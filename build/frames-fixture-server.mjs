#!/usr/bin/env node
// frames-fixture-server.mjs — 교차 출처(cross-origin) iframe 제어 검증 전용 로컬 fixture.
//
// 무엇을 검증하기 위한 것인가: 에이전트의 페이지 조작(page-actions.ts)이 최상위 문서뿐 아니라
// **다른 오리진의 iframe** 안 요소도 정확히 관찰·클릭·입력할 수 있는지, 그리고 허용 목록 밖의
// 프레임(제3 오리진)의 텍스트가 실수로 모델 프롬프트에 새지 않는지를 검증하기 위한 3-오리진
// 고정 장치(fixture)다. 127.0.0.1 에 포트만 다른 서버 3개를 띄운다 — 포트가 다르면 브라우저는
// 이를 서로 다른 오리진으로 취급하므로 실제 서비스형 CDN 없이도 교차 출처 iframe 을 재현할 수 있다.
//
// 검증 대상 시나리오(참고, 이 파일 자체는 fixture 만 제공하고 검증 로직은 담지 않는다):
//   - 부모 문서의 표식(PARENT_BODY_MARK)과 자식 프레임의 표식(CHILD_FORM_MARK)이 섞이지 않는가
//   - iframe 의 border/padding/margin 오프셋을 감안해 좌표 클릭이 정확한가 (f1)
//   - 허용 목록 밖 오리진(third, /secret)의 SECRET_C_TEXT_MUST_NOT_LEAK 문자열이 절대 새지 않는가
//   - 자동화가 DOM 속성을 건드리면(MutationObserver) 실제로 감지되는가 — 지문 회귀 검사용
//   - 프레임을 재로드했을 때 오래된(stale) 요소 참조를 거부하는가 (/reload-marker)
//
// 외부 네트워크 요청 없음. node:http 만 사용(의존성 0).

import http from 'node:http'
import { getFreePorts } from './lib/ports.mjs'

function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`
}

function send(res, status, body, contentType = 'text/html; charset=utf-8') {
  res.statusCode = status
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

/** 요청 경로를 기록하는 간단한 http 서버. 라우트 맵은 함수(req,url)->string|null. */
function createTrackedServer(routeFn) {
  const seenPaths = []
  const server = http.createServer((req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      send(res, 400, 'bad request')
      return
    }
    seenPaths.push(url.pathname)
    const result = routeFn(url.pathname)
    if (result == null) {
      send(res, 404, 'not found')
      return
    }
    send(res, 200, result)
  })
  return { server, seenPaths }
}

export async function startFramesFixture() {
  const [parentPort, childPort, thirdPort] = await getFreePorts(3)
  const parentOrigin = `http://127.0.0.1:${parentPort}`
  const childOrigin = `http://127.0.0.1:${childPort}`
  // ⚠ 호스트 이름을 일부러 다르게 둔다(localhost vs 127.0.0.1). 허용 목록은 **호스트 기준**이라
  // 셋 다 127.0.0.1 이면 "허용 밖 프레임" 을 만들 수 없어 F6/F7 검증이 성립하지 않는다.
  const thirdOrigin = `http://localhost:${thirdPort}`

  // ── 부모 오리진 ──
  const { server: parentServer, seenPaths: parentSeen } = createTrackedServer((path) => {
    if (path !== '/') return null
    return html(`
      <h1>부모 문서</h1>
      <p>PARENT_BODY_MARK</p>
      <button id="topbtn" onclick="document.title='TOP_CLICKED'">최상위 버튼</button>
      <iframe id="f1" src="${childOrigin}/form" width="480" height="320"
        style="border:8px solid #333;padding:4px;display:block;margin:40px 0 0 60px"></iframe>
      <iframe id="f2" src="${childOrigin}/editor" width="400" height="200"></iframe>
      <iframe id="f3" src="${thirdOrigin}/secret" width="300" height="150"></iframe>
      <div id="report"></div>
      <script>
        // 자식 프레임(교차 출처)이 postMessage 로 보내는 상태를 모아 둔다 — 검증 하네스가 여기서 읽는다.
        window.__frameState = {};
        window.addEventListener('message', function (e) {
          if (e.data && e.data.__frameState) window.__frameState[e.data.which] = e.data;
        });
        window.__resetFrameState = function () {
          window.__frameState = {};
          for (var i = 0; i < frames.length; i++) { try { frames[i].postMessage('__resetFrameState', '*'); } catch (err) {} }
        };
        window.__askFrameState = function () {
          for (var i = 0; i < frames.length; i++) { try { frames[i].postMessage('__askFrameState', '*'); } catch (err) {} }
        };
      </script>
    `)
  })

  // ── 자식 오리진(child) ──
  const { server: childServer, seenPaths: childSeen } = createTrackedServer((path) => {
    if (path === '/form') {
      return html(`
        <h2>교차출처 폼</h2>
        <p>CHILD_FORM_MARK</p>
        <label for="cname">이름</label><input id="cname" type="text">
        <select id="csel">
          <option value="a">알파</option>
          <option value="b">베타</option>
          <option value="c">감마</option>
        </select>
        <button id="cbtn">프레임 제출</button>
        <button id="cnav">프레임 이동</button>
        <button id="cpay">결제하기</button>
        <div id="cout"></div>
        <label for="ckey">키입력</label><input id="ckey" type="text">
        <div style="height:3000px"></div>
        <div id="cbottom">FRAME_BOTTOM</div>
        <script>
          document.getElementById('cbtn').addEventListener('click', function () {
            var name = document.getElementById('cname').value;
            var sel = document.getElementById('csel').value;
            document.getElementById('cout').textContent = 'FRAME_SUBMITTED:' + name + ':' + sel;
            window.__frameClicked = true;
          });
          document.getElementById('cnav').addEventListener('click', function () {
            location.href = '/reload-marker';
          });
          // 확인 게이트가 걸리는 라벨 — "관찰 → (프레임이 그 사이 바뀜) → 실행" 창을 결정적으로 만드는 데 쓴다.
          document.getElementById('cpay').addEventListener('click', function () {
            window.__framePaid = true;
            document.getElementById('cout').textContent = 'FRAME_PAID';
          });
          document.getElementById('ckey').addEventListener('keydown', function (e) {
            window.__lastKey = e.key;
          });
          window.__attrMutations = 0;
          new MutationObserver(function (records) {
            for (var i = 0; i < records.length; i++) {
              if (records[i].type === 'attributes') window.__attrMutations++;
            }
          }).observe(document.documentElement, { attributes: true, subtree: true });
          // 상태 보고 다리 — 교차 출처라 부모 JS 도 CDP /json/list 도 이 프레임 안을 볼 수 없다(OOPIF).
          // postMessage 는 교차 출처에서도 허용되므로, 검증 하네스가 부모에서 프레임 상태를 읽을 수 있게 한다.
          function report() {
            try {
              parent.postMessage({ __frameState: true, which: 'form',
                out: document.getElementById('cout').textContent,
                lastKey: window.__lastKey || '',
                paid: window.__framePaid === true,
                clicked: window.__frameClicked === true,
                scrollY: Math.round(window.scrollY),
                attrMutations: window.__attrMutations,
                href: location.href }, '*');
            } catch (e) {}
          }
          window.addEventListener('message', function (e) {
            if (e.data === '__askFrameState') report();
            if (e.data === '__resetFrameState') {
              window.__lastKey = ''; window.__frameClicked = false; window.__framePaid = false;
              window.__attrMutations = 0; document.getElementById('cout').textContent = '';
              try { window.scrollTo(0, 0); } catch (err) {}
              report();
            }
          });
          window.addEventListener('scroll', report);
          document.addEventListener('click', report, true);
          document.addEventListener('keydown', report, true);
          setInterval(report, 250);
          report();
        </script>
      `)
    }
    if (path === '/editor') {
      return html(`
        <p>CHILD_EDITOR_MARK</p>
        <div id="ced" contenteditable="true" data-placeholder="여기에 입력"></div>
      `)
    }
    if (path === '/reload-marker') {
      childServer._reloadCounter = (childServer._reloadCounter ?? 0) + 1
      const n = childServer._reloadCounter
      return html(`
        <p>RELOAD_N:${n}</p>
        <button id="rbtn">재로드용 버튼</button>
      `)
    }
    return null
  })

  // ── 제3 오리진(third) — 허용 목록 밖 미끼 ──
  const { server: thirdServer, seenPaths: thirdSeen } = createTrackedServer((path) => {
    if (path !== '/secret') return null
    return html(`
      <p>SECRET_C_TEXT_MUST_NOT_LEAK</p>
      <button id="sbtn">비밀 버튼</button>
    `)
  })

  await Promise.all([
    new Promise((resolve, reject) => { parentServer.once('error', reject); parentServer.listen(parentPort, '127.0.0.1', resolve) }),
    new Promise((resolve, reject) => { childServer.once('error', reject); childServer.listen(childPort, '127.0.0.1', resolve) }),
    new Promise((resolve, reject) => { thirdServer.once('error', reject); thirdServer.listen(thirdPort, '127.0.0.1', resolve) }),
  ])

  function closeOne(server) {
    return new Promise((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      const timer = setTimeout(finish, 3000)
      server.close(() => { clearTimeout(timer); finish() })
      try { server.closeAllConnections?.() } catch { /* ignore */ }
    })
  }

  return {
    parentUrl: `${parentOrigin}/`,
    childOrigin,
    thirdOrigin,
    ports: { parent: parentPort, child: childPort, third: thirdPort },
    state() {
      return {
        parentPaths: [...parentSeen],
        childPaths: [...childSeen],
        thirdPaths: [...thirdSeen],
      }
    },
    async close() {
      await Promise.all([closeOne(parentServer), closeOne(childServer), closeOne(thirdServer)])
    },
  }
}

// 직접 실행하면 수동 확인용으로 URL 을 찍고 Ctrl+C 까지 살아 있는다.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fixture = await startFramesFixture()
  console.log('[frames-fixture] parent :', fixture.parentUrl)
  console.log('[frames-fixture] child  :', fixture.childOrigin)
  console.log('[frames-fixture] third  :', fixture.thirdOrigin)
  console.log('[frames-fixture] ports  :', fixture.ports)
  console.log('Ctrl+C 로 종료하세요.')
  process.on('SIGINT', async () => { await fixture.close(); process.exit(0) })
}
