"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMacroIpc = registerMacroIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const automation_1 = require("../features/automation");
const tab_service_1 = require("../tabs/tab-service");
const window_service_1 = require("../windows/window-service");
const trust_1 = require("./trust");
function broadcastToast(message) {
    for (const ctx of (0, window_service_1.getAllWindows)()) {
        ctx.chrome.webContents.send('toast:show', { message, ts: Date.now() });
    }
}
function registerMacroIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.macro.list, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, automation_1.listMacros)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.macro.get, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return (0, automation_1.getMacro)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.macro.save, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, automation_1.saveMacro)(args);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.macro.remove, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, automation_1.removeMacro)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.macro.run, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        const tabId = args.windowId ? ((0, tab_service_1.listTabs)(args.windowId).find((t) => t.active)?.id ?? null) : null;
        const wc = tabId ? (0, tab_service_1.getWebContentsByTabId)(tabId) : null;
        return (0, automation_1.runMacro)(args.id, {
            webContents: wc,
            toast: (msg) => broadcastToast(msg),
        });
    });
    automation_1.macroEvents.on('changed', () => {
        const summaries = (0, automation_1.listMacros)();
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            ctx.chrome.webContents.send(ipc_channels_1.IPC.macro.changed, summaries);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.macro.changed, summaries);
    });
}
