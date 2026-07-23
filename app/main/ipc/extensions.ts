import { ipcMain, dialog, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  extensionEvents, importLocalUnpackedDir, installFromCrx, installFromUrl,
  invokeExtensionAction, listExtensions, openExtensionOptions, removeExtension,
  setExtensionEnabled,
} from '../extensions/adapter'
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

function resolveWindowId(e: IpcMainInvokeEvent, fallback: string | null = null): string | null {
  const wc = BrowserWindow.fromWebContents(e.sender)
  const ctxs = getAllWindows()
  for (const ctx of ctxs) {
    if (ctx.chrome.webContents.id === e.sender.id) return ctx.id
    if (wc && ctx.win === (wc as unknown as Electron.BaseWindow)) return ctx.id
  }
  return fallback ?? ctxs[0]?.id ?? null
}

export function registerExtensionsIpc(): void {
  ipcMain.handle(IPC.extensions.list, () => listExtensions())

  ipcMain.handle(IPC.extensions.installFromCrx, async (e, args: { path?: string } = {}) => {
    if (!isTrustedSender(e)) return { ok: false, error: 'untrusted' }
    let filePath = args.path
    if (!filePath) {
      const win = BrowserWindow.fromWebContents(e.sender)
      const r = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
        title: '확장(.crx) 선택',
        filters: [{ name: 'Chrome Extension', extensions: ['crx', 'zip'] }],
        properties: ['openFile'],
      })
      if (r.canceled || r.filePaths.length === 0) return { ok: false, error: 'canceled' }
      filePath = r.filePaths[0]
    }
    if (!filePath) return { ok: false, error: 'no path' }
    return installFromCrx(filePath)
  })

  ipcMain.handle(IPC.extensions.installFromUrl, (e, args: { url: string }) => {
    if (!isTrustedSender(e)) return { ok: false, error: 'untrusted' }
    if (!args?.url) return { ok: false, error: 'missing url' }
    return installFromUrl(args.url)
  })

  ipcMain.handle(IPC.extensions.remove, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return { ok: false, error: 'untrusted' }
    return removeExtension(args.id)
  })

  ipcMain.handle(IPC.extensions.setEnabled, (e, args: { id: string; enabled: boolean }) => {
    if (!isTrustedSender(e)) return { ok: false, error: 'untrusted' }
    return setExtensionEnabled(args.id, args.enabled)
  })

  ipcMain.handle(IPC.extensions.openOptions, (e, args: { id: string; windowId?: string }) => {
    if (!isTrustedSender(e)) return { ok: false, error: 'untrusted' }
    const wid = args.windowId ?? resolveWindowId(e)
    if (!wid) return { ok: false, error: 'no window' }
    return openExtensionOptions(args.id, wid)
  })

  ipcMain.handle(IPC.extensions.invokeAction, (e, args: { id: string; windowId?: string }) => {
    if (!isTrustedSender(e)) return { ok: false, error: 'untrusted' }
    const wid = args.windowId ?? resolveWindowId(e)
    if (!wid) return { ok: false, error: 'no window' }
    return invokeExtensionAction(args.id, wid)
  })

  ipcMain.handle(IPC.extensions.importLocal, async (e) => {
    if (!isTrustedSender(e)) return { ok: false, error: 'untrusted' }
    const win = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      title: 'unpacked 확장 폴더 선택',
      properties: ['openDirectory'],
    })
    if (r.canceled || r.filePaths.length === 0) return { ok: false, error: 'canceled' }
    const dir = r.filePaths[0]
    if (!dir) return { ok: false, error: 'no path' }
    return importLocalUnpackedDir(dir)
  })

  extensionEvents.on('changed', () => {
    void listExtensions().then((list) => broadcast(IPC.extensions.changed, list))
  })
}
