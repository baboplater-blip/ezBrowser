import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  getMacro, listMacros, macroEvents, removeMacro, runMacro, saveMacro, setMacroEnabled,
} from '../features/automation'
import { getWebContentsByTabId, listTabs } from '../tabs/tab-service'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import type { Macro } from '../../shared/types'
import { isTrustedSender } from './trust'

function broadcastToast(message: string): void {
  for (const ctx of getAllWindows()) {
    ctx.chrome.webContents.send('toast:show', { message, ts: Date.now() })
  }
}

export function registerMacroIpc(): void {
  ipcMain.handle(IPC.macro.list, (e) => {
    if (!isTrustedSender(e)) return []
    return listMacros()
  })

  ipcMain.handle(IPC.macro.get, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return null
    return getMacro(args.id)
  })

  ipcMain.handle(IPC.macro.save, async (e, args: Partial<Macro>) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return saveMacro(args)
  })

  ipcMain.handle(IPC.macro.remove, async (e, args: { id: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return removeMacro(args.id)
  })

  ipcMain.handle(IPC.macro.run, async (e, args: { id: string; windowId?: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    const tabId = args.windowId ? (listTabs(args.windowId).find((t) => t.active)?.id ?? null) : null
    const wc = tabId ? getWebContentsByTabId(tabId) : null
    return runMacro(args.id, {
      webContents: wc,
      toast: (msg) => broadcastToast(msg),
    })
  })

  macroEvents.on('changed', () => {
    const summaries = listMacros()
    for (const ctx of getAllWindows()) {
      ctx.chrome.webContents.send(IPC.macro.changed, summaries)
    }
    broadcastToInternalPages(IPC.macro.changed, summaries)
  })
}
