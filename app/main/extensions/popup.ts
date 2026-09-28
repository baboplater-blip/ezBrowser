// popup.ts — 확장 액션(툴바 아이콘) 팝업을 **앵커된 소형 창**으로 띄운다.
//
// 왜 (묶음 J, 항목 1): 예전엔 `invokeExtensionAction` 이 `default_popup` 페이지를 그냥 새 **탭**으로
// 열었다 — uBO Lite 의 필터 카운트 팝업, Bitwarden 의 로그인 목록 같은 화면이 주소창까지 있는
// 전체 탭으로 튀어나와 크롬·Cốc Cốc 사용자에게 익숙한 "작은 드롭다운" 경험과 전혀 달랐다.
//
// `electron-chrome-extensions` 라이브러리는 내부적으로 `PopupView`(BrowserWindow 기반 앵커 팝업)를
// 갖고 있지만, 그 경로는 라이브러리 자신의 `<browser-action-list>` 커스텀 엘리먼트가
// `crx-msg-remote` IPC 로 `browserAction.activate` 를 부를 때만 타는 **비공개**(index.d.ts 미노출)
// 구현이라, 우리 외피가 직접 그리는 `ExtensionActions.tsx` 아이콘에서 재사용하려면 라이브러리의
// 내부 웹 컴포넌트·`crx://` 프로토콜까지 통째로 들여와야 한다(버전마다 깨지기 쉬운 비공개 API).
// 그래서 여기서는 **우리 소유의** 작은 BrowserWindow 로 같은 UX 를 직접 구현한다 — 보안 기본값을
// 우리가 직접 통제할 수 있고, 라이브러리 내부 구현 변경에 흔들리지 않는다.
//
// 세션 선택이 핵심이다: 팝업은 그 창의 **활성 탭이 실제로 쓰는 세션**으로 열어야
// `chrome.tabs`/`chrome.storage` 등이 그 탭과 같은 확장 인스턴스를 본다. 그 세션은 이미
// `ensureAdapterFor(ses)` 로 확장 preload 가 세션 단위로 등록돼 있으므로(session-bootstrap 과
// 같은 패턴), 이 창을 그 세션으로 만들기만 하면 `chrome.*` API 가 저절로 따라온다.

import { app, BrowserWindow, screen, session as electronSession } from 'electron'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { getWindow } from '../windows/window-service'
import { getWebContentsByTabId, listTabs } from '../tabs/tab-service'

export interface PopupAnchor { x: number; y: number; width: number; height: number }

interface PopupManifestShape {
  action?: { default_popup?: string }
  browser_action?: { default_popup?: string }
}

const MIN_W = 200
const MIN_H = 120
const MAX_W = 800
const MAX_H = 600
const DEFAULT_W = 360
const DEFAULT_H = 460

// 창마다 팝업 하나. Map<windowId, { win, extId }> — 같은 아이콘을 다시 누르면 토글(닫힘).
const openPopups = new Map<string, { win: BrowserWindow; extId: string }>()

function extensionsRoot(): string {
  return path.join(app.getPath('userData'), 'extensions')
}

/** 이 창의 활성 탭이 실제로 쓰는 세션 — 없으면 defaultSession 으로 안전하게 물러난다. */
function sessionForWindow(windowId: string): Electron.Session {
  try {
    const active = listTabs(windowId).find((t) => t.active)
    const wc = active ? getWebContentsByTabId(active.id) : null
    if (wc && !wc.isDestroyed()) return wc.session
  } catch { /* 창이 막 생겼거나 탭이 없을 수 있다 — 기본 세션으로 폴백 */ }
  return electronSession.defaultSession
}

/** 이미 열린 팝업이 있으면 닫는다. 같은 확장이면 true(토글로 닫은 것)를 돌려준다. */
function closeExisting(windowId: string, extId: string): boolean {
  const existing = openPopups.get(windowId)
  if (!existing) return false
  const wasSame = existing.extId === extId
  openPopups.delete(windowId)
  if (!existing.win.isDestroyed()) existing.win.close()
  return wasSame
}

export function closeExtensionPopup(windowId: string): void {
  const existing = openPopups.get(windowId)
  if (!existing) return
  openPopups.delete(windowId)
  if (!existing.win.isDestroyed()) existing.win.close()
}

/** 확장이 꺼지거나 삭제될 때 — 그 확장의 팝업이 열려 있는 모든 창에서 닫는다. */
export function closeAllPopupsForExtension(extId: string): void {
  for (const [windowId, entry] of [...openPopups]) {
    if (entry.extId !== extId) continue
    openPopups.delete(windowId)
    if (!entry.win.isDestroyed()) entry.win.close()
  }
}

/** manifest 에 popup 이 선언돼 있는가 — 호출부가 팝업/옵션 중 어느 경로로 갈지 미리 판단할 때 쓴다. */
export async function getExtensionPopupPath(extId: string): Promise<string | null> {
  const dir = path.join(extensionsRoot(), extId)
  const manifestPath = path.join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) return null
  try {
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8')) as PopupManifestShape
    return manifest.action?.default_popup ?? manifest.browser_action?.default_popup ?? null
  } catch {
    return null
  }
}

/**
 * 확장 액션 팝업을 앵커 위치에 띄운다.
 * anchor 는 **chrome 셸(WebContentsView) 안 CSS 좌표**(아이콘의 getBoundingClientRect()) —
 * 그 view 는 항상 창 콘텐츠 영역 전체를 덮으므로 창의 content bounds 원점에 그대로 더하면 된다.
 */
export async function openExtensionPopup(
  extId: string, windowId: string, anchor: PopupAnchor,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = getWindow(windowId)
  if (!ctx) return { ok: false, error: 'no window' }

  if (closeExisting(windowId, extId)) return { ok: true } // 토글: 같은 아이콘 재클릭 = 닫기

  const popupPath = await getExtensionPopupPath(extId)
  if (!popupPath) return { ok: false, error: 'no popup' }

  const ses = sessionForWindow(windowId)
  const content = ctx.win.getContentBounds()
  const screenX = Math.round(content.x + anchor.x)
  const screenY = Math.round(content.y + anchor.y + anchor.height)

  let win: BrowserWindow
  try {
    win = new BrowserWindow({
      parent: ctx.win,
      show: false,
      frame: false,
      transparent: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      width: DEFAULT_W,
      height: DEFAULT_H,
      x: screenX,
      y: screenY,
      backgroundColor: '#FFFFFF',
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
      },
    })
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  win.setMenuBarVisibility(false)
  openPopups.set(windowId, { win, extId })

  const close = (): void => { if (!win.isDestroyed()) win.close() }
  win.on('blur', close)
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') close()
  })
  win.on('closed', () => {
    const cur = openPopups.get(windowId)
    if (cur && cur.win === win) openPopups.delete(windowId)
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.warn(`[ext-popup] did-fail-load code=${code} desc=${desc}`)
  })

  const resizeToContent = async (): Promise<void> => {
    if (win.isDestroyed()) return
    let w = DEFAULT_W
    let h = DEFAULT_H
    try {
      const size = await win.webContents.executeJavaScript(
        '({ w: Math.ceil(document.documentElement.scrollWidth || document.body.scrollWidth || 0),'
        + ' h: Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 0) })',
      ) as { w: number; h: number }
      if (size?.w) w = Math.max(MIN_W, Math.min(MAX_W, size.w))
      if (size?.h) h = Math.max(MIN_H, Math.min(MAX_H, size.h))
    } catch { /* 측정 실패 — 기본 크기로 보여준다 */ }
    if (win.isDestroyed()) return
    win.setContentSize(w, h)

    // 화면 밖으로 나가지 않게 클램프 + 아래가 부족하면 아이콘 위로 뒤집는다.
    const display = screen.getDisplayNearestPoint({ x: screenX, y: screenY })
    const area = display.workArea
    let x = screenX
    let y = screenY
    if (x + w > area.x + area.width) x = area.x + area.width - w
    if (x < area.x) x = area.x
    if (y + h > area.y + area.height) {
      const above = screenY - anchor.height - h
      y = above >= area.y ? above : Math.max(area.y, area.y + area.height - h)
    }
    win.setPosition(Math.round(x), Math.round(y))
    if (!win.isDestroyed()) win.show()
  }

  win.webContents.once('did-finish-load', () => { void resizeToContent() })
  // 폰트·이미지 로딩으로 첫 측정 이후 크기가 늘어나는 팝업 대비 한 번 더 측정한다.
  const settleTimer = setTimeout(() => { void resizeToContent() }, 220)
  win.once('closed', () => clearTimeout(settleTimer))

  try {
    await win.loadURL(`chrome-extension://${extId}/${popupPath}`)
  } catch (err) {
    if (!win.isDestroyed()) win.close()
    return { ok: false, error: (err as Error).message }
  }
  return { ok: true }
}
