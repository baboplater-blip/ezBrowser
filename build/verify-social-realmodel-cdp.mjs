#!/usr/bin/env node
// verify-social-realmodel-cdp.mjs — social 파이프라인을 **실제 구독 CLI 모델**로 완주시켜 검증한다.
//
// 지금까지 build/verify-social-pipeline-cdp.mjs 는 가짜 LLM 각본(build/lib/fake-llm.mjs)으로만
// social 파이프라인을 검증했다 — 각본이 통과해도 "진짜 planner 모델이 우리 툴을 실제로 쓰는지"는
// 확인되지 않는다. 이 하네스는 그 물음에 답한다: 사용자의 기존 구독 CLI(claude — settings.ai.provider
// = 'claude-code')가 자연어 지시만으로 우리 브라우저의 액션(mark_baseline/capture_image/upload_file/
// click/type/navigate/…)을 실제로 골라 써서 로컬 픽스처(social-fixture-server.mjs)에 진짜 부작용을
// 남기는지를 본다.
//
// 패턴은 build/verify-social-pipeline-cdp.mjs 를 그대로 따른다 — 앱 기동·CDP 접속·픽스처 기동·
// 설정 시드·이벤트 수집·정리가 전부 거기서 그대로 왔다. **가짜 LLM 부분만 실모델로 바꿨다**:
// llm.setScript(...) 없이 자연어 task 문자열 하나만 주고, 모델이 스스로 관찰·행동을 반복하게 둔다.
//
// 절대 제약 (위반하면 하네스 버그로 본다):
//   - 외부 실사이트 접속·로그인·게시 0건 — 모든 대상은 127.0.0.1 로컬 픽스처뿐이다
//     (agentStart 에 allowedHosts: ['127.0.0.1'] 을 강제해 코드로도 막는다).
//   - 유료 API 키·크레딧 0원 — 오직 사용자의 기존 구독 CLI(`claude`, PATH)만 쓴다.
//   - 시나리오당 예산: agentMaxSteps=20 (steps ≤ 20 ⟹ LLM 호출도 항상 ≤ 20 ⟹ 지시된
//     "최대 25단계·모델호출 20회 이내"를 항상 만족한다).
//   - 재시도는 시나리오당 최대 1회.
//   - 사용자 실제 프로필 무접촉 — 격리 --user-data-dir 사용.
//
// 판정 규칙: "모델이 그렇게 말했다"를 근거로 쓰지 않는다. 반드시 픽스처 서버의 /state 로 판정한다
// (구조적 판정 — 문구를 정확히 비교하지 않고 "비어 있지 않고 sha256 이 일치한다" 식으로 본다).
//
// 사용: node build/verify-social-realmodel-cdp.mjs [--port <n>] [--out <dir>]
// 결과: verify-out/social-realmodel/results.json

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, waitForPortFree, connectShellSessionReady } from './lib/cdp.mjs'
import { preferFreePort } from './lib/ports.mjs'
import { startSocialFixtures } from './social-fixture-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const ELECTRON_BIN = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN_ENTRY = path.join(REPO, 'app', 'dist', 'main', 'index.js')

const args = { port: 9269, out: path.join(REPO, 'verify-out', 'social-realmodel') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

// 시나리오당 예산 — 20단계면 "LLM 호출 ≤ 20"과 "단계 ≤ 25" 둘 다 항상 만족(호출은 단계당 최대 1회).
const AGENT_MAX_STEPS = 20
const SNS_TIMEOUT_MS = 5 * 60_000
const BLOG_TIMEOUT_MS = 6 * 60_000

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

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

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

async function main() {
  fs.mkdirSync(args.out, { recursive: true })

  console.log('=== social 실모델 검증(claude-code CLI, 구독 사용·유료 API 0원) ===')
  const pre = preflightClaudeCli()
  if (!pre.ok) {
    console.log(`claude CLI 를 쓸 수 없습니다 — 전체 시나리오를 SKIP 합니다. 사유: ${pre.reason}`)
    skip('R-SNS', '이미지 생성→캡처→SNS 게시', `claude CLI 미가용: ${pre.reason}`)
    skip('R-BLOG', '블로그 2글 댓글·좋아요', `claude CLI 미가용: ${pre.reason}`)
    writeResultsAndExit()
    return
  }
  console.log(`claude CLI 확인됨: ${pre.version} (인증 여부는 실행 중 오류로만 알 수 있음)`)

  if (!fs.existsSync(ELECTRON_BIN)) throw new Error(`electron 바이너리 없음: ${ELECTRON_BIN}`)
  if (!fs.existsSync(MAIN_ENTRY)) throw new Error(`빌드 산출물 없음(npm run build:main 필요): ${MAIN_ENTRY}`)

  args.port = await preferFreePort(args.port, 'verify-social-realmodel-cdp.mjs')
  await waitForPortFree(args.port)

  const fixture = await startSocialFixtures()
  console.log('픽스처:', fixture.base, '(altBase:', fixture.altBase, ') — 127.0.0.1 loopback 전용, 외부 접속 없음')

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
  const child = spawn(ELECTRON_BIN, [MAIN_ENTRY, `--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')

    const cfg = await evalIn(shell, 'window.browserAPI.ai.config()', true).catch(() => null)
    console.log('앱이 본 AI 설정:', cfg?.provider, '· model:', cfg?.model, '· hasKey:', cfg?.hasKey)

    // 이벤트 구독 — 이걸 빼먹으면 window.__ev 는 영원히 빈 배열로 남는다(실제로 한 번 겪음: 부작용은
    // 실제 실행됐는데 steps=0/calls=0/타임아웃으로만 보였다 — reference 파일의 이 한 줄을 놓쳤던 것).
    await evalIn(shell, 'window.__ev = []; window.browserAPI.ai.onAgentEvent((e) => window.__ev.push(e)); true')

    async function newTab(url) {
      return evalIn(shell,
        `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(url)}).then(t => t.id)`, true)
    }

    /** 지정 bucket(=taskId, 보통 "session-<reqId>")의 산출물 메타 목록. */
    async function listArtifactsFor(bucket) {
      const raw = await evalIn(shell, `window.browserAPI.ai.artifactList(${JSON.stringify(bucket)})`, true)
      return JSON.parse(JSON.stringify(raw ?? []))
    }

    const TERMINAL = new Set(['done', 'error', 'cancelled', 'exhausted'])

    /**
     * 실제 모델로 에이전트 작업 하나를 완주까지 돌린다. 각본 없음 — task 자연어 지시 하나만 준다.
     * 진행 중 나타나는 confirm/ask 는 로컬 픽스처(외부 접속 없음)에 한정된 검증이므로 자동 승인/응답한다
     * (실사용 안전 게이트 자체를 검증하는 것이 이 하네스의 목적이 아니다 — verify-agent-safety 가 그 몫).
     */
    async function runAgentTask({ reqId, task, tabId, timeoutMs }) {
      await evalIn(shell, 'window.__ev = []; true')
      const startArgs = { reqId, tabId, task, allowedHosts: ['127.0.0.1'] }
      await evalIn(shell, `window.browserAPI.ai.agentStart(${JSON.stringify(startArgs)})`, true)

      let handledConfirm = 0
      let handledAsk = 0
      const deadline = Date.now() + timeoutMs
      let evs = []
      while (Date.now() < deadline) {
        evs = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ev)') ?? '[]')

        const confirms = evs.filter((e) => e.type === 'confirm')
        if (confirms.length > handledConfirm) {
          await evalIn(shell, `window.browserAPI.ai.agentConfirm(${JSON.stringify(reqId)}, true)`, true).catch(() => {})
          handledConfirm = confirms.length
        }
        const asks = evs.filter((e) => e.type === 'ask')
        if (asks.length > handledAsk) {
          await evalIn(shell,
            `window.browserAPI.ai.agentReply(${JSON.stringify(reqId)}, ${JSON.stringify('네, 계속 진행해 주세요.')})`, true)
            .catch(() => {})
          handledAsk = asks.length
        }

        if (evs.some((e) => TERMINAL.has(e.type))) break
        await sleep(800)
      }
      evs = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ev)') ?? '[]')
      const steps = evs.filter((e) => e.type === 'observe').length
      const llmCalls = evs.filter((e) => e.type === 'usage').length
      const timedOut = !evs.some((e) => TERMINAL.has(e.type))
      return { evs, steps, llmCalls, timedOut }
    }

    function terminalSummary(evs) {
      const t = [...evs].reverse().find((e) => TERMINAL.has(e.type))
      if (!t) return '(종료 이벤트 없음 — 타임아웃)'
      const msg = t.message ?? t.detail ?? (t.type === 'exhausted' ? `${t.stepsUsed}단계 소진` : '')
      return `${t.type}${msg ? ` ("${String(msg).slice(0, 160)}")` : ''}`
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
    // R-SNS — 이미지 생성 → 캡처 → 캡션/태그 → SNS 게시 완료. 실제 claude CLI 플래너로 완주.
    // 합격 판정은 픽스처 서버 /state 로만 한다(모델의 "했다" 주장이 아니라 서버가 실제로 받은 것).
    // ===================================================================================
    async function attemptRSns(reqId) {
      const bucket = `session-${reqId}`
      const tabId = await newTab(fixture.base + '/gen')
      await sleep(400)
      const task =
        '당신은 지금 AI 이미지 생성 사이트에 있습니다. 먼저 지금 화면의 이미지 상태를 기준선으로 기록한 뒤, '
        + '프롬프트 입력칸에 원하는 그림에 대한 설명을 짧게 적고 "생성" 버튼을 누르세요. 이미지가 화면에 나타날 '
        + '때까지 기다렸다가 그 생성물을 이 작업의 산출물로 가져오세요. 그 다음 ' + fixture.base + '/sns 로 '
        + '이동해 "새 게시물"을 열고, 방금 가져온 이미지를 첨부한 뒤 그림에 어울리는 짧은 문구를 작성해서 '
        + '공유(게시)까지 마치세요. 다 끝나면 완료로 보고하세요.'

      const t0 = Date.now()
      const r = await runAgentTask({ reqId, task, tabId, timeoutMs: SNS_TIMEOUT_MS })
      const ms = Date.now() - t0

      const list = await listArtifactsFor(bucket)
      const state = await (await fetch(fixture.base + '/state')).json()
      const pub = state.publishes[state.publishes.length - 1]

      let ok = false
      let detail
      if (list.length >= 1 && pub) {
        const match = list.find((a) => { try { return sha256File(a.path) === pub.sha256 } catch { return false } })
        const byteIdentical = !!match
        const captionOk = typeof pub.caption === 'string' && pub.caption.trim().length > 0
        ok = byteIdentical && captionOk
        detail = `산출물=${list.length}개 · 업로드바이트일치=${byteIdentical}`
          + (match ? ` (artifact=${match.id})` : ' (일치하는 산출물 없음)')
          + ` · 캡션비어있지않음=${captionOk} 캡션="${String(pub.caption ?? '').slice(0, 60)}"`
          + ` · 서버publishes=${state.publishes.length}건 bytes=${pub.bytes}`
      } else {
        detail = `산출물=${list.length}개 · 서버publishes=${state.publishes.length}건(둘 다 ≥1 이어야 비교 가능)`
      }
      detail += ` · 종료=${terminalSummary(r.evs)} · steps=${r.steps}(한도${AGENT_MAX_STEPS}) calls=${r.llmCalls} `
        + `ms=${ms} timeout=${r.timedOut}`
      return { ok, detail, steps: r.steps, llmCalls: r.llmCalls, ms }
    }

    // ===================================================================================
    // R-BLOG — 블로그 본문 기반으로 서로 다른 2개 글에 댓글·좋아요. 실제 claude CLI 로 완주.
    // 판정: 새 댓글 2건 + 서로 다른 글(중복 0) + 그 2건 모두 좋아요 상태 true.
    // ===================================================================================
    async function attemptRBlog(reqId) {
      const topic = '캠핑'
      const tabId = await newTab(fixture.base + '/blog/search?q=' + encodeURIComponent(topic))
      await sleep(400)
      const before = await (await fetch(fixture.base + '/state')).json()

      const task =
        '지금 보고 있는 블로그 검색 결과 목록에는 여러 글이 있습니다. 이 중 "내 블로그" 글이나 검색 주제와 '
        + '무관한 글은 건너뛰고, 주제와 실제로 관련된 서로 다른 글 두 개를 골라 각각 클릭해 열어 본문을 '
        + '읽으세요. 한 글을 읽었으면 그 글의 실제 본문 내용에 근거한 짧은 댓글을 작성해 등록하고, 그 글에 '
        + '아직 좋아요가 눌려있지 않다면 좋아요도 눌러주세요(이미 좋아요가 눌려있는 글이면 좋아요는 건너뛰고 '
        + '댓글만 다세요). 한 글을 다 처리했으면 검색 결과 목록으로 돌아가(주소창 이동이 필요하면 이동해서) '
        + '아직 처리하지 않은 다른 글을 같은 방식으로 처리하세요. 서로 다른 두 글을 모두 처리했으면 '
        + '완료로 보고하세요.'

      const t0 = Date.now()
      const r = await runAgentTask({ reqId, task, tabId, timeoutMs: BLOG_TIMEOUT_MS })
      const ms = Date.now() - t0

      const after = await (await fetch(fixture.base + '/state')).json()
      const newComments = after.comments.slice(before.comments.length)
      const blogComments = newComments.filter((c) => /^post:/.test(c.postId))
      const mineComments = newComments.filter((c) => /^mine:/.test(c.postId))
      const distinctPosts = [...new Set(blogComments.map((c) => c.postId))]
      const commentsOk = blogComments.length === 2 && distinctPosts.length === 2
      const likesByKey = new Map(after.likes.map((l) => [l.key, l.liked]))
      const likedOk = distinctPosts.length === 2 && distinctPosts.every((k) => likesByKey.get(k) === true)
      const ok = commentsOk && likedOk

      const detail = `새댓글=${blogComments.length}(2여야) 서로다른글=${distinctPosts.length}(2여야) [${distinctPosts.join(',')}] `
        + `좋아요확인=${distinctPosts.map((k) => `${k}:${likesByKey.get(k)}`).join(' ') || '(없음)'} `
        + `내글에댓글=${mineComments.length}(0이어야) `
        + `· 종료=${terminalSummary(r.evs)} · steps=${r.steps}(한도${AGENT_MAX_STEPS}) calls=${r.llmCalls} `
        + `ms=${ms} timeout=${r.timedOut}`
      return { ok, detail, steps: r.steps, llmCalls: r.llmCalls, ms }
    }

    console.log('\n--- R-SNS: 이미지 생성 → 캡처 → SNS 게시 (claude CLI) ---')
    const rSns = await withRetry('R-SNS', attemptRSns)
    check('R-SNS', '이미지 생성→캡처→SNS 게시 완료(실제 claude CLI 플래너)', rSns.ok, rSns.detail,
      { steps: rSns.steps, llmCalls: rSns.llmCalls, ms: rSns.ms, retried: !!rSns.retried })

    console.log('\n--- R-BLOG: 블로그 2글 댓글·좋아요 (claude CLI) ---')
    const rBlog = await withRetry('R-BLOG', attemptRBlog)
    check('R-BLOG', '서로 다른 두 블로그 글에 댓글+좋아요(실제 claude CLI 플래너)', rBlog.ok, rBlog.detail,
      { steps: rBlog.steps, llmCalls: rBlog.llmCalls, ms: rBlog.ms, retried: !!rBlog.retried })

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
  console.log(`PASS=${pass.length} FAIL=${fail.length} SKIP=${skipped.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  console.log('결과 파일:', path.join(args.out, 'results.json'))
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
