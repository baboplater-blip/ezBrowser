import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { TabGroupColor } from '../../shared/types'
import {
  assignTabToGroup, createGroup, listGroups, removeGroup, setGroupCollapsed, updateGroup,
} from '../tabs/tab-service'

export function registerGroupsIpc(): void {
  ipcMain.handle(IPC.groups.list, (_e, { windowId }: { windowId: string }) =>
    listGroups(windowId))

  ipcMain.handle(IPC.groups.create, (_e, args: { windowId: string; title?: string; color?: TabGroupColor; tabIds?: string[] }) =>
    createGroup(args.windowId, { title: args.title, color: args.color, tabIds: args.tabIds }))

  ipcMain.handle(IPC.groups.update, (_e, args: { groupId: string; title?: string; color?: TabGroupColor }) => {
    updateGroup(args.groupId, { title: args.title, color: args.color })
  })

  ipcMain.handle(IPC.groups.remove, (_e, { groupId }: { groupId: string }) => {
    removeGroup(groupId)
  })

  ipcMain.handle(IPC.groups.setCollapsed, (_e, { groupId, collapsed }: { groupId: string; collapsed: boolean }) => {
    setGroupCollapsed(groupId, collapsed)
  })

  ipcMain.handle(IPC.groups.assignTab, (_e, { tabId, groupId }: { tabId: string; groupId: string | null }) => {
    assignTabToGroup(tabId, groupId)
  })
}
