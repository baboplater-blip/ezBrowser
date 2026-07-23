import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { exportAllData, importAllData } from '../features/data-sovereignty'
import { isTrustedSender } from './trust'

export function registerDataIpc(): void {
  ipcMain.handle(IPC.data.export, async (e) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return exportAllData()
  })

  ipcMain.handle(IPC.data.import, async (e, args: { bundle: unknown }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return importAllData(args.bundle as Parameters<typeof importAllData>[0])
  })
}
