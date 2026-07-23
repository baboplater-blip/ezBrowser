import { app, clipboard, dialog, nativeImage } from 'electron'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { getWebContentsByTabId } from '../../tabs/tab-service'

function timestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

async function defaultPicturesPath(): Promise<string> {
  const dir = path.join(app.getPath('pictures'), 'ezBrowser')
  await mkdir(dir, { recursive: true })
  return dir
}

export async function captureViewport(tabId: string, options?: { silent?: boolean }): Promise<string | null> {
  const wc = getWebContentsByTabId(tabId)
  if (!wc) return null
  const img = await wc.capturePage()
  return saveImage(img, options)
}

export async function captureArea(tabId: string, rect: Electron.Rectangle, options?: { silent?: boolean }): Promise<string | null> {
  const wc = getWebContentsByTabId(tabId)
  if (!wc) return null
  const img = await wc.capturePage(rect)
  return saveImage(img, options)
}

async function saveImage(img: Electron.NativeImage, options?: { silent?: boolean }): Promise<string | null> {
  clipboard.writeImage(img)
  if (options?.silent) return null
  const dir = await defaultPicturesPath()
  const file = path.join(dir, `screenshot-${timestamp()}.png`)
  await writeFile(file, img.toPNG())
  return file
}

export async function captureToClipboardOnly(tabId: string): Promise<boolean> {
  const wc = getWebContentsByTabId(tabId)
  if (!wc) return false
  const img = await wc.capturePage()
  clipboard.writeImage(img)
  return true
}

export async function pickAndSaveScreenshot(dataUrl: string): Promise<string | null> {
  const img = nativeImage.createFromDataURL(dataUrl)
  const result = await dialog.showSaveDialog({
    title: '스크린샷 저장',
    defaultPath: path.join(app.getPath('pictures'), `screenshot-${timestamp()}.png`),
    filters: [{ name: 'PNG', extensions: ['png'] }],
  })
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, img.toPNG())
  return result.filePath
}
