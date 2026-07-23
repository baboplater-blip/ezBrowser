import type { WebContents } from 'electron'
import { IPC } from '../../../shared/ipc-channels'
import { getTab, getWebContentsByTabId } from '../../tabs/tab-service'
import { getWindow } from '../../windows/window-service'

// 탭(webContents) 별 마지막 검색어 — findNext 호출 시 같은 텍스트 재사용
interface FindState {
  windowId: string
  lastText: string
}
const findStates = new Map<number, FindState>()

/**
 * 탭 webContents 에 found-in-page 리스너 부착. onTabCreated 훅에서 호출.
 * 결과는 해당 창의 외피(chrome) 로 푸시되어 FindBar 가 매치 수를 표시한다.
 */
export function trackFind(wc: WebContents, tabId: string): void {
  const tab = getTab(tabId)
  const windowId = tab?.windowId
  if (!windowId) return
  findStates.set(wc.id, { windowId, lastText: '' })

  wc.on('found-in-page', (_e, result) => {
    const ctx = getWindow(windowId)
    if (!ctx || ctx.chrome.webContents.isDestroyed()) return
    ctx.chrome.webContents.send(IPC.find.result, {
      tabId,
      requestId: result.requestId,
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
      finalUpdate: result.finalUpdate,
    })
  })

  wc.once('destroyed', () => { findStates.delete(wc.id) })
}

export interface FindOptions {
  forward?: boolean
  findNext?: boolean
  matchCase?: boolean
}

/**
 * 페이지 내 텍스트 검색. 빈 문자열이면 검색 중단·하이라이트 해제.
 * @returns Electron 의 requestId (0 = 검색 중단)
 */
export function startFind(tabId: string, text: string, opts: FindOptions = {}): number {
  const wc = getWebContentsByTabId(tabId)
  if (!wc || wc.isDestroyed()) return 0
  if (!text) {
    wc.stopFindInPage('clearSelection')
    const st = findStates.get(wc.id)
    if (st) st.lastText = ''
    return 0
  }
  const st = findStates.get(wc.id)
  // 같은 텍스트면 findNext=true (다음/이전 매치로 이동), 새 텍스트면 새 검색
  const sameText = st?.lastText === text
  if (st) st.lastText = text
  return wc.findInPage(text, {
    forward: opts.forward ?? true,
    findNext: opts.findNext ?? sameText,
    matchCase: opts.matchCase ?? false,
  })
}

export function stopFind(tabId: string, keepSelection = false): void {
  const wc = getWebContentsByTabId(tabId)
  if (!wc || wc.isDestroyed()) return
  wc.stopFindInPage(keepSelection ? 'keepSelection' : 'clearSelection')
  const st = findStates.get(wc.id)
  if (st) st.lastText = ''
}
