#!/usr/bin/env node
// verify-memory-page-cdp.mjs — `browser://memory` 가 보여 주는 수치를 **실제와 대조**하는 하네스.
//
// 왜 (2026-09-07, 임무 16): 이 페이지는 사용자에게 보이는 화면인데 검증이 없었다. 실제로
// 임무 9 에서 **예산 판정이 통째로 틀린 것**(WorkingSet 합을 private 예산과 비교)을 발견했다.
// 나머지 수치(탭 수·슬립 상태·프로세스 수·프로세스별 표)도 같은 방식으로 틀려 있을 수 있다.
// 화면에 뜬 숫자는 "그럴듯해 보인다"로 검증되지 않는다 — 실제와 대조해야 한다.
//
// 방법: 격리 프로필로 앱을 띄우고 탭을 정해진 수만큼 만든 뒤, browser://memory 가 표시한 값을
// ① 앱의 진짜 상태(browserAPI.tabs.list, settings) ② OS 의 실제 프로세스 수와 비교한다.
//
// 사용: node build/verify-memory-page-cdp.mjs [--port <n>] [--out <dir>]

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectSession, connectShellSessionReady, getTargetList, waitForPortFree, sleep,
} from './lib/cdp.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9245, out: path.join(REPO_ROOT, 'verify-out', 'memory-page') }
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

/** OS 가 실제로 보는 프로세스 수(이 프로필로 뜬 것만) — 페이지가 세는 수와 대조할 진짜 기준. */
function osProcessCount(profileDir) {
  if (process.platform !== 'win32') return null
  const prefix = profileDir.replace(/'/g, "''")
  const ps = [
    `Get-CimInstance Win32_Process -Filter "Name='ezBrowser.exe'"`,
    `| Where-Object { $_.CommandLine -like '*${prefix.replace(/\\/g, '\\')}*' }`,
    '| Measure-Object | Select-Object -ExpandProperty Count',
  ].join(' ')
  const res = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
  const n = Number(String(res.stdout || '').trim())
  return Number.isFinite(n) ? n : null
}

async function main() {
  fs.mkdirSync(args.out, { recursive: true })
  if (!fs.existsSync(EXE)) {
    console.error(`exe 없음: ${EXE} — 먼저 npx electron-builder --win --dir`)
    process.exit(2)
  }
  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true, completedAt: Date.now(), version: 'verify-memory' },
    startup: { mode: 'newtab', urls: [] },
  }, null, 2))

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
  let memSession = null
  try {
    shell = await connectShellSessionReady(args.port, { log: (m) => console.log(`[verify-memory] ${m}`) })
    const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)

    // 알려진 상태를 만든다 — 콘텐츠 탭 2개 추가(부팅 시 새 탭 1개가 이미 있다).
    for (const u of ['https://example.com/', 'https://example.com/?b']) {
      await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(u)})`)
      await sleep(700)
    }
    await sleep(1500)

    // browser://memory 를 열고 첫 렌더(1초 주기 갱신)를 기다린다.
    await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, 'browser://memory')`)
    const memTarget = await (async () => {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const t = (await getTargetList(args.port)).find((x) => String(x.url).startsWith('browser://memory'))
        if (t) return t
        await sleep(300)
      }
      return null
    })()
    if (!memTarget) throw new Error('browser://memory 타깃을 찾지 못함')
    memSession = await connectSession(memTarget, 'memory-page')
    await sleep(2500)

    // ── 진짜 상태 ────────────────────────────────────────────────────────
    const truth = await evaluate(shell, `(async () => {
      const tabs = await window.browserAPI.tabs.list(${JSON.stringify(windowId)})
      const sleepEnabled = await window.browserAPI.settings.get('performance.tabSleepEnabled')
      const sleepMinutes = await window.browserAPI.settings.get('performance.tabSleepMinutes')
      return {
        total: tabs.length,
        focused: tabs.filter((t) => t.active).length,
        discarded: tabs.filter((t) => t.discarded).length,
        sleepEnabled, sleepMinutes,
      }
    })()`)

    // ── 페이지가 보여 주는 값 ─────────────────────────────────────────────
    // 페이지가 보여 주는 값 — **라벨을 정확히 일치**시켜 집는다.
    // (처음엔 '프로세스' 부분일치로 집었다가 '메인 프로세스 (private bytes)' 카드의 279 를
    //  프로세스 수로 잘못 읽었다. 부분일치 스크래핑은 조용히 틀린 값을 만든다.)
    const shown = await evaluate(memSession, `(() => {
      const stat = (label) => {
        const el = [...document.querySelectorAll('.stat')]
          .find((s) => (s.querySelector('.label')?.textContent || '').trim() === label)
        if (!el) return null
        const raw = (el.querySelector('.value')?.textContent || '').replace(/[^0-9.\-]/g, '')
        const n = Number(raw)
        return Number.isFinite(n) ? n : null
      }
      const budget = (needle) => {
        const el = [...document.querySelectorAll('.budget-line')]
          .find((b) => (b.textContent || '').includes(needle))
        if (!el) return null
        const spans = el.querySelectorAll('span')
        return (spans[spans.length - 1]?.textContent || '').trim()
      }
      // 프로세스별 표는 "프로세스별 (N개)" 헤딩 바로 뒤 table 이다.
      const h = [...document.querySelectorAll('h3')].find((x) => (x.textContent || '').startsWith('프로세스별'))
      const table = h ? h.parentElement.querySelector('table') : null
      return {
        tabTotal: stat('탭 (총)'),
        tabAwake: stat('깨어 있음'),
        tabSleeping: stat('💤 슬립'),
        procCount: stat('프로세스'),
        sleepValue: budget('백그라운드 슬립'),
        procHeading: h ? (h.textContent || '').trim() : null,
        procRows: table ? table.querySelectorAll('tr').length : null,
      }
    })()`)

    const osCount = osProcessCount(profileDir)

    // ── 대조 ─────────────────────────────────────────────────────────────
    check('M1', '탭 수 표시가 실제 탭 수와 일치',
      shown.tabTotal === truth.total,
      `페이지 총 ${shown.tabTotal ?? '없음'} / 깨어 ${shown.tabAwake ?? '?'} / 슬립 ${shown.tabSleeping ?? '?'} vs 실제 총 ${truth.total} · 포커스 ${truth.focused}`)

    // 페이지의 '깨어 있음' 은 **총 − 슬립**(포커스 탭이 아니다 — system.ts 의 active 정의).
    // 처음엔 이걸 포커스 탭으로 착각해 실패로 읽었다. 검사는 페이지가 실제로 주장하는 것,
    // 즉 **총 = 깨어 있음 + 슬립** 항등식과 슬립 수의 실제 일치로 한다.
    check('M2', '탭 3분할이 정합 (총 = 깨어 있음 + 슬립) · 슬립 수가 실제와 일치',
      shown.tabTotal === (shown.tabAwake ?? 0) + (shown.tabSleeping ?? 0)
        && shown.tabSleeping === truth.discarded,
      `페이지 총 ${shown.tabTotal} = 깨어 ${shown.tabAwake} + 슬립 ${shown.tabSleeping} · 실제 슬립 ${truth.discarded}`)

    check('M3', '프로세스 수 표시가 OS 실제 프로세스 수와 일치',
      osCount !== null && shown.procCount !== null && Math.abs(shown.procCount - osCount) <= 1,
      `페이지 ${shown.procCount ?? '없음'} vs OS ${osCount ?? '측정 불가'} (±1 허용 — 측정 사이 생성/종료)`)

    // 슬립 줄의 **값 부분**만 본다. 목표 문구("30분 비활성 → discard")에도 '비활성' 이 들어 있어
    // 줄 전체를 정규식으로 보면 항상 꺼짐으로 읽힌다 — 실제로 그렇게 잘못 읽었다.
    const sleepOn = (v) => /활성/.test(v || '') && !/비활성/.test(v || '')
    check('M4', '백그라운드 슬립 상태 표시가 설정과 일치',
      sleepOn(shown.sleepValue) === (truth.sleepEnabled === true),
      `페이지 "${shown.sleepValue ?? '(없음)'}" vs 설정 ${truth.sleepEnabled}`)

    // 설정을 뒤집어도 따라오는가 — 정적 문자열이 아니라 실제 상태를 읽는지 확인한다.
    await evaluate(shell, `window.browserAPI.settings.set('performance.tabSleepEnabled', ${!truth.sleepEnabled})`)
    await sleep(2500)
    const afterValue = await evaluate(memSession, `(() => {
      const el = [...document.querySelectorAll('.budget-line')].find((b) => (b.textContent || '').includes('백그라운드 슬립'))
      if (!el) return null
      const spans = el.querySelectorAll('span')
      return (spans[spans.length - 1]?.textContent || '').trim()
    })()`)
    check('M5', '설정을 바꾸면 슬립 표시도 따라 바뀐다',
      sleepOn(afterValue) === !truth.sleepEnabled,
      `설정 ${truth.sleepEnabled} → ${!truth.sleepEnabled} 후 페이지 "${afterValue ?? '(없음)'}"`)
    await evaluate(shell, `window.browserAPI.settings.set('performance.tabSleepEnabled', ${truth.sleepEnabled})`)

    // 표 행 = 헤더 1 + 프로세스 N. 헤딩의 (N개) 와도 일치해야 한다.
    const headingN = Number((shown.procHeading || '').replace(/\D+/g, ''))
    check('M6', '프로세스별 표가 프로세스 수와 일치',
      shown.procRows !== null && shown.procCount !== null
        && shown.procRows === shown.procCount + 1 && headingN === shown.procCount,
      `표 행 ${shown.procRows}(헤더 포함) · 헤딩 "${shown.procHeading}" vs 프로세스 카드 ${shown.procCount}`)

  } catch (err) {
    check('FATAL', '하네스 실행', false, err.message)
  } finally {
    try { memSession?.close() } catch { /* ignore */ }
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

  console.log('\n===== verify-memory-page 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 이름: r.name, 상태: r.status })))
  const failed = results.filter((r) => r.status !== 'PASS')
  for (const f of failed) console.log(`FAIL ${f.id}: ${f.detail}`)
  fs.writeFileSync(path.join(args.out, 'memory-page-results.json'), JSON.stringify(results, null, 2))
  console.log(`PASS=${results.length - failed.length} FAIL=${failed.length} (총 ${results.length})`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify-memory-page] 치명적 오류:', err); process.exit(2) })
