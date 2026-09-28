#!/usr/bin/env node
// verify-userscript-cdp.mjs — Userscript 엔진(묶음 I)을 실제 패키징된 앱 + 로컬 fixture 로 검증.
//
// 왜: 이번 라운드는 GM 값 저장소를 페이지 localStorage(item1 이전 구현) 에서 메인 프로세스 +
// 격리 월드로 옮기고, document-start 를 main 프로세스 이벤트(dom-ready) 대신 preload 동기 주입으로
// 바꿨다. 둘 다 "그럴듯해 보이지만 실제로 그런지"는 실제 브라우저 위에서 DOM 을 읽어야만 안다 —
// 순수 함수 테스트(verify-userscript-match.mjs)는 매치 패턴/파서만 본다.
//
//   U1  document-start 유저스크립트가 페이지 자신의 head 인라인 스크립트보다 먼저 돈다
//   U2  GM_setValue 로 쓴 값이 페이지 localStorage 에 **전혀** 안 남는다(item1 핵심)
//   U3  GM_getValue 가 이전 실행에서 저장한 값을 다음 내비게이션에서도 스냅샷으로 돌려준다(영속)
//   U4  @grant none 스크립트는 메인 월드에서 돌아 페이지 전역을 실제로 본다
//   U5  GM 을 쓰는 스크립트는 격리 월드에서 돌아 **자신이 만든 전역이 페이지에 안 보인다**(격리 증거)
//   U6  GM_xmlhttpRequest — 같은 origin(무 @connect)은 성공 + 실제 응답 바디를 받는다(진짜 왕복)
//   U7  GM_xmlhttpRequest — @connect 선언 없이 교차 출처를 부르면 네트워크 시도 전에 거부된다
//   U8  GM_xmlhttpRequest — @connect 에 사설망 호스트를 선언해도 교차 출처면 SSRF 가드가 막는다
//   U9  GM_xmlhttpRequest — 허용 안 되는 메서드는 거부된다
//   U10 @require 가 성공한 라이브러리는 실행되고, 실패한 것은 requireErrors 에 남되 저장은 깨지지 않는다
//   U11 @require 크기 상한을 넘으면 다운로드가 거부된다(requireErrors 에 사유)
//   U12 @resource 가 GM_getResourceText/GM_getResourceURL 로 정확히 노출된다
//   U13 @noframes — 최상위 프레임에선 돌고, 같은 origin 의 iframe 에선 안 돈다(양성 대조 포함)
//   U14 GM_registerMenuCommand — 등록→목록 조회→실행 왕복이 실제로 격리 월드의 콜백을 부른다
//   U15 @grant 선언 안 한 GM_* 는 아예 노출되지 않는다(item4) — 실행은 되지만 그 함수만 없음
//
// 사용: node build/verify-userscript-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, connectShellSessionReady, getTargetList, pollUntil, sleep, waitForPortFree } from './lib/cdp.mjs'
import { preferFreePort } from './lib/ports.mjs'
import { startUserscriptFixture } from './userscript-fixture-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9273, out: path.join(REPO, 'verify-out', 'userscript') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const results = []
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}

async function evaluate(session, expression, timeoutMs = 30_000) {
  const r = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
  }
  return r.result?.value
}

async function openTab(shell, windowId, url) {
  const before = new Set((await getTargetList(args.port)).map((t) => t.id))
  await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(url)})`)
  const target = await pollUntil(async () => {
    const list = await getTargetList(args.port)
    return list.find((t) => !before.has(t.id) && String(t.url).startsWith(url.split('?')[0])) ?? null
  }, { timeoutMs: 15_000, label: `tab ${url}` })
  const session = await connectSession(target, url)
  return session
}

async function attr(session, name) {
  return evaluate(session, `document.documentElement.getAttribute(${JSON.stringify(name)})`)
}

async function waitAttr(session, name, timeoutMs = 8000) {
  return pollUntil(async () => attr(session, name), { timeoutMs, intervalMs: 200, label: `attr ${name}` })
}

async function saveScript(admin, source) {
  return evaluate(admin, `window.internalAPI.userscript.save(${JSON.stringify({ source })})`)
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error(`exe 없음: ${EXE} — 먼저 npx electron-builder --win --dir`)
    process.exit(2)
  }
  fs.mkdirSync(args.out, { recursive: true })
  args.port = await preferFreePort(args.port, 'verify-userscript-cdp.mjs')
  if (!(await waitForPortFree(args.port))) {
    console.error(`디버그 포트 ${args.port} 사용 중`)
    process.exit(2)
  }

  const fixture = await startUserscriptFixture(args.out)
  const A = fixture.portA
  const B = fixture.portB
  const C = fixture.portC
  console.log(`[userscript] fixture A(http)=${A} B(http)=${B} C(https)=${C || '없음(openssl 실패)'}`)

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true, completedAt: Date.now(), version: 'verify-userscript' },
    startup: { mode: 'newtab', urls: [] },
  }, null, 2))

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const chromeArgs = [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`]
  if (fixture.hasHttps) chromeArgs.push('--ignore-certificate-errors') // 검증 전용 — 자체 서명 인증서
  const child = spawn(EXE, chromeArgs, { env, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.pipe(fs.createWriteStream(path.join(args.out, 'app-stdout.log')))
  child.stderr?.pipe(fs.createWriteStream(path.join(args.out, 'app-stderr.log')))

  let shell = null
  let admin = null
  try {
    shell = await connectShellSessionReady(args.port, { log: (m) => console.log(`[userscript] ${m}`) })
    const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)

    admin = await openTab(shell, windowId, 'browser://userscripts')
    await sleep(500)

    // ===== 스크립트 설치 =====
    const orderScript = await saveScript(admin, [
      '// ==UserScript==', '// @name ORDER_TEST',
      `// @match http://127.0.0.1:${A}/order*`,
      '// @grant GM_log', '// @run-at document-start',
      '// ==/UserScript==',
      "document.documentElement.setAttribute('data-us-order', (document.documentElement.getAttribute('data-us-order')||'') + 'us-start,');",
    ].join('\n'))

    const valuesScript = await saveScript(admin, [
      '// ==UserScript==', '// @name VALUES_TEST',
      `// @match http://127.0.0.1:${A}/values*`,
      '// @grant GM_getValue', '// @grant GM_setValue', '// @run-at document-idle',
      '// ==/UserScript==',
      "var v = GM_getValue('counter', 0); GM_setValue('counter', v + 1); document.documentElement.setAttribute('data-us-value', String(v + 1));",
    ].join('\n'))

    const noneScript = await saveScript(admin, [
      '// ==UserScript==', '// @name NONE_TEST',
      `// @match http://127.0.0.1:${A}/none*`,
      '// @grant none', '// @run-at document-idle',
      '// ==/UserScript==',
      "document.documentElement.setAttribute('data-us-none-sees-page', String(typeof window.__pageDefined)); document.documentElement.setAttribute('data-us-none-ran','1');",
    ].join('\n'))

    const isolatedScript = await saveScript(admin, [
      '// ==UserScript==', '// @name ISOLATED_TEST',
      `// @match http://127.0.0.1:${A}/isolated*`,
      '// @grant GM_setValue', '// @run-at document-idle',
      '// ==/UserScript==',
      "window.__isolatedMark = 'SET_BY_US'; document.documentElement.setAttribute('data-us-isolated-ran','1');",
    ].join('\n'))

    const xhrScript = await saveScript(admin, [
      '// ==UserScript==', '// @name XHR_TEST',
      `// @match http://127.0.0.1:${A}/xhrtest*`,
      '// @grant GM_xmlhttpRequest', `// @connect 127.0.0.1`, '// @run-at document-idle',
      '// ==/UserScript==',
      `function done(key, val) { document.documentElement.setAttribute('data-xhr-' + key, String(val)); }`,
      `GM_xmlhttpRequest({ url: 'http://127.0.0.1:${A}/api/echo', method: 'POST', data: 'hello-us', headers: { 'Content-Type': 'text/plain' },`,
      `  onload: function(r) { var body = {}; try { body = JSON.parse(r.responseText) } catch(e) {} done('a-ok', body.method === 'POST' && body.bodyLen === 8); },`,
      `  onerror: function() { done('a-ok', false); } });`,
      `GM_xmlhttpRequest({ url: 'http://127.0.0.1:${B}/', method: 'GET',`,
      `  onload: function() { done('c-blocked', false); }, onerror: function(r) { done('c-blocked', /사설망/.test(r.error||r.statusText||'')); } });`,
      `GM_xmlhttpRequest({ url: 'http://127.0.0.1:${A}/api/echo', method: 'TRACE',`,
      `  onload: function() { done('d-blocked', false); }, onerror: function(r) { done('d-blocked', true); } });`,
    ].join('\n'))

    const xhr2Script = await saveScript(admin, [
      '// ==UserScript==', '// @name XHR2_TEST',
      `// @match http://127.0.0.1:${A}/xhrtest2*`,
      '// @grant GM_xmlhttpRequest', '// @run-at document-idle',
      '// ==/UserScript==',
      `GM_xmlhttpRequest({ url: 'http://127.0.0.1:${B}/', method: 'GET',`,
      `  onload: function() { document.documentElement.setAttribute('data-xhr2-blocked','false'); },`,
      `  onerror: function(r) { document.documentElement.setAttribute('data-xhr2-blocked', String(/같은 사이트/.test(r.error||r.statusText||''))); } });`,
    ].join('\n'))

    let requireScript = null
    let requireBigScript = null
    let resourceScript = null
    if (C) {
      requireScript = await saveScript(admin, [
        '// ==UserScript==', '// @name REQUIRE_TEST',
        `// @match http://127.0.0.1:${A}/requiretest*`,
        '// @grant none',
        `// @require https://127.0.0.1:${C}/lib.js`,
        `// @require https://127.0.0.1:${C}/lib-404.js`,
        '// @run-at document-idle',
        '// ==/UserScript==',
        "document.documentElement.setAttribute('data-require-ran', String(window.__bbRequireRan || 0));",
      ].join('\n'))

      requireBigScript = await saveScript(admin, [
        '// ==UserScript==', '// @name REQUIRE_BIG_TEST',
        `// @match http://127.0.0.1:${A}/nowhere*`,
        '// @grant none',
        `// @require https://127.0.0.1:${C}/lib-big.js`,
        '// ==/UserScript==',
        '',
      ].join('\n'))

      resourceScript = await saveScript(admin, [
        '// ==UserScript==', '// @name RESOURCE_TEST',
        `// @match http://127.0.0.1:${A}/resourcetest*`,
        '// @grant GM_getResourceText', '// @grant GM_getResourceURL',
        `// @resource txt https://127.0.0.1:${C}/res.txt`,
        `// @resource bin https://127.0.0.1:${C}/res.bin`,
        '// @run-at document-idle',
        '// ==/UserScript==',
        "document.documentElement.setAttribute('data-res-text', GM_getResourceText('txt') || ''); document.documentElement.setAttribute('data-res-url-ok', String((GM_getResourceURL('bin')||'').indexOf('data:') === 0));",
      ].join('\n'))
    }

    const noframesScript = await saveScript(admin, [
      '// ==UserScript==', '// @name NOFRAMES_TEST',
      `// @match http://127.0.0.1:${A}/frametest*`,
      '// @grant none', '// @noframes', '// @run-at document-idle',
      '// ==/UserScript==',
      "document.documentElement.setAttribute('data-noframes-ran','1');",
    ].join('\n'))
    const allframesScript = await saveScript(admin, [
      '// ==UserScript==', '// @name ALLFRAMES_TEST',
      `// @match http://127.0.0.1:${A}/frametest*`,
      '// @grant none', '// @run-at document-idle',
      '// ==/UserScript==',
      "document.documentElement.setAttribute('data-allframes-ran','1');",
    ].join('\n'))

    const menuScript = await saveScript(admin, [
      '// ==UserScript==', '// @name MENU_TEST',
      `// @match http://127.0.0.1:${A}/menu*`,
      '// @grant GM_registerMenuCommand', '// @run-at document-idle',
      '// ==/UserScript==',
      "GM_registerMenuCommand('실행 테스트', function() { document.documentElement.setAttribute('data-menu-ran','1'); }); document.documentElement.setAttribute('data-menu-registered','1');",
    ].join('\n'))

    const grantScript = await saveScript(admin, [
      '// ==UserScript==', '// @name GRANT_TEST',
      `// @match http://127.0.0.1:${A}/xhrtest2*`,
      '// @grant GM_setValue', '// @run-at document-idle', // GM_xmlhttpRequest 는 grant 안 함
      '// ==/UserScript==',
      "document.documentElement.setAttribute('data-grant-typeof-xhr', typeof GM_xmlhttpRequest);",
    ].join('\n'))

    // ===== U1 document-start 순서 =====
    {
      const tab = await openTab(shell, windowId, `http://127.0.0.1:${A}/order`)
      await sleep(600)
      const order = await attr(tab, 'data-us-order')
      const title = await evaluate(tab, 'document.title')
      const firstIsUs = typeof order === 'string' && order.startsWith('us-start,')
      check('U1', 'document-start 유저스크립트가 페이지 head 인라인 스크립트보다 먼저 돈다', firstIsUs, `order=${JSON.stringify(order)} title=${JSON.stringify(title)}`)
    }

    // ===== U2/U3 값 저장소 =====
    {
      const tab1 = await openTab(shell, windowId, `http://127.0.0.1:${A}/values`)
      const v1 = await waitAttr(tab1, 'data-us-value')
      const ls1 = await evaluate(tab1, `(() => { try { return { len: localStorage.length, keys: Object.keys(localStorage) } } catch(e) { return { len: -1, keys: [] } } })()`)
      const noLeak = ls1.len === 0
      check('U2', 'GM_setValue 로 쓴 값이 페이지 localStorage 에 전혀 안 남는다', noLeak, `localStorage 키 ${ls1.len}개: ${JSON.stringify(ls1.keys)}`)
      await sleep(400) // 비동기 persist 왕복 대기
      const tab2 = await openTab(shell, windowId, `http://127.0.0.1:${A}/values`)
      const v2 = await waitAttr(tab2, 'data-us-value')
      check('U3', 'GM_getValue 가 이전 값을 다음 내비게이션에서도 스냅샷으로 돌려준다(영속)', v1 === '1' && v2 === '2', `1회차=${v1} 2회차=${v2}`)
    }

    // ===== U4 @grant none = 메인 월드 =====
    {
      const tab = await openTab(shell, windowId, `http://127.0.0.1:${A}/none`)
      await waitAttr(tab, 'data-us-none-ran')
      const seesPage = await attr(tab, 'data-us-none-sees-page')
      check('U4', '@grant none 스크립트는 메인 월드에서 돌아 페이지 전역을 실제로 본다', seesPage === 'string', `typeof window.__pageDefined=${seesPage}`)
    }

    // ===== U5 격리 월드 =====
    {
      const tab = await openTab(shell, windowId, `http://127.0.0.1:${A}/isolated`)
      await waitAttr(tab, 'data-us-isolated-ran')
      const leaked = await evaluate(tab, `typeof window.__isolatedMark`)
      check('U5', 'GM 사용 스크립트는 격리 월드에서 돌아 자신의 전역이 페이지에 안 보인다', leaked === 'undefined', `typeof window.__isolatedMark=${leaked}(메인 월드 기준)`)
    }

    // ===== U6~U9 GM_xmlhttpRequest =====
    {
      const tab = await openTab(shell, windowId, `http://127.0.0.1:${A}/xhrtest`)
      const aOk = await waitAttr(tab, 'data-xhr-a-ok', 15_000)
      const cBlocked = await waitAttr(tab, 'data-xhr-c-blocked', 15_000)
      const dBlocked = await waitAttr(tab, 'data-xhr-d-blocked', 15_000)
      check('U6', 'GM_xmlhttpRequest 같은 origin(무 @connect)은 성공하고 실제 응답 바디를 받는다', aOk === 'true', `a-ok=${aOk}`)
      check('U8', 'GM_xmlhttpRequest @connect 에 사설망 호스트를 선언해도 교차 출처면 막힌다', cBlocked === 'true', `c-blocked=${cBlocked}`)
      check('U9', 'GM_xmlhttpRequest 허용 안 되는 메서드(TRACE)는 거부된다', dBlocked === 'true', `d-blocked=${dBlocked}`)

      const tab2 = await openTab(shell, windowId, `http://127.0.0.1:${A}/xhrtest2`)
      const blocked2 = await waitAttr(tab2, 'data-xhr2-blocked')
      check('U7', 'GM_xmlhttpRequest @connect 없이 교차 출처를 부르면 네트워크 전에 거부된다', blocked2 === 'true', `blocked=${blocked2}`)
    }

    // ===== U10/U11 @require =====
    if (C) {
      const tab = await openTab(shell, windowId, `http://127.0.0.1:${A}/requiretest`)
      const ran = await waitAttr(tab, 'data-require-ran')
      const errs = requireScript?.requireErrors ?? []
      check('U10', '@require 성공한 라이브러리는 실행되고 실패한 것은 requireErrors 에 남는다',
        ran === '1' && errs.length === 1 && String(errs[0]).includes('lib-404.js'),
        `실행됨=${ran} errors=${JSON.stringify(errs)}`)

      const bigErrs = requireBigScript?.requireErrors ?? []
      const bigOk = bigErrs.length === 1 && /상한|초과|KB|MB/.test(bigErrs[0] ?? '')
      check('U11', '@require 크기 상한을 넘으면 다운로드가 거부된다', bigOk, `errors=${JSON.stringify(bigErrs)} bundle길이=${(requireBigScript?.requireBundle ?? '').length}`)
    } else {
      check('U10', '@require 성공/실패 처리 (SKIP — openssl 없음)', true, 'https fixture 생성 실패로 건너뜀')
      check('U11', '@require 크기 상한 (SKIP — openssl 없음)', true, 'https fixture 생성 실패로 건너뜀')
    }

    // ===== U12 @resource =====
    if (C) {
      const tab = await openTab(shell, windowId, `http://127.0.0.1:${A}/resourcetest`)
      const text = await waitAttr(tab, 'data-res-text')
      const urlOk = await attr(tab, 'data-res-url-ok')
      check('U12', '@resource 가 GM_getResourceText/URL 로 정확히 노출된다', text === '안녕 리소스' && urlOk === 'true', `text=${JSON.stringify(text)} urlOk=${urlOk}`)
    } else {
      check('U12', '@resource (SKIP — openssl 없음)', true, 'https fixture 생성 실패로 건너뜀')
    }

    // ===== U13 noframes =====
    {
      const tab = await openTab(shell, windowId, `http://127.0.0.1:${A}/frametest`)
      await sleep(700)
      const topNo = await attr(tab, 'data-noframes-ran')
      const topAll = await attr(tab, 'data-allframes-ran')
      const childState = await evaluate(tab, `(() => { const f = document.querySelector('iframe'); const d = f && f.contentDocument; return d ? { no: d.documentElement.getAttribute('data-noframes-ran'), all: d.documentElement.getAttribute('data-allframes-ran') } : null })()`)
      const ok = topNo === '1' && topAll === '1' && childState && childState.no !== '1' && childState.all === '1'
      check('U13', '@noframes — 최상위는 돌고 같은 origin iframe 에선 noframes 스크립트만 빠진다',
        ok, `top(no=${topNo},all=${topAll}) child=${JSON.stringify(childState)}`)
    }

    // ===== U14 GM_registerMenuCommand =====
    {
      const tab = await openTab(shell, windowId, `http://127.0.0.1:${A}/menu`)
      await waitAttr(tab, 'data-menu-registered')
      const list = await evaluate(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)})`)
      const tabRow = (list || []).find((t) => String(t.url || '').includes('/menu'))
      let cmdOk = false
      let runOk = false
      let detail = 'tab 못 찾음'
      if (tabRow) {
        const cmds = await evaluate(admin, `window.internalAPI.userscript.menuList(${JSON.stringify(tabRow.id)})`)
        const cmd = (cmds || []).find((c) => c.label === '실행 테스트')
        cmdOk = !!cmd
        if (cmd) {
          const ran = await evaluate(admin, `window.internalAPI.userscript.menuRun(${JSON.stringify(cmd.id)})`)
          await sleep(300)
          const attrAfter = await attr(tab, 'data-menu-ran')
          runOk = ran === true && attrAfter === '1'
          detail = `cmd=${JSON.stringify(cmd)} runResult=${ran} attr=${attrAfter}`
        }
      }
      check('U14', 'GM_registerMenuCommand — 등록→조회→실행 왕복이 격리 월드 콜백을 부른다', cmdOk && runOk, detail)
    }

    // ===== U15 미선언 GM_* 는 노출되지 않는다 =====
    {
      const tab = await openTab(shell, windowId, `http://127.0.0.1:${A}/xhrtest2`)
      await sleep(700)
      const typ = await attr(tab, 'data-grant-typeof-xhr')
      check('U15', '@grant 선언 안 한 GM_* 는 노출되지 않는다(undefined)', typ === 'undefined', `typeof GM_xmlhttpRequest=${typ}`)
    }
  } finally {
    try { child.kill() } catch { /* ignore */ }
    await sleep(500)
    try { await fixture.close() } catch { /* ignore */ }
  }

  fs.writeFileSync(path.join(args.out, 'userscript-results.json'), JSON.stringify(results, null, 2))
  console.log('\n===== verify-userscript-cdp 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const failed = results.filter((r) => r.status !== 'PASS').length
  console.log(`PASS=${results.length - failed} FAIL=${failed} (총 ${results.length})`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('[userscript] 치명적 오류:', err)
  process.exit(2)
})
