export interface TabSummary {
  id: string
  windowId: string
  workspaceId?: string
  url: string
  title: string
  favicon?: string
  pinned: boolean
  audible: boolean
  muted: boolean
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  groupId?: string
  active: boolean
  index: number
  discarded?: boolean
}

export interface TabGroup {
  id: string
  windowId: string
  title: string
  color: TabGroupColor
  collapsed: boolean
}

export type TabGroupColor =
  | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'gray'

export interface ReadLaterItem {
  id: string
  url: string
  title: string
  favicon?: string
  read: boolean
  savedAt: number
  readAt?: number
}

export interface WindowSummary {
  id: string
  activeTabId: string | null
}

export interface SearchEngine {
  id: string
  name: string
  keyword: string
  url: string
  suggest?: string
}

export interface BangShortcut {
  trigger: string
  url: string
  description?: string
}

export interface OmniboxSuggestion {
  id: string
  source: 'history' | 'bookmark' | 'tab' | 'search' | 'action' | 'url'
  text: string
  detail?: string
  url?: string
  icon?: string
  actionId?: string
  score: number
}

export interface ActionDescriptor {
  id: string
  category: string
  labelKey: string
  defaultKey?: string
  when?: ActionContext
}

export type ActionContext =
  | 'global' | 'chrome' | 'omnibox' | 'content' | 'palette' | 'search-in-page'

export interface KeyBinding {
  action: string
  key: string
  when: ActionContext
}

export type DownloadKind = 'http' | 'video' | 'torrent'

export interface DownloadItem {
  id: string
  kind: DownloadKind
  url: string
  filename: string
  savePath: string
  mime?: string
  totalBytes: number
  receivedBytes: number
  state: 'queued' | 'metadata' | 'active' | 'paused' | 'done' | 'seeding' | 'failed' | 'cancelled'
  startedAt: number
  completedAt?: number
  sourceTabUrl?: string
  error?: string
  speed?: number
  accelerator?: {
    connections: number
  }
  // 토렌트 전용 (kind === 'torrent')
  torrent?: {
    infoHash?: string
    peers: number
    uploadedBytes: number
    uploadSpeed: number
    ratio: number
    files: Array<{ name: string; length: number; selected: boolean }>
  }
}

export interface MediaCandidate {
  tabId: string
  url: string
  pageUrl: string
  mime: string
  kind: 'hls' | 'dash' | 'mp4' | 'video' | 'site'
  sizeBytes?: number
  detectedAt: number
}

export interface AdblockRecentBlock {
  ts: number
  url: string
  host: string
  sourceHost?: string
}

export interface AdblockStats {
  totalBlocked: number
  perHost: Record<string, number>
  enabled?: boolean
  level?: 'lite' | 'standard' | 'strict' | 'custom'
  filters?: Record<string, boolean>
  siteOverrides?: Record<string, boolean>
  recent?: AdblockRecentBlock[]
}

export interface ScreenshotMode {
  mode: 'area' | 'viewport' | 'fullpage' | 'element'
}

export interface Bookmark {
  id: number
  url: string
  title: string
  folderId: number | null
  addedAt: number
  position: number
}

export interface BookmarkFolder {
  id: number
  name: string
  parentId: number | null
  position: number
}

export interface BookmarkTree {
  folders: BookmarkFolder[]
  bookmarks: Bookmark[]
}

export interface HistoryEntry {
  id: number
  url: string
  title: string
  visitCount: number
  lastVisitAt: number
}

export interface TopSite {
  url: string
  title: string
  visitCount: number
  lastVisitAt: number
}

export type UserscriptRunAt = 'document-start' | 'document-end' | 'document-idle'

export interface Userscript {
  id: string
  name: string
  description: string
  version: string
  author: string
  namespace: string
  enabled: boolean
  match: string[]
  exclude: string[]
  grant: string[]
  runAt: UserscriptRunAt
  source: string
  createdAt: number
  updatedAt: number
}

export interface UserscriptSummary {
  id: string
  name: string
  description: string
  version: string
  enabled: boolean
  match: string[]
  updatedAt: number
}

export interface HeaderPair {
  name: string
  value: string
}

export type PermissionDecision = 'allow' | 'deny' | 'default'

export interface PolicyRule {
  id: string
  name: string
  enabled: boolean
  match: string[]
  userAgent: string
  reqHeadersSet: HeaderPair[]
  reqHeadersRemove: string[]
  resHeadersSet: HeaderPair[]
  resHeadersRemove: string[]
  stripCsp: boolean
  blockCookies: boolean
  blockJs: boolean
  blockImages: boolean
  customJs: string
  permissions?: Record<string, PermissionDecision>
  createdAt: number
  updatedAt: number
}

export interface PolicyRuleSummary {
  id: string
  name: string
  enabled: boolean
  match: string[]
  updatedAt: number
}

export interface PasswordEntry {
  id: string
  origin: string
  username: string
  encryptedPassword: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number
}

export interface PasswordSummary {
  id: string
  origin: string
  username: string
  updatedAt: number
}

export type WorkspaceColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'gray'

export interface Workspace {
  id: string
  name: string
  color: WorkspaceColor
  homeUrl: string
  partition: string
  createdAt: number
  updatedAt: number
  position: number
}

export interface WorkspaceState {
  workspaces: Workspace[]
  activeId: string
}

export interface UserChromeState {
  cssEnabled: boolean
  cssPath: string
  cssContent: string
  jsEnabled: boolean
  jsPath: string
  jsContent: string
  lastError?: string
}

export type MacroTriggerType = 'shortcut' | 'url' | 'startup'

export interface MacroAction {
  type: 'navigate' | 'wait' | 'js' | 'click' | 'screenshot' | 'toast'
  value: string
}

export interface Macro {
  id: string
  name: string
  description: string
  enabled: boolean
  trigger: { type: MacroTriggerType; value: string }
  actions: MacroAction[]
  createdAt: number
  updatedAt: number
}

export interface MacroSummary {
  id: string
  name: string
  description: string
  enabled: boolean
  trigger: { type: MacroTriggerType; value: string }
  updatedAt: number
}

export type ModPermission = 'tabs' | 'menu' | 'storage' | 'network' | 'node'

export interface ModManifest {
  id: string
  name: string
  description: string
  version: string
  author: string
  permissions: ModPermission[]
}

export interface ModSummary {
  id: string
  name: string
  description: string
  version: string
  author: string
  permissions: ModPermission[]
  enabled: boolean
  hasError: boolean
  errorMessage?: string
  path: string
}

export type TokenOverrides = Record<string, string>

export interface PerfMilestones {
  whenReadyMs: number | null
  firstWindowReadyMs: number | null
  firstTabLoadedMs: number | null
  memoryAt30sMB: number | null
  memoryNowMB: number
  startedAt: number
  version: string
  packaged: boolean
}

export interface PerfBudget {
  coldStartMs: number       // 빈 창 첫 ready 까지 < 2000
  blankWindowMemoryMB: number // 빈 창 30초 후 < 250
}

export interface PerfReport {
  current: PerfMilestones
  budget: PerfBudget
  history: PerfMilestones[]
}

export interface ExtensionSummary {
  id: string
  name: string
  version: string
  description?: string
  enabled: boolean
  hasOptions: boolean
  hasIcon: boolean
  iconDataUrl?: string
  hasAction: boolean
  actionTitle?: string
  homepageUrl?: string
  source: 'crx' | 'unpacked' | 'webstore'
}

