import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  computeContextForFrame, getUserscript, listUserscripts, registerContextSyncHandler,
  removeUserscript, saveUserscript, setUserscriptEnabled, userscriptEvents, verifyScriptCallable,
} from '../features/userscript'
import { performGmXhr, type GmXhrDetails } from '../features/userscript/gmxhr'
import { getMenuCommand, listMenuCommands, registerMenuCommand } from '../features/userscript/menu'
import { deleteValue, setValue } from '../features/userscript/values'
import { findTabIdByWebContentsId, getWebContentsByTabId } from '../tabs/tab-service'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { isTrustedSender } from './trust'

function tabIdOf(e: IpcMainInvokeEvent): string | null {
  return findTabIdByWebContentsId(e.sender.id)?.tabId ?? null
}

export function registerUserscriptIpc(): void {
  // ===== 관리(browser:// 전용, 신뢰 발신자) =====
  ipcMain.handle(IPC.userscript.list, (e) => {
    if (!isTrustedSender(e)) return []
    return listUserscripts()
  })

  ipcMain.handle(IPC.userscript.get, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return null
    return getUserscript(args.id)
  })

  ipcMain.handle(IPC.userscript.save, async (e, args: { id?: string; source: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return saveUserscript(args)
  })

  ipcMain.handle(IPC.userscript.remove, async (e, args: { id: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    await removeUserscript(args.id)
  })

  ipcMain.handle(IPC.userscript.setEnabled, async (e, args: { id: string; enabled: boolean }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    await setUserscriptEnabled(args.id, args.enabled)
  })

  // 특정 탭에 등록된 메뉴 명령 목록 — UI 연결은 다른 묶음 몫(item 7, 상세는 features/userscript/menu.ts).
  ipcMain.handle(IPC.userscript.menuList, (e, args: { tabId?: string }) => {
    if (!isTrustedSender(e)) return []
    return listMenuCommands(args?.tabId)
  })

  ipcMain.handle(IPC.userscript.menuRun, (e, args: { commandId: string }) => {
    if (!isTrustedSender(e)) return false
    const cmd = args?.commandId ? getMenuCommand(args.commandId) : null
    if (!cmd) return false
    const wc = getWebContentsByTabId(cmd.tabId)
    if (!wc || wc.isDestroyed()) return false
    wc.send(IPC.userscript.menuRunEvent, { id: cmd.scriptId, commandId: cmd.id })
    return true
  })

  userscriptEvents.on('changed', () => {
    const summaries = listUserscripts()
    for (const ctx of getAllWindows()) {
      ctx.chrome.webContents.send(IPC.userscript.changed, summaries)
    }
    broadcastToInternalPages(IPC.userscript.changed, summaries)
  })

  // ===== 콘텐츠(content.js/internal.ts → external-features.ts) 전용 =====
  // isTrustedSender 대신 e.senderFrame 의 실제 URL/프레임으로 재검증한다(password.ts 의
  // senderOrigin 패턴과 동일 — 콘텐츠가 넘긴 값이 아니라 실제 발신 프레임을 신뢰의 근거로 삼는다).

  // document-start 타이밍을 지키려면 preload 의 **최상단(동기)** 에서 호출돼야 하므로 sendSync.
  registerContextSyncHandler()

  ipcMain.handle(IPC.userscript.gmSetValue, (e, args: { id: string; key: string; value: unknown }) => {
    const ok = verifyScriptCallable(args?.id, e, ['GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues', 'GM.getValue', 'GM.setValue', 'GM.deleteValue', 'GM.listValues'])
    if (!ok) return { ok: false, error: '허용되지 않습니다' }
    return setValue(args.id, args.key, args.value)
  })

  ipcMain.handle(IPC.userscript.gmDeleteValue, (e, args: { id: string; key: string }) => {
    const ok = verifyScriptCallable(args?.id, e, ['GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues', 'GM.getValue', 'GM.setValue', 'GM.deleteValue', 'GM.listValues'])
    if (!ok) return { ok: false, error: '허용되지 않습니다' }
    return deleteValue(args.id, args.key)
  })

  ipcMain.handle(IPC.userscript.gmXhr, async (e, args: { id: string; details: GmXhrDetails }) => {
    const ctx = verifyScriptCallable(args?.id, e, ['GM_xmlhttpRequest', 'GM.xmlHttpRequest'])
    if (!ctx) return { ok: false, status: 0, statusText: '허용되지 않습니다', responseText: '', responseHeaders: '', finalUrl: '', error: '허용되지 않습니다' }
    let pageOrigin = ''
    try { pageOrigin = new URL(ctx.frame.url).origin } catch { /* ignore */ }
    return performGmXhr(args.details ?? {}, ctx.us.connect, pageOrigin)
  })

  ipcMain.handle(IPC.userscript.menuRegister, (e, args: { id: string; label: string }) => {
    const ok = verifyScriptCallable(args?.id, e, ['GM_registerMenuCommand'])
    if (!ok) return null
    const tabId = tabIdOf(e)
    if (!tabId) return null
    return registerMenuCommand(args.id, ok.us.name, String(args.label ?? ''), tabId)
  })

  // CDP 하네스 등 preload sendSync 를 직접 트리거하기 어려운 환경을 위한 비동기 대응 채널.
  // 동작은 contextSync 와 완전히 동일(같은 computeContextForFrame) — 타이밍 보장만 다르다.
  ipcMain.handle(IPC.userscript.context, (e) => {
    try {
      const f = e.senderFrame
      const url = f ? f.url : e.sender.getURL()
      const isMainFrame = f ? f.parent === null : true
      return computeContextForFrame(url, isMainFrame)
    } catch {
      return []
    }
  })
}
