"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerReadLaterIpc = registerReadLaterIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const readlater_1 = require("../storage/readlater");
const window_service_1 = require("../windows/window-service");
const trust_1 = require("./trust");
function registerReadLaterIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.readlater.list, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, readlater_1.listReadLater)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.readlater.add, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return (0, readlater_1.addReadLater)(args);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.readlater.remove, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        (0, readlater_1.removeReadLater)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.readlater.setRead, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        (0, readlater_1.setReadLaterRead)(args.id, args.read);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.readlater.clearRead, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        (0, readlater_1.clearReadReadLater)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.readlater.isSaved, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return false;
        return (0, readlater_1.isReadLaterSaved)(args.url);
    });
    readlater_1.readlaterEvents.on('changed', () => {
        const items = (0, readlater_1.listReadLater)();
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            if (!ctx.chrome.webContents.isDestroyed())
                ctx.chrome.webContents.send(ipc_channels_1.IPC.readlater.changed, items);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.readlater.changed, items);
    });
}
