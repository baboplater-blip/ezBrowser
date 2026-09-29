"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.captureViewport = captureViewport;
exports.captureArea = captureArea;
exports.captureToClipboardOnly = captureToClipboardOnly;
exports.pickAndSaveScreenshot = pickAndSaveScreenshot;
const electron_1 = require("electron");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const tab_service_1 = require("../../tabs/tab-service");
function timestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
async function defaultPicturesPath() {
    const dir = node_path_1.default.join(electron_1.app.getPath('pictures'), 'ezBrowser');
    await (0, promises_1.mkdir)(dir, { recursive: true });
    return dir;
}
async function captureViewport(tabId, options) {
    const wc = (0, tab_service_1.getWebContentsByTabId)(tabId);
    if (!wc)
        return null;
    const img = await wc.capturePage();
    return saveImage(img, options);
}
async function captureArea(tabId, rect, options) {
    const wc = (0, tab_service_1.getWebContentsByTabId)(tabId);
    if (!wc)
        return null;
    const img = await wc.capturePage(rect);
    return saveImage(img, options);
}
async function saveImage(img, options) {
    electron_1.clipboard.writeImage(img);
    if (options?.silent)
        return null;
    const dir = await defaultPicturesPath();
    const file = node_path_1.default.join(dir, `screenshot-${timestamp()}.png`);
    await (0, promises_1.writeFile)(file, img.toPNG());
    return file;
}
async function captureToClipboardOnly(tabId) {
    const wc = (0, tab_service_1.getWebContentsByTabId)(tabId);
    if (!wc)
        return false;
    const img = await wc.capturePage();
    electron_1.clipboard.writeImage(img);
    return true;
}
async function pickAndSaveScreenshot(dataUrl) {
    const img = electron_1.nativeImage.createFromDataURL(dataUrl);
    const result = await electron_1.dialog.showSaveDialog({
        title: '스크린샷 저장',
        defaultPath: node_path_1.default.join(electron_1.app.getPath('pictures'), `screenshot-${timestamp()}.png`),
        filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath)
        return null;
    await (0, promises_1.writeFile)(result.filePath, img.toPNG());
    return result.filePath;
}
