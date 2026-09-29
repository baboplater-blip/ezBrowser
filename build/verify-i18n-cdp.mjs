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
  let lastList = []
  while (Date.now() < deadline) {
    lastList = await getTargetList(port)
    const t = lastList.find((x) => String(x.url).startsWith(url))
    if (t) return t
    await sleep(300)
  }
  const summary = lastList.map((t) => `${t.type}:${t.url}`).join('\n  ')
  throw new Error(`${url} 타깃을 찾지 못함\n마지막 타깃 목록:\n  ${summary || '(없음)'}`)
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

      // I10: browser://welcome(en) — 1단계 제목이 en 인지(묶음 M3, JS 템플릿 렌더).
      const welcomeTarget = await openInternalPage(args.port, shell, windowId, 'browser://welcome')
      const welcomeSession = await connectSession(welcomeTarget, 'welcome-en')
      await sleep(1200)
      const welcomeTitle = await evaluate(welcomeSession, `(document.querySelector('h2')?.textContent || '').trim()`)
      check('I10', 'browser://welcome(en) — 1단계 제목이 "Default search engine"', welcomeTitle === 'Default search engine', `title="${welcomeTitle}"`)
      welcomeSession.close()

      // I11: browser://newtab(en) — document.title·바로가기 섹션 제목이 en 인지(정적 data-i18n).
      const newtabTarget = await openInternalPage(args.port, shell, windowId, 'browser://newtab')
      const newtabSession = await connectSession(newtabTarget, 'newtab-en')
      await sleep(1200)
      const newtabDocTitle = await evaluate(newtabSession, `document.title`)
      const shortcutsTitle = await evaluate(newtabSession, `(document.querySelector('.section-title')?.textContent || '').trim()`)
      check('I11', 'browser://newtab(en) — 탭 제목 "New Tab" + 바로가기 섹션 "Shortcuts"',
        newtabDocTitle === 'New Tab' && shortcutsTitle === 'Shortcuts', `docTitle="${newtabDocTitle}" shortcuts="${shortcutsTitle}"`)
      newtabSession.close()

      // I12: browser://memory(en) — 통계 카드 라벨이 en 인지(JS 템플릿 렌더 + trSafe).
      const memoryTarget = await openInternalPage(args.port, shell, windowId, 'browser://memory')
      const memorySession = await connectSession(memoryTarget, 'memory-en')
      await sleep(1500)
      const memLabel = await evaluate(memorySession, `(document.querySelector('.stat .label')?.textContent || '').trim()`)
      check('I12', 'browser://memory(en) — 첫 통계 라벨이 "Main process (private bytes)"',
        memLabel === 'Main process (private bytes)', `label="${memLabel}"`)
      memorySession.close()

      // I13: browser://error(en) — kind/code 기반 클라이언트 재번역이 net 에러 설명을 en 으로 보여주는지.
      // Chromium 은 host 뒤 query 앞에 '/' 를 자동으로 붙인다(browser://error?.. → browser://error/?..) —
      // openInternalPage 의 startsWith 매칭이 실제 타깃 URL 과 어긋나지 않게 미리 슬래시를 넣는다.
      const errorUrl = 'browser://error/?' + new URLSearchParams({
        kind: 'load-fail', code: '-105', desc: 'name-not-resolved', url: 'https://no-such-host.invalid/',
      }).toString()
      const errorTarget = await openInternalPage(args.port, shell, windowId, errorUrl)
      const errorSession = await connectSession(errorTarget, 'error-en')
      await sleep(1200)
      const errTitle = await evaluate(errorSession, `(document.getElementById('title')?.textContent || '').trim()`)
      const errDesc = await evaluate(errorSession, `(document.getElementById('desc')?.textContent || '').trim()`)
      const errRetry = await evaluate(errorSession, `(document.getElementById('retry')?.textContent || '').trim()`)
      check('I13', 'browser://error(en) — 제목/설명/버튼이 en (net 코드 -105 기반 재번역)',
        errTitle === "This page can't be opened" && errDesc === "The address can't be found" && errRetry === 'Try again',
        `title="${errTitle}" desc="${errDesc}" retry="${errRetry}"`)
      errorSession.close()
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

      // I14: browser://welcome(vi) — 1단계 제목이 베트남어인지.
      const welcomeTarget = await openInternalPage(args.port, shell, windowId, 'browser://welcome')
      const welcomeSession = await connectSession(welcomeTarget, 'welcome-vi')
      await sleep(1200)
      const welcomeTitle = await evaluate(welcomeSession, `(document.querySelector('h2')?.textContent || '').trim()`)
      check('I14', 'browser://welcome(vi) — 1단계 제목이 "Công cụ tìm kiếm mặc định"', welcomeTitle === 'Công cụ tìm kiếm mặc định', `title="${welcomeTitle}"`)
      welcomeSession.close()

      // I15: browser://newtab(vi) — 탭 제목·바로가기 섹션 제목이 베트남어인지.
      const newtabTarget = await openInternalPage(args.port, shell, windowId, 'browser://newtab')
      const newtabSession = await connectSession(newtabTarget, 'newtab-vi')
      await sleep(1200)
      const newtabDocTitle = await evaluate(newtabSession, `document.title`)
      const shortcutsTitle = await evaluate(newtabSession, `(document.querySelector('.section-title')?.textContent || '').trim()`)
      check('I15', 'browser://newtab(vi) — 탭 제목 "Tab mới" + 바로가기 섹션 "Lối tắt"',
        newtabDocTitle === 'Tab mới' && shortcutsTitle === 'Lối tắt', `docTitle="${newtabDocTitle}" shortcuts="${shortcutsTitle}"`)
      newtabSession.close()

      // I16: browser://memory(vi) — 통계 카드 라벨이 베트남어인지.
      const memoryTarget = await openInternalPage(args.port, shell, windowId, 'browser://memory')
      const memorySession = await connectSession(memoryTarget, 'memory-vi')
      await sleep(1500)
      const memLabel = await evaluate(memorySession, `(document.querySelector('.stat .label')?.textContent || '').trim()`)
      check('I16', 'browser://memory(vi) — 첫 통계 라벨이 "Tiến trình chính (private bytes)"',
        memLabel === 'Tiến trình chính (private bytes)', `label="${memLabel}"`)
      memorySession.close()
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
