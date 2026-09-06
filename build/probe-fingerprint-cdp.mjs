#!/usr/bin/env node
// probe-fingerprint-cdp.mjs — 우리 브라우저가 웹사이트에 어떤 "자동화 흔적"을 노출하는지 실측한다.
// 추측으로 방어 코드를 넣지 않기 위해, 고치기 전에 먼저 잰다. (의존성 0 — Node 22+ 내장 WebSocket/fetch)
//
// 재는 것:
//   1) 요청 헤더 — User-Agent, Sec-CH-UA 계열(클라이언트 힌트). Electron/ezBrowser 토큰이 새는지.
//   2) navigator 표면 — webdriver, userAgentData.brands, plugins/languages/platform.
//   3) 디버거 부착 중(파일 업로드 경로)에 navigator.webdriver 가 바뀌는지 — 업로드마다 노출되면 치명적.
//
// 사용: node build/probe-fingerprint-cdp.mjs

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import {
  CDPSession,
  ensureSessionReady,
  getTargetList,
  isShellTarget,
} from './lib/cdp.mjs'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')
const OUT = path.join(REPO_ROOT, 'verify-out')
const PORT = 9281

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label} (${ms}ms)`)), ms))])
}
async function pollUntil(fn, { timeoutMs = 15000, intervalMs = 300, label = 'condition' } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try { const v = await fn(); if (v) return v } catch { /* retry */ }
    await sleep(intervalMs)
  }
  throw new Error(`pollUntil timeout: ${label}`)
}

async function evaluate(session, expression) {
  const r = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error(`JS exception: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`)
  return r.result?.value
}
const lit = (a) => (a === undefined ? 'undefined' : JSON.stringify(a))
const callApi = (s, p, args = []) => evaluate(s, `window.browserAPI.${p}(${args.map(lit).join(', ')})`)
const shellWindowId = (t) => { try { return new URL(t.url).searchParams.get('windowId') } catch { return null } }

// 요청 헤더를 그대로 기록하는 페이지 서버
function startProbeServer() {
  const seen = []
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, headers: { ...req.headers } })
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('<!doctype html><meta charset="utf-8"><title>fp</title><h1>fingerprint probe</h1><input type="file" id="f" accept="video/*"><input type="file" id="img" accept="image/*">')
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/` }))
  })
}

// 클라이언트 힌트(Sec-CH-UA)는 보안 컨텍스트에서만 나간다 → HTTPS 로도 재야 "안 보내는 것"인지
// "http 라서 안 보낸 것"인지 구분된다. 자체 서명 인증서 + --ignore-certificate-errors 로 로컬 측정.
function ensureCert() {
  const key = path.join(OUT, 'fp-key.pem')
  const cert = path.join(OUT, 'fp-cert.pem')
  if (fs.existsSync(key) && fs.existsSync(cert)) return { key, cert }
  const r = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
    '-keyout', key, '-out', cert, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { encoding: 'utf8' })
  if (r.status !== 0 || !fs.existsSync(cert)) return null
  return { key, cert }
}

function startHttpsProbeServer(certPaths) {
  const seen = []
  return new Promise((resolve) => {
    const server = https.createServer(
      { key: fs.readFileSync(certPaths.key), cert: fs.readFileSync(certPaths.cert) },
      (req, res) => {
        seen.push({ url: req.url, headers: { ...req.headers } })
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end('<!doctype html><meta charset="utf-8"><title>fp-https</title><h1>https probe</h1>')
      },
    )
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `https://127.0.0.1:${server.address().port}/` }))
  })
}

function seedProfile(dir) {
  // --keep-profile: 프로필을 지우지 않고 재사용 → "두 번째 실행"(브랜드 캐시가 있는 상태)을 측정한다.
  if (process.argv.includes('--keep-profile') && fs.existsSync(dir)) return
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ setup: { completed: true, completedAt: Date.now(), version: 'probe' }, startup: { mode: 'newtab', urls: [] } }, null, 2))
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const pa = require(path.join(REPO_ROOT, 'app', 'dist', 'main', 'features', 'ai', 'page-actions.js'))
  const { server, seen, url: pageUrl } = await startProbeServer()
  const profileDir = path.join(OUT, 'fp-profile')
  seedProfile(profileDir)
  const certPaths = ensureCert()
  const httpsSrv = certPaths ? await startHttpsProbeServer(certPaths) : null
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`]
  if (httpsSrv) args.push('--ignore-certificate-errors') // 로컬 자체 서명 인증서 측정용(진단 실행 한정)
  // 실험용 추가 Chromium 인자 — 예: node build/probe-fingerprint-cdp.mjs --arg=--accept-lang=ko-KR,ko,en-US,en
  for (const a of process.argv) if (a.startsWith('--arg=')) args.push(a.slice(6))
  const child = spawn(EXE, args, { env, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.pipe(fs.createWriteStream(path.join(OUT, 'fp-stdout.log')))
  let shell = null; let content = null
  const report = {}
  try {
    const st = await pollUntil(async () => (await getTargetList(PORT)).find(isShellTarget) ?? null, { timeoutMs: 30000, label: 'shell' })
    shell = new CDPSession(st.webSocketDebuggerUrl, 'shell'); await shell.connect(); await ensureSessionReady(shell)
    const windowId = shellWindowId(st)
    const before = new Set((await getTargetList(PORT)).map((t) => t.id))
    await callApi(shell, 'tabs.create', [windowId, pageUrl])
    const ct = await pollUntil(async () => (await getTargetList(PORT)).find((t) => t.type === 'page' && !before.has(t.id) && String(t.url).startsWith(pageUrl)) ?? null, { label: 'content' })
    content = new CDPSession(ct.webSocketDebuggerUrl, 'content'); await content.connect()
    await sleep(600)

    // 1) 요청 헤더
    const req = seen.find((s) => s.url === '/') ?? seen[0]
    report.requestHeaders = req?.headers ?? null

    // 2) navigator 표면
    report.navigator = await evaluate(content, `(function(){
      var uad = null;
      try { uad = navigator.userAgentData ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform } : null } catch(e){}
      return {
        webdriver: navigator.webdriver,
        userAgent: navigator.userAgent,
        appVersion: navigator.appVersion,
        platform: navigator.platform,
        languages: navigator.languages,
        pluginsLength: navigator.plugins ? navigator.plugins.length : -1,
        mimeTypesLength: navigator.mimeTypes ? navigator.mimeTypes.length : -1,
        hardwareConcurrency: navigator.hardwareConcurrency,
        userAgentData: uad,
        hasChromeObj: typeof window.chrome,
        permissionsQuery: typeof navigator.permissions !== 'undefined'
      }
    })()`)

    // 3) 디버거 부착 중(업로드 경로) 에 webdriver 가 바뀌는지 — 파일 첨부를 실제로 한 번 시도해 본다.
    const fakeWc = {
      isDestroyed: () => false,
      executeJavaScript: async (code) => evaluate(content, code),
    }
    // 첨부용 임시 파일
    const tmpVideo = path.join(OUT, 'fp-sample.mp4')
    fs.writeFileSync(tmpVideo, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]))
    // 실제 앱의 setFileInputFiles 는 Electron wc.debugger 를 쓴다 — Node 에서 흉내낼 수 없으므로
    // 여기서는 "CDP 디버거가 붙어 있는 상태"의 navigator.webdriver 만 확인한다(우리 CDP 세션 자체가 부착 상태).
    report.webdriverWhileDebuggerAttached = await evaluate(content, 'navigator.webdriver')

    // 4) 파일 input 이 여러 개일 때 무엇이 선택되는지 — accept 속성 기준 매칭 가능 여부 확인
    report.fileInputs = await evaluate(content, `(function(){
      var l = document.querySelectorAll('input[type=file]');
      return Array.prototype.map.call(l, function(e, i){ return { i: i, id: e.id, accept: e.getAttribute('accept') || '', visible: !!e.offsetParent } })
    })()`)
    // 5) HTTPS(보안 컨텍스트)에서의 요청 헤더 — 클라이언트 힌트가 실제로 나가는지 확정한다.
    if (httpsSrv) {
      const before2 = new Set((await getTargetList(PORT)).map((t) => t.id))
      await callApi(shell, 'tabs.create', [windowId, httpsSrv.url])
      try {
        await pollUntil(async () => (await getTargetList(PORT)).find((t) => t.type === 'page' && !before2.has(t.id) && String(t.url).startsWith('https://127.0.0.1')) ?? null, { timeoutMs: 15000, label: 'https tab' })
        await sleep(800)
      } catch { /* 인증서 거부 등 — 아래에서 headers 없음으로 드러난다 */ }
      report.httpsRequestHeaders = httpsSrv.seen.find((s) => s.url === '/')?.headers ?? null
    }
    void pa; void fakeWc
  } finally {
    try { httpsSrv?.server.close() } catch { /* ignore */ }
    try { server.close() } catch { /* ignore */ }
    try { content?.close() } catch { /* ignore */ }
    try { await shell?.send('Browser.close', {}, 3000).catch(() => {}) } catch { /* ignore */ }
    await sleep(600)
    if (child.exitCode === null) { try { child.kill() } catch { /* ignore */ }; try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']) } catch { /* ignore */ } }
    try { shell?.close() } catch { /* ignore */ }
  }

  fs.writeFileSync(path.join(OUT, 'fingerprint-report.json'), JSON.stringify(report, null, 2))
  console.log('\n===== 자동화 흔적 실측 =====')
  console.log('\n[요청 헤더]')
  for (const [k, v] of Object.entries(report.requestHeaders ?? {})) {
    if (/user-agent|sec-ch-ua|accept-language/i.test(k)) console.log(`  ${k}: ${v}`)
  }
  console.log('\n[navigator]')
  console.log(JSON.stringify(report.navigator, null, 2))
  console.log('\n[HTTPS(보안 컨텍스트) 요청 헤더 — 클라이언트 힌트]')
  if (!report.httpsRequestHeaders) console.log('  (측정 실패 — 인증서 생성/로드 불가)')
  else {
    const ch = Object.entries(report.httpsRequestHeaders).filter(([k]) => /sec-ch-ua|accept-language|user-agent/i.test(k))
    if (!ch.some(([k]) => /sec-ch-ua/i.test(k))) console.log('  ⚠ Sec-CH-UA 계열 헤더 없음 (실제 Chrome 은 보냄)')
    for (const [k, v] of ch) console.log(`  ${k}: ${v}`)
  }
  console.log('\n[디버거 부착 중 navigator.webdriver]', report.webdriverWhileDebuggerAttached)
  console.log('\n[파일 input 목록]', JSON.stringify(report.fileInputs))

  const ua = String(report.navigator?.userAgent ?? '')
  const hdrUa = String(report.requestHeaders?.['user-agent'] ?? '')
  const leaks = []
  if (/Electron/i.test(ua) || /Electron/i.test(hdrUa)) leaks.push('UA 에 Electron 토큰 노출')
  if (/ezBrowser/i.test(ua) || /ezBrowser/i.test(hdrUa)) leaks.push('UA 에 앱 이름(ezBrowser) 노출')
  if (report.navigator?.webdriver === true) leaks.push('navigator.webdriver = true')
  const brands = JSON.stringify(report.navigator?.userAgentData?.brands ?? [])
  if (/electron|ezbrowser/i.test(brands)) leaks.push('클라이언트 힌트 brands 에 Electron/앱 이름 노출')
  const chUa = String(report.requestHeaders?.['sec-ch-ua'] ?? '')
  if (/electron|ezbrowser/i.test(chUa)) leaks.push('Sec-CH-UA 헤더에 Electron/앱 이름 노출')
  console.log('\n[문제]', leaks.length ? leaks.join(' / ') : '없음')
  console.log(`\n보고서: ${path.join(OUT, 'fingerprint-report.json')}`)
}

main().catch((e) => { console.error('[probe-fingerprint] 오류:', e); process.exit(3) })
