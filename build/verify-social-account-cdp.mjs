#!/usr/bin/env node
// verify-social-account-cdp.mjs — review 단계에서 "계정을 고치는" 기능이 **실제 앱 + 실제 UI 클릭**
// 으로 동작하는지 확인한다.
//
// 왜 (2026-09-19): 사용자가 이미지 생성→캡션→SNS 게시 워크플로를 만들 때 계정을 빠뜨리거나
// 잘못 넣으면, 지금까지는 review 단계에서 고칠 방법이 없어 워크플로를 처음부터 다시 만들어야
// 했다. `setWorkflowAccount`(main) + `socialSetAccount`(IPC) + `.ai-social-account-input`/
// `.ai-social-account-save`(UI) 로 그 갭을 메운다. 이 하네스는 IPC 를 직접 불러 상태 전이만
// 보는 게 아니라 **사용자가 누르는 경로 그대로**(패널 열기 → 카드 찾기 → 입력 → 저장 클릭)를
// 쓴다 — `build/verify-task-ui-cdp.mjs` 의 선례를 그대로 따른다.
//
// review 단계 워크플로는 **부팅 전에 격리 프로필에 `ai-social-workflows.json` 을 직접 심어**
// 만든다(생성 단계를 실제로 돌리는 것은 이 검사의 관심사가 아니고, 이미지 생성 API 를 부르지
// 않고는 review 단계에 못 이르기 때문). `reviveWorkflow`(social-workflow.ts) 가 stage==='review'
// 인 워크플로에는 taskIds.generate 를 전혀 참조하지 않는다(`reconcileOne` 이 'generate'/'publish'
// 단계만 재조정하고 review/done/failed/cancelled 는 그대로 둔다) — 그래서 taskIds 는 빈 객체로
// 두어도 안전하고, 대응하는 ai-tasks.json 항목을 함께 심을 필요가 없다.
//
// 모델은 절대 부르지 않는다 — 이 워크플로들은 caption·artifactId 를 이미 가진 상태로 심으므로
// draftCaptionInto 가 불릴 일이 없다(proceedToReview 를 거치지 않고 파일에서 바로 복원되기 때문).
// 그래도 방어적으로 fake-llm 서버는 띄워 둔다(무슨 경로로든 모델을 부르면 조용히 실패하는 대신
// 응답이라도 오게).
//
// 앱 바이너리는 다른 하네스와 동일하게 dist/win-unpacked/ezBrowser.exe 를 쓴다.
//
// 사용: node build/verify-social-account-cdp.mjs [--port <n>] [--out <dir>] [--only <id1,id2>] [--keep-profile]

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

const args = { port: 9286, out: path.join(REPO_ROOT, 'verify-out', 'social-account'), only: null, keepProfile: false }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--only') args.only = String(process.argv[++i])
  else if (process.argv[i] === '--keep-profile') args.keepProfile = true
}

const results = []
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${name}: ${detail}`)
  return ok
}
function fail(id, name, detail) {
  results.push({ id, name, status: 'FAIL', detail })
  console.log(`  ✗ ${id} FAIL — ${name}: ${detail}`)
}
function skip(id, name, reason) {
  results.push({ id, name, status: 'SKIP', detail: reason })
  console.log(`  ⋯ ${id} SKIP — ${name}: ${reason}`)
}

/**
 * `--only` 는 쉼표로 여러 개를 받는다(`--only SA1,SA3-UI`) — 한 번의 실행에 여러 시나리오를
 * 골라 담아 결과 파일이 마지막 실행 하나로 덮어써지는 사고(2026-09-19 verify-recovery-cdp.mjs 의
 * 선례)를 피한다.
 */
function wants(id) {
  if (!args.only) return true
  return args.only.split(',').map((s) => s.trim()).filter(Boolean).includes(id)
}

// ── 로컬 fixture 페이지 서버(의존성 0) ──────────────────────────────────
// 이 검사는 어떤 시나리오도 콘텐츠 페이지 DOM 을 건드리지 않는다(전부 워크플로 카드 편집) —
// 그래도 활성 탭이 browser://newtab(내부 페이지) 하나뿐이면 AiTab 의 activeId/isInternal 계산이
// 달라질 여지가 있어, 일반 http 탭을 하나 만들어 활성화해 둔다(다른 하네스와 동일 관례).
function startPageServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end('<!doctype html><meta charset="utf-8"><title>계정 편집 검증</title>'
        + '<body style="font:16px system-ui;padding:24px"><h1>계정 편집 검증용 페이지</h1></body>')
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      resolve({
        port: actual,
        url: `http://127.0.0.1:${actual}/`,
        async close() {
          await new Promise((r) => {
            // 앱의 keep-alive 연결 때문에 close() 가 끝나지 않는 정지를 이 저장소에서 겪었다.
            try { server.closeAllConnections?.() } catch { /* ignore */ }
            const t = setTimeout(r, 3000)
            server.close(() => { clearTimeout(t); r() })
          })
        },
      })
    })
  })
}

// ── CDP 헬퍼 ──────────────────────────────────────────────────────────────
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
  throw new Error(`timeout(${timeoutMs}ms) waiting for ${label} — 마지막 값: ${JSON.stringify(last)}`)
}

async function clickByBtnTextIncludes(session, selector, needle) {
  return evaluate(session, `(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
    const el = els.find(x => (x.textContent || '').includes(${JSON.stringify(needle)}))
    if (!el) return false
    el.click(); return true
  })()`)
}

/** 마커(예: 'SA-ACC-1')가 포함된 `.ai-social-card` 하나를 찾아 계정 편집 UI 상태를 읽는다. */
function socialCardExpr(marker) {
  return `(() => {
    const cards = [...document.querySelectorAll('.ai-social-card')]
    const c = cards.find(x => (x.querySelector('.ai-task-instruction')?.getAttribute('title') || '').includes(${JSON.stringify(marker)}))
    if (!c) return null
    const input = c.querySelector('input.ai-social-account-input')
    const saveBtn = c.querySelector('button.ai-social-account-save')
    const statusEl = c.querySelector('.ai-social-receipt-status')
    return {
      found: true,
      hasInput: !!input,
      inputDisabled: input ? !!input.disabled : null,
      inputValue: input ? input.value : null,
      hasSaveBtn: !!saveBtn,
      saveDisabled: saveBtn ? !!saveBtn.disabled : null,
      hasStatusEl: !!statusEl,
      statusValue: statusEl ? statusEl.getAttribute('data-status') : null,
    }
  })()`
}
async function readSocialCard(session, marker) {
  return evaluate(session, socialCardExpr(marker))
}

/**
 * 마커가 포함된 `.ai-social-card` 의 **영수증 판정 결과**를 읽는다(SA7/SA8 전용).
 * 반드시 실제 렌더된 DOM 에서 읽는다 — 저장소 값만 보면 화면이 틀려도 통과하는 빈 검사가 된다.
 */
function socialCardReceiptExpr(marker) {
  return `(() => {
    const cards = [...document.querySelectorAll('.ai-social-card')]
    const c = cards.find(x => (x.querySelector('.ai-task-instruction')?.getAttribute('title') || '').includes(${JSON.stringify(marker)}))
    if (!c) return null
    const statusEl = c.querySelector('.ai-social-receipt-status')
    return {
      found: true,
      hasWarnClass: c.classList.contains('warn'),
      hasOkClass: c.classList.contains('ok'),
      hasStatusEl: !!statusEl,
      dataStatus: statusEl ? statusEl.getAttribute('data-status') : null,
      statusText: statusEl ? statusEl.textContent.trim() : null,
    }
  })()`
}
async function readSocialCardReceipt(session, marker) {
  return evaluate(session, socialCardReceiptExpr(marker))
}

/** DOM 으로 — 네이티브 setter + input/change 이벤트로 값을 넣고 저장 버튼을 실제로 클릭한다. */
async function setAccountViaUi(session, marker, value) {
  return evaluate(session, `(() => {
    const cards = [...document.querySelectorAll('.ai-social-card')]
    const c = cards.find(x => (x.querySelector('.ai-task-instruction')?.getAttribute('title') || '').includes(${JSON.stringify(marker)}))
    if (!c) return { ok: false, reason: 'no-card' }
    const input = c.querySelector('input.ai-social-account-input')
    if (!input) return { ok: false, reason: 'no-input' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    const btn = c.querySelector('button.ai-social-account-save')
    if (!btn) return { ok: false, reason: 'no-save-btn' }
    if (btn.disabled) return { ok: false, reason: 'save-btn-disabled' }
    btn.click()
    return { ok: true }
  })()`)
}

/** 마커가 포함된 프롬프트를 가진 워크플로를 socialList() 로 조회 — 조작이 아니라 검증에만 쓴다. */
async function getWfByMarker(session, marker) {
  return evaluate(session, `(async () => {
    const list = await window.browserAPI.ai.socialList()
    const w = list.find(x => (x.params && x.params.prompt || '').includes(${JSON.stringify(marker)}))
    return w || null
  })()`)
}
async function waitAccountEquals(session, marker, expected, opts) {
  return pollExpr(session, `(async () => {
    const list = await window.browserAPI.ai.socialList()
    const w = list.find(x => (x.params && x.params.prompt || '').includes(${JSON.stringify(marker)}))
    return w ? JSON.stringify(w.params.account ?? '') : null
  })()`, (v) => v === JSON.stringify(expected), opts)
}

/** socialSetAccount 를 **직접** 호출한다(SA3 의 거부 확인·SA5 의 반환값 확인처럼 반환 형태 자체가
 * 단언 대상일 때만 쓴다 — 조작이 UI 로 되는지 확인해야 하는 SA1/SA2/SA4 는 DOM 클릭을 쓴다). */
async function callSetAccount(session, id, account) {
  return evaluate(session, `window.browserAPI.ai.socialSetAccount(${JSON.stringify(id)}, ${JSON.stringify(account)})`)
}

async function openAiPanel(session, windowId) {
  await evaluate(session, `window.browserAPI.actions.run('action.ai.open', { windowId: ${JSON.stringify(windowId)} })`)
  const deadline = Date.now() + 20_000
  let reopened = false
  while (Date.now() < deadline) {
    const found = await evaluate(session, `!!document.querySelector('.ai-tab')`)
    if (found) return true
    // 사이드바 마운트가 레이스로 늦을 수 있다(verify-task-ui-cdp.mjs 선례) — 절반 지점에 한 번 더 연다.
    if (!reopened && Date.now() > deadline - 12_000) {
      await evaluate(session, `window.browserAPI.actions.run('action.ai.open', { windowId: ${JSON.stringify(windowId)} })`)
      reopened = true
    }
    await sleep(500)
  }
  return false
}

async function openSocialPanel(session) {
  const already = await evaluate(session, `!!document.querySelector('.ai-social-subtabs')`)
  if (already) return true
  const clicked = await clickByBtnTextIncludes(session, '.ai-meta-actions .ai-mini-btn', '🎨 만들기')
  if (!clicked) return false
  const opened = await pollExpr(session, `!!document.querySelector('.ai-social-subtabs')`, (v) => v === true,
    { timeoutMs: 8_000, label: '"🎨 만들기" 패널 열림' }).then(() => true).catch(() => false)
  return opened
}

// ── 프로필에 심을 review 단계 워크플로 5종 ─────────────────────────────────
// 전부 stage:'review' — reconcileOne 이 review/done/failed/cancelled 단계는 그대로 두므로
// taskIds.generate 를 참조하지 않는다(대응하는 ai-tasks.json 항목을 함께 심을 필요가 없다).
function seedWorkflows(now) {
  const base = (id, marker, over) => ({
    id,
    params: {
      service: 'genspark', platform: 'instagram',
      prompt: `[${marker}] 계정 편집 검증용 워크플로`,
      mode: 'draft', tabId: `seed-tab-${id}`, windowId: null,
      ...(over.account !== undefined ? { account: over.account } : {}),
      ...(over.platform ? { platform: over.platform } : {}),
    },
    stage: 'review',
    taskIds: {},
    artifactId: `art-${id}`,
    artifactPreview: { width: 800, height: 600, bytes: 123456, format: 'png', sha256: `${id}-sha256-fixed-value-000000000000000000000000000000` },
    caption: `${id} 원본 캡션 — 절대 바뀌면 안 됨`,
    ...(over.publishUncertain ? { publishUncertain: true } : {}),
    ...(over.receipt ? { receipt: over.receipt } : {}),
    createdAt: now, updatedAt: now,
  })
  return [
    // SA1 — 계정이 비어 있음(account 키 자체를 생략)
    base('sa1', 'SA-ACC-1', {}),
    // SA2 — 계정이 잘못 들어 있음
    base('sa2', 'SA-ACC-2', { account: 'wrong_account' }),
    // SA3 — 게시 여부가 불확실한 상태(publishUncertain) → 편집 자체가 막혀야 한다
    base('sa3', 'SA-ACC-3', { account: 'locked_account', publishUncertain: true }),
    // SA4 — 지난 게시 영수증이 남아 있음(계정을 바꾸면 이 근거는 더 이상 유효하지 않다)
    base('sa4', 'SA-ACC-4', {
      account: 'stale_account',
      receipt: { evidence: '과거 게시 확인됨(오래된 계정 기준)', at: now - 6 * 3600_000 },
    }),
    // SA5 — 자동 게시 선승인 범위 검증용(계정 A 로 시작, 이후 B 로 바꿀 것)
    base('sa5', 'SA-ACC-5', { account: 'account_a', platform: 'instagram' }),
  ]
}

/**
 * SA7/SA8 — 영수증 판정(receipt.status)이 evidence **문장**에 흔들리지 않는지 검증한다.
 * 전부 stage:'done' — 계정 편집 대상(review 단계)이 아니라 게시가 이미 끝난 뒤의 화면 표시를 본다.
 * reconcileOne 은 'done' 단계도 그대로 두므로(taskIds 참조 없음) taskIds:{} 로 안전하다.
 */
function seedReceiptWorkflows(now) {
  const baseDone = (id, marker, receipt) => ({
    id,
    params: {
      service: 'genspark', platform: 'instagram',
      prompt: `[${marker}] 영수증 판정 검증용 워크플로`,
      mode: 'publish', tabId: `seed-tab-${id}`, windowId: null,
      account: 'receipt_test_account',
    },
    stage: 'done',
    taskIds: {},
    artifactId: `art-${id}`,
    artifactPreview: { width: 800, height: 600, bytes: 123456, format: 'png', sha256: `${id}-sha256-fixed-value-000000000000000000000000000000` },
    caption: `${id} 캡션`,
    receipt,
    createdAt: now, updatedAt: now,
  })
  return [
    // SA7 — status:'verified' 인데 evidence 문장 안에 "미확인" 낱말이 그대로 들어 있다(실제 글에서
    // 읽어 온 발췌라는 뜻). 예전(문장 정규식) 판정이었다면 여기서 ⚠ 로 뒤집혔을 자리 — status 값이
    // 우선해야 하므로 ✅ 로 남아야 한다.
    baseDone('sa7', 'SA-ACC-7', {
      status: 'verified',
      evidence: '읽기 전용 확인 — 이 캡션을 직접 확인했습니다: "미확인 구역 탐사 후기" (https://example.com/p/1)',
      at: now,
    }),
    // SA8① — status:'unverified' 인데 evidence 낱말에는 "미확인" 계열이 전혀 없다. 문장만 봤다면
    // ✅ 로 새어 나갔을 자리 — status 값이 있으면 문장을 보지 않고 그 값을 그대로 따라야 한다.
    baseDone('sa8a', 'SA-ACC-8A', { status: 'unverified', evidence: '완료 신호를 보지 못했습니다.', at: now }),
    // SA8② — status 필드가 아예 없는 **옛 영수증**(하위호환) + evidence 에 "미확인" 포함 → 문장
    // 기반 판단으로 물러서서 여전히 ⚠ 로 보여야 한다(하위호환 경로가 깨지지 않았는지 확인).
    baseDone('sa8b', 'SA-ACC-8B', { evidence: '게시 여부를 미확인 상태로 종료했습니다.', at: now }),
  ]
}

async function main() {
  fs.mkdirSync(args.out, { recursive: true })
  if (!fs.existsSync(EXE)) { console.error(`exe 없음: ${EXE} — 팀장이 패키징해야 한다`); process.exit(2) }

  // ── 신선도 대조 — 이 기능은 팀장이 지금 구현 중이므로, 낡은 빌드를 검사하고 있을 가능성을
  // 매 실행마다 드러낸다(관련 파일이 asar 보다 새로우면 재패키징이 필요하다는 뜻). ──────────
  const asarMtime = fs.statSync(ASAR).mtimeMs
  const srcFiles = [
    'app/main/features/ai/social-workflow.ts', 'app/main/ipc/ai.ts',
    'app/preload/chrome.ts', 'app/renderer/components/AiSocialPanel.tsx', 'app/shared/ipc-channels.ts',
  ]
  const newestSrc = srcFiles
    .map((p) => ({ p, t: (() => { try { return fs.statSync(path.join(REPO_ROOT, p)).mtimeMs } catch { return 0 } })() }))
    .reduce((a, b) => (b.t > a.t ? b : a), { p: '(없음)', t: 0 })
  console.log(`[신선도] app.asar=${new Date(asarMtime).toISOString()} · 최신 소스=${newestSrc.p} ${new Date(newestSrc.t).toISOString()}`)
  if (asarMtime < newestSrc.t) {
    console.warn('[신선도] ⚠ 패키지가 소스보다 오래됐다 — 낡은 바이너리를 검사하고 있을 수 있다(재패키징 필요)')
  }

  args.port = await preferFreePort(args.port, 'verify-social-account-cdp.mjs')
  if (!(await waitForPortFree(args.port))) { console.error(`포트 ${args.port} 점유 중`); process.exit(2) }
  const [llmPort, pagePort] = await getFreePorts(2)

  const llm = await startFakeLlm({ port: llmPort })
  const pageSrv = await startPageServer(pagePort)

  const profileDir = path.join(args.out, 'profile')
  if (!args.keepProfile) fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true, completedAt: Date.now(), version: 'verify-social-account' },
    // 강제 종료가 아니라 정상 종료 + 재시작을 쓰지만, 세션 복원 모달이 창 생성을 막지 않도록
    // last-session 을 그대로 유지한다(session-restore·ai-persist 하네스와 동일 관례).
    startup: { mode: 'last-session', urls: [] },
    adblock: { enabled: false },
    ai: {
      enabled: true,
      provider: 'ollama',
      ollamaUrl: llm.url,
      ollamaModel: 'test-model',
      agentMaxSteps: 4,
      agentVision: 'off',
      agentHumanInput: false,
      agentAutoApprove: false,
    },
  }, null, 2))

  // review 단계 워크플로 5종 + 영수증 판정용 done 단계 워크플로 3종을 부팅 전에 직접 심는다
  // (json-store 의 스냅샷 형태와 동일하게).
  const workflowsFile = path.join(profileDir, 'ai-social-workflows.json')
  const seedNow = Date.now()
  fs.writeFileSync(workflowsFile, JSON.stringify({
    version: 1,
    workflows: [...seedWorkflows(seedNow), ...seedReceiptWorkflows(seedNow)],
    grant: null,
  }, null, 2))

  let child = null
  let shell = null

  /** 앱을 띄우고 외피 세션을 잡는다(같은 프로필 디렉터리를 재사용 — SA6 재시작 보존 시나리오). */
  async function boot(label) {
    child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`], {
      env: { ...process.env }, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.pipe(fs.createWriteStream(path.join(args.out, `app-${label}-stdout.log`)))
    child.stderr?.pipe(fs.createWriteStream(path.join(args.out, `app-${label}-stderr.log`)))
    shell = await connectShellSessionReady(args.port, { log: (m) => console.log(`[social-account] ${m}`) })
    await sleep(1200)
    return shell
  }

  /**
   * 정상 종료(Browser.close → before-quit → 동기 flush). SA6 은 **강제 kill 이 아니라 정상 종료**를
   * 써야 한다 — 그래야 계정 변경이 디바운스 저장(json-store 400ms)을 기다리지 않고도 before-quit
   * 의 동기 flush 로 확실히 착지한다(and 강제 kill 로 인한 세션 복원 모달이 SA6 재부팅을 막지 않는다).
   */
  async function gracefulQuit() {
    const exited = new Promise((r) => { child.once('exit', r) })
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {})
      b.close()
    } catch { /* ignore */ }
    await Promise.race([exited, sleep(15000)])
    try { shell?.close() } catch { /* ignore */ }
    try { child?.kill() } catch { /* ignore */ }
    await waitForPortFree(args.port).catch(() => {})
    await sleep(1000)
  }

  try {
    // ═══════════════════════════════════ 1차 부팅 ═══════════════════════════
    await boot('first')
    const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)

    const opened = await openAiPanel(shell, windowId)
    check('SETUP-1', 'AI 패널이 실제로 열림', opened, opened ? '.ai-tab 마운트 확인' : '.ai-tab 을 찾지 못함(막다른 상태)')
    if (!opened) throw new Error('AI 패널을 열지 못해 이후 시나리오를 진행할 수 없음')

    // 활성 탭을 내부 페이지(browser://newtab) 대신 일반 http 탭으로 — 다른 하네스와 동일 관례.
    const created = await evaluate(shell, `(async () => {
      const t = await window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pageSrv.url)}, { background: false })
      return t ? t.id : null
    })()`)
    check('SETUP-2', '조작 대상 http 탭 생성', !!created, created ? `tabId=${created}` : '탭 생성 실패')
    await sleep(500)

    const socialOpened = await openSocialPanel(shell)
    check('SETUP-3', '"🎨 만들기" 클릭으로 소셜 패널이 열림', socialOpened,
      socialOpened ? '.ai-social-subtabs 확인' : '패널을 열지 못함(providerReady=false 였을 수 있음)')
    if (!socialOpened) throw new Error('소셜 패널을 열지 못해 이후 시나리오를 진행할 수 없음')

    // 심은 워크플로 8개가 카드로 실제 렌더됐는지 먼저 확인 — 여기서 실패하면 이후 전부가
    // "카드 없음" 으로 연쇄 실패하므로 원인을 이 지점에서 분리해 보여준다.
    for (const marker of [
      'SA-ACC-1', 'SA-ACC-2', 'SA-ACC-3', 'SA-ACC-4', 'SA-ACC-5',
      'SA-ACC-7', 'SA-ACC-8A', 'SA-ACC-8B',
    ]) {
      const card = await pollExpr(shell, socialCardExpr(marker), (v) => v && v.found === true,
        { timeoutMs: 10_000, label: `카드[${marker}] 렌더` }).catch(() => null)
      check(`SETUP-CARD-${marker}`, `심은 워크플로 카드가 화면에 보임(${marker})`, !!card,
        card ? JSON.stringify(card) : '카드를 찾지 못함')
    }

    // ═══════════════════════════════════ SA1 (양성, DOM 경유) ═══════════════
    if (wants('SA1')) {
      try {
        const before = await getWfByMarker(shell, 'SA-ACC-1')
        const res = await setAccountViaUi(shell, 'SA-ACC-1', 'new_account_sa1')
        const after = await waitAccountEquals(shell, 'SA-ACC-1', 'new_account_sa1', { timeoutMs: 10_000, label: 'SA1 계정 반영' })
          .then(() => getWfByMarker(shell, 'SA-ACC-1')).catch((e) => ({ __timeout: e.message }))
        check('SA1', '빈 계정을 UI 입력+저장 클릭으로 실제로 채운다',
          res?.ok === true && after?.params?.account === 'new_account_sa1',
          `클릭결과=${JSON.stringify(res)} 이전계정=${JSON.stringify(before?.params?.account)} 이후계정=${JSON.stringify(after?.params?.account)}`)

        check('SA1-PRESERVE', '계정만 바뀌고 artifactId·sha256·caption 은 그대로 보존됨',
          !!after && after.artifactId === before?.artifactId
            && after.artifactPreview?.sha256 === before?.artifactPreview?.sha256
            && after.caption === before?.caption,
          `artifactId ${before?.artifactId}→${after?.artifactId} · `
          + `sha256 ${before?.artifactPreview?.sha256}→${after?.artifactPreview?.sha256} · `
          + `caption "${before?.caption}"→"${after?.caption}"`)
      } catch (e) { fail('SA1', '빈 계정 채우기', e.message) }
    } else { skip('SA1', '빈 계정 채우기', '--only 로 제외됨'); skip('SA1-PRESERVE', '보존 확인', '--only 로 제외됨') }

    // ═══════════════════════════════════ SA2 (양성, 잘못된 계정 교정) ═══════
    if (wants('SA2')) {
      try {
        const before = await getWfByMarker(shell, 'SA-ACC-2')
        const res = await setAccountViaUi(shell, 'SA-ACC-2', 'right_account')
        const after = await waitAccountEquals(shell, 'SA-ACC-2', 'right_account', { timeoutMs: 10_000, label: 'SA2 계정 반영' })
          .then(() => getWfByMarker(shell, 'SA-ACC-2')).catch((e) => ({ __timeout: e.message }))
        check('SA2', '잘못된 계정(wrong_account)을 UI 로 right_account 로 교정한다',
          res?.ok === true && after?.params?.account === 'right_account',
          `클릭결과=${JSON.stringify(res)} 이전계정=${JSON.stringify(before?.params?.account)} 이후계정=${JSON.stringify(after?.params?.account)}`)
      } catch (e) { fail('SA2', '잘못된 계정 교정', e.message) }
    } else { skip('SA2', '잘못된 계정 교정', '--only 로 제외됨') }

    // ═══════════════════════════════════ SA3 (부정, 안전하지 않은 편집 거부) ═
    // ⚠ 최초 설계는 "입력이 없거나 영구히 disabled" 를 기대했으나, 실제 UI 는 저장 버튼을
    // **dirty 체크로만** 막는다(값을 안 바꾸면 어차피 disabled — publishUncertain 과 무관하게
    // 모든 카드가 쉬는 상태에서 그렇다). 그 상태를 그대로 재던 첫 버전은 "항상 참" 인 빈 검사였다
    // (SA1/SA2 도 편집 전에는 saveDisabled:true 였다 — 실측으로 확인). 그래서 실제로 값을 바꾸고
    // 저장 버튼을 **눌러서**(dirty→활성화) 백엔드가 거부하는지, 그 거부가 화면에 실제로 보이는지
    // (`.ai-handoff-note.ai-err`), 계정이 실제로는 안 바뀌는지를 검사한다 — SA1/SA2/SA4 와 같은
    // 경로(DOM 클릭)를 쓰되 결과가 거부라는 점만 다르다.
    if (wants('SA3-UI')) {
      try {
        const before = await getWfByMarker(shell, 'SA-ACC-3')
        const res = await setAccountViaUi(shell, 'SA-ACC-3', 'sneaky_via_ui')
        const noteText = await pollExpr(shell, `(() => {
          const cards = [...document.querySelectorAll('.ai-social-card')]
          const c = cards.find(x => (x.querySelector('.ai-task-instruction')?.getAttribute('title') || '').includes('SA-ACC-3'))
          const n = c ? c.querySelector('.ai-handoff-note.ai-err') : null
          return n ? n.textContent.trim() : null
        })()`, (v) => typeof v === 'string' && v.length > 0,
        { timeoutMs: 8_000, label: 'SA3 오류 안내(.ai-handoff-note.ai-err)' }).catch((e) => `(타임아웃: ${e.message})`)
        const after = await getWfByMarker(shell, 'SA-ACC-3')
        check('SA3-UI', 'UI 로 편집을 시도해도(입력+저장 클릭) 백엔드가 거부하고 화면에 오류가 뜨며 계정은 바뀌지 않는다',
          res?.ok === true && typeof noteText === 'string' && noteText.length > 0 && !noteText.startsWith('(타임아웃')
            && after?.params?.account === 'locked_account',
          `클릭결과=${JSON.stringify(res)} 이전계정=${JSON.stringify(before?.params?.account)} `
          + `화면오류안내="${noteText}" 변경후계정=${JSON.stringify(after?.params?.account)}(locked_account 이어야)`)
      } catch (e) { fail('SA3-UI', 'UI 편집 시도 → 거부 노출 확인', e.message) }
    } else { skip('SA3-UI', 'UI 편집 시도 → 거부 노출 확인', '--only 로 제외됨') }

    if (wants('SA3-REJECT')) {
      try {
        const wf = await getWfByMarker(shell, 'SA-ACC-3')
        if (!wf) throw new Error('SA-ACC-3 워크플로를 찾지 못함')
        const res = await callSetAccount(shell, wf.id, 'sneaky_account')
        const after = await getWfByMarker(shell, 'SA-ACC-3')
        check('SA3-REJECT', 'socialSetAccount 직접 호출도 거부되고(ok:false+이유) 계정이 바뀌지 않는다',
          res?.ok === false && typeof res?.error === 'string' && res.error.length > 0
            && after?.params?.account === 'locked_account',
          `직접호출결과=${JSON.stringify(res)} 변경후계정=${JSON.stringify(after?.params?.account)}(locked_account 이어야)`)
      } catch (e) { fail('SA3-REJECT', '직접 IPC 호출 거부 확인', e.message) }
    } else { skip('SA3-REJECT', '직접 IPC 호출 거부 확인', '--only 로 제외됨') }

    // ═══════════════════════════════════ SA4 (부정, 지난 근거 재사용 금지) ═══
    if (wants('SA4')) {
      try {
        const before = await getWfByMarker(shell, 'SA-ACC-4')
        const cardBefore = await readSocialCard(shell, 'SA-ACC-4')
        if (cardBefore?.hasStatusEl) {
          console.log(`  [정보] SA-ACC-4 변경 전 .ai-social-receipt-status data-status="${cardBefore.statusValue}"`)
        }
        const res = await setAccountViaUi(shell, 'SA-ACC-4', 'fresh_account_sa4')
        const after = await waitAccountEquals(shell, 'SA-ACC-4', 'fresh_account_sa4', { timeoutMs: 10_000, label: 'SA4 계정 반영' })
          .then(() => getWfByMarker(shell, 'SA-ACC-4')).catch((e) => ({ __timeout: e.message }))
        check('SA4', '낡은 영수증이 있어도 UI 로 계정 교정 자체는 된다',
          res?.ok === true && after?.params?.account === 'fresh_account_sa4',
          `클릭결과=${JSON.stringify(res)} 이전계정=${JSON.stringify(before?.params?.account)} 이후계정=${JSON.stringify(after?.params?.account)}`)

        check('SA4-RECEIPT', '계정 변경 후 낡은 receipt(지난 게시 근거)가 더 이상 남아있지 않다',
          !!before?.receipt && !after?.receipt,
          `변경전 receipt=${JSON.stringify(before?.receipt)} · 변경후 receipt=${JSON.stringify(after?.receipt)}(없어야 함)`)

        // 상태 표시 요소의 값 "의미"(어떤 문자열이 '지워졌다'를 뜻하는지)는 이 하네스가 추측하지
        // 않는다 — 존재하면 4개 허용 값 중 하나인지(구조적 정합성)만 확인한다(빈 검사 방지).
        const cardAfter = await readSocialCard(shell, 'SA-ACC-4')
        if (cardAfter?.hasStatusEl) {
          check('SA4-STATUS-ENUM', '.ai-social-receipt-status 의 data-status 가 정의된 값 중 하나',
            ['verified', 'user-confirmed', 'draft', 'unverified'].includes(cardAfter.statusValue),
            `data-status="${cardAfter.statusValue}"`)
        } else {
          console.log('  [정보] SA-ACC-4 카드에 .ai-social-receipt-status 요소 없음(선택적 UI 로 판단, 결과에 영향 없음)')
        }
      } catch (e) { fail('SA4', '낡은 영수증 재사용 금지', e.message) }
    } else {
      skip('SA4', '낡은 영수증 상태에서 계정 교정', '--only 로 제외됨')
      skip('SA4-RECEIPT', '계정 변경 후 receipt 소거', '--only 로 제외됨')
    }

    // ═══════════════════════════════════ SA5 (부정, 지난 선승인 재사용 금지) ═
    if (wants('SA5-SCOPE')) {
      try {
        const grant = await evaluate(shell, `window.browserAPI.ai.socialGrant(${JSON.stringify({
          platform: 'instagram', accounts: ['account_a'], maxPosts: 5, minutes: 30,
        })})`)
        check('SA5-SETUP', '계정 A(account_a) 에만 자동 게시 선승인이 만들어짐',
          !!grant && Array.isArray(grant.accounts) && grant.accounts.length === 1 && grant.accounts[0] === 'account_a',
          `grant=${JSON.stringify(grant)}`)

        const wf = await getWfByMarker(shell, 'SA-ACC-5')
        if (!wf) throw new Error('SA-ACC-5 워크플로를 찾지 못함')
        const res = await callSetAccount(shell, wf.id, 'account_b')
        check('SA5-SCOPE', '선승인 범위 밖 계정(account_b)으로 바꾸면 autoPublish 가 not-covered 로 응답한다',
          res?.ok === true && res?.autoPublish === 'not-covered',
          `직접호출결과=${JSON.stringify(res)}`)

        const grantAfter = await evaluate(shell, `window.browserAPI.ai.socialGrantGet()`)
        check('SA5-GRANT-UNCHANGED', '계정을 B 로 바꿔도 선승인의 accounts 가 조용히 넓어지지 않는다(여전히 A 뿐)',
          !!grantAfter && Array.isArray(grantAfter.accounts)
            && grantAfter.accounts.length === 1 && grantAfter.accounts[0] === 'account_a',
          `변경후 grant.accounts=${JSON.stringify(grantAfter?.accounts)}(["account_a"] 이어야)`)
      } catch (e) {
        fail('SA5-SCOPE', '선승인 범위 밖 계정 전환', e.message)
        fail('SA5-GRANT-UNCHANGED', '선승인 accounts 불변', e.message)
      }
    } else {
      skip('SA5-SETUP', '자동 게시 선승인 생성', '--only 로 제외됨')
      skip('SA5-SCOPE', '선승인 범위 밖 계정 전환', '--only 로 제외됨')
      skip('SA5-GRANT-UNCHANGED', '선승인 accounts 불변', '--only 로 제외됨')
    }

    // ═══════════════════ SA7 (오염된 발췌가 판정을 뒤집지 못한다) ═══════════
    if (wants('SA7')) {
      try {
        const r = await readSocialCardReceipt(shell, 'SA-ACC-7')
        check('SA7', 'status:verified 면 evidence 문장 속 "미확인" 낱말에도 ✅(warn 아님)로 남는다',
          !!r && r.hasStatusEl && r.dataStatus === 'verified' && r.hasWarnClass === false
            && typeof r.statusText === 'string' && !r.statusText.startsWith('⚠') && r.statusText.startsWith('✅'),
          `카드=${JSON.stringify(r)}`)
      } catch (e) { fail('SA7', '오염된 발췌가 판정을 뒤집지 못함', e.message) }
    } else { skip('SA7', '오염된 발췌가 판정을 뒤집지 못함', '--only 로 제외됨') }

    // ═══════════════════ SA8 (반대 방향도 막힌다 + 옛 영수증 하위호환) ═════
    if (wants('SA8-UNVERIFIED-EXPLICIT')) {
      try {
        const r = await readSocialCardReceipt(shell, 'SA-ACC-8A')
        check('SA8-UNVERIFIED-EXPLICIT', 'status:unverified 면 evidence 에 "미확인" 낱말이 없어도 ⚠(warn) 로 보인다',
          !!r && r.hasStatusEl && r.dataStatus === 'unverified' && r.hasWarnClass === true
            && typeof r.statusText === 'string' && r.statusText.startsWith('⚠'),
          `카드=${JSON.stringify(r)}(문장만 봤다면 "미확인" 이 없어 ✅ 로 샜을 자리)`)
      } catch (e) { fail('SA8-UNVERIFIED-EXPLICIT', 'status 우선 — 문장에 없어도 경고', e.message) }
    } else { skip('SA8-UNVERIFIED-EXPLICIT', 'status 우선 — 문장에 없어도 경고', '--only 로 제외됨') }

    if (wants('SA8-LEGACY-COMPAT')) {
      try {
        const r = await readSocialCardReceipt(shell, 'SA-ACC-8B')
        // status 필드가 없는 옛 영수증만 문장 판단으로 물러선다 — 여기서 실제로 계산되는 값은
        // 'legacy-unverified'(코드 확인) 다. 정확한 문자열까지 확인하되, 핵심은 "여전히 경고로
        // 보이는가"(warn 클래스 + ⚠ 접두) 이므로 그 둘을 주된 판정으로 삼는다.
        check('SA8-LEGACY-COMPAT', 'status 없는 옛 영수증은 evidence 문장(미확인 포함)으로 물러서 여전히 ⚠(warn) 로 보인다',
          !!r && r.hasStatusEl && r.dataStatus === 'legacy-unverified' && r.hasWarnClass === true
            && typeof r.statusText === 'string' && r.statusText.startsWith('⚠'),
          `카드=${JSON.stringify(r)}`)
      } catch (e) { fail('SA8-LEGACY-COMPAT', '옛 영수증 하위호환', e.message) }
    } else { skip('SA8-LEGACY-COMPAT', '옛 영수증 하위호환', '--only 로 제외됨') }

    // ═══════════════════════════════════ SA6 (재시작 보존) ═══════════════════
    if (wants('SA6')) {
      try {
        await gracefulQuit()
        await boot('second')
        const windowId2 = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)
        const opened2 = await openAiPanel(shell, windowId2)
        if (!opened2) throw new Error('재시작 후 AI 패널을 열지 못함')
        const socialOpened2 = await openSocialPanel(shell)
        if (!socialOpened2) throw new Error('재시작 후 소셜 패널을 열지 못함')

        const sa1After = await getWfByMarker(shell, 'SA-ACC-1')
        const sa2After = await getWfByMarker(shell, 'SA-ACC-2')
        check('SA6-SA1', 'SA1 에서 바꾼 계정(new_account_sa1)이 정상 종료 후 재기동에도 남아 있다',
          sa1After?.params?.account === 'new_account_sa1', `재시작 후 계정=${JSON.stringify(sa1After?.params?.account)}`)
        check('SA6-SA2', 'SA2 에서 바꾼 계정(right_account)이 정상 종료 후 재기동에도 남아 있다',
          sa2After?.params?.account === 'right_account', `재시작 후 계정=${JSON.stringify(sa2After?.params?.account)}`)
      } catch (e) {
        fail('SA6-SA1', '재시작 보존(SA1)', e.message)
        fail('SA6-SA2', '재시작 보존(SA2)', e.message)
      }
    } else {
      skip('SA6-SA1', '재시작 보존(SA1)', '--only 로 제외됨')
      skip('SA6-SA2', '재시작 보존(SA2)', '--only 로 제외됨')
    }
  } finally {
    try { shell?.close() } catch { /* ignore */ }
    try { child?.kill() } catch { /* ignore */ }
    await sleep(500)
    try { await llm.close() } catch { /* ignore */ }
    try { await pageSrv.close() } catch { /* ignore */ }
  }

  const pass = results.filter((r) => r.status === 'PASS').length
  const fails = results.filter((r) => r.status === 'FAIL').length
  const skips = results.filter((r) => r.status === 'SKIP').length
  fs.writeFileSync(path.join(args.out, 'results.json'),
    JSON.stringify({ at: new Date().toISOString(), pass, fail: fails, skip: skips, results }, null, 2))
  console.log(`\nreview 단계 계정 편집: ${pass} PASS · ${fails} FAIL · ${skips} SKIP`)
  process.exit(fails > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
