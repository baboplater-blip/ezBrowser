"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.historyEvents = void 0;
exports.initHistory = initHistory;
exports.recordVisit = recordVisit;
exports.importVisits = importVisits;
exports.updateVisitTitle = updateVisitTitle;
exports.recentVisits = recentVisits;
exports.searchHistory = searchHistory;
exports.topSites = topSites;
exports.removeHistoryById = removeHistoryById;
exports.removeHistoryByUrl = removeHistoryByUrl;
exports.clearHistory = clearHistory;
const node_events_1 = require("node:events");
const db_1 = require("./db");
let managed = null;
exports.historyEvents = new node_events_1.EventEmitter();
const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    visit_count INTEGER NOT NULL DEFAULT 1,
    last_visit_at INTEGER NOT NULL,
    UNIQUE(url)
  )`,
    `CREATE INDEX IF NOT EXISTS idx_visits_last_visit ON visits(last_visit_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_visits_count ON visits(visit_count DESC)`,
];
const SKIP_PROTOCOLS = ['browser:', 'chrome:', 'about:', 'devtools:', 'data:', 'javascript:', 'file:'];
const SKIP_HOSTS = new Set(['localhost', '127.0.0.1']);
async function initHistory() {
    if (managed)
        return;
    managed = await (0, db_1.openDb)('history.db', SCHEMA);
}
function getDb() {
    if (!managed)
        throw new Error('history db not initialised');
    return managed;
}
function emitChanged() {
    exports.historyEvents.emit('changed');
}
function shouldSkip(url) {
    if (!url)
        return true;
    const lower = url.toLowerCase();
    if (SKIP_PROTOCOLS.some((p) => lower.startsWith(p)))
        return true;
    try {
        const u = new URL(url);
        if (SKIP_HOSTS.has(u.hostname))
            return true;
    }
    catch {
        return true;
    }
    return false;
}
function recordVisit(input) {
    if (shouldSkip(input.url))
        return;
    if (!managed)
        return;
    const { db, scheduleFlush } = managed;
    const title = (input.title ?? '').slice(0, 500) || input.url;
    const now = Date.now();
    const stmt = db.prepare(`INSERT INTO visits (url, title, visit_count, last_visit_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(url) DO UPDATE SET
       title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE visits.title END,
       visit_count = visits.visit_count + 1,
       last_visit_at = excluded.last_visit_at`);
    stmt.run([input.url, title, now]);
    stmt.free();
    scheduleFlush();
    emitChanged();
}
/**
 * 다른 브라우저(크롬/엣지 등)에서 추출한 방문 기록을 일괄 병합한다.
 * 같은 URL 이 이미 있으면 방문 횟수·최근 방문 시각을 큰 값으로 유지(중복 가져오기 안전).
 * 반환값 = 실제 반영된 행 수.
 */
function importVisits(entries) {
    if (!managed)
        return 0;
    const { db, scheduleFlush } = managed;
    const stmt = db.prepare(`INSERT INTO visits (url, title, visit_count, last_visit_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE visits.title END,
       visit_count = MAX(visits.visit_count, excluded.visit_count),
       last_visit_at = MAX(visits.last_visit_at, excluded.last_visit_at)`);
    let n = 0;
    for (const e of entries) {
        if (shouldSkip(e.url))
            continue;
        const title = (e.title || '').slice(0, 500) || e.url;
        const count = Math.max(1, Math.floor(e.visitCount) || 1);
        const at = Number.isFinite(e.lastVisitAt) && e.lastVisitAt > 0 ? e.lastVisitAt : Date.now();
        stmt.run([e.url, title, count, at]);
        n += 1;
    }
    stmt.free();
    scheduleFlush();
    emitChanged();
    return n;
}
function updateVisitTitle(url, title) {
    if (shouldSkip(url) || !title)
        return;
    if (!managed)
        return;
    const { db, scheduleFlush } = managed;
    const stmt = db.prepare('UPDATE visits SET title = ? WHERE url = ?');
    stmt.run([title.slice(0, 500), url]);
    stmt.free();
    scheduleFlush();
}
function recentVisits(limit = 200) {
    const { db } = getDb();
    const out = [];
    const stmt = db.prepare('SELECT id, url, title, visit_count, last_visit_at FROM visits ORDER BY last_visit_at DESC LIMIT ?');
    stmt.bind([limit]);
    while (stmt.step()) {
        const row = stmt.get();
        out.push({
            id: row[0], url: row[1], title: row[2],
            visitCount: row[3], lastVisitAt: row[4],
        });
    }
    stmt.free();
    return out;
}
function searchHistory(query, limit = 30) {
    const { db } = getDb();
    const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const out = [];
    const stmt = db.prepare(`SELECT id, url, title, visit_count, last_visit_at
       FROM visits
      WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\'
      ORDER BY visit_count DESC, last_visit_at DESC
      LIMIT ?`);
    stmt.bind([like, like, limit]);
    while (stmt.step()) {
        const row = stmt.get();
        out.push({
            id: row[0], url: row[1], title: row[2],
            visitCount: row[3], lastVisitAt: row[4],
        });
    }
    stmt.free();
    return out;
}
function topSites(limit = 12) {
    const { db } = getDb();
    const out = [];
    const stmt = db.prepare(`SELECT url, title, visit_count, last_visit_at
       FROM visits
      ORDER BY visit_count DESC, last_visit_at DESC
      LIMIT ?`);
    stmt.bind([limit]);
    while (stmt.step()) {
        const row = stmt.get();
        out.push({ url: row[0], title: row[1], visitCount: row[2], lastVisitAt: row[3] });
    }
    stmt.free();
    return out;
}
function removeHistoryById(id) {
    const { db, scheduleFlush } = getDb();
    const stmt = db.prepare('DELETE FROM visits WHERE id = ?');
    stmt.run([id]);
    stmt.free();
    scheduleFlush();
    emitChanged();
}
function removeHistoryByUrl(url) {
    const { db, scheduleFlush } = getDb();
    const stmt = db.prepare('DELETE FROM visits WHERE url = ?');
    stmt.run([url]);
    stmt.free();
    scheduleFlush();
    emitChanged();
}
function clearHistory(opts) {
    const { db, scheduleFlush } = getDb();
    if (opts?.sinceMs) {
        const cutoff = Date.now() - opts.sinceMs;
        const stmt = db.prepare('DELETE FROM visits WHERE last_visit_at >= ?');
        stmt.run([cutoff]);
        stmt.free();
    }
    else {
        db.exec('DELETE FROM visits');
    }
    scheduleFlush();
    emitChanged();
}
