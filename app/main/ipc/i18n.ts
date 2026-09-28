// browser:// 내부 페이지의 언어 로딩 IPC. pages/shared/i18n.js(공용 로더)와 렌더러 외피(설정
// 변경으로 인한 재조회)가 이 채널로 "지금 어떤 언어를 써야 하는지 + 그 언어의 평탄화된 사전"을 받는다.
// 최초 진입값은 window-service.ts 가 chromeUrl 쿼리(`&lang=`)로 미리 넣어 깜빡임을 없애고,
// 이 IPC 는 그 뒤의 재조회·설정 변경 반영을 맡는다. 규약은 docs/i18n.md.
import { IPC } from '../../shared/ipc-channels'
import type { SupportedLocale } from '../../shared/i18n-core'
import { currentMainLocale, localeDict } from '../i18n'
import { onSettingsChange } from '../storage/settings'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { handleTrusted } from './trust'

export interface I18nPayload {
  locale: SupportedLocale
  dict: Record<string, string>
}

export function currentI18nPayload(): I18nPayload {
  const locale = currentMainLocale()
  return { locale, dict: localeDict(locale) }
}

export function registerI18nIpc(): void {
  handleTrusted<void, I18nPayload>(IPC.i18n.get, () => currentI18nPayload())

  // 설정이 바뀔 때마다 언어를 다시 계산해, 실제로 달라졌을 때만 모든 창·내부 페이지에 알린다 —
  // 매번 브로드캐스트하면(다른 설정 변경이 훨씬 잦다) 불필요한 재렌더가 낭비된다.
  let lastLocale = currentMainLocale()
  onSettingsChange(() => {
    const next = currentMainLocale()
    if (next === lastLocale) return
    lastLocale = next
    const payload = currentI18nPayload()
    for (const ctx of getAllWindows()) {
      ctx.chrome.webContents.send(IPC.i18n.changed, payload)
    }
    broadcastToInternalPages(IPC.i18n.changed, payload)
  })
}
