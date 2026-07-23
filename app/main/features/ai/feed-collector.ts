import { app, BrowserWindow, Notification, net } from 'electron'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getSetting } from '../../storage/settings'
import { getAiKey } from './keys'
import { chatOnce, isCliProvider, cliPathSettingKey, type AiMessage, type AiRequest } from './providers'
import { extractFromPage } from './page-actions'

// 매일 자동 수집 — 지정 소스를 매일(또는 주기적으로) 몰래 열어 스크롤·추출하고, 어제 대비 새 항목만 골라
// AI 로 요약(브리핑)한 뒤 알림/웹훅으로 전달한다. 숨은 창(show:false)에서 조용히 돈다 — 사용자 방해 없음.
// 재시작해도 유지(영속). 부팅 시 타이머 재무장하되 과거분 소급 실행은 하지 않는다(안전).

export type CollectSchedule = 'daily' | 'interval'
export interface FeedCollector {
  id: string
  name: string
  enabled: boolean
  sources: string[]                 // 수집할 페이지 URL 들
  scheduleType: CollectSchedule
  time?: string                     // daily: "HH:MM"
  intervalMinutes?: number          // interval: 분
  rowSelector?: string              // 반복 항목 CSS(없으면 자동 감지 — 제목+링크)
  fields?: Record<string, string>   // {열이름: 선택자}
  keyword?: string                  // 쉼표 OR 필터(비면 전체)
  summarize: boolean                // AI 요약 브리핑 생성
  notify: boolean                   // 새 항목 시 알림
  webhook: boolean                  // 새 항목 시 웹훅 전송(설정 ai.webhookUrl)
  maxItems?: number                 // 소스당 최대 수집 수(기본 40)
  seen: string[]                    // 중복 제거 키(누적, 상한)
  lastFiredDay?: string             // daily: 마지막 발화 날짜("YYYY-M-D") — 재시작해도 하루 1회 보장
  lastRunAt?: number
  lastCount?: number                // 마지막 실행에서 새 항목 수
  lastDigest?: string               // 마지막 브리핑
  createdAt: number
}

export interface CollectItem { [k: string]: string }
export interface CollectRun {
  id: string
  collectorId: string
  collectorName: string
  at: number
  newCount: number
  items: CollectItem[]              // 새 항목(상한)
  digest?: string
}

const SEEN_CAP = 4000
const RUNS_CAP = 60
const RUN_ITEMS_CAP = 60

const CFILE = (): string => join(app.getPath('userData'), 'ai-collectors.json')
const RFILE = (): string => join(app.getPath('userData'), 'ai-collect-runs.json')

let collectors: FeedCollector[] = []
let runs: CollectRun[] = []
export const collectorEvents = new EventEmitter()
let saveTimer: NodeJS.Timeout | null = null
let saveRunsTimer: NodeJS.Timeout | null = null

function atomicWrite(file: string, data: unknown): void {
  try {
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch { /* ignore */ }
}
function persist(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => atomicWrite(CFILE(), collectors), 300)
}
function persistRuns(): void {
  if (saveRunsTimer) clearTimeout(saveRunsTimer)
  saveRunsTimer = setTimeout(() => atomicWrite(RFILE(), runs), 300)
}
function emitChanged(): void { collectorEvents.emit('changed', listCollectors()) }

// 외부에 seen 배열을 그대로 노출하지 않는다(무거움) — 요약 정보만.
function summaryOf(c: FeedCollector): Omit<FeedCollector, 'seen'> & { seenCount: number } {
  const { seen, ...rest } = c
  return { ...rest, seenCount: seen.length }
}
export function listCollectors(): Array<Omit<FeedCollector, 'seen'> & { seenCount: number }> {
  return collectors.map(summaryOf)
}
export function listRunsFor(collectorId: string, limit = 10): CollectRun[] {
  return runs.filter((r) => r.collectorId === collectorId).sort((a, b) => b.at - a.at).slice(0, limit)
}

function sanitize(p: Partial<FeedCollector>, base?: FeedCollector): FeedCollector {
  const scheduleType: CollectSchedule = (p.scheduleType === 'interval' || p.scheduleType === 'daily') ? p.scheduleType : (base?.scheduleType ?? 'daily')
  const sources = Array.isArray(p.sources)
    ? p.sources.map((s) => String(s).trim()).filter((s) => /^https?:\/\//i.test(s)).slice(0, 20)
    : (base?.sources ?? [])
  const fields = (p.fields && typeof p.fields === 'object' && !Array.isArray(p.fields))
    ? Object.fromEntries(Object.entries(p.fields).map(([k, v]) => [String(k).slice(0, 60), String(v).slice(0, 200)]).slice(0, 12))
    : base?.fields
  return {
    id: base?.id ?? randomUUID(),
    name: String(p.name ?? base?.name ?? '수집기').slice(0, 80),
    enabled: p.enabled != null ? !!p.enabled : (base?.enabled ?? true),
    sources,
    scheduleType,
    time: p.time != null ? String(p.time).slice(0, 5) : base?.time,
    intervalMinutes: p.intervalMinutes != null ? Math.max(5, Math.min(1440, Math.round(Number(p.intervalMinutes) || 60))) : base?.intervalMinutes,
    rowSelector: p.rowSelector != null ? String(p.rowSelector).slice(0, 200) : base?.rowSelector,
    fields,
    keyword: p.keyword != null ? String(p.keyword).slice(0, 200) : base?.keyword,
    summarize: p.summarize != null ? !!p.summarize : (base?.summarize ?? true),
    notify: p.notify != null ? !!p.notify : (base?.notify ?? true),
    webhook: p.webhook != null ? !!p.webhook : (base?.webhook ?? false),
    maxItems: p.maxItems != null ? Math.max(5, Math.min(200, Math.round(Number(p.maxItems) || 40))) : base?.maxItems,
    seen: base?.seen ?? [],
    lastFiredDay: base?.lastFiredDay,
    lastRunAt: base?.lastRunAt,
    lastCount: base?.lastCount,
    lastDigest: base?.lastDigest,
    createdAt: base?.createdAt ?? Date.now(),
  }
}

export function addCollector(p: Partial<FeedCollector>): Omit<FeedCollector, 'seen'> & { seenCount: number } {
  const c = sanitize(p)
  collectors.push(c)
  persist(); emitChanged()
  return summaryOf(c)
}
export function updateCollector(id: string, p: Partial<FeedCollector>): void {
  const i = collectors.findIndex((c) => c.id === id)
  if (i < 0) return
  collectors[i] = sanitize(p, collectors[i])
  persist(); emitChanged()
}
export function removeCollector(id: string): void {
  collectors = collectors.filter((c) => c.id !== id)
  runs = runs.filter((r) => r.collectorId !== id)
  persist(); persistRuns(); emitChanged()
}
export function setCollectorEnabled(id: string, on: boolean): void {
  const c = collectors.find((x) => x.id === id)
  if (c) { c.enabled = !!on; persist(); emitChanged() }
}

// ===== 수집 실행 =====
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function itemKey(item: CollectItem): string {
  // 링크가 있으면 링크로, 없으면 전체 값으로 dedup.
  const link = item['링크'] || item.link || item.url || item.href || ''
  const base = link || Object.values(item).join('|')
  let h = 5381
  for (let i = 0; i < base.length; i++) h = ((h << 5) + h + base.charCodeAt(i)) | 0
  return String(h >>> 0)
}

// 자동 감지(선택자 미지정) — 피드/목록 페이지에서 제목+링크를 뽑는 범용 스크립트.
async function autoCollect(wc: Electron.WebContents, cap: number): Promise<CollectItem[]> {
  const js = `(function(){
    var cap = ${cap};
    var out = [], seen = {};
    var anchors = Array.prototype.slice.call(document.querySelectorAll('article a, li a, h1 a, h2 a, h3 a, .item a, [class*="title"] a, [class*="post"] a, a'));
    for (var i=0;i<anchors.length && out.length<cap;i++){
      var a = anchors[i];
      var t = (a.innerText||a.textContent||'').replace(/\\s+/g,' ').trim();
      var href = a.href || '';
      if (!t || t.length < 10) continue;
      if (!/^https?:/i.test(href)) continue;
      if (seen[href]) continue; seen[href]=1;
      out.push({ '제목': t.slice(0,200), '링크': href });
    }
    return out;
  })()`
  try { return (await wc.executeJavaScript(js, true)) as CollectItem[] } catch { return [] }
}

// ===== RSS/Atom 직접 파싱 — 많은 사이트가 RSS 를 제공하며, 스크래핑보다 정확·안정하고 창도 안 띄운다 =====
function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}
// RSS 2.0(<item>) + Atom(<entry>) 둘 다 처리. 제목+링크(+요약)를 CollectItem 으로.
function parseFeed(xml: string, cap: number): CollectItem[] {
  const out: CollectItem[] = []
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml)
  const blockRe = isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(xml)) && out.length < cap) {
    const block = m[0]
    const titleRaw = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1] ?? ''
    let link = ''
    if (isAtom) {
      // Atom: <link href="..." rel="alternate"/> 우선, 없으면 첫 link href
      const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
        ?? block.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["']/i)
        ?? block.match(/<link[^>]*href=["']([^"']+)["']/i)
      link = alt?.[1] ?? ''
    } else {
      link = (block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) ?? [])[1] ?? ''
      if (!link) link = (block.match(/<link[^>]*href=["']([^"']+)["']/i) ?? [])[1] ?? ''
    }
    const descRaw = (block.match(/<(?:description|summary|content)[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/i) ?? [])[1] ?? ''
    const title = decodeEntities(titleRaw)
    const href = decodeEntities(link)
    if (!title || !/^https?:/i.test(href)) continue
    const desc = decodeEntities(descRaw).slice(0, 300)
    const item: CollectItem = { 제목: title.slice(0, 200), 링크: href }
    if (desc) item['요약'] = desc
    out.push(item)
  }
  return out
}
function looksLikeFeed(contentType: string, body: string): boolean {
  if (/(application|text)\/(rss|atom|xml)|\+xml/i.test(contentType)) return true
  const head = body.slice(0, 600)
  return /<rss[\s>]|<feed[\s>]|<\?xml[\s\S]*?(<rss|<feed|<channel)/i.test(head)
}
// URL 을 직접 받아(HTTP GET), RSS/Atom 이면 파싱해서 반환. 피드가 아니면 null(→ 스크래핑 폴백).
function fetchFeed(url: string, cap: number): Promise<CollectItem[] | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: CollectItem[] | null): void => { if (!settled) { settled = true; resolve(v) } }
    try {
      const req = net.request({ url, method: 'GET' })
      req.setHeader('User-Agent', 'Mozilla/5.0')
      req.setHeader('Accept', 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*')
      const timer = setTimeout(() => { try { req.abort() } catch { /* ignore */ } done(null) }, 12000)
      req.on('response', (resp) => {
        const status = resp.statusCode ?? 0
        const ct = String(resp.headers['content-type'] ?? '')
        const chunks: Buffer[] = []
        let total = 0
        resp.on('data', (c: Buffer) => { if (total < 3_000_000) { chunks.push(c); total += c.length } })
        resp.on('end', () => {
          clearTimeout(timer)
          if (status < 200 || status >= 300) { done(null); return }
          const body = Buffer.concat(chunks).toString('utf8')
          if (!looksLikeFeed(ct, body)) { done(null); return }
          try { done(parseFeed(body, cap)) } catch { done(null) }
        })
        resp.on('error', () => { clearTimeout(timer); done(null) })
      })
      req.on('error', () => { clearTimeout(timer); done(null) })
      req.end()
    } catch { done(null) }
  })
}

// 숨은 창으로 소스 하나를 열어 스크롤 후 수집.
async function collectSource(url: string, c: FeedCollector): Promise<CollectItem[]> {
  const cap0 = c.maxItems ?? 40
  // 사용자 정의 선택자가 없으면 먼저 RSS/Atom 을 시도(정확·안정, 창 불필요). 피드면 그대로 반환.
  if (!c.rowSelector && !(c.fields && Object.keys(c.fields).length)) {
    const feed = await fetchFeed(url, cap0)
    if (feed && feed.length) return feed
  }
  let win: BrowserWindow | null = null
  // 무한 스트리밍/멈춘 페이지에서 loadURL 이 영영 settle 안 되면 숨은 창이 누수되고 running 셋이 영구 점유돼
  // 이 수집기가 재시작 전까지 죽는다 → 타임아웃으로 감싼다.
  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
  try {
    win = new BrowserWindow({ show: false, width: 1200, height: 1400, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    const wc = win.webContents
    await withTimeout(win.loadURL(url), 30000).catch(() => { /* 리다이렉트/타임아웃 무시 — 부분 로드로 진행 */ })
    // 지연 로딩 유도 — 몇 번 스크롤하며 잠깐씩 기다린다.
    for (let i = 0; i < 4; i++) {
      try { await wc.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)', true) } catch { /* ignore */ }
      await sleep(600)
    }
    const cap = c.maxItems ?? 40
    let items: CollectItem[]
    if (c.rowSelector || (c.fields && Object.keys(c.fields).length)) {
      const res = await extractFromPage(wc, { rowSelector: c.rowSelector, fields: c.fields })
      items = res.rows.slice(0, cap)
    } else {
      items = await autoCollect(wc, cap)
    }
    return items
  } catch { return [] }
  finally { try { win?.destroy() } catch { /* ignore */ } }
}

function matchKeyword(item: CollectItem, keyword?: string): boolean {
  if (!keyword || !keyword.trim()) return true
  const terms = keyword.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
  if (!terms.length) return true
  const hay = Object.values(item).join(' ').toLowerCase()
  return terms.some((t) => hay.includes(t))
}

function notify(title: string, body: string): void {
  try { if (Notification.isSupported()) new Notification({ title, body }).show() } catch { /* ignore */ }
}

async function postWebhook(payload: unknown): Promise<void> {
  const url = (getSetting('ai').webhookUrl || '').trim()
  if (!/^https?:\/\//i.test(url)) return
  await new Promise<void>((resolve) => {
    try {
      const req = net.request({ url, method: 'POST' })
      req.setHeader('content-type', 'application/json')
      const timer = setTimeout(() => { try { req.abort() } catch { /* ignore */ } resolve() }, 20000)
      req.on('response', (resp) => { resp.on('data', () => { /* drain */ }); resp.on('end', () => { clearTimeout(timer); resolve() }); resp.on('error', () => { clearTimeout(timer); resolve() }) })
      req.on('error', () => { clearTimeout(timer); resolve() })
      req.write(JSON.stringify(payload)); req.end()
    } catch { resolve() }
  })
}

// 새 항목들을 AI 로 브리핑(불릿 요약). 실패해도 수집 자체는 유효 — digest 만 비게 둔다.
async function summarizeItems(name: string, items: CollectItem[]): Promise<string> {
  try {
    const s = getSetting('ai')
    const provider = s.provider
    const model = provider === 'anthropic' ? s.anthropicModel
      : provider === 'openai' ? s.openaiModel
        : provider === 'google' ? s.googleModel
          : provider === 'claude-code' ? s.claudeCodeModel
            : provider === 'codex' ? s.codexModel
              : provider === 'gemini-cli' ? s.geminiCliModel
                : s.ollamaModel
    let apiKey: string | undefined; let baseUrl: string | undefined
    if (provider === 'ollama') baseUrl = s.ollamaUrl
    else if (isCliProvider(provider)) { const k = cliPathSettingKey(provider); baseUrl = k ? s[k] : '' }
    else { const key = await getAiKey(provider); if (!key) return ''; apiKey = key }
    // 제목 + (있으면)요약/설명까지 넣어 실질 브리핑이 나오게 한다. 링크는 제외(요약에 불필요).
    const list = items.slice(0, 40).map((it, i) => {
      const title = it['제목'] || Object.values(it)[0] || ''
      const desc = it['요약'] || it['description'] || it['설명'] || ''
      return `${i + 1}. ${title}${desc ? ` — ${String(desc).slice(0, 200)}` : ''}`
    }).join('\n')
    const system = '당신은 매일 아침 브리핑을 만드는 편집자입니다. 아래 새 항목들을 사용자가 빠르게 파악하도록 한국어로 간결하게 요약합니다. 불릿(-) 3~6개, 각 줄은 짧게. 제공된 제목·요약만으로 핵심을 정리하고, 정보가 부족하면 제목을 바탕으로 무엇에 관한 소식인지 한 줄로 정리하세요(사과·되묻기 없이).'
    const messages: AiMessage[] = [{ role: 'user', content: `수집기: ${name}\n\n새 항목 ${items.length}건:\n${list}\n\n위 항목들을 오늘의 브리핑으로 요약하세요.` }]
    const req: AiRequest = { provider, model, system, messages, apiKey, baseUrl, maxTokens: 700 }
    const { promise } = chatOnce(req)
    return (await promise).trim()
  } catch { return '' }
}

async function runCollectInternal(c: FeedCollector): Promise<CollectRun> {
  const all: CollectItem[] = []
  for (const src of c.sources) {
    if (all.length > 400) break
    const items = await collectSource(src, c)
    for (const it of items) if (matchKeyword(it, c.keyword)) all.push(it)
  }
  // 중복 제거 — 이번 실행 내 + 과거 seen 대비.
  const seen = new Set(c.seen)
  const fresh: CollectItem[] = []
  const freshKeys: string[] = []
  const touchedSeen: string[] = [] // 이번 실행에도 여전히 페이지에 있는 기존 seen 키 — LRU 로 앞으로 당겨 조기 축출 방지
  const withinRun = new Set<string>()
  for (const it of all) {
    const key = itemKey(it)
    if (withinRun.has(key)) continue
    withinRun.add(key)
    if (seen.has(key)) { touchedSeen.push(key); continue } // 이미 본 항목이지만 여전히 존재 → 갱신(touch-on-hit)
    if (fresh.length < RUN_ITEMS_CAP) { freshKeys.push(key); fresh.push(it) } // 초과분은 다음 실행에서 새 항목으로 보고
  }
  // seen 재구성(LRU): 새 항목 + 이번에 다시 본 항목을 앞으로, 그 뒤 나머지 과거분. 중복 제거·상한 유지.
  // (기존엔 freshKeys 만 앞에 붙여, 계속 노출되는 고정 항목이 뒤로 밀려 SEEN_CAP 밖으로 나가면 재보고됐다.)
  const merged: string[] = []
  const dedupSeen = new Set<string>()
  for (const k of [...freshKeys, ...touchedSeen, ...c.seen]) {
    if (dedupSeen.has(k)) continue
    dedupSeen.add(k); merged.push(k)
    if (merged.length >= SEEN_CAP) break
  }
  c.seen = merged
  let digest = ''
  if (fresh.length && c.summarize) digest = await summarizeItems(c.name, fresh)

  const run: CollectRun = {
    id: randomUUID(), collectorId: c.id, collectorName: c.name, at: Date.now(),
    newCount: fresh.length, items: fresh, digest: digest || undefined,
  }
  runs.unshift(run)
  if (runs.length > RUNS_CAP) runs.length = RUNS_CAP
  c.lastRunAt = run.at; c.lastCount = fresh.length; c.lastDigest = digest || undefined
  persist(); persistRuns(); emitChanged()
  collectorEvents.emit('run', run)

  if (fresh.length) {
    if (c.notify) {
      const first = digest ? digest.split('\n').filter(Boolean)[0]?.slice(0, 140) : (fresh[0]?.['제목'] ?? '')
      notify(`📥 ${c.name} — 새 ${fresh.length}건`, first || `새 항목 ${fresh.length}건을 수집했습니다.`)
    }
    if (c.webhook) void postWebhook({ source: 'ezBrowser-collect', collector: c.name, count: fresh.length, items: fresh, digest, at: run.at })
  }
  return run
}

const running = new Set<string>()
export async function runCollectorNow(id: string): Promise<CollectRun | null> {
  const c = collectors.find((x) => x.id === id)
  if (!c || running.has(id)) return null
  running.add(id)
  try { return await runCollectInternal(c) }
  catch { return null }
  finally { running.delete(id) }
}

// ===== 스케줄 =====
// 매일 발화는 lastFiredDay(영속) 로 하루 1회 보장 — 재시작해도 같은 날 다시 발화하지 않는다(중복 방지).
function dailyTick(): void {
  const now = new Date()
  const cur = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
  const day = now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate()
  for (const c of collectors) {
    if (!c.enabled || c.scheduleType !== 'daily' || !c.time) continue
    if (c.lastFiredDay === day) continue
    // 목표 시각(HH:MM)이 이미 지났으면 발화 — 절전/지연으로 정확한 분을 놓쳐도 그날 안에 실행(catch-up).
    // "HH:MM" 은 0 패딩이라 문자열 비교로 시각 대소가 정확하다.
    if (cur < c.time) continue
    c.lastFiredDay = day
    persist()
    if (!running.has(c.id)) { running.add(c.id); void runCollectInternal(c).catch(() => { /* ignore */ }).finally(() => running.delete(c.id)) }
  }
}
function intervalTick(): void {
  for (const c of collectors) {
    if (!c.enabled || c.scheduleType !== 'interval') continue
    const iv = Math.max(5, c.intervalMinutes ?? 60) * 60000
    if (Date.now() - (c.lastRunAt ?? 0) < iv) continue
    if (running.has(c.id)) continue
    running.add(c.id); void runCollectInternal(c).catch(() => { /* ignore */ }).finally(() => running.delete(c.id))
  }
}

let dailyTimer: NodeJS.Timeout | null = null
let intervalTimer: NodeJS.Timeout | null = null

export function initFeedCollectors(): void {
  try { if (existsSync(CFILE())) { const raw = JSON.parse(readFileSync(CFILE(), 'utf8')) as FeedCollector[]; if (Array.isArray(raw)) collectors = raw.map((c) => sanitize(c, c)) } }
  catch { collectors = [] }
  try { if (existsSync(RFILE())) { const raw = JSON.parse(readFileSync(RFILE(), 'utf8')) as CollectRun[]; if (Array.isArray(raw)) runs = raw.slice(0, RUNS_CAP) } }
  catch { runs = [] }
  if (!dailyTimer) dailyTimer = setInterval(dailyTick, 30000)
  if (!intervalTimer) intervalTimer = setInterval(intervalTick, 60000)
  // 종료 시 디바운스 대기 중이던 상태(seen·lastFiredDay·lastRunAt)를 즉시 flush — 안 그러면 재시작 후
  // 같은 항목을 다시 수집하고 알림·웹훅을 중복 발화한다.
  app.on('before-quit', () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    if (saveRunsTimer) { clearTimeout(saveRunsTimer); saveRunsTimer = null }
    atomicWrite(CFILE(), collectors)
    atomicWrite(RFILE(), runs)
  })
}
