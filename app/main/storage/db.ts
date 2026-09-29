import { app } from 'electron'
import { existsSync, writeFileSync, renameSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'

let SQL: SqlJsStatic | null = null

// sql.js 는 in-memory DB 라 주기적·종료 시 디스크 flush 가 영속성의 유일한 보장.
// 디바운스를 짧게(400ms) + 주기 강제 flush(20s) + 종료 시 동기 atomic 쓰기로 손실창을 최소화.
const FLUSH_DEBOUNCE_MS = 400
const FORCE_FLUSH_MS = 20_000

function resolveWasmPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  }
  return require.resolve('sql.js/dist/sql-wasm.wasm')
}

async function ensureRuntime(): Promise<SqlJsStatic> {
  if (SQL) return SQL
  const wasmPath = resolveWasmPath()
  const buf = await readFile(wasmPath)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  SQL = await initSqlJs({ wasmBinary: ab })
  return SQL
}

export interface ManagedDb {
  db: Database
  flush: () => Promise<void>
  scheduleFlush: () => void
  close: () => Promise<void>
}

export interface OpenDbOptions {
  /** 쓰기 후 디스크 flush 까지의 디바운스(ms). 기본 400ms. 자주 쓰는 DB(이력 등)는 늘려서 IO 를 줄인다. */
  debounceMs?: number
  /** 디바운스가 계속 밀려도 강제로 flush 하는 주기(ms). 기본 20s. */
  forceFlushMs?: number
}

/**
 * 외부(읽기 전용) SQLite 파일을 sql.js 로 연다. 가져오기(크롬/엣지 History 등)용.
 * 호출자가 끝나면 반드시 `db.close()` 한다. 원본 파일이 잠겨 있을 수 있으므로,
 * 호출자는 미리 임시 위치로 복사한 경로를 넘기는 것이 안전하다.
 */
export async function openExternalSqlite(filePath: string): Promise<Database> {
  const runtime = await ensureRuntime()
  const buf = await readFile(filePath)
  return new runtime.Database(new Uint8Array(buf))
}

const dirty = new WeakMap<Database, NodeJS.Timeout | null>()

// db.export() 는 sql.js 가 Emscripten FS.readFile 로 새로 할당한 독립 Uint8Array 를 돌려준다
// (MEMFS 저장소나 WASM 힙을 직접 보는 뷰가 아님 — FS.read 가 .set() 으로 그 배열에 복사해 넣은
// 뒤 반환한다). 그래서 이 배열은 이후 어떤 db 연산에도 절대 재사용·변형되지 않는, 이 export()
// 호출 전용의 새 메모리다 — Buffer.from(u8.buffer, byteOffset, byteLength) 로 한 번 더 복사하지
// 않고 그대로 감싸도(zero-copy) 안전하다(불필요한 풀사이즈 복사 1회 제거).
function wrapExportedBuffer(u8: Uint8Array): Buffer {
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)
}

export async function openDb(filename: string, schema: string[], opts: OpenDbOptions = {}): Promise<ManagedDb> {
  const debounceMs = opts.debounceMs ?? FLUSH_DEBOUNCE_MS
  const forceFlushMs = opts.forceFlushMs ?? FORCE_FLUSH_MS
  const runtime = await ensureRuntime()
  const userData = app.getPath('userData')
  const dbDir = path.join(userData, 'data')
  await mkdir(dbDir, { recursive: true })
  const filePath = path.join(dbDir, filename)

  let db: Database
  if (existsSync(filePath)) {
    const buf = await readFile(filePath)
    db = new runtime.Database(new Uint8Array(buf))
  } else {
    db = new runtime.Database()
  }

  for (const stmt of schema) {
    db.exec(stmt)
  }

  // 마지막 flush 이후 쓰기 발생 여부 — 주기 flush·종료 flush 가 불필요한 쓰기를 건너뛰도록.
  let pendingWrites = false

  const flush = async (): Promise<void> => {
    pendingWrites = false
    const data = wrapExportedBuffer(db.export())
    const tmp = `${filePath}.tmp`
    await writeFile(tmp, data)
    await rename(tmp, filePath)
  }

  const flushSync = (): void => {
    if (!pendingWrites) return
    pendingWrites = false
    try {
      const data = wrapExportedBuffer(db.export())
      const tmp = `${filePath}.tmp`
      writeFileSync(tmp, data)
      renameSync(tmp, filePath) // atomic — 도중에 죽어도 원본 보존
    } catch (err) {
      console.error(`[db] sync flush ${filename} failed`, err)
    }
  }

  const scheduleFlush = (): void => {
    pendingWrites = true
    const existing = dirty.get(db)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      void flush().catch((err) => console.error(`[db] flush ${filename} failed`, err))
      dirty.set(db, null)
    }, debounceMs)
    dirty.set(db, t)
  }

  // 주기적 강제 flush — 디바운스가 계속 밀려도 forceFlushMs 마다 디스크에 반영(비정상 종료 손실창 축소).
  // pendingWrites 가 false 면(직전 flush 이후 변경 없음) 건너뛴다 — 불필요한 디스크 쓰기 방지.
  const interval = setInterval(() => {
    if (!pendingWrites) return
    const existing = dirty.get(db)
    if (existing) { clearTimeout(existing); dirty.set(db, null) }
    void flush().catch((err) => console.error(`[db] periodic flush ${filename} failed`, err))
  }, forceFlushMs)
  if (typeof interval.unref === 'function') interval.unref()

  // 정상 종료 — 동기 atomic 쓰기
  app.on('before-quit', flushSync)
  app.on('will-quit', flushSync)

  const close = async (): Promise<void> => {
    const existing = dirty.get(db)
    if (existing) clearTimeout(existing)
    clearInterval(interval)
    app.off('before-quit', flushSync)
    app.off('will-quit', flushSync)
    await flush()
    db.close()
  }

  return { db, flush, scheduleFlush, close }
}
