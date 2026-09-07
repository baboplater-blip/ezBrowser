#!/usr/bin/env node
// verify-agent-loop-cdp.mjs — 에이전트 루프 e2e (관찰→판단→실행), 모델 없이 결정론적으로
//
// 왜 (2026-09-07, 임무 26): 에이전트의 판정 함수는 임무 24 에서 검사를 붙였지만, **루프 자체**
// (관찰한 것을 실제로 클릭하는가 / 확인을 거부하면 정말 실행되지 않는가 / 질문에 답하면 이어가는가)
// 는 상설 검사가 없었다. 예전 라운드들의 e2e 는 실제 Ollama 모델에 의존해 **모델이 없으면 못 돌고
// 같은 입력에도 답이 달라져** 남길 수가 없었다.
//
// 그래서 각본대로만 답하는 가짜 LLM 서버를 두고 앱의 `ai.ollamaUrl` 을 거기로 돌린다.
// 모델 설치 없이, 매번 같은 결과로 루프 전체를 본다.
//
//   L1 관찰한 요소를 실제로 클릭해 페이지 상태를 바꾸는가
//   L2 결제 버튼 클릭 시 확인을 요구하고, **거부하면 실행되지 않는가**   ← 가장 중요
//   L3 승인하면 실행되는가
//   L4 ask 로 물으면 답을 받아 이어가는가
//   L5 done 으로 정상 종료하는가
//   L6 무인 배치(autoConfirm)에서도 critical 은 자동 승인되지 않는가
//
// 사용: node build/verify-agent-loop-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, getTargetList, waitForPortFree, connectShellSessionReady, ensureSessionReady } from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9260, llmPort: 11500, pagePort: 8791, out: path.join(REPO, 'verify-out', 'agent-loop') }
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

// ===== 시험용 페이지 =====
const PAGE = `<!doctype html><meta charset="utf-8"><title>에이전트 시험</title>
<body style="font:16px system-ui;padding:40px">
<h1>에이전트 시험 페이지</h1>
<button id="ok">확인</button>
<button id="pay">결제하기</button>
<p id="state">대기</p>
<script>
  window.__clicked = false; window.__paid = false;
  document.getElementById('ok').onclick = () => { window.__clicked = true; document.getElementById('state').textContent = '눌림' }
  document.getElementById('pay').onclick = () => { window.__paid = true; document.getElementById('state').textContent = '결제됨' }
</script></body>`

function startPageServer(port) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
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

const evalIn = async (s, expression, awaitPromise = false) => {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  return r.result?.result?.value ?? r.result?.value
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE}`)
  fs.mkdirSync(args.out, { recursive: true })
  await waitForPortFree(args.port)

  const llm = await startFakeLlm({ port: args.llmPort })
  const pages = await startPageServer(args.pagePort)

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true },
    startup: { mode: 'newtab', urls: [] },
    adblock: { enabled: false },
    ai: {
      enabled: true,
      provider: 'ollama',
      ollamaUrl: llm.url,
      // 허용목록에 없는 이름 → 네이티브 도구 대신 JSON 액션 경로(결정론적)로 간다.
      ollamaModel: 'test-model',
      agentMaxSteps: 8,
      agentAutoApprove: false,
      agentVision: 'off',
      agentHumanInput: false,   // 시험에서는 빠른 합성 입력으로 충분하다
    },
  }, null, 2))

  const logStream = fs.createWriteStream(path.join(args.out, 'app.log'))
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')

    // 시험 페이지 탭
    const tabId = await evalIn(shell,
      `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pages.url)}).then(t => t.id)`, true)
    await sleep(2500)

    // 이벤트 수집기
    await evalIn(shell, 'window.__ev = []; window.browserAPI.ai.onAgentEvent((e) => window.__ev.push(e)); true')

    // 페이지 세션(상태 확인용)
    const pageTarget = (await getTargetList(args.port)).find((t) => String(t.url).startsWith(pages.url))
    if (!pageTarget) throw new Error('시험 페이지 타깃을 찾지 못함')
    const page = await connectSession(pageTarget, 'page')
    await ensureSessionReady(page)

    /** 한 시나리오 실행: 각본을 걸고 에이전트를 돌린 뒤 이벤트를 모은다. */
    async function run({ script, reqId, task, onConfirm, onAsk, rows, autoConfirm, timeoutMs = 30000 }) {
      llm.setScript(script)
      await evalIn(page, 'window.__clicked = false; window.__paid = false; true')
      await evalIn(shell, 'window.__ev = []; true')
      const startArgs = { reqId, tabId, task, ...(rows ? { rows, autoConfirm: !!autoConfirm } : {}) }
      await evalIn(shell, `window.browserAPI.ai.agentStart(${JSON.stringify(startArgs)})`, true)

      const deadline = Date.now() + timeoutMs
      let handledConfirm = false
      let handledAsk = false
      while (Date.now() < deadline) {
        const evs = await evalIn(shell, 'JSON.stringify(window.__ev)')
        const list = JSON.parse(evs ?? '[]')
        if (!handledConfirm && onConfirm && list.some((e) => e.type === 'confirm')) {
          handledConfirm = true
          await evalIn(shell, `window.browserAPI.ai.agentConfirm(${JSON.stringify(reqId)}, ${onConfirm === 'approve'})`, true)
        }
        if (!handledAsk && onAsk && list.some((e) => e.type === 'ask')) {
          handledAsk = true
          await evalIn(shell, `window.browserAPI.ai.agentReply(${JSON.stringify(reqId)}, ${JSON.stringify(onAsk)})`, true)
        }
        if (list.some((e) => e.type === 'done' || e.type === 'error' || e.type === 'cancelled')) break
        await sleep(400)
      }
      const evs = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ev)') ?? '[]')
      const state = {
        clicked: await evalIn(page, 'window.__clicked === true'),
        paid: await evalIn(page, 'window.__paid === true'),
      }
      return { evs, state, types: evs.map((e) => e.type) }
    }

    // 라벨을 못 찾으면 **관찰 원문을 남긴다** — 조용히 done 으로 끝나면 원인을 알 수 없다.
    const missed = []
    const clickByLabel = (label) => ({
      reply: (ctx) => {
        const ref = ctx.refFor(label)
        // ref 는 0 부터 시작한다 — `!ref` 로 검사하면 첫 요소를 "못 찾음" 으로 오판한다.
        if (ref === null || ref === undefined) {
          missed.push({ label, observation: String(ctx.lastUser).slice(0, 1200) })
          return JSON.stringify({ action: 'done', message: `${label} 를 찾지 못함(관찰 실패)` })
        }
        return JSON.stringify({ action: 'click', ref, thought: `${label} 누름` })
      },
    })
    const doneStep = { reply: () => JSON.stringify({ action: 'done', message: '완료' }) }

    // ---- L1: 관찰한 것을 실제로 클릭한다 ----
    {
      const r = await run({ reqId: 'L1', task: '확인 버튼을 눌러라', script: [clickByLabel('확인'), doneStep] })
      check('L1', '관찰한 요소를 실제로 클릭해 페이지가 바뀐다',
        r.state.clicked === true && r.types.includes('done'),
        `클릭됨=${r.state.clicked} · 이벤트 ${r.types.join('>')}`
        + (missed.length ? ` · 관찰에서 못 찾음(${missed[0].label}) 원문: ${missed[0].observation.replace(/\s+/g, ' ').slice(0, 400)}` : ''))
    }

    // ---- L2: 결제는 확인을 요구하고, 거부하면 실행되지 않는다 (가장 중요) ----
    {
      const r = await run({
        reqId: 'L2', task: '결제하기를 눌러라',
        script: [clickByLabel('결제하기'), doneStep], onConfirm: 'deny',
      })
      check('L2', '결제 클릭은 확인을 요구하고 거부하면 실행되지 않는다',
        r.types.includes('confirm') && r.state.paid === false,
        `확인요청=${r.types.includes('confirm')} · 결제실행=${r.state.paid}(false 여야 함) · ${r.types.join('>')}`)
    }

    // ---- L3: 승인하면 실행된다 ----
    {
      const r = await run({
        reqId: 'L3', task: '결제하기를 눌러라',
        script: [clickByLabel('결제하기'), doneStep], onConfirm: 'approve',
      })
      check('L3', '확인을 승인하면 그 동작이 실행된다',
        r.types.includes('confirm') && r.state.paid === true,
        `확인요청=${r.types.includes('confirm')} · 결제실행=${r.state.paid}(true 여야 함)`)
    }

    // ---- L4: ask 로 물으면 답을 받아 이어간다 ----
    {
      const script = [
        { reply: () => JSON.stringify({ action: 'ask', question: '어느 버튼을 누를까요?' }) },
        clickByLabel('확인'),
        doneStep,
      ]
      const r = await run({ reqId: 'L4', task: '무엇을 누를지 물어봐라', script, onAsk: '확인 버튼' })
      const gotAnswer = llm.requests.some((q) => String(q.lastUser).includes('확인 버튼'))
      check('L4', '질문에 답하면 그 답을 받아 작업을 이어간다',
        r.types.includes('ask') && gotAnswer && r.state.clicked === true,
        `질문=${r.types.includes('ask')} · 답 전달=${gotAnswer} · 이어서 클릭=${r.state.clicked}`)
    }

    // ---- L5: done 으로 종료하고 그 뒤 요청이 없다 ----
    {
      // setScript 가 카운터를 0 으로 되돌리므로 실행 후 절대값을 본다.
      const r = await run({ reqId: 'L5', task: '아무것도 하지 말고 끝내라', script: [doneStep] })
      await sleep(1200)
      const calls = llm.count
      check('L5', 'done 이면 즉시 끝나고 추가 호출이 없다',
        r.types.includes('done') && calls <= 2,
        `이벤트 ${r.types.join('>')} · LLM 호출 ${calls}회`)
    }

    // ---- L6: 무인 배치에서도 critical 은 자동 승인되지 않는다 ----
    {
      const r = await run({
        reqId: 'L6', task: '결제하기를 눌러라',
        script: [clickByLabel('결제하기'), doneStep],
        rows: [{ 값: '1' }], autoConfirm: true, timeoutMs: 25000,
      })
      // 자동 승인되면 paid=true 가 된다 — 그 일이 없어야 한다.
      check('L6', '무인 자동승인이어도 결제는 자동 실행되지 않는다',
        r.state.paid === false,
        `결제실행=${r.state.paid}(false 여야 함) · 이벤트 ${r.types.slice(0, 8).join('>')}`)
    }

    try { page.close() } catch { /* ignore */ }
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
    try { child.kill() } catch { /* ignore */ }
    await llm.close()
    await pages.close()
  }

  fs.writeFileSync(path.join(args.out, 'agent-loop-results.json'), JSON.stringify(results, null, 2))
  console.log('\n===== verify-agent-loop 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL')
  console.log(`PASS=${results.length - fail.length} FAIL=${fail.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
