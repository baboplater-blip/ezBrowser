"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAdblockIpc = registerAdblockIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const adblock_1 = require("../features/adblock");
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
function registerAdblockIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.adblock.stats, () => (0, adblock_1.getAdblockStats)());
    electron_1.ipcMain.handle(ipc_channels_1.IPC.adblock.setLevel, (e, { level }) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        return (0, adblock_1.setAdblockLevel)(level);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.adblock.setEnabled, (e, { enabled }) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        return (0, adblock_1.setAdblockEnabled)(enabled);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.adblock.setFilter, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        return (0, adblock_1.setAdblockFilter)(args.id, args.enabled);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.adblock.setSiteAllowed, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        return (0, adblock_1.setSiteAllowed)(args.host, args.allowed);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.adblock.toggleSite, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        return (0, adblock_1.toggleSiteAllowed)(args.url);
    });
    adblock_1.adblockEvents.on('changed', () => {
        broadcast(ipc_channels_1.IPC.adblock.changed, (0, adblock_1.getAdblockStats)());
    });
}
