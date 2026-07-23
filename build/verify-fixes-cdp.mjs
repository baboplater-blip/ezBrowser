#!/usr/bin/env node
// verify-fixes-cdp.mjs — 디버그 라운드에서 고친 것 중 스모크 하네스가 커버하지 않는 3영역을
// packaged ezBrowser 를 CDP 로 원격 구동해 실제로 검증한다. (의존성 0 — Node 22+ 내장 WebSocket/fetch)
//   V1  보안 가드(CRITICAL): internalAPI 로 노출된 extensions/update 채널이 신뢰 origin(browser://)에서는
//        동작하고, 비신뢰 origin(data:)에서는 isTrustedSender 로 차단되는지. update.install() 이 비신뢰
//        페이지에서 앱을 강제 종료하지 못하는지.
//   V2  시크릿↔워크스페이스(HIGH): 시크릿 창을 연 채 메인 창에서 워크스페이스를 전환·삭제해도 시크릿
//        창의 탭이 살아있는지(하이재킹·강제 종료 없음).
//   V3  대화 검색 공백 정규화(MEDIUM): 여러 공백이 든 본문을 한 칸 쿼리로 검색해도 매칭되는지.
//
// 격리·안전: 스모크와 동일 — 격리 프로필(--user-data-dir), 이 하네스가 띄운 PID 만 정리.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')
const OUT = path.join(REPO_ROOT, 'verify-out')
const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 9260)

// ── 유틸 ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label} (${ms}ms)`)), ms))])
}
async function pollUntil(fn, { timeoutMs = 10000, intervalMs = 300, label = 'condition' } = {}) {
  const start = Date.now()
  let lastErr = null
  while (Date.now() - start < timeoutMs) {
    try { const v = await fn(); lastErr = null; if (v) return v } catch (err) { lastErr = err }
    await sleep(intervalMs)
  }
  throw new Error(`pollUntil timeout: ${label}${lastErr ? ` (마지막 오류: ${lastErr.message})` : ''}`)
}

// ── CDP 클라이언트 (스모크와 동일) ────────────────────────────────────────
class CDPSession {
  constructor(wsUrl, label) { this.wsUrl = wsUrl; this.label = label; this.ws = null; this._id = 0; this.pending = new Map() }
  async connect(timeoutMs = 10000) {
    this.ws = new WebSocket(this.wsUrl)
    await withTimeout(new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', (e) => reject(new Error(`ws error: ${e?.message ?? 'unknown'}`)))
    }), timeoutMs, `ws connect (${this.label})`)
    this.ws.addEventListener('message', (ev) => this._onMessage(ev))
    this.ws.addEventListener('close', () => { for (const [, p] of this.pending) p.reject(new Error('ws closed')); this.pending.clear() })
  }
  _onMessage(ev) {
    let msg; try { msg = JSON.parse(ev.data) } catch { return }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id)
      if (msg.error) reject(new Error(`CDP error [${msg.error.code}]: ${msg.error.message}`)); else resolve(msg.result)
    }
  }
  send(method, params = {}, timeoutMs = 15000) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error(`CDP not open (${this.label}) ${method}`))
    const id = (this._id += 1)
    const p = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.ws.send(JSON.stringify({ id, method, params }))
    return withTimeout(p, timeoutMs, `CDP ${method} (${this.label})`)
  }
  close() { try { this.ws?.close() } catch { /* ignore */ } }
}
async function connectSession(target, label) { const s = new CDPSession(target.webSocketDebuggerUrl, label ?? target.id); await s.connect(); return s }
async function evaluate(session, expression, opts = {}) {
  const { awaitPromise = true, returnByValue = true, timeoutMs = 15000 } = opts
  const r = await session.send('Runtime.evaluate', { expression, awaitPromise, returnByValue, userGesture: true }, timeoutMs)
  if (r.exceptionDetails) throw new Error(`JS exception in ${session.label}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`)
  return r.result?.value
}
const lit = (a) => (a === undefined ? 'undefined' : JSON.stringify(a))
const callApi = (session, apiPath, args = []) => evaluate(session, `window.browserAPI.${apiPath}(${args.map(lit).join(', ')})`)

async function getTargetList(port) { const res = await fetch(`http://127.0.0.1:${port}/json/list`); if (!res.ok) throw new Error(`/json/list ${res.status}`); return res.json() }
const isShellTarget = (t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith('file://') && t.url.includes('index.html') && t.url.includes('windowId=')
const shellWindowId = (t) => { try { return new URL(t.url).searchParams.get('windowId') } catch { return null } }
async function waitForShellTarget(port, timeoutMs = 30000) {
  return pollUntil(async () => (await getTargetList(port)).find(isShellTarget) ?? null, { timeoutMs, intervalMs: 500, label: 'shell target' })
}

// ── 앱 spawn/정리 ─────────────────────────────────────────────────────────
function seedProfile(dir) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ setup: { completed: true, completedAt: Date.now(), version: 'verify' }, startup: { mode: 'newtab', urls: [] } }, null, 2))
}
function launchApp(profileDir) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`], {
    env, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
  })
  child.stdout?.pipe(fs.createWriteStream(path.join(OUT, 'app-stdout.log')))
  child.stderr?.pipe(fs.createWriteStream(path.join(OUT, 'app-stderr.log')))
  return child
}
async function killApp(child, shell) {
  try { await evaluate(shell, 'true').catch(() => {}); await shell?.send('Browser.close', {}, 3000).catch(() => {}) } catch { /* ignore */ }
  await sleep(800)
  if (child && child.exitCode === null) { try { child.kill() } catch { /* ignore */ }; try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']) } catch { /* ignore */ } }
}

// ── 결과 ──────────────────────────────────────────────────────────────────
const results = []
async function scenario(id, fn) {
  const t0 = Date.now()
  try { const detail = await fn(); results.push({ id, status: 'PASS', ms: Date.now() - t0, detail }); console.log(`  ✓ ${id} PASS — ${detail}`) }
  catch (err) { results.push({ id, status: 'FAIL', ms: Date.now() - t0, detail: err.message }); console.log(`  ✗ ${id} FAIL — ${err.message}`) }
}

// ── 검증 시나리오 ───────────────────────────────────────────────────────────
async function findNewContentTarget(port, beforeIds, urlPrefix) {
  return pollUntil(async () => {
    const l = await getTargetList(port)
    return l.find((t) => t.type === 'page' && !beforeIds.has(t.id) && typeof t.url === 'string' && t.url.startsWith(urlPrefix)) ?? null
  }, { timeoutMs: 10000, intervalMs: 300, label: `content target ${urlPrefix}` })
}

async function V1_security(port, shell, windowId) {
  await scenario('V1 보안 가드(CRITICAL): extensions/update — 신뢰 vs 비신뢰 origin', async () => {
    // 1) browser://newtab 탭 생성 → internal.js preload(신뢰 origin)
    const before = new Set((await getTargetList(port)).map((t) => t.id))
    await callApi(shell, 'tabs.create', [windowId, 'browser://newtab'])
    const contentTarget = await findNewContentTarget(port, before, 'browser://newtab')
    const cs = await connectSession(contentTarget, 'content')
    await cs.send('Page.enable', {}).catch(() => {})

    // internalAPI 노출 확인(취약 표면 실재) + 신뢰 origin 에서는 게이트 통과(→ 'untrusted' 가 아닌 다른 에러로 실패)
    const hasApi = await evaluate(cs, `typeof window.internalAPI === 'object' && !!(window.internalAPI.extensions && window.internalAPI.update)`)
    if (!hasApi) throw new Error('browser://newtab 에 internalAPI 가 없음 — 검증 전제 실패')
    const trustedRes = await evaluate(cs, `window.internalAPI.extensions.installFromUrl('http://127.0.0.1:9/none.crx')`)
    if (!(trustedRes && trustedRes.ok === false && trustedRes.error !== 'untrusted')) {
      throw new Error(`신뢰 origin 에서 게이트 통과 실패(다운로드 시도 대신 차단됨?): ${JSON.stringify(trustedRes)}`)
    }

    // 2) 같은 탭(같은 internal.js preload)을 비신뢰 origin(data:)으로 이동 → 게이트가 차단해야 함
    await cs.send('Page.navigate', { url: 'data:text/html,<html><body>verify-untrusted</body></html>' })
    await pollUntil(async () => (await evaluate(cs, `document.body && document.body.innerText`).catch(() => '')) === 'verify-untrusted' ? true : null, { timeoutMs: 8000, intervalMs: 200, label: 'data: 로드' })
    await sleep(300)
    const stillHasApi = await evaluate(cs, `typeof window.internalAPI === 'object' && !!window.internalAPI.extensions`)
    if (!stillHasApi) throw new Error('data: 이동 후 internalAPI 가 사라짐 — 공격 표면 확인 불가(전제 실패)')
    const untrustedRes = await evaluate(cs, `window.internalAPI.extensions.installFromUrl('http://127.0.0.1:9/none.crx')`)
    if (!(untrustedRes && untrustedRes.ok === false && untrustedRes.error === 'untrusted')) {
      throw new Error(`비신뢰 origin 에서 차단 안 됨(RCE 가능): ${JSON.stringify(untrustedRes)}`)
    }
    // update.install() 이 비신뢰 페이지에서 앱을 강제 종료하지 못하는지 — 호출 후 앱 생존 확인
    await evaluate(cs, `window.internalAPI.update.install()`).catch(() => {})
    await sleep(500)
    const alive = (await evaluate(shell, '1+1').catch(() => null)) === 2
    if (!alive) throw new Error('비신뢰 update.install() 이 앱을 종료시킴(DoS) — 게이트 실패')
    cs.close()
    return `신뢰(browser://)→게이트 통과(err='${trustedRes.error}'), 비신뢰(data:)→차단(err='untrusted'), update.install() 후 앱 생존 확인`
  })
}

async function V2_incognitoWorkspace(port, shell, windowId) {
  await scenario('V2 시크릿↔워크스페이스(HIGH): 워크스페이스 전환·삭제에도 시크릿 탭 생존', async () => {
    const st = await callApi(shell, 'workspace.state', [])
    const w0 = st.activeId
    if (!w0) throw new Error('활성 워크스페이스 id 를 읽지 못함')

    // 시크릿 창 생성(생성 시점 활성 ws=w0 → 시크릿 탭 workspaceId=w0)
    const beforeShellIds = new Set((await getTargetList(port)).filter(isShellTarget).map((t) => t.id))
    const ran = await callApi(shell, 'actions.run', ['action.window.incognito', { windowId }])
    if (!ran) throw new Error('action.window.incognito 실행 실패(등록 안 됨?)')
    const incogShell = await pollUntil(async () => (await getTargetList(port)).find((t) => isShellTarget(t) && !beforeShellIds.has(t.id)) ?? null, { timeoutMs: 10000, label: '시크릿 창 외피' })
    const incogSession = await connectSession(incogShell, 'incog-shell')
    const incogWid = shellWindowId(incogShell)
    if (!incogWid) throw new Error('시크릿 창 windowId 파싱 실패')

    const incogTabsBefore = await callApi(incogSession, 'tabs.list', [incogWid])
    const beforeCount = incogTabsBefore.length
    const beforeIds = incogTabsBefore.map((t) => t.id).sort()
    if (beforeCount < 1) throw new Error('시크릿 창에 탭이 없음(전제 실패)')

    // 메인 창에서 워크스페이스 생성 + 전환(하이재킹 유발 시도) → 시크릿 탭 유지 확인
    const w1 = await callApi(shell, 'workspace.create', [{}])
    await callApi(shell, 'workspace.activate', [w1.id])
    await sleep(600)
    const afterSwitch = await callApi(incogSession, 'tabs.list', [incogWid])
    if (afterSwitch.length !== beforeCount || afterSwitch.map((t) => t.id).sort().join() !== beforeIds.join()) {
      throw new Error(`워크스페이스 전환 후 시크릿 탭이 바뀜(하이재킹): before=${beforeIds.join()} after=${afterSwitch.map((t) => t.id).sort().join()}`)
    }

    // 메인 창에서 w0(시크릿 탭의 workspaceId) 삭제(강제 종료 유발 시도) → 시크릿 탭 유지 확인
    await callApi(shell, 'workspace.remove', [w0]).catch(() => {})
    await sleep(600)
    const afterRemove = await callApi(incogSession, 'tabs.list', [incogWid])
    if (afterRemove.length !== beforeCount || afterRemove.map((t) => t.id).sort().join() !== beforeIds.join()) {
      throw new Error(`워크스페이스 삭제가 시크릿 탭을 닫음(강제 종료): before=${beforeIds.join()} after=${afterRemove.map((t) => t.id).sort().join()}`)
    }
    const incogTargetAlive = (await getTargetList(port)).some((t) => t.id === incogShell.id)
    if (!incogTargetAlive) throw new Error('시크릿 창 자체가 사라짐')
    incogSession.close()
    return `시크릿 탭 ${beforeCount}개 — 워크스페이스 전환 후 유지, w0 삭제 후에도 유지(강제 종료·하이재킹 없음)`
  })
}

async function V3_convSearch(port, shell) {
  await scenario('V3 대화 검색 공백 정규화(MEDIUM)', async () => {
    const id = 'verify-conv-' + Date.now()
    const saved = await callApi(shell, 'ai.convSave', [{ id, messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'the quick    brown\nfox jumps' }] }])
    if (!saved) throw new Error('convSave 실패')
    await sleep(200)
    // 본문엔 "brown\nfox"/"quick    brown"(여러 공백)이 있고, 한 칸 쿼리로 검색 → 정규화로 매칭돼야 함
    const hits = await callApi(shell, 'ai.convSearch', ['quick brown'])
    const hit = Array.isArray(hits) && hits.some((h) => h.id === id)
    if (!hit) throw new Error(`공백 다른 쿼리("quick brown")가 여러 공백 본문을 못 찾음: ${JSON.stringify(hits)}`)
    const hits2 = await callApi(shell, 'ai.convSearch', ['brown fox'])
    const hit2 = Array.isArray(hits2) && hits2.some((h) => h.id === id)
    if (!hit2) throw new Error(`줄바꿈 걸친 쿼리("brown fox")가 매칭 안 됨: ${JSON.stringify(hits2)}`)
    await callApi(shell, 'ai.convDelete', [id]).catch(() => {})
    return `여러 공백/줄바꿈 본문을 한 칸 쿼리로 매칭 확인("quick brown","brown fox")`
  })
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const profileDir = path.join(OUT, 'profile')
  seedProfile(profileDir)
  console.log(`[verify] EXE=${EXE}`)
  console.log(`[verify] port=${PORT} profile=${profileDir}`)
  const child = launchApp(profileDir)
  let shell = null
  try {
    const shellTarget = await waitForShellTarget(PORT, 30000)
    console.log(`[verify] 외피 타깃: ${shellTarget.url}`)
    shell = await connectSession(shellTarget, 'chrome-shell')
    const windowId = shellWindowId(shellTarget)
    await sleep(800) // 초기화(adblock 등) 여유

    await V1_security(PORT, shell, windowId)
    await V3_convSearch(PORT, shell)
    await V2_incognitoWorkspace(PORT, shell, windowId) // 마지막 — 워크스페이스 상태를 크게 바꾸므로

    console.log('\n===== verify 결과 =====')
    for (const r of results) console.log(`${r.id.split(':')[0].padEnd(4)} ${r.status}  ${r.ms}ms`)
    const pass = results.filter((r) => r.status === 'PASS').length
    const fail = results.filter((r) => r.status === 'FAIL').length
    console.log(`\nPASS=${pass} FAIL=${fail} (총 ${results.length})`)
    fs.writeFileSync(path.join(OUT, 'verify-results.json'), JSON.stringify(results, null, 2))
  } finally {
    await killApp(child, shell)
  }
}

main().catch((err) => { console.error('[verify] 치명적 오류:', err); process.exitCode = 1 })
