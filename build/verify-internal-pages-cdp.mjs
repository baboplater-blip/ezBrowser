#!/usr/bin/env node
// verify-internal-pages-cdp.mjs — browser:// 내부 페이지 전수 점검
//
// 왜 (2026-09-07, 임무 21): 내부 페이지는 20개가 넘는데 검증이 있는 건 settings·welcome·memory
// 셋뿐이었다. 그 셋을 실제로 대조했을 때 각각 결함이 나왔다(메모리 페이지의 거짓 예산 판정,
// 키맵 저장 결함). 나머지는 아무도 본 적이 없다.
//
// 각 페이지에 대해 보는 것:
//   ① 로드되는가 (CDP 타깃이 뜨는가)
//   ② 로드 중 자바스크립트 예외·console.error 가 났는가
//   ③ 화면에 실제 내용이 있는가 (빈 화면이 아닌가 + 그 페이지의 필수 요소가 있는가)
//   ④ 치환되지 않은 자리표시자가 새어 나오는가 (`__MSG_`, `{{ ... }}`, `[object Object]`, `undefined`)
//
// 사용: node build/verify-internal-pages-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectSession, getTargetList, waitForPortFree, connectShellSessionReady, ensureSessionReady,
} from './lib/cdp.mjs'
import { preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9236, out: path.join(REPO, 'verify-out', 'internal-pages') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

// 점검 대상. `expect` 는 그 페이지에 반드시 있어야 하는 요소의 선택자.
const PAGES = [
  { host: 'newtab', expect: 'input' },
  { host: 'bookmarks', expect: 'aside, .tree, #folders, input' },
  { host: 'history', expect: 'input' },
  { host: 'downloads', expect: 'body *' },
  { host: 'settings', expect: 'nav, .nav, aside' },
  { host: 'policies', expect: 'button' },
  { host: 'userscripts', expect: 'button' },
  { host: 'macros', expect: 'button' },
  { host: 'mods', expect: 'body *' },
  { host: 'passwords', expect: 'body *' },
  { host: 'extensions', expect: 'body *' },
  { host: 'keymap', expect: 'body *' },
  { host: 'adblock', expect: 'body *' },
  { host: 'memory', expect: 'body *' },
  { host: 'perf', expect: 'body *' },
  { host: 'privacy', expect: 'body *' },
  { host: 'terms', expect: 'body *' },
  { host: 'licenses', expect: 'body *' },
  { host: 'ai-memory', expect: 'textarea' },
  { host: 'ai-profile', expect: 'body *' },
  { host: 'ai-triggers', expect: 'body *' },
  { host: 'ai-collectors', expect: 'body *' },
]

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}

const PROBE = `(() => {
  const t = document.body ? document.body.innerText : ''
  return {
    text: t.length,
    nodes: document.querySelectorAll('*').length,
    placeholder: /__MSG_|\\[object Object\\]/.test(t),
    mustache: /\\{\\{[\\s\\S]{0,40}\\}\\}/.test(t),
    undefinedish: (t.match(/\\bundefined\\b/g) || []).length,
    nanish: (t.match(/\\bNaN\\b/g) || []).length,
    // 없는 페이지는 text/plain 404("Not Found: browser://x")로 온다 — 페이지로 세면 안 된다.
    contentType: document.contentType,
    title: document.title,
  }
})()`

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE} (npx electron-builder --win --dir)`)
  fs.mkdirSync(args.out, { recursive: true })
  // 고정 포트가 앞선 실행의 잔재에 물려 있으면 빈 포트로 대체한다(실행이 통째로 죽지 않게).
  args.port = await preferFreePort(args.port, 'verify-internal-pages-cdp.mjs')
  await waitForPortFree(args.port)

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true },
  }, null, 2))

  const logStream = fs.createWriteStream(path.join(args.out, 'app-stdout.log'))
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream)
  child.stderr.pipe(logStream)

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    const r0 = await shell.send('Runtime.evaluate', {
      expression: 'new URL(location.href).searchParams.get("windowId")', returnByValue: true,
    })
    const windowId = r0.result?.result?.value ?? r0.result?.value

    for (const page of PAGES) {
      const url = `browser://${page.host}`
      let session = null
      const errors = []
      try {
        await shell.send('Runtime.evaluate', {
          // 시그니처는 (windowId, url) — 객체 하나로 부르면 조용히 아무 일도 안 일어난다.
          expression: `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(url)})`,
          awaitPromise: true, returnByValue: true,
        })

        const deadline = Date.now() + 15000
        let target = null
        while (Date.now() < deadline && !target) {
          target = (await getTargetList(args.port)).find((t) => String(t.url).startsWith(url)) ?? null
          if (!target) await sleep(250)
        }
        if (!target) {
          check(page.host, `${url} 이 로드된다`, false, '타깃을 찾지 못함 — 로드 실패 추정')
          continue
        }

        session = await connectSession(target, page.host)
        await ensureSessionReady(session)
        session.events.push((msg) => {
          if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params?.exceptionDetails
            errors.push('예외: ' + String(d?.exception?.description ?? d?.text ?? '?').split('\n')[0])
          } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
            errors.push('console.error: ' + (msg.params.args ?? [])
              .map((a) => String(a.value ?? a.description ?? '?')).join(' ').slice(0, 160))
          }
        })
        await session.send('Runtime.enable')
        await session.send('Page.enable').catch(() => {})
        // 새로고침해 **로드 처음부터** 오류를 잡는다(붙기 전에 난 오류는 못 보므로).
        await session.send('Page.reload', { ignoreCache: false })
        await sleep(2500)

        const res = await session.send('Runtime.evaluate', { expression: PROBE, returnByValue: true })
        const info = res.result?.result?.value ?? res.result?.value
        const hasExpect = await session.send('Runtime.evaluate', {
          expression: `!!document.querySelector(${JSON.stringify(page.expect)})`, returnByValue: true,
        }).then((r) => r.result?.result?.value ?? r.result?.value)

        const ok = errors.length === 0 && !!info && info.text > 0 && hasExpect === true
          && info.contentType === 'text/html'
          && !info.placeholder && !info.mustache && info.undefinedish === 0 && info.nanish === 0
        check(page.host, `${url} 이 오류 없이 내용을 보인다`, ok,
          `본문 ${info?.text ?? 0}자 · 요소 ${info?.nodes ?? 0}개 · 필수요소=${hasExpect}`
          + (info && info.contentType !== 'text/html' ? ` · HTML 아님(${info.contentType})` : '')
          + (info?.placeholder ? ' · 자리표시자 노출' : '')
          + (info?.mustache ? ' · {{템플릿}} 노출' : '')
          + (info?.undefinedish ? ` · "undefined" ${info.undefinedish}회` : '')
          + (info?.nanish ? ` · "NaN" ${info.nanish}회` : '')
          + (errors.length ? ` · 오류 ${errors.length}건: ${errors[0]}` : ''))
      } catch (err) {
        check(page.host, `${url} 이 로드된다`, false, err.message)
      } finally {
        try { session?.close() } catch { /* ignore */ }
      }
    }

    // ===== 2단계: 데이터가 있을 때의 렌더 =====
    // 1단계는 빈 프로필이라 "빈 상태" 만 본다. 실제 렌더 버그는 목록에 내용이 있을 때 나온다.
    // 각 페이지의 internalAPI 로 N건을 넣고, 새로고침 후 화면에 그만큼 보이는지 대조한다.
    const SEEDS = [
      {
        host: 'bookmarks', n: 3, needle: '검증북마크',
        seed: `(async () => {
          for (let i = 1; i <= 3; i++) {
            await window.internalAPI.bookmarks.add({ url: 'https://example.com/b' + i, title: '검증북마크' + i })
          }
          return (await window.internalAPI.bookmarks.list()).bookmarks?.length ?? null
        })()`,
      },
      {
        host: 'policies', n: 3, needle: '검증정책',
        seed: `(async () => {
          for (let i = 1; i <= 3; i++) {
            await window.internalAPI.policy.save({ name: '검증정책' + i, match: ['*://p' + i + '.example/*'] })
          }
          return (await window.internalAPI.policy.list()).length
        })()`,
      },
      {
        host: 'macros', n: 3, needle: '검증매크로',
        seed: `(async () => {
          for (let i = 1; i <= 3; i++) {
            await window.internalAPI.macro.save({ name: '검증매크로' + i, trigger: { type: 'shortcut', value: '' }, actions: [] })
          }
          return (await window.internalAPI.macro.list()).length
        })()`,
      },
      {
        host: 'userscripts', n: 3, needle: '검증스크립트',
        seed: `(async () => {
          for (let i = 1; i <= 3; i++) {
            await window.internalAPI.userscript.save({
              source: ['// ==UserScript==', '// @name 검증스크립트' + i, '// @match *://*/*', '// ==/UserScript==', 'console.log(1)'].join(String.fromCharCode(10)),
            })
          }
          return (await window.internalAPI.userscript.list()).length
        })()`,
      },
    ]

    for (const seed of SEEDS) {
      const url = `browser://${seed.host}`
      let session = null
      const errors = []
      try {
        const t = (await getTargetList(args.port)).find((x) => String(x.url).startsWith(url))
        if (!t) { check(`데이터:${seed.host}`, `${url} 데이터 렌더`, false, '1단계에서 연 탭을 못 찾음'); continue }
        session = await connectSession(t, `data-${seed.host}`)
        await ensureSessionReady(session)

        // 씨앗 심기가 실패하면 조용히 undefined 가 된다 — 이유를 드러낸다.
        const seedRes = await session.send('Runtime.evaluate', {
          expression: seed.seed, awaitPromise: true, returnByValue: true,
        })
        const seedErr = seedRes.result?.exceptionDetails ?? seedRes.exceptionDetails
        const seeded = seedRes.result?.result?.value ?? seedRes.result?.value
        if (seedErr) {
          errors.push('씨앗 실패: ' + String(seedErr.exception?.description ?? seedErr.text ?? '?').slice(0, 200))
        }

        session.events.push((msg) => {
          if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params?.exceptionDetails
            errors.push('예외: ' + String(d?.exception?.description ?? d?.text ?? '?'))
          } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
            errors.push('console.error')
          }
        })
        await session.send('Runtime.enable')
        await session.send('Page.reload', { ignoreCache: false })
        await sleep(2500)

        const shown = await session.send('Runtime.evaluate', {
          expression: `(document.body.innerText.match(new RegExp(${JSON.stringify(seed.needle)}, 'g')) || []).length`,
          returnByValue: true,
        }).then((r) => r.result?.result?.value ?? r.result?.value)

        check(`데이터:${seed.host}`, `${url} 이 넣은 ${seed.n}건을 화면에 그린다`,
          errors.length === 0 && shown >= seed.n,
          `저장 ${seeded}건 · 화면 ${shown}건(기대 ${seed.n} 이상)`
          + (errors.length ? ` · 오류 ${errors.length}건: ${errors[0]}` : ''))
      } catch (err) {
        check(`데이터:${seed.host}`, `${url} 데이터 렌더`, false, err.message)
      } finally {
        try { session?.close() } catch { /* ignore */ }
      }
    }
  } catch (err) {
    check('FATAL', '하네스 실행', false, err.message)
  } finally {
    try { shell?.close() } catch { /* ignore */ }
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {})
      b.close()
    } catch { /* ignore */ }
    await sleep(1500)
    try { child.kill() } catch { /* ignore */ }
  }

  fs.writeFileSync(path.join(args.out, 'internal-pages-results.json'), JSON.stringify(results, null, 2))
  console.log('\n===== verify-internal-pages 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL')
  console.log(`PASS=${results.length - fail.length} FAIL=${fail.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
