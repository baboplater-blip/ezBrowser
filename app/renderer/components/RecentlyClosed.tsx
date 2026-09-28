import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18nT } from '../i18n'

type TFn = (key: string, fallback?: string, vars?: Record<string, string | number>) => string

interface ClosedEntry { id: number; url: string; title: string; closedAt: number }

interface Props {
  windowId: string
  open: boolean
  onClose: () => void
}

function faviconOf(url: string): string {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32` } catch { return '' }
}
function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u }
}
function ago(ts: number, tr: TFn): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 30) return tr('ui.recentlyClosed.justNow', '방금')
  if (s < 60) return tr('ui.recentlyClosed.secondsAgo', '{n}초 전', { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return tr('ui.recentlyClosed.minutesAgo', '{n}분 전', { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return tr('ui.recentlyClosed.hoursAgo', '{n}시간 전', { n: h })
  return tr('ui.recentlyClosed.daysAgo', '{n}일 전', { n: Math.floor(h / 24) })
}

export function RecentlyClosed({ windowId, open, onClose }: Props) {
  const tr = useI18nT()
  const [items, setItems] = useState<ClosedEntry[]>([])
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const refresh = useMemo(() => () => {
    void window.browserAPI.recentClosed.list(30).then((l) => setItems(l)).catch(() => setItems([]))
  }, [])

  useEffect(() => {
    if (!open) return
    setHighlight(0)
    refresh()
  }, [open, refresh])

  useEffect(() => {
    if (highlight >= items.length) setHighlight(Math.max(0, items.length - 1))
  }, [items, highlight])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  if (!open) return null

  const reopen = (id: number) => {
    void window.browserAPI.recentClosed.reopen(id, windowId)
    onClose()
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(items.length - 1, h + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const t = items[highlight]
      if (t) reopen(t.id)
    }
  }

  return (
    <div className="command-palette-backdrop" onMouseDown={onClose}>
      <div
        className="command-palette recently-closed"
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKey}
      >
        <div className="rc-head">
          <span className="rc-title">{tr('ui.recentlyClosed.title', '최근 닫은 탭')}</span>
          {items.length > 0 && (
            <button className="rc-clear" onMouseDown={(e) => { e.preventDefault(); void window.browserAPI.recentClosed.clear(); setItems([]) }}>
              {tr('ui.recentlyClosed.clearAll', '전체 비우기')}
            </button>
          )}
        </div>
        <div className="command-palette-list" ref={listRef}>
          {items.length === 0 ? (
            <div className="command-palette-empty">{tr('ui.recentlyClosed.empty', '최근에 닫은 탭이 없습니다')}</div>
          ) : (
            items.map((t, i) => (
              <div
                key={t.id}
                data-idx={i}
                className={`command-palette-item ts-item ${i === highlight ? 'active' : ''}`}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => { e.preventDefault(); reopen(t.id) }}
              >
                <img className="ts-favicon" src={faviconOf(t.url)} alt="" />
                <span className="ts-text">
                  <span className="ts-title">{t.title || hostOf(t.url)}</span>
                  <span className="ts-url">{hostOf(t.url)}</span>
                </span>
                <span className="rc-time">{ago(t.closedAt, tr)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
