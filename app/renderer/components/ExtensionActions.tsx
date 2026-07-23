import { useEffect, useRef, useState } from 'react'
import type { ExtensionSummary } from '../../shared/types'
import { useChromeOverlay } from '../hooks/useChromeOverlay'

interface Props {
  windowId: string
  extensions: ExtensionSummary[]
}

interface MenuState {
  id: string
  name: string
  hasOptions: boolean
  x: number
  y: number
}

const MAX_VISIBLE_ICONS = 6

export function ExtensionActions({ windowId, extensions }: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const overflowRef = useRef<HTMLDivElement>(null)

  // 오버플로 패널(absolute, 툴바 아래로 펼쳐짐)과 컨텍스트 메뉴(fixed) 둘 다 chrome 의 insets
  // 영역(top)을 넘어 콘텐츠 영역까지 확장될 수 있어 승격이 필요하다.
  useChromeOverlay(windowId, menu !== null || overflowOpen)

  useEffect(() => {
    if (!menu && !overflowOpen) return
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest?.('[data-ext-menu]')) return
      if (target?.closest?.('[data-ext-overflow]')) return
      setMenu(null)
      setOverflowOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenu(null); setOverflowOpen(false) }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [menu, overflowOpen])

  const actionable = extensions.filter((e) => e.enabled && (e.hasAction || e.hasOptions))
  if (actionable.length === 0) return null

  const visible = actionable.slice(0, MAX_VISIBLE_ICONS)
  const overflow = actionable.slice(MAX_VISIBLE_ICONS)

  function invoke(ext: ExtensionSummary) {
    void window.browserAPI.extensions.invokeAction(ext.id)
  }

  function openContextMenu(e: React.MouseEvent, ext: ExtensionSummary) {
    e.preventDefault()
    e.stopPropagation()
    setMenu({
      id: ext.id, name: ext.name, hasOptions: ext.hasOptions,
      x: e.clientX, y: e.clientY,
    })
  }

  function renderIcon(ext: ExtensionSummary) {
    return (
      <button
        key={ext.id}
        className="ext-action-icon"
        title={ext.actionTitle || ext.name}
        onClick={() => invoke(ext)}
        onContextMenu={(e) => openContextMenu(e, ext)}
      >
        {ext.iconDataUrl
          ? <img src={ext.iconDataUrl} alt={ext.name} draggable={false} />
          : <span className="ext-action-letter">{(ext.name || '?').slice(0, 1).toUpperCase()}</span>}
      </button>
    )
  }

  return (
    <div className="ext-actions">
      {visible.map(renderIcon)}
      {overflow.length > 0 && (
        <div className="ext-overflow-wrap" ref={overflowRef} data-ext-overflow="1">
          <button
            className="ext-action-icon ext-overflow-btn"
            onClick={() => setOverflowOpen((v) => !v)}
            title={`확장 ${overflow.length}개 더`}
          >
            ⋯<span className="ext-overflow-count">{overflow.length}</span>
          </button>
          {overflowOpen && (
            <div className="ext-overflow-panel" data-ext-overflow="1">
              {overflow.map(renderIcon)}
            </div>
          )}
        </div>
      )}
      {menu && (
        <div
          className="ext-context-menu"
          data-ext-menu="1"
          style={{ left: Math.min(menu.x, window.innerWidth - 200), top: menu.y }}
        >
          <div className="ext-context-title">{menu.name}</div>
          {menu.hasOptions && (
            <button
              className="ext-context-item"
              onClick={() => { void window.browserAPI.extensions.openOptions(menu.id); setMenu(null) }}
            >옵션</button>
          )}
          <button
            className="ext-context-item"
            onClick={() => {
              void window.browserAPI.actions.run('action.extensions.open', { windowId })
              setMenu(null)
            }}
          >확장 관리</button>
          <button
            className="ext-context-item danger"
            onClick={() => {
              if (confirm(`"${menu.name}" 확장을 제거할까요?`)) {
                void window.browserAPI.extensions.remove(menu.id)
              }
              setMenu(null)
            }}
          >제거</button>
        </div>
      )}
    </div>
  )
}
