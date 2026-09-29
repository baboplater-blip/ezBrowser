"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerUserChromeIpc = registerUserChromeIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const userchrome_1 = require("../features/userchrome");
function registerUserChromeIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.userchrome.get, () => (0, userchrome_1.getUserChromeState)());
    electron_1.ipcMain.handle(ipc_channels_1.IPC.userchrome.update, (_e, { kind, content }) => (0, userchrome_1.updateUserChrome)(kind, content));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.userchrome.reload, () => (0, userchrome_1.reloadUserChrome)());
    electron_1.ipcMain.handle(ipc_channels_1.IPC.userchrome.open, (_e, { kind }) => (0, userchrome_1.openUserChromeInEditor)(kind));
}
