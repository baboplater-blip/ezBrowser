import { app, session, webContents, type Session, type WebContents } from 'electron'
import path from 'node:path'
import { promises as fsPromises } from 'node:fs'
import { permissionDecisionFor } from './features/policy'
import { getPermissionDecision, setPermission } from './storage/permissions'
import { installResponseHooks } from './features/response-hooks'
import { installWebRequestDispatcher } from './features/web-request-dispatcher'
import { IPC } from '../shared/ipc-channels'
import { findTabIdByWebContentsId } from './tabs/tab-service'
import { getWindow } from './windows/window-service'

// 무해한 권한 — 사용자에게 물을 필요 없이 항상 허용(내부 페이지·웹 페이지 무관).
const PERMISSION_AUTO_ALLOW: ReadonlySet<string> = new Set(['fullscreen', 'pointerLock'])

// 크롬처럼 "물어야" 하는 권한 — 사이트별 저장된 결정·정책 룰이 없으면 사용자에게 프롬프트.
// (예전엔 여기 있는 것들이 PERMISSION_ALLOWED 에 들어가 **무조건 허용**됐다 — 카메라·마이크·
// 위치·알림을 아무 사이트에나 묻지도 않고 내줬다는 뜻. 항목 1.)
const PERMISSION_PROMPTABLE: ReadonlySet<string> = new Set(['media', 'geolocation', 'notifications', 'clipboard-read'])

// http/https 가 아닌 컨텍스트(외피 자신·확장·내부 페이지 등 — 물어볼 "사이트"가 없다)에서는
// 예전과 같이 promptable 권한도 자동 허용한다(신뢰된 컨텍스트).
function isPromptableContext(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// ===== 권한 프롬프트 큐 =====
// setPermissionRequestHandler 의 cb 는 언제 불러도 되는 비동기 콜백이다 — 외피에 말풍선을 띄우고
// 사용자가 허용/차단을 고를 때까지(또는 닫힘·탭 소멸·60초 무응답으로 거부될 때까지) 쥐고 있는다.

interface PendingPermissionPrompt {
  origin: string
  permission: string
  cb: (allow: boolean) => void
  timer: NodeJS.Timeout
  cleanup: () => void
  // 프롬프트를 띄운 외피(셸) webContents — 사용자 응답 없이(타임아웃·탭 소멸) 메인이 스스로
  // 거부를 확정할 때, 이 창에 "그 프롬프트는 이제 치워도 된다"고 알리기 위해 보관한다.
  // 요청을 보낸 콘텐츠 탭(wc)은 이 시점에 이미 파괴됐을 수 있어 셸 쪽을 따로 들고 있어야 한다.
  chromeWebContentsId: number
}

const pendingPermissionPrompts = new Map<string, PendingPermissionPrompt>()
let permissionPromptCounter = 0
const PERMISSION_PROMPT_TIMEOUT_MS = 60_000

/** 셸이 아직 안 파괴됐으면 promptClosed 를 보낸다 — 외피 큐에 남아 있을 그 promptId 를 지우라는 신호. */
function notifyPromptClosed(chromeWebContentsId: number, promptId: string): void {
  try {
    const wc = webContents.fromId(chromeWebContentsId)
    if (wc && !wc.isDestroyed()) wc.send(IPC.permissions.promptClosed, { promptId })
  } catch { /* 창이 이미 닫혔거나 — 어차피 지울 큐도 없다 */ }
}

/** 외피(PermissionPrompt.tsx)가 사용자의 선택을 알려줄 때 호출 — ipc/permissions.ts 에서 연결. */
export function resolvePermissionPrompt(promptId: string, allow: boolean, remember: boolean): void {
  const p = pendingPermissionPrompts.get(promptId)
  if (!p) return
  clearTimeout(p.timer)
  p.cleanup()
  pendingPermissionPrompts.delete(promptId)
  if (remember) setPermission(p.origin, p.permission, allow ? 'allow' : 'deny')
  p.cb(allow)
}

function denyAndForget(promptId: string): void {
  const p = pendingPermissionPrompts.get(promptId)
  if (!p) return
  clearTimeout(p.timer)
  p.cleanup()
  pendingPermissionPrompts.delete(promptId)
  p.cb(false)
  // 사용자가 직접 고른 게 아니므로(타임아웃·탭 소멸) — 외피 큐에 그 프롬프트가 아직 남아
  // 있다면 지우라고 알린다. 이게 없으면 이미 사라진 탭에 대한 말풍선이 화면에 영원히 남는다.
  notifyPromptClosed(p.chromeWebContentsId, promptId)
}

/**
 * 저장된 결정·정책 룰이 없는 promptable 권한을 사용자에게 물어본다.
 * 창/탭을 못 찾거나(팝업·서비스워커 등 화면에 보여줄 곳이 없음) 요청 콘텐츠가 곧 사라지면
 * 안전하게 거부한다 — "물어볼 수 없으면 허용하지 않는다".
 */
function requestPermissionFromUser(
  wc: WebContents, permission: string, origin: string, cb: (allow: boolean) => void,
): void {
  const found = findTabIdByWebContentsId(wc.id)
  if (!found) { cb(false); return }
  const ctx = getWindow(found.windowId)
  if (!ctx || ctx.chrome.webContents.isDestroyed()) { cb(false); return }

  permissionPromptCounter += 1
  const promptId = `perm-${Date.now().toString(36)}-${permissionPromptCounter}`

  const timer = setTimeout(() => denyAndForget(promptId), PERMISSION_PROMPT_TIMEOUT_MS)
  const onDestroyed = (): void => denyAndForget(promptId)
  wc.once('destroyed', onDestroyed)
  const cleanup = (): void => { try { wc.removeListener('destroyed', onDestroyed) } catch { /* noop */ } }

  pendingPermissionPrompts.set(promptId, {
    origin, permission, cb, timer, cleanup, chromeWebContentsId: ctx.chrome.webContents.id,
  })
  ctx.chrome.webContents.send(IPC.permissions.promptOpen, {
    promptId, origin, permission, tabId: found.tabId,
  })
}

const ASSET_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

async function handleBrowserUrl(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const page = url.hostname
  if (!/^[a-z0-9-]+$/i.test(page)) {
    return new Response('Bad Request', { status: 400 })
  }
  // pathname 에서 페이지 폴더 내 단일 파일만 허용 (디렉터리·traversal 차단).
  // 빈 경로/`/` → index.html. 그 외엔 `pages/<page>/<file>` 로 정적 자산(이미지·css·js) 서빙.
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  if (rel === '') rel = 'index.html'
  const safe = /^[a-z0-9_.-]+$/i.test(rel) && !rel.includes('..')
  const ext = safe ? (rel.slice(rel.lastIndexOf('.')).toLowerCase()) : ''
  const pageDir = path.join(app.getAppPath(), 'pages', page)
  if (safe && ASSET_MIME[ext]) {
    try {
      const data = await fsPromises.readFile(path.join(pageDir, rel))
      return new Response(data, { headers: { 'Content-Type': ASSET_MIME[ext] } })
    } catch {
      // 자산이 없으면 — html 류는 index.html 폴백, 그 외(이미지 등)는 404
      if (ext !== '.html') {
        return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      }
    }
  }
  // 기본 동작: 페이지의 index.html (알 수 없는 경로도 index.html 로 — 기존 동작 보존)
  try {
    const data = await fsPromises.readFile(path.join(pageDir, 'index.html'))
    return new Response(data, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  } catch {
    return new Response(`Not Found: browser://${page}`, {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}

const installedSessions = new WeakSet<Session>()
// 설치된 세션을 enumerate 할 수 있도록 배열로도 보관(세션은 앱 수명 동안 유지되므로 누수 아님).
// 이래야 뒤늦게 등록되는 hook(예: 1.5초 후 init 되는 adblock)도 이미 만들어진 모든 partition 에 적용 가능.
const installedSessionList: Session[] = []
const sessionHooks: Array<(ses: Session) => void> = []

export function addSessionInitHook(hook: (ses: Session) => void): void {
  sessionHooks.push(hook)
  // 이미 install 된 모든 세션에도 즉시 적용
  for (const ses of installedSessionList) {
    try { hook(ses) } catch (err) { console.warn('[session-bootstrap] late hook failed', err) }
  }
}

/** 설치된 세션 목록에서 제거 — 시크릿 창처럼 수명이 유한한(in-memory) 세션이 닫힌 뒤 누적되지 않도록.
 *  (영속 세션 persist:* 은 앱 수명 동안 유지되므로 호출하지 않는다.) */
export function removeInstalledSession(ses: Session): void {
  installedSessions.delete(ses)
  const i = installedSessionList.indexOf(ses)
  if (i >= 0) installedSessionList.splice(i, 1)
}

/**
 * 세션 → partition 문자열. Electron 의 Session 객체는 자기 partition 이름을 알려주지 않아서,
 * **우리가 만들 때 기록해 두는 것 말고는 되찾을 방법이 없다**(session.fromPartition 으로 역추적하면
 * 존재하지 않는 세션을 새로 만드는 부작용이 난다).
 * 확장 쪽에서 "이 세션이 시크릿인가"(확장을 올리면 안 됨) · "사용자에게 뭐라고 부를까"를 판단하는 데 쓴다.
 */
const partitionBySession = new WeakMap<Session, string>()

/** 이 세션의 partition 문자열. defaultSession 은 빈 문자열, 모르면 undefined. */
export function partitionOfSession(ses: Session): string | undefined {
  if (ses === session.defaultSession) return ''
  return partitionBySession.get(ses)
}

/** 설치된 모든 세션을 순회 (adblock 재초기화 등에서 사용). */
export function forEachInstalledSession(fn: (ses: Session) => void): void {
  for (const ses of installedSessionList) {
    try { fn(ses) } catch (err) { console.warn('[session-bootstrap] forEach fn failed', err) }
  }
}

export function setupSession(ses: Session): void {
  if (installedSessions.has(ses)) return
  installedSessions.add(ses)
  installedSessionList.push(ses)

  // 1) browser:// 프로토콜
  try {
    ses.protocol.handle('browser', handleBrowserUrl)
  } catch (err) {
    // defaultSession 은 protocol.handle (global) 로 등록되어 이중 등록 시 throw — 안전 무시
    if (ses !== session.defaultSession) {
      console.warn('[session-bootstrap] protocol.handle failed', err)
    }
  }

  // 1-b) webRequest 디스패처(onBeforeRequest/onBeforeSendHeaders/onHeadersReceived) 단독 소유 —
  //      확장 DNR·클라이언트 힌트·서드파티 쿠키 차단·사용자 정책이 부팅 즉시 걸린다. adblock 은
  //      뒤늦게(초기화 완료 시) setAdblockProviders 로 판정만 등록하고 리스너는 걸지 않는다.
  try { installWebRequestDispatcher(ses) } catch (err) { console.warn('[session-bootstrap] dispatcher install failed', err) }

  // 2) 권한 핸들러 — 사이트별 오버라이드 우선 → policy 룰 → 무해한 권한 자동 허용 →
  //    나머지(media/geolocation/notifications/clipboard-read)는 크롬처럼 사용자에게 묻는다.
  //    (예전엔 이 promptable 권한들이 전부 무조건 허용이었다 — 항목 1.)
  ses.setPermissionRequestHandler((wc, perm, cb, details) => {
    const url = (details as { requestingUrl?: string })?.requestingUrl ?? wc?.getURL() ?? ''
    const site = url ? getPermissionDecision(url, perm) : null
    if (site === 'allow') return cb(true)
    if (site === 'deny') return cb(false)
    const decision = url ? permissionDecisionFor(url, perm) : null
    if (decision === 'allow') return cb(true)
    if (decision === 'deny') return cb(false)
    if (PERMISSION_AUTO_ALLOW.has(perm)) return cb(true)
    if (!isPromptableContext(url)) {
      // 내부 페이지·확장·file: 등 — 사용자에게 보여줄 "사이트" 가 없는 신뢰된 컨텍스트.
      return cb(PERMISSION_PROMPTABLE.has(perm))
    }
    if (!PERMISSION_PROMPTABLE.has(perm)) return cb(false)
    if (!wc || wc.isDestroyed()) return cb(false)
    let origin: string
    try { origin = new URL(url).origin } catch { return cb(false) }
    requestPermissionFromUser(wc, perm, origin, cb)
  })
  ses.setPermissionCheckHandler((wc, perm, requestingOrigin) => {
    const url = requestingOrigin || wc?.getURL() || ''
    const site = url ? getPermissionDecision(url, perm) : null
    if (site === 'allow') return true
    if (site === 'deny') return false
    const decision = url ? permissionDecisionFor(url, perm) : null
    if (decision === 'allow') return true
    if (decision === 'deny') return false
    if (PERMISSION_AUTO_ALLOW.has(perm)) return true
    if (!isPromptableContext(url)) return PERMISSION_PROMPTABLE.has(perm)
    // promptable 인데 저장된 결정이 없으면 — 사용자가 프롬프트에서 고르기 전까지는 false
    // (크롬의 "prompt" 상태와 같은 의미).
    return false
  })

  // 3) 미디어/토렌트 감지용 onResponseStarted (모든 세션에 설치 — 탭은 파티션 세션 사용)
  try { installResponseHooks(ses) } catch (err) { console.warn('[session-bootstrap] response-hooks failed', err) }

  // 3.5) 맞춤법 검사 언어 — 한국어 + 영어 동시 검사(콘텍스트 메뉴 제안·"사전에 추가"의 전제).
  try { ses.setSpellCheckerLanguages(['ko', 'en-US']) } catch (err) { console.warn('[session-bootstrap] spellchecker langs failed', err) }

  // 4) 외부 모듈 hook (userscript·정책 customJs 트래킹 등 webRequest 아닌 것들)
  for (const hook of sessionHooks) {
    try { hook(ses) } catch (err) { console.warn('[session-bootstrap] hook failed', err) }
  }
}

export function setupSessionByPartition(partition: string): void {
  const ses = session.fromPartition(partition)
  // 라벨은 setupSession 보다 **먼저** 기록한다 — setupSession 이 부르는 hook(확장 어댑터 등)이
  // 곧바로 partitionOfSession 을 물어보기 때문이다. 순서가 뒤바뀌면 시크릿 세션을 못 알아본다.
  partitionBySession.set(ses, partition)
  setupSession(ses)
}
