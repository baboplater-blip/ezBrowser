#!/usr/bin/env node
// challenge-fixture-server.mjs — 로그인 화면 / CAPTCHA 감지 검증 전용 로컬 fixture.
//
// 무엇을 검증하기 위한 것인가: 에이전트가 "지금 로그인이 필요하다" 또는 "CAPTCHA 를 풀어야
// 한다"는 것을 실제로 감지해 사용자에게 개입을 요청하는지, 그리고 그 감지가 **과탐**(비밀번호
// 입력도 CAPTCHA 위젯도 없는 평범한 문서에서 "로그인"·"인증" 같은 단어만 보고 오판)하지
// 않는지를 검증하기 위한 4-라우트 고정 장치다. 전부 한 서버, 순수 인라인 HTML.
//
// **외부 네트워크 요청은 0건이다** — /captcha 라우트는 진짜 reCAPTCHA/Cloudflare Turnstile 같은
// 외부 서비스를 절대 로드하지 않는다. data-sitekey 는 실재하지 않는 가짜 문자열이고, 외부
// <script> 태그도 삽입하지 않는다. "내가 직접 해결" 버튼은 사람이 CAPTCHA 를 풀었다는 상황을
// 순수 DOM 조작으로 흉내만 낸다.
//
// 검증 대상 시나리오(참고, 이 파일 자체는 fixture 만 제공하고 검증 로직은 담지 않는다):
//   - /login: 보이는 password 입력 → 로그인 필요로 감지되는가
//   - /captcha: CAPTCHA 위젯 문구 → 감지되는가, 해결 후 /after 로 이어갈 수 있는가
//   - /normal-words: "로그인"·"인증"·"verify your account" 등 단어가 있어도 실제 입력·위젯이
//     없으면 오탐하지 않는가 (대조군)
//   - /after: 해결 후 정상적으로 계속 진행 가능한가

import http from 'node:http'
import { getFreePort } from './lib/ports.mjs'

function html(body) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`
}

function send(res, status, body, contentType = 'text/html; charset=utf-8') {
  res.statusCode = status
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

export async function startChallengeFixture() {
  const seenPaths = []

  const server = http.createServer((req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      send(res, 400, 'bad request')
      return
    }
    const path = url.pathname
    seenPaths.push(path)

    if (path === '/login') {
      send(res, 200, html(`
        <p>LOGIN_PAGE_MARK</p>
        <label for="uid">아이디</label><input id="uid" type="text">
        <label for="pw">비밀번호</label><input id="pw" type="password">
        <button id="lbtn">로그인</button>
      `))
      return
    }

    if (path === '/captcha') {
      // 외부 요청 0건: div.g-recaptcha 는 문구·마크업만 흉내낸 순수 로컬 요소이며
      // 실제 구글/클라우드플레어 스크립트를 로드하지 않는다.
      send(res, 200, html(`
        <div class="g-recaptcha" data-sitekey="LOCAL-FIXTURE-NOT-REAL"></div>
        <p>로봇이 아닙니다 확인이 필요합니다</p>
        <button id="solve">내가 직접 해결</button>
        <script>
          document.getElementById('solve').addEventListener('click', function () {
            document.body.innerHTML = '<h1 id="done">CHALLENGE_SOLVED</h1><button id="next">다음 단계</button>';
          });
        </script>
      `))
      return
    }

    if (path === '/normal-words') {
      // 오탐 대조군: password 입력도 CAPTCHA 위젯도 없이, "로그인"·"인증"·"보안 확인"·
      // "login"·"verify your account" 같은 단어만 자연스럽게 여러 번 등장하는 평범한 안내문.
      send(res, 200, html(`
        <p>NORMAL_WORDS_MARK</p>
        <h2>계정 보안 안내</h2>
        <p>안전한 서비스 이용을 위해 로그인 상태를 주기적으로 확인해 주세요.
        login 이력은 설정 페이지에서 확인할 수 있습니다.</p>
        <p>We recommend you verify your account email periodically for security.
        인증 메일이 오지 않으면 스팸함을 확인하세요.</p>
        <p>보안 확인 절차는 계정을 안전하게 지키기 위한 조치이며, 별도의 인증 없이도
        서비스 대부분 기능을 계속 이용할 수 있습니다.</p>
        <a href="/login">로그인 페이지로</a>
        <button id="nbtn">계속</button>
      `))
      return
    }

    if (path === '/after') {
      send(res, 200, html(`
        <h1>AFTER_CHALLENGE</h1>
        <button id="abtn">최종 버튼</button>
      `))
      return
    }

    send(res, 404, 'not found')
  })

  const port = await getFreePort()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })

  const base = `http://127.0.0.1:${port}`

  return {
    port,
    base,
    urls: {
      login: `${base}/login`,
      captcha: `${base}/captcha`,
      normalWords: `${base}/normal-words`,
      after: `${base}/after`,
    },
    state() {
      return { paths: [...seenPaths] }
    },
    close() {
      return new Promise((resolve) => {
        let done = false
        const finish = () => { if (!done) { done = true; resolve() } }
        const timer = setTimeout(finish, 3000)
        server.close(() => { clearTimeout(timer); finish() })
        try { server.closeAllConnections?.() } catch { /* ignore */ }
      })
    },
  }
}

// 직접 실행하면 수동 확인용으로 URL 을 찍고 Ctrl+C 까지 살아 있는다.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fixture = await startChallengeFixture()
  console.log('[challenge-fixture] base :', fixture.base)
  console.log('[challenge-fixture] urls :', fixture.urls)
  console.log('Ctrl+C 로 종료하세요.')
  process.on('SIGINT', async () => { await fixture.close(); process.exit(0) })
}
