#!/usr/bin/env node
// verify-task-target-ui-cdp.mjs — 대상 탭 재선택을 **사용자가 실제로 쓰는 UI 로** 검증한다.
//
// 왜 이 하네스가 따로 필요한가:
//   `verify-window-tabs-cdp.mjs` 의 W4·W5·W6·W9 는 같은 기능을 검증하지만 **메인 IPC**
//   (`window.browserAPI.ai.ptaskTargets` / `ptaskSetTarget`)를 직접 부른다. 그 경로가 통과해도
//   ① 카드에 선택 버튼이 안 뜨거나 ② 후보가 DOM 에 안 그려지거나 ③ onClick 이 안 붙어 있으면
//   사용자는 여전히 아무것도 못 한다. 실제로 이 저장소에서 "IPC 는 되는데 패널이 안 바뀌는"
//   결함(설정의 settings.onChange 미구독)이 그 자리에서 나온 적이 있다.
//   그래서 여기서는 **IPC 를 대상 선택에 쓰지 않는다** — `.ai-target-open` / `.ai-target-pick` /
//   이어가기 버튼을 DOM 에서 찾아 그 요소의 click() 을 부른다(React onClick 을 그대로 통과한다).
//   IPC 는 셋업(탭·작업 생성)과 **판정용 읽기**에만 쓴다.
//
// 판정 원칙(고정): 로컬 픽스처 서버에 **실제로 도착한 요청**으로만 "무엇이 실행됐는가" 를 판정한다.
//   상태 문구·모델 산문으로 판정하지 않는다. 하네스는 사라진 탭을 대신 열어 성공처럼 꾸미지 않는다.
//
// 사용: node build/verify-task-target-ui-cdp.mjs [--port <n>] [--out <dir>] [--app <exe>] [--only <ids>]

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectShellSessionReady, waitForPortFree, getTargetList, isShellTarget,
  connectSession, pollUntil,
} from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'
import { startWindowTabsFixtureServer } from './window-tabs-fixture-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')

const args = {
  port: 9287,
  out: path.join(REPO, 'verify-out', 'task-target-ui'),
  app: path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe'),
  only: null,
}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--port') args.port = Number(process.argv[++i])
  else if (a === '--out') args.out = path.resolve(process.argv[++i])
  else if (a === '--app') args.app = path.resolve(process.argv[++i])
  else if (a === '--only') args.only = String(process.argv[++i])
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

// ===== 각본 라우터 — 지시문의 [TT-<키>] 표식으로 핸들러를 고른다 =====
const handlers = new Map()
const callCounts = new Map()
function onTask(marker, fn) { handlers.set(marker, fn); callCounts.set(marker, 0) }
const missed = []
const router = {
  reply: (ctx) => {
    const sys = String(ctx.messages?.[0]?.content ?? '')
    const m = /\[TT-([A-Za-z0-9-]+)\]/.exec(sys)
    const key = m ? m[1] : 'NONE'
    const i = callCounts.get(key) ?? 0
    callCounts.set(key, i + 1)
    const fn = handlers.get(key)
    if (!fn) return J({ action: 'done', message: `핸들러 없음(${key})` })
    try { return fn(ctx, i) } catch (err) { return J({ action: 'done', message: `핸들러 오류: ${err.message}` }) }
  },
}
function clickLabel(ctx, label) {
  const ref = ctx.refFor(label)
  if (ref === null || ref === undefined) {
    missed.push({ label, obs: String(ctx.lastUser).replace(/\s+/g, ' ').slice(0, 240) })
    return J({ action: 'scroll', direction: 'down' })
  }
  return J({ action: 'click', ref })
}
const keepClicking = (label) => (ctx) => clickLabel(ctx, label)

async function main() {
  if (!fs.existsSync(args.app)) throw new Error(`패키지 없음: ${args.app}`)
  fs.mkdirSync(args.out, { recursive: true })
  const asarPath = path.join(path.dirname(args.app), 'resources', 'app.asar')
  note(`대상 exe=${args.app} · app.asar=${new Date(fs.statSync(asarPath).mtimeMs).toISOString()}`)

  args.port = await preferFreePort(args.port, 'verify-task-target-ui-cdp.mjs')
  await waitForPortFree(args.port)
  const [llmPort, fixturePort] = await getFreePorts(2)
  const llm = await startFakeLlm({ port: llmPort, script: [router] })
  const fx = await startWindowTabsFixtureServer(fixturePort)

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), J({
    setup: { completed: true },
    startup: { mode: 'newtab', urls: [] },
    adblock: { enabled: false },
    ai: {
      enabled: true, provider: 'ollama', ollamaUrl: llm.url, ollamaModel: 'test-model',
      agentMaxSteps: 8, agentVision: 'off', agentHumanInput: false, agentInputMode: 'fast',
      agentAutoApprove: false, agentCollapsePanels: false,
    },
  }, null, 2))

  let child = null
  let shell = null
  const pageSessions = []

  function boot() {
    const logStream = fs.createWriteStream(path.join(args.out, 'app.log'))
    child = spawn(args.app, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(logStream); child.stderr.pipe(logStream)
  }

  // ===== 평가 헬퍼 =====
  async function evalRaw(s, expression, awaitPromise = false, timeoutMs = 30000) {
    const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, timeoutMs)
    if (r.exceptionDetails) {
      throw new Error(`평가 예외: ${r.exceptionDetails.text ?? ''} ${r.exceptionDetails.exception?.description ?? ''}`)
    }
    return r.result?.result?.value ?? r.result?.value
  }
  async function jval(s, expression, timeoutMs = 30000) {
    const text = await evalRaw(s, `Promise.resolve(${expression}).then(v => JSON.stringify(v === undefined ? null : v))`, true, timeoutMs)
    return JSON.parse(text ?? 'null')
  }
  // IPC — **셋업과 판정용 읽기 전용**. 대상 선택(ptaskSetTarget)은 이 하네스에서 절대 부르지 않는다.
  const api = (expr, t) => jval(shell, `window.browserAPI.ai.${expr}`, t)
  const createTask = (o) => api(`ptaskCreate(${J(o)})`)
  const getTask = (id) => api(`ptaskGet(${J(id)})`)
  const startTask = (id) => api(`ptaskStart(${J(id)})`)
  const pauseTask = (id) => api(`ptaskPause(${J(id)})`)
  const resumeTask = (id) => api(`ptaskResume(${J(id)})`)
  const cancelTask = (id) => api(`ptaskCancel(${J(id)})`)
  const confirmTask = (id, approved) => api(`ptaskConfirm(${J(id)}, ${!!approved})`)
  const newTab = (windowId, url, opts = {}) =>
    jval(shell, `window.browserAPI.tabs.create(${J(windowId)}, ${J(url)}, ${J({ background: true, ...opts })})`)
  const closeTab = (id) => jval(shell, `window.browserAPI.tabs.close(${J(id)})`)
  const activateTab = (id) => jval(shell, `window.browserAPI.tabs.activate(${J(id)})`)
  const runAction = (id, ctx) => jval(shell, `window.browserAPI.actions.run(${J(id)}, ${J(ctx ?? {})})`)
  const wsCreate = (o) => jval(shell, `window.browserAPI.workspace.create(${J(o ?? {})})`)
  const wsActivate = (id) => jval(shell, `window.browserAPI.workspace.activate(${J(id)})`)
  const wsState = () => jval(shell, 'window.browserAPI.workspace.state()')

  async function waitUntil(fn, timeoutMs = 30000, intervalMs = 300) {
    const dl = Date.now() + timeoutMs
    while (Date.now() < dl) { if (await fn()) return true; await sleep(intervalMs) }
    return false
  }
  async function waitTask(id, pred, timeoutMs = 40000) {
    let last = null
    const ok = await waitUntil(async () => { last = await getTask(id); return !!last && pred(last) }, timeoutMs, 400)
    return { ok, task: last }
  }

  /** 픽스처 페이지의 loadId 를 URL 조각으로 찾는다(탭 ↔ loadId 지도). */
  async function readLoadIdByUrlSubstring(sub) {
    const list = await getTargetList(args.port)
    const t = list.find((x) => x.type === 'page' && String(x.url).includes(sub))
    if (!t) return null
    const s = await connectSession(t, `page-${sub}`)
    pageSessions.push(s)
    try { return await evalRaw(s, 'window.__loadId ?? null') } catch { return null }
  }

  // ===== DOM 조작 — 여기가 이 하네스의 존재 이유다 =====
  // 모든 조작은 실제로 그려진 요소를 찾아 `.click()` 한다. React 18 은 루트에 위임 리스너를 두므로
  // 이 클릭은 컴포넌트의 onClick 핸들러를 그대로 통과한다(핸들러를 우회하는 보조 함수가 아니다).
  const cardSel = (marker) => `(() => {
    const cards = [...document.querySelectorAll('.ai-task-card')]
    return cards.find(x => (x.querySelector('.ai-task-instruction')?.getAttribute('title') || '').includes(${J(marker)})) || null
  })()`

  /** 카드의 현재 DOM 상태를 그대로 읽는다(제품 상태가 아니라 **화면에 보이는 것**). */
  async function readCard(marker) {
    return jval(shell, `(() => {
      const c = ${cardSel(marker)}
      if (!c) return null
      const picker = c.querySelector('.ai-target-picker')
      return {
        badge: (c.querySelector('.ai-task-badge')?.textContent || '').trim(),
        note: (c.querySelector('.ai-task-note')?.textContent || '').trim(),
        hasOpenBtn: !!c.querySelector('.ai-target-open'),
        pickerOpen: !!picker,
        expected: (c.querySelector('.ai-target-expected')?.textContent || '').trim(),
        candidates: [...c.querySelectorAll('.ai-target-pick')].map(b => ({
          tabId: b.getAttribute('data-tab-id'),
          text: (b.textContent || '').replace(/\\s+/g, ' ').trim(),
        })),
        buttons: [...c.querySelectorAll('button')].map(b =>
          (b.getAttribute('title') || '') + '|' + (b.textContent || '').replace(/\\s+/g, ' ').trim()),
        hasConfirmBtns: !!c.querySelector('.ai-confirm-yes'),
      }
    })()`)
  }

  /** 카드 안의 "🎯 대상 탭 선택" 버튼을 실제로 누른다. */
  async function clickOpenPicker(marker) {
    return jval(shell, `(() => {
      const c = ${cardSel(marker)}
      if (!c) return 'no-card'
      const b = c.querySelector('.ai-target-open')
      if (!b) return 'no-button'
      if (b.disabled) return 'disabled'
      b.click(); return 'clicked'
    })()`)
  }
  /** 후보 목록에서 그 tabId 버튼을 실제로 누른다(목록에 없으면 누를 수 없다 — 그것이 요점이다). */
  async function clickCandidate(marker, tabId) {
    return jval(shell, `(() => {
      const c = ${cardSel(marker)}
      if (!c) return 'no-card'
      const b = [...c.querySelectorAll('.ai-target-pick')].find(x => x.getAttribute('data-tab-id') === ${J(tabId)})
      if (!b) return 'not-in-list'
      if (b.disabled) return 'disabled'
      b.click(); return 'clicked'
    })()`)
  }
  /** title 에 이 조각이 들어간 카드 버튼을 실제로 누른다(이어가기·중단 등). */
  async function clickCardButtonByTitle(marker, needle) {
    return jval(shell, `(() => {
      const c = ${cardSel(marker)}
      if (!c) return 'no-card'
      const b = [...c.querySelectorAll('button')].find(x => (x.getAttribute('title') || '').includes(${J(needle)}))
      if (!b) return 'no-button'
      if (b.disabled) return 'disabled'
      b.click(); return 'clicked'
    })()`)
  }
  /** 픽커 안의 텍스트 버튼(닫기·↻)을 실제로 누른다. */
  async function clickPickerButtonByText(marker, text) {
    return jval(shell, `(() => {
      const c = ${cardSel(marker)}
      if (!c) return 'no-card'
      const p = c.querySelector('.ai-target-picker')
      if (!p) return 'no-picker'
      const b = [...p.querySelectorAll('button')].find(x => (x.textContent || '').trim() === ${J(text)})
      if (!b) return 'no-button'
      b.click(); return 'clicked'
    })()`)
  }
  async function waitCard(marker, pred, timeoutMs = 20000) {
    let last = null
    const ok = await waitUntil(async () => { last = await readCard(marker); return !!last && pred(last) }, timeoutMs, 350)
    if (!ok && !last) note(`⚠ 카드[${marker}] 를 DOM 에서 못 찾음 — ${J(await domSnapshot())}`)
    return { ok, card: last }
  }
  /** 카드를 못 찾았을 때 "왜" 를 바로 알 수 있게 외피 DOM 상태를 찍는다. */
  async function domSnapshot() {
    return jval(shell, `(async () => ({
      aiTab: !!document.querySelector('.ai-tab'),
      cards: document.querySelectorAll('.ai-task-card').length,
      titles: [...document.querySelectorAll('.ai-task-instruction')].map(x => x.getAttribute('title')),
      view: document.querySelector('.ai-history-head span')?.textContent || '(기본)',
      sidepanels: document.querySelectorAll('.sidepanel').length,
      aiBody: !!document.querySelector('.ai-body'),
      bodyHtml: (document.querySelector('.ai-body')?.innerHTML || '(없음)').slice(0, 300),
      taskList: document.querySelectorAll('.ai-task-list').length,
      aiTabCount: document.querySelectorAll('.ai-tab').length,
      // 같은 창에서 IPC 로 직접 물어본 목록 — 여기엔 있는데 DOM 에 없다면 렌더러 상태 문제다.
      ipcTasks: (await window.browserAPI.ai.ptaskList()).map(t => t.instruction + '=' + t.state),
    }))()`).catch((e) => ({ error: e.message }))
  }

  /**
   * ⚠ 영속 작업 카드는 **에이전트 모드에서만** 그려진다. 챗 모드(기본)의 `.ai-body` 는 다른 분기라
   * 카드가 아예 없다(AiTab.tsx: mode==='chat' 분기 vs 그 아래 에이전트 분기). 이걸 몰라서
   * "IPC 에는 작업이 있는데 화면엔 카드 0개" 를 제품 결함으로 오인할 뻔했다(2026-09-20 실측).
   */
  async function ensureAgentMode() {
    await jval(shell, `(() => {
      const b = [...document.querySelectorAll('.ai-mode-btn')].find(x => (x.textContent||'').includes('에이전트'))
      if (!b) return 'no-button'
      if (!b.classList.contains('active')) b.click()
      return 'ok'
    })()`)
    await sleep(400)
  }

  async function openAiPanel(windowId) {
    await runAction('action.ai.open', { windowId })
    const dl = Date.now() + 20000
    let reopened = false
    while (Date.now() < dl) {
      if (await jval(shell, `!!document.querySelector('.ai-tab')`)) return true
      if (!reopened && Date.now() > dl - 12000) { await runAction('action.ai.open', { windowId }); reopened = true }
      await sleep(500)
    }
    return false
  }

  /**
   * 작업을 만들어 픽스처 탭에 **실제로 묶은 뒤**, 그 탭을 닫아 'tab-target' 대기로 보낸다.
   * (앱이 스스로 다른 탭을 추측하지 않는다는 것은 W4 가 이미 검증한다 — 여기서는 그 대기 상태를
   *  만들어 놓고 **UI 로 풀 수 있는지**만 본다.)
   */
  async function makeTabTargetTask(marker, windowId, urlPath = '/page') {
    const slot = `${marker}-orig`
    const tab = await newTab(windowId, `${fx.base}${urlPath}?slot=${slot}`)
    await activateTab(tab.id)
    await sleep(1600)
    const loadId = await readLoadIdByUrlSubstring(`slot=${slot}`)
    const created = await createTask({
      instruction: `[TT-${marker}] 제출 버튼을 계속 눌러라`,
      tabId: tab.id,
      budget: { maxSteps: 60, maxLlmCalls: 60 },
    })
    await startTask(created.id)
    const bound = await waitUntil(async () => (await fx.state()).hits[loadId] > 0, 40000)
    if (!bound) note(`⚠ [${marker}] 원래 탭(${loadId})에 동작이 도달하지 않았다 — 셋업이 불완전하다`)
    // 일시정지는 간헐적으로 한 번에 안 먹는다(구간 루프가 이미 돌고 있을 수 있다 —
    // verify-window-tabs-cdp.mjs 의 pauseTaskReliably 와 같은 이유). **확실히 멈춘 뒤에** 탭을 닫아야
    // 한다: 실행 중에 탭이 사라지면 'tab-gone' 결과 경로를 타 'user-fix' 로 가 버려서, 이 하네스가
    // 보려는 'tab-target' 대기가 만들어지지 않는다(2026-09-20 실측).
    let paused = false
    for (let i = 0; i < 4 && !paused; i++) {
      await pauseTask(created.id)
      paused = (await waitTask(created.id, (t) => t.state === 'paused', 8000)).ok
      if (!paused) note(`[${marker}] 일시정지 ${i + 1}차 실패 — 현재 상태=${(await getTask(created.id))?.state}`)
    }
    if (!paused) note(`⚠ [${marker}] 일시정지에 닿지 못했다 — 아래 대기 사유가 tab-target 이 아닐 수 있다`)
    await closeTab(tab.id)
    await sleep(1200)
    // 실행 중이던 탭이 사라지면 먼저 'user-fix'(사람이 손 볼 것)로 간다. 대상 재선택 대기
    // ('tab-target')는 **그 다음 이어가기**에서 resolveTaskTab 이 복원 키로 탭을 못 찾을 때 생긴다.
    // 그래서 tab-target 에 닿을 때까지 이어가기를 몇 번 준다(2026-09-20 실측으로 확인된 순서).
    // ⚠ `resumeTask` 는 paused·interrupted 에서만 받는다(waiting-user 는 거부). 'user-fix' 대기의
    //    정상 출구는 확인(confirmTask(id,true)) — 카드의 "▶ 처리했습니다 — 이어가기"/승인 버튼이
    //    그 경로다. 상태에 맞는 출구를 골라야 다음 구간으로 넘어가 tab-target 에 닿는다.
    let waiting = { ok: false, task: null }
    for (let i = 0; i < 3 && !waiting.ok; i++) {
      const cur = await getTask(created.id)
      if (cur?.state === 'waiting-user') await confirmTask(created.id, true)
      else await resumeTask(created.id)
      waiting = await waitTask(created.id, (t) => t.waitCause === 'tab-target', 30000)
      if (!waiting.ok) {
        const now = await getTask(created.id)
        note(`[${marker}] 진행 ${i + 1}회차 — 상태=${now?.state} waitCause=${now?.waitCause ?? '(없음)'}`)
      }
    }
    return { id: created.id, origLoadId: loadId, origTabId: tab.id, bound, reachedWait: waiting.ok, task: waiting.task }
  }

  try {
    boot()
    shell = await connectShellSessionReady(args.port)
    // 외피 렌더러의 오류를 놓치지 않는다 — "화면에 안 그려진다" 의 원인이 대개 여기 있다.
    const rendererErrors = []
    shell.events?.on?.('Runtime.exceptionThrown', (p) => {
      rendererErrors.push(String(p?.exceptionDetails?.exception?.description ?? p?.exceptionDetails?.text ?? '').slice(0, 300))
    })
    shell.events?.on?.('Runtime.consoleAPICalled', (p) => {
      if (p?.type === 'error') {
        rendererErrors.push('[console.error] ' + (p.args ?? []).map((a) => String(a?.value ?? a?.description ?? '')).join(' ').slice(0, 300))
      }
    })
    globalThis.__rendererErrors = rendererErrors
    const windowId = await evalRaw(shell, 'new URL(location.href).searchParams.get("windowId")')
    note(`창 id=${windowId}`)
    if (!(await openAiPanel(windowId))) throw new Error('AI 사이드바를 열지 못했다')
    await ensureAgentMode()

    // ── 경계 밖 탭 준비: 다른 워크스페이스 탭(TG4 용) ──
    const wsBefore = await wsState()
    const otherWs = await wsCreate({ name: 'TT-다른워크스페이스' })
    await wsActivate(otherWs.id)
    await sleep(900)
    const otherWsTab = await newTab(windowId, `${fx.base}/page?slot=otherws`)
    await sleep(1400)
    await wsActivate(wsBefore.activeId)
    await sleep(900)
    note(`다른 워크스페이스 탭 id=${otherWsTab.id}`)

    // ════════════ TG1 · TG2 · TG5(선택≠실행) — 한 작업으로 흐름 전체 ════════════
    if (shouldRun('TG1') || shouldRun('TG2')) {
      onTask('A', keepClicking('제출'))
      const t = await makeTabTargetTask('A', windowId)
      note(`[A] 대기 도달=${t.reachedWait} waitCause=${t.task?.waitCause} 상태=${t.task?.state}`)
      await ensureAgentMode()

      // 고를 수 있는 탭 2개를 사람이 연 상태로 만든다 — **하나는 고를 것, 하나는 미끼**.
      // 둘 다 같은 사이트·같은 워크스페이스라 앱 입장에서는 진짜로 모호하다.
      const pickTab = await newTab(windowId, `${fx.base}/page?slot=A-pick`)
      const decoyTab = await newTab(windowId, `${fx.base}/page?slot=A-decoy`)
      await sleep(1800)
      const pickLoad = await readLoadIdByUrlSubstring('slot=A-pick')
      const decoyLoad = await readLoadIdByUrlSubstring('slot=A-decoy')

      // ---- TG1: 카드에 선택 버튼이 뜨고, 눌러야 후보 목록이 그려진다 ----
      const before = await readCard('A')
      const openRes = await clickOpenPicker('A')
      const opened = await waitCard('A', (c) => c.pickerOpen && c.candidates.length > 0, 20000)
      const cand = opened.card?.candidates ?? []
      const hasPick = cand.some((c) => c.tabId === pickTab.id)
      const hasDecoy = cand.some((c) => c.tabId === decoyTab.id)
      if (shouldRun('TG1')) {
        check('TG1', '대상 탭 선택 UI — 카드에 버튼이 뜨고, 실제 클릭으로 후보 목록이 DOM 에 그려진다',
          !!t.reachedWait && before?.hasOpenBtn === true && openRes === 'clicked'
          && opened.ok && hasPick && hasDecoy,
          `대기 도달=${t.reachedWait}(waitCause=${t.task?.waitCause}) · 접힌 상태에 선택버튼=${before?.hasOpenBtn}`
          + ` · 클릭=${openRes} · 펼친 뒤 후보 ${cand.length}개(고를탭 포함=${hasPick} 미끼 포함=${hasDecoy})`
          + ` · 원래 대상 표시="${(opened.card?.expected ?? '').slice(0, 80)}"`)
      }

      // ---- TG2: 후보를 클릭 → 이어가기 전에는 조작 0 → 이어가기 클릭 후 **고른 탭에만** 동작 ----
      if (shouldRun('TG2')) {
        const hitsBeforePick = (await fx.state()).hits
        const pickRes = await clickCandidate('A', pickTab.id)
        // 고른 뒤에는 픽커가 닫히고 '미완료'(interrupted)로 간다 — **실행이 아니다**.
        const afterPick = await waitCard('A', (c) => !c.pickerOpen, 15000)
        const taskAfterPick = await getTask(t.id)
        // 선택만으로는 아무 동작도 일어나지 않아야 한다 — 3초 지켜본다.
        await sleep(3000)
        const hitsAfterPick = (await fx.state()).hits
        const zeroBeforeResume = J(hitsBeforePick) === J(hitsAfterPick)

        // 이어가기를 **DOM 에서** 누른다.
        const resumeRes = await clickCardButtonByTitle('A', '이어가기')
        const ranOnPick = await waitUntil(async () => (await fx.state()).hits[pickLoad] > 0, 40000)
        await sleep(2500)
        const finalHits = (await fx.state()).hits
        const decoyUntouched = (finalHits[decoyLoad] ?? 0) === 0
        const origUntouched = (finalHits[t.origLoadId] ?? 0) === (hitsBeforePick[t.origLoadId] ?? 0)

        check('TG2', '선택→이어가기 — 이어가기 전 조작 0, 이어가기 후 **고른 그 탭에만** 동작이 는다',
          pickRes === 'clicked' && afterPick.ok && taskAfterPick?.state === 'interrupted'
          && taskAfterPick?.waitCause === undefined && zeroBeforeResume
          && resumeRes === 'clicked' && ranOnPick && decoyUntouched && origUntouched,
          `후보 클릭=${pickRes} · 클릭 후 상태=${taskAfterPick?.state}(interrupted 여야, 실행 아님)`
          + ` waitCause=${taskAfterPick?.waitCause ?? '(지워짐)'}`
          + ` · 이어가기 전 조작 0=${zeroBeforeResume}(${J(hitsAfterPick)})`
          + ` · 이어가기 클릭=${resumeRes} → 고른 탭(${pickLoad}) 동작=${finalHits[pickLoad] ?? 0}`
          + ` · 미끼 탭(${decoyLoad})=${finalHits[decoyLoad] ?? 0}(0 이어야) · 옛 탭(${t.origLoadId})=${finalHits[t.origLoadId] ?? 0}`)
      }
      await cancelTask(t.id)
    }

    // ════════════ TG3 — 고르지 않고 닫으면 아무것도 묶이지 않는다 ════════════
    if (shouldRun('TG3')) {
      onTask('B', keepClicking('제출'))
      const t = await makeTabTargetTask('B', windowId)
      const spare = await newTab(windowId, `${fx.base}/page?slot=B-spare`)
      await sleep(1600)
      const spareLoad = await readLoadIdByUrlSubstring('slot=B-spare')

      const hitsBefore = (await fx.state()).hits
      const openRes = await clickOpenPicker('B')
      const opened = await waitCard('B', (c) => c.pickerOpen && c.candidates.length > 0, 20000)
      // 고르지 않고 **닫기**만 누른다.
      const closeRes = await clickPickerButtonByText('B', '닫기')
      const collapsed = await waitCard('B', (c) => !c.pickerOpen && c.hasOpenBtn, 15000)
      await sleep(3000)
      const hitsAfter = (await fx.state()).hits
      const afterTask = await getTask(t.id)
      const stillWaiting = afterTask?.waitCause === 'tab-target'
      const zeroAction = J(hitsBefore) === J(hitsAfter)

      check('TG3', '고르지 않고 닫으면 — 아무 탭에도 묶이지 않고 대기가 그대로 유지된다(조작 0)',
        openRes === 'clicked' && opened.ok && closeRes === 'clicked' && collapsed.ok
        && stillWaiting && zeroAction && (hitsAfter[spareLoad] ?? 0) === 0,
        `펼침=${openRes} 후보 ${opened.card?.candidates?.length ?? 0}개 · 닫기=${closeRes}`
        + ` · 다시 접힘(선택버튼 복귀)=${collapsed.ok} · waitCause=${afterTask?.waitCause}(tab-target 유지여야)`
        + ` · 조작 0=${zeroAction}(여분 탭 ${spareLoad}=${hitsAfter[spareLoad] ?? 0})`)
      await cancelTask(t.id)
    }

    // ════════════ TG4 — 경계 밖(다른 워크스페이스·시크릿) 탭은 목록에 아예 없다 ════════════
    if (shouldRun('TG4')) {
      onTask('C', keepClicking('제출'))
      const t = await makeTabTargetTask('C', windowId)
      const okTab = await newTab(windowId, `${fx.base}/page?slot=C-ok`)
      await sleep(1400)

      // 시크릿 창을 열고 그 안에 같은 사이트 탭을 만든다.
      await runAction('action.window.incognito')
      await sleep(2500)
      let incogTabId = null
      let incogShell = null
      try {
        const list = await getTargetList(args.port)
        const shellTargets = list.filter(isShellTarget)
        for (const tg of shellTargets) {
          const s = await connectSession(tg, `shell-probe-${tg.id}`)
          const wid = await evalRaw(s, 'new URL(location.href).searchParams.get("windowId")')
          const incog = await evalRaw(s, 'new URL(location.href).searchParams.get("incognito")')
          if (wid !== windowId && incog === '1') { incogShell = s; break }
          try { s.close() } catch { /* ignore */ }
        }
        if (incogShell) {
          const iwid = await evalRaw(incogShell, 'new URL(location.href).searchParams.get("windowId")')
          const it = await jval(incogShell,
            `window.browserAPI.tabs.create(${J(iwid)}, ${J(`${fx.base}/page?slot=C-incog`)}, ${J({ background: true })})`)
          incogTabId = it?.id ?? null
          await sleep(1500)
        }
      } catch (e) { note(`⚠ 시크릿 창 준비 실패: ${e.message}`) }

      const openRes = await clickOpenPicker('C')
      const opened = await waitCard('C', (c) => c.pickerOpen && c.candidates.length > 0, 20000)
      const ids = (opened.card?.candidates ?? []).map((c) => c.tabId)
      const otherWsShown = ids.includes(otherWsTab.id)
      const incogShown = incogTabId ? ids.includes(incogTabId) : false
      const okShown = ids.includes(okTab.id)
      // 목록에 없는 탭은 **클릭 자체가 불가능**하다 — 그것을 DOM 으로 확인한다.
      const clickOtherWs = await clickCandidate('C', otherWsTab.id)
      const clickIncog = incogTabId ? await clickCandidate('C', incogTabId) : 'not-in-list'
      const afterTask = await getTask(t.id)

      check('TG4', '경계 밖 탭은 후보 목록에 그려지지 않는다 — 다른 워크스페이스·시크릿 탭은 UI 에서 고를 수 없다',
        openRes === 'clicked' && opened.ok && okShown && !otherWsShown && !incogShown
        && clickOtherWs === 'not-in-list' && clickIncog === 'not-in-list'
        && afterTask?.waitCause === 'tab-target',
        `후보 ${ids.length}개 · 허용 탭 보임=${okShown} · 다른 워크스페이스 탭 보임=${otherWsShown}(없어야)`
        + ` · 시크릿 탭(${incogTabId ?? '생성실패'}) 보임=${incogShown}(없어야)`
        + ` · DOM 클릭 시도: 다른워크스페이스=${clickOtherWs} 시크릿=${clickIncog}(둘 다 not-in-list 여야)`
        + ` · 대기 유지=${afterTask?.waitCause}`)
      try { incogShell?.close() } catch { /* ignore */ }
      await cancelTask(t.id)
    }

    // ════════════ TG5 — 대상 선택은 승인이 아니다: 위험 동작 관문은 그대로 걸린다 ════════════
    if (shouldRun('TG5')) {
      // 눈앞에 있는 것을 누른다 — 원래 탭(/page)에서는 "제출", 고른 탭(/confirm)에서는 "결제하기".
      // ⚠ 원래 탭까지 결제 페이지로 두면 **셋업 도중에** 관문이 걸려서, 거기서 빠져나오려고
      //   confirmTask(true) 를 부르게 된다(= 검사가 보려는 것을 셋업이 미리 승인해 버린다).
      //   위험 동작은 **사용자가 대상을 고른 뒤에야** 처음 나타나야 판정이 깨끗하다.
      onTask('D', (ctx) => {
        const pay = ctx.refFor('결제하기')
        if (pay !== null && pay !== undefined) return J({ action: 'click', ref: pay })
        return clickLabel(ctx, '제출')
      })
      const t = await makeTabTargetTask('D', windowId)
      const payTab = await newTab(windowId, `${fx.base}/confirm?slot=D-pick`)
      await sleep(1600)
      const payLoad = await readLoadIdByUrlSubstring('slot=D-pick')

      const openRes = await clickOpenPicker('D')
      const opened = await waitCard('D', (c) => c.pickerOpen && c.candidates.length > 0, 20000)
      const pickRes = await clickCandidate('D', payTab.id)
      await waitCard('D', (c) => !c.pickerOpen, 15000)
      const resumeRes = await clickCardButtonByTitle('D', '이어가기')
      // 이어가면 결제 관문(critical)에서 멈춰야 한다 — 결제는 실행되면 안 된다.
      const gated = await waitTask(t.id, (x) => x.state === 'waiting-user' || x.state === 'interrupted', 60000)
      await sleep(2500)
      const hits = (await fx.state()).hits
      const notPaid = (hits[payLoad] ?? 0) === 0
      const cardAtGate = await readCard('D')

      check('TG5', '대상 선택 ≠ 승인 — 대상을 골라 이어가도 위험 동작(결제)은 관문에서 멈추고 실행되지 않는다',
        t.bound && t.reachedWait
        && openRes === 'clicked' && pickRes === 'clicked' && resumeRes === 'clicked'
        && gated.ok && notPaid && cardAtGate?.pickerOpen === false,
        `셋업(원래 탭에서 정상 동작=${t.bound}, 관문 없이 tab-target 도달=${t.reachedWait})`
        + ` · 선택=${pickRes} 이어가기=${resumeRes} · 이어간 뒤 상태=${gated.task?.state}`
        + ` waitCause=${gated.task?.waitCause ?? '(없음)'} 사유="${String(gated.task?.waitReason ?? '').slice(0, 60)}"`
        + ` · 결제 실행 안 됨=${notPaid}(고른 탭 ${payLoad}=${hits[payLoad] ?? 0}, 0 이어야)`
        + ` · 카드 버튼=${J((cardAtGate?.buttons ?? []).slice(0, 6))}`)

      // ---- TG6: 그 관문 대기에서는 대상 선택 UI 자체가 제공되지 않는다 ----
      if (shouldRun('TG6')) {
        const atGate = await readCard('D')
        const isConfirmWait = gated.task?.waitCause === 'confirm'
        check('TG6', '확인 대기(결제 관문)에서는 대상 선택 UI 가 아예 뜨지 않는다 — 선택으로 관문을 통과할 길이 없다',
          isConfirmWait && atGate?.hasOpenBtn === false && atGate?.pickerOpen === false,
          `waitCause=${gated.task?.waitCause ?? '(없음)'}(confirm 이어야) · 선택버튼 노출=${atGate?.hasOpenBtn}(false 여야)`
          + ` · 픽커 열림=${atGate?.pickerOpen}(false 여야) · 승인/거부 버튼 노출=${atGate?.hasConfirmBtns}`)
      }
      await cancelTask(t.id)
    }

    // ════════════ TG7 — 하네스 자기검증(공회전 방지) ════════════
    // 이 저장소는 "아무것도 못 찾아서 통과한" 검사에 여러 번 당했다(낡은 결과 파일, 부분일치
    // 스크래핑, 정리 코드가 증거를 지운 경우). 위 검사들이 'clicked'/'not-in-list' 를 근거로
    // 쓰는 만큼, 그 판정값들이 **없는 대상에 대해서는 반드시 실패로 나오는지** 직접 확인한다.
    if (shouldRun('TG7')) {
      const ghostCard = await readCard('존재하지않는마커-XYZ')
      const ghostOpen = await clickOpenPicker('존재하지않는마커-XYZ')
      const ghostPick = await clickCandidate('존재하지않는마커-XYZ', 'tab-999999')
      const ghostBtn = await clickCardButtonByTitle('존재하지않는마커-XYZ', '이어가기')
      check('TG7', '하네스 자기검증 — 없는 카드·없는 후보에는 조작이 성공으로 보고되지 않는다',
        ghostCard === null && ghostOpen === 'no-card' && ghostPick === 'no-card' && ghostBtn === 'no-card',
        `없는 카드 읽기=${J(ghostCard)}(null 이어야) · 픽커 열기=${ghostOpen} · 후보 클릭=${ghostPick}`
        + ` · 이어가기=${ghostBtn} (모두 no-card 여야 — 'clicked' 가 나오면 위 검사들의 근거가 무너진다)`)
    }

    if (missed.length) note(`⚠ 각본이 라벨을 못 찾은 횟수=${missed.length} (첫 건: ${J(missed[0]).slice(0, 200)})`)
  } finally {
    for (const s of pageSessions) { try { s.close() } catch { /* ignore */ } }
    try { shell?.close() } catch { /* ignore */ }
    if (child?.pid) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    }
    await sleep(800)
    try { await fx.close() } catch { /* ignore */ }
    try { await llm.close() } catch { /* ignore */ }
  }

  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  fs.writeFileSync(path.join(args.out, 'task-target-ui-results.json'),
    J({ at: new Date().toISOString(), pass, fail, results, notes }, null, 2))
  console.log(`\n대상 선택 UI 검증: ${pass} PASS / ${fail} FAIL`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(2) })
