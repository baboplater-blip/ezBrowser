import { useEffect, useRef, useState } from 'react'
import type { Bookmark, BookmarkFolder, BookmarkTree, TabSummary } from '../../shared/types'
import { useChromeOverlay } from '../hooks/useChromeOverlay'

interface Props {
  windowId: string
  active: TabSummary | null
  tree: BookmarkTree
}

function faviconOf(url: string): string {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32` } catch { return '' }
}

function navigateOrOpen(active: TabSummary | null, windowId: string, url: string, e: React.MouseEvent): void {
  if (e.ctrlKey || e.metaKey || e.button === 1) {
    void window.browserAPI.tabs.create(windowId, url, { background: e.shiftKey ? false : true })
    return
  }
  if (active) void window.browserAPI.tabs.navigate(active.id, url)
  else void window.browserAPI.tabs.create(windowId, url)
}

export function BookmarkBar({ windowId, active, tree }: Props) {
  const rootFolders = tree.folders.filter((f) => f.parentId === null)
                                   .sort((a, b) => a.position - b.position)
  const rootBookmarks = tree.bookmarks.filter((b) => b.folderId === null)
                                       .sort((a, b) => a.position - b.position)

  if (rootFolders.length === 0 && rootBookmarks.length === 0) {
    return (
      <div className="bookmark-bar">
        <span className="bookmark-bar-empty">
          북마크가 비어 있습니다. 사이트에서 Ctrl+D 로 추가하세요.
        </span>
        <a
          className="bookmark-bar-manage"
          href="#"
          onClick={(e) => {
            e.preventDefault()
            void window.browserAPI.tabs.create(windowId, 'browser://bookmarks')
          }}
        >
          관리
        </a>
      </div>
    )
  }

  return (
    <div className="bookmark-bar">
      {rootFolders.map((f) => (
        <BookmarkFolderItem
          key={`f-${f.id}`}
          folder={f}
          tree={tree}
          windowId={windowId}
          active={active}
        />
      ))}
      {rootBookmarks.map((b) => (
        <a
          key={`b-${b.id}`}
          className="bookmark-bar-item"
          title={b.url}
          href={b.url}
          onClick={(e) => {
            e.preventDefault()
            navigateOrOpen(active, windowId, b.url, e)
          }}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              navigateOrOpen(active, windowId, b.url, e)
            }
          }}
        >
          <img className="bookmark-bar-favicon" src={faviconOf(b.url)} alt="" />
          <span className="bookmark-bar-label">{b.title || hostOf(b.url)}</span>
        </a>
      ))}
    </div>
  )
}

function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u }
}

function BookmarkFolderItem({ folder, tree, windowId, active }: {
  folder: BookmarkFolder
  tree: BookmarkTree
  windowId: string
  active: TabSummary | null
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 드롭다운은 절대 위치로 페이지 위에 떠야 한다 — 열려 있는 동안 chrome 을 승격한다.
  // (중첩 하위 폴더도 각자 이 훅을 호출하지만 모듈 스코프 카운터가 공유되므로 안전하다.)
  useChromeOverlay(windowId, open)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const children = tree.bookmarks
    .filter((b) => b.folderId === folder.id)
    .sort((a, b) => a.position - b.position)
  const subFolders = tree.folders
    .filter((f) => f.parentId === folder.id)
    .sort((a, b) => a.position - b.position)

  return (
    <div className="bookmark-folder-wrap" ref={ref}>
      <button
        className={`bookmark-bar-item folder ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={folder.name}
      >
        <span className="bookmark-bar-favicon folder-icon">📁</span>
        <span className="bookmark-bar-label">{folder.name}</span>
      </button>
      {open && (
        <div className="bookmark-folder-menu">
          {children.length === 0 && subFolders.length === 0 ? (
            <div className="bookmark-folder-empty">빈 폴더</div>
          ) : (
            <>
              {subFolders.map((sub) => (
                <BookmarkFolderItem
                  key={`f-${sub.id}`}
                  folder={sub}
                  tree={tree}
                  windowId={windowId}
                  active={active}
                />
              ))}
              {children.map((b) => (
                <a
                  key={`b-${b.id}`}
                  className="bookmark-folder-link"
                  href={b.url}
                  title={b.url}
                  onClick={(e) => {
                    e.preventDefault()
                    setOpen(false)
                    navigateOrOpen(active, windowId, b.url, e)
                  }}
                >
                  <img className="bookmark-bar-favicon" src={faviconOf(b.url)} alt="" />
                  <span className="bookmark-bar-label">{b.title || hostOf(b.url)}</span>
                </a>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
