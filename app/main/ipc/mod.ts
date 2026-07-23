import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  listMods, modEvents, reloadMod, removeMod, setModEnabled,
  listMenuItemsMeta, invokeMenuItem,
} from '../features/mod-api'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { isTrustedSender } from './trust'

export function registerModIpc(): void {
  ipcMain.handle(IPC.mod.list, (e) => {
    if (!isTrustedSender(e)) return []
    return listMods()
  })

  ipcMain.handle(IPC.mod.setEnabled, async (e, args: { id: string; enabled: boolean }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return setModEnabled(args.id, args.enabled)
  })

  ipcMain.handle(IPC.mod.reload, async (e, args: { id: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return reloadMod(args.id)
  })

  ipcMain.handle(IPC.mod.remove, async (e, args: { id: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return removeMod(args.id)
  })

  ipcMain.handle(IPC.mod.menuList, (e) => {
    if (!isTrustedSender(e)) return []
    return listMenuItemsMeta()
  })

  ipcMain.handle(IPC.mod.menuInvoke, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return invokeMenuItem(args.id)
  })

  modEvents.on('changed', () => {
    const summaries = listMods()
    for (const ctx of getAllWindows()) {
      ctx.chrome.webContents.send(IPC.mod.changed, summaries)
    }
    broadcastToInternalPages(IPC.mod.changed, summaries)
  })
}
