// userscript-fixture-server.mjs — 묶음 I(userscript 엔진) 검증 전용 로컬 fixture.
//
// 3개 서버를 띄운다 — 의존성은 node:http/https + openssl(자체 서명 인증서) 뿐, 외부 네트워크 없음.
//   A(http)  — 스크립트가 @match 하는 "본체" 사이트. document-start 타이밍·GM 값 저장·격리·
//              noframes·GM_xmlhttpRequest(같은 origin) 시나리오를 모두 여기서 돌린다.
//   B(http)  — A 와 다른 포트(=다른 origin). "@connect 없이 교차 출처로 요청하면 거부된다" 를
//              검증하기 위한 목적지일 뿐 — 그 시나리오는 네트워크가 실제로 나가기 전에 거부되므로
//              이 서버가 응답을 준비할 필요조차 없지만, 혹시 몰라 최소 응답은 둔다.
//   C(https) — @require/@resource 는 https 만 허용하므로 자체 서명 인증서로 띄운다.
//              앱은 `--ignore-certificate-errors` 로 실행해야 이 서버에 닿는다(검증 전용 스위치).

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { getFreePorts } from './lib/ports.mjs'

function send(res, status, body, contentType = 'text/html; charset=utf-8') {
  res.statusCode = status
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

function page(bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${bodyHtml}</body></html>`
}

function ensureCert(outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  const key = path.join(outDir, 'us-key.pem')
  const cert = path.join(outDir, 'us-cert.pem')
  if (fs.existsSync(key) && fs.existsSync(cert)) return { key, cert }
  const r = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
    '-keyout', key, '-out', cert, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { encoding: 'utf8' })
  if (r.status !== 0 || !fs.existsSync(cert)) return null
  return { key, cert }
}

export async function startUserscriptFixture(outDir) {
  const [portA, portB] = await getFreePorts(2)

  // ── 서버 A(http) — 본체 사이트 ──────────────────────────────────────────
  const serverA = http.createServer((req, res) => {
    let url
    try { url = new URL(req.url, `http://127.0.0.1:${portA}`) } catch { send(res, 400, 'bad'); return }
    const p = url.pathname

    if (p === '/order') {
      send(res, 200, [
        '<!doctype html><html><head><meta charset="utf-8">',
        // 페이지 자신의 head 인라인 스크립트 — document-start 유저스크립트가 진짜로 "이것보다도",
        // 먼저" 도는지 순서를 남긴다(공유 DOM 속성 — 격리 월드에서도 관찰 가능).
        "<script>document.documentElement.setAttribute('data-us-order', (document.documentElement.getAttribute('data-us-order')||'') + 'page-head,')</script>",
        '</head><body>',
        `<iframe src="/order-frame"></iframe>`,
        "<script>document.documentElement.setAttribute('data-us-order', (document.documentElement.getAttribute('data-us-order')||'') + 'page-body,')</script>",
        '</body></html>',
      ].join(''))
      return
    }
    if (p === '/order-frame') {
      send(res, 200, page("<script>document.documentElement.setAttribute('data-frame-loaded','1')</script>frame"))
      return
    }
    if (p === '/values') { send(res, 200, page('values fixture')); return }
    if (p === '/none') {
      send(res, 200, page("<script>window.__pageDefined='X'</script>none fixture"))
      return
    }
    if (p === '/isolated') { send(res, 200, page('isolated fixture')); return }
    if (p === '/menu') { send(res, 200, page('menu fixture')); return }
    if (p === '/xhrtest') { send(res, 200, page('xhr fixture (with @connect)')); return }
    if (p === '/xhrtest2') { send(res, 200, page('xhr fixture (no @connect)')); return }
    if (p === '/requiretest') { send(res, 200, page('require fixture')); return }
    if (p === '/resourcetest') { send(res, 200, page('resource fixture')); return }
    if (p === '/frametest') {
      send(res, 200, page(`main<iframe src="/frametest-child"></iframe>`))
      return
    }
    if (p === '/frametest-child') { send(res, 200, page('child')); return }
    if (p === '/api/echo') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        send(res, 200, JSON.stringify({ ok: true, method: req.method, bodyLen: body.length, body }), 'application/json')
      })
      return
    }
    send(res, 404, 'not found')
  })
  await new Promise((resolve) => serverA.listen(portA, '127.0.0.1', resolve))

  // ── 서버 B(http) — 다른 origin(교차 출처 거부 시나리오의 목적지) ────────────
  const serverB = http.createServer((_req, res) => send(res, 200, page('cross-origin target')))
  await new Promise((resolve) => serverB.listen(portB, '127.0.0.1', resolve))

  // ── 서버 C(https) — @require/@resource ──────────────────────────────────
  const certPaths = ensureCert(outDir)
  let serverC = null
  let portC = 0
  if (certPaths) {
    const bigJs = `/*${'x'.repeat(3 * 1024 * 1024)}*/\nwindow.__bbBigRan=1;\n` // 2MB 상한을 넘기는 payload
    const handler = (req, res) => {
      let url
      try { url = new URL(req.url, 'https://127.0.0.1') } catch { send(res, 400, 'bad'); return }
      const p = url.pathname
      if (p === '/lib.js') { send(res, 200, 'window.__bbRequireRan = (window.__bbRequireRan||0)+1;\n', 'application/javascript'); return }
      if (p === '/lib-404.js') { send(res, 404, 'not found'); return }
      if (p === '/lib-big.js') { send(res, 200, bigJs, 'application/javascript'); return }
      if (p === '/res.txt') { send(res, 200, '안녕 리소스', 'text/plain; charset=utf-8'); return }
      if (p === '/res.bin') { send(res, 200, Buffer.from([1, 2, 3, 4, 5]), 'application/octet-stream'); return }
      send(res, 404, 'not found')
    }
    const [p] = await getFreePorts(1)
    portC = p
    serverC = https.createServer({ key: fs.readFileSync(certPaths.key), cert: fs.readFileSync(certPaths.cert) }, handler)
    await new Promise((resolve) => serverC.listen(portC, '127.0.0.1', resolve))
  }

  return {
    portA, portB, portC,
    hasHttps: !!serverC,
    async close() {
      await Promise.all([
        new Promise((r) => serverA.close(r)),
        new Promise((r) => serverB.close(r)),
        serverC ? new Promise((r) => serverC.close(r)) : Promise.resolve(),
      ])
    },
  }
}
