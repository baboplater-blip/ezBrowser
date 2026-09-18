import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type {
  ActionDescriptor, AdblockStats, AiConnectResult, AiProviderDetection, AiProviderKind, Bookmark, BookmarkFolder,
  BookmarkTree, DownloadItem, ExtensionSummary, HistoryEntry, KeyBinding,
  MacroSummary, MediaCandidate, OmniboxSuggestion, ReadLaterItem, SearchEngine, TabGroup, TabGroupColor, TabSummary, TopSite, UserChromeState,
  Workspace, WorkspaceState,
} from '../shared/types'

type Unsubscribe = () => void

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const fn = (_: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, fn)
  return () => { ipcRenderer.off(channel, fn) }
}

const api = {
  windows: {
    onReady: (cb: (info: { windowId: string }) => void) => on(IPC.windows.ready, cb),
    setChromeHeight: (windowId: string, height: number): Promise<void> =>
      ipcRenderer.invoke(IPC.windows.setChromeHeight, { windowId, height }),
    setShellInsets: (windowId: string, partial: { top?: number; right?: number; bottom?: number; left?: number }): Promise<void> =>
      ipcRenderer.invoke(IPC.windows.setShellInsets, { windowId, ...partial }),
    setPaneSplitRatio: (windowId: string, ratio: number): Promise<void> =>
      ipcRenderer.invoke(IPC.windows.setPaneSplitRatio, { windowId, ratio }),
    focusPane: (windowId: string, idx: number): Promise<void> =>
      ipcRenderer.invoke(IPC.windows.focusPane, { windowId, idx }),
    onLayoutChanged: (cb: (payload: {
      windowId: string
      split: 'h' | 'v' | null
      splitRatio: number
      activePaneIdx: number
      panes: Array<{ tabId: string | null }>
    }) => void) => on(IPC.windows.layoutChanged, cb),
    beginPaneDrag: (windowId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.windows.beginPaneDrag, { windowId }),
    endPaneDrag: (windowId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.windows.endPaneDrag, { windowId }),
  },
  tabs: {
    create: (windowId: string, url?: string, opts?: { background?: boolean }): Promise<TabSummary> =>
      ipcRenderer.invoke(IPC.tabs.create, { windowId, url, background: opts?.background }),
    list: (windowId: string): Promise<TabSummary[]> =>
      ipcRenderer.invoke(IPC.tabs.list, { windowId }),
    activate: (tabId: string): Promise<void> => ipcRenderer.invoke(IPC.tabs.activate, { tabId }),
    close: (tabId: string): Promise<void> => ipcRenderer.invoke(IPC.tabs.close, { tabId }),
    pin: (tabId: string, pinned: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.tabs.pin, { tabId, pinned }),
    duplicate: (tabId: string): Promise<TabSummary | null> =>
      ipcRenderer.invoke(IPC.tabs.duplicate, { tabId }),
    restore: (windowId: string): Promise<TabSummary | null> =>
      ipcRenderer.invoke(IPC.tabs.restore, { windowId }),
    reorder: (windowId: string, orderedIds: string[]): Promise<void> =>
      ipcRenderer.invoke(IPC.tabs.reorder, { windowId, orderedIds }),
    navigate: (tabId: string, url: string): Promise<void> =>
      ipcRenderer.invoke(IPC.tabs.navigate, { tabId, url }),
    back: (tabId: string): Promise<void> => ipcRenderer.invoke(IPC.tabs.back, { tabId }),
    forward: (tabId: string): Promise<void> => ipcRenderer.invoke(IPC.tabs.forward, { tabId }),
    reload: (tabId: string): Promise<void> => ipcRenderer.invoke(IPC.tabs.reload, { tabId }),
    stop: (tabId: string): Promise<void> => ipcRenderer.invoke(IPC.tabs.stop, { tabId }),
    setMuted: (tabId: string, muted: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.tabs.setMuted, { tabId, muted }),
    capture: (tabId: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.tabs.capture, { tabId }),
    onUpdate: (cb: (tab: TabSummary) => void) => on(IPC.tabs.update, cb),
    onListChanged: (cb: (payload: { windowId: string; tabs: TabSummary[] }) => void) =>
      on(IPC.tabs.listChanged, cb),
  },
  groups: {
    list: (windowId: string): Promise<TabGroup[]> =>
      ipcRenderer.invoke(IPC.groups.list, { windowId }),
    create: (windowId: string, opts?: { title?: string; color?: TabGroupColor; tabIds?: string[] }): Promise<TabGroup | null> =>
      ipcRenderer.invoke(IPC.groups.create, { windowId, ...opts }),
    update: (groupId: string, patch: { title?: string; color?: TabGroupColor }): Promise<void> =>
      ipcRenderer.invoke(IPC.groups.update, { groupId, ...patch }),
    remove: (groupId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.groups.remove, { groupId }),
    setCollapsed: (groupId: string, collapsed: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.groups.setCollapsed, { groupId, collapsed }),
    assignTab: (tabId: string, groupId: string | null): Promise<void> =>
      ipcRenderer.invoke(IPC.groups.assignTab, { tabId, groupId }),
    onChanged: (cb: (payload: { windowId: string; groups: TabGroup[] }) => void) =>
      on(IPC.groups.changed, cb),
  },
  omnibox: {
    suggest: (query: string, windowId: string): Promise<OmniboxSuggestion[]> =>
      ipcRenderer.invoke(IPC.omnibox.suggest, { query, windowId }),
    navigate: (windowId: string, tabId: string | undefined, input: string): Promise<void> =>
      ipcRenderer.invoke(IPC.omnibox.navigate, { windowId, tabId, input }),
    onFocus: (cb: () => void) => on('omnibox:focus', () => cb()),
  },
  search: {
    listEngines: (): Promise<SearchEngine[]> => ipcRenderer.invoke(IPC.search.listEngines),
  },
  actions: {
    list: (): Promise<Array<ActionDescriptor & { key?: string }>> =>
      ipcRenderer.invoke(IPC.actions.list),
    run: (id: string, ctx: { windowId?: string; tabId?: string }): Promise<boolean> =>
      ipcRenderer.invoke(IPC.actions.run, { id, ctx }),
  },
  keymap: {
    get: (): Promise<{ keymap: { version: number; bindings: KeyBinding[] }; conflicts: Array<{ key: string; when: string; actions: string[] }> }> =>
      ipcRenderer.invoke(IPC.keymap.get),
    set: (keymap: { version: number; bindings: KeyBinding[] }) =>
      ipcRenderer.invoke(IPC.keymap.set, { keymap }),
    reset: () => ipcRenderer.invoke(IPC.keymap.reset),
  },
  palette: {
    onOpen: (cb: () => void) => on('palette:open', () => cb()),
  },
  tabsearch: {
    onOpen: (cb: () => void) => on('tabsearch:open', () => cb()),
  },
  recentClosed: {
    list: (limit?: number): Promise<Array<{ id: number; url: string; title: string; closedAt: number }>> =>
      ipcRenderer.invoke(IPC.recentClosed.list, { limit }),
    reopen: (id: number, windowId: string): Promise<TabSummary | null> =>
      ipcRenderer.invoke(IPC.recentClosed.reopen, { id, windowId }),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.recentClosed.clear),
    onOpen: (cb: () => void) => on('recent-closed:open', () => cb()),
  },
  widgets: {
    dataGet: (key: string): Promise<unknown> => ipcRenderer.invoke(IPC.widgets.dataGet, { key }),
    dataSet: (key: string, value: unknown): Promise<void> =>
      ipcRenderer.invoke(IPC.widgets.dataSet, { key, value }),
  },
  permissions: {
    list: (): Promise<Array<{ origin: string; permissions: Record<string, 'allow' | 'deny'> }>> =>
      ipcRenderer.invoke(IPC.permissions.list),
    set: (origin: string, permission: string, decision: 'allow' | 'deny' | 'default'): Promise<void> =>
      ipcRenderer.invoke(IPC.permissions.set, { origin, permission, decision }),
    clearOrigin: (origin: string): Promise<void> =>
      ipcRenderer.invoke(IPC.permissions.clearOrigin, { origin }),
    onChanged: (cb: (list: Array<{ origin: string; permissions: Record<string, 'allow' | 'deny'> }>) => void) =>
      on(IPC.permissions.changed, cb),
  },
  sitedata: {
    summary: (origin: string): Promise<{ cookies: number; hasData: boolean }> =>
      ipcRenderer.invoke(IPC.sitedata.summary, { origin }),
    clear: (origin: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.sitedata.clear, { origin }),
  },
  readlater: {
    list: (): Promise<ReadLaterItem[]> => ipcRenderer.invoke(IPC.readlater.list),
    add: (args: { url: string; title?: string; favicon?: string }): Promise<ReadLaterItem | null> =>
      ipcRenderer.invoke(IPC.readlater.add, args),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.readlater.remove, { id }),
    setRead: (id: string, read: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.readlater.setRead, { id, read }),
    clearRead: (): Promise<void> => ipcRenderer.invoke(IPC.readlater.clearRead),
    isSaved: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC.readlater.isSaved, { url }),
    onChanged: (cb: (items: ReadLaterItem[]) => void) => on(IPC.readlater.changed, cb),
    onOpenPanel: (cb: () => void) => on('readlater:open-panel', () => cb()),
  },
  clearData: {
    onOpen: (cb: () => void) => on('cleardata:open', () => cb()),
  },
  settings: {
    all: () => ipcRenderer.invoke(IPC.settings.all),
    get: (key: string) => ipcRenderer.invoke(IPC.settings.get, { key }),
    set: (key: string, value: unknown) => ipcRenderer.invoke(IPC.settings.set, { key, value }),
    onChange: (cb: (settings: unknown) => void) => on(IPC.settings.changed, cb),
  },
  userchrome: {
    get: (): Promise<UserChromeState> => ipcRenderer.invoke(IPC.userchrome.get),
    update: (kind: 'css' | 'js', content: string): Promise<void> =>
      ipcRenderer.invoke(IPC.userchrome.update, { kind, content }),
    reload: () => ipcRenderer.invoke(IPC.userchrome.reload),
    open: (kind: 'css' | 'js') => ipcRenderer.invoke(IPC.userchrome.open, { kind }),
    onChanged: (cb: (payload: { cssEnabled: boolean; jsEnabled: boolean; css: string; js: string; lastError?: string }) => void) =>
      on(IPC.userchrome.cssChanged, cb),
  },
  downloads: {
    list: (): Promise<DownloadItem[]> => ipcRenderer.invoke(IPC.downloads.list),
    pause: (id: string) => ipcRenderer.invoke(IPC.downloads.pause, { id }),
    resume: (id: string) => ipcRenderer.invoke(IPC.downloads.resume, { id }),
    cancel: (id: string) => ipcRenderer.invoke(IPC.downloads.cancel, { id }),
    openFolder: (id?: string) => ipcRenderer.invoke(IPC.downloads.openFolder, { id }),
    openFile: (id: string) => ipcRenderer.invoke(IPC.downloads.openFile, { id }),
    copyPath: (id: string): Promise<string> => ipcRenderer.invoke(IPC.downloads.copyPath, { id }),
    retry: (id: string) => ipcRenderer.invoke(IPC.downloads.retry, { id }),
    remove: (id: string) => ipcRenderer.invoke(IPC.downloads.remove, { id }),
    clearFinished: (): Promise<number> => ipcRenderer.invoke(IPC.downloads.clearFinished),
    onUpdate: (cb: (list: DownloadItem[]) => void) => on(IPC.downloads.update, cb),
  },
  adblock: {
    stats: (): Promise<AdblockStats> => ipcRenderer.invoke(IPC.adblock.stats),
    setLevel: (level: 'lite' | 'standard' | 'strict' | 'custom') =>
      ipcRenderer.invoke(IPC.adblock.setLevel, { level }),
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(IPC.adblock.setEnabled, { enabled }),
    setFilter: (id: 'easylist' | 'easyprivacy' | 'kr' | 'fanboyAnnoyance' | 'fanboySocial', enabled: boolean) =>
      ipcRenderer.invoke(IPC.adblock.setFilter, { id, enabled }),
    setSiteAllowed: (host: string, allowed: boolean) =>
      ipcRenderer.invoke(IPC.adblock.setSiteAllowed, { host, allowed }),
    toggleSite: (url: string): Promise<{ host: string | null; allowed: boolean }> =>
      ipcRenderer.invoke(IPC.adblock.toggleSite, { url }),
    onChanged: (cb: (stats: AdblockStats) => void) => on(IPC.adblock.changed, cb),
  },
  screenshot: {
    captureViewport: (tabId: string) =>
      ipcRenderer.invoke(IPC.screenshot.capture, { tabId, mode: 'viewport' }),
    captureArea: (tabId: string, rect: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke(IPC.screenshot.capture, { tabId, mode: 'area', rect }),
    saveDataUrl: (dataUrl: string) =>
      ipcRenderer.invoke(IPC.screenshot.saveToFile, { dataUrl }),
  },
  find: {
    start: (tabId: string, text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): Promise<number> =>
      ipcRenderer.invoke(IPC.find.start, { tabId, text, options }),
    stop: (tabId: string, keepSelection?: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.find.stop, { tabId, keepSelection }),
    onResult: (cb: (payload: { tabId: string; requestId: number; activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void) =>
      on(IPC.find.result, cb),
    onOpen: (cb: (payload: { initialText?: string }) => void) => on(IPC.find.open, cb),
  },
  page: {
    print: (tabId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.page.print, { tabId }),
    printToPdf: (tabId: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke(IPC.page.printToPdf, { tabId }),
    zoomGet: (tabId: string): Promise<{ level: number; factor: number } | null> =>
      ipcRenderer.invoke(IPC.page.zoomGet, { tabId }),
    zoomSet: (tabId: string, delta: -1 | 0 | 1): Promise<{ level: number; factor: number } | null> =>
      ipcRenderer.invoke(IPC.page.zoomSet, { tabId, delta }),
  },
  torrent: {
    add: (uri: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.torrent.add, { uri }),
    pause: (id: string) => ipcRenderer.invoke(IPC.torrent.pause, { id }),
    resume: (id: string) => ipcRenderer.invoke(IPC.torrent.resume, { id }),
    remove: (id: string, deleteFiles?: boolean) =>
      ipcRenderer.invoke(IPC.torrent.remove, { id, deleteFiles }),
    setFiles: (id: string, indices: number[]) =>
      ipcRenderer.invoke(IPC.torrent.setFiles, { id, indices }),
  },
  video: {
    candidates: (tabId: string): Promise<MediaCandidate[]> =>
      ipcRenderer.invoke(IPC.video.candidates, { tabId }),
    download: (candidate: MediaCandidate): Promise<{ ok: boolean; kind: 'direct' | 'ytdlp'; id?: string | null }> =>
      ipcRenderer.invoke(IPC.video.download, { candidate }),
    ytdlpStatus: (): Promise<{ installed: boolean }> =>
      ipcRenderer.invoke(IPC.video.ytdlpStatus),
    ytdlpEnsure: (): Promise<{ ok: boolean; path: string | null }> =>
      ipcRenderer.invoke(IPC.video.ytdlpEnsure),
    ytdlpUpdate: (): Promise<{ ok: boolean; result: 'updated' | 'up-to-date' | 'skipped' | 'failed' }> =>
      ipcRenderer.invoke(IPC.video.ytdlpUpdate),
    onCandidates: (cb: (payload: { tabId: string; candidates: MediaCandidate[] }) => void) =>
      on(IPC.video.candidatesChanged, cb),
  },
  bookmarks: {
    list: (): Promise<BookmarkTree> => ipcRenderer.invoke(IPC.bookmarks.list),
    add: (args: { url: string; title: string; folderId?: number | null }): Promise<Bookmark> =>
      ipcRenderer.invoke(IPC.bookmarks.add, args),
    remove: (id: number): Promise<void> => ipcRenderer.invoke(IPC.bookmarks.remove, { id }),
    rename: (id: number, title: string): Promise<void> =>
      ipcRenderer.invoke(IPC.bookmarks.rename, { id, title }),
    move: (id: number, folderId: number | null, position: number): Promise<void> =>
      ipcRenderer.invoke(IPC.bookmarks.move, { id, folderId, position }),
    isBookmarked: (url: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.bookmarks.isBookmarked, { url }),
    folderCreate: (name: string, parentId?: number | null): Promise<BookmarkFolder> =>
      ipcRenderer.invoke(IPC.bookmarks.folderCreate, { name, parentId }),
    folderRemove: (id: number): Promise<void> =>
      ipcRenderer.invoke(IPC.bookmarks.folderRemove, { id }),
    onChanged: (cb: (tree: BookmarkTree) => void) => on(IPC.bookmarks.changed, cb),
  },
  history: {
    recent: (limit?: number): Promise<HistoryEntry[]> =>
      ipcRenderer.invoke(IPC.history.recent, { limit }),
    search: (query: string, limit?: number): Promise<HistoryEntry[]> =>
      ipcRenderer.invoke(IPC.history.search, { query, limit }),
    topSites: (limit?: number): Promise<TopSite[]> =>
      ipcRenderer.invoke(IPC.history.topSites, { limit }),
    remove: (args: { id?: number; url?: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.history.remove, args),
    clear: (args?: { sinceMs?: number }): Promise<void> =>
      ipcRenderer.invoke(IPC.history.clear, args ?? {}),
    onChanged: (cb: () => void) => on(IPC.history.changed, () => cb()),
  },
  toast: {
    onShow: (cb: (payload: { message: string; ts: number }) => void) =>
      on('toast:show', cb),
  },
  panel: {
    onOpen: (cb: (payload: { panel: 'downloads' | 'userchrome' | 'bookmarks' | 'history' }) => void) =>
      on('panel:open', cb),
  },
  bookmarkBar: {
    onToggle: (cb: () => void) => on('bookmark-bar:toggle', () => cb()),
  },
  sidepanel: {
    onToggle: (cb: (payload: { side: 'left' | 'right' }) => void) =>
      on('sidepanel:toggle', cb),
  },
  tabbar: {
    onCycleOrientation: (cb: () => void) => on('tabbar:cycle-orientation', () => cb()),
  },
  qrcode: {
    generate: (text: string, size?: number): Promise<string | null> =>
      ipcRenderer.invoke(IPC.qrcode.generate, { text, size }),
    onOpen: (cb: (payload: { url: string }) => void) =>
      on('qrcode:open', cb),
  },
  password: {
    onPromptOpen: (cb: (p: { promptId: string; origin: string; username: string; isUpdate: boolean }) => void) =>
      on(IPC.password.promptOpen, cb),
    onPromptResolved: (cb: (p: { promptId: string }) => void) =>
      on(IPC.password.promptResolved, cb),
    confirmSave: (promptId: string, action: 'save' | 'discard' | 'never'): Promise<{ status: string }> =>
      ipcRenderer.invoke(IPC.password.confirmSave, { promptId, action }),
  },
  workspace: {
    list: (): Promise<Workspace[]> => ipcRenderer.invoke(IPC.workspace.list),
    state: (): Promise<WorkspaceState> => ipcRenderer.invoke(IPC.workspace.state),
    activate: (id: string): Promise<string> =>
      ipcRenderer.invoke(IPC.workspace.activate, { id }),
    create: (args?: Partial<Workspace>): Promise<Workspace> =>
      ipcRenderer.invoke(IPC.workspace.create, args ?? {}),
    update: (id: string, patch: Partial<Workspace>): Promise<Workspace | null> =>
      ipcRenderer.invoke(IPC.workspace.update, { id, patch }),
    remove: (id: string): Promise<{ removed: boolean; newActiveId: string }> =>
      ipcRenderer.invoke(IPC.workspace.remove, { id }),
    reorder: (orderedIds: string[]): Promise<void> =>
      ipcRenderer.invoke(IPC.workspace.reorder, { orderedIds }),
    onChanged: (cb: (state: WorkspaceState) => void) =>
      on(IPC.workspace.changed, cb),
  },
  tokens: {
    onChanged: (cb: (payload: { overrides: Record<string, string>; cssVars: Record<string, string> }) => void) =>
      on(IPC.tokens.changed, cb),
  },
  update: {
    status: (): Promise<{
      state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'disabled'
      current: string
      available?: string
      releaseNotes?: string
      progress?: number
      error?: string
      lastCheckedAt?: number
    }> => ipcRenderer.invoke(IPC.update.status),
    check: (): Promise<unknown> => ipcRenderer.invoke(IPC.update.check),
    download: (): Promise<unknown> => ipcRenderer.invoke(IPC.update.download),
    install: (): Promise<void> => ipcRenderer.invoke(IPC.update.install),
    setChannel: (channel: 'latest' | 'beta' | 'nightly'): Promise<void> =>
      ipcRenderer.invoke(IPC.update.setChannel, { channel }),
    setAutoDownload: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.update.setAutoDownload, { enabled }),
    setAutoCheck: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.update.setAutoCheck, { enabled }),
    onStatus: (cb: (status: {
      state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'disabled'
      current: string
      available?: string
      releaseNotes?: string
      progress?: number
      error?: string
      lastCheckedAt?: number
    }) => void) => on(IPC.update.status, cb),
  },
  mod: {
    menuList: (): Promise<Array<{ id: string; modId: string; modName: string; label: string }>> =>
      ipcRenderer.invoke(IPC.mod.menuList),
    menuInvoke: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.mod.menuInvoke, { id }),
    onChanged: (cb: () => void) => on(IPC.mod.changed, () => cb()),
  },
  macro: {
    list: (): Promise<MacroSummary[]> => ipcRenderer.invoke(IPC.macro.list),
    run: (id: string, windowId?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.macro.run, { id, windowId }),
    onChanged: (cb: (list: MacroSummary[]) => void) => on(IPC.macro.changed, cb),
  },
  extensions: {
    list: (): Promise<ExtensionSummary[]> => ipcRenderer.invoke(IPC.extensions.list),
    installFromCrx: (filePath?: string): Promise<{ ok: boolean; id?: string; error?: string }> =>
      ipcRenderer.invoke(IPC.extensions.installFromCrx, { path: filePath }),
    installFromUrl: (url: string): Promise<{ ok: boolean; id?: string; error?: string }> =>
      ipcRenderer.invoke(IPC.extensions.installFromUrl, { url }),
    remove: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.extensions.remove, { id }),
    setEnabled: (id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.extensions.setEnabled, { id, enabled }),
    openOptions: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.extensions.openOptions, { id }),
    invokeAction: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.extensions.invokeAction, { id }),
    onChanged: (cb: (list: ExtensionSummary[]) => void) => on(IPC.extensions.changed, cb),
  },
  ai: {
    config: (): Promise<{
      enabled: boolean
      provider: AiProviderKind
      providerLabel: string
      model: string
      hasKey: boolean
      storageAvailable: boolean
    } | null> => ipcRenderer.invoke(IPC.ai.config),
    /** 이 컴퓨터에서 지금 쓸 수 있는 제공자 — 요금 드는 호출은 하지 않는다. */
    detectProviders: (force?: boolean): Promise<AiProviderDetection | null> =>
      ipcRenderer.invoke(IPC.ai.detectProviders, { force: !!force }),
    /** 제공자를 고르고 실제로 한 번 물어봐 확인 — 실패하면 원인·해결책이 함께 온다. */
    connectProvider: (provider: AiProviderKind, model?: string): Promise<AiConnectResult> =>
      ipcRenderer.invoke(IPC.ai.connectProvider, { provider, model }),
    pageContext: (tabId?: string): Promise<{ url: string; title: string; hasSelection: boolean } | null> =>
      ipcRenderer.invoke(IPC.ai.pageContext, { tabId }),
    send: (args: {
      reqId: string
      tabId?: string
      includePage?: boolean
      messages: Array<{ role: 'user' | 'assistant'; content: string }>
      summary?: string
    }): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.ai.send, args),
    cancel: (reqId: string): Promise<void> => ipcRenderer.invoke(IPC.ai.cancel, { reqId }),
    summarize: (messages: Array<{ role: 'user' | 'assistant'; content: string }>, prevSummary?: string): Promise<{ ok: boolean; summary: string }> =>
      ipcRenderer.invoke(IPC.ai.summarize, { messages, prevSummary }),
    onDelta: (cb: (p: { reqId: string; text: string }) => void) => on(IPC.ai.delta, cb),
    onDone: (cb: (p: { reqId: string; text: string }) => void) => on(IPC.ai.done, cb),
    onError: (cb: (p: { reqId: string; message: string }) => void) => on(IPC.ai.error, cb),
    onOpen: (cb: (p: { tabId?: string }) => void) => on('ai:open', cb),
    onSummarize: (cb: (p: { tabId?: string }) => void) => on('ai:summarize', cb),
    onWrite: (cb: (p: { tabId?: string }) => void) => on('ai:write', cb),
    agentStart: (args: { reqId: string; tabId?: string; task: string; rows?: Array<Record<string, string>>; autoConfirm?: boolean; readOnly?: boolean; allowedHosts?: string[] }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.ai.agentStart, args),
    exportWebhook: (rows: unknown[], url?: string): Promise<{ ok: boolean; detail: string }> =>
      ipcRenderer.invoke(IPC.ai.exportWebhook, { rows, url }),
    blogGenerate: (params: {
      topic: string; tone?: string; length?: 'short' | 'medium' | 'long'
      keywords?: string; category?: string; audience?: string; platform?: string; extra?: string
      series?: { seriesTitle: string; part: number; totalParts: number; partTitle?: string; otherTitles?: string[] }
    }): Promise<{ ok: boolean; error?: string; draft?: { titles: string[]; tags: string[]; summary: string; bodyMarkdown: string } }> =>
      ipcRenderer.invoke(IPC.ai.blogGenerate, params),
    blogSeriesPlan: (params: { topic: string; parts: number; tone?: string; platform?: string; keywords?: string; audience?: string }): Promise<{ ok: boolean; error?: string; plan?: { seriesTitle: string; parts: Array<{ title: string; angle: string }> } }> =>
      ipcRenderer.invoke(IPC.ai.blogSeriesPlan, params),
    blogRefine: (params: { body: string; instruction: string; title?: string; tone?: string; platform?: string }): Promise<{ ok: boolean; error?: string; body?: string }> =>
      ipcRenderer.invoke(IPC.ai.blogRefine, params),
    blogBuildTask: (params: { platform?: string; mode: 'insert' | 'draft' | 'publish'; title: string; body: string; tags?: string[]; autoOpen?: boolean }): Promise<{ task: string; naverWriteUrl: string }> =>
      ipcRenderer.invoke(IPC.ai.blogBuildTask, params),
    snsBuildTask: (params: { platform: 'instagram' | 'youtube' | 'tiktok'; mode: 'publish' | 'draft'; file: string; caption: string; title?: string; tags?: string[]; autoOpen?: boolean }): Promise<{ task: string; openUrl: string }> =>
      ipcRenderer.invoke(IPC.ai.snsBuildTask, params),
    // ===== 생성물 파이프라인 · 생성→게시 워크플로 · 블로그 참여 (묶음 SOCIAL-1) =====
    artifactList: (taskId: string): Promise<AiArtifactMeta[]> =>
      ipcRenderer.invoke(IPC.ai.artifactList, { taskId }),
    artifactData: (taskId: string, id: string): Promise<{ meta: AiArtifactMeta; dataUrl: string | null } | null> =>
      ipcRenderer.invoke(IPC.ai.artifactData, { taskId, id }),
    socialList: (): Promise<AiSocialWorkflow[]> => ipcRenderer.invoke(IPC.ai.socialList),
    socialStart: (params: AiSocialStartParams): Promise<AiSocialWorkflow | null> =>
      ipcRenderer.invoke(IPC.ai.socialStart, params),
    socialApprove: (id: string, caption: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.ai.socialApprove, { id, caption }),
    socialChoose: (id: string, artifactId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.ai.socialChoose, { id, artifactId }),
    // 이번 작업 한정 자동 게시 선승인(사용자가 시작할 때 명시 선택). 범위 밖은 자동 게시되지 않는다.
    socialGrant: (input: AiAutoPublishGrantInput): Promise<AiAutoPublishGrant | null> =>
      ipcRenderer.invoke(IPC.ai.socialGrant, input),
    socialGrantGet: (): Promise<AiAutoPublishGrant | null> => ipcRenderer.invoke(IPC.ai.socialGrantGet),
    socialGrantRevoke: (): Promise<void> => ipcRenderer.invoke(IPC.ai.socialGrantRevoke),
    socialCancel: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ai.socialCancel, { id }),
    socialDelete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ai.socialDelete, { id }),
    onSocialChanged: (cb: (list: AiSocialWorkflow[]) => void) => on(IPC.ai.socialChanged, cb),
    engageBuildTask: (params: AiEngageParams): Promise<{ task: string; openUrl: string; allowedHosts: string[] }> =>
      ipcRenderer.invoke(IPC.ai.engageBuildTask, params),
    engageLedger: (limit?: number): Promise<AiEngageLedgerEntry[]> =>
      ipcRenderer.invoke(IPC.ai.engageLedger, { limit }),
    engageLedgerClear: (): Promise<void> => ipcRenderer.invoke(IPC.ai.engageLedgerClear),
    reportBuildTask: (params: { url?: string; focus?: string; depth?: number }): Promise<{ task: string; readOnly: boolean }> =>
      ipcRenderer.invoke(IPC.ai.reportBuildTask, params),
    reportExport: (p: { title: string; markdown: string }): Promise<{ ok: boolean; path?: string }> =>
      ipcRenderer.invoke(IPC.ai.reportExport, p),
    blogDraftList: (): Promise<Array<{ id: string; title: string; topic: string; seriesId?: string; seriesTitle?: string; part?: number; updatedAt: number }>> =>
      ipcRenderer.invoke(IPC.ai.blogDraftList),
    blogDraftGet: (id: string): Promise<{ id: string; topic: string; title: string; bodyMarkdown: string; tags: string[]; summary: string; options?: { tone?: string; length?: string; platform?: string; keywords?: string }; seriesId?: string; seriesTitle?: string; part?: number } | null> =>
      ipcRenderer.invoke(IPC.ai.blogDraftGet, { id }),
    blogDraftSave: (payload: { id?: string; topic?: string; title?: string; bodyMarkdown?: string; tags?: string[]; summary?: string; options?: { tone?: string; length?: string; platform?: string; keywords?: string }; seriesId?: string; seriesTitle?: string; part?: number }): Promise<{ id: string; title: string } | null> =>
      ipcRenderer.invoke(IPC.ai.blogDraftSave, payload),
    blogDraftRemove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ai.blogDraftRemove, { id }),
    onBlogDraftChanged: (cb: (list: Array<{ id: string; title: string; topic: string; seriesId?: string; seriesTitle?: string; part?: number; updatedAt: number }>) => void) => on(IPC.ai.blogDraftChanged, cb),
    // 매일 자동 수집 — 사이드바 브리핑 탭용(읽기 + 지금 수집)
    collectorList: (): Promise<Array<{ id: string; name: string; enabled: boolean; sources: string[]; scheduleType: string; time?: string; intervalMinutes?: number; keyword?: string; lastRunAt?: number; lastCount?: number; lastDigest?: string; seenCount: number }>> =>
      ipcRenderer.invoke(IPC.ai.collectorList),
    collectorRuns: (id: string): Promise<Array<{ id: string; collectorId: string; collectorName: string; at: number; newCount: number; items: Array<Record<string, string>>; digest?: string }>> =>
      ipcRenderer.invoke(IPC.ai.collectorRuns, { id }),
    collectorRun: (id: string): Promise<{ ok: boolean; run?: { id: string; newCount: number; items: Array<Record<string, string>>; digest?: string } }> =>
      ipcRenderer.invoke(IPC.ai.collectorRun, { id }),
    onCollectorChanged: (cb: (list: unknown[]) => void) => on(IPC.ai.collectorChanged, cb),
    onCollectorRan: (cb: (run: unknown) => void) => on(IPC.ai.collectorRan, cb),
    agentConfirm: (reqId: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.ai.agentConfirm, { reqId, approved }),
    agentReply: (reqId: string, answer: string): Promise<void> =>
      ipcRenderer.invoke(IPC.ai.agentReply, { reqId, answer }),
    agentCancel: (reqId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.ai.agentCancel, { reqId }),
    agentReset: (windowId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.ai.agentReset, { windowId }),
    onAgentEvent: (cb: (p: { reqId: string; type: string; [k: string]: unknown }) => void) =>
      on(IPC.ai.agentEvent, cb),
    convList: (): Promise<Array<{ id: string; title: string; updatedAt: number; messageCount: number; folderId: string | null; tags: string[]; pinned: boolean }>> =>
      ipcRenderer.invoke(IPC.ai.convList),
    convGet: (id: string): Promise<{ id: string; title: string; updatedAt: number; messages: Array<{ role: 'user' | 'assistant'; content: string }>; summary?: string; foldCount?: number } | null> =>
      ipcRenderer.invoke(IPC.ai.convGet, { id }),
    convSave: (args: { id: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; summary?: string; foldCount?: number }): Promise<{ id: string; title: string } | null> =>
      ipcRenderer.invoke(IPC.ai.convSave, args),
    convDelete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ai.convDelete, { id }),
    convRename: (id: string, title: string): Promise<void> =>
      ipcRenderer.invoke(IPC.ai.convRename, { id, title }),
    convClear: (): Promise<void> => ipcRenderer.invoke(IPC.ai.convClear),
    onConvChanged: (cb: (list: Array<{ id: string; title: string; updatedAt: number; messageCount: number; folderId: string | null; tags: string[]; pinned: boolean }>) => void) =>
      on(IPC.ai.convChanged, cb),
    convSetFolder: (id: string, folderId: string | null): Promise<void> =>
      ipcRenderer.invoke(IPC.ai.convSetFolder, { id, folderId }),
    convSetTags: (id: string, tags: string[]): Promise<void> =>
      ipcRenderer.invoke(IPC.ai.convSetTags, { id, tags }),
    convSetPinned: (id: string, pinned: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.ai.convSetPinned, { id, pinned }),
    convSearch: (query: string): Promise<Array<{ id: string; snippet: string | null }>> =>
      ipcRenderer.invoke(IPC.ai.convSearch, { query }),
    convExport: (id: string): Promise<{ ok: boolean; path?: string }> =>
      ipcRenderer.invoke(IPC.ai.convExport, { id }),
    convExportBulk: (ids: string[]): Promise<{ ok: boolean; path?: string; count: number }> =>
      ipcRenderer.invoke(IPC.ai.convExportBulk, { ids }),
    folderList: (): Promise<Array<{ id: string; name: string; createdAt: number; color: string; emoji?: string }>> =>
      ipcRenderer.invoke(IPC.ai.folderList),
    folderCreate: (name: string): Promise<{ id: string; name: string; createdAt: number; color: string; emoji?: string } | null> =>
      ipcRenderer.invoke(IPC.ai.folderCreate, { name }),
    folderRename: (id: string, name: string): Promise<void> =>
      ipcRenderer.invoke(IPC.ai.folderRename, { id, name }),
    folderDelete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ai.folderDelete, { id }),
    folderReorder: (orderedIds: string[]): Promise<void> =>
      ipcRenderer.invoke(IPC.ai.folderReorder, { orderedIds }),
    folderSetColor: (id: string, color: string): Promise<void> =>
      ipcRenderer.invoke(IPC.ai.folderSetColor, { id, color }),
    folderSetEmoji: (id: string, emoji: string): Promise<void> =>
      ipcRenderer.invoke(IPC.ai.folderSetEmoji, { id, emoji }),
    onFolderChanged: (cb: (list: Array<{ id: string; name: string; createdAt: number; color: string; emoji?: string }>) => void) =>
      on(IPC.ai.folderChanged, cb),
    taskList: (): Promise<Array<{ id: string; name: string; task: string; createdAt: number; lastRunAt?: number }>> =>
      ipcRenderer.invoke(IPC.ai.taskList),
    taskAdd: (task: string, name?: string): Promise<{ id: string; name: string; task: string; createdAt: number } | null> =>
      ipcRenderer.invoke(IPC.ai.taskAdd, { task, name }),
    taskRemove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ai.taskRemove, { id }),
    taskRename: (id: string, name: string): Promise<void> => ipcRenderer.invoke(IPC.ai.taskRename, { id, name }),
    taskTouch: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ai.taskTouch, { id }),
    onTaskChanged: (cb: (list: Array<{ id: string; name: string; task: string; createdAt: number; lastRunAt?: number }>) => void) =>
      on(IPC.ai.taskChanged, cb),
    runList: (): Promise<Array<{ id: string; task: string; startedAt: number; endedAt?: number; status: 'running' | 'done' | 'error' | 'cancelled'; stepCount: number }>> =>
      ipcRenderer.invoke(IPC.ai.runList),
    runGet: (id: string): Promise<{ id: string; task: string; startedAt: number; endedAt?: number; status: 'running' | 'done' | 'error' | 'cancelled'; steps: Array<{ icon: string; text: string; tone?: 'ok' | 'warn' | 'muted' }>; result?: string } | null> =>
      ipcRenderer.invoke(IPC.ai.runGet, { id }),
    runDelete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ai.runDelete, { id }),
    runClear: (): Promise<void> => ipcRenderer.invoke(IPC.ai.runClear),
    onRunChanged: (cb: (list: Array<{ id: string; task: string; startedAt: number; endedAt?: number; status: 'running' | 'done' | 'error' | 'cancelled'; stepCount: number }>) => void) =>
      on(IPC.ai.runChanged, cb),
    // 자동 반복
    repeatStart: (args: { task: string; windowId: string; tabId: string; intervalMinutes: number; count: number; autoConfirm?: boolean }): Promise<{ ok: boolean; job?: RepeatSummary }> =>
      ipcRenderer.invoke(IPC.ai.repeatStart, args),
    repeatStop: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ai.repeatStop, { id }),
    repeatRemove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ai.repeatRemove, { id }),
    repeatList: (): Promise<RepeatSummary[]> => ipcRenderer.invoke(IPC.ai.repeatList),
    onRepeatChanged: (cb: (list: RepeatSummary[]) => void) => on(IPC.ai.repeatChanged, cb),
    onRepeatEvent: (cb: (evt: { scheduleId: string; reqId: string; run: number; type: string; [k: string]: unknown }) => void) => on(IPC.ai.repeatEvent, cb),
    // ===== 영속 작업 런타임(구간 단위로 이어가는 장기 에이전트 작업) =====
    // 채널이 ptask* 인 이유: ai:task-* 는 위의 taskList/taskAdd/...(에이전트 작업 매크로 —
    // SavedAgentTask)가 이미 쓰고 있다. 같은 이름을 쓰면 부팅 시 ipcMain.handle 이 같은 채널에
    // 두 번째 핸들러를 등록하려다 throw 하거나, 이 객체 리터럴 안에서 뒤에 쓴 메서드가 앞의
    // taskList/taskAdd 를 조용히 덮어써 macro 기능이 먹통이 된다 — 그래서 이름을 분리했다.
    ptaskList: (): Promise<PersistentTaskSummary[]> => ipcRenderer.invoke(IPC.ai.ptaskList),
    ptaskGet: (id: string): Promise<PersistentTask | null> => ipcRenderer.invoke(IPC.ai.ptaskGet, { id }),
    ptaskCreate: (args: {
      instruction: string
      tabId: string
      mode?: 'normal' | 'long'
      readOnly?: boolean
      budget?: Partial<PersistentTaskBudget>
    }): Promise<PersistentTaskSummary | null> => ipcRenderer.invoke(IPC.ai.ptaskCreate, args),
    // 시작/일시정지/재개/취소/삭제/승인은 소유 창이 아니면 메인이 거부한다(ok:false + 이유) —
    // 실패해도 throw 하지 않으니 UI 는 항상 ok 를 확인해야 한다.
    ptaskStart: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.ai.ptaskStart, { id }),
    ptaskPause: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.ai.ptaskPause, { id }),
    ptaskResume: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.ai.ptaskResume, { id }),
    ptaskCancel: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.ai.ptaskCancel, { id }),
    ptaskDelete: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.ai.ptaskDelete, { id }),
    ptaskAccept: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.ai.ptaskAccept, { id }),
    ptaskConfirm: (id: string, approved: boolean): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.ai.ptaskConfirm, { id, approved }),
    ptaskAnswer: (id: string, answer: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.ai.ptaskAnswer, { id, answer }),
    onPtaskChanged: (cb: (list: PersistentTaskSummary[]) => void) => on(IPC.ai.ptaskChanged, cb),
    onPtaskEvent: (cb: (evt: { taskId: string; type: string; [k: string]: unknown }) => void) =>
      on(IPC.ai.ptaskEvent, cb),
    // 반복 예약(에이전트 자동 반복) 재개 — 이미 돌던 작업을 이어서 재개.
    scheduleResume: (id: string): Promise<RepeatSummary | null> =>
      ipcRenderer.invoke(IPC.ai.scheduleResume, { id }),
  },
}

interface RepeatSummary {
  id: string; task: string; intervalMs: number; totalCount: number; doneCount: number
  autoConfirm: boolean; status: 'running' | 'waiting' | 'stopped' | 'finished'; nextAt: number | null; lastResult?: string
}

// task-runtime.ts(메인 전용 모듈)의 타입을 그대로 가져다 쓰지 않는다 — preload 의 tsconfig 는
// app/main 을 include 하지 않으므로(별도 컴파일 대상) 여기서 같은 모양을 복제해 둔다.
// 필드는 design.md §1 의 PersistentTask/TaskSummary/TaskBudget 확정 인터페이스와 동일해야 한다.
type PersistentTaskState =
  | 'queued' | 'running' | 'paused' | 'waiting-user' | 'retrying' | 'interrupted'
  | 'needs-verify' | 'completed' | 'failed' | 'cancelled'

interface PersistentTaskBudget {
  maxSteps: number
  maxDurationMs: number
  maxLlmCalls: number
  allowedHosts: string[]
}

interface PersistentTaskCheckpoint {
  segment: number
  stepsUsed: number
  llmCalls: number
  progressSummary: string
  doneSubtasks: string[]
  tabUrl: string | null
  workspaceId: string | null
  windowId: string | null
  savedAt: number
}

interface PersistentTaskRetry {
  kind: 'network' | 'rate-limit' | 'cli-dead' | 'tab-gone' | 'login' | 'model' | 'unknown'
  attempt: number
  nextAt: number
  detail: string
}

interface PersistentTask {
  id: string
  instruction: string
  state: PersistentTaskState
  mode: 'normal' | 'long'
  budget: PersistentTaskBudget
  checkpoint: PersistentTaskCheckpoint
  usage: { input: number; cacheRead: number; cacheCreate: number; output: number; llmCalls: number }
  resultFiles: string[]
  result?: string
  verifyEvidence?: string
  waitReason?: string
  retry?: PersistentTaskRetry
  readOnly: boolean
  incognito: boolean
  ownerWindowId: string | null
  externalWrites: Array<{ label: string; at: number; confirmed: boolean }>
  createdAt: number
  updatedAt: number
  startedAt: number
  endedAt?: number
  elapsedMs: number
}

// 생성물·워크플로·블로그 참여 타입 — 메인에서 import 하지 않고 여기 선언한다(프리로드 독립 원칙,
// PersistentTaskSummary 와 같은 관례). 메인 쪽 정의가 바뀌면 IPC 응답 모양이 달라지므로 함께 고칠 것.
interface AiArtifactMeta {
  id: string; taskId: string; name: string; path: string
  kind: 'image' | 'video' | 'file'
  format: string; mime: string; bytes: number; sha256: string
  width?: number; height?: number
  sourceUrl: string; sourcePageUrl: string; sourceTabId: string; sourceFrameUrl?: string
  capturedAt: number; origin: 'page-capture' | 'download-import'; label?: string
}

interface AiSocialStartParams {
  service: 'genspark' | 'chatgpt' | 'custom'
  customUrl?: string
  prompt: string
  platform: 'instagram' | 'youtube' | 'tiktok'
  account?: string
  tone?: string
  tags?: string[]
  mode: 'draft' | 'publish'
  windowId: string | null
  tabId: string
}

interface AiSocialWorkflow {
  id: string
  params: AiSocialStartParams
  stage: 'generate' | 'review' | 'publish' | 'done' | 'failed' | 'cancelled'
  taskIds: { generate?: string; publish?: string }
  artifactId?: string
  artifactPreview?: { width?: number; height?: number; bytes: number; format: string; sha256: string }
  caption?: string
  /** 캡션 초안 실패 사유. 있으면 자동 게시하지 않고 사용자가 직접 써야 한다. */
  captionError?: string
  /** 후보가 여럿이라 사람이 골랐는가(모호했던 이미지는 자동 게시 대상이 아니다). */
  artifactAmbiguous?: boolean
  /** 자동 게시 선승인으로 진행됐는가. */
  autoPublished?: boolean
  receipt?: { url?: string; evidence?: string; at: number }
  error?: string
  createdAt: number; updatedAt: number
}

interface AiAutoPublishGrantInput {
  platform: 'instagram' | 'youtube' | 'tiktok'
  accounts: string[]
  maxPosts: number
  minutes: number
}

interface AiAutoPublishGrant {
  id: string
  createdAt: number
  platform: 'instagram' | 'youtube' | 'tiktok'
  accounts: string[]
  maxPosts: number
  expiresAt: number
  used: number
  consumed: string[]
  revokedAt?: number
}

interface AiEngageParams {
  myBlogUrl?: string; topic?: string; searchUrl?: string; account?: string
  maxPosts: number
  actions: Array<'comment' | 'like'>
  mode: 'draft' | 'act'
  excludeHosts?: string[]
  minBodyChars?: number
  /** 글 사이 최소 간격(초). 영속 카운터로 **코드가 강제한다**(재개·구간 전환에도 유지). */
  intervalSeconds?: number
  /** 이 작업의 기한(epoch ms). 지나면 댓글·좋아요를 더 하지 않는다. */
  until?: number
}

interface AiEngageLedgerEntry {
  key: string; account: string; action: 'comment' | 'like'; at: number; note?: string
}

interface PersistentTaskSummary {
  id: string
  instruction: string
  state: PersistentTaskState
  mode: 'normal' | 'long'
  stepsUsed: number
  maxSteps: number
  segment: number
  elapsedMs: number
  startedAt: number
  endedAt?: number
  waitReason?: string
  retry?: PersistentTaskRetry
  llmCalls: number
  maxLlmCalls: number
  result?: string
  resultFiles: string[]
  needsVerify: boolean
}

contextBridge.exposeInMainWorld('browserAPI', api)

export type BrowserAPI = typeof api
