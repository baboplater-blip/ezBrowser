import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Userscript, UserscriptRunAt, UserscriptSummary } from '../../../shared/types'
import { compilePatterns, urlMatchesScript, type CompiledPattern } from './match'
import { clearForTab } from './menu'
import { resolveRequireBundle, resolveResources } from './require-cache'
import { getValuesSnapshot } from './values'

const userscripts = new Map<string, Userscript>()
let loaded = false
let counter = 0

export const userscriptEvents = new EventEmitter()

function dir(): string {
  return path.join(app.getPath('userData'), 'userscripts')
}

function nextId(): string {
  counter += 1
  return `us-${Date.now().toString(36)}-${counter}`
}

// ===== 메타데이터 파서 =====

const META_BLOCK = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/i
const META_LINE = /\/\/\s*@([\w-]+)(?:[ \t]+(.*))?/g

interface ParsedMeta {
  name: string; description: string; version: string; author: string; namespace: string
  match: string[]; exclude: string[]; grant: string[]; runAt: UserscriptRunAt
  noframes: boolean; connect: string[]; includePatterns: string[]
  requireUrls: string[]; resources: { name: string; url: string }[]
}

export function parseUserscript(source: string, fallbackName?: string): ParsedMeta {
  const m = META_BLOCK.exec(source)
  const meta: Record<string, string[]> = {}
  const flags = new Set<string>()
  if (m) {
    META_LINE.lastIndex = 0
    let mm: RegExpExecArray | null
    while ((mm = META_LINE.exec(m[1] ?? '')) !== null) {
      const key = (mm[1] ?? '').toLowerCase()
      const value = (mm[2] ?? '').trim()
      if (value === '' && mm[2] === undefined) flags.add(key)
      if (!meta[key]) meta[key] = []
      meta[key].push(value)
    }
  }
  const first = (key: string): string => (meta[key]?.[0] ?? '').trim()
  const all = (key: string): string[] => (meta[key] ?? []).filter(Boolean)
  const runAtRaw = first('run-at')
  const runAt: UserscriptRunAt =
    runAtRaw === 'document-start' || runAtRaw === 'document-idle' ? runAtRaw : 'document-end'

  const resources = all('resource').map((line) => {
    const sp = line.indexOf(' ')
    if (sp < 0) return null
    const name = line.slice(0, sp).trim()
    const url = line.slice(sp + 1).trim()
    return name && url ? { name, url } : null
  }).filter((x): x is { name: string; url: string } => x !== null)

  return {
    name: first('name') || fallbackName || '이름 없는 스크립트',
    description: first('description'),
    version: first('version') || '1.0',
    author: first('author'),
    namespace: first('namespace'),
    match: all('match'),
    exclude: all('exclude'),
    grant: all('grant'),
    runAt,
    noframes: flags.has('noframes') || meta['noframes'] !== undefined,
    connect: all('connect'),
    includePatterns: all('include'),
    requireUrls: all('require').filter((u) => /^https:\/\//i.test(u)),
    resources,
  }
}

// ===== match pattern 캐시 (스크립트별 컴파일 결과, 저장 시 무효화) =====

interface CompiledSet { positive: CompiledPattern[]; exclude: CompiledPattern[] }
const compiledCache = new Map<string, CompiledSet>()

function compiledFor(us: Userscript): CompiledSet {
  let c = compiledCache.get(us.id)
  if (!c) {
    c = {
      positive: compilePatterns([...us.match, ...us.includePatterns]),
      exclude: compilePatterns(us.exclude),
    }
    compiledCache.set(us.id, c)
  }
  return c
}

// ===== 저장소 =====

async function ensureDir(): Promise<void> {
  await mkdir(dir(), { recursive: true })
}

async function loadAll(): Promise<void> {
  if (loaded) return
  await ensureDir()
  try {
    const entries = await readdir(dir())
    for (const f of entries) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = await readFile(path.join(dir(), f), 'utf-8')
        const us = migrateLoaded(JSON.parse(raw) as Partial<Userscript>)
        if (us && us.id) userscripts.set(us.id, us)
      } catch (err) {
        console.warn('[userscript] load failed', f, err)
      }
    }
  } catch (err) {
    console.warn('[userscript] readdir failed', err)
  }
  loaded = true
}

/** 옛 스키마(묶음 I 이전)로 저장된 레코드에 새 필드 기본값을 채운다. */
function migrateLoaded(raw: Partial<Userscript>): Userscript | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null
  return {
    id: raw.id,
    name: raw.name ?? '이름 없는 스크립트',
    description: raw.description ?? '',
    version: raw.version ?? '1.0',
    author: raw.author ?? '',
    namespace: raw.namespace ?? '',
    enabled: raw.enabled !== false,
    match: Array.isArray(raw.match) ? raw.match : [],
    exclude: Array.isArray(raw.exclude) ? raw.exclude : [],
    grant: Array.isArray(raw.grant) ? raw.grant : [],
    runAt: raw.runAt === 'document-start' || raw.runAt === 'document-idle' ? raw.runAt : 'document-end',
    source: typeof raw.source === 'string' ? raw.source : '',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    noframes: raw.noframes === true,
    connect: Array.isArray(raw.connect) ? raw.connect : [],
    includePatterns: Array.isArray(raw.includePatterns) ? raw.includePatterns : [],
    requireUrls: Array.isArray(raw.requireUrls) ? raw.requireUrls : [],
    requireBundle: typeof raw.requireBundle === 'string' ? raw.requireBundle : '',
    requireErrors: Array.isArray(raw.requireErrors) ? raw.requireErrors : [],
    resources: Array.isArray(raw.resources) ? raw.resources : [],
    resourceCache: raw.resourceCache && typeof raw.resourceCache === 'object' ? raw.resourceCache : {},
  }
}

// id 는 그대로 파일 이름이 된다. `../..` 같은 값이 오면 프로필 **밖**에 쓰거나 지운다.
// 파일을 만지는 두 함수에서 막는다 — 어느 호출자를 거쳐도 새지 않게.
// (2026-09-07 임무 19: 데이터 가져오기에는 같은 방어가 있었는데 여기엔 없었다.)
function safeId(id: unknown): string | null {
  return typeof id === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(id) && !id.includes('..') ? id : null
}

async function persist(us: Userscript): Promise<void> {
  const safe = safeId(us.id)
  if (!safe) throw new Error('저장 id 가 올바르지 않습니다')
  await ensureDir()
  const p = path.join(dir(), `${safe}.json`)
  await writeFile(p, JSON.stringify(us, null, 2), 'utf-8')
}

async function removeFile(id: string): Promise<void> {
  const safe = safeId(id)
  if (!safe) return
  const p = path.join(dir(), `${safe}.json`)
  if (existsSync(p)) await unlink(p)
}

export async function initUserscripts(): Promise<void> {
  await loadAll()
  // GM_registerMenuCommand 로 등록된 명령은 그 탭의 "지금 문서"(격리 월드)에 묶여 있다 —
  // 탭이 다른 URL 로 이동하거나 닫히면 그 로컬 fn 맵은 사라지므로, 메인 쪽 레지스트리도 함께 비운다
  // (안 비우면 이미 떠난 페이지의 메뉴 항목이 영원히 listMenuCommands 에 남는다).
  try {
    const { onTabNavigated, onTabClosed } = await import('../../tabs/tab-service')
    onTabNavigated(({ id }) => clearForTab(id))
    onTabClosed((id) => clearForTab(id))
  } catch (err) {
    console.warn('[userscript] 탭 훅 등록 실패', err)
  }
}

// ===== CRUD =====

function summarize(us: Userscript): UserscriptSummary {
  return {
    id: us.id, name: us.name, description: us.description,
    version: us.version, enabled: us.enabled,
    match: us.match, updatedAt: us.updatedAt,
    grant: us.grant, noframes: us.noframes, requireErrors: us.requireErrors,
  }
}

export function listUserscripts(): UserscriptSummary[] {
  return Array.from(userscripts.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(summarize)
}

export function getUserscript(id: string): Userscript | null {
  return userscripts.get(id) ?? null
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}
function sameResourceList(a: readonly { name: string; url: string }[], b: readonly { name: string; url: string }[]): boolean {
  return a.length === b.length && a.every((v, i) => v.name === b[i]?.name && v.url === b[i]?.url)
}

export async function saveUserscript(input: { id?: string; source: string }): Promise<Userscript> {
  // 스크립트 본문은 **문자열**이어야 한다. 임무 19 실측: 검증이 없어 숫자·배열·null 이
  // 스크립트로 저장됐다(파서가 관대해 빈 메타로 통과시켰다).
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.source !== 'string') {
    throw new Error('userscript 형식이 올바르지 않습니다 — { source: string } 이어야 합니다')
  }
  const parsed = parseUserscript(input.source)
  const now = Date.now()
  const existing = input.id ? userscripts.get(input.id) : null

  // @require/@resource 는 목록이 안 바뀌었으면 재다운로드하지 않는다(저장할 때마다 네트워크
  // 왕복하지 않도록 — 흔한 케이스인 "본문만 고치고 다시 저장"에서 불필요한 지연/실패 방지).
  let requireBundle = existing?.requireBundle ?? ''
  let requireErrors = existing?.requireErrors ?? []
  if (!existing || !sameArray(existing.requireUrls, parsed.requireUrls)) {
    const r = await resolveRequireBundle(parsed.requireUrls)
    requireBundle = r.bundle
    requireErrors = r.errors
  }
  let resourceCache = existing?.resourceCache ?? {}
  if (!existing || !sameResourceList(existing.resources, parsed.resources)) {
    resourceCache = await resolveResources(parsed.resources)
  }

  const id = existing?.id ?? nextId()
  const us: Userscript = {
    id,
    name: parsed.name, description: parsed.description, version: parsed.version,
    author: parsed.author, namespace: parsed.namespace,
    enabled: existing?.enabled ?? true,
    match: parsed.match, exclude: parsed.exclude, grant: parsed.grant, runAt: parsed.runAt,
    source: input.source,
    createdAt: existing?.createdAt ?? now, updatedAt: now,
    noframes: parsed.noframes, connect: parsed.connect, includePatterns: parsed.includePatterns,
    requireUrls: parsed.requireUrls, requireBundle, requireErrors,
    resources: parsed.resources, resourceCache,
  }
  userscripts.set(us.id, us)
  compiledCache.delete(us.id)
  await persist(us)
  userscriptEvents.emit('changed')
  return us
}

export async function removeUserscript(id: string): Promise<void> {
  userscripts.delete(id)
  compiledCache.delete(id)
  await removeFile(id)
  const { clearValues } = await import('./values')
  clearValues(id)
  userscriptEvents.emit('changed')
}

export async function setUserscriptEnabled(id: string, enabled: boolean): Promise<void> {
  const us = userscripts.get(id)
  if (!us) return
  us.enabled = enabled
  us.updatedAt = Date.now()
  await persist(us)
  userscriptEvents.emit('changed')
}

// ===== 페이지 주입: 컨텍스트 계산 (순수·동기 — 매 네비게이션마다 IPC 로 호출됨) =====

export interface ScriptContextEntry {
  id: string
  name: string
  runAt: UserscriptRunAt
  worldId: number | null // null 이면 메인 월드(= @grant none, GM 없음) 실행
  code: string
  bridgeKey: string
}

/** 스크립트 id 로부터 결정적 isolated world id 를 만든다(스크립트마다 서로 다른 세계 — GM 값·전역이 안 섞이게). */
function worldIdFor(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return 5_000_000 + (h >>> 0) % 1_000_000
}

const GM_VALUE_GRANTS = ['GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues', 'GM.getValue', 'GM.setValue', 'GM.deleteValue', 'GM.listValues']
const GM_XHR_GRANTS = ['GM_xmlhttpRequest', 'GM.xmlHttpRequest']

function buildScriptCode(us: Userscript, bridgeKey: string): string {
  const grantSet = new Set(us.grant)
  const isNone = grantSet.size === 0 || (grantSet.size === 1 && grantSet.has('none'))
  const nameLit = JSON.stringify(us.name)
  const versionLit = JSON.stringify(us.version)
  const nsLit = JSON.stringify(us.namespace)
  const guardKey = '__bbUS_' + us.id.replace(/[^A-Za-z0-9]/g, '_')

  const header = `;(function() {\n'use strict';\nif (window.${guardKey}) return;\nwindow.${guardKey} = true;\n`
    + `var GM_info = { script: { name: ${nameLit}, version: ${versionLit}, namespace: ${nsLit} } };\n`

  const tryBlock = `try {\n${us.requireBundle}\n${us.source}\n} catch (err) { console.error('[userscript:' + GM_info.script.name + ']', err); }`
  // document-start 는 정말로 <html> 이 생기기 전에 실행될 수 있다(실측 확인 — Chromium 파서가
  // 문서 트리에 첫 노드를 넣기도 전, 즉 `document.documentElement` 가 아직 null 인 시점).
  // 실제 유저스크립트 다수가 documentElement 존재를 가정하므로, 없으면 MutationObserver 로
  // **생기는 즉시**(그 사이 페이지 스크립트가 끼어들 여지가 사실상 없는 첫 파싱 틱) 실행한다.
  const body = us.runAt === 'document-start'
    ? `function __bbReady(fn) {\n`
      + `  if (document.documentElement) { fn(); return; }\n`
      + `  var __mo;\n`
      + `  try {\n`
      + `    __mo = new MutationObserver(function() {\n`
      + `      if (document.documentElement) { try { __mo.disconnect(); } catch(e) {} fn(); }\n`
      + `    });\n`
      + `    __mo.observe(document, { childList: true });\n`
      + `  } catch (e) { fn(); }\n`
      + `}\n`
      + `__bbReady(function() {\n${tryBlock}\n});\n})();\n`
    : `${tryBlock}\n})();\n`

  if (isNone) {
    // GM 없음 — 메인 월드에서 그대로 실행(item 4 파라미터: "페이지 world 실행 옵션").
    // unsafeWindow 는 이 모드에선 실제 페이지 window 자체와 동일(완전 신뢰 — 어차피 GM 미사용).
    return header + `var unsafeWindow = window;\n` + body
  }

  const snapshotLit = JSON.stringify(getValuesSnapshot(us.id))
  const resourceLit = JSON.stringify(us.resourceCache)
  const parts: string[] = [header]
  parts.push(`var __bbVals = ${snapshotLit};\nvar __bbRes = ${resourceLit};\nvar __bbBridge = window[${JSON.stringify(bridgeKey)}];\n`)

  if (GM_VALUE_GRANTS.some((g) => grantSet.has(g))) {
    parts.push(`
function GM_getValue(k, d) { return (Object.prototype.hasOwnProperty.call(__bbVals, k)) ? __bbVals[k] : d; }
function GM_setValue(k, v) { __bbVals[k] = v; try { __bbBridge && __bbBridge.setValue(k, v); } catch(e) {} }
function GM_deleteValue(k) { delete __bbVals[k]; try { __bbBridge && __bbBridge.deleteValue(k); } catch(e) {} }
function GM_listValues() { return Object.keys(__bbVals); }
`)
  }
  if (grantSet.has('GM_addStyle')) {
    parts.push(`
function GM_addStyle(css) {
  var s = document.createElement('style');
  s.setAttribute('data-bb-userscript', ${JSON.stringify(us.id)});
  s.textContent = css;
  (document.head || document.documentElement).appendChild(s);
  return s;
}
`)
  }
  if (grantSet.has('GM_openInTab')) {
    parts.push(`function GM_openInTab(url) { return window.open(url, '_blank'); }\n`)
  }
  if (grantSet.has('GM_setClipboard')) {
    parts.push(`function GM_setClipboard(text) { try { navigator.clipboard.writeText(text); } catch(e) {} }\n`)
  }
  parts.push(`function GM_log() { console.log.apply(console, ['[userscript]', GM_info.script.name].concat([].slice.call(arguments))); }\n`)
  if (grantSet.has('GM_getResourceText')) {
    parts.push(`function GM_getResourceText(name) { var r = __bbRes[name]; return r ? r.text : undefined; }\n`)
  }
  if (grantSet.has('GM_getResourceURL')) {
    parts.push(`function GM_getResourceURL(name) { var r = __bbRes[name]; return r ? r.dataUrl : undefined; }\n`)
  }
  if (GM_XHR_GRANTS.some((g) => grantSet.has(g))) {
    parts.push(`
function __bbXhrCall(details) {
  if (!__bbBridge) return Promise.reject(new Error('GM_xmlhttpRequest 브릿지를 사용할 수 없습니다'));
  return __bbBridge.xhr({
    url: details && details.url, method: details && details.method,
    headers: details && details.headers, data: details && details.data, timeout: details && details.timeout,
  });
}
function GM_xmlhttpRequest(details) {
  details = details || {};
  var aborted = false;
  __bbXhrCall(details).then(function(resp) {
    if (aborted) return;
    if (resp.warning) { try { console.warn('[userscript:' + GM_info.script.name + ']', resp.warning); } catch(e) {} }
    if (resp.ok) { if (details.onload) details.onload(resp); }
    else { if (details.onerror) details.onerror(resp); }
  }, function(err) {
    if (aborted) return;
    var msg = (err && err.message) || String(err);
    if (details.onerror) details.onerror({ error: msg, status: 0, statusText: msg, responseText: '', responseHeaders: '', finalUrl: '' });
  });
  return { abort: function() { aborted = true; } };
}
`)
  }
  if (grantSet.has('GM_registerMenuCommand')) {
    parts.push(`
var __bbMenuFns = {};
if (__bbBridge && __bbBridge.onMenuRun) {
  __bbBridge.onMenuRun(function(id) { var fn = __bbMenuFns[id]; if (fn) { try { fn(); } catch(e) { console.error(e); } } });
}
function GM_registerMenuCommand(name, fn) {
  if (!__bbBridge) return null;
  __bbBridge.menuRegister(String(name)).then(function(id) { if (id) __bbMenuFns[id] = fn; });
  return null;
}
`)
  }
  // GM 객체(dot 표기, promise 버전) — 선언된 것만 조립(item 3).
  const gmParts: string[] = []
  if (GM_VALUE_GRANTS.some((g) => grantSet.has(g))) {
    gmParts.push(`
GM.getValue = function(k, d) { return Promise.resolve(GM_getValue(k, d)); };
GM.setValue = function(k, v) { GM_setValue(k, v); return Promise.resolve(); };
GM.deleteValue = function(k) { GM_deleteValue(k); return Promise.resolve(); };
GM.listValues = function() { return Promise.resolve(GM_listValues()); };
`)
  }
  if (GM_XHR_GRANTS.some((g) => grantSet.has(g))) {
    gmParts.push(`GM.xmlHttpRequest = function(details) { return __bbXhrCall(details || {}); };\n`)
  }
  if (gmParts.length) {
    parts.push(`var GM = {};\n${gmParts.join('')}`)
  }
  // unsafeWindow — 명시 grant 시에만 정의(스킬 가이드: "unsafeWindow 를 모든 스크립트에 노출 금지").
  // 격리 월드 자신의 window 다 — DOM 은 페이지와 공유되지만 페이지 스크립트가 만든 JS 전역은
  // 보이지 않는다(알려진 한계, item 1 보고 참고).
  if (grantSet.has('unsafeWindow')) {
    parts.push(`var unsafeWindow = window;\n`)
  }
  parts.push(body)
  return parts.join('')
}

/**
 * `e.senderFrame` 의 실제 URL·프레임 위치로 매칭한다(전달받은 값이 아니라 — 스푸핑 차단).
 * noframes 스크립트는 최상위 프레임에서만, 나머지는 모든 프레임에서(Tampermonkey 기본 동작).
 */
export function computeContextForFrame(url: string, isMainFrame: boolean): ScriptContextEntry[] {
  if (!/^https?:/i.test(url)) return []
  const out: ScriptContextEntry[] = []
  for (const us of userscripts.values()) {
    if (!us.enabled) continue
    if (us.noframes && !isMainFrame) continue
    const c = compiledFor(us)
    if (!urlMatchesScript(url, c.positive, c.exclude)) continue
    const grantSet = new Set(us.grant)
    const isNone = grantSet.size === 0 || (grantSet.size === 1 && grantSet.has('none'))
    const worldId = isNone ? null : worldIdFor(us.id)
    const bridgeKey = 'BB_GM_' + us.id.replace(/[^A-Za-z0-9]/g, '_')
    out.push({ id: us.id, name: us.name, runAt: us.runAt, worldId, code: buildScriptCode(us, bridgeKey), bridgeKey })
  }
  return out
}

function frameInfo(e: IpcMainEvent | IpcMainInvokeEvent): { url: string; isMainFrame: boolean } | null {
  try {
    const f = e.senderFrame
    if (f) {
      let u = ''
      try { u = f.url } catch { u = '' }
      if (!u) return null
      return { url: u, isMainFrame: f.parent === null }
    }
    return { url: e.sender.getURL(), isMainFrame: true }
  } catch {
    return null
  }
}

/** `IPC.userscript.contextSync` — ipcRenderer.sendSync 전용(document-start 타이밍 확보). */
export function registerContextSyncHandler(): void {
  ipcMain.on('userscript:context-sync', (e) => {
    const info = frameInfo(e)
    e.returnValue = info ? computeContextForFrame(info.url, info.isMainFrame) : []
  })
}

/** GM_setValue/GM_deleteValue/GM_xmlhttpRequest 호출을 스크립트별로 재검증한다(스푸핑 차단). */
export function verifyScriptCallable(id: string, e: IpcMainInvokeEvent, needGrant: readonly string[]): { us: Userscript; frame: { url: string; isMainFrame: boolean } } | null {
  const us = userscripts.get(id)
  if (!us || !us.enabled) return null
  const info = frameInfo(e)
  if (!info) return null
  if (us.noframes && !info.isMainFrame) return null
  const c = compiledFor(us)
  if (!urlMatchesScript(info.url, c.positive, c.exclude)) return null
  if (needGrant.length > 0 && !needGrant.some((g) => us.grant.includes(g))) return null
  return { us, frame: info }
}

// 예전엔 main 프로세스가 `wc.executeJavaScript` 로 직접 주입했다(dom-ready/did-finish-load 훅).
// 이제 주입은 **preload(external-features.ts)** 가 전담한다 — 그래야만
//  (a) contextBridge.exposeInIsolatedWorld 로 격리 월드에 GM 브릿지를 심을 수 있고(main 프로세스는
//      렌더러의 contextBridge 를 호출할 수 없다 — preload/렌더러 컨텍스트 전용 API),
//  (b) document-start 를 "페이지 자신의 스크립트보다 먼저"라는 진짜 의미로 지킬 수 있다
//      (Electron 은 preload 스크립트를 그 문서의 다른 어떤 스크립트보다도 먼저 실행되도록 보장한다 —
//      dom-ready/did-finish-load 는 이미 DOMContentLoaded 급으로 늦다. item 2 참고).
// 이 함수는 과거 시그니처 호환을 위해 남겨 두되, 더 이상 아무 것도 하지 않는다(app/main/index.ts 의
// onTabCreated 훅이 여전히 호출하므로 export 는 유지 — 그 파일은 다른 묶음도 건드리는 부팅 스크립트라
// 호출부를 지우지 않는다).
export function trackWebContents(_wc?: unknown): void {
  // no-op — 주입은 preload 가 수행한다. 인자는 호출부(app/main/index.ts) 호환용으로만 받는다.
  void _wc
}
