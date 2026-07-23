import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  createWorkspace, getActiveWorkspaceId, getState, listWorkspaces, removeWorkspace,
  reorderWorkspaces, setActiveWorkspace, updateWorkspace, workspaceEvents,
} from '../features/workspace'
import type { Workspace } from '../../shared/types'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { isTrustedSender } from './trust'

export function registerWorkspaceIpc(): void {
  ipcMain.handle(IPC.workspace.list, (e) => {
    if (!isTrustedSender(e)) return []
    return listWorkspaces()
  })
  ipcMain.handle(IPC.workspace.state, (e) => {
    if (!isTrustedSender(e)) return { workspaces: [], activeId: '' }
    return getState()
  })

  ipcMain.handle(IPC.workspace.activate, async (e, args: { id: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    await setActiveWorkspace(args.id)
    return getActiveWorkspaceId()
  })

  ipcMain.handle(IPC.workspace.create, async (e, args: Partial<Workspace>) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return createWorkspace(args)
  })

  ipcMain.handle(IPC.workspace.update, async (e, args: { id: string; patch: Partial<Workspace> }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return updateWorkspace(args.id, args.patch)
  })

  ipcMain.handle(IPC.workspace.remove, async (e, args: { id: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return removeWorkspace(args.id)
  })

  ipcMain.handle(IPC.workspace.reorder, async (e, args: { orderedIds: string[] }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    await reorderWorkspaces(args.orderedIds)
  })

  workspaceEvents.on('changed', () => {
    const state = getState()
    for (const ctx of getAllWindows()) {
      ctx.chrome.webContents.send(IPC.workspace.changed, state)
    }
    broadcastToInternalPages(IPC.workspace.changed, state)
  })
}
