import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../../shared/ipc-channels'
import { NEW_TAB_URL } from '../../../shared/constants'
import {
  closeTab, createTab, findTabIdByWebContentsId, tabBack, tabForward, tabReload,
} from '../../tabs/tab-service'

type GestureAction = 'back' | 'forward' | 'reload' | 'tab.new' | 'tab.close'

export function initGesture(): void {
  ipcMain.handle(IPC.gesture.exec, (e: IpcMainInvokeEvent, args: { action: GestureAction }) => {
    const found = findTabIdByWebContentsId(e.sender.id)
    if (!found) return
    const { tabId, windowId } = found
    switch (args.action) {
      case 'back': tabBack(tabId); break
      case 'forward': tabForward(tabId); break
      case 'reload': tabReload(tabId); break
      case 'tab.new': createTab({ windowId, url: NEW_TAB_URL }); break
      case 'tab.close': closeTab(tabId); break
    }
  })
}
