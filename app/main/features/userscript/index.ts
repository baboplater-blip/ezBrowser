import { app, type WebContents } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Userscript, UserscriptRunAt, UserscriptSummary } from '../../../shared/types'

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
const META_LINE = /\/\/\s*@([\w-]+)(?:\s+(.*))?/g

export function parseUserscript(source: string, fallbackName?: string): {
  name: string; description: string; version: string; author: string; namespace: string
  match: string[]; exclude: string[]; grant: string[]; runAt: UserscriptRunAt
} {
  const m = META_BLOCK.exec(source)
  const meta: Record<string, string[]> = {}
  if (m) {
    META_LINE.lastIndex = 0
    let mm: RegExpExecArray | null
    while ((mm = META_LINE.exec(m[1] ?? '')) !== null) {
      const key = (mm[1] ?? '').toLowerCase()
      const value = (mm[2] ?? '').trim()
      if (!meta[key]) meta[key] = []
      meta[key].push(value)
    }
  }
  const first = (key: string): string => (meta[key]?.[0] ?? '').trim()
  const all = (key: string): string[] => (meta[key] ?? []).filter(Boolean)
  const runAtRaw = first('run-at')
  const runAt: UserscriptRunAt =
    runAtRaw === 'document-start' || runAtRaw === 'document-idle' ? runAtRaw : 'document-end'
  return {
    name: first('name') || fallbackName || '이름 없는 스크립트',
    description: first('description'),
    version: first('version') || '1.0',
    author: first('author'),
    namespace: first('namespace'),
    match: [...all('match'), ...all('include')],
    exclude: all('exclude'),
    grant: all('grant'),
    runAt,
  }
}

// ===== Chrome match pattern → 정규식 =====

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

function matchPatternToRegex(pattern: string): RegExp {
  // Chrome match pattern: <scheme>://<host>/<path>
  // 가장 단순 변환: * → .*, ? 그대로 escape, 나머지는 literal
  // 와일드카드 *, ? 만 의미.
  const compiled = pattern
    .split('')
    .map((c) => {
      if (c === '*') return '.*'
      if (c === '?') return '\\?'
      return escapeRegex(c)
    })
    .join('')
  return new RegExp('^' + compiled + '$', 'i')
}

function urlMatches(url: string, patterns: string[]): boolean {
  for (const p of patterns) {
    try {
      if (matchPatternToRegex(p).test(url)) return true
    } catch { /* ignore */ }
  }
  return false
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
        const us = JSON.parse(raw) as Userscript
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

async function persist(us: Userscript): Promise<void> {
  await ensureDir()
  const p = path.join(dir(), `${us.id}.json`)
  await writeFile(p, JSON.stringify(us, null, 2), 'utf-8')
}

async function removeFile(id: string): Promise<void> {
  const p = path.join(dir(), `${id}.json`)
  if (existsSync(p)) await unlink(p)
}

export async function initUserscripts(): Promise<void> {
  await loadAll()
}

// ===== CRUD =====

function summarize(us: Userscript): UserscriptSummary {
  return {
    id: us.id, name: us.name, description: us.description,
    version: us.version, enabled: us.enabled,
    match: us.match, updatedAt: us.updatedAt,
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

export async function saveUserscript(input: { id?: string; source: string }): Promise<Userscript> {
  const parsed = parseUserscript(input.source)
  const now = Date.now()
  const existing = input.id ? userscripts.get(input.id) : null
  const us: Userscript = existing
    ? { ...existing, ...parsed, source: input.source, updatedAt: now }
    : {
      id: nextId(),
      ...parsed,
      enabled: true,
      source: input.source,
      createdAt: now,
      updatedAt: now,
    }
  userscripts.set(us.id, us)
  await persist(us)
  userscriptEvents.emit('changed')
  return us
}

export async function removeUserscript(id: string): Promise<void> {
  userscripts.delete(id)
  await removeFile(id)
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

// ===== 페이지 주입 =====

function wrap(us: Userscript): string {
  const idLit = JSON.stringify(us.id)
  const nameLit = JSON.stringify(us.name)
  const versionLit = JSON.stringify(us.version)
  return `
;(function() {
  if (window.__bbUS && window.__bbUS[${idLit}]) return
  if (!window.__bbUS) window.__bbUS = {}
  window.__bbUS[${idLit}] = true
  var SCRIPT_ID = ${idLit}
  var GM_info = { script: { name: ${nameLit}, version: ${versionLit} } }
  function _key(k) { return 'GM_' + SCRIPT_ID + '_' + k }
  function GM_setValue(k, v) { try { localStorage.setItem(_key(k), JSON.stringify(v)) } catch(e) {} }
  function GM_getValue(k, def) {
    try {
      var v = localStorage.getItem(_key(k))
      return v == null ? def : JSON.parse(v)
    } catch(e) { return def }
  }
  function GM_deleteValue(k) { try { localStorage.removeItem(_key(k)) } catch(e) {} }
  function GM_listValues() {
    var out = []
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i)
        if (key && key.indexOf('GM_' + SCRIPT_ID + '_') === 0) out.push(key.slice(('GM_' + SCRIPT_ID + '_').length))
      }
    } catch(e) {}
    return out
  }
  function GM_addStyle(css) {
    var s = document.createElement('style')
    s.setAttribute('data-bb-userscript', SCRIPT_ID)
    s.textContent = css
    ;(document.head || document.documentElement).appendChild(s)
    return s
  }
  function GM_openInTab(url) { return window.open(url, '_blank') }
  function GM_setClipboard(text) {
    try { navigator.clipboard.writeText(text) } catch(e) {}
  }
  function GM_log() { console.log.apply(console, ['[userscript]', GM_info.script.name].concat([].slice.call(arguments))) }
  var unsafeWindow = window
  try {
    (function(GM_info, GM_setValue, GM_getValue, GM_deleteValue, GM_listValues, GM_addStyle, GM_openInTab, GM_setClipboard, GM_log, unsafeWindow) {
      ${us.source}
    })(GM_info, GM_setValue, GM_getValue, GM_deleteValue, GM_listValues, GM_addStyle, GM_openInTab, GM_setClipboard, GM_log, unsafeWindow)
  } catch(err) {
    console.error('[userscript:' + GM_info.script.name + ']', err)
  }
})();
`
}

async function injectScripts(wc: WebContents, runAtTrigger: UserscriptRunAt): Promise<void> {
  if (wc.isDestroyed()) return
  const url = wc.getURL()
  if (!/^https?:/i.test(url)) return
  for (const us of userscripts.values()) {
    if (!us.enabled) continue
    if (us.runAt !== runAtTrigger) continue
    if (us.match.length === 0) continue
    if (!urlMatches(url, us.match)) continue
    if (us.exclude.length > 0 && urlMatches(url, us.exclude)) continue
    try {
      await wc.executeJavaScript(wrap(us), true)
    } catch (err) {
      console.warn(`[userscript] inject ${us.name} failed`, err)
    }
  }
}

export function trackWebContents(wc: WebContents): void {
  // run-at 별 hook
  wc.on('did-start-navigation', () => { /* document-start 는 dom-ready 가 가장 가까움 */ })
  wc.on('dom-ready', () => {
    void injectScripts(wc, 'document-start')
    void injectScripts(wc, 'document-end')
  })
  wc.on('did-finish-load', () => {
    void injectScripts(wc, 'document-idle')
  })
}
