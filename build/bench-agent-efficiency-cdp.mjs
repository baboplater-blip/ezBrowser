#!/usr/bin/env node
// bench-agent-efficiency-cdp.mjs — 에이전트 "작업 전체" 효율 벤치 (스텝 수 · 총 시간 · 스텝당 지연 · 토큰 · 성공률)
//
// 왜 (2026-09-12): bench-agent-cdp.mjs 는 LLM 을 뺀 "우리 코드" 구간만 잰다. 그런데 사용자가 체감하는 느림의
// 큰 몫은 LLM 호출 자체였고, CLI 제공자(claude-code·codex)는 스텝마다 프로세스를 새로 띄워 그 비용이 더 컸다.
// 이 하네스는 **실제 CLI 제공자(구독)** 로 같은 작업을 두 모드 — CLI 세션 유지(신규) / 스텝별 실행(기존) — 로
// 돌려 전후를 숫자로 비교한다. Codex 컴퓨터 유즈는 하네스로 돌릴 수 없으므로, 우리 스텝 수에 "스텝당 스크린샷
// 토큰" 을 곱한 **추정 기준치**를 병기한다(추정임을 표에 명시).
//
// ⚠ 구독 CLI 를 실제로 호출한다 — 게이트(verify-all)에 넣지 않는다. 사람이 필요할 때 돌린다.
// ⚠ 같은 입력에도 모델 답이 달라 스텝 수가 요동할 수 있다 → --repeat 로 여러 번 돌려 중앙값을 본다.
//
// 작업 3종(로컬 결정적 페이지, 외부 접속 없음):
//   T1 클릭        '확인' 버튼 누르기                      성공 = window.__clicked
//   T2 폼 작성     이름·이메일 입력 후 제출               성공 = 제출 + 값 일치
//   T3 탐색+읽기   링크로 들어가 표시된 코드를 done 에 적기 성공 = done 메시지에 코드 포함
//
// 사용: node build/bench-agent-efficiency-cdp.mjs [--provider claude-code|codex] [--model <m>]
//       [--modes session,legacy] [--tasks T1,T2,T3] [--repeat 1] [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, getTargetList, waitForPortFree, connectShellSessionReady, ensureSessionReady } from './lib/cdp.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = {
  port: 9295, pagePort: 0, out: path.join(REPO, 'verify-out', 'bench-efficiency'),
  provider: 'claude-code', model: '', modes: ['legacy', 'session'], tasks: ['T1', 'T2', 'T3'], repeat: 1,
  maxSteps: 12, taskTimeoutMs: 8 * 60000,
}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--port') args.port = Number(process.argv[++i])
  else if (a === '--out') args.out = path.resolve(process.argv[++i])
  else if (a === '--provider') args.provider = process.argv[++i]
  else if (a === '--model') args.model = process.argv[++i]
  else if (a === '--modes') args.modes = process.argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
  else if (a === '--tasks') args.tasks = process.argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
  else if (a === '--repeat') args.repeat = Math.max(1, Number(process.argv[++i]))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const NL = String.fromCharCode(10)

// ===== 시험 페이지 =====
const CODE = 'BB-7421'
const PAGES = {
  '/': `<!doctype html><meta charset="utf-8"><title>벤치 T1 · 클릭</title>
<body style="font:16px system-ui;padding:40px">
<h1>벤치 페이지</h1>
<p>아래 버튼 중 하나를 누르는 작업입니다.</p>
<button id="cancel">취소</button> <button id="ok">확인</button> <button id="more">더 보기</button>
<p id="state">대기</p>
<script>
  window.__clicked = false
  document.getElementById('ok').onclick = () => { window.__clicked = true; document.getElementById('state').textContent = '눌림' }
  document.getElementById('cancel').onclick = () => { document.getElementById('state').textContent = '취소됨' }
  document.getElementById('more').onclick = () => { document.getElementById('state').textContent = '더 보기' }
</script></body>`,
  '/form': `<!doctype html><meta charset="utf-8"><title>벤치 T2 · 폼</title>
<body style="font:16px system-ui;padding:40px">
<h1>가입 폼</h1>
<form id="f">
  <label>이름 <input id="name" name="name" type="text" placeholder="이름"></label><br><br>
  <label>이메일 <input id="email" name="email" type="email" placeholder="이메일"></label><br><br>
  <button id="submit" type="submit">제출</button>
</form>
<p id="state">대기</p>
<script>
  window.__submitted = null
  document.getElementById('f').onsubmit = (e) => {
    e.preventDefault()
    window.__submitted = { name: document.getElementById('name').value, email: document.getElementById('email').value }
    document.getElementById('state').textContent = '제출 완료: ' + window.__submitted.name
  }
</script></body>`,
  '/list': `<!doctype html><meta charset="utf-8"><title>벤치 T3 · 목록</title>
<body style="font:16px system-ui;padding:40px">
<h1>주문 목록</h1>
<ul>
  <li>주문 #1 — <a href="/detail?id=1">상세 보기</a></li>
  <li>주문 #2 — <a href="/other">다른 링크</a></li>
</ul>
</body>`,
  '/detail': `<!doctype html><meta charset="utf-8"><title>벤치 T3 · 상세</title>
<body style="font:16px system-ui;padding:40px">
<h1>주문 #1 상세</h1>
<p>확인 코드: <strong id="code">${CODE}</strong></p>
<a href="/list">목록으로</a>
</body>`,
  '/other': `<!doctype html><meta charset="utf-8"><title>다른 페이지</title><body style="padding:40px"><p>여긴 아님</p><a href="/list">목록으로</a></body>`,
}

function startPageServer(port) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const html = PAGES[u.pathname]
    if (!html) { res.writeHead(404); res.end('nope'); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((r) => {
        try { server.closeAllConnections?.() } catch { /* ignore */ }
        const t = setTimeout(r, 3000)
        server.close(() => { clearTimeout(t); r() })
      })
    },
  })))
}

const TASKS = {
  T1: { path: '/', task: "'확인' 버튼을 눌러 주세요. 눌렀으면 done 하세요.",
    reset: 'window.__clicked = false; document.getElementById("state").textContent = "대기"; true',
    success: (page) => page.clicked === true },
  T2: { path: '/form', task: "가입 폼에 이름 '홍길동', 이메일 'hong@example.com' 을 입력하고 제출 버튼을 누르세요. 제출 완료가 보이면 done 하세요.",
    reset: 'window.__submitted = null; document.getElementById("name").value = ""; document.getElementById("email").value = ""; document.getElementById("state").textContent = "대기"; true',
    success: (page) => !!page.submitted && page.submitted.name === '홍길동' && page.submitted.email === 'hong@example.com' },
  T3: { path: '/list', task: "주문 #1 의 '상세 보기' 링크로 들어가서 확인 코드를 읽고, done 메시지에 그 코드를 그대로 적어 주세요.",
    reset: 'true',
    success: (page, run) => String(run.doneMessage ?? '').includes(CODE) },
}

// Codex 컴퓨터 유즈 추정 기준치(스텝당). 근거: 1280×800 스크린샷 ≈ 1,100~1,600 토큰(OpenAI/Anthropic 이미지 토큰 공식),
// 여기에 지시·응답 텍스트 ≈ 400. **추정치**이며 실측이 아니다 — 표에 그렇게 표기한다.
const CU_IMAGE_TOKENS = 1500
const CU_TEXT_TOKENS = 400

const evalIn = async (s, expression, awaitPromise = false, timeoutMs = 60000) => {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, timeoutMs)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.result?.value ?? r.result?.value
}

function median(xs) { const a = [...xs].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0 }
const fmt = (n) => (typeof n === 'number' && isFinite(n) ? n.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) : '—')

async function bootApp(mode, profileDir, port, pagesUrl) {
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const ai = {
    enabled: true,
    provider: args.provider,
    agentMaxSteps: args.maxSteps,
    agentAutoApprove: false,
    agentVision: 'off',        // DOM 으로 충분한 페이지 — 비전 비용을 벤치에서 분리
    agentHumanInput: false,    // 우리 코드 구간은 bench-agent-cdp 가 따로 잰다
    agentInputMode: 'fast',
    memoryEnabled: false,
    cliSession: mode === 'session',
  }
  if (args.provider === 'claude-code') ai.claudeCodeModel = args.model
  if (args.provider === 'codex') ai.codexModel = args.model
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true }, startup: { mode: 'newtab', urls: [] }, adblock: { enabled: false }, ai,
  }, null, 2))
  const logStream = fs.createWriteStream(path.join(args.out, `app-${mode}.log`))
  const child = spawn(EXE, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)
  const shell = await connectShellSessionReady(port)
  const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
  const tabId = await evalIn(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pagesUrl + '/')}).then(t => t.id)`, true)
  await sleep(2000)
  // 이벤트 수집기 — 수신 시각을 붙인다(스텝당 지연 계산용).
  await evalIn(shell, 'window.__ev = []; window.browserAPI.ai.onAgentEvent((e) => window.__ev.push({ ...e, t: Date.now() })); true')
  return { child, shell, tabId, windowId }
}

async function shutdownApp(app, port) {
  try { app.shell?.close() } catch { /* ignore */ }
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
    await b.send('Browser.close').catch(() => {}); b.close()
  } catch { /* ignore */ }
  await sleep(1500)
  try { app.child.kill() } catch { /* ignore */ }
  await waitForPortFree(port, 15000).catch(() => {})
}

/** 한 작업 실행 → 메트릭 */
async function runTask(app, port, pagesUrl, taskId, mode, rep) {
  const spec = TASKS[taskId]
  const reqId = `bench-${mode}-${taskId}-${rep}-${Date.now()}`
  // 작업 페이지로 이동 + 상태 초기화
  await evalIn(app.shell, `window.browserAPI.tabs.navigate ? window.browserAPI.tabs.navigate(${JSON.stringify(app.tabId)}, ${JSON.stringify(pagesUrl + spec.path)}) : window.browserAPI.omnibox.navigate(${JSON.stringify(pagesUrl + spec.path)})`, true).catch(() => {})
  await sleep(1500)
  let pageTarget = null
  for (let i = 0; i < 20 && !pageTarget; i++) {
    pageTarget = (await getTargetList(port)).find((t) => String(t.url).startsWith(pagesUrl + spec.path))
    if (!pageTarget) await sleep(300)
  }
  if (!pageTarget) throw new Error(`시험 페이지 타깃 없음: ${spec.path}`)
  const page = await connectSession(pageTarget, 'page')
  await ensureSessionReady(page)
  await evalIn(page, spec.reset)
  await evalIn(app.shell, 'window.__ev = []; true')

  const t0 = Date.now()
  await evalIn(app.shell, `window.browserAPI.ai.agentStart(${JSON.stringify({ reqId, tabId: app.tabId, task: spec.task })})`, true)
  const deadline = Date.now() + args.taskTimeoutMs
  let evs = []
  while (Date.now() < deadline) {
    evs = JSON.parse(await evalIn(app.shell, 'JSON.stringify(window.__ev)') ?? '[]')
    // 벤치 작업에는 확인·질문이 없어야 한다. 나오면 거부/빈답으로 넘겨 멈추지 않게 한다.
    if (evs.some((e) => e.type === 'confirm')) await evalIn(app.shell, `window.browserAPI.ai.agentConfirm(${JSON.stringify(reqId)}, true)`, true).catch(() => {})
    if (evs.some((e) => e.type === 'ask')) await evalIn(app.shell, `window.browserAPI.ai.agentReply(${JSON.stringify(reqId)}, "그냥 진행하세요")`, true).catch(() => {})
    if (evs.some((e) => e.type === 'done' || e.type === 'error' || e.type === 'cancelled')) break
    await sleep(300)
  }
  const endEv = evs.find((e) => e.type === 'done' || e.type === 'error' || e.type === 'cancelled')
  if (!endEv) { await evalIn(app.shell, `window.browserAPI.ai.agentCancel(${JSON.stringify(reqId)})`, true).catch(() => {}); await sleep(1000) }
  const wallMs = (endEv?.t ?? Date.now()) - t0

  // 스텝당 LLM 지연 ≈ observe 이벤트 → 다음 (thought|action|done|ask|confirm|error) 이벤트
  const latencies = []
  for (let i = 0; i < evs.length; i++) {
    if (evs[i].type !== 'observe') continue
    for (let j = i + 1; j < evs.length; j++) {
      if (['thought', 'action', 'done', 'ask', 'confirm', 'error', 'usage'].includes(evs[j].type)) { latencies.push(evs[j].t - evs[i].t); break }
    }
  }
  const usageEvs = evs.filter((e) => e.type === 'usage')
  const usage = usageEvs.reduce((a, u) => ({ input: a.input + (u.input || 0), cacheRead: a.cacheRead + (u.cacheRead || 0), cacheCreate: a.cacheCreate + (u.cacheCreate || 0), output: a.output + (u.output || 0) }), { input: 0, cacheRead: 0, cacheCreate: 0, output: 0 })
  const steps = evs.filter((e) => e.type === 'observe').length
  const pageState = {
    clicked: await evalIn(page, 'window.__clicked === true').catch(() => false),
    submitted: await evalIn(page, 'JSON.stringify(window.__submitted ?? null)').then((s) => JSON.parse(s ?? 'null')).catch(() => null),
  }
  // T3 는 페이지가 바뀌었으므로 성공 판정을 done 메시지로 한다.
  const run = { doneMessage: endEv?.type === 'done' ? String(endEv.message ?? '') : '' }
  const success = endEv?.type === 'done' && spec.success(pageState, run)
  try { page.close() } catch { /* ignore */ }
  return {
    mode, task: taskId, rep, success, end: endEv?.type ?? 'timeout', steps, llmCalls: usageEvs.length || steps,
    wallMs, stepLatencyMs: latencies, stepLatencyMedianMs: median(latencies),
    tokens: usageEvs.length ? usage : null,
    sessionEvent: evs.some((e) => e.type === 'session'), fallback: evs.some((e) => e.type === 'result' && String(e.label || '').startsWith('CLI 세션')),
    doneMessage: run.doneMessage.slice(0, 160), errorMessage: endEv?.type === 'error' ? String(endEv.message ?? '').slice(0, 200) : '',
  }
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE}`)
  fs.mkdirSync(args.out, { recursive: true })
  args.port = await preferFreePort(args.port, 'bench-agent-efficiency-cdp.mjs')
  await waitForPortFree(args.port)
  ;[args.pagePort] = await getFreePorts(1)
  const pages = await startPageServer(args.pagePort)
  console.log(`bench-agent-efficiency — provider=${args.provider}${args.model ? ' model=' + args.model : ''} modes=${args.modes.join(',')} tasks=${args.tasks.join(',')} repeat=${args.repeat}`)

  const results = []
  try {
    for (const mode of args.modes) {
      const profileDir = path.join(args.out, `profile-${mode}`)
      console.log(`${NL}=== 모드: ${mode} (${mode === 'session' ? '작업당 CLI 프로세스 1개' : '스텝마다 CLI 새로 실행'}) ===`)
      const app = await bootApp(mode, profileDir, args.port, pages.url)
      try {
        for (let rep = 1; rep <= args.repeat; rep++) {
          for (const taskId of args.tasks) {
            process.stdout.write(`  ${taskId} #${rep} … `)
            try {
              const r = await runTask(app, args.port, pages.url, taskId, mode, rep)
              results.push(r)
              console.log(`${r.success ? '✓' : '✗'} ${r.end} · 스텝 ${r.steps} · ${fmt(r.wallMs / 1000)}s · 스텝지연 중앙 ${fmt(r.stepLatencyMedianMs / 1000)}s` + (r.tokens ? ` · 토큰 in ${fmt(r.tokens.input)} / cacheR ${fmt(r.tokens.cacheRead)} / cacheW ${fmt(r.tokens.cacheCreate)} / out ${fmt(r.tokens.output)}` : ' · 토큰 미측정') + (r.fallback ? ' · ⚠ 세션 폴백 발생' : '') + (r.errorMessage ? ` · 오류: ${r.errorMessage}` : ''))
            } catch (err) {
              results.push({ mode, task: taskId, rep, success: false, end: 'harness-error', errorMessage: err.message })
              console.log(`✗ 하네스 오류: ${err.message}`)
            }
          }
        }
      } finally {
        await shutdownApp(app, args.port)
      }
    }
  } finally {
    await pages.close()
  }

  // ===== 집계 =====
  const summary = {}
  for (const mode of args.modes) {
    const rs = results.filter((r) => r.mode === mode)
    const ok = rs.filter((r) => r.success)
    const withTok = rs.filter((r) => r.tokens)
    const tok = (k) => withTok.reduce((a, r) => a + r.tokens[k], 0)
    const stepsTotal = rs.reduce((a, r) => a + (r.steps || 0), 0)
    summary[mode] = {
      runs: rs.length, success: ok.length, successRate: rs.length ? ok.length / rs.length : 0,
      stepsMedian: median(rs.map((r) => r.steps || 0)), stepsTotal,
      wallMedianMs: median(rs.map((r) => r.wallMs || 0)), wallTotalMs: rs.reduce((a, r) => a + (r.wallMs || 0), 0),
      stepLatencyMedianMs: median(rs.flatMap((r) => r.stepLatencyMs || [])),
      tokens: withTok.length ? { input: tok('input'), cacheRead: tok('cacheRead'), cacheCreate: tok('cacheCreate'), output: tok('output'), perStepNew: stepsTotal ? Math.round((tok('input') + tok('cacheCreate') + tok('output')) / stepsTotal) : 0 } : null,
      fallbacks: rs.filter((r) => r.fallback).length,
      // Codex 컴퓨터 유즈 추정: 같은 스텝 수 × (스크린샷 + 텍스트) — 추정치
      computerUseEstimateTokens: stepsTotal * (CU_IMAGE_TOKENS + CU_TEXT_TOKENS),
    }
  }

  const md = []
  md.push(`# 에이전트 효율 벤치 — ${new Date().toISOString()}`)
  md.push(`provider=${args.provider}${args.model ? ' model=' + args.model : ''} · tasks=${args.tasks.join(',')} · repeat=${args.repeat} · maxSteps=${args.maxSteps} · vision=off · humanInput=off`)
  md.push('')
  md.push('| 모드 | 실행 | 성공률 | 스텝(중앙) | 총 시간(중앙) | 스텝당 LLM 지연(중앙) | 신규 토큰/스텝 (input+cacheW+out) | 캐시 읽기 합 | 폴백 |')
  md.push('|---|---|---|---|---|---|---|---|---|')
  for (const mode of args.modes) {
    const s = summary[mode]
    md.push(`| ${mode === 'session' ? '세션 유지(신규)' : '스텝별 실행(기존)'} | ${s.runs} | ${Math.round(s.successRate * 100)}% (${s.success}/${s.runs}) | ${fmt(s.stepsMedian)} | ${fmt(s.wallMedianMs / 1000)}s | ${fmt(s.stepLatencyMedianMs / 1000)}s | ${s.tokens ? fmt(s.tokens.perStepNew) : '미측정'} | ${s.tokens ? fmt(s.tokens.cacheRead) : '미측정'} | ${s.fallbacks} |`)
  }
  md.push('')
  md.push(`**Codex 컴퓨터 유즈 추정 기준치(실측 아님)**: 같은 스텝 수 × (스크린샷 ≈${CU_IMAGE_TOKENS} + 텍스트 ≈${CU_TEXT_TOKENS}) 토큰/스텝 → ` + args.modes.map((m) => `${m}: ${fmt(summary[m].computerUseEstimateTokens)}`).join(' · ') + '. 컴퓨터 유즈는 좌표 클릭 빗나감·OS 창 대응으로 스텝이 더 늘어나는 경향이 있으나 그 배수는 여기서 가정하지 않는다.')
  md.push('')
  md.push('## 실행별')
  md.push('| 모드 | 작업 | 회차 | 결과 | 스텝 | 시간 | 스텝지연(중앙) | 토큰 in/cacheR/cacheW/out | 비고 |')
  md.push('|---|---|---|---|---|---|---|---|---|')
  for (const r of results) md.push(`| ${r.mode} | ${r.task} | ${r.rep} | ${r.success ? '✓' : '✗'} ${r.end} | ${r.steps ?? '—'} | ${fmt((r.wallMs ?? 0) / 1000)}s | ${fmt((r.stepLatencyMedianMs ?? 0) / 1000)}s | ${r.tokens ? `${fmt(r.tokens.input)}/${fmt(r.tokens.cacheRead)}/${fmt(r.tokens.cacheCreate)}/${fmt(r.tokens.output)}` : '—'} | ${[r.fallback ? '세션 폴백' : '', r.errorMessage || '', r.task === 'T3' ? `done: ${r.doneMessage}` : ''].filter(Boolean).join(' · ')} |`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  fs.writeFileSync(path.join(args.out, `bench-${stamp}.json`), JSON.stringify({ args, summary, results }, null, 2))
  fs.writeFileSync(path.join(args.out, 'bench-latest.json'), JSON.stringify({ args, summary, results }, null, 2))
  fs.writeFileSync(path.join(args.out, 'bench-latest.md'), md.join(NL))
  console.log(NL + md.join(NL))
  console.log(`${NL}결과: ${path.join(args.out, 'bench-latest.md')}`)
  const anyRan = results.some((r) => r.end !== 'harness-error')
  process.exit(anyRan ? 0 : 1)
}

main().catch((err) => { console.error('bench 실패:', err); process.exit(1) })
