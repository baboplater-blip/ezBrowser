import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

// 스마트 폼필용 개인 프로필 — 이름·주소·이메일·카드 등. safeStorage(OS 키체인)로 암호화 저장.
// 값은 자동 채우기 시 메인 → 페이지로만 흐르고 AI(LLM)로는 절대 전송되지 않는다(자동 채우기는 결정적).

const FILE = (): string => join(app.getPath('userData'), 'ai-profile.json')
let cache: Record<string, string> = {}
let loaded = false
export const profileEvents = new EventEmitter()

// 표준 필드 정의 — 관리 UI 표시 + 자동 채우기 매칭에 공용. (순서 = UI 표시 순서)
export interface ProfileFieldDef { key: string; label: string; sensitive?: boolean }
export const PROFILE_FIELDS: ProfileFieldDef[] = [
  { key: 'fullName', label: '이름(전체)' },
  { key: 'firstName', label: '이름' },
  { key: 'lastName', label: '성' },
  { key: 'email', label: '이메일' },
  { key: 'phone', label: '전화번호' },
  { key: 'postalCode', label: '우편번호' },
  { key: 'address', label: '주소' },
  { key: 'addressDetail', label: '상세주소' },
  { key: 'city', label: '도시' },
  { key: 'country', label: '국가' },
  { key: 'birthday', label: '생년월일(YYYY-MM-DD)' },
  { key: 'organization', label: '회사/소속' },
  { key: 'username', label: '아이디' },
  { key: 'cardNumber', label: '카드번호', sensitive: true },
  { key: 'cardExp', label: '카드 만료(MM/YY)', sensitive: true },
  { key: 'cardCVC', label: '카드 CVC', sensitive: true },
]
const VALID_KEYS = new Set(PROFILE_FIELDS.map((f) => f.key))

function load(): void {
  if (loaded) return
  loaded = true
  try {
    if (existsSync(FILE())) {
      const raw = JSON.parse(readFileSync(FILE(), 'utf8')) as { enc?: string; plain?: Record<string, string> }
      if (raw?.enc && safeStorage.isEncryptionAvailable()) {
        cache = JSON.parse(safeStorage.decryptString(Buffer.from(raw.enc, 'base64'))) as Record<string, string>
      } else if (raw?.plain) {
        cache = raw.plain
      }
    }
  } catch { cache = {} }
  if (!cache || typeof cache !== 'object') cache = {}
}
function save(): void {
  try {
    // 암호화 불가 시 저장하지 않는다 — 카드번호·CVC 등 민감 정보를 평문으로 디스크에 남기지 않고,
    // 기존 암호화 파일도 덮어써 파괴하지 않는다(safeStorage 일시 불가 시 보존). password/keys 와 동일 정책.
    if (!safeStorage.isEncryptionAvailable()) return
    const payload = { enc: safeStorage.encryptString(JSON.stringify(cache)).toString('base64') }
    const tmp = FILE() + '.tmp'
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, FILE())
  } catch { /* ignore */ }
}

export function getProfile(): Record<string, string> { load(); return { ...cache } }
export function hasProfileData(): boolean { load(); return Object.keys(cache).length > 0 }
export function storageAvailable(): boolean { return safeStorage.isEncryptionAvailable() }

export function setProfile(fields: Record<string, string>): void {
  load()
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields || {})) {
    if (VALID_KEYS.has(k) && typeof v === 'string' && v.trim()) next[k] = v.trim().slice(0, 300)
  }
  cache = next
  save(); profileEvents.emit('changed')
}
