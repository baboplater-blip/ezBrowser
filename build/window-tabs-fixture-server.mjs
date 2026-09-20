#!/usr/bin/env node
// window-tabs-fixture-server.mjs — 다중 창·다중 탭 내구 작업(run-20260920T042617Z-732aef, W1~W10)
// 검증 전용 로컬 fixture 서버. 의존성 0.
//
// 왜 loadId 인가: 이 라운드의 핵심 위험은 "같은 URL 을 여는 탭이 여러 개(다른 창·같은 창) 있을 때
// 내구 작업이 **정확히 그 탭**에서만 동작이 느는가" 다. 페이지 안의 변수(`window.__st`)로만 세면
// 어느 탭이 눌렀는지 구분이 안 되고, 게다가 강제종료·재시작을 겪으면 그 변수 자체가 사라진다.
// 그래서 **서버가 매 `/page` 요청마다 새 loadId 를 발급**해 응답에 박아 두고, 그 탭이 버튼을 누르면
// `/hit?load=<loadId>` 로 알린다. 재시작 뒤 탭이 다시 로드되면 새 loadId 가 붙으므로, 하네스는
// 복원 직후 각 탭에서 `window.__loadId` 를 다시 읽어 "탭 ↔ loadId" 지도를 새로 만들면 된다.
//
// 제공하는 것:
//   GET /page              새 loadId 발급 + "제출" 버튼 1개. 클릭 시 그 loadId 로 /hit 호출.
//   GET /hit?load=X        hits[X]++ (204)
//   GET /state             { loads:[...], hits:{L1:0,...} } 전체 상태
//   GET /redirect          같은 호스트의 /page 로 302 (W8: 사이트 내 리다이렉트 흡수 검증용)
//   GET /reset             loads·hits 초기화 (loadId 카운터는 유지 — 재부팅 뒤에도 유일해야 하므로)
//
// close() 는 반드시 closeAllConnections + 상한과 함께 — 앱의 keep-alive 연결로 close() 가
// 영영 안 끝나는 정지를 이 저장소에서 여러 번 겪었다(2026-09-06 이후 모든 fixture 서버의 관례).

import http from 'node:http'

const NL = String.fromCharCode(10)

// W9(agent-confirm 대조군)용 — 라벨 "결제하기" 는 agent-gate 의 SENSITIVE 정규식에 걸려
// 클릭 전 확인(waitCause='confirm')을 요구한다. 완료 문구는 일부러 안 띄운다(발행/결제 완료로
// 오인돼 다른 게이트가 끼어드는 것을 피하려는 것 — task-runtime-server.mjs 의 /pay 와 같은 이유).
function confirmPageHtml(loadId) {
  return [
    '<!doctype html><meta charset="utf-8">',
    `<title>WT-CONFIRM ${loadId}</title>`,
    '<body style="font:16px system-ui;padding:24px">',
    `<h1>결제 시험 (${loadId})</h1>`,
    '<button id="pay">결제하기</button>',
    '<p id="state">준비</p>',
    '<script>',
    `window.__loadId = ${JSON.stringify(loadId)};`,
    'window.__st = { count: 0 };',
    'document.getElementById("pay").addEventListener("click", function () {',
    '  window.__st.count++;',
    '  document.getElementById("state").textContent = "\\uACB0\\uC81C\\uB428";',
    '  try { fetch("/hit?load=" + encodeURIComponent(window.__loadId), { cache: "no-store" }); } catch (e) {}',
    '});',
    '</script></body>',
  ].join(NL)
}

function pageHtml(loadId) {
  return [
    '<!doctype html><meta charset="utf-8">',
    `<title>WT ${loadId}</title>`,
    '<body style="font:16px system-ui;padding:24px">',
    `<h1>window-tabs 시험 (${loadId})</h1>`,
    '<p>이 페이지에서 눌린 제출은 서버가 loadId 로 구분해 집계합니다.</p>',
    '<button id="submit">제출</button>',
    '<p id="state">대기 0</p>',
    '<script>',
    `window.__loadId = ${JSON.stringify(loadId)};`,
    'window.__st = { count: 0 };',
    'document.getElementById("submit").addEventListener("click", function () {',
    '  window.__st.count++;',
    // 계속 눌러도 안전하도록: 에이전트의 "막힘 감지"는 페이지 지문(요소 종류·**이름**·상태, 본문
    // 텍스트는 제외)이 3번 연속 같으면 멈춘다(agent.ts pageFingerprint). 그래서 별도 문단 문구만
    // 바꾸는 걸로는 안 통한다(문단은 지문에 안 들어간다, 2026-09-20 실측) — **버튼 자기 자신의
    // 이름(접근성 이름=라벨 텍스트)** 을 바꿔야 지문이 매번 달라진다. 라벨에 "제출" 부분 문자열은
    // 유지해서(fake-llm 의 refFromObservation 이 부분일치로 찾는다) 클릭 대상은 그대로 찾힌다.
    '  this.textContent = "\\uC81C\\uCD9C " + window.__st.count;',
    '  document.getElementById("state").textContent = "\\uB20C\\uB9BC " + window.__st.count;',
    '  try { fetch("/hit?load=" + encodeURIComponent(window.__loadId), { cache: "no-store" }); } catch (e) {}',
    '});',
    '</script></body>',
  ].join(NL)
}

export function startWindowTabsFixtureServer(port) {
  const state = { loadCounter: 0, loads: [], hits: {} }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const p = url.pathname
    const json = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(obj))
    }
    const html = (text) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    }

    if (p === '/page') {
      state.loadCounter += 1
      const loadId = `L${state.loadCounter}`
      state.loads.push(loadId)
      state.hits[loadId] = 0
      html(pageHtml(loadId))
      return
    }
    if (p === '/confirm') {
      state.loadCounter += 1
      const loadId = `L${state.loadCounter}`
      state.loads.push(loadId)
      state.hits[loadId] = 0
      html(confirmPageHtml(loadId))
      return
    }
    if (p === '/hit') {
      const load = url.searchParams.get('load') ?? ''
      if (Object.prototype.hasOwnProperty.call(state.hits, load)) state.hits[load] += 1
      res.writeHead(204)
      res.end()
      return
    }
    if (p === '/state') { json({ loads: state.loads, hits: state.hits }); return }
    if (p === '/reset') {
      state.loads = []
      state.hits = {}
      json({ ok: true })
      return
    }
    if (p === '/redirect') {
      // 같은 서버(=같은 호스트) 안에서의 리다이렉트 — W8(사이트 내 리다이렉트 흡수) 용.
      // 절대경로가 아니라 상대경로를 쓴다 — 어떤 호스트명으로 접근했든 그 호스트로 그대로 되돌아간다.
      res.writeHead(302, { Location: '/page' })
      res.end()
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      const base = `http://127.0.0.1:${actual}`
      resolve({
        port: actual,
        base,
        pageUrl: `${base}/page`,
        redirectUrl: `${base}/redirect`,
        async state() {
          const r = await fetch(`${base}/state`, { cache: 'no-store' })
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
