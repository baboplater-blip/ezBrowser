#!/usr/bin/env node
// bench-agent-cdp.mjs — 에이전트 한 단계가 어디서 시간을 쓰는지 실측한다.
// LLM 호출을 뺀 "우리 코드" 구간만 잰다(관찰·클릭·입력·안정화). 최적화 전후 비교용.
//
// 재는 항목:
//   관찰(observePage)  · 클릭(사람처럼 / 합성)  · 입력 40자(사람처럼 / 합성)  · 프롬프트 크기
//
// 사용: node build/bench-agent-cdp.mjs [--rounds 5]

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import {
  CDPSession,
} from './lib/cdp.mjs'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')
const OUT = path.join(REPO_ROOT, 'verify-out')
const PORT = 9291
const ROUNDS = Number(process.argv.includes('--rounds') ? process.argv[process.argv.indexOf('--rounds') + 1] : 5)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms))])
}
async function pollUntil(fn, { timeoutMs = 20000, intervalMs = 300, label = 'x' } = {}) {
  const s = Date.now()
  while (Date.now() - s < timeoutMs) { try { const v = await fn(); if (v) return v } catch { /* retry */ } await sleep(intervalMs) }
  throw new Error(`pollUntil timeout: ${label}`)
}
async function evaluate(s, expr, timeoutMs = 60000) {
  const r = await s.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, timeoutMs)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.value
}
const lit = (a) => (a === undefined ? 'undefined' : JSON.stringify(a))
const callApi = (s, p, args = []) => evaluate(s, `window.browserAPI.${p}(${args.map(lit).join(', ')})`)
async function targets() { return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json() }
const isShell = (t) => t.type === 'page' && String(t.url).startsWith('file://') && t.url.includes('windowId=')

// 실제 사이트에 가까운 무게의 페이지(요소 400개 + 본문 다량 + 중첩 구조)
function heavyPage() {
  let rows = ''
  for (let i = 0; i < 120; i++) {
    rows += `<div class="card"><h3>항목 ${i}</h3><p>설명 텍스트가 들어가는 자리입니다 ${i}. 이 페이지는 실제 서비스 페이지의 무게를 흉내냅니다.</p>`
      + `<a href="#a${i}">링크 ${i}</a> <button id="b${i}">버튼 ${i}</button> <input id="i${i}" placeholder="입력 ${i}"></div>`
  }
  return `<!doctype html><meta charset="utf-8"><title>bench</title><style>.card{padding:8px;border:1px solid #eee}</style>
<h1>벤치마크 페이지</h1><input id="target" placeholder="입력 대상" style="width:400px">
<button id="click-target" style="padding:12px 20px">클릭 대상</button>${rows}`
}

function startServer() {
  const html = heavyPage()
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(html)
    })
    s.listen(0, '127.0.0.1', () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}/` }))
  })
}

const stat = (arr) => {
  const a = [...arr].sort((x, y) => x - y)
  return { min: a[0], med: a[Math.floor(a.length / 2)], max: a[a.length - 1], avg: a.reduce((p, c) => p + c, 0) / a.length }
}
const fmt = (s) => `${Math.round(s.avg)}ms (중앙 ${Math.round(s.med)} / 최소 ${Math.round(s.min)} / 최대 ${Math.round(s.max)})`

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const pa = require(path.join(REPO_ROOT, 'app', 'dist', 'main', 'features', 'ai', 'page-actions.js'))
  const { server, url } = await startServer()
  const profileDir = path.join(OUT, 'bench-profile')
  fs.rmSync(profileDir, { recursive: true, force: true }); fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({ setup: { completed: true, completedAt: Date.now(), version: 'bench' }, startup: { mode: 'newtab', urls: [] } }))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`], { env, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.pipe(fs.createWriteStream(path.join(OUT, 'bench-stdout.log')))
  let shell = null; let content = null
  const result = {}
  try {
    const st = await pollUntil(async () => (await targets()).find(isShell) ?? null, { timeoutMs: 30000, label: 'shell' })
    shell = new CDPSession(st.webSocketDebuggerUrl, 'shell'); await shell.connect()
    const windowId = new URL(st.url).searchParams.get('windowId')
    const before = new Set((await targets()).map((t) => t.id))
    await callApi(shell, 'tabs.create', [windowId, url])
    const ct = await pollUntil(async () => (await targets()).find((t) => t.type === 'page' && !before.has(t.id) && String(t.url).startsWith(url)) ?? null, { label: 'content' })
    content = new CDPSession(ct.webSocketDebuggerUrl, 'content'); await content.connect()
    await sleep(800)

    // ⚠ 중요: sendInputEvent 를 CDP 로 실제 전송하면 입력 하나마다 WebSocket 왕복이 생겨
    // "40자 입력 = 44초" 같은 하네스 아티팩트가 나온다(실제 앱에서는 프로세스 내 동기 호출이라 사실상 0).
    // 여기서는 **제품 자신의 지연 로직(대기·왕복 JS 평가)** 만 재기 위해 입력 전송은 세지 않는다.
    // 입력이 실제로 먹히는지는 verify-agent-safety(A5·A8·A12)에서 진짜 전송으로 이미 검증돼 있다.
    let inputEvents = 0
    const wc = {
      isDestroyed: () => false, getURL: () => url, focus: () => {},
      executeJavaScript: async (code) => evaluate(content, code),
      sendInputEvent: () => { inputEvents++ },
    }
    result.inputEventsPerType = 0

    const time = async (fn) => { const t = Date.now(); await fn(); return Date.now() - t }

    // 1) 관찰
    const obsT = []
    let obs = null
    for (let i = 0; i < ROUNDS; i++) obsT.push(await time(async () => { obs = await pa.observePage(wc) }))
    result.observe = stat(obsT)
    result.elements = obs?.elements.length ?? 0

    // 2) 프롬프트 크기(관찰이 LLM 에 보내는 문자 수) — 토큰 = 지연·비용
    const elsText = (obs?.elements ?? []).map((e) => `[${e.ref}] ${e.type} "${e.name}"${e.value ? ` value="${e.value}"` : ''}`).join('\n')
    result.promptChars = { elements: elsText.length, bodyText: (obs?.text ?? '').length, total: elsText.length + (obs?.text ?? '').length }

    const target = obs.elements.find((e) => e.name.includes('클릭 대상'))
    const input = obs.elements.find((e) => e.name.includes('입력 대상'))
    if (!target || !input) throw new Error('벤치 대상 요소를 못 찾음')

    // 3) 클릭 — 사람처럼(strict) / 빠름(fast, 실제 입력 이벤트 그대로) / 합성
    const STRICT = pa.inputProfileFor('https://instagram.com/', 'auto')
    const FAST = pa.inputProfileFor('https://example.com/', 'auto')
    const clkH = []; const clkF = []; const clkS = []
    for (let i = 0; i < ROUNDS; i++) {
      clkH.push(await time(() => pa.executeInPageAction(wc, { action: 'click', ref: target.ref }, { humanInput: true, profile: STRICT })))
      await pa.observePage(wc) // ref 갱신(레지스트리)
    }
    for (let i = 0; i < ROUNDS; i++) {
      clkF.push(await time(() => pa.executeInPageAction(wc, { action: 'click', ref: target.ref }, { humanInput: true, profile: FAST })))
      await pa.observePage(wc)
    }
    for (let i = 0; i < ROUNDS; i++) {
      clkS.push(await time(() => pa.executeInPageAction(wc, { action: 'click', ref: target.ref }, { humanInput: false })))
      await pa.observePage(wc)
    }
    result.clickHuman = stat(clkH); result.clickFast = stat(clkF); result.clickSynthetic = stat(clkS)

    // 4) 입력 40자 — 사람처럼 / 합성
    const text40 = '자동화 속도 벤치마크 테스트 입력 문자열 40자 abcdefg'
    const typH = []; const typS = []
    for (let i = 0; i < ROUNDS; i++) {
      const o = await pa.observePage(wc)
      const inp = o.elements.find((e) => e.name.includes('입력 대상'))
      const before = inputEvents
      typH.push(await time(() => pa.executeInPageAction(wc, { action: 'type', ref: inp.ref, text: text40 }, { humanInput: true, profile: STRICT })))
      result.inputEventsPerType = inputEvents - before
    }
    const typF = []
    for (let i = 0; i < ROUNDS; i++) {
      const o = await pa.observePage(wc)
      const inp = o.elements.find((e) => e.name.includes('입력 대상'))
      typF.push(await time(() => pa.executeInPageAction(wc, { action: 'type', ref: inp.ref, text: text40 }, { humanInput: true, profile: FAST })))
    }
    result.typeFast40 = stat(typF)
    for (let i = 0; i < ROUNDS; i++) {
      const o = await pa.observePage(wc)
      const inp = o.elements.find((e) => e.name.includes('입력 대상'))
      typS.push(await time(() => pa.executeInPageAction(wc, { action: 'type', ref: inp.ref, text: text40 }, { humanInput: false })))
    }
    result.typeHuman40 = stat(typH); result.typeSynthetic40 = stat(typS)
  } finally {
    try { server.close() } catch { /* ignore */ }
    try { content?.close() } catch { /* ignore */ }
    try { await shell?.send('Browser.close', {}, 3000).catch(() => {}) } catch { /* ignore */ }
    await sleep(600)
    if (child.exitCode === null) { try { child.kill() } catch { /* ignore */ }; try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']) } catch { /* ignore */ } }
    try { shell?.close() } catch { /* ignore */ }
  }

  const outFile = path.join(OUT, 'bench-agent.json')
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2))
  console.log('\n===== 에이전트 단계 비용 실측 (LLM 호출 제외) =====')
  console.log(`관찰(observePage, 요소 ${result.elements}개):  ${fmt(result.observe)}`)
  console.log(`클릭 — 사람처럼(봇탐지 사이트):       ${fmt(result.clickHuman)}`)
  console.log(`클릭 — 빠름(실제 입력, 일반 사이트):  ${fmt(result.clickFast)}`)
  console.log(`클릭 — 합성(참고):                    ${fmt(result.clickSynthetic)}`)
  console.log(`입력 40자 — 사람처럼(봇탐지):         ${fmt(result.typeHuman40)}`)
  console.log(`입력 40자 — 빠름(실제 입력):          ${fmt(result.typeFast40)}`)
  console.log(`입력 40자 — 합성(참고):               ${fmt(result.typeSynthetic40)}`)
  console.log(`\n입력 이벤트 수(40자당): ${result.inputEventsPerType}개 — 앱에서는 프로세스 내 호출이라 비용 ≈ 0`)
  console.log(`프롬프트 문자 수: 요소목록 ${result.promptChars.elements} + 본문 ${result.promptChars.bodyText} = ${result.promptChars.total}`)
  console.log(`\n보고서: ${outFile}`)
}
main().catch((e) => { console.error('[bench] 오류:', e); process.exit(3) })
