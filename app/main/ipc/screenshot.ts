import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  captureArea, captureToClipboardOnly, captureViewport, pickAndSaveScreenshot,
} from '../features/screenshot'

export function registerScreenshotIpc(): void {
  ipcMain.handle(IPC.screenshot.capture,
    (_e, { tabId, mode, rect }: { tabId: string; mode: 'viewport' | 'area'; rect?: Electron.Rectangle }) => {
      if (mode === 'area' && rect) return captureArea(tabId, rect)
      return captureViewport(tabId)
    })

  ipcMain.handle(IPC.screenshot.saveToClipboard, (_e, { tabId }: { tabId: string }) =>
    captureToClipboardOnly(tabId))

  ipcMain.handle(IPC.screenshot.saveToFile, (_e, { dataUrl }: { dataUrl: string }) =>
    pickAndSaveScreenshot(dataUrl))
}
