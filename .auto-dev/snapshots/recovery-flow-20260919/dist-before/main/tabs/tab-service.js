"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tabEvents = void 0;
exports.onTabCreated = onTabCreated;
exports.onTabClosed = onTabClosed;
exports.onTabActivated = onTabActivated;
exports.onTabNavigated = onTabNavigated;
exports.onTabTitleUpdated = onTabTitleUpdated;
exports.onTabInPageNavigated = onTabInPageNavigated;
exports.createTab = createTab;
exports.activateTab = activateTab;
exports.closeTab = closeTab;
exports.splitWindow = splitWindow;
exports.unsplitWindow = unsplitWindow;
exports.focusNextPane = focusNextPane;
exports.focusPaneByIndex = focusPaneByIndex;
exports.setPaneSplitRatio = setPaneSplitRatio;
exports.beginPaneDrag = beginPaneDrag;
exports.endPaneDrag = endPaneDrag;
exports.getWindowLayout = getWindowLayout;
exports.moveTabToWorkspace = moveTabToWorkspace;
exports.restoreLastClosed = restoreLastClosed;
exports.listRecentlyClosed = listRecentlyClosed;
exports.reopenClosedById = reopenClosedById;
exports.clearRecentlyClosed = clearRecentlyClosed;
exports.listTabs = listTabs;
exports.listTabsInWorkspace = listTabsInWorkspace;
exports.getTab = getTab;
exports.getAllTabs = getAllTabs;
exports.getWebContentsByTabId = getWebContentsByTabId;
exports.getTabPartition = getTabPartition;
exports.findTabIdByWebContentsId = findTabIdByWebContentsId;
exports.pinTab = pinTab;
exports.reorderTabs = reorderTabs;
exports.listGroups = listGroups;
exports.createGroup = createGroup;
exports.updateGroup = updateGroup;
exports.setGroupCollapsed = setGroupCollapsed;
exports.removeGroup = removeGroup;
exports.assignTabToGroup = assignTabToGroup;
exports.navigateTab = navigateTab;
exports.setTabMuted = setTabMuted;
exports.tabBack = tabBack;
exports.tabForward = tabForward;
exports.tabReload = tabReload;
exports.tabStop = tabStop;
exports.duplicateTab = duplicateTab;
exports.captureTab = captureTab;
exports.getAllTabRecordsForSleep = getAllTabRecordsForSleep;
exports.isPinnedTab = isPinnedTab;
exports.isTabActive = isTabActive;
exports.discardTab = discardTab;
exports.undiscardTab = undiscardTab;
exports.getDiscardedCount = getDiscardedCount;
exports.getTotalTabCount = getTotalTabCount;
exports.collectSession = collectSession;
exports.registerRestoredGroups = registerRestoredGroups;
exports.collectLayouts = collectLayouts;
exports.restoreWorkspaceLayout = restoreWorkspaceLayout;
const electron_1 = require("electron");
const node_path_1 = __importDefault(require("node:path"));
const node_events_1 = require("node:events");
const constants_1 = require("../../shared/constants");
const ipc_channels_1 = require("../../shared/ipc-channels");
const window_service_1 = require("../windows/window-service");
const workspace_1 = require("../features/workspace");
const session_bootstrap_1 = require("../session-bootstrap");
const favicon_1 = require("../features/favicon");
const onTabCreatedHooks = [];
const onTabClosedHooks = [];
const onTabActivatedHooks = [];
function onTabCreated(cb) { onTabCreatedHooks.push(cb); }
function onTabClosed(cb) { onTabClosedHooks.push(cb); }
/** 활성 탭이 바뀔 때 — 확장 시스템의 `chrome.tabs.query({ active: true })` 가 이 신호를 쓴다. */
function onTabActivated(cb) { onTabActivatedHooks.push(cb); }
const MAX_HISTORY_ENTRIES = 30;
const MAX_PAGESTATE_BYTES = 512 * 1024;
function captureHistory(wc) {
    try {
        const nav = wc.navigationHistory;
        const all = nav.getAllEntries();
        if (!all || all.length === 0)
            return null;
        let activeIndex = nav.getActiveIndex();
        let entries = all;
        if (all.length > MAX_HISTORY_ENTRIES) {
            const start = all.length - MAX_HISTORY_ENTRIES;
            entries = all.slice(start);
            activeIndex = Math.max(0, activeIndex - start);
        }
        const out = entries.map((e) => {
            const snap = { url: e.url, title: e.title || e.url };
            // pageState 가 과도하게 크면(드뭄) 생략 — URL/제목 복원은 유지, 스크롤·폼만 포기
            if (e.pageState && e.pageState.length <= MAX_PAGESTATE_BYTES)
                snap.pageState = e.pageState;
            return snap;
        });
        const idx = Math.min(Math.max(0, activeIndex), out.length - 1);
        return { entries: out, index: idx };
    }
    catch {
        return null;
    }
}
/** 저장된 히스토리를 webContents 에 재생. 실패 시 활성 엔트리 URL 단독 로드로 폴백. */
function restoreNavigation(wc, entries, index) {
    const safeIdx = typeof index === 'number' ? Math.min(Math.max(0, index), entries.length - 1) : entries.length - 1;
    const fallbackUrl = entries[safeIdx]?.url ?? entries[entries.length - 1]?.url ?? constants_1.NEW_TAB_URL;
    try {
        const restorable = entries.map((e) => ({ url: e.url, title: e.title, pageState: e.pageState }));
        void wc.navigationHistory.restore({ entries: restorable, index: safeIdx })
            // 폴백은 **조용히** 하면 안 된다 — 이 경로로 떨어지면 URL 만 맞고 스크롤·폼은 사라진다.
            // (2026-09-15: 잠든 복원 탭을 깨울 때 여기로 떨어지는 것을 이 로그로 확인했다.)
            .catch((err) => {
            console.warn(`[tabs] navigationHistory.restore 실패 → 평문 로드로 폴백(스크롤·폼 유실): ${String(err)}`);
            void wc.loadURL(fallbackUrl);
        });
    }
    catch (err) {
        console.warn(`[tabs] navigationHistory.restore 예외 → 평문 로드로 폴백(스크롤·폼 유실): ${String(err)}`);
        void wc.loadURL(fallbackUrl);
    }
}
const tabs = new Map();
const closedStack = [];
let closedCounter = 0;
const resizeBound = new WeakSet();
let counter = 0;
// ===== 탭 그룹 (색상 그룹핑 · 접기) =====
const groups = new Map();
let groupCounter = 0;
const GROUP_COLORS = ['blue', 'red', 'green', 'yellow', 'purple', 'pink', 'orange', 'gray'];
// 그룹 색은 세션 스냅샷에 영속되고 외피가 CSS 변수(--group-color)로 쓴다.
// 렌더러가 보낸 값을 팔레트와 대조해 **아는 색일 때만** 받는다.
// (2026-09-07 임무 19: 워크스페이스에 같은 결함이 있어 객체 `{}` 가 색으로 저장됐다.
//  여기는 truthy 검사뿐이라 같은 값이 통과한다.)
function validGroupColor(v) {
    return typeof v === 'string' && GROUP_COLORS.includes(v) ? v : null;
}
// 윈도우+워크스페이스 별 layout — 워크스페이스 전환 시 분할 상태/활성 탭 별도 유지
const layoutByWindow = new Map();
function layoutKey(windowId, workspaceId) {
    return `${windowId}::${workspaceId}`;
}
function singleLayout() {
    return { panes: [{ tabId: null }], split: null, activePaneIdx: 0, splitRatio: 0.5 };
}
// 시크릿 창은 전역 워크스페이스와 무관한 고정 워크스페이스를 쓴다 — 메인 창에서 워크스페이스를 전환/삭제해도
// 시크릿 창의 탭 목록·레이아웃·가시성이 영향받지 않는다(전역 활성 ws 로 필터하면 시크릿 TabBar 가 비어버린다).
// 일반 창에서는 getActiveWorkspaceId() 를 그대로 반환 → 기존 동작 완전 불변.
function incognitoWs(windowId) { return 'incognito-ws-' + windowId; }
function effectiveActiveWs(windowId) {
    return (0, window_service_1.getWindow)(windowId)?.incognito ? incognitoWs(windowId) : (0, workspace_1.getActiveWorkspaceId)();
}
function getLayout(windowId, workspaceId) {
    const wsId = workspaceId ?? effectiveActiveWs(windowId);
    const key = layoutKey(windowId, wsId);
    let l = layoutByWindow.get(key);
    if (!l) {
        l = singleLayout();
        layoutByWindow.set(key, l);
    }
    return l;
}
function getActivePane(layout) {
    return layout.panes[layout.activePaneIdx] ?? layout.panes[0] ?? { tabId: null };
}
function getActiveTabId(windowId) {
    const wsId = effectiveActiveWs(windowId);
    const l = layoutByWindow.get(layoutKey(windowId, wsId));
    if (!l)
        return null;
    return getActivePane(l).tabId;
}
function paneIndexOfTab(layout, tabId) {
    return layout.panes.findIndex((p) => p.tabId === tabId);
}
const SPLITTER_THICKNESS = 4;
const PANE_OUTLINE = 2;
function paneBoundsOf(ctx, idx, layout) {
    const base = (0, window_service_1.getTabBounds)(ctx);
    if (layout.panes.length === 1 || layout.split === null)
        return base;
    const ratio = Math.max(0.15, Math.min(0.85, layout.splitRatio));
    // 외피의 splitter (4px) + 활성 pane outline (2px) 영역을 빼고 webContentsView 배치
    const inset = PANE_OUTLINE;
    if (layout.split === 'h') {
        const usable = Math.max(0, base.width - SPLITTER_THICKNESS);
        const first = Math.floor(usable * ratio);
        if (idx === 0) {
            return {
                x: base.x + inset, y: base.y + inset,
                width: Math.max(0, first - inset * 2),
                height: Math.max(0, base.height - inset * 2),
            };
        }
        return {
            x: base.x + first + SPLITTER_THICKNESS + inset, y: base.y + inset,
            width: Math.max(0, usable - first - inset * 2),
            height: Math.max(0, base.height - inset * 2),
        };
    }
    else {
        const usable = Math.max(0, base.height - SPLITTER_THICKNESS);
        const first = Math.floor(usable * ratio);
        if (idx === 0) {
            return {
                x: base.x + inset, y: base.y + inset,
                width: Math.max(0, base.width - inset * 2),
                height: Math.max(0, first - inset * 2),
            };
        }
        return {
            x: base.x + inset, y: base.y + first + SPLITTER_THICKNESS + inset,
            width: Math.max(0, base.width - inset * 2),
            height: Math.max(0, usable - first - inset * 2),
        };
    }
}
function reapplyLayout(windowId) {
    const ctx = (0, window_service_1.getWindow)(windowId);
    if (!ctx)
        return;
    const wsId = effectiveActiveWs(windowId);
    const layout = getLayout(windowId, wsId);
    const visibleTabIds = new Set();
    layout.panes.forEach((p, idx) => {
        if (!p.tabId)
            return;
        const tab = tabs.get(p.tabId);
        if (!tab)
            return;
        if (tab.workspaceId !== wsId)
            return;
        // 슬립(discarded)된 탭이 pane 에 배치되면 webContents 가 about:blank 라 빈 화면이 보인다.
        // 보이게 만들기 전에 원본 URL/히스토리로 깨운다. (닫기·분할·워크스페이스 전환 경로 모두 커버)
        if (tab.discarded)
            undiscardTab(tab.id);
        tab.view.setBounds(paneBoundsOf(ctx, idx, layout));
        tab.view.setVisible(true);
        visibleTabIds.add(p.tabId);
    });
    for (const t of tabs.values()) {
        if (t.windowId !== windowId)
            continue;
        if (!visibleTabIds.has(t.id))
            t.view.setVisible(false);
    }
    ctx.chrome.webContents.send(ipc_channels_1.IPC.windows.layoutChanged, {
        windowId,
        split: layout.split,
        splitRatio: layout.splitRatio,
        activePaneIdx: layout.activePaneIdx,
        panes: layout.panes.map((p) => ({ tabId: p.tabId })),
    });
}
exports.tabEvents = new node_events_1.EventEmitter();
function emitTabUpdate(tab) {
    const ctx = (0, window_service_1.getWindow)(tab.windowId);
    if (!ctx)
        return;
    ctx.chrome.webContents.send(ipc_channels_1.IPC.tabs.update, summary(tab));
    exports.tabEvents.emit('update', summary(tab));
}
function emitTabList(windowId) {
    const ctx = (0, window_service_1.getWindow)(windowId);
    if (!ctx)
        return;
    ctx.chrome.webContents.send(ipc_channels_1.IPC.tabs.listChanged, { windowId, tabs: listTabs(windowId) });
    exports.tabEvents.emit('list', windowId);
}
function summary(tab) {
    const wc = tab.view.webContents;
    const activeInWorkspace = getLayout(tab.windowId, tab.workspaceId);
    // 슬립된 탭은 원본 URL/제목 노출 (외피가 사용자에게 원본 정보 보여줌)
    const url = tab.discarded ? (tab.discardedUrl ?? wc.getURL()) : wc.getURL();
    const title = tab.discarded
        ? (tab.discardedTitle || tab.discardedUrl || '잠자는 탭')
        : (wc.getTitle() || wc.getURL() || '새 탭');
    return {
        id: tab.id,
        windowId: tab.windowId,
        workspaceId: tab.workspaceId,
        url,
        title,
        favicon: (0, favicon_1.getFavicon)(url),
        pinned: tab.pinned,
        audible: wc.isCurrentlyAudible(),
        muted: wc.isAudioMuted(),
        loading: tab.discarded ? false : wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        groupId: tab.groupId,
        active: getActivePane(activeInWorkspace).tabId === tab.id,
        index: tab.index,
        discarded: tab.discarded,
    };
}
function bindWindowResize(ctx) {
    if (resizeBound.has(ctx))
        return;
    resizeBound.add(ctx);
    (0, window_service_1.onWindowResize)(ctx, () => reapplyLayout(ctx.id));
}
(0, window_service_1.setShellInsetsHook)((windowId) => reapplyLayout(windowId));
// origin+pathname 만 비교(SPA 라우팅 경로 변경 감지용) — hash(#section) 만 바뀌면 동일 취급
function keyOf(u) {
    try {
        const p = new URL(u);
        return p.origin + p.pathname;
    }
    catch {
        return u;
    }
}
function bindWebContentsEvents(tab) {
    const wc = tab.view.webContents;
    let lastInPageKey = '';
    wc.on('page-title-updated', (_e, title) => {
        emitTabUpdate(tab);
        for (const hook of onTitleHooks) {
            try {
                hook({ id: tab.id, url: wc.getURL(), title });
            }
            catch (err) {
                console.warn('[tabs] title hook error', err);
            }
        }
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
        const favicon = favicons[0];
        (0, favicon_1.recordFavicon)(wc.getURL(), favicon);
        const ctx = (0, window_service_1.getWindow)(tab.windowId);
        if (!ctx)
            return;
        ctx.chrome.webContents.send(ipc_channels_1.IPC.tabs.update, { ...summary(tab), favicon });
    });
    wc.on('did-start-loading', () => emitTabUpdate(tab));
    wc.on('did-stop-loading', () => emitTabUpdate(tab));
    wc.on('did-navigate', () => {
        emitTabUpdate(tab);
        // 전체 내비게이션 — 다음 in-page 내비게이션 비교 기준을 리셋(후보 정리는 onTabNavigated 가 담당)
        lastInPageKey = keyOf(wc.getURL());
        for (const hook of onNavigateHooks) {
            try {
                hook({ id: tab.id, url: wc.getURL(), title: wc.getTitle() });
            }
            catch (err) {
                console.warn('[tabs] navigate hook error', err);
            }
        }
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
        emitTabUpdate(tab);
        // SPA(pushState) 경로 변경 시에만 발화 — hash 만 바뀐 경우(pathname 동일)는 무시
        if (!isMainFrame)
            return;
        const key = keyOf(url);
        if (key === lastInPageKey)
            return;
        lastInPageKey = key;
        for (const hook of onInPageNavHooks) {
            try {
                hook({ id: tab.id, url });
            }
            catch (err) {
                console.warn('[tabs] in-page navigate hook error', err);
            }
        }
    });
    wc.on('audio-state-changed', () => emitTabUpdate(tab));
}
const onNavigateHooks = [];
function onTabNavigated(cb) { onNavigateHooks.push(cb); }
const onTitleHooks = [];
function onTabTitleUpdated(cb) { onTitleHooks.push(cb); }
const onInPageNavHooks = [];
function onTabInPageNavigated(cb) { onInPageNavHooks.push(cb); }
function createTab(opts) {
    const ctx = (0, window_service_1.getWindow)(opts.windowId);
    if (!ctx)
        throw new Error(`window ${opts.windowId} not found`);
    bindWindowResize(ctx);
    counter += 1;
    const id = `tab-${counter}`;
    const initialUrl = opts.url ?? constants_1.NEW_TAB_URL;
    const preloadName = initialUrl.startsWith('browser:') ? 'internal.js' : 'content.js';
    // 시크릿 창은 전역 워크스페이스와 무관한 고정 워크스페이스에 속한다 — 메인 창 워크스페이스 전환/삭제에
    // 시크릿 탭이 휩쓸리지 않게 한다(listTabs/레이아웃/가시성이 effectiveActiveWs 로 이 고정 ws 를 쓴다).
    const workspaceId = ctx.incognito ? incognitoWs(opts.windowId) : (opts.workspaceId ?? (0, workspace_1.getActiveWorkspaceId)());
    // 시크릿 창은 워크스페이스 partition 대신 그 창의 in-memory incognito partition 강제 —
    // 워크스페이스 기능 자체는 시크릿 창에서 비활성(항상 같은 incognito 세션으로 고정).
    const partition = (ctx.incognito && ctx.incognitoPartition)
        ? ctx.incognitoPartition
        : (opts.partition ?? (workspaceId ? (0, workspace_1.getActivePartition)() : constants_1.DEFAULT_SESSION));
    // 새 partition 이라면 browser:// 프로토콜 + 권한 + policy webRequest 가 미설치 — 즉시 install (idempotent).
    // incognito partition 도 이 경로를 반드시 지나가므로(위 override), 회귀 #11/#12 계열(OS "browser 링크"
    // 다이얼로그)이 시크릿 창에서도 재발하지 않는다.
    (0, session_bootstrap_1.setupSessionByPartition)(partition);
    const view = new electron_1.WebContentsView({
        webPreferences: {
            preload: node_path_1.default.join(__dirname, '../../preload/', preloadName),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            // cross-origin iframe (video 임베드 플레이어 등) 안에도 preload 실행 — 동영상 오버레이 등 콘텐츠 후킹용
            // sandbox+contextIsolation 그대로라 보안 모델 동일
            nodeIntegrationInSubFrames: true,
            // Chromium 내장 PDF 뷰어(pdfium) 활성화 — .pdf 를 다운로드 대신 인라인 표시. NPAPI 가 아니라 안전.
            plugins: true,
            partition,
        },
    });
    ctx.win.contentView.addChildView(view);
    view.setBounds((0, window_service_1.getTabBounds)(ctx));
    view.webContents.setWindowOpenHandler(({ url }) => {
        (0, window_service_1.routeWindowOpen)(opts.windowId, url, { sourceTabId: id });
        return { action: 'deny' };
    });
    const existingInWorkspace = listAllTabsInWindow(opts.windowId).filter((t) => t.workspaceId === workspaceId);
    const index = existingInWorkspace.length;
    const tab = {
        id, windowId: opts.windowId, workspaceId, view,
        partition,
        pinned: false, index,
        createdAt: Date.now(), lastActiveAt: Date.now(), discarded: false,
    };
    if (opts.groupId && groups.has(opts.groupId))
        tab.groupId = opts.groupId;
    tabs.set(id, tab);
    bindWebContentsEvents(tab);
    for (const hook of onTabCreatedHooks) {
        try {
            hook({ id, webContentsId: view.webContents.id });
        }
        catch (err) {
            console.warn('[tabs] hook error', err);
        }
    }
    const canDiscard = opts.restoreDiscarded === true && /^https?:/i.test(initialUrl);
    if (canDiscard) {
        // 세션 복원 시 즉시 로드하지 않고 슬립 상태로 — 외피는 원본 URL/제목을 보여주고, 클릭 시 lazy load
        tab.discarded = true;
        tab.discardedUrl = initialUrl;
        tab.discardedTitle = opts.restoreTitle || initialUrl;
        if (opts.restoreHistory && opts.restoreHistory.length > 0) {
            tab.discardedHistory = opts.restoreHistory;
            tab.discardedIndex = opts.restoreHistoryIndex;
            // ⚠ 여기서 about:blank 를 **커밋하지 않는다**. 갓 만든 WebContentsView 는 이미 빈 문서라
            //   메모리상 차이가 없는데, about:blank 를 한 번 커밋해 버리면 나중에 깨울 때
            //   `navigationHistory.restore()` 가 **성공은 하지만 pageState(스크롤·폼)가 적용되지 않는다**
            //   (2026-09-15 실측: 복원 실패 로그 없이 scrollY=0·폼 빈 값. Electron 35·42 동일).
            //   히스토리가 없는 경우에만 예전처럼 비워 둔다.
        }
        else {
            void view.webContents.loadURL('about:blank');
        }
    }
    else if (opts.restoreHistory && opts.restoreHistory.length > 0) {
        // 즉시 로드 대상 복원 탭: 히스토리 재생(뒤로/앞으로 + 스크롤/폼 복원)
        restoreNavigation(view.webContents, opts.restoreHistory, opts.restoreHistoryIndex);
    }
    else {
        void view.webContents.loadURL(initialUrl);
    }
    // 이 탭이 active workspace 가 아니면 항상 invisible
    const isActiveWorkspace = workspaceId === effectiveActiveWs(opts.windowId);
    const hadActive = isActiveWorkspace && getActiveTabId(opts.windowId) !== null;
    if (isActiveWorkspace && (!opts.background || !hadActive) && !canDiscard) {
        activateTabInternal(tab);
    }
    else {
        view.setVisible(false);
    }
    emitTabList(opts.windowId);
    return summary(tab);
}
function activateTabInternal(tab) {
    // 슬립된 탭이면 복원 (about:blank → 히스토리 재생 또는 원본 URL)
    if (tab.discarded && tab.discardedUrl) {
        const url = tab.discardedUrl;
        const history = tab.discardedHistory;
        const idx = tab.discardedIndex;
        tab.discarded = false;
        tab.discardedUrl = undefined;
        tab.discardedTitle = undefined;
        tab.discardedHistory = undefined;
        tab.discardedIndex = undefined;
        if (history && history.length > 0)
            restoreNavigation(tab.view.webContents, history, idx);
        else
            void tab.view.webContents.loadURL(url);
    }
    // 워크스페이스의 layout 만 변경 (활성 workspace 가 아니면 visible 변화는 후행 전환 시 반영)
    const layout = getLayout(tab.windowId, tab.workspaceId);
    // 이 탭이 이미 다른 pane 에 표시 중이면, 활성 pane 의 tabId 를 덮어써서 같은 탭이 두 pane 에
    // 중복(→ 한 pane 이 빈 화면)되는 것을 막고, 대신 그 pane 을 활성 pane 으로 만든다.
    const existingPane = paneIndexOfTab(layout, tab.id);
    if (existingPane >= 0) {
        layout.activePaneIdx = existingPane;
    }
    else {
        getActivePane(layout).tabId = tab.id;
    }
    tab.lastActiveAt = Date.now();
    if (tab.workspaceId === effectiveActiveWs(tab.windowId)) {
        reapplyLayout(tab.windowId);
    }
    emitTabList(tab.windowId);
    for (const cb of onTabActivatedHooks) {
        try {
            cb(tab.id);
        }
        catch { /* 훅 하나가 활성화를 막지 않도록 */ }
    }
}
function activateTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab)
        return;
    activateTabInternal(tab);
}
function closeTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab)
        return;
    const ctx = (0, window_service_1.getWindow)(tab.windowId);
    if (ctx)
        ctx.win.contentView.removeChildView(tab.view);
    // 슬립(discarded) 탭은 webContents 가 about:blank 이므로 원본 URL/제목 사용
    const closedUrl = tab.discarded ? (tab.discardedUrl ?? tab.view.webContents.getURL()) : tab.view.webContents.getURL();
    const closedTitle = tab.discarded ? (tab.discardedTitle ?? closedUrl) : (tab.view.webContents.getTitle() || closedUrl);
    // 시크릿 탭은 "최근 닫은 탭" 스택에도 남기지 않는다 — 다른(비시크릿) 탭에서 Ctrl+Shift+T 로 복원되면 안 됨.
    if (!tab.partition.startsWith('incognito')
        && /^https?:|^browser:/i.test(closedUrl) && !/^browser:\/\/newtab/i.test(closedUrl)) {
        closedCounter += 1;
        closedStack.push({
            id: closedCounter, url: closedUrl, title: closedTitle, windowId: tab.windowId,
            index: tab.index, workspaceId: tab.workspaceId, groupId: tab.groupId, closedAt: Date.now(),
        });
        if (closedStack.length > 50)
            closedStack.shift();
    }
    tab.view.webContents.close();
    const closedGroupId = tab.groupId;
    tabs.delete(tabId);
    for (const hook of onTabClosedHooks) {
        try {
            hook(tabId);
        }
        catch (err) {
            console.warn('[tabs] close hook error', err);
        }
    }
    // 그룹의 마지막 탭이 닫혔으면 빈 그룹 정리
    if (closedGroupId) {
        pruneEmptyGroups(tab.windowId);
        if (!groups.has(closedGroupId))
            emitGroups(tab.windowId);
    }
    // 닫힌 탭이 어느 pane 에 보였다면 그 pane 을 동일 워크스페이스 다른 탭으로 채우거나 단일화
    const layout = getLayout(tab.windowId, tab.workspaceId);
    const paneIdx = paneIndexOfTab(layout, tabId);
    if (paneIdx >= 0) {
        const otherTabs = listAllTabsInWindow(tab.windowId)
            .filter((t) => t.workspaceId === tab.workspaceId)
            .filter((t) => !layout.panes.some((p) => p.tabId === t.id))
            .map(summary);
        if (otherTabs.length > 0) {
            const next = otherTabs[Math.min(tab.index, otherTabs.length - 1)] ?? otherTabs[0];
            layout.panes[paneIdx].tabId = next ? next.id : null;
        }
        else {
            // 다른 탭 없음 → 분할 모드라면 단일화, 단일이면 빈 pane
            if (layout.panes.length > 1) {
                const keepIdx = paneIdx === 0 ? 1 : 0;
                const keep = layout.panes[keepIdx];
                layoutByWindow.set(layoutKey(tab.windowId, tab.workspaceId), {
                    panes: [keep ?? { tabId: null }],
                    split: null,
                    activePaneIdx: 0,
                    splitRatio: 0.5,
                });
            }
            else {
                layout.panes[0].tabId = null;
            }
        }
    }
    reindex(tab.windowId, tab.workspaceId);
    if (tab.workspaceId === effectiveActiveWs(tab.windowId))
        reapplyLayout(tab.windowId);
    emitTabList(tab.windowId);
}
// ===== 분할 화면 (panes) =====
function splitWindow(windowId, dir) {
    const wsId = effectiveActiveWs(windowId);
    const layout = getLayout(windowId, wsId);
    if (layout.panes.length >= 2) {
        if (layout.split !== dir) {
            layout.split = dir;
            reapplyLayout(windowId);
        }
        return;
    }
    const currentActive = getActiveTabId(windowId);
    const otherTabs = listTabs(windowId).filter((t) => t.id !== currentActive);
    let secondTabId;
    if (otherTabs.length > 0) {
        secondTabId = (otherTabs[otherTabs.length - 1] ?? otherTabs[0]).id;
    }
    else {
        const newTab = createTab({ windowId, url: constants_1.NEW_TAB_URL, background: true, workspaceId: wsId });
        secondTabId = newTab.id;
    }
    layout.panes.push({ tabId: secondTabId });
    layout.split = dir;
    layout.activePaneIdx = 0;
    layout.splitRatio = 0.5;
    reapplyLayout(windowId);
    emitTabList(windowId);
}
function unsplitWindow(windowId) {
    const wsId = effectiveActiveWs(windowId);
    const layout = getLayout(windowId, wsId);
    if (layout.panes.length < 2)
        return;
    const keep = layout.panes[layout.activePaneIdx] ?? layout.panes[0];
    layoutByWindow.set(layoutKey(windowId, wsId), {
        panes: [keep ?? { tabId: null }],
        split: null,
        activePaneIdx: 0,
        splitRatio: 0.5,
    });
    reapplyLayout(windowId);
    emitTabList(windowId);
}
function focusNextPane(windowId) {
    const layout = getLayout(windowId);
    if (layout.panes.length < 2)
        return;
    layout.activePaneIdx = (layout.activePaneIdx + 1) % layout.panes.length;
    emitTabList(windowId);
    reapplyLayout(windowId);
}
function focusPaneByIndex(windowId, idx) {
    const layout = getLayout(windowId);
    if (idx < 0 || idx >= layout.panes.length)
        return;
    if (layout.activePaneIdx === idx)
        return;
    layout.activePaneIdx = idx;
    emitTabList(windowId);
    reapplyLayout(windowId);
}
function setPaneSplitRatio(windowId, ratio) {
    const layout = getLayout(windowId);
    if (layout.panes.length < 2 || layout.split === null)
        return;
    const clamped = Math.max(0.15, Math.min(0.85, ratio));
    if (Math.abs(layout.splitRatio - clamped) < 0.001)
        return;
    layout.splitRatio = clamped;
    reapplyLayout(windowId);
}
function beginPaneDrag(windowId) {
    // drag 동안 chrome view 를 가장 위로 올려 마우스 이벤트를 외피가 받게 한다.
    // 탭 view 가 가운데 영역에 있어도, 외피의 splitter 가 마우스 capture 가능해야 ratio 변경.
    (0, window_service_1.bringChromeToFront)(windowId);
}
function endPaneDrag(windowId) {
    // 모든 탭 view 를 z-order 의 가장 위로 다시 올리고 chrome 은 그 아래로.
    // contentView 의 child 목록을 재구성: chrome 먼저, 그 다음 모든 windowId 의 탭 view
    const ctx = (0, window_service_1.getWindow)(windowId);
    if (!ctx)
        return;
    const windowTabs = Array.from(tabs.values()).filter((t) => t.windowId === windowId);
    try {
        // 모든 view 제거 후 다시 add — chrome 먼저, 탭 view 들 다음 (위)
        ctx.win.contentView.removeChildView(ctx.chrome);
        for (const t of windowTabs)
            ctx.win.contentView.removeChildView(t.view);
        ctx.win.contentView.addChildView(ctx.chrome);
        for (const t of windowTabs)
            ctx.win.contentView.addChildView(t.view);
    }
    catch (err) {
        console.warn('[tabs] endPaneDrag reorder failed', err);
    }
    reapplyLayout(windowId);
}
function getWindowLayout(windowId) {
    const l = getLayout(windowId);
    return {
        split: l.split,
        paneCount: l.panes.length,
        activePaneIdx: l.activePaneIdx,
        panes: l.panes.map((p) => ({ tabId: p.tabId })),
    };
}
function detachFromLayout(tab, wsId) {
    const layout = getLayout(tab.windowId, wsId);
    const paneIdx = paneIndexOfTab(layout, tab.id);
    if (paneIdx < 0)
        return;
    const others = listAllTabsInWindow(tab.windowId)
        .filter((t) => t.workspaceId === wsId && t.id !== tab.id)
        .filter((t) => !layout.panes.some((p) => p.tabId === t.id));
    if (others.length > 0) {
        const next = others[Math.min(tab.index, others.length - 1)] ?? others[0];
        layout.panes[paneIdx].tabId = next ? next.id : null;
    }
    else if (layout.panes.length > 1) {
        const keepIdx = paneIdx === 0 ? 1 : 0;
        const keep = layout.panes[keepIdx];
        layoutByWindow.set(layoutKey(tab.windowId, wsId), {
            panes: [keep ?? { tabId: null }],
            split: null,
            activePaneIdx: 0,
            splitRatio: 0.5,
        });
    }
    else {
        layout.panes[0].tabId = null;
    }
}
function moveTabToWorkspace(tabId, targetWorkspaceId) {
    const tab = tabs.get(tabId);
    if (!tab)
        return { moved: false, needsReload: false, reason: 'tab-not-found' };
    if (tab.workspaceId === targetWorkspaceId) {
        return { moved: false, needsReload: false, reason: 'same-workspace' };
    }
    const target = (0, workspace_1.getWorkspace)(targetWorkspaceId);
    if (!target)
        return { moved: false, needsReload: false, reason: 'target-not-found' };
    const oldWsId = tab.workspaceId;
    const activeWsId = (0, workspace_1.getActiveWorkspaceId)();
    if (tab.partition === target.partition) {
        detachFromLayout(tab, oldWsId);
        tab.workspaceId = targetWorkspaceId;
        tab.index = listAllTabsInWindow(tab.windowId)
            .filter((t) => t.workspaceId === targetWorkspaceId && t.id !== tabId).length;
        if (targetWorkspaceId === activeWsId) {
            const layout = getLayout(tab.windowId, targetWorkspaceId);
            getActivePane(layout).tabId = tabId;
        }
        else {
            tab.view.setVisible(false);
        }
        reindex(tab.windowId, oldWsId);
        reindex(tab.windowId, targetWorkspaceId);
        if (oldWsId === activeWsId || targetWorkspaceId === activeWsId)
            reapplyLayout(tab.windowId);
        emitTabList(tab.windowId);
        return { moved: true, needsReload: false };
    }
    // 잠자는(discarded) 탭은 webContents 가 about:blank 이므로 보존된 원본 URL 을 쓴다.
    const url = tab.discarded && tab.discardedUrl ? tab.discardedUrl : tab.view.webContents.getURL();
    const pinned = tab.pinned;
    const newTab = createTab({
        windowId: tab.windowId,
        url,
        workspaceId: targetWorkspaceId,
        background: targetWorkspaceId !== activeWsId,
    });
    if (pinned)
        pinTab(newTab.id, true);
    closeTab(tabId);
    return { moved: true, needsReload: true, newTabId: newTab.id };
}
function restoreLastClosed(windowId) {
    const wsId = effectiveActiveWs(windowId);
    // 활성 워크스페이스의 가장 최근 닫힌 탭 우선 — 없으면 어느 ws 든 가장 최근
    let idx = -1;
    for (let i = closedStack.length - 1; i >= 0; i -= 1) {
        if (closedStack[i]?.workspaceId === wsId) {
            idx = i;
            break;
        }
    }
    if (idx < 0)
        idx = closedStack.length - 1;
    if (idx < 0)
        return null;
    const [last] = closedStack.splice(idx, 1);
    if (!last)
        return null;
    // 활성 워크스페이스에 복원 → 항상 보이게. (다른 ws 로 복원하면 숨은 채 생겨 사용자가 반복 클릭 →
    // 숨은 중복 탭이 쌓인다.) 활성 ws 에 원래 항목이 있으면 last.workspaceId===wsId 라 동일.
    return createTab({ windowId, url: last.url, workspaceId: wsId });
}
/** 최근 닫은 탭 목록 (최신 우선). */
function listRecentlyClosed(limit = 30) {
    const out = [];
    for (let i = closedStack.length - 1; i >= 0 && out.length < limit; i -= 1) {
        const e = closedStack[i];
        if (e)
            out.push({ id: e.id, url: e.url, title: e.title, closedAt: e.closedAt });
    }
    return out;
}
/** 특정 닫은 탭을 다시 열기 (스택에서 제거). */
function reopenClosedById(id, windowId) {
    const idx = closedStack.findIndex((e) => e.id === id);
    if (idx < 0)
        return null;
    const [e] = closedStack.splice(idx, 1);
    if (!e)
        return null;
    // restoreLastClosed 와 동일하게 활성 워크스페이스에 복원 → 항상 보이게(원래 ws 가 비활성이면 숨은 탭이
    // 생겨 목록에서 클릭이 무반응처럼 보인다). groupId 는 활성 ws 와 같을 때만 유지.
    const wsId = effectiveActiveWs(windowId);
    const keepGroup = e.workspaceId === wsId ? e.groupId : undefined;
    return createTab({ windowId, url: e.url, workspaceId: wsId, groupId: keepGroup });
}
function clearRecentlyClosed() {
    closedStack.length = 0;
}
function listTabs(windowId) {
    const wsId = effectiveActiveWs(windowId);
    return Array.from(tabs.values())
        .filter((t) => t.windowId === windowId && t.workspaceId === wsId)
        .sort((a, b) => a.index - b.index)
        .map(summary);
}
function listAllTabsInWindow(windowId) {
    return Array.from(tabs.values()).filter((t) => t.windowId === windowId);
}
function listTabsInWorkspace(windowId, workspaceId) {
    return Array.from(tabs.values())
        .filter((t) => t.windowId === windowId && t.workspaceId === workspaceId)
        .sort((a, b) => a.index - b.index)
        .map(summary);
}
function getTab(tabId) {
    const t = tabs.get(tabId);
    return t ? summary(t) : null;
}
function getAllTabs() {
    return Array.from(tabs.values()).map(summary);
}
function getWebContentsByTabId(tabId) {
    return tabs.get(tabId)?.view.webContents ?? null;
}
/** 탭이 사용하는 세션 파티션 문자열(쿠키·이어받기 세션 복원용). */
function getTabPartition(tabId) {
    return tabs.get(tabId)?.partition;
}
function findTabIdByWebContentsId(wcId) {
    for (const t of tabs.values()) {
        if (t.view.webContents.id === wcId) {
            return { tabId: t.id, windowId: t.windowId };
        }
    }
    return null;
}
function pinTab(tabId, pinned) {
    const tab = tabs.get(tabId);
    if (!tab)
        return;
    tab.pinned = pinned;
    // 탭이 속한 워크스페이스를 재정렬해야 한다 — 인자 없으면 활성 ws 가 기본이라
    // 세션 복원 중 비활성 ws 의 핀 탭을 정렬 못 하고 활성 ws 만 헛되이 재정렬한다.
    reindex(tab.windowId, tab.workspaceId);
    emitTabList(tab.windowId);
}
function reorderTabs(windowId, orderedIds) {
    orderedIds.forEach((id, i) => {
        const t = tabs.get(id);
        if (t && t.windowId === windowId)
            t.index = i;
    });
    reindex(windowId, effectiveActiveWs(windowId));
    emitTabList(windowId);
}
function reindex(windowId, workspaceId) {
    const wsId = workspaceId ?? effectiveActiveWs(windowId);
    const list = Array.from(tabs.values()).filter((t) => t.windowId === windowId && t.workspaceId === wsId);
    // 그룹 멤버는 인접하게 클러스터링 — 그룹의 rank = 멤버 중 최소 index, 그 위치에 모임
    const groupMin = new Map();
    for (const t of list) {
        if (!t.groupId)
            continue;
        const cur = groupMin.get(t.groupId);
        if (cur === undefined || t.index < cur)
            groupMin.set(t.groupId, t.index);
    }
    const rankOf = (t) => (t.groupId != null ? (groupMin.get(t.groupId) ?? t.index) : t.index);
    list.sort((a, b) => {
        if (a.pinned !== b.pinned)
            return a.pinned ? -1 : 1;
        const ra = rankOf(a);
        const rb = rankOf(b);
        if (ra !== rb)
            return ra - rb;
        return a.index - b.index;
    });
    list.forEach((t, i) => { t.index = i; });
}
// ===== 그룹 CRUD =====
function emitGroups(windowId) {
    const ctx = (0, window_service_1.getWindow)(windowId);
    if (!ctx)
        return;
    ctx.chrome.webContents.send(ipc_channels_1.IPC.groups.changed, { windowId, groups: listGroups(windowId) });
}
function listGroups(windowId) {
    return Array.from(groups.values()).filter((g) => g.windowId === windowId);
}
function createGroup(windowId, opts) {
    const ctx = (0, window_service_1.getWindow)(windowId);
    if (!ctx)
        return null;
    groupCounter += 1;
    const id = `group-${groupCounter}`;
    const color = validGroupColor(opts?.color) ?? GROUP_COLORS[groupCounter % GROUP_COLORS.length];
    const title = typeof opts?.title === 'string' && opts.title ? opts.title : '새 그룹';
    const group = { id, windowId, title, color, collapsed: false };
    groups.set(id, group);
    let wsForReindex;
    if (opts?.tabIds) {
        for (const tid of opts.tabIds) {
            const t = tabs.get(tid);
            if (t && t.windowId === windowId) {
                t.groupId = id;
                wsForReindex = t.workspaceId;
            }
        }
    }
    reindex(windowId, wsForReindex);
    emitGroups(windowId);
    emitTabList(windowId);
    return group;
}
function updateGroup(groupId, patch) {
    const g = groups.get(groupId);
    if (!g)
        return;
    if (typeof patch.title === 'string')
        g.title = patch.title;
    const color = validGroupColor(patch.color);
    if (color)
        g.color = color;
    emitGroups(g.windowId);
    emitTabList(g.windowId);
}
function setGroupCollapsed(groupId, collapsed) {
    const g = groups.get(groupId);
    if (!g)
        return;
    g.collapsed = collapsed;
    emitGroups(g.windowId);
    emitTabList(g.windowId);
}
function removeGroup(groupId) {
    const g = groups.get(groupId);
    if (!g)
        return;
    const wid = g.windowId;
    for (const t of tabs.values())
        if (t.groupId === groupId)
            t.groupId = undefined;
    groups.delete(groupId);
    reindex(wid);
    emitGroups(wid);
    emitTabList(wid);
}
function assignTabToGroup(tabId, groupId) {
    const t = tabs.get(tabId);
    if (!t)
        return;
    if (groupId && !groups.has(groupId))
        return;
    t.groupId = groupId ?? undefined;
    reindex(t.windowId, t.workspaceId);
    pruneEmptyGroups(t.windowId);
    emitGroups(t.windowId);
    emitTabList(t.windowId);
}
function pruneEmptyGroups(windowId) {
    const used = new Set();
    for (const t of tabs.values())
        if (t.windowId === windowId && t.groupId)
            used.add(t.groupId);
    for (const g of Array.from(groups.values())) {
        if (g.windowId === windowId && !used.has(g.id))
            groups.delete(g.id);
    }
}
function navigateTab(tabId, url) {
    const tab = tabs.get(tabId);
    if (!tab)
        return;
    void tab.view.webContents.loadURL(url);
}
function setTabMuted(tabId, muted) {
    const tab = tabs.get(tabId);
    if (!tab)
        return;
    tab.view.webContents.setAudioMuted(muted);
    emitTabUpdate(tab);
}
function tabBack(tabId) {
    const wc = tabs.get(tabId)?.view.webContents;
    if (wc?.navigationHistory.canGoBack())
        wc.navigationHistory.goBack();
}
function tabForward(tabId) {
    const wc = tabs.get(tabId)?.view.webContents;
    if (wc?.navigationHistory.canGoForward())
        wc.navigationHistory.goForward();
}
function tabReload(tabId) {
    tabs.get(tabId)?.view.webContents.reload();
}
function tabStop(tabId) {
    tabs.get(tabId)?.view.webContents.stop();
}
function duplicateTab(tabId) {
    const t = tabs.get(tabId);
    if (!t)
        return null;
    // 잠자는 탭은 about:blank 이므로 보존된 원본 URL 로 복제.
    const url = t.discarded && t.discardedUrl ? t.discardedUrl : t.view.webContents.getURL();
    return createTab({ windowId: t.windowId, url });
}
async function captureTab(tabId) {
    const wc = tabs.get(tabId)?.view.webContents;
    if (!wc)
        return null;
    const img = await wc.capturePage();
    return img.toDataURL();
}
function getAllTabRecordsForSleep() {
    return Array.from(tabs.values()).filter((t) => !t.view.webContents.isDestroyed()).map((t) => ({
        id: t.id,
        url: t.view.webContents.getURL(),
        title: t.view.webContents.getTitle(),
        pinned: t.pinned,
        lastActiveAt: t.lastActiveAt,
        discarded: t.discarded,
    }));
}
function isPinnedTab(tabId) {
    return tabs.get(tabId)?.pinned ?? false;
}
function isTabActive(tabId) {
    for (const l of layoutByWindow.values()) {
        if (l.panes.some((p) => p.tabId === tabId))
            return true;
    }
    return false;
}
function discardTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || tab.discarded)
        return false;
    if (isTabActive(tabId))
        return false;
    const wc = tab.view.webContents;
    const url = wc.getURL();
    if (!url || /^browser:|^about:/i.test(url))
        return false;
    tab.discardedUrl = url;
    tab.discardedTitle = wc.getTitle() || url;
    // 슬립 전 히스토리(뒤로/앞으로 + 스크롤/폼) 보존 — 깨울 때 그대로 복원
    const hist = captureHistory(wc);
    if (hist) {
        tab.discardedHistory = hist.entries;
        tab.discardedIndex = hist.index;
    }
    tab.discarded = true;
    void wc.loadURL('about:blank');
    emitTabUpdate(tab);
    return true;
}
function undiscardTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || !tab.discarded)
        return false;
    const url = tab.discardedUrl;
    const history = tab.discardedHistory;
    const idx = tab.discardedIndex;
    tab.discarded = false;
    tab.discardedUrl = undefined;
    tab.discardedTitle = undefined;
    tab.discardedHistory = undefined;
    tab.discardedIndex = undefined;
    if (history && history.length > 0)
        restoreNavigation(tab.view.webContents, history, idx);
    else if (url)
        void tab.view.webContents.loadURL(url);
    emitTabUpdate(tab);
    return true;
}
function getDiscardedCount() {
    let n = 0;
    for (const t of tabs.values())
        if (t.discarded)
            n += 1;
    return n;
}
function getTotalTabCount() {
    return tabs.size;
}
/** 현재 열린 창·탭을 세션 스냅샷으로 수집. 시크릿(incognito) 파티션과 빈 탭은 제외. */
function collectSession() {
    const byWindow = new Map();
    for (const t of tabs.values()) {
        if (t.view.webContents.isDestroyed())
            continue;
        if (t.partition.startsWith('incognito'))
            continue;
        const wc = t.view.webContents;
        const url = t.discarded ? (t.discardedUrl ?? '') : wc.getURL();
        if (!url || /^about:blank$/i.test(url))
            continue;
        if (!/^https?:|^browser:/i.test(url))
            continue;
        let snap = byWindow.get(t.windowId);
        if (!snap) {
            const ctx = (0, window_service_1.getWindow)(t.windowId);
            if (!ctx)
                continue;
            snap = {
                windowId: t.windowId,
                bounds: ctx.win.getBounds(),
                activeTabId: getActiveTabId(t.windowId),
                tabs: [],
            };
            byWindow.set(t.windowId, snap);
        }
        const title = t.discarded
            ? (t.discardedTitle || url)
            : (wc.getTitle() || url);
        // 히스토리: 깨어있으면 라이브 캡처, 슬립 중이면 보존해 둔 것 사용
        let history;
        let historyIndex;
        if (t.discarded) {
            if (t.discardedHistory && t.discardedHistory.length > 0) {
                history = t.discardedHistory;
                historyIndex = t.discardedIndex;
            }
        }
        else {
            const cap = captureHistory(wc);
            if (cap) {
                history = cap.entries;
                historyIndex = cap.index;
            }
        }
        snap.tabs.push({
            url,
            title,
            pinned: t.pinned,
            workspaceId: t.workspaceId,
            active: getActivePane(getLayout(t.windowId, t.workspaceId)).tabId === t.id,
            index: t.index,
            history,
            historyIndex,
            groupId: t.groupId,
        });
    }
    // 인덱스 정렬 + 분할 레이아웃 + 그룹 수집
    for (const snap of byWindow.values()) {
        snap.tabs.sort((a, b) => a.index - b.index);
        const layouts = collectLayouts(snap.windowId);
        if (layouts.length > 0)
            snap.layouts = layouts;
        // 스냅샷에 포함된 탭이 실제로 속한 그룹만 저장
        const usedGroupIds = new Set();
        for (const t of snap.tabs)
            if (t.groupId)
                usedGroupIds.add(t.groupId);
        const wGroups = listGroups(snap.windowId).filter((g) => usedGroupIds.has(g.id));
        if (wGroups.length > 0)
            snap.groups = wGroups;
    }
    return Array.from(byWindow.values()).filter((w) => w.tabs.length > 0);
}
/** 세션 복원 시 그룹을 원래 id 로 재등록(탭 groupId 와 매칭). groupCounter 충돌 방지로 카운터 보정. */
function registerRestoredGroups(windowId, restored) {
    for (const g of restored) {
        groups.set(g.id, { id: g.id, windowId, title: g.title, color: g.color, collapsed: !!g.collapsed });
        const m = /^group-(\d+)$/.exec(g.id);
        if (m)
            groupCounter = Math.max(groupCounter, Number(m[1]));
    }
}
function splitKeyWindow(key) {
    const i = key.indexOf('::');
    if (i < 0)
        return null;
    return { windowId: key.slice(0, i), workspaceId: key.slice(i + 2) };
}
/** 한 창의 워크스페이스별 분할 레이아웃 수집 (단일 pane 은 복원할 게 없으므로 제외). */
function collectLayouts(windowId) {
    const out = [];
    for (const [key, layout] of layoutByWindow) {
        const parsed = splitKeyWindow(key);
        if (!parsed || parsed.windowId !== windowId)
            continue;
        if (!layout.split || layout.panes.length < 2)
            continue;
        const panes = layout.panes.map((p) => {
            if (!p.tabId)
                return { tabIndex: null };
            const t = tabs.get(p.tabId);
            return { tabIndex: t ? t.index : null };
        });
        // 최소 하나의 pane 에 탭이 있어야 의미 있음
        if (!panes.some((p) => p.tabIndex != null))
            continue;
        out.push({
            workspaceId: parsed.workspaceId,
            split: layout.split,
            splitRatio: layout.splitRatio,
            activePaneIdx: layout.activePaneIdx,
            panes,
        });
    }
    return out;
}
/** 저장된 분할 레이아웃을 복원. resolve(workspaceId, tabIndex) → 새 tabId 로 pane 을 재매핑. */
function restoreWorkspaceLayout(windowId, snap, resolve) {
    if (!snap.split || !Array.isArray(snap.panes) || snap.panes.length < 2)
        return;
    const panes = snap.panes.map((p) => ({
        tabId: p.tabIndex == null ? null : resolve(snap.workspaceId, p.tabIndex),
    }));
    // pane0 에 탭이 없으면(매핑 실패) 복원 의미 없음 — 건너뜀
    if (!panes[0]?.tabId)
        return;
    layoutByWindow.set(layoutKey(windowId, snap.workspaceId), {
        panes,
        split: snap.split,
        activePaneIdx: Math.min(Math.max(0, snap.activePaneIdx), panes.length - 1),
        splitRatio: Math.max(0.15, Math.min(0.85, snap.splitRatio || 0.5)),
    });
    if (snap.workspaceId === (0, workspace_1.getActiveWorkspaceId)())
        reapplyLayout(windowId);
}
// 창이 닫히면 그 창의 탭·레이아웃·그룹을 정리 — webContents 는 이미 파괴됐을 수 있으므로
// closeTab() 을 쓰지 않고 직접 정리한다.
window_service_1.windowEvents.on('closed', (ctx) => {
    const doomed = Array.from(tabs.values()).filter((t) => t.windowId === ctx.id);
    for (const t of doomed) {
        try {
            if (!t.view.webContents.isDestroyed())
                t.view.webContents.close();
        }
        catch { /* ignore */ }
        tabs.delete(t.id);
        for (const hook of onTabClosedHooks) {
            try {
                hook(t.id);
            }
            catch (err) {
                console.warn('[tabs] close hook error', err);
            }
        }
    }
    for (const key of Array.from(layoutByWindow.keys())) {
        if (key.startsWith(`${ctx.id}::`))
            layoutByWindow.delete(key);
    }
    for (const g of Array.from(groups.values())) {
        if (g.windowId === ctx.id)
            groups.delete(g.id);
    }
    if (doomed.length > 0)
        exports.tabEvents.emit('list', ctx.id);
});
electron_1.app.on('window-all-closed', () => {
    tabs.clear();
    layoutByWindow.clear();
});
// ===== 워크스페이스 전환 ↔ 탭 view 가시성 =====
workspace_1.workspaceEvents.on('activated', ({ id }) => {
    const windowIds = new Set();
    for (const t of tabs.values())
        windowIds.add(t.windowId);
    for (const wid of windowIds) {
        const ctx = (0, window_service_1.getWindow)(wid);
        if (!ctx)
            continue;
        if (ctx.incognito)
            continue; // 시크릿 창은 고정 세션 — 전역 워크스페이스 전환에 영향받지 않음(탭 숨김·홈탭 자동생성 금지)
        // 새 active workspace 의 첫 탭이 없으면 home 탭 자동 생성 (homeUrl 우선)
        const tabsInNewWs = listTabsInWorkspace(wid, id);
        if (tabsInNewWs.length === 0) {
            const ws = (0, workspace_1.getWorkspace)(id);
            const homeUrl = (ws?.homeUrl && ws.homeUrl.trim()) ? ws.homeUrl.trim() : constants_1.NEW_TAB_URL;
            createTab({ windowId: wid, url: homeUrl, workspaceId: id });
            continue;
        }
        // 활성 탭이 layout 에 없으면 첫 탭 활성화
        const layout = getLayout(wid, id);
        if (!layout.panes[0]?.tabId || !tabs.has(layout.panes[0].tabId)) {
            const firstTab = tabsInNewWs[0];
            if (firstTab)
                layout.panes[0].tabId = firstTab.id;
        }
        reapplyLayout(wid);
        emitTabList(wid);
    }
});
workspace_1.workspaceEvents.on('removed', ({ id }) => {
    // 제거된 workspace 의 모든 탭 close (단, 시크릿 창 탭은 워크스페이스 소속과 무관하므로 제외 — 워크스페이스
    // 삭제가 열려 있는 시크릿 창의 탭을 통째로 닫아버리지 않도록.)
    const toClose = Array.from(tabs.values())
        .filter((t) => t.workspaceId === id && !(0, window_service_1.getWindow)(t.windowId)?.incognito)
        .map((t) => t.id);
    for (const tabId of toClose)
        closeTab(tabId);
    // layout 키 cleanup
    for (const key of Array.from(layoutByWindow.keys())) {
        if (key.endsWith(`::${id}`))
            layoutByWindow.delete(key);
    }
});
