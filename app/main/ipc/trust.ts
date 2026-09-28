import { ipcMain, type IpcMainInvokeEvent } from 'electron'

const TRUSTED_PROTOCOLS = ['browser:', 'file:', 'devtools:']
const TRUSTED_HOSTS = new Set(['localhost'])

export function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  try {
    const url = e.sender.getURL()
    if (!url) return false
    const u = new URL(url)
    if (TRUSTED_PROTOCOLS.includes(u.protocol)) return true
    if (u.protocol === 'http:' && TRUSTED_HOSTS.has(u.hostname)) return true
    return false
  } catch {
    return false
  }
}

/**
 * 외피(file://)·browser:// 내부 페이지에서만 호출되어야 하는 IPC 핸들러를 등록한다.
 * isTrustedSender 가 false 면 핸들러 본문을 실행하지 않고 즉시 거부한다 — 외부 웹
 * 페이지(content.js)나 위조된 sender 가 내부 전용 채널을 두드리는 것을 막는 공통 게이트.
 *
 * 콘텐츠 preload(content.js/external-features.ts)가 정상적으로 호출해야 하는 채널
 * (제스처·빠른검색·비밀번호 lookup/proposeSave·동영상 오버레이 등)에는 절대 쓰지 말 것 —
 * 그 채널들은 자체적으로 sender URL 에서 origin/탭을 유도해 검증한다.
 */
export function handleTrusted<T = unknown, R = unknown>(
  channel: string,
  fn: (e: IpcMainInvokeEvent, payload: T) => R | Promise<R>,
): void {
  ipcMain.handle(channel, (e, payload: T) => {
    if (!isTrustedSender(e)) {
      throw new Error(`거부됨: ${channel} 은 신뢰된 발신자만 호출할 수 있습니다`)
    }
    return fn(e, payload)
  })
}
