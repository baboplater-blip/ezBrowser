import { useEffect, useRef, useState } from 'react'
import type { ExtensionSummary } from '../../shared/types'
import { useChromeOverlay } from '../hooks/useChromeOverlay'
import { useI18nT } from '../i18n'

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
  const tr = useI18nT()
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

  function invoke(ext: ExtensionSummary, anchorEl: HTMLElement | null) {
    const rect = anchorEl?.getBoundingClientRect()
    const anchorRect = rect
      ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      : undefined
    void window.browserAPI.extensions.invokeAction(ext.id, anchorRect)
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
    const label = ext.actionTitle || ext.name
    return (
      <button
        key={ext.id}
        type="button"
        className="ext-action-icon"
        title={label}
        aria-label={label}
        aria-haspopup={ext.hasAction ? 'dialog' : undefined}
        onClick={(e) => invoke(ext, e.currentTarget)}
        onContextMenu={(e) => openContextMenu(e, ext)}
        onKeyDown={(e) => {
          // Shift+F10 / ContextMenu 키로도 컨텍스트 메뉴를 열 수 있게(마우스 없이).
          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault()
            const rect = e.currentTarget.getBoundingClientRect()
            setMenu({ id: ext.id, name: ext.name, hasOptions: ext.hasOptions, x: rect.left, y: rect.bottom })
          }
        }}
      >
        {ext.iconDataUrl
          ? <img src={ext.iconDataUrl} alt="" draggable={false} />
          : <span className="ext-action-letter" aria-hidden="true">{(ext.name || '?').slice(0, 1).toUpperCase()}</span>}
      </button>
    )
  }

  return (
    <div className="ext-actions">
      {visible.map(renderIcon)}
      {overflow.length > 0 && (
        <div className="ext-overflow-wrap" ref={overflowRef} data-ext-overflow="1">
          <button
            type="button"
            className="ext-action-icon ext-overflow-btn"
            onClick={() => setOverflowOpen((v) => !v)}
            title={tr('ui.extActions.overflowTitle', '확장 {count}개 더', { count: overflow.length })}
            aria-label={tr('ui.extActions.overflowAria', '확장 {count}개 더 보기', { count: overflow.length })}
            aria-expanded={overflowOpen}
          >
            ⋯<span className="ext-overflow-count" aria-hidden="true">{overflow.length}</span>
          </button>
          {overflowOpen && (
            <div className="ext-overflow-panel" data-ext-overflow="1" role="group" aria-label={tr('ui.extActions.hiddenGroupAria', '숨겨진 확장 아이콘')}>
              {overflow.map(renderIcon)}
            </div>
          )}
        </div>
      )}
      {menu && (
        <div
          className="ext-context-menu"
          data-ext-menu="1"
          role="menu"
          aria-label={tr('ui.extActions.menuAria', '{name} 메뉴', { name: menu.name })}
          style={{ left: Math.min(menu.x, window.innerWidth - 200), top: menu.y }}
        >
          <div className="ext-context-title">{menu.name}</div>
          {menu.hasOptions && (
            <button
              type="button"
              role="menuitem"
              className="ext-context-item"
              onClick={() => { void window.browserAPI.extensions.openOptions(menu.id); setMenu(null) }}
            >{tr('ui.extActions.options', '옵션')}</button>
          )}
          <button
            type="button"
            role="menuitem"
            className="ext-context-item"
            onClick={() => {
              void window.browserAPI.actions.run('action.extensions.open', { windowId })
              setMenu(null)
            }}
          >{tr('ui.extActions.manage', '확장 관리')}</button>
          <button
            type="button"
            role="menuitem"
            className="ext-context-item danger"
            onClick={() => {
              if (confirm(tr('ui.extActions.confirmRemove', '"{name}" 확장을 제거할까요?', { name: menu.name }))) {
                void window.browserAPI.extensions.remove(menu.id)
              }
              setMenu(null)
            }}
          >{tr('ui.extActions.remove', '제거')}</button>
        </div>
      )}
    </div>
  )
}
