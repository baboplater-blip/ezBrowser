import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  getUserscript, listUserscripts, removeUserscript,
  saveUserscript, setUserscriptEnabled, userscriptEvents,
} from '../features/userscript'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { isTrustedSender } from './trust'

export function registerUserscriptIpc(): void {
  ipcMain.handle(IPC.userscript.list, (e) => {
    if (!isTrustedSender(e)) return []
    return listUserscripts()
  })

  ipcMain.handle(IPC.userscript.get, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return null
    return getUserscript(args.id)
  })

  ipcMain.handle(IPC.userscript.save, async (e, args: { id?: string; source: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return saveUserscript(args)
  })

  ipcMain.handle(IPC.userscript.remove, async (e, args: { id: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    await removeUserscript(args.id)
  })

  ipcMain.handle(IPC.userscript.setEnabled, async (e, args: { id: string; enabled: boolean }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    await setUserscriptEnabled(args.id, args.enabled)
  })

  userscriptEvents.on('changed', () => {
    const summaries = listUserscripts()
    for (const ctx of getAllWindows()) {
      ctx.chrome.webContents.send(IPC.userscript.changed, summaries)
    }
    broadcastToInternalPages(IPC.userscript.changed, summaries)
  })
}
