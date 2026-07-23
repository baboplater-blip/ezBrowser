import { app } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

interface ExportBundle {
  version: 1
  exportedAt: number
  app: { name: string; version: string }
  files: Record<string, { encoding: 'utf-8' | 'base64'; content: string }>
}

const FILES_TO_EXPORT: Array<{ rel: string; encoding: 'utf-8' | 'base64' }> = [
  { rel: 'settings.json', encoding: 'utf-8' },
  { rel: 'keymap.json', encoding: 'utf-8' },
  { rel: 'workspaces.json', encoding: 'utf-8' },
  { rel: 'passwords.json', encoding: 'utf-8' },
  { rel: 'userChrome.css', encoding: 'utf-8' },
  { rel: 'userChrome.js', encoding: 'utf-8' },
  { rel: 'data/bookmarks.db', encoding: 'base64' },
  { rel: 'data/history.db', encoding: 'base64' },
  { rel: 'user-tokens.json', encoding: 'utf-8' },
  { rel: 'macros.json', encoding: 'utf-8' },
  { rel: 'readlater.json', encoding: 'utf-8' },
  { rel: 'widgets-data.json', encoding: 'utf-8' },
  { rel: 'ai-chats.json', encoding: 'utf-8' },
  { rel: 'ai-memory.md', encoding: 'utf-8' },
  { rel: 'ai-agent-tasks.json', encoding: 'utf-8' },
  { rel: 'blog-drafts.json', encoding: 'utf-8' },
  { rel: 'ai-collectors.json', encoding: 'utf-8' },
]

const DIRS_TO_EXPORT: Array<{ rel: string; pattern: RegExp }> = [
  { rel: 'userscripts', pattern: /\.json$/i },
  { rel: 'policies', pattern: /\.json$/i },
]

function userDataPath(rel: string): string {
  return path.join(app.getPath('userData'), rel)
}

export async function exportAllData(): Promise<ExportBundle> {
  const files: ExportBundle['files'] = {}
  for (const { rel, encoding } of FILES_TO_EXPORT) {
    const full = userDataPath(rel)
    if (!existsSync(full)) continue
    try {
      const buf = await readFile(full)
      files[rel] = {
        encoding,
        content: encoding === 'base64' ? buf.toString('base64') : buf.toString('utf-8'),
      }
    } catch (err) {
      console.warn(`[data-sovereignty] export skip ${rel}:`, err)
    }
  }
  for (const { rel, pattern } of DIRS_TO_EXPORT) {
    const fullDir = userDataPath(rel)
    if (!existsSync(fullDir)) continue
    try {
      const entries = await readdir(fullDir)
      for (const entry of entries) {
        if (!pattern.test(entry)) continue
        const entryPath = path.join(fullDir, entry)
        try {
          const buf = await readFile(entryPath, 'utf-8')
          files[`${rel}/${entry}`] = { encoding: 'utf-8', content: buf }
        } catch (err) {
          console.warn(`[data-sovereignty] export skip ${rel}/${entry}:`, err)
        }
      }
    } catch (err) {
      console.warn(`[data-sovereignty] readdir failed ${rel}:`, err)
    }
  }
  return {
    version: 1,
    exportedAt: Date.now(),
    app: { name: app.getName(), version: app.getVersion() },
    files,
  }
}

export interface ImportResult {
  ok: boolean
  restored: number
  errors: string[]
}

function isSafeRelativePath(rel: string): boolean {
  if (path.isAbsolute(rel)) return false
  const normalized = path.normalize(rel).replace(/\\/g, '/')
  if (normalized.startsWith('..')) return false
  if (normalized.includes('/../')) return false
  return true
}

const IMPORT_WHITELIST = new Set<string>([
  'settings.json', 'keymap.json', 'workspaces.json', 'passwords.json',
  'userChrome.css', 'userChrome.js',
  'data/bookmarks.db', 'data/history.db',
  'user-tokens.json', 'macros.json',
  'readlater.json', 'widgets-data.json',
  'ai-chats.json', 'ai-memory.md', 'ai-agent-tasks.json', 'blog-drafts.json', 'ai-collectors.json',
])

function isWhitelisted(rel: string): boolean {
  if (IMPORT_WHITELIST.has(rel)) return true
  if (rel.startsWith('userscripts/') && rel.endsWith('.json')) return true
  if (rel.startsWith('policies/') && rel.endsWith('.json')) return true
  return false
}

export async function importAllData(bundle: ExportBundle): Promise<ImportResult> {
  const result: ImportResult = { ok: true, restored: 0, errors: [] }
  if (!bundle || bundle.version !== 1 || typeof bundle.files !== 'object') {
    return { ok: false, restored: 0, errors: ['bundle version 또는 형식 오류'] }
  }
  for (const [rel, item] of Object.entries(bundle.files)) {
    if (!isSafeRelativePath(rel) || !isWhitelisted(rel)) {
      result.errors.push(`거부됨: ${rel}`)
      continue
    }
    const full = userDataPath(rel)
    try {
      await mkdir(path.dirname(full), { recursive: true })
      if (item.encoding === 'base64') {
        await writeFile(full, Buffer.from(item.content, 'base64'))
      } else {
        await writeFile(full, item.content, 'utf-8')
      }
      result.restored += 1
    } catch (err) {
      result.errors.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (result.errors.length > 0) result.ok = result.restored > 0
  return result
}
