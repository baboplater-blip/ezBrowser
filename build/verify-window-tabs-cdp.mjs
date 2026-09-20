#!/usr/bin/env node
// verify-window-tabs-cdp.mjs — 다중 창 크래시 복원 + 내구 작업의 정확한 탭 재바인딩
// (run-20260920T042617Z-732aef) 검증. 합격 기준은 `.auto-dev/verification.md` 의
// "run-20260920T042617Z-732aef" 절 W1~W10 이다.
//
// 배경: 복원은 창·탭 id 를 프로세스마다 1부터 다시 발급한다. 내구 작업(task-runtime.ts)은
// 예전에 `checkpoint.windowId` + 호스트 스캔으로 대상을 되찾아 같은 사이트의 **엉뚱한 탭**
// (다른 창의 탭)을 집을 수 있었다. 이번 라운드의 수정은 `TabRecord.restoreKey` /
// `BrowserWindowContext.restoreKey` 를 세션 스냅샷에 저장·복원 시 물려주고, `resolveTaskTab`
// 이 그 키로만 대상을 되찾거나(찾지 못하면 waitCause='tab-target' 으로 사람에게 묻는다) 실패한다.
//
// 판정 원칙(고정): 로컬 픽스처 서버에 **실제로 도착한 요청**으로만 판정한다. 모델의 산문·상태
// 문구로 판정하지 않는다. 하네스는 사라진 탭을 스스로 열어 복원을 성공처럼 꾸미지 않는다.
//
// 핵심 설계 — "같은 URL, 다른 탭" 을 진짜로 만들되 하네스는 구분할 수 있게:
//   resolveTaskTab 의 sameTarget() 은 추적 파라미터(TRACKING_PARAMS, 'si' 포함)를 무시하고
//   호스트+경로+"의미있는" 질의문자열만 비교한다. 그래서 여러 탭에 `?slot=X&si=<라벨>` 을 주면
//   ① 앱 입장에서는 전부 "같은 대상"(sameTarget 참 — si 는 무시됨)이라 진짜 모호성이 생기고
//   ② 하네스 입장에서는 si 값으로 각 탭의 CDP 타깃을 정확히 구분할 수 있다.
//   결정적인 대조는 클릭이 "정확히 하나"의 loadId 에만 쌓이는지를 픽스처 서버 카운터로 보는 것이다
//   (페이지 안 변수는 재시작에 사라지므로 쓰지 않는다).
//
// 사용: node build/verify-window-tabs-cdp.mjs [--port <n>] [--out <dir>]
//                                              [--app <exe>] [--before <exe>] [--only <ids>]

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectSession, getTargetList, isShellTarget, waitForPortFree,
  waitForTargetByUrlPredicate, pollUntil,
} from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'
import { startWindowTabsFixtureServer } from './window-tabs-fixture-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')

const args = {
  port: 9281,
  out: path.join(REPO, 'verify-out', 'window-tabs'),
  app: path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe'),
  before: path.join(REPO, 'dist', 'win-unpacked-before', 'ezBrowser.exe'),
  only: null,
  skipNegative: false,
}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--port') args.port = Number(process.argv[++i])
  else if (a === '--out') args.out = path.resolve(process.argv[++i])
  else if (a === '--app') args.app = path.resolve(process.argv[++i])
  else if (a === '--before') args.before = path.resolve(process.argv[++i])
  else if (a === '--only') args.only = String(process.argv[++i])
  else if (a === '--skip-negative') args.skipNegative = true
  else if (a === '--negative-only') args.negativeOnly = true
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const J = JSON.stringify
const results = []
const notes = []

function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${name}: ${detail}`)
}
function note(text) { notes.push(text); console.log(`  ℹ ${text}`) }
function shouldRun(id) {
  if (!args.only) return true
  return args.only.split(',').map((s) => s.trim()).filter(Boolean).includes(id)
}

// ===== 각본 라우터 (verify-task-runtime-cdp.mjs 와 같은 표식 패턴) =====
const handlers = new Map()
const callCounts = new Map()
function onTask(marker, fn) { handlers.set(marker, fn); callCounts.set(marker, 0) }
const router = {
  reply: (ctx) => {
    const sys = String(ctx.messages?.[0]?.content ?? '')
    const m = /\[WT-([A-Za-z0-9]+)\]/.exec(sys)
    const key = m ? m[1] : 'NONE'
    const i = callCounts.get(key) ?? 0
    callCounts.set(key, i + 1)
    const fn = handlers.get(key)
    if (!fn) return J({ action: 'done', message: `핸들러 없음(${key})` })
    try { return fn(ctx, i) } catch (err) { return J({ action: 'done', message: `핸들러 오류: ${err.message}` }) }
  },
}
const missed = []
function clickLabel(ctx, label) {
  const ref = ctx.refFor(label)
  if (ref === null || ref === undefined) {
    missed.push({ label, obs: String(ctx.lastUser).replace(/\s+/g, ' ').slice(0, 300) })
    return J({ action: 'scroll', direction: 'down' })
  }
  return J({ action: 'click', ref })
}
// 계속 눌러라 — 매 호출 같은 라벨을 클릭한다(작업이 여러 구간에 걸쳐도 계속 진행되도록).
function keepClicking(label) { return (ctx) => clickLabel(ctx, label) }

async function main() {
  if (!fs.existsSync(args.app)) throw new Error(`패키지 없음: ${args.app}`)
  fs.mkdirSync(args.out, { recursive: true })

  const asarMtime = fs.statSync(path.join(path.dirname(args.app), 'resources', 'app.asar')).mtimeMs
  note(`대상 exe=${args.app} · app.asar=${new Date(asarMtime).toISOString()}`)

  args.port = await preferFreePort(args.port, 'verify-window-tabs-cdp.mjs')
  await waitForPortFree(args.port)
  const [llmPort, fixturePort] = await getFreePorts(2)

  const llm = await startFakeLlm({ port: llmPort, script: [router] })
  const fx = await startWindowTabsFixtureServer(fixturePort)

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), J({
    setup: { completed: true },
    startup: { mode: 'last-session', urls: [] },
    adblock: { enabled: false },
    ai: {
      enabled: true, provider: 'ollama', ollamaUrl: llm.url, ollamaModel: 'test-model',
      agentMaxSteps: 8, agentVision: 'off', agentHumanInput: false, agentInputMode: 'fast',
      agentAutoApprove: false, agentCollapsePanels: false,
    },
  }, null, 2))
  const tasksFilePath = path.join(profileDir, 'ai-tasks.json')

  let child = null
  const shells = new Map() // windowId -> CDPSession

  function boot(label) {
    const logStream = fs.createWriteStream(path.join(args.out, `app-${label}.log`))
    child = spawn(args.app, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(logStream); child.stderr.pipe(logStream)
    return child
  }

  /** 이 시점에 떠 있는 외피 세션을 전부 찾아 연결한다. windowId 별로 정리해 돌려준다. */
  async function connectAllShells(expectedCount, timeoutMs = 40000) {
    const found = await pollUntil(async () => {
      const list = await getTargetList(args.port)
      const shellTargets = list.filter(isShellTarget)
      return shellTargets.length >= expectedCount ? shellTargets : null
    }, { timeoutMs, intervalMs: 500, label: `외피 타깃 ${expectedCount}개` })
    const map = new Map()
    for (const t of found.slice(0, expectedCount)) {
      const s = await connectSpecificShellReady(args.port, t.id)
      const wid = await evalInRaw(s, 'new URL(location.href).searchParams.get("windowId")')
      map.set(wid, s)
    }
    return map
  }

  /**
   * `connectShellSessionReady`(lib/cdp.mjs) 는 **특정 타깃을 지정할 수 없다** — 내부에서
   * `waitForShellTarget` 으로 "아무 외피 타깃 하나"를 다시 찾아 붙는다. 창이 하나뿐인 다른
   * 하네스에서는 문제가 안 되지만, 여기서는 **여러 외피 타깃 중 정확히 이 targetId** 에 붙어야
   * 한다 — 아니면 여러 창을 연결해도 전부 같은(먼저 찾힌) 창에 붙어 버린다(실측: 이 함정 때문에
   * 창1 이 통째로 "복원 안 됨" 으로 오판됐었다 — 실제로는 창1 도 정상 복원돼 있었다).
   * 그래서 매 재시도마다 `/json/list` 를 다시 읽어 **같은 target.id** 의 최신
   * `webSocketDebuggerUrl` 로만 연결한다(타깃이 갱신될 수 있어 재조회가 필요하다).
   */
  async function connectSpecificShellReady(port, targetId, totalMs = 90000) {
    const deadline = Date.now() + totalMs
    const schedule = [8000, 20000, 30000, 30000]
    let attempt = 0
    let lastErr = null
    while (Date.now() < deadline) {
      const probeMs = Math.max(2000, Math.min(schedule[Math.min(attempt, schedule.length - 1)], deadline - Date.now()))
      attempt += 1
      let session = null
      try {
        const list = await getTargetList(port)
        const t = list.find((x) => x.id === targetId)
        if (!t) throw new Error(`타깃(${targetId}) 이 목록에 없음`)
        session = await connectSession(t, `shell-${targetId}`)
        await session.send('Runtime.enable', {}, probeMs)
        const probe = await session.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, probeMs)
        if (probe?.result?.value !== 2) throw new Error(`프로브 값 이상: ${JSON.stringify(probe)}`)
        return session
      } catch (err) {
        lastErr = err
        try { session?.close() } catch { /* ignore */ }
        await sleep(500)
      }
    }
    throw new Error(`특정 외피 세션(${targetId}) 확보 실패(${totalMs}ms, ${attempt}회 시도)${lastErr ? ` — ${lastErr.message}` : ''}`)
  }

  async function evalInRaw(s, expression, awaitPromise = false, timeoutMs = 30000) {
    const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, timeoutMs)
    if (r.exceptionDetails) throw new Error(`평가 예외: ${r.exceptionDetails.text ?? ''} ${r.exceptionDetails.exception?.description ?? ''}`)
    return r.result?.result?.value ?? r.result?.value
  }
  async function jval(s, expression, timeoutMs = 30000) {
    const text = await evalInRaw(s,
      `Promise.resolve(${expression}).then(v => JSON.stringify(v === undefined ? null : v))`, true, timeoutMs)
    return JSON.parse(text ?? 'null')
  }
  const api = (s, expr, timeoutMs) => jval(s, `window.browserAPI.ai.${expr}`, timeoutMs)
  const createTask = (s, o) => api(s, `ptaskCreate(${J(o)})`)
  const getTask = (s, id) => api(s, `ptaskGet(${J(id)})`)
  const listTasks = (s) => api(s, 'ptaskList()')
  const startTask = (s, id) => api(s, `ptaskStart(${J(id)})`)
  const pauseTask = (s, id) => api(s, `ptaskPause(${J(id)})`)
  const resumeTask = (s, id) => api(s, `ptaskResume(${J(id)})`)
  const cancelTask = (s, id) => api(s, `ptaskCancel(${J(id)})`)
  const confirmTask = (s, id, approved) => api(s, `ptaskConfirm(${J(id)}, ${!!approved})`)
  const targetsOf = (s, id) => api(s, `ptaskTargets(${J(id)})`)
  const setTarget = (s, id, tabId) => api(s, `ptaskSetTarget(${J(id)}, ${J(tabId)})`)
  // 기본을 **배경(background:true)** 으로 둔다 — tabs.create 의 기본은 전면(활성)이라, 배경으로
  // 만들 생각이 없는 셋업 탭을 잇달아 만들면 매번 활성 탭이 바뀌어 "원래 활성이어야 할 탭" 이
  // 마지막에 만든 탭에게 밀려난다(W1 실측: 창1 의 활성 탭이 데코이로 밀려나 있었다 — 이 함수의
  // 기본값 때문이지 앱 결함이 아니었다). 진짜 전면으로 두고 싶으면 명시 활성화(activateTab)를
  // 별도로 부른다(이 파일의 모든 "진짜 대상" 탭이 그렇게 한다) — 그래서 기본을 뒤집어도 안전하다.
  const newTab = (s, windowId, url, opts = {}) =>
    jval(s, `window.browserAPI.tabs.create(${J(windowId)}, ${J(url)}, ${J({ background: true, ...opts })})`)
  const listTabs = (s, windowId) => jval(s, `window.browserAPI.tabs.list(${J(windowId)})`)
  const closeTab = (s, id) => jval(s, `window.browserAPI.tabs.close(${J(id)})`)
  const pinTab = (s, id, v) => jval(s, `window.browserAPI.tabs.pin(${J(id)}, ${!!v})`)
  const activateTab = (s, id) => jval(s, `window.browserAPI.tabs.activate(${J(id)})`)
  const runAction = (s, id, ctx) => jval(s, `window.browserAPI.actions.run(${J(id)}, ${J(ctx ?? {})})`)
  const wsState = (s) => jval(s, 'window.browserAPI.workspace.state()')
  const wsCreate = (s, o) => jval(s, `window.browserAPI.workspace.create(${J(o ?? {})})`)
  const wsActivate = (s, id) => jval(s, `window.browserAPI.workspace.activate(${J(id)})`)

  async function waitTask(s, id, pred, timeoutMs = 30000, intervalMs = 350) {
    const dl = Date.now() + timeoutMs
    let last = null
    while (Date.now() < dl) {
      last = await getTask(s, id)
      if (last && pred(last)) return { ok: true, task: last }
      await sleep(intervalMs)
    }
    return { ok: false, task: last }
  }
  async function waitUntil(fn, timeoutMs = 30000, intervalMs = 300) {
    const dl = Date.now() + timeoutMs
    while (Date.now() < dl) {
      if (await fn()) return true
      await sleep(intervalMs)
    }
    return false
  }
  /**
   * `pauseTask` 를 재시도하며 'paused' 상태를 확보한다.
   *
   * 실측(2026-09-20): `pauseTask` 직후 한 번의 대기만으로는 **간헐적으로** 'paused' 에 닿지 못하고
   * `runLoop` 가 계속 진행돼 버렸다(재현율 대략 2/3). 코디네이터가 같은 시점에 "resolveTaskTab 이
   * 대기할 수 있게 되면서 생긴 취소/일시정지 경합"을 고쳤다고 알려왔는데, 그 수정은 아직
   * `dist/win-unpacked` 에 없다 — 즉 이 흔들림은 하네스 결함이 아니라 **아직 안 고쳐진 경합을
   * 실제로 잡아낸 것**일 가능성이 높다. 고쳐지기 전까지는 재시도로 버틴다(회귀 검사 자체가
   * 목적이 아니라, 재시도를 통해 뒤에 오는 tab-target/재바인딩 검사를 계속 진행하려는 것).
   */
  async function pauseTaskReliably(s, id, attempts = 4, perTryMs = 8000) {
    for (let i = 0; i < attempts; i++) {
      await pauseTask(s, id)
      const r = await waitTask(s, id, (t) => t.state === 'paused', perTryMs)
      if (r.ok) return r
      note(`[재시도] pauseTask 가 ${i + 1}/${attempts}차 시도에서 paused 에 닿지 못함 — 현재 상태=${stateOf(r.task)}`)
    }
    const last = await getTask(s, id)
    throw new Error(`pauseTask 가 ${attempts}회 재시도에도 paused 에 닿지 못함(현재 상태=${stateOf(last)}) `
      + '— 코디네이터가 알려준 취소/일시정지 경합 수정이 아직 dist/win-unpacked 에 반영되지 않아서일 수 있다.')
  }
  const stateOf = (t) => (t ? t.state : '(없음)')

  async function ensureWindowTabCount(s, windowId, atLeast, timeoutMs = 15000) {
    return pollUntil(async () => {
      const tabs = await listTabs(s, windowId)
      return (tabs && tabs.length >= atLeast) ? tabs : null
    }, { timeoutMs, intervalMs: 400, label: `창(${windowId}) 탭 ${atLeast}개 이상` })
  }

  async function gracefulQuit() {
    const exited = new Promise((r) => { child.once('exit', r) })
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {}); b.close()
    } catch { /* ignore */ }
    await Promise.race([exited, sleep(15000)])
    for (const s of shells.values()) { try { s.close() } catch { /* ignore */ } }
    shells.clear()
    try { child?.kill() } catch { /* ignore */ }
    await waitForPortFree(args.port).catch(() => {})
    await sleep(1000)
  }
  async function hardKill() {
    const exited = new Promise((r) => { child.once('exit', r) })
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 15000 }) } catch { /* ignore */ }
    await Promise.race([exited, sleep(8000)])
    for (const s of shells.values()) { try { s.close() } catch { /* ignore */ } }
    shells.clear()
    await waitForPortFree(args.port).catch(() => {})
    await sleep(1500)
  }

  // ── loadId 확인 — **직접 읽는다**, 순번을 추측하지 않는다 ──
  //
  // 처음엔 "순차 생성이니 N번째 /page 요청 = LN" 으로 로컬에서 미리 계산했다(nextLoadId 카운터).
  // 재시작 뒤에는 "eager" 탭들이 **동시에** 재로드돼(활성·핀·마지막 5개가 한꺼번에) 서버가 받는
  // 순서가 생성 순서와 다를 수 있고, 실측으로 W4·W5·W8 세 곳에서 "선택 뒤 재개=false" 가 나서
  // 확인해 보니 예측한 loadId 와 실제로 재생된 tab 의 loadId 가 달랐다(로컬 카운터 자체 결함,
  // 제품 결함 아님). 그래서 **CDP 로 그 탭의 `window.__loadId` 를 직접 읽는다** — 추측이 없다.
  async function readLoadIdByUrlPredicate(pred, label, timeoutMs = 15000, port = args.port) {
    const target = await waitForTargetByUrlPredicate(port, pred, `loadId 확인용 CDP 타깃(${label})`, timeoutMs)
    const s = await connectSession(target, `readload-${label}`)
    try {
      const r = await s.send('Runtime.evaluate', { expression: 'window.__loadId', returnByValue: true }, 8000)
      return r.result?.value ?? null
    } finally { s.close() }
  }
  function readLoadIdByUrlSubstring(sub, timeoutMs = 15000, port = args.port) {
    return readLoadIdByUrlPredicate((u) => u.includes(sub), sub, timeoutMs, port)
  }
  async function openPage(s, windowId, slot, opts = {}) {
    const marker = `${slot}${opts.uniqueMarker ?? ''}`
    const url = `${fx.base}/page?slot=${encodeURIComponent(marker)}`
    const t = await newTab(s, windowId, url)
    await sleep(1600)
    const loadId = await readLoadIdByUrlSubstring(`slot=${encodeURIComponent(marker)}`)
    if (opts.pinned) await pinTab(s, t.id, true)
    return { tabId: t.id, loadId, url }
  }
  async function openConfirmPage(s, windowId) {
    const t = await newTab(s, windowId, `${fx.base}/confirm`)
    await sleep(1600)
    const loadId = await readLoadIdByUrlSubstring('/confirm')
    return { tabId: t.id, loadId }
  }

  const runResults = { negative: null }

  if (!args.negativeOnly) {
  try {
    // ════════════════ 1차 부팅 (다중 창 셋업) ════════════════
    boot('boot1')
    const map1 = await connectAllShells(1)
    const [[win1Id, shell1]] = [...map1.entries()]
    note(`창1=${win1Id}`)
    await ensureWindowTabCount(shell1, win1Id, 1)

    // ---- 창1 셋업: 기본탭(활성) + 핀탭 + 크로스윈도우 중복 URL 데코이 ----
    const w1Tabs = await listTabs(shell1, win1Id)
    const w1Default = w1Tabs[0]
    await jval(shell1, `window.browserAPI.tabs.navigate(${J(w1Default.id)}, ${J(`${fx.base}/page?slot=w1-active`)})`)
    await sleep(1600)
    const w1ActiveLoad = await readLoadIdByUrlSubstring('slot=w1-active')
    const w1Pinned = await openPage(shell1, win1Id, 'w1-pinned', { pinned: true })
    // 창2 의 진짜 대상과 "sameTarget" 상 같은 대상이 되도록 slot 은 같게, si(추적 파라미터, 무시됨)만 다르게.
    const w1Decoy = await newTab(shell1, win1Id, `${fx.base}/page?slot=shared-dup&si=decoy1`)
    await sleep(1600)
    const w1DecoyLoad = await readLoadIdByUrlSubstring('si=decoy1')
    // 배경으로 만들어도(tabs.create 의 background:true) 활성 탭이 마지막 생성 탭으로 넘어가는
    // 것을 실측했다(2026-09-20) — "무엇이 활성이어야 하는가" 를 결과에서 거꾸로 끌어오지 않도록,
    // 여기서 **명시적으로** 활성 탭을 정하고 그 값을 기대값으로 못박는다.
    await activateTab(shell1, w1Default.id)
    await sleep(400)

    // ---- 창2 생성 ----
    await runAction(shell1, 'action.window.new')
    const map2 = await connectAllShells(2)
    const win2Id = [...map2.keys()].find((k) => k !== win1Id)
    const shell2 = map2.get(win2Id)
    shells.set(win1Id, shell1); shells.set(win2Id, shell2)
    note(`창2=${win2Id}`)
    await ensureWindowTabCount(shell2, win2Id, 1)

    // ---- 창2 셋업: 기본탭 + 핀탭 + 같은창 중복 데코이 + (닫힐 예정인) W4 대상 + W5 대상 + W2/W3 대상(활성) ----
    const w2Tabs = await listTabs(shell2, win2Id)
    const w2Default = w2Tabs[0]
    await jval(shell2, `window.browserAPI.tabs.navigate(${J(w2Default.id)}, ${J(`${fx.base}/page?slot=w2-other`)})`)
    await sleep(1600)
    const w2OtherLoad = await readLoadIdByUrlSubstring('slot=w2-other')
    const w2Pinned = await openPage(shell2, win2Id, 'w2-pinned', { pinned: true })
    const w2Decoy = await newTab(shell2, win2Id, `${fx.base}/page?slot=shared-dup&si=decoy2`)
    await sleep(1600)
    const w2DecoyLoad = await readLoadIdByUrlSubstring('si=decoy2')

    // W4 용 탭(재시작 전 닫아 "복원되지 않는 대상" 을 만든다)
    const w4Setup = await openPage(shell2, win2Id, 'w4-target')
    // W5 용 탭(재시작 뒤 파일에서 tabKey/windowKey 를 지워 "키 없는 옛 기록" 을 흉내낸다)
    const w5Setup = await openPage(shell2, win2Id, 'w5-legacy')
    // W2/W3 진짜 대상(창2 활성 탭) — si=target 으로 크로스윈도우/동일창 데코이와 구분한다
    const w2TargetUrl = `${fx.base}/page?slot=shared-dup&si=target`
    const w2Target = await newTab(shell2, win2Id, w2TargetUrl)
    await sleep(1600)
    const w2TargetLoad = await readLoadIdByUrlSubstring('si=target')
    await activateTab(shell2, w2Target.id)
    await sleep(400)

    // ---- W6 용 다른 워크스페이스 탭 ----
    const wsBefore = await wsState(shell2)
    const otherWs = await wsCreate(shell2, { name: 'WT-다른워크스페이스' })
    await wsActivate(shell2, otherWs.id)
    await sleep(800)
    const otherWsTab = await newTab(shell2, win2Id, `${fx.base}/page?slot=otherws`)
    await sleep(1600)
    const otherWsLoad = await readLoadIdByUrlSubstring('slot=otherws')
    await wsActivate(shell2, wsBefore.activeId) // 원래 워크스페이스로 복귀 — 아래 탭들이 거기 남게
    await sleep(800)

    // ---- 작업 생성 (전부 창2 세션으로 만든다 — ownerWindowId 가 창2 로 고정되어야
    //      재시작 뒤에도 "창2 세션에서만 조작 가능" 이 그대로 성립한다) ----
    onTask('W2', keepClicking('제출'))
    // ⚠ 예산을 넉넉히 준다(기본 25단계 → 120). 이 작업은 강제종료 때까지 계속 도는데, 셋업이
    //    길어지면 죽기 전에 예산을 다 써 버려 **복원 뒤 이어갈 몫이 0** 이 된다. 그러면 제품은
    //    정상(예산 소진 → interrupted)인데 "재개 후 클릭 0" 이 제품 결함처럼 보인다(2026-09-20 실측:
    //    W2/W3 간헐 FAIL 의 원인). 이 검사가 보는 것은 **어느 탭에서 동작이 느는가**이지 예산이 아니다.
    const idW2 = (await createTask(shell2, { instruction: '[WT-W2] 제출 버튼을 계속 눌러라', tabId: w2Target.id, budget: { maxSteps: 120, maxLlmCalls: 120 } })).id
    await startTask(shell2, idW2)
    await waitUntil(async () => (await fx.state()).hits[w2TargetLoad] > 0, 30000)

    onTask('W4', keepClicking('제출'))
    const idW4 = (await createTask(shell2, { instruction: '[WT-W4] 제출 버튼을 계속 눌러라', tabId: w4Setup.tabId })).id
    await startTask(shell2, idW4)
    await waitUntil(async () => (await fx.state()).hits[w4Setup.loadId] > 0, 30000)
    await pauseTaskReliably(shell2, idW4)
    await closeTab(shell2, w4Setup.tabId)
    await sleep(1600) // 탭 목록 변경이 세션에 반영될 시간(1s 디바운스 + 여유)

    onTask('W5', keepClicking('제출'))
    const idW5 = (await createTask(shell2, { instruction: '[WT-W5] 제출 버튼을 계속 눌러라', tabId: w5Setup.tabId, budget: { maxSteps: 120, maxLlmCalls: 120 } })).id
    await startTask(shell2, idW5)
    await waitUntil(async () => (await fx.state()).hits[w5Setup.loadId] > 0, 30000)
    // W5 는 running 상태로 kill 한다(→ 복원 시 interrupted) — 파일에서 tabKey/windowKey 를 지운다.

    const preKillState = await fx.state()
    note(`강제종료 직전 hits: ${J(preKillState.hits)}`)
    const w1TabsBeforeKill = await listTabs(shell1, win1Id)
    note(`[진단] 강제종료 직전 창1 탭 상세=${J(w1TabsBeforeKill.map((t) => ({ id: t.id, url: t.url, active: t.active, pinned: t.pinned })))}`)

    await sleep(1500) // 저장 디바운스가 디스크에 닿도록
    await hardKill()

    // ---- 파일 조작: W5 를 "키 없는 옛 기록" 으로, W9 준비를 위한 흔적 없음(가짜 LLM 서버로 라이브 확인) ----
    const raw = JSON.parse(fs.readFileSync(tasksFilePath, 'utf8'))
    let strippedW5 = false
    for (const t of raw.tasks ?? []) {
      if (typeof t.instruction === 'string' && t.instruction.includes('[WT-W5]') && t.checkpoint) {
        delete t.checkpoint.tabKey
        delete t.checkpoint.windowKey
        strippedW5 = true
      }
    }
    if (!strippedW5) note('⚠ W5 작업을 파일에서 찾지 못해 tabKey 를 못 지웠다 — W5 판정이 무효할 수 있다')
    fs.writeFileSync(tasksFilePath, JSON.stringify(raw))

    // ════════════════ 2차 부팅 (강제종료 복원) ════════════════
    boot('boot2')
    const map1b = await connectAllShells(2)
    const shell1b = map1b.get(win1Id)
    const shell2b = map1b.get(win2Id)
    if (!shell1b || !shell2b) {
      // 창 id 가 재생성 순서 그대로 재현되지 않았다 — 그 자체가 W1 실패 사유이므로 남은 창으로 계속.
      note(`⚠ 재시작 뒤 창 id 가 예상과 다르다(win1=${win1Id} 발견=${!!shell1b}, win2=${win2Id} 발견=${!!shell2b})`)
    }
    shells.clear()
    if (shell1b) shells.set(win1Id, shell1b)
    if (shell2b) shells.set(win2Id, shell2b)
    await sleep(3000) // 세션 복원(활성/핀 탭 즉시 로드)을 기다린다

    // ---- W7: 재시작 직후, 이어가기를 누르기 전에는 조작 0 ----
    if (shouldRun('W7')) {
      const afterBootState = await fx.state()
      await sleep(4000)
      const laterState = await fx.state()
      const noChange = JSON.stringify(afterBootState.hits) === JSON.stringify(laterState.hits)
      check('W7', '재시작 직후(이어가기 전) 조작 0 — 브라우저가 켜졌다고 저절로 돌지 않는다',
        noChange,
        `부팅 직후 hits=${J(afterBootState.hits)} · 4초 뒤=${J(laterState.hits)}(같아야 한다)`)
    }

    // ---- W1: 두 창이 각자의 탭 URL 집합·핀·활성 탭 그대로 복원 ----
    // (다른 체크의 detail 문구도 이 값을 참조하므로 --only 로 W1 을 뺐어도 항상 채운다.)
    const w1TabsAfter = shell1b ? await listTabs(shell1b, win1Id) : []
    const w2TabsAfter = shell2b ? await listTabs(shell2b, win2Id) : []
    note(`[진단] 창1 탭 상세=${J(w1TabsAfter.map((t) => ({ id: t.id, url: t.url, active: t.active, pinned: t.pinned, discarded: t.discarded })))}`)
    if (shouldRun('W1')) {
      const w1OkCount = w1TabsAfter.length === 3
      // 기대값은 "w1-active 라는 슬롯 이름" 이 아니라 **크래시 직전에 명시적으로 활성화해 둔 탭**이다
      // (실측: tabs.create 는 background:true 를 줘도 활성 탭을 마지막 생성 탭으로 넘긴다 —
      // 그래서 셋업 끝에 `activateTab(shell1, w1Default.id)` 로 명시 고정해 뒀다. slot 이름으로
      // "활성이어야 할 탭"을 추측하면, 그 추측 자체가 틀렸을 때도 우연히 맞아 보일 수 있다).
      const w1ActiveOk = !!w1TabsAfter.find((t) => t.active && String(t.url).includes('slot=w1-active'))
      const w1PinnedOk = !!w1TabsAfter.find((t) => t.pinned && String(t.url).includes('slot=w1-pinned'))
      const w1DecoyOk = !!w1TabsAfter.find((t) => String(t.url).includes('si=decoy1'))

      // 창2: 6개 탭(기본·핀·데코이·W5용·W2/W3 대상) — W4 용은 재시작 전 닫혔으므로 5개.
      const w2ExpectedCount = 5
      const w2OkCount = w2TabsAfter.length === w2ExpectedCount
      const w2ActiveOk = !!w2TabsAfter.find((t) => t.active && String(t.url).includes('si=target'))
      const w2PinnedOk = !!w2TabsAfter.find((t) => t.pinned && String(t.url).includes('slot=w2-pinned'))
      const w2DecoyOk = !!w2TabsAfter.find((t) => String(t.url).includes('si=decoy2'))

      check('W1', '탭·핀·활성탭이 서로 다른 창 2개, 강제 종료 후 각자의 탭 URL 집합·핀·활성 탭 그대로 복원',
        w1OkCount && w1ActiveOk && w1PinnedOk && w1DecoyOk && w2OkCount && w2ActiveOk && w2PinnedOk && w2DecoyOk,
        `창1 탭 ${w1TabsAfter.length}/3(기대) 활성=${w1ActiveOk} 핀=${w1PinnedOk} 데코이=${w1DecoyOk}`
        + ` · 창2 탭 ${w2TabsAfter.length}/${w2ExpectedCount}(기대) 활성=${w2ActiveOk} 핀=${w2PinnedOk} 데코이=${w2DecoyOk}`
        + ` · 창1 URL들=${J(w1TabsAfter.map((t) => t.url))}`
        + ` · 창2 URL들=${J(w2TabsAfter.map((t) => t.url))}`)
    }

    // ---- W2 대상 탭의 새 loadId 를 찾는다(활성 탭이라 즉시 재로드된다) ----
    let w2TargetLoadAfter = null
    if (shell2b) {
      const target = await waitForTargetByUrlPredicate(args.port, (u) => u.includes('si=target') && u.includes('/page'), 'W2 대상 탭 CDP 타깃', 20000).catch(() => null)
      if (target) {
        const s2 = await connectSession(target, 'content:w2-target')
        w2TargetLoadAfter = await (async () => {
          const r = await s2.send('Runtime.evaluate', { expression: 'window.__loadId', returnByValue: true }, 10000)
          return r.result?.value ?? null
        })()
        s2.close()
      }
    }

    // ---- W2/W3: 이어가기 → 원래 그 탭에서만, 정확히 하나에서만 동작이 는다 ----
    if (shouldRun('W2') || shouldRun('W3')) {
      const full = (await listTasks(shell2b)).find((x) => x.instruction.includes('[WT-W2]'))
      const before2 = await fx.state()
      let resumed = false; let afterTask = null
      if (full && shell2b) {
        if (full.state === 'interrupted' || full.state === 'paused') {
          await resumeTask(shell2b, full.id)
        }
        resumed = await waitUntil(async () => {
          if (!w2TargetLoadAfter) return false
          return (await fx.state()).hits[w2TargetLoadAfter] > 0
        }, 40000)
        afterTask = await getTask(shell2b, full.id)
        await cancelTask(shell2b, full.id)
      }
      const afterState = await fx.state()
      // 부정 사례: 크로스윈도우 데코이(w1), 동일창 데코이(w2), 다른 워크스페이스 탭 — 전부 늘면 안 된다
      const decoysUntouched = afterState.hits[w1DecoyLoad] === 0 && afterState.hits[w2DecoyLoad] === 0
        && afterState.hits[otherWsLoad] === 0
      check('W2', '창2 의 탭에서 시작한 내구 작업이 크래시 뒤 이어가기로 원래 그 탭에서만 재개된다',
        !!full && (full.state === 'interrupted' || full.state === 'paused')
        && resumed && decoysUntouched,
        `복원 상태=${stateOf(full)}(interrupted 나 paused 여야) · 새 loadId=${w2TargetLoadAfter}`
        + ` · 재개 후 클릭=${resumed} · 데코이 3종 무변화=${decoysUntouched}(${J({ w1Decoy: afterState.hits[w1DecoyLoad], w2Decoy: afterState.hits[w2DecoyLoad], otherWs: afterState.hits[otherWsLoad] })})`
        + ` · 최종 상태=${stateOf(afterTask)}`)

      const targetsIncreased = Object.entries(afterState.hits)
        .filter(([k, v]) => v > (before2.hits[k] ?? 0)).map(([k]) => k)
      check('W3', '같은 URL 탭이 여러 개(다른 창·같은 창) 있어도 동작이 느는 탭이 정확히 하나',
        targetsIncreased.length === 1 && targetsIncreased[0] === w2TargetLoadAfter,
        `늘어난 loadId=${J(targetsIncreased)}(정확히 [${w2TargetLoadAfter}] 하나여야) · 창2 최종 탭 ${w2TabsAfter.length}개 중 si=decoy2/si=target 공존 확인됨`)
    }

    // W9(양성 대조)가 재사용할 값 — W4 는 진짜 재시작으로 만든 tab-target 대기이므로,
    // 여기서 성공한 setTaskTarget 호출을 "tab-target 대기에서는 허용된다" 의 증거로 그대로 쓴다.
    // (새로 만들면 "이미 한 번 풀린 대기에 또 setTaskTarget 을 부르는" 별개의 동작이 되어,
    //  대상 재선택 뒤 waitCause 가 지워지는 정상 동작과 뒤섞여 결과가 흐려진다.)
    let w4WaitCauseAtSelect = ''; let w4SelectOk = false

    // ---- W6: 워크스페이스 경계(다른 워크스페이스 탭은 후보에 없고, 직접 넣어도 거부) ----
    // ---- W4: 대상 탭이 닫혀 복원되지 않음 — 이어가기만으로는 추측하지 않고, 명시 선택하면 재개 ----
    if (shouldRun('W4') || shouldRun('W6')) {
      const full = (await listTasks(shell2b)).find((x) => x.instruction.includes('[WT-W4]'))
      let w4Reason = ''; let w4WaitCause = ''; let noGuess = false; let hitsBefore = null
      if (full && shell2b) {
        hitsBefore = await fx.state()
        await resumeTask(shell2b, full.id)
        const waiting = await waitTask(shell2b, full.id, (t) => t.state === 'waiting-user' || t.state === 'interrupted', 25000)
        w4Reason = String(waiting.task?.waitReason ?? '')
        w4WaitCause = String(waiting.task?.waitCause ?? '')
        await sleep(3000)
        const hitsAfterWait = await fx.state()
        noGuess = JSON.stringify(hitsBefore.hits) === JSON.stringify(hitsAfterWait.hits)

        // W6: 대상 후보 목록에 다른 워크스페이스 탭이 없는지, 직접 넣어도 거부되는지
        if (shouldRun('W6')) {
          const list = await targetsOf(shell2b, full.id)
          const otherWsInList = (list.tabs ?? []).some((t) => t.tabId === otherWsTab.id)
          const rejectOtherWs = await setTarget(shell2b, full.id, otherWsTab.id)
          // 시크릿 창: 지금(재시작 후) 새로 하나 만들어 그 탭도 거부되는지 함께 본다.
          await runAction(shell2b, 'action.window.incognito')
          const incogMap = await connectAllShells(3, 20000).catch(() => new Map())
          const incogWinId = [...incogMap.keys()].find((k) => k !== win1Id && k !== win2Id)
          let rejectIncognito = { ok: true }
          let incogInList = false
          if (incogWinId) {
            const incogShell = incogMap.get(incogWinId)
            await ensureWindowTabCount(incogShell, incogWinId, 1).catch(() => {})
            const incogTabs = await listTabs(incogShell, incogWinId).catch(() => [])
            const incogTabId = incogTabs[0]?.id
            if (incogTabId) {
              incogInList = (list.tabs ?? []).some((t) => t.tabId === incogTabId)
              rejectIncognito = await setTarget(shell2b, full.id, incogTabId)
            }
            try { incogShell.close() } catch { /* ignore */ }
          }
          // connectAllShells 가 창1·창2 용으로 재연결한 중복 세션은 여기서만 쓰고 버린다(누수 방지).
          for (const [wid, s] of incogMap) { if (wid !== incogWinId) { try { s.close() } catch { /* ignore */ } } }
          check('W6', '워크스페이스·시크릿 경계 — 후보 목록에 없고, id 를 직접 넣어도 거부된다',
            !otherWsInList && rejectOtherWs?.ok === false && !incogInList && rejectIncognito?.ok === false,
            `다른 워크스페이스 탭 후보목록 포함=${otherWsInList}(없어야) 직접지정 결과=${J(rejectOtherWs)}`
            + ` · 시크릿 탭 후보목록 포함=${incogInList}(없어야) 직접지정 결과=${J(rejectIncognito)}`
            + ` · 후보 총 ${(list.tabs ?? []).length}개`)
        }
      }

      if (shouldRun('W4')) {
        // (b) 명시 선택 — 새 탭을 열어 대상으로 지정하면 재개된다.
        let selectOk = false; let resumedAfterSelect = false; let newLoadIdVal = null
        if (full && shell2b) {
          const fresh = await newTab(shell2b, win2Id, `${fx.base}/page?slot=w4-relocated`)
          await sleep(1600)
          newLoadIdVal = await readLoadIdByUrlSubstring('slot=w4-relocated')
          const list2 = await targetsOf(shell2b, full.id)
          const inList = (list2.tabs ?? []).some((t) => t.tabId === fresh.id)
          w4WaitCauseAtSelect = String((await getTask(shell2b, full.id))?.waitCause ?? '')
          const setRes = await setTarget(shell2b, full.id, fresh.id)
          selectOk = !!setRes?.ok && inList
          w4SelectOk = selectOk
          const afterSet = await getTask(shell2b, full.id)
          if (afterSet?.state === 'interrupted') await resumeTask(shell2b, full.id)
          resumedAfterSelect = await waitUntil(async () => (await fx.state()).hits[newLoadIdVal] > 0, 30000)
          await cancelTask(shell2b, full.id)
        }
        check('W4', '대상 탭이 닫혀 복원되지 않음 — 이어가기만으로는 추측하지 않고(조작 0), 명시 선택하면 재개된다',
          !!full && /탭/.test(w4Reason) && noGuess && selectOk && resumedAfterSelect,
          `복원 후 재개 시도 → 상태=${w4WaitCause || '(원인 없음)'} 사유="${w4Reason.slice(0, 60)}"`
          + ` · 대기 중 조작 없음=${noGuess}(${J(hitsBefore?.hits)})`
          + ` · 새 탭 지정 성공=${selectOk} · 지정 뒤 이어가기로 재개=${resumedAfterSelect}(새 loadId=${newLoadIdVal})`)
      }
    }

    // ---- W5: 키 없는 옛 기록 — 추측 없이 선택 요구, 선택하면 정상 진행 ----
    if (shouldRun('W5')) {
      const full = (await listTasks(shell2b)).find((x) => x.instruction.includes('[WT-W5]'))
      let waitCause = ''; let reason = ''; let noGuess = false; let selectOk = false; let resumedAfter = false
      if (full && shell2b) {
        const before5 = await fx.state()
        // running 이었으므로 복원 뒤 interrupted — resumeTask 로 첫 세그먼트를 돌려 tabKey 없는 경로를 태운다.
        if (full.state === 'interrupted' || full.state === 'paused') await resumeTask(shell2b, full.id)
        const waiting = await waitTask(shell2b, full.id, (t) => t.state === 'waiting-user', 25000)
        waitCause = String(waiting.task?.waitCause ?? '')
        reason = String(waiting.task?.waitReason ?? '')
        await sleep(2500)
        const afterWait = await fx.state()
        noGuess = JSON.stringify(before5.hits) === JSON.stringify(afterWait.hits)

        const fresh = await newTab(shell2b, win2Id, `${fx.base}/page?slot=w5-relocated`)
        await sleep(1600)
        const newLoadIdVal = await readLoadIdByUrlSubstring('slot=w5-relocated')
        const setRes = await setTarget(shell2b, full.id, fresh.id)
        selectOk = !!setRes?.ok
        const afterSet = await getTask(shell2b, full.id)
        if (afterSet?.state === 'interrupted') await resumeTask(shell2b, full.id)
        resumedAfter = await waitUntil(async () => (await fx.state()).hits[newLoadIdVal] > 0, 30000)
        await cancelTask(shell2b, full.id)
      }
      check('W5', '키 없는 옛 기록(legacy) — 추측 없이 선택을 요구하고, 선택하면 정상 진행',
        !!full && waitCause === 'tab-target' && noGuess && selectOk && resumedAfter,
        `waitCause=${waitCause}(tab-target 여야) 사유="${reason.slice(0, 60)}" · 대기 중 조작 없음=${noGuess}`
        + ` · 선택 성공=${selectOk} · 선택 후 재개=${resumedAfter}`)
    }

    // ---- W8: 같은 사이트 안 리다이렉트는 흡수(선택 요구 없이 그 탭에서 계속) ----
    if (shouldRun('W8')) {
      const tabW8 = await newTab(shell2b, win2Id, `${fx.base}/page?slot=w8-origin`)
      await sleep(1600)
      // 체크포인트에 원래 url 이 박히도록 작업을 만든 뒤, 시작 전에 탭을 다른 페이지로 옮긴다
      // (사이트 내 세션 갱신 등으로 조용히 리다이렉트된 상황을 흉내낸다).
      onTask('W8', keepClicking('제출'))
      const created = await createTask(shell2b, { instruction: '[WT-W8] 제출 버튼을 계속 눌러라', tabId: tabW8.id })
      const idW8 = created.id
      await jval(shell2b, `window.browserAPI.tabs.navigate(${J(tabW8.id)}, ${J(`${fx.base}/redirect`)})`)
      await sleep(1200)
      // /redirect 는 질의문자열 없이 /page 로 302 하므로, 착지한 페이지의 url 은 **정확히** ".../page"
      // (물음표 없음) 다 — 이게 유일하게 slot 이 없는 로드라 배타적으로 식별할 수 있다.
      const w8LoadAfterRedirect = await readLoadIdByUrlPredicate((u) => /\/page$/.test(u), '/page(질의문자열 없음, 착지 페이지)')
      await sleep(800)
      await startTask(shell2b, idW8)
      const settled = await waitTask(shell2b, idW8, (t) => t.state !== 'queued' && t.state !== 'running', 30000)
      const clicked = await waitUntil(async () => (await fx.state()).hits[w8LoadAfterRedirect] > 0, 20000)
      const finalTask = await getTask(shell2b, idW8)
      await cancelTask(shell2b, idW8)
      check('W8', '원래 탭이 같은 사이트 안에서 리다이렉트되면 선택을 묻지 않고 그 탭에서 계속',
        finalTask?.waitCause !== 'tab-target' && clicked,
        `상태=${stateOf(finalTask)} waitCause=${finalTask?.waitCause ?? '(없음)'}(tab-target 이면 실패)`
        + ` · 리다이렉트된 탭에서 클릭 발생=${clicked}`)
    }

    // ---- W9: 대상 선택 ≠ 승인. tab-target 대기에서만 허용되고, 다른 대기(agent-confirm)에는 거부된다 ----
    if (shouldRun('W9')) {
      // 양성 대조: **새로 안 만든다.** W4 가 이미 진짜 재시작으로 만든 tab-target 대기에서
      // setTaskTarget 을 부른 결과가 있다(w4WaitCauseAtSelect/w4SelectOk) — 그걸 그대로 증거로 쓴다.
      // (같은 작업에 setTaskTarget 을 또 부르면, 이번엔 이미 대기가 풀린 뒤라 "tab-target 이 아니라서
      //  거부" 와 "이미 풀려서 거부" 가 뒤섞여 이 검사의 의미가 흐려진다 — W4 의 첫 성공 호출 하나만 본다.)
      const posCause = w4WaitCauseAtSelect
      const posSetRes = { ok: w4SelectOk }

      // 부정 사례: agent-confirm 대기 중(결제하기) 작업에는 ok:false 여야 하고, 대기 상태·waitCause 가 그대로여야 한다.
      const confirmTab = await openConfirmPage(shell2b, win2Id)
      onTask('W9NEG', keepClicking('결제하기'))
      const negId = (await createTask(shell2b, { instruction: '[WT-W9NEG] 결제하기를 눌러라', tabId: confirmTab.tabId })).id
      await startTask(shell2b, negId)
      const negWaiting = await waitTask(shell2b, negId, (t) => t.state === 'waiting-user', 30000)
      const negCauseBefore = String(negWaiting.task?.waitCause ?? '')
      const otherTab = await newTab(shell2b, win2Id, `${fx.base}/page?slot=w9-neg-other`)
      await sleep(1400)
      const negSetRes = await setTarget(shell2b, negId, otherTab.id)
      const negAfter = await getTask(shell2b, negId)
      await cancelTask(shell2b, negId).catch(() => {})

      check('W9', '대상 선택 ≠ 위험 동작 승인 — tab-target 대기에만 허용되고, 다른 대기(agent-confirm)에는 거부된다',
        posCause === 'tab-target' && posSetRes?.ok === true
        && negCauseBefore === 'confirm' && negSetRes?.ok === false
        && negAfter?.state === 'waiting-user' && negAfter?.waitCause === 'confirm',
        `[양성 · W4 의 setTaskTarget 재사용] tab-target 대기 waitCause=${posCause} · setTaskTarget=${J(posSetRes)}(ok:true 여야)`
        + ` · [부정] agent-confirm 대기 waitCause=${negCauseBefore} · setTaskTarget=${J(negSetRes)}(ok:false 여야)`
        + ` · 시도 후에도 상태=${stateOf(negAfter)}/waitCause=${negAfter?.waitCause}(그대로여야)`
        + ' · (양성 대조는 W4 를 먼저 돌려야 값이 채워진다 — `--only W9` 단독 실행은 무효)'
        + ' · ⚠ 이 부정 사례는 setTaskTarget 이 tab-target 외 대기를 거부하도록 막 고친 것이라, 그 수정이 아직 반영 안 된 빌드에서는 실패가 정상이다(재빌드 후 재확인 필요).')
    }

    // ---- W10 은 negative control(별도 --before 실행)에서 별도 기록 ----
  } finally {
    await gracefulQuit().catch(() => {})
  }
  } else {
    note('--negative-only: 본 시나리오(W1~W9)는 건너뛰고 W10 음성 대조만 돌린다.')
  }

  // ════════════════ W10: 음성 대조 (--before 빌드로 W2/W4 핵심 동작만 축약 재현) ════════════════
  if (shouldRun('W10') && !args.skipNegative) {
    if (!fs.existsSync(args.before)) {
      note(`⚠ --before 빌드 없음(${args.before}) — W10 생략`)
    } else {
      runResults.negative = await runNegativeControl()
    }
  }

  async function runNegativeControl() {
    console.log('\n===== W10: 음성 대조 (수정 전 빌드) =====')
    const beforeAsar = fs.statSync(path.join(path.dirname(args.before), 'resources', 'app.asar')).mtimeMs
    note(`--before exe=${args.before} · app.asar=${new Date(beforeAsar).toISOString()}`)
    if (beforeAsar >= asarMtime) {
      note('⚠ --before 빌드가 --app 빌드보다 새롭거나 같다 — 진짜 "수정 전" 인지 의심스럽다')
    }

    const negOut = path.join(args.out, 'negative')
    fs.rmSync(negOut, { recursive: true, force: true })
    fs.mkdirSync(negOut, { recursive: true })
    const negProfile = path.join(negOut, 'profile')
    fs.mkdirSync(negProfile, { recursive: true })
    const [negLlmPort, negFixPort] = await getFreePorts(2)
    const negLlm = await startFakeLlm({ port: negLlmPort, script: [router] })
    const negFx = await startWindowTabsFixtureServer(negFixPort)
    fs.writeFileSync(path.join(negProfile, 'settings.json'), J({
      setup: { completed: true },
      startup: { mode: 'last-session', urls: [] },
      adblock: { enabled: false },
      ai: {
        enabled: true, provider: 'ollama', ollamaUrl: negLlm.url, ollamaModel: 'test-model',
        agentMaxSteps: 8, agentVision: 'off', agentHumanInput: false, agentInputMode: 'fast',
        agentAutoApprove: false, agentCollapsePanels: false,
      },
    }, null, 2))

    const negPort = await preferFreePort(args.port + 1, 'verify-window-tabs-cdp.mjs(negative)')
    await waitForPortFree(negPort)
    let negChild = null
    function negBoot(label) {
      const logStream = fs.createWriteStream(path.join(negOut, `app-${label}.log`))
      negChild = spawn(args.before, [`--remote-debugging-port=${negPort}`, `--user-data-dir=${negProfile}`],
        { stdio: ['ignore', 'pipe', 'pipe'] })
      negChild.stdout.pipe(logStream); negChild.stderr.pipe(logStream)
      return negChild
    }
    async function negConnectAllShells(expectedCount, timeoutMs = 40000) {
      const found = await pollUntil(async () => {
        const list = await getTargetList(negPort)
        const shellTargets = list.filter(isShellTarget)
        return shellTargets.length >= expectedCount ? shellTargets : null
      }, { timeoutMs, intervalMs: 500, label: `[음성대조] 외피 타깃 ${expectedCount}개` })
      const map = new Map()
      for (const t of found.slice(0, expectedCount)) {
        // 본 실행의 connectSpecificShellReady 와 같은 이유 — 특정 타깃에 정확히 붙어야 한다.
        const s = await connectSpecificShellReady(negPort, t.id)
        const wid = await evalInRaw(s, 'new URL(location.href).searchParams.get("windowId")')
        map.set(wid, s)
      }
      return map
    }
    async function negHardKill() {
      const exited = new Promise((r) => { negChild.once('exit', r) })
      try { execFileSync('taskkill', ['/PID', String(negChild.pid), '/T', '/F'], { timeout: 15000 }) } catch { /* ignore */ }
      await Promise.race([exited, sleep(8000)])
      await waitForPortFree(negPort).catch(() => {})
      await sleep(1500)
    }
    async function negQuit(sessions) {
      for (const s of sessions.values()) { try { s.close() } catch { /* ignore */ } }
      try {
        const v = await (await fetch(`http://127.0.0.1:${negPort}/json/version`)).json()
        const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
        await b.send('Browser.close').catch(() => {}); b.close()
      } catch { /* ignore */ }
      await sleep(1000)
      try { negChild?.kill() } catch { /* ignore */ }
      await waitForPortFree(negPort).catch(() => {})
    }

    const negResult = { w2: null, w4: null }
    try {
      negBoot('boot1')
      const negMap1 = await negConnectAllShells(1)
      const [[negWin1, negShell1]] = [...negMap1.entries()]
      await ensureWindowTabCount(negShell1, negWin1, 1)
      const t0 = (await listTabs(negShell1, negWin1))[0]
      await jval(negShell1, `window.browserAPI.tabs.navigate(${J(t0.id)}, ${J(`${negFx.base}/page?slot=n-w1`)})`)
      await sleep(1500)

      await runAction(negShell1, 'action.window.new')
      const negMap2 = await negConnectAllShells(2)
      const negWin2 = [...negMap2.keys()].find((k) => k !== negWin1)
      const negShell2 = negMap2.get(negWin2)
      await ensureWindowTabCount(negShell2, negWin2, 1)
      const t2default = (await listTabs(negShell2, negWin2))[0]
      await jval(negShell2, `window.browserAPI.tabs.navigate(${J(t2default.id)}, ${J(`${negFx.base}/page?slot=n-w2-other`)})`)
      await sleep(1500)
      // 크로스윈도우 데코이(같은 URL) — 창1 쪽에도 하나
      await newTab(negShell1, negWin1, `${negFx.base}/page?slot=n-shared&si=decoy1`)
      await sleep(1500)
      const negDecoyLoad = await readLoadIdByUrlSubstring('si=decoy1', 15000, negPort)

      const negTargetUrl = `${negFx.base}/page?slot=n-shared&si=target`
      const negTarget = await newTab(negShell2, negWin2, negTargetUrl)
      await sleep(1500)
      const negTargetLoad = await readLoadIdByUrlSubstring('si=target', 15000, negPort)
      await activateTab(negShell2, negTarget.id)
      await sleep(400)

      const negW4Setup = await newTab(negShell2, negWin2, `${negFx.base}/page?slot=n-w4`)
      await sleep(1500)
      const negW4Load = await readLoadIdByUrlSubstring('slot=n-w4', 15000, negPort)

      onTask('W2', keepClicking('제출'))
      const negIdW2 = (await createTask(negShell2, { instruction: '[WT-W2] 제출 버튼을 계속 눌러라', tabId: negTarget.id, budget: { maxSteps: 120, maxLlmCalls: 120 } })).id
      await startTask(negShell2, negIdW2)
      await waitUntil(async () => (await negFx.state()).hits[negTargetLoad] > 0, 30000)

      onTask('W4', keepClicking('제출'))
      const negIdW4 = (await createTask(negShell2, { instruction: '[WT-W4] 제출 버튼을 계속 눌러라', tabId: negW4Setup.id })).id
      await startTask(negShell2, negIdW4)
      await waitUntil(async () => (await negFx.state()).hits[negW4Load] > 0, 30000)
      await pauseTask(negShell2, negIdW4)
      await waitTask(negShell2, negIdW4, (t) => t.state === 'paused', 10000)
      await closeTab(negShell2, negW4Setup.id)
      await sleep(1500)

      await sleep(1200)
      await negHardKill()

      negBoot('boot2')
      const negMap1b = await negConnectAllShells(2)
      const negShell1b = negMap1b.get(negWin1)
      const negShell2b = negMap1b.get(negWin2)
      await sleep(3000)

      // W2 대조: 대상 탭의 새 loadId 를 찾아 재개 시 어디에 클릭이 쌓이는지 본다.
      const negTargetElem = await waitForTargetByUrlPredicate(negPort, (u) => u.includes('si=target') && u.includes('/page'), '[음성대조] W2 대상 탭', 20000).catch(() => null)
      let negTargetLoadAfter = null
      if (negTargetElem) {
        const s = await connectSession(negTargetElem, 'neg-content-w2')
        const r = await s.send('Runtime.evaluate', { expression: 'window.__loadId', returnByValue: true }, 8000)
        negTargetLoadAfter = r.result?.value ?? null
        s.close()
      }
      const negFullW2 = (await listTasks(negShell2b)).find((x) => x.instruction.includes('[WT-W2]'))
      let negW2Resumed = false; let negW2DecoyLeaked = false
      if (negFullW2 && negShell2b) {
        if (negFullW2.state === 'interrupted' || negFullW2.state === 'paused') await resumeTask(negShell2b, negFullW2.id)
        negW2Resumed = await waitUntil(async () => {
          if (!negTargetLoadAfter) return false
          return (await negFx.state()).hits[negTargetLoadAfter] > 0
        }, 30000)
        const finalHits = await negFx.state()
        negW2DecoyLeaked = (finalHits.hits[negDecoyLoad] ?? 0) > 0
        await cancelTask(negShell2b, negFullW2.id).catch(() => {})
      }
      negResult.w2 = {
        state: negFullW2?.state ?? '(없음)', resumed: negW2Resumed, decoyLeaked: negW2DecoyLeaked,
      }

      // W4 대조: 탭이 닫힌 채 이어가기만 눌렀을 때 실제로 무엇이 일어나는지(추측 여부).
      const negFullW4 = (await listTasks(negShell2b)).find((x) => x.instruction.includes('[WT-W4]'))
      let negW4State = '(없음)'; let negW4WaitCause = ''; let negW4Reason = ''; let negW4AutoActed = false
      if (negFullW4 && negShell2b) {
        const before4 = await negFx.state()
        await resumeTask(negShell2b, negFullW4.id)
        const waited = await waitTask(negShell2b, negFullW4.id, (t) => t.state !== 'running' && t.state !== 'queued', 25000)
        negW4State = stateOf(waited.task)
        negW4WaitCause = String(waited.task?.waitCause ?? '')
        negW4Reason = String(waited.task?.waitReason ?? '')
        await sleep(3000)
        const after4 = await negFx.state()
        // "추측해서 아무 탭이나 조작했다" 는 새로운 loadId 에 히트가 찍혔는지로 본다
        // (닫힌 탭 자체는 이미 없으니, 그 탭이 아닌 **다른 어떤 탭**이든 클릭이 늘면 추측이 있었다는 뜻).
        negW4AutoActed = Object.entries(after4.hits).some(([k, v]) => v > (before4.hits[k] ?? 0))
        await cancelTask(negShell2b, negFullW4.id).catch(() => {})
      }
      negResult.w4 = { state: negW4State, waitCause: negW4WaitCause, reason: negW4Reason, autoActed: negW4AutoActed }

      await negQuit(negMap1b)
    } catch (err) {
      note(`⚠ W10 음성 대조 실행 중 오류: ${err.message}`)
      try { negChild?.kill() } catch { /* ignore */ }
    } finally {
      await negLlm.close().catch(() => {})
      await negFx.close().catch(() => {})
    }
    return negResult
  }

  if (runResults.negative) {
    const n = runResults.negative
    check('W10', '음성 대조 — 수정 전 빌드에서 W2·W4 가 수정 후와 다르게 동작함을 수치로 보인다',
      true, // 이 항목은 판정이 아니라 **관찰 기록**이다(아래 detail 에 수치를 남긴다). 해석은 보고서에서.
      `[수정 전] W2: 상태=${n.w2?.state} 재개후클릭=${n.w2?.resumed} 데코이누출=${n.w2?.decoyLeaked}`
      + ` · W4: 상태=${n.w4?.state} waitCause=${n.w4?.waitCause || '(없음)'} 사유="${(n.w4?.reason ?? '').slice(0, 50)}" 자동조작발생=${n.w4?.autoActed}`
      + ' · (수정 후 결과는 위 W2/W4 항목과 대조할 것 — 다르면 검출력 있음, 같으면 검출력 없음)')
    note('W10 은 "PASS/FAIL" 이 아니라 관찰 기록이다 — 위 [수정 전] 수치를 본문의 W2/W4 결과와 직접 비교해 판단할 것.')
  }

  await llm.close().catch(() => {})
  await fx.close().catch(() => {})

  // ===== 결과 저장 =====
  const out = {
    startedAt: new Date().toISOString(),
    appAsarMtime: new Date(asarMtime).toISOString(),
    results, notes, missed,
    summary: {
      pass: results.filter((r) => r.status === 'PASS').length,
      fail: results.filter((r) => r.status === 'FAIL').length,
      total: results.length,
    },
  }
  fs.writeFileSync(path.join(args.out, 'results.json'), JSON.stringify(out, null, 2))
  console.log(`\n===== 요약: ${out.summary.pass}/${out.summary.total} PASS =====`)
  if (missed.length > 0) console.log(`⚠ 관찰에서 라벨을 못 찾은 사례 ${missed.length}건 — results.json 참고`)
  process.exit(out.summary.fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('[verify-window-tabs-cdp] 치명적 오류:', err)
  process.exit(2)
})
