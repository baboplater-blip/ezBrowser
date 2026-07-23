import { ipcMain } from 'electron'
import { IPC } from '../../../shared/ipc-channels'

interface QRCodeLib {
  toDataURL: (text: string, opts?: Record<string, unknown>) => Promise<string>
}

// lazy load — 첫 generate 호출 시점까지 require 지연 (콜드 스타트 단축)
let qrLib: QRCodeLib | null = null
function getQRCode(): QRCodeLib {
  if (qrLib) return qrLib
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  qrLib = require('qrcode') as QRCodeLib
  return qrLib
}

export function initQrcode(): void {
  ipcMain.handle(IPC.qrcode.generate, async (_e, args: { text: string; size?: number }) => {
    const text = (args.text ?? '').trim()
    if (!text) return null
    const size = Math.max(128, Math.min(1024, args.size ?? 256))
    try {
      return await getQRCode().toDataURL(text, {
        width: size, margin: 1,
        color: { dark: '#1a1a1a', light: '#ffffff' },
      })
    } catch (err) {
      console.warn('[qrcode] generate failed', err)
      return null
    }
  })
}
