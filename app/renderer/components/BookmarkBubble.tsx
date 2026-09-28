import { useEffect, useRef, useState } from 'react'
import type { Bookmark, BookmarkFolder } from '../../shared/types'

interface Props {
  windowId: string
  open: boolean
  url: string
  anchor: { x: number; y: number }
  onClose: () => void
}

/**
 * 크롬 스타일 북마크 편집 말풍선 — 별 버튼(또는 Ctrl+D) 클릭 시 열린다.
 * 이미 북마크된 페이지라도 여기선 삭제하지 않는다 — 실제 삭제는 "삭제" 버튼으로만.
 */
export function BookmarkBubble({ windowId: _windowId, open, url, anchor, onClose }: Props) {
  const [bookmark, setBookmark] = useState<Bookmark | null>(null)
  const [folders, setFolders] = useState<BookmarkFolder[]>([])
  const [title, setTitle] = useState('')
  const [folderId, setFolderId] = useState<number | null>(null)
  const loadedRef = useRef(false)

  useEffect(() => {
    if (!open || !url) return
    let cancelled = false
    loadedRef.current = false
    void window.browserAPI.bookmarks.list().then((tree) => {
      if (cancelled) return
      const found = tree.bookmarks.find((b) => b.url === url) ?? null
      setBookmark(found)
      setFolders(tree.folders)
      setTitle(found?.title ?? '')
      setFolderId(found?.folderId ?? null)
      loadedRef.current = true
    })
    return () => { cancelled = true }
  }, [open, url])

  if (!open) return null

  const commitTitle = (): void => {
    if (!bookmark) return
    const t = title.trim() || bookmark.url
    if (t !== bookmark.title) {
      void window.browserAPI.bookmarks.rename(bookmark.id, t)
      setBookmark({ ...bookmark, title: t })
    }
  }

  const commitFolder = (value: string): void => {
    const next = value === '' ? null : Number(value)
    setFolderId(next)
    if (!bookmark) return
    void window.browserAPI.bookmarks.move(bookmark.id, next, 0)
    setBookmark({ ...bookmark, folderId: next })
  }

  const remove = (): void => {
    if (bookmark) void window.browserAPI.bookmarks.remove(bookmark.id)
    onClose()
  }

  const done = (): void => {
    commitTitle()
    onClose()
  }

  const style: React.CSSProperties = {
    top: Math.min(anchor.y + 4, window.innerHeight - 220),
    left: Math.min(Math.max(anchor.x - 220, 8), window.innerWidth - 300),
  }

  return (
    <div className="bm-bubble-backdrop" onMouseDown={done}>
      <div className="bm-bubble" style={style} onMouseDown={(e) => e.stopPropagation()}>
        <div className="bm-bubble-head">
          <span className="bm-bubble-star">★</span>
          <span>{bookmark ? '북마크가 추가됨' : '저장 중…'}</span>
        </div>
        <label className="bm-bubble-field">
          <span>이름</span>
          <input
            className="bm-bubble-input"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); done() }
              else if (e.key === 'Escape') { e.preventDefault(); done() }
            }}
          />
        </label>
        <label className="bm-bubble-field">
          <span>폴더</span>
          <select
            className="bm-bubble-select"
            value={folderId ?? ''}
            onChange={(e) => commitFolder(e.target.value)}
          >
            <option value="">북마크 바</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </label>
        <div className="bm-bubble-actions">
          <button className="bm-bubble-remove" onClick={remove}>삭제</button>
          <button className="bm-bubble-done" onClick={done}>완료</button>
        </div>
      </div>
    </div>
  )
}
