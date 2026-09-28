import { useEffect, useRef, useState } from 'react'
import type { OmniboxSuggestion, TabSummary } from '../../shared/types'
import { OmniboxSuggestions } from './OmniboxSuggestions'
import { useOmniboxSuggestions } from '../hooks/useOmniboxSuggestions'
import { ExtensionActions } from './ExtensionActions'
import { useExtensions } from '../hooks/useExtensions'
import { Icon, type IconName } from './Icon'

function siteIcon(url?: string): IconName {
  if (!url || /^browser:/i.test(url)) return 'gear'
  if (/^https:/i.test(url)) return 'lock'
  if (/^http:/i.test(url)) return 'warning'
  return 'globe'
}

interface Props {
  windowId: string
  incognito?: boolean
  active: TabSummary | null
  onOpenDownloads: () => void
  downloadsOpen: boolean
  onToggleDownloads: () => void
  activeDownloads: number
  videoCandidateCount: number
  videoOpen: boolean
  onToggleVideo: () => void
  leftPanelOpen: boolean
  rightPanelOpen: boolean
  workspaceRailOpen: boolean
  onToggleLeftPanel: () => void
  onToggleRightPanel: () => void
  onToggleWorkspaceRail: () => void
  onOpenSiteInfo: (anchorX: number, anchorY: number) => void
  onOpenAi: () => void
  onOpenBookmarkBubble: (anchorX: number, anchorY: number, url: string) => void
}

export function Toolbar({
  windowId, incognito, active, onOpenDownloads,
  downloadsOpen, onToggleDownloads, activeDownloads,
  videoCandidateCount, videoOpen, onToggleVideo,
  leftPanelOpen, rightPanelOpen, workspaceRailOpen,
  onToggleLeftPanel, onToggleRightPanel, onToggleWorkspaceRail,
  onOpenSiteInfo, onOpenAi, onOpenBookmarkBubble,
}: Props) {
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  const [composing, setComposing] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [bookmarked, setBookmarked] = useState(false)
  const [readLaterSaved, setReadLaterSaved] = useState(false)
  const [removedSuggestionIds, setRemovedSuggestionIds] = useState<Set<string>>(new Set())
  const [zoom, setZoom] = useState<{ level: number; factor: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const bookmarkBtnRef = useRef<HTMLButtonElement>(null)
  const extensions = useExtensions()

  useEffect(() => {
    let cancelled = false
    const url = active?.url
    if (!url) { setBookmarked(false); return }
    void window.browserAPI.bookmarks.isBookmarked(url).then((b) => {
      if (!cancelled) setBookmarked(b)
    })
    const off = window.browserAPI.bookmarks.onChanged(() => {
      void window.browserAPI.bookmarks.isBookmarked(url).then((b) => {
        if (!cancelled) setBookmarked(b)
      })
    })
    return () => { cancelled = true; off() }
  }, [active?.url])

  const toggleBookmark = () => {
    if (!active?.url) return
    void window.browserAPI.actions.run('action.bookmark.add', { windowId, tabId: active.id })
  }

  // 별 버튼(또는 Ctrl+D)이 실행되면 메인이 이 탭에 대해 편집 말풍선을 열라고 알려온다 —
  // 좌표는 렌더러만 아는 정보라 여기서 버튼 위치를 다시 재서 넘긴다.
  useEffect(() => {
    const off = window.browserAPI.bookmarks.onBubbleOpen(({ tabId }) => {
      if (!active || tabId !== active.id || !active.url) return
      const r = bookmarkBtnRef.current?.getBoundingClientRect()
      onOpenBookmarkBubble(r?.left ?? 0, r?.bottom ?? 0, active.url)
    })
    return off
  }, [active, onOpenBookmarkBubble])

  useEffect(() => {
    let cancelled = false
    const url = active?.url
    if (!url) { setReadLaterSaved(false); return }
    void window.browserAPI.readlater.isSaved(url).then((s) => { if (!cancelled) setReadLaterSaved(s) })
    const off = window.browserAPI.readlater.onChanged(() => {
      void window.browserAPI.readlater.isSaved(url).then((s) => { if (!cancelled) setReadLaterSaved(s) })
    })
    return () => { cancelled = true; off() }
  }, [active?.url])

  const toggleReadLater = () => {
    if (!active?.url) return
    void window.browserAPI.actions.run('action.readlater.add', { windowId, tabId: active.id })
  }

  // 탭 전환 시 그 탭의 현재 배율을 읽어온다.
  useEffect(() => {
    let cancelled = false
    const id = active?.id
    if (!id) { setZoom(null); return }
    void window.browserAPI.page.zoomGet(id).then((z) => { if (!cancelled) setZoom(z) })
    return () => { cancelled = true }
  }, [active?.id])

  // Ctrl+휠·핀치 줌 또는 다른 곳(단축키·메뉴)에서 배율이 바뀌면 배지 실시간 갱신.
  useEffect(() => {
    const off = window.browserAPI.page.onZoomChanged(({ tabId, level, factor }) => {
      if (tabId !== active?.id) return
      setZoom({ level, factor })
    })
    return off
  }, [active?.id])

  useEffect(() => {
    if (!focused) setValue(active?.url ?? '')
  }, [active, focused])

  useEffect(() => {
    const off = window.browserAPI.omnibox.onFocus(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return off
  }, [])

  // 검색어가 바뀌면 이전 검색에서 삭제한 이력 항목 숨김을 초기화한다.
  useEffect(() => { setRemovedSuggestionIds(new Set()) }, [value])

  const suggestionsRaw = useOmniboxSuggestions(value, windowId, focused && !composing)
  const suggestions = suggestionsRaw.filter((s) => !removedSuggestionIds.has(s.id))

  useEffect(() => { setHighlight(0) }, [suggestions])

  const back = () => active && window.browserAPI.tabs.back(active.id)
  const forward = () => active && window.browserAPI.tabs.forward(active.id)
  const reloadOrStop = () => {
    if (!active) return
    if (active.loading) window.browserAPI.tabs.stop(active.id)
    else window.browserAPI.tabs.reload(active.id)
  }

  // Ctrl+Enter: 입력이 공백·스킴 없는 한 단어면 www.<입력>.com 으로 완성(크롬 표준 동작).
  function ctrlEnterUrl(text: string): string | null {
    const t = text.trim()
    if (!t || /\s/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null
    const bare = t.replace(/^www\./i, '')
    if (!bare) return null
    return `https://www.${bare}.com`
  }

  async function submit(input?: string, newTab?: boolean) {
    const text = (input ?? value).trim()
    if (!text) return
    if (text.startsWith('magnet:?') || /\.torrent(\?|$)/i.test(text)) {
      const id = await window.browserAPI.torrent.add(text)
      if (id) { onOpenDownloads() }
      setValue(''); inputRef.current?.blur()
      return
    }
    // Alt+Enter: 현재 탭을 놔두고 새 탭에 연다 — tabId 를 안 주면 omnibox.navigate 가 새 탭을 만든다.
    await window.browserAPI.omnibox.navigate(windowId, newTab ? undefined : active?.id, text)
    setValue('')
    inputRef.current?.blur()
  }

  function selectSuggestion(target: OmniboxSuggestion, newTab: boolean): void {
    if (target.source === 'tab' && target.tabId) {
      // "탭으로 전환" — 다시 불러오지 않고 이미 열려 있는 그 탭으로 이동한다.
      void window.browserAPI.tabs.activate(target.tabId)
    } else if (target.actionId) {
      void window.browserAPI.actions.run(target.actionId, { windowId, tabId: active?.id })
    } else if (target.url) {
      if (newTab || !active) void window.browserAPI.tabs.create(windowId, target.url)
      else void window.browserAPI.tabs.navigate(active.id, target.url)
    }
    setValue(''); inputRef.current?.blur()
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (composing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.ctrlKey && !e.altKey) {
        const url = ctrlEnterUrl(value)
        if (url) { void submit(url, false); return }
      }
      const target = suggestions[highlight]
      if (target?.url || target?.actionId) selectSuggestion(target, e.altKey)
      else void submit(undefined, e.altKey)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if ((e.key === 'Delete' || e.key === 'Del') && e.shiftKey) {
      // Shift+Delete — 강조된 이력 제안을 방문 기록에서 삭제(크롬 표준 동작).
      const target = suggestions[highlight]
      if (target?.source === 'history' && target.url) {
        e.preventDefault()
        void window.browserAPI.history.remove({ url: target.url })
        setRemovedSuggestionIds((prev) => { const next = new Set(prev); next.add(target.id); return next })
      }
    } else if (e.key === 'Escape') {
      setValue(active?.url ?? '')
      inputRef.current?.blur()
    }
  }

  // 100% 가 아닐 때만 배지 표시 — 기본 배율에서는 크롬처럼 조용히 숨어 있는다.
  const zoomPercent = zoom && Math.abs(zoom.factor - 1) > 0.001 ? Math.round(zoom.factor * 100) : null

  return (
    <div className="toolbar">
      <div className="toolbar-nav">
        <button
          className={`nav-btn workspace-toggle-btn ${workspaceRailOpen ? 'active' : ''}`}
          aria-label={workspaceRailOpen ? '워크스페이스 사이드바 접기' : '워크스페이스 사이드바 펼치기'}
          title={'워크스페이스 사이드바 (좌측) — 색 칩으로 스페이스 전환, + 로 새 스페이스 추가'}
          onClick={onToggleWorkspaceRail}
        ><Icon name="grid" size={16} /></button>
        <button className="nav-btn" aria-label="뒤로" disabled={!active?.canGoBack} onClick={back}><Icon name="back" size={16} /></button>
        <button className="nav-btn" aria-label="앞으로" disabled={!active?.canGoForward} onClick={forward}><Icon name="forward" size={16} /></button>
        <button
          className="nav-btn"
          aria-label={active?.loading ? '중지' : '새로고침'}
          onClick={reloadOrStop}
          disabled={!active}
        >
          {active?.loading ? <Icon name="close" size={16} /> : <Icon name="reload" size={16} />}
        </button>
      </div>
      {incognito && (
        <span className="incognito-badge" title="시크릿 창 — 방문 기록·비밀번호 자동 저장을 남기지 않습니다">
          🕶 시크릿
        </span>
      )}
      <div className="omnibox-wrap">
        <button
          className="site-info-btn"
          aria-label="사이트 정보"
          title="사이트 정보 · 권한"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onOpenSiteInfo(r.left, r.bottom) }}
        ><Icon name={siteIcon(active?.url)} size={13} /></button>
        <input
          ref={inputRef}
          className="omnibox"
          placeholder="검색하거나 URL · 명령 입력 (예: !yt 검색어)"
          value={value}
          style={zoomPercent !== null ? { paddingRight: 52 } : undefined}
          onChange={(e) => setValue(e.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onFocus={(e) => { setFocused(true); e.currentTarget.select() }}
          onBlur={() => setTimeout(() => setFocused(false), 100)}
          onKeyDown={handleKey}
          spellCheck={false}
        />
        {zoomPercent !== null && (
          <button
            className="zoom-badge"
            aria-label={`배율 ${zoomPercent}% — 클릭해서 100%로`}
            title={`배율 ${zoomPercent}% — 클릭해서 기본 배율로`}
            onClick={() => {
              if (!active) return
              void window.browserAPI.page.zoomSet(active.id, 0).then((z) => setZoom(z))
            }}
          >{zoomPercent}%</button>
        )}
        {focused && suggestions.length > 0 && (
          <OmniboxSuggestions
            items={suggestions}
            highlight={highlight}
            onSelect={(item) => selectSuggestion(item, false)}
          />
        )}
      </div>
      <div className="toolbar-actions">
        <button
          className="nav-btn ai-btn"
          aria-label="AI 어시스턴트"
          title="AI 어시스턴트 (Ctrl+Shift+Space) — 이 페이지 요약·질문"
          onClick={onOpenAi}
        >
          <Icon name="sparkle" size={16} />
        </button>
        <button
          className={`nav-btn sidepanel-btn ${leftPanelOpen ? 'active' : ''}`}
          aria-label={leftPanelOpen ? '좌측 사이드 패널 닫기' : '좌측 사이드 패널 열기'}
          title={'좌측 사이드 패널 (Ctrl+B) — 북마크·이력·메모'}
          onClick={onToggleLeftPanel}
        >
          <Icon name="panel-left" size={16} />
        </button>
        <button
          className={`nav-btn sidepanel-btn ${rightPanelOpen ? 'active' : ''}`}
          aria-label={rightPanelOpen ? '우측 사이드 패널 닫기' : '우측 사이드 패널 열기'}
          title={'우측 사이드 패널 (Ctrl+Alt+B) — 북마크·이력·메모'}
          onClick={onToggleRightPanel}
        >
          <Icon name="panel-right" size={16} />
        </button>
        <button
          ref={bookmarkBtnRef}
          className={`nav-btn bookmark-btn ${bookmarked ? 'active' : ''}`}
          aria-label={bookmarked ? '북마크 편집' : '북마크 추가'}
          title={bookmarked ? '북마크 편집 (Ctrl+D)' : '북마크에 추가 (Ctrl+D)'}
          onClick={toggleBookmark}
          disabled={!active}
        >
          {bookmarked ? <Icon name="star-filled" size={16} /> : <Icon name="star" size={16} />}
        </button>
        <button
          className={`nav-btn readlater-btn ${readLaterSaved ? 'active' : ''}`}
          aria-label={readLaterSaved ? '읽기 목록에서 제거' : '읽기 목록에 추가'}
          title={readLaterSaved ? '읽기 목록에서 제거' : '읽기 목록에 추가 — 나중에 보기'}
          onClick={toggleReadLater}
          disabled={!active}
        >
          {readLaterSaved ? <Icon name="book" size={16} /> : <Icon name="book-open" size={16} />}
        </button>
        {videoCandidateCount > 0 && (
          <button
            className={`nav-btn video-btn ${videoOpen ? 'active' : ''}`}
            aria-label={videoOpen ? '동영상 사이드바 닫기' : '동영상 사이드바 열기'}
            title={`감지된 동영상 ${videoCandidateCount}개 — 사이드바 열기/닫기`}
            onClick={onToggleVideo}
          >
            <Icon name="play" size={15} />
            <span className="video-count">{videoCandidateCount}</span>
          </button>
        )}
        <ExtensionActions windowId={windowId} extensions={extensions} />
        <button
          className={`nav-btn downloads-btn ${downloadsOpen ? 'active' : ''}`}
          aria-label={downloadsOpen ? '다운로드 사이드바 닫기' : '다운로드 사이드바 열기'}
          title="다운로드 (Ctrl+J) — 사이드바 열기/닫기"
          onClick={onToggleDownloads}
        >
          <Icon name="download" size={16} />
          {activeDownloads > 0 && <span className="video-count">{activeDownloads}</span>}
        </button>
        <button
          className="nav-btn"
          aria-label="명령 팔레트"
          title="명령 팔레트 (Ctrl+Shift+P)"
          onClick={() => window.browserAPI.actions.run('action.palette.open', { windowId, tabId: active?.id })}
        >
          <Icon name="command" size={16} />
        </button>
      </div>
    </div>
  )
}
