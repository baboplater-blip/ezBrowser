#!/usr/bin/env node
// verify-error-boundary-cdp.mjs — 외피 오류 경계가 실제로 창을 살리는지 확인
//
// 왜 (2026-09-07, 임무 22): 외피에 오류 경계가 없어서, 컴포넌트가 렌더 중 한 번만 던져도
// React 가 트리 전체를 언마운트해 **탭바·주소창이 사라진 흰 외피**가 됐다.
// 회귀 #8·#9 에서 사용자가 본 화면이 바로 그것이다.
//
// 제품에 검사용 후크를 심지 않는다(그 자체가 사용자에게 나가는 코드다). 대신 사람이 임시로
// 컴포넌트를 던지게 고친 뒤 이 스크립트로 결과를 본다 — 아래 음성 대조 절차.
//
// 사용:
//   node build/verify-error-boundary-cdp.mjs            → 정상 상태(경계가 안 뜨고 외피가 멀쩡)
//   node build/verify-error-boundary-cdp.mjs --expect-boundary
//        → 일부러 던지게 만든 빌드에서 실행. 경계 안내가 뜨고 창이 살아 있어야 한다.
//
// ⚠ 한계를 숨기지 않는다: `--full` 게이트가 돌리는 것은 **정상 상태 검사**뿐이다.
//    그것이 잡는 것은 "경계가 늘 떠 있다(=외피가 무너진 채다)" 뿐이고,
//    "경계가 실제로 받는가" 는 아래 음성 대조를 **사람이** 돌려야 확인된다.
//
// 음성 대조 절차 (2026-09-07 실측):
//   1) 아무 외피 컴포넌트(예: Toolbar)의 첫 줄에 `throw new Error('음성 대조')` 를 넣는다
//   2) npm run build && npx electron-builder --win --dir
//   3) node build/verify-error-boundary-cdp.mjs --expect-boundary   → 2/2 PASS 여야 한다
//   4) main.tsx 의 <ErrorBoundary> 를 잠시 걷어내고 같은 빌드로 기본 실행
//      → EB2 가 `root 자식 0개 · 본문 0자` 로 FAIL (= 경계가 없으면 흰 외피라는 증거)
//   5) 둘 다 원복

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, waitForPortFree, connectShellSessionReady } from './lib/cdp.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9237, out: path.join(REPO, 'verify-out', 'error-boundary'), expectBoundary: false }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--expect-boundary') args.expectBoundary = true
}

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE}`)
  fs.mkdirSync(args.out, { recursive: true })
  await waitForPortFree(args.port)

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'),
    JSON.stringify({ setup: { completed: true } }, null, 2))

  const logStream = fs.createWriteStream(path.join(args.out, 'app-stdout.log'))
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream)
  child.stderr.pipe(logStream)

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    await sleep(2000)

    const r = await shell.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => ({
        boundary: !!document.querySelector('.error-boundary'),
        boundaryText: (document.querySelector('.error-boundary .eb-title') || {}).innerText || '',
        tabbar: !!document.querySelector('.tabbar'),
        toolbar: !!document.querySelector('.toolbar, .omnibox, input'),
        rootChildren: (document.getElementById('root') || { children: [] }).children.length,
        bodyText: (document.body.innerText || '').length,
      }))()`,
    })
    const v = r.result?.result?.value ?? r.result?.value

    if (args.expectBoundary) {
      // 일부러 던지게 만든 빌드: 경계 안내가 뜨고, 창이 흰 화면이 아니어야 한다.
      check('EB1', '렌더 예외를 오류 경계가 받는다', v.boundary === true,
        `경계 표시=${v.boundary} · 문구="${v.boundaryText}"`)
      check('EB2', '트리가 통째로 사라지지 않는다(흰 외피 아님)',
        v.rootChildren > 0 && v.bodyText > 0,
        `root 자식 ${v.rootChildren}개 · 본문 ${v.bodyText}자`)
    } else {
      // 평소: 경계가 뜨지 않고 외피가 정상이어야 한다.
      check('EB1', '평소에는 오류 경계가 뜨지 않는다', v.boundary === false,
        `경계 표시=${v.boundary}`)
      check('EB2', '외피가 정상으로 그려진다', v.tabbar === true && v.rootChildren > 0,
        `탭바=${v.tabbar} · root 자식 ${v.rootChildren}개 · 본문 ${v.bodyText}자`)
    }
  } catch (err) {
    check('FATAL', '하네스 실행', false, err.message)
  } finally {
    try { shell?.close() } catch { /* ignore */ }
    try {
      const ver = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: ver.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {})
      b.close()
    } catch { /* ignore */ }
    await sleep(1200)
    try { child.kill() } catch { /* ignore */ }
  }

  fs.writeFileSync(path.join(args.out, 'error-boundary-results.json'), JSON.stringify(results, null, 2))
  const fail = results.filter((x) => x.status === 'FAIL')
  console.log(`\nPASS=${results.length - fail.length} FAIL=${fail.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
