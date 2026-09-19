"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerGroupsIpc = registerGroupsIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const tab_service_1 = require("../tabs/tab-service");
function registerGroupsIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.groups.list, (_e, { windowId }) => (0, tab_service_1.listGroups)(windowId));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.groups.create, (_e, args) => (0, tab_service_1.createGroup)(args.windowId, { title: args.title, color: args.color, tabIds: args.tabIds }));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.groups.update, (_e, args) => {
        (0, tab_service_1.updateGroup)(args.groupId, { title: args.title, color: args.color });
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.groups.remove, (_e, { groupId }) => {
        (0, tab_service_1.removeGroup)(groupId);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.groups.setCollapsed, (_e, { groupId, collapsed }) => {
        (0, tab_service_1.setGroupCollapsed)(groupId, collapsed);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.groups.assignTab, (_e, { tabId, groupId }) => {
        (0, tab_service_1.assignTabToGroup)(tabId, groupId);
    });
}
