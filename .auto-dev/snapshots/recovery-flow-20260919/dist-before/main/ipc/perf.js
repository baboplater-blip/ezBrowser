"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPerfIpc = registerPerfIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const perf_1 = require("../features/perf");
const window_service_1 = require("../windows/window-service");
function broadcast(channel, payload) {
    for (const ctx of (0, window_service_1.getAllWindows)()) {
        if (!ctx.chrome.webContents.isDestroyed()) {
            ctx.chrome.webContents.send(channel, payload);
        }
    }
    (0, window_service_1.broadcastToInternalPages)(channel, payload);
}
function registerPerfIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.perf.report, () => (0, perf_1.getReport)());
    perf_1.perfEvents.on('milestone', (m) => broadcast(ipc_channels_1.IPC.perf.milestone, m));
}
