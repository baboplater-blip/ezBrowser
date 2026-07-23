import { app, session, type Session } from 'electron'
import path from 'node:path'
import { promises as fsPromises } from 'node:fs'
import { permissionDecisionFor } from './features/policy'
import { getPermissionDecision } from './storage/permissions'
import { installResponseHooks } from './features/response-hooks'

const PERMISSION_ALLOWED: ReadonlyArray<string> = [
  'media', 'geolocation', 'notifications',
  'clipboard-read', 'fullscreen', 'pointerLock',
]

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

  // 2) 권한 핸들러 — 사이트별 오버라이드 우선 → policy 룰 → 화이트리스트 fallback
  ses.setPermissionRequestHandler((wc, perm, cb, details) => {
    const url = (details as { requestingUrl?: string })?.requestingUrl ?? wc?.getURL() ?? ''
    const site = url ? getPermissionDecision(url, perm) : null
    if (site === 'allow') return cb(true)
    if (site === 'deny') return cb(false)
    const decision = url ? permissionDecisionFor(url, perm) : null
    if (decision === 'allow') return cb(true)
    if (decision === 'deny') return cb(false)
    cb(PERMISSION_ALLOWED.includes(perm))
  })
  ses.setPermissionCheckHandler((wc, perm, requestingOrigin) => {
    const url = requestingOrigin || wc?.getURL() || ''
    const site = url ? getPermissionDecision(url, perm) : null
    if (site === 'allow') return true
    if (site === 'deny') return false
    const decision = url ? permissionDecisionFor(url, perm) : null
    if (decision === 'allow') return true
    if (decision === 'deny') return false
    return PERMISSION_ALLOWED.includes(perm)
  })

  // 3) 미디어/토렌트 감지용 onResponseStarted (모든 세션에 설치 — 탭은 파티션 세션 사용)
  try { installResponseHooks(ses) } catch (err) { console.warn('[session-bootstrap] response-hooks failed', err) }

  // 4) 외부 모듈 hook (policy webRequest, 향후 adblock 등)
  for (const hook of sessionHooks) {
    try { hook(ses) } catch (err) { console.warn('[session-bootstrap] hook failed', err) }
  }
}

export function setupSessionByPartition(partition: string): void {
  const ses = session.fromPartition(partition)
  setupSession(ses)
}
