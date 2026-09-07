---
name: command-palette-fuzzy
description: 명령 팔레트 검색 알고리즘 — ngram fuzzy + 한글 초성 + MRU 가중치. 250ms 이내 응답.
---

# Command Palette Fuzzy Search

## 인덱스 빌드 (registry 변경 시)

```ts
type Indexed = {
  id: string
  label: string
  labelLower: string
  labelChosung: string   // korean-ime-handling 의 chosung()
  tokens: string[]       // 라벨 단어 분리
  category: string
  mruScore: number       // 최근 사용 점수
}

let index: Indexed[] = []

function rebuild() {
  index = actionRegistry.all().map(a => ({
    id: a.id,
    label: t(a.labelKey),
    labelLower: t(a.labelKey).toLowerCase(),
    labelChosung: chosung(t(a.labelKey)),
    tokens: t(a.labelKey).toLowerCase().split(/\s+/),
    category: a.category,
    mruScore: mru.get(a.id) ?? 0,
  }))
}
```

## 점수 함수

```ts
function score(item: Indexed, query: string): number {
  const q = query.toLowerCase().trim()
  if (!q) return item.mruScore  // 빈 쿼리는 MRU 순

  let s = 0

  // 1. 정확 prefix
  if (item.labelLower.startsWith(q)) s += 5

  // 2. 토큰 prefix (단어 시작)
  if (item.tokens.some(tk => tk.startsWith(q))) s += 3

  // 3. substring
  if (item.labelLower.includes(q)) s += 2

  // 4. ngram (fuzzy 거리)
  s += ngramSimilarity(item.labelLower, q) * 2

  // 5. 한글 초성 매칭
  if (q.split('').every(ch => /[ㄱ-ㅎ]/.test(ch))) {
    if (item.labelChosung.includes(q)) s += 4
  }

  // 6. MRU
  s += item.mruScore * 0.5

  return s
}

function ngramSimilarity(a: string, b: string): number {
  const set = new Set<string>()
  for (let i = 0; i < a.length - 1; i++) set.add(a.slice(i, i + 2))
  let hits = 0
  for (let i = 0; i < b.length - 1; i++) if (set.has(b.slice(i, i + 2))) hits++
  return hits / Math.max(b.length - 1, 1)
}
```

## 카테고리 prefix 파싱

```ts
function parseQuery(raw: string): { prefix: string | null; query: string } {
  const m = /^(>|:|@|#|\/|\?)\s*(.*)$/.exec(raw)
  return m ? { prefix: m[1], query: m[2] } : { prefix: null, query: raw }
}

function filterByPrefix(items: Indexed[], prefix: string | null): Indexed[] {
  if (!prefix) return items
  const map = { '>': null, ':': 'settings', '@': 'workspace', '#': 'tab', '/': 'omnibox', '?': 'help' }
  const cat = (map as any)[prefix]
  return cat === null ? items.filter(i => i.category !== 'tab' && i.category !== 'settings')
                      : items.filter(i => i.category === cat)
}
```

## 검색 호출

```ts
export function search(raw: string, limit = 10): Indexed[] {
  const { prefix, query } = parseQuery(raw)
  const pool = filterByPrefix(index, prefix)
  return pool
    .map(item => ({ item, s: score(item, query) }))
    .filter(({ s }) => s > 0.1 || !query)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(({ item }) => item)
}
```

## MRU 업데이트

```ts
function recordUse(actionId: string) {
  const cur = mru.get(actionId) ?? 0
  mru.set(actionId, cur + 1)
  // 디케이: 매일 자정 모든 값 ×0.95
}
```

## 250ms 예산

- 인덱스 ≤ 1000 항목 가정
- 매 입력 O(N) ≈ 1000 × 100ns = 0.1ms
- 정렬 O(N log N) ≈ 10000 비교 = 1ms
- 렌더 ≤ 10 items = trivial
- 즉시 응답 가능, 디바운스 50ms 만

## 절대 피할 것

- 빈 쿼리에 빈 결과 — MRU 표시
- 매 입력마다 인덱스 재빌드 — registry 변경 시만
- 매 입력 IPC — 인덱스 외피 메모리에 캐시
- 초성 매칭이 영문 라벨에도 발화 — query 가 초성일 때만
- 비활성 액션을 결과에 — `enabled(ctx)` 호출 후 필터
