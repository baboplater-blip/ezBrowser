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

/**
 * 사용자가 선등록 폼에 적은 주소 → 저장용 origin.
 * `example.com` 처럼 스킴이 없으면 https 로 보강하고, **https 가 아니면 거부**한다.
 * (평문 http 로는 비밀번호를 내보내지 않는다 — 다운그레이드 차단의 출발점.)
 * 포트·호스트는 그대로 보존한다. `https://a.example.com` 과 `https://example.com` 은 서로 다른 origin 이며,
 * 자동 로그인은 **정확히 일치**할 때만 동작한다(서브도메인·유사문자 도메인에 비밀을 넘기지 않기 위해).
 */
export function normalizeHttpsOrigin(input: string): string | null {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let u: URL
  try { u = new URL(withScheme) } catch { return null }
  if (u.protocol !== 'https:') return null
  if (!u.hostname) return null
  return `https://${u.host}`
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
        // ===== 마이그레이션 =====
        // 예전 항목에는 자동 로그인 관련 필드가 없다. **없으면 무조건 꺼진 것**으로 정규화한다.
        // (값이 없을 때 "허용"으로 읽히는 실수를 원천 차단 — 저장돼 있다는 이유로 자동 로그인이
        //  켜지면 사용자가 켠 적 없는 권한이 생긴다.)
        e.autoLoginAllowed = e.autoLoginAllowed === true
        e.preferred = e.preferred === true
        e.autoLoginFailures = typeof e.autoLoginFailures === 'number' && e.autoLoginFailures > 0
          ? Math.floor(e.autoLoginFailures) : 0
        e.autoLoginBlockedUntil = typeof e.autoLoginBlockedUntil === 'number' && e.autoLoginBlockedUntil > 0
          ? Math.floor(e.autoLoginBlockedUntil) : 0
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
  return {
    id: e.id,
    origin: e.origin,
    username: e.username,
    updatedAt: e.updatedAt,
    autoLoginAllowed: e.autoLoginAllowed === true,
    preferred: e.preferred === true,
    scheme: e.origin.startsWith('https:') ? 'https' : 'http',
    autoLoginFailures: e.autoLoginFailures ?? 0,
    autoLoginBlockedUntil: e.autoLoginBlockedUntil ?? 0,
  }
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

// ===== 선등록(사용자가 설정에서 직접 추가/수정) =====
//
// 규칙:
//   · https origin 만. 평문 http 에는 비밀번호를 저장하지도, 보내지도 않는다.
//   · safeStorage 로 암호화할 수 없으면 **저장하지 않는다**(평문 폴백 없음). 실패로 알린다.
//   · 자동 로그인 허용(autoLoginAllowed)은 호출자가 명시로 넘길 때만 켜진다. 기본은 꺼짐.

export type PasswordWriteReason = 'unavailable' | 'invalid-origin' | 'invalid' | 'duplicate' | 'not-found'

export interface PasswordWriteResult {
  ok: boolean
  id?: string
  reason?: PasswordWriteReason
  message?: string
}

const WRITE_MESSAGE: Record<PasswordWriteReason, string> = {
  unavailable: '이 컴퓨터에서 OS 암호화(safeStorage)를 쓸 수 없어 비밀번호를 저장하지 않았습니다. 평문으로는 저장하지 않습니다.',
  'invalid-origin': '사이트 주소가 올바르지 않습니다. https 주소여야 합니다 (예: https://example.com).',
  invalid: '사용자명과 비밀번호를 모두 입력해 주세요.',
  duplicate: '같은 사이트에 같은 사용자명이 이미 등록돼 있습니다. 기존 항목을 수정해 주세요.',
  'not-found': '해당 계정을 찾을 수 없습니다.',
}

function fail(reason: PasswordWriteReason): PasswordWriteResult {
  return { ok: false, reason, message: WRITE_MESSAGE[reason] }
}

function findByOriginUser(origin: string, username: string): PasswordEntry | undefined {
  return Array.from(passwords.values()).find((e) => e.origin === origin && e.username === username)
}

export function addPassword(args: {
  origin: string
  username: string
  password: string
  autoLoginAllowed?: boolean
}): PasswordWriteResult {
  const origin = normalizeHttpsOrigin(args.origin)
  if (!origin) return fail('invalid-origin')
  const username = String(args.username ?? '').trim()
  const password = String(args.password ?? '')
  if (!username || !password) return fail('invalid')
  if (!isPasswordStorageAvailable()) return fail('unavailable')
  if (findByOriginUser(origin, username)) return fail('duplicate')
  const encoded = encrypt(password)
  if (encoded === null) return fail('unavailable')

  const now = Date.now()
  const e: PasswordEntry = {
    id: nextId(),
    origin,
    username,
    encryptedPassword: encoded,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: 0,
    autoLoginAllowed: args.autoLoginAllowed === true,
    preferred: false,
    autoLoginFailures: 0,
    autoLoginBlockedUntil: 0,
  }
  passwords.set(e.id, e)
  // 기본 계정(preferred)을 자동으로 켜지 않는다. 허용 계정이 하나뿐이면 애초에 모호하지 않아 필요 없고,
  // 자동으로 켜 두면 나중에 둘째 계정이 생겼을 때 **사용자가 고른 적 없는 계정**이 조용히 쓰인다.
  persist()
  passwordEvents.emit('changed')
  return { ok: true, id: e.id }
}

export function updatePassword(args: {
  id: string
  username?: string
  password?: string
  autoLoginAllowed?: boolean
  preferred?: boolean
}): PasswordWriteResult {
  const e = passwords.get(String(args.id ?? ''))
  if (!e) return fail('not-found')

  if (args.username !== undefined) {
    const username = String(args.username).trim()
    if (!username) return fail('invalid')
    const dup = findByOriginUser(e.origin, username)
    if (dup && dup.id !== e.id) return fail('duplicate')
    e.username = username
  }

  if (args.password !== undefined) {
    const password = String(args.password)
    if (!password) return fail('invalid')
    if (!isPasswordStorageAvailable()) return fail('unavailable')
    const encoded = encrypt(password)
    if (encoded === null) return fail('unavailable')
    e.encryptedPassword = encoded
    // 비밀번호를 고쳤다 = "틀린 비밀번호" 잠금의 원인이 사라졌을 수 있다 → 잠금 해제하고 다시 시도하게 한다.
    e.autoLoginFailures = 0
    e.autoLoginBlockedUntil = 0
  }

  if (args.autoLoginAllowed !== undefined) {
    const on = args.autoLoginAllowed === true
    // http 항목은 켤 수 없다(저장은 과거에 됐을 수 있으나 자동 로그인 대상이 아니다).
    e.autoLoginAllowed = on && e.origin.startsWith('https:')
    if (!e.autoLoginAllowed) e.preferred = false
  }

  if (args.preferred === false) {
    e.preferred = false
  } else if (args.preferred === true) {
    if (!e.autoLoginAllowed) return fail('invalid')
    // 기본 계정은 origin 당 하나 — 형제들의 표시를 내린다.
    for (const other of passwords.values()) {
      if (other.origin === e.origin && other.id !== e.id) other.preferred = false
    }
    e.preferred = true
  }

  e.updatedAt = Date.now()
  persist()
  passwordEvents.emit('changed')
  return { ok: true, id: e.id }
}

// ===== 자동화 로그인용 조회 =====

/** 잠금 만료 시각까지 남았는가. */
export function isAutoLoginBlocked(e: PasswordEntry): boolean {
  return (e.autoLoginBlockedUntil ?? 0) > Date.now()
}

/**
 * 이 origin 에서 **자동 로그인이 허용된** 계정들. 정확히 일치하는 origin 만 — 서브도메인·다른 포트·http 는
 * 절대 매칭되지 않는다(비밀을 유사 도메인에 넘기지 않기 위한 핵심 경계).
 */
export function autoLoginEntriesFor(origin: string): PasswordEntry[] {
  if (!origin.startsWith('https:')) return []
  return Array.from(passwords.values())
    .filter((e) => e.origin === origin && e.autoLoginAllowed === true)
    .sort((a, b) => (b.preferred === true ? 1 : 0) - (a.preferred === true ? 1 : 0)
      || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
}

/** 이 origin 에 저장돼 있으나 자동 로그인이 꺼진 계정 수 — "등록은 했는데 허용을 안 켰다" 를 구분해 안내한다. */
export function savedButNotAllowedCount(origin: string): number {
  return Array.from(passwords.values())
    .filter((e) => e.origin === origin && e.autoLoginAllowed !== true).length
}

export function getEntryById(id: string): PasswordEntry | undefined {
  return passwords.get(id)
}

/** 자동 로그인에 쓸 평문. 이 값은 호출자(auto-login)의 지역 변수 밖으로 절대 나가면 안 된다. */
export function secretForAutoLogin(id: string): string | null {
  const e = passwords.get(id)
  if (!e || e.autoLoginAllowed !== true) return null
  if (isAutoLoginBlocked(e)) return null
  return decrypt(e.encryptedPassword)
}

export const MAX_AUTO_LOGIN_FAILURES = 3
const AUTO_LOGIN_BLOCK_MS = 30 * 60_000

/**
 * 로그인 실패 기록. 상한에 닿으면 잠근다 — **디스크에 남으므로 구간 경계·작업 재개·앱 재시작을 넘어 유지된다.**
 * (계정 잠금은 되돌리기 어려운 피해다. 무한 재시도는 그 자체가 사고다.)
 */
export function noteAutoLoginFailure(id: string): { failures: number; blocked: boolean } {
  const e = passwords.get(id)
  if (!e) return { failures: 0, blocked: false }
  e.autoLoginFailures = (e.autoLoginFailures ?? 0) + 1
  const blocked = e.autoLoginFailures >= MAX_AUTO_LOGIN_FAILURES
  if (blocked) e.autoLoginBlockedUntil = Date.now() + AUTO_LOGIN_BLOCK_MS
  persist()
  passwordEvents.emit('changed')
  return { failures: e.autoLoginFailures, blocked }
}

export function clearAutoLoginFailures(id: string): void {
  const e = passwords.get(id)
  if (!e) return
  if ((e.autoLoginFailures ?? 0) === 0 && (e.autoLoginBlockedUntil ?? 0) === 0) return
  e.autoLoginFailures = 0
  e.autoLoginBlockedUntil = 0
  persist()
  passwordEvents.emit('changed')
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
