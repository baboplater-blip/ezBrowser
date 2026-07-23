---
name: omnibox-suggest-protocol
description: 주소창 검색 제안 통합. Google/Naver/Bing OpenSearch suggest 엔드포인트, 응답 파싱, CORS 우회(메인 프로세스 대행), 디바운스·캐시·정렬.
---

# Omnibox Suggest Protocol

## 엔드포인트 (무인증)

| 엔진 | URL | 응답 형식 |
|------|-----|----------|
| Google | `https://suggestqueries.google.com/complete/search?client=chrome&q={q}` | `[query, [suggestions], [descs], [urls], {meta}]` |
| Naver | `https://ac.search.naver.com/nx/ac?q={q}&st=100&r_format=json&r_enc=UTF-8&r_lt=11211&q_enc=UTF-8` | 복잡한 JSON, `items[0]` 이 제안 배열 |
| Bing | `https://www.bing.com/AS/Suggestions?qry={q}&cvid=...` | HTML (파싱 필요) |
| DuckDuckGo | `https://duckduckgo.com/ac/?q={q}&type=list` | `[query, [{phrase: ...}]]` |
| Kagi | `https://kagi.com/api/autosuggest?q={q}` | 인증 필요 |

응답 파싱은 엔진별 어댑터:

```ts
type Suggestion = { text: string; type: 'query' | 'navigation'; url?: string }

const adapters: Record<string, (json: any) => Suggestion[]> = {
  google: (j) => j[1].map((text: string, i: number) => ({
    text, type: 'query', url: undefined,
  })),
  naver: (j) => j.items?.[0]?.map((it: any) => ({ text: it[0], type: 'query' })) ?? [],
  ddg: (j) => j[1].map((it: any) => ({ text: it.phrase, type: 'query' })),
}
```

## CORS 우회 (메인 대행)

브라우저 외피 페이지에서 직접 fetch 하면 CORS 차단. 메인 프로세스가 대행:

```ts
// main
ipcMain.handle('omnibox:suggest', async (e, { query, engineId }) => {
  const cached = suggestCache.get(`${engineId}:${query}`)
  if (cached) return cached

  const engine = engines.find(en => en.id === engineId)
  if (!engine?.suggest) return []

  const url = engine.suggest.replace('{query}', encodeURIComponent(query))
  const resp = await fetch(url, { signal: AbortSignal.timeout(800) })
  const json = await resp.json()
  const sugg = adapters[engineId]?.(json) ?? []

  suggestCache.set(`${engineId}:${query}`, sugg, 60_000)
  return sugg
})
```

## 디바운스 + 취소

```ts
// renderer
let controller: AbortController | null = null
const debouncedSuggest = debounce(async (q: string) => {
  controller?.abort()
  controller = new AbortController()
  const sugg = await browserAPI.omnibox.suggest(q)
  if (controller.signal.aborted) return
  setSuggestions(sugg)
}, 150)
```

## 결과 합성 (omnibox-developer 가 호출)

```ts
async function buildSuggestions(query: string) {
  const [history, bookmarks, openTabs, engineSugg] = await Promise.all([
    browserAPI.history.search(query, 5),
    browserAPI.bookmarks.search(query, 5),
    browserAPI.tabs.search(query, 5),
    browserAPI.omnibox.suggest(query),
  ])

  return rank([
    ...history.map(h => ({ ...h, source: 'history', score: scoreHistory(h, query) })),
    ...bookmarks.map(b => ({ ...b, source: 'bookmark', score: scoreBookmark(b, query) })),
    ...openTabs.map(t => ({ ...t, source: 'tab', score: scoreTab(t, query) })),
    ...engineSugg.map(s => ({ ...s, source: 'search', score: 0.3 })),
  ]).slice(0, 8)
}
```

## 절대 피할 것

- 모든 키 입력마다 fetch — 150ms 디바운스 + 800ms 타임아웃
- 사용자가 입력 멈춰도 stale 결과 — controller.abort
- 캐시 무한 누적 — 1000 항목 LRU
- 외피 origin 에서 직접 fetch — main 대행
- suggest 응답이 오타 경고/광고 같은 노이즈 포함 — 어댑터에서 정제
