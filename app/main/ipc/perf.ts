import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { getReport, perfEvents } from '../features/perf'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'

function broadcast(channel: string, payload?: unknown): void {
  for (const ctx of getAllWindows()) {
    if (!ctx.chrome.webContents.isDestroyed()) {
      ctx.chrome.webContents.send(channel, payload)
    }
  }
  broadcastToInternalPages(channel, payload)
}

export function registerPerfIpc(): void {
  ipcMain.handle(IPC.perf.report, () => getReport())
  perfEvents.on('milestone', (m) => broadcast(IPC.perf.milestone, m))
}
