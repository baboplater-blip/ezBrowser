#!/usr/bin/env node
// ext-matrix.mjs — 크롬 확장 호환 매트릭스 검증 하네스 (게이트 5, CLAUDE.md 1원칙 #2).
//
// packaged ezBrowser.exe 를 CDP 로 원격 구동해 Chrome Web Store 상위 확장 10종을
// 앱의 실제 설치 경로(browserAPI.extensions.installFromUrl — browser://extensions 페이지의
// "URL 설치" 버튼과 동일 코드 경로, app/main/extensions/adapter.ts installFromUrl)로 설치하고,
// 로드·MV3 service worker 활성·액션(popup) 렌더링을 검증한다.
//
// 검증만 — app/ 은 절대 수정하지 않는다. 이미 패키징된 dist/win-unpacked/ezBrowser.exe 사용.
//
// 핵심 설계 결정 — 왜 CRX 를 직접 언팩해 폴더에 심지 않고 installFromUrl 을 쓰는가:
//   1. 앱의 실제 유저 플로우(URL 설치/드래그 설치)를 그대로 검증하는 게 이 작업의 목적.
//   2. installFromCrx 는 파일 없이 호출하면 dialog.showOpenDialog 를 띄워 자동화가 막힘 —
//      installFromUrl 은 순수 IPC 왕복(다운로드 자체는 메인 프로세스가 수행)이라 CDP 로 완전 자동화 가능.
//   3. CRX 페이로드(zip)에는 보통 manifest.json 에 "key" 필드가 없어, loadExtension() 이 부여하는
//      실제 확장 ID 는 웹스토어 ID 와 다르다(경로 해시 기반). installFromUrl 은 이 실제 ID(loaded.id)를
//      돌려주므로, 우리가 직접 언팩했을 때 생기는 "ID 불일치로 SW/타깃 상관관계를 못 잡는" 문제가 없다.
//
// 사용:
//   node build/ext-matrix.mjs [--exe <path>] [--out <dir>] [--port <n>] [--keep-alive]

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const DEFAULTS = {
  exe: path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe'),
  out: 'C:\\Users\\molma\\AppData\\Local\\Temp\\claude\\c--Users-molma-Desktop-----browser-build\\9385582e-821e-4490-88cc-bb0c7fda225a\\scratchpad\\ext-matrix',
  port: 9232,
  keepAlive: false,
}

const EXTENSIONS = [
  { id: 'ddkjiahejlhfcafbddmgiahcphecmpfh', name: 'uBlock Origin Lite' },
  { id: 'eimadpbcbfnmbkopoojfekhnkhdbieeh', name: 'Dark Reader' },
  { id: 'nngceckbapebfimnlniiiahkandclblb', name: 'Bitwarden' },
  { id: 'dbepggeogbaibhgnhhndojpepiihcmeb', name: 'Vimium' },
  { id: 'bcjindcccaagfpapjjmafapmmgkkhgoa', name: 'JSON Formatter' },
  { id: 'clngdbkpkpeebahjckkjfobafhncgmne', name: 'Stylus' },
  { id: 'dhdgffkkebhmkfjojejmpbldmpobfkfo', name: 'Tampermonkey' },
  { id: 'niloccemoadcdkdjlinkgdfekeahmflj', name: 'Save to Pocket' },
  { id: 'gppongmhjkpfnbhagpmjfkannfbllamg', name: 'Wappalyzer' },
  { id: 'bhlhnicpbhignbdhedgjhgdocnmhomnp', name: 'ColorZilla' },
]

// ── 인자 파싱 ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--exe') out.exe = path.resolve(argv[++i] ?? '')
    else if (a === '--out') out.out = path.resolve(argv[++i] ?? '')
    else if (a === '--port') out.port = Number(argv[++i] ?? DEFAULTS.port)
    else if (a === '--keep-alive') out.keepAlive = true
    else console.warn(`[ext-matrix] 알 수 없는 인자 무시: ${a}`)
  }
  return out
}

// ── 공통 유틸 (smoke-cdp.mjs 패턴 재사용) ────────────────────────────────

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

// ── 프로세스 관리 (PID 스코프 종료만 — Stop-Process -Name 금지) ──────────

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
  if (res.error) console.warn('[ext-matrix] taskkill 실행 오류(무시):', res.error.message)
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
    await browserSession.send('Browser.close', {}, timeoutMs).catch(() => { /* Electron 미지원이어도 무방 */ })
    browserSession.close()
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
  console.log(`[ext-matrix] 이전 실행이 남긴 프로세스 발견 (pid=${stale.pid}, port=${stale.port}) — 정리 시도…`)
  if (isPidAlive(stale.pid)) {
    const graceful = await tryGracefulShutdown(stale.port)
    if (graceful) await sleep(1500)
    if (isPidAlive(stale.pid)) killPidTree(stale.pid)
  }
  removeProcFile(outDir)
}

function launchApp(exePath, outDir, port, profileDir) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

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
    console.log(`[ext-matrix] app process exited (code=${code} signal=${signal})`)
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

function seedProfile(profileDir) {
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const settingsPath = path.join(profileDir, 'settings.json')
  const seed = {
    setup: { completed: true, completedAt: Date.now(), version: 'ext-matrix' },
    startup: { mode: 'newtab', urls: [] },
  }
  fs.writeFileSync(settingsPath, JSON.stringify(seed, null, 2))
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

async function cdpScreenshot(session, outDir, name) {
  try {
    const result = await session.send('Page.captureScreenshot', { format: 'png' }, 10_000)
    const outPath = path.join(outDir, `${name}.png`)
    fs.writeFileSync(outPath, Buffer.from(result.data, 'base64'))
    return { ok: true, path: outPath }
  } catch (err) { return { ok: false, error: err.message } }
}

// ── 확장 매니페스트 로컬 읽기 (userData/extensions/<realId>/manifest.json) ──

function extensionsRootOf(profileDir) { return path.join(profileDir, 'extensions') }

function readManifest(profileDir, realId) {
  try {
    const raw = fs.readFileSync(path.join(extensionsRootOf(profileDir), realId, 'manifest.json'), 'utf8')
    return JSON.parse(raw)
  } catch { return null }
}

function grepContentScriptsForMarker(profileDir, realId) {
  // JSON Formatter 등 콘텐츠 스크립트가 페이지에 남기는 특징적 클래스/ID 문자열을
  // 언팩된 소스에서 찾아 동작 확인의 실마리로 쓴다 (best-effort — 못 찾아도 실패 아님).
  const dir = path.join(extensionsRootOf(profileDir), realId)
  const markers = new Set()
  const patterns = [/id=['"]([\w-]{4,40})['"]/g, /class(?:List\.add)?\(?['"]([\w-]{6,40})['"]/g]
  function walk(d, depth) {
    if (depth > 3) return
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walk(p, depth + 1); continue }
      if (!/\.(js)$/i.test(e.name)) continue
      let text = ''
      try { text = fs.readFileSync(p, 'utf8') } catch { continue }
      if (text.length > 2_000_000) continue // 너무 큰(번들) 파일은 스킵 — 노이즈만 늘어남
      for (const re of patterns) {
        let m
        let count = 0
        while ((m = re.exec(text)) && count < 20) {
          count++
          const val = m[1]
          if (/json/i.test(val) || /format/i.test(val)) markers.add(val)
        }
      }
    }
  }
  walk(dir, 0)
  return [...markers].slice(0, 10)
}

// ── CDP 타깃에서 확장 관련 컨텍스트 찾기 ─────────────────────────────────

function extIdFromUrl(url) {
  const m = /^chrome-extension:\/\/([a-z]{32})\//.exec(url || '')
  return m ? m[1] : null
}

async function findExtensionTargets(port) {
  const list = await getTargetList(port)
  const out = []
  for (const t of list) {
    const id = extIdFromUrl(t.url)
    if (id) out.push({ id, type: t.type, url: t.url, title: t.title })
  }
  return out
}

// ── 결과 수집 ────────────────────────────────────────────────────────────

const matrix = []

function record(entry) {
  matrix.push(entry)
  console.log(`  → [${entry.id}] ${entry.name}: ${entry.status}${entry.note ? ` — ${entry.note}` : ''}`)
}

// ── 메인 검증 루틴 ───────────────────────────────────────────────────────

async function installExtension(ctx, ext) {
  const webstoreUrl = `https://chromewebstore.google.com/detail/x/${ext.id}`
  try {
    const res = await callApi(ctx.chromeSession, 'extensions.installFromUrl', [webstoreUrl], { timeoutMs: 45_000 })
    return res
  } catch (err) {
    return { ok: false, error: `IPC/CDP 예외: ${err.message}` }
  }
}

async function checkActionRenders(ctx, realId) {
  // browserAPI.extensions.invokeAction 은 popup(또는 옵션 페이지)을 새 탭으로 연다
  // (app/main/extensions/adapter.ts invokeExtensionAction — 정식 팝업 창 미구현, 새 탭 폴백).
  // 실사용자가 툴바 아이콘을 누르는 것과 동일한 코드 경로.
  const before = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
  const beforeIds = new Set(before.map((t) => t.id))
  const res = await callApi(ctx.chromeSession, 'extensions.invokeAction', [realId], { timeoutMs: 10_000 })
  if (!res || res.ok !== true) return { rendered: false, note: `invokeAction 실패: ${res?.error ?? '(unknown)'}` }

  try {
    const tab = await pollUntil(async () => {
      const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
      return tabs.find((t) => !beforeIds.has(t.id) && typeof t.url === 'string' && t.url.startsWith(`chrome-extension://${realId}/`)) ?? null
    }, { timeoutMs: 6000, label: 'action popup/options 탭' })

    await pollUntil(async () => {
      const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
      const t = tabs.find((x) => x.id === tab.id)
      return t && !t.loading
    }, { timeoutMs: 8000, label: '액션 탭 로드 완료' })

    const target = await pollUntil(async () => {
      const list = await getTargetList(ctx.port)
      return list.find((x) => x.url === tab.url) ?? null
    }, { timeoutMs: 5000, label: '액션 탭 CDP 타깃' })

    const session = await connectSession(target, `ext-action:${realId}`)
    ctx.openSessions.push(session)
    const bodyLen = await evaluate(session, 'document.body ? document.body.innerText.length : -1').catch(() => -1)
    const htmlLen = await evaluate(session, 'document.documentElement ? document.documentElement.outerHTML.length : -1').catch(() => -1)
    const isChromeError = await evaluate(session, `document.documentElement && document.documentElement.getAttribute('data-bb-href') === 'chrome-error://chromewebdata/'`).catch(() => false)
    const readyState = await evaluate(session, 'document.readyState').catch(() => 'unknown')
    await callApi(ctx.chromeSession, 'tabs.close', [tab.id]).catch(() => {})
    // bodyLen>=0 만으로는 빈 chrome-error 페이지(로드 "성공"으로 보이는 실패)를 오탐한다 —
    // 실제 컨텐츠가 있어야(문서 HTML 이 최소한의 크기를 넘어야) "렌더됨"으로 판정한다.
    const rendered = readyState === 'complete' && !isChromeError && (bodyLen > 0 || htmlLen > 200)
    return { rendered, note: `readyState=${readyState}, bodyTextLen=${bodyLen}, htmlLen=${htmlLen}, isChromeError=${isChromeError}, url=${tab.url}` }
  } catch (err) {
    return { rendered: false, note: `팝업/옵션 탭 확인 실패: ${err.message}` }
  }
}

async function checkDarkReader(ctx) {
  const before = await getTargetList(ctx.port)
  const beforeIds = new Set(before.map((t) => t.id))
  const tab = await callApi(ctx.chromeSession, 'tabs.create', [ctx.windowId, 'https://example.com/'])
  try {
    await pollUntil(async () => {
      const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
      const t = tabs.find((x) => x.id === tab.id)
      return t && !t.loading
    }, { timeoutMs: 15000, label: 'Dark Reader probe 탭 로드' })
    await sleep(1200) // 확장 콘텐츠 스크립트 적용 시간
    const target = await pollUntil(async () => {
      const list = await getTargetList(ctx.port)
      return list.find((t) => !beforeIds.has(t.id) && typeof t.url === 'string' && t.url.startsWith('https://example.com')) ?? null
    }, { timeoutMs: 8000, label: 'Dark Reader probe CDP 타깃' })
    const session = await connectSession(target, 'darkreader-probe')
    ctx.openSessions.push(session)
    const signal = await evaluate(session, `(() => {
      const hasStyleTag = !!document.querySelector('style.darkreader, style[data-darkreader-src], #dark-reader-style, [data-darkreader-scheme], [data-darkreader-mode]');
      const bg = getComputedStyle(document.documentElement).backgroundColor;
      const bodyBg = document.body ? getComputedStyle(document.body).backgroundColor : '';
      return { hasStyleTag, bg, bodyBg };
    })()`)
    const shot = await cdpScreenshot(session, ctx.outDir, 'darkreader-example-com')
    const darkened = /rgba?\((\d+), *(\d+), *(\d+)/.exec(signal.bodyBg || signal.bg || '')
    let isDark = false
    if (darkened) {
      const [, r, g, b] = darkened.map(Number)
      isDark = (r + g + b) / 3 < 128
    }
    return {
      applied: signal.hasStyleTag || isDark,
      note: `hasStyleTag=${signal.hasStyleTag}, html-bg=${signal.bg}, body-bg=${signal.bodyBg}, 스크린샷=${shot.ok ? shot.path : shot.error}`,
    }
  } finally {
    await callApi(ctx.chromeSession, 'tabs.close', [tab.id]).catch(() => {})
  }
}

async function checkVimium(ctx) {
  const before = await getTargetList(ctx.port)
  const beforeIds = new Set(before.map((t) => t.id))
  const tab = await callApi(ctx.chromeSession, 'tabs.create', [ctx.windowId, 'https://example.com/'])
  try {
    await pollUntil(async () => {
      const tabs = await callApi(ctx.chromeSession, 'tabs.list', [ctx.windowId])
      const t = tabs.find((x) => x.id === tab.id)
      return t && !t.loading
    }, { timeoutMs: 15000, label: 'Vimium probe 탭 로드' })
    await sleep(800)
    const target = await pollUntil(async () => {
      const list = await getTargetList(ctx.port)
      return list.find((t) => !beforeIds.has(t.id) && typeof t.url === 'string' && t.url.startsWith('https://example.com')) ?? null
    }, { timeoutMs: 8000, label: 'Vimium probe CDP 타깃' })
    const session = await connectSession(target, 'vimium-probe')
    ctx.openSessions.push(session)
    await evaluate(session, `document.body.focus()`)
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, text: 'f' })
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 })
    await sleep(600)
    const hasHints = await evaluate(session, `!!document.getElementById('vimiumHintMarkerContainer') || !!document.querySelector('.vimiumHintMarker, div[class*="vimium"]')`)
    const shot = await cdpScreenshot(session, ctx.outDir, 'vimium-example-com')
    return { applied: hasHints, note: `hint-DOM 발견=${hasHints}, 스크린샷=${shot.ok ? shot.path : shot.error}` }
  } finally {
    await callApi(ctx.chromeSession, 'tabs.close', [tab.id]).catch(() => {})
  }
}

async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('[ext-matrix] Node 22+ 필요 (전역 WebSocket 없음).')
    process.exit(2)
  }

  const args = parseArgs(process.argv.slice(2))
  fs.mkdirSync(args.out, { recursive: true })
  const profileDir = path.join(args.out, 'profile')

  const report = {
    startedAt: new Date().toISOString(),
    exe: args.exe,
    port: args.port,
    electronChromeExtensionsInstalled: null,
    matrix: [],
  }

  try {
    const req = (await import('node:module')).createRequire(import.meta.url)
    req.resolve('electron-chrome-extensions', { paths: [REPO_ROOT] })
    report.electronChromeExtensionsInstalled = true
  } catch {
    report.electronChromeExtensionsInstalled = false
  }
  console.log(`[ext-matrix] electron-chrome-extensions 설치 여부: ${report.electronChromeExtensionsInstalled}`)

  if (!fs.existsSync(args.exe)) {
    console.error(`[ext-matrix] exe 를 찾을 수 없음: ${args.exe}`)
    report.fatal = `exe not found: ${args.exe}`
    fs.writeFileSync(path.join(args.out, 'ext-matrix-results.json'), JSON.stringify(report, null, 2))
    process.exit(1)
  }

  console.log(`[ext-matrix] exe=${args.exe}`)
  console.log(`[ext-matrix] out=${args.out}`)
  console.log(`[ext-matrix] port=${args.port}`)
  console.log(`[ext-matrix] profile=${profileDir}`)

  await cleanupStaleProcess(args.out)
  seedProfile(profileDir)

  const { child } = launchApp(args.exe, args.out, args.port, profileDir)

  const ctx = {
    port: args.port,
    outDir: args.out,
    chromeSession: null,
    windowId: null,
    openSessions: [],
  }

  let infraOk = false
  try {
    console.log('[ext-matrix] CDP 외피 타깃 대기 중 (최대 30초)…')
    const shellTarget = await waitForShellTarget(args.port, 30_000)
    ctx.chromeSession = await connectSession(shellTarget, 'chrome-shell')
    ctx.openSessions.push(ctx.chromeSession)
    ctx.windowId = await evaluate(ctx.chromeSession, `new URL(location.href).searchParams.get('windowId')`)
    if (!ctx.windowId) throw new Error('외피 URL 에서 windowId 를 읽지 못함')
    console.log(`[ext-matrix] windowId=${ctx.windowId}`)
    await sleep(1500) // 첫 탭/부팅 안정화
    infraOk = true
  } catch (err) {
    console.error(`[ext-matrix] 인프라 셋업 실패: ${err.message}`)
    report.fatal = `infra: ${err.message}`
  }

  if (infraOk) {
    console.log(`\n[ext-matrix] 확장 ${EXTENSIONS.length}종 설치 시작 (순차, installFromUrl)…`)
    for (const ext of EXTENSIONS) {
      console.log(`\n[install] ${ext.name} (${ext.id})`)
      const installRes = await installExtension(ctx, ext)
      const entry = {
        webstoreId: ext.id,
        name: ext.name,
        download: 'UNKNOWN',
        load: 'UNKNOWN',
        realId: null,
        manifestVersion: null,
        backgroundType: null,
        swActive: null,
        backgroundPageActive: null,
        actionRendered: null,
        spotCheck: null,
        note: '',
        status: 'UNKNOWN',
      }

      if (!installRes || installRes.ok !== true) {
        const errMsg = installRes?.error ?? '(no error message)'
        // installFromUrl 은 다운로드 실패와 로드 실패를 구분해 error 문자열에 남긴다
        // (adapter.ts: "다운로드 실패", "네트워크 오류", "압축 해제 실패", "로드 실패").
        const isDownloadFail = /다운로드 실패|네트워크 오류/.test(errMsg)
        entry.download = isDownloadFail ? 'FAILED' : 'OK'
        entry.load = isDownloadFail ? 'N/A' : 'FAILED'
        entry.status = isDownloadFail ? 'DOWNLOAD-FAILED' : 'LOAD-FAILED'
        entry.note = errMsg
        record({ id: ext.id, name: ext.name, status: entry.status, note: errMsg })
        report.matrix.push(entry)
        await sleep(600)
        continue
      }

      entry.download = 'OK'
      entry.load = 'OK'
      entry.realId = installRes.id
      const manifest = readManifest(profileDir, installRes.id)
      if (manifest) {
        entry.manifestVersion = manifest.manifest_version ?? null
        entry.backgroundType = manifest.background?.service_worker
          ? 'service_worker'
          : (manifest.background?.page || manifest.background?.scripts ? 'background_page' : (manifest.background ? 'unknown' : 'none'))
        entry.hasAction = Boolean(manifest.action || manifest.browser_action)
      }
      report.matrix.push(entry)
      matrix.push({ id: ext.id, name: ext.name, status: 'LOADED(pending checks)' })
      await sleep(500)
    }

    // 모든 설치 시도가 끝난 뒤 잠깐 대기 — MV3 service worker 가 뜰 시간(lazy activate 가능성).
    console.log('\n[ext-matrix] 설치 완료 대기(SW 활성화 여유)…')
    await sleep(3000)

    const extTargets = await findExtensionTargets(args.port)
    fs.writeFileSync(path.join(args.out, 'ext-cdp-targets.json'), JSON.stringify(extTargets, null, 2))

    const list = await callApi(ctx.chromeSession, 'extensions.list', []).catch(() => [])
    fs.writeFileSync(path.join(args.out, 'ext-list-snapshot.json'), JSON.stringify(list, null, 2))

    for (const entry of report.matrix) {
      if (!entry.realId) continue
      const own = extTargets.filter((t) => t.id === entry.realId)
      entry.swActive = own.some((t) => t.type === 'service_worker')
      entry.backgroundPageActive = own.some((t) => t.type === 'background_page' || (t.type === 'page' && /background/i.test(t.url)))
      entry.cdpTargets = own
      // storedId(설치 API 가 돌려준 id, extensions.list() 의 id 이자 userData/extensions/<id>/ 디렉터리명)가
      // 실제 Chromium 이 부여한 런타임 ID 와 일치하는지 — installFromCrx/installFromUrl 은 임시 경로에서
      // 먼저 로드해 id 를 얻은 뒤 최종 경로로 이동시켜 재로드하는데, Electron 의 확장 ID 생성이 설치 경로
      // 해시 기반이라(manifest 에 "key" 없는 한) 이 두 id 가 다를 수 있다. storedIdLiveInCdp=false 면
      // browser://extensions 의 "▶ 실행"/"⚙ 옵션"/삭제/토글이 잘못된 id 를 참조하게 되는 근거.
      entry.storedIdLiveInCdp = own.length > 0
    }

    // 액션(popup/options) 렌더 확인 — hasAction 인 것만.
    for (const entry of report.matrix) {
      if (!entry.realId || !entry.hasAction) continue
      console.log(`\n[action-check] ${entry.name}`)
      try {
        const r = await checkActionRenders(ctx, entry.realId)
        entry.actionRendered = r.rendered
        entry.actionNote = r.note
        console.log(`  → actionRendered=${r.rendered} (${r.note})`)
      } catch (err) {
        entry.actionRendered = false
        entry.actionNote = `예외: ${err.message}`
        console.log(`  → 예외: ${err.message}`)
      }
    }

    // 스팟 동작 확인 — Dark Reader / Vimium / JSON Formatter (가능한 것만, 억지 안 함).
    const darkReader = report.matrix.find((e) => e.webstoreId === 'eimadpbcbfnmbkopoojfekhnkhdbieeh')
    if (darkReader?.realId) {
      console.log('\n[spot-check] Dark Reader — example.com 다크 적용 확인')
      try {
        const r = await checkDarkReader(ctx)
        darkReader.spotCheck = r
        console.log(`  → applied=${r.applied} (${r.note})`)
      } catch (err) {
        darkReader.spotCheck = { applied: false, note: `예외: ${err.message}` }
      }
    }

    const vimium = report.matrix.find((e) => e.webstoreId === 'dbepggeogbaibhgnhhndojpepiihcmeb')
    if (vimium?.realId) {
      console.log('\n[spot-check] Vimium — "f" 키 링크 힌트 확인')
      try {
        const r = await checkVimium(ctx)
        vimium.spotCheck = r
        console.log(`  → applied=${r.applied} (${r.note})`)
      } catch (err) {
        vimium.spotCheck = { applied: false, note: `예외: ${err.message}` }
      }
    }

    const jsonFmt = report.matrix.find((e) => e.webstoreId === 'bcjindcccaagfpapjjmafapmmgkkhgoa')
    if (jsonFmt?.realId) {
      console.log('\n[spot-check] JSON Formatter — 소스 마커 추출(참고용, 자동 DOM 검증은 생략)')
      const markers = grepContentScriptsForMarker(profileDir, jsonFmt.realId)
      jsonFmt.spotCheck = { applied: null, note: `content script 마커 후보: ${markers.join(', ') || '(없음)'} — DOM 자동 검증은 하지 않음(오탐 위험), SW/action 렌더 확인으로 대체` }
      console.log(`  → 마커 후보: ${markers.join(', ') || '(없음)'}`)
    }

    // 최종 상태 분류
    for (const entry of report.matrix) {
      if (entry.status === 'DOWNLOAD-FAILED' || entry.status === 'LOAD-FAILED') continue
      const hasSignal = entry.swActive || entry.backgroundPageActive
      const behaviorOk = entry.actionRendered === true || entry.spotCheck?.applied === true
      if (behaviorOk) entry.status = 'LOADED+동작확인'
      else if (entry.hasAction && entry.actionRendered === false && entry.storedIdLiveInCdp === false) {
        entry.status = 'LOADED(ID 불일치로 액션 깨짐)'
      } else if (hasSignal || entry.actionRendered === false || entry.hasAction === false) {
        entry.status = `LOADED(sw=${entry.swActive}, bg=${entry.backgroundPageActive}, action=${entry.actionRendered ?? 'N/A'})`
      } else entry.status = 'LOADED(신호 없음)'
      console.log(`\n[최종] ${entry.name}: ${entry.status} (storedIdLiveInCdp=${entry.storedIdLiveInCdp})`)
    }
  } else {
    for (const ext of EXTENSIONS) {
      report.matrix.push({ webstoreId: ext.id, name: ext.name, status: 'INFRA-FAIL', note: report.fatal })
    }
  }

  for (const s of ctx.openSessions) s.close()

  report.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(args.out, 'ext-matrix-results.json'), JSON.stringify(report, null, 2))

  console.log('\n===== ext-matrix 결과 =====')
  console.table(report.matrix.map((e) => ({
    ID: e.webstoreId, 이름: e.name, 다운로드: e.download, 로드: e.load, realId: e.realId,
    MV: e.manifestVersion, BG: e.backgroundType, SW활성: e.swActive, 액션렌더: e.actionRendered, 상태: e.status,
  })))
  const loadedCount = report.matrix.filter((e) => typeof e.status === 'string' && e.status.startsWith('LOADED')).length
  console.log(`LOADED 이상: ${loadedCount}/${EXTENSIONS.length}`)

  if (!args.keepAlive) {
    console.log('[ext-matrix] 앱 종료…')
    await killApp(child, args.port, args.out)
  } else {
    console.log(`[ext-matrix] --keep-alive 지정됨 — pid=${child.pid} 유지`)
    child.unref()
  }

  return 0
}

main().then((code) => process.exit(code ?? 0)).catch((err) => {
  console.error('[ext-matrix] 치명적 오류:', err)
  process.exit(2)
})
