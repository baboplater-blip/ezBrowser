import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  clearHistory, historyEvents, recentVisits, removeHistoryById,
  removeHistoryByUrl, searchHistory, topSites,
} from '../storage/history'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { isTrustedSender } from './trust'

export function registerHistoryIpc(): void {
  ipcMain.handle(IPC.history.recent, (e, args?: { limit?: number }) => {
    if (!isTrustedSender(e)) return []
    return recentVisits(args?.limit)
  })

  ipcMain.handle(IPC.history.search, (e, args: { query: string; limit?: number }) => {
    if (!isTrustedSender(e)) return []
    if (!args.query) return []
    return searchHistory(args.query, args.limit)
  })

  ipcMain.handle(IPC.history.topSites, (e, args?: { limit?: number }) => {
    if (!isTrustedSender(e)) return []
    return topSites(args?.limit)
  })

  ipcMain.handle(IPC.history.remove, (e, args: { id?: number; url?: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    if (typeof args.id === 'number') removeHistoryById(args.id)
    else if (args.url) removeHistoryByUrl(args.url)
  })

  ipcMain.handle(IPC.history.clear, (e, args?: { sinceMs?: number }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    clearHistory(args)
  })

  historyEvents.on('changed', () => {
    for (const ctx of getAllWindows()) {
      ctx.chrome.webContents.send(IPC.history.changed)
    }
    broadcastToInternalPages(IPC.history.changed)
  })
}
