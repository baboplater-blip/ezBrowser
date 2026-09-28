export const IPC = {
  windows: {
    ready: 'windows:ready',
    list: 'windows:list',
    focus: 'windows:focus',
    create: 'windows:create',
    setChromeHeight: 'windows:set-chrome-height',
    setShellInsets: 'windows:set-shell-insets',
    setPaneSplitRatio: 'windows:set-pane-split-ratio',
    focusPane: 'windows:focus-pane',
    layoutChanged: 'windows:layout-changed',
    beginPaneDrag: 'windows:begin-pane-drag',
    endPaneDrag: 'windows:end-pane-drag',
  },
  tabs: {
    create: 'tabs:create',
    list: 'tabs:list',
    listChanged: 'tabs:list-changed',
    activate: 'tabs:activate',
    close: 'tabs:close',
    reorder: 'tabs:reorder',
    pin: 'tabs:pin',
    duplicate: 'tabs:duplicate',
    restore: 'tabs:restore',
    update: 'tabs:update',
    capture: 'tabs:capture',
    navigate: 'tabs:navigate',
    back: 'tabs:back',
    forward: 'tabs:forward',
    reload: 'tabs:reload',
    stop: 'tabs:stop',
    setMuted: 'tabs:set-muted',
  },
  omnibox: {
    suggest: 'omnibox:suggest',
    navigate: 'omnibox:navigate',
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
    all: 'settings:all',
    changed: 'settings:changed',
  },
  actions: {
    list: 'actions:list',
    run: 'actions:run',
  },
  keymap: {
    get: 'keymap:get',
    set: 'keymap:set',
    reset: 'keymap:reset',
  },
  palette: {
    open: 'palette:open',
    close: 'palette:close',
  },
  tabsearch: {
    open: 'tabsearch:open',
  },
  recentClosed: {
    list: 'recent-closed:list',
    reopen: 'recent-closed:reopen',
    clear: 'recent-closed:clear',
    open: 'recent-closed:open',
  },
  userchrome: {
    get: 'userchrome:get',
    update: 'userchrome:update',
    reload: 'userchrome:reload',
    open: 'userchrome:open',
    cssChanged: 'userchrome:css-changed',
  },
  adblock: {
    stats: 'adblock:stats',
    setLevel: 'adblock:set-level',
    setEnabled: 'adblock:set-enabled',
    setFilter: 'adblock:set-filter',
    setSiteAllowed: 'adblock:set-site-allowed',
    toggleSite: 'adblock:toggle-site',
    changed: 'adblock:changed',
  },
  downloads: {
    list: 'downloads:list',
    pause: 'downloads:pause',
    resume: 'downloads:resume',
    cancel: 'downloads:cancel',
    openFolder: 'downloads:open-folder',
    openFile: 'downloads:open-file',
    copyPath: 'downloads:copy-path',
    retry: 'downloads:retry',
    remove: 'downloads:remove',
    clearFinished: 'downloads:clear-finished',
    pickFolder: 'downloads:pick-folder',
    update: 'downloads:update',
  },
  torrent: {
    add: 'torrent:add',
    pause: 'torrent:pause',
    resume: 'torrent:resume',
    remove: 'torrent:remove',
    setFiles: 'torrent:set-files',
  },
  video: {
    candidates: 'video:candidates',
    candidatesChanged: 'video:candidates-changed',
    download: 'video:download',
    ytdlpStatus: 'video:ytdlp-status',
    ytdlpEnsure: 'video:ytdlp-ensure',
    ytdlpUpdate: 'video:ytdlp-update',
    downloadFromOverlay: 'video:download-from-overlay',
  },
  screenshot: {
    capture: 'screenshot:capture',
    saveToClipboard: 'screenshot:to-clipboard',
    saveToFile: 'screenshot:to-file',
  },
  search: {
    listEngines: 'search:list-engines',
    setDefault: 'search:set-default',
  },
  gesture: {
    exec: 'gesture:exec',
  },
  quickSearch: {
    open: 'quick-search:open',
  },
  reader: {
    toggle: 'reader:toggle',
  },
  find: {
    start: 'find:start',
    stop: 'find:stop',
    result: 'find:result',
    open: 'find:open',
    // F3/Shift+F3/Ctrl+G — 찾기 바가 열려 있으면 다음/이전 매치로, 닫혀 있으면 여는 것으로 처리.
    step: 'find:step',
  },
  page: {
    print: 'page:print',
    printToPdf: 'page:print-to-pdf',
    zoomGet: 'page:zoom-get',
    zoomSet: 'page:zoom-set',
    // Ctrl+휠·핀치 줌 또는 키보드 배율 변경 시 활성 탭의 새 배율을 외피에 알림(배지 표시용).
    zoomChanged: 'page:zoom-changed',
  },
  translate: {
    batch: 'translate:batch',
  },
  qrcode: {
    generate: 'qrcode:generate',
    open: 'qrcode:open',
  },
  userscript: {
    list: 'userscript:list',
    get: 'userscript:get',
    save: 'userscript:save',
    remove: 'userscript:remove',
    setEnabled: 'userscript:set-enabled',
    changed: 'userscript:changed',
  },
  policy: {
    list: 'policy:list',
    get: 'policy:get',
    save: 'policy:save',
    remove: 'policy:remove',
    setEnabled: 'policy:set-enabled',
    changed: 'policy:changed',
  },
  password: {
    list: 'password:list',
    lookup: 'password:lookup',
    reveal: 'password:reveal',
    proposeSave: 'password:propose-save',
    confirmSave: 'password:confirm-save',
    promptOpen: 'password:prompt-open',
    promptResolved: 'password:prompt-resolved',
    remove: 'password:remove',
    changed: 'password:changed',
    available: 'password:available',
    // 선등록(사용자가 설정에서 직접 추가/수정) — 신뢰된 내부 페이지만.
    add: 'password:add',
    update: 'password:update',
  },
  workspace: {
    list: 'workspace:list',
    state: 'workspace:state',
    activate: 'workspace:activate',
    create: 'workspace:create',
    update: 'workspace:update',
    remove: 'workspace:remove',
    reorder: 'workspace:reorder',
    changed: 'workspace:changed',
  },
  bookmarks: {
    list: 'bookmarks:list',
    add: 'bookmarks:add',
    remove: 'bookmarks:remove',
    rename: 'bookmarks:rename',
    update: 'bookmarks:update',
    move: 'bookmarks:move',
    isBookmarked: 'bookmarks:is-bookmarked',
    folderCreate: 'bookmarks:folder-create',
    folderRename: 'bookmarks:folder-rename',
    folderRemove: 'bookmarks:folder-remove',
    exportHtml: 'bookmarks:export-html',
    importHtml: 'bookmarks:import-html',
    changed: 'bookmarks:changed',
    // 별 버튼/Ctrl+D 로 북마크를 추가(또는 이미 있으면 그대로 두고) 직후 편집 말풍선을 띄우라는 신호.
    bubbleOpen: 'bookmarks:bubble-open',
  },
  history: {
    recent: 'history:recent',
    search: 'history:search',
    topSites: 'history:top-sites',
    remove: 'history:remove',
    clear: 'history:clear',
    changed: 'history:changed',
  },
  data: {
    export: 'data:export',
    import: 'data:import',
  },
  tokens: {
    get: 'tokens:get',
    set: 'tokens:set',
    reset: 'tokens:reset',
    changed: 'tokens:changed',
  },
  macro: {
    list: 'macro:list',
    get: 'macro:get',
    save: 'macro:save',
    remove: 'macro:remove',
    run: 'macro:run',
    changed: 'macro:changed',
  },
  mod: {
    list: 'mod:list',
    get: 'mod:get',
    setEnabled: 'mod:set-enabled',
    remove: 'mod:remove',
    changed: 'mod:changed',
    reload: 'mod:reload',
    menuList: 'mod:menu-list',
    menuInvoke: 'mod:menu-invoke',
  },
  system: {
    metrics: 'system:metrics',
    bootInfo: 'system:boot-info',
    sweepTabSleep: 'system:sweep-tab-sleep',
    wakeTab: 'system:wake-tab',
    licenses: 'system:licenses',
  },
  perf: {
    report: 'perf:report',
    milestone: 'perf:milestone',
  },
  update: {
    status: 'update:status',
    check: 'update:check',
    download: 'update:download',
    install: 'update:install',
    setChannel: 'update:set-channel',
    setAutoDownload: 'update:set-auto-download',
    setAutoCheck: 'update:set-auto-check',
  },
  extensions: {
    list: 'extensions:list',
    installFromCrx: 'extensions:install-from-crx',
    installFromUrl: 'extensions:install-from-url',
    remove: 'extensions:remove',
    setEnabled: 'extensions:set-enabled',
    openOptions: 'extensions:open-options',
    invokeAction: 'extensions:invoke-action',
    changed: 'extensions:changed',
    importLocal: 'extensions:import-local',
  },
  widgets: {
    weather: 'widgets:weather',
    news: 'widgets:news',
    fx: 'widgets:fx',
    dataGet: 'widgets:data-get',
    dataSet: 'widgets:data-set',
  },
  groups: {
    list: 'groups:list',
    create: 'groups:create',
    update: 'groups:update',
    remove: 'groups:remove',
    setCollapsed: 'groups:set-collapsed',
    assignTab: 'groups:assign-tab',
    changed: 'groups:changed',
  },
  permissions: {
    list: 'permissions:list',
    set: 'permissions:set',
    clearOrigin: 'permissions:clear-origin',
    clearAll: 'permissions:clear-all',
    changed: 'permissions:changed',
    // 사이트가 media/geolocation/notifications/clipboard-read 를 요청했는데 저장된 결정이
    // 없을 때 — 메인이 이 채널로 외피에 프롬프트를 띄우고, 외피는 promptRespond 로 답한다.
    promptOpen: 'permissions:prompt-open',
    promptRespond: 'permissions:prompt-respond',
  },
  readlater: {
    list: 'readlater:list',
    add: 'readlater:add',
    remove: 'readlater:remove',
    setRead: 'readlater:set-read',
    clearRead: 'readlater:clear-read',
    isSaved: 'readlater:is-saved',
    changed: 'readlater:changed',
    openPanel: 'readlater:open-panel',
  },
  sitedata: {
    summary: 'sitedata:summary',
    clear: 'sitedata:clear',
  },
  imports: {
    sources: 'imports:sources',
    run: 'imports:run',
  },
  onboarding: {
    setDefaultBrowser: 'onboarding:set-default-browser',
    complete: 'onboarding:complete',
  },
  ai: {
    config: 'ai:config',
    pageContext: 'ai:page-context',
    keyStatus: 'ai:key-status',
    setKey: 'ai:set-key',
    clearKey: 'ai:clear-key',
    pickAgentDir: 'ai:pick-agent-dir',
    agentFilesInfo: 'ai:agent-files-info',
    send: 'ai:send',
    cancel: 'ai:cancel',
    delta: 'ai:delta',
    done: 'ai:done',
    error: 'ai:error',
    open: 'ai:open',
    agentStart: 'ai:agent-start',
    agentEvent: 'ai:agent-event',
    agentConfirm: 'ai:agent-confirm',
    agentReply: 'ai:agent-reply',
    agentCancel: 'ai:agent-cancel',
    agentReset: 'ai:agent-reset',
    summarize: 'ai:summarize',
    diagnose: 'ai:diagnose',
    detectProviders: 'ai:detect-providers',
    connectProvider: 'ai:connect-provider',
    triggerList: 'ai:trigger-list',
    triggerAdd: 'ai:trigger-add',
    triggerUpdate: 'ai:trigger-update',
    triggerRemove: 'ai:trigger-remove',
    triggerSetEnabled: 'ai:trigger-set-enabled',
    triggerChanged: 'ai:trigger-changed',
    profileGet: 'ai:profile-get',
    profileSet: 'ai:profile-set',
    profileChanged: 'ai:profile-changed',
    exportWebhook: 'ai:export-webhook',
    blogGenerate: 'ai:blog-generate',
    blogBuildTask: 'ai:blog-build-task',
    snsBuildTask: 'ai:sns-build-task',
    reportBuildTask: 'ai:report-build-task',
    reportExport: 'ai:report-export',
    blogRefine: 'ai:blog-refine',
    blogSeriesPlan: 'ai:blog-series-plan',
    blogDraftList: 'ai:blog-draft-list',
    blogDraftGet: 'ai:blog-draft-get',
    blogDraftSave: 'ai:blog-draft-save',
    blogDraftRemove: 'ai:blog-draft-remove',
    blogDraftChanged: 'ai:blog-draft-changed',
    // 생성→캡션→게시 워크플로 (묶음 SOCIAL-1)
    socialList: 'ai:social-list',
    socialStart: 'ai:social-start',
    socialApprove: 'ai:social-approve',
    socialChoose: 'ai:social-choose',
    socialCancel: 'ai:social-cancel',
    socialDelete: 'ai:social-delete',
    socialChanged: 'ai:social-changed',
    socialGrant: 'ai:social-grant',
    socialGrantGet: 'ai:social-grant-get',
    socialGrantRevoke: 'ai:social-grant-revoke',
    // 중단 후 복구 (묶음 RECOVERY-1) — 캡션 재시도·직접 입력, 게시 여부 불확실 해소
    socialRetryCaption: 'ai:social-retry-caption',
    socialSetCaption: 'ai:social-set-caption',
    // 확인 단계에서 계정 고치기 — 계정을 빠뜨리거나 잘못 넣었을 때 워크플로를 다시 만들지 않아도 된다.
    socialSetAccount: 'ai:social-set-account',
    socialResolvePublish: 'ai:social-resolve-publish',
    // 초안 승격 — 만들어 둔 초안을 다시 만들지 않고 게시로 올린다. prepare 는 **확인 화면을 만들 뿐**
    // 아무것도 게시하지 않고 디스크에 쓰지도 않는다. 실제 게시는 confirm 한 경로에서만 시작된다.
    socialPromotePrepare: 'ai:social-promote-prepare',
    socialPromoteConfirm: 'ai:social-promote-confirm',
    socialPromoteCancel: 'ai:social-promote-cancel',
    // 작업 산출물(캡처한 이미지·받은 파일)
    artifactList: 'ai:artifact-list',
    artifactData: 'ai:artifact-data',
    // 관심 블로그 댓글·좋아요
    intentDetect: 'ai:intent-detect',

    engageBuildTask: 'ai:engage-build-task',
    engageLedger: 'ai:engage-ledger',
    engageLedgerClear: 'ai:engage-ledger-clear',
    collectorList: 'ai:collector-list',
    collectorAdd: 'ai:collector-add',
    collectorUpdate: 'ai:collector-update',
    collectorRemove: 'ai:collector-remove',
    collectorSetEnabled: 'ai:collector-set-enabled',
    collectorRun: 'ai:collector-run',
    collectorRuns: 'ai:collector-runs',
    collectorChanged: 'ai:collector-changed',
    collectorRan: 'ai:collector-ran',
    memoryGet: 'ai:memory-get',
    memorySet: 'ai:memory-set',
    memoryClear: 'ai:memory-clear',
    memoryChanged: 'ai:memory-changed',
    convList: 'ai:conv-list',
    convGet: 'ai:conv-get',
    convSave: 'ai:conv-save',
    convDelete: 'ai:conv-delete',
    convRename: 'ai:conv-rename',
    convClear: 'ai:conv-clear',
    convChanged: 'ai:conv-changed',
    convSetFolder: 'ai:conv-set-folder',
    convSetTags: 'ai:conv-set-tags',
    convSetPinned: 'ai:conv-set-pinned',
    convSearch: 'ai:conv-search',
    convExport: 'ai:conv-export',
    convExportBulk: 'ai:conv-export-bulk',
    folderList: 'ai:folder-list',
    folderCreate: 'ai:folder-create',
    folderRename: 'ai:folder-rename',
    folderDelete: 'ai:folder-delete',
    folderReorder: 'ai:folder-reorder',
    folderSetColor: 'ai:folder-set-color',
    folderSetEmoji: 'ai:folder-set-emoji',
    folderChanged: 'ai:folder-changed',
    taskList: 'ai:task-list',
    taskAdd: 'ai:task-add',
    taskRemove: 'ai:task-remove',
    taskRename: 'ai:task-rename',
    taskTouch: 'ai:task-touch',
    taskChanged: 'ai:task-changed',
    runList: 'ai:run-list',
    runGet: 'ai:run-get',
    runDelete: 'ai:run-delete',
    runClear: 'ai:run-clear',
    runChanged: 'ai:run-changed',
    repeatStart: 'ai:repeat-start',
    repeatStop: 'ai:repeat-stop',
    repeatRemove: 'ai:repeat-remove',
    repeatList: 'ai:repeat-list',
    repeatChanged: 'ai:repeat-changed',
    repeatEvent: 'ai:repeat-event',
    // ===== 영속 작업 런타임(구간 단위로 이어가는 장기 에이전트 작업) =====
    // 주의: `ai:task-*` 는 위의 taskList/taskAdd/... (에이전트 작업 매크로 · SavedAgentTask) 가
    // 이미 쓰고 있다. 같은 이름을 쓰면 object literal 키 충돌로 조용히 macro 기능이 덮이거나,
    // ipcMain.handle 이 같은 채널에 두 번째 핸들러를 등록해 부팅 시 throw 한다.
    // 그래서 새 런타임은 `ptask*`(persistent task) 접두로 분리한다 — 이름이 design.md 의
    // `ai.taskList` 등과 다르니 팀장이 UI 작업자에게 이 접두를 알려줘야 한다.
    ptaskList: 'ai:ptask-list',
    ptaskGet: 'ai:ptask-get',
    ptaskCreate: 'ai:ptask-create',
    ptaskStart: 'ai:ptask-start',
    ptaskPause: 'ai:ptask-pause',
    ptaskResume: 'ai:ptask-resume',
    ptaskCancel: 'ai:ptask-cancel',
    ptaskDelete: 'ai:ptask-delete',
    ptaskConfirm: 'ai:ptask-confirm',
    ptaskAnswer: 'ai:ptask-answer',
    ptaskAccept: 'ai:ptask-accept',
    // 대상 탭을 다시 찾지 못했을 때(waitCause 'tab-target') 사용자가 직접 고르는 경로.
    ptaskTargets: 'ai:ptask-targets',
    ptaskSetTarget: 'ai:ptask-set-target',
    ptaskChanged: 'ai:ptask-changed',
    ptaskEvent: 'ai:ptask-event',
    scheduleResume: 'ai:schedule-resume',
  },
} as const

export type IpcChannel =
  | typeof IPC.windows[keyof typeof IPC.windows]
  | typeof IPC.tabs[keyof typeof IPC.tabs]
  | typeof IPC.omnibox[keyof typeof IPC.omnibox]
  | typeof IPC.settings[keyof typeof IPC.settings]
  | typeof IPC.actions[keyof typeof IPC.actions]
  | typeof IPC.keymap[keyof typeof IPC.keymap]
  | typeof IPC.palette[keyof typeof IPC.palette]
  | typeof IPC.userchrome[keyof typeof IPC.userchrome]
  | typeof IPC.adblock[keyof typeof IPC.adblock]
  | typeof IPC.downloads[keyof typeof IPC.downloads]
  | typeof IPC.torrent[keyof typeof IPC.torrent]
  | typeof IPC.video[keyof typeof IPC.video]
  | typeof IPC.screenshot[keyof typeof IPC.screenshot]
  | typeof IPC.search[keyof typeof IPC.search]
  | typeof IPC.bookmarks[keyof typeof IPC.bookmarks]
  | typeof IPC.history[keyof typeof IPC.history]
  | typeof IPC.gesture[keyof typeof IPC.gesture]
  | typeof IPC.quickSearch[keyof typeof IPC.quickSearch]
  | typeof IPC.reader[keyof typeof IPC.reader]
  | typeof IPC.find[keyof typeof IPC.find]
  | typeof IPC.page[keyof typeof IPC.page]
  | typeof IPC.translate[keyof typeof IPC.translate]
  | typeof IPC.qrcode[keyof typeof IPC.qrcode]
  | typeof IPC.userscript[keyof typeof IPC.userscript]
  | typeof IPC.policy[keyof typeof IPC.policy]
  | typeof IPC.password[keyof typeof IPC.password]
  | typeof IPC.workspace[keyof typeof IPC.workspace]
  | typeof IPC.data[keyof typeof IPC.data]
  | typeof IPC.tokens[keyof typeof IPC.tokens]
  | typeof IPC.macro[keyof typeof IPC.macro]
  | typeof IPC.mod[keyof typeof IPC.mod]
  | typeof IPC.system[keyof typeof IPC.system]
  | typeof IPC.extensions[keyof typeof IPC.extensions]
  | typeof IPC.update[keyof typeof IPC.update]
  | typeof IPC.perf[keyof typeof IPC.perf]
  | typeof IPC.widgets[keyof typeof IPC.widgets]
  | typeof IPC.groups[keyof typeof IPC.groups]
  | typeof IPC.tabsearch[keyof typeof IPC.tabsearch]
  | typeof IPC.recentClosed[keyof typeof IPC.recentClosed]
  | typeof IPC.permissions[keyof typeof IPC.permissions]
  | typeof IPC.readlater[keyof typeof IPC.readlater]
  | typeof IPC.sitedata[keyof typeof IPC.sitedata]
  | typeof IPC.imports[keyof typeof IPC.imports]
  | typeof IPC.onboarding[keyof typeof IPC.onboarding]
  | typeof IPC.ai[keyof typeof IPC.ai]
