#!/usr/bin/env node
// audit-firstrun-cdp.mjs — **처음 설치한 사용자의 여정**을 그대로 따라가며 막히는 지점을 찾는 진단 하네스.
//
// 왜 (2026-09-18): 기존 하네스 32종은 전부 "기능이 규격대로 동작하는가"를 본다. 그런데 제품이
// 쓸 만한지는 **설명 없이 연결되는가**로 갈린다 — 첫 화면에서 무엇을 해야 할지 보이는가, AI 를
// 처음 누르면 쓸 수 있는 데까지 가는가, 실패했을 때 다음 행동이 있는가. 이건 PASS/FAIL 이 아니라
// **관찰**이라 별도 진단으로 둔다(게이트에 등록하지 않는다).
//
// 사용: node build/audit-firstrun-cdp.mjs [--port <n>] [--out <dir>] [--keep]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, connectShellSessionReady, getTargetList, waitForPortFree, sleep } from './lib/cdp.mjs'
import { preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9281, out: path.join(REPO_ROOT, 'verify-out', 'firstrun'), keep: false }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--keep') args.keep = true
}

const findings = []
function note(area, severity, text, evidence) {
  findings.push({ area, severity, text, evidence })
  const icon = severity === 'blocker' ? '⛔' : severity === 'friction' ? '⚠' : 'ℹ'
  console.log(`  ${icon} [${area}] ${text}${evidence ? ` — ${evidence}` : ''}`)
}

async function evaluate(session, expression, timeoutMs = 20_000) {
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
  // 설정 파일을 만들지 않는다 — 진짜 첫 실행(온보딩이 떠야 한다).

  args.port = await preferFreePort(args.port, 'audit-firstrun')
  if (!(await waitForPortFree(args.port))) { console.error(`포트 ${args.port} 사용 중`); process.exit(2) }

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`], {
    env, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutLog = path.join(args.out, 'app-stdout.log')
  child.stdout?.pipe(fs.createWriteStream(stdoutLog))
  child.stderr?.pipe(fs.createWriteStream(path.join(args.out, 'app-stderr.log')))

  let shell = null
  try {
    console.log('\n── 1. 첫 실행 ──────────────────────────────')
    shell = await connectShellSessionReady(args.port, { log: (m) => console.log(`[firstrun] ${m}`) })
    const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)
    await sleep(2500)

    const tabs0 = await evaluate(shell, `(async () => (await window.browserAPI.tabs.list(${JSON.stringify(windowId)})).map(t => ({url:t.url,title:t.title})))()`)
    console.log(`  첫 화면 탭: ${JSON.stringify(tabs0)}`)
    const onWelcome = tabs0.some((t) => String(t.url).includes('welcome'))
    if (!onWelcome) note('첫실행', 'blocker', '첫 실행인데 환영/설정 화면이 뜨지 않음', JSON.stringify(tabs0))

    // 온보딩 화면의 실제 내용 확인
    const wTarget = await findTarget(args.port, (t) => String(t.url).includes('welcome'))
    if (wTarget) {
      const w = await connectSession(wTarget, 'welcome')
      const info = await evaluate(w, `(() => {
        const s = document.getElementById('step')
        return { heading: s?.querySelector('h2')?.textContent?.trim() ?? null,
                 bodyLen: (document.body.innerText||'').length,
                 dots: document.querySelectorAll('.dot').length,
                 mentionsAi: /AI|인공지능|어시스턴트/.test(document.body.innerText||'') }
      })()`)
      console.log(`  온보딩: 단계 ${info.dots}개, 첫 제목 "${info.heading}"`)
      if (!info.mentionsAi) note('첫실행', 'friction', '온보딩 어디에도 AI 설정 단계가 없음 — 제품의 핵심 차별점인데 첫 실행에서 연결되지 않는다')

      // 끝까지 넘겨 본다
      for (let i = 0; i < 6; i++) {
        const done = await evaluate(w, `(() => { const b = document.getElementById('next'); if(!b) return 'nobtn'; const last = b.textContent.includes('시작'); b.click(); return last ? 'done' : 'next' })()`)
        await sleep(600)
        if (done === 'done' || done === 'nobtn') break
      }
      await sleep(2000)
      w.close()
    }

    const afterSetup = await evaluate(shell, `(async () => {
      const t = await window.browserAPI.tabs.list(${JSON.stringify(windowId)})
      const s = await window.browserAPI.settings?.all?.().catch(() => null)
      return { tabs: t.map(x => x.url), setupDone: s?.setup?.completed ?? null }
    })()`)
    console.log(`  온보딩 완료 후: setup.completed=${afterSetup.setupDone}, 탭=${JSON.stringify(afterSetup.tabs)}`)
    if (afterSetup.setupDone !== true) note('첫실행', 'blocker', '온보딩을 끝까지 눌러도 setup.completed 가 true 가 되지 않음', String(afterSetup.setupDone))

    console.log('\n── 2. AI 첫 사용 ───────────────────────────')
    const aiCfg = await evaluate(shell, `(async () => {
      const c = await window.browserAPI.ai.config()
      return c
    })()`)
    console.log(`  기본 제공자: ${aiCfg?.provider} / 모델: ${JSON.stringify(aiCfg?.model ?? aiCfg)}`)
    const keyStatus = await evaluate(shell, `(async () => { try { return await window.browserAPI.ai.keyStatus() } catch(e) { return String(e) } })()`)
    console.log(`  키 상태: ${JSON.stringify(keyStatus)}`)

    // AI 사이드바를 실제로 연다
    await evaluate(shell, `window.browserAPI.actions.run('action.ai.open', { windowId: ${JSON.stringify(windowId)} })`)
    await sleep(4000)
    const panelDump = await evaluate(shell, `(() => {
      const p = document.querySelector('.sidepanel')
      return { panels: document.querySelectorAll('.sidepanel').length,
               classes: [...document.querySelectorAll('.sidepanel')].map(x => x.className),
               text: p ? (p.innerText||'').slice(0,400) : null }
    })()`)
    console.log(`  사이드패널 상태: ${JSON.stringify(panelDump)}`)
    const aiUi = await evaluate(shell, `(() => {
      // 준비 전이면 .ai-setup, 준비되면 .ai-tab — 둘 다 "패널이 떴다" 는 뜻이다.
      const t = document.querySelector('.ai-tab, .ai-setup')
      if (!t) return { mounted: false }
      const txt = t.innerText || ''
      return { mounted: true, text: txt.slice(0, 700),
               hasSetupCard: /키|설정|연결/.test(txt),
               inputDisabled: !!t.querySelector('textarea[disabled], input[disabled]'),
               buttons: [...t.querySelectorAll('button')].map(b => (b.textContent||'').trim()).filter(Boolean).slice(0, 14) }
    })()`)
    if (!aiUi.mounted) note('AI', 'blocker', 'action.ai.open 을 실행해도 AI 패널이 마운트되지 않음')
    else {
      console.log(`  AI 패널 텍스트(앞부분):\n---\n${aiUi.text}\n---`)
      console.log(`  버튼: ${JSON.stringify(aiUi.buttons)}`)
      const t = aiUi.text || ''
      // 설정 화면으로 갈 수 있는 실제 진입점이 패널 안에 있는가?
      const hasEntry = /설정.*열기|설정으로|연결하기|시작하기|키 입력/.test(t) || aiUi.buttons.some((b) => /설정|연결|시작/.test(b))
      if (!hasEntry) note('AI', 'blocker', 'AI 를 처음 열었을 때 패널 안에서 연결을 시작할 방법이 없음(설정 열기 버튼 없음)', JSON.stringify(aiUi.buttons))
    }

    // 사용 가능한 CLI 제공자가 실제로 있는지 — 있는데 안내하지 않으면 그 자체가 결함
    const cliProbe = await evaluate(shell, `(async () => {
      try { return await window.browserAPI.ai.detectProviders?.() ?? 'no-api' } catch(e) { return 'err:'+String(e) }
    })()`)
    console.log(`  사용 가능 제공자 자동 탐지: ${JSON.stringify(cliProbe)}`)
    if (cliProbe === 'no-api') note('AI', 'friction', '설치된 CLI(claude/codex/gemini)를 자동 탐지하는 경로가 없음 — 사용자가 제공자를 직접 알아내 골라야 한다')

    console.log('\n── 3. 일상 탐색 ────────────────────────────')
    // 한국어 검색어를 주소창 규칙대로 해석하는가
    const searchUrl = await evaluate(shell, `(async () => {
      try { return await window.browserAPI.omnibox.resolve?.('날씨') ?? 'no-api' } catch(e) { return 'err:'+String(e) }
    })()`)
    console.log(`  omnibox '날씨' 해석: ${JSON.stringify(searchUrl)}`)

    await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, 'browser://newtab')`)
    await sleep(1200)
    const newtabT = await findTarget(args.port, (t) => String(t.url).startsWith('browser://newtab'), 8000)
    if (newtabT) {
      const nt = await connectSession(newtabT, 'newtab')
      const ntInfo = await evaluate(nt, `(() => ({ len: (document.body.innerText||'').length,
        text: (document.body.innerText||'').slice(0, 300),
        errors: [...document.querySelectorAll('.error, .failed')].length }))()`)
      console.log(`  새 탭 내용(${ntInfo.len}자): ${JSON.stringify(ntInfo.text)}`)
      if (ntInfo.len < 30) note('탐색', 'friction', '새 탭이 거의 비어 있음', `${ntInfo.len}자`)
      nt.close()
    }

    console.log('\n── 4. 로그 점검 ────────────────────────────')
    await sleep(1000)
    const log = fs.existsSync(stdoutLog) ? fs.readFileSync(stdoutLog, 'utf8') : ''
    const errLines = log.split(/\r?\n/).filter((l) => /error|ERR_|failed|Unhandled|Exception/i.test(l)).slice(0, 12)
    if (errLines.length) {
      note('로그', 'friction', `부팅 로그에 오류성 줄 ${errLines.length}개`, errLines[0]?.slice(0, 160))
      errLines.forEach((l) => console.log(`    · ${l.slice(0, 180)}`))
    } else console.log('  부팅 로그 깨끗')

    fs.writeFileSync(path.join(args.out, 'findings.json'), JSON.stringify({ at: new Date().toISOString(), findings }, null, 2))
    console.log(`\n관찰 ${findings.length}건 — ${path.join(args.out, 'findings.json')}`)
  } finally {
    try { shell?.close() } catch {}
    if (!args.keep) {
      try {
        const s = await connectShellSessionReady(args.port, { totalMs: 8000 }).catch(() => null)
        s?.close()
      } catch {}
      try { child.kill() } catch {}
      await sleep(1500)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
