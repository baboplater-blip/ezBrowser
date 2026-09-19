"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackContextMenu = trackContextMenu;
const electron_1 = require("electron");
const electron_2 = require("electron");
const ipc_channels_1 = require("../../../shared/ipc-channels");
const tab_service_1 = require("../../tabs/tab-service");
const search_engines_1 = require("../../storage/search-engines");
const bookmarks_1 = require("../../storage/bookmarks");
const find_1 = require("../find");
const window_service_1 = require("../../windows/window-service");
const mod_api_1 = require("../mod-api");
const video_download_1 = require("../video-download");
const SEARCH_LABEL_MAX = 24;
function truncate(text, max) {
    const t = text.trim().replace(/\s+/g, ' ');
    return t.length > max ? `${t.slice(0, max)}…` : t;
}
/**
 * 원격 이미지를 다운로드해 클립보드에 복사. data:/blob: 은 직접 처리.
 */
async function copyImageToClipboard(srcUrl) {
    try {
        if (srcUrl.startsWith('data:')) {
            const img = electron_1.nativeImage.createFromDataURL(srcUrl);
            if (!img.isEmpty())
                electron_1.clipboard.writeImage(img);
            return;
        }
        const res = await electron_2.net.fetch(srcUrl);
        const buf = Buffer.from(await res.arrayBuffer());
        const img = electron_1.nativeImage.createFromBuffer(buf);
        if (!img.isEmpty())
            electron_1.clipboard.writeImage(img);
    }
    catch (err) {
        console.warn('[context-menu] copy image failed', err);
    }
}
function buildTemplate(wc, tabId, windowId, params) {
    const template = [];
    const sep = () => { template.push({ type: 'separator' }); };
    // ===== 링크 =====
    if (params.linkURL) {
        const link = params.linkURL;
        template.push({ label: '새 탭에서 링크 열기', click: () => { (0, tab_service_1.createTab)({ windowId, url: link, background: true }); } }, { label: '새 창에서 링크 열기', click: () => { (0, tab_service_1.createTab)({ windowId, url: link }); } }, { label: '링크 주소 복사', click: () => electron_1.clipboard.writeText(link) });
        if (params.linkText) {
            template.push({ label: '링크 텍스트 복사', click: () => electron_1.clipboard.writeText(params.linkText) });
        }
        sep();
    }
    // ===== 이미지 =====
    if (params.mediaType === 'image' && params.srcURL) {
        const src = params.srcURL;
        template.push({ label: '새 탭에서 이미지 열기', click: () => { (0, tab_service_1.createTab)({ windowId, url: src, background: true }); } }, { label: '이미지 복사', click: () => { void copyImageToClipboard(src); } }, { label: '이미지 주소 복사', click: () => electron_1.clipboard.writeText(src) }, { label: '이미지 다운로드', click: () => wc.downloadURL(src) });
        sep();
    }
    // ===== 동영상/오디오 =====
    if (params.mediaType === 'video' || params.mediaType === 'audio') {
        const src = params.srcURL || '';
        template.push({
            label: '동영상 다운로드',
            click: () => {
                // 스트림(HLS/blob)·직접 파일을 자동 판별해 yt-dlp/직접 다운로드로 라우팅
                void (0, video_download_1.handleOverlayDownload)({ videoSrc: src, pageUrl: wc.getURL(), senderWcId: wc.id });
            },
        });
        if (src && !src.startsWith('blob:')) {
            template.push({ label: '미디어 주소 복사', click: () => electron_1.clipboard.writeText(src) });
        }
        sep();
    }
    // ===== 선택 텍스트 =====
    if (params.selectionText && params.selectionText.trim()) {
        const sel = params.selectionText.trim();
        template.push({ label: '복사', role: 'copy', enabled: params.editFlags.canCopy });
        const engine = (0, search_engines_1.getDefaultEngine)();
        template.push({
            label: `${engine.name}에서 "${truncate(sel, SEARCH_LABEL_MAX)}" 검색`,
            click: () => { (0, tab_service_1.createTab)({ windowId, url: (0, search_engines_1.buildSearchUrl)(sel, engine), background: false }); },
        });
        template.push({
            label: '선택 영역에서 찾기',
            click: () => {
                const ctx = (0, window_service_1.getWindow)(windowId);
                ctx?.chrome.webContents.send(ipc_channels_1.IPC.find.open, { initialText: sel.slice(0, 200) });
                (0, find_1.startFind)(tabId, sel.slice(0, 200));
            },
        });
        sep();
    }
    // ===== 편집 가능한 입력 =====
    if (params.isEditable) {
        template.push({ label: '실행 취소', role: 'undo', enabled: params.editFlags.canUndo }, { label: '다시 실행', role: 'redo', enabled: params.editFlags.canRedo }, { type: 'separator' }, { label: '잘라내기', role: 'cut', enabled: params.editFlags.canCut }, { label: '복사', role: 'copy', enabled: params.editFlags.canCopy }, { label: '붙여넣기', role: 'paste', enabled: params.editFlags.canPaste }, { label: '모두 선택', role: 'selectAll', enabled: params.editFlags.canSelectAll });
        sep();
    }
    // ===== 페이지 일반 (위 항목이 없을 때 = 빈 영역 우클릭) =====
    const isPlainPage = !params.linkURL && params.mediaType === 'none'
        && !(params.selectionText && params.selectionText.trim()) && !params.isEditable;
    if (isPlainPage) {
        template.push({ label: '뒤로', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() }, { label: '앞으로', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() }, { label: '새로고침', click: () => wc.reload() }, { type: 'separator' }, {
            label: '이 페이지 북마크 추가 ★',
            click: () => {
                const t = (0, tab_service_1.getTab)(tabId);
                if (t?.url && !/^browser:|^chrome:|^about:/i.test(t.url)) {
                    (0, bookmarks_1.addBookmark)({ url: t.url, title: t.title || t.url });
                    const ctx = (0, window_service_1.getWindow)(windowId);
                    ctx?.chrome.webContents.send('toast:show', { message: '북마크에 추가됨 ★', ts: 0 });
                }
            },
        }, { type: 'separator' });
    }
    // ===== 모드가 등록한 메뉴 항목 =====
    const modItems = (0, mod_api_1.collectMenuItems)();
    if (modItems.length > 0) {
        template.push({
            label: '모드',
            submenu: modItems.map((m) => ({
                label: m.label,
                click: () => {
                    try {
                        m.click();
                    }
                    catch (err) {
                        console.warn(`[context-menu] mod "${m.modId}" menu click error`, err);
                    }
                },
            })),
        });
        sep();
    }
    // ===== 항상 표시 =====
    template.push({
        label: '페이지 소스 보기',
        click: () => {
            const url = wc.getURL();
            if (/^https?:|^file:/i.test(url))
                (0, tab_service_1.createTab)({ windowId, url: `view-source:${url}`, background: true });
        },
    });
    template.push({
        label: '검사',
        click: () => {
            wc.inspectElement(params.x, params.y);
            if (!wc.isDevToolsOpened())
                wc.openDevTools({ mode: 'detach' });
        },
    });
    return template;
}
/**
 * 탭 webContents 에 우클릭 컨텍스트 메뉴 부착. onTabCreated 훅에서 호출.
 */
function trackContextMenu(wc, tabId) {
    const tab = (0, tab_service_1.getTab)(tabId);
    const windowId = tab?.windowId;
    if (!windowId)
        return;
    wc.on('context-menu', (_e, params) => {
        const template = buildTemplate(wc, tabId, windowId, params);
        if (template.length === 0)
            return;
        const menu = electron_1.Menu.buildFromTemplate(template);
        const ctx = (0, window_service_1.getWindow)(windowId);
        if (ctx)
            menu.popup({ window: ctx.win });
        else
            menu.popup();
    });
}
