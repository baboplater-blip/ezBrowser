#!/usr/bin/env node
// smoke-media-server.mjs — S5(다운로드)·S6(동영상 감지+다운로드) 스모크 시나리오 전용
// 로컬 결정적 테스트 서버. 127.0.0.1 loopback, Node 내장 http 모듈만 사용(의존성 0).
// 외부 사이트를 대상으로 하면 flaky 해지므로, 다운로드 가속·폴백·동영상 감지 경로를
// 결정적으로 재현할 수 있는 최소 서버를 하네스 프로세스 안에 띄운다.
//
// 라우트:
//   GET/HEAD /file.bin      — Range 지원 5MB(기본) 옥텟스트림. 가속(멀티 커넥션) 다운로드 경로 검증용.
//   GET/HEAD /noRange.bin   — Range 미지원 1MB(기본) 옥텟스트림. 단일 다운로드 폴백 경로 검증용.
//   GET      /video.html    — <video src="/clip.mp4"> + fetch() 를 포함한 최소 HTML. 동영상 감지 트리거용.
//   GET/HEAD /clip.mp4      — Range 지원 video/mp4. video-download 후보 감지 + 직접(비-yt-dlp) 다운로드 검증용.
//
// 다운로드 대상 리소스(file.bin/noRange.bin/clip.mp4)는 모두 Content-Disposition 으로
// runId 를 포함한 고유 파일명을 강제한다 — 실사용자 %USERPROFILE%\Downloads 폴더에 이미 있는
// 파일과 충돌(덮어쓰기)하지 않도록 하기 위함이다. app/main/features/downloads 는
// app.getPath('downloads') 를 그대로 쓰고 격리 프로필(--user-data-dir)의 영향을 받지 않으므로
// (settings.downloads.defaultPath 는 스키마만 있고 실제로 쓰이지 않음), 호출부가 다운로드
// 완료 확인 후 반드시 파일을 정리해야 한다.

import http from 'node:http'
import crypto from 'node:crypto'

function makeBuffer(size, seed) {
  const buf = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i++) buf[i] = (i + seed) & 0xff
  return buf
}

/** "bytes=START-END" / "bytes=START-" / "bytes=-N"(suffix) 파싱. 유효하지 않으면 null. */
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

/** Range 지원 응답 — 가속(멀티 커넥션) 다운로드 경로가 요구하는 Accept-Ranges + 206 을 구현. */
function serveRangeable(req, res, buf, contentType, filename, lastModified, etag) {
  const total = buf.length
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Last-Modified', lastModified)
  res.setHeader('ETag', etag)
  if (filename) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
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

/** Range 미지원 응답 — Accept-Ranges 를 보내지 않고 Range 헤더가 와도 항상 전체 200. 단일 다운로드 폴백 경로용. */
function serveNoRange(req, res, buf, contentType, filename, lastModified, etag) {
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Last-Modified', lastModified)
  res.setHeader('ETag', etag)
  if (filename) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Content-Length', String(buf.length))
  if (req.method === 'HEAD') {
    res.statusCode = 200
    res.end()
    return
  }
  res.statusCode = 200
  res.end(buf)
}

export async function startTestServer(opts = {}) {
  const fileBinSize = opts.fileBinSize ?? 5 * 1024 * 1024
  const noRangeSize = opts.noRangeSize ?? 1 * 1024 * 1024
  const clipSize = opts.clipSize ?? 2 * 1024 * 1024

  const runId = crypto.randomBytes(4).toString('hex')
  const buffers = {
    fileBin: makeBuffer(fileBinSize, 0x11),
    noRangeBin: makeBuffer(noRangeSize, 0x37),
    clipMp4: makeBuffer(clipSize, 0x5a),
  }
  const filenames = {
    fileBin: `ezbrowser-smoke-${runId}-file.bin`,
    noRangeBin: `ezbrowser-smoke-${runId}-norange.bin`,
    clipMp4: `ezbrowser-smoke-${runId}-clip.mp4`,
  }
  // 실제 정적 파일 서버를 흉내 — Last-Modified/ETag 없이 서빙하면 Electron 의 native
  // DownloadItem.pause()/resume() 이 "재검증 불가"로 처음부터 다시 받으려 시도할 수 있어
  // (pause 가 매우 이른 시점에 걸리는 소형 다운로드에서) 완료 이벤트가 지연/누락될 위험이 있다.
  const lastModified = new Date().toUTCString()
  const etagFor = (name) => `"${crypto.createHash('sha1').update(name + runId).digest('hex').slice(0, 16)}"`

  const videoHtml = '<!doctype html><html><head><meta charset="utf-8"><title>smoke-video</title></head>'
    + '<body><video id="v" src="/clip.mp4" preload="auto" autoplay muted playsinline '
    + 'style="width:320px;height:180px"></video>'
    + "<script>fetch('/clip.mp4', { cache: 'no-store' }).catch(function () {});</script>"
    + '</body></html>'

  const server = http.createServer((req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      res.statusCode = 400
      res.end('bad request')
      return
    }
    if (url.pathname === '/file.bin') {
      serveRangeable(req, res, buffers.fileBin, 'application/octet-stream', filenames.fileBin, lastModified, etagFor('file.bin'))
      return
    }
    if (url.pathname === '/noRange.bin') {
      serveNoRange(req, res, buffers.noRangeBin, 'application/octet-stream', filenames.noRangeBin, lastModified, etagFor('noRange.bin'))
      return
    }
    if (url.pathname === '/clip.mp4') {
      serveRangeable(req, res, buffers.clipMp4, 'video/mp4', filenames.clipMp4, lastModified, etagFor('clip.mp4'))
      return
    }
    if (url.pathname === '/video.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.statusCode = 200
      res.end(videoHtml)
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
    buffers,
    filenames,
    urls: {
      fileBin: `${base}/file.bin`,
      noRangeBin: `${base}/noRange.bin`,
      videoHtml: `${base}/video.html`,
      clipMp4: `${base}/clip.mp4`,
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
