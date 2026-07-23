import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  adblockEvents, getAdblockStats, setAdblockEnabled, setAdblockFilter, setAdblockLevel,
  setSiteAllowed, toggleSiteAllowed,
} from '../features/adblock'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { isTrustedSender } from './trust'

function broadcast(channel: string, payload?: unknown): void {
  for (const ctx of getAllWindows()) {
    if (!ctx.chrome.webContents.isDestroyed()) {
      ctx.chrome.webContents.send(channel, payload)
    }
  }
  broadcastToInternalPages(channel, payload)
}

export function registerAdblockIpc(): void {
  ipcMain.handle(IPC.adblock.stats, () => getAdblockStats())
  ipcMain.handle(IPC.adblock.setLevel, (e, { level }: { level: 'lite' | 'standard' | 'strict' | 'custom' }) => {
    if (!isTrustedSender(e)) return
    return setAdblockLevel(level)
  })
  ipcMain.handle(IPC.adblock.setEnabled, (e, { enabled }: { enabled: boolean }) => {
    if (!isTrustedSender(e)) return
    return setAdblockEnabled(enabled)
  })
  ipcMain.handle(IPC.adblock.setFilter, (e, args: { id: 'easylist' | 'easyprivacy' | 'kr' | 'fanboyAnnoyance' | 'fanboySocial'; enabled: boolean }) => {
    if (!isTrustedSender(e)) return
    return setAdblockFilter(args.id, args.enabled)
  })
  ipcMain.handle(IPC.adblock.setSiteAllowed, (e, args: { host: string; allowed: boolean }) => {
    if (!isTrustedSender(e)) return
    return setSiteAllowed(args.host, args.allowed)
  })
  ipcMain.handle(IPC.adblock.toggleSite, (e, args: { url: string }) => {
    if (!isTrustedSender(e)) return
    return toggleSiteAllowed(args.url)
  })

  adblockEvents.on('changed', () => {
    broadcast(IPC.adblock.changed, getAdblockStats())
  })
}
