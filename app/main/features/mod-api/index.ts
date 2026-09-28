import { app, dialog, net } from 'electron'
import { EventEmitter } from 'node:events'
import { lookup as dnsLookup } from 'node:dns/promises'
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
  // 호스트가 보관하는 메뉴 항목 메타(라벨만). 실제 클릭 핸들러는 context 안에 남아있고,
  // 호출은 항상 vm.runInContext 로 JSON 인자만 넘겨 안전하게 위임한다(§보안 설계 참고).
  menuItems: Array<{ idx: number; label: string }>
  // 모드가 등록한 타이머 — 비활성화 시 일괄 취소(메인 루프 오염·누수 방지)
  timers: Set<NodeJS.Timeout>
  // 활성화된 mod 의 vm 컨텍스트. 이벤트 디스패치(탭 lifecycle·메뉴 클릭)는 이 컨텍스트에
  // JSON 문자열 인자로 작은 스크립트를 실행하는 방식으로만 이뤄진다 — 호스트 객체를
  // 컨텍스트에 직접 넘기지 않는다(넘기면 <값>.constructor.constructor 체인으로 탈출 가능).
  context: vm.Context | null
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

// 모드별 storage API — mod.id 당 하나만 생성해 재사용한다(캐시·250ms 디바운스 쓰기 타이머 공유).
// 매 storage.get/set 호출마다 새로 만들면 디바운스가 무의미해지고 파일을 중복으로 쓴다.
const storageApis = new Map<string, { get: (k: string) => unknown; set: (k: string, v: unknown) => void }>()

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

function storageApiFor(modId: string): { get: (k: string) => unknown; set: (k: string, v: unknown) => void } {
  let api = storageApis.get(modId)
  if (!api) { api = makeStorageApi(modId); storageApis.set(modId, api) }
  return api
}

function firstWindowId(): string | null {
  return getAllWindows()[0]?.id ?? null
}

// ===== 사설망/로컬 접근 차단 (mod.net.fetch, SSRF 방어) =====
// node 권한이 승인된 mod 는 어차피 require('http')/require('net') 로 로컬에 접근 가능하므로
// (명시 동의를 받은 완전 신뢰 escape hatch — 아래 mod.node 참고) 여기서는 예외를 두지 않는다.
// network 권한만 받은(= node 는 없는) mod 가 mod.net.fetch 를 사설망 스캔에 악용하는 것을 막는 게 목적.

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  if (a === 127) return true // loopback
  if (a === 10) return true // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 169 && b === 254) return true // link-local
  if (a === 0) return true // 0.0.0.0/8
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const low = ip.toLowerCase()
  if (low === '::1' || low === '::') return true
  if (low.startsWith('fe80:')) return true // link-local
  const first = low.split(':')[0] ?? ''
  if (/^f[cd][0-9a-f]{2}$/.test(first)) return true // fc00::/7 unique local
  return false
}

function isPrivateHostLiteral(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '0.0.0.0') return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIPv4(h)
  if (h.includes(':')) return isPrivateIPv6(h)
  return false
}

/**
 * 호스트명이 사설망/로컬 주소를 가리키는지 확인한다. IP 리터럴은 즉시 판정하고,
 * 도메인명은 DNS 조회 결과로 한 번 더 판정한다(흔한 "공인 도메인이 내부 IP 로 리졸브" 우회 차단).
 *
 * 한계(DNS 리바인딩): 이 조회와 실제 net.fetch 의 커넥션 사이에 DNS 응답이 바뀌면
 * (TTL=0 공격 등) 이 검사를 우회할 수 있다 — TOCTOU. 완전한 방어는 소켓 레벨에서
 * 연결 직전 IP 를 검사해야 하는데 Electron net.fetch 는 그 훅을 제공하지 않는다.
 * 조회 실패 시에는 가용성을 우선해 통과시킨다(모드가 완전히 막히는 것보다 낫다는 판단).
 */
async function isPrivateHostResolved(hostname: string): Promise<boolean> {
  if (isPrivateHostLiteral(hostname)) return true
  try {
    const { address } = await dnsLookup(hostname)
    return isPrivateHostLiteral(address)
  } catch {
    return false
  }
}

function requirePerm(perms: Set<ModPermission>, p: ModPermission): void {
  if (!perms.has(p)) throw new Error(`permission denied: ${p}`)
}

/**
 * mod 의 vm 컨텍스트 "밖"(호스트)에서 실제로 side-effect 를 수행하는 단일 진입점.
 * 컨텍스트 쪽 브리지 함수가 이 함수를 호출하며, 인자·반환값 모두 JSON 문자열로만 오간다 —
 * 이 함수 자체는 항상 호스트 realm 에서 돈다.
 */
async function hostDispatch(mod: LoadedMod, perms: Set<ModPermission>, method: string, argsJson: string): Promise<unknown> {
  let args: unknown[]
  try {
    const parsed = JSON.parse(argsJson) as unknown
    args = Array.isArray(parsed) ? parsed : []
  } catch {
    args = []
  }
  switch (method) {
    case 'log': console.log(`[mod:${mod.id}]`, ...args); return null
    case 'warn': console.warn(`[mod:${mod.id}]`, ...args); return null
    case 'error': console.error(`[mod:${mod.id}]`, ...args); return null
    case 'toast': {
      const text = String(args[0] ?? '').slice(0, 200)
      for (const ctx of getAllWindows()) {
        ctx.chrome.webContents.send('toast:show', { message: `[${mod.manifest.name}] ${text}`, ts: Date.now() })
      }
      return null
    }
    case 'tabs.list': {
      requirePerm(perms, 'tabs')
      return getAllTabs().map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
    }
    case 'tabs.create': {
      requirePerm(perms, 'tabs')
      const windowId = firstWindowId()
      if (!windowId) return null
      const url = args[0]
      const safe = typeof url === 'string' && /^https?:|^browser:/i.test(url) ? url : undefined
      const t = createTab({ windowId, url: safe })
      return t.id
    }
    case 'tabs.navigate': {
      requirePerm(perms, 'tabs')
      const [tabId, url] = args
      if (typeof tabId === 'string' && typeof url === 'string' && /^https?:|^browser:/i.test(url)) {
        navigateTab(tabId, url)
      }
      return null
    }
    case 'tabs.close': {
      requirePerm(perms, 'tabs')
      const [tabId] = args
      if (typeof tabId === 'string') closeTab(tabId)
      return null
    }
    case 'tabs.active': {
      requirePerm(perms, 'tabs')
      const windowId = firstWindowId()
      if (!windowId) return null
      const t = listTabs(windowId).find((x) => x.active)
      return t ? { id: t.id, url: t.url, title: t.title } : null
    }
    case 'menu.add': {
      requirePerm(perms, 'menu')
      const [idx, label] = args as [number, string]
      if (typeof idx !== 'number' || !Number.isInteger(idx) || typeof label !== 'string') return null
      mod.menuItems.push({ idx, label: label.slice(0, 80) })
      return null
    }
    case 'storage.get': {
      requirePerm(perms, 'storage')
      const [k] = args
      return storageApiFor(mod.id).get(String(k)) ?? null
    }
    case 'storage.set': {
      requirePerm(perms, 'storage')
      const [k, v] = args
      storageApiFor(mod.id).set(String(k), v)
      return null
    }
    case 'net.fetch': {
      requirePerm(perms, 'network')
      const [url, opts] = args as [string, { method?: string; headers?: Record<string, string>; body?: string } | undefined]
      if (typeof url !== 'string' || !/^https?:/i.test(url)) {
        throw new Error('net.fetch: http(s) URL 만 허용됩니다')
      }
      let parsedUrl: URL
      try {
        parsedUrl = new URL(url)
      } catch {
        throw new Error('net.fetch: 잘못된 URL 입니다')
      }
      if (await isPrivateHostResolved(parsedUrl.hostname)) {
        throw new Error('net.fetch: 사설망·로컬 주소는 허용되지 않습니다 (SSRF 방지)')
      }
      const res = await net.fetch(url, {
        method: opts?.method ?? 'GET',
        headers: opts?.headers,
        body: opts?.body,
      })
      const text = await res.text()
      return { ok: res.ok, status: res.status, text }
    }
    default:
      throw new Error(`unknown bridge method: ${method}`)
  }
}

/**
 * mod 코드가 실행되는 vm 컨텍스트에 먼저 주입되는 "부트스트랩" 스크립트를 만든다.
 *
 * ## 보안 설계 (2026-09-28, 묶음 G 재작성 — CRITICAL 샌드박스 탈출 수정)
 *
 * 예전 구현은 호스트(메인 프로세스) realm 에서 만든 `api` 객체(host Function/Object)를
 * `vm.createContext({ mod: api, ... })` 로 컨텍스트에 직접 꽂았다. 문제는 host 객체/함수를
 * *어떤 형태로든* 컨텍스트에 넘기면, mod 코드가 `아무값.constructor.constructor('코드')()`
 * (즉 host Object/Function 프로토타입 체인)로 host Function 생성자에 도달해 완전한
 * Node 권한(process, require 등)을 얻을 수 있다는 것 — `codeGeneration:false` 를 컨텍스트에
 * 걸어도 막지 못한다(그 옵션은 "그 컨텍스트 realm 의" 코드 생성만 막지, host realm 의
 * Function 생성자 호출에는 전혀 적용되지 않는다 — 실측 확인됨).
 *
 * 새 구조는 **host 객체를 단 하나도 mod 코드에 노출하지 않는다**:
 *  1. `__bbBridge` 라는 단일 host 함수(JSON 문자열만 주고받음)만 컨텍스트에 심는다.
 *     이 함수 자체도 `Object.setPrototypeOf(fn, null)` 로 프로토타입 체인을 끊어
 *     `.constructor` 접근조차 차단한다.
 *  2. 이 부트스트랩 스크립트(→ vm.Script 로 **컨텍스트 안에서** 컴파일·실행됨)가
 *     `__bbBridge` 를 클로저에 담고 **즉시 전역에서 삭제**한다. 이후 실행되는 mod 코드는
 *     `__bbBridge` 에 도달할 문법적 경로가 없다.
 *  3. `mod.*` API 전부(log/toast/tabs/menu/storage/net)를 **이 스크립트 안에서** 객체
 *     리터럴·함수로 새로 만든다 — 이 함수들은 컨텍스트 자신의 Function 생성자를 상속하므로
 *     `.constructor` 를 따라가도 (a) 이 컨텍스트의 Function 일 뿐이고 (b) 컨텍스트에
 *     `codeGeneration:{strings:false}` 를 걸어뒀으므로 그 Function 으로 문자열 코드를
 *     생성하는 것 자체가 차단된다(실측: eval/Function/제네레이터·async 생성자 전부 차단됨).
 *  4. host → mod 콜백(탭 이벤트·메뉴 클릭)은 host 가 직접 함수를 호출하는 게 아니라
 *     `vm.runInContext('__dispatchXxx(<JSON문자열>)', context)` 로, **컨텍스트 안에 정의된
 *     디스패처 함수에 JSON 문자열 인자만** 넘겨 실행한다. 그 함수는 자기 로컬(컨텍스트 내부)
 *     리스너 배열에서 콜백을 찾아 부른다 — host 객체가 인자로 건너가는 경로 자체가 없다.
 *  5. 에러도 `{ __bbErr: string }` 형태로 JSON 직렬화해 넘기고, 컨텍스트 쪽에서
 *     `new Error(...)` 로 **컨텍스트 자신의 Error** 를 던진다 (host Error 를 넘기면
 *     그 역시 host Function 체인으로 이어지는 탈출 경로가 된다).
 *
 * `mod.node.require`/`mod.node.process` 는 예외다 — node 권한을 사용자가 명시적으로
 * 승인(다이얼로그, 영구 저장)한 mod 에 한해 **의도적으로** host 의 raw require/process 를
 * 그대로 넘긴다. userChrome.js 정신의 "완전 신뢰 escape hatch"이며, 이미 `require('child_process')`
 * 로 무엇이든 할 수 있는 mod 이므로 여기서 추가로 막을 실익이 없다.
 */
function buildBootstrapScript(mod: LoadedMod, perms: Set<ModPermission>, nodeGranted: boolean): string {
  const infoJson = JSON.stringify(mod.manifest)
  const parts: string[] = []

  parts.push(`
(function (__bridge) {
  'use strict';
  try { delete globalThis.__bbBridge; } catch (e) {}
  function callHost(method, args) {
    return __bridge(method, JSON.stringify(args === undefined ? [] : args)).then(function (resultJson) {
      var parsed;
      try { parsed = JSON.parse(resultJson); } catch (e) { throw new Error('bridge response parse error'); }
      if (parsed && typeof parsed === 'object' && parsed.__bbErr) {
        throw new Error(String(parsed.__bbErr));
      }
      return parsed ? parsed.value : null;
    });
  }
  function fireAndForget(method, args) { callHost(method, args).catch(function () {}); }

  var mod = { info: ${infoJson} };
  mod.log = function () { fireAndForget('log', Array.prototype.slice.call(arguments)); };
  mod.toast = function (msg) { fireAndForget('toast', [msg]); };
`)

  if (perms.has('tabs')) {
    parts.push(`
  var __tabCreated = [], __tabClosed = [], __tabNavigated = [];
  mod.tabs = {
    onCreated: function (cb) { if (typeof cb === 'function') __tabCreated.push(cb); },
    onClosed: function (cb) { if (typeof cb === 'function') __tabClosed.push(cb); },
    onNavigated: function (cb) { if (typeof cb === 'function') __tabNavigated.push(cb); },
    list: function () { return callHost('tabs.list', []); },
    create: function (url) { return callHost('tabs.create', [url]); },
    navigate: function (tabId, url) { return callHost('tabs.navigate', [tabId, url]); },
    close: function (tabId) { return callHost('tabs.close', [tabId]); },
    active: function () { return callHost('tabs.active', []); },
  };
  globalThis.__dispatchTabCreated = function (json) {
    var info = JSON.parse(json);
    __tabCreated.forEach(function (cb) { try { cb(info); } catch (e) { console.error(e); } });
  };
  globalThis.__dispatchTabClosed = function (json) {
    var id = JSON.parse(json);
    __tabClosed.forEach(function (cb) { try { cb(id); } catch (e) { console.error(e); } });
  };
  globalThis.__dispatchTabNavigated = function (json) {
    var info = JSON.parse(json);
    __tabNavigated.forEach(function (cb) { try { cb(info); } catch (e) { console.error(e); } });
  };
`)
  }

  if (perms.has('menu')) {
    parts.push(`
  var __menuClicks = [];
  mod.menu = {
    add: function (item) {
      if (!item || typeof item.label !== 'string' || typeof item.click !== 'function') return;
      var idx = __menuClicks.length;
      __menuClicks.push(item.click);
      fireAndForget('menu.add', [idx, String(item.label).slice(0, 80)]);
    },
  };
  globalThis.__invokeMenuClick = function (idxJson) {
    var idx = JSON.parse(idxJson);
    var fn = __menuClicks[idx];
    if (typeof fn === 'function') { try { fn(); } catch (e) { console.error(e); } }
  };
`)
  }

  if (perms.has('storage')) {
    parts.push(`
  mod.storage = {
    get: function (k) { return callHost('storage.get', [k]); },
    set: function (k, v) { return callHost('storage.set', [k, v]); },
  };
`)
  }

  if (perms.has('network')) {
    parts.push(`
  mod.net = {
    fetch: function (url, opts) {
      return callHost('net.fetch', [url, opts]).then(function (r) {
        return {
          ok: r.ok, status: r.status, text: r.text,
          json: function () { try { return JSON.parse(r.text); } catch (e) { return null; } },
        };
      });
    },
  };
`)
  }

  if (nodeGranted) {
    // 명시 동의(node 권한)를 받은 mod 만 — 의도적으로 host require/process 를 그대로 넘긴다.
    parts.push(`
  mod.node = { require: __bbNodeRequire, process: __bbNodeProcess, modDir: ${JSON.stringify(mod.modPath)} };
  try { delete globalThis.__bbNodeRequire; delete globalThis.__bbNodeProcess; } catch (e) {}
`)
  }

  parts.push(`
  var console = {
    log: function () { fireAndForget('log', Array.prototype.slice.call(arguments)); },
    warn: function () { fireAndForget('warn', Array.prototype.slice.call(arguments)); },
    error: function () { fireAndForget('error', Array.prototype.slice.call(arguments)); },
  };
  globalThis.console = console;
  globalThis.mod = mod;
})(__bbBridge);
`)
  return parts.join('\n')
}

/** 타이머(setTimeout 등)를 컨텍스트에 안전하게 노출한다 — 반환값은 host Timeout 객체가 아닌
 *  평범한 숫자 핸들(사설 카운터)이어야 한다. host Timeout 객체를 그대로 돌려주면
 *  그 객체의 프로토타입 체인을 타고 또 다른 탈출 경로가 열린다. */
function makeTimerApis(mod: LoadedMod): {
  trackedSetTimeout: (fn: () => void, ms?: number) => number
  trackedClearTimeout: (h: number) => void
  trackedSetInterval: (fn: () => void, ms?: number) => number
  trackedClearInterval: (h: number) => void
} {
  const handles = new Map<number, NodeJS.Timeout>()
  let counter = 0
  const trackedSetTimeout = (fn: () => void, ms?: number): number => {
    const handleId = ++counter
    const t = setTimeout(() => {
      handles.delete(handleId)
      mod.timers.delete(t)
      try { fn() } catch (e) { console.warn(`[mod:${mod.id}] timer error`, e) }
    }, ms)
    handles.set(handleId, t)
    mod.timers.add(t)
    return handleId
  }
  const trackedClearTimeout = (h: number): void => {
    const t = handles.get(h)
    if (t) { clearTimeout(t); mod.timers.delete(t); handles.delete(h) }
  }
  const trackedSetInterval = (fn: () => void, ms?: number): number => {
    const handleId = ++counter
    const t = setInterval(() => {
      try { fn() } catch (e) { console.warn(`[mod:${mod.id}] interval error`, e) }
    }, ms)
    handles.set(handleId, t)
    mod.timers.add(t)
    return handleId
  }
  const trackedClearInterval = (h: number): void => {
    const t = handles.get(h)
    if (t) { clearInterval(t); mod.timers.delete(t); handles.delete(h) }
  }
  for (const fn of [trackedSetTimeout, trackedClearTimeout, trackedSetInterval, trackedClearInterval]) {
    try { Object.setPrototypeOf(fn, null) } catch { /* 방어적 하드닝 실패는 무시 — 기능엔 영향 없음 */ }
  }
  return { trackedSetTimeout, trackedClearTimeout, trackedSetInterval, trackedClearInterval }
}

function executeModCode(mod: LoadedMod, code: string, nodeGranted: boolean): void {
  const perms = new Set(mod.manifest.permissions)
  mod.menuItems = []
  mod.context = null

  const bridgeImpl = (method: string, argsJson: string): Promise<string> =>
    hostDispatch(mod, perms, method, argsJson).then(
      (value) => JSON.stringify({ value: value === undefined ? null : value }),
      (err) => JSON.stringify({ __bbErr: err instanceof Error ? err.message : String(err) }),
    )
  try { Object.setPrototypeOf(bridgeImpl, null) } catch { /* 방어적 하드닝 실패는 무시 */ }

  const timers = makeTimerApis(mod)

  const sandbox: Record<string, unknown> = {
    __bbBridge: bridgeImpl,
    setTimeout: timers.trackedSetTimeout,
    clearTimeout: timers.trackedClearTimeout,
    setInterval: timers.trackedSetInterval,
    clearInterval: timers.trackedClearInterval,
  }
  if (nodeGranted) {
    // 의도적 완전 신뢰 escape hatch — 아래 buildBootstrapScript 주석 참고.
    sandbox.__bbNodeRequire = require
    sandbox.__bbNodeProcess = process
  }

  let context: vm.Context
  try {
    context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })
  } catch (err) {
    mod.hasError = true
    mod.errorMessage = err instanceof Error ? err.message : String(err)
    return
  }

  try {
    const bootstrap = buildBootstrapScript(mod, perms, nodeGranted)
    new vm.Script(bootstrap, { filename: `mod:${mod.id}/bootstrap.js` }).runInContext(context, { timeout: 5000 })
    const script = new vm.Script(code, { filename: `mod:${mod.id}/index.js` })
    script.runInContext(context, { timeout: 5000 })
    mod.context = context
    mod.hasError = false
    mod.errorMessage = undefined
  } catch (err) {
    mod.hasError = true
    mod.errorMessage = err instanceof Error ? err.message : String(err)
    mod.context = null
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
      menuItems: [],
      timers: new Set(),
      context: null,
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
    // 활성화 전 타이머·메뉴·컨텍스트 초기화 (재로드 시 중복 방지)
    clearModTimers(mod)
    mod.menuItems = []
    mod.context = null
    executeModCode(mod, code, nodeGranted)
    mod.enabled = true
  } catch (err) {
    mod.hasError = true
    mod.errorMessage = err instanceof Error ? err.message : String(err)
    mod.context = null
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
    mod.menuItems = []
    mod.context = null
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
  mod.context = null
  storageApis.delete(id)
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
// 호스트 객체를 컨텍스트에 직접 넘기지 않고, JSON 문자열 인자로 컨텍스트 안의
// __dispatchXxx 디스패처 함수를 실행하는 방식으로만 이벤트를 전달한다.

function dispatchToContext(mod: LoadedMod, fnName: string, payload: unknown): void {
  if (!mod.enabled || !mod.context || !mod.manifest.permissions.includes('tabs')) return
  try {
    const jsonArg = JSON.stringify(JSON.stringify(payload))
    vm.runInContext(`${fnName}(${jsonArg})`, mod.context, { timeout: 2000, filename: `mod:${mod.id}/dispatch.js` })
  } catch (err) {
    console.warn(`[mod:${mod.id}] ${fnName} dispatch error`, err)
  }
}

export function dispatchTabCreated(info: { id: string; webContentsId: number }): void {
  for (const mod of mods.values()) dispatchToContext(mod, '__dispatchTabCreated', info)
}

export function dispatchTabClosed(id: string): void {
  for (const mod of mods.values()) dispatchToContext(mod, '__dispatchTabClosed', id)
}

export function dispatchTabNavigated(info: { id: string; url: string; title: string }): void {
  for (const mod of mods.values()) dispatchToContext(mod, '__dispatchTabNavigated', info)
}

/** 메뉴 항목 클릭을 안전하게 위임한다 — 실제 클릭 핸들러는 컨텍스트 안에 남아있고,
 *  host 는 인덱스(숫자)만 JSON 으로 넘겨 컨텍스트 안의 디스패처를 실행시킨다. */
export function invokeMenuItem(id: string): boolean {
  const sep = id.lastIndexOf('::')
  if (sep < 0) return false
  const modId = id.slice(0, sep)
  const idx = Number(id.slice(sep + 2))
  const mod = mods.get(modId)
  if (!mod || !mod.enabled || !mod.context || !Number.isInteger(idx)) return false
  const has = mod.menuItems.some((m) => m.idx === idx)
  if (!has) return false
  try {
    vm.runInContext(`__invokeMenuClick(${JSON.stringify(JSON.stringify(idx))})`, mod.context, {
      timeout: 5000, filename: `mod:${modId}/menu-click.js`,
    })
    return true
  } catch (err) {
    console.warn(`[mod:${modId}] menu invoke error`, err)
    return false
  }
}

/** 명령 팔레트/외피용: 안정 id 가 붙은 모드 메뉴 메타 목록 */
export function listMenuItemsMeta(): Array<{ id: string; modId: string; modName: string; label: string }> {
  const out: Array<{ id: string; modId: string; modName: string; label: string }> = []
  for (const mod of mods.values()) {
    if (!mod.enabled) continue
    for (const item of mod.menuItems) {
      out.push({ id: `${mod.id}::${item.idx}`, modId: mod.id, modName: mod.manifest.name, label: item.label })
    }
  }
  return out
}

/** context-menu 모듈 등 기존 호출부 호환용 — click() 을 부르면 내부적으로 invokeMenuItem 을 탄다. */
export function collectMenuItems(): Array<{ modId: string; label: string; click: () => void }> {
  const out: Array<{ modId: string; label: string; click: () => void }> = []
  for (const mod of mods.values()) {
    if (!mod.enabled) continue
    for (const item of mod.menuItems) {
      const id = `${mod.id}::${item.idx}`
      out.push({ modId: mod.id, label: item.label, click: () => { invokeMenuItem(id) } })
    }
  }
  return out
}
