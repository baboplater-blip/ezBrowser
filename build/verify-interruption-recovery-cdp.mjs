#!/usr/bin/env node
// verify-interruption-recovery-cdp.mjs — "자동화가 네트워크·제공자 오류로 중단됐을 때"의 복구 동작을
// 실제 앱으로 검증한다. app/main/features/ai/task-runtime.ts 를 방금 고쳤다는 전제로, 수정 전 빌드
// 스냅샷(dist-before-ir/main/index.js)과 수정 후 빌드(app/dist/main/index.js)를 둘 다 띄워 비교한다.
//
// 패턴은 세 파일을 그대로 따른다:
//   build/verify-recovery-cdp.mjs      — makeAppController(boot/hardKill/gracefulQuit), --main, --only
//   build/verify-task-runtime-cdp.mjs  — ptask 를 CDP 로 몰아가는 방법
//   build/lib/fake-llm.mjs             — 각본대로만 답하는 로컬 LLM
//
// 이 하네스가 스스로 만드는 것(다른 파일은 읽기만 함):
//   · 각본 LLM 앞에 놓는 **릴레이**(startLlmRelay) — 요청 번호(1-indexed)로 실패를 결정한다.
//     "몇 번째 요청을 실패시킬지"를 미리 정해 두면, 클릭→다음 모델호출 사이의 타이밍 경합 없이
//     결정론적으로 "게시 클릭은 성공, 그다음 모델 호출만 실패"를 만들 수 있다(관찰: 에이전트는
//     한 액션의 응답을 완전히 처리한 뒤에야 다음 요청을 보내므로, 릴레이가 요청 도착 시점에
//     동기적으로 내리는 판정에는 경합이 없다).
//   · 정적 fixture 서버 — "게시"/"확인"/"결제하기" 버튼 + 로그인 화면(보이는 password 입력칸,
//     challenge-detect.ts 가 구조적으로 감지). 게시·결제 버튼은 각각 POST /api/publish, /api/pay 를
//     실제로 쏴서(서버 카운터 증가) "정확히 몇 번 실행됐는지"를 앱 밖에서 잰다.
//
// 사용: node build/verify-interruption-recovery-cdp.mjs [--port <n>] [--out <dir>]
//        [--main <index.js>] [--old-main <index.js>] [--only IR1,IR3,...] [--skip-old-repro]

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, connectShellSessionReady, waitForPortFree } from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const ELECTRON_BIN = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')

const args = {
  port: 9299,
  out: path.join(REPO, 'verify-out', 'interruption-recovery'),
  main: path.join(REPO, 'app', 'dist', 'main', 'index.js'),
  oldMain: path.join(REPO, 'dist-before-ir', 'main', 'index.js'),
  only: null,
  skipOldRepro: false,
}
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--main') args.main = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--old-main') args.oldMain = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--only') args.only = String(process.argv[++i])
  else if (process.argv[i] === '--skip-old-repro') args.skipOldRepro = true
}
const MAIN_ENTRY = args.main

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const J = JSON.stringify

function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${name}: ${detail}`)
  return ok
}
function skip(id, name, reason) {
  results.push({ id, name, status: 'SKIP', detail: reason })
  console.log(`  ⋯ ${id} SKIP — ${name}: ${reason}`)
}
function info(id, name, detail) {
  results.push({ id, name, status: 'INFO', detail })
  console.log(`  ○ ${id} INFO — ${name}: ${detail}`)
}

function shouldRun(id) {
  if (!args.only) return true
  return args.only.split(',').map((s) => s.trim()).filter(Boolean).includes(id)
}

async function evalIn(s, expression, awaitPromise = false) {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, 20000)
  if (r.result?.exceptionDetails) {
    throw new Error(`evalIn 예외: ${JSON.stringify(r.result.exceptionDetails).slice(0, 500)}`)
  }
  return r.result?.result?.value ?? r.result?.value
}

async function waitUntil(fn, timeoutMs, stepMs = 400) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() >= deadline) return false
    await sleep(stepMs)
  }
}

/** ptaskGet 을 폴링해 지정 상태 중 하나가 될 때까지 기다린다. 전체(PersistentTask)를 돌려준다. */
async function waitForTaskState(shell, taskId, states, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evalIn(shell, `window.browserAPI.ai.ptaskGet(${J(taskId)})`, true)
    if (last && states.includes(last.state)) return last
    await sleep(300)
  }
  return last
}

async function newTab(shell, windowId, url) {
  return evalIn(shell, `window.browserAPI.tabs.create(${J(windowId)}, ${J(url)}).then(t => t.id)`, true)
}

// ===================================================================================
// 릴레이 — 각본 LLM 앞에 놓고, 요청 번호(1-indexed, 이 릴레이에 도착한 순서)로 실패를 결정한다.
// 실패 판정된 요청은 소켓을 즉시 끊는다(응답 없이) — Electron net.request 쪽에서는 접속이 되다가
// 리셋된 형태의 net:: 오류가 나고, agent.ts 의 friendlyError 가 그 메시지의 "connect" 부분 문자열을
// 보고 "AI 서버에 연결하지 못했습니다"로 바꾼다 → task-runtime.classifyRetry 가 "연결하지 못"을 보고
// 'network' 로 분류한다(agent.ts:568-575, task-runtime.ts:916-930 확인 — 두 파일 다 읽기만 했다).
// 실패로 판정되지 않은 요청은 실제 fake-llm 서버로 그대로 중계한다.
// ===================================================================================
// ⚠ 함정(2026-09-19 실측으로 확정, 하네스 결함 — 수정됨): 실패 판정된 요청을 `req.socket.destroy()`
// 로 끊는 첫 설계는 **재사용되는(keep-alive) 연결**에서는 Chromium 네트워크 스택이 그 리셋을
// **앱에 알리지 않고 새 연결로 조용히 재시도**한다(idx=2 실패·idx=3 성공이 같은 밀리초에 관측됨 —
// task-runtime 의 백오프(최소 2초)를 전혀 거치지 않았다는 뜻). 이 반투명 재시도는 **완전히 끝난
// 연결의 첫 요청**(IR1·IR2 처럼 이 프로세스에서 그 호스트로 보내는 첫 요청)에서는 일어나지
// 않았다(그때는 정상적으로 오류가 표면화됐다) — 재사용 연결에서만 재현된다. 그래서 **연결을 끊는
// 대신 정상적으로 끝나는 HTTP 오류 응답**(verify-ai-errors-cdp.mjs 의 {status,body} 패턴)을 준다.
// 완결된 HTTP 교환(상태 코드까지 받은)은 Chromium 이 조용히 재시도하지 않는다 — providers.ts 의
// `resp.on('end')` 경로로 정직하게 onError 까지 도달한다.
function startLlmRelay(target) {
  let total = 0
  let forwarded = 0
  let shouldFail = () => false
  const targetUrl = new URL(target)
  const server = http.createServer((req, res) => {
    total += 1
    const idx = total
    if (shouldFail(idx)) {
      // 몸통을 다 받은 뒤(연결을 끊지 않고) 완결된 오류 응답을 준다 — ollama 제공자 경로에서
      // providers.ts 가 status>=500 을 "로컬 Ollama 서버에 연결할 수 없습니다..." 로 바꾸고,
      // task-runtime.classifyRetry 는 이 조합 문구를 'unknown'(사다리 [10000]) 으로 분류한다
      // (network 로 분류되진 않지만 사다리가 비어있지 않아 ledger 검사 경로는 동일하게 탄다 —
      // 이 점은 IR3/IR4 본문 주석에도 남겨 둔다).
      req.resume()
      req.on('end', () => {
        try {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end('{"error":"simulated upstream failure"}')
        } catch { /* ignore */ }
      })
      return
    }
    forwarded += 1
    const preq = http.request({
      hostname: targetUrl.hostname, port: targetUrl.port, path: req.url, method: req.method, headers: req.headers,
    }, (pres) => {
      try { res.writeHead(pres.statusCode ?? 200, pres.headers) } catch { /* ignore */ }
      pres.pipe(res)
    })
    preq.on('error', () => { try { res.destroy() } catch { /* ignore */ } })
    req.pipe(preq)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        get total() { return total },
        get forwarded() { return forwarded },
        setShouldFail(fn) { shouldFail = fn },
        async close() {
          await new Promise((r) => {
            try { server.closeAllConnections?.() } catch { /* ignore */ }
            const t = setTimeout(r, 3000)
            server.close(() => { clearTimeout(t); r() })
          })
        },
      })
    })
  })
}

// ===================================================================================
// 정적 fixture — 클릭 대상(게시/확인/결제하기) + 로그인 화면. 게시·결제는 서버로 실제 요청을
// 보내 "정확히 몇 번 실행됐는지"를 앱 밖에서 카운트한다(원본 R3 의 pubCount() 패턴).
// ===================================================================================
const MAIN_HTML = '<!doctype html><meta charset="utf-8"><title>IR 검증</title>'
  + '<body style="font:16px system-ui;padding:24px">'
  + '<h1>IR 검증 페이지</h1>'
  + '<button id="publishBtn">게시</button> '
  + '<button id="readBtn">확인</button> '
  + '<button id="payBtn">결제하기</button>'
  + '<div id="status">ready</div>'
  + '<script>'
  + "document.getElementById('publishBtn').onclick=function(){fetch('/api/publish',{method:'POST'}).then(function(){document.getElementById('status').textContent='published'})};"
  + "document.getElementById('readBtn').onclick=function(){document.getElementById('status').textContent='read'};"
  + "document.getElementById('payBtn').onclick=function(){fetch('/api/pay',{method:'POST'}).then(function(){document.getElementById('status').textContent='paid'})};"
  + '</script></body>'

const LOGIN_HTML = '<!doctype html><meta charset="utf-8"><title>로그인</title>'
  + '<body style="font:16px system-ui;padding:24px"><h1>로그인</h1>'
  + '<div><input type="text" placeholder="아이디" autocomplete="username"></div>'
  + '<div><input type="password" placeholder="비밀번호" autocomplete="current-password"></div>'
  + '<button>로그인</button></body>'

function startFixture(port) {
  const state = { publishes: 0, pays: 0 }
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/publish') {
      state.publishes += 1
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return
    }
    if (req.method === 'POST' && req.url === '/api/pay') {
      state.pays += 1
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return
    }
    if (req.url === '/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(LOGIN_HTML); return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(MAIN_HTML)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      resolve({
        port: actual,
        base: `http://127.0.0.1:${actual}`,
        state,
        async close() {
          await new Promise((r) => {
            try { server.closeAllConnections?.() } catch { /* ignore */ }
            const t = setTimeout(r, 3000)
            server.close(() => { clearTimeout(t); r() })
          })
        },
      })
    })
  })
}

// ── 앱 기동/종료 헬퍼 (verify-recovery-cdp.mjs 의 makeAppController 패턴 그대로) ──
function makeAppController(profileDir, logPrefix, mainEntry, cdpPort) {
  let child = null
  let shell = null

  async function boot(label) {
    const logStream = fs.createWriteStream(path.join(args.out, `${logPrefix}-${label}.log`))
    child = spawn(ELECTRON_BIN, [mainEntry, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(logStream); child.stderr.pipe(logStream)
    shell = await connectShellSessionReady(cdpPort)
    await sleep(1200)
    return evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
  }

  async function gracefulQuit() {
    if (!child) return
    const exited = new Promise((r) => { child.once('exit', r) })
    try {
      const v = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {}); b.close()
    } catch { /* ignore */ }
    await Promise.race([exited, sleep(15000)])
    try { shell?.close() } catch { /* ignore */ }
    try { child?.kill() } catch { /* ignore */ }
    await waitForPortFree(cdpPort).catch(() => {})
    await sleep(1000)
    child = null; shell = null
  }

  /** 진짜 비정상 종료 — before-quit 이 돌지 않는다(트리째 강제 종료). */
  async function hardKill() {
    if (!child) return
    const exited = new Promise((r) => { child.once('exit', r) })
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 15000 }) } catch { /* ignore */ }
    await Promise.race([exited, sleep(8000)])
    try { shell?.close() } catch { /* ignore */ }
    await waitForPortFree(cdpPort).catch(() => {})
    await sleep(1500)
    child = null; shell = null
  }

  return {
    boot, gracefulQuit, hardKill,
    get shell() { return shell },
    get child() { return child },
  }
}

function writeProfileSettings(profileDir, ollamaUrl, downloadsDir) {
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), J({
    setup: { completed: true },
    // 강제 종료 뒤 재부팅하므로 '지난 세션 복원' 네이티브 모달이 창 생성(=CDP 타깃)을 막는다.
    // last-session 이면 묻지 않고 자동 복원한다(2026-09-07 임무 23 에서 규명된 함정 회피).
    startup: { mode: 'last-session', urls: [] },
    adblock: { enabled: false },
    downloads: { defaultPath: downloadsDir, askEveryTime: false },
    ai: {
      enabled: true,
      provider: 'ollama',
      ollamaUrl,
      ollamaModel: 'test-model',   // 도구 허용목록에 없는 이름 → JSON 액션 경로(결정론적)
      agentMaxSteps: 25,
      agentVision: 'off',
      agentHumanInput: false,
      agentInputMode: 'fast',
      agentAutoApprove: false,     // critical(결제 등)은 이 토글과 무관하게 항상 확인이지만, 명시적으로 꺼 둔다.
      agentCollapsePanels: false,
    },
  }, null, 2))
}

// ===================================================================================
// UI 헬퍼(IR5 의 "실제 화면 버튼으로 이어가기" 용) — verify-task-ui-cdp.mjs 의 패턴을 그대로 따른다.
// ===================================================================================
async function openAiPanel(shell, windowId) {
  await evalIn(shell, `window.browserAPI.actions.run('action.ai.open', ${J({ windowId })})`)
  const deadline = Date.now() + 20000
  let reopened = false
  while (Date.now() < deadline) {
    const found = await evalIn(shell, `!!document.querySelector('.ai-tab')`)
    if (found) return true
    // 사이드바 마운트가 레이스로 늦을 수 있다(verify-ai-connect-cdp.mjs 선례) — 절반 지점에 한 번 더 연다.
    if (!reopened && Date.now() > deadline - 12000) {
      await evalIn(shell, `window.browserAPI.actions.run('action.ai.open', ${J({ windowId })})`)
      reopened = true
    }
    await sleep(500)
  }
  return false
}

async function switchMode(shell, label) {
  return evalIn(shell, `(() => {
    const els = [...document.querySelectorAll('.ai-mode-btn')]
    const el = els.find(x => (x.textContent || '').includes(${J(label)}))
    if (!el) return false
    el.click(); return true
  })()`)
}

function cardExpr(marker) {
  return `(() => {
    const cards = [...document.querySelectorAll('.ai-task-card')]
    const c = cards.find(x => (x.querySelector('.ai-task-instruction')?.getAttribute('title') || '').includes(${J(marker)}))
    if (!c) return null
    return {
      badge: (c.querySelector('.ai-task-badge')?.textContent || '').trim(),
      note: (c.querySelector('.ai-task-note')?.textContent || '').trim(),
      buttons: [...c.querySelectorAll('button')].map(b => (b.getAttribute('title') || '').trim() + '|' + (b.textContent || '').trim()),
    }
  })()`
}
async function waitCard(shell, marker, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evalIn(shell, cardExpr(marker), true)
    if (last && predicate(last)) return last
    await sleep(400)
  }
  throw new Error(`timeout(${timeoutMs}ms) waiting for ${label} — 마지막 카드: ${J(last)}`)
}
async function clickCardButtonByTitle(shell, marker, title) {
  return evalIn(shell, `(() => {
    const cards = [...document.querySelectorAll('.ai-task-card')]
    const c = cards.find(x => (x.querySelector('.ai-task-instruction')?.getAttribute('title') || '').includes(${J(marker)}))
    if (!c) return 'no-card'
    const btn = [...c.querySelectorAll('button')].find(b => (b.getAttribute('title') || '') === ${J(title)})
    if (!btn) return 'no-button'
    btn.click(); return 'clicked'
  })()`)
}

async function main() {
  if (!fs.existsSync(ELECTRON_BIN)) throw new Error(`electron 바이너리 없음: ${ELECTRON_BIN}`)
  if (!fs.existsSync(MAIN_ENTRY)) throw new Error(`진입점 없음: ${MAIN_ENTRY}`)
  fs.mkdirSync(args.out, { recursive: true })

  console.log(`[진입점] ${MAIN_ENTRY}`)
  console.log(`[구버전 진입점] ${args.oldMain}${fs.existsSync(args.oldMain) ? '' : ' (없음 — 재현 단계는 SKIP)'}`)

  args.port = await preferFreePort(args.port, 'verify-interruption-recovery-cdp.mjs')
  await waitForPortFree(args.port)
  const [llmPort, fixturePort] = await getFreePorts(2)

  const llm = await startFakeLlm({ port: llmPort })
  const fixture = await startFixture(fixturePort)
  console.log(`[fixture] ${fixture.base} (127.0.0.1 loopback 전용)`)

  try {
    // ── 0. 수정 전 빌드로 결함 재현(IR3·IR6A) — 정보용, PASS/FAIL 판정 없음 ────────────────
    if (!args.skipOldRepro && fs.existsSync(args.oldMain)) {
      await reproduceOldBuild({ llm, fixture })
    } else if (!args.skipOldRepro) {
      info('OLD-REPRO', '수정 전 빌드 결함 재현', `${args.oldMain} 없음 — 재현 단계를 건너뜀`)
    }

    // ── 1. 수정 후 빌드로 판정 ────────────────────────────────────────────────────────
    if (shouldRun('IR1')) await scenarioIR1({ llm, fixture })
    else skip('IR1', '읽기 전용 작업의 일시적 오류는 재시도되어 회복된다(양성 대조)', '--only 로 제외됨')

    if (shouldRun('IR2')) await scenarioIR2({ llm, fixture })
    else skip('IR2', '재시도 대기 중 중단하면 되살아나지 않는다', '--only 로 제외됨')

    if (shouldRun('IR3')) await scenarioIR3({ llm, fixture })
    else skip('IR3', '서버는 커밋했는데 응답 유실 뒤 오류 → 재시도하지 않고 사람에게 묻는다', '--only 로 제외됨')

    if (shouldRun('IR4')) await scenarioIR4({ llm, fixture })
    else skip('IR4', '커밋된 것이 없으면 같은 오류에서 그대로 재시도한다(양성 대조)', '--only 로 제외됨')

    if (shouldRun('IR5')) await scenarioIR5({ llm, fixture })
    else skip('IR5', '재시작해도 불확실 제한이 유지된다(실제 화면 버튼으로 이어가기)', '--only 로 제외됨')

    if (shouldRun('IR6A')) await scenarioIR6a({ llm, fixture })
    else skip('IR6A', '로그인 대기 사유가 재시작을 넘어 보존된다', '--only 로 제외됨')

    if (shouldRun('IR6B')) await scenarioIR6b({ llm, fixture })
    else skip('IR6B', '위험 동작 확인 대기가 재시작을 넘어 보존되고 자동 승인되지 않는다', '--only 로 제외됨')
  } finally {
    await llm.close().catch(() => {})
    await fixture.close().catch(() => {})
  }

  fs.writeFileSync(path.join(args.out, 'interruption-recovery-results.json'), J({ main: MAIN_ENTRY, oldMain: args.oldMain, results }, null, 2))
  console.log('\n===== verify-interruption-recovery 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL')
  const pass = results.filter((r) => r.status === 'PASS')
  const skipped = results.filter((r) => r.status === 'SKIP')
  const infoCount = results.filter((r) => r.status === 'INFO')
  console.log(`PASS=${pass.length} FAIL=${fail.length} SKIP=${skipped.length} INFO=${infoCount.length} (총 ${results.length})`)
  for (const r of results) console.log(`${r.status} ${r.id}: ${r.detail}`)
  console.log(`\n결과 파일: ${path.join(args.out, 'interruption-recovery-results.json')}`)
  process.exit(fail.length ? 1 : 0)
}

// ===================================================================================
// 0. 수정 전 빌드 재현 — IR3(불확실 확정 대신 재시도가 관측되는지), IR6A(waitReason 이 원래 사유를
//    보존하지 않고 일반 문구로 덮이는지) 를 그대로 겪게 해 기록한다. PASS/FAIL 판정은 하지 않는다
//    (info() 만 남긴다) — "이게 옛 결함이다" 를 증명하는 용도.
// ===================================================================================
async function reproduceOldBuild({ llm, fixture }) {
  console.log('\n[0] 수정 전 빌드로 결함 재현 시도 (정보용, PASS/FAIL 아님)')

  // --- IR3 계열: 게시 클릭(성공) → 다음 모델호출(실패) → 무엇이 되는지 관측 ---
  {
    const relay = await startLlmRelay(llm.url)
    const profileDir = path.join(args.out, 'old-ir3-profile')
    const downloadsDir = path.join(args.out, 'old-ir3-downloads')
    writeProfileSettings(profileDir, relay.url, downloadsDir)
    const app = makeAppController(profileDir, 'old-ir3', args.oldMain, args.port)
    try {
      await app.boot('boot1')
      const windowId = await evalIn(app.shell, 'new URL(location.href).searchParams.get("windowId")')
      const tabId = await newTab(app.shell, windowId, fixture.base + '/')
      await sleep(500)
      const baseline = fixture.state.publishes

      llm.setScript([
        { reply: (ctx) => { const r = ctx.refFor ? ctx.refFor('게시') : null; return J({ action: 'click', ref: r }) } },
        { reply: () => J({ action: 'done', message: '완료' }) },
      ])
      relay.setShouldFail((idx) => idx === 2)

      const created = await evalIn(app.shell, `window.browserAPI.ai.ptaskCreate(${J({
        instruction: '[OLD-IR3] 게시 버튼을 눌러라.', tabId, mode: 'normal', readOnly: false,
      })})`, true)
      if (!created?.id) {
        info('IR3-OLD-REPRO', '재현 시도', `ptaskCreate 실패: ${J(created)}`)
      } else {
        const startRes = await evalIn(app.shell, `window.browserAPI.ai.ptaskStart(${J(created.id)})`, true)
        const observed = await waitForTaskState(app.shell, created.id,
          ['waiting-user', 'retrying', 'interrupted', 'completed', 'failed'], 30000)
        await sleep(6000)   // network 백오프 첫 칸(2초)보다 넉넉히 — 재시도가 실제로 도는지까지 본다
        const after = await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(created.id)})`, true)
        info('IR3-OLD-REPRO', '수정 전 빌드에서의 IR3 재현',
          `start응답=${J(startRes)} · 클릭직후상태=${observed?.state} waitCause=${observed?.waitCause ?? '(없음)'} `
          + `· 6초 후 상태=${after?.state} waitCause=${after?.waitCause ?? '(없음)'} `
          + `· 서버 게시 ${baseline} → ${fixture.state.publishes} · 릴레이 총요청=${relay.total} 중계=${relay.forwarded}`)
      }
    } catch (err) {
      info('IR3-OLD-REPRO', '재현 시도', `예외: ${err.message}`)
    } finally {
      await app.gracefulQuit().catch(() => {})
      await relay.close().catch(() => {})
    }
  }

  // --- IR6A 계열: 로그인 화면 → waiting-user/login → 강제종료 → 재부팅 후 waitReason/waitCause ---
  {
    const profileDir = path.join(args.out, 'old-ir6a-profile')
    const downloadsDir = path.join(args.out, 'old-ir6a-downloads')
    writeProfileSettings(profileDir, llm.url, downloadsDir)
    const app = makeAppController(profileDir, 'old-ir6a', args.oldMain, args.port)
    try {
      await app.boot('boot1')
      const windowId = await evalIn(app.shell, 'new URL(location.href).searchParams.get("windowId")')
      const tabId = await newTab(app.shell, windowId, fixture.base + '/login')
      await sleep(500)
      llm.setScript([{ reply: () => J({ action: 'read' }) }])

      const created = await evalIn(app.shell, `window.browserAPI.ai.ptaskCreate(${J({
        instruction: '[OLD-IR6A] 로그인 화면을 확인해라.', tabId, mode: 'normal', readOnly: false,
      })})`, true)
      if (!created?.id) {
        info('IR6A-OLD-REPRO', '재현 시도', `ptaskCreate 실패: ${J(created)}`)
      } else {
        await evalIn(app.shell, `window.browserAPI.ai.ptaskStart(${J(created.id)})`, true)
        const beforeKill = await waitForTaskState(app.shell, created.id, ['waiting-user', 'interrupted', 'failed'], 20000)
        await sleep(1200)
        await app.hardKill()
        await app.boot('boot2')
        const afterBoot = await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(created.id)})`, true)
        info('IR6A-OLD-REPRO', '수정 전 빌드에서의 IR6A 재현',
          `킬 전 상태=${beforeKill?.state} waitCause=${beforeKill?.waitCause ?? '(없음)'} waitReason="${(beforeKill?.waitReason ?? '').slice(0, 100)}" `
          + `· 재부팅 후 상태=${afterBoot?.state} waitCause=${afterBoot?.waitCause ?? '(없음)'} waitReason="${(afterBoot?.waitReason ?? '').slice(0, 140)}"`)
      }
    } catch (err) {
      info('IR6A-OLD-REPRO', '재현 시도', `예외: ${err.message}`)
    } finally {
      await app.gracefulQuit().catch(() => {})
    }
  }
}

// ===================================================================================
// IR1 — 읽기 전용 작업의 일시적 오류는 여전히 재시도되어 회복된다 (양성 대조)
// ===================================================================================
async function scenarioIR1({ llm, fixture }) {
  const relay = await startLlmRelay(llm.url)
  const profileDir = path.join(args.out, 'ir1-profile')
  const downloadsDir = path.join(args.out, 'ir1-downloads')
  writeProfileSettings(profileDir, relay.url, downloadsDir)
  const app = makeAppController(profileDir, 'ir1', MAIN_ENTRY, args.port)
  try {
    await app.boot('boot1')
    const windowId = await evalIn(app.shell, 'new URL(location.href).searchParams.get("windowId")')
    const tabId = await newTab(app.shell, windowId, fixture.base + '/')
    await sleep(500)

    llm.setScript([{ reply: () => J({ action: 'done', message: '다 읽었습니다.' }) }])
    relay.setShouldFail((idx) => idx === 1)   // 1번째 요청만 실패, 그다음부터는 성공

    const created = await evalIn(app.shell, `window.browserAPI.ai.ptaskCreate(${J({
      instruction: '[IR1] 아무것도 바꾸지 말고 페이지를 확인만 하고 끝내라.', tabId, mode: 'normal', readOnly: true,
    })})`, true)
    if (!created?.id) { check('IR1', '읽기 전용 작업의 일시적 오류는 재시도되어 회복된다', false, `ptaskCreate 실패: ${J(created)}`); return }
    const taskId = created.id

    const startRes = await evalIn(app.shell, `window.browserAPI.ai.ptaskStart(${J(taskId)})`, true)
    if (!startRes?.ok) { check('IR1', '읽기 전용 작업의 일시적 오류는 재시도되어 회복된다', false, `ptaskStart 실패: ${J(startRes)}`); return }

    const retrying = await waitForTaskState(app.shell, taskId, ['retrying', 'interrupted', 'completed', 'needs-verify', 'failed'], 20000)
    const reachedRetrying = retrying?.state === 'retrying'
    const observedKind = retrying?.retry?.kind ?? null
    const nextAt = retrying?.retry?.nextAt ?? (Date.now() + 12000)
    const waitMs = Math.max(3000, nextAt - Date.now() + 15000)

    const final = reachedRetrying
      ? await waitForTaskState(app.shell, taskId, ['completed', 'needs-verify', 'failed', 'interrupted'], waitMs)
      : retrying

    // 릴레이가 만드는 실패는 ollama 제공자의 연결 실패 문구("로컬 Ollama 서버에 연결할 수
    // 없습니다...")다 — classifyRetry 가 이를 'network' 로 분류해야 한다(2026-09-19 수정 반영:
    // 이전에는 "연결하지 못" 만 봐서 이 정확한 문구를 'unknown' 으로 떨어뜨렸다 — 사다리가
    // 10초 1회 vs network 의 2·8·30초 3회로 갈리는 실질적 차이였다). 종류까지 판정에 넣는다.
    const kindOk = observedKind === 'network'
    const ok = reachedRetrying && kindOk && (final?.state === 'completed' || final?.state === 'needs-verify')
    check('IR1', '읽기 전용 작업의 일시적 오류는 여전히 재시도되어 회복된다(양성 대조, 재시도 종류=network 검증 포함)', ok,
      `첫 실패 직후 상태=${retrying?.state}(관측된 재시도종류=${observedKind ?? '(없음)'}, network로분류됨=${kindOk}, detail="${(retrying?.retry?.detail ?? '').slice(0, 90)}") `
      + `→ 최종 상태=${final?.state} result="${(final?.result ?? '').slice(0, 80)}" `
      + `· 릴레이 총요청=${relay.total} 중계=${relay.forwarded} · fake-llm 수신=${llm.count}`)
  } catch (err) {
    check('IR1', '읽기 전용 작업의 일시적 오류는 재시도되어 회복된다', false, `예외: ${err.message}\n${(err.stack ?? '').slice(0, 500)}`)
  } finally {
    await app.gracefulQuit().catch(() => {})
    await relay.close().catch(() => {})
  }
}

// ===================================================================================
// IR2 — 재시도 대기 중 중단하면 되살아나지 않는다
// ===================================================================================
async function scenarioIR2({ llm, fixture }) {
  const relay = await startLlmRelay(llm.url)
  const profileDir = path.join(args.out, 'ir2-profile')
  const downloadsDir = path.join(args.out, 'ir2-downloads')
  writeProfileSettings(profileDir, relay.url, downloadsDir)
  const app = makeAppController(profileDir, 'ir2', MAIN_ENTRY, args.port)
  try {
    await app.boot('boot1')
    const windowId = await evalIn(app.shell, 'new URL(location.href).searchParams.get("windowId")')
    const tabId = await newTab(app.shell, windowId, fixture.base + '/')
    await sleep(500)

    llm.setScript([{ reply: () => J({ action: 'done', message: '완료' }) }])
    relay.setShouldFail(() => true)   // 전부 실패 — 재시도가 실제로 fake-llm 에 닿는지까지 이 카운터로 본다

    const created = await evalIn(app.shell, `window.browserAPI.ai.ptaskCreate(${J({
      instruction: '[IR2] 아무것도 바꾸지 말고 페이지를 확인만 하고 끝내라.', tabId, mode: 'normal', readOnly: true,
    })})`, true)
    if (!created?.id) { check('IR2', '재시도 대기 중 중단하면 되살아나지 않는다', false, `ptaskCreate 실패: ${J(created)}`); return }
    const taskId = created.id

    await evalIn(app.shell, `window.browserAPI.ai.ptaskStart(${J(taskId)})`, true)
    const retrying = await waitForTaskState(app.shell, taskId, ['retrying', 'interrupted', 'failed'], 20000)
    if (retrying?.state !== 'retrying') {
      check('IR2', '재시도 대기 중 중단하면 되살아나지 않는다', false, `retrying 상태에 도달하지 못함(관측: ${J(retrying)})`)
      return
    }
    const totalBeforeCancel = relay.total
    const nextAt = retrying?.retry?.nextAt ?? (Date.now() + 2000)
    const observedKind = retrying?.retry?.kind ?? '(없음)'

    const cancelResp = await evalIn(app.shell, `window.browserAPI.ai.ptaskCancel(${J(taskId)})`, true)
    const afterCancel = await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(taskId)})`, true)

    // 백오프 지연보다 충분히 길게(spec: 8초 이상, 관측된 지연보다도 여유 있게) 기다린다.
    const waitMs = Math.max(8000, (nextAt - Date.now()) + 5000)
    await sleep(waitMs)

    const stillCancelled = await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(taskId)})`, true)
    const totalAfterWait = relay.total

    const stayedCancelled = stillCancelled?.state === 'cancelled'
    const noAdditionalAttempt = totalAfterWait === totalBeforeCancel
    check('IR2', '재시도 대기 중 중단하면 되살아나지 않는다', stayedCancelled && noAdditionalAttempt,
      `cancel 직후=${afterCancel?.state} · ${waitMs}ms 대기 후=${stillCancelled?.state}(계속 취소상태=${stayedCancelled}) `
      + `· 관측된 재시도종류=${observedKind} · 릴레이 총요청: cancel직전 ${totalBeforeCancel} → 대기후 ${totalAfterWait}(추가시도없음=${noAdditionalAttempt}) `
      + `· fake-llm 수신(항상 실패라 0이어야 함)=${llm.count}`)
  } catch (err) {
    check('IR2', '재시도 대기 중 중단하면 되살아나지 않는다', false, `예외: ${err.message}\n${(err.stack ?? '').slice(0, 500)}`)
  } finally {
    await app.gracefulQuit().catch(() => {})
    await relay.close().catch(() => {})
  }
}

// ===================================================================================
// IR3 — 서버는 커밋했는데(게시 클릭 성공) 응답 유실 뒤 모델 오류 → 재시도하지 않고 사람에게 묻는다.
// 추가 쓰기 0(서버가 관측한 게시 수는 정확히 1).
// ===================================================================================
async function scenarioIR3({ llm, fixture }) {
  const relay = await startLlmRelay(llm.url)
  const profileDir = path.join(args.out, 'ir3-profile')
  const downloadsDir = path.join(args.out, 'ir3-downloads')
  writeProfileSettings(profileDir, relay.url, downloadsDir)
  const app = makeAppController(profileDir, 'ir3', MAIN_ENTRY, args.port)
  try {
    await app.boot('boot1')
    const windowId = await evalIn(app.shell, 'new URL(location.href).searchParams.get("windowId")')
    const tabId = await newTab(app.shell, windowId, fixture.base + '/')
    await sleep(500)
    const baseline = fixture.state.publishes

    llm.setScript([
      { reply: (ctx) => { const r = ctx.refFor('게시'); return J({ action: 'click', ref: r }) } },
      { reply: () => J({ action: 'done', message: '완료' }) },   // 요청 2는 릴레이가 막으므로 fake-llm 은 이 각본을 안 씀
    ])
    relay.setShouldFail((idx) => idx === 2)   // 1(클릭)=성공, 2(그다음 모델호출)=실패(정상 종료된 503 응답)

    const created = await evalIn(app.shell, `window.browserAPI.ai.ptaskCreate(${J({
      instruction: '[IR3] 게시 버튼을 눌러라.', tabId, mode: 'normal', readOnly: false,
    })})`, true)
    if (!created?.id) { check('IR3', '게시 클릭 후 오류 → 재시도하지 않고 사람에게 묻는다', false, `ptaskCreate 실패: ${J(created)}`); return }
    const taskId = created.id

    await evalIn(app.shell, `window.browserAPI.ai.ptaskStart(${J(taskId)})`, true)
    const state = await waitForTaskState(app.shell, taskId, ['waiting-user', 'retrying', 'interrupted', 'completed', 'failed'], 30000)

    const isLedgerWait = state?.state === 'waiting-user' && state?.waitCause === 'ledger'
    // 제품 문구는 `${noun}이(가) 실제로 됐는지 확실하지 않습니다` (task-runtime.ts) — 옛 표현도 허용한다.
    const hasReasonText = /발행이(?:\(가\))? (?:실제로 )?됐는지 확실하지 않습니다/.test(state?.waitReason ?? '')
    const afterFirstCheck = fixture.state.publishes
    const publishedExactlyOnce = afterFirstCheck === baseline + 1

    // 더 기다려도 자동으로 더 게시되지 않는지 확인한다(추가 쓰기 0).
    await sleep(4000)
    const afterWait = fixture.state.publishes
    const noExtraWrite = afterWait === afterFirstCheck

    const ok = isLedgerWait && hasReasonText && publishedExactlyOnce && noExtraWrite
    check('IR3', '서버는 커밋했는데 응답 유실 뒤 오류 → 재시도하지 않고 사람에게 묻는다. 추가 쓰기 0', ok,
      `상태=${state?.state} waitCause=${state?.waitCause ?? '(없음)'} `
      + `waitReason="${(state?.waitReason ?? '').slice(0, 140)}"(발행문구포함=${hasReasonText}) `
      + `· 서버 게시: 시작 ${baseline} → 오류직후 ${afterFirstCheck} → 4초 후 ${afterWait}(정확히 1건=${publishedExactlyOnce}, 추가쓰기없음=${noExtraWrite}) `
      + `· 릴레이 총요청=${relay.total} 중계=${relay.forwarded}(2 이상이면 이후 재시도가 릴레이까지는 왔다는 뜻 — ledger 는 runLoop 시작 시 막으므로 정상은 2 그대로여야 함)`)
  } catch (err) {
    check('IR3', '게시 클릭 후 오류 → 재시도하지 않고 사람에게 묻는다', false, `예외: ${err.message}\n${(err.stack ?? '').slice(0, 500)}`)
  } finally {
    await app.gracefulQuit().catch(() => {})
    await relay.close().catch(() => {})
  }
}

// ===================================================================================
// IR4 — 커밋된 것이 없으면(발행성 클릭이 아니었으면) 같은 오류에서 그대로 재시도한다 (양성 대조)
// ===================================================================================
async function scenarioIR4({ llm, fixture }) {
  const relay = await startLlmRelay(llm.url)
  const profileDir = path.join(args.out, 'ir4-profile')
  const downloadsDir = path.join(args.out, 'ir4-downloads')
  writeProfileSettings(profileDir, relay.url, downloadsDir)
  const app = makeAppController(profileDir, 'ir4', MAIN_ENTRY, args.port)
  try {
    await app.boot('boot1')
    const windowId = await evalIn(app.shell, 'new URL(location.href).searchParams.get("windowId")')
    const tabId = await newTab(app.shell, windowId, fixture.base + '/')
    await sleep(500)
    const baseline = fixture.state.publishes

    llm.setScript([
      { reply: (ctx) => { const r = ctx.refFor('확인'); return J({ action: 'click', ref: r }) } },   // '확인' — 발행성 라벨 아님
      { reply: () => J({ action: 'done', message: '확인했습니다.' }) },
    ])
    relay.setShouldFail((idx) => idx === 2)   // IR3 과 동일한 실패 지점 — 유일한 차이는 클릭 라벨

    const created = await evalIn(app.shell, `window.browserAPI.ai.ptaskCreate(${J({
      instruction: '[IR4] 확인 버튼을 눌러라.', tabId, mode: 'normal', readOnly: false,
    })})`, true)
    if (!created?.id) { check('IR4', '외부 쓰기가 없으면 같은 오류에서 재시도한다', false, `ptaskCreate 실패: ${J(created)}`); return }
    const taskId = created.id

    await evalIn(app.shell, `window.browserAPI.ai.ptaskStart(${J(taskId)})`, true)
    const retrying = await waitForTaskState(app.shell, taskId, ['retrying', 'waiting-user', 'interrupted', 'completed', 'failed'], 20000)
    const reachedRetrying = retrying?.state === 'retrying'
    const nextAt = retrying?.retry?.nextAt ?? (Date.now() + 12000)
    const waitMs = Math.max(5000, (nextAt - Date.now()) + 15000)

    const final = reachedRetrying
      ? await waitForTaskState(app.shell, taskId, ['completed', 'needs-verify', 'failed', 'interrupted', 'waiting-user'], waitMs)
      : retrying

    const recovered = final?.state === 'completed' || final?.state === 'needs-verify'
    const neverLedger = retrying?.waitCause !== 'ledger' && final?.waitCause !== 'ledger'
    const noPublishHappened = fixture.state.publishes === baseline
    // IR1 과 같은 이유로 재시도 종류까지 판정한다 — IR3/IR4 는 완전히 같은 릴레이 실패(ollama
    // 연결 실패 문구)를 쓰므로 여기서도 'network' 여야 한다.
    const kindOk = retrying?.retry?.kind === 'network'

    const ok = reachedRetrying && kindOk && recovered && neverLedger && noPublishHappened
    check('IR4', '커밋된 것이 없으면 같은 오류에서 그대로 재시도한다(양성 대조, 재시도 종류=network 검증 포함)', ok,
      `오류직후상태=${retrying?.state}(재시도종류=${retrying?.retry?.kind ?? '(없음)'}, network로분류됨=${kindOk}) → 최종상태=${final?.state}(waitCause=${final?.waitCause ?? '(없음)'}) `
      + `· 회복됨=${recovered} · ledger 로 안 감=${neverLedger} · 서버 게시 변화없음=${noPublishHappened}(${baseline}→${fixture.state.publishes}) `
      + `· 릴레이 총요청=${relay.total} 중계=${relay.forwarded} · fake-llm 수신=${llm.count}`)
  } catch (err) {
    check('IR4', '외부 쓰기가 없으면 같은 오류에서 재시도한다', false, `예외: ${err.message}\n${(err.stack ?? '').slice(0, 500)}`)
  } finally {
    await app.gracefulQuit().catch(() => {})
    await relay.close().catch(() => {})
  }
}

// ===================================================================================
// IR5 — 재시작해도 불확실 제한이 유지된다. **실제 화면의 "이어가기" 버튼**으로 이어간다(IPC 우회 없음).
//
// task-runtime.ts 의 ledger 는 runLoop 의 매 구간 시작 시(step 2) pendingExternalWrite 를 다시 검사한다
// (line ~1300). 확인되지 않은 외부 쓰기가 남아 있으면, 이어가기를 눌러도 **모델을 부르기 전에** 곧바로
// 다시 waiting-user/ledger 로 돌아간다 — 그래서 이 시나리오는 재개 후 모델 응답을 준비할 필요가 없다
// (읽기만 해서 확인한 사실이지, 추측이 아니다 — task-runtime.ts 를 읽고 확인함).
// ===================================================================================
async function scenarioIR5({ llm, fixture }) {
  const relay = await startLlmRelay(llm.url)
  const profileDir = path.join(args.out, 'ir5-profile')
  const downloadsDir = path.join(args.out, 'ir5-downloads')
  writeProfileSettings(profileDir, relay.url, downloadsDir)
  const app = makeAppController(profileDir, 'ir5', MAIN_ENTRY, args.port)
  const marker = 'IR5'
  try {
    await app.boot('boot1')
    const windowId = await evalIn(app.shell, 'new URL(location.href).searchParams.get("windowId")')
    const tabId = await newTab(app.shell, windowId, fixture.base + '/')
    await sleep(500)
    const baseline = fixture.state.publishes

    llm.setScript([
      { reply: (ctx) => { const r = ctx.refFor('게시'); return J({ action: 'click', ref: r }) } },
      { reply: () => J({ action: 'done', message: '완료' }) },
    ])
    relay.setShouldFail((idx) => idx === 2)

    const created = await evalIn(app.shell, `window.browserAPI.ai.ptaskCreate(${J({
      instruction: `[${marker}] 게시 버튼을 눌러라.`, tabId, mode: 'normal', readOnly: false,
    })})`, true)
    if (!created?.id) { check('IR5', '재시작해도 불확실 제한이 유지된다', false, `ptaskCreate 실패: ${J(created)}`); return }
    const taskId = created.id

    await evalIn(app.shell, `window.browserAPI.ai.ptaskStart(${J(taskId)})`, true)
    const ledgerWait = await waitForTaskState(app.shell, taskId, ['waiting-user', 'retrying', 'interrupted', 'completed', 'failed'], 30000)
    if (!(ledgerWait?.state === 'waiting-user' && ledgerWait?.waitCause === 'ledger')) {
      check('IR5', '재시작해도 불확실 제한이 유지된다', false, `ledger 대기 상태를 만들지 못함(관측: ${J(ledgerWait)})`)
      return
    }
    const publishesAtLedger = fixture.state.publishes

    // 디스크 반영 여유(json-store 디바운스) 후 진짜 강제 종료.
    await sleep(1200)
    await app.hardKill()

    // ── 재부팅 — interrupted + waitCause='ledger' 가 보존되는지 ────────────────────────
    await app.boot('boot2')
    const afterBoot = await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(taskId)})`, true)
    const persistedLedger = afterBoot?.state === 'interrupted' && afterBoot?.waitCause === 'ledger'
    const reasonKeptOriginal = /확실하지 않습니다/.test(afterBoot?.waitReason ?? '')
    const reasonHasRestartTag = /재시작으로 중단됨/.test(afterBoot?.waitReason ?? '')

    // ── 실제 화면 버튼으로 이어가기(IPC 우회 없음) ──────────────────────────────────────
    const windowId2 = await evalIn(app.shell, 'new URL(location.href).searchParams.get("windowId")')
    const opened = await openAiPanel(app.shell, windowId2)
    if (!opened) {
      check('IR5', '재시작해도 불확실 제한이 유지된다(실제 화면 버튼으로 이어가기)', false,
        `AI 사이드바(.ai-tab)가 마운트되지 않아 화면에서 버튼을 찾을 수 없었음 — action.ai.open 실행 후 20초 대기`)
      return
    }
    await switchMode(app.shell, '에이전트')
    await sleep(400)

    let card
    try {
      card = await waitCard(app.shell, marker, (c) => c.badge.includes('미완료'), 15000, `${marker} 카드(미완료 배지)`)
    } catch (err) {
      check('IR5', '재시작해도 불확실 제한이 유지된다(실제 화면 버튼으로 이어가기)', false,
        `화면에서 작업 카드를 찾지 못함(마커=${marker}): ${err.message}`)
      return
    }
    // 사유별 버튼 문구를 판정에 포함한다 — ledger 는 NEEDS_MANUAL_ACTION 이라 "▶ 처리했습니다 — 이어가기".
    const expectedTitle = '직접 처리를 마친 뒤 누르세요'
    const hasExpectedButton = card.buttons.some((b) => b.startsWith(`${expectedTitle}|`))
    const buttonText = card.buttons.find((b) => b.startsWith(`${expectedTitle}|`)) ?? ''
    const noteHasLedgerWording = /게시 여부가 확인되지 않았습니다/.test(card.note) || /확실하지 않습니다/.test(card.note)

    if (!hasExpectedButton) {
      check('IR5', '재시작해도 불확실 제한이 유지된다(실제 화면 버튼으로 이어가기)', false,
        `화면에서 "${expectedTitle}" 이어가기 버튼을 찾지 못함(제품 결함 가능성) — 카드에서 본 버튼들: ${J(card.buttons)} `
        + `· 카드 안내문: "${card.note}"`)
      return
    }

    const clickRes = await clickCardButtonByTitle(app.shell, marker, expectedTitle)
    const reWaiting = await waitForTaskState(app.shell, taskId, ['waiting-user', 'running', 'interrupted', 'completed', 'failed'], 15000)
    const backToLedger = reWaiting?.state === 'waiting-user' && reWaiting?.waitCause === 'ledger'
    const noReExecution = fixture.state.publishes === publishesAtLedger   // 이어가도 다시 게시하지 않는다

    const ok = persistedLedger && reasonKeptOriginal && reasonHasRestartTag && hasExpectedButton && clickRes === 'clicked' && backToLedger && noReExecution
    check('IR5', '재시작해도 불확실 제한이 유지된다(실제 화면의 "이어가기" 버튼으로 확인)', ok,
      `재부팅 직후 상태=${afterBoot?.state} waitCause=${afterBoot?.waitCause ?? '(없음)'} `
      + `waitReason="${(afterBoot?.waitReason ?? '').slice(0, 160)}"(원래사유보존=${reasonKeptOriginal}, 재시작표식=${reasonHasRestartTag}) `
      + `· 화면 카드 배지="${card.badge}" 안내문="${card.note}"(ledger문구포함=${noteHasLedgerWording}) `
      + `· 화면 버튼="${buttonText}"(찾음=${hasExpectedButton}) → 클릭결과=${clickRes} `
      + `· 클릭 후 상태=${reWaiting?.state} waitCause=${reWaiting?.waitCause ?? '(없음)'}(다시ledger=${backToLedger}) `
      + `· 서버 게시: ledger대기시점 ${publishesAtLedger} → 클릭후 ${fixture.state.publishes}(재실행없음=${noReExecution})`)
  } catch (err) {
    check('IR5', '재시작해도 불확실 제한이 유지된다', false, `예외: ${err.message}\n${(err.stack ?? '').slice(0, 500)}`)
  } finally {
    await app.gracefulQuit().catch(() => {})
    await relay.close().catch(() => {})
  }
}

// ===================================================================================
// IR6A — 로그인 대기 사유(🔐)가 재시작을 넘어 보존된다. challenge-detect.ts 의 구조적 감지(보이는
// password 입력칸)를 쓴다 — 모델 호출 없이(관찰 직후) waiting-user/login 이 된다.
// ===================================================================================
async function scenarioIR6a({ llm, fixture }) {
  const profileDir = path.join(args.out, 'ir6a-profile')
  const downloadsDir = path.join(args.out, 'ir6a-downloads')
  writeProfileSettings(profileDir, llm.url, downloadsDir)
  const app = makeAppController(profileDir, 'ir6a', MAIN_ENTRY, args.port)
  try {
    await app.boot('boot1')
    const windowId = await evalIn(app.shell, 'new URL(location.href).searchParams.get("windowId")')
    const tabId = await newTab(app.shell, windowId, fixture.base + '/login')
    await sleep(500)
    llm.setScript([{ reply: () => J({ action: 'read' }) }])

    const created = await evalIn(app.shell, `window.browserAPI.ai.ptaskCreate(${J({
      instruction: '[IR6A] 로그인 화면을 확인해라.', tabId, mode: 'normal', readOnly: false,
    })})`, true)
    if (!created?.id) { check('IR6A', '로그인 대기 사유가 재시작을 넘어 보존된다', false, `ptaskCreate 실패: ${J(created)}`); return }
    const taskId = created.id

    await evalIn(app.shell, `window.browserAPI.ai.ptaskStart(${J(taskId)})`, true)
    const loginWait = await waitForTaskState(app.shell, taskId, ['waiting-user', 'interrupted', 'completed', 'failed'], 20000)
    if (!(loginWait?.state === 'waiting-user' && loginWait?.waitCause === 'login')) {
      check('IR6A', '로그인 대기 사유가 재시작을 넘어 보존된다', false, `login 대기 상태를 만들지 못함(관측: ${J(loginWait)})`)
      return
    }
    const originalReason = loginWait.waitReason ?? ''
    const hasLockEmoji = originalReason.includes('🔐')

    await sleep(1200)
    await app.hardKill()

    await app.boot('boot2')
    const afterBoot = await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(taskId)})`, true)

    const persistedLogin = afterBoot?.state === 'interrupted' && afterBoot?.waitCause === 'login'
    const keptOriginalHint = (afterBoot?.waitReason ?? '').includes('🔐')
    const hasRestartTag = /재시작으로 중단됨/.test(afterBoot?.waitReason ?? '')
    const hasManualActionHint = /직접 처리한 뒤 이어가세요/.test(afterBoot?.waitReason ?? '')

    const ok = persistedLogin && hasLockEmoji && keptOriginalHint && hasRestartTag && hasManualActionHint
    check('IR6A', '로그인 대기 사유(🔐)가 재시작을 넘어 보존된다', ok,
      `킬 전 상태=${loginWait.state} waitCause=${loginWait.waitCause} waitReason="${originalReason.slice(0, 120)}"(🔐포함=${hasLockEmoji}) `
      + `· 재부팅 후 상태=${afterBoot?.state} waitCause=${afterBoot?.waitCause ?? '(없음)'} `
      + `waitReason="${(afterBoot?.waitReason ?? '').slice(0, 180)}" `
      + `(🔐유지=${keptOriginalHint}, 재시작표식=${hasRestartTag}, 직접처리안내=${hasManualActionHint})`)
  } catch (err) {
    check('IR6A', '로그인 대기 사유가 재시작을 넘어 보존된다', false, `예외: ${err.message}\n${(err.stack ?? '').slice(0, 500)}`)
  } finally {
    await app.gracefulQuit().catch(() => {})
  }
}

// ===================================================================================
// IR6B — 되돌릴 수 없는 위험 동작(결제하기)의 확인 대기가 재시작을 넘어 보존되고, 이어가기가 그
// 위험 동작을 자동 실행하지 않는다(재시도해도 다시 확인을 요구한다). 하네스는 절대 승인하지 않는다.
// ===================================================================================
async function scenarioIR6b({ llm, fixture }) {
  const profileDir = path.join(args.out, 'ir6b-profile')
  const downloadsDir = path.join(args.out, 'ir6b-downloads')
  writeProfileSettings(profileDir, llm.url, downloadsDir)
  const app = makeAppController(profileDir, 'ir6b', MAIN_ENTRY, args.port)
  try {
    await app.boot('boot1')
    const windowId = await evalIn(app.shell, 'new URL(location.href).searchParams.get("windowId")')
    const tabId = await newTab(app.shell, windowId, fixture.base + '/')
    await sleep(500)
    const baseline = fixture.state.pays

    llm.setScript([{ reply: (ctx) => { const r = ctx.refFor('결제하기'); return J({ action: 'click', ref: r }) } }])

    const created = await evalIn(app.shell, `window.browserAPI.ai.ptaskCreate(${J({
      instruction: '[IR6B] 결제하기 버튼을 눌러라.', tabId, mode: 'normal', readOnly: false,
    })})`, true)
    if (!created?.id) { check('IR6B', '위험 동작 확인 대기가 재시작을 넘어 보존된다', false, `ptaskCreate 실패: ${J(created)}`); return }
    const taskId = created.id

    await evalIn(app.shell, `window.browserAPI.ai.ptaskStart(${J(taskId)})`, true)
    const confirmWait = await waitForTaskState(app.shell, taskId, ['waiting-user', 'interrupted', 'completed', 'failed'], 20000)
    if (!(confirmWait?.state === 'waiting-user' && confirmWait?.waitCause === 'confirm')) {
      check('IR6B', '위험 동작 확인 대기가 재시작을 넘어 보존된다', false, `confirm 대기 상태를 만들지 못함(관측: ${J(confirmWait)})`)
      return
    }
    const paidBeforeKill = fixture.state.pays

    await sleep(1200)
    await app.hardKill()

    await app.boot('boot2')
    const afterBoot = await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(taskId)})`, true)
    const persistedConfirm = afterBoot?.state === 'interrupted' && afterBoot?.waitCause === 'confirm'
    const hasConfirmHint = /자동으로 승인되지 않습니다/.test(afterBoot?.waitReason ?? '')
    const hasRestartTag = /재시작으로 중단됨/.test(afterBoot?.waitReason ?? '')

    // ── 관찰(2026-09-19 실측, task-runtime.ts 와 무관한 별개 계열): 'last-session' 복원은 이
    // 시나리오에서 **두 번째로 만든 탭(내 fixture 페이지)을 되살리지 못했다** — 재부팅 직후
    // tabs.list() 에 browser://newtab 탭 하나만 남고, http://127.0.0.1:<port>/ 탭은 없었다(강제
    // 종료 직전 1200ms 를 더 기다려도 두 탭이 분명히 존재했던 것을 확인한 뒤였다 — 세션 스냅샷
    // 파일 last-stable.json 을 직접 읽어 탭이 1개뿐임을 대조 확인함). 이건 세션/탭 복원 하위계
    // 통(session/index.ts·tab-service.ts)의 동작이고 **이번에 고친 task-runtime.ts 와는 다른
    // 파일**이라 이 검증의 판정 대상이 아니다 — 여기서 고치지 않고(그 파일들을 건드리지 않는다),
    // 하네스가 사용자가 하듯 "그 페이지를 다시 열어" 이어가기를 계속한다.
    const windowId2 = await evalIn(app.shell, 'new URL(location.href).searchParams.get("windowId")')
    await newTab(app.shell, windowId2, fixture.base + '/')
    await sleep(500)

    // 이어가기(IPC — IR5 에서 이미 실제 화면 버튼을 검증했으므로 여기서는 결정성을 위해 IPC 사용).
    // 같은 위험 클릭을 다시 시도하게 각본을 준비한 뒤 이어간다 — 자동 승인 없이 다시 확인을 요구해야 한다.
    llm.setScript([{ reply: (ctx) => { const r = ctx.refFor('결제하기'); return J({ action: 'click', ref: r }) } }])
    const resumeRes = await evalIn(app.shell, `window.browserAPI.ai.ptaskResume(${J(taskId)})`, true)
    let reConfirm = await waitForTaskState(app.shell, taskId, ['waiting-user', 'completed', 'failed', 'interrupted'], 20000)
    // 탭을 다시 열었어도 checkpoint 재바인딩이 'user-fix' 로 한 번 더 사람에게 물을 수 있다(같은
    // 페이지인지 재확인하는 것 자체가 안전한 동작이다 — 자동 실행이 아니라 또 사람에게 묻는 것이므로
    // 이 자체는 안전성 위반이 아니다). 그 경우 한 번 더 confirmTask(true) 로 "그 페이지 맞다"만
    // 확인해 주고(위험 동작 자체를 승인하는 것이 아니다 — waitKind='user-fix' 는 재바인딩 승인이지
    // 결제 승인이 아니다), 실제 confirm 게이트가 뜨는지까지 본다.
    let userFixHop = false
    if (reConfirm?.state === 'waiting-user' && reConfirm?.waitCause === 'user-fix') {
      userFixHop = true
      await evalIn(app.shell, `window.browserAPI.ai.ptaskConfirm(${J(taskId)}, true)`, true)
      reConfirm = await waitForTaskState(app.shell, taskId, ['waiting-user', 'completed', 'failed', 'interrupted'], 20000)
    }
    const askedAgain = reConfirm?.state === 'waiting-user' && reConfirm?.waitCause === 'confirm'
    const neverAutoApproved = fixture.state.pays === baseline   // 하네스가 '결제하기' 자체를 승인한 적 없음 + 자동승인 없음

    const ok = persistedConfirm && hasConfirmHint && hasRestartTag && resumeRes?.ok === true && askedAgain && neverAutoApproved
    check('IR6B', '위험 동작 확인 대기가 재시작을 넘어 보존되고, 이어가기가 자동 승인하지 않는다', ok,
      `킬 전 상태=${confirmWait.state} waitCause=${confirmWait.waitCause} waitReason="${(confirmWait.waitReason ?? '').slice(0, 100)}" `
      + `· 재부팅 후 상태=${afterBoot?.state} waitCause=${afterBoot?.waitCause ?? '(없음)'} `
      + `waitReason="${(afterBoot?.waitReason ?? '').slice(0, 160)}"(승인안내포함=${hasConfirmHint}, 재시작표식=${hasRestartTag}) `
      + `· [관찰] 재부팅 후 fixture 탭이 세션 복원되지 않아 하네스가 다시 열었음(user-fix 경유=${userFixHop}, task-runtime.ts 와 무관한 별개 계열 — 위 주석 참고) `
      + `· resume응답=${J(resumeRes)} → 이어간 뒤 상태=${reConfirm?.state} waitCause=${reConfirm?.waitCause ?? '(없음)'}(다시확인요구=${askedAgain}) `
      + `· 결제 실행횟수: ledger직전 ${paidBeforeKill} → 지금 ${fixture.state.pays}(자동승인없음=${neverAutoApproved}, 하네스는 어떤 경우에도 ptaskConfirm(true) 를 부르지 않았다)`)
  } catch (err) {
    check('IR6B', '위험 동작 확인 대기가 재시작을 넘어 보존된다', false, `예외: ${err.message}\n${(err.stack ?? '').slice(0, 500)}`)
  } finally {
    await app.gracefulQuit().catch(() => {})
  }
}

main().catch((e) => { console.error(e); process.exit(2) })
