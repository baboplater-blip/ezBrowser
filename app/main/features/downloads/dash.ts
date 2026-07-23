import { net, type Session } from 'electron'
import { promises as fs } from 'node:fs'
import { createWriteStream, type WriteStream } from 'node:fs'
import { netGet, resolveUrl } from './hls'

/**
 * yt-dlp 없이 동작하는 네이티브 DASH(.mpd) 다운로더.
 *  - MPD 매니페스트를 파싱해 영상 Representation 중 최고 화질을 고른다.
 *  - SegmentTemplate($Number$/$Time$ + SegmentTimeline 또는 @duration), SegmentList,
 *    단일 BaseURL(SegmentBase) 주소지정을 지원한다.
 *  - init 세그먼트 + 미디어 세그먼트를 순서대로 합쳐 fragmented MP4 로 저장한다.
 *
 * 한계(정직성): DASH 는 보통 영상/음성을 별도 AdaptationSet 으로 나눈다. 별도 음성 트랙이
 * 존재하면 ffmpeg 없이 muxing 이 불가하므로 'dash-separate-av' 로 throw → 호출부가 yt-dlp 로
 * 폴백(소리 없는 영상 방지). muxed(음성 분리 없음) 스트림만 네이티브로 받는다.
 */

const SEGMENT_CONCURRENCY = 6
const MAX_AHEAD = SEGMENT_CONCURRENCY * 3
// SegmentBase/단일 BaseURL(전체 파일 1개) 스트리밍 다운로드용 idle 타임아웃 — hls.ts netGet 과 동일 값.
const FETCH_TIMEOUT_MS = 20000

export interface DashProgress {
  receivedBytes: number
  writtenBytes: number
  totalSegments: number
  doneSegments: number
}

export interface DashDownloadHandle { cancel: () => void }

export class DashSeparateAvError extends Error {
  constructor() { super('dash-separate-av'); this.name = 'DashSeparateAvError' }
}

interface Representation {
  id: string
  bandwidth: number
  width: number
  height: number
  codecs: string
  initUrl?: string
  segmentUrls: string[]
  /** SegmentBase/단일 BaseURL — segmentUrls[0] 하나가 파일 전체. 스트리밍 다운로드로 처리(메모리 버퍼링 회피). */
  isSingleFile?: boolean
}

// ---- XML 속성/요소 파싱 헬퍼 (정규식 기반 — 외부 XML 라이브러리 불필요) ----

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)
  return m?.[1]
}

/** <Name ...>...</Name> 또는 <Name .../> 블록들을 추출. */
function elements(xml: string, name: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${name}\\b[^>]*?/>|<${name}\\b[^>]*?>[\\s\\S]*?</${name}>`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[0])
  return out
}

/** 여는 태그 한 개만(자식 제외) — 속성 읽기용. */
function openTag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}\\b[^>]*?/?>`, 'i').exec(xml)
  return m?.[0]
}

/** ISO-8601 기간(PT1H2M3.5S)을 초로. */
function parseIsoDuration(s?: string): number {
  if (!s) return 0
  const m = /P(?:[\d.]+Y)?(?:[\d.]+M)?(?:[\d.]+D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?/i.exec(s)
  if (!m) return 0
  const h = parseFloat(m[1] ?? '0'), min = parseFloat(m[2] ?? '0'), sec = parseFloat(m[3] ?? '0')
  return h * 3600 + min * 60 + sec
}

/** SegmentTemplate 의 $Number$/$Time$/$RepresentationID$/$Bandwidth$ 치환. */
function fillTemplate(tpl: string, vars: { id: string; bandwidth: number; number?: number; time?: number }): string {
  const pad = (raw: string | number, fmt?: string) => {
    if (!fmt) return String(raw)
    const w = parseInt(fmt.slice(2, -1), 10)
    return String(raw).padStart(w, '0')
  }
  return tpl
    .replace(/\$RepresentationID\$/g, vars.id)
    .replace(/\$Bandwidth(%0\d+d)?\$/g, (_m, f) => pad(vars.bandwidth, f))
    .replace(/\$Number(%0\d+d)?\$/g, (_m, f) => vars.number === undefined ? '' : pad(vars.number, f))
    .replace(/\$Time(%0\d+d)?\$/g, (_m, f) => vars.time === undefined ? '' : pad(vars.time, f))
    .replace(/\$\$/g, '$')
}

interface TimelineEntry { number: number; time: number }

/** SegmentTimeline 의 S(t,d,r) 들을 (number,time) 목록으로 전개. */
function parseTimeline(templateXml: string, startNumber: number): TimelineEntry[] {
  const tl = /[<]SegmentTimeline[>]([\s\S]*?)[<]\/SegmentTimeline[>]/i.exec(templateXml)
  if (!tl) return []
  const entries: TimelineEntry[] = []
  let number = startNumber
  let time = 0
  let first = true
  const sRe = /<S\b[^>]*?\/?>/gi
  let m: RegExpExecArray | null
  while ((m = sRe.exec(tl[1]!)) !== null) {
    const tag = m[0]
    const t = attr(tag, 't')
    const d = parseInt(attr(tag, 'd') ?? '0', 10)
    const r = parseInt(attr(tag, 'r') ?? '0', 10)
    if (t !== undefined && (first || true)) time = parseInt(t, 10)
    first = false
    const repeat = r < 0 ? 0 : r // r<0(=끝까지)는 매니페스트 duration 미상이라 지원 안 함
    for (let i = 0; i <= repeat; i += 1) {
      entries.push({ number, time })
      time += d
      number += 1
    }
  }
  return entries
}

/** 한 Representation 의 init/세그먼트 URL 을 계산. */
function buildRepresentation(repXml: string, asXml: string, base: string, periodSeconds: number): Representation | null {
  const id = attr(repXml, 'id') ?? attr(asXml, 'id') ?? 'rep'
  const bandwidth = parseInt(attr(repXml, 'bandwidth') ?? '0', 10)
  const width = parseInt(attr(repXml, 'width') ?? attr(asXml, 'width') ?? '0', 10)
  const height = parseInt(attr(repXml, 'height') ?? attr(asXml, 'height') ?? '0', 10)
  const codecs = attr(repXml, 'codecs') ?? attr(asXml, 'codecs') ?? ''

  // BaseURL 누적(AS → Rep)
  let repBase = base
  const asBase = elements(asXml, 'BaseURL')[0]
  if (asBase) { const u = asBase.replace(/<\/?BaseURL>/gi, '').trim(); if (u) repBase = resolveUrl(repBase, u) }
  const repBaseEl = elements(repXml, 'BaseURL')[0]
  if (repBaseEl) { const u = repBaseEl.replace(/<\/?BaseURL>/gi, '').trim(); if (u) repBase = resolveUrl(repBase, u) }

  // SegmentTemplate (Rep 우선, 없으면 AS)
  const tmplXml = elements(repXml, 'SegmentTemplate')[0] ?? openTag(repXml, 'SegmentTemplate')
    ?? elements(asXml, 'SegmentTemplate')[0] ?? openTag(asXml, 'SegmentTemplate')

  if (tmplXml) {
    const media = attr(tmplXml, 'media')
    const initialization = attr(tmplXml, 'initialization')
    const startNumber = parseInt(attr(tmplXml, 'startNumber') ?? '1', 10)
    const timescale = parseInt(attr(tmplXml, 'timescale') ?? '1', 10)
    const duration = parseInt(attr(tmplXml, 'duration') ?? '0', 10)
    if (!media) return null

    const initUrl = initialization
      ? resolveUrl(repBase, fillTemplate(initialization, { id, bandwidth }))
      : undefined

    const segmentUrls: string[] = []
    const timeline = parseTimeline(tmplXml, startNumber)
    if (timeline.length > 0) {
      for (const e of timeline) {
        segmentUrls.push(resolveUrl(repBase, fillTemplate(media, { id, bandwidth, number: e.number, time: e.time })))
      }
    } else if (duration > 0 && periodSeconds > 0) {
      const segSec = duration / timescale
      const count = Math.max(1, Math.ceil(periodSeconds / segSec))
      for (let i = 0; i < count; i += 1) {
        segmentUrls.push(resolveUrl(repBase, fillTemplate(media, { id, bandwidth, number: startNumber + i })))
      }
    } else {
      return null // 세그먼트 수를 결정할 수 없음
    }
    return { id, bandwidth, width, height, codecs, initUrl, segmentUrls }
  }

  // SegmentList
  const listXml = elements(repXml, 'SegmentList')[0] ?? elements(asXml, 'SegmentList')[0]
  if (listXml) {
    const initEl = openTag(listXml, 'Initialization')
    const initSrc = initEl ? attr(initEl, 'sourceURL') : undefined
    const initUrl = initSrc ? resolveUrl(repBase, initSrc) : undefined
    const segmentUrls: string[] = []
    for (const su of elements(listXml, 'SegmentURL')) {
      const m = attr(su, 'media')
      if (m) segmentUrls.push(resolveUrl(repBase, m))
    }
    if (segmentUrls.length === 0) return null
    return { id, bandwidth, width, height, codecs, initUrl, segmentUrls }
  }

  // SegmentBase / 단일 BaseURL — 전체 파일 하나가 곧 세그먼트(스트리밍 경로로 처리)
  return { id, bandwidth, width, height, codecs, initUrl: undefined, segmentUrls: [repBase], isSingleFile: true }
}

interface ParsedMpd {
  video: Representation[]
  hasSeparateAudio: boolean
}

export function parseMpd(text: string, manifestUrl: string): ParsedMpd {
  // 매니페스트·MPD·Period 레벨 BaseURL 누적
  let base = manifestUrl
  const mpdOpen = openTag(text, 'MPD') ?? ''
  const mpdDur = parseIsoDuration(attr(mpdOpen, 'mediaPresentationDuration'))
  // MPD-level BaseURL 은 첫 <Period> 등장 이전 구간에서만 찾는다 — 그렇지 않으면
  // AdaptationSet/Representation 레벨에만 있는 BaseURL 이 "문서 전체의 첫 BaseURL"로
  // 오매치돼 글로벌 base 로 잘못 적용(경로 이중 적용 → 404)되는 문제가 있었다.
  const periodIdx = text.search(/<Period[\s>]/i)
  const preamble = periodIdx === -1 ? text : text.slice(0, periodIdx)
  const mpdBase = elements(preamble, 'BaseURL')[0]
  if (mpdBase) { const u = mpdBase.replace(/<\/?BaseURL>/gi, '').trim(); if (u) base = resolveUrl(base, u) }

  const periods = elements(text, 'Period')
  if (periods.length > 1) {
    // 멀티피리어드 VOD 는 첫 Period 만 받는다(다음 라운드 보강 대상) — 조용히 잘리지 않도록 로그만.
    console.warn('[dash] multi-period MPD — 첫 Period 만 다운로드됩니다')
  }
  const periodXml = periods[0] ?? text
  const periodOpen = openTag(periodXml, 'Period') ?? ''
  const periodSeconds = parseIsoDuration(attr(periodOpen, 'duration')) || mpdDur

  const video: Representation[] = []
  let hasSeparateAudio = false

  for (const asXml of elements(periodXml, 'AdaptationSet')) {
    const asOpen = openTag(asXml, 'AdaptationSet') ?? ''
    const mime = (attr(asOpen, 'mimeType') ?? attr(asOpen, 'contentType') ?? '').toLowerCase()
    const reps = elements(asXml, 'Representation')
    const repMimes = reps.map((r) => (attr(r, 'mimeType') ?? '').toLowerCase())
    const isAudio = mime.startsWith('audio') || attr(asOpen, 'contentType') === 'audio'
      || repMimes.some((m) => m.startsWith('audio'))
    const isVideo = mime.startsWith('video') || attr(asOpen, 'contentType') === 'video'
      || repMimes.some((m) => m.startsWith('video'))

    if (isAudio && !isVideo) { if (reps.length > 0) hasSeparateAudio = true; continue }
    if (!isVideo) continue

    for (const repXml of reps) {
      const rep = buildRepresentation(repXml, asXml, base, periodSeconds)
      if (rep && rep.segmentUrls.length > 0) video.push(rep)
    }
  }
  return { video, hasSeparateAudio }
}

/**
 * SegmentBase/단일 BaseURL(전체 파일 1개) 스트리밍 다운로드.
 * fetchSeg 처럼 전체를 메모리 Buffer 로 모으지 않고, 받는 즉시(청크 단위) 파일에 순서대로 기록한다.
 * Electron 의 IncomingMessage 타입에는 pause()/resume() 이 노출돼 있지 않으므로, 청크마다
 * Promise 체인으로 이어 붙여 쓰기 순서를 보장한다(간단한 순차 기록 방식의 backpressure).
 */
function downloadSingleFileStream(args: {
  url: string
  session: Session
  headers?: Record<string, string>
  writeChunk: (buf: Buffer) => Promise<void>
  onProgress: (bytes: number) => void
  signal: { cancelled: boolean }
}): Promise<void> {
  const { url, session, headers, writeChunk, onProgress, signal } = args
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET', session, useSessionCookies: true })
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        const lk = k.toLowerCase()
        if (v && lk !== 'host' && lk !== 'content-length') {
          try { req.setHeader(k, v) } catch { /* ignore */ }
        }
      }
    }
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (err?: Error): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (err) reject(err); else resolve()
    }
    // 응답이 진행 중이어도 무조건 끊기지 않게 — 마지막 수신(또는 쓰기 완료) 이후
    // FETCH_TIMEOUT_MS 동안 무소식일 때만 abort.
    const resetTimer = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        try { req.abort() } catch { /* ignore */ }
        settle(new Error('single-file stream idle timeout'))
      }, FETCH_TIMEOUT_MS)
    }
    resetTimer()
    req.on('response', (resp) => {
      const status = resp.statusCode
      if (status < 200 || status >= 300) {
        try { req.abort() } catch { /* ignore */ }
        settle(new Error(`single-file segment HTTP ${status}`))
        return
      }
      resetTimer()
      // 청크를 순서대로 파일에 쓰기 위한 체인 — 각 청크는 이전 청크의 기록이 끝난 뒤에 기록된다.
      let chain: Promise<void> = Promise.resolve()
      resp.on('data', (chunk: Buffer) => {
        if (settled) return
        if (signal.cancelled) {
          try { req.abort() } catch { /* ignore */ }
          settle(new Error('cancelled'))
          return
        }
        chain = chain
          .then(() => writeChunk(chunk))
          .then(() => {
            onProgress(chunk.length)
            resetTimer()
          })
          .catch((e) => {
            try { req.abort() } catch { /* ignore */ }
            settle(e instanceof Error ? e : new Error(String(e)))
          })
      })
      resp.on('end', () => {
        // 마지막 청크까지 실제로 기록된 뒤에 완료 처리(체인이 'end' 이벤트보다 늦게 끝날 수 있음).
        chain.then(() => settle()).catch(() => { /* 이미 위에서 settle 됨 */ })
      })
      resp.on('error', (e: Error) => settle(e instanceof Error ? e : new Error(String(e))))
    })
    req.on('error', (e: Error) => settle(e instanceof Error ? e : new Error(String(e))))
    req.end()
  })
}

/**
 * DASH 를 받아 outPath 로 저장. muxed 스트림만 처리하며, 별도 음성 트랙이 있으면 throw.
 * @returns 최종 저장 경로(.mp4)
 */
export async function downloadDash(args: {
  manifestUrl: string
  session: Session
  headers?: Record<string, string>
  outPathNoExt: string
  onProgress?: (p: DashProgress) => void
  onStart?: (info: { savePath: string; totalSegments: number }) => void
  signal: { cancelled: boolean }
}): Promise<{ savePath: string }> {
  const { manifestUrl, session, headers, outPathNoExt, onProgress, onStart, signal } = args

  const first = await netGet({ url: manifestUrl, session, headers, asText: true })
  if (!first.ok) throw new Error(`manifest fetch failed (HTTP ${first.status})`)
  const parsed = parseMpd(first.body.toString('utf8'), manifestUrl)

  if (parsed.video.length === 0) throw new Error('no video representation in MPD')
  // 별도 음성 트랙이 있으면 ffmpeg 없이 합칠 수 없음 → yt-dlp 폴백 신호
  if (parsed.hasSeparateAudio) throw new DashSeparateAvError()

  // 최고 화질(해상도 → 대역폭) 선택
  const best = parsed.video.sort((a, b) =>
    (b.height - a.height) || (b.bandwidth - a.bandwidth))[0]!

  const savePath = `${outPathNoExt}.mp4`
  const segs = best.segmentUrls
  const total = segs.length
  onStart?.({ savePath, totalSegments: total })

  const out: WriteStream = createWriteStream(savePath, { flags: 'w' })
  let streamError: Error | null = null
  out.on('error', (e) => { streamError = streamError ?? (e instanceof Error ? e : new Error(String(e))) })
  let writtenBytes = 0
  const writeChunk = (buf: Buffer): Promise<void> => new Promise((resolve, reject) => {
    if (streamError) { reject(streamError); return }
    out.write(buf, (err) => { if (err) { reject(err); return } writtenBytes += buf.length; resolve() })
  })

  let receivedBytes = 0
  let doneSegments = 0

  const fetchSeg = async (url: string): Promise<Buffer> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal.cancelled) throw new Error('cancelled')
      const res = await netGet({ url, session, headers, asText: false })
      if (res.ok && res.body.length > 0) return res.body
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)))
    }
    throw new Error(`segment fetch failed: ${url}`)
  }

  try {
    // init 세그먼트
    if (best.initUrl) {
      const initRes = await netGet({ url: best.initUrl, session, headers, asText: false })
      if (!initRes.ok) throw new Error(`init segment fetch failed (HTTP ${initRes.status})`)
      receivedBytes += initRes.body.length
      await writeChunk(initRes.body)
    }

    if (best.isSingleFile) {
      // SegmentBase/단일 BaseURL — 파일 전체를 메모리에 담지 않고 스트리밍으로 직접 받아 기록.
      await downloadSingleFileStream({
        url: segs[0]!,
        session,
        headers,
        signal,
        writeChunk,
        onProgress: (bytes) => {
          receivedBytes += bytes
          onProgress?.({ receivedBytes, writtenBytes, totalSegments: total, doneSegments: 0 })
        },
      })
      doneSegments = 1
      onProgress?.({ receivedBytes, writtenBytes, totalSegments: total, doneSegments })
    } else {
      // 미디어 세그먼트: 제한 동시성 프리페치 + 순서대로 flush
      const buffers = new Map<number, Buffer>()
      let nextToWrite = 0
      let nextToFetch = 0
      const inFlight = new Set<Promise<void>>()
      let fatalError: Error | null = null

      const launch = (idx: number): void => {
        const wrapped: Promise<void> = (async () => {
          try {
            const buf = await fetchSeg(segs[idx]!)
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
        while (inFlight.size < SEGMENT_CONCURRENCY && nextToFetch < total && (nextToFetch - nextToWrite) < MAX_AHEAD) {
          launch(nextToFetch)
          nextToFetch += 1
        }
        if (inFlight.size > 0) await Promise.race(inFlight)
        if (fatalError) throw fatalError
        await flushReady()
      }
      await Promise.all(inFlight)
      if (fatalError) throw fatalError
      await flushReady()
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()))
  }

  if (signal.cancelled) {
    try { await fs.unlink(savePath) } catch { /* ignore */ }
    throw new Error('cancelled')
  }
  return { savePath }
}
