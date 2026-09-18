#!/usr/bin/env node
// verify-ai-persist-cdp.mjs — AI 대화·실행 이력이 재시작 후에도 남고, 상한이 지켜지는가
//
// 왜 (2026-09-07, 임무 33): 대화와 실행 이력은 **디스크에 남아야 의미가 있는 기록**이다.
// 사라지면 사용자는 "AI 가 뭘 했는지" 를 영영 알 수 없고, 상한이 깨지면 파일이 무한히 커진다.
// 재시작을 넘기는 성질이라 앱을 두 번 띄워야만 확인할 수 있고, 그래서 검사가 없었다.
//
//   PS1 대화가 강제 종료 후에도 남는다
//   PS5 대화 **본문**까지 온전하다(제목만 남고 메시지가 비는 것을 잡는다)
//   PS2 에이전트 실행 이력이 남고 **단계 내용**도 보존된다
//   PS4 재시작하면 'running' 으로 남은 실행이 'cancelled' 로 정리된다(영원한 진행중 방지)
//   PS3 대화 상한(100개)을 넘기면 **오래된 것부터** 잘린다
//   PS6 실행 이력 상한(50건)을 넘기면 **최신이 남고** 오래된 것이 잘린다
//   PS7 대화당 메시지 상한(200개)을 넘기면 **최신 대화가 남는다**
//   PS8 한 실행의 단계 상한(120개) — 정확히 120 을 지키고, 최신(종료 마커)이 남는다
//
// 2026-09-15 (묶음 A) 추가 — 저장 신뢰성(경합·손상 복구):
//   PS9  연속 갱신 직후 정상 종료 → 재시작해도 **마지막 갱신까지** 남는다
//   PS10 저장 파일이 통째로 깨져도 앱이 뜨고, 손상본이 **고유 이름 백업**으로 보존된다
//   PS10B 두 번째 손상이 나도 **첫 백업을 덮어쓰지 않는다**(원본 보존)
//   PS11 일부 항목만 망가진 파일에서 **정상 항목은 복구**된다
//   PS12 (양성 대조) 정상 파일은 **한 바이트도 건드리지 않는다** — 백업도, 비우기도 없다
//
// ⚠ PS9 의 성격을 정직하게 적어 둔다: 이 검사는 **계약(연속 갱신 후 즉시 종료해도 안 잃는다)**
//   을 지키는 가드다. 고치기 전 코드의 결함(`persist()` 가 await 뒤에 dirty=false 를 해서,
//   쓰는 도중 들어온 변경을 "저장됨" 으로 표시하고 종료 flush 가 건너뛰던 것)은 **쓰기가 진행 중인
//   그 몇 ms 안에 마지막 변경이 들어와야** 발현한다. 밖에서 그 순간을 정확히 겨냥할 수 없으므로,
//   파일을 키워 쓰기 구간을 늘리고 디바운스 경계에 맞춰 변경을 몰아넣는 것까지가 이 하네스의 최선이다.
//   즉 **PS9 가 통과한다고 옛 결함이 없었다는 뜻은 아니다.** 반대로 PS9 가 실패하면 그건 진짜다.
//   PS12 가 없으면 "언제나 백업하고 비우는" 구현도 PS10 을 통과해 버린다 — 양성 대조가 짝이다.
//
// ⚠ 2026-09-15 에 고친 하네스 결함 두 가지 — 같은 실수를 되풀이하지 말 것:
//   ① PS2 가 요약의 `steps`(없는 필드)를 읽어 늘 `단계 0개` 였는데, 판정식이
//      `A && B || C` 라 뒤의 느슨한 C(`이력 2건 이상`)로 통과했다. 요약 필드는 `stepCount` 이고,
//      단계 **내용**은 `runGet(id).steps` 로만 볼 수 있다. 느슨한 폴백을 || 로 붙이지 말 것.
//   ② PS4 는 "하나는 running 으로 남긴다" 고 적어 뒀지만, 제공자가 죽어 있어 두 실행 모두
//      kill 전에 error 로 끝났다 — **아무것도 running 이 아닌 상태**에서 "running 이 없다" 를
//      확인하던 빈 검사였다. 이제 가짜 LLM 의 hang 으로 실제로 멈춰 세운 뒤 죽인다.
//
// 사용: node build/verify-ai-persist-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, waitForPortFree, connectShellSessionReady } from './lib/cdp.mjs'
import { preferFreePort, getFreePorts } from './lib/ports.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9265, out: path.join(REPO, 'verify-out', 'ai-persist') }
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

// 에이전트는 내부 페이지(browser://)를 조작 대상에서 제외한다 — 실행 이력을 만들려면 http 페이지가 필요하다.
function startPageServer(port) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset="utf-8"><title>영속화 시험</title>'
      + '<body style="font:16px system-ui;padding:40px"><h1>영속화 시험 페이지</h1>'
      + '<button id="b">확인</button></body>')
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

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE}`)
  fs.mkdirSync(args.out, { recursive: true })
  args.port = await preferFreePort(args.port, 'ai-persist')
  await waitForPortFree(args.port)
  const [llmPort, pagePort] = await getFreePorts(2)
  const llm = await startFakeLlm({ port: llmPort })
  const pages = await startPageServer(pagePort)

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true },
    // 강제 종료 뒤 재부팅하므로 **'지난 세션 복원' 모달**이 창 생성을 막는다(임무 23 에서 규명).
    // last-session 이면 묻지 않고 자동 복원한다 — session-restore 하네스와 같은 방식.
    startup: { mode: 'last-session', urls: [] },
    adblock: { enabled: false },
    ai: {
      enabled: true, provider: 'ollama', ollamaUrl: llm.url,
      // 허용목록에 없는 모델 이름 → 네이티브 도구 대신 JSON 액션 경로(결정론적).
      ollamaModel: 'test-model',
      agentMaxSteps: 4, agentVision: 'off', agentHumanInput: false, agentAutoApprove: false,
    },
  }, null, 2))

  let child = null
  let shell = null

  /** 앱을 띄우고 외피 세션을 잡는다. */
  async function boot(label) {
    const logStream = fs.createWriteStream(path.join(args.out, `app-${label}.log`))
    child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(logStream); child.stderr.pipe(logStream)
    shell = await connectShellSessionReady(args.port)
    await sleep(1200)
  }

  /**
   * 정상 종료(Browser.close → before-quit → 동기 flush).
   * 디바운스 대기 중이던 저장이 여기서 살아남아야 한다 — PS9 의 핵심 경로.
   */
  async function gracefulQuit() {
    const exited = new Promise((r) => { child.once('exit', r) })
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {})
      b.close()
    } catch { /* ignore */ }
    await Promise.race([exited, sleep(15000)])
    try { shell?.close() } catch { /* ignore */ }
    try { child?.kill() } catch { /* ignore */ }
    await waitForPortFree(args.port).catch(() => {})
    await sleep(1000)
  }

  /** 강제 종료 — 정상 종료가 아니어도 남아야 하는 기록인지 본다. */
  async function hardKill() {
    const exited = new Promise((r) => { child.once('exit', r) })
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    await Promise.race([exited, sleep(6000)])
    try { shell?.close() } catch { /* ignore */ }
    await waitForPortFree(args.port).catch(() => {})
    await sleep(1200)
  }

  try {
    // ===== 1차 부팅: 기록을 남긴다 =====
    await boot('first')

    // 대화 3개 + 실행 이력 2건(하나는 running 으로 남긴다)
    await evalIn(shell, `(async () => {
      for (let i = 1; i <= 3; i++) {
        // 시그니처는 **객체 하나** — (id, messages) 두 인자로 부르면 조용히 아무 일도 안 일어난다.
        await window.browserAPI.ai.convSave({ id: 'conv-' + i, messages: [
          { role: 'user', content: '질문 ' + i },
          { role: 'assistant', content: '답변 ' + i },
        ] })
      }
      return true
    })()`, true)

    // 실행 이력은 에이전트 이벤트로만 쌓인다. 조작 대상이 될 http 탭을 연다.
    const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
    const tabId = await evalIn(shell,
      `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pages.url)}).then(t => t.id)`, true)
    await sleep(2500)

    // 실행 A — 끝까지 가는 실행. 단계(관찰·행동·완료)가 쌓인 채 'done' 으로 닫힌다.
    llm.setScript([{ reply: () => '{"action":"done","message":"작업 A 완료"}' }])
    await evalIn(shell,
      `window.browserAPI.ai.agentStart(${JSON.stringify({ reqId: 'run-A', tabId, task: '영속화 시험 작업 A' })})`, true)
    await sleep(4000)

    // 실행 B — **진짜로 멈춰 세운다**. 가짜 LLM 이 응답을 끝내지 않아 'running' 인 채로 남고,
    // 그 상태에서 강제 종료해야 PS4(재시작 시 running→cancelled 정리)가 실제로 시험된다.
    llm.setScript([{ mode: 'hang' }])
    await evalIn(shell,
      `window.browserAPI.ai.agentStart(${JSON.stringify({ reqId: 'run-B', tabId, task: '영속화 시험 작업 B' })})`, true)
    await sleep(4000)

    const before = JSON.parse(await evalIn(shell, `(async () => JSON.stringify({
      convs: (await window.browserAPI.ai.convList()).length,
      runs: (await window.browserAPI.ai.runList()).map(r => ({ task: r.task, status: r.status, stepCount: r.stepCount })),
    }))()`, true) ?? '{}')

    const runningBefore = (before.runs ?? []).filter((r) => r.status === 'running').length
    await sleep(1500)   // 디바운스 저장(400ms)이 디스크에 닿도록
    await hardKill()

    // ===== 2차 부팅: 남아 있는지 확인 =====
    await boot('second')
    const after = JSON.parse(await evalIn(shell, `(async () => JSON.stringify({
      convs: await window.browserAPI.ai.convList(),
      runs: await window.browserAPI.ai.runList(),
    }))()`, true) ?? '{}')

    check('PS1', '대화가 강제 종료 후에도 남는다',
      (after.convs?.length ?? 0) >= 3 && after.convs.some((c) => String(c.title ?? '').includes('질문')),
      `재시작 전 ${before.convs}개 → 후 ${after.convs?.length ?? 0}개 · 제목 예: ${after.convs?.[0]?.title ?? '(없음)'}`)

    // PS5 — 제목만 남고 본문이 비는 손실을 잡는다. 목록 요약이 아니라 **본문**을 직접 읽는다.
    {
      const conv = JSON.parse(await evalIn(shell,
        `window.browserAPI.ai.convGet('conv-2').then(c => JSON.stringify(c))`, true) ?? 'null')
      const msgs = conv?.messages ?? []
      const roles = msgs.map((m) => m.role).join(',')
      check('PS5', '대화 본문(메시지)까지 온전히 남는다',
        msgs.length === 2 && roles === 'user,assistant'
          && String(msgs[0]?.content) === '질문 2' && String(msgs[1]?.content) === '답변 2',
        `메시지 ${msgs.length}개 · 역할=[${roles}] · 본문="${String(msgs[0]?.content ?? '')}" / "${String(msgs[1]?.content ?? '')}"`)
    }

    // PS2 — 요약의 필드는 `stepCount` 다(`steps` 는 없다). 개수만으로는 "무엇이 남았는지" 를 못 보므로
    // runGet 으로 **단계 내용**까지 확인한다. 느슨한 폴백(||)은 두지 않는다 — 그게 이 검사를 죽였다.
    const runA = (after.runs ?? []).find((r) => String(r.task).includes('작업 A'))
    {
      const detail = runA ? JSON.parse(await evalIn(shell,
        `window.browserAPI.ai.runGet(${JSON.stringify(runA.id)}).then(r => JSON.stringify(r))`, true) ?? 'null') : null
      const steps = detail?.steps ?? []
      const texts = steps.map((s) => String(s.text)).join(' | ')
      check('PS2', '에이전트 실행 이력이 남고 단계 내용도 보존된다',
        !!runA && (runA.stepCount ?? 0) > 0 && steps.length === runA.stepCount
          && detail?.status === 'done' && texts.includes('작업 A 완료'),
        `이력 ${after.runs?.length ?? 0}건 · A 작업=${!!runA} · 요약 stepCount=${runA?.stepCount ?? 0}`
        + ` · 상세 단계 ${steps.length}개 · 상태=${detail?.status} · 내용=${texts.slice(0, 120) || '(없음)'}`)
    }

    // PS4 — 재시작 **전에 실제로 running 이었는지**를 먼저 확인한다. 그러지 않으면
    // "running 이 하나도 없었으니 당연히 없다" 를 통과로 세는 빈 검사가 된다(2026-09-15 이전이 그랬다).
    const runB = (after.runs ?? []).find((r) => String(r.task).includes('작업 B'))
    // 기대 상태 변경 (2026-09-18, 팀장): `cancelled` → **`interrupted`**.
    //   예전에는 재시작 시 남은 'running' 을 'cancelled' 로 뭉갰다. 그러면 **사용자가 직접 중단한 것**과
    //   **크래시로 끊긴 것**이 화면에서 같아 보이고, 후자는 이어갈 수 있는데 그 사실이 사라진다.
    //   이번 라운드에 'interrupted'(이어가기 가능) 를 신설해 둘을 구분했다 — 이 검사는 옛 동작을
    //   기대하고 있었으므로 고쳐진 제품을 실패로 잡았다.
    //   느슨해지지 않도록 조건을 **추가**한다: ① 'running' 잔여가 하나도 없어야 한다(원래 계약)
    //   ② 사용자가 중단하지 않았으므로 'cancelled' 로 오분류돼서도 안 된다.
    check('PS4', "재시작하면 'running' 잔여가 'interrupted'(이어가기 가능)로 정리되고, 사용자 중단과 혼동되지 않는다",
      runningBefore > 0 && runB?.status === 'interrupted'
        && (after.runs ?? []).every((r) => r.status !== 'running')
        && (after.runs ?? []).every((r) => r.status !== 'cancelled'),
      `종료 전 running ${runningBefore}건(0 이면 빈 검사) · B 작업 상태=${runB?.status}(interrupted 여야)`
      + ` · 재시작 후 전체 상태: ${(after.runs ?? []).map((r) => r.status).join(', ') || '(없음)'}`
      + ` (running 잔여 0 · cancelled 오분류 0 이어야)`)

    // ===== PS3: 상한 =====
    {
      // 대화 상한 100개를 넘겨 본다(빠르게 저장만 한다).
      await evalIn(shell, `(async () => {
        for (let i = 0; i < 110; i++) {
          await window.browserAPI.ai.convSave({ id: 'bulk-' + i, messages: [
            { role: 'user', content: '대량 ' + i }, { role: 'assistant', content: 'ok' },
          ] })
        }
        return true
      })()`, true)
      await sleep(2000)
      const list = JSON.parse(await evalIn(shell,
        'window.browserAPI.ai.convList().then(l => JSON.stringify(l.map(c => c.title)))', true) ?? '[]')
      // 오래된 것부터 잘려야 한다 — 가장 처음 만든 '질문 1' 이 사라지고 최신 '대량 109' 는 남아야.
      const hasNewest = list.some((tt) => String(tt).includes('대량 109'))
      const oldGone = !list.some((tt) => String(tt).includes('질문 1'))
      check('PS3', '대화 상한(100개)을 넘기면 오래된 것부터 잘린다',
        list.length <= 100 && hasNewest && oldGone,
        `보관 ${list.length}개(100 이하) · 최신 보존=${hasNewest} · 오래된 것 제거=${oldGone}`)
    }

    // ===== PS7: 대화 하나 안의 메시지 상한(200) =====
    {
      await evalIn(shell, `(async () => {
        const msgs = []
        for (let i = 0; i < 250; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'm-' + i })
        await window.browserAPI.ai.convSave({ id: 'longconv', messages: msgs })
        return true
      })()`, true)
      await sleep(1200)
      const conv = JSON.parse(await evalIn(shell,
        `window.browserAPI.ai.convGet('longconv').then(c => JSON.stringify(c))`, true) ?? 'null')
      const msgs = conv?.messages ?? []
      const keptNewest = msgs.some((m) => m.content === 'm-249')
      const droppedOldest = !msgs.some((m) => m.content === 'm-0')
      check('PS7', '대화당 메시지 상한(200개)을 넘기면 최신 대화가 남는다',
        msgs.length === 200 && keptNewest && droppedOldest,
        `보관 ${msgs.length}개(200 이어야) · 최신 m-249 보존=${keptNewest} · 최초 m-0 제거=${droppedOldest}`)
    }

    // ===== PS6: 실행 이력 상한(50건) =====
    {
      // 실행 이력은 에이전트 이벤트로만 생긴다 → 끝까지 가는 짧은 작업을 여러 번 돌린다.
      // stagger 를 둬 동시 실행 수를 낮춘다(60개를 한꺼번에 던지면 관찰이 서로 밀린다).
      llm.setScript([{ reply: () => '{"action":"done","message":"cap ok"}' }])
      const windowId2 = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
      const capTabId = await evalIn(shell,
        `window.browserAPI.tabs.create(${JSON.stringify(windowId2)}, ${JSON.stringify(pages.url)}).then(t => t.id)`, true)
      await sleep(2000)
      for (let i = 0; i < 60; i++) {
        await evalIn(shell, `window.browserAPI.ai.agentStart(${JSON.stringify({
          reqId: `cap-${i}`, tabId: capTabId, task: `상한 시험 ${i}`,
        })})`, true)
        await sleep(80)
      }
      await sleep(6000)
      const runs = JSON.parse(await evalIn(shell,
        'window.browserAPI.ai.runList().then(l => JSON.stringify(l.map(r => r.task)))', true) ?? '[]')
      const hasNewest = runs.some((t) => String(t) === '상한 시험 59')
      const oldGone = !runs.some((t) => String(t).includes('작업 A'))
      check('PS6', '실행 이력 상한(50건)을 넘기면 최신이 남고 오래된 것이 잘린다',
        runs.length <= 50 && hasNewest && oldGone,
        `보관 ${runs.length}건(50 이하) · 최신 "상한 시험 59" 보존=${hasNewest} · 최초 "작업 A" 제거=${oldGone}`)

      // ===== PS8: **한 실행 안의** 단계 상한(120) =====
      //
      // PS6 은 "실행이 몇 건" 을 보고 PS7 은 "대화 하나에 메시지 몇 개" 를 본다.
      // 남아 있던 구멍은 "실행 하나에 단계 몇 개" 다 — 긴 작업이 파일을 무한히 불리는 축이다.
      //
      // 어떻게 120 을 넘기나: 루프 한 바퀴가 관찰·생각·행동·결과 **4단계**를 남긴다.
      // 막힘 감지는 click/type/navigate/click_at 에만 걸리므로(agent.ts) 같은 동작을 반복해도
      // 묻지 않는 `scroll` 을 쓴다. 45바퀴면 최소 135단계(생각이 빠져도) 로 상한을 확실히 넘는다.
      {
        const MAX_STEPS = 120
        const LOOPS = 45
        // 루프 상한은 설정에서 온다(agent.ts: 6~80 으로 clamp). 이 검사만을 위해 올린다 — 마지막 검사다.
        await evalIn(shell, `window.browserAPI.settings.set('ai.agentMaxSteps', ${LOOPS + 5})`, true)
        llm.setScript([{
          reply: (c) => (c.n < LOOPS
            ? JSON.stringify({ action: 'scroll', direction: 'down', thought: `단계표식 ${c.n}` })
            : JSON.stringify({ action: 'done', message: '상한 시험 종료' })),
        }])
        const windowId3 = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
        const longTabId = await evalIn(shell,
          `window.browserAPI.tabs.create(${JSON.stringify(windowId3)}, ${JSON.stringify(pages.url)}).then(t => t.id)`, true)
        await sleep(2000)
        await evalIn(shell, `window.browserAPI.ai.agentStart(${JSON.stringify({
          reqId: 'stepcap', tabId: longTabId, task: '단계 상한 시험',
        })})`, true)

        // 고정 대기가 아니라 **끝날 때까지** 기다린다(머신 속도에 따라 수십 초).
        const startedAt = Date.now()
        let detail = null
        while (Date.now() - startedAt < 180_000) {
          await sleep(1500)
          detail = JSON.parse(await evalIn(shell,
            `window.browserAPI.ai.runGet('stepcap').then(r => JSON.stringify(r))`, true) ?? 'null')
          if (detail && detail.status !== 'running') break
        }
        const steps = detail?.steps ?? []
        const texts = steps.map((s) => String(s.text))
        // 상한을 정확히 지키는가(경계값). 넘치면 파일이 무한히 커지고, 모자라면 너무 일찍 버린 것이다.
        const exactCap = steps.length === MAX_STEPS
        // 최신은 남아야 한다 — 특히 **마지막 종료 마커**(사용자가 결과를 보는 단계).
        const lastText = texts[texts.length - 1] ?? ''
        const keptNewest = lastText.includes('상한 시험 종료') && texts.includes(`단계표식 ${LOOPS - 1}`)
        // 오래된 것은 버려야 한다. 부분 일치는 '단계표식 1' 이 '단계표식 10' 에 걸리므로 **완전 일치**로 본다.
        const droppedOldest = !texts.includes('단계표식 0')
        check('PS8', '한 실행의 단계 상한(120개) — 최신(종료 마커 포함)이 남고 오래된 단계가 잘린다',
          exactCap && keptNewest && droppedOldest && detail?.status === 'done',
          `기록 ${steps.length}단계(${MAX_STEPS} 이어야) · 상태=${detail?.status ?? '(없음)'}`
          + ` · 마지막 단계="${lastText.slice(0, 40)}" · 최신 표식 ${LOOPS - 1} 보존=${texts.includes(`단계표식 ${LOOPS - 1}`)}`
          + ` · 최초 표식 0 제거=${droppedOldest} · 남은 표식 ${texts.filter((t) => t.startsWith('단계표식')).length}개`
          + ` (총 ${LOOPS}개 중) · 소요 ${Math.round((Date.now() - startedAt) / 1000)}초`)
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // PS9~PS12 (2026-09-15, 묶음 A) — 저장 신뢰성: 경합 · 손상 복구
    // 여기부터는 앱을 껐다 켜며 **저장 파일 자체**를 다룬다. 파일 조작은 반드시 앱이 죽은 뒤에.
    // ════════════════════════════════════════════════════════════════════════

    // 큰 페이로드(수 MB)를 보내는 evaluate 는 기본 15초 안에 못 끝난다 — 이 블록 전용 느린 호출.
    const evalSlow = async (expression, timeoutMs = 180_000) => {
      const r = await shell.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs)
      return r.result?.result?.value ?? r.result?.value
    }

    const chatFile = path.join(profileDir, 'ai-chats.json')
    const runFile = path.join(profileDir, 'ai-agent-runs.json')
    const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16)
    const hashOf = (p) => { try { return sha(fs.readFileSync(p)) } catch { return '(없음)' } }
    /** `<파일>.corrupt-<ISO시각>.bak` 백업 목록(이름에 시각이 들어 있어 사전순 = 시간순). */
    const backupsOf = (f) => {
      const base = path.basename(f)
      try {
        return fs.readdirSync(profileDir)
          .filter((n) => n.startsWith(base + '.corrupt-') && n.endsWith('.bak'))
          .sort()
          .map((n) => path.join(profileDir, n))
      } catch { return [] }
    }
    /** 두 저장소의 목록을 한 번에 읽는다(읽기만 — 정상 파일을 건드리지 않는 PS12 를 위해 저장은 안 한다). */
    const readBoth = async () => JSON.parse(await evalIn(shell, `(async () => JSON.stringify({
      convs: (await window.browserAPI.ai.convList()).map(c => c.title),
      runs: (await window.browserAPI.ai.runList()).map(r => r.task),
    }))()`, true) ?? '{}')

    // ===== PS9: 연속 갱신 → 즉시 종료 → 재시작 =====
    {
      // ① 파일을 수 MB 로 키운다 — 저장(쓰기)이 한순간에 끝나지 않아야 "쓰는 도중 들어온 변경" 이라는
      //    위험 구간이 실제로 생긴다. 상한(대화 100개·대화당 200메시지) 안에서 채운다.
      await evalSlow(`(async () => {
        const pad = 'x'.repeat(800)
        for (let i = 0; i < 50; i++) {
          const msgs = []
          for (let j = 0; j < 120; j++) msgs.push({ role: j % 2 ? 'assistant' : 'user', content: 'pad-' + i + '-' + j + '-' + pad })
          await window.browserAPI.ai.convSave({ id: 'big-' + i, messages: msgs })
        }
        return true
      })()`)
      await sleep(3000)   // 여기까지는 디스크에 안착시킨다(이후의 변경만 시험 대상)
      const bulkBytes = (() => { try { return fs.statSync(chatFile).size } catch { return 0 } })()

      // ② 마커 1 → 조용한 구간(디바운스 300ms 발화 → 저장이 큰 파일을 쓰는 중)
      //    → 그 구간에 마커 2~4 를 몰아넣고 → **디바운스가 끝나기 전에** 곧바로 정상 종료.
      //    이제 마지막 갱신을 지키는 것은 종료 flush 뿐이다.
      await evalIn(shell, `window.browserAPI.ai.convSave({ id: 'race-1', messages: [
        { role: 'user', content: '경합 마커 1' }, { role: 'assistant', content: 'ok' } ] })`, true)
      await sleep(320)
      await evalIn(shell, `(async () => {
        for (let i = 2; i <= 4; i++) {
          await window.browserAPI.ai.convSave({ id: 'race-' + i, messages: [
            { role: 'user', content: '경합 마커 ' + i }, { role: 'assistant', content: 'ok' } ] })
        }
        return true
      })()`, true)
      await sleep(120)    // 진행 중이던 저장이 끝날 시간만 주고(= 옛 코드가 dirty 를 끄는 순간), 디바운스 전에 종료
      await gracefulQuit()

      await boot('third')
      const titles = JSON.parse(await evalIn(shell,
        'window.browserAPI.ai.convList().then(l => JSON.stringify(l.map(c => c.title)))', true) ?? '[]')
      const missing = [1, 2, 3, 4].filter((i) => !titles.some((t) => String(t) === '경합 마커 ' + i))
      let parses = false
      try { JSON.parse(fs.readFileSync(chatFile, 'utf-8')); parses = true } catch { /* 잘린 채 남았다 */ }
      check('PS9', '연속 갱신 직후 종료해도 마지막 갱신까지 남는다',
        missing.length === 0 && parses,
        `마커 4개 중 ${4 - missing.length}개 보존`
        + (missing.length ? ` · 유실: ${missing.map((i) => '마커 ' + i).join(', ')}` : '')
        + ` · 파일 파싱 가능=${parses} · 파일 ${Math.round(bulkBytes / 1024)}KB · 대화 ${titles.length}개`)
    }

    // ===== PS10: 저장 파일이 통째로 깨진 경우 =====
    // 두 저장소 **모두** 본다 — agent-runs 쪽은 백업을 아예 안 만들어 손상본이 영구 소실되던 파일이다.
    const truncHash = {}
    {
      await gracefulQuit()
      // 정전·강제 종료로 쓰기가 끊긴 모습: 앞부분만 남은 잘린 JSON.
      for (const f of [chatFile, runFile]) {
        const buf = fs.readFileSync(f)
        const cut = buf.subarray(0, Math.max(16, Math.floor(buf.length * 0.4)))
        fs.writeFileSync(f, cut)
        truncHash[f] = sha(cut)
      }

      try {
        await boot('ps10a')
      } catch (err) {
        check('PS10', '저장 파일이 깨져도 앱이 뜨고 손상본이 백업된다', false, `앱이 뜨지 않음 — ${err.message}`)
        throw err
      }

      // 창이 떴고(=boot 성공) 새 저장이 되는가 — 손상 뒤에도 기능이 살아 있어야 한다.
      const saved = await evalIn(shell, `(async () => {
        await window.browserAPI.ai.convSave({ id: 'after-corrupt', messages: [
          { role: 'user', content: '손상 뒤 저장' }, { role: 'assistant', content: 'ok' } ] })
        const l = await window.browserAPI.ai.convList()
        await window.browserAPI.ai.runList()
        return l.some(c => String(c.title).indexOf('손상 뒤 저장') >= 0)
      })()`, true)

      const b = { chat: backupsOf(chatFile), run: backupsOf(runFile) }
      const chatOk = b.chat.length === 1 && hashOf(b.chat[0]) === truncHash[chatFile]
      const runOk = b.run.length === 1 && hashOf(b.run[0]) === truncHash[runFile]
      check('PS10', '저장 파일이 통째로 깨져도 앱이 뜨고, 손상본이 고유 이름으로 보존된다',
        saved === true && chatOk && runOk,
        `새 저장=${saved} · 대화 백업 ${b.chat.length}개(내용 일치=${chatOk})`
        + ` · 실행이력 백업 ${b.run.length}개(내용 일치=${runOk})`
        + ` · 예: ${b.chat[0] ? path.basename(b.chat[0]) : '(없음)'}`)
    }

    // ===== PS10B: 두 번째 손상 — 첫 백업을 덮어쓰지 않는다 =====
    {
      await gracefulQuit()
      const firstBackup = { chat: backupsOf(chatFile)[0], run: backupsOf(runFile)[0] }
      for (const f of [chatFile, runFile]) fs.writeFileSync(f, '{"두 번째 손상"')

      try {
        await boot('ps10b')
      } catch (err) {
        check('PS10B', '두 번째 손상이 나도 첫 백업을 덮어쓰지 않는다', false, `앱이 뜨지 않음 — ${err.message}`)
        throw err
      }
      await readBoth()  // 로드(=백업 생성)를 확실히 유도

      const b = { chat: backupsOf(chatFile), run: backupsOf(runFile) }
      // 첫 백업이 **그 자리에 그 내용 그대로** 있어야 한다(옛 고정 이름 `.corrupt.bak` 은 여기서 원본을 잃었다).
      const chatKept = b.chat.length === 2 && hashOf(firstBackup.chat) === truncHash[chatFile]
      const runKept = b.run.length === 2 && hashOf(firstBackup.run) === truncHash[runFile]
      check('PS10B', '두 번째 손상이 나도 첫 백업(원본)을 덮어쓰지 않는다',
        chatKept && runKept,
        `대화 백업 ${b.chat.length}개(첫 백업 내용 불변=${chatKept})`
        + ` · 실행이력 백업 ${b.run.length}개(첫 백업 내용 불변=${runKept})`)
    }

    // ===== PS11: 부분 손상 — 정상 항목은 살린다 =====
    {
      await gracefulQuit()
      const now = Date.now()
      const seedConv = (id, title, body) => ({
        id, title, createdAt: now, updatedAt: now,
        messages: [{ role: 'user', content: body }, { role: 'assistant', content: 'ok' }],
      })
      const seedRun = (id, task) => ({
        id, task, startedAt: now, endedAt: now, status: 'done',
        steps: [{ icon: '🏁', text: task + ' 완료', tone: 'ok' }],
      })
      // 정상 2개 + 망가진 2개(타입이 틀린 것·객체가 아닌 것)를 섞는다.
      fs.writeFileSync(chatFile, JSON.stringify({
        version: 1,
        conversations: [seedConv('keep-1', '유효 대화 1', '본문 1'), 42,
          seedConv('keep-2', '유효 대화 2', '본문 2'), { id: 5, messages: 'nope' }],
        folders: [],
      }))
      fs.writeFileSync(runFile, JSON.stringify({
        version: 1,
        runs: [seedRun('keep-r1', '유효 실행 1'), null,
          seedRun('keep-r2', '유효 실행 2'), { id: 'x', task: 7, steps: [] }],
      }))
      const backupsBefore = backupsOf(chatFile).length + backupsOf(runFile).length

      try {
        await boot('ps11')
      } catch (err) {
        check('PS11', '부분 손상 파일에서 정상 항목은 복구된다', false, `앱이 뜨지 않음 — ${err.message}`)
        throw err
      }
      const got = await readBoth()
      const convs = got.convs ?? []
      const runs = got.runs ?? []
      const convOk = convs.length === 2 && convs.includes('유효 대화 1') && convs.includes('유효 대화 2')
      const runOk = runs.length === 2 && runs.includes('유효 실행 1') && runs.includes('유효 실행 2')
      const backupsAfter = backupsOf(chatFile).length + backupsOf(runFile).length
      check('PS11', '일부 항목만 망가진 파일에서 정상 항목은 복구된다',
        convOk && runOk,
        `대화 ${convs.length}개(정상 2개 보존=${convOk}) · 실행이력 ${runs.length}개(정상 2개 보존=${runOk})`
        + ` · 버린 항목 보존 사본 ${backupsAfter - backupsBefore}개(참고 — 합격 조건 아님)`)
    }

    // ===== PS12: 정상 파일 무손실 (양성 대조) =====
    // 이 검사가 없으면 "언제나 백업하고 비우는" 구현도 PS10·PS11 을 통과해 버린다.
    {
      await gracefulQuit()
      const now = Date.now()
      const mk = (id, title) => ({
        id, title, createdAt: now, updatedAt: now,
        messages: [{ role: 'user', content: title }, { role: 'assistant', content: 'ok' }],
      })
      fs.writeFileSync(chatFile, JSON.stringify({
        version: 1, conversations: [mk('ok-1', '멀쩡한 대화 1'), mk('ok-2', '멀쩡한 대화 2')], folders: [],
      }))
      fs.writeFileSync(runFile, JSON.stringify({
        version: 1,
        runs: [
          { id: 'ok-r1', task: '멀쩡한 실행 1', startedAt: now, endedAt: now, status: 'done', steps: [] },
          { id: 'ok-r2', task: '멀쩡한 실행 2', startedAt: now, endedAt: now, status: 'done', steps: [] },
        ],
      }))
      const before = {
        backups: backupsOf(chatFile).length + backupsOf(runFile).length,
        chat: hashOf(chatFile), run: hashOf(runFile),
      }

      try {
        await boot('ps12')
      } catch (err) {
        check('PS12', '정상 파일은 건드리지 않는다', false, `앱이 뜨지 않음 — ${err.message}`)
        throw err
      }
      const got = await readBoth()   // 읽기만 한다 — 저장을 시키면 재기록되는 게 당연해져 검사가 무의미해진다
      const convs = got.convs ?? []
      const runs = got.runs ?? []
      const after = {
        backups: backupsOf(chatFile).length + backupsOf(runFile).length,
        chat: hashOf(chatFile), run: hashOf(runFile),
      }
      const noBackup = after.backups === before.backups
      const untouched = after.chat === before.chat && after.run === before.run
      const intact = convs.length === 2 && runs.length === 2
        && convs.includes('멀쩡한 대화 1') && runs.includes('멀쩡한 실행 2')
      check('PS12', '정상 파일은 백업도 재기록도 없이 그대로 읽힌다(양성 대조)',
        noBackup && untouched && intact,
        `새 백업 ${after.backups - before.backups}개(0 이어야) · 파일 바이트 불변=${untouched}`
        + ` · 대화 ${convs.length}개 · 실행이력 ${runs.length}개 · 내용 온전=${intact}`)
    }
  } catch (err) {
    check('FATAL', '하네스 실행', false, err.message)
  } finally {
    try { shell?.close() } catch { /* ignore */ }
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {}); b.close()
    } catch { /* ignore */ }
    await sleep(1500)
    try { child?.kill() } catch { /* ignore */ }
    await pages.close()
    await llm.close()
  }

  fs.writeFileSync(path.join(args.out, 'ai-persist-results.json'), JSON.stringify(results, null, 2))
  console.log('\n===== verify-ai-persist 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL')
  console.log(`PASS=${results.length - fail.length} FAIL=${fail.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
