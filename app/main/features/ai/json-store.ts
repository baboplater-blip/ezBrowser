import { app } from 'electron'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * userData 아래 JSON 한 파일을 안전하게 읽고 쓰는 공용 저장소.
 *
 * 왜 (2026-09-15, 묶음 A): conversations.ts 와 agent-runs.ts 가 같은 패턴을 복제하고 있었고,
 * 그 패턴에 **데이터가 실제로 사라지는** 결함이 세 가지 있었다.
 *
 *  ① dirty 유실 — `persist()` 가 `await` **뒤에** `dirty = false` 를 했다. 직렬화(await 이전)에
 *     담기지 않은 변경이 await 도중 들어와도 그걸 덮어써 "저장됨" 으로 표시했고, 곧바로 종료하면
 *     `flush()` 의 `if (!dirty) return` 때문에 그 변경은 **영영 사라졌다**.
 *     → `dirty` 대신 **단조 증가 `seq`** 와 "디스크에 착지한 seq(`persistedSeq`)" 를 비교한다.
 *       저장은 자기가 **직렬화한 시점의 seq 만** 착지로 기록하므로, 그 뒤에 들어온 변경은
 *       여전히 `seq > persistedSeq` 로 남아 반드시 다시 저장된다.
 *
 *  ② tmp 경로 공유 — 모든 저장이 같은 `<file>.tmp` 를 썼다. 두 저장이 겹치면 한쪽 rename 이
 *     ENOENT 로 실패하거나, 더 나쁘게는 **오래된 스냅샷이 최신 것을 덮어썼다**.
 *     → tmp 이름에 pid + 카운터를 넣어 유일하게 만든다.
 *
 *  ③ 종료 경합 — 종료 시 동기 flush 가 최신을 쓴 직후, 진행 중이던 비동기 rename 이 **늦게 착지**해
 *     구버전으로 되돌릴 수 있었다.
 *     → rename **직전**에 "나보다 새 스냅샷이 이미 착지했는가" 를 확인해 그렇다면 자기 tmp 를 버리고,
 *       그래도 rename 도중 더 새 것이 착지했다면(동기 flush 와의 좁은 경합) **즉시 동기 재기록**으로 복구한다.
 *
 * 그리고 손상 복구: 파일을 통째로 못 읽으면 **고유 이름 백업**(`<file>.corrupt-<시각>.bak`)을 남긴다.
 * 예전 conversations.ts 는 고정 이름(`.corrupt.bak`)이라 두 번째 손상이 **첫 백업(원본)을 덮어썼고**,
 * agent-runs.ts 는 백업을 아예 안 만들어 다음 저장이 손상 파일을 영구히 지웠다.
 *
 * ⚠ 가장 중요한 불변식: **정상 파일은 절대 건드리지 않는다.** 백업도, 비우기도, 불필요한 재기록도 없다.
 *   과잉 방어로 멀쩡한 데이터를 날리면 고치기 전보다 나쁘다.
 */

/** 같은 파일의 손상 백업 보관 개수 상한. 초과하면 **가장 오래된 것부터** 정리한다. */
const MAX_BACKUPS = 10

/** 디바운스가 계속 밀려 저장이 굶는 것을 막는 상한 — 첫 변경 이후 이만큼 지나면 타이머를 더 미루지 않는다. */
const MAX_SAVE_DELAY_MS = 2000

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function userDataFile(fileName: string): string {
  return path.join(app.getPath('userData'), fileName)
}

/** `<file>.corrupt-<ISO시각>.bak` — 이미 있으면 접미사를 올려 **절대 덮어쓰지 않는다**. */
function nextBackupPath(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let dest = `${file}.corrupt-${stamp}.bak`
  let n = 2
  while (existsSync(dest)) dest = `${file}.corrupt-${stamp}-${n++}.bak`
  return dest
}

/** 백업이 무한히 쌓이지 않게 오래된 것부터 정리(보존 우선 — 상한을 넉넉히 둔다). */
function pruneBackups(file: string): void {
  try {
    const dir = path.dirname(file)
    const base = path.basename(file)
    const found: { p: string; t: number }[] = []
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${base}.corrupt-`) || !name.endsWith('.bak')) continue
      const p = path.join(dir, name)
      let t = 0
      try { t = statSync(p).mtimeMs } catch { /* 못 읽으면 가장 오래된 것으로 본다 */ }
      found.push({ p, t })
    }
    if (found.length <= MAX_BACKUPS) return
    found.sort((a, b) => a.t - b.t)
    for (const { p } of found.slice(0, found.length - MAX_BACKUPS)) {
      try { unlinkSync(p) } catch { /* ignore */ }
    }
  } catch { /* 정리는 실패해도 무방 */ }
}

/** 읽을 수 없는 파일을 고유 이름으로 **옮긴다**(원본 자리는 비운다). */
function quarantine(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    const dest = nextBackupPath(file)
    renameSync(file, dest)
    pruneBackups(file)
    return dest
  } catch {
    return null
  }
}

/** 원본은 그대로 두고 **복사본**만 남긴다(부분 손상 — 앱은 살아남은 항목으로 계속 동작한다). */
function preserveCopy(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    const dest = nextBackupPath(file)
    copyFileSync(file, dest)
    pruneBackups(file)
    return dest
  } catch {
    return null
  }
}

/** 이전 실행이 남긴 고아 tmp 정리(이 시점엔 이 프로세스의 쓰기가 아직 없다). */
function pruneStaleTmp(file: string): void {
  try {
    const dir = path.dirname(file)
    const base = path.basename(file)
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`${base}.`) && name.endsWith('.tmp')) {
        try { unlinkSync(path.join(dir, name)) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/**
 * 저장 파일을 읽어 최상위 객체를 돌려준다.
 *
 * - 파일이 없으면 `null`(백업도 로그도 없다 — 첫 실행의 정상 상태다)
 * - 읽기·파싱 실패 또는 모양이 다르면(`primaryKey` 가 배열이 아니면) **고유 이름 백업 후** `null`.
 *   그냥 빈 상태로 시작하면 다음 저장이 손상 파일을 영구히 덮어써 복구가 불가능해진다.
 */
export function loadJsonObject(
  fileName: string, label: string, primaryKey: string,
): Record<string, unknown> | null {
  let file: string
  try { file = userDataFile(fileName) } catch { return null }
  pruneStaleTmp(file)
  if (!existsSync(file)) return null

  const giveUp = (reason: string): null => {
    const dest = quarantine(file)
    console.error(
      `[ai] ${label} 파일을 읽을 수 없어 빈 상태로 시작합니다 — ${reason}.`
      + (dest ? ` 손상본은 ${path.basename(dest)} 로 보존했습니다.` : ' (보존 실패 — 원본이 그대로 남아 있습니다)'),
    )
    return null
  }

  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch (err) {
    return giveUp(`읽기 실패(${msgOf(err)})`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return giveUp(`JSON 손상(${msgOf(err)})`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return giveUp('최상위가 객체가 아님')
  }
  if (!Array.isArray((parsed as Record<string, unknown>)[primaryKey])) {
    return giveUp(`'${primaryKey}' 목록이 없음`)
  }
  return parsed as Record<string, unknown>
}

export interface JsonStore {
  /** 상태가 바뀌었다 — 디바운스 저장 예약. */
  markDirty(): void
  /** 종료 시 동기 저장. 저장할 변경이 없으면 **파일을 건드리지 않는다**. */
  flush(): void
  /** 부분 손상으로 항목을 버렸을 때 — 원본을 복사본으로 보존하고 몇 개를 버렸는지 알린다. */
  reportDropped(dropped: number, kept: number): void
}

export function createJsonStore(opts: {
  /** userData 아래 파일 이름 (예: 'ai-chats.json') */
  fileName: string
  /** 로그에 쓰는 한국어 이름 (예: '대화') */
  label: string
  debounceMs: number
  /** 지금 디스크에 쓸 객체 — 호출 시점의 최신 상태여야 한다. */
  snapshot: () => unknown
}): JsonStore {
  const { fileName, label, debounceMs, snapshot } = opts

  let seq = 0             // 변경마다 증가
  let persistedSeq = 0    // 디스크에 마지막으로 **착지한** 스냅샷의 seq
  let timer: NodeJS.Timeout | null = null
  let firstDirtyAt = 0
  let writing = false
  let tmpCounter = 0

  const fileOf = (): string => userDataFile(fileName)
  const tmpOf = (file: string): string => `${file}.${process.pid}-${++tmpCounter}.tmp`

  function serialize(): string | null {
    try {
      return JSON.stringify(snapshot())
    } catch (err) {
      console.warn(`[ai] ${label} 직렬화 실패`, err)
      return null
    }
  }

  function scheduleTimer(): void {
    if (timer) return
    firstDirtyAt = firstDirtyAt || Date.now()
    timer = setTimeout(() => { timer = null; firstDirtyAt = 0; void runPersist() }, debounceMs)
  }

  function markDirty(): void {
    seq++
    if (timer) {
      // 변경이 쉼 없이 들어와도 저장이 굶지 않도록, 첫 변경 이후 일정 시간이 지나면 타이머를 더 미루지 않는다.
      if (Date.now() - firstDirtyAt >= MAX_SAVE_DELAY_MS) return
      clearTimeout(timer)
      timer = null
    }
    scheduleTimer()
  }

  /** 동기 원자적 쓰기. 성공하면 `persistedSeq` 를 올린다. */
  function writeSyncAt(mySeq: number, text: string): boolean {
    const file = fileOf()
    let tmp = ''
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      tmp = tmpOf(file)
      writeFileSync(tmp, text, 'utf-8')
      renameSync(tmp, file)
      persistedSeq = Math.max(persistedSeq, mySeq)
      return true
    } catch (err) {
      if (tmp) { try { unlinkSync(tmp) } catch { /* ignore */ } }
      console.warn(`[ai] ${label} 저장 실패(동기)`, err)
      return false
    }
  }

  async function runPersist(): Promise<void> {
    if (writing) return  // single-flight — 진행 중인 루프가 최신 seq 까지 따라간다
    writing = true
    try {
      // 직렬화 이후 들어온 변경까지 따라가도록 반복한다(무한 루프 방지용 상한).
      for (let guard = 0; guard < 50; guard++) {
        if (seq <= persistedSeq) break
        const mySeq = seq
        const text = serialize()
        if (text === null) break
        const file = fileOf()
        let tmp = ''
        try {
          await mkdir(path.dirname(file), { recursive: true })
          tmp = tmpOf(file)
          await writeFile(tmp, text, 'utf-8')
          if (persistedSeq >= mySeq) {
            // 내가 쓰는 동안 더 새(또는 같은) 스냅샷이 이미 착지했다 → 내 것을 착지시키면 되돌리기다.
            await unlink(tmp).catch(() => {})
            continue
          }
          await rename(tmp, file)
          if (persistedSeq > mySeq) {
            // rename 도중 동기 flush 가 더 새 스냅샷을 착지시켰다 → 방금 그걸 덮었다. 즉시 동기 복구.
            const cur = seq
            const fresh = serialize()
            if (fresh !== null) writeSyncAt(cur, fresh)
          } else {
            persistedSeq = mySeq
          }
        } catch (err) {
          if (tmp) { await unlink(tmp).catch(() => {}) }
          // persistedSeq 를 올리지 않는다 → 다음 변경이나 종료 flush 에서 다시 시도된다.
          console.warn(`[ai] ${label} 저장 실패`, err)
          break
        }
      }
    } finally {
      writing = false
    }
    // 루프가 도는 동안 들어온 변경(또는 실패로 남은 변경)이 있으면 다시 예약한다.
    if (seq > persistedSeq) scheduleTimer()
  }

  function flush(): void {
    if (timer) { clearTimeout(timer); timer = null; firstDirtyAt = 0 }
    if (seq <= persistedSeq) return  // 저장할 변경 없음 — 정상 파일을 건드리지 않는다
    const mySeq = seq
    const text = serialize()
    if (text === null) return
    writeSyncAt(mySeq, text)
  }

  function reportDropped(dropped: number, kept: number): void {
    if (dropped <= 0) return
    const dest = preserveCopy(fileOf())
    console.error(
      `[ai] ${label} 파일에서 읽을 수 없는 항목 ${dropped}개를 제외하고 ${kept}개를 복구했습니다.`
      + (dest ? ` 원본은 ${path.basename(dest)} 로 보존했습니다.` : ' (원본 보존 실패)'),
    )
  }

  return { markDirty, flush, reportDropped }
}
