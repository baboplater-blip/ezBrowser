import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  addReadLater, clearReadReadLater, isReadLaterSaved, listReadLater,
  readlaterEvents, removeReadLater, setReadLaterRead,
} from '../storage/readlater'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { isTrustedSender } from './trust'

export function registerReadLaterIpc(): void {
  ipcMain.handle(IPC.readlater.list, (e) => {
    if (!isTrustedSender(e)) return []
    return listReadLater()
  })

  ipcMain.handle(IPC.readlater.add, (e, args: { url: string; title?: string; favicon?: string }) => {
    if (!isTrustedSender(e)) return null
    return addReadLater(args)
  })

  ipcMain.handle(IPC.readlater.remove, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return
    removeReadLater(args.id)
  })

  ipcMain.handle(IPC.readlater.setRead, (e, args: { id: string; read: boolean }) => {
    if (!isTrustedSender(e)) return
    setReadLaterRead(args.id, args.read)
  })

  ipcMain.handle(IPC.readlater.clearRead, (e) => {
    if (!isTrustedSender(e)) return
    clearReadReadLater()
  })

  ipcMain.handle(IPC.readlater.isSaved, (e, args: { url: string }) => {
    if (!isTrustedSender(e)) return false
    return isReadLaterSaved(args.url)
  })

  readlaterEvents.on('changed', () => {
    const items = listReadLater()
    for (const ctx of getAllWindows()) {
      if (!ctx.chrome.webContents.isDestroyed()) ctx.chrome.webContents.send(IPC.readlater.changed, items)
    }
    broadcastToInternalPages(IPC.readlater.changed, items)
  })
}
