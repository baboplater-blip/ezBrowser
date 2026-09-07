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

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

type ActionType = 'block' | 'allow' | 'redirect' | 'upgradeScheme' | 'allowAllRequests' | 'modifyHeaders'

interface RawRule {
  id?: number
  priority?: number
  action?: { type?: string; redirect?: { url?: string; extensionPath?: string } }
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
  }
}

interface CompiledRule {
  extId: string
  id: number
  priority: number
  action: ActionType
  redirectUrl?: string
  redirectExtensionPath?: string
  test: (url: string) => boolean
  resourceTypes?: Set<string>
  excludedResourceTypes?: Set<string>
  initiatorDomains?: string[]
  excludedInitiatorDomains?: string[]
  requestDomains?: string[]
  excludedRequestDomains?: string[]
}

let rules: CompiledRule[] = []

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
  // 아직 지원하지 않는 액션은 조용히 건너뛴다(있는 척하지 않는다).
  if (type === 'modifyHeaders') return null

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
    test,
    resourceTypes: Array.isArray(c.resourceTypes) ? new Set(c.resourceTypes) : undefined,
    excludedResourceTypes: Array.isArray(c.excludedResourceTypes) ? new Set(c.excludedResourceTypes) : undefined,
    initiatorDomains: c.initiatorDomains ?? c.domains,
    excludedInitiatorDomains: c.excludedInitiatorDomains ?? c.excludedDomains,
    requestDomains: c.requestDomains,
    excludedRequestDomains: c.excludedRequestDomains,
  }
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
  const rank = (a: CompiledRule): number => (a.action === 'allow' || a.action === 'allowAllRequests' ? 0 : 1)
  next.sort((a, b) => (b.priority - a.priority) || (rank(a) - rank(b)))
  rules = next
  return rules.length
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
    if (r.initiatorDomains && initiator && !domainMatches(initiator, r.initiatorDomains)) continue
    if (r.excludedInitiatorDomains && initiator && domainMatches(initiator, r.excludedInitiatorDomains)) continue
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
      default:
        return null
    }
  }
  return null
}
