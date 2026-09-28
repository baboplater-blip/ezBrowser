import { app, BrowserWindow } from 'electron'
import type {
  AuthInfo, AuthenticationResponseDetails, Certificate, Event as ElectronEvent, NativeImage, WebContents,
} from 'electron'
import { tMain } from '../../i18n'

// ===== 오류 페이지(browser://error) 연결 =====
// tab-service 는 이 모듈에만 의존하고, 이 모듈은 tab/window 모델을 모른다(순환 의존 방지).
// 실패한 탭을 우리가 그린 오류 페이지로 바꿔치기하는 것과, 인증서 예외·기본 인증 팝업처럼
// 창 하나짜리로 끝나는 전역(app 레벨) 이벤트를 함께 다룬다.

export type ErrorPageKind = 'load-fail' | 'crash' | 'cert'

// 값은 tMain 의 fallback(= ko 원문) — 실제 표시는 friendlyDesc()/RENDER_GONE_LABELS 조회 시점에
// currentMainLocale() 기준으로 번역된다.
const FAIL_LOAD_KO: Record<string, string> = {
  ERR_NAME_NOT_RESOLVED: '주소를 찾을 수 없습니다',
  ERR_CONNECTION_REFUSED: '연결이 거부되었습니다',
  ERR_CONNECTION_RESET: '연결이 재설정되었습니다',
  ERR_CONNECTION_CLOSED: '연결이 끊어졌습니다',
  ERR_CONNECTION_TIMED_OUT: '연결 시간이 초과되었습니다',
  ERR_INTERNET_DISCONNECTED: '인터넷에 연결되어 있지 않습니다',
  ERR_ADDRESS_UNREACHABLE: '주소에 접속할 수 없습니다',
  ERR_EMPTY_RESPONSE: '서버가 응답하지 않았습니다',
  ERR_SSL_PROTOCOL_ERROR: 'SSL 연결 오류',
  ERR_NETWORK_CHANGED: '네트워크가 변경되었습니다',
  ERR_FILE_NOT_FOUND: '파일을 찾을 수 없습니다',
  ERR_TOO_MANY_REDIRECTS: '리디렉션이 너무 많습니다',
  ERR_BLOCKED_BY_CLIENT: '이 브라우저가 요청을 차단했습니다',
}

const RENDER_GONE_LABELS: Record<string, string> = {
  crashed: '충돌',
  oom: '메모리 부족',
  'launch-failed': '실행 실패',
  killed: '강제 종료',
  'integrity-failure': '무결성 오류',
}

function friendlyDesc(desc: string): string {
  const fallback = FAIL_LOAD_KO[desc]
  if (!fallback) return desc
  return tMain(`main.pageError.net.${desc}`, fallback)
}

function renderGoneLabel(reason: string): string {
  const fallback = RENDER_GONE_LABELS[reason]
  if (!fallback) return reason
  return tMain(`main.pageError.crash.${reason}`, fallback)
}

function buildErrorUrl(opts: {
  kind: ErrorPageKind; code: number | string; desc: string; url: string; host?: string
}): string {
  const qs = new URLSearchParams({
    kind: opts.kind,
    code: String(opts.code),
    desc: opts.desc,
    url: opts.url,
  })
  if (opts.host) qs.set('host', opts.host)
  return `browser://error?${qs.toString()}`
}

// 인증서 오류를 한 번 눈감아 준 호스트 — 세션(=앱 실행) 동안만 유지, 디스크에 저장하지 않는다.
const certExceptions = new Set<string>()

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return '' }
}

export interface PageErrorHooks {
  onUnresponsive?: () => void
  onResponsiveAgain?: () => void
}

const tracked = new WeakSet<WebContents>()

/**
 * 탭(또는 팝업) 의 webContents 에 오류 처리를 건다. 한 webContents 당 한 번만 유효(중복 등록 방지).
 * - 로드 실패 → browser://error 로 대체
 * - 렌더러 프로세스 소멸(크래시 등) → browser://error 로 대체
 * - 무응답/응답 재개 → 훅으로 위임(토스트 등은 호출자가 window 컨텍스트를 알고 있으므로)
 * - browser://error 페이지의 "위험을 감수하고 계속" 클릭(해시 내비게이션)을 받아 인증서 예외 등록 + 재시도
 */
export function trackPageErrors(wc: WebContents, hooks: PageErrorHooks = {}): void {
  if (tracked.has(wc)) return
  tracked.add(wc)

  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    if (errorCode === -3) return // ERR_ABORTED — 사용자 취소/다른 내비게이션으로 대체된 정상 상황
    if (!validatedURL || !/^https?:/i.test(validatedURL)) return
    if (validatedURL.startsWith('browser://error')) return // 무한 루프 방지
    if (wc.isDestroyed()) return
    void wc.loadURL(buildErrorUrl({
      kind: 'load-fail', code: errorCode, desc: friendlyDesc(errorDescription || tMain('main.pageError.unknown', '알 수 없는 오류')), url: validatedURL,
    }))
  })

  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    if (wc.isDestroyed()) return
    let url = ''
    try { url = wc.getURL() } catch { /* ignore */ }
    const label = renderGoneLabel(details.reason)
    // 렌더러가 막 죽은 직후엔 즉시 loadURL 이 불안정할 수 있어 한 틱 늦춘다.
    setTimeout(() => {
      if (wc.isDestroyed()) return
      void wc.loadURL(buildErrorUrl({
        kind: 'crash', code: details.exitCode, desc: tMain('main.pageError.crashDesc', `탭이 멈췄습니다 (${label})`, { label }), url: url || 'about:blank',
      }))
    }, 50)
  })

  wc.on('unresponsive', () => hooks.onUnresponsive?.())
  wc.on('responsive', () => hooks.onResponsiveAgain?.())

  // browser://error 페이지의 "위험을 감수하고 계속" 버튼은 같은 문서 안에서 해시만 바꾼다
  // (실제 IPC 없이 오류 페이지 자체 preload(content.js) 가 아무 API 도 노출하지 않아도 동작하게 하려는 설계).
  // 공격 사이트가 자기 페이지에서 이 해시를 흉내내도 URL 이 browser://error 가 아니므로 무시된다.
  wc.on('did-navigate-in-page', (_e, url) => {
    if (!url.startsWith('browser://error')) return
    let hash = ''
    try { hash = new URL(url).hash.replace(/^#/, '') } catch { return }
    if (!hash.startsWith('bypass-cert=')) return
    try {
      const payload = JSON.parse(decodeURIComponent(hash.slice('bypass-cert='.length))) as { host?: unknown; target?: unknown }
      if (typeof payload.host === 'string' && payload.host) certExceptions.add(payload.host)
      if (typeof payload.target === 'string' && /^https?:/i.test(payload.target) && !wc.isDestroyed()) {
        void wc.loadURL(payload.target)
      }
    } catch { /* 잘못된 해시는 무시 */ }
  })
}

// ===== 전역(app) 이벤트: 인증서 오류 + HTTP 기본 인증 =====

let globalHandlersInstalled = false

export function initGlobalPageErrorHandlers(): void {
  if (globalHandlersInstalled) return
  globalHandlersInstalled = true

  app.on('certificate-error', (event: ElectronEvent, wc: WebContents, url: string, error: string, _certificate: Certificate, callback: (isTrusted: boolean) => void, isMainFrame: boolean) => {
    const host = hostOf(url)
    if (host && certExceptions.has(host)) {
      event.preventDefault()
      callback(true)
      return
    }
    // 기본은 거부. 메인 프레임 내비게이션이면 경고 페이지로 안내(하위 리소스의 인증서 오류는
    // 페이지 하나를 통으로 오류 페이지로 바꾸면 과도하므로 조용히 거부만 한다).
    event.preventDefault()
    callback(false)
    if (!isMainFrame || wc.isDestroyed()) return
    void wc.loadURL(buildErrorUrl({ kind: 'cert', code: error, desc: tMain('main.pageError.certUntrusted', '이 사이트의 보안 인증서를 신뢰할 수 없습니다'), url, host }))
  })

  app.on('login', (event: ElectronEvent, wc: WebContents, details: AuthenticationResponseDetails, authInfo: AuthInfo, callback: (username?: string, password?: string) => void) => {
    if (authInfo.isProxy) return // 프록시 인증은 범위 밖 — 기존 기본 동작(취소) 유지
    event.preventDefault()
    openLoginPrompt(wc, details, authInfo, callback)
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

function openLoginPrompt(
  ownerWc: WebContents,
  details: AuthenticationResponseDetails,
  authInfo: AuthInfo,
  callback: (username?: string, password?: string) => void,
): void {
  const ownerWin = (() => { try { return BrowserWindow.fromWebContents(ownerWc) ?? undefined } catch { return undefined } })()
  let done = false
  const finish = (username?: string, password?: string): void => {
    if (done) return
    done = true
    try { if (!promptWin.isDestroyed()) promptWin.close() } catch { /* ignore */ }
    callback(username, password)
  }

  const promptWin = new BrowserWindow({
    width: 380,
    height: 240,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    parent: ownerWin,
    modal: !!ownerWin,
    show: false,
    autoHideMenuBar: true,
    title: tMain('main.pageError.auth.title', '로그인 필요'),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  promptWin.on('closed', () => finish())
  promptWin.webContents.on('did-navigate-in-page', (_e, url) => {
    let hash = ''
    try { hash = new URL(url).hash.replace(/^#/, '') } catch { return }
    if (hash.startsWith('submit=')) {
      try {
        const { u, p } = JSON.parse(decodeURIComponent(hash.slice('submit='.length))) as { u?: string; p?: string }
        finish(u, p)
      } catch { finish() }
    } else if (hash === 'cancel') {
      finish()
    }
  })

  const host = escapeHtml(`${authInfo.host}${authInfo.port ? ':' + authInfo.port : ''}`)
  const realm = escapeHtml(authInfo.realm || '')
  const urlLabel = escapeHtml(details.url)
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
    <style>
      :root{color-scheme:light dark}
      body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Pretendard',sans-serif;padding:20px;background:#fff;color:#1a1a1a}
      @media (prefers-color-scheme:dark){body{background:#1a1a1f;color:#f2f2f5}}
      h1{font-size:15px;margin:0 0 4px}
      p{font-size:12px;color:#777;margin:0 0 16px;word-break:break-all}
      label{display:block;font-size:12px;margin:10px 0 4px}
      input{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid #ccc;font-size:13px}
      .row{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}
      button{padding:7px 14px;border-radius:6px;border:1px solid #ccc;background:#f2f2f2;cursor:pointer;font-size:12px}
      button.primary{background:#3478F6;color:#fff;border-color:#3478F6}
    </style></head>
    <body>
      <h1>${tMain('main.pageError.auth.heading', '{host} 에서 인증을 요구합니다', { host })}</h1>
      <p>${realm ? realm + ' · ' : ''}${urlLabel}</p>
      <form id="f">
        <label>${tMain('main.pageError.auth.username', '아이디')}</label><input id="u" autofocus>
        <label>${tMain('main.pageError.auth.password', '비밀번호')}</label><input id="p" type="password">
        <div class="row">
          <button type="button" id="cancel">${tMain('main.pageError.auth.cancel', '취소')}</button>
          <button type="submit" class="primary">${tMain('main.pageError.auth.submit', '로그인')}</button>
        </div>
      </form>
      <script>
        document.getElementById('f').addEventListener('submit', function (e) {
          e.preventDefault()
          var u = document.getElementById('u').value
          var p = document.getElementById('p').value
          location.hash = 'submit=' + encodeURIComponent(JSON.stringify({ u: u, p: p }))
        })
        document.getElementById('cancel').addEventListener('click', function () {
          location.hash = 'cancel'
        })
      </script>
    </body></html>`

  void promptWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  promptWin.once('ready-to-show', () => { if (!promptWin.isDestroyed()) promptWin.show() })
}

// ===== 탭 미리보기 썸네일 =====

const THUMBNAIL_WIDTH = 320

/** capturePage() 결과를 미리보기용으로 축소(320px 폭) + JPEG 재인코딩(품질 70) 해 data URL 로. */
export function thumbnailDataUrl(img: NativeImage): string | null {
  if (img.isEmpty()) return null
  const size = img.getSize()
  if (size.width <= 0) return null
  const resized = size.width > THUMBNAIL_WIDTH ? img.resize({ width: THUMBNAIL_WIDTH }) : img
  try {
    const buf = resized.toJPEG(70)
    if (!buf || buf.length === 0) return null
    return `data:image/jpeg;base64,${buf.toString('base64')}`
  } catch { return null }
}
