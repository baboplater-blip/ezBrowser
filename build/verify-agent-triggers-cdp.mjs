#!/usr/bin/env node
// verify-agent-triggers-cdp.mjs — AI 트리거(URL 진입)가 의도대로만 발화하는가
//
// 왜 (2026-09-07, 임무 28): 트리거는 **사용자가 없을 때 에이전트를 스스로 돌리는** 장치다.
// 잘못 발화하면 사용자가 보지 않는 사이 페이지를 조작하고, 발화가 반복되면 같은 작업이 계속 돈다.
// 그런데 상설 검사가 없었다.
//
//   T1 URL 진입 트리거가 실제로 발화한다(에이전트가 그 작업으로 돈다)
//   T2 60초 쿨다운 — 곧바로 다시 들어가도 두 번 돌지 않는다(에이전트 자체 이동에 의한 루프 방지)
//   T3 비활성 트리거는 발화하지 않는다
//   T4 삭제한 트리거는 발화하지 않는다
//
// 발화 판정은 **가짜 LLM 서버에 그 작업 지시가 도착했는지**로 한다 — 에이전트가 실제로 돌았다는 증거.
//
// 범위 밖: daily(벽시계 시각)·watch(30분 쿨다운)는 실시간으로 재현하기 어려워 이번 검사에 없다.
//
// 사용: node build/verify-agent-triggers-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, getTargetList, waitForPortFree, connectShellSessionReady, ensureSessionReady } from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9262, llmPort: 11502, pagePort: 8792, out: path.join(REPO, 'verify-out', 'agent-triggers') }
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

const PAGE = (title) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:16px system-ui;padding:40px"><h1>${title}</h1><button id="ok">확인</button></body>`

function startPageServer(port) {
  const server = http.createServer((req, res) => {
    const name = req.url.startsWith('/watch') ? '감시 페이지' : '보통 페이지'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE(name))
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${port}`,
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
  // 고정 포트가 앞선 실행의 잔재에 물려 있으면 빈 포트로 대체한다(실행이 통째로 죽지 않게).
  args.port = await preferFreePort(args.port, 'verify-agent-triggers-cdp.mjs')
  await waitForPortFree(args.port)
  // 우리가 여는 서버 포트는 **OS 에서 빈 것을 받아** 쓴다 - 고정 포트는 앞선 실행의 잔재와 충돌한다.
  ;[args.llmPort, args.pagePort] = await getFreePorts(2)

  // 트리거가 발화하면 에이전트는 곧바로 done 한다(부작용 없이 "돌았다" 만 확인).
  const llm = await startFakeLlm({
    port: args.llmPort,
    script: [{ reply: () => JSON.stringify({ action: 'done', message: '트리거 작업 완료' }) }],
  })
  const pages = await startPageServer(args.pagePort)

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

    // 트리거 API 는 browser:// 페이지의 internalAPI 에만 있다.
    await evalIn(shell,
      `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, 'browser://ai-triggers')`, true)
    const deadline = Date.now() + 15000
    let tgTarget = null
    while (Date.now() < deadline && !tgTarget) {
      tgTarget = (await getTargetList(args.port)).find((t) => String(t.url).startsWith('browser://ai-triggers')) ?? null
      if (!tgTarget) await sleep(300)
    }
    if (!tgTarget) throw new Error('browser://ai-triggers 타깃을 찾지 못함')
    const tg = await connectSession(tgTarget, 'triggers')
    await ensureSessionReady(tg)

    // 조작할 탭(여기로 이동시켜 트리거를 건드린다)
    const tabId = await evalIn(shell,
      `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pages.base + '/plain')}).then(t => t.id)`, true)
    await sleep(2000)

    const TASK = '트리거작업알파'
    const addTrigger = async (patch = {}) => evalIn(tg, `window.internalAPI.ai.triggerAdd(${JSON.stringify({
      name: '검증 트리거', type: 'url', enabled: true, task: TASK,
      urlPattern: `*://127.0.0.1:${args.pagePort}/watch*`, autoConfirm: false, notify: false, ...patch,
    })}).then(t => t && t.id)`, true)

    const navigate = async (p) => {
      await evalIn(shell, `window.browserAPI.tabs.navigate(${JSON.stringify(tabId)}, ${JSON.stringify(pages.base + p)})`, true)
      await sleep(3500)
    }
    /** 가짜 LLM 에 이 작업 지시가 몇 번 도착했는가 = 에이전트가 몇 번 돌았는가 */
    const fires = () => llm.requests.filter((q) => JSON.stringify(q.messages).includes(TASK)).length

    // ---- T1 발화 ----
    let id = null
    {
      id = await addTrigger()
      const before = fires()
      await navigate('/watch?1')
      const after = fires()
      check('T1', 'URL 진입 트리거가 실제로 발화한다', after > before,
        `발화 ${before}→${after}회 · 트리거 id=${String(id).slice(0, 8)}`)
    }

    // ---- T2 쿨다운 ----
    {
      const before = fires()
      await navigate('/plain')       // 벗어났다가
      await navigate('/watch?2')     // 다시 들어간다 — 60초 쿨다운이라 발화하면 안 된다
      const after = fires()
      check('T2', '60초 쿨다운 안에는 다시 발화하지 않는다', after === before,
        `발화 ${before}→${after}회(같아야 함)`)
    }

    // ---- T3 비활성 ----
    {
      await evalIn(tg, `window.internalAPI.ai.triggerSetEnabled(${JSON.stringify(id)}, false)`, true)
      // 쿨다운과 구분하기 위해 **새 트리거**(다른 id)를 비활성으로 추가해 시험한다.
      const id2 = await addTrigger({ enabled: false, name: '비활성 트리거' })
      const before = fires()
      await navigate('/plain')
      await navigate('/watch?3')
      const after = fires()
      check('T3', '비활성 트리거는 발화하지 않는다', after === before,
        `발화 ${before}→${after}회(같아야 함) · 비활성 id=${String(id2).slice(0, 8)}`)
      await evalIn(tg, `window.internalAPI.ai.triggerRemove(${JSON.stringify(id2)})`, true)
    }

    // ---- T4 삭제 ----
    {
      await evalIn(tg, `window.internalAPI.ai.triggerRemove(${JSON.stringify(id)})`, true)
      const list = JSON.parse(await evalIn(tg, 'window.internalAPI.ai.triggerList().then(l => JSON.stringify(l.length))', true) ?? '0')
      const before = fires()
      await navigate('/plain')
      await navigate('/watch?4')
      const after = fires()
      check('T4', '삭제한 트리거는 발화하지 않는다', after === before && list === 0,
        `발화 ${before}→${after}회(같아야 함) · 남은 트리거 ${list}개`)
    }

    // ---- T5 양성 대조: 위 T2~T4 의 "발화 안 함" 이 **기능이 죽어서**가 아님을 보인다 ----
    {
      const TASK2 = '트리거작업베타'
      await evalIn(tg, `window.internalAPI.ai.triggerAdd(${JSON.stringify({
        name: '양성 대조 트리거', type: 'url', enabled: true, task: TASK2,
        urlPattern: `*://127.0.0.1:${args.pagePort}/watch*`, autoConfirm: false, notify: false,
      })})`, true)
      const fires2 = () => llm.requests.filter((q) => JSON.stringify(q.messages).includes(TASK2)).length
      const before = fires2()
      await navigate('/plain')
      await navigate('/watch?5')
      const after = fires2()
      check('T5', '억제 검사 뒤에도 새 트리거는 정상 발화한다(양성 대조)', after > before,
        `발화 ${before}→${after}회 — 이것이 0 이면 위 T2~T4 는 "기능이 죽어서" 통과한 것이다`)
    }

    try { tg.close() } catch { /* ignore */ }
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

  fs.writeFileSync(path.join(args.out, 'agent-triggers-results.json'), JSON.stringify(results, null, 2))
  console.log('\n===== verify-agent-triggers 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL')
  console.log(`PASS=${results.length - fail.length} FAIL=${fail.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
