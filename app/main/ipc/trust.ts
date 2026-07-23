import type { IpcMainInvokeEvent } from 'electron'

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
