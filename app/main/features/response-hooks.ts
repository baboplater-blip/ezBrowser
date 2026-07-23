import type { Session } from 'electron'

type Listener = (details: Electron.OnResponseStartedListenerDetails) => void

const listeners: Listener[] = []
// onResponseStarted 는 세션당 콜백 1개만 허용 — 세션마다 한 번만 설치(중복 방지)
const installedSessions = new WeakSet<Session>()

/**
 * 주어진 세션에 onResponseStarted 팬아웃 콜백을 설치(멱등).
 * 탭은 defaultSession 이 아니라 persist:default / 워크스페이스 파티션 세션을 쓰므로
 * 모든 세션(session-bootstrap.setupSession 경유)에 설치해야 미디어/토렌트 감지가 동작한다.
 */
export function installResponseHooks(ses: Session): void {
  if (installedSessions.has(ses)) return
  installedSessions.add(ses)
  ses.webRequest.onResponseStarted({ urls: ['*://*/*'] }, (details) => {
    for (const fn of listeners) {
      try { fn(details) } catch (err) { console.warn('[response-hook] listener error', err) }
    }
  })
}

export function onResponseStarted(listener: Listener): () => void {
  listeners.push(listener)
  return () => {
    const idx = listeners.indexOf(listener)
    if (idx >= 0) listeners.splice(idx, 1)
  }
}
