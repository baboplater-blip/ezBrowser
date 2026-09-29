import { app, type WebContents } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// User-Agent 클라이언트 힌트(Sec-CH-UA) 보강.
//
// 실측(build/probe-fingerprint-cdp.mjs): Electron 은 http 는 물론 **HTTPS(보안 컨텍스트)에서도**
// Sec-CH-UA / Sec-CH-UA-Mobile / Sec-CH-UA-Platform 를 아예 보내지 않는다. 실제 Chrome 은 항상 보낸다.
// "Chrome UA 를 쓰면서 클라이언트 힌트는 없는" 조합은 그 자체로 일반 브라우저가 아니라는 신호가 된다.
//
// 중요한 설계 결정: 헤더 값을 임의로 지어내지 않고 **이 브라우저의 실제 navigator.userAgentData.brands
// 를 읽어 그대로** 헤더로 만든다. "Google Chrome" 을 헤더에만 넣으면 JS 값과 어긋나서, 없느니만 못한
// 더 강한 신호(내부 불일치)가 되기 때문이다. JS 와 헤더가 항상 같은 값을 말하게 한다.
// 브랜드를 아직 못 읽었으면 아무 헤더도 넣지 않는다(기존 동작 유지 — 잘못된 값을 보내는 것보다 낫다).

interface Brand { brand: string; version: string }

let brands: Brand[] | null = null
let capturing = false
let cacheLoaded = false

// 브랜드는 렌더러에서만 읽을 수 있어(외피 로드 후) "아주 첫 요청" 에는 아직 없을 수 있다.
// 그러면 같은 사이트인데 첫 요청만 힌트가 빠지는 어색한 패턴이 생긴다.
// → 한 번 읽으면 디스크에 캐시해 두고, 다음 실행부터는 첫 요청 전에 즉시 쓴다.
// Chromium 버전을 키로 저장하므로 Electron 업그레이드 시 자동으로 다시 읽는다(낡은 값 사용 방지).
function cacheFile(): string {
  return path.join(app.getPath('userData'), 'client-hints.json')
}

function loadCache(): void {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const f = cacheFile()
    if (!existsSync(f)) return
    const raw = JSON.parse(readFileSync(f, 'utf8')) as { chromium?: string; brands?: Brand[] }
    if (raw?.chromium !== process.versions.chrome) return // 버전이 바뀌었으면 무시하고 다시 읽는다
    if (Array.isArray(raw.brands) && raw.brands.length) {
      brands = raw.brands.filter((b) => b && typeof b.brand === 'string' && typeof b.version === 'string')
    }
  } catch { /* 캐시가 깨졌으면 무시 — 렌더러에서 다시 읽는다 */ }
}

function saveCache(list: Brand[]): void {
  try { writeFileSync(cacheFile(), JSON.stringify({ chromium: process.versions.chrome, brands: list }), 'utf8') }
  catch { /* 저장 실패는 무해 — 다음 실행에서 다시 읽는다 */ }
}

function platformLabel(): string {
  switch (process.platform) {
    case 'darwin': return 'macOS'
    case 'win32': return 'Windows'
    case 'linux': return 'Linux'
    default: return 'Unknown'
  }
}

// 브랜드 목록을 실제 렌더러에서 한 번 읽어 캐시한다(외피 렌더러도 같은 값을 가진다).
export async function captureBrands(wc: WebContents): Promise<boolean> {
  loadCache()
  if (brands || capturing) return !!brands
  capturing = true
  try {
    const raw = await wc.executeJavaScript(
      '(function(){try{return navigator.userAgentData?JSON.stringify(navigator.userAgentData.brands):""}catch(e){return ""}})()',
      true,
    ) as string
    const parsed = raw ? JSON.parse(raw) as Brand[] : []
    if (Array.isArray(parsed) && parsed.length) {
      brands = parsed.filter((b) => b && typeof b.brand === 'string' && typeof b.version === 'string')
      if (brands.length) saveCache(brands)
    }
  } catch { /* 못 읽으면 헤더를 넣지 않는다 */ }
  finally { capturing = false }
  return !!brands
}

export function hasBrands(): boolean { return !!brands }

// `"Not:A-Brand";v="24", "Chromium";v="134"` 형식(구조화 헤더 목록).
function secChUaValue(): string | null {
  if (!brands || !brands.length) return null
  return brands.map((b) => `"${b.brand.replace(/"/g, '')}";v="${b.version.replace(/"/g, '')}"`).join(', ')
}

// 클라이언트 힌트는 보안 컨텍스트에만 보낸다 — 평문 http 사이트에 보내면 그것대로 비정상 신호다.
function isSecureContextUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:' || u.protocol === 'wss:') return true
    if (u.protocol === 'http:') {
      const h = u.hostname
      return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')
    }
    return false
  } catch { return false }
}

const hasHeader = (headers: Record<string, string>, name: string): boolean =>
  Object.keys(headers).some((k) => k.toLowerCase() === name)

// 요청 헤더에 Sec-CH-UA 3종을 채운다. 이미 있으면(사용자 정책 룰 등) 건드리지 않는다.
export function applyClientHints(url: string, headers: Record<string, string>): Record<string, string> {
  loadCache() // 지난 실행에서 캐시해 둔 값이 있으면 첫 요청부터 바로 쓴다
  const value = secChUaValue()
  if (!value || !isSecureContextUrl(url)) return headers
  const next = { ...headers }
  if (!hasHeader(next, 'sec-ch-ua')) next['Sec-CH-UA'] = value
  if (!hasHeader(next, 'sec-ch-ua-mobile')) next['Sec-CH-UA-Mobile'] = '?0'
  if (!hasHeader(next, 'sec-ch-ua-platform')) next['Sec-CH-UA-Platform'] = `"${platformLabel()}"`
  return next
}

// ===== Accept-Language 에 대해 (조사 결과 — 손대지 않기로 한 이유) =====
// 우리 기본값은 헤더 "ko" + navigator.languages ["ko"] 이고, 실제 Chrome 은
// "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7" + ["ko-KR","ko","en-US","en"] 이다.
// Chrome 처럼 바꾸려 두 가지를 실측했는데 둘 다 **헤더만 바뀌고 navigator.languages 는 그대로**였다:
//   ① session.setUserAgent(ua, acceptLanguages)  ② Chromium --accept-lang 스위치
// 헤더만 바꾸면 "헤더는 4개 언어, JS 는 1개" 라는 내부 불일치가 생기는데, 이는 원래의 "언어 하나로
// 설정한 사용자"(충분히 있을 수 있는 상태)보다 훨씬 강한 자동화 신호다. 그래서 되돌렸다.
// 고치려면 navigator.languages 까지 함께 바꿀 수단이 필요하다(메인 월드 주입은 그 자체가 탐지 표면이라 보류).
// 참고: setUserAgent 의 acceptLanguages 인자는 q 값을 스스로 붙인다(직접 q 를 넣으면 ";q=0.9;q=0.9" 로 이중).
