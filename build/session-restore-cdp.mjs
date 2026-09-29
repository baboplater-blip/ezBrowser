#!/usr/bin/env node
// session-restore-cdp.mjs — 게이트 3: 비정상 종료(강제 kill) 후 세션 복원 정확도 실증 하네스.
//
// smoke-cdp.mjs 의 패턴(의존성 0 CDP 클라이언트, PID 스코프 프로세스 관리, 격리 --user-data-dir)을
// 재사용해, "복잡한 상태를 만든다 → 강제 kill(진짜 비정상 종료) → 같은 프로필로 재기동 →
// 복원된 상태를 기대값과 대조" 2단계 시나리오를 자동 실행한다.
//
// 검증 항목: 탭 개수/URL, 탭 그룹(색·이름·멤버), 분할 화면(pane 구성), 스크롤 위치, 폼 값.
// app/main/features/session/index.ts 의 maybeRestoreSession 이 `startup.mode==='last-session'`
// 일 때 모달 없이 자동 복원하므로, 이 하네스는 프로필 시드에 그 모드를 강제한다.
//
// 사용: node build/session-restore-cdp.mjs [--exe <path>] [--out <dir>] [--port <n>]

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
  waitForPortFree,
  waitForShellTarget,
  waitForTargetByUrlPredicate,
} from './lib/cdp.mjs'
import { preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const DEFAULTS = {
  exe: path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe'),
  out: path.join(REPO_ROOT, 'verify-out', 'restore'),
  port: 9226,
}

function parseArgs(argv) {
  const out = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--exe') out.exe = path.resolve(argv[++i] ?? '')
    else if (a === '--out') out.out = path.resolve(argv[++i] ?? '')
    else if (a === '--port') out.port = Number(argv[++i] ?? DEFAULTS.port)
    else console.warn(`[session-restore] 알 수 없는 인자 무시: ${a}`)
  }
  return out
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

// ── 프로세스 관리 (PID 스코프만 — 이름 기반 종료 절대 금지) ────────────────

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
  if (res.error) console.warn('[session-restore] taskkill 오류(무시):', res.error.message)
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
  console.log(`[session-restore] 이전 실행의 잔존 프로세스(pid=${stale.pid}) 정리 시도…`)
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
    console.log(`[session-restore] [${tag}] app process exited (code=${code} signal=${signal})`)
  })
  writeProcFile(outDir, { pid: child.pid, port })
  return { child, stdoutPath, stderrPath }
}

/** 정상 종료 우선 시도 후 taskkill — phase2 마무리(정리)에만 사용. 비정상 종료 시뮬레이션에는 forceKill 사용. */
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

/** 진짜 비정상 종료 시뮬레이션: taskkill /PID /T /F 로만 트리 강제 종료 (graceful 경로 전혀 안 탐 — before-quit 훅 안 돎). */
async function forceKillAppTree(pid, outDir) {
  killPidTree(pid)
  const gone = await waitPidGone(pid, 5000)
  removeProcFile(outDir)
  return gone
}

// ── 격리 프로필 시드 ────────────────────────────────────────────────────
// startup.mode='last-session' 강제 — 비정상 종료 복원이 네이티브 확인 모달 없이 자동으로
// 일어나야 CDP 로 끝까지 검증 가능하다 (newtab 모드는 dialog.showMessageBox 로 부팅이 막힘).

function seedProfile(profileDir) {
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const settingsPath = path.join(profileDir, 'settings.json')
  const seed = {
    setup: { completed: true, completedAt: Date.now(), version: 'session-restore-cdp' },
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

// ── 로컬 프로브 HTTP 서버 (스크롤·폼 상태 확인용, 두 phase 동안 계속 살아있음) ──

function plainHtml(n) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Plain Tab ${n}</title></head>`
    + `<body><h1>Plain Tab ${n}</h1><p>probe-plain-${n}</p></body></html>`
}

const SCROLL_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Scroll Probe</title>
<style>
  html,body{margin:0;padding:0;}
  .spacer{height:9000px;background:linear-gradient(#eef,#fff);}
  .marker{position:absolute;top:4000px;left:20px;font:16px sans-serif;}
  form{position:fixed;top:0;left:0;background:#fff;padding:8px;border-bottom:1px solid #ccc;z-index:10;}
</style>
</head>
<body>
<form id="probe-form">
  <label>Probe: <input id="probe-input" name="probe" type="text" value=""></label>
</form>
<div class="spacer"></div>
<div class="marker">scroll marker @4000px</div>
<div class="spacer"></div>
</body>
</html>`

function startProbeServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      res.setHeader('Cache-Control', 'no-store')
      if (u.pathname === '/scroll') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(SCROLL_HTML)
        return
      }
      if (u.pathname === '/plain') {
        const n = u.searchParams.get('n') ?? '0'
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(plainHtml(n))
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
        scrollUrl: `http://127.0.0.1:${port}/scroll`,
        plainUrl: (n) => `http://127.0.0.1:${port}/plain?n=${n}`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

// ── CDP 클라이언트 (의존성 0) ────────────────────────────────────────────

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

// ── 시나리오 상태 ────────────────────────────────────────────────────────

const findings = []
function record(item, status, expected, actual, note) {
  findings.push({ item, status, expected, actual, note: note ?? '' })
  console.log(`  [${status}] ${item} — 기대: ${JSON.stringify(expected)} / 실제: ${JSON.stringify(actual)}${note ? ` (${note})` : ''}`)
}

async function waitTabLoaded(chromeSession, windowId, tabId, urlPrefix, timeoutMs = 15_000) {
  return pollUntil(async () => {
    const tabs = await callApi(chromeSession, 'tabs.list', [windowId])
    const t = tabs.find((x) => x.id === tabId)
    return (t && !t.loading && typeof t.url === 'string' && t.url.startsWith(urlPrefix)) ? t : null
  }, { timeoutMs, label: `탭(${tabId}) ${urlPrefix} 로드 완료` })
}

// ── PHASE 1: 복잡한 상태 셋업 + 기대값 캡처 + 강제 kill ───────────────────

async function phase1(args, probe) {
  console.log('\n===== PHASE 1: 상태 셋업 =====')
  // 고정 포트가 앞선 실행의 잔재에 물려 있으면 빈 포트로 대체한다(실행이 통째로 죽지 않게).
  args.port = await preferFreePort(args.port, 'session-restore-cdp.mjs')
  if (!(await waitForPortFree(args.port))) {
    // 좀비 인스턴스가 디버그 포트를 쥐고 있으면 /json/list 가 죽은 타깃을 돌려준다.
    // 남의(또는 시체의) 브라우저를 검사하느니 큰 소리로 실패한다.
    throw new Error(`디버그 포트 ${args.port} 가 이미 사용 중입니다 — 남은 인스턴스를 종료하거나 다른 포트를 지정하세요.`)
  }
  const { child } = launchApp(args.exe, args.out, args.port, args.profileDir, 'phase1')
  const openSessions = []
  let expected = null
  let appPid = child.pid

  try {
    const chromeSession = await connectShellSessionReady(args.port, {
      label: 'chrome-shell-p1',
      log: (msg) => console.log(`[session-restore-cdp] ${msg}`),
    })
    openSessions.push(chromeSession)
    const windowId = await evaluate(chromeSession, `new URL(location.href).searchParams.get('windowId')`)
    if (!windowId) throw new Error('외피 URL 에서 windowId 를 읽지 못함')
    console.log(`[phase1] windowId=${windowId}`)

    // 초기 탭(T0, browser://newtab 자동 생성) 대기
    const initial = await pollUntil(async () => {
      const tabs = await callApi(chromeSession, 'tabs.list', [windowId])
      return tabs.length >= 1 ? tabs : null
    }, { timeoutMs: 15_000, label: 'T0 초기 탭 생성' })
    const t0 = initial[0]
    console.log(`[phase1] T0=${t0.id} (${t0.url})`)

    // T0 → plain?n=0
    await callApi(chromeSession, 'tabs.navigate', [t0.id, probe.plainUrl(0)])
    await waitTabLoaded(chromeSession, windowId, t0.id, probe.plainUrl(0))

    // T1 = /scroll (foreground → active)
    const t1 = await callApi(chromeSession, 'tabs.create', [windowId, probe.scrollUrl])
    await waitTabLoaded(chromeSession, windowId, t1.id, probe.scrollUrl)
    console.log(`[phase1] T1(scroll)=${t1.id}`)

    // T2..T6 = /plain?n=2..6 (background)
    const bgTabs = {}
    for (const n of [2, 3, 4, 5, 6]) {
      const t = await callApi(chromeSession, 'tabs.create', [windowId, probe.plainUrl(n), { background: true }])
      await waitTabLoaded(chromeSession, windowId, t.id, probe.plainUrl(n))
      bgTabs[n] = t
      console.log(`[phase1] T${n}(plain)=${t.id}`)
    }

    // 탭 그룹: T2,T3,T4 → 'Group Alpha' (blue)
    const group = await callApi(chromeSession, 'groups.create', [windowId, {
      title: 'Group Alpha', color: 'blue', tabIds: [bgTabs[2].id, bgTabs[3].id, bgTabs[4].id],
    }])
    if (!group) throw new Error('groups.create 가 null 반환')
    console.log(`[phase1] group=${group.id} (${group.title}, ${group.color})`)

    // T1 활성 확실히 하기
    await callApi(chromeSession, 'tabs.activate', [t1.id])
    await sleep(200)

    // 분할 화면: layoutChanged 이벤트 수집기 설치 후 action.pane.split.h 실행
    await evaluate(chromeSession, `(function(){
      window.__restoreProbeLayoutEvents = [];
      window.browserAPI.windows.onLayoutChanged(function(p){ window.__restoreProbeLayoutEvents.push(p); });
      return true;
    })()`)
    await callApi(chromeSession, 'actions.run', ['action.pane.split.h', { windowId }])
    const layoutEvent = await pollUntil(async () => {
      const arr = await evaluate(chromeSession, `window.__restoreProbeLayoutEvents || []`)
      return (Array.isArray(arr) && arr.length > 0) ? arr[arr.length - 1] : null
    }, { timeoutMs: 8000, label: '분할 layoutChanged 이벤트' })
    console.log(`[phase1] split layout event: ${JSON.stringify(layoutEvent)}`)
    if (!layoutEvent.split || layoutEvent.panes.length < 2) throw new Error(`분할이 적용되지 않음: ${JSON.stringify(layoutEvent)}`)
    const pane0TabId = layoutEvent.panes[0]?.tabId
    const pane1TabId = layoutEvent.panes[1]?.tabId
    if (pane0TabId !== t1.id) console.warn(`[phase1] 예상과 다른 pane0 tabId: 기대 ${t1.id}, 실제 ${pane0TabId}`)

    // 스크롤 위치 설정 + 확인
    const scrollTarget = await waitForTargetByUrlPredicate(args.port, (u) => u.startsWith(probe.scrollUrl), 'scroll CDP 타깃')
    const scrollSession = await connectSession(scrollTarget, 'content:scroll-p1')
    openSessions.push(scrollSession)
    await evaluate(scrollSession, `window.scrollTo(0, 4000)`)
    await sleep(200)
    const expectedScrollY = await evaluate(scrollSession, `window.scrollY`)
    console.log(`[phase1] scrollY set → ${expectedScrollY}`)

    // 폼 입력 설정 + 확인
    const expectedInputValue = await evaluate(scrollSession, `(function(){
      var el = document.querySelector('#probe-input');
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, 'SESSION_RESTORE_PROBE_1234');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`)
    console.log(`[phase1] input value set → ${expectedInputValue}`)

    // 스크롤/폼 변경이 Chromium 내부 히스토리 상태에 반영될 시간
    const interactionAt = Date.now()
    await sleep(2000)

    // 트리거 탭(T7) — tabEvents 'list' 를 발생시켜 scheduleSaveSoon(1s 디바운스) 유발.
    // 이 시점 이후 buildSnapshot() 이 실행되면 방금 설정한 scroll/form 의 "라이브" 상태를 캡처한다.
    const t7 = await callApi(chromeSession, 'tabs.create', [windowId, probe.plainUrl(7), { background: true }])
    await waitTabLoaded(chromeSession, windowId, t7.id, probe.plainUrl(7))
    console.log(`[phase1] T7(trigger)=${t7.id}`)

    // sessions/current.json 이 T7 생성 이후(즉 scroll/form 설정 이후)의 상태로 flush 됐는지
    // 파일을 직접 폴링해 확인 — 디바운스 타이밍을 추측하지 않고 결정적으로 기다린다.
    //
    // ⚠ 2026-09-20: 조건에 **savedAt 하한**을 넣었다. 예전에는 "탭 목록에 T7 과 scroll 이 있는가" 만
    //   봤는데, 그건 제품이 **언제** 그 스냅샷을 떴는지를 전혀 제약하지 못한다.
    //   스크롤 위치·폼 값은 메인 프로세스에 이벤트를 내지 않고, Chromium 이 그 값을
    //   내비게이션 항목(pageState)에 반영하는 데도 몇 초가 걸린다. 그래서 탭 목록만 맞는
    //   **이른 스냅샷**은 pageState 가 아직 낡아 있다(실측: 상호작용 +3초 스냅샷은 scrollY=0,
    //   +7초 스냅샷은 scrollY=4000 — 같은 빌드에서).
    //   예전에는 저장이 활동 5초 뒤 **한 번만** 일어나 이 조건이 우연히 충족됐을 뿐이고,
    //   저장이 더 자주 일어나게 되자 그 우연이 깨졌다. 이제 의도를 조건에 직접 적는다:
    //   **상호작용이 가라앉은 뒤에 떠진 스냅샷**을 기다린다.
    const SETTLE_MS = 7000 // 제품의 정착 저장(활동 후 5초) + 여유
    const curPath = currentSessionPath(args.profileDir)
    const flushed = await pollUntil(() => {
      const snap = readJsonSafe(curPath)
      if (!snap || !Array.isArray(snap.windows)) return null
      if (!(typeof snap.savedAt === 'number' && snap.savedAt >= interactionAt + SETTLE_MS)) return null
      const win = snap.windows.find((w) => w.windowId === windowId)
      if (!win) return null
      const hasT7 = win.tabs.some((t) => t.url === probe.plainUrl(7))
      const hasScroll = win.tabs.some((t) => t.url === probe.scrollUrl)
      return (hasT7 && hasScroll) ? snap : null
    }, { timeoutMs: 40_000, intervalMs: 500, label: 'sessions/current.json 에 정착 후 스냅샷(T7+scroll) flush' })
    const flushedWin = flushed.windows.find((w) => w.windowId === windowId)
    const flushedScrollTab = flushedWin.tabs.find((t) => t.url === probe.scrollUrl)
    const pageStateLen = flushedScrollTab?.history?.find((h) => h.url === probe.scrollUrl)?.pageState?.length ?? 0
    console.log(`[session-restore] current.json flush 확인 — scroll 탭 history pageState 길이=${pageStateLen}`)
    console.log('[phase1] DIAG flushed tabs:', JSON.stringify(flushedWin.tabs.map((t) => ({
      url: t.url, index: t.index, active: t.active, historyLen: t.history?.length ?? 0, historyIndex: t.historyIndex,
    })), null, 2))

    // 추가 안전 버퍼
    await sleep(3000)

    // 최종 기대값 캡처
    const tabsExpected = await callApi(chromeSession, 'tabs.list', [windowId])
    const groupsExpected = await callApi(chromeSession, 'groups.list', [windowId])

    const idToUrl = new Map(tabsExpected.map((t) => [t.id, t.url]))
    expected = {
      tabCount: tabsExpected.length,
      urls: tabsExpected.map((t) => t.url).sort(),
      activeUrl: tabsExpected.find((t) => t.active)?.url ?? null,
      group: {
        id: group.id, title: group.title, color: group.color,
        memberUrls: tabsExpected.filter((t) => t.groupId === group.id).map((t) => t.url).sort(),
      },
      // ⚠ pane 의 탭은 **스냅샷에서** 읽는다 — 복원이 실제로 쓰는 바로 그 값이다.
      //
      // 2026-09-15 수정: 예전에는 분할 직후의 `layoutChanged` 이벤트(pane0TabId)를 그대로 기대값으로
      // 썼다. 그런데 그 뒤 T7 을 **전면(foreground)으로** 만들면 `createTab` 이 활성 pane 의 탭을
      // 교체한다(설계된 동작). 즉 kill 시점의 pane0 은 /scroll 이 아니라 plain?n=7 인데, 기대값만
      // 옛날 그대로여서 "pane0 콘텐츠 타깃 없음" 으로 **제품과 무관하게** 실패했다.
      // (같은 실패가 Electron 35.7.5·42.11.3 양쪽에서 동일하게 재현돼 엔진 무관임을 확인했다.)
      split: (() => {
        const snapLayout = (flushedWin.layouts ?? [])[0] ?? null
        const idxToUrl = new Map((flushedWin.tabs ?? []).map((t) => [t.index, t.url]))
        const paneUrl = (i) => {
          const ti = snapLayout?.panes?.[i]?.tabIndex
          return (typeof ti === 'number' ? idxToUrl.get(ti) : null) ?? null
        }
        const s = {
          split: snapLayout?.split ?? layoutEvent.split,
          splitRatio: snapLayout?.splitRatio ?? layoutEvent.splitRatio,
          activePaneIdx: snapLayout?.activePaneIdx ?? layoutEvent.activePaneIdx,
          pane0Url: paneUrl(0), pane1Url: paneUrl(1),
        }
        console.log(`[phase1] 스냅샷 layout 에서 읽은 pane: ${JSON.stringify(s)}`
          + ` (분할 직후 이벤트의 pane0=${idToUrl.get(pane0TabId) ?? '(모름)'},`
          + ` pane1=${idToUrl.get(pane1TabId) ?? '(모름)'} — 이후 전면 탭 생성으로 바뀔 수 있다)`)
        return s
      })(),
      scrollUrl: probe.scrollUrl,
      scrollY: expectedScrollY,
      inputValue: expectedInputValue,
      pageStateCapturedLen: pageStateLen,
    }
    console.log('[phase1] 기대값:', JSON.stringify(expected, null, 2))
  } finally {
    for (const s of openSessions) s.close()
  }

  // ── 강제 kill: taskkill /PID /T /F 만 사용, graceful 경로(Browser.close/before-quit) 전혀 안 탐 ──
  console.log(`[phase1] 강제 kill: taskkill /PID ${appPid} /T /F`)
  const beforeLastStable = fs.existsSync(lastStableSessionPath(args.profileDir))
  const gone = await forceKillAppTree(appPid, args.out)
  console.log(`[phase1] 프로세스 소멸 확인: ${gone ? 'OK' : 'FAIL(아직 살아있음)'}`)
  const afterLastStable = fs.existsSync(lastStableSessionPath(args.profileDir))
  const currentExistsAfterKill = fs.existsSync(currentSessionPath(args.profileDir))

  return {
    expected,
    pidKilledCleanly: gone,
    lastStableExistedBeforeKill: beforeLastStable,
    lastStableExistsAfterKill: afterLastStable, // true 면 graceful 경로가 어딘가에서 탔다는 뜻(예상 밖)
    currentExistsAfterKill, // true 여야 정상 — 이게 다음 부팅의 복원 소스
  }
}

// ── PHASE 2: 재기동 + 복원 검증 ──────────────────────────────────────────

async function phase2(args, probe, setup) {
  console.log('\n===== PHASE 2: 재기동 + 복원 검증 =====')
  await sleep(1000) // 강제 kill 직후 파일 핸들 해제 버퍼
  if (!(await waitForPortFree(args.port))) {
    // 좀비 인스턴스가 디버그 포트를 쥐고 있으면 /json/list 가 죽은 타깃을 돌려준다.
    // 남의(또는 시체의) 브라우저를 검사하느니 큰 소리로 실패한다.
    throw new Error(`디버그 포트 ${args.port} 가 이미 사용 중입니다 — 남은 인스턴스를 종료하거나 다른 포트를 지정하세요.`)
  }
  const { child } = launchApp(args.exe, args.out, args.port, args.profileDir, 'phase2')
  const openSessions = []
  let recoveryAfterRestore = null

  try {
    const chromeSession = await connectShellSessionReady(args.port, {
      label: 'chrome-shell-p2',
      log: (msg) => console.log(`[session-restore-cdp] ${msg}`),
    })
    openSessions.push(chromeSession)
    const windowId = await evaluate(chromeSession, `new URL(location.href).searchParams.get('windowId')`)
    if (!windowId) throw new Error('복원 후 외피 URL 에서 windowId 를 읽지 못함')
    console.log(`[phase2] windowId=${windowId}`)

    const expected = setup.expected

    // did-fail-load / preload-error 조기 수집을 위해 잠시 대기 후 stdout 로그 스캔
    await sleep(3000)

    // 탭 개수 도달 대기
    let tabsActual = []
    try {
      tabsActual = await pollUntil(async () => {
        const tabs = await callApi(chromeSession, 'tabs.list', [windowId])
        return tabs.length >= expected.tabCount ? tabs : null
      }, { timeoutMs: 25_000, label: `복원 탭 ${expected.tabCount}개 도달` })
    } catch (err) {
      tabsActual = await callApi(chromeSession, 'tabs.list', [windowId]).catch(() => [])
      record('탭 개수', 'FAIL', expected.tabCount, tabsActual.length, err.message)
    }

    // 복원이 끝난 **바로 그 순간** 디스크에 복구 자료가 남아 있는지 본다.
    // 2026-09-20 이전에는 maybeRestoreSession 이 복원 직후 current.json 을 지웠고,
    // 그래서 "복원 직후 다시 크래시" 구간에는 디스크에 복구 자료가 하나도 없었다(세션 통째 손실).
    // ⚠ 이 측정은 반드시 정상 종료 **전에** 해야 한다 — 종료 후에 보면 before-quit 이 지운 뒤라
    //   무엇을 확인하든 항상 "없음" 이 나온다(예전 판정이 실제로 그랬다).
    recoveryAfterRestore = readJsonSafe(currentSessionPath(args.profileDir))

    if (tabsActual.length > 0) {
      console.log('[phase2] DIAG tabsActual:', JSON.stringify(tabsActual.map((t) => ({
        id: t.id, url: t.url, title: t.title, discarded: t.discarded, index: t.index, active: t.active,
      })), null, 2))
      record('탭 개수', tabsActual.length === expected.tabCount ? 'PASS' : 'FAIL', expected.tabCount, tabsActual.length)
      const actualUrls = tabsActual.map((t) => t.url).sort()
      const urlsMatch = JSON.stringify(actualUrls) === JSON.stringify(expected.urls)
      record('탭 URL 집합', urlsMatch ? 'PASS' : 'FAIL', expected.urls, actualUrls)

      const activeTab = tabsActual.find((t) => t.active)
      record('활성 탭 URL', activeTab?.url === expected.activeUrl ? 'PASS' : 'FAIL', expected.activeUrl, activeTab?.url ?? null)
    }

    // 탭 그룹 검증
    const groupsActual = await callApi(chromeSession, 'groups.list', [windowId]).catch(() => [])
    const g = groupsActual.find((x) => x.id === expected.group.id) ?? groupsActual.find((x) => x.title === expected.group.title)
    if (!g) {
      record('탭 그룹 존재', 'FAIL', expected.group.title, groupsActual.map((x) => x.title), '복원된 groups.list 에서 못 찾음')
    } else {
      record('탭 그룹 id 보존', g.id === expected.group.id ? 'PASS' : 'FAIL', expected.group.id, g.id)
      record('탭 그룹 색상', g.color === expected.group.color ? 'PASS' : 'FAIL', expected.group.color, g.color)
      const memberUrls = tabsActual.filter((t) => t.groupId === g.id).map((t) => t.url).sort()
      record('탭 그룹 멤버', JSON.stringify(memberUrls) === JSON.stringify(expected.group.memberUrls) ? 'PASS' : 'FAIL', expected.group.memberUrls, memberUrls)
    }

    // 분할 화면 검증 — (a) 백엔드 geometry, (b) 외피 DOM 반영
    const domSplit = await evaluate(chromeSession, `!!document.querySelector('.tab-stage-split')`).catch(() => false)
    const paneCount = await evaluate(chromeSession, `document.querySelectorAll('.pane').length`).catch(() => 0)
    record('분할 화면 — 외피 DOM(.tab-stage-split)', domSplit && paneCount === 2 ? 'PASS' : 'FAIL', 'split DOM + pane 2개', { domSplit, paneCount })

    if (expected.split.pane0Url && expected.split.pane1Url) {
      try {
        const containerWidth = await evaluate(chromeSession, `(function(){
          var el = document.querySelector('.tab-stage-split') || document.querySelector('.tab-stage');
          return el ? el.getBoundingClientRect().width : null;
        })()`)
        const t0 = await waitForTargetByUrlPredicate(args.port, (u) => u.startsWith(expected.split.pane0Url), 'pane0 콘텐츠 타깃', 15000)
        const t1 = await waitForTargetByUrlPredicate(args.port, (u) => u.startsWith(expected.split.pane1Url), 'pane1 콘텐츠 타깃', 15000)
        const s0 = await connectSession(t0, 'content:pane0-p2'); openSessions.push(s0)
        const s1 = await connectSession(t1, 'content:pane1-p2'); openSessions.push(s1)
        const w0 = await evaluate(s0, `window.innerWidth`)
        const w1 = await evaluate(s1, `window.innerWidth`)
        const halfish = containerWidth ? containerWidth * 0.7 : 900
        const geomSplit = w0 < halfish && w1 < halfish
        record('분할 화면 — 콘텐츠뷰 geometry(반씩 나뉨)', geomSplit ? 'PASS' : 'FAIL',
          `각 pane width < ${halfish.toFixed(0)}px (container=${containerWidth})`, { pane0Width: w0, pane1Width: w1 })
      } catch (err) {
        record('분할 화면 — 콘텐츠뷰 geometry', 'FAIL', 'pane0/pane1 콘텐츠 타깃 발견', null, err.message)
      }
    } else {
      record('분할 화면 — 콘텐츠뷰 geometry', 'SKIP', '-', '-', 'phase1 에서 pane tabId→url 매핑 실패')
    }

    // 스크롤 위치 검증
    //
    // 2026-09-15 수정: 복원은 **활성 탭 + 핀 + 마지막 5개**만 즉시 로드하고 나머지는 잠재운다
    // (가벼움 예산). 이 시나리오의 /scroll 탭은 index 1 이라 잠든 채로 복원되며 — 잠든 탭은
    // about:blank 이므로 CDP 에 그 URL 의 타깃이 **아예 없다**. 예전 코드는 그 타깃을 20초 기다리다
    // 타임아웃으로 실패했다(제품이 아니라 검사의 문제 — 엔진 35·42 양쪽에서 동일 재현).
    //
    // 사용자가 그 탭을 실제로 보는 유일한 경로는 **깨우는 것**이다. 그래서 깨운 뒤에 잰다.
    // 이건 기준 완화가 아니다 — 깨웠는데 스크롤·폼이 안 돌아오면 그대로 FAIL 이고,
    // 오히려 잠든 탭의 내비게이션 히스토리 재생(undiscardTab)까지 함께 검증된다.
    try {
      const sleeping = tabsActual.find((t) => t.url === expected.scrollUrl && t.discarded)
      if (sleeping) {
        console.log(`[phase2] /scroll 탭이 잠들어 있음(index=${sleeping.index}) → 활성화해서 깨운다`)
        await callApi(chromeSession, 'tabs.activate', [sleeping.id])
      }
      const scrollTarget = await waitForTargetByUrlPredicate(args.port, (u) => u.startsWith(expected.scrollUrl), 'scroll 콘텐츠 타깃(복원)', 20000)
      const scrollSession = await connectSession(scrollTarget, 'content:scroll-p2')
      openSessions.push(scrollSession)
      await pollUntil(() => evaluate(scrollSession, `document.readyState === 'complete'`), { timeoutMs: 10000, label: 'scroll 탭 로드 완료' })
      await sleep(500)
      const actualScrollY = await evaluate(scrollSession, `window.scrollY`)
      const scrollOk = typeof actualScrollY === 'number' && Math.abs(actualScrollY - expected.scrollY) <= 100
      record('스크롤 위치 복원', scrollOk ? 'PASS' : 'FAIL', expected.scrollY, actualScrollY)

      const actualInputValue = await evaluate(scrollSession, `document.querySelector('#probe-input')?.value ?? null`)
      record('폼 입력값 복원', actualInputValue === expected.inputValue ? 'PASS' : 'FAIL', expected.inputValue, actualInputValue)
    } catch (err) {
      record('스크롤 위치 복원', 'FAIL', expected.scrollY, null, err.message)
      record('폼 입력값 복원', 'FAIL', expected.inputValue, null, err.message)
    }

    // 흰 화면 / did-fail-load 점검
    const shellHtmlLen = await evaluate(chromeSession, `document.body ? document.body.innerHTML.length : 0`).catch(() => 0)
    record('외피 흰 화면 아님', shellHtmlLen > 200 ? 'PASS' : 'FAIL', '> 200 chars', shellHtmlLen)

    return { windowId, tabsActual, groupsActual, recoveryAfterRestore }
  } finally {
    for (const s of openSessions) s.close()
    await gracefulThenForceKill(child, args.port, args.out)
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────────

async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('[session-restore] Node 22+ 필요(전역 WebSocket 없음).')
    process.exit(2)
  }
  const args = parseArgs(process.argv.slice(2))
  args.profileDir = path.join(args.out, 'profile')
  fs.mkdirSync(args.out, { recursive: true })

  if (!fs.existsSync(args.exe)) {
    console.error(`[session-restore] exe 를 찾을 수 없음: ${args.exe}`)
    process.exit(1)
  }

  console.log(`[session-restore] exe=${args.exe}`)
  console.log(`[session-restore] out=${args.out}`)
  console.log(`[session-restore] port=${args.port}`)
  console.log(`[session-restore] profile=${args.profileDir} (매 실행 초기화)`)

  await cleanupStaleProcess(args.out)
  seedProfile(args.profileDir)

  const probe = await startProbeServer()
  console.log(`[session-restore] 프로브 서버 시작: http://127.0.0.1:${probe.port}`)

  let exitCode = 0
  let setup = null
  let logScan = { failLoad: [], preloadError: [] }
  try {
    setup = await phase1(args, probe)
    if (!setup.expected) throw new Error('phase1 이 기대값을 만들지 못함(예외 발생) — phase2 스킵')

    record('강제 kill 후 프로세스 소멸', setup.pidKilledCleanly ? 'PASS' : 'FAIL', true, setup.pidKilledCleanly)
    record('비정상 종료 경로(kill 후 last-stable.json 미생성)', !setup.lastStableExistsAfterKill ? 'PASS' : 'FAIL',
      false, setup.lastStableExistsAfterKill, 'true 면 graceful(before-quit) 경로가 어딘가에서 실행됐다는 뜻 — 강제 kill 이 진짜 크래시가 아니었을 가능성')
    record('current.json 존재(kill 직후, 다음 부팅의 복원 소스)', setup.currentExistsAfterKill ? 'PASS' : 'FAIL', true, setup.currentExistsAfterKill)

    const p2 = await phase2(args, probe, setup)

    // 복원 직후(정상 종료 전)에 디스크에 복구 자료가 남아 있어야 한다 — 그 자리에서 다시 크래시해도
    // 같은 세션을 한 번 더 복원할 수 있어야 하기 때문이다.
    // "파일이 있다" 만 보면 빈 파일로도 통과하므로 **복원한 탭 URL 을 실제로 담고 있는지**까지 본다.
    const rec = p2?.recoveryAfterRestore ?? null
    const recUrls = rec && Array.isArray(rec.windows)
      ? rec.windows.flatMap((w) => (w.tabs ?? []).map((t) => t.url))
      : []
    const missing = (setup.expected?.urls ?? []).filter((u) => !recUrls.includes(u))
    record('복원 직후 복구 자료가 디스크에 남아 있다(재크래시 대비)',
      rec && missing.length === 0 ? 'PASS' : 'FAIL',
      `${(setup.expected?.urls ?? []).length}개 URL 전부`,
      rec ? `${recUrls.length}개 (빠진 것: ${missing.length})` : 'current.json 없음',
      missing.slice(0, 3).join(' | '))

    // 정상 종료(before-quit)가 끝난 뒤에는 current.json 이 정리돼 있어야 한다 —
    // 다음 부팅이 "지난 세션 복원" 을 다시 묻지 않는 근거.
    const currentAfterQuit = fs.existsSync(currentSessionPath(args.profileDir))
    const lastStableAfterQuit = fs.existsSync(lastStableSessionPath(args.profileDir))
    record('정상 종료 후 current.json 정리 + last-stable 기록',
      (!currentAfterQuit && lastStableAfterQuit) ? 'PASS' : 'FAIL',
      'current 없음 + last-stable 있음',
      `current=${currentAfterQuit} last-stable=${lastStableAfterQuit}`)

    // stdout 로그 스캔 (did-fail-load / preload-error)
    for (const tag of ['phase1', 'phase2']) {
      const p = path.join(args.out, `app-stdout-${tag}.log`)
      if (!fs.existsSync(p)) continue
      const text = fs.readFileSync(p, 'utf8')
      const failLines = text.split('\n').filter((l) => l.includes('did-fail-load') && !l.includes('code=-3'))
      const preloadLines = text.split('\n').filter((l) => l.toLowerCase().includes('preload-error') || l.toLowerCase().includes('preload error'))
      if (failLines.length) logScan.failLoad.push(...failLines.map((l) => `[${tag}] ${l}`))
      if (preloadLines.length) logScan.preloadError.push(...preloadLines.map((l) => `[${tag}] ${l}`))
    }
    record('did-fail-load 없음(사용자 취소 -3 제외)', logScan.failLoad.length === 0 ? 'PASS' : 'FAIL', 0, logScan.failLoad.length, logScan.failLoad.slice(0, 5).join(' | '))
    record('preload-error 없음', logScan.preloadError.length === 0 ? 'PASS' : 'FAIL', 0, logScan.preloadError.length, logScan.preloadError.slice(0, 5).join(' | '))
  } catch (err) {
    console.error('[session-restore] 치명적 오류:', err)
    record('하네스 실행', 'FAIL', 'no exception', String(err?.stack ?? err))
    exitCode = 2
  } finally {
    await probe.close().catch(() => {})
    // 최종 안전망: 이 하네스가 띄운 프로세스가 아직 남아있다면 정리
    const stale = readProcFile(args.out)
    if (stale && isPidAlive(stale.pid)) {
      console.log(`[session-restore] 최종 정리: pid=${stale.pid}`)
      killPidTree(stale.pid)
      removeProcFile(args.out)
    }
  }

  fs.writeFileSync(path.join(args.out, 'restore-results.json'), JSON.stringify({
    findings,
    expected: setup?.expected ?? null,
    logScan,
  }, null, 2))

  console.log('\n===== session-restore-cdp 결과 =====')
  console.table(findings.map((f) => ({ 항목: f.item, 상태: f.status, 비고: f.note })))
  const fail = findings.filter((f) => f.status === 'FAIL').length
  const pass = findings.filter((f) => f.status === 'PASS').length
  console.log(`PASS=${pass} FAIL=${fail} (총 ${findings.length})`)

  return exitCode || (fail > 0 ? 1 : 0)
}

main().then((code) => process.exit(code ?? 0)).catch((err) => {
  console.error('[session-restore] main() 실패:', err)
  process.exit(2)
})
