// dnr.ts — 크롬 확장의 declarativeNetRequest(정적 룰셋) 지원.
//
// 왜 (2026-09-07, 임무 36): `electron-chrome-extensions` 에는 DNR 구현이 없고 Electron 도
// 확장용 DNR 을 제공하지 않는다. 그래서 uBO Lite 같은 **MV3 차단기는 로드는 되지만 아무것도
// 막지 못했다**(임무 34 에서 시험 확장으로 확인). CLAUDE.md 가 지원 우선순위 2번으로 적은 API 다.
//
// 여기서는 확장의 manifest 에 선언된 **정적 룰셋**을 읽어 우리 webRequest 경로에서 적용한다.
//
// 구현 범위(정직하게):
//   O  정적 룰셋(`declarative_net_request.rule_resources`, enabled:true)
//   O  액션 block / allow / redirect(url·extensionPath) / upgradeScheme
//   O  조건 urlFilter(크롬 문법 || | ^ *) · regexFilter · resourceTypes(+excluded)
//      · initiatorDomains(+excluded) · requestDomains(+excluded) · isUrlFilterCaseSensitive
//   O  priority + **allow 가 block 을 이긴다**(같은 우선순위에서)
//   X  동적 룰 API(updateDynamicRules 등) — 확장이 런타임에 룰을 바꾸는 경우는 아직 미지원
//   X  modifyHeaders — 응답/요청 헤더 변형은 다음 단계
//
// ⚠ 세션당 webRequest 리스너는 **하나만** 유효하다(회귀 #5 계열). 그래서 이 모듈은 리스너를
//    직접 걸지 않고 **순수 판정 함수**만 제공하고, adblock 모듈의 단일 리스너가 호출한다.

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

type ActionType = 'block' | 'allow' | 'redirect' | 'upgradeScheme' | 'allowAllRequests' | 'modifyHeaders'

interface HeaderOp { header?: string; operation?: string; value?: string }

interface RawRule {
  id?: number
  priority?: number
  action?: {
    type?: string
    redirect?: { url?: string; extensionPath?: string }
    requestHeaders?: HeaderOp[]
    responseHeaders?: HeaderOp[]
  }
  condition?: {
    urlFilter?: string
    regexFilter?: string
    isUrlFilterCaseSensitive?: boolean
    resourceTypes?: string[]
    excludedResourceTypes?: string[]
    initiatorDomains?: string[]
    excludedInitiatorDomains?: string[]
    domains?: string[]              // MV2 시절 이름 — 호환으로 받아 준다
    excludedDomains?: string[]
    requestDomains?: string[]
    excludedRequestDomains?: string[]
    domainType?: string          // 'firstParty' | 'thirdParty'
  }
}

interface CompiledRule {
  extId: string
  id: number
  priority: number
  action: ActionType
  redirectUrl?: string
  redirectExtensionPath?: string
  requestHeaders?: HeaderOp[]
  responseHeaders?: HeaderOp[]
  test: (url: string) => boolean
  resourceTypes?: Set<string>
  excludedResourceTypes?: Set<string>
  initiatorDomains?: string[]
  excludedInitiatorDomains?: string[]
  requestDomains?: string[]
  excludedRequestDomains?: string[]
  domainType?: 'firstParty' | 'thirdParty'
}

let staticRules: CompiledRule[] = []
// 확장이 런타임에 넣는 룰. dynamic 은 **재시작 후에도 유지**(크롬과 같다), session 은 메모리만.
const dynamicRaw = new Map<string, RawRule[]>()
const sessionRaw = new Map<string, RawRule[]>()
let diskCompiled: CompiledRule[] = []   // Chromium 이 디스크에 쓴 확장 동적 룰
let dynamicCompiled: CompiledRule[] = []
let sessionCompiled: CompiledRule[] = []
// 매칭에 쓰는 최종 목록(정적 + 동적 + 세션을 우선순위로 정렬해 합친 것).
let rules: CompiledRule[] = []

function rankOf(a: CompiledRule): number {
  return a.action === 'allow' || a.action === 'allowAllRequests' ? 0 : 1
}

function rebuildMerged(): void {
  rules = [...staticRules, ...dynamicCompiled, ...sessionCompiled, ...diskCompiled]
    .sort((a, b) => (b.priority - a.priority) || (rankOf(a) - rankOf(b)))
}

function compileList(extId: string, list: RawRule[]): CompiledRule[] {
  const out: CompiledRule[] = []
  for (const raw of list) { const c = compile(extId, raw); if (c) out.push(c) }
  return out
}

function recompileRuntime(): void {
  dynamicCompiled = []
  for (const [id, list] of dynamicRaw) dynamicCompiled.push(...compileList(id, list))
  sessionCompiled = []
  for (const [id, list] of sessionRaw) sessionCompiled.push(...compileList(id, list))
  rebuildMerged()
}

export function dnrRuleCount(): number { return rules.length }

/** 확장별 적용 룰 수 — 설정 화면 표시와 검증 하네스가 쓴다. */
export function dnrRuleCountFor(extId: string): number {
  let n = 0
  for (const r of rules) if (r.extId === extId) n++
  return n
}

function extensionsRoot(): string {
  return path.join(app.getPath('userData'), 'extensions')
}

/**
 * 크롬 urlFilter 문법을 정규식으로.
 *   ||  도메인 시작(서브도메인 포함)   |  URL 의 시작/끝   ^  구분자   *  임의 문자열
 * 그 외 문자는 그대로(정규식 특수문자는 이스케이프).
 */
function urlFilterToRegExp(filter: string, caseSensitive: boolean): RegExp {
  const esc = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let re = ''
  let i = 0
  if (filter.startsWith('||')) { re += '^[a-z]+://([^/?#]*\\.)?'; i = 2 }
  else if (filter.startsWith('|')) { re += '^'; i = 1 }
  const endAnchored = filter.length > 1 && filter.endsWith('|')
  const body = endAnchored ? filter.slice(i, -1) : filter.slice(i)
  for (const ch of body) {
    if (ch === '*') re += '.*'
    else if (ch === '^') re += '[^a-zA-Z0-9._%-]'   // 크롬의 구분자 정의(영숫자·_.%- 가 아닌 것)
    else re += esc(ch)
  }
  if (endAnchored) re += '$'
  return new RegExp(re, caseSensitive ? '' : 'i')
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

/** 도메인 목록 매칭 — 정확히 같거나 서브도메인이면 참(크롬과 같은 규칙). */
function domainMatches(host: string, list: string[]): boolean {
  return list.some((d) => {
    const dd = String(d).toLowerCase().replace(/^\./, '')
    return host === dd || host.endsWith('.' + dd)
  })
}

function compile(extId: string, raw: RawRule): CompiledRule | null {
  const c = raw.condition ?? {}
  const type = String(raw.action?.type ?? '') as ActionType
  if (!type) return null

  let test: (url: string) => boolean
  if (typeof c.regexFilter === 'string' && c.regexFilter) {
    let re: RegExp
    try { re = new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive ? '' : 'i') } catch { return null }
    test = (u) => re.test(u)
  } else if (typeof c.urlFilter === 'string' && c.urlFilter) {
    let re: RegExp
    try { re = urlFilterToRegExp(c.urlFilter, !!c.isUrlFilterCaseSensitive) } catch { return null }
    test = (u) => re.test(u)
  } else {
    test = () => true   // 조건에 URL 패턴이 없으면 모든 URL(도메인·타입 조건으로 좁힌다)
  }

  return {
    extId,
    id: Number(raw.id) || 0,
    priority: Number(raw.priority) || 1,
    action: type,
    redirectUrl: raw.action?.redirect?.url,
    redirectExtensionPath: raw.action?.redirect?.extensionPath,
    requestHeaders: Array.isArray(raw.action?.requestHeaders) ? raw.action.requestHeaders : undefined,
    responseHeaders: Array.isArray(raw.action?.responseHeaders) ? raw.action.responseHeaders : undefined,
    test,
    resourceTypes: Array.isArray(c.resourceTypes) ? new Set(c.resourceTypes) : undefined,
    excludedResourceTypes: Array.isArray(c.excludedResourceTypes) ? new Set(c.excludedResourceTypes) : undefined,
    initiatorDomains: c.initiatorDomains ?? c.domains,
    excludedInitiatorDomains: c.excludedInitiatorDomains ?? c.excludedDomains,
    requestDomains: c.requestDomains,
    excludedRequestDomains: c.excludedRequestDomains,
    domainType: c.domainType === 'firstParty' || c.domainType === 'thirdParty' ? c.domainType : undefined,
  }
}

/** 같은 사이트인가(등록 가능 도메인 근사 — 마지막 두 라벨 비교). */
function sameSite(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const tail = (h: string): string => h.split('.').slice(-2).join('.')
  return tail(a) === tail(b)
}

/** Electron webRequest 의 resourceType 을 크롬 DNR 의 이름으로. */
function toDnrResourceType(t: string): string {
  switch (t) {
    case 'mainFrame': return 'main_frame'
    case 'subFrame': return 'sub_frame'
    case 'cspReport': return 'csp_report'
    case 'xhr': return 'xmlhttprequest'
    default: return t   // script·image·stylesheet·font·media·object·ping·websocket 등은 그대로
  }
}

/**
 * 설치된 확장들의 정적 룰셋을 모두 읽어 컴파일한다.
 * 확장 설치·제거·활성 변경 뒤에 다시 부르면 된다(전체 재적재 — 개수가 적어 충분히 싸다).
 */
export async function reloadDnrRules(disabledIds?: Set<string>): Promise<number> {
  const root = extensionsRoot()
  const next: CompiledRule[] = []
  let entries: string[] = []
  try { entries = await readdir(root) } catch { rules = []; return 0 }

  for (const entry of entries) {
    if (disabledIds?.has(entry)) continue
    const manifestPath = path.join(root, entry, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    let manifest: { declarative_net_request?: { rule_resources?: Array<{ path?: string; enabled?: boolean }> } }
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) } catch { continue }
    const resources = manifest.declarative_net_request?.rule_resources
    if (!Array.isArray(resources)) continue

    for (const res of resources) {
      if (res?.enabled === false) continue
      const rel = String(res?.path ?? '')
      if (!rel) continue
      const rulePath = path.join(root, entry, rel)
      // 룰 파일이 확장 폴더 밖을 가리키면 무시(경로 이탈 방지 — 임무 20 과 같은 계열).
      if (!path.resolve(rulePath).startsWith(path.resolve(path.join(root, entry)))) continue
      let list: RawRule[]
      try { list = JSON.parse(await readFile(rulePath, 'utf-8')) } catch { continue }
      if (!Array.isArray(list)) continue
      for (const raw of list) {
        const c = compile(entry, raw)
        if (c) next.push(c)
      }
    }
  }

  // 우선순위가 높은 것부터. 같은 우선순위면 allow 계열이 먼저 오게 해 block 을 이긴다.
  staticRules = next
  rebuildMerged()
  return staticRules.length
}

// ===== 동적·세션 룰 (chrome.declarativeNetRequest.updateDynamicRules 등) =====

const DYN_FILE = (): string => path.join(app.getPath('userData'), 'dnr-dynamic.json')

/** 디스크에 저장된 동적 룰을 읽어 온다(부팅 시 1회). */
export async function loadDynamicRules(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(DYN_FILE(), 'utf-8')) as Record<string, RawRule[]>
    for (const [id, list] of Object.entries(raw)) if (Array.isArray(list)) dynamicRaw.set(id, list)
  } catch { /* 없으면 그만 */ }
  recompileRuntime()
}

let saveTimer: NodeJS.Timeout | null = null
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    const obj: Record<string, RawRule[]> = {}
    for (const [id, list] of dynamicRaw) obj[id] = list
    void writeFile(DYN_FILE(), JSON.stringify(obj), 'utf-8').catch(() => undefined)
  }, 300)
}

const MAX_RUNTIME_RULES = 30000

/** 확장이 룰을 추가·제거한다. 크롬과 같은 의미: 먼저 removeRuleIds, 그다음 addRules. */
export function updateRuntimeRules(
  extId: string, scope: 'dynamic' | 'session',
  args: { addRules?: RawRule[]; removeRuleIds?: number[] },
): { ok: boolean; count: number; error?: string } {
  if (!extId) return { ok: false, count: 0, error: '확장 id 없음' }
  const store = scope === 'dynamic' ? dynamicRaw : sessionRaw
  const cur = store.get(extId) ?? []
  const removeSet = new Set((args.removeRuleIds ?? []).map((n) => Number(n)))
  let next = cur.filter((r) => !removeSet.has(Number(r?.id)))
  if (Array.isArray(args.addRules)) {
    // 같은 id 를 다시 넣으면 교체한다(크롬은 중복 id 를 오류로 보지만, 관대한 쪽이 안전하다).
    const addIds = new Set(args.addRules.map((r) => Number(r?.id)))
    next = next.filter((r) => !addIds.has(Number(r?.id)))
    next = next.concat(args.addRules.filter((r) => r && typeof r === 'object'))
  }
  if (next.length > MAX_RUNTIME_RULES) {
    return { ok: false, count: cur.length, error: `룰이 너무 많습니다(최대 ${MAX_RUNTIME_RULES})` }
  }
  store.set(extId, next)
  recompileRuntime()
  if (scope === 'dynamic') scheduleSave()
  return { ok: true, count: next.length }
}

export function getRuntimeRules(extId: string, scope: 'dynamic' | 'session'): RawRule[] {
  return (scope === 'dynamic' ? dynamicRaw : sessionRaw).get(extId) ?? []
}

// ===== Chromium 이 디스크에 쓴 동적 룰을 읽어 온다 =====
//
// 왜 (2026-09-07, 임무 39): 확장이 `chrome.declarativeNetRequest.updateDynamicRules` 를 부르면
// **Electron 이 받아 디스크에 쓴다** — 집행만 하지 않을 뿐이다. 확장 컨텍스트에 preload 를 넣는
// 길이 막혀 있으므로(임무 38), 그 파일을 읽어 우리 엔진에 병합한다.
//
//   <userData>/Partitions/<파티션>/DNR Extension Rules/<확장ID>/rules.json
//
// 한계: `updateSessionRules`(세션 룰)는 Chromium 이 **디스크에 쓰지 않는다** → 여전히 미지원.

const DISK_POLL_MS = 2000
let diskTimer: NodeJS.Timeout | null = null
const diskRaw = new Map<string, RawRule[]>()   // "<파티션>/<확장ID>" -> 룰

function dnrStoreDirs(): string[] {
  const root = path.join(app.getPath('userData'), 'Partitions')
  const out: string[] = []
  try {
    for (const part of readdirSync(root)) {
      const d = path.join(root, part, 'DNR Extension Rules')
      if (existsSync(d)) out.push(d)
    }
  } catch { /* Partitions 가 없으면 그만 */ }
  // 기본 세션은 Partitions 밖에도 둘 수 있다.
  const flat = path.join(app.getPath('userData'), 'DNR Extension Rules')
  if (existsSync(flat)) out.push(flat)
  return out
}

/** 디스크의 동적 룰을 다시 읽는다. 내용이 바뀌었으면 true. */
function syncDiskRules(): boolean {
  const seen = new Set<string>()
  let changed = false
  for (const dir of dnrStoreDirs()) {
    let exts: string[] = []
    try { exts = readdirSync(dir) } catch { continue }
    for (const extId of exts) {
      const file = path.join(dir, extId, 'rules.json')
      if (!existsSync(file)) continue
      const key = `${path.basename(path.dirname(dir))}/${extId}`
      seen.add(key)
      let list: RawRule[] = []
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf-8'))
        if (Array.isArray(parsed)) list = parsed
      } catch { continue }   // 쓰는 도중이면 다음 폴링에서 다시 본다
      const before = JSON.stringify(diskRaw.get(key) ?? [])
      const after = JSON.stringify(list)
      if (before !== after) { diskRaw.set(key, list); changed = true }
    }
  }
  // 사라진 확장의 룰은 버린다
  for (const key of [...diskRaw.keys()]) if (!seen.has(key)) { diskRaw.delete(key); changed = true }

  if (changed) {
    diskCompiled = []
    for (const [key, list] of diskRaw) {
      const extId = key.slice(key.indexOf('/') + 1)
      diskCompiled.push(...compileList(extId, list))
    }
    rebuildMerged()
  }
  return changed
}

/** 디스크 동적 룰 감시 시작 — 파일 이벤트는 놓칠 수 있어 폴링을 안전망으로 둔다. */
export function watchDiskDynamicRules(): void {
  if (diskTimer) return
  syncDiskRules()
  diskTimer = setInterval(() => {
    try {
      if (syncDiskRules()) {
        console.log(`[dnr] 확장 동적 룰 갱신 — 매칭 목록 ${rules.length}개`)
      }
    } catch { /* 폴링 실패는 무시 */ }
  }, DISK_POLL_MS)
  if (typeof diskTimer.unref === 'function') diskTimer.unref()
}

/** 확장이 제거되면 그 확장의 런타임 룰도 함께 버린다. */
export function dropRuntimeRules(extId: string): void {
  dynamicRaw.delete(extId)
  sessionRaw.delete(extId)
  recompileRuntime()
  scheduleSave()
}

export interface DnrDetails {
  url: string
  resourceType?: string
  webContentsId?: number
  // Electron 의 OnBeforeRequestListenerDetails 를 그대로 받을 수 있게 null 도 허용한다.
  frame?: { url?: string } | null
  referrer?: string
}

export type DnrDecision = { cancel: true } | { redirectURL: string } | null

/**
 * 이 요청에 적용할 확장 룰의 결론. 아무 룰도 안 맞으면 null(그대로 통과).
 * **순수 함수** — 리스너를 걸지 않는다(세션당 리스너 1개 제약).
 */
export function dnrDecide(details: DnrDetails): DnrDecision {
  if (!rules.length) return null
  const url = details.url
  if (!url || url.startsWith('devtools:') || url.startsWith('chrome-extension:')) return null

  const rt = toDnrResourceType(String(details.resourceType ?? ''))
  const initiator = hostOf(details.frame?.url ?? details.referrer ?? '')
  const reqHost = hostOf(url)

  for (const r of rules) {
    if (r.resourceTypes && rt && !r.resourceTypes.has(rt)) continue
    if (r.excludedResourceTypes && rt && r.excludedResourceTypes.has(rt)) continue
    if (r.requestDomains && !domainMatches(reqHost, r.requestDomains)) continue
    if (r.excludedRequestDomains && domainMatches(reqHost, r.excludedRequestDomains)) continue
    // ⚠ initiatorDomains 가 지정된 룰은 **발신 도메인을 알 수 없으면 적용하지 않는다**(크롬과 같다).
    //   예전에는 initiator 가 비면 검사를 건너뛰어, 발신 도메인으로만 좁힌 룰 823개가
    //   **모든 요청에 적용**됐다 — uBO Lite 를 켜면 네이버·구글·위키백과까지 막혔다(임무 40 실측).
    if (r.initiatorDomains && (!initiator || !domainMatches(initiator, r.initiatorDomains))) continue
    if (r.excludedInitiatorDomains && initiator && domainMatches(initiator, r.excludedInitiatorDomains)) continue
    // domainType 도 발신을 알아야 판정할 수 있다 — 모르면 적용하지 않는다.
    if (r.domainType) {
      if (!initiator) continue
      const first = sameSite(initiator, reqHost)
      if (r.domainType === 'firstParty' && !first) continue
      if (r.domainType === 'thirdParty' && first) continue
    }
    if (!r.test(url)) continue

    // 정렬 덕분에 먼저 맞는 것이 곧 최우선 룰이다.
    switch (r.action) {
      case 'allow':
      case 'allowAllRequests':
        return null                       // 통과시킨다(뒤의 block 룰을 보지 않는다)
      case 'block':
        return { cancel: true }
      case 'upgradeScheme':
        return url.startsWith('http://') ? { redirectURL: 'https://' + url.slice(7) } : null
      case 'redirect': {
        if (r.redirectUrl) return { redirectURL: r.redirectUrl }
        if (r.redirectExtensionPath) {
          const p = r.redirectExtensionPath.startsWith('/') ? r.redirectExtensionPath : '/' + r.redirectExtensionPath
          return { redirectURL: `chrome-extension://${r.extId}${p}` }
        }
        return null
      }
      case 'modifyHeaders':
        // 헤더만 바꾸는 룰은 요청을 막지 않는다 — 아래 헤더 함수가 따로 적용한다.
        continue
      default:
        return null
    }
  }
  return null
}

// ===== modifyHeaders =====
// 크롬 DNR 의 헤더 변형(set·remove·append). 요청 헤더는 onBeforeSendHeaders,
// 응답 헤더는 onHeadersReceived 에서 적용한다 — 둘 다 세션당 리스너가 하나뿐이라
// 기존 소유자(policy·adblock)가 이 함수를 호출하는 팬아웃 구조를 쓴다.

function matchesRule(r: CompiledRule, details: DnrDetails): boolean {
  const rt = toDnrResourceType(String(details.resourceType ?? ''))
  const initiator = hostOf(details.frame?.url ?? details.referrer ?? '')
  const reqHost = hostOf(details.url)
  if (r.resourceTypes && rt && !r.resourceTypes.has(rt)) return false
  if (r.excludedResourceTypes && rt && r.excludedResourceTypes.has(rt)) return false
  if (r.requestDomains && !domainMatches(reqHost, r.requestDomains)) return false
  if (r.excludedRequestDomains && domainMatches(reqHost, r.excludedRequestDomains)) return false
  if (r.initiatorDomains && (!initiator || !domainMatches(initiator, r.initiatorDomains))) return false
  if (r.excludedInitiatorDomains && initiator && domainMatches(initiator, r.excludedInitiatorDomains)) return false
  if (r.domainType) {
    if (!initiator) return false
    const first = sameSite(initiator, reqHost)
    if (r.domainType === 'firstParty' && !first) return false
    if (r.domainType === 'thirdParty' && first) return false
  }
  return r.test(details.url)
}

// 요청 헤더는 문자열만, 응답 헤더는 배열도 가능 — Electron 의 실제 타입에 맞춘다.
type ReqHeaders = Record<string, string>
type ResHeaders = Record<string, string | string[]>

/** 헤더 이름은 대소문자를 가리지 않는다 — 실제 키를 찾아 준다. */
function findKey(headers: Record<string, unknown>, name: string): string | undefined {
  const lower = name.toLowerCase()
  return Object.keys(headers).find((k) => k.toLowerCase() === lower)
}

function applyOps<T extends Record<string, string | string[]>>(headers: T, ops: HeaderOp[]): T {
  const out = { ...headers } as Record<string, string | string[]>
  for (const op of ops) {
    const name = String(op?.header ?? '').trim()
    if (!name) continue
    const key = findKey(out, name)
    switch (String(op?.operation ?? '')) {
      case 'remove':
        if (key) delete out[key]
        break
      case 'set':
        if (key) delete out[key]
        out[name] = String(op.value ?? '')
        break
      case 'append': {
        const v = String(op.value ?? '')
        if (key) {
          const cur = out[key]
          out[key] = Array.isArray(cur) ? [...cur, v] : [String(cur), v]
        } else out[name] = v
        break
      }
      default: break
    }
  }
  return out as T
}

/** 확장 룰에 따른 **요청** 헤더 변형. 바뀐 게 없으면 원본을 그대로 돌려준다. */
export function dnrRequestHeaders(details: DnrDetails, headers: ReqHeaders | undefined): ReqHeaders | undefined {
  if (!headers || !rules.length) return headers
  let out = headers
  let touched = false
  for (const r of rules) {
    if (r.action !== 'modifyHeaders' || !r.requestHeaders) continue
    if (!matchesRule(r, details)) continue
    out = applyOps(out, r.requestHeaders)
    touched = true
  }
  return touched ? out : headers
}

/** 확장 룰에 따른 **응답** 헤더 변형. */
export function dnrResponseHeaders(details: DnrDetails, headers: ResHeaders | undefined): ResHeaders | undefined {
  if (!headers || !rules.length) return headers
  let out = headers
  let touched = false
  for (const r of rules) {
    if (r.action !== 'modifyHeaders' || !r.responseHeaders) continue
    if (!matchesRule(r, details)) continue
    out = applyOps(out, r.responseHeaders)
    touched = true
  }
  return touched ? out : headers
}
