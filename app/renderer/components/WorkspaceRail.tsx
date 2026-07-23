import { useEffect, useRef, useState } from 'react'
import type { Workspace, WorkspaceColor, WorkspaceState } from '../../shared/types'
import { useChromeOverlay } from '../hooks/useChromeOverlay'

const COLOR_HEX: Record<WorkspaceColor, string> = {
  red: '#E5484D',
  orange: '#F76808',
  yellow: '#FFB224',
  green: '#30A46C',
  blue: '#3478F6',
  purple: '#8E4EC6',
  pink: '#E93D82',
  gray: '#8E8E93',
}

const COLOR_LABEL: Record<WorkspaceColor, string> = {
  red: '빨강', orange: '주황', yellow: '노랑', green: '초록',
  blue: '파랑', purple: '보라', pink: '핑크', gray: '회색',
}

const COLORS: WorkspaceColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'gray']

export const WORKSPACE_RAIL_WIDTH = 48

function chipLabel(name: string, fallbackIdx: number): string {
  const trimmed = name.trim()
  const m = /(\d+)\s*$/.exec(trimmed)
  if (m && m[1]) return m[1].slice(-2)
  const first = trimmed.charAt(0)
  return first || String(fallbackIdx + 1)
}

interface Props {
  windowId: string | null
  open: boolean
  onToggle: () => void
}

interface MenuState {
  workspace: Workspace
  x: number
  y: number
  mode: 'main' | 'rename' | 'home'
}

export function WorkspaceRail({ windowId, open, onToggle }: Props): JSX.Element | null {
  const [state, setState] = useState<WorkspaceState>({ workspaces: [], activeId: '' })
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [tempInput, setTempInput] = useState('')
  const dragSourceId = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 컨텍스트 메뉴(색상 picker·이름변경·삭제)는 rail 의 48px 폭을 넘어 콘텐츠 영역까지 펼쳐지는
  // fixed 오버레이 — chrome view 를 z-order 최상위로 승격해야 보이고 클릭도 받는다.
  useChromeOverlay(windowId, menu !== null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const s = await window.browserAPI.workspace.state()
      if (cancelled) return
      setState(s)
    })()
    const off = window.browserAPI.workspace.onChanged((s) => setState(s))
    return () => { cancelled = true; off() }
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest?.('[data-ws-menu]')) return
      setMenu(null)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [menu])

  useEffect(() => {
    if (menu?.mode === 'rename' || menu?.mode === 'home') {
      setTempInput(menu.mode === 'rename' ? menu.workspace.name : menu.workspace.homeUrl)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [menu])

  if (!open) return null

  const handleActivate = (id: string) => {
    if (id === state.activeId) return
    void window.browserAPI.workspace.activate(id)
  }

  const handleNew = () => {
    void window.browserAPI.workspace.create()
  }

  const openContextMenu = (e: React.MouseEvent, w: Workspace) => {
    e.preventDefault()
    setMenu({ workspace: w, x: e.clientX + 4, y: e.clientY, mode: 'main' })
  }

  const handleRename = (w: Workspace) => {
    setMenu((m) => m ? { ...m, mode: 'rename' } : null)
  }

  const handleHome = (w: Workspace) => {
    setMenu((m) => m ? { ...m, mode: 'home' } : null)
  }

  const handleColor = (w: Workspace, color: WorkspaceColor) => {
    void window.browserAPI.workspace.update(w.id, { color })
    setMenu(null)
  }

  const handleDelete = (w: Workspace) => {
    if (state.workspaces.length <= 1) {
      alert('마지막 스페이스는 삭제할 수 없습니다.')
      return
    }
    if (!confirm(`스페이스 "${w.name}" 를 삭제할까요?\n(이 스페이스의 모든 탭과 세션이 사라집니다.)`)) return
    void window.browserAPI.workspace.remove(w.id)
    setMenu(null)
  }

  const submitInput = () => {
    if (!menu) return
    const v = tempInput.trim()
    if (menu.mode === 'rename') {
      if (v && v !== menu.workspace.name) {
        void window.browserAPI.workspace.update(menu.workspace.id, { name: v })
      }
    } else if (menu.mode === 'home') {
      if (v !== menu.workspace.homeUrl) {
        void window.browserAPI.workspace.update(menu.workspace.id, { homeUrl: v })
      }
    }
    setMenu(null)
  }

  return (
    <div className="workspace-rail">
      <button
        className="workspace-collapse"
        onClick={onToggle}
        title="워크스페이스 사이드바 접기"
      >‹</button>
      {state.workspaces.map((w, idx) => (
        <button
          key={w.id}
          className={`workspace-chip ${w.id === state.activeId ? 'active' : ''}${dragOverId === w.id ? ' drag-over' : ''}`}
          style={{ background: COLOR_HEX[w.color] ?? COLOR_HEX.gray }}
          onClick={() => handleActivate(w.id)}
          onContextMenu={(e) => openContextMenu(e, w)}
          onDoubleClick={() => { setMenu({ workspace: w, x: 56, y: 60 + idx * 44, mode: 'rename' }) }}
          title={`${w.name}${w.id === state.activeId ? ' (활성)' : ''}\n우클릭 = 메뉴, 더블클릭 = 이름`}
          draggable
          onDragStart={(e) => {
            dragSourceId.current = w.id
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={(e) => {
            if (!dragSourceId.current || dragSourceId.current === w.id) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDragOverId(w.id)
          }}
          onDragLeave={() => setDragOverId((id) => id === w.id ? null : id)}
          onDrop={(e) => {
            e.preventDefault()
            const src = dragSourceId.current
            dragSourceId.current = null
            setDragOverId(null)
            if (!src || src === w.id) return
            const order = state.workspaces.map((x) => x.id)
            const srcIdx = order.indexOf(src)
            const dstIdx = order.indexOf(w.id)
            if (srcIdx < 0 || dstIdx < 0) return
            order.splice(srcIdx, 1)
            order.splice(dstIdx, 0, src)
            void window.browserAPI.workspace.reorder(order)
          }}
          onDragEnd={() => { dragSourceId.current = null; setDragOverId(null) }}
        >
          <span className="workspace-chip-letter">{chipLabel(w.name, idx)}</span>
        </button>
      ))}
      <button
        className="workspace-new"
        onClick={handleNew}
        title="새 스페이스 (Ctrl+Alt+N)"
      >+</button>

      {menu && (
        <div
          className="workspace-menu"
          data-ws-menu="1"
          style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 280) }}
        >
          <div className="ws-menu-title">{menu.workspace.name}</div>
          {menu.mode === 'main' && (
            <>
              <button className="ws-menu-item" onClick={() => handleRename(menu.workspace)}>이름 변경…</button>
              <button className="ws-menu-item" onClick={() => handleHome(menu.workspace)}>시작 페이지 지정…</button>
              <div className="ws-menu-section">색상</div>
              <div className="ws-menu-colors">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    className={`ws-color-chip ${menu.workspace.color === c ? 'active' : ''}`}
                    style={{ background: COLOR_HEX[c] }}
                    title={COLOR_LABEL[c]}
                    onClick={() => handleColor(menu.workspace, c)}
                  />
                ))}
              </div>
              <div className="ws-menu-divider" />
              <button
                className="ws-menu-item danger"
                onClick={() => handleDelete(menu.workspace)}
              >삭제</button>
            </>
          )}
          {(menu.mode === 'rename' || menu.mode === 'home') && (
            <div className="ws-menu-input-wrap">
              <input
                ref={inputRef}
                className="ws-menu-input"
                value={tempInput}
                onChange={(e) => setTempInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitInput()
                  if (e.key === 'Escape') setMenu(null)
                }}
                placeholder={menu.mode === 'rename' ? '스페이스 이름' : 'https://… (비우면 새 탭)'}
                spellCheck={false}
              />
              <div className="ws-menu-input-actions">
                <button className="ws-menu-item" onClick={submitInput}>확인</button>
                <button className="ws-menu-item" onClick={() => setMenu(null)}>취소</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
