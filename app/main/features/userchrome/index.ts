import { app, shell } from 'electron'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { IPC } from '../../../shared/ipc-channels'
import type { UserChromeState } from '../../../shared/types'
import { getSetting } from '../../storage/settings'
import { getAllWindows } from '../../windows/window-service'

const DEFAULT_CSS = `/* userChrome.css — 외피 CSS 주입
 * 안전 셀렉터:
 *   .tabbar, .tab, .tab.active, .tab.pinned
 *   .toolbar, .omnibox, .omnibox-suggestions
 *   .sidepanel.left, .sidepanel.right
 *   .command-palette
 * 안전 변수:
 *   --color-bg-base / --color-bg-elevated / --color-bg-sunken
 *   --color-text-primary / --color-accent-primary
 *   --tab-active-bg / --tab-inactive-bg
 *   --density-tabbar-h / --density-toolbar-h
 *
 * 예시 — 활성 탭을 두껍게 강조:
 * .tab.active { font-weight: 700; border-bottom: 2px solid var(--color-accent-primary); }
 */
`

const DEFAULT_JS = `// userChrome.js — 외피 JS 주입 (opt-in)
// 사용 가능한 API: window.browserAPI
// 예시:
//   browserAPI.actions.run('action.tab.new')
`

let cssWatcher: FSWatcher | null = null
let jsWatcher: FSWatcher | null = null
let cssCache = ''
let jsCache = ''
let lastError: string | undefined

function cssPath(): string { return path.join(app.getPath('userData'), 'userChrome.css') }
function jsPath(): string { return path.join(app.getPath('userData'), 'userChrome.js') }

async function ensureFile(p: string, fallback: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true })
  if (!existsSync(p)) await writeFile(p, fallback, 'utf8')
}

async function readSafe(p: string): Promise<string> {
  try { return await readFile(p, 'utf8') } catch { return '' }
}

let debounceTimer: NodeJS.Timeout | null = null

function debouncedBroadcast(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(async () => {
    try {
      cssCache = await readSafe(cssPath())
      jsCache = getSetting('freedom').userChromeJs ? await readSafe(jsPath()) : ''
      lastError = undefined
    } catch (err) {
      lastError = (err as Error).message
    }
    broadcast()
  }, 200)
}

function broadcast(): void {
  for (const ctx of getAllWindows()) {
    ctx.chrome.webContents.send(IPC.userchrome.cssChanged, {
      cssEnabled: getSetting('freedom').userChromeCss,
      jsEnabled: getSetting('freedom').userChromeJs,
      css: cssCache,
      js: jsCache,
      lastError,
    })
  }
}

export async function initUserChrome(): Promise<void> {
  await ensureFile(cssPath(), DEFAULT_CSS)
  await ensureFile(jsPath(), DEFAULT_JS)
  cssCache = await readSafe(cssPath())
  jsCache = getSetting('freedom').userChromeJs ? await readSafe(jsPath()) : ''

  try {
    cssWatcher?.close()
    cssWatcher = watch(cssPath(), () => debouncedBroadcast())
    jsWatcher?.close()
    jsWatcher = watch(jsPath(), () => debouncedBroadcast())
  } catch (err) {
    console.warn('[userchrome] watch failed', err)
  }
}

export async function getUserChromeState(): Promise<UserChromeState> {
  return {
    cssEnabled: getSetting('freedom').userChromeCss,
    cssPath: cssPath(),
    cssContent: cssCache,
    jsEnabled: getSetting('freedom').userChromeJs,
    jsPath: jsPath(),
    jsContent: jsCache,
    lastError,
  }
}

export async function reloadUserChrome(): Promise<void> {
  cssCache = await readSafe(cssPath())
  jsCache = getSetting('freedom').userChromeJs ? await readSafe(jsPath()) : ''
  broadcast()
}

export async function openUserChromeInEditor(kind: 'css' | 'js'): Promise<void> {
  const p = kind === 'css' ? cssPath() : jsPath()
  await ensureFile(p, kind === 'css' ? DEFAULT_CSS : DEFAULT_JS)
  await shell.openPath(p)
}

export async function updateUserChrome(kind: 'css' | 'js', content: string): Promise<void> {
  const p = kind === 'css' ? cssPath() : jsPath()
  await ensureFile(p, '')
  await writeFile(p, content, 'utf8')
  await reloadUserChrome()
}
