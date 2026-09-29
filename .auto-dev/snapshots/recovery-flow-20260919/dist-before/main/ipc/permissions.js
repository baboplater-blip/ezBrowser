"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPermissionsIpc = registerPermissionsIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const permissions_1 = require("../storage/permissions");
const window_service_1 = require("../windows/window-service");
const trust_1 = require("./trust");
function registerPermissionsIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.permissions.list, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, permissions_1.listPermissions)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.permissions.set, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        (0, permissions_1.setPermission)(args.origin, args.permission, args.decision);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.permissions.clearOrigin, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        (0, permissions_1.clearOrigin)(args.origin);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.permissions.clearAll, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        (0, permissions_1.clearAllPermissions)();
    });
    permissions_1.permissionEvents.on('changed', () => {
        const list = (0, permissions_1.listPermissions)();
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            if (!ctx.chrome.webContents.isDestroyed())
                ctx.chrome.webContents.send(ipc_channels_1.IPC.permissions.changed, list);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.permissions.changed, list);
    });
}
