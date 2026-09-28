import { IPC } from '../../shared/ipc-channels'
import type { TabGroupColor } from '../../shared/types'
import {
  assignTabToGroup, createGroup, listGroups, removeGroup, setGroupCollapsed, updateGroup,
} from '../tabs/tab-service'
import { handleTrusted } from './trust'

export function registerGroupsIpc(): void {
  handleTrusted(IPC.groups.list, (_e, { windowId }: { windowId: string }) =>
    listGroups(windowId))

  handleTrusted(IPC.groups.create, (_e, args: { windowId: string; title?: string; color?: TabGroupColor; tabIds?: string[] }) =>
    createGroup(args.windowId, { title: args.title, color: args.color, tabIds: args.tabIds }))

  handleTrusted(IPC.groups.update, (_e, args: { groupId: string; title?: string; color?: TabGroupColor }) => {
    updateGroup(args.groupId, { title: args.title, color: args.color })
  })

  handleTrusted(IPC.groups.remove, (_e, { groupId }: { groupId: string }) => {
    removeGroup(groupId)
  })

  handleTrusted(IPC.groups.setCollapsed, (_e, { groupId, collapsed }: { groupId: string; collapsed: boolean }) => {
    setGroupCollapsed(groupId, collapsed)
  })

  handleTrusted(IPC.groups.assignTab, (_e, { tabId, groupId }: { tabId: string; groupId: string | null }) => {
    assignTabToGroup(tabId, groupId)
  })
}
