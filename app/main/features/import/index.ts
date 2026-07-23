import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, readFile, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { openExternalSqlite } from '../../storage/db'
import { addBookmark, createFolder } from '../../storage/bookmarks'
import { importVisits, type ImportVisit } from '../../storage/history'

/** 렌더러로 넘기는 안전한 소스 정보 (경로는 노출하지 않는다). */
export interface ImportSourcePublic {
  id: string
  browser: string
  profile: string
  hasBookmarks: boolean
  hasHistory: boolean
}

interface ImportSource extends ImportSourcePublic {
  profileDir: string
}

export interface ImportOptions {
  bookmarks: boolean
  history: boolean
}

export interface ImportResult {
  ok: boolean
  bookmarks: number
  folders: number
  history: number
  errors: string[]
}

interface BrowserDef {
  key: string
  name: string
  userDataDirs: string[]
}

// Chrome epoch(1601-01-01) → Unix epoch(1970-01-01) 차이(밀리초)
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000

function browserDefs(): BrowserDef[] {
  const home = os.homedir()
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    return [
      { key: 'chrome', name: 'Chrome', userDataDirs: [path.join(local, 'Google', 'Chrome', 'User Data')] },
      { key: 'edge', name: 'Edge', userDataDirs: [path.join(local, 'Microsoft', 'Edge', 'User Data')] },
      { key: 'brave', name: 'Brave', userDataDirs: [path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')] },
      { key: 'whale', name: 'Whale', userDataDirs: [path.join(local, 'Naver', 'Naver Whale', 'User Data')] },
    ]
  }
  if (process.platform === 'darwin') {
    const as = path.join(home, 'Library', 'Application Support')
    return [
      { key: 'chrome', name: 'Chrome', userDataDirs: [path.join(as, 'Google', 'Chrome')] },
      { key: 'edge', name: 'Edge', userDataDirs: [path.join(as, 'Microsoft Edge')] },
      { key: 'brave', name: 'Brave', userDataDirs: [path.join(as, 'BraveSoftware', 'Brave-Browser')] },
      { key: 'whale', name: 'Whale', userDataDirs: [path.join(as, 'Naver', 'Whale')] },
    ]
  }
  const cfg = path.join(home, '.config')
  return [
    { key: 'chrome', name: 'Chrome', userDataDirs: [path.join(cfg, 'google-chrome')] },
    { key: 'edge', name: 'Edge', userDataDirs: [path.join(cfg, 'microsoft-edge')] },
    { key: 'brave', name: 'Brave', userDataDirs: [path.join(cfg, 'BraveSoftware', 'Brave-Browser')] },
  ]
}

async function detectProfiles(def: BrowserDef): Promise<ImportSource[]> {
  const out: ImportSource[] = []
  for (const ud of def.userDataDirs) {
    if (!existsSync(ud)) continue
    let entries: string[] = []
    try { entries = await readdir(ud) } catch { continue }
    for (const name of entries) {
      // Chromium 프로필 디렉터리: 'Default' 또는 'Profile N'
      if (name !== 'Default' && !/^Profile \d+$/.test(name)) continue
      const dir = path.join(ud, name)
      const hasBookmarks = existsSync(path.join(dir, 'Bookmarks'))
      const hasHistory = existsSync(path.join(dir, 'History'))
      if (!hasBookmarks && !hasHistory) continue
      let display = name
      try {
        const prefRaw = await readFile(path.join(dir, 'Preferences'), 'utf-8')
        const pref = JSON.parse(prefRaw) as { profile?: { name?: string } }
        if (pref?.profile?.name) display = pref.profile.name
      } catch { /* Preferences 없거나 손상 — 폴더명 사용 */ }
      out.push({
        id: `${def.key}::${name}`,
        browser: def.name,
        profile: display,
        profileDir: dir,
        hasBookmarks,
        hasHistory,
      })
    }
  }
  return out
}

async function detectAll(): Promise<ImportSource[]> {
  const defs = browserDefs()
  const all = await Promise.all(defs.map(detectProfiles))
  return all.flat()
}

/** 설치된 Chromium 계열 브라우저의 가져오기 가능한 프로필 목록 (렌더러 안전 형태). */
export async function detectImportSources(): Promise<ImportSourcePublic[]> {
  const sources = await detectAll()
  return sources.map(({ profileDir: _omit, ...pub }) => pub)
}

interface ChromeNode {
  type?: string
  name?: string
  url?: string
  children?: ChromeNode[]
}

function importBookmarkChildren(
  node: ChromeNode,
  parentFolderId: number | null,
  counts: { folders: number; bookmarks: number },
): void {
  const children = node.children ?? []
  for (const child of children) {
    if (child.type === 'folder') {
      const folder = createFolder({ name: child.name || '폴더', parentId: parentFolderId })
      counts.folders += 1
      importBookmarkChildren(child, folder.id, counts)
    } else if (child.type === 'url' && child.url && /^https?:|^ftp:|^file:/i.test(child.url)) {
      addBookmark({ url: child.url, title: child.name || child.url, folderId: parentFolderId })
      counts.bookmarks += 1
    }
  }
}

function importBookmarks(src: ImportSource, result: ImportResult): void {
  const file = path.join(src.profileDir, 'Bookmarks')
  let json: { roots?: Record<string, ChromeNode> }
  try {
    json = JSON.parse(readFileSync(file, 'utf-8')) as { roots?: Record<string, ChromeNode> }
  } catch (err) {
    result.errors.push(`북마크 파일을 읽지 못했습니다: ${(err as Error).message}`)
    return
  }
  const roots = json.roots
  if (!roots) return
  const counts = { folders: 0, bookmarks: 0 }
  const rootFolder = createFolder({ name: `${src.browser}에서 가져온 북마크`, parentId: null })
  counts.folders += 1
  // 북마크 바 — 가져오기 루트 폴더 바로 아래에 평면 배치
  if (roots.bookmark_bar) importBookmarkChildren(roots.bookmark_bar, rootFolder.id, counts)
  // 기타 북마크 / 모바일 북마크 — 하위 폴더로
  if (roots.other?.children?.length) {
    const f = createFolder({ name: '기타 북마크', parentId: rootFolder.id })
    counts.folders += 1
    importBookmarkChildren(roots.other, f.id, counts)
  }
  if (roots.synced?.children?.length) {
    const f = createFolder({ name: '모바일 북마크', parentId: rootFolder.id })
    counts.folders += 1
    importBookmarkChildren(roots.synced, f.id, counts)
  }
  result.bookmarks += counts.bookmarks
  result.folders += counts.folders
}

async function importHistory(src: ImportSource, result: ImportResult): Promise<void> {
  const srcFile = path.join(src.profileDir, 'History')
  if (!existsSync(srcFile)) return
  // 원본은 브라우저가 잠그고 있을 수 있으므로 임시 복사 후 읽는다.
  const tmp = path.join(app.getPath('temp'), `bb-import-history-${process.pid}-${Date.now()}.sqlite`)
  try {
    await copyFile(srcFile, tmp)
  } catch (err) {
    result.errors.push(`방문 기록을 복사하지 못했습니다. 해당 브라우저를 완전히 종료하고 다시 시도하세요. (${(err as Error).message})`)
    return
  }
  try {
    const db = await openExternalSqlite(tmp)
    const entries: ImportVisit[] = []
    try {
      const res = db.exec(
        'SELECT url, title, visit_count, last_visit_time FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT 5000',
      )
      const rows = res[0]?.values ?? []
      for (const row of rows) {
        const url = row[0] as string
        if (!url) continue
        const title = (row[1] as string) || url
        const visitCount = (row[2] as number) || 1
        const chromeTime = (row[3] as number) || 0
        const lastVisitAt = chromeTime > 0
          ? Math.round(chromeTime / 1000) - CHROME_EPOCH_OFFSET_MS
          : Date.now()
        entries.push({ url, title, visitCount, lastVisitAt })
      }
    } finally {
      db.close()
    }
    result.history += importVisits(entries)
  } catch (err) {
    result.errors.push(`방문 기록을 읽지 못했습니다: ${(err as Error).message}`)
  } finally {
    await unlink(tmp).catch(() => { /* 임시 파일 정리 실패는 무시 */ })
  }
}

/** 지정 프로필에서 북마크·방문 기록을 현재 브라우저로 가져온다. */
export async function runImport(sourceId: string, opts: ImportOptions): Promise<ImportResult> {
  const result: ImportResult = { ok: false, bookmarks: 0, folders: 0, history: 0, errors: [] }
  const sources = await detectAll()
  const src = sources.find((s) => s.id === sourceId)
  if (!src) {
    result.errors.push('가져올 프로필을 찾을 수 없습니다.')
    return result
  }
  if (opts.bookmarks && src.hasBookmarks) {
    try { importBookmarks(src, result) } catch (err) {
      result.errors.push(`북마크 가져오기 실패: ${(err as Error).message}`)
    }
  }
  if (opts.history && src.hasHistory) {
    await importHistory(src, result)
  }
  result.ok = result.bookmarks > 0 || result.history > 0 || result.errors.length === 0
  return result
}
