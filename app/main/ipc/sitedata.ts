import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { clearSiteData, getSiteDataSummary, type SiteDataSummary } from '../features/sitedata'
import { isTrustedSender } from './trust'

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.origin : null
  } catch { return null }
}

export function registerSiteDataIpc(): void {
  ipcMain.handle(IPC.sitedata.summary, async (e, args: { origin: string }): Promise<SiteDataSummary> => {
    if (!isTrustedSender(e)) return { cookies: 0, hasData: false }
    const origin = originOf(args.origin)
    if (!origin) return { cookies: 0, hasData: false }
    return getSiteDataSummary(origin)
  })

  ipcMain.handle(IPC.sitedata.clear, async (e, args: { origin: string }): Promise<boolean> => {
    if (!isTrustedSender(e)) return false
    const origin = originOf(args.origin)
    if (!origin) return false
    await clearSiteData(origin)
    return true
  })
}
