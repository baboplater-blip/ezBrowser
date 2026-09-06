#!/usr/bin/env node
// verify-agent-safety-cdp.mjs — 에이전트 안전 라운드에서 고친 것 중 "실제 웹 페이지에서만" 검증되는 것을
// packaged ezBrowser 를 CDP 로 원격 구동해 진짜 DOM 위에서 확인한다. (의존성 0 — Node 22+ 내장 WebSocket/fetch)
//
//   A1  DOM 지문 제거: 관찰(observePage) 이 DOM 을 전혀 수정하지 않는가.
//        - 페이지가 MutationObserver 로 감시 중일 때 속성/자식 변경이 0건인가
//        - document.querySelector('[data-bb-agent-ref]') 가 null 인가 (예전엔 여기서 자동화가 노출됐다)
//   A2  레지스트리 클릭: 속성 없이도 ref 로 정확한 요소를 클릭하는가(회귀 없음).
//   A3  같은 요소 shadow DOM 안에서도 관찰·클릭되는가(레지스트리로 바뀐 뒤에도 유지).
//   A4  재활용 노드 방어: 관찰 후 그 자리의 내용이 다른 항목으로 바뀌면(가상 스크롤) 클릭을 거부하는가.
//        (예전엔 옛 ref 가 남아 엉뚱한 게시물에 좋아요·신고를 누를 수 있었다.)
//
// 구동 방식: page-actions.js 는 electron 런타임 의존이 없다(타입만 import). 그래서 컴파일된 모듈을 Node 에서
// 직접 require 하고, WebContents 대신 "CDP 로 실제 페이지에 evaluate 하는 가짜 wc" 를 넘긴다 →
// 인페이지 스크립트(관찰·집기·실행)를 진짜 브라우저 DOM 위에서 그대로 검증한다.
//
// 격리·안전: 다른 하네스와 동일 — 격리 프로필(--user-data-dir), 이 하네스가 띄운 PID 만 정리.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')
const OUT = path.join(REPO_ROOT, 'verify-out')
const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 9271)

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

// ── CDP 클라이언트 (다른 하네스와 동일) ────────────────────────────────────
class CDPSession {
  constructor(wsUrl, label) { this.wsUrl = wsUrl; this.label = label; this.ws = null; this._id = 0; this.pending = new Map(); this.events = [] }
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
      return
    }
    // CDP 이벤트 — Electron debugger 의 'message' 시그니처(event, method, params, sessionId)로 전달한다.
    if (typeof msg.method === 'string') for (const fn of this.events) { try { fn({}, msg.method, msg.params ?? {}, msg.sessionId) } catch { /* ignore */ } }
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

// ── 테스트 페이지 ──────────────────────────────────────────────────────────
// 자동화 탐지를 흉내내는 페이지: MutationObserver 로 자기 DOM 변화(속성·자식)를 전부 센다.
const TEST_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>agent-safety</title></head><body>
<h1>에이전트 안전 검증 페이지</h1>
<div id="feed">
  <button id="postA" data-kind="post">게시물 A 좋아요</button>
  <button id="postB" data-kind="post">게시물 B 신고</button>
</div>
<input id="cap" placeholder="캡션 입력">
<!-- 유튜브 스튜디오처럼 영상·썸네일 입력이 공존하는 상황(썸네일 칸이 DOM 상 마지막) -->
<input type="file" id="video" accept="video/*">
<input type="file" id="thumb" accept="image/*">
<!-- 유튜브 업로드 화면 흉내 — 진행률 + 공개범위 라디오 + 아직 못 누르는 게시 버튼 -->
<div role="progressbar" aria-label="업로드" aria-valuenow="45" aria-valuetext="업로드 중 45%" style="width:220px;height:10px;background:#eee"></div>
<label><input type="radio" name="vis" value="public" checked> 공개</label>
<label><input type="radio" name="vis" value="private"> 비공개</label>
<select id="cat"><option>게임</option><option selected>교육</option></select>
<button id="pub" aria-disabled="true">게시</button>
<div id="host"></div>
<p id="log">클릭 없음</p>
<script>
  // 봇 탐지 흉내 — DOM 이 조작되면 즉시 카운트된다.
  window.__mut = { attr: 0, child: 0, attrNames: [] };
  new MutationObserver(function (recs) {
    for (var i = 0; i < recs.length; i++) {
      if (recs[i].type === 'attributes') { window.__mut.attr++; window.__mut.attrNames.push(recs[i].attributeName); }
      else window.__mut.child++;
    }
  }).observe(document.documentElement, { attributes: true, childList: true, subtree: true, attributeOldValue: false });

  // 타이핑 인간화 검증용 — 키 이벤트 시퀀스와 타건 간격을 기록한다.
  window.__keys = [];
  var cap = document.getElementById('cap');
  ['keydown', 'keypress', 'keyup', 'input'].forEach(function (t) {
    cap.addEventListener(t, function (e) { window.__keys.push({ t: t, k: e.key, at: performance.now() }); });
  });

  window.__clicked = [];
  document.getElementById('postA').addEventListener('click', function () { window.__clicked.push('A'); document.getElementById('log').textContent = 'A 클릭됨'; });
  document.getElementById('postB').addEventListener('click', function () { window.__clicked.push('B'); document.getElementById('log').textContent = 'B 클릭됨'; });

  // 열린 shadow DOM 안의 버튼(웹 컴포넌트) — 레지스트리 전환 후에도 관찰·클릭돼야 한다.
  var sr = document.getElementById('host').attachShadow({ mode: 'open' });
  var sb = document.createElement('button');
  sb.textContent = '쉐도우 버튼';
  sb.addEventListener('click', function () { window.__clicked.push('S'); });
  sr.appendChild(sb);

  // 가상 스크롤 재활용 흉내 — 같은 DOM 노드의 내용만 다른 게시물로 갈아끼운다.
  window.__recycle = function () { document.getElementById('postA').textContent = '게시물 Z 결제하기'; };
</script>
</body></html>`

function startPageServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(TEST_HTML)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }))
  })
}

// ── 앱 spawn/정리 ─────────────────────────────────────────────────────────
function seedProfile(dir) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    setup: { completed: true, completedAt: Date.now(), version: 'verify' }, startup: { mode: 'newtab', urls: [] },
  }, null, 2))
}
function launchApp(profileDir) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`], {
    env, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
  })
  child.stdout?.pipe(fs.createWriteStream(path.join(OUT, 'agent-safety-stdout.log')))
  child.stderr?.pipe(fs.createWriteStream(path.join(OUT, 'agent-safety-stderr.log')))
  return child
}
async function killApp(child, shell) {
  try { await shell?.send('Browser.close', {}, 3000).catch(() => {}) } catch { /* ignore */ }
  await sleep(800)
  if (child && child.exitCode === null) { try { child.kill() } catch { /* ignore */ }; try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']) } catch { /* ignore */ } }
}

const results = []
async function scenario(id, name, fn) {
  const t0 = Date.now()
  try { const detail = await fn(); results.push({ id, name, status: 'PASS', ms: Date.now() - t0, detail }); console.log(`  ✓ ${id} PASS — ${detail}`) }
  catch (err) { results.push({ id, name, status: 'FAIL', ms: Date.now() - t0, detail: err.message }); console.log(`  ✗ ${id} FAIL — ${err.message}`) }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  if (!fs.existsSync(EXE)) { console.error(`exe 없음: ${EXE} — 먼저 npx electron-builder --win --dir`); process.exit(2) }

  // 컴파일된 page-actions 를 그대로 쓴다(제품 코드 자체를 검증하는 것이 목적).
  const pa = require(path.join(REPO_ROOT, 'app', 'dist', 'main', 'features', 'ai', 'page-actions.js'))

  const { server, url: pageUrl } = await startPageServer()
  const profileDir = path.join(OUT, 'agent-safety-profile')
  seedProfile(profileDir)
  const child = launchApp(profileDir)
  let shell = null; let content = null

  try {
    const shellTarget = await pollUntil(async () => (await getTargetList(PORT)).find(isShellTarget) ?? null,
      { timeoutMs: 30000, intervalMs: 500, label: 'shell target' })
    shell = await connectSession(shellTarget, 'shell')
    const windowId = shellWindowId(shellTarget)

    const before = new Set((await getTargetList(PORT)).map((t) => t.id))
    await callApi(shell, 'tabs.create', [windowId, pageUrl])
    const contentTarget = await pollUntil(async () => {
      const l = await getTargetList(PORT)
      return l.find((t) => t.type === 'page' && !before.has(t.id) && typeof t.url === 'string' && t.url.startsWith(pageUrl)) ?? null
    }, { timeoutMs: 15000, intervalMs: 300, label: 'test page target' })
    content = await connectSession(contentTarget, 'content')
    await sleep(500)

    // 가짜 WebContents — page-actions 가 쓰는 표면만 구현해 CDP 로 실제 페이지에 위임한다.
    // sendInputEvent 는 CDP Input 도메인으로 매핑해, "사람처럼 조작" 경로(베지어 궤적·정규분포 착지점·
    // 가림 검사)까지 진짜 브라우저 입력으로 검증한다. WS 는 순서를 보장하므로 동기 enqueue 로 순서 유지.
    let inputChain = Promise.resolve()
    const enqueue = (method, params) => { inputChain = inputChain.then(() => content.send(method, params).catch(() => {})) }
    const fakeWc = {
      isDestroyed: () => false,
      getURL: () => pageUrl,
      focus: () => {},
      // 인페이지 대기(wait_for)는 최대 5분까지 걸릴 수 있으므로 CDP 응답 타임아웃을 넉넉히 준다
      // (기본 15초로 두면 제품이 아니라 하네스가 먼저 끊겨 오탐이 난다).
      executeJavaScript: async (code) => { await inputChain; return evaluate(content, code, { timeoutMs: 360000 }) },
      sendInputEvent: (e) => {
        if (e.type === 'mouseMove') enqueue('Input.dispatchMouseEvent', { type: 'mouseMoved', x: e.x, y: e.y, button: 'none' })
        else if (e.type === 'mouseDown') enqueue('Input.dispatchMouseEvent', { type: 'mousePressed', x: e.x, y: e.y, button: 'left', clickCount: e.clickCount ?? 1, buttons: 1 })
        else if (e.type === 'mouseUp') enqueue('Input.dispatchMouseEvent', { type: 'mouseReleased', x: e.x, y: e.y, button: 'left', clickCount: e.clickCount ?? 1, buttons: 0 })
        else if (e.type === 'char') enqueue('Input.dispatchKeyEvent', { type: 'char', text: e.keyCode })
        else if (e.type === 'keyDown') enqueue('Input.dispatchKeyEvent', { type: 'keyDown', key: e.keyCode === 'Return' ? 'Enter' : e.keyCode })
        else if (e.type === 'keyUp') enqueue('Input.dispatchKeyEvent', { type: 'keyUp', key: e.keyCode === 'Return' ? 'Enter' : e.keyCode })
      },
    }

    let obs = null
    await scenario('A1', '관찰이 DOM 을 전혀 수정하지 않음(봇 지문 제거)', async () => {
      await evaluate(content, 'window.__mut = { attr: 0, child: 0, attrNames: [] }, true')
      obs = await pa.observePage(fakeWc)
      if (!obs) throw new Error('관찰 실패(null)')
      await sleep(300) // MutationObserver 콜백은 마이크로태스크 뒤에 온다 — 충분히 기다린 뒤 센다
      const mut = await evaluate(content, 'JSON.stringify(window.__mut)')
      const m = JSON.parse(mut)
      const legacy = await evaluate(content, "document.querySelector('[data-bb-agent-ref]') ? 'FOUND' : 'none'")
      if (legacy !== 'none') throw new Error(`옛 지문 속성이 DOM 에 남음: ${legacy}`)
      if (m.attr !== 0) throw new Error(`DOM 속성 변경이 ${m.attr}건 감지됨(지문 노출): ${m.attrNames.join(',')}`)
      if (obs.elements.length < 3) throw new Error(`관찰된 요소가 너무 적음(${obs.elements.length}) — 회귀 의심`)
      return `요소 ${obs.elements.length}개 관찰, MutationObserver 감지 0건(속성 ${m.attr}·자식 ${m.child}), [data-bb-agent-ref] 없음`
    })

    await scenario('A2', '레지스트리 ref 로 정확한 요소 클릭(회귀 없음)', async () => {
      const target = obs.elements.find((e) => e.name.includes('게시물 A'))
      if (!target) throw new Error(`대상 요소를 관찰 목록에서 못 찾음: ${obs.elements.map((e) => e.name).join(' | ')}`)
      const r = await pa.executeInPageAction(fakeWc, { action: 'click', ref: target.ref }, { humanInput: false })
      if (!r.ok) throw new Error(`클릭 실패: ${r.detail}`)
      const clicked = JSON.parse(await evaluate(content, 'JSON.stringify(window.__clicked)'))
      if (clicked.join(',') !== 'A') throw new Error(`엉뚱한 요소가 클릭됨: [${clicked.join(',')}]`)
      const mut = JSON.parse(await evaluate(content, 'JSON.stringify(window.__mut)'))
      if (mut.attr !== 0) throw new Error(`클릭 과정에서 DOM 속성이 ${mut.attr}건 변경됨(지문 노출)`)
      return `ref ${target.ref}("${target.name}") 클릭 → 페이지가 A 클릭 확인, DOM 수정 0건 유지`
    })

    await scenario('A3', 'shadow DOM 안 요소도 관찰·클릭', async () => {
      const target = obs.elements.find((e) => e.name.includes('쉐도우'))
      if (!target) throw new Error(`shadow DOM 버튼이 관찰 목록에 없음: ${obs.elements.map((e) => e.name).join(' | ')}`)
      const r = await pa.executeInPageAction(fakeWc, { action: 'click', ref: target.ref }, { humanInput: false })
      if (!r.ok) throw new Error(`클릭 실패: ${r.detail}`)
      const clicked = JSON.parse(await evaluate(content, 'JSON.stringify(window.__clicked)'))
      if (!clicked.includes('S')) throw new Error(`shadow 버튼이 클릭되지 않음: [${clicked.join(',')}]`)
      return `shadow DOM 버튼 ref ${target.ref} 클릭 성공(레지스트리 전환 후에도 유지)`
    })

    await scenario('A4', '가상 스크롤 재활용 노드 오클릭 방어', async () => {
      const fresh = await pa.observePage(fakeWc)
      const target = fresh.elements.find((e) => e.name.includes('게시물 A'))
      if (!target) throw new Error('재관찰에서 게시물 A 를 못 찾음')
      // 관찰 직후 그 노드가 다른 게시물로 재활용된 상황(내용만 바뀜 — 인스타·페북 피드의 실제 동작)
      await evaluate(content, 'window.__recycle(), true')
      await evaluate(content, 'window.__clicked = [], true')
      const r = await pa.executeInPageAction(fakeWc, { action: 'click', ref: target.ref }, { humanInput: false })
      const clicked = JSON.parse(await evaluate(content, 'JSON.stringify(window.__clicked)'))
      if (clicked.length > 0) throw new Error(`내용이 바뀐 노드를 그대로 클릭함(오클릭): [${clicked.join(',')}]`)
      if (r.ok) throw new Error('클릭이 성공으로 보고됨 — 재관찰을 유도하지 못함')
      return `내용이 "게시물 Z 결제하기" 로 바뀐 노드 클릭 거부(${r.detail}) → 재관찰 유도`
    })
    await scenario('A5', '사람처럼 조작(실제 마우스 궤적·정규분포 착지점)으로 정확히 클릭', async () => {
      await evaluate(content, 'window.__clicked = [], true')
      const fresh = await pa.observePage(fakeWc)
      const target = fresh.elements.find((e) => e.name.includes('게시물 B'))
      if (!target) throw new Error('게시물 B 를 관찰 목록에서 못 찾음')
      const r = await pa.executeInPageAction(fakeWc, { action: 'click', ref: target.ref }, { humanInput: true })
      await sleep(300)
      const clicked = JSON.parse(await evaluate(content, 'JSON.stringify(window.__clicked)'))
      if (!r.ok) throw new Error(`클릭 실패: ${r.detail}`)
      if (clicked.join(',') !== 'B') throw new Error(`엉뚱한 곳이 클릭됨(착지점 오차가 과함): [${clicked.join(',')}] / ${r.detail}`)
      if (/합성 이벤트/.test(r.detail)) throw new Error(`실제 입력이 아니라 합성 폴백으로 처리됨: ${r.detail}`)
      return `실제 마우스 이동·클릭으로 게시물 B 정확히 적중 (${r.detail})`
    })

    await scenario('A6', '오버레이가 덮은 요소는 실제 클릭을 거부하고 폴백을 명시', async () => {
      await evaluate(content, 'window.__clicked = [], true')
      // A4 에서 재활용 흉내로 바꿔둔 라벨을 원복(이 시나리오는 가림만 검증한다).
      await evaluate(content, `(function(){document.getElementById('postA').textContent='게시물 A 좋아요';return true})()`)
      // 쿠키 배너·스티키 헤더가 버튼 위를 덮은 상황 — 좌표만 보고 누르면 엉뚱한 것이 눌린다.
      await evaluate(content, `(function(){var d=document.createElement('div');d.id='ov';d.style.cssText='position:fixed;left:0;top:0;right:0;height:400px;background:rgba(0,0,0,.2);z-index:9999';document.body.appendChild(d);return true})()`)
      const fresh = await pa.observePage(fakeWc)
      const target = fresh.elements.find((e) => e.name.includes('게시물 A'))
      if (!target) throw new Error('게시물 A 를 관찰 목록에서 못 찾음')
      const r = await pa.executeInPageAction(fakeWc, { action: 'click', ref: target.ref }, { humanInput: true })
      await evaluate(content, `(function(){var o=document.getElementById('ov');if(o)o.remove();return true})()`)
      if (!/합성 이벤트/.test(r.detail)) throw new Error(`가림을 감지하지 못하고 그대로 실제 클릭함: ${r.detail}`)
      return `가림 감지 → 실제 클릭 거부 후 합성 폴백을 명시 (${r.detail})`
    })
    await scenario('A7', '업로드 진행률·선택 상태를 관찰이 구조적으로 보고', async () => {
      const fresh = await pa.observePage(fakeWc)
      if (!fresh.progress || !/45/.test(fresh.progress)) throw new Error(`진행률을 관찰하지 못함: ${JSON.stringify(fresh.progress)}`)
      const pub = fresh.elements.find((e) => e.name.trim() === '게시')
      if (!pub) throw new Error('게시 버튼이 관찰 목록에 없음')
      if (pub.state !== 'disabled') throw new Error(`aria-disabled 게시 버튼을 활성으로 봄(state=${pub.state}) — 미완 상태 게시 위험`)
      const radios = fresh.elements.filter((e) => e.type === 'radio')
      const checked = radios.filter((e) => e.state === 'checked')
      const unchecked = radios.filter((e) => e.state === 'unchecked')
      if (checked.length !== 1 || unchecked.length !== 1) {
        throw new Error(`라디오 선택 상태가 안 보임: ${radios.map((r) => `${r.name}=${r.state}`).join(', ')}`)
      }
      const sel = fresh.elements.find((e) => e.tag === 'select')
      if (!sel || !/교육/.test(sel.value ?? '')) throw new Error(`드롭다운 현재값이 안 보임: ${JSON.stringify(sel?.value)}`)
      return `진행률("${fresh.progress}") · 게시버튼 비활성 · 라디오 선택(${checked[0].name.trim()}) · 드롭다운 현재값(${sel.value}) 모두 관찰됨`
    })
    await scenario('A8', '타이핑이 사람의 키 시퀀스·불규칙 간격을 따름', async () => {
      await evaluate(content, 'window.__keys = [], true')
      const fresh = await pa.observePage(fakeWc)
      const cap = fresh.elements.find((e) => e.name.includes('캡션'))
      if (!cap) throw new Error('캡션 입력칸을 관찰 목록에서 못 찾음')
      const r = await pa.executeInPageAction(fakeWc, { action: 'type', ref: cap.ref, text: 'hello world 2026', submit: false }, { humanInput: true })
      if (!r.ok) throw new Error(`입력 실패: ${r.detail}`)
      if (/합성 이벤트/.test(r.detail)) throw new Error(`실제 키 입력이 아니라 합성 폴백으로 처리됨: ${r.detail}`)
      const keys = JSON.parse(await evaluate(content, 'JSON.stringify(window.__keys)'))
      const val = await evaluate(content, 'document.getElementById("cap").value')
      if (val !== 'hello world 2026') throw new Error(`입력 결과가 다름: ${JSON.stringify(val)}`)
      const downs = keys.filter((k) => k.t === 'keydown').length
      const ups = keys.filter((k) => k.t === 'keyup').length
      if (downs < 10 || ups < 10) throw new Error(`keydown/keyup 이 없거나 부족(down=${downs}, up=${ups}) — char 만 보내면 비정상 신호`)
      // 타건 간격의 불규칙성 — 균등한 간격은 봇 신호다.
      const ins = keys.filter((k) => k.t === 'input').map((k) => k.at)
      const gaps = ins.slice(1).map((v, i) => v - ins[i]).filter((g) => g > 0)
      if (gaps.length < 8) throw new Error('간격 표본이 부족')
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
      const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length)
      if (sd / mean < 0.25) throw new Error(`타건 간격이 지나치게 균일(변동계수 ${(sd / mean).toFixed(2)}) — 봇 리듬`)
      return `keydown ${downs}·keyup ${ups} 완전 시퀀스, 간격 평균 ${mean.toFixed(0)}ms·변동계수 ${(sd / mean).toFixed(2)}, 값 정확`
    })

    await scenario('A9', '파일 업로드가 accept 로 올바른 입력을 고름(영상→썸네일 오첨부 방지)', async () => {
      const sample = path.join(OUT, 'agent-safety-sample.mp4')
      fs.writeFileSync(sample, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]))
      // 진짜 setFileInputFiles 를 돌린다 — Electron wc.debugger 대신 CDP 세션을 debugger 로 흉내낸다.
      const dbgShim = {
        isAttached: () => true,
        attach: () => {},
        detach: () => {},
        sendCommand: (method, params) => content.send(method, params ?? {}, 20000),
        on: (ev, fn) => { if (ev === 'message') content.events.push(fn) },
        off: (ev, fn) => { const i = content.events.indexOf(fn); if (i >= 0) content.events.splice(i, 1) },
      }
      const wcWithDbg = { ...fakeWc, debugger: dbgShim }
      const r = await pa.setFileInputFiles(wcWithDbg, [sample])
      if (!r.ok) throw new Error(`첨부 실패: ${r.detail}`)
      const landed = JSON.parse(await evaluate(content, `(function(){
        function f(id){ var e=document.getElementById(id); return e && e.files && e.files[0] ? e.files[0].name : null }
        return JSON.stringify({ video: f('video'), thumb: f('thumb') })
      })()`))
      if (landed.thumb) throw new Error(`영상이 썸네일 칸(accept=image/*)에 첨부됨: ${landed.thumb}`)
      if (!landed.video) throw new Error(`영상 입력에 파일이 들어가지 않음: ${JSON.stringify(landed)}`)
      return `mp4 가 accept="video/*" 입력에 첨부됨(썸네일 칸 비어 있음) — ${r.detail}`
    })

    await scenario('A10', '긴 대기(wait_for)가 60초 상한에 잘리지 않음', async () => {
      // 옛 상한(60초)이 남아 있으면 65초를 요청해도 60초에 끊긴다. 실제로 기다려 확인한다.
      const t0 = Date.now()
      const r = await pa.waitForOnPage(fakeWc, { text: '절대없는문구ZZZ', timeout: 65000 })
      const elapsed = Date.now() - t0
      if (r.ok) throw new Error('없는 문구인데 성공으로 보고')
      if (elapsed < 62000) throw new Error(`요청 65초인데 ${Math.round(elapsed / 1000)}초에 끊김 — 옛 60초 상한이 남아 있음`)
      return `65초 요청이 그대로 유지됨(${Math.round(elapsed / 1000)}초 뒤 종료) — 업로드·인코딩 대기 가능`
    })
    await scenario('A11', '파일 선택 창을 가로채 자동 첨부(OS 다이얼로그 갇힘 방지)', async () => {
      const sample = path.join(OUT, 'agent-safety-sample.mp4')
      // 드롭존형 UI 흉내 — 파일 입력이 화면에 없고, 버튼을 눌러야 그때 input.click() 이 일어난다.
      await evaluate(content, `(function(){
        document.getElementById('video').remove(); document.getElementById('thumb').remove();
        var b = document.createElement('button'); b.id='pick'; b.textContent='컴퓨터에서 선택';
        b.onclick = function(){ var i=document.createElement('input'); i.type='file'; i.id='late';
          i.onchange=function(){ window.__lateFile = i.files[0] ? i.files[0].name : null }; document.body.appendChild(i); i.click(); };
        document.body.appendChild(b); return true })()`)
      const dbgShim = {
        isAttached: () => true, attach: () => {}, detach: () => {},
        sendCommand: (method, params) => content.send(method, params ?? {}, 20000),
        on: (ev, fn) => { if (ev === 'message') content.events.push(fn) },
        off: (ev, fn) => { const i = content.events.indexOf(fn); if (i >= 0) content.events.splice(i, 1) },
      }
      const wcWithDbg = { ...fakeWc, debugger: dbgShim }
      // 첨부 시도 → 입력이 없으니 실패해야 하고, 그때 가로채기를 무장한다(제품 흐름과 동일).
      const first = await pa.setFileInputFiles(wcWithDbg, [sample])
      if (first.ok) throw new Error('파일 입력이 없는데 첨부 성공으로 보고')
      if (!/찾지 못했습니다/.test(first.detail)) throw new Error(`예상과 다른 실패 사유: ${first.detail}`)
      const armed = pa.armFileChooser(wcWithDbg, [sample], 20000)
      await sleep(400)
      await evaluate(content, 'document.getElementById("pick").click(), true')
      const res = await armed
      if (!res.ok) throw new Error(`가로채기 실패: ${res.detail}`)
      const landed = await evaluate(content, 'window.__lateFile || null')
      if (!landed) throw new Error('가로채기는 됐지만 파일이 입력에 들어가지 않음')
      return `버튼 클릭 시 OS 파일 창 대신 자동 첨부됨(${landed}) — ${res.detail}`
    })
    await scenario('A12', '순수 드롭존(DataTransfer)에 파일 드래그&드롭 업로드', async () => {
      const sample = path.join(OUT, 'agent-safety-sample.mp4')
      // 파일 입력도 파일 선택 창도 없이 오직 ondrop 으로만 파일을 받는 UI(틱톡식 드롭존).
      await evaluate(content, `(function(){
        var z=document.createElement('div'); z.id='zone'; z.textContent='여기에 파일을 끌어다 놓으세요';
        z.style.cssText='width:320px;height:120px;border:2px dashed #888;display:flex;align-items:center;justify-content:center';
        z.addEventListener('dragover', function(e){ e.preventDefault() });
        z.addEventListener('drop', function(e){ e.preventDefault();
          var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
          window.__dropped = f ? { name: f.name, size: f.size } : null; });
        document.body.appendChild(z); window.__dropped = undefined; return true })()`)
      const dbgShim = {
        isAttached: () => true, attach: () => {}, detach: () => {},
        sendCommand: (method, params) => content.send(method, params ?? {}, 20000),
        on: () => {}, off: () => {},
      }
      const wcWithDbg = { ...fakeWc, debugger: dbgShim }
      const fresh = await pa.observePage(wcWithDbg)
      const zone = fresh.elements.find((e) => e.name.includes('끌어다'))
      if (!zone) throw new Error(`드롭존이 관찰 목록에 없음: ${fresh.elements.map((e) => e.name).join(' | ')}`)
      const r = await pa.dropFilesOnRef(wcWithDbg, zone.ref, [sample])
      if (!r.ok) throw new Error(`드롭 실패: ${r.detail}`)
      await sleep(300)
      const dropped = JSON.parse(await evaluate(content, 'JSON.stringify(window.__dropped ?? null)'))
      if (!dropped) throw new Error('드롭 이벤트는 갔지만 페이지가 파일을 받지 못함(DataTransfer.files 비어 있음)')
      if (!/\.mp4$/.test(dropped.name)) throw new Error(`엉뚱한 파일이 전달됨: ${JSON.stringify(dropped)}`)
      return `드롭존이 파일을 실제로 수신(${dropped.name}, ${dropped.size}바이트) — 파일 입력 없는 UI 업로드 가능`
    })
    await scenario('A13', '문구 없는 아이콘 드롭존도 인식(오탐 없이)', async () => {
      await evaluate(content, `(function(){
        var z=document.getElementById('zone'); if(z) z.remove();
        // ① 문구 없이 아이콘만 있는 드롭존(class 로만 알 수 있음)
        var a=document.createElement('div'); a.className='upload-dropzone'; a.innerHTML='<span>⬆</span>';
        a.style.cssText='width:300px;height:100px;border:1px solid #ccc';
        // ② 숨은 file input 을 품은 래퍼(문구·클래스 없음)
        var b=document.createElement('div'); b.id='wrap'; b.style.cssText='width:300px;height:100px;border:1px solid #ccc';
        b.innerHTML='<span>📁</span><input type="file" style="display:none">';
        // ③ 오탐 함정 — "dropdown" 은 드롭존이 아니다
        var c=document.createElement('div'); c.className='menu-dropdown'; c.textContent='메뉴';
        c.style.cssText='width:300px;height:100px;border:1px solid #ccc';
        document.body.appendChild(a); document.body.appendChild(b); document.body.appendChild(c); return true })()`)
      const fresh = await pa.observePage(fakeWc)
      const zones = fresh.elements.filter((e) => e.type === 'dropzone')
      if (zones.length < 2) throw new Error(`아이콘 드롭존을 못 찾음(발견 ${zones.length}개): ${fresh.elements.map((e) => `${e.type}:${e.name}`).join(' | ')}`)
      if (zones.some((z) => /dropdown|메뉴/.test(z.name))) throw new Error(`dropdown 을 드롭존으로 오인: ${zones.map((z) => z.name).join(', ')}`)
      return `문구 없는 드롭존 ${zones.length}개 인식(${zones.map((z) => z.name.slice(0, 24)).join(' / ')}), dropdown 오탐 없음`
    })
    await scenario('A14', '빠른 프로파일(일반 사이트)에서도 클릭·입력 정확도 유지', async () => {
      // 속도를 얻자고 정확도를 잃으면 의미가 없다 — fast 프로파일로 20회 연속 클릭/입력해 전부 맞는지 본다.
      const FAST = pa.inputProfileFor('https://example.com/', 'auto')
      const STRICT = pa.inputProfileFor('https://instagram.com/', 'auto')
      if (FAST === STRICT) throw new Error('일반 사이트인데 strict 프로파일이 선택됨(사이트 판정 오류)')
      await evaluate(content, 'window.__clicked = [], true')
      let clicks = 0
      for (let i = 0; i < 10; i++) {
        const o = await pa.observePage(fakeWc)
        const t = o.elements.find((e) => e.name.includes('게시물 B'))
        if (!t) throw new Error('대상 없음')
        const r = await pa.executeInPageAction(fakeWc, { action: 'click', ref: t.ref }, { humanInput: true, profile: FAST })
        if (!r.ok) throw new Error(`${i + 1}번째 클릭 실패: ${r.detail}`)
        if (/합성 이벤트/.test(r.detail)) throw new Error(`${i + 1}번째가 합성 폴백으로 떨어짐: ${r.detail}`)
        clicks++
      }
      await sleep(200)
      const clicked = JSON.parse(await evaluate(content, 'JSON.stringify(window.__clicked)'))
      const wrong = clicked.filter((c) => c !== 'B').length
      if (clicked.length !== clicks || wrong > 0) {
        throw new Error(`빠른 클릭 정확도 실패: 시도 ${clicks}, 도달 ${clicked.length}, 오클릭 ${wrong}`)
      }
      const o2 = await pa.observePage(fakeWc)
      const cap = o2.elements.find((e) => e.name.includes('캡션'))
      const txt = '빠른 입력 정확도 확인 abc 123'
      const tr = await pa.executeInPageAction(fakeWc, { action: 'type', ref: cap.ref, text: txt }, { humanInput: true, profile: FAST })
      if (!tr.ok) throw new Error(`빠른 입력 실패: ${tr.detail}`)
      const val = await evaluate(content, 'document.getElementById("cap").value')
      if (val !== txt) throw new Error(`빠른 입력 값 불일치: ${JSON.stringify(val)}`)
      return `빠른 프로파일 클릭 ${clicks}/10 정확(오클릭 0) + 입력 값 정확 — 속도를 얻고도 정확도 유지`
    })
  } finally {
    try { server.close() } catch { /* ignore */ }
    try { content?.close() } catch { /* ignore */ }
    await killApp(child, shell)
    try { shell?.close() } catch { /* ignore */ }
  }

  console.log('\n===== verify-agent-safety 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 이름: r.name, 상태: r.status, ms: r.ms })))
  const failed = results.filter((r) => r.status !== 'PASS')
  for (const f of failed) console.log(`FAIL ${f.id}: ${f.detail}`)
  fs.writeFileSync(path.join(OUT, 'agent-safety-results.json'), JSON.stringify(results, null, 2))
  console.log(`PASS=${results.length - failed.length} FAIL=${failed.length} (총 ${results.length})`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify-agent-safety] 치명적 오류:', err); process.exit(3) })
