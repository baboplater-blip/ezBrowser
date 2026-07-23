import { useEffect, useState } from 'react'
import type { BookmarkTree } from '../../shared/types'

const EMPTY: BookmarkTree = { folders: [], bookmarks: [] }

export function useBookmarks(): BookmarkTree {
  const [tree, setTree] = useState<BookmarkTree>(EMPTY)

  useEffect(() => {
    let cancelled = false
    void window.browserAPI.bookmarks.list().then((t) => {
      if (!cancelled) setTree(t)
    })
    const off = window.browserAPI.bookmarks.onChanged((t) => {
      if (!cancelled) setTree(t)
    })
    return () => { cancelled = true; off() }
  }, [])

  return tree
}
