import { app, session, type Session, type WebContents } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { HeaderPair, PolicyRule, PolicyRuleSummary } from '../../../shared/types'
import { DEFAULT_SESSION } from '../../../shared/constants'

const policies = new Map<string, PolicyRule>()
let loaded = false
let counter = 0

export const policyEvents = new EventEmitter()

function dir(): string {
  return path.join(app.getPath('userData'), 'policies')
}

function nextId(): string {
  counter += 1
  return `pol-${Date.now().toString(36)}-${counter}`
}

// ===== Chrome 정식 match pattern → 정규식 =====
// https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
// 형식: <scheme>://<host>/<path>
//  - scheme: http | https | * | file
//  - host: '*' | '*.도메인' | '도메인'
//  - path: '/' 로 시작, '*' 와일드카드 허용
//  - 특수: '<all_urls>' = 모든 http/https/file/ftp

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

interface CompiledPattern {
  schemeRe: RegExp
  hostRe: RegExp
  pathRe: RegExp
}

const compileCache = new Map<string, CompiledPattern | null>()

function compileMatchPattern(pattern: string): CompiledPattern | null {
  const cached = compileCache.get(pattern)
  if (cached !== undefined) return cached
  const result = compileMatchPatternInner(pattern)
  compileCache.set(pattern, result)
  return result
}

function compileMatchPatternInner(pattern: string): CompiledPattern | null {
  if (pattern === '<all_urls>') {
    return {
      schemeRe: /^(http|https|file|ftp)$/i,
      hostRe: /^.*$/,
      pathRe: /^\/.*$/,
    }
  }

  // 스킴 분리
  const schemeMatch = /^([a-z*]+):\/\/(.*)$/i.exec(pattern)
  if (!schemeMatch || !schemeMatch[1] || !schemeMatch[2]) {
    // legacy 와일드카드 패턴 (예: '*example.com*') — 옛 단순 와일드카드로 fallback
    return compileLegacyPattern(pattern)
  }
  const scheme = schemeMatch[1].toLowerCase()
  const rest = schemeMatch[2]
  const schemeRe = scheme === '*'
    ? /^(http|https)$/i
    : new RegExp('^' + escapeRegex(scheme) + '$', 'i')

  // host 와 path 분리: 첫 '/' 가 분리점. host 에 path 없으면 path = '/*'
  let host: string
  let pathPart: string
  const slashIdx = rest.indexOf('/')
  if (slashIdx < 0) { host = rest; pathPart = '/*' }
  else { host = rest.slice(0, slashIdx); pathPart = rest.slice(slashIdx) }

  // host: '*' | '*.domain' | 'domain'
  let hostRe: RegExp
  if (host === '*') {
    hostRe = /^.*$/
  } else if (host.startsWith('*.')) {
    const suffix = host.slice(2)
    hostRe = new RegExp('^(.*\\.)?' + escapeRegex(suffix) + '$', 'i')
  } else if (host.includes('*')) {
    // 비표준 위치의 '*' — 단순 와일드카드 허용 (관대한 처리)
    hostRe = new RegExp('^' + host.split('').map((c) => c === '*' ? '.*' : escapeRegex(c)).join('') + '$', 'i')
  } else {
    hostRe = new RegExp('^' + escapeRegex(host) + '$', 'i')
  }

  // path: '*' 를 '.*' 로
  const pathRe = new RegExp('^' + pathPart.split('').map((c) => c === '*' ? '.*' : escapeRegex(c)).join('') + '$')

  return { schemeRe, hostRe, pathRe }
}

function compileLegacyPattern(pattern: string): CompiledPattern | null {
  // 'foo*bar' 같은 옛 단순 와일드카드 — URL 전체에 대해 .* 만 의미
  const re = new RegExp('^' + pattern.split('').map((c) => c === '*' ? '.*' : c === '?' ? '\\?' : escapeRegex(c)).join('') + '$', 'i')
  // schemeRe/hostRe/pathRe 를 우회 — 전체 URL 매칭 함수에서 별도 분기
  return {
    schemeRe: re,  // 마커로 전체-URL 정규식 사용
    hostRe: /.*/,
    pathRe: /.*/,
  }
}

function urlMatchesPattern(url: string, p: CompiledPattern, raw: string): boolean {
  // legacy 와일드카드 패턴 처리: '<scheme>://' 가 없으면 raw 전체에 매칭
  if (!/^[a-z*]+:\/\//i.test(raw) && raw !== '<all_urls>') {
    return p.schemeRe.test(url)
  }
  try {
    const u = new URL(url)
    const scheme = u.protocol.replace(/:$/, '')
    if (!p.schemeRe.test(scheme)) return false
    if (!p.hostRe.test(u.hostname)) return false
    const fullPath = u.pathname + u.search + u.hash
    if (!p.pathRe.test(fullPath)) return false
    return true
  } catch {
    return false
  }
}

function urlMatches(url: string, patterns: string[]): boolean {
  for (const p of patterns) {
    const compiled = compileMatchPattern(p)
    if (!compiled) continue
    if (urlMatchesPattern(url, compiled, p)) return true
  }
  return false
}

function activeRulesFor(url: string): PolicyRule[] {
  const out: PolicyRule[] = []
  for (const r of policies.values()) {
    if (!r.enabled) continue
    if (r.match.length === 0) continue
    if (!urlMatches(url, r.match)) continue
    out.push(r)
  }
  return out
}

// ===== 저장소 =====

async function ensureDir(): Promise<void> {
  await mkdir(dir(), { recursive: true })
}

const VALID_PERMISSIONS = ['media', 'geolocation', 'notifications', 'clipboard-read', 'fullscreen', 'pointerLock']
const VALID_DECISIONS = new Set(['allow', 'deny', 'default'])

function sanitizePermissions(input: unknown): Record<string, 'allow' | 'deny' | 'default'> | undefined {
  if (!input || typeof input !== 'object') return undefined
  const out: Record<string, 'allow' | 'deny' | 'default'> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!VALID_PERMISSIONS.includes(k)) continue
    if (typeof v !== 'string' || !VALID_DECISIONS.has(v)) continue
    if (v === 'default') continue
    out[k] = v as 'allow' | 'deny'
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeRule(input: Partial<PolicyRule>, fallbackId?: string, now = Date.now()): PolicyRule {
  return {
    id: input.id ?? fallbackId ?? nextId(),
    name: (input.name ?? '').trim() || '이름 없는 룰',
    enabled: input.enabled !== false,
    match: Array.isArray(input.match) ? input.match.filter((x) => typeof x === 'string' && x.trim()) : [],
    userAgent: (input.userAgent ?? '').trim(),
    reqHeadersSet: sanitizeHeaders(input.reqHeadersSet),
    reqHeadersRemove: sanitizeHeaderNames(input.reqHeadersRemove),
    resHeadersSet: sanitizeHeaders(input.resHeadersSet),
    resHeadersRemove: sanitizeHeaderNames(input.resHeadersRemove),
    stripCsp: !!input.stripCsp,
    blockCookies: !!input.blockCookies,
    blockJs: !!input.blockJs,
    blockImages: !!input.blockImages,
    customJs: typeof input.customJs === 'string' ? input.customJs : '',
    permissions: sanitizePermissions(input.permissions),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  }
}

/**
 * URL 에 매칭되는 룰들의 permission 결정.
 * - 'deny' 우선 (보안: 한 룰이라도 거부하면 거부)
 * - 그 외 'allow' 가 하나라도 있으면 허용
 * - 매칭 룰이 모두 미설정이면 null → 호출자가 기본 정책 적용
 */
export function permissionDecisionFor(url: string, permission: string): 'allow' | 'deny' | null {
  const rules = activeRulesFor(url)
  if (rules.length === 0) return null
  let anyAllow = false
  for (const r of rules) {
    const dec = r.permissions?.[permission]
    if (dec === 'deny') return 'deny'
    if (dec === 'allow') anyAllow = true
  }
  return anyAllow ? 'allow' : null
}

function sanitizeHeaders(arr: unknown): HeaderPair[] {
  if (!Array.isArray(arr)) return []
  return arr
    .map((h) => ({ name: String((h as HeaderPair)?.name ?? '').trim(), value: String((h as HeaderPair)?.value ?? '') }))
    .filter((h) => h.name.length > 0)
}

function sanitizeHeaderNames(arr: unknown): string[] {
  if (!Array.isArray(arr)) return []
  return arr.map((x) => String(x).trim()).filter((x) => x.length > 0)
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
        const obj = JSON.parse(raw) as Partial<PolicyRule>
        const r = normalizeRule(obj, obj.id, obj.updatedAt ?? Date.now())
        policies.set(r.id, r)
      } catch (err) {
        console.warn('[policy] load failed', f, err)
      }
    }
  } catch (err) {
    console.warn('[policy] readdir failed', err)
  }
  loaded = true
}

async function persist(r: PolicyRule): Promise<void> {
  await ensureDir()
  const p = path.join(dir(), `${r.id}.json`)
  await writeFile(p, JSON.stringify(r, null, 2), 'utf-8')
}

async function removeFile(id: string): Promise<void> {
  const p = path.join(dir(), `${id}.json`)
  if (existsSync(p)) await unlink(p)
}

// ===== CRUD =====

function summarize(r: PolicyRule): PolicyRuleSummary {
  return {
    id: r.id, name: r.name, enabled: r.enabled, match: r.match, updatedAt: r.updatedAt,
  }
}

export function listPolicies(): PolicyRuleSummary[] {
  return Array.from(policies.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(summarize)
}

export function getPolicy(id: string): PolicyRule | null {
  return policies.get(id) ?? null
}

export async function savePolicy(input: Partial<PolicyRule>): Promise<PolicyRule> {
  const existing = input.id ? policies.get(input.id) : null
  const merged = existing
    ? { ...existing, ...input, createdAt: existing.createdAt, updatedAt: Date.now() }
    : { ...input, createdAt: Date.now(), updatedAt: Date.now() }
  const r = normalizeRule(merged, existing?.id ?? input.id, Date.now())
  policies.set(r.id, r)
  await persist(r)
  policyEvents.emit('changed')
  return r
}

export async function removePolicy(id: string): Promise<void> {
  policies.delete(id)
  await removeFile(id)
  policyEvents.emit('changed')
}

export async function setPolicyEnabled(id: string, enabled: boolean): Promise<void> {
  const r = policies.get(id)
  if (!r) return
  r.enabled = enabled
  r.updatedAt = Date.now()
  await persist(r)
  policyEvents.emit('changed')
}

// ===== webRequest 후킹 =====

const CSP_HEADER_KEYS = new Set(['content-security-policy', 'content-security-policy-report-only'])
const SET_COOKIE_KEYS = new Set(['set-cookie'])
const REQ_COOKIE_KEYS = new Set(['cookie'])

function lowerKeyEntries(headers: Record<string, string | string[]>): Array<[string, string | string[]]> {
  return Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
}

function withoutHeaders(
  headers: Record<string, string | string[]>,
  blockedLower: Set<string>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (blockedLower.has(k.toLowerCase())) continue
    out[k] = v
  }
  return out
}

function setHeader(headers: Record<string, string | string[]>, name: string, value: string): void {
  // 케이스 일관성을 위해 동일 이름(대소문자 무시) 모두 제거 후 set
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) delete headers[k]
  }
  headers[name] = value
}

function applyToRequestHeaders(
  url: string, requestHeaders: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const rules = activeRulesFor(url)
  if (rules.length === 0) return requestHeaders
  let next: Record<string, string | string[]> = { ...requestHeaders }
  for (const r of rules) {
    if (r.userAgent) setHeader(next, 'User-Agent', r.userAgent)
    for (const h of r.reqHeadersSet) setHeader(next, h.name, h.value)
    const removed = new Set(r.reqHeadersRemove.map((s) => s.toLowerCase()))
    if (r.blockCookies) for (const k of REQ_COOKIE_KEYS) removed.add(k)
    if (removed.size > 0) next = withoutHeaders(next, removed)
  }
  return next
}

export function applyToResponseHeaders(
  url: string, responseHeaders: Record<string, string | string[]> | undefined,
): Record<string, string | string[]> | undefined {
  if (!responseHeaders) return responseHeaders
  const rules = activeRulesFor(url)
  if (rules.length === 0) return responseHeaders
  let next: Record<string, string | string[]> = { ...responseHeaders }
  const cspDirectives: string[] = []
  let dropCsp = false
  for (const r of rules) {
    for (const h of r.resHeadersSet) setHeader(next, h.name, h.value)
    const removed = new Set(r.resHeadersRemove.map((s) => s.toLowerCase()))
    if (r.stripCsp) dropCsp = true
    if (r.blockCookies) for (const k of SET_COOKIE_KEYS) removed.add(k)
    if (removed.size > 0) next = withoutHeaders(next, removed)
    if (r.blockJs) cspDirectives.push("script-src 'none'")
    if (r.blockImages) cspDirectives.push("img-src 'none'")
  }
  if (dropCsp) next = withoutHeaders(next, CSP_HEADER_KEYS)
  if (cspDirectives.length > 0) {
    // 새 CSP 강제 — stripCsp 가 우선 적용된 후라 충돌 없음. (stripCsp 안 켜져 있어도 추가 directive 로 작동)
    const existing = lowerKeyEntries(next)
      .find(([k]) => k === 'content-security-policy')
    const merged = (existing && !dropCsp ? String(existing[1]) + '; ' : '') + cspDirectives.join('; ')
    setHeader(next, 'Content-Security-Policy', merged)
  }
  return next
}

const installedSessions = new WeakSet<Session>()

export function installPolicyOn(ses: Session): void {
  installOn(ses)
}

function installOn(ses: Session): void {
  if (installedSessions.has(ses)) return
  installedSessions.add(ses)
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, cb) => {
    try {
      const next = applyToRequestHeaders(details.url, details.requestHeaders)
      cb({ cancel: false, requestHeaders: next })
    } catch (err) {
      console.warn('[policy] onBeforeSendHeaders error', err)
      cb({ cancel: false, requestHeaders: details.requestHeaders })
    }
  })
  ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, cb) => {
    try {
      const next = applyToResponseHeaders(details.url, details.responseHeaders)
      cb({ cancel: false, responseHeaders: next })
    } catch (err) {
      console.warn('[policy] onHeadersReceived error', err)
      cb({ cancel: false, responseHeaders: details.responseHeaders })
    }
  })
}

export async function initPolicies(): Promise<void> {
  await loadAll()
  // 세션별 install 은 session-bootstrap 의 hook 으로 처리됨 (idempotent)
}

// ===== customJs 주입 (페이지 컨텍스트) =====

function wrapCustomJs(rule: PolicyRule): string {
  const idLit = JSON.stringify(rule.id)
  const nameLit = JSON.stringify(rule.name)
  return `
;(function() {
  if (window.__bbPolicy && window.__bbPolicy[${idLit}]) return
  if (!window.__bbPolicy) window.__bbPolicy = {}
  window.__bbPolicy[${idLit}] = true
  try {
    (function() { ${rule.customJs} })()
  } catch (err) {
    console.error('[policy:' + ${nameLit} + '] customJs error', err)
  }
})();
`
}

async function injectCustomJs(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return
  const url = wc.getURL()
  if (!/^https?:/i.test(url)) return
  const rules = activeRulesFor(url).filter((r) => r.customJs.trim().length > 0)
  for (const r of rules) {
    try {
      await wc.executeJavaScript(wrapCustomJs(r), true)
    } catch (err) {
      console.warn(`[policy] inject ${r.name} failed`, err)
    }
  }
}

export function trackWebContents(wc: WebContents): void {
  wc.on('dom-ready', () => { void injectCustomJs(wc) })
}
