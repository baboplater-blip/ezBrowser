import { app, BrowserWindow, Notification } from 'electron'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runAgentTask, confirmAgentStep, cancelAgentTask } from './agent'
import { getAllWindows } from '../../windows/window-service'
import { createTab, getWebContentsByTabId, listTabs } from '../../tabs/tab-service'

// AI 트리거 — 브라우저가 스스로 일한다.
//  url:   지정 URL 패턴에 진입하면 작업 자동 실행(자동 로그인·정리 등)
//  daily: 매일 지정 시각에 실행(뉴스 요약 등). openUrl 을 새 탭으로 연 뒤 작업.
//  watch: 지정 URL 을 주기적으로 몰래 확인해 내용이 바뀌면 알림(+옵션으로 작업 실행)
// 재시작해도 유지(영속). 부팅 시 타이머 재무장하되, 과거분 자동 소급 실행은 하지 않는다(안전).

export type TriggerType = 'url' | 'daily' | 'watch'
export interface AgentTrigger {
  id: string
  name: string
  type: TriggerType
  enabled: boolean
  task: string
  autoConfirm: boolean
  notify: boolean
  urlPattern?: string        // url: 와일드카드(*) 매칭
  time?: string              // daily: "HH:MM"
  openUrl?: string           // daily/watch: 열거나 확인할 URL
  selector?: string          // watch: 확인할 요소(없으면 본문 전체)
  intervalMinutes?: number   // watch: 확인 주기(분)
  runOnChange?: boolean      // watch: 변경 시 작업도 실행
  lastValue?: string         // watch: 마지막 관측 해시
  lastRun?: number
  lastFiredDay?: string      // daily: 마지막 발화 날짜("Y-M-D") — 재시작해도 하루 1회 보장(+절전 catch-up)
  lastResult?: string
  createdAt: number
}

const FILE = (): string => join(app.getPath('userData'), 'ai-triggers.json')
let triggers: AgentTrigger[] = []
export const triggerEvents = new EventEmitter()
let saveTimer: NodeJS.Timeout | null = null

function persist(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      const tmp = FILE() + '.tmp'
      writeFileSync(tmp, JSON.stringify(triggers, null, 2), 'utf8')
      renameSync(tmp, FILE())
    } catch { /* ignore */ }
  }, 300)
}
function emitChanged(): void { triggerEvents.emit('changed', listTriggers()) }

function clone(t: AgentTrigger): AgentTrigger { return { ...t } }
export function listTriggers(): AgentTrigger[] { return triggers.map(clone) }

function sanitize(p: Partial<AgentTrigger>, base?: AgentTrigger): AgentTrigger {
  const type: TriggerType = (p.type === 'url' || p.type === 'daily' || p.type === 'watch') ? p.type : (base?.type ?? 'url')
  return {
    id: base?.id ?? randomUUID(),
    name: String(p.name ?? base?.name ?? '트리거').slice(0, 80),
    type,
    enabled: p.enabled != null ? !!p.enabled : (base?.enabled ?? true),
    task: String(p.task ?? base?.task ?? '').slice(0, 4000),
    autoConfirm: p.autoConfirm != null ? !!p.autoConfirm : (base?.autoConfirm ?? false),
    notify: p.notify != null ? !!p.notify : (base?.notify ?? true),
    urlPattern: p.urlPattern != null ? String(p.urlPattern).slice(0, 300) : base?.urlPattern,
    time: p.time != null ? String(p.time).slice(0, 5) : base?.time,
    openUrl: p.openUrl != null ? String(p.openUrl).slice(0, 500) : base?.openUrl,
    selector: p.selector != null ? String(p.selector).slice(0, 200) : base?.selector,
    intervalMinutes: p.intervalMinutes != null ? Math.max(1, Math.min(1440, Math.round(Number(p.intervalMinutes) || 10))) : base?.intervalMinutes,
    runOnChange: p.runOnChange != null ? !!p.runOnChange : (base?.runOnChange ?? false),
    lastValue: base?.lastValue,
    lastRun: base?.lastRun,
    lastFiredDay: base?.lastFiredDay,
    lastResult: base?.lastResult,
    createdAt: base?.createdAt ?? Date.now(),
  }
}

export function addTrigger(p: Partial<AgentTrigger>): AgentTrigger {
  const t = sanitize(p)
  triggers.push(t)
  persist(); emitChanged()
  return clone(t)
}
export function updateTrigger(id: string, p: Partial<AgentTrigger>): void {
  const i = triggers.findIndex((t) => t.id === id)
  if (i < 0) return
  triggers[i] = sanitize(p, triggers[i])
  persist(); emitChanged()
}
export function removeTrigger(id: string): void {
  triggers = triggers.filter((t) => t.id !== id)
  persist(); emitChanged()
}
export function setTriggerEnabled(id: string, on: boolean): void {
  const t = triggers.find((x) => x.id === id)
  if (t) { t.enabled = !!on; persist(); emitChanged() }
}

// ===== 매칭·유틸 =====
function urlMatch(pattern: string, url: string): boolean {
  if (!pattern) return false
  try {
    const rx = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
    return rx.test(url)
  } catch { return false }
}
function simpleHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return String(h >>> 0)
}
function notify(title: string, body: string): void {
  try { if (Notification.isSupported()) new Notification({ title, body }).show() } catch { /* ignore */ }
}
function firstWindowId(): string | null {
  const ws = getAllWindows()
  return ws[0]?.id ?? null
}
function activeHttpTab(windowId: string): string | null {
  const tabs = listTabs(windowId)
  const active = tabs.find((t) => t.active) ?? tabs[tabs.length - 1]
  if (active) { const wc = getWebContentsByTabId(active.id); if (wc && !wc.isDestroyed() && /^https?:/i.test(wc.getURL())) return active.id }
  return null
}
function waitLoad(tabId: string): Promise<void> {
  return new Promise((resolve) => {
    const wc = getWebContentsByTabId(tabId)
    if (!wc || !wc.isLoading()) { resolve(); return }
    let done = false
    const fin = (): void => { if (!done) { done = true; resolve() } }
    wc.once('did-finish-load', fin); wc.once('did-fail-load', fin)
    setTimeout(fin, 20000)
  })
}

// ===== 실행 =====
async function runTriggerTask(t: AgentTrigger, tabId: string): Promise<void> {
  const reqId = randomUUID()
  let outcome = ''
  try {
    await runAgentTask({ reqId, tabId, task: t.task }, (evt) => {
      if (evt.type === 'confirm') { if (t.autoConfirm) confirmAgentStep(reqId, true); else cancelAgentTask(reqId) }
      else if (evt.type === 'ask') cancelAgentTask(reqId)
      else if (evt.type === 'done') outcome = String(evt.message ?? '완료')
      else if (evt.type === 'error') outcome = '오류: ' + String(evt.message ?? '')
    })
  } catch (err) { outcome = '오류: ' + String(err) }
  t.lastRun = Date.now(); t.lastResult = outcome.slice(0, 200)
  persist(); emitChanged()
  if (t.notify && outcome) notify(`AI 트리거: ${t.name}`, outcome.slice(0, 220))
}

// URL 진입 트리거 — 네비게이션 훅에서 호출. 쿨다운으로 에이전트 자체 네비 루프 방지.
const urlCooldown = new Map<string, number>()
export function onNavigatedForTriggers(tabId: string, url: string): void {
  if (!/^https?:/i.test(url)) return
  for (const t of triggers) {
    if (!t.enabled || t.type !== 'url' || !t.urlPattern) continue
    if (!urlMatch(t.urlPattern, url)) continue
    const last = urlCooldown.get(t.id) ?? 0
    if (Date.now() - last < 60000) continue
    urlCooldown.set(t.id, Date.now())
    void runTriggerTask(t, tabId)
  }
}

// 매일 시각 트리거 — lastFiredDay(영속) 로 하루 1회 보장. 재시작해도 같은 날 중복 발화하지 않고,
// 절전/지연으로 정확한 분을 놓쳐도 그날 안에 시각이 지났으면 실행(catch-up).
function dailyTick(): void {
  const now = new Date()
  const cur = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
  const day = now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate()
  for (const t of triggers) {
    if (!t.enabled || t.type !== 'daily' || !t.time) continue
    if (t.lastFiredDay === day) continue
    if (cur < t.time) continue // "HH:MM" 0 패딩 문자열 비교 — 목표 시각이 아직 안 됨
    t.lastFiredDay = day
    persist()
    void runDaily(t)
  }
}
async function runDaily(t: AgentTrigger): Promise<void> {
  const wid = firstWindowId(); if (!wid) return
  let tabId: string | null
  if (t.openUrl && /^https?:/i.test(t.openUrl)) { const nt = createTab({ windowId: wid, url: t.openUrl }); tabId = nt.id; await waitLoad(tabId) }
  else tabId = activeHttpTab(wid)
  if (!tabId) return
  await runTriggerTask(t, tabId)
}

// 변경 감지 트리거 — 숨은 창으로 몰래 확인.
async function backgroundText(url: string, selector?: string): Promise<string | null> {
  let win: BrowserWindow | null = null
  // 무한 스트리밍/멈춘 페이지에서 loadURL/executeJavaScript 가 영영 settle 안 되면 숨은 창이 누수되고
  // watchTick 이 인터벌마다 새 창을 또 만들어 무한 누적된다 → 반드시 타임아웃으로 감싼다.
  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
  try {
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    await withTimeout(win.loadURL(url), 30000).catch(() => { /* 리다이렉트/타임아웃 무시 — 부분 로드로 진행 */ })
    const js = selector
      ? `(function(){var e=document.querySelector(${JSON.stringify(selector)});return e?(e.innerText||e.textContent||''):'';})()`
      : `(document.body?document.body.innerText:'')`
    const txt = await withTimeout(win.webContents.executeJavaScript(js, true), 10000)
    return String(txt ?? '').replace(/\s+/g, ' ').trim().slice(0, 20000)
  } catch { return null }
  finally { try { win?.destroy() } catch { /* ignore */ } }
}
function watchTick(): void {
  for (const t of triggers) {
    if (!t.enabled || t.type !== 'watch' || !t.openUrl) continue
    const iv = Math.max(1, t.intervalMinutes ?? 10) * 60000
    if (Date.now() - (t.lastRun ?? 0) < iv) continue
    t.lastRun = Date.now()
    void runWatch(t)
  }
}
async function runWatch(t: AgentTrigger): Promise<void> {
  const text = await backgroundText(t.openUrl ?? '', t.selector)
  if (text == null) { persist(); return }
  const hash = simpleHash(text)
  if (t.lastValue && t.lastValue !== hash) {
    if (t.notify) notify(`변경 감지: ${t.name}`, `${t.openUrl} 의 내용이 바뀌었습니다.`)
    if (t.runOnChange) {
      const wid = firstWindowId()
      if (wid) { const nt = createTab({ windowId: wid, url: t.openUrl ?? '' }); await waitLoad(nt.id); await runTriggerTask(t, nt.id) }
    }
  }
  t.lastValue = hash
  persist(); emitChanged()
}

let dailyTimer: NodeJS.Timeout | null = null
let watchTimer: NodeJS.Timeout | null = null

export function initAgentTriggers(): void {
  try {
    if (existsSync(FILE())) {
      const raw = JSON.parse(readFileSync(FILE(), 'utf8')) as AgentTrigger[]
      if (Array.isArray(raw)) triggers = raw.map((t) => sanitize(t, t))
    }
  } catch { triggers = [] }
  if (!dailyTimer) dailyTimer = setInterval(dailyTick, 30000)
  if (!watchTimer) watchTimer = setInterval(watchTick, 60000)
  // 종료 시 디바운스 대기 중이던 상태(lastValue·lastFiredDay·lastRun)를 즉시 flush — 안 그러면 재시작 후
  // watch 가 "변경됨" 을 다시 알리거나 daily 가 중복 발화한다.
  app.on('before-quit', () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    try {
      const tmp = FILE() + '.tmp'
      writeFileSync(tmp, JSON.stringify(triggers, null, 2), 'utf8')
      renameSync(tmp, FILE())
    } catch { /* ignore */ }
  })
}
