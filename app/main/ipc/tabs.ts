import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  activateTab, captureTab, closeTab, createTab, duplicateTab, listTabs,
  navigateTab, pinTab, reorderTabs, restoreLastClosed,
  tabBack, tabForward, tabReload, tabStop, setTabMuted,
  listRecentlyClosed, reopenClosedById, clearRecentlyClosed,
} from '../tabs/tab-service'

export function registerTabsIpc(): void {
  ipcMain.handle(IPC.tabs.create, (_e, { windowId, url, background }: { windowId: string; url?: string; background?: boolean }) =>
    createTab({ windowId, url, background }))

  ipcMain.handle(IPC.tabs.list, (_e, { windowId }: { windowId: string }) =>
    listTabs(windowId))

  ipcMain.handle(IPC.tabs.activate, (_e, { tabId }: { tabId: string }) => {
    activateTab(tabId)
  })

  ipcMain.handle(IPC.tabs.close, (_e, { tabId }: { tabId: string }) => {
    closeTab(tabId)
  })

  ipcMain.handle(IPC.tabs.reorder, (_e, { windowId, orderedIds }: { windowId: string; orderedIds: string[] }) => {
    reorderTabs(windowId, orderedIds)
  })

  ipcMain.handle(IPC.tabs.pin, (_e, { tabId, pinned }: { tabId: string; pinned: boolean }) => {
    pinTab(tabId, pinned)
  })

  ipcMain.handle(IPC.tabs.duplicate, (_e, { tabId }: { tabId: string }) =>
    duplicateTab(tabId))

  ipcMain.handle(IPC.tabs.restore, (_e, { windowId }: { windowId: string }) =>
    restoreLastClosed(windowId))

  ipcMain.handle(IPC.tabs.navigate, (_e, { tabId, url }: { tabId: string; url: string }) => {
    navigateTab(tabId, url)
  })

  ipcMain.handle(IPC.tabs.back, (_e, { tabId }: { tabId: string }) => tabBack(tabId))
  ipcMain.handle(IPC.tabs.forward, (_e, { tabId }: { tabId: string }) => tabForward(tabId))
  ipcMain.handle(IPC.tabs.reload, (_e, { tabId }: { tabId: string }) => tabReload(tabId))
  ipcMain.handle(IPC.tabs.stop, (_e, { tabId }: { tabId: string }) => tabStop(tabId))
  ipcMain.handle(IPC.tabs.setMuted, (_e, { tabId, muted }: { tabId: string; muted: boolean }) => setTabMuted(tabId, muted))

  ipcMain.handle(IPC.tabs.capture, (_e, { tabId }: { tabId: string }) => captureTab(tabId))

  ipcMain.handle(IPC.recentClosed.list, (_e, args?: { limit?: number }) =>
    listRecentlyClosed(args?.limit))
  ipcMain.handle(IPC.recentClosed.reopen, (_e, { id, windowId }: { id: number; windowId: string }) =>
    reopenClosedById(id, windowId))
  ipcMain.handle(IPC.recentClosed.clear, () => { clearRecentlyClosed() })
}
