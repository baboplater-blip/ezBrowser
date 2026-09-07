import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import defaultKeymap from '../../shared/keymap.default.json'
import type { KeyBinding } from '../../shared/types'

const KEYMAP_FILENAME = 'keymap.json'

interface KeymapFile {
  version: number
  bindings: KeyBinding[]
}

let cache: KeymapFile = defaultKeymap as KeymapFile

function keymapPath(): string {
  return path.join(app.getPath('userData'), KEYMAP_FILENAME)
}

export async function loadKeymap(): Promise<KeymapFile> {
  const p = keymapPath()
  try {
    if (!existsSync(p)) {
      await mkdir(path.dirname(p), { recursive: true })
      await writeFile(p, JSON.stringify(defaultKeymap, null, 2), 'utf8')
      cache = defaultKeymap as KeymapFile
      return cache
    }
    const text = await readFile(p, 'utf8')
    const parsed = JSON.parse(text) as KeymapFile
    cache = mergeWithDefaults(parsed)
    return cache
  } catch (err) {
    console.warn('[keymap] load failed, using defaults', err)
    cache = defaultKeymap as KeymapFile
    return cache
  }
}

function mergeWithDefaults(user: KeymapFile): KeymapFile {
  const merged: KeymapFile = { version: user.version || 1, bindings: [...user.bindings] }
  for (const def of (defaultKeymap as KeymapFile).bindings) {
    const exists = merged.bindings.some(
      (b) => b.action === def.action && b.when === def.when,
    )
    if (!exists) merged.bindings.push(def)
  }
  return merged
}

export function getKeymap(): KeymapFile {
  return cache
}

/**
 * 저장 전 형태 검증 — 잘못된 값이 오면 **캐시도 디스크도 건드리지 않고** 거부한다.
 *
 * 왜 (2026-09-07, 임무 18 에서 발견): 예전에는 `cache = next` 로 무조건 덮어썼다. 설정 페이지가
 * 실수로 배열을 보내면 `cache.bindings` 가 사라져 **모든 단축키가 먹통이 되고 그 상태가 디스크에
 * 저장**됐다(로드 시 폴백이 있어 재시작하면 회복되지만, 재시작 전까지는 깨진 채로 남는다).
 * 사용자 설정을 받아 쓰는 경로는 "호출자가 알아서 잘 보낼 것"을 전제하면 안 된다.
 */
function isValidKeymap(v: unknown): v is KeymapFile {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const f = v as Partial<KeymapFile>
  if (!Array.isArray(f.bindings)) return false
  return f.bindings.every((b) => b && typeof b === 'object'
    && typeof (b as KeyBinding).action === 'string'
    && typeof (b as KeyBinding).key === 'string')
}

export async function saveKeymap(next: KeymapFile): Promise<void> {
  if (!isValidKeymap(next)) {
    throw new Error('키맵 형식이 올바르지 않습니다 — { version, bindings: [{ action, key, ... }] } 여야 합니다')
  }
  cache = { version: typeof next.version === 'number' ? next.version : 1, bindings: next.bindings }
  await writeFile(keymapPath(), JSON.stringify(cache, null, 2), 'utf8')
}

export async function resetKeymap(): Promise<KeymapFile> {
  cache = defaultKeymap as KeymapFile
  await writeFile(keymapPath(), JSON.stringify(defaultKeymap, null, 2), 'utf8')
  return cache
}

export function findKeyFor(actionId: string): string | undefined {
  return cache.bindings.find((b) => b.action === actionId)?.key
}

export function findConflicts(): Array<{ key: string; when: string; actions: string[] }> {
  const groups = new Map<string, string[]>()
  for (const b of cache.bindings) {
    const k = `${b.when}::${b.key.toLowerCase()}`
    const arr = groups.get(k) ?? []
    arr.push(b.action)
    groups.set(k, arr)
  }
  const conflicts: Array<{ key: string; when: string; actions: string[] }> = []
  for (const [k, actions] of groups) {
    if (actions.length > 1) {
      const [when, key] = k.split('::') as [string, string]
      conflicts.push({ key, when, actions })
    }
  }
  return conflicts
}
