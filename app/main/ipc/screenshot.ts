import { IPC } from '../../shared/ipc-channels'
import {
  captureArea, captureToClipboardOnly, captureViewport, pickAndSaveScreenshot,
} from '../features/screenshot'
import { handleTrusted } from './trust'

export function registerScreenshotIpc(): void {
  handleTrusted(IPC.screenshot.capture,
    (_e, { tabId, mode, rect }: { tabId: string; mode: 'viewport' | 'area'; rect?: Electron.Rectangle }) => {
      if (mode === 'area' && rect) return captureArea(tabId, rect)
      return captureViewport(tabId)
    })

  handleTrusted(IPC.screenshot.saveToClipboard, (_e, { tabId }: { tabId: string }) =>
    captureToClipboardOnly(tabId))

  handleTrusted(IPC.screenshot.saveToFile, (_e, { dataUrl }: { dataUrl: string }) =>
    pickAndSaveScreenshot(dataUrl))
}
