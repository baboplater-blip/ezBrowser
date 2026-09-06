#!/usr/bin/env node
// stress-page-server.mjs — stress-cdp.mjs 전용 로컬 렌더 부하 테스트 서버.
// 127.0.0.1 loopback, Node 내장 http 모듈만 사용(의존성 0). 외부 사이트 flake 회피 목적으로
// smoke-media-server.mjs 와 동일한 패턴을 따른다.
//
// 라우트:
//   GET /page?n=<i> — 수백 개 DOM 노드 + 작은 인라인(data-uri) 이미지 + setInterval 타이머 1개를
//                      가진 최소 HTML. 대량 탭 개장 시 "진짜 렌더러 자원"을 쓰도록 하기 위함
//                      (about:blank 만 쓰면 렌더 부하가 사실상 0이라 누수·회수 관측이 어려움).

import http from 'node:http'

// 1x1 투명 PNG — "작은 인라인 이미지" 요구사항 충족용. 실제 사진일 필요 없음.
const PIXEL_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function pageHtml(n) {
  const rows = []
  for (let i = 0; i < 400; i++) {
    rows.push(`<div class="row" data-i="${i}">stress row ${i} for page ${n} — ${'x'.repeat(24)}</div>`)
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>stress-page-${n}</title></head><body>
<h1>Stress test page #${n}</h1>
<img src="data:image/png;base64,${PIXEL_PNG_B64}" width="32" height="32" alt="dot">
<div id="rows">${rows.join('')}</div>
<div>tick: <span id="tick">0</span></div>
<script>
  (function () {
    var c = 0
    setInterval(function () {
      c += 1
      var el = document.getElementById('tick')
      if (el) el.textContent = String(c)
    }, 1000)
  })()
</script>
</body></html>`
}

export async function startPageServer() {
  const server = http.createServer((req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      res.statusCode = 400
      res.end('bad request')
      return
    }
    if (url.pathname === '/page') {
      const n = url.searchParams.get('n') ?? '0'
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.statusCode = 200
      res.end(pageHtml(n))
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
    port,
    base,
    pageUrl(n) { return `${base}/page?n=${n}` },
    close() {
      // 열린 keep-alive 연결이 하나라도 있으면 server.close() 의 콜백은 영영 오지 않는다.
      // 검증 대상 앱이 아직 살아 있는 순간에 닫으면 실제로 그렇게 멈춘다(2026-09-06 실측:
      // 스모크가 16/16 통과 후 종료 단계에서 8분 이상 정지 → verify-all 의 회수 시계가 잡음).
      // 연결을 강제로 끊고, 그래도 안 끝나면 짧은 타임아웃으로 진행한다.
      return new Promise((resolve) => {
        let done = false
        const finish = () => { if (!done) { done = true; resolve() } }
        const timer = setTimeout(finish, 3000)
        server.close(() => { clearTimeout(timer); finish() })
        try { server.closeAllConnections?.() } catch { /* ignore */ }
      })
    },
  }
}
