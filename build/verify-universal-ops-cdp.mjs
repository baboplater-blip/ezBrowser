#!/usr/bin/env node
// verify-universal-ops-cdp.mjs — AI 에이전트의 "범용 조작"(사이트별 스크립트 없이 되는 조작)을
// 결정론적으로 검증한다. `.auto-dev/verification.md` B 섹션 U1~U10 과 1:1 대응.
//
// 구조는 verify-agent-safety-cdp.mjs 와 동일한 패턴을 따른다: packaged ezBrowser 를 CDP 로 구동하고,
// 컴파일된 app/dist/main/features/ai/page-actions.js 를 Node 에서 직접 require 해 "CDP 로 실제 페이지에
// 위임하는 가짜 WebContents" 를 넘긴다. 여러 탭을 다뤄야 해서(U1/U2/U5/U6/U7/U8 은 허브 탭 하나를 계속
// 쓰고, U3 는 전용 탭, U4 는 탭 2개) 가짜 wc 팩토리를 탭마다 하나씩 만든다.
//
// LLM 은 대부분 쓰지 않는다 — page-actions.ts 의 export 함수를 직접 호출해 결과를 실측한다.
// 예외는 U9(비전 미지원 통지) 하나뿐이다 — 이건 agent.ts 의 에이전트 루프 안에서만 나오는 이벤트라
// 각본대로만 답하는 가짜 LLM(lib/fake-llm.mjs, Ollama 호환)을 띄워 실제로 `ai.agentStart` 를 돌린다.
//
// 사용: node build/verify-universal-ops-cdp.mjs [--port <n>] [--out <dir>] [--keep-profile]

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import {
  CDPSession,
  connectSession,
  connectShellSessionReady,
  ensureSessionReady,
  getTargetList,
  isShellTarget,
  pollUntil,
  sleep,
  waitForPortFree,
} from './lib/cdp.mjs'
import { preferFreePort, getFreePorts } from './lib/ports.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { startUniversalOpsServer } from './universal-ops-server.mjs'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9284, out: path.join(REPO_ROOT, 'verify-out', 'universal-ops'), keepProfile: false }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--keep-profile') args.keepProfile = true
}

// ── 결과 수집 ────────────────────────────────────────────────────────────
const results = []
function record(id, status, detail) {
  results.push({ id, status, detail })
  const tag = status === 'PASS' ? '✓ PASS' : status === 'GAP' ? '△ GAP ' : '✗ FAIL'
  console.log(`  ${tag} ${id} — ${detail}`)
}
async function scenario(id, fn) {
  try {
    const r = await fn()
    if (r && typeof r === 'object' && 'status' in r) record(id, r.status, r.detail)
    else record(id, 'PASS', String(r))
  } catch (err) {
    record(id, 'FAIL', err?.message ?? String(err))
  }
}

// ── CDP 헬퍼 ────────────────────────────────────────────────────────────
async function evaluate(session, expression, opts = {}) {
  const { awaitPromise = true, returnByValue = true, timeoutMs = 15000 } = opts
  const r = await session.send('Runtime.evaluate', { expression, awaitPromise, returnByValue, userGesture: true }, timeoutMs)
  if (r.exceptionDetails) throw new Error(`JS exception in ${session.label}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`)
  return r.result?.value
}
const lit = (a) => (a === undefined ? 'undefined' : JSON.stringify(a))
const callApi = (session, apiPath, args = []) => evaluate(session, `window.browserAPI.${apiPath}(${args.map(lit).join(', ')})`)
const shellWindowId = (t) => { try { return new URL(t.url).searchParams.get('windowId') } catch { return null } }

// 가짜 WebContents — page-actions 가 쓰는 표면만 구현해 CDP 로 실제 페이지에 위임한다.
// verify-agent-safety-cdp.mjs 의 fakeWc 와 동일 패턴(사람처럼 조작 경로까지 진짜 입력으로 검증).
function makeFakeWc(pageUrl, contentSession, tabIdNum) {
  let inputChain = Promise.resolve()
  const enqueue = (method, params) => { inputChain = inputChain.then(() => contentSession.send(method, params).catch(() => {})) }
  const dbgShim = {
    isAttached: () => true,
    attach: () => {},
    detach: () => {},
    sendCommand: (method, params) => contentSession.send(method, params ?? {}, 20000),
    on: (ev, fn) => { if (ev === 'message') contentSession.events.push(fn) },
    off: (ev, fn) => { const i = contentSession.events.indexOf(fn); if (i >= 0) contentSession.events.splice(i, 1) },
  }
  return {
    id: tabIdNum,
    isDestroyed: () => false,
    getURL: () => pageUrl,
    focus: () => {},
    debugger: dbgShim,
    executeJavaScript: async (code) => { await inputChain; return evaluate(contentSession, code, { timeoutMs: 360000 }) },
    sendInputEvent: (e) => {
      if (e.type === 'mouseMove') enqueue('Input.dispatchMouseEvent', { type: 'mouseMoved', x: e.x, y: e.y, button: 'none' })
      else if (e.type === 'mouseDown') enqueue('Input.dispatchMouseEvent', { type: 'mousePressed', x: e.x, y: e.y, button: 'left', clickCount: e.clickCount ?? 1, buttons: 1 })
      else if (e.type === 'mouseUp') enqueue('Input.dispatchMouseEvent', { type: 'mouseReleased', x: e.x, y: e.y, button: 'left', clickCount: e.clickCount ?? 1, buttons: 0 })
      else if (e.type === 'char') enqueue('Input.dispatchKeyEvent', { type: 'char', text: e.keyCode })
      else if (e.type === 'keyDown') enqueue('Input.dispatchKeyEvent', keyEventParams('keyDown', e))
      else if (e.type === 'keyUp') enqueue('Input.dispatchKeyEvent', keyEventParams('keyUp', e))
    },
  }
}
// Ctrl+A 같은 브라우저 기본 편집 단축키는 CDP 가 `key` 문자열만으로는 인식하지 못하고,
// Chromium 이 내부적으로 windowsVirtualKeyCode 로 edit-command(SelectAll 등)를 찾는다.
// (실측: VK 코드 없이 보내면 keydown 은 도착하지만 selectionStart/End 가 그대로 0/0 — 선택이 전혀 안 됨.)
const VK_MAP = {} // 'a'..'z' → 65..90, '0'..'9' → 48..57 (미국 키보드 배열 기준, Chromium 표준)
for (let c = 0; c < 26; c++) VK_MAP[String.fromCharCode(97 + c)] = 65 + c
for (let d = 0; d < 10; d++) VK_MAP[String(d)] = 48 + d
// page-actions.ts 의 KEY_ALIAS 가 매핑하는 이름 있는 키들 — pressKey('Delete') 로 실제 선택 영역을
// 지우는 것까지 검증하려면 이 키들도 VK 코드가 필요하다.
const NAMED_VK = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32, Up: 38, Down: 40, Left: 37, Right: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34 }
const NAMED_CODE = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', Space: 'Space', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' }
function keyEventParams(type, e) {
  const key = e.keyCode === 'Return' ? 'Enter' : e.keyCode
  const params = { type, key, modifiers: modifierBits(e.modifiers) }
  const low = String(key).toLowerCase()
  if (VK_MAP[low] != null) {
    params.windowsVirtualKeyCode = VK_MAP[low]
    params.nativeVirtualKeyCode = VK_MAP[low]
    params.code = /^[0-9]$/.test(low) ? `Digit${low}` : `Key${low.toUpperCase()}`
  } else if (NAMED_VK[key] != null) {
    params.windowsVirtualKeyCode = NAMED_VK[key]
    params.nativeVirtualKeyCode = NAMED_VK[key]
    params.code = NAMED_CODE[key]
  }
  return params
}
function modifierBits(mods) {
  if (!mods || !mods.length) return 0
  let bits = 0
  for (const m of mods) {
    if (m === 'control') bits |= 2
    else if (m === 'shift') bits |= 8
    else if (m === 'alt') bits |= 1
    else if (m === 'meta') bits |= 4
  }
  return bits
}

let tabCounter = 1000
async function openContentTab(shell, windowId, port, url) {
  const before = new Set((await getTargetList(port)).map((t) => t.id))
  const tab = await callApi(shell, 'tabs.create', [windowId, url])
  const target = await pollUntil(async () => {
    const l = await getTargetList(port)
    return l.find((t) => t.type === 'page' && !before.has(t.id) && typeof t.url === 'string' && t.url.startsWith(url)) ?? null
  }, { timeoutMs: 15000, intervalMs: 300, label: `content target for ${url}` })
  const session = await connectSession(target, `content-${tab.id}`)
  await ensureSessionReady(session)
  await sleep(300)
  tabCounter += 1
  const fakeWc = makeFakeWc(url, session, tabCounter)
  return { tabId: tab.id, session, fakeWc }
}
async function closeContentTab(shell, tab) {
  try { await tab.session?.close() } catch { /* ignore */ }
  try { await callApi(shell, 'tabs.close', [tab.tabId]) } catch { /* ignore */ }
}

// ── 앱 spawn/정리 ─────────────────────────────────────────────────────────
function seedProfile(dir) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    setup: { completed: true, completedAt: Date.now(), version: 'verify' },
    startup: { mode: 'newtab', urls: [] },
    adblock: { enabled: false },
  }, null, 2))
}
function launchApp(profileDir, port) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`], {
    env, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
  })
  fs.mkdirSync(args.out, { recursive: true })
  child.stdout?.pipe(fs.createWriteStream(path.join(args.out, 'app-stdout.log')))
  child.stderr?.pipe(fs.createWriteStream(path.join(args.out, 'app-stderr.log')))
  return child
}
async function killApp(child, shell) {
  try { await shell?.send('Browser.close', {}, 3000).catch(() => {}) } catch { /* ignore */ }
  await sleep(800)
  if (child && child.exitCode === null) {
    try { child.kill() } catch { /* ignore */ }
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']) } catch { /* ignore */ }
  }
}

// 요소의 화면상 퍼센트 좌표(중심) — click_at/scroll 시험에 쓴다. click_at 자체는 스크롤을 하지 않는
// "지금 보이는 화면"을 좌표로 찍는 도구이므로(비전으로 화면을 본 뒤 쓰는 것을 흉내낸다), 여기서 먼저
// scrollIntoView 로 요소를 화면 안에 넣고 나서 퍼센트를 잰다(그러지 않으면 페이지가 길 때 요소가
// 뷰포트 밖에 있어 100%를 넘는 좌표가 나오고, "화면 밖" 거부 경로와 뒤섞여 버린다).
async function elementCenterPct(session, selector) {
  const r = await evaluate(session, `(function(){
    var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    var r = el.getBoundingClientRect();
    return { xPct: (r.left + r.width / 2) / window.innerWidth * 100, yPct: (r.top + r.height / 2) / window.innerHeight * 100 };
  })()`)
  return r
}

// ── 메인 ────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(args.out, { recursive: true })
  if (!fs.existsSync(EXE)) { console.error(`exe 없음: ${EXE} — 먼저 npm run build && npx electron-builder --win --dir`); process.exit(2) }

  const pa = require(path.join(REPO_ROOT, 'app', 'dist', 'main', 'features', 'ai', 'page-actions.js'))

  const srv = await startUniversalOpsServer({})
  const profileDir = path.join(args.out, 'profile')
  seedProfile(profileDir)

  args.port = await preferFreePort(args.port, 'verify-universal-ops-cdp.mjs')
  if (!(await waitForPortFree(args.port))) {
    throw new Error(`디버그 포트 ${args.port} 가 이미 사용 중입니다 — 남은 인스턴스를 종료하세요.`)
  }

  const child = launchApp(profileDir, args.port)
  let shell = null

  // ===== 정적 검사(브라우저 무관) — U10, 언제 돌려도 결과가 같다. U9 는 실제 에이전트 루프를
  // 돌려야 해서(가짜 LLM 필요) 아래 앱 구동 이후로 옮겼다. =====
  await scenario('U10', () => checkU10CaptchaHandoff())

  try {
    shell = await connectShellSessionReady(args.port)
    const shellTarget = (await getTargetList(args.port)).find(isShellTarget)
    const windowId = shellWindowId(shellTarget)

    // ── 허브 탭(U1·U2·U5·U6·U7·U8 이 공유) ──────────────────────────────
    const hub = await openContentTab(shell, windowId, args.port, srv.urls.hub)

    let hubObs = await pa.observePage(hub.fakeWc)
    if (!hubObs) throw new Error('허브 관찰 실패(null)')

    // ===== U1: cross-origin iframe — 접근 불가를 "정직하게" 보고하는가 =====
    await scenario('U1', async () => {
      const list = hubObs.crossOriginFrames ?? []
      const reported = list.some((s) => /frameB-ops|frameB\.html/.test(s))
      const leakedAsElement = hubObs.elements.some((e) => e.name.includes('프레임B'))
      if (leakedAsElement) {
        return { status: 'FAIL', detail: `cross-origin 버튼이 [조작 가능한 요소] 목록에 새어 들어옴(관찰 정확성 결함): ${hubObs.elements.find((e) => e.name.includes('프레임B')).name}` }
      }
      if (!reported) {
        return { status: 'FAIL', detail: `cross-origin iframe 이 crossOriginFrames 로 보고되지 않음(조용히 누락) — 목록: ${JSON.stringify(list)}` }
      }
      return { status: 'PASS', detail: `cross-origin iframe 안은 관찰 불가(Same-Origin Policy, 구조적 제약)이지만 crossOriginFrames=${JSON.stringify(list)} 로 정직하게 보고됨. 가짜 요소로 새지 않음` }
    })

    // ===== U2: open/closed shadow DOM =====
    await scenario('U2', async () => {
      const openEl = hubObs.elements.find((e) => e.name.includes('쉐도우 열림'))
      const closedEl = hubObs.elements.find((e) => e.name.includes('쉐도우 닫힘'))
      if (!openEl) return { status: 'FAIL', detail: `open shadow 버튼이 관찰 목록에 없음(회귀): ${hubObs.elements.map((e) => e.name).join(' | ')}` }
      if (closedEl) return { status: 'FAIL', detail: `closed shadow 버튼이 관찰됨 — 있으면 안 됨(닫힌 shadow root 는 구조적으로 접근 불가해야 함)` }
      const r = await pa.executeInPageAction(hub.fakeWc, { action: 'click', ref: openEl.ref }, { humanInput: true, epoch: hubObs.epoch })
      if (!r.ok) return { status: 'FAIL', detail: `open shadow 버튼 클릭 실패: ${r.detail}` }
      const clicked = await evaluate(hub.session, 'window.__ops.openShadowClicked === true')
      if (!clicked) return { status: 'FAIL', detail: `클릭은 ok 였지만 페이지 상태(openShadowClicked)가 안 바뀜` }
      return { status: 'PASS', detail: `open shadow 버튼 관찰·클릭 성공(${r.detail}), closed shadow 는 관찰 목록에 없음(구조적으로 불가)` }
    })

    // 재관찰(U1·U2 에서 DOM 자체는 안 바뀌었지만, 다음 단계들은 새 epoch 로 진행 — 실제 에이전트 루프와 동일한 습관)
    hubObs = await pa.observePage(hub.fakeWc)

    // ===== U5: window.open 으로 열린 새 탭 인지 =====
    await scenario('U5', async () => {
      const before = await callApi(shell, 'tabs.list', [windowId])
      const target = hubObs.elements.find((e) => e.name.includes('새창 열기'))
      if (!target) return { status: 'FAIL', detail: '새창 열기 버튼을 관찰 목록에서 못 찾음' }
      const r = await pa.executeInPageAction(hub.fakeWc, { action: 'click', ref: target.ref }, { humanInput: true, epoch: hubObs.epoch })
      if (!r.ok) return { status: 'FAIL', detail: `새창 열기 클릭 실패: ${r.detail}` }
      const found = await pollUntil(async () => {
        const list = await callApi(shell, 'tabs.list', [windowId])
        return list.find((t) => !before.some((b) => b.id === t.id) && t.url.includes('/page2')) ?? null
      }, { timeoutMs: 10000, intervalMs: 300, label: 'window.open 새 탭' }).catch(() => null)
      if (!found) return { status: 'FAIL', detail: 'window.open 으로 연 새 탭이 tabs.list 에 안 잡힘(놓침)' }
      // 정리
      await callApi(shell, 'tabs.close', [found.id]).catch(() => {})
      return { status: 'PASS', detail: `window.open 이 새 탭(id=${found.id}, url=${found.url})으로 즉시 인지됨 → 전환 가능` }
    })

    hubObs = await pa.observePage(hub.fakeWc)

    // ===== U6: 파일 업로드 3경로 + 자료 폴더 경계(정적 확인) =====
    await scenario('U6', async () => {
      const sample = path.join(args.out, `ops-sample-${srv.runId}.mp4`)
      fs.writeFileSync(sample, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 0x6d, 0x70, 0x34, 0x32]))
      try {
        const notes = []

        // 경로 1: input[type=file] accept 일치
        const r1 = await pa.setFileInputFiles(hub.fakeWc, [sample])
        const landed1 = await evaluate(hub.session, `(function(){ var e=document.getElementById('fileIn'); return e && e.files && e.files[0] ? e.files[0].name : null })()`)
        if (!r1.ok || !landed1) return { status: 'FAIL', detail: `경로1(input accept) 실패: ok=${r1.ok} detail=${r1.detail} landed=${landed1}` }
        notes.push(`경로1(input accept) OK — ${landed1}`)

        // 경로 2: 드롭존(dropFilesOnRef)
        const obs2 = await pa.observePage(hub.fakeWc)
        // "드롭존"으로 잡히는 컨테이너가 여러 개일 수 있다(파일 입력을 품은 section 도 byInput 신호로
        // 잡힌다 — 이건 제품이 의도한 신호다). 우리가 시험하려는 건 문구로 안내하는 진짜 드롭존이므로
        // 이름으로 정확히 골라야 한다(첫 매치를 덥석 쓰면 엉뚱한 컨테이너를 집게 된다).
        const dropzones = obs2.elements.filter((e) => e.type === 'dropzone')
        const zone = dropzones.find((e) => e.name.includes('끌어다'))
        if (!zone) return { status: 'FAIL', detail: `안내 문구가 있는 드롭존을 관찰 목록에서 못 찾음(발견된 dropzone 타입: ${dropzones.map((e) => e.name).join(' | ')})` }
        const r2 = await pa.dropFilesOnRef(hub.fakeWc, zone.ref, [sample], obs2.epoch)
        await sleep(300)
        const dropped = await evaluate(hub.session, 'JSON.stringify(window.__ops.dropped ?? null)')
        const droppedObj = JSON.parse(dropped)
        if (!r2.ok || !droppedObj) return { status: 'FAIL', detail: `경로2(드롭존) 실패: ok=${r2.ok} detail=${r2.detail} dropped=${dropped}` }
        notes.push(`경로2(드롭존) OK — ${droppedObj.name}`)

        // 경로 3: 파일 선택 창 가로채기(armFileChooser) — 버튼을 눌러야 창이 뜬다
        const armed = pa.armFileChooser(hub.fakeWc, [sample], 20000)
        await sleep(300)
        await evaluate(hub.session, "document.getElementById('pickBtn').click(), true")
        const r3 = await armed
        const landed3 = await evaluate(hub.session, 'window.__ops.lateFile || null')
        if (!r3.ok || !landed3) return { status: 'FAIL', detail: `경로3(파일선택창 가로채기) 실패: ok=${r3.ok} detail=${r3.detail} landed=${landed3}` }
        notes.push(`경로3(파일선택창 가로채기) OK — ${landed3}(${r3.detail})`)

        // 자료 폴더 밖 파일 거부 — 정적 확인(agent-files.ts 의 경계 코드 + agent.ts 의 배선).
        // page-actions.ts 의 setFileInputFiles/dropFilesOnRef/armFileChooser 는 "이미 해석된 절대경로"만
        // 받는다(위에서 확인한 대로) — 이름→경로 해석과 폴더 경계는 그 한 단계 위(agent.ts 의 upload_file
        // 핸들러)에서 일어나므로, 여기서는 소스를 읽어 그 경계 코드가 실재하고 실제로 배선돼 있는지 확인한다.
        const boundary = checkAgentFilesBoundary()
        if (boundary.status !== 'PASS') return boundary
        notes.push(boundary.detail)

        return { status: 'PASS', detail: notes.join(' / ') }
      } finally {
        try { fs.unlinkSync(sample) } catch { /* 실패 경로에서도 시험용 파일은 남기지 않는다 */ }
      }
    })

    hubObs = await pa.observePage(hub.fakeWc)

    // ===== U7: 다운로드 링크 클릭 → 실제 저장 =====
    await scenario('U7', async () => {
      const link = hubObs.elements.find((e) => e.name.includes('파일 다운로드'))
      if (!link) return { status: 'FAIL', detail: '다운로드 링크가 관찰 목록에 없음' }
      const beforeDl = await callApi(shell, 'downloads.list', [])
      const beforeIds = new Set(beforeDl.map((d) => d.id))
      const r = await pa.executeInPageAction(hub.fakeWc, { action: 'click', ref: link.ref }, { humanInput: true, epoch: hubObs.epoch })
      if (!r.ok) return { status: 'FAIL', detail: `다운로드 링크 클릭 실패: ${r.detail}` }
      let entry
      try {
        entry = await pollUntil(async () => {
          const list = await callApi(shell, 'downloads.list', [])
          const found = list.find((d) => !beforeIds.has(d.id) && d.url === srv.urls.dl)
          if (found && (found.state === 'done' || found.state === 'failed' || found.state === 'cancelled')) return found
          return null
        }, { timeoutMs: 20000, label: 'U7 다운로드 완료 대기' })
      } catch (err) {
        const snap = await callApi(shell, 'downloads.list', []).catch(() => [])
        const stuck = snap.find((d) => !beforeIds.has(d.id) && d.url === srv.urls.dl)
        if (stuck) { await callApi(shell, 'downloads.cancel', [stuck.id]).catch(() => {}); if (stuck.savePath) { try { fs.unlinkSync(stuck.savePath) } catch { /* ignore */ } } }
        return { status: 'FAIL', detail: `${err.message} — 스냅샷: ${JSON.stringify(snap)}` }
      }
      if (entry.state !== 'done') return { status: 'FAIL', detail: `다운로드 실패 state=${entry.state} error=${entry.error ?? ''}` }
      let match = false; let sizeInfo = ''
      try {
        const buf = fs.readFileSync(entry.savePath)
        sizeInfo = `${buf.length}/${srv.dlBuf.length}`
        match = buf.length === srv.dlBuf.length && buf.equals(srv.dlBuf)
      } finally {
        try { fs.unlinkSync(entry.savePath) } catch { /* 실사용자 폴더 오염 방지 best-effort */ }
      }
      if (!match) return { status: 'FAIL', detail: `다운로드 파일 바이트 불일치(${sizeInfo}) savePath=${entry.savePath}` }
      return { status: 'PASS', detail: `클릭으로 다운로드 완료(${sizeInfo} bytes, 일치) savePath=${entry.savePath}(검증 후 삭제)` }
    })

    hubObs = await pa.observePage(hub.fakeWc)

    // ===== U8: 좌표 클릭·키보드 조합·컨테이너 내부 스크롤 + 화면 밖 좌표 거부 =====
    await scenario('U8', async () => {
      const notes = []
      // click_at: 캔버스(DOM 요소 목록엔 없는 대상)를 좌표로 클릭
      const canvasPct = await elementCenterPct(hub.session, '#canvas')
      if (!canvasPct) return { status: 'FAIL', detail: '#canvas 좌표 계산 실패' }
      const rClick = await pa.executeInPageAction(hub.fakeWc, { action: 'click_at', xPct: canvasPct.xPct, yPct: canvasPct.yPct }, { humanInput: true })
      const canvasClicked = await evaluate(hub.session, 'window.__ops.canvasClicked === true')
      if (!rClick.ok || !canvasClicked) return { status: 'FAIL', detail: `click_at 캔버스 실패: ok=${rClick.ok} detail=${rClick.detail} canvasClicked=${canvasClicked}` }
      notes.push(`click_at(캔버스) OK — ${rClick.detail}`)

      // 화면 밖 좌표(150%) 는 거부돼야 한다(clamp 금지)
      const rOut = await pa.executeInPageAction(hub.fakeWc, { action: 'click_at', xPct: 150, yPct: 50 }, { humanInput: true })
      if (rOut.ok) return { status: 'FAIL', detail: `화면 밖 좌표(150%)가 거부되지 않고 실행됨: ${rOut.detail}` }
      if (!/화면 밖/.test(rOut.detail)) return { status: 'FAIL', detail: `화면 밖 좌표 거부는 됐지만 사유 문구가 다름: ${rOut.detail}` }
      notes.push(`화면 밖 좌표(150%) 거부 확인 — ${rOut.detail}`)

      // 키보드 조합: Ctrl+A(전체선택) 후 Delete → 입력칸이 비어야 함
      const obsK = await pa.observePage(hub.fakeWc)
      const keyEl = obsK.elements.find((e) => e.tag === 'input' && (e.value ?? '').includes('select-me'))
      if (!keyEl) return { status: 'FAIL', detail: `키보드 시험 입력칸을 관찰 목록에서 못 찾음: ${obsK.elements.map((e) => `${e.tag}:${e.value ?? e.name}`).join(' | ')}` }
      const before = await evaluate(hub.session, "document.getElementById('keyIn').value")
      const rSel = await pa.pressKey(hub.fakeWc, { key: 'Control+a', ref: keyEl.ref }, obsK.epoch)
      // CDP 로 보낸 keydown 이 Chromium 의 SelectAll 편집 명령으로 처리되는 데는 약간의 지연이 있다 —
      // 곧바로 Delete 를 보내면 선택이 아직 안 잡힌 채로 지워져 경합이 난다(실측: sleep 없이 0% 재현율).
      await sleep(250)
      const rDel = await pa.pressKey(hub.fakeWc, { key: 'Delete' })
      await sleep(200)
      const after = await evaluate(hub.session, "document.getElementById('keyIn').value")
      if (!rSel.ok || !rDel.ok) return { status: 'FAIL', detail: `키 입력 실패: sel=${rSel.detail} del=${rDel.detail}` }
      if (before === after || after !== '') return { status: 'FAIL', detail: `Ctrl+A→Delete 로 값이 안 지워짐: before="${before}" after="${after}"` }
      notes.push(`Ctrl+A→Delete 로 입력칸 값 "${before}" → "" 확인`)

      // 컨테이너 내부 스크롤: scroll 액션에 좌표를 주면 그 지점의 스크롤 가능한 조상이 스크롤됨(페이지 자체는 안 움직임)
      const boxPct = await elementCenterPct(hub.session, '#scrollBox')
      if (!boxPct) return { status: 'FAIL', detail: '#scrollBox 좌표 계산 실패' }
      const beforeScrollTop = await evaluate(hub.session, "document.getElementById('scrollBox').scrollTop")
      const beforeWinY = await evaluate(hub.session, 'window.scrollY')
      const rScroll = await pa.executeInPageAction(hub.fakeWc, { action: 'scroll', xPct: boxPct.xPct, yPct: boxPct.yPct, direction: 'down' }, { humanInput: true })
      const afterScrollTop = await evaluate(hub.session, "document.getElementById('scrollBox').scrollTop")
      const afterWinY = await evaluate(hub.session, 'window.scrollY')
      if (!rScroll.ok) return { status: 'FAIL', detail: `scroll 액션 실패: ${rScroll.detail}` }
      if (afterScrollTop <= beforeScrollTop) return { status: 'FAIL', detail: `컨테이너가 스크롤되지 않음(scrollTop ${beforeScrollTop}→${afterScrollTop}), detail=${rScroll.detail}` }
      notes.push(`컨테이너 내부 스크롤 OK — scrollTop ${beforeScrollTop}→${afterScrollTop}(윈도우 자체 스크롤 ${beforeWinY}→${afterWinY}), detail=${rScroll.detail}`)

      return { status: 'PASS', detail: notes.join(' / ') }
    })

    await closeContentTab(shell, hub)

    // ===== U3: SPA 재렌더 후 stale ref 거부 + epoch 검출력 음성 대조 =====
    await scenario('U3', async () => {
      const t = await openContentTab(shell, windowId, args.port, srv.urls.rerender)
      try {
        const obs1 = await pa.observePage(t.fakeWc)
        const target = obs1.elements.find((e) => e.name.includes('항목 A'))
        if (!target) throw new Error(`재렌더 대상 버튼을 못 찾음: ${obs1.elements.map((e) => e.name).join(' | ')}`)
        const epoch1 = obs1.epoch

        // 재렌더 트리거 — DOM 을 통째로 교체(옛 노드 destroy, 이름도 완전히 다름)
        await evaluate(t.session, "document.getElementById('rerenderBtn').click(), true")
        await sleep(200)

        // ① 실제 검사(제품 코드가 실제로 거부하는가): epoch1(재관찰 없이 여전히 유효한 세대) + 옛 ref
        //    → 노드가 detach 됐고 이름도 달라 재연결도 실패해야 한다("stale").
        const rMain = await pa.executeInPageAction(t.fakeWc, { action: 'click', ref: target.ref }, { humanInput: false, epoch: epoch1 })
        const clickedAfterMain = JSON.parse(await evaluate(t.session, 'JSON.stringify(window.__clicked)'))
        if (rMain.ok || clickedAfterMain.length > 0) {
          return { status: 'FAIL', detail: `재렌더 후 옛 ref 클릭이 거부되지 않음: ok=${rMain.ok} detail=${rMain.detail} clicked=${JSON.stringify(clickedAfterMain)}` }
        }

        // ② 음성 대조(검출력 확인) — "epoch 를 일부러 (현재) 맞는 값으로 넘기면 거부되지 않는다"를 직접 보인다.
        //    재관찰(새 epoch2, 새 레지스트리)을 하고, 그 유효한 epoch2 를 "옛 ref 번호"와 잘못 짝지어 호출한다.
        //    이 페이지는 상호작용 요소가 하나뿐이라 재렌더 전후 ref 번호가 결정론적으로 같다(둘 다 0) —
        //    그래서 epoch2(유효)+ref0(옛 것) 조합은 pick() 입장에서 "지금 레지스트리의 0번" 을 그냥 돌려주고,
        //    그건 새로 생긴(의미가 전혀 다른) 버튼이다. epoch 를 제대로 짝짓지 않으면 이렇게 새어 나간다는
        //    증거이며, ①이 그 실수를 하지 않기 때문에 PASS 한다는 것을 보여준다.
        const obs2 = await pa.observePage(t.fakeWc)
        const epoch2 = obs2.epoch
        const rNeg = await pa.executeInPageAction(t.fakeWc, { action: 'click', ref: target.ref }, { humanInput: false, epoch: epoch2 })
        const clickedAfterNeg = JSON.parse(await evaluate(t.session, 'JSON.stringify(window.__clicked)'))
        const negDemonstrated = rNeg.ok === true && clickedAfterNeg.includes('new')

        return {
          status: 'PASS',
          detail: `실제 판정: epoch1+옛ref → 거부(${rMain.detail}), 클릭 0건(PASS 조건 충족). `
            + `음성대조: 재관찰로 얻은 유효 epoch2 를 옛 ref 번호와 잘못 짝지으면 ${negDemonstrated ? '거부되지 않고 새 버튼이 클릭됨(검출력 실증)' : `여전히 거부됨(detail=${rNeg.detail}) — 이 구성에서는 추가 방어가 있었음, 참고용`}`,
        }
      } finally {
        await closeContentTab(shell, t)
      }
    })

    // ===== U4: 탭 전환 후 옛 ref 가 다른 탭에서 먹히지 않는가 + epoch 생략 음성 대조 =====
    await scenario('U4', async () => {
      const a = await openContentTab(shell, windowId, args.port, srv.urls.tabA)
      const b = await openContentTab(shell, windowId, args.port, srv.urls.tabB)
      try {
        const obsA = await pa.observePage(a.fakeWc)
        const obsB = await pa.observePage(b.fakeWc)
        const refA = obsA.elements.find((e) => e.name.includes('게시물 A'))
        const refB = obsB.elements.find((e) => e.name.includes('결제하기'))
        if (!refA || !refB) throw new Error(`탭 요소를 못 찾음: A=${JSON.stringify(obsA.elements)} B=${JSON.stringify(obsB.elements)}`)

        // ① 실제 검사: 탭B 의 wc 에 탭A 의 (ref, epoch) 를 그대로 써서 클릭 시도 → 거부돼야 한다.
        const rMain = await pa.executeInPageAction(b.fakeWc, { action: 'click', ref: refA.ref }, { humanInput: false, epoch: obsA.epoch })
        const clickedBAfterMain = await evaluate(b.session, 'window.__clicked === true')
        if (rMain.ok || clickedBAfterMain) {
          return { status: 'FAIL', detail: `탭A 의 ref+epoch 로 탭B 의 "결제하기" 가 실행됨(격리 실패): ok=${rMain.ok} detail=${rMain.detail} clicked=${clickedBAfterMain}` }
        }

        // ② 음성 대조: epoch 를 아예 생략(opts.epoch undefined)하면 세대 검사가 스킵된다(하위호환 경로) —
        //    탭B 자신의 레지스트리 0번(="결제하기")이 그대로 눌려야 한다. 이게 실제로 눌리는 걸 보여줘야
        //    ①이 "epoch 를 제대로 넘겨서" 막혔다는 것(우연이 아니라)이 증명된다.
        const rNeg = await pa.executeInPageAction(b.fakeWc, { action: 'click', ref: refA.ref }, { humanInput: false })
        const clickedBAfterNeg = await evaluate(b.session, 'window.__clicked === true')
        const negDemonstrated = rNeg.ok === true && clickedBAfterNeg === true

        return {
          status: 'PASS',
          detail: `실제 판정: 탭A epoch 로 탭B 클릭 시도 → 거부(${rMain.detail}), 탭B "결제하기" 미클릭(PASS 조건 충족). `
            + `음성대조: epoch 를 생략하면 ${negDemonstrated ? '탭B 자신의 0번("결제하기")이 그대로 눌림(검출력 실증 — epoch 가 실제 방어선임)' : `그래도 안 눌림(detail=${rNeg.detail}) — 참고용`}`,
        }
      } finally {
        await closeContentTab(shell, a)
        await closeContentTab(shell, b)
      }
    })

    // ===== U9: 비전 미지원 모델에서 "명확히 안내"하는가(에이전트 루프 실제 구동, 가짜 LLM) =====
    await scenario('U9', () => checkU9VisionNotice(shell, windowId, args.port, srv.urls.page2))
  } finally {
    await killApp(child, shell)
    try { shell?.close() } catch { /* ignore */ }
    await srv.close()
    if (!args.keepProfile) { try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch { /* ignore */ } }
  }

  console.log('\n===== verify-universal-ops 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status, 상세: r.detail.slice(0, 140) })))
  const fail = results.filter((r) => r.status === 'FAIL')
  const gap = results.filter((r) => r.status === 'GAP')
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  for (const g of gap) console.log(`GAP  ${g.id}: ${g.detail}`)
  fs.mkdirSync(args.out, { recursive: true })
  fs.writeFileSync(path.join(args.out, 'universal-ops-results.json'), JSON.stringify({
    results, pass: results.length - fail.length - gap.length, fail: fail.length, gap: gap.length,
  }, null, 2))
  console.log(`PASS=${results.length - fail.length - gap.length} FAIL=${fail.length} GAP=${gap.length} (총 ${results.length})`)
  process.exit(fail.length ? 1 : 0)
}

// ── U9: 비전 미지원 안내 — 실제 에이전트 루프를 가짜 LLM 으로 구동해 통지 이벤트를 실측한다 ──
//
// 2026-09-18: 처음엔 코드 검사만으로 GAP(런타임 통지를 못 찾음)을 보고했는데, 그게 실제 제품 갭이었고
// 팀이 방금 agent.ts 에 고쳤다(emit({type:'start'}) 직후 result 이벤트로 통지). 이제 실제로 그 이벤트가
// 오는지 — 그리고 agentVision='off' 일 때는 오지 않는지(음성 대조) — 진짜로 에이전트를 돌려서 본다.
//
// 모델명을 추측하지 않는다 — supportsVision('ollama', model) 의 판정 기준은 providers.ts 의
// OLLAMA_VISION_MODELS 정규식(소스에서 직접 확인: llava|vision|-vl\b|qwen2.5-vl|minicpm-v|moondream|
// bakllava|gemma3|llama-4|pixtral|granite3.2-vision)이고, 'test-model' 은 이 중 아무 것과도 매치되지
// 않으므로 확실히 비전 미지원이다.
async function checkU9VisionNotice(shell, windowId, port, pageUrl) {
  const [llmPort] = await getFreePorts(1)
  const llm = await startFakeLlm({ port: llmPort, script: [{ reply: () => '{"action":"done","message":"끝"}' }] })
  const tab = await openContentTab(shell, windowId, port, pageUrl)
  try {
    await callApi(shell, 'settings.set', ['ai.enabled', true])
    await callApi(shell, 'settings.set', ['ai.provider', 'ollama'])
    await callApi(shell, 'settings.set', ['ai.ollamaUrl', llm.url])
    await callApi(shell, 'settings.set', ['ai.ollamaModel', 'test-model'])
    await callApi(shell, 'settings.set', ['ai.agentMaxSteps', 4])
    await callApi(shell, 'settings.set', ['ai.agentAutoApprove', false])
    await callApi(shell, 'settings.set', ['ai.agentHumanInput', false])

    async function runOnce(reqId, visionMode) {
      await callApi(shell, 'settings.set', ['ai.agentVision', visionMode])
      // reqId 별로 수신 배열을 분리해 두 실행(on/off)이 서로 섞이지 않게 한다.
      await evaluate(shell, `(function(){
        window.__u9 = window.__u9 || {}; window.__u9[${JSON.stringify(reqId)}] = [];
        window.browserAPI.ai.onAgentEvent(function (e) { if (e.reqId === ${JSON.stringify(reqId)}) window.__u9[${JSON.stringify(reqId)}].push(e) });
        return true;
      })()`)
      await callApi(shell, 'ai.agentStart', [{ reqId, tabId: tab.tabId, task: '아무 것도 하지 말고 바로 완료했다고 보고하세요.' }])
      // done 뿐 아니라 error/cancelled/exhausted(단계 소진 — done 과 별개 종료 상태) 도 종료로 본다.
      return pollUntil(async () => {
        const list = JSON.parse(await evaluate(shell, `JSON.stringify(window.__u9[${JSON.stringify(reqId)}] ?? [])`))
        if (list.some((e) => ['done', 'error', 'cancelled', 'exhausted'].includes(e.type))) return list
        return null
      }, { timeoutMs: 20000, intervalMs: 300, label: `U9 에이전트 종료 대기(${reqId})` })
    }

    const evsOn = await runOnce(`u9-on-${Date.now()}`, 'auto')
    const idx = evsOn.findIndex((e) => e.type === 'result' && e.label === '화면 인식 사용 안 함')
    const noticeNearStart = idx >= 0 && idx <= 2 // emit({type:'start'}) 바로 다음 자리
    const detailOk = idx >= 0 && /설정\s*>\s*AI|이미지를 읽/.test(evsOn[idx].detail ?? '')

    const evsOff = await runOnce(`u9-off-${Date.now()}`, 'off')
    const noticeAbsentWhenOff = !evsOff.some((e) => e.type === 'result' && e.label === '화면 인식 사용 안 함')

    if (!noticeNearStart) {
      return { status: 'FAIL', detail: `agentVision='auto'+ollama/test-model(비전 미지원)인데 통지가 없거나 늦게 옴(idx=${idx}): ${JSON.stringify(evsOn.map((e) => `${e.type}${e.label ? ':' + e.label : ''}`))}` }
    }
    if (!detailOk) return { status: 'FAIL', detail: `통지는 왔지만(idx=${idx}) 설정 안내 문구가 없음: "${evsOn[idx].detail}"` }
    if (!noticeAbsentWhenOff) {
      return { status: 'FAIL', detail: `agentVision='off' 인데도 통지가 뜸(음성 대조 실패, 오탐): ${JSON.stringify(evsOff.filter((e) => e.type === 'result').map((e) => e.label))}` }
    }
    return {
      status: 'PASS',
      detail: `agentVision='auto' + ollama/test-model(비전 미지원, providers.ts 의 OLLAMA_VISION_MODELS 로 확인)에서 `
        + `result 이벤트(label="화면 인식 사용 안 함")가 start 직후(idx=${idx}) 발생, detail="${evsOn[idx].detail.slice(0, 60)}…"에 설정 안내 포함. `
        + `음성대조: agentVision='off' 로 같은 조건 재실행 시 통지 없음(오탐 0) — 두 방향 모두 확인`,
    }
  } finally {
    await closeContentTab(shell, tab)
    await llm.close()
  }
}

// ── U10: 로그인/CAPTCHA — 코드 확인만(우회 코드 추가 금지) ─────────────────
function checkU10CaptchaHandoff() {
  const dir = path.join(REPO_ROOT, 'app', 'main', 'features', 'ai')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))
  const combined = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
  // ① 우회·지문은폐 코드가 없어야 한다(이건 절대 추가하면 안 되는 것 — 준수 확인).
  const bypassHit = /2captcha|anti-?captcha|captcha[-_]?solver|solve[-_]?captcha|recaptcha[-_]?bypass|captcha[-_]?bypass/i.exec(combined)
  if (bypassHit) return { status: 'FAIL', detail: `CAPTCHA 우회/솔버로 보이는 코드 발견(추가돼선 안 됨): "${bypassHit[0]}"` }
  // ② CAPTCHA 전용 감지기는 없지만, 진전 없는 반복을 감지해 사용자에게 넘기는 범용 메커니즘이 있는지 확인
  //    (agent.ts 의 STUCK_REPEAT/ask 경로 — 로그인/CAPTCHA 로 막혔을 때도 이 경로로 사용자에게 넘어간다).
  const agentPath = path.join(REPO_ROOT, 'app', 'main', 'features', 'ai', 'agent.ts')
  const agentSrc = fs.readFileSync(agentPath, 'utf8')
  const hasStuckAsk = /STUCK_REPEAT/.test(agentSrc) && /type:\s*'ask'/.test(agentSrc) && /같은 동작.*반복했는데 진전이 없습니다/.test(agentSrc)
  if (!hasStuckAsk) {
    return { status: 'FAIL', detail: '막힘→사용자에게 묻는 범용 경로(STUCK_REPEAT/ask)를 agent.ts 에서 못 찾음(회귀 의심)' }
  }
  return {
    status: 'GAP',
    detail: 'CAPTCHA/로그인 우회·지문은폐 코드 없음(준수 확인, grep 0건). '
      + 'CAPTCHA 전용 감지기는 없으나, 진전 없는 반복(STUCK_REPEAT=3)을 감지해 emit({type:"ask"}) 로 사용자에게 넘기고 '
      + '답변을 받아 이어가는 범용 메커니즘은 실재(agent.ts) — CAPTCHA로 막힌 흐름도 결국 이 경로로 수렴할 것으로 보이나, '
      + 'CAPTCHA 를 특정해 즉시 감지하는 전용 로직은 아니므로 e2e 로 실증하지 않고 정직히 GAP 으로 보고.',
  }
}

// ── U6 하위 검사: agent-files.ts 의 폴더 경계 + agent.ts 배선 확인(정적) ──────
function checkAgentFilesBoundary() {
  const afPath = path.join(REPO_ROOT, 'app', 'main', 'features', 'ai', 'agent-files.ts')
  const agentPath = path.join(REPO_ROOT, 'app', 'main', 'features', 'ai', 'agent.ts')
  if (!fs.existsSync(afPath)) return { status: 'FAIL', detail: 'agent-files.ts 없음' }
  const af = fs.readFileSync(afPath, 'utf8')
  const agent = fs.readFileSync(agentPath, 'utf8')

  const rejectsAbsolute = /path\.isAbsolute\(raw\)\)\s*return\s*null/.test(af)
  const containmentCheck = /rel\.startsWith\(['"]\.\.['"]\)/.test(af)
  const realpathUsed = /realpathSync/.test(af)
  if (!rejectsAbsolute || !containmentCheck || !realpathUsed) {
    return { status: 'FAIL', detail: `agent-files.ts 경계 코드 미확인: absolute거부=${rejectsAbsolute} 포함검사=${containmentCheck} realpath=${realpathUsed}` }
  }
  // 배선 확인 — agent.ts 의 upload_file 핸들러가 실제로 resolveAgentFile 을 부르고 null 이면 거부하는가.
  const wired = /resolveAgentFile\(wanted\)/.test(agent) && /if\s*\(resolved\)/.test(agent) && /자료 폴더에 '.*'\s*없음|자료 폴더에.*없습니다/.test(agent)
  if (!wired) {
    return { status: 'FAIL', detail: 'agent-files.ts 의 경계 코드는 있으나 agent.ts 의 upload_file 핸들러 배선을 확인 못 함(죽은 코드 의심)' }
  }
  return {
    status: 'PASS',
    detail: '자료 폴더 밖 파일 거부(정적 확인): agent-files.ts 가 절대경로 거부 + realpath 포함검사 보유, '
      + 'agent.ts 의 upload_file 핸들러가 resolveAgentFile() 결과가 null 이면 명시 거부(라이브 e2e 는 verify-agent-loop-cdp.mjs 의 F1~F3 가 이미 커버)',
  }
}

main().catch((err) => { console.error('[verify-universal-ops] 치명적 오류:', err); process.exit(3) })
