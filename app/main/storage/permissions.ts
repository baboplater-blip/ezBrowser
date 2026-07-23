import Store from 'electron-store'
import { EventEmitter } from 'node:events'

// 사이트(origin)별 권한 오버라이드. 기본 동작(화이트리스트)은 session-bootstrap 이 유지하고,
// 여기에 저장된 명시적 'allow'/'deny' 만 우선 적용. 항목 없음 = 기본.
export type PermDecision = 'allow' | 'deny'
export interface OriginPerms { [permission: string]: PermDecision }

export const permissionEvents = new EventEmitter()

const store = new Store<{ origins: Record<string, OriginPerms> }>({ name: 'permissions', defaults: { origins: {} } })
const cache = new Map<string, OriginPerms>()
let loaded = false

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  const origins = store.get('origins')
  if (origins && typeof origins === 'object') {
    for (const [k, v] of Object.entries(origins)) if (v && typeof v === 'object') cache.set(k, v)
  }
}

function persist(): void {
  store.set('origins', Object.fromEntries(cache))
  permissionEvents.emit('changed')
}

export function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch { return null }
}

/** session-bootstrap 핸들러용: 명시적 결정만 반환, 없으면 null(기본 동작). */
export function getPermissionDecision(url: string, permission: string): PermDecision | null {
  const origin = originOf(url)
  if (!origin) return null
  ensureLoaded()
  return cache.get(origin)?.[permission] ?? null
}

export function listPermissions(): Array<{ origin: string; permissions: OriginPerms }> {
  ensureLoaded()
  return Array.from(cache.entries())
    .map(([origin, permissions]) => ({ origin, permissions: { ...permissions } }))
    .sort((a, b) => a.origin.localeCompare(b.origin))
}

/** decision 'default' 는 오버라이드 제거(기본 동작 복귀). */
export function setPermission(origin: string, permission: string, decision: PermDecision | 'default'): void {
  if (!originOf(origin)) return
  ensureLoaded()
  const perms = { ...(cache.get(origin) ?? {}) }
  if (decision === 'default') delete perms[permission]
  else perms[permission] = decision
  if (Object.keys(perms).length === 0) cache.delete(origin)
  else cache.set(origin, perms)
  persist()
}

export function clearOrigin(origin: string): void {
  ensureLoaded()
  if (cache.delete(origin)) persist()
}

export function clearAllPermissions(): void {
  ensureLoaded()
  if (cache.size === 0) return
  cache.clear()
  persist()
}
