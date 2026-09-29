import { app, type WebContents } from 'electron'
import { tMain } from '../../i18n'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Macro, MacroAction, MacroSummary } from '../../../shared/types'
import { getAllWindows, windowEvents, type BrowserWindowContext } from '../../windows/window-service'
import { findTabIdByWebContentsId, getWebContentsByTabId, listTabs } from '../../tabs/tab-service'
import { captureViewport } from '../screenshot'
import { registerAction, unregisterAction, type ActionRunCtx } from '../../actions/registry'
import { getKeymap } from '../../keymap/keymap-service'

const macros = new Map<string, Macro>()
let loaded = false
let counter = 0

export const macroEvents = new EventEmitter()

function filePath(): string {
  return path.join(app.getPath('userData'), 'macros.json')
}

function nextId(): string {
  counter += 1
  return `mac-${Date.now().toString(36)}-${counter}`
}

async function ensureDir(): Promise<void> {
  await mkdir(path.dirname(filePath()), { recursive: true })
}

let persistTimer: NodeJS.Timeout | null = null
async function persist(): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(async () => {
    persistTimer = null
    await ensureDir()
    try {
      const arr = Array.from(macros.values()).sort((a, b) => a.createdAt - b.createdAt)
      await writeFile(filePath(), JSON.stringify(arr, null, 2), 'utf-8')
    } catch (err) {
      console.warn('[automation] persist failed', err)
    }
  }, 250)
}

function normalizeAction(a: Partial<MacroAction>): MacroAction | null {
  const type = a.type
  if (!type || !['navigate', 'wait', 'js', 'click', 'screenshot', 'toast'].includes(type)) return null
  return { type, value: String(a.value ?? '') }
}

const TRIGGER_TYPES = new Set(['url', 'startup', 'interval'])

function normalize(m: Partial<Macro>): Macro {
  const id = m.id ?? nextId()
  const triggerType = m.trigger?.type
  const trigger = triggerType && TRIGGER_TYPES.has(triggerType)
    ? { type: triggerType, value: String(m.trigger?.value ?? '') }
    : { type: 'shortcut' as const, value: String(m.trigger?.value ?? '') }
  const actions = (Array.isArray(m.actions) ? m.actions : [])
    .map((a) => normalizeAction(a))
    .filter((a): a is MacroAction => a !== null)
  return {
    id,
    name: String(m.name ?? '').trim() || '이름 없는 매크로',
    description: String(m.description ?? ''),
    enabled: m.enabled !== false,
    trigger,
    actions,
    createdAt: m.createdAt ?? Date.now(),
    updatedAt: m.updatedAt ?? Date.now(),
  }
}

function broadcastToast(message: string): void {
  for (const ctx of getAllWindows()) {
    ctx.chrome.webContents.send('toast:show', { message, ts: Date.now() })
  }
}

export async function initAutomation(): Promise<void> {
  if (loaded) return
  loaded = true
  await ensureDir()
  if (existsSync(filePath())) {
    try {
      const raw = await readFile(filePath(), 'utf-8')
      const data = JSON.parse(raw) as Macro[]
      if (Array.isArray(data)) {
        for (const m of data) {
          if (!m || typeof m.id !== 'string') continue
          macros.set(m.id, normalize(m))
        }
      }
    } catch (err) {
      console.warn('[automation] load failed', err)
    }
  }
  syncDynamicActions()
  attachShortcutListenerToAllWindows()
  startIntervalScheduler()
}

export function listMacros(): MacroSummary[] {
  const conflicts = detectShortcutConflicts()
  return Array.from(macros.values())
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((m) => ({
      id: m.id, name: m.name, description: m.description, enabled: m.enabled,
      trigger: m.trigger, updatedAt: m.updatedAt,
      shortcutConflict: conflicts.has(m.id),
    }))
}

export function getMacro(id: string): Macro | null {
  return macros.get(id) ?? null
}

export async function saveMacro(input: Partial<Macro>): Promise<Macro> {
  // 객체가 아닌 입력은 거부(빈 객체는 "새 매크로" 흐름이라 허용) — 임무 19 실측 근거.
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('매크로 형식이 올바르지 않습니다 — 객체여야 합니다')
  }
  const existing = input.id ? macros.get(input.id) : null
  const m = normalize({
    ...input,
    id: existing?.id ?? input.id ?? nextId(),
    createdAt: existing?.createdAt ?? input.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  })
  macros.set(m.id, m)
  await persist()
  syncDynamicActions()
  macroEvents.emit('changed', m)
  return m
}

export async function removeMacro(id: string): Promise<boolean> {
  if (!macros.has(id)) return false
  macros.delete(id)
  intervalLastRun.delete(id)
  await persist()
  syncDynamicActions()
  macroEvents.emit('changed', null)
  return true
}

export async function setMacroEnabled(id: string, enabled: boolean): Promise<boolean> {
  const m = macros.get(id)
  if (!m) return false
  m.enabled = enabled
  m.updatedAt = Date.now()
  await persist()
  syncDynamicActions()
  macroEvents.emit('changed', m)
  return true
}

// ===== 실행 엔진 =====

export interface MacroContext {
  webContents: WebContents | null
  toast: (msg: string) => void
}

function escapeJs(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')
}

async function runAction(action: MacroAction, ctx: MacroContext): Promise<void> {
  switch (action.type) {
    case 'navigate': {
      if (ctx.webContents && /^https?:|^browser:|^file:/.test(action.value)) {
        await ctx.webContents.loadURL(action.value)
      }
      return
    }
    case 'wait': {
      const ms = Math.max(0, Math.min(60_000, parseInt(action.value, 10) || 0))
      await new Promise((r) => setTimeout(r, ms))
      return
    }
    case 'js': {
      if (!ctx.webContents) return
      await ctx.webContents.executeJavaScript(`(function(){try{${action.value}}catch(e){console.error('[macro]',e)}})()`)
      return
    }
    case 'click': {
      if (!ctx.webContents) return
      const sel = escapeJs(action.value)
      await ctx.webContents.executeJavaScript(
        `(function(){var el=document.querySelector('${sel}');if(el)el.click();})()`,
      )
      return
    }
    case 'toast': {
      ctx.toast(action.value)
      return
    }
    case 'screenshot': {
      // 묶음 G: 실제 캡처를 연결한다 — features/screenshot 이 뷰포트 캡처+저장(클립보드도)까지 담당.
      // MacroContext 에 tabId 를 따로 안 두고, webContents 로 역조회해 자급자족으로 만든다
      // (호출부 전부를 건드리지 않기 위해).
      if (!ctx.webContents) { ctx.toast(tMain('main.automation.screenshotNoTab', '스크린샷 실패 — 대상 탭이 없습니다')); return }
      const found = findTabIdByWebContentsId(ctx.webContents.id)
      if (!found) { ctx.toast(tMain('main.automation.screenshotTabGone', '스크린샷 실패 — 탭을 찾을 수 없습니다')); return }
      const savedPath = await captureViewport(found.tabId)
      ctx.toast(savedPath ? tMain('main.automation.screenshotSaved', `스크린샷 저장됨 📸 (${savedPath})`, { path: savedPath }) : tMain('main.automation.screenshotFailed', '스크린샷 실패'))
      return
    }
  }
}

export async function runMacro(id: string, ctx: MacroContext): Promise<{ ok: boolean; error?: string }> {
  const m = macros.get(id)
  if (!m) return { ok: false, error: 'macro not found' }
  if (!m.enabled) return { ok: false, error: 'macro disabled' }
  try {
    for (const action of m.actions) {
      await runAction(action, ctx)
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ===== URL 트리거 =====
// onTabNavigated hook 에서 호출 — URL 패턴 매칭된 macro 실행.
//
// 묶음 G (2026-09-28): **무한 루프 방지**. 매크로 액션이 자기 트리거 URL 로(또는 같은 패턴에
// 계속 매칭되는 URL 로) navigate 하면, 그 navigate 가 다시 onTabNavigated 를 일으켜 같은
// 매크로가 또 매칭되고, 또 navigate 하고… 를 무한 반복할 수 있었다(재현 확인: 액션에
// `navigate` → 트리거 URL 자기 자신, 두 번째 tick 부터 브라우저가 사실상 멈춤).
//
// index.ts 의 호출부(`listUrlMacrosFor(url)`, 단일 인자)를 바꾸지 않고 이 함수 **안에서만**
// 두 겹으로 막는다 — 다른 lane 이 크게 손댈 index.ts 를 건드리지 않기 위함:
//  ① 매크로별 쿨다운(10초) — 매칭되는 즉시(호출 시점에) 기록해, 같은 tick 다중 매칭도 1회로 억제.
//  ② 전역 발화 속도 제한(5초 창에 20회) — 서로 다른 매크로들이 사슬처럼 연쇄 발동하는 것도 차단.
const URL_TRIGGER_COOLDOWN_MS = 10_000
const lastFiredAt = new Map<string, number>()

const GLOBAL_URL_FIRE_LIMIT = 20
const GLOBAL_URL_FIRE_WINDOW_MS = 5_000
let recentFireTimestamps: number[] = []

function globalRateLimitOk(now: number): boolean {
  recentFireTimestamps = recentFireTimestamps.filter((t) => now - t < GLOBAL_URL_FIRE_WINDOW_MS)
  if (recentFireTimestamps.length >= GLOBAL_URL_FIRE_LIMIT) return false
  recentFireTimestamps.push(now)
  return true
}

export function listUrlMacrosFor(url: string): Macro[] {
  const out: Macro[] = []
  const now = Date.now()
  for (const m of macros.values()) {
    if (!m.enabled) continue
    if (m.trigger.type !== 'url') continue
    if (!m.trigger.value) continue
    try {
      const re = new RegExp(
        '^' + m.trigger.value.split('*').map(escapeRegex).join('.*') + '$',
        'i',
      )
      if (!re.test(url)) continue
    } catch { continue } // invalid pattern
    const last = lastFiredAt.get(m.id) ?? 0
    if (now - last < URL_TRIGGER_COOLDOWN_MS) continue
    if (!globalRateLimitOk(now)) {
      console.warn('[automation] URL 트리거 매크로 발동 속도 제한 초과 — 연쇄 발동 방지를 위해 이번 tick 중단')
      break
    }
    lastFiredAt.set(m.id, now)
    out.push(m)
  }
  return out
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

export function listStartupMacros(): Macro[] {
  return Array.from(macros.values()).filter((m) => m.enabled && m.trigger.type === 'startup')
}

export function listShortcutMacros(): Macro[] {
  return Array.from(macros.values()).filter((m) => m.enabled && m.trigger.type === 'shortcut')
}

// ===== 단축키 트리거 =====
// 묶음 G (2026-09-28): 예전엔 listShortcutMacros() 를 아무도 호출하지 않아 "단축키" 트리거가
// 완전히 무동작이었다(팔레트로만 수동 실행 가능). 여기서는 index.ts 를 건드리지 않고
// windowEvents(모듈 간 공용 EventEmitter) 를 직접 구독해 각 창의 chrome webContents 에
// before-input-event 리스너를 독립적으로 붙인다 — index.ts 의 attachAcceleratorsToWindow 와
// 완전히 분리된, automation 모듈 자급자족 경로.

function matchesAccelerator(accel: string, input: Electron.Input): boolean {
  const parts = accel.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean)
  if (parts.length === 0) return false
  const wantCtrl = parts.includes('ctrl') || parts.includes('cmdorctrl')
  const wantShift = parts.includes('shift')
  const wantAlt = parts.includes('alt')
  const wantMeta = parts.includes('cmd') || parts.includes('meta') || parts.includes('super')
  const key = parts[parts.length - 1] ?? ''
  if (input.control !== wantCtrl) return false
  if (input.shift !== wantShift) return false
  if (input.alt !== wantAlt) return false
  if (input.meta !== wantMeta) return false
  return input.key.toLowerCase() === key
}

/** "Ctrl+Shift+K" 형태로 보이는지 최소 검증 — modifier 최소 1개 + key 1개. 키맵 형식과 동일 규약. */
function looksLikeAccelerator(value: string): boolean {
  const parts = value.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return false
  const known = new Set(['ctrl', 'cmdorctrl', 'shift', 'alt', 'cmd', 'meta', 'super'])
  const hasModifier = parts.slice(0, -1).every((p) => known.has(p.toLowerCase()))
  const key = parts[parts.length - 1]
  return hasModifier && !!key && !known.has(key.toLowerCase())
}

const attachedWindows = new WeakSet<BrowserWindowContext>()

function attachShortcutListener(ctx: BrowserWindowContext): void {
  if (attachedWindows.has(ctx)) return
  attachedWindows.add(ctx)
  ctx.chrome.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if ((input as { isComposing?: boolean }).isComposing) return
    for (const m of macros.values()) {
      if (!m.enabled || m.trigger.type !== 'shortcut' || !m.trigger.value) continue
      if (!matchesAccelerator(m.trigger.value, input)) continue
      event.preventDefault()
      const t = listTabs(ctx.id).find((x) => x.active)
      const wc = t ? getWebContentsByTabId(t.id) : null
      void runMacro(m.id, {
        webContents: wc,
        toast: (msg) => ctx.chrome.webContents.send('toast:show', { message: msg, ts: Date.now() }),
      })
      return
    }
  })
}

function attachShortcutListenerToAllWindows(): void {
  for (const ctx of getAllWindows()) attachShortcutListener(ctx)
  windowEvents.on('created', (ctx: BrowserWindowContext) => attachShortcutListener(ctx))
}

/**
 * 단축키 트리거 매크로 사이의, 그리고 시스템 키맵과의 충돌을 찾는다.
 * (index.ts 의 attachAcceleratorsToWindow 를 못 건드리므로 별도 리스너로 처리하고 있어,
 *  keymap-service 의 findConflicts() 는 이 매크로 단축키를 모른다 — 여기서 자체 계산해
 *  macro 목록 UI 에 경고 배지로 보여준다.)
 */
function detectShortcutConflicts(): Set<string> {
  const conflicted = new Set<string>()
  const byKey = new Map<string, string[]>() // normalized accel -> macroIds
  const normalize = (v: string) => v.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean).join('+')

  const shortcutMacros = Array.from(macros.values()).filter((m) => m.enabled && m.trigger.type === 'shortcut' && m.trigger.value)
  for (const m of shortcutMacros) {
    const key = normalize(m.trigger.value)
    const arr = byKey.get(key) ?? []
    arr.push(m.id)
    byKey.set(key, arr)
  }
  for (const arr of byKey.values()) {
    if (arr.length > 1) for (const id of arr) conflicted.add(id)
  }

  // 시스템 키맵(전역 바인딩)과도 겹치는지 확인
  let systemKeys: Set<string>
  try {
    systemKeys = new Set(getKeymap().bindings.filter((b) => b.when === 'global').map((b) => normalize(b.key)))
  } catch {
    systemKeys = new Set()
  }
  for (const m of shortcutMacros) {
    if (systemKeys.has(normalize(m.trigger.value))) conflicted.add(m.id)
  }
  return conflicted
}

// ===== 명령 팔레트/키맵 편집 화면 노출용 동적 액션 =====
// 묶음 G: 단축키 트리거 매크로는 actionId 를 갖게 해(CLAUDE.md 자유도 원칙과 일관) 팔레트에서도
// 실행 가능하게 한다(사이드바의 @ 매크로 항목과는 별개 — 이건 단축키 배선이 실제로 있다는 증거).
const registeredDynamicActionIds = new Set<string>()

function actionIdFor(macroId: string): string {
  return `action.macros.run.${macroId}`
}

function syncDynamicActions(): void {
  const wanted = new Set<string>()
  for (const m of macros.values()) {
    if (!m.enabled || m.trigger.type !== 'shortcut' || !looksLikeAccelerator(m.trigger.value)) continue
    const actionId = actionIdFor(m.id)
    wanted.add(actionId)
    registerAction({
      id: actionId,
      category: 'macro',
      labelKey: 'action.macros.run',
      when: 'global',
      run: async (ctx: ActionRunCtx) => {
        const tabId = ctx.tabId ?? (ctx.windowId ? listTabs(ctx.windowId).find((x) => x.active)?.id : undefined)
        const wc = tabId ? getWebContentsByTabId(tabId) : null
        await runMacro(m.id, { webContents: wc, toast: (msg) => broadcastToast(msg) })
      },
    })
  }
  for (const id of registeredDynamicActionIds) {
    if (!wanted.has(id)) unregisterAction(id)
  }
  registeredDynamicActionIds.clear()
  for (const id of wanted) registeredDynamicActionIds.add(id)
}

// ===== 시간(분 단위) 트리거 =====
// 묶음 G 보너스: interval 트리거 — "N분마다" 실행. 최소 1분(0 이하·미입력 시 1분으로 clamp),
// 15초 간격으로 확인(분 단위 트리거이므로 이 정도 해상도면 충분).
const INTERVAL_MIN_MINUTES = 1
const INTERVAL_POLL_MS = 15_000
const intervalLastRun = new Map<string, number>()
let intervalTimer: NodeJS.Timeout | null = null

function startIntervalScheduler(): void {
  if (intervalTimer) return
  intervalTimer = setInterval(() => {
    const now = Date.now()
    for (const m of macros.values()) {
      if (!m.enabled || m.trigger.type !== 'interval') continue
      const minutes = Math.max(INTERVAL_MIN_MINUTES, parseInt(m.trigger.value, 10) || INTERVAL_MIN_MINUTES)
      const last = intervalLastRun.get(m.id) ?? 0
      if (now - last < minutes * 60_000) continue
      intervalLastRun.set(m.id, now)
      void runMacro(m.id, { webContents: null, toast: (msg) => broadcastToast(msg) })
    }
  }, INTERVAL_POLL_MS)
  // 앱 종료를 막지 않도록 — Node 타이머가 이벤트 루프를 붙잡아 종료가 늦어지는 것 방지.
  intervalTimer.unref?.()
}
