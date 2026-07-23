#!/usr/bin/env node
// perf-breakdown.mjs — 메인 프로세스 메모리 주범 "기여도 격리 측정" 하네스.
//
// perf-measure.mjs 의 CDP 구동·WMI Private Working Set 측정 패턴을 재사용하되,
// 전체 예산 표 대신 "설정 A vs 설정 B 의 baseline(newtab 1개) private WS 차이"만 빠르게 뽑는다.
// 콜드 스타트 반복·idle CPU·탭 10개 증분 측정은 생략 — 격리 실험 1회당 수 분이 아니라 수십 초.
//
// 방법: 프로필을 두 단계로 부팅한다.
//   1) warm-up 부팅 — 어댑터/엔진 캐시(adblock engine.bin 등)를 디스크에 만든 뒤 정상 종료.
//   2) measure 부팅 — 캐시가 있는 상태로 다시 부팅, 안정화 후 메인 프로세스 private WS 표본.
// (실사용자는 브라우저를 매번 새로 설치하지 않으므로 "warm cache" 상태가 steady-state 에 더 가깝다.
//  perf-measure.mjs 의 long-session 측정도 cold-start 반복이 이미 캐시를 데운 뒤에 이뤄진다 — 동일 패턴.)
//
// 사용:
//   node build/perf-breakdown.mjs --label baseline --out <dir>/bd-baseline --port 9240
//   node build/perf-breakdown.mjs --label adblock-off --settings '{"adblock":{"enabled":false}}' --out <dir>/bd-noadblock --port 9241

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const DEFAULTS = {
  exe: path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe'),
  out: path.join(REPO_ROOT, 'perf-breakdown-out'),
  port: 9240,
  label: 'run',
  settings: '{}',
  warmupMs: 12_000,
  stabilizeMs: 8_000,
}

function parseArgs(argv) {
  const out = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--exe') out.exe = path.resolve(argv[++i] ?? '')
    else if (a === '--out') out.out = path.resolve(argv[++i] ?? '')
    else if (a === '--port') out.port = Number(argv[++i] ?? DEFAULTS.port)
    else if (a === '--label') out.label = argv[++i] ?? DEFAULTS.label
    else if (a === '--settings') out.settings = argv[++i] ?? '{}'
    else if (a === '--warmup-ms') out.warmupMs = Number(argv[++i] ?? DEFAULTS.warmupMs)
    else if (a === '--stabilize-ms') out.stabilizeMs = Number(argv[++i] ?? DEFAULTS.stabilizeMs)
    else if (a === '--single-boot') out.singleBoot = true
    else if (a === '--env') {
      const kv = argv[++i] ?? ''
      const eq = kv.indexOf('=')
      if (eq > 0) (out.extraEnv ??= {})[kv.slice(0, eq)] = kv.slice(eq + 1)
    }
    else console.warn(`[perf-breakdown] 알 수 없는 인자 무시: ${a}`)
  }
  out.profileDir = path.join(out.out, 'profile')
  return out
}

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
  let lastErr
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn()
      if (v) return v
      lastErr = null
    } catch (err) { lastErr = err }
    await sleep(intervalMs)
  }
  const suffix = lastErr ? ` (마지막 오류: ${lastErr.message})` : ''
  throw new Error(`timeout(${timeoutMs}ms) waiting for ${label}${suffix}`)
}

function procFilePath(outDir) { return path.join(outDir, 'app-proc.json') }
function readProcFile(outDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(procFilePath(outDir), 'utf8'))
    return typeof parsed?.pid === 'number' ? parsed : null
  } catch { return null }
}
function writeProcFile(outDir, info) { try { fs.writeFileSync(procFilePath(outDir), JSON.stringify(info)) } catch {} }
function removeProcFile(outDir) { try { fs.unlinkSync(procFilePath(outDir)) } catch {} }

function killPidTree(pid) {
  if (!pid) return
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
}
function isPidAlive(pid) {
  if (!pid) return false
  const res = spawnSync('powershell', ['-NoProfile', '-Command',
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Write-Output 'alive' }`], { encoding: 'utf8' })
  return (res.stdout || '').includes('alive')
}

async function tryGracefulShutdown(port, timeoutMs = 3000) {
  try {
    const res = await withTimeout(fetch(`http://127.0.0.1:${port}/json/version`), timeoutMs, 'graceful shutdown')
    if (!res.ok) return false
    const info = await res.json()
    if (!info.webSocketDebuggerUrl) return false
    const s = new CDPSession(info.webSocketDebuggerUrl, 'browser-close')
    await s.connect(timeoutMs)
    await s.send('Browser.close', {}, timeoutMs).catch(() => {})
    s.close()
    return true
  } catch { return false }
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) { resolve(true); return }
    const t = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => { clearTimeout(t); resolve(true) })
  })
}

async function cleanupStaleProcess(outDir) {
  const stale = readProcFile(outDir)
  if (!stale) return
  if (isPidAlive(stale.pid)) {
    const graceful = await tryGracefulShutdown(stale.port)
    if (graceful) await sleep(1500)
    if (isPidAlive(stale.pid)) killPidTree(stale.pid)
  }
  removeProcFile(outDir)
}

function launchApp(exePath, outDir, port, profileDir, tag, extraEnv) {
  const env = { ...process.env, ...(extraEnv ?? {}) }
  delete env.ELECTRON_RUN_AS_NODE
  const stdoutStream = fs.createWriteStream(path.join(outDir, `app-stdout${tag ?? ''}.log`))
  const stderrStream = fs.createWriteStream(path.join(outDir, `app-stderr${tag ?? ''}.log`))
  const child = spawn(exePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
  ], { env, cwd: path.dirname(exePath), stdio: ['ignore', 'pipe', 'pipe'], detached: false, windowsHide: false })
  child.stdout?.pipe(stdoutStream)
  child.stderr?.pipe(stderrStream)
  writeProcFile(outDir, { pid: child.pid, port })
  return child
}

async function killApp(child, port, outDir) {
  if (!child || child.exitCode !== null) { removeProcFile(outDir); return }
  const graceful = await tryGracefulShutdown(port)
  if (graceful) {
    const exited = await waitForExit(child, 5000)
    if (exited) { removeProcFile(outDir); return }
  }
  try { child.kill() } catch {}
  killPidTree(child.pid)
  removeProcFile(outDir)
}

class CDPSession {
  constructor(wsUrl, label) { this.wsUrl = wsUrl; this.label = label; this.ws = null; this._id = 0; this.pending = new Map() }
  async connect(timeoutMs = 10_000) {
    this.ws = new WebSocket(this.wsUrl)
    await withTimeout(new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', (e) => reject(new Error(`ws error: ${e?.message ?? 'unknown'}`)))
    }), timeoutMs, `CDP ws connect (${this.label})`)
    this.ws.addEventListener('message', (ev) => this._onMessage(ev))
    this.ws.addEventListener('close', () => { for (const [, p] of this.pending) p.reject(new Error('ws closed')); this.pending.clear() })
  }
  _onMessage(ev) {
    let msg; try { msg = JSON.parse(ev.data) } catch { return }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(`CDP error [${msg.error.code}]: ${msg.error.message}`)); else resolve(msg.result)
    }
  }
  send(method, params = {}, timeoutMs = 15_000) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error(`CDP session not open (${this.label})`))
    const id = (this._id += 1)
    const p = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.ws.send(JSON.stringify({ id, method, params }))
    return withTimeout(p, timeoutMs, `CDP ${method} (${this.label})`)
  }
  close() { try { this.ws?.close() } catch {} }
}

async function connectSession(target, label) {
  const s = new CDPSession(target.webSocketDebuggerUrl, label ?? target.id)
  await s.connect()
  return s
}

async function evaluate(session, expression, opts = {}) {
  const { awaitPromise = true, returnByValue = true, timeoutMs = 15_000 } = opts
  const result = await session.send('Runtime.evaluate', { expression, awaitPromise, returnByValue, userGesture: true }, timeoutMs)
  if (result.exceptionDetails) {
    const ex = result.exceptionDetails
    throw new Error(`JS exception in ${session.label}: ${ex.exception?.description || ex.text || JSON.stringify(ex)}`)
  }
  return result.result?.value
}

function callApi(session, apiPath, args = []) {
  const argStr = args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(', ')
  return evaluate(session, `window.browserAPI.${apiPath}(${argStr})`)
}
function callInternal(session, apiPath, args = []) {
  const argStr = args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(', ')
  return evaluate(session, `window.internalAPI.${apiPath}(${argStr})`)
}

async function getTargetList(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`)
  return res.json()
}
function isShellTarget(t) {
  return t.type === 'page' && typeof t.url === 'string' && t.url.startsWith('file://') && t.url.includes('index.html') && t.url.includes('windowId=')
}
async function waitForShellTarget(port, timeoutMs = 30_000) {
  let lastList = []
  return pollUntil(async () => { lastList = await getTargetList(port); return lastList.find(isShellTarget) ?? null },
    { timeoutMs, intervalMs: 400, label: 'shell CDP target' }).catch((err) => {
      throw new Error(`${err.message}\n마지막 타깃: ${lastList.map((t) => `${t.type}:${t.url}`).join('\n  ')}`)
    })
}

function queryProcessCounters(pids) {
  if (!pids || pids.length === 0) return []
  const cond = pids.map((p) => `$_.IDProcess -eq ${Number(p)}`).join(' -or ')
  const script = `$ProgressPreference='SilentlyContinue'; `
    + `$rows = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue `
    + `| Where-Object { ${cond} } | Select-Object IDProcess, Name, WorkingSet, WorkingSetPrivate; `
    + `$rows | ConvertTo-Json -Compress`
  const res = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (res.status !== 0 || !res.stdout) return []
  let out
  try { out = JSON.parse(res.stdout.trim() || '[]') } catch { return [] }
  const arr = Array.isArray(out) ? out : (out ? [out] : [])
  return arr.map((r) => ({ pid: r.IDProcess, name: r.Name, workingSetBytes: r.WorkingSet, privateWorkingSetBytes: r.WorkingSetPrivate }))
}

async function sampleMemory(session) {
  const metrics = await callInternal(session, 'system.metrics')
  const pids = metrics.processes.map((p) => p.pid)
  const wmiByPid = new Map(queryProcessCounters(pids).map((r) => [r.pid, r]))
  const merged = metrics.processes.map((p) => {
    const w = wmiByPid.get(p.pid)
    return {
      pid: p.pid, type: p.type, name: p.name ?? null,
      workingSetMB_electron: p.memoryMB,
      privateWorkingSetMB_wmi: w ? Math.round(w.privateWorkingSetBytes / 1024 / 1024) : null,
    }
  })
  const mainProc = merged.find((p) => p.type === 'Browser') ?? null
  return {
    processes: merged,
    totalWorkingSetElectronMB: metrics.totals.memoryMB,
    totalPrivateWorkingSetMB: merged.reduce((s, r) => s + (r.privateWorkingSetMB_wmi ?? 0), 0),
    mainPrivateWorkingSetMB: mainProc?.privateWorkingSetMB_wmi ?? null,
    mainWorkingSetElectronMB: mainProc?.workingSetMB_electron ?? null,
    processCount: merged.length,
  }
}

// ── 격리 프로필 시드 ─────────────────────────────────────────────────────
function deepMerge(base, patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch
  const out = { ...base }
  for (const k of Object.keys(patch)) {
    out[k] = deepMerge(base?.[k], patch[k])
  }
  return out
}

function seedProfile(profileDir, settingsPatch) {
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const base = {
    setup: { completed: true, completedAt: Date.now(), version: 'perf-breakdown' },
    startup: { mode: 'newtab', urls: [] },
  }
  const merged = deepMerge(base, settingsPatch)
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify(merged, null, 2))
}

async function bootAndGetSessions(exe, out, port, profileDir, tag, extraEnv) {
  const child = launchApp(exe, out, port, profileDir, tag, extraEnv)
  const shellTarget = await waitForShellTarget(port, 30_000)
  const chromeSession = await connectSession(shellTarget, `chrome${tag}`)
  const windowId = await pollUntil(
    () => evaluate(chromeSession, `new URL(location.href).searchParams.get('windowId')`),
    { timeoutMs: 8_000, intervalMs: 300, label: 'windowId' },
  )
  if (!windowId) throw new Error('windowId 를 읽지 못함')
  let controlTarget
  try {
    controlTarget = await pollUntil(async () => {
      const list = await getTargetList(port)
      return list.find((t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith('browser://')) ?? null
    }, { timeoutMs, intervalMs: 300, label: 'default internal tab' })
  } catch {
    await callApi(chromeSession, 'tabs.create', [windowId, 'browser://newtab'])
    controlTarget = await pollUntil(async () => {
      const list = await getTargetList(port)
      return list.find((t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith('browser://')) ?? null
    }, { timeoutMs: 10_000, intervalMs: 300, label: 'fallback internal tab' })
  }
  const controlSession = await connectSession(controlTarget, `control${tag}`)
  return { child, chromeSession, controlSession, windowId }
}
const timeoutMs = 8_000

async function runOne(args) {
  fs.mkdirSync(args.out, { recursive: true })
  console.log(`\n[perf-breakdown:${args.label}] settings patch = ${args.settings}`)
  await cleanupStaleProcess(args.out)
  const settingsPatch = JSON.parse(args.settings)
  seedProfile(args.profileDir, settingsPatch)

  // ── 1) warm-up 부팅: 캐시(adblock engine.bin 등) 를 디스크에 만든다 (--single-boot 면 생략 —
  //      "설치 후 첫 실행"처럼 캐시 없는 상태를 그대로 측정) ──
  if (!args.singleBoot) {
    console.log(`[perf-breakdown:${args.label}] warm-up 부팅 (캐시 빌드) …`)
    const { child, chromeSession, controlSession } = await bootAndGetSessions(args.exe, args.out, args.port, args.profileDir, '-warm', args.extraEnv)
    await sleep(args.warmupMs)
    try { controlSession.close() } catch {}
    try { chromeSession.close() } catch {}
    await killApp(child, args.port, args.out)
    await sleep(1000)
  } else {
    console.log(`[perf-breakdown:${args.label}] --single-boot: warm-up 생략(캐시 없는 콜드 상태 유지)`)
  }

  // ── 2) measure 부팅: 캐시 warm 상태에서 안정화 후 표본 ──
  console.log(`[perf-breakdown:${args.label}] measure 부팅 …`)
  let result = { ok: false, label: args.label }
  {
    let child, chromeSession, controlSession
    try {
      ({ child, chromeSession, controlSession } = await bootAndGetSessions(args.exe, args.out, args.port, args.profileDir, '-measure', args.extraEnv))
      console.log(`[perf-breakdown:${args.label}] 안정화 대기(${args.stabilizeMs}ms) …`)
      await sleep(args.stabilizeMs)
      const sample = await sampleMemory(controlSession)
      result = { ok: true, label: args.label, settings: settingsPatch, sample }
      console.log(`[perf-breakdown:${args.label}] main(Browser) private WS = ${sample.mainPrivateWorkingSetMB}MB  전체 private WS = ${sample.totalPrivateWorkingSetMB}MB  procs=${sample.processCount}`)
      console.table(sample.processes)
    } catch (err) {
      result = { ok: false, label: args.label, error: err.message }
      console.error(`[perf-breakdown:${args.label}] ✗ 실패: ${err.message}`)
    } finally {
      try { controlSession?.close() } catch {}
      try { chromeSession?.close() } catch {}
      await killApp(child, args.port, args.out)
    }
  }

  fs.writeFileSync(path.join(args.out, 'result.json'), JSON.stringify(result, null, 2))
  return result
}

async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('[perf-breakdown] Node 22+ 필요 (전역 WebSocket 없음).')
    process.exit(2)
  }
  const args = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(args.exe)) {
    console.error(`[perf-breakdown] exe 를 찾을 수 없음: ${args.exe}`)
    process.exit(1)
  }
  const result = await runOne(args)
  process.exit(result.ok ? 0 : 1)
}

main().catch((err) => { console.error('[perf-breakdown] 치명적 오류:', err); process.exit(2) })
