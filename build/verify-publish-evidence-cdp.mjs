#!/usr/bin/env node
// verify-publish-evidence-cdp.mjs — "게시 확인 근거" 판정을 DOM → 판정 끝에서 끝까지 검증한다.
//
// 왜 (2026-09-19): sightingSupportsPublication 은 호스트·문구·관찰시각 셋만으로 "게시됐다" 를
// 확정했다. 그 셋만으로는 ① 같은 사이트의 남의 계정 글, ② 같은 캡션을 가진 오래된 글도 근거로
// 통과한다 — 둘 다 되돌릴 수 없는 오판(중복 게시 또는 영구 대기)으로 이어진다. 이번 라운드에
// 누가 썼는가(author/authorScope)·언제 올라갔는가(postedAt) 두 축이 추가됐다. 이 검사는 그 판정이
// **모델의 말이 아니라 실제 브라우저 DOM** 에서 시작해 옳게 동작하는지를 끝에서 끝까지 본다.
//
// 구동 방식: page-actions.js 는 electron 런타임 의존이 없다(타입만 import). 그래서 컴파일된 모듈을
// Node 에서 직접 require 하고, WebContents 대신 "CDP 로 실제 페이지에 evaluate 하는 가짜 wc" 를
// 넘긴다(verify-agent-safety-cdp.mjs 의 fakeWc 패턴) → probeVerifyNeedles 를 진짜 브라우저 DOM
// 위에서 그대로 검증한다. 판정 자체(sightingSupportsPublication)는 agent-gate.js 를 직접 require.
//
// 픽스처: 한 로컬 HTTP 서버가 같은 캡션을 담은 네 가지 DOM 모양을 서로 다른 경로로 서빙한다.
// 모든 페이지 상단에는 "전역 nav 에 내 계정 로그인 표기" 를 둔다 — 이것이 "전역 로그인 라벨을
// 게시 증거로 쓰지 않는다" 를 시험하는 장치다.
//   /ok            — 글 컨테이너 안에 정확한 계정 + 방금 시각 → 근거로 인정돼야 한다
//   /wrong-author  — 같은 캡션·같은 시각이지만 글쓴이가 다른 사람 → 확정 거부(uncertain 아님)
//   /old           — 계정은 맞지만 글 시각이 30일 전 → 확정 거부(uncertain 아님)
//   /ambiguous     — 글 단위 컨테이너가 없고 계정 표기는 전역 nav 에만 있음 → "모름"(uncertain)
//
//   E-POS          /ok 근거가 실제로 통과한다(작성자·시각까지 정확히 읽힘)
//   E-WRONG-AUTHOR  다른 계정의 글은 거부된다(확정 거부)
//   E-OLD           오래된 글은 거부된다(확정 거부)
//   E-AMBIG         컨테이너를 못 찾으면 "모름"(uncertain)으로 남는다(확정 거부와 다름)
//   E-NO-GLOBAL     전역 nav 의 로그인 계정이 글 작성자로 새지 않는다
//   E-NEG           음성 대조 — 계정/시각을 안 보는 느슨한 판정 복제본은 wrong-author 근거를 통과시킨다
//
// 격리·안전: 다른 하네스와 동일 — 격리 프로필(--user-data-dir), 이 하네스가 띄운 PID 만 정리,
// 우리가 여는 HTTP 서버는 고정 포트가 아니라 getFreePorts 로 받는다.
//
// ⚠ 앱 기동: `dist/win-unpacked/ezBrowser.exe` 가 아니라 **`electron.exe` + `app/dist/main/index.js`**
// 로 띄운다(verify-recovery-cdp.mjs 의 패턴). win-unpacked 는 마지막 `npm run package` 시점의
// 스냅샷이라 이번 라운드의 새 `probeVerifyNeedles`(page-actions.ts)가 안 들어 있을 수 있다 —
// 그 실행 파일로 띄우면 DOM 을 보여주는 브라우저 자체가 구코드로 도는 셈이라 검사가 조용히 틀린
// 것을 검증하게 된다. `electron.exe + app/dist/main/index.js` 는 항상 방금 `npm run build` 한
// 산출물을 쓴다. (probeVerifyNeedles/sightingSupportsPublication 자체는 이 하네스 프로세스가
// `app/dist/main/features/ai/*.js` 를 직접 require 해서 쓰므로 원래도 최신이었지만, 브라우저까지
// 같은 산출물로 맞춰야 혼선이 없다.)
//
// 사용: node build/verify-publish-evidence-cdp.mjs [--port <n>] [--out <dir>] [--main <index.js 절대경로>]

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import {
  connectSession,
  connectShellSessionReady,
  getTargetList,
  pollUntil,
  sleep,
  waitForPortFree,
} from './lib/cdp.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const ELECTRON_BIN = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PAGE_ACTIONS_JS = path.join(REPO_ROOT, 'app', 'dist', 'main', 'features', 'ai', 'page-actions.js')
const AGENT_GATE_JS = path.join(REPO_ROOT, 'app', 'dist', 'main', 'features', 'ai', 'agent-gate.js')

const args = {
  port: 9299,
  out: path.join(REPO_ROOT, 'verify-out', 'publish-evidence'),
  main: path.join(REPO_ROOT, 'app', 'dist', 'main', 'index.js'),
}
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--main') args.main = path.resolve(process.argv[++i])
}
const MAIN_ENTRY = args.main

// ── 판정 재료 상수 ───────────────────────────────────────────────────────
const LOGIN_ACCOUNT = 'ez_test_account'      // 모든 픽스처의 전역 nav 가 표시하는 "내 계정"
const CAPTION = '오늘 하네스 검증용 테스트 게시물입니다 자동화 확인'
function normalizeText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}
const NEEDLE = normalizeText(CAPTION)

// ── 픽스처 HTML ──────────────────────────────────────────────────────────
function pageHtml({ route, authorHref, authorText, timeIso, timeText, ambiguousLayout }) {
  const nav = `<nav>로그인: @${LOGIN_ACCOUNT}</nav>`
  const body = ambiguousLayout
    ? `${nav}\n<div id="feed"><p>${CAPTION}</p></div>`
    : `${nav}\n<article data-post-id="${route}">
        <a href="${authorHref}">${authorText}</a>
        <time datetime="${timeIso}">${timeText}</time>
        <p>${CAPTION}</p>
      </article>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>publish-evidence-${route}</title></head>`
    + `<body>\n${body}\n</body></html>`
}

function buildFixturePages(freshIso, oldIso) {
  return {
    ok: pageHtml({
      route: 'ok', authorHref: `/${LOGIN_ACCOUNT}/`, authorText: `@${LOGIN_ACCOUNT}`,
      timeIso: freshIso, timeText: '방금',
    }),
    'wrong-author': pageHtml({
      route: 'wrong-author', authorHref: '/someone_else/', authorText: '@someone_else',
      timeIso: freshIso, timeText: '방금',
    }),
    old: pageHtml({
      route: 'old', authorHref: `/${LOGIN_ACCOUNT}/`, authorText: `@${LOGIN_ACCOUNT}`,
      timeIso: oldIso, timeText: '30일 전',
    }),
    ambiguous: pageHtml({ route: 'ambiguous', ambiguousLayout: true }),
    // 명시 표기(data-author)로 남의 글임이 분명한 경우 — 이때만 "확정 거부" 가 허용된다.
    'wrong-author-structural': `<!doctype html><html><head><meta charset="utf-8"><title>publish-evidence-structural</title></head>`
      + `<body>
<nav>로그인: @${LOGIN_ACCOUNT}</nav>
`
      + `<article data-post-id="ws" data-author="someone_else">`
      + `<time datetime="${freshIso}">방금</time><p>${CAPTION}</p></article>
</body></html>`,
    // 내 글인데 **캡션 안에 남을 멘션**한 경우 — 작성자는 캡션 위의 내 계정이어야 한다.
    // (이것을 멘션으로 읽으면 내 글을 "남의 글" 로 단정하고, 사용자가 "게시 안 됨" 을 눌러 중복 게시한다.)
    mention: `<!doctype html><html><head><meta charset="utf-8"><title>publish-evidence-mention</title></head>`
      + `<body>
<nav>로그인: @${LOGIN_ACCOUNT}</nav>
`
      + `<article data-post-id="mention">`
      + `<a href="/${LOGIN_ACCOUNT}/">@${LOGIN_ACCOUNT}</a>`
      + `<time datetime="${freshIso}">방금</time>`
      + `<p>${CAPTION} <a href="/friend_person/">@friend_person</a></p>`
      + `<div class="comments"><a href="/commenter_one/">@commenter_one</a><time datetime="${freshIso}">방금</time></div>`
      + `</article>
</body></html>`,
  }
}

async function startFixtureServer(pages) {
  const [port] = await getFreePorts(1)
  const server = http.createServer((req, res) => {
    const route = (req.url || '/').split('?')[0].replace(/^\//, '') || 'ok'
    const html = pages[route]
    if (!html) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
  })
  await new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return { server, port, baseUrl: `http://127.0.0.1:${port}/` }
}

async function closeServer(server) {
  try { server.closeAllConnections?.() } catch { /* Node 22 미만이면 없음 — 무시 */ }
  await Promise.race([
    new Promise((resolve) => server.close(() => resolve())),
    sleep(3000),
  ])
}

// ── 앱 spawn/정리 ─────────────────────────────────────────────────────────
function seedProfile(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    setup: { completed: true, completedAt: Date.now(), version: 'verify' },
    startup: { mode: 'newtab', urls: [] },
  }, null, 2))
}
function launchApp(profileDir, port, outDir) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(ELECTRON_BIN, [MAIN_ENTRY, `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
  })
  child.stdout?.pipe(fs.createWriteStream(path.join(outDir, 'publish-evidence-stdout.log')))
  child.stderr?.pipe(fs.createWriteStream(path.join(outDir, 'publish-evidence-stderr.log')))
  return child
}
async function killApp(child, shell) {
  try { await shell?.send('Browser.close', {}, 3000).catch(() => {}) } catch { /* ignore */ }
  await sleep(800)
  if (child && child.exitCode === null) {
    try { child.kill() } catch { /* ignore */ }
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']) } catch { /* ignore */ }
  }
}

// ── CDP 헬퍼 ────────────────────────────────────────────────────────────
async function evaluate(session, expression, opts = {}) {
  const { awaitPromise = true, returnByValue = true, timeoutMs = 20000 } = opts
  const r = await session.send('Runtime.evaluate', { expression, awaitPromise, returnByValue, userGesture: true }, timeoutMs)
  if (r.exceptionDetails) throw new Error(`JS exception in ${session.label}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`)
  return r.result?.value
}
const lit = (a) => (a === undefined ? 'undefined' : JSON.stringify(a))
const callApi = (session, apiPath, argv = []) => evaluate(session, `window.browserAPI.${apiPath}(${argv.map(lit).join(', ')})`)
const shellWindowId = (t) => { try { return new URL(t.url).searchParams.get('windowId') } catch { return null } }

function fakeWcFor(session, url) {
  return {
    isDestroyed: () => false,
    getURL: () => url,
    focus: () => {},
    executeJavaScript: (code) => evaluate(session, code, { timeoutMs: 20000 }),
  }
}

async function openTab(shell, port, windowId, url) {
  const before = new Set((await getTargetList(port)).map((t) => t.id))
  await callApi(shell, 'tabs.create', [windowId, url])
  const target = await pollUntil(async () => {
    const l = await getTargetList(port)
    return l.find((t) => t.type === 'page' && !before.has(t.id) && typeof t.url === 'string' && t.url.startsWith(url)) ?? null
  }, { timeoutMs: 15000, intervalMs: 300, label: `tab ${url}` })
  const session = await connectSession(target, url)
  await sleep(400)
  return session
}

// ── 결과 집계 ───────────────────────────────────────────────────────────
const results = []
async function scenario(id, name, fn) {
  const t0 = Date.now()
  try {
    const detail = await fn()
    results.push({ id, name, status: 'PASS', ms: Date.now() - t0, detail })
    console.log(`  ✓ ${id} PASS — ${detail}`)
  } catch (err) {
    results.push({ id, name, status: 'FAIL', ms: Date.now() - t0, detail: err.message })
    console.log(`  ✗ ${id} FAIL — ${err.message}`)
  }
}

// 옛 3필드 계약을 흉내내는 느슨한 판정 복제본 — 제품 코드는 손대지 않고 하네스 안에서만 만든다.
// 계정(author)·게시시각(postedAt)을 전혀 보지 않으면 어떤 근거가 잘못 통과하는지 보이기 위한 것.
function looseJudge(s, expect) {
  const url = typeof s.url === 'string' ? s.url : ''
  const needle = typeof s.needle === 'string' ? normalizeText(s.needle) : ''
  if (!url || !needle) return { ok: false, reason: '근거 비어있음(loose)' }
  let host = ''
  try { host = new URL(url).hostname.toLowerCase() } catch { return { ok: false, reason: 'url 파싱 실패(loose)' } }
  const wantHost = String(expect.host ?? '').toLowerCase()
  if (host !== wantHost && !host.endsWith(`.${wantHost}`)) return { ok: false, reason: '다른 사이트(loose)' }
  const want = expect.needles.map((n) => normalizeText(n))
  if (!want.includes(needle)) return { ok: false, reason: '다른 문구(loose)' }
  if (typeof s.at !== 'number' || s.at < expect.notBefore) return { ok: false, reason: '오래된 근거(loose)' }
  return { ok: true, reason: '호스트·문구·시각만 확인(loose) — 계정·게시시각은 안 봄' }
}

async function main() {
  fs.mkdirSync(args.out, { recursive: true })
  if (!fs.existsSync(ELECTRON_BIN)) {
    console.error(`electron 실행 파일 없음: ${ELECTRON_BIN} — node_modules 설치 확인`)
    process.exit(2)
  }
  for (const f of [MAIN_ENTRY, PAGE_ACTIONS_JS, AGENT_GATE_JS]) {
    if (!fs.existsSync(f)) {
      console.error(`빌드 산출물 없음: ${f} — 먼저 npm run build`)
      process.exit(2)
    }
  }

  // 컴파일된 모듈을 그대로 쓴다(제품 코드 자체를 검증하는 것이 목적).
  const pa = require(PAGE_ACTIONS_JS)
  const gate = require(AGENT_GATE_JS)
  if (typeof gate.sightingSupportsPublication !== 'function') {
    console.error('agent-gate.js 에 sightingSupportsPublication 이 없음 — 계약이 아직 안 나온 것으로 보임')
    process.exit(2)
  }
  if (typeof pa.probeVerifyNeedles !== 'function') {
    console.error('page-actions.js 에 probeVerifyNeedles 가 없음 — 계약이 아직 안 나온 것으로 보임')
    process.exit(2)
  }

  const ATTEMPT_STARTED_AT = Date.now()
  const FRESH_ISO = new Date(ATTEMPT_STARTED_AT + 2000).toISOString()
  const OLD_ISO = new Date(ATTEMPT_STARTED_AT - 30 * 24 * 3600 * 1000).toISOString()
  const EXPECT_BASE = {
    account: LOGIN_ACCOUNT,
    attemptStartedAt: ATTEMPT_STARTED_AT,
    notBefore: ATTEMPT_STARTED_AT - 5000,
    needles: [NEEDLE],
  }

  const pages = buildFixturePages(FRESH_ISO, OLD_ISO)
  const { server, baseUrl } = await startFixtureServer(pages)

  const profileDir = path.join(args.out, 'profile')
  seedProfile(profileDir)
  args.port = await preferFreePort(args.port, 'verify-publish-evidence-cdp.mjs')
  if (!(await waitForPortFree(args.port))) {
    throw new Error(`디버그 포트 ${args.port} 가 이미 사용 중입니다 — 남은 인스턴스를 종료하세요.`)
  }
  const child = launchApp(profileDir, args.port, args.out)
  let shell = null
  const contentSessions = []

  try {
    shell = await connectShellSessionReady(args.port)
    // windowId 는 외피 타깃의 URL(file://…/index.html?windowId=…)에서 뽑는다.
    const list0 = await getTargetList(args.port)
    const found = list0.find((t) => typeof t.url === 'string' && t.url.startsWith('file://') && t.url.includes('windowId='))
    const windowId = found ? shellWindowId(found) : null
    if (!windowId) throw new Error('외피 windowId 를 못 얻음')

    async function probeRoute(routeName) {
      const url = `${baseUrl}${routeName}`
      const session = await openTab(shell, args.port, windowId, url)
      contentSessions.push(session)
      const pageUrl = await evaluate(session, 'location.href')
      const wc = fakeWcFor(session, pageUrl)
      const probe = await pa.probeVerifyNeedles(wc, [NEEDLE])
      return { probe, pageUrl, session }
    }

    function buildSighting(probe, pageUrl, at) {
      let host = ''
      try { host = new URL(pageUrl).hostname } catch { /* ignore */ }
      return {
        url: pageUrl,
        host,
        needle: probe?.needle ?? '',
        snippet: probe?.snippet ?? '',
        at,
        author: probe?.author,
        authorScope: probe?.authorScope,
        // 제품에서는 agent.ts 가 이 값을 이벤트에 싣고 task-runtime 이 작업에 적는다.
        // 여기서 빠뜨리면 "추정/명시" 구분이 통째로 사라져 판정이 항상 보수적으로 나온다.
        authorSource: probe?.authorSource,
        postedAt: probe?.postedAt,
        postedAtText: probe?.postedAtText,
        ambiguous: probe?.ambiguous,
      }
    }

    // ── E-POS ────────────────────────────────────────────────────────
    let okProbe = null
    let okPageUrl = ''
    await scenario('E-POS', '정확한 계정·방금 시각 글 = 근거로 인정', async () => {
      const { probe, pageUrl } = await probeRoute('ok')
      okProbe = probe
      okPageUrl = pageUrl
      if (!probe) throw new Error('probe 가 null — needle 을 못 찾음(/ok 페이지 구성 확인 필요)')
      if (normalizeText(probe.author) !== LOGIN_ACCOUNT) throw new Error(`작성자 오독: ${JSON.stringify(probe.author)}(기대 ${LOGIN_ACCOUNT})`)
      if (probe.authorScope !== 'post') throw new Error(`authorScope 가 'post' 가 아님: ${JSON.stringify(probe.authorScope)}`)
      if (typeof probe.postedAt !== 'number' || !(probe.postedAt > 0)) throw new Error(`postedAt 을 못 읽음: ${JSON.stringify(probe.postedAt)}`)
      const sighting = buildSighting(probe, pageUrl, Date.now())
      const expect = { ...EXPECT_BASE, host: new URL(pageUrl).hostname }
      const verdict = gate.sightingSupportsPublication(sighting, expect)
      if (verdict.ok !== true) throw new Error(`판정이 통과하지 못함: ${JSON.stringify(verdict)}`)
      return `author=${probe.author}(scope=${probe.authorScope}) · postedAt=${new Date(probe.postedAt).toISOString()} · 판정=${JSON.stringify(verdict)}`
    })

    // ── E-WRONG-AUTHOR ───────────────────────────────────────────────
    let wrongProbe = null
    let wrongPageUrl = ''
    await scenario('E-WRONG-AUTHOR', '같은 문구·다른 작성자 = 확정 거부(uncertain 아님)', async () => {
      const { probe, pageUrl } = await probeRoute('wrong-author')
      wrongProbe = probe
      wrongPageUrl = pageUrl
      if (!probe) throw new Error('probe 가 null — needle 을 못 찾음(/wrong-author 페이지 구성 확인 필요)')
      if (normalizeText(probe.author) === LOGIN_ACCOUNT) throw new Error(`작성자가 nav 의 내 계정으로 새어들어옴: ${JSON.stringify(probe.author)}`)
      const sighting = buildSighting(probe, pageUrl, Date.now())
      const expect = { ...EXPECT_BASE, host: new URL(pageUrl).hostname }
      const verdict = gate.sightingSupportsPublication(sighting, expect)
      if (verdict.ok !== false) throw new Error(`다른 계정 글이 통과함: ${JSON.stringify(verdict)}`)
      // 이 픽스처의 작성자는 **프로필 링크**에서 읽은 추정값이다. 추정이 빗나갔을 때 "다른 계정의 글"
      // 이라고 단정하면 사용자가 "게시 안 됨" 을 눌러 **같은 글을 또 올린다**(리뷰 H1).
      // 그래서 근거로는 인정하지 않되(ok:false) 결론은 "모름" 이어야 한다.
      if (verdict.uncertain !== true) throw new Error(`추정 출처인데 확정 거부로 단정함: ${JSON.stringify(verdict)}`)
      if (String(verdict.reason || '').indexOf(String(probe.author)) < 0) {
        throw new Error(`사유에 실제로 읽은 작성자가 없음(사용자가 판단할 재료가 없다): ${JSON.stringify(verdict)}`)
      }
      return `작성자="${probe.author}"(추정 출처) · 판정=${JSON.stringify(verdict)}`
    })

    // ── E-WRONG-AUTHOR-STRUCT — 명시 표기(data-author)면 확정 거부가 맞다 ──
    await scenario('E-WRONG-AUTHOR-STRUCT', '명시 표기(data-author)로 읽은 다른 계정 = 확정 거부', async () => {
      const { probe, pageUrl } = await probeRoute('wrong-author-structural')
      if (!probe) throw new Error('probe 가 null')
      if (probe.authorSource !== 'structural') throw new Error(`출처가 structural 이 아님: ${JSON.stringify(probe.authorSource)}`)
      const verdict = gate.sightingSupportsPublication(buildSighting(probe, pageUrl, Date.now()),
        { ...EXPECT_BASE, host: new URL(pageUrl).hostname })
      if (verdict.ok !== false) throw new Error(`다른 계정 글이 통과함: ${JSON.stringify(verdict)}`)
      if (verdict.uncertain === true) throw new Error(`명시 표기인데 모름으로 남음: ${JSON.stringify(verdict)}`)
      return `작성자="${probe.author}"(${probe.authorSource}) · 판정=${JSON.stringify(verdict)}`
    })

    // ── E-MENTION — 캡션 속 멘션·댓글 작성자를 글쓴이로 오독하지 않는다 ──
    await scenario('E-MENTION', '캡션 안 멘션·댓글 작성자를 글쓴이로 읽지 않는다(내 글은 내 글로)', async () => {
      const { probe, pageUrl } = await probeRoute('mention')
      if (!probe) throw new Error('probe 가 null')
      const who = normalizeText(probe.author)
      if (who !== LOGIN_ACCOUNT) {
        throw new Error(`캡션 멘션/댓글 작성자를 글쓴이로 오독함: ${JSON.stringify(probe.author)} (기대 ${LOGIN_ACCOUNT})`)
      }
      const verdict = gate.sightingSupportsPublication(buildSighting(probe, pageUrl, Date.now()),
        { ...EXPECT_BASE, host: new URL(pageUrl).hostname })
      if (verdict.ok !== true) throw new Error(`내 글인데 근거로 인정되지 않음: ${JSON.stringify(verdict)}`)
      return `작성자="${probe.author}"(멘션 @friend_person·댓글 @commenter_one 무시) · 판정=${JSON.stringify(verdict)}`
    })

    // ── E-OLD ────────────────────────────────────────────────────────
    await scenario('E-OLD', '계정은 맞지만 30일 전 글 = 확정 거부(uncertain 아님)', async () => {
      const { probe, pageUrl } = await probeRoute('old')
      if (!probe) throw new Error('probe 가 null — needle 을 못 찾음(/old 페이지 구성 확인 필요)')
      if (normalizeText(probe.author) !== LOGIN_ACCOUNT) throw new Error(`작성자 오독: ${JSON.stringify(probe.author)}`)
      if (typeof probe.postedAt !== 'number' || !(probe.postedAt > 0)) throw new Error(`postedAt 을 못 읽음: ${JSON.stringify(probe.postedAt)}`)
      const ageDays = (ATTEMPT_STARTED_AT - probe.postedAt) / 86400000
      if (ageDays < 10) throw new Error(`postedAt 이 충분히 오래되지 않음(약 ${ageDays.toFixed(1)}일 전) — 픽스처 시각 확인`)
      const sighting = buildSighting(probe, pageUrl, Date.now())
      const expect = { ...EXPECT_BASE, host: new URL(pageUrl).hostname }
      const verdict = gate.sightingSupportsPublication(sighting, expect)
      if (verdict.ok !== false) throw new Error(`오래된 글이 통과함: ${JSON.stringify(verdict)}`)
      if (verdict.uncertain === true) throw new Error(`확정 거부여야 하는데 uncertain 으로 남음: ${JSON.stringify(verdict)}`)
      return `postedAt="${probe.postedAtText ?? new Date(probe.postedAt).toISOString()}"(약 ${ageDays.toFixed(1)}일 전) · 판정=${JSON.stringify(verdict)}`
    })

    // ── E-AMBIG ──────────────────────────────────────────────────────
    let ambigProbe = null
    await scenario('E-AMBIG', '글 단위 컨테이너를 못 찾으면 "모름"(uncertain) — 확정 거부와 다름', async () => {
      const { probe, pageUrl } = await probeRoute('ambiguous')
      ambigProbe = probe
      if (!probe) {
        // 근거 자체가 안 만들어졌다 — 이것도 "근거 없음"이라 안전한 결과다. 정직하게 이렇게 기록한다.
        return `probe=null(needle 을 애초에 못 찾음 — 컨테이너가 없어 캡션을 못 읽었을 수 있음). `
          + `이 경우도 게시 근거가 되지 못하므로 안전한 결과로 PASS 처리.`
      }
      const sighting = buildSighting(probe, pageUrl, Date.now())
      const expect = { ...EXPECT_BASE, host: new URL(pageUrl).hostname }
      const verdict = gate.sightingSupportsPublication(sighting, expect)
      if (verdict.ok !== false) throw new Error(`모호한 근거가 통과함: ${JSON.stringify(verdict)}`)
      if (verdict.uncertain !== true) {
        throw new Error(`확정 거부가 아니라 "모름"(uncertain:true) 이어야 하는데 그렇지 않음: ${JSON.stringify(verdict)}`)
      }
      return `probe.ambiguous=${JSON.stringify(probe.ambiguous)} · author=${JSON.stringify(probe.author)} · 판정=${JSON.stringify(verdict)}`
    })

    // ── E-NO-GLOBAL ──────────────────────────────────────────────────
    await scenario('E-NO-GLOBAL', '전역 nav 의 로그인 계정이 작성자로 새지 않음', async () => {
      // /wrong-author: probe.author 는 반드시 실제 글쓴이(someone_else)여야 하고 nav 의 내 계정이면 안 된다.
      if (!wrongProbe) throw new Error('E-WRONG-AUTHOR 단계가 먼저 실행돼야 함(probe 없음)')
      const wrongLeaked = normalizeText(wrongProbe.author) === LOGIN_ACCOUNT
      // /ambiguous: 글 컨테이너가 없어 author 를 못 읽어야 한다(비어있거나 ambiguous) — nav 값으로 채워지면 안 된다.
      const ambigAuthor = ambigProbe?.author
      const ambigLeaked = ambigAuthor !== undefined && ambigAuthor !== null && normalizeText(ambigAuthor) === LOGIN_ACCOUNT
      if (wrongLeaked) throw new Error(`/wrong-author 에서 nav 의 로그인 계정이 작성자로 유출됨: ${JSON.stringify(wrongProbe.author)}`)
      if (ambigLeaked) throw new Error(`/ambiguous 에서 nav 의 로그인 계정이 작성자로 유출됨: ${JSON.stringify(ambigAuthor)}`)
      return `wrong-author 작성자="${wrongProbe.author}"(nav 계정 아님) · ambiguous 작성자=${JSON.stringify(ambigAuthor)}(nav 계정 아님)`
    })

    // ── E-NEG (음성 대조) ────────────────────────────────────────────
    await scenario('E-NEG', '음성 대조 — 계정·시각을 안 보는 느슨한 판정은 wrong-author 근거를 통과시킨다', async () => {
      if (!wrongProbe) throw new Error('E-WRONG-AUTHOR 단계가 먼저 실행돼야 함(probe 없음)')
      const sighting = buildSighting(wrongProbe, wrongPageUrl, Date.now())
      const expect = { ...EXPECT_BASE, host: new URL(wrongPageUrl).hostname }
      const looseVerdict = looseJudge(sighting, expect)
      const realVerdict = gate.sightingSupportsPublication(sighting, expect)
      if (looseVerdict.ok !== true) throw new Error(`느슨한 판정이 wrong-author 를 거부함(음성 대조 실패 — 픽스처 재확인 필요): ${JSON.stringify(looseVerdict)}`)
      if (realVerdict.ok !== false) throw new Error(`실제 판정도 통과해버림(검출력 없음): ${JSON.stringify(realVerdict)}`)
      return `느슨한판정(호스트·문구·시각만)=${JSON.stringify(looseVerdict)} / 실제판정=${JSON.stringify(realVerdict)}`
    })
  } finally {
    for (const s of contentSessions) { try { s.close() } catch { /* ignore */ } }
    await killApp(child, shell)
    try { shell?.close() } catch { /* ignore */ }
    await closeServer(server)
  }

  console.log('\n===== verify-publish-evidence 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 이름: r.name, 상태: r.status, ms: r.ms })))
  const failed = results.filter((r) => r.status !== 'PASS')
  for (const f of failed) console.log(`FAIL ${f.id}: ${f.detail}`)
  fs.writeFileSync(path.join(args.out, 'publish-evidence-results.json'), JSON.stringify(results, null, 2))
  console.log(`PASS=${results.length - failed.length} FAIL=${failed.length} (총 ${results.length})`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify-publish-evidence] 치명적 오류:', err); process.exit(3) })
