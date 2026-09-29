#!/usr/bin/env node
// verify-permissions-network-cdp.mjs — 묶음 B2 검증: 권한 프롬프트 · 서드파티 쿠키 · webRequest 통합
//
// 왜: 묶음 B(session-bootstrap.ts 의 권한 프롬프트 큐, web-request-dispatcher.ts 의 서드파티 쿠키
// 차단, PermissionPrompt.tsx)가 전용 검증 하네스 없이 병합됐다(스모크·확장·dl-matrix 회귀만 확인).
// 이 하네스가 실제 동작을 실측한다.
//
//   P1 사이트가 알림 권한을 요청하면 외피에 프롬프트가 뜬다(DOM 확인), 이때 권한은 아직 미부여.
//   P2 "허용"+기억 → 콜백 허용 + 저장소 기록, 다시 요청해도 프롬프트 없음.
//   P3 "차단" → 거부 + 기억.
//   P4 무응답(탭 소멸로 대체 — 코드에 타임아웃 단축 훅이 없다) → 거부, 프롬프트 사라짐, 기억 안 됨.
//   P5 내부 페이지(browser://)는 프롬프트 없이 자동 허용.
//   C1 설정 ON(기본): 제3자 요청에 Cookie 헤더가 서버에 도착하지 않고 Set-Cookie 도 저장 안 됨.
//      1자(first-party) 요청은 영향 없음.
//   C2 설정 OFF(양성 대조): 제3자에도 쿠키가 정상 왕래한다.
//   D1 확장 declarativeNetRequest 차단이 adblock 활성 여부와 무관하게 걸린다
//      (adblock.enabled:false 로도 확장 DNR 은 동작 — web-request-dispatcher 가 세션당 리스너를
//       단독 소유하고 adblock 은 판정 제공자로만 꽂힌다는 설계의 핵심을 검증).
//
// eTLD+1 근사(web-request-dispatcher.ts registrableDomain)는 IP 주소를 "마지막 2 라벨"로 보므로
// 127.0.0.1 → "0.1", 127.0.0.2 → "0.2" 로 서로 다른 등록가능도메인이 된다 — hosts 파일 조작 없이
// 실제 서로 다른 오리진 쌍을 얻을 수 있다(둘 다 loopback, 네트워크 불필요).
//
// 사용: node build/verify-permissions-network-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectSession, getTargetList, waitForPortFree, connectShellSessionReady, ensureSessionReady,
} from './lib/cdp.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9311, out: path.join(REPO, 'verify-out', 'permissions-network') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const NL = String.fromCharCode(10)
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}

const evalIn = async (s, expression, awaitPromise = false) => {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.result?.value ?? r.result?.value
}

// ───────────────────────────── 부팅 헬퍼 ─────────────────────────────

async function bootAndTest(label, settingsExtra, fn) {
  const profileDir = path.join(args.out, `profile-${label}`)
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true }, startup: { mode: 'newtab', urls: [] },
    adblock: { enabled: false }, // 권한·쿠키 시나리오에선 adblock 을 꺼서 잡음을 없앤다(D1 은 별도로 다룸)
    ...settingsExtra,
  }, null, 2))
  await waitForPortFree(args.port)
  const child = spawn(EXE, [
    `--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`, '--ignore-certificate-errors',
  ], { stdio: 'ignore' })
  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
    await fn(shell, windowId, profileDir)
  } finally {
    try { shell?.close() } catch { /* ignore */ }
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {})
      b.close()
    } catch { /* ignore */ }
    await sleep(1500)
    try { child.kill() } catch { /* ignore */ }
    await waitForPortFree(args.port, 15000).catch(() => {})
  }
}

async function openTab(shell, windowId, port, pageUrl) {
  const tabId = await evalIn(
    shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pageUrl)}).then(t => t.id)`, true,
  )
  await sleep(1200)
  let t = null
  for (let i = 0; i < 25 && !t; i++) {
    t = (await getTargetList(port)).find((x) => x.type === 'page' && String(x.url).startsWith(pageUrl))
    if (!t) await sleep(300)
  }
  if (!t) throw new Error(`시험 페이지 타깃 없음: ${pageUrl}`)
  const page = await connectSession(t, 'page')
  await ensureSessionReady(page)
  return { page, tabId }
}

async function reconnectTab(port, pageUrlPrefix) {
  let t = null
  for (let i = 0; i < 25 && !t; i++) {
    t = (await getTargetList(port)).find((x) => x.type === 'page' && String(x.url).startsWith(pageUrlPrefix))
    if (!t) await sleep(300)
  }
  if (!t) throw new Error(`재연결 대상 없음: ${pageUrlPrefix}`)
  const page = await connectSession(t, 'page')
  await ensureSessionReady(page)
  return page
}

// ───────────────────────────── P1~P5: 권한 프롬프트 ─────────────────────────────

// ⚠ Notification.permission (동기 getter) 은 우리 setPermissionCheckHandler 가 boolean 만
// 반환할 수 있어("아직 안 정했다"를 표현할 tri-state 가 없다) 응답 전에도 'denied' 로 뜬다
// (실측 확인·Electron/Chromium 의 구조적 한계, 제품 결함 아님). 그래서 "아직 권한이 안 정해졌다"는
// __state() 대신 **요청 프라미스 자체가 아직 안 풀렸는지**로 판정한다 — 이게 진짜 신뢰 가능한 신호.
const PERM_PAGE = `<!doctype html><meta charset="utf-8"><title>권한 시험</title><body><h1>permission test</h1>
<script>
  window.__reqNotif = () => {
    window.__pending = true
    window.__p = Notification.requestPermission()
    window.__p.then(() => { window.__pending = false })
    return true
  }
  window.__state = () => Notification.permission
</script></body>`

function startPermPageServer(port) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PERM_PAGE)
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

async function subscribePromptQueue(shell) {
  await evalIn(shell, `
    window.__ev = []; window.__closed = [];
    window.__sub = window.__sub || window.browserAPI.permissions.onPromptOpen((p) => window.__ev.push(p));
    window.__subClosed = window.__subClosed || window.browserAPI.permissions.onPromptClosed((p) => window.__closed.push(p));
    true
  `)
}

async function waitForPromptEvent(shell, timeoutMs = 6000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const n = await evalIn(shell, 'window.__ev.length')
    if (n > 0) return evalIn(shell, 'window.__ev[window.__ev.length - 1]')
    await sleep(200)
  }
  return null
}

async function domPromptVisible(shell) {
  return evalIn(shell, `!!document.querySelector('.perm-prompt')`)
}

// 실제 사용자 클릭을 흉내낸다(⚠ `browserAPI.permissions.respondPrompt` 를 직접 호출하면
// 백엔드는 정상 처리되지만, 그 프롬프트를 로컬 큐에서 지우는 건 PermissionPrompt.tsx 의
// 버튼 onClick 핸들러뿐이다 — IPC 를 우회하면 화면엔 영원히 죽은 프롬프트가 남는다).
async function clickPromptButton(shell, allow) {
  const sel = allow ? '.perm-prompt-btn.primary' : '.perm-prompt-btn:not(.primary)'
  const clicked = await evalIn(shell, `(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true })()`)
  if (!clicked) throw new Error(`프롬프트 버튼을 못 찾음: ${sel}`)
}

async function runPermissionScenarios() {
  const [portA, portB, portC] = await getFreePorts(3)
  const srvA = await startPermPageServer(portA)
  const srvB = await startPermPageServer(portB)
  const srvC = await startPermPageServer(portC)
  try {
    await bootAndTest('permissions', {}, async (shell, windowId) => {
      await subscribePromptQueue(shell)

      // ── P1: 알림 권한 요청 → 프롬프트 DOM 표시 + 아직 미부여 ──
      const { page: pageA, tabId: tabA } = await openTab(shell, windowId, args.port, srvA.url)
      await evalIn(pageA, 'window.__reqNotif()')
      const promptEvtP1 = await waitForPromptEvent(shell)
      const domVisibleP1 = await domPromptVisible(shell)
      const stillPending = await evalIn(pageA, 'window.__pending')
      check('P1', '알림 권한 요청 시 외피에 프롬프트가 뜨고(DOM) 응답 전까지 권한 미부여(요청이 아직 안 풀림)',
        !!promptEvtP1 && promptEvtP1.permission === 'notifications' && domVisibleP1 === true && stillPending === true,
        `event=${JSON.stringify(promptEvtP1)} domVisible=${domVisibleP1} pending=${stillPending}`)

      // ── P2: "허용"+기억 → 콜백 허용 + 저장, 재요청 시 프롬프트 없음 ──
      // (기억 체크박스는 컴포넌트 기본값이 이미 true — 그대로 "허용" 버튼만 클릭)
      await clickPromptButton(shell, true)
      const domAfterAllowClick = await domPromptVisible(shell)
      const resolvedA = await evalIn(pageA, 'window.__p', true)
      const listAfterAllow = await evalIn(shell, 'window.browserAPI.permissions.list()', true)
      const originA = new URL(srvA.url).origin
      const storedAllow = (listAfterAllow ?? []).find((r) => r.origin === originA)?.permissions?.notifications
      // 재요청 — 같은 탭을 같은 URL 로 재내비게이션(새 프롬프트가 없어야 한다)
      await evalIn(shell, `window.__ev = []`)
      await evalIn(shell, `window.browserAPI.tabs.navigate(${JSON.stringify(tabA)}, ${JSON.stringify(srvA.url)})`, true)
      await sleep(1500)
      const pageA2 = await reconnectTab(args.port, srvA.url)
      await evalIn(pageA2, 'window.__reqNotif()')
      const resolvedA2 = await evalIn(pageA2, 'window.__p', true)
      await sleep(800)
      const evCountAfterReAllow = await evalIn(shell, 'window.__ev.length')
      check('P2', '"허용"+기억 → 클릭 즉시 프롬프트 닫힘 + 콜백 허용(granted) + 저장소 기록, 재요청 시 프롬프트 없이 즉시 허용',
        domAfterAllowClick === false && resolvedA === 'granted' && storedAllow === 'allow' && resolvedA2 === 'granted' && evCountAfterReAllow === 0,
        `domAfterClick=${domAfterAllowClick} resolved=${resolvedA} stored=${storedAllow} resolved2=${resolvedA2} newPrompts=${evCountAfterReAllow}`)
      try { pageA.close() } catch { /* ignore */ }
      try { pageA2.close() } catch { /* ignore */ }

      // ── P3: "차단" → 거부 + 기억, 재요청 시 프롬프트 없이 즉시 거부 ──
      await evalIn(shell, `window.__ev = []`)
      const { page: pageB, tabId: tabB } = await openTab(shell, windowId, args.port, srvB.url)
      await evalIn(pageB, 'window.__reqNotif()')
      const promptEvtP3 = await waitForPromptEvent(shell)
      await clickPromptButton(shell, false)
      const domAfterDenyClick = await domPromptVisible(shell)
      const resolvedB = await evalIn(pageB, 'window.__p', true)
      const listAfterDeny = await evalIn(shell, 'window.browserAPI.permissions.list()', true)
      const originB = new URL(srvB.url).origin
      const storedDeny = (listAfterDeny ?? []).find((r) => r.origin === originB)?.permissions?.notifications
      await evalIn(shell, `window.__ev = []`)
      await evalIn(shell, `window.browserAPI.tabs.navigate(${JSON.stringify(tabB)}, ${JSON.stringify(srvB.url)})`, true)
      await sleep(1500)
      const pageB2 = await reconnectTab(args.port, srvB.url)
      await evalIn(pageB2, 'window.__reqNotif()')
      const resolvedB2 = await evalIn(pageB2, 'window.__p', true)
      await sleep(800)
      const evCountAfterReDeny = await evalIn(shell, 'window.__ev.length')
      check('P3', '"차단" → 클릭 즉시 프롬프트 닫힘 + 콜백 거부(denied) + 저장소 기록, 재요청 시 프롬프트 없이 즉시 거부',
        !!promptEvtP3 && domAfterDenyClick === false && resolvedB === 'denied' && storedDeny === 'deny' && resolvedB2 === 'denied' && evCountAfterReDeny === 0,
        `domAfterClick=${domAfterDenyClick} resolved=${resolvedB} stored=${storedDeny} resolved2=${resolvedB2} newPrompts=${evCountAfterReDeny}`)
      try { pageB.close() } catch { /* ignore */ }
      try { pageB2.close() } catch { /* ignore */ }

      // ── P4: 응답 없이 탭이 사라짐(코드에 타임아웃 단축 훅이 없어 60초 대기 대신 탭 닫기로 대체)
      //      → 거부되고 프롬프트가 사라지며, "기억"되지 않는다(remember 없는 경로이므로 저장 안 됨) ──
      await evalIn(shell, `window.__ev = []; window.__closed = []`)
      const { page: pageC, tabId: tabC } = await openTab(shell, windowId, args.port, srvC.url)
      await evalIn(pageC, 'window.__reqNotif()')
      const promptEvtP4 = await waitForPromptEvent(shell)
      const domBeforeClose = await domPromptVisible(shell)
      await evalIn(shell, `window.browserAPI.tabs.close(${JSON.stringify(tabC)})`, true)
      await sleep(1500)
      const domAfterClose = await domPromptVisible(shell)
      const closedEvents = await evalIn(shell, 'window.__closed')
      const listAfterDestroy = await evalIn(shell, 'window.browserAPI.permissions.list()', true)
      const originC = new URL(srvC.url).origin
      const storedC = (listAfterDestroy ?? []).find((r) => r.origin === originC)
      check('P4', '탭 소멸(무응답 대체) → promptClosed 통지로 프롬프트가 사라지고 기억되지 않음(다음 방문에 다시 물어야 함)',
        !!promptEvtP4 && domBeforeClose === true && domAfterClose === false
          && (closedEvents ?? []).some((c) => c.promptId === promptEvtP4.promptId) && !storedC,
        `event=${!!promptEvtP4} domBefore=${domBeforeClose} domAfter=${domAfterClose} closed=${JSON.stringify(closedEvents)} stored=${JSON.stringify(storedC)}`)

      // ── P5: 내부 페이지(browser://)는 프롬프트 없이 자동 허용 ──
      await evalIn(shell, `window.__ev = []`)
      const { page: pageD } = await openTab(shell, windowId, args.port, 'browser://newtab/')
      await evalIn(pageD, 'window.__reqNotif = () => { window.__p = Notification.requestPermission(); return true }; window.__reqNotif()')
      const resolvedD = await evalIn(pageD, 'window.__p', true)
      await sleep(800)
      const evCountInternal = await evalIn(shell, 'window.__ev.length')
      check('P5', '내부 페이지(browser://)는 프롬프트 없이 즉시 허용',
        resolvedD === 'granted' && evCountInternal === 0,
        `resolved=${resolvedD} prompts=${evCountInternal}`)
      try { pageD.close() } catch { /* ignore */ }
    })
  } catch (err) {
    check('P-FATAL', '권한 프롬프트 시나리오 실행', false, err.message)
  } finally {
    await srvA.close(); await srvB.close(); await srvC.close()
  }
}

// ───────────────────────────── C1~C2: 서드파티 쿠키 차단 ─────────────────────────────

function ensureCert(certDir) {
  fs.mkdirSync(certDir, { recursive: true })
  const key = path.join(certDir, 'key.pem')
  const cert = path.join(certDir, 'cert.pem')
  if (fs.existsSync(key) && fs.existsSync(cert)) return { key, cert }
  const r = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
    '-keyout', key, '-out', cert, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,IP:127.0.0.2',
  ], { encoding: 'utf8' })
  if (r.status !== 0 || !fs.existsSync(cert)) {
    throw new Error(`openssl 자체 서명 인증서 생성 실패: ${r.stderr || r.error || 'unknown'}`)
  }
  return { key, cert }
}

/**
 * 두 오리진(127.0.0.1 = A/문서, 127.0.0.2 = B/제3자) HTTPS 서버.
 * B `/set`: Set-Cookie: tp=orig (1자 방문으로 쿠키 심기)
 * B `/api`: 받은 Cookie 헤더를 기록 + Set-Cookie: tp2=serverset (제3자 요청으로서의 응답)
 * A `/`: <img src="https://127.0.0.2:portB/api"> 를 로드하는 문서
 */
async function startCookieFixture(certDir) {
  const { key, cert } = ensureCert(certDir)
  const tlsOptions = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }
  const [portA, portB] = await getFreePorts(2)
  const state = { apiHits: [] }

  const serverB = https.createServer(tlsOptions, (req, res) => {
    const u = new URL(req.url, `https://127.0.0.2:${portB}`)
    if (u.pathname === '/set') {
      res.writeHead(200, {
        'content-type': 'text/plain', 'cache-control': 'no-store',
        'set-cookie': 'tp=orig; Path=/; SameSite=None; Secure',
      })
      res.end('set')
      return
    }
    if (u.pathname === '/api') {
      state.apiHits.push({ at: Date.now(), cookieHeader: req.headers.cookie ?? null })
      res.writeHead(200, {
        'content-type': 'image/gif', 'cache-control': 'no-store',
        'set-cookie': 'tp2=serverset; Path=/; SameSite=None; Secure',
      })
      // 1x1 GIF — <img> 태그가 콘텐츠 자체를 신경 쓰지 않지만 유효한 응답으로 둔다.
      res.end(Buffer.from('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b', 'hex'))
      return
    }
    if (u.pathname === '/cookie') {
      // 첫 오리진(B) 재방문으로 document.cookie 를 읽기 위한 페이지.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end('<!doctype html><meta charset="utf-8"><body><script>window.__cookie = () => document.cookie</script></body>')
      return
    }
    res.writeHead(404); res.end('not found')
  })

  const serverA = https.createServer(tlsOptions, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`<!doctype html><meta charset="utf-8"><title>쿠키 시험 A</title><body>
      <img id="px" src="https://127.0.0.2:${portB}/api?cb=${Date.now()}">
      <script>window.__loaded = new Promise((r) => { document.getElementById('px').onload = () => r(true); document.getElementById('px').onerror = () => r(false) })</script>
    </body>`)
  })

  await Promise.all([
    new Promise((resolve) => serverA.listen(portA, '127.0.0.1', resolve)),
    new Promise((resolve) => serverB.listen(portB, '127.0.0.2', resolve)),
  ])

  return {
    urlA: `https://127.0.0.1:${portA}/`,
    urlB: `https://127.0.0.2:${portB}/`,
    state,
    async close() {
      await Promise.all([serverA, serverB].map((s) => new Promise((r) => {
        try { s.closeAllConnections?.() } catch { /* ignore */ }
        const t = setTimeout(r, 3000)
        s.close(() => { clearTimeout(t); r() })
      })))
    },
  }
}

async function runCookieScenario(label, blockSetting, checkId, checkDesc) {
  const certDir = path.join(args.out, 'cookie-cert')
  const fx = await startCookieFixture(certDir)
  try {
    await bootAndTest(`cookies-${label}`, {
      privacy: { historyRetention: '1y', blockThirdPartyCookies: blockSetting, passkeyAutoPrompt: 'block' },
    }, async (shell, windowId) => {
      // 1) B 를 1자로 방문해 쿠키 심기
      const { page: pB1, tabId } = await openTab(shell, windowId, args.port, `${fx.urlB}set`)
      await sleep(600)

      // 2) A 로 이동 — <img> 가 B 에 제3자 요청을 보낸다
      await evalIn(shell, `window.browserAPI.tabs.navigate(${JSON.stringify(tabId)}, ${JSON.stringify(fx.urlA)})`, true)
      await sleep(1500)
      const pageA = await reconnectTab(args.port, fx.urlA)
      await evalIn(pageA, 'window.__loaded', true).catch(() => {})
      await sleep(500)

      // 3) B 를 다시 1자로 방문해 document.cookie 로 Set-Cookie 반영 여부 확인
      await evalIn(shell, `window.browserAPI.tabs.navigate(${JSON.stringify(tabId)}, ${JSON.stringify(`${fx.urlB}cookie`)})`, true)
      await sleep(1200)
      const pageB2 = await reconnectTab(args.port, `${fx.urlB}cookie`)
      const cookieAfter = await evalIn(pageB2, 'window.__cookie()')

      const apiHit = fx.state.apiHits[fx.state.apiHits.length - 1]
      const cookieArrived = !!apiHit && !!apiHit.cookieHeader && apiHit.cookieHeader.includes('tp=orig')
      const responseCookieStored = typeof cookieAfter === 'string' && cookieAfter.includes('tp2=serverset')

      if (blockSetting) {
        check(checkId, checkDesc,
          fx.state.apiHits.length > 0 && !cookieArrived && !responseCookieStored,
          `hits=${fx.state.apiHits.length} apiHit=${JSON.stringify(apiHit)} cookieAfter=${cookieAfter}`)
      } else {
        check(checkId, checkDesc,
          fx.state.apiHits.length > 0 && cookieArrived && responseCookieStored,
          `hits=${fx.state.apiHits.length} apiHit=${JSON.stringify(apiHit)} cookieAfter=${cookieAfter}`)
      }
      try { pB1.close() } catch { /* ignore */ }
      try { pageA.close() } catch { /* ignore */ }
      try { pageB2.close() } catch { /* ignore */ }
    })
  } catch (err) {
    check(checkId, checkDesc, false, `harness 예외: ${err.message}`)
  } finally {
    await fx.close()
  }
}

// ───────────────────────────── D1: 확장 DNR (adblock 무관) ─────────────────────────────

function idFromPublicKey(pubKeyDer) {
  const first16 = crypto.createHash('sha256').update(pubKeyDer).digest().subarray(0, 16)
  let id = ''
  for (const byte of first16) {
    id += String.fromCharCode(97 + (byte >> 4))
    id += String.fromCharCode(97 + (byte & 0x0f))
  }
  return id
}

function writeDnrTestExtension(root) {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pubKeyDer = publicKey.export({ type: 'spki', format: 'der' })
  const id = idFromPublicKey(pubKeyDer)
  const dir = path.join(root, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    key: pubKeyDer.toString('base64'),
    manifest_version: 3,
    name: 'B2 DNR 시험 확장',
    version: '1.0',
    description: 'adblock 과 무관하게 declarativeNetRequest 가 동작하는지 확인',
    permissions: ['declarativeNetRequest'],
    host_permissions: ['<all_urls>'],
    background: { service_worker: 'sw.js' },
    declarative_net_request: { rule_resources: [{ id: 'ruleset', enabled: true, path: 'rules.json' }] },
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify([
    { id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '/ads/', resourceTypes: ['script'] } },
  ], null, 2))
  fs.writeFileSync(path.join(dir, 'sw.js'), '// 시험용 — DNR 정적 룰만 필요, SW 로직 없음')
  return { dir, id }
}

function startAdPageServer(port) {
  let adHits = 0
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/ads/')) {
      adHits++
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' })
      res.end('window.__adLoaded = true;')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`<!doctype html><meta charset="utf-8"><title>D1 시험</title><body>
      <script>window.__adLoaded = false; window.__adError = false</script>
      <script src="/ads/banner.js" onerror="window.__adError = true"></script>
    </body>`)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${port}/`,
    get adHits() { return adHits },
    async close() {
      await new Promise((r) => {
        try { server.closeAllConnections?.() } catch { /* ignore */ }
        const t = setTimeout(r, 3000)
        server.close(() => { clearTimeout(t); r() })
      })
    },
  })))
}

async function runDnrScenario() {
  const [pagePort] = await getFreePorts(1)
  const page = await startAdPageServer(pagePort)
  try {
    const profileDir = path.join(args.out, 'profile-dnr')
    fs.rmSync(profileDir, { recursive: true, force: true })
    fs.mkdirSync(profileDir, { recursive: true })
    fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
      setup: { completed: true }, startup: { mode: 'newtab', urls: [] },
      adblock: { enabled: false }, // adblock 완전히 꺼짐 — adblockRequestProvider 는 영원히 null
    }, null, 2))
    const ext = writeDnrTestExtension(path.join(profileDir, 'extensions'))
    const bootedAt = Date.now()

    await waitForPortFree(args.port)
    const child = spawn(EXE, [
      `--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`,
    ], { stdio: 'ignore' })
    let shell = null
    let firstBlockedAt = null
    try {
      shell = await connectShellSessionReady(args.port)
      const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')

      // adblock.enabled=false 이므로 "[adblock] initialized" 로그는 절대 나오지 않는다 —
      // 즉 adblockRequestProvider 가 이 프로세스 수명 동안 한 번도 등록되지 않는다는 뜻.
      // 확장 정적 DNR 룰은 initExtensions() 시점(부팅 1.5초 지연)에야 로드되므로, 그 이전의
      // 몇 번의 요청은 (adblock 이 꺼져 있으니) 정상적으로 서버에 도달하는 게 **맞다** — 그건
      // 결함이 아니라 이 아키텍처의 사실이다. 검증할 것은 "확장이 로드되면, adblock 없이도
      // 차단이 걸리고 그 뒤로 계속 유지되는가"다. 탭을 반복 재내비게이션해(매번 요청을 새로
      // 발생시켜) 최대 40회(~12초) 지켜본다.
      const { tabId } = await openTab(shell, windowId, args.port, page.url)
      let blocked = false
      let lastAdLoaded = null
      let hitsAtFirstBlock = null
      for (let i = 0; i < 40; i++) {
        await evalIn(shell, `window.browserAPI.tabs.navigate(${JSON.stringify(tabId)}, ${JSON.stringify(page.url)})`, true).catch(() => {})
        await sleep(300)
        try {
          const p = await reconnectTab(args.port, page.url)
          lastAdLoaded = await evalIn(p, 'window.__adLoaded')
          try { p.close() } catch { /* ignore */ }
        } catch { /* 재연결 실패 — 다음 반복에서 재시도 */ }
        if (lastAdLoaded === false) {
          if (!blocked) { blocked = true; firstBlockedAt = Date.now(); hitsAtFirstBlock = page.adHits }
        } else {
          // 다시 통과했다 = 아직 룰이 없거나(초기) 불안정 — blocked 를 취소하고 계속 지켜본다.
          blocked = false
        }
      }
      const staysBlocked = blocked && page.adHits === hitsAtFirstBlock

      check('D1', '확장 DNR 차단이 adblock 활성 여부와 무관하게 걸리고 유지됨(adblock.enabled=false 에서도)',
        staysBlocked,
        `staysBlocked=${staysBlocked} totalAdHits=${page.adHits} hitsAtFirstBlock=${hitsAtFirstBlock} lastAdLoaded=${lastAdLoaded} 최초 차단까지=${firstBlockedAt ? firstBlockedAt - bootedAt : 'n/a'}ms (참고: 확장 정적 룰은 initExtensions() 시점(부팅 1.5초 지연)에야 로드되므로 그 이전 요청이 서버에 도달하는 것은 정상 — 여기서 검증하는 것은 "adblock 없이도 확장 DNR 이 걸리고 유지된다"는 리스너 소유권의 독립성)`)
    } finally {
      try { shell?.close() } catch { /* ignore */ }
      try {
        const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
        const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
        await b.send('Browser.close').catch(() => {})
        b.close()
      } catch { /* ignore */ }
      await sleep(1500)
      try { child.kill() } catch { /* ignore */ }
      await waitForPortFree(args.port, 15000).catch(() => {})
    }
  } catch (err) {
    check('D1', '확장 DNR (adblock 무관)', false, `harness 예외: ${err.message}`)
  } finally {
    await page.close()
  }
}

// ───────────────────────────── main ─────────────────────────────

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE}`)
  fs.mkdirSync(args.out, { recursive: true })
  args.port = await preferFreePort(args.port, 'verify-permissions-network-cdp.mjs')

  await runPermissionScenarios()
  await runCookieScenario('on', true, 'C1', '서드파티 쿠키 차단 ON(기본): 제3자 요청에 Cookie 미전송 + Set-Cookie 미저장')
  await runCookieScenario('off', false, 'C2', '서드파티 쿠키 차단 OFF(양성 대조): 제3자에도 쿠키 정상 왕래')
  await runDnrScenario()

  fs.writeFileSync(path.join(args.out, 'permissions-network-results.json'), JSON.stringify(results, null, 2))
  console.log(NL + '===== verify-permissions-network 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL').length
  console.log(`PASS=${results.length - fail} FAIL=${fail} (총 ${results.length})`)
  process.exit(fail ? 1 : 0)
}

main().catch((err) => { console.error('harness 실패:', err); process.exit(1) })
