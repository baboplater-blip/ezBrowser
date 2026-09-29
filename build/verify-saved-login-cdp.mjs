#!/usr/bin/env node
// verify-saved-login-cdp.mjs — 저장된 계정으로 자동 로그인: 긍정·부정 양방향 검증
//
// 왜: 에이전트는 로그인 화면에서 무조건 멈췄다. 사용자가 계정을 미리 등록하고 **계정마다 명시로** 허용하면
// 그 계정에 한해 브라우저가 직접 로그인하고 원래 작업을 이어간다. 이 기능은 **비밀번호를 다루므로**,
// "되는가" 만큼 "새지 않는가 · 엉뚱한 곳에 넣지 않는가" 를 같은 무게로 봐야 한다.
//
// 결정적으로 만드는 두 장치:
//   · 로컬 HTTPS 픽스처(build/saved-login-fixture-server.mjs) — 실제 사이트에 접속하지 않는다.
//     https 여야 하는 이유: 제품이 http 에는 비밀번호를 넣지 않으므로 http 픽스처로는 긍정 경로를 못 본다.
//   · 각본대로만 답하는 가짜 LLM(build/lib/fake-llm.mjs) — 모델 설치 없이 매번 같은 결과.
//     자동 로그인 자체는 **모델을 부르기 전에** 일어나므로, 가짜 모델은 "로그인 뒤 원래 작업" 에만 쓰인다.
//
//   [긍정]
//   SL1  선등록(add)이 저장되고 목록에 허용 상태가 반영된다
//   SL2  잘못된 입력은 거부된다(http 주소 · 중복 · 빈 값)
//   SL5  로그인 화면을 스스로 통과하고 **원래 작업까지 완료**한다(채우기만 성공이라 우기지 않는다)
//   SL6  아이디 먼저(2단계) 로그인도 통과한다
//   SL7  허용된 교차 출처 iframe 안의 로그인 폼도 처리한다
//   SL3  앱을 껐다 켜도 등록·허용이 유지된다
//
//   [부정 — 전부 "비밀번호가 서버에 한 글자도 도달하지 않았는가" 로 판정]
//   SL4  신뢰되지 않은 페이지(외부 사이트)는 계정 CRUD 에 접근할 수 없다
//   SL8  자동 로그인을 끈 계정(opt-out)으로는 로그인하지 않는다
//   SL9  등록되지 않은 다른 출처(포트가 다른 오리진)에는 비밀을 넘기지 않는다
//   SL10 폼 전송 주소가 다른 출처로 바뀐 폼(action 변조)에는 넣지 않는다
//   SL11 숨은 폼 · 가입 폼 · 아이디 칸이 모호한 폼에는 넣지 않는다
//   SL12 비밀번호가 틀리면 성공이라 하지 않고, 실패를 누적해 상한에서 잠근다(계정 잠금 방지)
//   SL13 2단계 인증(OTP) 화면은 사람에게 넘긴다 — 코드를 대신 넣지 않는다
//   SL14 허용 계정이 여럿인데 기본이 정해지지 않았으면 아무것도 입력하지 않고 묻는다
//   SL16 취소 뒤에는 추가 로그인·제출이 없다
//   SL15 비밀번호가 모델 프롬프트 · 실행 이력 · 작업 체크포인트 · 로그 · 저장 파일 어디에도 평문으로 없다
//
// 사용: node build/verify-saved-login-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, getTargetList, waitForPortFree, connectShellSessionReady, ensureSessionReady } from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { preferFreePort, getFreePorts } from './lib/ports.mjs'
import { startLoginFixture, FIXTURE_USER, FIXTURE_PASS } from './saved-login-fixture-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9272, out: path.join(REPO, 'verify-out', 'saved-login') }
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

const evalIn = async (s, expression, awaitPromise = false) => {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  return r.result?.result?.value ?? r.result?.value
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE}`)
  fs.mkdirSync(args.out, { recursive: true })
  args.port = await preferFreePort(args.port, 'verify-saved-login-cdp.mjs')
  await waitForPortFree(args.port)

  const fixture = await startLoginFixture({ certDir: path.join(args.out, 'cert') })
  const [llmPort] = await getFreePorts(1)
  // ⚠ llm.requests 는 setScript 마다 비워진다(시나리오마다 교체). 유출 검사가 **마지막 시나리오의**
  //   프롬프트만 보면(실제로 0건이었다) 아무것도 증명하지 못한다 → 전 실행의 프롬프트를 따로 누적한다.
  const allPrompts = []
  const llm = await startFakeLlm({
    port: llmPort,
    onRequest: ({ messages, lastUser }) => { allPrompts.push(JSON.stringify({ messages, lastUser })) },
  })
  const mainOrigin = new URL(fixture.url).origin
  const altOrigin = new URL(fixture.altUrl).origin

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const settings = {
    setup: { completed: true },
    startup: { mode: 'newtab', urls: [] },
    adblock: { enabled: false },
    ai: {
      enabled: true, provider: 'ollama', ollamaUrl: llm.url, ollamaModel: 'test-model',
      agentMaxSteps: 8, agentAutoApprove: false, agentVision: 'off', agentHumanInput: false,
    },
  }
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify(settings, null, 2))

  const logPath = path.join(args.out, 'app.log')
  let child = null
  let shell = null
  const launch = async () => {
    const logStream = fs.createWriteStream(logPath, { flags: 'a' })
    child = spawn(EXE, [
      `--remote-debugging-port=${args.port}`,
      `--user-data-dir=${profileDir}`,
      // 픽스처는 자체 서명 인증서다(검증 실행 한정). 제품 기본값은 바뀌지 않는다.
      '--ignore-certificate-errors',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(logStream); child.stderr.pipe(logStream)
    shell = await connectShellSessionReady(args.port)
    return await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
  }
  const shutdown = async () => {
    try { if (shell) await shell.send('Browser.close', {}) } catch { /* ignore */ }
    await sleep(1200)
    try { child?.kill() } catch { /* ignore */ }
    await sleep(600)
    try { fs.rmSync(path.join(profileDir, 'sessions', 'current.json'), { force: true }) } catch { /* ignore */ }
  }

  try {
    let windowId = await launch()

    // ===== 계정 관리 페이지에서 선등록 (제품의 실제 경로 — internalAPI) =====
    const accountsTabId = await evalIn(shell,
      `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, "browser://passwords").then(t => t.id)`, true)
    await sleep(2000)
    let accountsPage = null
    const connectAccounts = async () => {
      const t = (await getTargetList(args.port)).find((x) => String(x.url).startsWith('browser://passwords'))
      if (!t) throw new Error('browser://passwords 타깃을 찾지 못함')
      const s = await connectSession(t, 'page')
      await ensureSessionReady(s)
      return s
    }
    accountsPage = await connectAccounts()

    const pwApi = async (method, arg) =>
      JSON.parse(await evalIn(accountsPage,
        `window.internalAPI.password.${method}(${arg === undefined ? '' : JSON.stringify(arg)}).then(r => JSON.stringify(r ?? null))`, true) ?? 'null')

    // ---- SL1 / SL2 : 선등록과 입력 검증 ----
    const addMain = await pwApi('add', { origin: mainOrigin, username: FIXTURE_USER, password: FIXTURE_PASS, autoLoginAllowed: true })
    let list = await pwApi('list')
    const mainEntry = (list ?? []).find((e) => e.origin === mainOrigin && e.username === FIXTURE_USER)
    check('SL1', '계정 선등록이 저장되고 자동 로그인 허용이 반영된다',
      addMain?.ok === true && !!mainEntry && mainEntry.autoLoginAllowed === true && mainEntry.scheme === 'https',
      `add.ok=${addMain?.ok} · 목록반영=${!!mainEntry} · 허용=${mainEntry?.autoLoginAllowed} · scheme=${mainEntry?.scheme}`)

    const badHttp = await pwApi('add', { origin: 'http://insecure.example', username: 'u', password: 'p' })
    const dup = await pwApi('add', { origin: mainOrigin, username: FIXTURE_USER, password: 'x' })
    const empty = await pwApi('add', { origin: mainOrigin, username: '', password: '' })
    const junk = await pwApi('add', { origin: mainOrigin, username: 42, password: null })
    check('SL2', '잘못된 등록은 거부된다(http · 중복 · 빈 값 · 형태 오류)',
      badHttp?.reason === 'invalid-origin' && dup?.reason === 'duplicate'
      && empty?.reason === 'invalid' && junk?.ok === false,
      `http=${badHttp?.reason} · 중복=${dup?.reason} · 빈값=${empty?.reason} · 형태오류거부=${junk?.ok === false}`)

    // ===== 에이전트 실행 헬퍼 =====
    const clickByLabel = (label) => ({
      reply: (ctx) => {
        const ref = ctx.refFor(label)
        if (ref === null || ref === undefined) return JSON.stringify({ action: 'done', message: `${label} 없음` })
        return JSON.stringify({ action: 'click', ref, thought: `${label} 누름` })
      },
    })
    const doneStep = { reply: () => JSON.stringify({ action: 'done', message: '완료' }) }

    async function pageEval(urlPrefix, expr) {
      const t = (await getTargetList(args.port)).find((x) => String(x.url).startsWith(urlPrefix))
      if (!t) return null
      const s = await connectSession(t, 'page')
      await ensureSessionReady(s)
      const v = await evalIn(s, expr)
      try { s.close?.() } catch { /* ignore */ }
      return v
    }

    /** 시나리오 하나: 새 탭에 픽스처 페이지를 열고 에이전트를 돌린 뒤 이벤트를 모은다. */
    async function runAgent({ reqId, task, url, script = [doneStep], allowedHosts, timeoutMs = 45000, cancelAfterMs, replyToAsk }) {
      llm.setScript(script)
      const tabId = await evalIn(shell,
        `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(url)}).then(t => t.id)`, true)
      await sleep(2500)
      await evalIn(shell, 'window.__ev = []; window.__sub = window.__sub || window.browserAPI.ai.onAgentEvent((e) => window.__ev.push(e)); window.__ev = []; true')
      const startArgs = { reqId, tabId, task, ...(allowedHosts ? { allowedHosts } : {}) }
      await evalIn(shell, `window.browserAPI.ai.agentStart(${JSON.stringify(startArgs)})`, true)
      if (cancelAfterMs !== undefined) {
        await sleep(cancelAfterMs)
        await evalIn(shell, `window.browserAPI.ai.agentCancel(${JSON.stringify(reqId)})`, true)
      }
      const deadline = Date.now() + timeoutMs
      let replied = false
      let evs = []
      while (Date.now() < deadline) {
        evs = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ev)') ?? '[]')
        if (evs.some((e) => e.type === 'done' || e.type === 'error' || e.type === 'cancelled')) break
        if (evs.some((e) => e.type === 'ask')) {
          if (replyToAsk && !replied) { replied = true; await evalIn(shell, `window.browserAPI.ai.agentReply(${JSON.stringify(reqId)}, ${JSON.stringify(replyToAsk)})`, true) }
          else break // 대기 상태 자체가 결과다 — 더 기다리지 않는다
        }
        await sleep(400)
      }
      return {
        evs, types: evs.map((e) => e.type), tabId,
        asks: evs.filter((e) => e.type === 'ask').map((e) => String(e.message ?? '')),
        results: evs.filter((e) => e.type === 'result').map((e) => `${e.ok ? '+' : '-'}${e.label}`),
        async close() {
          try { await evalIn(shell, `window.browserAPI.ai.agentCancel(${JSON.stringify(reqId)})`, true) } catch { /* ignore */ }
          try { await evalIn(shell, `window.browserAPI.tabs.close(${JSON.stringify(tabId)})`, true) } catch { /* ignore */ }
        },
      }
    }
    const authOn = (origin) => fixture.state.auth.filter((a) => (origin === 'alt' ? a.origin === 'alt' : a.origin !== 'alt'))
    const leakedTo = (origin) => authOn(origin).filter((a) => a.password === FIXTURE_PASS).length

    // ---- SL4: 신뢰되지 않은 페이지는 계정 CRUD 에 접근 못 한다 ----
    // ⚠ 여기서 에이전트를 돌리면 **실제로 로그인이 되어 세션 쿠키가 남고**, 로그인 화면부터 시작해야 하는
    //   뒤 시나리오(SL5)의 전제가 깨진다. 이 검사는 API 노출 여부만 보므로 탭만 연다.
    {
      const tabId = await evalIn(shell,
        `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(fixture.url + 'login')}).then(t => t.id)`, true)
      await sleep(2000)
      const probe = await pageEval(mainOrigin, `JSON.stringify({
        internal: typeof window.internalAPI,
        pw: typeof (window.browserAPI && window.browserAPI.password && window.browserAPI.password.list),
      })`)
      const p = JSON.parse(probe ?? '{}')
      check('SL4', '외부 사이트 페이지에는 계정 CRUD 가 노출되지 않는다',
        p.internal === 'undefined' && p.pw === 'undefined',
        `internalAPI=${p.internal} · browserAPI.password.list=${p.pw}`)
      try { await evalIn(shell, `window.browserAPI.tabs.close(${JSON.stringify(tabId)})`, true) } catch { /* ignore */ }
    }

    // ---- SL5: 로그인 자동 통과 + 원래 작업 완료 ----
    {
      const before = authOn('main').length
      const r = await runAgent({
        reqId: 'SL5', task: '대시보드에서 작업 버튼을 눌러라',
        url: `${fixture.url}start`,
        script: [clickByLabel('작업 버튼'), doneStep],
      })
      const taskDone = await pageEval(mainOrigin, 'window.__taskDone === true')
      const authed = authOn('main').slice(before)
      const loggedIn = authed.some((a) => a.username === FIXTURE_USER && a.password === FIXTURE_PASS)
      check('SL5', '로그인 화면을 스스로 통과하고 원래 작업까지 완료한다',
        loggedIn && taskDone === true && r.types.includes('done'),
        `서버가 받은 정확한 자격증명=${loggedIn} · 후속작업완료=${taskDone} · 이벤트 ${r.types.join('>')}`
        + ` · 관찰URL=${r.evs.filter((e) => e.type === 'observe').map((e) => e.url).join(' → ') || '(없음)'}`
        + ` · 오류=${r.evs.filter((e) => e.type === 'error').map((e) => e.message).join('|') || '없음'}`)
      await r.close()
    }

    // ---- SL9: 등록되지 않은 다른 출처에는 비밀을 넘기지 않는다 ----
    {
      const beforeAlt = authOn('alt').length
      const r = await runAgent({ reqId: 'SL9', task: '로그인해서 대시보드를 열어라', url: `${fixture.altUrl}login`, timeoutMs: 25000 })
      const newAlt = authOn('alt').length - beforeAlt
      check('SL9', '등록되지 않은 다른 출처(다른 포트)에는 비밀번호를 보내지 않는다',
        newAlt === 0 && leakedTo('alt') === 0 && r.asks.length > 0,
        `alt 인증시도=${newAlt}(0이어야 함) · 평문도달=${leakedTo('alt')} · 사람에게 넘김=${r.asks.length > 0}`)
      await r.close()
    }

    // ---- SL10 / SL11: 수상한 폼은 넣지 않는다 ----
    const refuseCases = [
      ['SL10', 'xform', '폼 전송 주소가 다른 출처인 폼(action 변조)'],
      ['SL11a', 'hidden', '화면에 보이지 않는 숨은 폼'],
      ['SL11b', 'signup', '가입 폼(비밀번호 칸 2개)'],
      ['SL11c', 'ambig', '아이디 칸이 모호한 폼'],
    ]
    for (const [id, route, label] of refuseCases) {
      const beforeM = authOn('main').length, beforeA = authOn('alt').length
      const r = await runAgent({ reqId: id, task: '로그인해라', url: `${fixture.url}${route}`, timeoutMs: 25000 })
      const newAuth = (authOn('main').length - beforeM) + (authOn('alt').length - beforeA)
      check(id, `${label}에는 비밀번호를 넣지 않는다`,
        newAuth === 0,
        `인증시도=${newAuth}(0이어야 함) · 대기사유="${(r.asks[0] ?? '(없음)').slice(0, 70)}"`)
      await r.close()
    }

    // ---- SL13: 2단계 인증은 사람에게 넘긴다 ----
    {
      const beforeOtp = fixture.state.otpSubmits.length
      const r = await runAgent({ reqId: 'SL13', task: '로그인해라', url: `${fixture.url}twofa`, timeoutMs: 40000 })
      const askText = r.asks.join(' ')
      const otpNew = fixture.state.otpSubmits.length - beforeOtp
      check('SL13', '2단계 인증(OTP) 화면은 사람에게 넘기고 코드를 대신 넣지 않는다',
        otpNew === 0 && /인증 코드|2단계/.test(askText) && !r.types.includes('done'),
        `OTP 제출=${otpNew}(0이어야 함) · 대기사유="${askText.slice(0, 80)}"`)
      await r.close()
    }

    // ---- SL16: 취소 뒤에는 추가 로그인·제출이 없다 ----
    {
      // (a) 2단계 로그인 **도중** 취소 — 아이디는 제출됐고 비밀번호 단계를 기다리는 사이에 끊는다.
      //     "80ms 안에 취소" 같은 경합이 아니라, 진행 중인 순간을 서버 기록으로 확인한 뒤 끊으므로 결정적이다.
      llm.setScript([doneStep])
      const tabA = await evalIn(shell,
        `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(fixture.url + 'idfirst')}).then(t => t.id)`, true)
      await sleep(2500)
      const baseId = fixture.state.auth.filter((a) => a.path === '/idfirst-next').length
      const basePw = fixture.state.auth.filter((a) => a.path === '/auth' && a.origin !== 'alt').length
      await evalIn(shell, `window.browserAPI.ai.agentStart(${JSON.stringify({ reqId: 'SL16a', tabId: tabA, task: '로그인해라' })})`, true)
      // 아이디 단계가 서버에 도달할 때까지 기다린다(= 로그인 시퀀스가 진행 중임을 확인).
      const dl = Date.now() + 20000
      while (Date.now() < dl && fixture.state.auth.filter((a) => a.path === '/idfirst-next').length === baseId) await sleep(150)
      const idSubmitted = fixture.state.auth.filter((a) => a.path === '/idfirst-next').length > baseId
      await evalIn(shell, 'window.browserAPI.ai.agentCancel("SL16a")', true)
      await sleep(6000)   // 2단계 대기(폴링)보다 넉넉히
      const pwAfter = fixture.state.auth.filter((a) => a.path === '/auth' && a.origin !== 'alt').length - basePw
      try { await evalIn(shell, `window.browserAPI.tabs.close(${JSON.stringify(tabA)})`, true) } catch { /* ignore */ }

      // (b) 인계 대기 중(2단계 인증 화면) 취소 → 추가 제출 0
      const rb = await runAgent({ reqId: 'SL16b', task: '로그인해라', url: `${fixture.url}twofa`, timeoutMs: 40000 })
      const mid = authOn('main').length
      await evalIn(shell, 'window.browserAPI.ai.agentCancel("SL16b")', true)
      await sleep(3500)
      const after = authOn('main').length
      check('SL16', '취소 뒤에는 추가 로그인·제출이 일어나지 않는다',
        idSubmitted && pwAfter === 0 && after === mid,
        `2단계 진행중 취소: 아이디제출=${idSubmitted} → 비밀번호제출=${pwAfter}(0이어야 함) · 대기중취소 후 추가제출=${after - mid}(0이어야 함)`)
      await rb.close()
    }

    // ---- SL8: 자동 로그인을 끈 계정으로는 로그인하지 않는다 ----
    {
      await pwApi('update', { id: mainEntry.id, autoLoginAllowed: false })
      const before = authOn('main').length
      const r = await runAgent({ reqId: 'SL8', task: '로그인해라', url: `${fixture.url}login`, timeoutMs: 25000 })
      const newAuth = authOn('main').length - before
      const askText = r.asks.join(' ')
      check('SL8', '자동 로그인을 끈 계정(opt-out)으로는 로그인하지 않는다',
        newAuth === 0 && /자동 로그인/.test(askText),
        `인증시도=${newAuth}(0이어야 함) · 안내="${askText.slice(0, 90)}"`)
      await r.close()
      await pwApi('update', { id: mainEntry.id, autoLoginAllowed: true })
    }

    // ---- SL14: 허용 계정이 여럿인데 기본이 없으면 아무것도 넣지 않는다 ----
    {
      const second = await pwApi('add', { origin: mainOrigin, username: 'second-user', password: 'another-pass', autoLoginAllowed: true })
      const before = authOn('main').length
      const r = await runAgent({ reqId: 'SL14', task: '로그인해라', url: `${fixture.url}login`, timeoutMs: 25000 })
      const newAuth = authOn('main').length - before
      const askText = r.asks.join(' ')
      check('SL14', '허용 계정이 여럿인데 기본이 정해지지 않으면 입력하지 않고 묻는다',
        newAuth === 0 && /계정이 2개|기본 계정/.test(askText),
        `인증시도=${newAuth}(0이어야 함) · 안내="${askText.slice(0, 90)}"`)
      await r.close()
      // 기본 계정을 지정하면 다시 동작해야 한다(양성 대조 — "전부 막혀서" 통과한 게 아님을 보인다)
      await pwApi('update', { id: mainEntry.id, preferred: true })
      const before2 = authOn('main').length
      const r2 = await runAgent({ reqId: 'SL14b', task: '대시보드에서 작업 버튼을 눌러라', url: `${fixture.url}login`, script: [doneStep], timeoutMs: 40000 })
      const ok2 = authOn('main').slice(before2).some((a) => a.username === FIXTURE_USER && a.password === FIXTURE_PASS)
      check('SL14b', '기본 계정을 지정하면 다시 자동 로그인된다(양성 대조)', ok2,
        `기본 지정 후 로그인=${ok2}`)
      await r2.close()
      if (second?.id) await pwApi('remove', second.id)
    }

    // ---- SL6: 아이디 먼저(2단계) 로그인 ----
    {
      const before = authOn('main').length
      const r = await runAgent({ reqId: 'SL6', task: '대시보드에서 작업 버튼을 눌러라', url: `${fixture.url}idfirst`, script: [doneStep], timeoutMs: 50000 })
      const after = authOn('main').slice(before)
      const idStep = after.some((a) => a.path === '/idfirst-next' && a.username === FIXTURE_USER)
      const pwStep = after.some((a) => a.path === '/auth' && a.password === FIXTURE_PASS)
      check('SL6', '아이디 먼저(2단계) 로그인도 통과한다',
        idStep && pwStep,
        `1단계(아이디)=${idStep} · 2단계(비밀번호)=${pwStep} · 이벤트 ${r.types.join('>')}`)
      await r.close()
    }

    // ---- SL17: 자동 입력(autofill)이 **요청한 프레임의 출처**로만 조회된다 ----
    // 예전에는 페이지 안의 다른 출처 iframe 이 자동 입력을 요청해도 **최상위 페이지의** 자격증명을
    // 돌려줬다(sender URL = 탭의 최상위 문서). 광고·위젯 iframe 하나가 그 사이트에 저장된 아이디·비밀번호를
    // 가져갈 수 있는 경로였다. 이제 senderFrame 의 URL 로 판정한다.
    // ⚠ 이 검사는 **alt 오리진을 등록하기 전에** 돌아야 한다(SL7 이 등록한다).
    {
      const readForm = async (url, label) => {
        const tabId = await evalIn(shell,
          `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(url)}).then(t => t.id)`, true)
        await sleep(3500)   // content preload 의 자동 입력이 DOM 을 훑을 시간
        const v = await pageEval(url, `(function(){
          var f = document.querySelector('iframe');
          try {
            var d = f && f.contentDocument;   // 같은 출처면 읽힌다
            if (d) { var p = d.querySelector('input[type=password]'); var u = d.querySelector('input[name=username]');
              return JSON.stringify({ reachable: true, pw: (p && p.value) || '', user: (u && u.value) || '' }) }
          } catch (e) { /* 교차 출처 — 아래에서 별도로 본다 */ }
          return JSON.stringify({ reachable: false })
        })()`)
        return { tabId, label, ...JSON.parse(v ?? '{"reachable":false}') }
      }
      // 양성 대조: 같은 출처 iframe 은 등록된 계정으로 자동 입력돼야 한다("전부 안 채워져서" 통과가 아님을 보인다)
      const same = await readForm(`${fixture.url}iframe-same`, 'same')
      // 본 검사: 다른 출처(alt) iframe — alt 는 아직 등록되지 않았으므로 **아무것도 채워지면 안 된다**
      const crossTab = await evalIn(shell,
        `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(fixture.url + 'iframe-cross')}).then(t => t.id)`, true)
      // 교차 출처 프레임은 페이지 JS 로 못 읽는다. **읽지 못한 것을 "비어 있음" 으로 세면 빈 검사**가 되므로
      // CDP 로 그 프레임 안에서 직접 평가한다(읽었다는 사실 자체를 판정에 넣는다).
      // 세 경로를 차례로 시도한다 — 프레임이 같은 렌더러에 있을 때와 별도 프로세스(OOPIF)일 때가 다르다:
      //   ① Page.getFrameTree → Page.createIsolatedWorld(frameId) — 같은 렌더러의 자식 프레임
      //   ② Target.setAutoAttach(flatten) 로 붙은 **자식 타깃 세션**에서 평가 — OOPIF
      //   ③ Runtime.executionContextCreated 로 잡은 main-world 컨텍스트
      // ⚠ 어느 경로든 **비밀번호 칸을 실제로 찾았을 때만** read=true 로 친다.
      // `href` 를 함께 받아 **정말 alt 출처 문서를 읽었는지** 확인한다 — 엉뚱한 문서(최상위 래퍼나
      // 같은 출처 폼)를 읽고 "비어 있다" 고 말하면 그것도 빈 검사다.
      const READ_FORM_JS = `JSON.stringify({
        href: location.href,
        pw: (document.querySelector('input[type=password]')||{}).value || '',
        user: (document.querySelector('input[name=username]')||{}).value || '',
        hasForm: !!document.querySelector('input[type=password]')
      })`
      const crossTarget = (await getTargetList(args.port)).find((x) => String(x.url).startsWith(`${fixture.url}iframe-cross`))
      let alt = { pw: '', user: '', read: false, how: '프레임 타깃 없음' }
      const takeForm = (raw, how) => {
        const v = raw?.result?.result?.value ?? raw?.result?.value
        const parsed = v ? JSON.parse(v) : null
        // 비밀번호 칸이 실제로 있고 **그 문서가 alt 출처**일 때만 "읽었다" 로 친다.
        if (parsed && parsed.hasForm && String(parsed.href ?? '').startsWith(altOrigin)) {
          alt = { pw: parsed.pw, user: parsed.user, read: true, how, href: parsed.href }
          return true
        }
        return false
      }
      if (crossTarget) {
        alt.how = '프레임 안 평가 실패'
        const cs = await connectSession(crossTarget, 'cross')
        await ensureSessionReady(cs)
        const ctxs = []
        const childSessions = []
        // ⚠ 구독자 시그니처는 `(_, method, params, sessionId)` 다(build/lib/cdp.mjs). `(msg) => msg.method`
        //   로 쓰면 **아무 이벤트도 못 잡고 조용히 빈 검사**가 된다 — 실제로 그래서 ③ 이 늘 실패했다.
        cs.events.push((_, method, params) => {
          if (method === 'Runtime.executionContextCreated') ctxs.push(params?.context)
          if (method === 'Target.attachedToTarget') childSessions.push(params)
        })
        await cs.send('Runtime.enable', {})
        await cs.send('Page.enable', {}).catch(() => {})
        await cs.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {})
        await sleep(3500)   // content preload 의 자동 입력이 DOM 을 훑을 시간

        // ① 같은 렌더러의 자식 프레임 — 격리 월드를 만들어 그 프레임 문서를 읽는다
        try {
          const tree = await cs.send('Page.getFrameTree', {})
          const root = tree.result?.frameTree ?? tree.frameTree
          const child = (root?.childFrames ?? []).find((f) => String(f?.frame?.url ?? '').startsWith(altOrigin))
          if (child?.frame?.id) {
            const world = await cs.send('Page.createIsolatedWorld',
              { frameId: child.frame.id, worldName: 'sl17-probe', grantUniveralAccess: false })
            const ctxId = world.result?.executionContextId ?? world.executionContextId
            if (ctxId) {
              takeForm(await cs.send('Runtime.evaluate',
                { contextId: ctxId, returnByValue: true, expression: READ_FORM_JS }), '격리 월드(같은 렌더러)')
            }
          }
        } catch { /* OOPIF 면 여기서 실패한다 — ② 로 간다 */ }

        // ② 별도 프로세스(OOPIF) — 자동 부착된 자식 세션에서 평가
        //    lib 의 send() 는 sessionId 를 안 받으므로(16개 하네스가 공유하는 코드라 손대지 않는다)
        //    이 검사 안에서만 sessionId 를 실어 보낸다.
        if (!alt.read) {
          const child = childSessions.find((s) => String(s?.targetInfo?.url ?? '').startsWith(altOrigin))
          if (child?.sessionId) {
            try {
              const id = (cs._id += 1)
              const answer = new Promise((resolve, reject) => cs.pending.set(id, { resolve, reject }))
              const timeout = new Promise((_, rj) => setTimeout(() => {
                cs.pending.delete(id); rj(new Error('OOPIF 세션 응답 없음'))
              }, 10_000))
              cs.ws.send(JSON.stringify({
                id, sessionId: child.sessionId, method: 'Runtime.evaluate',
                params: { returnByValue: true, expression: READ_FORM_JS },
              }))
              takeForm(await Promise.race([answer, timeout]), '자식 타깃 세션(OOPIF)')
            } catch { /* ③ 으로 */ }
          }
        }

        // ③ main-world 실행 컨텍스트
        if (!alt.read) {
          const altCtx = ctxs.find((c) => String(c?.origin ?? '') === altOrigin)
          if (altCtx) {
            takeForm(await cs.send('Runtime.evaluate',
              { contextId: altCtx.id, returnByValue: true, expression: READ_FORM_JS }), '실행 컨텍스트')
          }
        }
        try { cs.close?.() } catch { /* ignore */ }
      }
      const sameFilled = same.reachable && (same.user === FIXTURE_USER || (same.pw ?? '').length > 0)
      // ⚠ **실제로 읽었을 때만** 판정한다 — 못 읽은 것을 "비어 있음" 으로 세면 아무것도 증명하지 못한다.
      const crossEmpty = alt.read && alt.user === '' && alt.pw === ''
      check('SL17', '자동 입력은 요청한 프레임의 출처로만 조회된다(다른 출처 iframe 이 최상위 계정을 가져가지 못한다)',
        crossEmpty && sameFilled,
        `같은 출처 iframe 자동입력=${sameFilled}(양성 대조, true 여야 함, user="${same.user ?? ''}") · `
        + `다른 출처 iframe 실제로 읽음=${alt.read}[${alt.how}${alt.href ? ` ${alt.href}` : ''}] `
        + `비어 있음=${alt.user === '' && alt.pw === ''} (user="${alt.user}" pw길이=${alt.pw.length})`)
      try { await evalIn(shell, `window.browserAPI.tabs.close(${JSON.stringify(same.tabId)})`, true) } catch { /* ignore */ }
      try { await evalIn(shell, `window.browserAPI.tabs.close(${JSON.stringify(crossTab)})`, true) } catch { /* ignore */ }
    }

    // ---- SL7: 허용된 교차 출처 iframe 안의 로그인 폼 ----
    {
      const altAdd = await pwApi('add', { origin: altOrigin, username: FIXTURE_USER, password: FIXTURE_PASS, autoLoginAllowed: true })
      const before = authOn('alt').length
      const r = await runAgent({ reqId: 'SL7', task: '로그인 후 내용을 확인해라', url: `${fixture.url}iframe-cross`, timeoutMs: 50000 })
      const ok = authOn('alt').slice(before).some((a) => a.username === FIXTURE_USER && a.password === FIXTURE_PASS)
      check('SL7', '허용된 교차 출처 iframe 안의 로그인 폼도 처리한다',
        altAdd?.ok === true && ok,
        `alt 등록=${altAdd?.ok} · iframe 안 로그인 성공=${ok} · ${r.results.join(',').slice(0, 80)}`)
      await r.close()
      // SL12 를 위해 alt 비밀번호를 **틀린 값**으로 바꾼다.
      const altEntry = (await pwApi('list')).find((e) => e.origin === altOrigin)
      if (altEntry) await pwApi('update', { id: altEntry.id, password: 'definitely-wrong-pass' })
    }

    // ---- SL12: 틀린 비밀번호 — 성공이라 하지 않고 실패를 누적해 잠근다 ----
    {
      const leakBase = leakedTo('alt')   // SL7 의 정상 로그인은 유출이 아니다 — 증가분만 센다
      let blocked = false, failures = 0, askText = ''
      for (let i = 0; i < 4 && !blocked; i++) {
        const r = await runAgent({ reqId: `SL12-${i}`, task: '로그인해라', url: `${fixture.altUrl}login`, timeoutMs: 45000 })
        askText = r.asks.join(' ')
        await r.close()
        const e = (await pwApi('list')).find((x) => x.origin === altOrigin)
        failures = e?.autoLoginFailures ?? 0
        blocked = (e?.autoLoginBlockedUntil ?? 0) > Date.now()
        if (r.types.includes('done')) break
      }
      check('SL12', '틀린 비밀번호를 성공이라 하지 않고, 상한에서 잠가 계정 잠금을 막는다',
        failures >= 1 && blocked && leakedTo('alt') - leakBase === 0,
        `실패누적=${failures} · 잠김=${blocked} · 비밀번호 바꾼 뒤 정확한 값 유출=${leakedTo('alt') - leakBase}(0이어야 함) · 안내="${askText.slice(0, 70)}"`)
    }

    // ---- SL3: 앱 재시작 후에도 등록·허용이 유지된다 ----
    let restarted = null
    {
      const beforeList = await pwApi('list')
      await sleep(800) // 디바운스 영속화가 디스크에 닿도록
      await shutdown()
      await waitForPortFree(args.port)
      windowId = await launch()
      const t2 = await evalIn(shell,
        `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, "browser://passwords").then(t => t.id)`, true)
      await sleep(2200)
      accountsPage = await connectAccounts()
      const afterList = await pwApi('list')
      const m = (afterList ?? []).find((e) => e.origin === mainOrigin && e.username === FIXTURE_USER)
      const a = (afterList ?? []).find((e) => e.origin === altOrigin)
      restarted = { beforeList, afterList }
      check('SL3', '앱을 껐다 켜도 등록·허용·잠금 상태가 유지된다',
        !!m && m.autoLoginAllowed === true && m.preferred === true
        && !!a && (a.autoLoginBlockedUntil ?? 0) > Date.now(),
        `재시작 전 ${beforeList?.length}건 → 후 ${afterList?.length}건 · 허용유지=${m?.autoLoginAllowed} · 기본유지=${m?.preferred} · 잠금유지=${(a?.autoLoginBlockedUntil ?? 0) > Date.now()}`)
      void t2
    }

    // ---- SL15: 비밀번호가 어디에도 평문으로 남지 않는다 ----
    {
      const hits = []
      // ① 모델이 받은 프롬프트 전부
      const prompts = allPrompts.join(' | ')
      if (prompts.includes(FIXTURE_PASS)) hits.push('모델 프롬프트')
      if (prompts.includes('definitely-wrong-pass')) hits.push('모델 프롬프트(교체한 비밀번호)')
      // ② 실행 이력 · 영속 작업 체크포인트 · 대화 · 기억
      for (const f of ['ai-agent-runs.json', 'ai-tasks.json', 'ai-chats.json', 'ai-memory.md', 'passwords.json']) {
        const p = path.join(profileDir, f)
        if (!fs.existsSync(p)) continue
        if (fs.readFileSync(p, 'utf8').includes(FIXTURE_PASS)) hits.push(f)
      }
      // ③ 앱 로그
      if (fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes(FIXTURE_PASS)) hits.push('app.log')
      // 대조군: 그 비밀번호가 실제로 쓰이긴 했는가(검사가 헛돌지 않았는지)
      const actuallyUsed = fixture.state.auth.some((a) => a.password === FIXTURE_PASS)
      // 검사가 헛돌지 않았는지 두 축으로 확인한다: ① 그 비밀번호가 실제로 로그인에 쓰였는가
      // ② 모델이 실제로 불렸는가(프롬프트가 0건이면 "유출 없음" 은 아무 의미가 없다).
      const promptsSeen = allPrompts.length
      check('SL15', '비밀번호가 모델 프롬프트·실행 이력·체크포인트·로그·저장 파일 어디에도 평문으로 없다',
        hits.length === 0 && actuallyUsed && promptsSeen > 0,
        hits.length === 0
          ? `유출 0건 · 누적 프롬프트 ${promptsSeen}건 검사(0이면 무효) · 대조군(실제 사용됨)=${actuallyUsed}`
          : `유출 발견: ${hits.join(', ')} (누적 프롬프트 ${promptsSeen}건)`)
      void restarted
    }
  } finally {
    await shutdown()
    try { await llm.close() } catch { /* ignore */ }
    try { await fixture.close() } catch { /* ignore */ }
  }

  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  console.log(`\n저장 계정 자동 로그인: ${pass} PASS / ${fail} FAIL`)
  fs.writeFileSync(path.join(args.out, 'saved-login-results.json'),
    JSON.stringify({ at: new Date().toISOString(), pass, fail, results }, null, 2))
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('하네스 오류:', err)
  process.exit(2)
})
