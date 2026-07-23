import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  clearAllPermissions, clearOrigin, listPermissions, permissionEvents, setPermission,
  type PermDecision,
} from '../storage/permissions'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { isTrustedSender } from './trust'

export function registerPermissionsIpc(): void {
  ipcMain.handle(IPC.permissions.list, (e) => {
    if (!isTrustedSender(e)) return []
    return listPermissions()
  })

  ipcMain.handle(IPC.permissions.set, (e, args: { origin: string; permission: string; decision: PermDecision | 'default' }) => {
    if (!isTrustedSender(e)) return
    setPermission(args.origin, args.permission, args.decision)
  })

  ipcMain.handle(IPC.permissions.clearOrigin, (e, args: { origin: string }) => {
    if (!isTrustedSender(e)) return
    clearOrigin(args.origin)
  })

  ipcMain.handle(IPC.permissions.clearAll, (e) => {
    if (!isTrustedSender(e)) return
    clearAllPermissions()
  })

  permissionEvents.on('changed', () => {
    const list = listPermissions()
    for (const ctx of getAllWindows()) {
      if (!ctx.chrome.webContents.isDestroyed()) ctx.chrome.webContents.send(IPC.permissions.changed, list)
    }
    broadcastToInternalPages(IPC.permissions.changed, list)
  })
}
