import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../../shared/ipc-channels'
import { createTab, findTabIdByWebContentsId } from '../../tabs/tab-service'
import { buildSearchUrl } from '../../storage/search-engines'

export function initQuickSearch(): void {
  ipcMain.handle(IPC.quickSearch.open, (e: IpcMainInvokeEvent, args: { query: string }) => {
    const q = (args.query ?? '').trim()
    if (!q) return
    const found = findTabIdByWebContentsId(e.sender.id)
    if (!found) return
    const url = buildSearchUrl(q)
    createTab({ windowId: found.windowId, url })
  })
}
