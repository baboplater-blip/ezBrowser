import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  addPassword, confirmSave, isPasswordStorageAvailable, listPasswords, lookupForOrigin, markUsed,
  normalizeOrigin, passwordEvents, type PendingProposal,
  proposeSave, removePassword, revealPassword, updatePassword, type ConfirmAction,
} from '../features/password'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { findTabIdByWebContentsId, getTabPartition } from '../tabs/tab-service'
import { isTrustedSender } from './trust'

/**
 * 요청을 **실제로 보낸 프레임**의 origin.
 *
 * 예전에는 `e.sender.getURL()`(= 탭의 **최상위 문서** URL)만 봤다. 그래서 페이지 안에 박힌 다른 출처의
 * iframe 이 content preload 로 lookup 을 부르면, 그 프레임이 아니라 **최상위 페이지의** 자격증명을
 * 돌려줬다 — 광고·위젯 iframe 하나가 그 사이트에 저장된 아이디·비밀번호를 가져갈 수 있는 경로였다.
 * 이제 `senderFrame` 의 URL 을 쓰고, 그것을 읽을 수 없으면 **거부**한다(모르면 주지 않는다).
 */
function senderOrigin(e: IpcMainInvokeEvent): string | null {
  try {
    const f = e.senderFrame
    if (f) {
      let u = ''
      try { u = f.url } catch { u = '' }
      // 프레임 URL 을 못 읽었으면(파괴됨 등) 최상위로 대체하지 않는다 — fail-closed.
      return u ? normalizeOrigin(u) : null
    }
    // senderFrame 자체가 없는 경우(최상위 webContents 직접 호출)만 sender URL 로.
    return normalizeOrigin(e.sender.getURL())
  } catch {
    return null
  }
}

// ===== 런타임 타입 검사 =====
// 신뢰된 sender 라도 인자 모양까지 믿지 않는다. 저장소가 "받은 값을 그대로 파일에 쓰는" 경로였던
// 전례(keymap)가 있어, 사용자 입력이 디스크로 가는 길목마다 형태를 검사한다.
function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
function optString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function optBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
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

  ipcMain.handle(IPC.password.reveal, (e, args: unknown) => {
    if (!isTrustedSender(e)) return null
    const id = optString(asObject(args)?.id)
    if (!id) return null
    const plain = revealPassword(id)
    if (plain) markUsed(id)
    return plain
  })

  ipcMain.handle(IPC.password.remove, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    const o = asObject(args)
    const id = optString(o?.id)
    if (!id) throw new Error('invalid')
    removePassword(id)
  })

  // 선등록 — 신뢰된 내부 페이지(browser://passwords)만. 외부 사이트에는 preload 에서도 노출되지 않는다.
  ipcMain.handle(IPC.password.add, (e, args: unknown) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    const o = asObject(args)
    if (!o) return { ok: false, reason: 'invalid', message: '입력 형식이 올바르지 않습니다.' }
    const origin = optString(o.origin)
    const username = optString(o.username)
    const password = optString(o.password)
    if (origin === undefined || username === undefined || password === undefined) {
      return { ok: false, reason: 'invalid', message: '사이트 주소·사용자명·비밀번호를 모두 입력해 주세요.' }
    }
    return addPassword({ origin, username, password, autoLoginAllowed: optBool(o.autoLoginAllowed) === true })
  })

  ipcMain.handle(IPC.password.update, (e, args: unknown) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    const o = asObject(args)
    const id = optString(o?.id)
    if (!o || !id) return { ok: false, reason: 'invalid', message: '입력 형식이 올바르지 않습니다.' }
    return updatePassword({
      id,
      username: optString(o.username),
      password: optString(o.password),
      autoLoginAllowed: optBool(o.autoLoginAllowed),
      preferred: optBool(o.preferred),
    })
  })

  // content.js 가 sender → main 으로 호출. origin 은 sender URL 에서 강제 유도(변조 방지).
  ipcMain.handle(IPC.password.lookup, (e) => {
    const origin = senderOrigin(e)
    if (!origin) return []
    return lookupForOrigin(origin)
  })

  ipcMain.handle(IPC.password.proposeSave, (e, args: unknown) => {
    // 시크릿 탭은 저장 제안 자체를 하지 않는다 — 사용자 확인 배너도 뜨지 않음(무기록 원칙).
    if (isIncognitoSender(e)) return { status: 'never' }
    const origin = senderOrigin(e)
    if (!origin) return { status: 'invalid' }
    const o = asObject(args)
    const username = optString(o?.username)
    const password = optString(o?.password)
    if (username === undefined || password === undefined) return { status: 'invalid' }
    return proposeSave({ origin, username, password })
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
