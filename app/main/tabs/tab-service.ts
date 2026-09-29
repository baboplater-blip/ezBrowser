import { WebContentsView, app, dialog } from 'electron'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { DEFAULT_SESSION, NEW_TAB_URL } from '../../shared/constants'
import { IPC } from '../../shared/ipc-channels'
import type { TabSummary, TabGroup, TabGroupColor } from '../../shared/types'
import {
  bringChromeToFront, getWindow, getChromeSize, getTabBounds, onWindowResize, routeWindowOpen,
  setShellInsetsHook, windowEvents, type BrowserWindowContext, type ShellInsets,
} from '../windows/window-service'
import {
  getActiveWorkspaceId, getActivePartition, getWorkspace, workspaceEvents,
} from '../features/workspace'
import { setupSessionByPartition } from '../session-bootstrap'
import { getFavicon, recordFavicon } from '../features/favicon'
import { trackPageErrors, thumbnailDataUrl } from '../features/page-errors'
import { tMain } from '../i18n'

type TabHook = (tab: { id: string; webContentsId: number }) => void
const onTabCreatedHooks: TabHook[] = []
const onTabClosedHooks: Array<(id: string) => void> = []

const onTabActivatedHooks: Array<(id: string) => void> = []

export function onTabCreated(cb: TabHook): void { onTabCreatedHooks.push(cb) }
export function onTabClosed(cb: (id: string) => void): void { onTabClosedHooks.push(cb) }
/** 활성 탭이 바뀔 때 — 확장 시스템의 `chrome.tabs.query({ active: true })` 가 이 신호를 쓴다. */
export function onTabActivated(cb: (id: string) => void): void { onTabActivatedHooks.push(cb) }

interface TabRecord {
  id: string
  /**
   * **복원을 넘어 살아남는 탭의 정체성.**
   *
   * `id`(`tab-N`)는 프로세스마다 1부터 다시 세므로 크래시 복원 뒤의 `tab-3` 은 종료 전의 `tab-3`
   * 과 아무 관계가 없다. 그래서 내구 자동화 작업은 예전에 "창 id + URL 호스트" 로 대상을 다시
   * 찾았고, 같은 사이트 탭이 여러 개면 **엉뚱한 탭**을 집을 수 있었다(발행·결제면 사고다).
   * 이 키는 세션 스냅샷에 함께 저장돼 복원 시 그대로 되살아나므로, "사용자가 보기에 바로 그 탭"
   * 을 기계가 확정할 수 있는 유일한 값이다.
   */
  restoreKey: string
  windowId: string
  workspaceId: string
  view: WebContentsView
  partition: string
  pinned: boolean
  groupId?: string
  index: number
  createdAt: number
  lastActiveAt: number
  discarded: boolean
  // 슬립 전 원본 URL / 제목 (about:blank 로 unload 한 뒤 복원용)
  discardedUrl?: string
  discardedTitle?: string
  // 슬립/세션복원 전 내비게이션 히스토리(뒤로·앞으로 + 스크롤·폼 상태) — 깨우거나 복원할 때 재생
  discardedHistory?: NavigationEntrySnap[]
  discardedIndex?: number
  // 슬립 직전에 찍어 둔 화면 미리보기(320px 폭 JPEG data URL). about:blank 로 언로드된 뒤에도
  // captureTab() 이 "마지막 모습"을 대신 돌려줄 수 있게 해 준다.
  discardedThumbnail?: string
  // 로드를 요청했지만 아직 커밋되지 않은 URL. webContents.getURL() 은 첫 커밋 전까지 빈 문자열이라,
  // 그 사이에 세션 스냅샷을 뜨면 **갓 만든 탭이 통째로 빠진다**(크래시 시 그 탭이 사라진다).
  // 커밋 후에는 getURL() 이 항상 우선하므로 이 값은 그 공백 구간에서만 쓰인다.
  pendingUrl?: string
}

// ===== 내비게이션 히스토리 스냅샷 (뒤로/앞으로 + 스크롤 + 폼 상태) =====
// NavigationEntry.pageState 는 Chromium 이 커밋하는 base64 페이지 상태로 스크롤 위치·폼 값을 포함.
export interface NavigationEntrySnap { url: string; title: string; pageState?: string }
const MAX_HISTORY_ENTRIES = 30
const MAX_PAGESTATE_BYTES = 512 * 1024

function captureHistory(wc: Electron.WebContents): { entries: NavigationEntrySnap[]; index: number } | null {
  try {
    const nav = wc.navigationHistory
    const all = nav.getAllEntries()
    if (!all || all.length === 0) return null
    let activeIndex = nav.getActiveIndex()
    let entries = all
    if (all.length > MAX_HISTORY_ENTRIES) {
      const start = all.length - MAX_HISTORY_ENTRIES
      entries = all.slice(start)
      activeIndex = Math.max(0, activeIndex - start)
    }
    const out: NavigationEntrySnap[] = entries.map((e) => {
      const snap: NavigationEntrySnap = { url: e.url, title: e.title || e.url }
      // pageState 가 과도하게 크면(드뭄) 생략 — URL/제목 복원은 유지, 스크롤·폼만 포기
      if (e.pageState && e.pageState.length <= MAX_PAGESTATE_BYTES) snap.pageState = e.pageState
      return snap
    })
    const idx = Math.min(Math.max(0, activeIndex), out.length - 1)
    return { entries: out, index: idx }
  } catch { return null }
}

/** 저장된 히스토리를 webContents 에 재생. 실패 시 활성 엔트리 URL 단독 로드로 폴백. */
function restoreNavigation(wc: Electron.WebContents, entries: NavigationEntrySnap[], index?: number): void {
  const safeIdx = typeof index === 'number' ? Math.min(Math.max(0, index), entries.length - 1) : entries.length - 1
  const fallbackUrl = entries[safeIdx]?.url ?? entries[entries.length - 1]?.url ?? NEW_TAB_URL
  try {
    const restorable = entries.map((e) => ({ url: e.url, title: e.title, pageState: e.pageState })) as Electron.NavigationEntry[]
    void wc.navigationHistory.restore({ entries: restorable, index: safeIdx })
      // 폴백은 **조용히** 하면 안 된다 — 이 경로로 떨어지면 URL 만 맞고 스크롤·폼은 사라진다.
      // (2026-09-15: 잠든 복원 탭을 깨울 때 여기로 떨어지는 것을 이 로그로 확인했다.)
      .catch((err: unknown) => {
        console.warn(`[tabs] navigationHistory.restore 실패 → 평문 로드로 폴백(스크롤·폼 유실): ${String(err)}`)
        void wc.loadURL(fallbackUrl)
      })
  } catch (err) {
    console.warn(`[tabs] navigationHistory.restore 예외 → 평문 로드로 폴백(스크롤·폼 유실): ${String(err)}`)
    void wc.loadURL(fallbackUrl)
  }
}

const tabs = new Map<string, TabRecord>()
interface ClosedEntry {
  id: number; url: string; title: string; windowId: string
  index: number; workspaceId: string; groupId?: string; closedAt: number
}
const closedStack: ClosedEntry[] = []
let closedCounter = 0
const resizeBound = new WeakSet<BrowserWindowContext>()
let counter = 0

// ===== HTML5 전체화면(enter/leave-html-full-screen) =====
// 진입 시 그 탭의 view 가 창 전체(insets 0)를 덮어 외피를 가리고, 다른 탭/pane 은 잠시 숨긴다.
// 종료 시 원래 insets 를 복원하고 reapplyLayout() 으로 분할·다른 탭 가시성을 정상대로 되돌린다.
const fullscreenByWindow = new Map<string, { insets: ShellInsets; tabId: string }>()

// ===== 탭 그룹 (색상 그룹핑 · 접기) =====
const groups = new Map<string, TabGroup>()
let groupCounter = 0
const GROUP_COLORS: TabGroupColor[] = ['blue', 'red', 'green', 'yellow', 'purple', 'pink', 'orange', 'gray']

// 그룹 색은 세션 스냅샷에 영속되고 외피가 CSS 변수(--group-color)로 쓴다.
// 렌더러가 보낸 값을 팔레트와 대조해 **아는 색일 때만** 받는다.
// (2026-09-07 임무 19: 워크스페이스에 같은 결함이 있어 객체 `{}` 가 색으로 저장됐다.
//  여기는 truthy 검사뿐이라 같은 값이 통과한다.)
function validGroupColor(v: unknown): TabGroupColor | null {
  return typeof v === 'string' && (GROUP_COLORS as string[]).includes(v) ? (v as TabGroupColor) : null
}

interface Pane { tabId: string | null }
export type SplitDirection = 'h' | 'v'
interface WindowLayout {
  panes: Pane[]               // 1개 = single, 2개 = split
  split: SplitDirection | null
  activePaneIdx: number
  splitRatio: number          // 0.0~1.0, default 0.5
}

// 윈도우+워크스페이스 별 layout — 워크스페이스 전환 시 분할 상태/활성 탭 별도 유지
const layoutByWindow = new Map<string, WindowLayout>()

function layoutKey(windowId: string, workspaceId: string): string {
  return `${windowId}::${workspaceId}`
}

function singleLayout(): WindowLayout {
  return { panes: [{ tabId: null }], split: null, activePaneIdx: 0, splitRatio: 0.5 }
}

// 시크릿 창은 전역 워크스페이스와 무관한 고정 워크스페이스를 쓴다 — 메인 창에서 워크스페이스를 전환/삭제해도
// 시크릿 창의 탭 목록·레이아웃·가시성이 영향받지 않는다(전역 활성 ws 로 필터하면 시크릿 TabBar 가 비어버린다).
// 일반 창에서는 getActiveWorkspaceId() 를 그대로 반환 → 기존 동작 완전 불변.
function incognitoWs(windowId: string): string { return 'incognito-ws-' + windowId }
function effectiveActiveWs(windowId: string): string {
  return getWindow(windowId)?.incognito ? incognitoWs(windowId) : getActiveWorkspaceId()
}

function getLayout(windowId: string, workspaceId?: string): WindowLayout {
  const wsId = workspaceId ?? effectiveActiveWs(windowId)
  const key = layoutKey(windowId, wsId)
  let l = layoutByWindow.get(key)
  if (!l) {
    l = singleLayout()
    layoutByWindow.set(key, l)
  }
  return l
}

function getActivePane(layout: WindowLayout): Pane {
  return layout.panes[layout.activePaneIdx] ?? layout.panes[0] ?? { tabId: null }
}

function getActiveTabId(windowId: string): string | null {
  const wsId = effectiveActiveWs(windowId)
  const l = layoutByWindow.get(layoutKey(windowId, wsId))
  if (!l) return null
  return getActivePane(l).tabId
}

function paneIndexOfTab(layout: WindowLayout, tabId: string): number {
  return layout.panes.findIndex((p) => p.tabId === tabId)
}

const SPLITTER_THICKNESS = 4
const PANE_OUTLINE = 2

function paneBoundsOf(ctx: BrowserWindowContext, idx: number, layout: WindowLayout): Electron.Rectangle {
  const base = getTabBounds(ctx)
  if (layout.panes.length === 1 || layout.split === null) return base
  const ratio = Math.max(0.15, Math.min(0.85, layout.splitRatio))
  // 외피의 splitter (4px) + 활성 pane outline (2px) 영역을 빼고 webContentsView 배치
  const inset = PANE_OUTLINE
  if (layout.split === 'h') {
    const usable = Math.max(0, base.width - SPLITTER_THICKNESS)
    const first = Math.floor(usable * ratio)
    if (idx === 0) {
      return {
        x: base.x + inset, y: base.y + inset,
        width: Math.max(0, first - inset * 2),
        height: Math.max(0, base.height - inset * 2),
      }
    }
    return {
      x: base.x + first + SPLITTER_THICKNESS + inset, y: base.y + inset,
      width: Math.max(0, usable - first - inset * 2),
      height: Math.max(0, base.height - inset * 2),
    }
  } else {
    const usable = Math.max(0, base.height - SPLITTER_THICKNESS)
    const first = Math.floor(usable * ratio)
    if (idx === 0) {
      return {
        x: base.x + inset, y: base.y + inset,
        width: Math.max(0, base.width - inset * 2),
        height: Math.max(0, first - inset * 2),
      }
    }
    return {
      x: base.x + inset, y: base.y + first + SPLITTER_THICKNESS + inset,
      width: Math.max(0, base.width - inset * 2),
      height: Math.max(0, usable - first - inset * 2),
    }
  }
}

function reapplyLayout(windowId: string): void {
  const ctx = getWindow(windowId)
  if (!ctx) return
  const wsId = effectiveActiveWs(windowId)
  const layout = getLayout(windowId, wsId)
  const visibleTabIds = new Set<string>()
  layout.panes.forEach((p, idx) => {
    if (!p.tabId) return
    const tab = tabs.get(p.tabId)
    if (!tab) return
    if (tab.workspaceId !== wsId) return
    // 슬립(discarded)된 탭이 pane 에 배치되면 webContents 가 about:blank 라 빈 화면이 보인다.
    // 보이게 만들기 전에 원본 URL/히스토리로 깨운다. (닫기·분할·워크스페이스 전환 경로 모두 커버)
    if (tab.discarded) undiscardTab(tab.id)
    tab.view.setBounds(paneBoundsOf(ctx, idx, layout))
    tab.view.setVisible(true)
    visibleTabIds.add(p.tabId)
  })
  for (const t of tabs.values()) {
    if (t.windowId !== windowId) continue
    if (!visibleTabIds.has(t.id)) t.view.setVisible(false)
  }
  ctx.chrome.webContents.send(IPC.windows.layoutChanged, {
    windowId,
    split: layout.split,
    splitRatio: layout.splitRatio,
    activePaneIdx: layout.activePaneIdx,
    panes: layout.panes.map((p) => ({ tabId: p.tabId })),
  })
}

export const tabEvents = new EventEmitter()

function emitTabUpdate(tab: TabRecord): void {
  const ctx = getWindow(tab.windowId)
  if (!ctx) return
  ctx.chrome.webContents.send(IPC.tabs.update, summary(tab))
  tabEvents.emit('update', summary(tab))
}

function emitTabList(windowId: string): void {
  const ctx = getWindow(windowId)
  if (!ctx) return
  ctx.chrome.webContents.send(IPC.tabs.listChanged, { windowId, tabs: listTabs(windowId) })
  tabEvents.emit('list', windowId)
}

/**
 * `view.webContents` 가 지금 실제로 쓸 수 있는 상태인지. WebContentsView 의 타입은 항상
 * WebContents 지만, 실제로는 close({waitForBeforeUnload:true}) 로 파괴되는 도중 —
 * **'destroyed' 이벤트를 우리보다 먼저 등록한 다른 리스너(예: 확장 어댑터)가 실행되는 바로 그
 * 찰나** — undefined 를 돌려줄 수 있다(2026-09-28 실측: did-fail-load 직후 재현, tabs.list
 * 전체가 죽었다). 그 찰나에도 이 탭은 아직 `tabs` 맵에 남아 있으므로, 순회하는 모든 함수가
 * 이 상태를 견뎌야 한다.
 */
function wcAlive(wc: Electron.WebContents | undefined | null): wc is Electron.WebContents {
  if (!wc) return false
  try { return !wc.isDestroyed() } catch { return false }
}

function summary(tab: TabRecord): TabSummary {
  const wc = tab.view.webContents
  const alive = wcAlive(wc)
  const activeInWorkspace = getLayout(tab.windowId, tab.workspaceId)
  // 슬립된 탭은 원본 URL/제목 노출 (외피가 사용자에게 원본 정보 보여줌)
  const url = tab.discarded
    ? (tab.discardedUrl ?? (alive ? wc.getURL() : ''))
    : (alive ? wc.getURL() : (tab.pendingUrl ?? ''))
  const title = tab.discarded
    ? (tab.discardedTitle || tab.discardedUrl || '잠자는 탭')
    : (alive ? (wc.getTitle() || wc.getURL() || '새 탭') : (url || '탭'))
  return {
    id: tab.id,
    windowId: tab.windowId,
    workspaceId: tab.workspaceId,
    url,
    title,
    favicon: getFavicon(url),
    pinned: tab.pinned,
    audible: alive ? wc.isCurrentlyAudible() : false,
    muted: alive ? wc.isAudioMuted() : false,
    loading: (tab.discarded || !alive) ? false : wc.isLoading(),
    canGoBack: alive ? wc.navigationHistory.canGoBack() : false,
    canGoForward: alive ? wc.navigationHistory.canGoForward() : false,
    groupId: tab.groupId,
    active: getActivePane(activeInWorkspace).tabId === tab.id,
    index: tab.index,
    discarded: tab.discarded,
  }
}

function bindWindowResize(ctx: BrowserWindowContext): void {
  if (resizeBound.has(ctx)) return
  resizeBound.add(ctx)
  onWindowResize(ctx, () => reapplyLayout(ctx.id))
  // 안전망 — HTML5 전체화면이 leave-html-full-screen 없이 종료되는 경로(OS 단축키 등)에서도
  // insets/가시성이 계속 "전체화면 중" 상태로 남지 않도록.
  ctx.win.on('leave-full-screen', () => {
    if (fullscreenByWindow.has(ctx.id)) leaveTabFullscreen(ctx.id)
  })
}

setShellInsetsHook((windowId) => reapplyLayout(windowId))

// origin+pathname 만 비교(SPA 라우팅 경로 변경 감지용) — hash(#section) 만 바뀌면 동일 취급
function keyOf(u: string): string {
  try { const p = new URL(u); return p.origin + p.pathname } catch { return u }
}

function bindWebContentsEvents(tab: TabRecord): void {
  const wc = tab.view.webContents
  let lastInPageKey = ''
  wc.on('page-title-updated', (_e, title) => {
    emitTabUpdate(tab)
    for (const hook of onTitleHooks) {
      try { hook({ id: tab.id, url: wc.getURL(), title }) } catch (err) { console.warn('[tabs] title hook error', err) }
    }
  })
  wc.on('page-favicon-updated', (_e, favicons) => {
    const favicon = favicons[0]
    recordFavicon(wc.getURL(), favicon)
    const ctx = getWindow(tab.windowId)
    if (!ctx) return
    ctx.chrome.webContents.send(IPC.tabs.update, { ...summary(tab), favicon })
  })
  wc.on('did-start-loading', () => emitTabUpdate(tab))
  wc.on('did-stop-loading', () => emitTabUpdate(tab))
  wc.on('did-navigate', () => {
    emitTabUpdate(tab)
    // 전체 내비게이션 — 다음 in-page 내비게이션 비교 기준을 리셋(후보 정리는 onTabNavigated 가 담당)
    lastInPageKey = keyOf(wc.getURL())
    for (const hook of onNavigateHooks) {
      try { hook({ id: tab.id, url: wc.getURL(), title: wc.getTitle() }) } catch (err) { console.warn('[tabs] navigate hook error', err) }
    }
  })
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    emitTabUpdate(tab)
    // SPA(pushState) 경로 변경 시에만 발화 — hash 만 바뀐 경우(pathname 동일)는 무시
    if (!isMainFrame) return
    const key = keyOf(url)
    if (key === lastInPageKey) return
    lastInPageKey = key
    for (const hook of onInPageNavHooks) {
      try { hook({ id: tab.id, url }) } catch (err) { console.warn('[tabs] in-page navigate hook error', err) }
    }
  })
  wc.on('audio-state-changed', () => emitTabUpdate(tab))

  wc.on('enter-html-full-screen', () => enterTabFullscreen(tab))
  wc.on('leave-html-full-screen', () => leaveTabFullscreen(tab.windowId))

  trackPageErrors(wc, {
    onUnresponsive: () => {
      const ctx = getWindow(tab.windowId)
      ctx?.chrome.webContents.send('toast:show', { message: '페이지가 응답하지 않습니다…', ts: Date.now() })
    },
  })
}

/** HTML5 전체화면 진입 — 그 탭의 view 를 창 전체로 키우고 외피·다른 탭을 가린다. */
function enterTabFullscreen(tab: TabRecord): void {
  const ctx = getWindow(tab.windowId)
  if (!ctx) return
  if (fullscreenByWindow.has(tab.windowId)) return // 이미 전체화면 중(중복 진입 무시)
  fullscreenByWindow.set(tab.windowId, { insets: { ...ctx.insets }, tabId: tab.id })
  try { ctx.win.setFullScreen(true) } catch (err) { console.warn('[tabs] setFullScreen(true) 실패', err) }
  ctx.insets = { top: 0, right: 0, bottom: 0, left: 0 }
  const { width, height } = getChromeSize(ctx)
  tab.view.setBounds({ x: 0, y: 0, width, height })
  tab.view.setVisible(true)
  // 같은 창의 다른 탭(분할된 pane 포함)은 전체화면 중 잠시 숨김 — leaveTabFullscreen 에서 reapplyLayout 이 복원
  for (const t of tabs.values()) {
    if (t.windowId === tab.windowId && t.id !== tab.id) t.view.setVisible(false)
  }
  // Electron 은 `//chrome` 브라우저 UI 계층이 없어(이 앱이 그 역할) Esc 로 HTML 전체화면을
  // 자동으로 빠져나가지 않는다 — 페이지 자신의 keydown 리스너로 직접 처리한다(document.exitFullscreen()
  // 이 호출되면 우리가 이미 구독 중인 leave-html-full-screen 이 정상적으로 뒤따라온다).
  void tab.view.webContents.executeJavaScript(`(function(){
    if (window.__bbFsEscBound) return;
    window.__bbFsEscBound = true;
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.fullscreenElement) {
        document.exitFullscreen().catch(function () {});
      }
    }, true);
  })()`).catch(() => { /* 주입 실패는 무시 — OS/브라우저 자체 처리에 맡긴다 */ })
}

/** HTML5 전체화면 종료 — insets 복원 + reapplyLayout 으로 분할·가시성을 정상 상태로 되돌린다. */
function leaveTabFullscreen(windowId: string): void {
  const saved = fullscreenByWindow.get(windowId)
  if (!saved) return
  fullscreenByWindow.delete(windowId)
  const ctx = getWindow(windowId)
  if (!ctx) return
  try { ctx.win.setFullScreen(false) } catch (err) { console.warn('[tabs] setFullScreen(false) 실패', err) }
  ctx.insets = saved.insets
  reapplyLayout(windowId)
}

type NavigateHook = (info: { id: string; url: string; title: string }) => void
const onNavigateHooks: NavigateHook[] = []
export function onTabNavigated(cb: NavigateHook): void { onNavigateHooks.push(cb) }

type TitleHook = (info: { id: string; url: string; title: string }) => void
const onTitleHooks: TitleHook[] = []
export function onTabTitleUpdated(cb: TitleHook): void { onTitleHooks.push(cb) }

// SPA(pushState) 경로 변경 전용 경량 hook — recordVisit 등 무거운 부작용은 없음(영상 후보 정리 등)
type InPageNavHook = (info: { id: string; url: string }) => void
const onInPageNavHooks: InPageNavHook[] = []
export function onTabInPageNavigated(cb: InPageNavHook): void { onInPageNavHooks.push(cb) }

// ===== 팝업(window.open) — OAuth 로그인·PG 결제·본인인증처럼 window.opener·postMessage 가 필요한 창 =====
// 크기 지정이 있는(=명시적으로 작은 팝업을 요구하는) window.open 만 실제 자식 BrowserWindow 로 허용한다.
// 일반 target=_blank(크기 지정 없음)는 기존대로 새 탭으로 — Chrome 의 기본 동작과 같다.
const POPUP_OK_SCHEMES = new Set(['', 'about:', 'http:', 'https:', 'data:', 'blob:'])

function parsePopupFeatures(features: string): { width?: number; height?: number } {
  const out: { width?: number; height?: number } = {}
  for (const part of (features || '').split(/[,;]/)) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    const val = Number(part.slice(eq + 1).trim())
    if (!Number.isFinite(val) || val <= 0) continue
    if (key === 'width' || key === 'innerwidth') out.width = Math.round(val)
    if (key === 'height' || key === 'innerheight') out.height = Math.round(val)
  }
  return out
}

function shouldAllowPopupWindow(details: Electron.HandlerDetails): boolean {
  if (details.disposition === 'new-window') return true
  const feats = parsePopupFeatures(details.features)
  return feats.width !== undefined || feats.height !== undefined
}

function buildPopupWindowOptions(
  details: Electron.HandlerDetails, partition: string,
): Electron.BrowserWindowConstructorOptions | null {
  let scheme = ''
  try { scheme = new URL(details.url).protocol } catch { scheme = '' }
  if (!POPUP_OK_SCHEMES.has(scheme)) return null
  const { width, height } = parsePopupFeatures(details.features)
  return {
    width: width ?? 480,
    height: height ?? 640,
    title: '',
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // 부모 탭과 같은 세션 — 로그인 쿠키·adblock·policy·권한 정책이 그대로 이어진다.
      partition,
    },
  }
}

export function createTab(opts: {
  windowId: string
  url?: string
  background?: boolean
  partition?: string
  workspaceId?: string
  // 세션 복원용: 즉시 로드 대신 슬립 상태(메타만)로 생성 — 클릭 시 lazy load
  restoreDiscarded?: boolean
  restoreTitle?: string
  // 세션 복원용: 내비게이션 히스토리(뒤로/앞으로 + 스크롤/폼) 재생
  restoreHistory?: NavigationEntrySnap[]
  restoreHistoryIndex?: number
  // 세션 복원용: 소속 탭 그룹
  groupId?: string
  /** 세션 복원 전용: 종료 전 그 탭이 쓰던 안정 키를 그대로 물려준다(없으면 새로 발급). */
  restoreKey?: string
}): TabSummary {
  const ctx = getWindow(opts.windowId)
  if (!ctx) throw new Error(`window ${opts.windowId} not found`)

  bindWindowResize(ctx)

  counter += 1
  const id = `tab-${counter}`
  const restoreKey = (typeof opts.restoreKey === 'string' && opts.restoreKey.trim())
    ? opts.restoreKey.trim().slice(0, 100)
    : `tk-${randomUUID()}`
  const initialUrl = opts.url ?? NEW_TAB_URL
  const preloadName = initialUrl.startsWith('browser:') ? 'internal.js' : 'content.js'
  // 시크릿 창은 전역 워크스페이스와 무관한 고정 워크스페이스에 속한다 — 메인 창 워크스페이스 전환/삭제에
  // 시크릿 탭이 휩쓸리지 않게 한다(listTabs/레이아웃/가시성이 effectiveActiveWs 로 이 고정 ws 를 쓴다).
  const workspaceId = ctx.incognito ? incognitoWs(opts.windowId) : (opts.workspaceId ?? getActiveWorkspaceId())
  // 시크릿 창은 워크스페이스 partition 대신 그 창의 in-memory incognito partition 강제 —
  // 워크스페이스 기능 자체는 시크릿 창에서 비활성(항상 같은 incognito 세션으로 고정).
  const partition = (ctx.incognito && ctx.incognitoPartition)
    ? ctx.incognitoPartition
    : (opts.partition ?? (workspaceId ? getActivePartition() : DEFAULT_SESSION))
  // 새 partition 이라면 browser:// 프로토콜 + 권한 + policy webRequest 가 미설치 — 즉시 install (idempotent).
  // incognito partition 도 이 경로를 반드시 지나가므로(위 override), 회귀 #11/#12 계열(OS "browser 링크"
  // 다이얼로그)이 시크릿 창에서도 재발하지 않는다.
  setupSessionByPartition(partition)
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../../preload/', preloadName),
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
  })

  ctx.win.contentView.addChildView(view)
  view.setBounds(getTabBounds(ctx))

  view.webContents.setWindowOpenHandler((details) => {
    if (shouldAllowPopupWindow(details)) {
      const popupOptions = buildPopupWindowOptions(details, partition)
      if (popupOptions) return { action: 'allow', overrideBrowserWindowOptions: popupOptions }
    }
    routeWindowOpen(opts.windowId, details.url, { sourceTabId: id })
    return { action: 'deny' }
  })
  // action:'allow' 로 실제 자식 창이 만들어지면 여기로 통지된다 — 오류 페이지 처리만 최소로 붙인다
  // (adblock·policy·권한은 partition 이 같은 세션이라 session-bootstrap 이 이미 커버한다).
  view.webContents.on('did-create-window', (childWindow) => {
    try { trackPageErrors(childWindow.webContents) } catch (err) { console.warn('[tabs] popup trackPageErrors 실패', err) }
  })

  const existingInWorkspace = listAllTabsInWindow(opts.windowId).filter((t) => t.workspaceId === workspaceId)
  const index = existingInWorkspace.length

  const tab: TabRecord = {
    id, restoreKey, windowId: opts.windowId, workspaceId, view,
    partition,
    pinned: false, index,
    createdAt: Date.now(), lastActiveAt: Date.now(), discarded: false,
    // 커밋 전 공백 구간에도 세션 스냅샷이 이 탭을 놓치지 않도록 요청한 URL 을 들고 있는다.
    pendingUrl: initialUrl,
  }
  if (opts.groupId && groups.has(opts.groupId)) tab.groupId = opts.groupId
  tabs.set(id, tab)

  bindWebContentsEvents(tab)
  for (const hook of onTabCreatedHooks) {
    try { hook({ id, webContentsId: view.webContents.id }) } catch (err) { console.warn('[tabs] hook error', err) }
  }

  const canDiscard = opts.restoreDiscarded === true && /^https?:/i.test(initialUrl)
  if (canDiscard) {
    // 세션 복원 시 즉시 로드하지 않고 슬립 상태로 — 외피는 원본 URL/제목을 보여주고, 클릭 시 lazy load
    tab.discarded = true
    tab.discardedUrl = initialUrl
    tab.discardedTitle = opts.restoreTitle || initialUrl
    if (opts.restoreHistory && opts.restoreHistory.length > 0) {
      tab.discardedHistory = opts.restoreHistory
      tab.discardedIndex = opts.restoreHistoryIndex
      // ⚠ 여기서 about:blank 를 **커밋하지 않는다**. 갓 만든 WebContentsView 는 이미 빈 문서라
      //   메모리상 차이가 없는데, about:blank 를 한 번 커밋해 버리면 나중에 깨울 때
      //   `navigationHistory.restore()` 가 **성공은 하지만 pageState(스크롤·폼)가 적용되지 않는다**
      //   (2026-09-15 실측: 복원 실패 로그 없이 scrollY=0·폼 빈 값. Electron 35·42 동일).
      //   히스토리가 없는 경우에만 예전처럼 비워 둔다.
    } else {
      void view.webContents.loadURL('about:blank')
    }
  } else if (opts.restoreHistory && opts.restoreHistory.length > 0) {
    // 즉시 로드 대상 복원 탭: 히스토리 재생(뒤로/앞으로 + 스크롤/폼 복원)
    restoreNavigation(view.webContents, opts.restoreHistory, opts.restoreHistoryIndex)
  } else {
    void view.webContents.loadURL(initialUrl)
  }

  // 이 탭이 active workspace 가 아니면 항상 invisible
  const isActiveWorkspace = workspaceId === effectiveActiveWs(opts.windowId)
  const hadActive = isActiveWorkspace && getActiveTabId(opts.windowId) !== null

  if (isActiveWorkspace && (!opts.background || !hadActive) && !canDiscard) {
    activateTabInternal(tab)
  } else {
    view.setVisible(false)
  }
  emitTabList(opts.windowId)
  return summary(tab)
}

function activateTabInternal(tab: TabRecord): void {
  // 슬립된 탭이면 복원 (about:blank → 히스토리 재생 또는 원본 URL)
  if (tab.discarded && tab.discardedUrl) {
    const url = tab.discardedUrl
    const history = tab.discardedHistory
    const idx = tab.discardedIndex
    tab.discarded = false
    tab.discardedUrl = undefined
    tab.discardedTitle = undefined
    tab.discardedHistory = undefined
    tab.discardedIndex = undefined
    if (history && history.length > 0) restoreNavigation(tab.view.webContents, history, idx)
    else void tab.view.webContents.loadURL(url)
  }
  // 워크스페이스의 layout 만 변경 (활성 workspace 가 아니면 visible 변화는 후행 전환 시 반영)
  const layout = getLayout(tab.windowId, tab.workspaceId)
  // 이 탭이 이미 다른 pane 에 표시 중이면, 활성 pane 의 tabId 를 덮어써서 같은 탭이 두 pane 에
  // 중복(→ 한 pane 이 빈 화면)되는 것을 막고, 대신 그 pane 을 활성 pane 으로 만든다.
  const existingPane = paneIndexOfTab(layout, tab.id)
  if (existingPane >= 0) {
    layout.activePaneIdx = existingPane
  } else {
    getActivePane(layout).tabId = tab.id
  }
  tab.lastActiveAt = Date.now()
  if (tab.workspaceId === effectiveActiveWs(tab.windowId)) {
    reapplyLayout(tab.windowId)
  }
  emitTabList(tab.windowId)
  for (const cb of onTabActivatedHooks) { try { cb(tab.id) } catch { /* 훅 하나가 활성화를 막지 않도록 */ } }
}

export function activateTab(tabId: string): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  activateTabInternal(tab)
}

// closeTab() 은 사용자에게 보이는 순간부터 완결처럼 느껴지지만, beforeunload 확인이 끼면 실제 정리는
// 비동기(사용자가 다이얼로그에 응답한 뒤)로 미뤄진다. 같은 탭에 중복으로 closeTab 이 들어와도(더블클릭 등)
// 다이얼로그가 두 번 뜨지 않도록 진행 중인 탭 id 를 추적한다.
const closingTabs = new Set<string>()

interface ClosedTabInfo { url: string; title: string }

/** webContents 가 아직 살아 있을 때(=닫기 시작 시점) URL/제목을 미리 캡처. destroy 후엔 접근할 수 없다. */
function captureClosedInfo(tab: TabRecord): ClosedTabInfo {
  const wc = tab.view.webContents
  try {
    const url = tab.discarded ? (tab.discardedUrl ?? wc.getURL()) : wc.getURL()
    const title = tab.discarded ? (tab.discardedTitle ?? url) : (wc.getTitle() || url)
    return { url, title }
  } catch {
    return { url: tab.discardedUrl ?? '', title: tab.discardedTitle ?? '' }
  }
}

/**
 * beforeunload 를 물어본다. 페이지에 unload 를 막으려는 핸들러가 없으면(대다수) 즉시 true 로 끝난다.
 * 있으면 네이티브 확인 다이얼로그를 띄우고, "머무르기" 를 고르면 false(탭 유지) — Chrome 과 동일한 흐름.
 */
function confirmBeforeUnload(tab: TabRecord): Promise<boolean> {
  return new Promise((resolve) => {
    const wc = tab.view.webContents
    let settled = false

    const onDestroyed = (): void => {
      if (settled) return
      settled = true
      wc.removeListener('will-prevent-unload', onPrevent)
      resolve(true)
    }
    // 비동기 다이얼로그를 쓴다 — showMessageBoxSync 는 메인 JS 스레드를 통째로 멈춰
    // 다른 창·탭·IPC·자동화까지 전부 얼렸다(탭 하나의 확인 창이 브라우저 전체를 세운다).
    // 흐름: preventDefault 를 하지 않으면 이번 닫기는 취소되고 탭이 그대로 남는다 →
    // 사용자가 "나가기" 를 고르면 beforeunload 없이 다시 닫는다(close() 기본값은 즉시 파괴).
    const onPrevent = (): void => {
      wc.removeListener('will-prevent-unload', onPrevent)
      const ctx = getWindow(tab.windowId)
      const boxOptions: Electron.MessageBoxOptions = {
        type: 'question',
        buttons: [
          tMain('main.tabs.beforeUnload.stay', '머무르기'),
          tMain('main.tabs.beforeUnload.leave', '나가기'),
        ],
        defaultId: 0,
        cancelId: 0,
        title: tMain('main.tabs.beforeUnload.title', '사이트에서 나가시겠습니까?'),
        message: tMain('main.tabs.beforeUnload.message', '변경한 내용이 저장되지 않을 수 있습니다.'),
      }
      const shown = ctx ? dialog.showMessageBox(ctx.win, boxOptions) : dialog.showMessageBox(boxOptions)
      shown.then(({ response }) => response === 1, (err) => {
        console.warn('[tabs] beforeunload 확인 다이얼로그 실패 — 나가기로 처리', err)
        return true
      }).then((leave) => {
        if (settled) return
        if (!leave || wc.isDestroyed()) {
          wc.removeListener('destroyed', onDestroyed)
          settled = true
          resolve(leave)
          return
        }
        try {
          wc.close() // beforeunload 를 다시 묻지 않고 파괴 → onDestroyed 가 resolve(true)
        } catch (err) {
          console.warn('[tabs] webContents.close 실패 — 닫힌 것으로 처리', err)
          wc.removeListener('destroyed', onDestroyed)
          settled = true
          resolve(true)
        }
      })
    }

    wc.once('destroyed', onDestroyed)
    wc.on('will-prevent-unload', onPrevent)
    try {
      wc.close({ waitForBeforeUnload: true })
    } catch (err) {
      console.warn('[tabs] webContents.close 실패 — 강제로 닫힌 것으로 처리', err)
      wc.removeListener('will-prevent-unload', onPrevent)
      wc.removeListener('destroyed', onDestroyed)
      if (!settled) { settled = true; resolve(true) }
    }
  })
}

export function closeTab(tabId: string): void {
  void closeTabAsync(tabId)
}

async function closeTabAsync(tabId: string): Promise<void> {
  const tab = tabs.get(tabId)
  if (!tab) return
  if (closingTabs.has(tabId)) return
  closingTabs.add(tabId)
  try {
    const wc = tab.view.webContents
    const closedInfo = captureClosedInfo(tab) // webContents 가 살아있는 지금 캡처
    if (wc.isDestroyed()) {
      finishCloseTab(tab, closedInfo)
      return
    }
    if (tab.discarded) {
      // 슬립(about:blank) 탭엔 beforeunload 를 물을 이유가 없다 — 바로 닫는다.
      try { wc.close() } catch { /* ignore */ }
      finishCloseTab(tab, closedInfo)
      return
    }
    const proceed = await confirmBeforeUnload(tab)
    if (!proceed) return // "머무르기" 선택 — 탭을 그대로 둔다(정리 로직 실행 안 함)
    finishCloseTab(tab, closedInfo)
  } finally {
    closingTabs.delete(tabId)
  }
}

function finishCloseTab(tab: TabRecord, closedInfo: ClosedTabInfo): void {
  const tabId = tab.id
  // 이 탭이 전체화면 중이었다면 창을 정상 상태로 되돌려 두고 닫는다(안 그러면 insets 가 0 인 채로 남는다).
  if (fullscreenByWindow.get(tab.windowId)?.tabId === tabId) leaveTabFullscreen(tab.windowId)
  const ctx = getWindow(tab.windowId)
  if (ctx) { try { ctx.win.contentView.removeChildView(tab.view) } catch { /* ignore */ } }
  const closedUrl = closedInfo.url
  const closedTitle = closedInfo.title
  // 시크릿 탭은 "최근 닫은 탭" 스택에도 남기지 않는다 — 다른(비시크릿) 탭에서 Ctrl+Shift+T 로 복원되면 안 됨.
  if (!tab.partition.startsWith('incognito')
    && /^https?:|^browser:/i.test(closedUrl) && !/^browser:\/\/newtab/i.test(closedUrl)) {
    closedCounter += 1
    closedStack.push({
      id: closedCounter, url: closedUrl, title: closedTitle, windowId: tab.windowId,
      index: tab.index, workspaceId: tab.workspaceId, groupId: tab.groupId, closedAt: Date.now(),
    })
    if (closedStack.length > 50) closedStack.shift()
  }
  const closedGroupId = tab.groupId
  tabs.delete(tabId)
  for (const hook of onTabClosedHooks) {
    try { hook(tabId) } catch (err) { console.warn('[tabs] close hook error', err) }
  }
  // 그룹의 마지막 탭이 닫혔으면 빈 그룹 정리
  if (closedGroupId) {
    pruneEmptyGroups(tab.windowId)
    if (!groups.has(closedGroupId)) emitGroups(tab.windowId)
  }
  // 닫힌 탭이 어느 pane 에 보였다면 그 pane 을 동일 워크스페이스 다른 탭으로 채우거나 단일화
  const layout = getLayout(tab.windowId, tab.workspaceId)
  const paneIdx = paneIndexOfTab(layout, tabId)
  if (paneIdx >= 0) {
    const otherTabs = listAllTabsInWindow(tab.windowId)
      .filter((t) => t.workspaceId === tab.workspaceId)
      .filter((t) => !layout.panes.some((p) => p.tabId === t.id))
      .map(summary)
    if (otherTabs.length > 0) {
      const next = otherTabs[Math.min(tab.index, otherTabs.length - 1)] ?? otherTabs[0]
      layout.panes[paneIdx]!.tabId = next ? next.id : null
    } else {
      // 다른 탭 없음 → 분할 모드라면 단일화, 단일이면 빈 pane
      if (layout.panes.length > 1) {
        const keepIdx = paneIdx === 0 ? 1 : 0
        const keep = layout.panes[keepIdx]
        layoutByWindow.set(layoutKey(tab.windowId, tab.workspaceId), {
          panes: [keep ?? { tabId: null }],
          split: null,
          activePaneIdx: 0,
          splitRatio: 0.5,
        })
      } else {
        layout.panes[0]!.tabId = null
      }
    }
  }
  reindex(tab.windowId, tab.workspaceId)
  if (tab.workspaceId === effectiveActiveWs(tab.windowId)) reapplyLayout(tab.windowId)
  emitTabList(tab.windowId)
}

// ===== 분할 화면 (panes) =====

export function splitWindow(windowId: string, dir: SplitDirection): void {
  const wsId = effectiveActiveWs(windowId)
  const layout = getLayout(windowId, wsId)
  if (layout.panes.length >= 2) {
    if (layout.split !== dir) {
      layout.split = dir
      reapplyLayout(windowId)
    }
    return
  }
  const currentActive = getActiveTabId(windowId)
  const otherTabs = listTabs(windowId).filter((t) => t.id !== currentActive)
  let secondTabId: string
  if (otherTabs.length > 0) {
    secondTabId = (otherTabs[otherTabs.length - 1] ?? otherTabs[0])!.id
  } else {
    const newTab = createTab({ windowId, url: NEW_TAB_URL, background: true, workspaceId: wsId })
    secondTabId = newTab.id
  }
  layout.panes.push({ tabId: secondTabId })
  layout.split = dir
  layout.activePaneIdx = 0
  layout.splitRatio = 0.5
  reapplyLayout(windowId)
  emitTabList(windowId)
}

export function unsplitWindow(windowId: string): void {
  const wsId = effectiveActiveWs(windowId)
  const layout = getLayout(windowId, wsId)
  if (layout.panes.length < 2) return
  const keep = layout.panes[layout.activePaneIdx] ?? layout.panes[0]
  layoutByWindow.set(layoutKey(windowId, wsId), {
    panes: [keep ?? { tabId: null }],
    split: null,
    activePaneIdx: 0,
    splitRatio: 0.5,
  })
  reapplyLayout(windowId)
  emitTabList(windowId)
}

export function focusNextPane(windowId: string): void {
  const layout = getLayout(windowId)
  if (layout.panes.length < 2) return
  layout.activePaneIdx = (layout.activePaneIdx + 1) % layout.panes.length
  emitTabList(windowId)
  reapplyLayout(windowId)
}

export function focusPaneByIndex(windowId: string, idx: number): void {
  const layout = getLayout(windowId)
  if (idx < 0 || idx >= layout.panes.length) return
  if (layout.activePaneIdx === idx) return
  layout.activePaneIdx = idx
  emitTabList(windowId)
  reapplyLayout(windowId)
}

export function setPaneSplitRatio(windowId: string, ratio: number): void {
  const layout = getLayout(windowId)
  if (layout.panes.length < 2 || layout.split === null) return
  const clamped = Math.max(0.15, Math.min(0.85, ratio))
  if (Math.abs(layout.splitRatio - clamped) < 0.001) return
  layout.splitRatio = clamped
  reapplyLayout(windowId)
}

export function beginPaneDrag(windowId: string): void {
  // drag 동안 chrome view 를 가장 위로 올려 마우스 이벤트를 외피가 받게 한다.
  // 탭 view 가 가운데 영역에 있어도, 외피의 splitter 가 마우스 capture 가능해야 ratio 변경.
  bringChromeToFront(windowId)
}

export function endPaneDrag(windowId: string): void {
  // 모든 탭 view 를 z-order 의 가장 위로 다시 올리고 chrome 은 그 아래로.
  // contentView 의 child 목록을 재구성: chrome 먼저, 그 다음 모든 windowId 의 탭 view
  const ctx = getWindow(windowId)
  if (!ctx) return
  const windowTabs = Array.from(tabs.values()).filter((t) => t.windowId === windowId)
  try {
    // 모든 view 제거 후 다시 add — chrome 먼저, 탭 view 들 다음 (위)
    ctx.win.contentView.removeChildView(ctx.chrome)
    for (const t of windowTabs) ctx.win.contentView.removeChildView(t.view)
    ctx.win.contentView.addChildView(ctx.chrome)
    for (const t of windowTabs) ctx.win.contentView.addChildView(t.view)
  } catch (err) {
    console.warn('[tabs] endPaneDrag reorder failed', err)
  }
  reapplyLayout(windowId)
}

export function getWindowLayout(windowId: string): {
  split: SplitDirection | null
  paneCount: number
  activePaneIdx: number
  panes: Array<{ tabId: string | null }>
} {
  const l = getLayout(windowId)
  return {
    split: l.split,
    paneCount: l.panes.length,
    activePaneIdx: l.activePaneIdx,
    panes: l.panes.map((p) => ({ tabId: p.tabId })),
  }
}

function detachFromLayout(tab: TabRecord, wsId: string): void {
  const layout = getLayout(tab.windowId, wsId)
  const paneIdx = paneIndexOfTab(layout, tab.id)
  if (paneIdx < 0) return
  const others = listAllTabsInWindow(tab.windowId)
    .filter((t) => t.workspaceId === wsId && t.id !== tab.id)
    .filter((t) => !layout.panes.some((p) => p.tabId === t.id))
  if (others.length > 0) {
    const next = others[Math.min(tab.index, others.length - 1)] ?? others[0]
    layout.panes[paneIdx]!.tabId = next ? next.id : null
  } else if (layout.panes.length > 1) {
    const keepIdx = paneIdx === 0 ? 1 : 0
    const keep = layout.panes[keepIdx]
    layoutByWindow.set(layoutKey(tab.windowId, wsId), {
      panes: [keep ?? { tabId: null }],
      split: null,
      activePaneIdx: 0,
      splitRatio: 0.5,
    })
  } else {
    layout.panes[0]!.tabId = null
  }
}

export interface MoveTabResult {
  moved: boolean
  needsReload: boolean
  newTabId?: string
  reason?: 'same-workspace' | 'tab-not-found' | 'target-not-found'
}

export function moveTabToWorkspace(tabId: string, targetWorkspaceId: string): MoveTabResult {
  const tab = tabs.get(tabId)
  if (!tab) return { moved: false, needsReload: false, reason: 'tab-not-found' }
  if (tab.workspaceId === targetWorkspaceId) {
    return { moved: false, needsReload: false, reason: 'same-workspace' }
  }
  const target = getWorkspace(targetWorkspaceId)
  if (!target) return { moved: false, needsReload: false, reason: 'target-not-found' }

  const oldWsId = tab.workspaceId
  const activeWsId = getActiveWorkspaceId()

  if (tab.partition === target.partition) {
    detachFromLayout(tab, oldWsId)
    tab.workspaceId = targetWorkspaceId
    tab.index = listAllTabsInWindow(tab.windowId)
      .filter((t) => t.workspaceId === targetWorkspaceId && t.id !== tabId).length
    if (targetWorkspaceId === activeWsId) {
      const layout = getLayout(tab.windowId, targetWorkspaceId)
      getActivePane(layout).tabId = tabId
    } else {
      tab.view.setVisible(false)
    }
    reindex(tab.windowId, oldWsId)
    reindex(tab.windowId, targetWorkspaceId)
    if (oldWsId === activeWsId || targetWorkspaceId === activeWsId) reapplyLayout(tab.windowId)
    emitTabList(tab.windowId)
    return { moved: true, needsReload: false }
  }

  // 잠자는(discarded) 탭은 webContents 가 about:blank 이므로 보존된 원본 URL 을 쓴다.
  const url = tab.discarded && tab.discardedUrl ? tab.discardedUrl : tab.view.webContents.getURL()
  const pinned = tab.pinned
  const newTab = createTab({
    windowId: tab.windowId,
    url,
    workspaceId: targetWorkspaceId,
    background: targetWorkspaceId !== activeWsId,
  })
  if (pinned) pinTab(newTab.id, true)
  closeTab(tabId)
  return { moved: true, needsReload: true, newTabId: newTab.id }
}

export function restoreLastClosed(windowId: string): TabSummary | null {
  const wsId = effectiveActiveWs(windowId)
  // 활성 워크스페이스의 가장 최근 닫힌 탭 우선 — 없으면 어느 ws 든 가장 최근
  let idx = -1
  for (let i = closedStack.length - 1; i >= 0; i -= 1) {
    if (closedStack[i]?.workspaceId === wsId) { idx = i; break }
  }
  if (idx < 0) idx = closedStack.length - 1
  if (idx < 0) return null
  const [last] = closedStack.splice(idx, 1)
  if (!last) return null
  // 활성 워크스페이스에 복원 → 항상 보이게. (다른 ws 로 복원하면 숨은 채 생겨 사용자가 반복 클릭 →
  // 숨은 중복 탭이 쌓인다.) 활성 ws 에 원래 항목이 있으면 last.workspaceId===wsId 라 동일.
  return createTab({ windowId, url: last.url, workspaceId: wsId })
}

export interface RecentlyClosedEntry { id: number; url: string; title: string; closedAt: number }

/** 최근 닫은 탭 목록 (최신 우선). */
export function listRecentlyClosed(limit = 30): RecentlyClosedEntry[] {
  const out: RecentlyClosedEntry[] = []
  for (let i = closedStack.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const e = closedStack[i]
    if (e) out.push({ id: e.id, url: e.url, title: e.title, closedAt: e.closedAt })
  }
  return out
}

/** 특정 닫은 탭을 다시 열기 (스택에서 제거). */
export function reopenClosedById(id: number, windowId: string): TabSummary | null {
  const idx = closedStack.findIndex((e) => e.id === id)
  if (idx < 0) return null
  const [e] = closedStack.splice(idx, 1)
  if (!e) return null
  // restoreLastClosed 와 동일하게 활성 워크스페이스에 복원 → 항상 보이게(원래 ws 가 비활성이면 숨은 탭이
  // 생겨 목록에서 클릭이 무반응처럼 보인다). groupId 는 활성 ws 와 같을 때만 유지.
  const wsId = effectiveActiveWs(windowId)
  const keepGroup = e.workspaceId === wsId ? e.groupId : undefined
  return createTab({ windowId, url: e.url, workspaceId: wsId, groupId: keepGroup })
}

export function clearRecentlyClosed(): void {
  closedStack.length = 0
}

export function listTabs(windowId: string): TabSummary[] {
  const wsId = effectiveActiveWs(windowId)
  return Array.from(tabs.values())
    .filter((t) => t.windowId === windowId && t.workspaceId === wsId)
    .sort((a, b) => a.index - b.index)
    .map(summary)
}

function listAllTabsInWindow(windowId: string): TabRecord[] {
  return Array.from(tabs.values()).filter((t) => t.windowId === windowId)
}

export function listTabsInWorkspace(windowId: string, workspaceId: string): TabSummary[] {
  return Array.from(tabs.values())
    .filter((t) => t.windowId === windowId && t.workspaceId === workspaceId)
    .sort((a, b) => a.index - b.index)
    .map(summary)
}

export function getTab(tabId: string): TabSummary | null {
  const t = tabs.get(tabId)
  return t ? summary(t) : null
}

export function getAllTabs(): TabSummary[] {
  return Array.from(tabs.values()).map(summary)
}

/** 이 탭의 복원 안정 키. 탭이 없으면 null. */
export function getTabRestoreKey(tabId: string): string | null {
  return tabs.get(tabId)?.restoreKey ?? null
}

/**
 * 안정 키로 지금 살아 있는 탭을 찾는다 — **복원을 건너 같은 탭을 가리키는 유일한 방법**이다.
 * 못 찾으면 null 을 돌려줄 뿐, 비슷한 탭을 대신 찾아 주지 않는다(그 추측이 바로 사고의 원인이었다).
 */
export function findTabByRestoreKey(key: string): { id: string; windowId: string; workspaceId: string } | null {
  if (!key) return null
  for (const t of tabs.values()) {
    if (t.restoreKey !== key) continue
    if (t.view.webContents.isDestroyed()) return null
    return { id: t.id, windowId: t.windowId, workspaceId: t.workspaceId }
  }
  return null
}

export function getWebContentsByTabId(tabId: string): Electron.WebContents | null {
  return tabs.get(tabId)?.view.webContents ?? null
}

/** 탭이 사용하는 세션 파티션 문자열(쿠키·이어받기 세션 복원용). */
export function getTabPartition(tabId: string): string | undefined {
  return tabs.get(tabId)?.partition
}

export function findTabIdByWebContentsId(wcId: number): { tabId: string; windowId: string } | null {
  for (const t of tabs.values()) {
    if (!wcAlive(t.view.webContents)) continue
    if (t.view.webContents.id === wcId) {
      return { tabId: t.id, windowId: t.windowId }
    }
  }
  return null
}

export function pinTab(tabId: string, pinned: boolean): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  tab.pinned = pinned
  // 탭이 속한 워크스페이스를 재정렬해야 한다 — 인자 없으면 활성 ws 가 기본이라
  // 세션 복원 중 비활성 ws 의 핀 탭을 정렬 못 하고 활성 ws 만 헛되이 재정렬한다.
  reindex(tab.windowId, tab.workspaceId)
  emitTabList(tab.windowId)
}

export function reorderTabs(windowId: string, orderedIds: string[]): void {
  orderedIds.forEach((id, i) => {
    const t = tabs.get(id)
    if (t && t.windowId === windowId) t.index = i
  })
  reindex(windowId, effectiveActiveWs(windowId))
  emitTabList(windowId)
}

function reindex(windowId: string, workspaceId?: string): void {
  const wsId = workspaceId ?? effectiveActiveWs(windowId)
  const list = Array.from(tabs.values()).filter((t) => t.windowId === windowId && t.workspaceId === wsId)
  // 그룹 멤버는 인접하게 클러스터링 — 그룹의 rank = 멤버 중 최소 index, 그 위치에 모임
  const groupMin = new Map<string, number>()
  for (const t of list) {
    if (!t.groupId) continue
    const cur = groupMin.get(t.groupId)
    if (cur === undefined || t.index < cur) groupMin.set(t.groupId, t.index)
  }
  const rankOf = (t: TabRecord): number => (t.groupId != null ? (groupMin.get(t.groupId) ?? t.index) : t.index)
  list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const ra = rankOf(a)
    const rb = rankOf(b)
    if (ra !== rb) return ra - rb
    return a.index - b.index
  })
  list.forEach((t, i) => { t.index = i })
}

// ===== 그룹 CRUD =====
function emitGroups(windowId: string): void {
  const ctx = getWindow(windowId)
  if (!ctx) return
  ctx.chrome.webContents.send(IPC.groups.changed, { windowId, groups: listGroups(windowId) })
}

export function listGroups(windowId: string): TabGroup[] {
  return Array.from(groups.values()).filter((g) => g.windowId === windowId)
}

export function createGroup(
  windowId: string,
  opts?: { title?: string; color?: TabGroupColor; tabIds?: string[] },
): TabGroup | null {
  const ctx = getWindow(windowId)
  if (!ctx) return null
  groupCounter += 1
  const id = `group-${groupCounter}`
  const color = validGroupColor(opts?.color) ?? GROUP_COLORS[groupCounter % GROUP_COLORS.length]!
  const title = typeof opts?.title === 'string' && opts.title ? opts.title : '새 그룹'
  const group: TabGroup = { id, windowId, title, color, collapsed: false }
  groups.set(id, group)
  let wsForReindex: string | undefined
  if (opts?.tabIds) {
    for (const tid of opts.tabIds) {
      const t = tabs.get(tid)
      if (t && t.windowId === windowId) { t.groupId = id; wsForReindex = t.workspaceId }
    }
  }
  reindex(windowId, wsForReindex)
  emitGroups(windowId)
  emitTabList(windowId)
  return group
}

export function updateGroup(groupId: string, patch: { title?: string; color?: TabGroupColor }): void {
  const g = groups.get(groupId)
  if (!g) return
  if (typeof patch.title === 'string') g.title = patch.title
  const color = validGroupColor(patch.color)
  if (color) g.color = color
  emitGroups(g.windowId)
  emitTabList(g.windowId)
}

export function setGroupCollapsed(groupId: string, collapsed: boolean): void {
  const g = groups.get(groupId)
  if (!g) return
  g.collapsed = collapsed
  emitGroups(g.windowId)
  emitTabList(g.windowId)
}

export function removeGroup(groupId: string): void {
  const g = groups.get(groupId)
  if (!g) return
  const wid = g.windowId
  for (const t of tabs.values()) if (t.groupId === groupId) t.groupId = undefined
  groups.delete(groupId)
  reindex(wid)
  emitGroups(wid)
  emitTabList(wid)
}

export function assignTabToGroup(tabId: string, groupId: string | null): void {
  const t = tabs.get(tabId)
  if (!t) return
  if (groupId && !groups.has(groupId)) return
  t.groupId = groupId ?? undefined
  reindex(t.windowId, t.workspaceId)
  pruneEmptyGroups(t.windowId)
  emitGroups(t.windowId)
  emitTabList(t.windowId)
}

function pruneEmptyGroups(windowId: string): void {
  const used = new Set<string>()
  for (const t of tabs.values()) if (t.windowId === windowId && t.groupId) used.add(t.groupId)
  for (const g of Array.from(groups.values())) {
    if (g.windowId === windowId && !used.has(g.id)) groups.delete(g.id)
  }
}

export function navigateTab(tabId: string, url: string): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  void tab.view.webContents.loadURL(url)
}

export function setTabMuted(tabId: string, muted: boolean): void {
  const tab = tabs.get(tabId)
  if (!tab) return
  tab.view.webContents.setAudioMuted(muted)
  emitTabUpdate(tab)
}

export function tabBack(tabId: string): void {
  const wc = tabs.get(tabId)?.view.webContents
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
}

export function tabForward(tabId: string): void {
  const wc = tabs.get(tabId)?.view.webContents
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
}

export function tabReload(tabId: string): void {
  tabs.get(tabId)?.view.webContents.reload()
}

export function tabStop(tabId: string): void {
  tabs.get(tabId)?.view.webContents.stop()
}

export function duplicateTab(tabId: string): TabSummary | null {
  const t = tabs.get(tabId)
  if (!t) return null
  // 잠자는 탭은 about:blank 이므로 보존된 원본 URL 로 복제.
  const url = t.discarded && t.discardedUrl ? t.discardedUrl : t.view.webContents.getURL()
  return createTab({ windowId: t.windowId, url })
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * capturePage() 는 그 탭이 방금 보이게 됐거나(compositor 프레임이 아직 준비되지 않음) 다른 창에
 * 가려진(occluded) 직후엔 "Current display surface not available for capture" 로 실패할 수 있다
 * (2026-09-28 실측, 전형적으로 일시적) — 짧게 두어 번 재시도한다.
 */
async function capturePageWithRetry(wc: Electron.WebContents, attempts = 3): Promise<Electron.NativeImage | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await wc.capturePage()
    } catch (err) {
      if (i === attempts - 1) { console.warn('[tabs] capturePage 실패(재시도 소진)', err); return null }
      await sleepMs(150 * (i + 1))
    }
  }
  return null
}

export async function captureTab(tabId: string): Promise<string | null> {
  const tab = tabs.get(tabId)
  if (!tab) return null
  // 잠든(discarded) 탭은 실제로 about:blank 라 지금 찍어봐야 빈 화면이다 — 슬립 직전에 남겨둔
  // "마지막 모습" 썸네일을 대신 돌려준다(없으면 아직 한 번도 잠든 적 없는 세션 복원 탭 등 — null).
  if (tab.discarded) return tab.discardedThumbnail ?? null
  const wc = tab.view.webContents
  if (!wcAlive(wc)) return null
  const img = await capturePageWithRetry(wc)
  return img ? thumbnailDataUrl(img) : null
}

// ===== 백그라운드 탭 슬립 =====

export interface SleepTabSnapshot {
  id: string
  url: string
  title: string
  pinned: boolean
  lastActiveAt: number
  discarded: boolean
}

export function getAllTabRecordsForSleep(): SleepTabSnapshot[] {
  return Array.from(tabs.values()).filter((t) => wcAlive(t.view.webContents)).map((t) => ({
    id: t.id,
    url: t.view.webContents.getURL(),
    title: t.view.webContents.getTitle(),
    pinned: t.pinned,
    lastActiveAt: t.lastActiveAt,
    discarded: t.discarded,
  }))
}

export function isPinnedTab(tabId: string): boolean {
  return tabs.get(tabId)?.pinned ?? false
}

export function isTabActive(tabId: string): boolean {
  for (const l of layoutByWindow.values()) {
    if (l.panes.some((p) => p.tabId === tabId)) return true
  }
  return false
}

export function discardTab(tabId: string): boolean {
  const tab = tabs.get(tabId)
  if (!tab || tab.discarded) return false
  if (isTabActive(tabId)) return false
  const wc = tab.view.webContents
  const url = wc.getURL()
  if (!url || /^browser:|^about:/i.test(url)) return false
  tab.discardedUrl = url
  tab.discardedTitle = wc.getTitle() || url
  // 슬립 전 히스토리(뒤로/앞으로 + 스크롤/폼) 보존 — 깨울 때 그대로 복원
  const hist = captureHistory(wc)
  if (hist) { tab.discardedHistory = hist.entries; tab.discardedIndex = hist.index }
  tab.discarded = true
  emitTabUpdate(tab)
  // 언로드(about:blank) 전에 화면을 찍어 TabBar 미리보기에 "마지막 모습"을 남긴다.
  // 순서가 중요하다 — capturePage() 보다 loadURL 이 먼저 끝나면 about:blank 가 찍힌다.
  capturePageWithRetry(wc)
    .then((img) => {
      const t = tabs.get(tabId)
      if (t && img) t.discardedThumbnail = thumbnailDataUrl(img) ?? undefined
    })
    .catch((err) => console.warn('[tabs] 슬립 썸네일 캡처 실패', err))
    .finally(() => {
      if (!wc.isDestroyed()) void wc.loadURL('about:blank')
    })
  return true
}

export function undiscardTab(tabId: string): boolean {
  const tab = tabs.get(tabId)
  if (!tab || !tab.discarded) return false
  const url = tab.discardedUrl
  const history = tab.discardedHistory
  const idx = tab.discardedIndex
  tab.discarded = false
  tab.discardedUrl = undefined
  tab.discardedTitle = undefined
  tab.discardedHistory = undefined
  tab.discardedIndex = undefined
  tab.discardedThumbnail = undefined
  if (history && history.length > 0) restoreNavigation(tab.view.webContents, history, idx)
  else if (url) void tab.view.webContents.loadURL(url)
  emitTabUpdate(tab)
  return true
}

export function getDiscardedCount(): number {
  let n = 0
  for (const t of tabs.values()) if (t.discarded) n += 1
  return n
}

export function getTotalTabCount(): number {
  return tabs.size
}

// ===== 세션 스냅샷 (저장/복원용) =====

export interface SessionTabSnap {
  /**
   * 복원을 넘어 유지되는 탭 정체성(`TabRecord.restoreKey`). 옛 스냅샷에는 없다 — 그때는
   * 복원된 탭이 새 키를 받고, 그 탭에 매여 있던 작업은 추측하지 않고 사용자에게 대상을 묻는다.
   */
  restoreKey?: string
  url: string
  title: string
  pinned: boolean
  workspaceId: string
  active: boolean
  index: number
  // 내비게이션 히스토리(뒤로/앞으로 + 스크롤/폼) — 정확 복원용. 없으면 url 단독 복원.
  history?: NavigationEntrySnap[]
  historyIndex?: number
  groupId?: string
}

export interface SessionWindowSnap {
  windowId: string
  /** 복원을 넘어 유지되는 창 정체성(`BrowserWindowContext.restoreKey`). 옛 스냅샷에는 없다. */
  restoreKey?: string
  // 디스크에서 읽은 스냅샷은 손상돼 있을 수 있다 — 검증을 통과하지 못한 bounds 는 빠진 채로 들어온다.
  bounds?: Electron.Rectangle
  activeTabId: string | null
  tabs: SessionTabSnap[]
  // 워크스페이스별 분할 화면 레이아웃 (없으면 단일 pane)
  layouts?: WorkspaceLayoutSnap[]
  // 탭 그룹 (색상·이름·접힘)
  groups?: TabGroup[]
}

/** 현재 열린 창·탭을 세션 스냅샷으로 수집. 시크릿(incognito) 파티션과 빈 탭은 제외. */
export function collectSession(): SessionWindowSnap[] {
  const byWindow = new Map<string, SessionWindowSnap>()
  for (const t of tabs.values()) {
    if (!wcAlive(t.view.webContents)) continue
    if (t.partition.startsWith('incognito')) continue
    const wc = t.view.webContents
    // 아직 커밋되지 않은 탭은 getURL() 이 비어 있다 — 요청한 URL 로 메워 새 탭이 스냅샷에서 빠지지 않게 한다.
    const url = t.discarded ? (t.discardedUrl ?? '') : (wc.getURL() || t.pendingUrl || '')
    if (!url || /^about:blank$/i.test(url)) continue
    if (!/^https?:|^browser:/i.test(url)) continue
    let snap = byWindow.get(t.windowId)
    if (!snap) {
      const ctx = getWindow(t.windowId)
      if (!ctx) continue
      snap = {
        windowId: t.windowId,
        restoreKey: ctx.restoreKey,
        bounds: ctx.win.getBounds(),
        activeTabId: getActiveTabId(t.windowId),
        tabs: [],
      }
      byWindow.set(t.windowId, snap)
    }
    const title = t.discarded
      ? (t.discardedTitle || url)
      : (wc.getTitle() || url)
    // 히스토리: 깨어있으면 라이브 캡처, 슬립 중이면 보존해 둔 것 사용
    let history: NavigationEntrySnap[] | undefined
    let historyIndex: number | undefined
    if (t.discarded) {
      if (t.discardedHistory && t.discardedHistory.length > 0) {
        history = t.discardedHistory
        historyIndex = t.discardedIndex
      }
    } else {
      const cap = captureHistory(wc)
      if (cap) { history = cap.entries; historyIndex = cap.index }
    }
    snap.tabs.push({
      restoreKey: t.restoreKey,
      url,
      title,
      pinned: t.pinned,
      workspaceId: t.workspaceId,
      active: getActivePane(getLayout(t.windowId, t.workspaceId)).tabId === t.id,
      index: t.index,
      history,
      historyIndex,
      groupId: t.groupId,
    })
  }
  // 인덱스 정렬 + 분할 레이아웃 + 그룹 수집
  for (const snap of byWindow.values()) {
    snap.tabs.sort((a, b) => a.index - b.index)
    const layouts = collectLayouts(snap.windowId)
    if (layouts.length > 0) snap.layouts = layouts
    // 스냅샷에 포함된 탭이 실제로 속한 그룹만 저장
    const usedGroupIds = new Set<string>()
    for (const t of snap.tabs) if (t.groupId) usedGroupIds.add(t.groupId)
    const wGroups = listGroups(snap.windowId).filter((g) => usedGroupIds.has(g.id))
    if (wGroups.length > 0) snap.groups = wGroups
  }
  return Array.from(byWindow.values()).filter((w) => w.tabs.length > 0)
}

/** 세션 복원 시 그룹을 원래 id 로 재등록(탭 groupId 와 매칭). groupCounter 충돌 방지로 카운터 보정. */
export function registerRestoredGroups(windowId: string, restored: TabGroup[]): void {
  for (const g of restored) {
    groups.set(g.id, { id: g.id, windowId, title: g.title, color: g.color, collapsed: !!g.collapsed })
    const m = /^group-(\d+)$/.exec(g.id)
    if (m) groupCounter = Math.max(groupCounter, Number(m[1]))
  }
}

// ===== 분할 화면(split pane) 레이아웃 스냅샷 =====
// 탭 id 는 복원 시 새로 발급되므로 pane 을 워크스페이스 내 index 로 참조 → 복원 후 재매핑.
export interface PaneSnap { tabIndex: number | null }
export interface WorkspaceLayoutSnap {
  workspaceId: string
  split: SplitDirection
  splitRatio: number
  activePaneIdx: number
  panes: PaneSnap[]
}

function splitKeyWindow(key: string): { windowId: string; workspaceId: string } | null {
  const i = key.indexOf('::')
  if (i < 0) return null
  return { windowId: key.slice(0, i), workspaceId: key.slice(i + 2) }
}

/** 한 창의 워크스페이스별 분할 레이아웃 수집 (단일 pane 은 복원할 게 없으므로 제외). */
export function collectLayouts(windowId: string): WorkspaceLayoutSnap[] {
  const out: WorkspaceLayoutSnap[] = []
  for (const [key, layout] of layoutByWindow) {
    const parsed = splitKeyWindow(key)
    if (!parsed || parsed.windowId !== windowId) continue
    if (!layout.split || layout.panes.length < 2) continue
    const panes: PaneSnap[] = layout.panes.map((p) => {
      if (!p.tabId) return { tabIndex: null }
      const t = tabs.get(p.tabId)
      return { tabIndex: t ? t.index : null }
    })
    // 최소 하나의 pane 에 탭이 있어야 의미 있음
    if (!panes.some((p) => p.tabIndex != null)) continue
    out.push({
      workspaceId: parsed.workspaceId,
      split: layout.split,
      splitRatio: layout.splitRatio,
      activePaneIdx: layout.activePaneIdx,
      panes,
    })
  }
  return out
}

/** 저장된 분할 레이아웃을 복원. resolve(workspaceId, tabIndex) → 새 tabId 로 pane 을 재매핑. */
export function restoreWorkspaceLayout(
  windowId: string,
  snap: WorkspaceLayoutSnap,
  resolve: (workspaceId: string, tabIndex: number) => string | null,
): void {
  if (!snap.split || !Array.isArray(snap.panes) || snap.panes.length < 2) return
  const panes: Pane[] = snap.panes.map((p) => ({
    tabId: p.tabIndex == null ? null : resolve(snap.workspaceId, p.tabIndex),
  }))
  // pane0 에 탭이 없으면(매핑 실패) 복원 의미 없음 — 건너뜀
  if (!panes[0]?.tabId) return
  layoutByWindow.set(layoutKey(windowId, snap.workspaceId), {
    panes,
    split: snap.split,
    activePaneIdx: Math.min(Math.max(0, snap.activePaneIdx), panes.length - 1),
    splitRatio: Math.max(0.15, Math.min(0.85, snap.splitRatio || 0.5)),
  })
  if (snap.workspaceId === getActiveWorkspaceId()) reapplyLayout(windowId)
}

// 창이 닫히면 그 창의 탭·레이아웃·그룹을 정리 — webContents 는 이미 파괴됐을 수 있으므로
// closeTab() 을 쓰지 않고 직접 정리한다.
windowEvents.on('closed', (ctx: BrowserWindowContext) => {
  const doomed = Array.from(tabs.values()).filter((t) => t.windowId === ctx.id)
  for (const t of doomed) {
    try { if (!t.view.webContents.isDestroyed()) t.view.webContents.close() } catch { /* ignore */ }
    tabs.delete(t.id)
    for (const hook of onTabClosedHooks) {
      try { hook(t.id) } catch (err) { console.warn('[tabs] close hook error', err) }
    }
  }
  for (const key of Array.from(layoutByWindow.keys())) {
    if (key.startsWith(`${ctx.id}::`)) layoutByWindow.delete(key)
  }
  for (const g of Array.from(groups.values())) {
    if (g.windowId === ctx.id) groups.delete(g.id)
  }
  if (doomed.length > 0) tabEvents.emit('list', ctx.id)
})

app.on('window-all-closed', () => {
  tabs.clear()
  layoutByWindow.clear()
})

// ===== 워크스페이스 전환 ↔ 탭 view 가시성 =====
workspaceEvents.on('activated', ({ id }: { id: string; prev: string }) => {
  const windowIds = new Set<string>()
  for (const t of tabs.values()) windowIds.add(t.windowId)
  for (const wid of windowIds) {
    const ctx = getWindow(wid)
    if (!ctx) continue
    if (ctx.incognito) continue // 시크릿 창은 고정 세션 — 전역 워크스페이스 전환에 영향받지 않음(탭 숨김·홈탭 자동생성 금지)
    // 새 active workspace 의 첫 탭이 없으면 home 탭 자동 생성 (homeUrl 우선)
    const tabsInNewWs = listTabsInWorkspace(wid, id)
    if (tabsInNewWs.length === 0) {
      const ws = getWorkspace(id)
      const homeUrl = (ws?.homeUrl && ws.homeUrl.trim()) ? ws.homeUrl.trim() : NEW_TAB_URL
      createTab({ windowId: wid, url: homeUrl, workspaceId: id })
      continue
    }
    // 활성 탭이 layout 에 없으면 첫 탭 활성화
    const layout = getLayout(wid, id)
    if (!layout.panes[0]?.tabId || !tabs.has(layout.panes[0]!.tabId!)) {
      const firstTab = tabsInNewWs[0]
      if (firstTab) layout.panes[0]!.tabId = firstTab.id
    }
    reapplyLayout(wid)
    emitTabList(wid)
  }
})

workspaceEvents.on('removed', ({ id }: { id: string }) => {
  // 제거된 workspace 의 모든 탭 close (단, 시크릿 창 탭은 워크스페이스 소속과 무관하므로 제외 — 워크스페이스
  // 삭제가 열려 있는 시크릿 창의 탭을 통째로 닫아버리지 않도록.)
  const toClose = Array.from(tabs.values())
    .filter((t) => t.workspaceId === id && !getWindow(t.windowId)?.incognito)
    .map((t) => t.id)
  for (const tabId of toClose) closeTab(tabId)
  // layout 키 cleanup
  for (const key of Array.from(layoutByWindow.keys())) {
    if (key.endsWith(`::${id}`)) layoutByWindow.delete(key)
  }
})
