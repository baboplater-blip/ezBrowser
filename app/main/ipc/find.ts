import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { startFind, stopFind, type FindOptions } from '../features/find'
import { printTab, printTabToPdf, adjustZoom, getZoom } from '../features/page-tools'

export function registerFindIpc(): void {
  ipcMain.handle(IPC.find.start, (_e, { tabId, text, options }: { tabId: string; text: string; options?: FindOptions }) =>
    startFind(tabId, text, options ?? {}))

  ipcMain.handle(IPC.find.stop, (_e, { tabId, keepSelection }: { tabId: string; keepSelection?: boolean }) => {
    stopFind(tabId, keepSelection === true)
  })

  ipcMain.handle(IPC.page.print, (_e, { tabId }: { tabId: string }) => printTab(tabId))
  ipcMain.handle(IPC.page.printToPdf, (_e, { tabId }: { tabId: string }) => printTabToPdf(tabId))

  ipcMain.handle(IPC.page.zoomGet, (_e, { tabId }: { tabId: string }) => getZoom(tabId))
  ipcMain.handle(IPC.page.zoomSet, (_e, { tabId, delta }: { tabId: string; delta: -1 | 0 | 1 }) => adjustZoom(tabId, delta))
}
