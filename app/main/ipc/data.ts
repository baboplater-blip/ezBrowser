import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { exportAllData, importAllData, listCodeItems } from '../features/data-sovereignty'
import { isTrustedSender } from './trust'

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
function optString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export function registerDataIpc(): void {
  ipcMain.handle(IPC.data.export, async (e, args: unknown) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    const o = asObject(args)
    return exportAllData({ backupPassword: optString(o?.backupPassword) })
  })

  ipcMain.handle(IPC.data.previewCode, (e, args: unknown) => {
    if (!isTrustedSender(e)) return { codeItems: [] }
    const o = asObject(args)
    const bundle = o?.bundle as Parameters<typeof listCodeItems>[0]
    return { codeItems: listCodeItems(bundle) }
  })

  ipcMain.handle(IPC.data.import, async (e, args: unknown) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    const o = asObject(args)
    return importAllData(o?.bundle as Parameters<typeof importAllData>[0], {
      backupPassword: optString(o?.backupPassword),
      includeCode: o?.includeCode === true,
    })
  })
}
