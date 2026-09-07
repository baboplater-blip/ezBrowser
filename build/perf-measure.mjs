#!/usr/bin/env node
// perf-measure.mjs — 가벼움 예산(1원칙 #1) 정밀 측정 하네스. 게이트 4.
//
// smoke-cdp.mjs 와 동일한 CDP 기반 구동 패턴(의존성 0 — Node 22+ 내장 WebSocket/fetch 만 사용)을
// 재사용하되, 기능 시나리오 대신 "가벼움 예산" 수치(콜드 스타트·메모리·CPU·번들 크기)를 정밀 측정한다.
//
// 핵심 동기: app.getAppMetrics().memory.workingSetSize 합산(= 기존 perf 모듈·browser://memory 가
// 쓰는 값)은 프로세스 간 공유 페이지(Chromium 바이너리 등)를 중복 집계해 실제 물리 메모리
// 증가분보다 부풀려진다. 이 하네스는 Windows WMI(Win32_PerfFormattedData_PerfProc_Process)로
// "Private Working Set"(Task Manager 의 "메모리(비공개 작업 집합)" 컬럼과 동일 지표)을
// PID 단위로 교차 측정해 WorkingSet 과 나란히 보고한다.
//
// 격리·안전성: smoke-cdp.mjs 와 동일 — 격리 --user-data-dir, PID 스코프 종료(이름 기반 금지),
// 이전 실행이 남긴 PID 만 정리.
//
// 사용:
//   node build/perf-measure.mjs [--exe <path>] [--out <dir>] [--port <n>]
//                                [--cold-runs <n>] [--idle-minutes <n>]

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  CDPSession,
  connectSession,
  connectShellSessionReady,
  getTargetList,
  isShellTarget,
  waitForPortFree,
  waitForShellTarget,
  waitForTargetByUrlPredicate,
} from './lib/cdp.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const DEFAULTS = {
  exe: path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe'),
  out: path.join(REPO_ROOT, 'perf-out'),
  port: 9228,
  coldRuns: 3,
  idleMinutes: 3,
  // 빈 창 baseline 은 한 시점이 아니라 여러 표본의 **중앙값**으로 판정한다(단일 시점은
  // 그 순간의 GC·지연 초기화 상태에 좌우돼 예산선을 넘나든다 — 2026-09-07 실측).
  baselineSamples: 5,
  baselineIntervalMs: 4000,
  forceCold: false,
  // adblock 을 끈 baseline 도 함께 재서 "우리 코드"와 "adblock 비용"을 분리 판정한다.
  // (2026-09-07 실측: adblock 이 빈 창 메모리의 110MB, 약 44% — 이걸 섞어 놓으면
  //  게이트가 우리 코드의 회귀를 adblock 비용에 묻어 놓친다.)
  dual: true,
}

const BUDGET = {
  coldStartMs: 2000,
  // 빈 창 RSS 예산 250MB 는 **웜(2번째 이후 실행 = 실사용 절대다수)** 기준이다.
  blankWindowMemoryMB: 250,
  // 콜드(설치 후 첫 실행)는 adblock 이 필터 원문을 받아 엔진을 빌드하므로 고정비가 더 붙는다.
  // CLAUDE.md 의 완화 조항("콜드 예산은 250 + adblock 고정비로 자동 완화")을 코드로 옮긴 값.
  // 근거 실측: V4(2026-07-11) 콜드 285 / 웜 226 → 차 59MB. 2026-09-07 콜드 289 / 웜 243~249 → 차 40~46MB.
  // 두 측정을 모두 덮도록 60MB 로 둔다(콜드 예산 = 310MB). 이 값을 올려야 할 상황이 오면
  // 그것은 완화가 아니라 **adblock 콜드 빌드 비용이 실제로 늘었다는 신호**이므로 조사할 것.
  adblockColdAllowanceMB: 60,
  // **판정 1순위** — adblock 을 제외한 빈 창(= 우리가 통제하는 코드).
  //
  // adblock 은 콕콕 핵심이라 끌 수 없는 고정비(2026-09-07 실측 103~110MB)이고, 그걸 섞어서
  // 판정하면 **우리 코드의 회귀가 adblock 비용에 묻힌다**. 그래서 축을 나눈다.
  //
  // 값의 근거(2026-09-07 dual 3회 실측): adblock 제외 **149 · 146 · 149MB**(측정 노이즈 ±1.5MB).
  // 예산 = 중앙값 149 + 6MB(≈ 노이즈의 3배). 이 여유는 **측정 흔들림은 통과시키되
  // 5MB 이상의 실제 증가는 잡는** 크기다. 새로 세우는 축이므로 기존 예산의 완화가 아니다.
  // 이 값을 올려야 할 상황이 오면 그것은 **우리 코드가 커졌다는 신호**이므로 조사부터 할 것.
  blankWindowNoAdblockMB: 155,
  perTabMemoryMB: 80,
  idleCpuPercent: 0.5,
  rendererJsGzipKB: 500,
}

function parseArgs(argv) {
  const out = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--exe') out.exe = path.resolve(argv[++i] ?? '')
    else if (a === '--out') out.out = path.resolve(argv[++i] ?? '')
    else if (a === '--port') out.port = Number(argv[++i] ?? DEFAULTS.port)
    else if (a === '--cold-runs') out.coldRuns = Number(argv[++i] ?? DEFAULTS.coldRuns)
    else if (a === '--idle-minutes') out.idleMinutes = Number(argv[++i] ?? DEFAULTS.idleMinutes)
    else if (a === '--baseline-samples') out.baselineSamples = Math.max(1, Number(argv[++i] ?? DEFAULTS.baselineSamples))
    else if (a === '--cold') out.forceCold = true
    else if (a === '--dual') out.dual = true
    else if (a === '--no-dual') out.dual = false
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else console.warn(`[perf-measure] 알 수 없는 인자 무시: ${a}`)
  }
  out.profileDir = path.join(out.out, 'profile')
  return out
}

function printHelp() {
  console.log(`
perf-measure — 가벼움 예산(1원칙 #1) 정밀 측정 하네스

사용: node build/perf-measure.mjs [옵션]

옵션:
  --exe <path>        패키징된 exe 경로 (기본: dist/win-unpacked/ezBrowser.exe)
  --out <dir>         결과 저장 디렉터리
  --port <n>          --remote-debugging-port 값 (기본: 9228)
  --cold-runs <n>      콜드 스타트 반복 횟수 (기본: 3)
  --idle-minutes <n>  idle CPU 샘플링 시간(분) (기본: 3)
  --baseline-samples <n>  빈 창 baseline 표본 수, 중앙값으로 판정 (기본: 5)
  --cold              프로필을 비워 **콜드 경로**(adblock 캐시 없음)를 일부러 측정
                      (기본은 웜 = 2번째 이후 실행, 실사용 절대다수)
  --no-dual           adblock 제외 baseline 측정을 생략(기본은 측정 — 판정 1순위)
`.trim())
}

// ── 공통 유틸 ────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout(${ms}ms): ${label}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// adblock 은 부팅 ~1500ms 후 지연 init 되고(app/main/index.ts), 필터 리스트 역직렬화(또는 콜드
// 빌드면 파싱)·GC 넛지까지 마쳐야 실사용 절대다수(2번째 이후 실행)가 겪는 "웜" 메모리 상태에
// 도달한다(app/main/features/adblock/index.ts 의 콜드≈231MB→웜≈166MB 관찰 주석 참고). 이 완료를
// 기다리지 않고 고정 시간만 대기하면 초기화가 채 끝나지 않은 "콜드" 순간을 baseline 으로 잘못
// 잡을 수 있다 — [adblock] initialized stdout 로그를 직접 폴링해 실제 완료를 확인한다.
async function waitForLogLine(filePath, needle, { timeoutMs = 20_000, intervalMs = 300 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (fs.readFileSync(filePath, 'utf8').includes(needle)) return true
    } catch { /* 로그 파일이 아직 생성되지 않았을 수 있음 — 계속 폴링 */ }
    await sleep(intervalMs)
  }
  return false
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

// ── 프로세스 관리 (PID 스코프 — smoke-cdp.mjs 와 동일 패턴) ───────────────

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
  if (res.error) console.warn('[perf-measure] taskkill 실행 오류(무시):', res.error.message)
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
    await browserSession.send('Browser.close', {}, timeoutMs).catch(() => { /* Electron 미지원이어도 무방 — 폴백 사용 */ })
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
  console.log(`[perf-measure] 이전 실행이 남긴 프로세스 발견 (pid=${stale.pid}, port=${stale.port}) — 정리 시도…`)
  if (isPidAlive(stale.pid)) {
    const graceful = await tryGracefulShutdown(stale.port)
    if (graceful) await sleep(1500)
    if (isPidAlive(stale.pid)) killPidTree(stale.pid)
  }
  removeProcFile(outDir)
}

function launchApp(exePath, outDir, port, profileDir, tag) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // Electron 이 일반 Node 모드로 뜨는 것 방지 (알려진 환경 이슈)

  const stdoutPath = path.join(outDir, `app-stdout${tag ?? ''}.log`)
  const stderrPath = path.join(outDir, `app-stderr${tag ?? ''}.log`)
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

// ── 격리 프로필 ──────────────────────────────────────────────────────────
// 실사용자 프로필(%APPDATA%/browser-build)과 완전히 분리. startup.mode='newtab' 고정으로
// 매 실행이 "빈 창(newtab 1개)" 이라는 동일 출발선에서 시작하게 한다(세션 복원/온보딩 배제).
// 정상 종료(before-quit)마다 current.json 이 정리되므로, 같은 프로필을 콜드 스타트 반복에
// 재사용해도 두 번째 실행부터 "비정상 종료 복원 여부" 다이얼로그가 뜨지 않는다.

function seedProfile(profileDir, reset) {
  if (reset) fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const settingsPath = path.join(profileDir, 'settings.json')
  if (!fs.existsSync(settingsPath)) {
    const seed = {
      setup: { completed: true, completedAt: Date.now(), version: 'perf-measure' },
      startup: { mode: 'newtab', urls: [] },
    }
    fs.writeFileSync(settingsPath, JSON.stringify(seed, null, 2))
  }
}

/** 프로필의 settings.json 을 부분 갱신한다(dual 모드에서 adblock 을 껐다 켜기 위함). */
function patchProfileSettings(profileDir, patch) {
  const settingsPath = path.join(profileDir, 'settings.json')
  let cur = {}
  try { cur = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch { /* 없으면 새로 */ }
  const merged = { ...cur }
  for (const [k, v] of Object.entries(patch)) {
    merged[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? { ...(cur[k] ?? {}), ...v } : v
  }
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2))
}

// ── CDP 클라이언트 (smoke-cdp.mjs 와 동일) ────────────────────────────────

async function evaluate(session, expression, opts = {}) {
  const { awaitPromise = true, returnByValue = true, timeoutMs = 15_000 } = opts
  const result = await session.send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue, userGesture: true,
  }, timeoutMs)
  if (result.exceptionDetails) {
    const ex = result.exceptionDetails
    const desc = ex.exception?.description || ex.text || JSON.stringify(ex)
    throw new Error(`JS exception in ${session.label}: ${desc}`)
  }
  return result.result?.value
}

function argToLiteral(a) { return a === undefined ? 'undefined' : JSON.stringify(a) }

function callApi(session, apiPath, args = [], opts) {
  const argStr = args.map(argToLiteral).join(', ')
  return evaluate(session, `window.browserAPI.${apiPath}(${argStr})`, opts)
}

function callInternal(session, apiPath, args = [], opts) {
  const argStr = args.map(argToLiteral).join(', ')
  return evaluate(session, `window.internalAPI.${apiPath}(${argStr})`, opts)
}

// ── Windows WMI 를 통한 프로세스별 Private/전체 Working Set 측정 ──────────
// Win32_PerfFormattedData_PerfProc_Process 는 WMI 제공자가 이미 rate 계산을 끝낸
// "포맷된" 값을 준다 — WorkingSet/WorkingSetPrivate 는 게이지(그대로 바이트), PercentProcessorTime
// 은 표준 Task Manager 의 "CPU" raw 값(코어 수로 정규화되지 않음 — 이 스크립트가 별도 나눔)과 동일.
// IDProcess 로 필터링하므로 동일 이미지명(ezBrowser.exe) 프로세스가 여러 개 있어도 안전하다.

function queryProcessCounters(pids) {
  if (!pids || pids.length === 0) return []
  const cond = pids.map((p) => `$_.IDProcess -eq ${Number(p)}`).join(' -or ')
  const script = `$ProgressPreference='SilentlyContinue'; `
    + `$rows = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction SilentlyContinue `
    + `| Where-Object { ${cond} } `
    + `| Select-Object IDProcess, Name, WorkingSet, WorkingSetPrivate, PercentProcessorTime; `
    + `$rows | ConvertTo-Json -Compress`
  const res = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (res.status !== 0 || !res.stdout) return []
  let out
  try { out = JSON.parse(res.stdout.trim() || '[]') } catch { return [] }
  const arr = Array.isArray(out) ? out : (out ? [out] : [])
  return arr.map((r) => ({
    pid: r.IDProcess, name: r.Name,
    workingSetBytes: r.WorkingSet, privateWorkingSetBytes: r.WorkingSetPrivate,
    percentProcessorTime: r.PercentProcessorTime,
  }))
}

function logicalCoreCount() {
  const res = spawnSync('powershell', ['-NoProfile', '-Command',
    '(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors'], { encoding: 'utf8' })
  const n = Number((res.stdout || '').trim())
  return Number.isFinite(n) && n > 0 ? n : 1
}

// ── 앱 내부 계측(Electron app.getAppMetrics()) — internalAPI.system.metrics() 경유 ─

async function getMetrics(session) {
  return callInternal(session, 'system.metrics')
}

async function getPerfReport(session) {
  return callInternal(session, 'perf.report')
}

// PID 목록을 internalAPI.system.metrics() 에서 얻고, 같은 PID 를 WMI 로 교차 조회해
// WorkingSet(Electron 자체 집계) · WorkingSet(WMI) · Private WorkingSet(WMI) 3열을 병합한다.
async function sampleMemory(session, label) {
  const metrics = await getMetrics(session)
  const pids = metrics.processes.map((p) => p.pid)
  const wmiRows = queryProcessCounters(pids)
  const wmiByPid = new Map(wmiRows.map((r) => [r.pid, r]))
  const cores = logicalCoreCount()
  const merged = metrics.processes.map((p) => {
    const w = wmiByPid.get(p.pid)
    return {
      pid: p.pid,
      type: p.type,
      name: p.name ?? null,
      workingSetMB_electron: p.memoryMB,
      workingSetMB_wmi: w ? Math.round(w.workingSetBytes / 1024 / 1024) : null,
      privateWorkingSetMB_wmi: w ? Math.round(w.privateWorkingSetBytes / 1024 / 1024) : null,
      cpuPercent_electron: p.cpu,
      cpuPercent_wmi_raw: w ? w.percentProcessorTime : null,
      cpuPercent_wmi_normalized: w ? Number((w.percentProcessorTime / cores).toFixed(2)) : null,
    }
  })
  const totalWorkingSetElectronMB = metrics.totals.memoryMB
  const totalWorkingSetWmiMB = merged.reduce((s, r) => s + (r.workingSetMB_wmi ?? 0), 0)
  const totalPrivateWorkingSetMB = merged.reduce((s, r) => s + (r.privateWorkingSetMB_wmi ?? 0), 0)
  const wmiMatchedCount = merged.filter((r) => r.privateWorkingSetMB_wmi !== null).length
  return {
    label,
    at: new Date().toISOString(),
    processes: merged,
    totalWorkingSetElectronMB,
    totalWorkingSetWmiMB,
    totalPrivateWorkingSetMB,
    wmiMatchedCount,
    processCount: merged.length,
    tabs: metrics.tabs,
  }
}

// ── 콜드 스타트 3회 측정 ───────────────────────────────────────────────────
// CLAUDE.md 정의: app.whenReady() → window.show() ≈ firstWindowReadyMs (main/index.ts 의
// runStartup 이 chrome shell 의 'did-finish-load' 에서 recordFirstWindowReady() 를 호출하는데,
// 이는 window-service.ts 의 win.show() 를 트리거하는 바로 그 'did-finish-load' 이벤트와 동일 틱
// — 두 리스너 모두 같은 이벤트에 등록되어 win.show() 가 먼저(등록 순서상) 실행된다).
// browserAPI(chrome shell 전용)에는 perf/system 네임스페이스가 없으므로, browser:// 내부 페이지
// 탭을 하나 열어 internalAPI.perf.report() 로 마일스톤을 읽는다.

async function measureColdStart(args) {
  const runs = []
  for (let i = 1; i <= args.coldRuns; i++) {
    console.log(`\n[cold-start] 실행 ${i}/${args.coldRuns} …`)
    await cleanupStaleProcess(args.out)
    seedProfile(args.profileDir, i === 1) // 첫 회차만 프로필 초기화, 이후는 재사용(정상 종료로 current.json 정리됨)
    const t0 = Date.now()
    if (!(await waitForPortFree(args.port))) {
      // 좀비 인스턴스가 디버그 포트를 쥐고 있으면 /json/list 가 죽은 타깃을 돌려준다.
      // 남의(또는 시체의) 브라우저를 검사하느니 큰 소리로 실패한다.
      throw new Error(`디버그 포트 ${args.port} 가 이미 사용 중입니다 — 남은 인스턴스를 종료하거나 다른 포트를 지정하세요.`)
    }
    const { child, stdoutPath } = launchApp(args.exe, args.out, args.port, args.profileDir, `-cold${i}`)
    let record = { run: i, ok: false }
    try {
      const chromeSession = await connectShellSessionReady(args.port, {
        label: `chrome-cold${i}`,
        log: (msg) => console.log(`[perf-measure] ${msg}`),
      })
      const windowId = await evaluate(chromeSession, `new URL(location.href).searchParams.get('windowId')`)
      if (!windowId) throw new Error('windowId 를 읽지 못함')

      // perf.report() 를 읽기 위한 internal 페이지 탭을 하나 연다(측정 전용 — 콜드 스타트
      // 마일스톤은 이미 latched 되어 있으므로 이 탭 생성 자체는 firstWindowReadyMs 에 영향 없음).
      await callApi(chromeSession, 'tabs.create', [windowId, 'browser://memory'])
      const memTarget = await waitForTargetByUrlPredicate(
        args.port, (u) => u.startsWith('browser://memory'), 'cold-start internal target', 15_000,
      )
      const memSession = await connectSession(memTarget, `mem-cold${i}`)

      const report = await pollUntil(async () => {
        const r = await getPerfReport(memSession)
        return r?.current?.firstWindowReadyMs != null ? r : null
      }, { timeoutMs: 10_000, label: 'perf milestones populated' })

      const harnessMs = Date.now() - t0
      record = {
        run: i, ok: true,
        whenReadyMs: report.current.whenReadyMs,
        firstWindowReadyMs: report.current.firstWindowReadyMs,
        firstTabLoadedMs: report.current.firstTabLoadedMs,
        harnessObservedMs: harnessMs, // 참고용(spawn 부터 측정 완료까지 — 프로세스 생성 오버헤드 포함, 예산 판정에는 미사용)
      }
      console.log(`  whenReadyMs=${record.whenReadyMs} firstWindowReadyMs=${record.firstWindowReadyMs} firstTabLoadedMs=${record.firstTabLoadedMs}`)

      memSession.close()
      chromeSession.close()
    } catch (err) {
      record = { run: i, ok: false, error: err.message }
      console.error(`  ✗ 실패: ${err.message}`)
    } finally {
      // killApp 전에 adblock 지연 init(engine.bin 캐시 빌드+영속화)이 끝날 기회를 준다. 콜드 스타트
      // 타이밍 자체(firstWindowReadyMs 등)는 이미 위에서 latch 되어 기록이 끝난 뒤라 영향 없음 —
      // 다만 과거엔 이 직후 바로 죽여서 캐시가 전혀 만들어지지 않아, 프로필을 그대로 물려받는
      // long-session 이 "매번" 콜드 빌드를 측정하는 근본 원인이었다(측정 시점을 아무리 늦춰도
      // 캐시 자체가 없으면 웜이 될 수 없음). 여기서 한 번이라도 캐시를 만들어두면 이후 콜드런과
      // long-session 모두 웜(역직렬화) 경로를 안정적으로 타게 된다. 실패해도 치명적이지 않음 —
      // 폴백으로 long-session 쪽 대기가 여전히 콜드 상태를 정확히 측정해 보고한다.
      const adblockReady = await waitForLogLine(stdoutPath, '[adblock] initialized', { timeoutMs: 15_000 })
      console.log(adblockReady
        ? '  (adblock 캐시 빌드 확인 — 이후 실행부터 웜 경로)'
        : '  ⚠ adblock 초기화 로그를 15s 내 확인 못함(캐시 미생성 가능)')
      await killApp(child, args.port, args.out)
      await sleep(1000)
    }
    runs.push(record)
  }
  return runs
}

// ── 장기 세션: 빈 창 RSS · 탭당 RSS 증가 · idle CPU ────────────────────────

async function measureLongSession(args) {
  console.log('\n[long-session] 시작 …')
  await cleanupStaleProcess(args.out)
  // 기본은 웜(콜드 스타트 단계에서 만들어진 프로필·adblock 캐시 재사용) — 실사용 절대다수가
  // 겪는 "2번째 이후 실행"이 판정 기준이기 때문이다. --cold 는 캐시를 지워 콜드 경로를 강제한다.
  seedProfile(args.profileDir, args.forceCold)
  // 콜드 스타트 마지막 회차의 graceful shutdown 직후라 OS 가 이전 프로세스의 디버그 포트 소켓을
  // 아직 완전히 회수하지 못했을 수 있음 — 다른 포트를 쓰고 약간의 여유를 둔다.
  const longPort = args.port + 1
  await sleep(1500)
  if (!(await waitForPortFree(longPort))) {
    // 좀비 인스턴스가 디버그 포트를 쥐고 있으면 /json/list 가 죽은 타깃을 돌려준다.
    // 남의(또는 시체의) 브라우저를 검사하느니 큰 소리로 실패한다.
    throw new Error(`디버그 포트 ${longPort} 가 이미 사용 중입니다 — 남은 인스턴스를 종료하거나 다른 포트를 지정하세요.`)
  }
  // adblock 엔진 캐시(engine.bin)는 프로필 안에 산다. 이게 있으면 역직렬화만 하는 "웜",
  // 없으면 필터 원문을 받아 빌드하는 "콜드"다. V4 실측으로 둘의 메모리 차이가 크다는 것이
  // 확인됐으므로(웜 ≈226MB / 콜드 ≈285MB), 어느 경로를 쟀는지 **기록 없이 판정하면 안 된다**.
  const adblockCachePath = path.join(args.profileDir, 'adblock', 'engine.bin')
  let adblockCache = { existedAtLaunch: false, bytes: 0 }
  try {
    const st = fs.statSync(adblockCachePath)
    adblockCache = { existedAtLaunch: true, bytes: st.size }
  } catch { /* 없으면 콜드 */ }
  console.log(`[long-session] adblock 캐시: ${adblockCache.existedAtLaunch ? `있음(${(adblockCache.bytes / 1048576).toFixed(1)}MB) → 웜 경로` : '없음 → 콜드 경로'}`)

  const { child, stdoutPath } = launchApp(args.exe, args.out, longPort, args.profileDir, '-long')
  const result = { ok: false, adblockCache, measuredPath: adblockCache.existedAtLaunch ? 'warm' : 'cold' }
  let chromeSession = null
  let controlSession = null
  try {
    chromeSession = await connectShellSessionReady(longPort, {
      label: 'chrome-long',
      log: (msg) => console.log(`[perf-measure] ${msg}`),
    })
    // 드물게 타깃은 등장했지만 아직 location.href 가 목표 URL 로 커밋되기 전(레이스)일 수 있어 재시도.
    const windowId = await pollUntil(
      () => evaluate(chromeSession, `new URL(location.href).searchParams.get('windowId')`),
      { timeoutMs: 8_000, intervalMs: 300, label: 'windowId from shell location.href' },
    )
    if (!windowId) throw new Error('windowId 를 읽지 못함')

    // 기본 탭(browser://newtab)을 제어 채널로 재사용 — browser://memory 는 1초 폴링 타이머를
    // 자체 내장하고 있어(pages/memory) idle CPU 측정을 오염시키므로 의도적으로 피한다.
    let controlTarget
    try {
      controlTarget = await waitForTargetByUrlPredicate(
        longPort, (u) => u.startsWith('browser://'), 'default internal tab', 8_000,
      )
      result.controlTabSource = 'default-tab'
    } catch {
      // 기본 탭을 못 찾으면 폴백으로 하나 만든다(이 경우 baseline 이 "탭 2개" 가 됨 — 결과에 표기).
      await callApi(chromeSession, 'tabs.create', [windowId, 'browser://newtab'])
      controlTarget = await waitForTargetByUrlPredicate(
        longPort, (u) => u.startsWith('browser://'), 'fallback internal tab', 10_000,
      )
      result.controlTabSource = 'fallback-created'
    }
    controlSession = await connectSession(controlTarget, 'control-long')

    // ── 1) 빈 창 RSS(newtab 1개) — adblock 지연 init 완료를 확인한 뒤 baseline 측정(콜드 오염 방지) ──
    console.log('[long-session] adblock 지연 init 로그 대기(최대 20s) …')
    const adblockReady = await waitForLogLine(stdoutPath, '[adblock] initialized', { timeoutMs: 20_000 })
    if (adblockReady) {
      console.log('  [adblock] initialized 확인 — 안정화 대기(3s) 후 baseline 측정')
      await sleep(3000)
    } else {
      console.warn('  ⚠ adblock 초기화 로그를 20s 내 확인하지 못함(설정에서 꺼졌거나 지연) — 폴백 고정 대기(8s) 사용')
      await sleep(8000)
    }
    // 한 시점만 찍으면 그 순간의 GC·지연 초기화 상태가 판정을 좌우한다(실측: 같은 세션에서
    // 242MB ↔ 254MB 로 예산선을 넘나들었다). 여러 번 재서 **분포**를 남기고 중앙값으로 판정한다.
    const baselineSeries = []
    for (let i = 0; i < args.baselineSamples; i++) {
      if (i > 0) await sleep(args.baselineIntervalMs)
      const smp = await sampleMemory(controlSession, `baseline(newtab x1) #${i + 1}`)
      baselineSeries.push(smp)
      console.log(`  baseline #${i + 1}: private=${smp.totalPrivateWorkingSetMB}MB workingSet(electron)=${smp.totalWorkingSetElectronMB}MB procs=${smp.processCount}`)
    }
    const privates = baselineSeries.map((b) => b.totalPrivateWorkingSetMB).sort((a, b) => a - b)
    const medianPrivate = privates.length % 2
      ? privates[(privates.length - 1) / 2]
      : Math.round(((privates[privates.length / 2 - 1] + privates[privates.length / 2]) / 2) * 10) / 10
    const baseline = { ...baselineSeries[baselineSeries.length - 1], totalPrivateWorkingSetMB: medianPrivate }
    result.baselineSeries = {
      samples: privates,
      median: medianPrivate,
      min: privates[0],
      max: privates[privates.length - 1],
      spread: Math.round((privates[privates.length - 1] - privates[0]) * 10) / 10,
    }
    console.log(`  baseline 확정(중앙값): private=${medianPrivate}MB (표본 ${privates.length}개, 최소 ${privates[0]} / 최대 ${privates[privates.length - 1]}, 폭 ${result.baselineSeries.spread}MB)`)

    // dual 모드의 2회차(adblock 제외 baseline)는 baseline 만 필요하다 — 탭 증분·idle CPU 는
    // adblock 유무와 무관하고, 반복하면 실행 시간만 배로 든다.
    if (args.baselineOnly) {
      result.ok = true
      result.baseline = baseline
      return result
    }

    // ── 2) 탭당 RSS 증가 — about:blank 10개 (background) ──
    console.log('[long-session] about:blank 10탭 생성 …')
    for (let i = 0; i < 10; i++) {
      await callApi(chromeSession, 'tabs.create', [windowId, 'about:blank', { background: true }])
    }
    console.log('[long-session] 탭 생성 후 안정화 대기(8s) …')
    await sleep(8000)
    const after10Tabs = await sampleMemory(controlSession, 'after +10 about:blank tabs')
    console.log(`  after10: private=${after10Tabs.totalPrivateWorkingSetMB}MB workingSet(electron)=${after10Tabs.totalWorkingSetElectronMB}MB tabs=${after10Tabs.tabs.total} procs=${after10Tabs.processCount}`)

    const perTabPrivateMB = (after10Tabs.totalPrivateWorkingSetMB - baseline.totalPrivateWorkingSetMB) / 10
    const perTabWorkingSetElectronMB = (after10Tabs.totalWorkingSetElectronMB - baseline.totalWorkingSetElectronMB) / 10

    // ── 3) idle CPU — idleMinutes 분, 10초 간격 샘플(내부 IPC 만 사용 — 외부 프로세스 스폰 없음
    //      = 측정 자체가 CPU 를 태우지 않도록). 탭은 그대로 11개(1+10) 상태로 idle.
    const idleMs = args.idleMinutes * 60_000
    const intervalMs = 10_000
    const sampleCount = Math.max(2, Math.round(idleMs / intervalMs))
    console.log(`[long-session] idle CPU 샘플링 ${args.idleMinutes}분(${sampleCount}회, ${intervalMs / 1000}s 간격) …`)
    const cpuSamples = []
    for (let i = 0; i < sampleCount; i++) {
      await sleep(intervalMs)
      const m = await getMetrics(controlSession)
      const sumCpu = m.processes.reduce((s, p) => s + (p.cpu ?? 0), 0)
      cpuSamples.push({ t: i, sumCpuPercent: Number(sumCpu.toFixed(3)), avgCpuPercentField: m.totals.avgCpu, processCount: m.processes.length })
      console.log(`  [idle ${i + 1}/${sampleCount}] sumCpu=${sumCpu.toFixed(3)}%`)
    }
    // 첫 샘플은 Electron percentCPUUsage 의 "첫 호출은 0" 특성과 무관하게 이미 부팅 후 상당 시간이
    // 지난 뒤라 유효하지만, 표본 노이즈를 줄이기 위해 전체 평균과 함께 마지막 절반 평균도 report.
    const avgAll = cpuSamples.reduce((s, c) => s + c.sumCpuPercent, 0) / cpuSamples.length
    const secondHalf = cpuSamples.slice(Math.floor(cpuSamples.length / 2))
    const avgSecondHalf = secondHalf.reduce((s, c) => s + c.sumCpuPercent, 0) / secondHalf.length

    // idle 종료 시점에 한 번만 WMI 교차 체크(반복 호출은 WMI 쿼리 자체가 CPU 를 태워 idle 측정을
    // 오염시키므로 idle 루프 밖에서 단발로만 수행).
    const idleWmiCheck = await sampleMemory(controlSession, 'idle-end (wmi cross-check)')
    const idleCpuWmiSum = idleWmiCheck.processes.reduce((s, p) => s + (p.cpuPercent_wmi_normalized ?? 0), 0)

    // ── 4) 외피 JS gzip 크기 ──
    const rendererDir = path.join(REPO_ROOT, 'app', 'dist', 'renderer', 'assets')
    let rendererJs = null
    try {
      const files = fs.readdirSync(rendererDir).filter((f) => f.endsWith('.js'))
      if (files.length > 0) {
        const file = files.sort((a, b) => fs.statSync(path.join(rendererDir, b)).size - fs.statSync(path.join(rendererDir, a)).size)[0]
        const buf = fs.readFileSync(path.join(rendererDir, file))
        const gz = zlib.gzipSync(buf, { level: 9 })
        rendererJs = { file, rawBytes: buf.length, gzipBytes: gz.length, gzipKB: Number((gz.length / 1024).toFixed(2)) }
      }
    } catch (err) {
      rendererJs = { error: err.message }
    }

    result.ok = true
    result.baseline = baseline
    result.after10Tabs = after10Tabs
    result.perTabPrivateMB = Number(perTabPrivateMB.toFixed(2))
    result.perTabWorkingSetElectronMB = Number(perTabWorkingSetElectronMB.toFixed(2))
    result.idle = {
      minutes: args.idleMinutes, intervalMs, samples: cpuSamples,
      avgSumCpuPercentAll: Number(avgAll.toFixed(3)),
      avgSumCpuPercentSecondHalf: Number(avgSecondHalf.toFixed(3)),
      wmiCrossCheckSumNormalizedPercent: Number(idleCpuWmiSum.toFixed(3)),
    }
    result.rendererJs = rendererJs
  } catch (err) {
    result.ok = false
    result.error = err.message
    console.error(`[long-session] ✗ 실패: ${err.message}`)
  } finally {
    try { controlSession?.close() } catch { /* ignore */ }
    try { chromeSession?.close() } catch { /* ignore */ }
    await killApp(child, longPort, args.out)
  }
  return result
}

// ── 판정·보고 ────────────────────────────────────────────────────────────

function judgeColdStart(runs) {
  const ok = runs.filter((r) => r.ok)
  const vals = ok.map((r) => r.firstWindowReadyMs).filter((v) => typeof v === 'number')
  const avg = vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null
  const max = vals.length ? Math.max(...vals) : null
  return { avg, max, pass: avg !== null && avg <= BUDGET.coldStartMs, vals }
}

function printReport(args, coldRuns, longSession, noAdblock) {
  const cold = judgeColdStart(coldRuns)
  console.log('\n===================================================')
  console.log(' 가벼움 예산(1원칙 #1) 정밀 측정 결과')
  console.log('===================================================\n')

  console.log('[콜드 스타트] app.whenReady() → window.show() (≈ firstWindowReadyMs)')
  console.table(coldRuns.map((r) => ({
    run: r.run, ok: r.ok, whenReadyMs: r.whenReadyMs, firstWindowReadyMs: r.firstWindowReadyMs, firstTabLoadedMs: r.firstTabLoadedMs, error: r.error ?? '',
  })))
  console.log(`avg(firstWindowReadyMs)=${cold.avg}ms  max=${cold.max}ms  예산=${BUDGET.coldStartMs}ms  → ${cold.pass ? 'PASS' : 'FAIL'}`)

  if (longSession.ok) {
    console.log(`\n[장기 세션] control 탭 출처=${longSession.controlTabSource}`)
    console.log('\n-- 프로세스 분해 (baseline: newtab 1개) --')
    console.table(longSession.baseline.processes.map((p) => ({
      pid: p.pid, type: p.type,
      workingSet_electron_MB: p.workingSetMB_electron,
      workingSet_WMI_MB: p.workingSetMB_wmi,
      privateWS_WMI_MB: p.privateWorkingSetMB_wmi,
    })))
    console.log(`baseline 합계: WorkingSet(Electron 자체 집계, 공유페이지 중복포함)=${longSession.baseline.totalWorkingSetElectronMB}MB  `
      + `WorkingSet(WMI)=${longSession.baseline.totalWorkingSetWmiMB}MB  Private WorkingSet(WMI, 진짜 물리메모리 증분)=${longSession.baseline.totalPrivateWorkingSetMB}MB`)

    console.log('\n-- 프로세스 분해 (about:blank +10탭 후) --')
    console.table(longSession.after10Tabs.processes.map((p) => ({
      pid: p.pid, type: p.type,
      workingSet_electron_MB: p.workingSetMB_electron,
      workingSet_WMI_MB: p.workingSetMB_wmi,
      privateWS_WMI_MB: p.privateWorkingSetMB_wmi,
    })))
    console.log(`+10탭 합계: WorkingSet(Electron)=${longSession.after10Tabs.totalWorkingSetElectronMB}MB  `
      + `WorkingSet(WMI)=${longSession.after10Tabs.totalWorkingSetWmiMB}MB  Private WorkingSet(WMI)=${longSession.after10Tabs.totalPrivateWorkingSetMB}MB`)

    console.log(`\n탭당 증가: Private(WMI)=${longSession.perTabPrivateMB}MB/탭  WorkingSet(Electron)=${longSession.perTabWorkingSetElectronMB}MB/탭  예산=${BUDGET.perTabMemoryMB}MB/탭`)

    console.log(`\n[idle CPU] ${longSession.idle.minutes}분, ${longSession.idle.samples.length}회 샘플(10s 간격, 내부 IPC 만 사용)`)
    console.log(`  평균(전체 샘플)=${longSession.idle.avgSumCpuPercentAll}%  평균(후반부)=${longSession.idle.avgSumCpuPercentSecondHalf}%  `
      + `WMI 교차체크(1회, 코어수 정규화)=${longSession.idle.wmiCrossCheckSumNormalizedPercent}%  예산=${BUDGET.idleCpuPercent}%`)

    console.log(`\n[외피 JS 번들] ${JSON.stringify(longSession.rendererJs)}`)
  } else {
    console.log(`\n[장기 세션] ✗ 실패: ${longSession.error}`)
  }

  console.log('\n===================================================')
  console.log(' CLAUDE.md 가벼움 예산 표 대조 (판정은 Private WorkingSet 기준)')
  console.log('===================================================')
  const budgetRows = [
    { 항목: '콜드 스타트', 측정치_private: '-', 측정치_workingSet: `${cold.avg}ms (avg) / ${cold.max}ms (max)`, 예산: `${BUDGET.coldStartMs}ms`, 판정: cold.pass ? 'PASS' : 'FAIL' },
  ]
  if (longSession.ok) {
    // 어느 경로를 쟀는지에 따라 예산이 다르다 — 라벨 없이 판정하면 콜드 측정이 늘 실패한다.
    const measuredPath = longSession.measuredPath ?? 'unknown'
    const blankBudget = measuredPath === 'cold'
      ? BUDGET.blankWindowMemoryMB + BUDGET.adblockColdAllowanceMB
      : BUDGET.blankWindowMemoryMB
    const noAdblockMB = noAdblock?.ok ? (noAdblock.baseline?.totalPrivateWorkingSetMB ?? null) : null
    const noAdblockPass = noAdblockMB === null ? true : noAdblockMB <= BUDGET.blankWindowNoAdblockMB
    const adblockCostMB = noAdblockMB === null ? null
      : Math.round((longSession.baseline.totalPrivateWorkingSetMB - noAdblockMB) * 10) / 10
    const blankPass = longSession.baseline.totalPrivateWorkingSetMB <= blankBudget
    const blankPassWS = longSession.baseline.totalWorkingSetElectronMB <= blankBudget
    const perTabPass = longSession.perTabPrivateMB <= BUDGET.perTabMemoryMB
    const perTabPassWS = longSession.perTabWorkingSetElectronMB <= BUDGET.perTabMemoryMB
    const cpuPass = longSession.idle.avgSumCpuPercentSecondHalf <= BUDGET.idleCpuPercent
    const gzipPass = longSession.rendererJs?.gzipKB != null && longSession.rendererJs.gzipKB <= BUDGET.rendererJsGzipKB
    budgetRows.push(
      // 판정 1순위: adblock 제외(우리 코드). dual 측정이 없으면 이 행은 생략된다.
      ...(noAdblockMB === null ? [] : [{
        항목: '빈 창 RSS — adblock 제외 (판정 1순위)',
        측정치_private: `${noAdblockMB}MB`,
        측정치_workingSet: '-',
        예산: `${BUDGET.blankWindowNoAdblockMB}MB`,
        판정: noAdblockPass ? `PASS (여유 ${Math.round((BUDGET.blankWindowNoAdblockMB - noAdblockMB) * 10) / 10}MB)` : `FAIL (초과 ${Math.round((noAdblockMB - BUDGET.blankWindowNoAdblockMB) * 10) / 10}MB)`,
      }]),
      // 총계는 참고·추세용. adblock 실측 비용을 함께 적어 초과 사유가 보이게 한다.
      { 항목: `빈 창 RSS(newtab 1개, ${measuredPath === 'cold' ? '콜드' : '웜'} 경로) — 총계(참고)`, 측정치_private: `${longSession.baseline.totalPrivateWorkingSetMB}MB${longSession.baselineSeries ? ` (중앙값, 표본 ${longSession.baselineSeries.samples.length}개 폭 ${longSession.baselineSeries.spread}MB)` : ''}${adblockCostMB === null ? '' : ` · 그중 adblock ${adblockCostMB}MB`}`, 측정치_workingSet: `${longSession.baseline.totalWorkingSetElectronMB}MB`, 예산: `${blankBudget}MB${measuredPath === 'cold' ? ` (250 + adblock 콜드 ${BUDGET.adblockColdAllowanceMB})` : ''}`, 판정: `private=${blankPass ? `PASS (여유 ${Math.round((blankBudget - longSession.baseline.totalPrivateWorkingSetMB) * 10) / 10}MB)` : (noAdblockMB === null ? `FAIL (초과 ${Math.round((longSession.baseline.totalPrivateWorkingSetMB - blankBudget) * 10) / 10}MB)` : `참고: 초과 ${Math.round((longSession.baseline.totalPrivateWorkingSetMB - blankBudget) * 10) / 10}MB`)} / WS=${blankPassWS ? 'PASS' : 'FAIL'}` },
      { 항목: '탭 추가당 RSS 증가', 측정치_private: `${longSession.perTabPrivateMB}MB/탭`, 측정치_workingSet: `${longSession.perTabWorkingSetElectronMB}MB/탭`, 예산: `${BUDGET.perTabMemoryMB}MB/탭`, 판정: `private=${perTabPass ? 'PASS' : 'FAIL'} / WS=${perTabPassWS ? 'PASS' : 'FAIL'}` },
      { 항목: `휴식 시 CPU(${longSession.idle.minutes}분 idle, 후반부 평균)`, 측정치_private: '-', 측정치_workingSet: `${longSession.idle.avgSumCpuPercentSecondHalf}%`, 예산: `${BUDGET.idleCpuPercent}%`, 판정: cpuPass ? 'PASS' : 'FAIL' },
      { 항목: '외피 초기 JS(gzip)', 측정치_private: '-', 측정치_workingSet: `${longSession.rendererJs?.gzipKB ?? 'N/A'}KB`, 예산: `${BUDGET.rendererJsGzipKB}KB`, 판정: gzipPass ? 'PASS' : 'FAIL' },
    )
  }
  console.table(budgetRows)

  return { cold, budgetRows }
}

// ── 메인 ─────────────────────────────────────────────────────────────────

async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('[perf-measure] Node 22+ 필요 (전역 WebSocket 없음).')
    process.exit(2)
  }
  const args = parseArgs(process.argv.slice(2))
  fs.mkdirSync(args.out, { recursive: true })

  if (!fs.existsSync(args.exe)) {
    console.error(`[perf-measure] exe 를 찾을 수 없음: ${args.exe}`)
    console.error('  먼저 "npm run package:win" 으로 패키징하거나 --exe 로 경로를 지정하세요.')
    process.exit(1)
  }

  console.log(`[perf-measure] exe=${args.exe}`)
  console.log(`[perf-measure] out=${args.out}`)
  console.log(`[perf-measure] port=${args.port}`)
  console.log(`[perf-measure] cold-runs=${args.coldRuns}  idle-minutes=${args.idleMinutes}`)

  await cleanupStaleProcess(args.out)

  const coldRuns = await measureColdStart(args)
  const longSession = await measureLongSession(args)

  // ── dual: adblock 을 끈 baseline 도 잰다 ────────────────────────────────
  // 판정 1순위는 **adblock 제외** 값이다. adblock 은 콕콕 핵심이라 끌 수 없는 고정비이고
  // (2026-09-07 실측 110MB), 그걸 섞어서 판정하면 우리 코드의 회귀가 묻힌다.
  let noAdblock = null
  if (args.dual && longSession.ok) {
    console.log('\n[dual] adblock 을 끈 baseline 측정 …')
    try {
      patchProfileSettings(args.profileDir, { adblock: { enabled: false } })
      noAdblock = await measureLongSession({ ...args, baselineOnly: true })
    } catch (err) {
      console.warn('[dual] adblock 제외 측정 실패(무시):', err.message)
    } finally {
      patchProfileSettings(args.profileDir, { adblock: { enabled: true } })
    }
    if (noAdblock?.ok) {
      const total = longSession.baseline?.totalPrivateWorkingSetMB ?? 0
      const base = noAdblock.baseline?.totalPrivateWorkingSetMB ?? 0
      console.log(`[dual] adblock 제외 ${base}MB · adblock 포함 ${total}MB · adblock 비용 ${Math.round((total - base) * 10) / 10}MB`)
    }
  }

  const { cold, budgetRows } = printReport(args, coldRuns, longSession, noAdblock)

  const resultsPath = path.join(args.out, 'perf-results.json')
  fs.writeFileSync(resultsPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    budget: BUDGET,
    coldRuns,
    coldJudgement: cold,
    longSession,
    noAdblock: noAdblock?.ok ? { baseline: noAdblock.baseline, path: noAdblock.measuredPath } : null,
    budgetTable: budgetRows,
  }, null, 2))
  console.log(`\n[perf-measure] 결과 저장: ${resultsPath}`)

  // ── 기준선 이력 ────────────────────────────────────────────────────────
  //
  // 한 번의 측정값만으로는 "예산을 넘었다"를 말할 수 없다. 2026-09-07 실측에서 같은 빌드가
  // 같은 머신에서 233~260MB 로 흔들렸다(실행 간 드리프트 ±13MB — 예산까지의 여유와 맞먹는다).
  // 그래서 실행마다 이력을 남기고, **같은 경로(웜/콜드)의 과거 중앙값**과 비교해 보여준다.
  // 회귀는 한 번의 초과가 아니라 **중앙값의 이동**으로 판단해야 한다.
  // 이력은 --out 과 무관하게 **저장소 고정 위치**에 쌓는다. verify-all 은 단계별 out 디렉터리를
  // 넘기므로(verify-out/all/perf), out 을 따라가면 수동 실행과 게이트 실행의 추세선이 갈라져
  // "과거 표본 0개"만 반복된다(2026-09-07 full 실행에서 실제로 그랬다).
  const historyDir = path.join(REPO_ROOT, 'perf-out')
  fs.mkdirSync(historyDir, { recursive: true })
  const historyPath = path.join(historyDir, 'perf-history.json')
  let history = []
  try {
    const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'))
    // 손상된 이력(원소가 null·비객체·NaN)이 아래 계산에서 TypeError 를 내지 않도록 여기서 걸러낸다.
    if (Array.isArray(parsed)) history = parsed.filter((h) => h && typeof h === 'object')
  } catch { /* 첫 실행 */ }

  const entry = {
    at: new Date().toISOString(),
    path: longSession.measuredPath ?? 'unknown',
    blankPrivateMB: longSession.baseline?.totalPrivateWorkingSetMB ?? null,
    perTabPrivateMB: longSession.perTabPrivateMB ?? null,
    coldStartAvgMs: cold?.avg ?? null,
    spreadMB: longSession.baselineSeries?.spread ?? null,
    // 판정 1순위 축(adblock 제외)과 adblock 비용도 함께 남긴다 — 이력만 보고도 2축을 알 수 있게.
    noAdblockMB: noAdblock?.ok ? (noAdblock.baseline?.totalPrivateWorkingSetMB ?? null) : null,
    adblockCostMB: (noAdblock?.ok && longSession.baseline)
      ? Math.round((longSession.baseline.totalPrivateWorkingSetMB - noAdblock.baseline.totalPrivateWorkingSetMB) * 10) / 10
      : null,
  }
  const samePath = history.filter((h) => h.path === entry.path && Number.isFinite(h.blankPrivateMB))
  if (samePath.length >= 2 && typeof entry.blankPrivateMB === 'number') {
    const prev = samePath.slice(-9).map((h) => h.blankPrivateMB).sort((a, b) => a - b)
    const prevMedian = prev.length % 2
      ? prev[(prev.length - 1) / 2]
      : (prev[prev.length / 2 - 1] + prev[prev.length / 2]) / 2
    const delta = Math.round((entry.blankPrivateMB - prevMedian) * 10) / 10
    const sign = delta >= 0 ? '+' : ''
    console.log(`[perf-measure] 기준선 비교(${entry.path}, 과거 ${prev.length}회 중앙값 ${prevMedian}MB): ${sign}${delta}MB`)
    if (delta >= 10) {
      console.log(`  ⚠ 과거 중앙값 대비 ${sign}${delta}MB — 실행 간 드리프트(±13MB 관측)를 감안해도 큰 편이다. 추세를 확인할 것.`)
    }
    entry.deltaVsMedianMB = delta
  } else {
    console.log(`[perf-measure] 기준선 비교: 같은 경로(${entry.path}) 과거 표본 ${samePath.length}개 — 3회 이상 쌓이면 비교를 표시한다.`)
  }
  history.push(entry)
  try {
    // 원자적 쓰기(tmp + rename) — 중간에 죽어도 반쪽 파일이 남지 않는다.
    const tmp = `${historyPath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(history.slice(-50), null, 2))
    fs.renameSync(tmp, historyPath)
    console.log(`[perf-measure] 기준선 이력: ${historyPath} (${Math.min(history.length, 50)}회 보관)`)
  } catch (err) {
    console.warn('[perf-measure] 기준선 이력 저장 실패(무시):', err.message)
  }

  // 판정은 **Private WorkingSet 기준**이다(CLAUDE.md 가벼움 예산 표: Electron 의
  // `getAppMetrics().workingSetSize` 는 공유 페이지를 중복 집계해 5~7배 과대평가하므로
  // "판정에 쓰지 말 것"). 그런데 표의 판정 문자열에는 참고용 `WS=FAIL` 이 함께 들어 있어,
  // 단순 includes('FAIL') 로 보면 **모든 예산을 통과해도 항상 실패**로 끝난다.
  // 늘 빨간 게이트는 무시당하므로, private 판정만 실패로 센다(WS 는 표에 참고로 남긴다).
  const failed = budgetRows.filter((r) => {
    const v = String(r.판정)
    if (v.includes('private=')) return /private=FAIL/.test(v)
    return v.includes('FAIL')
  })
  if (failed.length) {
    console.log(`\n[perf-measure] 예산 초과: ${failed.map((r) => r.항목).join(', ')}`)
  }
  return failed.length ? 1 : 0
}

main().then((code) => {
  process.exit(code ?? 0)
}).catch((err) => {
  console.error('[perf-measure] 치명적 오류:', err)
  process.exit(2)
})
