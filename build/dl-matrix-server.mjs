#!/usr/bin/env node
// dl-matrix-server.mjs — /audit-download (게이트 5) 다운로드 다사이트 매트릭스 전용 로컬 결정적 서버.
// 127.0.0.1 loopback, Node 내장 http + crypto 만 사용(의존성 0). 외부 사이트 의존 없이 11 시나리오
// (progressive mp4 / 토큰CDN octet / HLS 평문·fMP4·AES-128·master / DASH muxed / blob-MSE 감지 /
// 쿠키게이트 / 재시작 이어받기)를 재현한다.
//
// 각 라우트는 앱의 video-download 감지 로직(app/main/features/video-download/index.ts)과
// 다운로드 엔진(downloads/index.ts, multi-connection.ts, hls.ts, dash.ts)이 기대하는 정확한
// 신호(확장자·Content-Type·Content-Length·Accept-Ranges·Set-Cookie 등)를 재현하도록 설계됐다.

import http from 'node:http'
import crypto from 'node:crypto'

function makeBuffer(size, seed) {
  const buf = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i++) buf[i] = (i + seed) & 0xff
  return buf
}

/** 188바이트 패킷 정렬 + 동기바이트(0x47) — "유효해 보이는" MPEG-TS 스텁. */
function makeTsSegment(numPackets, seed) {
  const buf = Buffer.alloc(numPackets * 188)
  for (let p = 0; p < numPackets; p++) {
    const off = p * 188
    buf[off] = 0x47
    for (let i = 1; i < 188; i++) buf[off + i] = (p + i + seed) & 0xff
  }
  return buf
}

function parseRange(rangeHeader, total) {
  if (!rangeHeader) return null
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
  if (!m) return null
  let start = m[1] === '' ? NaN : parseInt(m[1], 10)
  let end = m[2] === '' ? NaN : parseInt(m[2], 10)
  if (Number.isNaN(start) && Number.isNaN(end)) return null
  if (Number.isNaN(start)) {
    start = Math.max(0, total - end)
    end = total - 1
  } else if (Number.isNaN(end)) {
    end = total - 1
  }
  if (start > end || start >= total || start < 0) return null
  end = Math.min(end, total - 1)
  return { start, end }
}

function serveBuffer(req, res, buf, contentType, opts = {}) {
  const total = buf.length
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'no-store')
  if (opts.filename) res.setHeader('Content-Disposition', `attachment; filename="${opts.filename}"`)
  if (req.method === 'HEAD') {
    res.setHeader('Content-Length', String(total))
    res.statusCode = 200
    res.end()
    return
  }
  const range = parseRange(req.headers['range'], total)
  if (range) {
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${total}`)
    res.setHeader('Content-Length', String(range.end - range.start + 1))
    res.end(buf.subarray(range.start, range.end + 1))
  } else {
    res.statusCode = 200
    res.setHeader('Content-Length', String(total))
    res.end(buf)
  }
}

function serveText(res, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'no-store')
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v)
  res.statusCode = 200
  res.end(text)
}

function htmlPage(title, script) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body><p>${title}</p><script>${script}</script></body></html>`
}

/** Range 요청을 정확히 서빙하되 지정한 속도로 드립(drip)한다 — 재시작 이어받기(S11) 시나리오용. */
function serveThrottled(req, res, buf, contentType, opts = {}) {
  const total = buf.length
  const chunkSize = opts.chunkSize ?? 32 * 1024
  const delayMs = opts.delayMs ?? 40
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'no-store')
  if (opts.filename) res.setHeader('Content-Disposition', `attachment; filename="${opts.filename}"`)
  if (req.method === 'HEAD') {
    res.setHeader('Content-Length', String(total))
    res.statusCode = 200
    res.end()
    return
  }
  const range = parseRange(req.headers['range'], total)
  let start = 0
  let end = total - 1
  let status = 200
  if (range) { start = range.start; end = range.end; status = 206 }
  res.statusCode = status
  if (status === 206) res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
  res.setHeader('Content-Length', String(end - start + 1))

  let offset = start
  let destroyed = false
  req.on('close', () => { destroyed = true })
  res.on('close', () => { destroyed = true })

  function pump() {
    if (destroyed) return
    if (offset > end) { try { res.end() } catch { /* ignore */ } return }
    const sliceEnd = Math.min(offset + chunkSize, end + 1)
    const chunk = buf.subarray(offset, sliceEnd)
    offset = sliceEnd
    let ok = true
    try { ok = res.write(chunk) } catch { destroyed = true; return }
    if (offset > end) { try { res.end() } catch { /* ignore */ } return }
    if (ok) setTimeout(pump, delayMs)
    else res.once('drain', () => setTimeout(pump, delayMs))
  }
  pump()
}

export async function startDlMatrixServer(opts = {}) {
  const runId = crypto.randomBytes(4).toString('hex')

  // ── S1: progressive mp4 (Range 지원, native will-download 경로) ──
  const progressiveBuf = makeBuffer(opts.progressiveSize ?? 4 * 1024 * 1024, 0x11)
  const progressiveFilename = `ezb-dlm-${runId}-progressive.mp4`

  // ── S2: 토큰 CDN octet-stream (Content-Disposition 없음, 확장자 없음) ──
  const octetBuf = makeBuffer(opts.octetSize ?? 4 * 1024 * 1024, 0x22)

  // ── S3: HLS 평문(TS) ──
  const plainSegCount = 4
  const plainSegs = Array.from({ length: plainSegCount }, (_, i) => makeTsSegment(1400, 0x30 + i))

  // ── S4: HLS fMP4 ──
  const fmp4Init = makeBuffer(16 * 1024, 0x40)
  const fmp4SegCount = 4
  const fmp4Segs = Array.from({ length: fmp4SegCount }, (_, i) => makeBuffer(256 * 1024, 0x41 + i))

  // ── S5: HLS AES-128 ──
  const aesKey = crypto.randomBytes(16)
  const aesIv = crypto.randomBytes(16)
  const aesIvHex = `0x${aesIv.toString('hex').toUpperCase()}`
  const aesSegCount = 4
  const aesPlainSegs = Array.from({ length: aesSegCount }, (_, i) => makeTsSegment(1400, 0x50 + i))
  const aesCipherSegs = aesPlainSegs.map((plain) => {
    const cipher = crypto.createCipheriv('aes-128-cbc', aesKey, aesIv)
    return Buffer.concat([cipher.update(plain), cipher.final()])
  })

  // ── S6: HLS master (여러 variant 중 최고 대역폭 선택 검증) ──
  const lowSegs = Array.from({ length: 3 }, (_, i) => makeTsSegment(700, 0x60 + i))
  const highSegs = Array.from({ length: 3 }, (_, i) => makeTsSegment(2800, 0x70 + i))

  // ── S7: DASH muxed (SegmentTemplate, Number 기반) ──
  const dashInit = makeBuffer(16 * 1024, 0x80)
  const dashSegCount = 5
  const dashSegs = Array.from({ length: dashSegCount }, (_, i) => makeBuffer(200 * 1024, 0x81 + i))

  // ── S9: blob/MSE 세그먼트 스니핑 (감지만) ──
  const mseSegCount = 5
  const mseSegs = Array.from({ length: mseSegCount }, (_, i) => makeBuffer(10 * 1024, 0x90 + i))

  // ── S10: 쿠키 게이트 ──
  const cookieName = `dlm_${runId}`
  const cookieValue = 'ok-secret'
  const gateBuf = makeBuffer(opts.gateSize ?? 4 * 1024 * 1024, 0xA0)

  // ── S11: 재시작 이어받기 (throttled, Range 지원) ──
  const resumeBuf = makeBuffer(opts.resumeSize ?? 16 * 1024 * 1024, 0xB0)
  const resumeFilename = `ezb-dlm-${runId}-resume.bin`

  function fullUrl(base, p) { return `${base}${p}` }

  const server = http.createServer((req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      res.statusCode = 400
      res.end('bad request')
      return
    }
    const p = url.pathname

    // ---- S1 progressive ----
    if (p === '/progressive.mp4') {
      serveBuffer(req, res, progressiveBuf, 'video/mp4', { filename: progressiveFilename })
      return
    }

    // ---- S2 token CDN octet ----
    if (p === '/octet.html') {
      serveText(res, htmlPage('octet', `fetch('/octet.bin', { cache: 'no-store' }).catch(function(){});`), 'text/html; charset=utf-8')
      return
    }
    if (p === '/octet.bin') {
      // 의도적으로 Content-Disposition 없음 — 실제 토큰 CDN 흉내
      serveBuffer(req, res, octetBuf, 'application/octet-stream')
      return
    }

    // ---- S3 HLS 평문 ----
    if (p === '/hls/plain.html') {
      serveText(res, htmlPage('hls-plain', `fetch('/hls/plain.m3u8', { cache: 'no-store' }).catch(function(){});`), 'text/html; charset=utf-8')
      return
    }
    if (p === '/hls/plain.m3u8') {
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0']
      for (let i = 0; i < plainSegCount; i++) { lines.push('#EXTINF:4.0,', `/hls/plain-${i}.ts`) }
      lines.push('#EXT-X-ENDLIST')
      serveText(res, lines.join('\n'), 'application/vnd.apple.mpegurl')
      return
    }
    {
      const m = /^\/hls\/plain-(\d+)\.ts$/.exec(p)
      if (m) {
        const idx = Number(m[1])
        const seg = plainSegs[idx]
        if (seg) { serveBuffer(req, res, seg, 'video/mp2t'); return }
      }
    }

    // ---- S4 HLS fMP4 ----
    if (p === '/hls/fmp4.html') {
      serveText(res, htmlPage('hls-fmp4', `fetch('/hls/fmp4.m3u8', { cache: 'no-store' }).catch(function(){});`), 'text/html; charset=utf-8')
      return
    }
    if (p === '/hls/fmp4.m3u8') {
      const lines = [
        '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-MAP:URI="/hls/fmp4-init.mp4"',
      ]
      for (let i = 0; i < fmp4SegCount; i++) { lines.push('#EXTINF:4.0,', `/hls/fmp4-seg-${i}.m4s`) }
      lines.push('#EXT-X-ENDLIST')
      serveText(res, lines.join('\n'), 'application/vnd.apple.mpegurl')
      return
    }
    if (p === '/hls/fmp4-init.mp4') { serveBuffer(req, res, fmp4Init, 'video/mp4'); return }
    {
      const m = /^\/hls\/fmp4-seg-(\d+)\.m4s$/.exec(p)
      if (m) {
        const idx = Number(m[1])
        const seg = fmp4Segs[idx]
        if (seg) { serveBuffer(req, res, seg, 'video/iso.segment'); return }
      }
    }

    // ---- S5 HLS AES-128 ----
    if (p === '/hls/aes.html') {
      serveText(res, htmlPage('hls-aes', `fetch('/hls/aes.m3u8', { cache: 'no-store' }).catch(function(){});`), 'text/html; charset=utf-8')
      return
    }
    if (p === '/hls/aes.m3u8') {
      const lines = [
        '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0',
        `#EXT-X-KEY:METHOD=AES-128,URI="/hls/aes.key",IV=${aesIvHex}`,
      ]
      for (let i = 0; i < aesSegCount; i++) { lines.push('#EXTINF:4.0,', `/hls/aes-${i}.ts`) }
      lines.push('#EXT-X-ENDLIST')
      serveText(res, lines.join('\n'), 'application/vnd.apple.mpegurl')
      return
    }
    if (p === '/hls/aes.key') {
      res.setHeader('Content-Type', 'application/octet-stream')
      res.statusCode = 200
      res.end(aesKey)
      return
    }
    {
      const m = /^\/hls\/aes-(\d+)\.ts$/.exec(p)
      if (m) {
        const idx = Number(m[1])
        const seg = aesCipherSegs[idx]
        if (seg) { serveBuffer(req, res, seg, 'video/mp2t'); return }
      }
    }

    // ---- S6 HLS master ----
    if (p === '/hls/master.html') {
      serveText(res, htmlPage('hls-master', `fetch('/hls/master.m3u8', { cache: 'no-store' }).catch(function(){});`), 'text/html; charset=utf-8')
      return
    }
    if (p === '/hls/master.m3u8') {
      const lines = [
        '#EXTM3U', '#EXT-X-VERSION:3',
        '#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=320x180',
        '/hls/low.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
        '/hls/high.m3u8',
      ]
      serveText(res, lines.join('\n'), 'application/vnd.apple.mpegurl')
      return
    }
    if (p === '/hls/low.m3u8' || p === '/hls/high.m3u8') {
      const isHigh = p === '/hls/high.m3u8'
      const n = isHigh ? highSegs.length : lowSegs.length
      const prefix = isHigh ? 'high' : 'low'
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0']
      for (let i = 0; i < n; i++) { lines.push('#EXTINF:4.0,', `/hls/${prefix}-${i}.ts`) }
      lines.push('#EXT-X-ENDLIST')
      serveText(res, lines.join('\n'), 'application/vnd.apple.mpegurl')
      return
    }
    {
      const m = /^\/hls\/(low|high)-(\d+)\.ts$/.exec(p)
      if (m) {
        const list = m[1] === 'high' ? highSegs : lowSegs
        const seg = list[Number(m[2])]
        if (seg) { serveBuffer(req, res, seg, 'video/mp2t'); return }
      }
    }

    // ---- S7 DASH muxed ----
    if (p === '/dash/muxed.html') {
      serveText(res, htmlPage('dash-muxed', `fetch('/dash/muxed.mpd', { cache: 'no-store' }).catch(function(){});`), 'text/html; charset=utf-8')
      return
    }
    if (p === '/dash/muxed.mpd') {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT${dashSegCount * 2}S" minBufferTime="PT2S">
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video" segmentAlignment="true">
      <Representation id="v0" bandwidth="500000" width="640" height="360" codecs="avc1.4d401e">
        <SegmentTemplate media="seg-$Number$.m4s" initialization="init.mp4" startNumber="1" timescale="1" duration="2"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`
      serveText(res, xml, 'application/dash+xml')
      return
    }
    if (p === '/dash/init.mp4') { serveBuffer(req, res, dashInit, 'video/mp4'); return }
    {
      const m = /^\/dash\/seg-(\d+)\.m4s$/.exec(p)
      if (m) {
        const idx = Number(m[1]) - 1 // startNumber=1
        const seg = dashSegs[idx]
        if (seg) { serveBuffer(req, res, seg, 'video/iso.segment'); return }
      }
    }

    // ---- S9 blob/MSE 감지(다운로드 아님) ----
    if (p === '/mse.html') {
      const script = `
        (async () => {
          for (let i = 0; i < ${mseSegCount}; i++) {
            try { await fetch('/mse/seg-' + i + '.m4s', { cache: 'no-store' }) } catch (e) {}
          }
        })();
      `
      serveText(res, htmlPage('mse-sniff', script), 'text/html; charset=utf-8')
      return
    }
    {
      const m = /^\/mse\/seg-(\d+)\.m4s$/.exec(p)
      if (m) {
        const idx = Number(m[1])
        const seg = mseSegs[idx]
        if (seg) { serveBuffer(req, res, seg, 'application/octet-stream'); return }
      }
    }

    // ---- S10 쿠키 게이트 ----
    if (p === '/gate/login.html') {
      res.setHeader('Set-Cookie', `${cookieName}=${cookieValue}; Path=/`)
      serveText(res, htmlPage('gate-login', `fetch('/gate/media.bin', { cache: 'no-store' }).catch(function(){});`), 'text/html; charset=utf-8', {})
      return
    }
    if (p === '/gate/media.bin') {
      const cookieHeader = req.headers['cookie'] || ''
      const hasCookie = cookieHeader.split(';').map((s) => s.trim()).includes(`${cookieName}=${cookieValue}`)
      if (!hasCookie) {
        res.statusCode = 403
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end('<html><body>forbidden — missing cookie</body></html>')
        return
      }
      serveBuffer(req, res, gateBuf, 'application/octet-stream')
      return
    }

    // ---- S11 재시작 이어받기 ----
    if (p === '/resume/big.bin') {
      serveThrottled(req, res, resumeBuf, 'application/octet-stream', {
        filename: resumeFilename,
        chunkSize: opts.resumeChunkSize ?? 32 * 1024,
        delayMs: opts.resumeDelayMs ?? 45,
      })
      return
    }

    res.statusCode = 404
    res.end('not found')
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const base = `http://127.0.0.1:${port}`

  return {
    runId,
    port,
    base,
    urls: {
      progressive: fullUrl(base, '/progressive.mp4'),
      octetHtml: fullUrl(base, '/octet.html'),
      octetBin: fullUrl(base, '/octet.bin'),
      hlsPlainHtml: fullUrl(base, '/hls/plain.html'),
      hlsPlainM3u8: fullUrl(base, '/hls/plain.m3u8'),
      hlsFmp4Html: fullUrl(base, '/hls/fmp4.html'),
      hlsFmp4M3u8: fullUrl(base, '/hls/fmp4.m3u8'),
      hlsAesHtml: fullUrl(base, '/hls/aes.html'),
      hlsAesM3u8: fullUrl(base, '/hls/aes.m3u8'),
      hlsMasterHtml: fullUrl(base, '/hls/master.html'),
      hlsMasterM3u8: fullUrl(base, '/hls/master.m3u8'),
      hlsHighM3u8: fullUrl(base, '/hls/high.m3u8'),
      dashHtml: fullUrl(base, '/dash/muxed.html'),
      dashMpd: fullUrl(base, '/dash/muxed.mpd'),
      mseHtml: fullUrl(base, '/mse.html'),
      gateLogin: fullUrl(base, '/gate/login.html'),
      gateMedia: fullUrl(base, '/gate/media.bin'),
      resumeBig: fullUrl(base, '/resume/big.bin'),
    },
    expected: {
      progressive: progressiveBuf,
      octet: octetBuf,
      hlsPlain: Buffer.concat(plainSegs),
      hlsFmp4: Buffer.concat([fmp4Init, ...fmp4Segs]),
      hlsAes: Buffer.concat(aesPlainSegs),
      hlsMasterHigh: Buffer.concat(highSegs),
      hlsMasterLow: Buffer.concat(lowSegs),
      dash: Buffer.concat([dashInit, ...dashSegs]),
      gate: gateBuf,
      resume: resumeBuf,
    },
    filenames: {
      progressive: progressiveFilename,
      resume: resumeFilename,
    },
    cookie: { name: cookieName, value: cookieValue },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
