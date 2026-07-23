import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  addBookmark, bookmarkEvents, createFolder, exportBookmarksAsHtml,
  importBookmarksFromHtml, isBookmarked, listBookmarks, moveBookmark,
  removeBookmarkById, removeFolder, renameBookmark, renameFolder, updateBookmark,
} from '../storage/bookmarks'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { isTrustedSender } from './trust'

export function registerBookmarksIpc(): void {
  ipcMain.handle(IPC.bookmarks.list, (e) => {
    if (!isTrustedSender(e)) return { folders: [], bookmarks: [] }
    return listBookmarks()
  })

  ipcMain.handle(IPC.bookmarks.add, (e, args: { url: string; title: string; folderId?: number | null }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return addBookmark(args)
  })

  ipcMain.handle(IPC.bookmarks.remove, (e, args: { id: number }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    removeBookmarkById(args.id)
  })

  ipcMain.handle(IPC.bookmarks.rename, (e, args: { id: number; title: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    renameBookmark(args.id, args.title)
  })

  ipcMain.handle(IPC.bookmarks.update, (e, args: { id: number; title?: string; url?: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    updateBookmark(args.id, { title: args.title, url: args.url })
  })

  ipcMain.handle(IPC.bookmarks.move, (e, args: { id: number; folderId: number | null; position: number }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    moveBookmark(args.id, args.folderId, args.position)
  })

  ipcMain.handle(IPC.bookmarks.isBookmarked, (e, args: { url: string }) => {
    if (!isTrustedSender(e)) return false
    return isBookmarked(args.url)
  })

  ipcMain.handle(IPC.bookmarks.folderCreate, (e, args: { name: string; parentId?: number | null }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return createFolder(args)
  })

  ipcMain.handle(IPC.bookmarks.folderRename, (e, args: { id: number; name: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    renameFolder(args.id, args.name)
  })

  ipcMain.handle(IPC.bookmarks.folderRemove, (e, args: { id: number }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    removeFolder(args.id)
  })

  ipcMain.handle(IPC.bookmarks.exportHtml, (e) => {
    if (!isTrustedSender(e)) return ''
    return exportBookmarksAsHtml()
  })

  ipcMain.handle(IPC.bookmarks.importHtml, (e, args: { html: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return importBookmarksFromHtml(args.html)
  })

  bookmarkEvents.on('changed', () => {
    const tree = listBookmarks()
    for (const ctx of getAllWindows()) {
      ctx.chrome.webContents.send(IPC.bookmarks.changed, tree)
    }
    broadcastToInternalPages(IPC.bookmarks.changed, tree)
  })
}
