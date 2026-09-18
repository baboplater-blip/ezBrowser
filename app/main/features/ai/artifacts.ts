import { app } from 'electron'
import { randomBytes, createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync,
  realpathSync, rmSync, statSync,
} from 'node:fs'
import path from 'node:path'

// 작업별 산출물 저장소 — 에이전트가 페이지에서 만든 이미지(또는 다운로드로 받은 파일)를
// "그 작업이 만든 것만 그 작업이 업로드할 수 있게" 격리해 보관한다.
// (.auto-dev/design-social.md #1 — 이 파일은 그 계약의 구현체. 시그니처는 계약과 동일해야 한다.)
//
// 왜 작업별 폴더인가: 에이전트가 여러 탭·여러 작업을 오가는 동안 "방금 만든 이미지"와
// "다른 작업이 예전에 만든 이미지"가 섞이면 엉뚱한 파일이 업로드될 수 있다. taskId 로 나눈 하위
// 폴더 + resolveArtifactPath 의 realpath 경계 검사(agent-files.ts 의 resolveAgentFile 과 같은 방식)로
// 그 작업 폴더 밖의 어떤 파일도 "그 작업의 산출물"로 위장할 수 없게 한다.

export type ArtifactKind = 'image' | 'video' | 'file'

export interface ArtifactMeta {
  id: string                 // 'art_' + 12 hex
  taskId: string
  name: string               // 디스크 파일명 = id + '.' + format
  path: string                // 절대 경로
  kind: ArtifactKind
  format: string              // 'png'|'jpeg'|'webp'|'gif'|'mp4'|'bin' ...
  mime: string
  bytes: number
  sha256: string
  width?: number              // 이미지일 때만
  height?: number
  sourceUrl: string           // 원본 URL. blob:/data: 는 80자로 축약 저장
  sourcePageUrl: string
  sourceTabId: string
  sourceFrameUrl?: string
  capturedAt: number          // epoch ms
  origin: 'page-capture' | 'download-import'
  label?: string              // 사람이 읽는 설명(선택)
}

export type CaptureCode =
  | 'empty' | 'not-image' | 'too-large' | 'timeout' | 'cancelled'
  | 'fetch-failed' | 'scope' | 'io'

export interface CaptureResult { ok: boolean; meta?: ArtifactMeta; error?: string; code?: CaptureCode }

export interface ImageProbe {
  ok: boolean
  format?: 'png' | 'jpeg' | 'webp' | 'gif'
  mime?: string
  width?: number
  height?: number
  reason?: string              // 실패 사유(한국어)
}

/** 50MB — CaptureResult 의 'too-large' 판정 상한. 산출물은 스크린샷·짤 수준을 넘지 않는다. */
const MAX_BYTES = 50 * 1024 * 1024

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// 경로
// ---------------------------------------------------------------------------

export function artifactsRoot(): string {
  return path.join(app.getPath('userData'), 'agent-artifacts')
}

/**
 * taskId 를 폴더명으로 안전화한다. 목적은 경로 이탈 차단이지 예쁜 이름이 아니라서,
 * 허용 문자 밖은 전부 '_' 로 뭉갠다(디코딩·정규화 우회 여지를 남기지 않는다).
 */
function safeTaskId(taskId: string): string {
  const raw = typeof taskId === 'string' ? taskId : ''
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return cleaned || 'unknown'
}

export function taskArtifactDir(taskId: string): string {
  const dir = path.join(artifactsRoot(), safeTaskId(taskId))
  try { mkdirSync(dir, { recursive: true } ) } catch { /* 다음 파일 쓰기 시점에 다시 시도된다 */ }
  return dir
}

function metaFile(taskId: string): string {
  return path.join(taskArtifactDir(taskId), '_meta.json')
}

// ---------------------------------------------------------------------------
// 메타 목록 — 작업 폴더당 `_meta.json` 배열 하나. 동기 read/write, tmp+rename 로 원자적.
// (json-store.ts 의 디바운스 방식은 여기서 과하다 — 캡처는 드물게 일어나고 매번 즉시 확정돼야 한다.)
// ---------------------------------------------------------------------------

function loadMetaList(taskId: string): ArtifactMeta[] {
  const file = metaFile(taskId)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    if (!Array.isArray(parsed)) {
      console.warn(`[ai] 산출물 메타(${taskId})가 배열이 아닙니다 — 빈 목록으로 시작합니다.`)
      return []
    }
    return parsed as ArtifactMeta[]
  } catch (err) {
    // 깨진 _meta.json 은 조용히 빈 배열로 시작한다 — 그 폴더의 다른 파일(실제 산출물 바이트)은
    // 절대 건드리지 않는다. 다음 캡처가 목록을 다시 쌓아 올린다.
    console.warn(`[ai] 산출물 메타(${taskId})를 읽지 못했습니다 — 빈 목록으로 시작합니다.`, msgOf(err))
    return []
  }
}

/** 실패하면 던진다 — 호출자(saveArtifactBytes)가 code:'io' 로 변환한다. */
function saveMetaList(taskId: string, list: ArtifactMeta[]): void {
  const file = metaFile(taskId)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(list), 'utf-8')
  renameSync(tmp, file)
}

export function listArtifacts(taskId: string): ArtifactMeta[] {
  return loadMetaList(taskId).slice().sort((a, b) => b.capturedAt - a.capturedAt)
}

export function getArtifact(taskId: string, id: string): ArtifactMeta | null {
  return loadMetaList(taskId).find((m) => m.id === id) ?? null
}

/**
 * 업로드용 실제 경로. agent-files.ts 의 resolveAgentFile 과 같은 경계 검사(realpath 후
 * path.relative 로 '..'·절대경로 판정) — 메타가 가리키는 경로가 심링크 등으로 그 작업 폴더
 * 밖을 가리키게 됐어도 반환하지 않는다.
 */
export function resolveArtifactPath(taskId: string, id: string): string | null {
  const meta = getArtifact(taskId, id)
  if (!meta) return null
  try {
    if (!statSync(meta.path).isFile()) return null
    const realFile = realpathSync(meta.path)
    const realDir = realpathSync(taskArtifactDir(taskId))
    const rel = path.relative(realDir, realFile)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
    return realFile
  } catch {
    return null
  }
}

/** 자동 호출 금지 — 사용자 명시 정리용. 그 작업 폴더만 지우고, 루트 자체는 절대 지우지 않는다. */
export function deleteTaskArtifacts(taskId: string): void {
  const dir = taskArtifactDir(taskId)
  const root = artifactsRoot()
  const rel = path.relative(root, dir)
  if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) return // 안전화가 어긋난 경우의 방어선
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// probeImage — 매직 바이트만 믿는다. 확장자·Content-Type 은 위조하기 쉬워 신뢰하지 않는다
// (로그인 리다이렉트·에러 페이지가 이미지 URL 로 HTML 을 돌려주는 실제 사례가 있다).
// 어떤 경로로도 예외를 던지지 않는다 — 전부 { ok:false, reason } 로 돌아간다.
// ---------------------------------------------------------------------------

function dimFail(): ImageProbe {
  return { ok: false, reason: '이미지 치수를 읽지 못했습니다(손상된 파일)' }
}

function skipBomAndSpace(buf: Buffer): Buffer {
  let start = 0
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3
  while (start < buf.length) {
    const c = buf[start]
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) start++
    else break
  }
  return buf.subarray(start)
}

function isPng(buf: Buffer): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (buf.length < 8) return false
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return false
  return true
}

function probePng(buf: Buffer): ImageProbe {
  if (buf.length < 24) return dimFail()
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (!width || !height) return dimFail()
  return { ok: true, format: 'png', mime: 'image/png', width, height }
}

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
}

/**
 * JPEG 는 SOI(FFD8) 뒤로 마커 세그먼트가 이어지고, 치수는 SOFn(FFC0~FFCF, 단 DHT/JPG예약/DAC 인
 * C4·C8·CC 제외) 세그먼트 안에 있다. 길이 없는 마커(SOI/EOI/RSTn/TEM)는 건너뛰고, 그 외엔 세그먼트
 * 길이만큼 전진해 다음 마커로 간다. 0xFF 패딩(마커 코드 앞의 반복된 0xFF)도 감안한다.
 */
function probeJpeg(buf: Buffer): ImageProbe {
  let offset = 2
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue }
    let codePos = offset + 1
    while (codePos < buf.length && buf[codePos] === 0xff) codePos++
    if (codePos >= buf.length) break
    const marker = buf[codePos]
    if (marker === undefined) break
    const markerStart = codePos - 1 // 이 마커의 'FF' 위치 — 세그먼트 필드 오프셋의 기준점
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = codePos + 1
      continue
    }
    const lenPos = codePos + 1
    if (lenPos + 1 >= buf.length) break
    const segLen = buf.readUInt16BE(lenPos)
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const heightPos = markerStart + 5
      const widthPos = markerStart + 7
      if (widthPos + 1 >= buf.length) break
      const height = buf.readUInt16BE(heightPos)
      const width = buf.readUInt16BE(widthPos)
      if (!width || !height) break
      return { ok: true, format: 'jpeg', mime: 'image/jpeg', width, height }
    }
    if (segLen < 2) break // 방어 — 진행이 멈추지 않게(정상 JPEG 라면 이론상 도달하지 않는다)
    offset = codePos + 1 + segLen
  }
  return dimFail()
}

function isWebp(buf: Buffer): boolean {
  if (buf.length < 12) return false
  return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
}

function readUInt24LE(buf: Buffer, offset: number): number {
  const b0 = buf[offset] ?? 0
  const b1 = buf[offset + 1] ?? 0
  const b2 = buf[offset + 2] ?? 0
  return b0 | (b1 << 8) | (b2 << 16)
}

function probeWebp(buf: Buffer): ImageProbe {
  if (buf.length < 16) return dimFail()
  const fourcc = buf.toString('ascii', 12, 16)
  if (fourcc === 'VP8 ') {
    if (buf.length < 30) return dimFail()
    const width = buf.readUInt16LE(26) & 0x3fff
    const height = buf.readUInt16LE(28) & 0x3fff
    if (!width || !height) return dimFail()
    return { ok: true, format: 'webp', mime: 'image/webp', width, height }
  }
  if (fourcc === 'VP8L') {
    if (buf.length < 25) return dimFail()
    const bits = buf.readUInt32LE(21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >>> 14) & 0x3fff) + 1
    return { ok: true, format: 'webp', mime: 'image/webp', width, height }
  }
  if (fourcc === 'VP8X') {
    if (buf.length < 30) return dimFail()
    const width = readUInt24LE(buf, 24) + 1
    const height = readUInt24LE(buf, 27) + 1
    return { ok: true, format: 'webp', mime: 'image/webp', width, height }
  }
  return dimFail()
}

function isGif(buf: Buffer): boolean {
  if (buf.length < 6) return false
  const sig = buf.toString('ascii', 0, 6)
  return sig === 'GIF87a' || sig === 'GIF89a'
}

function probeGif(buf: Buffer): ImageProbe {
  if (buf.length < 10) return dimFail()
  const width = buf.readUInt16LE(6)
  const height = buf.readUInt16LE(8)
  if (!width || !height) return dimFail()
  return { ok: true, format: 'gif', mime: 'image/gif', width, height }
}

export function probeImage(buf: Buffer): ImageProbe {
  try {
    if (!buf || buf.length === 0) return { ok: false, reason: '빈 데이터입니다' }

    // HTML 위장 탐지 — 앞쪽 공백·BOM 을 건너뛰고 처음 몇백 바이트만 아스키로 본다.
    // 실제 이진 이미지의 매직 바이트(0x89, 0xFF, 'RIFF', 'GIF8')는 이 문자열들과 절대 겹치지 않는다.
    const head = skipBomAndSpace(buf).subarray(0, 200).toString('latin1').toLowerCase()
    if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
      return { ok: false, reason: 'HTML 문서입니다(이미지가 아님)' }
    }

    if (isPng(buf)) return probePng(buf)
    if (isJpeg(buf)) return probeJpeg(buf)
    if (isWebp(buf)) return probeWebp(buf)
    if (isGif(buf)) return probeGif(buf)

    return { ok: false, reason: '알 수 없는 이미지 형식입니다' }
  } catch (err) {
    // 어떤 하위 검사든 여기서 걸러진다 — 손상된 파일이 예외로 앱을 흔들면 안 된다.
    console.warn('[ai] probeImage 예외', msgOf(err))
    return { ok: false, reason: '이미지 데이터를 분석하지 못했습니다(손상된 파일)' }
  }
}

// ---------------------------------------------------------------------------
// expect:'any' 일 때(예: 다운로드 가져오기) 형식 검증 없이 URL 확장자만으로 분류.
// ---------------------------------------------------------------------------

const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv'])
const IMAGE_EXT_FORMAT: Record<string, string> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif' }
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  pdf: 'application/pdf', txt: 'text/plain', json: 'application/json', csv: 'text/csv',
  zip: 'application/zip', mp3: 'audio/mpeg', wav: 'audio/wav', svg: 'image/svg+xml',
}

function extOfUrl(url: string): string {
  try {
    if (url.startsWith('data:')) {
      const m = /^data:[a-z]+\/([a-z0-9+.-]+)/i.exec(url)
      return (m?.[1] ?? '').toLowerCase().replace('+xml', '')
    }
    if (url.startsWith('blob:')) return '' // blob: 은 경로가 없다
    const base = new URL(url).pathname.split('/').pop() ?? ''
    const dot = base.lastIndexOf('.')
    if (dot < 0 || dot === base.length - 1) return ''
    const ext = base.slice(dot + 1).toLowerCase()
    return /^[a-z0-9]{1,8}$/.test(ext) ? ext : ''
  } catch {
    return ''
  }
}

function inferFromUrl(url: string): { kind: ArtifactKind; format: string; mime: string } {
  const ext = extOfUrl(url)
  if (VIDEO_EXT.has(ext)) return { kind: 'video', format: ext, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' }
  const imgFormat = IMAGE_EXT_FORMAT[ext]
  if (imgFormat) return { kind: 'image', format: imgFormat, mime: MIME_BY_EXT[imgFormat] ?? 'application/octet-stream' }
  const format = ext || 'bin'
  return { kind: 'file', format, mime: MIME_BY_EXT[format] ?? 'application/octet-stream' }
}

// ---------------------------------------------------------------------------
// 저장
// ---------------------------------------------------------------------------

/** 바이트를 검증하고 저장한다. 이미지면 형식·치수까지 확인. */
export function saveArtifactBytes(args: {
  taskId: string
  data: Buffer
  sourceUrl: string
  sourcePageUrl: string
  sourceTabId: string
  sourceFrameUrl?: string
  expect?: 'image' | 'any'      // 기본 'image'
  label?: string
  origin?: ArtifactMeta['origin']
}): CaptureResult {
  const { taskId, data, sourceUrl } = args
  if (!data || data.length === 0) return { ok: false, code: 'empty', error: '빈 파일입니다' }
  if (data.length > MAX_BYTES) return { ok: false, code: 'too-large', error: '파일이 너무 큽니다(50MB 초과)' }

  const expect = args.expect ?? 'image'
  let kind: ArtifactKind
  let format: string
  let mime: string
  let width: number | undefined
  let height: number | undefined

  if (expect === 'image') {
    const probe = probeImage(data)
    if (!probe.ok || !probe.format || !probe.mime) {
      return { ok: false, code: 'not-image', error: probe.reason ?? '이미지가 아닙니다' }
    }
    kind = 'image'
    format = probe.format
    mime = probe.mime
    width = probe.width
    height = probe.height
  } else {
    const inferred = inferFromUrl(sourceUrl)
    kind = inferred.kind
    format = inferred.format
    mime = inferred.mime
  }

  const id = `art_${randomBytes(6).toString('hex')}`
  const dir = taskArtifactDir(taskId)
  const fileName = `${id}.${format}`
  const filePath = path.join(dir, fileName)

  try {
    const tmp = `${filePath}.${process.pid}.tmp`
    writeFileSync(tmp, data)
    renameSync(tmp, filePath)
  } catch (err) {
    return { ok: false, code: 'io', error: msgOf(err) }
  }

  const sha256 = createHash('sha256').update(data).digest('hex')
  // blob:/data: 는 통째로 저장하면 거대한 base64 가 _meta.json 을 부풀린다 — 어차피 재사용 불가한
  // 일회성 URL 이라 앞부분만 남겨 "어떤 종류였는지" 식별 정보로 충분하다.
  const truncatedSourceUrl = (sourceUrl.startsWith('blob:') || sourceUrl.startsWith('data:'))
    ? sourceUrl.slice(0, 80)
    : sourceUrl

  const meta: ArtifactMeta = {
    id,
    taskId,
    name: fileName,
    path: filePath,
    kind,
    format,
    mime,
    bytes: data.length,
    sha256,
    width,
    height,
    sourceUrl: truncatedSourceUrl,
    sourcePageUrl: args.sourcePageUrl,
    sourceTabId: args.sourceTabId,
    sourceFrameUrl: args.sourceFrameUrl,
    capturedAt: Date.now(),
    origin: args.origin ?? 'page-capture',
    label: args.label,
  }

  try {
    const list = loadMetaList(taskId)
    list.push(meta)
    saveMetaList(taskId, list)
  } catch (err) {
    // 메타가 없으면 아무도 이 파일을 찾을 수 없다(고아 파일) — 방금 쓴 바이트를 되돌린다.
    try { unlinkSync(filePath) } catch { /* ignore */ }
    return { ok: false, code: 'io', error: msgOf(err) }
  }

  return { ok: true, meta }
}

/** 다운로드 엔진이 저장한 파일을 작업 저장소로 **복사**(원본은 지우지 않는다). */
export function importDownloadedFile(args: {
  taskId: string
  filePath: string
  sourceUrl: string
  sourcePageUrl: string
  sourceTabId: string
  expect?: 'image' | 'any'
  label?: string
}): CaptureResult {
  let size: number
  try {
    const st = statSync(args.filePath)
    if (!st.isFile()) return { ok: false, code: 'io', error: '파일이 아닙니다' }
    size = st.size
  } catch (err) {
    return { ok: false, code: 'io', error: msgOf(err) }
  }
  if (size === 0) return { ok: false, code: 'empty', error: '빈 파일입니다' }
  if (size > MAX_BYTES) return { ok: false, code: 'too-large', error: '파일이 너무 큽니다(50MB 초과)' }

  let data: Buffer
  try {
    data = readFileSync(args.filePath) // 사용자의 다운로드 파일 — 여기서도 이후에도 절대 지우지 않는다
  } catch (err) {
    return { ok: false, code: 'io', error: msgOf(err) }
  }

  return saveArtifactBytes({
    taskId: args.taskId,
    data,
    sourceUrl: args.sourceUrl,
    sourcePageUrl: args.sourcePageUrl,
    sourceTabId: args.sourceTabId,
    expect: args.expect,
    label: args.label,
    origin: 'download-import',
  })
}
