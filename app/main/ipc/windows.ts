import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { setChromeHeight, setShellInsets } from '../windows/window-service'
import { beginPaneDrag, endPaneDrag, focusPaneByIndex, setPaneSplitRatio } from '../tabs/tab-service'

export function registerWindowsIpc(): void {
  ipcMain.handle(IPC.windows.setChromeHeight, (_e, args: { windowId: string; height: number }) => {
    setChromeHeight(args.windowId, args.height)
  })

  ipcMain.handle(IPC.windows.setShellInsets, (_e, args: {
    windowId: string
    top?: number; right?: number; bottom?: number; left?: number
  }) => {
    setShellInsets(args.windowId, args)
  })

  ipcMain.handle(IPC.windows.setPaneSplitRatio, (_e, args: { windowId: string; ratio: number }) => {
    setPaneSplitRatio(args.windowId, args.ratio)
  })

  ipcMain.handle(IPC.windows.focusPane, (_e, args: { windowId: string; idx: number }) => {
    focusPaneByIndex(args.windowId, args.idx)
  })

  ipcMain.handle(IPC.windows.beginPaneDrag, (_e, args: { windowId: string }) => {
    beginPaneDrag(args.windowId)
  })

  ipcMain.handle(IPC.windows.endPaneDrag, (_e, args: { windowId: string }) => {
    endPaneDrag(args.windowId)
  })
}
