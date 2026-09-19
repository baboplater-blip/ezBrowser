"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerExtensionsIpc = registerExtensionsIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const adapter_1 = require("../extensions/adapter");
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
function resolveWindowId(e, fallback = null) {
    const wc = electron_1.BrowserWindow.fromWebContents(e.sender);
    const ctxs = (0, window_service_1.getAllWindows)();
    for (const ctx of ctxs) {
        if (ctx.chrome.webContents.id === e.sender.id)
            return ctx.id;
        if (wc && ctx.win === wc)
            return ctx.id;
    }
    return fallback ?? ctxs[0]?.id ?? null;
}
function registerExtensionsIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.extensions.list, () => (0, adapter_1.listExtensions)());
    electron_1.ipcMain.handle(ipc_channels_1.IPC.extensions.installFromCrx, async (e, args = {}) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false, error: 'untrusted' };
        let filePath = args.path;
        if (!filePath) {
            const win = electron_1.BrowserWindow.fromWebContents(e.sender);
            const r = await electron_1.dialog.showOpenDialog(win ?? new electron_1.BrowserWindow({ show: false }), {
                title: '확장(.crx) 선택',
                filters: [{ name: 'Chrome Extension', extensions: ['crx', 'zip'] }],
                properties: ['openFile'],
            });
            if (r.canceled || r.filePaths.length === 0)
                return { ok: false, error: 'canceled' };
            filePath = r.filePaths[0];
        }
        if (!filePath)
            return { ok: false, error: 'no path' };
        return (0, adapter_1.installFromCrx)(filePath);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.extensions.installFromUrl, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false, error: 'untrusted' };
        if (!args?.url)
            return { ok: false, error: 'missing url' };
        return (0, adapter_1.installFromUrl)(args.url);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.extensions.remove, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false, error: 'untrusted' };
        return (0, adapter_1.removeExtension)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.extensions.setEnabled, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false, error: 'untrusted' };
        return (0, adapter_1.setExtensionEnabled)(args.id, args.enabled);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.extensions.openOptions, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false, error: 'untrusted' };
        const wid = args.windowId ?? resolveWindowId(e);
        if (!wid)
            return { ok: false, error: 'no window' };
        return (0, adapter_1.openExtensionOptions)(args.id, wid);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.extensions.invokeAction, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false, error: 'untrusted' };
        const wid = args.windowId ?? resolveWindowId(e);
        if (!wid)
            return { ok: false, error: 'no window' };
        return (0, adapter_1.invokeExtensionAction)(args.id, wid);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.extensions.importLocal, async (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false, error: 'untrusted' };
        const win = electron_1.BrowserWindow.fromWebContents(e.sender);
        const r = await electron_1.dialog.showOpenDialog(win ?? new electron_1.BrowserWindow({ show: false }), {
            title: 'unpacked 확장 폴더 선택',
            properties: ['openDirectory'],
        });
        if (r.canceled || r.filePaths.length === 0)
            return { ok: false, error: 'canceled' };
        const dir = r.filePaths[0];
        if (!dir)
            return { ok: false, error: 'no path' };
        return (0, adapter_1.importLocalUnpackedDir)(dir);
    });
    adapter_1.extensionEvents.on('changed', () => {
        void (0, adapter_1.listExtensions)().then((list) => broadcast(ipc_channels_1.IPC.extensions.changed, list));
    });
}
