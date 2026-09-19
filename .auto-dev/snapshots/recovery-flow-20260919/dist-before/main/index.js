"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanUserAgent = cleanUserAgent;
require("./bootstrap-userdata"); // 반드시 첫 import — 다른 모듈의 top-level Store 생성보다 먼저 userData 경로를 정해야 함
const electron_1 = require("electron");
const ipc_1 = require("./ipc");
const window_service_1 = require("./windows/window-service");
const register_defaults_1 = require("./actions/register-defaults");
const registry_1 = require("./actions/registry");
const keymap_service_1 = require("./keymap/keymap-service");
const userchrome_1 = require("./features/userchrome");
const adblock_1 = require("./features/adblock");
const downloads_1 = require("./features/downloads");
const resume_1 = require("./features/downloads/resume");
const torrent_1 = require("./features/torrent");
const video_download_1 = require("./features/video-download");
const tab_service_1 = require("./tabs/tab-service");
const adapter_1 = require("./extensions/adapter");
const build_menu_1 = require("./menu/build-menu");
const bookmarks_1 = require("./storage/bookmarks");
const history_1 = require("./storage/history");
const constants_1 = require("../shared/constants");
const dark_mode_1 = require("./features/dark-mode");
const passkey_1 = require("./features/passkey");
const tab_service_2 = require("./tabs/tab-service");
const gesture_1 = require("./features/gesture");
const quick_search_1 = require("./features/quick-search");
const translate_1 = require("./features/translate");
const qrcode_1 = require("./features/qrcode");
const ai_1 = require("./features/ai");
const agent_triggers_1 = require("./features/ai/agent-triggers");
const feed_collector_1 = require("./features/ai/feed-collector");
const blog_drafts_1 = require("./features/ai/blog-drafts");
const userscript_1 = require("./features/userscript");
const policy_1 = require("./features/policy");
const workspace_1 = require("./features/workspace");
const password_1 = require("./features/password");
const session_bootstrap_1 = require("./session-bootstrap");
const design_tokens_1 = require("./features/design-tokens");
const automation_1 = require("./features/automation");
const mod_api_1 = require("./features/mod-api");
const tab_sleep_1 = require("./features/tab-sleep");
const find_1 = require("./features/find");
const context_menu_1 = require("./features/context-menu");
const page_tools_1 = require("./features/page-tools");
const session_1 = require("./features/session");
const auto_update_1 = require("./features/auto-update");
const perf_1 = require("./features/perf");
const gc_nudge_1 = require("./features/gc-nudge");
const client_hints_1 = require("./features/client-hints");
electron_1.protocol.registerSchemesAsPrivileged([
    { scheme: 'browser', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
let lastFocusedWindowId = null;
// Electron 기본 UA 에서 앱 이름·Electron 토큰만 걷어내 순정 Chrome UA 로 만든다.
// 예) "... browser-build/0.1.0 Chrome/134.0.6998.205 Electron/35.7.5 Safari/537.36"
//   → "... Chrome/134.0.6998.205 Safari/537.36"
// app.userAgentFallback 에 넣으면 이후 만들어지는 모든 세션·창에 적용된다(창 생성보다 먼저 호출할 것).
function cleanUserAgent(raw, appName) {
    return raw
        .replace(new RegExp(`\\s*${appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/[\\d.]+`, 'ig'), '')
        .replace(/\s*Electron\/[\d.]+/ig, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}
function applyCleanUserAgent() {
    try {
        const ua = cleanUserAgent(electron_1.app.userAgentFallback, electron_1.app.getName());
        if (ua && !/Electron\//i.test(ua))
            electron_1.app.userAgentFallback = ua;
    }
    catch { /* UA 정규화 실패는 치명적이지 않다 — 기본값으로 진행 */ }
}
// 시크릿 창의 탭인지 — 방문 기록 등 영속 저장을 건너뛸 때 사용.
// (CLAUDE.md: "시크릿 세션은 메모리에만 보관, 종료 시 삭제")
function isIncognitoTab(tabId) {
    return ((0, tab_service_1.getTabPartition)(tabId) ?? '').startsWith('incognito');
}
if (!electron_1.app.requestSingleInstanceLock()) {
    electron_1.app.quit();
}
else {
    const NAV_ALLOWED_SCHEMES = new Set([
        'http:', 'https:', 'file:', 'browser:', 'devtools:', 'chrome-extension:',
        'about:', 'data:', 'blob:', 'view-source:',
    ]);
    electron_1.app.on('web-contents-created', (_e, wc) => {
        wc.on('will-navigate', (ev, url) => {
            try {
                const u = new URL(url);
                if (!NAV_ALLOWED_SCHEMES.has(u.protocol)) {
                    ev.preventDefault();
                    console.warn(`[nav] blocked will-navigate scheme=${u.protocol} url=${url}`);
                }
            }
            catch { /* invalid url — leave to Electron */ }
        });
        wc.on('did-fail-load', (_ev, code, desc, validatedURL) => {
            if (code !== -3) {
                console.warn(`[nav] did-fail-load wc#${wc.id} code=${code} ${desc} url=${validatedURL}`);
            }
        });
    });
    electron_1.app.on('second-instance', () => {
        const ctx = (0, window_service_1.getAllWindows)()[0];
        if (ctx) {
            if (ctx.win.isMinimized())
                ctx.win.restore();
            ctx.win.focus();
        }
        else {
            (0, window_service_1.createBrowserWindow)();
        }
    });
    // User-Agent 정규화 — Electron 기본 UA 는 "browser-build/0.1.0 ... Electron/35.7.5" 를 그대로 담는다.
    // 이건 "일반 브라우저가 아님"을 스스로 밝히는 것과 같아, 봇 탐지에 즉시 걸리고(인스타·페북·틱톡)
    // 일부 사이트는 아예 다른 페이지를 준다. 앱·Electron 토큰만 제거해 순정 Chrome UA 로 맞춘다.
    // (Chromium 버전은 실제 런타임 값을 쓰므로 Electron 업그레이드 때 자동으로 따라간다.)
    applyCleanUserAgent();
    electron_1.app.whenReady().then(async () => {
        (0, perf_1.recordWhenReady)();
        try {
            // policy 의 webRequest 후킹을 session 초기화 hook 으로 등록 (모든 세션 자동 적용)
            (0, session_bootstrap_1.addSessionInitHook)((ses) => { (0, policy_1.installPolicyOn)(ses); });
            // default + persist:default 즉시 install
            (0, session_bootstrap_1.setupSession)(electron_1.session.defaultSession);
            (0, session_bootstrap_1.setupSessionByPartition)(constants_1.DEFAULT_SESSION);
            (0, window_service_1.setOpenInTabHandler)((windowId, url, opts) => {
                if (opts?.sourceTabId && !opts.forceNewTab) {
                    // same-tab 모드 — 요청을 발생시킨 탭에서 navigate
                    (0, tab_service_1.navigateTab)(opts.sourceTabId, url);
                    return;
                }
                (0, tab_service_1.createTab)({ windowId, url, background: opts?.background === true });
            });
            (0, window_service_1.setMagnetHandler)((url) => { void (0, torrent_1.addTorrent)(url); });
            await (0, bookmarks_1.initBookmarks)();
            await (0, history_1.initHistory)();
            await (0, workspace_1.initWorkspaces)();
            // 모든 워크스페이스 partition 에 핸들러 install
            for (const ws of (0, workspace_1.listWorkspaces)())
                (0, session_bootstrap_1.setupSessionByPartition)(ws.partition);
            // 새 워크스페이스 생성 시 자동 install
            workspace_1.workspaceEvents.on('created', (ws) => {
                (0, session_bootstrap_1.setupSessionByPartition)(ws.partition);
            });
            await (0, userscript_1.initUserscripts)();
            await (0, policy_1.initPolicies)();
            await (0, password_1.initPasswords)();
            await (0, design_tokens_1.initDesignTokens)();
            await (0, automation_1.initAutomation)();
            await (0, mod_api_1.initModApi)();
            (0, ipc_1.registerAllIpc)();
            (0, register_defaults_1.registerDefaultActions)();
            (0, downloads_1.initDownloads)();
            (0, video_download_1.initVideoDetect)();
            (0, torrent_1.initTorrentBridge)();
            (0, torrent_1.initMagnetHandler)();
            (0, torrent_1.initTorrentResponseHook)();
            (0, dark_mode_1.bindNativeTheme)();
            (0, gesture_1.initGesture)();
            (0, quick_search_1.initQuickSearch)();
            (0, translate_1.initTranslate)();
            (0, qrcode_1.initQrcode)();
            void (0, ai_1.initAi)();
            (0, agent_triggers_1.initAgentTriggers)();
            (0, feed_collector_1.initFeedCollectors)();
            (0, blog_drafts_1.initBlogDrafts)();
            (0, tab_service_1.onTabCreated)(({ id, webContentsId }) => {
                (0, video_download_1.registerTabWebContents)(id, webContentsId);
                const wc = (0, tab_service_2.getWebContentsByTabId)(id);
                if (wc) {
                    (0, dark_mode_1.trackWebContents)(wc);
                    (0, passkey_1.trackWebContents)(wc);
                    (0, userscript_1.trackWebContents)(wc);
                    (0, policy_1.trackWebContents)(wc);
                    (0, find_1.trackFind)(wc, id);
                    (0, context_menu_1.trackContextMenu)(wc, id);
                    (0, page_tools_1.trackZoom)(wc, id);
                    wc.once('did-finish-load', () => (0, perf_1.recordFirstTabLoaded)());
                }
                // 확장에 탭을 알린다 — 등록하지 않으면 chrome.tabs.query 가 늘 빈 배열이다.
                (0, adapter_1.trackExtensionTab)(id);
                (0, mod_api_1.dispatchTabCreated)({ id, webContentsId });
            });
            (0, tab_service_1.onTabClosed)((id) => {
                (0, video_download_1.unregisterTabWebContents)(id);
                (0, adapter_1.untrackExtensionTab)(id);
                (0, mod_api_1.dispatchTabClosed)(id);
            });
            (0, tab_service_1.onTabActivated)((id) => (0, adapter_1.selectExtensionTab)(id));
            // SPA(pushState) 경로 변경 시에도 이전 영상 후보를 비운다 — did-navigate 만으로는 안 불림
            (0, tab_service_1.onTabInPageNavigated)(({ id }) => (0, video_download_1.clearCandidates)(id));
            (0, tab_service_1.onTabNavigated)(({ id, url, title }) => {
                // 새 페이지로 이동 시 이전 영상의 미디어 후보를 비운다 —
                // 안 비우면 새 영상에서 받기를 눌러도 이전 영상의 m3u8 로 받아 "이름만 다르고 내용은 같은" 문제가 생김.
                (0, video_download_1.clearCandidates)(id);
                (0, video_download_1.reportSiteCandidate)(id, url);
                if (!isIncognitoTab(id))
                    (0, history_1.recordVisit)({ url, title });
                (0, mod_api_1.dispatchTabNavigated)({ id, url, title });
                if (!isIncognitoTab(id))
                    (0, agent_triggers_1.onNavigatedForTriggers)(id, url); // AI URL 진입 트리거
                // URL 트리거 매크로 자동 실행
                const matched = (0, automation_1.listUrlMacrosFor)(url);
                if (matched.length > 0) {
                    const wc = (0, tab_service_2.getWebContentsByTabId)(id);
                    for (const macro of matched) {
                        void (0, automation_1.runMacro)(macro.id, {
                            webContents: wc,
                            toast: (msg) => {
                                for (const ctx of (0, window_service_1.getAllWindows)()) {
                                    ctx.chrome.webContents.send('toast:show', { message: msg, ts: Date.now() });
                                }
                            },
                        });
                    }
                }
            });
            (0, tab_service_1.onTabTitleUpdated)(({ id, url, title }) => {
                if (!isIncognitoTab(id))
                    (0, history_1.updateVisitTitle)(url, title);
            });
            await (0, keymap_service_1.loadKeymap)();
            await (0, userchrome_1.initUserChrome)();
            window_service_1.windowEvents.on('created', (ctx) => {
                attachAcceleratorsToWindow(ctx);
                ctx.win.on('focus', () => { lastFocusedWindowId = ctx.id; });
                lastFocusedWindowId = ctx.id;
            });
            // 새 창 생성 시 토큰 overrides 자동 적용 (복원 창도 포함되도록 창 생성 전에 등록)
            window_service_1.windowEvents.on('created', (newCtx) => {
                newCtx.chrome.webContents.once('did-finish-load', () => {
                    const cssVars = (0, design_tokens_1.getOverridesAsCssVars)();
                    if (Object.keys(cssVars).length > 0) {
                        newCtx.chrome.webContents.send('tokens:changed', { overrides: {}, cssVars });
                    }
                });
            });
            // 세션 추적 시작 + 부팅 시 복원 시도. 복원이 창을 만들었으면 기본 창 생성을 건너뜀.
            (0, session_1.initSessionTracking)();
            const restored = await (0, session_1.maybeRestoreSession)().catch((err) => {
                console.warn('[main] session restore failed', err);
                return false;
            });
            const ctx = (restored ? (0, window_service_1.getAllWindows)()[0] : undefined) ?? (0, window_service_1.createBrowserWindow)();
            electron_1.Menu.setApplicationMenu((0, build_menu_1.buildAppMenu)(() => lastFocusedWindowId ?? ctx.id));
            // 부팅 시 'startup' 트리거 매크로 실행 (외피 마운트 직후)
            const runStartup = () => {
                (0, perf_1.recordFirstWindowReady)();
                // 클라이언트 힌트(Sec-CH-UA) 헤더에 쓸 브랜드 목록을 실제 렌더러에서 한 번 읽어 캐시한다.
                // 값을 지어내지 않고 navigator.userAgentData 와 항상 같은 값을 헤더로 내보내기 위함.
                void (0, client_hints_1.captureBrands)(ctx.chrome.webContents);
                setTimeout(() => {
                    const startupMacros = (0, automation_1.listStartupMacros)();
                    for (const macro of startupMacros) {
                        void (0, automation_1.runMacro)(macro.id, {
                            webContents: null,
                            toast: (msg) => ctx.chrome.webContents.send('toast:show', { message: msg, ts: Date.now() }),
                        });
                    }
                    // 디자인 토큰 overrides 외피에 전송
                    const cssVars = (0, design_tokens_1.getOverridesAsCssVars)();
                    if (Object.keys(cssVars).length > 0) {
                        ctx.chrome.webContents.send('tokens:changed', { overrides: {}, cssVars });
                    }
                }, 100);
            };
            if (ctx.chrome.webContents.isLoadingMainFrame()) {
                ctx.chrome.webContents.once('did-finish-load', runStartup);
            }
            else {
                runStartup();
            }
            // 토큰 변경 broadcast (IPC 핸들러에서도 broadcast 하나, init 흐름 보강)
            design_tokens_1.tokenEvents.on('changed', () => { });
            setTimeout(() => {
                const adblockDone = (0, adblock_1.initAdblock)().catch((err) => console.error('[main] adblock init failed', err));
                const extensionsDone = (0, adapter_1.initExtensions)().catch((err) => console.error('[main] extensions init failed', err));
                // 부팅 초기 대량 JSON 파싱(설정·워크스페이스·정책·userscript 등) + adblock 필터 빌드까지
                // 끝난 뒤 1회 GC 넛지 — 스크래치 메모리를 최대한 회수한 상태를 "새 바닥"으로 굳힌다.
                // 기능·데이터에는 영향 없음(순수 메모리 정리).
                void Promise.allSettled([adblockDone, extensionsDone]).then(() => (0, gc_nudge_1.nudgeGc)('post-boot-settle'));
            }, 1500);
            // 백그라운드 탭 슬립 루프 — 매 60초마다 비활성 탭 검사
            (0, tab_sleep_1.startTabSleepLoop)();
            // 지난 세션에서 진행 중이던 다운로드 이어받기 (렌더러 마운트 후 토스트·패널이 보이도록 약간 지연)
            setTimeout(() => {
                void (0, resume_1.resumePendingDownloads)().catch((err) => console.warn('[main] resume downloads failed', err));
            }, 1800);
            // 자동 업데이트 — packaged 빌드에서만 활성
            void (0, auto_update_1.initAutoUpdate)().catch((err) => console.warn('[main] auto-update init failed', err));
        }
        catch (err) {
            console.error('[main] startup failed', err);
            throw err;
        }
    }).catch((err) => {
        console.error('[main] whenReady chain failed', err);
    });
    process.on('uncaughtException', (err) => { console.error('[main] uncaught', err); });
    process.on('unhandledRejection', (err) => { console.error('[main] unhandled rejection', err); });
    electron_1.app.on('window-all-closed', () => {
        if (process.platform !== 'darwin')
            electron_1.app.quit();
    });
    electron_1.app.on('activate', () => {
        if ((0, window_service_1.getAllWindows)().length === 0)
            (0, window_service_1.createBrowserWindow)();
    });
}
function attachAcceleratorsToWindow(ctx) {
    // keymap 변경 시 즉시 반영되도록 closure 캡처 대신 매번 getKeymap() 호출
    ctx.chrome.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown')
            return;
        if (input.isComposing)
            return;
        const km = (0, keymap_service_1.getKeymap)();
        for (const binding of km.bindings) {
            if (!matchesAccelerator(binding.key, input))
                continue;
            const action = (0, registry_1.getAction)(binding.action);
            if (!action)
                continue;
            event.preventDefault();
            const focused = electron_1.BrowserWindow.getFocusedWindow();
            const windowId = ctx.id;
            void (0, registry_1.runAction)(binding.action, { windowId, tabId: focused ? undefined : undefined });
            return;
        }
    });
}
function matchesAccelerator(accel, input) {
    const parts = accel.split('+').map((p) => p.trim().toLowerCase());
    const wantCtrl = parts.includes('ctrl') || parts.includes('cmdorctrl');
    const wantShift = parts.includes('shift');
    const wantAlt = parts.includes('alt');
    const wantMeta = parts.includes('cmd') || parts.includes('meta') || parts.includes('super');
    const key = parts[parts.length - 1] ?? '';
    if (input.control !== wantCtrl)
        return false;
    if (input.shift !== wantShift)
        return false;
    if (input.alt !== wantAlt)
        return false;
    if (input.meta !== wantMeta)
        return false;
    return input.key.toLowerCase() === key;
}
