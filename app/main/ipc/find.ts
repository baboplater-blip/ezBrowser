import { IPC } from '../../shared/ipc-channels'
import { startFind, stopFind, type FindOptions } from '../features/find'
import { printTab, printTabToPdf, adjustZoom, getZoom } from '../features/page-tools'
import { handleTrusted } from './trust'

export function registerFindIpc(): void {
  handleTrusted(IPC.find.start, (_e, { tabId, text, options }: { tabId: string; text: string; options?: FindOptions }) =>
    startFind(tabId, text, options ?? {}))

  handleTrusted(IPC.find.stop, (_e, { tabId, keepSelection }: { tabId: string; keepSelection?: boolean }) => {
    stopFind(tabId, keepSelection === true)
  })

  handleTrusted(IPC.page.print, (_e, { tabId }: { tabId: string }) => printTab(tabId))
  handleTrusted(IPC.page.printToPdf, (_e, { tabId }: { tabId: string }) => printTabToPdf(tabId))

  handleTrusted(IPC.page.zoomGet, (_e, { tabId }: { tabId: string }) => getZoom(tabId))
  handleTrusted(IPC.page.zoomSet, (_e, { tabId, delta }: { tabId: string; delta: -1 | 0 | 1 }) => adjustZoom(tabId, delta))
}
