import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActionDescriptor, MacroSummary, TabSummary } from '../../shared/types'
import { chosung, scoreFuzzy } from '../utils/fuzzy'

interface ItemBase {
  id: string
  label: string
  category: string
  shortcut?: string
}

interface ActionItem extends ItemBase {
  kind: 'action'
  actionId: string
}

interface TabItem extends ItemBase {
  kind: 'tab'
  tabId: string
  url?: string
}

interface MacroItem extends ItemBase {
  kind: 'macro'
  macroId: string
  detail?: string
}

interface ModMenuItem extends ItemBase {
  kind: 'mod'
  menuId: string
}

type Item = ActionItem | TabItem | MacroItem | ModMenuItem

interface Props {
  windowId: string
  open: boolean
  onClose: () => void
  actions: Array<ActionDescriptor & { key?: string }>
  tabs: TabSummary[]
  macros: MacroSummary[]
  labels: Record<string, string>
  activeTabId?: string
}

const PREFIXES: Record<string, { category: string | null; label: string }> = {
  '>': { category: null, label: '액션' },
  '#': { category: 'tab', label: '탭' },
  '@': { category: 'macro', label: '매크로' },
  '?': { category: 'help', label: '도움말' },
}

export function CommandPalette({ windowId, open, onClose, actions, tabs, macros, labels, activeTabId }: Props) {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [mru, setMru] = useState<Record<string, number>>({})
  const [modMenu, setModMenu] = useState<Array<{ id: string; modName: string; label: string }>>([])

  useEffect(() => {
    if (open) {
      setQuery('')
      setHighlight(0)
      requestAnimationFrame(() => inputRef.current?.focus())
      // 열릴 때마다 모드 메뉴 항목 갱신 (모드는 동적으로 추가됨)
      void window.browserAPI.mod.menuList().then(setModMenu).catch(() => setModMenu([]))
    }
  }, [open])

  const allItems: Item[] = useMemo(() => {
    const items: Item[] = []
    for (const a of actions) {
      const label = labels[a.labelKey] ?? a.id
      items.push({
        id: a.id, kind: 'action', actionId: a.id, label,
        category: a.category, shortcut: a.key,
      })
    }
    for (const t of tabs) {
      items.push({
        id: `tab-${t.id}`, kind: 'tab', tabId: t.id,
        label: t.title || t.url || '새 탭',
        category: 'tab',
      })
    }
    for (const m of macros) {
      if (!m.enabled) continue
      items.push({
        id: `macro-${m.id}`, kind: 'macro', macroId: m.id,
        label: m.name || m.id,
        category: 'macro',
        detail: m.description,
      })
    }
    for (const mm of modMenu) {
      items.push({
        id: `mod-${mm.id}`, kind: 'mod', menuId: mm.id,
        label: `${mm.label}`,
        category: 'mod',
      })
    }
    return items
  }, [actions, tabs, macros, labels, modMenu])

  const FEATURED_ACTION_IDS = [
    'action.settings.open',
    'action.bookmark.add',
    'action.history.open',
    'action.downloads.open',
    'action.darkmode.toggle',
    'action.tab.reader',
    'action.translate.page',
    'action.qrcode.show',
    'action.screenshot.area',
    'action.workspace.next',
  ]

  const filtered = useMemo(() => {
    const trimmed = query.trim()
    let prefixCat: string | null | undefined
    let q = trimmed
    if (trimmed[0] && PREFIXES[trimmed[0]]) {
      const pref = PREFIXES[trimmed[0]]!
      prefixCat = pref.category
      q = trimmed.slice(1).trim()
    }

    // 빈 입력 — MRU 우선, 없으면 추천 액션 + 열린 탭
    if (!q) {
      const mruItems = allItems
        .filter((it) => {
          if (prefixCat === undefined) return true
          if (prefixCat === null) return it.kind === 'action'
          return it.category === prefixCat
        })
        .map((it) => ({ it, s: mru[it.id] ?? 0 }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 8)
        .map((r) => r.it)

      if (mruItems.length > 0) return mruItems

      // MRU 비어있음 — 추천 액션 + 최근 탭
      const featured: Item[] = []
      for (const id of FEATURED_ACTION_IDS) {
        const found = allItems.find((it) => it.kind === 'action' && it.actionId === id)
        if (found && (prefixCat === undefined || prefixCat === null)) featured.push(found)
      }
      const tabsLimited = allItems
        .filter((it) => it.kind === 'tab' && (prefixCat === undefined || prefixCat === 'tab'))
        .slice(0, 5)
      return [...featured.slice(0, 8), ...tabsLimited]
    }

    const ql = q.toLowerCase()
    const qChosung = chosung(q)
    const ranked = allItems
      .filter((it) => {
        if (prefixCat === undefined) return true
        if (prefixCat === null) return it.kind === 'action'
        return it.category === prefixCat
      })
      .map((it) => {
        const labelLower = it.label.toLowerCase()
        const labelChosung = chosung(it.label)
        let s = scoreFuzzy(labelLower, ql)
        if (q && /^[ㄱ-ㅎ]+$/.test(q) && labelChosung.includes(qChosung)) s += 4
        s += (mru[it.id] ?? 0) * 0.3
        return { it, s }
      })
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
    return ranked.map((r) => r.it)
  }, [allItems, query, mru])

  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(Math.max(0, filtered.length - 1))
  }, [filtered, highlight])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  if (!open) return null

  function run(item: Item) {
    setMru((prev) => ({ ...prev, [item.id]: (prev[item.id] ?? 0) + 1 }))
    if (item.kind === 'action') {
      void window.browserAPI.actions.run(item.actionId, { windowId, tabId: activeTabId })
    } else if (item.kind === 'tab') {
      void window.browserAPI.tabs.activate(item.tabId)
    } else if (item.kind === 'macro') {
      void window.browserAPI.macro.run(item.macroId, windowId)
    } else if (item.kind === 'mod') {
      void window.browserAPI.mod.menuInvoke(item.menuId)
    }
    onClose()
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(filtered.length - 1, h + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const target = filtered[highlight]
      if (target) run(target)
    }
  }

  const isHelp = query.trim() === '?'
  const showHint = query.trim() === '' && filtered.length > 0

  return (
    <div className="command-palette-backdrop" onMouseDown={onClose}>
      <div className="command-palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKey}
          placeholder="명령 검색 — 이름을 입력하세요 (예: 다크, 설정, ㅂㅁㅋ)  ·  ? 누르면 도움말"
        />
        <div className="command-palette-list" ref={listRef}>
          {isHelp && (
            <div className="command-palette-help">
              <div className="cp-help-title">명령 팔레트 사용법</div>
              <div className="cp-help-row"><kbd>↑</kbd><kbd>↓</kbd> 항목 이동 · <kbd>Enter</kbd> 실행 · <kbd>Esc</kbd> 닫기</div>
              <div className="cp-help-section">검색 범위 좁히기</div>
              <div className="cp-help-row"><kbd>&gt;</kbd> 액션만 (예: <em>&gt;다크</em>)</div>
              <div className="cp-help-row"><kbd>#</kbd> 열린 탭만 (예: <em>#github</em>)</div>
              <div className="cp-help-row"><kbd>@</kbd> 저장된 매크로</div>
              <div className="cp-help-section">검색 팁</div>
              <div className="cp-help-row">한글 초성으로도 검색됩니다 — <em>ㅂㅁㅋ</em> → 북마크</div>
              <div className="cp-help-row">자주 쓴 명령은 자동으로 위로 정렬됩니다 (MRU)</div>
            </div>
          )}
          {!isHelp && showHint && (
            <div className="command-palette-hint">
              자주 사용하는 명령 · 이름을 입력하면 전체에서 검색됩니다 (<kbd>?</kbd> 사용법)
            </div>
          )}
          {!isHelp && filtered.length === 0 && (
            <div className="command-palette-empty">결과 없음 — 다른 키워드를 시도하거나 <kbd>?</kbd>로 사용법을 확인하세요</div>
          )}
          {!isHelp && filtered.map((item, i) => (
            <div
              key={item.id}
              data-idx={i}
              className={`command-palette-item ${i === highlight ? 'active' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => { e.preventDefault(); run(item) }}
            >
              <span className="cp-category">{item.category}</span>
              <span className="cp-label">{item.label}</span>
              {item.shortcut && <span className="cp-shortcut">{item.shortcut}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
