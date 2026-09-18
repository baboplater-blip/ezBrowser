#!/usr/bin/env node
// verify-extension-behavior-cdp.mjs — 크롬 확장이 **로드만 되는 게 아니라 실제로 동작하는가**
//
// 왜 (2026-09-07, 임무 34): `ext-matrix` 는 웹스토어 상위 확장이 **로드되는지**까지만 본다.
// 그런데 1원칙 #2 가 약속한 것은 "그대로 붙는다" 즉 **동작**이다. 로드는 되는데 차단이 안 되거나
// 콘텐츠 스크립트가 안 도는 상태여도 지금 게이트는 초록이었다.
//
// 설계 판단: 웹스토어 CRX 로 검사하면 네트워크·버전에 의존해 게이트가 흔들린다(ext-matrix 가 이미
// 그 역할을 한다). 여기서는 **목적별 시험 확장을 직접 만들어** 우리가 지원해야 하는 API 가
// 실제로 동작하는지 결정론적으로 본다.
//
//   X1 declarativeNetRequest 로 지정 URL 이 실제로 차단된다        (uBO Lite 방식)
//   X2 content script 가 페이지에 주입·실행된다                     (Dark Reader 방식)
//   X3 chrome.storage 가 읽고 쓰인다
//   X4 MV3 service worker 가 살아 동작한다(메시지 왕복)
//   X5 양성 대조 — 확장을 끄면 차단이 사라진다
//   X10 양성 대조 — 확장을 끄면 **주입도** 멈춘다(X2 의 짝. 없으면 X2 는 "항상 주입됨" 과 구분되지 않는다)
//   X11 chrome.scripting.executeScript 프로그래밍 주입 (MV3 확장이 흔히 쓰는 경로)
//   X13 chrome.tabs 가 우리 탭을 **정확한 id·URL** 로, **그 탭의 세션에서만** 보고한다
//
// ⚠ 주입 검사는 **DOM 을 통해** 본다. 콘텐츠 스크립트·executeScript 는 격리 월드에서 돌아
// `window.*` 전역이 CDP 의 메인 월드 evaluate 에 보이지 않는다 — 공유되는 것은 DOM 뿐이다.
//
// 사용: node build/verify-extension-behavior-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectSession, getTargetList, waitForPortFree, connectShellSessionReady, ensureSessionReady,
  isShellTarget, pollUntil,
} from './lib/cdp.mjs'
import { preferFreePort, getFreePorts } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9266, out: path.join(REPO, 'verify-out', 'extension-behavior') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}

// **알려진 공백** — 아직 구현되지 않은 기능. 실패로 세지 않되(게이트를 영구히 빨갛게 만들면
// 결국 무시당한다) 매 실행 크게 보이게 남긴다. 구현되면 이 항목을 check() 로 승격한다.
function gap(id, name, nowOk, detail, why) {
  results.push({ id, name, status: nowOk ? 'PASS' : 'GAP', detail, why })
  console.log(`  ${nowOk ? '✓' : '△'} ${id} ${nowOk ? 'PASS' : 'GAP'} — ${detail}`)
  if (!nowOk) console.log(`      ↳ 알려진 공백: ${why}`)
}

// 시험 페이지: 광고처럼 생긴 스크립트를 하나 불러온다(차단 대상).
const PAGE = `<!doctype html><meta charset="utf-8"><title>확장 시험</title>
<body style="font:16px system-ui;padding:40px">
<h1>확장 시험 페이지</h1><p id="mark">원본</p>
<script>
  window.__adLoaded = false
  window.__adError = false
</script>
<script src="/ads/banner.js" onerror="window.__adError = true"></script>
</body>`

function startPageServer(port) {
  let adHits = 0
  let dynHits = 0
  const seenHeaders = []
  const server = http.createServer((req, res) => {
    // 헤더 시험용 — 서버가 **받은 요청 헤더**를 그대로 돌려준다(요청 헤더 변형 확인).
    if (req.url.startsWith('/echo')) {
      seenHeaders.push({ url: req.url, headers: req.headers })
      res.writeHead(200, { 'content-type': 'application/json', 'x-original': 'from-server' })
      res.end(JSON.stringify({ ok: true, got: req.headers['x-bb-added'] ?? null }))
      return
    }
    if (req.url.startsWith('/dyn/')) {
      dynHits++
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' })
      res.end('window.__dynLoaded = true;')
      return
    }
    if (req.url.startsWith('/ads/')) {
      adHits++
      // no-store — X17/X18/X22 등 여러 워크스페이스·여러 시점에서 반복 요청하므로,
      // HTTP 캐시가 "차단 해제/재차단"을 가려 결과를 헷갈리게 만들면 안 된다.
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' })
      res.end('window.__adLoaded = true;')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${port}/`,
    get adHits() { return adHits },
    get dynHits() { return dynHits },
    get seenHeaders() { return seenHeaders },
    resetHits() { adHits = 0; dynHits = 0; seenHeaders.length = 0 },
    async close() {
      await new Promise((r) => {
        try { server.closeAllConnections?.() } catch { /* ignore */ }
        const t = setTimeout(r, 3000)
        server.close(() => { clearTimeout(t); r() })
      })
    },
  })))
}

// 앱(adapter.ts idFromPublicKey)과 **같은 방식**으로 공개키에서 확장 ID 를 파생한다.
// SHA256(DER)[0:16] 을 a-p 알파벳으로. Chromium GenerateId 와 동일.
function idFromPublicKey(pubKeyDer) {
  const first16 = crypto.createHash('sha256').update(pubKeyDer).digest().subarray(0, 16)
  let id = ''
  for (const byte of first16) {
    id += String.fromCharCode(97 + (byte >> 4))
    id += String.fromCharCode(97 + (byte & 0x0f))
  }
  return id
}

/**
 * 시험용 확장을 프로필의 extensions 디렉터리에 만든다.
 *
 * ⚠ 디렉터리 이름은 반드시 **확장 ID** 여야 한다(2026-09-15).
 * 앱은 `디렉터리 이름 === 확장 ID` 를 전제로 동작한다 — listExtensions 가 `id: dir` 을 쓰고
 * setExtensionEnabled/removeExtension 이 그 값을 그대로 `session.removeExtension(id)` 에 넘긴다.
 * 실제 설치 경로(installFromCrx·importLocalUnpackedDir)는 manifest 에 `key` 를 주입해 ID 를
 * 파생하고 그 ID 로 디렉터리를 만들므로 이 전제가 성립한다.
 * 예전 이 하네스는 디렉터리를 `harness-test-ext` 로 지어 그 전제를 깼고, 그 결과
 * "끄면 주입이 멈추는가"(X10)가 **제품이 아니라 픽스처 때문에** 실패했다.
 * 그래서 여기서도 실제 설치와 동일하게 key 를 주입하고 ID 로 디렉터리를 짓는다.
 *
 * @returns {{ dir: string, id: string }}
 */
function writeTestExtension(root) {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pubKeyDer = publicKey.export({ type: 'spki', format: 'der' })
  const id = idFromPublicKey(pubKeyDer)
  const dir = path.join(root, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    key: pubKeyDer.toString('base64'),
    manifest_version: 3,
    name: '검증 시험 확장',
    version: '1.0',
    description: '하네스가 만드는 시험용 확장 — 차단·주입·저장소·SW 를 확인한다',
    permissions: ['declarativeNetRequest', 'storage', 'scripting', 'tabs'],
    host_permissions: ['<all_urls>'],
    background: { service_worker: 'sw.js' },
    content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle' }],
    declarative_net_request: {
      rule_resources: [{ id: 'ruleset', enabled: true, path: 'rules.json' }],
    },
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify([
    { id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '/ads/', resourceTypes: ['script'] } },
    // 요청 헤더 변형 — 서버가 받은 헤더로 확인한다.
    { id: 2, priority: 1, condition: { urlFilter: '/echo' },
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'x-bb-added', operation: 'set', value: 'hello-from-dnr' },
        { header: 'x-bb-removed', operation: 'remove' },
      ] } },
    // 응답 헤더 변형 — 페이지가 fetch 로 확인한다.
    { id: 3, priority: 1, condition: { urlFilter: '/echo' },
      action: { type: 'modifyHeaders', responseHeaders: [
        { header: 'x-bb-res', operation: 'set', value: 'set-by-dnr' },
        { header: 'x-original', operation: 'remove' },
      ] } },
  ], null, 2))
  // 콘텐츠 스크립트: 페이지에 흔적을 남긴다(주입·실행 확인).
  // 격리 월드라 window 전역은 하네스에 안 보인다 → **DOM 속성**으로 흔적을 남긴다.
  fs.writeFileSync(path.join(dir, 'content.js'),
    "document.documentElement.setAttribute('data-ext-injected', 'yes');" +
    "const p = document.getElementById('mark'); if (p) p.textContent = '확장이 바꿈';")
  // chrome.scripting.executeScript 로 넣을 파일(X11) — 역시 DOM 에 흔적을 남긴다.
  fs.writeFileSync(path.join(dir, 'injected.js'),
    "document.documentElement.setAttribute('data-ext-scripted', 'yes');")
  // 서비스 워커: 저장소에 쓰고, 메시지에 응답한다.
  fs.writeFileSync(path.join(dir, 'sw.js'),
    "chrome.storage.local.set({ swAlive: true, at: Date.now() });" +
    "chrome.runtime.onMessage.addListener((msg, _s, reply) => { reply({ pong: msg && msg.ping }); return true });" +
    // 하네스가 SW 컨텍스트에서 직접 부를 수 있게 전역에 노출한다(동적 룰 시험용).
    "globalThis.__bbAddDynamic = () => chrome.declarativeNetRequest.updateDynamicRules({" +
    "  addRules: [{ id: 100, priority: 2, action: { type: 'block' }," +
    "    condition: { urlFilter: '/dyn/', resourceTypes: ['script', 'xmlhttprequest'] } }] });" +
    "globalThis.__bbRemoveDynamic = () => chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [100] });" +
    "globalThis.__bbHasApi = () => typeof chrome !== 'undefined' && !!chrome.declarativeNetRequest" +
    "  && typeof chrome.declarativeNetRequest.updateDynamicRules === 'function';")
  return { dir, id }
}

/**
 * X13 판정 — 함수로 뽑아 둔 이유: 음성 대조에서 **같은 코드**에 결함 데이터를 먹여
 * 각 조건이 실제로 빨개지는지 확인하기 위해서다(판정식을 베껴 시험하면 베낀 쪽만 검증된다).
 *   ownerCount   우리 탭을 정확한 URL 로 보고한 SW(=세션) 수 — 1 이어야 한다
 *   ownerGetUrl  그 SW 의 tabs.get(id) 가 돌려준 URL — id ↔ URL 정합
 *   foreignGets  나머지 세션이 같은 id 로 받은 응답 — 우리 URL 이 나오면 세션 누출
 */
function judgeX13({ expectUrl, ownerCount, ownerTabId, ownerGetUrl, foreignGets }) {
  if (!expectUrl) return false
  if (ownerCount !== 1) return false
  if (typeof ownerTabId !== 'number' || ownerTabId <= 0) return false
  if (ownerGetUrl !== expectUrl) return false
  return (foreignGets ?? []).every((g) => String(g?.url ?? '') !== expectUrl)
}

// ─────────────────────────────────────────────────────────────────────────
// (3) 세션 격리 — 워크스페이스 2개 이상 + 시크릿 창. 판정 함수들을 X13 과 같은 패턴으로
// 이름 붙여 두어 아래 selfCheckJudges() 에서 결함 데이터를 먹여 검증할 수 있게 한다.
// ─────────────────────────────────────────────────────────────────────────

/** X14 — 워크스페이스 A/B 의 탭을 각각 정확히 한 세션만 보고하는가(교차 누출 없이). */
function judgeX14Isolation({ tabAUrl, tabBUrl, ownerAIdx, ownerBIdx, leakA, leakB, sessionCount }) {
  if (!tabAUrl || !tabBUrl) return false
  if (ownerAIdx == null || ownerBIdx == null || ownerAIdx < 0 || ownerBIdx < 0) return false
  if (ownerAIdx === ownerBIdx) return false // 서로 다른 partition 이므로 서로 다른 세션이어야 한다
  if (leakA > 0 || leakB > 0) return false
  if (!sessionCount || sessionCount < 2) return false
  return true
}

/** X15 — executeScript 가 소유 세션에서만 실제로 DOM 에 닿고, 다른 세션 시도는 영향이 없는가. */
function judgeX15Scripting({ scriptedBefore, scriptedAfterCross, ownOutcome, scriptedAfterOwn }) {
  if (scriptedBefore === 'yes') return false // 오염된 페이지로는 대조가 성립하지 않는다
  if (scriptedAfterCross === 'yes') return false // 교차 세션 시도가 실제로 주입시켰다 = 누출
  if (ownOutcome !== 'ok') return false // 양성 대조: 제 세션의 호출은 성공해야 한다
  if (scriptedAfterOwn !== 'yes') return false // 양성 대조: 실제로 주입돼야 한다
  return true
}

/** X16 — 시크릿 탭이 어떤 확장 세션에도 안 보이는가(새 SW 자체가 안 생기는지까지). */
function judgeX16Incognito({ incogRan, incogWindowId, incogUrl, swCountBefore, swCountAfter, incogLeak }) {
  if (incogRan !== 'true') return false
  if (!incogWindowId || !incogUrl) return false
  if (swCountAfter !== swCountBefore) return false // 시크릿 탭 때문에 새 SW 가 생기면 안 된다
  if (incogLeak !== 0) return false // 기존 SW 어디서도 시크릿 탭이 보이면 안 된다
  return true
}

/**
 * X25 — 확장이 탭 id 를 추측해 **시크릿 탭의 DOM 을 실제로 바꿀 수 있는가**(X16 의 짝).
 * X16 은 "보이는가" 만 본다. Electron 의 scripting 은 목록을 거치지 않고 전역 id 로 탭을 풀므로
 * "안 보이는데 닿는" 상태가 성립할 수 있다 — 그래서 **변조 여부**를 따로 판정한다.
 * 양성 대조(다른 워크스페이스 새 탭이 실제로 주입됨)가 서지 않으면 이 검사는 빈 검사이므로 실패로 본다.
 */
function judgeX25IncognitoInjection({ ran, ctrlBefore, ctrlAfter, incogBefore, incogAfter, incogInjectedBefore, incogCodeRan }) {
  if (!ran) return false // 훑기 자체를 못 돌렸다
  if (incogCodeRan) return false // func 경로로 시크릿 페이지에서 코드가 돌았다 = 변조 가능
  if (ctrlBefore === '(타깃 없음)' || incogBefore === '(타깃 없음)') return false
  if (incogAfter === '(타깃 없음)') return false // 시크릿 탭이 사라졌으면 아무것도 증명 못 한다
  if (ctrlBefore === 'yes' || incogBefore === 'yes') return false // 이미 오염된 대조로는 성립 안 됨
  if (incogInjectedBefore === 'yes') return false // 시크릿에 확장이 실려 있다 = 전제부터 깨짐
  if (ctrlAfter !== 'yes') return false // 양성 대조 실패 = 빈 검사(훑기가 아예 안 먹혔다)
  return incogAfter !== 'yes' // 시크릿이 실제로 바뀌었으면 실패
}

/**
 * X26 — 확장이 **브라우저 외피(UI) 렌더러**에 코드를 주입하지 못하는가.
 * 외피는 file:// 로 로드되는 또 하나의 webContents 이고, 그 DOM 에는 그 창의 탭 제목·주소창 값이 있다.
 * 빈 검사 방지 두 겹: 외피를 실제로 시도했다는 증거 + 같은 훑기가 일반 탭에서는 성공한다는 대조.
 */
function judgeX26ShellInjection({ ran, shellAttempted, shellRan, controlRan }) {
  if (!ran) return false // 훑기 자체를 못 돌렸다
  if (!shellAttempted) return false // 외피를 아예 시도하지 못했다 = 빈 검사
  if (!controlRan) return false // 일반 탭에도 안 먹혔다 = 훑기가 죽은 것이지 막힌 게 아니다
  return !shellRan
}

/**
 * X24 — 창을 **실제로 닫은 직후**에도 워크스페이스 전환이 살아남는가.
 * app/main/ipc/workspace.ts 의 "파괴된 창 브로드캐스트" 가드에 대한 유일한 커버리지다.
 * cycles 가 비어 있으면(=한 번도 안 닫았으면) 통과시키지 않는다 — 빈 검사 금지.
 */
function judgeX24CloseThenSwitch({ cycles, failures, finalActiveId, expectedActiveId }) {
  if (!Array.isArray(cycles) || cycles.length === 0) return false // 창을 한 번도 안 닫았다 = 빈 검사
  if (!Array.isArray(failures) || failures.length > 0) return false // 전환이 한 번이라도 reject 되면 실패
  if (!finalActiveId || finalActiveId !== expectedActiveId) return false // 전환이 "실제로" 먹혔는가
  return true
}

// ─────────────────────────────────────────────────────────────────────────
// (4) 확장 생애주기 — disable/enable/remove + 재시작
// ─────────────────────────────────────────────────────────────────────────

/** X17 — disable 이 모든 비-시크릿 세션에서 실제로 멈추고(DNR·SW·주입) 페이지도 그렇게 보이는가. */
function judgeX17Disable({ adBlockedGoneB, injectedGoneB, swAfterDisable, cardEnabled, cardLoaded }) {
  if (adBlockedGoneB !== true) return false // 차단이 사라졌어야(광고가 다시 로드돼야) 한다
  if (injectedGoneB) return false // 주입 표식이 남아 있으면 안 된다
  if (swAfterDisable !== 0) return false // SW 가 하나도 남아 있으면 안 된다
  if (cardEnabled !== 'false') return false
  if (cardLoaded !== 'false') return false
  return true
}

/** X18 — re-enable 이 모든 비-시크릿 세션에서 다시 동작하는가. */
function judgeX18Enable({ adBlockedA, adBlockedB, injectedA, injectedB, swAfterEnable }) {
  if (adBlockedA !== true || adBlockedB !== true) return false // 다시 차단돼야(광고가 안 로드돼야) 한다
  if (!injectedA || !injectedB) return false
  if (!swAfterEnable || swAfterEnable <= 0) return false
  return true
}

/** X19 — remove 가 모든 세션에서 완전히 사라지게 하는가(SW·DNR·주입·목록). */
function judgeX19Remove({ removedOk, swAfterRemove, adBlockedGone, injectedGone, stillListed }) {
  if (removedOk !== true) return false
  if (swAfterRemove !== 0) return false
  if (adBlockedGone !== true) return false
  if (injectedGone) return false
  if (stillListed) return false
  return true
}

/** X20 — 재시작 후 켜져 있던 확장이 모든 세션(단일세션 실패를 겪었던 세션 포함)에 되살아나는가. */
function judgeX20Restart({ entryEnabled, kofn, healedSessionLoaded }) {
  if (entryEnabled !== true) return false
  if (!kofn || kofn.k !== kofn.n || kofn.n < 3) return false
  if (healedSessionLoaded !== true) return false
  return true
}

/** X21 — 건강한 상태에서 카드가 정확한 총 세션 수·enabled·loaded·pill 을 보여주는가. */
function judgeX21Baseline({ cardEnabled, cardLoaded, kofn, expectedTotal, pillText }) {
  if (cardEnabled !== 'true' || cardLoaded !== 'true') return false
  if (!kofn || kofn.k !== kofn.n || kofn.n !== expectedTotal || kofn.n < 2) return false
  if (!/실제 로드됨/.test(String(pillText ?? ''))) return false
  return true
}

/** X22 — 단일 세션 강제 실패가 enabled=true·loaded 부분 실패로 정직하게 드러나는가(+한국어 사유). */
function judgeX22Partial({ entryEnabled, cSessionLoaded, cSessionReason, cardEnabled, kofn, pillText, cChipLoaded, failBoxHasKorean }) {
  if (entryEnabled !== true) return false // 사용자는 껐다 켜지 않았다 — 설정상 여전히 켬
  if (cSessionLoaded !== false) return false // 실제로는 그 세션에서 실패해야
  const nonError = cSessionReason === '꺼져 있습니다.' || cSessionReason === '아직 이 세션에 불러오지 않았습니다.'
  if (!cSessionReason || nonError) return false // 진짜 실패 사유가 있어야(플레이스홀더가 아니라)
  if (cardEnabled !== 'true') return false
  if (!kofn || !(kofn.k > 0 && kofn.k < kofn.n)) return false
  if (!/일부 세션에서 실패/.test(String(pillText ?? ''))) return false
  if (cChipLoaded !== 'false') return false
  if (!failBoxHasKorean) return false
  return true
}

/** X23 — 재시작해도 제거된 확장이 되살아나지 않는가. */
function judgeX23RestartRemoved({ stillGoneAfterRestart, swFinal }) {
  return stillGoneAfterRestart === true && swFinal === 0
}

function parseKofN(s) {
  const m = /^(\d+)\/(\d+)$/.exec(String(s ?? ''))
  if (!m) return null
  return { k: Number(m[1]), n: Number(m[2]) }
}

/**
 * (5) browser://extensions 페이지에서 **화면에 실제로 그려진 DOM** 을 읽는다.
 * IPC 응답(extensions.list())이 아니라 렌더된 결과를 본다 — "확장 목록 데이터가 맞다"와
 * "화면이 그걸 정확히 보여준다"는 다른 주장이고, claim (5)가 요구하는 건 후자다.
 */
async function readExtCard(page, extId) {
  if (!page) return null
  const raw = await evalIn(page, `(() => {
    const el = document.querySelector('.ext-card[data-ext-id=${JSON.stringify(extId)}]')
    if (!el) return null
    const pill = el.querySelector('.pill')
    const chips = Array.from(el.querySelectorAll('.schip')).map((c) => ({
      loaded: c.getAttribute('data-loaded'), kind: c.getAttribute('data-kind'), text: c.textContent,
    }))
    const failBox = el.querySelector('.fail-box')
    return JSON.stringify({
      enabled: el.getAttribute('data-enabled'),
      loaded: el.getAttribute('data-loaded'),
      loadedSessions: el.getAttribute('data-loaded-sessions'),
      pillText: pill ? pill.textContent : null,
      pillStatus: pill ? pill.getAttribute('data-status') : null,
      chips,
      failBoxText: failBox ? failBox.textContent : null,
    })
  })()`)
  return raw ? JSON.parse(raw) : null
}

/** extPage 를 새로고침하고 잠시 기다린 뒤 카드를 읽는다 — onChanged 브로드캐스트 경합을 피한다. */
async function reloadAndReadCard(page, extId) {
  if (!page) return null
  await evalIn(page, 'location.reload()')
  await sleep(1200)
  return readExtCard(page, extId)
}

/**
 * 위 judge* 함수들에 **결함 데이터**를 먹여 실제로 빨개지는지 스스로 검증한다.
 * (task 지시: "판단을 이름 붙인 함수로 빼서 결함 데이터를 먹일 수 있게 하라")
 * 앱을 띄우지 않고 순수 함수만 호출 — main() 시작 전에 동기적으로 돈다.
 */
function selfCheckJudges() {
  const cases = [
    ['judgeX14Isolation(정상)', judgeX14Isolation({ tabAUrl: 'a', tabBUrl: 'b', ownerAIdx: 0, ownerBIdx: 1, leakA: 0, leakB: 0, sessionCount: 4 }), true],
    ['judgeX14Isolation(같은 세션이 둘 다 봄=결함)', judgeX14Isolation({ tabAUrl: 'a', tabBUrl: 'b', ownerAIdx: 0, ownerBIdx: 0, leakA: 0, leakB: 0, sessionCount: 4 }), false],
    ['judgeX14Isolation(누출=결함)', judgeX14Isolation({ tabAUrl: 'a', tabBUrl: 'b', ownerAIdx: 0, ownerBIdx: 1, leakA: 1, leakB: 0, sessionCount: 4 }), false],
    ['judgeX15Scripting(정상)', judgeX15Scripting({ scriptedBefore: null, scriptedAfterCross: null, ownOutcome: 'ok', scriptedAfterOwn: 'yes' }), true],
    ['judgeX15Scripting(교차 세션이 주입시킴=결함)', judgeX15Scripting({ scriptedBefore: null, scriptedAfterCross: 'yes', ownOutcome: 'ok', scriptedAfterOwn: 'yes' }), false],
    ['judgeX15Scripting(양성대조 자체가 실패=결함)', judgeX15Scripting({ scriptedBefore: null, scriptedAfterCross: null, ownOutcome: 'ok', scriptedAfterOwn: null }), false],
    ['judgeX25(정상 — 대조는 주입되고 시크릿은 안 바뀜)',
      judgeX25IncognitoInjection({ ran: true, ctrlBefore: null, ctrlAfter: 'yes', incogBefore: null, incogAfter: null, incogInjectedBefore: null }), true],
    ['judgeX25(시크릿이 실제로 바뀜=결함)',
      judgeX25IncognitoInjection({ ran: true, ctrlBefore: null, ctrlAfter: 'yes', incogBefore: null, incogAfter: 'yes', incogInjectedBefore: null }), false],
    ['judgeX25(양성 대조가 안 섬=빈 검사)',
      judgeX25IncognitoInjection({ ran: true, ctrlBefore: null, ctrlAfter: null, incogBefore: null, incogAfter: null, incogInjectedBefore: null }), false],
    ['judgeX25(시크릿에 확장이 실려 있음=전제 붕괴)',
      judgeX25IncognitoInjection({ ran: true, ctrlBefore: null, ctrlAfter: 'yes', incogBefore: null, incogAfter: null, incogInjectedBefore: 'yes' }), false],
    ['judgeX25(func 경로로 시크릿에서 코드가 돎=결함)',
      judgeX25IncognitoInjection({ ran: true, ctrlBefore: null, ctrlAfter: 'yes', incogBefore: null, incogAfter: null, incogInjectedBefore: null, incogCodeRan: true }), false],
    ['judgeX26(정상 — 외피는 거부되고 일반 탭은 실행)',
      judgeX26ShellInjection({ ran: true, shellAttempted: true, shellRan: false, controlRan: true }), true],
    ['judgeX26(외피에서 코드가 돎=결함)',
      judgeX26ShellInjection({ ran: true, shellAttempted: true, shellRan: true, controlRan: true }), false],
    ['judgeX26(외피를 시도조차 못 함=빈 검사)',
      judgeX26ShellInjection({ ran: true, shellAttempted: false, shellRan: false, controlRan: true }), false],
    ['judgeX26(일반 탭에도 안 먹힘=훑기가 죽음)',
      judgeX26ShellInjection({ ran: true, shellAttempted: true, shellRan: false, controlRan: false }), false],
    ['judgeX25(시크릿 탭 타깃 자체가 없음=증명 불가)',
      judgeX25IncognitoInjection({ ran: true, ctrlBefore: null, ctrlAfter: 'yes', incogBefore: '(타깃 없음)', incogAfter: '(타깃 없음)', incogInjectedBefore: '(타깃 없음)' }), false],
    ['judgeX16Incognito(정상)', judgeX16Incognito({ incogRan: 'true', incogWindowId: '9', incogUrl: 'u', swCountBefore: 3, swCountAfter: 3, incogLeak: 0 }), true],
    ['judgeX16Incognito(새 SW 생김=결함)', judgeX16Incognito({ incogRan: 'true', incogWindowId: '9', incogUrl: 'u', swCountBefore: 3, swCountAfter: 4, incogLeak: 0 }), false],
    ['judgeX16Incognito(누출=결함)', judgeX16Incognito({ incogRan: 'true', incogWindowId: '9', incogUrl: 'u', swCountBefore: 3, swCountAfter: 3, incogLeak: 1 }), false],
    ['judgeX24CloseThenSwitch(정상)', judgeX24CloseThenSwitch({ cycles: ['#0 ok'], failures: [], finalActiveId: 'a', expectedActiveId: 'a' }), true],
    ['judgeX24CloseThenSwitch(창을 안 닫음=빈 검사)', judgeX24CloseThenSwitch({ cycles: [], failures: [], finalActiveId: 'a', expectedActiveId: 'a' }), false],
    ['judgeX24CloseThenSwitch(전환이 reject=결함)', judgeX24CloseThenSwitch({ cycles: ['#0 ERR'], failures: ['바퀴 0: ERR'], finalActiveId: 'a', expectedActiveId: 'a' }), false],
    ['judgeX24CloseThenSwitch(ok 인데 실제로 안 바뀜=결함)', judgeX24CloseThenSwitch({ cycles: ['#0 ok'], failures: [], finalActiveId: 'b', expectedActiveId: 'a' }), false],
    ['judgeX17Disable(정상)', judgeX17Disable({ adBlockedGoneB: true, injectedGoneB: null, swAfterDisable: 0, cardEnabled: 'false', cardLoaded: 'false' }), true],
    ['judgeX17Disable(SW 남음=결함)', judgeX17Disable({ adBlockedGoneB: true, injectedGoneB: null, swAfterDisable: 1, cardEnabled: 'false', cardLoaded: 'false' }), false],
    ['judgeX18Enable(정상)', judgeX18Enable({ adBlockedA: true, adBlockedB: true, injectedA: 'yes', injectedB: 'yes', swAfterEnable: 4 }), true],
    ['judgeX18Enable(한쪽 세션 안됨=결함)', judgeX18Enable({ adBlockedA: true, adBlockedB: false, injectedA: 'yes', injectedB: 'yes', swAfterEnable: 4 }), false],
    ['judgeX19Remove(정상)', judgeX19Remove({ removedOk: true, swAfterRemove: 0, adBlockedGone: true, injectedGone: null, stillListed: false }), true],
    ['judgeX19Remove(목록에 남음=결함)', judgeX19Remove({ removedOk: true, swAfterRemove: 0, adBlockedGone: true, injectedGone: null, stillListed: true }), false],
    ['judgeX20Restart(정상)', judgeX20Restart({ entryEnabled: true, kofn: { k: 4, n: 4 }, healedSessionLoaded: true }), true],
    ['judgeX20Restart(치유 안 된 세션=결함)', judgeX20Restart({ entryEnabled: true, kofn: { k: 4, n: 4 }, healedSessionLoaded: false }), false],
    ['judgeX21Baseline(정상)', judgeX21Baseline({ cardEnabled: 'true', cardLoaded: 'true', kofn: { k: 4, n: 4 }, expectedTotal: 4, pillText: '실제 로드됨 · 4/4 세션' }), true],
    ['judgeX21Baseline(총수 불일치=결함)', judgeX21Baseline({ cardEnabled: 'true', cardLoaded: 'true', kofn: { k: 4, n: 4 }, expectedTotal: 5, pillText: '실제 로드됨 · 4/4 세션' }), false],
    ['judgeX22Partial(정상)', judgeX22Partial({ entryEnabled: true, cSessionLoaded: false, cSessionReason: '확장 파일을 찾을 수 없습니다.', cardEnabled: 'true', kofn: { k: 3, n: 4 }, pillText: '일부 세션에서 실패 · 3/4 세션', cChipLoaded: 'false', failBoxHasKorean: true }), true],
    ['judgeX22Partial(사유가 플레이스홀더=결함)', judgeX22Partial({ entryEnabled: true, cSessionLoaded: false, cSessionReason: '아직 이 세션에 불러오지 않았습니다.', cardEnabled: 'true', kofn: { k: 3, n: 4 }, pillText: '일부 세션에서 실패 · 3/4 세션', cChipLoaded: 'false', failBoxHasKorean: true }), false],
    ['judgeX22Partial(전부 성공인데 partial 주장=결함)', judgeX22Partial({ entryEnabled: true, cSessionLoaded: false, cSessionReason: '확장 파일을 찾을 수 없습니다.', cardEnabled: 'true', kofn: { k: 4, n: 4 }, pillText: '실제 로드됨 · 4/4 세션', cChipLoaded: 'false', failBoxHasKorean: true }), false],
    ['judgeX23RestartRemoved(정상)', judgeX23RestartRemoved({ stillGoneAfterRestart: true, swFinal: 0 }), true],
    ['judgeX23RestartRemoved(되살아남=결함)', judgeX23RestartRemoved({ stillGoneAfterRestart: false, swFinal: 0 }), false],
  ]
  let allOk = true
  for (const [label, actual, expected] of cases) {
    const ok = actual === expected
    if (!ok) allOk = false
    console.log(`  ${ok ? '✓' : '✗'} [자체검증] ${label} → ${actual}(기대 ${expected})`)
  }
  results.push({ id: 'SELFCHECK', name: '판정 함수 자체검증(결함 데이터로 실제로 빨개지는지)', status: allOk ? 'PASS' : 'FAIL', detail: `${cases.length}건 중 ${cases.filter(([, a, e]) => a === e).length}건 일치` })
  if (!allOk) throw new Error('judge* 함수 자체검증 실패 — 판정 로직 자체가 결함을 못 잡는다. 앱을 띄우기 전에 멈춘다.')
}

const evalIn = async (s, expression, awaitPromise = false) => {
  // s.send() 는 CDP 응답의 msg.result 를 그대로 준다 — Runtime.evaluate 응답에서 msg.result 자체가
  // 이미 { result: <RemoteObject>, exceptionDetails? } 형태다(중첩 없음). 즉 exceptionDetails 는
  // r.exceptionDetails 이지 r.result.exceptionDetails 가 아니다 — 처음엔 이걸 잘못 짚어서(2026-09)
  // 예외 감지가 조용히 무력했고, JSON.parse(비문자열) 이 "[object Object]" is not valid JSON 이라는
  // 원인 불명의 하네스 자체 에러로만 터졌다. 이제 진짜 위치에서 먼저 터뜨린다.
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails
    const desc = ex.exception?.description ?? ex.exception?.value ?? ex.text ?? JSON.stringify(ex)
    throw new Error(`evalIn 예외: ${String(desc).slice(0, 600)} · 식=${expression.slice(0, 160)}`)
  }
  return r.result?.value
}

async function main() {
  selfCheckJudges()
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE}`)
  fs.mkdirSync(args.out, { recursive: true })
  args.port = await preferFreePort(args.port, 'extension-behavior')
  await waitForPortFree(args.port)
  const [pagePort] = await getFreePorts(1)
  const pages = await startPageServer(pagePort)

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true }, startup: { mode: 'newtab', urls: [] },
    adblock: { enabled: false },   // 우리 광고차단을 꺼야 **확장이** 막았는지 알 수 있다
  }, null, 2))
  const testExt = writeTestExtension(path.join(profileDir, 'extensions'))

  const logStream = fs.createWriteStream(path.join(args.out, 'app.log'))
  // let(재시작 시 재할당) — X20/X23 이 앱을 껐다 켠다.
  let child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    let windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
    await sleep(2500)   // 확장 로드 여유

    const loaded = JSON.parse(await evalIn(shell,
      'window.browserAPI.extensions.list().then(l => JSON.stringify(l))', true).catch(() => '[]') ?? '[]')

    const openPage = async (suffix) => {
      const tabId = await evalIn(shell,
        `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pages.url + suffix)}).then(t => t.id)`, true)
      await sleep(3000)
      const target = (await getTargetList(args.port)).find((t) => String(t.url).startsWith(pages.url + suffix))
      if (!target) return { tabId, page: null, url: null }
      const page = await connectSession(target, 'page' + suffix)
      await ensureSessionReady(page)
      // 확장이 보고하는 URL 과 **정확히** 대조하기 위해 브라우저가 실제로 연 주소를 쓴다(짐작하지 않는다).
      return { tabId, page, url: String(target.url) }
    }

    // ---- X1 declarativeNetRequest 차단 ----
    pages.resetHits()
    const { tabId: t1, page: p1, url: x1Url } = await openPage('?x1')
    const state1 = p1 ? {
      adLoaded: await evalIn(p1, 'window.__adLoaded === true'),
      injected: await evalIn(p1, 'document.documentElement.getAttribute("data-ext-injected")'),
      mark: await evalIn(p1, '(document.getElementById("mark")||{}).textContent'),
    } : {}
    // 임무 36 에서 DNR 을 구현해 **GAP 에서 정식 검사로 승격**했다. 이제 실패하면 회귀다.
    check('X1', '확장의 declarativeNetRequest 가 실제로 요청을 차단한다',
      state1.adLoaded === false && pages.adHits === 0,
      `광고 스크립트 로드=${state1.adLoaded} · 서버 적중 ${pages.adHits}회(0 이어야 함) · 확장 ${loaded.length}개 로드`)

    // ---- X2 콘텐츠 스크립트 주입 ----
    check('X2', '콘텐츠 스크립트가 페이지에 주입·실행된다',
      state1.injected === 'yes' && String(state1.mark) === '확장이 바꿈',
      `주입 표식=${state1.injected} · 본문 변경="${state1.mark}"`)

    // ---- X6/X7: modifyHeaders (임무 37) ----
    {
      pages.resetHits()
      // returnByValue 가 객체를 그대로 준다 — 굳이 문자열로 만들지 않는다.
      const r = (p1 ? await evalIn(p1, `(async () => {
        try {
          const res = await fetch('/echo?x6', { headers: { 'x-bb-removed': 'should-be-removed' } })
          const body = await res.json()
          return { got: body && body.got, resHeader: res.headers.get('x-bb-res'), original: res.headers.get('x-original') }
        } catch (e) { return { err: String(e && e.message || e), where: location.href } }
      })()`, true) : null) ?? { err: '페이지 세션 없음' }
      const sent = pages.seenHeaders[0]?.headers ?? {}
      check('X6', '확장 룰이 요청 헤더를 바꾼다(set·remove)',
        String(sent['x-bb-added']) === 'hello-from-dnr' && sent['x-bb-removed'] === undefined,
        `서버가 받은 x-bb-added=${sent['x-bb-added']} · x-bb-removed=${sent['x-bb-removed'] ?? '(없음)'}`
        + ` · 서버 도달 ${pages.seenHeaders.length}회 · got=${r.got} · 오류=${r.err ?? '(없음)'} · 위치=${r.where ?? ''}`)
      check('X7', '확장 룰이 응답 헤더를 바꾼다(set·remove)',
        r.resHeader === 'set-by-dnr' && !r.original,
        `x-bb-res=${r.resHeader} · 지워야 할 x-original=${r.original ?? '(없음)'}`)
    }

    // ---- X3/X4 서비스 워커 + storage ----
    {
      const swTarget = (await getTargetList(args.port))
        .find((t) => String(t.url).startsWith('chrome-extension://') && /sw\.js|service_worker|background/.test(String(t.url) + String(t.title)))
      let swOk = false, storageOk = false, detail = ''
      if (swTarget) {
        const sw = await connectSession(swTarget, 'sw')
        await ensureSessionReady(sw)
        swOk = (await evalIn(sw, 'typeof chrome !== "undefined" && typeof chrome.runtime !== "undefined"')) === true
        const got = await evalIn(sw,
          'new Promise((r) => chrome.storage.local.get(["swAlive"], (v) => r(JSON.stringify(v))))', true)
        storageOk = String(got ?? '').includes('true')
        detail = `SW 타깃=${String(swTarget.url).slice(0, 60)} · chrome.runtime=${swOk} · storage=${got}`
        try { sw.close() } catch { /* ignore */ }
      } else {
        detail = `SW 타깃을 찾지 못함 · 확장 목록 ${JSON.stringify(loaded).slice(0, 120)}`
      }
      check('X4', 'MV3 service worker 가 살아 동작한다', swOk, detail)
      check('X3', 'chrome.storage 가 읽고 쓰인다', storageOk, detail)
    }


    // ---- X8~X9: 동적 룰 API (임무 38) ----
    {
      const swTarget = (await getTargetList(args.port))
        .find((t) => String(t.url).endsWith('/sw.js'))
      let hasApi = null, added = null, removed = null, stored = null, applied = null, preloadRan = null, preloadInPage = null
      let blockedAfterAdd = null, loadedAfterRemove = null
      if (swTarget) {
        const sw = await connectSession(swTarget, 'sw-dyn')
        await ensureSessionReady(sw)
        hasApi = await evalIn(sw, 'globalThis.__bbHasApi ? globalThis.__bbHasApi() : false')
        preloadRan = await evalIn(sw, 'globalThis.__bbDnrPreload === true')
        // 프레임 컨텍스트에서는 실행되는지도 함께 본다 — SW 만 안 되는지 가르기 위해.
        preloadInPage = await evalIn(p1, 'window.__bbDnrPreload === true')
        added = await evalIn(sw, 'globalThis.__bbAddDynamic ? globalThis.__bbAddDynamic().then((r) => JSON.stringify(r)).catch((e) => String(e)) : "함수 없음"', true)
        await sleep(3500)   // Electron 이 디스크에 쓰고 우리 폴링(2초)이 읽을 시간
        stored = await evalIn(sw, 'chrome.declarativeNetRequest.getDynamicRules().then((r) => JSON.stringify(r)).catch((e) => String(e))', true)
        applied = JSON.parse(await evalIn(shell, 'window.browserAPI.extensions.list().then(l => JSON.stringify(l.map(x => x.dnrRules)))', true) ?? '[]')
        // 룰을 넣은 뒤 그 경로를 요청해 본다
        pages.resetHits()
        const r1 = await evalIn(p1, `fetch('/dyn/a.js').then(() => 'ok').catch(() => 'blocked')`, true)
        blockedAfterAdd = pages.dynHits === 0
        removed = await evalIn(sw, 'globalThis.__bbRemoveDynamic ? globalThis.__bbRemoveDynamic().then(() => true).catch((e) => String(e)) : "함수 없음"', true)
        await sleep(3500)   // 제거도 디스크→폴링을 거친다
        pages.resetHits()
        await evalIn(p1, `fetch('/dyn/b.js').then(() => 'ok').catch(() => 'blocked')`, true)
        loadedAfterRemove = pages.dynHits > 0
        try { sw.close() } catch { /* ignore */ }
      }
      check('X8', '확장이 런타임에 넣은 동적 룰이 실제로 차단한다',
        blockedAfterAdd === true,
        `Electron 표면 존재=${hasApi} · 추가 후 서버 도달 0회=${blockedAfterAdd} · 저장된 룰=${String(stored).slice(0, 80)}`)
      check('X9', '동적 룰을 제거하면 다시 통과한다(양성 대조)',
        loadedAfterRemove === true,
        `제거 후 서버 도달=${loadedAfterRemove} — false 면 X8 은 "확장과 무관하게" 통과한 것이다`)
    }

    // ---- X11: chrome.scripting.executeScript (프로그래밍 주입) ----
    // MV3 확장은 선언형 content_scripts 말고 이 API 로도 코드를 넣는다(사용자 클릭 시 주입 등).
    // 라이브러리(electron-chrome-extensions 4.9.0)에는 scripting 구현이 없다 — Electron 이 주는지
    // **직접 불러서** 확인한다. 안 되면 GAP 으로 남겨 매 실행 보이게 한다.
    {
      // ⚠ 서비스 워커는 **세션마다 하나씩** 있다.
      // 앱은 확장을 defaultSession·persist:default·워크스페이스 partition **전부**에 로드하고
      // (loadExtensionInAll — 워크스페이스에서도 확장이 동작하게 하려고), MV3 확장은 세션마다
      // 자기 SW 를 띄운다. 그래서 `/sw.js` CDP 타깃이 여러 개다.
      // 탭을 볼 수 있는 것은 **그 탭이 사는 세션의 SW 뿐**이므로, 아무거나 하나를 집으면
      // 실행마다 결과가 뒤집힌다(2026-09-15 에 실제로 그렇게 흔들렸다).
      // → 전부 훑어 탭을 보는 SW 를 찾는다. 하나도 없으면 그때가 진짜 실패다.
      // ⚠ 2026-09-15(마감 보완) 이전 판정은 "SW 중 **아무거나 하나**가 URL 에 127.0.0.1 을 품은 탭을
      //    본다" 였다. 그것은 ① 어느 세션이 봤는지 ② 그게 정말 우리가 연 그 탭인지를 구분하지 못한다
      //    (다른 탭·다른 쿼리 문자열도 127.0.0.1 을 포함한다). 이제 아래를 모두 요구한다:
      //      · 우리 탭을 **정확한 URL** 로 보고하는 SW 가 **정확히 하나**   → 세션 격리
      //      · 그 SW 에서 tabs.get(id) 가 같은 URL 을 돌려준다             → id ↔ URL 정합
      //      · 나머지 SW 는 같은 id 로 우리 URL 을 얻지 못한다              → id 가 그 세션 밖으로 새지 않음
      const swTargets = (await getTargetList(args.port)).filter((t) => String(t.url).endsWith('/sw.js'))
      const expectUrl = x1Url   // 브라우저가 실제로 연 주소(짐작하지 않는다)

      // 1차 — 전수 조사. 어느 SW 가 무엇을 보는지 모두 기록한다(먼저 찾은 것에서 멈추지 않는다).
      const seenBySw = []
      for (let i = 0; i < swTargets.length; i++) {
        const sw = await connectSession(swTargets[i], `sw-scan-${i}`)
        await ensureSessionReady(sw)
        // 확장이 보는 탭 목록. 브라우저가 addTab 으로 등록해 주지 않으면 여기가 **항상 0개**다.
        const seen = JSON.parse(await evalIn(sw, `chrome.tabs.query({}).then(
          (ts) => JSON.stringify(ts.map((t) => ({ id: t.id, url: String(t.url || ''), active: t.active })))
        ).catch((e) => JSON.stringify([{ err: String(e && e.message || e) }]))`, true) ?? '[]')
        seenBySw.push(seen)
        try { sw.close() } catch { /* ignore */ }
      }

      const ownerIdxs = seenBySw
        .map((seen, i) => (expectUrl && seen.some((t) => String(t.url) === expectUrl) ? i : -1))
        .filter((i) => i >= 0)
      const ownerIdx = ownerIdxs.length ? ownerIdxs[0] : -1
      const ownerTab = ownerIdx >= 0 ? seenBySw[ownerIdx].find((t) => String(t.url) === expectUrl) : null
      const ownerTabId = ownerTab?.id

      // 2차 — 같은 탭 id 를 모든 세션에 물어 교차 확인한다.
      // (라이브러리는 등록되지 않은 id 에 예외가 아니라 `{ id: -1 }` 을 돌려준다 — 그래서 URL 로 판정한다.)
      let ownerGetUrl = null
      const foreignGets = []
      let outcome = swTargets.length ? '탭을 보는 SW 없음' : 'SW 타깃 없음'
      if (ownerIdx >= 0 && typeof ownerTabId === 'number') {
        for (let i = 0; i < swTargets.length; i++) {
          const sw = await connectSession(swTargets[i], `sw-cross-${i}`)
          await ensureSessionReady(sw)
          const got = JSON.parse(await evalIn(sw,
            `chrome.tabs.get(${ownerTabId})`
            + `.then((t) => JSON.stringify({ id: t && t.id, url: String((t && t.url) || '') }))`
            + `.catch((e) => JSON.stringify({ err: String(e && e.message || e) }))`, true) ?? 'null')
          if (i === ownerIdx) {
            ownerGetUrl = got?.url ?? null
            // X11 — 확인된 그 id 로 코드를 넣는다(목록에서 다시 고르지 않는다).
            outcome = await evalIn(sw, `(async () => {
              try {
                if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') return 'scripting API 없음'
                await chrome.scripting.executeScript({ target: { tabId: ${ownerTabId} }, files: ['injected.js'] })
                return 'ok'
              } catch (e) { return '오류: ' + String((e && e.message) || e) }
            })()`, true)
          } else {
            foreignGets.push(got)
          }
          try { sw.close() } catch { /* ignore */ }
        }
      }
      await sleep(800)
      const scripted = p1 ? await evalIn(p1, 'document.documentElement.getAttribute("data-ext-scripted")') : null

      // X13 — 2026-09-15 에 고친 결함의 회귀 검사. 라이브러리는 `addTab(wc, window)` 로 등록된
      // webContents 만 chrome.tabs 에 노출한다. 우리가 그 호출을 빠뜨려 목록이 늘 비어 있었다.
      const foreignLeak = foreignGets.filter((g) => String(g?.url ?? '') === expectUrl).length
      check('X13', 'chrome.tabs 가 우리 탭을 정확한 id·URL 로, 그 탭의 세션에서만 보고한다',
        judgeX13({ expectUrl, ownerCount: ownerIdxs.length, ownerTabId, ownerGetUrl, foreignGets }),
        `SW ${swTargets.length}개(세션마다 하나) · 기대 URL=${expectUrl ?? '(페이지 세션 없음)'}`
        + ` · 보고한 SW ${ownerIdxs.length}개(1 이어야) · 탭 id=${ownerTabId ?? '(없음)'}`
        + ` · tabs.get(id).url=${ownerGetUrl ?? '(없음)'}`
        + ` · 다른 세션 누출 ${foreignLeak}건 · 다른 세션 응답=${JSON.stringify(foreignGets).slice(0, 120)}`
        + ` · SW별 탭수=[${seenBySw.map((s) => s.length).join(',')}]`)

      // X11 — 라이브러리(4.9.0)에는 scripting 구현이 없지만(문자열 검색 0건) **Electron 이 준다**.
      // 2026-09-15 이전에는 이게 실패했는데, 원인은 scripting 미지원이 아니라 위 X13(탭 미등록)이었다.
      // 탭이 0개라 `target: { tabId }` 에 넣을 id 가 없었을 뿐이다.
      // → 실패 원인을 넘겨짚지 말 것. 지금은 동작하므로 GAP 이 아니라 **정식 검사**다(회귀면 FAIL).
      check('X11', 'chrome.scripting.executeScript 로 넣은 코드가 실제로 실행된다',
        outcome === 'ok' && scripted === 'yes',
        `executeScript 결과=${outcome} · 페이지 표식=${scripted ?? '(없음)'}`)
    }

    // X8·X9·X11 까지 쓰고 나서 닫는다(앞에서 닫으면 그 뒤 검사가 세션을 잃는다).
    try { p1?.close() } catch { /* ignore */ }

    // 확장 id 를 여기서 한 번만 정한다(X5 이후 모든 생애주기 검사가 이 값을 쓴다).
    // 앱이 보고하는 id 는 디렉터리 이름이고, 그것이 곧 확장 ID 여야 한다(위 writeTestExtension 주석).
    // 어긋나면 setEnabled 가 엉뚱한 id 로 session.removeExtension 을 불러 조용히 아무 일도 안 한다.
    const id = loaded[0]?.id
    if (id !== testExt.id) {
      check('X12', '앱이 보고하는 확장 id 가 실제 확장 ID 와 같다',
        false, `목록 id=${id} · 실제 ID=${testExt.id} — 어긋나면 끄기·제거가 무력해진다`)
    }

    // ════════════════════════════════════════════════════════════════════
    // (3) 세션 격리 — 워크스페이스 2개 이상 + 시크릿 창
    //
    // 아직 확장을 끄지 않은 상태(활성)에서 검증한다. 워크스페이스는 **전역** 개념
    // (app/main/features/workspace 의 activeId 는 모듈 전역 하나 — 창별이 아니다)이라,
    // tabs.create() 가 어느 partition 에 탭을 만드는지는 "호출 시점에 무엇이 활성인가"로 정해진다.
    // 그래서 워크스페이스 B 의 탭을 만들려면 먼저 B 를 활성화한 뒤 tabs.create() 를 부른다.
    // ════════════════════════════════════════════════════════════════════
    let wsB = null
    let idA = null
    {
      const stateBefore = JSON.parse(await evalIn(shell, 'window.browserAPI.workspace.state().then(s=>JSON.stringify(s))', true) ?? '{}')
      idA = stateBefore.activeId

      // 워크스페이스 A(현재 활성 — 부팅 시 자동 생성된 "기본")에 탭 하나.
      await evalIn(shell,
        `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pages.url + '?x14a')})`, true)
      await sleep(3000)

      // 워크스페이스 B 를 만들고 활성화한 뒤 탭 하나 — 이제 이 탭은 B 의 partition 에서 산다.
      wsB = JSON.parse(await evalIn(shell, 'window.browserAPI.workspace.create({name:"검증B"}).then(w=>JSON.stringify(w))', true) ?? '{}')
      await evalIn(shell, `window.browserAPI.workspace.activate(${JSON.stringify(wsB.id)})`, true)
      await sleep(600)
      await evalIn(shell,
        `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pages.url + '?x14b')})`, true)
      await sleep(3000)

      // A 로 되돌린다 — 탭 B 자체는 그대로 살아있다(단지 화면에서 안 보일 뿐, webContents·세션은 유지).
      await evalIn(shell, `window.browserAPI.workspace.activate(${JSON.stringify(idA)})`, true)
      await sleep(600)

      const tabAUrl = (await getTargetList(args.port)).find((t) => String(t.url).includes('?x14a'))?.url ?? null
      const tabBUrl = (await getTargetList(args.port)).find((t) => String(t.url).includes('?x14b'))?.url ?? null

      // 모든 SW 세션을 훑어 어느 세션이 어느 탭을 "자기 것"으로 보는지 스캔한다(X13 과 같은 기법을
      // 탭 2개·세션 N개로 일반화). SW 세션은 뒤이은 executeScript 검사에서도 재사용하려 열어 둔다.
      const swTargets = (await getTargetList(args.port)).filter((t) => String(t.url).endsWith('/sw.js'))
      const scan1 = []
      for (let i = 0; i < swTargets.length; i++) {
        const sw = await connectSession(swTargets[i], `sw-x14-${i}`)
        await ensureSessionReady(sw)
        const seenRaw = await evalIn(sw, `chrome.tabs.query({}).then(
          (ts) => JSON.stringify(ts.map((t) => ({ id: t.id, url: String(t.url || '') })))
        ).catch((e) => JSON.stringify([{ err: String(e && e.message || e) }]))`, true)
        scan1.push({ target: swTargets[i], sw, seen: JSON.parse(seenRaw ?? '[]') })
      }

      const ownerAIdx = scan1.findIndex((s) => s.seen.some((t) => String(t.url) === tabAUrl))
      const ownerBIdx = scan1.findIndex((s) => s.seen.some((t) => String(t.url) === tabBUrl))
      const localIdA = ownerAIdx >= 0 ? scan1[ownerAIdx].seen.find((t) => String(t.url) === tabAUrl)?.id ?? null : null
      const leakA = scan1.filter((s, i) => i !== ownerAIdx && s.seen.some((t) => String(t.url) === tabAUrl)).length
      const leakB = scan1.filter((s, i) => i !== ownerBIdx && s.seen.some((t) => String(t.url) === tabBUrl)).length

      check('X14', 'chrome.tabs.query/get 이 워크스페이스별로 정확히 격리된다(서로 다른 partition = 서로 다른 세션)',
        judgeX14Isolation({ tabAUrl, tabBUrl, ownerAIdx, ownerBIdx, leakA, leakB, sessionCount: scan1.length }),
        `탭A=${tabAUrl ?? '(없음)'} · 탭B=${tabBUrl ?? '(없음)'} · SW 세션 ${scan1.length}개 중`
        + ` A 를 본 세션 idx=${ownerAIdx}(누출 ${leakA}건) · B 를 본 세션 idx=${ownerBIdx}(누출 ${leakB}건)`
        + ` · 서로 다른 세션이어야: ${ownerAIdx} ≠ ${ownerBIdx}`)

      // ---- X15: chrome.scripting.executeScript 도 세션 경계를 지키는가 ----
      // 순서가 핵심 — "교차 세션 시도" 를 먼저 해서 tabA2 가 여전히 깨끗한지 보고(음성),
      // 그다음 "제 세션의 정상 호출" 로 실제로 주입되는지 본다(양성 대조, 같은 페이지·같은 파일).
      const tabATarget = (await getTargetList(args.port)).find((t) => t.url === tabAUrl)
      const pageA = tabATarget ? await connectSession(tabATarget, 'page-x14a') : null
      if (pageA) await ensureSessionReady(pageA)

      const scriptedBefore = pageA ? await evalIn(pageA, 'document.documentElement.getAttribute("data-ext-scripted")') : null

      let crossOutcome = '(대상 없음 — ownerB 또는 localIdA 미확보)'
      if (ownerBIdx >= 0 && ownerBIdx !== ownerAIdx && localIdA != null) {
        crossOutcome = await evalIn(scan1[ownerBIdx].sw, `(async () => {
          try {
            if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') return 'scripting API 없음'
            await chrome.scripting.executeScript({ target: { tabId: ${localIdA} }, files: ['injected.js'] })
            return 'ok(다른 세션에서 호출됨 — 그 세션 자신의 로컬 id 공간일 뿐 tabA 가 아니다)'
          } catch (e) { return '오류: ' + String((e && e.message) || e) }
        })()`, true)
      }
      await sleep(600)
      const scriptedAfterCross = pageA ? await evalIn(pageA, 'document.documentElement.getAttribute("data-ext-scripted")') : null

      let ownOutcome = '(대상 없음 — ownerA 또는 localIdA 미확보)'
      if (ownerAIdx >= 0 && localIdA != null) {
        ownOutcome = await evalIn(scan1[ownerAIdx].sw, `(async () => {
          try {
            await chrome.scripting.executeScript({ target: { tabId: ${localIdA} }, files: ['injected.js'] })
            return 'ok'
          } catch (e) { return '오류: ' + String((e && e.message) || e) }
        })()`, true)
      }
      await sleep(600)
      const scriptedAfterOwn = pageA ? await evalIn(pageA, 'document.documentElement.getAttribute("data-ext-scripted")') : null

      // 2026-09-15: **GAP → 정식 검사로 승격.** 사용자 승인으로 Electron 35.7.5 → 42.11.3 판올림을 했고,
      // 그 안에 upstream PR #50906(`fix: scope extension tab-ID resolution to the calling BrowserContext`,
      // 2026-04-11 merge · 백포트 #50925→39-x-y / #50924→40 / #50926→41 / #50923→42, 38 이하에는 없음)이
      // 들어 있다. 이제 tabs·scripting 둘 다 `GetElectronTabById(..., browser_context, ...)` 로 라우팅돼
      // 호출한 세션의 BrowserContext 밖 탭은 애초에 풀리지 않는다. **실패하면 회귀다**(판올림 되돌림 또는
      // 그 경계를 우회하는 새 코드). 판정식(judgeX15Scripting)은 GAP 시절 그대로 — 한 글자도 약화하지 않았다.
      check('X15', 'chrome.scripting.executeScript 가 제 세션의 탭에만 닿고 다른 세션 시도는 영향이 없다',
        judgeX15Scripting({ scriptedBefore, scriptedAfterCross, ownOutcome, scriptedAfterOwn }),
        `대조 전 표식=${scriptedBefore ?? '(없음)'}(없어야) · 교차 세션 시도 결과=${crossOutcome}`
        + ` · 교차 시도 후 표식=${scriptedAfterCross ?? '(없음)'}(여전히 없어야) · 제 세션 호출=${ownOutcome}`
        + ` · 제 세션 호출 후 표식=${scriptedAfterOwn ?? '(없음)'}(yes 여야 — 양성 대조)`
        + ' · 근거: Electron 42.11.3(PR #50906 포함) 이후 tabs·scripting 이 호출 세션의 BrowserContext 안에서만'
        + ' 탭 id 를 푼다. 35.7.5 에서는 프로세스 전역 `WebContents::FromID` 라 여기서 교차 주입이 성공했다.')

      try { pageA?.close() } catch { /* ignore */ }
      for (const s of scan1) { try { s.sw.close() } catch { /* ignore */ } }

      // ---- X16: 시크릿 탭은 어떤 확장 세션에도 보이지 않는다(SW 자체가 안 생긴다) ----
      const swCountBefore = (await getTargetList(args.port)).filter((t) => String(t.url).endsWith('/sw.js')).length
      const beforeShellIds = new Set((await getTargetList(args.port)).filter(isShellTarget).map((t) => t.id))
      const incogRan = await evalIn(shell, `window.browserAPI.actions.run('action.window.incognito', {}).then(r=>String(r))`, true)
      let incogWindowId = null, incogUrl = null, incogSession = null
      if (incogRan === 'true') {
        const newShellTarget = await pollUntil(async () => {
          const l = await getTargetList(args.port)
          return l.find((t) => isShellTarget(t) && !beforeShellIds.has(t.id)) ?? null
        }, { timeoutMs: 10000, label: 'X16 시크릿 창 외피 타깃' }).catch(() => null)
        if (newShellTarget) {
          incogSession = await connectSession(newShellTarget, 'chrome-incognito')
          await ensureSessionReady(incogSession)
          incogWindowId = new URL(newShellTarget.url).searchParams.get('windowId')
          if (incogWindowId) {
            await evalIn(incogSession,
              `window.browserAPI.tabs.create(${JSON.stringify(incogWindowId)}, ${JSON.stringify(pages.url + '?x14incog')})`, true)
            await sleep(3000)
            incogUrl = (await getTargetList(args.port)).find((t) => String(t.url).includes('?x14incog'))?.url ?? null
          }
        }
      }
      const swCountAfter = (await getTargetList(args.port)).filter((t) => String(t.url).endsWith('/sw.js')).length
      let incogLeak = -1
      if (incogUrl) {
        const scan2Targets = (await getTargetList(args.port)).filter((t) => String(t.url).endsWith('/sw.js'))
        let leak = 0
        for (let i = 0; i < scan2Targets.length; i++) {
          const sw = await connectSession(scan2Targets[i], `sw-x16-${i}`)
          await ensureSessionReady(sw)
          const seenRaw = await evalIn(sw, `chrome.tabs.query({}).then(
            (ts) => JSON.stringify(ts.map((t) => String(t.url || '')))
          ).catch(() => '[]')`, true)
          const seen = JSON.parse(seenRaw ?? '[]')
          if (seen.includes(incogUrl)) leak++
          try { sw.close() } catch { /* ignore */ }
        }
        incogLeak = leak
      }

      check('X16', '시크릿 탭은 어떤 확장 세션에도 보이지 않는다(확장이 시크릿에 아예 안 실린다)',
        judgeX16Incognito({ incogRan, incogWindowId, incogUrl, swCountBefore, swCountAfter, incogLeak }),
        `action.window.incognito 실행=${incogRan} · 시크릿 windowId=${incogWindowId ?? '(없음)'}`
        + ` · 시크릿 탭 URL=${incogUrl ?? '(없음)'} · SW 타깃 수 ${swCountBefore}→${swCountAfter}(같아야 — 새 SW 없음)`
        + ` · 기존 SW 중 시크릿 탭 목격 ${incogLeak}건(0 이어야, -1 이면 시크릿 탭 자체를 못 만듦)`)

      // ---- X25: 시크릿 탭이 executeScript 로 **실제로 변조되는가** (X16 의 짝) ----
      //
      // 왜 (2026-09-15): X16 은 "확장이 시크릿 탭을 **보지** 못한다" 까지만 증명한다. 그런데 X15 에서
      // 드러난 Electron 구현은 목록을 거치지 않는다 — v35.7.5
      // `shell/browser/extensions/api/scripting/scripting_api.cc` 의 `CanAccessTarget` 은
      // 탭을 `electron::api::WebContents::FromID(target.tab_id)`(**프로세스 전역 레지스트리**)로 풀고,
      // 넘겨받은 `browser_context` · `include_incognito_information` 인자를 **한 번도 쓰지 않는다**
      // (원본 Chromium 은 같은 자리에서 `ExtensionTabUtil::GetTabById(..., browser_context, include_incognito, ...)`
      // 로 프로필 범위를 건다). 남는 관문은 `HasPermissionToInjectIntoFrame` →
      // `permissions.CanAccessPage(committed_url, ...)` 즉 **대상 URL 에 대한 host 권한**뿐이다.
      // 따라서 "목록에 안 보이는 탭" 이라도 id 만 맞히면 브라우저 프로세스 단계는 통과한다.
      //
      // 그래서 사용자 영향이 가장 큰 질문을 직접 잰다 — **시크릿 페이지가 실제로 바뀌는가.**
      // 공격자 모델 그대로 작은 정수를 훑는다(확장이 다른 세션 탭의 id 를 조회할 길은 X14 가 막았으므로
      // 남는 경로는 추측뿐이다). 시크릿 탭의 id 를 확실히 훑었다는 것은 **훑은 범위 위쪽이 전부
      // "No tab with id"** 라는 사실로 보인다(살아 있는 id 구간을 소진했다는 증거).
      //
      // 빈 검사 방지(양성 대조): 같은 훑기가 **다른 워크스페이스의 새 탭**에는 실제로 주입돼야 한다.
      // 그게 없으면 "시크릿이 안 뚫렸다" 와 "훑기 자체가 안 먹혔다" 를 구분할 수 없다.
      // 이 대조는 동시에 X15 의 교차 세션 누출을 **id 추측 경로로** 한 번 더 확인해 준다.
      let x25 = { ran: false, ctrlBefore: null, ctrlAfter: null, incogBefore: null, incogAfter: null, note: '(시크릿 탭 없음)' }
      if (incogUrl) {
        const readMarks = async (url) => {
          const t = (await getTargetList(args.port)).find((x) => x.url === url)
          if (!t) return { scripted: '(타깃 없음)', injected: '(타깃 없음)' }
          const s = await connectSession(t, 'x25-read')
          await ensureSessionReady(s)
          const scripted = await evalIn(s, 'document.documentElement.getAttribute("data-ext-scripted")')
          const injected = await evalIn(s, 'document.documentElement.getAttribute("data-ext-injected")')
          try { s.close() } catch { /* ignore */ }
          return { scripted, injected }
        }

        // 대조용 새 탭 — 워크스페이스 A 에. 콘텐츠 스크립트는 받지만(=확장이 그 세션에 실려 있음)
        // executeScript 는 아직 안 당한 상태여야 대조가 성립한다.
        await evalIn(shell,
          `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pages.url + '?x25ctrl')})`, true)
        await sleep(2500)
        const ctrlUrl = (await getTargetList(args.port)).find((t) => String(t.url).includes('?x25ctrl'))?.url ?? null
        x25.ctrlUrl = ctrlUrl

        // 훑을 SW 를 고른다 — **대조 탭을 보지 못하는** 세션(= 다른 워크스페이스)의 SW 를 우선한다.
        // 세션 판별은 X14 가 옳음을 보인 세션별 탭 레지스트리(chrome.tabs.query)로 한다.
        const swAll = (await getTargetList(args.port)).filter((t) => String(t.url).endsWith('/sw.js'))
        const opened = []
        for (let i = 0; i < swAll.length; i++) {
          const s = await connectSession(swAll[i], `sw-x25-${i}`)
          await ensureSessionReady(s)
          const seenRaw = await evalIn(s,
            `chrome.tabs.query({}).then((ts)=>JSON.stringify(ts.map(t=>String(t.url||'')))).catch(()=>'[]')`, true)
          opened.push({ s, seen: JSON.parse(seenRaw ?? '[]') })
        }
        // 훑기는 **열려 있는 모든 확장 세션에서** 돌린다(2026-09-15 Electron 42 판올림 후 변경).
        // 왜: 예전에는 "대조 탭을 못 보는 다른 세션" 하나만 골라 훑었다. 그 설계는 교차 세션 id 해석이
        // 새던 시절(Electron 35)에만 성립한다 — 판올림으로 그 구멍이 막히자 **양성 대조(대조 탭 주입)가
        // 영영 서지 않아** X25·X26 이 통째로 빈 검사가 됐다(실측 FAIL). 공격자 모델을 약화한 것이 아니라
        // **넓혔다**: 이제 모든 세션이 각자 id 를 추측하므로, 시크릿·외피에 닿을 수 있는 세션이 하나라도
        // 있으면 그 세션이 잡아낸다. 양성 대조는 "대조 탭을 제 세션이 실제로 주입한다" 로 선다.
        const probes = opened
        const foreignCount = ctrlUrl ? opened.filter((o) => !o.seen.includes(ctrlUrl)).length : 0

        const before = await Promise.all([readMarks(ctrlUrl ?? ''), readMarks(incogUrl)])
        x25.ctrlBefore = before[0].scripted
        x25.incogBefore = before[1].scripted
        x25.incogInjectedBefore = before[1].injected

        const MAXID = 140
        let sweep = { ok: [], noTab: [], other: [] }
        const perSession = []
        for (let pi = 0; pi < probes.length; pi++) {
          const probe = probes[pi]
          const raw = await evalIn(probe.s, `(async () => {
            const ids = Array.from({ length: ${MAXID} }, (_, i) => i + 1)
            const res = await Promise.all(ids.map(async (id) => {
              try {
                await chrome.scripting.executeScript({ target: { tabId: id }, files: ['injected.js'] })
                return [id, 'ok']
              } catch (e) { return [id, String((e && e.message) || e)] }
            }))
            const out = { ok: [], noTab: [], other: [] }
            for (const [id, m] of res) {
              if (m === 'ok') out.ok.push(id)
              else if (m.indexOf('No tab with id') >= 0) out.noTab.push(id)
              else out.other.push(id + ': ' + m.slice(0, 70))
            }
            return JSON.stringify(out)
          })()`, true)
          let one = { ok: [], noTab: [], other: [] }
          try { one = JSON.parse(raw ?? '{}') } catch { /* 형태가 깨지면 빈 값 그대로 */ }
          perSession.push(one)
          x25.ran = true
        }
        // 합치기: ok 는 합집합(한 세션이라도 닿았으면 닿은 것), noTab 은 **모든 세션이** 못 찾은 id 만,
        // other 는 세션 표시를 붙여 전부 싣는다(어느 세션이 무엇으로 막혔는지가 진단의 핵심이다).
        {
          const okSet = new Set()
          const otherIds = new Set()
          const others = []
          for (let pi = 0; pi < perSession.length; pi++) {
            for (const id of perSession[pi].ok ?? []) okSet.add(id)
            for (const s of perSession[pi].other ?? []) {
              others.push(`s${pi}#${s}`)
              const n = Number(String(s).split(':')[0]); if (n > 0) otherIds.add(n)
            }
          }
          const noTab = []
          for (let id = 1; id <= MAXID; id++) {
            if (!okSet.has(id) && !otherIds.has(id)) noTab.push(id)
          }
          sweep = { ok: [...okSet].sort((a, b) => a - b), noTab, other: others }
        }
        await sleep(900)

        // 진단 — 살아 있는 id 가 각각 **어느 페이지인지** 매핑하고, 같은 API 의 다른 경로(`func`)로
        // **코드가 실제로 도는지** 를 한 번 더 본다. 반환값이 오면 그 탭에서 코드가 실행된 것이다.
        // (DOM 표식만 보면 "주입은 됐는데 표식이 안 남은" 경우와 구분할 수 없다. 여기서 시크릿 탭의
        //  URL 이 되돌아오면 그건 시크릿 페이지에서 확장 코드가 돌았다는 직접 증거이므로 실패로 본다.)
        let map = []
        for (let pi = 0; pi < probes.length; pi++) {
          const probe = probes[pi]
          // 그 세션이 **직접** 살아 있다고 본 id 만 매핑한다(세션마다 id 공간이 다르므로 합집합을 쓰면
          // 남의 id 를 자기 세션에 물어보는 꼴이 되어 진단이 흐려진다).
          const liveIds = [...(perSession[pi]?.ok ?? []),
            ...(perSession[pi]?.other ?? []).map((s) => Number(String(s).split(':')[0]))].filter((n) => n > 0)
          if (!liveIds.length) continue
          const raw2 = await evalIn(probe.s, `(async () => {
            const ids = ${JSON.stringify(liveIds)}
            const res = await Promise.all(ids.map(async (id) => {
              try {
                const r = await chrome.scripting.executeScript({
                  target: { tabId: id }, func: () => {
                    const t = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').slice(0, 300)
                    const v = Array.from(document.querySelectorAll('input')).map((i) => i.value || '').join(' ').slice(0, 200)
                    return String(location.href) + '|||' + t + ' ' + v
                  } })
                if (!r || !r.length) return [id, 'ran-no-result:(결과 배열이 비었다 — 렌더러가 주입을 버렸다)']
                return [id, 'ran:' + String(r[0].result == null ? '(결과없음)' : r[0].result)]
              } catch (e) { return [id, 'err:' + String((e && e.message) || e).slice(0, 90)] }
            }))
            return JSON.stringify(res)
          })()`, true)
          try { map = map.concat((JSON.parse(raw2 ?? '[]') ?? []).map(([id, v]) => [`s${pi}#${id}`, v])) }
          catch { /* 형태가 깨지면 빈 값 */ }
        }
        // 'ran:<href>|||<본문 발췌>' 를 갈라 **어느 페이지에서 돌았는지(href)** 와
        // **무엇을 읽어냈는지(본문)** 를 나눈다. 둘을 섞으면 "시크릿 탭에서 돌았다" 와
        // "시크릿 창의 외피에서 시크릿 탭 주소를 읽었다" 를 구분할 수 없다.
        const parsed = map.map(([id, v]) => {
          const s = String(v)
          if (!s.startsWith('ran:')) return { id, ran: false, raw: s, href: '', body: '' }
          const rest = s.slice(4)
          const cut = rest.indexOf('|||')
          return { id, ran: true, raw: s, href: cut < 0 ? rest : rest.slice(0, cut), body: cut < 0 ? '' : rest.slice(cut + 3) }
        })
        x25.parsed = parsed
        x25.incogCodeRan = parsed.some((p) => p.ran && p.href === incogUrl) // **그 탭 자체**에서 돌았는가
        x25.funcSupported = parsed.some((p) => p.ran)
        const short = (u) => String(u).replace(incogUrl, '⟪시크릿탭⟫')
          .replace(ctrlUrl ?? ' ', '⟪대조탭⟫').replace(pages.url, '/')
          .replace(/^file:\/\/.*$/, '⟪외피(브라우저 UI)⟫')
        x25.mapNote = parsed.map((p) => `${p.id}=${p.ran ? short(p.href) : p.raw.slice(0, 46)}`).join(' | ')

        const after = await Promise.all([readMarks(ctrlUrl ?? ''), readMarks(incogUrl)])
        x25.ctrlAfter = after[0].scripted
        x25.incogAfter = after[1].scripted
        x25.sweep = sweep
        x25.sweptSessions = probes.length
        x25.foreignSessions = foreignCount
        const okIds = sweep.ok ?? []
        // other 항목은 `s<세션>#<id>: <메시지>` 형태다 — 세션 접두를 떼고 id 만 뽑는다
        // (안 떼면 NaN→0 이 되어 "살아 있는 id 구간을 소진했는가" 판정이 조용히 헐거워진다).
        const otherIdOf = (s) => Number(String(s).replace(/^s\d+#/, '').split(':')[0]) || 0
        const liveMax = Math.max(0, ...okIds, ...(sweep.other ?? []).map(otherIdOf))
        x25.note = `훑은 id 1~${MAXID} · 주입 성공 ${okIds.length}개(최대 살아있는 id ${liveMax})`
          + ` · "No tab with id" ${(sweep.noTab ?? []).length}개 · 기타 오류 ${(sweep.other ?? []).length}개`
          + `${(sweep.other ?? []).length ? ` [${(sweep.other ?? []).join(' / ')}]` : ''}`
          + ` · 살아 있는 id 구간을 소진했는가(=최대 살아있는 id 위쪽이 전부 no-tab): ${liveMax < MAXID ? '예' : '아니오(범위 부족)'}`
        for (const o of opened) { try { o.s.close() } catch { /* ignore */ } }
      }

      check('X25', '확장이 id 를 추측해도 **시크릿 탭의 DOM 은 바꾸지 못한다**(executeScript 실제 변조)',
        judgeX25IncognitoInjection(x25),
        `${x25.note} · 훑은 확장 세션 ${x25.sweptSessions ?? 0}개(그중 대조 탭을 못 보는 다른 세션 ${x25.foreignSessions ?? 0}개)`
        + ` · [양성 대조] 다른 워크스페이스 새 탭 표식 ${x25.ctrlBefore ?? '(없음)'}→${x25.ctrlAfter ?? '(없음)'}(yes 여야 — 훑기가 실제로 먹혔다는 증거)`
        + ` · [본 검사] 시크릿 탭 표식 ${x25.incogBefore ?? '(없음)'}→${x25.incogAfter ?? '(없음)'}(끝까지 없어야)`
        + ` · [본 검사2] 시크릿 탭에서 코드가 실행됨=${x25.incogCodeRan ?? '(모름)'}(false 여야`
        + `${x25.funcSupported === false ? ' — ⚠ func 경로가 어디서도 안 돌아 매핑 불가' : ''})`
        + ` · 시크릿 탭 콘텐츠 스크립트 표식=${x25.incogInjectedBefore ?? '(없음)'}(없어야 — 확장이 시크릿에 안 실린다)`
        + ` · id→페이지 매핑: ${x25.mapNote ?? '(없음)'}`)

      // ---- X26: 확장이 **브라우저 외피(UI) 렌더러**에는 주입하지 못한다 ----
      //
      // 왜 (2026-09-15, X25 의 매핑이 드러낸 것): 외피(탭바·주소창·사이드패널)는 `file://` 로 로드되는
      // **또 하나의 webContents** 다. Electron 의 scripting 은 탭 id 를 전역으로 풀므로(X15 의 원인)
      // 확장이 작은 정수를 맞히면 여기에도 닿는다. 그리고 외피 DOM 에는 **그 창의 탭 제목과 주소창 값**이
      // 들어 있다 — 즉 시크릿 창의 외피까지 닿으면, 확장은 시크릿 탭 **안**을 못 건드려도(X25)
      // **무엇을 보고 있는지는 읽어낼 수 있다**. X16·X25 가 닫은 문 옆의 창문이다.
      //
      // 빈 검사 방지 두 겹: ① 외피를 실제로 **시도했다는 증거**(성공이든 거부든 file:// 응답)가 있어야 하고
      // ② 같은 훑기가 일반 탭에서는 계속 성공해야 한다(대조). 둘 중 하나라도 없으면 실패로 본다.
      const p26 = x25.parsed ?? []
      const x26 = {
        ran: !!x25.ran,
        shellAttempted: p26.some((p) => String(p.ran ? p.href : p.raw).includes('file://')),
        shellRan: p26.some((p) => p.ran && String(p.href).startsWith('file://')),
        controlRan: p26.some((p) => p.ran && p.href === (x25.ctrlUrl ?? ' ')),
      }
      // 외피에서 읽어낸 본문에 **시크릿 탭의 주소**가 들어 있으면, 추상적 위험이 아니라 실제 유출이다.
      const incogInfoLeak = p26.filter((p) => p.ran && String(p.href).startsWith('file://') && p.body.includes('x14incog'))

      check('X26', '확장이 브라우저 외피(UI) 렌더러에 코드를 주입하지 못한다(시크릿 창의 외피 포함)',
        judgeX26ShellInjection(x26),
        `외피를 실제로 시도했는가=${x26.shellAttempted}(true 여야 — 아니면 빈 검사)`
        + ` · [대조] 일반 탭에서는 여전히 실행됨=${x26.controlRan}(true 여야)`
        + ` · [본 검사] 외피에서 코드가 실행됨=${x26.shellRan}(false 여야)`
        + ` · 외피에서 읽어낸 본문에 시크릿 탭 주소가 들어 있는 건수=${incogInfoLeak.length}(0 이어야)`
        + `${incogInfoLeak.length ? ` ← 유출 예: id ${incogInfoLeak[0].id} 본문 "${incogInfoLeak[0].body.slice(0, 120)}"` : ''}`)

      try { incogSession?.close() } catch { /* ignore */ }

      // ---- X24: 창을 "실제로 닫은" 직후에도 워크스페이스 전환이 살아남는가 ----
      // 이전 라운드는 여기서 **일부러 창을 닫지 않았다** — 당시 떠 있던 exe 에 수정이 미반영이라
      // 닫으면 실패했기 때문이다. 그 회피를 남겨 두면 app/main/ipc/workspace.ts 의 가드는
      // 영원히 한 번도 검사되지 않는다(고친 줄에 검사가 없는 상태). 수정이 들어간 빌드에서는
      // 실제로 닫고 곧바로 전환해 확인한다.
      //
      // 원래 증상: 창을 닫은 직후 workspace.activate() 를 부르면 'changed' 브로드캐스트가
      // 파괴된 ctx.chrome.webContents 에 .send() 하려다 던지고, ipcMain.handle 이 그대로
      // reject 되어 **렌더러의 전환 호출이 통째로 실패**한다.
      const x24Cycles = []
      const x24Failures = []
      {
        const switchTargets = [wsB?.id, idA].filter(Boolean)
        for (let cycle = 0; cycle < 3 && switchTargets.length === 2; cycle++) {
          // 1) 닫을 창 확보 — 첫 바퀴는 X16 이 연 시크릿 창을 그대로 쓰고, 이후엔 새로 연다.
          let victimId = cycle === 0 ? incogWindowId : null
          if (!victimId) {
            const before = new Set((await getTargetList(args.port)).filter(isShellTarget).map((t) => t.id))
            await evalIn(shell, `window.browserAPI.actions.run('action.window.incognito', {}).then(r=>String(r))`, true)
            const t = await pollUntil(async () => {
              const l = await getTargetList(args.port)
              return l.find((x) => isShellTarget(x) && !before.has(x.id)) ?? null
            }, { timeoutMs: 10000, label: `X24 시크릿 창 ${cycle}` }).catch(() => null)
            victimId = t ? new URL(t.url).searchParams.get('windowId') : null
          }
          if (!victimId) { x24Failures.push(`바퀴 ${cycle}: 닫을 창을 못 만들었다`); break }

          // 2)+3) 창을 실제로 닫고(사용자의 Ctrl+Shift+W 와 같은 경로 — action.window.close),
          //    **닫힘이 끝나기를 기다리지 않고** 그 생애주기 내내 워크스페이스 전환을 쉬지 않고 두드린다.
          //    결함은 "창의 webContents 는 이미 죽었는데 창 레지스트리엔 아직 남아 있는" 짧은 순간에만
          //    나므로, 닫은 뒤 한 번만 전환하면 그 순간을 지나쳐 **빈 검사**가 된다(실측: 한 번만 부르면
          //    가드를 빼도 통과했다). close 를 await 하지 않고 시작한 뒤 마감 시각까지 반복해 창을 연다.
          //    전부 살아남는 메인 외피에서 부른다 — 닫히는 창 자신의 세션으로 부르면 응답이 오지 않는다.
          const raw = await evalIn(shell, `(async () => {
            const errs = []
            let n = 0, closed = 'pending'
            const closeP = window.browserAPI.actions.run('action.window.close', { windowId: ${JSON.stringify(victimId)} })
              .then((r) => { closed = String(r) }).catch((e) => { closed = 'ERR: ' + String((e && e.message) || e) })
            const deadline = Date.now() + 2500
            const ids = ${JSON.stringify(switchTargets)}
            while (Date.now() < deadline) {
              try { await window.browserAPI.workspace.activate(ids[n % 2]) }
              catch (e) { errs.push(String((e && e.message) || e)) }
              n++
            }
            await closeP
            return JSON.stringify({ n, closed, errs: errs.slice(0, 2), errCount: errs.length })
          })()`, true)
          const r = JSON.parse(raw ?? '{}')
          x24Cycles.push(`#${cycle} 닫기=${r.closed} 전환 ${r.n}회 중 실패 ${r.errCount}건`)
          if (r.errCount > 0) x24Failures.push(`바퀴 ${cycle}: ${(r.errs || []).join(' / ')}`)
          if (!(r.n > 0)) x24Failures.push(`바퀴 ${cycle}: 전환을 한 번도 못 불렀다`)
          await sleep(400)
        }

        // 4) 두 번째 방아쇠 — **창은 살아 있는데 외피 렌더러(webContents)만 사라진** 상태.
        //    위 (2)+(3) 은 가드를 빼도 통과한다(실측: 닫기 3바퀴 × 전환 ~1250회, 실패 0건).
        //    정상적인 창 닫기는 'closed' 에서 레지스트리를 지우므로 브로드캐스트가 죽은 창을
        //    만날 틈이 사실상 없기 때문이다. 가드가 실제로 값을 하는 경우는 이쪽 —
        //    창은 레지스트리에 남아 있는데 그 chrome 뷰의 webContents 가 먼저 사라진 상태
        //    (외피 렌더러 크래시와 같은 모양)다. CDP 로 외피 타깃만 닫아 그 상태를 만든다.
        //    ✔ 음성 대조로 확인(2026-09-15): 가드를 빼고 재빌드·재패키징하면 여기서
        //      `TypeError: Cannot read properties of undefined (reading 'send')` 로 FAIL 한다.
        //      게다가 이건 경합이 아니라 **영구 상태**다 — 창이 레지스트리에 계속 남아 있어
        //      그 뒤 모든 워크스페이스 전환이 실패한다(그 실행에서 뒤따르는 검사들도 함께 무너졌다).
        const beforeShells = (await getTargetList(args.port)).filter(isShellTarget)
        let victimShell = null
        if (beforeShells.length > 0) {
          const beforeIds = new Set(beforeShells.map((t) => t.id))
          await evalIn(shell, `window.browserAPI.actions.run('action.window.incognito', {}).then(r=>String(r))`, true)
          victimShell = await pollUntil(async () => {
            const l = await getTargetList(args.port)
            return l.find((x) => isShellTarget(x) && !beforeIds.has(x.id)) ?? null
          }, { timeoutMs: 10000, label: 'X24 외피만 죽일 창' }).catch(() => null)
        }
        if (victimShell) {
          // 창은 그대로 두고 외피 webContents 만 파괴한다.
          await fetch(`http://127.0.0.1:${args.port}/json/close/${victimShell.id}`).catch(() => null)
          await sleep(1200)
          const res = await evalIn(shell, `(async () => {
            try { await window.browserAPI.workspace.activate(${JSON.stringify(switchTargets[0])}); return 'ok' }
            catch (e) { return 'ERR: ' + String((e && e.message) || e) }
          })()`, true)
          x24Cycles.push(`#외피만파괴 전환=${res}`)
          if (String(res) !== 'ok') x24Failures.push(`외피만 파괴된 창이 남아 있을 때: ${res}`)
        } else {
          x24Failures.push('외피만 파괴할 창을 만들지 못했다')
        }

        // 뒤 검사들이 워크스페이스 A 를 전제로 하므로 되돌려 놓는다.
        await evalIn(shell, `(async () => {
          try { await window.browserAPI.workspace.activate(${JSON.stringify(idA)}); return 'ok' }
          catch (e) { return 'ERR' }
        })()`, true)
        await sleep(800)
      }
      const x24State = JSON.parse(await evalIn(shell,
        'window.browserAPI.workspace.state().then(s=>JSON.stringify(s)).catch(()=>"{}")', true) ?? '{}')

      check('X24', '창을 실제로 닫은 직후에도 워크스페이스 전환이 살아남는다(파괴된 창 브로드캐스트 가드)',
        judgeX24CloseThenSwitch({
          cycles: x24Cycles, failures: x24Failures,
          finalActiveId: x24State.activeId ?? null, expectedActiveId: idA,
        }),
        `닫기→전환 ${x24Cycles.length}바퀴: ${x24Cycles.join(' | ') || '(한 바퀴도 못 돌았다)'}`
        + ` · 실패 ${x24Failures.length}건${x24Failures.length ? ': ' + x24Failures.join(' / ') : ''}`
        + ` · 최종 활성 워크스페이스=${x24State.activeId ?? '(없음)'}(A=${idA} 여야)`)
    }

    // ════════════════════════════════════════════════════════════════════
    // (5) browser://extensions 페이지 — 이후 모든 생애주기 전환에서 카드를 다시 읽는다.
    // ════════════════════════════════════════════════════════════════════
    let extPage = null
    {
      await evalIn(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, "browser://extensions")`, true)
      // 정확한 문자열 일치(===) 대신 startsWith — 리다이렉트/트레일링 슬래시 등으로 URL 이
      // 살짝 달라져도(예: "browser://extensions/") 놓치지 않는다. 폴링으로 타이밍도 흡수.
      const extPageTarget = await pollUntil(async () => {
        const l = await getTargetList(args.port)
        return l.find((t) => t.type === 'page' && String(t.url).startsWith('browser://extensions')) ?? null
      }, { timeoutMs: 10000, intervalMs: 400, label: 'browser://extensions 탭 CDP 타깃' }).catch(() => null)
      extPage = extPageTarget ? await connectSession(extPageTarget, 'page-extensions') : null
      if (extPage) await ensureSessionReady(extPage)
      if (!extPage) console.warn('  ⚠ browser://extensions 탭을 못 찾음 — claim(5) UI 검사가 전부 null 로 나올 것')
    }

    // ---- X5 양성 대조: 확장을 끄면 차단이 사라진다 (기존 검사, 워크스페이스 A 에서) ----
    {
      if (id) {
        await evalIn(shell, `window.browserAPI.extensions.setEnabled(${JSON.stringify(id)}, false)`, true).catch(() => null)
        await sleep(1500)
      }
      pages.resetHits()
      const { page: p2 } = await openPage('?x5')
      const adLoaded2 = p2 ? await evalIn(p2, 'window.__adLoaded === true') : null
      const injected2 = p2 ? await evalIn(p2, 'document.documentElement.getAttribute("data-ext-injected")') : null
      const mark2 = p2 ? await evalIn(p2, '(document.getElementById("mark")||{}).textContent') : null
      try { p2?.close() } catch { /* ignore */ }
      // X1 의 **양성 대조** — 확장을 끄면 차단이 사라져야 한다.
      // 이게 없으면 X1 은 "확장과 무관하게 요청이 안 갔을" 가능성과 구분되지 않는다.
      check('X5', '확장을 끄면 차단이 사라진다(X1 의 양성 대조)',
        adLoaded2 === true || pages.adHits > 0,
        `광고 로드=${adLoaded2} · 서버 적중 ${pages.adHits}회`)
      // X2 의 짝. 끈 확장이 계속 주입한다면 "끄기" 가 이름뿐이라는 뜻이고,
      // 반대로 이 검사가 없으면 X2 는 "우리와 무관하게 페이지가 원래 그랬을" 가능성과 구분되지 않는다.
      // ⚠ 동작 한계(의도된 것 — 크롬과 같다): 이 검사는 **끈 뒤에 새로 연 문서**를 본다.
      //    확장이 **이미 바꿔 놓은** 기존 탭의 DOM 은 끈다고 소급 복원되지 않는다(되돌릴 방법이 없다).
      //    그래서 여기서 새 탭을 열어 확인하는 것이며, 이 한계는 browser://extensions 안내문에도 적어 두었다.
      check('X10', '확장을 끄면 콘텐츠 스크립트 주입도 멈춘다(X2 의 양성 대조)',
        !injected2 && String(mark2) === '원본',
        `주입 표식=${injected2 ?? '(없음)'} · 본문="${mark2}"(원본이어야)`)
    }

    // ════════════════════════════════════════════════════════════════════
    // (4) 확장 생애주기 — disable → re-enable → (단일 세션 강제 실패) → 재시작 → remove → 재시작
    // ════════════════════════════════════════════════════════════════════

    // ---- X17: disable 이 "모든 비-시크릿 세션" 에서 실제로 멈춘다 ----
    // X5/X10 은 워크스페이스 A 만 봤다 — 여기서는 **B 도** 같은 disable 이 적용됐는지, 그리고
    // browser://extensions 페이지가 그 사실을 data-enabled/data-loaded 로 정확히 보여주는지 본다.
    {
      await evalIn(shell, `window.browserAPI.workspace.activate(${JSON.stringify(wsB.id)})`, true)
      await sleep(500)
      pages.resetHits()
      const { page: pB3 } = await openPage('?x17b')
      const adB = pB3 ? await evalIn(pB3, 'window.__adLoaded === true') : null
      const injB = pB3 ? await evalIn(pB3, 'document.documentElement.getAttribute("data-ext-injected")') : null
      try { pB3?.close() } catch { /* ignore */ }
      await evalIn(shell, `window.browserAPI.workspace.activate(${JSON.stringify(idA)})`, true)
      await sleep(500)

      const swAfterDisable = (await getTargetList(args.port)).filter((t) => String(t.url).endsWith('/sw.js')).length
      const cardDisabled = await reloadAndReadCard(extPage, id)

      check('X17', 'disable — DNR 차단·SW·주입이 모든 비-시크릿 세션에서 실제로 멈추고 페이지도 그걸 보여준다',
        judgeX17Disable({
          adBlockedGoneB: adB, injectedGoneB: injB, swAfterDisable,
          cardEnabled: cardDisabled?.enabled ?? null, cardLoaded: cardDisabled?.loaded ?? null,
        }),
        `워크스페이스B 광고로드=${adB}(true=차단없음이어야) · 주입=${injB ?? '(없음)'}(없어야) · SW 타깃 수=${swAfterDisable}(0 이어야)`
        + ` · 페이지 data-enabled=${cardDisabled?.enabled} data-loaded=${cardDisabled?.loaded}`
        + ` · pill="${cardDisabled?.pillText ?? ''}"`)
    }

    // ---- X18/X21: re-enable — 모든 세션에서 다시 동작 + 페이지가 건강한 상태를 정확히 보여준다 ----
    let expectedTotalSessions = 0
    {
      await evalIn(shell, `window.browserAPI.extensions.setEnabled(${JSON.stringify(id)}, true)`, true).catch(() => null)
      await sleep(2500)

      pages.resetHits()
      const { page: pA4 } = await openPage('?x18a')
      const adA = pA4 ? await evalIn(pA4, 'window.__adLoaded === true') : null
      const injA = pA4 ? await evalIn(pA4, 'document.documentElement.getAttribute("data-ext-injected")') : null
      try { pA4?.close() } catch { /* ignore */ }

      await evalIn(shell, `window.browserAPI.workspace.activate(${JSON.stringify(wsB.id)})`, true)
      await sleep(500)
      pages.resetHits()
      const { page: pB4 } = await openPage('?x18b')
      const adB = pB4 ? await evalIn(pB4, 'window.__adLoaded === true') : null
      const injB = pB4 ? await evalIn(pB4, 'document.documentElement.getAttribute("data-ext-injected")') : null
      try { pB4?.close() } catch { /* ignore */ }
      await evalIn(shell, `window.browserAPI.workspace.activate(${JSON.stringify(idA)})`, true)
      await sleep(500)

      const swAfterEnable = (await getTargetList(args.port)).filter((t) => String(t.url).endsWith('/sw.js')).length
      const cardEnabled = await reloadAndReadCard(extPage, id)
      const kofn = parseKofN(cardEnabled?.loadedSessions)
      const wsListNow = JSON.parse(await evalIn(shell, 'window.browserAPI.workspace.list().then(l=>JSON.stringify(l))', true) ?? '[]')
      // 총 세션 수 = defaultSession + persist:default(항상 있음) + 워크스페이스 개수.
      expectedTotalSessions = 2 + (Array.isArray(wsListNow) ? wsListNow.length : 0)

      check('X18', 're-enable — DNR 차단·SW·주입이 모든 비-시크릿 세션에서 다시 동작한다',
        judgeX18Enable({ adBlockedA: adA === false, adBlockedB: adB === false, injectedA: injA, injectedB: injB, swAfterEnable }),
        `워크스페이스A 광고로드=${adA}(false=차단됨이어야) 주입=${injA ?? '(없음)'}`
        + ` · 워크스페이스B 광고로드=${adB}(false 여야) 주입=${injB ?? '(없음)'} · SW 타깃 수=${swAfterEnable}`)

      check('X21', 'browser://extensions 카드가 세션별 실제 로드 상태를 보여준다(N total 정확·enabled/loaded 둘 다 참)',
        judgeX21Baseline({
          cardEnabled: cardEnabled?.enabled ?? null, cardLoaded: cardEnabled?.loaded ?? null,
          kofn, expectedTotal: expectedTotalSessions, pillText: cardEnabled?.pillText,
        }),
        `data-enabled=${cardEnabled?.enabled} · data-loaded=${cardEnabled?.loaded} · data-loaded-sessions=${cardEnabled?.loadedSessions}`
        + ` · 기대 총 세션수=${expectedTotalSessions}(default+persist:default+워크스페이스 ${wsListNow.length}개)`
        + ` · pill="${cardEnabled?.pillText ?? ''}" · 세션칩 ${cardEnabled?.chips?.length ?? 0}개`)
    }

    // ---- X22: 단일 세션 강제 실패 → "일부 세션에서 실패 · k/N" + 한국어 사유로 표면화 ----
    // 제품 코드는 건드리지 않는다. 우리가 만든 **시험 확장 디렉터리**의 manifest.json **내용을
    // 깨뜨려**(파일 자체는 남겨 둔다) 그 순간 새 워크스페이스(C)를 만들어 그 세션만 로드에
    // 실패하게 한다 — 이미 로드에 성공한 세션들(A·B·default·persist:default)은 Electron 이 그
    // 시점의 Extension 객체를 그대로 들고 있어 영향을 받지 않는다. 복구는 try/finally 로 무조건
    // 한다(이후 검사가 정상 확장을 전제).
    //
    // ⚠ 파일을 **치웠다가(rename) 되돌리는** 방식은 실패로 안 이어진다 — loadEnabledInto() 가
    // `existsSync(manifest.json)` 로 먼저 걸러 버려서(app/main/extensions/adapter.ts) 파일이
    // 없으면 ses.loadExtension() 을 **시도조차 안 하고 그냥 건너뛴다** → recordLoadResult 가 한
    // 번도 안 불려 reason 이 진짜 오류가 아니라 "아직 이 세션에 불러오지 않았습니다." 로 남는다
    // (2026-09-15 에 직접 겪은 결함 — 판정 함수가 정확히 그 차이를 걸러내 FAIL 로 잡아냈다).
    // → 파일은 그대로 두고 **내용만 깨뜨려서**(existsSync 는 true, JSON.parse 가 진짜로 실패)
    //   ses.loadExtension() 이 실제로 시도되고 실제로 던지게 만든다.
    {
      const manifestPath = path.join(testExt.dir, 'manifest.json')
      const originalManifest = fs.readFileSync(manifestPath, 'utf-8')
      let wsC = null
      try {
        fs.writeFileSync(manifestPath, '{ this is not valid json')
        wsC = JSON.parse(await evalIn(shell, 'window.browserAPI.workspace.create({name:"검증C"}).then(w=>JSON.stringify(w))', true) ?? '{}')
        await sleep(3000) // setupSessionByPartition → loadEnabledInto 가 새 세션에 돌 시간
      } finally {
        fs.writeFileSync(manifestPath, originalManifest)
      }

      const card = await reloadAndReadCard(extPage, id)
      const listAfter = JSON.parse(await evalIn(shell, `window.browserAPI.extensions.list().then(l => JSON.stringify(l))`, true) ?? '[]')
      const entry = listAfter.find((e) => e.id === id)
      const cSessionEntry = entry?.sessions?.find((s) => s.partition === wsC?.partition)
      const kofn = parseKofN(card?.loadedSessions)
      const cChip = (card?.chips ?? []).find((c) => wsC?.name && String(c.text ?? '').includes(wsC.name))
      const failBoxHasKorean = /[가-힣]/.test(String(card?.failBoxText ?? ''))

      check('X22', '단일 세션 강제 실패가 enabled=true 인 채 loaded 부분 실패로 정직하게 드러난다(+한국어 사유)',
        judgeX22Partial({
          entryEnabled: entry?.enabled ?? null,
          cSessionLoaded: cSessionEntry?.loaded ?? null,
          cSessionReason: cSessionEntry?.reason ?? null,
          cardEnabled: card?.enabled ?? null,
          kofn,
          pillText: card?.pillText,
          cChipLoaded: cChip?.loaded ?? null,
          failBoxHasKorean,
        }),
        `워크스페이스C=${wsC?.name ?? '(생성 실패)'} · IPC: entry.enabled=${entry?.enabled} 세션(C).loaded=${cSessionEntry?.loaded}`
        + ` reason="${cSessionEntry?.reason ?? ''}" · 페이지: data-enabled=${card?.enabled} data-loaded-sessions=${card?.loadedSessions}`
        + ` pill="${card?.pillText ?? ''}" · C 칩=${cChip ? `${cChip.text}(loaded=${cChip.loaded})` : '(못 찾음)'}`
        + ` · fail-box(발췌)="${String(card?.failBoxText ?? '').slice(0, 160)}"`)
    }

    // ---- 재시작 헬퍼: 우아하게 종료(Browser.close) 후 같은 프로필로 재기동 ----
    // 강제 kill 은 세션 파일을 지저분하게 남겨 다음 부팅의 복원 모달이 CDP 를 막을 수 있다
    // (기존 하네스들의 확립된 패턴 — verify-all 의 finally 블록과 동일한 절차).
    const restartApp = async (logName) => {
      try { extPage?.close() } catch { /* ignore */ }
      try { shell?.close() } catch { /* ignore */ }
      try {
        const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
        const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser-restart')
        await b.send('Browser.close').catch(() => {})
        b.close()
      } catch { /* ignore */ }
      await new Promise((resolve) => {
        let done = false
        const finish = () => { if (!done) { done = true; resolve() } }
        child.once('exit', finish)
        setTimeout(finish, 8000)
      })
      await sleep(1000)
      const ls = fs.createWriteStream(path.join(args.out, logName))
      child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
        { stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.pipe(ls); child.stderr.pipe(ls)
      shell = await connectShellSessionReady(args.port)
      windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
      await sleep(4000) // initExtensions() 가 부팅 1.5초 뒤 돌고, 모든 세션에 로드될 시간
    }

    // ---- X20: 재시작 후 켜져 있던 확장이 모든 비-시크릿 세션에 다시 로드된다 ----
    // (워크스페이스 C 는 X22 에서 로드가 실패했었다 — 재시작이 그것까지 바로잡는지가 핵심 증거다.
    //  manifest.json 은 X22 의 finally 에서 이미 복구했으므로, 재시작 시 처음부터 다시 시도하면
    //  이번엔 성공해야 한다.)
    {
      await restartApp('app-restart-1.log')

      const listRestart = JSON.parse(await evalIn(shell, `window.browserAPI.extensions.list().then(l => JSON.stringify(l))`, true) ?? '[]')
      const entryR = listRestart.find((e) => e.id === id)
      const wsListR = JSON.parse(await evalIn(shell, 'window.browserAPI.workspace.list().then(l=>JSON.stringify(l))', true) ?? '[]')
      const wsCPartitionR = (Array.isArray(wsListR) ? wsListR : []).find((w) => w.name === '검증C')?.partition
      const cEntryR = entryR?.sessions?.find((s) => s.partition === wsCPartitionR)
      const kofnR = parseKofN(entryR ? `${entryR.loadedSessions}/${entryR.totalSessions}` : null)

      check('X20', '재시작 후 켜져 있던 확장이 모든 비-시크릿 세션(단일세션 실패를 겪은 C 포함)에 다시 로드된다',
        judgeX20Restart({ entryEnabled: entryR?.enabled ?? null, kofn: kofnR, healedSessionLoaded: cEntryR?.loaded ?? null }),
        `재시작 후 enabled=${entryR?.enabled} · loadedSessions=${entryR?.loadedSessions}/${entryR?.totalSessions}`
        + ` · 워크스페이스C(partition=${wsCPartitionR ?? '(못 찾음)'}) loaded=${cEntryR?.loaded}`
        + `(X22 에서 실패했던 세션 — 재시작이 처음부터 다시 시도해 true 가 됐어야 한다)`)
    }

    // ---- X19: remove — 모든 세션에서 완전히 사라진다(SW·DNR·주입·목록 전부) ----
    {
      const removed = JSON.parse(await evalIn(shell, `window.browserAPI.extensions.remove(${JSON.stringify(id)}).then(r=>JSON.stringify(r))`, true) ?? '{}')
      await sleep(2000)

      const swAfterRemove = (await getTargetList(args.port)).filter((t) => String(t.url).endsWith('/sw.js') && String(t.url).includes(id)).length
      pages.resetHits()
      await evalIn(shell,
        `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pages.url + '?x19')})`, true)
      await sleep(3000)
      const target = (await getTargetList(args.port)).find((t) => String(t.url).includes('?x19'))
      const pRemoved = target ? await connectSession(target, 'page-x19') : null
      if (pRemoved) await ensureSessionReady(pRemoved)
      const adRemoved = pRemoved ? await evalIn(pRemoved, 'window.__adLoaded === true') : null
      const injRemoved = pRemoved ? await evalIn(pRemoved, 'document.documentElement.getAttribute("data-ext-injected")') : null
      try { pRemoved?.close() } catch { /* ignore */ }

      const listAfterRemove = JSON.parse(await evalIn(shell, `window.browserAPI.extensions.list().then(l => JSON.stringify(l))`, true) ?? '[]')
      const stillListed = listAfterRemove.some((e) => e.id === id)

      check('X19', 'remove — 모든 세션에서 완전히 사라진다(SW·DNR·주입·목록 전부)',
        judgeX19Remove({
          removedOk: removed?.ok ?? null, swAfterRemove, adBlockedGone: adRemoved, injectedGone: injRemoved, stillListed,
        }),
        `remove 결과=${JSON.stringify(removed)} · 그 확장 id 를 URL 에 포함한 SW 타깃=${swAfterRemove}(0 이어야)`
        + ` · 새 페이지 광고로드=${adRemoved}(true=차단없음이어야) · 주입=${injRemoved ?? '(없음)'}(없어야)`
        + ` · 목록에 여전히 존재=${stillListed}(false 여야)`)
    }

    // ---- X23: 재시작해도 제거된 확장은 되살아나지 않는다 ----
    {
      await restartApp('app-restart-2.log')

      const listFinal = JSON.parse(await evalIn(shell, `window.browserAPI.extensions.list().then(l => JSON.stringify(l))`, true) ?? '[]')
      const stillGoneAfterRestart = !listFinal.some((e) => e.id === id)
      const swFinal = (await getTargetList(args.port)).filter((t) => String(t.url).includes(id)).length

      check('X23', '재시작해도 제거된 확장은 되살아나지 않는다',
        judgeX23RestartRemoved({ stillGoneAfterRestart, swFinal }),
        `재시작 후 목록에 남아있음=${!stillGoneAfterRestart}(false 여야) · 그 확장 id 를 포함한 타깃=${swFinal}(0 이어야)`)
    }
  } catch (err) {
    console.error('[FATAL stack]', err?.stack ?? err)
    check('FATAL', '하네스 실행', false, `${err.message} @ ${String(err?.stack ?? '').split('\n')[1]?.trim() ?? '(스택 없음)'}`)
  } finally {
    try { shell?.close() } catch { /* ignore */ }
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {}); b.close()
    } catch { /* ignore */ }
    await sleep(1500)
    try { child.kill() } catch { /* ignore */ }
    await pages.close()
  }

  fs.writeFileSync(path.join(args.out, 'extension-behavior-results.json'), JSON.stringify(results, null, 2))
  console.log('\n===== verify-extension-behavior 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL')
  const gaps = results.filter((r) => r.status === 'GAP')
  console.log(`PASS=${results.length - fail.length - gaps.length} FAIL=${fail.length} GAP=${gaps.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  for (const g of gaps) console.log(`GAP ${g.id}: ${g.why}`)
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
