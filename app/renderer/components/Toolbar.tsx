import { useEffect, useRef, useState } from 'react'
import type { TabSummary } from '../../shared/types'
import { OmniboxSuggestions } from './OmniboxSuggestions'
import { useOmniboxSuggestions } from '../hooks/useOmniboxSuggestions'
import { ExtensionActions } from './ExtensionActions'
import { useExtensions } from '../hooks/useExtensions'

function siteIcon(url?: string): string {
  if (!url || /^browser:/i.test(url)) return '⚙'
  if (/^https:/i.test(url)) return '🔒'
  if (/^http:/i.test(url)) return '⚠'
  return '🌐'
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
}

export function Toolbar({
  windowId, incognito, active, onOpenDownloads,
  downloadsOpen, onToggleDownloads, activeDownloads,
  videoCandidateCount, videoOpen, onToggleVideo,
  leftPanelOpen, rightPanelOpen, workspaceRailOpen,
  onToggleLeftPanel, onToggleRightPanel, onToggleWorkspaceRail,
  onOpenSiteInfo, onOpenAi,
}: Props) {
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  const [composing, setComposing] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [bookmarked, setBookmarked] = useState(false)
  const [readLaterSaved, setReadLaterSaved] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
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

  const suggestions = useOmniboxSuggestions(value, windowId, focused && !composing)

  useEffect(() => { setHighlight(0) }, [suggestions])

  const back = () => active && window.browserAPI.tabs.back(active.id)
  const forward = () => active && window.browserAPI.tabs.forward(active.id)
  const reloadOrStop = () => {
    if (!active) return
    if (active.loading) window.browserAPI.tabs.stop(active.id)
    else window.browserAPI.tabs.reload(active.id)
  }

  async function submit(input?: string) {
    const text = (input ?? value).trim()
    if (!text) return
    if (text.startsWith('magnet:?') || /\.torrent(\?|$)/i.test(text)) {
      const id = await window.browserAPI.torrent.add(text)
      if (id) { onOpenDownloads() }
      setValue(''); inputRef.current?.blur()
      return
    }
    await window.browserAPI.omnibox.navigate(windowId, active?.id, text)
    setValue('')
    inputRef.current?.blur()
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (composing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      const target = suggestions[highlight]
      if (target?.url) {
        if (target.actionId) {
          void window.browserAPI.actions.run(target.actionId, { windowId, tabId: active?.id })
        } else if (active) {
          void window.browserAPI.tabs.navigate(active.id, target.url)
        } else {
          void window.browserAPI.tabs.create(windowId, target.url)
        }
        setValue(''); inputRef.current?.blur()
      } else {
        void submit()
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Escape') {
      setValue(active?.url ?? '')
      inputRef.current?.blur()
    }
  }

  return (
    <div className="toolbar">
      <div className="toolbar-nav">
        <button
          className={`nav-btn workspace-toggle-btn ${workspaceRailOpen ? 'active' : ''}`}
          aria-label={workspaceRailOpen ? '워크스페이스 사이드바 접기' : '워크스페이스 사이드바 펼치기'}
          title={'워크스페이스 사이드바 (좌측) — 색 칩으로 스페이스 전환, + 로 새 스페이스 추가'}
          onClick={onToggleWorkspaceRail}
        >▦</button>
        <button className="nav-btn" aria-label="뒤로" disabled={!active?.canGoBack} onClick={back}>‹</button>
        <button className="nav-btn" aria-label="앞으로" disabled={!active?.canGoForward} onClick={forward}>›</button>
        <button
          className="nav-btn"
          aria-label={active?.loading ? '중지' : '새로고침'}
          onClick={reloadOrStop}
          disabled={!active}
        >
          {active?.loading ? '×' : '↻'}
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
        >{siteIcon(active?.url)}</button>
        <input
          ref={inputRef}
          className="omnibox"
          placeholder="검색하거나 URL · 명령 입력 (예: !yt 검색어)"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onFocus={(e) => { setFocused(true); e.currentTarget.select() }}
          onBlur={() => setTimeout(() => setFocused(false), 100)}
          onKeyDown={handleKey}
          spellCheck={false}
        />
        {focused && suggestions.length > 0 && (
          <OmniboxSuggestions
            items={suggestions}
            highlight={highlight}
            onSelect={(item) => {
              if (item.actionId) {
                void window.browserAPI.actions.run(item.actionId, { windowId, tabId: active?.id })
              } else if (item.url) {
                if (active) void window.browserAPI.tabs.navigate(active.id, item.url)
                else void window.browserAPI.tabs.create(windowId, item.url)
              }
              setValue(''); inputRef.current?.blur()
            }}
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
          ✨
        </button>
        <button
          className={`nav-btn sidepanel-btn ${leftPanelOpen ? 'active' : ''}`}
          aria-label={leftPanelOpen ? '좌측 사이드 패널 닫기' : '좌측 사이드 패널 열기'}
          title={'좌측 사이드 패널 (Ctrl+B) — 북마크·이력·메모'}
          onClick={onToggleLeftPanel}
        >
          ◧
        </button>
        <button
          className={`nav-btn sidepanel-btn ${rightPanelOpen ? 'active' : ''}`}
          aria-label={rightPanelOpen ? '우측 사이드 패널 닫기' : '우측 사이드 패널 열기'}
          title={'우측 사이드 패널 (Ctrl+Alt+B) — 북마크·이력·메모'}
          onClick={onToggleRightPanel}
        >
          ◨
        </button>
        <button
          className={`nav-btn bookmark-btn ${bookmarked ? 'active' : ''}`}
          aria-label={bookmarked ? '북마크 제거' : '북마크 추가'}
          title={bookmarked ? '북마크 제거 (Ctrl+D)' : '북마크에 추가 (Ctrl+D)'}
          onClick={toggleBookmark}
          disabled={!active}
        >
          {bookmarked ? '★' : '☆'}
        </button>
        <button
          className={`nav-btn readlater-btn ${readLaterSaved ? 'active' : ''}`}
          aria-label={readLaterSaved ? '읽기 목록에서 제거' : '읽기 목록에 추가'}
          title={readLaterSaved ? '읽기 목록에서 제거' : '읽기 목록에 추가 — 나중에 보기'}
          onClick={toggleReadLater}
          disabled={!active}
        >
          {readLaterSaved ? '📚' : '📖'}
        </button>
        {videoCandidateCount > 0 && (
          <button
            className={`nav-btn video-btn ${videoOpen ? 'active' : ''}`}
            aria-label={videoOpen ? '동영상 사이드바 닫기' : '동영상 사이드바 열기'}
            title={`감지된 동영상 ${videoCandidateCount}개 — 사이드바 열기/닫기`}
            onClick={onToggleVideo}
          >
            ▶
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
          ⬇
          {activeDownloads > 0 && <span className="video-count">{activeDownloads}</span>}
        </button>
        <button
          className="nav-btn"
          aria-label="명령 팔레트"
          title="명령 팔레트 (Ctrl+Shift+P)"
          onClick={() => window.browserAPI.actions.run('action.palette.open', { windowId, tabId: active?.id })}
        >
          ⌘
        </button>
      </div>
    </div>
  )
}
