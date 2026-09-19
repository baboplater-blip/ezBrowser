"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.windowEvents = void 0;
exports.setOpenInTabHandler = setOpenInTabHandler;
exports.routeWindowOpen = routeWindowOpen;
exports.setMagnetHandler = setMagnetHandler;
exports.createBrowserWindow = createBrowserWindow;
exports.getWindow = getWindow;
exports.getAllWindows = getAllWindows;
exports.broadcastToInternalPages = broadcastToInternalPages;
exports.getChromeSize = getChromeSize;
exports.getTabBounds = getTabBounds;
exports.setShellInsetsHook = setShellInsetsHook;
exports.bringChromeToFront = bringChromeToFront;
exports.setShellInsets = setShellInsets;
exports.setChromeHeight = setChromeHeight;
exports.onWindowResize = onWindowResize;
const electron_1 = require("electron");
const node_events_1 = require("node:events");
const node_path_1 = __importDefault(require("node:path"));
const constants_1 = require("../../shared/constants");
const settings_1 = require("../storage/settings");
const session_bootstrap_1 = require("../session-bootstrap");
const windows = new Map();
let counter = 0;
let incognitoCounter = 0;
const isDev = process.env.VITE_DEV_SERVER_URL !== undefined
    || process.env.BROWSERBUILD_DEV === '1';
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
exports.windowEvents = new node_events_1.EventEmitter();
function isInternalUrl(url) {
    return constants_1.INTERNAL_URL_PREFIXES.some((p) => url.startsWith(p));
}
const EXTERNAL_OK_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:', 'sms:'];
let openInTab = null;
function setOpenInTabHandler(fn) { openInTab = fn; }
function routeWindowOpen(windowId, url, source) {
    if (!url)
        return;
    let scheme = '';
    try {
        scheme = new URL(url).protocol;
    }
    catch {
        return;
    }
    if (scheme === 'magnet:') {
        if (magnetHandler)
            void magnetHandler(url);
        return;
    }
    if (scheme === 'browser:' || EXTERNAL_OK_SCHEMES.includes(scheme)) {
        if (!openInTab)
            return;
        // 사용자 설정에 따라 새 탭/현재 탭/백그라운드 탭
        let behavior = 'new-tab';
        try {
            behavior = (0, settings_1.getSetting)('tabs').openBehavior;
        }
        catch { /* default */ }
        if (behavior === 'same-tab') {
            openInTab(windowId, url, { sourceTabId: source?.sourceTabId });
        }
        else if (behavior === 'background-tab') {
            openInTab(windowId, url, { background: true, forceNewTab: true });
        }
        else {
            openInTab(windowId, url, { forceNewTab: true });
        }
        return;
    }
    // 알 수 없는 스킴은 무시 — OS 핸들러로 위임하지 않음
}
let magnetHandler = null;
function setMagnetHandler(fn) { magnetHandler = fn; }
function createBrowserWindow(opts) {
    counter += 1;
    const id = `win-${counter}`;
    const incognito = opts?.incognito === true;
    let incognitoPart;
    if (incognito) {
        incognitoCounter += 1;
        incognitoPart = (0, constants_1.incognitoPartition)(incognitoCounter);
    }
    const win = new electron_1.BaseWindow({
        width: 1280,
        height: 800,
        show: false,
        backgroundColor: '#0F0F12',
        title: incognito ? 'ezBrowser (시크릿)' : 'ezBrowser',
    });
    const chrome = new electron_1.WebContentsView({
        webPreferences: {
            preload: node_path_1.default.join(__dirname, '../../preload/chrome.js'),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
        },
    });
    // 오버레이(토스트·모달·컨텍스트 메뉴 등)가 chrome view 를 최상위로 승격할 때
    // 콘텐츠 페이지가 완전히 가려지지 않도록 chrome view 자체를 투명하게 만든다.
    // 실제 UI 가 그려지는 영역(탭바·툴바·모달 등)은 각 컴포넌트의 CSS 가 자체 배경을 갖는다.
    try {
        chrome.setBackgroundColor('#00000000');
    }
    catch (err) {
        console.warn('[window] chrome.setBackgroundColor failed', err);
    }
    win.contentView.addChildView(chrome);
    const size = win.getContentSize();
    const w = size[0] ?? 1280;
    const h = size[1] ?? 800;
    chrome.setBounds({ x: 0, y: 0, width: w, height: h });
    win.on('resize', () => {
        const s = win.getContentSize();
        chrome.setBounds({ x: 0, y: 0, width: s[0] ?? 0, height: s[1] ?? 0 });
    });
    chrome.webContents.setWindowOpenHandler(({ url }) => {
        routeWindowOpen(id, url);
        return { action: 'deny' };
    });
    chrome.webContents.on('did-fail-load', (_e, code, desc, url) => {
        console.warn(`[chrome] did-fail-load code=${code} desc=${desc} url=${url}`);
    });
    chrome.webContents.on('preload-error', (_e, preloadPath, error) => {
        console.error(`[chrome] preload-error ${preloadPath}: ${error.message}`);
    });
    chrome.webContents.on('will-navigate', (e, url) => {
        if (!isInternalUrl(url))
            e.preventDefault();
    });
    const incognitoQuery = incognito ? '&incognito=1' : '';
    const chromeUrl = isDev
        ? `${DEV_URL}?windowId=${id}${incognitoQuery}`
        : `file://${node_path_1.default.join(__dirname, '../../renderer/index.html')}?windowId=${id}${incognitoQuery}`;
    chrome.webContents.loadURL(chromeUrl);
    const ctx = {
        id, win, chrome, chromeHeight: constants_1.CHROME_HEIGHT,
        insets: { top: constants_1.CHROME_HEIGHT, right: 0, bottom: 0, left: 0 },
        incognito, incognitoPartition: incognitoPart,
    };
    windows.set(id, ctx);
    chrome.webContents.once('did-finish-load', () => {
        win.show();
        setTimeout(() => {
            chrome.webContents.send('windows:ready', { windowId: id });
        }, 50);
    });
    win.on('closed', () => {
        windows.delete(id);
        exports.windowEvents.emit('closed', ctx);
        // 시크릿 창의 in-memory 세션은 창이 닫히면 더 이상 쓰이지 않는다 — 설치 세션 목록에서 제거해
        // incognito 창을 여닫을 때마다 세션(과 그 webRequest/policy/adblock 리스너)이 누적되지 않게 한다.
        if (incognito && incognitoPart) {
            try {
                (0, session_bootstrap_1.removeInstalledSession)(electron_1.session.fromPartition(incognitoPart));
            }
            catch { /* ignore */ }
        }
    });
    exports.windowEvents.emit('created', ctx);
    return ctx;
}
function getWindow(id) {
    return windows.get(id);
}
function getAllWindows() {
    return Array.from(windows.values());
}
// browser:// 내부 페이지(북마크·다운로드·설정 등 관리 UI)는 탭 webContents 에서 돌아가므로
// 외피(chrome) 셸에만 보내는 `.changed`/`update` 브로드캐스트를 못 받는다 → 실시간 갱신이 죽는다.
// 이 헬퍼로 열린 모든 browser:// 페이지에도 같은 이벤트를 전달한다. (외피로의 기존 send 는 그대로 유지)
function broadcastToInternalPages(channel, payload) {
    for (const wc of electron_1.webContents.getAllWebContents()) {
        if (wc.isDestroyed())
            continue;
        let url = '';
        try {
            url = wc.getURL();
        }
        catch {
            continue;
        }
        if (url.startsWith('browser://'))
            wc.send(channel, payload);
    }
}
function getChromeSize(ctx) {
    const size = ctx.win.getContentSize();
    return { width: size[0] ?? 1280, height: size[1] ?? 800 };
}
function getTabBounds(ctx) {
    const { width, height } = getChromeSize(ctx);
    const { top, right, bottom, left } = ctx.insets;
    return {
        x: left,
        y: top,
        width: Math.max(0, width - left - right),
        height: Math.max(0, height - top - bottom),
    };
}
let insetsHook = null;
function setShellInsetsHook(fn) { insetsHook = fn; }
function clampInset(v, max) {
    if (!Number.isFinite(v))
        return 0;
    return Math.max(0, Math.min(max, Math.round(v)));
}
function bringChromeToFront(windowId) {
    const ctx = windows.get(windowId);
    if (!ctx)
        return;
    try {
        ctx.win.contentView.removeChildView(ctx.chrome);
        ctx.win.contentView.addChildView(ctx.chrome);
    }
    catch (err) {
        console.warn('[window] bringChromeToFront failed', err);
    }
}
function setShellInsets(windowId, partial) {
    const ctx = windows.get(windowId);
    if (!ctx)
        return;
    // 창 크기 기준으로 클램프한다(기존 고정 800 은 우측 탭바+사이드패널+다운로드+동영상 도크가 함께 열려
    // 합이 ~1140 이 되는 정상 상황을 잘라 콘텐츠 뷰가 도크를 덮는 문제를 냈다). 각 축 최소 여백은 남긴다.
    const { width, height } = getChromeSize(ctx);
    const maxW = Math.max(0, width - 200);
    const maxH = Math.max(0, height - 120);
    const next = {
        top: partial.top !== undefined ? clampInset(partial.top, maxH) : ctx.insets.top,
        right: partial.right !== undefined ? clampInset(partial.right, maxW) : ctx.insets.right,
        bottom: partial.bottom !== undefined ? clampInset(partial.bottom, maxH) : ctx.insets.bottom,
        left: partial.left !== undefined ? clampInset(partial.left, maxW) : ctx.insets.left,
    };
    const cur = ctx.insets;
    if (cur.top === next.top && cur.right === next.right && cur.bottom === next.bottom && cur.left === next.left)
        return;
    ctx.insets = next;
    ctx.chromeHeight = next.top;
    if (insetsHook)
        insetsHook(windowId);
}
function setChromeHeight(windowId, height) {
    setShellInsets(windowId, { top: height });
}
function onWindowResize(ctx, cb) {
    ctx.win.on('resize', cb);
}
