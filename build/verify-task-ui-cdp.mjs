#!/usr/bin/env node
// verify-task-ui-cdp.mjs — 영속 작업 UI(AiTab 의 TaskCard)가 **화면에서 실제로** 동작하는지 확인한다.
//
// 왜 (2026-09-18): 이 저장소에서 "기능이 규격대로 도는가"만 보는 하네스가 전부 초록인 채로 몇 달을
// 지나온 전례가 있다(`.auto-dev/lessons.md`). IPC 를 직접 불러 상태 전이만 확인하면 통과하지만,
// 화면에 버튼이 없거나 모드 전환이 안 되는 결함이 그 사이에 숨는다. 그래서 이 하네스는 **사용자가
// 누르는 경로 그대로**(사이드바 열기 → 에이전트 모드 → 입력창에 타이핑 → 실행 버튼 클릭 → 카드의
// 일시정지/재개/중단/승인 버튼 클릭)만 쓴다. 조회(ptaskList/ptaskGet)는 검증에만 쓰고 조작에는
// 쓰지 않는다(`build/verify-ai-connect-cdp.mjs` 의 선례를 그대로 따른다).
//
// 모델은 실제로 부르지 않는다 — `lib/fake-llm.mjs` 의 각본 서버로 `ai.ollamaUrl` 을 돌린다.
// 지시문에 `[TU-<marker>]` 표식을 박고(작업 지시문은 시스템 프롬프트에 그대로 실려 나간다 —
// `verify-task-runtime-cdp.mjs` 가 같은 방식으로 이미 검증한 경로), **첫** 표식으로 핸들러를 고른다.
//
// 사용: node build/verify-task-ui-cdp.mjs [--port <n>] [--out <dir>] [--keep-profile]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectSession, connectShellSessionReady, ensureSessionReady,
  getTargetList, isShellTarget, sleep, waitForPortFree,
} from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')
const ASAR = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar')

const args = { port: 9285, out: path.join(REPO_ROOT, 'verify-out', 'task-ui'), keepProfile: false }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--keep-profile') args.keepProfile = true
}

const results = []
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
  return ok
}
function gap(id, name, detail) {
  results.push({ id, name, status: 'GAP', detail })
  console.log(`  ○ ${id} GAP — ${detail}`)
}
function fail(id, name, detail) {
  results.push({ id, name, status: 'FAIL', detail })
  console.log(`  ✗ ${id} FAIL — ${detail}`)
}

// ── 로컬 fixture 서버(의존성 0) ──────────────────────────────────────────
// task-runtime-server.mjs 는 다른 작업자가 동시에 만들고 있어 쓰지 않는다(회귀 위험) — 내 모든
// 시나리오는 클릭 대상 요소가 필요 없는 scroll/done 액션만 쓰므로 아주 얇은 페이지 하나면 충분하다.
function startPageServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end('<!doctype html><meta charset="utf-8"><title>작업 UI 검증</title>'
        + '<body style="font:16px system-ui;padding:24px"><h1>작업 UI 검증용 페이지</h1></body>')
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      resolve({
        port: actual,
        url: `http://127.0.0.1:${actual}/`,
        async close() {
          await new Promise((r) => {
            // 앱의 keep-alive 연결 때문에 close() 가 끝나지 않는 정지를 이 저장소에서 겪었다.
            try { server.closeAllConnections?.() } catch { /* ignore */ }
            const t = setTimeout(r, 3000)
            server.close(() => { clearTimeout(t); r() })
          })
        },
      })
    })
  })
}

// ── 각본 LLM 라우터 — 표식(marker) → 핸들러 ─────────────────────────────
const handlers = new Map()
function onTask(marker, fn) { handlers.set(marker, fn) }
const router = {
  reply: (ctx) => {
    const sys = String(ctx.messages?.[0]?.content ?? '')
    const m = /\[TU-([A-Za-z0-9]+)\]/.exec(sys)
    const key = m ? m[1] : null
    const fn = key ? handlers.get(key) : null
    if (!fn) return JSON.stringify({ action: 'done', message: `핸들러 없음(${key})` })
    try { return fn(ctx) } catch (e) { return JSON.stringify({ action: 'done', message: `각본 오류: ${e.message}` }) }
  },
}
const SCROLL = JSON.stringify({ action: 'scroll', direction: 'down' })
const DONE_NOW = JSON.stringify({ action: 'done', message: '완료했습니다.' })
// U1·U3·U4·U5·U7·U9 는 끝나지 않는 작업(카드가 계속 'running' 이어야 조작 시나리오를 시험할 수 있다).
for (const m of ['U1', 'U3', 'U4', 'U5', 'U7', 'U9']) onTask(m, () => SCROLL)
// U6·U8 은 즉시 done(근거 없음) — needs-verify 유도.
for (const m of ['U6', 'U8']) onTask(m, () => DONE_NOW)

// ── CDP 헬퍼 ──────────────────────────────────────────────────────────────
async function evaluate(session, expression, timeoutMs = 20_000) {
  const r = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'JS 예외')
  return r.result?.value
}

async function pollExpr(session, expression, predicate, { timeoutMs = 20_000, intervalMs = 400, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await evaluate(session, expression)
    if (predicate(last)) return last
    await sleep(intervalMs)
  }
  throw new Error(`timeout(${timeoutMs}ms) waiting for ${label} — 마지막 값: ${JSON.stringify(last)}`)
}

async function setFieldValue(session, selector, value) {
  return evaluate(session, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return el.value
  })()`)
}

async function clickSelector(session, selector) {
  return evaluate(session, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el || el.disabled) return false
    el.click(); return true
  })()`)
}

async function clickByText(session, selector, text) {
  return evaluate(session, `(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const el = els.find(x => (x.textContent || '').trim() === ${JSON.stringify(text)})
    if (!el || el.disabled) return false
    el.click(); return true
  })()`)
}

function cardExpr(marker) {
  return `(() => {
    const cards = [...document.querySelectorAll('.ai-task-card')]
    const c = cards.find(x => (x.querySelector('.ai-task-instruction')?.getAttribute('title') || '').includes(${JSON.stringify(marker)}))
    if (!c) return null
    return {
      badge: (c.querySelector('.ai-task-badge')?.textContent || '').trim(),
      note: (c.querySelector('.ai-task-note')?.textContent || '').trim(),
      elapsed: (c.querySelector('.ai-task-meta span')?.textContent || '').trim(),
      // title 과 textContent 를 모두 담는다 — 버튼마다 title(짧은 동사)·textContent(아이콘+동사)가
      // 다르고 검사는 둘 중 하나만 알 수도 있다(예: title="완료를 확인하고 승인" vs 본문 "✅ 결과 승인").
      buttons: [...c.querySelectorAll('button')].map(b => (b.getAttribute('title') || '').trim() + '|' + (b.textContent || '').trim()),
    }
  })()`
}
async function openTaskList(session) {
  const already = await evaluate(session, `document.querySelector('.ai-history-head span')?.textContent === '영속 작업'`)
  if (already) return
  await clickByText(session, '.ai-meta-actions .ai-mini-btn', '📌 작업')
  await pollExpr(session, `document.querySelector('.ai-history-head span')?.textContent === '영속 작업'`, (v) => v === true,
    { timeoutMs: 8_000, label: '"📌 작업" 전체 목록 열림' })
}
async function closeTaskList(session) {
  const open = await evaluate(session, `document.querySelector('.ai-history-head span')?.textContent === '영속 작업'`)
  if (!open) return
  await clickByText(session, '.ai-history-head-actions .ai-mini-btn', '닫기')
  await pollExpr(session, `!!document.querySelector('.ai-input-row')`, (v) => v === true,
    { timeoutMs: 8_000, label: '"📌 작업" 전체 목록 닫힘(입력창 복귀)' })
}
async function waitCard(session, marker, predicate, opts) {
  return pollExpr(session, cardExpr(marker), (v) => !!v && predicate(v), { label: `카드[${marker}]`, ...opts })
}
async function clickCardButton(session, marker, title) {
  return evaluate(session, `(() => {
    const cards = [...document.querySelectorAll('.ai-task-card')]
    const c = cards.find(x => (x.querySelector('.ai-task-instruction')?.getAttribute('title') || '').includes(${JSON.stringify(marker)}))
    if (!c) return 'no-card'
    const btn = [...c.querySelectorAll('button')].find(b => (b.getAttribute('title') || '') === ${JSON.stringify(title)})
    if (!btn) return 'no-button'
    btn.click(); return 'clicked'
  })()`)
}
async function taskIdByMarker(session, marker) {
  return evaluate(session, `(async () => {
    const list = await window.browserAPI.ai.ptaskList()
    const t = list.find(x => (x.instruction || '').includes(${JSON.stringify(marker)}))
    return t ? t.id : null
  })()`)
}
async function switchMode(session, label) {
  const clicked = await clickByBtnTextIncludes(session, '.ai-mode-btn', label)
  if (clicked) await sleep(200)
  return clicked
}
async function clickByBtnTextIncludes(session, selector, needle) {
  return evaluate(session, `(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const el = els.find(x => (x.textContent || '').includes(${JSON.stringify(needle)}))
    if (!el) return false
    el.click(); return true
  })()`)
}

async function openAiPanel(session, windowId) {
  await evaluate(session, `window.browserAPI.actions.run('action.ai.open', { windowId: ${JSON.stringify(windowId)} })`)
  const deadline = Date.now() + 20_000
  let reopened = false
  while (Date.now() < deadline) {
    const found = await evaluate(session, `!!document.querySelector('.ai-tab')`)
    if (found) return true
    // 사이드바 마운트가 레이스로 늦을 수 있다(verify-ai-connect-cdp.mjs 선례) — 절반 지점에 한 번 더 연다.
    if (!reopened && Date.now() > deadline - 12_000) {
      await evaluate(session, `window.browserAPI.actions.run('action.ai.open', { windowId: ${JSON.stringify(windowId)} })`)
      reopened = true
    }
    await sleep(500)
  }
  return false
}

async function ensureExecMode(session, label) {
  await clickByText(session, '.ai-exec-mode .ai-chip', label)
  await sleep(150)
}

async function ensureAgentReady(session) {
  await switchMode(session, '에이전트')
  // 전송 버튼은 입력이 비어 있어도 disabled 다(!agentTask.trim()) — 준비 신호로는 부적합.
  // 제공자·탭 준비는 textarea 자체의 disabled(!providerReady || isInternal || agentRunning) 로 본다.
  await pollExpr(session, `!!document.querySelector('.ai-input-row textarea.ai-input:not(:disabled)')`, (v) => v === true,
    { timeoutMs: 15_000, label: '에이전트 입력창 준비(제공자 연결·탭 활성화)' })
}

async function runAgentTaskViaUi(session, marker, instructionSuffix) {
  await setFieldValue(session, '.ai-input', `[TU-${marker}] ${instructionSuffix}`)
  const clicked = await clickSelector(session, '.ai-input-row .ai-send')
  if (!clicked) throw new Error(`[TU-${marker}] 실행 버튼을 누르지 못함(비활성 상태였을 수 있음)`)
}

/** 카드가 실행 중·일시정지 등 살아 있으면 중단 → 삭제까지 UI 로 정리한다. */
async function cleanupCard(session, marker) {
  let card = await evaluate(session, cardExpr(marker))
  let openedList = false
  if (!card) {
    // 완료·실패·중단(terminal) 카드는 인라인 진행 목록에서 빠지고 "📌 작업" 전체 목록에만 남는다
    // (의도된 동작 — livePtasks 필터). 거기서 찾아 정리한다.
    await openTaskList(session)
    openedList = true
    card = await evaluate(session, cardExpr(marker))
  }
  if (!card) { if (openedList) await closeTaskList(session); return }
  if (card.buttons.some((b) => b.includes('중단'))) {
    await clickCardButton(session, marker, '중단')
    await sleep(500)
  }
  await clickCardButton(session, marker, '목록에서 삭제')
  await sleep(300)
  if (openedList) await closeTaskList(session)
}

// ── 정직성 판정 함수(UI5 의 음성 대조용으로 실제 코드에서 추출) ─────────────
// 완료 배지("✅ 완료" 류)가 뜨지 않고, 안내문이 "완료하지 못했습니다" 를 정직하게 말해야 한다.
function judgeInterruptedHonest(badgeText, noteText) {
  if (/^✅?\s*완료\s*$/.test((badgeText || '').replace(/[^\S\r\n]/g, ' ').trim())) return false
  if (!/완료하지\s*못했습니다/.test(noteText || '')) return false
  return true
}

async function main() {
  fs.mkdirSync(args.out, { recursive: true })
  if (!fs.existsSync(EXE)) { console.error(`exe 없음: ${EXE} — 팀장이 패키징해야 한다`); process.exit(2) }

  // ── 신선도 대조 ───────────────────────────────────────────────────────
  const asarMtime = fs.statSync(ASAR).mtimeMs
  const srcFiles = [
    'app/renderer/components/AiTab.tsx', 'app/renderer/styles.css',
    'app/main/features/ai/task-runtime.ts', 'app/main/ipc/ai.ts',
  ]
  const newestSrc = srcFiles
    .map((p) => ({ p, t: (() => { try { return fs.statSync(path.join(REPO_ROOT, p)).mtimeMs } catch { return 0 } })() }))
    .reduce((a, b) => (b.t > a.t ? b : a), { p: '(없음)', t: 0 })
  console.log(`[신선도] app.asar=${new Date(asarMtime).toISOString()} · 최신 소스=${newestSrc.p} ${new Date(newestSrc.t).toISOString()}`)
  if (asarMtime < newestSrc.t) {
    console.warn('[신선도] ⚠ 패키지가 소스보다 오래됐다 — 낡은 바이너리를 검사하고 있을 수 있다(재패키징 필요)')
  }

  args.port = await preferFreePort(args.port, 'verify-task-ui-cdp.mjs')
  if (!(await waitForPortFree(args.port))) { console.error(`포트 ${args.port} 점유 중`); process.exit(2) }
  const [llmPort, pagePort] = await getFreePorts(2)

  const llm = await startFakeLlm({ port: llmPort, script: [router] })
  const pageSrv = await startPageServer(pagePort)

  const profileDir = path.join(args.out, 'profile')
  if (!args.keepProfile) fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true, completedAt: Date.now(), version: 'verify-task-ui' },
    startup: { mode: 'newtab', urls: [] },
    adblock: { enabled: false },
    ai: {
      enabled: true,
      provider: 'ollama',
      ollamaUrl: llm.url,
      // 도구 허용목록에 없는 이름 → 네이티브 tool-use 대신 JSON 액션 경로(결정론적, fake-llm 이 그 형식만 답한다).
      ollamaModel: 'test-model',
      agentMaxSteps: 6,
      agentVision: 'off',
      agentHumanInput: false,   // 합성 입력을 빠르게(사람 흉내 지연 없이)
      agentInputMode: 'fast',
      agentAutoApprove: false,
      agentCollapsePanels: false,
    },
  }, null, 2))

  let child = null
  let shellA = null
  let shellB = null

  try {
    child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`], {
      env: { ...process.env }, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.pipe(fs.createWriteStream(path.join(args.out, 'app-stdout.log')))
    child.stderr?.pipe(fs.createWriteStream(path.join(args.out, 'app-stderr.log')))

    shellA = await connectShellSessionReady(args.port, { log: (m) => console.log(`[task-ui] ${m}`) })
    const windowIdA = await evaluate(shellA, `new URL(location.href).searchParams.get('windowId')`)
    await sleep(1200)

    // ── 준비: 패널 열기 → 에이전트 모드 → 조작 대상 탭(http) 생성·활성화 ────
    const opened = await openAiPanel(shellA, windowIdA)
    check('SETUP-1', 'AI 패널이 실제로 열림', opened, opened ? '.ai-tab 마운트 확인' : '.ai-tab 을 찾지 못함(막다른 상태)')
    if (!opened) throw new Error('AI 패널을 열지 못해 이후 시나리오를 진행할 수 없음')

    const created = await evaluate(shellA, `(async () => {
      const t = await window.browserAPI.tabs.create(${JSON.stringify(windowIdA)}, ${JSON.stringify(pageSrv.url)}, { background: false })
      return t ? t.id : null
    })()`)
    check('SETUP-2', '조작 대상 http 탭 생성', !!created, created ? `tabId=${created}` : '탭 생성 실패')
    await sleep(800)

    await ensureAgentReady(shellA)
    check('SETUP-3', '에이전트 입력창이 활성화됨(제공자 연결 + 활성 탭 인식)', true, '.ai-send 활성')

    // ═══════════════════════════════════ UI1 ═══════════════════════════════════
    try {
      await ensureExecMode(shellA, '일반')
      await runAgentTaskViaUi(shellA, 'U1', '페이지를 계속 살펴보세요')
      const c1 = await waitCard(shellA, 'U1', (c) => c.badge.includes('실행 중'), { timeoutMs: 15_000 })
      check('UI1', '작업 실행 시 카드가 나타나고 "실행 중" 으로 보임', true, `배지="${c1.badge}"`)

      const e0 = (await evaluate(shellA, cardExpr('U1'))).elapsed
      await sleep(2600)
      const e1 = (await evaluate(shellA, cardExpr('U1')))?.elapsed ?? ''
      const secOf = (s) => { const m = /(\d+)\s*초/.exec(s || ''); return m ? Number(m[1]) : (/분/.test(s || '') ? 60 : -1) }
      const increased = secOf(e1) >= secOf(e0) && (e1 !== e0)
      check('UI1b', '경과 시간이 실제로 증가함(2회 샘플링)', increased, `${e0} → ${e1}`)
    } catch (e) { fail('UI1', '작업 생성·표시', e.message) }
    finally { await cleanupCard(shellA, 'U1') }

    // ═══════════════════════════════════ UI2 ═══════════════════════════════════
    try {
      const before = await evaluate(shellA, `!!document.querySelector('.ai-exec-warn')`)
      await ensureExecMode(shellA, '장시간')
      const long = await pollExpr(shellA, `(() => {
        const w = document.querySelector('.ai-exec-warn')
        const n = document.querySelectorAll('.ai-exec-long input').length
        return { text: w ? w.textContent : null, inputs: n }
      })()`, (v) => !!v.text, { timeoutMs: 8_000, label: '장시간 옵션 펼침' })
      const okText = /브라우저를\s*켜\s*둔\s*동안\s*최대\s*\d+\s*시간\s*계속\s*시도합니다/.test(long.text || '')
      check('UI2', '"장시간" 칩 선택 시 승인 문구+입력이 실제로 펼쳐짐(빈 칩 아님)',
        !before && okText && long.inputs === 3,
        `이전상태=${before} 문구="${long.text}" 입력수=${long.inputs}`)
      await ensureExecMode(shellA, '일반')
      const after = await pollExpr(shellA, `!document.querySelector('.ai-exec-warn')`, (v) => v === true, { timeoutMs: 5_000, label: '일반 복귀' }).catch(() => false)
      check('UI2b', '"일반" 으로 되돌리면 승인 문구가 다시 사라짐', after === true, `사라짐=${after}`)
    } catch (e) { fail('UI2', '실행 방식 선택 UI', e.message) }

    // ═══════════════════════════════════ UI3 (일시정지·재개) ═══════════════════
    try {
      await ensureExecMode(shellA, '일반')
      await runAgentTaskViaUi(shellA, 'U3', '계속 진행하세요')
      await waitCard(shellA, 'U3', (c) => c.badge.includes('실행 중'), { timeoutMs: 15_000 })
      const r1 = await clickCardButton(shellA, 'U3', '일시정지')
      const paused = await waitCard(shellA, 'U3', (c) => c.badge.includes('일시정지'), { timeoutMs: 10_000 })
      check('UI3', '⏸ 버튼(DOM 클릭)으로 일시정지 상태로 바뀜', r1 === 'clicked' && paused.badge.includes('일시정지'),
        `클릭결과=${r1} 배지="${paused.badge}"`)

      const r2 = await clickCardButton(shellA, 'U3', '재개')
      const running = await waitCard(shellA, 'U3', (c) => c.badge.includes('실행 중'), { timeoutMs: 10_000 })
      check('UI3b', '▶ 재개 클릭으로 다시 실행 중이 됨', r2 === 'clicked' && running.badge.includes('실행 중'),
        `클릭결과=${r2} 배지="${running.badge}"`)
    } catch (e) { fail('UI3', '일시정지·재개', e.message) }
    finally { await cleanupCard(shellA, 'U3') }

    // ═══════════════════════════════════ UI4 (중단) ═══════════════════════════
    try {
      await runAgentTaskViaUi(shellA, 'U4', '계속 진행하세요')
      await waitCard(shellA, 'U4', (c) => c.badge.includes('실행 중'), { timeoutMs: 15_000 })
      const r = await clickCardButton(shellA, 'U4', '중단')
      // 중단된(terminal) 카드는 인라인 진행 목록에서 빠지고 "📌 작업" 전체 목록에만 남는다(의도된 동작).
      await openTaskList(shellA)
      const cancelled = await waitCard(shellA, 'U4', (c) => c.badge.includes('중단됨'), { timeoutMs: 10_000 })
      check('UI4', '⏹ 버튼 클릭으로 중단 상태로 바뀜(전체 작업 목록에서 확인)', r === 'clicked' && cancelled.badge.includes('중단됨'),
        `클릭결과=${r} 배지="${cancelled.badge}"`)
      await closeTaskList(shellA)
    } catch (e) { fail('UI4', '중단', e.message) }
    finally { await cleanupCard(shellA, 'U4') }

    // ═══════════════════════════════════ UI5 (미완료·interrupted) ═════════════
    try {
      await ensureExecMode(shellA, '장시간')
      await pollExpr(shellA, `document.querySelectorAll('.ai-exec-long input').length`, (v) => v === 3, { timeoutMs: 5_000, label: '장시간 입력 3개' })
      // 단계 입력(2번째)을 아주 작게 — onChange 가 최소 10으로 clamp 하므로 그 값이 예산이 된다
      // (SEGMENT_STEPS=12 보다 작아 첫 구간에서 곧바로 소진 → interrupted).
      await evaluate(shellA, `(() => {
        const inputs = document.querySelectorAll('.ai-exec-long input')
        const el = inputs[1]
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, '1')
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      })()`)
      await sleep(300)
      const stepsVal = await evaluate(shellA, `document.querySelectorAll('.ai-exec-long input')[1]?.value`)
      check('UI5-setup', '단계 입력이 최소값(10)으로 clamp 되어 반영됨', stepsVal === '10', `입력값="${stepsVal}"`)

      await runAgentTaskViaUi(shellA, 'U5', '계속 진행하세요(절대 끝내지 마세요)')
      const interrupted = await waitCard(shellA, 'U5', (c) => c.badge.includes('미완료'), { timeoutMs: 30_000 })
      const hasResumeBtn = interrupted.buttons.some((b) => b.includes('이어가기'))
      const notFalselyDone = !interrupted.badge.replace(/\s/g, '').includes('✅완료')
      check('UI5', '단계 예산 소진 시 "미완료" 로 정직하게 표시 + "이어가기" 버튼', notFalselyDone && hasResumeBtn,
        `배지="${interrupted.badge}" 안내="${interrupted.note}" 이어가기버튼=${hasResumeBtn}`)

      // ── 음성 대조: 같은 판정 함수가 결함(완료로 오인 표시)을 실제로 잡는지 ──
      const realOk = judgeInterruptedHonest(interrupted.badge, interrupted.note)
      const brokenBadge = judgeInterruptedHonest('✅ 완료', interrupted.note)
      const brokenNote = judgeInterruptedHonest(interrupted.badge, '작업이 완료되었습니다.')
      check('UI5-neg', '판정 함수가 실제 결함(거짓 완료 배지·부정 없는 안내문)을 잡아냄',
        realOk === true && brokenBadge === false && brokenNote === false,
        `실제=${realOk} 배지위조시=${brokenBadge} 안내위조시=${brokenNote}`)
    } catch (e) { fail('UI5', '미완료(interrupted) 표시', e.message) }
    finally { await cleanupCard(shellA, 'U5') }

    // ═══════════════════════════════════ UI6 (확인 필요·needs-verify) ═════════
    try {
      await ensureExecMode(shellA, '일반')
      await runAgentTaskViaUi(shellA, 'U6', '그냥 완료라고만 답하세요(근거 없이)')
      const nv = await waitCard(shellA, 'U6', (c) => c.note.includes('완료를 확인해 주세요'), { timeoutMs: 15_000 })
      const hasAccept = nv.buttons.some((b) => b.includes('결과 승인'))
      check('UI6', '근거 없는 done 은 "확인해 주세요" + 승인 버튼으로 표시(자동 완료 승격 아님)',
        hasAccept, `안내="${nv.note}" 버튼=${JSON.stringify(nv.buttons)}`)

      const r = await clickCardButton(shellA, 'U6', '완료를 확인하고 승인')
      // completed 카드도 인라인 진행 목록에서 빠진다 — "📌 작업" 전체 목록에서 확인.
      await openTaskList(shellA)
      const done = await waitCard(shellA, 'U6', (c) => c.badge.includes('완료') && !c.badge.includes('미완료'), { timeoutMs: 10_000 })
      check('UI6b', '✅ 결과 승인 클릭 시 실제로 완료로 바뀜(전체 작업 목록에서 확인)', r === 'clicked' && done.badge.includes('완료'),
        `클릭결과=${r} 배지="${done.badge}"`)
      await closeTaskList(shellA)
    } catch (e) { fail('UI6', 'needs-verify 승인 흐름', e.message) }
    finally { await cleanupCard(shellA, 'U6') }

    // ═══════════════════════════════════ UI7 (닫았다 열기) ════════════════════
    try {
      await runAgentTaskViaUi(shellA, 'U7', '계속 진행하세요')
      const before = await waitCard(shellA, 'U7', (c) => c.badge.includes('실행 중'), { timeoutMs: 15_000 })
      const idBefore = await taskIdByMarker(shellA, 'U7')

      const closed = await clickSelector(shellA, '.sidepanel-close')
      const isClosed = await pollExpr(shellA, `!document.querySelector('.ai-tab')`, (v) => v === true, { timeoutMs: 8_000, label: '패널 닫힘' })
      check('UI7-close', '패널 닫기 버튼(×)으로 실제로 닫힘', closed && isClosed, `클릭=${closed} 닫힘확인=${isClosed}`)

      const reopened = await openAiPanel(shellA, windowIdA)
      await ensureAgentReady(shellA)
      const after = await waitCard(shellA, 'U7', (c) => !!c.badge, { timeoutMs: 15_000 })
      const idAfter = await taskIdByMarker(shellA, 'U7')
      check('UI7', '닫았다 다시 열어도 진행 중이던 작업 카드가 그대로 보임(같은 작업)',
        reopened && !!after && idAfter === idBefore,
        `재오픈=${reopened} 이전배지="${before.badge}" 이후배지="${after?.badge}" id동일=${idAfter === idBefore}`)
    } catch (e) { fail('UI7', '사이드바 닫았다 열기', e.message) }
    finally { await cleanupCard(shellA, 'U7') }

    // ═══════════════════════════════════ UI8 (허용 사이트) ════════════════════
    try {
      await ensureExecMode(shellA, '일반')
      const advBefore = await evaluate(shellA, `!!document.querySelector('.ai-exec-hosts')`)
      if (!advBefore) {
        await clickSelector(shellA, '.ai-adv-toggle')
        await pollExpr(shellA, `!!document.querySelector('.ai-exec-hosts')`, (v) => v === true, { timeoutMs: 5_000, label: '고급 옵션 펼침' })
      }
      const set = await setFieldValue(shellA, '.ai-exec-hosts textarea', 'example.com\nshop.example.com')
      check('UI8-setup', '허용 사이트 입력란이 존재하고 값을 받음', typeof set === 'string' && set.includes('example.com'), `값="${set}"`)

      await runAgentTaskViaUi(shellA, 'U8', '완료라고 답하세요')
      const id = await pollExpr(shellA, `(async () => {
        const list = await window.browserAPI.ai.ptaskList()
        const t = list.find(x => (x.instruction || '').includes('[TU-U8]'))
        return t ? t.id : null
      })()`, (v) => !!v, { timeoutMs: 10_000, label: 'U8 작업 id' })
      const full = await evaluate(shellA, `window.browserAPI.ai.ptaskGet(${JSON.stringify(id)})`)
      const hosts = full?.budget?.allowedHosts ?? []
      const ok = hosts.includes('example.com') && hosts.includes('shop.example.com')
      check('UI8', '입력창의 허용 사이트가 그 작업의 budget.allowedHosts 에 실제로 반영됨',
        ok, `hosts=${JSON.stringify(hosts)}`)
    } catch (e) { fail('UI8', '허용 사이트 입력 반영', e.message) }
    finally { await cleanupCard(shellA, 'U8') }

    // ═══════════════════════════════════ UI9 (소유 창 아닌 곳에서 조작) ═══════
    try {
      await runAgentTaskViaUi(shellA, 'U9', '계속 진행하세요')
      await waitCard(shellA, 'U9', (c) => c.badge.includes('실행 중'), { timeoutMs: 15_000 })

      const beforeTargets = (await getTargetList(args.port)).filter(isShellTarget).length
      await evaluate(shellA, `window.browserAPI.actions.run('action.window.new')`)
      const deadline = Date.now() + 15_000
      let targetB = null
      while (Date.now() < deadline && !targetB) {
        const list = (await getTargetList(args.port)).filter(isShellTarget)
        if (list.length > beforeTargets) {
          targetB = list.find((t) => {
            const wid = new URL(t.url).searchParams.get('windowId')
            return wid && wid !== windowIdA
          }) ?? null
        }
        if (!targetB) await sleep(400)
      }
      if (!targetB) throw new Error('두 번째 창 CDP 타깃을 찾지 못함')
      const windowIdB = new URL(targetB.url).searchParams.get('windowId')
      shellB = await connectSession(targetB, 'chrome-shell-B')
      await ensureSessionReady(shellB)

      const openedB = await openAiPanel(shellB, windowIdB)
      if (!openedB) throw new Error('두 번째 창에서 AI 패널을 열지 못함')
      await switchMode(shellB, '에이전트')

      const seenInB = await waitCard(shellB, 'U9', (c) => c.badge.includes('실행 중'), { timeoutMs: 15_000 })
      check('UI9-setup', '다른 창에서도 같은 작업 카드가 전역 목록에 보임', seenInB.badge.includes('실행 중'), `배지="${seenInB.badge}"`)

      const clickResult = await clickCardButton(shellB, 'U9', '일시정지')
      const note = await pollExpr(shellB, `(document.querySelector('.ai-handoff-note')?.textContent || '')`,
        (v) => /이 작업을 시작한 창에서만 조작할 수 있습니다/.test(v), { timeoutMs: 8_000, label: '소유권 오류 안내' }).catch((e) => e.message)
      const stillRunningB = await evaluate(shellB, cardExpr('U9'))
      const stillRunningA = await evaluate(shellA, cardExpr('U9'))
      const denied = typeof note === 'string' && /이 작업을 시작한 창에서만 조작할 수 있습니다/.test(note)
      check('UI9', '소유하지 않은 창에서 조작하면 이유가 화면(.ai-handoff-note)에 보이고 상태가 안 바뀜',
        clickResult === 'clicked' && denied && stillRunningB.badge.includes('실행 중') && stillRunningA.badge.includes('실행 중'),
        `클릭=${clickResult} 안내="${note}" B배지="${stillRunningB?.badge}" A배지="${stillRunningA?.badge}"`)
    } catch (e) { fail('UI9', '소유 창 밖 조작 오류 노출', e.message) }
    finally { await cleanupCard(shellA, 'U9') }
  } finally {
    try { shellB?.close() } catch { /* ignore */ }
    try { shellA?.close() } catch { /* ignore */ }
    try { child?.kill() } catch { /* ignore */ }
    await sleep(1000)
    try { await llm.close() } catch { /* ignore */ }
    try { await pageSrv.close() } catch { /* ignore */ }
  }

  const pass = results.filter((r) => r.status === 'PASS').length
  const fails = results.filter((r) => r.status === 'FAIL').length
  const gaps = results.filter((r) => r.status === 'GAP').length
  fs.writeFileSync(path.join(args.out, 'task-ui-results.json'),
    JSON.stringify({ at: new Date().toISOString(), pass, fail: fails, gap: gaps, results }, null, 2))
  console.log(`\n영속 작업 UI: ${pass} PASS · ${fails} FAIL · ${gaps} GAP`)
  process.exit(fails > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
