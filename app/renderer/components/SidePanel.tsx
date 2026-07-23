import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import type { Bookmark, BookmarkFolder, BookmarkTree, HistoryEntry, ReadLaterItem, TabSummary } from '../../shared/types'
import { AiTab } from './AiTab'

type Tab = 'ai' | 'bookmarks' | 'history' | 'notes' | 'readlater' | 'briefing'
const TABS: Tab[] = ['ai', 'bookmarks', 'history', 'notes', 'readlater', 'briefing']

interface Props {
  side: 'left' | 'right'
  open: boolean
  width: number
  onClose: () => void
  windowId: string
  active: TabSummary | null
  tree: BookmarkTree
  requestTab?: { side: 'left' | 'right'; tab: Tab; nonce: number }
  aiSummarizeNonce?: number
  aiWriteNonce?: number
}

const STORAGE_NOTES = 'browserbuild.sidepanel.notes'
const STORAGE_TAB_PREFIX = 'browserbuild.sidepanel.tab.'

function faviconOf(url: string): string {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32` } catch { return '' }
}
function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u }
}

function openLink(active: TabSummary | null, windowId: string, url: string, ev: React.MouseEvent): void {
  if (ev.ctrlKey || ev.metaKey || ev.button === 1) {
    void window.browserAPI.tabs.create(windowId, url, { background: !ev.shiftKey })
    return
  }
  if (active) void window.browserAPI.tabs.navigate(active.id, url)
  else void window.browserAPI.tabs.create(windowId, url)
}

export const SidePanel = forwardRef<HTMLDivElement, Props>(function SidePanel(
  { side, open, width, onClose, windowId, active, tree, requestTab, aiSummarizeNonce, aiWriteNonce }, ref,
) {
  const tabKey = `${STORAGE_TAB_PREFIX}${side}`
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const v = localStorage.getItem(tabKey) as Tab | null
      return v && TABS.includes(v) ? v : 'ai'
    } catch { return 'ai' }
  })

  useEffect(() => {
    try { localStorage.setItem(tabKey, tab) } catch { /* ignore */ }
  }, [tab, tabKey])

  // 외부 요청(예: 읽기 목록 열기 액션)으로 특정 섹션 강제 전환
  useEffect(() => {
    if (requestTab && requestTab.side === side) setTab(requestTab.tab)
  }, [requestTab, side])

  if (!open) return null

  return (
    <aside
      ref={ref}
      className={`sidepanel sidepanel-${side}`}
      style={{ width }}
    >
      <div className="sidepanel-head">
        <div className="sidepanel-tabs">
          <button
            className={`sidepanel-tab ${tab === 'ai' ? 'active' : ''}`}
            onClick={() => setTab('ai')} title="AI 어시스턴트"
          >✨</button>
          <button
            className={`sidepanel-tab ${tab === 'bookmarks' ? 'active' : ''}`}
            onClick={() => setTab('bookmarks')} title="북마크"
          >★</button>
          <button
            className={`sidepanel-tab ${tab === 'history' ? 'active' : ''}`}
            onClick={() => setTab('history')} title="방문 기록"
          >🕘</button>
          <button
            className={`sidepanel-tab ${tab === 'notes' ? 'active' : ''}`}
            onClick={() => setTab('notes')} title="메모"
          >📝</button>
          <button
            className={`sidepanel-tab ${tab === 'readlater' ? 'active' : ''}`}
            onClick={() => setTab('readlater')} title="읽기 목록"
          >📚</button>
          <button
            className={`sidepanel-tab ${tab === 'briefing' ? 'active' : ''}`}
            onClick={() => setTab('briefing')} title="자동 수집 브리핑"
          >📥</button>
        </div>
        <button className="sidepanel-close" onClick={onClose} title="닫기">×</button>
      </div>
      <div className={`sidepanel-body ${tab === 'ai' ? 'sidepanel-body-ai' : ''}`}>
        {tab === 'ai' && (
          <AiTab windowId={windowId} active={active} summarizeNonce={aiSummarizeNonce} writeNonce={aiWriteNonce} />
        )}
        {tab === 'bookmarks' && (
          <BookmarksTab tree={tree} windowId={windowId} active={active} />
        )}
        {tab === 'history' && (
          <HistoryTab windowId={windowId} active={active} />
        )}
        {tab === 'notes' && (
          <NotesTab side={side} />
        )}
        {tab === 'readlater' && (
          <ReadLaterTab windowId={windowId} active={active} />
        )}
        {tab === 'briefing' && (
          <BriefingTab windowId={windowId} active={active} />
        )}
      </div>
    </aside>
  )
})

function BookmarksTab({ tree, windowId, active }: {
  tree: BookmarkTree; windowId: string; active: TabSummary | null
}) {
  const [filter, setFilter] = useState('')
  const rootFolders = tree.folders.filter((f) => f.parentId === null)
                                   .sort((a, b) => a.position - b.position)
  const rootBookmarks = tree.bookmarks.filter((b) => b.folderId === null)
                                       .sort((a, b) => a.position - b.position)

  const matches = (b: Bookmark): boolean => {
    if (!filter) return true
    const q = filter.toLowerCase()
    return (b.title || '').toLowerCase().includes(q) || b.url.toLowerCase().includes(q)
  }

  if (tree.folders.length === 0 && tree.bookmarks.length === 0) {
    return <div className="sidepanel-empty">북마크가 비어 있습니다. Ctrl+D 로 추가하세요.</div>
  }

  return (
    <>
      <input
        className="sidepanel-filter"
        placeholder="제목·URL 검색"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="sidepanel-tree">
        {rootFolders.map((f) => (
          <FolderNode
            key={`f-${f.id}`}
            folder={f}
            depth={0}
            tree={tree}
            windowId={windowId}
            active={active}
            matches={matches}
            forceOpen={filter.length > 0}
          />
        ))}
        {rootBookmarks.filter(matches).map((b) => (
          <BookmarkRow key={`b-${b.id}`} bookmark={b} depth={0}
            windowId={windowId} active={active} />
        ))}
      </div>
    </>
  )
}

function FolderNode({ folder, depth, tree, windowId, active, matches, forceOpen }: {
  folder: BookmarkFolder; depth: number; tree: BookmarkTree
  windowId: string; active: TabSummary | null
  matches: (b: Bookmark) => boolean; forceOpen: boolean
}) {
  const [open, setOpen] = useState(false)
  const isOpen = open || forceOpen

  const children = tree.bookmarks.filter((b) => b.folderId === folder.id)
                                 .sort((a, b) => a.position - b.position)
  const subFolders = tree.folders.filter((f) => f.parentId === folder.id)
                                  .sort((a, b) => a.position - b.position)
  const visibleChildren = children.filter(matches)

  return (
    <>
      <button
        className="sidepanel-folder"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="folder-caret">{isOpen ? '▾' : '▸'}</span>
        <span className="folder-ic">📁</span>
        <span className="folder-name">{folder.name}</span>
        <span className="folder-count">{children.length}</span>
      </button>
      {isOpen && (
        <>
          {subFolders.map((sub) => (
            <FolderNode
              key={`f-${sub.id}`}
              folder={sub} depth={depth + 1} tree={tree}
              windowId={windowId} active={active}
              matches={matches} forceOpen={forceOpen}
            />
          ))}
          {visibleChildren.map((b) => (
            <BookmarkRow key={`b-${b.id}`} bookmark={b} depth={depth + 1}
              windowId={windowId} active={active} />
          ))}
        </>
      )}
    </>
  )
}

function BookmarkRow({ bookmark, depth, windowId, active }: {
  bookmark: Bookmark; depth: number; windowId: string; active: TabSummary | null
}) {
  return (
    <a
      className="sidepanel-bookmark"
      href={bookmark.url}
      title={bookmark.url}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={(e) => { e.preventDefault(); openLink(active, windowId, bookmark.url, e) }}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); openLink(active, windowId, bookmark.url, e) } }}
    >
      <img className="sidepanel-favicon" src={faviconOf(bookmark.url)} alt="" />
      <span className="sidepanel-label">{bookmark.title || hostOf(bookmark.url)}</span>
    </a>
  )
}

function HistoryTab({ windowId, active }: { windowId: string; active: TabSummary | null }) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<HistoryEntry[]>([])
  const queryRef = useRef(query)
  queryRef.current = query

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const list = query
        ? await window.browserAPI.history.search(query, 100)
        : await window.browserAPI.history.recent(100)
      if (!cancelled) setItems(list)
    }
    const t = setTimeout(run, 120)
    return () => { cancelled = true; clearTimeout(t) }
  }, [query])

  // 변경 구독은 한 번만(매 키 입력마다 재구독하지 않음) + 최신 query 는 ref 로 읽고,
  // 언마운트/경합 시 stale 결과가 최신 결과를 덮어쓰지 않도록 가드한다.
  useEffect(() => {
    let cancelled = false
    const off = window.browserAPI.history.onChanged(() => {
      void (async () => {
        const q = queryRef.current
        const list = q
          ? await window.browserAPI.history.search(q, 100)
          : await window.browserAPI.history.recent(100)
        if (!cancelled) setItems(list)
      })()
    })
    return () => { cancelled = true; off() }
  }, [])

  const groups = useMemo(() => groupByDay(items), [items])

  return (
    <>
      <input
        className="sidepanel-filter"
        placeholder="이력 검색"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="sidepanel-history">
        {items.length === 0 ? (
          <div className="sidepanel-empty">{query ? '검색 결과 없음' : '아직 방문 기록이 없습니다.'}</div>
        ) : groups.map(([day, list]) => (
          <div key={day} className="sidepanel-history-group">
            <div className="sidepanel-history-day">{day}</div>
            {list.map((h) => (
              <a
                key={h.id}
                className="sidepanel-history-row"
                href={h.url}
                title={h.url}
                onClick={(e) => { e.preventDefault(); openLink(active, windowId, h.url, e) }}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); openLink(active, windowId, h.url, e) } }}
              >
                <img className="sidepanel-favicon" src={faviconOf(h.url)} alt="" />
                <span className="sidepanel-label">{h.title || h.url}</span>
                <button
                  className="sidepanel-history-rm"
                  title="이 항목 삭제"
                  onClick={(ev) => {
                    ev.preventDefault(); ev.stopPropagation()
                    void window.browserAPI.history.remove({ id: h.id })
                  }}
                >×</button>
              </a>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}

function groupByDay(items: HistoryEntry[]): Array<[string, HistoryEntry[]]> {
  const map = new Map<string, HistoryEntry[]>()
  for (const e of items) {
    const day = new Date(e.lastVisitAt).toLocaleDateString('ko-KR', {
      year: 'numeric', month: 'short', day: 'numeric', weekday: 'short',
    })
    const bucket = map.get(day)
    if (bucket) bucket.push(e)
    else map.set(day, [e])
  }
  return Array.from(map.entries())
}

function ReadLaterTab({ windowId, active }: { windowId: string; active: TabSummary | null }) {
  const [items, setItems] = useState<ReadLaterItem[]>([])
  const [showRead, setShowRead] = useState(true)

  useEffect(() => {
    let cancelled = false
    void window.browserAPI.readlater.list().then((l) => { if (!cancelled) setItems(l) })
    const off = window.browserAPI.readlater.onChanged((l) => setItems(l))
    return () => { cancelled = true; off() }
  }, [])

  const unreadCount = items.filter((x) => !x.read).length
  const visible = showRead ? items : items.filter((x) => !x.read)
  const hasRead = items.some((x) => x.read)

  const openItem = (it: ReadLaterItem, ev: React.MouseEvent) => {
    // 열면서 읽음 처리
    if (!it.read) void window.browserAPI.readlater.setRead(it.id, true)
    openLink(active, windowId, it.url, ev)
  }

  if (items.length === 0) {
    return <div className="sidepanel-empty">읽기 목록이 비어 있습니다. 주소창 옆 📖 버튼으로 페이지를 저장하세요.</div>
  }

  return (
    <>
      <div className="rl-bar">
        <span className="rl-count">{unreadCount}개 안 읽음 · 총 {items.length}개</span>
        <div className="rl-bar-actions">
          <button className="rl-toggle" onClick={() => setShowRead((v) => !v)} title="읽은 항목 표시 전환">
            {showRead ? '안 읽은 것만' : '전체 보기'}
          </button>
          {hasRead && (
            <button className="rl-toggle" onClick={() => window.browserAPI.readlater.clearRead()} title="읽은 항목 모두 삭제">
              읽은 항목 비우기
            </button>
          )}
        </div>
      </div>
      <div className="sidepanel-readlater">
        {visible.length === 0 ? (
          <div className="sidepanel-empty">안 읽은 항목이 없습니다.</div>
        ) : visible.map((it) => (
          <div key={it.id} className={`rl-row ${it.read ? 'read' : ''}`}>
            <a
              className="rl-link"
              href={it.url}
              title={it.url}
              onClick={(e) => { e.preventDefault(); openItem(it, e) }}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); openItem(it, e) } }}
            >
              <img className="sidepanel-favicon" src={it.favicon || faviconOf(it.url)} alt="" />
              <span className="rl-text">
                <span className="sidepanel-label">{it.title || hostOf(it.url)}</span>
                <span className="rl-host">{hostOf(it.url)}</span>
              </span>
            </a>
            <button
              className="rl-act"
              title={it.read ? '안 읽음으로 표시' : '읽음으로 표시'}
              onClick={() => window.browserAPI.readlater.setRead(it.id, !it.read)}
            >{it.read ? '↩' : '✓'}</button>
            <button
              className="rl-act rl-rm"
              title="목록에서 삭제"
              onClick={() => window.browserAPI.readlater.remove(it.id)}
            >×</button>
          </div>
        ))}
      </div>
    </>
  )
}

function NotesTab({ side }: { side: 'left' | 'right' }) {
  // 메인 저장(widgets-data)로 승격 — 데이터 내보내기에 포함, localStorage 보다 안전.
  const dataKey = `notes-${side}`
  const legacyKey = `${STORAGE_NOTES}.${side}`
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)

  // 최초 로드: 메인 저장 우선, 비어 있고 옛 localStorage 값이 있으면 1회 마이그레이션
  useEffect(() => {
    let cancelled = false
    void window.browserAPI.widgets.dataGet(dataKey).then((v) => {
      if (cancelled) return
      let initial = typeof v === 'string' ? v : ''
      if (!initial) {
        let legacy = ''
        try { legacy = localStorage.getItem(legacyKey) ?? '' } catch { /* ignore */ }
        if (legacy) {
          initial = legacy
          void window.browserAPI.widgets.dataSet(dataKey, legacy)
          try { localStorage.removeItem(legacyKey) } catch { /* ignore */ }
        }
      }
      setText(initial)
      setLoaded(true)
    }).catch(() => setLoaded(true))
    return () => { cancelled = true }
  }, [dataKey, legacyKey])

  // 편집 시 디바운스 저장 (로드 완료 후에만 — 빈 값으로 덮어쓰기 방지)
  useEffect(() => {
    if (!loaded) return
    let saved = false
    const doSave = () => { if (!saved) { saved = true; void window.browserAPI.widgets.dataSet(dataKey, text) } }
    const t = setTimeout(doSave, 300)
    // 패널 닫힘·탭 전환 시에도 마지막 편집을 저장(clearTimeout 만 하면 최근 ≤300ms 입력 유실).
    return () => { clearTimeout(t); doSave() }
  }, [text, dataKey, loaded])

  return (
    <textarea
      className="sidepanel-notes"
      value={text}
      placeholder="여기에 자유롭게 메모하세요. 입력 즉시 저장됩니다."
      onChange={(e) => setText(e.target.value)}
    />
  )
}

// 매일 자동 수집 브리핑 — 수집기별 최신 AI 요약 + 새 항목을 사이드바에서 바로 읽는다.
interface CollectorSummary {
  id: string; name: string; enabled: boolean; sources: string[]; scheduleType: string
  time?: string; intervalMinutes?: number; keyword?: string
  lastRunAt?: number; lastCount?: number; lastDigest?: string; seenCount: number
}
interface CollectRunItem { [k: string]: string }

function BriefingTab({ windowId, active }: { windowId: string; active: TabSummary | null }) {
  const [collectors, setCollectors] = useState<CollectorSummary[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [items, setItems] = useState<CollectRunItem[]>([])
  const [running, setRunning] = useState<string | null>(null)

  const reload = () => { void window.browserAPI.ai.collectorList().then(setCollectors) }
  useEffect(() => {
    reload()
    const off1 = window.browserAPI.ai.onCollectorChanged(() => reload())
    const off2 = window.browserAPI.ai.onCollectorRan(() => reload())
    return () => { off1(); off2() }
  }, [])

  const runNow = (id: string) => {
    setRunning(id)
    void window.browserAPI.ai.collectorRun(id).then(() => { reload(); if (expanded === id) void loadItems(id) }).finally(() => setRunning(null))
  }
  const loadItems = async (id: string) => {
    const runs = await window.browserAPI.ai.collectorRuns(id)
    setItems((runs[0]?.items ?? []) as CollectRunItem[])
  }
  const toggle = (id: string) => {
    if (expanded === id) { setExpanded(null); setItems([]) }
    else { setExpanded(id); setItems([]); void loadItems(id) }
  }

  if (collectors.length === 0) {
    return (
      <div className="sidepanel-empty">
        아직 수집기가 없습니다.<br />
        <button className="brf-link" onClick={() => void window.browserAPI.tabs.create(windowId, 'browser://ai-collectors', { background: false })}>
          + 매일 자동 수집 만들기
        </button>
      </div>
    )
  }

  return (
    <div className="sidepanel-briefing">
      {collectors.map((c) => (
        <div key={c.id} className={`brf-card ${c.enabled ? '' : 'off'}`}>
          <div className="brf-head">
            <div className="brf-name">{c.name}{!c.enabled ? <span className="brf-off">꺼짐</span> : null}</div>
            <button className="brf-run" disabled={running === c.id} onClick={() => runNow(c.id)} title="지금 수집">
              {running === c.id ? '수집 중…' : '지금 수집'}
            </button>
          </div>
          <div className="brf-meta">
            {c.lastRunAt ? relTime(c.lastRunAt) : '아직 실행 안 됨'}
            {c.lastCount != null ? ` · 새 ${c.lastCount}건` : ''}
            {c.keyword ? ` · 필터: ${c.keyword}` : ''}
          </div>
          {c.lastDigest ? <div className="brf-digest">{c.lastDigest}</div> : <div className="brf-digest dim">브리핑이 아직 없습니다. “지금 수집”을 눌러보세요.</div>}
          <button className="brf-toggle" onClick={() => toggle(c.id)}>
            {expanded === c.id ? '▾ 항목 접기' : '▸ 수집한 항목 보기'}
          </button>
          {expanded === c.id && (
            <div className="brf-items">
              {items.length === 0 ? <div className="brf-item dim">항목이 없습니다.</div> : items.map((it, i) => {
                const url = it['링크'] || it.link || it.url || ''
                const title = it['제목'] || Object.values(it)[0] || ''
                return url ? (
                  <a key={i} className="brf-item" href={url} title={url}
                    onClick={(e) => { e.preventDefault(); openLink(active, windowId, url, e) }}
                    onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); openLink(active, windowId, url, e) } }}>
                    <img className="sidepanel-favicon" src={faviconOf(url)} alt="" />
                    <span className="sidepanel-label">{title}</span>
                  </a>
                ) : <div key={i} className="brf-item">{title}</div>
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function relTime(ts: number): string {
  const d = Date.now() - ts
  if (d < 60000) return '방금'
  if (d < 3600000) return `${Math.floor(d / 60000)}분 전`
  if (d < 86400000) return `${Math.floor(d / 3600000)}시간 전`
  return `${Math.floor(d / 86400000)}일 전`
}
