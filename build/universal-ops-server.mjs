#!/usr/bin/env node
// universal-ops-server.mjs — verify-universal-ops-cdp.mjs 전용 로컬 fixture 서버.
// 의존성 0(Node 내장 http/crypto 만). 두 개의 오리진을 띄운다(cross-origin iframe 검증 위해
// 127.0.0.1:portA 와 localhost:portB — 호스트 이름이 달라 진짜 cross-origin 이 된다).
//
// 왜 두 오리진인가: U1(멀티오리진 iframe) 을 실제로 시험하려면 같은 머신·같은 포트 범위라도
// Same-Origin Policy 가 적용되는 "진짜 다른 오리진"이 필요하다. 127.0.0.1 과 localhost 는
// 브라우저 관점에서 별개 오리진(scheme+host+port 3중 중 host 가 다름)이므로 이걸로 충분하다.
//
// 다른 하네스(dl-matrix-server.mjs 등)와 동일한 close() 패턴을 쓴다 — keep-alive 연결이
// 남아 있으면 server.close() 콜백이 영영 안 오므로, closeAllConnections + 짧은 타임아웃으로 강제.

import http from 'node:http'
import crypto from 'node:crypto'

function makeBuffer(size, seed) {
  const buf = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i++) buf[i] = (i + seed) & 0xff
  return buf
}

function serveHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
}

function closeServer(server) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    const timer = setTimeout(finish, 3000)
    server.close(() => { clearTimeout(timer); finish() })
    try { server.closeAllConnections?.() } catch { /* ignore */ }
  })
}

/**
 * 두 오리진 + 모든 fixture 라우트를 띄운다.
 * @param {object} opts
 * @param {number} [opts.portA] 메인 오리진 포트(생략 시 OS 가 배정)
 * @param {number} [opts.portB] 다른 오리진 포트(생략 시 OS 가 배정)
 */
export async function startUniversalOpsServer(opts = {}) {
  const runId = crypto.randomBytes(4).toString('hex')
  const dlBuf = makeBuffer(64 * 1024, 0x77) // 다운로드 검증용 작은 바이너리
  const dlFilename = `ezb-ops-${runId}-dl.bin`

  // ── 서버 B(다른 오리진, cross-origin iframe 내용) — A 보다 먼저 띄워야 A 의 HTML 에 baseB 를 박을 수 있다.
  const serverB = http.createServer((req, res) => {
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { res.statusCode = 400; res.end(); return }
    if (url.pathname === '/frameB.html') {
      serveHtml(res, `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:8px;font:14px system-ui">
<button id="crossBtn">프레임B 버튼</button>
<script>
  document.getElementById('crossBtn').addEventListener('click', function () {
    // cross-origin 이라 parent.window 를 직접 건드릴 수 없다 — postMessage 로만 알린다.
    try { window.parent.postMessage({ __opsCross: true, run: ${JSON.stringify(runId)} }, '*') } catch (e) {}
  })
</script></body></html>`)
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise((resolve, reject) => {
    serverB.once('error', reject)
    serverB.listen(opts.portB ?? 0, 'localhost', () => resolve())
  })
  const portB = serverB.address().port
  const baseB = `http://localhost:${portB}`

  // ── 서버 A(메인 오리진) ──────────────────────────────────────────────
  const serverA = http.createServer((req, res) => {
    let url
    try { url = new URL(req.url, 'http://127.0.0.1') } catch { res.statusCode = 400; res.end(); return }
    const p = url.pathname

    if (p === '/') { serveHtml(res, HUB_HTML(baseB, runId)); return }
    if (p === '/frameA.html') { serveHtml(res, FRAME_A_HTML); return }
    if (p === '/page2') { serveHtml(res, PAGE2_HTML(runId)); return }
    if (p === '/rerender.html') { serveHtml(res, RERENDER_HTML); return }
    if (p === '/tabA.html') { serveHtml(res, TAB_HTML('A', '게시물 A')); return }
    if (p === '/tabB.html') { serveHtml(res, TAB_HTML('B', '결제하기')); return }
    if (p === `/dl-${runId}.bin`) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${dlFilename}"`,
        'Content-Length': String(dlBuf.length),
        'Cache-Control': 'no-store',
      })
      res.end(dlBuf)
      return
    }
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise((resolve, reject) => {
    serverA.once('error', reject)
    serverA.listen(opts.portA ?? 0, '127.0.0.1', () => resolve())
  })
  const portA = serverA.address().port
  const baseA = `http://127.0.0.1:${portA}`

  return {
    runId,
    portA, baseA, portB, baseB,
    urls: {
      hub: `${baseA}/`,
      page2: `${baseA}/page2`,
      rerender: `${baseA}/rerender.html`,
      tabA: `${baseA}/tabA.html`,
      tabB: `${baseA}/tabB.html`,
      dl: `${baseA}/dl-${runId}.bin`,
    },
    dlBuf,
    dlFilename,
    async close() {
      await Promise.all([closeServer(serverA), closeServer(serverB)])
    },
  }
}

// ── HTML 조각들 ─────────────────────────────────────────────────────────

const FRAME_A_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:8px;font:14px system-ui">
<button id="sameBtn">프레임A 버튼</button>
<script>
  document.getElementById('sameBtn').addEventListener('click', function () {
    // same-origin 이므로 부모 window 를 직접 건드릴 수 있다.
    try { window.parent.__ops.sameClicked = true } catch (e) {}
  })
</script></body></html>`

function PAGE2_HTML(runId) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>page2-${runId}</title></head>
<body style="font:16px system-ui;padding:24px"><h1 id="marker" data-run="${runId}">두번째 페이지</h1></body></html>`
}

// SPA 재렌더 시험용 최소 페이지 — 버튼 하나 + 그 컨테이너를 통째로 다른 내용으로 갈아끼우는 버튼.
// 다른 요소가 전혀 없어 ref 번호가 항상 결정론적이다(hub 페이지처럼 다른 요소들에 의해 인덱스가 흔들리지 않음).
const RERENDER_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body style="font:16px system-ui;padding:24px">
<div id="list"><button id="targetBtn">항목 A 클릭</button></div>
<button id="rerenderBtn">재렌더 트리거</button>
<p id="log">클릭 없음</p>
<script>
  window.__clicked = [];
  document.getElementById('targetBtn').addEventListener('click', function () { window.__clicked.push('old'); document.getElementById('log').textContent = 'old 클릭됨' });
  document.getElementById('rerenderBtn').addEventListener('click', function () {
    // innerHTML 통째로 교체 — 옛 DOM 노드는 완전히 destroy(detach)되고 이름도 전혀 다른 새 버튼이 생긴다.
    var el = document.createElement('button'); el.id = 'newBtn'; el.textContent = '전혀 다른 새 버튼';
    el.addEventListener('click', function () { window.__clicked.push('new'); document.getElementById('log').textContent = 'new 클릭됨' });
    var list = document.getElementById('list'); list.innerHTML = ''; list.appendChild(el);
  })
</script></body></html>`

// 탭 전환 ref 격리 시험용 — 두 탭 모두 단일 상호작용 요소만 있어 ref 번호가 둘 다 결정론적으로 0(또는 첫 번째)이 된다.
// which='A' 는 이름이 "게시물 A"(무해), which='B' 는 이름이 "결제하기"(민감해 보이는 대상) — 다른 탭의
// ref+epoch 로 이 탭을 조작하면 안 된다는 것을, "결제하기"가 잘못 눌리는지로 명확히 보여준다.
function TAB_HTML(which, label) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>tab${which}</title></head>
<body style="font:16px system-ui;padding:24px">
<button id="btn${which}">${label}</button>
<p id="log">클릭 없음</p>
<script>
  window.__clicked = false;
  document.getElementById('btn${which}').addEventListener('click', function () { window.__clicked = true; document.getElementById('log').textContent = '클릭됨' })
</script></body></html>`
}

function HUB_HTML(baseB, runId) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>universal-ops-hub</title></head>
<body style="font:15px system-ui;padding:16px">
<h1>범용 조작 시험 허브</h1>

<!-- ① same-origin iframe -->
<section><h2>same-origin</h2><iframe id="ifA" src="/frameA.html" style="width:300px;height:60px;border:1px solid #ccc"></iframe></section>

<!-- ② cross-origin iframe -->
<section><h2>cross-origin</h2><iframe id="ifB" title="frameB-ops" src="${baseB}/frameB.html" style="width:300px;height:60px;border:1px solid #ccc"></iframe></section>

<!-- ③④ shadow DOM 호스트(open/closed) — 스크립트가 채운다 -->
<section><h2>shadow</h2><div id="hostOpen"></div><div id="hostClosed"></div></section>

<!-- ⑤ window.open -->
<section><h2>새 창</h2><button id="openBtn">새창 열기</button></section>

<!-- ⑥ 업로드 3경로 — 드롭존 감지 로직은 "여기에 끌어다 놓으세요" 류 문구를 담은 컨테이너를 통째로
     드롭존으로 인식한다. 그래서 파일 입력·버튼과 같은 section 에 섞어 두면 그 큰 section 전체가
     매치돼 실제 드롭 좌표가 zone 밖(엉뚱한 형제 요소 위)으로 빗나간다 — 세 경로를 각자 독립된
     컨테이너로 분리해야 한다(1개의 section 에 신호 문구 하나만). -->
<section><h2>업로드 — 파일 입력</h2>
  <input type="file" id="fileIn" accept="video/mp4,video/webm">
</section>
<section><h2>업로드 — 파일 선택 창</h2>
  <button id="pickBtn">컴퓨터에서 선택</button>
</section>
<!-- 드롭존은 어떤 래퍼(section 등)로도 감싸지 않는다 — 감지 로직은 "여기에 끌어다 놓으세요" 문구를
     담은 가장 가까운 컨테이너를 문서 순서상 먼저 매치하므로, 래퍼를 씌우면 래퍼가 먼저 잡혀 실제
     드롭 좌표가 zone 밖으로 빗나간다(위 section 들처럼 감싸면 재현되는 결함 — 실측 확인). -->
<div id="zone" style="width:260px;height:80px;border:2px dashed #888;display:flex;align-items:center;justify-content:center">여기에 파일을 끌어다 놓으세요</div>

<!-- ⑦ 다운로드 링크 -->
<section><h2>다운로드</h2><a id="dlLink" href="/dl-${runId}.bin" download>파일 다운로드</a></section>

<!-- ⑧ 좌표·키보드·컨테이너 스크롤 -->
<section><h2>좌표/키/스크롤</h2>
  <canvas id="canvas" width="200" height="80" style="border:1px solid #999;display:block"></canvas>
  <input id="keyIn" value="select-me-1234" style="margin-top:6px">
  <div id="scrollBox" style="width:260px;height:100px;overflow:auto;border:1px solid #999;margin-top:6px">
    <div style="height:500px;padding-top:8px">스크롤 해야 보임</div>
    <button id="deepBtn">스크롤 버튼</button>
    <div style="height:20px"></div>
  </div>
</section>

<p id="log">-</p>

<script>
  window.__ops = {
    sameClicked: false, crossClicked: false,
    openShadowClicked: false, closedShadowClicked: false,
    windowOpened: false,
    dropped: null,
    canvasClicked: false,
    containerScrollBtnClicked: false,
  };
  window.addEventListener('message', function (e) {
    if (e.data && e.data.__opsCross) window.__ops.crossClicked = true;
  });

  // open shadow
  var hostOpen = document.getElementById('hostOpen');
  var srOpen = hostOpen.attachShadow({ mode: 'open' });
  var bOpen = document.createElement('button'); bOpen.textContent = '쉐도우 열림 버튼';
  bOpen.addEventListener('click', function () { window.__ops.openShadowClicked = true });
  srOpen.appendChild(bOpen);

  // closed shadow — page-actions 는 이 안을 구조적으로 볼 수 없어야 한다.
  var hostClosed = document.getElementById('hostClosed');
  var srClosed = hostClosed.attachShadow({ mode: 'closed' });
  var bClosed = document.createElement('button'); bClosed.textContent = '쉐도우 닫힘 버튼';
  bClosed.addEventListener('click', function () { window.__ops.closedShadowClicked = true });
  srClosed.appendChild(bClosed);

  document.getElementById('openBtn').addEventListener('click', function () {
    window.__ops.windowOpened = true;
    window.open('/page2', '_blank');
  });

  // 드롭존(파일 입력 없이 ondrop 만)
  var zone = document.getElementById('zone');
  zone.addEventListener('dragover', function (e) { e.preventDefault() });
  zone.addEventListener('drop', function (e) {
    e.preventDefault();
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    window.__ops.dropped = f ? { name: f.name, size: f.size } : null;
  });

  // 파일 선택 창(버튼 눌러야 input 생성 — armFileChooser 시험 대상)
  document.getElementById('pickBtn').addEventListener('click', function () {
    var i = document.createElement('input'); i.type = 'file'; i.id = 'lateFile';
    i.addEventListener('change', function () { window.__ops.lateFile = i.files[0] ? i.files[0].name : null });
    document.body.appendChild(i);
    i.click();
  });

  // 캔버스 클릭(DOM 요소 목록에 이름으로 안 잡히는 대상 — click_at 전용)
  document.getElementById('canvas').addEventListener('click', function () { window.__ops.canvasClicked = true });

  // 컨테이너 내부 스크롤 검증용 버튼
  document.getElementById('deepBtn').addEventListener('click', function () { window.__ops.containerScrollBtnClicked = true });
</script>
</body></html>`
}
