"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerModIpc = registerModIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const mod_api_1 = require("../features/mod-api");
const window_service_1 = require("../windows/window-service");
const trust_1 = require("./trust");
function registerModIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.mod.list, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, mod_api_1.listMods)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.mod.setEnabled, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, mod_api_1.setModEnabled)(args.id, args.enabled);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.mod.reload, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, mod_api_1.reloadMod)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.mod.remove, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, mod_api_1.removeMod)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.mod.menuList, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, mod_api_1.listMenuItemsMeta)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.mod.menuInvoke, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, mod_api_1.invokeMenuItem)(args.id);
    });
    mod_api_1.modEvents.on('changed', () => {
        const summaries = (0, mod_api_1.listMods)();
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            ctx.chrome.webContents.send(ipc_channels_1.IPC.mod.changed, summaries);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.mod.changed, summaries);
    });
}
