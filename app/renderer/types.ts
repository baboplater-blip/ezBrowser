import type { BrowserAPI as PreloadBrowserAPI } from '../preload/chrome'

export type BrowserAPI = PreloadBrowserAPI

declare global {
  interface Window {
    browserAPI: BrowserAPI
  }
}
