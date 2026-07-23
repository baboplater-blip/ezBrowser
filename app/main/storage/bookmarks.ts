import { EventEmitter } from 'node:events'
import type { Bookmark, BookmarkFolder, BookmarkTree } from '../../shared/types'
import { openDb, type ManagedDb } from './db'

let managed: ManagedDb | null = null

export const bookmarkEvents = new EventEmitter()

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER,
    position INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    folder_id INTEGER,
    position INTEGER NOT NULL DEFAULT 0,
    added_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(url)`,
  `CREATE INDEX IF NOT EXISTS idx_bookmarks_folder ON bookmarks(folder_id)`,
]

export async function initBookmarks(): Promise<void> {
  if (managed) return
  managed = await openDb('bookmarks.db', SCHEMA)
}

function getDb(): ManagedDb {
  if (!managed) throw new Error('bookmarks db not initialised')
  return managed
}

function emitChanged(): void {
  bookmarkEvents.emit('changed')
}

export function listBookmarks(): BookmarkTree {
  const { db } = getDb()
  const folders: BookmarkFolder[] = []
  const fs = db.exec('SELECT id, name, parent_id, position FROM folders ORDER BY position, id')
  if (fs[0]) {
    for (const row of fs[0].values) {
      folders.push({
        id: row[0] as number,
        name: row[1] as string,
        parentId: (row[2] as number | null) ?? null,
        position: row[3] as number,
      })
    }
  }
  const bookmarks: Bookmark[] = []
  const bs = db.exec('SELECT id, url, title, folder_id, position, added_at FROM bookmarks ORDER BY position, id')
  if (bs[0]) {
    for (const row of bs[0].values) {
      bookmarks.push({
        id: row[0] as number,
        url: row[1] as string,
        title: row[2] as string,
        folderId: (row[3] as number | null) ?? null,
        position: row[4] as number,
        addedAt: row[5] as number,
      })
    }
  }
  return { folders, bookmarks }
}

export function isBookmarked(url: string): boolean {
  const { db } = getDb()
  const stmt = db.prepare('SELECT 1 FROM bookmarks WHERE url = ? LIMIT 1')
  stmt.bind([url])
  const has = stmt.step()
  stmt.free()
  return has
}

export function addBookmark(input: { url: string; title: string; folderId?: number | null }): Bookmark {
  const { db, scheduleFlush } = getDb()
  const now = Date.now()
  const folderId = input.folderId ?? null
  const posRow = db.exec('SELECT COALESCE(MAX(position), -1) + 1 FROM bookmarks WHERE folder_id IS ?', [folderId as never])
  const position = (posRow[0]?.values[0]?.[0] as number | undefined) ?? 0
  const stmt = db.prepare(
    'INSERT INTO bookmarks (url, title, folder_id, position, added_at) VALUES (?, ?, ?, ?, ?)',
  )
  stmt.run([input.url, input.title, folderId, position, now])
  stmt.free()
  const idRow = db.exec('SELECT last_insert_rowid()')
  const id = (idRow[0]?.values[0]?.[0] as number) ?? 0
  scheduleFlush()
  emitChanged()
  return { id, url: input.url, title: input.title, folderId, position, addedAt: now }
}

export function removeBookmarkById(id: number): void {
  const { db, scheduleFlush } = getDb()
  const stmt = db.prepare('DELETE FROM bookmarks WHERE id = ?')
  stmt.run([id])
  stmt.free()
  scheduleFlush()
  emitChanged()
}

export function removeBookmarkByUrl(url: string): void {
  const { db, scheduleFlush } = getDb()
  const stmt = db.prepare('DELETE FROM bookmarks WHERE url = ?')
  stmt.run([url])
  stmt.free()
  scheduleFlush()
  emitChanged()
}

export function renameBookmark(id: number, title: string): void {
  const { db, scheduleFlush } = getDb()
  const stmt = db.prepare('UPDATE bookmarks SET title = ? WHERE id = ?')
  stmt.run([title, id])
  stmt.free()
  scheduleFlush()
  emitChanged()
}

export function updateBookmark(id: number, patch: { title?: string; url?: string }): void {
  const sets: string[] = []
  const params: (string | number)[] = []
  if (typeof patch.title === 'string') { sets.push('title = ?'); params.push(patch.title) }
  if (typeof patch.url === 'string') { sets.push('url = ?'); params.push(patch.url) }
  if (sets.length === 0) return
  const { db, scheduleFlush } = getDb()
  params.push(id)
  const stmt = db.prepare(`UPDATE bookmarks SET ${sets.join(', ')} WHERE id = ?`)
  stmt.run(params as never)
  stmt.free()
  scheduleFlush()
  emitChanged()
}

export function renameFolder(id: number, name: string): void {
  const { db, scheduleFlush } = getDb()
  const stmt = db.prepare('UPDATE folders SET name = ? WHERE id = ?')
  stmt.run([name, id])
  stmt.free()
  scheduleFlush()
  emitChanged()
}

export function moveBookmark(id: number, folderId: number | null, position: number): void {
  const { db, scheduleFlush } = getDb()
  const stmt = db.prepare('UPDATE bookmarks SET folder_id = ?, position = ? WHERE id = ?')
  stmt.run([folderId, position, id])
  stmt.free()
  scheduleFlush()
  emitChanged()
}

export function createFolder(input: { name: string; parentId?: number | null }): BookmarkFolder {
  const { db, scheduleFlush } = getDb()
  const parentId = input.parentId ?? null
  const posRow = db.exec('SELECT COALESCE(MAX(position), -1) + 1 FROM folders WHERE parent_id IS ?', [parentId as never])
  const position = (posRow[0]?.values[0]?.[0] as number | undefined) ?? 0
  const stmt = db.prepare('INSERT INTO folders (name, parent_id, position) VALUES (?, ?, ?)')
  stmt.run([input.name, parentId, position])
  stmt.free()
  const idRow = db.exec('SELECT last_insert_rowid()')
  const id = (idRow[0]?.values[0]?.[0] as number) ?? 0
  scheduleFlush()
  emitChanged()
  return { id, name: input.name, parentId, position }
}

export function removeFolder(id: number): void {
  const { db, scheduleFlush } = getDb()
  db.exec('DELETE FROM bookmarks WHERE folder_id = ' + String(id))
  const stmt = db.prepare('DELETE FROM folders WHERE id = ?')
  stmt.run([id])
  stmt.free()
  scheduleFlush()
  emitChanged()
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function exportBookmarksAsHtml(): string {
  const { folders, bookmarks } = listBookmarks()
  const childFolders = (parentId: number | null) =>
    folders.filter((f) => (f.parentId ?? null) === parentId)
           .sort((a, b) => a.position - b.position)
  const childBookmarks = (folderId: number | null) =>
    bookmarks.filter((b) => (b.folderId ?? null) === folderId)
             .sort((a, b) => a.position - b.position)

  const lines: string[] = []
  lines.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>')
  lines.push('<!-- This is an automatically generated file by ezBrowser. -->')
  lines.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">')
  lines.push('<TITLE>Bookmarks</TITLE>')
  lines.push('<H1>Bookmarks</H1>')

  function emit(parentId: number | null, depth: number): void {
    const indent = '    '.repeat(depth)
    lines.push(`${indent}<DL><p>`)
    for (const f of childFolders(parentId)) {
      lines.push(`${indent}    <DT><H3>${htmlEscape(f.name)}</H3>`)
      emit(f.id, depth + 1)
    }
    for (const b of childBookmarks(parentId)) {
      const addDate = Math.floor(b.addedAt / 1000)
      lines.push(`${indent}    <DT><A HREF="${htmlEscape(b.url)}" ADD_DATE="${addDate}">${htmlEscape(b.title || b.url)}</A>`)
    }
    lines.push(`${indent}</DL><p>`)
  }
  emit(null, 0)
  return lines.join('\n')
}

interface ImportResult { folders: number; bookmarks: number }

export function importBookmarksFromHtml(html: string): ImportResult {
  const result: ImportResult = { folders: 0, bookmarks: 0 }
  const folderStack: (number | null)[] = [null]
  const tagRe = /<(\/?)(dl|dt|h3|a)\b([^>]*)>([^<]*)/gi
  let m: RegExpExecArray | null
  let pendingFolderName: string | null = null

  while ((m = tagRe.exec(html)) !== null) {
    const closing = m[1] === '/'
    const tag = m[2]!.toLowerCase()
    const attrs = m[3] ?? ''
    const text = (m[4] ?? '').trim()

    if (tag === 'dl' && !closing) {
      if (pendingFolderName !== null) {
        const parentId = folderStack[folderStack.length - 1] ?? null
        const created = createFolder({ name: pendingFolderName, parentId })
        result.folders += 1
        folderStack.push(created.id)
        pendingFolderName = null
      }
    } else if (tag === 'dl' && closing) {
      if (folderStack.length > 1) folderStack.pop()
    } else if (tag === 'h3' && !closing) {
      pendingFolderName = text || '폴더'
    } else if (tag === 'a' && !closing) {
      const hrefMatch = /href\s*=\s*"([^"]+)"/i.exec(attrs)
      if (hrefMatch) {
        const url = hrefMatch[1]!
        const title = text || url
        const folderId = folderStack[folderStack.length - 1] ?? null
        if (/^https?:|^ftp:|^file:/i.test(url)) {
          addBookmark({ url, title, folderId })
          result.bookmarks += 1
        }
      }
    }
  }
  return result
}

export function searchBookmarks(query: string, limit = 8): Bookmark[] {
  const { db } = getDb()
  const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`
  const out: Bookmark[] = []
  const stmt = db.prepare(
    `SELECT id, url, title, folder_id, position, added_at
       FROM bookmarks
      WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\'
      ORDER BY added_at DESC
      LIMIT ?`,
  )
  stmt.bind([like, like, limit])
  while (stmt.step()) {
    const row = stmt.get() as [number, string, string, number | null, number, number]
    out.push({
      id: row[0], url: row[1], title: row[2],
      folderId: row[3] ?? null, position: row[4], addedAt: row[5],
    })
  }
  stmt.free()
  return out
}
