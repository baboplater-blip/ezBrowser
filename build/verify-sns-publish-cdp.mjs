#!/usr/bin/env node
// verify-sns-publish-cdp.mjs — SNS 게시 레시피(인스타·유튜브·틱톡) + 완료 신호 결정론 검사
//
// 왜 (2026-09-13): 레시피(sns-publish.ts)는 실제 사이트에서만 진짜로 검증되지만, 실제 게시는 되돌릴 수 없고
// 계정이 필요해 게이트에 넣을 수 없다. 그래서 **레시피가 기대하는 흐름을 모사한 모의 페이지**(만들기 → 파일 → 다음 →
// 캡션 → 공유 → "게시물이 공유되었습니다")를 두고, 각본 LLM 이 레시피대로 움직일 때 다음이 성립하는지 본다:
//   S1 인스타 게시: 파일 첨부·캡션·공유가 실제로 되고, **완료 신호로 마지막 LLM 호출이 생략**된다(호출 수 = 각본 수)
//   S2 인스타 게시 직전까지(draft): 공유 클릭이 코드로 차단되고 게시되지 않는다
//   S3 유튜브 게시: 제목·설명·공개·게시 → "동영상 게시됨" 으로 완료
//   S4 틱톡 게시: 업로드 100% 대기 → 캡션 → 게시 → "게시되었습니다" 로 완료
//   S5 완료 신호가 안 뜨면(게시 실패 모의) 모델에 다시 묻고 done 에 미확인 경고가 붙는다
//   S6 표식 왕복: buildCompletionMark ↔ parseCompletionMark
//   S7 캡션에 완료 어휘가 있어도 게시 클릭 전에는 완료로 보지 않는다(contenteditable 캡션)
// 실제 사이트 파일럿은 docs/sns-pilot.md 절차로 사람이 돌린다.
//
// 사용: node build/verify-sns-publish-cdp.mjs [--port <n>] [--out <dir>]

import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { connectSession, getTargetList, waitForPortFree, connectShellSessionReady, ensureSessionReady } from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9297, out: path.join(REPO, 'verify-out', 'sns-publish') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const NL = String.fromCharCode(10)
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}

// ===== 모의 페이지 =====
const HEAD = '<!doctype html><meta charset="utf-8"><style>body{font:15px system-ui;padding:32px}[hidden]{display:none!important}button{margin:4px}</style>'
const PAGES = {
  // 인스타그램(웹) 모사 — 만들기 → 파일 → 다음 → 다음 → 캡션 → 공유하기 → 완료 문구. ?fail=1 이면 공유가 실패 문구를 낸다.
  '/ig': HEAD + `<title>Instagram</title><body>
<h1>Instagram</h1>
<nav><button id="home">홈</button><button id="create">만들기</button><button id="profile">프로필</button></nav>
<ul id="feed"></ul>
<div id="modal" role="dialog" aria-modal="true" hidden>
  <h2>새 게시물 만들기</h2>
  <div id="s1"><p>사진과 동영상을 여기에 드래그하세요</p><input id="file" type="file" accept="image/*,video/*" hidden><button id="pick">컴퓨터에서 선택</button></div>
  <div id="s2" hidden><p>자르기</p><button id="n1">다음</button></div>
  <div id="s3" hidden><p>수정</p><button id="n2">다음</button></div>
  <div id="s4" hidden><div id="cap" contenteditable="true" aria-label="문구 입력..." style="border:1px solid #999;min-height:40px;width:300px"></div><br><button id="share">공유하기</button></div>
  <div id="ok" hidden><h3>게시물이 공유되었습니다.</h3></div>
  <div id="bad" hidden><h3>게시물을 공유하지 못했습니다. 다시 시도하세요.</h3></div>
</div>
<script>
  window.__shared=false; window.__caption=''; window.__file='';
  const $=(i)=>document.getElementById(i); const fail=new URL(location.href).searchParams.get('fail')==='1'
  // 피드 링크 120개 — 실제 인스타처럼 DOM 앞쪽에 요소가 많아 관찰 상한(80)에 대화상자 버튼이 잘리던 결함(2026-09-13 실사이트) 재현
  for (let i = 0; i < 120; i++) { const li = document.createElement('li'); const a = document.createElement('a'); a.href = '#p' + i; a.textContent = '게시물 ' + i + ' 보기'; li.appendChild(a); $('feed').appendChild(li) }
  $('create').onclick=()=>{ $('modal').hidden=false }
  $('pick').onclick=()=>{ $('file').click() }
  $('file').onchange=()=>{ window.__file=$('file').files[0]?.name||''; $('s1').hidden=true; $('s2').hidden=false }
  $('n1').onclick=()=>{ $('s2').hidden=true; $('s3').hidden=false }
  $('n2').onclick=()=>{ $('s3').hidden=true; $('s4').hidden=false }
  $('share').onclick=()=>{ window.__caption=$('cap').textContent; $('s4').hidden=true; if(fail){ $('bad').hidden=false } else { window.__shared=true; $('ok').hidden=false } }
</script></body>`,
  // 유튜브 스튜디오 모사 — 만들기 → 동영상 업로드 → 파일 → 제목·설명·아동용 → 다음×3 → 공개 → 게시 → "동영상 게시됨"
  '/yt': HEAD + `<title>YouTube Studio</title><body>
<h1>채널 대시보드</h1>
<button id="create">만들기</button>
<div id="menu" hidden><button id="upload">동영상 업로드</button><button id="live">라이브 스트리밍 시작</button></div>
<div id="dlg" role="dialog" aria-modal="true" hidden>
  <div id="u1"><p>업로드할 동영상 파일을 드래그 앤 드롭하세요</p><input id="file" type="file" accept="video/*" hidden><button id="pick">파일 선택</button></div>
  <div id="u2" hidden>
    <h2>세부정보</h2>
    <label>제목 <input id="title" placeholder="제목(필수)"></label><br>
    <label>설명 <textarea id="desc" placeholder="시청자에게 동영상에 대해 설명해 주세요"></textarea></label><br>
    <p>아동용 동영상인가요?</p>
    <label><input type="radio" name="kids" id="kidsYes"> 예, 아동용입니다</label>
    <label><input type="radio" name="kids" id="kidsNo" checked> 아니요, 아동용이 아닙니다</label><br>
    <button id="next1">다음</button>
  </div>
  <div id="u3" hidden><h2>동영상 요소</h2><button id="next2">다음</button></div>
  <div id="u4" hidden><h2>검토</h2><p>문제가 발견되지 않았습니다</p><button id="next3">다음</button></div>
  <div id="u5" hidden><h2>공개 상태</h2>
    <label><input type="radio" name="vis" id="visPublic"> 공개</label>
    <label><input type="radio" name="vis" id="visPrivate" checked> 비공개</label><br>
    <button id="save">저장</button><button id="publish">게시</button>
  </div>
  <div id="ok" hidden><h3>동영상 게시됨</h3><p>동영상 링크: https://youtu.be/mock123</p></div>
</div>
<script>
  window.__published=false; window.__title=''; window.__desc=''; window.__vis=''; window.__file='';
  const $=(i)=>document.getElementById(i)
  $('create').onclick=()=>{ $('menu').hidden=false }
  $('upload').onclick=()=>{ $('menu').hidden=true; $('dlg').hidden=false }
  $('pick').onclick=()=>{ $('file').click() }
  $('file').onchange=()=>{ window.__file=$('file').files[0]?.name||''; $('u1').hidden=true; $('u2').hidden=false; $('title').value=window.__file.replace(/\\.[^.]+$/,'') }
  $('next1').onclick=()=>{ $('u2').hidden=true; $('u3').hidden=false }
  $('next2').onclick=()=>{ $('u3').hidden=true; $('u4').hidden=false }
  $('next3').onclick=()=>{ $('u4').hidden=true; $('u5').hidden=false }
  $('publish').onclick=()=>{ window.__title=$('title').value; window.__desc=$('desc').value; window.__vis=$('visPublic').checked?'public':'private'; window.__published=true; $('u5').hidden=true; $('ok').hidden=false }
  $('save').onclick=()=>{ window.__title=$('title').value; window.__desc=$('desc').value; window.__vis='private'; $('u5').hidden=true }
</script></body>`,
  // 틱톡 업로드 모사 — 파일 → 업로드 진행률(0→100%) → 설명 → 게시(진행 중엔 비활성) → "게시되었습니다"
  '/tt': HEAD + `<title>TikTok 업로드</title><body>
<h1>동영상 업로드</h1>
<div id="t1"><p>업로드할 동영상을 선택하세요</p><input id="file" type="file" accept="video/*" hidden><button id="pick">파일 선택</button></div>
<div id="t2" hidden>
  <p id="prog" role="progressbar" aria-valuenow="0">업로드 중 0%</p>
  <label>설명 <textarea id="cap"></textarea></label><br>
  <button id="drafts">임시 저장</button><button id="post" disabled>게시</button>
</div>
<div id="ok" hidden><h3>동영상이 게시되었습니다</h3></div>
<script>
  window.__posted=false; window.__caption=''; window.__file='';
  const $=(i)=>document.getElementById(i)
  $('pick').onclick=()=>{ $('file').click() }
  $('file').onchange=()=>{ window.__file=$('file').files[0]?.name||''; $('t1').hidden=true; $('t2').hidden=false; $('cap').value=window.__file
    let p=0; const t=setInterval(()=>{ p+=25; $('prog').textContent='업로드 중 '+p+'%'; $('prog').setAttribute('aria-valuenow',String(p)); if(p>=100){ clearInterval(t); $('prog').textContent='업로드 완료 100%'; $('post').disabled=false } },250) }
  $('post').onclick=()=>{ if($('post').disabled) return; window.__caption=$('cap').value; window.__posted=true; $('t2').hidden=true; $('ok').hidden=false }
</script></body>`,
}

function startPageServer(port) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const html = PAGES[u.pathname]
    if (!html) { res.writeHead(404); res.end('nope'); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((r) => { try { server.closeAllConnections?.() } catch { /* ignore */ } const t = setTimeout(r, 3000); server.close(() => { clearTimeout(t); r() }) })
    },
  })))
}

const evalIn = async (s, expression, awaitPromise = false) => {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.result?.value ?? r.result?.value
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`패키지 없음: ${EXE}`)
  fs.mkdirSync(args.out, { recursive: true })

  // S6 — 표식 왕복(앱 없이, 빌드 산출물의 순수 함수)
  try {
    const gate = require(path.join(REPO, 'app', 'dist', 'main', 'features', 'ai', 'agent-gate.js'))
    const mark = gate.buildCompletionMark({ texts: ['게시물이 공유되었습니다', 'Your post has been shared'], urlContains: '/p/', message: '인스타 완료' })
    const parsed = gate.parseCompletionMark('아래 글을 올려 주세요.' + NL + mark + NL + '# 내용')
    check('S6', '완료 신호 표식 왕복(build ↔ parse)',
      !!parsed && parsed.texts.length === 2 && parsed.texts[1] === 'Your post has been shared' && parsed.urlContains === '/p/' && parsed.message === '인스타 완료' && gate.parseCompletionMark('표식 없음') === null,
      `mark="${mark.slice(0, 70)}…" → ${JSON.stringify(parsed)}`)
  } catch (err) { check('S6', '완료 신호 표식 왕복', false, err.message) }

  args.port = await preferFreePort(args.port, 'verify-sns-publish-cdp.mjs')
  await waitForPortFree(args.port)
  const [llmPort, pagePort] = await getFreePorts(2)
  const llm = await startFakeLlm({ port: llmPort })
  const pages = await startPageServer(pagePort)

  // 자료 폴더 — 첨부할 더미 파일
  const filesDir = path.join(args.out, 'files')
  fs.rmSync(filesDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(filesDir, 'videos'), { recursive: true })
  fs.writeFileSync(path.join(filesDir, 'cat.jpg'), Buffer.from('ffd8ffe000104a464946', 'hex'))
  fs.writeFileSync(path.join(filesDir, 'videos', 'clip.mp4'), Buffer.alloc(2048, 1))

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true }, startup: { mode: 'newtab', urls: [] }, adblock: { enabled: false },
    ai: { enabled: true, provider: 'ollama', ollamaUrl: llm.url, ollamaModel: 'test-model', agentMaxSteps: 14, agentAutoApprove: false, agentVision: 'off', agentHumanInput: false, agentInputMode: 'fast', agentFilesDir: filesDir, memoryEnabled: false },
  }, null, 2))

  const logStream = fs.createWriteStream(path.join(args.out, 'app.log'))
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(logStream); child.stderr.pipe(logStream)

  let shell = null
  try {
    shell = await connectShellSessionReady(args.port)
    const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
    const tabId = await evalIn(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(pages.url + '/ig')}).then(t => t.id)`, true)
    await sleep(2000)
    await evalIn(shell, 'window.__ev = []; window.browserAPI.ai.onAgentEvent((e) => window.__ev.push(e)); true')

    let page = null
    async function openPage(pathq) {
      try { page?.close() } catch { /* ignore */ }
      await evalIn(shell, `window.browserAPI.tabs.navigate(${JSON.stringify(tabId)}, ${JSON.stringify(pages.url + pathq)})`, true)
      await sleep(1200)
      let t = null
      for (let i = 0; i < 20 && !t; i++) { t = (await getTargetList(args.port)).find((x) => String(x.url) === pages.url + pathq); if (!t) await sleep(300) }
      if (!t) throw new Error('모의 페이지 타깃 없음: ' + pathq)
      page = await connectSession(t, 'page')
      await ensureSessionReady(page)
    }

    async function run({ reqId, task, script, timeoutMs = 60000 }) {
      llm.setScript(script)
      await evalIn(shell, 'window.__ev = []; true')
      await evalIn(shell, `window.browserAPI.ai.agentStart(${JSON.stringify({ reqId, tabId, task })})`, true)
      const deadline = Date.now() + timeoutMs
      let evs = []
      while (Date.now() < deadline) {
        evs = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__ev)') ?? '[]')
        if (evs.some((e) => e.type === 'confirm')) await evalIn(shell, `window.browserAPI.ai.agentConfirm(${JSON.stringify(reqId)}, true)`, true).catch(() => {})
        if (evs.some((e) => e.type === 'ask')) await evalIn(shell, `window.browserAPI.ai.agentReply(${JSON.stringify(reqId)}, "계속")`, true).catch(() => {})
        if (evs.some((e) => e.type === 'done' || e.type === 'error' || e.type === 'cancelled')) break
        await sleep(300)
      }
      return { evs, types: evs.map((e) => e.type), done: evs.find((e) => e.type === 'done'), labels: evs.filter((e) => e.type === 'result').map((e) => `${e.ok ? '✓' : '✗'}${e.label}`) }
    }

    // 각본 헬퍼 — 관찰문에서 라벨로 ref 를 찾는다. **정확 일치 우선**, 없으면 부분일치(공유 라이브러리의 refFor 는
    // 부분일치뿐이라 "공개" 가 "비공개" 에, "게시" 가 큰 컨테이너 텍스트에 걸렸다 — 2026-09-13 S3·S4 거짓 실패).
    const missed = []
    const refOf = (ctx, label) => {
      const re = /\[(\d+)\]\s+\S+\s+"([^"]*)"/g
      let m; let partial = null
      while ((m = re.exec(String(ctx.lastUser)))) {
        const name = String(m[2]).trim()
        if (name === label) return Number(m[1])
        if (partial == null && name.includes(label)) partial = Number(m[1])
      }
      if (partial == null) missed.push({ label, obs: String(ctx.lastUser).replace(/\s+/g, ' ').slice(0, 500) })
      return partial
    }
    const clickL = (label) => ({ reply: (ctx) => { const ref = refOf(ctx, label); return ref == null ? JSON.stringify({ action: 'done', message: `${label} 못 찾음` }) : JSON.stringify({ action: 'click', ref }) } })
    const upload = (name) => ({ reply: () => JSON.stringify({ action: 'upload_file', name }) })
    let lastObsElements = ''
    const typeThenClick = (fieldLabel, text, clickLabel) => ({ reply: (ctx) => {
      lastObsElements = String(ctx.lastUser).split(String.fromCharCode(10)).filter((l) => /^\[\d+\]/.test(l)).join(' | ').slice(0, 400)
      const f = refOf(ctx, fieldLabel); const c = refOf(ctx, clickLabel)
      if (f == null || c == null) return JSON.stringify({ action: 'done', message: `못 찾음: ${f == null ? fieldLabel : clickLabel}` })
      return JSON.stringify([{ action: 'type', ref: f, text }, { action: 'click', ref: c }])
    } })
    const extraCall = { reply: () => JSON.stringify({ action: 'done', message: '추가 호출(완료 신호가 일을 안 함)' }) }
    const snsTask = (p) => evalIn(shell, `window.browserAPI.ai.snsBuildTask(${JSON.stringify(p)}).then(r => r.task)`, true)

    // ---- S1: 인스타 게시 — 완료 신호로 마지막 호출 생략 ----
    {
      await openPage('/ig')
      const task = await snsTask({ platform: 'instagram', mode: 'publish', file: 'cat.jpg', caption: '오늘의 고양이', tags: ['cat', '고양이'], autoOpen: false })
      const script = [clickL('만들기'), upload('cat.jpg'), clickL('다음'), clickL('다음'), typeThenClick('문구 입력...', '오늘의 고양이 #cat #고양이', '공유하기'), extraCall]
      const r = await run({ reqId: 'S1', task, script })
      const st = { shared: await evalIn(page, 'window.__shared'), caption: await evalIn(page, 'window.__caption'), file: await evalIn(page, 'window.__file') }
      const sig = r.evs.find((e) => e.type === 'result' && e.label === '완료 신호 확인')
      check('S1', '인스타 게시: 첨부·캡션·공유 후 완료 신호로 모델 호출 없이 done',
        st.shared === true && st.file === 'cat.jpg' && st.caption.includes('오늘의 고양이') && !!sig && llm.count === 5 && String(r.done?.message ?? '').includes('인스타그램 게시 완료') && !String(r.done?.message ?? '').includes('⚠'),
        `shared=${st.shared} file=${st.file} caption="${st.caption.slice(0, 20)}" 신호=${!!sig} LLM 호출=${llm.count}(5 이어야) done="${String(r.done?.message ?? '').slice(0, 60)}" · ${r.labels.join(' ')}`)
    }
    // ---- S2: 인스타 게시 직전까지(draft) — 공유 클릭 차단 ----
    {
      await openPage('/ig')
      const task = await snsTask({ platform: 'instagram', mode: 'draft', file: 'cat.jpg', caption: '초안 캡션', autoOpen: false })
      const script = [clickL('만들기'), upload('cat.jpg'), clickL('다음'), clickL('다음'), typeThenClick('문구 입력...', '초안 캡션', '공유하기'), { reply: () => JSON.stringify({ action: 'done', message: '준비 완료' }) }]
      const r = await run({ reqId: 'S2', task, script })
      const st = { shared: await evalIn(page, 'window.__shared'), cap: await evalIn(page, 'document.getElementById("cap").textContent') }
      const blocked = r.evs.some((e) => e.type === 'result' && !e.ok && /발행|게시/.test(String(e.detail ?? '') + String(e.label ?? '')))
      check('S2', '게시 직전까지(draft): 공유 클릭이 코드로 차단되고 게시되지 않는다',
        st.shared === false && st.cap === '초안 캡션' && blocked && r.done,
        `shared=${st.shared} 캡션입력=${st.cap === '초안 캡션'} 차단=${blocked} · ${r.labels.join(' ')}`)
    }
    // ---- S3: 유튜브 게시 ----
    {
      missed.length = 0
      await openPage('/yt')
      const task = await snsTask({ platform: 'youtube', mode: 'publish', file: 'videos/clip.mp4', caption: '설명 본문', title: '모의 영상 제목', tags: ['test'], autoOpen: false })
      const script = [
        clickL('만들기'), clickL('동영상 업로드'), upload('videos/clip.mp4'),
        { reply: (ctx) => { const t = refOf(ctx, '제목'); const d = refOf(ctx, '설명'); const n = refOf(ctx, '다음'); if (t == null || d == null || n == null) return JSON.stringify({ action: 'done', message: '세부정보 칸 못 찾음' }); return JSON.stringify([{ action: 'type', ref: t, text: '모의 영상 제목' }, { action: 'type', ref: d, text: '설명 본문' }, { action: 'click', ref: n }]) } },
        clickL('다음'), clickL('다음'), clickL('공개'), clickL('게시'), extraCall,
      ]
      const r = await run({ reqId: 'S3', task, script, timeoutMs: 90000 })
      const st = { pub: await evalIn(page, 'window.__published'), title: await evalIn(page, 'window.__title'), desc: await evalIn(page, 'window.__desc'), vis: await evalIn(page, 'window.__vis') }
      const sig = r.evs.find((e) => e.type === 'result' && e.label === '완료 신호 확인')
      check('S3', '유튜브 게시: 제목·설명·공개·게시 → "동영상 게시됨" 완료 신호',
        st.pub === true && st.title === '모의 영상 제목' && st.desc === '설명 본문' && st.vis === 'public' && !!sig && llm.count === 8,
        `published=${st.pub} title="${st.title}" vis=${st.vis} 신호=${!!sig} LLM 호출=${llm.count}(8 이어야) · ${r.labels.join(' ')}` + (missed.length ? ` · 못 찾음(${missed[0].label}) 관찰: ${missed[0].obs.slice(0, 300)}` : ''))
    }
    // ---- S4: 틱톡 게시 — 업로드 100% 대기 후 게시 ----
    {
      missed.length = 0
      await openPage('/tt')
      const task = await snsTask({ platform: 'tiktok', mode: 'publish', file: 'videos/clip.mp4', caption: '틱톡 캡션', autoOpen: false })
      const script = [upload('videos/clip.mp4'), { reply: () => JSON.stringify({ action: 'wait_for', text: '100%', timeout: 10000 }) }, typeThenClick('설명', '틱톡 캡션', '게시'), extraCall]
      const r = await run({ reqId: 'S4', task, script, timeoutMs: 90000 })
      const st = { posted: await evalIn(page, 'window.__posted'), cap: await evalIn(page, 'window.__caption') }
      const sig = r.evs.find((e) => e.type === 'result' && e.label === '완료 신호 확인')
      check('S4', '틱톡 게시: 업로드 완료 대기 → 캡션 → 게시 → "게시되었습니다" 완료 신호',
        st.posted === true && String(st.cap).includes('틱톡 캡션') && !!sig && llm.count === 3,
        `posted=${st.posted} caption="${String(st.cap).slice(0, 20)}" 신호=${!!sig} LLM 호출=${llm.count}(3 이어야) · ${r.labels.join(' ')} · 요소: ${lastObsElements} · 결과상세: ${r.evs.filter((e) => e.type === 'result').map((e) => String(e.detail ?? '').slice(0, 60)).join(' / ')}`)
    }
    // ---- S7: 캡션에 완료 어휘가 들어 있어도 게시 클릭 전에는 완료로 보지 않는다(contenteditable 캡션 = 실제 인스타) ----
    {
      missed.length = 0
      await openPage('/ig')
      const task = await snsTask({ platform: 'instagram', mode: 'publish', file: 'cat.jpg', caption: '어제 게시물이 공유되었습니다 라고 쓴 글 이어서', autoOpen: false })
      const script = [clickL('만들기'), upload('cat.jpg'), clickL('다음'), clickL('다음'), typeThenClick('문구 입력...', '어제 게시물이 공유되었습니다 라고 쓴 글 이어서', '공유하기'), extraCall]
      const r = await run({ reqId: 'S7', task, script })
      const st = { shared: await evalIn(page, 'window.__shared'), caption: await evalIn(page, 'window.__caption') }
      const sigIdx = r.evs.findIndex((e) => e.type === 'result' && e.label === '완료 신호 확인')
      const shareIdx = r.evs.findIndex((e) => e.type === 'result' && String(e.label ?? '').includes('공유하기'))
      check('S7', '캡션에 완료 어휘가 있어도 게시 클릭 전에는 완료로 보지 않는다(신호는 공유 클릭 뒤에만)',
        st.shared === true && String(st.caption).includes('공유되었습니다') && sigIdx > shareIdx && shareIdx >= 0 && llm.count === 5,
        `shared=${st.shared} 신호idx=${sigIdx} 공유클릭idx=${shareIdx}(신호가 뒤여야) LLM 호출=${llm.count}(5 이어야) · ${r.labels.join(' ')}`)
    }
    // ---- S5: 완료 신호가 안 뜨면 재질의 + 미확인 경고 ----
    {
      await openPage('/ig?fail=1')
      const task = await snsTask({ platform: 'instagram', mode: 'publish', file: 'cat.jpg', caption: '실패 시험', autoOpen: false })
      const script = [clickL('만들기'), upload('cat.jpg'), clickL('다음'), clickL('다음'), typeThenClick('문구 입력...', '실패 시험', '공유하기'), { reply: () => JSON.stringify({ action: 'done', message: '게시했다고 생각함' }) }]
      const r = await run({ reqId: 'S5', task, script })
      const sig = r.evs.find((e) => e.type === 'result' && e.label === '완료 신호 확인')
      const msg = String(r.done?.message ?? '')
      check('S5', '완료 신호가 안 뜨면(게시 실패) 모델에 다시 묻고 done 에 미확인 경고가 붙는다',
        !sig && llm.count === 6 && msg.includes('⚠') && msg.includes('게시했다고 생각함'),
        `신호=${!!sig}(false 여야) LLM 호출=${llm.count}(6 이어야) done="${msg.slice(0, 90)}"`)
    }

    try { page?.close() } catch { /* ignore */ }
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
    await llm.close()
    await pages.close()
  }

  fs.writeFileSync(path.join(args.out, 'sns-publish-results.json'), JSON.stringify(results, null, 2))
  console.log(NL + '===== verify-sns-publish 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const fail = results.filter((r) => r.status === 'FAIL').length
  console.log(`PASS=${results.length - fail} FAIL=${fail} (총 ${results.length})`)
  process.exit(fail ? 1 : 0)
}

main().catch((err) => { console.error('harness 실패:', err); process.exit(1) })
