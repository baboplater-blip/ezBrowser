import { app, dialog, type WebContents } from 'electron'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createStore } from '../../storage/safe-store'
import { getWebContentsByTabId, getTab } from '../../tabs/tab-service'
import { getWindow } from '../../windows/window-service'
import { IPC } from '../../../shared/ipc-channels'
import { getKeymap } from '../../keymap/keymap-service'
import { runAction } from '../../actions/registry'

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80).trim() || 'page'
}

/** 시스템 인쇄 대화상자 열기 */
export function printTab(tabId: string): { ok: boolean; error?: string } {
  const wc = getWebContentsByTabId(tabId)
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'no-webcontents' }
  try {
    wc.print({}, (success, failureReason) => {
      if (!success) console.warn('[page-tools] print failed:', failureReason)
    })
    return { ok: true }
  } catch (err) {
    console.warn('[page-tools] print error', err)
    return { ok: false, error: String(err) }
  }
}

/** 페이지를 PDF 로 저장 (저장 위치 선택 대화상자) */
export async function printTabToPdf(tabId: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const wc = getWebContentsByTabId(tabId)
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'no-webcontents' }
  const tab = getTab(tabId)
  const win = tab?.windowId ? getWindow(tab.windowId)?.win : undefined
  const baseName = sanitizeFilename(tab?.title || 'page')
  const defaultPath = path.join(app.getPath('downloads'), `${baseName}.pdf`)
  try {
    const result = win
      ? await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
      : await dialog.showSaveDialog({ defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (result.canceled || !result.filePath) return { ok: false, error: 'canceled' }
    const data = await wc.printToPDF({ printBackground: true, pageSize: 'A4' })
    await writeFile(result.filePath, data)
    return { ok: true, path: result.filePath }
  } catch (err) {
    console.warn('[page-tools] printToPDF error', err)
    return { ok: false, error: String(err) }
  }
}

/** 페이지를 파일로 저장 (저장 위치 선택 대화상자, 기본 형식 = HTMLComplete: 리소스 포함 완전 저장) */
export async function savePageAs(tabId: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const wc = getWebContentsByTabId(tabId)
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'no-webcontents' }
  const tab = getTab(tabId)
  const win = tab?.windowId ? getWindow(tab.windowId)?.win : undefined
  const baseName = sanitizeFilename(tab?.title || 'page')
  const defaultPath = path.join(app.getPath('downloads'), `${baseName}.html`)
  try {
    const result = win
      ? await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: '웹페이지', extensions: ['html', 'htm'] }] })
      : await dialog.showSaveDialog({ defaultPath, filters: [{ name: '웹페이지', extensions: ['html', 'htm'] }] })
    if (result.canceled || !result.filePath) return { ok: false, error: 'canceled' }
    await wc.savePage(result.filePath, 'HTMLComplete')
    return { ok: true, path: result.filePath }
  } catch (err) {
    console.warn('[page-tools] savePage error', err)
    return { ok: false, error: String(err) }
  }
}

// ===== 사이트별 줌 저장 =====

const ZOOM_MIN = -3
const ZOOM_MAX = 4
const ZOOM_STEP = 0.5

const zoomStore = createStore<{ levels: Record<string, number> }>({ name: 'zoom', defaults: { levels: {} } })

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

function savedZoomFor(origin: string): number {
  const levels = zoomStore.get('levels')
  return typeof levels[origin] === 'number' ? levels[origin]! : 0
}

function persistZoom(origin: string, level: number): void {
  const levels = { ...zoomStore.get('levels') }
  if (Math.abs(level) < 0.001) delete levels[origin]
  else levels[origin] = level
  zoomStore.set('levels', levels)
}

/** 활성 탭의 배율 변경을 외피(Toolbar 배지)에 알림. 탭이 사라졌거나 창을 못 찾으면 조용히 무시. */
function broadcastZoom(tabId: string, level: number, factor: number): void {
  const tab = getTab(tabId)
  if (!tab) return
  const ctx = getWindow(tab.windowId)
  ctx?.chrome.webContents.send(IPC.page.zoomChanged, { tabId, level, factor })
}

/**
 * 탭 webContents 에 줌 복원 + Ctrl+휠/핀치 줌 부착. onTabCreated 훅에서 호출.
 *
 * Electron 은 Ctrl+휠·트랙패드 핀치를 자동으로 확대/축소하지 않는다 — 'zoom-changed' 는
 * "사용자가 요청했다"는 신호일 뿐이라 실제 setZoomLevel 호출은 우리가 해야 한다.
 */
export function trackZoom(wc: WebContents, tabId: string): void {
  const apply = (): void => {
    if (wc.isDestroyed()) return
    try {
      const origin = originOf(wc.getURL())
      const level = origin ? savedZoomFor(origin) : 0
      wc.setZoomLevel(level)
      broadcastZoom(tabId, level, wc.getZoomFactor())
    } catch { /* destroyed mid-call */ }
  }
  const onZoomChanged = (_event: Electron.Event, zoomDirection: 'in' | 'out'): void => {
    if (wc.isDestroyed()) return
    const cur = wc.getZoomLevel()
    let next = zoomDirection === 'in' ? cur + ZOOM_STEP : cur - ZOOM_STEP
    next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next))
    wc.setZoomLevel(next)
    const origin = originOf(wc.getURL())
    if (origin) persistZoom(origin, next)
    broadcastZoom(tabId, next, wc.getZoomFactor())
  }
  wc.on('did-finish-load', apply)
  wc.on('did-navigate', apply)
  wc.on('zoom-changed', onZoomChanged)
  wc.once('destroyed', () => {
    wc.off('did-finish-load', apply)
    wc.off('did-navigate', apply)
    wc.off('zoom-changed', onZoomChanged)
  })
}

/** 줌 단계 조정 (delta: +1 확대 / -1 축소 / 0 초기화) 후 origin 별 저장 */
export function adjustZoom(tabId: string, delta: -1 | 0 | 1): { level: number; factor: number } | null {
  const wc = getWebContentsByTabId(tabId)
  if (!wc || wc.isDestroyed()) return null
  const cur = wc.getZoomLevel()
  let next = delta === 0 ? 0 : cur + delta * ZOOM_STEP
  next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next))
  wc.setZoomLevel(next)
  const origin = originOf(wc.getURL())
  if (origin) persistZoom(origin, next)
  broadcastZoom(tabId, next, wc.getZoomFactor())
  return { level: next, factor: wc.getZoomFactor() }
}

export function getZoom(tabId: string): { level: number; factor: number } | null {
  const wc = getWebContentsByTabId(tabId)
  if (!wc || wc.isDestroyed()) return null
  return { level: wc.getZoomLevel(), factor: wc.getZoomFactor() }
}

// ===== 콘텐츠 포커스 상태에서도 동작해야 하는 표준 단축키 =====
//
// 'when: global' 액션은 chrome(외피) webContents 의 before-input-event(app/main/index.ts) 로만
// 잡히는데, 사용자가 페이지를 클릭한 순간부터는 키보드 포커스가 콘텐츠 WebContentsView 로
// 넘어가 그 리스너가 더는 못 잡는다(네이티브 메뉴 accelerator 로 등록된 액션만 그때도 동작).
// 아래 액션들은 메뉴에 없어도 페이지에 포커스가 있을 때 작동해야 하는 브라우저 표준 단축키라,
// 콘텐츠 webContents 에도 같은 키맵을 직접 물려 runAction 으로 라우팅한다.
const CONTENT_ROUTED_ACTIONS = new Set([
  'action.page.reloadHard',
  'action.page.viewSource',
  'action.page.save',
  'action.find.next',
  'action.find.prev',
  'action.nav.home',
])

function matchesAccel(accel: string, input: Electron.Input): boolean {
  const parts = accel.split('+').map((p) => p.trim().toLowerCase())
  const wantCtrl = parts.includes('ctrl') || parts.includes('cmdorctrl')
  const wantShift = parts.includes('shift')
  const wantAlt = parts.includes('alt')
  const wantMeta = parts.includes('cmd') || parts.includes('meta') || parts.includes('super')
  const key = parts[parts.length - 1] ?? ''
  if (input.control !== wantCtrl) return false
  if (input.shift !== wantShift) return false
  if (input.alt !== wantAlt) return false
  if (input.meta !== wantMeta) return false
  return input.key.toLowerCase() === key
}

/** 탭 webContents 에 표준 단축키(강력 새로고침·소스 보기·페이지 저장·찾기 다음/이전·홈) 부착. onTabCreated 훅에서 호출. */
export function trackPageShortcuts(wc: WebContents, tabId: string): void {
  const onInput = (event: Electron.Event, input: Electron.Input): void => {
    if (input.type !== 'keyDown') return
    if ((input as { isComposing?: boolean }).isComposing) return
    const km = getKeymap()
    for (const binding of km.bindings) {
      if (binding.when !== 'global') continue
      if (!CONTENT_ROUTED_ACTIONS.has(binding.action)) continue
      if (!matchesAccel(binding.key, input)) continue
      event.preventDefault()
      const tab = getTab(tabId)
      void runAction(binding.action, { windowId: tab?.windowId, tabId })
      return
    }
  }
  wc.on('before-input-event', onInput)
  wc.once('destroyed', () => wc.off('before-input-event', onInput))
}
