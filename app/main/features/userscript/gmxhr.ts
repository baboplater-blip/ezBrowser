// GM_xmlhttpRequest / GM.xmlHttpRequest 백엔드. 메인 프로세스가 net.request 로 대행하므로
// CORS 와 무관하고(item 3), @connect 화이트리스트가 없으면 요청을 만든 페이지의 origin 으로만
// 좁힌다(item 3: "없으면 같은 origin 만 + 사용자 경고"). 사설망 차단 + 응답 크기 상한.

import { net } from 'electron'
import { isPrivateHostResolved } from './net-guard'

const RESPONSE_MAX_BYTES = 20 * 1024 * 1024 // 20MB
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])
// 요청 위조·세션 하이재킹 경로가 될 수 있는 헤더는 사용자 스크립트가 직접 못 넣게 막는다.
const FORBIDDEN_REQ_HEADERS = new Set(['cookie', 'host', 'content-length', 'connection'])

export interface GmXhrDetails {
  url?: string
  method?: string
  headers?: Record<string, string>
  data?: string
  timeout?: number
}

export interface GmXhrResponse {
  ok: boolean
  status: number
  statusText: string
  responseText: string
  responseHeaders: string
  finalUrl: string
  error?: string
  warning?: string
}

/**
 * @param connect  스크립트의 @connect 목록(빈 배열이면 origin 제약 적용)
 * @param pageOrigin 요청을 촉발한 프레임의 origin(스킴+호스트+포트) — @connect 없을 때 유일한 허용처
 */
export async function performGmXhr(
  details: GmXhrDetails,
  connect: readonly string[],
  pageOrigin: string,
): Promise<GmXhrResponse> {
  const fail = (status: number, error: string): GmXhrResponse =>
    ({ ok: false, status, statusText: error, responseText: '', responseHeaders: '', finalUrl: '', error })

  const rawUrl = typeof details.url === 'string' ? details.url : ''
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return fail(0, '잘못된 URL 입니다')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return fail(0, 'http(s) URL 만 허용됩니다')
  }

  let sameOrigin = false
  try { sameOrigin = new URL(pageOrigin).origin === parsed.origin } catch { /* pageOrigin 파싱 실패 시 sameOrigin=false 유지 */ }

  let warning: string | undefined
  const connectLower = connect.map((h) => h.toLowerCase().trim()).filter(Boolean)
  if (!sameOrigin) {
    if (connectLower.length > 0) {
      const host = parsed.hostname.toLowerCase()
      const allowed = connectLower.some((c) => host === c || host.endsWith(`.${c}`) || c === '*')
      if (!allowed) {
        return fail(0, `@connect 에 없는 호스트입니다: ${parsed.hostname} (메타데이터에 // @connect ${parsed.hostname} 추가)`)
      }
    } else {
      // @connect 선언이 없으면 요청을 만든 페이지와 같은 origin 으로만 좁힌다.
      return fail(0, `@connect 선언이 없어 같은 사이트(${pageOrigin})로만 요청할 수 있습니다`)
    }
  } else if (connectLower.length === 0) {
    warning = '@connect 를 선언하지 않아 같은 사이트로만 요청이 허용됩니다. 다른 도메인이 필요하면 // @connect <host> 를 추가하세요.'
  }

  // 사설망/로컬 차단은 **교차 출처**(다른 host 로 @connect 를 통해 여는) 목적지에만 적용한다.
  // 같은 origin(스크립트가 이미 매치돼 실행 중인 바로 그 페이지)으로의 요청은 새 권한이 아니다 —
  // 그 페이지가 인트라넷 안에 있다면 스크립트도 이미 그 인트라넷 페이지 위에서 돌고 있으므로
  // 막을 이유가 없다(사내 인트라넷 자동화 스크립트의 정상 사용 사례를 막지 않기 위한 설계).
  if (!sameOrigin && await isPrivateHostResolved(parsed.hostname)) {
    return fail(0, '사설망·로컬 주소는 허용되지 않습니다(@connect 로 여는 교차 출처 목적지에만 적용)')
  }

  const method = (typeof details.method === 'string' ? details.method.toUpperCase() : 'GET')
  if (!ALLOWED_METHODS.has(method)) {
    return fail(0, `허용되지 않는 메서드입니다: ${method}`)
  }
  const timeout = Math.min(
    Math.max(typeof details.timeout === 'number' && details.timeout > 0 ? details.timeout : DEFAULT_TIMEOUT_MS, 1000),
    MAX_TIMEOUT_MS,
  )

  return new Promise((resolve) => {
    let settled = false
    const finish = (r: GmXhrResponse): void => { if (!settled) { settled = true; resolve(warning ? { ...r, warning } : r) } }
    try {
      // GM_xmlhttpRequest 는 페이지 세션 쿠키를 공유하지 않는 것이 통상 동작(사이트 간 CSRF 토큰
      // 탈취 등의 남용을 줄이는 방향) — 필요하면 스크립트가 직접 credentials 헤더를 실어야 한다.
      const req = net.request({ url: rawUrl, method, useSessionCookies: false })
      if (details.headers && typeof details.headers === 'object') {
        for (const [k, v] of Object.entries(details.headers)) {
          if (typeof v !== 'string') continue
          if (FORBIDDEN_REQ_HEADERS.has(k.toLowerCase())) continue
          try { req.setHeader(k, v) } catch { /* 잘못된 헤더 이름은 조용히 무시 */ }
        }
      }
      const chunks: Buffer[] = []
      let total = 0
      const timer = setTimeout(() => {
        try { req.abort() } catch { /* ignore */ }
        finish(fail(0, '시간 초과'))
      }, timeout)
      req.on('response', (resp) => {
        const headerLines: string[] = []
        for (const [k, v] of Object.entries(resp.headers)) {
          const vals = Array.isArray(v) ? v : [v]
          for (const val of vals) headerLines.push(`${k}: ${val}`)
        }
        resp.on('data', (c: Buffer) => {
          total += c.length
          if (total > RESPONSE_MAX_BYTES) {
            clearTimeout(timer)
            try { req.abort() } catch { /* ignore */ }
            finish(fail(0, `응답 크기 상한 초과(최대 ${Math.floor(RESPONSE_MAX_BYTES / 1024 / 1024)}MB)`))
            return
          }
          chunks.push(c)
        })
        resp.on('end', () => {
          clearTimeout(timer)
          finish({
            ok: resp.statusCode < 400,
            status: resp.statusCode,
            statusText: String(resp.statusCode),
            responseText: Buffer.concat(chunks).toString('utf-8'),
            responseHeaders: headerLines.join('\r\n'),
            finalUrl: rawUrl,
          })
        })
      })
      req.on('error', (err) => { clearTimeout(timer); finish(fail(0, err.message)) })
      if (typeof details.data === 'string' && method !== 'GET' && method !== 'HEAD') {
        req.write(details.data)
      }
      req.end()
    } catch (err) {
      finish(fail(0, err instanceof Error ? err.message : String(err)))
    }
  })
}
