#!/usr/bin/env node
// verify-task-runtime-cdp.mjs — 영속 작업 런타임(app/main/features/ai/task-runtime.ts) 검증
//
// 합격 기준은 `.auto-dev/verification.md` A 섹션 **T1~T15** 다. 이 하네스는 그 표의 각 행에
// 1:1 로 대응하는 시나리오를 돌리고, 실패도 그대로 기록한다(기준을 바꾸지 않는다).
//
// 왜 이렇게 만드나
//   ① **모델은 가짜로 고정한다.** 실제 구독 모델로 검증하면 모델이 없으면 못 돌고, 같은 입력에도
//      답이 달라져 실패가 재현되지 않는다 — 상설 게이트로 남길 수 없다. `lib/fake-llm.mjs` 의
//      각본 서버를 쓰고 앱의 `ai.ollamaUrl` 을 거기로 돌린다(verify-agent-loop 와 같은 방식).
//   ② **각본은 index 가 아니라 "작업 표식" 으로 라우팅한다.** 이 하네스는 여러 작업이 겹쳐 돌고
//      (T7·T8 은 동시에 살아 있어야 한다) 재시작까지 하므로, 요청 순번으로 각본을 고르면 뒤엉킨다.
//      작업 지시문에 `[TR-<id>]` 표식을 박고 시스템 프롬프트의 **첫 표식**으로 핸들러를 찾는다
//      (창 단위 세션 맥락 때문에 이전 작업의 표식이 뒤에 붙을 수 있어 "첫" 이어야 한다).
//   ③ **부작용은 서버 카운터로 센다.** "그 뒤로 아무 일도 없었다" 가 계약의 핵심인데, 페이지 안의
//      변수로 세면 강제종료·재시작(T7·T8)에서 증거가 지워진다. fixture 서버가 클릭·발행·결제를 센다.
//
// 규격에서 **의도적으로 벗어난 지점**은 `.auto-dev/design.md` "구현 중 확정된 규격 변경" 에 적혀 있고,
// 이 하네스는 그것을 기대값으로 삼는다(결함으로 오판하지 않는다):
//   - createTask 는 `queued` → `ptaskStart` 를 따로 불러야 `running`
//   - pauseTask 는 `running`/`retrying` 에서만
//   - login·tab-gone 은 `waiting-user`(user-fix) → **`ptaskConfirm(id, true)`** 로 이어간다(resume 아님)
//   - elapsedMs 는 `running` 동안만 누적
//   - 완료 근거에서 `done.shot`(스크린샷)은 인정하지 않는다
//
// 사용: node build/verify-task-runtime-cdp.mjs [--port <n>] [--out <dir>] [--keep-profile]

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectSession, waitForPortFree, connectShellSessionReady,
} from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'
import { startTaskRuntimeServer } from './task-runtime-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')
const ASAR = path.join(REPO, 'dist', 'win-unpacked', 'resources', 'app.asar')

const args = { port: 9268, out: path.join(REPO, 'verify-out', 'task-runtime'), keepProfile: false, negative: false }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--keep-profile') args.keepProfile = true
  // 음성 대조 — 결함을 **재현해서** T3·T5 판정이 실제로 잡아내는지 확인한다.
  // 검출력 없는 검사는 검사가 아니다. 결과는 별도 파일로 쓴다(게이트 결과를 덮지 않는다).
  else if (process.argv[i] === '--negative-control') args.negative = true
}

const results = []
const notes = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const J = JSON.stringify

function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}
function gap(id, name, detail) {
  results.push({ id, name, status: 'GAP', detail })
  console.log(`  ⚠ ${id} GAP — ${detail}`)
}
function note(text) {
  notes.push(text)
  console.log(`  ℹ ${text}`)
}

const DAY_MS = 24 * 60 * 60_000

// ===== 각본 라우터 =====
// 표식(marker) → 핸들러. 핸들러는 (ctx, i) 를 받아 그 작업의 i 번째 모델 호출에 답한다.
const handlers = new Map()
const callCounts = new Map()
function onTask(marker, fn) { handlers.set(marker, fn); callCounts.set(marker, 0) }
function callsOf(marker) { return callCounts.get(marker) ?? 0 }
const router = {
  reply: (ctx) => {
    const sys = String(ctx.messages?.[0]?.content ?? '')
    // **첫** 표식이 지금 실행 중인 작업이다(뒤쪽에는 창 세션 맥락에 남은 이전 작업 표식이 올 수 있다).
    const m = /\[TR-([A-Za-z0-9]+)\]/.exec(sys)
    const key = m ? m[1] : 'NONE'
    const i = callCounts.get(key) ?? 0
    callCounts.set(key, i + 1)
    const fn = handlers.get(key)
    if (!fn) return J({ action: 'done', message: `핸들러 없음(${key})` })
    try { return fn(ctx, i) } catch (err) { return J({ action: 'done', message: `핸들러 오류: ${err.message}` }) }
  },
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRST'.split('')
/** 라벨로 ref 를 찾아 클릭. 못 찾으면 스크롤(관찰 실패를 조용한 done 으로 감추지 않는다). */
function clickLabel(ctx, label, missed) {
  const ref = ctx.refFor(label)
  if (ref === null || ref === undefined) {
    missed.push({ label, obs: String(ctx.lastUser).replace(/\s+/g, ' ').slice(0, 300) })
    return J({ action: 'scroll', direction: 'down' })
  }
  return J({ action: 'click', ref })
}
const SCROLL = J({ action: 'scroll', direction: 'down' })

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE} — 팀장이 패키징해야 한다`)
  fs.mkdirSync(args.out, { recursive: true })

  // ===== 신선도 대조 (이 저장소에서 "빌드보다 이른 결과" 를 성공으로 오인한 사고가 있었다) =====
  const asarMtime = fs.statSync(ASAR).mtimeMs
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version
  const srcMtimes = ['app/main/features/ai/task-runtime.ts', 'app/main/features/ai/agent.ts', 'app/main/ipc/ai.ts', 'app/preload/chrome.ts']
    .map((p) => ({ p, t: (() => { try { return fs.statSync(path.join(REPO, p)).mtimeMs } catch { return 0 } })() }))
  const newestSrc = srcMtimes.reduce((a, b) => (b.t > a.t ? b : a), { p: '(없음)', t: 0 })
  const runStartedAt = Date.now()
  console.log(`[신선도] app.asar=${new Date(asarMtime).toISOString()} · 최신 소스=${newestSrc.p} ${new Date(newestSrc.t).toISOString()} · package.json=${pkgVersion}`)
  if (asarMtime < newestSrc.t) {
    console.warn('[신선도] ⚠ 패키지가 소스보다 오래됐다 — 낡은 바이너리를 검사하고 있을 수 있다')
  }

  args.port = await preferFreePort(args.port, 'verify-task-runtime-cdp.mjs')
  await waitForPortFree(args.port)
  // 우리가 여는 서버 포트는 OS 에게 받아 쓴다(고정 포트는 앞선 실행의 잔재와 충돌한다).
  // deadPort 는 **연결이 거부되는** 포트가 필요해서 받아 놓고 아무도 듣지 않게 둔다(T11 네트워크 분기).
  const [llmPort, pagePort, deadPort] = await getFreePorts(3)

  const llm = await startFakeLlm({ port: llmPort, script: [router] })
  const srv = await startTaskRuntimeServer(pagePort)
  const deadUrl = `http://127.0.0.1:${deadPort}`

  const profileDir = path.join(args.out, 'profile')
  if (!args.keepProfile) fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const tasksFile = path.join(profileDir, 'ai-tasks.json')
  fs.writeFileSync(path.join(profileDir, 'settings.json'), J({
    setup: { completed: true },
    // 강제 종료 뒤 재부팅하므로 '지난 세션 복원' 네이티브 모달이 창 생성을 막는다(임무 23 에서 규명).
    // last-session 이면 묻지 않고 자동 복원한다.
    startup: { mode: 'last-session', urls: [] },
    adblock: { enabled: false },
    ai: {
      enabled: true,
      provider: 'ollama',
      ollamaUrl: llm.url,
      // 도구 허용목록에 없는 이름 → 네이티브 tool-use 대신 JSON 액션 경로(결정론적).
      ollamaModel: 'test-model',
      agentMaxSteps: 6,          // ptask 는 stepBudget 을 직접 주므로 무관. 반복 작업(T10)에만 쓰인다.
      agentVision: 'off',
      agentHumanInput: false,    // 검증에서는 빠른 합성 입력으로 충분하다
      agentInputMode: 'fast',
      agentAutoApprove: false,
      agentCollapsePanels: false,
    },
  }, null, 2))

  let child = null
  let shell = null
  const missed = []   // 관찰에서 라벨을 못 찾은 기록(조용한 실패 방지)

  // ── 앱 기동/종료 ────────────────────────────────────────────────────────
  async function boot(label) {
    const logStream = fs.createWriteStream(path.join(args.out, `app-${label}.log`))
    child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(logStream); child.stderr.pipe(logStream)
    shell = await connectShellSessionReady(args.port)
    await sleep(1500)
    // 이벤트 수집기 — 재부팅마다 다시 심는다.
    await evalIn(shell, `
      window.__T = { ev: [], changed: [], repeat: [] };
      window.browserAPI.ai.onPtaskEvent((e) => { window.__T.ev.push(e) });
      window.browserAPI.ai.onPtaskChanged((l) => { window.__T.changed.push({ at: Date.now(), list: l }) });
      window.browserAPI.ai.onRepeatEvent((e) => { window.__T.repeat.push(e) });
      true`)
    return evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
  }

  async function gracefulQuit() {
    const exited = new Promise((r) => { child.once('exit', r) })
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {}); b.close()
    } catch { /* ignore */ }
    await Promise.race([exited, sleep(15000)])
    try { shell?.close() } catch { /* ignore */ }
    try { child?.kill() } catch { /* ignore */ }
    await waitForPortFree(args.port).catch(() => {})
    await sleep(1200)
  }

  /** 진짜 비정상 종료 — before-quit 이 돌지 않는다(트리째 강제 종료). */
  async function hardKill() {
    const exited = new Promise((r) => { child.once('exit', r) })
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 15000 }) } catch { /* ignore */ }
    await Promise.race([exited, sleep(8000)])
    try { shell?.close() } catch { /* ignore */ }
    await waitForPortFree(args.port).catch(() => {})
    await sleep(1500)
  }

  // ── CDP 평가 ────────────────────────────────────────────────────────────
  async function evalIn(s, expression, awaitPromise = false, timeoutMs = 30000) {
    const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, timeoutMs)
    if (r.exceptionDetails) throw new Error(`평가 예외: ${r.exceptionDetails.text ?? ''} ${r.exceptionDetails.exception?.description ?? ''}`)
    return r.result?.result?.value ?? r.result?.value
  }
  /** 프로미스를 JSON 으로 받아 온다(undefined → null). */
  async function jval(expression, timeoutMs = 30000) {
    const text = await evalIn(shell,
      `Promise.resolve(${expression}).then(v => JSON.stringify(v === undefined ? null : v))`, true, timeoutMs)
    return JSON.parse(text ?? 'null')
  }
  const api = (expr, timeoutMs) => jval(`window.browserAPI.ai.${expr}`, timeoutMs)

  // ── 작업 조작 헬퍼 ──────────────────────────────────────────────────────
  const createTask = (o) => api(`ptaskCreate(${J(o)})`)
  const getTask = (id) => api(`ptaskGet(${J(id)})`)
  const listTasks = () => api('ptaskList()')
  const startTask = (id) => api(`ptaskStart(${J(id)})`)
  const pauseTask = (id) => api(`ptaskPause(${J(id)})`)
  const resumeTask = (id) => api(`ptaskResume(${J(id)})`)
  const cancelTask = (id) => api(`ptaskCancel(${J(id)})`)
  const acceptTask = (id) => api(`ptaskAccept(${J(id)})`)
  const confirmTask = (id, approved) => api(`ptaskConfirm(${J(id)}, ${!!approved})`)
  const answerTask = (id, text) => api(`ptaskAnswer(${J(id)}, ${J(text)})`)
  const taskEvents = async (id) => {
    const all = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__T.ev)') ?? '[]')
    return all.filter((e) => e.taskId === id)
  }
  const setSetting = (k, v) => jval(`window.browserAPI.settings.set(${J(k)}, ${J(v)})`)
  const newTab = (windowId, url) => jval(`window.browserAPI.tabs.create(${J(windowId)}, ${J(url)})`)
  const listTabs = (windowId) => jval(`window.browserAPI.tabs.list(${J(windowId)})`)
  const closeTab = (id) => jval(`window.browserAPI.tabs.close(${J(id)})`)

  /** 조건이 참이 될 때까지 작업 상태를 폴링한다. 실패 시 마지막 상태를 그대로 돌려준다. */
  async function waitTask(id, pred, timeoutMs = 30000, intervalMs = 350) {
    const dl = Date.now() + timeoutMs
    let last = null
    while (Date.now() < dl) {
      last = await getTask(id)
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
  const stateOf = (t) => (t ? t.state : '(없음)')

  /** 작업을 만들고 시작까지 — 규격대로 create 는 queued 이므로 start 를 따로 부른다. */
  async function launch({ marker, tabId, extra = '', budget, mode, readOnly }) {
    const instruction = `[TR-${marker}] ${extra || '검증용 작업'}`
    const summary = await createTask({
      instruction, tabId,
      ...(mode ? { mode } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      ...(budget ? { budget } : {}),
    })
    if (!summary) throw new Error(`작업 생성 실패(${marker})`)
    const r = await startTask(summary.id)
    if (!r?.ok) throw new Error(`작업 시작 실패(${marker}): ${r?.error}`)
    return summary.id
  }

  // ===== 시나리오 =====
  let windowId = null
  let t9TabGoneReason = null   // T11 의 '탭 닫힘' 분기 상호 참조용
  let t7 = null; let t8 = null; let t10Job = null; let t15 = null
  let countsBeforeKill = null

  try {
    // ════════════════ 1차 부팅 ════════════════
    windowId = await boot('boot1')

    // 실행한 바이너리가 정말 새 빌드인지 — 런타임 버전으로 확인한다.
    const upd = await jval('window.browserAPI.update.status()').catch(() => null)
    const runtimeVersion = upd?.current ?? '(알 수 없음)'
    note(`실행 바이너리 버전=${runtimeVersion} (package.json=${pkgVersion}) · app.asar ${new Date(asarMtime).toISOString()}`)
    if (runtimeVersion !== pkgVersion) {
      note(`⚠ 런타임 버전과 package.json 이 다르다 — 낡은 패키지일 수 있다`)
    }

    const mainTab = (await newTab(windowId, `${srv.base}/?tag=main`)).id
    await sleep(2000)
    await srv.reset()

    if (args.negative) {
      // ══════════ 음성 대조 — 검사에 검출력이 있는지 확인한다 ══════════
      // 판정식을 뒤집는 것만으로는 부족하다(값이 undefined 여도 뒤집힌 식이 실패할 수 있다).
      // 그래서 **결함의 관찰값을 실제로 재현**하고, 그때 T3·T5 의 판정이 실패하는지 본다.
      // 이 모드에서 PASS 는 "그 결함을 검사가 잡았다" 는 뜻이다.

      // NC-T3: 옛 결함("단계 소진을 done 으로 보고")의 관찰값 재현 — 모델이 done 을 내면
      // 작업은 needs-verify/completed 로 끝난다. T3 은 interrupted + '단계 예산' 을 요구하므로
      // 반드시 실패해야 한다.
      {
        onTask('NC3', () => J({ action: 'done', message: '다 했습니다(단계 소진을 완료로 보고)' }))
        const id = await launch({ marker: 'NC3', tabId: mainTab, extra: '끝없이 스크롤해라', budget: { maxSteps: 4 } })
        const end = await waitTask(id, (t) => t.state !== 'running' && t.state !== 'queued', 60000)
        const t = end.task
        // ↓ T3 과 **같은** 판정식
        const t3Verdict = t?.state === 'interrupted' && /단계 예산/.test(String(t.waitReason ?? ''))
          && t.result === undefined
        check('NC-T3', '[음성 대조] 단계 소진이 완료로 보고되는 상황을 만들면 T3 판정이 실패한다',
          !t3Verdict,
          `재현한 상태=${stateOf(t)} result="${String(t?.result ?? '')}" · T3 판정=${t3Verdict ? 'PASS(← 검출력 없음, 검사가 잘못됐다)' : 'FAIL(정상 — 결함을 잡았다)'}`)
        await cancelTask(id)
      }

      // NC-T5: "일시정지가 다음 행동을 막지 못한다" 를 재현 — 일시정지를 **부르지 않고** 같은
      // 창(정지 후 5.8초)을 관찰한다. T5 는 그 창에서 클릭이 늘지 않을 것을 요구하므로 실패해야 한다.
      {
        const tab = (await newTab(windowId, `${srv.base}/?tag=nc5`)).id
        await sleep(1800)
        onTask('NC5', (ctx, i) => clickLabel(ctx, `동작${LETTERS[i % LETTERS.length]}`, missed))
        const id = await launch({ marker: 'NC5', tabId: tab, extra: '버튼들을 차례로 눌러라', budget: { maxSteps: 60 } })
        const base = (await srv.counts()).hits
        const moved = await waitUntil(async () => (await srv.counts()).hits >= base + 2, 40000)
        await sleep(1800)
        const h1 = (await srv.counts()).hits
        await sleep(4000)
        const h2 = (await srv.counts()).hits
        const st = await getTask(id)
        // ↓ T5 의 핵심 판정식(부작용 0)
        const t5Verdict = h2 === h1
        check('NC-T5', '[음성 대조] 일시정지를 걸지 않으면(= 정지가 동작을 막지 못하는 상황) T5 판정이 실패한다',
          !t5Verdict,
          `클릭 진행=${moved} · 일시정지 호출 없음 · 클릭 ${h1}→${h2}(늘어야 정상) · 상태=${stateOf(st)}`
          + ` · T5 판정=${t5Verdict ? 'PASS(← 검출력 없음)' : 'FAIL(정상 — 결함을 잡았다)'}`)
        await cancelTask(id)
      }
    } else {

    // ---- T1: 작업 생성·상태·파일 ----
    {
      const before = (await listTasks()).length
      const empty = await createTask({ instruction: '   ', tabId: mainTab })
      const afterEmpty = (await listTasks()).length

      onTask('T1', () => SCROLL)   // 끝나지 않는 작업 → running 을 관찰할 수 있다
      const id = await launch({ marker: 'T1', tabId: mainTab, extra: '이 페이지를 계속 살펴봐라' })
      const run = await waitTask(id, (t) => t.state === 'running', 20000)

      // 저장 시각을 고정 대기로 잡지 말 것 — json-store 의 디바운스(400ms)는 **새 변경마다 리셋**되고
      // 실행 중에는 usage·체크포인트 변경이 계속 들어오므로, 첫 쓰기가 상한(MAX_SAVE_DELAY_MS=2초)
      // 까지 밀린다. 1.3초 고정 대기로 읽으면 "파일에 안 남았다" 는 거짓 실패가 난다(실측).
      let saved = null
      let firstSeenMs = -1
      const fileStart = Date.now()
      while (Date.now() - fileStart < 8000) {
        try {
          const f = JSON.parse(fs.readFileSync(tasksFile, 'utf8'))
          saved = (f?.tasks ?? []).find((t) => t.id === id) ?? null
        } catch { saved = null }
        if (saved) { firstSeenMs = Date.now() - fileStart; break }
        await sleep(250)
      }
      const listed = (await listTasks()).find((t) => t.id === id)
      const cpOk = !!saved && !!saved.checkpoint
        && typeof saved.checkpoint.segment === 'number'
        && typeof saved.checkpoint.stepsUsed === 'number'
        && typeof saved.checkpoint.progressSummary === 'string'

      check('T1', '지시를 넣으면 목록에 뜨고 running · 파일에 원 지시·상태·체크포인트가 남는다 (빈 지시는 거부)',
        empty === null && afterEmpty === before
        && !!listed && run.ok && !!saved && saved.instruction.includes('[TR-T1]') && typeof saved.state === 'string' && cpOk,
        `빈 지시 거부=${empty === null}(목록 ${before}→${afterEmpty}) · 목록 등재=${!!listed} · 상태=${stateOf(run.task)}`
        + ` · 파일 저장=${!!saved}(${firstSeenMs}ms 만에 관찰) 지시보존=${!!saved && saved.instruction.includes('[TR-T1]')} 상태=${saved?.state} 체크포인트=${cpOk}`)
      await cancelTask(id)
    }

    // ---- T4: 완료 검증 — 증거 없는 done 은 needs-verify ----
    {
      onTask('T4', () => J({ action: 'done', message: '다 했습니다' }))
      const id = await launch({ marker: 'T4', tabId: mainTab, extra: '아무것도 하지 말고 끝났다고만 해라' })
      const nv = await waitTask(id, (t) => t.state === 'needs-verify' || t.state === 'completed', 40000)
      const beforeAccept = nv.task
      let accepted = null
      if (beforeAccept?.state === 'needs-verify') {
        await acceptTask(id)
        accepted = (await waitTask(id, (t) => t.state === 'completed', 10000)).task
      }
      check('T4', '증거 없는 done 은 needs-verify 로 남고 사용자 승인 뒤에만 completed',
        beforeAccept?.state === 'needs-verify' && !beforeAccept.verifyEvidence
        && accepted?.state === 'completed' && !!accepted.verifyEvidence,
        `승인 전 상태=${stateOf(beforeAccept)}(needs-verify 여야) 근거=${beforeAccept?.verifyEvidence ?? '(없음)'}`
        + ` · 안내="${String(beforeAccept?.waitReason ?? '').slice(0, 40)}"`
        + ` · 승인 후 상태=${stateOf(accepted)} 근거="${accepted?.verifyEvidence ?? '(없음)'}"`)
    }

    // ---- T3: 단계 소진 ≠ 성공 ----
    {
      const runsBefore = await api('runList()')
      onTask('T3', () => SCROLL)
      const id = await launch({
        marker: 'T3', tabId: mainTab, extra: '끝없이 스크롤해라',
        budget: { maxSteps: 4 },
      })
      const done = await waitTask(id, (t) => t.state !== 'running' && t.state !== 'queued', 60000)
      const t = done.task
      const runsAfter = await api('runList()')
      const newRuns = (runsAfter ?? []).filter((r) => !(runsBefore ?? []).some((b) => b.id === r.id))
      const successRuns = newRuns.filter((r) => r.status === 'done')

      check('T3', '단계를 다 쓰면 completed 가 아니라 interrupted(이어가기 가능) · 이력에 성공으로 안 남는다',
        t?.state === 'interrupted' && /단계 예산/.test(String(t.waitReason ?? ''))
        && t.result === undefined && successRuns.length === 0,
        `상태=${stateOf(t)}(interrupted 여야) · 사유="${String(t?.waitReason ?? '').slice(0, 60)}"`
        + ` · 결과필드=${t?.result === undefined ? '없음' : '있음(있으면 안 됨)'} · 단계=${t?.checkpoint?.stepsUsed}/${t?.budget?.maxSteps}`
        + ` · 새 실행이력 ${newRuns.length}건 중 성공(✅) ${successRuns.length}건`)
      if (newRuns.length === 0) {
        note('T3 참고: ptask 구간은 실행 이력(runList)에 기록되지 않는다(recordAgentEvent 는 agentStart IPC 경로에서만 호출). 그래서 "✅ 로 안 보인다" 는 구조적으로 충족된다 — 작업 상태(interrupted)가 주된 근거다.')
      }
    }

    // ---- T2: 구간 분할 + 압축 진행요약 + 완료 하위작업 누적 ----
    {
      // 6단계 주기: 이동(제목이 바뀐다) → 노트(그 제목으로 하위작업 1건) → 스크롤 4회.
      // **노트를 매 단계 찍으면 안 된다.** 완료 하위작업 보관 상한은 20건이고(설계: 넘치면 최신을
      // 남긴다) 12단계 구간에서 6건씩 쌓으면 구간 4개째에 상한에 닿아 **오래된 항목이 정당하게**
      // 잘린다 — 그러면 "앞 구간 것이 남아 있는가" 라는 질문 자체가 성립하지 않는다(1차 실행에서
      // 이 설계 상한을 결함으로 오판해 FAIL 이 났다). 구간당 2건이면 상한 아래에서 검사할 수 있다.
      onTask('T2', (ctx, i) => {
        const p = Math.floor(i / 6) + 1
        const k = i % 6
        if (k === 0) return J({ action: 'navigate', url: `${srv.base}/?p=${p}` })
        if (k === 1) return J({ action: 'note', text: `p=${p} 페이지 요약` })
        return SCROLL
      })
      const id = await launch({
        marker: 'T2', tabId: mainTab, extra: '여러 페이지를 돌며 요약을 모아라',
        budget: { maxSteps: 80 },
      })
      // 구간 경계마다 체크포인트를 스냅샷으로 모은다. 폴링은 촘촘히 — 메인 프로세스가 바쁘면
      // 왕복이 길어져 구간 두어 개를 건너뛴 채로 보게 된다(1차 실행에서 구간 2와 5만 잡혔다).
      const snaps = new Map()
      const dl = Date.now() + 150_000
      let last = null
      while (Date.now() < dl) {
        last = await getTask(id)
        if (!last) break
        const seg = last.checkpoint.segment
        if (seg > 0 && !snaps.has(seg)) snaps.set(seg, JSON.parse(J(last.checkpoint)))
        if (seg >= 3) break
        if (last.state !== 'running') break
        await sleep(200)
      }
      const segs = [...snaps.keys()].sort((a, b) => a - b)
      const first = snaps.get(segs[0])
      const latest = snaps.get(segs[segs.length - 1])
      const summariesOk = segs.every((s) => String(snaps.get(s).progressSummary || '').length > 0)
      const keptAll = !!first && !!latest
        && first.doneSubtasks.every((x) => latest.doneSubtasks.includes(x))
      // 보관 상한(20건)에 닿으면 오래된 항목이 **설계대로** 잘리므로 "앞 구간 것이 남았는가" 를
      // 물을 수 없게 된다 — 그 상태로 통과/실패를 내면 둘 다 거짓이다. 닿았으면 크게 실패시킨다.
      const capped = (latest?.doneSubtasks.length ?? 0) >= 20
      // 압축 요약이 실제로 다음 구간 프롬프트에 주입됐는지 — 모델이 받은 원문에서 확인한다.
      const resumeInjected = llm.requests.some((q) => {
        const sys = String(q.messages?.[0]?.content ?? '')
        return sys.includes('[TR-T2]') && sys.includes('지금까지 진행')
      })
      check('T2', '단계 예산 80 작업이 구간 여러 개로 쪼개지고, 구간마다 압축 진행요약 저장 · 앞 구간 완료 하위작업이 사라지지 않는다',
        segs.length >= 2 && summariesOk && keptAll && !!first && first.doneSubtasks.length > 0 && resumeInjected && !capped,
        `관찰된 구간=${segs.join(',')} · 단계 ${latest?.stepsUsed}/80 · 요약 전 구간 비어있지 않음=${summariesOk}`
        + ` · 하위작업 ${first?.doneSubtasks.length ?? 0}개 → ${latest?.doneSubtasks.length ?? 0}개(앞 구간 전부 보존=${keptAll}`
        + `${capped ? ', 보관 상한 20건에 닿아 검사 무효 — 노트 빈도를 낮춰야 한다' : ''})`
        + ` · 다음 구간 프롬프트에 진행요약 주입=${resumeInjected}`
        + ` · 요약 예="${String(latest?.progressSummary ?? '').slice(0, 70)}"`)
      note(`T2 참고: 예산 80단계 전부를 태우지 않고 구간 ${segs.length}개(약 ${latest?.stepsUsed ?? 0}단계)를 관찰한 뒤 중단했다 — 구간 분할·요약·누적 계약을 보는 데 필요한 만큼만 돌렸다.`)
      await cancelTask(id)
      await sleep(800)
    }

    // ---- T5: pause/resume — 일시정지 중 페이지가 바뀌지 않는다 ----
    {
      const tab = (await newTab(windowId, `${srv.base}/?tag=t5`)).id
      await sleep(1800)
      onTask('T5', (ctx, i) => clickLabel(ctx, `동작${LETTERS[i % LETTERS.length]}`, missed))
      const id = await launch({ marker: 'T5', tabId: tab, extra: '버튼들을 차례로 눌러라', budget: { maxSteps: 40 } })

      const base = (await srv.counts()).hits
      const moved = await waitUntil(async () => (await srv.counts()).hits >= base + 2, 40000)
      const stepsBefore = Math.max(0, ...(await taskEvents(id)).filter((e) => e.type === 'observe').map((e) => Number(e.step) || 0))

      await pauseTask(id)
      const paused = await waitTask(id, (t) => t.state === 'paused', 15000)
      // 일시정지 요청 직전에 이미 나간 동작 하나는 도착할 수 있다 — 관문 이후를 본다.
      await sleep(1800)
      const h1 = (await srv.counts()).hits
      await sleep(4000)
      const h2 = (await srv.counts()).hits

      await resumeTask(id)
      const resumed = await waitUntil(async () => (await srv.counts()).hits > h2, 25000)
      const stepsAfter = Math.max(0, ...(await taskEvents(id)).filter((e) => e.type === 'observe').map((e) => Number(e.step) || 0))

      check('T5', '일시정지하면 상태 paused + 다음 동작이 안 나간다(부작용 0) · 재개하면 중단 지점부터 잇는다',
        moved && paused.ok && h2 === h1 && resumed && stepsAfter > stepsBefore,
        `클릭 진행=${moved} · 상태=${stateOf(paused.task)} · 정지 후 클릭 ${h1}→${h2}(같아야) · 재개 후 클릭 증가=${resumed}`
        + ` · 단계 번호 ${stepsBefore}→${stepsAfter}(이어져야, 1 로 되돌아가면 실패)`)
      await cancelTask(id)
      await sleep(600)
    }

    // ---- T6: cancel 부작용 0 + 늦은 done 이 상태를 뒤집지 않는다 ----
    {
      const tab = (await newTab(windowId, `${srv.base}/?tag=t6`)).id
      await sleep(1800)
      // 클릭 두 번 뒤에는 done 을 낸다 — 취소 뒤 늦게 도착할 수 있는 완료 보고를 일부러 만든다.
      onTask('T6', (ctx, i) => (i < 2 ? clickLabel(ctx, `동작${LETTERS[i]}`, missed) : J({ action: 'done', message: '늦은 완료 보고' })))
      const id = await launch({ marker: 'T6', tabId: tab, extra: '버튼을 누르고 끝내라', budget: { maxSteps: 30 } })

      const base = (await srv.counts()).hits
      const moved = await waitUntil(async () => (await srv.counts()).hits >= base + 1, 40000)
      // 취소 **직전** 상태를 남긴다 — 이게 없으면 뒤에 남은 result 가 "취소 뒤에 쓰인 것"(결함)인지
      // "취소 전에 이미 구간이 done 으로 끝난 것"(정상)인지 구분할 수 없다(2차 실행에서 실제로 헷갈렸다).
      const stateBeforeCancel = stateOf(await getTask(id))
      await cancelTask(id)
      const cancelled = await waitTask(id, (t) => t.state === 'cancelled', 15000)
      await sleep(1800)
      const h1 = (await srv.counts()).hits
      await sleep(4000)
      const h2 = (await srv.counts()).hits
      const finalTask = await getTask(id)
      const evs = await taskEvents(id)
      const lateDone = evs.some((e) => e.type === 'done')
      // 판정 기준 변경 이력 (2026-09-18, 팀장):
      //   이 검사는 원래 "취소 시점에 running 이었는데 `result` 가 **존재하면** 결함" 이었다.
      //   그 기준으로 최신 빌드에서 FAIL 이 났고, 들여다보니 **제품에 진짜 문제가 있었다** —
      //   구간의 done 과 사용자의 중단이 거의 동시에 오면 result 에 모델의 완료 보고("늦은 완료 보고")가
      //   남아, 화면에 "중단됨" 과 "완료했습니다" 가 같이 보였다. 상태는 cancelled 로 맞았지만 읽는 사람은
      //   성공으로 오해한다.
      //   제품은 그 자리에서 result 를 **중단이 결론임을 앞세운 문장**으로 바꾸도록 고쳤다(정보는 괄호로 보존).
      //   그래서 "result 가 존재하면 결함" 은 더 이상 옳은 기준이 아니다(중단된 작업은 중단 사유를 말해야 한다).
      //   바뀐 기준: **result 가 중단을 결론으로 말하지 않으면 결함.** 즉 성공처럼 읽히면 실패로 잡는다.
      //   (검증 매트릭스 T6 의 계약 자체 — "부작용 0" 과 "늦은 done 이 상태를 뒤집지 않는다" — 는 그대로다.)
      const resultText = String(finalTask?.result ?? '')
      const saysCancelled = /중단|취소/.test(resultText)
      const readsAsSuccess = resultText.length > 0 && !saysCancelled
      const lateWrote = stateBeforeCancel === 'running' && readsAsSuccess

      check('T6', '중단 후 페이지 조작이 더 일어나지 않고, 늦게 온 done 이 상태·결과 문구를 성공으로 뒤집지 않는다',
        moved && cancelled.ok && h2 === h1 && finalTask?.state === 'cancelled' && !lateWrote,
        `클릭 진행=${moved} · 취소 직전 상태=${stateBeforeCancel} · 취소 상태=${stateOf(cancelled.task)} · 취소 후 클릭 ${h1}→${h2}(같아야)`
        + ` · 5.8초 뒤 상태=${stateOf(finalTask)}(cancelled 유지 — completed/needs-verify 로 뒤집히면 실패)`
        + ` · 늦은 done 이벤트 도착=${lateDone} · result 필드=${resultText === '' ? '없음' : `"${resultText.slice(0, 40)}"`}`
        + ` · 중단을 결론으로 말함=${saysCancelled} · 성공처럼 읽힘=${readsAsSuccess}(false 여야)`)
    }

    // ---- T12: 무진척 루프 — 같은 동작 반복이면 사용자에게 묻는다 ----
    {
      const tab = (await newTab(windowId, `${srv.base}/?tag=t12`)).id
      await sleep(1800)
      onTask('T12', (ctx, i) => (i < 3 ? clickLabel(ctx, '동작A', missed) : J({ action: 'done', message: '사용자 지시대로 종료' })))
      const id = await launch({ marker: 'T12', tabId: tab, extra: '동작A 를 계속 눌러라', budget: { maxSteps: 40 } })

      const base = (await srv.counts()).hits
      const asked = await waitTask(id, (t) => t.state === 'waiting-user', 60000)
      const hitsAtAsk = (await srv.counts()).hits - base
      const reason = String(asked.task?.waitReason ?? '')

      // 답을 주면 이어간다(억제만 보지 않는 양성 대조).
      await answerTask(id, '그만하고 끝내라')
      const after = await waitTask(id, (t) => t.state === 'needs-verify' || t.state === 'completed' || t.state === 'interrupted', 40000)

      check('T12', '같은 동작이 진척 없이 반복되면 감지해 사용자에게 묻는다(100번 반복하지 않는다) · 답하면 이어간다',
        asked.ok && /반복/.test(reason) && hitsAtAsk <= 6
        && (after.task?.state === 'needs-verify' || after.task?.state === 'completed'),
        `질문 상태=${stateOf(asked.task)} · 사유="${reason.slice(0, 70)}" · 질문 시점까지 클릭 ${hitsAtAsk}회(6 이하여야)`
        + ` · 답변 후 상태=${stateOf(after.task)}`)
    }

    // ---- T13: 중복 외부쓰기 — 발행 완료가 불확실하면 자동 재실행하지 않는다 ----
    {
      const tab = (await newTab(windowId, `${srv.base}/publish`)).id
      await sleep(1800)
      // 첫 단계에 발행을 누르고, 그 뒤로는 스크롤만 — 구간이 소진되며 "발행했지만 완료 미확인" 으로 끝난다.
      onTask('T13', (ctx, i) => (i === 0 ? clickLabel(ctx, '발행', missed) : SCROLL))
      const id = await launch({
        marker: 'T13', tabId: tab, extra: '글을 발행해라',
        budget: { maxSteps: 20 },   // 12단계 구간이 끝나도 단계 예산은 남아 있어야 원장 검사에 닿는다
      })
      const waiting = await waitTask(id, (t) => t.state === 'waiting-user' || t.state === 'interrupted' || t.state === 'completed', 120000)
      const pub1 = (await srv.counts()).publish
      const reason = String(waiting.task?.waitReason ?? '')
      await sleep(4000)
      const pub2 = (await srv.counts()).publish

      // 사용자가 "확인했고 계속" → 이어가되 발행을 다시 누르지 않는다.
      await confirmTask(id, true)
      const resumed = await waitTask(id, (t) => t.state === 'running' || t.state === 'interrupted', 20000)
      await sleep(5000)
      const pub3 = (await srv.counts()).publish
      const ledger = (await getTask(id))?.externalWrites ?? []

      check('T13', '발행 완료가 불확실하면 자동 재실행하지 않고 확인을 구한다(발행은 정확히 1회) · "한 번" 을 거짓 보장하지 않는다',
        waiting.task?.state === 'waiting-user' && /발행/.test(reason) && pub1 === 1 && pub2 === 1 && pub3 === 1,
        `상태=${stateOf(waiting.task)}(waiting-user 여야) · 안내="${reason.slice(0, 80)}"`
        + ` · 발행 호출 ${pub1}회 → 4초 후 ${pub2}회 → 확인 후 이어가기 ${pub3}회 (모두 1 이어야)`
        + ` · 원장 ${ledger.length}건(확정=${ledger.filter((w) => w.confirmed).length}) · 확인 후 상태=${stateOf(resumed.task)}`)
      await cancelTask(id)
      await sleep(600)
    }

    // ---- T14: 예산 한도 — 허용 사이트 / 모델 호출 ----
    {
      // (a) 허용 사이트 밖 이동은 거부되고 이유가 보인다.
      const tab = (await newTab(windowId, `${srv.base}/?tag=t14`)).id
      await sleep(1800)
      onTask('T14a', (ctx, i) => (i === 0
        ? J({ action: 'navigate', url: srv.offScopeUrl })
        : J({ action: 'done', message: '이동 시도 끝' })))
      const idA = await launch({
        marker: 'T14a', tabId: tab, extra: '허용 밖 사이트로 이동해 봐라',
        budget: { allowedHosts: ['127.0.0.1'], maxSteps: 6 },
      })
      const endA = await waitTask(idA, (t) => t.state !== 'running' && t.state !== 'queued', 60000)
      const evsA = await taskEvents(idA)
      const refused = evsA.filter((e) => e.type === 'result' && e.ok === false
        && /허용된 사이트가 아닙니다/.test(String(e.detail ?? '')))
      const tabsNow = await listTabs(windowId)
      const tabUrl = String((tabsNow ?? []).find((t) => t.id === tab)?.url ?? '')
      const stayed = tabUrl.includes('127.0.0.1') && !tabUrl.includes('off-scope')

      // (b) 모델 호출 예산.
      const tabB = (await newTab(windowId, `${srv.base}/?tag=t14b`)).id
      await sleep(1800)
      onTask('T14b', () => SCROLL)
      const idB = await launch({
        marker: 'T14b', tabId: tabB, extra: '끝없이 스크롤해라',
        budget: { maxSteps: 40, maxLlmCalls: 3 },
      })
      const endB = await waitTask(idB, (t) => t.state !== 'running' && t.state !== 'queued', 120000)
      const tB = endB.task
      const callBudgetHit = tB?.state === 'interrupted' && /모델 호출 예산/.test(String(tB.waitReason ?? ''))

      check('T14', '허용 사이트 밖 이동은 거부되고 이유가 보인다 · 모델 호출 한도를 넘으면 멈추고 이유를 보인다',
        refused.length >= 1 && stayed && callBudgetHit,
        `(a) 이동 거부 ${refused.length}건 "${String(refused[0]?.detail ?? '').slice(0, 50)}" · 탭 URL="${tabUrl.slice(0, 48)}"(허용 호스트 유지=${stayed}) · 상태=${stateOf(endA.task)}`
        + ` · (b) 상태=${stateOf(tB)} 사유="${String(tB?.waitReason ?? '').slice(0, 60)}" 호출 ${tB?.usage?.llmCalls}/${tB?.budget?.maxLlmCalls}`
        + ` · 시간 예산은 T15(가상시계)에서 확인`)
      if (callBudgetHit) {
        note(`T14 참고: 호출 예산 검사는 **구간 경계에서만** 돈다 — 예산 3회에 실제 ${tB?.usage?.llmCalls}회를 쓴 뒤 멈췄다(한 구간 12단계는 끝까지 간다). 멈춤·사유는 계약대로지만 초과분이 생긴다.`)
      }
      await cancelTask(idB)
      await sleep(600)
    }

    // ---- T9: 탭 재바인딩 (전용 워크스페이스에서) ----
    {
      const wsState = await jval('window.browserAPI.workspace.state()')
      const originWs = wsState.activeId
      // 부정 사례를 **빈 검사로 만들지 않기 위해**: 원래 워크스페이스에 같은 URL 의 http 탭이
      // 실제로 남아 있는지 먼저 센다. 그게 0이면 "다른 워크스페이스로 안 넘어간다" 는 말이 공허하다.
      const otherWsHttpTabs = (await listTabs(windowId) ?? []).filter((t) => /^https?:/.test(t.url)).length

      const ws = await jval(`window.browserAPI.workspace.create({ name: "작업런타임-T9" })`)
      await jval(`window.browserAPI.workspace.activate(${J(ws.id)})`)
      await sleep(1500)
      const tabA = (await newTab(windowId, `${srv.base}/?tag=t9`)).id
      await sleep(2000)

      onTask('T9', (ctx, i) => clickLabel(ctx, `동작${LETTERS[i % LETTERS.length]}`, missed))
      const id = await launch({ marker: 'T9', tabId: tabA, extra: '버튼을 차례로 눌러라', budget: { maxSteps: 40 } })
      const base0 = (await srv.counts()).hits
      await waitUntil(async () => (await srv.counts()).hits > base0, 40000)
      await pauseTask(id)
      await waitTask(id, (t) => t.state === 'paused', 15000)

      // 작업하던 탭을 닫는다 → 이 워크스페이스에 쓸 수 있는 http 탭이 없다.
      await closeTab(tabA)
      await sleep(1200)
      await resumeTask(id)
      const askTab = await waitTask(id, (t) => t.state === 'waiting-user', 40000)
      t9TabGoneReason = String(askTab.task?.waitReason ?? '')
      const hitsWhileGone = (await srv.counts()).hits
      await sleep(3000)
      const hitsGone2 = (await srv.counts()).hits

      // 같은 URL 의 새 탭을 열고 "조치했으니 계속" → 옛 탭 id 가 아니라 URL 로 다시 찾아야 한다.
      const tabB = (await newTab(windowId, `${srv.base}/?tag=t9`)).id
      await sleep(2000)
      await confirmTask(id, true)
      const rebound = await waitUntil(async () => (await srv.counts()).hits > hitsGone2, 40000)
      const after = await getTask(id)

      check('T9', '복원 시 옛 탭 id 를 쓰지 않고 같은 워크스페이스의 같은 URL 탭을 찾거나 사용자에게 묻는다(다른 워크스페이스 탭으로 넘어가지 않는다)',
        askTab.ok && /탭/.test(t9TabGoneReason) && hitsGone2 === hitsWhileGone
        && otherWsHttpTabs >= 1 && tabB !== tabA && rebound,
        `탭 닫은 뒤 상태=${stateOf(askTab.task)} 사유="${t9TabGoneReason.slice(0, 60)}"`
        + ` · 그 사이 클릭 ${hitsWhileGone}→${hitsGone2}(늘면 남의 탭을 조작한 것)`
        + ` · 원래 워크스페이스의 http 탭 ${otherWsHttpTabs}개가 살아 있었는데도 그쪽으로 안 넘어갔다(부정 사례 유효)`
        + ` · 새 탭(${tabB}) 으로 재바인딩되어 클릭 재개=${rebound} · 최종 상태=${stateOf(after)}`)
      await cancelTask(id)
      await jval(`window.browserAPI.workspace.activate(${J(originWs)})`)
      await sleep(1500)
    }

    // ---- T11: 원인별 재시도 ----
    {
      const tab = (await newTab(windowId, `${srv.base}/?tag=t11`)).id
      await sleep(1800)
      const sub = []

      // (a) 네트워크 — 죽은 포트로 돌려 실제 연결 실패를 만든다. backoff 재시도 뒤 **실제로 이어져야** 한다.
      await setSetting('ai.ollamaUrl', deadUrl)
      onTask('T11a', () => J({ action: 'done', message: '연결 회복 후 완료' }))
      const idA = await launch({ marker: 'T11a', tabId: tab, extra: '아무거나 하고 끝내라' })
      const retryA = await waitTask(idA, (t) => t.state === 'retrying' && !!t.retry, 40000)
      const kindA = retryA.task?.retry?.kind
      await setSetting('ai.ollamaUrl', llm.url)   // 복구 → 예정된 재시도가 성공해야 한다
      const recovered = await waitTask(idA, (t) => t.state === 'needs-verify' || t.state === 'completed', 40000)
      sub.push(`network: 상태=${stateOf(retryA.task)} kind=${kindA} 회차=${retryA.task?.retry?.attempt} → 복구 후 ${stateOf(recovered.task)}`)
      const okA = kindA === 'network' && (recovered.task?.state === 'needs-verify' || recovered.task?.state === 'completed')

      // (b) 429 — 긴 backoff 로 물러난다(즉시 두드리지 않는다).
      await setSetting('ai.ollamaUrl', srv.llmUrl(429))
      onTask('T11b', () => SCROLL)
      const idB = await launch({ marker: 'T11b', tabId: tab, extra: '한도 초과 시험' })
      const retryB = await waitTask(idB, (t) => t.state === 'retrying' && !!t.retry, 40000)
      const kindB = retryB.task?.retry?.kind
      const waitSecB = Math.round(((retryB.task?.retry?.nextAt ?? 0) - Date.now()) / 1000)
      sub.push(`rate-limit: kind=${kindB} 다음 재시도 ${waitSecB}초 후`)
      const okB = kindB === 'rate-limit' && waitSecB >= 30
      await cancelTask(idB)

      // (c) 401 — 사람만 풀 수 있다 → 재시도하지 않고 기다린다.
      await setSetting('ai.ollamaUrl', srv.llmUrl(401))
      onTask('T11c', () => SCROLL)
      const idC = await launch({ marker: 'T11c', tabId: tab, extra: '인증 실패 시험' })
      const waitC = await waitTask(idC, (t) => t.state === 'waiting-user', 40000)
      const reasonC = String(waitC.task?.waitReason ?? '')
      sub.push(`login: 상태=${stateOf(waitC.task)} 사유="${reasonC.slice(0, 40)}" 재시도필드=${waitC.task?.retry ? '있음' : '없음'}`)
      const okC = waitC.task?.state === 'waiting-user' && !waitC.task.retry && /인증|로그인/.test(reasonC)
      await cancelTask(idC)

      // (d) 분류되지 않은 오류 — 상한(1회)까지만 재시도하고 상태를 보존한 채 멈춘다.
      await setSetting('ai.ollamaUrl', srv.llmUrl(418))
      onTask('T11d', () => SCROLL)
      const idD = await launch({ marker: 'T11d', tabId: tab, extra: '알 수 없는 오류 시험' })
      const capD = await waitTask(idD, (t) => t.state === 'interrupted', 90000)
      const reasonD = String(capD.task?.waitReason ?? '')
      sub.push(`재시도 상한: 상태=${stateOf(capD.task)} 사유="${reasonD.slice(0, 48)}"`)
      const okD = capD.task?.state === 'interrupted' && /재시도/.test(reasonD)
      await setSetting('ai.ollamaUrl', llm.url)

      // (e) 탭 닫힘 — T9 에서 관찰한 분기를 그대로 인용한다(같은 대기 계열, 재시도 없음).
      const okE = /탭/.test(t9TabGoneReason)
      sub.push(`tab-gone(T9 관찰): "${t9TabGoneReason.slice(0, 40)}"`)

      check('T11', '원인별로 다른 대응(backoff 재시도 / 긴 대기 / 사용자 대기)으로 분기하고, 상한에 도달하면 상태를 보존한 채 멈춘다',
        okA && okB && okC && okD && okE,
        sub.join(' · '))
      note('T11 참고: 네트워크 분기는 죽은 포트(연결 거부)로, 429·401·분류불가는 fixture 서버의 상태코드 주입 엔드포인트로 만들었다. 실제 사이트 로그인 만료는 문구가 다를 수 있어 여기서 검증한 것은 제공자 인증 실패 경로다.')
    }

    // ---- T10 준비: 반복 작업 ----
    {
      const tab = (await newTab(windowId, `${srv.base}/?tag=t10`)).id
      await sleep(1800)
      // 반복 작업은 페이지를 건드리지 않게 둔다 — 다른 시나리오의 클릭 카운터와 섞이면
      // "재시작 후 저절로 실행되지 않았다" 를 셀 수 없다. 실행 여부는 doneCount·lastResult 로 본다.
      onTask('T10', (ctx, i) => (i === 0 ? J({ action: 'note', text: '반복 회차 기록' }) : J({ action: 'done', message: '반복 회차 완료' })))
      const started = await jval(`window.browserAPI.ai.repeatStart(${J({
        task: '[TR-T10] 이 페이지를 확인하고 기록만 해라', windowId, tabId: tab,
        intervalMinutes: 1, count: 2, autoConfirm: false,
      })})`)
      t10Job = started?.job ?? null
      if (t10Job) {
        const ran = await waitUntil(async () => {
          const l = await api('repeatList()')
          const j = (l ?? []).find((x) => x.id === t10Job.id)
          return (j?.doneCount ?? 0) >= 1
        }, 60000)
        const l = await api('repeatList()')
        t10Job = (l ?? []).find((x) => x.id === t10Job.id) ?? t10Job
        note(`T10 준비: 반복 작업 첫 회차 실행=${ran} · doneCount=${t10Job.doneCount} status=${t10Job.status} lastResult="${String(t10Job.lastResult ?? '').slice(0, 40)}"`)
      } else {
        note('T10 준비 실패: repeatStart 가 작업을 만들지 못했다')
      }
    }

    // ---- T7 준비: 실행 중인 작업 ----
    {
      const tab = (await newTab(windowId, `${srv.base}/?tag=t7`)).id
      await sleep(1800)
      onTask('T7', (ctx, i) => clickLabel(ctx, `동작${LETTERS[i % LETTERS.length]}`, missed))
      const id = await launch({ marker: 'T7', tabId: tab, extra: '버튼을 차례로 눌러라', budget: { maxSteps: 200 } })
      const base = (await srv.counts()).hits
      const moved = await waitUntil(async () => (await srv.counts()).hits > base, 40000)
      t7 = { id, moved }
    }

    // ---- T8 준비: 확인 대기(민감 동작) 중인 작업 ----
    {
      const tab = (await newTab(windowId, `${srv.base}/pay`)).id
      await sleep(1800)
      onTask('T8', (ctx) => clickLabel(ctx, '결제하기', missed))
      const id = await launch({ marker: 'T8', tabId: tab, extra: '결제하기를 눌러라', budget: { maxSteps: 40 } })
      const waiting = await waitTask(id, (t) => t.state === 'waiting-user', 60000)
      t8 = { id, waiting: waiting.ok, reason: String(waiting.task?.waitReason ?? '') }
    }

    countsBeforeKill = await srv.counts()
    note(`강제종료 직전 카운터: ${J(countsBeforeKill)} · T7 실행중=${t7?.moved} · T8 확인대기=${t8?.waiting}`)
    await sleep(1200)   // 저장 디바운스가 디스크에 닿도록
    await hardKill()

    // ════════════════ 2차 부팅 (강제종료 복원) ════════════════
    windowId = await boot('boot2')
    await sleep(2500)   // 세션 복원(탭 재로드)을 기다린다

    // ---- T7: 강제종료 복원 ----
    {
      const all = await listTasks()
      const t = (all ?? []).find((x) => x.instruction.includes('[TR-T7]'))
      const full = t ? await getTask(t.id) : null
      const afterBoot = await srv.counts()
      await sleep(5000)
      const later = await srv.counts()
      const noAuto = later.hits === afterBoot.hits

      let resumedOk = false; let resumedState = '(미시도)'; let bound7 = '(미시도)'
      if (full && full.state === 'interrupted') {
        await resumeTask(full.id)
        resumedOk = await waitUntil(async () => (await srv.counts()).hits > later.hits, 40000)
        const afterTask = await getTask(full.id)
        resumedState = stateOf(afterTask)
        // 어느 페이지에서 이어갔는지 드러낸다 — 내 페이지들은 버튼 구성이 같아서, 원래 탭이 아니라
        // 다른 탭에 재바인딩돼도 "클릭이 늘었다" 는 똑같이 참이 된다(이 검사의 한계를 숨기지 않는다).
        bound7 = String(afterTask?.checkpoint?.tabUrl ?? '').replace(srv.base, '')
        await cancelTask(full.id)
      }
      check('T7', 'taskkill 후 재시작하면 실행 중이던 작업이 interrupted 로 복원되고, 자동으로 되살아나 페이지를 조작하지 않는다(명시 재개로 이어진다)',
        !!full && full.state === 'interrupted' && /재시작/.test(String(full.waitReason ?? ''))
        && noAuto && resumedOk,
        `복원 상태=${stateOf(full)}(interrupted 여야) 사유="${String(full?.waitReason ?? '').slice(0, 50)}"`
        + ` · 부팅 후 5초간 클릭 ${afterBoot.hits}→${later.hits}(같아야 = 자동 부활 없음)`
        + ` · 단계 ${full?.checkpoint?.stepsUsed} 보존 · 명시 재개로 클릭 재개=${resumedOk}(상태 ${resumedState}, 이어간 페이지=${bound7})`)
    }

    // ---- T8: 민감 행동 무자동부활 ----
    {
      const all = await listTasks()
      const t = (all ?? []).find((x) => x.instruction.includes('[TR-T8]'))
      const full = t ? await getTask(t.id) : null
      await sleep(4000)
      const payAfterBoot = (await srv.counts()).pay

      // 재개 전에 **대상 페이지를 깨운다.** 세션 복원은 탭을 지연 로드(잠자는 탭 = about:blank)로
      // 되살리고, 잠자는 탭은 재바인딩 후보에서 빠진다(design.md "알려진 한계"). 1차 실행에서는
      // 그 탓에 작업이 **엉뚱한 활성 탭**으로 재바인딩돼 결제 페이지를 다시 볼 기회조차 없이
      // 40단계 예산을 태웠다(확인을 다시 묻지 않은 진짜 이유). 사용자라면 그 페이지를 열어 둔 채
      // 재개하므로 그 조건을 만들어 주고 양성 대조(다시 묻는가)를 본다.
      const tabsB2 = (await listTabs(windowId)) ?? []
      let payTab = tabsB2.find((x) => String(x.url).includes('/pay'))
      let payTabInfo = payTab ? `복원됨 ${payTab.id}(잠자는탭=${payTab.discarded === true})` : '복원 안 됨'
      if (!payTab) {
        // 결제 페이지 탭이 세션 복원에 없으면 **하네스가 직접 연다.** T8 의 계약은 "재시작만으로
        // 승인되지 않고, 재개하면 다시 묻는다" 이지 세션 복원 충실도가 아니다. 사용자도 결제를
        // 이어가려면 그 페이지를 열어 둔 채 재개한다 — 그 조건을 만들어 주고 양성 대조를 본다.
        // (2차 실행 관찰: 복원 탭 목록에 /pay 가 아예 없어 작업이 무관한 탭으로 재바인딩됐다.)
        payTab = await newTab(windowId, `${srv.base}/pay`)
        payTabInfo += ' → 하네스가 다시 열었다'
        await sleep(2500)
      } else {
        await jval(`window.browserAPI.tabs.activate(${J(payTab.id)})`)
        await sleep(2500)
      }
      const restoredUrls = tabsB2.map((x) => String(x.url).replace(srv.base, '')).join(' ')

      let askedAgain = false; let payAfterResume = payAfterBoot; let resumedState = '(미시도)'
      let boundUrl = '(미시도)'; let finalReason = ''
      if (full && full.state === 'interrupted') {
        await resumeTask(full.id)
        const again = await waitTask(full.id, (x) => x.state === 'waiting-user', 60000)
        askedAgain = again.ok
        resumedState = stateOf(again.task)
        boundUrl = String(again.task?.checkpoint?.tabUrl ?? '(없음)')
        finalReason = String(again.task?.waitReason ?? '')
        payAfterResume = (await srv.counts()).pay
        await cancelTask(full.id)
      }
      check('T8', '확인 대기에서 죽었다 살아나면 자동 승인되지 않는다(재시작만으로 결제·게시가 실행되지 않고, 재개하면 다시 묻는다)',
        !!full && full.state === 'interrupted'
        && countsBeforeKill?.pay === 0 && payAfterBoot === 0 && payAfterResume === 0 && askedAgain,
        `종료 전 상태=waiting-user(${t8?.waiting}) "${String(t8?.reason ?? '').slice(0, 40)}"`
        + ` · 복원 상태=${stateOf(full)}(interrupted 여야 — waiting-user 로 되살리면 재시작이 곧 승인이 된다)`
        + ` · 결제 호출: 종료 전 ${countsBeforeKill?.pay} → 부팅 후 ${payAfterBoot} → 재개 후 ${payAfterResume} (전부 0 이어야)`
        + ` · 재개 시 다시 확인을 요구=${askedAgain}(상태 ${resumedState}, 사유="${finalReason.slice(0, 50)}")`
        + ` · 결제 탭=${payTabInfo} · 재바인딩된 페이지=${boundUrl.replace(srv.base, '')}`
        + ` · 복원된 탭(${tabsB2.length}개): ${restoredUrls.slice(0, 160)}`)
    }

    // ---- T10: 예약·반복 영속 ----
    {
      if (!t10Job) {
        gap('T10', '예약·반복 영속', '1차 부팅에서 반복 작업을 만들지 못해 검증하지 못했다')
      } else {
        const list = await api('repeatList()')
        const j = (list ?? []).find((x) => x.id === t10Job.id)
        const dupes = (list ?? []).filter((x) => x.id === t10Job.id).length
        const evBefore = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__T.repeat)') ?? '[]').length
        await sleep(5000)
        const evAfter = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__T.repeat)') ?? '[]').length
        const list2 = await api('repeatList()')
        const j2 = (list2 ?? []).find((x) => x.id === t10Job.id)
        const noAutoRun = evAfter === evBefore && (j2?.doneCount ?? -1) === (j?.doneCount ?? -2)

        // 명시 재개 → 간격을 존중해 예약된다(연타 금지). 그리고 **실제로 한 번 더 돈다**(양성 대조).
        const resumed = await jval(`window.browserAPI.ai.scheduleResume(${J(t10Job.id)})`)
        // nextAt 이 null 이면 "간격이 이미 지나 즉시 실행" 이다 — 0 으로 취급해 초를 계산하면
        // 음수 수십억 초 같은 헛소리가 찍힌다(1차 실행에서 실제로 그랬다).
        const nextAt = resumed?.nextAt ?? null
        const nextDesc = nextAt
          ? `${Math.round((nextAt - Date.now()) / 1000)}초 뒤로 예약(간격 남아 있어 연타 안 함)`
          : '간격(1분)이 이미 지나 즉시 실행 — 재시작만으로는 안 돌고 명시 재개에서만 돈다'
        const firedAgain = await waitUntil(async () => {
          const l = await api('repeatList()')
          const x = (l ?? []).find((y) => y.id === t10Job.id)
          return (x?.doneCount ?? 0) >= (j?.doneCount ?? 0) + 1
        }, 95000)
        const final = ((await api('repeatList()')) ?? []).find((x) => x.id === t10Job.id)

        check('T10', '반복 작업이 재시작 후에도 목록에 남고, 재시작만으로 저절로 실행되지 않으며(명시 재개), 중복 실행이 생기지 않는다',
          !!j && j.status === 'stopped' && dupes === 1 && (j.doneCount ?? 0) >= 1 && noAutoRun
          && !!resumed && firedAgain && (final?.doneCount ?? 0) <= (final?.totalCount ?? 0),
          `복원 후 status=${j?.status}(stopped 여야) nextAt=${j?.nextAt}(null 이어야) doneCount=${j?.doneCount} 중복항목=${dupes}`
          + ` · 부팅 후 5초간 자동 실행 없음=${noAutoRun}(반복 이벤트 ${evBefore}→${evAfter})`
          + ` · 재개 후: ${nextDesc} · 실제 재실행=${firedAgain}`
          + ` · 최종 doneCount=${final?.doneCount}/${final?.totalCount}(초과 없음)`)
        await jval(`window.browserAPI.ai.repeatStop(${J(t10Job.id)})`)
        await jval(`window.browserAPI.ai.repeatRemove(${J(t10Job.id)})`)
      }
    }

    // ---- T15 준비: 가상시계용 작업을 만들고 정상 종료 후 파일을 조작한다 ----
    {
      const tab = (await newTab(windowId, `${srv.base}/?tag=t15`)).id
      await sleep(2000)
      // navigate 는 매번 다른 URL(느린 페이지)로 — 같은 URL 반복은 막힘 감지에 걸린다.
      onTask('T15', (ctx, i) => (i % 2 === 0
        ? J({ action: 'navigate', url: `${srv.base}/slow?k=${i}` })
        : SCROLL))
      const summary = await createTask({
        instruction: '[TR-T15] 하루 동안 이 사이트를 관찰해라',
        tabId: tab, mode: 'long',
        budget: { maxSteps: 2000, maxDurationMs: DAY_MS, maxLlmCalls: 4000 },
      })
      t15 = summary ? { id: summary.id, tabUrl: `${srv.base}/?tag=t15` } : null
      note(`T15 준비: 작업 생성=${!!t15} (mode=long, 시간 예산 24시간)`)
      await sleep(1200)
    }

    await gracefulQuit()

    // ===== 가상시계: 저장 파일의 누적 실행 시간을 24시간 직전으로 앞당긴다 =====
    // **실제 24시간을 기다리지 않는다.** 앱이 꺼진 동안 파일을 고쳐 "이미 23시간 59분 57초를
    // 썼고 마지막 실행은 하루 전" 인 작업으로 만든 뒤, 재개해 경계를 넘기는 것을 관찰한다.
    let patched = false
    if (t15) {
      try {
        const obj = JSON.parse(fs.readFileSync(tasksFile, 'utf8'))
        const target = (obj.tasks ?? []).find((t) => t.id === t15.id)
        if (target) {
          target.state = 'interrupted'
          target.waitReason = '가상시계 시험 — 이어서 진행할 수 있습니다.'
          target.elapsedMs = DAY_MS - 3000          // 3초만 남긴다
          target.startedAt = Date.now() - DAY_MS
          target.budget.maxDurationMs = DAY_MS
          target.checkpoint.savedAt = Date.now()
          fs.writeFileSync(tasksFile, J(obj))
          patched = true
        }
      } catch (err) {
        note(`T15 파일 조작 실패: ${err.message}`)
      }
    }

    // ════════════════ 3차 부팅 (가상시계 경계) ════════════════
    windowId = await boot('boot3')
    await sleep(2500)

    if (!t15 || !patched) {
      gap('T15', '가상시계 24시간 경계', `준비 실패(작업=${!!t15}, 파일조작=${patched}) — 경계 동작을 시험하지 못했다`)
    } else {
      const restored = await getTask(t15.id)
      const elapsedH = restored ? (restored.elapsedMs / 3_600_000).toFixed(2) : '?'
      const aliveOk = !!restored && restored.state === 'interrupted'
        && restored.elapsedMs >= DAY_MS - 10_000 && restored.budget.maxDurationMs === DAY_MS

      await resumeTask(t15.id)
      const stopped = await waitTask(t15.id, (t) => t.state === 'interrupted' && /시간 예산/.test(String(t.waitReason ?? '')), 150000)
      const fin = stopped.task ?? await getTask(t15.id)
      const grewOk = !!fin && fin.elapsedMs >= DAY_MS

      check('T15', '가상시계로 24시간 경계를 넘겨도 작업이 살아 있고 예산 회계가 맞는다 (실제 24시간 실행이 아님)',
        aliveOk && stopped.ok && grewOk,
        `[가상시계 — 실제 24시간 연속 실행이 아니다. 앱이 꺼진 동안 저장 파일의 누적 실행시간을 24시간-3초로 앞당겼다]`
        + ` · 재시작 후 상태=${stateOf(restored)} 누적=${elapsedH}시간(예산 24시간, 회계 보존=${aliveOk})`
        + ` · 재개 후 상태=${stateOf(fin)} 사유="${String(fin?.waitReason ?? '').slice(0, 60)}"`
        + ` · 최종 누적=${fin ? (fin.elapsedMs / 3_600_000).toFixed(3) : '?'}시간(24 이상이어야 = 계속 누적)`
        + ` · 단계 ${fin?.checkpoint?.stepsUsed} 사용(예산 소진 아님 — 멈춘 이유는 시간이다)`)
    }

    }   // ← if (args.negative) 의 else 끝 (음성 대조 모드가 아닐 때의 T1~T15)

    if (missed.length) {
      note(`관찰에서 라벨을 못 찾은 경우 ${missed.length}건(첫 건: ${missed[0].label}) — 각본이 스크롤로 대체했다. 원문: ${missed[0].obs.slice(0, 200)}`)
    }
  } catch (err) {
    check('FATAL', '하네스 실행', false, `${err.message}`)
    console.error(err)
  } finally {
    try { shell?.close() } catch { /* ignore */ }
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {}); b.close()
    } catch { /* ignore */ }
    await sleep(1500)
    try { child?.kill() } catch { /* ignore */ }
    await llm.close()
    await srv.close()
  }

  // ===== 보고 =====
  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL')
  const gaps = results.filter((r) => r.status === 'GAP')
  const payload = {
    results, pass, fail: fail.length, gap: gaps.length,
    notes,
    freshness: {
      asarMtime: new Date(asarMtime).toISOString(),
      newestSource: { file: newestSrc.p, mtime: new Date(newestSrc.t).toISOString() },
      packageVersion: pkgVersion,
      runStartedAt: new Date(runStartedAt).toISOString(),
      packageNewerThanSource: asarMtime >= newestSrc.t,
    },
  }
  // 음성 대조 결과는 **게이트 결과 파일을 덮지 않는다** — 러너가 읽는 파일은 계약 검증 결과다.
  const outFile = args.negative ? 'task-runtime-negative-control.json' : 'task-runtime-results.json'
  fs.writeFileSync(path.join(args.out, outFile), J(payload, null, 2))

  console.log(`\n===== verify-task-runtime ${args.negative ? '음성 대조' : '결과'} =====`)
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  console.log(`PASS=${pass} FAIL=${fail.length} GAP=${gaps.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  if (gaps.length) {
    console.log('\n----- GAP (실패로 세지 않지만 못 한 것) -----')
    for (const g of gaps) console.log(`GAP ${g.id}: ${g.detail}`)
  }
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
