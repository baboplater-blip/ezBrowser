import ko from '../shared/locales/ko.json'
import en from '../shared/locales/en.json'

const lang = (navigator.language || 'ko').toLowerCase().startsWith('ko') ? 'ko' : 'en'
const data = (lang === 'ko' ? ko : en) as Record<string, unknown>

export function t(key: string, fallback?: string): string {
  const parts = key.split('.')
  let cur: unknown = data
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return fallback ?? key
    }
  }
  return typeof cur === 'string' ? cur : (fallback ?? key)
}

export function flatten(): Record<string, string> {
  const out: Record<string, string> = {}
  function walk(obj: unknown, prefix: string) {
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        const next = prefix ? `${prefix}.${k}` : k
        if (v && typeof v === 'object') walk(v, next)
        else if (typeof v === 'string') out[next] = v
      }
    }
  }
  walk(data, '')
  return out
}

export const labels = flatten()
