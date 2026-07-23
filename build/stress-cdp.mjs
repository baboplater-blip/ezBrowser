#!/usr/bin/env node
// stress-cdp.mjs — 게이트 3(안정성) 압축 스트레스 하네스. CDP 로 packaged ezBrowser 를 원격
// 구동해 대량 탭 개장·순회·워크스페이스 반복 전환·탭 슬립·대량 탭 닫기를 몰아붙이고, 그 과정에서
// RSS 추이·크래시/먹통·에러 로그를 관측한다. 8시간 실사용을 흉내낼 수 없으므로 "반복 후 회수되는가"
// 를 판정 기준으로 삼는다.
//
// 아키텍처·안전장치는 build/smoke-cdp.mjs 를 그대로 재사용한다 (CDP 세션 클래스, 격리 프로필 시드,
// PID 스코프 프로세스 종료 — 이름 기반 Stop-Process 절대 금지, CDP Browser.close 우아한 종료 우선).
// 이 하네스는 build/smoke-cdp.mjs 와 별개 포트(기본 9225)·별개 출력 디렉터리를 써서 동시에 떠 있는
// 다른 워커의 인스턴스와 절대 충돌하지 않는다.
//
// RSS 측정: window.browserAPI(외피 셸) 에는 시스템 메트릭이 없다 — browser://memory 페이지 전용
// window.internalAPI.system.metrics() 를 쓴다(app/main/ipc/system.ts, isTrustedSender 로
// browser:/file:/devtools:/localhost 만 허용). 그래서 이 하네스는 시작 직후 browser://memory 탭을
// 하나 만들어 그 CDP 콘텐츠 타깃에 붙어 있다가, 필요한 시점마다 evaluate 로 metrics() 를 호출한다.
//
// 탭 슬립 수동 트리거: internalAPI.system.sweepTabSleep() 은 있지만 내부적으로 여전히
// performance.tabSleepMinutes(기본 30) 임계값을 그대로 적용한다(app/main/features/tab-sleep — 강제
// 옵션 없음). 임계값 자체를 낮추는 것은 가능하다 — browserAPI.settings.set('performance.tabSleepMinutes', 1)
// 로 1분까지 낫출 수 있고(1분 미만 값은 코드가 무시하고 기본 30분로 폴백), 그 뒤 백그라운드 탭들의
// lastActiveAt 이 1분 이상 지나길 기다린 뒤 sweepTabSleep() 을 호출하면 실제로 discard 된다.
// 이 우회 경로를 "수동 슬립 트리거 가능"으로 보고한다.
//
// 사용:
//   node build/stress-cdp.mjs [--exe <path>] [--out <dir>] [--port <n>] [--keep-alive]

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { startPageServer } from './stress-page-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const DEFAULTS = {
  exe: path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe'),
  out: 'C:\\Users\\molma\\AppData\\Local\\Temp\\claude\\c--Users-molma-Desktop-----browser-build\\9385582e-821e-4490-88cc-bb0c7fda225a\\scratchpad\\stress',
  port: 9225,
  keepAlive: false,
}

// ── 인자 파싱 ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--exe') out.exe = path.resolve(argv[++i] ?? '')
    else if (a === '--out') out.out = path.resolve(argv[++i] ?? '')
    else if (a === '--port') out.port = Number(argv[++i] ?? DEFAULTS.port)
    else if (a === '--keep-alive') out.keepAlive = true
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else console.warn(`[stress-cdp] 알 수 없는 인자 무시: ${a}`)
  }
  out.profileDir = path.join(out.out, 'profile')
  return out
}

function printHelp() {
  console.log(`
stress-cdp — CDP 기반 ezBrowser 안정성 압축 스트레스 하네스 (게이트 3)

사용: node build/stress-cdp.mjs [옵션]

옵션:
  --exe <path>   패키징된 exe 경로 (기본: dist/win-unpacked/ezBrowser.exe)
  --out <dir>    결과 JSON/CSV/로그 저장 디렉터리 (기본: scratchpad/stress)
  --port <n>     --remote-debugging-port 값 (기본: 9225)
  --keep-alive   끝나도 앱을 종료하지 않음 (수동 확인용)
`.trim())
}

// ── 공통 유틸 (smoke-cdp.mjs 와 동일 패턴) ─────────────────────────────────

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout(${ms}ms): ${label}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function pollUntil(fn, { timeoutMs = 10_000, intervalMs = 300, label = 'condition' } = {}) {
  const start = Date.now()
  let last
  let lastErr
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn()
      lastErr = null
      if (last) return last
    } catch (err) {
      lastErr = err
    }
    await sleep(intervalMs)
  }
  const suffix = lastErr ? ` (마지막 오류: ${lastErr.message})` : ''
  throw new Error(`timeout(${timeoutMs}ms) waiting for ${label}${suffix}`)
}

// ── 프로세스 관리 (PID 스코프만 — 이름 기반 종료 절대 금지) ─────────────────

function procFilePath(outDir) { return path.join(outDir, 'app-proc.json') }

function readProcFile(outDir) {
  try {
    const raw = fs.readFileSync(procFilePath(outDir), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.pid === 'number') return parsed
    return null
  } catch {
    return null
  }
}

function writeProcFile(outDir, info) {
  try { fs.writeFileSync(procFilePath(outDir), JSON.stringify(info)) } catch { /* best-effort */ }
}

function removeProcFile(outDir) {
  try { fs.unlinkSync(procFilePath(outDir)) } catch { /* ignore */ }
}

function killPidTree(pid) {
  if (!pid) return
  const res = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
  if (res.error) console.warn('[stress-cdp] taskkill 실행 오류(무시):', res.error.message)
}

function isPidAlive(pid) {
  if (!pid) return false
  const res = spawnSync('powershell', [
    '-NoProfile', '-Command',
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Write-Output 'alive' }`,
  ], { encoding: 'utf8' })
  return (res.stdout || '').includes('alive')
}

async function tryGracefulShutdown(port, timeoutMs = 3000) {
  try {
    const res = await withTimeout(fetch(`http://127.0.0.1:${port}/json/version`), timeoutMs, 'graceful shutdown /json/version')
    if (!res.ok) return false
    const info = await res.json()
    const wsUrl = info.webSocketDebuggerUrl
    if (!wsUrl) return false
    const browserSession = new CDPSession(wsUrl, 'browser-close')
    await browserSession.connect(timeoutMs)
    await browserSession.send('Browser.close', {}, timeoutMs).catch(() => { /* Electron 이 지원 안 해도 무방 */ })
    browserSession.close()
    return true
  } catch {
    return false
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) { resolve(true); return }
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve(true) })
  })
}

async function cleanupStaleProcess(outDir) {
  const stale = readProcFile(outDir)
  if (!stale) return
  console.log(`[stress-cdp] 이전 실행이 남긴 프로세스 발견 (pid=${stale.pid}, port=${stale.port}) — 정리 시도…`)
  if (isPidAlive(stale.pid)) {
    const graceful = await tryGracefulShutdown(stale.port)
    if (graceful) await sleep(1500)
    if (isPidAlive(stale.pid)) killPidTree(stale.pid)
  }
  removeProcFile(outDir)
}

function launchApp(exePath, outDir, port, profileDir) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // Electron 이 일반 Node 모드로 뜨는 것 방지

  const stdoutPath = path.join(outDir, 'app-stdout.log')
  const stderrPath = path.join(outDir, 'app-stderr.log')
  const stdoutStream = fs.createWriteStream(stdoutPath)
  const stderrStream = fs.createWriteStream(stderrPath)

  const child = spawn(exePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
  ], {
    env,
    cwd: path.dirname(exePath),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    windowsHide: false,
  })
  child.stdout?.pipe(stdoutStream)
  child.stderr?.pipe(stderrStream)
  child.on('exit', (code, signal) => {
    console.log(`[stress-cdp] app process exited (code=${code} signal=${signal})`)
  })
  writeProcFile(outDir, { pid: child.pid, port })
  return { child, stdoutPath, stderrPath }
}

async function killApp(child, port, outDir) {
  if (!child || child.exitCode !== null) {
    removeProcFile(outDir)
    return
  }
  const graceful = await tryGracefulShutdown(port)
  if (graceful) {
    const exited = await waitForExit(child, 5000)
    if (exited) { removeProcFile(outDir); return }
  }
  try { child.kill() } catch { /* ignore */ }
  killPidTree(child.pid)
  removeProcFile(outDir)
}

// ── 격리 프로필 시드 (실사용자 프로필 절대 미접촉) ──────────────────────────

function seedProfile(profileDir) {
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const settingsPath = path.join(profileDir, 'settings.json')
  const seed = {
    setup: { completed: true, completedAt: Date.now(), version: 'stress-cdp' },
    startup: { mode: 'newtab', urls: [] },
  }
  fs.writeFileSync(settingsPath, JSON.stringify(seed, null, 2))
}

// ── CDP 클라이언트 (smoke-cdp.mjs 와 동일) ──────────────────────────────

class CDPSession {
  constructor(wsUrl, label) {
    this.wsUrl = wsUrl
    this.label = label
    this.ws = null
    this._id = 0
    this.pending = new Map()
  }

  async connect(timeoutMs = 10_000) {
    this.ws = new WebSocket(this.wsUrl)
    await withTimeout(new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', (e) => reject(new Error(`ws error: ${e?.message ?? 'unknown'}`)))
    }), timeoutMs, `CDP ws connect (${this.label})`)
    this.ws.addEventListener('message', (ev) => this._onMessage(ev))
    this.ws.addEventListener('close', () => {
      for (const [, p] of this.pending) p.reject(new Error('ws closed before response'))
      this.pending.clear()
    })
  }

  _onMessage(ev) {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(`CDP error [${msg.error.code}]: ${msg.error.message}`))
      else resolve(msg.result)
    }
  }

  send(method, params = {}, timeoutMs = 15_000) {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
      return Promise.reject(new Error(`CDP session not open (${this.label}) — method=${method}`))
    }
    const id = (this._id += 1)
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.ws.send(JSON.stringify({ id, method, params }))
    return withTimeout(p, timeoutMs, `CDP ${method} (${this.label})`)
  }

  close() {
    try { this.ws?.close() } catch { /* ignore */ }
  }
}

async function connectSession(target, label) {
  const session = new CDPSession(target.webSocketDebuggerUrl, label ?? target.id)
  await session.connect()
  return session
}

async function evaluate(session, expression, opts = {}) {
  const { awaitPromise = true, returnByValue = true, timeoutMs = 15_000 } = opts
  const result = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue,
    userGesture: true,
  }, timeoutMs)
  if (result.exceptionDetails) {
    const ex = result.exceptionDetails
    const desc = ex.exception?.description || ex.text || JSON.stringify(ex)
    throw new Error(`JS exception in ${session.label}: ${desc}`)
  }
  return result.result?.value
}

function argToLiteral(a) {
  return a === undefined ? 'undefined' : JSON.stringify(a)
}

function callApi(session, apiPath, args = [], opts) {
  const argStr = args.map(argToLiteral).join(', ')
  return evaluate(session, `window.browserAPI.${apiPath}(${argStr})`, opts)
}

function callInternalApi(session, apiPath, args = [], opts) {
  const argStr = args.map(argToLiteral).join(', ')
  return evaluate(session, `window.internalAPI.${apiPath}(${argStr})`, opts)
}

// ── CDP 타깃 발견 ────────────────────────────────────────────────────────

async function getTargetList(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`)
  return res.json()
}

function isShellTarget(t) {
  return t.type === 'page' && typeof t.url === 'string'
    && t.url.startsWith('file://') && t.url.includes('index.html') && t.url.includes('windowId=')
}

async function waitForShellTarget(port, timeoutMs = 30_000) {
  let lastList = []
  const found = await pollUntil(async () => {
    lastList = await getTargetList(port)
    return lastList.find(isShellTarget) ?? null
  }, { timeoutMs, intervalMs: 500, label: 'shell CDP target' }).catch((err) => {
    const summary = lastList.map((t) => `${t.type}:${t.url}`).join('\n  ')
    throw new Error(`${err.message}\n마지막 타깃 목록:\n  ${summary || '(없음)'}`)
  })
  return found
}

/** tabs.create 로 새 탭을 만들고, 그 직후 새로 등장한 CDP page 타깃을 찾아 연결한다.
 *  URL 이 중복될 수 있는(about:blank, browser://newtab) 탭도 안전하게 식별하도록
 *  "생성 직전/직후 타깃 id 집합의 차집합"으로 매칭한다 (smoke-cdp.mjs S2 패턴 재사용). */
async function createTrackedTab(ctx, url, opts) {
  const before = await getTargetList(ctx.port)
  const beforeIds = new Set(before.map((t) => t.id))
  const tab = await callApi(ctx.chromeSession, 'tabs.create', [ctx.windowId, url, opts])
  const target = await pollUntil(async () => {
    const list = await getTargetList(ctx.port)
    return list.find((t) => !beforeIds.has(t.id) && t.type === 'page') ?? null
  }, { timeoutMs: 8000, label: `새 탭 CDP 타깃(${url})` })
  return { tab, target }
}

// ── RSS 샘플링 (browser://memory 의 internalAPI.system.metrics) ─────────

const rssSamples = []

async function sampleRss(ctx, label) {
  const t0 = Date.now()
  const metrics = await callInternalApi(ctx.memSession, 'system.metrics', [])
  const sample = {
    label,
    ts: Date.now(),
    totalMemoryMB: metrics.totals.memoryMB,
    processCount: metrics.totals.processCount,
    avgCpu: metrics.totals.avgCpu,
    tabsTotal: metrics.tabs.total,
    tabsDiscarded: metrics.tabs.discarded,
    tabsActive: metrics.tabs.active,
    processes: metrics.processes.map((p) => ({ pid: p.pid, type: p.type, memoryMB: p.memoryMB })),
  }
  rssSamples.push(sample)
  console.log(`  [rss] ${label}: ${sample.totalMemoryMB}MB (${sample.processCount} procs, `
    + `tabs total=${sample.tabsTotal} discarded=${sample.tabsDiscarded}) — ${Date.now() - t0}ms`)
  return sample
}

// ── 이벤트 로그 ──────────────────────────────────────────────────────────

const events = []
function logEvent(stage, status, detail) {
  const rec = { stage, status, detail, ts: Date.now() }
  events.push(rec)
  const marker = status === 'OK' ? '✓' : status === 'WARN' ? '⚠' : '✗'
  console.log(`  ${marker} [${stage}] ${status}${detail ? ` — ${detail}` : ''}`)
}

// ── 시나리오 단계 ────────────────────────────────────────────────────────

async function stageBoot(ctx) {
  const shellTarget = await waitForShellTarget(ctx.port, 30_000)
  ctx.chromeSession = await connectSession(shellTarget, 'chrome-shell')
  ctx.openSessions.push(ctx.chromeSession)
  ctx.windowId = await evaluate(ctx.chromeSession, `new URL(location.href).searchParams.get('windowId')`)
  if (!ctx.windowId) throw new Error('외피 URL 에서 windowId 를 읽지 못함')
  logEvent('boot', 'OK', `windowId=${ctx.windowId}`)

  // 첫 탭이 뜰 시간 확보.
  await sleep(1500)

  // browser://memory 전용 세션 — 전 과정 RSS 샘플링에 재사용.
  const { tab: memTab, target: memTarget } = await createTrackedTab(ctx, 'browser://memory', {})
  ctx.memTabId = memTab.id
  ctx.memSession = await connectSession(memTarget, 'content:memory')
  ctx.openSessions.push(ctx.memSession)
  await pollUntil(
    () => evaluate(ctx.memSession, `typeof window.internalAPI !== 'undefined' && typeof window.internalAPI.system !== 'undefined'`),
    { timeoutMs: 8000, label: 'browser://memory internalAPI 준비' },
  )
  logEvent('boot', 'OK', 'browser://memory internalAPI 연결 확인')

  // 수동 슬립 트리거 API 가용성 확인(호출은 나중 단계에서).
  const hasSweep = await evaluate(ctx.memSession, `typeof window.internalAPI.system.sweepTabSleep === 'function'`)
  ctx.hasManualSleepTrigger = !!hasSweep
  logEvent('boot', hasSweep ? 'OK' : 'WARN', `수동 탭 슬립 트리거(sweepTabSleep) 가용: ${hasSweep}`)
}

async function stageOpen50Tabs(ctx) {
  const plan = []
  for (let i = 0; i < 50; i++) {
    if (i % 2 === 0) plan.push({ kind: 'local', url: ctx.pageServer.pageUrl(i) })
    else if (i % 4 === 1) plan.push({ kind: 'newtab', url: 'browser://newtab' })
    else plan.push({ kind: 'blank', url: 'about:blank' })
  }
  ctx.stressTabs = []
  let failures = 0
  for (let i = 0; i < plan.length; i++) {
    const { kind, url } = plan[i]
    try {
      const { tab, target } = await createTrackedTab(ctx, url, { background: true })
      ctx.stressTabs.push({ idx: i, kind, url, tabId: tab.id, wsDebuggerUrl: target.webSocketDebuggerUrl, session: null })
    } catch (err) {
      failures += 1
      logEvent('open-50-tabs', 'FAIL', `#${i}(${kind}) 생성 실패: ${err.message}`)
    }
    await sleep(150)
  }
  const counts = ctx.stressTabs.reduce((acc, t) => { acc[t.kind] = (acc[t.kind] ?? 0) + 1; return acc }, {})
  logEvent('open-50-tabs', failures === 0 ? 'OK' : 'WARN',
    `생성 ${ctx.stressTabs.length}/50 (실패 ${failures}) — local=${counts.local ?? 0} newtab=${counts.newtab ?? 0} blank=${counts.blank ?? 0}`)
}

async function sessionFor(ctx, rec) {
  if (rec.session && rec.session.ws && rec.session.ws.readyState === 1) return rec.session
  rec.session = await connectSession({ webSocketDebuggerUrl: rec.wsDebuggerUrl }, `content:${rec.kind}#${rec.idx}`)
  ctx.openSessions.push(rec.session)
  return rec.session
}

async function stageTraverseTabs(ctx) {
  const passes = [
    { name: 'forward', order: ctx.stressTabs.map((_, i) => i) },
    { name: 'backward', order: ctx.stressTabs.map((_, i) => i).reverse() },
    { name: 'forward2', order: ctx.stressTabs.map((_, i) => i) },
  ]
  let unresponsive = 0
  let activateFailures = 0
  for (const pass of passes) {
    for (const idx of pass.order) {
      const rec = ctx.stressTabs[idx]
      try {
        await callApi(ctx.chromeSession, 'tabs.activate', [rec.tabId])
        await sleep(200)
        const session = await sessionFor(ctx, rec)
        const readyState = await withTimeout(
          evaluate(session, `document.readyState`),
          6000,
          `readyState(#${idx} ${rec.kind})`,
        )
        if (readyState !== 'complete' && readyState !== 'interactive') {
          unresponsive += 1
          logEvent('traverse', 'WARN', `pass=${pass.name} #${idx}(${rec.kind}) readyState=${readyState}`)
        }
      } catch (err) {
        unresponsive += 1
        activateFailures += 1
        logEvent('traverse', 'FAIL', `pass=${pass.name} #${idx}(${rec.kind} tabId=${rec.tabId}): ${err.message}`)
      }
    }
    logEvent('traverse', 'OK', `pass=${pass.name} 완료 (${ctx.stressTabs.length}개 탭 순회)`)
  }
  logEvent('traverse', unresponsive === 0 ? 'OK' : 'WARN',
    `총 3패스 순회 완료 — 먹통/실패 ${unresponsive}건 (그 중 activate 실패 ${activateFailures}건)`)
}

async function stageWorkspaceCycle(ctx) {
  const wsState0 = await callApi(ctx.chromeSession, 'workspace.state', [])
  const originalWsId = wsState0.activeId
  ctx.originalWsId = originalWsId
  const originalTabsBefore = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
  logEvent('workspace', 'OK', `원래 워크스페이스=${originalWsId}, 탭 ${originalTabsBefore.length}개`)

  const wsA = await callApi(ctx.chromeSession, 'workspace.create', [{ name: 'stress-A' }])
  const wsB = await callApi(ctx.chromeSession, 'workspace.create', [{ name: 'stress-B' }])
  ctx.stressWorkspaces = [wsA, wsB]
  logEvent('workspace', 'OK', `워크스페이스 A=${wsA.id}, B=${wsB.id} 생성`)

  const wsTabs = { [wsA.id]: [], [wsB.id]: [] }
  for (const ws of [wsA, wsB]) {
    await callApi(ctx.chromeSession, 'workspace.activate', [ws.id])
    await sleep(300)
    const { tab: t1 } = await createTrackedTab(ctx, ctx.pageServer.pageUrl(`ws-${ws.id}-1`), {})
    const { tab: t2 } = await createTrackedTab(ctx, 'about:blank', {})
    wsTabs[ws.id].push(t1.id, t2.id)
    await sleep(150)
  }
  ctx.wsTabIds = wsTabs

  await callApi(ctx.chromeSession, 'workspace.activate', [originalWsId])
  await sleep(300)

  const cycleIds = [originalWsId, wsA.id, wsB.id]
  let isolationBreach = 0
  const cycleLog = []
  for (let round = 0; round < 10; round++) {
    const wsId = cycleIds[round % cycleIds.length]
    await callApi(ctx.chromeSession, 'workspace.activate', [wsId])
    await sleep(200)
    const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
    const state = await callApi(ctx.chromeSession, 'workspace.state', [])
    const allMatch = tabs.every((t) => t.workspaceId === wsId)
    const activeMatches = state.activeId === wsId
    if (!allMatch || !activeMatches) isolationBreach += 1
    cycleLog.push({ round, wsId, tabCount: tabs.length, allMatch, activeMatches })
  }
  logEvent('workspace', isolationBreach === 0 ? 'OK' : 'FAIL',
    `10회 라운드로빈 전환 완료 — 격리 위반 ${isolationBreach}건. 라운드별: `
    + cycleLog.map((c) => `${c.round}:${c.wsId.slice(0, 6)}(n=${c.tabCount}${c.allMatch ? '' : ' MISMATCH'})`).join(' '))

  await callApi(ctx.chromeSession, 'workspace.activate', [originalWsId])
  await sleep(300)
  ctx.workspaceCycleLog = cycleLog
}

async function stageManualSleepSweep(ctx) {
  if (!ctx.hasManualSleepTrigger) {
    logEvent('sleep', 'WARN', '수동 슬립 트리거 API 없음 — 자연 발동(30분)만 가능, 스킵')
    return
  }
  const origMinutes = await callApi(ctx.chromeSession, 'settings.get', ['performance.tabSleepMinutes'])
  // 1분(코드가 받아들이는 최소값)으로 낮춰 30분 임계값을 우회한다. 0/미만 값은 무시되고 기본
  // 30분으로 폴백하므로(app/main/features/tab-sleep/index.ts idleThresholdMs), 반드시 1 이상.
  await callApi(ctx.chromeSession, 'settings.set', ['performance.tabSleepMinutes', 1])
  logEvent('sleep', 'OK', `performance.tabSleepMinutes: ${origMinutes ?? '(기본값)'} → 1 (임계 우회 시도)`)

  const waitMs = 75_000
  logEvent('sleep', 'OK', `백그라운드 탭들의 lastActiveAt 이 1분 임계를 넘도록 ${waitMs / 1000}초 대기…`)
  await sleep(waitMs)

  await sampleRss(ctx, 'before-sweep')
  const result = await callInternalApi(ctx.memSession, 'system.sweepTabSleep', [])
  logEvent('sleep', 'OK', `sweepTabSleep() → discarded=${result.discarded} skipped=${result.skipped}`)
  ctx.sweepResult = result
  await sampleRss(ctx, 'after-sweep')

  // 원복(best-effort).
  await callApi(ctx.chromeSession, 'settings.set', ['performance.tabSleepMinutes', origMinutes ?? 30]).catch(() => {})
}

async function stageCloseAll(ctx) {
  let closeFailures = 0
  for (const rec of ctx.stressTabs) {
    try {
      await callApi(ctx.chromeSession, 'tabs.close', [rec.tabId])
    } catch (err) {
      closeFailures += 1
      logEvent('close-all', 'FAIL', `#${rec.idx}(${rec.kind} tabId=${rec.tabId}) 닫기 실패: ${err.message}`)
    }
    await sleep(120)
  }
  logEvent('close-all', closeFailures === 0 ? 'OK' : 'WARN', `50개 스트레스 탭 닫기 완료 (실패 ${closeFailures})`)

  for (const ws of ctx.stressWorkspaces ?? []) {
    try {
      await callApi(ctx.chromeSession, 'workspace.remove', [ws.id])
    } catch (err) {
      logEvent('close-all', 'WARN', `워크스페이스 ${ws.id} 제거 실패: ${err.message}`)
    }
  }
  logEvent('close-all', 'OK', '스트레스용 워크스페이스 A/B 제거 완료')

  const remaining = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
  logEvent('close-all', 'OK', `정리 후 원래 워크스페이스 잔여 탭 ${remaining.length}개`)
}

// ── 에러 로그 스캔 ───────────────────────────────────────────────────────

function scanLogForErrors(filePath, label) {
  if (!fs.existsSync(filePath)) return { label, lines: [] }
  const text = fs.readFileSync(filePath, 'utf8')
  const lines = text.split(/\r?\n/)
  const patterns = [
    /uncaughtException/i,
    /unhandledRejection/i,
    /preload-error/i,
    /\bpanic\b/i,
    /did-fail-load/i, // 사용자 취소(-3)는 아래에서 후처리로 제외
  ]
  const hits = []
  for (const line of lines) {
    if (!line.trim()) continue
    if (/did-fail-load/i.test(line) && /code=-3\b/.test(line)) continue // 사용자 취소 제외
    if (patterns.some((p) => p.test(line))) hits.push(line)
  }
  return { label, lines: hits }
}

// ── 메인 오케스트레이션 ──────────────────────────────────────────────────

async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('[stress-cdp] Node 22+ 필요 (전역 WebSocket 없음). node -v 로 버전 확인.')
    process.exit(2)
  }

  const args = parseArgs(process.argv.slice(2))
  fs.mkdirSync(args.out, { recursive: true })

  if (!fs.existsSync(args.exe)) {
    console.error(`[stress-cdp] exe 를 찾을 수 없음: ${args.exe}`)
    process.exit(1)
  }

  console.log(`[stress-cdp] exe=${args.exe}`)
  console.log(`[stress-cdp] out=${args.out}`)
  console.log(`[stress-cdp] port=${args.port}`)

  await cleanupStaleProcess(args.out)
  seedProfile(args.profileDir)

  const pageServer = await startPageServer()
  console.log(`[stress-cdp] 로컬 렌더 부하 테스트 서버: ${pageServer.base}`)

  const { child } = launchApp(args.exe, args.out, args.port, args.profileDir)

  const ctx = {
    port: args.port,
    outDir: args.out,
    appPid: child.pid,
    chromeSession: null,
    memSession: null,
    windowId: null,
    pageServer,
    openSessions: [],
    stressTabs: [],
    stressWorkspaces: [],
  }

  let fatalErr = null
  try {
    console.log('\n[stress-cdp] === 1) 부팅 + baseline RSS ===')
    await stageBoot(ctx)
    await sampleRss(ctx, 'baseline')

    console.log('\n[stress-cdp] === 2) 50탭 개장 ===')
    await stageOpen50Tabs(ctx)
    await sampleRss(ctx, 'after-50-tabs')

    console.log('\n[stress-cdp] === 3) 탭 순회 (앞→뒤→앞) ===')
    await stageTraverseTabs(ctx)
    await sampleRss(ctx, 'after-traversal')

    console.log('\n[stress-cdp] === 4) 워크스페이스 3개 라운드로빈 10회 ===')
    await stageWorkspaceCycle(ctx)
    await sampleRss(ctx, 'after-workspace-cycle')

    console.log('\n[stress-cdp] === 5) 탭 슬립 수동 트리거 ===')
    await stageManualSleepSweep(ctx) // 내부에서 before/after-sweep 샘플링

    console.log('\n[stress-cdp] === 6) 대량 탭 닫기 ===')
    await stageCloseAll(ctx)
    await sampleRss(ctx, 'after-close-all')
  } catch (err) {
    fatalErr = err
    console.error(`[stress-cdp] 치명적 오류 — 시나리오 중단: ${err.stack ?? err.message}`)
    logEvent('fatal', 'FAIL', err.message)
  }

  for (const s of ctx.openSessions) s.close()
  await pageServer.close().catch(() => {})

  // 앱을 먼저 정상 종료해 로그 파일이 flush 되도록 한다.
  console.log('\n[stress-cdp] 앱 종료…')
  if (!args.keepAlive) {
    await killApp(child, args.port, args.out)
    await sleep(500)
  }

  const stdoutScan = scanLogForErrors(path.join(args.out, 'app-stdout.log'), 'stdout')
  const stderrScan = scanLogForErrors(path.join(args.out, 'app-stderr.log'), 'stderr')
  const errorHits = [...stdoutScan.lines.map((l) => `[stdout] ${l}`), ...stderrScan.lines.map((l) => `[stderr] ${l}`)]

  // RSS 추이 해석: baseline 대비 close-all 후 값이 50탭/사이클 진행 중 피크보다 충분히 낮아졌는지.
  const byLabel = Object.fromEntries(rssSamples.map((s) => [s.label, s]))
  const baseline = byLabel['baseline']?.totalMemoryMB ?? null
  const peak = rssSamples.reduce((m, s) => Math.max(m, s.totalMemoryMB), 0)
  const afterClose = byLabel['after-close-all']?.totalMemoryMB ?? null
  let leakVerdict = 'UNKNOWN'
  if (baseline != null && afterClose != null) {
    const recoveredFrac = peak > baseline ? (peak - afterClose) / (peak - baseline) : 1
    if (afterClose <= baseline * 1.25) leakVerdict = 'RECOVERED (baseline 근접, 25% 이내)'
    else if (recoveredFrac >= 0.6) leakVerdict = `PARTIAL_RECOVERY (peak 대비 ${(recoveredFrac * 100).toFixed(0)}% 회수)`
    else leakVerdict = `POSSIBLE_LEAK (peak 대비 ${(recoveredFrac * 100).toFixed(0)}% 만 회수, baseline=${baseline}MB peak=${peak}MB after-close=${afterClose}MB)`
  }

  const report = {
    exe: args.exe,
    startedAt: rssSamples[0]?.ts ?? Date.now(),
    finishedAt: Date.now(),
    fatalError: fatalErr ? fatalErr.message : null,
    events,
    rssSamples,
    leakVerdict,
    baselineMB: baseline,
    peakMB: peak,
    afterCloseMB: afterClose,
    manualSleepTrigger: {
      available: ctx.hasManualSleepTrigger === true,
      sweepResult: ctx.sweepResult ?? null,
    },
    workspaceIsolationLog: ctx.workspaceCycleLog ?? [],
    errorLogHits: errorHits,
  }

  fs.writeFileSync(path.join(args.out, 'stress-results.json'), JSON.stringify(report, null, 2))

  // RSS 샘플 CSV.
  const csvLines = ['label,ts,totalMemoryMB,processCount,avgCpu,tabsTotal,tabsDiscarded,tabsActive']
  for (const s of rssSamples) {
    csvLines.push([s.label, s.ts, s.totalMemoryMB, s.processCount, s.avgCpu, s.tabsTotal, s.tabsDiscarded, s.tabsActive].join(','))
  }
  fs.writeFileSync(path.join(args.out, 'rss-samples.csv'), csvLines.join('\n'))

  console.log('\n===== stress-cdp 요약 =====')
  console.table(rssSamples.map((s) => ({
    label: s.label, totalMemoryMB: s.totalMemoryMB, procs: s.processCount,
    tabsTotal: s.tabsTotal, tabsDiscarded: s.tabsDiscarded,
  })))
  console.log(`baseline=${baseline}MB peak=${peak}MB after-close=${afterClose}MB → 판정: ${leakVerdict}`)
  console.log(`수동 탭 슬립 트리거: ${ctx.hasManualSleepTrigger ? '가능(settings.tabSleepMinutes 우회)' : '불가'}`
    + (ctx.sweepResult ? ` — discarded=${ctx.sweepResult.discarded} skipped=${ctx.sweepResult.skipped}` : ''))
  console.log(`에러 로그 히트: ${errorHits.length}건`)
  if (errorHits.length > 0) {
    console.log('  ' + errorHits.slice(0, 20).join('\n  '))
    if (errorHits.length > 20) console.log(`  … 외 ${errorHits.length - 20}건 (stress-results.json 참고)`)
  }
  console.log(`결과 파일: ${path.join(args.out, 'stress-results.json')}`)
  console.log(`RSS CSV: ${path.join(args.out, 'rss-samples.csv')}`)

  if (args.keepAlive) {
    console.log('[stress-cdp] --keep-alive 지정됨 — 앱을 종료하지 않음')
    child.unref()
  }

  return fatalErr ? 1 : 0
}

main().then((code) => {
  process.exit(code ?? 0)
}).catch((err) => {
  console.error('[stress-cdp] 치명적 오류:', err)
  process.exit(2)
})
