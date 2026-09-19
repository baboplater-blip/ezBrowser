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
  // ===== 자동화 로그인 (계정별 명시 opt-in) =====
  // 저장되어 있다는 사실만으로는 에이전트가 이 계정으로 로그인하지 않는다. 사용자가 계정마다 켜야 한다
  // (마이그레이션: 기존 항목은 전부 false). 켜면 "입력 + 로그인 버튼 누르기" 까지 허용된다 —
  // 자동 제출 권한을 저장과 분리해 달라는 요구를 이 한 플래그의 **명시성**으로 만족시킨다.
  autoLoginAllowed?: boolean
  /** 같은 origin 에 허용 계정이 여럿일 때 자동화가 쓸 기본 계정. 없으면 자동화는 사용자에게 고르라고 묻는다. */
  preferred?: boolean
  /** 연속 로그인 실패 횟수 — 계정 잠금을 유발하는 무한 재시도를 막는다. 성공하거나 비밀번호를 고치면 0. */
  autoLoginFailures?: number
  /** 이 시각(ms)까지 자동 로그인 잠김. 디스크에 남으므로 앱을 재시작해도 유지된다. */
  autoLoginBlockedUntil?: number
}

export interface PasswordSummary {
  id: string
  origin: string
  username: string
  updatedAt: number
  autoLoginAllowed: boolean
  preferred: boolean
  scheme: 'https' | 'http'
  autoLoginFailures: number
  autoLoginBlockedUntil: number
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

/**
 * 확장이 **어느 세션에서 실제로 로드됐는지**.
 *
 * 왜 필요한가: 우리 탭은 워크스페이스마다 다른 partition(`persist:ws-*`)을 쓰고, 확장은 그
 * 세션들에 각각 로드된다. 그런데 목록은 `defaultSession` 하나만 보고 "켬/끔"만 말해서,
 * **어떤 워크스페이스에서는 확장이 전혀 안 뜨는데도 화면에는 정상으로 보였다**.
 * 설정상 켬(`enabled`)과 실제 로드됨(`loaded`)은 다른 것이므로 따로 싣는다.
 */
export interface ExtensionSessionLoad {
  /** partition 문자열. defaultSession 은 빈 문자열. 사용자에게 그대로 보이면 안 된다(label 을 쓸 것). */
  partition: string
  /** 사람이 읽는 이름 — '기본' · '워크스페이스: 업무' · '시크릿'. */
  label: string
  kind: 'default' | 'workspace' | 'incognito' | 'other'
  /** 지금 이 세션에 실제로 올라와 있는가(과거 시도 기록이 아니라 현재 상태를 조회한 값). */
  loaded: boolean
  /** 실패 원문(영문 메시지 등) — 화면에는 접어서 보여준다. */
  error?: string
  /** 실패를 한국어로 요약한 것 — 화면에 먼저 보여준다. */
  reason?: string
}

export interface ExtensionSummary {
  /** 이 확장의 declarativeNetRequest 정적 룰 중 우리가 적용 중인 개수(없으면 0). */
  dnrRules?: number
  id: string
  name: string
  version: string
  description?: string
  /** 사용자가 켜 둔 상태인가(설정값). 실제 동작 여부는 `loaded` 를 볼 것. */
  enabled: boolean
  /** 한 곳 이상의 세션에 실제로 로드돼 있는가. */
  loaded?: boolean
  /** 세션별 로드 결과(확장이 로드될 수 있는 세션만 — 시크릿은 제외). */
  sessions?: ExtensionSessionLoad[]
  /** 로드에 성공한 세션 수 / 전체 세션 수 — 부분 실패를 한눈에. */
  loadedSessions?: number
  totalSessions?: number
  hasOptions: boolean
  hasIcon: boolean
  iconDataUrl?: string
  hasAction: boolean
  actionTitle?: string
  homepageUrl?: string
  source: 'crx' | 'unpacked' | 'webstore'
}


// ── AI 제공자 탐지·연결 ────────────────────────────────────────────────────────
// 메인(features/ai/detect.ts)·preload·화면(AiTab·설정·환영)이 같은 모양을 본다.

export type AiProviderKind =
  | 'anthropic' | 'openai' | 'ollama' | 'google' | 'claude-code' | 'codex' | 'gemini-cli'

/** 지금 이 컴퓨터에서 쓸 수 있는가 / 얼마가 드는가 — 사용자에게 그대로 보여주는 판정. */
export interface AiProviderCandidate {
  id: AiProviderKind
  label: string
  kind: 'cli' | 'local' | 'key'
  ready: boolean
  /** subscription=이미 있는 구독 · free-local=내 컴퓨터 · free-tier=무료 티어 · paid-key=종량 과금 */
  cost: 'subscription' | 'free-local' | 'free-tier' | 'paid-key'
  detail: string
  fix?: string
  models?: string[]
}

export interface AiProviderDetection {
  at: number
  current: AiProviderKind
  currentReady: boolean
  candidates: AiProviderCandidate[]
  error?: string
}

export interface AiDiagnosisSummary {
  ok: boolean
  provider: string
  providerLabel: string
  model: string
  status: string
  message: string
  detail?: string
  fix?: string
  latencyMs?: number
  installedModels?: string[]
}

export interface AiConnectResult {
  ok: boolean
  provider?: AiProviderKind
  providerLabel?: string
  diagnosis?: AiDiagnosisSummary
  error?: string
}

// ===== 에이전트 입력창 의도 해석 (묶음 INTENT-1) =====
// 사용자가 직접 친 자연어 요청을 생산 워크플로의 **폼 미리채움**으로 읽은 결과.
// 이 타입들은 제안값만 담는다 — 게시·참여 권한은 여기서 만들어지지 않는다.

export type WorkflowIntentKind = 'image-post' | 'blog-engage'

export interface ImagePostIntentFields {
  service: 'genspark' | 'chatgpt' | 'custom'
  /** 사용자가 그려 달라고 한 내용 */
  prompt: string
  /** 못 고르면 null — missing 에 'platform' 이 함께 온다 */
  platform: 'instagram' | 'youtube' | 'tiktok' | null
  /** 제안값일 뿐. 실제 게시 여부는 기존 승인 단계가 결정한다. */
  mode: 'draft' | 'publish'
  tags: string[]
}

export interface BlogEngageIntentFields {
  topic: string
  /** 원문에 내 블로그 주소가 있을 때만 */
  myBlogUrl: string
  actions: ('comment' | 'like')[]
  mode: 'draft' | 'act'
  /** 1~20 */
  maxPosts: number
  /** 원문에 검색·목록 주소가 있을 때만, 없으면 '' */
  searchUrl: string
}

export interface WorkflowIntent {
  kind: WorkflowIntentKind
  /** 사용자에게 보여 줄 한 줄 한국어 요약 */
  summary: string
  /** 사용자가 한 번 설정해야 하는 것: 'platform' | 'account' | 'prompt' | 'topic' | 'maxPosts' */
  missing: string[]
  /** 무엇을 보고 이렇게 판단했는지 — 디버깅·검사용 근거 토큰 */
  matched: string[]
  image?: ImagePostIntentFields
  blog?: BlogEngageIntentFields
}
