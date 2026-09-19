"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.printTab = printTab;
exports.printTabToPdf = printTabToPdf;
exports.trackZoom = trackZoom;
exports.adjustZoom = adjustZoom;
exports.getZoom = getZoom;
const electron_1 = require("electron");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const safe_store_1 = require("../../storage/safe-store");
const tab_service_1 = require("../../tabs/tab-service");
const window_service_1 = require("../../windows/window-service");
function sanitizeFilename(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80).trim() || 'page';
}
/** 시스템 인쇄 대화상자 열기 */
function printTab(tabId) {
    const wc = (0, tab_service_1.getWebContentsByTabId)(tabId);
    if (!wc || wc.isDestroyed())
        return { ok: false, error: 'no-webcontents' };
    try {
        wc.print({}, (success, failureReason) => {
            if (!success)
                console.warn('[page-tools] print failed:', failureReason);
        });
        return { ok: true };
    }
    catch (err) {
        console.warn('[page-tools] print error', err);
        return { ok: false, error: String(err) };
    }
}
/** 페이지를 PDF 로 저장 (저장 위치 선택 대화상자) */
async function printTabToPdf(tabId) {
    const wc = (0, tab_service_1.getWebContentsByTabId)(tabId);
    if (!wc || wc.isDestroyed())
        return { ok: false, error: 'no-webcontents' };
    const tab = (0, tab_service_1.getTab)(tabId);
    const win = tab?.windowId ? (0, window_service_1.getWindow)(tab.windowId)?.win : undefined;
    const baseName = sanitizeFilename(tab?.title || 'page');
    const defaultPath = node_path_1.default.join(electron_1.app.getPath('downloads'), `${baseName}.pdf`);
    try {
        const result = win
            ? await electron_1.dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
            : await electron_1.dialog.showSaveDialog({ defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
        if (result.canceled || !result.filePath)
            return { ok: false, error: 'canceled' };
        const data = await wc.printToPDF({ printBackground: true, pageSize: 'A4' });
        await (0, promises_1.writeFile)(result.filePath, data);
        return { ok: true, path: result.filePath };
    }
    catch (err) {
        console.warn('[page-tools] printToPDF error', err);
        return { ok: false, error: String(err) };
    }
}
// ===== 사이트별 줌 저장 =====
const ZOOM_MIN = -3;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.5;
const zoomStore = (0, safe_store_1.createStore)({ name: 'zoom', defaults: { levels: {} } });
function originOf(url) {
    try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
            return null;
        return u.origin;
    }
    catch {
        return null;
    }
}
function savedZoomFor(origin) {
    const levels = zoomStore.get('levels');
    return typeof levels[origin] === 'number' ? levels[origin] : 0;
}
function persistZoom(origin, level) {
    const levels = { ...zoomStore.get('levels') };
    if (Math.abs(level) < 0.001)
        delete levels[origin];
    else
        levels[origin] = level;
    zoomStore.set('levels', levels);
}
/** 탭 webContents 에 줌 복원 부착. 같은 origin 재방문 시 저장된 배율 자동 적용. onTabCreated 훅에서 호출. */
function trackZoom(wc, _tabId) {
    const apply = () => {
        if (wc.isDestroyed())
            return;
        try {
            const origin = originOf(wc.getURL());
            const level = origin ? savedZoomFor(origin) : 0;
            wc.setZoomLevel(level);
        }
        catch { /* destroyed mid-call */ }
    };
    wc.on('did-finish-load', apply);
    wc.on('did-navigate', apply);
    wc.once('destroyed', () => {
        wc.off('did-finish-load', apply);
        wc.off('did-navigate', apply);
    });
}
/** 줌 단계 조정 (delta: +1 확대 / -1 축소 / 0 초기화) 후 origin 별 저장 */
function adjustZoom(tabId, delta) {
    const wc = (0, tab_service_1.getWebContentsByTabId)(tabId);
    if (!wc || wc.isDestroyed())
        return null;
    const cur = wc.getZoomLevel();
    let next = delta === 0 ? 0 : cur + delta * ZOOM_STEP;
    next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    wc.setZoomLevel(next);
    const origin = originOf(wc.getURL());
    if (origin)
        persistZoom(origin, next);
    return { level: next, factor: wc.getZoomFactor() };
}
function getZoom(tabId) {
    const wc = (0, tab_service_1.getWebContentsByTabId)(tabId);
    if (!wc || wc.isDestroyed())
        return null;
    return { level: wc.getZoomLevel(), factor: wc.getZoomFactor() };
}
