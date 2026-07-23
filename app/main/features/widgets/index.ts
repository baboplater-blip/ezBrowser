import { net } from 'electron'
import Store from 'electron-store'
import { getSetting } from '../../storage/settings'

// 새 탭 위젯(날씨·뉴스). 외부 API 키 없이 동작:
//  - 날씨: Open-Meteo (무료, 키 불필요)
//  - 위치: ipapi.co IP 지오로케이션 (자동) 또는 설정의 수동 좌표
//  - 뉴스: Google News RSS (무료, 키 불필요)
// CSP가 default-src 'self' 인 새 탭 페이지에서 직접 fetch 가 막히므로 메인 프로세스가 대신 가져온다.
// stale-while-revalidate: 캐시가 신선하면 그대로, 오래됐으면 새로 받되 실패 시 마지막 성공값을 반환.

const WEATHER_TTL_MS = 30 * 60 * 1000
const NEWS_TTL_MS = 15 * 60 * 1000
const REQ_TIMEOUT_MS = 12_000
const SEOUL = { lat: 37.5665, lon: 126.978, place: '서울' }

export interface WeatherDay { label: string; max: number; min: number; code: number; icon: string }
export interface WeatherResult {
  place: string; temp: number; code: number; desc: string; icon: string
  wind: number; unit: string; daily: WeatherDay[]; ts: number
}
export interface NewsItem { title: string; link: string; source: string }
export interface NewsResult { topic: string; items: NewsItem[]; ts: number }
export interface FxRate { code: string; value: number }
export interface FxResult { base: string; date: string; rates: FxRate[]; ts: number }

interface CacheEntry<T> { value: T; ts: number }
const weatherCache = new Map<string, CacheEntry<WeatherResult>>()
const newsCache = new Map<string, CacheEntry<NewsResult>>()
const fxCache = new Map<string, CacheEntry<FxResult>>()
let geoCache: { lat: number; lon: number; place: string; ts: number } | null = null
const FX_TTL_MS = 60 * 60 * 1000

// 마지막 성공값 영속 — 앱 재시작 직후 새 탭에서 즉시 표시(이후 백그라운드 갱신).
const persist = new Store<{ weather?: WeatherResult; news?: Record<string, NewsResult>; fx?: Record<string, FxResult> }>({ name: 'widgets-cache' })

// 새 탭 위젯 사용자 데이터(메모·할 일). browser:// 로컬스토리지와 달리 방문 데이터 삭제에도 보존되고
// 향후 데이터 내보내기에 포함 가능. 키는 IPC 계층에서 화이트리스트로 제한.
const userData = new Store<Record<string, unknown>>({ name: 'widgets-data' })
export function getWidgetData(key: string): unknown { return userData.get(key) ?? null }
export function setWidgetData(key: string, value: unknown): void { userData.set(key, value) }

// ── HTTP 헬퍼 ───────────────────────────────────────────────────────────────
function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET', useSessionCookies: false })
    if (headers) for (const [k, v] of Object.entries(headers)) req.setHeader(k, v)
    const chunks: Buffer[] = []
    const timer = setTimeout(() => { try { req.abort() } catch { /* ignore */ } reject(new Error('timeout')) }, REQ_TIMEOUT_MS)
    req.on('response', (resp) => {
      if (resp.statusCode >= 400) {
        clearTimeout(timer)
        try { req.abort() } catch { /* ignore */ }
        reject(new Error('http ' + resp.statusCode))
        return
      }
      resp.on('data', (c: Buffer) => chunks.push(c))
      resp.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')) })
    })
    req.on('error', (err) => { clearTimeout(timer); reject(err) })
    req.end()
  })
}

async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url, { Accept: 'application/json' })) as T
}

// ── 날씨 ─────────────────────────────────────────────────────────────────────
// WMO weather code → 한국어 설명 + 이모지
function describeCode(code: number): { desc: string; icon: string } {
  const map: Record<number, [string, string]> = {
    0: ['맑음', '☀️'],
    1: ['대체로 맑음', '🌤️'], 2: ['구름 조금', '⛅'], 3: ['흐림', '☁️'],
    45: ['안개', '🌫️'], 48: ['짙은 안개', '🌫️'],
    51: ['약한 이슬비', '🌦️'], 53: ['이슬비', '🌦️'], 55: ['강한 이슬비', '🌧️'],
    56: ['어는 이슬비', '🌧️'], 57: ['강한 어는 이슬비', '🌧️'],
    61: ['약한 비', '🌦️'], 63: ['비', '🌧️'], 65: ['강한 비', '🌧️'],
    66: ['어는 비', '🌧️'], 67: ['강한 어는 비', '🌧️'],
    71: ['약한 눈', '🌨️'], 73: ['눈', '🌨️'], 75: ['강한 눈', '❄️'], 77: ['싸락눈', '🌨️'],
    80: ['약한 소나기', '🌦️'], 81: ['소나기', '🌧️'], 82: ['강한 소나기', '⛈️'],
    85: ['약한 눈 소나기', '🌨️'], 86: ['강한 눈 소나기', '❄️'],
    95: ['뇌우', '⛈️'], 96: ['우박 동반 뇌우', '⛈️'], 99: ['강한 우박 뇌우', '⛈️'],
  }
  const hit = map[code]
  return hit ? { desc: hit[0], icon: hit[1] } : { desc: '알 수 없음', icon: '🌡️' }
}

const DAY_KO = ['일', '월', '화', '수', '목', '금', '토']

async function resolveLocation(): Promise<{ lat: number; lon: number; place: string }> {
  const w = getSetting('widgets')
  if (w.locationMode === 'manual' && Number.isFinite(w.manualLat) && Number.isFinite(w.manualLon)) {
    return { lat: w.manualLat, lon: w.manualLon, place: w.manualPlace || '내 위치' }
  }
  // auto: IP 지오로케이션 (1시간 캐시)
  if (geoCache && Date.now() - geoCache.ts < 60 * 60 * 1000) {
    return { lat: geoCache.lat, lon: geoCache.lon, place: geoCache.place }
  }
  try {
    const j = await fetchJson<{ latitude: number; longitude: number; city?: string; region?: string }>('https://ipapi.co/json/')
    if (Number.isFinite(j.latitude) && Number.isFinite(j.longitude)) {
      const place = j.city || j.region || '내 위치'
      geoCache = { lat: j.latitude, lon: j.longitude, place, ts: Date.now() }
      return { lat: j.latitude, lon: j.longitude, place }
    }
  } catch { /* fall through to Seoul */ }
  return SEOUL
}

export async function getWeather(force = false): Promise<WeatherResult | null> {
  const loc = await resolveLocation()
  const w = getSetting('widgets')
  const imperial = w.units === 'imperial'
  const key = loc.lat.toFixed(2) + ',' + loc.lon.toFixed(2) + ',' + (imperial ? 'F' : 'C')
  const cached = weatherCache.get(key)
  if (!force && cached && Date.now() - cached.ts < WEATHER_TTL_MS) return cached.value

  try {
    const params = new URLSearchParams({
      latitude: String(loc.lat), longitude: String(loc.lon),
      current: 'temperature_2m,weather_code,wind_speed_10m',
      daily: 'temperature_2m_max,temperature_2m_min,weather_code',
      timezone: 'auto', forecast_days: '3',
    })
    if (imperial) { params.set('temperature_unit', 'fahrenheit'); params.set('wind_speed_unit', 'mph') }
    const j = await fetchJson<{
      current: { temperature_2m: number; weather_code: number; wind_speed_10m: number }
      daily: { time: string[]; temperature_2m_max: number[]; temperature_2m_min: number[]; weather_code: number[] }
    }>('https://api.open-meteo.com/v1/forecast?' + params.toString())

    const cur = describeCode(j.current.weather_code)
    const daily: WeatherDay[] = (j.daily?.time ?? []).slice(0, 3).map((iso, i) => {
      const d = new Date(iso + 'T00:00:00')
      const code = j.daily.weather_code[i] ?? 0
      return {
        label: i === 0 ? '오늘' : (DAY_KO[d.getDay()] ?? ''),
        max: Math.round(j.daily.temperature_2m_max[i] ?? 0),
        min: Math.round(j.daily.temperature_2m_min[i] ?? 0),
        code,
        icon: describeCode(code).icon,
      }
    })
    const result: WeatherResult = {
      place: loc.place, temp: Math.round(j.current.temperature_2m), code: j.current.weather_code,
      desc: cur.desc, icon: cur.icon, wind: Math.round(j.current.wind_speed_10m),
      unit: imperial ? '°F' : '°C', daily, ts: Date.now(),
    }
    weatherCache.set(key, { value: result, ts: result.ts })
    persist.set('weather', result)
    return result
  } catch (err) {
    console.warn('[widgets] weather failed', err)
    if (cached) return cached.value
    const last = persist.get('weather')
    return last ?? null
  }
}

// ── 뉴스 ─────────────────────────────────────────────────────────────────────
const NEWS_TOPIC_PATH: Record<string, string | null> = {
  headlines: null, world: 'WORLD', nation: 'NATION', business: 'BUSINESS',
  technology: 'TECHNOLOGY', entertainment: 'ENTERTAINMENT', sports: 'SPORTS',
  science: 'SCIENCE', health: 'HEALTH',
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim()
}

function parseRss(xml: string, limit: number): NewsItem[] {
  const items: NewsItem[] = []
  const itemRe = /<item\b[\s\S]*?<\/item>/g
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) && items.length < limit) {
    const block = m[0]
    const titleRaw = (block.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? ''
    const linkRaw = (block.match(/<link>([\s\S]*?)<\/link>/) ?? [])[1] ?? ''
    const srcRaw = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) ?? [])[1] ?? ''
    let title = decodeEntities(titleRaw)
    const source = decodeEntities(srcRaw)
    // Google News 제목은 "헤드라인 - 언론사" 형식 — 끝의 언론사 꼬리표 제거
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3))
    const link = decodeEntities(linkRaw)
    if (title && link) items.push({ title, link, source })
  }
  return items
}

export async function getNews(force = false): Promise<NewsResult | null> {
  const w = getSetting('widgets')
  const topic = w.newsTopic in NEWS_TOPIC_PATH ? w.newsTopic : 'headlines'
  const cached = newsCache.get(topic)
  if (!force && cached && Date.now() - cached.ts < NEWS_TTL_MS) return cached.value

  try {
    const path = NEWS_TOPIC_PATH[topic]
    const url = path
      ? `https://news.google.com/rss/headlines/section/topic/${path}?hl=ko&gl=KR&ceid=KR:ko`
      : 'https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko'
    const xml = await fetchText(url, { 'User-Agent': 'Mozilla/5.0', Accept: 'application/rss+xml, application/xml' })
    const items = parseRss(xml, 8)
    if (items.length === 0) throw new Error('no items')
    const result: NewsResult = { topic, items, ts: Date.now() }
    newsCache.set(topic, { value: result, ts: result.ts })
    const store = persist.get('news') ?? {}
    store[topic] = result
    persist.set('news', store)
    return result
  } catch (err) {
    console.warn('[widgets] news failed', err)
    if (cached) return cached.value
    const last = (persist.get('news') ?? {})[topic]
    return last ?? null
  }
}

// ── 환율 ─────────────────────────────────────────────────────────────────────
// Frankfurter (ECB 데이터, 무료, 키 불필요). 지원 통화는 ECB 목록(약 30종)으로 제한됨.
const FX_DEFAULT_SYMBOLS = 'KRW,JPY,EUR,CNY'

export async function getFx(force = false): Promise<FxResult | null> {
  const w = getSetting('widgets')
  const base = (w.fxBase || 'USD').toUpperCase().slice(0, 3)
  const symbols = (w.fxSymbols || FX_DEFAULT_SYMBOLS)
    .split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{3}$/.test(s) && s !== base)
  const list = symbols.length > 0 ? symbols : FX_DEFAULT_SYMBOLS.split(',').filter((s) => s !== base)
  const key = base + '>' + list.join(',')
  const cached = fxCache.get(key)
  if (!force && cached && Date.now() - cached.ts < FX_TTL_MS) return cached.value

  try {
    const url = `https://api.frankfurter.app/latest?from=${base}&symbols=${list.join(',')}`
    const j = await fetchJson<{ base: string; date: string; rates: Record<string, number> }>(url)
    const rates: FxRate[] = list
      .map((code) => ({ code, value: j.rates?.[code] }))
      .filter((r): r is FxRate => typeof r.value === 'number')
    if (rates.length === 0) throw new Error('no rates')
    const result: FxResult = { base, date: j.date || '', rates, ts: Date.now() }
    fxCache.set(key, { value: result, ts: result.ts })
    const store = persist.get('fx') ?? {}
    store[key] = result
    persist.set('fx', store)
    return result
  } catch (err) {
    console.warn('[widgets] fx failed', err)
    if (cached) return cached.value
    const last = (persist.get('fx') ?? {})[key]
    return last ?? null
  }
}
