#!/usr/bin/env node
// saved-login-fixture-server.mjs — "저장된 계정으로 자동 로그인" 검증 전용 로컬 HTTPS fixture.
//
// 무엇을 증명하려는 것인가: 브라우저의 비밀번호 자동입력·자동저장 기능이
//   ① 평범한 로그인 폼에서는 정확히 동작하고,
//   ② 그 기능이 절대 하면 안 되는 상황(다른 오리진으로 제출·숨은 폼·모호한 폼·회원가입·
//      교차 출처 iframe·2FA 코드 입력칸)에서는 손대지 않으며,
//   ③ identifier-first(아이디 먼저 → 다음 화면에서 비밀번호) 2단계 흐름과 느린 응답에도
//      성급하게 "로그인 성공"으로 오판하지 않는지를
// 실제 사이트에 접속하지 않고 결정론적으로 재현하기 위한 것이다. 127.0.0.1 루프백에서만
// 돌고, 더미 자격증명만 쓴다. **HTTPS 여야 한다** — 제품이 https 가 아닌 곳에는 비밀번호를
// 절대 넣지 않도록 만들어져 있어서, http 픽스처로는 긍정 경로(정상 자동입력)를 검증할 수
// 없다(자체 서명 인증서 + `--ignore-certificate-errors` 패턴은 probe-fingerprint-cdp.mjs 를
// 그대로 재사용했다).
//
// 라우트 → 판정표 (주 오리진, 별도 표기 없으면 https://127.0.0.1:<port1>/ 기준):
//
//   경로              | 메서드 | 판정        | 무엇을 증명하는가
//   ------------------|--------|-------------|--------------------------------------------
//   /start            | GET    | 흐름 진입    | 세션 없으면 /login, 있으면 /dashboard 로 302
//   /login            | GET    | 긍정        | 평범한 로그인 폼 — 자동입력이 채워져야 한다
//   /auth             | POST   | 긍정        | 정확한 자격증명만 세션 쿠키 + /dashboard
//   /dashboard        | GET    | 흐름 확인    | 로그인 뒤 원래 작업(버튼 클릭)이 실제로 이어지는가
//   /signup           | GET    | 부정        | 새 비밀번호 입력칸(new-password) — 채우면 안 된다
//   /xform            | GET    | 부정        | action 이 다른 오리진 — 자동입력·자동제출 금지
//   /ambig            | GET    | 부정        | 아이디 칸이 모호 — "모르겠다"로 거부해야 한다
//   /hidden           | GET    | 부정        | display:none 안의 폼 — 사람 눈에 안 보이면 채우지 않는다
//   /idfirst          | GET    | 긍정(2단계) | identifier-first 1단계 — 아이디만 입력
//   /idfirst-next      | POST   | 흐름        | 1단계 제출 → 2단계로 302(비밀번호는 아직 없음)
//   /idfirst2         | GET    | 긍정(2단계) | 2단계 — 숨은 아이디 + 보이는 비밀번호 칸만 자동입력
//   /twofa            | GET    | 흐름        | 1차 자격증명은 정상 폼과 동일
//   /auth2fa          | POST   | 흐름        | 성공해도 쿠키를 주지 않고 /otp 로 — 아직 로그인 아님
//   /otp              | GET    | 부정        | 인증 코드 입력칸 — 저장된 비밀번호를 넣으면 안 된다
//   /otp-submit       | POST   | 관찰용      | 무엇이 제출됐는지 state.otpSubmits 에 기록
//   /iframe-same      | GET    | 긍정        | 같은 오리진 iframe 안의 로그인 폼도 채워져야 한다
//   /iframe-cross     | GET    | 부정        | 다른 오리진 iframe 안 폼은 조심해야 한다(교차 출처)
//   /slow-auth        | GET    | 흐름        | action = /auth-slow
//   /auth-slow        | POST   | 흐름        | 성공해도 2.5초 뒤에야 응답 — 성급한 성공 판정 방지
//
//   보조 오리진(altUrl = https://127.0.0.1:<port2>/):
//   /login            | GET    | 대조        | 주 오리진과 동일한 폼(iframe-cross·xform 의 목적지)
//   /auth             | POST   | 대조        | 판정 동일. state.auth 에 origin:'alt' 로 구분 기록
//   (그 외)           | *      | -           | 404
//
// 의존성 0(Node 내장 모듈만). ESM.

import https from 'node:https'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { getFreePorts } from './lib/ports.mjs'

/** 표식으로 쓸 만큼 독특한 더미 자격증명. 렌더링된 HTML 에는 절대 나타나지 않는다(유출 검사용). */
export const FIXTURE_USER = 'demo-user'
export const FIXTURE_PASS = 'Zq7-fixture-pass-9174'

const SESSION_COOKIE = 'fx_sess=1'

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function page(body) {
  return `<!doctype html><meta charset="utf-8"><title>login-fixture</title>${body}`
}

function send(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders })
  res.end(body)
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...extraHeaders })
  res.end()
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseForm(body) {
  const out = {}
  for (const [k, v] of new URLSearchParams(body || '')) out[k] = v
  return out
}

function hasSessionCookie(req) {
  const c = req.headers.cookie || ''
  return c.split(';').map((s) => s.trim()).includes(SESSION_COOKIE)
}

/** probe-fingerprint-cdp.mjs 의 검증된 패턴 그대로 — 자체 서명 인증서를 openssl 로 생성. */
function ensureCert(certDir) {
  fs.mkdirSync(certDir, { recursive: true })
  const key = path.join(certDir, 'key.pem')
  const cert = path.join(certDir, 'cert.pem')
  if (fs.existsSync(key) && fs.existsSync(cert)) return { key, cert }
  const r = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
    '-keyout', key, '-out', cert, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { encoding: 'utf8' })
  if (r.status !== 0 || !fs.existsSync(cert)) {
    throw new Error(`openssl 자체 서명 인증서 생성 실패: ${r.stderr || r.error || 'unknown'}`)
  }
  return { key, cert }
}

/** 열린 연결이 있으면 server.close() 콜백이 영영 안 온다 — 강제로 끊고 3초 상한을 둔다. */
function closeServer(server) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    const timer = setTimeout(finish, 3000)
    server.close(() => { clearTimeout(timer); finish() })
    try { server.closeAllConnections?.() } catch { /* ignore */ }
  })
}

function loginFormHtml({ action = '/auth', error = false, extraFields = '' } = {}) {
  return `
    <h1>로그인</h1>
    ${error ? '<p class="err">비밀번호가 올바르지 않습니다.</p>' : ''}
    <form method="post" action="${action}">
      ${extraFields}
      <label for="username">아이디</label>
      <input id="username" name="username" type="text" autocomplete="username">
      <label for="password">비밀번호</label>
      <input id="password" name="password" type="password" autocomplete="current-password">
      <button type="submit">로그인</button>
    </form>
  `
}

/**
 * @param {object} opts
 * @param {string} [opts.certDir] 인증서를 쓸 디렉터리. 주면 close() 에서 지우지 않는다(재사용/캐시용).
 *   없으면 os.tmpdir() 아래 임시 폴더를 만들어 쓰고 close() 에서 삭제한다.
 * @returns {Promise<{url:string, altUrl:string, state:object, close:() => Promise<void>}>}
 */
export async function startLoginFixture(opts = {}) {
  const ownCertDir = !opts.certDir
  const certDir = opts.certDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ezb-login-fixture-'))
  const certPaths = ensureCert(certDir)
  const tlsOptions = { key: fs.readFileSync(certPaths.key), cert: fs.readFileSync(certPaths.cert) }

  const [port1, port2] = await getFreePorts(2)

  const state = {
    auth: [],       // { path, username, password, at, origin? }
    hits: [],       // { path, method, at, origin }
    otpSubmits: [], // { code, at }
    sessions: 0,
  }

  function recordAuth(pathName, username, password, origin) {
    state.auth.push({ path: pathName, username, password, at: Date.now(), ...(origin ? { origin } : {}) })
  }

  const baseUrl = (port) => `https://127.0.0.1:${port}/`
  const url = baseUrl(port1)
  const altUrl = baseUrl(port2)

  // ── 주 오리진 라우팅 ──
  async function routeMain(req, res, pathName, urlObj) {
    if (req.method === 'GET' && pathName === '/start') {
      return redirect(res, hasSessionCookie(req) ? '/dashboard' : '/login')
    }

    if (req.method === 'GET' && pathName === '/login') {
      const error = urlObj.searchParams.get('e') === '1'
      return send(res, 200, page(loginFormHtml({ action: '/auth', error })))
    }

    if (req.method === 'POST' && pathName === '/auth') {
      const body = parseForm(await readBody(req))
      recordAuth('/auth', body.username ?? '', body.password ?? '')
      if (body.username === FIXTURE_USER && body.password === FIXTURE_PASS) {
        state.sessions++
        return redirect(res, '/dashboard', { 'Set-Cookie': `${SESSION_COOKIE}; Path=/` })
      }
      return redirect(res, '/login?e=1')
    }

    if (req.method === 'GET' && pathName === '/dashboard') {
      if (!hasSessionCookie(req)) return redirect(res, '/login')
      return send(res, 200, page(`
        <h1>로그인됨 — 대시보드</h1>
        <button id="task-btn">작업 버튼</button>
        <div id="task-result">미완료</div>
        <script>
          document.getElementById('task-btn').addEventListener('click', function () {
            window.__taskDone = true;
            document.getElementById('task-result').textContent = '작업 완료됨';
          });
        </script>
      `))
    }

    if (req.method === 'GET' && pathName === '/signup') {
      return send(res, 200, page(`
        <h1>회원가입</h1>
        <form method="post" action="/signup-submit">
          <label for="password">비밀번호</label>
          <input id="password" name="password" type="password" autocomplete="new-password">
          <label for="password_confirm">비밀번호 확인</label>
          <input id="password_confirm" name="password_confirm" type="password" autocomplete="new-password">
          <button type="submit">회원가입</button>
        </form>
      `))
    }
    if (req.method === 'POST' && pathName === '/signup-submit') {
      await readBody(req)
      return send(res, 200, page('<p>가입 처리(테스트용, 아무 것도 저장하지 않음)</p>'))
    }

    if (req.method === 'GET' && pathName === '/xform') {
      // action 이 다른 오리진의 절대 URL — 자동입력·자동제출이 여기서 일어나면 안 된다.
      return send(res, 200, page(loginFormHtml({ action: `${altUrl}auth` })))
    }

    if (req.method === 'GET' && pathName === '/ambig') {
      return send(res, 200, page(`
        <h1>로그인</h1>
        <form method="post" action="/auth">
          <input type="text">
          <input type="text">
          <input type="text">
          <input type="password">
          <button type="submit">확인</button>
        </form>
      `))
    }

    if (req.method === 'GET' && pathName === '/hidden') {
      return send(res, 200, page(`
        <h1>페이지</h1>
        <div style="display:none">${loginFormHtml({ action: '/auth' })}</div>
      `))
    }

    if (req.method === 'GET' && pathName === '/idfirst') {
      return send(res, 200, page(`
        <h1>로그인</h1>
        <form method="post" action="/idfirst-next">
          <label for="username">아이디</label>
          <input id="username" name="username" type="text" autocomplete="username">
          <button type="submit">다음</button>
        </form>
      `))
    }
    if (req.method === 'POST' && pathName === '/idfirst-next') {
      const body = parseForm(await readBody(req))
      const username = body.username ?? ''
      recordAuth('/idfirst-next', username, '')
      return redirect(res, `/idfirst2?u=${encodeURIComponent(username)}`)
    }
    if (req.method === 'GET' && pathName === '/idfirst2') {
      const u = urlObj.searchParams.get('u') ?? ''
      return send(res, 200, page(`
        <h1>비밀번호 입력</h1>
        <div>아이디: ${escapeHtml(u)}</div>
        <form method="post" action="/auth">
          <input type="hidden" name="username" value="${escapeHtml(u)}">
          <label for="password">비밀번호</label>
          <input id="password" name="password" type="password" autocomplete="current-password">
          <button type="submit">로그인</button>
        </form>
      `))
    }

    if (req.method === 'GET' && pathName === '/twofa') {
      const error = urlObj.searchParams.get('e') === '1'
      return send(res, 200, page(loginFormHtml({ action: '/auth2fa', error })))
    }
    if (req.method === 'POST' && pathName === '/auth2fa') {
      const body = parseForm(await readBody(req))
      recordAuth('/auth2fa', body.username ?? '', body.password ?? '')
      if (body.username === FIXTURE_USER && body.password === FIXTURE_PASS) {
        // 자격증명은 맞지만 아직 세션을 열지 않는다 — 2FA 코드 확인이 남아 있다.
        return redirect(res, '/otp')
      }
      return redirect(res, '/twofa?e=1')
    }
    if (req.method === 'GET' && pathName === '/otp') {
      return send(res, 200, page(`
        <h1>인증 코드 입력</h1>
        <form method="post" action="/otp-submit">
          <label for="code">코드</label>
          <input id="code" name="code" type="text" autocomplete="one-time-code">
          <button type="submit">확인</button>
        </form>
      `))
    }
    if (req.method === 'POST' && pathName === '/otp-submit') {
      const body = parseForm(await readBody(req))
      const code = body.code ?? ''
      state.otpSubmits.push({ code, at: Date.now() })
      if (code) {
        state.sessions++
        return redirect(res, '/dashboard', { 'Set-Cookie': `${SESSION_COOKIE}; Path=/` })
      }
      return redirect(res, '/otp')
    }

    if (req.method === 'GET' && pathName === '/iframe-same') {
      return send(res, 200, page(`
        <h1>같은 오리진 iframe</h1>
        <iframe src="/login" width="480" height="320" style="border:1px solid #ccc"></iframe>
      `))
    }
    if (req.method === 'GET' && pathName === '/iframe-cross') {
      return send(res, 200, page(`
        <h1>교차 출처 iframe</h1>
        <iframe src="${altUrl}login" width="480" height="320" style="border:1px solid #ccc"></iframe>
      `))
    }

    if (req.method === 'GET' && pathName === '/slow-auth') {
      return send(res, 200, page(loginFormHtml({ action: '/auth-slow' })))
    }
    if (req.method === 'POST' && pathName === '/auth-slow') {
      const body = parseForm(await readBody(req))
      recordAuth('/auth-slow', body.username ?? '', body.password ?? '')
      const ok = body.username === FIXTURE_USER && body.password === FIXTURE_PASS
      setTimeout(() => {
        if (ok) {
          state.sessions++
          return redirect(res, '/dashboard', { 'Set-Cookie': `${SESSION_COOKIE}; Path=/` })
        }
        return redirect(res, '/slow-auth?e=1')
      }, 2500)
      return
    }

    return send(res, 404, page('<p>not found</p>'))
  }

  // ── 보조 오리진 라우팅 ──
  async function routeAlt(req, res, pathName, urlObj) {
    if (req.method === 'GET' && pathName === '/login') {
      // 주 오리진과 **동일하게** ?e=1 오류 문구를 렌더링한다. 이게 빠져 있으면
      // "틀린 비밀번호를 감지하는가" 검사가 감지할 문구 자체를 못 본다(2026-09-18 실측).
      const error = urlObj.searchParams.get('e') === '1'
      return send(res, 200, page(loginFormHtml({ action: '/auth', error })))
    }
    if (req.method === 'POST' && pathName === '/auth') {
      const body = parseForm(await readBody(req))
      recordAuth('/auth', body.username ?? '', body.password ?? '', 'alt')
      if (body.username === FIXTURE_USER && body.password === FIXTURE_PASS) {
        state.sessions++
        return redirect(res, '/dashboard', { 'Set-Cookie': `${SESSION_COOKIE}; Path=/` })
      }
      return redirect(res, '/login?e=1')
    }
    return send(res, 404, page('<p>not found</p>'))
  }

  function makeServer(routeFn, originLabel) {
    return https.createServer(tlsOptions, (req, res) => {
      let urlObj
      try {
        urlObj = new URL(req.url, `https://127.0.0.1`)
      } catch {
        res.writeHead(400); res.end('bad request'); return
      }
      const pathName = urlObj.pathname
      state.hits.push({ path: pathName, method: req.method, at: Date.now(), origin: originLabel })
      Promise.resolve(routeFn(req, res, pathName, urlObj)).catch((err) => {
        try { send(res, 500, page(`<p>fixture error: ${escapeHtml(err?.message)}</p>`)) } catch { /* ignore */ }
      })
    })
  }

  const mainServer = makeServer(routeMain, 'main')
  const altServer = makeServer(routeAlt, 'alt')

  await Promise.all([
    new Promise((resolve, reject) => { mainServer.once('error', reject); mainServer.listen(port1, '127.0.0.1', resolve) }),
    new Promise((resolve, reject) => { altServer.once('error', reject); altServer.listen(port2, '127.0.0.1', resolve) }),
  ])

  return {
    url,
    altUrl,
    state,
    async close() {
      await Promise.all([closeServer(mainServer), closeServer(altServer)])
      if (ownCertDir) {
        try { fs.rmSync(certDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    },
  }
}

// 직접 실행하면 수동 확인용으로 URL 을 찍고 Ctrl+C 까지 살아 있는다.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fixture = await startLoginFixture()
  console.log('[saved-login-fixture] url    :', fixture.url)
  console.log('[saved-login-fixture] altUrl :', fixture.altUrl)
  console.log('[saved-login-fixture] user   :', FIXTURE_USER)
  console.log('[saved-login-fixture] pass   :', FIXTURE_PASS)
  console.log('Ctrl+C 로 종료하세요.')
  process.on('SIGINT', async () => { await fixture.close(); process.exit(0) })
}
