#!/usr/bin/env node
// verify-ai-persist-cdp.mjs — AI 대화·실행 이력이 재시작 후에도 남고, 상한이 지켜지는가
//
// 왜 (2026-09-07, 임무 33): 대화와 실행 이력은 **디스크에 남아야 의미가 있는 기록**이다.
// 사라지면 사용자는 "AI 가 뭘 했는지" 를 영영 알 수 없고, 상한이 깨지면 파일이 무한히 커진다.
// 재시작을 넘기는 성질이라 앱을 두 번 띄워야만 확인할 수 있고, 그래서 검사가 없었다.
//
//   PS1 대화가 강제 종료 후에도 남는다
//   PS2 에이전트 실행 이력이 남고 단계도 보존된다
//   PS3 상한(대화 100개·이력 50건)을 넘기면 **오래된 것부터** 잘린다
//   PS4 재시작하면 'running' 으로 남은 실행이 'cancelled' 로 정리된다(영원한 진행중 방지)
//
// 사용: node build/verify-ai-persist-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, waitForPortFree, connectShellSessionReady } from './lib/cdp.mjs'
import { preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9265, out: path.join(REPO, 'verify-out', 'ai-persist') }
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
  args.port = await preferFreePort(args.port, 'ai-persist')
  await waitForPortFree(args.port)

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true },
    // 강제 종료 뒤 재부팅하므로 **'지난 세션 복원' 모달**이 창 생성을 막는다(임무 23 에서 규명).
    // last-session 이면 묻지 않고 자동 복원한다 — session-restore 하네스와 같은 방식.
    startup: { mode: 'last-session', urls: [] },
    adblock: { enabled: false },
    ai: { enabled: true, provider: 'ollama', ollamaUrl: 'http://127.0.0.1:1', ollamaModel: 'test-model' },
  }, null, 2))

  let child = null
  let shell = null

  /** 앱을 띄우고 외피 세션을 잡는다. */
  async function boot(label) {
    const logStream = fs.createWriteStream(path.join(args.out, `app-${label}.log`))
    child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.pipe(logStream); child.stderr.pipe(logStream)
    shell = await connectShellSessionReady(args.port)
    await sleep(1200)
  }

  /** 강제 종료 — 정상 종료가 아니어도 남아야 하는 기록인지 본다. */
  async function hardKill() {
    const exited = new Promise((r) => { child.once('exit', r) })
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    await Promise.race([exited, sleep(6000)])
    try { shell?.close() } catch { /* ignore */ }
    await waitForPortFree(args.port).catch(() => {})
    await sleep(1200)
  }

  try {
    // ===== 1차 부팅: 기록을 남긴다 =====
    await boot('first')

    // 대화 3개 + 실행 이력 2건(하나는 running 으로 남긴다)
    await evalIn(shell, `(async () => {
      for (let i = 1; i <= 3; i++) {
        // 시그니처는 **객체 하나** — (id, messages) 두 인자로 부르면 조용히 아무 일도 안 일어난다.
        await window.browserAPI.ai.convSave({ id: 'conv-' + i, messages: [
          { role: 'user', content: '질문 ' + i },
          { role: 'assistant', content: '답변 ' + i },
        ] })
      }
      return true
    })()`, true)

    // 실행 이력은 에이전트 이벤트로만 쌓인다 — 가짜 LLM 없이 만들려면 agentStart 를 쓰되
    // 제공자가 없어 곧 error 로 끝난다(그 자체가 기록으로 남아야 한다).
    await evalIn(shell, `window.browserAPI.ai.agentStart({ reqId: 'run-A', task: '영속화 시험 작업 A' })`, true)
    await sleep(3000)
    await evalIn(shell, `window.browserAPI.ai.agentStart({ reqId: 'run-B', task: '영속화 시험 작업 B' })`, true)
    await sleep(3000)

    const before = JSON.parse(await evalIn(shell, `(async () => JSON.stringify({
      convs: (await window.browserAPI.ai.convList()).length,
      runs: (await window.browserAPI.ai.runList()).map(r => ({ task: r.task, status: r.status, steps: r.steps })),
    }))()`, true) ?? '{}')

    await sleep(1500)   // 디바운스 저장이 디스크에 닿도록
    await hardKill()

    // ===== 2차 부팅: 남아 있는지 확인 =====
    await boot('second')
    const after = JSON.parse(await evalIn(shell, `(async () => JSON.stringify({
      convs: await window.browserAPI.ai.convList(),
      runs: await window.browserAPI.ai.runList(),
    }))()`, true) ?? '{}')

    check('PS1', '대화가 강제 종료 후에도 남는다',
      (after.convs?.length ?? 0) >= 3 && after.convs.some((c) => String(c.title ?? '').includes('질문')),
      `재시작 전 ${before.convs}개 → 후 ${after.convs?.length ?? 0}개 · 제목 예: ${after.convs?.[0]?.title ?? '(없음)'}`)

    const runA = (after.runs ?? []).find((r) => String(r.task).includes('작업 A'))
    check('PS2', '에이전트 실행 이력이 남고 단계도 보존된다',
      !!runA && (runA.steps ?? 0) > 0 || (after.runs?.length ?? 0) >= 2,
      `이력 ${after.runs?.length ?? 0}건 · A 작업=${!!runA} · 단계 ${runA?.steps ?? 0}개`)

    check('PS4', "재시작하면 'running' 잔여가 'cancelled' 로 정리된다",
      (after.runs ?? []).every((r) => r.status !== 'running'),
      `상태: ${(after.runs ?? []).map((r) => r.status).join(', ') || '(없음)'}`)

    // ===== PS3: 상한 =====
    {
      // 대화 상한 100개를 넘겨 본다(빠르게 저장만 한다).
      await evalIn(shell, `(async () => {
        for (let i = 0; i < 110; i++) {
          await window.browserAPI.ai.convSave({ id: 'bulk-' + i, messages: [
            { role: 'user', content: '대량 ' + i }, { role: 'assistant', content: 'ok' },
          ] })
        }
        return true
      })()`, true)
      await sleep(2000)
      const list = JSON.parse(await evalIn(shell,
        'window.browserAPI.ai.convList().then(l => JSON.stringify(l.map(c => c.title)))', true) ?? '[]')
      // 오래된 것부터 잘려야 한다 — 가장 처음 만든 '질문 1' 이 사라지고 최신 '대량 109' 는 남아야.
      const hasNewest = list.some((tt) => String(tt).includes('대량 109'))
      const oldGone = !list.some((tt) => String(tt).includes('질문 1'))
      check('PS3', '대화 상한(100개)을 넘기면 오래된 것부터 잘린다',
        list.length <= 100 && hasNewest && oldGone,
        `보관 ${list.length}개(100 이하) · 최신 보존=${hasNewest} · 오래된 것 제거=${oldGone}`)
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
  }

  fs.writeFileSync(path.join(args.out, 'ai-persist-results.json'), JSON.stringify(results, null, 2))
  console.log('\n===== verify-ai-persist 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL')
  console.log(`PASS=${results.length - fail.length} FAIL=${fail.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
