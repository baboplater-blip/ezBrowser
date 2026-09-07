#!/usr/bin/env node
// verify-extension-behavior-cdp.mjs — 크롬 확장이 **로드만 되는 게 아니라 실제로 동작하는가**
//
// 왜 (2026-09-07, 임무 34): `ext-matrix` 는 웹스토어 상위 확장이 **로드되는지**까지만 본다.
// 그런데 1원칙 #2 가 약속한 것은 "그대로 붙는다" 즉 **동작**이다. 로드는 되는데 차단이 안 되거나
// 콘텐츠 스크립트가 안 도는 상태여도 지금 게이트는 초록이었다.
//
// 설계 판단: 웹스토어 CRX 로 검사하면 네트워크·버전에 의존해 게이트가 흔들린다(ext-matrix 가 이미
// 그 역할을 한다). 여기서는 **목적별 시험 확장을 직접 만들어** 우리가 지원해야 하는 API 가
// 실제로 동작하는지 결정론적으로 본다.
//
//   X1 declarativeNetRequest 로 지정 URL 이 실제로 차단된다        (uBO Lite 방식)
//   X2 content script 가 페이지에 주입·실행된다                     (Dark Reader 방식)
//   X3 chrome.storage 가 읽고 쓰인다
//   X4 MV3 service worker 가 살아 동작한다(메시지 왕복)
//   X5 양성 대조 — 확장을 끄면 차단이 사라진다
//
// 사용: node build/verify-extension-behavior-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, getTargetList, waitForPortFree, connectShellSessionReady, ensureSessionReady } from './lib/cdp.mjs'
import { preferFreePort, getFreePorts } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9266, out: path.join(REPO, 'verify-out', 'extension-behavior') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}

// **알려진 공백** — 아직 구현되지 않은 기능. 실패로 세지 않되(게이트를 영구히 빨갛게 만들면
// 결국 무시당한다) 매 실행 크게 보이게 남긴다. 구현되면 이 항목을 check() 로 승격한다.
function gap(id, name, nowOk, detail, why) {
  results.push({ id, name, status: nowOk ? 'PASS' : 'GAP', detail, why })
  console.log(`  ${nowOk ? '✓' : '△'} ${id} ${nowOk ? 'PASS' : 'GAP'} — ${detail}`)
  if (!nowOk) console.log(`      ↳ 알려진 공백: ${why}`)
}

// 시험 페이지: 광고처럼 생긴 스크립트를 하나 불러온다(차단 대상).
const PAGE = `<!doctype html><meta charset="utf-8"><title>확장 시험</title>
<body style="font:16px system-ui;padding:40px">
<h1>확장 시험 페이지</h1><p id="mark">원본</p>
<script>
  window.__adLoaded = false
  window.__adError = false
</script>
<script src="/ads/banner.js" onerror="window.__adError = true"></script>
</body>`

function startPageServer(port) {
  let adHits = 0
  let dynHits = 0
  const seenHeaders = []
  const server = http.createServer((req, res) => {
    // 헤더 시험용 — 서버가 **받은 요청 헤더**를 그대로 돌려준다(요청 헤더 변형 확인).
    if (req.url.startsWith('/echo')) {
      seenHeaders.push({ url: req.url, headers: req.headers })
      res.writeHead(200, { 'content-type': 'application/json', 'x-original': 'from-server' })
      res.end(JSON.stringify({ ok: true, got: req.headers['x-bb-added'] ?? null }))
      return
    }
    if (req.url.startsWith('/dyn/')) {
      dynHits++
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end('window.__dynLoaded = true;')
      return
    }
    if (req.url.startsWith('/ads/')) {
      adHits++
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end('window.__adLoaded = true;')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${port}/`,
    get adHits() { return adHits },
    get dynHits() { return dynHits },
    get seenHeaders() { return seenHeaders },
    resetHits() { adHits = 0; dynHits = 0; seenHeaders.length = 0 },
    async close() {
      await new Promise((r) => {
        try { server.closeAllConnections?.() } catch { /* ignore */ }
        const t = setTimeout(r, 3000)
        server.close(() => { clearTimeout(t); r() })
      })
    },
  })))
}

/** 시험용 확장을 프로필의 extensions 디렉터리에 만든다. */
function writeTestExtension(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: '검증 시험 확장',
    version: '1.0',
    description: '하네스가 만드는 시험용 확장 — 차단·주입·저장소·SW 를 확인한다',
    permissions: ['declarativeNetRequest', 'storage'],
    host_permissions: ['<all_urls>'],
    background: { service_worker: 'sw.js' },
    content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle' }],
    declarative_net_request: {
      rule_resources: [{ id: 'ruleset', enabled: true, path: 'rules.json' }],
    },
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify([
    { id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '/ads/', resourceTypes: ['script'] } },
    // 요청 헤더 변형 — 서버가 받은 헤더로 확인한다.
    { id: 2, priority: 1, condition: { urlFilter: '/echo' },
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'x-bb-added', operation: 'set', value: 'hello-from-dnr' },
        { header: 'x-bb-removed', operation: 'remove' },
      ] } },
    // 응답 헤더 변형 — 페이지가 fetch 로 확인한다.
    { id: 3, priority: 1, condition: { urlFilter: '/echo' },
      action: { type: 'modifyHeaders', responseHeaders: [
        { header: 'x-bb-res', operation: 'set', value: 'set-by-dnr' },
        { header: 'x-original', operation: 'remove' },
      ] } },
  ], null, 2))
  // 콘텐츠 스크립트: 페이지에 흔적을 남긴다(주입·실행 확인).
  fs.writeFileSync(path.join(dir, 'content.js'),
    "document.documentElement.setAttribute('data-ext-injected', 'yes');" +
    "const p = document.getElementById('mark'); if (p) p.textContent = '확장이 바꿈';")
  // 서비스 워커: 저장소에 쓰고, 메시지에 응답한다.
  fs.writeFileSync(path.join(dir, 'sw.js'),
    "chrome.storage.local.set({ swAlive: true, at: Date.now() });" +
    "chrome.runtime.onMessage.addListener((msg, _s, reply) => { reply({ pong: msg && msg.ping }); return true });" +
    // 하네스가 SW 컨텍스트에서 직접 부를 수 있게 전역에 노출한다(동적 룰 시험용).
    "globalThis.__bbAddDynamic = () => chrome.declarativeNetRequest.updateDynamicRules({" +
    "  addRules: [{ id: 100, priority: 2, action: { type: 'block' }," +
    "    condition: { urlFilter: '/dyn/', resourceTypes: ['script', 'xmlhttprequest'] } }] });" +
    "globalThis.__bbRemoveDynamic = () => chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [100] });" +
    "globalThis.__bbHasApi = () => typeof chrome !== 'undefined' && !!chrome.declarativeNetRequest" +
    "  && typeof chrome.declarativeNetRequest.updateDynamicRules === 'function';")
}

const evalIn = async (s, expression, awaitPromise = false) => {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  return r.result?.result?.value ?? r.result?.value
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE}`)
  fs.mkdirSync(args.out, { recursive: true })
  args.port = await preferFreePort(args.port, 'extension-behavior')
  await waitForPortFree(args.port)
  const [pagePort] = await getFreePorts(1)
  const pages = await startPageServer(pagePort)

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true }, startup: { mode: 'newtab', urls: [] },
    adblock: { enabled: false },   // 우리 광고차단을 꺼야 **확장이** 막았는지 알 수 있다
  }, null, 2))
  writeTestExtension(path.join(profileDir, 'extensions', 'harness-test-ext'))

  const logStream = fs.createWriteStream(path.join(args.out, 'app.log'))
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
    await sleep(2500)   // 확장 로드 여유

    const loaded = JSON.parse(await evalIn(shell,
      'window.browserAPI.extensions.list().then(l => JSON.stringify(l))', true).catch(() => '[]') ?? '[]')

    const openPage = async (suffix) => {
      const tabId = await evalIn(shell,
        `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pages.url + suffix)}).then(t => t.id)`, true)
      await sleep(3000)
      const target = (await getTargetList(args.port)).find((t) => String(t.url).startsWith(pages.url + suffix))
      if (!target) return { tabId, page: null }
      const page = await connectSession(target, 'page' + suffix)
      await ensureSessionReady(page)
      return { tabId, page }
    }

    // ---- X1 declarativeNetRequest 차단 ----
    pages.resetHits()
    const { tabId: t1, page: p1 } = await openPage('?x1')
    const state1 = p1 ? {
      adLoaded: await evalIn(p1, 'window.__adLoaded === true'),
      injected: await evalIn(p1, 'document.documentElement.getAttribute("data-ext-injected")'),
      mark: await evalIn(p1, '(document.getElementById("mark")||{}).textContent'),
    } : {}
    // 임무 36 에서 DNR 을 구현해 **GAP 에서 정식 검사로 승격**했다. 이제 실패하면 회귀다.
    check('X1', '확장의 declarativeNetRequest 가 실제로 요청을 차단한다',
      state1.adLoaded === false && pages.adHits === 0,
      `광고 스크립트 로드=${state1.adLoaded} · 서버 적중 ${pages.adHits}회(0 이어야 함) · 확장 ${loaded.length}개 로드`)

    // ---- X2 콘텐츠 스크립트 주입 ----
    check('X2', '콘텐츠 스크립트가 페이지에 주입·실행된다',
      state1.injected === 'yes' && String(state1.mark) === '확장이 바꿈',
      `주입 표식=${state1.injected} · 본문 변경="${state1.mark}"`)

    // ---- X6/X7: modifyHeaders (임무 37) ----
    {
      pages.resetHits()
      // returnByValue 가 객체를 그대로 준다 — 굳이 문자열로 만들지 않는다.
      const r = (p1 ? await evalIn(p1, `(async () => {
        try {
          const res = await fetch('/echo?x6', { headers: { 'x-bb-removed': 'should-be-removed' } })
          const body = await res.json()
          return { got: body && body.got, resHeader: res.headers.get('x-bb-res'), original: res.headers.get('x-original') }
        } catch (e) { return { err: String(e && e.message || e), where: location.href } }
      })()`, true) : null) ?? { err: '페이지 세션 없음' }
      const sent = pages.seenHeaders[0]?.headers ?? {}
      check('X6', '확장 룰이 요청 헤더를 바꾼다(set·remove)',
        String(sent['x-bb-added']) === 'hello-from-dnr' && sent['x-bb-removed'] === undefined,
        `서버가 받은 x-bb-added=${sent['x-bb-added']} · x-bb-removed=${sent['x-bb-removed'] ?? '(없음)'}`
        + ` · 서버 도달 ${pages.seenHeaders.length}회 · got=${r.got} · 오류=${r.err ?? '(없음)'} · 위치=${r.where ?? ''}`)
      check('X7', '확장 룰이 응답 헤더를 바꾼다(set·remove)',
        r.resHeader === 'set-by-dnr' && !r.original,
        `x-bb-res=${r.resHeader} · 지워야 할 x-original=${r.original ?? '(없음)'}`)
    }

    // ---- X3/X4 서비스 워커 + storage ----
    {
      const swTarget = (await getTargetList(args.port))
        .find((t) => String(t.url).startsWith('chrome-extension://') && /sw\.js|service_worker|background/.test(String(t.url) + String(t.title)))
      let swOk = false, storageOk = false, detail = ''
      if (swTarget) {
        const sw = await connectSession(swTarget, 'sw')
        await ensureSessionReady(sw)
        swOk = (await evalIn(sw, 'typeof chrome !== "undefined" && typeof chrome.runtime !== "undefined"')) === true
        const got = await evalIn(sw,
          'new Promise((r) => chrome.storage.local.get(["swAlive"], (v) => r(JSON.stringify(v))))', true)
        storageOk = String(got ?? '').includes('true')
        detail = `SW 타깃=${String(swTarget.url).slice(0, 60)} · chrome.runtime=${swOk} · storage=${got}`
        try { sw.close() } catch { /* ignore */ }
      } else {
        detail = `SW 타깃을 찾지 못함 · 확장 목록 ${JSON.stringify(loaded).slice(0, 120)}`
      }
      check('X4', 'MV3 service worker 가 살아 동작한다', swOk, detail)
      check('X3', 'chrome.storage 가 읽고 쓰인다', storageOk, detail)
    }


    // ---- X8~X9: 동적 룰 API (임무 38) ----
    {
      const swTarget = (await getTargetList(args.port))
        .find((t) => String(t.url).endsWith('/sw.js'))
      let hasApi = null, added = null, removed = null, stored = null, applied = null, preloadRan = null, preloadInPage = null
      let blockedAfterAdd = null, loadedAfterRemove = null
      if (swTarget) {
        const sw = await connectSession(swTarget, 'sw-dyn')
        await ensureSessionReady(sw)
        hasApi = await evalIn(sw, 'globalThis.__bbHasApi ? globalThis.__bbHasApi() : false')
        preloadRan = await evalIn(sw, 'globalThis.__bbDnrPreload === true')
        // 프레임 컨텍스트에서는 실행되는지도 함께 본다 — SW 만 안 되는지 가르기 위해.
        preloadInPage = await evalIn(p1, 'window.__bbDnrPreload === true')
        added = await evalIn(sw, 'globalThis.__bbAddDynamic ? globalThis.__bbAddDynamic().then((r) => JSON.stringify(r)).catch((e) => String(e)) : "함수 없음"', true)
        await sleep(3500)   // Electron 이 디스크에 쓰고 우리 폴링(2초)이 읽을 시간
        stored = await evalIn(sw, 'chrome.declarativeNetRequest.getDynamicRules().then((r) => JSON.stringify(r)).catch((e) => String(e))', true)
        applied = JSON.parse(await evalIn(shell, 'window.browserAPI.extensions.list().then(l => JSON.stringify(l.map(x => x.dnrRules)))', true) ?? '[]')
        // 룰을 넣은 뒤 그 경로를 요청해 본다
        pages.resetHits()
        const r1 = await evalIn(p1, `fetch('/dyn/a.js').then(() => 'ok').catch(() => 'blocked')`, true)
        blockedAfterAdd = pages.dynHits === 0
        removed = await evalIn(sw, 'globalThis.__bbRemoveDynamic ? globalThis.__bbRemoveDynamic().then(() => true).catch((e) => String(e)) : "함수 없음"', true)
        await sleep(3500)   // 제거도 디스크→폴링을 거친다
        pages.resetHits()
        await evalIn(p1, `fetch('/dyn/b.js').then(() => 'ok').catch(() => 'blocked')`, true)
        loadedAfterRemove = pages.dynHits > 0
        try { sw.close() } catch { /* ignore */ }
      }
      check('X8', '확장이 런타임에 넣은 동적 룰이 실제로 차단한다',
        blockedAfterAdd === true,
        `Electron 표면 존재=${hasApi} · 추가 후 서버 도달 0회=${blockedAfterAdd} · 저장된 룰=${String(stored).slice(0, 80)}`)
      check('X9', '동적 룰을 제거하면 다시 통과한다(양성 대조)',
        loadedAfterRemove === true,
        `제거 후 서버 도달=${loadedAfterRemove} — false 면 X8 은 "확장과 무관하게" 통과한 것이다`)
    }

    // X8·X9 까지 쓰고 나서 닫는다(앞에서 닫으면 그 뒤 검사가 세션을 잃는다).
    try { p1?.close() } catch { /* ignore */ }

    // ---- X5 양성 대조: 확장을 끄면 차단이 사라진다 ----
    {
      const id = loaded[0]?.id
      if (id) {
        await evalIn(shell, `window.browserAPI.extensions.setEnabled(${JSON.stringify(id)}, false)`, true).catch(() => null)
        await sleep(1500)
      }
      pages.resetHits()
      const { page: p2 } = await openPage('?x5')
      const adLoaded2 = p2 ? await evalIn(p2, 'window.__adLoaded === true') : null
      try { p2?.close() } catch { /* ignore */ }
      // X1 의 **양성 대조** — 확장을 끄면 차단이 사라져야 한다.
      // 이게 없으면 X1 은 "확장과 무관하게 요청이 안 갔을" 가능성과 구분되지 않는다.
      check('X5', '확장을 끄면 차단이 사라진다(X1 의 양성 대조)',
        adLoaded2 === true || pages.adHits > 0,
        `광고 로드=${adLoaded2} · 서버 적중 ${pages.adHits}회`)
    }
  } catch (err) {
    check('FATAL', '하네스 실행', false, err.message)
  } finally {
    try { shell?.close() } catch { /* ignore */ }
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {}); b.close()
    } catch { /* ignore */ }
    await sleep(1500)
    try { child.kill() } catch { /* ignore */ }
    await pages.close()
  }

  fs.writeFileSync(path.join(args.out, 'extension-behavior-results.json'), JSON.stringify(results, null, 2))
  console.log('\n===== verify-extension-behavior 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL')
  const gaps = results.filter((r) => r.status === 'GAP')
  console.log(`PASS=${results.length - fail.length - gaps.length} FAIL=${fail.length} GAP=${gaps.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  for (const g of gaps) console.log(`GAP ${g.id}: ${g.why}`)
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
