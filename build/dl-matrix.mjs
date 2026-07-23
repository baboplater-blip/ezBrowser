#!/usr/bin/env node
// dl-matrix.mjs — /audit-download (게이트 5) 다운로드 다사이트 매트릭스 검증 워커.
// CDP 로 packaged ezBrowser 를 구동해 11개 다운로드 시나리오를 실제로 완주시키고,
// 디스크에 받아진 파일의 바이트를 원본과 정확히 비교한다.
//
// 병렬 제약: 다른 워커가 다른 프로필·포트로 동시 실행 중이므로 이 스크립트는 자신의
// PID(및 자식 프로세스 트리)만 종료한다(이름 기반 taskkill 사용 안 함) — smoke-cdp.mjs 와 동일 패턴.
//
// 사용:
//   node build/dl-matrix.mjs [--exe <path>] [--out <dir>] [--port <n>]

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { startDlMatrixServer } from './dl-matrix-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const DEFAULTS = {
  exe: path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe'),
  out: 'C:\\Users\\molma\\AppData\\Local\\Temp\\claude\\c--Users-molma-Desktop-----browser-build\\9385582e-821e-4490-88cc-bb0c7fda225a\\scratchpad\\dl-matrix',
  port: 9233,
}

function parseArgs(argv) {
  const out = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--exe') out.exe = path.resolve(argv[++i] ?? '')
    else if (a === '--out') out.out = path.resolve(argv[++i] ?? '')
    else if (a === '--port') out.port = Number(argv[++i] ?? DEFAULTS.port)
    else console.warn(`[dl-matrix] 알 수 없는 인자 무시: ${a}`)
  }
  out.profileDir = path.join(out.out, 'profile')
  return out
}

// ── 공통 유틸 (smoke-cdp.mjs 와 동일 패턴 — import 시 부작용 있는 모듈이라 복제) ──

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

// ── 프로세스 관리 (PID 스코프) ──

function procFilePath(outDir) { return path.join(outDir, 'app-proc.json') }

function readProcFile(outDir) {
  try {
    const raw = fs.readFileSync(procFilePath(outDir), 'utf8')
    const parsed = JSON.parse(raw)
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
  if (res.error) console.warn('[dl-matrix] taskkill 실행 오류(무시):', res.error.message)
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
  console.log(`[dl-matrix] 이전 실행이 남긴 프로세스 발견 (pid=${stale.pid}, port=${stale.port}) — 정리 시도…`)
  if (isPidAlive(stale.pid)) {
    const graceful = await tryGracefulShutdown(stale.port)
    if (graceful) await sleep(1500)
    if (isPidAlive(stale.pid)) killPidTree(stale.pid)
  }
  removeProcFile(outDir)
}

function launchApp(exePath, outDir, port, profileDir, logSuffix = '') {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const stdoutPath = path.join(outDir, `app-stdout${logSuffix}.log`)
  const stderrPath = path.join(outDir, `app-stderr${logSuffix}.log`)
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
    console.log(`[dl-matrix] app process exited (code=${code} signal=${signal})`)
  })
  writeProcFile(outDir, { pid: child.pid, port })
  return { child, stdoutPath, stderrPath }
}

async function killApp(child, port, outDir) {
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

/** 강제 종료(taskkill) — 정상 종료 시도 없이 즉시 죽인다. 재시작 이어받기(S11) 크래시 시뮬레이션용. */
function forceKillApp(child, outDir) {
  if (child && child.pid) killPidTree(child.pid)
  removeProcFile(outDir)
}

function seedProfile(profileDir) {
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const settingsPath = path.join(profileDir, 'settings.json')
  const seed = {
    setup: { completed: true, completedAt: Date.now(), version: 'dl-matrix' },
    startup: { mode: 'newtab', urls: [] },
    downloads: { accelerator: true },
  }
  fs.writeFileSync(settingsPath, JSON.stringify(seed, null, 2))
}

// ── CDP 클라이언트 ──

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
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error(`CDP session not open (${this.label}) — method=${method}`))
    }
    const id = (this._id += 1)
    const p = new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }) })
    this.ws.send(JSON.stringify({ id, method, params }))
    return withTimeout(p, timeoutMs, `CDP ${method} (${this.label})`)
  }

  close() { try { this.ws?.close() } catch { /* ignore */ } }
}

async function connectSession(target, label) {
  const session = new CDPSession(target.webSocketDebuggerUrl, label ?? target.id)
  await session.connect()
  return session
}

async function evaluate(session, expression, opts = {}) {
  const { awaitPromise = true, returnByValue = true, timeoutMs = 20_000 } = opts
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

async function connectShell(port) {
  const shellTarget = await waitForShellTarget(port, 30_000)
  const chromeSession = await connectSession(shellTarget, 'chrome-shell')
  const windowId = await evaluate(chromeSession, `new URL(location.href).searchParams.get('windowId')`)
  if (!windowId) throw new Error('외피 URL 에서 windowId 를 읽지 못함')
  return { chromeSession, windowId }
}

// ── 다운로드 폴더 헬퍼 (실사용자 %USERPROFILE%\Downloads 를 그대로 사용 — 정리 필수) ──

function downloadsDir() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return path.join(home, 'Downloads')
}

function safeUnlink(p) {
  if (!p) return
  try { fs.unlinkSync(p) } catch { /* 이미 없거나 정리 실패 — 무시 */ }
}

/** savePath 의 임시 세그먼트(.part0..N) 잔재까지 정리(best-effort). */
function cleanupAccelParts(savePath) {
  try {
    const dir = path.dirname(savePath)
    const base = path.basename(savePath)
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${base}.part`)) safeUnlink(path.join(dir, f))
    }
  } catch { /* ignore */ }
}

// ── 결과 수집 ──

const results = []

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
    results.push({ id, name, status: 'FAIL', detail: err.message, ms })
    console.log(`  ✗ FAIL (${ms}ms) ${err.message}`)
  }
}

function skipScenario(id, name, reason) {
  results.push({ id, name, status: 'SKIP', detail: reason, ms: 0 })
  console.log(`\n[${id}] ${name} — SKIP (${reason})`)
}

// ── 공용: 후보 감지 + video.download 로 받아 바이트 검증 ──

async function waitTabLoaded(ctx, tabId, timeoutMs = 10_000, label = '페이지 로드') {
  return pollUntil(async () => {
    const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
    const t = tabs.find((x) => x.id === tabId)
    return t && !t.loading ? t : null
  }, { timeoutMs, label })
}

async function waitCandidate(ctx, tabId, matchSubstr, timeoutMs = 10_000, label = '후보 감지') {
  return pollUntil(async () => {
    const list = await callApi(ctx.chromeSession, 'video.candidates', [tabId])
    return list.find((c) => c.url.includes(matchSubstr)) ?? null
  }, { timeoutMs, label })
}

async function waitDownloadDone(ctx, matchUrl, beforeIds, timeoutMs = 40_000, label = '다운로드 완료 대기') {
  return pollUntil(async () => {
    const list = await callApi(ctx.chromeSession, 'downloads.list', [])
    const found = list.find((d) => !beforeIds.has(d.id) && d.url === matchUrl)
    if (found && (found.state === 'done' || found.state === 'failed' || found.state === 'cancelled')) return found
    return null
  }, { timeoutMs, label })
}

async function candidateDownloadAndVerify(ctx, {
  label, htmlUrl, matchSubstr, expectedKind, expectedBuf, downloadTimeoutMs = 40_000,
}) {
  const tab = await callApi(ctx.chromeSession, 'tabs.create', [ctx.windowId, htmlUrl])
  try {
    await waitTabLoaded(ctx, tab.id, 10_000, `${label} 페이지 로드`)
    const candidate = await waitCandidate(ctx, tab.id, matchSubstr, 15_000, `${label} 후보 감지`)
    if (expectedKind && candidate.kind !== expectedKind) {
      throw new Error(`후보 kind 불일치: got=${candidate.kind} expected=${expectedKind} (url=${candidate.url})`)
    }

    const beforeDl = await callApi(ctx.chromeSession, 'downloads.list', [])
    const beforeIds = new Set(beforeDl.map((d) => d.id))

    const res = await callApi(ctx.chromeSession, 'video.download', [candidate])
    if (!res || res.ok !== true) throw new Error(`video.download 호출 실패: ${JSON.stringify(res)}`)
    if (res.kind === 'ytdlp') {
      throw new Error(`video.download 이 yt-dlp 경로로 라우팅됨(kind=${res.kind}) — 네이티브 다운로더 기대와 불일치`)
    }

    let entry
    try {
      entry = await waitDownloadDone(ctx, candidate.url, beforeIds, downloadTimeoutMs, `${label} 다운로드 완료 대기`)
    } catch (err) {
      const snapshot = await callApi(ctx.chromeSession, 'downloads.list', []).catch(() => [])
      const stuck = Array.isArray(snapshot) ? snapshot.find((d) => !beforeIds.has(d.id) && d.url === candidate.url) : null
      if (stuck) {
        await callApi(ctx.chromeSession, 'downloads.cancel', [stuck.id]).catch(() => {})
        cleanupAccelParts(stuck.savePath)
        safeUnlink(stuck.savePath)
      }
      throw new Error(`${err.message} — downloads.list 스냅샷: ${JSON.stringify(snapshot)}`)
    }

    if (entry.state !== 'done') {
      cleanupAccelParts(entry.savePath)
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
      safeUnlink(entry.savePath)
      cleanupAccelParts(entry.savePath)
    }

    if (!match) {
      throw new Error(`${label} — 파일 내용 불일치(${sizeInfo}) savePath=${entry.savePath} kind=${res.kind} candidate.kind=${candidate.kind}`)
    }

    const accel = entry.accelerator?.connections
    return `후보 kind=${candidate.kind} → video.download(kind=${res.kind}) → 완료(${sizeInfo}, 바이트 정확히 일치)`
      + `${accel ? `, 가속 ${accel}커넥션` : ''}, savePath=${path.basename(entry.savePath)}`
  } finally {
    await callApi(ctx.chromeSession, 'tabs.close', [tab.id]).catch(() => {})
  }
}

// ── S1: progressive mp4 (native will-download) ──

async function scenarioProgressive(ctx) {
  const server = ctx.state.server
  const url = server.urls.progressive
  const expectedBuf = server.expected.progressive

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
    }, { timeoutMs: 30_000, label: 'progressive mp4 다운로드 완료 대기' })
  } finally {
    await callApi(ctx.chromeSession, 'tabs.close', [tab.id]).catch(() => {})
  }

  if (entry.state !== 'done') {
    cleanupAccelParts(entry.savePath)
    throw new Error(`실패 — state=${entry.state} error=${entry.error ?? '(none)'} savePath=${entry.savePath}`)
  }

  let match = false
  let sizeInfo = ''
  try {
    const buf = fs.readFileSync(entry.savePath)
    sizeInfo = `${buf.length}/${expectedBuf.length} bytes`
    match = buf.length === expectedBuf.length && buf.equals(expectedBuf)
  } finally {
    safeUnlink(entry.savePath)
    cleanupAccelParts(entry.savePath)
  }
  if (!match) throw new Error(`파일 불일치(${sizeInfo}) savePath=${entry.savePath}`)
  const accel = entry.accelerator?.connections
  return `native will-download → 완료(${sizeInfo}, 바이트 정확히 일치)${accel ? `, 가속 ${accel}커넥션` : ', 단일 커넥션'}`
}

// ── S2: 토큰 CDN octet-stream ──

async function scenarioTokenOctet(ctx) {
  const server = ctx.state.server
  return candidateDownloadAndVerify(ctx, {
    label: '토큰CDN octet',
    htmlUrl: server.urls.octetHtml,
    matchSubstr: '/octet.bin',
    expectedBuf: server.expected.octet,
  })
}

// ── S3~S6: HLS ──

async function scenarioHlsPlain(ctx) {
  const server = ctx.state.server
  return candidateDownloadAndVerify(ctx, {
    label: 'HLS 평문',
    htmlUrl: server.urls.hlsPlainHtml,
    matchSubstr: '/hls/plain.m3u8',
    expectedKind: 'hls',
    expectedBuf: server.expected.hlsPlain,
  })
}

async function scenarioHlsFmp4(ctx) {
  const server = ctx.state.server
  const result = await candidateDownloadAndVerify(ctx, {
    label: 'HLS fMP4',
    htmlUrl: server.urls.hlsFmp4Html,
    matchSubstr: '/hls/fmp4.m3u8',
    expectedKind: 'hls',
    expectedBuf: server.expected.hlsFmp4,
  })
  return result
}

async function scenarioHlsAes(ctx) {
  const server = ctx.state.server
  return candidateDownloadAndVerify(ctx, {
    label: 'HLS AES-128',
    htmlUrl: server.urls.hlsAesHtml,
    matchSubstr: '/hls/aes.m3u8',
    expectedKind: 'hls',
    expectedBuf: server.expected.hlsAes, // 평문(복호화된) 기대값과 비교 — 복호화 정확성 검증
  })
}

async function scenarioHlsMaster(ctx) {
  const server = ctx.state.server
  return candidateDownloadAndVerify(ctx, {
    label: 'HLS master(최고 대역폭 선택)',
    htmlUrl: server.urls.hlsMasterHtml,
    matchSubstr: '/hls/master.m3u8',
    expectedKind: 'hls',
    expectedBuf: server.expected.hlsMasterHigh, // 저대역폭 variant 가 아니라 고대역폭이 선택돼야 함
  })
}

// ── S7: DASH muxed ──

async function scenarioDashMuxed(ctx) {
  const server = ctx.state.server
  return candidateDownloadAndVerify(ctx, {
    label: 'DASH muxed',
    htmlUrl: server.urls.dashHtml,
    matchSubstr: '/dash/muxed.mpd',
    expectedKind: 'dash',
    expectedBuf: server.expected.dash,
  })
}

// ── S8: yt-dlp 지원 호스트 (SKIP — 네이티브 동의 다이얼로그·실호스트 필요) ──

async function scenarioYtDlpHost(ctx) {
  const status = await callApi(ctx.chromeSession, 'video.ytdlpStatus', [])
  const installed = !!status?.installed
  skipScenario(
    'S8', '지원호스트(yt-dlp)',
    `yt-dlp 바이너리 ${installed ? '설치됨' : '미설치'} — 이 경로는 실제 지원 호스트(YouTube 등) 접근 + `
    + `(미설치 시) 네이티브 OS 동의 다이얼로그가 필요해 CDP 로 자동화 불가. 억지로 실행하지 않음(지시사항 준수).`,
  )
}

// ── S9: blob/MSE 세그먼트 스니핑 (감지만 — 실다운로드는 yt-dlp 이므로 생략) ──

async function scenarioMseSniff(ctx) {
  const server = ctx.state.server
  const tab = await callApi(ctx.chromeSession, 'tabs.create', [ctx.windowId, server.urls.mseHtml])
  try {
    await waitTabLoaded(ctx, tab.id, 10_000, 'MSE 페이지 로드')
    const candidate = await pollUntil(async () => {
      const list = await callApi(ctx.chromeSession, 'video.candidates', [tab.id])
      return list.find((c) => c.kind === 'site' && c.url === server.urls.mseHtml) ?? null
    }, { timeoutMs: 15_000, label: 'MSE 세그먼트 스니핑 → site 후보' })
    return `세그먼트 ${5}개 fetch 후 kind='site' 합성 후보 감지(url=${candidate.url}) — `
      + `실다운로드는 yt-dlp 경로라 생략(지시사항: 감지까지만 검증)`
  } finally {
    await callApi(ctx.chromeSession, 'tabs.close', [tab.id]).catch(() => {})
  }
}

// ── S10: 쿠키 게이트 ──

async function scenarioCookieGate(ctx) {
  const server = ctx.state.server
  return candidateDownloadAndVerify(ctx, {
    label: '쿠키게이트',
    htmlUrl: server.urls.gateLogin,
    matchSubstr: '/gate/media.bin',
    expectedKind: 'mp4',
    expectedBuf: server.expected.gate,
  })
}

// ── S11: 재시작 이어받기 ──

async function scenarioResume(ctx, args) {
  const { launchAppWithProfile, outDir, profileDir, port } = args
  const server = ctx.state.server
  const url = server.urls.resumeBig
  const expectedBuf = server.expected.resume

  const beforeDl = await callApi(ctx.chromeSession, 'downloads.list', [])
  const beforeIds = new Set(beforeDl.map((d) => d.id))
  const tab = await callApi(ctx.chromeSession, 'tabs.create', [ctx.windowId, url])

  // 진행 중(가속) 다운로드 항목 등장 + 어느 정도 받을 때까지 대기
  const inProgress = await pollUntil(async () => {
    const list = await callApi(ctx.chromeSession, 'downloads.list', [])
    const found = list.find((d) => !beforeIds.has(d.id) && d.url === url)
    if (found && found.receivedBytes > 0 && found.totalBytes > 0
      && found.receivedBytes / found.totalBytes >= 0.15) return found
    return null
  }, { timeoutMs: 20_000, label: 'S11 다운로드 15% 이상 진행 대기' })

  console.log(`  [S11] 진행률 ${inProgress.receivedBytes}/${inProgress.totalBytes} 도달 — 1초 대기 후 강제 종료(크래시 시뮬레이션)`)
  await sleep(1000) // pending-store 300ms 디바운스 flush 여유

  // 크래시 시뮬레이션 — 정상 종료 절차 없이 즉시 taskkill
  forceKillApp(ctx.appChild, outDir)
  ctx.chromeSession.close()
  await sleep(500)

  console.log('  [S11] 앱 재실행 (같은 프로필·포트) …')
  const relaunched = await launchAppWithProfile(port, profileDir, '-s11')
  ctx.appChild = relaunched.child

  const newShell = await connectShell(port)
  ctx.chromeSession = newShell.chromeSession
  ctx.windowId = newShell.windowId
  await sleep(2200) // resumePendingDownloads() 는 whenReady 이후 1.8초 지연 실행

  let entry
  try {
    entry = await pollUntil(async () => {
      const list = await callApi(ctx.chromeSession, 'downloads.list', [])
      const found = list.find((d) => d.url === url)
      if (found && (found.state === 'done' || found.state === 'failed' || found.state === 'cancelled')) return found
      return null
    }, { timeoutMs: 60_000, label: 'S11 재시작 후 이어받기 완료 대기' })
  } catch (err) {
    const snapshot = await callApi(ctx.chromeSession, 'downloads.list', []).catch(() => [])
    throw new Error(`${err.message} — downloads.list 스냅샷: ${JSON.stringify(snapshot)}`)
  }

  if (entry.state !== 'done') {
    cleanupAccelParts(entry.savePath)
    throw new Error(`이어받기 실패 — state=${entry.state} error=${entry.error ?? '(none)'} savePath=${entry.savePath}`)
  }

  let match = false
  let sizeInfo = ''
  try {
    const buf = fs.readFileSync(entry.savePath)
    sizeInfo = `${buf.length}/${expectedBuf.length} bytes`
    match = buf.length === expectedBuf.length && buf.equals(expectedBuf)
  } finally {
    safeUnlink(entry.savePath)
    cleanupAccelParts(entry.savePath)
  }
  if (!match) throw new Error(`이어받기 파일 불일치(${sizeInfo}) savePath=${entry.savePath}`)

  return `15% 지점 강제 kill(taskkill) → 재기동 → resumePendingDownloads 자동 이어받기 → `
    + `완료(${sizeInfo}, 바이트 정확히 일치, 손상 없음)`
}

// ── 메인 오케스트레이션 ──

function printResultsTable() {
  const rows = results.map((r) => ({ ID: r.id, 이름: r.name, 상태: r.status, ms: r.ms, 상세: r.detail }))
  console.log('\n===== dl-matrix 결과 =====')
  console.table(rows)
  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const skip = results.filter((r) => r.status === 'SKIP').length
  console.log(`PASS=${pass} FAIL=${fail} SKIP=${skip} (총 ${results.length})`)
}

async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('[dl-matrix] Node 22+ 필요 (전역 WebSocket 없음).')
    process.exit(2)
  }

  const args = parseArgs(process.argv.slice(2))
  fs.mkdirSync(args.out, { recursive: true })

  if (!fs.existsSync(args.exe)) {
    console.error(`[dl-matrix] exe 를 찾을 수 없음: ${args.exe}`)
    fs.writeFileSync(path.join(args.out, 'dl-matrix-results.json'), JSON.stringify([{
      id: 'INFRA', name: 'exe 존재 확인', status: 'FAIL', detail: `not found: ${args.exe}`, ms: 0,
    }], null, 2))
    process.exit(1)
  }

  console.log(`[dl-matrix] exe=${args.exe}`)
  console.log(`[dl-matrix] out=${args.out}`)
  console.log(`[dl-matrix] port=${args.port}`)
  console.log(`[dl-matrix] profile=${args.profileDir}`)

  await cleanupStaleProcess(args.out)
  seedProfile(args.profileDir)

  let server = null
  try {
    server = await startDlMatrixServer()
    console.log(`[dl-matrix] 로컬 테스트 서버 시작: http://127.0.0.1:${server.port} (runId=${server.runId})`)
  } catch (err) {
    console.error(`[dl-matrix] 로컬 테스트 서버 시작 실패 — 전체 시나리오 FAIL 처리: ${err.message}`)
    fs.writeFileSync(path.join(args.out, 'dl-matrix-results.json'), JSON.stringify([{
      id: 'INFRA', name: '로컬 테스트 서버 시작', status: 'FAIL', detail: err.message, ms: 0,
    }], null, 2))
    process.exit(1)
  }

  const dlBefore = new Set()
  try {
    for (const f of fs.readdirSync(downloadsDir())) dlBefore.add(f)
  } catch { /* Downloads 폴더 없을 수도 있음 — 무시 */ }

  const { child } = launchApp(args.exe, args.out, args.port, args.profileDir)

  const ctx = {
    port: args.port,
    outDir: args.out,
    chromeSession: null,
    windowId: null,
    appChild: child,
    state: { server },
  }

  let infraOk = false
  try {
    console.log('[dl-matrix] CDP 외피 타깃 대기 중 (최대 30초)…')
    const shell = await connectShell(args.port)
    ctx.chromeSession = shell.chromeSession
    ctx.windowId = shell.windowId
    console.log(`[dl-matrix] windowId=${ctx.windowId}`)
    await sleep(1500) // 첫 탭 안정화
    infraOk = true
  } catch (err) {
    console.error(`[dl-matrix] 인프라 셋업 실패: ${err.message}`)
    results.push({ id: 'INFRA', name: '외피 CDP 연결', status: 'FAIL', detail: err.message, ms: 0 })
  }

  if (infraOk) {
    await runScenario('S1', 'progressive mp4 (native will-download, 가속)', () => scenarioProgressive(ctx))
    await runScenario('S2', '토큰CDN octet-stream (Content-Disposition 없음)', () => scenarioTokenOctet(ctx))
    await runScenario('S3', 'HLS 평문(TS)', () => scenarioHlsPlain(ctx))
    await runScenario('S4', 'HLS fMP4', () => scenarioHlsFmp4(ctx))
    await runScenario('S5', 'HLS AES-128', () => scenarioHlsAes(ctx))
    await runScenario('S6', 'HLS master(최고 대역폭 선택)', () => scenarioHlsMaster(ctx))
    await runScenario('S7', 'DASH muxed', () => scenarioDashMuxed(ctx))
    await scenarioYtDlpHost(ctx)
    await runScenario('S9', 'blob/MSE 세그먼트 스니핑(감지)', () => scenarioMseSniff(ctx))
    await runScenario('S10', '쿠키게이트(세션 쿠키로 다운로드)', () => scenarioCookieGate(ctx))
    await runScenario('S11', '재시작 이어받기(강제 kill → 재기동)', () => scenarioResume(ctx, {
      launchAppWithProfile: (port, profileDir, suffix) => Promise.resolve(launchApp(args.exe, args.out, port, profileDir, suffix)),
      outDir: args.out,
      profileDir: args.profileDir,
      port: args.port,
    }))
  } else {
    for (const [id, name] of [
      ['S1', 'progressive mp4'], ['S2', '토큰CDN octet'], ['S3', 'HLS 평문'], ['S4', 'HLS fMP4'],
      ['S5', 'HLS AES-128'], ['S6', 'HLS master'], ['S7', 'DASH muxed'], ['S8', '지원호스트(yt-dlp)'],
      ['S9', 'blob/MSE 스니핑'], ['S10', '쿠키게이트'], ['S11', '재시작 이어받기'],
    ]) {
      results.push({ id, name, status: 'FAIL', detail: 'INFRA 실패로 실행 안 됨', ms: 0 })
    }
  }

  try { ctx.chromeSession?.close() } catch { /* ignore */ }

  if (server) {
    await server.close().catch(() => {})
    console.log('[dl-matrix] 로컬 테스트 서버 종료')
  }

  fs.writeFileSync(path.join(args.out, 'dl-matrix-results.json'), JSON.stringify(results, null, 2))
  printResultsTable()

  console.log('[dl-matrix] 앱 종료…')
  await killApp(ctx.appChild, args.port, args.out)

  // Downloads 폴더 잔재 검사 — 이 실행 중 새로 생긴 파일이 남아있으면 경고(정리 실패 가능성)
  try {
    const after = fs.readdirSync(downloadsDir())
    const newFiles = after.filter((f) => !dlBefore.has(f) && /ezb-dlm-|\.part\d+$/.test(f))
    if (newFiles.length > 0) {
      console.warn(`[dl-matrix] 경고 — Downloads 폴더에 잔재 파일 ${newFiles.length}개 발견, 정리 시도: ${newFiles.join(', ')}`)
      for (const f of newFiles) safeUnlink(path.join(downloadsDir(), f))
    } else {
      console.log('[dl-matrix] Downloads 폴더 잔재 없음 확인')
    }
    // videos 서브폴더(HLS/DASH/영상 다운로드 대상)도 검사
    const videosDir = path.join(downloadsDir(), 'videos')
    if (fs.existsSync(videosDir)) {
      const vFiles = fs.readdirSync(videosDir)
      const leftover = vFiles.filter((f) => /\[(hls|dash|http)-/.test(f) || /\.part\d+$/.test(f))
      if (leftover.length > 0) {
        console.warn(`[dl-matrix] 경고 — Downloads/videos 폴더에 잔재 파일 ${leftover.length}개 발견, 정리 시도: ${leftover.join(', ')}`)
        for (const f of leftover) safeUnlink(path.join(videosDir, f))
      } else {
        console.log('[dl-matrix] Downloads/videos 폴더 잔재 없음 확인')
      }
    }
  } catch (err) {
    console.warn('[dl-matrix] Downloads 폴더 잔재 검사 실패(무시):', err.message)
  }

  return results.some((r) => r.status === 'FAIL') ? 1 : 0
}

main().then((code) => {
  process.exit(code ?? 0)
}).catch((err) => {
  console.error('[dl-matrix] 치명적 오류:', err)
  process.exit(2)
})
