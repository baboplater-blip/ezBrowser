import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { getSettings, setNestedSetting, onSettingsChange } from '../storage/settings'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { isTrustedSender } from './trust'

// 외피 측에서 ui.* 토글을 위해 chrome WebContentsView 도 trusted 로 인정.
// chrome.ts preload 도 file:// 또는 dev http://localhost 라 isTrustedSender 가 자동 통과.

export function registerSettingsIpc(): void {
  ipcMain.handle(IPC.settings.all, (e) => {
    if (!isTrustedSender(e)) return {}
    return getSettings()
  })

  ipcMain.handle(IPC.settings.get, (e, { key }: { key: string }) => {
    // 외부(http/https) 콘텐츠 페이지는 비민감 콘텐츠 토글(freedom)만 읽을 수 있다.
    // external-features.ts 가 마우스 제스처·빠른 검색·hover 번역 플래그를 로드하는 데 필요.
    // (그 외 임의 키 읽기는 정보 유출 방지를 위해 계속 차단)
    if (!isTrustedSender(e)) {
      return key === 'freedom' ? getSettings().freedom : undefined
    }
    const parts = key.split('.')
    let value: unknown = getSettings()
    for (const p of parts) {
      if (value && typeof value === 'object' && p in (value as Record<string, unknown>)) {
        value = (value as Record<string, unknown>)[p]
      } else {
        value = undefined
        break
      }
    }
    return value
  })

  ipcMain.handle(IPC.settings.set, (e, { key, value }: { key: string; value: unknown }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    setNestedSetting(key, value)
  })

  onSettingsChange((s) => {
    for (const ctx of getAllWindows()) {
      ctx.chrome.webContents.send(IPC.settings.changed, s)
    }
    broadcastToInternalPages(IPC.settings.changed, s)
  })
}
