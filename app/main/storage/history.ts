import { EventEmitter } from 'node:events'
import type { HistoryEntry, TopSite } from '../../shared/types'
import { openDb, type ManagedDb } from './db'

let managed: ManagedDb | null = null

export const historyEvents = new EventEmitter()

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
]

const SKIP_PROTOCOLS = ['browser:', 'chrome:', 'about:', 'devtools:', 'data:', 'javascript:', 'file:']
const SKIP_HOSTS = new Set(['localhost', '127.0.0.1'])

export async function initHistory(): Promise<void> {
  if (managed) return
  managed = await openDb('history.db', SCHEMA)
}

function getDb(): ManagedDb {
  if (!managed) throw new Error('history db not initialised')
  return managed
}

function emitChanged(): void {
  historyEvents.emit('changed')
}

function shouldSkip(url: string): boolean {
  if (!url) return true
  const lower = url.toLowerCase()
  if (SKIP_PROTOCOLS.some((p) => lower.startsWith(p))) return true
  try {
    const u = new URL(url)
    if (SKIP_HOSTS.has(u.hostname)) return true
  } catch {
    return true
  }
  return false
}

export function recordVisit(input: { url: string; title?: string }): void {
  if (shouldSkip(input.url)) return
  if (!managed) return
  const { db, scheduleFlush } = managed
  const title = (input.title ?? '').slice(0, 500) || input.url
  const now = Date.now()
  const stmt = db.prepare(
    `INSERT INTO visits (url, title, visit_count, last_visit_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(url) DO UPDATE SET
       title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE visits.title END,
       visit_count = visits.visit_count + 1,
       last_visit_at = excluded.last_visit_at`,
  )
  stmt.run([input.url, title, now])
  stmt.free()
  scheduleFlush()
  emitChanged()
}

export interface ImportVisit {
  url: string
  title: string
  visitCount: number
  lastVisitAt: number
}

/**
 * 다른 브라우저(크롬/엣지 등)에서 추출한 방문 기록을 일괄 병합한다.
 * 같은 URL 이 이미 있으면 방문 횟수·최근 방문 시각을 큰 값으로 유지(중복 가져오기 안전).
 * 반환값 = 실제 반영된 행 수.
 */
export function importVisits(entries: ImportVisit[]): number {
  if (!managed) return 0
  const { db, scheduleFlush } = managed
  const stmt = db.prepare(
    `INSERT INTO visits (url, title, visit_count, last_visit_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE visits.title END,
       visit_count = MAX(visits.visit_count, excluded.visit_count),
       last_visit_at = MAX(visits.last_visit_at, excluded.last_visit_at)`,
  )
  let n = 0
  for (const e of entries) {
    if (shouldSkip(e.url)) continue
    const title = (e.title || '').slice(0, 500) || e.url
    const count = Math.max(1, Math.floor(e.visitCount) || 1)
    const at = Number.isFinite(e.lastVisitAt) && e.lastVisitAt > 0 ? e.lastVisitAt : Date.now()
    stmt.run([e.url, title, count, at])
    n += 1
  }
  stmt.free()
  scheduleFlush()
  emitChanged()
  return n
}

export function updateVisitTitle(url: string, title: string): void {
  if (shouldSkip(url) || !title) return
  if (!managed) return
  const { db, scheduleFlush } = managed
  const stmt = db.prepare('UPDATE visits SET title = ? WHERE url = ?')
  stmt.run([title.slice(0, 500), url])
  stmt.free()
  scheduleFlush()
}

export function recentVisits(limit = 200): HistoryEntry[] {
  const { db } = getDb()
  const out: HistoryEntry[] = []
  const stmt = db.prepare(
    'SELECT id, url, title, visit_count, last_visit_at FROM visits ORDER BY last_visit_at DESC LIMIT ?',
  )
  stmt.bind([limit])
  while (stmt.step()) {
    const row = stmt.get() as [number, string, string, number, number]
    out.push({
      id: row[0], url: row[1], title: row[2],
      visitCount: row[3], lastVisitAt: row[4],
    })
  }
  stmt.free()
  return out
}

export function searchHistory(query: string, limit = 30): HistoryEntry[] {
  const { db } = getDb()
  const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`
  const out: HistoryEntry[] = []
  const stmt = db.prepare(
    `SELECT id, url, title, visit_count, last_visit_at
       FROM visits
      WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\'
      ORDER BY visit_count DESC, last_visit_at DESC
      LIMIT ?`,
  )
  stmt.bind([like, like, limit])
  while (stmt.step()) {
    const row = stmt.get() as [number, string, string, number, number]
    out.push({
      id: row[0], url: row[1], title: row[2],
      visitCount: row[3], lastVisitAt: row[4],
    })
  }
  stmt.free()
  return out
}

export function topSites(limit = 12): TopSite[] {
  const { db } = getDb()
  const out: TopSite[] = []
  const stmt = db.prepare(
    `SELECT url, title, visit_count, last_visit_at
       FROM visits
      ORDER BY visit_count DESC, last_visit_at DESC
      LIMIT ?`,
  )
  stmt.bind([limit])
  while (stmt.step()) {
    const row = stmt.get() as [string, string, number, number]
    out.push({ url: row[0], title: row[1], visitCount: row[2], lastVisitAt: row[3] })
  }
  stmt.free()
  return out
}

export function removeHistoryById(id: number): void {
  const { db, scheduleFlush } = getDb()
  const stmt = db.prepare('DELETE FROM visits WHERE id = ?')
  stmt.run([id])
  stmt.free()
  scheduleFlush()
  emitChanged()
}

export function removeHistoryByUrl(url: string): void {
  const { db, scheduleFlush } = getDb()
  const stmt = db.prepare('DELETE FROM visits WHERE url = ?')
  stmt.run([url])
  stmt.free()
  scheduleFlush()
  emitChanged()
}

export function clearHistory(opts?: { sinceMs?: number }): void {
  const { db, scheduleFlush } = getDb()
  if (opts?.sinceMs) {
    const cutoff = Date.now() - opts.sinceMs
    const stmt = db.prepare('DELETE FROM visits WHERE last_visit_at >= ?')
    stmt.run([cutoff])
    stmt.free()
  } else {
    db.exec('DELETE FROM visits')
  }
  scheduleFlush()
  emitChanged()
}
