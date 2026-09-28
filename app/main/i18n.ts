// 메인 프로세스용 i18n — 네이티브 메뉴·대화상자·토스트 문구에 쓴다.
// 규약은 docs/i18n.md, 판정 로직은 app/shared/i18n-core.ts 단일 출처(renderer/페이지와 공유).
import { app } from 'electron'
import ko from '../shared/locales/ko.json'
import en from '../shared/locales/en.json'
import vi from '../shared/locales/vi.json'
import { flattenLocale, resolveLocale, type SupportedLocale } from '../shared/i18n-core'
import { getSetting } from './storage/settings'

const RAW: Record<SupportedLocale, unknown> = { ko, en, vi }

// 평탄화는 로케일당 1회만(사전은 작고 부팅 후 안 바뀜 — 캐시해도 안전).
const FLAT_CACHE = new Map<SupportedLocale, Record<string, string>>()
function flatFor(locale: SupportedLocale): Record<string, string> {
  let cached = FLAT_CACHE.get(locale)
  if (!cached) {
    cached = flattenLocale(RAW[locale])
    FLAT_CACHE.set(locale, cached)
  }
  return cached
}

/** 로케일의 평탄화된 사전을 돌려준다(캐시됨). ipc/i18n.ts 가 페이지 로더용 payload 조립에 재사용한다. */
export function localeDict(locale: SupportedLocale): Record<string, string> {
  return flatFor(locale)
}

/** 현재 설정 + OS 로케일로 메인 프로세스가 써야 할 언어를 정한다. */
export function currentMainLocale(): SupportedLocale {
  let setting: string | undefined
  try {
    setting = getSetting('ui')?.language
  } catch {
    setting = undefined
  }
  let osLocale = 'en'
  try {
    osLocale = app.getLocale()
  } catch {
    osLocale = 'en'
  }
  return resolveLocale(setting, osLocale)
}

/**
 * 메인 프로세스 대화상자·메뉴·토스트 문구용 번역 함수.
 * key 는 docs/i18n.md 의 `main.*` 네임스페이스 규칙을 따른다(강제는 아님 — 다른 네임스페이스 키도
 * 조회는 가능하지만 병렬 작업 충돌 방지를 위해 main 코드는 main.* 만 쓸 것).
 */
export function tMain(key: string, fallback?: string, vars?: Record<string, string | number>): string {
  const dict = flatFor(currentMainLocale())
  const v = dict[key]
  if (typeof v !== 'string') return fallback ?? key
  if (!vars) return v
  return v.replace(/\{(\w+)\}/g, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m,
  )
}
