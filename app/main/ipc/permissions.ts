import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  clearAllPermissions, clearOrigin, listPermissions, permissionEvents, setPermission,
  type PermDecision,
} from '../storage/permissions'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { resolvePermissionPrompt } from '../session-bootstrap'
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

  // 외피의 PermissionPrompt.tsx 가 사용자의 허용/차단(+기억 여부)을 알려준다.
  ipcMain.handle(IPC.permissions.promptRespond, (e, args: { promptId: string; allow: boolean; remember: boolean }) => {
    if (!isTrustedSender(e)) return
    resolvePermissionPrompt(args.promptId, args.allow, args.remember)
  })

  permissionEvents.on('changed', () => {
    const list = listPermissions()
    for (const ctx of getAllWindows()) {
      if (!ctx.chrome.webContents.isDestroyed()) ctx.chrome.webContents.send(IPC.permissions.changed, list)
    }
    broadcastToInternalPages(IPC.permissions.changed, list)
  })
}
