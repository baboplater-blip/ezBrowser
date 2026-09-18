#!/usr/bin/env node
// verify-frames-cdp.mjs — 교차 출처 iframe 제어 · ref 키 동작 안전 · 로그인/CAPTCHA 넘기기
//
// 왜 (2026-09-18):
//   A) 관찰·조작 스크립트는 최상위 문서에서만 돌아서, 다른 출처 iframe(로그인·결제·업로드 UI)이 나오면
//      에이전트가 "못 본다"로 멈췄다. 이제 메인 프로세스가 WebFrameMain 으로 그 프레임 문서에서 직접
//      관찰·조작한다. **정말 되는지**를 실제 패키징된 앱 + 2오리진 fixture 로 본다.
//   B) pressKey 는 ref 검증 실패를 삼키고 "지금 포커스" 에 키를 그대로 보냈다 — Ctrl+A/Delete/Enter 가
//      엉뚱한 곳으로 가는 조용한 사고. 이제 즉시 실패해야 한다(부정 대조 포함).
//   C) 로그인/CAPTCHA 화면에서 루프를 다 태우지 않고 곧바로 사용자에게 넘겨야 한다. 우회·자동 해결은 하지 않는다.
//
// 판정은 전부 "사용자가 보는 동작" 기준 — 프레임 안 페이지의 실제 DOM 상태, 작업 상태(waiting-user),
// 그리고 **가짜 LLM 이 실제로 받은 프롬프트 전문**(허용 밖 프레임 텍스트가 새지 않았는지)으로 확인한다.
//
//   F1 교차출처 프레임의 요소가 관찰 목록에 들어온다
//   F2 프레임 안 입력 → 드롭다운 선택 → 클릭이 프레임 페이지 상태를 실제로 바꾼다
//   F3 프레임 안 key 동작이 그 프레임 요소에 간다
//   F4 프레임 안 scroll 이 그 프레임을 스크롤한다
//   F5 프레임 재로드 뒤 옛 ref 는 거부된다(stale)
//   F6 허용 목록 밖 프레임은 열지 않는다 — 그 안의 문자열이 모델 프롬프트에 한 글자도 없다
//   F7 request_scope 는 사용자가 승인해야만 범위를 넓힌다(거부하면 그대로 막힘)
//   F8 사람 입력(trusted)으로 프레임 버튼을 정확히 누른다 + DOM 속성 변형 0(봇 지문 없음)
//   K1 유효 ref 키 동작은 그 요소에 간다
//   K2 무효 ref 키 동작은 **키를 한 개도 보내지 않고** 실패한다 ← 부정 대조
//   C1 로그인 화면 감지 → waiting-user, 모델 호출 0회
//   C2 사용자가 직접 처리 후 "계속" → 이어서 진행
//   C3 CAPTCHA 화면 감지 → waiting-user (풀지 않는다)
//   C4 '로그인'·'verify' 단어만 있는 평범한 문서는 감지되지 않는다 ← 부정 대조(오탐 방지)
//
// 사용: node build/verify-frames-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, getTargetList, waitForPortFree, connectShellSessionReady, ensureSessionReady } from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'
import { startFramesFixture } from './frames-fixture-server.mjs'
import { startChallengeFixture } from './challenge-fixture-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9271, out: path.join(REPO, 'verify-out', 'frames') }
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

// 관찰 블록에서 "(프레임 host) 이름" 형태의 요소 번호를 고른다.
function frameRef(prompt, host, nameFragment) {
  const re = /\[(\d+)\]\s+\S+\s+"([^"]*)"/g
  let m
  while ((m = re.exec(prompt ?? ''))) {
    const nm = String(m[2])
    if (nm.includes(`(프레임 ${host})`) && nm.includes(nameFragment)) return Number(m[1])
  }
  return null
}
function plainRef(prompt, nameFragment) {
  const re = /\[(\d+)\]\s+\S+\s+"([^"]*)"/g
  let m
  while ((m = re.exec(prompt ?? ''))) {
    const nm = String(m[2])
    if (!nm.startsWith('(프레임') && nm.includes(nameFragment)) return Number(m[1])
  }
  return null
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE} — 먼저 npm run package:win`)
  fs.mkdirSync(args.out, { recursive: true })
  args.port = await preferFreePort(args.port, 'verify-frames-cdp.mjs')
  await waitForPortFree(args.port)
  const [llmPort] = await getFreePorts(1)

  const llm = await startFakeLlm({ port: llmPort })
  const fx = await startFramesFixture()
  const ch = await startChallengeFixture()
  const childHost = new URL(fx.childOrigin).hostname
  void new URL(fx.childOrigin).port
  const thirdHost = new URL(fx.thirdOrigin).hostname
  // 부모·자식은 127.0.0.1, 제3 오리진은 localhost — 허용 목록은 **호스트 기준**이라 포트만 다르면
  // 허용/차단을 가를 수 없다(프레임 fixture 가 그래서 제3 오리진만 localhost 로 서빙한다).
  const parentUrl = fx.parentUrl

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const writeSettings = (extra = {}) => fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true },
    startup: { mode: 'newtab', urls: [] },
    adblock: { enabled: false },
    ai: {
      enabled: true, provider: 'ollama', ollamaUrl: llm.url, ollamaModel: 'test-model',
      agentMaxSteps: 10, agentAutoApprove: false, agentVision: 'off', agentHumanInput: false,
      ...extra,
    },
  }, null, 2))
  writeSettings()

  const logStream = fs.createWriteStream(path.join(args.out, 'app.log'))
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
    await evalIn(shell, 'window.__ev = []; window.browserAPI.ai.onAgentEvent((e) => window.__ev.push(e)); true')

    const tabId = await evalIn(shell,
      `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(parentUrl)}).then(t => t.id)`, true)
    await sleep(2800)

    // 부모 문서 세션(프레임 상태를 확인하려면 프레임 타깃에 따로 붙는다)
    const targets = await getTargetList(args.port)
    const parentTarget = targets.find((t) => String(t.url).startsWith(fx.parentUrl))
    if (!parentTarget) throw new Error('부모 페이지 타깃을 찾지 못함')
    const parentPage = await connectSession(parentTarget, 'page')
    await ensureSessionReady(parentPage)
    // 자식 프레임(교차 출처)은 OOPIF 라 /json/list 에도 부모 JS 에도 안 잡힌다 → fixture 가 postMessage 로
    // 보내 주는 상태를 부모에서 읽는다. (검증이 프레임 안을 직접 보는 유일한 경로.)
    async function frameState(which = 'form') {
      await evalIn(parentPage, 'window.__askFrameState && window.__askFrameState(); true')
      await sleep(400)
      const raw = await evalIn(parentPage, `JSON.stringify((window.__frameState||{})[${JSON.stringify(which)}] || null)`)
      try { return JSON.parse(raw ?? 'null') } catch { return null }
    }
    async function resetFrameState() {
      await evalIn(parentPage, 'window.__resetFrameState && window.__resetFrameState(); true')
      await sleep(400)
    }

    /** 각본을 걸고 에이전트를 돌린다. 반환: { events, prompts } */
    async function run({ script, reqId, task, allowedHosts, onConfirm, onAsk, humanInput, timeoutMs = 45000 }) {
      llm.setScript(script)
      await evalIn(shell, 'window.__ev = []; true')
      const startArgs = { reqId, tabId, task, ...(allowedHosts ? { allowedHosts } : {}) }
      await evalIn(shell, `window.browserAPI.ai.agentStart(${JSON.stringify(startArgs)})`, true)
      const deadline = Date.now() + timeoutMs
      let didConfirm = false, didAsk = false
      while (Date.now() < deadline) {
        const list = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ev)') ?? '[]')
        if (!didConfirm && onConfirm && list.some((e) => e.type === 'confirm')) {
          didConfirm = true
          // 함수면 먼저 실행한다 — "확인 대기 중에 화면이 바뀌는" 상황을 결정적으로 만들 때 쓴다.
          const approve = typeof onConfirm === 'function' ? await onConfirm() : onConfirm === 'approve'
          await evalIn(shell, `window.browserAPI.ai.agentConfirm(${JSON.stringify(reqId)}, ${!!approve})`, true)
        }
        if (!didAsk && onAsk && list.some((e) => e.type === 'ask')) {
          didAsk = true
          if (typeof onAsk === 'function') await onAsk()
          await evalIn(shell, `window.browserAPI.ai.agentReply(${JSON.stringify(reqId)}, ${JSON.stringify(typeof onAsk === 'function' ? '계속' : onAsk)})`, true)
        }
        if (list.some((e) => e.type === 'done' || e.type === 'error' || e.type === 'cancelled')) break
        await sleep(350)
      }
      const events = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ev)') ?? '[]')
      try { fs.writeFileSync(path.join(args.out, `events-${reqId}.json`), JSON.stringify(events, null, 2)) } catch { /* ignore */ }
      const prompts = llm.requests.map((r) => {
        const msgs = Array.isArray(r.messages) ? r.messages : []
        return msgs.map((m) => String(m.content ?? '')).join('\n')
      })
      return { events, prompts, all: prompts.join('\n') }
    }

    // ───────────────────────────────────────────────────────────────
    // F1 — 교차출처 프레임 요소가 관찰에 들어오는가
    // ───────────────────────────────────────────────────────────────
    let obs1 = ''
    {
      const r = await run({
        reqId: 'F1', task: '프레임 확인',
        script: [{ reply: (c) => { obs1 = c.lastUser; return '{"action":"done","message":"확인"}' } }],
      })
      const hasFrameEl = /\(프레임 /.test(obs1)
      const hasFrameSection = obs1.includes('[프레임]') && obs1.includes(childHost)
      const hasChildMark = obs1.includes('CHILD_FORM_MARK')
      check('F1', '교차출처 프레임 관찰', hasFrameEl && hasFrameSection && hasChildMark,
        `프레임요소=${hasFrameEl} 프레임섹션=${hasFrameSection} 프레임본문=${hasChildMark} (이벤트 ${r.events.length}개)`)
    }

    // ───────────────────────────────────────────────────────────────
    // F2 — 프레임 안 입력 → select → 클릭이 실제 상태를 바꾸는가
    // ───────────────────────────────────────────────────────────────
    {
      let promptSeen = ''
      const r = await run({
        reqId: 'F2', task: '프레임 폼 제출',
        script: [
          { reply: (c) => { promptSeen = c.lastUser; const ref = frameRef(c.lastUser, childHost, '이름'); return JSON.stringify({ action: 'type', ref, text: '홍길동' }) } },
          { reply: (c) => { const ref = frameRef(c.lastUser, childHost, '알파') ?? frameRef(c.lastUser, childHost, '베타') ?? frameRef(c.lastUser, childHost, '감마'); return JSON.stringify({ action: 'select', ref, text: '감마' }) } },
          { reply: (c) => JSON.stringify({ action: 'click', ref: frameRef(c.lastUser, childHost, '프레임 제출') }) },
          { reply: () => '{"action":"done","message":"제출 완료"}' },
        ],
      })
      const st = await frameState()
      const out = st?.out ?? ''
      const ok = String(out).startsWith('FRAME_SUBMITTED:홍길동:c')
      check('F2', '프레임 안 입력·선택·클릭', ok, `프레임 결과="${out}" (기대 FRAME_SUBMITTED:홍길동:c)`)
      if (!ok) fs.writeFileSync(path.join(args.out, 'F2-prompt.txt'), promptSeen)
    }

    // ───────────────────────────────────────────────────────────────
    // F3 / K1 — 프레임 안 key 동작
    // ───────────────────────────────────────────────────────────────
    {
      const r = await run({
        reqId: 'F3', task: '프레임 키 입력',
        script: [
          { reply: (c) => JSON.stringify({ action: 'key', key: 'Enter', ref: frameRef(c.lastUser, childHost, '키입력') }) },
          { reply: () => '{"action":"done","message":"키 완료"}' },
        ],
      })
      const st = await frameState()
      const lastKey = st?.lastKey ?? ''
      const keyResult = r.events.find((e) => e.type === 'result' && String(e.label ?? '').startsWith('키'))
      const ok = lastKey === 'Enter'
      check('F3', '프레임 안 키 동작', ok, `프레임이 받은 키="${lastKey}" · 결과=${keyResult ? `${keyResult.ok}/${keyResult.detail}` : '없음'}`)
      check('K1', '유효 ref 키 동작 성공', !!keyResult?.ok, `detail=${keyResult?.detail ?? '없음'}`)
    }

    // ───────────────────────────────────────────────────────────────
    // F4 — 프레임 안 스크롤
    // ───────────────────────────────────────────────────────────────
    {
      await run({
        reqId: 'F4', task: '프레임 스크롤',
        script: [
          { reply: (c) => JSON.stringify({ action: 'scroll', direction: 'down', ref: frameRef(c.lastUser, childHost, '프레임 제출') }) },
          { reply: () => '{"action":"done","message":"스크롤"}' },
        ],
      })
      const st = await frameState()
      const y = st?.scrollY ?? 0
      check('F4', '프레임 안 스크롤', Number(y) > 50, `프레임 scrollY=${y}`)
    }

    // ───────────────────────────────────────────────────────────────
    // F8 — 사람 입력(trusted)으로 프레임 버튼 정확히 클릭 + DOM 지문 0
    // ───────────────────────────────────────────────────────────────
    {
      // 프레임 상태 초기화 — 속성 변형 카운터도 0으로(이 시나리오의 관찰·클릭만 세기 위해)
      await resetFrameState()
      // 사람 입력 켜고 재기동 대신, 설정 변경 IPC 로 전환한다(앱 재시작 없이).
      await evalIn(shell, 'window.browserAPI.settings ? window.browserAPI.settings.set("ai.agentHumanInput", true) : null', true).catch(() => {})
      await run({
        reqId: 'F8', task: '프레임 버튼 클릭(사람 입력)',
        script: [
          { reply: (c) => JSON.stringify({ action: 'click', ref: frameRef(c.lastUser, childHost, '프레임 제출') }) },
          { reply: () => '{"action":"done","message":"클릭"}' },
        ],
      })
      const st = await frameState()
      const clicked = st?.clicked === true
      const mutations = st?.attrMutations ?? -1
      check('F8', '프레임 실제 입력 + 지문 0', clicked === true && Number(mutations) === 0,
        `프레임 버튼 눌림=${clicked} · 관찰이 만든 DOM 속성 변형=${mutations}건(0이어야 함)`)
      await evalIn(shell, 'window.browserAPI.settings ? window.browserAPI.settings.set("ai.agentHumanInput", false) : null', true).catch(() => {})
    }

    // ───────────────────────────────────────────────────────────────
    // K2 — 무효 ref 키 동작은 키를 보내지 않는다 (부정 대조)
    // ───────────────────────────────────────────────────────────────
    {
      await resetFrameState()
      // 최상위 입력칸에 포커스를 둔 상태에서, **존재하지 않는 큰 ref** 로 키를 보낸다.
      // 옛 동작이라면 검증 실패를 삼키고 "지금 포커스"(최상위 입력칸)에 Delete 가 그대로 갔다.
      await evalIn(parentPage, 'document.title = "TITLE_BEFORE_K2"; true')
      const r = await run({
        reqId: 'K2', task: '무효 ref 키',
        // 확인 게이트("대상을 알 수 없는 Enter 제출")가 먼저 뜬다 — **승인**해서 통과시킨 뒤,
        // 그래도 키가 나가지 않는지 본다(게이트가 막아 준 게 아니라 pressKey 가 막는다는 것을 확인).
        onConfirm: 'approve',
        script: [
          { reply: () => JSON.stringify({ action: 'key', key: 'Enter', ref: 9999 }) },
          { reply: () => '{"action":"done","message":"끝"}' },
        ],
      })
      const st = await frameState()
      const lastKey = st?.lastKey ?? ''
      const keyResult = r.events.find((e) => e.type === 'result' && String(e.label ?? '').startsWith('키'))
      const failedProperly = keyResult && keyResult.ok === false && /키를 보내지 않았습니다/.test(String(keyResult.detail ?? ''))
      check('K2', '무효 ref 키 — 전송 안 함(부정 대조)', !!failedProperly && lastKey === '',
        `결과 ok=${keyResult?.ok} detail="${String(keyResult?.detail ?? '').slice(0, 80)}" · 프레임이 받은 키="${lastKey}"(비어야 함)`)
    }

    // ───────────────────────────────────────────────────────────────
    // F5 — 관찰 뒤 프레임이 다른 문서로 바뀌면 그 번호는 거부된다(stale)
    //
    // 루프는 매 단계 다시 관찰하므로 "옛 번호" 창은 관찰과 실행 사이로 좁다. 그 창을 결정적으로 만들려면
    // **확인 게이트**를 쓴다: 위험 라벨("결제하기")이면 사용자 승인을 기다리는데, 그 대기 중에 프레임을
    // 갈아치우고 승인하면 실행은 옛 관찰 기준으로 일어난다. 이때 거부되지 않으면 "지금 그 자리에 있는
    // 다른 요소"를 결제 버튼인 줄 알고 누르게 된다 — 이 검사가 막으려는 바로 그 사고다.
    // ───────────────────────────────────────────────────────────────
    {
      await evalIn(parentPage, `document.getElementById('f1').src = ${JSON.stringify(fx.childOrigin + '/form')}; true`)
      await sleep(1400)
      await resetFrameState()
      const r = await run({
        reqId: 'F5', task: '프레임 결제 버튼',
        onConfirm: async () => {
          // 승인 직전에 프레임을 다른 문서로 갈아치운다.
          await evalIn(parentPage, `document.getElementById('f1').src = ${JSON.stringify(fx.childOrigin + '/reload-marker')}; true`)
          await sleep(1500)
          return true   // 승인 — 그래도 실행되면 안 된다
        },
        script: [
          { reply: (c) => JSON.stringify({ action: 'click', ref: frameRef(c.lastUser, childHost, '결제하기') }) },
          { reply: () => '{"action":"done","message":"끝"}' },
        ],
        timeoutMs: 40000,
      })
      const clickRes = r.events.find((e) => e.type === 'result' && /클릭/.test(String(e.label ?? '')))
      const rejected = !!clickRes && clickRes.ok === false
        && /(다시 관찰|프레임|찾을 수 없|사라지거나|바뀌었)/.test(String(clickRes.detail ?? ''))
      // 프레임을 되돌린 뒤 결제가 실제로 일어나지 않았는지 확인한다.
      await evalIn(parentPage, `document.getElementById('f1').src = ${JSON.stringify(fx.childOrigin + '/form')}; true`)
      await sleep(1400)
      const st = await frameState()
      const notPaid = st ? st.paid !== true : true
      check('F5', '프레임이 바뀐 뒤 옛 번호 거부', rejected && notPaid,
        `거부=${clickRes?.ok === false} 사유="${String(clickRes?.detail ?? '(없음)').slice(0, 80)}" · 결제 실행됨=${!notPaid}(false 여야 함)`)
    }

    // ───────────────────────────────────────────────────────────────
    // F6 — 허용 목록 밖 프레임은 열지 않는다(텍스트 0 유출)
    // ───────────────────────────────────────────────────────────────
    {
      const r = await run({
        reqId: 'F6', task: '허용 범위 확인',
        allowedHosts: ['127.0.0.1'],   // 제3 오리진(localhost)은 허용 목록 밖
        script: [{ reply: () => '{"action":"done","message":"확인"}' }],
      })
      const leaked = r.all.includes('SECRET_C_TEXT_MUST_NOT_LEAK')
      const reported = r.all.includes('[열지 않은 프레임]') && r.all.includes(thirdHost)
      const sawAllowed = r.all.includes('CHILD_FORM_MARK')
      check('F6', '허용 밖 프레임 미열람(텍스트 0 유출)', !leaked && reported && sawAllowed,
        `비밀문자열 유출=${leaked}(false 여야 함) · 차단보고=${reported} · 허용프레임은 보임=${sawAllowed}`)
    }

    // ───────────────────────────────────────────────────────────────
    // F7 — request_scope: 승인해야만 넓어진다
    // ───────────────────────────────────────────────────────────────
    {
      // 7-1 거부
      const rDeny = await run({
        reqId: 'F7d', task: '범위 요청 거부',
        allowedHosts: ['127.0.0.1'],
        onConfirm: 'deny',
        script: [
          { reply: () => JSON.stringify({ action: 'request_scope', host: thirdHost, message: '비밀 프레임 확인 필요' }) },
          { reply: (c) => { const leaked = c.lastUser.includes('SECRET_C_TEXT_MUST_NOT_LEAK'); return JSON.stringify({ action: 'done', message: `거부후유출=${leaked}` }) } },
        ],
      })
      const denyLeak = rDeny.all.includes('SECRET_C_TEXT_MUST_NOT_LEAK')
      const denyConfirmed = rDeny.events.some((e) => e.type === 'confirm')
      // 7-2 승인
      const rOk = await run({
        reqId: 'F7a', task: '범위 요청 승인',
        allowedHosts: ['127.0.0.1'],
        onConfirm: 'approve',
        script: [
          { reply: () => JSON.stringify({ action: 'request_scope', host: thirdHost, message: '비밀 프레임 확인 필요' }) },
          { reply: () => JSON.stringify({ action: 'read' }) },
          { reply: (c) => JSON.stringify({ action: 'done', message: `승인후보임=${c.lastUser.includes('SECRET_C_TEXT_MUST_NOT_LEAK')}` }) },
        ],
      })
      const approvedLeak = rOk.all.includes('SECRET_C_TEXT_MUST_NOT_LEAK')
      check('F7', 'request_scope 는 명시 승인으로만', denyConfirmed && !denyLeak && approvedLeak,
        `확인창=${denyConfirmed} · 거부시 열람=${denyLeak}(false 여야) · 승인시 열람=${approvedLeak}(true 여야)`)
    }

    // ───────────────────────────────────────────────────────────────
    // C1~C4 — 로그인 / CAPTCHA
    // ───────────────────────────────────────────────────────────────
    const gotoTab = async (url) => {
      await evalIn(shell, `window.browserAPI.tabs.navigate(${JSON.stringify(tabId)}, ${JSON.stringify(url)})`, true)
      await sleep(1600)
    }

    {
      await gotoTab(ch.urls.login)
      const r = await run({
        reqId: 'C1', task: '로그인 화면에서 작업',
        script: [{ reply: () => '{"action":"done","message":"여기 오면 안 됨"}' }],
        onAsk: null, timeoutMs: 15000,
      })
      const chEv = r.events.find((e) => e.type === 'challenge')
      const askEv = r.events.find((e) => e.type === 'ask')
      const calls = llm.count
      check('C1', '로그인 화면 감지 → 사용자에게 넘김', chEv?.kind === 'login' && !!askEv && calls === 0,
        `challenge=${chEv?.kind ?? '없음'} · ask=${!!askEv} · 모델호출=${calls}회(0이어야 함) · 근거="${String(chEv?.evidence ?? '')}"`)
      // 대기 중인 실행을 정리
      await evalIn(shell, `window.browserAPI.ai.agentCancel(${JSON.stringify('C1')})`, true).catch(() => {})
      await sleep(400)
    }

    {
      // C2 — 사용자가 직접 처리 후 "계속" → 이어서 진행
      await gotoTab(ch.urls.login)
      llm.setScript([
        { reply: () => JSON.stringify({ action: 'click', ref: plainRef(llm.requests.at(-1)?.messages?.at(-1)?.content ?? '', '최종 버튼') ?? 0 }) },
        { reply: () => '{"action":"done","message":"재개 후 완료"}' },
      ])
      await evalIn(shell, 'window.__ev = []; true')
      await evalIn(shell, `window.browserAPI.ai.agentStart(${JSON.stringify({ reqId: 'C2', tabId, task: '로그인 뒤 이어서' })})`, true)
      // 대기 상태가 될 때까지
      let asked = false
      for (let i = 0; i < 40 && !asked; i++) {
        const list = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ev)') ?? '[]')
        asked = list.some((e) => e.type === 'ask')
        if (!asked) await sleep(300)
      }
      // 사용자가 브라우저에서 직접 로그인했다고 가정 → 페이지를 /after 로 이동
      await gotoTab(ch.urls.after)
      await evalIn(shell, `window.browserAPI.ai.agentReply(${JSON.stringify('C2')}, ${JSON.stringify('계속')})`, true)
      for (let i = 0; i < 60; i++) {
        const list = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ev)') ?? '[]')
        if (list.some((e) => e.type === 'done' || e.type === 'error')) break
        await sleep(300)
      }
      const evs = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ev)') ?? '[]')
      const resumed = evs.some((e) => e.type === 'answer') && evs.some((e) => e.type === 'done')
      const observedAfter = evs.some((e) => e.type === 'observe' && String(e.url ?? '').includes('/after'))
      check('C2', '사용자 처리 후 재개', asked && resumed && observedAfter,
        `대기=${asked} · 재개·완료=${resumed} · 처리 후 화면 관찰=${observedAfter}`)
    }

    {
      await gotoTab(ch.urls.captcha)
      const r = await run({
        reqId: 'C3', task: 'CAPTCHA 화면에서 작업',
        script: [{ reply: () => '{"action":"done","message":"여기 오면 안 됨"}' }],
        onAsk: null, timeoutMs: 15000,
      })
      const chEv = r.events.find((e) => e.type === 'challenge')
      const calls = llm.count
      check('C3', 'CAPTCHA 화면 감지 → 사용자에게 넘김', chEv?.kind === 'captcha' && calls === 0,
        `challenge=${chEv?.kind ?? '없음'} · 모델호출=${calls}회 · 근거="${String(chEv?.evidence ?? '')}"`)
      await evalIn(shell, `window.browserAPI.ai.agentCancel(${JSON.stringify('C3')})`, true).catch(() => {})
      await sleep(400)
    }

    {
      // C4 — 오탐 대조군: '로그인'·'verify'·'인증' 단어만 있는 평범한 문서
      await gotoTab(ch.urls.normalWords)
      const r = await run({
        reqId: 'C4', task: '평범한 안내 문서 읽기',
        script: [
          { reply: (c) => JSON.stringify({ action: 'click', ref: plainRef(c.lastUser, '계속') ?? 0 }) },
          { reply: () => '{"action":"done","message":"정상 진행"}' },
        ],
        timeoutMs: 20000,
      })
      const chEv = r.events.find((e) => e.type === 'challenge')
      const progressed = r.events.some((e) => e.type === 'done')
      const sawWords = r.all.includes('NORMAL_WORDS_MARK')
      check('C4', '단어만 있는 문서는 감지 안 함(부정 대조)', !chEv && progressed && sawWords,
        `challenge=${chEv?.kind ?? '없음'}(없어야 함) · 정상완료=${progressed} · 대조군페이지=${sawWords}`)
    }

    // ───────────────────────────────────────────────────────────────
    // C-UI — 영속 작업(UI가 보는 상태)에서 로그인 대기·재개
    // ───────────────────────────────────────────────────────────────
    {
      await gotoTab(ch.urls.captcha)
      llm.setScript([{ reply: () => '{"action":"done","message":"여기 오면 안 됨"}' }])
      const created = JSON.parse(await evalIn(shell,
        `window.browserAPI.ai.ptaskCreate({ instruction: 'CAPTCHA 화면 작업', tabId: ${JSON.stringify(tabId)} }).then(t => JSON.stringify(t))`, true) ?? 'null')
      let waitState = null
      if (created?.id) {
        await evalIn(shell, `window.browserAPI.ai.ptaskStart(${JSON.stringify(created.id)})`, true)
        for (let i = 0; i < 50; i++) {
          const t = JSON.parse(await evalIn(shell,
            `window.browserAPI.ai.ptaskGet(${JSON.stringify(created.id)}).then(x => JSON.stringify(x))`, true) ?? 'null')
          if (t && t.state === 'waiting-user') { waitState = t; break }
          await sleep(350)
        }
      }
      const reasonOk = !!waitState && /🧩|사람 확인/.test(String(waitState.waitReason ?? ''))
      check('C-UI', 'UI 상태: 대기 + 사유 표시', !!waitState && reasonOk,
        `상태=${waitState?.state ?? '없음'} · 사유="${String(waitState?.waitReason ?? '').slice(0, 70)}"`)
      if (created?.id) {
        await evalIn(shell, `window.browserAPI.ai.ptaskCancel(${JSON.stringify(created.id)})`, true).catch(() => {})
        await evalIn(shell, `window.browserAPI.ai.ptaskDelete(${JSON.stringify(created.id)})`, true).catch(() => {})
      }
    }
  } finally {
    try { await shell?.send('Browser.close', {}) } catch { /* ignore */ }
    await sleep(1200)
    try { child.kill() } catch { /* ignore */ }
    await llm.close(); await fx.close(); await ch.close()
    try { logStream.end() } catch { /* ignore */ }
  }

  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  fs.writeFileSync(path.join(args.out, 'frames-results.json'),
    JSON.stringify({ when: new Date().toISOString(), pass, fail, results }, null, 2))
  console.log(`\n교차출처 프레임·키 안전·로그인/CAPTCHA: ${pass} PASS / ${fail} FAIL`)
  if (fail > 0) process.exitCode = 1
}

main().catch((err) => { console.error(err); process.exitCode = 2 })
