#!/usr/bin/env node
// verify-agent-repeat-cdp.mjs — 자동 반복 작업이 정해진 횟수만 돌고 중단이 먹는가
//
// 왜 (2026-09-07, 임무 32): 반복은 **사용자가 없을 때 같은 작업을 계속 돌리는** 장치다.
// 횟수 제한이 깨지면 영원히 돌고, 중단이 안 먹으면 멈출 방법이 없다. 게다가 계정 활동(게시 등)은
// 너무 잦으면 스팸으로 판정돼 계정이 정지된다 - 그래서 최소 간격이 강제된다(SEC-1).
// 그런데 이 셋 다 상설 검사가 없었다.
//
//   RP1 count=2 로 시작하면 즉시 1회 + 최소 간격 뒤 1회, 그 뒤 멈춘다
//   RP2 stop 하면 다음 실행이 오지 않는다
//   RP3 중단 뒤 새 반복은 정상 동작한다              ← 양성 대조
//   RP4 계정 활동(게시 등)은 최소 간격이 10분으로 강제된다
//
// 실행 판정은 **가짜 LLM 에 그 작업 지시가 몇 번 도착했는가**로 한다.
// 최소 간격이 60초라 RP1 은 약 70초 걸린다.
//
// 사용: node build/verify-agent-repeat-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, getTargetList, waitForPortFree, connectShellSessionReady, ensureSessionReady } from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { preferFreePort, getFreePorts } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9264, out: path.join(REPO, 'verify-out', 'agent-repeat') }
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

const PAGE = `<!doctype html><meta charset="utf-8"><title>반복 시험</title>
<body style="font:16px system-ui;padding:40px"><h1>반복 시험 페이지</h1><button id="ok">확인</button></body>`

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
  args.port = await preferFreePort(args.port, 'agent-repeat')
  await waitForPortFree(args.port)
  const [llmPort, pagePort] = await getFreePorts(2)

  // 반복이 돌면 에이전트는 곧바로 done 한다(부작용 없이 "돌았다" 만 확인).
  const llm = await startFakeLlm({
    port: llmPort,
    script: [{ reply: () => JSON.stringify({ action: 'done', message: '반복 작업 완료' }) }],
  })
  const pages = await startPageServer(pagePort)

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true },
    startup: { mode: 'newtab', urls: [] },
    adblock: { enabled: false },
    ai: { enabled: true, provider: 'ollama', ollamaUrl: llm.url, ollamaModel: 'test-model', agentVision: 'off', agentMaxSteps: 4 },
  }, null, 2))

  const logStream = fs.createWriteStream(path.join(args.out, 'app.log'))
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
    const tabId = await evalIn(shell,
      `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pages.url)}).then(t => t.id)`, true)
    await sleep(2500)

    const startRepeat = async (task, opts = {}) => JSON.parse(await evalIn(shell,
      `window.browserAPI.ai.repeatStart(${JSON.stringify({
        task, windowId, tabId, intervalMinutes: 1, count: 2, ...opts,
      })}).then(r => JSON.stringify(r))`, true) ?? '{}')
    const listRepeats = async () => JSON.parse(await evalIn(shell,
      'window.browserAPI.ai.repeatList().then(l => JSON.stringify(l))', true) ?? '[]')
    const stopRepeat = async (id) => evalIn(shell, `window.browserAPI.ai.repeatStop(${JSON.stringify(id)})`, true)
    const removeRepeat = async (id) => evalIn(shell, `window.browserAPI.ai.repeatRemove(${JSON.stringify(id)})`, true)
    const runs = (task) => llm.requests.filter((q) => JSON.stringify(q.messages).includes(task)).length

    // ---- RP4 먼저(즉시 확인 가능): 계정 활동은 최소 간격이 10분으로 올라간다 ----
    {
      const r = await startRepeat('인스타그램에 사진을 게시해라', { intervalMinutes: 1, count: 0 })
      const job = r?.job ?? {}
      const mins = Math.round((job.intervalMs ?? 0) / 60000)
      await stopRepeat(job.id); await removeRepeat(job.id)
      check('RP4', '게시 같은 계정 활동은 최소 간격이 10분으로 강제된다',
        (job.intervalMs ?? 0) >= 10 * 60000,
        `요청 1분 → 실제 ${mins}분(10분 이상이어야 함) · 총횟수 ${job.totalCount}(무제한 요청이 하루 상한으로 잘림)`)
    }

    // ---- RP2/RP3: 중단이 먹는가 + 그 뒤 새 반복은 정상인가 ----
    let stoppedTask = '중단시험작업'
    {
      const r = await startRepeat(stoppedTask)
      await sleep(4000)                       // 첫 실행은 즉시
      const afterFirst = runs(stoppedTask)
      await stopRepeat(r?.job?.id)
      await sleep(70000)                      // 최소 간격(60초) 을 넘겨 기다린다
      const afterWait = runs(stoppedTask)
      await removeRepeat(r?.job?.id)
      check('RP2', '중단하면 다음 실행이 오지 않는다',
        afterFirst >= 1 && afterWait === afterFirst,
        `첫 실행 ${afterFirst}회 → 70초 대기 후 ${afterWait}회(같아야 함)`)
    }

    // ---- RP1: count=2 면 두 번 돌고 멈춘다 ----
    {
      const task = '반복두번작업'
      const r = await startRepeat(task, { count: 2 })
      await sleep(4000)
      const first = runs(task)
      await sleep(70000)                      // 두 번째 실행이 오도록
      const second = runs(task)
      await sleep(70000)                      // 세 번째는 오면 안 된다
      const third = runs(task)
      const list = await listRepeats()
      const job = list.find((j) => j.id === r?.job?.id)
      await removeRepeat(r?.job?.id)
      check('RP1', 'count=2 면 두 번 돌고 더 돌지 않는다',
        first === 1 && second === 2 && third === 2,
        `실행 ${first} → ${second} → ${third}회(1→2→2 여야 함) · 상태=${job?.status ?? '(목록에서 사라짐=완료)'}`)
    }

    // ---- RP3 양성 대조: 위 중단·완료 뒤에도 새 반복은 정상 발화한다 ----
    {
      const task = '양성대조반복'
      const r = await startRepeat(task, { count: 1 })
      await sleep(4000)
      const n = runs(task)
      await removeRepeat(r?.job?.id)
      check('RP3', '중단·완료 뒤에도 새 반복은 정상 동작한다(양성 대조)', n >= 1,
        `실행 ${n}회 — 0 이면 위 RP1·RP2 는 "반복이 죽어서" 통과한 것이다`)
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
    try { child.kill() } catch { /* ignore */ }
    await llm.close()
    await pages.close()
  }

  fs.writeFileSync(path.join(args.out, 'agent-repeat-results.json'), JSON.stringify(results, null, 2))
  console.log('\n===== verify-agent-repeat 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL')
  console.log(`PASS=${results.length - fail.length} FAIL=${fail.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
