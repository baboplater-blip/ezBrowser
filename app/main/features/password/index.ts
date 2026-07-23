import { app, safeStorage } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PasswordEntry, PasswordSummary } from '../../../shared/types'

const passwords = new Map<string, PasswordEntry>()
let loaded = false
let counter = 0

export const passwordEvents = new EventEmitter()

function filePath(): string {
  return path.join(app.getPath('userData'), 'passwords.json')
}

function nextId(): string {
  counter += 1
  return `pwd-${Date.now().toString(36)}-${counter}`
}

export function isPasswordStorageAvailable(): boolean {
  try { return safeStorage.isEncryptionAvailable() } catch { return false }
}

// ===== origin 정규화 =====

export function normalizeOrigin(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

// ===== 저장소 =====

async function ensureDir(): Promise<void> {
  await mkdir(path.dirname(filePath()), { recursive: true })
}

async function loadAll(): Promise<void> {
  if (loaded) return
  loaded = true
  await ensureDir()
  if (!existsSync(filePath())) return
  try {
    const raw = await readFile(filePath(), 'utf-8')
    const arr = JSON.parse(raw) as PasswordEntry[]
    if (Array.isArray(arr)) {
      for (const e of arr) {
        if (!e || typeof e.id !== 'string') continue
        passwords.set(e.id, e)
      }
    }
  } catch (err) {
    console.warn('[password] load failed', err)
  }
}

let persistTimer: NodeJS.Timeout | null = null
function persist(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(async () => {
    persistTimer = null
    await ensureDir()
    try {
      const arr = Array.from(passwords.values())
      await writeFile(filePath(), JSON.stringify(arr, null, 2), 'utf-8')
    } catch (err) {
      console.warn('[password] persist failed', err)
    }
  }, 250)
}

// ===== Init =====

export async function initPasswords(): Promise<void> {
  await loadAll()
  if (!isPasswordStorageAvailable()) {
    console.warn('[password] safeStorage not available — entries can be loaded but new saves will fail')
  }
}

// ===== Encrypt/Decrypt =====

function encrypt(plain: string): string | null {
  if (!isPasswordStorageAvailable()) return null
  try {
    const buf = safeStorage.encryptString(plain)
    return buf.toString('base64')
  } catch (err) {
    console.warn('[password] encrypt failed', err)
    return null
  }
}

function decrypt(b64: string): string | null {
  if (!isPasswordStorageAvailable()) return null
  try {
    const buf = Buffer.from(b64, 'base64')
    return safeStorage.decryptString(buf)
  } catch (err) {
    console.warn('[password] decrypt failed', err)
    return null
  }
}

// ===== CRUD =====

function summarize(e: PasswordEntry): PasswordSummary {
  return { id: e.id, origin: e.origin, username: e.username, updatedAt: e.updatedAt }
}

export function listPasswords(): PasswordSummary[] {
  return Array.from(passwords.values())
    .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username))
    .map(summarize)
}

export function lookupForOrigin(origin: string): Array<{ id: string; username: string; password: string }> {
  const out: Array<{ id: string; username: string; password: string }> = []
  for (const e of passwords.values()) {
    if (e.origin !== origin) continue
    const plain = decrypt(e.encryptedPassword)
    if (plain === null) continue
    out.push({ id: e.id, username: e.username, password: plain })
  }
  // 가장 최근 사용 우선
  return out.sort((a, b) => {
    const ea = passwords.get(a.id)
    const eb = passwords.get(b.id)
    return (eb?.lastUsedAt ?? 0) - (ea?.lastUsedAt ?? 0)
  })
}

export function revealPassword(id: string): string | null {
  const e = passwords.get(id)
  if (!e) return null
  return decrypt(e.encryptedPassword)
}

// ===== 사용자 확인 대기 큐 (silent 자동 저장 → prompt) =====

export interface PendingProposal {
  promptId: string
  origin: string
  username: string
  password: string
  isUpdate: boolean
  proposedAt: number
}

const pendingProposals = new Map<string, PendingProposal>()
let promptCounter = 0

function nextPromptId(): string {
  promptCounter += 1
  return `pwprompt-${Date.now().toString(36)}-${promptCounter}`
}

const neverOrigins = new Set<string>()

/**
 * content.js 가 form submit 감지 시 호출.
 * 결과:
 * - `unchanged`: 기존 항목과 동일 → 즉시 lastUsedAt 갱신만, prompt 없음
 * - `unavailable`/`invalid`: prompt 없음
 * - `prompt`: 외피에 사용자 확인 배너 요청, 응답을 기다림
 */
export function proposeSave(args: { origin: string; username: string; password: string }): {
  status: 'prompt' | 'unchanged' | 'unavailable' | 'invalid' | 'never'
  promptId?: string
  isUpdate?: boolean
} {
  const origin = normalizeOrigin(args.origin)
  if (!origin) return { status: 'invalid' }
  if (!args.username || !args.password) return { status: 'invalid' }
  if (!isPasswordStorageAvailable()) return { status: 'unavailable' }
  if (neverOrigins.has(origin)) return { status: 'never' }

  const existing = Array.from(passwords.values())
    .find((e) => e.origin === origin && e.username === args.username)

  if (existing) {
    const oldPlain = decrypt(existing.encryptedPassword)
    if (oldPlain === args.password) {
      existing.lastUsedAt = Date.now()
      persist()
      return { status: 'unchanged' }
    }
  }

  const promptId = nextPromptId()
  pendingProposals.set(promptId, {
    promptId,
    origin,
    username: args.username,
    password: args.password,
    isUpdate: !!existing,
    proposedAt: Date.now(),
  })
  passwordEvents.emit('prompt', pendingProposals.get(promptId))
  return { status: 'prompt', promptId, isUpdate: !!existing }
}

export type ConfirmAction = 'save' | 'discard' | 'never'

export function confirmSave(promptId: string, action: ConfirmAction): {
  status: 'saved' | 'updated' | 'discarded' | 'never' | 'unknown' | 'unavailable'
  id?: string
} {
  const p = pendingProposals.get(promptId)
  if (!p) return { status: 'unknown' }
  pendingProposals.delete(promptId)
  passwordEvents.emit('prompt-resolved', promptId)

  if (action === 'discard') return { status: 'discarded' }
  if (action === 'never') {
    neverOrigins.add(p.origin)
    return { status: 'never' }
  }

  if (!isPasswordStorageAvailable()) return { status: 'unavailable' }
  const encoded = encrypt(p.password)
  if (encoded === null) return { status: 'unavailable' }

  const existing = Array.from(passwords.values())
    .find((e) => e.origin === p.origin && e.username === p.username)

  if (existing) {
    existing.encryptedPassword = encoded
    existing.updatedAt = Date.now()
    existing.lastUsedAt = Date.now()
    persist()
    passwordEvents.emit('changed')
    return { status: 'updated', id: existing.id }
  }

  const e: PasswordEntry = {
    id: nextId(),
    origin: p.origin,
    username: p.username,
    encryptedPassword: encoded,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastUsedAt: Date.now(),
  }
  passwords.set(e.id, e)
  persist()
  passwordEvents.emit('changed')
  return { status: 'saved', id: e.id }
}

export function listPendingProposals(): PendingProposal[] {
  return Array.from(pendingProposals.values())
}

export function markUsed(id: string): void {
  const e = passwords.get(id)
  if (!e) return
  e.lastUsedAt = Date.now()
  persist()
}

export function removePassword(id: string): void {
  if (passwords.delete(id)) {
    persist()
    passwordEvents.emit('changed')
  }
}
