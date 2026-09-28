#!/usr/bin/env node
// verify-tab-engine-cdp.mjs — 묶음 A(탭 엔진) 검증
//
// 무엇을 검증하는가 (2026-09-28, 묶음 A):
//   T1 명시적 크기의 window.open() → 실제 자식 BrowserWindow 로 열리고(탭 수 불변) opener↔child
//      postMessage 가 오간다 (OAuth/PG 팝업이 window.opener 를 쓰는 것과 동일한 조건)
//   T2 크기 지정 없는 window.open()(일반 target=_blank) → 기존대로 새 탭 (탭 수 +1) ← 부정 대조
//   T3 로드 실패(did-fail-load) → browser://error 로 대체, 원래 주소·재시도 버튼 표시
//   T4 HTML5 전체화면 — 트러스티드 클릭으로 진입(document.fullscreenElement 생김) →
//      Esc 키(트러스티드)로 종료(document.fullscreenElement 사라짐)
//   T5 beforeunload 없는 탭은 평소처럼 바로 닫힌다 ← 부정 대조(과도하게 묻지 않는지)
//   T6 captureTab() 이 JPEG data URL 을 돌려준다(PNG 아님 — 축소+재인코딩 확인)
//   T7 백그라운드 탭 슬립(discard) 후에도 captureTab() 이 슬립 직전 썸네일(JPEG)을 돌려준다
//   T8(맨 마지막) beforeunload 를 막는 탭을 닫으면 다이얼로그 확인 전까지 탭이 그대로 남는다
//      — 네이티브 다이얼로그를 자동으로 누를 수는 없으므로 "즉시 닫히지 않는다"만 확인하고,
//      이후 테스트 없이 바로 프로세스를 강제 종료한다(메인 스레드가 다이얼로그로 막혀 있어도
//      OS 프로세스 종료는 항상 가능).
//
// 사용: node build/verify-tab-engine-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectSession, getTargetList, waitForPortFree, connectShellSessionReady,
  waitForTargetByUrlPredicate, sleep,
} from './lib/cdp.mjs'
import { preferFreePort } from './lib/ports.mjs'
import { startTabEngineFixture } from './tab-engine-fixture-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9281, out: path.join(REPO, 'verify-out', 'tab-engine') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const results = []
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}

async function evalIn(s, expression, awaitPromise = false) {
  // 다른 lane 들도 동시에 electron 을 띄워 CDP 왕복이 느려질 수 있다 — 기본 15초보다 넉넉히 준다.
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, 35000)
  if (r.result?.exceptionDetails) {
    throw new Error(`evaluate 예외: ${JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails)}`)
  }
  return r.result?.result?.value ?? r.result?.value
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE} — 먼저 npx electron-builder --win --dir`)
  fs.mkdirSync(args.out, { recursive: true })
  args.port = await preferFreePort(args.port, 'verify-tab-engine-cdp.mjs')
  await waitForPortFree(args.port)

  const fx = await startTabEngineFixture()

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true },
    startup: { mode: 'newtab', urls: [] },
    adblock: { enabled: false },
    // tab-sleep/index.ts 의 idleThresholdMs() 가 1분 미만 값은 무시하고 기본(30분)으로 되돌아간다
    // (사용자가 실수로 0 분을 넣는 것을 막는 하한선) — 그래서 검증도 최소값인 1분을 그대로 쓴다.
    performance: { tabSleepEnabled: true, tabSleepMinutes: 1 },
  }, null, 2))

  const logStream = fs.createWriteStream(path.join(args.out, 'app.log'))
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')

    const tabCount = async () => {
      const raw = await evalIn(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)}).then(t => t.length)`, true)
      return Number(raw)
    }
    const createTab = async (url) => {
      const raw = await evalIn(shell,
        `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(url)}).then(t => t.id)`, true)
      return String(raw)
    }
    const contentSessionFor = async (urlPrefix, timeoutMs = 15000) => {
      const target = await waitForTargetByUrlPredicate(args.port, (u) => u.startsWith(urlPrefix), `content:${urlPrefix}`, timeoutMs)
      const s = await connectSession(target, urlPrefix)
      return s
    }

    // ───────────────────────────── T1/T2 — 팝업 vs 일반 탭 ─────────────────────────────
    {
      const before = await tabCount()
      const openerTabId = await createTab(fx.urls.popupOpener)
      await sleep(600)
      const openerSession = await contentSessionFor(fx.urls.popupOpener)

      // T1: 크기 지정 팝업 — 실제 자식 창(탭 수 불변) + opener/child postMessage 왕복
      await evalIn(openerSession, 'window.__openSized(); true')
      let childSession = null
      try {
        const childTarget = await waitForTargetByUrlPredicate(args.port, (u) => u.startsWith(fx.urls.popupChild), 'popup-child', 10000)
        childSession = await connectSession(childTarget, 'popup-child')
      } catch (err) {
        check('T1', '크기 지정 팝업 → 실제 자식 창 + opener↔child 통신', false, `자식 창 타깃을 못 찾음: ${err.message}`)
      }
      if (childSession) {
        await sleep(400)
        const isChild = await evalIn(childSession, 'window.__isPopupChild === true')
        const afterSized = await tabCount()
        await sleep(300)
        const gotMsg = await evalIn(openerSession, 'window.__childMsg')
        check('T1', '크기 지정 팝업 → 실제 자식 창(탭 수 불변) + opener↔child 통신',
          isChild && afterSized === before + 1 /* 오프너 탭 1개만 추가, 팝업은 탭 아님 */ && gotMsg === 'hello-from-child',
          `child로드=${isChild} · 탭수 before=${before} openerCreate후=${afterSized}(기대 ${before + 1}) · 부모수신="${gotMsg}"`)
      }

      // T2 — 부정 대조: 크기 지정 없는 window.open → 기존대로 새 탭(탭 수 증가)
      const beforePlain = await tabCount()
      await evalIn(openerSession, 'window.__openPlain(); true')
      await sleep(1000)
      const afterPlain = await tabCount()
      check('T2', '크기 없는 window.open → 새 탭(부정 대조, 팝업 아님)', afterPlain === beforePlain + 1,
        `탭수 before=${beforePlain} after=${afterPlain}(기대 ${beforePlain + 1})`)
    }

    // ───────────────────────────── T3 — 로드 실패 → 오류 페이지 ─────────────────────────────
    {
      // 열려 있지 않은 로컬 포트로 접속 시도 → ERR_CONNECTION_REFUSED 결정적 재현
      const deadPort = fx.origin.match(/:(\d+)$/)[1] // 살아있는 fixture 포트를 재활용하지 않도록 근처에서 하나 뺀다
      const deadUrl = `http://127.0.0.1:${Number(deadPort) === 1 ? 2 : Number(deadPort) - 1}/nope`
      const tabId = await createTab(deadUrl)
      let errUrl = null
      for (let i = 0; i < 40; i++) {
        const list = JSON.parse(await evalIn(shell,
          `window.browserAPI.tabs.list(${JSON.stringify(windowId)}).then(l => JSON.stringify(l))`, true) ?? '[]')
        const t = list.find((x) => x.id === tabId)
        if (t && String(t.url).startsWith('browser://error')) { errUrl = t.url; break }
        await sleep(250)
      }
      let pageOk = false
      let bodyDesc = ''
      if (errUrl) {
        try {
          const errSession = await contentSessionFor('browser://error', 15000)
          await sleep(800)
          bodyDesc = await evalIn(errSession, 'document.getElementById("url")?.textContent ?? ""')
          const hasRetry = await evalIn(errSession, '!!document.getElementById("retry")')
          const kind = new URL(errUrl).searchParams.get('kind')
          pageOk = hasRetry && bodyDesc.includes(deadUrl.replace(/\/nope$/, '')) && kind === 'load-fail'
        } catch (err) { bodyDesc = `오류 페이지 세션 연결 실패: ${err.message}` }
      }
      check('T3', '로드 실패 → browser://error(재시도 버튼 + 원래 주소)', !!errUrl && pageOk,
        `errUrl=${errUrl ?? '(없음)'} · 표시된 주소="${bodyDesc}"`)
      await evalIn(shell, `window.browserAPI.tabs.close(${JSON.stringify(tabId)})`, true).catch(() => {})
    }

    // ───────────────────────────── T4 — HTML5 전체화면 ─────────────────────────────
    {
      const tabId = await createTab(fx.urls.fullscreen)
      await sleep(1200)
      const fsSession = await contentSessionFor(fx.urls.fullscreen)

      // 트러스티드 클릭(Input.dispatchMouseEvent) — JS 합성 클릭은 requestFullscreen 을 거부당한다.
      // 클릭 타이밍이 간헐적으로 늦게 반영될 수 있어 성공할 때까지 몇 번 재시도한다.
      let enteredFs = false
      for (let i = 0; i < 4 && !enteredFs; i++) {
        await fsSession.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 60, y: 40, button: 'left', clickCount: 1, buttons: 1 })
        await fsSession.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 60, y: 40, button: 'left', clickCount: 1, buttons: 0 })
        for (let j = 0; j < 10 && !enteredFs; j++) {
          await sleep(300)
          enteredFs = await evalIn(fsSession, '!!document.fullscreenElement')
        }
      }

      let leftFs = false
      if (enteredFs) {
        for (let i = 0; i < 4 && !leftFs; i++) {
          await fsSession.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' })
          await fsSession.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape' })
          for (let j = 0; j < 10 && !leftFs; j++) {
            await sleep(300)
            leftFs = !(await evalIn(fsSession, '!!document.fullscreenElement'))
          }
        }
      }
      check('T4', 'HTML5 전체화면 진입(트러스티드 클릭) → Esc 로 종료', enteredFs && leftFs,
        `진입=${enteredFs} · Esc후종료=${leftFs}`)
      await evalIn(shell, `window.browserAPI.tabs.close(${JSON.stringify(tabId)})`, true).catch(() => {})
    }

    // ───────────────────────────── T5 — beforeunload 없음(부정 대조: 과도한 확인 없음) ─────────────────────────────
    {
      const before = await tabCount()
      const tabId = await createTab(fx.urls.noop)
      await sleep(500)
      await evalIn(shell, `window.browserAPI.tabs.close(${JSON.stringify(tabId)})`, true)
      let closed = false
      for (let i = 0; i < 20; i++) {
        if (await tabCount() === before) { closed = true; break }
        await sleep(200)
      }
      check('T5', 'beforeunload 리스너가 막지 않으면 즉시 닫힘(부정 대조)', closed, `2초 내 닫힘=${closed}`)
    }

    // ───────────────────────────── T6 — 썸네일이 JPEG data URL ─────────────────────────────
    {
      const tabId = await createTab(fx.urls.plain)
      await sleep(3000) // 이 검증 환경에서 capturePage() 가 간헐적으로 "표면 준비 안 됨" — 넉넉히 대기
      const shot = await evalIn(shell, `window.browserAPI.tabs.capture(${JSON.stringify(tabId)})`, true)
      const ok = typeof shot === 'string' && shot.startsWith('data:image/jpeg;base64,') && shot.length > 100
      check('T6', 'captureTab() → 축소+JPEG data URL(PNG 아님)', ok, `앞부분="${String(shot).slice(0, 40)}…" 길이=${String(shot).length}`)
      await evalIn(shell, `window.browserAPI.tabs.close(${JSON.stringify(tabId)})`, true).catch(() => {})
    }

    // ───────────────────────────── T7 — 슬립 직전 썸네일 보존 ─────────────────────────────
    {
      // 실사용과 같은 순서로 만든다 — "한 번도 안 보인 배경 탭"(background:true) 은 애초에 찍을
      // 화면이 없어 캡처가 늘 실패한다(Chromium 이 보인 적 없는 뷰를 합성하지 않음). 그래서 이 탭을
      // 먼저 **활성**으로 만들어 실제로 한 번 렌더링시킨 뒤, 다른 탭을 활성화해 자연스럽게 비활성으로 보낸다.
      const bgTabId = await createTab(fx.urls.plain)
      await sleep(1200) // 렌더링을 마칠 시간(캡처할 화면이 있어야 함)
      const activeTabId = await createTab(fx.urls.plain) // 활성화되며 bgTabId 는 비활성(invisible) 으로 전환
      await sleep(600)
      // idleThresholdMs() 는 1분 미만 설정을 무시하므로(하한선), 슬립 임계값(1분)을 실제로 넘긴다.
      await sleep(64000)
      // browser://memory 는 internalAPI.system.sweepTabSleep 을 노출한다.
      const memTabId = await createTab('browser://memory')
      await sleep(700)
      const memSession = await contentSessionFor('browser://memory', 8000)
      await evalIn(memSession, 'window.internalAPI.system.sweepTabSleep()', true).catch(() => {})
      await sleep(400)

      let discarded = false
      for (let i = 0; i < 20; i++) {
        const list = JSON.parse(await evalIn(shell,
          `window.browserAPI.tabs.list(${JSON.stringify(windowId)}).then(l => JSON.stringify(l))`, true) ?? '[]')
        const t = list.find((x) => x.id === bgTabId)
        if (t?.discarded) { discarded = true; break }
        await sleep(200)
      }
      const shot = discarded
        ? await evalIn(shell, `window.browserAPI.tabs.capture(${JSON.stringify(bgTabId)})`, true)
        : null
      const shotOk = typeof shot === 'string' && shot.startsWith('data:image/jpeg;base64,') && shot.length > 100
      check('T7', '슬립(discard)된 탭도 captureTab() 이 슬립 직전 JPEG 썸네일을 돌려줌',
        discarded && shotOk, `discarded=${discarded} · 썸네일길이=${String(shot ?? '').length}`)

      await evalIn(shell, `window.browserAPI.tabs.close(${JSON.stringify(memTabId)})`, true).catch(() => {})
      await evalIn(shell, `window.browserAPI.tabs.close(${JSON.stringify(bgTabId)})`, true).catch(() => {})
      await evalIn(shell, `window.browserAPI.tabs.close(${JSON.stringify(activeTabId)})`, true).catch(() => {})
    }
  } finally {
    try { await shell?.send('Browser.close', {}) } catch { /* ignore */ }
    await sleep(800)
    try { child.kill() } catch { /* ignore */ }
    try { logStream.end() } catch { /* ignore */ }
  }

  // ───────────────────────────── T8 — beforeunload 확인 게이트 (별도 새 인스턴스) ─────────────────────────────
  // T7 뒤(약 70초 경과 시점)에 이어서 돌리면 같은 인스턴스에서 CDP 왕복이 간헐적으로 15초 넘게
  // 걸리는 현상을 겪었다(원인 미확정 — 제품 로그엔 오류 없음, T1~T7 단독으로는 매번 통과).
  // 원인 규명 대신 **완전히 새 앱 인스턴스**로 격리해 그 불확실성 자체를 제거한다 — 네이티브
  // 다이얼로그를 자동으로 누를 수 없으므로 "닫기 요청 뒤에도 탭이 즉시 사라지지 않는다"만 확인하고,
  // 이 다이얼로그가 메인 프로세스를 블로킹하므로 곧바로 강제 종료로 정리한다.
  await runT8()

  async function runT8() {
    const port8 = await preferFreePort(args.port + 1, 'verify-tab-engine-cdp.mjs(T8)')
    await waitForPortFree(port8)
    const profile8 = path.join(args.out, 'profile-t8')
    fs.rmSync(profile8, { recursive: true, force: true })
    fs.mkdirSync(profile8, { recursive: true })
    fs.writeFileSync(path.join(profile8, 'settings.json'), JSON.stringify({
      setup: { completed: true },
      startup: { mode: 'newtab', urls: [] },
      adblock: { enabled: false },
    }, null, 2))
    const log8 = fs.createWriteStream(path.join(args.out, 'app-t8.log'))
    const child8 = spawn(EXE, [`--remote-debugging-port=${port8}`, `--user-data-dir=${profile8}`],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    child8.stdout.pipe(log8); child8.stderr.pipe(log8)
    let shell8 = null
    try {
      shell8 = await connectShellSessionReady(port8)
      const wid8 = await evalIn(shell8, 'new URL(location.href).searchParams.get("windowId")')
      const tabId = await evalIn(shell8,
        `window.browserAPI.tabs.create(${JSON.stringify(wid8)}, ${JSON.stringify(fx.urls.blocking)}).then(t => t.id)`, true)
      await sleep(600)
      // 이 close 요청이 dialog.showMessageBoxSync() 를 띄우면 **메인 프로세스 JS 스레드 전체가
      // 그 다이얼로그가 닫힐 때까지 멈춘다** — ipcMain 핸들러(우리가 확인에 쓰려던 tabs:list 포함)도
      // 예외가 아니다. 그래서 "닫기 뒤 확인"은 IPC 가 아니라, 브라우저 프로세스의 **별도 IO 스레드**에서
      // 도는 CDP HTTP 서버(/json/list)로 한다 — 메인 스레드가 멈춰도 그 스레드는 영향받지 않는다.
      // tabs.close() 의 IPC 핸들러 자체는 즉시 반환한다(closeTab 은 fire-and-forget) — 다이얼로그는
      // 그 뒤 beforeunload 왕복이 끝나야 뜨므로 이 호출은 안전하게 await 할 수 있다.
      await evalIn(shell8, `window.browserAPI.tabs.close(${JSON.stringify(tabId)})`, true).catch(() => {})
      await sleep(2500)
      const targets = await getTargetList(port8)
      const stillOpen = targets.some((t) => typeof t.url === 'string' && t.url.startsWith(fx.urls.blocking))
      check('T8', 'beforeunload 를 막는 탭은 확인 전까지 남아 있음(다이얼로그 대기 중)', stillOpen,
        `close 요청 2.5초 후 CDP 타깃 목록에 그 탭=${stillOpen}(다이얼로그 응답 전이라 살아있어야 함, IPC 대신 /json/list 로 확인 — 메인 스레드가 다이얼로그로 멈춰 있어도 안전)`)
    } catch (err) {
      check('T8', 'beforeunload 를 막는 탭은 확인 전까지 남아 있음(다이얼로그 대기 중)', false, `예외: ${err.message}`)
    } finally {
      // 네이티브 모달이 뜬 채 끝난다 — 우아한 종료는 시도하지 않고 곧바로 강제 종료.
      try { child8.kill() } catch { /* ignore */ }
      try { log8.end() } catch { /* ignore */ }
    }
  }

  await fx.close()

  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  fs.writeFileSync(path.join(args.out, 'tab-engine-results.json'),
    JSON.stringify({ when: new Date().toISOString(), pass, fail, results }, null, 2))
  console.log(`\n탭 엔진(묶음 A): ${pass} PASS / ${fail} FAIL`)
  if (fail > 0) process.exitCode = 1
}

main().catch((err) => { console.error(err); process.exitCode = 2 })
