"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerUserscriptIpc = registerUserscriptIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const userscript_1 = require("../features/userscript");
const window_service_1 = require("../windows/window-service");
const trust_1 = require("./trust");
function registerUserscriptIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.userscript.list, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, userscript_1.listUserscripts)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.userscript.get, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return (0, userscript_1.getUserscript)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.userscript.save, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, userscript_1.saveUserscript)(args);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.userscript.remove, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        await (0, userscript_1.removeUserscript)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.userscript.setEnabled, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        await (0, userscript_1.setUserscriptEnabled)(args.id, args.enabled);
    });
    userscript_1.userscriptEvents.on('changed', () => {
        const summaries = (0, userscript_1.listUserscripts)();
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            ctx.chrome.webContents.send(ipc_channels_1.IPC.userscript.changed, summaries);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.userscript.changed, summaries);
    });
}
