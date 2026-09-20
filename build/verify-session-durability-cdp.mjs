#!/usr/bin/env node
// verify-session-durability-cdp.mjs — 세션 저장 내구성 회귀 재현 하네스 (수정 전, 재현 전용).
//
// 왜 있는가:
//   실사용에서 "강제 종료(크래시) 후 두 번째 탭이 복원되지 않는다"는 결함이 보고됐다.
//   이 하네스는 그 결함을 **결정적으로 재현**하고, 같은 취약 구조(디바운스 경합·저장 실패
//   삼킴·손상 항목이 forEach 를 끊는 것)가 만드는 인접 결함까지 함께 드러낸다.
//   수정은 이 하네스가 아니라 app/main/features/session/index.ts 쪽에서 별도로 진행된다 —
//   그래서 지금은 **FAIL 이 나와도 정상**이다. 나중에 그 수정이 들어오면 이 하네스가 PASS 로
//   바뀌어야 "고쳤다"는 증거가 된다.
//
// 재사용: build/session-restore-cdp.mjs 의 패턴을 그대로 따른다 —
//   - 의존성 0 CDP 클라이언트는 ./lib/cdp.mjs 에서 가져다 쓴다(복제하지 않는다)
//   - 프로세스 관리(launchApp/forceKillAppTree/gracefulThenForceKill)·프로필 시드·로컬 프로브
//     서버는 하네스마다 자기 것을 갖는 관례를 따라 이 파일 안에 복사해 둔다
//     (session-restore-cdp.mjs 는 건드리지 않는다 — 다른 엔지니어가 지금 그 옆 파일을 고치는 중)
//
// 안전 규칙(비타협):
//   - 격리된 --user-data-dir 만 사용한다. verify-out/session-durability/ 아래 프로필만 건드리고
//     사용자의 실제 프로필(%APPDATA%\ezBrowser 등)은 절대 만지지 않는다.
//   - 이 하네스가 직접 spawn 한 PID 만 taskkill 한다. `taskkill /IM` 이름 기반 종료는 절대 금지
//     (사용자가 자기 브라우저를 따로 켜 두었을 수 있다).
//
// 시나리오(고정 id):
//   SD1 두 탭 크래시 복원(보고된 결함 원본 재현)
//   SD2 제목 변동 중에도 구조 저장이 무한 연기되지 않는가(SD1 의 의심 원인을 직접 측정)
//   SD3 복원 직후 재크래시에도 탭이 남는가(복원된 상태의 자기 지속성)
//   SD4 저장 실패 주입 시 복구 자료가 보존되는가(정상 종료 경로의 방어력)
//   SD5 손상된 세션 항목 하나가 유효한 다른 탭 전체를 무너뜨리지 않는가
//   SD6 정상 종료 회귀(양성 대조 — 이 경로는 원래도 튼튼해야 한다)
//   SD7 사용자가 닫은 탭은 복원되지 않는가(부정 대조 — 복원이 지나치게 관대해지지 않았는지)
//
// 사용:
//   node build/verify-session-durability-cdp.mjs [--exe <path>] [--out <dir>] [--port <n>]
//                                                 [--only SD1,SD2,...]

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import {
  CDPSession,
  connectSession,
  connectShellSessionReady,
  getTargetList,
  isShellTarget,
  pollUntil,
  sleep,
  waitForPortFree,
  waitForTargetByUrlPredicate,
  withTimeout,
} from './lib/cdp.mjs'
import { preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const DEFAULTS = {
  exe: path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe'),
  out: path.join(REPO_ROOT, 'verify-out', 'session-durability'),
  port: 9288, // 다른 하네스와 안 겹치는 값 — preferFreePort 가 점유 시 자동으로 빈 포트로 대체
}

function parseArgs(argv) {
  const out = { ...DEFAULTS, only: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--exe') out.exe = path.resolve(argv[++i] ?? '')
    else if (a === '--out') out.out = path.resolve(argv[++i] ?? '')
    else if (a === '--port') out.port = Number(argv[++i] ?? DEFAULTS.port)
    // ⚠ 콤마로 구분된 목록이어야 한다 — 단일 id 만 받도록 잘못 만들었다가 다른 라운드가 데인 전례가 있다.
    else if (a === '--only') out.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else console.warn(`[session-durability] 알 수 없는 인자 무시: ${a}`)
  }
  return out
}

// ── 프로세스 관리 (PID 스코프만 — 이름 기반 종료 절대 금지) ────────────────
// session-restore-cdp.mjs 와 동일한 패턴. 그 파일을 refactor 하지 않고 이 파일에 복사해 둔다.

function procFilePath(outDir) { return path.join(outDir, 'app-proc.json') }

function readProcFile(outDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(procFilePath(outDir), 'utf8'))
    if (parsed && typeof parsed.pid === 'number') return parsed
    return null
  } catch { return null }
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
  if (res.error) console.warn('[session-durability] taskkill 오류(무시):', res.error.message)
  return res
}

function isPidAlive(pid) {
  if (!pid) return false
  const res = spawnSync('powershell', [
    '-NoProfile', '-Command',
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Write-Output 'alive' }`,
  ], { encoding: 'utf8' })
  return (res.stdout || '').includes('alive')
}

async function waitPidGone(pid, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return true
    await sleep(300)
  }
  return !isPidAlive(pid)
}

async function tryGracefulShutdown(port, timeoutMs = 3000) {
  try {
    const res = await withTimeout(fetch(`http://127.0.0.1:${port}/json/version`), timeoutMs, 'graceful /json/version')
    if (!res.ok) return false
    const info = await res.json()
    const wsUrl = info.webSocketDebuggerUrl
    if (!wsUrl) return false
    const s = new CDPSession(wsUrl, 'browser-close')
    await s.connect(timeoutMs)
    await s.send('Browser.close', {}, timeoutMs).catch(() => {})
    s.close()
    return true
  } catch { return false }
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
  console.log(`[session-durability] 이전 실행의 잔존 프로세스(pid=${stale.pid}) 정리 시도…`)
  if (isPidAlive(stale.pid)) {
    const graceful = await tryGracefulShutdown(stale.port)
    if (graceful) await sleep(1500)
    if (isPidAlive(stale.pid)) killPidTree(stale.pid)
  }
  removeProcFile(outDir)
}

function launchApp(exePath, outDir, port, profileDir, tag) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // Electron 이 일반 Node 모드로 뜨는 걸 방지 (알려진 환경 이슈)

  const stdoutPath = path.join(outDir, `app-stdout-${tag}.log`)
  const stderrPath = path.join(outDir, `app-stderr-${tag}.log`)
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
    console.log(`[session-durability] [${tag}] app process exited (code=${code} signal=${signal})`)
  })
  writeProcFile(outDir, { pid: child.pid, port })
  return { child, stdoutPath, stderrPath }
}

/** 정상 종료 우선 시도 후 taskkill — 뒷정리에만 사용. 비정상 종료 시뮬레이션에는 forceKillAppTree 사용. */
async function gracefulThenForceKill(child, port, outDir) {
  if (!child || child.exitCode !== null) { removeProcFile(outDir); return }
  const graceful = await tryGracefulShutdown(port)
  if (graceful) {
    const exited = await waitForExit(child, 5000)
    if (exited) { removeProcFile(outDir); return }
  }
  try { child.kill() } catch { /* ignore */ }
  killPidTree(child.pid)
  removeProcFile(outDir)
}

/** 진짜 비정상 종료: taskkill /PID /T /F 만 사용 — graceful 경로(Browser.close/before-quit) 전혀 안 탐. */
async function forceKillAppTree(pid, outDir) {
  killPidTree(pid)
  const gone = await waitPidGone(pid, 5000)
  removeProcFile(outDir)
  return gone
}

// ── 격리 프로필 시드 ────────────────────────────────────────────────────
// startup.mode='last-session' 강제 — 비정상 종료 복원이 네이티브 확인 모달 없이 자동으로
// 일어나야 CDP 로 끝까지 검증 가능하다(newtab 모드는 dialog.showMessageBox 로 부팅이 막힌다).

function seedProfile(profileDir) {
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const settingsPath = path.join(profileDir, 'settings.json')
  const seed = {
    setup: { completed: true, completedAt: Date.now(), version: 'session-durability-cdp' },
    startup: { mode: 'last-session', urls: [] },
  }
  fs.writeFileSync(settingsPath, JSON.stringify(seed, null, 2))
}

function sessionsDir(profileDir) { return path.join(profileDir, 'sessions') }
function currentSessionPath(profileDir) { return path.join(sessionsDir(profileDir), 'current.json') }
function lastStableSessionPath(profileDir) { return path.join(sessionsDir(profileDir), 'last-stable.json') }

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch { return null }
}

/** 스냅샷에서 windowId 에 해당하는 창의 탭 URL 목록(정렬). 창을 못 찾으면 null. */
function snapshotTabUrls(snap, windowId) {
  if (!snap || !Array.isArray(snap.windows)) return null
  const win = windowId ? snap.windows.find((w) => w.windowId === windowId) : snap.windows[0]
  if (!win || !Array.isArray(win.tabs)) return null
  return win.tabs.map((t) => t.url).slice().sort()
}

/** 파일 존재·savedAt·탭 URL 목록을 한 번에 캡처 — pre/post-kill 증거용(SD1·SD2 보고 항목). */
function captureFileEvidence(filePath, windowId) {
  const exists = fs.existsSync(filePath)
  const snap = exists ? readJsonSafe(filePath) : null
  return {
    exists,
    savedAt: snap?.savedAt ?? null,
    tabUrls: snapshotTabUrls(snap, windowId),
  }
}

// ── 로컬 프로브 HTTP 서버 ────────────────────────────────────────────────
// /p?n=<N>  — 정적 탭 (SD1·SD3·SD5·SD6·SD7 용, 구분 가능한 로컬 URL)
// /churn    — document.title 을 300ms 마다 영원히 바꾸는 페이지 (SD2 의 의심 원인 재현용:
//             tabEvents 'update' 가 매번 scheduleSave(기본 5s) 를 호출해 구조 저장 타이머를
//             계속 뒤로 미룰 수 있는가)

function probeHtml(n) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Probe P${n}</title></head>`
    + `<body><h1>Probe P${n}</h1><p>probe-p-${n}</p></body></html>`
}

const CHURN_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Churn 0</title></head>
<body>
<h1>Churn Page</h1>
<p>document.title 이 300ms 마다 영원히 바뀐다.</p>
<script>
  var i = 0;
  setInterval(function () { i += 1; document.title = 'Churn ' + i; }, 300);
</script>
</body>
</html>`

function startProbeServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      res.setHeader('Cache-Control', 'no-store')
      if (u.pathname === '/p') {
        const n = u.searchParams.get('n') ?? '0'
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(probeHtml(n))
        return
      }
      if (u.pathname === '/churn') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(CHURN_HTML)
        return
      }
      // /secret — 비밀번호 칸과 일반 텍스트 칸이 하나씩. SD8 에서 "세션 스냅샷이 비밀번호를
      // 디스크에 적지 않는가" 를 실제 파일 바이트로 확인하는 데 쓴다.
      if (u.pathname === '/secret') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end('<!doctype html><html><head><meta charset="utf-8"><title>Secret Form</title></head>'
          + '<body><h1>Secret Form</h1><form>'
          + '<input id="pw" type="password" name="password" autocomplete="current-password">'
          + '<input id="plain" type="text" name="nickname">'
          + '</form></body></html>')
        return
      }
      res.statusCode = 404
      res.end('not found')
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        server,
        port,
        pUrl: (n) => `http://127.0.0.1:${port}/p?n=${n}`,
        churnUrl: `http://127.0.0.1:${port}/churn`,
        secretUrl: `http://127.0.0.1:${port}/secret`,
        close: () => new Promise((r) => {
          // 앱의 keep-alive 연결 때문에 close() 콜백이 영영 안 오는 정지를 이 저장소에서 겪었다.
          try { server.closeAllConnections?.() } catch { /* ignore */ }
          const t = setTimeout(r, 3000)
          server.close(() => { clearTimeout(t); r() })
        }),
      })
    })
  })
}

// ── CDP 헬퍼 (evaluate/callApi — session-restore-cdp.mjs 와 동일 패턴) ─────

async function evaluate(session, expression, opts = {}) {
  const { awaitPromise = true, returnByValue = true, timeoutMs = 15_000 } = opts
  const result = await session.send('Runtime.evaluate', { expression, awaitPromise, returnByValue, userGesture: true }, timeoutMs)
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

async function getWindowId(chromeSession) {
  const windowId = await evaluate(chromeSession, `new URL(location.href).searchParams.get('windowId')`)
  if (!windowId) throw new Error('외피 URL 에서 windowId 를 읽지 못함')
  return windowId
}

async function waitTabLoaded(chromeSession, windowId, tabId, urlPrefix, timeoutMs = 15_000) {
  return pollUntil(async () => {
    const tabs = await callApi(chromeSession, 'tabs.list', [windowId])
    const t = tabs.find((x) => x.id === tabId)
    return (t && !t.loading && typeof t.url === 'string' && t.url.startsWith(urlPrefix)) ? t : null
  }, { timeoutMs, label: `탭(${tabId}) ${urlPrefix} 로드 완료` })
}

async function waitTabsAtLeast(chromeSession, windowId, n, timeoutMs = 25_000) {
  return pollUntil(async () => {
    const tabs = await callApi(chromeSession, 'tabs.list', [windowId])
    return tabs.length >= n ? tabs : null
  }, { timeoutMs, label: `탭 ${n}개 이상 도달` })
}

/**
 * waitTabsAtLeast 의 관대한 버전 — 타임아웃이 나도 예외를 던지지 않고 "그 시점의 실제 탭 목록"을
 * 돌려준다. 이 하네스는 "복원이 실패한다"를 재현하는 게 목적이므로, 실패했을 때도 계속 진행해
 * 무엇이 실제로 복원됐는지 기록해야 한다 (예외로 시나리오 전체를 끊으면 진단 정보를 잃는다).
 */
async function safeWaitTabsAtLeast(chromeSession, windowId, n, timeoutMs = 25_000) {
  try {
    return await waitTabsAtLeast(chromeSession, windowId, n, timeoutMs)
  } catch (err) {
    console.warn(`[session-durability] 탭 ${n}개 도달 타임아웃 — 현재 상태로 계속 진행: ${err.message}`)
    return await callApi(chromeSession, 'tabs.list', [windowId]).catch(() => [])
  }
}

async function launchAndConnect(args, profileDir, tag) {
  if (!(await waitForPortFree(args.port))) {
    // 좀비 인스턴스가 디버그 포트를 쥐고 있으면 /json/list 가 죽은 타깃을 돌려준다.
    // 남의(또는 시체의) 브라우저를 검사하느니 큰 소리로 실패한다.
    throw new Error(`디버그 포트 ${args.port} 가 이미 사용 중입니다 — 남은 인스턴스를 종료하거나 다른 포트를 지정하세요.`)
  }
  const { child } = launchApp(args.exe, args.out, args.port, profileDir, tag)
  const chromeSession = await connectShellSessionReady(args.port, {
    label: `chrome-shell-${tag}`,
    log: (msg) => console.log(`[session-durability-cdp] ${msg}`),
  })
  const windowId = await getWindowId(chromeSession)
  return { child, chromeSession, windowId }
}

/** 실행 중 살아 있으면 그 프로세스만 죽인다 — 이름 기반 종료는 절대 하지 않는다. */
function killIfAlive(outDir) {
  const stale = readProcFile(outDir)
  if (stale && isPidAlive(stale.pid)) { killPidTree(stale.pid); removeProcFile(outDir) }
}

// ── 결과 기록 ────────────────────────────────────────────────────────────

const checks = []
function record(id, name, status, detail) {
  checks.push({ id, name, status, detail })
  const shortDetail = typeof detail === 'string' ? detail : JSON.stringify(detail)
  console.log(`  [${status}] ${id} ${name}${shortDetail ? ` — ${shortDetail.slice(0, 300)}` : ''}`)
}

// ── SD1: 두 탭 크래시 복원 (보고된 결함 원본 재현) ─────────────────────────
//
// 실사용 보고: "강제 종료 후 두 번째 탭이 사라진다." 재현 조건이 핵심이다 — 두 번째 탭을 만든
// 뒤 정확히 1500ms 만 정착시킨다. 구조 변경(tabEvents 'list')의 디바운스는 1000ms 이므로 이
// 시점이면 이미 지났어야 하고, 일반 디바운스(5000ms)는 아직 안 지났다. 즉 "구조 저장이 제대로
// 동작한다면" 이 타이밍에서 current.json 은 이미 두 탭을 담고 있어야 한다.
//
// 판정은 디스크 스냅샷이 아니라 **재기동 후 tabs.list**로 한다 — 사용자가 실제로 보는 것은
// 파일이 아니라 복원된 탭이기 때문이다. pre/post-kill 파일 증거는 진단용으로만 detail 에 남긴다.

async function scenarioSD1(args, probe) {
  const id = 'SD1'
  const name = '두 탭 크래시 복원 (보고된 결함)'
  const profileDir = path.join(args.out, 'profile-sd1')
  seedProfile(profileDir)
  let launch1 = null
  let launch2 = null
  try {
    launch1 = await launchAndConnect(args, profileDir, 'sd1-boot')
    const { chromeSession, windowId } = launch1

    const t0all = await waitTabsAtLeast(chromeSession, windowId, 1)
    const t0 = t0all[0]
    await callApi(chromeSession, 'tabs.navigate', [t0.id, probe.pUrl(1)])
    await waitTabLoaded(chromeSession, windowId, t0.id, probe.pUrl(1))

    const t1 = await callApi(chromeSession, 'tabs.create', [windowId, probe.pUrl(2)])
    await waitTabLoaded(chromeSession, windowId, t1.id, probe.pUrl(2))

    // 정확히 1500ms — 구조 디바운스(1s)는 지나고 일반 디바운스(5s)는 안 지난 지점.
    await sleep(1500)

    const curPath = currentSessionPath(profileDir)
    const stablePath = lastStableSessionPath(profileDir)
    const preKillCurrent = captureFileEvidence(curPath, windowId)
    const preKillStable = captureFileEvidence(stablePath, windowId)
    console.log(`[SD1] 강제 kill 전 current.json 증거: ${JSON.stringify(preKillCurrent)}`)
    console.log(`[SD1] 강제 kill 전 last-stable.json 증거: ${JSON.stringify(preKillStable)}`)

    try { chromeSession.close() } catch { /* ignore */ }
    const pidKilledCleanly = await forceKillAppTree(launch1.child.pid, args.out)

    const postKillCurrent = captureFileEvidence(curPath, windowId)
    const postKillStable = captureFileEvidence(stablePath, windowId)
    console.log(`[SD1] 강제 kill 후 current.json 증거: ${JSON.stringify(postKillCurrent)}`)
    console.log(`[SD1] 강제 kill 후 last-stable.json 증거: ${JSON.stringify(postKillStable)}`)

    await sleep(1000) // 강제 kill 직후 파일 핸들 해제 버퍼

    launch2 = await launchAndConnect(args, profileDir, 'sd1-restore')
    const tabs = await safeWaitTabsAtLeast(launch2.chromeSession, launch2.windowId, 2, 25_000)
    const restoredUrls = tabs.map((t) => t.url)
    const hasP1 = restoredUrls.some((u) => u.startsWith(probe.pUrl(1)))
    const hasP2 = restoredUrls.some((u) => u.startsWith(probe.pUrl(2)))
    const pass = hasP1 && hasP2

    record(id, name, pass ? 'PASS' : 'FAIL', {
      pidKilledCleanly,
      preKillCurrent, preKillStable, postKillCurrent, postKillStable,
      restoredUrls, hasP1, hasP2,
    })
  } catch (err) {
    record(id, name, 'FAIL', `예외: ${err.stack ?? err}`)
  } finally {
    if (launch2) {
      try { launch2.chromeSession.close() } catch { /* ignore */ }
      await gracefulThenForceKill(launch2.child, args.port, args.out)
    }
    if (launch1 && isPidAlive(launch1.child.pid)) killPidTree(launch1.child.pid)
    killIfAlive(args.out)
  }
}

// ── SD2: 제목 변동 중에도 구조 저장이 무한 연기되지 않는다 ─────────────────
//
// SD1 의 의심 원인을 직접 측정한다. tab-service 의 'page-title-updated' 는 tabEvents 'update' 를
// 내보내고, session/index.ts 는 그걸 `scheduleSave()`(기본 5000ms)로 받는다. `scheduleSave` 는
// 지연 시간과 무관하게 **공유된 단일 타이머**를 clearTimeout 후 재설정한다 — 즉 구조 변경으로 예약된
// 1000ms 타이머라도, 그 전에 title 이 한 번만 바뀌면 5000ms 로 밀린다. 제목이 300ms 마다 영원히
// 바뀌면(=간격이 5000ms 보다 훨씬 짧다) 이 저장이 영원히 뒤로 밀릴 수 있다는 뜻이다.

async function scenarioSD2(args, probe) {
  const id = 'SD2'
  const name = '제목 변동 중에도 구조 저장이 무한 연기되지 않는다'
  const profileDir = path.join(args.out, 'profile-sd2')
  seedProfile(profileDir)
  let launch = null
  try {
    launch = await launchAndConnect(args, profileDir, 'sd2-boot')
    const { chromeSession, windowId } = launch

    const t0all = await waitTabsAtLeast(chromeSession, windowId, 1)
    const t0 = t0all[0]
    await callApi(chromeSession, 'tabs.navigate', [t0.id, probe.pUrl(1)])
    await waitTabLoaded(chromeSession, windowId, t0.id, probe.pUrl(1))

    const tCreateStart = Date.now()
    const tb = await callApi(chromeSession, 'tabs.create', [windowId, probe.churnUrl])
    await waitTabLoaded(chromeSession, windowId, tb.id, probe.churnUrl)
    const loadedAtMs = Date.now() - tCreateStart

    const curPath = currentSessionPath(profileDir)
    let latencyMs = null
    let lastSnapUrls = null
    let timedOut = false
    try {
      await pollUntil(() => {
        const snap = readJsonSafe(curPath)
        const win = snap?.windows?.find((w) => w.windowId === windowId)
        lastSnapUrls = win ? win.tabs.map((t) => t.url) : null
        const hasBoth = !!win
          && win.tabs.some((t) => t.url.startsWith(probe.pUrl(1)))
          && win.tabs.some((t) => t.url === probe.churnUrl)
        if (hasBoth) { latencyMs = Date.now() - tCreateStart; return true }
        return null
      }, { timeoutMs: 12_000, intervalMs: 250, label: 'current.json 에 두 탭 모두 flush' })
    } catch {
      timedOut = true
    }

    const pass = typeof latencyMs === 'number' && latencyMs <= 3000
    record(id, name, pass ? 'PASS' : 'FAIL', {
      measuredLatencyMs: latencyMs,
      thresholdMs: 3000,
      tabBLoadedAfterMs: loadedAtMs,
      timedOutAt12000ms: timedOut,
      lastObservedSnapshotTabUrls: lastSnapUrls,
      note: timedOut
        ? 'churn 이 계속되는 동안 12초 안에 current.json 이 두 탭을 모두 담지 못했다 — 구조 저장이 title 갱신에 의해 계속 뒤로 밀렸을 가능성'
        : undefined,
    })
  } catch (err) {
    record(id, name, 'FAIL', `예외: ${err.stack ?? err}`)
  } finally {
    if (launch) {
      try { launch.chromeSession.close() } catch { /* ignore */ }
      await gracefulThenForceKill(launch.child, args.port, args.out)
    }
    killIfAlive(args.out)
  }
}

// ── SD3: 복원 직후 재크래시에도 탭이 남는다 ─────────────────────────────────
//
// SD1 이 통과하더라도, 복원된 세션 자체가 "다시 크래시해도 버티는" 안정 상태인지는 별개 질문이다.
// 복원 직후엔 활성화(activateTab)·레이아웃 재적용 등으로 또 다른 구조 이벤트가 발생하므로,
// 그 시점에 다시 크래시하면 "복원됐다가 다시 사라지는" 회귀가 생길 수 있다.

async function scenarioSD3(args, probe) {
  const id = 'SD3'
  const name = '복원 직후 재크래시에도 탭이 남는다'
  const profileDir = path.join(args.out, 'profile-sd3')
  seedProfile(profileDir)
  let launch1 = null
  let launch2 = null
  let launch3 = null
  try {
    // 1차: 두 탭 셋업 → 강제 kill (SD1 과 동일한 셋업)
    launch1 = await launchAndConnect(args, profileDir, 'sd3-boot')
    {
      const { chromeSession, windowId } = launch1
      const t0all = await waitTabsAtLeast(chromeSession, windowId, 1)
      const t0 = t0all[0]
      await callApi(chromeSession, 'tabs.navigate', [t0.id, probe.pUrl(1)])
      await waitTabLoaded(chromeSession, windowId, t0.id, probe.pUrl(1))
      const t1 = await callApi(chromeSession, 'tabs.create', [windowId, probe.pUrl(2)])
      await waitTabLoaded(chromeSession, windowId, t1.id, probe.pUrl(2))
      await sleep(1500)
      try { chromeSession.close() } catch { /* ignore */ }
    }
    const pidKilledCleanly1 = await forceKillAppTree(launch1.child.pid, args.out)
    await sleep(1000)

    // 2차: 재기동 → 복원 확인 → 복원 완료 시점부터 1500ms 정착 → 다시 강제 kill
    launch2 = await launchAndConnect(args, profileDir, 'sd3-restore1')
    let restoredOnceUrls = []
    {
      const tabs = await safeWaitTabsAtLeast(launch2.chromeSession, launch2.windowId, 2, 25_000)
      restoredOnceUrls = tabs.map((t) => t.url)
      await sleep(1500)
      try { launch2.chromeSession.close() } catch { /* ignore */ }
    }
    const pidKilledCleanly2 = await forceKillAppTree(launch2.child.pid, args.out)
    await sleep(1000)

    // 3차: 재기동 → 최종 확인
    launch3 = await launchAndConnect(args, profileDir, 'sd3-restore2')
    const finalTabs = await safeWaitTabsAtLeast(launch3.chromeSession, launch3.windowId, 2, 25_000)
    const finalUrls = finalTabs.map((t) => t.url)

    const hasP1 = finalUrls.some((u) => u.startsWith(probe.pUrl(1)))
    const hasP2 = finalUrls.some((u) => u.startsWith(probe.pUrl(2)))
    record(id, name, (hasP1 && hasP2) ? 'PASS' : 'FAIL', {
      pidKilledCleanly1, pidKilledCleanly2,
      restoredOnceUrls, finalUrls, hasP1, hasP2,
    })
  } catch (err) {
    record(id, name, 'FAIL', `예외: ${err.stack ?? err}`)
  } finally {
    if (launch3) {
      try { launch3.chromeSession.close() } catch { /* ignore */ }
      await gracefulThenForceKill(launch3.child, args.port, args.out)
    }
    for (const l of [launch1, launch2]) {
      if (l && isPidAlive(l.child.pid)) killPidTree(l.child.pid)
    }
    killIfAlive(args.out)
  }
}

// ── SD4: 저장 실패 주입 시 복구 자료 보존 ───────────────────────────────────
//
// before-quit 훅은 last-stable.json 을 먼저 쓰고 나서 current.json 을 지운다. 그런데
// writeSnapshot() 내부의 try/catch 가 쓰기 실패를 조용히 삼키고 **다시 던지지 않는다** — 즉
// last-stable 쓰기가 실패해도 바깥 코드는 그걸 모른 채 그대로 진행해 current.json 을 지워버릴
// 수 있다. 그러면 last-stable 도 없고 current 도 없는 "완전 유실" 상태가 된다.
//
// 권한을 건드리지 않고 실패를 주입하는 방법: writeSnapshot 은 `<target>.tmp` 에 먼저 쓴 뒤
// rename 한다. 그 `.tmp` 자리에 **디렉터리**를 만들어 두면 writeFileSync 가 EISDIR 로 반드시
// 실패한다.

function craftMalformedDir(stableTmpPath) {
  fs.rmSync(stableTmpPath, { recursive: true, force: true })
  fs.mkdirSync(stableTmpPath, { recursive: true })
}

async function scenarioSD4(args, probe) {
  const id = 'SD4'
  const name = '저장 실패 주입 시 복구 자료 보존'
  const profileDir = path.join(args.out, 'profile-sd4')
  seedProfile(profileDir)
  let launch1 = null
  let launch2 = null
  try {
    launch1 = await launchAndConnect(args, profileDir, 'sd4-boot')
    const { chromeSession, windowId } = launch1

    const t0all = await waitTabsAtLeast(chromeSession, windowId, 1)
    const t0 = t0all[0]
    await callApi(chromeSession, 'tabs.navigate', [t0.id, probe.pUrl(1)])
    await waitTabLoaded(chromeSession, windowId, t0.id, probe.pUrl(1))
    const t1 = await callApi(chromeSession, 'tabs.create', [windowId, probe.pUrl(2)])
    await waitTabLoaded(chromeSession, windowId, t1.id, probe.pUrl(2))

    const curPath = currentSessionPath(profileDir)
    const stablePath = lastStableSessionPath(profileDir)

    // 사전조건: current.json 이 두 탭을 담을 때까지 정착(주입과 무관하게 sessions/ 디렉터리를
    // 만들어 두기 위함이기도 하다). 이게 타임아웃 나도(SD1/SD2 결함이 이미 여기서 나타난 것일
    // 수 있다) before-quit 은 라이브 상태에서 별도로 buildSnapshot() 하므로 SD4 자체 검증에는
    // 지장이 없다 — 그래서 실패해도 시나리오를 계속 진행한다.
    await pollUntil(() => {
      const snap = readJsonSafe(curPath)
      const win = snap?.windows?.find((w) => w.windowId === windowId)
      const ok = !!win
        && win.tabs.some((t) => t.url.startsWith(probe.pUrl(1)))
        && win.tabs.some((t) => t.url.startsWith(probe.pUrl(2)))
      return ok ? true : null
    }, { timeoutMs: 15_000, intervalMs: 300, label: 'current.json 사전 flush(주입 전 준비 단계)' })
      .catch(() => console.warn('[SD4] current.json 사전 flush 확인 실패 — 계속 진행'))

    // 실패 주입
    fs.mkdirSync(path.dirname(stablePath), { recursive: true })
    const stableTmpPath = `${stablePath}.tmp`
    craftMalformedDir(stableTmpPath)
    const injectedIsDir = fs.existsSync(stableTmpPath) && fs.statSync(stableTmpPath).isDirectory()

    // 정상(graceful) 종료 — before-quit 훅을 실제로 타야 이 시나리오가 의미 있다.
    try { chromeSession.close() } catch { /* ignore */ }
    const gracefulTriggered = await tryGracefulShutdown(args.port)
    const exitedGracefully = await waitForExit(launch1.child, 8000)
    if (!exitedGracefully) { killPidTree(launch1.child.pid); await waitPidGone(launch1.child.pid, 5000) }
    removeProcFile(args.out)

    const afterQuitCurrent = captureFileEvidence(curPath, windowId)
    const afterQuitStable = captureFileEvidence(stablePath, windowId)
    const tmpStillDirAfterQuit = fs.existsSync(stableTmpPath) && fs.statSync(stableTmpPath).isDirectory()
    console.log(`[SD4] 종료 후 current.json 증거: ${JSON.stringify(afterQuitCurrent)}`)
    console.log(`[SD4] 종료 후 last-stable.json 증거: ${JSON.stringify(afterQuitStable)}`)

    await sleep(500)
    launch2 = await launchAndConnect(args, profileDir, 'sd4-restore')
    const finalTabs = await safeWaitTabsAtLeast(launch2.chromeSession, launch2.windowId, 2, 20_000)
    const finalUrls = finalTabs.map((t) => t.url)

    const hasP1 = finalUrls.some((u) => u.startsWith(probe.pUrl(1)))
    const hasP2 = finalUrls.some((u) => u.startsWith(probe.pUrl(2)))
    const survivingSource = afterQuitStable.exists ? 'last-stable.json' : (afterQuitCurrent.exists ? 'current.json' : '(없음 — 유실)')

    record(id, name, (hasP1 && hasP2) ? 'PASS' : 'FAIL', {
      injectedIsDir, gracefulTriggered, exitedGracefully,
      afterQuitCurrent, afterQuitStable, tmpStillDirAfterQuit, survivingSource,
      finalUrls, hasP1, hasP2,
    })
  } catch (err) {
    record(id, name, 'FAIL', `예외: ${err.stack ?? err}`)
  } finally {
    if (launch2) {
      try { launch2.chromeSession.close() } catch { /* ignore */ }
      await gracefulThenForceKill(launch2.child, args.port, args.out)
    }
    if (launch1 && isPidAlive(launch1.child.pid)) killPidTree(launch1.child.pid)
    killIfAlive(args.out)
  }
}

// ── SD5: 손상 항목이 유효 탭 전체를 무너뜨리지 않는다 ───────────────────────
//
// restoreSnapshot() 은 `w.tabs.forEach((t, i) => { const created = createTab({ url: t.url, ... }) })`
// 로 탭을 만든다. createTab() 은 맨 앞에서 `initialUrl.startsWith('browser:')` 를 호출하는데,
// url 이 문자열이 아니면(예: 42) 이 호출 자체가 TypeError 를 던진다 — try/catch 로 감싸여 있지
// 않으므로 forEach 를 그대로 끊고, **그 뒤 인덱스의 유효한 탭들까지 전부 만들어지지 못한 채**
// 예외가 maybeRestoreSession() 밖으로 전파된다(main/index.ts 의 .catch 가 잡아 앱 부팅 자체는
// 막지 않지만, current.json 삭제 직전에 끊기므로 손상된 스냅샷이 디스크에 그대로 남는다).

function craftSd5Snapshot(windowId, pUrl) {
  return {
    version: 1,
    savedAt: Date.now(),
    windows: [
      {
        windowId,
        activeTabId: null,
        tabs: [
          { url: pUrl(1), title: 'Probe P1', pinned: false, workspaceId: 'bogus-ws', active: true, index: 0 },
          // 고의로 손상 — url 이 문자열이 아니다.
          { url: 42, title: 'broken', pinned: false, workspaceId: 'bogus-ws', active: false, index: 1 },
          { url: pUrl(3), title: 'Probe P3', pinned: false, workspaceId: 'bogus-ws', active: false, index: 2 },
        ],
      },
    ],
  }
}

async function scenarioSD5(args, probe) {
  const id = 'SD5'
  const name = '손상 항목이 유효 탭 전체를 무너뜨리지 않는다'
  const profileDir = path.join(args.out, 'profile-sd5')
  seedProfile(profileDir)
  let launch = null
  try {
    const curPath = currentSessionPath(profileDir)
    const stablePath = lastStableSessionPath(profileDir)
    fs.mkdirSync(path.dirname(curPath), { recursive: true })
    fs.rmSync(stablePath, { force: true }) // "last-stable.json 제거" — 스펙 명시

    // 앱이 실행 중이 아닌 상태에서 손으로 current.json 작성.
    // windowId 값 자체는 restoreSnapshot 이 항상 createBrowserWindow() 로 새 창을 만들기 때문에
    // (스냅샷의 windowId 로 기존 창을 찾지 않는다) 실제로 매칭될 필요가 없다 — 아무 문자열이나 된다.
    const crafted = craftSd5Snapshot('w1', probe.pUrl)
    fs.writeFileSync(curPath, JSON.stringify(crafted, null, 2))
    const craftedTabs = crafted.windows[0].tabs.map((t) => ({ url: t.url, index: t.index }))

    launch = await launchAndConnect(args, profileDir, 'sd5-boot')
    const tabs = await safeWaitTabsAtLeast(launch.chromeSession, launch.windowId, 1, 20_000)
    const finalUrls = tabs.map((t) => t.url)
    const shellHtmlLen = await evaluate(launch.chromeSession, `document.body ? document.body.innerHTML.length : 0`).catch(() => 0)
    const bootOk = shellHtmlLen > 200

    const hasP1 = finalUrls.some((u) => u.startsWith(probe.pUrl(1)))
    const hasP3 = finalUrls.some((u) => u.startsWith(probe.pUrl(3)))
    // "원본 파일이 어딘가에 증거로 남았는가" — 이 코드베이스엔 손상 파일 격리 관례가 없으므로
    // 남는다면 그건 "정상 정리 경로(safeUnlink)가 예외 때문에 도달하지 못했다"는 뜻이다.
    const originalCurrentStillPresent = fs.existsSync(curPath)
    const currentFileAfterBoot = readJsonSafe(curPath)

    const pass = hasP1 && hasP3 && bootOk
    record(id, name, pass ? 'PASS' : 'FAIL', {
      craftedTabs, finalUrls, hasP1, hasP3, bootOk,
      originalCurrentStillPresent, currentFileAfterBoot,
    })
  } catch (err) {
    record(id, name, 'FAIL', `예외: ${err.stack ?? err}`)
  } finally {
    if (launch) {
      try { launch.chromeSession.close() } catch { /* ignore */ }
      await gracefulThenForceKill(launch.child, args.port, args.out)
    }
    killIfAlive(args.out)
  }
}

// ── SD6: 정상 종료 회귀 (양성 대조) ─────────────────────────────────────────
//
// 크래시 경로만 파느라 가장 흔한 경로(정상 종료)를 깨뜨리지 않았는지 확인하는 대조군.
// 이게 깨지면 SD1~SD5 의 어떤 수정도 "고쳤다"고 부를 수 없다.

async function scenarioSD6(args, probe) {
  const id = 'SD6'
  const name = '정상 종료 회귀 (양성 대조)'
  const profileDir = path.join(args.out, 'profile-sd6')
  seedProfile(profileDir)
  let launch1 = null
  let launch2 = null
  try {
    launch1 = await launchAndConnect(args, profileDir, 'sd6-boot')
    const { chromeSession, windowId } = launch1

    const t0all = await waitTabsAtLeast(chromeSession, windowId, 1)
    const t0 = t0all[0]
    await callApi(chromeSession, 'tabs.navigate', [t0.id, probe.pUrl(1)])
    await waitTabLoaded(chromeSession, windowId, t0.id, probe.pUrl(1))
    const t1 = await callApi(chromeSession, 'tabs.create', [windowId, probe.pUrl(2)])
    await waitTabLoaded(chromeSession, windowId, t1.id, probe.pUrl(2))
    await sleep(500)

    try { chromeSession.close() } catch { /* ignore */ }
    const gracefulTriggered = await tryGracefulShutdown(args.port)
    const exited = await waitForExit(launch1.child, 8000)
    if (!exited) { killPidTree(launch1.child.pid); await waitPidGone(launch1.child.pid, 5000) }
    removeProcFile(args.out)

    const stablePath = lastStableSessionPath(profileDir)
    const curPath = currentSessionPath(profileDir)
    const stableExistsAfterQuit = fs.existsSync(stablePath)
    const currentExistsAfterQuit = fs.existsSync(curPath)

    await sleep(500)
    launch2 = await launchAndConnect(args, profileDir, 'sd6-restore')
    const finalTabs = await safeWaitTabsAtLeast(launch2.chromeSession, launch2.windowId, 2, 20_000)
    const finalUrls = finalTabs.map((t) => t.url)

    const hasP1 = finalUrls.some((u) => u.startsWith(probe.pUrl(1)))
    const hasP2 = finalUrls.some((u) => u.startsWith(probe.pUrl(2)))
    const pass = hasP1 && hasP2 && stableExistsAfterQuit
    record(id, name, pass ? 'PASS' : 'FAIL', {
      gracefulTriggered, stableExistsAfterQuit, currentExistsAfterQuit, finalUrls, hasP1, hasP2,
    })
  } catch (err) {
    record(id, name, 'FAIL', `예외: ${err.stack ?? err}`)
  } finally {
    if (launch2) {
      try { launch2.chromeSession.close() } catch { /* ignore */ }
      await gracefulThenForceKill(launch2.child, args.port, args.out)
    }
    if (launch1 && isPidAlive(launch1.child.pid)) killPidTree(launch1.child.pid)
    killIfAlive(args.out)
  }
}

// ── SD7: 사용자가 닫은 탭은 닫힌 채로 있는다 (부정 대조) ────────────────────
//
// 내구성을 고친답시고 복원을 과하게 관대하게 만들면, 사용자가 의도적으로 닫은 탭까지
// 되살아나는 역효과가 생길 수 있다. 이 시나리오는 "닫은 탭은 안 돌아와야 한다"를 지켜
// 향후 수정이 그 경계를 넘지 않는지 감시한다.

async function scenarioSD7(args, probe) {
  const id = 'SD7'
  const name = '사용자가 닫은 탭은 닫힌 채로 있는다 (부정 대조)'
  const profileDir = path.join(args.out, 'profile-sd7')
  seedProfile(profileDir)
  let launch1 = null
  let launch2 = null
  try {
    launch1 = await launchAndConnect(args, profileDir, 'sd7-boot')
    const { chromeSession, windowId } = launch1

    const t0all = await waitTabsAtLeast(chromeSession, windowId, 1)
    const t0 = t0all[0]
    await callApi(chromeSession, 'tabs.navigate', [t0.id, probe.pUrl(1)])
    await waitTabLoaded(chromeSession, windowId, t0.id, probe.pUrl(1))
    const t1 = await callApi(chromeSession, 'tabs.create', [windowId, probe.pUrl(2)])
    await waitTabLoaded(chromeSession, windowId, t1.id, probe.pUrl(2))

    await callApi(chromeSession, 'tabs.close', [t1.id])
    await sleep(3000)

    try { chromeSession.close() } catch { /* ignore */ }
    const pidKilledCleanly = await forceKillAppTree(launch1.child.pid, args.out)
    await sleep(1000)

    launch2 = await launchAndConnect(args, profileDir, 'sd7-restore')
    const finalTabs = await safeWaitTabsAtLeast(launch2.chromeSession, launch2.windowId, 1, 20_000)
    const finalUrls = finalTabs.map((t) => t.url)

    const hasP1 = finalUrls.some((u) => u.startsWith(probe.pUrl(1)))
    const hasP2 = finalUrls.some((u) => u.startsWith(probe.pUrl(2)))
    const pass = hasP1 && !hasP2
    record(id, name, pass ? 'PASS' : 'FAIL', { pidKilledCleanly, finalUrls, hasP1, hasP2 })
  } catch (err) {
    record(id, name, 'FAIL', `예외: ${err.stack ?? err}`)
  } finally {
    if (launch2) {
      try { launch2.chromeSession.close() } catch { /* ignore */ }
      await gracefulThenForceKill(launch2.child, args.port, args.out)
    }
    if (launch1 && isPidAlive(launch1.child.pid)) killPidTree(launch1.child.pid)
    killIfAlive(args.out)
  }
}

/**
 * SD8 — 세션 스냅샷이 **비밀번호를 디스크에 적지 않는다**.
 *
 * 세션 복원은 스크롤 위치·폼 값을 되살리려고 Chromium 의 pageState 를 그대로 저장한다.
 * 그 안에 비밀번호까지 들어간다면 `sessions/current.json` 은 평문 비밀 저장소가 된다.
 * 추측하지 않고 **파일 바이트를 직접 뒤져서** 확인한다 — 원문·base64·UTF-16 세 형태 전부.
 * 대조군으로 일반 텍스트 칸에도 표식을 넣는다(그건 저장돼도 되고, 저장되는 것이 정상이다).
 */
async function scenarioSD8(args, probe) {
  const id = 'SD8'
  const name = '세션 스냅샷에 비밀번호가 적히지 않는다'
  const profileDir = path.join(args.out, 'profile-sd8')
  seedProfile(profileDir)
  const SECRET = 'SD8SECRETPW' + Date.now()
  const PLAIN = 'SD8PLAINNICK' + Date.now()
  let launch1 = null
  try {
    launch1 = await launchAndConnect(args, profileDir, 'sd8-boot')
    const { chromeSession, windowId } = launch1
    const t0all = await waitTabsAtLeast(chromeSession, windowId, 1)
    const t0 = t0all[0]
    await callApi(chromeSession, 'tabs.navigate', [t0.id, probe.secretUrl])
    await waitTabLoaded(chromeSession, windowId, t0.id, probe.secretUrl)

    // 콘텐츠 탭에 직접 붙어 두 칸을 채운다(실제 사용자 입력과 같은 이벤트를 낸다).
    const target = await waitForTargetByUrlPredicate(
      args.port, (url) => url.startsWith(probe.secretUrl), 'sd8 비밀 폼 탭', 20_000)
    const contentSession = await connectSession(target, 'content:sd8')
    try {
      await evaluate(contentSession, `(function(){
        function fill(id, v) {
          var el = document.getElementById(id);
          var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return el.value;
        }
        return [fill('pw', ${JSON.stringify(SECRET)}), fill('plain', ${JSON.stringify(PLAIN)})];
      })()`)
    } finally {
      try { contentSession.close() } catch { /* ignore */ }
    }

    // 입력이 가라앉고 스냅샷이 떠질 때까지 기다린다(구조 이벤트 하나로 저장을 유발).
    const interactionAt = Date.now()
    await sleep(2000)
    await callApi(chromeSession, 'tabs.create', [windowId, probe.pUrl(1), { background: true }])
    const curPath = currentSessionPath(profileDir)
    let settled = null
    try {
      settled = await pollUntil(() => {
        const snap = readJsonSafe(curPath)
        if (!snap || typeof snap.savedAt !== 'number') return null
        return snap.savedAt >= interactionAt + 7000 ? snap : null
      }, { timeoutMs: 40_000, intervalMs: 500, label: '정착 후 스냅샷' })
    } catch { /* 정착 스냅샷을 못 봐도 아래에서 파일 자체는 검사한다 */ }

    const raw = fs.existsSync(curPath) ? fs.readFileSync(curPath) : Buffer.alloc(0)
    const asUtf8 = raw.toString('utf8')
    const asB64 = raw.toString('base64')
    // pageState 는 base64 로 직렬화돼 들어간다 — 비밀이 그 안에 있으면 디코드했을 때 드러난다.
    const decodedBlobs = []
    try {
      const snap = JSON.parse(asUtf8)
      for (const w of snap.windows ?? []) {
        for (const t of w.tabs ?? []) {
          for (const h of t.history ?? []) {
            if (typeof h.pageState === 'string') {
              decodedBlobs.push(Buffer.from(h.pageState, 'base64').toString('binary'))
              decodedBlobs.push(Buffer.from(h.pageState, 'base64').toString('utf16le'))
            }
          }
        }
      }
    } catch { /* 파싱 실패해도 원문 검사만으로 충분 */ }
    const haystacks = [asUtf8, asB64, ...decodedBlobs]
    const secretFound = haystacks.some((h) => h.includes(SECRET))
    // 대조군: 일반 텍스트 칸은 pageState 에 들어가는 것이 **정상**이다. 들어갔다면 이 검사가
    // 실제로 폼 상태를 들여다보고 있다는 뜻이고, 안 들어갔다면 검사가 헛돌았을 수 있으니 기록만 한다.
    const plainFound = haystacks.some((h) => h.includes(PLAIN))
    record(id, name, !secretFound ? 'PASS' : 'FAIL', {
      snapshotBytes: raw.length,
      settledSnapshotSeen: !!settled,
      secretFoundOnDisk: secretFound,
      plainTextFoundOnDisk_대조군: plainFound,
      note: plainFound
        ? '일반 텍스트 칸은 디스크에 있고 비밀번호는 없다 — 검사가 실제로 폼 상태를 보고 있다는 증거'
        : '일반 텍스트 칸도 디스크에서 못 찾았다 — 이 실행에서는 폼 상태가 아직 저장되지 않았을 수 있다(검사 민감도 주의)',
    })
  } catch (err) {
    record(id, name, 'FAIL', `예외: ${err.stack ?? err}`)
  } finally {
    if (launch1) {
      try { launch1.chromeSession.close() } catch { /* ignore */ }
      await gracefulThenForceKill(launch1.child, args.port, args.out)
    }
    killIfAlive(args.out)
  }
}

/**
 * SD9 — 시크릿(incognito) 창의 탭은 디스크에도, 복원에도 없다 (부정 대조).
 * 이번 라운드가 "스냅샷을 더 자주·더 일찍 쓰게" 바꿨으므로, 그 변경이 시크릿 제외를
 * 뚫지 않았는지 반드시 확인해야 한다.
 */
async function scenarioSD9(args, probe) {
  const id = 'SD9'
  const name = '시크릿 창 탭은 디스크에도 복원에도 없다 (부정 대조)'
  const profileDir = path.join(args.out, 'profile-sd9')
  seedProfile(profileDir)
  let launch1 = null
  let launch2 = null
  try {
    launch1 = await launchAndConnect(args, profileDir, 'sd9-boot')
    const { chromeSession, windowId } = launch1
    const t0all = await waitTabsAtLeast(chromeSession, windowId, 1)
    await callApi(chromeSession, 'tabs.navigate', [t0all[0].id, probe.pUrl(1)])
    await waitTabLoaded(chromeSession, windowId, t0all[0].id, probe.pUrl(1))

    // 시크릿 창을 열고 그 안에서 표식 URL 을 연다.
    const before = await getTargetList(args.port)
    const beforeIds = new Set(before.filter(isShellTarget).map((t) => t.id))
    const ran = await callApi(chromeSession, 'actions.run', ['action.window.incognito', { windowId }])
    if (!ran) throw new Error('action.window.incognito 실행 실패')
    const incogShell = await pollUntil(async () => {
      const list = await getTargetList(args.port)
      return list.filter(isShellTarget).find((t) => !beforeIds.has(t.id)) ?? null
    }, { timeoutMs: 20_000, label: '시크릿 외피 타깃' })
    const incogSession = await connectSession(incogShell, 'chrome-sd9-incognito')
    let incogTabOk = false
    try {
      const incogWindowId = await evaluate(incogSession, `new URL(location.href).searchParams.get('windowId')`)
      const it = await callApi(incogSession, 'tabs.create', [incogWindowId, probe.pUrl(99)])
      await waitTabLoaded(incogSession, incogWindowId, it.id, probe.pUrl(99))
      incogTabOk = true
    } finally {
      try { incogSession.close() } catch { /* ignore */ }
    }

    await sleep(4000) // 저장이 한 번 뜨도록
    const curPath = currentSessionPath(profileDir)
    const rawBefore = fs.existsSync(curPath) ? fs.readFileSync(curPath, 'utf8') : ''
    const incogOnDisk = rawBefore.includes('n=99')

    try { chromeSession.close() } catch { /* ignore */ }
    const pidKilledCleanly = await forceKillAppTree(launch1.child.pid, args.out)
    await sleep(1000)

    launch2 = await launchAndConnect(args, profileDir, 'sd9-restore')
    const finalTabs = await safeWaitTabsAtLeast(launch2.chromeSession, launch2.windowId, 1, 20_000)
    const finalUrls = finalTabs.map((t) => t.url)
    const hasP1 = finalUrls.some((u) => u.startsWith(probe.pUrl(1)))
    const hasIncog = finalUrls.some((u) => u.includes('n=99'))
    // 시크릿 탭이 실제로 열렸는지(incogTabOk)까지 봐야 "안 열려서 통과" 를 배제할 수 있다.
    const pass = incogTabOk && !incogOnDisk && !hasIncog && hasP1
    record(id, name, pass ? 'PASS' : 'FAIL', {
      incogTabOpened: incogTabOk, incogUrlOnDisk: incogOnDisk, pidKilledCleanly,
      finalUrls, hasNormalTab: hasP1, hasIncognitoTab: hasIncog,
    })
  } catch (err) {
    record(id, name, 'FAIL', `예외: ${err.stack ?? err}`)
  } finally {
    if (launch2) {
      try { launch2.chromeSession.close() } catch { /* ignore */ }
      await gracefulThenForceKill(launch2.child, args.port, args.out)
    }
    if (launch1 && isPidAlive(launch1.child.pid)) killPidTree(launch1.child.pid)
    killIfAlive(args.out)
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────────

const SCENARIOS = [
  { id: 'SD1', fn: scenarioSD1 },
  { id: 'SD2', fn: scenarioSD2 },
  { id: 'SD3', fn: scenarioSD3 },
  { id: 'SD4', fn: scenarioSD4 },
  { id: 'SD5', fn: scenarioSD5 },
  { id: 'SD6', fn: scenarioSD6 },
  { id: 'SD7', fn: scenarioSD7 },
  { id: 'SD8', fn: scenarioSD8 },
  { id: 'SD9', fn: scenarioSD9 },
]

async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('[session-durability] Node 22+ 필요(전역 WebSocket 없음).')
    process.exit(2)
  }
  const args = parseArgs(process.argv.slice(2))
  fs.mkdirSync(args.out, { recursive: true })

  if (!fs.existsSync(args.exe)) {
    console.error(`[session-durability] exe 를 찾을 수 없음: ${args.exe}`)
    process.exit(1)
  }

  console.log(`[session-durability] exe=${args.exe}`)
  console.log(`[session-durability] out=${args.out}`)
  console.log(`[session-durability] port(기본)=${args.port}`)
  if (args.only) console.log(`[session-durability] --only ${args.only.join(',')}`)

  await cleanupStaleProcess(args.out)
  args.port = await preferFreePort(args.port, 'verify-session-durability-cdp.mjs')

  const probe = await startProbeServer()
  console.log(`[session-durability] 프로브 서버: http://127.0.0.1:${probe.port}`)

  const only = args.only ? new Set(args.only.map((s) => s.toUpperCase())) : null
  const toRun = only ? SCENARIOS.filter((s) => only.has(s.id)) : SCENARIOS
  if (only) {
    const unknown = [...only].filter((id) => !SCENARIOS.some((s) => s.id === id))
    if (unknown.length) console.warn(`[session-durability] 알 수 없는 --only id 무시: ${unknown.join(',')}`)
  }

  for (const s of toRun) {
    console.log(`\n===== ${s.id} =====`)
    try {
      await s.fn(args, probe)
    } catch (err) {
      // 시나리오 함수는 내부적으로 자체 try/catch 를 갖지만, 예상 밖 예외에 대한 최종 안전망.
      record(s.id, s.id, 'FAIL', `시나리오 실행 중 미처리 예외: ${err.stack ?? err}`)
    }
  }

  await probe.close().catch(() => {})
  killIfAlive(args.out)

  const result = {
    generatedAt: new Date().toISOString(),
    exe: args.exe,
    checks,
    summary: {
      pass: checks.filter((c) => c.status === 'PASS').length,
      fail: checks.filter((c) => c.status === 'FAIL').length,
      skip: checks.filter((c) => c.status === 'SKIP').length,
    },
  }
  fs.writeFileSync(path.join(args.out, 'results.json'), JSON.stringify(result, null, 2))

  console.log('\n===== verify-session-durability-cdp 결과 =====')
  console.table(checks.map((c) => ({ id: c.id, 이름: c.name, 상태: c.status })))
  console.log(`PASS=${result.summary.pass} FAIL=${result.summary.fail} SKIP=${result.summary.skip} (총 ${checks.length})`)

  console.log('\n===== 상세 근거(evidence) — 전체 detail 원문 =====')
  for (const c of checks) {
    console.log(`\n--- ${c.id} (${c.status}) — ${c.name} ---`)
    console.log(typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail, null, 2))
  }

  return result.summary.fail > 0 ? 1 : 0
}

main().then((code) => process.exit(code ?? 0)).catch((err) => {
  console.error('[session-durability] main() 실패:', err)
  process.exit(2)
})
