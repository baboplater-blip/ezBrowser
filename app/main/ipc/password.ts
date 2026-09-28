import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { IPC } from '../../shared/ipc-channels'
import {
  addPassword, confirmSave, exportPlainForCsv, importPlainFromCsv, isPasswordStorageAvailable,
  listNeverOrigins, listPasswords, lookupForOrigin, markUsed,
  normalizeOrigin, passwordEvents, type PendingProposal,
  proposeSave, removeNeverOrigin, removePassword, revealPassword, updatePassword, type ConfirmAction,
} from '../features/password'
import { buildCsv, parseCsv } from '../features/password/csv'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { findTabIdByWebContentsId, getTabPartition } from '../tabs/tab-service'
import { isTrustedSender } from './trust'

// CSV 가져오기 파일 크기 상한 — 사용자가 직접 네이티브 다이얼로그로 고른 로컬 파일이라 위험은
// 낮지만, 엉뚱한 대용량 파일을 고른 실수까지 방어한다.
const MAX_CSV_BYTES = 5 * 1024 * 1024

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
  ipcMain.handle(IPC.password.available, (e) => {
    if (!isTrustedSender(e)) return false
    return isPasswordStorageAvailable()
  })

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

  // ===== "이 사이트는 저장 안 함" 목록 (관리 페이지) =====

  ipcMain.handle(IPC.password.neverList, (e) => {
    if (!isTrustedSender(e)) return []
    return listNeverOrigins()
  })

  ipcMain.handle(IPC.password.neverRemove, (e, args: unknown) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    const origin = optString(asObject(args)?.origin)
    if (!origin) throw new Error('invalid')
    removeNeverOrigin(origin)
  })

  // ===== CSV (크롬/엣지 호환) — 네이티브 다이얼로그로 경로 선택 =====

  ipcMain.handle(IPC.password.csvExport, async (e) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    const win = BrowserWindow.fromWebContents(e.sender)
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const r = await dialog.showSaveDialog(win ?? new BrowserWindow({ show: false }), {
      title: '비밀번호를 CSV로 내보내기',
      defaultPath: `ezbrowser-passwords-${ts}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
    try {
      const rows = exportPlainForCsv()
      const csv = buildCsv(rows.map((row) => ({ name: '', url: row.origin, username: row.username, password: row.password, note: '' })))
      await writeFile(r.filePath, csv, 'utf-8')
      return { ok: true, canceled: false, path: r.filePath, count: rows.length }
    } catch (err) {
      return { ok: false, canceled: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.password.csvImport, async (e) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    const win = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      title: '비밀번호 CSV 가져오기',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile'],
    })
    const filePath = r.filePaths[0]
    if (r.canceled || !filePath) {
      return { ok: false, canceled: true, imported: 0, updated: 0, skipped: 0, parsed: 0 }
    }
    try {
      const buf = await readFile(filePath)
      if (buf.byteLength > MAX_CSV_BYTES) {
        return {
          ok: false, canceled: false, imported: 0, updated: 0, skipped: 0, parsed: 0,
          error: 'CSV 파일이 너무 큽니다 (5MB 초과).',
        }
      }
      const rows = parseCsv(buf.toString('utf-8'))
      const result = importPlainFromCsv(rows.map((row) => ({ url: row.url, username: row.username, password: row.password })))
      return { ok: true, canceled: false, ...result, parsed: rows.length }
    } catch (err) {
      return {
        ok: false, canceled: false, imported: 0, updated: 0, skipped: 0, parsed: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })

  passwordEvents.on('never-changed', () => {
    const list = listNeverOrigins()
    for (const ctx of getAllWindows()) {
      ctx.chrome.webContents.send(IPC.password.neverChanged, list)
    }
    broadcastToInternalPages(IPC.password.neverChanged, list)
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
