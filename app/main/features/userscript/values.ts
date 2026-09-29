// 스크립트별 GM_* 값 저장소 — userData/userscripts-values/<id>.json (electron-store, createStore 로
// 손상 시 자동 격리). 예전엔 GM_setValue 가 페이지 자신의 localStorage 에 썼다 — 그러면 그 값이
// 사이트 스크립트에서 직접 읽고 조작 가능했고, origin 마다 쪼개져 같은 스크립트가 사이트마다
// 값을 못 나눴다(item 1). 이제 메인 프로세스가 스크립트 id 단위로 보관하고, 페이지에는 절대
// 노출하지 않는다 — 격리 월드 안에서 GM 브릿지로만 접근.

import path from 'node:path'
import { app } from 'electron'
import { createStore } from '../../storage/safe-store'
import type Store from 'electron-store'

const MAX_KEY_LEN = 200
const MAX_VALUE_BYTES = 512 * 1024 // 값 하나당 512KB
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 // 스크립트당 전체 5MB

type ValueStore = Store<Record<string, unknown>>
const stores = new Map<string, ValueStore>()

function safeId(id: string): string {
  // index.ts 의 safeId 와 동일 제약(파일 이름이 됨) — 이 함수에 오는 id 는 이미 검증된
  // Userscript.id 여야 한다(호출부가 존재하는 스크립트인지 먼저 확인). 방어적으로 한 번 더 거른다.
  return /^[A-Za-z0-9._-]{1,80}$/.test(id) && !id.includes('..') ? id : '_invalid'
}

function storeFor(id: string): ValueStore {
  const safe = safeId(id)
  let s = stores.get(safe)
  if (!s) {
    s = createStore<Record<string, unknown>>({
      name: safe,
      cwd: path.join(app.getPath('userData'), 'userscripts-values'),
    })
    stores.set(safe, s)
  }
  return s
}

function byteLength(v: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8') } catch { return Infinity }
}

function totalBytes(s: ValueStore): number {
  try { return Buffer.byteLength(JSON.stringify(s.store) ?? '', 'utf8') } catch { return 0 }
}

/** 주입 시점에 쓸 전체 값 스냅샷 — 동기, 디스크/네트워크 접근 없음(electron-store 는 생성 시 메모리에 로드). */
export function getValuesSnapshot(id: string): Record<string, unknown> {
  try {
    return { ...storeFor(id).store }
  } catch {
    return {}
  }
}

export interface ValueWriteResult { ok: boolean; error?: string }

export function setValue(id: string, key: string, value: unknown): ValueWriteResult {
  if (typeof key !== 'string' || !key || key.length > MAX_KEY_LEN) {
    return { ok: false, error: '키가 올바르지 않습니다' }
  }
  const size = byteLength(value)
  if (size > MAX_VALUE_BYTES) {
    return { ok: false, error: `값이 너무 큽니다(최대 ${MAX_VALUE_BYTES / 1024}KB)` }
  }
  const store = storeFor(id)
  const before = totalBytes(store)
  const prevSize = store.has(key) ? byteLength(store.get(key)) : 0
  if (before - prevSize + size > MAX_TOTAL_BYTES) {
    return { ok: false, error: `스크립트 저장 용량을 초과했습니다(최대 ${MAX_TOTAL_BYTES / 1024 / 1024}MB)` }
  }
  try {
    store.set(key, value)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function deleteValue(id: string, key: string): ValueWriteResult {
  if (typeof key !== 'string' || !key) return { ok: false, error: '키가 올바르지 않습니다' }
  try {
    storeFor(id).delete(key)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 스크립트가 완전히 삭제될 때 그 값 저장소도 함께 치운다. */
export function clearValues(id: string): void {
  try {
    storeFor(id).clear()
  } catch { /* ignore */ }
  stores.delete(safeId(id))
}
