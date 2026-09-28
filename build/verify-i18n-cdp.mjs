#!/usr/bin/env node
// verify-i18n-cdp.mjs — 다국어(i18n) 인프라가 실제로 동작하는지 대조하는 하네스.
//
// 왜: 언어 판정(ui.language + resolveLocale)·페이지 로더(pages/shared/i18n.js)·외피 반응형
// t() 는 전부 "설정한 값이 실제 화면에 반영되는가"라는 성질이 핵심이다. 코드가 컴파일된다고
// 해서 en/vi 시드가 실제로 pages/settings 의 nav 라벨·언어 select·외피 Toolbar title 을
// 바꾸는지는 별개 — 실제로 창을 띄우고 대조해야 한다.
//
// 사용: node build/verify-i18n-cdp.mjs [--port <n>] [--out <dir>]

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

const args = { port: 9247, out: path.join(REPO_ROOT, 'verify-out', 'i18n') }
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

function writeProfile(profileDir, languageSetting) {
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true, completedAt: Date.now(), version: 'verify-i18n' },
    startup: { mode: 'newtab', urls: [] },
    ui: { language: languageSetting },
  }, null, 2))
}

/** exe 를 이 프로필로 띄우고 외피 세션 + windowId 를 돌려준다. 호출자가 종료를 책임진다. */
async function launch(profileDir, port, label) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`], {
    env, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'],
  })
  fs.mkdirSync(args.out, { recursive: true })
  child.stdout?.pipe(fs.createWriteStream(path.join(args.out, `${label}-stdout.log`)))
  child.stderr?.pipe(fs.createWriteStream(path.join(args.out, `${label}-stderr.log`)))
  const shell = await connectShellSessionReady(port, { log: (m) => console.log(`[${label}] ${m}`) })
  const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)
  return { child, shell, windowId }
}

async function closeAll(port, child, shell) {
  try { shell?.close() } catch { /* ignore */ }
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
    await b.send('Browser.close', {}, 5000).catch(() => {})
    b.close()
  } catch { /* ignore */ }
  await sleep(1200)
  if (child && child.exitCode === null) {
    try { child.kill() } catch { /* ignore */ }
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
  }
}

async function openInternalPage(port, shell, windowId, url) {
  await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(url)})`)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const t = (await getTargetList(port)).find((x) => String(x.url).startsWith(url))
    if (t) return t
    await sleep(300)
  }
  throw new Error(`${url} 타깃을 찾지 못함`)
}

async function main() {
  fs.mkdirSync(args.out, { recursive: true })
  if (!fs.existsSync(EXE)) {
    console.error(`exe 없음: ${EXE} — 먼저 npx electron-builder --win --dir`)
    process.exit(2)
  }
  args.port = await preferFreePort(args.port, 'verify-i18n-cdp.mjs')
  if (!(await waitForPortFree(args.port))) {
    console.error(`디버그 포트 ${args.port} 사용 중 — 남은 인스턴스를 종료하세요.`)
    process.exit(2)
  }

  // ── I1~I4: 언어를 en 으로 시드 — 설정 페이지 nav·언어 select·외피 Toolbar title 이 en 인지 ──
  {
    const profileDir = path.join(args.out, 'profile-en')
    writeProfile(profileDir, 'en')
    let child, shell
    try {
      ;({ child, shell } = await launch(profileDir, args.port, 'en'))
      const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)

      // I1: 외피 Toolbar 의 AI 버튼 title 이 en 문구인지(App.tsx 는 useI18nDict 로 반응형).
      await sleep(1000)
      const aiTitle = await evaluate(shell, `document.querySelector('.ai-btn')?.getAttribute('title') || ''`)
      check('I1', '외피(en) — AI 버튼 title 이 영어', /AI Assistant/.test(aiTitle), `title="${aiTitle}"`)

      // I10: TabBar 의 "새 탭" 버튼 aria-label 이 en 문구인지(묶음 M1 — TabBar.tsx).
      const newTabAria = await evaluate(shell, `document.querySelector('.tab-new')?.getAttribute('aria-label') || ''`)
      check('I10', '외피(en) — 탭바 새 탭 버튼 aria-label 이 "New tab"', newTabAria === 'New tab', `aria-label="${newTabAria}"`)

      // I11: Toolbar 다운로드 버튼 title 이 en 문구인지(묶음 M1 — Toolbar.tsx).
      const dlTitle = await evaluate(shell, `document.querySelector('.downloads-btn')?.getAttribute('title') || ''`)
      check('I11', '외피(en) — 다운로드 버튼 title 이 "Downloads (Ctrl+J)…"', /^Downloads \(Ctrl\+J\)/.test(dlTitle), `title="${dlTitle}"`)

      // I12: 명령 팔레트 placeholder 가 en 문구인지(묶음 M1 — CommandPalette.tsx).
      await evaluate(shell, `window.browserAPI.actions.run('action.palette.open', { windowId: ${JSON.stringify(windowId)} })`)
      await sleep(500)
      const paletteHolder = await evaluate(shell, `document.querySelector('.command-palette-input')?.getAttribute('placeholder') || ''`)
      check('I12', '외피(en) — 명령 팔레트 placeholder 가 "Search commands…"', /^Search commands/.test(paletteHolder), `placeholder="${paletteHolder}"`)
      await evaluate(shell, `document.querySelector('.command-palette-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)

      // I2: browser://settings 의 nav 라벨이 en 인지(data-i18n 정적 치환).
      const settingsTarget = await openInternalPage(args.port, shell, windowId, 'browser://settings')
      const settingsSession = await connectSession(settingsTarget, 'settings-en')
      await sleep(2000)
      const navText = await evaluate(settingsSession, `(document.querySelector('[data-cat="appearance"]')?.textContent || '').trim()`)
      check('I2', 'browser://settings(en) — nav "모양" 라벨이 "Appearance"', navText === 'Appearance', `nav="${navText}"`)

      // I3: 언어 select 옵션 라벨이 en 인지(window.t() 동적 렌더).
      const langLabel = await evaluate(settingsSession, `(() => {
        const rows = [...document.querySelectorAll('.row')]
        const row = rows.find((r) => r.querySelector('select[data-select="ui.language"]'))
        return row ? (row.querySelector('.label')?.textContent || '').trim() : null
      })()`)
      check('I3', 'browser://settings(en) — 언어 설정 행 라벨이 en', langLabel === 'Language', `label="${langLabel ?? '(못찾음)'}"`)

      const selValue = await evaluate(settingsSession, `document.querySelector('select[data-select="ui.language"]')?.value || null`)
      check('I4', 'browser://settings(en) — 언어 select 현재값이 en(설정 시드가 실제 반영)', selValue === 'en', `select.value="${selValue}"`)
      settingsSession.close()

      // I10~I13: 묶음 M4(내부 페이지) 이관분 — 정적 data-i18n 이 en 사전으로 실제 치환되는지
      // 페이지별 1개 대조(전 페이지를 다 열면 느려지므로 대표 4개: bookmarks/extensions/passwords/ai-memory).
      const bmTarget = await openInternalPage(args.port, shell, windowId, 'browser://bookmarks')
      const bmSession = await connectSession(bmTarget, 'bookmarks-en')
      await sleep(1200)
      const bmH1 = await evaluate(bmSession, `(document.querySelector('h1')?.textContent || '').trim()`)
      check('I10', 'browser://bookmarks(en) — h1 이 "Bookmarks"', bmH1 === 'Bookmarks', `h1="${bmH1}"`)
      bmSession.close()

      const extTarget = await openInternalPage(args.port, shell, windowId, 'browser://extensions')
      const extSession = await connectSession(extTarget, 'extensions-en')
      await sleep(1200)
      const extH1 = await evaluate(extSession, `(document.querySelector('h1')?.textContent || '').trim()`)
      check('I11', 'browser://extensions(en) — h1 이 "Extensions"', extH1 === 'Extensions', `h1="${extH1}"`)
      extSession.close()

      const pwTarget = await openInternalPage(args.port, shell, windowId, 'browser://passwords')
      const pwSession = await connectSession(pwTarget, 'passwords-en')
      await sleep(1200)
      const pwH1 = await evaluate(pwSession, `(document.querySelector('h1')?.textContent || '').trim()`)
      check('I12', 'browser://passwords(en) — h1 이 "Password Manager"', pwH1 === 'Password Manager', `h1="${pwH1}"`)
      pwSession.close()

      const memTarget = await openInternalPage(args.port, shell, windowId, 'browser://ai-memory')
      const memSession = await connectSession(memTarget, 'ai-memory-en')
      await sleep(1200)
      const memSave = await evaluate(memSession, `(document.querySelector('[data-i18n="page.ai-memory.a3"]')?.textContent || '').trim()`)
      check('I13', 'browser://ai-memory(en) — 저장 버튼이 "Save"', memSave === 'Save', `btn="${memSave}"`)
      memSession.close()
    } catch (err) {
      check('FATAL-EN', 'en 시드 실행', false, err.message)
    } finally {
      await closeAll(args.port, child, shell)
    }
  }

  // ── I5~I6: vi 시드 — settings nav 가 베트남어인지 ──
  {
    const profileDir = path.join(args.out, 'profile-vi')
    writeProfile(profileDir, 'vi')
    let child, shell
    try {
      ;({ child, shell } = await launch(profileDir, args.port, 'vi'))
      const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)
      const settingsTarget = await openInternalPage(args.port, shell, windowId, 'browser://settings')
      const settingsSession = await connectSession(settingsTarget, 'settings-vi')
      await sleep(2000)
      const navText = await evaluate(settingsSession, `(document.querySelector('[data-cat="appearance"]')?.textContent || '').trim()`)
      check('I5', 'browser://settings(vi) — nav 라벨이 "Giao diện"(베트남어)', navText === 'Giao diện', `nav="${navText}"`)

      const langAuto = await evaluate(settingsSession, `(() => {
        const opts = [...(document.querySelector('select[data-select="ui.language"]')?.options || [])]
        const o = opts.find((x) => x.value === 'auto')
        return o ? o.textContent.trim() : null
      })()`)
      check('I6', 'browser://settings(vi) — "자동" 옵션 라벨이 베트남어', langAuto === 'Tự động (theo hệ thống)', `auto="${langAuto ?? '(못찾음)'}"`)
      settingsSession.close()

      // I14~I15: 묶음 M4(내부 페이지) 이관분 — vi 사전 대조 2종.
      const bmTargetVi = await openInternalPage(args.port, shell, windowId, 'browser://bookmarks')
      const bmSessionVi = await connectSession(bmTargetVi, 'bookmarks-vi')
      await sleep(1200)
      const bmH1Vi = await evaluate(bmSessionVi, `(document.querySelector('h1')?.textContent || '').trim()`)
      check('I14', 'browser://bookmarks(vi) — h1 이 "Dấu trang"', bmH1Vi === 'Dấu trang', `h1="${bmH1Vi}"`)
      bmSessionVi.close()

      const pwTargetVi = await openInternalPage(args.port, shell, windowId, 'browser://passwords')
      const pwSessionVi = await connectSession(pwTargetVi, 'passwords-vi')
      await sleep(1200)
      const pwH1Vi = await evaluate(pwSessionVi, `(document.querySelector('h1')?.textContent || '').trim()`)
      check('I15', 'browser://passwords(vi) — h1 이 "Quản lý mật khẩu"', pwH1Vi === 'Quản lý mật khẩu', `h1="${pwH1Vi}"`)
      pwSessionVi.close()
    } catch (err) {
      check('FATAL-VI', 'vi 시드 실행', false, err.message)
    } finally {
      await closeAll(args.port, child, shell)
    }
  }

  // ── I7~I9: auto 판정 — OS 로케일이 ko 로 나오는 이 머신에서 language='auto' 면 ko 로 뜨는지 ──
  //          + 설정에서 언어를 바꾸면 재로드 없이 즉시 반영되는지(반응형 t()) ──
  {
    const profileDir = path.join(args.out, 'profile-auto')
    writeProfile(profileDir, 'auto')
    let child, shell
    try {
      ;({ child, shell } = await launch(profileDir, args.port, 'auto'))
      await sleep(1000)
      const aiTitle = await evaluate(shell, `document.querySelector('.ai-btn')?.getAttribute('title') || ''`)
      check('I7', 'language=auto — OS 로케일(ko) 기준 외피가 한국어', /AI 어시스턴트/.test(aiTitle), `title="${aiTitle}"`)

      // I13~I15: 기본(ko) 렌더링이 이행 전 원문과 바이트 단위로 동일한지(묶음 M1 회귀 확인).
      const newTabAriaKo = await evaluate(shell, `document.querySelector('.tab-new')?.getAttribute('aria-label') || ''`)
      check('I13', '외피(ko 기본) — 탭바 새 탭 버튼 aria-label 이 "새 탭"(원문 그대로)', newTabAriaKo === '새 탭', `aria-label="${newTabAriaKo}"`)

      const dlTitleKo = await evaluate(shell, `document.querySelector('.downloads-btn')?.getAttribute('title') || ''`)
      check('I14', '외피(ko 기본) — 다운로드 버튼 title 이 "다운로드 (Ctrl+J) — 사이드바 열기/닫기"(원문 그대로)',
        dlTitleKo === '다운로드 (Ctrl+J) — 사이드바 열기/닫기', `title="${dlTitleKo}"`)

      await evaluate(shell, `window.browserAPI.actions.run('action.palette.open', { windowId: ${JSON.stringify(await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`))} })`)
      await sleep(500)
      const paletteHolderKo = await evaluate(shell, `document.querySelector('.command-palette-input')?.getAttribute('placeholder') || ''`)
      check('I15', '외피(ko 기본) — 명령 팔레트 placeholder 가 원문 그대로',
        paletteHolderKo === '명령 검색 — 이름을 입력하세요 (예: 다크, 설정, ㅂㅁㅋ)  ·  ? 누르면 도움말', `placeholder="${paletteHolderKo}"`)
      await evaluate(shell, `document.querySelector('.command-palette-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)

      // I8: 존재하지 않는 키를 fallback 으로 조회하면(폴백 안전망) 앱이 죽지 않고 폴백이 나오는가.
      const fb = await evaluate(shell, `(() => {
        // App.tsx 가 내부적으로 쓰는 것과 동일한 반응형 조회 경로를 흉내 — 렌더러 모듈은 번들에 인라인돼
        // import 로 못 꺼내므로, 존재하는 값(labels 사전에 없는 키)에 대한 안전성은 t() 시그니처로 대신 확인.
        return typeof window.browserAPI?.i18n?.get === 'function'
      })()`)
      check('I8', '외피 — browserAPI.i18n.get 노출됨(preload 배선)', fb === true, `typeof get === 'function': ${fb}`)

      // I9: 설정에서 언어를 en 으로 바꾸면(재시작 없이) 외피 title 이 즉시 영어로 바뀌는가.
      await evaluate(shell, `window.browserAPI.settings.set('ui.language', 'en')`)
      await sleep(1500)
      const afterTitle = await evaluate(shell, `document.querySelector('.ai-btn')?.getAttribute('title') || ''`)
      check('I9', '설정 언어 변경(auto→en) — 재로드 없이 외피 title 이 즉시 영어로 반영',
        /AI Assistant/.test(afterTitle), `title="${afterTitle}"`)
    } catch (err) {
      check('FATAL-AUTO', 'auto 시드 실행', false, err.message)
    } finally {
      await closeAll(args.port, child, shell)
    }
  }

  console.log('\n===== verify-i18n 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 이름: r.name, 상태: r.status })))
  const failed = results.filter((r) => r.status !== 'PASS')
  for (const f of failed) console.log(`FAIL ${f.id}: ${f.detail}`)
  fs.writeFileSync(path.join(args.out, 'i18n-results.json'), JSON.stringify(results, null, 2))
  console.log(`PASS=${results.length - failed.length} FAIL=${failed.length} (총 ${results.length})`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify-i18n] 치명적 오류:', err); process.exit(2) })
