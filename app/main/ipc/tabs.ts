import { IPC } from '../../shared/ipc-channels'
import {
  activateTab, captureTab, closeTab, createTab, duplicateTab, listTabs,
  navigateTab, pinTab, reorderTabs, restoreLastClosed,
  tabBack, tabForward, tabReload, tabStop, setTabMuted,
  listRecentlyClosed, reopenClosedById, clearRecentlyClosed,
} from '../tabs/tab-service'
import { handleTrusted } from './trust'

export function registerTabsIpc(): void {
  handleTrusted(IPC.tabs.create, (_e, { windowId, url, background }: { windowId: string; url?: string; background?: boolean }) =>
    createTab({ windowId, url, background }))

  handleTrusted(IPC.tabs.list, (_e, { windowId }: { windowId: string }) =>
    listTabs(windowId))

  handleTrusted(IPC.tabs.activate, (_e, { tabId }: { tabId: string }) => {
    activateTab(tabId)
  })

  handleTrusted(IPC.tabs.close, (_e, { tabId }: { tabId: string }) => {
    closeTab(tabId)
  })

  handleTrusted(IPC.tabs.reorder, (_e, { windowId, orderedIds }: { windowId: string; orderedIds: string[] }) => {
    reorderTabs(windowId, orderedIds)
  })

  handleTrusted(IPC.tabs.pin, (_e, { tabId, pinned }: { tabId: string; pinned: boolean }) => {
    pinTab(tabId, pinned)
  })

  handleTrusted(IPC.tabs.duplicate, (_e, { tabId }: { tabId: string }) =>
    duplicateTab(tabId))

  handleTrusted(IPC.tabs.restore, (_e, { windowId }: { windowId: string }) =>
    restoreLastClosed(windowId))

  handleTrusted(IPC.tabs.navigate, (_e, { tabId, url }: { tabId: string; url: string }) => {
    navigateTab(tabId, url)
  })

  handleTrusted(IPC.tabs.back, (_e, { tabId }: { tabId: string }) => tabBack(tabId))
  handleTrusted(IPC.tabs.forward, (_e, { tabId }: { tabId: string }) => tabForward(tabId))
  handleTrusted(IPC.tabs.reload, (_e, { tabId }: { tabId: string }) => tabReload(tabId))
  handleTrusted(IPC.tabs.stop, (_e, { tabId }: { tabId: string }) => tabStop(tabId))
  handleTrusted(IPC.tabs.setMuted, (_e, { tabId, muted }: { tabId: string; muted: boolean }) => setTabMuted(tabId, muted))

  handleTrusted(IPC.tabs.capture, (_e, { tabId }: { tabId: string }) => captureTab(tabId))

  handleTrusted(IPC.recentClosed.list, (_e, args?: { limit?: number }) =>
    listRecentlyClosed(args?.limit))
  handleTrusted(IPC.recentClosed.reopen, (_e, { id, windowId }: { id: number; windowId: string }) =>
    reopenClosedById(id, windowId))
  handleTrusted(IPC.recentClosed.clear, () => { clearRecentlyClosed() })
}
