#!/usr/bin/env node
/**
 * probe-download — URL 하나가 우리 다운로드 엔진에서 어떻게 처리될지 즉시 진단한다.
 * 앱의 probeUrl + 미디어 분류 로직을 그대로(독립 Node 로) 재현해, 봇 차단 사이트도
 * 터미널에서 빠르게 "받힐지/HTML 인지/HLS 인지/Range 지원/지역차단" 을 가린다.
 *
 * 사용:
 *   node build/probe-download.mjs <url> [referer]
 *   node build/probe-download.mjs https://cdn.example/v.mp4 https://site.example/
 *
 * 종료코드: 0=미디어로 받힘 / 1=미디어 아님(HTML·실패) / 2=인자 오류
 */

const [, , url, referer] = process.argv
if (!url) {
  console.error('usage: node build/probe-download.mjs <url> [referer]')
  process.exit(2)
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'

// 앱 분류 로직과 동일 (video-download/index.ts)
const MANIFEST_EXT = /\.(m3u8|mpd)(\?|$)/i
const VIDEO_EXT = /\.(m3u8|mpd|mp4|webm|mkv|mov)(\?|$)/i
const SEGMENT_EXT = /\.(ts|dts|m4s|cmfv|cmfa|m4v|seg)(\?|$)/i
const OCTET_MEDIA_MIN = 3 * 1024 * 1024

function headers(extra = {}) {
  const h = { 'User-Agent': UA, ...extra }
  if (referer) h.Referer = referer
  return h
}

async function probe(method) {
  const h = headers(method === 'GET' ? { Range: 'bytes=0-0' } : {})
  try {
    const res = await fetch(url, { method, headers: h, redirect: 'follow' })
    const ct = res.headers.get('content-type') || ''
    const cr = res.headers.get('content-range') || ''
    const clen = parseInt(res.headers.get('content-length') || '0', 10) || 0
    const crSize = /\/(\d+)\s*$/.exec(cr)?.[1]
    const total = crSize ? parseInt(crSize, 10) : clen
    const acceptsRanges = res.status === 206 || (res.headers.get('accept-ranges') || '').toLowerCase() === 'bytes'
    // 본문은 읽지 않고 소켓을 해제(cancel) — 대용량 GET 시 본문 수신 방지 + 핸들 정리
    try { await res.body?.cancel() } catch { /* ignore */ }
    return { ok: res.status >= 200 && res.status < 400, status: res.status, ct, total, acceptsRanges }
  } catch (e) {
    return { ok: false, status: 0, ct: '', total: 0, acceptsRanges: false, err: String(e.message || e) }
  }
}

// process.exit() 를 소켓 close 중에 호출하면 Windows libuv assertion 크래시가 나므로,
// exitCode 만 설정하고 이벤트 루프가 자연스레 비워지며 종료하도록 한다.
function finish(code, msg) {
  console.log(msg)
  process.exitCode = code
}

function classify(ct, total) {
  const c = ct.toLowerCase()
  if (MANIFEST_EXT.test(url) || /mpegurl|dash\+xml/i.test(c)) return /\.mpd|dash/i.test(url + c) ? 'dash' : 'hls'
  if (SEGMENT_EXT.test(url) && !VIDEO_EXT.test(url)) return 'segment(제외)'
  if (VIDEO_EXT.test(url) || /^video\//i.test(c)) return /\.mp4/i.test(url) ? 'mp4' : 'video'
  if (c.includes('application/octet-stream') && total >= OCTET_MEDIA_MIN) return 'mp4(octet)'
  return null
}

;(async () => {
  console.log(`\n▶ probe: ${url}`)
  console.log(`  referer: ${referer || '(none)'}\n`)

  let p = await probe('HEAD')
  if (!p.ok || !p.ct) {
    console.log(`  HEAD: ${p.status} ${p.ct || '(no content-type)'} → GET(0-0) 폴백`)
    p = await probe('GET')
  }

  const fmt = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)}GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}MB` : `${n}B`)
  console.log(`  status      : ${p.status}${p.err ? ` (${p.err})` : ''}`)
  console.log(`  content-type: ${p.ct || '(none)'}`)
  console.log(`  size        : ${p.total ? fmt(p.total) : '?'}`)
  console.log(`  ranges      : ${p.acceptsRanges ? 'yes (가속 가능)' : 'no'}`)

  const isHtml = /text\/html|application\/xhtml/i.test(p.ct)
  const kind = classify(p.ct, p.total)

  console.log('')
  if (!p.ok) {
    finish(1, `  ✖ 판정: 실패(HTTP ${p.status}) → yt-dlp 폴백 (지역차단/토큰만료/핫링크면 referer 확인)`)
  } else if (isHtml) {
    finish(1, '  ✖ 판정: HTML(미디어 아님) → yt-dlp 폴백 (referer 누락 시 핫링크 CDN 이 HTML 반환)')
  } else if (kind === 'hls') {
    finish(0, '  ✔ 판정: HLS → 네이티브 HLS 다운로더(세그먼트 병합)')
  } else if (kind === 'dash') {
    finish(0, '  ✔ 판정: DASH → 네이티브 DASH(muxed) / 분리음성 시 yt-dlp 폴백')
  } else if ((kind && kind.startsWith('mp4')) || kind === 'video') {
    finish(0, `  ✔ 판정: ${kind} → 직접 다운로드${p.acceptsRanges ? '(가속)' : ''} (탭 세션 쿠키 + Referer)`)
  } else {
    finish(0, `  △ 판정: 분류 불명(ct=${p.ct}) → downloadMedia 가 받기 시도 후 안 되면 yt-dlp 폴백`)
  }
})()
