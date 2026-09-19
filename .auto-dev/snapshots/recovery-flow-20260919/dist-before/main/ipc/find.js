"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFindIpc = registerFindIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const find_1 = require("../features/find");
const page_tools_1 = require("../features/page-tools");
function registerFindIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.find.start, (_e, { tabId, text, options }) => (0, find_1.startFind)(tabId, text, options ?? {}));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.find.stop, (_e, { tabId, keepSelection }) => {
        (0, find_1.stopFind)(tabId, keepSelection === true);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.page.print, (_e, { tabId }) => (0, page_tools_1.printTab)(tabId));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.page.printToPdf, (_e, { tabId }) => (0, page_tools_1.printTabToPdf)(tabId));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.page.zoomGet, (_e, { tabId }) => (0, page_tools_1.getZoom)(tabId));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.page.zoomSet, (_e, { tabId, delta }) => (0, page_tools_1.adjustZoom)(tabId, delta));
}
