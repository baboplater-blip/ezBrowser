import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import './external-features'
import type {
  ActionDescriptor, AdblockStats, Bookmark, BookmarkFolder, BookmarkTree, DownloadItem,
  ExtensionSummary, HistoryEntry, KeyBinding,
  Macro, MacroSummary, ModSummary,
  PasswordSummary, PerfMilestones, PerfReport, PolicyRule, PolicyRuleSummary, ReadLaterItem, SearchEngine, TopSite,
  Userscript, UserscriptSummary, Workspace, WorkspaceState,
} from '../shared/types'

type Unsubscribe = () => void

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const fn = (_: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, fn)
  return () => { ipcRenderer.off(channel, fn) }
}

const api = {
  navigate: (url: string): void => { window.location.href = url },
  bookmarks: {
    list: (): Promise<BookmarkTree> => ipcRenderer.invoke(IPC.bookmarks.list),
    add: (args: { url: string; title: string; folderId?: number | null }): Promise<Bookmark> =>
      ipcRenderer.invoke(IPC.bookmarks.add, args),
    remove: (id: number): Promise<void> => ipcRenderer.invoke(IPC.bookmarks.remove, { id }),
    rename: (id: number, title: string): Promise<void> =>
      ipcRenderer.invoke(IPC.bookmarks.rename, { id, title }),
    update: (id: number, patch: { title?: string; url?: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.bookmarks.update, { id, ...patch }),
    move: (id: number, folderId: number | null, position: number): Promise<void> =>
      ipcRenderer.invoke(IPC.bookmarks.move, { id, folderId, position }),
    folderCreate: (name: string, parentId?: number | null): Promise<BookmarkFolder> =>
      ipcRenderer.invoke(IPC.bookmarks.folderCreate, { name, parentId }),
    folderRename: (id: number, name: string): Promise<void> =>
      ipcRenderer.invoke(IPC.bookmarks.folderRename, { id, name }),
    folderRemove: (id: number): Promise<void> =>
      ipcRenderer.invoke(IPC.bookmarks.folderRemove, { id }),
    exportHtml: (): Promise<string> => ipcRenderer.invoke(IPC.bookmarks.exportHtml),
    importHtml: (html: string): Promise<{ folders: number; bookmarks: number }> =>
      ipcRenderer.invoke(IPC.bookmarks.importHtml, { html }),
    onChanged: (cb: (tree: BookmarkTree) => void) => on(IPC.bookmarks.changed, cb),
  },
  userscript: {
    list: (): Promise<UserscriptSummary[]> => ipcRenderer.invoke(IPC.userscript.list),
    get: (id: string): Promise<Userscript | null> => ipcRenderer.invoke(IPC.userscript.get, { id }),
    save: (args: { id?: string; source: string }): Promise<Userscript> =>
      ipcRenderer.invoke(IPC.userscript.save, args),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.userscript.remove, { id }),
    setEnabled: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.userscript.setEnabled, { id, enabled }),
    onChanged: (cb: (list: UserscriptSummary[]) => void) =>
      on(IPC.userscript.changed, cb),
  },
  policy: {
    list: (): Promise<PolicyRuleSummary[]> => ipcRenderer.invoke(IPC.policy.list),
    get: (id: string): Promise<PolicyRule | null> => ipcRenderer.invoke(IPC.policy.get, { id }),
    save: (rule: Partial<PolicyRule>): Promise<PolicyRule> =>
      ipcRenderer.invoke(IPC.policy.save, rule),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.policy.remove, { id }),
    setEnabled: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.policy.setEnabled, { id, enabled }),
    onChanged: (cb: (list: PolicyRuleSummary[]) => void) =>
      on(IPC.policy.changed, cb),
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
  settings: {
    all: (): Promise<Record<string, unknown>> => ipcRenderer.invoke(IPC.settings.all),
    get: (key: string): Promise<unknown> => ipcRenderer.invoke(IPC.settings.get, { key }),
    set: (key: string, value: unknown): Promise<void> =>
      ipcRenderer.invoke(IPC.settings.set, { key, value }),
    onChange: (cb: (s: Record<string, unknown>) => void) =>
      on(IPC.settings.changed, cb),
  },
  update: {
    status: (): Promise<unknown> => ipcRenderer.invoke(IPC.update.status),
    check: (): Promise<unknown> => ipcRenderer.invoke(IPC.update.check),
    download: (): Promise<unknown> => ipcRenderer.invoke(IPC.update.download),
    install: (): Promise<void> => ipcRenderer.invoke(IPC.update.install),
    setChannel: (channel: string): Promise<void> =>
      ipcRenderer.invoke(IPC.update.setChannel, { channel }),
    setAutoDownload: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.update.setAutoDownload, { enabled }),
    setAutoCheck: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.update.setAutoCheck, { enabled }),
    onStatus: (cb: (s: unknown) => void) => on(IPC.update.status, cb),
  },
  search: {
    listEngines: (): Promise<SearchEngine[]> => ipcRenderer.invoke(IPC.search.listEngines),
  },
  keymap: {
    get: (): Promise<{ keymap: { version: number; bindings: KeyBinding[] }; conflicts: Array<{ key: string; when: string; actions: string[] }> }> =>
      ipcRenderer.invoke(IPC.keymap.get),
    set: (keymap: { version: number; bindings: KeyBinding[] }): Promise<{ keymap: { version: number; bindings: KeyBinding[] }; conflicts: Array<{ key: string; when: string; actions: string[] }> }> =>
      ipcRenderer.invoke(IPC.keymap.set, { keymap }),
    reset: (): Promise<{ keymap: { version: number; bindings: KeyBinding[] }; conflicts: Array<{ key: string; when: string; actions: string[] }> }> =>
      ipcRenderer.invoke(IPC.keymap.reset),
  },
  password: {
    available: (): Promise<boolean> => ipcRenderer.invoke(IPC.password.available),
    list: (): Promise<PasswordSummary[]> => ipcRenderer.invoke(IPC.password.list),
    reveal: (id: string): Promise<string | null> => ipcRenderer.invoke(IPC.password.reveal, { id }),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.password.remove, { id }),
    onChanged: (cb: (list: PasswordSummary[]) => void) =>
      on(IPC.password.changed, cb),
  },
  workspace: {
    list: (): Promise<Workspace[]> => ipcRenderer.invoke(IPC.workspace.list),
    state: (): Promise<WorkspaceState> => ipcRenderer.invoke(IPC.workspace.state),
    activate: (id: string): Promise<string> => ipcRenderer.invoke(IPC.workspace.activate, { id }),
    create: (args?: Partial<Workspace>): Promise<Workspace> =>
      ipcRenderer.invoke(IPC.workspace.create, args ?? {}),
    update: (id: string, patch: Partial<Workspace>): Promise<Workspace | null> =>
      ipcRenderer.invoke(IPC.workspace.update, { id, patch }),
    remove: (id: string): Promise<{ removed: boolean; newActiveId: string }> =>
      ipcRenderer.invoke(IPC.workspace.remove, { id }),
    onChanged: (cb: (state: WorkspaceState) => void) =>
      on(IPC.workspace.changed, cb),
  },
  data: {
    export: (): Promise<unknown> => ipcRenderer.invoke(IPC.data.export),
    import: (bundle: unknown): Promise<{ ok: boolean; restored: number; errors: string[] }> =>
      ipcRenderer.invoke(IPC.data.import, { bundle }),
  },
  tokens: {
    get: (): Promise<{
      editable: Array<{ key: string; cssVar: string; label: string; type: string; defaultValue: string }>
      overrides: Record<string, string>
      cssVars: Record<string, string>
      defaults: Record<string, string>
    } | null> => ipcRenderer.invoke(IPC.tokens.get),
    set: (key: string, value: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.tokens.set, { key, value }),
    reset: (): Promise<void> => ipcRenderer.invoke(IPC.tokens.reset),
    onChanged: (cb: (p: { overrides: Record<string, string>; cssVars: Record<string, string> }) => void) =>
      on(IPC.tokens.changed, cb),
  },
  macro: {
    list: (): Promise<MacroSummary[]> => ipcRenderer.invoke(IPC.macro.list),
    get: (id: string): Promise<Macro | null> => ipcRenderer.invoke(IPC.macro.get, { id }),
    save: (m: Partial<Macro>): Promise<Macro> => ipcRenderer.invoke(IPC.macro.save, m),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.macro.remove, { id }),
    run: (id: string, windowId?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.macro.run, { id, windowId }),
    onChanged: (cb: (list: MacroSummary[]) => void) => on(IPC.macro.changed, cb),
  },
  mod: {
    list: (): Promise<ModSummary[]> => ipcRenderer.invoke(IPC.mod.list),
    setEnabled: (id: string, enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC.mod.setEnabled, { id, enabled }),
    reload: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.mod.reload, { id }),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.mod.remove, { id }),
    onChanged: (cb: (list: ModSummary[]) => void) => on(IPC.mod.changed, cb),
  },
  adblock: {
    stats: (): Promise<AdblockStats> => ipcRenderer.invoke(IPC.adblock.stats),
    setLevel: (level: 'lite' | 'standard' | 'strict' | 'custom'): Promise<void> =>
      ipcRenderer.invoke(IPC.adblock.setLevel, { level }),
    setEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.adblock.setEnabled, { enabled }),
    setFilter: (id: 'easylist' | 'easyprivacy' | 'kr' | 'fanboyAnnoyance' | 'fanboySocial', enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.adblock.setFilter, { id, enabled }),
    setSiteAllowed: (host: string, allowed: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.adblock.setSiteAllowed, { host, allowed }),
    onChanged: (cb: (stats: AdblockStats) => void) => on(IPC.adblock.changed, cb),
  },
  downloads: {
    list: (): Promise<DownloadItem[]> => ipcRenderer.invoke(IPC.downloads.list),
    pause: (id: string): Promise<void> => ipcRenderer.invoke(IPC.downloads.pause, { id }),
    resume: (id: string): Promise<void> => ipcRenderer.invoke(IPC.downloads.resume, { id }),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke(IPC.downloads.cancel, { id }),
    openFolder: (id?: string): Promise<void> => ipcRenderer.invoke(IPC.downloads.openFolder, { id }),
    pickFolder: (): Promise<{ canceled: boolean; path?: string }> => ipcRenderer.invoke(IPC.downloads.pickFolder),
    onUpdate: (cb: (list: DownloadItem[]) => void) => on(IPC.downloads.update, cb),
  },
  torrent: {
    add: (uri: string): Promise<string | null> => ipcRenderer.invoke(IPC.torrent.add, { uri }),
    pause: (id: string): Promise<void> => ipcRenderer.invoke(IPC.torrent.pause, { id }),
    resume: (id: string): Promise<void> => ipcRenderer.invoke(IPC.torrent.resume, { id }),
    remove: (id: string, deleteFiles?: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.torrent.remove, { id, deleteFiles }),
    setFiles: (id: string, indices: number[]): Promise<void> =>
      ipcRenderer.invoke(IPC.torrent.setFiles, { id, indices }),
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
    importLocal: (): Promise<{ ok: boolean; id?: string; error?: string }> =>
      ipcRenderer.invoke(IPC.extensions.importLocal),
    onChanged: (cb: (list: ExtensionSummary[]) => void) => on(IPC.extensions.changed, cb),
  },
  actions: {
    list: (): Promise<Array<ActionDescriptor & { key?: string }>> =>
      ipcRenderer.invoke(IPC.actions.list),
    run: (id: string, ctx: { windowId?: string; tabId?: string }): Promise<boolean> =>
      ipcRenderer.invoke(IPC.actions.run, { id, ctx }),
  },
  perf: {
    report: (): Promise<PerfReport> => ipcRenderer.invoke(IPC.perf.report),
    onMilestone: (cb: (m: PerfMilestones) => void) => on(IPC.perf.milestone, cb),
  },
  widgets: {
    weather: (force?: boolean): Promise<unknown> =>
      ipcRenderer.invoke(IPC.widgets.weather, { force }),
    news: (force?: boolean): Promise<unknown> =>
      ipcRenderer.invoke(IPC.widgets.news, { force }),
    fx: (force?: boolean): Promise<unknown> =>
      ipcRenderer.invoke(IPC.widgets.fx, { force }),
    dataGet: (key: string): Promise<unknown> =>
      ipcRenderer.invoke(IPC.widgets.dataGet, { key }),
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
    clearAll: (): Promise<void> => ipcRenderer.invoke(IPC.permissions.clearAll),
    onChanged: (cb: (list: Array<{ origin: string; permissions: Record<string, 'allow' | 'deny'> }>) => void) =>
      on(IPC.permissions.changed, cb),
  },
  readlater: {
    list: (): Promise<ReadLaterItem[]> => ipcRenderer.invoke(IPC.readlater.list),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.readlater.remove, { id }),
    setRead: (id: string, read: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.readlater.setRead, { id, read }),
    onChanged: (cb: (items: ReadLaterItem[]) => void) => on(IPC.readlater.changed, cb),
  },
  importer: {
    sources: (): Promise<Array<{ id: string; browser: string; profile: string; hasBookmarks: boolean; hasHistory: boolean }>> =>
      ipcRenderer.invoke(IPC.imports.sources),
    run: (sourceId: string, opts: { bookmarks: boolean; history: boolean }): Promise<{ ok: boolean; bookmarks: number; folders: number; history: number; errors: string[] }> =>
      ipcRenderer.invoke(IPC.imports.run, { sourceId, ...opts }),
  },
  onboarding: {
    setDefaultBrowser: (): Promise<{ ok: boolean; http: boolean; https: boolean }> =>
      ipcRenderer.invoke(IPC.onboarding.setDefaultBrowser),
    complete: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.onboarding.complete),
  },
  system: {
    metrics: (): Promise<unknown> => ipcRenderer.invoke(IPC.system.metrics),
    bootInfo: (): Promise<{ bootTime: number; now: number; uptimeMs: number } | null> =>
      ipcRenderer.invoke(IPC.system.bootInfo),
    sweepTabSleep: (): Promise<{ discarded: number; skipped: number }> =>
      ipcRenderer.invoke(IPC.system.sweepTabSleep),
    wakeTab: (tabId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.system.wakeTab, { tabId }),
    licenses: (): Promise<{
      app: { version: string; electronVersion: string; chromeVersion: string } | null
      packages: Array<{ name: string; version: string; licenses: string; repository?: string; publisher?: string }>
    }> => ipcRenderer.invoke(IPC.system.licenses),
  },
  ai: {
    config: (): Promise<{
      enabled: boolean
      provider: 'anthropic' | 'openai' | 'ollama' | 'google'
      providerLabel: string
      model: string
      hasKey: boolean
      storageAvailable: boolean
    } | null> => ipcRenderer.invoke(IPC.ai.config),
    keyStatus: (): Promise<{ anthropic: boolean; openai: boolean; google: boolean; storageAvailable: boolean } | null> =>
      ipcRenderer.invoke(IPC.ai.keyStatus),
    diagnose: (): Promise<{
      ok: boolean; provider: string; providerLabel: string; model: string; status: string
      message: string; detail?: string; fix?: string; latencyMs?: number; installedModels?: string[]
    } | null> => ipcRenderer.invoke(IPC.ai.diagnose),
    setKey: (provider: 'anthropic' | 'openai' | 'google', key: string): Promise<{ ok: boolean; status?: { anthropic: boolean; openai: boolean; google: boolean; storageAvailable: boolean } }> =>
      ipcRenderer.invoke(IPC.ai.setKey, { provider, key }),
    clearKey: (provider: 'anthropic' | 'openai' | 'google'): Promise<{ ok: boolean; status?: { anthropic: boolean; openai: boolean; google: boolean; storageAvailable: boolean } }> =>
      ipcRenderer.invoke(IPC.ai.clearKey, { provider }),
    memoryGet: (): Promise<string> => ipcRenderer.invoke(IPC.ai.memoryGet),
    memorySet: (text: string): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.ai.memorySet, { text }),
    memoryClear: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.ai.memoryClear),
    onMemoryChanged: (cb: (text: string) => void) => on(IPC.ai.memoryChanged, cb),
    pickAgentDir: (): Promise<{ ok: boolean; dir: string; count: number }> => ipcRenderer.invoke(IPC.ai.pickAgentDir),
    agentFilesInfo: (): Promise<{ dir: string; count: number; files: string[] }> => ipcRenderer.invoke(IPC.ai.agentFilesInfo),
    triggerList: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.ai.triggerList),
    triggerAdd: (p: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke(IPC.ai.triggerAdd, p),
    triggerUpdate: (id: string, patch: Record<string, unknown>): Promise<void> => ipcRenderer.invoke(IPC.ai.triggerUpdate, { id, patch }),
    triggerRemove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ai.triggerRemove, { id }),
    triggerSetEnabled: (id: string, enabled: boolean): Promise<void> => ipcRenderer.invoke(IPC.ai.triggerSetEnabled, { id, enabled }),
    onTriggerChanged: (cb: (list: unknown[]) => void) => on(IPC.ai.triggerChanged, cb),
    profileGet: (): Promise<{ fields: Array<{ key: string; label: string; sensitive?: boolean }>; values: Record<string, string>; storageAvailable: boolean }> => ipcRenderer.invoke(IPC.ai.profileGet),
    profileSet: (values: Record<string, string>): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.ai.profileSet, values),
    onProfileChanged: (cb: () => void) => on(IPC.ai.profileChanged, cb),
    // 매일 자동 수집(피드 수집기) — browser://ai-collectors 관리 페이지용
    collectorList: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.ai.collectorList),
    collectorAdd: (p: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke(IPC.ai.collectorAdd, p),
    collectorUpdate: (id: string, patch: Record<string, unknown>): Promise<void> => ipcRenderer.invoke(IPC.ai.collectorUpdate, { id, patch }),
    collectorRemove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.ai.collectorRemove, { id }),
    collectorSetEnabled: (id: string, enabled: boolean): Promise<void> => ipcRenderer.invoke(IPC.ai.collectorSetEnabled, { id, enabled }),
    collectorRun: (id: string): Promise<{ ok: boolean; run?: unknown }> => ipcRenderer.invoke(IPC.ai.collectorRun, { id }),
    collectorRuns: (id: string): Promise<unknown[]> => ipcRenderer.invoke(IPC.ai.collectorRuns, { id }),
    onCollectorChanged: (cb: (list: unknown[]) => void) => on(IPC.ai.collectorChanged, cb),
    onCollectorRan: (cb: (run: unknown) => void) => on(IPC.ai.collectorRan, cb),
  },
}

contextBridge.exposeInMainWorld('internalAPI', api)

export type InternalAPI = typeof api
