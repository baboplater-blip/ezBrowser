import { app, session, type Extension, type Session } from 'electron'
import { EventEmitter } from 'node:events'
import { promises as fsp, existsSync, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash, generateKeyPairSync } from 'node:crypto'
import path from 'node:path'
import extract from 'extract-zip'
import { createTab, getWebContentsByTabId } from '../tabs/tab-service'
import { getAllWindows } from '../windows/window-service'
import { addSessionInitHook, forEachInstalledSession } from '../session-bootstrap'
import type { ExtensionSummary } from '../../shared/types'

let extensionsAdapter: unknown = null

interface ExtensionsCtor {
  new (opts: {
    session: Electron.Session
    license?: string
    createTab: (details: { url?: string; windowId?: number; active?: boolean }) => Promise<[Electron.WebContents, Electron.BaseWindow]>
    selectTab?: (tab: Electron.WebContents, win: Electron.BaseWindow) => void
    removeTab?: (tab: Electron.WebContents, win: Electron.BaseWindow) => void
  }): unknown
}

async function loadModule(): Promise<{ ElectronChromeExtensions: ExtensionsCtor } | null> {
  try {
    const name = ['electron-chrome-extensions'][0]!
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(name) as { ElectronChromeExtensions: ExtensionsCtor }
    return mod
  } catch {
    console.warn('[extensions] electron-chrome-extensions not installed — skipped')
    return null
  }
}

function extensionsRoot(): string {
  return path.join(app.getPath('userData'), 'extensions')
}

function disabledFile(): string {
  return path.join(app.getPath('userData'), 'extensions-disabled.json')
}

async function readDisabled(): Promise<Set<string>> {
  try {
    const raw = await fsp.readFile(disabledFile(), 'utf-8')
    const arr = JSON.parse(raw) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

async function writeDisabled(set: Set<string>): Promise<void> {
  await fsp.writeFile(disabledFile(), JSON.stringify(Array.from(set)), 'utf-8')
}

export const extensionEvents = new EventEmitter()

function sessions(): Session[] {
  // 모든 설치된 세션(default + persist:default + 모든 워크스페이스 partition)에 확장을 로드해야
  // 비-default 워크스페이스에서도 확장이 동작한다. defaultSession 은 install 목록에 포함되지만
  // 방어적으로 Set 에 미리 넣어 dedup 한다. (회귀 #12/#13 계열 — session-bootstrap hook 시스템 재사용)
  const set = new Set<Session>([session.defaultSession])
  forEachInstalledSession((s) => set.add(s))
  return [...set]
}

// 새로 만들어지는 세션(예: 새 워크스페이스 partition)에 활성 확장을 로드한다. idempotent.
async function loadEnabledInto(ses: Session): Promise<void> {
  const root = extensionsRoot()
  let entries: string[] = []
  try { entries = await fsp.readdir(root) } catch { return }
  const disabled = await readDisabled()
  const already = new Set(ses.getAllExtensions().map((x) => x.id))
  for (const entry of entries) {
    if (disabled.has(entry)) continue
    if (already.has(entry)) continue // 이미 로드됨 (디렉터리 이름 = 확장 id)
    const extPath = path.join(root, entry)
    const stat = await fsp.stat(extPath).catch(() => null)
    if (!stat?.isDirectory()) continue
    if (!existsSync(path.join(extPath, 'manifest.json'))) continue
    try { await ses.loadExtension(extPath, { allowFileAccess: true }) }
    catch (err) { console.warn(`[extensions] load into new session failed: ${entry}`, err) }
  }
}

export async function initExtensions(): Promise<void> {
  const mod = await loadModule()
  if (!mod) return

  try {
    extensionsAdapter = new mod.ElectronChromeExtensions({
      session: session.defaultSession,
      license: 'GPL-3.0',
      createTab: async ({ url, active }) => {
        const ctx = getAllWindows()[0]
        if (!ctx) throw new Error('no window')
        const summary = createTab({ windowId: ctx.id, url, background: !active })
        const wc = getWebContentsByTabId(summary.id)
        if (!wc) throw new Error('webcontents not found')
        return [wc, ctx.win]
      },
      selectTab: () => undefined,
      removeTab: () => undefined,
    })
  } catch (err) {
    console.warn('[extensions] adapter init failed', err)
    return
  }

  await fsp.mkdir(extensionsRoot(), { recursive: true }).catch(() => undefined)
  await loadInstalledExtensions()
  // 이후 생성되는 워크스페이스 partition 세션에도 자동으로 활성 확장 로드 (기존 세션은 위에서 이미 로드됨 → getAllExtensions 가드로 skip)
  addSessionInitHook((ses) => { void loadEnabledInto(ses) })
}

async function loadInstalledExtensions(): Promise<void> {
  const root = extensionsRoot()
  let entries: string[] = []
  try {
    entries = await fsp.readdir(root)
  } catch {
    return
  }
  const disabled = await readDisabled()
  for (const entry of entries) {
    if (disabled.has(entry)) continue
    const extPath = path.join(root, entry)
    const stat = await fsp.stat(extPath).catch(() => null)
    if (!stat?.isDirectory()) continue
    if (!existsSync(path.join(extPath, 'manifest.json'))) continue
    await loadExtensionInAll(extPath)
  }
  extensionEvents.emit('changed')
}

async function loadExtensionInAll(extPath: string): Promise<Extension | null> {
  let lastErr: unknown = null
  let loaded: Extension | null = null
  for (const ses of sessions()) {
    try {
      const ext = await ses.loadExtension(extPath, { allowFileAccess: true })
      loaded = ext
    } catch (err) {
      lastErr = err
    }
  }
  if (!loaded) console.warn(`[extensions] failed to load ${extPath}`, lastErr)
  return loaded
}

function removeFromAll(id: string): void {
  for (const ses of sessions()) {
    try { ses.removeExtension(id) } catch { /* ignore */ }
  }
}

export async function listExtensions(): Promise<ExtensionSummary[]> {
  const disabled = await readDisabled()
  const root = extensionsRoot()
  const dirs: string[] = await fsp.readdir(root).catch(() => [])
  const out: ExtensionSummary[] = []
  // active 세션 기준 metadata
  const active = session.defaultSession.getAllExtensions()
  const activeById = new Map(active.map((e) => [e.id, e]))
  for (const dir of dirs) {
    const dirPath = path.join(root, dir)
    const stat = await fsp.stat(dirPath).catch(() => null)
    if (!stat?.isDirectory()) continue
    const manifestPath = path.join(dirPath, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    let manifest: ManifestJson
    try {
      manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'))
    } catch {
      continue
    }
    const isDisabled = disabled.has(dir)
    const ext = activeById.get(dir)
    const iconDataUrl = await readBestIcon(dirPath, manifest).catch(() => undefined)
    const messages = await loadLocaleMessages(dirPath, manifest.default_locale || 'en')
    out.push({
      id: dir,
      // Electron 이 이미 name 을 치환해 준 경우(ext?.name) localizeString 은 정규식 불일치라
      // 그대로 통과시킨다 — 아직 __MSG_x__ 그대로면(또는 ext 가 없으면) messages.json 으로 해석.
      name: localizeString(ext?.name ?? manifest.name, messages) ?? dir,
      version: ext?.version ?? manifest.version ?? '0.0.0',
      description: localizeString(manifest.description, messages),
      enabled: !isDisabled,
      hasOptions: Boolean(manifest.options_ui?.page || manifest.options_page),
      hasIcon: Boolean(iconDataUrl),
      iconDataUrl,
      hasAction: Boolean(manifest.action || manifest.browser_action),
      actionTitle: localizeString(
        manifest.action?.default_title
        ?? manifest.browser_action?.default_title
        ?? manifest.name,
        messages,
      ),
      homepageUrl: manifest.homepage_url,
      source: 'crx',
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

// ── i18n: manifest 필드의 __MSG_key__ 플레이스홀더를 _locales/<locale>/messages.json 으로 해석 ──
// Chrome 확장 표준: manifest 의 name/description/action.default_title 등에 정확히
// "__MSG_key__" 형식의 값이 오면, default_locale(없으면 'en') 폴더의 messages.json 에서
// { "key": { "message": "..." } } 을 찾아 치환한다. Electron 의 loadExtension 은 name 만
// 이따금 이미 치환해 반환하므로(런타임 확장 객체 기준), name 은 우선 그 값을 쓰고 여전히
// 플레이스홀더 형태면(또는 없으면) 여기서 마저 해석한다. 파일 없음·키 없음 등은 원문을 그대로
// 반환해 표시가 깨지지 않게 한다(안전 우선).
type LocaleMessages = Record<string, { message?: string }>

async function loadLocaleMessages(extDir: string, locale: string): Promise<LocaleMessages | null> {
  const file = path.join(extDir, '_locales', locale, 'messages.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(await fsp.readFile(file, 'utf-8')) as LocaleMessages
  } catch {
    return null
  }
}

const MSG_PLACEHOLDER_RE = /^__MSG_([A-Za-z0-9_@]+)__$/

function localizeString(raw: string | undefined, messages: LocaleMessages | null): string | undefined {
  if (!raw) return raw
  const m = raw.match(MSG_PLACEHOLDER_RE)
  if (!m) return raw // 일반 문자열 — 이미 해석됐거나 애초에 플레이스홀더가 아님
  const key = m[1]!
  return messages?.[key]?.message ?? raw
}

interface ManifestJson {
  name?: string
  version?: string
  description?: string
  homepage_url?: string
  options_page?: string
  options_ui?: { page?: string }
  action?: { default_title?: string; default_icon?: string | Record<string, string> }
  browser_action?: { default_title?: string; default_icon?: string | Record<string, string> }
  icons?: Record<string, string>
  default_locale?: string
}

async function readBestIcon(extDir: string, manifest: ManifestJson): Promise<string | undefined> {
  const candidates: string[] = []
  const collect = (src: string | Record<string, string> | undefined) => {
    if (!src) return
    if (typeof src === 'string') { candidates.push(src); return }
    for (const v of Object.values(src)) candidates.push(v)
  }
  collect(manifest.action?.default_icon)
  collect(manifest.browser_action?.default_icon)
  collect(manifest.icons)
  // 큰 아이콘부터
  const ranked = candidates
    .map((p) => ({ p, size: parseInt(p.match(/(\d+)/)?.[1] ?? '0', 10) }))
    .sort((a, b) => b.size - a.size)
  for (const { p } of ranked) {
    const full = path.join(extDir, p)
    if (!existsSync(full)) continue
    try {
      const buf = await fsp.readFile(full)
      const ext = path.extname(p).slice(1).toLowerCase()
      const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch { continue }
  }
  return undefined
}

const CRX_MAGIC = Buffer.from('Cr24', 'utf-8')
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04])

// ── 회귀(버그 2) fix: manifest "key" 기반 안정 ID ────────────────────────
//
// 근본 원인: CRX 페이로드(zip)를 그대로 풀면 manifest.json 에는 보통 "key" 필드가 없다
// (웹스토어 서명키는 CRX 컨테이너의 바깥쪽 헤더에만 있고, 압축 payload 안 manifest 에는
// 기록되지 않는다). manifest 에 "key" 가 없으면 Chromium/Electron 은 **설치 경로 문자열의
// SHA256 해시**로 확장 ID 를 만든다 — 즉 ID 가 경로에 종속된다. 옛 코드는 임시 경로에서
// 한 번 로드해 ID 를 얻은 뒤(경로A 기준 ID) 최종 경로로 옮기고 다시 로드했는데(경로B 기준
// 재계산), 이때 재로드로 실제 활성화된 확장의 런타임 ID 는 경로B 기준으로 새로 계산되어
// 저장/반환한 ID(경로A 기준)와 영구히 달라진다 → 툴바 액션 팝업 chrome-error, 이름
// __MSG_extName__, disable/remove 무반응 등 "확장이 로드는 되지만 앱 UI 에서 못 씀" 증상.
//
// 수정: CRX 컨테이너 헤더에서 서명 공개키(pubkey, DER SubjectPublicKeyInfo)를 직접 추출해
// manifest.json 에 "key"(base64) 로 주입한다. Chrome 확장 ID = SHA256(pubkey DER)의 앞
// 16바이트를 a~p 알파벳으로 인코딩한 값 — **경로와 무관**, 웹스토어가 부여한 ID 와 동일.
// 이제 최종 설치 경로를 ID 로 미리 계산해 정확히 그 자리에 배치한 뒤 **단 한 번만** 로드한다
// (이동 후 재로드 없음 → mismatch 자체가 발생할 수 없는 구조).
// unpacked 로컬 드래그(importLocalUnpackedDir)처럼 서명키가 없는 입력은, Electron 이
// unpacked 로드 시 key 의 서명 유효성을 검증하지 않고 ID 파생에만 쓴다는 점을 이용해
// 자체 키쌍을 생성해 동일하게 주입한다 — 이 역시 경로 독립적인 안정 ID 를 얻는다.

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let result = 0
  let shift = 0
  let pos = offset
  while (pos < buf.length) {
    const byte = buf[pos]!
    pos++
    result += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value: result, next: pos }
    shift += 7
  }
  throw new Error('protobuf: truncated varint')
}

// CRX3 헤더는 protobuf(CrxFileHeader) — 라이브러리 없이 varint+wire-type 만 최소 파싱한다.
// 최상위 필드 번호별로 length-delimited(wire type 2) 바이트열을 모아 반환.
function parseProtoLenDelimitedFields(buf: Buffer): Map<number, Buffer[]> {
  const fields = new Map<number, Buffer[]>()
  let pos = 0
  while (pos < buf.length) {
    const { value: key, next: afterKey } = readVarint(buf, pos)
    pos = afterKey
    const tag = Math.floor(key / 8)
    const wireType = key % 8
    if (wireType === 0) {
      pos = readVarint(buf, pos).next
    } else if (wireType === 1) {
      pos += 8
    } else if (wireType === 2) {
      const { value: len, next } = readVarint(buf, pos)
      pos = next
      if (pos + len > buf.length) throw new Error('protobuf: length exceeds buffer')
      const data = buf.subarray(pos, pos + len)
      if (!fields.has(tag)) fields.set(tag, [])
      fields.get(tag)!.push(data)
      pos += len
    } else if (wireType === 5) {
      pos += 4
    } else {
      throw new Error(`protobuf: unsupported wire type ${wireType}`)
    }
  }
  return fields
}

// CrxFileHeader.sha256_with_rsa(field 2) / sha256_with_ecdsa(field 3) = repeated
// AsymmetricKeyProof{ public_key(field 1), signature(field 2) }.
//
// 실측(웹스토어 CRX 3종 직접 다운로드+파싱)으로 확인된 함정: field 2 에는 흔히 **proof 가
// 2개** 들어있다 — 첫 번째는 모든 확장에 걸쳐 바이트가 완전히 동일한 "배포/재서명" 키(웹
// 스토어가 다운로드 서비스를 통해 재패키징할 때 추가하는 것으로 보임)이고, 실제 개발자
// 고유 키(=웹스토어 ID 를 결정하는 키)는 **두 번째** proof 에 있다. 첫 proof 를 그대로 쓰면
// 모든 확장이 동일한 ID 로 뭉개진다(실측 재현: uBO Lite/Dark Reader/ColorZilla 3종 모두
// 첫 proof pubkey 가 바이트 단위로 동일 → id 도 동일).
//
// 신뢰 가능한 판별법: CrxFileHeader.signed_header_data(field 10000) = SignedData 안의
// crx_id(field 1) 는 Chromium 이 이미 계산해 넣어둔 **정답 ID 원본 바이트(16바이트, 해시 불필요,
// a-p 인코딩만 하면 곧 확장 ID)**. 이 값과 SHA256(pubkey)[0:16] 이 일치하는 proof 를
// field 2 → field 3 순서로 탐색해 "진짜" 개발자 키를 찾아낸다 — 실측 3/3 에서 크로스체크
// 정확히 일치함을 확인(예: uBO Lite crx_id 원본 바이트를 a-p 인코딩한 값이 field2[1] pubkey 의
// SHA256 기반 id 와 정확히 일치, 그리고 둘 다 실제 웹스토어 상세페이지 ID 'ddkjiahejl...' 와 일치).
function extractCrx3PublicKey(header: Buffer): Buffer | null {
  const top = parseProtoLenDelimitedFields(header)

  const candidates: Buffer[] = []
  for (const fieldNum of [2, 3]) {
    const proofs = top.get(fieldNum)
    if (!proofs) continue
    for (const proofBuf of proofs) {
      const proofFields = parseProtoLenDelimitedFields(proofBuf)
      const pubKeys = proofFields.get(1)
      if (pubKeys && pubKeys.length > 0) candidates.push(Buffer.from(pubKeys[0]!))
    }
  }
  if (candidates.length === 0) return null

  // signed_header_data(10000) → SignedData.crx_id(1) = 정답 ID 원본 바이트. 있으면 그 값과
  // SHA256 해시가 일치하는 후보를 찾아 self-verify. 여러 proof 가 있어도 순서에 의존하지 않는다.
  const signedHeaderData = top.get(10000)
  if (signedHeaderData && signedHeaderData.length > 0) {
    try {
      const shdFields = parseProtoLenDelimitedFields(signedHeaderData[0]!)
      const crxIdBytes = shdFields.get(1)?.[0]
      if (crxIdBytes && crxIdBytes.length === 16) {
        const expectedId = idFromRawIdBytes(Buffer.from(crxIdBytes))
        const match = candidates.find((pk) => idFromPublicKey(pk) === expectedId)
        if (match) return match
      }
    } catch {
      // signed_header_data 파싱 실패 — 아래 fallback 으로
    }
  }

  // signed_header_data 가 없거나 어느 후보와도 안 맞는 예외적 경우: 마지막 후보를 사용한다
  // (실측상 "배포/재서명" 키가 항상 먼저, 개발자 키가 나중에 오는 패턴과 일치하는 최선의 추정).
  return candidates[candidates.length - 1]!
}

// SignedData.crx_id 는 이미 계산된 16바이트 ID 원본 — 해시 없이 a-p 알파벳으로만 인코딩.
function idFromRawIdBytes(idBytes: Buffer): string {
  let id = ''
  for (const byte of idBytes) {
    id += String.fromCharCode(97 + (byte >> 4))
    id += String.fromCharCode(97 + (byte & 0x0f))
  }
  return id
}

// Chrome 확장 ID = SHA256(pubkey DER)[0:16] 을 hex 인코딩 후 각 hex 문자(0-9a-f)를
// a-p 알파벳으로 치환(0→a … 15→p). (Chromium crx_file::id_util::GenerateId 와 동일 알고리즘 —
// 다수의 빌드 도구·문서에서 검증된 공개 알고리즘.)
function idFromPublicKey(pubKeyDer: Buffer): string {
  const hash = createHash('sha256').update(pubKeyDer).digest()
  const first16 = hash.subarray(0, 16)
  let id = ''
  for (const byte of first16) {
    id += String.fromCharCode(97 + (byte >> 4))
    id += String.fromCharCode(97 + (byte & 0x0f))
  }
  return id
}

async function unpackCrx(crxPath: string, outDir: string): Promise<Buffer | null> {
  const buf = await fsp.readFile(crxPath)
  let zipOffset: number
  let pubKey: Buffer | null = null
  if (buf.length >= 4 && buf.subarray(0, 4).equals(CRX_MAGIC)) {
    const version = buf.readUInt32LE(4)
    if (version === 2) {
      const pubKeyLen = buf.readUInt32LE(8)
      const sigLen = buf.readUInt32LE(12)
      if (pubKeyLen > 0 && 16 + pubKeyLen <= buf.length) {
        pubKey = Buffer.from(buf.subarray(16, 16 + pubKeyLen))
      }
      zipOffset = 16 + pubKeyLen + sigLen
    } else if (version === 3) {
      const headerLen = buf.readUInt32LE(8)
      const header = buf.subarray(12, 12 + headerLen)
      try {
        pubKey = extractCrx3PublicKey(header)
      } catch (err) {
        console.warn('[extensions] CRX3 헤더 파싱 실패 — 서명 키 없이 진행(자체 키 생성으로 폴백)', err)
      }
      zipOffset = 12 + headerLen
    } else {
      // 알 수 없는 버전 — ZIP 시그니처 직접 탐색
      const found = buf.indexOf(ZIP_LOCAL_HEADER)
      if (found < 0) throw new Error('crx: ZIP header not found')
      zipOffset = found
    }
  } else if (buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_LOCAL_HEADER)) {
    // 이미 ZIP — unpacked 형식의 zip
    zipOffset = 0
  } else {
    throw new Error('crx: not a CRX or ZIP file')
  }

  const tmpZip = path.join(outDir, '__inner.zip')
  await fsp.mkdir(outDir, { recursive: true })
  await fsp.writeFile(tmpZip, buf.subarray(zipOffset))
  try {
    await extract(tmpZip, { dir: outDir })
  } finally {
    await fsp.unlink(tmpZip).catch(() => undefined)
  }
  return pubKey
}

// manifest.json 에 "key" 가 없으면(CRX payload 의 일반적 상태) pubKeyFromCrx(있으면) 또는
// 자체 생성 키를 주입해 경로 독립적 ID 를 계산한다. 이미 key 가 있으면(재서명된 unpacked 등)
// 그 key 기준으로만 ID 를 계산 — 존중하고 덮어쓰지 않는다.
async function ensureManifestKey(extDir: string, pubKeyFromCrx: Buffer | null): Promise<string | null> {
  const manifestPath = path.join(extDir, 'manifest.json')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'))
  } catch (err) {
    console.warn('[extensions] manifest.json 파싱 실패', err)
    return null
  }

  const existingKey = typeof manifest.key === 'string' ? manifest.key : null
  if (existingKey) {
    try {
      return idFromPublicKey(Buffer.from(existingKey, 'base64'))
    } catch {
      // 손상된 key 값 — 아래에서 재생성해 덮어씀
    }
  }

  let pubKeyDer = pubKeyFromCrx
  if (!pubKeyDer) {
    // CRX 헤더에서 서명 키를 못 얻었거나(unpacked 로컬 드래그 등) manifest 에 key 가 없는 경우.
    // Electron/Chrome 은 unpacked 로드 시 key 의 서명 유효성을 검증하지 않고 ID 파생에만
    // 사용하므로, 안정적(경로 독립적) ID 확보를 위해 자체 키를 생성해 주입한다.
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    pubKeyDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  }
  manifest.key = pubKeyDer.toString('base64')
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
  return idFromPublicKey(pubKeyDer)
}

// key 주입이 끝난 준비 디렉터리(preparedDir)를 계산된 ID 기준 최종 위치로 배치하고
// **단 한 번만** 로드한다. content-based ID 이므로 이동 자체가 ID 를 바꾸지 않는다 —
// 그래도 방어적으로 loaded.id !== computedId 면(파싱 버그 등 이론상 상황) 순수 rename 으로
// 디렉터리명을 런타임 진실(loaded.id)에 맞춰 정정한다(재로드 불필요 — content-based ID 는
// 경로가 아니라 key 내용에만 의존하므로 이후 재부팅 시에도 동일 id 로 다시 계산된다).
async function finalizeInstall(preparedDir: string, computedId: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  removeFromAll(computedId) // 재설치/업데이트 시 기존 로드분 정리

  const finalDir = path.join(extensionsRoot(), computedId)
  if (existsSync(finalDir)) {
    await fsp.rm(finalDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await fsp.mkdir(extensionsRoot(), { recursive: true })
  await fsp.rename(preparedDir, finalDir).catch(async () => {
    // 다른 디스크일 수도 — copy fallback
    await copyDir(preparedDir, finalDir)
    await fsp.rm(preparedDir, { recursive: true, force: true }).catch(() => undefined)
  })

  const loaded = await loadExtensionInAll(finalDir)
  if (!loaded) return { ok: false, error: '로드 실패' }

  let finalId = loaded.id
  if (loaded.id !== computedId) {
    console.warn(`[extensions] id mismatch — 정정: computed=${computedId} runtime=${loaded.id}`)
    const correctedDir = path.join(extensionsRoot(), loaded.id)
    if (existsSync(correctedDir)) await fsp.rm(correctedDir, { recursive: true, force: true }).catch(() => undefined)
    await fsp.rename(finalDir, correctedDir).catch(() => undefined)
    finalId = loaded.id
  }

  const disabled = await readDisabled()
  if (disabled.delete(finalId)) await writeDisabled(disabled)
  extensionEvents.emit('changed')
  return { ok: true, id: finalId }
}

export async function installFromCrx(crxPath: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!existsSync(crxPath)) return { ok: false, error: 'file not found' }

  // 임시 디렉터리에 압축 해제(+ CRX 헤더에서 서명 pubkey 추출)
  const tmpDir = path.join(app.getPath('temp'), `browserbuild-crx-${Date.now()}`)
  let pubKey: Buffer | null = null
  try {
    pubKey = await unpackCrx(crxPath, tmpDir)
  } catch (err) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: `압축 해제 실패: ${(err as Error).message}` }
  }

  const computedId = await ensureManifestKey(tmpDir, pubKey)
  if (!computedId) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: 'manifest.json 을 읽을 수 없습니다.' }
  }

  return finalizeInstall(tmpDir, computedId)
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fsp.mkdir(dst, { recursive: true })
  const entries = await fsp.readdir(src, { withFileTypes: true })
  for (const e of entries) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) await copyDir(s, d)
    else await fsp.copyFile(s, d)
  }
}

const WEBSTORE_URL_RE = /chrome(?:webstore)?\.google\.com\/(?:webstore\/)?detail\/[^/]+\/([a-p]{32})/i
// 버그 1 fix: prodversion 을 하드코딩(120.0.0.0)하면 minimum_chrome_version 이 그보다 높은
// 확장(uBO Lite·Stylus·Wappalyzer 등)에 대해 웹스토어가 204(No Content) 를 반환해 다운로드가
// 조용히 실패한다. Electron 이 내장한 실제 Chromium 런타임 버전(process.versions.chrome)을
// 그대로 전달해 항상 현재 엔진과 일치하는 버전으로 질의한다.
const WEBSTORE_CRX_URL = (id: string): string =>
  `https://clients2.google.com/service/update2/crx?response=redirect`
  + `&os=win&arch=x64&os_arch=x86_64&nacl_arch=x86-64`
  + `&prod=chromiumcrx&prodchannel=unknown&prodversion=${process.versions.chrome}`
  + `&acceptformat=crx2,crx3&x=id%3D${id}%26uc`

export function parseWebstoreId(url: string): string | null {
  const m = url.match(WEBSTORE_URL_RE)
  return m?.[1] ?? null
}

export async function installFromUrl(url: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const id = parseWebstoreId(url)
  let downloadUrl: string
  if (id) {
    downloadUrl = WEBSTORE_CRX_URL(id)
  } else if (/^https?:\/\/.+\.crx(\?.*)?$/i.test(url)) {
    downloadUrl = url
  } else {
    return { ok: false, error: '지원하지 않는 URL — 웹스토어 detail URL 또는 .crx 직접 링크여야 합니다.' }
  }

  const tmpCrx = path.join(app.getPath('temp'), `browserbuild-dl-${Date.now()}.crx`)
  try {
    const res = await fetch(downloadUrl, { redirect: 'follow' })
    if (!res.ok || !res.body) {
      return { ok: false, error: `다운로드 실패 (${res.status})` }
    }
    const ws = createWriteStream(tmpCrx)
    await pipeline(Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream), ws)
  } catch (err) {
    return { ok: false, error: `네트워크 오류: ${(err as Error).message}` }
  }

  try {
    return await installFromCrx(tmpCrx)
  } finally {
    await fsp.unlink(tmpCrx).catch(() => undefined)
  }
}

export async function removeExtension(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^[a-z]{32}$/i.test(id) && !/^[a-z0-9_-]+$/i.test(id)) {
    return { ok: false, error: 'invalid id' }
  }
  removeFromAll(id)
  const dir = path.join(extensionsRoot(), id)
  if (!existsSync(dir)) return { ok: false, error: 'not found' }
  await fsp.rm(dir, { recursive: true, force: true })
  const disabled = await readDisabled()
  if (disabled.delete(id)) await writeDisabled(disabled)
  extensionEvents.emit('changed')
  return { ok: true }
}

export async function setExtensionEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const dir = path.join(extensionsRoot(), id)
  if (!existsSync(dir)) return { ok: false, error: 'not found' }
  const disabled = await readDisabled()
  if (enabled) {
    disabled.delete(id)
    await writeDisabled(disabled)
    await loadExtensionInAll(dir)
  } else {
    disabled.add(id)
    await writeDisabled(disabled)
    removeFromAll(id)
  }
  extensionEvents.emit('changed')
  return { ok: true }
}

export async function openExtensionOptions(id: string, windowId: string): Promise<{ ok: boolean; error?: string }> {
  const dir = path.join(extensionsRoot(), id)
  if (!existsSync(dir)) return { ok: false, error: 'not found' }
  let manifest: ManifestJson
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf-8'))
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  const page = manifest.options_ui?.page ?? manifest.options_page
  if (!page) return { ok: false, error: '옵션 페이지 없음' }
  createTab({ windowId, url: `chrome-extension://${id}/${page}` })
  return { ok: true }
}

export async function invokeExtensionAction(id: string, windowId: string): Promise<{ ok: boolean; error?: string }> {
  // 기본 동작: popup 페이지를 새 탭으로 (정식 popup 창은 향후 보완)
  const dir = path.join(extensionsRoot(), id)
  if (!existsSync(dir)) return { ok: false, error: 'not found' }
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf-8')) as ManifestJson & {
      action?: { default_popup?: string }
      browser_action?: { default_popup?: string }
    }
    const popup = manifest.action?.default_popup ?? manifest.browser_action?.default_popup
    if (popup) {
      createTab({ windowId, url: `chrome-extension://${id}/${popup}` })
      return { ok: true }
    }
    // popup 없으면 옵션 페이지로 fallback
    return openExtensionOptions(id, windowId)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function importLocalUnpackedDir(srcDir: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!existsSync(path.join(srcDir, 'manifest.json'))) {
    return { ok: false, error: 'manifest.json 없음 (unpacked 디렉터리가 맞나요?)' }
  }
  // srcDir 은 사용자 소유 임의 경로일 수 있으므로 직접 수정하지 않고 임시 복사본에 key 주입.
  // 폴더 드래그(unpacked) 는 CRX 헤더가 없어 pubKeyFromCrx=null → manifest 에 기존 key 가
  // 없으면 ensureManifestKey 가 자체 키를 생성해 경로 독립적 ID 를 부여한다(installFromCrx 와
  // 동일한 finalizeInstall 단일 로드 경로 — 이동 후 재로드로 인한 ID mismatch 가 구조적으로 없음).
  const tmpDir = path.join(app.getPath('temp'), `browserbuild-unpacked-${Date.now()}`)
  try {
    await copyDir(srcDir, tmpDir)
  } catch (err) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: `복사 실패: ${(err as Error).message}` }
  }

  const computedId = await ensureManifestKey(tmpDir, null)
  if (!computedId) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: 'manifest.json 을 읽을 수 없습니다.' }
  }

  return finalizeInstall(tmpDir, computedId)
}

export function getExtensionsAdapter(): unknown {
  return extensionsAdapter
}
