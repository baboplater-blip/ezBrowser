#!/usr/bin/env node
// task-runtime-server.mjs — 영속 작업 런타임 검증용 로컬 fixture 서버 (의존성 0)
//
// 왜 서버가 필요한가: 영속 작업 런타임의 계약 대부분이 **"그 뒤로 아무 일도 더 일어나지 않았다"** 다
// (일시정지·중단·강제종료 뒤 부작용 0, 발행 중복 0). 이걸 페이지 안의 `window.__st` 로만 세면
// **페이지가 다시 로드되는 순간 증거가 지워진다** — 강제종료 후 재시작(T7·T8)은 정확히 그 경우다.
// 그래서 클릭·발행·결제를 **서버 카운터**로 센다. 프로세스를 죽였다 살려도 카운터는 남는다.
//
// 제공하는 것:
//   GET /                 조작용 버튼 20개(동작A~동작T) + 발행/결제 없음. ?p=N 으로 제목이 바뀐다
//                         (구간 경계마다 다른 제목이 필요한 T2 의 doneSubtasks 누적 검증용)
//   GET /publish          "발행" 버튼 — 누르면 서버 카운터 +1, 화면은 "처리 중…" 으로만 바뀐다
//                         (완료 문구를 **일부러 띄우지 않아** "발행됐는지 모르는" 상황을 만든다 — T13)
//   GET /pay              "결제하기" 버튼 — 누르면 서버 카운터 +1 (민감 동작 무자동부활 T8)
//   GET /slow             1.5초 뒤에 응답하는 페이지(구간이 실제 시간을 쓰게 만든다 — T15 가상시계)
//   GET /off-scope        허용 사이트 밖 판정용 페이지. 하네스는 **localhost** 호스트로 접근해
//                         (서버는 127.0.0.1 하나) 호스트만 다른 요청을 만든다 — T14
//   GET /counts           { hits, publish, pay, clicks } 카운터 조회
//   GET /reset            카운터 0으로
//   POST /llm-<코드>/api/chat   그 HTTP 상태를 항상 돌려주는 Ollama 호환 엔드포인트.
//                         원인별 재시도(T11)용 — 429/401/418/500 을 주입한다. 앱 설정의
//                         `ai.ollamaUrl` 을 `<base>/llm-429` 로 바꾸면 그 작업만 그 오류를 만난다.
//
// ⚠ close() 는 반드시 closeAllConnections + 상한과 함께 — 앱의 keep-alive 연결 때문에
//   server.close() 가 영영 끝나지 않는 정지를 이 저장소에서 실제로 겪었다(2026-09-06).

import http from 'node:http'

const NL = String.fromCharCode(10)

// 버튼 라벨 — **접두 충돌이 없어야 한다.** fake-llm 의 refFromObservation 은 부분 일치로
// 라벨→ref 를 찾으므로 "버튼1" 은 "버튼10" 에도 걸린다. 글자 하나씩 쓰면 그 함정이 없다.
const LETTERS = 'ABCDEFGHIJKLMNOPQRST'.split('')

function mainPage(p) {
  const buttons = LETTERS
    .map((L) => `<button class="act" data-l="${L}">동작${L}</button>`)
    .join(' ')
  return [
    '<!doctype html><meta charset="utf-8">',
    `<title>작업 런타임 시험 p=${p}</title>`,
    '<body style="font:16px system-ui;padding:24px">',
    `<h1>작업 런타임 시험 p=${p}</h1>`,
    '<p>이 페이지의 클릭은 서버 카운터로 집계됩니다.</p>',
    `<div>${buttons}</div>`,
    '<p id="state">대기</p>',
    '<script>',
    'window.__st = { count: 0, log: [] };',
    'for (const b of document.querySelectorAll(".act")) {',
    '  b.addEventListener("click", function () {',
    '    var L = this.getAttribute("data-l");',
    '    window.__st.count++; window.__st.log.push(L);',
    '    document.getElementById("state").textContent = "\\uB20C\\uB9BC:" + L;',
    '    try { fetch("/hit?b=" + L, { cache: "no-store" }); } catch (e) {}',
    '  });',
    '}',
    '</script></body>',
  ].join(NL)
}

// 발행 페이지 — 완료 문구를 띄우지 않는 것이 핵심이다.
// agent-gate 의 PUBLISHED_TEXT_RE(발행 완료·게시되었…)에 걸리는 문구를 쓰면 "완료 신호를 봤다" 가
// 되어 원장이 확정되고, T13 이 시험하려는 "완료가 불확실한 상태" 자체가 사라진다.
function publishPage() {
  return [
    '<!doctype html><meta charset="utf-8">',
    '<title>발행 시험</title>',
    '<body style="font:16px system-ui;padding:24px">',
    '<h1>발행 시험</h1>',
    '<textarea id="body" rows="3" cols="40">본문</textarea>',
    '<div><button id="pub">발행</button></div>',
    '<p id="state">준비</p>',
    '<script>',
    'window.__st = { count: 0, log: [] };',
    'document.getElementById("pub").addEventListener("click", function () {',
    '  window.__st.count++; window.__st.log.push("pub");',
    // "처리 중" 만 표시한다 — 완료 신호가 아니다(의도).
    '  document.getElementById("state").textContent = "\\uCC98\\uB9AC \\uC911\\u2026";',
    '  try { fetch("/publish-hit", { cache: "no-store" }); } catch (e) {}',
    '});',
    '</script></body>',
  ].join(NL)
}

function payPage() {
  return [
    '<!doctype html><meta charset="utf-8">',
    '<title>결제 시험</title>',
    '<body style="font:16px system-ui;padding:24px">',
    '<h1>결제 시험</h1>',
    '<div><button id="pay">결제하기</button></div>',
    '<p id="state">준비</p>',
    '<script>',
    'window.__st = { count: 0, log: [] };',
    'document.getElementById("pay").addEventListener("click", function () {',
    '  window.__st.count++; window.__st.log.push("pay");',
    '  document.getElementById("state").textContent = "\\uACB0\\uC81C\\uB428";',
    '  try { fetch("/pay-hit", { cache: "no-store" }); } catch (e) {}',
    '});',
    '</script></body>',
  ].join(NL)
}

function plainPage(title, body) {
  return [
    '<!doctype html><meta charset="utf-8">',
    `<title>${title}</title>`,
    '<body style="font:16px system-ui;padding:24px">',
    `<h1>${title}</h1><p>${body}</p>`,
    '<button id="x">아무 버튼</button>',
    '</body>',
  ].join(NL)
}

/** Ollama 호환 정상 응답이 아니라 **오류 상태**만 돌려주는 엔드포인트(원인별 재시도 주입용). */
function llmErrorBody(code) {
  return JSON.stringify({ error: `주입된 오류 (${code})` })
}

export function startTaskRuntimeServer(port) {
  const counts = { hits: 0, publish: 0, pay: 0, llmError: 0 }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const p = url.pathname
    const html = (text) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    }
    const json = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(obj))
    }

    // 주입 LLM 엔드포인트: /llm-429/api/chat 처럼 앞에 상태 코드가 붙는다.
    const llm = /^\/llm-(\d{3})\/api\/chat$/.exec(p)
    if (llm) {
      // 본문을 다 받아야 클라이언트가 끊기지 않는다(net.request 는 write 후 응답을 기다린다).
      req.on('data', () => {})
      req.on('end', () => {
        counts.llmError++
        const code = Number(llm[1])
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(llmErrorBody(code))
      })
      return
    }

    if (p === '/hit') { counts.hits++; res.writeHead(204); res.end(); return }
    if (p === '/publish-hit') { counts.publish++; res.writeHead(204); res.end(); return }
    if (p === '/pay-hit') { counts.pay++; res.writeHead(204); res.end(); return }
    if (p === '/counts') { json(counts); return }
    if (p === '/reset') {
      counts.hits = 0; counts.publish = 0; counts.pay = 0; counts.llmError = 0
      json(counts); return
    }

    if (p === '/publish') { html(publishPage()); return }
    if (p === '/pay') { html(payPage()); return }
    if (p === '/off-scope') { html(plainPage('허용 밖 페이지', '이 페이지로 이동하면 안 됩니다.')); return }
    if (p === '/slow') {
      // 응답을 늦춘다 — 구간이 실제 시간을 쓰게 만들어 시간 예산 경계를 넘긴다.
      setTimeout(() => html(plainPage('느린 페이지', '1.5초 뒤에 도착했습니다.')), 1500)
      return
    }
    // '/' 및 그 밖의 모든 경로 → 메인 페이지(질의문자열 p 로 제목이 바뀐다)
    html(mainPage(url.searchParams.get('p') ?? '0'))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      // 실제로 열린 포트를 쓴다 — port 0(임의 할당)을 넘겼을 때 인자 값을 그대로 쓰면 주소가 깨진다.
      const actual = server.address().port
      const base = `http://127.0.0.1:${actual}`
      resolve({
        port: actual,
        base,
        url: `${base}/`,
        /** 호스트만 다른 같은 서버 주소 — 허용 사이트 밖 판정(T14)용. */
        offScopeUrl: `http://localhost:${actual}/off-scope`,
        llmUrl: (code) => `${base}/llm-${code}`,
        async counts() {
          const r = await fetch(`${base}/counts`, { cache: 'no-store' })
          return r.json()
        },
        async reset() {
          await fetch(`${base}/reset`, { cache: 'no-store' })
        },
        async close() {
          await new Promise((r) => {
            try { server.closeAllConnections?.() } catch { /* ignore */ }
            const t = setTimeout(r, 3000)
            server.close(() => { clearTimeout(t); r() })
          })
        },
      })
    })
  })
}
