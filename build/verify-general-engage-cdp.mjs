#!/usr/bin/env node
// verify-general-engage-cdp.mjs — "일반 영속 작업의 댓글·좋아요 중복 방지" e2e 검증.
//
// ── 무엇을 지키는 검사인가 ──────────────────────────────────────────────────
// 사용자가 AI 사이드바에 직접 낸 영속 작업("이 글에 댓글 달아줘")에서, 식별 가능한 댓글 등록·좋아요
// 클릭은 실행 **직전에** 작업 단위 장부(blog-engage.ts, account=`task:<id>`)에 동기로 저장된다.
// 그래서 ① 모델 응답 유실 ② 앱 크래시·재시작 을 넘겨 이어가도 같은 글에 두 번 나가지 않고,
// ③ 대상을 특정할 수 없으면(피드에 제목·링크가 없는 글) 추측해서 누르지 않고 사용자에게 묻는다.
// 판정은 모델이 뭐라고 했는지가 아니라 **로컬 블로그 픽스처의 `/state` 카운터**(댓글·좋아요 실측)로만 한다.
//
// ── 절대 제약 ────────────────────────────────────────────────────────────
// - 외부 인터넷 접속·실제 계정·실제 게시 0건. 대상은 전부 127.0.0.1 로컬 픽스처(social-fixture-server.mjs).
//   작업 생성 시 budget.allowedHosts 를 픽스처 호스트로 좁힌다.
// - 사용자 실제 프로필 무접촉 — 격리 `--user-data-dir` 만 쓴다.
// - 유료 API·크레딧 0원 — 가짜 LLM(lib/fake-llm.mjs)만 쓴다. 실제 모델·CLI 는 부르지 않는다.
// - `dist/win-unpacked` 는 이미 최신 코드로 패키징돼 있다(팀장 조율). 이 파일은 **재빌드/재패키징하지 않는다.**
//
// ── 시나리오 개요 (각각 "전 카운터 → 실행 → 후 카운터" 로 판정) ─────────────
//   GE1  댓글: 응답 유실(모델 호출 오류) 뒤 재시도해도 두 번 달리지 않는다.
//   GE2  댓글: 위와 같되 크래시+재시작을 넘겨도 두 번 달리지 않는다.
//   GE3  좋아요: 응답 유실 뒤에도 취소(토글 원복)되지 않는다.
//   GE4  같은 페이지의 다른 글(f1·f2)에 대한 정당한 행동은 서로 막지 않는다(과차단 방지).
//   GE5  사용자가 명시적으로 요청한 좋아요 취소는 정상 동작한다.
//   GE6  대상을 특정할 수 없으면 묻고 멈춘다 + 실제 화면(UI)으로 답해 복구할 수 있다.
//   GE7  장부 저장 자체가 실패하면 클릭이 나가지 않는다(저장 확정 전에는 하지 않는다).
//   GE8  평범한 읽기·이동은 전혀 간섭하지 않는다 + 발사되지 못한 클릭은 정당한 재시도를 막지 않는다.
//   GE9  댓글이 "등록" 클릭이 아니라 입력칸 Enter(type+submit)로 나가는 경로도 같은 가드를 탄다.
//
// 사용: node build/verify-general-engage-cdp.mjs [--port <n>] [--out <dir>] [--keep-profile] [--only a,b,c]

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectSession, waitForPortFree, connectShellSessionReady,
} from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'
import { startSocialFixtures } from './social-fixture-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')
const ASAR = path.join(REPO, 'dist', 'win-unpacked', 'resources', 'app.asar')

// 문자열 안에 개행 이스케이프(백슬래시-n)를 쓰지 않는다 — 이 저장소에서 여러 층(파이썬 패치 등)을
// 거치며 실제 개행으로 오염돼 파일이 깨진 사고가 세 번 있었다. 필요하면 이 상수를 쓴다.
const NL = String.fromCharCode(10)

const args = {
  port: 9312,
  out: path.join(REPO, 'verify-out', 'general-engage-cdp'),
  keepProfile: false,
  only: new Set(),
}
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--keep-profile') args.keepProfile = true
  else if (process.argv[i] === '--only') {
    for (const s of String(process.argv[++i] ?? '').split(',')) { const t = s.trim(); if (t) args.only.add(t) }
  }
}
function shouldRun(id) { return args.only.size === 0 || args.only.has(id) }
// GE2 는 전체 실행 흐름 안에서만 크래시+재시작을 겪는다 — GE2 가 선택됐는데 다른 것들이 빠져 있어도
// 그 자체로 하나의 완결된 재부팅 사이클을 돌 수 있게 설계돼 있다(아래 main() 참고).

const results = []
const notes = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const J = JSON.stringify

function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}
function skip(id, name, reason) {
  results.push({ id, name, status: 'SKIP', detail: reason })
  console.log(`  ○ ${id} SKIP — ${reason}`)
}
function note(text) { notes.push(text); console.log(`  ℹ ${text}`) }

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE} — 최신 코드로 패키징돼 있어야 한다(재패키징은 이 하네스의 책임이 아니다)`)
  fs.mkdirSync(args.out, { recursive: true })

  // ===== 신선도 대조(결과 해석용 — 재빌드는 하지 않는다) =====
  const asarMtime = fs.statSync(ASAR).mtimeMs
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version
  const srcFiles = [
    'app/main/features/ai/agent.ts', 'app/main/features/ai/task-runtime.ts',
    'app/main/features/ai/blog-engage.ts', 'app/main/features/ai/agent-gate.ts',
    'app/main/features/ai/page-actions.ts', 'app/main/ipc/ai.ts',
    'app/preload/chrome.ts', 'app/renderer/components/AiTab.tsx',
  ]
  const newestSrc = srcFiles
    .map((p) => ({ p, t: (() => { try { return fs.statSync(path.join(REPO, p)).mtimeMs } catch { return 0 } })() }))
    .reduce((a, b) => (b.t > a.t ? b : a), { p: '(없음)', t: 0 })
  console.log(`[신선도] app.asar=${new Date(asarMtime).toISOString()} · 최신 소스=${newestSrc.p} ${new Date(newestSrc.t).toISOString()} · package.json=${pkgVersion}`)
  if (asarMtime < newestSrc.t) {
    console.warn('[신선도] ⚠ 패키지가 소스보다 오래됐다 — 낡은 바이너리를 검사하고 있을 수 있다')
  }

  args.port = await preferFreePort(args.port, 'verify-general-engage-cdp.mjs')
  await waitForPortFree(args.port)
  const [llmPort, deadPort] = await getFreePorts(2)
  void deadPort // (현재 시나리오에서는 안 쓴다 — 자리만 예약해 포트 충돌을 피한다)

  const llm = await startFakeLlm({ port: llmPort, script: [{ reply: () => J({ action: 'scroll', direction: 'down' }) }] })
  const fixture = await startSocialFixtures()

  const profileDir = path.join(args.out, 'profile')
  if (!args.keepProfile) fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const ledgerFile = path.join(profileDir, 'ai-engage-ledger.json')

  fs.writeFileSync(path.join(profileDir, 'settings.json'), J({
    setup: { completed: true, completedAt: Date.now(), version: 'verify-general-engage' },
    // GE2 는 강제 종료 후 재부팅한다 — '지난 세션 복원' 네이티브 모달이 CDP 연결을 막지 않도록
    // last-session 으로 묻지 않고 자동 복원되게 한다(task-runtime-cdp 의 선례).
    startup: { mode: 'last-session', urls: [] },
    adblock: { enabled: false },
    ai: {
      enabled: true,
      provider: 'ollama',
      ollamaUrl: llm.url,
      ollamaModel: 'test-model',   // 도구 허용목록에 없는 이름 → 결정론적 JSON 액션 경로
      agentMaxSteps: 30,
      agentVision: 'off',
      agentHumanInput: false,      // 검증에서는 빠른 합성 입력으로 충분
      agentInputMode: 'fast',
      agentAutoApprove: false,
      agentCollapsePanels: false,
    },
  }, null, 2))

  let child = null
  let shell = null
  let windowId = null

  // ── 앱 기동/종료 ────────────────────────────────────────────────────────
  async function boot(label) {
    const logStream = fs.createWriteStream(path.join(args.out, `app-${label}.log`))
    child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(logStream); child.stderr.pipe(logStream)
    shell = await connectShellSessionReady(args.port)
    await sleep(1500)
    // 이벤트 수집기 — 재부팅마다 다시 심는다(렌더러 상태는 재부팅으로 날아간다).
    await evalIn(shell, `
      window.__GE = { ev: [] };
      window.browserAPI.ai.onPtaskEvent((e) => { window.__GE.ev.push(e) });
      true`)
    windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
    return windowId
  }

  async function gracefulQuit() {
    if (!child) return
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
    await sleep(1000)
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
  async function jval(expression, timeoutMs = 30000) {
    const text = await evalIn(shell,
      `Promise.resolve(${expression}).then(v => JSON.stringify(v === undefined ? null : v))`, true, timeoutMs)
    return JSON.parse(text ?? 'null')
  }
  const api = (expr, timeoutMs) => jval(`window.browserAPI.ai.${expr}`, timeoutMs)

  // ── 작업 조작 헬퍼 ──────────────────────────────────────────────────────
  const createTask = (o) => api(`ptaskCreate(${J(o)})`)
  const getTask = (id) => api(`ptaskGet(${J(id)})`)
  const startTask = (id) => api(`ptaskStart(${J(id)})`)
  const resumeTask = (id) => api(`ptaskResume(${J(id)})`)
  const cancelTask = (id) => api(`ptaskCancel(${J(id)})`)
  const confirmTask = (id, approved) => api(`ptaskConfirm(${J(id)}, ${!!approved})`)
  const answerTask = (id, text) => api(`ptaskAnswer(${J(id)}, ${J(text)})`)
  const ptaskTargets = (id) => api(`ptaskTargets(${J(id)})`)
  const ptaskSetTarget = (id, tabId) => api(`ptaskSetTarget(${J(id)}, ${J(tabId)})`)
  const newTab = (wid, url) => jval(`window.browserAPI.tabs.create(${J(wid)}, ${J(url)})`)
  const stateOf = (t) => (t ? t.state : '(없음)')

  async function taskEvents(id) {
    const all = JSON.parse((await evalIn(shell, 'JSON.stringify(window.__GE ? window.__GE.ev : [])')) ?? '[]')
    return all.filter((e) => e.taskId === id)
  }

  async function waitTask(id, pred, timeoutMs = 40000, intervalMs = 350) {
    const dl = Date.now() + timeoutMs
    let last = null
    while (Date.now() < dl) {
      last = await getTask(id)
      if (last && pred(last)) return { ok: true, task: last }
      await sleep(intervalMs)
    }
    return { ok: false, task: last }
  }
  async function waitUntil(fn, timeoutMs = 40000, intervalMs = 300) {
    const dl = Date.now() + timeoutMs
    while (Date.now() < dl) {
      if (await fn()) return true
      await sleep(intervalMs)
    }
    return false
  }

  /** 작업을 만들고 시작까지 — create 는 queued 이므로 start 를 따로 부른다. */
  async function launch({ marker, tabId, extra, budget, readOnly }) {
    const instruction = `[GE-${marker}] ${extra || '검증용 작업'}`
    const summary = await createTask({
      instruction, tabId,
      budget: { allowedHosts: ['127.0.0.1'], maxSteps: 20, ...(budget || {}) },
      ...(readOnly ? { readOnly: true } : {}),
    })
    if (!summary) throw new Error(`작업 생성 실패(${marker})`)
    const r = await startTask(summary.id)
    if (!r?.ok) throw new Error(`작업 시작 실패(${marker}): ${r?.error}`)
    return summary.id
  }

  /** 진단 스냅샷 — FAIL 시 detail 에 붙인다(다음 사람이 원인을 바로 알 수 있게). */
  async function diagFor(id) {
    const t = await getTask(id).catch(() => null)
    const lastObs = String(llm.requests[llm.requests.length - 1]?.lastUser ?? '').replace(/\s+/g, ' ').slice(0, 220)
    return `state=${stateOf(t)} waitCause=${t?.waitCause ?? '(없음)'} waitReason="${String(t?.waitReason ?? '').slice(0, 100)}"`
      + ` · 마지막관찰="${lastObs}" · state:{comments:${fixture.state.comments.length},likes:${J(fixture.state.likes ?? Object.entries(fixture.state.likesMap))}}`
  }

  // ===== 관찰 텍스트에서 라벨의 N 번째(0-based) 등장을 ref 로 찾는다 =====
  // fake-llm.mjs 의 refFromObservation 은 "첫 매칭"만 준다 — /blog/feed 처럼 같은 라벨(placeholder)이
  // 글마다 반복되는 페이지(f1·f2·f3 의 "댓글을 입력하세요")에서는 몇 번째 글인지 직접 세야 한다.
  function pickRef(text, label, occurrence = 0) {
    const re = /\[(\d+)\]\s+\S+\s+"([^"]*)"/g
    let m; let count = 0
    while ((m = re.exec(text ?? ''))) {
      if (String(m[2]).includes(label)) {
        if (count === occurrence) return Number(m[1])
        count++
      }
    }
    return null
  }
  const clickJson = (ref) => J({ action: 'click', ref })
  const typeJson = (ref, text) => J({ action: 'type', ref, text })
  const typeSubmitJson = (ref, text) => J({ action: 'type', ref, text, submit: true })
  const doneJson = (message) => J({ action: 'done', message })
  const navJson = (url) => J({ action: 'navigate', url })
  const scrollJson = J({ action: 'scroll', direction: 'down' })
  const noteJson = (text) => J({ action: 'note', text })

  /** 라벨을 찾아 클릭/입력 JSON 을 만든다. 못 찾으면 done 으로 실패를 크게 드러낸다(조용한 오작동 방지). */
  function reqClick(text, label, occurrence, missed, tag) {
    const ref = pickRef(text, label, occurrence)
    if (ref === null) { missed.push({ tag, label, occurrence, obs: text.replace(/\s+/g, ' ').slice(0, 300) }); return doneJson(`각본 실패: "${label}"(${occurrence}) 를 관찰에서 못 찾음`) }
    return clickJson(ref)
  }
  function reqType(text, label, occurrence, value, missed, tag) {
    const ref = pickRef(text, label, occurrence)
    if (ref === null) { missed.push({ tag, label, occurrence, obs: text.replace(/\s+/g, ' ').slice(0, 300) }); return doneJson(`각본 실패: "${label}"(${occurrence}) 를 관찰에서 못 찾음`) }
    return typeJson(ref, value)
  }
  /** 타이핑과 동시에 Enter 로 제출한다(댓글 등록 버튼을 별도로 누르지 않는 경로). */
  function reqTypeSubmit(text, label, occurrence, value, missed, tag) {
    const ref = pickRef(text, label, occurrence)
    if (ref === null) { missed.push({ tag, label, occurrence, obs: text.replace(/\s+/g, ' ').slice(0, 300) }); return doneJson(`각본 실패: "${label}"(${occurrence}) 를 관찰에서 못 찾음`) }
    return typeSubmitJson(ref, value)
  }

  const missed = []

  // ===== 시나리오 =====

  // ---- GE1 — 댓글 응답 유실 후 재시도해도 두 번 달리지 않는다 ----
  async function runGE1() {
    const postId = 'post:1101'
    const tab = (await newTab(windowId, `${fixture.base}/blog/post/1101`)).id
    await sleep(1200)
    llm.setScript([
      { reply: (ctx) => reqType(ctx.lastUser, '댓글을 입력하세요', 0, 'GE1 실측 댓글입니다', missed, 'GE1-type') },
      { reply: (ctx) => reqClick(ctx.lastUser, '댓글 등록', 0, missed, 'GE1-click') },
      { status: 500, body: { error: '응답 유실(시험)' } },
    ])
    const id = await launch({ marker: 'GE1', tabId: tab, extra: '이 글에 댓글을 하나 남겨줘' })

    const waiting = await waitTask(id, (t) => t.state === 'waiting-user', 40000)
    const cause = waiting.task?.waitCause
    const reason = String(waiting.task?.waitReason ?? '')
    check('GE1-a', '응답 유실 뒤 waiting-user/ledger 로 확인을 구한다(문구에 "댓글 등록")',
      waiting.ok && cause === 'ledger' && /댓글 등록/.test(reason),
      `상태=${stateOf(waiting.task)} cause=${cause} 사유="${reason.slice(0, 80)}"` + (waiting.ok ? '' : ` · ${await diagFor(id)}`))
    const after1st = fixture.state.comments.filter((c) => c.postId === postId).length

    llm.setScript([
      { reply: (ctx) => reqType(ctx.lastUser, '댓글을 입력하세요', 0, 'GE1 재시도 댓글입니다', missed, 'GE1-retry-type') },
      { reply: (ctx) => reqClick(ctx.lastUser, '댓글 등록', 0, missed, 'GE1-retry-click') },
      { reply: () => doneJson('완료') },
    ])
    await confirmTask(id, true)
    const done = await waitTask(id, (t) => t.state !== 'running' && t.state !== 'retrying', 60000)
    const final = fixture.state.comments.filter((c) => c.postId === postId).length
    check('GE1-b', '이어가기(확인) 후 재시도해도 댓글이 정확히 1건 — 2건이면 중복, 0건이면 애초에 안 달린 것',
      after1st === 1 && final === 1,
      `1차 후 ${after1st}건 · 확인+재시도 후 ${final}건 · 최종 상태=${stateOf(done.task)}` + (final !== 1 ? ` · ${await diagFor(id)}` : ''))
    await cancelTask(id).catch(() => {})
  }

  // ---- GE2 — 크래시·재시작을 넘겨도 두 번 달리지 않는다 ----
  async function runGE2() {
    const postId = 'post:1102'
    const tab = (await newTab(windowId, `${fixture.base}/blog/post/1102`)).id
    await sleep(1200)
    llm.setScript([
      { reply: (ctx) => reqType(ctx.lastUser, '댓글을 입력하세요', 0, 'GE2 실측 댓글입니다', missed, 'GE2-type') },
      { reply: (ctx) => reqClick(ctx.lastUser, '댓글 등록', 0, missed, 'GE2-click') },
      { status: 500, body: { error: '응답 유실(시험)' } },
    ])
    const id = await launch({ marker: 'GE2', tabId: tab, extra: '이 글에 댓글을 하나 남겨줘' })
    const waiting = await waitTask(id, (t) => t.state === 'waiting-user', 40000)
    check('GE2-a', '크래시 직전에도 waiting-user/ledger 로 멈춘다(하드킬 전 전제 확인)',
      waiting.ok && waiting.task?.waitCause === 'ledger',
      `상태=${stateOf(waiting.task)} cause=${waiting.task?.waitCause}` + (waiting.ok ? '' : ` · ${await diagFor(id)}`))
    const afterCrashPre = fixture.state.comments.filter((c) => c.postId === postId).length

    // ── 진짜 비정상 종료(before-quit 미실행) — fake-llm/fixture 는 별도 프로세스가 아니라 이
    //    하네스 안의 서버라 앱 크래시와 무관하게 살아 있는다(상태·카운트 그대로 유지).
    await hardKill()
    await boot('ge2-restart')

    const settled = await waitTask(id, (t) => t.state !== 'running' && t.state !== 'queued', 30000)
    note(`GE2 재시작 직후 상태=${stateOf(settled.task)}(보통 interrupted 로 정리된다 — 재시작은 진행 중이던 구간을 통째로 무효화한다)`)

    llm.setScript([
      { reply: (ctx) => reqType(ctx.lastUser, '댓글을 입력하세요', 0, 'GE2 재시도 댓글입니다', missed, 'GE2-retry-type') },
      { reply: (ctx) => reqClick(ctx.lastUser, '댓글 등록', 0, missed, 'GE2-retry-click') },
      { reply: () => doneJson('완료') },
    ])

    let cur = settled.task
    if (cur?.state === 'interrupted' || cur?.state === 'paused') {
      const r = await resumeTask(id)
      if (!r?.ok) note(`GE2 resumeTask 거부: ${r?.error ?? '(사유 없음)'}`)
    }
    // 재시작 뒤 첫 재개는 (미확인 원장이 남아 있으므로) 다시 waiting-user/ledger 로 되돌아온다 —
    // 확인해야 이어간다(재시작 한 번이 곧 자동 승인이 되면 안 된다).
    let re = await waitTask(id, (t) => t.state === 'waiting-user' || t.state === 'interrupted' || t.state === 'completed' || t.state === 'needs-verify', 40000)
    if (re.task?.state === 'waiting-user' && re.task.waitCause === 'ledger') {
      await confirmTask(id, true)
      re = await waitTask(id, (t) => t.state !== 'running' && t.state !== 'retrying' && t.state !== 'waiting-user', 60000)
    } else if (re.task?.state === 'waiting-user' && re.task.waitCause === 'tab-target') {
      // 안전망 — 탭 재바인딩이 자동으로 안 됐으면 대상을 직접 지정한다(T9 와 같은 방식).
      const targets = await ptaskTargets(id)
      const pick = (targets?.tabs ?? [])[0]
      if (pick) {
        await ptaskSetTarget(id, pick.tabId)
        await resumeTask(id)
        re = await waitTask(id, (t) => t.state === 'waiting-user' || t.state !== 'running', 40000)
        if (re.task?.state === 'waiting-user' && re.task.waitCause === 'ledger') {
          await confirmTask(id, true)
          re = await waitTask(id, (t) => t.state !== 'running' && t.state !== 'retrying' && t.state !== 'waiting-user', 60000)
        }
      }
    }
    const final = fixture.state.comments.filter((c) => c.postId === postId).length
    check('GE2-b', '크래시+재시작을 넘겨도 댓글이 정확히 1건 유지 — 재시작이 중복을 만들지 않는다',
      afterCrashPre === 1 && final === 1,
      `크래시 직전 ${afterCrashPre}건 · 재시작+재시도 후 ${final}건 · 최종 상태=${stateOf(re.task)}` + (final !== 1 ? ` · ${await diagFor(id)}` : ''))
    await cancelTask(id).catch(() => {})
  }

  // ---- GE3 — 좋아요가 눌린 뒤 타임아웃되어도 취소되지 않는다 ----
  async function runGE3() {
    const postId = 'post:1103'
    const tab = (await newTab(windowId, `${fixture.base}/blog/post/1103`)).id
    await sleep(1200)
    llm.setScript([
      { reply: (ctx) => reqClick(ctx.lastUser, '좋아요', 0, missed, 'GE3-click') },
      { status: 500, body: { error: '응답 유실(시험)' } },
    ])
    const id = await launch({ marker: 'GE3', tabId: tab, extra: '이 글에 좋아요 눌러줘' })
    const waiting = await waitTask(id, (t) => t.state === 'waiting-user', 40000)
    const reason = String(waiting.task?.waitReason ?? '')
    check('GE3-a', '좋아요 응답 유실 뒤 waiting-user/ledger 로 확인을 구한다(문구에 "좋아요")',
      waiting.ok && waiting.task?.waitCause === 'ledger' && /좋아요/.test(reason),
      `상태=${stateOf(waiting.task)} cause=${waiting.task?.waitCause} 사유="${reason.slice(0, 80)}"` + (waiting.ok ? '' : ` · ${await diagFor(id)}`))
    const likedAfter1 = !!fixture.state.likesMap[postId]
    const eventsAfter1 = fixture.state.likeEvents.filter((e) => e.postId === postId).length

    llm.setScript([
      // 이어가기 후 각본이 그 버튼을 **다시** 누른다(모델이 실패했다고 오해하고 재시도하는 상황) —
      // 이 시점 버튼 라벨은 "♥ 좋아요 취소" 지만 라벨 검색은 부분일치라 "좋아요" 로도 찾힌다.
      { reply: (ctx) => reqClick(ctx.lastUser, '좋아요', 0, missed, 'GE3-retry-click') },
      { reply: () => doneJson('완료') },
    ])
    await confirmTask(id, true)
    const done = await waitTask(id, (t) => t.state !== 'running' && t.state !== 'retrying', 60000)
    const likedFinal = !!fixture.state.likesMap[postId]
    const eventsFinal = fixture.state.likeEvents.filter((e) => e.postId === postId).length
    check('GE3-b', '확인 후 재시도해도 좋아요가 취소되지 않는다(liked 유지, 토글 이벤트 1건 그대로)',
      likedAfter1 === true && likedFinal === true && eventsAfter1 === 1 && eventsFinal === 1,
      `1차 후 liked=${likedAfter1}(이벤트 ${eventsAfter1}) · 재시도 후 liked=${likedFinal}(이벤트 ${eventsFinal}) · 상태=${stateOf(done.task)}`
      + (!(likedFinal && eventsFinal === 1) ? ` · ${await diagFor(id)}` : ''))
    await cancelTask(id).catch(() => {})
  }

  // ---- GE4 — 다른 글에 대한 정당한 행동은 막히지 않는다(과차단 방지) ----
  async function runGE4() {
    const tab = (await newTab(windowId, `${fixture.base}/blog/feed`)).id
    await sleep(1200)
    llm.setScript([
      { reply: (ctx) => reqType(ctx.lastUser, '댓글을 입력하세요', 0, 'f1 실측 댓글', missed, 'GE4-type-f1') },
      { reply: (ctx) => reqClick(ctx.lastUser, '댓글 등록', 0, missed, 'GE4-click-f1') },
      { reply: (ctx) => reqType(ctx.lastUser, '댓글을 입력하세요', 1, 'f2 실측 댓글', missed, 'GE4-type-f2') },
      { reply: (ctx) => reqClick(ctx.lastUser, '댓글 등록', 1, missed, 'GE4-click-f2') },
      { reply: () => doneJson('완료') },
    ])
    const id = await launch({ marker: 'GE4', tabId: tab, extra: 'f1 글과 f2 글에 각각 댓글을 하나씩 남겨줘', budget: { maxSteps: 20 } })
    const done = await waitTask(id, (t) => t.state !== 'running' && t.state !== 'queued', 60000)
    const f1 = fixture.state.comments.filter((c) => c.postId === 'post:f1').length
    const f2 = fixture.state.comments.filter((c) => c.postId === 'post:f2').length
    check('GE4', '같은 페이지의 다른 글(f1·f2) 각각에 댓글 1건씩 — 같은 페이지 주소를 공유해도 서로 막지 않는다',
      f1 === 1 && f2 === 1,
      `post:f1=${f1}건 · post:f2=${f2}건 · 최종 상태=${stateOf(done.task)}` + (!(f1 === 1 && f2 === 1) ? ` · ${await diagFor(id)}` : ''))
    await cancelTask(id).catch(() => {})
  }

  // ---- GE5 — 명시적으로 요청한 좋아요 취소는 정상 동작한다 ----
  async function runGE5() {
    // post:3 은 픽스처가 이미 좋아요를 눌러 둔 상태로 시작한다.
    if (!fixture.state.likesMap['post:3']) {
      skip('GE5', '명시적 좋아요 취소', 'post:3 초기 좋아요 상태 전제가 깨져 있음(픽스처 변경?)')
      return
    }
    const tab = (await newTab(windowId, `${fixture.base}/blog/post/3`)).id
    await sleep(1200)
    llm.setScript([
      { reply: (ctx) => reqClick(ctx.lastUser, '좋아요', 0, missed, 'GE5-unlike-click') },
      { reply: () => doneJson('완료') },
    ])
    const id = await launch({ marker: 'GE5', tabId: tab, extra: '이 글 좋아요를 취소해줘' })
    const done = await waitTask(id, (t) => t.state !== 'running' && t.state !== 'queued', 40000)
    const liked = !!fixture.state.likesMap['post:3']
    check('GE5', '사용자가 명시적으로 요청한 좋아요 취소는 실제로 실행된다(liked=false)',
      liked === false,
      `post:3 liked=${liked}(false 여야) · 최종 상태=${stateOf(done.task)}` + (liked !== false ? ` · ${await diagFor(id)}` : ''))
    await cancelTask(id).catch(() => {})
  }

  // ---- GE6 — 대상을 특정할 수 없으면 실제 UI 로 복구할 수 있다 ----
  // UI 헬퍼(verify-task-ui-cdp.mjs 의 선례를 그대로 따른다 — 실제 DOM 클릭/입력만 쓴다, IPC 로 직접 답하지 않는다).
  async function evaluateUi(expression, timeoutMs = 20000) {
    const r = await shell.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'JS 예외')
    return r.result?.value
  }
  async function pollUi(expression, predicate, { timeoutMs = 20000, intervalMs = 400, label = 'condition' } = {}) {
    const dl = Date.now() + timeoutMs
    let last
    while (Date.now() < dl) {
      last = await evaluateUi(expression)
      if (predicate(last)) return last
      await sleep(intervalMs)
    }
    throw new Error(`timeout(${timeoutMs}ms) waiting for ${label} — 마지막 값: ${J(last)}`)
  }
  async function clickByText(selector, text) {
    return evaluateUi(`(() => {
      const els = [...document.querySelectorAll(${J(selector)})]
      const el = els.find(x => (x.textContent || '').includes(${J(text)}))
      if (!el) return false
      el.click(); return true
    })()`)
  }
  async function openAiPanel() {
    await evaluateUi(`window.browserAPI.actions.run('action.ai.open', { windowId: ${J(windowId)} })`)
    const dl = Date.now() + 20000
    let reopened = false
    while (Date.now() < dl) {
      if (await evaluateUi(`!!document.querySelector('.ai-tab')`)) return true
      if (!reopened && Date.now() > dl - 12000) {
        await evaluateUi(`window.browserAPI.actions.run('action.ai.open', { windowId: ${J(windowId)} })`)
        reopened = true
      }
      await sleep(500)
    }
    return false
  }
  async function switchToAgentMode() {
    await clickByText('.ai-mode-btn', '에이전트')
    await sleep(200)
  }
  function cardExprFor(marker) {
    return `(() => {
      const cards = [...document.querySelectorAll('.ai-task-card')]
      const c = cards.find(x => (x.querySelector('.ai-task-instruction')?.getAttribute('title') || '').includes(${J(marker)}))
      if (!c) return null
      return {
        state: (c.querySelector('.ai-task-badge')?.textContent || '').trim(),
        confirmMsg: (c.querySelector('.ai-confirm-msg')?.textContent || '').trim(),
        hasAskInput: !!c.querySelector('.ai-ask-input'),
      }
    })()`
  }
  async function answerCardViaUi(marker, answerText) {
    // "📌 작업" 전체 목록을 열어 카드를 확실히 찾는다(인라인 목록은 진행 중인 것만 보이는데,
    // waiting-user 는 진행 중으로 분류돼 인라인에도 보이지만 전체 목록에서도 항상 찾힌다).
    const opened = await pollUi(`document.querySelector('.ai-history-head span')?.textContent === '영속 작업' ? true : (() => { const b = [...document.querySelectorAll('.ai-meta-actions .ai-mini-btn')].find(x => (x.textContent||'').includes('작업')); if (b) b.click(); return false })()`,
      (v) => v === true, { timeoutMs: 8000, label: '"📌 작업" 목록 열림' }).catch(() => false)
    void opened
    const card = await pollUi(cardExprFor(marker), (v) => !!v && (v.hasAskInput || v.confirmMsg), { timeoutMs: 15000, label: `카드[${marker}] 질문 표시` })
    const ok1 = await evaluateUi(`(() => {
      const cards = [...document.querySelectorAll('.ai-task-card')]
      const c = cards.find(x => (x.querySelector('.ai-task-instruction')?.getAttribute('title') || '').includes(${J(marker)}))
      if (!c) return false
      const input = c.querySelector('.ai-ask-input')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${J(answerText)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    const ok2 = await evaluateUi(`(() => {
      const cards = [...document.querySelectorAll('.ai-task-card')]
      const c = cards.find(x => (x.querySelector('.ai-task-instruction')?.getAttribute('title') || '').includes(${J(marker)}))
      if (!c) return false
      const btns = [...c.querySelectorAll('button')].filter(b => (b.textContent || '').includes('보내기'))
      const btn = btns.find((b) => !b.disabled) || btns[0]
      if (!btn || btn.disabled) return false
      btn.click(); return true
    })()`)
    return { card, filled: ok1, sent: ok2 }
  }

  async function runGE6() {
    // Part A — "건너뛰기" 답변 → 클릭이 실행되지 않는다.
    {
      const tab = (await newTab(windowId, `${fixture.base}/blog/anon`)).id
      await sleep(1200)
      llm.setScript([
        { reply: (ctx) => reqType(ctx.lastUser, '댓글을 입력하세요', 0, 'GE6 익명 댓글', missed, 'GE6a-type') },
        { reply: (ctx) => reqClick(ctx.lastUser, '댓글 등록', 0, missed, 'GE6a-click') },
        { reply: () => doneJson('사용자 지시대로 건너뜀') },
      ])
      const id = await launch({ marker: 'GE6A', tabId: tab, extra: '이 글에 댓글 달아줘' })
      const asking = await waitTask(id, (t) => t.state === 'waiting-user', 40000)
      const reason = String(asking.task?.waitReason ?? '')
      check('GE6-a1', '퍼머링크·제목이 없는 글(대상 특정 불가)에서는 추측해서 누르지 않고 사용자에게 묻는다(waitCause=ask)',
        asking.ok && asking.task?.waitCause === 'ask' && /특정할 수 없|모릅니다|어느 글/.test(reason),
        `상태=${stateOf(asking.task)} cause=${asking.task?.waitCause} 사유="${reason.slice(0, 90)}"` + (asking.ok ? '' : ` · ${await diagFor(id)}`))

      const panelOpen = await openAiPanel()
      check('GE6-a2-setup', 'AI 패널(에이전트 모드)이 실제로 열림', panelOpen, panelOpen ? '.ai-tab 마운트' : '패널을 못 엶')
      if (panelOpen) {
        await switchToAgentMode()
        let ui = null
        try { ui = await answerCardViaUi('GE6A', '건너뛰기') } catch (e) { note(`GE6-a UI 상호작용 실패: ${e.message}`) }
        check('GE6-a2', '카드에 질문 문구가 보이고, 실제 DOM(답변칸+보내기 버튼)으로 "건너뛰기" 를 보낼 수 있다',
          !!ui && !!ui.card?.confirmMsg && ui.filled === true && ui.sent === true,
          ui ? `카드 질문="${String(ui.card?.confirmMsg ?? '').slice(0, 60)}" 입력채움=${ui.filled} 전송=${ui.sent}` : '(UI 상호작용 실패)')
      }
      const settled = await waitTask(id, (t) => t.state !== 'running' && t.state !== 'waiting-user', 30000)
      const a1 = fixture.state.comments.filter((c) => c.postId === 'post:a1').length
      const a2 = fixture.state.comments.filter((c) => c.postId === 'post:a2').length
      check('GE6-a3', '"건너뛰기" 답변 후에는 댓글이 등록되지 않는다(a1·a2 둘 다 0건)',
        a1 === 0 && a2 === 0,
        `post:a1=${a1}건 post:a2=${a2}건 · 최종 상태=${stateOf(settled.task)}` + (!(a1 === 0 && a2 === 0) ? ` · ${await diagFor(id)}` : ''))
      await cancelTask(id).catch(() => {})
    }

    // Part B — "계속" 답변 → 페이지 단위 키로 실제 진행된다(복구가 쓸모 있는지).
    {
      const tab = (await newTab(windowId, `${fixture.base}/blog/anon`)).id
      await sleep(1200)
      llm.setScript([
        { reply: (ctx) => reqType(ctx.lastUser, '댓글을 입력하세요', 1, 'GE6B 익명 댓글', missed, 'GE6b-type') },
        { reply: (ctx) => reqClick(ctx.lastUser, '댓글 등록', 1, missed, 'GE6b-click') },
        { reply: () => doneJson('완료') },
      ])
      const id = await launch({ marker: 'GE6B', tabId: tab, extra: '이 글에 댓글 달아줘' })
      const asking = await waitTask(id, (t) => t.state === 'waiting-user', 40000)
      const panelOpen = await openAiPanel()
      let ui = null
      if (panelOpen) {
        await switchToAgentMode()
        try { ui = await answerCardViaUi('GE6B', '계속') } catch (e) { note(`GE6-b UI 상호작용 실패: ${e.message}`) }
      }
      const settled = await waitTask(id, (t) => t.state !== 'running' && t.state !== 'waiting-user', 40000)
      const total = fixture.state.comments.filter((c) => c.postId === 'post:a1' || c.postId === 'post:a2').length
      check('GE6-b', '복구가 실제로 쓸모 있다 — "계속" 답변 뒤에는 정확히 1건이 등록된다(막기만 하는 게 아니라 진행할 길이 있다)',
        asking.ok && !!ui?.sent && total === 1,
        `질문상태=${asking.ok} UI전송=${ui?.sent} 댓글 합계=${total}건 · 최종 상태=${stateOf(settled.task)}` + (total !== 1 ? ` · ${await diagFor(id)}` : ''))
      await cancelTask(id).catch(() => {})
    }
  }

  // ---- GE7 — 장부 저장 자체가 실패하면 클릭이 나가지 않는다 ----
  async function runGE7() {
    // 제품 코드는 건드리지 않는다 — userData 경로 그 자리에 **동명의 디렉터리**를 만들어 쓰기(rename)가
    // 실패하게 한다(json-store.ts: tmp 쓰기는 성공하지만 파일→디렉터리로의 rename 은 실패한다).
    // 부팅 시점의 ledger 초기화(initEngageLedger)는 이미 끝난 뒤(in-memory 캐시 보유)이므로 안전하다.
    if (fs.existsSync(ledgerFile)) {
      const st = fs.statSync(ledgerFile)
      if (st.isDirectory()) { note('GE7: ledger 경로가 이미 디렉터리 — 그대로 사용'); }
      else fs.rmSync(ledgerFile, { force: true })
    }
    if (!fs.existsSync(ledgerFile)) fs.mkdirSync(ledgerFile, { recursive: true })
    const obstructed = fs.existsSync(ledgerFile) && fs.statSync(ledgerFile).isDirectory()
    if (!obstructed) {
      skip('GE7', '장부 저장 실패 시 클릭 차단', '디렉터리 장애물을 만들지 못해 이 시나리오를 신뢰성 있게 재현할 수 없음')
      return
    }

    const tab = (await newTab(windowId, `${fixture.base}/blog/post/1107`)).id
    await sleep(1200)
    llm.setScript([
      { reply: (ctx) => reqType(ctx.lastUser, '댓글을 입력하세요', 0, 'GE7 저장실패 댓글', missed, 'GE7-type') },
      { reply: (ctx) => reqClick(ctx.lastUser, '댓글 등록', 0, missed, 'GE7-click') },
      { reply: () => doneJson('완료') },
    ])
    const id = await launch({ marker: 'GE7', tabId: tab, extra: '이 글에 댓글을 하나 남겨줘' })
    const done = await waitTask(id, (t) => t.state !== 'running' && t.state !== 'queued', 40000)
    const count = fixture.state.comments.filter((c) => c.postId === 'post:1107').length
    const evs = await taskEvents(id)
    const failNote = evs.some((e) => e.type === 'result' && e.ok === false && /저장하지 못해|저장 실패|기록을 저장/.test(String(e.detail ?? '')))

    check('GE7-a', '장부를 디스크에 확정하지 못하면 클릭이 나가지 않는다(댓글 0건)',
      count === 0,
      `post:1107 댓글=${count}건(0 이어야) · 최종 상태=${stateOf(done.task)}` + (count !== 0 ? ` · ${await diagFor(id)}` : ''))
    check('GE7-b', '저장 실패 사실이 트레이스/결과에 문구로 남는다(조용히 실패하지 않는다)',
      failNote,
      failNote ? '저장 실패 문구 확인됨' : `이벤트 ${evs.length}건 중 저장 실패 문구 없음 — 이벤트=${J(evs.slice(0, 6))}`)
    await cancelTask(id).catch(() => {})

    // 정리 — 이후 시나리오(GE8)가 정상적으로 장부를 쓸 수 있게 장애물을 치운다.
    fs.rmSync(ledgerFile, { recursive: true, force: true })
    note('GE7: ledger 장애물 제거 완료 — 다음 시나리오부터는 정상 저장된다')
  }

  // ---- GE8 — 평범한 읽기·이동은 간섭하지 않는다 + 발사 못 한 클릭은 재시도를 막지 않는다 ----
  async function runGE8() {
    // (a) 읽기 전용 동작(이동·스크롤·note·done)만 — /state 전혀 안 바뀐다.
    {
      const before = J({
        c: fixture.state.comments.length, l: J(fixture.state.likesMap), e: fixture.state.likeEvents.length,
      })
      const tab = (await newTab(windowId, `${fixture.base}/blog/post/1108`)).id
      await sleep(1200)
      llm.setScript([
        { reply: () => navJson(`${fixture.base}/blog/search?q=test`) },
        { reply: () => scrollJson },
        { reply: () => noteJson('읽기 전용 확인용 노트') },
        { reply: () => doneJson('읽기만 하고 종료') },
      ])
      const id = await launch({ marker: 'GE8A', tabId: tab, extra: '이 글을 읽고 요약만 남겨줘(댓글·좋아요는 하지 마)', budget: { maxSteps: 12 } })
      const done = await waitTask(id, (t) => t.state !== 'running' && t.state !== 'queued', 40000)
      const after = J({
        c: fixture.state.comments.length, l: J(fixture.state.likesMap), e: fixture.state.likeEvents.length,
      })
      const stuck = done.task?.state === 'waiting-user'
      check('GE8-a', '읽기·이동·스크롤·note 만 하는 작업은 /state 를 전혀 바꾸지 않고 정상 종료한다(대기 상태로 멈추지 않음)',
        before === after && !stuck,
        `변경없음=${before === after} · 최종 상태=${stateOf(done.task)}(대기로 멈추면 안 됨)` + (before !== after || stuck ? ` · ${await diagFor(id)}` : ''))
      await cancelTask(id).catch(() => {})
    }

    // (b) 발사 못 한 클릭(존재하지 않는 ref)은 정당한 재시도를 막지 않는다.
    {
      const postId = 'post:1109'
      const tab = (await newTab(windowId, `${fixture.base}/blog/post/1109`)).id
      await sleep(1200)
      llm.setScript([
        { reply: () => clickJson(9999) },   // 존재하지 않는 ref — 실행 계층에서 그냥 실패한다
        { reply: (ctx) => reqType(ctx.lastUser, '댓글을 입력하세요', 0, 'GE8b 정상 댓글', missed, 'GE8b-type') },
        { reply: (ctx) => reqClick(ctx.lastUser, '댓글 등록', 0, missed, 'GE8b-click') },
        { reply: () => doneJson('완료') },
      ])
      const id = await launch({ marker: 'GE8B', tabId: tab, extra: '이 글에 댓글을 하나 남겨줘', budget: { maxSteps: 14 } })
      const done = await waitTask(id, (t) => t.state !== 'running' && t.state !== 'queued', 40000)
      const count = fixture.state.comments.filter((c) => c.postId === postId).length
      check('GE8-b', '존재하지 않는 ref 로 첫 클릭이 실패해도, 그 다음 올바른 ref 의 정당한 클릭은 막히지 않는다(댓글 1건)',
        count === 1,
        `post:1109 댓글=${count}건(1 이어야) · 최종 상태=${stateOf(done.task)}` + (count !== 1 ? ` · ${await diagFor(id)}` : ''))
      await cancelTask(id).catch(() => {})
    }
  }

  // ---- GE9 — 댓글이 클릭이 아니라 입력칸 Enter(type+submit)로 나가는 경로도 같은 가드를 탄다 ----
  // (2026-09-20, 팀장 조율: 장부 기록을 "실행 직전"으로 옮기며 이 경로도 같은 가드를 타도록 고치는 중.
  //  이 시나리오는 그 변경을 대상으로 한다 — 재패키징 전에는 보호가 없어 2건이 될 수 있다.)
  async function runGE9() {
    const postId = 'post:1110'
    const tab = (await newTab(windowId, `${fixture.base}/blog/post/1110`)).id
    await sleep(1200)
    llm.setScript([
      // 한 액션으로 타이핑+Enter 제출 — 별도의 "댓글 등록" 클릭이 없다.
      { reply: (ctx) => reqTypeSubmit(ctx.lastUser, '댓글을 입력하세요', 0, 'GE9 Enter 제출 댓글입니다', missed, 'GE9-typesubmit') },
      { status: 500, body: { error: '응답 유실(시험)' } },
    ])
    const id = await launch({ marker: 'GE9', tabId: tab, extra: '이 글에 댓글을 하나 남겨줘' })

    const waiting = await waitTask(id, (t) => t.state === 'waiting-user', 40000)
    const cause = waiting.task?.waitCause
    const reason = String(waiting.task?.waitReason ?? '')
    check('GE9-a', 'Enter 제출(type+submit)로 나간 댓글도 응답 유실 뒤 waiting-user/ledger 로 확인을 구한다',
      waiting.ok && cause === 'ledger' && /댓글 등록/.test(reason),
      `상태=${stateOf(waiting.task)} cause=${cause} 사유="${reason.slice(0, 80)}"` + (waiting.ok ? '' : ` · ${await diagFor(id)}`))
    const after1st = fixture.state.comments.filter((c) => c.postId === postId).length

    llm.setScript([
      { reply: (ctx) => reqTypeSubmit(ctx.lastUser, '댓글을 입력하세요', 0, 'GE9 재시도 댓글입니다', missed, 'GE9-retry-typesubmit') },
      { reply: () => doneJson('완료') },
    ])
    await confirmTask(id, true)
    const done = await waitTask(id, (t) => t.state !== 'running' && t.state !== 'retrying', 60000)
    const final = fixture.state.comments.filter((c) => c.postId === postId).length
    check('GE9-b', 'Enter 제출 경로도 확인 후 재시도해도 댓글이 정확히 1건 — 클릭 경로(GE1)와 같은 보호를 받는다',
      after1st === 1 && final === 1,
      `1차 후 ${after1st}건 · 확인+재시도 후 ${final}건 · 최종 상태=${stateOf(done.task)}` + (final !== 1 ? ` · ${await diagFor(id)}` : ''))
    await cancelTask(id).catch(() => {})
  }

  // ===== 실행 =====
  try {
    windowId = await boot('boot1')
    await sleep(500)

    if (shouldRun('GE1')) await runGE1()
    if (shouldRun('GE2')) await runGE2()
    if (shouldRun('GE3')) await runGE3()
    if (shouldRun('GE4')) await runGE4()
    if (shouldRun('GE5')) await runGE5()
    if (shouldRun('GE6')) await runGE6()
    if (shouldRun('GE7')) await runGE7()
    if (shouldRun('GE8')) await runGE8()
    if (shouldRun('GE9')) await runGE9()

    if (missed.length) {
      note(`관찰에서 라벨을 못 찾은 시도 ${missed.length}건: ${J(missed.slice(0, 5))}`)
    }
  } finally {
    await gracefulQuit()
    // 좀비 프로세스 확인 — 이 하네스가 띄운 PID 만 확인한다(사용자의 실제 창을 건드리지 않는다).
    if (child?.pid) {
      let alive = true
      try { process.kill(child.pid, 0) } catch { alive = false }
      if (alive) {
        note(`⚠ PID ${child.pid} 가 아직 살아 있다 — 강제 정리 시도`)
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000 }) } catch { /* ignore */ }
      }
    }
    try { await llm.close() } catch { /* ignore */ }
    try { await fixture.close() } catch { /* ignore */ }
  }

  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const skipped = results.filter((r) => r.status === 'SKIP').length
  fs.writeFileSync(path.join(args.out, 'results.json'), J({
    at: new Date().toISOString(), pass, fail, skip: skipped, results, notes,
  }, null, 2))
  console.log(NL + `일반 작업 댓글·좋아요 중복 방지: ${pass} PASS · ${fail} FAIL · ${skipped} SKIP`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
