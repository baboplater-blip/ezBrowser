#!/usr/bin/env node
// social-fixture-server.mjs — "이미지 생성 사이트 + SNS 업로드 + 블로그" 를 흉내낸 로컬 픽스처.
//
// 이것은 검증용 로컬 서버다. 외부 네트워크 접속은 0줄이다 — 실제 젠스파크·ChatGPT·
// 인스타그램·네이버에는 절대 접속하지 않는다. 그 UI 를 흉내낸 로컬 페이지일 뿐이다.
// 의존성 0(node:http, node:zlib, node:crypto, node:url 만). 127.0.0.1 loopback 전용.
//
// 라우트 개요:
//
//   [이미지 생성 사이트 흉내]
//   GET  /gen                          로고·광고·썸네일 3개(기준선, 페이지 로드부터 존재)
//                                       + 프롬프트 입력칸 + "생성" 버튼. 쿼리로 동작 변경:
//                                       ?delay=ms  ?fail=1  ?blob=1  ?two=1  ?html=1
//   GET  /img/generated-<seed>.png     800x600 진짜 PNG. seed 별로 다른 바이트(sha256 다름).
//   GET  /img/logo.png|ad.png|thumb1..3.png   고정 기준선 이미지(생성물 아님).
//   GET  /img/fake.png                 Content-Type: image/png 인데 본문은 HTML(위장 파일).
//   GET  /img/empty.png                0 바이트.
//   GET  /img/needcookie.png           쿠키 sess=ok 없으면 403+HTML, 있으면 진짜 PNG.
//   GET  /setcookie                    Set-Cookie: sess=ok; Path=/
//
//   [SNS 업로드 흉내]
//   GET  /sns[?iframe=1]               "새 게시물" 버튼 → 대화상자(파일+캡션+공유하기).
//                                       iframe=1 이면 폼 전체가 다른 출처(altBase) iframe 안에.
//   GET  /sns/embed                    (altBase 전용) iframe 안에 뜨는 업로드 폼 단독 페이지.
//   POST /sns/publish                  (양쪽 오리진 공용) multipart 파싱 → sha256 기록.
//   GET  /sns/post/<id>                게시된 항목 확인용 페이지.
//   GET  /state                        { publishes, comments, likes } JSON — 판정의 근거.
//
//   [블로그 검색 흉내]
//   GET  /blog/search?q=...            결과 6개: 내 블로그 1 · 무관 1 · 관련 4.
//   GET  /blog/post/<id>               600자+ 본문 + 고유 표지 + 좋아요/댓글 폼.
//                                       id=3 은 이미 좋아요 눌린 상태. id=9 는 500 실패.
//   GET  /blog/mine/<id>               내 블로그 글(건너뛰어야 할 자기 글).
//   POST /blog/like                    { postId, returnTo } → 좋아요 토글 후 returnTo 로 302.
//   POST /blog/comment                 { postId, text, returnTo } → 댓글 추가 후 302.
//
// 상태는 메모리에만 있다(재시작하면 초기화). close() 는 keep-alive 연결을 강제로 끊은 뒤
// 닫는다 — 안 그러면 이 저장소의 다른 픽스처들이 실제로 겪은 대로 close() 콜백이 영영
// 안 온다(smoke-media-server.mjs 주석 참고).

import http from 'node:http'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { getFreePorts } from './lib/ports.mjs'

// ───────────────────────── 공통 HTML/HTTP 헬퍼 ─────────────────────────

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function page(body, title = 'social-fixture') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`
}

function sendHtml(res, status, body) {
  const buf = Buffer.from(body, 'utf8')
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
  })
  res.end(buf)
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
  })
  res.end(buf)
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' })
  res.end()
}

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function readBodyText(req) {
  return readBodyBuffer(req).then((buf) => buf.toString('utf8'))
}

function parseForm(body) {
  const out = {}
  for (const [k, v] of new URLSearchParams(body || '')) out[k] = v
  return out
}

function hasCookiePair(req, pair) {
  const c = req.headers.cookie || ''
  return c.split(';').map((s) => s.trim()).includes(pair)
}

/** 열린 연결이 있으면 server.close() 콜백이 영영 안 온다 — 강제로 끊고 3초 상한을 둔다. */
function closeServer(server) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    const timer = setTimeout(finish, 3000)
    server.close(() => { clearTimeout(timer); finish() })
    try { server.closeAllConnections?.() } catch { /* ignore */ }
  })
}

// ───────────────────────── 의존성 0 PNG 인코더 ─────────────────────────
// node:zlib 의 deflateSync 는 RFC1950(zlib) 스트림을 만든다 — PNG IDAT 이 요구하는 바로 그것.
// CRC32 는 PNG 청크마다 필요한데 node 표준 API 에 없어 표준 테이블 기반으로 직접 구현한다.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

/** width x height 8비트 RGB(colorType=2) PNG 를 순수 zlib 으로 조립한다. colorFn(x,y) -> [r,g,b]. */
function encodePng(width, height, colorFn) {
  const rowBytes = width * 3
  const raw = Buffer.alloc((rowBytes + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1)
    raw[rowStart] = 0 // 필터 없음
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorFn(x, y)
      const off = rowStart + 1 + x * 3
      raw[off] = r & 0xff
      raw[off + 1] = g & 0xff
      raw[off + 2] = b & 0xff
    }
  }
  const compressed = zlib.deflateSync(raw)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 2  // color type: truecolor RGB
  ihdr[10] = 0 // compression method
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // interlace method
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 문자열 seed 로부터 결정적인 기준색을 뽑는다 — 같은 seed 는 항상 같은 바이트를 낸다. */
function seedColor(seedStr) {
  const h = crypto.createHash('sha256').update(String(seedStr)).digest()
  return [h[0], h[1], h[2]]
}

function makeColorFn(seedStr) {
  const [br, bg, bb] = seedColor(seedStr)
  return (x, y) => {
    const t = (x + y) % 64
    return [(br + t) & 0xff, (bg + t * 2) & 0xff, (bb + t * 3) & 0xff]
  }
}

const pngCache = new Map()
function pngFor(seedKey, width, height) {
  const cacheKey = `${seedKey}:${width}x${height}`
  let buf = pngCache.get(cacheKey)
  if (!buf) {
    buf = encodePng(width, height, makeColorFn(seedKey))
    pngCache.set(cacheKey, buf)
  }
  return buf
}

function servePngBuffer(res, buf, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'image/png',
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store',
  })
  res.end(buf)
}

const FAKE_PNG_BODY = Buffer.from(
  '<!doctype html><html><head><meta charset="utf-8"><title>로그인 필요</title></head>'
  + '<body><h1>로그인이 필요합니다</h1><p>이 이미지를 보려면 먼저 로그인하세요.</p></body></html>',
  'utf8',
)

const NEEDCOOKIE_DENY_BODY = Buffer.from(
  '<!doctype html><html><head><meta charset="utf-8"></head>'
  + '<body><h1>로그인이 필요합니다</h1><p>쿠키가 없어 이미지를 보여줄 수 없습니다.</p></body></html>',
  'utf8',
)

// 고정 기준선 이미지 — 모듈 로드 시 1회만 인코딩.
const IMG = {
  logo: pngFor('fixture:logo', 48, 48),
  ad: pngFor('fixture:ad', 300, 100),
  thumb1: pngFor('fixture:thumb1', 120, 120),
  thumb2: pngFor('fixture:thumb2', 120, 120),
  thumb3: pngFor('fixture:thumb3', 120, 120),
  needcookie: pngFor('fixture:needcookie', 200, 200),
}

// ───────────────────────── multipart/form-data 파서 ─────────────────────────
// FormData 를 완전히 스펙대로 파싱할 필요 없이, 경계 문자열로 잘라 헤더/본문만 가른다.
// Buffer.indexOf(Buffer) 는 바이트 단위로 동작해 이미지 바이너리를 훼손하지 않는다.

function parseMultipart(bodyBuf, boundary) {
  const boundaryBuf = Buffer.from(`--${boundary}`)
  const crlfcrlf = Buffer.from('\r\n\r\n')
  const parts = []
  let idx = bodyBuf.indexOf(boundaryBuf)
  while (idx !== -1) {
    const nextIdx = bodyBuf.indexOf(boundaryBuf, idx + boundaryBuf.length)
    if (nextIdx === -1) break
    let partStart = idx + boundaryBuf.length
    if (bodyBuf[partStart] === 0x0d && bodyBuf[partStart + 1] === 0x0a) partStart += 2
    let partEnd = nextIdx
    if (bodyBuf[partEnd - 2] === 0x0d && bodyBuf[partEnd - 1] === 0x0a) partEnd -= 2
    if (partEnd > partStart) parts.push(bodyBuf.subarray(partStart, partEnd))
    idx = nextIdx
  }
  const result = { fields: {}, files: {} }
  for (const part of parts) {
    const headerEnd = part.indexOf(crlfcrlf)
    if (headerEnd === -1) continue
    const headerStr = part.subarray(0, headerEnd).toString('utf8')
    const data = part.subarray(headerEnd + 4)
    const nameMatch = /name="([^"]*)"/.exec(headerStr)
    const filenameMatch = /filename="([^"]*)"/.exec(headerStr)
    const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerStr)
    const name = nameMatch ? nameMatch[1] : ''
    if (!name) continue
    if (filenameMatch) {
      result.files[name] = {
        filename: filenameMatch[1],
        contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
        data,
      }
    } else {
      result.fields[name] = data.toString('utf8')
    }
  }
  return result
}

// ───────────────────────── /gen 페이지 (정적 — 쿼리는 클라이언트 JS 가 읽는다) ─────────────────────────

const GEN_PAGE_HTML = page(`
  <h1>AI 이미지 생성 (픽스처)</h1>
  <p>아래 로고·광고·썸네일은 페이지가 열릴 때부터 있던 것입니다(생성물이 아닙니다).</p>
  <img src="/img/logo.png" width="48" height="48" alt="로고">
  <img src="/img/ad.png" width="300" height="100" alt="광고">
  <div>
    <img src="/img/thumb1.png" width="120" height="120" alt="썸네일1">
    <img src="/img/thumb2.png" width="120" height="120" alt="썸네일2">
    <img src="/img/thumb3.png" width="120" height="120" alt="썸네일3">
  </div>
  <hr>
  <textarea id="prompt" placeholder="프롬프트 입력..."></textarea>
  <br>
  <button id="genBtn">생성</button>
  <div id="result"></div>
  <script>
    var params = new URLSearchParams(location.search);
    var delayMs = parseInt(params.get('delay') || '1200', 10);
    var shouldFail = params.get('fail') === '1';
    var useBlob = params.get('blob') === '1';
    var makeTwo = params.get('two') === '1';
    var htmlTrap = params.get('html') === '1';
    var counter = 1;

    function addImg(container, src) {
      var img = document.createElement('img');
      img.width = 800;
      img.height = 600;
      img.alt = '생성된 이미지';
      if (useBlob) {
        fetch(src, { cache: 'no-store' }).then(function (r) { return r.blob(); }).then(function (b) {
          img.src = URL.createObjectURL(b);
          container.appendChild(img);
        });
      } else {
        img.src = src;
        container.appendChild(img);
      }
    }

    document.getElementById('genBtn').addEventListener('click', function () {
      var n = counter++;
      if (makeTwo) counter++;
      setTimeout(function () {
        var out = document.getElementById('result');
        if (shouldFail) {
          out.textContent = '생성 실패';
          return;
        }
        out.innerHTML = '';
        if (htmlTrap) {
          addImg(out, '/img/fake.png');
        } else if (makeTwo) {
          addImg(out, '/img/generated-' + n + '.png');
          addImg(out, '/img/generated-' + n + 'b.png');
        } else {
          addImg(out, '/img/generated-' + n + '.png');
        }
      }, delayMs);
    });
  </script>
`, '이미지 생성 픽스처')

// ───────────────────────── SNS 업로드 페이지 ─────────────────────────

function snsFormScript() {
  return `
    function snsFormHtml() {
      return '<input type="file" id="file" accept="image/png,image/jpeg,image/webp">'
        + '<br><textarea id="caption" placeholder="문구 입력..."></textarea>'
        + '<br><button id="shareBtn" disabled>공유하기</button>'
        + '<div id="shareResult"></div>';
    }
    function wireSnsForm(container) {
      var fileEl = container.querySelector('#file');
      var capEl = container.querySelector('#caption');
      var btnEl = container.querySelector('#shareBtn');
      function updateBtn() {
        btnEl.disabled = !(fileEl.files.length > 0 && capEl.value.trim().length > 0);
      }
      fileEl.addEventListener('change', updateBtn);
      capEl.addEventListener('input', updateBtn);
      btnEl.addEventListener('click', function () {
        var form = new FormData();
        form.append('file', fileEl.files[0]);
        form.append('caption', capEl.value);
        fetch('/sns/publish', { method: 'POST', body: form })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            container.querySelector('#shareResult').innerHTML =
              '<p>게시물이 공유되었습니다</p><p>게시물 주소: <a href="/sns/post/' + data.id + '">/sns/post/' + data.id + '</a></p>';
          });
      });
    }
  `
}

function snsPageHtml(iframeMode, altBase) {
  return page(`
    <h1>SNS 게시물 올리기 (픽스처)</h1>
    <button id="openBtn">새 게시물</button>
    <div id="dialogHost"></div>
    <script>
      var IFRAME_MODE = ${iframeMode ? 'true' : 'false'};
      var ALT_BASE = ${JSON.stringify(altBase)};
      ${snsFormScript()}
      document.getElementById('openBtn').addEventListener('click', function () {
        var host = document.getElementById('dialogHost');
        if (IFRAME_MODE) {
          host.innerHTML = '<div role="dialog" aria-label="새 게시물"><h2>새 게시물</h2>'
            + '<iframe src="' + ALT_BASE + '/sns/embed" width="480" height="360" style="border:1px solid #ccc"></iframe></div>';
        } else {
          host.innerHTML = '<div role="dialog" aria-label="새 게시물"><h2>새 게시물</h2>' + snsFormHtml() + '</div>';
          wireSnsForm(host);
        }
      });
    </script>
  `, 'SNS 업로드 픽스처')
}

function snsEmbedPageHtml() {
  return page(`
    <h2>새 게시물</h2>
    <div id="dialogHost">
      <input type="file" id="file" accept="image/png,image/jpeg,image/webp">
      <br><textarea id="caption" placeholder="문구 입력..."></textarea>
      <br><button id="shareBtn" disabled>공유하기</button>
      <div id="shareResult"></div>
    </div>
    <script>
      ${snsFormScript()}
      wireSnsForm(document.getElementById('dialogHost'));
    </script>
  `, 'SNS 업로드 픽스처 (embed)')
}

// ───────────────────────── 블로그 페이지 ─────────────────────────

function blogSearchHtml(q) {
  const qs = escapeHtml(q || '검색어')
  const items = [
    { title: `${qs}에 대한 내 생각`, summary: '예전에 제가 직접 쓴 글입니다.', href: '/blog/mine/1' },
    { title: '오늘의 날씨와 생활 정보', summary: '오늘 날씨는 맑고 기온은 섭씨 20도입니다. 우산은 필요 없습니다.', href: '/blog/post/6' },
    { title: `${qs} 완전 정리`, summary: `${qs}에 대해 알아야 할 모든 것을 정리했습니다.`, href: '/blog/post/2' },
    { title: `${qs} 후기 및 경험담`, summary: `제가 직접 ${qs}을(를) 경험하고 남긴 후기입니다.`, href: '/blog/post/3' },
    { title: `초보자를 위한 ${qs} 가이드`, summary: `${qs}가 처음이신 분들을 위한 안내입니다.`, href: '/blog/post/4' },
    { title: `${qs} 관련 최신 소식`, summary: `${qs}에 대한 최신 업데이트 소식을 전합니다.`, href: '/blog/post/5' },
  ]
  const listHtml = items.map((it) => `<li><a href="${it.href}">${it.title}</a><p>${it.summary}</p></li>`).join('')
  return page(`<h1>"${qs}" 검색 결과</h1><ul>${listHtml}</ul>`, '블로그 검색 픽스처')
}

function blogPostBody(kind, id) {
  const topic = kind === 'mine' ? '제 블로그 이야기' : `주제 ${escapeHtml(id)}에 대한 심층 분석`
  const marker = kind === 'mine' ? `이 글의 고유 표지: MINE-${id}-MARKER` : `이 글의 고유 표지: POST-${id}-MARKER`
  const paragraphs = []
  for (let i = 1; i <= 8; i++) {
    paragraphs.push(
      `<p>이 문단은 테스트를 위한 더미 본문 ${i}번째 문단입니다. 실제 글쓰기 서비스처럼 `
      + `충분한 분량의 본문을 갖추기 위해 작성되었습니다. ${topic}에 관한 이야기가 이어집니다.</p>`,
    )
  }
  return `<h1>${topic}</h1>${paragraphs.join('')}<p>${marker}</p>`
}

function likeFormHtml(state, key, returnTo) {
  const liked = !!state.likesMap[key]
  return `<form method="post" action="/blog/like">`
    + `<input type="hidden" name="postId" value="${escapeHtml(key)}">`
    + `<input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">`
    + `<button type="submit">${liked ? '♥ 좋아요 취소' : '♥ 좋아요'}</button></form>`
}

function commentFormHtml(state, key, returnTo) {
  const list = state.comments.filter((c) => c.postId === key)
  const listHtml = list.map((c) => `<li>${escapeHtml(c.text)}</li>`).join('')
  return `<h3>댓글</h3><ul>${listHtml || '<li>(아직 댓글이 없습니다)</li>'}</ul>`
    + `<form method="post" action="/blog/comment">`
    + `<input type="hidden" name="postId" value="${escapeHtml(key)}">`
    + `<input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">`
    + `<input type="text" name="text" placeholder="댓글을 입력하세요">`
    + `<button type="submit">댓글 등록</button></form>`
}

// ───────────────────────── 서버 조립 ─────────────────────────

/**
 * @returns {Promise<{base:string, altBase:string, state:object, close:() => Promise<void>}>}
 */
export async function startSocialFixtures() {
  const [port1, port2] = await getFreePorts(2)
  const base = `http://127.0.0.1:${port1}`
  const altBase = `http://127.0.0.1:${port2}`

  const state = {
    publishes: [], // { id, bytes, sha256, caption, at }
    comments: [],  // { postId, text, at }
    likesMap: { 'post:3': true }, // post/3 은 이미 좋아요가 눌린 상태로 시작
  }

  async function handleSnsPublish(req, res) {
    const ct = req.headers['content-type'] || ''
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct)
    if (!boundaryMatch) {
      return sendJson(res, 400, { error: 'multipart boundary 없음' })
    }
    const boundary = boundaryMatch[1] || boundaryMatch[2]
    const bodyBuf = await readBodyBuffer(req)
    const parsed = parseMultipart(bodyBuf, boundary)
    const file = parsed.files['file']
    const caption = (parsed.fields['caption'] || '').trim()
    if (!file || !caption) {
      return sendJson(res, 400, { error: '파일 또는 문구 누락' })
    }
    const sha256 = crypto.createHash('sha256').update(file.data).digest('hex')
    const id = String(state.publishes.length + 1)
    state.publishes.push({ id, bytes: file.data.length, sha256, caption, at: Date.now() })
    return sendJson(res, 200, { id })
  }

  async function routeMain(req, res, pathname, urlObj) {
    if (req.method === 'GET' && pathname === '/') {
      return sendHtml(res, 200, page(
        '<h1>소셜 픽스처</h1><ul>'
        + '<li><a href="/gen">이미지 생성</a></li>'
        + '<li><a href="/sns">SNS 업로드</a></li>'
        + '<li><a href="/blog/search?q=테스트">블로그 검색</a></li>'
        + '<li><a href="/state">상태 확인</a></li></ul>',
      ))
    }

    if (req.method === 'GET' && pathname === '/gen') {
      return sendHtml(res, 200, GEN_PAGE_HTML)
    }

    if (req.method === 'GET' && pathname === '/setcookie') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Set-Cookie': 'sess=ok; Path=/' })
      res.end('ok')
      return
    }

    if (pathname === '/img/logo.png') return servePngBuffer(res, IMG.logo)
    if (pathname === '/img/ad.png') return servePngBuffer(res, IMG.ad)
    if (pathname === '/img/thumb1.png') return servePngBuffer(res, IMG.thumb1)
    if (pathname === '/img/thumb2.png') return servePngBuffer(res, IMG.thumb2)
    if (pathname === '/img/thumb3.png') return servePngBuffer(res, IMG.thumb3)
    if (pathname === '/img/fake.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(FAKE_PNG_BODY.length) })
      res.end(FAKE_PNG_BODY)
      return
    }
    if (pathname === '/img/empty.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '0' })
      res.end()
      return
    }
    if (pathname === '/img/needcookie.png') {
      if (!hasCookiePair(req, 'sess=ok')) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(NEEDCOOKIE_DENY_BODY.length) })
        res.end(NEEDCOOKIE_DENY_BODY)
        return
      }
      return servePngBuffer(res, IMG.needcookie)
    }
    const genMatch = /^\/img\/generated-(.+)\.png$/.exec(pathname)
    if (genMatch) {
      const seed = decodeURIComponent(genMatch[1])
      return servePngBuffer(res, pngFor(`generated:${seed}`, 800, 600))
    }
    if (pathname.startsWith('/img/')) {
      return sendHtml(res, 404, page('<p>이미지를 찾을 수 없습니다.</p>'))
    }

    if (req.method === 'GET' && pathname === '/sns') {
      const iframeMode = urlObj.searchParams.get('iframe') === '1'
      return sendHtml(res, 200, snsPageHtml(iframeMode, altBase))
    }
    if (req.method === 'POST' && pathname === '/sns/publish') {
      return handleSnsPublish(req, res)
    }
    const snsPostMatch = /^\/sns\/post\/(\w+)$/.exec(pathname)
    if (req.method === 'GET' && snsPostMatch) {
      const rec = state.publishes.find((p) => p.id === snsPostMatch[1])
      if (!rec) return sendHtml(res, 404, page('<p>게시물을 찾을 수 없습니다.</p>'))
      return sendHtml(res, 200, page(
        `<h1>게시물 #${escapeHtml(rec.id)}</h1>`
        + `<p>문구: ${escapeHtml(rec.caption)}</p>`
        + `<p>바이트: ${rec.bytes}</p>`
        + `<p>sha256: ${rec.sha256}</p>`,
      ))
    }

    if (req.method === 'GET' && pathname === '/state') {
      return sendJson(res, 200, {
        publishes: state.publishes,
        comments: state.comments,
        likes: Object.entries(state.likesMap).map(([key, liked]) => ({ key, liked })),
      })
    }

    if (req.method === 'GET' && pathname === '/blog/search') {
      return sendHtml(res, 200, blogSearchHtml(urlObj.searchParams.get('q') || ''))
    }

    const postMatch = /^\/blog\/post\/(\w+)$/.exec(pathname)
    if (req.method === 'GET' && postMatch) {
      const id = postMatch[1]
      if (id === '9') {
        return sendHtml(res, 500, page('<h1>글을 불러오지 못했습니다</h1><p>일시적인 오류로 본문을 표시할 수 없습니다.</p>'))
      }
      const key = `post:${id}`
      const returnTo = `/blog/post/${id}`
      return sendHtml(res, 200, page(
        blogPostBody('post', id) + likeFormHtml(state, key, returnTo) + commentFormHtml(state, key, returnTo),
      ))
    }
    const mineMatch = /^\/blog\/mine\/(\w+)$/.exec(pathname)
    if (req.method === 'GET' && mineMatch) {
      const id = mineMatch[1]
      const key = `mine:${id}`
      const returnTo = `/blog/mine/${id}`
      return sendHtml(res, 200, page(
        blogPostBody('mine', id) + likeFormHtml(state, key, returnTo) + commentFormHtml(state, key, returnTo),
      ))
    }
    if (req.method === 'POST' && pathname === '/blog/like') {
      const body = parseForm(await readBodyText(req))
      const key = body.postId || ''
      if (key) state.likesMap[key] = !state.likesMap[key]
      return redirect(res, body.returnTo || '/')
    }
    if (req.method === 'POST' && pathname === '/blog/comment') {
      const body = parseForm(await readBodyText(req))
      const key = body.postId || ''
      const text = (body.text || '').trim()
      if (key && text) state.comments.push({ postId: key, text, at: Date.now() })
      return redirect(res, body.returnTo || '/')
    }

    return sendHtml(res, 404, page('<p>not found</p>'))
  }

  async function routeAlt(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/sns/embed') {
      return sendHtml(res, 200, snsEmbedPageHtml())
    }
    if (req.method === 'POST' && pathname === '/sns/publish') {
      return handleSnsPublish(req, res)
    }
    return sendHtml(res, 404, page('<p>not found</p>'))
  }

  const mainServer = http.createServer((req, res) => {
    let urlObj
    try {
      urlObj = new URL(req.url, base)
    } catch {
      res.writeHead(400)
      res.end('bad request')
      return
    }
    Promise.resolve(routeMain(req, res, urlObj.pathname, urlObj)).catch((err) => {
      try { sendHtml(res, 500, page(`<p>fixture error: ${escapeHtml(err?.message)}</p>`)) } catch { /* ignore */ }
    })
  })

  const altServer = http.createServer((req, res) => {
    let urlObj
    try {
      urlObj = new URL(req.url, altBase)
    } catch {
      res.writeHead(400)
      res.end('bad request')
      return
    }
    Promise.resolve(routeAlt(req, res, urlObj.pathname)).catch((err) => {
      try { sendHtml(res, 500, page(`<p>fixture error: ${escapeHtml(err?.message)}</p>`)) } catch { /* ignore */ }
    })
  })

  await Promise.all([
    new Promise((resolve, reject) => { mainServer.once('error', reject); mainServer.listen(port1, '127.0.0.1', resolve) }),
    new Promise((resolve, reject) => { altServer.once('error', reject); altServer.listen(port2, '127.0.0.1', resolve) }),
  ])

  return {
    base,
    altBase,
    state,
    async close() {
      await Promise.all([closeServer(mainServer), closeServer(altServer)])
    },
  }
}

// 직접 실행하면 수동 확인용으로 URL 을 찍고 Ctrl+C 까지 살아 있는다.
// (process.argv[1] 이 없는 실행 환경 — 예: `node --input-type=module` 로 stdin 모듈 실행 — 에서는
// pathToFileURL(undefined) 가 예외를 던지므로 먼저 존재를 확인한다.)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startSocialFixtures()
  console.log('[social-fixture] base    :', fixture.base)
  console.log('[social-fixture] altBase :', fixture.altBase)
  console.log('Ctrl+C 로 종료하세요.')
  process.on('SIGINT', async () => { await fixture.close(); process.exit(0) })
}
