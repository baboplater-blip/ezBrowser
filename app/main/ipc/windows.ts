import { IPC } from '../../shared/ipc-channels'
import { setChromeHeight, setShellInsets } from '../windows/window-service'
import { beginPaneDrag, endPaneDrag, focusPaneByIndex, setPaneSplitRatio } from '../tabs/tab-service'
import { handleTrusted } from './trust'

export function registerWindowsIpc(): void {
  handleTrusted(IPC.windows.setChromeHeight, (_e, args: { windowId: string; height: number }) => {
    setChromeHeight(args.windowId, args.height)
  })

  handleTrusted(IPC.windows.setShellInsets, (_e, args: {
    windowId: string
    top?: number; right?: number; bottom?: number; left?: number
  }) => {
    setShellInsets(args.windowId, args)
  })

  handleTrusted(IPC.windows.setPaneSplitRatio, (_e, args: { windowId: string; ratio: number }) => {
    setPaneSplitRatio(args.windowId, args.ratio)
  })

  handleTrusted(IPC.windows.focusPane, (_e, args: { windowId: string; idx: number }) => {
    focusPaneByIndex(args.windowId, args.idx)
  })

  handleTrusted(IPC.windows.beginPaneDrag, (_e, args: { windowId: string }) => {
    beginPaneDrag(args.windowId)
  })

  handleTrusted(IPC.windows.endPaneDrag, (_e, args: { windowId: string }) => {
    endPaneDrag(args.windowId)
  })
}
