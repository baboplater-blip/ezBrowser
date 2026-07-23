import { ipcMain, net } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { SUGGEST_TIMEOUT_MS } from '../../shared/constants'
import type { OmniboxSuggestion } from '../../shared/types'
import {
  buildSearchUrl, getDefaultEngine, listEngines,
  parseBangAndQuery, parseEngineKeywordAndQuery,
} from '../storage/search-engines'
import { createTab, listTabs, navigateTab } from '../tabs/tab-service'
import { searchBookmarks } from '../storage/bookmarks'
import { searchHistory } from '../storage/history'

interface SuggestEntry { value: OmniboxSuggestion[]; expiresAt: number }
const cache = new Map<string, SuggestEntry>()
const CACHE_TTL_MS = 60_000
const CACHE_MAX = 200

function cacheGet(key: string): OmniboxSuggestion[] | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAt < Date.now()) { cache.delete(key); return null }
  return entry.value
}

function cacheSet(key: string, value: OmniboxSuggestion[]): void {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value
    if (first) cache.delete(first)
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
}

async function fetchSuggest(engineId: string, query: string): Promise<OmniboxSuggestion[]> {
  const engine = listEngines().find((e) => e.id === engineId)
  if (!engine?.suggest) return []
  const url = engine.suggest.replace('{query}', encodeURIComponent(query))
  return new Promise((resolve) => {
    let done = false
    const request = net.request({ url, method: 'GET', useSessionCookies: false })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try { request.abort() } catch { /* ignore */ }
      resolve([])
    }, SUGGEST_TIMEOUT_MS)
    request.on('response', (resp) => {
      resp.on('data', (chunk: Buffer) => chunks.push(chunk))
      resp.on('end', () => {
        if (done) return
        done = true
        clearTimeout(timer)
        try {
          const body = Buffer.concat(chunks).toString('utf8')
          resolve(parseAdapter(engineId, body, engine.url))
        } catch {
          resolve([])
        }
      })
    })
    request.on('error', () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve([])
    })
    request.end()
  })
}

function parseAdapter(engineId: string, body: string, engineUrl: string): OmniboxSuggestion[] {
  try {
    const json = JSON.parse(body)
    let phrases: string[] = []
    if (engineId === 'google' && Array.isArray(json) && Array.isArray(json[1])) phrases = json[1]
    else if (engineId === 'ddg' && Array.isArray(json)) {
      phrases = json.map((it: any) => (typeof it === 'string' ? it : it.phrase ?? '')).filter(Boolean)
    } else if (engineId === 'naver' && json?.items && Array.isArray(json.items[0])) {
      phrases = json.items[0].map((it: any) => (Array.isArray(it) ? it[0] : '')).filter(Boolean)
    }
    return phrases.slice(0, 8).map((text, i) => ({
      id: `search-${i}-${text}`,
      source: 'search' as const,
      text,
      url: engineUrl.replace('{query}', encodeURIComponent(text)),
      score: 0.3,
    }))
  } catch {
    return []
  }
}

function normalizeUrl(input: string): string | null {
  const v = input.trim()
  if (!v) return null
  if (/^[a-z]+:\/\//i.test(v)) return v
  if (/^[\w.-]+\.[a-z]{2,}([/?#].*)?$/i.test(v)) return `https://${v}`
  return null
}

async function combineSuggestions(query: string, windowId?: string): Promise<OmniboxSuggestion[]> {
  const out: OmniboxSuggestion[] = []
  const q = query.trim()
  if (!q) return out

  const directUrl = normalizeUrl(q)
  if (directUrl) {
    out.push({
      id: `url-${directUrl}`, source: 'url', text: q,
      detail: directUrl, url: directUrl, score: 1,
    })
  }

  const bangResult = parseBangAndQuery(q)
  if (bangResult.bang) {
    out.push({
      id: `bang-${bangResult.bang.trigger}`, source: 'search',
      text: `!${bangResult.bang.trigger} ${bangResult.query}`,
      detail: bangResult.bang.description, score: 0.95,
      url: bangResult.bang.url.replace('{query}', encodeURIComponent(bangResult.query)),
    })
  } else {
    const kwResult = parseEngineKeywordAndQuery(q)
    if (kwResult.engine) {
      out.push({
        id: `kw-${kwResult.engine.id}`, source: 'search',
        text: `${kwResult.engine.name}: ${kwResult.query}`,
        detail: kwResult.engine.name, score: 0.9,
        url: buildSearchUrl(kwResult.query, kwResult.engine),
      })
    }
  }

  if (windowId) {
    const tabs = listTabs(windowId).filter((t) =>
      t.title.toLowerCase().includes(q.toLowerCase()) ||
      t.url.toLowerCase().includes(q.toLowerCase()),
    ).slice(0, 3)
    for (const t of tabs) {
      out.push({
        id: `tab-${t.id}`, source: 'tab',
        text: t.title, detail: t.url, url: t.url, score: 0.6,
      })
    }
  }

  try {
    const bookmarks = searchBookmarks(q, 4)
    for (const b of bookmarks) {
      out.push({
        id: `bm-${b.id}`, source: 'bookmark',
        text: b.title, detail: b.url, url: b.url, score: 0.75,
      })
    }
  } catch { /* db not ready */ }

  try {
    const hist = searchHistory(q, 6)
    for (const h of hist) {
      const score = Math.min(0.7, 0.45 + Math.log10(h.visitCount + 1) * 0.12)
      out.push({
        id: `hist-${h.id}`, source: 'history',
        text: h.title || h.url, detail: h.url, url: h.url, score,
      })
    }
  } catch { /* db not ready */ }

  const engine = getDefaultEngine()
  out.push({
    id: `default-${engine.id}`, source: 'search',
    text: `${engine.name} 검색: ${q}`,
    detail: engine.name, score: 0.4,
    url: buildSearchUrl(q),
  })

  if (engine.suggest) {
    const cacheKey = `${engine.id}::${q.toLowerCase()}`
    let suggest = cacheGet(cacheKey)
    if (!suggest) {
      suggest = await fetchSuggest(engine.id, q)
      cacheSet(cacheKey, suggest)
    }
    out.push(...suggest)
  }

  return dedupe(out).sort((a, b) => b.score - a.score).slice(0, 10)
}

function dedupe(arr: OmniboxSuggestion[]): OmniboxSuggestion[] {
  const seen = new Set<string>()
  const out: OmniboxSuggestion[] = []
  for (const s of arr) {
    const key = (s.url ?? s.text).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

export function registerOmniboxIpc(): void {
  ipcMain.handle(IPC.omnibox.suggest, async (_e, { query, windowId }: { query: string; windowId?: string }) =>
    combineSuggestions(query, windowId))

  ipcMain.handle(IPC.omnibox.navigate, (_e, { windowId, tabId, input }: { windowId: string; tabId?: string; input: string }) => {
    const direct = normalizeUrl(input)
    let target = direct
    if (!target) {
      const bang = parseBangAndQuery(input)
      if (bang.bang) target = bang.bang.url.replace('{query}', encodeURIComponent(bang.query))
      else {
        const kw = parseEngineKeywordAndQuery(input)
        if (kw.engine) target = buildSearchUrl(kw.query, kw.engine)
        else target = buildSearchUrl(input)
      }
    }
    if (tabId) navigateTab(tabId, target)
    else createTab({ windowId, url: target })
  })

  ipcMain.handle(IPC.search.listEngines, () => {
    // 검색엔진 목록은 민감 정보 아님 — 모든 컨텍스트 허용 (omnibox 자동완성에서도 필요할 수 있음)
    return listEngines()
  })
}
