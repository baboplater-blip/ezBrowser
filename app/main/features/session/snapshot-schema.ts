/**
 * 디스크에서 읽은 세션 스냅샷의 모양 검증 — 순수 로직(파일·electron 없음)이라 단독으로 시험할 수 있다.
 *
 * 원칙: **항목 하나가 이상하다고 멀쩡한 탭까지 버리지 않는다.**
 * 예전에는 복원 루프가 탭 항목을 그대로 믿었고(`url.startsWith(...)`), url 이 문자열이 아닌 항목
 * 하나가 그 창의 **뒤따르는 탭 전부**를 날릴 수 있었다.
 *
 * 타입 import 만 쓰므로 컴파일된 산출물에는 electron 의존이 남지 않는다(노드로 바로 시험 가능).
 */
import type { SessionWindowSnap, SessionTabSnap, NavigationEntrySnap } from '../../tabs/tab-service'

/** collectSession 이 저장할 때 쓰는 것과 같은 규칙 — 여기서 넓히면 복원이 이상한 스킴을 연다. */
export const RESTORABLE_URL = /^https?:|^browser:/i

export interface SanitizedSnapshot {
  savedAt: number
  windows: SessionWindowSnap[]
  /** 버려진 탭·창 수 — 조용히 넘어가지 않고 로그로 드러내기 위한 값. */
  droppedTabs: number
  droppedWindows: number
}

export type SnapshotShapeResult =
  | { ok: true; snapshot: SanitizedSnapshot }
  /** corrupt: 읽을 수 없는 파일 — 증거로 보존해야 한다. */
  | { ok: false; corrupt: true; reason: string }
  /** corrupt=false: 손상이 아니라 그냥 쓸 수 없는 것(스키마 버전 차이 등) — 격리하지 않는다. */
  | { ok: false; corrupt: false; reason: string }

function sanitizeTab(raw: unknown, fallbackIndex: number): SessionTabSnap | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  const url = typeof t.url === 'string' ? t.url : ''
  if (!url || !RESTORABLE_URL.test(url)) return null
  const index = typeof t.index === 'number' && Number.isFinite(t.index) ? t.index : fallbackIndex
  const rawHistory = Array.isArray(t.history)
    ? (t.history.filter((e) => !!e && typeof e === 'object'
      && typeof (e as { url?: unknown }).url === 'string') as NavigationEntrySnap[])
    : []
  const history = rawHistory.length > 0 ? rawHistory : undefined
  const historyIndex = history && typeof t.historyIndex === 'number' && Number.isFinite(t.historyIndex)
    ? t.historyIndex
    : undefined
  return {
    // 복원 안정 키 — 없으면(옛 스냅샷) undefined 로 두고 복원이 새 키를 발급한다.
    restoreKey: typeof t.restoreKey === 'string' && t.restoreKey ? t.restoreKey : undefined,
    url,
    title: typeof t.title === 'string' && t.title ? t.title : url,
    pinned: t.pinned === true,
    workspaceId: typeof t.workspaceId === 'string' ? t.workspaceId : '',
    active: t.active === true,
    index,
    history,
    historyIndex,
    groupId: typeof t.groupId === 'string' ? t.groupId : undefined,
  }
}

function sanitizeBounds(raw: unknown): Electron.Rectangle | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const b = raw as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const x = num(b.x); const y = num(b.y); const width = num(b.width); const height = num(b.height)
  if (x === null || y === null || width === null || height === null) return undefined
  if (width <= 0 || height <= 0) return undefined
  return { x, y, width, height }
}

function sanitizeWindow(raw: unknown): { window: SessionWindowSnap | null; droppedTabs: number } {
  if (!raw || typeof raw !== 'object') return { window: null, droppedTabs: 0 }
  const w = raw as Record<string, unknown>
  const rawTabs = Array.isArray(w.tabs) ? w.tabs : []
  const tabs: SessionTabSnap[] = []
  let droppedTabs = 0
  rawTabs.forEach((t, i) => {
    const ok = sanitizeTab(t, i)
    if (ok) tabs.push(ok)
    else droppedTabs += 1
  })
  // 복원할 탭이 하나도 없는 창은 만들지 않는다 (빈 껍데기 창 방지).
  if (tabs.length === 0) return { window: null, droppedTabs }
  return {
    window: {
      windowId: typeof w.windowId === 'string' ? w.windowId : '',
      restoreKey: typeof w.restoreKey === 'string' && w.restoreKey ? w.restoreKey : undefined,
      bounds: sanitizeBounds(w.bounds),
      activeTabId: typeof w.activeTabId === 'string' ? w.activeTabId : null,
      tabs,
      layouts: Array.isArray(w.layouts) ? (w.layouts as SessionWindowSnap['layouts']) : undefined,
      groups: Array.isArray(w.groups) ? (w.groups as SessionWindowSnap['groups']) : undefined,
    },
    droppedTabs,
  }
}

/**
 * 파싱된 JSON 값을 복원 가능한 스냅샷으로 좁힌다. 절대 예외를 던지지 않는다.
 * `expectedVersion` 과 다르면 손상이 아니라 "쓸 수 없음" 으로 돌려준다(격리 금지).
 */
export function sanitizeSnapshotShape(parsed: unknown, expectedVersion: number): SnapshotShapeResult {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, corrupt: true, reason: '최상위가 객체가 아님' }
  }
  const snap = parsed as Record<string, unknown>
  if (snap.version !== expectedVersion) {
    return { ok: false, corrupt: false, reason: `스키마 버전 불일치(${String(snap.version)})` }
  }
  if (!Array.isArray(snap.windows)) {
    return { ok: false, corrupt: true, reason: 'windows 가 배열이 아님' }
  }
  const windows: SessionWindowSnap[] = []
  let droppedTabs = 0
  let droppedWindows = 0
  for (const rawWindow of snap.windows) {
    const res = sanitizeWindow(rawWindow)
    droppedTabs += res.droppedTabs
    if (res.window) windows.push(res.window)
    else droppedWindows += 1
  }
  const savedAt = typeof snap.savedAt === 'number' && Number.isFinite(snap.savedAt) ? snap.savedAt : 0
  return { ok: true, snapshot: { savedAt, windows, droppedTabs, droppedWindows } }
}
