"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerHistoryIpc = registerHistoryIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const history_1 = require("../storage/history");
const window_service_1 = require("../windows/window-service");
const trust_1 = require("./trust");
function registerHistoryIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.history.recent, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, history_1.recentVisits)(args?.limit);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.history.search, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        if (!args.query)
            return [];
        return (0, history_1.searchHistory)(args.query, args.limit);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.history.topSites, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, history_1.topSites)(args?.limit);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.history.remove, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        if (typeof args.id === 'number')
            (0, history_1.removeHistoryById)(args.id);
        else if (args.url)
            (0, history_1.removeHistoryByUrl)(args.url);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.history.clear, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        (0, history_1.clearHistory)(args);
    });
    history_1.historyEvents.on('changed', () => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            ctx.chrome.webContents.send(ipc_channels_1.IPC.history.changed);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.history.changed);
    });
}
