import { app } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  exportPasswordsForBackup, importPasswordsFromBackup, MIN_BACKUP_PASSPHRASE_LENGTH,
  type EncryptedPayload,
} from '../password'

export interface ExportBundle {
  version: 1
  exportedAt: number
  app: { name: string; version: string }
  files: Record<string, { encoding: 'utf-8' | 'base64'; content: string }>
  /**
   * 사용자가 백업 암호를 입력했을 때만 존재한다 — 비밀번호를 그 암호로(scrypt+AES-256-GCM)
   * 재암호화한 이식 가능한 블록. 없으면(암호 미입력) 이 번들에 비밀번호는 포함되지 않는다.
   * (safeStorage 암호문은 이 PC 에서만 풀리므로, 암호 없이 내보내면 다른 PC 는 물론
   *  이 PC 라도 "복원할 수 없는 비밀번호"만 남기는 셈이라 아예 뺀다.)
   */
  passwordsEncrypted?: EncryptedPayload
}

const FILES_TO_EXPORT: Array<{ rel: string; encoding: 'utf-8' | 'base64' }> = [
  { rel: 'settings.json', encoding: 'utf-8' },
  { rel: 'keymap.json', encoding: 'utf-8' },
  { rel: 'workspaces.json', encoding: 'utf-8' },
  // passwords.json(safeStorage 암호문)은 여기 없다 — exportPasswordsForBackup() 이 백업 암호로
  // 재암호화한 값만 bundle.passwordsEncrypted 로 담는다. 아래로.
  { rel: 'password-never-save.json', encoding: 'utf-8' },
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

export interface ExportOptions {
  /** 있으면 비밀번호도 이 암호로 재암호화해 함께 내보낸다(최소 6자). */
  backupPassword?: string
}

export async function exportAllData(opts: ExportOptions = {}): Promise<ExportBundle> {
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

  const bundle: ExportBundle = {
    version: 1,
    exportedAt: Date.now(),
    app: { name: app.getName(), version: app.getVersion() },
    files,
  }

  const backupPassword = typeof opts.backupPassword === 'string' ? opts.backupPassword.trim() : ''
  if (backupPassword) {
    const result = exportPasswordsForBackup(backupPassword)
    if (result) bundle.passwordsEncrypted = result.payload
  }

  return bundle
}

export interface ImportResult {
  ok: boolean
  restored: number
  errors: string[]
  /** 코드 실행 항목인데 `includeCode` 를 안 켜서 건너뛴 항목들(관대한 필터 — 실패 아님). */
  codeItemsSkipped: string[]
  passwordStatus: 'not-present' | 'skipped-no-password' | 'wrong-password' | 'invalid-passphrase' | 'imported'
  passwordImported: number
  passwordUpdated: number
  passwordSkippedRows: number
}

function isSafeRelativePath(rel: string): boolean {
  if (path.isAbsolute(rel)) return false
  const normalized = path.normalize(rel).replace(/\\/g, '/')
  if (normalized.startsWith('..')) return false
  if (normalized.includes('/../')) return false
  return true
}

const IMPORT_WHITELIST = new Set<string>([
  'settings.json', 'keymap.json', 'workspaces.json',
  // 예전 버전이 내보낸 bundle 은 passwords.json(safeStorage 암호문)을 그대로 담고 있었다 —
  // 같은 PC 라면 여전히 복원 가능하므로 하위 호환을 위해 whitelist 에 남긴다(새 export 는 더 이상
  // 이 경로를 쓰지 않는다).
  'passwords.json', 'password-never-save.json',
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

/**
 * 실행 코드를 담을 수 있는 항목인가 — userChrome.js(외피에 주입되는 JS), macros.json(액션
 * 시퀀스, JS 스텝 포함 가능), userscripts/*(정의상 JS), policies/*(customJs 필드로 임의 JS
 * 실행 가능). 이 목록에 들면 가져오기가 **기본적으로 건너뛰고**, 사용자가 명시로 켜야 포함된다.
 */
export function isCodeItem(rel: string): boolean {
  if (rel === 'userChrome.js') return true
  if (rel === 'macros.json') return true
  if (rel.startsWith('userscripts/')) return true
  if (rel.startsWith('policies/')) return true
  return false
}

/** 번들 안에 코드 실행 항목이 있는지 미리 본다(가져오기 확인 UI 용). */
export function listCodeItems(bundle: { files?: Record<string, unknown> } | null | undefined): string[] {
  if (!bundle?.files) return []
  return Object.keys(bundle.files).filter(isCodeItem)
}

export interface ImportOptions {
  /** 번들에 passwordsEncrypted 가 있을 때 풀 암호. 없으면 비밀번호는 건너뛴다. */
  backupPassword?: string
  /** true 여야 userChrome.js·매크로·userscript·정책(customJs) 을 실제로 가져온다. 기본 false. */
  includeCode?: boolean
}

export async function importAllData(bundle: ExportBundle, opts: ImportOptions = {}): Promise<ImportResult> {
  const result: ImportResult = {
    ok: true,
    restored: 0,
    errors: [],
    codeItemsSkipped: [],
    passwordStatus: 'not-present',
    passwordImported: 0,
    passwordUpdated: 0,
    passwordSkippedRows: 0,
  }
  if (!bundle || bundle.version !== 1 || typeof bundle.files !== 'object') {
    return { ...result, ok: false, errors: ['bundle version 또는 형식 오류'] }
  }
  for (const [rel, item] of Object.entries(bundle.files)) {
    if (!isSafeRelativePath(rel) || !isWhitelisted(rel)) {
      result.errors.push(`거부됨: ${rel}`)
      continue
    }
    if (isCodeItem(rel) && opts.includeCode !== true) {
      result.codeItemsSkipped.push(rel)
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

  if (bundle.passwordsEncrypted) {
    const backupPassword = typeof opts.backupPassword === 'string' ? opts.backupPassword.trim() : ''
    if (!backupPassword) {
      result.passwordStatus = 'skipped-no-password'
      result.errors.push('비밀번호 데이터가 포함돼 있지만 백업 암호를 입력하지 않아 건너뛰었습니다.')
    } else {
      const r = importPasswordsFromBackup(bundle.passwordsEncrypted, backupPassword)
      result.passwordStatus = r.status === 'ok' ? 'imported' : r.status
      result.passwordImported = r.imported
      result.passwordUpdated = r.updated
      result.passwordSkippedRows = r.skipped
      result.restored += r.imported + r.updated
      if (r.status === 'wrong-password') {
        result.errors.push('백업 암호가 올바르지 않아 비밀번호를 복원하지 못했습니다.')
      } else if (r.status === 'invalid-passphrase') {
        result.errors.push(`백업 암호는 최소 ${MIN_BACKUP_PASSPHRASE_LENGTH}자 이상이어야 합니다.`)
      }
    }
  }

  if (result.errors.length > 0) result.ok = result.restored > 0
  return result
}
