#!/usr/bin/env node
// verify-agent-loop-cdp.mjs — 에이전트 루프 e2e (관찰→판단→실행), 모델 없이 결정론적으로
//
// 왜 (2026-09-07, 임무 26): 에이전트의 판정 함수는 임무 24 에서 검사를 붙였지만, **루프 자체**
// (관찰한 것을 실제로 클릭하는가 / 확인을 거부하면 정말 실행되지 않는가 / 질문에 답하면 이어가는가)
// 는 상설 검사가 없었다. 예전 라운드들의 e2e 는 실제 Ollama 모델에 의존해 **모델이 없으면 못 돌고
// 같은 입력에도 답이 달라져** 남길 수가 없었다.
//
// 그래서 각본대로만 답하는 가짜 LLM 서버를 두고 앱의 `ai.ollamaUrl` 을 거기로 돌린다.
// 모델 설치 없이, 매번 같은 결과로 루프 전체를 본다.
//
//   L1 관찰한 요소를 실제로 클릭해 페이지 상태를 바꾸는가
//   L2 결제 버튼 클릭 시 확인을 요구하고, **거부하면 실행되지 않는가**   ← 가장 중요
//   L3 승인하면 실행되는가
//   L4 ask 로 물으면 답을 받아 이어가는가
//   L5 done 으로 정상 종료하는가
//   L6 무인 배치(autoConfirm)에서도 critical 은 자동 승인되지 않는가
//
// 사용: node build/verify-agent-loop-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, getTargetList, waitForPortFree, connectShellSessionReady, ensureSessionReady } from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9260, llmPort: 11500, pagePort: 8791, out: path.join(REPO, 'verify-out', 'agent-loop') }
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

// ===== 시험용 페이지 =====
const PAGE = `<!doctype html><meta charset="utf-8"><title>에이전트 시험</title>
<body style="font:16px system-ui;padding:40px">
<h1>에이전트 시험 페이지</h1>
<button id="ok">확인</button>
<button id="pay">결제하기</button>
<input id="f" type="file">
<button id="pub">발행</button>
<input id="txt" type="text" placeholder="제목">
<p id="state">대기</p>
<script>
  window.__clicked = false; window.__paid = false; window.__published = false;
  document.getElementById('ok').onclick = () => { window.__clicked = true; document.getElementById('state').textContent = '눌림' }
  document.getElementById('pay').onclick = () => { window.__paid = true; document.getElementById('state').textContent = '결제됨' }
  document.getElementById('pub').onclick = () => { window.__published = true; document.getElementById('state').textContent = '발행됨' }
</script></body>`

function startPageServer(port) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${port}/`,
    async close() {
      await new Promise((r) => {
        try { server.closeAllConnections?.() } catch { /* ignore */ }
        const t = setTimeout(r, 3000)
        server.close(() => { clearTimeout(t); r() })
      })
    },
  })))
}

const evalIn = async (s, expression, awaitPromise = false) => {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  return r.result?.result?.value ?? r.result?.value
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE}`)
  fs.mkdirSync(args.out, { recursive: true })
  // 고정 포트가 앞선 실행의 잔재에 물려 있으면 빈 포트로 대체한다(실행이 통째로 죽지 않게).
  args.port = await preferFreePort(args.port, 'verify-agent-loop-cdp.mjs')
  await waitForPortFree(args.port)
  // 우리가 여는 서버 포트는 **OS 에서 빈 것을 받아** 쓴다 - 고정 포트는 앞선 실행의 잔재와 충돌한다.
  ;[args.llmPort, args.pagePort] = await getFreePorts(2)

  const llm = await startFakeLlm({ port: args.llmPort })
  const pages = await startPageServer(args.pagePort)

  // 자료 폴더(안)와 그 **바깥** 폴더를 만들어 경계를 시험한다.
  const filesDir = path.join(args.out, 'files')
  const outsideDir = path.join(args.out, 'outside')
  fs.rmSync(filesDir, { recursive: true, force: true })
  fs.rmSync(outsideDir, { recursive: true, force: true })
  fs.mkdirSync(filesDir, { recursive: true })
  fs.mkdirSync(outsideDir, { recursive: true })
  fs.writeFileSync(path.join(filesDir, 'ok.txt'), '허용된 파일')
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), '폴더 밖 비밀')
  // 폴더 밖을 가리키는 링크를 만든다. Windows 는 파일 심링크에 권한이 필요하지만
  // **디렉터리 정션(junction)** 은 권한 없이 만들 수 있고, realpath 로 해석되므로 탈출 검사에 쓸 수 있다.
  let linkKind = ''
  try {
    fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(filesDir, 'link.txt'), 'file')
    linkKind = '파일 심링크'
  } catch {
    try {
      fs.symlinkSync(outsideDir, path.join(filesDir, 'linkdir'), 'junction')
      linkKind = '디렉터리 정션'
    } catch { linkKind = '' }
  }
  const symlinkOk = linkKind !== ''
  const linkPath = linkKind === '파일 심링크' ? 'link.txt' : 'linkdir/secret.txt'

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true },
    startup: { mode: 'newtab', urls: [] },
    adblock: { enabled: false },
    ai: {
      enabled: true,
      provider: 'ollama',
      ollamaUrl: llm.url,
      // 허용목록에 없는 이름 → 네이티브 도구 대신 JSON 액션 경로(결정론적)로 간다.
      ollamaModel: 'test-model',
      agentMaxSteps: 8,
      agentAutoApprove: false,
      agentVision: 'off',
      agentHumanInput: false,   // 시험에서는 빠른 합성 입력으로 충분하다
      agentFilesDir: filesDir,  // 자료 폴더 경계 검사(F1~F4)용
    },
  }, null, 2))

  const logStream = fs.createWriteStream(path.join(args.out, 'app.log'))
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')

    // 시험 페이지 탭
    const tabId = await evalIn(shell,
      `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pages.url)}).then(t => t.id)`, true)
    await sleep(2500)

    // 이벤트 수집기
    await evalIn(shell, 'window.__ev = []; window.browserAPI.ai.onAgentEvent((e) => window.__ev.push(e)); true')

    // 페이지 세션(상태 확인용)
    const pageTarget = (await getTargetList(args.port)).find((t) => String(t.url).startsWith(pages.url))
    if (!pageTarget) throw new Error('시험 페이지 타깃을 찾지 못함')
    const page = await connectSession(pageTarget, 'page')
    await ensureSessionReady(page)

    /** 한 시나리오 실행: 각본을 걸고 에이전트를 돌린 뒤 이벤트를 모은다. */
    async function run({ script, reqId, task, onConfirm, onAsk, rows, autoConfirm, readOnly, timeoutMs = 30000 }) {
      llm.setScript(script)
      await evalIn(page, 'window.__clicked = false; window.__paid = false; window.__published = false; true')
      await evalIn(shell, 'window.__ev = []; true')
      const startArgs = { reqId, tabId, task, ...(readOnly ? { readOnly: true } : {}), ...(rows ? { rows, autoConfirm: !!autoConfirm } : {}) }
      await evalIn(shell, `window.browserAPI.ai.agentStart(${JSON.stringify(startArgs)})`, true)

      const deadline = Date.now() + timeoutMs
      let handledConfirm = false
      let handledAsk = false
      while (Date.now() < deadline) {
        const evs = await evalIn(shell, 'JSON.stringify(window.__ev)')
        const list = JSON.parse(evs ?? '[]')
        if (!handledConfirm && onConfirm && list.some((e) => e.type === 'confirm')) {
          handledConfirm = true
          await evalIn(shell, `window.browserAPI.ai.agentConfirm(${JSON.stringify(reqId)}, ${onConfirm === 'approve'})`, true)
        }
        if (!handledAsk && onAsk && list.some((e) => e.type === 'ask')) {
          handledAsk = true
          await evalIn(shell, `window.browserAPI.ai.agentReply(${JSON.stringify(reqId)}, ${JSON.stringify(onAsk)})`, true)
        }
        if (list.some((e) => e.type === 'done' || e.type === 'error' || e.type === 'cancelled')) break
        await sleep(400)
      }
      const evs = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ev)') ?? '[]')
      const state = {
        clicked: await evalIn(page, 'window.__clicked === true'),
        paid: await evalIn(page, 'window.__paid === true'),
        published: await evalIn(page, 'window.__published === true'),
        typed: await evalIn(page, '(document.getElementById("txt")?.value ?? "")'),
      }
      return { evs, state, types: evs.map((e) => e.type) }
    }

    // 라벨을 못 찾으면 **관찰 원문을 남긴다** — 조용히 done 으로 끝나면 원인을 알 수 없다.
    const missed = []
    const clickByLabel = (label) => ({
      reply: (ctx) => {
        const ref = ctx.refFor(label)
        // ref 는 0 부터 시작한다 — `!ref` 로 검사하면 첫 요소를 "못 찾음" 으로 오판한다.
        if (ref === null || ref === undefined) {
          missed.push({ label, observation: String(ctx.lastUser).slice(0, 1200) })
          return JSON.stringify({ action: 'done', message: `${label} 를 찾지 못함(관찰 실패)` })
        }
        return JSON.stringify({ action: 'click', ref, thought: `${label} 누름` })
      },
    })
    const doneStep = { reply: () => JSON.stringify({ action: 'done', message: '완료' }) }

    // ---- L1: 관찰한 것을 실제로 클릭한다 ----
    {
      const r = await run({ reqId: 'L1', task: '확인 버튼을 눌러라', script: [clickByLabel('확인'), doneStep] })
      check('L1', '관찰한 요소를 실제로 클릭해 페이지가 바뀐다',
        r.state.clicked === true && r.types.includes('done'),
        `클릭됨=${r.state.clicked} · 이벤트 ${r.types.join('>')}`
        + (missed.length ? ` · 관찰에서 못 찾음(${missed[0].label}) 원문: ${missed[0].observation.replace(/\s+/g, ' ').slice(0, 400)}` : ''))
    }

    // ---- L2: 결제는 확인을 요구하고, 거부하면 실행되지 않는다 (가장 중요) ----
    {
      const r = await run({
        reqId: 'L2', task: '결제하기를 눌러라',
        script: [clickByLabel('결제하기'), doneStep], onConfirm: 'deny',
      })
      check('L2', '결제 클릭은 확인을 요구하고 거부하면 실행되지 않는다',
        r.types.includes('confirm') && r.state.paid === false,
        `확인요청=${r.types.includes('confirm')} · 결제실행=${r.state.paid}(false 여야 함) · ${r.types.join('>')}`)
    }

    // ---- L3: 승인하면 실행된다 ----
    {
      const r = await run({
        reqId: 'L3', task: '결제하기를 눌러라',
        script: [clickByLabel('결제하기'), doneStep], onConfirm: 'approve',
      })
      check('L3', '확인을 승인하면 그 동작이 실행된다',
        r.types.includes('confirm') && r.state.paid === true,
        `확인요청=${r.types.includes('confirm')} · 결제실행=${r.state.paid}(true 여야 함)`)
    }

    // ---- L4: ask 로 물으면 답을 받아 이어간다 ----
    {
      const script = [
        { reply: () => JSON.stringify({ action: 'ask', question: '어느 버튼을 누를까요?' }) },
        clickByLabel('확인'),
        doneStep,
      ]
      const r = await run({ reqId: 'L4', task: '무엇을 누를지 물어봐라', script, onAsk: '확인 버튼' })
      const gotAnswer = llm.requests.some((q) => String(q.lastUser).includes('확인 버튼'))
      check('L4', '질문에 답하면 그 답을 받아 작업을 이어간다',
        r.types.includes('ask') && gotAnswer && r.state.clicked === true,
        `질문=${r.types.includes('ask')} · 답 전달=${gotAnswer} · 이어서 클릭=${r.state.clicked}`)
    }

    // ---- L5: done 으로 종료하고 그 뒤 요청이 없다 ----
    {
      // setScript 가 카운터를 0 으로 되돌리므로 실행 후 절대값을 본다.
      const r = await run({ reqId: 'L5', task: '아무것도 하지 말고 끝내라', script: [doneStep] })
      await sleep(1200)
      const calls = llm.count
      check('L5', 'done 이면 즉시 끝나고 추가 호출이 없다',
        r.types.includes('done') && calls <= 2,
        `이벤트 ${r.types.join('>')} · LLM 호출 ${calls}회`)
    }

    // ---- L6: 무인 배치에서도 critical 은 자동 승인되지 않는다 ----
    {
      const r = await run({
        reqId: 'L6', task: '결제하기를 눌러라',
        script: [clickByLabel('결제하기'), doneStep],
        rows: [{ 값: '1' }], autoConfirm: true, timeoutMs: 25000,
      })
      // 자동 승인되면 paid=true 가 된다 — 그 일이 없어야 한다.
      check('L6', '무인 자동승인이어도 결제는 자동 실행되지 않는다',
        r.state.paid === false,
        `결제실행=${r.state.paid}(false 여야 함) · 이벤트 ${r.types.slice(0, 8).join('>')}`)
    }

    // ---- L7: 탭 열기·전환·닫기가 실제 탭 목록을 바꾸고, 현재 탭은 닫히지 않는다 ----
    {
      const tabsNow = async () => JSON.parse(await evalIn(shell,
        `window.browserAPI.tabs.list(${JSON.stringify(windowId)}).then(t => JSON.stringify(t.length))`, true) ?? '0')
      const before = await tabsNow()

      // 관찰문의 [탭N] 목록에서 현재 탭(▶)의 번호를 읽는다.
      const currentTabIndex = (obsText) => {
        const m = /\[탭(\d+)\]\s*▶/.exec(String(obsText))
        return m ? Number(m[1]) : null
      }
      let opened = -1
      const script = [
        { reply: () => JSON.stringify({ action: 'open_tab', url: pages.url + '?second', thought: '새 탭' }) },
        // 지금 조작 중인 탭을 닫으려 한다 — 거부되어야 한다.
        { reply: (ctx) => {
          opened = currentTabIndex(ctx.lastUser) ?? -1
          return JSON.stringify({ action: 'close_tab', index: opened, thought: '현재 탭 닫기 시도' })
        } },
        // 내부 페이지(새 탭)가 아니라 **시험 페이지 탭**으로 전환한다(내부 페이지는 관찰 대상이 아니다).
        { reply: () => JSON.stringify({ action: 'switch_tab', index: 1, thought: '시험 페이지 탭으로' }) },
        { reply: () => JSON.stringify({ action: 'close_tab', index: opened, thought: '아까 연 탭 닫기' }) },
        doneStep,
      ]
      const r = await run({ reqId: 'L7', task: '탭을 열고 닫아라', script, timeoutMs: 40000 })
      const after = await tabsNow()
      const results = r.evs.filter((e) => e.type === 'result').map((e) => JSON.stringify(e))
      const refused = results.some((t) => /현재|지금|닫을 수 없|먼저 전환/.test(t))
      check('L7', '탭 열기·전환·닫기가 동작하고 현재 탭은 닫히지 않는다',
        after === before && refused,
        `탭 ${before}→${after} · 거부=${refused} · opened=${opened} · 흐름 ${r.types.join('>')} · 결과들: ${results.slice(0, 5).join(' ').slice(0, 420)}`)
    }

    // ---- L8: 같은 동작을 반복하면 무한 루프 대신 사용자에게 묻는다 ----
    {
      const sameClick = { reply: (ctx) => {
        const ref = ctx.refFor('확인')
        return JSON.stringify({ action: 'click', ref: ref ?? 0, thought: '또 누름' })
      } }
      const r = await run({
        reqId: 'L8', task: '확인을 계속 눌러라',
        script: [sameClick, sameClick, sameClick, sameClick, sameClick, doneStep],
        onAsk: '그만하고 끝내라', timeoutMs: 45000,
      })
      const askEv = r.evs.find((e) => e.type === 'ask')
      check('L8', '같은 동작 반복을 감지해 사용자에게 묻는다',
        !!askEv && /반복/.test(String(askEv.message ?? '')),
        askEv ? `질문: ${String(askEv.message).slice(0, 70)}` : `질문 없음 · 이벤트 ${r.types.slice(0, 10).join('>')}`)
    }

    // ---- L9: done 이 오지 않아도 단계 상한에서 안전하게 끝난다 ----
    {
      await evalIn(shell, `window.browserAPI.settings.set('ai.agentMaxSteps', 4)`, true)
      await sleep(400)
      // 스크롤은 막힘 감지 대상이 아니므로 상한에 걸릴 때까지 계속된다.
      const forever = { reply: () => JSON.stringify({ action: 'scroll', dy: 100, thought: '계속 스크롤' }) }
      const r = await run({ reqId: 'L9', task: '끝없이 스크롤해라', script: [forever], timeoutMs: 45000 })
      const ended = r.types.some((t) => t === 'done' || t === 'error' || t === 'cancelled')
      check('L9', 'done 이 없어도 단계 상한에서 멈춘다(무한 루프 없음)',
        ended && llm.count <= 8,
        `종료=${ended}(${r.types.slice(-2).join('>')}) · LLM 호출 ${llm.count}회(상한 4 + 여유)`)
      await evalIn(shell, `window.browserAPI.settings.set('ai.agentMaxSteps', 8)`, true)
    }

    // ---- F1~F4: 자료 폴더 경계 — 폴더 밖 파일은 어떤 경로로도 붙지 않는다 ----
    {
      const upload = (name) => ({ reply: () => JSON.stringify({ action: 'upload_file', name, thought: name }) })
      const script = [
        upload('ok.txt'),
        upload('../outside/secret.txt'),
        upload(path.join(outsideDir, 'secret.txt').split(path.sep).join('/')),
        ...(symlinkOk ? [upload(linkPath)] : []),
        doneStep,
      ]
      const r = await run({ reqId: 'F', task: '파일을 붙여라', script, timeoutMs: 45000 })
      const res = r.evs.filter((e) => e.type === 'result' && String(e.label ?? '').includes('업로드'))
      const okCount = res.filter((e) => e.ok).length
      const refused = res.filter((e) => !e.ok).length
      const attached = await evalIn(page, '(document.getElementById("f")?.files?.length ?? 0)')
      const expectRefused = symlinkOk ? 3 : 2

      check('F1', '자료 폴더 안 파일은 실제로 첨부된다',
        okCount >= 1 && attached >= 1,
        `성공 ${okCount}건 · 페이지 input 파일 ${attached}개`)
      check('F2', `폴더 밖 경로는 전부 거부된다(상대·절대${symlinkOk ? '·심링크' : ''})`,
        refused === expectRefused,
        `거부 ${refused}/${expectRefused}건 · 상세: ${res.filter((e) => !e.ok).map((e) => String(e.detail ?? '')).join(' | ').slice(0, 160)}`)
      check('F3', '심링크 탈출 검사를 실제로 수행했다', symlinkOk,
        symlinkOk ? `${linkKind} 로 폴더 밖 링크 생성 — 검사 포함(${linkPath})` : '이 환경에서 심링크를 만들 수 없어 F4 는 건너뜀(권한). 상대·절대 경로 검사만 유효')
    }

    // ---- NP1: 발행 금지 모드에서 발행 버튼은 **코드로** 막힌다(프롬프트 지시가 아니라) ----
    {
      const NO_PUBLISH = '[모드: 발행 금지]'
      const r = await run({
        reqId: 'NP1', task: `${NO_PUBLISH} 글을 쓰고 임시저장만 해라`,
        script: [clickByLabel('발행'), doneStep], timeoutMs: 30000,
      })
      const blocked = r.evs.some((e) => e.type === 'result' && e.ok === false
        && /발행 금지/.test(String(e.detail ?? '')))
      check('NP1', '발행 금지 모드에서는 발행 버튼이 눌리지 않는다',
        r.state.published === false && blocked,
        `발행됨=${r.state.published}(false 여야 함) · 차단 메시지=${blocked}`)
    }

    // ---- RO1: 읽기 전용에서 입력·JS 실행이 차단되고 페이지가 바뀌지 않는다 ----
    {
      const typeStep = { reply: (ctx) => JSON.stringify({ action: 'type', ref: ctx.refFor('제목') ?? 0, text: '침입', thought: '입력 시도' }) }
      const jsStep = { reply: () => JSON.stringify({ action: 'run_js', code: 'document.getElementById("txt").value = "JS침입"', thought: 'JS 시도' }) }
      const r = await run({
        reqId: 'RO1', task: '이 페이지를 살펴보고 보고해라', readOnly: true,
        script: [typeStep, jsStep, doneStep], timeoutMs: 30000,
      })
      const refusals = r.evs.filter((e) => e.type === 'result' && e.ok === false
        && /읽기 전용/.test(String(e.detail ?? '')))
      check('RO1', '읽기 전용에서 입력·JS 가 차단되고 페이지가 안 바뀐다',
        refusals.length >= 2 && String(r.state.typed) === '',
        `차단 ${refusals.length}건(2 이상이어야 함) · 입력칸 내용="${r.state.typed}"(비어야 함)`)
    }

    // ---- RO2: 읽기 전용에서도 열람·스크롤은 정상 동작한다(양성 대조) ----
    {
      const r = await run({
        reqId: 'RO2', task: '이 페이지를 읽고 보고해라', readOnly: true,
        script: [
          { reply: () => JSON.stringify({ action: 'scroll', dy: 200, thought: '스크롤' }) },
          { reply: () => JSON.stringify({ action: 'read', thought: '읽기' }) },
          doneStep,
        ], timeoutMs: 30000,
      })
      const okResults = r.evs.filter((e) => e.type === 'result' && e.ok === true).length
      check('RO2', '읽기 전용에서도 열람·스크롤은 된다(양성 대조)',
        okResults >= 1 && r.types.includes('done'),
        `성공한 동작 ${okResults}건 — 0 이면 RO1 은 "전부 막혀서" 통과한 것이다`)
    }

    try { page.close() } catch { /* ignore */ }
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
    await pages.close()
  }

  fs.writeFileSync(path.join(args.out, 'agent-loop-results.json'), JSON.stringify(results, null, 2))
  console.log('\n===== verify-agent-loop 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL')
  console.log(`PASS=${results.length - fail.length} FAIL=${fail.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
