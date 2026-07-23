import { app, dialog, net } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { getAllWindows } from '../../windows/window-service'
import {
  createTab, closeTab, navigateTab, listTabs, getAllTabs,
} from '../../tabs/tab-service'
import type { ModManifest, ModPermission, ModSummary } from '../../../shared/types'

interface LoadedMod {
  id: string
  modPath: string
  manifest: ModManifest
  enabled: boolean
  hasError: boolean
  errorMessage?: string
  tabListeners: {
    created: Array<(info: { id: string; webContentsId: number }) => void>
    closed: Array<(id: string) => void>
    navigated: Array<(info: { id: string; url: string; title: string }) => void>
  }
  menuItems: Array<{ label: string; click: () => void }>
  // 모드가 등록한 타이머 — 비활성화 시 일괄 취소(메인 루프 오염·누수 방지)
  timers: Set<NodeJS.Timeout>
}

const mods = new Map<string, LoadedMod>()
let loaded = false

// 각 모드 storage 의 동기 flush 함수 — 앱 종료 시 일괄 호출(250ms 디바운스 손실 방지)
const storageFlushers: Array<() => void> = []
let quitHookBound = false

export const modEvents = new EventEmitter()

function clearModTimers(mod: LoadedMod): void {
  for (const t of mod.timers) { clearTimeout(t); clearInterval(t) }
  mod.timers.clear()
}

function rootDir(): string {
  return path.join(app.getPath('userData'), 'mods')
}

function storageDirOf(id: string): string {
  return path.join(rootDir(), id, 'storage')
}

async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true })
}

function isAllowedPermission(p: string): p is ModPermission {
  return p === 'tabs' || p === 'menu' || p === 'storage' || p === 'network' || p === 'node'
}

function normalizeManifest(raw: unknown, id: string): ModManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : id
  const description = typeof r.description === 'string' ? r.description : ''
  const version = typeof r.version === 'string' && r.version.trim() ? r.version.trim() : '0.0.0'
  const author = typeof r.author === 'string' ? r.author : ''
  const permsRaw = Array.isArray(r.permissions) ? r.permissions : []
  const permissions: ModPermission[] = []
  for (const p of permsRaw) {
    if (typeof p === 'string' && isAllowedPermission(p)) permissions.push(p)
  }
  return { id, name, description, version, author, permissions }
}

function makeStorageApi(modId: string): { get: (k: string) => unknown; set: (k: string, v: unknown) => void } {
  const dir = storageDirOf(modId)
  const file = path.join(dir, 'kv.json')
  let cache: Record<string, unknown> = {}
  let cacheLoaded = false
  function loadSync(): void {
    if (cacheLoaded) return
    cacheLoaded = true
    try {
      if (existsSync(file)) {
        const raw = require('node:fs').readFileSync(file, 'utf-8')
        cache = JSON.parse(raw) as Record<string, unknown>
      }
    } catch (err) {
      console.warn(`[mod:${modId}] storage load failed`, err)
    }
  }
  let writeTimer: NodeJS.Timeout | null = null
  let dirtyKv = false
  function scheduleWrite(): void {
    dirtyKv = true
    if (writeTimer) clearTimeout(writeTimer)
    writeTimer = setTimeout(async () => {
      writeTimer = null
      dirtyKv = false
      try {
        await ensureDir(dir)
        await writeFile(file, JSON.stringify(cache, null, 2), 'utf-8')
      } catch (err) {
        console.warn(`[mod:${modId}] storage persist failed`, err)
      }
    }, 250)
  }
  // 종료 시 대기 중인 변경을 동기 기록 (디바운스 손실 방지)
  storageFlushers.push(() => {
    if (!dirtyKv) return
    dirtyKv = false
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
    try {
      require('node:fs').mkdirSync(dir, { recursive: true })
      require('node:fs').writeFileSync(file, JSON.stringify(cache, null, 2), 'utf-8')
    } catch (err) {
      console.warn(`[mod:${modId}] storage sync flush failed`, err)
    }
  })
  return {
    get: (k: string) => { loadSync(); return cache[k] },
    set: (k: string, v: unknown) => { loadSync(); cache[k] = v; scheduleWrite() },
  }
}

function firstWindowId(): string | null {
  return getAllWindows()[0]?.id ?? null
}

function makeApiForMod(mod: LoadedMod, nodeGranted: boolean): Record<string, unknown> {
  const perms = new Set(mod.manifest.permissions)
  const api: Record<string, unknown> = {
    info: { ...mod.manifest },
    log: (...args: unknown[]) => console.log(`[mod:${mod.id}]`, ...args),
    toast: (msg: string) => {
      const text = String(msg ?? '').slice(0, 200)
      for (const ctx of getAllWindows()) {
        ctx.chrome.webContents.send('toast:show', { message: `[${mod.manifest.name}] ${text}`, ts: Date.now() })
      }
    },
  }
  if (perms.has('tabs')) {
    api.tabs = {
      // 관찰
      onCreated: (cb: (info: { id: string; webContentsId: number }) => void) => {
        if (typeof cb === 'function') mod.tabListeners.created.push(cb)
      },
      onClosed: (cb: (id: string) => void) => {
        if (typeof cb === 'function') mod.tabListeners.closed.push(cb)
      },
      onNavigated: (cb: (info: { id: string; url: string; title: string }) => void) => {
        if (typeof cb === 'function') mod.tabListeners.navigated.push(cb)
      },
      // 조작
      list: () => getAllTabs().map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })),
      create: (url?: string) => {
        const windowId = firstWindowId()
        if (!windowId) return null
        const safe = typeof url === 'string' && /^https?:|^browser:/i.test(url) ? url : undefined
        const t = createTab({ windowId, url: safe })
        return t.id
      },
      navigate: (tabId: string, url: string) => {
        if (typeof tabId !== 'string' || typeof url !== 'string') return
        if (!/^https?:|^browser:/i.test(url)) return
        navigateTab(tabId, url)
      },
      close: (tabId: string) => { if (typeof tabId === 'string') closeTab(tabId) },
      active: () => {
        const windowId = firstWindowId()
        if (!windowId) return null
        const t = listTabs(windowId).find((x) => x.active)
        return t ? { id: t.id, url: t.url, title: t.title } : null
      },
    }
  }
  if (perms.has('menu')) {
    api.menu = {
      add: (item: { label: string; click: () => void }) => {
        if (!item || typeof item.label !== 'string' || typeof item.click !== 'function') return
        mod.menuItems.push({ label: item.label.slice(0, 80), click: item.click })
      },
    }
  }
  if (perms.has('storage')) {
    api.storage = makeStorageApi(mod.id)
  }
  if (perms.has('network')) {
    api.net = {
      // 메인 프로세스 대행 fetch (CORS 우회). 텍스트/JSON 반환.
      fetch: async (url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        if (typeof url !== 'string' || !/^https?:/i.test(url)) {
          throw new Error('net.fetch: http(s) URL 만 허용됩니다')
        }
        const res = await net.fetch(url, {
          method: opts?.method ?? 'GET',
          headers: opts?.headers,
          body: opts?.body,
        })
        const text = await res.text()
        return {
          ok: res.ok,
          status: res.status,
          text,
          json: () => { try { return JSON.parse(text) } catch { return null } },
        }
      },
    }
  }
  if (perms.has('node') && nodeGranted) {
    // 사용자가 명시적으로 Node 권한을 승인한 모드만 — 확장보다 깊은 후킹 허용 (userChrome.js 정신)
    api.node = {
      require: (m: string) => require(m),
      process,
      modDir: mod.modPath,
    }
  }
  return api
}

function executeModCode(mod: LoadedMod, code: string, nodeGranted: boolean): void {
  const api = makeApiForMod(mod, nodeGranted)
  // 모드가 등록하는 타이머를 추적 — 비활성화/종료 시 일괄 취소
  const trackedSetTimeout = (fn: () => void, ms?: number): NodeJS.Timeout => {
    const t = setTimeout(() => { mod.timers.delete(t); try { fn() } catch (e) { console.warn(`[mod:${mod.id}] timer error`, e) } }, ms)
    mod.timers.add(t)
    return t
  }
  const trackedSetInterval = (fn: () => void, ms?: number): NodeJS.Timeout => {
    const t = setInterval(() => { try { fn() } catch (e) { console.warn(`[mod:${mod.id}] interval error`, e) } }, ms)
    mod.timers.add(t)
    return t
  }
  const trackedClear = (t: NodeJS.Timeout): void => { mod.timers.delete(t); clearTimeout(t); clearInterval(t) }
  const context = vm.createContext({
    mod: api,
    console: {
      log: (...a: unknown[]) => console.log(`[mod:${mod.id}]`, ...a),
      warn: (...a: unknown[]) => console.warn(`[mod:${mod.id}]`, ...a),
      error: (...a: unknown[]) => console.error(`[mod:${mod.id}]`, ...a),
    },
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClear,
    setInterval: trackedSetInterval,
    clearInterval: trackedClear,
    URL, URLSearchParams,
  })
  try {
    const script = new vm.Script(code, { filename: `mod:${mod.id}/index.js` })
    script.runInContext(context, { timeout: 5000 })
    mod.hasError = false
    mod.errorMessage = undefined
  } catch (err) {
    mod.hasError = true
    mod.errorMessage = err instanceof Error ? err.message : String(err)
    console.warn(`[mod:${mod.id}] exec failed`, err)
  }
}

async function loadMod(id: string, modPath: string): Promise<LoadedMod | null> {
  const manifestPath = path.join(modPath, 'manifest.json')
  const indexPath = path.join(modPath, 'index.js')
  if (!existsSync(manifestPath) || !existsSync(indexPath)) {
    console.warn(`[mod] ${id} missing manifest.json or index.js`)
    return null
  }
  try {
    const raw = await readFile(manifestPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    const manifest = normalizeManifest(parsed, id)
    if (!manifest) return null
    const mod: LoadedMod = {
      id, modPath, manifest,
      enabled: false, hasError: false,
      tabListeners: { created: [], closed: [], navigated: [] },
      menuItems: [],
      timers: new Set(),
    }
    return mod
  } catch (err) {
    console.warn(`[mod:${id}] manifest parse failed`, err)
    return null
  }
}

// ===== Node 권한 동의 (옵트인) =====

function nodeGrantsPath(): string {
  return path.join(rootDir(), '_node-grants.json')
}

async function readNodeGrants(): Promise<Record<string, boolean>> {
  const file = nodeGrantsPath()
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as Record<string, boolean>
  } catch {
    return {}
  }
}

async function writeNodeGrant(id: string, granted: boolean): Promise<void> {
  const grants = await readNodeGrants()
  grants[id] = granted
  try {
    await ensureDir(rootDir())
    await writeFile(nodeGrantsPath(), JSON.stringify(grants, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[mod] write node grants failed', err)
  }
}

/** Node 권한이 필요한 모드면 사용자 동의를 받는다(1회, 영구 저장). 동의 여부 반환. */
async function ensureNodeGrant(mod: LoadedMod): Promise<boolean> {
  if (!mod.manifest.permissions.includes('node')) return false
  const grants = await readNodeGrants()
  if (typeof grants[mod.id] === 'boolean') return grants[mod.id]!
  const result = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['거부', 'Node 권한 허용'],
    defaultId: 0,
    cancelId: 0,
    title: 'Node 권한 요청',
    message: `모드 "${mod.manifest.name}" 가 Node.js 시스템 접근을 요청합니다.`,
    detail: '이 권한은 파일 시스템·프로세스 등 컴퓨터 전체에 접근할 수 있어 확장보다 강력하고 위험합니다. '
      + '신뢰하는 모드에만 허용하세요. (이 결정은 저장되며 모드 페이지에서 변경할 수 있습니다)',
  })
  const granted = result.response === 1
  await writeNodeGrant(mod.id, granted)
  return granted
}

async function activateMod(mod: LoadedMod): Promise<void> {
  const indexPath = path.join(mod.modPath, 'index.js')
  try {
    const code = await readFile(indexPath, 'utf-8')
    const nodeGranted = await ensureNodeGrant(mod)
    // 활성화 전 listener·타이머 초기화 (재로드 시 중복 방지)
    clearModTimers(mod)
    mod.tabListeners = { created: [], closed: [], navigated: [] }
    mod.menuItems = []
    executeModCode(mod, code, nodeGranted)
    mod.enabled = true
  } catch (err) {
    mod.hasError = true
    mod.errorMessage = err instanceof Error ? err.message : String(err)
    console.warn(`[mod:${mod.id}] activate failed`, err)
  }
}

async function readEnabledState(): Promise<Record<string, boolean>> {
  const file = path.join(rootDir(), '_state.json')
  if (!existsSync(file)) return {}
  try {
    const raw = await readFile(file, 'utf-8')
    return JSON.parse(raw) as Record<string, boolean>
  } catch {
    return {}
  }
}

async function writeEnabledState(): Promise<void> {
  const file = path.join(rootDir(), '_state.json')
  const state: Record<string, boolean> = {}
  for (const m of mods.values()) state[m.id] = m.enabled
  try {
    await ensureDir(rootDir())
    await writeFile(file, JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[mod] write state failed', err)
  }
}

export async function initModApi(): Promise<void> {
  if (loaded) return
  loaded = true
  if (!quitHookBound) {
    quitHookBound = true
    app.on('before-quit', () => { for (const flush of storageFlushers) flush() })
  }
  await ensureDir(rootDir())
  const state = await readEnabledState()
  let entries: string[] = []
  try {
    entries = await readdir(rootDir())
  } catch (err) {
    console.warn('[mod] readdir failed', err)
    return
  }
  for (const entry of entries) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue
    const full = path.join(rootDir(), entry)
    try {
      const st = await stat(full)
      if (!st.isDirectory()) continue
    } catch { continue }
    const mod = await loadMod(entry, full)
    if (!mod) continue
    mods.set(mod.id, mod)
    if (state[mod.id]) {
      await activateMod(mod)
    }
  }
  if (mods.size > 0) {
    console.log(`[mod] loaded ${mods.size} mods, ${Array.from(mods.values()).filter((m) => m.enabled).length} active`)
  }
}

export function listMods(): ModSummary[] {
  return Array.from(mods.values()).map((m) => ({
    id: m.id,
    name: m.manifest.name,
    description: m.manifest.description,
    version: m.manifest.version,
    author: m.manifest.author,
    permissions: m.manifest.permissions,
    enabled: m.enabled,
    hasError: m.hasError,
    errorMessage: m.errorMessage,
    path: m.modPath,
  }))
}

export async function setModEnabled(id: string, enabled: boolean): Promise<boolean> {
  const mod = mods.get(id)
  if (!mod) return false
  if (enabled && !mod.enabled) {
    await activateMod(mod)
  } else if (!enabled && mod.enabled) {
    mod.enabled = false
    clearModTimers(mod)
    mod.tabListeners = { created: [], closed: [], navigated: [] }
    mod.menuItems = []
    mod.hasError = false
    mod.errorMessage = undefined
  }
  await writeEnabledState()
  modEvents.emit('changed')
  return true
}

export async function reloadMod(id: string): Promise<boolean> {
  const mod = mods.get(id)
  if (!mod) return false
  if (mod.enabled) {
    await activateMod(mod)
  }
  modEvents.emit('changed')
  return true
}

export async function removeMod(id: string): Promise<boolean> {
  const mod = mods.get(id)
  if (!mod) return false
  clearModTimers(mod)
  mods.delete(id)
  try {
    await rm(mod.modPath, { recursive: true, force: true })
  } catch (err) {
    console.warn(`[mod:${id}] remove failed`, err)
  }
  await writeEnabledState()
  modEvents.emit('changed')
  return true
}

// ===== tab lifecycle hook bridge =====
// main 진입의 onTabCreated/onTabClosed/onTabNavigated 가 이 함수들 호출.

export function dispatchTabCreated(info: { id: string; webContentsId: number }): void {
  for (const mod of mods.values()) {
    if (!mod.enabled) continue
    for (const cb of mod.tabListeners.created) {
      try { cb(info) } catch (err) { console.warn(`[mod:${mod.id}] tab.onCreated error`, err) }
    }
  }
}

export function dispatchTabClosed(id: string): void {
  for (const mod of mods.values()) {
    if (!mod.enabled) continue
    for (const cb of mod.tabListeners.closed) {
      try { cb(id) } catch (err) { console.warn(`[mod:${mod.id}] tab.onClosed error`, err) }
    }
  }
}

export function dispatchTabNavigated(info: { id: string; url: string; title: string }): void {
  for (const mod of mods.values()) {
    if (!mod.enabled) continue
    for (const cb of mod.tabListeners.navigated) {
      try { cb(info) } catch (err) { console.warn(`[mod:${mod.id}] tab.onNavigated error`, err) }
    }
  }
}

export function collectMenuItems(): Array<{ modId: string; label: string; click: () => void }> {
  const out: Array<{ modId: string; label: string; click: () => void }> = []
  for (const mod of mods.values()) {
    if (!mod.enabled) continue
    for (const item of mod.menuItems) {
      out.push({ modId: mod.id, label: item.label, click: item.click })
    }
  }
  return out
}

/** 명령 팔레트/외피용: 안정 id 가 붙은 모드 메뉴 메타 목록 */
export function listMenuItemsMeta(): Array<{ id: string; modId: string; modName: string; label: string }> {
  const out: Array<{ id: string; modId: string; modName: string; label: string }> = []
  for (const mod of mods.values()) {
    if (!mod.enabled) continue
    mod.menuItems.forEach((item, i) => {
      out.push({ id: `${mod.id}::${i}`, modId: mod.id, modName: mod.manifest.name, label: item.label })
    })
  }
  return out
}

/** id(`<modId>::<index>`) 로 모드 메뉴 항목 실행 */
export function invokeMenuItem(id: string): boolean {
  const sep = id.lastIndexOf('::')
  if (sep < 0) return false
  const modId = id.slice(0, sep)
  const idx = Number(id.slice(sep + 2))
  const mod = mods.get(modId)
  if (!mod || !mod.enabled || !Number.isInteger(idx)) return false
  const item = mod.menuItems[idx]
  if (!item) return false
  try { item.click(); return true } catch (err) {
    console.warn(`[mod:${modId}] menu invoke error`, err)
    return false
  }
}
