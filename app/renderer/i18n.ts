// 외피(브라우저 크롬) 렌더러용 i18n. 규약은 docs/i18n.md, 판정·평탄화 로직은
// app/shared/i18n-core.ts 단일 출처(메인·페이지 로더와 공유).
//
// 초기 언어는 windowId 와 같은 패턴으로 chromeUrl 쿼리(`?lang=`)에서 동기적으로 읽는다
// (window-service.ts 가 부팅 직전에 currentMainLocale() 값을 심어 준다) — 그래서 부팅 첫 페인트부터
// 맞는 언어로 그려지고, 그 뒤 언어가 바뀌면(설정 변경) `browserAPI.i18n.onChanged` 구독으로
// 재로드 없이 갱신된다.
import { useSyncExternalStore } from 'react'
import ko from '../shared/locales/ko.json'
import en from '../shared/locales/en.json'
import vi from '../shared/locales/vi.json'
import { flattenLocale, interpolate, resolveLocale, type SupportedLocale } from '../shared/i18n-core'

const RAW: Record<SupportedLocale, unknown> = { ko, en, vi }
const FLAT: Record<SupportedLocale, Record<string, string>> = {
  ko: flattenLocale(RAW.ko),
  en: flattenLocale(RAW.en),
  vi: flattenLocale(RAW.vi),
}

function initialLocale(): SupportedLocale {
  let fromQuery: string | undefined
  try {
    fromQuery = new URL(window.location.href).searchParams.get('lang') ?? undefined
  } catch {
    fromQuery = undefined
  }
  return resolveLocale(fromQuery, (typeof navigator !== 'undefined' && navigator.language) || 'en')
}

let currentLocale: SupportedLocale = initialLocale()
let currentDict: Record<string, string> = FLAT[currentLocale]

type Listener = () => void
const listeners = new Set<Listener>()

/** 언어가 바뀔 때마다 호출된다. React 컴포넌트는 useI18nDict()/useI18nLocale() 훅을 쓸 것. */
export function subscribeI18n(cb: Listener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function setLocale(locale: SupportedLocale): void {
  if (locale === currentLocale) return
  currentLocale = locale
  currentDict = FLAT[locale]
  for (const cb of listeners) cb()
}

export function getLocale(): SupportedLocale {
  return currentLocale
}

/** 단발성 조회(React 밖, 예: 액션 핸들러·토스트 문구). 반응성이 필요하면 useI18nDict() 훅을 쓸 것. */
export function t(key: string, fallback?: string, vars?: Record<string, string | number>): string {
  const v = currentDict[key]
  if (typeof v !== 'string') return fallback ?? key
  return interpolate(v, vars)
}

/** 현재 언어의 평탄화된 사전 전체(명령 팔레트의 action.* 라벨 조회 등에 쓴다). */
export function flatten(): Record<string, string> {
  return currentDict
}

/**
 * React 훅 — 언어가 바뀌면 컴포넌트를 재렌더시키며 최신 사전을 돌려준다.
 * `const dict = useI18nDict(); dict['action.tab.new']` 또는 `useI18nT()` 로 t() 자체를 받아도 된다.
 */
export function useI18nDict(): Record<string, string> {
  return useSyncExternalStore(subscribeI18n, () => currentDict, () => currentDict)
}

export function useI18nLocale(): SupportedLocale {
  return useSyncExternalStore(subscribeI18n, () => currentLocale, () => currentLocale)
}

/**
 * 반응형 t() — 컴포넌트 안에서 호출하면 언어가 바뀔 때 자동 재렌더된다.
 * 훅이 아니라 함수를 쓰고 싶은 콜백(예: 정렬 비교자) 안에서는 useI18nDict() 로 사전을 받아
 * lookup 하는 편이 낫다(훅은 컴포넌트 최상위에서만 호출 가능하다는 React 규칙 때문).
 */
export function useI18nT(): (key: string, fallback?: string, vars?: Record<string, string | number>) => string {
  const dict = useI18nDict()
  return (key, fallback, vars) => {
    const v = dict[key]
    if (typeof v !== 'string') return fallback ?? key
    return interpolate(v, vars)
  }
}

/** 하위 호환 — 정적 스냅샷이 필요한 극히 드문 자리(모듈 최상위 등)에서만 쓸 것. React 안에서는 useI18nDict() 를 쓴다. */
export const labels = currentDict
