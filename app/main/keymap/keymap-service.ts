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

export async function saveKeymap(next: KeymapFile): Promise<void> {
  cache = next
  await writeFile(keymapPath(), JSON.stringify(next, null, 2), 'utf8')
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
