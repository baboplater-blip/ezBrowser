"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerScreenshotIpc = registerScreenshotIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const screenshot_1 = require("../features/screenshot");
function registerScreenshotIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.screenshot.capture, (_e, { tabId, mode, rect }) => {
        if (mode === 'area' && rect)
            return (0, screenshot_1.captureArea)(tabId, rect);
        return (0, screenshot_1.captureViewport)(tabId);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.screenshot.saveToClipboard, (_e, { tabId }) => (0, screenshot_1.captureToClipboardOnly)(tabId));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.screenshot.saveToFile, (_e, { dataUrl }) => (0, screenshot_1.pickAndSaveScreenshot)(dataUrl));
}
