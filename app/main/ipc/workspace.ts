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
      // 2026-09-15 검증 중 실측: 창(특히 시크릿 창)을 닫은 직후 워크스페이스를 전환하면
      // ctx.chrome.webContents 가 undefined 가 되어(단순 isDestroyed() 가드로도 못 막음 —
      // extensions.ts 의 같은 가드도 "Cannot read properties of undefined (reading 'isDestroyed')"
      // 로 동일하게 죽는 것을 확인) ipcMain.handle('workspace:activate', ...) 자체가 reject 되고
      // 렌더러의 workspace.activate() 호출이 통째로 실패했다. downloads/index.ts 의 setProgressBar
      // 가드와 같은 방식(try/catch)으로 — 파괴된 창은 조용히 건너뛴다.
      try { ctx.chrome.webContents.send(IPC.workspace.changed, state) } catch { /* 파괴된 창 — 무시 */ }
    }
    broadcastToInternalPages(IPC.workspace.changed, state)
  })
}
