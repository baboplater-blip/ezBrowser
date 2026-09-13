#!/usr/bin/env node
// verify-passkey-cdp.mjs — 패스키(WebAuthn) 요청 처리 검사 P1~P4
//
// 왜 (2026-09-13): 인스타 로그인 페이지의 조건부 패스키 요청이 Electron 에서 Windows OS 모달로 튀어나온다(크롬은 자동완성에
// 조용히 표시). 앱은 조건부 요청을 기본 차단하고 사이트별로 허용/차단을 바꿀 수 있다. 실제 OS 모달은 CDP 로 볼 수 없으므로
// 페이지 스크립트가 받는 **결과**(NotAllowedError 로 즉시 거부되는가 / 통과하는가)로 판정한다.
//   P1 기본: 조건부 get → 영구 대기(pending, 우리 거부 아님) · 명시(required) get 은 우리 계층을 통과(다른 이유로 거부되거나 대기)
//   P2 사이트 'deny': 조건부·명시·create 전부 NotAllowedError
//   P3 사이트 'allow': 조건부 get 도 통과(우리가 거부하지 않음)
//   P4 전역 설정 privacy.passkeyAutoPrompt='allow': 기본 사이트에서 조건부 통과
// ⚠ 명시 요청을 'allow' 상태에서 부르면 실제 OS 창이 뜰 수 있으므로 P3·P4 는 조건부만 시험한다.
//
// 사용: node build/verify-passkey-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, getTargetList, waitForPortFree, connectShellSessionReady, ensureSessionReady } from './lib/cdp.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')
const args = { port: 9298, out: path.join(REPO, 'verify-out', 'passkey') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}
const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const NL = String.fromCharCode(10)
function check(id, name, ok, detail) { results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail }); console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`) }

// 시험 페이지 — 버튼 없이 함수만 노출한다(사람 조작 없이 CDP 로 호출).
const PAGE = `<!doctype html><meta charset="utf-8"><title>패스키 시험</title><body><h1>passkey test</h1>
<script>
  const chal = new Uint8Array(32)
  window.__try = async (mediation) => {
    const t0 = Date.now()
    try {
      const p = navigator.credentials.get({ mediation, publicKey: { challenge: chal, timeout: 60000, rpId: location.hostname, allowCredentials: [], userVerification: 'discouraged' } })
      const r = await Promise.race([p.then(() => 'resolved'), new Promise((res) => setTimeout(() => res('pending'), 600))])
      return { outcome: r, ms: Date.now() - t0 }
    } catch (e) { return { outcome: 'rejected:' + (e && e.name), ms: Date.now() - t0 } }
  }
  window.__tryCreate = async () => {
    try {
      const p = navigator.credentials.create({ publicKey: { challenge: chal, rp: { name: 'x' }, user: { id: chal, name: 'u', displayName: 'u' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 60000 } })
      const r = await Promise.race([p.then(() => 'resolved'), new Promise((res) => setTimeout(() => res('pending'), 600))])
      return { outcome: r }
    } catch (e) { return { outcome: 'rejected:' + (e && e.name) } }
  }
</script></body>`

function startPageServer(port) {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE) })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${port}/`, async close() { await new Promise((r) => { try { server.closeAllConnections?.() } catch {} const t = setTimeout(r, 3000); server.close(() => { clearTimeout(t); r() }) }) } })))
}
const evalIn = async (s, expression, awaitPromise = false) => {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.result?.value ?? r.result?.value
}

async function bootAndTest(label, settingsExtra, fn) {
  const profileDir = path.join(args.out, `profile-${label}`)
  fs.rmSync(profileDir, { recursive: true, force: true }); fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({ setup: { completed: true }, startup: { mode: 'newtab', urls: [] }, adblock: { enabled: false }, ...settingsExtra }, null, 2))
  await waitForPortFree(args.port)
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`], { stdio: 'ignore' })
  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
    await fn(shell, windowId)
  } finally {
    try { shell?.close() } catch {}
    try { const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json(); const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser'); await b.send('Browser.close').catch(() => {}); b.close() } catch {}
    await sleep(1500); try { child.kill() } catch {}
    await waitForPortFree(args.port, 15000).catch(() => {})
  }
}

async function openTest(shell, windowId, port, pageUrl) {
  const tabId = await evalIn(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pageUrl)}).then(t => t.id)`, true)
  await sleep(2500)
  let t = null
  for (let i = 0; i < 20 && !t; i++) { t = (await getTargetList(port)).find((x) => x.type === 'page' && String(x.url).startsWith(pageUrl)); if (!t) await sleep(300) }
  if (!t) throw new Error('시험 페이지 타깃 없음')
  const page = await connectSession(t, 'page'); await ensureSessionReady(page)
  return { page, tabId }
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE}`)
  fs.mkdirSync(args.out, { recursive: true })
  args.port = await preferFreePort(args.port, 'verify-passkey-cdp.mjs')
  const [pagePort] = await getFreePorts(1)
  const pages = await startPageServer(pagePort)
  try {
    // P1 + P2 — 기본 차단(조건부만) → 사이트 deny 로 바꾸면 전부 거부
    await bootAndTest('default', {}, async (shell, windowId) => {
      const { page, tabId } = await openTest(shell, windowId, args.port, pages.url)
      const fp = await evalIn(page, `JSON.stringify({ own: Object.prototype.hasOwnProperty.call(navigator, 'credentials'), inst: navigator.credentials instanceof CredentialsContainer, ts: String(navigator.credentials.get), name: navigator.credentials.get.name })`)
      const fpo = JSON.parse(fp)
      check('P0', '주입 후 지문: navigator 에 own property 없음 · instanceof 유지 · get 이 native 처럼 보임',
        fpo.own === false && fpo.inst === true && /\[native code\]/.test(fpo.ts) && fpo.name === 'get', fp)
      const cond = await evalIn(page, 'window.__try("conditional")', true)
      const req = await evalIn(page, 'window.__try("required")', true)
      // 조건부는 **영구 대기**(즉시 거부는 실제 브라우저에 없는 패턴이라 그 자체가 자동화 신호 — 리뷰 반영). 명시 요청은 통과.
      check('P1', '기본: 조건부 패스키 요청은 조용히 대기(OS 창 없음), 명시 요청은 우리 계층을 통과',
        cond.outcome === 'pending' && req.outcome !== 'rejected:NotAllowedError',
        `conditional=${cond.outcome}(${cond.ms}ms) · required=${req.outcome}`)
      // 사이트 deny — 외피에서 권한 저장소에 기록(자물쇠 패널이 쓰는 것과 같은 API) → 새로고침 후 전부 거부
      await evalIn(shell, `window.browserAPI.permissions.set(${JSON.stringify(new URL(pages.url).origin)}, 'passkey', 'deny')`, true)
      await evalIn(shell, `window.browserAPI.tabs.reload(${JSON.stringify(tabId)})`, true).catch(() => {})
      await sleep(2500)
      const page2 = (await (async () => { const t = (await getTargetList(args.port)).find((x) => x.type === 'page' && String(x.url).startsWith(pages.url)); const p = await connectSession(t, 'page'); await ensureSessionReady(p); return p })())
      const c2 = await evalIn(page2, 'window.__try("conditional")', true)
      const r2 = await evalIn(page2, 'window.__try("required")', true)
      const cr = await evalIn(page2, 'window.__tryCreate()', true)
      check('P2', "사이트 '차단': 조건부·명시·등록 요청 전부 NotAllowedError",
        c2.outcome === 'rejected:NotAllowedError' && r2.outcome === 'rejected:NotAllowedError' && cr.outcome === 'rejected:NotAllowedError',
        `conditional=${c2.outcome} · required=${r2.outcome} · create=${cr.outcome}`)
      try { page.close(); page2.close() } catch {}
    })
    // P3 — 사이트 allow: 조건부도 통과
    await bootAndTest('siteAllow', {}, async (shell, windowId) => {
      await evalIn(shell, `window.browserAPI.permissions.set(${JSON.stringify(new URL(pages.url).origin)}, 'passkey', 'allow')`, true)
      const { page } = await openTest(shell, windowId, args.port, pages.url)
      const cond = await evalIn(page, 'window.__try("conditional")', true)
      // 허용이면 주입이 없어 Chromium 원본이 처리한다(로컬 http 라 SecurityError 등으로 거부됨 — pending 이 아니어야 우리 보류가 아님이 증명된다).
      check('P3', "사이트 '허용': 조건부 요청이 우리 계층을 통과(보류·거부하지 않음)", cond.outcome !== 'pending' && cond.outcome !== 'rejected:NotAllowedError', `conditional=${cond.outcome}`)
      try { page.close() } catch {}
    })
    // P4 — 전역 설정 allow
    await bootAndTest('globalAllow', { privacy: { historyRetention: '1y', blockThirdPartyCookies: true, passkeyAutoPrompt: 'allow' } }, async (shell, windowId) => {
      const { page } = await openTest(shell, windowId, args.port, pages.url)
      const cond = await evalIn(page, 'window.__try("conditional")', true)
      check('P4', "전역 설정 '허용': 기본 사이트에서 조건부 요청 통과", cond.outcome !== 'pending' && cond.outcome !== 'rejected:NotAllowedError', `conditional=${cond.outcome}`)
      try { page.close() } catch {}
    })
  } catch (err) {
    check('FATAL', '하네스 실행', false, err.message)
  } finally {
    await pages.close()
  }
  fs.writeFileSync(path.join(args.out, 'passkey-results.json'), JSON.stringify(results, null, 2))
  console.log(NL + '===== verify-passkey 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL').length
  console.log(`PASS=${results.length - fail} FAIL=${fail} (총 ${results.length})`)
  process.exit(fail ? 1 : 0)
}
main().catch((err) => { console.error('harness 실패:', err); process.exit(1) })
