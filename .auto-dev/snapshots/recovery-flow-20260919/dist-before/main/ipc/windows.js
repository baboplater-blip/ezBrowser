"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerWindowsIpc = registerWindowsIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const window_service_1 = require("../windows/window-service");
const tab_service_1 = require("../tabs/tab-service");
function registerWindowsIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.windows.setChromeHeight, (_e, args) => {
        (0, window_service_1.setChromeHeight)(args.windowId, args.height);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.windows.setShellInsets, (_e, args) => {
        (0, window_service_1.setShellInsets)(args.windowId, args);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.windows.setPaneSplitRatio, (_e, args) => {
        (0, tab_service_1.setPaneSplitRatio)(args.windowId, args.ratio);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.windows.focusPane, (_e, args) => {
        (0, tab_service_1.focusPaneByIndex)(args.windowId, args.idx);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.windows.beginPaneDrag, (_e, args) => {
        (0, tab_service_1.beginPaneDrag)(args.windowId);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.windows.endPaneDrag, (_e, args) => {
        (0, tab_service_1.endPaneDrag)(args.windowId);
    });
}
