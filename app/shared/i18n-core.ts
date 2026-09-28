// i18n 공통 핵심 로직 — 메인 프로세스(tMain)·렌더러(i18n.ts)·내부 페이지 로더(pages/shared/i18n.js 를
// 만드는 IPC 핸들러)가 모두 이 파일 하나를 통해 로케일을 해석·평탄화·보간한다.
// 규약은 docs/i18n.md 참고. 이 파일 자체는 순수 로직만 담고 JSON 사전은 import 하지 않는다
// (호출 측이 ko/en/vi.json 을 가져와 넘긴다 — main/renderer 양쪽에서 재사용 가능하게).

export type SupportedLocale = 'ko' | 'en' | 'vi'
export type LanguageSetting = 'auto' | SupportedLocale

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = ['ko', 'en', 'vi']

export function isSupportedLocale(v: unknown): v is SupportedLocale {
  return v === 'ko' || v === 'en' || v === 'vi'
}

/**
 * 설정값(`ui.language`)과 OS/브라우저 로케일 문자열로부터 실제 사용할 로케일을 정한다.
 * setting 이 'auto' 이거나 유효하지 않으면 osLocale 로 판정 — ko*→ko, vi*→vi, 그 외 전부 en.
 * main(app.getLocale())·renderer(navigator.language)·페이지(둘 다 아님, IPC 로 이미 정해진 값을 받음)
 * 가 이 함수 하나를 공유해 판정 기준이 갈라지지 않게 한다.
 */
export function resolveLocale(setting: LanguageSetting | string | undefined | null, osLocale: string): SupportedLocale {
  if (isSupportedLocale(setting)) return setting
  const l = (osLocale || 'en').toLowerCase()
  if (l.startsWith('ko')) return 'ko'
  if (l.startsWith('vi')) return 'vi'
  return 'en'
}

/** 중첩 JSON 사전을 `a.b.c` 형태의 평탄한 키-문자열 맵으로 편다. */
export function flattenLocale(obj: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const next = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object') flattenLocale(v, next, out)
      else if (typeof v === 'string') out[next] = v
    }
  }
  return out
}

/**
 * `{name}` 형태의 자리표시자를 vars 로 치환한다. 키가 없으면 원문 그대로 둔다(조용히 사라지지 않게).
 * 예: interpolate('{count}개 남음', { count: 3 }) → '3개 남음'
 */
export function interpolate(str: string, vars?: Record<string, string | number>): string {
  if (!vars) return str
  return str.replace(/\{(\w+)\}/g, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m,
  )
}

/** 평탄화된 사전에서 dot 키를 찾아 보간까지 적용한다. 없으면 fallback(또는 key 자체)을 돌려준다. */
export function lookup(
  dict: Record<string, string>,
  key: string,
  fallback?: string,
  vars?: Record<string, string | number>,
): string {
  const v = dict[key]
  if (typeof v === 'string') return interpolate(v, vars)
  return fallback ?? key
}
