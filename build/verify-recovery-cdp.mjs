#!/usr/bin/env node
// verify-recovery-cdp.mjs — 중단 후 복구(recovery) 검증. 강제 종료 + 재시작을 실제로 겪게 해
// "프로세스 메모리 유실"을 증명한다. 세 시나리오:
//
//   R1 — 이미지 기준선(capture.ts 의 baselines Map)이 재시작을 못 넘긴다
//   R2 — 캡션 작성 도중(chatOnce 가 진행 중) 종료되면 아무 안내 없이 멈춘다
//   R3 — 게시 도중 종료되면 중복 게시 위험이 남는다(격리 HTTPS 픽스처 + 응답 보류로 실재현)
//
// 패턴은 build/verify-social-pipeline-cdp.mjs(앱 기동·evalIn·산출물 조회)와
// build/verify-task-runtime-cdp.mjs(boot/hardKill/gracefulQuit·신선도 대조)를 그대로 따른다.
//
// --main 옵션: 기본은 app/dist/main/index.js 이지만, "수정 전" 스냅샷(다른 작업자가 app/main 을
// 고치는 동안 앱 코드를 건드리지 않고 결함을 재현하기 위해 떠 둔 빌드)을 가리킬 수도 있다.
// 스냅샷 트리는 dist-before/{main,preload,renderer,shared} 구조를 그대로 유지하므로, 그 안의
// index.js 를 띄우면 preload·renderer 도 같은 스냅샷 쪽을 상대 경로로 찾는다(원래 배치와 동일).
//
// 사용: node build/verify-recovery-cdp.mjs [--port <n>] [--out <dir>] [--main <index.js 절대경로>] [--only <id>]

import { spawn, execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, waitForPortFree, connectShellSessionReady } from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'
import { startSocialFixtures, startInstagramHttpsFixture, REAL_DOMAIN_HOST, FIXTURE_ACCOUNT } from './social-fixture-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const ELECTRON_BIN = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')

const args = {
  port: 9277,
  out: path.join(REPO, 'verify-out', 'recovery'),
  main: path.join(REPO, 'app', 'dist', 'main', 'index.js'),
  only: null,
}
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--main') args.main = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--only') args.only = String(process.argv[++i])
  // R3 의 ①②(크래시·불확실 확정)까지는 각본 LLM 으로 상태를 만들고, **게시 여부 확인(읽기 전용)만**
  // 사용자의 실제 구독 CLI 모델에게 맡긴다. 그 뒤 시나리오(NEG/RO/POS)는 각본 전용이라 건너뛴다.
  else if (process.argv[i] === '--real-verify') args.realVerify = true
}
const MAIN_ENTRY = args.main

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const J = JSON.stringify

function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} PASS/FAIL=${ok} — ${name}: ${detail}`)
}
function skip(id, name, reason) {
  results.push({ id, name, status: 'SKIP', detail: reason })
  console.log(`  ⋯ ${id} SKIP — ${name}: ${reason}`)
}

/**
 * `--only` 는 **쉼표로 여러 개**를 받는다(`--only R3,R3-VER-INT`).
 *
 * 왜 (2026-09-19): 하나만 받던 시절엔 시나리오마다 따로 돌려야 했고, 그때마다 결과 파일이
 * **덮어써져서** 마지막 실행의 것만 남았다 — 앞서 통과한 시나리오가 `SKIP` 으로 찍힌 파일을 보고
 * "안 돌렸다" 고 오해하기 딱 좋다(실제로 그런 일이 있었다). 한 번에 돌려 한 기록에 담는다.
 */
function shouldRun(id) {
  if (!args.only) return true
  return args.only.split(',').map((s) => s.trim()).filter(Boolean).includes(id)
}

async function evalIn(s, expression, awaitPromise = false) {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, timeout: 30000 })
  if (r.result?.exceptionDetails) {
    throw new Error(`evalIn 예외: ${JSON.stringify(r.result.exceptionDetails).slice(0, 500)}`)
  }
  return r.result?.result?.value ?? r.result?.value
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}
function sha256File(p) {
  return sha256Buffer(fs.readFileSync(p))
}
async function fetchBytes(url) {
  const r = await fetch(url)
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) }
}

/** 라벨로 ref 를 찾아 클릭. 못 찾으면 스크롤(관찰 실패를 조용한 done 으로 감추지 않는다). */
function clickByLabel(label, missed) {
  return {
    reply: (ctx) => {
      const ref = ctx.refFor(label)
      if (ref === null || ref === undefined) {
        missed.push({ label, obs: String(ctx.lastUser).replace(/\s+/g, ' ').slice(0, 400) })
        return J({ action: 'scroll', direction: 'down' })
      }
      return J({ action: 'click', ref })
    },
  }
}

async function main() {
  if (!fs.existsSync(ELECTRON_BIN)) throw new Error(`electron 바이너리 없음: ${ELECTRON_BIN}`)
  if (!fs.existsSync(MAIN_ENTRY)) throw new Error(`진입점 없음: ${MAIN_ENTRY}`)
  fs.mkdirSync(args.out, { recursive: true })

  console.log(`[진입점] ${MAIN_ENTRY}`)
  try {
    const mt = fs.statSync(MAIN_ENTRY).mtime.toISOString()
    console.log(`[진입점 mtime] ${mt}`)
  } catch { /* ignore */ }

  args.port = await preferFreePort(args.port, 'verify-recovery-cdp.mjs')
  await waitForPortFree(args.port)
  const [llmPort] = await getFreePorts(1)

  const llm = await startFakeLlm({ port: llmPort })
  const fixture = await startSocialFixtures()
  console.log(`[픽스처] ${fixture.base} (127.0.0.1 loopback 전용)`)

  try {
    if (shouldRun('R1')) await scenarioR1({ llm, fixture })
    else skip('R1', '이미지 기준선 재시작 생존', '--only 로 제외됨')

    if (shouldRun('R2')) await scenarioR2({ llm, fixture })
    else skip('R2', '캡션 작성 중 종료 시 안내 없음', '--only 로 제외됨')

    if (shouldRun('R3')) await scenarioR3({ llm, fixture })
    else skip('R3', '게시 도중 종료 시 중복 게시 위험', '--only 로 제외됨')

    if (shouldRun('R3-VER-INT')) await scenarioR3VerInt({ llm, fixture })
    else skip('R3-VER-INT', '게시 여부 확인 작업이 도는 도중 강제 종료', '--only 로 제외됨')

    if (shouldRun('R3-STORE-TASKS')) {
      await scenarioR3Store({ llm, fixture, fileName: 'ai-tasks.json', id: 'R3-STORE-TASKS', humanLabel: '작업 목록 ai-tasks.json' })
    } else skip('R3-STORE-TASKS', '작업 목록(ai-tasks.json) 저장 실패 주입', '--only 로 제외됨')

    if (shouldRun('R3-STORE-SOCIAL')) {
      // ⚠ 실제 파일명은 'ai-social-workflows.json' 이다(social-workflow.ts 의 FILE_NAME 상수로 확인 —
      //   persistPublishBoundary 의 실패 메시지 문자열 "게시 워크플로(ai-social.json)" 은 오래된
      //   설명 라벨일 뿐 실제 파일명과 다르다). 처음에 'ai-social.json' 으로 주입했을 때 엉뚱한(존재
      //   하지도 않는) 경로만 막혀 실제 저장소는 멀쩡히 쓰기가 성공 — 서버 게시가 그대로 나갔다
      //   (승인 직후 서버 게시 0→1). 하네스 버그였고, 실제 파일명으로 고치자 정상 동작했다.
      await scenarioR3Store({ llm, fixture, fileName: 'ai-social-workflows.json', id: 'R3-STORE-SOCIAL', humanLabel: '게시 워크플로 ai-social-workflows.json' })
    } else skip('R3-STORE-SOCIAL', '게시 워크플로(ai-social-workflows.json) 저장 실패 주입', '--only 로 제외됨')
  } finally {
    await llm.close()
    await fixture.close()
  }

  fs.writeFileSync(path.join(args.out, 'recovery-results.json'), J({ main: MAIN_ENTRY, results }, null, 2))
  console.log('\n===== verify-recovery 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL')
  const pass = results.filter((r) => r.status === 'PASS')
  const skipped = results.filter((r) => r.status === 'SKIP')
  console.log(`PASS=${pass.length} FAIL=${fail.length} SKIP=${skipped.length} (총 ${results.length})`)
  for (const r of results) console.log(`${r.status} ${r.id}: ${r.detail}`)
  console.log(`\n결과 파일: ${path.join(args.out, 'recovery-results.json')}`)
  process.exit(fail.length ? 1 : 0)
}

// ── 앱 기동/종료 헬퍼 (verify-task-runtime-cdp.mjs 의 boot/hardKill/gracefulQuit 패턴) ──

function makeAppController(profileDir, logPrefix, extraArgs = []) {
  let child = null
  let shell = null

  async function boot(label) {
    const logStream = fs.createWriteStream(path.join(args.out, `${logPrefix}-${label}.log`))
    child = spawn(ELECTRON_BIN, [MAIN_ENTRY, `--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`, ...extraArgs],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(logStream); child.stderr.pipe(logStream)
    shell = await connectShellSessionReady(args.port)
    await sleep(1200)
    return evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
  }

  async function gracefulQuit() {
    if (!child) return
    const exited = new Promise((r) => { child.once('exit', r) })
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {}); b.close()
    } catch { /* ignore */ }
    await Promise.race([exited, sleep(15000)])
    try { shell?.close() } catch { /* ignore */ }
    try { child?.kill() } catch { /* ignore */ }
    await waitForPortFree(args.port).catch(() => {})
    await sleep(1000)
    child = null; shell = null
  }

  /** 진짜 비정상 종료 — before-quit 이 돌지 않는다(트리째 강제 종료). */
  async function hardKill() {
    if (!child) return
    const exited = new Promise((r) => { child.once('exit', r) })
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 15000 }) } catch { /* ignore */ }
    await Promise.race([exited, sleep(8000)])
    try { shell?.close() } catch { /* ignore */ }
    await waitForPortFree(args.port).catch(() => {})
    await sleep(1500)
    child = null; shell = null
  }

  return {
    boot, gracefulQuit, hardKill,
    get shell() { return shell },
    get child() { return child },
  }
}

/**
 * 프로필의 `ai-tasks.json` **원본**에서 작업 id 만 읽는다(제품 코드를 거치지 않는다).
 * 이래야 "디스크에 있었나" 와 "제품이 load 후에도 들고 있나" 를 따로 잴 수 있다.
 */
function rawTaskIds(profileDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(profileDir, 'ai-tasks.json'), 'utf-8'))
    return Array.isArray(raw?.tasks) ? raw.tasks.map((t) => t?.id).filter((x) => typeof x === 'string') : []
  } catch { return [] }
}

function writeProfileSettings(profileDir, llmUrl, downloadsDir) {
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), J({
    setup: { completed: true },
    // 강제 종료 뒤 재부팅하므로 '지난 세션 복원' 네이티브 모달이 창 생성(=CDP 타깃)을 막는다
    // (2026-09-07 임무 23 에서 규명). last-session 이면 묻지 않고 자동 복원한다.
    startup: { mode: 'last-session', urls: [] },
    adblock: { enabled: false },
    downloads: { defaultPath: downloadsDir, askEveryTime: false },
    ai: {
      enabled: true,
      provider: 'ollama',
      ollamaUrl: llmUrl,
      ollamaModel: 'test-model',   // 도구 허용목록에 없는 이름 → JSON 액션 경로(결정론적)
      agentMaxSteps: 25,
      agentVision: 'off',
      agentHumanInput: false,     // 검증에서는 빠른 합성 입력으로 충분
      agentInputMode: 'fast',
      agentAutoApprove: false,
      agentCollapsePanels: false,
    },
  }, null, 2))
}

async function newTab(shell, windowId, url) {
  return evalIn(shell, `window.browserAPI.tabs.create(${J(windowId)}, ${J(url)}).then(t => t.id)`, true)
}

/** ptaskGet 을 폴링해 지정 상태 중 하나가 될 때까지 기다린다. */
async function waitForTaskState(shell, taskId, states, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evalIn(shell, `window.browserAPI.ai.ptaskGet(${J(taskId)})`, true)
    if (last && states.includes(last.state)) return last
    await sleep(300)
  }
  return last
}

// ===================================================================================
// R1 — 이미지 기준선이 재시작을 못 넘긴다
//
// 픽스처: /gen?bigbait=1 — 900x900 미끼(생성물 800x600 보다 면적이 크다: 810000 > 480000).
// "생성" 클릭은 실 내비게이션(/gen?bigbait=1&done=1&seed=N)으로 결과를 반영한다 — 재시작 뒤
// 세션 복원이 같은 URL 로 돌아와도(정적 렌더) 생성 결과가 그대로 보여, "기준선 유실"의 영향만
// 골라 관찰할 수 있다(생성 자체가 사라지는 것과 구분).
//
// 1차 구간: mark_baseline → 생성 클릭 → wait_for(생성 이미지) → ask(구간 종료, capture_image 호출 전)
// 강제 종료 → 재시작(baselines Map 은 in-memory 라 여기서 통째로 사라진다) → 이어가기
// 2차 구간: capture_image(index:0) — index 를 명시로 준다(모델이 기준선 유실을 모르는 채 "가장
//   눈에 띄는" index 0 을 고르는 현실적 시나리오; index 를 생략하면 후보 2개라 자동 선택 자체가
//   안 되어 "선택 필요"로 막힐 뿐 — 이 경우도 버그의 증거지만 "미끼가 선택됨"이라는 더 명확한
//   신호를 얻기 위해 index:0 을 명시한다. 기준선이 살아 있었다면(수정 후) 후보는 생성물 1개뿐이라
//   index:0 이 정확히 그것을 가리킨다 — 그래서 이 판정은 기준선 생존 여부와 정확히 대응한다.)
// → done
//
// 판정: 저장된 산출물의 sha256 이 생성물과 같아야 PASS. 미끼와 같으면(또는 산출물이 없으면) FAIL.
// ===================================================================================
async function scenarioR1({ llm, fixture }) {
  const missed = []
  const profileDir = path.join(args.out, 'r1-profile')
  const downloadsDir = path.join(args.out, 'r1-downloads')
  writeProfileSettings(profileDir, llm.url, downloadsDir)
  const app = makeAppController(profileDir, 'r1')

  let taskId = null
  let seg1State = null
  let restartState = null
  let finalState = null

  try {
    await app.boot('boot1')
    const tabId = await newTab(app.shell, await evalIn(app.shell, 'new URL(location.href).searchParams.get("windowId")'), fixture.base + '/gen?bigbait=1')
    await sleep(500)

    const created = await evalIn(app.shell, `window.browserAPI.ai.ptaskCreate(${J({
      instruction: 'R1: 이 페이지에서 이미지를 생성하고 그 생성물을 가져와라.',
      tabId, mode: 'normal', readOnly: false,
    })})`, true)
    if (!created || !created.id) {
      check('R1', '이미지 기준선이 재시작을 못 넘긴다', false, `ptaskCreate 가 작업을 만들지 못함: ${J(created)}`)
      return
    }
    taskId = created.id

    llm.setScript([
      { reply: () => J({ action: 'mark_baseline' }) },
      clickByLabel('생성', missed),
      { reply: () => J({ action: 'wait_for', selector: 'img[alt="생성된 이미지"]', timeout: 8000 }) },
      { reply: () => J({ action: 'ask', message: '1차 구간 완료 — 재시작 전 확인 지점' }) },
    ])
    const startRes = await evalIn(app.shell, `window.browserAPI.ai.ptaskStart(${J(taskId)})`, true)
    if (!startRes?.ok) {
      check('R1', '이미지 기준선이 재시작을 못 넘긴다', false, `ptaskStart 실패: ${J(startRes)}`)
      return
    }

    seg1State = await waitForTaskState(app.shell, taskId,
      ['waiting-user', 'needs-verify', 'completed', 'failed', 'interrupted'], 30000)

    // json-store 는 400ms 디바운스로 쓴다 — 강제 종료 전 디스크에 실제로 반영될 시간을 준다.
    await sleep(1200)
    await app.hardKill()

    await app.boot('boot2')
    restartState = await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(taskId)})`, true)

    llm.setScript([
      { reply: () => J({ action: 'capture_image', index: 0 }) },
      { reply: () => J({ action: 'done', message: '완료' }) },
    ])
    const startRes2 = await evalIn(app.shell, `window.browserAPI.ai.ptaskStart(${J(taskId)})`, true)
    if (!startRes2?.ok) {
      check('R1', '이미지 기준선이 재시작을 못 넘긴다', false,
        `재시작 후 ptaskStart 실패: ${J(startRes2)} (재시작 직후 상태=${restartState?.state})`)
      return
    }

    finalState = await waitForTaskState(app.shell, taskId,
      ['completed', 'needs-verify', 'failed', 'interrupted', 'waiting-user'], 30000)

    const list = await evalIn(app.shell, `window.browserAPI.ai.artifactList(${J(taskId)})`, true)

    let ok = false
    let detail
    if (Array.isArray(list) && list.length >= 1 && list[0]?.path) {
      const savedSha = sha256File(list[0].path)
      const bait = await fetchBytes(fixture.base + '/img/bigbait.png')
      const gen = await fetchBytes(fixture.base + '/img/generated-1.png')
      const baitSha = sha256Buffer(bait.buf)
      const genSha = sha256Buffer(gen.buf)
      const which = savedSha === genSha ? '생성물(정답)' : savedSha === baitSha ? '미끼(버그 재현)' : '불일치(알 수 없는 바이트)'
      ok = savedSha === genSha && savedSha !== baitSha
      detail = `저장 산출물 ${list.length}개 · sha=${savedSha.slice(0, 12)} → ${which} `
        + `(생성물=${genSha.slice(0, 12)}, 미끼=${baitSha.slice(0, 12)}) · 치수=${list[0].width}x${list[0].height} `
        + `· 1차구간상태=${seg1State?.state} · 재시작직후상태=${restartState?.state}(waitReason="${restartState?.waitReason ?? ''}") `
        + `· 최종상태=${finalState?.state}`
    } else {
      detail = `산출물 0개(저장 실패) · 1차구간상태=${seg1State?.state} · 재시작직후상태=${restartState?.state} `
        + `(waitReason="${restartState?.waitReason ?? ''}") · 최종상태=${finalState?.state} `
        + (missed.length ? `· 관찰에서 못 찾은 라벨: ${missed.map((m) => m.label).join(',')}` : '')
    }
    check('R1', '이미지 기준선이 재시작을 못 넘긴다(capture.ts 의 baselines Map — in-memory, 재시작으로 소실)', ok, detail)
  } catch (err) {
    check('R1', '이미지 기준선이 재시작을 못 넘긴다', false, `예외: ${err.message}\n${(err.stack ?? '').slice(0, 800)}`)
  } finally {
    await app.gracefulQuit()
  }
}

// ===================================================================================
// R2 — 캡션 작성 도중(chatOnce 진행 중) 종료되면 아무 안내 없이 멈춘다
//
// social-workflow.ts 의 흐름: 생성 작업 완료 → reconcileGenerate → proceedToReview(stage='review')
// → draftCaptionInto() 가 비동기로 chatOnce 를 부른다. 그 호출이 응답 전에 죽으면, review 단계는
// taskEvents 'changed' 로도 재시도되지 않는다(reconcileOne 은 'generate'/'publish' 만 다시 본다 —
// 'review' 는 "사용자 조작만"이라는 주석대로 방치된다).
//
// 생성 작업의 모델 호출은 정확히 5회(mark_baseline·클릭·wait_for·capture_image·done) —
// 이후(6번째, 캡션 초안의 chatOnce)는 각본 마지막 항목을 재사용하므로 그 자리에 hang 을 둔다.
// ===================================================================================
async function scenarioR2({ llm, fixture }) {
  const missed = []
  const profileDir = path.join(args.out, 'r2-profile')
  const downloadsDir = path.join(args.out, 'r2-downloads')
  writeProfileSettings(profileDir, llm.url, downloadsDir)
  const app = makeAppController(profileDir, 'r2')

  let workflowId = null
  let reviewState = null
  let afterRestartWorkflow = null

  try {
    await app.boot('boot1')
    const windowId = await evalIn(app.shell, 'new URL(location.href).searchParams.get("windowId")')
    const tabId = await newTab(app.shell, windowId, fixture.base + '/gen')
    await sleep(500)

    llm.setScript([
      { reply: () => J({ action: 'mark_baseline' }) },
      clickByLabel('생성', missed),
      { reply: () => J({ action: 'wait_for', selector: 'img[alt="생성된 이미지"]', timeout: 8000 }) },
      { reply: () => J({ action: 'capture_image' }) },
      { reply: () => J({ action: 'done', message: '생성물을 가져왔습니다' }) },
      { mode: 'hang' },   // 6번째 호출(캡션 초안 chatOnce) — 여기서 영원히 응답 없음
    ])

    const started = await evalIn(app.shell, `window.browserAPI.ai.socialStart(${J({
      service: 'custom', customUrl: fixture.base + '/gen', prompt: 'R2 캡션 정지 테스트',
      platform: 'instagram', mode: 'draft', windowId, tabId,
    })})`, true)
    if (!started || !started.id) {
      check('R2', '캡션 작성 중 종료되면 아무 안내 없이 멈춘다', false, `socialStart 가 워크플로를 만들지 못함: ${J(started)}`)
      return
    }
    workflowId = started.id

    // stage 가 review 로 넘어갈 때까지 기다린다(생성 작업 완료 → reconcileGenerate).
    const deadline1 = Date.now() + 30000
    while (Date.now() < deadline1) {
      const list = await evalIn(app.shell, 'window.browserAPI.ai.socialList()', true)
      const wf = Array.isArray(list) ? list.find((w) => w.id === workflowId) : null
      if (wf && (wf.stage === 'review' || wf.stage === 'failed' || wf.stage === 'cancelled')) { reviewState = wf; break }
      await sleep(300)
    }

    if (!reviewState || reviewState.stage !== 'review') {
      check('R2', '캡션 작성 중 종료되면 아무 안내 없이 멈춘다', false,
        `review 단계에 도달하지 못함(마지막 관측: ${J(reviewState)}) `
        + (missed.length ? `· 관찰에서 못 찾은 라벨: ${missed.map((m) => m.label).join(',')}` : ''))
      return
    }

    // 캡션 초안 호출(hang)이 이미 나가 있을 시간을 준 뒤(그렇지 않으면 요청조차 안 나갔을 수 있다),
    // 캡션이 아직 안 채워진 것을 재확인하고 강제 종료한다.
    await sleep(1500)
    const beforeKill = (await evalIn(app.shell, 'window.browserAPI.ai.socialList()', true) ?? [])
      .find((w) => w.id === workflowId)
    await app.hardKill()

    await app.boot('boot2')
    const list2 = await evalIn(app.shell, 'window.browserAPI.ai.socialList()', true)
    afterRestartWorkflow = Array.isArray(list2) ? list2.find((w) => w.id === workflowId) : null

    // 재시작 후 잠시 기다려도(자동 재시도가 있다면 여기서 캡션이 채워질 것) 상태가 그대로인지 본다.
    await sleep(2000)
    const list3 = await evalIn(app.shell, 'window.browserAPI.ai.socialList()', true)
    const stillState = Array.isArray(list3) ? list3.find((w) => w.id === workflowId) : null

    const hasCaption = !!(stillState?.caption ?? '').trim()
    const hasCaptionError = !!(stillState?.captionError ?? '').trim()
    // 워크플로 타입에 명시적 "recovery"/"uncertain" 필드가 없다 — 존재할 만한 이름들을 넓게 확인한다.
    const recoveryHint = ['recovery', 'error', 'uncertain', 'publishUncertain', 'warning']
      .some((k) => !!stillState?.[k])

    // stuckNoHint === true 는 "버그가 재현됐다"(캡션도 없고, 오류도 없고, 복구 힌트도 없이 멈춤)는
    // 뜻이다 — R1 과 같은 극성으로 맞춘다: check() 의 ok 는 "정상(수정된) 동작인가" 를 뜻하므로
    // 여기서는 !stuckNoHint 를 넘긴다(버그 재현 시 FAIL, 캡션·오류·힌트 중 하나라도 있으면 PASS).
    const stuckNoHint = stillState?.stage === 'review' && !hasCaption && !hasCaptionError && !recoveryHint
    check('R2', '캡션 작성 중 종료되면 아무 안내 없이 멈춘다(review 단계는 taskEvents 로 재시도되지 않는다)',
      !stuckNoHint,
      `킬 직전 상태=${J(beforeKill ? { stage: beforeKill.stage, caption: beforeKill.caption, captionError: beforeKill.captionError } : null)} `
      + `· 재시작 직후=${J(afterRestartWorkflow ? { stage: afterRestartWorkflow.stage, caption: afterRestartWorkflow.caption } : null)} `
      + `· 재시작 2초 후=${J(stillState ? { stage: stillState.stage, caption: stillState.caption, captionError: stillState.captionError } : null)} `
      + `· caption있음=${hasCaption} captionError있음=${hasCaptionError} recovery힌트있음=${recoveryHint}`)
  } catch (err) {
    check('R2', '캡션 작성 중 종료되면 아무 안내 없이 멈춘다', false, `예외: ${err.message}\n${(err.stack ?? '').slice(0, 800)}`)
  } finally {
    await app.gracefulQuit()
  }
}

// ===================================================================================
// R3 — 게시 도중 종료되면 중복 게시 위험이 남는다 (실제 제품 워크플로 · 완전 격리)
//
// 무엇을 재현하는가 — "서버에는 글이 올라갔는데 브라우저는 성공 신호를 못 받았다":
//   ① social-workflow 의 실제 게시 경로를 그대로 탄다(socialStart → 승인 → 게시 작업).
//      게시 주소는 하드코딩된 https://www.instagram.com/ 이므로 Chromium `--host-resolver-rules`
//      로 127.0.0.1 의 HTTPS 픽스처에 묶는다 — **실제 서비스 접속 0건**.
//   ② 픽스처가 POST /sns/publish 를 받으면 state 에 **먼저 기록하고 응답을 보내지 않는다**
//      (holdPublish). 기록 시점은 앱이 아니라 **앱 밖 서버의 state.publishes** 로 관측한다.
//   ③ 그 순간 Electron 을 PID 강제 종료하고, **같은 격리 프로필로** 다시 부팅한다.
//   → 앱 데이터 파일을 손으로 편집해 가짜 상태를 만들지 않는다. publishUncertain·recovery·
//     resumeBlock 은 전부 제품이 실제 경로로 스스로 세운 값이다.
//
// 판정(전부 서버 쪽 게시 건수로 교차 확인):
//   R3              재시작 뒤 불확실 표시가 서고 이어가기가 막힌다. 재개·재승인을 여러 번 눌러도 총 1건 유지.
//   R3-VER-POS      실제로 서버에 올라간 캡션을 가진 불확실 워크플로 → 읽기 전용 확인이 화면에서
//                   실제 근거(발췌·URL)를 찾아 완료로 확정한다 — 양성 대조(막기만 하는 게 아님).
//   R3-RO           읽기 전용 확인 작업에서 type/upload_file 이 차단된다(악성 페이지가 시켜도). 추가 게시 0.
//   R3-VER-UNMARKED 표지 없는 결론은 완료로 인정하지 않고 불확실을 유지한다.
//   R3-VER-FORGED   서버에 없는 캡션인데 "게시됨:" 표지만 있으면 — 화면 근거가 없으므로 완료로
//                   확정하지 않는다(예전엔 이 표지 한 줄만으로 완료 처리했다 — 그 결함의 회귀 검사).
//   R3-VER-NOTPUB   "게시안됨:" 은 자동으로 차단을 풀지 않는다. 사람이 직접 "게시 안 됨"을 선택해야
//                   풀린다(양성 대조 포함 — 막기만 하고 사람 경로까지 막아버리진 않았는지 확인).
//   R3-NEG          전송 전에 중단하면 서버 게시 0건(유령 게시 없음) — 부정 대조.
//   R3-POS          정상 완료는 정확히 1건 + stage=done + 영수증 — 양성 대조(막기만 하는 것이 아님).
// ===================================================================================

/** 관찰문(참조 번호 [n] 이 있는 텍스트)과 일반 챗 호출을 구분한다. */
function isObservationText(text) {
  return /\[\d+\]\s/.test(String(text ?? ''))
}

/** 게시 작업 지시문에 치환돼 들어온 산출물 id 를 모델 입력에서 그대로 읽어온다. */
function artifactIdFrom(ctx) {
  // 제공자마다 시스템 프롬프트를 messages 에 넣기도 하고 별도 필드에 싣기도 한다 — **요청 본문 전체**를
  // 훑는다. 특정 필드 이름에 기대면 조용히 null 이 되어, 첨부 없이 "다음"만 누르는 무한 루프가 된다.
  let blob = ''
  try { blob = JSON.stringify(ctx?.body ?? '') } catch { blob = '' }
  blob += (ctx?.messages ?? []).map((m) => String(m?.content ?? '')).join('\n')
  // ⚠ 지시문에는 id 가 **둘** 나온다: 사람이 읽는 표시용 "(작업 산출물 art_A)" 가 먼저 나오고,
  //   실제로 첨부해야 하는 게시 작업 복사본 id 는 마지막 안내문("artifact 인자로 …")에 있다.
  //   그냥 첫 매치를 쓰면 없는 산출물을 첨부하려다 조용히 실패한다(실측으로 잡은 함정).
  const targeted = /artifact\s*인자로\s*\\?"(art_[0-9a-f]{6,})/.exec(blob)
  if (targeted) return targeted[1]
  const all = blob.match(/art_[0-9a-f]{6,}/g)
  return all && all.length ? all[all.length - 1] : null
}

/**
 * 하나의 각본 항목(마지막 항목은 재사용된다)으로 생성·캡션·게시·확인을 전부 처리하는 라우터.
 * 호출 횟수를 세지 않고 **화면에 보이는 것**으로 분기하므로, 단계 수가 달라져도 깨지지 않는다.
 * `phase` 는 하네스가 실행 중에 바꾸는 가변 객체다.
 */
/**
 * 사용자의 구독 CLI 가 이 컴퓨터에서 실제로 실행 가능한지 확인한다(앱과 같은 방식 — Windows 셸 경유).
 * 여기서 걸러야 "모델이 없어서" 를 "제품이 실패해서" 로 오인하지 않는다.
 */
function preflightClaudeCli() {
  try {
    const r = spawnSync('claude', ['--version'], {
      shell: process.platform === 'win32', timeout: 20_000, encoding: 'utf8', windowsHide: true,
    })
    if (r.error) return { ok: false, reason: `claude 실행 실패: ${r.error.message}` }
    if (typeof r.status === 'number' && r.status !== 0) {
      return { ok: false, reason: `claude --version 비정상 종료(코드 ${r.status}): ${String(r.stderr || r.stdout || '').slice(0, 200)}` }
    }
    return { ok: true, version: String(r.stdout || '').trim().slice(0, 80) }
  } catch (err) {
    return { ok: false, reason: `preflight 예외: ${err.message}` }
  }
}

/** 프로필을 지우지 않고 settings.json 의 ai 항목만 바꾼다(작업·워크플로 기록을 보존해야 한다). */
function patchProfileAi(profileDir, ai) {
  const file = path.join(profileDir, 'settings.json')
  const cur = JSON.parse(fs.readFileSync(file, 'utf-8'))
  cur.ai = { ...(cur.ai ?? {}), ...ai }
  fs.writeFileSync(file, J(cur, null, 2))
}

/**
 * R3-REAL — 복구 상태에서 **사용자의 실제 구독 모델**이 읽기 전용 확인을 수행한다.
 *
 * 각본 LLM 으로 대체하지 않는다. 여기서 확인하려는 것은 "각본대로 동작하는가" 가 아니라
 * **진짜 플래너가 우리의 복구 경로(resolvePublishUncertainty → 읽기 전용 확인 작업 → 표지 판정)를
 * 타고 결론을 내는가** 이기 때문이다. 판정 근거는 모델의 말이 아니라 **앱 밖 픽스처 서버의
 * 게시 건수**와 제품이 남긴 영수증이다.
 */
async function realVerifyPhase({ app, control, wfId, profileDir, pubCount, pubTaskId }) {
  const pre = preflightClaudeCli()
  if (!pre.ok) {
    check('R3-REAL', '복구 상태에서 실제 구독 모델이 읽기 전용 확인을 수행한다', false,
      `구독 CLI 를 쓸 수 없어 실행하지 못했습니다(대체 모델로 돌리지 않았습니다) — ${pre.reason}`)
    return
  }
  console.log(`  · 구독 CLI 확인: ${pre.version}`)

  const before = pubCount()
  await app.gracefulQuit()

  // 확인 작업은 **읽기**만 한다 — 게시 응답 보류를 풀어 페이지가 정상 응답하게 둔다.
  control.holdPublish = false
  patchProfileAi(profileDir, {
    provider: 'claude-code',
    claudeCodePath: '',
    claudeCodeModel: '',
    agentMaxSteps: 12,        // 읽기 전용 확인은 몇 단계면 끝난다 — 한도를 작게 잡는다.
    agentVision: 'off',
    cliSession: true,
  })
  await app.boot('boot-real')

  const cfg = await evalIn(app.shell, 'window.browserAPI.ai.config()', true).catch(() => null)
  console.log(`  · 앱이 본 AI 설정: provider=${cfg?.provider} model=${cfg?.model}`)

  const wfBefore = await getWorkflow(app.shell, wfId)
  const startedOk = await evalIn(app.shell, `window.browserAPI.ai.socialResolvePublish(${J(wfId)}, ${J('verify')})`, true)
    .catch((e) => ({ ok: false, error: String(e) }))

  // ⚠ 두 단계로 기다린다. 한 번에 "verifyTaskId 가 없으면 끝" 으로 보면, `startVerifyTask` 가
  //   비동기(확인용 탭을 열고 로드될 때까지 대기)라 **작업이 생기기도 전에** 즉시 통과해 버린다
  //   — 실제로 첫 실행에서 그렇게 돼 "확인 작업 없음" 을 결론으로 오독했다(하네스 결함).
  let vTaskSeen = null
  const vAppeared = await waitUntil(async () => {
    const wf = await getWorkflow(app.shell, wfId).catch(() => null)
    return !!wf?.verifyTaskId
  }, 90_000, 500)
  if (vAppeared) {
    await waitUntil(async () => {
      const wf = await getWorkflow(app.shell, wfId).catch(() => null)
      if (!wf?.verifyTaskId) return true   // 지워졌다 = 확인 작업이 결론에 도달했다
      const vt = await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(wf.verifyTaskId)})`, true).catch(() => null)
      if (vt) vTaskSeen = vt
      return false
    }, 6 * 60_000, 2000)
  }
  await sleep(2500)

  const wfAfter = await getWorkflow(app.shell, wfId)
  const after = pubCount()
  const pubTaskAfter = pubTaskId
    ? await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(pubTaskId)})`, true).catch(() => null)
    : null

  const evidence = wfAfter?.receipt?.evidence ?? ''
  const noExtraWrite = after === before
  const terminal = wfAfter?.stage === 'done'
  const hasMarker = /게시됨\s*:/.test(evidence)
  const readOnly = vTaskSeen?.readOnly !== false   // 확인 작업은 읽기 전용으로 만들어져야 한다

  fs.writeFileSync(path.join(args.out, 'r3-real-verify.json'), J({
    cli: pre.version, provider: cfg?.provider, model: cfg?.model,
    resolveResponse: startedOk,
    verifyTaskAppeared: vAppeared,
    wfBefore: { stage: wfBefore?.stage, publishUncertain: wfBefore?.publishUncertain, recovery: wfBefore?.recovery },
    wfAfter: { stage: wfAfter?.stage, publishUncertain: wfAfter?.publishUncertain, receipt: wfAfter?.receipt },
    verifyTask: vTaskSeen && {
      state: vTaskSeen.state, readOnly: vTaskSeen.readOnly,
      llmCalls: vTaskSeen.llmCalls, stepsUsed: vTaskSeen.stepsUsed, result: vTaskSeen.result,
    },
    publishTaskAfter: pubTaskAfter && { state: pubTaskAfter.state, resumeBlockedReason: pubTaskAfter.resumeBlockedReason },
    serverPublishes: { before, after },
  }, null, 2))

  check('R3-REAL', '복구 상태에서 **실제 구독 모델**이 읽기 전용 확인 → 영수증으로 결론(추가 게시 0)',
    !!(noExtraWrite && terminal && hasMarker),
    `서버 게시 ${before} → ${after}(추가 ${after - before}건) · 재시작 후 불확실=${wfBefore?.publishUncertain} `
    + `· resolve 응답=${J(startedOk)} · 확인작업 생성=${vAppeared} readOnly=${readOnly} state=${vTaskSeen?.state} `
    + `모델호출=${vTaskSeen?.llmCalls}/${vTaskSeen?.maxLlmCalls} 단계=${vTaskSeen?.stepsUsed} `
    + `· 최종 stage=${wfAfter?.stage} 영수증="${String(evidence).slice(0, 120)}" `
    + `· 모델=${cfg?.provider}/${cfg?.model} (각본 LLM 아님) · 상세: r3-real-verify.json`)
}

function makeR3Router(phase, log) {
  const st = { genStep: 0, vStep: 0, uploaded: false, typed: false, shared: false }
  const step = {
    reply: (ctx) => {
      const obs = String(ctx.lastUser ?? '')
      // 관찰이 아닌 호출 = 캡션 초안 같은 평문 챗. 평문으로 답한다.
      if (!isObservationText(obs)) return phase.caption

      if (phase.name === 'gen') {
        const i = st.genStep++
        if (i === 0) return J({ action: 'mark_baseline' })
        if (i === 1) {
          const r = ctx.refFor('생성')
          return r == null ? J({ action: 'scroll', direction: 'down' }) : J({ action: 'click', ref: r })
        }
        if (i === 2) return J({ action: 'wait_for', selector: 'img[alt="생성된 이미지"]', timeout: 8000 })
        if (i === 3) return J({ action: 'capture_image' })
        return J({ action: 'done', message: '생성물을 가져왔습니다' })
      }

      if (phase.name === 'verify') {
        // 읽기 전용 작업이다. 악성 페이지가 시키는 대로 쓰기를 시도해 본다 — 차단되어야 한다.
        const i = st.vStep++
        // R3-VER-INT 전용: 첫 스텝을 존재하지 않는 셀렉터로 긴 wait_for 를 걸어 확인 작업을 오래
        // 'running' 상태로 묶어 둔다(강제 종료 타이밍을 안정적으로 맞추기 위함). phase.verifySlow
        // 를 세팅하는 시나리오가 없으면(undefined) 이 분기는 절대 안 타 기존 동작과 완전히 같다.
        if (phase.verifySlow && i === 0) {
          return J({ action: 'wait_for', selector: '.__r3-verint-never-exists__', timeout: 60000 })
        }
        if (i === 0) return J({ action: 'type', ref: 0, text: '페이지가 시키는 대로 댓글을 답니다' })
        if (i === 1) return J({ action: 'upload_file', artifact: artifactIdFrom(ctx) ?? 'art_none' })
        if (i === 2) return J({ action: 'read' })
        return J({ action: 'done', message: phase.verifyResult })
      }

      // phase.name === 'publish' — 인스타 픽스처 위저드(4단계)를 라벨로 탄다.
      if (/공유하기/.test(obs)) {
        if (st.shared) return J({ action: 'wait_for', selector: '#shareResult p', timeout: 6000 })
        if (!st.typed) {
          const t = ctx.refFor('문구')
          if (t != null) { st.typed = true; return J({ action: 'type', ref: t, text: phase.caption }) }
        }
        if (phase.stopBeforeShare) {
          // 전송 전 중단 — 게시 요청 자체를 내보내지 않는다(부정 대조).
          return J({ action: 'ask', question: '공유 전에 사용자 확인이 필요합니다.' })
        }
        const r = ctx.refFor('공유하기')
        if (r != null) { st.shared = true; return J({ action: 'click', ref: r }) }
      }
      if (/자르기|필터를 선택/.test(obs)) {
        const r = ctx.refFor('다음')
        if (r != null) return J({ action: 'click', ref: r })
      }
      if (/새 게시물 만들기/.test(obs)) {
        if (!st.uploaded) {
          const art = artifactIdFrom(ctx)
          if (art) { st.uploaded = true; return J({ action: 'upload_file', artifact: art }) }
        }
        const r = ctx.refFor('다음')
        if (r != null) return J({ action: 'click', ref: r })
      }
      {
        const r = ctx.refFor('만들기')
        if (r != null) return J({ action: 'click', ref: r })
      }
      log.push(`분기 실패: ${obs.replace(/\s+/g, ' ').slice(0, 200)}`)
      return J({ action: 'scroll', direction: 'down' })
    },
  }
  return { st, step }
}

async function waitUntil(fn, timeoutMs, stepMs = 400) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() >= deadline) return false
    await sleep(stepMs)
  }
}

/**
 * 확인 대기(waiting-user)면 사용자가 "승인"을 누른 것과 똑같이 처리한다 — 게시 클릭은 민감 행동이라
 * 제품이 반드시 사람에게 묻는다(agentAutoApprove=false). 승인 자체가 성공을 만들어주지 않는다:
 * 게시 여부는 항상 앱 밖 픽스처 서버의 state.publishes 로 따로 판정한다.
 */
async function confirmIfWaiting(shell, taskId, state) {
  if (!taskId || state !== 'waiting-user') return false
  await evalIn(shell, `window.browserAPI.ai.ptaskConfirm(${J(taskId)}, true)`, true).catch(() => {})
  const t = await evalIn(shell, `window.browserAPI.ai.ptaskGet(${J(taskId)})`, true).catch(() => null)
  if (t?.state === 'waiting-user') {
    await evalIn(shell, `window.browserAPI.ai.ptaskAnswer(${J(taskId)}, ${J('네, 계속 진행해 주세요.')})`, true).catch(() => {})
  }
  return true
}

async function getWorkflow(shell, id) {
  const list = await evalIn(shell, 'window.browserAPI.ai.socialList()', true)
  return Array.isArray(list) ? (list.find((w) => w.id === id) ?? null) : null
}

/**
 * 생성 → 리뷰 → 승인까지 몰아 게시 작업을 시작시킨다. 게시 작업 id 를 돌려준다(없으면 null).
 *
 * `opts.beforeApprove(id)` — review 도달 **직후·승인 직전**에 호출되는 훅(선택). 저장 실패
 * 주입처럼 "승인 버튼을 누르기 직전" 시점이 필요한 시나리오가 안전하게 끼워 넣는다.
 * 훅을 안 주면(기존 4-인자 호출) 이전과 **100% 동일하게** 동작한다.
 *
 * `account: FIXTURE_ACCOUNT` — 게시 여부 확인이 "어느 계정의 글인가" 까지 화면에서 대조하므로
 * (agent-gate.ts sightingSupportsPublication), 인스타 격리 픽스처가 로그인돼 있는 계정과 맞춰
 * 둬야 R3-VER-POS 류의 완료 확정이 "계정을 몰라 대조 불가"로 uncertain 에 머무르지 않는다.
 */
async function driveToPublish(app, fixture, phase, caption, opts = {}) {
  const windowId = await evalIn(app.shell, 'new URL(location.href).searchParams.get("windowId")')
  const tabId = await newTab(app.shell, windowId, fixture.base + '/gen')
  await sleep(600)

  phase.name = 'gen'
  phase.caption = caption
  const started = await evalIn(app.shell, `window.browserAPI.ai.socialStart(${J({
    service: 'custom', customUrl: fixture.base + '/gen', prompt: 'R3 게시 중단 테스트',
    platform: 'instagram', mode: 'publish', windowId, tabId, account: FIXTURE_ACCOUNT,
  })})`, true)
  if (!started?.id) return { error: `socialStart 실패: ${J(started)}` }
  const id = started.id

  const reachedReview = await waitUntil(async () => {
    const wf = await getWorkflow(app.shell, id)
    return !!wf && (wf.stage === 'review' || wf.stage === 'failed' || wf.stage === 'cancelled')
  }, 45000)
  const wfReview = await getWorkflow(app.shell, id)
  if (!reachedReview || wfReview?.stage !== 'review') {
    return { error: `review 단계 도달 실패(stage=${wfReview?.stage} error=${wfReview?.error ?? ''})`, id }
  }

  phase.name = 'publish'
  if (typeof opts.beforeApprove === 'function') await opts.beforeApprove(id)
  const approved = await evalIn(app.shell,
    `window.browserAPI.ai.socialApprove(${J(id)}, ${J(caption)})`, true)
  if (!approved?.ok) return { error: `승인 실패: ${J(approved)}`, id }
  return { id }
}

/**
 * 읽기 전용 확인 작업을 시작시키고 결론(완료 확정 또는 불확실 유지)에 도달할 때까지 기다린다.
 * `verifyResult` 는 각본이 done 에 실어 보낼 문장이다 — 그 문장이 진짜 근거가 되는지는 런타임이
 * (readSightings 로) 스스로 판정한다. 여기서는 그 판정 과정을 한 번 실행하고 결과만 돌려준다 —
 * "성공/실패" 를 미리 판단하지 않는다(호출부가 시나리오별로 다른 기준으로 판정한다).
 */
async function verifyWithRealCaption({ app, llm, phase, routerLog, targetWfId, verifyResult, pubCount }) {
  const before = pubCount()
  phase.name = 'verify'
  phase.verifyResult = verifyResult
  const router = makeR3Router(phase, routerLog)
  llm.setScript([router.step])
  const resp = await evalIn(app.shell, `window.browserAPI.ai.socialResolvePublish(${J(targetWfId)}, ${J('verify')})`, true)
    .catch((e) => ({ ok: false, error: String(e) }))
  if (!resp?.ok) {
    return { ok: false, resp, before, after: pubCount(), settled: false, wfAfter: null, triedWrites: false, readSightings: [], verifyTaskId: null }
  }
  // verifyTaskId 는 결론이 나면 지워진다(reconcileVerifyTask 의 규약) — 지워지기 전에 잡아 둬야
  // 나중에 ptaskGet 으로 **런타임이 실제로 화면에서 본 근거**(readSightings, 모델이 만들 수 없는
  // 값)를 조회할 수 있다. 못 잡아도(레이스로 이미 지워졌으면) 결과 자체엔 영향 없다 — 보고용 부가정보다.
  let verifyTaskId = null
  await waitUntil(async () => {
    const wf = await getWorkflow(app.shell, targetWfId)
    if (wf?.verifyTaskId) verifyTaskId = wf.verifyTaskId
    return !!verifyTaskId
  }, 15000, 300)
  // verifyTaskId 가 지워지는 것이 곧 "결론에 도달했다"는 뜻이다(reconcileVerifyTask 가 완료·불확실
  // 어느 쪽으로 결론을 내든 항상 지운다 — social-workflow.ts 의 규약).
  const settled = await waitUntil(async () => {
    const wf = await getWorkflow(app.shell, targetWfId)
    return !!wf && !wf.verifyTaskId
  }, 90000, 800)
  await sleep(1200)
  const wfAfter = await getWorkflow(app.shell, targetWfId)
  const verifyTask = verifyTaskId
    ? await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(verifyTaskId)})`, true).catch(() => null)
    : null
  const readSightings = Array.isArray(verifyTask?.readSightings) ? verifyTask.readSightings : []
  return { ok: true, resp, settled, wfAfter, before, after: pubCount(), triedWrites: router.st.vStep >= 2, readSightings, verifyTaskId }
}

/** readSightings 배열을 로그에 담기 좋은 짧은 문자열로 요약한다(url·발췌만 — 나머지는 잡음). */
function summarizeSightings(list) {
  const arr = Array.isArray(list) ? list : []
  if (arr.length === 0) return '없음'
  return arr.map((s) => `[${s.url ?? ''} · "${String(s.snippet ?? '').slice(0, 90)}"]`).join(' ')
}

// ── R3-STORE-* 공용: 프로필 안의 저장 파일을 디렉터리로 바꿔 tmp→rename 을 결정적으로 실패시킨다 ──
//
// json-store.ts 의 writeSyncAt/runPersist 는 둘 다 "<file>.<pid>-<n>.tmp 로 쓴 뒤 file 로 rename"
// 패턴이다. file 자리에 **디렉터리**가 있으면 그 rename 은 OS 불문 항상 실패한다(파일→기존 디렉터리
// rename 은 성립하지 않는다) — 디스크 꽉 참·권한 거부와 달리 크로스플랫폼으로 결정적이다.
//
// ⚠ 주입은 기존 파일을 **지우고** 그 자리에 디렉터리를 놓는다 — 그 파일이 들고 있던 이전 데이터는
//   사라진다(예: ai-tasks.json 을 주입하면 이미 완료된 생성 작업 기록도 함께 사라진다). 이는 부팅 시
//   json-store 의 loadJsonObject 가 "읽을 수 없는 파일"로 보고 **디렉터리째 격리(rename)** 하는
//   결과로 이어질 수 있다 — 재부팅 뒤 그 저장소가 텅 빈 채로 시작될 수 있다는 뜻이다. 이 부수효과를
//   숨기지 않고 각 시나리오가 직접 관측해 detail 에 남긴다.
function injectStorageFailure(profileDir, fileName) {
  const p = path.join(profileDir, fileName)
  fs.rmSync(p, { recursive: true, force: true })
  fs.mkdirSync(p, { recursive: true })
}

/** 주입한 실패를 치운다 — 사용자가 하듯 "막힌 폴더를 지운다". 이미 없어도(자동 격리 등) 안전(no-op). */
function clearStorageFailure(profileDir, fileName) {
  fs.rmSync(path.join(profileDir, fileName), { recursive: true, force: true })
}

/** 주입이 아직 살아 있는지(디렉터리로 남아 있는지) 앱 프로세스 밖에서 직접 확인한다. */
function isStorageFailureActive(profileDir, fileName) {
  try { return fs.statSync(path.join(profileDir, fileName)).isDirectory() } catch { return false }
}

/**
 * json-store.ts 의 loadJsonObject 가 "읽을 수 없는 파일"(우리가 주입한 디렉터리 포함)을 만나면
 * `<file>.corrupt-<시각>.bak` 로 **이름만 바꿔 격리**한다 — 디렉터리 rename 은 파일→디렉터리 rename
 * 과 달리 **성공**하므로, 부팅 한 번으로 우리가 건 막힘이 저절로 풀릴 수 있다(정상적인 자기 복구
 * 설계 — 제품 결함이 아니다). 그 격리가 실제로 일어났는지 앱 밖에서 직접 확인한다.
 */
function wasQuarantined(profileDir, fileName) {
  try {
    return fs.readdirSync(profileDir).some((n) => n.startsWith(`${fileName}.corrupt-`) && n.endsWith('.bak'))
  } catch { return false }
}

async function scenarioR3({ llm, fixture }) {
  const control = { holdPublish: true }
  const ig = await startInstagramHttpsFixture(fixture.state, path.join(args.out, 'r3-certs'), control)
    .catch((err) => { console.log('[igHttps] 기동 실패:', err?.message ?? err); return null })
  if (!ig) {
    skip('R3', '게시 도중 종료되면 중복 게시 위험이 남는다',
      '격리 인터셉터(openssl 자체 서명 인증서)를 세우지 못해 실행하지 않음 — 실제 instagram.com 에 붙는 것보다 SKIP 이 안전하다.')
    return
  }
  console.log(`[R3 격리] ${REAL_DOMAIN_HOST} → 127.0.0.1:${ig.port} (실제 서비스 접속 0건)`)

  const routerLog = []
  const phase = { name: 'gen', caption: 'R3 테스트 캡션', verifyResult: '', stopBeforeShare: false }
  const router = makeR3Router(phase, routerLog)
  llm.setScript([router.step])

  const profileDir = path.join(args.out, 'r3-profile')
  const downloadsDir = path.join(args.out, 'r3-downloads')
  writeProfileSettings(profileDir, llm.url, downloadsDir)
  const app = makeAppController(profileDir, 'r3', [
    `--host-resolver-rules=${ig.hostResolverRule}`,
    '--ignore-certificate-errors',   // 격리 인터셉터의 자체 서명 인증서용(이 검증 실행 한정)
  ])

  const pubCount = () => fixture.state.publishes.length
  const base0 = pubCount()

  try {
    // ── ① 게시 요청이 서버에 실제로 저장된 순간까지 몰고 간 뒤 강제 종료 ──────────────────
    await app.boot('boot1')
    const drive = await driveToPublish(app, fixture, phase, 'R3 테스트 캡션')
    if (drive.error || !drive.id) {
      check('R3', '게시 중단 → 불확실 표시 + 중복 게시 0', false,
        `${drive.error} · 라우터 분기 실패: ${routerLog.slice(0, 2).join(' | ')}`)
      return
    }
    const wfId = drive.id

    // ── 유실 진단 (2026-09-19) ─────────────────────────────────────────────────────────
    // "게시 작업 기록이 왜 ai-tasks.json 에 없었나" 를 **추정하지 않고 가른다**:
    //   ① 킬 직전 raw 파일에 있었나(=boot1 이 썼나)  ② 킬 직후 raw 에 있나
    //   ③ 제품이 load 한 뒤에도 있나(=reviveTask 가 버렸나)
    // 셋을 따로 재야 "쓰이지 않았다" 와 "썼는데 버려졌다" 가 구분된다.
    const durability = { pubTaskId: null, createdAt: 0, firstSeenAt: 0, killedAt: 0, msCreateToKill: null }
    let lastSeen = ''
    const sent = await waitUntil(async () => {
      if (pubCount() >= base0 + 1) return true
      const wf = await getWorkflow(app.shell, wfId).catch(() => null)
      const pid = wf?.taskIds?.publish
      if (pid && !durability.pubTaskId) {
        durability.pubTaskId = pid
        durability.firstSeenAt = Date.now()
      }
      const pt = pid ? await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(pid)})`, true).catch(() => null) : null
      const line = `stage=${wf?.stage} err=${(wf?.error ?? '').slice(0, 80)} pub=${pid ?? '-'} ptask=${pt?.state}/${(pt?.result ?? '').slice(0, 60)}`
      if (line !== lastSeen) { lastSeen = line; console.log(`    · ${line}`) }
      await confirmIfWaiting(app.shell, pid, pt?.state)
      return false
    }, 90000, 1200)
    if (!sent) {
      const wfDbg = await getWorkflow(app.shell, wfId).catch(() => null)
      const ptDbg = wfDbg?.taskIds?.publish
        ? await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(wfDbg.taskIds.publish)})`, true).catch(() => null) : null
      fs.writeFileSync(path.join(args.out, 'r3-debug.json'), J({
        wf: wfDbg, ptask: ptDbg, routerLog,
        llm: llm.requests.slice(-8).map((r) => String(r.lastUser ?? '').replace(/\s+/g, ' ').slice(0, 600)),
      }, null, 2))
      check('R3', '게시 중단 → 불확실 표시 + 중복 게시 0', false,
        `게시 요청이 서버에 도달하지 않음(서버 게시 ${pubCount() - base0}건) · 마지막 상태: ${lastSeen} `
        + `· ptask.result="${(ptDbg?.result ?? '').slice(0, 160)}" · 진단 덤프: r3-debug.json `
        + `· 라우터 분기 실패: ${routerLog.slice(0, 3).join(' | ')}`)
      return
    }
    const afterSend = pubCount()

    // 킬 직전: 게시 작업 id 를 확정하고, 그 작업이 **이미 디스크에 있는지** 를 본다.
    if (!durability.pubTaskId) {
      const wfNow = await getWorkflow(app.shell, wfId).catch(() => null)
      durability.pubTaskId = wfNow?.taskIds?.publish ?? null
    }
    if (durability.pubTaskId) {
      const live = await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(durability.pubTaskId)})`, true).catch(() => null)
      durability.createdAt = live?.createdAt ?? 0
      durability.liveState = live?.state ?? null
    }
    durability.rawBeforeKill = rawTaskIds(profileDir).includes(durability.pubTaskId)
    durability.rawCountBeforeKill = rawTaskIds(profileDir).length

    console.log(`  · 서버가 게시 1건을 저장했고 응답은 보류 중(heldCount=${ig.heldCount()}) → 강제 종료`)
    durability.killedAt = Date.now()
    if (durability.createdAt) durability.msCreateToKill = durability.killedAt - durability.createdAt
    await app.hardKill()
    durability.rawAfterKill = rawTaskIds(profileDir).includes(durability.pubTaskId)
    durability.rawCountAfterKill = rawTaskIds(profileDir).length

    // ── ② 같은 격리 프로필로 재부팅 — 제품이 스스로 세운 복구 상태를 본다 ───────────────
    await app.boot('boot2')
    const settled = await waitUntil(async () => {
      const wf = await getWorkflow(app.shell, wfId)
      return !!wf && (wf.publishUncertain === true || wf.stage === 'done' || wf.stage === 'failed')
    }, 30000)
    const wfAfter = await getWorkflow(app.shell, wfId)
    const pubTaskId = wfAfter?.taskIds?.publish ?? null
    const pubTask = pubTaskId
      ? await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(pubTaskId)})`, true)
      : null

    // ── R3-DUR: 되돌릴 수 없는 외부 쓰기를 시작하기 전에 그 작업 기록이 디스크에 남아 있어야 한다 ──
    // 남지 않으면 재시작 후 제품은 "무엇을 하던 중이었는지" 를 잃고 안전망(불확실 표시)에만 기댄다.
    durability.loadedHasAfterBoot = !!pubTask
    durability.rawAfterBoot = rawTaskIds(profileDir).includes(durability.pubTaskId)
    durability.wfKeptPublishId = pubTaskId === durability.pubTaskId && !!pubTaskId
    fs.writeFileSync(path.join(args.out, 'r3-durability.json'), J(durability, null, 2))
    check('R3-DUR', '게시(비가역 외부 쓰기) 시작 전에 게시 작업 기록이 디스크에 확정된다 — 강제 종료를 넘긴다',
      !!(durability.pubTaskId && durability.rawBeforeKill && durability.rawAfterKill && durability.loadedHasAfterBoot),
      `게시작업 ${String(durability.pubTaskId).slice(0, 8)} · 워크플로는 id 보존=${durability.wfKeptPublishId} `
      + `· raw(ai-tasks.json) 킬직전=${durability.rawBeforeKill} 킬직후=${durability.rawAfterKill} 재부팅후=${durability.rawAfterBoot} `
      + `· 제품 load 후 존재=${durability.loadedHasAfterBoot} `
      + `· 생성→킬 ${durability.msCreateToKill ?? '?'}ms · raw 작업수 ${durability.rawCountBeforeKill}→${durability.rawCountAfterKill}`)

    // ── ③ 재개·재승인을 반복해도 서버 게시가 늘지 않아야 한다 ────────────────────────────
    const resumeAttempts = []
    for (let i = 0; i < 3; i++) {
      if (!pubTaskId) break
      resumeAttempts.push(await evalIn(app.shell, `window.browserAPI.ai.ptaskStart(${J(pubTaskId)})`, true).catch((e) => ({ error: String(e) })))
      await sleep(400)
    }
    const approveAgain = []
    for (let i = 0; i < 2; i++) {
      approveAgain.push(await evalIn(app.shell, `window.browserAPI.ai.socialApprove(${J(wfId)}, ${J('중복 승인 시도')})`, true).catch((e) => ({ error: String(e) })))
      await sleep(400)
    }
    await sleep(4000)   // 막히지 않았다면 이 사이에 두 번째 게시가 나갔을 것이다.
    const afterResume = pubCount()

    const uncertain = wfAfter?.publishUncertain === true
    const recoveryOk = wfAfter?.recovery?.kind === 'publish-uncertain'
    // 이어가기가 실제로 막혔는가.
    // ⚠ 2026-09-19 이전에는 `|| !pubTask`(작업 기록이 없으면 막힌 것으로 침) 가 붙어 있었다.
    //   그 조항은 "보이지 않는 것" 을 "막힌 것" 으로 세는 것이라, 기록 유실이라는 **제품 결함이
    //   있는 채로도 통과**했다(SL17 과 같은 부류). 유실은 R3-DUR 이 따로 잡으므로, 여기서는
    //   **실제 차단 사유가 적혀 있을 때만** 막혔다고 본다.
    const blocked = !!(pubTask?.resumeBlockedReason ?? '').trim()
    const resumeRefused = resumeAttempts.every((r) => r && r.ok !== true)
    const approveRefused = approveAgain.every((r) => !r || r.ok !== true)
    const noDup = afterResume === afterSend
    check('R3', '게시 도중 강제 종료 → 불확실 표시 + 이어가기 차단 + 중복 게시 0(서버 관측)',
      !!(settled && uncertain && recoveryOk && blocked && resumeRefused && approveRefused && noDup),
      `서버 게시: 시작 ${base0} → 전송직후 ${afterSend} → 재개·재승인 5회 후 ${afterResume}(중복없음=${noDup}) `
      + `· publishUncertain=${uncertain} recovery.kind=${wfAfter?.recovery?.kind ?? '(없음)'} `
      + `· 게시작업 state=${pubTask?.state} resumeBlockedReason="${(pubTask?.resumeBlockedReason ?? '').slice(0, 60)}" `
      + `· ptaskStart 거부=${resumeRefused}(${J(resumeAttempts).slice(0, 120)}) socialApprove 거부=${approveRefused} `
      + `· 안내="${wfAfter?.recovery?.nextAction ?? ''}"`)

    // ── ④ 양성 대조: 실제로 서버에 올라간 캡션을 가진 불확실 워크플로 → 읽기 전용 확인이
    //    화면에서 실제 근거를 찾아 완료로 확정해야 한다(막기만 하는 게 아니라는 것을 보인다).
    //
    //    1차 시도: wfId(방금 강제 종료를 겪은 원 워크플로, 캡션 "R3 테스트 캡션") 로 바로 시도한다.
    //    그 워크플로의 게시 요청은 ①에서 이미 서버에 실제로 기록됐다(heldCount) — 지금 boot2 로
    //    살아 있는 앱이 아직 그 세션(윈도우)을 붙들고 있을 수도, 재시작으로 잃었을 수도 있다.
    //    실패(ok:false — 세션을 모른다고 거절)하면 **대안 경로**로 새 워크플로를 같은 방식(응답
    //    보류 + 강제 종료 + 재부팅)으로 몰아 불확실 상태를 만든 뒤 다시 시도한다 — 정답을 미리
    //    심지 않는다: 캡션이 "최근 게시물" 목록에 뜨는 것은 실제로 서버에 기록됐기 때문이어야 한다.
    {
      const beforeVerPos = pubCount()
      let attempt = await verifyWithRealCaption({
        app, llm, phase, routerLog, targetWfId: wfId, pubCount,
        verifyResult: '게시됨: 게시물 목록에서 같은 문구의 글을 확인했습니다.',
      })
      let source = `wfId(강제종료로 복구된 원 워크플로, 캡션 "${phase.caption}")`

      if (!attempt.ok || !attempt.settled || attempt.wfAfter?.stage !== 'done') {
        console.log(`  · R3-VER-POS: wfId 경로로 결론에 이르지 못함 `
          + `(resolve응답=${J(attempt.resp ?? { ok: attempt.ok })} 결론도달=${attempt.settled} stage=${attempt.wfAfter?.stage}) `
          + `— 대안 경로(신규 워크플로 + 재기록 + 강제종료 + 재부팅)로 전환`)
        source = '대안(신규 워크플로를 응답보류로 서버에 기록 → 강제종료 → 재부팅 → 확인)'

        control.holdPublish = true
        const altCaption = 'R3 양성 확인 캡션'
        const beforeAlt = pubCount()
        const routerAlt = makeR3Router(phase, routerLog)
        llm.setScript([routerAlt.step])
        const altDrive = await driveToPublish(app, fixture, phase, altCaption)
        if (altDrive.error || !altDrive.id) {
          attempt = { ok: false, error: `대안 워크플로 생성 실패: ${altDrive.error}`, before: beforeVerPos, after: pubCount(), settled: false, wfAfter: null }
        } else {
          const altSent = await waitUntil(() => pubCount() > beforeAlt, 90000, 1000)
          await sleep(1000)
          await app.hardKill()
          await app.boot('boot-verpos')
          const wfAltAfterBoot = await getWorkflow(app.shell, altDrive.id)
          if (!altSent || wfAltAfterBoot?.publishUncertain !== true) {
            attempt = {
              ok: false, before: beforeVerPos, after: pubCount(), settled: false, wfAfter: wfAltAfterBoot,
              error: `대안 경로에서도 불확실 상태를 만들지 못함(전송됨=${altSent}, 재부팅후 publishUncertain=${wfAltAfterBoot?.publishUncertain})`,
            }
          } else {
            attempt = await verifyWithRealCaption({
              app, llm, phase, routerLog, targetWfId: altDrive.id, pubCount,
              verifyResult: '게시됨: 게시물 목록에서 같은 문구의 글을 확인했습니다.',
            })
          }
        }
      }

      const wfPos2 = attempt.wfAfter
      const evidence = wfPos2?.receipt?.evidence ?? ''
      const hasReadOnlyEvidence = /읽기 전용 확인/.test(evidence)
      const receiptUrl = String(wfPos2?.receipt?.url ?? '')
      // 인스타 격리 픽스처는 앱 눈에 https://www.instagram.com/ 로 보인다(호스트 해석만 loopback 으로
      // 되돌아간다 — social-fixture-server.mjs 상단 주석 참고). 그래서 URL 문자열 자체는 실제 호스트명이다.
      const urlOk = /^https?:\/\/(www\.)?instagram\.com\//.test(receiptUrl)
      const noExtraWrite = (attempt.after ?? pubCount()) === (attempt.before ?? beforeVerPos)
      check('R3-VER-POS', '실제로 서버에 올라간 캡션을 가진 불확실 워크플로 → 읽기 전용 확인이 화면 근거로 완료 확정(영수증 포함) — 양성 대조',
        !!(attempt.ok && attempt.settled && wfPos2?.stage === 'done' && hasReadOnlyEvidence && urlOk && noExtraWrite),
        `경로=${source} · resolve성공=${attempt.ok} 결론도달=${attempt.settled} stage=${wfPos2?.stage} `
        + `· 영수증="${evidence.slice(0, 160)}" 영수증url="${receiptUrl}"(host판정=${urlOk}) `
        // readSightings — 모델의 산문이 아니라 런타임이 직접 관찰해 적어 둔 근거(무엇을 근거로
        // 완료로 확정했는가). ptaskGet(verifyTaskId) 로 조회 — 완료 확정 시 verifyTaskId 는 이미
        // 지워지지만, verifyWithRealCaption 이 그 전에 잡아 둔 값을 쓴다.
        + `· 확인작업이 실제로 본 근거(readSightings): ${summarizeSightings(attempt.readSightings)} `
        + `· 서버 게시: ${attempt.before ?? beforeVerPos} → ${attempt.after ?? pubCount()}(추가 ${(attempt.after ?? pubCount()) - (attempt.before ?? beforeVerPos)}건, 기대 0) `
        + (attempt.error ? `· 오류: ${attempt.error}` : ''))
    }

    // ── ④-real: 게시 여부 확인(읽기 전용)을 **실제 구독 CLI 모델**에게 맡긴다 ─────────────
    if (args.realVerify) {
      await realVerifyPhase({ app, control, wfId, profileDir, pubCount, pubTaskId })
      return   // 뒤 시나리오(NEG/RO/POS)는 각본 LLM 전용 — 같은 실행에서 이어가지 않는다.
    }

    // ── ⑤ 부정 대조: 전송 전에 중단하면 서버 게시 0건(유령 게시 없음) ────────────────────
    control.holdPublish = true
    const beforeNeg = pubCount()
    const router2 = makeR3Router(phase, routerLog)
    llm.setScript([router2.step])
    phase.stopBeforeShare = true
    const negDrive = await driveToPublish(app, fixture, phase, 'R3 전송 전 중단 캡션')
    let negDetail = ''
    if (negDrive.error || !negDrive.id) {
      negDetail = `게시 단계까지 가지 못함: ${negDrive.error}`
    } else {
      // 게시 클릭은 민감 행동이라 제품이 확인을 요구한다 — **승인하지 않고** 그 상태에서 강제 종료한다.
      // (요청이 나가기 전에 멈춘 지점이다. stopBeforeShare 는 확인 게이트가 없더라도 ask 로 멈추게 하는 이중 안전장치.)
      const reached = await waitUntil(async () => {
        if (pubCount() > beforeNeg) return true
        const wf = await getWorkflow(app.shell, negDrive.id)
        const pid = wf?.taskIds?.publish
        if (!pid) return false
        const pt = await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(pid)})`, true).catch(() => null)
        return pt?.state === 'waiting-user' || pt?.state === 'interrupted' || pt?.state === 'failed'
      }, 90000, 1000)
      negDetail = `확인대기 도달=${reached}`
      await sleep(2000)
    }
    const negBeforeKill = pubCount()
    await app.hardKill()

    await app.boot('boot3')
    await sleep(3000)
    const negAfter = pubCount()
    const wfNeg = negDrive.id ? await getWorkflow(app.shell, negDrive.id) : null
    check('R3-NEG', '전송 전에 중단하면 서버 게시 0건(유령 게시 없음) — 부정 대조',
      negAfter === beforeNeg && negBeforeKill === beforeNeg,
      `서버 게시: 중단 전 ${beforeNeg} → 킬 직전 ${negBeforeKill} → 재시작 후 ${negAfter}(추가 ${negAfter - beforeNeg}건) `
      + `· 워크플로 stage=${wfNeg?.stage} publishUncertain=${wfNeg?.publishUncertain ?? false} ${negDetail}`)

    // ── ⑥ 읽기 전용 확인 4종 — 쓰기 차단 · 표지 없음 · 위조된 "게시됨" · "게시안됨" 자동 미해제 ──
    //
    // 확인 대상은 **부정 대조 워크플로**(negDrive, 캡션 "R3 전송 전 중단 캡션")다. 이유를 숨기지
    // 않고 적는다: ①에서 크래시로 게시 작업 기록 자체가 사라지면 제품은 그 작업의 세션(워크스페이스)을
    // 알 수 없어 확인 작업을 시작하지 않고 "직접 확인해 주세요"로 거절한다 — 그것이 설계상 옳은
    // 보수적 동작이라 여기서 우회하지 않는다. 대신 게시 작업이 살아 있는(불확실 상태인) 워크플로로
    // 같은 경로를 검증한다. negDrive 는 전송 전에 멈췄으므로(R3-NEG) **서버에 실제로 게시된 적이
    // 없다** — 이것이 "게시됨:" 표지가 위조인지 진짜인지 가르는 조건이다.
    if (negDrive.id) {
      control.holdPublish = false          // 확인용 페이지 조회는 정상 응답

      // R3-RO + R3-VER-UNMARKED — 표지 없는 결론: 쓰기(type/upload_file)는 차단되고, 완료로
      // 인정되지 않아 불확실이 유지되어야 한다.
      const beforeUnmarked = pubCount()
      const unmarked = await verifyWithRealCaption({
        app, llm, phase, routerLog, targetWfId: negDrive.id, pubCount,
        verifyResult: '아마 올라간 것 같기도 합니다(확실하지 않음).',
      })
      check('R3-RO', '읽기 전용 확인 작업 — 악성 지시대로 type/upload_file 을 시도해도 실제로는 차단된다(추가 게시 0)',
        !!(unmarked.ok && unmarked.triedWrites && unmarked.after === beforeUnmarked),
        `resolve응답=${J(unmarked.resp)} · type·upload_file 시도함=${unmarked.triedWrites} `
        + `· 서버 게시 ${beforeUnmarked} → ${unmarked.after}(추가 ${unmarked.after - beforeUnmarked}건, 기대 0)`)

      const unmarkedStaysUncertain = unmarked.wfAfter?.publishUncertain === true && unmarked.wfAfter?.stage !== 'done'
      check('R3-VER-UNMARKED', '표지("게시됨:"/"게시안됨:") 없는 결론은 완료로 인정하지 않는다 — 불확실 유지',
        !!(unmarked.settled && unmarkedStaysUncertain),
        `결론도달=${unmarked.settled} · stage=${unmarked.wfAfter?.stage} publishUncertain=${unmarked.wfAfter?.publishUncertain} `
        + `nextAction="${(unmarked.wfAfter?.recovery?.nextAction ?? '').slice(0, 90)}"`)

      // R3-VER-FORGED — 서버에 없는 캡션인데 "게시됨:" 표지만 있는 결론. 예전 결함은 이 표지 **한
      // 줄만** 보고 stage='done' 으로 확정했다 — 화면 근거(readSightings) 와 대조하는 지금은 근거가
      // 없으므로 완료로 확정되면 안 된다. 이게 이번 수정의 핵심 회귀 검사다.
      const beforeForged = pubCount()
      const forged = await verifyWithRealCaption({
        app, llm, phase, routerLog, targetWfId: negDrive.id, pubCount,
        verifyResult: '게시됨: 게시물 목록에서 같은 문구의 글을 확인했습니다.',
      })
      const forgedStaysUncertain = forged.wfAfter?.publishUncertain === true && forged.wfAfter?.stage !== 'done'
      const forgedStoppedAtOk = /근거를 찾지 못했/.test(forged.wfAfter?.recovery?.stoppedAt ?? '')
      const forgedNoSightings = !Array.isArray(forged.readSightings) || forged.readSightings.length === 0
      check('R3-VER-FORGED', '서버에 없는 캡션은 "게시됨:" 표지만으로 완료 확정되지 않는다(화면 근거와 대조) — 옛 결함의 회귀 검사',
        !!(forged.ok && forged.settled && forgedStaysUncertain && forgedStoppedAtOk && forged.after === beforeForged),
        `resolve응답=${J(forged.resp)} 결론도달=${forged.settled} · stage=${forged.wfAfter?.stage} publishUncertain=${forged.wfAfter?.publishUncertain} `
        + `· stoppedAt="${(forged.wfAfter?.recovery?.stoppedAt ?? '').slice(0, 110)}" `
        // 대조: R3-VER-POS 는 readSightings 가 채워져 완료로 확정됐다. 여기(위조된 표지)는 서버에
        // 캡션이 없으니 화면에서도 못 봤어야 한다 — 그 대비를 위해 비어 있음을 명시한다.
        + `· 확인작업이 실제로 본 근거(readSightings): ${summarizeSightings(forged.readSightings)}(비어있음=${forgedNoSightings}) `
        + `· 서버 게시 ${beforeForged} → ${forged.after}(추가 ${forged.after - beforeForged}건, 기대 0)`)

      // R3-VER-NOTPUB — "게시안됨:" 은 "안 보인다"가 "안 올라갔다"는 증명이 아니므로 자동으로
      // 차단을 풀지 않는다. 사람이 직접 "게시 안 됨"을 선택해야만 풀린다(양성 대조 포함 — 사람
      // 경로까지 막아버리지는 않았는지 확인).
      const wfBeforeNotpub = await getWorkflow(app.shell, negDrive.id)
      const negPubTaskId = wfBeforeNotpub?.taskIds?.publish ?? null
      const beforeNotpub = pubCount()
      const notpub = await verifyWithRealCaption({
        app, llm, phase, routerLog, targetWfId: negDrive.id, pubCount,
        verifyResult: '게시안됨: 최근 게시물 목록 상단까지 확인했습니다.',
      })
      const pubTaskAfterNotpub = negPubTaskId
        ? await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(negPubTaskId)})`, true).catch(() => null)
        : null
      const stillBlocked = !!(pubTaskAfterNotpub?.resumeBlockedReason ?? '').trim()
      const notpubStaysUncertain = notpub.wfAfter?.publishUncertain === true && notpub.wfAfter?.stage !== 'done'

      // 사람 경로 — 사용자가 화면을 직접 보고 "게시 안 됨"을 선택하면 차단이 풀려야 한다.
      const resolvedByUser = await evalIn(app.shell,
        `window.browserAPI.ai.socialResolvePublish(${J(negDrive.id)}, ${J('not-published')})`, true)
        .catch((e) => ({ ok: false, error: String(e) }))
      await sleep(800)
      const wfAfterUserResolve = await getWorkflow(app.shell, negDrive.id)
      const pubTaskAfterUserResolve = negPubTaskId
        ? await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(negPubTaskId)})`, true).catch(() => null)
        : null
      const unblockedByUser = !(pubTaskAfterUserResolve?.resumeBlockedReason ?? '').trim()
        && wfAfterUserResolve?.publishUncertain !== true
      const afterNotpubAll = pubCount()

      check('R3-VER-NOTPUB', '"게시안됨:" 은 자동으로 이어가기 차단을 풀지 않는다 — 사람이 "게시 안 됨"을 직접 선택해야 풀린다(양성 대조 포함)',
        !!(notpub.ok && notpub.settled && notpubStaysUncertain && stillBlocked
          && resolvedByUser?.ok && unblockedByUser && afterNotpubAll === beforeNotpub),
        `자동판정: resolve응답=${J(notpub.resp)} 결론도달=${notpub.settled} stage=${notpub.wfAfter?.stage} `
        + `publishUncertain=${notpub.wfAfter?.publishUncertain} 이어가기차단유지=${stillBlocked} `
        + `· 사람이 "게시 안 됨" 선택 응답=${J(resolvedByUser)} → 차단해제=${unblockedByUser}(publishUncertain=${wfAfterUserResolve?.publishUncertain}) `
        + `· 서버 게시 ${beforeNotpub} → ${afterNotpubAll}(추가 ${afterNotpubAll - beforeNotpub}건, 기대 0)`)
    } else {
      skip('R3-RO', '읽기 전용 확인 — 쓰기 차단', '부정 대조 워크플로가 만들어지지 않아 확인 경로를 시험할 대상이 없음')
      skip('R3-VER-UNMARKED', '표지 없는 결론은 불확실 유지', '부정 대조 워크플로가 만들어지지 않음')
      skip('R3-VER-FORGED', '위조된 "게시됨:" 표지는 완료 확정되지 않음', '부정 대조 워크플로가 만들어지지 않음')
      skip('R3-VER-NOTPUB', '"게시안됨:" 은 자동으로 차단을 풀지 않음', '부정 대조 워크플로가 만들어지지 않음')
    }


    // ── ⑦ 양성 대조: 정상 완료는 정확히 1건 + 완료 확정 ──────────────────────────────────
    control.holdPublish = false
    phase.stopBeforeShare = false
    const beforePos = pubCount()
    const router3 = makeR3Router(phase, routerLog)
    llm.setScript([router3.step])
    const posDrive = await driveToPublish(app, fixture, phase, 'R3 정상 완료 캡션')
    let wfPos = null
    let posOk = false
    if (!posDrive.error && posDrive.id) {
      posOk = await waitUntil(async () => {
        const wf = await getWorkflow(app.shell, posDrive.id)
        if (!wf) return false
        const pid = wf.taskIds?.publish
        if (pid) {
          const pt = await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(pid)})`, true).catch(() => null)
          await confirmIfWaiting(app.shell, pid, pt?.state)
        }
        return wf.stage === 'done' || wf.stage === 'failed' || wf.stage === 'cancelled'
      }, 120000, 1000)
      wfPos = await getWorkflow(app.shell, posDrive.id)
    }
    await sleep(1500)
    const afterPos = pubCount()
    check('R3-POS', '정상 완료는 정확히 1건 게시 + 완료 확정 — 양성 대조',
      !!(posOk && wfPos?.stage === 'done' && afterPos === beforePos + 1 && !wfPos?.publishUncertain),
      `서버 게시: ${beforePos} → ${afterPos}(추가 ${afterPos - beforePos}건, 기대 1) `
      + `· stage=${wfPos?.stage} receipt="${(wfPos?.receipt?.evidence ?? '').slice(0, 70)}" `
      + `· publishUncertain=${wfPos?.publishUncertain ?? false} ${posDrive.error ?? ''}`)

    fs.writeFileSync(path.join(args.out, 'r3-server-publishes.json'),
      J({ publishes: fixture.state.publishes, routerLog }, null, 2))
  } catch (err) {
    check('R3', '게시 중단 → 불확실 표시 + 중복 게시 0', false, `예외: ${err.message}\n${(err.stack ?? '').slice(0, 800)}`)
  } finally {
    await app.gracefulQuit()
    await ig.close().catch(() => {})
  }
}

// ===================================================================================
// R3-VER-INT — 게시 여부 확인 작업이 **도는 도중** 강제 종료
//
// ①②(크래시로 게시 불확실 확정)까지는 scenarioR3 와 똑같은 방식(응답 보류 + 강제 종료)으로
// 만든다 — 새로 지어낸 경로가 아니라 이미 검증된 흐름을 재사용한다. 그 뒤:
//   ② 게시 여부 확인(socialResolvePublish(...,'verify'))을 시작시키고, **실제로 running 인
//      순간**(존재하지 않는 셀렉터로 긴 wait_for 를 걸어 running 을 오래 유지시킨다) 강제 종료한다.
//   → 확인은 **읽기 전용**이므로 이 시나리오 전체에서 서버 게시가 늘어나면 그 자체가 버그다.
//
// 판정(전부 앱 밖 서버 게시 건수 + 워크플로 관측으로 교차 확인):
//   - 확인 작업이 도는 동안·강제 종료·재시작 어느 시점에도 서버 게시 0건 증가.
//   - 재시작 뒤 verifyTaskId 가 영원히 남지 않는다("🔎 확인하는 중…" 고착 회귀 검사) — 유예 뒤 풀린다.
//   - 불확실 표시(publishUncertain)는 유지되고, 확인 버튼을 다시 누르면(socialResolvePublish) ok —
//     고착이 아니라 재사용 가능하다(재호출이 결론에 도달하는 것까지 확인).
// ===================================================================================
async function scenarioR3VerInt({ llm, fixture }) {
  const control = { holdPublish: true }
  const ig = await startInstagramHttpsFixture(fixture.state, path.join(args.out, 'r3-verint-certs'), control)
    .catch((err) => { console.log('[igHttps] 기동 실패(R3-VER-INT):', err?.message ?? err); return null })
  if (!ig) {
    skip('R3-VER-INT', '게시 여부 확인 작업이 도는 도중 강제 종료',
      '격리 인터셉터(openssl 자체 서명 인증서)를 세우지 못해 실행하지 않음 — 실제 instagram.com 에 붙는 것보다 SKIP 이 안전하다.')
    return
  }
  console.log(`[R3-VER-INT 격리] ${REAL_DOMAIN_HOST} → 127.0.0.1:${ig.port} (실제 서비스 접속 0건)`)

  const routerLog = []
  const phase = { name: 'gen', caption: 'R3-VER-INT 캡션', verifyResult: '', stopBeforeShare: false, verifySlow: false }
  const router = makeR3Router(phase, routerLog)
  llm.setScript([router.step])

  const profileDir = path.join(args.out, 'r3-verint-profile')
  const downloadsDir = path.join(args.out, 'r3-verint-downloads')
  writeProfileSettings(profileDir, llm.url, downloadsDir)
  const app = makeAppController(profileDir, 'r3verint', [
    `--host-resolver-rules=${ig.hostResolverRule}`,
    '--ignore-certificate-errors',   // 격리 인터셉터의 자체 서명 인증서용(이 검증 실행 한정)
  ])

  const pubCount = () => fixture.state.publishes.length
  const base0 = pubCount()

  try {
    // ── ① 게시 요청이 서버에 실제로 저장된 순간까지 몰고 간 뒤 강제 종료해 불확실 상태를 만든다 ──
    await app.boot('boot1')
    const drive = await driveToPublish(app, fixture, phase, 'R3-VER-INT 캡션')
    if (drive.error || !drive.id) {
      check('R3-VER-INT', '게시 여부 확인 작업이 도는 도중 강제 종료', false,
        `불확실 상태를 만들지 못함: ${drive.error} · 라우터 분기 실패: ${routerLog.slice(0, 2).join(' | ')}`)
      return
    }
    const wfId = drive.id

    const sent = await waitUntil(() => pubCount() >= base0 + 1, 90000, 1000)
    if (!sent) {
      check('R3-VER-INT', '게시 여부 확인 작업이 도는 도중 강제 종료', false,
        `게시 요청이 서버에 도달하지 않음 · 라우터 분기 실패: ${routerLog.slice(0, 3).join(' | ')}`)
      return
    }
    await sleep(1200)
    await app.hardKill()

    await app.boot('boot2')
    const uncertainReached = await waitUntil(async () => {
      const wf = await getWorkflow(app.shell, wfId)
      return !!wf?.publishUncertain
    }, 30000)
    const wfUncertain = await getWorkflow(app.shell, wfId)
    if (!uncertainReached) {
      check('R3-VER-INT', '게시 여부 확인 작업이 도는 도중 강제 종료', false,
        `강제 종료 뒤 불확실 상태 확정 실패(마지막 관측: ${J(wfUncertain)})`)
      return
    }

    // ── ② 게시 여부 확인 작업을 시작시키고, 실제로 running 인 순간 강제 종료 ─────────────────
    const beforeVerify = pubCount()
    phase.name = 'verify'
    phase.verifySlow = true   // 첫 verify 스텝이 존재하지 않는 셀렉터로 긴 wait_for 를 낸다 → running 유지
    phase.verifyResult = '게시됨: 게시물 목록에서 같은 문구의 글을 확인했습니다.'
    const routerV = makeR3Router(phase, routerLog)
    llm.setScript([routerV.step])
    const resolveResp = await evalIn(app.shell,
      `window.browserAPI.ai.socialResolvePublish(${J(wfId)}, ${J('verify')})`, true)
      .catch((e) => ({ ok: false, error: String(e) }))
    if (!resolveResp?.ok) {
      check('R3-VER-INT', '게시 여부 확인 작업이 도는 도중 강제 종료', false,
        `확인 작업을 시작시키지 못함: ${J(resolveResp)}`)
      return
    }

    let verifyTaskId = null
    const vAppeared = await waitUntil(async () => {
      const wf = await getWorkflow(app.shell, wfId)
      if (wf?.verifyTaskId) { verifyTaskId = wf.verifyTaskId; return true }
      return false
    }, 30000, 300)
    if (!vAppeared) {
      check('R3-VER-INT', '게시 여부 확인 작업이 도는 도중 강제 종료', false,
        `확인 작업이 생성되지 않음(resolve 응답=${J(resolveResp)})`)
      return
    }

    const running = await waitUntil(async () => {
      const t = await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(verifyTaskId)})`, true).catch(() => null)
      return t?.state === 'running'
    }, 30000, 300)
    if (!running) {
      const vDbg = await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(verifyTaskId)})`, true).catch(() => null)
      check('R3-VER-INT', '게시 여부 확인 작업이 도는 도중 강제 종료', false,
        `확인 작업이 running 상태에 도달하지 못함(verifyTaskId=${String(verifyTaskId).slice(0, 8)} 마지막상태=${vDbg?.state})`)
      return
    }
    // json-store 는 400ms 디바운스로 쓴다 — 강제 종료 전 'running' 이 디스크에 실제로 반영될 시간을 준다.
    await sleep(1500)
    console.log(`  · 확인 작업 ${verifyTaskId.slice(0, 8)} 가 running 상태 — 강제 종료`)
    await app.hardKill()

    // ── ③ 재부팅 — verifyTaskId 가 영원히 남지 않고, 불확실 표시는 유지되며, 확인을 다시 누를 수 있다 ──
    await app.boot('boot3')

    // ⚠ VERIFY_MISSING_GRACE_MS(=30s, social-workflow.ts)를 고려해 넉넉히 기다린다. 확인 작업이
    //   task-runtime 의 재시작 규칙으로 곧바로 'interrupted' 로 복원되면(진짜 있었던 작업이 끊긴
    //   경우) reconcileVerifyTask 가 **유예 없이 즉시** 자리를 놓아주지만, 혹시 그 기록조차 못 찾는
    //   경로(저장 유실)를 타면 "못 찾음" 유예만큼 걸릴 수 있다 — 회귀 검사이므로 둘 다 통과로 받는다.
    const released = await waitUntil(async () => {
      const wf = await getWorkflow(app.shell, wfId)
      return !!wf && !wf.verifyTaskId
    }, 45000, 500)
    const wfAfterKill = await getWorkflow(app.shell, wfId)
    const afterVerifyKill = pubCount()

    const stayedUncertain = wfAfterKill?.publishUncertain === true
    const noExtraDuringVerify = afterVerifyKill === beforeVerify

    // ── ④ 확인 버튼을 다시 누를 수 있다 — 고착이 아니다(재호출이 실제로 결론에 도달하는 것까지 확인) ──
    phase.verifySlow = false
    phase.verifyResult = '읽어봤지만 확실한 근거를 찾지 못했습니다.'
    const routerRetry = makeR3Router(phase, routerLog)
    llm.setScript([routerRetry.step])
    const retryResp = await evalIn(app.shell,
      `window.browserAPI.ai.socialResolvePublish(${J(wfId)}, ${J('verify')})`, true)
      .catch((e) => ({ ok: false, error: String(e) }))
    const retryOk = retryResp?.ok === true

    const retrySettled = retryOk
      ? await waitUntil(async () => {
          const wf = await getWorkflow(app.shell, wfId)
          return !!wf && !wf.verifyTaskId
        }, 60000, 800)
      : false

    const finalCount = pubCount()

    check('R3-VER-INT', '게시 여부 확인 작업이 도는 도중 강제 종료 → 고착 없이 회복 + 추가 게시 0',
      !!(released && stayedUncertain && noExtraDuringVerify && retryOk && retrySettled && finalCount === beforeVerify),
      `서버 게시(읽기전용이라 전부 동일해야 함): 확인 시작 전 ${beforeVerify} → 킬 직후 ${afterVerifyKill} → 재확인 뒤 ${finalCount} `
      + `· verifyTaskId 해제(고착 없음)=${released}(킬 재부팅 직후 관측: ${J(wfAfterKill?.verifyTaskId ?? null)}) `
      + `· 불확실 유지=${stayedUncertain}(publishUncertain=${wfAfterKill?.publishUncertain}) `
      + `· 재확인 응답=${J(retryResp)}(ok=${retryOk}) 재확인 결론도달=${retrySettled} `
      + `· recovery.kind=${wfAfterKill?.recovery?.kind ?? '(없음)'} nextAction="${(wfAfterKill?.recovery?.nextAction ?? '').slice(0, 100)}"`)
  } catch (err) {
    check('R3-VER-INT', '게시 여부 확인 작업이 도는 도중 강제 종료', false, `예외: ${err.message}\n${(err.stack ?? '').slice(0, 800)}`)
  } finally {
    await app.gracefulQuit()
    await ig.close().catch(() => {})
  }
}

// ===================================================================================
// R3-STORE-TASKS / R3-STORE-SOCIAL — 실제 앱 워크플로에 저장 실패를 주입
//
// 기존 P1~P6(verify-persistence-boundary.mjs)는 JsonStore 를 단독으로만 시험한다. 여기서는
// **실제 앱**에서 review 도달 직후·승인(게시 시작) 직전에 대상 파일을 디렉터리로 바꿔 저장을 막고,
// 실제 socialApprove 경로가 그 실패를 만나 게시를 내보내지 않는지를 본다(driveToPublish 의
// beforeApprove 훅을 씀 — 기존 호출부 동작은 그대로다).
//
// 게시 작업은 이제 **태어날 때부터 차단**돼(createTask blockedReason=PUBLISH_PENDING_BLOCK) 내구성
// 경계(persistPublishBoundary, 두 저장소 동기 flush)를 통과한 뒤에만 풀린다 — 즉 디스크에 남는 모든
// 판본의 게시 작업은 이미 막혀 있다. "시작/재개로 우회할 수 없다" 축은 이 빗장을 직접 확인한다.
//
// 판정(전부 서버 게시 건수 + ptaskStart/ptaskResume 실제 응답으로 교차 확인):
//   - 저장이 막힌 동안 서버 게시 0건(가장 중요한 축).
//   - 재시작 전·후 모두, 남은 게시 작업이 있으면 ptaskStart/ptaskResume 가 거부된다(있으면 그 오류
//     문구를 그대로 남긴다). 남은 작업이 없으면 "우회할 대상 자체가 없다"도 합격(명시적으로 기록).
//   - 막아 둔 파일을 지우고 사용자가 하듯 다시 승인/시작하면 서버 게시가 **정확히 1건** 늘어난다.
//
// ⚠ 원 워크플로가 재시작을 못 넘길 수 있다(대상 파일이 통째로 디렉터리→자동 격리되며 그 저장소가
//   빈 채로 다시 시작될 수 있다 — injectStorageFailure 주석 참고). 그 경우 "복구 후 재시도"는 같은
//   워크플로를 잇는 대신 **새 워크플로**로 진행한다(사용자가 실제로 하는 것과 같다) — 이 사실을
//   숨기지 않고 detail 의 retrySource 에 그대로 남긴다.
// ===================================================================================
async function scenarioR3Store({ llm, fixture, fileName, id, humanLabel }) {
  const control = { holdPublish: true }
  const slug = fileName.replace(/\W+/g, '-')
  const ig = await startInstagramHttpsFixture(fixture.state, path.join(args.out, `r3-store-${slug}-certs`), control)
    .catch((err) => { console.log(`[igHttps] 기동 실패(${id}):`, err?.message ?? err); return null })
  if (!ig) {
    skip(id, `저장 실패(${humanLabel}) 주입 시 게시가 나가지 않는다`,
      '격리 인터셉터를 세우지 못해 실행하지 않음 — 실제 instagram.com 에 붙는 것보다 SKIP 이 안전하다.')
    return
  }
  console.log(`[${id} 격리] ${REAL_DOMAIN_HOST} → 127.0.0.1:${ig.port} (실제 서비스 접속 0건)`)

  const routerLog = []
  const phase = { name: 'gen', caption: `${id} 캡션`, verifyResult: '', stopBeforeShare: false, verifySlow: false }

  const profileDir = path.join(args.out, `r3-store-${slug}-profile`)
  const downloadsDir = path.join(args.out, `r3-store-${slug}-downloads`)
  writeProfileSettings(profileDir, llm.url, downloadsDir)
  const app = makeAppController(profileDir, `r3store-${slug}`, [
    `--host-resolver-rules=${ig.hostResolverRule}`,
    '--ignore-certificate-errors',
  ])

  const pubCount = () => fixture.state.publishes.length
  const base0 = pubCount()

  try {
    await app.boot('boot1')

    let injectedAt = 0
    const router = makeR3Router(phase, routerLog)
    llm.setScript([router.step])
    const drive = await driveToPublish(app, fixture, phase, `${id} 캡션`, {
      beforeApprove: async () => {
        // review 도달 직후 · 승인(게시 시작) 직전 — 되돌릴 수 없는 외부 쓰기가 시작되기 전에 저장을 막는다.
        injectStorageFailure(profileDir, fileName)
        injectedAt = Date.now()
        await sleep(150)   // 디렉터리 생성이 파일시스템에 반영될 짧은 여유
      },
    })
    if (drive.error || !drive.id) {
      check(id, `저장 실패(${humanLabel}) 주입 시 게시가 나가지 않는다`, false,
        `review→승인 흐름 실패: ${drive.error} · 라우터 분기 실패: ${routerLog.slice(0, 3).join(' | ')}`)
      return
    }
    const wfId = drive.id
    console.log(`  · 승인 직전 ${fileName} 을 디렉터리로 막음(주입 시각 ${new Date(injectedAt).toISOString()})`)

    // ── 승인 직후: 저장 실패로 물러나는지(review 로 복귀 + recovery.kind 로 원인 남김) 기다린다 ────
    // recovery.kind==='publish-storage-failed' 는 abortPublishBeforeStart 가 이 실패 경로에서만
    // 세우는 값이라, "아직 시작도 안 함"과 "저장 실패로 물러남"을 확실히 구분한다.
    await waitUntil(async () => {
      const wf = await getWorkflow(app.shell, wfId)
      return !!wf && (wf.recovery?.kind === 'publish-storage-failed' || wf.stage === 'done' || wf.stage === 'failed')
    }, 60000, 600)
    const wfAfterApprove = await getWorkflow(app.shell, wfId)
    const pubTaskIdSeen = wfAfterApprove?.taskIds?.publish ?? null

    await sleep(1000)
    const afterApprove = pubCount()

    // ── 이어가기 우회 시도(재시작 전) — 남은 게시 작업이 있으면 직접 시작/재개를 시도해 거부되는지 본다 ──
    let bypassBefore = { attempted: false, taskId: null, startOk: null, resumeOk: null, startErr: '', resumeErr: '' }
    if (pubTaskIdSeen) {
      const startRes = await evalIn(app.shell, `window.browserAPI.ai.ptaskStart(${J(pubTaskIdSeen)})`, true)
        .catch((e) => ({ ok: false, error: String(e) }))
      const resumeRes = await evalIn(app.shell, `window.browserAPI.ai.ptaskResume(${J(pubTaskIdSeen)})`, true)
        .catch((e) => ({ ok: false, error: String(e) }))
      bypassBefore = {
        attempted: true, taskId: pubTaskIdSeen,
        startOk: startRes?.ok === true, resumeOk: resumeRes?.ok === true,
        startErr: startRes?.error ?? '', resumeErr: resumeRes?.error ?? '',
      }
      await sleep(1500)
    }
    const afterBypassBefore = pubCount()

    const stillInjectedBeforeKill = isStorageFailureActive(profileDir, fileName)
    await app.hardKill()

    // ── 재부팅 — 부팅 초기화가 디렉터리(=읽을 수 없는 파일)를 스스로 격리(quarantine, 이름만 바꿔
    //    옮김)할 수 있다는 것을 알고 시험한다. 디렉터리 rename 은 파일→디렉터리 rename 과 달리
    //    **성공**하므로, 우리가 건 막힘이 부팅 한 번에 저절로 풀릴 수 있다(정상 자기복구 — 제품
    //    결함 아님). "재시작 뒤에도 저장이 계속 막혀 있다" 를 실제로 시험하려면, 격리 여부를 먼저
    //    확인한 뒤 **즉시 다시 막는다**(앱 밖 fs 조작이라 부팅 여부와 무관하게 바로 반영된다).
    await app.boot('boot2')
    await sleep(1500)   // initAi → initTaskRuntime/initSocialWorkflows 가 격리를 마칠 시간을 준다.
    const quarantinedAtBoot = wasQuarantined(profileDir, fileName) && !isStorageFailureActive(profileDir, fileName)
    injectStorageFailure(profileDir, fileName)   // 재주입 — 재시작 뒤에도 계속 막힌 상태를 만든다.
    await sleep(300)
    const stillInjectedAfterBoot = isStorageFailureActive(profileDir, fileName)   // 재주입 후(기대: true)
    const wfAfterBoot = await getWorkflow(app.shell, wfId).catch(() => null)
    const afterBoot = pubCount()

    let bypassAfter = { attempted: false, taskId: null, startOk: null, resumeOk: null, startErr: '', resumeErr: '' }
    const candidateId = wfAfterBoot?.taskIds?.publish ?? pubTaskIdSeen
    if (candidateId) {
      const startRes2 = await evalIn(app.shell, `window.browserAPI.ai.ptaskStart(${J(candidateId)})`, true)
        .catch((e) => ({ ok: false, error: String(e) }))
      const resumeRes2 = await evalIn(app.shell, `window.browserAPI.ai.ptaskResume(${J(candidateId)})`, true)
        .catch((e) => ({ ok: false, error: String(e) }))
      bypassAfter = {
        attempted: true, taskId: candidateId,
        startOk: startRes2?.ok === true, resumeOk: resumeRes2?.ok === true,
        startErr: startRes2?.error ?? '', resumeErr: resumeRes2?.error ?? '',
      }
      await sleep(1500)
    }
    const afterBypassAfter = pubCount()

    // ── 저장을 복구하고 명시 재시도 — 정확히 1건 늘어야 한다 ─────────────────────────────────
    clearStorageFailure(profileDir, fileName)
    const clearedNow = !isStorageFailureActive(profileDir, fileName)

    const beforeRetry = pubCount()
    control.holdPublish = false   // 실제 게시가 나가야 하는 마지막 단계 — 정상 응답으로

    // 원 워크플로를 이어갈 수 있으려면 ① 그 워크플로 레코드 자체가 살아 있고 ② 그것이 참조하는
    // 생성 작업(genTaskId) 도 살아 있어야 한다(ai-tasks.json 주입 시나리오는 그 파일 전체가 자동
    // 격리로 비워지면서, 승인 이전에 이미 성공적으로 저장돼 있던 생성 작업 기록까지 함께 잃을 수
    // 있다 — 그러면 approveAndPublish 가 "가져올 산출물이 없습니다" 로 실패한다. 이건 제품 결함이
    // 아니라 내 주입 방식의 collateral damage 이므로, 재사용이 불가능하면 정직하게 새로 만든다).
    const wfNow = await getWorkflow(app.shell, wfId).catch(() => null)
    let genTaskAlive = false
    if (wfNow?.taskIds?.generate) {
      const gt = await evalIn(app.shell, `window.browserAPI.ai.ptaskGet(${J(wfNow.taskIds.generate)})`, true).catch(() => null)
      genTaskAlive = !!gt
    }

    let retrySource = ''
    let retryWfId = wfId
    let retryResp = null
    if (wfNow && wfNow.stage === 'review' && genTaskAlive) {
      retrySource = `기존 워크플로 재승인(wfId=${wfId})`
      phase.name = 'publish'
      phase.verifySlow = false
      const routerRetry = makeR3Router(phase, routerLog)
      llm.setScript([routerRetry.step])
      retryResp = await evalIn(app.shell,
        `window.browserAPI.ai.socialApprove(${J(wfId)}, ${J(phase.caption)})`, true)
        .catch((e) => ({ ok: false, error: String(e) }))
    } else {
      retrySource = `원 워크플로/생성 작업 소실(stage=${wfNow?.stage ?? '(없음)'} genTaskAlive=${genTaskAlive}) → 새 워크플로로 재시도`
      // ⚠ 반드시 **새 라우터**(st 카운터가 0부터 시작)를 걸어야 한다 — 맨 위에서 만든 router 를 그대로
      //   재사용하면, 그 st.genStep 이 이미 첫 시도(실패로 끝난 생성 작업)에서 다 써 버린 값이라
      //   새로 만드는 생성 작업이 mark_baseline/클릭/capture_image 를 한 번도 못 밟고 즉시 done 으로
      //   빠진다(산출물 0개 → "생성물을 가져오지 못했습니다") — 실제로 처음 겪은 것이 바로 이 하네스
      //   버그였다(제품 결함 아님).
      const routerFresh = makeR3Router(phase, routerLog)
      llm.setScript([routerFresh.step])
      const retryDrive = await driveToPublish(app, fixture, phase, `${id} 복구 후 재시도 캡션`)
      if (retryDrive.error || !retryDrive.id) {
        retryResp = { ok: false, error: retryDrive.error }
      } else {
        retryWfId = retryDrive.id
        retryResp = { ok: true }   // driveToPublish 가 성공 시 이미 approve 까지 호출했다.
      }
    }

    const retryDone = await waitUntil(async () => {
      const wf = await getWorkflow(app.shell, retryWfId)
      return !!wf && (wf.stage === 'done' || wf.stage === 'failed' || wf.stage === 'cancelled')
    }, 120000, 1000)
    const wfAfterRetry = await getWorkflow(app.shell, retryWfId)
    await sleep(1000)
    const afterRetry = pubCount()

    fs.writeFileSync(path.join(args.out, `${id.toLowerCase()}.json`), J({
      fileName, injectedAt, afterApprove: { stage: wfAfterApprove?.stage, recovery: wfAfterApprove?.recovery, taskIdsPublish: wfAfterApprove?.taskIds?.publish ?? null },
      bypassBefore, bypassAfter, stillInjectedBeforeKill, quarantinedAtBoot, stillInjectedAfterBoot,
      retrySource, retryResp, wfAfterRetry: wfAfterRetry && { stage: wfAfterRetry.stage, receipt: wfAfterRetry.receipt },
      counts: { base0, afterApprove, afterBypassBefore, afterBoot, afterBypassAfter, beforeRetry, afterRetry },
    }, null, 2))

    const noWriteDuringFailure = afterApprove === base0 && afterBypassBefore === base0
      && afterBoot === base0 && afterBypassAfter === base0
    const revertedProperly = wfAfterApprove?.stage === 'review' && !wfAfterApprove?.taskIds?.publish
    const bypassRejectedBefore = !bypassBefore.attempted || (bypassBefore.startOk === false && bypassBefore.resumeOk === false)
    const bypassRejectedAfter = !bypassAfter.attempted || (bypassAfter.startOk === false && bypassAfter.resumeOk === false)
    // 재부팅 뒤에는 우리가 다시 막았으므로(위 재주입) stillInjectedAfterBoot 는 항상 true 여야 한다 —
    // 이게 false 라면 "재시작 뒤에도 계속 막혀 있다" 는 이 축의 전제 자체가 깨진 것이다.
    const reinjectionHeld = stillInjectedAfterBoot === true
    const retryGivesExactlyOne = retryDone && (afterRetry === beforeRetry + 1) && wfAfterRetry?.stage === 'done'

    check(id, `저장 실패(${humanLabel}) 주입 시 게시가 나가지 않고, 복구 후 재시도는 정확히 1건 게시`,
      !!(noWriteDuringFailure && revertedProperly && bypassRejectedBefore && bypassRejectedAfter
        && reinjectionHeld && clearedNow && retryGivesExactlyOne),
      `대상파일=${fileName} · 서버 게시: 시작 ${base0} → 승인직후 ${afterApprove} → 우회시도(재시작전) ${afterBypassBefore} `
      + `→ 재부팅후 ${afterBoot} → 우회시도(재시작후) ${afterBypassAfter}(전부 ${base0} 유지 기대, 저장실패 축) `
      + `· 승인 직후 stage=${wfAfterApprove?.stage} taskIds.publish=${wfAfterApprove?.taskIds?.publish ?? '(없음)'} `
      + `recovery.kind=${wfAfterApprove?.recovery?.kind ?? '(없음)'} `
      + `· 우회(재시작전) 시도함=${bypassBefore.attempted} start=${bypassBefore.startOk}(${bypassBefore.startErr}) `
      + `resume=${bypassBefore.resumeOk}(${bypassBefore.resumeErr}) `
      + `· 우회(재시작후, 재주입 뒤=계속 막힌 상태에서 시도) 시도함=${bypassAfter.attempted} `
      + `start=${bypassAfter.startOk}(${bypassAfter.startErr}) resume=${bypassAfter.resumeOk}(${bypassAfter.resumeErr}) `
      + `· 킬 직전 주입활성=${stillInjectedBeforeKill} `
      + `· 재부팅 시 격리(quarantine, 디렉터리→.corrupt-*.bak 이름바꾸기)로 저절로 풀렸는가=${quarantinedAtBoot}`
      + `(디렉터리 rename 은 성공해 자동 복구될 수 있다 — 정상 설계, 제품 결함 아님) → 즉시 재주입하여 `
      + `"재시작 뒤에도 계속 막힘"을 실제로 시험함(재주입 후 주입활성=${stillInjectedAfterBoot}) `
      + `· 복구경로=${retrySource} 재시도응답=${J(retryResp)} 재시도결론도달=${retryDone} `
      + `· 재시도 서버 게시(복구축): ${beforeRetry} → ${afterRetry}(추가 ${afterRetry - beforeRetry}건, 기대 정확히 1) `
      + `· 최종 stage=${wfAfterRetry?.stage} receipt="${(wfAfterRetry?.receipt?.evidence ?? '').slice(0, 90)}" `
      + `· 상세: ${id.toLowerCase()}.json`)
  } catch (err) {
    check(id, `저장 실패(${humanLabel}) 주입 시 게시가 나가지 않는다`, false, `예외: ${err.message}\n${(err.stack ?? '').slice(0, 800)}`)
  } finally {
    await app.gracefulQuit()
    await ig.close().catch(() => {})
  }
}

main().catch((e) => { console.error(e); process.exit(2) })
