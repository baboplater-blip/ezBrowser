"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// app/preload/internal.ts
var internal_exports = {};
module.exports = __toCommonJS(internal_exports);
var import_electron2 = require("electron");

// app/shared/ipc-channels.ts
var IPC = {
  windows: {
    ready: "windows:ready",
    list: "windows:list",
    focus: "windows:focus",
    create: "windows:create",
    setChromeHeight: "windows:set-chrome-height",
    setShellInsets: "windows:set-shell-insets",
    setPaneSplitRatio: "windows:set-pane-split-ratio",
    focusPane: "windows:focus-pane",
    layoutChanged: "windows:layout-changed",
    beginPaneDrag: "windows:begin-pane-drag",
    endPaneDrag: "windows:end-pane-drag"
  },
  tabs: {
    create: "tabs:create",
    list: "tabs:list",
    listChanged: "tabs:list-changed",
    activate: "tabs:activate",
    close: "tabs:close",
    reorder: "tabs:reorder",
    pin: "tabs:pin",
    duplicate: "tabs:duplicate",
    restore: "tabs:restore",
    update: "tabs:update",
    capture: "tabs:capture",
    navigate: "tabs:navigate",
    back: "tabs:back",
    forward: "tabs:forward",
    reload: "tabs:reload",
    stop: "tabs:stop",
    setMuted: "tabs:set-muted"
  },
  omnibox: {
    suggest: "omnibox:suggest",
    navigate: "omnibox:navigate"
  },
  settings: {
    get: "settings:get",
    set: "settings:set",
    all: "settings:all",
    changed: "settings:changed"
  },
  actions: {
    list: "actions:list",
    run: "actions:run"
  },
  keymap: {
    get: "keymap:get",
    set: "keymap:set",
    reset: "keymap:reset"
  },
  palette: {
    open: "palette:open",
    close: "palette:close"
  },
  tabsearch: {
    open: "tabsearch:open"
  },
  recentClosed: {
    list: "recent-closed:list",
    reopen: "recent-closed:reopen",
    clear: "recent-closed:clear",
    open: "recent-closed:open"
  },
  userchrome: {
    get: "userchrome:get",
    update: "userchrome:update",
    reload: "userchrome:reload",
    open: "userchrome:open",
    cssChanged: "userchrome:css-changed"
  },
  adblock: {
    stats: "adblock:stats",
    setLevel: "adblock:set-level",
    setEnabled: "adblock:set-enabled",
    setFilter: "adblock:set-filter",
    setSiteAllowed: "adblock:set-site-allowed",
    toggleSite: "adblock:toggle-site",
    changed: "adblock:changed"
  },
  downloads: {
    list: "downloads:list",
    pause: "downloads:pause",
    resume: "downloads:resume",
    cancel: "downloads:cancel",
    openFolder: "downloads:open-folder",
    openFile: "downloads:open-file",
    copyPath: "downloads:copy-path",
    retry: "downloads:retry",
    remove: "downloads:remove",
    clearFinished: "downloads:clear-finished",
    pickFolder: "downloads:pick-folder",
    update: "downloads:update"
  },
  torrent: {
    add: "torrent:add",
    pause: "torrent:pause",
    resume: "torrent:resume",
    remove: "torrent:remove",
    setFiles: "torrent:set-files"
  },
  video: {
    candidates: "video:candidates",
    candidatesChanged: "video:candidates-changed",
    download: "video:download",
    ytdlpStatus: "video:ytdlp-status",
    ytdlpEnsure: "video:ytdlp-ensure",
    ytdlpUpdate: "video:ytdlp-update",
    downloadFromOverlay: "video:download-from-overlay"
  },
  screenshot: {
    capture: "screenshot:capture",
    saveToClipboard: "screenshot:to-clipboard",
    saveToFile: "screenshot:to-file"
  },
  search: {
    listEngines: "search:list-engines",
    setDefault: "search:set-default"
  },
  gesture: {
    exec: "gesture:exec"
  },
  quickSearch: {
    open: "quick-search:open"
  },
  reader: {
    toggle: "reader:toggle"
  },
  find: {
    start: "find:start",
    stop: "find:stop",
    result: "find:result",
    open: "find:open"
  },
  page: {
    print: "page:print",
    printToPdf: "page:print-to-pdf",
    zoomGet: "page:zoom-get",
    zoomSet: "page:zoom-set"
  },
  translate: {
    batch: "translate:batch"
  },
  qrcode: {
    generate: "qrcode:generate",
    open: "qrcode:open"
  },
  userscript: {
    list: "userscript:list",
    get: "userscript:get",
    save: "userscript:save",
    remove: "userscript:remove",
    setEnabled: "userscript:set-enabled",
    changed: "userscript:changed"
  },
  policy: {
    list: "policy:list",
    get: "policy:get",
    save: "policy:save",
    remove: "policy:remove",
    setEnabled: "policy:set-enabled",
    changed: "policy:changed"
  },
  password: {
    list: "password:list",
    lookup: "password:lookup",
    reveal: "password:reveal",
    proposeSave: "password:propose-save",
    confirmSave: "password:confirm-save",
    promptOpen: "password:prompt-open",
    promptResolved: "password:prompt-resolved",
    remove: "password:remove",
    changed: "password:changed",
    available: "password:available",
    // 선등록(사용자가 설정에서 직접 추가/수정) — 신뢰된 내부 페이지만.
    add: "password:add",
    update: "password:update"
  },
  workspace: {
    list: "workspace:list",
    state: "workspace:state",
    activate: "workspace:activate",
    create: "workspace:create",
    update: "workspace:update",
    remove: "workspace:remove",
    reorder: "workspace:reorder",
    changed: "workspace:changed"
  },
  bookmarks: {
    list: "bookmarks:list",
    add: "bookmarks:add",
    remove: "bookmarks:remove",
    rename: "bookmarks:rename",
    update: "bookmarks:update",
    move: "bookmarks:move",
    isBookmarked: "bookmarks:is-bookmarked",
    folderCreate: "bookmarks:folder-create",
    folderRename: "bookmarks:folder-rename",
    folderRemove: "bookmarks:folder-remove",
    exportHtml: "bookmarks:export-html",
    importHtml: "bookmarks:import-html",
    changed: "bookmarks:changed"
  },
  history: {
    recent: "history:recent",
    search: "history:search",
    topSites: "history:top-sites",
    remove: "history:remove",
    clear: "history:clear",
    changed: "history:changed"
  },
  data: {
    export: "data:export",
    import: "data:import"
  },
  tokens: {
    get: "tokens:get",
    set: "tokens:set",
    reset: "tokens:reset",
    changed: "tokens:changed"
  },
  macro: {
    list: "macro:list",
    get: "macro:get",
    save: "macro:save",
    remove: "macro:remove",
    run: "macro:run",
    changed: "macro:changed"
  },
  mod: {
    list: "mod:list",
    get: "mod:get",
    setEnabled: "mod:set-enabled",
    remove: "mod:remove",
    changed: "mod:changed",
    reload: "mod:reload",
    menuList: "mod:menu-list",
    menuInvoke: "mod:menu-invoke"
  },
  system: {
    metrics: "system:metrics",
    bootInfo: "system:boot-info",
    sweepTabSleep: "system:sweep-tab-sleep",
    wakeTab: "system:wake-tab",
    licenses: "system:licenses"
  },
  perf: {
    report: "perf:report",
    milestone: "perf:milestone"
  },
  update: {
    status: "update:status",
    check: "update:check",
    download: "update:download",
    install: "update:install",
    setChannel: "update:set-channel",
    setAutoDownload: "update:set-auto-download",
    setAutoCheck: "update:set-auto-check"
  },
  extensions: {
    list: "extensions:list",
    installFromCrx: "extensions:install-from-crx",
    installFromUrl: "extensions:install-from-url",
    remove: "extensions:remove",
    setEnabled: "extensions:set-enabled",
    openOptions: "extensions:open-options",
    invokeAction: "extensions:invoke-action",
    changed: "extensions:changed",
    importLocal: "extensions:import-local"
  },
  widgets: {
    weather: "widgets:weather",
    news: "widgets:news",
    fx: "widgets:fx",
    dataGet: "widgets:data-get",
    dataSet: "widgets:data-set"
  },
  groups: {
    list: "groups:list",
    create: "groups:create",
    update: "groups:update",
    remove: "groups:remove",
    setCollapsed: "groups:set-collapsed",
    assignTab: "groups:assign-tab",
    changed: "groups:changed"
  },
  permissions: {
    list: "permissions:list",
    set: "permissions:set",
    clearOrigin: "permissions:clear-origin",
    clearAll: "permissions:clear-all",
    changed: "permissions:changed"
  },
  readlater: {
    list: "readlater:list",
    add: "readlater:add",
    remove: "readlater:remove",
    setRead: "readlater:set-read",
    clearRead: "readlater:clear-read",
    isSaved: "readlater:is-saved",
    changed: "readlater:changed",
    openPanel: "readlater:open-panel"
  },
  sitedata: {
    summary: "sitedata:summary",
    clear: "sitedata:clear"
  },
  imports: {
    sources: "imports:sources",
    run: "imports:run"
  },
  onboarding: {
    setDefaultBrowser: "onboarding:set-default-browser",
    complete: "onboarding:complete"
  },
  ai: {
    config: "ai:config",
    pageContext: "ai:page-context",
    keyStatus: "ai:key-status",
    setKey: "ai:set-key",
    clearKey: "ai:clear-key",
    pickAgentDir: "ai:pick-agent-dir",
    agentFilesInfo: "ai:agent-files-info",
    send: "ai:send",
    cancel: "ai:cancel",
    delta: "ai:delta",
    done: "ai:done",
    error: "ai:error",
    open: "ai:open",
    agentStart: "ai:agent-start",
    agentEvent: "ai:agent-event",
    agentConfirm: "ai:agent-confirm",
    agentReply: "ai:agent-reply",
    agentCancel: "ai:agent-cancel",
    agentReset: "ai:agent-reset",
    summarize: "ai:summarize",
    diagnose: "ai:diagnose",
    detectProviders: "ai:detect-providers",
    connectProvider: "ai:connect-provider",
    triggerList: "ai:trigger-list",
    triggerAdd: "ai:trigger-add",
    triggerUpdate: "ai:trigger-update",
    triggerRemove: "ai:trigger-remove",
    triggerSetEnabled: "ai:trigger-set-enabled",
    triggerChanged: "ai:trigger-changed",
    profileGet: "ai:profile-get",
    profileSet: "ai:profile-set",
    profileChanged: "ai:profile-changed",
    exportWebhook: "ai:export-webhook",
    blogGenerate: "ai:blog-generate",
    blogBuildTask: "ai:blog-build-task",
    snsBuildTask: "ai:sns-build-task",
    reportBuildTask: "ai:report-build-task",
    reportExport: "ai:report-export",
    blogRefine: "ai:blog-refine",
    blogSeriesPlan: "ai:blog-series-plan",
    blogDraftList: "ai:blog-draft-list",
    blogDraftGet: "ai:blog-draft-get",
    blogDraftSave: "ai:blog-draft-save",
    blogDraftRemove: "ai:blog-draft-remove",
    blogDraftChanged: "ai:blog-draft-changed",
    // 생성→캡션→게시 워크플로 (묶음 SOCIAL-1)
    socialList: "ai:social-list",
    socialStart: "ai:social-start",
    socialApprove: "ai:social-approve",
    socialChoose: "ai:social-choose",
    socialCancel: "ai:social-cancel",
    socialDelete: "ai:social-delete",
    socialChanged: "ai:social-changed",
    socialGrant: "ai:social-grant",
    socialGrantGet: "ai:social-grant-get",
    socialGrantRevoke: "ai:social-grant-revoke",
    // 작업 산출물(캡처한 이미지·받은 파일)
    artifactList: "ai:artifact-list",
    artifactData: "ai:artifact-data",
    // 관심 블로그 댓글·좋아요
    intentDetect: "ai:intent-detect",
    engageBuildTask: "ai:engage-build-task",
    engageLedger: "ai:engage-ledger",
    engageLedgerClear: "ai:engage-ledger-clear",
    collectorList: "ai:collector-list",
    collectorAdd: "ai:collector-add",
    collectorUpdate: "ai:collector-update",
    collectorRemove: "ai:collector-remove",
    collectorSetEnabled: "ai:collector-set-enabled",
    collectorRun: "ai:collector-run",
    collectorRuns: "ai:collector-runs",
    collectorChanged: "ai:collector-changed",
    collectorRan: "ai:collector-ran",
    memoryGet: "ai:memory-get",
    memorySet: "ai:memory-set",
    memoryClear: "ai:memory-clear",
    memoryChanged: "ai:memory-changed",
    convList: "ai:conv-list",
    convGet: "ai:conv-get",
    convSave: "ai:conv-save",
    convDelete: "ai:conv-delete",
    convRename: "ai:conv-rename",
    convClear: "ai:conv-clear",
    convChanged: "ai:conv-changed",
    convSetFolder: "ai:conv-set-folder",
    convSetTags: "ai:conv-set-tags",
    convSetPinned: "ai:conv-set-pinned",
    convSearch: "ai:conv-search",
    convExport: "ai:conv-export",
    convExportBulk: "ai:conv-export-bulk",
    folderList: "ai:folder-list",
    folderCreate: "ai:folder-create",
    folderRename: "ai:folder-rename",
    folderDelete: "ai:folder-delete",
    folderReorder: "ai:folder-reorder",
    folderSetColor: "ai:folder-set-color",
    folderSetEmoji: "ai:folder-set-emoji",
    folderChanged: "ai:folder-changed",
    taskList: "ai:task-list",
    taskAdd: "ai:task-add",
    taskRemove: "ai:task-remove",
    taskRename: "ai:task-rename",
    taskTouch: "ai:task-touch",
    taskChanged: "ai:task-changed",
    runList: "ai:run-list",
    runGet: "ai:run-get",
    runDelete: "ai:run-delete",
    runClear: "ai:run-clear",
    runChanged: "ai:run-changed",
    repeatStart: "ai:repeat-start",
    repeatStop: "ai:repeat-stop",
    repeatRemove: "ai:repeat-remove",
    repeatList: "ai:repeat-list",
    repeatChanged: "ai:repeat-changed",
    repeatEvent: "ai:repeat-event",
    // ===== 영속 작업 런타임(구간 단위로 이어가는 장기 에이전트 작업) =====
    // 주의: `ai:task-*` 는 위의 taskList/taskAdd/... (에이전트 작업 매크로 · SavedAgentTask) 가
    // 이미 쓰고 있다. 같은 이름을 쓰면 object literal 키 충돌로 조용히 macro 기능이 덮이거나,
    // ipcMain.handle 이 같은 채널에 두 번째 핸들러를 등록해 부팅 시 throw 한다.
    // 그래서 새 런타임은 `ptask*`(persistent task) 접두로 분리한다 — 이름이 design.md 의
    // `ai.taskList` 등과 다르니 팀장이 UI 작업자에게 이 접두를 알려줘야 한다.
    ptaskList: "ai:ptask-list",
    ptaskGet: "ai:ptask-get",
    ptaskCreate: "ai:ptask-create",
    ptaskStart: "ai:ptask-start",
    ptaskPause: "ai:ptask-pause",
    ptaskResume: "ai:ptask-resume",
    ptaskCancel: "ai:ptask-cancel",
    ptaskDelete: "ai:ptask-delete",
    ptaskConfirm: "ai:ptask-confirm",
    ptaskAnswer: "ai:ptask-answer",
    ptaskAccept: "ai:ptask-accept",
    ptaskChanged: "ai:ptask-changed",
    ptaskEvent: "ai:ptask-event",
    scheduleResume: "ai:schedule-resume"
  }
};

// app/preload/external-features.ts
var import_electron = require("electron");
var flags = {
  mouseGestures: true,
  quickSearch: true,
  hoverTranslate: false,
  hoverTranslateTarget: "ko"
};
void (async () => {
  try {
    const f = await import_electron.ipcRenderer.invoke(IPC.settings.get, { key: "freedom" });
    if (typeof f?.mouseGestures === "boolean") flags.mouseGestures = f.mouseGestures;
    if (typeof f?.quickSearch === "boolean") flags.quickSearch = f.quickSearch;
    if (typeof f?.hoverTranslate === "boolean") flags.hoverTranslate = f.hoverTranslate;
    if (typeof f?.hoverTranslateTarget === "string") flags.hoverTranslateTarget = f.hoverTranslateTarget;
  } catch {
  }
})();
import_electron.ipcRenderer.on(IPC.settings.changed, (_e, settings) => {
  const f = settings?.freedom;
  if (!f) return;
  if (typeof f.mouseGestures === "boolean") flags.mouseGestures = f.mouseGestures;
  if (typeof f.quickSearch === "boolean") flags.quickSearch = f.quickSearch;
  if (typeof f.hoverTranslate === "boolean") flags.hoverTranslate = f.hoverTranslate;
  if (typeof f.hoverTranslateTarget === "string") flags.hoverTranslateTarget = f.hoverTranslateTarget;
});
function prefersDark() {
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  } catch {
    return false;
  }
}
var GESTURE_TRIGGER_PX = 30;
var GESTURE_L_MIN_PX = 60;
var gestureActive = false;
var gestureStartX = 0;
var gestureStartY = 0;
var gestureUsed = false;
var gestureHintEl = null;
var gesturePath = [];
function ensureHint() {
  if (gestureHintEl) return gestureHintEl;
  const el = document.createElement("div");
  el.setAttribute("data-bb-gesture-hint", "1");
  el.style.cssText = [
    "position:fixed",
    "z-index:2147483645",
    "pointer-events:none",
    "top:0",
    "left:0",
    `color:${prefersDark() ? "#f2f2f5" : "#1a1a1a"}`,
    "font:600 13px -apple-system,BlinkMacSystemFont,Segoe UI,Pretendard,sans-serif",
    "padding:6px 12px",
    "border-radius:14px",
    `background:${prefersDark() ? "rgba(20,20,24,0.92)" : "rgba(255,255,255,0.92)"}`,
    "box-shadow:0 4px 14px rgba(0,0,0,0.25)",
    "transition:opacity .1s ease"
  ].join(";");
  document.body.appendChild(el);
  gestureHintEl = el;
  return el;
}
function showHint(text, x, y) {
  const el = ensureHint();
  el.style.transform = `translate(${Math.min(window.innerWidth - 200, x + 16)}px, ${Math.min(window.innerHeight - 40, y + 16)}px)`;
  el.textContent = text;
  el.style.opacity = "1";
}
function clearGestureHint() {
  if (gestureHintEl) {
    gestureHintEl.remove();
    gestureHintEl = null;
  }
}
function describePath(path) {
  if (path.length < 2) return null;
  const first = path[0];
  const last = path[path.length - 1];
  if (!first || !last) return null;
  const dxTotal = last.x - first.x;
  const dyTotal = last.y - first.y;
  const absX = Math.abs(dxTotal);
  const absY = Math.abs(dyTotal);
  if (absX >= GESTURE_L_MIN_PX && absY >= GESTURE_L_MIN_PX) {
    let maxYIdx = 0;
    for (let i = 0; i < path.length; i += 1) {
      const p = path[i];
      if (!p) continue;
      const m = path[maxYIdx];
      if (m && p.y > m.y) maxYIdx = i;
    }
    const peak = path[maxYIdx];
    if (peak && maxYIdx > 0 && maxYIdx < path.length - 1 && peak.y - first.y >= GESTURE_L_MIN_PX && Math.abs(last.x - peak.x) >= GESTURE_L_MIN_PX) {
      return "tab.close";
    }
  }
  if (absX < GESTURE_TRIGGER_PX && absY < GESTURE_TRIGGER_PX) return null;
  if (absX > absY) return dxTotal < 0 ? "back" : "forward";
  return dyTotal < 0 ? "reload" : "tab.new";
}
var GESTURE_LABEL = {
  "back": "\u2190 \uB4A4\uB85C",
  "forward": "\uC55E\uC73C\uB85C \u2192",
  "reload": "\u2191 \uC0C8\uB85C\uACE0\uCE68",
  "tab.new": "\u2193 \uC0C8 \uD0ED",
  "tab.close": "\u2193\u2192 \uD0ED \uB2EB\uAE30"
};
document.addEventListener("mousedown", (e) => {
  if (!flags.mouseGestures) return;
  if (e.button !== 2) return;
  gestureActive = true;
  gestureStartX = e.clientX;
  gestureStartY = e.clientY;
  gestureUsed = false;
  gesturePath = [{ x: e.clientX, y: e.clientY }];
});
document.addEventListener("mousemove", (e) => {
  if (!gestureActive) return;
  const last = gesturePath[gesturePath.length - 1];
  if (!last) return;
  const ddx = e.clientX - last.x;
  const ddy = e.clientY - last.y;
  if (ddx * ddx + ddy * ddy < 64) return;
  gesturePath.push({ x: e.clientX, y: e.clientY });
  const tentative = describePath(gesturePath);
  if (tentative) showHint(GESTURE_LABEL[tentative], e.clientX, e.clientY);
});
document.addEventListener("mouseup", (e) => {
  if (e.button !== 2 || !gestureActive) return;
  gestureActive = false;
  gesturePath.push({ x: e.clientX, y: e.clientY });
  const action = describePath(gesturePath);
  gesturePath = [];
  clearGestureHint();
  if (!action) return;
  gestureUsed = true;
  void import_electron.ipcRenderer.invoke(IPC.gesture.exec, { action });
});
document.addEventListener("contextmenu", (e) => {
  if (gestureUsed) {
    e.preventDefault();
    gestureUsed = false;
  }
}, true);
var quickSearchEl = null;
function hideQuickSearch() {
  if (quickSearchEl) {
    quickSearchEl.remove();
    quickSearchEl = null;
  }
}
function showQuickSearch(text, x, y) {
  hideQuickSearch();
  const dark = prefersDark();
  const btn = document.createElement("div");
  btn.setAttribute("data-bb-quicksearch", "1");
  btn.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    `top:${Math.max(8, y + 12)}px`,
    `left:${Math.max(8, Math.min(window.innerWidth - 100, x))}px`,
    "padding:5px 12px",
    `border:1px solid ${dark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)"}`,
    "border-radius:14px",
    `background:${dark ? "#1f1f24" : "#ffffff"}`,
    `color:${dark ? "#f2f2f5" : "#1a1a1a"}`,
    "font-size:12px",
    "font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Pretendard,Apple SD Gothic Neo,sans-serif",
    "cursor:pointer",
    "box-shadow:0 4px 14px rgba(0,0,0,0.18)",
    "user-select:none",
    "-webkit-user-select:none"
  ].join(";");
  btn.textContent = `\u{1F50D} "${text.length > 24 ? text.slice(0, 24) + "\u2026" : text}"`;
  btn.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void import_electron.ipcRenderer.invoke(IPC.quickSearch.open, { query: text });
    hideQuickSearch();
  });
  document.body.appendChild(btn);
  quickSearchEl = btn;
}
document.addEventListener("mouseup", (e) => {
  if (!flags.quickSearch) return;
  if (e.button !== 0) return;
  if (e.target?.hasAttribute?.("data-bb-quicksearch")) return;
  setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (text.length < 2 || text.length > 200 || /^\s*$/.test(text)) {
      hideQuickSearch();
      return;
    }
    showQuickSearch(text, e.clientX, e.clientY);
  }, 10);
});
document.addEventListener("mousedown", (e) => {
  if (e.target?.hasAttribute?.("data-bb-quicksearch")) return;
  hideQuickSearch();
});
window.addEventListener("scroll", hideQuickSearch, true);
window.addEventListener("blur", hideQuickSearch);
function findPasswordInputs() {
  return Array.from(document.querySelectorAll("input[type=password]"));
}
function findUsernameInputFor(passwordInput) {
  const form = passwordInput.form;
  const candidates = [];
  const inputs = form ? Array.from(form.querySelectorAll("input")) : Array.from(document.querySelectorAll("input"));
  for (const el of inputs) {
    if (el === passwordInput) break;
    const t = (el.type || "text").toLowerCase();
    if (t === "text" || t === "email" || t === "tel") candidates.push(el);
  }
  if (candidates.length === 0) return null;
  const byAutocomplete = candidates.find((e) => /username|email/i.test(e.autocomplete));
  if (byAutocomplete) return byAutocomplete;
  const byName = candidates.find((e) => /user|login|email|id/i.test(`${e.name} ${e.id} ${e.placeholder}`));
  if (byName) return byName;
  return candidates[candidates.length - 1] ?? null;
}
function setNativeValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
var autofillApplied = false;
async function tryAutofill() {
  if (autofillApplied) return;
  const pwInputs = findPasswordInputs();
  if (pwInputs.length === 0) return;
  let matches = [];
  try {
    matches = await import_electron.ipcRenderer.invoke(IPC.password.lookup);
  } catch {
    return;
  }
  if (!Array.isArray(matches) || matches.length === 0) return;
  const m = matches[0];
  if (!m) return;
  const firstPw = pwInputs[0];
  if (!firstPw) return;
  const userInput = findUsernameInputFor(firstPw);
  if (userInput && !userInput.value) setNativeValue(userInput, m.username);
  if (!firstPw.value) setNativeValue(firstPw, m.password);
  autofillApplied = true;
}
function watchForPasswordFields() {
  void tryAutofill();
  let timer = null;
  const mo = new MutationObserver(() => {
    if (autofillApplied) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void tryAutofill();
    }, 300);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}
async function captureCredentialsFromForm(form) {
  const pwInputs = Array.from(form.querySelectorAll("input[type=password]"));
  const pw = pwInputs.find((e) => e.value && e.value.length >= 1);
  if (!pw) return;
  const userInput = findUsernameInputFor(pw);
  const username = userInput?.value?.trim();
  const password = pw.value;
  if (!username || !password) return;
  try {
    await import_electron.ipcRenderer.invoke(IPC.password.proposeSave, { username, password });
  } catch {
  }
}
document.addEventListener("submit", (e) => {
  const form = e.target;
  if (!form || !(form instanceof HTMLFormElement)) return;
  void captureCredentialsFromForm(form);
}, true);
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", watchForPasswordFields, { once: true });
} else {
  watchForPasswordFields();
}
var VIDEO_OVERLAY_ATTR = "data-bb-video-overlay";
var VIDEO_TAGGED_ATTR = "data-bb-video-overlayed";
var VIDEO_MIN_SIZE = 160;
var BB_VIDEO_OVERLAY_ID = "__bbVideoOverlayInjected";
function isExcludedContext() {
  const proto = window.location.protocol;
  if (proto === "about:" || proto === "data:" || proto === "chrome:" || proto === "devtools:") return true;
  return false;
}
function findVideoSrc(video) {
  const sources = video.querySelectorAll("source[src]");
  for (const s of Array.from(sources)) {
    const el = s;
    const url = el.src;
    if (url && !url.startsWith("blob:")) return url;
  }
  if (video.currentSrc && !video.currentSrc.startsWith("blob:")) return video.currentSrc;
  if (video.src && !video.src.startsWith("blob:")) return video.src;
  return video.currentSrc || video.src || "";
}
function createOverlayButton(video) {
  const wrap = document.createElement("div");
  wrap.setAttribute(VIDEO_OVERLAY_ATTR, "");
  wrap.style.cssText = [
    "position:absolute",
    "top:8px",
    "left:8px",
    "z-index:2147483646",
    "opacity:0.85",
    "transition:opacity 0.15s ease, transform 0.1s ease",
    "pointer-events:auto"
  ].join(";");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = "\uB3D9\uC601\uC0C1 \uB2E4\uC6B4\uB85C\uB4DC";
  btn.setAttribute("aria-label", "\uB3D9\uC601\uC0C1 \uB2E4\uC6B4\uB85C\uB4DC");
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13"/><path d="M5 12l7 7 7-7"/><path d="M5 21h14"/></svg>';
  btn.style.cssText = [
    "width:34px",
    "height:34px",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "border:none",
    "border-radius:50%",
    "background:rgba(30,180,90,0.95)",
    "color:white",
    "cursor:pointer",
    "box-shadow:0 2px 6px rgba(0,0,0,0.3)",
    "font-family:inherit",
    "padding:0"
  ].join(";");
  btn.addEventListener("mouseenter", () => {
    wrap.style.opacity = "1";
    wrap.style.transform = "scale(1.06)";
  });
  btn.addEventListener("mouseleave", () => {
    wrap.style.opacity = "0.85";
    wrap.style.transform = "scale(1)";
  });
  btn.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    e.stopPropagation();
    e.preventDefault();
    const src = findVideoSrc(video);
    void import_electron.ipcRenderer.invoke(IPC.video.downloadFromOverlay, {
      videoSrc: src,
      pageUrl: window.location.href
    }).catch((err) => console.warn("[bb] video overlay download failed", err));
    btn.style.background = "rgba(52,120,246,0.95)";
    setTimeout(() => {
      btn.style.background = "rgba(30,180,90,0.95)";
    }, 600);
  });
  wrap.appendChild(btn);
  return wrap;
}
function isVideoBigEnough(video) {
  const rect = video.getBoundingClientRect();
  if (rect.width >= VIDEO_MIN_SIZE && rect.height >= VIDEO_MIN_SIZE / 2) return true;
  if (video.videoWidth >= VIDEO_MIN_SIZE && video.videoHeight >= VIDEO_MIN_SIZE / 2) return true;
  return false;
}
function attachOverlayToVideo(video) {
  if (video.hasAttribute(VIDEO_TAGGED_ATTR)) return;
  const parent = video.parentElement;
  if (!parent) return;
  const parentPos = window.getComputedStyle(parent).position;
  if (parentPos === "static") {
    parent.style.position = "relative";
  }
  const overlay = createOverlayButton(video);
  parent.appendChild(overlay);
  video.setAttribute(VIDEO_TAGGED_ATTR, "1");
  function syncVisibility() {
    overlay.style.display = isVideoBigEnough(video) ? "block" : "none";
  }
  syncVisibility();
  try {
    const ro = new ResizeObserver(syncVisibility);
    ro.observe(video);
  } catch {
  }
  video.addEventListener("loadedmetadata", syncVisibility);
  const cleanup = () => {
    try {
      overlay.remove();
    } catch {
    }
  };
  video.__bbCleanup = cleanup;
}
function scanAllVideos() {
  const videos = document.querySelectorAll("video");
  videos.forEach((v) => attachOverlayToVideo(v));
}
function initVideoOverlay() {
  if (window[BB_VIDEO_OVERLAY_ID]) return;
  window[BB_VIDEO_OVERLAY_ID] = true;
  if (isExcludedContext()) return;
  try {
    document.documentElement.setAttribute("data-bb-content-loaded", "1");
    document.documentElement.setAttribute("data-bb-frame", window.top !== window.self ? "sub" : "top");
    document.documentElement.setAttribute("data-bb-href", window.location.href);
  } catch {
  }
  scanAllVideos();
  const observer = new MutationObserver((mutations) => {
    let needScan = false;
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.tagName === "VIDEO") {
          attachOverlayToVideo(node);
          continue;
        }
        if (node.querySelector && node.querySelector("video")) {
          needScan = true;
        }
      }
    }
    if (needScan) scanAllVideos();
  });
  try {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
  }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initVideoOverlay, { once: true });
} else {
  initVideoOverlay();
}
window.addEventListener("load", () => {
  try {
    scanAllVideos();
  } catch {
  }
});
var scanPollCount = 0;
var scanPollTimer = setInterval(() => {
  try {
    scanAllVideos();
  } catch {
  }
  scanPollCount += 1;
  if (scanPollCount >= 15) clearInterval(scanPollTimer);
}, 1e3);
document.addEventListener("click", () => {
  setTimeout(() => {
    try {
      scanAllVideos();
    } catch {
    }
  }, 500);
  setTimeout(() => {
    try {
      scanAllVideos();
    } catch {
    }
  }, 1500);
}, true);
var hoverTransEl = null;
var lastWord = "";
var hoverTransCache = /* @__PURE__ */ new Map();
var hoverPending = false;
function hideHoverTrans() {
  if (hoverTransEl) {
    hoverTransEl.remove();
    hoverTransEl = null;
  }
  lastWord = "";
}
function isWordChar(c) {
  if (!c) return false;
  return /[A-Za-z0-9À-ɏͰ-ϿЀ-ӿ぀-ヿ㐀-鿿가-힯]/.test(c);
}
function extractWordAt(node, offset) {
  const data = node.data;
  if (offset < 0 || offset > data.length) return null;
  let start = offset;
  let end = offset;
  while (start > 0 && isWordChar(data[start - 1] ?? "")) start -= 1;
  while (end < data.length && isWordChar(data[end] ?? "")) end += 1;
  const text = data.slice(start, end).trim();
  if (!text || text.length < 2 || text.length > 60) return null;
  if (/^[0-9.,]+$/.test(text)) return null;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return { text, range };
}
async function translateWord(word, target) {
  const key = `${target}::${word}`;
  const cached = hoverTransCache.get(key);
  if (cached !== void 0) return cached;
  try {
    const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" + encodeURIComponent(target) + "&dt=t&q=" + encodeURIComponent(word);
    const res = await fetch(url, { method: "GET" });
    const data = await res.json();
    let combined = "";
    if (Array.isArray(data) && Array.isArray(data[0])) {
      for (const part of data[0] ?? []) {
        if (Array.isArray(part) && typeof part[0] === "string") combined += part[0];
      }
    }
    const out = combined || "";
    hoverTransCache.set(key, out);
    return out;
  } catch {
    return "";
  }
}
function showHoverTrans(text, translated, x, y) {
  hideHoverTrans();
  const dark = prefersDark();
  const el = document.createElement("div");
  el.setAttribute("data-bb-hover-trans", "1");
  el.style.cssText = [
    "position:fixed",
    "z-index:2147483646",
    "pointer-events:none",
    `top:${Math.min(window.innerHeight - 80, y + 20)}px`,
    `left:${Math.max(8, Math.min(window.innerWidth - 320, x))}px`,
    `max-width:320px`,
    "padding:8px 12px",
    `border:1px solid ${dark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)"}`,
    "border-radius:8px",
    `background:${dark ? "#1f1f24" : "#ffffff"}`,
    `color:${dark ? "#f2f2f5" : "#1a1a1a"}`,
    "font:13px -apple-system,BlinkMacSystemFont,Segoe UI,Pretendard,Apple SD Gothic Neo,sans-serif",
    "box-shadow:0 4px 14px rgba(0,0,0,0.18)"
  ].join(";");
  const orig = document.createElement("div");
  orig.style.cssText = `color:${dark ? "#9b9ba3" : "#5f5f66"};font-size:11px;margin-bottom:4px;`;
  orig.textContent = text;
  const trans = document.createElement("div");
  trans.style.cssText = "font-weight:500;";
  trans.textContent = translated || "(\uBC88\uC5ED \uACB0\uACFC \uC5C6\uC74C)";
  el.appendChild(orig);
  el.appendChild(trans);
  document.body.appendChild(el);
  hoverTransEl = el;
}
document.addEventListener("mousemove", (e) => {
  if (!flags.hoverTranslate) return;
  if (!e.altKey) {
    if (hoverTransEl) hideHoverTrans();
    return;
  }
  if (hoverPending) return;
  const x = e.clientX;
  const y = e.clientY;
  let textNode = null;
  let offset = 0;
  const d = document;
  if (typeof d.caretRangeFromPoint === "function") {
    const r = d.caretRangeFromPoint(x, y);
    if (r && r.startContainer && r.startContainer.nodeType === Node.TEXT_NODE) {
      textNode = r.startContainer;
      offset = r.startOffset;
    }
  }
  if (!textNode) return;
  const w = extractWordAt(textNode, offset);
  if (!w) return;
  if (w.text === lastWord && hoverTransEl) return;
  lastWord = w.text;
  hoverPending = true;
  void translateWord(w.text, flags.hoverTranslateTarget).then((tr) => {
    hoverPending = false;
    if (lastWord !== w.text) return;
    showHoverTrans(w.text, tr, x, y);
  });
});
document.addEventListener("keyup", (e) => {
  if (e.key === "Alt" && hoverTransEl) hideHoverTrans();
});
window.addEventListener("scroll", hideHoverTrans, true);
window.addEventListener("blur", hideHoverTrans);
var ANTI_ADBLOCK_HOSTS = [
  /(^|\.)sogirl\.so$/i
];
var ANTI_ADBLOCK_KW = /광고\s*차단|차단\s*기|애드\s*블[록로]|adblock|ad-?block|블로커|adblocker/i;
function isAntiAdblockHost() {
  try {
    return ANTI_ADBLOCK_HOSTS.some((re) => re.test(window.location.hostname));
  } catch {
    return false;
  }
}
function injectAdStubs() {
  try {
    const code = `(function(){try{
      var ag = window.adsbygoogle;
      if (!ag || ag.loaded !== true) {
        var arr = (ag && typeof ag.push === 'function') ? ag : [];
        try { arr.loaded = true; } catch(e){}
        try { arr.push = function(){ return (arr.length||0); }; } catch(e){}
        window.adsbygoogle = arr;
      }
      window.google_ad_status = 1;
      window.canRunAds = true;
      window.isAdBlockActive = false;
    }catch(e){}})();`;
    const s = document.createElement("script");
    s.textContent = code;
    (document.head || document.documentElement).prepend(s);
    s.remove();
  } catch {
  }
}
function defuseAntiAdblock() {
  injectAdStubs();
  try {
    const style = document.createElement("style");
    style.setAttribute("data-bb-antiadblock", "");
    style.textContent = "html,body{overflow:auto !important}";
    (document.head || document.documentElement).appendChild(style);
  } catch {
  }
  const hideEl = (el) => {
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("pointer-events", "none", "important");
  };
  const removeWalls = () => {
    try {
      const nodes = document.querySelectorAll("body *");
      for (const el of Array.from(nodes)) {
        const pos = getComputedStyle(el).position;
        if (pos !== "fixed" && pos !== "absolute" && pos !== "sticky") continue;
        const hay = `${el.id} ${el.className} ${(el.textContent || "").slice(0, 300)}`;
        if (ANTI_ADBLOCK_KW.test(hay)) hideEl(el);
      }
      document.documentElement.style.setProperty("overflow", "auto", "important");
      if (document.body) {
        document.body.style.setProperty("overflow", "auto", "important");
        document.body.style.setProperty("filter", "none", "important");
      }
    } catch {
    }
  };
  removeWalls();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", removeWalls, { once: true });
  }
  let scheduled = false;
  let observer = null;
  const onMutate = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      removeWalls();
    }, 200);
  };
  try {
    observer = new MutationObserver(onMutate);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
  }
  ;
  [400, 1e3, 2500, 5e3, 9e3].forEach((t) => setTimeout(removeWalls, t));
  setTimeout(() => {
    try {
      observer?.disconnect();
    } catch {
    }
  }, 12e3);
}
var AA_MODAL_SELECTOR = [
  '[class*="adde_modal_detector"]',
  '[class*="adde-modal"]',
  '[id*="adde_modal"]',
  ".adblock-modal",
  ".adblocker-modal",
  ".adb-modal",
  ".adblock-detected",
  ".adblock-overlay",
  ".adblock-popup",
  "#adblock-modal",
  "#adblockDetector"
].join(",");
function hideKnownAntiAdblockModals() {
  try {
    const s = document.createElement("style");
    s.setAttribute("data-bb-aa-modal", "");
    s.textContent = `${AA_MODAL_SELECTOR}{display:none !important;visibility:hidden !important;opacity:0 !important;pointer-events:none !important;}`;
    (document.head || document.documentElement).appendChild(s);
  } catch {
  }
  let loggedHidden = false;
  const sweep = () => {
    try {
      const found = document.querySelectorAll(AA_MODAL_SELECTOR);
      if (found.length === 0) return;
      for (const el of Array.from(found)) {
        el.style.setProperty("display", "none", "important");
        el.style.setProperty("visibility", "hidden", "important");
        el.style.setProperty("pointer-events", "none", "important");
      }
      document.documentElement.style.setProperty("overflow", "auto", "important");
      if (document.body) {
        document.body.style.setProperty("overflow", "auto", "important");
        document.body.style.setProperty("filter", "none", "important");
      }
      if (!loggedHidden) {
        loggedHidden = true;
        console.info("[bb] anti-adblock modal hidden:", found.length);
      }
    } catch {
    }
  };
  console.info("[bb] anti-adblock guard active @", window.location.hostname);
  sweep();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sweep, { once: true });
  }
  let scheduled = false;
  let observer = null;
  try {
    observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        sweep();
      }, 150);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "id", "style"] });
  } catch {
  }
  ;
  [0, 300, 800, 1500, 3e3, 6e3].forEach((t) => setTimeout(sweep, t));
  setTimeout(() => {
    try {
      observer?.disconnect();
    } catch {
    }
  }, 15e3);
}
if (!isExcludedContext()) {
  hideKnownAntiAdblockModals();
  if (isAntiAdblockHost()) defuseAntiAdblock();
}

// app/preload/internal.ts
function on(channel, cb) {
  const fn = (_, payload) => cb(payload);
  import_electron2.ipcRenderer.on(channel, fn);
  return () => {
    import_electron2.ipcRenderer.off(channel, fn);
  };
}
var api = {
  navigate: (url) => {
    window.location.href = url;
  },
  bookmarks: {
    list: () => import_electron2.ipcRenderer.invoke(IPC.bookmarks.list),
    add: (args) => import_electron2.ipcRenderer.invoke(IPC.bookmarks.add, args),
    remove: (id) => import_electron2.ipcRenderer.invoke(IPC.bookmarks.remove, { id }),
    rename: (id, title) => import_electron2.ipcRenderer.invoke(IPC.bookmarks.rename, { id, title }),
    update: (id, patch) => import_electron2.ipcRenderer.invoke(IPC.bookmarks.update, { id, ...patch }),
    move: (id, folderId, position) => import_electron2.ipcRenderer.invoke(IPC.bookmarks.move, { id, folderId, position }),
    folderCreate: (name, parentId) => import_electron2.ipcRenderer.invoke(IPC.bookmarks.folderCreate, { name, parentId }),
    folderRename: (id, name) => import_electron2.ipcRenderer.invoke(IPC.bookmarks.folderRename, { id, name }),
    folderRemove: (id) => import_electron2.ipcRenderer.invoke(IPC.bookmarks.folderRemove, { id }),
    exportHtml: () => import_electron2.ipcRenderer.invoke(IPC.bookmarks.exportHtml),
    importHtml: (html) => import_electron2.ipcRenderer.invoke(IPC.bookmarks.importHtml, { html }),
    onChanged: (cb) => on(IPC.bookmarks.changed, cb)
  },
  userscript: {
    list: () => import_electron2.ipcRenderer.invoke(IPC.userscript.list),
    get: (id) => import_electron2.ipcRenderer.invoke(IPC.userscript.get, { id }),
    save: (args) => import_electron2.ipcRenderer.invoke(IPC.userscript.save, args),
    remove: (id) => import_electron2.ipcRenderer.invoke(IPC.userscript.remove, { id }),
    setEnabled: (id, enabled) => import_electron2.ipcRenderer.invoke(IPC.userscript.setEnabled, { id, enabled }),
    onChanged: (cb) => on(IPC.userscript.changed, cb)
  },
  policy: {
    list: () => import_electron2.ipcRenderer.invoke(IPC.policy.list),
    get: (id) => import_electron2.ipcRenderer.invoke(IPC.policy.get, { id }),
    save: (rule) => import_electron2.ipcRenderer.invoke(IPC.policy.save, rule),
    remove: (id) => import_electron2.ipcRenderer.invoke(IPC.policy.remove, { id }),
    setEnabled: (id, enabled) => import_electron2.ipcRenderer.invoke(IPC.policy.setEnabled, { id, enabled }),
    onChanged: (cb) => on(IPC.policy.changed, cb)
  },
  history: {
    recent: (limit) => import_electron2.ipcRenderer.invoke(IPC.history.recent, { limit }),
    search: (query, limit) => import_electron2.ipcRenderer.invoke(IPC.history.search, { query, limit }),
    topSites: (limit) => import_electron2.ipcRenderer.invoke(IPC.history.topSites, { limit }),
    remove: (args) => import_electron2.ipcRenderer.invoke(IPC.history.remove, args),
    clear: (args) => import_electron2.ipcRenderer.invoke(IPC.history.clear, args ?? {}),
    onChanged: (cb) => on(IPC.history.changed, () => cb())
  },
  settings: {
    all: () => import_electron2.ipcRenderer.invoke(IPC.settings.all),
    get: (key) => import_electron2.ipcRenderer.invoke(IPC.settings.get, { key }),
    set: (key, value) => import_electron2.ipcRenderer.invoke(IPC.settings.set, { key, value }),
    onChange: (cb) => on(IPC.settings.changed, cb)
  },
  update: {
    status: () => import_electron2.ipcRenderer.invoke(IPC.update.status),
    check: () => import_electron2.ipcRenderer.invoke(IPC.update.check),
    download: () => import_electron2.ipcRenderer.invoke(IPC.update.download),
    install: () => import_electron2.ipcRenderer.invoke(IPC.update.install),
    setChannel: (channel) => import_electron2.ipcRenderer.invoke(IPC.update.setChannel, { channel }),
    setAutoDownload: (enabled) => import_electron2.ipcRenderer.invoke(IPC.update.setAutoDownload, { enabled }),
    setAutoCheck: (enabled) => import_electron2.ipcRenderer.invoke(IPC.update.setAutoCheck, { enabled }),
    onStatus: (cb) => on(IPC.update.status, cb)
  },
  search: {
    listEngines: () => import_electron2.ipcRenderer.invoke(IPC.search.listEngines)
  },
  keymap: {
    get: () => import_electron2.ipcRenderer.invoke(IPC.keymap.get),
    set: (keymap) => import_electron2.ipcRenderer.invoke(IPC.keymap.set, { keymap }),
    reset: () => import_electron2.ipcRenderer.invoke(IPC.keymap.reset)
  },
  password: {
    available: () => import_electron2.ipcRenderer.invoke(IPC.password.available),
    list: () => import_electron2.ipcRenderer.invoke(IPC.password.list),
    reveal: (id) => import_electron2.ipcRenderer.invoke(IPC.password.reveal, { id }),
    remove: (id) => import_electron2.ipcRenderer.invoke(IPC.password.remove, { id }),
    // 선등록 CRUD — browser:// 내부 페이지 전용. 외부 사이트가 쓰는 content preload 에는 노출하지 않는다.
    add: (a) => import_electron2.ipcRenderer.invoke(IPC.password.add, a),
    update: (a) => import_electron2.ipcRenderer.invoke(IPC.password.update, a),
    onChanged: (cb) => on(IPC.password.changed, cb)
  },
  workspace: {
    list: () => import_electron2.ipcRenderer.invoke(IPC.workspace.list),
    state: () => import_electron2.ipcRenderer.invoke(IPC.workspace.state),
    activate: (id) => import_electron2.ipcRenderer.invoke(IPC.workspace.activate, { id }),
    create: (args) => import_electron2.ipcRenderer.invoke(IPC.workspace.create, args ?? {}),
    update: (id, patch) => import_electron2.ipcRenderer.invoke(IPC.workspace.update, { id, patch }),
    remove: (id) => import_electron2.ipcRenderer.invoke(IPC.workspace.remove, { id }),
    onChanged: (cb) => on(IPC.workspace.changed, cb)
  },
  data: {
    export: () => import_electron2.ipcRenderer.invoke(IPC.data.export),
    import: (bundle) => import_electron2.ipcRenderer.invoke(IPC.data.import, { bundle })
  },
  tokens: {
    get: () => import_electron2.ipcRenderer.invoke(IPC.tokens.get),
    set: (key, value) => import_electron2.ipcRenderer.invoke(IPC.tokens.set, { key, value }),
    reset: () => import_electron2.ipcRenderer.invoke(IPC.tokens.reset),
    onChanged: (cb) => on(IPC.tokens.changed, cb)
  },
  macro: {
    list: () => import_electron2.ipcRenderer.invoke(IPC.macro.list),
    get: (id) => import_electron2.ipcRenderer.invoke(IPC.macro.get, { id }),
    save: (m) => import_electron2.ipcRenderer.invoke(IPC.macro.save, m),
    remove: (id) => import_electron2.ipcRenderer.invoke(IPC.macro.remove, { id }),
    run: (id, windowId) => import_electron2.ipcRenderer.invoke(IPC.macro.run, { id, windowId }),
    onChanged: (cb) => on(IPC.macro.changed, cb)
  },
  mod: {
    list: () => import_electron2.ipcRenderer.invoke(IPC.mod.list),
    setEnabled: (id, enabled) => import_electron2.ipcRenderer.invoke(IPC.mod.setEnabled, { id, enabled }),
    reload: (id) => import_electron2.ipcRenderer.invoke(IPC.mod.reload, { id }),
    remove: (id) => import_electron2.ipcRenderer.invoke(IPC.mod.remove, { id }),
    onChanged: (cb) => on(IPC.mod.changed, cb)
  },
  adblock: {
    stats: () => import_electron2.ipcRenderer.invoke(IPC.adblock.stats),
    setLevel: (level) => import_electron2.ipcRenderer.invoke(IPC.adblock.setLevel, { level }),
    setEnabled: (enabled) => import_electron2.ipcRenderer.invoke(IPC.adblock.setEnabled, { enabled }),
    setFilter: (id, enabled) => import_electron2.ipcRenderer.invoke(IPC.adblock.setFilter, { id, enabled }),
    setSiteAllowed: (host, allowed) => import_electron2.ipcRenderer.invoke(IPC.adblock.setSiteAllowed, { host, allowed }),
    onChanged: (cb) => on(IPC.adblock.changed, cb)
  },
  downloads: {
    list: () => import_electron2.ipcRenderer.invoke(IPC.downloads.list),
    pause: (id) => import_electron2.ipcRenderer.invoke(IPC.downloads.pause, { id }),
    resume: (id) => import_electron2.ipcRenderer.invoke(IPC.downloads.resume, { id }),
    cancel: (id) => import_electron2.ipcRenderer.invoke(IPC.downloads.cancel, { id }),
    openFolder: (id) => import_electron2.ipcRenderer.invoke(IPC.downloads.openFolder, { id }),
    pickFolder: () => import_electron2.ipcRenderer.invoke(IPC.downloads.pickFolder),
    onUpdate: (cb) => on(IPC.downloads.update, cb)
  },
  video: {
    ytdlpStatus: () => import_electron2.ipcRenderer.invoke(IPC.video.ytdlpStatus),
    ytdlpUpdate: () => import_electron2.ipcRenderer.invoke(IPC.video.ytdlpUpdate)
  },
  torrent: {
    add: (uri) => import_electron2.ipcRenderer.invoke(IPC.torrent.add, { uri }),
    pause: (id) => import_electron2.ipcRenderer.invoke(IPC.torrent.pause, { id }),
    resume: (id) => import_electron2.ipcRenderer.invoke(IPC.torrent.resume, { id }),
    remove: (id, deleteFiles) => import_electron2.ipcRenderer.invoke(IPC.torrent.remove, { id, deleteFiles }),
    setFiles: (id, indices) => import_electron2.ipcRenderer.invoke(IPC.torrent.setFiles, { id, indices })
  },
  extensions: {
    list: () => import_electron2.ipcRenderer.invoke(IPC.extensions.list),
    installFromCrx: (filePath) => import_electron2.ipcRenderer.invoke(IPC.extensions.installFromCrx, { path: filePath }),
    installFromUrl: (url) => import_electron2.ipcRenderer.invoke(IPC.extensions.installFromUrl, { url }),
    remove: (id) => import_electron2.ipcRenderer.invoke(IPC.extensions.remove, { id }),
    setEnabled: (id, enabled) => import_electron2.ipcRenderer.invoke(IPC.extensions.setEnabled, { id, enabled }),
    openOptions: (id) => import_electron2.ipcRenderer.invoke(IPC.extensions.openOptions, { id }),
    invokeAction: (id) => import_electron2.ipcRenderer.invoke(IPC.extensions.invokeAction, { id }),
    importLocal: () => import_electron2.ipcRenderer.invoke(IPC.extensions.importLocal),
    onChanged: (cb) => on(IPC.extensions.changed, cb)
  },
  actions: {
    list: () => import_electron2.ipcRenderer.invoke(IPC.actions.list),
    run: (id, ctx) => import_electron2.ipcRenderer.invoke(IPC.actions.run, { id, ctx })
  },
  perf: {
    report: () => import_electron2.ipcRenderer.invoke(IPC.perf.report),
    onMilestone: (cb) => on(IPC.perf.milestone, cb)
  },
  widgets: {
    weather: (force) => import_electron2.ipcRenderer.invoke(IPC.widgets.weather, { force }),
    news: (force) => import_electron2.ipcRenderer.invoke(IPC.widgets.news, { force }),
    fx: (force) => import_electron2.ipcRenderer.invoke(IPC.widgets.fx, { force }),
    dataGet: (key) => import_electron2.ipcRenderer.invoke(IPC.widgets.dataGet, { key }),
    dataSet: (key, value) => import_electron2.ipcRenderer.invoke(IPC.widgets.dataSet, { key, value })
  },
  permissions: {
    list: () => import_electron2.ipcRenderer.invoke(IPC.permissions.list),
    set: (origin, permission, decision) => import_electron2.ipcRenderer.invoke(IPC.permissions.set, { origin, permission, decision }),
    clearOrigin: (origin) => import_electron2.ipcRenderer.invoke(IPC.permissions.clearOrigin, { origin }),
    clearAll: () => import_electron2.ipcRenderer.invoke(IPC.permissions.clearAll),
    onChanged: (cb) => on(IPC.permissions.changed, cb)
  },
  readlater: {
    list: () => import_electron2.ipcRenderer.invoke(IPC.readlater.list),
    remove: (id) => import_electron2.ipcRenderer.invoke(IPC.readlater.remove, { id }),
    setRead: (id, read) => import_electron2.ipcRenderer.invoke(IPC.readlater.setRead, { id, read }),
    onChanged: (cb) => on(IPC.readlater.changed, cb)
  },
  importer: {
    sources: () => import_electron2.ipcRenderer.invoke(IPC.imports.sources),
    run: (sourceId, opts) => import_electron2.ipcRenderer.invoke(IPC.imports.run, { sourceId, ...opts })
  },
  onboarding: {
    setDefaultBrowser: () => import_electron2.ipcRenderer.invoke(IPC.onboarding.setDefaultBrowser),
    complete: () => import_electron2.ipcRenderer.invoke(IPC.onboarding.complete)
  },
  system: {
    metrics: () => import_electron2.ipcRenderer.invoke(IPC.system.metrics),
    bootInfo: () => import_electron2.ipcRenderer.invoke(IPC.system.bootInfo),
    sweepTabSleep: () => import_electron2.ipcRenderer.invoke(IPC.system.sweepTabSleep),
    wakeTab: (tabId) => import_electron2.ipcRenderer.invoke(IPC.system.wakeTab, { tabId }),
    licenses: () => import_electron2.ipcRenderer.invoke(IPC.system.licenses)
  },
  ai: {
    config: () => import_electron2.ipcRenderer.invoke(IPC.ai.config),
    detectProviders: (force) => import_electron2.ipcRenderer.invoke(IPC.ai.detectProviders, { force: !!force }),
    connectProvider: (provider, model) => import_electron2.ipcRenderer.invoke(IPC.ai.connectProvider, { provider, model }),
    keyStatus: () => import_electron2.ipcRenderer.invoke(IPC.ai.keyStatus),
    diagnose: () => import_electron2.ipcRenderer.invoke(IPC.ai.diagnose),
    setKey: (provider, key) => import_electron2.ipcRenderer.invoke(IPC.ai.setKey, { provider, key }),
    clearKey: (provider) => import_electron2.ipcRenderer.invoke(IPC.ai.clearKey, { provider }),
    memoryGet: () => import_electron2.ipcRenderer.invoke(IPC.ai.memoryGet),
    memorySet: (text) => import_electron2.ipcRenderer.invoke(IPC.ai.memorySet, { text }),
    memoryClear: () => import_electron2.ipcRenderer.invoke(IPC.ai.memoryClear),
    onMemoryChanged: (cb) => on(IPC.ai.memoryChanged, cb),
    pickAgentDir: () => import_electron2.ipcRenderer.invoke(IPC.ai.pickAgentDir),
    agentFilesInfo: () => import_electron2.ipcRenderer.invoke(IPC.ai.agentFilesInfo),
    triggerList: () => import_electron2.ipcRenderer.invoke(IPC.ai.triggerList),
    triggerAdd: (p) => import_electron2.ipcRenderer.invoke(IPC.ai.triggerAdd, p),
    triggerUpdate: (id, patch) => import_electron2.ipcRenderer.invoke(IPC.ai.triggerUpdate, { id, patch }),
    triggerRemove: (id) => import_electron2.ipcRenderer.invoke(IPC.ai.triggerRemove, { id }),
    triggerSetEnabled: (id, enabled) => import_electron2.ipcRenderer.invoke(IPC.ai.triggerSetEnabled, { id, enabled }),
    onTriggerChanged: (cb) => on(IPC.ai.triggerChanged, cb),
    profileGet: () => import_electron2.ipcRenderer.invoke(IPC.ai.profileGet),
    profileSet: (values) => import_electron2.ipcRenderer.invoke(IPC.ai.profileSet, values),
    onProfileChanged: (cb) => on(IPC.ai.profileChanged, cb),
    // 매일 자동 수집(피드 수집기) — browser://ai-collectors 관리 페이지용
    collectorList: () => import_electron2.ipcRenderer.invoke(IPC.ai.collectorList),
    collectorAdd: (p) => import_electron2.ipcRenderer.invoke(IPC.ai.collectorAdd, p),
    collectorUpdate: (id, patch) => import_electron2.ipcRenderer.invoke(IPC.ai.collectorUpdate, { id, patch }),
    collectorRemove: (id) => import_electron2.ipcRenderer.invoke(IPC.ai.collectorRemove, { id }),
    collectorSetEnabled: (id, enabled) => import_electron2.ipcRenderer.invoke(IPC.ai.collectorSetEnabled, { id, enabled }),
    collectorRun: (id) => import_electron2.ipcRenderer.invoke(IPC.ai.collectorRun, { id }),
    collectorRuns: (id) => import_electron2.ipcRenderer.invoke(IPC.ai.collectorRuns, { id }),
    onCollectorChanged: (cb) => on(IPC.ai.collectorChanged, cb),
    onCollectorRan: (cb) => on(IPC.ai.collectorRan, cb)
  }
};
import_electron2.contextBridge.exposeInMainWorld("internalAPI", api);
