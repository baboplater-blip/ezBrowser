import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  confirmSave, isPasswordStorageAvailable, listPasswords, lookupForOrigin, markUsed,
  normalizeOrigin, passwordEvents, type PendingProposal,
  proposeSave, removePassword, revealPassword, type ConfirmAction,
} from '../features/password'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { findTabIdByWebContentsId, getTabPartition } from '../tabs/tab-service'
import { isTrustedSender } from './trust'

function senderOrigin(e: IpcMainInvokeEvent): string | null {
  try {
    return normalizeOrigin(e.sender.getURL())
  } catch {
    return null
  }
}

// 시크릿 탭에서 온 요청인지 — 자동 저장 제안(proposeSave)만 막는다.
// 자동 "입력"(lookup)은 Chrome 과 동일하게 시크릿 탭에서도 허용.
function isIncognitoSender(e: IpcMainInvokeEvent): boolean {
  const found = findTabIdByWebContentsId(e.sender.id)
  if (!found) return false
  return (getTabPartition(found.tabId) ?? '').startsWith('incognito')
}

export function registerPasswordIpc(): void {
  ipcMain.handle(IPC.password.available, () => isPasswordStorageAvailable())

  ipcMain.handle(IPC.password.list, (e) => {
    if (!isTrustedSender(e)) return []
    return listPasswords()
  })

  ipcMain.handle(IPC.password.reveal, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return null
    const plain = revealPassword(args.id)
    if (plain) markUsed(args.id)
    return plain
  })

  ipcMain.handle(IPC.password.remove, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    removePassword(args.id)
  })

  // content.js 가 sender → main 으로 호출. origin 은 sender URL 에서 강제 유도(변조 방지).
  ipcMain.handle(IPC.password.lookup, (e) => {
    const origin = senderOrigin(e)
    if (!origin) return []
    return lookupForOrigin(origin)
  })

  ipcMain.handle(IPC.password.proposeSave, (e, args: { username: string; password: string }) => {
    // 시크릿 탭은 저장 제안 자체를 하지 않는다 — 사용자 확인 배너도 뜨지 않음(무기록 원칙).
    if (isIncognitoSender(e)) return { status: 'never' }
    const origin = senderOrigin(e)
    if (!origin) return { status: 'invalid' }
    return proposeSave({ origin, username: args.username, password: args.password })
  })

  ipcMain.handle(IPC.password.confirmSave, (e, args: { promptId: string; action: ConfirmAction }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return confirmSave(args.promptId, args.action)
  })

  passwordEvents.on('changed', () => {
    const list = listPasswords()
    for (const ctx of getAllWindows()) {
      ctx.chrome.webContents.send(IPC.password.changed, list)
    }
    broadcastToInternalPages(IPC.password.changed, list)
  })

  passwordEvents.on('prompt', (p: PendingProposal) => {
    for (const ctx of getAllWindows()) {
      ctx.chrome.webContents.send(IPC.password.promptOpen, {
        promptId: p.promptId,
        origin: p.origin,
        username: p.username,
        isUpdate: p.isUpdate,
      })
    }
  })

  passwordEvents.on('prompt-resolved', (promptId: string) => {
    for (const ctx of getAllWindows()) {
      ctx.chrome.webContents.send(IPC.password.promptResolved, { promptId })
    }
  })
}
