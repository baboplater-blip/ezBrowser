"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerUpdateIpc = registerUpdateIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const auto_update_1 = require("../features/auto-update");
const window_service_1 = require("../windows/window-service");
const trust_1 = require("./trust");
function broadcast(channel, payload) {
    for (const ctx of (0, window_service_1.getAllWindows)()) {
        if (!ctx.chrome.webContents.isDestroyed()) {
            ctx.chrome.webContents.send(channel, payload);
        }
    }
    (0, window_service_1.broadcastToInternalPages)(channel, payload);
}
function registerUpdateIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.update.status, () => (0, auto_update_1.getStatus)());
    electron_1.ipcMain.handle(ipc_channels_1.IPC.update.check, (e) => { if (!(0, trust_1.isTrustedSender)(e))
        return; return (0, auto_update_1.checkForUpdates)(false); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.update.download, (e) => { if (!(0, trust_1.isTrustedSender)(e))
        return; return (0, auto_update_1.downloadUpdate)(); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.update.install, (e) => { if (!(0, trust_1.isTrustedSender)(e))
        return; (0, auto_update_1.quitAndInstall)(); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.update.setChannel, (e, { channel }) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        (0, auto_update_1.setChannel)(channel);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.update.setAutoDownload, (e, { enabled }) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        (0, auto_update_1.setAutoDownload)(enabled);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.update.setAutoCheck, (e, { enabled }) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        (0, auto_update_1.setAutoCheck)(enabled);
    });
    auto_update_1.updateEvents.on('status', (status) => broadcast(ipc_channels_1.IPC.update.status, status));
}
