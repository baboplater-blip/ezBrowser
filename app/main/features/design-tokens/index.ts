import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { TokenOverrides } from '../../../shared/types'

// 사용자가 수정 가능한 토큰 화이트리스트.
// CSS 변수 이름은 build/gen-tokens.mjs 의 규칙과 동일 — '.' → '-'.
export const EDITABLE_TOKENS: ReadonlyArray<{
  key: string
  cssVar: string
  label: string
  type: 'color' | 'size' | 'duration' | 'text'
  defaultValue: string
}> = [
  { key: 'color.accent.primary', cssVar: '--color-accent-primary', label: '액센트', type: 'color', defaultValue: '#3478F6' },
  { key: 'color.accent.hover', cssVar: '--color-accent-hover', label: '액센트 호버', type: 'color', defaultValue: '#2C66D6' },
  { key: 'color.bg.base', cssVar: '--color-bg-base', label: '배경', type: 'color', defaultValue: '#F7F7F8' },
  { key: 'color.bg.elevated', cssVar: '--color-bg-elevated', label: '카드 배경', type: 'color', defaultValue: '#FFFFFF' },
  { key: 'color.text.primary', cssVar: '--color-text-primary', label: '본문', type: 'color', defaultValue: '#1A1A1A' },
  { key: 'color.text.secondary', cssVar: '--color-text-secondary', label: '보조 글자', type: 'color', defaultValue: '#5F5F66' },
  { key: 'color.border.subtle', cssVar: '--color-border-subtle', label: '경계선', type: 'color', defaultValue: '#E5E5E8' },
  { key: 'radius.sm', cssVar: '--radius-sm', label: '작은 라운드', type: 'size', defaultValue: '4px' },
  { key: 'radius.md', cssVar: '--radius-md', label: '중간 라운드', type: 'size', defaultValue: '8px' },
  { key: 'radius.lg', cssVar: '--radius-lg', label: '큰 라운드', type: 'size', defaultValue: '12px' },
  { key: 'radius.tab', cssVar: '--radius-tab', label: '탭 라운드', type: 'size', defaultValue: '8px' },
  { key: 'density.tabbar-h', cssVar: '--density-tabbar-h', label: '탭바 높이', type: 'size', defaultValue: '36px' },
  { key: 'density.toolbar-h', cssVar: '--density-toolbar-h', label: '툴바 높이', type: 'size', defaultValue: '36px' },
  { key: 'density.font-size', cssVar: '--density-font-size', label: '기본 글자 크기', type: 'size', defaultValue: '13px' },
  { key: 'motion.normal', cssVar: '--motion-normal', label: '애니메이션 속도', type: 'duration', defaultValue: '180ms' },
]

const cssVarByKey = new Map(EDITABLE_TOKENS.map((t) => [t.key, t.cssVar]))
const defaultByKey = new Map(EDITABLE_TOKENS.map((t) => [t.key, t.defaultValue]))
const editableKeys = new Set(EDITABLE_TOKENS.map((t) => t.key))

let overrides: TokenOverrides = {}
let loaded = false

export const tokenEvents = new EventEmitter()

function filePath(): string {
  return path.join(app.getPath('userData'), 'user-tokens.json')
}

async function ensureDir(): Promise<void> {
  await mkdir(path.dirname(filePath()), { recursive: true })
}

async function persist(): Promise<void> {
  await ensureDir()
  try {
    await writeFile(filePath(), JSON.stringify(overrides, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[design-tokens] persist failed', err)
  }
}

function sanitizeValue(key: string, raw: string): string {
  const v = String(raw ?? '').trim()
  if (!v) return ''
  const meta = EDITABLE_TOKENS.find((t) => t.key === key)
  if (!meta) return ''
  if (meta.type === 'color') {
    if (/^#[0-9a-f]{3,8}$/i.test(v)) return v
    if (/^rgba?\([0-9.,\s%]+\)$/i.test(v)) return v
    if (/^hsla?\([0-9.,\s%]+\)$/i.test(v)) return v
    return ''
  }
  if (meta.type === 'size') {
    if (/^-?\d+(\.\d+)?(px|rem|em|%)$/.test(v)) return v
    return ''
  }
  if (meta.type === 'duration') {
    if (/^\d+(\.\d+)?(ms|s)$/.test(v)) return v
    return ''
  }
  return v.slice(0, 100)
}

export async function initDesignTokens(): Promise<void> {
  if (loaded) return
  loaded = true
  await ensureDir()
  if (!existsSync(filePath())) return
  try {
    const raw = await readFile(filePath(), 'utf-8')
    const parsed = JSON.parse(raw) as TokenOverrides
    overrides = {}
    for (const [k, v] of Object.entries(parsed ?? {})) {
      if (!editableKeys.has(k)) continue
      const clean = sanitizeValue(k, v)
      if (clean) overrides[k] = clean
    }
  } catch (err) {
    console.warn('[design-tokens] load failed', err)
  }
}

export function getOverrides(): TokenOverrides {
  return { ...overrides }
}

export function getOverridesAsCssVars(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(overrides)) {
    const cssVar = cssVarByKey.get(k)
    if (cssVar) out[cssVar] = v
  }
  return out
}

export async function setOverride(key: string, value: string): Promise<boolean> {
  if (!editableKeys.has(key)) return false
  const clean = sanitizeValue(key, value)
  if (!clean) {
    if (overrides[key]) {
      delete overrides[key]
      await persist()
      tokenEvents.emit('changed', getOverrides())
    }
    return true
  }
  if (overrides[key] === clean) return true
  overrides[key] = clean
  await persist()
  tokenEvents.emit('changed', getOverrides())
  return true
}

export async function resetTokens(): Promise<void> {
  overrides = {}
  await persist()
  tokenEvents.emit('changed', getOverrides())
}

export function listEditableTokens(): typeof EDITABLE_TOKENS {
  return EDITABLE_TOKENS
}

export function defaultsAsCssVars(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of defaultByKey) {
    const cssVar = cssVarByKey.get(k)
    if (cssVar) out[cssVar] = v
  }
  return out
}
