import { app, safeStorage } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'

// API 키는 aside 의 "자격증명은 노출되지 않는다" 정신 그대로 — 평문으로 settings.json 에 두지 않고
// OS 암호화(safeStorage: Windows DPAPI / macOS Keychain / Linux libsecret)로 저장한다.
// 비밀번호 매니저(features/password)와 동일한 보안 모델.

export type AiSecretProvider = 'anthropic' | 'openai' | 'google'

const cipherByProvider = new Map<AiSecretProvider, string>() // base64 ciphertext
let loaded = false

function filePath(): string {
  return path.join(app.getPath('userData'), 'ai-keys.json')
}

export function isKeyStorageAvailable(): boolean {
  try { return safeStorage.isEncryptionAvailable() } catch { return false }
}

async function ensureLoaded(): Promise<boolean> {
  if (loaded) return true
  if (!existsSync(filePath())) { loaded = true; return true }
  try {
    const raw = await readFile(filePath(), 'utf-8')
    const obj = JSON.parse(raw) as Record<string, string>
    for (const p of ['anthropic', 'openai', 'google'] as const) {
      if (typeof obj[p] === 'string') cipherByProvider.set(p, obj[p] as string)
    }
    loaded = true
    return true
  } catch (err) {
    // loaded 를 true 로 올리지 않고 false 를 반환한다 — 일시적 read 실패(AV/EBUSY) 후 setAiKey 가 빈 맵을
    // persist 해서 다른 제공자 키를 영구 소실시키는 것을 막는다(호출자는 실패 시 persist 금지). 다음 접근에서 재시도.
    console.warn('[ai] key load failed', err)
    return false
  }
}

async function persist(): Promise<void> {
  try {
    await mkdir(path.dirname(filePath()), { recursive: true })
    const obj: Record<string, string> = {}
    for (const [p, c] of cipherByProvider) obj[p] = c
    const tmp = filePath() + '.tmp'
    await writeFile(tmp, JSON.stringify(obj), 'utf-8')
    await rename(tmp, filePath())
  } catch (err) {
    console.warn('[ai] key persist failed', err)
  }
}

export async function initAiKeys(): Promise<void> {
  await ensureLoaded()
}

export async function setAiKey(provider: AiSecretProvider, plaintext: string): Promise<boolean> {
  if (!(await ensureLoaded())) return false // 로드 실패 시 persist 금지 — 다른 제공자 키 유실 방지
  if (!isKeyStorageAvailable()) return false
  const trimmed = plaintext.trim()
  if (!trimmed) {
    cipherByProvider.delete(provider)
  } else {
    const enc = safeStorage.encryptString(trimmed)
    cipherByProvider.set(provider, enc.toString('base64'))
  }
  await persist()
  return true
}

export async function clearAiKey(provider: AiSecretProvider): Promise<void> {
  if (!(await ensureLoaded())) return // 로드 실패 시 아무것도 안 함 — 다른 제공자 키 유실 방지
  cipherByProvider.delete(provider)
  await persist()
}

export async function getAiKey(provider: AiSecretProvider): Promise<string | null> {
  await ensureLoaded()
  const cipher = cipherByProvider.get(provider)
  if (!cipher) return null
  try {
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  } catch (err) {
    console.warn('[ai] key decrypt failed', err)
    return null
  }
}

export async function hasAiKey(provider: AiSecretProvider): Promise<boolean> {
  await ensureLoaded()
  return cipherByProvider.has(provider)
}
