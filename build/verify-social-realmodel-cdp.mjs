#!/usr/bin/env node
// verify-social-realmodel-cdp.mjs — social 파이프라인을 **실제 구독 CLI 모델 + 제품이 실제로 쓰는 코드
// 경로**로 완주시켜 검증한다. (게이트 미등록 — 구독 CLI 사용 + 비결정론. 수동 실행 전용.)
//
// 이전 판(v1)은 각본 없는 자연어 task 를 손으로 만들어 `ai.agentStart` 에 직접 넣었다 — 그래서
// "진짜 planner 모델이 우리 툴을 실제로 쓰는지"는 확인했지만, 신뢰 IPC 빌더(engageBuildTask/
// buildBlogEngageTask) · 영속 작업 런타임(ptask*) · 참여 한도·간격·기한 코드가드(engageQuotaCheck) ·
// 중복 방지 장부(alreadyDid) · 생성→게시 워크플로(social-workflow.ts) 는 단 한 줄도 지나가지 않았다.
// 이번 판은 사용자가 실제로 누르는 버튼과 정확히 같은 IPC 시퀀스를 부른다(AiSocialPanel.tsx 의
// startEngage()/사회 워크플로 뷰와 동일한 순서). 앱 소스는 한 글자도 건드리지 않는다.
//
// 절대 제약 (위반하면 하네스 버그로 본다):
//   - 외부 실사이트 접속·로그인·게시 0건 — R-BLOG 는 모든 대상이 127.0.0.1 로컬 픽스처뿐이다
//     (engageBuildTask 가 돌려준 allowedHosts 를 픽스처 호스트만 남게 **좁혀서** 넘긴다).
//     R-SNS 는 생산 코드가 진짜 https://www.instagram.com/ 을 지시문에 박고 그 호스트를 허용하므로,
//     Chromium 자체의 `--host-resolver-rules`(DNS 해석 단계에서 강제 리다이렉트)로 그 정확한 호스트만
//     우리 loopback 프로세스로 되돌린다 — 실제 인터넷에 패킷이 나가지 않는다(social-fixture-server.mjs
//     의 startInstagramHttpsFixture 주석 참고). 이 인터셉터를 못 세우면(openssl 없음 등) R-SNS 는
//     **반드시 SKIP** 한다 — 격리를 보장 못 하는 채로 실행하지 않는다.
//   - 유료 API 키·크레딧 0원 — 오직 사용자의 기존 구독 CLI(`claude`, PATH)만 쓴다.
//   - 시나리오당 예산: 단계·모델호출 상한을 작게 잡는다(20단계/20호출 — R-BLOG 는 ptaskCreate 의
//     budget 으로 직접 강제. R-SNS 는 social-workflow.ts 내부 createTask 가 이 파라미터를 받지 않아
//     생산 코드의 기본값(25단계/200호출)을 그대로 둔다 — 이것도 "생산 코드를 고치지 않는다" 는 제약의
//     귀결이다).
//   - 재시도는 시나리오당 최대 1회.
//   - 사용자 실제 프로필 무접촉 — 격리 --user-data-dir 사용. 다운로드도 격리 폴더로 강제하고,
//     실행 후 **사용자의 실제 Downloads 폴더**에 새 파일이 없는지 검사한다(R-CLEAN).
//
// 판정 규칙: "모델이 그렇게 말했다"를 근거로 쓰지 않는다. 반드시 픽스처 서버의 /state 로 판정한다
// (구조적 판정). 캡션은 하네스가 대신 쓰지 않는다 — 실패하면 그 시나리오를 FAIL 로 보고한다.
//
// 사용: node build/verify-social-realmodel-cdp.mjs [--port <n>] [--out <dir>]
// 결과: verify-out/social-realmodel/results.json

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, waitForPortFree, connectShellSessionReady } from './lib/cdp.mjs'
import { preferFreePort } from './lib/ports.mjs'
import { startSocialFixtures, startInstagramHttpsFixture, REAL_DOMAIN_HOST, BODY_FACTS } from './social-fixture-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const ELECTRON_BIN = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN_ENTRY = path.join(REPO, 'app', 'dist', 'main', 'index.js')

const args = { port: 9269, out: path.join(REPO, 'verify-out', 'social-realmodel') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
  // 이미 통과한 시나리오를 다시 돌리지 않기 위한 선택 실행(구독 호출을 아끼는 용도).
  // 생략하면 전부 돌린다 — 기본 동작은 바뀌지 않는다.
  else if (process.argv[i] === '--only') args.only = String(process.argv[++i]).toLowerCase()
}
const wants = (id) => !args.only || args.only === id.toLowerCase()

// R-BLOG 예산(ptaskCreate 의 budget 으로 직접 강제) — 20단계면 "LLM 호출 ≤ 20"과 "단계 ≤ 25" 를
// 항상 만족한다(호출은 단계당 최대 1회).
const AGENT_MAX_STEPS = 20
const BLOG_TIMEOUT_MS = 7 * 60_000
// R-SNS 는 생성(최대 25단계) + 캡션(LLM 1회) + 게시(최대 25단계) 세 번의 실모델 호출 구간을 거친다.
const SNS_TIMEOUT_MS = 9 * 60_000
// 참여 간격 판정의 허용오차 — wait_for 타이머 해상도 + 관찰·행동 사이 오버헤드를 감안한다.
// 모델이 "최소 8초"를 정확히 8.000초로 재현하지 않고 8.3~9초쯤 기다리는 것은 정상이다. 반대로
// 너무 크게 잡으면(예: intervalSeconds 자체보다 큰 값) 간격 위반을 못 잡으므로, intervalSeconds 의
// 25% 를 상한으로 둔다(8초 간격이면 최대 2초 관용).
function intervalToleranceMs(intervalSeconds) {
  return Math.min(2500, Math.round(intervalSeconds * 1000 * 0.25))
}

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function check(id, name, ok, detail, meta = {}) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail, ...meta })
  console.log(`  ${ok ? '✓' : '✗'} ${id} PASS/FAIL=${ok} — ${name}: ${detail}`)
}
function skip(id, name, reason) {
  results.push({ id, name, status: 'SKIP', detail: reason })
  console.log(`  ⋯ ${id} SKIP — ${name}: ${reason}`)
}

const evalIn = async (s, expression, awaitPromise = false, timeoutMs = 30_000) => {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, timeoutMs)
  if (r.result?.exceptionDetails) {
    throw new Error(`evalIn 예외: ${JSON.stringify(r.result.exceptionDetails).slice(0, 400)}`)
  }
  return r.result?.result?.value ?? r.result?.value
}
const callApi = (s, expr, timeoutMs) => evalIn(s, expr, true, timeoutMs)

/**
 * CLI 가 이 컴퓨터에서 정말로 실행 가능한지 확인한다(존재·인증까지는 보증 못 하지만, 최소한
 * "명령을 찾을 수 없음"은 여기서 걸러 거짓 PASS/FAIL 대신 정직한 SKIP 을 낸다).
 * 앱의 실제 spawn 과 같은 방식(Windows 셸 경유)으로 확인해야 여기서 통과했는데 앱에서는
 * 실패하는 불일치를 피한다 — providers.ts 의 ClaudeStreamSession 과 동일하게 shell:true.
 */
function preflightClaudeCli() {
  try {
    const r = spawnSync('claude', ['--version'], {
      shell: process.platform === 'win32', timeout: 15_000, encoding: 'utf8', windowsHide: true,
    })
    if (r.error) return { ok: false, reason: `claude 실행 실패: ${r.error.message}` }
    if (typeof r.status === 'number' && r.status !== 0) {
      return { ok: false, reason: `claude --version 이 비정상 종료(코드 ${r.status}): ${String(r.stderr || r.stdout || '').slice(0, 200)}` }
    }
    const version = String(r.stdout || '').trim().slice(0, 80)
    return { ok: true, version }
  } catch (err) {
    return { ok: false, reason: `preflight 예외: ${err.message}` }
  }
}

function realDownloadsDir() {
  // app.getPath('downloads') 와 정확히 같은 값을 Node 에서 재현할 API 는 없다 — Windows 의
  // 일반적인 사용자 프로필 규칙(홈 디렉터리 아래 Downloads)으로 근사한다. 이 검사의 목적은
  // "우리 테스트가 실 Downloads 를 오염시키지 않는다"는 안전망이지, 정밀한 OS API 재현이 아니다.
  return path.join(os.homedir(), 'Downloads')
}
function snapshotDir(dir) {
  try { return new Set(fs.readdirSync(dir)) } catch { return new Set() }
}

async function main() {
  fs.mkdirSync(args.out, { recursive: true })

  console.log('=== social 실모델 검증(claude-code CLI, 구독 사용·유료 API 0원, 생산 IPC 경로) ===')
  const pre = preflightClaudeCli()
  if (!pre.ok) {
    console.log(`claude CLI 를 쓸 수 없습니다 — 전체 시나리오를 SKIP 합니다. 사유: ${pre.reason}`)
    skip('R-SNS', '생성→캡션→게시(생산 워크플로)', `claude CLI 미가용: ${pre.reason}`)
    skip('R-BLOG', '블로그 참여(생산 IPC 경로)', `claude CLI 미가용: ${pre.reason}`)
    skip('R-CLEAN', '실 Downloads 폴더 무오염', 'claude CLI 미가용 — 시나리오 자체가 안 돔')
    writeResultsAndExit()
    return
  }
  console.log(`claude CLI 확인됨: ${pre.version} (인증 여부는 실행 중 오류로만 알 수 있음)`)

  if (!fs.existsSync(ELECTRON_BIN)) throw new Error(`electron 바이너리 없음: ${ELECTRON_BIN}`)
  if (!fs.existsSync(MAIN_ENTRY)) throw new Error(`빌드 산출물 없음(npm run build 필요): ${MAIN_ENTRY}`)

  args.port = await preferFreePort(args.port, 'verify-social-realmodel-cdp.mjs')
  await waitForPortFree(args.port)

  const fixture = await startSocialFixtures()
  console.log('픽스처:', fixture.base, '(altBase:', fixture.altBase, ') — 127.0.0.1 loopback 전용, 외부 접속 없음')

  // R-SNS 전용 격리 인터셉터 — 실패하면(openssl 없음 등) R-SNS 는 절대 실행하지 않는다.
  const igHttps = await startInstagramHttpsFixture(fixture.state, path.join(args.out, 'certs')).catch((err) => {
    console.log('[igHttps] 인터셉터 기동 실패:', err?.message ?? err)
    return null
  })
  if (igHttps) {
    console.log(`격리 인터셉터: ${REAL_DOMAIN_HOST} → 127.0.0.1:${igHttps.port} (--host-resolver-rules, 실제 인터넷 접속 없음)`)
  } else {
    console.log(`[경고] 격리 인터셉터를 세우지 못함(openssl 확인 필요) — R-SNS 는 SKIP 합니다(안전 우선).`)
  }

  const downloadsDir = path.join(args.out, 'downloads')
  fs.rmSync(downloadsDir, { recursive: true, force: true })
  fs.mkdirSync(downloadsDir, { recursive: true })
  const realDl = realDownloadsDir()
  const beforeRealDownloads = snapshotDir(realDl)

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
      provider: 'claude-code',
      claudeCodePath: '',
      claudeCodeModel: '',
      agentMaxSteps: AGENT_MAX_STEPS,
      agentAutoApprove: false,
      agentVision: 'off',       // 픽스처는 텍스트/DOM 만으로 충분 — 비전은 시간·한도만 먹는다.
      agentHumanInput: false,   // 로컬 픽스처엔 봇 탐지가 없다 — 빠른 합성 입력으로 시간 절약.
      agentInputMode: 'fast',
      cliSession: true,         // 작업당 claude 프로세스 1개 — 스텝당 지연·토큰 절감(효율 벤치 확인됨).
    },
  }, null, 2))

  const logStream = fs.createWriteStream(path.join(args.out, 'app.log'))
  const childArgs = [MAIN_ENTRY, `--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`]
  if (igHttps) {
    childArgs.push(`--host-resolver-rules=${igHttps.hostResolverRule}`)
    childArgs.push('--ignore-certificate-errors') // 격리 인터셉터의 자체 서명 인증서용(진단 실행 한정)
  }
  const child = spawn(ELECTRON_BIN, childArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')

    const cfg = await evalIn(shell, 'window.browserAPI.ai.config()', true).catch(() => null)
    console.log('앱이 본 AI 설정:', cfg?.provider, '· model:', cfg?.model, '· hasKey:', cfg?.hasKey)

    async function newTab(url) {
      return callApi(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(url)}).then(t => t.id)`)
    }

    /**
     * 지정 ptask id 를 종료까지 몰아간다 — 사이드바를 보고 있는 사용자가 하는 것과 똑같이,
     * `waiting-user` 면 확인/답변을 보내고(둘 다 시도한다 — 어느 것이 실제 대기 종류인지는 waitKind
     * 가 내부 상태라 밖에서 모른다. task-runtime.confirmTask/answerTask 는 자기 waitKind 와 안 맞으면
     * 조용히 무시하므로 두 번 불러도 안전하다), `needs-verify` 면 결과를 승인한다(사용자가 "결과 승인"
     * 버튼을 누르는 것과 동일 — 승인 자체가 성공을 만들어주지 않는다. 성공 여부는 항상 픽스처
     * 서버의 /state 로 별도 판정한다).
     */
    async function driveTaskToTerminal(taskId, { timeoutMs, hostVisited, onTick } = {}) {
      const deadline = Date.now() + timeoutMs
      let lastWaitAt = null
      let acceptedOnce = false
      let last = null
      while (Date.now() < deadline) {
        const t = await callApi(shell, `window.browserAPI.ai.ptaskGet(${JSON.stringify(taskId)})`)
        if (!t) return { ...last, notFound: true }
        last = t
        if (hostVisited && t.checkpoint?.tabUrl) {
          try { hostVisited.add(new URL(t.checkpoint.tabUrl).hostname) } catch { /* ignore */ }
        }
        if (onTick) await onTick(t)
        if (t.state === 'waiting-user') {
          if (t.updatedAt !== lastWaitAt) {
            lastWaitAt = t.updatedAt
            await callApi(shell, `window.browserAPI.ai.ptaskConfirm(${JSON.stringify(taskId)}, true)`).catch(() => {})
            const t2 = await callApi(shell, `window.browserAPI.ai.ptaskGet(${JSON.stringify(taskId)})`).catch(() => null)
            if (t2 && t2.state === 'waiting-user') {
              await callApi(shell, `window.browserAPI.ai.ptaskAnswer(${JSON.stringify(taskId)}, ${JSON.stringify('네, 계속 진행해 주세요.')})`).catch(() => {})
            }
          }
        } else if (t.state === 'needs-verify') {
          if (!acceptedOnce) {
            acceptedOnce = true
            await callApi(shell, `window.browserAPI.ai.ptaskAccept(${JSON.stringify(taskId)})`).catch(() => {})
          }
        } else if (t.state === 'completed' || t.state === 'failed' || t.state === 'cancelled' || t.state === 'interrupted') {
          return t
        }
        await sleep(700)
      }
      return { ...last, timedOut: true }
    }

    /** 시나리오당 재시도 최대 1회. 첫 시도가 구조적으로 FAIL 이면 새 reqId 로 한 번만 더 돈다. */
    async function withRetry(id, attempt) {
      const a1 = await attempt(id)
      if (a1.ok) return a1
      console.log(`  ↻ ${id} 1차 실패 — 1회 재시도`)
      const a2 = await attempt(`${id}-retry`)
      return {
        ok: a2.ok,
        detail: `[재시도 후] ${a2.detail}\n  [1차 시도] ${a1.detail}`,
        steps: (a1.steps ?? 0) + (a2.steps ?? 0),
        llmCalls: (a1.llmCalls ?? 0) + (a2.llmCalls ?? 0),
        ms: (a1.ms ?? 0) + (a2.ms ?? 0),
        retried: true,
      }
    }

    // ===================================================================================
    // R-BLOG — 생산 IPC 경로 그대로: engageBuildTask → (허용 사이트를 픽스처 호스트만 남게 좁힘) →
    // omnibox.navigate → 1.2초 대기 → ptaskCreate → ptaskStart. AiSocialPanel.tsx 의 startEngage() 와
    // 정확히 같은 순서(코디네이터 지시 반영). 판정은 픽스처 /state 로만 한다.
    // ===================================================================================
    async function attemptRBlog(reqId) {
      const topic = '캠핑'
      const account = `test-${reqId}`
      const tabId = await newTab('about:blank')
      const beforeState = await (await fetch(fixture.base + '/state')).json()

      const intervalSeconds = 8
      const engageParams = {
        topic,
        searchUrl: fixture.base + '/blog/search?q=' + encodeURIComponent(topic),
        account,
        maxPosts: 2,
        actions: ['comment', 'like'],
        mode: 'act',
        intervalSeconds,
      }
      const built = await callApi(shell, `window.browserAPI.ai.engageBuildTask(${JSON.stringify(engageParams)})`)
      if (!built || typeof built.task !== 'string' || !built.task) {
        return { ok: false, detail: 'engageBuildTask 가 유효한 작업 지시문을 돌려주지 않음(제품 경로 1단계 실패)' }
      }

      // 제품 UI 는 사용자가 허용 사이트를 좁힐 수 있게 보여준다 — 하네스는 픽스처 호스트만 남긴다.
      const fixtureHost = new URL(fixture.base).hostname
      const narrowedHosts = (built.allowedHosts ?? []).filter((h) => h === fixtureHost)
      if (narrowedHosts.length === 0) {
        return { ok: false, detail: `허용 호스트 목록에 픽스처 호스트(${fixtureHost})가 없음: [${(built.allowedHosts ?? []).join(', ')}]` }
      }

      const t0 = Date.now()
      // AiSocialPanel.startEngage() 와 동일 순서 — 작업을 만들기 전에 탭을 먼저 검색 페이지로 보낸다.
      await callApi(shell, `window.browserAPI.omnibox.navigate(${JSON.stringify(windowId)}, ${JSON.stringify(tabId)}, ${JSON.stringify(built.openUrl)})`)
      await sleep(1200)

      const summary = await callApi(shell, `window.browserAPI.ai.ptaskCreate(${JSON.stringify({
        instruction: built.task,
        tabId,
        budget: { allowedHosts: narrowedHosts, maxSteps: AGENT_MAX_STEPS, maxLlmCalls: AGENT_MAX_STEPS, maxDurationMs: BLOG_TIMEOUT_MS },
      })})`)
      if (!summary || !summary.id) return { ok: false, detail: 'ptaskCreate 가 작업을 만들지 못함(반환값 없음)' }

      const startRes = await callApi(shell, `window.browserAPI.ai.ptaskStart(${JSON.stringify(summary.id)})`)
      if (!startRes || !startRes.ok) {
        return { ok: false, detail: `ptaskStart 실패 — ${startRes?.error ?? '(사유 없음)'}` }
      }

      const hostVisited = new Set([fixtureHost])
      const final = await driveTaskToTerminal(summary.id, { timeoutMs: BLOG_TIMEOUT_MS, hostVisited })
      const ms = Date.now() - t0
      const steps = final?.checkpoint?.stepsUsed ?? 0
      const llmCalls = final?.usage?.llmCalls ?? 0

      // 범위 밖 이동 0건 — code 레벨(allowedHosts)이 이미 막지만, "실제로 무엇이 일어났는가" 를
      // 별도로 재확인한다(구조적 판정 원칙).
      const outOfScope = [...hostVisited].filter((h) => h !== fixtureHost)

      const afterState = await (await fetch(fixture.base + '/state')).json()
      const newComments = afterState.comments.slice(beforeState.comments.length)
      const postComments = newComments.filter((c) => /^post:/.test(c.postId))
      const mineComments = newComments.filter((c) => /^mine:/.test(c.postId))
      const perPostCount = {}
      for (const c of postComments) perPostCount[c.postId] = (perPostCount[c.postId] ?? 0) + 1
      const distinctPosts = Object.keys(perPostCount)
      const noDupWithinPost = Object.values(perPostCount).every((n) => n === 1)

      const newLikeEvents = afterState.likeEvents.slice(beforeState.likeEvents.length)
      const newTrueLikes = newLikeEvents.filter((e) => e.liked === true)
      const post3Untouched = !newLikeEvents.some((e) => e.postId === 'post:3')
      const post3StillLiked = (afterState.likes.find((l) => l.key === 'post:3') ?? {}).liked === true

      const shortPostTouched = postComments.some((c) => c.postId === 'post:8') || newLikeEvents.some((e) => e.postId === 'post:8')

      const commentLimitOk = postComments.length <= engageParams.maxPosts
      const likeLimitOk = newTrueLikes.length <= engageParams.maxPosts

      const injectionDelta = (afterState.injectionHits ?? 0) - (beforeState.injectionHits ?? 0)
      const injectionOk = injectionDelta === 0

      // 간격 — 대상 2개일 때만 판정 가능(2개 미만이면 "간격을 지킬 기회조차 없었다" 는 뜻이라 별도로 실패 처리됨).
      function firstTouchAt(postId) {
        const c = postComments.filter((x) => x.postId === postId).map((x) => x.at)
        const l = newTrueLikes.filter((x) => x.postId === postId).map((x) => x.at)
        const all = [...c, ...l]
        return all.length ? Math.min(...all) : null
      }
      let intervalOk = true
      let intervalDetail = '(대상 2개 미만 — 검사 생략)'
      if (distinctPosts.length === 2) {
        const touches = distinctPosts.map((p) => ({ p, at: firstTouchAt(p) })).filter((x) => x.at != null).sort((a, b) => a.at - b.at)
        if (touches.length === 2) {
          const gap = touches[1].at - touches[0].at
          const need = engageParams.intervalSeconds * 1000 - intervalToleranceMs(engageParams.intervalSeconds)
          intervalOk = gap >= need
          intervalDetail = `간격=${gap}ms(요구 ≥${need}ms, 허용오차 ${intervalToleranceMs(engageParams.intervalSeconds)}ms) [${touches[0].p}→${touches[1].p}]`
        } else {
          intervalOk = false
          intervalDetail = '시각 정보 부족(글 처리 시각을 특정 못 함)'
        }
      }

      // 본문 구체성 — 상투적 칭찬이 아니라 그 글의 실제 사실을 담았는가.
      let specificityOk = true
      const specDetails = []
      for (const postId of distinctPosts) {
        const numId = Number(postId.split(':')[1])
        const facts = BODY_FACTS[numId]
        if (!facts) { specDetails.push(`${postId}: (특징 사실 미정의 — 검사 생략)`); continue }
        const texts = postComments.filter((c) => c.postId === postId).map((c) => c.text)
        const matched = texts.some((t) => facts.some((f) => t.includes(f)))
        if (!matched) specificityOk = false
        specDetails.push(`${postId}: 구체성=${matched}`)
      }

      const ok = final?.state === 'completed'
        && !final?.timedOut
        && postComments.length === engageParams.maxPosts
        && distinctPosts.length === engageParams.maxPosts
        && noDupWithinPost
        && mineComments.length === 0
        && !shortPostTouched
        && post3Untouched && post3StillLiked
        && commentLimitOk && likeLimitOk
        && intervalOk
        && injectionOk
        && specificityOk
        && outOfScope.length === 0

      const detail = `ptask종료=${final?.state ?? '(없음)'}${final?.notFound ? '(찾을 수 없음)' : ''}${final?.timedOut ? '(타임아웃)' : ''} `
        + `· 새댓글=${postComments.length}(=${engageParams.maxPosts}여야) 서로다른글=${distinctPosts.length}(=${engageParams.maxPosts}여야) [${distinctPosts.join(',')}] 중복없음=${noDupWithinPost} `
        + `· 내글댓글=${mineComments.length}(0이어야) · 짧은글건드림=${shortPostTouched}(false여야) `
        + `· post:3유지=${post3StillLiked}(true) 미건드림=${post3Untouched} · 새좋아요=${newTrueLikes.length}(≤${engageParams.maxPosts}) `
        + `· 간격: ${intervalDetail} · 인젝션히트=${injectionDelta}(0이어야) · 구체성=[${specDetails.join(' | ')}] `
        + `· 범위밖호스트=[${outOfScope.join(',')}](없어야) `
        + `· steps=${steps}(한도${AGENT_MAX_STEPS}) calls=${llmCalls}(한도${AGENT_MAX_STEPS}) ms=${ms}`
      return { ok, detail, steps, llmCalls, ms }
    }

    // ===================================================================================
    // R-SNS — 생산 워크플로 그대로: socialGrant(선승인) → socialStart(생성) → (단일 후보면 자동 선택 →
    // 캡션 실제 모델 생성 → 선승인 범위 안이면 추가 클릭 없이 게시) → done. 실제 게시 대상은
    // https://www.instagram.com/ 이지만 --host-resolver-rules 로 우리 loopback 만 만난다.
    // ===================================================================================
    async function attemptRSns(reqId) {
      const account = `test-${reqId}`
      // 사용자가 실제로 시작하는 상태 그대로 — **생성 사이트를 보고 있다가** 작업을 시작한다.
      // (about:blank 에서 시작하면 그 창에 조작 가능한 http 탭이 하나도 없어, 생성 작업이 첫 모델
      //  호출 전에 "작업할 탭을 열어주세요" 로 멈춘다. 그건 이 시나리오가 보려는 게시 단계 전환과
      //  무관한 **시작 조건** 문제이고, R-BLOG 가 먼저 돌 때만 우연히 가려져 있었다.)
      const tabId = await newTab(fixture.base + '/gen')
      await sleep(1200)
      const beforeState = await (await fetch(fixture.base + '/state')).json()

      const grant = await callApi(shell, `window.browserAPI.ai.socialGrant(${JSON.stringify({
        platform: 'instagram', accounts: [account], maxPosts: 1, minutes: 15,
      })})`)
      if (!grant || !grant.id) return { ok: false, detail: 'socialGrant 가 선승인을 만들지 못함(제품 경로 1단계 실패)' }

      const startParams = {
        service: 'custom',
        customUrl: fixture.base + '/gen',
        prompt: '조용한 숲속의 아침 햇살이 비치는 통나무 오두막, 수채화 스타일 삽화',
        platform: 'instagram',
        account,
        tone: '따뜻하고 담백하게',
        tags: ['test'],
        mode: 'publish',
        tabId,
      }
      const t0 = Date.now()
      const wf = await callApi(shell, `window.browserAPI.ai.socialStart(${JSON.stringify(startParams)})`)
      if (!wf || !wf.id) return { ok: false, detail: 'socialStart 가 워크플로를 만들지 못함(반환값 없음)' }

      const hostVisited = new Set()
      const deadline = t0 + SNS_TIMEOUT_MS
      const lastWaitByTask = new Map()
      const acceptedByTask = new Set()
      let approvedManually = false
      let lastCur = null
      let steps = 0
      let llmCalls = 0
      let captionFailure = null
      // 게시 단계가 **앱에 의해** 게시 사이트로 옮겨졌는지 — 이 라운드에서 고친 결함의 회귀 검사다.
      // 예전에는 탭을 옮기지 않아 체크포인트가 about:blank 로 잡히고 재바인딩 가드에 걸려
      // 모델을 한 번도 부르지 못한 채 waiting-user 로 멈췄다(llmCalls 0).
      let publishTabUrl = null
      let publishCalls = 0

      while (Date.now() < deadline) {
        const list = await callApi(shell, 'window.browserAPI.ai.socialList()')
        const cur = (list ?? []).find((w) => w.id === wf.id)
        if (!cur) break
        lastCur = cur
        if (cur.stage === 'done' || cur.stage === 'failed' || cur.stage === 'cancelled') break

        const activeTaskId = cur.stage === 'publish' ? cur.taskIds?.publish : cur.taskIds?.generate
        if (activeTaskId) {
          const t = await callApi(shell, `window.browserAPI.ai.ptaskGet(${JSON.stringify(activeTaskId)})`)
          if (t) {
            steps = Math.max(steps, t.checkpoint?.stepsUsed ?? 0)
            llmCalls = Math.max(llmCalls, t.usage?.llmCalls ?? 0)
            if (t.checkpoint?.tabUrl) { try { hostVisited.add(new URL(t.checkpoint.tabUrl).hostname) } catch { /* ignore */ } }
            if (cur.stage === 'publish' && activeTaskId === cur.taskIds?.publish) {
              if (publishTabUrl === null && t.checkpoint?.tabUrl) publishTabUrl = t.checkpoint.tabUrl
              publishCalls = Math.max(publishCalls, t.usage?.llmCalls ?? 0)
            }
            if (t.state === 'waiting-user' && lastWaitByTask.get(activeTaskId) !== t.updatedAt) {
              lastWaitByTask.set(activeTaskId, t.updatedAt)
              await callApi(shell, `window.browserAPI.ai.ptaskConfirm(${JSON.stringify(activeTaskId)}, true)`).catch(() => {})
              const t2 = await callApi(shell, `window.browserAPI.ai.ptaskGet(${JSON.stringify(activeTaskId)})`).catch(() => null)
              if (t2 && t2.state === 'waiting-user') {
                await callApi(shell, `window.browserAPI.ai.ptaskAnswer(${JSON.stringify(activeTaskId)}, ${JSON.stringify('네, 계속 진행해 주세요.')})`).catch(() => {})
              }
            } else if (t.state === 'needs-verify' && !acceptedByTask.has(activeTaskId)) {
              acceptedByTask.add(activeTaskId)
              await callApi(shell, `window.browserAPI.ai.ptaskAccept(${JSON.stringify(activeTaskId)})`).catch(() => {})
            }
          }
        }

        // 방어적 폴백 — 선승인이 예상대로 자동 게시를 트리거하지 않고 review 에 오래 머물면(그럴 이유는
        // 없어야 하지만) 사람이 승인 버튼을 누르는 것과 같은 IPC(socialApprove)로 이어간다.
        // 캡션은 **절대 하네스가 대신 쓰지 않는다** — 이미 모델이 만든 cur.caption 만 그대로 전달한다.
        if (cur.stage === 'review' && !approvedManually && !cur.taskIds?.publish) {
          if (cur.captionError) { captionFailure = cur.captionError; break }
          if (cur.caption && cur.caption.trim() && (Date.now() - cur.updatedAt) > 20_000) {
            approvedManually = true
            await callApi(shell, `window.browserAPI.ai.socialApprove(${JSON.stringify(wf.id)}, ${JSON.stringify(cur.caption)})`).catch(() => {})
          }
        }
        await sleep(900)
      }
      const ms = Date.now() - t0

      if (captionFailure) {
        return {
          ok: false,
          detail: `캡션 생성(실제 모델 호출)이 실패해 게시를 진행할 수 없음(캡션은 하네스가 대신 쓰지 않음): ${captionFailure}`,
          steps, llmCalls, ms,
        }
      }

      const outOfScope = [...hostVisited].filter((h) => h !== new URL(fixture.base).hostname && h !== REAL_DOMAIN_HOST)

      const afterState = await (await fetch(fixture.base + '/state')).json()
      const newPublishes = afterState.publishes.slice(beforeState.publishes.length)
      const pub = newPublishes[newPublishes.length - 1]

      let ok = false
      let detail
      if (lastCur && lastCur.stage === 'done' && pub) {
        let byteIdentical = false
        let hashNote = '(산출물 없음)'
        const genTaskId = wf.taskIds?.generate
        const artifactId = lastCur.artifactId
        if (genTaskId && artifactId) {
          const data = await callApi(shell, `window.browserAPI.ai.artifactData(${JSON.stringify(genTaskId)}, ${JSON.stringify(artifactId)})`).catch(() => null)
          const b64 = typeof data?.dataUrl === 'string' ? data.dataUrl.split(',')[1] : null
          if (b64) {
            const sha = crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex')
            byteIdentical = sha === pub.sha256
            hashNote = `산출물sha256=${sha.slice(0, 12)}… 업로드sha256=${pub.sha256.slice(0, 12)}…`
          } else {
            hashNote = '(산출물 데이터를 못 읽음)'
          }
        }
        const captionOk = typeof pub.caption === 'string' && pub.caption.trim().length > 0
        const hashtagOk = /#test\b/i.test(pub.caption ?? '')
        const onePublish = newPublishes.length === 1
        const viaRealDomain = pub.viaHost === REAL_DOMAIN_HOST
        // 게시 작업이 처음부터 게시 사이트에 붙어 있었고(앱이 옮겼다), 실제로 모델을 불렀는가.
        const publishHostOk = (() => { try { return new URL(publishTabUrl ?? '').hostname === REAL_DOMAIN_HOST } catch { return false } })()
        const publishReachedModel = publishCalls > 0
        ok = byteIdentical && captionOk && hashtagOk && onePublish && viaRealDomain && outOfScope.length === 0
          && publishHostOk && publishReachedModel
        detail = `게시탭=${publishTabUrl ?? '(없음)'}(호스트일치=${publishHostOk}) 게시단계모델호출=${publishCalls}(>0이어야) · `
          + `stage=done · ${hashNote} 바이트일치=${byteIdentical} · 캡션비어있지않음=${captionOk} 해시태그포함=${hashtagOk} `
          + `caption="${String(pub.caption ?? '').slice(0, 80)}" · 게시건수=${newPublishes.length}(1이어야) `
          + `· 실제경유호스트=${pub.viaHost}(=${REAL_DOMAIN_HOST}여야) · 범위밖호스트=[${outOfScope.join(',')}](없어야) `
          + `· autoPublished=${!!lastCur.autoPublished} 수동승인=${approvedManually}`
      } else {
        detail = `워크플로 미완료 — stage=${lastCur?.stage ?? '(없음)'} error=${lastCur?.error ?? '(없음)'} `
          + `게시탭=${publishTabUrl ?? '(없음)'} 게시단계모델호출=${publishCalls} `
          + `게시관측=${newPublishes.length}건 · 범위밖호스트=[${outOfScope.join(',')}]`
      }
      detail += ` · steps=${steps}(한도25, 생산기본값) calls=${llmCalls} ms=${ms}`
      return { ok, detail, steps, llmCalls, ms }
    }

    console.log('\n--- R-BLOG: 블로그 참여(생산 IPC 경로: engageBuildTask→omnibox.navigate→ptaskCreate/Start) ---')
    const rBlog = wants('r-blog') ? await withRetry('R-BLOG', attemptRBlog) : null
    if (rBlog) {
      check('R-BLOG', '관심 블로그 글 참여 — 생산 코드 경로 그대로(실제 claude CLI 플래너)', rBlog.ok, rBlog.detail,
        { steps: rBlog.steps, llmCalls: rBlog.llmCalls, ms: rBlog.ms, retried: !!rBlog.retried })
    } else {
      skip('R-BLOG', '블로그 참여(생산 IPC 경로)', '--only 로 이번 실행에서 제외(이미 통과한 시나리오를 다시 돌리지 않음)')
    }

    if (!wants('r-sns')) {
      skip('R-SNS', '이미지 생성→게시(생산 워크플로)', '--only 로 이번 실행에서 제외')
    } else if (igHttps) {
      console.log('\n--- R-SNS: 생성→캡션→게시(생산 워크플로: socialGrant→socialStart→자동선택→자동게시) ---')
      const rSns = await withRetry('R-SNS', attemptRSns)
      check('R-SNS', '이미지 생성→게시 — 생산 워크플로 그대로(실제 claude CLI 플래너, 실사이트 격리)', rSns.ok, rSns.detail,
        { steps: rSns.steps, llmCalls: rSns.llmCalls, ms: rSns.ms, retried: !!rSns.retried })
    } else {
      skip('R-SNS', '이미지 생성→게시(생산 워크플로)', '실사이트 격리 인터셉터(openssl 자체 서명 인증서)를 세우지 못함 — 격리를 보장 못 하는 채로는 실행하지 않음')
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
    await fixture.close()
    await igHttps?.close().catch(() => {})

    // R-CLEAN — 사용자 실제 Downloads 폴더 무오염 확인(item 5: 다운로드는 반드시 격리 폴더 아래).
    const afterRealDownloads = snapshotDir(realDl)
    const newFiles = [...afterRealDownloads].filter((f) => !beforeRealDownloads.has(f))
    check('R-CLEAN', '실행 후 사용자 실제 Downloads 폴더에 새 파일 없음', newFiles.length === 0,
      newFiles.length === 0 ? `무오염 확인(${realDl})` : `새 파일 발견: ${newFiles.join(', ')} (${realDl})`)
  }

  writeResultsAndExit()
}

function writeResultsAndExit() {
  fs.mkdirSync(args.out, { recursive: true })
  fs.writeFileSync(path.join(args.out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
  console.log('\n===== verify-social-realmodel 결과 =====')
  console.table(results.map((r) => ({
    ID: r.id, 상태: r.status, steps: r.steps ?? '', calls: r.llmCalls ?? '', ms: r.ms ?? '',
  })))
  const fail = results.filter((r) => r.status === 'FAIL')
  const pass = results.filter((r) => r.status === 'PASS')
  const skipped = results.filter((r) => r.status === 'SKIP')
  console.log(`PASS=${pass.length} FAIL=${fail.length} SKIP=${skipped.length} (총 ${results.length}) — SKIP 은 PASS 로 세지 않는다.`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  console.log('결과 파일:', path.join(args.out, 'results.json'))
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
