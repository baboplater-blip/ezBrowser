#!/usr/bin/env node
// verify-ipc-trust-cdp.mjs — 내부 통신(IPC) 신뢰 경계 검증 (묶음 E)
//
// 왜: internal.ts(browser:// 전용 API)가 탭 생성 시점의 preload 선택 1회에만 의존해,
// browser:// 로 열린 탭이 외부 사이트로 이동해도 internalAPI 가 그대로 노출됐다(항목 1).
// 또한 tabs/windows/find/groups/omnibox/perf/userchrome/screenshot/video 등 다수의
// IPC 채널이 sender 검증 없이 등록돼 있어, content.js(외부 웹페이지 preload)가 호출할 수
// 있었다면 탭 생성·삭제·화면 캡처 등을 임의로 수행할 수 있었다(항목 2).
//
// 이 하네스가 보는 것:
//   Part A (판정 함수 단위 검사, Electron 미기동) — isTrustedSender / handleTrusted 가
//     신뢰 프로토콜(browser:/file:/devtools:/http://localhost)만 통과시키고 나머지는
//     거부하는지, handleTrusted 로 감싼 핸들러가 미신뢰 발신자에서 실제로 던지는지.
//   Part B (CDP, 패키징된 앱 실제 기동):
//     B1 browser://settings 탭에는 internalAPI 가 노출된다
//     B2 같은 탭이 외부(http) 사이트로 이동하면 internalAPI 가 사라진다 (항목 1 회귀 검사)
//     B2b 그 탭에는 콘텐츠 preload(browserBuild)가 대신 로드된다
//     B3 외부 사이트의 기본(main world) 컨텍스트에는 internalAPI/browserAPI/require 가 전혀 없다
//     B4 신뢰된 외피(chrome shell)는 새로 가드를 두른 채널들을 여전히 정상 호출할 수 있다(회귀 없음)
//     B5 신뢰된 내부 페이지는 perf.report 를 여전히 호출할 수 있다
//
// 사용: node build/verify-ipc-trust-cdp.mjs [--port <n>] [--out <dir>]

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import Module from 'node:module'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  connectSession, connectShellSessionReady, getTargetList, waitForPortFree, sleep,
} from './lib/cdp.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9252, out: path.join(REPO_ROOT, 'verify-out', 'ipc-trust') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const results = []
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}

// ===== Part A — 판정 함수 단위 검사 (Electron 앱 미기동) =====
function runUnitChecks() {
  console.log('\n[Part A] isTrustedSender / handleTrusted 단위 검사')
  const trustPath = path.join(REPO_ROOT, 'app', 'dist', 'main', 'ipc', 'trust.js')
  if (!fs.existsSync(trustPath)) {
    check('U0', 'trust.js 빌드 산출물 존재', false, `${trustPath} 없음 — 먼저 npm run build:main`)
    return
  }
  const fakeIpcMain = { _map: new Map(), handle(ch, fn) { this._map.set(ch, fn) } }
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { ipcMain: fakeIpcMain }
    return originalLoad.apply(this, arguments)
  }
  try {
    const req = createRequire(import.meta.url)
    delete req.cache?.[trustPath]
    const mod = req(trustPath)
    const { isTrustedSender, handleTrusted } = mod

    const mk = (url) => ({ sender: { getURL: () => url } })
    const trustedUrls = [
      'browser://settings', 'file:///C:/app/dist/renderer/index.html',
      'devtools://devtools/bundled/inspector.html', 'http://localhost:5173/',
    ]
    const untrustedUrls = [
      'https://evil.example.com/', 'http://evil.example.com/',
      'http://127.0.0.1:9999/', 'chrome-extension://abcdefg/page.html', '',
    ]
    const trustedOk = trustedUrls.every((u) => isTrustedSender(mk(u)) === true)
    const untrustedOk = untrustedUrls.every((u) => isTrustedSender(mk(u)) === false)
    check('U1', 'isTrustedSender 가 신뢰 프로토콜만 통과시킨다',
      trustedOk && untrustedOk,
      `신뢰 ${trustedUrls.length}/${trustedUrls.length} 통과=${trustedOk} · 미신뢰 ${untrustedUrls.length}/${untrustedUrls.length} 차단=${untrustedOk}`)

    // sender.getURL() 이 던지는 경우(파괴된 webContents 등)에도 fail-closed 인가
    const throwing = { sender: { getURL: () => { throw new Error('destroyed') } } }
    let throwSafe = false
    try { throwSafe = isTrustedSender(throwing) === false } catch { throwSafe = false }
    check('U2', 'sender.getURL() 예외 시에도 fail-closed(거부)', throwSafe, `결과=${throwSafe}`)

    handleTrusted('test:echo', (_e, payload) => ({ ok: true, payload }))
    const wrapped = fakeIpcMain._map.get('test:echo')
    const trustedResult = wrapped(mk('file:///x'), { a: 1 })
    let untrustedThrew = false
    let untrustedMsg = ''
    try { wrapped(mk('https://evil.example.com/'), { a: 1 }) } catch (e) { untrustedThrew = true; untrustedMsg = String(e.message ?? e) }
    check('U3', 'handleTrusted — 신뢰 발신자는 실제 핸들러를 실행한다',
      trustedResult?.ok === true && trustedResult.payload?.a === 1,
      `결과=${JSON.stringify(trustedResult)}`)
    check('U4', 'handleTrusted — 미신뢰 발신자는 핸들러 본문을 실행하지 않고 거부한다',
      untrustedThrew, `던짐=${untrustedThrew} · 메시지="${untrustedMsg}"`)
  } catch (err) {
    check('U-FATAL', 'Part A 실행', false, err?.stack ?? String(err))
  } finally {
    Module._load = originalLoad
  }
}

// ===== Part B — CDP e2e =====
const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>ipc-trust fixture</title></head>
<body><h1>외부 사이트 픽스처</h1><p id="marker">loaded</p></body></html>`

function startFixtureServer(port) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(FIXTURE_HTML)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${port}/`,
    async close() {
      await new Promise((r) => {
        try { server.closeAllConnections?.() } catch { /* ignore */ }
        const t = setTimeout(r, 3000)
        server.close(() => { clearTimeout(t); r() })
      })
    },
  })))
}

async function evaluate(session, expression, timeoutMs = 20_000) {
  const r = await session.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, timeoutMs)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'JS 예외')
  return r.result?.value
}

async function main() {
  fs.mkdirSync(args.out, { recursive: true })
  runUnitChecks()

  if (!fs.existsSync(EXE)) {
    console.error(`exe 없음: ${EXE} — 먼저 npx electron-builder --win --dir`)
    console.log('\n===== verify-ipc-trust 결과 (Part A 만) =====')
    console.table(results.map((r) => ({ ID: r.id, 이름: r.name, 상태: r.status })))
    const failedA = results.filter((r) => r.status !== 'PASS')
    fs.writeFileSync(path.join(args.out, 'ipc-trust-results.json'), JSON.stringify(results, null, 2))
    process.exit(failedA.length ? 1 : 2)
  }

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true, completedAt: Date.now(), version: 'verify-ipc-trust' },
    startup: { mode: 'newtab', urls: [] },
  }, null, 2))

  const [fixturePort] = await getFreePorts(1)
  const fixture = await startFixtureServer(fixturePort)

  args.port = await preferFreePort(args.port, 'verify-ipc-trust-cdp.mjs')
  if (!(await waitForPortFree(args.port))) {
    console.error(`디버그 포트 ${args.port} 사용 중 — 남은 인스턴스를 종료하세요.`)
    await fixture.close()
    process.exit(2)
  }

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`], {
    env, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.pipe(fs.createWriteStream(path.join(args.out, 'app-stdout.log')))
  child.stderr?.pipe(fs.createWriteStream(path.join(args.out, 'app-stderr.log')))

  let shell = null
  let settingsPage = null
  let fixturePage = null
  try {
    shell = await connectShellSessionReady(args.port, { log: (m) => console.log(`[verify-ipc-trust] ${m}`) })
    const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)

    // === B1/B2/B2b/B3: browser://settings → internalAPI → 외부 이동 → internalAPI 사라짐 ===
    await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, 'browser://settings')`)
    let target = null
    {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !target) {
        target = (await getTargetList(args.port)).find((x) => String(x.url).startsWith('browser://settings')) ?? null
        if (!target) await sleep(300)
      }
    }
    if (!target) throw new Error('browser://settings 타깃을 찾지 못함')
    settingsPage = await connectSession(target, 'settings')
    await sleep(1200)

    const b1 = await evaluate(settingsPage, `({
      hasInternal: typeof window.internalAPI !== 'undefined',
      hasBookmarks: !!(window.internalAPI && window.internalAPI.bookmarks),
    })`)
    check('B1', 'browser://settings 탭에는 internalAPI 가 노출된다',
      b1.hasInternal === true && b1.hasBookmarks === true, `hasInternal=${b1.hasInternal} hasBookmarks=${b1.hasBookmarks}`)

    // 이 탭의 tabId 를 찾아 외부 사이트로 이동
    const tabId = await evaluate(shell, `(async () => {
      const list = await window.browserAPI.tabs.list(${JSON.stringify(windowId)})
      const t = list.find((x) => (x.url || '').startsWith('browser://settings'))
      return t ? t.id : null
    })()`)
    if (!tabId) throw new Error('settings 탭 id 를 찾지 못함')

    await evaluate(shell, `window.browserAPI.tabs.navigate(${JSON.stringify(tabId)}, ${JSON.stringify(fixture.url)})`)
    let navigatedTarget = null
    {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !navigatedTarget) {
        navigatedTarget = (await getTargetList(args.port)).find((x) => String(x.url).startsWith(fixture.url)) ?? null
        if (!navigatedTarget) await sleep(300)
      }
    }
    if (!navigatedTarget) throw new Error('외부 사이트로 이동한 타깃을 찾지 못함')
    fixturePage = await connectSession(navigatedTarget, 'fixture')
    await sleep(1200)

    const b2 = await evaluate(fixturePage, `({
      hasInternal: typeof window.internalAPI !== 'undefined',
      hasBrowserAPI: typeof window.browserAPI !== 'undefined',
      hasBrowserBuild: typeof window.browserBuild !== 'undefined',
      version: window.browserBuild ? window.browserBuild.version : null,
      hasRequire: typeof window.require !== 'undefined',
      hasProcess: typeof window.process !== 'undefined',
      marker: document.getElementById('marker') ? document.getElementById('marker').textContent : null,
    })`)
    check('B2', '같은 탭이 외부(http) 사이트로 이동하면 internalAPI 가 사라진다 (항목 1)',
      b2.hasInternal === false, `hasInternal=${b2.hasInternal} · marker="${b2.marker}"`)
    // 참고: WebContentsView 의 preload 는 탭 생성 시 1 회 고정되어(tab-service.ts) 그 탭이 살아있는
    // 동안 모든 문서 로드에서 재사용된다 — 따라서 browser:// 로 만들어진 이 탭이 외부로 이동해도
    // preload 자체는 여전히 internal.js(이번 라운드에서 가드를 추가한 그 스크립트)이고 content.js
    // 로 바뀌지 않는다. 그래서 B2b 는 "처음부터" 외부 URL 로 만든 새 탭이 content.js(browserBuild)
    // 를 정상적으로 받는지를 확인한다 — 이 하네스가 항목 1 수정으로 preload 선택 로직 자체를
    // 건드리지 않았음을 보이는 별도 회귀 검사.
    const freshTabId = await evaluate(shell, `(async () => {
      const t = await window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(fixture.url)})
      return t ? t.id : null
    })()`)
    let freshTarget = null
    {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !freshTarget) {
        const list = await getTargetList(args.port)
        freshTarget = list.find((x) => String(x.url).startsWith(fixture.url) && x.id !== navigatedTarget?.id) ?? null
        if (!freshTarget) await sleep(300)
      }
    }
    if (!freshTarget) throw new Error('처음부터 외부 URL 로 만든 새 탭 타깃을 찾지 못함')
    const freshPage = await connectSession(freshTarget, 'fresh-fixture')
    await sleep(1000)
    const b2b = await evaluate(freshPage, `({
      hasInternal: typeof window.internalAPI !== 'undefined',
      hasBrowserBuild: typeof window.browserBuild !== 'undefined',
      version: window.browserBuild ? window.browserBuild.version : null,
    })`)
    try { freshPage.close() } catch { /* ignore */ }
    check('B2b', '처음부터 외부(http) URL 로 만든 새 탭은 content.js(browserBuild) 를 받고 internalAPI 는 없다',
      b2b.hasBrowserBuild === true && b2b.hasInternal === false,
      `hasBrowserBuild=${b2b.hasBrowserBuild} version=${b2b.version} hasInternal=${b2b.hasInternal}`)
    check('B3', '외부 사이트의 main world 에는 internalAPI/browserAPI/require/process 가 전혀 없다',
      b2.hasInternal === false && b2.hasBrowserAPI === false && b2.hasRequire === false && b2.hasProcess === false,
      `internalAPI=${b2.hasInternal} browserAPI=${b2.hasBrowserAPI} require=${b2.hasRequire} process=${b2.hasProcess}`)

    // === B4: 신뢰된 외피는 새로 가드를 두른 채널을 여전히 정상 호출할 수 있다 (회귀 없음) ===
    const newTabId = await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, 'browser://newtab')`)
    await sleep(800)
    const b4 = await evaluate(shell, `(async () => {
      const out = {}
      try { const uc = await window.browserAPI.userchrome.get(); out.userchrome = typeof uc === 'object' && uc !== null } catch (e) { out.userchrome = 'ERR:' + e.message }
      try { const tl = await window.browserAPI.tabs.list(${JSON.stringify(windowId)}); out.tabsList = Array.isArray(tl) && tl.length > 0 } catch (e) { out.tabsList = 'ERR:' + e.message }
      try { const gl = await window.browserAPI.groups.list(${JSON.stringify(windowId)}); out.groupsList = Array.isArray(gl) } catch (e) { out.groupsList = 'ERR:' + e.message }
      try { const sg = await window.browserAPI.omnibox.suggest('test', ${JSON.stringify(windowId)}); out.omniboxSuggest = Array.isArray(sg) } catch (e) { out.omniboxSuggest = 'ERR:' + e.message }
      try { await window.browserAPI.find.start(${JSON.stringify(newTabId?.id ?? '')}, 'a', {}); await window.browserAPI.find.stop(${JSON.stringify(newTabId?.id ?? '')}); out.find = true } catch (e) { out.find = 'ERR:' + e.message }
      try { const z = await window.browserAPI.page.zoomGet(${JSON.stringify(newTabId?.id ?? '')}); out.pageZoom = z !== undefined } catch (e) { out.pageZoom = 'ERR:' + e.message }
      try { const vs = await window.browserAPI.video.ytdlpStatus(); out.videoStatus = typeof vs === 'object' && vs !== null } catch (e) { out.videoStatus = 'ERR:' + e.message }
      try { const st = await window.browserAPI.adblock.stats(); out.adblockStats = typeof st === 'object' && st !== null } catch (e) { out.adblockStats = 'ERR:' + e.message }
      try { const us = await window.browserAPI.update.status(); out.updateStatus = typeof us === 'object' && us !== null } catch (e) { out.updateStatus = 'ERR:' + e.message }
      try { const ex = await window.browserAPI.extensions.list(); out.extensionsList = Array.isArray(ex) } catch (e) { out.extensionsList = 'ERR:' + e.message }
      return out
    })()`)
    const b4Keys = Object.keys(b4)
    const b4Ok = b4Keys.every((k) => b4[k] === true)
    check('B4', '신뢰된 외피는 가드를 두른 채널을 여전히 정상 호출할 수 있다 (회귀 없음)',
      b4Ok, JSON.stringify(b4))

    // === B5: 신뢰된 내부 페이지는 perf.report 를 여전히 호출할 수 있다 (internalAPI 전용) ===
    await evaluate(shell, `window.browserAPI.tabs.navigate(${JSON.stringify(tabId)}, 'browser://memory')`)
    let perfTarget = null
    {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !perfTarget) {
        perfTarget = (await getTargetList(args.port)).find((x) => String(x.url).startsWith('browser://memory')) ?? null
        if (!perfTarget) await sleep(300)
      }
    }
    if (perfTarget) {
      const perfPage = await connectSession(perfTarget, 'perf')
      await sleep(1000)
      const b5 = await evaluate(perfPage, `(async () => {
        try { const r = await window.internalAPI.perf.report(); return { ok: true, hasReport: typeof r === 'object' } }
        catch (e) { return { ok: false, error: e.message } }
      })()`)
      check('B5', '신뢰된 내부 페이지(browser://memory)는 perf.report 를 호출할 수 있다',
        b5.ok === true, JSON.stringify(b5))
      try { perfPage.close() } catch { /* ignore */ }
    } else {
      check('B5', '신뢰된 내부 페이지(browser://memory)는 perf.report 를 호출할 수 있다', false, 'browser://memory 타깃을 찾지 못함')
    }
  } catch (err) {
    check('FATAL', '하네스 실행', false, err.stack ?? String(err))
  } finally {
    try { settingsPage?.close() } catch { /* ignore */ }
    try { fixturePage?.close() } catch { /* ignore */ }
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close', {}, 5000).catch(() => {})
      b.close()
    } catch { /* ignore */ }
    await sleep(1200)
    try { shell?.close() } catch { /* ignore */ }
    if (child.exitCode === null) {
      try { child.kill() } catch { /* ignore */ }
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    }
    await fixture.close()
  }

  console.log('\n===== verify-ipc-trust 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 이름: r.name, 상태: r.status })))
  const failed = results.filter((r) => r.status !== 'PASS')
  for (const f of failed) console.log(`FAIL ${f.id}: ${f.detail}`)
  fs.writeFileSync(path.join(args.out, 'ipc-trust-results.json'), JSON.stringify(results, null, 2))
  console.log(`PASS=${results.length - failed.length} FAIL=${failed.length} (총 ${results.length})`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify-ipc-trust] 치명적 오류:', err); process.exit(2) })
