import { useCallback, useEffect, useRef, useState } from 'react'
import type { TabSummary } from '../../shared/types'
import { NEW_TAB_URL } from '../../shared/constants'
import { acquireChromeOverlay, releaseChromeOverlay } from '../hooks/useChromeOverlay'

export interface PaneLayout {
  split: 'h' | 'v' | null
  splitRatio: number
  activePaneIdx: number
  panes: Array<{ tabId: string | null }>
}

interface Props {
  windowId: string
  layout: PaneLayout
  tabs: TabSummary[]
}

type DropZone = 'left' | 'right' | 'top' | 'bottom' | null

export function PaneStage({ windowId, layout, tabs }: Props) {
  const [dropZone, setDropZone] = useState<DropZone>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const onDragOver = useCallback((e: React.DragEvent) => {
    const types = e.dataTransfer?.types
    if (!types || !Array.from(types).some((t) => t === 'application/x-browserbuild-tab' || t === 'text/plain')) return
    e.preventDefault()
    const el = wrapRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    let zone: DropZone = null
    if (x < 0.2) zone = 'left'
    else if (x > 0.8) zone = 'right'
    else if (y < 0.2) zone = 'top'
    else if (y > 0.8) zone = 'bottom'
    setDropZone(zone)
  }, [])
  const onDragLeave = useCallback(() => setDropZone(null), [])
  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const tabId = e.dataTransfer?.getData('application/x-browserbuild-tab')
      || e.dataTransfer?.getData('text/plain')
    const zone = dropZone
    setDropZone(null)
    if (!tabId || !zone) return
    const direction: 'h' | 'v' = zone === 'left' || zone === 'right' ? 'h' : 'v'
    if (layout.split === null) {
      // 분할 시작 + 드래그된 탭을 새로운 pane 에 배치
      await window.browserAPI.actions.run('action.pane.split.h', { windowId })
      // splitWindow 가 활성 탭을 다른 pane 에 배치하므로, 우리는 드래그 탭을 활성화하여 위치 조정
      await window.browserAPI.tabs.activate(tabId)
      void direction
    } else {
      await window.browserAPI.tabs.activate(tabId)
    }
  }, [dropZone, layout.split, windowId])

  if (layout.split === null || layout.panes.length < 2) {
    return (
      <div
        className={`tab-stage ${dropZone ? `dropzone-${dropZone}` : ''}`}
        ref={wrapRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {dropZone && <div className={`pane-dropzone-overlay zone-${dropZone}`}>여기에 분할</div>}
      </div>
    )
  }
  const ratio = Math.max(0.15, Math.min(0.85, layout.splitRatio))
  const first = layout.panes[0]
  const second = layout.panes[1]
  return (
    <div className={`tab-stage-split tab-stage-${layout.split}`} ref={wrapRef}>
      <Pane
        idx={0}
        active={layout.activePaneIdx === 0}
        flex={ratio}
        tabId={first?.tabId ?? null}
        tabs={tabs}
        windowId={windowId}
        split={layout.split}
      />
      <Splitter split={layout.split} windowId={windowId} />
      <Pane
        idx={1}
        active={layout.activePaneIdx === 1}
        flex={1 - ratio}
        tabId={second?.tabId ?? null}
        tabs={tabs}
        windowId={windowId}
        split={layout.split}
      />
    </div>
  )
}

function Pane({ idx, active, flex, tabId, tabs, windowId, split }: {
  idx: number; active: boolean; flex: number; tabId: string | null
  tabs: TabSummary[]; windowId: string; split: 'h' | 'v'
}) {
  const tab = tabs.find((t) => t.id === tabId)
  const handleClick = useCallback(() => {
    if (!active) void window.browserAPI.windows.focusPane(windowId, idx)
  }, [active, windowId, idx])

  const closeSplit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    void window.browserAPI.actions.run('action.pane.unsplit', { windowId })
  }, [windowId])

  const addNewTab = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    void window.browserAPI.windows.focusPane(windowId, idx)
    void window.browserAPI.tabs.create(windowId, NEW_TAB_URL)
  }, [windowId, idx])

  return (
    <div
      className={`pane pane-${split} ${active ? 'active' : ''}`}
      style={{ flex }}
      onMouseDown={handleClick}
    >
      <div className="pane-header">
        {tab?.favicon && <img className="pane-header-favicon" src={tab.favicon} alt="" />}
        <span className="pane-header-title">{tab?.title || tab?.url || '빈 분할창'}</span>
        <span className="pane-header-pos">{positionLabel(split, idx)}</span>
        {!tab && (
          <button
            className="pane-header-btn"
            title="이 분할창에 새 탭"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={addNewTab}
          >＋</button>
        )}
        <button
          className="pane-header-btn pane-header-close"
          title="분할 해제 (Ctrl+Alt+0)"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={closeSplit}
        >✕</button>
      </div>
    </div>
  )
}

function positionLabel(split: 'h' | 'v', idx: number): string {
  if (split === 'h') return idx === 0 ? '왼쪽' : '오른쪽'
  return idx === 0 ? '위' : '아래'
}

function Splitter({ split, windowId }: { split: 'h' | 'v'; windowId: string }) {
  const draggingRef = useRef(false)
  const [doubleHint, setDoubleHint] = useState(false)

  useEffect(() => {
    if (!doubleHint) return
    const t = setTimeout(() => setDoubleHint(false), 600)
    return () => clearTimeout(t)
  }, [doubleHint])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const wrap = (e.currentTarget as HTMLElement).parentElement
    if (!wrap) return
    draggingRef.current = true
    document.body.style.cursor = split === 'h' ? 'col-resize' : 'row-resize'
    document.body.classList.add('splitter-dragging')
    // 다른 오버레이(토스트·모달 등)가 동시에 열려 있어도 서로 승격/강등이 꼬이지 않도록
    // 공유 참조 카운터(useChromeOverlay)를 통해 승격한다 — 직접 begin/endPaneDrag 를 부르면
    // 드래그가 먼저 끝날 때 다른 오버레이가 열려 있어도 chrome 을 강등시켜버릴 수 있다.
    acquireChromeOverlay(windowId)

    const move = (ev: MouseEvent) => {
      if (!draggingRef.current) return
      const rect = wrap.getBoundingClientRect()
      const r = split === 'h'
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height
      const clamped = Math.max(0.15, Math.min(0.85, r))
      void window.browserAPI.windows.setPaneSplitRatio(windowId, clamped)
    }
    const up = () => {
      draggingRef.current = false
      document.body.style.cursor = ''
      document.body.classList.remove('splitter-dragging')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      releaseChromeOverlay(windowId)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [split, windowId])

  const onDoubleClick = useCallback(() => {
    void window.browserAPI.windows.setPaneSplitRatio(windowId, 0.5)
    setDoubleHint(true)
  }, [windowId])

  return (
    <div
      className={`splitter splitter-${split} ${doubleHint ? 'hint' : ''}`}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      title="드래그 = 비율 조정 · 더블클릭 = 50:50"
    />
  )
}
