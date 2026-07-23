import { net, type Session } from 'electron'
import { createDecipheriv } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createWriteStream, type WriteStream } from 'node:fs'

/**
 * yt-dlp 없이 동작하는 네이티브 HLS(.m3u8) 다운로더.
 *  - master 플레이리스트면 최고 대역폭 variant 를 고른다.
 *  - media 플레이리스트의 세그먼트를 (탭 세션 쿠키 + Referer 로) 받아 순서대로 병합한다.
 *  - AES-128 암호화 세그먼트는 키를 받아 복호화한다(aes-128-cbc).
 *  - fMP4(#EXT-X-MAP) 면 init + m4s 를 합쳐 .mp4, 아니면 TS 를 합쳐 .ts 로 저장.
 * ffmpeg 불필요: TS 바이트 연결은 그대로 재생 가능한 MPEG-TS, fMP4 연결은 유효한 fragmented MP4.
 */

const SEGMENT_CONCURRENCY = 6
// 완료됐지만 아직 못 쓴(순서 대기) 세그먼트 버퍼 상한 — 느린 세그먼트 하나로 메모리 폭증 방지.
const MAX_AHEAD = SEGMENT_CONCURRENCY * 3
const FETCH_TIMEOUT_MS = 20000
const MAX_SEG_RETRIES = 3

export interface HlsProgress {
  receivedBytes: number // 받은(fetch) 누적 바이트 — 진행률 표시용(쓰기보다 약간 앞섬)
  writtenBytes: number // 파일에 실제 기록한 누적 바이트 — 이어받기 truncate 기준(정합성)
  totalSegments: number
  doneSegments: number
}

interface HlsKey {
  method: string // 'NONE' | 'AES-128' | 'SAMPLE-AES'
  uri?: string
  iv?: Buffer
}

interface HlsSegment {
  url: string
  seq: number
  key?: HlsKey
}

interface MediaPlaylist {
  segments: HlsSegment[]
  mapUrl?: string // #EXT-X-MAP (fMP4 init segment)
  isFmp4: boolean
}

export function resolveUrl(base: string, rel: string): string {
  try { return new URL(rel, base).href } catch { return rel }
}

function hexToBuffer(hex: string): Buffer {
  const clean = hex.replace(/^0x/i, '')
  return Buffer.from(clean, 'hex')
}

/** media sequence number → 16바이트 BE IV (EXT-X-KEY 에 IV 가 없을 때의 기본값, RFC 8216) */
function seqToIv(seq: number): Buffer {
  const iv = Buffer.alloc(16)
  // seq 는 최대 2^53(JS safe int). 하위 64비트(상위32+하위32)에 BE 기록 — 긴 시퀀스도 정확.
  iv.writeUInt32BE(Math.floor(seq / 0x100000000) >>> 0, 8)
  iv.writeUInt32BE(seq >>> 0, 12)
  return iv
}

export function netGet(args: { url: string; session: Session; headers?: Record<string, string>; asText: boolean }): Promise<{ ok: boolean; status: number; body: Buffer }> {
  return new Promise((resolve) => {
    const req = net.request({ url: args.url, method: 'GET', session: args.session, useSessionCookies: true })
    if (args.headers) {
      for (const [k, v] of Object.entries(args.headers)) {
        const lk = k.toLowerCase()
        if (v && lk !== 'host' && lk !== 'content-length') {
          try { req.setHeader(k, v) } catch { /* ignore */ }
        }
      }
    }
    let settled = false
    const chunks: Buffer[] = []
    // 총 타임아웃이 아니라 idle 타임아웃 — 데이터가 오는 동안은 계속 리셋되고,
    // 마지막 수신 이후 FETCH_TIMEOUT_MS 동안 무소식일 때만 abort(큰 세그먼트/느린 회선 대응).
    let timer: ReturnType<typeof setTimeout> | undefined
    const resetTimer = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { req.abort() } catch { /* ignore */ }
        resolve({ ok: false, status: 0, body: Buffer.alloc(0) })
      }, FETCH_TIMEOUT_MS)
    }
    resetTimer() // 응답 자체가 안 오는 경우도 동일하게 idle 타임아웃으로 처리
    req.on('response', (resp) => {
      const status = resp.statusCode
      resetTimer() // 응답 헤더 도착 = 진행 신호
      resp.on('data', (c: Buffer) => {
        chunks.push(c)
        resetTimer() // 데이터 수신마다 idle 타이머 리셋
      })
      resp.on('end', () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve({ ok: status >= 200 && status < 300, status, body: Buffer.concat(chunks) })
      })
      resp.on('error', () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve({ ok: false, status, body: Buffer.alloc(0) })
      })
    })
    req.on('error', () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ ok: false, status: 0, body: Buffer.alloc(0) })
    })
    req.end()
  })
}

interface VariantPick {
  url: string
  streamInfLine: string // 선택된 variant 의 #EXT-X-STREAM-INF 원본 라인(오디오 그룹 검사용)
}

/** master 플레이리스트면 최고 대역폭 variant 를, media 면 null 을 반환 */
function pickBestVariant(text: string, baseUrl: string): VariantPick | null {
  if (!/#EXT-X-STREAM-INF/i.test(text)) return null
  const lines = text.split(/\r?\n/)
  let best: { bw: number; url: string; line: string } | null = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line || !/^#EXT-X-STREAM-INF/i.test(line)) continue
    const bwM = /BANDWIDTH=(\d+)/i.exec(line)
    const bw = bwM ? parseInt(bwM[1]!, 10) : 0
    // 다음 비주석 라인이 variant URL
    let j = i + 1
    while (j < lines.length && (!lines[j] || lines[j]!.startsWith('#'))) j += 1
    const u = lines[j]?.trim()
    if (!u) continue
    if (!best || bw > best.bw) best = { bw, url: resolveUrl(baseUrl, u), line }
  }
  return best ? { url: best.url, streamInfLine: best.line } : null
}

/**
 * master 플레이리스트에 "URI 를 가진" TYPE=AUDIO 렌디션이 하나라도 있는지 검사.
 * URI 없는 TYPE=AUDIO(예: CC 그룹 선언만 있고 실제 오디오는 variant 안에 muxed)는
 * "오디오 분리"를 의미하지 않으므로 여기서 걸러선 안 된다.
 */
function hasSeparateAudioMediaGroup(masterText: string): boolean {
  const lines = masterText.split(/\r?\n/)
  for (const line of lines) {
    if (!line || !/^#EXT-X-MEDIA:/i.test(line)) continue
    if (/TYPE=AUDIO/i.test(line) && /URI="[^"]*"/i.test(line)) return true
  }
  return false
}

function parseMediaPlaylist(text: string, baseUrl: string): MediaPlaylist {
  // single-file HLS(바이트 범위로 하나의 파일을 세그먼트처럼 나눔)는 미지원 —
  // 무시하면 같은 파일을 N번 통째로 받아 이어 붙이는 손상된 결과가 나온다.
  if (/#EXT-X-BYTERANGE/i.test(text)) {
    throw new Error('EXT-X-BYTERANGE not supported (single-file HLS)')
  }
  const lines = text.split(/\r?\n/)
  const segments: HlsSegment[] = []
  let mapUrl: string | undefined
  let curKey: HlsKey | undefined
  let seq = 0
  // #EXT-X-MEDIA-SEQUENCE 가 있으면 시작 시퀀스 보정(IV 기본값 계산용)
  const seqM = /#EXT-X-MEDIA-SEQUENCE:(\d+)/i.exec(text)
  if (seqM) seq = parseInt(seqM[1]!, 10)

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXT-X-KEY')) {
      const method = /METHOD=([A-Z0-9-]+)/i.exec(line)?.[1] ?? 'NONE'
      if (/METHOD=NONE/i.test(line)) { curKey = undefined; continue }
      const uri = /URI="([^"]+)"/i.exec(line)?.[1]
      const ivHex = /IV=(0x[0-9a-f]+)/i.exec(line)?.[1]
      curKey = {
        method,
        uri: uri ? resolveUrl(baseUrl, uri) : undefined,
        iv: ivHex ? hexToBuffer(ivHex) : undefined,
      }
      continue
    }
    if (line.startsWith('#EXT-X-MAP')) {
      const uri = /URI="([^"]+)"/i.exec(line)?.[1]
      if (uri) mapUrl = resolveUrl(baseUrl, uri)
      continue
    }
    if (line.startsWith('#')) continue
    // 비주석 라인 = 세그먼트 URL
    segments.push({
      url: resolveUrl(baseUrl, line),
      seq,
      key: curKey,
    })
    seq += 1
  }
  const isFmp4 = !!mapUrl || segments.some((s) => /\.(m4s|mp4|cmfv|cmfa)(\?|$)/i.test(s.url))
  return { segments, mapUrl, isFmp4 }
}

/** 암호화 세그먼트 복호화(aes-128-cbc). 키는 캐시. */
async function decryptIfNeeded(
  data: Buffer, seg: HlsSegment, session: Session, headers: Record<string, string> | undefined,
  keyCache: Map<string, Buffer>,
): Promise<Buffer> {
  const key = seg.key
  // downloadHls 가 세그먼트 수신 시작 전에 AES-128(+URI 존재) 외 방식은 이미 걸러내므로,
  // 여기선 key 유무만 보면 된다. (uri 는 그 조기 검사로 항상 존재가 보장됨)
  if (!key) return data
  const keyUri = key.uri!
  let keyBytes = keyCache.get(keyUri)
  if (!keyBytes) {
    const res = await netGet({ url: keyUri, session, headers, asText: false })
    if (!res.ok || res.body.length < 16) throw new Error(`HLS key fetch failed (${res.status})`)
    keyBytes = res.body.subarray(0, 16)
    keyCache.set(keyUri, keyBytes)
  }
  const iv = key.iv ?? seqToIv(seg.seq)
  const decipher = createDecipheriv('aes-128-cbc', keyBytes, iv)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

export interface HlsDownloadHandle {
  cancel: () => void
}

/**
 * HLS 를 받아 outPath 로 저장. 진행률은 onProgress 로 통지.
 * @returns 최종 저장 경로(확장자 보정됨)
 */
export async function downloadHls(args: {
  playlistUrl: string
  session: Session
  headers?: Record<string, string>
  outPathNoExt: string
  onProgress?: (p: HlsProgress) => void
  /** 파싱 직후(세그먼트 받기 전) 1회 호출 — 호출부가 이어받기용 descriptor 를 영속화하도록. */
  onStart?: (info: { savePath: string; totalSegments: number; isFmp4: boolean }) => void
  /** 이어받기: 이미 기록한 세그먼트 수. >0 이면 파일에 append 하고 init 재기록을 건너뛴다. */
  resumeFrom?: number
  /** 이어받기: doneSegments 시점의 정확한 파일 바이트 — 이 길이로 truncate 후 append(중복/누락 방지). */
  resumeBytes?: number
  signal: { cancelled: boolean }
}): Promise<{ savePath: string }> {
  const { playlistUrl, session, headers, outPathNoExt, onProgress, onStart, signal } = args
  const resumeFrom = Math.max(0, args.resumeFrom ?? 0)
  const resumeBytes = Math.max(0, args.resumeBytes ?? 0)

  // 1) master → 최고 화질 media 플레이리스트
  const first = await netGet({ url: playlistUrl, session, headers, asText: true })
  if (!first.ok) throw new Error(`playlist fetch failed (HTTP ${first.status})`)
  let mediaUrl = playlistUrl
  let mediaText = first.body.toString('utf8')
  const variantPick = pickBestVariant(mediaText, playlistUrl)
  if (variantPick) {
    // 오디오가 별도 렌디션(#EXT-X-MEDIA TYPE=AUDIO + URI)으로 분리된 master 인지 검사 —
    // muxing 없이 그대로 받으면 무음 영상이 되므로 조기에 폴백시킨다.
    if (hasSeparateAudioMediaGroup(mediaText) && /AUDIO="[^"]+"/i.test(variantPick.streamInfLine)) {
      throw new Error('hls-separate-av (audio in separate rendition, unsupported)')
    }
    mediaUrl = variantPick.url
    const v = await netGet({ url: variantPick.url, session, headers, asText: true })
    if (!v.ok) throw new Error(`variant fetch failed (HTTP ${v.status})`)
    mediaText = v.body.toString('utf8')
  }

  // 2) media 플레이리스트 파싱
  const pl = parseMediaPlaylist(mediaText, mediaUrl)
  if (pl.segments.length === 0) throw new Error('no segments in playlist (live or unsupported)')

  // 세그먼트를 받기 시작하기 전에 미지원 암호화를 조기 검출(SAMPLE-AES 등 → 손상 파일 방지)
  for (const seg of pl.segments) {
    if (!seg.key) continue
    if (!/^AES-128$/i.test(seg.key.method)) {
      throw new Error(`unsupported HLS encryption: ${seg.key.method}`)
    }
    if (!seg.key.uri) {
      throw new Error('unsupported HLS encryption: AES-128 without key URI')
    }
  }

  const ext = pl.isFmp4 ? 'mp4' : 'ts'
  const savePath = `${outPathNoExt}.${ext}`
  const total = pl.segments.length
  onStart?.({ savePath, totalSegments: total, isFmp4: pl.isFmp4 })

  // 이어받기 유효성: 세그먼트 수가 줄었으면(다른 영상/만료) 무효. 또한 파일이 기대 바이트보다
  // 작으면(하드 크래시로 부분 flush 손실) truncate 가 0 패딩으로 손상시키므로 처음부터 받는다.
  let resume = resumeFrom > 0 && resumeFrom < total && resumeBytes > 0
  if (resume) {
    try {
      const sz = (await fs.stat(savePath)).size
      if (sz >= resumeBytes) {
        await fs.truncate(savePath, resumeBytes) // 영속 지점 이후 잔여 바이트 제거(중복 방지)
      } else {
        resume = false // 파일이 기대보다 작음 → 신뢰 불가, 처음부터
      }
    } catch {
      resume = false // 파일 없음/접근 불가 → 처음부터
    }
  }
  const out: WriteStream = createWriteStream(savePath, { flags: resume ? 'a' : 'w' })
  // 디스크 풀·권한 오류 등 스트림 내부 에러는 write 콜백 외로도 올 수 있으므로 잡아둔다.
  let streamError: Error | null = null
  out.on('error', (e) => { streamError = streamError ?? (e instanceof Error ? e : new Error(String(e))) })
  let writtenBytes = resume ? resumeBytes : 0
  const writeChunk = (buf: Buffer): Promise<void> => new Promise((resolve, reject) => {
    if (streamError) { reject(streamError); return }
    out.write(buf, (err) => {
      if (err) { reject(err); return }
      writtenBytes += buf.length
      resolve()
    })
  })

  const keyCache = new Map<string, Buffer>()
  let receivedBytes = resume ? resumeBytes : 0
  let doneSegments = resume ? resumeFrom : 0

  const fetchSegment = async (seg: HlsSegment): Promise<Buffer> => {
    let lastErr: unknown = null
    // 취소는 재시도 경계에서만 검사 — net.request abort 수단이 없어, 진행 중 요청은
    // 최대 FETCH_TIMEOUT_MS 후에야 끊긴다(취소 직후 잠깐 멈춘 듯 보일 수 있음).
    for (let attempt = 0; attempt < MAX_SEG_RETRIES; attempt += 1) {
      if (signal.cancelled) throw new Error('cancelled')
      const res = await netGet({ url: seg.url, session, headers, asText: false })
      if (res.ok && res.body.length > 0) {
        return decryptIfNeeded(res.body, seg, session, headers, keyCache)
      }
      lastErr = new Error(`segment HTTP ${res.status}`)
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)))
    }
    throw lastErr instanceof Error ? lastErr : new Error('segment failed')
  }

  try {
    // 3) init 세그먼트(fMP4) 먼저 — 이어받기면 이미 파일 맨 앞에 기록돼 있으므로 건너뜀
    if (pl.mapUrl && !resume) {
      const initRes = await netGet({ url: pl.mapUrl, session, headers, asText: false })
      if (!initRes.ok) throw new Error(`init segment fetch failed (HTTP ${initRes.status})`)
      receivedBytes += initRes.body.length
      await writeChunk(initRes.body)
    }

    // 4) 세그먼트: 제한 동시성으로 프리페치(버퍼 보관) + 순서대로 flush(메모리 ≈ 동시성×세그먼트)
    // 이어받기면 이미 기록한 resumeFrom 개는 건너뛰고 그 다음부터.
    const buffers = new Map<number, Buffer>()
    let nextToWrite = resume ? resumeFrom : 0
    let nextToFetch = resume ? resumeFrom : 0
    const inFlight = new Set<Promise<void>>()
    // 태스크는 절대 reject 하지 않는다(첫 에러만 fatalError 에 기록) — Promise.race 가 reject 로
    // 깨지거나 straggler 의 unhandledRejection 이 나지 않게. 루프 곳곳에서 fatalError 를 검사해 중단.
    let fatalError: Error | null = null

    const launch = (idx: number): void => {
      const wrapped: Promise<void> = (async () => {
        try {
          const buf = await fetchSegment(pl.segments[idx]!)
          receivedBytes += buf.length
          buffers.set(idx, buf)
        } catch (e) {
          fatalError = fatalError ?? (e instanceof Error ? e : new Error(String(e)))
        }
      })().finally(() => { inFlight.delete(wrapped) })
      inFlight.add(wrapped)
    }

    const flushReady = async (): Promise<void> => {
      while (buffers.has(nextToWrite)) {
        const buf = buffers.get(nextToWrite)!
        buffers.delete(nextToWrite)
        await writeChunk(buf)
        doneSegments += 1
        nextToWrite += 1
        onProgress?.({ receivedBytes, writtenBytes, totalSegments: total, doneSegments })
      }
    }

    while (nextToWrite < total) {
      if (signal.cancelled) throw new Error('cancelled')
      if (fatalError) throw fatalError
      // 동시성 채우기 (단, 미기록 버퍼가 MAX_AHEAD 를 넘지 않게 prefetch 창 제한)
      while (inFlight.size < SEGMENT_CONCURRENCY && nextToFetch < total && (nextToFetch - nextToWrite) < MAX_AHEAD) {
        launch(nextToFetch)
        nextToFetch += 1
      }
      // 하나라도 끝나길 기다린 뒤 순서대로 flush (빈 Set 이면 race 가 영구 pending 이므로 가드)
      if (inFlight.size > 0) await Promise.race(inFlight)
      if (fatalError) throw fatalError
      await flushReady()
    }
    // 잔여 in-flight 완료 후 마지막 flush (태스크는 reject 안 하므로 Promise.all 안전)
    await Promise.all(inFlight)
    if (fatalError) throw fatalError
    await flushReady()
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()))
  }

  if (signal.cancelled) {
    // 신규 다운로드 취소면 부분 파일 정리. 이어받기(resume) 취소면 이전 세션 데이터가 섞여 있으므로
    // 삭제하지 않는다(우리가 만들지 않은 데이터를 지우지 않음).
    if (!resume) {
      try { await fs.unlink(savePath) } catch { /* ignore */ }
    }
    throw new Error('cancelled')
  }
  return { savePath }
}
