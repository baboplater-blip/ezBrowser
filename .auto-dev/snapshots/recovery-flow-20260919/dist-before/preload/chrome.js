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

// app/preload/chrome.ts
var chrome_exports = {};
module.exports = __toCommonJS(chrome_exports);
var import_electron = require("electron");

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

// app/preload/chrome.ts
function on(channel, cb) {
  const fn = (_, payload) => cb(payload);
  import_electron.ipcRenderer.on(channel, fn);
  return () => {
    import_electron.ipcRenderer.off(channel, fn);
  };
}
var api = {
  windows: {
    onReady: (cb) => on(IPC.windows.ready, cb),
    setChromeHeight: (windowId, height) => import_electron.ipcRenderer.invoke(IPC.windows.setChromeHeight, { windowId, height }),
    setShellInsets: (windowId, partial) => import_electron.ipcRenderer.invoke(IPC.windows.setShellInsets, { windowId, ...partial }),
    setPaneSplitRatio: (windowId, ratio) => import_electron.ipcRenderer.invoke(IPC.windows.setPaneSplitRatio, { windowId, ratio }),
    focusPane: (windowId, idx) => import_electron.ipcRenderer.invoke(IPC.windows.focusPane, { windowId, idx }),
    onLayoutChanged: (cb) => on(IPC.windows.layoutChanged, cb),
    beginPaneDrag: (windowId) => import_electron.ipcRenderer.invoke(IPC.windows.beginPaneDrag, { windowId }),
    endPaneDrag: (windowId) => import_electron.ipcRenderer.invoke(IPC.windows.endPaneDrag, { windowId })
  },
  tabs: {
    create: (windowId, url, opts) => import_electron.ipcRenderer.invoke(IPC.tabs.create, { windowId, url, background: opts?.background }),
    list: (windowId) => import_electron.ipcRenderer.invoke(IPC.tabs.list, { windowId }),
    activate: (tabId) => import_electron.ipcRenderer.invoke(IPC.tabs.activate, { tabId }),
    close: (tabId) => import_electron.ipcRenderer.invoke(IPC.tabs.close, { tabId }),
    pin: (tabId, pinned) => import_electron.ipcRenderer.invoke(IPC.tabs.pin, { tabId, pinned }),
    duplicate: (tabId) => import_electron.ipcRenderer.invoke(IPC.tabs.duplicate, { tabId }),
    restore: (windowId) => import_electron.ipcRenderer.invoke(IPC.tabs.restore, { windowId }),
    reorder: (windowId, orderedIds) => import_electron.ipcRenderer.invoke(IPC.tabs.reorder, { windowId, orderedIds }),
    navigate: (tabId, url) => import_electron.ipcRenderer.invoke(IPC.tabs.navigate, { tabId, url }),
    back: (tabId) => import_electron.ipcRenderer.invoke(IPC.tabs.back, { tabId }),
    forward: (tabId) => import_electron.ipcRenderer.invoke(IPC.tabs.forward, { tabId }),
    reload: (tabId) => import_electron.ipcRenderer.invoke(IPC.tabs.reload, { tabId }),
    stop: (tabId) => import_electron.ipcRenderer.invoke(IPC.tabs.stop, { tabId }),
    setMuted: (tabId, muted) => import_electron.ipcRenderer.invoke(IPC.tabs.setMuted, { tabId, muted }),
    capture: (tabId) => import_electron.ipcRenderer.invoke(IPC.tabs.capture, { tabId }),
    onUpdate: (cb) => on(IPC.tabs.update, cb),
    onListChanged: (cb) => on(IPC.tabs.listChanged, cb)
  },
  groups: {
    list: (windowId) => import_electron.ipcRenderer.invoke(IPC.groups.list, { windowId }),
    create: (windowId, opts) => import_electron.ipcRenderer.invoke(IPC.groups.create, { windowId, ...opts }),
    update: (groupId, patch) => import_electron.ipcRenderer.invoke(IPC.groups.update, { groupId, ...patch }),
    remove: (groupId) => import_electron.ipcRenderer.invoke(IPC.groups.remove, { groupId }),
    setCollapsed: (groupId, collapsed) => import_electron.ipcRenderer.invoke(IPC.groups.setCollapsed, { groupId, collapsed }),
    assignTab: (tabId, groupId) => import_electron.ipcRenderer.invoke(IPC.groups.assignTab, { tabId, groupId }),
    onChanged: (cb) => on(IPC.groups.changed, cb)
  },
  omnibox: {
    suggest: (query, windowId) => import_electron.ipcRenderer.invoke(IPC.omnibox.suggest, { query, windowId }),
    navigate: (windowId, tabId, input) => import_electron.ipcRenderer.invoke(IPC.omnibox.navigate, { windowId, tabId, input }),
    onFocus: (cb) => on("omnibox:focus", () => cb())
  },
  search: {
    listEngines: () => import_electron.ipcRenderer.invoke(IPC.search.listEngines)
  },
  actions: {
    list: () => import_electron.ipcRenderer.invoke(IPC.actions.list),
    run: (id, ctx) => import_electron.ipcRenderer.invoke(IPC.actions.run, { id, ctx })
  },
  keymap: {
    get: () => import_electron.ipcRenderer.invoke(IPC.keymap.get),
    set: (keymap) => import_electron.ipcRenderer.invoke(IPC.keymap.set, { keymap }),
    reset: () => import_electron.ipcRenderer.invoke(IPC.keymap.reset)
  },
  palette: {
    onOpen: (cb) => on("palette:open", () => cb())
  },
  tabsearch: {
    onOpen: (cb) => on("tabsearch:open", () => cb())
  },
  recentClosed: {
    list: (limit) => import_electron.ipcRenderer.invoke(IPC.recentClosed.list, { limit }),
    reopen: (id, windowId) => import_electron.ipcRenderer.invoke(IPC.recentClosed.reopen, { id, windowId }),
    clear: () => import_electron.ipcRenderer.invoke(IPC.recentClosed.clear),
    onOpen: (cb) => on("recent-closed:open", () => cb())
  },
  widgets: {
    dataGet: (key) => import_electron.ipcRenderer.invoke(IPC.widgets.dataGet, { key }),
    dataSet: (key, value) => import_electron.ipcRenderer.invoke(IPC.widgets.dataSet, { key, value })
  },
  permissions: {
    list: () => import_electron.ipcRenderer.invoke(IPC.permissions.list),
    set: (origin, permission, decision) => import_electron.ipcRenderer.invoke(IPC.permissions.set, { origin, permission, decision }),
    clearOrigin: (origin) => import_electron.ipcRenderer.invoke(IPC.permissions.clearOrigin, { origin }),
    onChanged: (cb) => on(IPC.permissions.changed, cb)
  },
  sitedata: {
    summary: (origin) => import_electron.ipcRenderer.invoke(IPC.sitedata.summary, { origin }),
    clear: (origin) => import_electron.ipcRenderer.invoke(IPC.sitedata.clear, { origin })
  },
  readlater: {
    list: () => import_electron.ipcRenderer.invoke(IPC.readlater.list),
    add: (args) => import_electron.ipcRenderer.invoke(IPC.readlater.add, args),
    remove: (id) => import_electron.ipcRenderer.invoke(IPC.readlater.remove, { id }),
    setRead: (id, read) => import_electron.ipcRenderer.invoke(IPC.readlater.setRead, { id, read }),
    clearRead: () => import_electron.ipcRenderer.invoke(IPC.readlater.clearRead),
    isSaved: (url) => import_electron.ipcRenderer.invoke(IPC.readlater.isSaved, { url }),
    onChanged: (cb) => on(IPC.readlater.changed, cb),
    onOpenPanel: (cb) => on("readlater:open-panel", () => cb())
  },
  clearData: {
    onOpen: (cb) => on("cleardata:open", () => cb())
  },
  settings: {
    all: () => import_electron.ipcRenderer.invoke(IPC.settings.all),
    get: (key) => import_electron.ipcRenderer.invoke(IPC.settings.get, { key }),
    set: (key, value) => import_electron.ipcRenderer.invoke(IPC.settings.set, { key, value }),
    onChange: (cb) => on(IPC.settings.changed, cb)
  },
  userchrome: {
    get: () => import_electron.ipcRenderer.invoke(IPC.userchrome.get),
    update: (kind, content) => import_electron.ipcRenderer.invoke(IPC.userchrome.update, { kind, content }),
    reload: () => import_electron.ipcRenderer.invoke(IPC.userchrome.reload),
    open: (kind) => import_electron.ipcRenderer.invoke(IPC.userchrome.open, { kind }),
    onChanged: (cb) => on(IPC.userchrome.cssChanged, cb)
  },
  downloads: {
    list: () => import_electron.ipcRenderer.invoke(IPC.downloads.list),
    pause: (id) => import_electron.ipcRenderer.invoke(IPC.downloads.pause, { id }),
    resume: (id) => import_electron.ipcRenderer.invoke(IPC.downloads.resume, { id }),
    cancel: (id) => import_electron.ipcRenderer.invoke(IPC.downloads.cancel, { id }),
    openFolder: (id) => import_electron.ipcRenderer.invoke(IPC.downloads.openFolder, { id }),
    openFile: (id) => import_electron.ipcRenderer.invoke(IPC.downloads.openFile, { id }),
    copyPath: (id) => import_electron.ipcRenderer.invoke(IPC.downloads.copyPath, { id }),
    retry: (id) => import_electron.ipcRenderer.invoke(IPC.downloads.retry, { id }),
    remove: (id) => import_electron.ipcRenderer.invoke(IPC.downloads.remove, { id }),
    clearFinished: () => import_electron.ipcRenderer.invoke(IPC.downloads.clearFinished),
    onUpdate: (cb) => on(IPC.downloads.update, cb)
  },
  adblock: {
    stats: () => import_electron.ipcRenderer.invoke(IPC.adblock.stats),
    setLevel: (level) => import_electron.ipcRenderer.invoke(IPC.adblock.setLevel, { level }),
    setEnabled: (enabled) => import_electron.ipcRenderer.invoke(IPC.adblock.setEnabled, { enabled }),
    setFilter: (id, enabled) => import_electron.ipcRenderer.invoke(IPC.adblock.setFilter, { id, enabled }),
    setSiteAllowed: (host, allowed) => import_electron.ipcRenderer.invoke(IPC.adblock.setSiteAllowed, { host, allowed }),
    toggleSite: (url) => import_electron.ipcRenderer.invoke(IPC.adblock.toggleSite, { url }),
    onChanged: (cb) => on(IPC.adblock.changed, cb)
  },
  screenshot: {
    captureViewport: (tabId) => import_electron.ipcRenderer.invoke(IPC.screenshot.capture, { tabId, mode: "viewport" }),
    captureArea: (tabId, rect) => import_electron.ipcRenderer.invoke(IPC.screenshot.capture, { tabId, mode: "area", rect }),
    saveDataUrl: (dataUrl) => import_electron.ipcRenderer.invoke(IPC.screenshot.saveToFile, { dataUrl })
  },
  find: {
    start: (tabId, text, options) => import_electron.ipcRenderer.invoke(IPC.find.start, { tabId, text, options }),
    stop: (tabId, keepSelection) => import_electron.ipcRenderer.invoke(IPC.find.stop, { tabId, keepSelection }),
    onResult: (cb) => on(IPC.find.result, cb),
    onOpen: (cb) => on(IPC.find.open, cb)
  },
  page: {
    print: (tabId) => import_electron.ipcRenderer.invoke(IPC.page.print, { tabId }),
    printToPdf: (tabId) => import_electron.ipcRenderer.invoke(IPC.page.printToPdf, { tabId }),
    zoomGet: (tabId) => import_electron.ipcRenderer.invoke(IPC.page.zoomGet, { tabId }),
    zoomSet: (tabId, delta) => import_electron.ipcRenderer.invoke(IPC.page.zoomSet, { tabId, delta })
  },
  torrent: {
    add: (uri) => import_electron.ipcRenderer.invoke(IPC.torrent.add, { uri }),
    pause: (id) => import_electron.ipcRenderer.invoke(IPC.torrent.pause, { id }),
    resume: (id) => import_electron.ipcRenderer.invoke(IPC.torrent.resume, { id }),
    remove: (id, deleteFiles) => import_electron.ipcRenderer.invoke(IPC.torrent.remove, { id, deleteFiles }),
    setFiles: (id, indices) => import_electron.ipcRenderer.invoke(IPC.torrent.setFiles, { id, indices })
  },
  video: {
    candidates: (tabId) => import_electron.ipcRenderer.invoke(IPC.video.candidates, { tabId }),
    download: (candidate) => import_electron.ipcRenderer.invoke(IPC.video.download, { candidate }),
    ytdlpStatus: () => import_electron.ipcRenderer.invoke(IPC.video.ytdlpStatus),
    ytdlpEnsure: () => import_electron.ipcRenderer.invoke(IPC.video.ytdlpEnsure),
    ytdlpUpdate: () => import_electron.ipcRenderer.invoke(IPC.video.ytdlpUpdate),
    onCandidates: (cb) => on(IPC.video.candidatesChanged, cb)
  },
  bookmarks: {
    list: () => import_electron.ipcRenderer.invoke(IPC.bookmarks.list),
    add: (args) => import_electron.ipcRenderer.invoke(IPC.bookmarks.add, args),
    remove: (id) => import_electron.ipcRenderer.invoke(IPC.bookmarks.remove, { id }),
    rename: (id, title) => import_electron.ipcRenderer.invoke(IPC.bookmarks.rename, { id, title }),
    move: (id, folderId, position) => import_electron.ipcRenderer.invoke(IPC.bookmarks.move, { id, folderId, position }),
    isBookmarked: (url) => import_electron.ipcRenderer.invoke(IPC.bookmarks.isBookmarked, { url }),
    folderCreate: (name, parentId) => import_electron.ipcRenderer.invoke(IPC.bookmarks.folderCreate, { name, parentId }),
    folderRemove: (id) => import_electron.ipcRenderer.invoke(IPC.bookmarks.folderRemove, { id }),
    onChanged: (cb) => on(IPC.bookmarks.changed, cb)
  },
  history: {
    recent: (limit) => import_electron.ipcRenderer.invoke(IPC.history.recent, { limit }),
    search: (query, limit) => import_electron.ipcRenderer.invoke(IPC.history.search, { query, limit }),
    topSites: (limit) => import_electron.ipcRenderer.invoke(IPC.history.topSites, { limit }),
    remove: (args) => import_electron.ipcRenderer.invoke(IPC.history.remove, args),
    clear: (args) => import_electron.ipcRenderer.invoke(IPC.history.clear, args ?? {}),
    onChanged: (cb) => on(IPC.history.changed, () => cb())
  },
  toast: {
    onShow: (cb) => on("toast:show", cb)
  },
  panel: {
    onOpen: (cb) => on("panel:open", cb)
  },
  bookmarkBar: {
    onToggle: (cb) => on("bookmark-bar:toggle", () => cb())
  },
  sidepanel: {
    onToggle: (cb) => on("sidepanel:toggle", cb)
  },
  tabbar: {
    onCycleOrientation: (cb) => on("tabbar:cycle-orientation", () => cb())
  },
  qrcode: {
    generate: (text, size) => import_electron.ipcRenderer.invoke(IPC.qrcode.generate, { text, size }),
    onOpen: (cb) => on("qrcode:open", cb)
  },
  password: {
    onPromptOpen: (cb) => on(IPC.password.promptOpen, cb),
    onPromptResolved: (cb) => on(IPC.password.promptResolved, cb),
    confirmSave: (promptId, action) => import_electron.ipcRenderer.invoke(IPC.password.confirmSave, { promptId, action })
  },
  workspace: {
    list: () => import_electron.ipcRenderer.invoke(IPC.workspace.list),
    state: () => import_electron.ipcRenderer.invoke(IPC.workspace.state),
    activate: (id) => import_electron.ipcRenderer.invoke(IPC.workspace.activate, { id }),
    create: (args) => import_electron.ipcRenderer.invoke(IPC.workspace.create, args ?? {}),
    update: (id, patch) => import_electron.ipcRenderer.invoke(IPC.workspace.update, { id, patch }),
    remove: (id) => import_electron.ipcRenderer.invoke(IPC.workspace.remove, { id }),
    reorder: (orderedIds) => import_electron.ipcRenderer.invoke(IPC.workspace.reorder, { orderedIds }),
    onChanged: (cb) => on(IPC.workspace.changed, cb)
  },
  tokens: {
    onChanged: (cb) => on(IPC.tokens.changed, cb)
  },
  update: {
    status: () => import_electron.ipcRenderer.invoke(IPC.update.status),
    check: () => import_electron.ipcRenderer.invoke(IPC.update.check),
    download: () => import_electron.ipcRenderer.invoke(IPC.update.download),
    install: () => import_electron.ipcRenderer.invoke(IPC.update.install),
    setChannel: (channel) => import_electron.ipcRenderer.invoke(IPC.update.setChannel, { channel }),
    setAutoDownload: (enabled) => import_electron.ipcRenderer.invoke(IPC.update.setAutoDownload, { enabled }),
    setAutoCheck: (enabled) => import_electron.ipcRenderer.invoke(IPC.update.setAutoCheck, { enabled }),
    onStatus: (cb) => on(IPC.update.status, cb)
  },
  mod: {
    menuList: () => import_electron.ipcRenderer.invoke(IPC.mod.menuList),
    menuInvoke: (id) => import_electron.ipcRenderer.invoke(IPC.mod.menuInvoke, { id }),
    onChanged: (cb) => on(IPC.mod.changed, () => cb())
  },
  macro: {
    list: () => import_electron.ipcRenderer.invoke(IPC.macro.list),
    run: (id, windowId) => import_electron.ipcRenderer.invoke(IPC.macro.run, { id, windowId }),
    onChanged: (cb) => on(IPC.macro.changed, cb)
  },
  extensions: {
    list: () => import_electron.ipcRenderer.invoke(IPC.extensions.list),
    installFromCrx: (filePath) => import_electron.ipcRenderer.invoke(IPC.extensions.installFromCrx, { path: filePath }),
    installFromUrl: (url) => import_electron.ipcRenderer.invoke(IPC.extensions.installFromUrl, { url }),
    remove: (id) => import_electron.ipcRenderer.invoke(IPC.extensions.remove, { id }),
    setEnabled: (id, enabled) => import_electron.ipcRenderer.invoke(IPC.extensions.setEnabled, { id, enabled }),
    openOptions: (id) => import_electron.ipcRenderer.invoke(IPC.extensions.openOptions, { id }),
    invokeAction: (id) => import_electron.ipcRenderer.invoke(IPC.extensions.invokeAction, { id }),
    onChanged: (cb) => on(IPC.extensions.changed, cb)
  },
  ai: {
    config: () => import_electron.ipcRenderer.invoke(IPC.ai.config),
    /** 이 컴퓨터에서 지금 쓸 수 있는 제공자 — 요금 드는 호출은 하지 않는다. */
    detectProviders: (force) => import_electron.ipcRenderer.invoke(IPC.ai.detectProviders, { force: !!force }),
    /** 제공자를 고르고 실제로 한 번 물어봐 확인 — 실패하면 원인·해결책이 함께 온다. */
    connectProvider: (provider, model) => import_electron.ipcRenderer.invoke(IPC.ai.connectProvider, { provider, model }),
    pageContext: (tabId) => import_electron.ipcRenderer.invoke(IPC.ai.pageContext, { tabId }),
    send: (args) => import_electron.ipcRenderer.invoke(IPC.ai.send, args),
    cancel: (reqId) => import_electron.ipcRenderer.invoke(IPC.ai.cancel, { reqId }),
    summarize: (messages, prevSummary) => import_electron.ipcRenderer.invoke(IPC.ai.summarize, { messages, prevSummary }),
    onDelta: (cb) => on(IPC.ai.delta, cb),
    onDone: (cb) => on(IPC.ai.done, cb),
    onError: (cb) => on(IPC.ai.error, cb),
    onOpen: (cb) => on("ai:open", cb),
    onSummarize: (cb) => on("ai:summarize", cb),
    onWrite: (cb) => on("ai:write", cb),
    agentStart: (args) => import_electron.ipcRenderer.invoke(IPC.ai.agentStart, args),
    exportWebhook: (rows, url) => import_electron.ipcRenderer.invoke(IPC.ai.exportWebhook, { rows, url }),
    blogGenerate: (params) => import_electron.ipcRenderer.invoke(IPC.ai.blogGenerate, params),
    blogSeriesPlan: (params) => import_electron.ipcRenderer.invoke(IPC.ai.blogSeriesPlan, params),
    blogRefine: (params) => import_electron.ipcRenderer.invoke(IPC.ai.blogRefine, params),
    blogBuildTask: (params) => import_electron.ipcRenderer.invoke(IPC.ai.blogBuildTask, params),
    snsBuildTask: (params) => import_electron.ipcRenderer.invoke(IPC.ai.snsBuildTask, params),
    // 입력창에 친 한 줄을 워크플로 폼값으로 읽는다(순수 판독 — 아무 작업도 시작하지 않는다).
    intentDetect: (text) => import_electron.ipcRenderer.invoke(IPC.ai.intentDetect, { text }),
    // ===== 생성물 파이프라인 · 생성→게시 워크플로 · 블로그 참여 (묶음 SOCIAL-1) =====
    artifactList: (taskId) => import_electron.ipcRenderer.invoke(IPC.ai.artifactList, { taskId }),
    artifactData: (taskId, id) => import_electron.ipcRenderer.invoke(IPC.ai.artifactData, { taskId, id }),
    socialList: () => import_electron.ipcRenderer.invoke(IPC.ai.socialList),
    socialStart: (params) => import_electron.ipcRenderer.invoke(IPC.ai.socialStart, params),
    socialApprove: (id, caption) => import_electron.ipcRenderer.invoke(IPC.ai.socialApprove, { id, caption }),
    socialChoose: (id, artifactId) => import_electron.ipcRenderer.invoke(IPC.ai.socialChoose, { id, artifactId }),
    // 이번 작업 한정 자동 게시 선승인(사용자가 시작할 때 명시 선택). 범위 밖은 자동 게시되지 않는다.
    socialGrant: (input) => import_electron.ipcRenderer.invoke(IPC.ai.socialGrant, input),
    socialGrantGet: () => import_electron.ipcRenderer.invoke(IPC.ai.socialGrantGet),
    socialGrantRevoke: () => import_electron.ipcRenderer.invoke(IPC.ai.socialGrantRevoke),
    socialCancel: (id) => import_electron.ipcRenderer.invoke(IPC.ai.socialCancel, { id }),
    socialDelete: (id) => import_electron.ipcRenderer.invoke(IPC.ai.socialDelete, { id }),
    onSocialChanged: (cb) => on(IPC.ai.socialChanged, cb),
    engageBuildTask: (params) => import_electron.ipcRenderer.invoke(IPC.ai.engageBuildTask, params),
    engageLedger: (limit) => import_electron.ipcRenderer.invoke(IPC.ai.engageLedger, { limit }),
    engageLedgerClear: () => import_electron.ipcRenderer.invoke(IPC.ai.engageLedgerClear),
    reportBuildTask: (params) => import_electron.ipcRenderer.invoke(IPC.ai.reportBuildTask, params),
    reportExport: (p) => import_electron.ipcRenderer.invoke(IPC.ai.reportExport, p),
    blogDraftList: () => import_electron.ipcRenderer.invoke(IPC.ai.blogDraftList),
    blogDraftGet: (id) => import_electron.ipcRenderer.invoke(IPC.ai.blogDraftGet, { id }),
    blogDraftSave: (payload) => import_electron.ipcRenderer.invoke(IPC.ai.blogDraftSave, payload),
    blogDraftRemove: (id) => import_electron.ipcRenderer.invoke(IPC.ai.blogDraftRemove, { id }),
    onBlogDraftChanged: (cb) => on(IPC.ai.blogDraftChanged, cb),
    // 매일 자동 수집 — 사이드바 브리핑 탭용(읽기 + 지금 수집)
    collectorList: () => import_electron.ipcRenderer.invoke(IPC.ai.collectorList),
    collectorRuns: (id) => import_electron.ipcRenderer.invoke(IPC.ai.collectorRuns, { id }),
    collectorRun: (id) => import_electron.ipcRenderer.invoke(IPC.ai.collectorRun, { id }),
    onCollectorChanged: (cb) => on(IPC.ai.collectorChanged, cb),
    onCollectorRan: (cb) => on(IPC.ai.collectorRan, cb),
    agentConfirm: (reqId, approved) => import_electron.ipcRenderer.invoke(IPC.ai.agentConfirm, { reqId, approved }),
    agentReply: (reqId, answer) => import_electron.ipcRenderer.invoke(IPC.ai.agentReply, { reqId, answer }),
    agentCancel: (reqId) => import_electron.ipcRenderer.invoke(IPC.ai.agentCancel, { reqId }),
    agentReset: (windowId) => import_electron.ipcRenderer.invoke(IPC.ai.agentReset, { windowId }),
    onAgentEvent: (cb) => on(IPC.ai.agentEvent, cb),
    convList: () => import_electron.ipcRenderer.invoke(IPC.ai.convList),
    convGet: (id) => import_electron.ipcRenderer.invoke(IPC.ai.convGet, { id }),
    convSave: (args) => import_electron.ipcRenderer.invoke(IPC.ai.convSave, args),
    convDelete: (id) => import_electron.ipcRenderer.invoke(IPC.ai.convDelete, { id }),
    convRename: (id, title) => import_electron.ipcRenderer.invoke(IPC.ai.convRename, { id, title }),
    convClear: () => import_electron.ipcRenderer.invoke(IPC.ai.convClear),
    onConvChanged: (cb) => on(IPC.ai.convChanged, cb),
    convSetFolder: (id, folderId) => import_electron.ipcRenderer.invoke(IPC.ai.convSetFolder, { id, folderId }),
    convSetTags: (id, tags) => import_electron.ipcRenderer.invoke(IPC.ai.convSetTags, { id, tags }),
    convSetPinned: (id, pinned) => import_electron.ipcRenderer.invoke(IPC.ai.convSetPinned, { id, pinned }),
    convSearch: (query) => import_electron.ipcRenderer.invoke(IPC.ai.convSearch, { query }),
    convExport: (id) => import_electron.ipcRenderer.invoke(IPC.ai.convExport, { id }),
    convExportBulk: (ids) => import_electron.ipcRenderer.invoke(IPC.ai.convExportBulk, { ids }),
    folderList: () => import_electron.ipcRenderer.invoke(IPC.ai.folderList),
    folderCreate: (name) => import_electron.ipcRenderer.invoke(IPC.ai.folderCreate, { name }),
    folderRename: (id, name) => import_electron.ipcRenderer.invoke(IPC.ai.folderRename, { id, name }),
    folderDelete: (id) => import_electron.ipcRenderer.invoke(IPC.ai.folderDelete, { id }),
    folderReorder: (orderedIds) => import_electron.ipcRenderer.invoke(IPC.ai.folderReorder, { orderedIds }),
    folderSetColor: (id, color) => import_electron.ipcRenderer.invoke(IPC.ai.folderSetColor, { id, color }),
    folderSetEmoji: (id, emoji) => import_electron.ipcRenderer.invoke(IPC.ai.folderSetEmoji, { id, emoji }),
    onFolderChanged: (cb) => on(IPC.ai.folderChanged, cb),
    taskList: () => import_electron.ipcRenderer.invoke(IPC.ai.taskList),
    taskAdd: (task, name) => import_electron.ipcRenderer.invoke(IPC.ai.taskAdd, { task, name }),
    taskRemove: (id) => import_electron.ipcRenderer.invoke(IPC.ai.taskRemove, { id }),
    taskRename: (id, name) => import_electron.ipcRenderer.invoke(IPC.ai.taskRename, { id, name }),
    taskTouch: (id) => import_electron.ipcRenderer.invoke(IPC.ai.taskTouch, { id }),
    onTaskChanged: (cb) => on(IPC.ai.taskChanged, cb),
    runList: () => import_electron.ipcRenderer.invoke(IPC.ai.runList),
    runGet: (id) => import_electron.ipcRenderer.invoke(IPC.ai.runGet, { id }),
    runDelete: (id) => import_electron.ipcRenderer.invoke(IPC.ai.runDelete, { id }),
    runClear: () => import_electron.ipcRenderer.invoke(IPC.ai.runClear),
    onRunChanged: (cb) => on(IPC.ai.runChanged, cb),
    // 자동 반복
    repeatStart: (args) => import_electron.ipcRenderer.invoke(IPC.ai.repeatStart, args),
    repeatStop: (id) => import_electron.ipcRenderer.invoke(IPC.ai.repeatStop, { id }),
    repeatRemove: (id) => import_electron.ipcRenderer.invoke(IPC.ai.repeatRemove, { id }),
    repeatList: () => import_electron.ipcRenderer.invoke(IPC.ai.repeatList),
    onRepeatChanged: (cb) => on(IPC.ai.repeatChanged, cb),
    onRepeatEvent: (cb) => on(IPC.ai.repeatEvent, cb),
    // ===== 영속 작업 런타임(구간 단위로 이어가는 장기 에이전트 작업) =====
    // 채널이 ptask* 인 이유: ai:task-* 는 위의 taskList/taskAdd/...(에이전트 작업 매크로 —
    // SavedAgentTask)가 이미 쓰고 있다. 같은 이름을 쓰면 부팅 시 ipcMain.handle 이 같은 채널에
    // 두 번째 핸들러를 등록하려다 throw 하거나, 이 객체 리터럴 안에서 뒤에 쓴 메서드가 앞의
    // taskList/taskAdd 를 조용히 덮어써 macro 기능이 먹통이 된다 — 그래서 이름을 분리했다.
    ptaskList: () => import_electron.ipcRenderer.invoke(IPC.ai.ptaskList),
    ptaskGet: (id) => import_electron.ipcRenderer.invoke(IPC.ai.ptaskGet, { id }),
    ptaskCreate: (args) => import_electron.ipcRenderer.invoke(IPC.ai.ptaskCreate, args),
    // 시작/일시정지/재개/취소/삭제/승인은 소유 창이 아니면 메인이 거부한다(ok:false + 이유) —
    // 실패해도 throw 하지 않으니 UI 는 항상 ok 를 확인해야 한다.
    ptaskStart: (id) => import_electron.ipcRenderer.invoke(IPC.ai.ptaskStart, { id }),
    ptaskPause: (id) => import_electron.ipcRenderer.invoke(IPC.ai.ptaskPause, { id }),
    ptaskResume: (id) => import_electron.ipcRenderer.invoke(IPC.ai.ptaskResume, { id }),
    ptaskCancel: (id) => import_electron.ipcRenderer.invoke(IPC.ai.ptaskCancel, { id }),
    ptaskDelete: (id) => import_electron.ipcRenderer.invoke(IPC.ai.ptaskDelete, { id }),
    ptaskAccept: (id) => import_electron.ipcRenderer.invoke(IPC.ai.ptaskAccept, { id }),
    ptaskConfirm: (id, approved) => import_electron.ipcRenderer.invoke(IPC.ai.ptaskConfirm, { id, approved }),
    ptaskAnswer: (id, answer) => import_electron.ipcRenderer.invoke(IPC.ai.ptaskAnswer, { id, answer }),
    onPtaskChanged: (cb) => on(IPC.ai.ptaskChanged, cb),
    onPtaskEvent: (cb) => on(IPC.ai.ptaskEvent, cb),
    // 반복 예약(에이전트 자동 반복) 재개 — 이미 돌던 작업을 이어서 재개.
    scheduleResume: (id) => import_electron.ipcRenderer.invoke(IPC.ai.scheduleResume, { id })
  }
};
import_electron.contextBridge.exposeInMainWorld("browserAPI", api);
