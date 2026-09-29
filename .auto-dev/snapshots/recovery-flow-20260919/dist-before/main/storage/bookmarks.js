"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bookmarkEvents = void 0;
exports.initBookmarks = initBookmarks;
exports.listBookmarks = listBookmarks;
exports.isBookmarked = isBookmarked;
exports.addBookmark = addBookmark;
exports.removeBookmarkById = removeBookmarkById;
exports.removeBookmarkByUrl = removeBookmarkByUrl;
exports.renameBookmark = renameBookmark;
exports.updateBookmark = updateBookmark;
exports.renameFolder = renameFolder;
exports.moveBookmark = moveBookmark;
exports.createFolder = createFolder;
exports.removeFolder = removeFolder;
exports.exportBookmarksAsHtml = exportBookmarksAsHtml;
exports.importBookmarksFromHtml = importBookmarksFromHtml;
exports.searchBookmarks = searchBookmarks;
const node_events_1 = require("node:events");
const db_1 = require("./db");
let managed = null;
exports.bookmarkEvents = new node_events_1.EventEmitter();
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
];
async function initBookmarks() {
    if (managed)
        return;
    managed = await (0, db_1.openDb)('bookmarks.db', SCHEMA);
}
function getDb() {
    if (!managed)
        throw new Error('bookmarks db not initialised');
    return managed;
}
function emitChanged() {
    exports.bookmarkEvents.emit('changed');
}
function listBookmarks() {
    const { db } = getDb();
    const folders = [];
    const fs = db.exec('SELECT id, name, parent_id, position FROM folders ORDER BY position, id');
    if (fs[0]) {
        for (const row of fs[0].values) {
            folders.push({
                id: row[0],
                name: row[1],
                parentId: row[2] ?? null,
                position: row[3],
            });
        }
    }
    const bookmarks = [];
    const bs = db.exec('SELECT id, url, title, folder_id, position, added_at FROM bookmarks ORDER BY position, id');
    if (bs[0]) {
        for (const row of bs[0].values) {
            bookmarks.push({
                id: row[0],
                url: row[1],
                title: row[2],
                folderId: row[3] ?? null,
                position: row[4],
                addedAt: row[5],
            });
        }
    }
    return { folders, bookmarks };
}
function isBookmarked(url) {
    const { db } = getDb();
    const stmt = db.prepare('SELECT 1 FROM bookmarks WHERE url = ? LIMIT 1');
    stmt.bind([url]);
    const has = stmt.step();
    stmt.free();
    return has;
}
function addBookmark(input) {
    // 호출자(내부 페이지·액션)가 보낸 값을 타입까지 확인한다 — 숫자·객체가 그대로 저장되면
    // 북마크 바가 `new URL(값)` 에서 터진다. (2026-09-07 임무 19 계열)
    if (!input || typeof input !== 'object' || typeof input.url !== 'string' || !input.url.trim()) {
        throw new Error('북마크 주소가 올바르지 않습니다');
    }
    input = {
        url: input.url.trim(),
        title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : input.url.trim(),
        folderId: typeof input.folderId === 'number' ? input.folderId : null,
    };
    const { db, scheduleFlush } = getDb();
    const now = Date.now();
    const folderId = input.folderId ?? null;
    const posRow = db.exec('SELECT COALESCE(MAX(position), -1) + 1 FROM bookmarks WHERE folder_id IS ?', [folderId]);
    const position = posRow[0]?.values[0]?.[0] ?? 0;
    const stmt = db.prepare('INSERT INTO bookmarks (url, title, folder_id, position, added_at) VALUES (?, ?, ?, ?, ?)');
    stmt.run([input.url, input.title, folderId, position, now]);
    stmt.free();
    const idRow = db.exec('SELECT last_insert_rowid()');
    const id = idRow[0]?.values[0]?.[0] ?? 0;
    scheduleFlush();
    emitChanged();
    return { id, url: input.url, title: input.title, folderId, position, addedAt: now };
}
function removeBookmarkById(id) {
    const { db, scheduleFlush } = getDb();
    const stmt = db.prepare('DELETE FROM bookmarks WHERE id = ?');
    stmt.run([id]);
    stmt.free();
    scheduleFlush();
    emitChanged();
}
function removeBookmarkByUrl(url) {
    const { db, scheduleFlush } = getDb();
    const stmt = db.prepare('DELETE FROM bookmarks WHERE url = ?');
    stmt.run([url]);
    stmt.free();
    scheduleFlush();
    emitChanged();
}
function renameBookmark(id, title) {
    const { db, scheduleFlush } = getDb();
    const stmt = db.prepare('UPDATE bookmarks SET title = ? WHERE id = ?');
    stmt.run([title, id]);
    stmt.free();
    scheduleFlush();
    emitChanged();
}
function updateBookmark(id, patch) {
    const sets = [];
    const params = [];
    if (typeof patch.title === 'string') {
        sets.push('title = ?');
        params.push(patch.title);
    }
    if (typeof patch.url === 'string') {
        sets.push('url = ?');
        params.push(patch.url);
    }
    if (sets.length === 0)
        return;
    const { db, scheduleFlush } = getDb();
    params.push(id);
    const stmt = db.prepare(`UPDATE bookmarks SET ${sets.join(', ')} WHERE id = ?`);
    stmt.run(params);
    stmt.free();
    scheduleFlush();
    emitChanged();
}
function renameFolder(id, name) {
    const { db, scheduleFlush } = getDb();
    const stmt = db.prepare('UPDATE folders SET name = ? WHERE id = ?');
    stmt.run([name, id]);
    stmt.free();
    scheduleFlush();
    emitChanged();
}
function moveBookmark(id, folderId, position) {
    const { db, scheduleFlush } = getDb();
    const stmt = db.prepare('UPDATE bookmarks SET folder_id = ?, position = ? WHERE id = ?');
    stmt.run([folderId, position, id]);
    stmt.free();
    scheduleFlush();
    emitChanged();
}
function createFolder(input) {
    if (!input || typeof input !== 'object' || typeof input.name !== 'string' || !input.name.trim()) {
        throw new Error('폴더 이름이 올바르지 않습니다');
    }
    input = { name: input.name.trim(), parentId: typeof input.parentId === 'number' ? input.parentId : null };
    const { db, scheduleFlush } = getDb();
    const parentId = input.parentId ?? null;
    const posRow = db.exec('SELECT COALESCE(MAX(position), -1) + 1 FROM folders WHERE parent_id IS ?', [parentId]);
    const position = posRow[0]?.values[0]?.[0] ?? 0;
    const stmt = db.prepare('INSERT INTO folders (name, parent_id, position) VALUES (?, ?, ?)');
    stmt.run([input.name, parentId, position]);
    stmt.free();
    const idRow = db.exec('SELECT last_insert_rowid()');
    const id = idRow[0]?.values[0]?.[0] ?? 0;
    scheduleFlush();
    emitChanged();
    return { id, name: input.name, parentId, position };
}
function removeFolder(id) {
    const { db, scheduleFlush } = getDb();
    db.exec('DELETE FROM bookmarks WHERE folder_id = ' + String(id));
    const stmt = db.prepare('DELETE FROM folders WHERE id = ?');
    stmt.run([id]);
    stmt.free();
    scheduleFlush();
    emitChanged();
}
function htmlEscape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function exportBookmarksAsHtml() {
    const { folders, bookmarks } = listBookmarks();
    const childFolders = (parentId) => folders.filter((f) => (f.parentId ?? null) === parentId)
        .sort((a, b) => a.position - b.position);
    const childBookmarks = (folderId) => bookmarks.filter((b) => (b.folderId ?? null) === folderId)
        .sort((a, b) => a.position - b.position);
    const lines = [];
    lines.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    lines.push('<!-- This is an automatically generated file by ezBrowser. -->');
    lines.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">');
    lines.push('<TITLE>Bookmarks</TITLE>');
    lines.push('<H1>Bookmarks</H1>');
    function emit(parentId, depth) {
        const indent = '    '.repeat(depth);
        lines.push(`${indent}<DL><p>`);
        for (const f of childFolders(parentId)) {
            lines.push(`${indent}    <DT><H3>${htmlEscape(f.name)}</H3>`);
            emit(f.id, depth + 1);
        }
        for (const b of childBookmarks(parentId)) {
            const addDate = Math.floor(b.addedAt / 1000);
            lines.push(`${indent}    <DT><A HREF="${htmlEscape(b.url)}" ADD_DATE="${addDate}">${htmlEscape(b.title || b.url)}</A>`);
        }
        lines.push(`${indent}</DL><p>`);
    }
    emit(null, 0);
    return lines.join('\n');
}
function importBookmarksFromHtml(html) {
    const result = { folders: 0, bookmarks: 0 };
    const folderStack = [null];
    const tagRe = /<(\/?)(dl|dt|h3|a)\b([^>]*)>([^<]*)/gi;
    let m;
    let pendingFolderName = null;
    while ((m = tagRe.exec(html)) !== null) {
        const closing = m[1] === '/';
        const tag = m[2].toLowerCase();
        const attrs = m[3] ?? '';
        const text = (m[4] ?? '').trim();
        if (tag === 'dl' && !closing) {
            if (pendingFolderName !== null) {
                const parentId = folderStack[folderStack.length - 1] ?? null;
                const created = createFolder({ name: pendingFolderName, parentId });
                result.folders += 1;
                folderStack.push(created.id);
                pendingFolderName = null;
            }
        }
        else if (tag === 'dl' && closing) {
            if (folderStack.length > 1)
                folderStack.pop();
        }
        else if (tag === 'h3' && !closing) {
            pendingFolderName = text || '폴더';
        }
        else if (tag === 'a' && !closing) {
            const hrefMatch = /href\s*=\s*"([^"]+)"/i.exec(attrs);
            if (hrefMatch) {
                const url = hrefMatch[1];
                const title = text || url;
                const folderId = folderStack[folderStack.length - 1] ?? null;
                if (/^https?:|^ftp:|^file:/i.test(url)) {
                    addBookmark({ url, title, folderId });
                    result.bookmarks += 1;
                }
            }
        }
    }
    return result;
}
function searchBookmarks(query, limit = 8) {
    const { db } = getDb();
    const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const out = [];
    const stmt = db.prepare(`SELECT id, url, title, folder_id, position, added_at
       FROM bookmarks
      WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\'
      ORDER BY added_at DESC
      LIMIT ?`);
    stmt.bind([like, like, limit]);
    while (stmt.step()) {
        const row = stmt.get();
        out.push({
            id: row[0], url: row[1], title: row[2],
            folderId: row[3] ?? null, position: row[4], addedAt: row[5],
        });
    }
    stmt.free();
    return out;
}
