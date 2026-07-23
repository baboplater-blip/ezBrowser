import { app, session, type Session } from 'electron'
import { promises as fs, existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { AdblockRecentBlock, AdblockStats } from '../../../shared/types'
import { getSetting, setNestedSetting } from '../../storage/settings'
import { addSessionInitHook, forEachInstalledSession } from '../../session-bootstrap'
import { applyToResponseHeaders } from '../policy'
import { nudgeGc } from '../gc-nudge'

// @ghostery 코스메틱/scriptlet 주입용 content preload 경로. enableBlockingInSession 이 첫 세션에
// 전역 ipc 핸들러를 등록하면(blocker 단위라 1회로 충분), 나머지 세션엔 이 preload 만 등록하면
// 동일하게 코스메틱·scriptlet 이 동작한다 → anti-adblock 오버레이 숨김/스크롤 복원이 모든 탭 세션에서.
const COSMETIC_PRELOAD_PATH: string | null = (() => {
  try { return createRequire(__filename).resolve('@ghostery/adblocker-electron-preload') } catch { return null }
})()

// registerPreloadScript / unregisterPreloadScript 는 Electron 35+ Session API
type PreloadSession = Session & {
  registerPreloadScript: (opts: { type: 'frame'; filePath: string }) => string
  unregisterPreloadScript: (id: string) => void
}

type Level = 'lite' | 'standard' | 'strict' | 'custom'
type FilterId = 'easylist' | 'easyprivacy' | 'kr' | 'antiAdblock' | 'fanboyAnnoyance' | 'fanboySocial'

interface BlockerInstance {
  enableBlockingInSession(session: Electron.Session): unknown
  disableBlockingInSession(session: Electron.Session): void
  updateResources(data: string, checksum: string): boolean
  updateFromDiff(diff: { added?: string[]; removed?: string[] }): unknown
  onBeforeRequest: (
    details: Electron.OnBeforeRequestListenerDetails,
    cb: (response: Electron.CallbackResponse) => void,
  ) => void
  onHeadersReceived: (
    details: Electron.OnHeadersReceivedListenerDetails,
    cb: (response: Electron.HeadersReceivedResponse) => void,
  ) => void
}

let blocker: BlockerInstance | null = null
const stats: AdblockStats = { totalBlocked: 0, perHost: {} }
const recent: AdblockRecentBlock[] = []
const RECENT_LIMIT = 200

export const adblockEvents = new EventEmitter()

const FILTER_URL: Record<FilterId, string> = {
  easylist: 'https://easylist-downloads.adblockplus.org/easylist.txt',
  easyprivacy: 'https://easylist-downloads.adblockplus.org/easyprivacy.txt',
  kr: 'https://raw.githubusercontent.com/List-KR/List-KR/master/filter.txt',
  // anti-circumvention — "광고 차단기를 꺼주세요" 식 anti-adblock 탐지/우회 차단 (ABP 공식)
  antiAdblock: 'https://easylist-downloads.adblockplus.org/abp-filters-anti-cv.txt',
  fanboyAnnoyance: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
  fanboySocial: 'https://secure.fanboy.co.nz/fanboy-social.txt',
}

const LEVEL_FILTERS: Record<Exclude<Level, 'custom'>, FilterId[]> = {
  lite: ['easylist', 'antiAdblock'],
  standard: ['easylist', 'easyprivacy', 'kr', 'antiAdblock'],
  strict: ['easylist', 'easyprivacy', 'kr', 'antiAdblock', 'fanboyAnnoyance', 'fanboySocial'],
}

function enginePath(): string {
  return path.join(app.getPath('userData'), 'adblock', 'engine.bin')
}

// engine.bin 캐시가 아직 없는 "콜드 빌드"(설치 후 첫 실행 등)는 fromLists() 가 필터 리스트 원문을
// 네트워크에서 받아 직접 파싱하는데, 이 파싱 과정의 스크래치 메모리(원문 텍스트·중간 파싱 배열)를
// V8 이 GC 이후에도 즉시 OS 에 반환하지 않는 경우가 있어(프로세스 수명 내내 힙을 보유하는 V8 특성)
// 콜드 빌드 직후 메인 프로세스 private working set 이 캐시 재사용(warm deserialize) 대비 눈에 띄게
// 높게 남을 수 있다(실측: 콜드 ≈231MB → GC 넛지 후 ≈206MB, 웜 ≈166MB, 8초 안정화 시점 기준).
// 캐시가 이미 있으면(2번째 이후 실행 — 실사용의 절대다수) fromLists 가 바로 역직렬화만 하므로 이
// 스파이크 자체가 없다. 필터 내용·차단 동작은 완전히 동일 — GC 를 한 번 더 돌려 파싱 스크래치를
// 최대한 회수하는 것 뿐이라 "필터를 줄이는" 개선이 아니다.

function resourcesCachePath(): string {
  return path.join(app.getPath('userData'), 'adblock', 'resources.json')
}

// uBO scriptlet/redirect 리소스 — `+js()` (anti-adblock 우회 등) 규칙 동작에 필요.
// @ghostery 가 프리빌트 엔진에 쓰는 동일 소스.
const UBO_RESOURCES_URL =
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json'

// 참고: 광고 스크립트를 surrogate 로 "리디렉트"하는 방법(redirect=)은 Chromium 이 http→data: 리디렉트를
// ERR_UNSAFE_REDIRECT 로 막아 이 Electron 에선 동작하지 않는다. 대신 콘텐츠 preload(external-features)
// 가 페이지 main world 에 window.adsbygoogle 스텁을 직접 주입해 "광고 미로드" 탐지를 우회한다.

// 사이트 자체(first-party) 스크립트가 필터에 오탐 차단되어 영상 로더 등이 깨지는 것을 막는 예외 규칙.
// 광고 스크립트는 대부분 다른 도메인(third-party)이라 영향받지 않는다.
const SITE_SCRIPT_ALLOW: string[] = [
  '@@||sogirl.so^$script',
  // 영상 플레이어·CDN(Bunny Stream 등)은 광고가 아니므로 어떤 것도 차단하지 않는다 — 재생 깨짐 방지
  '@@||mediadelivery.net^',
  '@@||b-cdn.net^',
  '@@||bunnycdn.com^',
  '@@||bunny.net^',
]

/**
 * scriptlet/redirect 리소스를 blocker 에 적용. 네트워크 우선, 실패 시 디스크 캐시 폴백.
 * 적용되면 `##+js(...)` 류 anti-adblock 우회 규칙이 실제로 페이지에 주입된다.
 */
async function loadScriptletResources(b: BlockerInstance, crossFetch: typeof fetch): Promise<void> {
  let text: string | null = null
  try {
    const resp = await crossFetch(UBO_RESOURCES_URL)
    if (resp.ok) {
      text = await resp.text()
      // 다음 실행을 위한 캐시 저장(오프라인 폴백)
      void fs.writeFile(resourcesCachePath(), text).catch(() => undefined)
    }
  } catch {
    /* 네트워크 실패 — 캐시로 폴백 */
  }
  if (!text) {
    try { text = await fs.readFile(resourcesCachePath(), 'utf8') } catch { text = null }
  }
  if (!text) {
    console.warn('[adblock] scriptlet resources unavailable — +js() rules disabled')
    return
  }
  try {
    b.updateResources(text, `${text.length}`)
    console.log('[adblock] scriptlet resources loaded (+js rules active)')
  } catch (err) {
    console.warn('[adblock] updateResources failed', err)
  }
}

async function loadAdblockModule(): Promise<typeof import('@ghostery/adblocker-electron') | null> {
  try {
    return await import('@ghostery/adblocker-electron')
  } catch {
    console.warn('[adblock] @ghostery/adblocker-electron not installed — skipped')
    return null
  }
}

// Electron 35(Node 22 내장)의 메인 프로세스에는 네이티브 fetch 가 이미 있다 — 이 코드베이스의
// 다른 모든 곳(translate/torrent/extensions/video-download 등)도 별도 폴리필 없이 이걸 그대로 쓴다.
// 예전엔 cross-fetch 를 우선 시도했는데, 그 패키지는 항상 설치돼 있어 매번 성공 → 불필요한
// node-fetch 계열 폴리필(Headers/Response/Blob 등)을 파싱·상주시키는 낭비였다. 네이티브를 우선하고,
// (이론상으로만 있을 수 있는) 네이티브 부재 환경을 위해 cross-fetch 를 폴백으로만 남긴다.
// 동작은 100% 동일(둘 다 스펙 준수 fetch) — adblock 필터링 결과에 영향 없음.
async function loadCrossFetch(): Promise<typeof fetch | null> {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis)
  try {
    const mod = await import('cross-fetch')
    return (mod.default ?? mod) as unknown as typeof fetch
  } catch {
    return null
  }
}

function resolveFilterUrls(): string[] {
  const settings = getSetting('adblock')
  if (settings.level === 'custom') {
    const f = settings.filters
    return (Object.keys(FILTER_URL) as FilterId[])
      .filter((k) => f[k] === true)
      .map((k) => FILTER_URL[k])
  }
  return LEVEL_FILTERS[settings.level].map((k) => FILTER_URL[k])
}

function frameUrlOf(details: Electron.OnBeforeRequestListenerDetails | Electron.OnHeadersReceivedListenerDetails): string {
  // electron 30+ 에서는 referrer / firstPartyUrl 가 webContentsId 없으면 비어있을 수 있음
  type WithExtras = { referrer?: string; firstPartyUrl?: string; documentLifecycle?: string }
  const d = details as Electron.OnBeforeRequestListenerDetails & WithExtras
  return d.referrer || d.firstPartyUrl || details.url
}

function normalizeHost(h: string): string {
  return h.replace(/^www\./i, '').toLowerCase()
}

function isSiteAllowlisted(documentUrl: string): boolean {
  if (!documentUrl) return false
  let host: string
  try { host = normalizeHost(new URL(documentUrl).hostname) } catch { return false }
  const overrides = getSetting('adblock').siteOverrides ?? {}
  for (const [allowedHost, allowed] of Object.entries(overrides)) {
    if (allowed !== false) continue
    const target = normalizeHost(allowedHost)
    if (host === target || host.endsWith('.' + target)) return true
  }
  return false
}

function recordBlock(details: { url: string }, sourceUrl: string): void {
  let host = ''
  try { host = new URL(details.url).hostname } catch { /* ignore */ }
  let sourceHost: string | undefined
  try { if (sourceUrl) sourceHost = new URL(sourceUrl).hostname } catch { /* ignore */ }
  stats.totalBlocked += 1
  if (host) stats.perHost[host] = (stats.perHost[host] ?? 0) + 1
  recent.unshift({ ts: Date.now(), url: details.url, host, sourceHost })
  if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT
}

function attachOverridingListeners(ses: Session, b: BlockerInstance): void {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    // 영상 unbreak: 일부 사이트가 Bunny Stream 영상을 player.mediadelivery.net 으로 embed 하는데
    // 그 서브도메인은 404 다(정상은 iframe.mediadelivery.net). http→http 리라이트로 영상 복구.
    const u = details.url
    if (u.indexOf('player.mediadelivery.net/embed/') !== -1) {
      callback({ redirectURL: u.replace('//player.mediadelivery.net/', '//iframe.mediadelivery.net/') })
      return
    }
    const sourceUrl = frameUrlOf(details)
    if (isSiteAllowlisted(sourceUrl)) {
      callback({})
      return
    }
    b.onBeforeRequest(details, (response) => {
      if (response.cancel === true || response.redirectURL) {
        recordBlock({ url: details.url }, sourceUrl)
      }
      callback(response)
    })
  })
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    const sourceUrl = frameUrlOf(details)
    // policy 응답헤더 변형은 adblock allowlist 와 무관하게 항상 적용 — 세션당 리스너 1개뿐이라 여기서 팬아웃.
    const applyPolicy = (
      headers: Record<string, string | string[]> | undefined,
    ): Record<string, string | string[]> | undefined => {
      try { return applyToResponseHeaders(details.url, headers) } catch { return headers }
    }
    if (isSiteAllowlisted(sourceUrl)) {
      callback({ responseHeaders: applyPolicy(details.responseHeaders) })
      return
    }
    b.onHeadersReceived(details, (response) => {
      if (response.cancel === true) { callback(response); return }
      callback({
        ...response,
        responseHeaders: applyPolicy(response.responseHeaders ?? details.responseHeaders),
      })
    })
  })
}

function clearListeners(ses: Session): void {
  ses.webRequest.onBeforeRequest(null)
  // null 로 두면 policy 응답헤더 룰까지 죽는다(policy installOn 은 WeakSet 가드로 재설치 안 됨)
  // → adblock 없이도 policy 만 적용하는 리스너로 교체
  ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, cb) => {
    try { cb({ cancel: false, responseHeaders: applyToResponseHeaders(details.url, details.responseHeaders) }) }
    catch { cb({ cancel: false, responseHeaders: details.responseHeaders }) }
  })
}

async function buildBlocker(): Promise<BlockerInstance | null> {
  const mod = await loadAdblockModule()
  if (!mod) return null
  const { ElectronBlocker } = mod
  const crossFetch = await loadCrossFetch()
  if (!crossFetch) return null

  await fs.mkdir(path.dirname(enginePath()), { recursive: true }).catch(() => undefined)
  const urls = resolveFilterUrls()
  if (urls.length === 0) return null
  const wasCold = !existsSync(enginePath())
  try {
    const b = await ElectronBlocker.fromLists(
      crossFetch,
      urls,
      { enableCompression: true },
      { path: enginePath(), read: fs.readFile, write: fs.writeFile },
    ) as unknown as BlockerInstance
    // scriptlet/redirect 리소스 적용 — +js() anti-adblock 우회 규칙 활성
    await loadScriptletResources(b, crossFetch)
    // 사이트 자체(first-party) 스크립트가 오탐 차단되어 영상 로더 등이 깨지는 것 방지(예외 규칙).
    // 광고 스크립트는 대부분 third-party 라 영향 없음.
    try {
      b.updateFromDiff({ added: SITE_SCRIPT_ALLOW })
    } catch (err) {
      console.warn('[adblock] site-script allow merge failed', err)
    }
    // 콜드 빌드(캐시 없이 리스트 원문을 직접 파싱)였을 때만 — 파싱 스크래치 메모리 회수 시도.
    // 캐시가 있던(웜) 경로는 이미 가볍기 때문에 건드릴 필요 없음.
    if (wasCold) nudgeGc('adblock-cold-build')
    return b
  } catch (err) {
    console.warn('[adblock] fromLists failed', err)
    return null
  }
}

// @ghostery 의 전역 cosmetic ipc 핸들러는 blocker 단위라 1회 등록으로 모든 세션을 처리한다.
// 따라서 "한 세션"에서만 enableBlockingInSession 으로 전역 핸들러를 켜고(cosmeticGlobalSession),
// 나머지 세션엔 동일한 content preload 만 추가 등록하면 코스메틱·scriptlet 이 그 세션에도 주입된다.
// → anti-adblock 탐지(오버레이/스크롤 잠금)를 모든 탭 세션에서 우회. 네트워크 차단은 항상 모든 세션.
let cosmeticGlobalSession: Session | null = null
const cosmeticPreloadIds = new Map<Session, string>()

function enableOnSession(ses: Session): void {
  if (!blocker) return
  if (!cosmeticGlobalSession && ses !== session.defaultSession) {
    try {
      // 첫 탭 세션: 전역 cosmetic ipc 핸들러 + 이 세션 preload + (임시 webRequest, 아래서 덮어씀)
      blocker.enableBlockingInSession(ses)
      cosmeticGlobalSession = ses
    } catch (err) {
      console.warn('[adblock] cosmetic(global) enable failed', err)
    }
  } else if (ses !== cosmeticGlobalSession && COSMETIC_PRELOAD_PATH && !cosmeticPreloadIds.has(ses)) {
    try {
      // 나머지 세션: content preload 만 추가(전역 ipc 핸들러는 이미 등록됨)
      const id = (ses as PreloadSession).registerPreloadScript({ type: 'frame', filePath: COSMETIC_PRELOAD_PATH })
      cosmeticPreloadIds.set(ses, id)
    } catch (err) {
      console.warn('[adblock] cosmetic preload register failed', err)
    }
  }
  // 네트워크 차단 + allowlist + 통계 — 모든 세션. enableBlockingInSession 의 webRequest 도 여기서 덮어씀.
  try {
    attachOverridingListeners(ses, blocker)
  } catch (err) {
    console.warn('[adblock] attach listeners failed', err)
  }
}

function disableOnAllSessions(): void {
  if (cosmeticGlobalSession) {
    try { blocker?.disableBlockingInSession(cosmeticGlobalSession) } catch { /* ignore */ }
    cosmeticGlobalSession = null
  }
  for (const [ses, id] of cosmeticPreloadIds) {
    try { (ses as PreloadSession).unregisterPreloadScript(id) } catch { /* ignore */ }
  }
  cosmeticPreloadIds.clear()
  forEachInstalledSession(clearListeners)
}

let hookRegistered = false

export async function initAdblock(): Promise<void> {
  // 기존 정리 — 모든 세션에서 해제
  if (blocker) {
    disableOnAllSessions()
    blocker = null
  } else {
    forEachInstalledSession(clearListeners)
  }

  const settings = getSetting('adblock')
  if (!settings.enabled) {
    adblockEvents.emit('changed')
    return
  }

  const b = await buildBlocker()
  if (!b) return
  blocker = b

  // 모든 partition 세션(persist:default·워크스페이스 ws-* 포함)에 적용 — 탭은 defaultSession 을 쓰지 않는다.
  if (!hookRegistered) {
    hookRegistered = true
    // 등록 즉시 기존 세션 전부에 적용 + 이후 새로 생성되는 세션에도 자동 적용
    addSessionInitHook((ses) => { if (blocker) enableOnSession(ses) })
  } else {
    // 재초기화(설정 변경) — 기존 세션에 다시 적용
    forEachInstalledSession(enableOnSession)
  }
  console.log(`[adblock] initialized (${settings.level}, filters=${resolveFilterUrls().length}, all sessions)`)
  adblockEvents.emit('changed')
}

export async function setAdblockLevel(level: Level): Promise<void> {
  setNestedSetting('adblock.level', level)
  await initAdblock()
}

export async function setAdblockEnabled(enabled: boolean): Promise<void> {
  setNestedSetting('adblock.enabled', enabled)
  await initAdblock()
}

export async function setAdblockFilter(id: FilterId, enabled: boolean): Promise<void> {
  const cur = { ...getSetting('adblock').filters, [id]: enabled }
  setNestedSetting('adblock.filters', cur)
  // 개별 필터 토글은 'custom' 모드로 전환
  setNestedSetting('adblock.level', 'custom')
  await initAdblock()
}

export async function setSiteAllowed(host: string, allowed: boolean): Promise<void> {
  const h = normalizeHost(host)
  if (!h) return
  const cur = { ...(getSetting('adblock').siteOverrides ?? {}) }
  if (allowed) cur[h] = false
  else delete cur[h]
  setNestedSetting('adblock.siteOverrides', cur)
  adblockEvents.emit('changed')
}

export async function toggleSiteAllowed(url: string): Promise<{ host: string | null; allowed: boolean }> {
  let host: string
  try { host = normalizeHost(new URL(url).hostname) } catch { return { host: null, allowed: false } }
  if (!host) return { host: null, allowed: false }
  const cur = getSetting('adblock').siteOverrides ?? {}
  const wasAllowed = cur[host] === false
  await setSiteAllowed(host, !wasAllowed)
  return { host, allowed: !wasAllowed }
}

export function getAdblockStats(): AdblockStats {
  const s = getSetting('adblock')
  return {
    totalBlocked: stats.totalBlocked,
    perHost: { ...stats.perHost },
    enabled: s.enabled,
    level: s.level,
    filters: { ...s.filters },
    siteOverrides: { ...(s.siteOverrides ?? {}) },
    recent: [...recent],
  }
}

export function getRecentBlocks(limit = 50): AdblockRecentBlock[] {
  return recent.slice(0, Math.max(0, Math.min(RECENT_LIMIT, limit)))
}
