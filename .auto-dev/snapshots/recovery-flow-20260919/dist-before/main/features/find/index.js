"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackFind = trackFind;
exports.startFind = startFind;
exports.stopFind = stopFind;
const ipc_channels_1 = require("../../../shared/ipc-channels");
const tab_service_1 = require("../../tabs/tab-service");
const window_service_1 = require("../../windows/window-service");
const findStates = new Map();
/**
 * 탭 webContents 에 found-in-page 리스너 부착. onTabCreated 훅에서 호출.
 * 결과는 해당 창의 외피(chrome) 로 푸시되어 FindBar 가 매치 수를 표시한다.
 */
function trackFind(wc, tabId) {
    const tab = (0, tab_service_1.getTab)(tabId);
    const windowId = tab?.windowId;
    if (!windowId)
        return;
    findStates.set(wc.id, { windowId, lastText: '' });
    wc.on('found-in-page', (_e, result) => {
        const ctx = (0, window_service_1.getWindow)(windowId);
        if (!ctx || ctx.chrome.webContents.isDestroyed())
            return;
        ctx.chrome.webContents.send(ipc_channels_1.IPC.find.result, {
            tabId,
            requestId: result.requestId,
            activeMatchOrdinal: result.activeMatchOrdinal,
            matches: result.matches,
            finalUpdate: result.finalUpdate,
        });
    });
    wc.once('destroyed', () => { findStates.delete(wc.id); });
}
/**
 * 페이지 내 텍스트 검색. 빈 문자열이면 검색 중단·하이라이트 해제.
 * @returns Electron 의 requestId (0 = 검색 중단)
 */
function startFind(tabId, text, opts = {}) {
    const wc = (0, tab_service_1.getWebContentsByTabId)(tabId);
    if (!wc || wc.isDestroyed())
        return 0;
    if (!text) {
        wc.stopFindInPage('clearSelection');
        const st = findStates.get(wc.id);
        if (st)
            st.lastText = '';
        return 0;
    }
    const st = findStates.get(wc.id);
    // 같은 텍스트면 findNext=true (다음/이전 매치로 이동), 새 텍스트면 새 검색
    const sameText = st?.lastText === text;
    if (st)
        st.lastText = text;
    return wc.findInPage(text, {
        forward: opts.forward ?? true,
        findNext: opts.findNext ?? sameText,
        matchCase: opts.matchCase ?? false,
    });
}
function stopFind(tabId, keepSelection = false) {
    const wc = (0, tab_service_1.getWebContentsByTabId)(tabId);
    if (!wc || wc.isDestroyed())
        return;
    wc.stopFindInPage(keepSelection ? 'keepSelection' : 'clearSelection');
    const st = findStates.get(wc.id);
    if (st)
        st.lastText = '';
}
