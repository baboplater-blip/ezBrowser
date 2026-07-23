#!/usr/bin/env node
// smoke-cdp.mjs — CDP(Chrome DevTools Protocol) 로 packaged ezBrowser 를 원격 구동해
// 스모크 시나리오를 자동 실행하고 스크린샷·판정 결과를 남기는 상시 게이트 하네스.
//
// 아키텍처 (의존성 0 — Node 22+ 내장 WebSocket/fetch 만 사용):
//   1. dist/win-unpacked/ezBrowser.exe 를 --remote-debugging-port=<port> --user-data-dir=<격리 프로필>
//      로 spawn (실사용자 프로필은 절대 건드리지 않음 — app/main/bootstrap-userdata.ts 가 지원)
//   2. http://127.0.0.1:<port>/json/list 폴링으로 CDP 타깃 발견
//      - 외피(chrome shell) 타깃: type='page' && url 이 file://…/index.html?windowId=… 패턴
//      - 콘텐츠 탭 타깃: 그 외 type='page' (browser://, https://… 등)
//   3. 외피 타깃에 WS 연결 후 Runtime.evaluate 로 window.browserAPI.* 를 직접 호출해 구동
//      (외피 preload 가 contextBridge 로 노출하는 표면이 가장 신뢰성 높은 구동 경로)
//   4. 시나리오별 PASS/FAIL/SKIP 판정 + CDP 스크린샷 + OS 합성 스크린샷(z-order 검증용) 저장
//
// 격리·안전성:
//   - 매 실행마다 <out>/profile 을 --user-data-dir 로 사용(기본: 실행마다 삭제 후 재생성 →
//     결정적 테스트). --profile-keep 지정 시 유지(수동 확인 후 이어서 조사할 때).
//   - 프로필이 새로 만들어지면 온보딩(browser://welcome)·복원 다이얼로그를 피하도록
//     settings.json 을 최소 시드(setup.completed=true, startup.mode='newtab')한다.
//   - 프로세스 종료는 이름(Stop-Process -Name) 이 아니라 **이 하네스가 직접 띄운 PID** 기준으로만
//     수행한다 — 사용자가 동시에 쓰고 있는 실제 ezBrowser 인스턴스를 죽이지 않는다.
//     <out>/app-proc.json 에 {pid, port} 를 기록해두고, 다음 실행 시작 시 그 PID 가 아직 살아있으면
//     먼저 CDP Browser.close 로 정상 종료를 시도, 실패하면 taskkill /PID <pid> /T /F (해당 프로세스
//     트리만) 로 정리한다.
//
// 사용:
//   node build/smoke-cdp.mjs [--exe <path>] [--out <dir>] [--port <n>] [--keep-alive] [--profile-keep]

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { startTestServer } from './smoke-media-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const DEFAULTS = {
  exe: path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe'),
  out: path.join(REPO_ROOT, 'smoke-out'),
  port: 9223,
  keepAlive: false,
  keepProfile: false,
  profileDir: null, // 미지정 시 <out>/profile
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
    else if (a === '--profile-keep') out.keepProfile = true
    else if (a === '--profile') out.profileDir = path.resolve(argv[++i] ?? '')
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else console.warn(`[smoke-cdp] 알 수 없는 인자 무시: ${a}`)
  }
  if (!out.profileDir) out.profileDir = path.join(out.out, 'profile')
  return out
}

function printHelp() {
  console.log(`
smoke-cdp — CDP 기반 ezBrowser 스모크 게이트

사용: node build/smoke-cdp.mjs [옵션]

옵션:
  --exe <path>     패키징된 exe 경로 (기본: dist/win-unpacked/ezBrowser.exe)
  --out <dir>      스크린샷·결과 JSON 저장 디렉터리 (기본: ./smoke-out)
  --port <n>       --remote-debugging-port 값 (기본: 9223)
  --profile <dir>  격리 --user-data-dir 경로 (기본: <out>/profile)
  --profile-keep   실행 전 프로필 디렉터리를 삭제하지 않고 재사용 (수동 확인 후 이어보기용)
  --keep-alive     끝나도 앱을 종료하지 않음 (수동 확인용)
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

async function pollUntil(fn, { timeoutMs = 10_000, intervalMs = 300, label = 'condition' } = {}) {
  const start = Date.now()
  let last
  let lastErr
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn()
      lastErr = null // fn() 이 예외 없이 반환했으면 이전 이터레이션의 오류는 더 이상 유효하지 않음
      if (last) return last
    } catch (err) {
      lastErr = err
    }
    await sleep(intervalMs)
  }
  const suffix = lastErr ? ` (마지막 오류: ${lastErr.message})` : ''
  throw new Error(`timeout(${timeoutMs}ms) waiting for ${label}${suffix}`)
}

// ── 프로세스 관리 (PID 스코프 — 이름 기반 Stop-Process 사용 금지) ─────────
//
// 이름(Get-Process -Name ezBrowser) 기반 종료는 사용자가 동시에 띄워둔 실제 인스턴스까지
// 죽일 수 있어 위험하다. 이 하네스가 spawn 한 PID 만 기록해두고 그 PID(트리)만 종료한다.

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

/** taskkill /PID <pid> /T /F — 우리가 띄운 프로세스 트리(GPU/렌더러/네트워크 자식 포함)만 정리. */
function killPidTree(pid) {
  if (!pid) return
  const res = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
  if (res.error) console.warn('[smoke-cdp] taskkill 실행 오류(무시):', res.error.message)
}

function isPidAlive(pid) {
  if (!pid) return false
  const res = spawnSync('powershell', [
    '-NoProfile', '-Command',
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Write-Output 'alive' }`,
  ], { encoding: 'utf8' })
  return (res.stdout || '').includes('alive')
}

/** CDP Browser.close 로 정상 종료 시도 (전체 브라우저 대상 — 페이지 타깃 세션과 별개). */
async function tryGracefulShutdown(port, timeoutMs = 3000) {
  try {
    const res = await withTimeout(fetch(`http://127.0.0.1:${port}/json/version`), timeoutMs, 'graceful shutdown /json/version')
    if (!res.ok) return false
    const info = await res.json()
    const wsUrl = info.webSocketDebuggerUrl
    if (!wsUrl) return false
    const browserSession = new CDPSession(wsUrl, 'browser-close')
    await browserSession.connect(timeoutMs)
    await browserSession.send('Browser.close', {}, timeoutMs).catch(() => { /* Electron 이 지원 안 해도 무방 — 아래 폴백 사용 */ })
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

/** 이전 실행이 남긴(이 하네스가 띄운) 프로세스가 있으면 PID 스코프로만 정리. */
async function cleanupStaleProcess(outDir) {
  const stale = readProcFile(outDir)
  if (!stale) return
  console.log(`[smoke-cdp] 이전 실행이 남긴 프로세스 발견 (pid=${stale.pid}, port=${stale.port}) — 정리 시도…`)
  if (isPidAlive(stale.pid)) {
    const graceful = await tryGracefulShutdown(stale.port)
    if (graceful) await sleep(1500)
    if (isPidAlive(stale.pid)) killPidTree(stale.pid)
  }
  removeProcFile(outDir)
}

function launchApp(exePath, outDir, port, profileDir) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // Electron 이 일반 Node 모드로 뜨는 것 방지 (알려진 환경 이슈)

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
    console.log(`[smoke-cdp] app process exited (code=${code} signal=${signal})`)
  })
  writeProcFile(outDir, { pid: child.pid, port })
  return { child, stdoutPath, stderrPath }
}

/** 정상 종료 우선(CDP Browser.close) → 실패 시 taskkill /PID /T /F (우리 PID 트리만). */
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

// ── 격리 프로필 (userData) ──────────────────────────────────────────────
//
// 실사용자 프로필(%APPDATA%/browser-build)을 절대 건드리지 않는다.
// 매 실행마다 삭제 후 재생성해 결정적으로 만들고(--profile-keep 로 옵트아웃),
// 온보딩(browser://welcome)·비정상종료 복원 다이얼로그를 피하도록 settings.json 을 최소 시드한다.
// electron-store(Conf) 는 로드 시 `{...defaults, ...fileStore}` 얕은 병합이므로,
// 우리가 지정하지 않은 최상위 키(adblock/downloads/ui 등)는 앱 기본값을 그대로 사용한다.

function seedProfile(profileDir, keepProfile) {
  if (!keepProfile) {
    fs.rmSync(profileDir, { recursive: true, force: true })
  }
  fs.mkdirSync(profileDir, { recursive: true })
  const settingsPath = path.join(profileDir, 'settings.json')
  if (!fs.existsSync(settingsPath)) {
    const seed = {
      setup: { completed: true, completedAt: Date.now(), version: 'smoke-cdp' },
      startup: { mode: 'newtab', urls: [] },
    }
    fs.writeFileSync(settingsPath, JSON.stringify(seed, null, 2))
  }
}

/** OS 스크린샷 직전 대상 창을 포그라운드로 시도(best-effort, PID 기반 — 이름 기반 아님). */
function activateAppWindow(pid) {
  const ps1 = path.join(__dirname, 'os-activate.ps1')
  const res = spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-ProcessId', String(pid),
  ], { encoding: 'utf8' })
  if (res.status !== 0) {
    return { ok: false, detail: (res.stderr || res.stdout || `exit ${res.status}`).trim() }
  }
  return { ok: true, detail: (res.stdout || '').trim() }
}

// ── CDP 클라이언트 (의존성 0 — Node 22+ 내장 WebSocket) ──────────────────

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
    // 이벤트(msg.method) 는 이번 하네스에서 구독하지 않음 — polling 기반으로 충분.
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

/** Runtime.evaluate 래퍼 — 예외를 throw 로, 값을 returnByValue 로 돌려받는다. */
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

/** window.browserAPI.<dotted.path>(...args) 호출 표현식을 만들어 evaluate. */
function callApi(session, apiPath, args = [], opts) {
  const argStr = args.map(argToLiteral).join(', ')
  return evaluate(session, `window.browserAPI.${apiPath}(${argStr})`, opts)
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

async function waitForTargetByUrlPredicate(port, predicate, label, timeoutMs = 15_000) {
  return pollUntil(async () => {
    const list = await getTargetList(port)
    return list.find((t) => t.type === 'page' && typeof t.url === 'string' && predicate(t.url)) ?? null
  }, { timeoutMs, intervalMs: 300, label })
}

// ── OS 합성 스크린샷 (z-order 검증용) ──────────────────────────────────

function osScreenshot(outDir, name) {
  const outPath = path.join(outDir, `${name}.png`)
  const ps1 = path.join(__dirname, 'os-screenshot.ps1')
  const res = spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-OutPath', outPath,
  ], { encoding: 'utf8' })
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || `exit ${res.status}`).trim(), path: outPath }
  }
  return { ok: true, path: outPath }
}

async function cdpScreenshot(session, outDir, name) {
  try {
    const result = await session.send('Page.captureScreenshot', { format: 'png' }, 10_000)
    const outPath = path.join(outDir, `${name}.png`)
    fs.writeFileSync(outPath, Buffer.from(result.data, 'base64'))
    return { ok: true, path: outPath }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// ── 시나리오 결과 수집 ───────────────────────────────────────────────────

const results = []

/**
 * "기능 자체가 구현돼 있지 않음"을 나타내는 에러 — runScenario 가 이를 FAIL 이 아니라
 * MISSING-FEATURE 로 분류한다. 앱 버그(FAIL)와 "아직 안 만든 기능"(MISSING-FEATURE)을
 * 구분해야 게이트가 false-positive 로 막히지 않는다 — 지휘관에게는 별도 보고 대상.
 */
function missingFeatureError(message) {
  const err = new Error(message)
  err.missingFeature = true
  return err
}

async function runScenario(id, name, fn) {
  const start = Date.now()
  console.log(`\n[${id}] ${name} …`)
  try {
    const detail = await fn()
    const ms = Date.now() - start
    results.push({ id, name, status: 'PASS', detail: detail ?? '', ms })
    console.log(`  ✓ PASS (${ms}ms) ${detail ?? ''}`)
  } catch (err) {
    const ms = Date.now() - start
    if (err && err.missingFeature) {
      results.push({ id, name, status: 'MISSING-FEATURE', detail: err.message, ms })
      console.log(`  ⚠ MISSING-FEATURE (${ms}ms) ${err.message}`)
    } else {
      results.push({ id, name, status: 'FAIL', detail: err.message, ms })
      console.log(`  ✗ FAIL (${ms}ms) ${err.message}`)
    }
  }
}

function skipScenario(id, name, reason) {
  results.push({ id, name, status: 'SKIP', detail: reason, ms: 0 })
  console.log(`\n[${id}] ${name} — SKIP (${reason})`)
}

// ── 시나리오 구현 ────────────────────────────────────────────────────────
// ctx = { port, outDir, chromeSession, windowId, openSessions:[] }

async function scenarioS1(ctx) {
  // 새 탭 생성 + omnibox 검색 라우팅: omnibox.navigate(windowId, undefined, query) 는
  // tabId 가 없으면 새 탭을 만들어 검색엔진 URL 로 이동시킨다 (app/main/ipc/omnibox.ts).
  const query = `ezbrowser smoke ${Date.now()}`
  const before = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
  await callApi(ctx.chromeSession, 'omnibox.navigate', [ctx.windowId, undefined, query])
  const needle = encodeURIComponent(query)
  const found = await pollUntil(async () => {
    const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
    return tabs.find((t) => !before.some((b) => b.id === t.id)
      && typeof t.url === 'string' && t.url.includes('google.com/search') && t.url.includes(needle))
  }, { timeoutMs: 8000, label: 'omnibox search tab' })
  if (!found) throw new Error('검색 결과 탭을 찾지 못함')
  ctx.state.searchTabId = found.id
  return `새 탭 ${found.id} → ${found.url}`
}

async function scenarioS2(ctx) {
  // 탭 로드 → CDP 콘텐츠 타깃 등장 확인 → 두 번째 URL 이동 → goBack.
  const url1 = 'https://example.com/'
  const url2 = 'https://www.iana.org/domains/reserved'
  const created = await callApi(ctx.chromeSession, 'tabs.create', [ctx.windowId, url1])
  ctx.state.navTabId = created.id

  await pollUntil(async () => {
    const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
    const t = tabs.find((x) => x.id === created.id)
    return t && !t.loading && typeof t.url === 'string' && t.url.startsWith('https://example.com')
  }, { timeoutMs: 15000, label: 'S2 첫 페이지 로드 완료' })

  const contentTarget = await waitForTargetByUrlPredicate(
    ctx.port, (u) => u.startsWith('https://example.com'), 'S2 콘텐츠 CDP 타깃', 10000,
  )
  if (!contentTarget) throw new Error('콘텐츠 CDP 타깃을 찾지 못함')

  // CDP 스크린샷(타깃별) — 콘텐츠가 실제로 렌더됐는지 시각 확인용.
  const s2session = await connectSession(contentTarget, 'content:s2')
  ctx.state.openSessions.push(s2session)
  const s2shot = await cdpScreenshot(s2session, ctx.outDir, 's2-content-example')

  await callApi(ctx.chromeSession, 'tabs.navigate', [created.id, url2])
  await pollUntil(async () => {
    const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
    const t = tabs.find((x) => x.id === created.id)
    return t && !t.loading && typeof t.url === 'string' && t.url.includes('iana.org')
  }, { timeoutMs: 15000, label: 'S2 두 번째 페이지 로드 완료' })

  await callApi(ctx.chromeSession, 'tabs.back', [created.id])
  const back = await pollUntil(async () => {
    const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
    const t = tabs.find((x) => x.id === created.id)
    return (t && typeof t.url === 'string' && t.url.startsWith('https://example.com')) ? t : null
  }, { timeoutMs: 10000, label: 'S2 goBack 반영' })

  return `탭 ${created.id}: ${url1} → ${url2} → back → ${back.url} (CDP 타깃 ${contentTarget.id.slice(0, 8)}…, `
    + `스크린샷 ${s2shot.ok ? s2shot.path : `실패: ${s2shot.error}`})`
}

async function scenarioS3(ctx) {
  // 탭 생성/전환/닫기.
  const t = await callApi(ctx.chromeSession, 'tabs.create', [ctx.windowId, 'about:blank'])
  await callApi(ctx.chromeSession, 'tabs.activate', [t.id])
  const afterActivate = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
  const activeEntry = afterActivate.find((x) => x.id === t.id)
  if (!activeEntry || activeEntry.active !== true) {
    throw new Error(`활성화 후 active=true 아님: ${JSON.stringify(activeEntry)}`)
  }
  await callApi(ctx.chromeSession, 'tabs.close', [t.id])
  const afterClose = await pollUntil(async () => {
    const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
    return tabs.some((x) => x.id === t.id) ? null : tabs
  }, { timeoutMs: 5000, label: 'S3 탭 close 반영' })
  return `탭 ${t.id} 생성→활성화(active=true 확인)→닫기(목록에서 사라짐, 남은 탭 ${afterClose.length}개)`
}

async function scenarioS4(ctx) {
  // 북마크 추가/제거 — bookmarks API + Toolbar DOM(.bookmark-btn.active) 상태 동시 검증.
  const navTabId = ctx.state.navTabId
  if (!navTabId) throw new Error('S2 의 navTabId 필요 (S2 가 먼저 성공해야 함)')
  const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
  const navTab = tabs.find((t) => t.id === navTabId)
  if (!navTab) throw new Error('navTab 을 찾지 못함')
  const url = navTab.url

  await callApi(ctx.chromeSession, 'tabs.activate', [navTabId])
  await sleep(200) // 활성 탭 전환이 Toolbar 리렌더에 반영될 시간

  // 시작 상태를 깨끗하게(미북마크)로 정리.
  const isBookmarked = await callApi(ctx.chromeSession, 'bookmarks.isBookmarked', [url])
  if (isBookmarked) {
    await callApi(ctx.chromeSession, 'actions.run', ['action.bookmark.add', { windowId: ctx.windowId, tabId: navTabId }])
    await sleep(300)
  }

  await callApi(ctx.chromeSession, 'actions.run', ['action.bookmark.add', { windowId: ctx.windowId, tabId: navTabId }])
  await sleep(300)
  const afterAdd = await callApi(ctx.chromeSession, 'bookmarks.isBookmarked', [url])
  const domActive = await evaluate(ctx.chromeSession, `!!document.querySelector('.bookmark-btn.active')`)

  await callApi(ctx.chromeSession, 'actions.run', ['action.bookmark.add', { windowId: ctx.windowId, tabId: navTabId }])
  await sleep(300)
  const afterRemove = await callApi(ctx.chromeSession, 'bookmarks.isBookmarked', [url])
  const domInactive = await evaluate(ctx.chromeSession, `!document.querySelector('.bookmark-btn.active')`)

  if (!(afterAdd === true && domActive === true && afterRemove === false && domInactive === true)) {
    throw new Error(`북마크 토글 불일치: afterAdd=${afterAdd} domActive=${domActive} afterRemove=${afterRemove} domInactive=${domInactive}`)
  }
  return `${url} 북마크 추가(isBookmarked=true, ★ DOM active)→제거(isBookmarked=false, ☆) 확인`
}

// ── S5(다운로드) · S6(동영상 감지+다운로드) 공용 헬퍼 ──────────────────────
// 로컬 결정적 테스트 서버(smoke-media-server.mjs)를 대상으로 실제 다운로드를 완주시키고
// 디스크에 받아진 파일의 바이트를 원본과 정확히 비교한다(가속 다운로드의 세그먼트 병합
// 손상은 파일 크기만 봐서는 못 잡는 회귀 계열 — 전체 바이트 비교로 잡는다).
// app/main/features/downloads 의 defaultDownloadDir() 는 --user-data-dir 격리와 무관하게
// app.getPath('downloads')(실사용자 Downloads 폴더)를 그대로 쓰므로, 파일명에 runId 를 박아
// 기존 파일과 충돌하지 않게 하고 검증 직후 반드시 삭제한다.

async function downloadAndVerify(ctx, { url, expectedBuf, label }) {
  const beforeDl = await callApi(ctx.chromeSession, 'downloads.list', [])
  const beforeIds = new Set(beforeDl.map((d) => d.id))
  const tab = await callApi(ctx.chromeSession, 'tabs.create', [ctx.windowId, url])

  let entry
  try {
    entry = await pollUntil(async () => {
      const list = await callApi(ctx.chromeSession, 'downloads.list', [])
      const found = list.find((d) => !beforeIds.has(d.id) && d.url === url)
      if (found && (found.state === 'done' || found.state === 'failed' || found.state === 'cancelled')) return found
      return null
    }, { timeoutMs: 30_000, label: `${label} 다운로드 완료 대기` })
  } catch (err) {
    // 타임아웃이어도 실사용자 Downloads 폴더에 걸린(멈춘) 다운로드를 그대로 두지 않는다 —
    // 취소 시도 + 이미 디스크에 쓰인 부분 파일이 있으면 정리(best-effort).
    const snapshot = await callApi(ctx.chromeSession, 'downloads.list', []).catch(() => [])
    const stuck = Array.isArray(snapshot) ? snapshot.find((d) => !beforeIds.has(d.id) && d.url === url) : null
    if (stuck) {
      await callApi(ctx.chromeSession, 'downloads.cancel', [stuck.id]).catch(() => {})
      if (stuck.savePath) { try { fs.unlinkSync(stuck.savePath) } catch { /* 무시 */ } }
    }
    throw new Error(`${err.message} — downloads.list 스냅샷: ${JSON.stringify(snapshot)}`)
  } finally {
    await callApi(ctx.chromeSession, 'tabs.close', [tab.id]).catch(() => {})
  }

  if (entry.state !== 'done') {
    throw new Error(`${label} 실패 — state=${entry.state} error=${entry.error ?? '(none)'} savePath=${entry.savePath}`)
  }

  let match = false
  let sizeInfo = ''
  try {
    const buf = fs.readFileSync(entry.savePath)
    sizeInfo = `${buf.length}/${expectedBuf.length} bytes`
    match = buf.length === expectedBuf.length && buf.equals(expectedBuf)
  } catch (err) {
    throw new Error(`${label} — 다운로드된 파일을 읽지 못함(${entry.savePath}): ${err.message}`)
  } finally {
    try { fs.unlinkSync(entry.savePath) } catch { /* 이미 없거나 정리 실패 — 무시(실사용자 폴더 오염 방지 best-effort) */ }
  }

  if (!match) {
    throw new Error(`${label} — 다운로드 파일이 원본과 불일치(${sizeInfo}) savePath=${entry.savePath} (세그먼트 병합 손상 가능성)`)
  }

  const accel = entry.accelerator?.connections
  return `${label}: 완료(${sizeInfo}, 바이트 정확히 일치)${accel ? `, 가속 다운로드 ${accel}커넥션` : ', 단일 커넥션(폴백)'}`
}

async function scenarioS5(ctx) {
  const server = ctx.state.server
  if (!server) throw new Error('로컬 테스트 서버가 시작되지 않음(S5/S6 공용) — 시작 시점 로그의 실패 원인 참고')

  const r1 = await downloadAndVerify(ctx, {
    url: server.urls.fileBin,
    expectedBuf: server.buffers.fileBin,
    label: `file.bin(${(server.buffers.fileBin.length / 1024 / 1024).toFixed(1)}MB, Range 지원 → 가속 기대)`,
  })
  const r2 = await downloadAndVerify(ctx, {
    url: server.urls.noRangeBin,
    expectedBuf: server.buffers.noRangeBin,
    label: `noRange.bin(${(server.buffers.noRangeBin.length / 1024 / 1024).toFixed(1)}MB, Range 미지원 → 단일 폴백 기대)`,
  })
  return `${r1} | ${r2}`
}

async function scenarioS6(ctx) {
  const server = ctx.state.server
  if (!server) throw new Error('로컬 테스트 서버가 시작되지 않음(S5/S6 공용) — 시작 시점 로그의 실패 원인 참고')

  const tab = await callApi(ctx.chromeSession, 'tabs.create', [ctx.windowId, server.urls.videoHtml])
  try {
    await pollUntil(async () => {
      const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
      const t = tabs.find((x) => x.id === tab.id)
      return t && !t.loading
    }, { timeoutMs: 10_000, label: 'S6 video.html 로드 완료' })

    // 동영상 감지: onResponseStarted 후킹이 /clip.mp4 응답(video/mp4)을 후보로 등록해야 PASS.
    const candidate = await pollUntil(async () => {
      const list = await callApi(ctx.chromeSession, 'video.candidates', [tab.id])
      return list.find((c) => c.url.includes('/clip.mp4')) ?? null
    }, { timeoutMs: 10_000, label: 'S6 동영상 후보(mp4) 감지' })

    if (candidate.kind !== 'mp4' && candidate.kind !== 'video') {
      throw new Error(`예상치 못한 후보 kind="${candidate.kind}"(mp4/video 기대) — ${JSON.stringify(candidate)}`)
    }

    const beforeDl = await callApi(ctx.chromeSession, 'downloads.list', [])
    const beforeIds = new Set(beforeDl.map((d) => d.id))

    const res = await callApi(ctx.chromeSession, 'video.download', [candidate])
    if (!res || res.ok !== true) throw new Error(`video.download 호출 실패: ${JSON.stringify(res)}`)
    if (res.kind === 'ytdlp') {
      throw new Error(
        'video.download 이 yt-dlp 경로로 라우팅됨 — 직접 mp4 는 startManagedHttpDownload(downloadMedia) 로 '
        + 'yt-dlp 없이 받아지는 것이 설계. yt-dlp 는 네이티브(OS) 동의 다이얼로그를 띄우므로 CDP 로 처리 불가 '
        + '— 이 경로로 빠지면 실사용에서도 다운로드가 자동으로 진행되지 않는 회귀로 봐야 함.',
      )
    }

    let entry
    try {
      entry = await pollUntil(async () => {
        const list = await callApi(ctx.chromeSession, 'downloads.list', [])
        const found = list.find((d) => !beforeIds.has(d.id) && d.url.includes('/clip.mp4'))
        if (found && (found.state === 'done' || found.state === 'failed' || found.state === 'cancelled')) return found
        return null
      }, { timeoutMs: 30_000, label: 'S6 mp4 다운로드 완료 대기' })
    } catch (err) {
      const snapshot = await callApi(ctx.chromeSession, 'downloads.list', []).catch(() => [])
      const stuck = Array.isArray(snapshot) ? snapshot.find((d) => !beforeIds.has(d.id) && d.url.includes('/clip.mp4')) : null
      if (stuck) {
        await callApi(ctx.chromeSession, 'downloads.cancel', [stuck.id]).catch(() => {})
        if (stuck.savePath) { try { fs.unlinkSync(stuck.savePath) } catch { /* 무시 */ } }
      }
      throw new Error(`${err.message} — downloads.list 스냅샷: ${JSON.stringify(snapshot)}`)
    }

    if (entry.state !== 'done') {
      throw new Error(`S6 다운로드 실패 — state=${entry.state} error=${entry.error ?? '(none)'} savePath=${entry.savePath}`)
    }

    let match = false
    let sizeInfo = ''
    try {
      const buf = fs.readFileSync(entry.savePath)
      sizeInfo = `${buf.length}/${server.buffers.clipMp4.length} bytes`
      match = buf.length === server.buffers.clipMp4.length && buf.equals(server.buffers.clipMp4)
    } catch (err) {
      throw new Error(`S6 — 다운로드된 파일을 읽지 못함(${entry.savePath}): ${err.message}`)
    } finally {
      try { fs.unlinkSync(entry.savePath) } catch { /* 무시 */ }
    }

    if (!match) throw new Error(`S6 — 파일 내용 불일치(${sizeInfo}) savePath=${entry.savePath}`)

    return `동영상 후보 감지(kind=${candidate.kind}, url=${candidate.url}) → video.download(kind=${res.kind}, `
      + `yt-dlp 미사용 확인) → 다운로드 완료(${sizeInfo}, 바이트 정확히 일치)`
  } finally {
    await callApi(ctx.chromeSession, 'tabs.close', [tab.id]).catch(() => {})
  }
}

async function scenarioS7(ctx) {
  // settings.set → settings.get 반영 확인 (왕복 후 원복).
  const key = 'ui.workspaceRailOpen'
  const orig = await callApi(ctx.chromeSession, 'settings.get', [key])
  const flipped = orig !== true
  await callApi(ctx.chromeSession, 'settings.set', [key, flipped])
  await sleep(200)
  const got = await callApi(ctx.chromeSession, 'settings.get', [key])
  // 원복
  await callApi(ctx.chromeSession, 'settings.set', [key, orig])
  if (got !== flipped) throw new Error(`set(${flipped}) 후 get()=${got} (기대값 불일치)`)
  return `${key}: ${orig} → set(${flipped}) → get()=${got} 일치 확인, 원복 완료`
}

async function scenarioS8(ctx) {
  // 명령 팔레트: action.palette.open → .command-palette DOM 등장 → Escape → 사라짐.
  await callApi(ctx.chromeSession, 'actions.run', ['action.palette.open', { windowId: ctx.windowId }])
  const opened = await pollUntil(
    () => evaluate(ctx.chromeSession, `!!document.querySelector('.command-palette')`),
    { timeoutMs: 5000, label: 'S8 팔레트 DOM 등장' },
  )
  if (!opened) throw new Error('action.palette.open 후 .command-palette 가 나타나지 않음')

  await evaluate(ctx.chromeSession, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
  await sleep(200)
  const closed = await evaluate(ctx.chromeSession, `!document.querySelector('.command-palette')`)
  if (!closed) throw new Error('Escape 후 팔레트가 닫히지 않음')
  return '팔레트 열림(.command-palette 등장) → Escape 로 닫힘 확인'
}

async function scenarioS9(ctx) {
  // 워크스페이스 전환 + 격리: 새 스페이스 활성화 시 (1) 그 스페이스 전용 newtab 이 자동 생성되고
  // (2) 원래 스페이스의 탭들이 tabs.list 에서 보이지 않아야(격리) 하며, 원래 스페이스로 복귀하면
  // 원래 탭 목록이 그대로 복원돼야 한다. listTabs()는 활성 워크스페이스의 탭만 반환한다
  // (app/main/tabs/tab-service.ts listTabs) — 이 성질 자체가 격리의 관측 지점.
  const before = await callApi(ctx.chromeSession, 'workspace.state', [])
  const originalWsId = before.activeId
  if (!originalWsId) throw new Error('원래 활성 워크스페이스 id 를 읽지 못함')
  ctx.state.originalWorkspaceId = originalWsId
  const beforeTabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])

  const ws = await callApi(ctx.chromeSession, 'workspace.create', [{}])
  ctx.state.testWorkspaceId = ws.id

  try {
    await callApi(ctx.chromeSession, 'workspace.activate', [ws.id])

    const isolatedTabs = await pollUntil(async () => {
      const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
      const onlyNewWs = tabs.length > 0 && tabs.every((t) => t.workspaceId === ws.id)
      const hasNewtab = tabs.some((t) => typeof t.url === 'string' && t.url.startsWith('browser://newtab'))
      return (onlyNewWs && hasNewtab) ? tabs : null
    }, { timeoutMs: 8000, label: 'S9 새 워크스페이스 자동 newtab 생성' })

    const leaked = isolatedTabs.filter((t) => beforeTabs.some((b) => b.id === t.id))
    if (leaked.length > 0) {
      throw new Error(`격리 실패 — 원래 워크스페이스 탭이 새 워크스페이스 tabs.list 에 보임: ${leaked.map((t) => t.id).join(',')}`)
    }

    await callApi(ctx.chromeSession, 'workspace.activate', [originalWsId])
    const restored = await pollUntil(async () => {
      const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
      const ids = new Set(tabs.map((t) => t.id))
      return beforeTabs.every((b) => ids.has(b.id)) ? tabs : null
    }, { timeoutMs: 8000, label: 'S9 원래 워크스페이스 복귀 확인' })

    return `새 워크스페이스 ${ws.id} 생성→활성화(격리된 새 탭 ${isolatedTabs.length}개, 원래 탭 ${beforeTabs.length}개 안 보임 확인, `
      + `browser://newtab 자동 생성 확인)→원래 워크스페이스(${originalWsId}) 복귀(탭 ${restored.length}개 모두 복원 확인)`
  } catch (err) {
    // 실패해도 다음 시나리오(S10/S11 등은 원래 워크스페이스의 탭에 의존) 오염을 막기 위해 최대한 복귀 시도.
    await callApi(ctx.chromeSession, 'workspace.activate', [originalWsId]).catch(() => {})
    throw err
  }
}

async function scenarioR11R12(ctx) {
  // 회귀 #11/#12 재현 확인: 워크스페이스마다 별도 명명 세션(persist:ws-<id>)을 쓰므로, 그 세션에
  // browser:// 프로토콜 핸들러가 설치돼 있지 않으면 Chromium 이 알 수 없는 스킴으로 취급해 OS 외부
  // 핸들러(Windows "이 'browser' 링크를 여세요" 다이얼로그)로 위임한다. OS 다이얼로그 자체는 CDP 로
  // 캡처 불가하므로, "그 워크스페이스의 browser://newtab 콘텐츠 타깃이 CDP 에 정상 등장하고
  // did-fail-load 없이 로드 완료됐는지"를 합격 근거로 삼는다 — 위임됐다면애초 이 타깃 자체가
  // 정상적으로 나타나지 않거나 빈 페이지로 멈춘다.
  const testWsId = ctx.state.testWorkspaceId
  const originalWsId = ctx.state.originalWorkspaceId
  if (!testWsId || !originalWsId) throw new Error('S9 의 워크스페이스가 필요함 (S9 가 먼저 성공해야 함)')

  await callApi(ctx.chromeSession, 'workspace.activate', [testWsId])
  try {
    const target = await pollUntil(async () => {
      const list = await getTargetList(ctx.port)
      return list.find((t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith('browser://newtab')) ?? null
    }, { timeoutMs: 10000, label: 'R11/R12 워크스페이스 partition 의 browser://newtab CDP 타깃' })

    const session = await connectSession(target, 'content:r11r12')
    ctx.state.openSessions.push(session)
    const readyState = await evaluate(session, `document.readyState`)
    const title = await evaluate(session, `document.title`)
    const hasSearchForm = await evaluate(session, `!!document.querySelector('#search-form')`)
    const shot = await cdpScreenshot(session, ctx.outDir, 'r11r12-workspace-newtab')

    if (readyState !== 'complete' && readyState !== 'interactive') {
      throw new Error(`browser://newtab readyState=${readyState} — 정상 로드로 보이지 않음(OS 위임 가능성)`)
    }
    if (!hasSearchForm) {
      throw new Error(`browser://newtab 에 #search-form 이 없음(title=${title}) — 빈 페이지/오류 페이지로 멈췄을 가능성`)
    }

    return `워크스페이스(${testWsId}) partition 의 browser://newtab 타깃 정상 로드 확인 `
      + `(readyState=${readyState}, title="${title}", #search-form 존재 — OS 다이얼로그로 위임되지 않음), `
      + `스크린샷 ${shot.ok ? shot.path : `실패: ${shot.error}`}`
  } finally {
    await callApi(ctx.chromeSession, 'workspace.activate', [originalWsId]).catch(() => {})
  }
}

async function scenarioR13(ctx) {
  // 회귀 #13 재현 확인: adblock 초기화가 defaultSession 에만 적용되면 실제 탭이 쓰는
  // persist:ws-<id> 세션엔 차단이 안 걸린다. S10 과 동일한 광고 리소스 fetch 차단 검사를
  // "워크스페이스 partition 의 새 탭"에서 수행해 모든 세션 적용을 검증한다.
  const testWsId = ctx.state.testWorkspaceId
  const originalWsId = ctx.state.originalWorkspaceId
  if (!testWsId || !originalWsId) throw new Error('S9 의 워크스페이스가 필요함 (S9 가 먼저 성공해야 함)')

  await callApi(ctx.chromeSession, 'workspace.activate', [testWsId])
  try {
    const beforeTargets = await getTargetList(ctx.port)
    const beforeIds = new Set(beforeTargets.map((t) => t.id))

    const created = await callApi(ctx.chromeSession, 'tabs.create', [ctx.windowId, 'https://example.com/'])
    await pollUntil(async () => {
      const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
      const t = tabs.find((x) => x.id === created.id)
      return t && !t.loading && typeof t.url === 'string' && t.url.startsWith('https://example.com')
        && t.workspaceId === testWsId
    }, { timeoutMs: 15000, label: 'R13 워크스페이스 탭 로드 완료' })

    const contentTarget = await pollUntil(async () => {
      const list = await getTargetList(ctx.port)
      return list.find((t) => !beforeIds.has(t.id) && t.type === 'page'
        && typeof t.url === 'string' && t.url.startsWith('https://example.com')) ?? null
    }, { timeoutMs: 10000, label: 'R13 콘텐츠 CDP 타깃(워크스페이스 partition)' })

    const session = await connectSession(contentTarget, 'content:r13-adblock')
    ctx.state.openSessions.push(session)

    const AD_URL = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'
    const outcome = await evaluate(session, `(async () => {
      try {
        await fetch(${JSON.stringify(AD_URL)}, { mode: 'no-cors', cache: 'no-store' });
        return 'not-blocked';
      } catch (e) {
        return 'blocked:' + (e && e.message ? e.message : String(e));
      }
    })()`, { timeoutMs: 12000 })

    const shot = await cdpScreenshot(session, ctx.outDir, 'r13-workspace-adblock')

    if (!outcome.startsWith('blocked')) {
      throw new Error(`워크스페이스(${testWsId}) partition 세션에서 광고 리소스 fetch 가 차단되지 않음: ${outcome} `
        + '— adblock 이 defaultSession 에만 걸려 있을 가능성(회귀 #13 재현)')
    }
    return `워크스페이스(${testWsId}) partition 의 새 탭에서 ${AD_URL} → ${outcome} (adblock 이 모든 세션에 적용됨 확인), `
      + `스크린샷 ${shot.ok ? shot.path : `실패: ${shot.error}`}`
  } finally {
    // 원래 워크스페이스로 복귀 + 테스트용 워크스페이스 정리(그 안의 탭도 함께 close 됨 — workspace.remove).
    await callApi(ctx.chromeSession, 'workspace.activate', [originalWsId]).catch(() => {})
    await callApi(ctx.chromeSession, 'workspace.remove', [testWsId]).catch(() => {})
  }
}

async function scenarioS10(ctx) {
  // adblock: EasyList 로 잘 알려진 광고 리소스 fetch 가 net::ERR_BLOCKED_BY_CLIENT 로 실패해야 PASS.
  const navTabId = ctx.state.navTabId
  if (!navTabId) throw new Error('S2 의 navTabId 필요')
  const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
  const navTab = tabs.find((t) => t.id === navTabId)
  if (!navTab) throw new Error('navTab 을 찾지 못함')

  const contentTarget = await waitForTargetByUrlPredicate(
    ctx.port, (u) => u === navTab.url || u.startsWith('https://example.com'), 'S10 콘텐츠 CDP 타깃', 10000,
  )
  if (!contentTarget) throw new Error('콘텐츠 CDP 타깃을 찾지 못함')
  const session = await connectSession(contentTarget, 'content:adblock')
  ctx.state.openSessions.push(session)
  ctx.state.adblockContentTarget = contentTarget

  const AD_URL = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'
  const outcome = await evaluate(session, `(async () => {
    try {
      await fetch(${JSON.stringify(AD_URL)}, { mode: 'no-cors', cache: 'no-store' });
      return 'not-blocked';
    } catch (e) {
      return 'blocked:' + (e && e.message ? e.message : String(e));
    }
  })()`, { timeoutMs: 12000 })

  const shot = await cdpScreenshot(session, ctx.outDir, 's10-content-adblock')

  if (!outcome.startsWith('blocked')) {
    throw new Error(`광고 리소스 fetch 가 차단되지 않음: ${outcome}`)
  }
  return `${AD_URL} → ${outcome} (adblock 정상 차단), 스크린샷 ${shot.ok ? shot.path : `실패: ${shot.error}`}`
}

async function scenarioS11(ctx) {
  // 다크모드 액션 토글 → 콘텐츠 탭에 insertCSS(filter: invert…) 주입 여부 확인 후 원복.
  const target = ctx.state.adblockContentTarget
    ?? await waitForTargetByUrlPredicate(ctx.port, (u) => u.startsWith('https://example.com'), 'S11 콘텐츠 CDP 타깃', 10000)
  if (!target) throw new Error('콘텐츠 CDP 타깃을 찾지 못함')
  const session = ctx.state.openSessions.find((s) => s.label === 'content:adblock' && s.ws?.readyState === 1)
    ?? await connectSession(target, 'content:darkmode')
  if (!ctx.state.openSessions.includes(session)) ctx.state.openSessions.push(session)

  const before = await callApi(ctx.chromeSession, 'settings.get', ['appearance.forcePageDark'])
  await callApi(ctx.chromeSession, 'actions.run', ['action.darkmode.toggle', { windowId: ctx.windowId }])
  await sleep(700)
  const after = await callApi(ctx.chromeSession, 'settings.get', ['appearance.forcePageDark'])
  const filterVal = await evaluate(session, `getComputedStyle(document.documentElement).filter`)
  const hasInvert = typeof filterVal === 'string' && filterVal.includes('invert')
  const shot = await cdpScreenshot(session, ctx.outDir, 's11-content-darkmode')

  // 원복
  if (after !== before) {
    await callApi(ctx.chromeSession, 'actions.run', ['action.darkmode.toggle', { windowId: ctx.windowId }])
    await sleep(300)
  }

  const consistent = (after === true && hasInvert) || (after !== true && !hasInvert)
  if (!consistent) {
    throw new Error(`forcePageDark=${after} 인데 콘텐츠 filter=${filterVal ?? '(none)'} — 불일치`)
  }
  return `toggle: forcePageDark ${before}→${after}, computed filter ${hasInvert ? '포함' : '없음'}(invert) — 일치 확인, `
    + `원복 완료, 스크린샷 ${shot.ok ? shot.path : `실패: ${shot.error}`}`
}

function shellTargetWindowId(t) {
  try { return new URL(t.url).searchParams.get('windowId') } catch { return null }
}

async function scenarioS12(ctx) {
  // 시크릿(incognito) 창 — 먼저 액션 레지스트리에 action.window.incognito 가 실제로 등록돼 있는지
  // 확인한다. keymap.default.json 에 Ctrl+Shift+N 매핑 + ko/en i18n 라벨("시크릿 창")은 존재하지만,
  // register-defaults.ts 에는 action.window.new/action.window.close 만 등록돼 있고 action.window.incognito
  // 는 등록된 적이 없다(등록 안 된 액션은 actions.run 이 조용히 false 를 반환할 뿐 throw 하지 않음 —
  // app/main/actions/registry.ts runAction). 앱을 수정하지 않고 이 상태를 있는 그대로 보고한다.
  const list = await callApi(ctx.chromeSession, 'actions.list', [])
  const registered = Array.isArray(list) && list.some((a) => a.id === 'action.window.incognito')
  if (!registered) {
    throw missingFeatureError(
      'action.window.incognito 가 액션 레지스트리(actions.list)에 없음 — keymap(Ctrl+Shift+N)과 i18n 라벨(ko: "시크릿 창", '
      + 'en: "New Incognito Window")만 존재하고, 실제 창 생성·incognito partition 격리 구현(액션 등록·핸들러)이 없음. '
      + 'app/shared/constants.ts 의 incognitoPartition() 헬퍼도 어디서도 호출되지 않는 미사용 코드.',
    )
  }

  // ── 아래는 향후 구현될 경우를 대비한 실행 경로 (현재 코드베이스에서는 registered=false 라 도달하지 않음) ──
  const beforeTargets = await getTargetList(ctx.port)
  const beforeShellIds = new Set(beforeTargets.filter(isShellTarget).map((t) => t.id))

  const ok = await callApi(ctx.chromeSession, 'actions.run', ['action.window.incognito', { windowId: ctx.windowId }])
  if (!ok) throw new Error('action.window.incognito 실행이 false 를 반환(등록은 됐지만 run 이 실패)')

  const newShell = await pollUntil(async () => {
    const l = await getTargetList(ctx.port)
    return l.find((t) => isShellTarget(t) && !beforeShellIds.has(t.id)) ?? null
  }, { timeoutMs: 10000, label: 'S12 새 시크릿 창 외피 CDP 타깃' })

  const incogSession = await connectSession(newShell, 'chrome-incognito')
  ctx.state.openSessions.push(incogSession)
  const incogWindowId = shellTargetWindowId(newShell)
  if (!incogWindowId) throw new Error('시크릿 창 외피 URL 에서 windowId 를 읽지 못함')

  try {
    // localStorage 격리 확인: 같은 오리진(example.com)에 각각 탭을 만들어 한쪽에서 쓴 값이
    // 다른 세션(파티션)에 안 보이는지 확인한다.
    const probeUrl = 'https://example.com/'
    const probeKey = 'ezbrowser-smoke-incognito-probe'

    const mainBefore = await getTargetList(ctx.port)
    const mainBeforeIds = new Set(mainBefore.map((t) => t.id))
    const mainTab = await callApi(ctx.chromeSession, 'tabs.create', [ctx.windowId, probeUrl])
    await pollUntil(async () => {
      const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
      const t = tabs.find((x) => x.id === mainTab.id)
      return t && !t.loading
    }, { timeoutMs: 15000, label: 'S12 메인 창 probe 탭 로드' })
    const mainTarget = await pollUntil(async () => {
      const l = await getTargetList(ctx.port)
      return l.find((t) => !mainBeforeIds.has(t.id) && t.type === 'page'
        && typeof t.url === 'string' && t.url.startsWith('https://example.com')) ?? null
    }, { timeoutMs: 10000, label: 'S12 메인 창 probe CDP 타깃' })
    const mainProbeSession = await connectSession(mainTarget, 'content:s12-main')
    ctx.state.openSessions.push(mainProbeSession)
    await evaluate(mainProbeSession, `localStorage.setItem(${JSON.stringify(probeKey)}, 'main-window')`)

    const incogBefore = await getTargetList(ctx.port)
    const incogBeforeIds = new Set(incogBefore.map((t) => t.id))
    const incogTab = await callApi(incogSession, 'tabs.create', [incogWindowId, probeUrl])
    await pollUntil(async () => {
      const tabs = await callApi(incogSession, 'tabs.list', [incogWindowId])
      const t = tabs.find((x) => x.id === incogTab.id)
      return t && !t.loading
    }, { timeoutMs: 15000, label: 'S12 시크릿 창 probe 탭 로드' })
    const incogTarget = await pollUntil(async () => {
      const l = await getTargetList(ctx.port)
      return l.find((t) => !incogBeforeIds.has(t.id) && t.type === 'page'
        && typeof t.url === 'string' && t.url.startsWith('https://example.com')) ?? null
    }, { timeoutMs: 10000, label: 'S12 시크릿 창 probe CDP 타깃' })
    const incogProbeSession = await connectSession(incogTarget, 'content:s12-incognito')
    ctx.state.openSessions.push(incogProbeSession)
    const leaked = await evaluate(incogProbeSession, `localStorage.getItem(${JSON.stringify(probeKey)})`)

    // 정리: 메인 창의 probe 값 제거.
    await evaluate(mainProbeSession, `localStorage.removeItem(${JSON.stringify(probeKey)})`).catch(() => {})

    if (leaked) {
      throw new Error(`시크릿 창이 메인 창과 localStorage 를 공유함(leaked="${leaked}") — 세션 격리 실패`)
    }
    return `시크릿 창(windowId=${incogWindowId}) 생성 확인 → localStorage 격리 확인(메인 창에서 쓴 값이 시크릿 창에 안 보임)`
  } finally {
    await evaluate(incogSession, `window.close()`).catch(() => {})
  }
}

async function scenarioZ1(ctx) {
  const navTabId = ctx.state.navTabId
  if (!navTabId) throw new Error('S2 의 navTabId 필요')
  await callApi(ctx.chromeSession, 'tabs.activate', [navTabId])
  await sleep(150)
  // 토스트를 새로 띄우기 위해 북마크 토글 1회(추가) 실행.
  await callApi(ctx.chromeSession, 'actions.run', ['action.bookmark.add', { windowId: ctx.windowId, tabId: navTabId }])
  await sleep(250) // 토스트 슬라이드인 애니메이션 대기
  try { await ctx.chromeSession.send('Page.bringToFront', {}, 3000) } catch { /* best-effort */ }
  const act = ctx.appPid ? activateAppWindow(ctx.appPid) : { ok: false, detail: 'appPid 없음' }
  const shot = osScreenshot(ctx.outDir, 'zorder-toast-bookmark')
  // 정리: 방금 추가한 북마크 제거.
  await callApi(ctx.chromeSession, 'actions.run', ['action.bookmark.add', { windowId: ctx.windowId, tabId: navTabId }])
  if (!shot.ok) throw new Error(`OS 스크린샷 실패: ${shot.error}`)
  return `창 활성화 ${act.ok ? '성공' : `실패(${act.detail})`} → 북마크 토글 토스트 직후 OS 스크린샷 저장 → ${shot.path} (판정은 육안 확인 필요)`
}

async function scenarioZ2(ctx) {
  const navTabId = ctx.state.navTabId
  if (!navTabId) throw new Error('S2 의 navTabId 필요')
  await callApi(ctx.chromeSession, 'tabs.activate', [navTabId])
  await sleep(150)
  await callApi(ctx.chromeSession, 'actions.run', ['action.qrcode.show', { windowId: ctx.windowId, tabId: navTabId }])
  await pollUntil(
    () => evaluate(ctx.chromeSession, `!!document.querySelector('.qr-modal')`),
    { timeoutMs: 5000, label: 'Z2 QR 모달 DOM 등장' },
  )
  await sleep(400) // QR PNG 생성(IPC 왕복) 대기
  try { await ctx.chromeSession.send('Page.bringToFront', {}, 3000) } catch { /* best-effort */ }
  const act = ctx.appPid ? activateAppWindow(ctx.appPid) : { ok: false, detail: 'appPid 없음' }
  const shot = osScreenshot(ctx.outDir, 'zorder-qrcode')
  // 정리: 모달 닫기.
  await evaluate(ctx.chromeSession, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
  if (!shot.ok) throw new Error(`OS 스크린샷 실패: ${shot.error}`)
  return `창 활성화 ${act.ok ? '성공' : `실패(${act.detail})`} → QR 모달 표시 직후 OS 스크린샷 저장 → ${shot.path} (판정은 육안 확인 필요)`
}

// ── 메인 오케스트레이션 ──────────────────────────────────────────────────

function printResultsTable() {
  const rows = results.map((r) => ({
    ID: r.id, 이름: r.name, 상태: r.status, 'ms': r.ms, 상세: r.detail,
  }))
  console.log('\n===== smoke-cdp 결과 =====')
  console.table(rows)
  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const skip = results.filter((r) => r.status === 'SKIP').length
  const missing = results.filter((r) => r.status === 'MISSING-FEATURE').length
  console.log(`PASS=${pass} FAIL=${fail} SKIP=${skip} MISSING-FEATURE=${missing} (총 ${results.length})`)
}

async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('[smoke-cdp] Node 22+ 필요 (전역 WebSocket 없음). node -v 로 버전 확인.')
    process.exit(2)
  }

  const args = parseArgs(process.argv.slice(2))
  fs.mkdirSync(args.out, { recursive: true })

  if (!fs.existsSync(args.exe)) {
    console.error(`[smoke-cdp] exe 를 찾을 수 없음: ${args.exe}`)
    console.error('  먼저 "npm run package:win" 으로 패키징하거나 --exe 로 경로를 지정하세요.')
    fs.writeFileSync(path.join(args.out, 'smoke-results.json'), JSON.stringify([{
      id: 'INFRA', name: 'exe 존재 확인', status: 'FAIL', detail: `not found: ${args.exe}`, ms: 0,
    }], null, 2))
    process.exit(1)
  }

  console.log(`[smoke-cdp] exe=${args.exe}`)
  console.log(`[smoke-cdp] out=${args.out}`)
  console.log(`[smoke-cdp] port=${args.port}`)
  console.log(`[smoke-cdp] profile=${args.profileDir} (${args.keepProfile ? '유지' : '매 실행 초기화'})`)

  // 이름 기반 종료가 아니라, 이 하네스가 이전에 띄운 PID 만 정리 (사용자의 실제 인스턴스는 건드리지 않음).
  await cleanupStaleProcess(args.out)

  // 격리 프로필: 실사용자 프로필(%APPDATA%/browser-build)과 완전히 분리.
  // 온보딩/복원 다이얼로그를 피하도록 최소 settings.json 시드.
  seedProfile(args.profileDir, args.keepProfile)

  // S5(다운로드)·S6(동영상 감지+다운로드) 전용 로컬 결정적 테스트 서버.
  // 127.0.0.1 loopback 이라 방화벽/외부 사이트 flake 영향 없음. 이 Node 프로세스 안에서만
  // 살아있으므로(별도 spawn 아님) 프로세스 종료 시 소켓도 자동 정리 — orphan 위험 없음.
  let testServer = null
  try {
    testServer = await startTestServer()
    console.log(`[smoke-cdp] S5/S6 테스트 서버 시작: http://127.0.0.1:${testServer.port} (runId=${testServer.runId})`)
  } catch (err) {
    console.warn(`[smoke-cdp] S5/S6 테스트 서버 시작 실패 — 해당 시나리오는 FAIL 처리됨: ${err.message}`)
  }

  const { child } = launchApp(args.exe, args.out, args.port, args.profileDir)

  const ctx = {
    port: args.port,
    outDir: args.out,
    chromeSession: null,
    windowId: null,
    appPid: child.pid,
    state: { openSessions: [], server: testServer },
  }

  let infraOk = false
  try {
    console.log('[smoke-cdp] CDP 외피 타깃 대기 중 (최대 30초)…')
    const shellTarget = await waitForShellTarget(args.port, 30_000)
    console.log(`[smoke-cdp] 외피 타깃 발견: ${shellTarget.url}`)
    ctx.chromeSession = await connectSession(shellTarget, 'chrome-shell')
    ctx.state.openSessions.push(ctx.chromeSession)

    ctx.windowId = await evaluate(
      ctx.chromeSession,
      `new URL(location.href).searchParams.get('windowId')`,
    )
    if (!ctx.windowId) throw new Error('외피 URL 에서 windowId 를 읽지 못함')
    console.log(`[smoke-cdp] windowId=${ctx.windowId}`)

    // browserAPI 노출 표면 발견 + 저장.
    const surface = await evaluate(ctx.chromeSession, `(() => {
      const api = window.browserAPI || {}
      const out = {}
      for (const k of Object.keys(api)) {
        const v = api[k]
        out[k] = (v && typeof v === 'object') ? Object.keys(v) : typeof v
      }
      return out
    })()`)
    fs.writeFileSync(path.join(args.out, 'browserapi-surface.json'), JSON.stringify(surface, null, 2))
    console.log(`[smoke-cdp] browserAPI 네임스페이스 ${Object.keys(surface).length}개 발견 → browserapi-surface.json`)

    // 첫 탭이 뜰 시간(설치 마법사/새 탭 자동 생성) 확보.
    await sleep(1500)
    infraOk = true
  } catch (err) {
    console.error(`[smoke-cdp] 인프라 셋업 실패: ${err.message}`)
    results.push({ id: 'INFRA', name: '외피 CDP 연결', status: 'FAIL', detail: err.message, ms: 0 })
  }

  if (infraOk) {
    await runScenario('S1', '새 탭 생성 + omnibox 검색 라우팅', () => scenarioS1(ctx))
    await runScenario('S2', '탭 로드 → 이동 → goBack', () => scenarioS2(ctx))
    await runScenario('S3', '탭 생성/전환/닫기', () => scenarioS3(ctx))
    await runScenario('S4', '북마크 추가/제거 (API + DOM)', () => scenarioS4(ctx))
    await runScenario('S5', '다운로드 (가속 Range + 단일 폴백, 바이트 검증)', () => scenarioS5(ctx))
    await runScenario('S6', '동영상 감지 + 직접 다운로드 (yt-dlp 미사용)', () => scenarioS6(ctx))
    await runScenario('S7', 'settings.set → settings.get 반영', () => scenarioS7(ctx))
    await runScenario('S8', '명령 팔레트 열기/닫기', () => scenarioS8(ctx))
    await runScenario('S9', '워크스페이스 전환 + 격리', () => scenarioS9(ctx))
    await runScenario('R11R12', 'browser:// 링크 OS 다이얼로그 회귀 (워크스페이스 partition)', () => scenarioR11R12(ctx))
    await runScenario('R13', 'adblock — 워크스페이스 partition 세션 적용 (회귀 #13)', () => scenarioR13(ctx))
    await runScenario('S10', 'adblock — 광고 리소스 차단', () => scenarioS10(ctx))
    await runScenario('S11', '다크모드 토글 → 콘텐츠 CSS 주입', () => scenarioS11(ctx))
    await runScenario('S12', '시크릿 창 (incognito)', () => scenarioS12(ctx))
    await runScenario('Z1', 'z-order: 토스트 위에 콘텐츠 안 가려짐 (OS 스크린샷)', () => scenarioZ1(ctx))
    await runScenario('Z2', 'z-order: QR 모달 (OS 스크린샷)', () => scenarioZ2(ctx))
  } else {
    for (const [id, name] of [
      ['S1', '새 탭 생성 + omnibox 검색 라우팅'], ['S2', '탭 로드 → 이동 → goBack'],
      ['S3', '탭 생성/전환/닫기'], ['S4', '북마크 추가/제거'], ['S5', '다운로드'],
      ['S6', '동영상 감지/다운로드'], ['S7', 'settings 왕복'],
      ['S8', '명령 팔레트'], ['S9', '워크스페이스 전환 + 격리'], ['R11R12', 'browser:// 링크 회귀'],
      ['R13', 'adblock 워크스페이스 partition'], ['S10', 'adblock'], ['S11', '다크모드'],
      ['S12', '시크릿 창'], ['Z1', 'z-order 토스트'], ['Z2', 'z-order QR'],
    ]) {
      results.push({ id, name, status: 'FAIL', detail: 'INFRA 실패로 실행 안 됨', ms: 0 })
    }
  }

  for (const s of ctx.state.openSessions) s.close()

  if (testServer) {
    await testServer.close().catch(() => {})
    console.log('[smoke-cdp] S5/S6 테스트 서버 종료')
  }

  fs.writeFileSync(path.join(args.out, 'smoke-results.json'), JSON.stringify(results, null, 2))
  printResultsTable()

  if (!args.keepAlive) {
    console.log('[smoke-cdp] 앱 종료…')
    await killApp(child, args.port, args.out)
  } else {
    console.log('[smoke-cdp] --keep-alive 지정됨 — 앱을 종료하지 않음 (직접 확인 후 수동 종료하세요)')
    console.log(`[smoke-cdp] 다음 실행 시 이 프로세스(pid=${child.pid})는 자동으로 정리됩니다 (${procFilePath(args.out)}).`)
    child.unref() // 하네스 프로세스는 종료해도 앱은 계속 떠 있게(부모가 자식을 기다리지 않도록). app-proc.json 은 남겨둠.
  }

  return results.some((r) => r.status === 'FAIL') ? 1 : 0
}

main().then((code) => {
  // child.stdout/stderr 파이프(WriteStream) 가 열려 있으면 이벤트 루프가 자연 종료를 기다릴 수 있음 —
  // 스모크 게이트는 결과가 나오는 즉시 확실히 빠져나와야 하므로 명시적으로 종료한다.
  process.exit(code ?? 0)
}).catch((err) => {
  console.error('[smoke-cdp] 치명적 오류:', err)
  process.exit(2)
})
