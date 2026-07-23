import Store from 'electron-store'

// origin → favicon URL 캐시. 슬립/복원/새 탭/북마크에서 페이지 로드 없이 파비콘 표시.
const CAP = 600

const store = new Store<{ map: Record<string, string> }>({ name: 'favicons', defaults: { map: {} } })

// 삽입 순서 유지를 위한 in-memory Map (LRU 근사)
const cache = new Map<string, string>()
let loaded = false
let persistTimer: NodeJS.Timeout | null = null

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  const map = store.get('map')
  for (const [k, v] of Object.entries(map)) cache.set(k, v)
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    store.set('map', Object.fromEntries(cache))
  }, 1_000)
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

export function recordFavicon(pageUrl: string, faviconUrl: string | undefined): void {
  if (!faviconUrl) return
  const origin = originOf(pageUrl)
  if (!origin) return
  ensureLoaded()
  if (cache.get(origin) === faviconUrl) return
  // LRU: 기존 키 삭제 후 재삽입해 맨 뒤로
  if (cache.has(origin)) cache.delete(origin)
  cache.set(origin, faviconUrl)
  while (cache.size > CAP) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  schedulePersist()
}

export function getFavicon(pageUrl: string): string | undefined {
  const origin = originOf(pageUrl)
  if (!origin) return undefined
  ensureLoaded()
  return cache.get(origin)
}
