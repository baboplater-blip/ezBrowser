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

      // ---- I2b/I2c 설치본으로 실제 일상 사용 → 재시작 복원 ----
      //   (2026-09-18) "뜬다" 는 쓸 수 있다는 뜻이 아니다. 사용자가 실제로 하는 것 —
      //   탭 열고 주소창으로 이동하고 북마크하고, 껐다 켜면 그대로 있는지 — 를 설치본으로 확인한다.
      if (ok) {
        // 세션 복원을 켜 둔다(껐다 켜도 탭이 남는 설정 — 이게 없으면 새 탭으로 시작하는 게 정상이다).
        fs.writeFileSync(path.join(profileDir, 'settings.json'),
          JSON.stringify({ setup: { completed: true }, startup: { mode: 'last-session', urls: [] } }, null, 2))

        const runInstalled = async (label) => {
          await waitForPortFree(args.port)
          const c = spawn(exe, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
            { stdio: ['ignore', 'pipe', 'pipe'] })
          c.stdout.pipe(fs.createWriteStream(path.join(args.out, `app-${label}.log`)))
          c.stderr.pipe(fs.createWriteStream(path.join(args.out, `app-${label}.err.log`)))
          const sh = await connectShellSessionReady(args.port)
          const ev = async (expr, ms = 25000) => {
            const r = await sh.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms)
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'JS 예외')
            return r.result?.value
          }
          return { child: c, shell: sh, ev }
        }

        let use = null
        let daily = null
        let restored = null
        try {
          use = await runInstalled('daily')
          const wid = await use.ev(`new URL(location.href).searchParams.get('windowId')`)
          await sleep(1500)
          // 한국어 검색어와 주소를 주소창 규칙 그대로 넣는다(사용자가 실제로 하는 입력).
          await use.ev(`window.browserAPI.omnibox.navigate(${JSON.stringify(wid)}, undefined, '날씨')`)
          await sleep(1200)
          await use.ev(`window.browserAPI.tabs.create(${JSON.stringify(wid)}, 'browser://history')`)
          await sleep(900)
          await use.ev(`window.browserAPI.tabs.create(${JSON.stringify(wid)}, 'browser://bookmarks')`)
          await sleep(1400)
          daily = await use.ev(`(async () => {
            const tabs = await window.browserAPI.tabs.list(${JSON.stringify(wid)})
            return { count: tabs.length, urls: tabs.map(t => t.url) }
          })()`)

          // 뒤로/앞으로 — 한 탭 안에서 두 곳을 거친 뒤 되돌아갔다 다시 오는 동작.
          //   ⚠ 이력이 하나뿐인 탭에서 '뒤로'를 누르면 아무 일도 안 일어나는 것이 **정상**이다.
          //     그래서 먼저 두 번째 페이지로 이동해 실제 이력을 만든 뒤에 검사한다.
          const nav = await use.ev(`(async () => {
            const wid = ${JSON.stringify(wid)}
            const tabs = await window.browserAPI.tabs.list(wid)
            const t = tabs.find(x => /^https?:/.test(x.url))
            if (!t) return { ok: false, why: '외부 페이지 탭 없음' }
            await window.browserAPI.tabs.activate(t.id)
            const first = t.url
            const urlOf = async () => (await window.browserAPI.tabs.list(wid)).find(x => x.id === t.id)?.url
            const settle = async (want, ms) => {
              const end = Date.now() + ms
              while (Date.now() < end) {
                const u = await urlOf()
                if (want(u)) return u
                await new Promise(r => setTimeout(r, 400))
              }
              return await urlOf()
            }
            // 같은 탭에서 두 번째 페이지로 — 여기서 이력이 2개가 된다.
            await window.browserAPI.tabs.navigate(t.id, 'https://example.com/')
            const second = await settle(u => /example\\.com/.test(u || ''), 20000)
            if (!/example\\.com/.test(second || '')) return { ok: false, why: '두 번째 페이지 로드 실패', first, second }
            await window.browserAPI.tabs.back(t.id)
            const back = await settle(u => u === first, 20000)
            await window.browserAPI.tabs.forward(t.id)
            const fwd = await settle(u => /example\\.com/.test(u || ''), 20000)
            return { ok: back === first && /example\\.com/.test(fwd || ''), first, second, back, fwd }
          })()`, 90000)
          check('I2d', '설치본에서 뒤로/앞으로가 동작한다', nav.ok === true,
            nav.ok
              ? `이동 → 뒤로(${String(nav.back).slice(0, 34)}) → 앞으로(${String(nav.fwd).slice(0, 30)})`
              : `${nav.why ?? ''} 뒤로=${String(nav.back).slice(0, 34)} 앞으로=${String(nav.fwd).slice(0, 34)}`)

          // 북마크 — 추가하면 실제 목록에 남는가.
          const bm = await use.ev(`(async () => {
            const wid = ${JSON.stringify(wid)}
            const tabs = await window.browserAPI.tabs.list(wid)
            const t = tabs.find(x => /^https?:/.test(x.url))
            if (!t) return { ok: false }
            await window.browserAPI.tabs.activate(t.id)
            await window.browserAPI.actions.run('action.bookmark.add', { windowId: wid, tabId: t.id })
            await new Promise(r => setTimeout(r, 1500))
            const saved = await window.browserAPI.bookmarks.isBookmarked(t.url)
            return { ok: saved === true, url: t.url }
          })()`, 40000)
          check('I2e', '설치본에서 북마크 추가가 실제로 저장된다', bm.ok === true,
            bm.ok ? `저장됨: ${String(bm.url).slice(0, 50)}` : '저장 확인 실패')
          // 주소창이 한국어 검색어를 검색 URL 로 바꿔 실제로 이동했는가.
          const searched = (daily.urls || []).some((u) => /[?&](q|query|wd)=/.test(u) || /search/i.test(u))
          check('I2b', '설치본에서 일상 탐색이 된다(한국어 검색·탭·내부 페이지)',
            daily.count >= 3 && searched,
            `탭 ${daily.count}개 · 검색 이동 ${searched ? '성공' : '실패'} · ${(daily.urls || []).map((u) => String(u).slice(0, 44)).join(' | ')}`)
          // 정상 종료로 세션을 확정시킨다.
          try {
            const ver = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
            const b = await connectSession({ webSocketDebuggerUrl: ver.webSocketDebuggerUrl }, 'browser')
            await b.send('Browser.close').catch(() => {}); b.close()
          } catch { /* ignore */ }
          await sleep(2500)
          try { use.shell.close() } catch { /* ignore */ }
          try { use.child.kill() } catch { /* ignore */ }
          await sleep(1500)

          // 다시 켠다 — 사용자가 브라우저를 닫았다 여는 그 동작.
          const again = await runInstalled('restore')
          await sleep(3500)
          restored = await again.ev(`(async () => {
            const wid = new URL(location.href).searchParams.get('windowId')
            const tabs = await window.browserAPI.tabs.list(wid)
            return { count: tabs.length, urls: tabs.map(t => t.url) }
          })()`)
          const before = new Set((daily.urls || []).map((u) => String(u).split('#')[0]))
          const kept = (restored.urls || []).filter((u) => before.has(String(u).split('#')[0])).length
          check('I2c', '설치본을 껐다 켜면 쓰던 탭이 그대로 돌아온다',
            restored.count >= daily.count - 1 && kept >= Math.max(2, daily.count - 1),
            `이전 ${daily.count}개 → 복원 ${restored.count}개 (같은 주소 ${kept}개)`)
          try {
            const ver = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
            const b = await connectSession({ webSocketDebuggerUrl: ver.webSocketDebuggerUrl }, 'browser')
            await b.send('Browser.close').catch(() => {}); b.close()
          } catch { /* ignore */ }
          await sleep(1500)
          try { again.shell.close() } catch { /* ignore */ }
          try { again.child.kill() } catch { /* ignore */ }
        } catch (e) {
          check('I2b', '설치본에서 일상 탐색이 된다(한국어 검색·탭·내부 페이지)', false, e.message)
          check('I2c', '설치본을 껐다 켜면 쓰던 탭이 그대로 돌아온다', false, '앞 단계 실패로 확인 불가')
          try { use?.shell?.close() } catch { /* ignore */ }
          try { use?.child?.kill() } catch { /* ignore */ }
        }
        await sleep(1200)
      }
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
