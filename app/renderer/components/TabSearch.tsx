import { useEffect, useMemo, useRef, useState } from 'react'
import type { TabSummary, TabGroup, TabGroupColor } from '../../shared/types'
import { chosung, scoreFuzzy } from '../utils/fuzzy'

interface Props {
  windowId: string
  open: boolean
  onClose: () => void
  tabs: TabSummary[]
  activeTabId?: string
}

const GROUP_HEX: Record<TabGroupColor, string> = {
  red: '#E5484D', orange: '#F76808', yellow: '#FFB224', green: '#30A46C',
  blue: '#3478F6', purple: '#8E4EC6', pink: '#E93D82', gray: '#8E8E93',
}

function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u }
}

export function TabSearch({ windowId, open, onClose, tabs, activeTabId }: Props) {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [groups, setGroups] = useState<TabGroup[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setHighlight(0)
    requestAnimationFrame(() => inputRef.current?.focus())
    void window.browserAPI.groups.list(windowId).then(setGroups).catch(() => setGroups([]))
  }, [open, windowId])

  useEffect(() => {
    const off = window.browserAPI.groups.onChanged((payload) => {
      if (payload.windowId === windowId) setGroups(payload.groups)
    })
    return off
  }, [windowId])

  const groupsById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])

  const filtered = useMemo(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      // 빈 입력: 활성 탭 우선, 그다음 index 순
      return [...tabs].sort((a, b) => {
        if (a.id === activeTabId) return -1
        if (b.id === activeTabId) return 1
        return a.index - b.index
      })
    }
    const ql = trimmed.toLowerCase()
    const qChosung = chosung(trimmed)
    const isChosungQuery = /^[ㄱ-ㅎ]+$/.test(trimmed)
    return tabs
      .map((t) => {
        const title = t.title || t.url || '새 탭'
        const titleLower = title.toLowerCase()
        const urlLower = (t.url || '').toLowerCase()
        let s = Math.max(scoreFuzzy(titleLower, ql), scoreFuzzy(urlLower, ql) * 0.9)
        if (isChosungQuery && chosung(title).includes(qChosung)) s += 4
        return { t, s }
      })
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((r) => r.t)
  }, [tabs, query, activeTabId])

  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(Math.max(0, filtered.length - 1))
  }, [filtered, highlight])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  if (!open) return null

  const activate = (id: string) => { void window.browserAPI.tabs.activate(id); onClose() }
  const closeOne = (id: string) => { void window.browserAPI.tabs.close(id) }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(filtered.length - 1, h + 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)); return }
    // Ctrl+Enter 또는 Delete: 강조된 탭 닫기 (오버레이 유지) — plain Enter 분기보다 먼저 검사해야
    // Ctrl+Enter 가 활성화로 새지 않는다 (e.key 는 Ctrl 유무와 무관하게 'Enter').
    if ((e.ctrlKey && e.key === 'Enter') || e.key === 'Delete') {
      e.preventDefault()
      const target = filtered[highlight]
      if (target) closeOne(target.id)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const target = filtered[highlight]
      if (target) activate(target.id)
      return
    }
  }

  return (
    <div className="command-palette-backdrop" onMouseDown={onClose}>
      <div className="command-palette tabsearch" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKey}
          placeholder={`열린 탭 ${tabs.length}개 검색 — 제목·주소·초성  ·  Enter 이동, Ctrl+Enter/Del 닫기`}
        />
        <div className="command-palette-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="command-palette-empty">일치하는 탭이 없습니다</div>
          ) : (
            filtered.map((t, i) => {
              const g = t.groupId ? groupsById.get(t.groupId) : undefined
              return (
                <div
                  key={t.id}
                  data-idx={i}
                  className={`command-palette-item ts-item ${i === highlight ? 'active' : ''} ${t.id === activeTabId ? 'ts-current' : ''}`}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => { e.preventDefault(); activate(t.id) }}
                >
                  {t.favicon
                    ? <img className="ts-favicon" src={t.favicon} alt="" />
                    : <span className="ts-favicon ts-favicon-empty" aria-hidden />}
                  <span className="ts-text">
                    <span className="ts-title">
                      {t.pinned && <span className="ts-badge" title="고정됨">📌</span>}
                      {t.discarded && <span className="ts-badge" title="잠자는 탭">💤</span>}
                      {t.title || t.url || '새 탭'}
                    </span>
                    <span className="ts-url">{hostOf(t.url || '')}</span>
                  </span>
                  {g && (
                    <span className="ts-group" title={`그룹: ${g.title}`}>
                      <span className="tg-dot" style={{ background: GROUP_HEX[g.color] }} />
                      {g.title}
                    </span>
                  )}
                  {t.id === activeTabId && <span className="ts-now">현재</span>}
                  <button
                    className="ts-close"
                    aria-label="탭 닫기"
                    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); closeOne(t.id) }}
                  >×</button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
