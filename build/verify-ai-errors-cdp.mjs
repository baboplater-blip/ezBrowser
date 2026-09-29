#!/usr/bin/env node
// verify-ai-errors-cdp.mjs — AI 오류 경로: 사용자에게 보이는 문구가 원인을 알려주는가
//
// 왜 (2026-09-07, 임무 26): 제공자 계층의 순수 부분은 임무 24 에서 검사했지만, **실제 왕복**은
// Electron `net.request` 라 그 하네스가 다루지 못했다. 그런데 사용자가 겪는 문제는 대부분 여기다 —
// 키가 틀렸는지, 한도를 넘었는지, 모델 이름이 틀렸는지, 서버가 안 뜨는지.
// 이때 "오류가 발생했습니다" 만 보이면 사용자는 무엇을 고쳐야 할지 알 수 없다.
//
// 가짜 LLM 서버로 상태 코드·지연·깨진 스트림을 만들어 **사용자 문구**를 대조한다.
//   E1 401  키 문제임을 알려주는가
//   E2 429  한도 문제임을 알려주는가
//   E3 404  모델 이름 문제임을 알려주는가
//   E4 서버 없음(연결 거부)  주소·실행 여부를 알려주는가
//   E5 취소  중단하면 스트림이 멈추고 앱이 정상인가
//   E6 깨진 스트림  한 줄이 망가져도 앱이 죽지 않는가
//
// 사용: node build/verify-ai-errors-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, waitForPortFree, connectShellSessionReady } from './lib/cdp.mjs'
import { preferFreePort } from './lib/ports.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9261, llmPort: 11501, out: path.join(REPO, 'verify-out', 'ai-errors') }
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

const evalIn = async (s, expression, awaitPromise = false) => {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  return r.result?.result?.value ?? r.result?.value
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE}`)
  fs.mkdirSync(args.out, { recursive: true })
  // 고정 포트가 앞선 실행의 잔재에 물려 있으면 빈 포트로 대체한다(실행이 통째로 죽지 않게).
  args.port = await preferFreePort(args.port, 'verify-ai-errors-cdp.mjs')
  await waitForPortFree(args.port)

  const llm = await startFakeLlm({ port: args.llmPort })

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true },
    startup: { mode: 'newtab', urls: [] },
    adblock: { enabled: false },
    ai: { enabled: true, provider: 'ollama', ollamaUrl: llm.url, ollamaModel: 'test-model', agentVision: 'off' },
  }, null, 2))

  const logStream = fs.createWriteStream(path.join(args.out, 'app.log'))
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    await sleep(1500)

    // 챗 한 번을 보내고 델타/오류를 모은다.
    await evalIn(shell, `
      window.__ai = { delta: '', error: null, done: false }
      window.browserAPI.ai.onDelta((p) => { window.__ai.delta += (p.text ?? '') })
      window.browserAPI.ai.onError((p) => { window.__ai.error = String(p.message ?? p.error ?? p) })
      window.browserAPI.ai.onDone(() => { window.__ai.done = true })
      true`)

    async function ask({ script, reqId, waitMs = 9000, cancelAfterMs = 0, baseUrlOverride }) {
      llm.setScript(script ?? [])
      if (baseUrlOverride !== undefined) {
        await evalIn(shell, `window.browserAPI.settings.set('ai.ollamaUrl', ${JSON.stringify(baseUrlOverride)})`, true)
        await sleep(300)
      }
      await evalIn(shell, `window.__ai = { delta: '', error: null, done: false }; true`)
      await evalIn(shell,
        `window.browserAPI.ai.send({ reqId: ${JSON.stringify(reqId)}, includePage: false, messages: [{ role: 'user', content: '안녕' }] })`, true)
      if (cancelAfterMs) {
        await sleep(cancelAfterMs)
        await evalIn(shell, `window.browserAPI.ai.cancel(${JSON.stringify(reqId)})`, true)
      }
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline) {
        const st = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ai)') ?? '{}')
        if (st.error || st.done) return st
        await sleep(300)
      }
      return JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ai)') ?? '{}')
    }

    const hasAny = (s, words) => words.some((w) => String(s ?? '').includes(w))

    // ---- E0 대조: 정상 응답에서 델타가 오는가 (오지 않으면 아래 취소 검사는 무효다) ----
    {
      const st = await ask({ reqId: 'E0', script: [{ reply: () => '안녕하세요 반갑습니다' }] })
      check('E0', '정상 응답에서 델타가 도착한다(대조군)',
        String(st.delta ?? '').length > 0 && st.done === true,
        `델타 ${String(st.delta ?? '').length}자 · 완료=${st.done} · 오류=${st.error ?? '(없음)'}`)
    }

    // ---- E1 401 ----
    {
      const st = await ask({ reqId: 'E1', script: [{ status: 401, body: { error: 'unauthorized' } }] })
      check('E1', '401 이면 키 문제임을 알려준다', !!st.error && hasAny(st.error, ['키', 'API', '인증', '401']),
        `문구: ${String(st.error).slice(0, 90)}`)
    }
    // ---- E2 429 ----
    {
      const st = await ask({ reqId: 'E2', script: [{ status: 429, body: { error: 'rate limit' } }] })
      check('E2', '429 이면 한도 문제임을 알려준다', !!st.error && hasAny(st.error, ['한도', '요청', '429', '잠시']),
        `문구: ${String(st.error).slice(0, 90)}`)
    }
    // ---- E3 404 ----
    {
      const st = await ask({ reqId: 'E3', script: [{ status: 404, body: { error: 'model not found' } }] })
      check('E3', '404 면 모델 이름 문제임을 알려준다', !!st.error && hasAny(st.error, ['모델', '404', '찾을 수 없']),
        `문구: ${String(st.error).slice(0, 90)}`)
    }
    // ---- E4 서버 없음 ----
    {
      const st = await ask({ reqId: 'E4', baseUrlOverride: 'http://127.0.0.1:1', waitMs: 12000 })
      check('E4', '서버가 없으면 연결 문제임을 알려준다',
        !!st.error && hasAny(st.error, ['연결', 'Ollama', '실행', '주소', '서버']),
        `문구: ${String(st.error).slice(0, 90)}`)
      await evalIn(shell, `window.browserAPI.settings.set('ai.ollamaUrl', ${JSON.stringify(llm.url)})`, true)
      await sleep(300)
    }
    // ---- E5 취소: 응답하지 않는 요청을 끊으면 다음 요청이 정상인가 ----
    {
      // 목적은 "취소가 요청을 놓아주는가" 다. 진행형 스트리밍에 기대지 않는다
      // (조금씩 보내는 응답이 앱까지 조각으로 도달하는지는 별개 문제 - 아래 알려진 공백).
      llm.setScript([{ mode: 'hang' }])
      await evalIn(shell, 'window.__ai = { delta: "", error: null, done: false }; true')
      await evalIn(shell,
        `window.browserAPI.ai.send({ reqId: 'E5', includePage: false, messages: [{ role: 'user', content: '안녕' }] })`, true)
      await sleep(2500)
      const pending = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ai)') ?? '{}')
      const wasPending = !pending.done && !pending.error   // 아직 기다리는 중이어야 한다

      await evalIn(shell, `window.browserAPI.ai.cancel('E5')`, true)
      await sleep(1500)

      // 취소 뒤 정상 요청이 되는가 — 파이프라인이 붙들려 있지 않아야 한다.
      const after = await ask({ reqId: 'E5b', script: [{ reply: () => '취소 후에도 정상' }], waitMs: 9000 })
      check('E5', '응답 없는 요청을 취소하면 파이프라인이 풀린다',
        wasPending && String(after.delta ?? '').length > 0 && after.done === true,
        `취소 전 대기중=${wasPending} · 취소 후 델타 ${String(after.delta ?? '').length}자 · 완료=${after.done}`)
    }

    // ---- E6 깨진 스트림 ----
    {
      const st = await ask({ reqId: 'E6', script: [{ mode: 'garbage' }], waitMs: 8000 })
      const alive = await evalIn(shell, '!!window.browserAPI && !!document.querySelector(".tabbar")')
      check('E6', '깨진 스트림에도 앱이 살아 있다', alive === true,
        `앱 정상=${alive} · 오류문구=${st.error ? String(st.error).slice(0, 50) : '(없음)'} · 완료=${st.done}`)
    }
    // ---- E7 진행형 스트리밍: 답이 조각으로 도착하는가(끝에 몰아 오지 않는가) ----
    {
      llm.setScript([{ mode: 'slow', chunks: ['조각하나 ', '조각둘 ', '조각셋 ', '조각넷 ', '조각다섯 '], delayMs: 500 }])
      await evalIn(shell, 'window.__ai = { delta: "", error: null, done: false }; true')
      const t0 = Date.now()
      await evalIn(shell,
        `window.browserAPI.ai.send({ reqId: 'E7', includePage: false, messages: [{ role: 'user', content: '안녕' }] })`, true)

      const timeline = []
      const deadline = Date.now() + 12000
      while (Date.now() < deadline) {
        const st = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ai)') ?? '{}')
        const len = String(st.delta ?? '').length
        const last = timeline[timeline.length - 1]
        if (!last || last.len !== len) timeline.push({ ms: Date.now() - t0, len, done: !!st.done })
        if (st.done || st.error) break
        await sleep(250)
      }
      // 길이가 0 -> ... -> 최종 으로 **두 번 이상 늘어야** 조각으로 온 것이다.
      const growth = timeline.filter((p) => p.len > 0).length
      const finalLen = timeline.length ? timeline[timeline.length - 1].len : 0
      check('E7', '답이 조각으로 도착한다(끝에 몰아 오지 않는다)',
        growth >= 2 && finalLen > 0,
        `길이 변화 ${timeline.map((p) => `${p.ms}ms:${p.len}자`).join(' > ')}`)
    }

  } catch (err) {
    check('FATAL', '하네스 실행', false, err.message)
  } finally {
    try { shell?.close() } catch { /* ignore */ }
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {}); b.close()
    } catch { /* ignore */ }
    await sleep(1500)
    try { child.kill() } catch { /* ignore */ }
    await llm.close()
  }

  fs.writeFileSync(path.join(args.out, 'ai-errors-results.json'), JSON.stringify(results, null, 2))
  console.log('\n===== verify-ai-errors 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL')
  console.log(`PASS=${results.length - fail.length} FAIL=${fail.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
