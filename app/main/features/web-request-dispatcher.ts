// web-request-dispatcher.ts — 세션당 webRequest 리스너(onBeforeRequest / onBeforeSendHeaders /
// onHeadersReceived) 는 하나만 유효하다(회귀 #5 계열). 예전엔 이 세 이벤트를 policy·adblock 이
// 각자 따로 등록해 "누가 마지막에 등록했는지"에 동작이 좌우됐고, 특히 onBeforeRequest 는
// adblock 초기화(부팅 1.5초 지연) 전엔 **아무도 등록하지 않아** 그 사이 확장 declarativeNetRequest
// 차단이 통째로 빠지는 구멍이 있었다.
//
// 이 모듈이 세 이벤트의 **유일한 소유자**다. session-bootstrap.setupSession() 이 부팅 즉시(다른
// 모듈의 지연 초기화를 기다리지 않고) 모든 세션에 설치한다. adblock 은 자신의 판정 로직을
// setAdblockProviders() 로 등록만 하고, 실제 리스너는 걸지 않는다.
//
// 순서:
//   onBeforeRequest      = 동영상 URL 리라이트 → 확장 DNR → adblock(등록돼 있으면)
//   onBeforeSendHeaders  = 확장 DNR → 클라이언트 힌트 → 3자 쿠키 차단 → 사용자 정책(최종)
//   onHeadersReceived    = 확장 DNR → 3자 쿠키 차단 → 사용자 정책(최종) → adblock 필요 처리

import type {
  CallbackResponse, HeadersReceivedResponse, OnBeforeRequestListenerDetails,
  OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails, Session, WebFrameMain,
} from 'electron'
import { dnrDecide, dnrRequestHeaders, dnrResponseHeaders } from './extensions/dnr'
import { applyClientHints } from './client-hints'
import { applyToRequestHeaders, applyToResponseHeaders } from './policy'
import { getSetting } from '../storage/settings'

// ===== adblock 판정 제공자 — adblock 모듈이 등록(리스너는 걸지 않는다) =====

type RequestProvider = (
  details: OnBeforeRequestListenerDetails,
  callback: (response: CallbackResponse) => void,
) => void

type HeadersProvider = (
  details: OnHeadersReceivedListenerDetails,
  callback: (response: HeadersReceivedResponse) => void,
) => void

let adblockRequestProvider: RequestProvider | null = null
let adblockHeadersProvider: HeadersProvider | null = null

/** adblock 모듈이 자신의 판정 함수를 등록한다. null 을 넘기면 해제(꺼짐/전체 끄기). */
export function setAdblockProviders(request: RequestProvider | null, headers: HeadersProvider | null): void {
  adblockRequestProvider = request
  adblockHeadersProvider = headers
}

// ===== 동영상 URL 리라이트 (sogirl 등 Bunny Stream embed 서브도메인 404 unbreak) =====

function videoUrlRewrite(url: string): string | null {
  if (url.indexOf('player.mediadelivery.net/embed/') !== -1) {
    return url.replace('//player.mediadelivery.net/', '//iframe.mediadelivery.net/')
  }
  return null
}

// ===== 서드파티 쿠키 차단 =====
// eTLD+1 근사 — 2단계 ccTLD(co.kr 등)는 알려진 접미사 목록으로 보정, 그 외는 마지막 2 라벨.

const TWO_LEVEL_SUFFIXES = new Set([
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr', 'pe.kr', 're.kr', 'hs.kr', 'ms.kr', 'es.kr',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ad.jp',
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'net.uk', 'sch.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.au', 'net.au', 'org.au', 'gov.au', 'edu.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'co.in', 'net.in', 'org.in', 'gov.in', 'firm.in',
  'co.id', 'net.id', 'or.id', 'web.id',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.tw', 'net.tw', 'org.tw', 'idv.tw',
  'com.hk', 'net.hk', 'org.hk', 'co.hk', 'gov.hk',
  'com.sg', 'net.sg', 'org.sg', 'gov.sg', 'edu.sg',
  'com.mx', 'com.ar', 'com.tr', 'com.vn',
])

function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '')
  const labels = h.split('.')
  if (labels.length <= 2) return h
  const lastTwo = labels.slice(-2).join('.')
  if (labels.length >= 3 && TWO_LEVEL_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join('.')
  }
  return lastTwo
}

/** 요청이 걸린 프레임의 "최상위 문서" URL을 최대한 근사해서 구한다. */
function documentUrlOf(details: {
  frame?: WebFrameMain | null
  referrer?: string
  url: string
}): string {
  const frame = details.frame
  if (frame) {
    try {
      if (!frame.isDestroyed()) {
        const top = frame.top
        if (top && !top.isDestroyed() && top.url) return top.url
        if (frame.url) return frame.url
      }
    } catch { /* frame 이 파괴 중일 수 있음 — 무시하고 폴백 */ }
  }
  return details.referrer || details.url
}

function isThirdPartyRequest(requestUrl: string, documentUrl: string): boolean {
  if (!documentUrl) return false
  try {
    const reqHost = new URL(requestUrl).hostname
    const docHost = new URL(documentUrl).hostname
    if (!reqHost || !docHost) return false
    return registrableDomain(reqHost) !== registrableDomain(docHost)
  } catch { return false }
}

function thirdPartyCookiesBlocked(): boolean {
  try { return getSetting('privacy').blockThirdPartyCookies === true } catch { return false }
}

function removeHeaderCI<T extends Record<string, unknown>>(headers: T, name: string): T {
  const lower = name.toLowerCase()
  let touched = false
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) { touched = true; continue }
    out[k] = v
  }
  return touched ? (out as T) : headers
}

function stripThirdPartyRequestCookie(
  details: OnBeforeSendHeadersListenerDetails, headers: Record<string, string>,
): Record<string, string> {
  if (details.resourceType === 'mainFrame') return headers
  if (!thirdPartyCookiesBlocked()) return headers
  const docUrl = documentUrlOf(details)
  if (!isThirdPartyRequest(details.url, docUrl)) return headers
  return removeHeaderCI(headers, 'Cookie')
}

function stripThirdPartyResponseCookie(
  details: OnHeadersReceivedListenerDetails, headers: Record<string, string | string[]> | undefined,
): Record<string, string | string[]> | undefined {
  if (!headers) return headers
  if (details.resourceType === 'mainFrame') return headers
  if (!thirdPartyCookiesBlocked()) return headers
  const docUrl = documentUrlOf(details)
  if (!isThirdPartyRequest(details.url, docUrl)) return headers
  return removeHeaderCI(headers, 'Set-Cookie')
}

// ===== 세션에 설치 =====

const installed = new WeakSet<Session>()

/**
 * 부팅 시 세션마다 한 번만 호출된다(session-bootstrap.setupSession 이 idempotent 하게 보장).
 * @ghostery 의 `enableBlockingInSession()` 처럼 **다른 라이브러리가 나중에 같은 세션에
 * onBeforeRequest/onHeadersReceived 를 직접 등록**하면 그 순간부터 이 디스패처의 리스너는
 * 조용히 덮어써진다(세션당 리스너 1개 제약). 그런 경우엔 `reclaimWebRequestDispatcher(ses)` 로
 * 소유권을 되찾아야 한다(adblock 모듈이 enableBlockingInSession 직후 호출).
 */
export function installWebRequestDispatcher(ses: Session): void {
  if (installed.has(ses)) return
  installed.add(ses)
  attachListeners(ses)
}

/** 다른 모듈이 같은 세션에 webRequest 리스너를 다시 걸었을 때 소유권을 되찾는다(가드 없이 재등록). */
export function reclaimWebRequestDispatcher(ses: Session): void {
  attachListeners(ses)
}

function attachListeners(ses: Session): void {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const rewrite = videoUrlRewrite(details.url)
    if (rewrite) { callback({ redirectURL: rewrite }); return }

    // 확장 declarativeNetRequest — 부팅 즉시(adblock 초기화를 기다리지 않고) 걸린다.
    const dnr = dnrDecide(details)
    if (dnr) { callback(dnr); return }

    if (adblockRequestProvider) { adblockRequestProvider(details, callback); return }
    callback({})
  })

  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    try {
      let headers = dnrRequestHeaders(details, details.requestHeaders) ?? details.requestHeaders
      headers = applyClientHints(details.url, headers)
      headers = stripThirdPartyRequestCookie(details, headers)
      headers = applyToRequestHeaders(details.url, headers) as Record<string, string>
      callback({ cancel: false, requestHeaders: headers })
    } catch (err) {
      console.warn('[web-request] onBeforeSendHeaders error', err)
      callback({ cancel: false, requestHeaders: details.requestHeaders })
    }
  })

  ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
    let headers: Record<string, string | string[]> | undefined
    try {
      headers = dnrResponseHeaders(details, details.responseHeaders) ?? details.responseHeaders
      headers = stripThirdPartyResponseCookie(details, headers)
      headers = applyToResponseHeaders(details.url, headers)
    } catch (err) {
      console.warn('[web-request] onHeadersReceived error', err)
      callback({ cancel: false, responseHeaders: details.responseHeaders })
      return
    }
    if (adblockHeadersProvider) {
      // adblock(ghostery) 은 response.responseHeaders 를 문자열 배열로만 기대하지만, 정책 룰의
      // 헤더 set 은 단일 문자열일 수 있다(둘 다 실제 Electron API 가 허용하는 형태) — 여기서만 캐스팅.
      const detailsForAdblock = { ...details, responseHeaders: headers } as OnHeadersReceivedListenerDetails
      adblockHeadersProvider(detailsForAdblock, (response) => {
        if (response.cancel === true) { callback(response); return }
        callback({ cancel: false, responseHeaders: response.responseHeaders ?? headers })
      })
      return
    }
    callback({ cancel: false, responseHeaders: headers })
  })
}
