import crypto from 'node:crypto'

/**
 * 백업(내보내기) 전용 암호화 — scrypt(비밀번호→키) + AES-256-GCM.
 *
 * 이 모듈이 존재하는 이유: 비밀번호 저장소(`passwords.json`)는 `safeStorage`(OS 키체인/DPAPI)로
 * 암호화돼 있다. **그 암호문은 "이 PC의 이 사용자 계정"에서만 풀 수 있다** — 다른 PC 로 백업을
 * 옮기면 복호화가 영구히 불가능하다. 이 모듈은 사용자가 직접 입력한 **백업 암호(passphrase)**
 * 로 별도 재암호화해, PC 를 옮겨도 같은 암호로 풀 수 있는 이식 가능한 블록을 만든다.
 *
 * 순수 함수 — Electron 의존 없음. Node 내장 `crypto` 만 사용(신규 의존성 없음).
 */

export interface EncryptedPayload {
  alg: 'aes-256-gcm'
  kdf: 'scrypt'
  /** scrypt 솔트 (base64) */
  saltB64: string
  /** GCM IV (base64) */
  ivB64: string
  /** GCM 인증 태그 (base64) — 틀린 암호·손상 데이터를 여기서 잡는다 */
  authTagB64: string
  ciphertextB64: string
}

const KEY_LEN = 32 // AES-256

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // scrypt 기본 파라미터(N=16384, r=8, p=1)로 충분 — 브루트포스 비용을 높이는 것이 목적이며
  // 이 앱은 대화형 로컬 사용이라 초 단위 지연도 허용 범위.
  return crypto.scryptSync(passphrase, salt, KEY_LEN)
}

/** 평문 JSON 문자열을 백업 암호로 암호화한다. */
export function encryptWithPassphrase(plainJson: string, passphrase: string): EncryptedPayload {
  const salt = crypto.randomBytes(16)
  const key = deriveKey(passphrase, salt)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plainJson, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    alg: 'aes-256-gcm',
    kdf: 'scrypt',
    saltB64: salt.toString('base64'),
    ivB64: iv.toString('base64'),
    authTagB64: authTag.toString('base64'),
    ciphertextB64: ciphertext.toString('base64'),
  }
}

/**
 * 백업 암호로 복호화한다. 암호가 틀렸거나 데이터가 손상됐으면(GCM 인증 실패) **null**.
 * (틀린 암호와 손상 데이터를 구분해 알리지 않는다 — GCM 인증 실패는 원인이 둘 다일 수 있고,
 * 구분해서 알리는 것 자체가 부가 정보 유출이라 관례상 하나로 묶는다.)
 */
export function decryptWithPassphrase(payload: EncryptedPayload, passphrase: string): string | null {
  try {
    if (!payload || payload.alg !== 'aes-256-gcm' || payload.kdf !== 'scrypt') return null
    const salt = Buffer.from(payload.saltB64, 'base64')
    const iv = Buffer.from(payload.ivB64, 'base64')
    const authTag = Buffer.from(payload.authTagB64, 'base64')
    const ciphertext = Buffer.from(payload.ciphertextB64, 'base64')
    const key = deriveKey(passphrase, salt)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plain.toString('utf8')
  } catch {
    return null
  }
}
