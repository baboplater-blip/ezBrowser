#!/usr/bin/env node
// verify-intent-ui-cdp.mjs — 에이전트 입력창에 **자연어로 적은 한 줄**이 확인 카드를 거쳐
// **기존 생산 워크플로**(buildBlogEngageTask → 영속 작업 / socialStart)로 실제로 이어지는지 본다.
//
// 왜 필요한가 (2026-09-19):
//   `verify-intent-routing.mjs` 는 순수 함수(의도 해석)만 본다 — "해석은 맞는데 화면에서 아무 일도
//   안 일어난다"를 잡지 못한다. 그리고 이 갭은 안전 문제다: `agent.ts` 의 참여 가드 블록 전체가
//   `parseEngageMark(task)` 성공에만 걸려 있고, 그 표식은 **오직 buildBlogEngageTask** 만 만든다.
//   자연어가 레시피를 안 거치면 중복 방지 장부·글 수·간격·초안 모드가 **하나도** 걸리지 않는다.
//   그래서 여기서는 작업 지시문에 **표식이 실려 있는지**를 직접 확인한다(문자열 비교가 아니라
//   "레시피를 통과했다"는 증거다 — 하네스가 지시문을 손으로 만들면 얻을 수 없는 증거).
//
// 모델은 부르지 않는다 — `lib/fake-llm.mjs` 로 `ai.ollamaUrl` 을 돌리고, 작업은 만들어지자마자
// 취소한다(실제 페이지 조작 없이 "생산 경로를 탔는가"만 본다).
//
// 조작은 **사용자가 누르는 경로 그대로** 한다(입력창 타이핑 → 전송 → 카드 필드 → 실행 버튼).
// 조회(ptaskList/ptaskGet/socialGrantGet)는 판정에만 쓴다.
//
// 사용: node build/verify-intent-ui-cdp.mjs [--port <n>] [--out <dir>] [--keep-profile]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, connectShellSessionReady, sleep, waitForPortFree } from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')
const ASAR = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar')

const args = { port: 9291, out: path.join(REPO_ROOT, 'verify-out', 'intent-ui'), keepProfile: false }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--keep-profile') args.keepProfile = true
}

const results = []
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
  return ok
}

function startPageServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end('<!doctype html><meta charset="utf-8"><title>의도 라우팅 검증</title>'
        + '<body style="font:16px system-ui;padding:24px"><h1>의도 라우팅 검증용 페이지</h1></body>')
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      resolve({
        url: `http://127.0.0.1:${actual}/`,
        async close() {
          await new Promise((r) => {
            try { server.closeAllConnections?.() } catch { /* ignore */ }
            const t = setTimeout(r, 3000)
            server.close(() => { clearTimeout(t); r() })
          })
        },
      })
    })
  })
}

// 각본은 쓰지 않는다 — 작업은 만들자마자 취소하므로 첫 응답만 있으면 된다.
const router = { reply: () => JSON.stringify({ action: 'done', message: '검증용 즉시 종료' }) }

async function evaluate(session, expression, timeoutMs = 20_000) {
  const r = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'JS 예외')
  return r.result?.value
}

async function pollExpr(session, expression, predicate, { timeoutMs = 20_000, intervalMs = 400, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await evaluate(session, expression)
    if (predicate(last)) return last
    await sleep(intervalMs)
  }
  throw new Error(`timeout(${timeoutMs}ms) — ${label} · 마지막 값: ${JSON.stringify(last)}`)
}

async function setFieldValue(session, selector, value) {
  return evaluate(session, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return el.value
  })()`)
}

async function clickSelector(session, selector) {
  return evaluate(session, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el || el.disabled) return false
    el.click(); return true
  })()`)
}

async function clickByTextIncludes(session, selector, needle) {
  return evaluate(session, `(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const el = els.find(x => (x.textContent || '').includes(${JSON.stringify(needle)}))
    if (!el) return false
    el.click(); return true
  })()`)
}

const CARD = '.ai-intent-card'
const cardExpr = `(() => {
  const c = document.querySelector('${CARD}')
  if (!c) return null
  const val = (n) => { const el = c.querySelector('[data-intent="' + n + '"]'); return el ? (el.value ?? el.textContent ?? '') : null }
  const run = c.querySelector('[data-intent="run"]')
  return {
    kind: c.getAttribute('data-intent-kind'),
    topic: val('topic'), account: val('account'), maxposts: val('maxposts'), prompt: val('prompt'),
    runDisabled: run ? !!run.disabled : null,
    needed: [...c.querySelectorAll('[data-intent-needed]')].map(e => e.getAttribute('data-intent')),
  }
})()`

async function openAiPanel(session, windowId) {
  await evaluate(session, `window.browserAPI.actions.run('action.ai.open', { windowId: ${JSON.stringify(windowId)} })`)
  const deadline = Date.now() + 20_000
  let reopened = false
  while (Date.now() < deadline) {
    if (await evaluate(session, `!!document.querySelector('.ai-tab')`)) return true
    if (!reopened && Date.now() > deadline - 12_000) {
      await evaluate(session, `window.browserAPI.actions.run('action.ai.open', { windowId: ${JSON.stringify(windowId)} })`)
      reopened = true
    }
    await sleep(500)
  }
  return false
}

async function ensureAgentReady(session) {
  await clickByTextIncludes(session, '.ai-mode-btn', '에이전트')
  await sleep(250)
  await pollExpr(session, `!!document.querySelector('.ai-input-row textarea.ai-input:not(:disabled)')`, (v) => v === true,
    { timeoutMs: 15_000, label: '에이전트 입력창 준비' })
}

/** 입력창에 자연어를 치고 전송 — 사용자가 하는 그대로. */
async function typeAndSend(session, text) {
  await setFieldValue(session, '.ai-input-row textarea.ai-input', text)
  await sleep(150)
  const clicked = await clickSelector(session, '.ai-input-row .ai-send')
  if (!clicked) throw new Error(`전송 버튼이 눌리지 않았다(비활성): ${text}`)
}

async function ptaskSnapshot(session) {
  return evaluate(session, `(async () => {
    const list = await window.browserAPI.ai.ptaskList()
    return list.map(t => ({ id: t.id, instruction: t.instruction || '' }))
  })()`)
}

async function cancelAllPtasks(session) {
  await evaluate(session, `(async () => {
    const list = await window.browserAPI.ai.ptaskList()
    for (const t of list) { try { await window.browserAPI.ai.ptaskCancel(t.id) } catch {} }
    for (const t of list) { try { await window.browserAPI.ai.ptaskDelete(t.id) } catch {} }
    return true
  })()`)
}

async function main() {
  fs.mkdirSync(args.out, { recursive: true })
  if (!fs.existsSync(EXE)) { console.error(`exe 없음: ${EXE} — 패키징 필요`); process.exit(2) }

  // 신선도 대조 — 낡은 패키지를 재면 "고쳤는데 여전히 실패" 로 보인다(이 저장소의 전례).
  const asarMtime = fs.statSync(ASAR).mtimeMs
  const srcFiles = ['app/renderer/components/AiTab.tsx', 'app/main/features/ai/intent.ts', 'app/main/ipc/ai.ts']
  const newest = srcFiles
    .map((p) => ({ p, t: (() => { try { return fs.statSync(path.join(REPO_ROOT, p)).mtimeMs } catch { return 0 } })() }))
    .reduce((a, b) => (b.t > a.t ? b : a), { p: '(없음)', t: 0 })
  console.log(`[신선도] app.asar=${new Date(asarMtime).toISOString()} · 최신 소스=${newest.p} ${new Date(newest.t).toISOString()}`)
  if (asarMtime < newest.t) console.warn('[신선도] ⚠ 패키지가 소스보다 오래됐다 — 재패키징 필요')

  args.port = await preferFreePort(args.port, 'verify-intent-ui-cdp.mjs')
  if (!(await waitForPortFree(args.port))) { console.error(`포트 ${args.port} 점유 중`); process.exit(2) }

  const [llmPort, pagePort] = await getFreePorts(2)
  const llm = await startFakeLlm({ port: llmPort, script: [router] })
  const pages = await startPageServer(pagePort)

  const profileDir = path.join(args.out, 'profile')
  if (!args.keepProfile) fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const downloadsDir = path.join(args.out, 'downloads')
  fs.mkdirSync(downloadsDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true },
    startup: { mode: 'newtab', urls: [] },
    adblock: { enabled: false },
    downloads: { defaultPath: downloadsDir, askEveryTime: false },
    ai: {
      enabled: true, provider: 'ollama', ollamaUrl: llm.url, ollamaModel: 'test-model',
      agentMaxSteps: 2, agentVision: 'off', agentHumanInput: false, agentAutoApprove: false,
    },
  }, null, 2))

  const logStream = fs.createWriteStream(path.join(args.out, 'app.log'))
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)

    // 에이전트는 내부 페이지를 조작 대상에서 제외한다 — http 탭이 있어야 입력창이 활성화된다.
    await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pages.url)}).then(t => t.id)`)
    await sleep(1500)

    if (!(await openAiPanel(shell, windowId))) throw new Error('AI 사이드바가 열리지 않았다')
    await ensureAgentReady(shell)

    // ── IU1: 자연어 → 확인 카드. 그리고 **아직 아무것도 실행되지 않는다** ────────────────
    {
      await cancelAllPtasks(shell)
      const before = await ptaskSnapshot(shell)
      // 검색 주소를 문장에 넣는다 — 안 넣으면 레시피 기본값이 **네이버 실서버**가 되어 외부로 나간다.
      // (원문에 있을 때만 searchUrl 을 채우는 것도 여기서 함께 확인된다.)
      await typeAndSend(shell, `등산 관련 블로그 3개 글에 댓글 달아줘 ${pages.url}search?q=%EB%93%B1%EC%82%B0`)
      let card = null
      try {
        card = await pollExpr(shell, cardExpr, (v) => !!v, { timeoutMs: 10_000, label: '확인 카드 등장' })
      } catch (e) { /* 아래에서 FAIL 로 기록 */ }
      const after = await ptaskSnapshot(shell)
      const noAutoRun = after.length === before.length
      check('IU1', '자연어 지시가 확인 카드를 띄우고, 누르기 전에는 아무 작업도 시작하지 않는다',
        !!card && card.kind === 'blog-engage' && noAutoRun,
        `카드=${card ? card.kind : '없음'} · 카드 전 작업 ${before.length}개 → 후 ${after.length}개(늘면 자동 실행된 것)`)
    }

    // ── IU2: 미리 채워짐 + 계정은 채워지지 않고 실행이 잠긴다 ─────────────────────────
    {
      const c = await evaluate(shell, cardExpr)
      const topicOk = typeof c?.topic === 'string' && c.topic.includes('등산')
      const postsOk = String(c?.maxposts ?? '') === '3'
      const accountEmpty = String(c?.account ?? '') === ''
      const lockedBeforeAccount = c?.runDisabled === true
      await setFieldValue(shell, `${CARD} [data-intent="account"]`, 'tester')
      await sleep(250)
      const c2 = await evaluate(shell, cardExpr)
      const unlockedAfter = c2?.runDisabled === false
      check('IU2', '말에서 읽은 값은 채워지고, 계정은 짐작하지 않아 채우기 전까지 실행이 잠긴다',
        topicOk && postsOk && accountEmpty && lockedBeforeAccount && unlockedAfter,
        `주제="${c?.topic}" · 글 수=${c?.maxposts} · 계정 비어있음=${accountEmpty}`
        + ` · 계정 전 실행잠김=${lockedBeforeAccount} → 계정 후 실행가능=${unlockedAfter}`)
    }

    // ── IU3: 실행 → 레시피(buildBlogEngageTask)를 통과한 영속 작업이 생긴다 ──────────
    {
      const before = await ptaskSnapshot(shell)
      await clickSelector(shell, `${CARD} [data-intent="run"]`)
      let created = null
      try {
        created = await pollExpr(shell, `(async () => {
          const list = await window.browserAPI.ai.ptaskList()
          const t = list.find(x => (x.instruction || '').includes('[참여 가드]'))
          return t ? { id: t.id, instruction: t.instruction } : null
        })()`, (v) => !!v, { timeoutMs: 20_000, label: '레시피 표식이 실린 영속 작업 생성' })
      } catch { /* FAIL 로 기록 */ }

      // 목록(ptaskList)의 instruction 은 카드 표시용으로 잘린다 — 지시문 끝의 '# 안전 지침' 까지
      // 보려면 전체를 가져와야 한다(처음에 목록만 보고 거짓 FAIL 을 냈다).
      const full = await evaluate(shell, `(async () => {
        const t = await window.browserAPI.ai.ptaskGet(${JSON.stringify(created?.id ?? '')})
        return t ? (t.instruction || '') : ''
      })()`).catch(() => '')
      const instr = full || created?.instruction || ''
      // 표식은 buildBlogEngageTask 만 만든다 — 이게 있으면 레시피를 실제로 통과한 것이다.
      const hasMark = /\[참여 가드\]/.test(instr)
      const hasGuardId = /\bid=[A-Za-z0-9-]{8,}/.test(instr)
      const hasLimit = /\blimit=3\b/.test(instr)
      const hasSafety = instr.includes('안전 지침')
      const hasAccount = /account=tester/.test(instr)
      const detail = await evaluate(shell, `(async () => {
        const t = await window.browserAPI.ai.ptaskGet(${JSON.stringify(created?.id ?? '')})
        return t ? { hosts: (t.budget && t.budget.allowedHosts) || [] } : null
      })()`).catch(() => null)
      const hostsOk = Array.isArray(detail?.hosts) && detail.hosts.length > 0
      const cardGone = await evaluate(shell, `!document.querySelector('${CARD}')`)
      check('IU3', '실행을 누르면 레시피가 만든 지시문(참여 가드 표식·한도·안전 지침)으로 영속 작업이 시작된다',
        !!created && hasMark && hasGuardId && hasLimit && hasSafety && hasAccount && hostsOk && cardGone === true,
        `작업 ${before.length}→생성=${!!created} · 표식=${hasMark} · guardId=${hasGuardId} · limit=3=${hasLimit}`
        + ` · 안전지침=${hasSafety} · account=tester=${hasAccount} · allowedHosts ${detail?.hosts?.length ?? 0}개 · 카드 닫힘=${cardGone}`)
      await cancelAllPtasks(shell)
    }

    // ── IU4(부정): 질문은 카드를 띄우지 않고 평범한 에이전트로 간다 ──────────────────
    {
      await cancelAllPtasks(shell)
      const before = await ptaskSnapshot(shell)
      await typeAndSend(shell, '인스타에 그림 올리려면 어떻게 해?')
      await sleep(2500)
      const cardShown = await evaluate(shell, `!!document.querySelector('${CARD}')`)
      const after = await ptaskSnapshot(shell)
      const wentToAgent = after.length > before.length
      const noMark = after.every((t) => !t.instruction.includes('[참여 가드]'))
      check('IU4', '질문에는 카드를 띄우지 않고, 평범한 에이전트 작업으로 그대로 보낸다',
        cardShown === false && wentToAgent && noMark,
        `카드 뜸=${cardShown}(false 여야) · 일반 작업 ${before.length}→${after.length} · 참여 가드 표식 없음=${noMark}`)
      await cancelAllPtasks(shell)
    }

    // ── IU5(권한): 게시까지 골라도 토글을 안 켜면 자동 게시 승인이 생기지 않는다 ──────
    {
      await evaluate(shell, `window.browserAPI.ai.socialGrantRevoke()`).catch(() => {})
      await typeAndSend(shell, 'Genspark에서 밤바다 수채화 그려서 내 인스타에 올려줘')
      let card = null
      try {
        card = await pollExpr(shell, cardExpr, (v) => !!v, { timeoutMs: 10_000, label: '이미지 카드 등장' })
      } catch { /* FAIL 로 기록 */ }
      await setFieldValue(shell, `${CARD} [data-intent="account"]`, 'tester')
      await sleep(200)
      // 생성 사이트를 로컬로 돌린다 — 기본값(Genspark 실서버)으로 두면 작업이 외부로 나간다.
      // 카드가 말에서 읽어 'genspark' 를 골라 둔 상태이므로, 사용자가 바꾸는 그대로 '직접 입력'으로 바꾼다.
      await clickSelector(shell, `${CARD} [data-intent="service"][data-intent-value="custom"]`)
      await sleep(200)
      await setFieldValue(shell, `${CARD} input[placeholder="생성 서비스 URL"]`, pages.url)
      await sleep(200)
      // '게시까지' 를 고른다 — 자동 게시 토글은 **켜지 않는다**.
      await evaluate(shell, `(() => {
        const el = document.querySelector('${CARD} [data-intent="mode"][data-intent-value="publish"]')
        if (el) { el.click(); return true } return false
      })()`)
      await sleep(250)
      const grantBefore = await evaluate(shell, `window.browserAPI.ai.socialGrantGet()`)
      await clickSelector(shell, `${CARD} [data-intent="run"]`)
      await sleep(2500)
      const grantAfter = await evaluate(shell, `window.browserAPI.ai.socialGrantGet()`)
      const wfCount = await evaluate(shell, `window.browserAPI.ai.socialList().then(l => l.length)`)
      check('IU5', '"게시까지" 를 골라도 자동 게시 토글을 켜지 않으면 선승인이 생기지 않는다',
        card?.kind === 'image-post' && !grantBefore && !grantAfter && wfCount >= 1,
        `카드=${card?.kind} · 실행 전 선승인=${grantBefore ? '있음' : '없음'}`
        + ` · 실행 후 선승인=${grantAfter ? '있음(있으면 결함)' : '없음'} · 생성된 워크플로 ${wfCount}개`)
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
    try { child?.kill() } catch { /* ignore */ }
    await pages.close()
    await llm.close()
  }

  fs.writeFileSync(path.join(args.out, 'intent-ui-results.json'), JSON.stringify(results, null, 2))
  console.log('\n===== verify-intent-ui 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL')
  console.log(`PASS=${results.length - fail.length} FAIL=${fail.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
