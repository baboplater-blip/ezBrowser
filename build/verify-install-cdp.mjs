#!/usr/bin/env node
// verify-install-cdp.mjs — NSIS 설치본이 설치·실행·제거되는가 (사용자 환경 무접촉)
//
// 왜 (2026-09-07, 임무 35): 우리가 늘 검증하는 것은 `dist/win-unpacked` 다. 그런데 사용자에게
// 가는 것은 **NSIS 설치본**이고, 그 사이에는 파일 추출·레지스트리·바로가기·자동 실행이 있다.
// 릴리즈-1 라운드에서 한 번 손으로 확인했지만 그 뒤 수십 라운드의 변경은 확인되지 않았다.
//
//   I1 무인 설치가 성공한다(종료코드 0)
//   I2 설치된 exe 가 실제로 뜬다(CDP 로 외피 확인)
//   I3 바로가기·레지스트리가 등록된다
//   I4 무인 제거가 성공하고 잔재가 남지 않는다
//
// ⚠ 사용자 환경 보호 (릴리즈-1 에서 확립한 절차):
//   - oneClick 설치본은 설치 직후 **자동 실행**된다. 그대로 두면 사용자의 실제 프로필
//     (%APPDATA%/browser-build)에 쓰기가 일어난다. 그래서 설치 중에는 `ELECTRON_RUN_AS_NODE=1`
//     을 걸어 자동 실행된 앱이 창·프로필 없이 즉시 끝나게 한다.
//   - 부팅 검증은 **격리 프로필**(--user-data-dir)로만 한다.
//   - 검증이 끝나면 반드시 제거한다.
//
// ⚠ 이 하네스는 **게이트에 넣지 않는다** — 매 검증마다 사용자 머신에 소프트웨어를 설치하는 것은
//   너무 침습적이다. 출시 전에 사람이 직접 돌린다.
//
// ⚠ 연속 실행 주의: 제거 직후 곧바로 다시 설치하면 설치 프로그램이 0xC0000005 로 죽는다(실측 2회).
//   레지스트리·디렉터리는 깨끗한데도 그렇다 — 파일 시스템·백신이 정착할 시간이 필요한 것으로 보인다.
//   **30초 이상 두고** 다시 돌리면 정상 통과한다. 원인은 더 좁히지 못했다(설치 프로그램 내부).
//
// 사용: node build/verify-install-cdp.mjs [--port <n>] [--out <dir>]

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, waitForPortFree, connectShellSessionReady } from './lib/cdp.mjs'
import { preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const INSTALLER = path.join(REPO, 'dist', 'ezBrowser-0.1.0-win-x64.exe')

const args = { port: 9267, out: path.join(REPO, 'verify-out', 'install') }
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

const ps = (cmd) => {
  try { return execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 20000 }).trim() }
  catch { return '' }
}

async function main() {
  if (!fs.existsSync(INSTALLER)) throw new Error(`설치본 없음: ${INSTALLER} — 먼저 npm run package:win`)
  fs.mkdirSync(args.out, { recursive: true })
  args.port = await preferFreePort(args.port, 'install')

  const installRoot = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'Programs', 'browser-build')
  const realProfile = path.join(process.env.APPDATA ?? os.tmpdir(), 'browser-build')
  const realProfileBefore = fs.existsSync(realProfile)
    ? fs.readdirSync(realProfile).length : -1

  // 앞선 실행의 잔재를 먼저 치운다. NSIS 는 `_?=` 로 제거하면 **제거기 자신을 남긴다**(알려진 동작)
  // — 그 잔재가 남아 있으면 다음 설치가 0xC0000005 로 깨진다(2026-09-07 실측).
  if (fs.existsSync(installRoot)) {
    const left = fs.readdirSync(installRoot)
    if (left.length && left.every((f) => /^Uninstall .*\.exe$/i.test(f))) {
      for (const f of left) { try { fs.unlinkSync(path.join(installRoot, f)) } catch { /* ignore */ } }
      try { fs.rmdirSync(installRoot) } catch { /* ignore */ }
      console.log('  (앞선 검사가 남긴 제거기 잔재를 정리했다)')
    }
  }

  let installed = false
  try {
    // ---- I1 무인 설치 ----
    {
      // ELECTRON_RUN_AS_NODE: 설치 직후 자동 실행되는 앱을 **창·프로필 없이** 끝내 사용자 환경을 지킨다.
      let code = -1
      try {
        execFileSync(INSTALLER, ['/S'], {
          timeout: 180000,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        })
        code = 0
      } catch (e) { code = e.status ?? -1 }
      await sleep(4000)
      const exe = path.join(installRoot, 'ezBrowser.exe')
      installed = fs.existsSync(exe)
      const fileCount = installed ? fs.readdirSync(installRoot).length : 0
      check('I1', '무인 설치가 성공한다', code === 0 && installed,
        `종료코드 ${code} · 설치 위치 ${installRoot} · 파일 ${fileCount}개`)
    }

    // ---- I2 설치된 exe 가 실제로 뜬다(격리 프로필) ----
    if (installed) {
      const exe = path.join(installRoot, 'ezBrowser.exe')
      const profileDir = path.join(args.out, 'profile')
      fs.rmSync(profileDir, { recursive: true, force: true })
      fs.mkdirSync(profileDir, { recursive: true })
      fs.writeFileSync(path.join(profileDir, 'settings.json'),
        JSON.stringify({ setup: { completed: true }, startup: { mode: 'newtab', urls: [] } }, null, 2))
      await waitForPortFree(args.port)
      const logStream = fs.createWriteStream(path.join(args.out, 'app.log'))
      const child = spawn(exe, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
        { stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.pipe(logStream); child.stderr.pipe(logStream)
      let ok = false, detail = ''
      try {
        const shell = await connectShellSessionReady(args.port)
        // 외피 React 트리가 마운트될 때까지 기다린다 — 연결 직후 바로 읽으면 렌더 전이다.
        let v = null
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) {
          v = await shell.send('Runtime.evaluate', {
            returnByValue: true,
            expression: '(() => ({ api: !!window.browserAPI, tabbar: !!document.querySelector(".tabbar"), root: (document.getElementById("root")||{children:[]}).children.length, href: location.href }))()',
          }).then((r) => r.result?.result?.value ?? r.result?.value)
          if (v?.tabbar) break
          await sleep(500)
        }
        ok = v?.api === true && v?.tabbar === true
        detail = `API=${v?.api} · 탭바=${v?.tabbar} · root 자식 ${v?.root}개 · 로드 경로=${String(v?.href ?? '').includes('app.asar') ? 'app.asar(설치본)' : String(v?.href ?? '').slice(0, 60)}`
        shell.close()
      } catch (e) { detail = e.message }
      try {
        const ver = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
        const b = await connectSession({ webSocketDebuggerUrl: ver.webSocketDebuggerUrl }, 'browser')
        await b.send('Browser.close').catch(() => {}); b.close()
      } catch { /* ignore */ }
      await sleep(1500)
      try { child.kill() } catch { /* ignore */ }
      check('I2', '설치된 exe 가 실제로 뜨고 외피가 그려진다', ok, detail)
    } else {
      check('I2', '설치된 exe 가 실제로 뜨고 외피가 그려진다', false, '설치가 안 돼 확인 불가')
    }

    // ---- I3 바로가기·레지스트리 ----
    if (installed) {
      const startMenu = ps('$p = "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs"; '
        + '(Get-ChildItem -Path $p -Recurse -Filter "*ezBrowser*" -ErrorAction SilentlyContinue).Count')
      const reg = ps('(Get-ChildItem "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" '
        + '-ErrorAction SilentlyContinue | Where-Object { $_.GetValue("DisplayName") -like "*ezBrowser*" }).Count')
      check('I3', '바로가기와 제거 정보가 등록된다',
        Number(startMenu) > 0 && Number(reg) > 0,
        `시작 메뉴 바로가기 ${startMenu || 0}개 · 제거 레지스트리 ${reg || 0}개`)
    } else {
      check('I3', '바로가기와 제거 정보가 등록된다', false, '설치가 안 돼 확인 불가')
    }

    // ---- I4 무인 제거 ----
    if (installed) {
      const uninst = path.join(installRoot, 'Uninstall ezBrowser.exe')
      let code = -1
      if (fs.existsSync(uninst)) {
        try {
          execFileSync(uninst, ['/S', '/currentuser', `_?=${installRoot}`], { timeout: 180000 })
          code = 0
        } catch (e) { code = e.status ?? -1 }
      }
      await sleep(6000)
      const stillThere = fs.existsSync(path.join(installRoot, 'ezBrowser.exe'))
      // 제거기 자신이 남는 것은 NSIS 동작이다 — 우리가 만든 것이니 우리가 치운다.
      try {
        for (const f of fs.readdirSync(installRoot)) {
          if (/^Uninstall .*\.exe$/i.test(f)) fs.unlinkSync(path.join(installRoot, f))
        }
        fs.rmdirSync(installRoot)
      } catch { /* 이미 없으면 그만 */ }
      const regAfter = ps('(Get-ChildItem "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" '
        + '-ErrorAction SilentlyContinue | Where-Object { $_.GetValue("DisplayName") -like "*ezBrowser*" }).Count')
      check('I4', '무인 제거가 성공하고 잔재가 남지 않는다',
        !stillThere && Number(regAfter || 0) === 0,
        `제거 종료코드 ${code} · exe 잔존=${stillThere} · 레지스트리 잔존 ${regAfter || 0}개`)
    } else {
      check('I4', '무인 제거가 성공하고 잔재가 남지 않는다', false, '설치가 안 돼 확인 불가')
    }

    // ---- 사용자 실제 프로필이 건드려지지 않았는지 ----
    {
      const after = fs.existsSync(realProfile) ? fs.readdirSync(realProfile).length : -1
      check('I5', '사용자의 실제 프로필을 건드리지 않았다', after === realProfileBefore,
        `검사 전 ${realProfileBefore === -1 ? '(없음)' : realProfileBefore + '개'} → 후 ${after === -1 ? '(없음)' : after + '개'}`)
    }
  } catch (err) {
    check('FATAL', '하네스 실행', false, err.message)
  }

  fs.writeFileSync(path.join(args.out, 'install-results.json'), JSON.stringify(results, null, 2))
  console.log('\n===== verify-install 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL')
  console.log(`PASS=${results.length - fail.length} FAIL=${fail.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
