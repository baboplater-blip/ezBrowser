import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  checkForUpdates, downloadUpdate, getStatus, quitAndInstall,
  setAutoCheck, setAutoDownload, setChannel, updateEvents,
} from '../features/auto-update'
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

export function registerUpdateIpc(): void {
  ipcMain.handle(IPC.update.status, () => getStatus())
  ipcMain.handle(IPC.update.check, (e) => { if (!isTrustedSender(e)) return; return checkForUpdates(false) })
  ipcMain.handle(IPC.update.download, (e) => { if (!isTrustedSender(e)) return; return downloadUpdate() })
  ipcMain.handle(IPC.update.install, (e) => { if (!isTrustedSender(e)) return; quitAndInstall() })
  ipcMain.handle(IPC.update.setChannel, (e, { channel }: { channel: 'latest' | 'beta' | 'nightly' }) => {
    if (!isTrustedSender(e)) return
    setChannel(channel)
  })
  ipcMain.handle(IPC.update.setAutoDownload, (e, { enabled }: { enabled: boolean }) => {
    if (!isTrustedSender(e)) return
    setAutoDownload(enabled)
  })
  ipcMain.handle(IPC.update.setAutoCheck, (e, { enabled }: { enabled: boolean }) => {
    if (!isTrustedSender(e)) return
    setAutoCheck(enabled)
  })

  updateEvents.on('status', (status) => broadcast(IPC.update.status, status))
}
