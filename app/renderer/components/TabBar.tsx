import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TabSummary, TabGroup, TabGroupColor } from '../../shared/types'
import faviconFallback from '../assets/favicon-fallback.png'
import { useChromeOverlay } from '../hooks/useChromeOverlay'

export type TabBarOrientation = 'top' | 'left' | 'right' | 'bottom'

interface Props {
  windowId: string
  tabs: TabSummary[]
  orientation?: TabBarOrientation
}

interface PreviewState {
  tabId: string
  dataUrl: string | null
  loading: boolean
  rect: DOMRect
}

interface MenuState {
  kind: 'tab' | 'group'
  id: string
  x: number
  y: number
}

const PREVIEW_DELAY_MS = 500
const PREVIEW_CLOSE_DELAY_MS = 160
const PREVIEW_CACHE_MS = 6_000
const previewCache = new Map<string, { ts: number; dataUrl: string | null }>()

const GROUP_COLORS: TabGroupColor[] = ['blue', 'red', 'green', 'yellow', 'purple', 'pink', 'orange', 'gray']
const GROUP_HEX: Record<TabGroupColor, string> = {
  red: '#E5484D', orange: '#F76808', yellow: '#FFB224', green: '#30A46C',
  blue: '#3478F6', purple: '#8E4EC6', pink: '#E93D82', gray: '#8E8E93',
}
const GROUP_COLOR_LABEL: Record<TabGroupColor, string> = {
  red: '빨강', orange: '주황', yellow: '노랑', green: '초록',
  blue: '파랑', purple: '보라', pink: '분홍', gray: '회색',
}

export function TabBar({ windowId, tabs, orientation = 'top' }: Props) {
  const vertical = orientation === 'left' || orientation === 'right'
  const [dragId, setDragId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [groups, setGroups] = useState<TabGroup[]>([])
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 탭 컨텍스트 메뉴·호버 미리보기 카드는 fixed 오버레이라 콘텐츠 탭 view 아래에 깔리면
  // 완전히 가려진다 — 열려 있는 동안 chrome 을 승격한다.
  useChromeOverlay(windowId, menu !== null)
  useChromeOverlay(windowId, preview !== null)

  // 그룹 로드 + 변경 구독
  useEffect(() => {
    let alive = true
    void window.browserAPI.groups.list(windowId).then((g) => { if (alive) setGroups(g) }).catch(() => {})
    const off = window.browserAPI.groups.onChanged((payload) => {
      if (payload.windowId === windowId) setGroups(payload.groups)
    })
    return () => { alive = false; off() }
  }, [windowId])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => { window.removeEventListener('click', close); window.removeEventListener('blur', close) }
  }, [menu])

  // 지연 닫기(호버 브리지) — 탭에서 카드로 마우스를 옮길 때 카드가 사라지지 않게 한다.
  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null }
  }, [])

  const cancelPreview = useCallback(() => {
    if (previewTimerRef.current) { clearTimeout(previewTimerRef.current); previewTimerRef.current = null }
    clearCloseTimer()
    closeTimerRef.current = setTimeout(() => { setPreview(null); closeTimerRef.current = null }, PREVIEW_CLOSE_DELAY_MS)
  }, [clearCloseTimer])

  // 즉시 닫기(드래그·비활성 탭 등) — 지연 없이 제거.
  const cancelPreviewNow = useCallback(() => {
    if (previewTimerRef.current) { clearTimeout(previewTimerRef.current); previewTimerRef.current = null }
    clearCloseTimer()
    setPreview(null)
  }, [clearCloseTimer])

  // 카드 위로 마우스가 올라오면 예정된 닫기를 취소.
  const keepPreview = useCallback(() => { clearCloseTimer() }, [clearCloseTimer])

  const schedulePreview = useCallback((tab: TabSummary, target: HTMLElement) => {
    if (tab.active || tab.discarded || dragId) {
      cancelPreviewNow()
      return
    }
    clearCloseTimer() // 다른 탭으로 이동 시 예정된 닫기 취소(새 미리보기 유지)
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    const rect = target.getBoundingClientRect()
    previewTimerRef.current = setTimeout(() => {
      const cached = previewCache.get(tab.id)
      const now = Date.now()
      if (cached && (now - cached.ts) < PREVIEW_CACHE_MS) {
        setPreview({ tabId: tab.id, dataUrl: cached.dataUrl, loading: false, rect })
        return
      }
      setPreview({ tabId: tab.id, dataUrl: null, loading: true, rect })
      void window.browserAPI.tabs.capture(tab.id).then((dataUrl) => {
        previewCache.set(tab.id, { ts: Date.now(), dataUrl: dataUrl ?? null })
        setPreview((cur) => cur && cur.tabId === tab.id
          ? { ...cur, dataUrl: dataUrl ?? null, loading: false }
          : cur)
      }).catch(() => {
        setPreview((cur) => cur && cur.tabId === tab.id
          ? { ...cur, dataUrl: null, loading: false }
          : cur)
      })
    }, PREVIEW_DELAY_MS)
  }, [cancelPreviewNow, clearCloseTimer, dragId])

  useEffect(() => () => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
  }, [])

  const ordered = useMemo(() => [...tabs].sort((a, b) => a.index - b.index), [tabs])
  const groupsById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  const groupCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of ordered) if (t.groupId) m.set(t.groupId, (m.get(t.groupId) ?? 0) + 1)
    return m
  }, [ordered])

  // 그룹 헤더 + 탭을 순서대로 펼친 렌더 항목 (접힌 그룹의 비활성 탭은 숨김)
  type RenderItem = { kind: 'header'; group: TabGroup } | { kind: 'tab'; tab: TabSummary; group: TabGroup | null }
  const items = useMemo<RenderItem[]>(() => {
    const out: RenderItem[] = []
    let prev: string | null = null
    for (const t of ordered) {
      const gid = t.groupId && groupsById.has(t.groupId) ? t.groupId : null
      const g = gid ? groupsById.get(gid)! : null
      if (gid && gid !== prev) out.push({ kind: 'header', group: g! })
      prev = gid
      if (g && g.collapsed && !t.active) continue
      out.push({ kind: 'tab', tab: t, group: g })
    }
    return out
  }, [ordered, groupsById])

  const handleDragStart = useCallback((id: string, e: React.DragEvent) => {
    setDragId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-browserbuild-tab', id)
    e.dataTransfer.setData('text/plain', id)
  }, [])

  const handleDragOver = useCallback((id: string, e: React.DragEvent) => {
    e.preventDefault()
    if (id !== hoverId) setHoverId(id)
  }, [hoverId])

  const handleDrop = useCallback(async (targetId: string, e: React.DragEvent) => {
    e.preventDefault()
    if (!dragId || dragId === targetId) { setDragId(null); setHoverId(null); return }
    const ids = ordered.map((t) => t.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) { setDragId(null); setHoverId(null); return }
    ids.splice(from, 1)
    ids.splice(to, 0, dragId)
    await window.browserAPI.tabs.reorder(windowId, ids)
    setDragId(null); setHoverId(null)
  }, [dragId, ordered, windowId])

  const activate = useCallback((id: string) => window.browserAPI.tabs.activate(id), [])
  const clearSelection = useCallback(() => { setSelected(new Set()); setAnchorId(null) }, [])
  const closeTab = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await window.browserAPI.tabs.close(id)
  }, [])

  const onTabClick = useCallback((id: string, e: React.MouseEvent) => {
    if (e.shiftKey && anchorId) {
      // 범위 선택 — 현재 탭 순서 기준
      const ids = ordered.map((t) => t.id)
      const a = ids.indexOf(anchorId)
      const b = ids.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        const next = new Set(selected)
        for (let i = lo; i <= hi; i += 1) { const x = ids[i]; if (x) next.add(x) }
        setSelected(next)
      }
      return
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setSelected(next)
      setAnchorId(id)
      return
    }
    clearSelection()
    activate(id)
  }, [anchorId, ordered, selected, clearSelection, activate])

  const openTabMenu = useCallback((id: string, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    // 선택에 없는 탭을 우클릭하면 단일 대상으로 — 기존 선택 해제
    if (!selected.has(id)) clearSelection()
    setMenu({ kind: 'tab', id, x: e.clientX, y: e.clientY })
  }, [selected, clearSelection])
  const openGroupMenu = useCallback((id: string, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    setMenu({ kind: 'group', id, x: e.clientX, y: e.clientY })
  }, [])

  const toggleCollapse = useCallback((g: TabGroup) => {
    void window.browserAPI.groups.setCollapsed(g.id, !g.collapsed)
  }, [])

  const newTab = useCallback(() => window.browserAPI.tabs.create(windowId), [windowId])

  return (
    <div className={`tabbar tabbar-${orientation} ${vertical ? 'vertical' : 'horizontal'}`} role="tablist">
      {items.map((it, i) => {
        if (it.kind === 'header') {
          const g = it.group
          const hex = GROUP_HEX[g.color]
          return (
            <div
              key={`h-${g.id}`}
              className={`tab-group-header ${g.collapsed ? 'collapsed' : ''}`}
              style={{ ['--group-color' as string]: hex }}
              onClick={() => toggleCollapse(g)}
              onContextMenu={(e) => openGroupMenu(g.id, e)}
              title={`${g.title} — 클릭하면 ${g.collapsed ? '펼치기' : '접기'}, 우클릭 메뉴`}
            >
              <span className="tg-caret">{g.collapsed ? '▸' : '▾'}</span>
              <span className="tg-dot" style={{ background: hex }} />
              <span className="tg-title">{g.title}</span>
              <span className="tg-count">{groupCounts.get(g.id) ?? 0}</span>
            </div>
          )
        }
        const t = it.tab
        const hex = it.group ? GROUP_HEX[it.group.color] : undefined
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.active}
            className={`tab ${t.active ? 'active' : ''} ${t.pinned ? 'pinned' : ''} ${t.discarded ? 'discarded' : ''} ${hoverId === t.id ? 'drop-target' : ''} ${it.group ? 'grouped' : ''} ${selected.has(t.id) ? 'multi-selected' : ''}`}
            style={hex ? { ['--group-color' as string]: hex } : undefined}
            draggable
            onDragStart={(e) => { cancelPreviewNow(); handleDragStart(t.id, e) }}
            onDragOver={(e) => handleDragOver(t.id, e)}
            onDragLeave={() => setHoverId(null)}
            onDrop={(e) => handleDrop(t.id, e)}
            onDragEnd={() => { setDragId(null); setHoverId(null) }}
            onClick={(e) => onTabClick(t.id, e)}
            onContextMenu={(e) => openTabMenu(t.id, e)}
            onAuxClick={(e) => { if (e.button === 1) closeTab(t.id, e) }}
            onMouseEnter={(e) => schedulePreview(t, e.currentTarget)}
            onMouseLeave={cancelPreview}
            title={t.discarded ? `${t.url}\n(잠자는 탭 — 클릭하면 다시 로드)` : t.url}
          >
            {t.pinned && <span className="tab-pin" aria-hidden>📌</span>}
            {t.discarded && <span className="tab-sleep" aria-hidden title="잠자는 탭">💤</span>}
            {t.favicon && !t.discarded && <img className="tab-favicon" src={t.favicon} alt="" />}
            {!t.favicon && !t.discarded && t.loading && <span className="tab-spinner" aria-hidden />}
            {!t.favicon && !t.discarded && !t.loading && <img className="tab-favicon" src={faviconFallback} alt="" />}
            <span className="tab-title">{t.title || t.url || '새 탭'}</span>
            {(t.audible || t.muted) && (
              <button
                className="tab-audio"
                aria-label={t.muted ? '음소거 해제' : '음소거'}
                title={t.muted ? '음소거됨 — 클릭하여 해제' : '소리 재생 중 — 클릭하여 음소거'}
                onClick={(e) => { e.stopPropagation(); void window.browserAPI.tabs.setMuted(t.id, !t.muted) }}
              >{t.muted ? '🔇' : '🔊'}</button>
            )}
            {!t.pinned && (
              <button className="tab-close" aria-label="탭 닫기" onClick={(e) => closeTab(t.id, e)}>
                ×
              </button>
            )}
          </div>
        )
      })}
      <button className="tab-new" aria-label="새 탭" onClick={newTab}>+</button>
      {preview && (
        <TabPreviewPopover
          preview={preview}
          tab={ordered.find((t) => t.id === preview.tabId)}
          orientation={orientation}
          onMouseEnter={keepPreview}
          onMouseLeave={cancelPreview}
          onClosed={cancelPreviewNow}
        />
      )}
      {menu && (
        <TabContextMenu
          menu={menu}
          windowId={windowId}
          tabs={ordered}
          groups={groups}
          selected={selected}
          onClose={() => setMenu(null)}
          clearSelection={clearSelection}
        />
      )}
    </div>
  )
}

function TabContextMenu({ menu, windowId, tabs, groups, selected, onClose, clearSelection }: {
  menu: MenuState
  windowId: string
  tabs: TabSummary[]
  groups: TabGroup[]
  selected: Set<string>
  onClose: () => void
  clearSelection: () => void
}) {
  const style: React.CSSProperties = {
    top: Math.min(menu.y, window.innerHeight - 320),
    left: Math.min(menu.x, window.innerWidth - 220),
  }
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  // 다중 선택 + 우클릭한 탭이 선택에 포함 → 일괄 작업 메뉴
  if (menu.kind === 'tab' && selected.size >= 2 && selected.has(menu.id)) {
    const ids = tabs.filter((t) => selected.has(t.id)).map((t) => t.id)
    const sel = tabs.filter((t) => selected.has(t.id))
    const n = ids.length
    const after = () => { clearSelection(); onClose() }
    return (
      <div className="tab-ctx" style={style} onClick={stop}>
        <div className="tab-ctx-label">{n}개 탭 선택됨</div>
        <button className="tab-ctx-item" onClick={() => { void window.browserAPI.groups.create(windowId, { tabIds: ids }); after() }}>
          새 그룹으로 묶기
        </button>
        {groups.map((g) => (
          <button key={g.id} className="tab-ctx-item" onClick={() => { void Promise.all(ids.map((id) => window.browserAPI.groups.assignTab(id, g.id))); after() }}>
            <span className="tg-dot" style={{ background: GROUP_HEX[g.color] }} /> {g.title} 그룹으로
          </button>
        ))}
        <div className="tab-ctx-sep" />
        <button className="tab-ctx-item" onClick={() => { for (const t of sel) void window.browserAPI.bookmarks.add({ url: t.url, title: t.title || t.url }); after() }}>
          북마크에 추가
        </button>
        <button className="tab-ctx-item" onClick={() => { for (const t of sel) void window.browserAPI.readlater.add({ url: t.url, title: t.title, favicon: t.favicon }); after() }}>
          읽기 목록에 추가
        </button>
        <div className="tab-ctx-sep" />
        <button className="tab-ctx-item danger" onClick={() => { for (const id of ids) void window.browserAPI.tabs.close(id); after() }}>
          {n}개 탭 닫기
        </button>
        <button className="tab-ctx-item" onClick={() => { clearSelection(); onClose() }}>선택 해제</button>
      </div>
    )
  }

  if (menu.kind === 'tab') {
    const tab = tabs.find((t) => t.id === menu.id)
    if (!tab) return null
    const otherGroups = groups
    const othersAudible = tabs.some((t) => t.id !== tab.id && t.audible && !t.muted)
    const anyMuted = tabs.some((t) => t.muted)
    const muteOthers = () => {
      for (const t of tabs) if (t.id !== tab.id && !t.muted) void window.browserAPI.tabs.setMuted(t.id, true)
    }
    const unmuteAll = () => {
      for (const t of tabs) if (t.muted) void window.browserAPI.tabs.setMuted(t.id, false)
    }
    return (
      <div className="tab-ctx" style={style} onClick={stop}>
        <button className="tab-ctx-item" onClick={() => { void window.browserAPI.tabs.pin(tab.id, !tab.pinned); onClose() }}>
          {tab.pinned ? '핀 고정 해제' : '핀 고정'}
        </button>
        {(tab.audible || tab.muted) && (
          <button className="tab-ctx-item" onClick={() => { void window.browserAPI.tabs.setMuted(tab.id, !tab.muted); onClose() }}>
            {tab.muted ? '음소거 해제' : '탭 음소거'}
          </button>
        )}
        {othersAudible && (
          <button className="tab-ctx-item" onClick={() => { muteOthers(); onClose() }}>
            다른 탭 모두 음소거
          </button>
        )}
        {anyMuted && (
          <button className="tab-ctx-item" onClick={() => { unmuteAll(); onClose() }}>
            전체 탭 음소거 해제
          </button>
        )}
        <div className="tab-ctx-sep" />
        <button className="tab-ctx-item" onClick={() => { void window.browserAPI.groups.create(windowId, { tabIds: [tab.id] }); onClose() }}>
          새 그룹으로 이동
        </button>
        {otherGroups.filter((g) => g.id !== tab.groupId).map((g) => (
          <button key={g.id} className="tab-ctx-item" onClick={() => { void window.browserAPI.groups.assignTab(tab.id, g.id); onClose() }}>
            <span className="tg-dot" style={{ background: GROUP_HEX[g.color] }} /> {g.title} 그룹으로
          </button>
        ))}
        {tab.groupId && (
          <button className="tab-ctx-item" onClick={() => { void window.browserAPI.groups.assignTab(tab.id, null); onClose() }}>
            그룹에서 빼기
          </button>
        )}
        <div className="tab-ctx-sep" />
        <button className="tab-ctx-item danger" onClick={() => { void window.browserAPI.tabs.close(tab.id); onClose() }}>
          탭 닫기
        </button>
      </div>
    )
  }

  // group menu
  const group = groups.find((g) => g.id === menu.id)
  if (!group) return null
  return (
    <div className="tab-ctx" style={style} onClick={stop}>
      <button className="tab-ctx-item" onClick={() => {
        const name = window.prompt('그룹 이름', group.title)
        if (name != null) void window.browserAPI.groups.update(group.id, { title: name.trim() || group.title })
        onClose()
      }}>이름 변경</button>
      <button className="tab-ctx-item" onClick={() => { void window.browserAPI.groups.setCollapsed(group.id, !group.collapsed); onClose() }}>
        {group.collapsed ? '펼치기' : '접기'}
      </button>
      <div className="tab-ctx-sep" />
      <div className="tab-ctx-colors">
        {GROUP_COLORS.map((c) => (
          <button
            key={c}
            className={`tab-ctx-swatch ${group.color === c ? 'sel' : ''}`}
            style={{ background: GROUP_HEX[c] }}
            title={GROUP_COLOR_LABEL[c]}
            onClick={() => { void window.browserAPI.groups.update(group.id, { color: c }); onClose() }}
          />
        ))}
      </div>
      <div className="tab-ctx-sep" />
      <button className="tab-ctx-item danger" onClick={() => { void window.browserAPI.groups.remove(group.id); onClose() }}>
        그룹 해제
      </button>
    </div>
  )
}

function TabPreviewPopover({ preview, tab, orientation, onMouseEnter, onMouseLeave, onClosed }: {
  preview: PreviewState
  tab: TabSummary | undefined
  orientation: TabBarOrientation
  onMouseEnter: () => void
  onMouseLeave: () => void
  onClosed: () => void
}) {
  if (!tab) return null
  const PREVIEW_W = 280
  const PREVIEW_H = 170
  const GAP = 8
  let style: React.CSSProperties = {}
  const { rect } = preview
  if (orientation === 'top') {
    const left = Math.max(8, Math.min(window.innerWidth - PREVIEW_W - 8, rect.left + rect.width / 2 - PREVIEW_W / 2))
    style = { top: rect.bottom + GAP, left, width: PREVIEW_W }
  } else if (orientation === 'left') {
    style = { top: rect.top, left: rect.right + GAP, width: PREVIEW_W }
  } else if (orientation === 'right') {
    style = { top: rect.top, right: window.innerWidth - rect.left + GAP, width: PREVIEW_W }
  } else {
    style = { bottom: window.innerHeight - rect.top + GAP, left: rect.left, width: PREVIEW_W }
  }
  return (
    <div className="tab-preview" style={style} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="tab-preview-thumb" style={{ height: PREVIEW_H }}>
        {preview.dataUrl
          ? <img src={preview.dataUrl} alt="" />
          : (preview.loading
            ? <div className="tab-preview-loading">캡처 중…</div>
            : <div className="tab-preview-loading">미리보기 없음</div>)}
      </div>
      <div className="tab-preview-meta">
        {tab.favicon && <img className="tab-preview-favicon" src={tab.favicon} alt="" />}
        <div className="tab-preview-text">
          <div className="tab-preview-title">{tab.title || '새 탭'}</div>
          <div className="tab-preview-url">{tab.url}</div>
        </div>
        <div className="tab-preview-actions">
          {(tab.audible || tab.muted) && (
            <button
              className="tab-preview-btn"
              title={tab.muted ? '음소거 해제' : '음소거'}
              aria-label={tab.muted ? '음소거 해제' : '음소거'}
              onClick={() => void window.browserAPI.tabs.setMuted(tab.id, !tab.muted)}
            >{tab.muted ? '🔇' : '🔊'}</button>
          )}
          {!tab.pinned && (
            <button
              className="tab-preview-btn danger"
              title="탭 닫기"
              aria-label="탭 닫기"
              onClick={() => { void window.browserAPI.tabs.close(tab.id); onClosed() }}
            >×</button>
          )}
        </div>
      </div>
    </div>
  )
}
