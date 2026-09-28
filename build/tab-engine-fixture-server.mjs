#!/usr/bin/env node
// tab-engine-fixture-server.mjs — 묶음 A(탭 엔진) 검증 전용 로컬 fixture.
// 외부 네트워크 요청 없음. node:http 만 사용(의존성 0).

import http from 'node:http'
import { getFreePorts } from './lib/ports.mjs'

function send(res, status, body, contentType = 'text/html; charset=utf-8') {
  res.statusCode = status
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

export async function startTabEngineFixture() {
  const [port] = await getFreePorts(1)
  const origin = `http://127.0.0.1:${port}`

  const routes = {
    // 명시적 크기를 요구하는 팝업 — OAuth/PG 팝업 흉내. window.opener 로 부모와 통신.
    '/popup-opener': () => `<!doctype html><html><head><meta charset="utf-8"><title>opener</title></head><body>
      <h1>popup-opener</h1>
      <div id="log"></div>
      <script>
        window.__childMsg = null
        window.addEventListener('message', (e) => { window.__childMsg = e.data })
        window.__openSized = () => window.open('${origin}/popup-child', 'sizedPopup', 'width=420,height=360')
        window.__openPlain = () => window.open('${origin}/popup-child', '_blank')
      </script>
    </body></html>`,
    '/popup-child': () => `<!doctype html><html><head><meta charset="utf-8"><title>popup-child</title></head><body>
      <h1>popup-child</h1>
      <script>
        if (window.opener) { window.opener.postMessage('hello-from-child', '*') }
        window.__isPopupChild = true
      </script>
    </body></html>`,

    // beforeunload — 막는 버전 / 막지 않는(no-op) 버전
    '/blocking-unload': () => `<!doctype html><html><head><meta charset="utf-8"><title>blocking</title></head><body>
      <h1>blocking-unload</h1>
      <script>
        window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = '' })
      </script>
    </body></html>`,
    '/noop-unload': () => `<!doctype html><html><head><meta charset="utf-8"><title>noop</title></head><body>
      <h1>noop-unload</h1>
      <script>
        window.addEventListener('beforeunload', () => { /* 막지 않음 */ })
      </script>
    </body></html>`,

    // HTML5 전체화면 — 트러스티드 클릭으로만 성공하는 requestFullscreen() 버튼
    '/fullscreen': () => `<!doctype html><html><head><meta charset="utf-8"><title>fs</title></head><body>
      <button id="go" style="position:absolute;left:20px;top:20px;width:120px;height:40px;">전체화면</button>
      <script>
        document.getElementById('go').addEventListener('click', () => {
          document.documentElement.requestFullscreen().catch(() => {})
        })
      </script>
    </body></html>`,

    '/plain': () => `<!doctype html><html><head><meta charset="utf-8"><title>plain</title></head><body><h1>plain</h1></body></html>`,
  }

  const server = http.createServer((req, res) => {
    let url
    try { url = new URL(req.url, origin) } catch { send(res, 400, 'bad'); return }
    const fn = routes[url.pathname]
    if (!fn) { send(res, 404, 'not found'); return }
    send(res, 200, fn())
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))

  return {
    origin,
    urls: {
      popupOpener: `${origin}/popup-opener`,
      popupChild: `${origin}/popup-child`,
      blocking: `${origin}/blocking-unload`,
      noop: `${origin}/noop-unload`,
      fullscreen: `${origin}/fullscreen`,
      plain: `${origin}/plain`,
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
