"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDefaultActions = registerDefaultActions;
const electron_1 = require("electron");
const registry_1 = require("./registry");
const tab_service_1 = require("../tabs/tab-service");
const sitedata_1 = require("../features/sitedata");
const window_service_1 = require("../windows/window-service");
const constants_1 = require("../../shared/constants");
const userchrome_1 = require("../features/userchrome");
const screenshot_1 = require("../features/screenshot");
const bookmarks_1 = require("../storage/bookmarks");
const readlater_1 = require("../storage/readlater");
const dark_mode_1 = require("../features/dark-mode");
const settings_1 = require("../storage/settings");
const adblock_1 = require("../features/adblock");
const auto_update_1 = require("../features/auto-update");
const reader_1 = require("../features/reader");
const translate_1 = require("../features/translate");
const workspace_1 = require("../features/workspace");
const page_tools_1 = require("../features/page-tools");
const page_actions_1 = require("../features/ai/page-actions");
const profile_1 = require("../features/ai/profile");
function activeTabIdOf(windowId) {
    if (!windowId)
        return undefined;
    const t = (0, tab_service_1.listTabs)(windowId).find((x) => x.active);
    return t?.id;
}
function broadcastToast(windowId, message) {
    const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
    ctx?.chrome.webContents.send('toast:show', { message, ts: Date.now() });
}
function registerDefaultActions() {
    (0, registry_1.registerAction)({
        id: 'action.autofill.page', category: 'ai', labelKey: 'action.autofill.page', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            const wc = id ? (0, tab_service_1.getWebContentsByTabId)(id) : null;
            if (!wc || !/^https?:/i.test(wc.getURL())) {
                broadcastToast(windowId, '웹 페이지에서만 사용할 수 있습니다');
                return;
            }
            if (!(0, profile_1.hasProfileData)()) {
                broadcastToast(windowId, '내 정보가 비어 있습니다 — 설정 > AI 에서 입력하세요');
                return;
            }
            void (0, page_actions_1.autofillPage)(wc, (0, profile_1.getProfile)()).then((r) => {
                broadcastToast(windowId, r.count > 0 ? `자동 채우기: ${r.count}개 필드 ✍️` : '채울 폼 필드를 못 찾았습니다');
            });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.tab.new', category: 'tab', labelKey: 'action.tab.new',
        defaultKey: 'Ctrl+T', when: 'global',
        run: ({ windowId }) => { if (windowId)
            (0, tab_service_1.createTab)({ windowId, url: constants_1.NEW_TAB_URL }); },
    });
    (0, registry_1.registerAction)({
        id: 'action.tab.close', category: 'tab', labelKey: 'action.tab.close',
        defaultKey: 'Ctrl+W', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            if (id)
                (0, tab_service_1.closeTab)(id);
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.tab.restore', category: 'tab', labelKey: 'action.tab.restore',
        defaultKey: 'Ctrl+Shift+T', when: 'global',
        run: ({ windowId }) => { if (windowId)
            (0, tab_service_1.restoreLastClosed)(windowId); },
    });
    (0, registry_1.registerAction)({
        id: 'action.tab.duplicate', category: 'tab', labelKey: 'action.tab.duplicate',
        when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            if (id)
                (0, tab_service_1.duplicateTab)(id);
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.tab.pin', category: 'tab', labelKey: 'action.tab.pin',
        when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            if (!id)
                return;
            const t = (0, tab_service_1.getTab)(id);
            if (t)
                (0, tab_service_1.pinTab)(id, !t.pinned);
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.tab.next', category: 'tab', labelKey: 'action.tab.next',
        defaultKey: 'Ctrl+Tab', when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            const list = (0, tab_service_1.listTabs)(windowId);
            const i = list.findIndex((t) => t.active);
            const next = list[(i + 1) % list.length];
            if (next)
                (0, tab_service_1.activateTab)(next.id);
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.tab.prev', category: 'tab', labelKey: 'action.tab.prev',
        defaultKey: 'Ctrl+Shift+Tab', when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            const list = (0, tab_service_1.listTabs)(windowId);
            const i = list.findIndex((t) => t.active);
            const prev = list[(i - 1 + list.length) % list.length];
            if (prev)
                (0, tab_service_1.activateTab)(prev.id);
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.nav.back', category: 'nav', labelKey: 'action.nav.back',
        defaultKey: 'Alt+Left', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            if (id)
                (0, tab_service_1.tabBack)(id);
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.nav.forward', category: 'nav', labelKey: 'action.nav.forward',
        defaultKey: 'Alt+Right', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            if (id)
                (0, tab_service_1.tabForward)(id);
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.page.reload', category: 'nav', labelKey: 'action.page.reload',
        defaultKey: 'Ctrl+R', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            if (id)
                (0, tab_service_1.tabReload)(id);
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.page.stop', category: 'nav', labelKey: 'action.page.stop',
        defaultKey: 'Escape', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            if (id)
                (0, tab_service_1.tabStop)(id);
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.omnibox.focus', category: 'omnibox', labelKey: 'action.omnibox.focus',
        defaultKey: 'Ctrl+L', when: 'global',
        run: ({ windowId }) => {
            const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
            ctx?.chrome.webContents.send('omnibox:focus');
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.palette.open', category: 'palette', labelKey: 'action.palette.open',
        defaultKey: 'Ctrl+Shift+P', when: 'global',
        run: ({ windowId }) => {
            const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
            ctx?.chrome.webContents.send('palette:open');
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.tab.search', category: 'tab', labelKey: 'action.tab.search',
        defaultKey: 'Ctrl+Shift+A', when: 'global',
        run: ({ windowId }) => {
            const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
            ctx?.chrome.webContents.send('tabsearch:open');
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.readlater.add', category: 'readlater', labelKey: 'action.readlater.add',
        when: 'global',
        run: ({ windowId, tabId }) => {
            const tab = tabId ? (0, tab_service_1.getTab)(tabId) : (0, tab_service_1.listTabs)(windowId ?? '').find((t) => t.active);
            if (!tab?.url || !/^https?:/i.test(tab.url))
                return;
            if ((0, readlater_1.isReadLaterSaved)(tab.url)) {
                (0, readlater_1.removeReadLaterByUrl)(tab.url);
                broadcastToast(windowId, '읽기 목록에서 제거됨');
            }
            else {
                (0, readlater_1.addReadLater)({ url: tab.url, title: tab.title, favicon: tab.favicon });
                broadcastToast(windowId, '읽기 목록에 추가됨 📚');
            }
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.readlater.open', category: 'readlater', labelKey: 'action.readlater.open',
        when: 'global',
        run: ({ windowId }) => {
            const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
            ctx?.chrome.webContents.send('readlater:open-panel');
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.tab.recentClosed', category: 'tab', labelKey: 'action.tab.recentClosed',
        when: 'global',
        run: ({ windowId }) => {
            const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
            ctx?.chrome.webContents.send('recent-closed:open');
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.find.toggle', category: 'tools', labelKey: 'action.find.toggle',
        defaultKey: 'Ctrl+F', when: 'global',
        run: ({ windowId }) => {
            const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
            ctx?.chrome.webContents.send('find:open', {});
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.history.clear', category: 'tools', labelKey: 'action.history.clear',
        defaultKey: 'Ctrl+Shift+Delete', when: 'global',
        run: ({ windowId }) => {
            const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
            ctx?.chrome.webContents.send('cleardata:open');
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.page.print', category: 'tools', labelKey: 'action.page.print',
        defaultKey: 'Ctrl+P', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            if (id)
                (0, page_tools_1.printTab)(id);
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.page.printPdf', category: 'tools', labelKey: 'action.page.printPdf',
        defaultKey: 'Ctrl+Alt+P', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            if (!id)
                return;
            void (0, page_tools_1.printTabToPdf)(id).then((r) => {
                if (r.ok)
                    broadcastToast(windowId, 'PDF 저장 완료 📄');
                else if (r.error !== 'canceled')
                    broadcastToast(windowId, 'PDF 저장 실패');
            });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.page.zoom.in', category: 'tools', labelKey: 'action.page.zoom.in',
        defaultKey: 'Ctrl+=', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            if (id)
                (0, page_tools_1.adjustZoom)(id, 1);
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.page.zoom.out', category: 'tools', labelKey: 'action.page.zoom.out',
        defaultKey: 'Ctrl+-', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            if (id)
                (0, page_tools_1.adjustZoom)(id, -1);
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.page.zoom.reset', category: 'tools', labelKey: 'action.page.zoom.reset',
        defaultKey: 'Ctrl+0', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            if (id)
                (0, page_tools_1.adjustZoom)(id, 0);
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.devtools.toggle', category: 'dev', labelKey: 'action.devtools.toggle',
        defaultKey: 'F12', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            const wc = id ? (0, tab_service_1.getWebContentsByTabId)(id) : null;
            if (wc?.isDevToolsOpened())
                wc.closeDevTools();
            else
                wc?.openDevTools({ mode: 'detach' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.userchrome.reload', category: 'freedom', labelKey: 'action.userchrome.reload',
        defaultKey: 'Ctrl+Alt+Shift+R', when: 'chrome',
        run: () => { void (0, userchrome_1.reloadUserChrome)(); },
    });
    (0, registry_1.registerAction)({
        id: 'action.userchrome.edit', category: 'freedom', labelKey: 'action.userchrome.edit',
        when: 'chrome',
        run: () => { void (0, userchrome_1.openUserChromeInEditor)('css'); },
    });
    (0, registry_1.registerAction)({
        id: 'action.screenshot.viewport', category: 'tools', labelKey: 'action.screenshot.viewport',
        defaultKey: 'Ctrl+Shift+Alt+S', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            if (id)
                void (0, screenshot_1.captureViewport)(id);
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.window.new', category: 'window', labelKey: 'action.window.new',
        defaultKey: 'Ctrl+N', when: 'global',
        run: () => {
            (0, window_service_1.createBrowserWindow)();
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.window.incognito', category: 'window', labelKey: 'action.window.incognito',
        defaultKey: 'Ctrl+Shift+N', when: 'global',
        run: () => {
            const ctx = (0, window_service_1.createBrowserWindow)({ incognito: true });
            (0, tab_service_1.createTab)({ windowId: ctx.id, url: constants_1.NEW_TAB_URL });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.window.close', category: 'window', labelKey: 'action.window.close',
        defaultKey: 'Ctrl+Shift+W', when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            const ctx = (0, window_service_1.getWindow)(windowId);
            ctx?.win.close();
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.app.quit', category: 'app', labelKey: 'action.app.quit',
        defaultKey: 'Ctrl+Q', when: 'global',
        run: () => electron_1.app.quit(),
    });
    (0, registry_1.registerAction)({
        id: 'action.help.report', category: 'help', labelKey: 'action.help.report',
        when: 'global',
        run: () => { void electron_1.shell.openExternal('https://github.com/'); },
    });
    (0, registry_1.registerAction)({
        id: 'action.bookmark.add', category: 'bookmark', labelKey: 'action.bookmark.add',
        defaultKey: 'Ctrl+D', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            if (!id)
                return;
            const t = (0, tab_service_1.getTab)(id);
            if (!t || !t.url || /^browser:|^chrome:|^about:/i.test(t.url))
                return;
            if ((0, bookmarks_1.isBookmarked)(t.url)) {
                (0, bookmarks_1.removeBookmarkByUrl)(t.url);
                broadcastToast(windowId, '북마크에서 제거됨');
            }
            else {
                (0, bookmarks_1.addBookmark)({ url: t.url, title: t.title || t.url });
                broadcastToast(windowId, '북마크에 추가됨 ★');
            }
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.history.open', category: 'history', labelKey: 'action.history.open',
        defaultKey: 'Ctrl+H', when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.createTab)({ windowId, url: 'browser://history' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.bookmark.list', category: 'bookmark', labelKey: 'action.bookmark.list',
        when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.createTab)({ windowId, url: 'browser://bookmarks' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.bookmark.bar.toggle', category: 'bookmark', labelKey: 'action.bookmark.bar.toggle',
        defaultKey: 'Ctrl+Shift+B', when: 'global',
        run: ({ windowId }) => {
            const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
            ctx?.chrome.webContents.send('bookmark-bar:toggle');
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.sidepanel.left.toggle', category: 'sidepanel', labelKey: 'action.sidepanel.left.toggle',
        defaultKey: 'Ctrl+B', when: 'global',
        run: ({ windowId }) => {
            const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
            ctx?.chrome.webContents.send('sidepanel:toggle', { side: 'left' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.sidepanel.right.toggle', category: 'sidepanel', labelKey: 'action.sidepanel.right.toggle',
        defaultKey: 'Ctrl+Alt+B', when: 'global',
        run: ({ windowId }) => {
            const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
            ctx?.chrome.webContents.send('sidepanel:toggle', { side: 'right' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.ai.open', category: 'tools', labelKey: 'action.ai.open',
        defaultKey: 'Ctrl+Shift+Space', when: 'global',
        run: ({ windowId, tabId }) => {
            const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
            const id = tabId ?? activeTabIdOf(windowId ?? ctx?.id);
            ctx?.chrome.webContents.send('ai:open', { tabId: id });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.ai.summarize', category: 'tools', labelKey: 'action.ai.summarize', when: 'global',
        run: ({ windowId, tabId }) => {
            const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
            const id = tabId ?? activeTabIdOf(windowId ?? ctx?.id);
            ctx?.chrome.webContents.send('ai:summarize', { tabId: id });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.ai.write', category: 'tools', labelKey: 'action.ai.write', when: 'global',
        run: ({ windowId, tabId }) => {
            const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
            const id = tabId ?? activeTabIdOf(windowId ?? ctx?.id);
            ctx?.chrome.webContents.send('ai:write', { tabId: id });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.tab.reader', category: 'tab', labelKey: 'action.tab.reader',
        defaultKey: 'Ctrl+Alt+R', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            const wc = id ? (0, tab_service_1.getWebContentsByTabId)(id) : null;
            if (!wc)
                return;
            void (0, reader_1.toggleReader)(wc).then((on) => {
                broadcastToast(windowId, on ? '리더 모드 📖' : '원본 보기');
            });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.translate.page', category: 'tab', labelKey: 'action.translate.page',
        defaultKey: 'Ctrl+Shift+L', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            const wc = id ? (0, tab_service_1.getWebContentsByTabId)(id) : null;
            if (!wc)
                return;
            broadcastToast(windowId, '번역 중… ⏳');
            void (0, translate_1.togglePageTranslate)(wc).then((r) => {
                if (r.restored)
                    broadcastToast(windowId, '원본 복원');
                else if (r.started)
                    broadcastToast(windowId, '번역 완료 🌐');
            }).catch((err) => {
                console.warn('[translate] failed', err);
                broadcastToast(windowId, '번역 실패');
            });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.userscript.toggle', category: 'freedom', labelKey: 'action.userscript.toggle',
        defaultKey: 'Ctrl+Shift+U', when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.createTab)({ windowId, url: 'browser://userscripts' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.policy.open', category: 'freedom', labelKey: 'action.policy.open',
        defaultKey: 'Ctrl+Shift+Y', when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.createTab)({ windowId, url: 'browser://policies' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.macros.open', category: 'freedom', labelKey: 'action.macros.open',
        when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.createTab)({ windowId, url: 'browser://macros' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.mods.open', category: 'freedom', labelKey: 'action.mods.open',
        when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.createTab)({ windowId, url: 'browser://mods' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.memory.open', category: 'tools', labelKey: 'action.memory.open',
        when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.createTab)({ windowId, url: 'browser://memory' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.ai.collectors', category: 'tools', labelKey: 'action.ai.collectors',
        when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.createTab)({ windowId, url: 'browser://ai-collectors' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.extensions.open', category: 'tools', labelKey: 'action.extensions.open',
        defaultKey: 'Ctrl+Shift+X', when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.createTab)({ windowId, url: 'browser://extensions' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.adblock.openPage', category: 'tools', labelKey: 'action.adblock.openPage',
        when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.createTab)({ windowId, url: 'browser://adblock' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.perf.open', category: 'tools', labelKey: 'action.perf.open',
        when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.createTab)({ windowId, url: 'browser://perf' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.keymap.open', category: 'tools', labelKey: 'action.keymap.open',
        when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.createTab)({ windowId, url: 'browser://keymap' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.update.check', category: 'app', labelKey: 'action.update.check',
        when: 'global',
        run: ({ windowId }) => {
            void (0, auto_update_1.checkForUpdates)(false).then((s) => {
                if (s.state === 'available')
                    broadcastToast(windowId, `새 버전 ${s.available} 발견`);
                else if (s.state === 'not-available')
                    broadcastToast(windowId, '최신 버전입니다 ✓');
                else if (s.state === 'downloaded')
                    broadcastToast(windowId, '업데이트 준비 완료 — 재시작 시 적용');
                else if (s.state === 'disabled')
                    broadcastToast(windowId, s.error ?? '자동 업데이트 비활성');
                else if (s.state === 'error')
                    broadcastToast(windowId, `업데이트 확인 실패: ${s.error}`);
            });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.adblock.toggleSite', category: 'tools', labelKey: 'action.adblock.toggleSite',
        defaultKey: 'Ctrl+Alt+A', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            const wc = id ? (0, tab_service_1.getWebContentsByTabId)(id) : null;
            const url = wc?.getURL() ?? '';
            if (!url) {
                broadcastToast(windowId, '현재 탭 URL 을 확인할 수 없습니다');
                return;
            }
            void (0, adblock_1.toggleSiteAllowed)(url).then(({ host, allowed }) => {
                if (!host) {
                    broadcastToast(windowId, '이 페이지에 광고차단을 적용할 수 없습니다');
                    return;
                }
                // allowed=true → 이 사이트에서 광고차단 "꺼짐"(허용), false → "켜짐"
                broadcastToast(windowId, allowed
                    ? `🛡️ ${host} — 광고차단 꺼짐 · 새로고침 중…`
                    : `🛡️ ${host} — 광고차단 켜짐 · 새로고침 중…`);
                // 변경은 새 요청부터 적용되므로 탭을 새로고침해 결과가 바로 보이게 한다.
                try {
                    wc?.reload();
                }
                catch { /* ignore */ }
            });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.settings.open', category: 'app', labelKey: 'action.settings.open',
        defaultKey: 'Ctrl+,', when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.createTab)({ windowId, url: 'browser://settings' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.password.open', category: 'tools', labelKey: 'action.password.open',
        defaultKey: 'Ctrl+Shift+;', when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.createTab)({ windowId, url: 'browser://passwords' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.workspace.next', category: 'workspace', labelKey: 'action.workspace.next',
        defaultKey: 'Ctrl+Alt+Right', when: 'global',
        run: ({ windowId }) => {
            const next = (0, workspace_1.nextWorkspaceId)(1);
            if (next) {
                void (0, workspace_1.setActiveWorkspace)(next);
                const ws = (0, workspace_1.listWorkspaces)().find((w) => w.id === next);
                if (ws)
                    broadcastToast(windowId, `스페이스: ${ws.name}`);
            }
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.workspace.prev', category: 'workspace', labelKey: 'action.workspace.prev',
        defaultKey: 'Ctrl+Alt+Left', when: 'global',
        run: ({ windowId }) => {
            const prev = (0, workspace_1.nextWorkspaceId)(-1);
            if (prev) {
                void (0, workspace_1.setActiveWorkspace)(prev);
                const ws = (0, workspace_1.listWorkspaces)().find((w) => w.id === prev);
                if (ws)
                    broadcastToast(windowId, `스페이스: ${ws.name}`);
            }
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.workspace.new', category: 'workspace', labelKey: 'action.workspace.new',
        defaultKey: 'Ctrl+Alt+N', when: 'global',
        run: async ({ windowId }) => {
            const ws = await (0, workspace_1.createWorkspace)();
            await (0, workspace_1.setActiveWorkspace)(ws.id);
            broadcastToast(windowId, `새 스페이스 ${ws.name} 생성됨`);
        },
    });
    for (let i = 1; i <= 5; i += 1) {
        const idx = i;
        (0, registry_1.registerAction)({
            id: `action.workspace.switch.${idx}`, category: 'workspace',
            labelKey: 'action.workspace.switch', defaultKey: `Ctrl+Alt+${idx}`, when: 'global',
            run: ({ windowId }) => {
                const list = (0, workspace_1.listWorkspaces)();
                const target = list[idx - 1];
                if (target && target.id !== (0, workspace_1.getActiveWorkspaceId)()) {
                    void (0, workspace_1.setActiveWorkspace)(target.id);
                    broadcastToast(windowId, `스페이스: ${target.name}`);
                }
            },
        });
    }
    function moveActiveTabTo(windowId, direction) {
        if (!windowId)
            return;
        const list = (0, workspace_1.listWorkspaces)();
        if (list.length <= 1) {
            broadcastToast(windowId, '스페이스가 하나뿐입니다');
            return;
        }
        const activeWsId = (0, workspace_1.getActiveWorkspaceId)();
        const i = list.findIndex((w) => w.id === activeWsId);
        if (i < 0)
            return;
        const target = list[(i + direction + list.length) % list.length];
        if (!target)
            return;
        const tabId = activeTabIdOf(windowId);
        if (!tabId)
            return;
        const result = (0, tab_service_1.moveTabToWorkspace)(tabId, target.id);
        if (!result.moved) {
            broadcastToast(windowId, '탭 이동 실패');
            return;
        }
        const suffix = result.needsReload ? ' · 페이지 재로드' : '';
        broadcastToast(windowId, `탭 이동 → ${target.name}${suffix}`);
    }
    (0, registry_1.registerAction)({
        id: 'action.tab.move.next.workspace', category: 'workspace',
        labelKey: 'action.tab.move.next.workspace',
        defaultKey: 'Ctrl+Shift+PageDown', when: 'global',
        run: ({ windowId }) => moveActiveTabTo(windowId, 1),
    });
    (0, registry_1.registerAction)({
        id: 'action.tab.move.prev.workspace', category: 'workspace',
        labelKey: 'action.tab.move.prev.workspace',
        defaultKey: 'Ctrl+Shift+PageUp', when: 'global',
        run: ({ windowId }) => moveActiveTabTo(windowId, -1),
    });
    (0, registry_1.registerAction)({
        id: 'action.qrcode.show', category: 'tools', labelKey: 'action.qrcode.show',
        defaultKey: 'Ctrl+Shift+Q', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            const t = id ? (0, tab_service_1.getTab)(id) : null;
            const url = t?.url;
            if (!url)
                return;
            const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
            ctx?.chrome.webContents.send('qrcode:open', { url });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.darkmode.toggle', category: 'appearance', labelKey: 'action.darkmode.toggle',
        defaultKey: 'Ctrl+Shift+D', when: 'global',
        run: ({ windowId }) => {
            void (0, dark_mode_1.toggleForcePageDark)().then((enabled) => {
                broadcastToast(windowId, enabled ? '강제 다크 모드 켜짐 🌙' : '강제 다크 모드 꺼짐 ☀');
            });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.darkmode.toggleSite', category: 'appearance', labelKey: 'action.darkmode.toggleSite',
        defaultKey: 'Ctrl+Alt+D', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            const wc = id ? (0, tab_service_1.getWebContentsByTabId)(id) : null;
            const url = wc?.getURL() ?? '';
            if (!url) {
                broadcastToast(windowId, '현재 탭 URL 을 확인할 수 없습니다');
                return;
            }
            void (0, dark_mode_1.toggleSiteDark)(url).then(({ origin, state }) => {
                if (!origin) {
                    broadcastToast(windowId, '이 페이지에는 사이트별 다크 모드를 적용할 수 없습니다');
                    return;
                }
                const label = state === 'on' ? `사이트 다크 켜짐 🌙 (${origin})`
                    : state === 'off' ? `사이트 다크 꺼짐 ☀ (${origin})`
                        : `사이트 다크 기본값 따름 (${origin})`;
                broadcastToast(windowId, label);
            });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.darkmode.followSystem', category: 'appearance', labelKey: 'action.darkmode.followSystem',
        when: 'global',
        run: ({ windowId }) => {
            const cur = (0, settings_1.getSetting)('appearance').pageDarkFollowSystem === true;
            void (0, dark_mode_1.setFollowSystemDark)(!cur).then(() => {
                broadcastToast(windowId, !cur ? 'OS 다크 모드 따라가기 켜짐 🌓' : 'OS 다크 모드 따라가기 꺼짐');
            });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.tabbar.cycle', category: 'layout', labelKey: 'action.tabbar.cycle',
        defaultKey: 'Ctrl+Alt+T', when: 'global',
        run: ({ windowId }) => {
            const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
            ctx?.chrome.webContents.send('tabbar:cycle-orientation');
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.pane.split.h', category: 'layout', labelKey: 'action.pane.split.h',
        defaultKey: 'Ctrl+\\', when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.splitWindow)(windowId, 'h');
            broadcastToast(windowId, '좌우 분할 ⫾');
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.pane.split.v', category: 'layout', labelKey: 'action.pane.split.v',
        defaultKey: 'Ctrl+Alt+-', when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.splitWindow)(windowId, 'v');
            broadcastToast(windowId, '상하 분할 ⫿');
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.pane.unsplit', category: 'layout', labelKey: 'action.pane.unsplit',
        defaultKey: 'Ctrl+Alt+0', when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.unsplitWindow)(windowId);
            broadcastToast(windowId, '분할 해제');
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.pane.focus.next', category: 'layout', labelKey: 'action.pane.focus.next',
        defaultKey: 'Ctrl+`', when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.focusNextPane)(windowId);
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.downloads.open', category: 'tools', labelKey: 'action.downloads.open',
        defaultKey: 'Ctrl+J', when: 'global',
        run: ({ windowId }) => {
            const ctx = windowId ? (0, window_service_1.getWindow)(windowId) : (0, window_service_1.getAllWindows)()[0];
            ctx?.chrome.webContents.send('panel:open', { panel: 'downloads' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.downloads.openPage', category: 'tools', labelKey: 'action.downloads.openPage',
        defaultKey: 'Ctrl+Shift+J', when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            (0, tab_service_1.createTab)({ windowId, url: 'browser://downloads' });
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.tab.mute', category: 'tab', labelKey: 'action.tab.mute', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            if (!id)
                return;
            const summary = (0, tab_service_1.listTabs)(windowId ?? '').find((t) => t.id === id);
            (0, tab_service_1.setTabMuted)(id, !summary?.muted);
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.tab.muteOthers', category: 'tab', labelKey: 'action.tab.muteOthers', when: 'global',
        run: ({ windowId, tabId }) => {
            if (!windowId)
                return;
            const id = tabId ?? activeTabIdOf(windowId);
            let n = 0;
            for (const t of (0, tab_service_1.listTabs)(windowId))
                if (t.id !== id && !t.muted) {
                    (0, tab_service_1.setTabMuted)(t.id, true);
                    n += 1;
                }
            broadcastToast(windowId, n > 0 ? `다른 탭 ${n}개 음소거됨 🔇` : '음소거할 다른 탭이 없습니다');
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.tab.unmuteAll', category: 'tab', labelKey: 'action.tab.unmuteAll', when: 'global',
        run: ({ windowId }) => {
            if (!windowId)
                return;
            let n = 0;
            for (const t of (0, tab_service_1.listTabs)(windowId))
                if (t.muted) {
                    (0, tab_service_1.setTabMuted)(t.id, false);
                    n += 1;
                }
            broadcastToast(windowId, n > 0 ? `${n}개 탭 음소거 해제 🔊` : '음소거된 탭이 없습니다');
        },
    });
    (0, registry_1.registerAction)({
        id: 'action.sitedata.clear', category: 'tools', labelKey: 'action.sitedata.clear', when: 'global',
        run: ({ windowId, tabId }) => {
            const id = tabId ?? activeTabIdOf(windowId);
            const wc = id ? (0, tab_service_1.getWebContentsByTabId)(id) : null;
            const url = wc?.getURL() ?? '';
            let origin = null;
            try {
                const u = new URL(url);
                if (u.protocol === 'http:' || u.protocol === 'https:')
                    origin = u.origin;
            }
            catch { /* invalid url */ }
            if (!origin) {
                broadcastToast(windowId, '이 페이지의 사이트 데이터는 지울 수 없습니다');
                return;
            }
            void (0, sitedata_1.clearSiteData)(origin).then(() => {
                broadcastToast(windowId, '사이트 데이터 삭제됨 · 새로고침 중… 🗑');
                try {
                    wc?.reload();
                }
                catch { /* ignore */ }
            });
        },
    });
    // 탭 직접 점프 액션은 명령 팔레트가 동적으로 생성 (action.tab.goto.<N>)
    for (let i = 1; i <= 9; i += 1) {
        const idx = i;
        (0, registry_1.registerAction)({
            id: `action.tab.goto.${idx}`, category: 'tab',
            labelKey: 'action.tab.goto', defaultKey: `Ctrl+${idx}`, when: 'global',
            run: ({ windowId }) => {
                if (!windowId)
                    return;
                const list = (0, tab_service_1.listTabs)(windowId);
                const target = idx === 9 ? list[list.length - 1] : list[idx - 1];
                if (target)
                    (0, tab_service_1.activateTab)(target.id);
            },
        });
    }
}
