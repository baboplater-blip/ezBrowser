#!/usr/bin/env node
// verify-ai-connect-cdp.mjs — **AI 첫 사용이 막다른 길로 끝나지 않는가**를 실제 UI 로 확인한다.
//
// 왜 (2026-09-18): 기본 제공자는 anthropic(API 키 필요)인데, 실제 컴퓨터에는 이미 로그인된 CLI 나
// 로컬 Ollama 가 있는 경우가 많다. 그런데 AI 패널은 "API 키가 필요합니다" 만 말하고 끝나
// **쓸 수 있는 길이 있는데도 막힌 것처럼** 보였다. 그 회귀를 잡는다.
//
// 검사 방침 — 이 하네스는 **모델을 부르지 않는다**(탐지는 `--version`·로컬 tags·키 유무만).
// 실제 대화 왕복은 요금·구독 한도가 걸리므로 사람이 돌리는 별도 확인(`--live`)으로만 한다.
//
// 사용: node build/verify-ai-connect-cdp.mjs [--port <n>] [--out <dir>] [--live]
//   --live : 실제로 한 번 연결해 모델을 호출한다(구독 CLI 가 있을 때만·수동 확인용).

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, connectShellSessionReady, getTargetList, waitForPortFree, sleep } from './lib/cdp.mjs'
import { preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9283, out: path.join(REPO_ROOT, 'verify-out', 'ai-connect'), live: false }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--live') args.live = true
}

const results = []
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}
function gap(id, name, detail) {
  results.push({ id, name, status: 'GAP', detail })
  console.log(`  ○ ${id} GAP — ${detail}`)
}

async function evaluate(session, expression, timeoutMs = 30_000) {
  const r = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'JS 예외')
  return r.result?.value
}

async function findTarget(port, pred, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const t = (await getTargetList(port)).find(pred)
    if (t) return t
    await sleep(300)
  }
  return null
}

async function main() {
  fs.mkdirSync(args.out, { recursive: true })
  if (!fs.existsSync(EXE)) { console.error(`exe 없음: ${EXE}`); process.exit(2) }

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  // 온보딩은 건너뛰고(별도 하네스가 본다) AI 는 기본값 그대로 — 즉 키 없는 anthropic.
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true, completedAt: Date.now(), version: 'verify-ai-connect' },
    startup: { mode: 'newtab', urls: [] },
  }, null, 2))

  args.port = await preferFreePort(args.port, 'verify-ai-connect')
  if (!(await waitForPortFree(args.port))) { console.error(`포트 ${args.port} 사용 중`); process.exit(2) }

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`], {
    env, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.pipe(fs.createWriteStream(path.join(args.out, 'app-stdout.log')))
  child.stderr?.pipe(fs.createWriteStream(path.join(args.out, 'app-stderr.log')))

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port, { log: (m) => console.log(`[ai-connect] ${m}`) })
    const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)
    await sleep(1500)

    // ── C1. 기본 상태가 "키 없음" 인지 확인(이 하네스의 전제) ─────────────────
    const cfg = await evaluate(shell, `window.browserAPI.ai.config()`)
    check('C1', '기본 제공자는 키가 없는 상태', cfg && cfg.hasKey === false,
      `provider=${cfg?.provider} hasKey=${cfg?.hasKey}`)

    // ── C2. 탐지가 실제 환경을 반영하는가 ────────────────────────────────────
    const det = await evaluate(shell, `window.browserAPI.ai.detectProviders(true)`, 45_000)
    const cand = det?.candidates ?? []
    const ready = cand.filter((c) => c.ready)
    check('C2', '제공자 탐지가 7종을 모두 판정', cand.length === 7,
      `후보 ${cand.length}개 · 사용 가능 ${ready.length}개 (${ready.map((c) => c.id).join(', ') || '없음'})`)

    // ── C3. 판정이 실제와 일치하는가(하네스가 직접 재확인) ────────────────────
    //   탐지를 믿지 않고, 같은 사실을 다른 방법으로 재서 대조한다.
    const truth = await (async () => {
      const out = {}
      for (const [id, bin] of [['claude-code', 'claude'], ['codex', 'codex'], ['gemini-cli', 'gemini']]) {
        out[id] = await new Promise((res) => {
          const p = spawn(bin, ['--version'], { shell: process.platform === 'win32', windowsHide: true, stdio: 'ignore' })
          const t = setTimeout(() => { try { p.kill() } catch {} ; res(false) }, 8000)
          p.on('error', () => { clearTimeout(t); res(false) })
          p.on('close', (c) => { clearTimeout(t); res(c === 0) })
        })
      }
      try {
        const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(4000) })
        const b = await r.json()
        out.ollama = Array.isArray(b.models) && b.models.length > 0
      } catch { out.ollama = false }
      return out
    })()
    const mismatches = Object.entries(truth).filter(([id, real]) => (cand.find((c) => c.id === id)?.ready ?? null) !== real)
    check('C3', '탐지 결과가 실제 환경과 일치', mismatches.length === 0,
      mismatches.length === 0
        ? `4종 일치 (${Object.entries(truth).map(([k, v]) => `${k}=${v ? '있음' : '없음'}`).join(' ')})`
        : `불일치: ${mismatches.map(([id, real]) => `${id} 실제=${real} 탐지=${cand.find((c) => c.id === id)?.ready}`).join(', ')}`)

    // ── C4. 비용을 숨기지 않는가 ─────────────────────────────────────────────
    const costOk = cand.every((c) => ['subscription', 'free-local', 'free-tier', 'paid-key'].includes(c.cost))
      && cand.filter((c) => c.kind === 'cli').every((c) => c.cost === 'subscription')
      && cand.find((c) => c.id === 'anthropic')?.cost === 'paid-key'
    check('C4', '후보마다 비용 구분이 달려 있음', costOk,
      cand.map((c) => `${c.id}:${c.cost}`).join(' '))

    // ── C5. 준비 안 된 후보에는 해결책이 붙는가(막다른 안내 금지) ─────────────
    const notReady = cand.filter((c) => !c.ready)
    const allHaveFix = notReady.every((c) => typeof c.fix === 'string' && c.fix.length > 5)
    check('C5', '준비되지 않은 후보마다 무엇을 하면 되는지 제시', allHaveFix,
      notReady.length ? `${notReady.length}개 중 안내 있는 것 ${notReady.filter((c) => c.fix).length}개` : '준비 안 된 후보 없음')

    // ── C6. AI 패널이 그 목록을 실제로 그리는가 ──────────────────────────────
    await evaluate(shell, `window.browserAPI.actions.run('action.ai.open', { windowId: ${JSON.stringify(windowId)} })`)
    await sleep(1200)
    const ui = await (async () => {
      const deadline = Date.now() + 25_000
      let last = null
      while (Date.now() < deadline) {
        last = await evaluate(shell, `(() => {
          const s = document.querySelector('.ai-setup')
          if (!s) return { found: false }
          return { found: true, text: (s.innerText || '').slice(0, 600),
                   cards: [...s.querySelectorAll('.ai-provider-card')].map(b => (b.innerText||'').replace(/\\s+/g,' ').trim()),
                   buttons: [...s.querySelectorAll('button')].map(b => (b.textContent||'').trim()) }
        })()`)
        if (last.found && last.cards.length > 0) break
        await sleep(600)
      }
      return last
    })()
    const expectCards = ready.length
    check('C6', 'AI 패널이 연결 가능한 방법을 실제로 보여줌', !!ui?.found && ui.cards.length === expectCards,
      `카드 ${ui?.cards?.length ?? 0}개 / 사용 가능 ${expectCards}개`)
    if (ui?.cards?.length) console.log(`     카드: ${ui.cards.map((c) => c.slice(0, 70)).join(' | ')}`)

    // ── C7. 막다른 문구가 남아 있지 않은가(옛 UI 회귀) ────────────────────────
    const deadEnd = /API 키가 필요합니다/.test(ui?.text ?? '') && (ui?.cards?.length ?? 0) === 0
    check('C7', '"키가 필요합니다"로 끝나는 막다른 안내가 아님', !deadEnd,
      deadEnd ? '옛 막다른 안내로 회귀' : '연결 경로가 화면에 있음')

    // ── C8. 알 수 없는 제공자는 거부하는가(입력 방어) ─────────────────────────
    const bogus = await evaluate(shell, `window.browserAPI.ai.connectProvider('evil-provider')`)
    const stillSame = await evaluate(shell, `window.browserAPI.ai.config()`)
    check('C8', '알 수 없는 제공자는 거부하고 설정을 바꾸지 않음',
      bogus?.ok === false && stillSame?.provider === cfg?.provider,
      `ok=${bogus?.ok} provider=${stillSame?.provider}`)

    // ── C9. 밖에서 설정이 바뀌면 패널이 따라오는가 ────────────────────────────
    //   설정 화면·다른 창에서 연결했는데 사이드바가 "키가 필요합니다"에 머물면,
    //   사용자가 보기엔 연결이 안 된 것과 똑같다. 모델을 부르지 않고 확인할 수 있다.
    await evaluate(shell, `window.browserAPI.settings.set('ai.enabled', false)`)
    const followed = await (async () => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const t = await evaluate(shell, `(() => document.querySelector('.ai-setup')?.innerText ?? '')()`)
        if (/꺼져 있습니다/.test(t)) return true
        await sleep(400)
      }
      return false
    })()
    check('C9', '설정이 밖에서 바뀌면 AI 패널이 따라옴', followed,
      followed ? 'ai.enabled=false 로 바꾸자 패널이 즉시 반영' : '패널이 옛 상태에 머무름')
    await evaluate(shell, `window.browserAPI.settings.set('ai.enabled', true)`)
    await sleep(800)

    // ── C10~C12. 실제 연결(선택) — 사용자가 하는 그대로 카드를 눌러서 ─────────
    if (!args.live) {
      gap('C10', '실제 모델 호출로 연결 확인', '요금·구독 한도가 걸려 기본 실행에서는 하지 않는다 — `--live` 로 수동 확인')
    } else if (ready.length === 0) {
      gap('C10', '실제 모델 호출로 연결 확인', '이 컴퓨터에 쓸 수 있는 제공자가 없음')
    } else {
      const pick = ready.find((c) => c.kind === 'cli') ?? ready[0]
      console.log(`  → 화면의 "${pick.label}" 카드를 실제로 눌러 연결(모델 1회 호출)`)
      // IPC 를 직접 부르지 않는다 — 사용자가 누르는 경로 그대로여야 UI 전환까지 검증된다.
      const clicked = await evaluate(shell, `(() => {
        const cards = [...document.querySelectorAll('.ai-provider-card')]
        const t = cards.find(c => (c.innerText||'').includes(${JSON.stringify(pick.label)}))
        if (!t) return false
        t.click(); return true
      })()`)
      check('C10', '연결 카드를 화면에서 누를 수 있음', clicked === true, clicked ? `"${pick.label}" 클릭` : '카드를 찾지 못함')

      const settled = await (async () => {
        const deadline = Date.now() + 180_000
        while (Date.now() < deadline) {
          const st = await evaluate(shell, `(() => ({
            setup: !!document.querySelector('.ai-setup'),
            chat: !!document.querySelector('.ai-tab'),
            err: document.querySelector('.ai-setup-error-msg')?.textContent ?? null,
            fix: document.querySelector('.ai-setup-error-fix')?.textContent ?? null,
          }))()`)
          if (st.chat || st.err) return st
          await sleep(1000)
        }
        return { setup: true, chat: false, err: '시간 초과', fix: null }
      })()
      check('C11', '연결 후 AI 패널이 대화 화면으로 전환', settled.chat === true && settled.setup === false,
        settled.chat ? '설정 카드가 사라지고 대화 화면 표시' : `실패: ${settled.err} / 해결: ${settled.fix ?? '-'}`)
      const after = await evaluate(shell, `window.browserAPI.ai.config()`)
      check('C12', '연결 후 설정이 실제로 그 제공자로 바뀜', after?.provider === pick.id,
        `provider=${after?.provider} hasKey=${after?.hasKey}`)
    }
  } finally {
    try { shell?.close() } catch { /* 이미 닫힘 */ }
    try { child.kill() } catch { /* 이미 종료 */ }
    await sleep(1200)
  }

  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const gaps = results.filter((r) => r.status === 'GAP').length
  fs.writeFileSync(path.join(args.out, 'results.json'),
    JSON.stringify({ at: new Date().toISOString(), live: args.live, pass, fail, gap: gaps, results }, null, 2))
  console.log(`\nAI 연결: ${pass} PASS · ${fail} FAIL · ${gaps} GAP`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
