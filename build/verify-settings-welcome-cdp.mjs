#!/usr/bin/env node
// verify-settings-welcome-cdp.mjs — 사용자가 가장 먼저·가장 자주 보는 두 화면
// (`browser://settings`, `browser://welcome`)의 표시값과 반영을 **실측 대조**한다.
//
// 왜 (2026-09-07, 임무 17): 임무 9·16 에서 `browser://memory` 를 대조했더니 **예산 판정이
// 통째로 틀려 있었다**(다른 지표를 비교). 설정·환영 화면은 검증이 아예 없었고, 여기는
// **첫인상**이자 사용자가 값을 바꾸는 곳이다. "그럴듯해 보인다"는 검증이 아니다.
//
// 검사 방향은 두 갈래다:
//   · 표시(main → UI): 실제 설정을 바꾸면 화면이 따라오는가
//   · 반영(UI → main): 화면에서 바꾸면 실제 설정이 바뀌는가
// 한 방향만 되는 UI 는 흔한 버그다(초기값만 읽고 구독을 안 하거나, 그리기만 하고 저장을 안 함).
//
// 사용: node build/verify-settings-welcome-cdp.mjs [--port <n>] [--out <dir>]

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectSession, connectShellSessionReady, getTargetList, waitForPortFree, sleep,
} from './lib/cdp.mjs'
import { preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9246, out: path.join(REPO_ROOT, 'verify-out', 'settings-welcome') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const results = []
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}

async function evaluate(session, expression, timeoutMs = 20_000) {
  const r = await session.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, timeoutMs)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'JS 예외')
  return r.result?.value
}

async function openInternalPage(shell, windowId, url, port, label) {
  await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(url)})`)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const t = (await getTargetList(port)).find((x) => String(x.url).startsWith(url))
    if (t) {
      const s = await connectSession(t, label)
      await sleep(1500) // 첫 렌더(설정 로드 + 그리기) 대기
      return s
    }
    await sleep(300)
  }
  throw new Error(`${url} 타깃을 찾지 못함`)
}

function seedProfile(dir, extraSettings) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    setup: { completed: true, completedAt: Date.now(), version: 'verify-sw' },
    startup: { mode: 'newtab', urls: [] },
    ...extraSettings,
  }, null, 2))
}

async function main() {
  fs.mkdirSync(args.out, { recursive: true })
  if (!fs.existsSync(EXE)) {
    console.error(`exe 없음: ${EXE} — 먼저 npx electron-builder --win --dir`)
    process.exit(2)
  }
  const profileDir = path.join(args.out, 'profile')
  seedProfile(profileDir)

  // 고정 포트가 앞선 실행의 잔재에 물려 있으면 빈 포트로 대체한다(실행이 통째로 죽지 않게).
  args.port = await preferFreePort(args.port, 'verify-settings-welcome-cdp.mjs')
  if (!(await waitForPortFree(args.port))) {
    console.error(`디버그 포트 ${args.port} 사용 중 — 남은 인스턴스를 종료하세요.`)
    process.exit(2)
  }

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`], {
    env, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.pipe(fs.createWriteStream(path.join(args.out, 'app-stdout.log')))
  child.stderr?.pipe(fs.createWriteStream(path.join(args.out, 'app-stderr.log')))

  let shell = null
  let settings = null
  let welcome = null
  try {
    shell = await connectShellSessionReady(args.port, { log: (m) => console.log(`[verify-sw] ${m}`) })
    const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)
    settings = await openInternalPage(shell, windowId, 'browser://settings', args.port, 'settings')

    // ── S1: 표시 — 실제 설정과 토글 상태가 일치하는가 ────────────────────
    const KEY = 'appearance.forcePageDark'
    const truth1 = await evaluate(shell, `window.browserAPI.settings.get(${JSON.stringify(KEY)})`)
    const shown1 = await evaluate(settings, `(() => {
      const el = document.querySelector('[data-toggle=${JSON.stringify(KEY)}]')
      return el ? el.classList.contains('on') : null
    })()`)
    check('S1', '토글 표시가 실제 설정과 일치',
      shown1 !== null && shown1 === (truth1 === true),
      `페이지 ${shown1 === null ? '(토글 없음)' : shown1} vs 설정 ${truth1}`)

    // ── S2: 반영 — 페이지에서 클릭하면 실제 설정이 바뀌는가 ───────────────
    await evaluate(settings, `(() => {
      const el = document.querySelector('[data-toggle=${JSON.stringify(KEY)}]')
      if (el) el.click()
      return true
    })()`)
    await sleep(1200)
    const truth2 = await evaluate(shell, `window.browserAPI.settings.get(${JSON.stringify(KEY)})`)
    check('S2', '페이지에서 토글하면 실제 설정이 바뀐다 (UI → main)',
      truth2 === !truth1,
      `${truth1} → ${truth2} (기대 ${!truth1})`)

    // ── S3: 구독 — 밖에서 바꾸면 페이지가 따라오는가 ─────────────────────
    await evaluate(shell, `window.browserAPI.settings.set(${JSON.stringify(KEY)}, ${truth1 === true})`)
    await sleep(1500)
    const shown3 = await evaluate(settings, `(() => {
      const el = document.querySelector('[data-toggle=${JSON.stringify(KEY)}]')
      return el ? el.classList.contains('on') : null
    })()`)
    check('S3', '밖에서 설정을 바꾸면 페이지 표시도 따라온다 (main → UI)',
      shown3 === (truth1 === true),
      `설정 ${truth1} 로 되돌린 뒤 페이지 ${shown3}`)

    // ── S4: 모든 카테고리가 빈 화면 없이 렌더되는가 ──────────────────────
    const cats = await evaluate(settings, `(async () => {
      const items = [...document.querySelectorAll('.nav-item')]
      const out = []
      for (const it of items) {
        it.click()
        await new Promise((r) => setTimeout(r, 220))
        const body = document.querySelector('.content') || document.body
        const len = (body.innerText || '').trim().length
        out.push({ cat: it.dataset.cat, chars: len })
      }
      return out
    })()`, 60_000)
    const empty = cats.filter((c) => c.chars < 40)
    check('S4', '모든 설정 카테고리가 내용 있게 렌더된다',
      cats.length > 0 && empty.length === 0,
      `카테고리 ${cats.length}개 · 빈 화면 ${empty.length}개${empty.length ? ` (${empty.map((e) => e.cat).join(', ')})` : ''}`)

    // ── S5: select 표시가 실제 설정과 일치 ───────────────────────────────
    // S4 가 모든 카테고리를 훑고 **마지막 카테고리에 머물러** 있다. 거기 select 가 없으면
    // "요소를 찾지 못함"으로 실패한다 — 실제로 그렇게 한 번 틀렸다. 카테고리를 명시적으로 되돌린다.
    const sel = await evaluate(settings, `(async () => {
      const appearance = [...document.querySelectorAll('.nav-item')].find((x) => x.dataset.cat === 'appearance')
      if (appearance) { appearance.click(); await new Promise((r) => setTimeout(r, 400)) }
      const el = document.querySelector('[data-select]')
      return el ? { key: el.dataset.select, value: el.value } : null
    })()`)
    if (sel) {
      const truthSel = await evaluate(shell, `window.browserAPI.settings.get(${JSON.stringify(sel.key)})`)
      check('S5', 'select 표시가 실제 설정과 일치',
        String(truthSel) === String(sel.value),
        `${sel.key}: 페이지 "${sel.value}" vs 설정 "${truthSel}"`)
    } else {
      check('S5', 'select 표시가 실제 설정과 일치', false, 'data-select 요소를 찾지 못함')
    }

    // ── 환영 화면 ────────────────────────────────────────────────────────
    welcome = await openInternalPage(shell, windowId, 'browser://welcome', args.port, 'welcome')

    const w1 = await evaluate(welcome, `(() => {
      const step = document.getElementById('step')
      const dots = document.getElementById('dots')
      return {
        chars: (step?.innerText || '').trim().length,
        dots: dots ? dots.children.length : 0,
        hasNext: !!document.getElementById('next'),
      }
    })()`)
    check('W1', '환영 화면 1단계가 내용·진행표시·다음 버튼과 함께 렌더된다',
      w1.chars > 20 && w1.dots > 1 && w1.hasNext,
      `본문 ${w1.chars}자 · 단계 표시 ${w1.dots}개 · 다음 버튼 ${w1.hasNext}`)

    // 모든 단계를 끝까지 넘겨 본다 — 중간에 빈 화면이나 멈춤이 없어야 한다.
    const steps = await evaluate(welcome, `(async () => {
      const out = []
      for (let i = 0; i < 12; i++) {
        const step = document.getElementById('step')
        out.push({ i, chars: (step?.innerText || '').trim().length })
        const next = document.getElementById('next')
        if (!next) break
        const last = /시작하기/.test(next.textContent || '')
        if (last) break
        next.click()
        await new Promise((r) => setTimeout(r, 400))
      }
      return out
    })()`, 60_000)
    const blank = steps.filter((s) => s.chars < 20)
    check('W2', '환영 화면의 모든 단계가 빈 화면 없이 넘어간다',
      steps.length >= 2 && blank.length === 0,
      `단계 ${steps.length}개 통과 · 빈 단계 ${blank.length}개`)

    // 마지막 단계에서 "시작하기" 를 누르면 온보딩 완료가 실제로 기록되는가.
    await evaluate(shell, `window.browserAPI.settings.set('setup.completed', false)`)
    await sleep(500)
    await evaluate(welcome, `(() => { const n = document.getElementById('next'); if (n) n.click(); return true })()`)
    await sleep(1800)
    const completed = await evaluate(shell, `window.browserAPI.settings.get('setup.completed')`)
    check('W3', '"시작하기" 가 온보딩 완료를 실제로 기록한다',
      completed === true,
      `setup.completed = ${completed}`)
  } catch (err) {
    check('FATAL', '하네스 실행', false, err.message)
  } finally {
    for (const s of [settings, welcome]) { try { s?.close() } catch { /* ignore */ } }
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close', {}, 5000).catch(() => {})
      b.close()
    } catch { /* ignore */ }
    await sleep(1200)
    try { shell?.close() } catch { /* ignore */ }
    if (child.exitCode === null) {
      try { child.kill() } catch { /* ignore */ }
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    }
  }

  console.log('\n===== verify-settings-welcome 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 이름: r.name, 상태: r.status })))
  const failed = results.filter((r) => r.status !== 'PASS')
  for (const f of failed) console.log(`FAIL ${f.id}: ${f.detail}`)
  fs.writeFileSync(path.join(args.out, 'settings-welcome-results.json'), JSON.stringify(results, null, 2))
  console.log(`PASS=${results.length - failed.length} FAIL=${failed.length} (총 ${results.length})`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify-settings-welcome] 치명적 오류:', err); process.exit(2) })
