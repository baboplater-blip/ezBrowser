#!/usr/bin/env node
// verify-social-pipeline-cdp.mjs — 생성물 파이프라인(이미지 생성→가져오기→업로드) + 블로그 인게이지먼트 e2e.
//
// 패턴은 build/verify-agent-loop-cdp.mjs 를 그대로 따른다: 가짜 LLM 각본으로 에이전트를 결정론적으로
// 몬 뒤, 앱이 실제로 만든 파일·상태를 검사한다. LLM 은 없고, 로컬 픽스처(social-fixture-server.mjs)만 있다.
//
// 실행 경로 — 패키징 exe(dist/win-unpacked) 를 쓰지 않는다. 다른 작업자가 app/renderer 를 편집 중이라
// 전체 빌드/재패키징이 위험하다는 지시(2026-09-18)에 따라, 이미 최신인 app/dist/main 을 electron.exe 로
// 직접 띄운다(개발 모드 env 변수를 안 주면 프로덕션처럼 app/dist/renderer 를 file:// 로 로드한다 — 부팅
// 프로브로 확인됨). 렌더러가 변경 중이어도 이 검증은 shell 컨텍스트에서 window.browserAPI 를 직접
// 호출하므로(AiTab UI 를 그리지 않는다) 영향받지 않는다.
//
// 시나리오 — A(생성물 파이프라인), C(블로그 인게이지먼트). 상세는 각 블록 주석.
//
// 사용: node build/verify-social-pipeline-cdp.mjs [--port <n>] [--out <dir>]

import { spawn, execFileSync } from 'node:child_process'
import Module from 'node:module'
import { createRequire } from 'node:module'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, getTargetList, waitForPortFree, connectShellSessionReady, ensureSessionReady } from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'
import { startSocialFixtures } from './social-fixture-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const ELECTRON_BIN = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN_ENTRY = path.join(REPO, 'app', 'dist', 'main', 'index.js')

const args = { port: 9268, out: path.join(REPO, 'verify-out', 'social-pipeline') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const results = []
const findings = []   // 제품에서 발견한 결함(고치지 않고 보고)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} PASS/FAIL=${ok} — ${name}: ${detail}`)
}
function skip(id, name, reason) {
  results.push({ id, name, status: 'SKIP', detail: reason })
  console.log(`  ⋯ ${id} SKIP — ${name}: ${reason}`)
}
function finding(where, text) {
  findings.push({ where, text })
  console.log(`  ⚠ FINDING [${where}] ${text}`)
}

const evalIn = async (s, expression, awaitPromise = false) => {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.result?.exceptionDetails) {
    throw new Error(`evalIn 예외: ${JSON.stringify(r.result.exceptionDetails).slice(0, 400)}`)
  }
  return r.result?.result?.value ?? r.result?.value
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

// ===== C7: 순수 함수 검사(앱 없이) — Electron 을 흉내내지 않고 'electron' require 를 스텁으로 가로챈다 =====
function runC7PureLedgerTests() {
  const tmpUserData = path.join(args.out, 'c7-userdata')
  fs.rmSync(tmpUserData, { recursive: true, force: true })
  fs.mkdirSync(tmpUserData, { recursive: true })

  const req = createRequire(import.meta.url)
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: (name) => (name === 'userData' ? tmpUserData : tmpUserData) } }
    return origLoad.apply(this, arguments)
  }
  // 모듈 캐시에 이미 있으면(다른 하네스가 앞서 같은 프로세스에서 require 했으면) 재사용되어 스텁이 안 먹는다 —
  // 이 harness 는 단독 실행이므로 최초 require 이지만, 안전하게 캐시를 지운다.
  const modPath = path.join(REPO, 'app', 'dist', 'main', 'features', 'ai', 'blog-engage.js')
  delete req.cache?.[modPath]
  let mod
  try {
    mod = req(modPath)
  } finally {
    Module._load = origLoad
  }
  const { normalizeTargetUrl, alreadyDid, recordEngagement, initEngageLedger, listEngagements } = mod
  initEngageLedger()

  // --- normalizeTargetUrl ---
  const cases = [
    ['https://Blog.Naver.com/abc/123?a=1&utm_source=x', 'https://blog.naver.com/abc/123?a=1'],
    ['http://www.example.com:80/path/', 'https://example.com/path'],
    ['https://example.com/p?utm_campaign=x&z=2&a=1', 'https://example.com/p?a=1&z=2'],  // 쿼리 키 정렬 + utm 제거
    ['https://example.com/x#frag', 'https://example.com/x'],
  ]
  let normOk = true
  const normDetails = []
  for (const [input, expected] of cases) {
    const got = normalizeTargetUrl(input)
    const ok = got === expected
    if (!ok) normOk = false
    normDetails.push(`${ok ? 'OK' : 'MISMATCH'}: ${input} → ${got} (기대 ${expected})`)
  }
  check('C7a', 'normalizeTargetUrl 이 스킴·www·기본포트·해시·utm 을 정규화한다', normOk, normDetails.join(' | '))

  // --- alreadyDid / recordEngagement dedup ---
  const key = normalizeTargetUrl('https://blog.naver.com/foo/1?utm_source=x')
  const before = alreadyDid(key, 'acct1', 'comment')
  recordEngagement({ key, account: 'acct1', action: 'comment', note: '첫 댓글' })
  const afterFirst = alreadyDid(key, 'acct1', 'comment')
  const afterFirstOtherAccount = alreadyDid(key, 'acct2', 'comment') // 다른 계정은 별도
  const afterFirstOtherAction = alreadyDid(key, 'acct1', 'like')     // 다른 행동은 별도
  recordEngagement({ key, account: 'acct1', action: 'comment', note: '두번째 시도(무시되어야)' })
  const listAfterDup = listEngagements(100).filter((e) => e.key === key && e.account === 'acct1' && e.action === 'comment')
  check('C7b', 'alreadyDid/recordEngagement 이 (key,account,action) 단위로 중복을 막고 최초 기록을 보존한다',
    before === false && afterFirst === true && afterFirstOtherAccount === false && afterFirstOtherAction === false
    && listAfterDup.length === 1 && listAfterDup[0].note === '첫 댓글',
    `이전=${before}(false여야) 이후=${afterFirst}(true여야) 다른계정=${afterFirstOtherAccount}(false여야) `
    + `다른행동=${afterFirstOtherAction}(false여야) 저장건수=${listAfterDup.length}(1이어야) 보존된note="${listAfterDup[0]?.note}"`)

  fs.rmSync(tmpUserData, { recursive: true, force: true })
}

// ===== 픽스처 페이지 안에서 다운로드 이미지를 직접 fetch 해 sha256 비교(A7 검증용) =====
async function fetchBytes(url, headers) {
  const r = await fetch(url, { headers })
  const buf = Buffer.from(await r.arrayBuffer())
  return { status: r.status, buf }
}

// agent-gate.js 는 electron 등 외부 의존이 없다(확인됨) — 바로 require 해서 실제 표식을 만든다.
const { buildEngageMark } = createRequire(import.meta.url)(
  path.join(REPO, 'app', 'dist', 'main', 'features', 'ai', 'agent-gate.js'))

async function main() {
  if (!fs.existsSync(ELECTRON_BIN)) throw new Error(`electron 바이너리 없음: ${ELECTRON_BIN}`)
  if (!fs.existsSync(MAIN_ENTRY)) throw new Error(`빌드 산출물 없음(npm run build:main 필요): ${MAIN_ENTRY}`)
  fs.mkdirSync(args.out, { recursive: true })

  // C7 은 앱을 안 띄우니 먼저 실행 — 이후 실패해도 이 결과는 남는다.
  try { runC7PureLedgerTests() } catch (e) { check('C7', 'pure ledger', false, `예외: ${e.message}`) }

  args.port = await preferFreePort(args.port, 'verify-social-pipeline-cdp.mjs')
  await waitForPortFree(args.port)
  const [llmPort] = await getFreePorts(1)

  const llm = await startFakeLlm({ port: llmPort })
  const fixture = await startSocialFixtures()

  const downloadsDir = path.join(args.out, 'downloads')
  fs.rmSync(downloadsDir, { recursive: true, force: true })
  fs.mkdirSync(downloadsDir, { recursive: true })

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true },
    startup: { mode: 'newtab', urls: [] },
    adblock: { enabled: false },
    downloads: { defaultPath: downloadsDir, askEveryTime: false },
    ai: {
      enabled: true,
      provider: 'ollama',
      ollamaUrl: llm.url,
      ollamaModel: 'test-model',
      agentMaxSteps: 30,
      agentAutoApprove: false,
      agentVision: 'off',
      agentHumanInput: false,
    },
  }, null, 2))

  const logStream = fs.createWriteStream(path.join(args.out, 'app.log'))
  const child = spawn(ELECTRON_BIN, [MAIN_ENTRY, `--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')

    async function newTab(url) {
      return evalIn(shell,
        `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(url)}).then(t => t.id)`, true)
    }
    await evalIn(shell, 'window.__ev = []; window.browserAPI.ai.onAgentEvent((e) => window.__ev.push(e)); true')

    /** 지정 bucket(=taskId, 보통 "session-<reqId>")의 산출물 메타 목록을 IPC 로 가져온다(디스크 realpath 검증은 앱이 이미 함). */
    async function listArtifactsFor(bucket) {
      const raw = await evalIn(shell, `window.browserAPI.ai.artifactList(${JSON.stringify(bucket)})`, true)
      return JSON.parse(JSON.stringify(raw ?? []))
    }

    /** 한 시나리오 실행: 각본을 걸고 에이전트를 돌린 뒤 이벤트를 모은다. */
    async function run({ script, reqId, task, tabId, timeoutMs = 45000 }) {
      llm.setScript(script)
      await evalIn(shell, 'window.__ev = []; true')
      const startArgs = { reqId, tabId, task }
      await evalIn(shell, `window.browserAPI.ai.agentStart(${JSON.stringify(startArgs)})`, true)
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const evs = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ev)') ?? '[]')
        if (evs.some((e) => e.type === 'done' || e.type === 'error' || e.type === 'cancelled')) break
        await sleep(300)
      }
      const evs = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ev)') ?? '[]')
      return { evs, types: evs.map((e) => e.type) }
    }

    /** 취소 타이밍 제어가 필요한 시나리오(A10)용 — verify-agent-loop-cdp.mjs 의 startControlled 와 동형. */
    async function startControlled({ reqId, task, script, tabId, timeoutMs = 30000 }) {
      llm.setScript(script)
      await evalIn(shell, 'window.__ev = []; true')
      await evalIn(shell, `window.browserAPI.ai.agentStart(${JSON.stringify({ reqId, tabId, task })})`, true)
      const isTerminal = (evs) => evs.some((e) => e.type === 'done' || e.type === 'error' || e.type === 'cancelled')
      return {
        async events() { return JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ev)') ?? '[]') },
        async waitUntil(predicate, ms = timeoutMs) {
          const dl = Date.now() + ms
          let evs = await this.events()
          while (Date.now() < dl && !predicate(evs)) { await sleep(30); evs = await this.events() }
          return evs
        },
        async waitTerminal(ms = timeoutMs) { return this.waitUntil(isTerminal, ms) },
        async cancel() { await evalIn(shell, `window.browserAPI.ai.agentCancel(${JSON.stringify(reqId)})`, true) },
      }
    }

    const doneStep = { reply: () => JSON.stringify({ action: 'done', message: '완료' }) }
    const missed = []
    const clickByLabel = (label) => ({
      reply: (ctx) => {
        const ref = ctx.refFor(label)
        if (ref === null || ref === undefined) {
          missed.push({ label, obs: String(ctx.lastUser).slice(0, 1500) })
          return JSON.stringify({ action: 'done', message: `${label} 못 찾음(관찰 실패)` })
        }
        return JSON.stringify({ action: 'click', ref, thought: `${label} 누름` })
      },
    })
    const genImgWait = { reply: () => JSON.stringify({ action: 'wait_for', selector: 'img[alt="생성된 이미지"]', timeout: 6000 }) }

    // 결과에서 "id=\"art_xxxx\"" 패턴을 뽑는다(capture_image/download 성공 시 pendingPrefix 가 다음 관찰에 실린다).
    function extractArtifactId(text) {
      const m = /id="(art_[a-f0-9]+)"/.exec(String(text ?? ''))
      return m ? m[1] : null
    }

    // ===================================================================================
    // A1 — 정상 경로: 기준선 → 생성 → 가져오기. 우선순위 최상.
    // ===================================================================================
    {
      const reqId = 'A1'
      const bucket = `session-${reqId}`
      const tabId = await newTab(fixture.base + '/gen')
      await sleep(400)
      const script = [
        { reply: () => JSON.stringify({ action: 'mark_baseline' }) },
        clickByLabel('생성'),
        genImgWait,
        { reply: () => JSON.stringify({ action: 'capture_image' }) },
        doneStep,
      ]
      const r = await run({ reqId, script, task: '이미지를 생성하고 가져와라', tabId })
      const list = await listArtifactsFor(bucket)
      const saveEv = r.evs.find((e) => e.type === 'result' && e.label === '생성물 저장' && e.ok === true)
      let diskOk = false, diskDetail = ''
      if (list.length === 1) {
        const meta = list[0]
        try {
          const buf = fs.readFileSync(meta.path)
          const isPngSig = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
          diskOk = isPngSig && meta.width === 800 && meta.height === 600 && meta.format === 'png'
          diskDetail = `path=${path.basename(meta.path)} pngSig=${isPngSig} ${meta.width}x${meta.height} bytes=${meta.bytes}`
        } catch (e) { diskDetail = `파일 읽기 실패: ${e.message}` }
      } else diskDetail = `산출물 개수=${list.length}(1이어야)`
      check('A1', '정상 경로: mark_baseline→생성→capture_image 로 실제 PNG 파일이 저장된다',
        !!saveEv && list.length === 1 && diskOk,
        `트레이스저장이벤트=${!!saveEv} · 목록=${list.length}개 · ${diskDetail}`
        + (missed.length ? ` · 못찾음(${missed[missed.length - 1].label})` : ''))
    }

    // ===================================================================================
    // A4 — HTML 위장 거부. 우선순위 최상.
    // ===================================================================================
    {
      const reqId = 'A4'
      const bucket = `session-${reqId}`
      const tabId = await newTab(fixture.base + '/gen?html=1')
      await sleep(400)
      const script = [
        { reply: () => JSON.stringify({ action: 'mark_baseline' }) },
        clickByLabel('생성'),
        genImgWait,
        { reply: () => JSON.stringify({ action: 'capture_image' }) },
        doneStep,
      ]
      const r = await run({ reqId, script, task: '이미지를 생성하고 가져와라', tabId })
      const list = await listArtifactsFor(bucket)
      const failEv = r.evs.find((e) => e.type === 'result' && e.label === '생성물 가져오기' && e.ok === false)
      check('A4', 'HTML 위장 이미지(Content-Type: image/png 인데 본문은 HTML)는 산출물로 저장되지 않는다',
        list.length === 0 && !!failEv,
        `산출물=${list.length}개(0이어야) · 거부이벤트=${!!failEv} · detail="${failEv?.detail ?? ''}"`)
    }

    // ===================================================================================
    // A6 — 다운로드 완료까지 기다린다. 우선순위 최상.
    // ===================================================================================
    {
      const reqId = 'A6'
      const bucket = `session-${reqId}`
      const tabId = await newTab(fixture.base + '/')
      await sleep(300)
      const targetUrl = fixture.base + '/img/generated-a6.png'
      const script = [
        { reply: () => JSON.stringify({ action: 'download', url: targetUrl }) },
        doneStep,
      ]
      const r = await run({ reqId, script, task: '이 파일을 다운로드해라', tabId, timeoutMs: 60000 })
      const list = await listArtifactsFor(bucket)
      const doneEv = r.evs.find((e) => e.type === 'result' && e.label === '다운로드 완료')
      const startedOnlyEv = r.evs.find((e) => e.type === 'result' && /시작만|시작함/.test(String(e.detail ?? '')))
      let byteMatch = false, sizeDetail = ''
      if (list.length === 1) {
        try {
          const localSha = sha256File(list[0].path)
          const remote = await fetchBytes(targetUrl)
          const remoteSha = crypto.createHash('sha256').update(remote.buf).digest('hex')
          byteMatch = localSha === remoteSha
          sizeDetail = `local=${localSha.slice(0, 12)} remote=${remoteSha.slice(0, 12)} bytes=${list[0].bytes}`
        } catch (e) { sizeDetail = `비교 실패: ${e.message}` }
      }
      check('A6', '다운로드가 "완료"까지 대기하고(시작만이 아님) 산출물로 등록된다',
        !!doneEv && !startedOnlyEv && list.length === 1 && byteMatch,
        `완료이벤트=${!!doneEv} · 시작만이벤트=${!!startedOnlyEv}(없어야) · 산출물=${list.length}개 · ${sizeDetail}`)
    }

    // ===================================================================================
    // A8 — 업로드 연결(가장 중요): 생성→가져오기→SNS 업로드→바이트 동일성. 우선순위 최상.
    // ===================================================================================
    let a8Sha = null
    {
      const reqId = 'A8'
      const bucket = `session-${reqId}`
      const tabId = await newTab(fixture.base + '/gen')
      await sleep(400)
      // capture_image 의 결과(id)는 **바로 다음** 관찰의 pendingPrefix 에만 실린다(그 뒤 동작이 pendingPrefix 를
      // 덮어쓴다) — 그래서 navigate 응답을 만드는 이 턴(=capture_image 바로 다음 턴)에서 뽑아 클로저에 저장하고,
      // 실제 upload_file 은 여러 턴 뒤에 이 저장값을 쓴다.
      let cachedId = null
      const script = [
        { reply: () => JSON.stringify({ action: 'mark_baseline' }) },
        clickByLabel('생성'),
        genImgWait,
        { reply: () => JSON.stringify({ action: 'capture_image' }) },
        { reply: (ctx) => { cachedId = extractArtifactId(ctx.lastUser) ?? cachedId; return JSON.stringify({ action: 'navigate', url: fixture.base + '/sns' }) } },
        clickByLabel('새 게시물'),
        { reply: () => JSON.stringify({ action: 'upload_file', artifact: cachedId }) },
        { reply: (ctx) => JSON.stringify({ action: 'type', ref: ctx.refFor('문구 입력'), text: '검증용 캡션입니다' }) },
        clickByLabel('공유하기'),
        { reply: () => JSON.stringify({ action: 'wait_for', text: '게시물이 공유되었습니다', timeout: 5000 }) },
        doneStep,
      ]

      const r = await run({ reqId, script, task: '이미지를 생성해 SNS 에 올려라', tabId, timeoutMs: 60000 })
      const list = await listArtifactsFor(bucket)
      const state = await (await fetch(fixture.base + '/state')).json()
      const pub = state.publishes[0]
      let byteIdentical = false, detail = ''
      if (list.length >= 1 && pub) {
        const localSha = sha256File(list[0].path)
        a8Sha = localSha
        byteIdentical = localSha === pub.sha256
        detail = `local=${localSha.slice(0, 16)} server=${pub.sha256.slice(0, 16)} bytes=${pub.bytes}`
      } else detail = `산출물=${list.length}개, 서버 publishes=${state.publishes.length}건`
      check('A8', '업로드 연결: 생성물의 sha256 이 SNS 서버가 받은 파일의 sha256 과 정확히 일치한다(진짜 바이트 도착)',
        byteIdentical, detail + (cachedId ? ` · artifact=${cachedId}` : ' · artifact id 를 못 뽑음'))
    }

    // ===================================================================================
    // A2 — 옛 이미지 미끼: 생성 없이 capture_image → 산출물 0개
    // ===================================================================================
    {
      const reqId = 'A2'
      const bucket = `session-${reqId}`
      const tabId = await newTab(fixture.base + '/gen')
      await sleep(400)
      const script = [
        { reply: () => JSON.stringify({ action: 'mark_baseline' }) },
        { reply: () => JSON.stringify({ action: 'capture_image' }) },
        doneStep,
      ]
      const r = await run({ reqId, script, task: '생성물을 가져와라(생성 버튼은 누르지 않음)', tabId })
      const list = await listArtifactsFor(bucket)
      const failEv = r.evs.find((e) => e.type === 'result' && e.label === '생성물 가져오기' && e.ok === false)
      const askedSelection = r.evs.some((e) => e.type === 'result' && /선택 필요/.test(String(e.detail ?? '')))
      check('A2', '생성 없이 capture_image 를 부르면 로고·광고·썸네일을 집지 않는다(후보 없음 또는 선택 요구)',
        list.length === 0 && (!!failEv || askedSelection),
        `산출물=${list.length}개(0이어야) · 거부이벤트=${!!failEv} · 선택요구=${askedSelection} · detail="${failEv?.detail ?? ''}"`)
    }

    // ===================================================================================
    // A3 — 후보 여럿: index 없이 부르면 선택 요구, index 주면 저장
    // ===================================================================================
    {
      const reqId = 'A3'
      const bucket = `session-${reqId}`
      const tabId = await newTab(fixture.base + '/gen?two=1')
      await sleep(400)
      const script = [
        { reply: () => JSON.stringify({ action: 'mark_baseline' }) },
        clickByLabel('생성'),
        genImgWait,
        { reply: () => JSON.stringify({ action: 'capture_image' }) },              // index 없음 → 선택 요구 기대
        { reply: () => JSON.stringify({ action: 'capture_image', index: 0 }) },    // index 지정 → 저장 기대
        doneStep,
      ]
      const r = await run({ reqId, script, task: '생성된 이미지를 가져와라', tabId })
      const listAfterFirst = r.evs.filter((e) => e.type === 'result' && e.label === '생성물 가져오기')
      const askedSelection = listAfterFirst.some((e) => e.ok === false && /선택 필요/.test(String(e.detail ?? '')))
      const list = await listArtifactsFor(bucket)
      const savedOk = list.length === 1 && list[0].width === 800 && list[0].height === 600
      check('A3', '후보가 여럿이면 index 없이는 선택을 요구하고, index 를 주면 저장된다',
        askedSelection && savedOk,
        `선택요구=${askedSelection} · 저장후산출물=${list.length}개 · ${savedOk ? '치수정상' : '치수불일치'}`)
    }

    // ===================================================================================
    // A5 — blob URL 이미지도 캡처된다
    // ===================================================================================
    {
      const reqId = 'A5'
      const bucket = `session-${reqId}`
      const tabId = await newTab(fixture.base + '/gen?blob=1')
      await sleep(400)
      const script = [
        { reply: () => JSON.stringify({ action: 'mark_baseline' }) },
        clickByLabel('생성'),
        genImgWait,
        { reply: () => JSON.stringify({ action: 'capture_image' }) },
        doneStep,
      ]
      const r = await run({ reqId, script, task: '생성된 이미지를 가져와라', tabId })
      const list = await listArtifactsFor(bucket)
      let pngOk = false
      if (list.length === 1) {
        try { const buf = fs.readFileSync(list[0].path); pngOk = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 } catch { /* */ }
      }
      check('A5', 'blob: URL 로 표시된 생성 이미지도 페이지 컨텍스트에서 읽어 실제 PNG 로 저장된다',
        list.length === 1 && pngOk,
        `산출물=${list.length}개 · pngSig=${pngOk}`)
    }

    // ===================================================================================
    // A7 — 쿠키 보존: 세션 쿠키 없이는 403 HTML, 있으면 진짜 PNG
    // ===================================================================================
    {
      const reqId = 'A7'
      const bucket = `session-${reqId}`
      const tabId = await newTab(fixture.base + '/setcookie')
      await sleep(400)
      const targetUrl = fixture.base + '/img/needcookie.png'
      const script = [
        { reply: () => JSON.stringify({ action: 'download', url: targetUrl }) },
        doneStep,
      ]
      const r = await run({ reqId, script, task: '이 파일을 받아라', tabId, timeoutMs: 60000 })
      const list = await listArtifactsFor(bucket)
      let cookieVerified = false, detail = ''
      if (list.length === 1) {
        try {
          const buf = fs.readFileSync(list[0].path)
          const isPngSig = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
          const withCookie = await fetchBytes(targetUrl, { Cookie: 'sess=ok' })
          const withoutCookie = await fetchBytes(targetUrl, {})
          const shaLocal = sha256File(list[0].path)
          const shaWithCookie = crypto.createHash('sha256').update(withCookie.buf).digest('hex')
          cookieVerified = isPngSig && shaLocal === shaWithCookie && withoutCookie.status === 403
          detail = `pngSig=${isPngSig} · local==withCookie=${shaLocal === shaWithCookie} · 쿠키없을때상태=${withoutCookie.status}(403이어야)`
        } catch (e) { detail = `검증 실패: ${e.message}` }
      } else detail = `산출물=${list.length}개(1이어야)`
      check('A7', '탭 세션 쿠키를 그대로 실어 받아 403 HTML 이 아니라 진짜 PNG 가 저장된다',
        list.length === 1 && cookieVerified, detail)
    }

    // ===================================================================================
    // A9 — 다른 작업 산출물 거부
    // ===================================================================================
    {
      // A1 이 이미 만든 산출물 id 를 재사용한다(A1 이 앞서 실행돼 있어야 함 — 위에서 이미 실행됨).
      const a1List = await listArtifactsFor('session-A1')
      const otherId = a1List[0]?.id
      if (!otherId) {
        skip('A9', '다른 작업 산출물 거부', 'A1 의 산출물을 찾지 못해 재사용할 id 가 없음')
      } else {
        const reqId = 'A9'
        const tabId = await newTab(fixture.base + '/sns')
        await sleep(300)
        const script = [
          clickByLabel('새 게시물'),
          { reply: () => JSON.stringify({ action: 'upload_file', artifact: otherId }) },
          doneStep,
        ]
        const r = await run({ reqId, script, task: '파일을 첨부해라', tabId })
        const failEv = r.evs.find((e) => e.type === 'result' && e.label === '파일 업로드' && e.ok === false)
        const pageTarget = (await getTargetList(args.port)).find((t) => t.url && t.url.startsWith(fixture.base + '/sns'))
        let attachedCount = -1
        if (pageTarget) {
          const page = await connectSession(pageTarget, 'page')
          await ensureSessionReady(page)
          attachedCount = await evalIn(page, '(document.getElementById("file")?.files?.length ?? 0)')
          try { page.close() } catch { /* ignore */ }
        }
        check('A9', '다른 작업(bucket)의 산출물 id 는 거부되고 파일이 첨부되지 않는다',
          !!failEv && attachedCount === 0,
          `거부이벤트=${!!failEv} · detail="${failEv?.detail ?? ''}" · 첨부된파일수=${attachedCount}(0이어야)`)
      }
    }

    // ===================================================================================
    // A10 — 취소 후 무전달: capture_image 로 이어지는 응답 스트리밍 중 취소 → 산출물 미생성
    //   (해석: "capture_image 직전에 취소" = 모델이 그 행동을 결정하는 도중(스트리밍) 취소하면 그 행동 자체가
    //    실행되지 않는다. agent.ts 내부의 파일-쓰기 직전 gate() 마이크로 레이스는 타이밍이 ms 단위라 CDP
    //    라운드트립으로 결정론적으로 맞히기 어려워, 더 신뢰도 높은 이 경계로 검증한다 — CN1 과 동형 패턴.)
    // ===================================================================================
    {
      const reqId = 'A10'
      const bucket = `session-${reqId}`
      const tabId = await newTab(fixture.base + '/gen')
      await sleep(400)
      const h = await startControlled({
        reqId, task: '생성물을 가져와라', tabId,
        script: [
          { reply: () => JSON.stringify({ action: 'mark_baseline' }) },
          clickByLabel('생성'),
          genImgWait,
          { mode: 'slow', chunks: ['{"action":"capture', '_image"}'], delayMs: 700 },
          doneStep,
        ],
      })
      // 4번째 LLM 호출(capture_image 스트리밍)이 시작될 때까지 대기 후 취소.
      const deadline = Date.now() + 20000
      while (Date.now() < deadline && llm.count < 4) await sleep(50)
      await sleep(300) // 스트림이 흐르는 중(완결 전)
      const callsAtCancel = llm.count
      await h.cancel()
      const evs = await h.waitTerminal(15000)
      const types = evs.map((e) => e.type)
      const list = await listArtifactsFor(bucket)
      check('A10', 'capture_image 를 만들던 도중 취소하면 그 행동이 실행되지 않아 산출물이 생기지 않는다',
        types[types.length - 1] === 'cancelled' && !types.includes('done') && list.length === 0 && callsAtCancel === 4,
        `취소시점 LLM호출=${callsAtCancel}(4여야) · 산출물=${list.length}개(0이어야) · 이벤트 ${types.join('>')}`)
    }

    // ===================================================================================
    // A11 — 교차 출처 iframe 안 업로드 폼에서도 upload_file 이 동작한다
    // ===================================================================================
    {
      const reqId = 'A11'
      const bucket = `session-${reqId}`
      const tabId = await newTab(fixture.base + '/gen')
      await sleep(400)
      let cachedId = null
      const script = [
        { reply: () => JSON.stringify({ action: 'mark_baseline' }) },
        clickByLabel('생성'),
        genImgWait,
        { reply: () => JSON.stringify({ action: 'capture_image' }) },
        // capture_image 바로 다음 턴에서만 pendingPrefix 에 id 가 실려 있다 — 여기서 뽑아 클로저에 저장.
        { reply: (ctx) => { cachedId = extractArtifactId(ctx.lastUser) ?? cachedId; return JSON.stringify({ action: 'navigate', url: fixture.base + '/sns?iframe=1' }) } },
        clickByLabel('새 게시물'),
        { reply: () => JSON.stringify({ action: 'wait' }) },  // iframe 로드 여유(고정 대기, 단계 소모 감수)
        { reply: () => JSON.stringify({ action: 'upload_file', artifact: cachedId }) },
        { reply: (ctx) => JSON.stringify({ action: 'type', ref: ctx.refFor('문구 입력'), text: 'iframe 캡션' }) },
        clickByLabel('공유하기'),
        { reply: () => JSON.stringify({ action: 'wait_for', text: '게시물이 공유되었습니다', timeout: 5000 }) },
        doneStep,
      ]
      const r = await run({ reqId, script, task: 'iframe 안 SNS 폼에 이미지를 올려라', tabId, timeoutMs: 60000 })
      const list = await listArtifactsFor(bucket)
      const state = await (await fetch(fixture.base + '/state')).json()
      const lastPub = state.publishes[state.publishes.length - 1]
      let byteIdentical = false, detail = ''
      if (list.length >= 1 && lastPub) {
        const localSha = sha256File(list[0].path)
        byteIdentical = localSha === lastPub.sha256
        detail = `local=${localSha.slice(0, 12)} server=${lastPub.sha256.slice(0, 12)}`
      } else detail = `산출물=${list.length}개, publishes=${state.publishes.length}건`
      check('A11', '교차 출처 iframe(altBase) 안 업로드 폼에서도 upload_file 이 실제 파일을 전달한다',
        byteIdentical, detail + (cachedId ? ` · artifact=${cachedId}` : ' · id 못뽑음')
        + (missed.length ? ` · 참고: 못찾은 라벨=${missed.map((m) => m.label).join(',')}` : ''))
    }

    // ===================================================================================
    // C — 블로그 인게이지먼트. 정직성 원칙: recordEngagement/alreadyDid 는 코드에서 자동 호출되지
    // 않는다(§C7 순수함수만 검증 가능 — grep 확인, "필수 규율" 섹션 참고). 따라서 C2·C3·C4·C5·C6 는
    // "지시를 따르는 모델이라면 이 파이프라인(관찰·클릭·읽기)이 올바른 결과를 내는가" 를 검증한다.
    // ===================================================================================

    // ---- C2 (재검증, 참여 가드 fix 반영): 같은 글에 두 번 댓글 → [참여 가드] 표식이 있으면 2번째가 코드로 막히는가 ----
    {
      const reqId = 'C2'
      const mark = buildEngageMark({ account: 'testacct', mode: 'act', comment: true, like: false })
      const tabId = await newTab(fixture.base + '/blog/post/4')
      await sleep(300)
      const script = [
        { reply: (ctx) => JSON.stringify({ action: 'type', ref: ctx.refFor('댓글을 입력하세요'), text: '좋은 정보 감사합니다 - 1회차' }) },
        clickByLabel('댓글 등록'),
        // 302 redirect 후 같은 글로 돌아옴 — 두 번째 시도(같은 스크립트가 다시 이 글에 댓글을 단다).
        { reply: (ctx) => JSON.stringify({ action: 'type', ref: ctx.refFor('댓글을 입력하세요'), text: '두 번째 시도 - 2회차' }) },
        clickByLabel('댓글 등록'),
        doneStep,
      ]
      const r = await run({ reqId, script, task: `${mark}\n이 글에 댓글을 달아라`, tabId })
      const state = await (await fetch(fixture.base + '/state')).json()
      const mine = state.comments.filter((c) => c.postId === 'post:4')
      const dedup = mine.length === 1
      const blockedEv = r.evs.find((e) => e.type === 'result' && e.ok === false && /이미 이 글에/.test(String(e.detail ?? '')))
      check('C2', '[참여 가드] 표식이 있으면 같은 글 두 번째 댓글 클릭이 코드로 막혀 comments 에 1개만 남는다',
        dedup && !!blockedEv,
        `post:4 댓글 수=${mine.length}(1이어야) · 차단이벤트=${!!blockedEv} detail="${blockedEv?.detail ?? ''}" · 내용: ${mine.map((c) => c.text).join(' | ')}`)
    }

    // ---- C3 (재검증, 참여 가드 fix 반영): 이미 좋아요 눌린 글(post:3)에 클릭 → unlike 로 분류돼 클릭 자체가 막히는가 ----
    {
      const reqId = 'C3'
      const mark = buildEngageMark({ account: 'testacct', mode: 'act', comment: false, like: true })
      const tabId = await newTab(fixture.base + '/blog/post/3')
      await sleep(300)
      const beforeState = await (await fetch(fixture.base + '/state')).json()
      const beforeLiked = beforeState.likes.find((l) => l.key === 'post:3')?.liked
      const script = [
        clickByLabel('좋아요'),  // 버튼 라벨은 "♥ 좋아요 취소"(이미 눌린 상태) — refFor 는 부분일치라 "좋아요" 로 매칭됨
        doneStep,
      ]
      const r = await run({ reqId, script, task: `${mark}\n이 글에 좋아요를 눌러라`, tabId })
      const afterState = await (await fetch(fixture.base + '/state')).json()
      const afterLiked = afterState.likes.find((l) => l.key === 'post:3')?.liked
      const stayedLiked = afterLiked === true
      const blockedEv = r.evs.find((e) => e.type === 'result' && e.ok === false && /다시 누르면 취소되므로/.test(String(e.detail ?? '')))
      check('C3', '[참여 가드] 표식이 있으면 "좋아요 취소" 로 보이는 버튼 클릭 자체가 코드로 막혀 좋아요가 유지된다',
        stayedLiked && !!blockedEv,
        `클릭 전=${beforeLiked} 클릭 후=${afterLiked}(true 여야) · 차단이벤트=${!!blockedEv} detail="${blockedEv?.detail ?? ''}"`)
    }

    // ---- C1: 관련성 — 검색 결과에서 고른 글을 실제로 읽고, 노트에 그 글 고유 표지가 담기는가 ----
    {
      const reqId = 'C1'
      const topic = '캠핑'
      const tabId = await newTab(fixture.base + '/blog/search?q=' + encodeURIComponent(topic))
      await sleep(300)
      const script = [
        clickByLabel('완전 정리'),                                   // → /blog/post/2
        { reply: () => JSON.stringify({ action: 'read' }) },
        { reply: (ctx) => {
          const m = /POST-2-MARKER/.exec(ctx.lastUser)
          return JSON.stringify({ action: 'note', text: `대상: ${ctx.lastUser.match(/URL: (\S+)/)?.[1] ?? ''}|주제2 완전정리|본문에서 확인: ${m ? m[0] : '표지를 못 찾음'}` })
        } },
        { reply: () => JSON.stringify({ action: 'navigate', url: fixture.base + '/blog/search?q=' + encodeURIComponent(topic) }) },
        clickByLabel('후기 및 경험담'),                                // → /blog/post/3
        { reply: () => JSON.stringify({ action: 'read' }) },
        { reply: (ctx) => {
          const m = /POST-3-MARKER/.exec(ctx.lastUser)
          return JSON.stringify({ action: 'note', text: `대상: ${ctx.lastUser.match(/URL: (\S+)/)?.[1] ?? ''}|주제3 후기|본문에서 확인: ${m ? m[0] : '표지를 못 찾음'}` })
        } },
        { reply: () => JSON.stringify({ action: 'report', title: 'C1 검증 보고서', markdown: '' }) },
        doneStep,
      ]
      const r = await run({ reqId, script, task: `${topic} 관련 블로그를 찾아 읽고 요약해라`, tabId, timeoutMs: 60000 })
      const reportEv = r.evs.find((e) => e.type === 'report')
      const md = String(reportEv?.markdown ?? '')
      const hasBoth = md.includes('POST-2-MARKER') && md.includes('POST-3-MARKER')
      check('C1', '검색 결과에서 고른 글을 실제로 읽어(read) 그 글 고유 표지가 note→report 에 담긴다(내용을 실제로 읽었다는 증거)',
        !!reportEv && hasBoth,
        `보고서생성=${!!reportEv} · 노트수=${reportEv?.notes ?? 0} · 표지2포함=${md.includes('POST-2-MARKER')} · 표지3포함=${md.includes('POST-3-MARKER')}`)
    }

    // ---- C4: 내 글은 건너뛴다 (URL 로 식별 가능함을 이용한 "지시를 따르는" 스크립트) ----
    {
      const reqId = 'C4'
      const tabId = await newTab(fixture.base + '/blog/mine/1')
      await sleep(300)
      const script = [
        { reply: (ctx) => {
          const isMine = /\/blog\/mine\//.test(ctx.lastUser)
          if (isMine) return JSON.stringify({ action: 'note', text: '내 블로그 글이라 건너뜀' })
          return JSON.stringify({ action: 'type', ref: ctx.refFor('댓글을 입력하세요'), text: '실수로 단 댓글' })
        } },
        doneStep,
      ]
      const r = await run({ reqId, script, task: '이 글에 댓글을 달아라(단, 내 블로그 글이면 건너뛰어라)', tabId })
      const state = await (await fetch(fixture.base + '/state')).json()
      const mine = state.comments.filter((c) => c.postId === 'mine:1')
      check('C4', 'URL 로 "내 블로그"임을 식별할 수 있어, 지시를 따르는 모델이면 자기 글을 건너뛸 수 있다',
        mine.length === 0,
        `mine:1 댓글 수=${mine.length}(0이어야) · observation 에 /blog/mine/ 노출 확인됨`)
    }

    // ---- C5: 500 오류(읽지 못한 글)는 건너뛴다 ----
    {
      const reqId = 'C5'
      const tabId = await newTab(fixture.base + '/gen') // 아무 페이지에서 시작 후 navigate 로 post/9(500) 진입
      await sleep(300)
      const script = [
        { reply: () => JSON.stringify({ action: 'navigate', url: fixture.base + '/blog/post/9' }) },
        { reply: (ctx) => {
          const unreadable = /글을 불러오지 못했습니다/.test(ctx.lastUser)
          if (unreadable) return JSON.stringify({ action: 'note', text: '본문 로드 실패(500) - 건너뜀' })
          return JSON.stringify({ action: 'type', ref: ctx.refFor('댓글을 입력하세요'), text: '읽지도 않고 단 댓글' })
        } },
        doneStep,
      ]
      const r = await run({ reqId, script, task: '이 글에 댓글을 달아라(본문을 읽지 못하면 건너뛰어라)', tabId })
      const state = await (await fetch(fixture.base + '/state')).json()
      const post9 = state.comments.filter((c) => c.postId === 'post:9')
      check('C5', '본문 로드 실패(500, 짧은 오류 문구)를 관찰이 정확히 드러내 건너뛸 수 있다',
        post9.length === 0,
        `post:9 댓글 수=${post9.length}(0이어야)`)
    }

    // ---- C6 (재검증, 참여 가드 fix 반영): draft 모드 — [참여 가드] mode=draft 가 "댓글 등록"/"좋아요" 클릭도 코드로 막는지 ----
    {
      const mark = buildEngageMark({ account: 'testacct', mode: 'draft', comment: true, like: true })
      const reqId = 'C6'
      const tabId = await newTab(fixture.base + '/blog/post/2')
      await sleep(300)
      const naiveScript = [
        { reply: (ctx) => JSON.stringify({ action: 'type', ref: ctx.refFor('댓글을 입력하세요'), text: 'draft 모드인데 그냥 등록 시도' }) },
        clickByLabel('댓글 등록'),
        clickByLabel('좋아요'),
        doneStep,
      ]
      const r = await run({
        reqId, tabId, timeoutMs: 30000,
        task: `${mark}\n이 글에 댓글을 달고 좋아요를 눌러라(초안 모드 — 실제로 등록·좋아요하지 않는다)`,
        script: naiveScript,
      })
      const state = await (await fetch(fixture.base + '/state')).json()
      const post2Comments = state.comments.filter((c) => c.postId === 'post:2')
      const post2Liked = state.likes.find((l) => l.key === 'post:2')?.liked
      const blockedByCode = post2Comments.length === 0 && !post2Liked
      const blockedEvs = r.evs.filter((e) => e.type === 'result' && e.ok === false && /초안 모드입니다/.test(String(e.detail ?? '')))
      check('C6', '[참여 가드] mode=draft 이면 "댓글 등록"·"좋아요" 클릭이 순진한 스크립트에서도 코드로 막힌다',
        blockedByCode && blockedEvs.length === 2,
        `post:2 댓글수=${post2Comments.length}(0이어야) · 좋아요=${post2Liked}(false/undefined 여야) · 차단이벤트=${blockedEvs.length}(2여야: 댓글+좋아요)`)
    }

    try { child.kill() } catch { /* ignore */ }
  } catch (err) {
    check('FATAL', '하네스 실행', false, `${err.message}\n${err.stack ?? ''}`.slice(0, 1500))
  } finally {
    try { shell?.close() } catch { /* ignore */ }
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {}); b.close()
    } catch { /* ignore */ }
    await sleep(1200)
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    await llm.close()
    await fixture.close()
  }

  fs.writeFileSync(path.join(args.out, 'social-pipeline-results.json'), JSON.stringify({ results, findings }, null, 2))
  console.log('\n===== verify-social-pipeline 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL')
  const pass = results.filter((r) => r.status === 'PASS')
  const skipped = results.filter((r) => r.status === 'SKIP')
  console.log(`PASS=${pass.length} FAIL=${fail.length} SKIP=${skipped.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  if (findings.length) {
    console.log('\n===== 발견한 결함(고치지 않음) =====')
    for (const f of findings) console.log(`[${f.where}] ${f.text}`)
  }
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
