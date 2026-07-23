import { app, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { detectImportSources, runImport } from '../features/import'
import { setNestedSetting } from '../storage/settings'
import { isTrustedSender } from './trust'

export function registerImportIpc(): void {
  ipcMain.handle(IPC.imports.sources, async (e) => {
    if (!isTrustedSender(e)) return []
    return detectImportSources()
  })

  ipcMain.handle(IPC.imports.run, async (e, args: { sourceId: string; bookmarks?: boolean; history?: boolean }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    if (!args?.sourceId) throw new Error('sourceId required')
    return runImport(args.sourceId, {
      bookmarks: args.bookmarks !== false,
      history: args.history !== false,
    })
  })

  // 기본 브라우저 설정 시도 (best-effort — OS 가 사용자 확인을 요구할 수 있음)
  ipcMain.handle(IPC.onboarding.setDefaultBrowser, (e) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    let http = false
    let https = false
    try { http = app.setAsDefaultProtocolClient('http') } catch { /* noop */ }
    try { https = app.setAsDefaultProtocolClient('https') } catch { /* noop */ }
    return { ok: http || https, http, https }
  })

  // 온보딩 완료 표시
  ipcMain.handle(IPC.onboarding.complete, (e) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    setNestedSetting('setup.completed', true)
    setNestedSetting('setup.completedAt', Date.now())
    setNestedSetting('setup.version', app.getVersion())
    return { ok: true }
  })
}
