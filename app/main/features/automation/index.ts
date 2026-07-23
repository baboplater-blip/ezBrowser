import { app, type WebContents } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Macro, MacroAction, MacroSummary } from '../../../shared/types'

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

function normalize(m: Partial<Macro>): Macro {
  const id = m.id ?? nextId()
  const triggerType = m.trigger?.type
  const trigger = triggerType === 'url' || triggerType === 'startup'
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

export async function initAutomation(): Promise<void> {
  if (loaded) return
  loaded = true
  await ensureDir()
  if (!existsSync(filePath())) return
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

export function listMacros(): MacroSummary[] {
  return Array.from(macros.values())
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((m) => ({
      id: m.id, name: m.name, description: m.description, enabled: m.enabled,
      trigger: m.trigger, updatedAt: m.updatedAt,
    }))
}

export function getMacro(id: string): Macro | null {
  return macros.get(id) ?? null
}

export async function saveMacro(input: Partial<Macro>): Promise<Macro> {
  const existing = input.id ? macros.get(input.id) : null
  const m = normalize({
    ...input,
    id: existing?.id ?? input.id ?? nextId(),
    createdAt: existing?.createdAt ?? input.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  })
  macros.set(m.id, m)
  await persist()
  macroEvents.emit('changed', m)
  return m
}

export async function removeMacro(id: string): Promise<boolean> {
  if (!macros.has(id)) return false
  macros.delete(id)
  await persist()
  macroEvents.emit('changed', null)
  return true
}

export async function setMacroEnabled(id: string, enabled: boolean): Promise<boolean> {
  const m = macros.get(id)
  if (!m) return false
  m.enabled = enabled
  m.updatedAt = Date.now()
  await persist()
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
      // 실제 캡처는 features/screenshot 모듈이 담당 — 매크로에서는 트리거만, 후속 작업은 다음 라운드
      ctx.toast('스크린샷 액션은 다음 라운드')
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

export function listUrlMacrosFor(url: string): Macro[] {
  const out: Macro[] = []
  for (const m of macros.values()) {
    if (!m.enabled) continue
    if (m.trigger.type !== 'url') continue
    if (!m.trigger.value) continue
    try {
      const re = new RegExp(
        '^' + m.trigger.value.split('*').map(escapeRegex).join('.*') + '$',
        'i',
      )
      if (re.test(url)) out.push(m)
    } catch { /* invalid pattern */ }
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
