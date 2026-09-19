"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTabsIpc = registerTabsIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const tab_service_1 = require("../tabs/tab-service");
function registerTabsIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tabs.create, (_e, { windowId, url, background }) => (0, tab_service_1.createTab)({ windowId, url, background }));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tabs.list, (_e, { windowId }) => (0, tab_service_1.listTabs)(windowId));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tabs.activate, (_e, { tabId }) => {
        (0, tab_service_1.activateTab)(tabId);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tabs.close, (_e, { tabId }) => {
        (0, tab_service_1.closeTab)(tabId);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tabs.reorder, (_e, { windowId, orderedIds }) => {
        (0, tab_service_1.reorderTabs)(windowId, orderedIds);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tabs.pin, (_e, { tabId, pinned }) => {
        (0, tab_service_1.pinTab)(tabId, pinned);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tabs.duplicate, (_e, { tabId }) => (0, tab_service_1.duplicateTab)(tabId));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tabs.restore, (_e, { windowId }) => (0, tab_service_1.restoreLastClosed)(windowId));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tabs.navigate, (_e, { tabId, url }) => {
        (0, tab_service_1.navigateTab)(tabId, url);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tabs.back, (_e, { tabId }) => (0, tab_service_1.tabBack)(tabId));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tabs.forward, (_e, { tabId }) => (0, tab_service_1.tabForward)(tabId));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tabs.reload, (_e, { tabId }) => (0, tab_service_1.tabReload)(tabId));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tabs.stop, (_e, { tabId }) => (0, tab_service_1.tabStop)(tabId));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tabs.setMuted, (_e, { tabId, muted }) => (0, tab_service_1.setTabMuted)(tabId, muted));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tabs.capture, (_e, { tabId }) => (0, tab_service_1.captureTab)(tabId));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.recentClosed.list, (_e, args) => (0, tab_service_1.listRecentlyClosed)(args?.limit));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.recentClosed.reopen, (_e, { id, windowId }) => (0, tab_service_1.reopenClosedById)(id, windowId));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.recentClosed.clear, () => { (0, tab_service_1.clearRecentlyClosed)(); });
}
