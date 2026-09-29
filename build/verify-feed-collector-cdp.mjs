#!/usr/bin/env node
// verify-feed-collector-cdp.mjs — 매일 자동 수집(피드 수집기)이 제대로 모으고 중복을 거르는가
//
// 왜 (2026-09-07, 임무 31): 수집기는 **사용자가 안 볼 때 주기적으로 페이지를 읽어** 새 항목을 쌓는다.
// 중복 제거가 깨지면 매 실행마다 같은 항목이 새 것으로 잡혀 알림·웹훅이 반복되고,
// 반대로 과하게 걸러지면 새 글을 영영 못 본다. 그런데 상설 검사가 없었다.
//
//   C1 수집기를 만들고 즉시 실행하면 항목이 수집된다
//   C2 같은 페이지를 다시 수집하면 **새 항목 0건**(중복 제거)
//   C3 페이지에 **새 항목이 생기면 그것만** 잡는다  ← 양성 대조(C2 가 "기능이 죽어서 0건" 인 경우와 구분)
//   C4 키워드 필터가 걸리면 맞는 항목만 남는다
//
// 수집 대상은 **로컬 시험 페이지**뿐이다 — 외부 사이트에 접속하지 않는다.
//
// 사용: node build/verify-feed-collector-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, getTargetList, waitForPortFree, connectShellSessionReady, ensureSessionReady } from './lib/cdp.mjs'
import { preferFreePort, getFreePorts } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9263, pagePort: 8793, out: path.join(REPO, 'verify-out', 'feed-collector') }
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

// 목록 페이지 — 서버가 들고 있는 항목 배열을 그대로 그린다(도중에 항목을 추가할 수 있게).
let items = [
  { title: '고양이 소식 하나', href: '/a1' },
  { title: '강아지 소식 둘', href: '/a2' },
  { title: '고양이 소식 셋', href: '/a3' },
]
function listHtml() {
  const li = items.map((it) => `<li class="item"><a href="${it.href}">${it.title}</a></li>`).join('')
  return `<!doctype html><meta charset="utf-8"><title>시험 피드</title>
<body style="font:16px system-ui;padding:40px"><h1>시험 피드</h1><ul id="list">${li}</ul></body>`
}

// 웹훅 수신 서버 — 외부로 보내지 않고 **여기로만** 받는다.
function startHookServer(port) {
  const received = []
  let mode = 'ok'   // 'ok' | 'fail' | 'hang'
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body = null
      try { body = JSON.parse(raw || 'null') } catch { body = raw }
      received.push({ at: Date.now(), contentType: req.headers['content-type'] ?? '', body })
      if (mode === 'hang') return                       // 응답하지 않는다
      res.writeHead(mode === 'fail' ? 500 : 200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${port}/hook`,
    received,
    setMode(m) { mode = m },
    async close() {
      await new Promise((r) => {
        try { server.closeAllConnections?.() } catch { /* ignore */ }
        const t = setTimeout(r, 3000)
        server.close(() => { clearTimeout(t); r() })
      })
    },
  })))
}

function startPageServer(port) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(listHtml())
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${port}/`,
    async close() {
      await new Promise((r) => {
        try { server.closeAllConnections?.() } catch { /* ignore */ }
        const t = setTimeout(r, 3000)
        server.close(() => { clearTimeout(t); r() })
      })
    },
  })))
}

const evalIn = async (s, expression, awaitPromise = false) => {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  return r.result?.result?.value ?? r.result?.value
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE}`)
  fs.mkdirSync(args.out, { recursive: true })
  args.port = await preferFreePort(args.port, 'feed-collector')
  await waitForPortFree(args.port)
  ;[args.pagePort, args.hookPort] = await getFreePorts(2)

  const pages = await startPageServer(args.pagePort)
  const hook = await startHookServer(args.hookPort)

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true },
    startup: { mode: 'newtab', urls: [] },
    adblock: { enabled: false },
    // 요약(AI 브리핑)은 끄고 **수집·중복 제거**만 본다 — 모델에 의존하지 않게.
    ai: { enabled: true, provider: 'ollama', ollamaUrl: 'http://127.0.0.1:1', ollamaModel: 'test-model',
      webhookUrl: hook.url },   // 웹훅은 **로컬 수신 서버로만** 보낸다
  }, null, 2))

  const logStream = fs.createWriteStream(path.join(args.out, 'app.log'))
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')

    // 수집기 API 는 browser:// 페이지의 internalAPI 에만 있다.
    await evalIn(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, 'browser://ai-collectors')`, true)
    const deadline = Date.now() + 15000
    let target = null
    while (Date.now() < deadline && !target) {
      target = (await getTargetList(args.port)).find((t) => String(t.url).startsWith('browser://ai-collectors')) ?? null
      if (!target) await sleep(300)
    }
    if (!target) throw new Error('browser://ai-collectors 타깃을 찾지 못함')
    const cp = await connectSession(target, 'collectors')
    await ensureSessionReady(cp)

    const addCollector = async (patch = {}) => evalIn(cp, `window.internalAPI.ai.collectorAdd(${JSON.stringify({
      name: '검증 수집기', enabled: true, sources: [pages.url], scheduleType: 'interval',
      intervalMinutes: 60, rowSelector: '.item', fields: { 제목: 'a', 링크: 'a@href' },
      summarize: false, notify: false, webhook: false, maxItems: 40, ...patch,
    })}).then(c => c && c.id)`, true)

    const runNow = async (id) => JSON.parse(await evalIn(cp,
      `window.internalAPI.ai.collectorRun(${JSON.stringify(id)}).then(r => JSON.stringify(r))`, true) ?? '{}')

    // ---- C1 수집 ----
    let id = null
    {
      id = await addCollector()
      const r = await runNow(id)
      const count = r?.run?.items?.length ?? r?.run?.newCount ?? 0
      check('C1', '수집기를 실행하면 페이지 항목을 모은다', !!r?.ok && count >= 3,
        `ok=${r?.ok} · 수집 ${count}건(3 이상이어야 함)`)
    }

    // ---- C2 중복 제거 ----
    {
      const r = await runNow(id)
      const count = r?.run?.items?.length ?? r?.run?.newCount ?? 0
      check('C2', '같은 페이지를 다시 수집하면 새 항목이 없다', !!r?.ok && count === 0,
        `새 항목 ${count}건(0 이어야 함)`)
    }

    // ---- C3 양성 대조: 새 항목이 생기면 그것만 잡는다 ----
    {
      items = [...items, { title: '새로 올라온 고양이 소식', href: '/a4' }]
      const r = await runNow(id)
      const list = r?.run?.items ?? []
      const count = list.length
      const onlyNew = count === 1 && JSON.stringify(list).includes('새로 올라온')
      check('C3', '새 항목이 생기면 그것만 잡는다(양성 대조)', !!r?.ok && onlyNew,
        `새 항목 ${count}건 — 0 이면 C2 는 "기능이 죽어서" 통과한 것이다 · ${JSON.stringify(list).slice(0, 120)}`)
    }

    // ---- C4 키워드 필터 ----
    {
      const id2 = await addCollector({ name: '키워드 수집기', keyword: '강아지' })
      const r = await runNow(id2)
      const list = r?.run?.items ?? []
      const allMatch = list.length > 0 && list.every((it) => JSON.stringify(it).includes('강아지'))
      check('C4', '키워드 필터는 맞는 항목만 남긴다', !!r?.ok && allMatch,
        `수집 ${list.length}건 · 전부 일치=${allMatch} · ${JSON.stringify(list).slice(0, 120)}`)
      await evalIn(cp, `window.internalAPI.ai.collectorRemove(${JSON.stringify(id2)})`, true)
    }

    // ---- W1~W4: 웹훅 ----
    {
      const wid = await addCollector({ name: '웹훅 수집기', webhook: true })
      const sent = () => hook.received.length

      // W1 새 항목이 있으면 전송되고 페이로드에 항목이 담긴다
      const before1 = sent()
      const r1 = await runNow(wid)
      await sleep(1200)
      const got = hook.received[hook.received.length - 1]
      const payloadHasItem = JSON.stringify(got?.body ?? '').includes('고양이 소식 하나')
      check('W1', '새 항목이 있으면 웹훅이 전송되고 항목이 담긴다',
        sent() > before1 && payloadHasItem && String(got?.contentType).includes('json'),
        `전송 ${before1}→${sent()}회 · content-type=${got?.contentType} · 항목포함=${payloadHasItem}`)

      // W2 새 항목이 없으면 보내지 않는다
      const before2 = sent()
      await runNow(wid)
      await sleep(1200)
      check('W2', '새 항목이 없으면 웹훅을 보내지 않는다', sent() === before2,
        `전송 ${before2}→${sent()}회(같아야 함)`)

      // W3 양성 대조 — 새 항목이 생기면 다시 보낸다
      items = [...items, { title: '웹훅용 새 소식', href: '/w1' }]
      const before3 = sent()
      await runNow(wid)
      await sleep(1200)
      const last = hook.received[hook.received.length - 1]
      check('W3', '새 항목이 다시 생기면 웹훅을 보낸다(양성 대조)',
        sent() > before3 && JSON.stringify(last?.body ?? '').includes('웹훅용 새 소식'),
        `전송 ${before3}→${sent()}회 — 이것이 그대로면 W2 는 "웹훅이 죽어서" 통과한 것이다`)

      // W4 수신 서버가 실패해도 수집은 성공한다
      hook.setMode('fail')
      items = [...items, { title: '실패내성 확인용 소식', href: '/w2' }]
      const r4 = await runNow(wid)
      const count4 = r4?.run?.items?.length ?? 0
      hook.setMode('ok')
      check('W4', '웹훅 수신이 실패해도 수집 자체는 성공한다', !!r4?.ok && count4 >= 1,
        `수집 ok=${r4?.ok} · 새 항목 ${count4}건(웹훅은 500 응답)`)

      await evalIn(cp, `window.internalAPI.ai.collectorRemove(${JSON.stringify(wid)})`, true)
    }

    await evalIn(cp, `window.internalAPI.ai.collectorRemove(${JSON.stringify(id)})`, true)
    try { cp.close() } catch { /* ignore */ }
  } catch (err) {
    check('FATAL', '하네스 실행', false, err.message)
  } finally {
    try { shell?.close() } catch { /* ignore */ }
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {}); b.close()
    } catch { /* ignore */ }
    await sleep(1500)
    try { child.kill() } catch { /* ignore */ }
    await pages.close()
    await hook.close()
  }

  fs.writeFileSync(path.join(args.out, 'feed-collector-results.json'), JSON.stringify(results, null, 2))
  console.log('\n===== verify-feed-collector 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL')
  console.log(`PASS=${results.length - fail.length} FAIL=${fail.length} (총 ${results.length})`)
  for (const f of fail) console.log(`FAIL ${f.id}: ${f.detail}`)
  process.exit(fail.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
