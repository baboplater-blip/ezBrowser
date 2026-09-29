// 외피(브라우저 크롬) 렌더러용 i18n. 규약은 docs/i18n.md, 판정·평탄화 로직은
// app/shared/i18n-core.ts 단일 출처(메인·페이지 로더와 공유).
//
// 초기 언어는 windowId 와 같은 패턴으로 chromeUrl 쿼리(`?lang=`)에서 동기적으로 읽는다
// (window-service.ts 가 부팅 직전에 currentMainLocale() 값을 심어 준다) — 그래서 부팅 첫 페인트부터
// 맞는 언어로 그려지고, 그 뒤 언어가 바뀌면(설정 변경) `browserAPI.i18n.onChanged` 구독으로
// 재로드 없이 갱신된다.
import { useSyncExternalStore } from 'react'
import { flattenLocale, interpolate, resolveLocale, type SupportedLocale } from '../shared/i18n-core'

// 사전은 언어별 별도 청크로 나눠 **지금 쓰는 언어 하나만** 받는다. 세 사전(각 약 150KB)을 모두
// 초기 번들에 넣으면 외피 초기 JS 가 258KB → 615KB 로 불고, 부팅마다 셋 다 파싱·평탄화한다.
// main.tsx 가 첫 렌더 전에 initI18n() 을 await 하므로 첫 페인트부터 맞는 언어로 그려진다.
const LOADERS: Record<SupportedLocale, () => Promise<{ default: unknown }>> = {
  ko: () => import('../shared/locales/ko.json'),
  en: () => import('../shared/locales/en.json'),
  vi: () => import('../shared/locales/vi.json'),
}
const FLAT: Partial<Record<SupportedLocale, Record<string, string>>> = {}

async function loadFlat(locale: SupportedLocale): Promise<Record<string, string>> {
  const cached = FLAT[locale]
  if (cached) return cached
  const mod = await LOADERS[locale]()
  const flat = flattenLocale(mod.default)
  FLAT[locale] = flat
  return flat
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
// 사전이 도착하기 전에는 비어 있다 — 모든 호출부가 한국어 원문 fallback 을 넘기므로 깨지지 않는다.
let currentDict: Record<string, string> = {}

/** 첫 렌더 전에 한 번 부른다(main.tsx). 실패해도 fallback(한국어 원문)으로 그려진다. */
export async function initI18n(): Promise<void> {
  try {
    currentDict = await loadFlat(currentLocale)
  } catch (err) {
    console.error('[i18n] 사전 로드 실패 — 원문으로 표시', err)
  }
}

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
  void loadFlat(locale).then((flat) => {
    if (currentLocale !== locale) return // 로드 중 다시 바뀌었으면 최신 것만 반영
    currentDict = flat
    for (const cb of listeners) cb()
  }, (err) => console.error('[i18n] 사전 로드 실패', err))
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

