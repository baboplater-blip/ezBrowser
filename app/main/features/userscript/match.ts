// Chrome match pattern(+ Tampermonkey 확장) → 매처. 순수 함수만 — 부수효과 없음.
//
// 지원:
//  - `<scheme>://<host>/<path>` 표준 Chrome match pattern (scheme=`*` 은 http/https 만)
//  - `<all_urls>`
//  - host 의 `*.example.com` — **베어 도메인 example.com 자체도 포함**(item 6). 예전 구현은
//    전체 문자열을 통째로 `*`→`.*` 치환해 `*.example.com` 이 항상 리터럴 점(.) 을 요구했다
//    (`.*\.example\.com` 은 "example.com" 단독과 매치 안 됨) — scheme/host/path 를 분리 파싱해 고쳤다.
//  - `@include`/`@match` 값이 `/regex/` 형태면 raw 정규식으로(item 6). 유효하지 않으면 무시.

export interface CompiledPattern {
  readonly raw: string
  test(url: string): boolean
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

/** `<scheme>://<host>/<path>` 형태의 정식 Chrome match pattern을 컴파일한다. 실패하면 null. */
function compileChromePattern(pattern: string): RegExp | null {
  if (pattern === '<all_urls>') return /^(https?|ftp|file):\/\/.*/i
  const m = /^(\*|https?|ftp|file):\/\/([^/]+)(\/.*)?$/i.exec(pattern)
  if (!m) return null
  const scheme = m[1] ?? '*'
  const host = m[2] ?? '*'
  const rawPath = m[3]
  const schemeRe = scheme === '*' ? '(https?)' : escapeRegex(scheme)
  const hostRe = host === '*'
    ? '[^/]+'
    : host.startsWith('*.')
      ? `(?:[^/]+\\.)?${escapeRegex(host.slice(2))}` // 서브도메인 옵션 + 베어 도메인 포함
      : escapeRegex(host)
  const pathRe = (rawPath ?? '/').split('*').map(escapeRegex).join('.*')
  try {
    return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`, 'i')
  } catch {
    return null
  }
}

/** 구식(스킴 없는) 단순 와일드카드 패턴 — 하위호환. `*`→`.*`, `?`→literal. */
function compileLegacyGlob(pattern: string): RegExp | null {
  const compiled = pattern.split('').map((c) => {
    if (c === '*') return '.*'
    if (c === '?') return '\\?'
    return escapeRegex(c)
  }).join('')
  try {
    return new RegExp('^' + compiled + '$', 'i')
  } catch {
    return null
  }
}

/** `/regex/` 또는 `/regex/flags` 형태를 raw 정규식으로 파싱한다. 실패하면 null. */
function compileRawRegex(raw: string): RegExp | null {
  if (!raw.startsWith('/') || raw.length < 2) return null
  const lastSlash = raw.lastIndexOf('/')
  if (lastSlash <= 0) return null
  const body = raw.slice(1, lastSlash)
  const flags = raw.slice(lastSlash + 1)
  if (!/^[a-z]*$/i.test(flags)) return null
  try {
    return new RegExp(body, flags)
  } catch {
    return null
  }
}

/** 패턴 하나를 컴파일한다 — `/regex/` 우선, 아니면 Chrome match pattern, 그래도 실패하면 레거시 glob. */
export function compilePattern(raw: string): CompiledPattern | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const re = compileRawRegex(trimmed) ?? compileChromePattern(trimmed) ?? compileLegacyGlob(trimmed)
  if (!re) return null
  return { raw, test: (url: string) => { try { return re.test(url) } catch { return false } } }
}

export function compilePatterns(list: readonly string[]): CompiledPattern[] {
  const out: CompiledPattern[] = []
  for (const p of list) {
    const c = compilePattern(p)
    if (c) out.push(c)
  }
  return out
}

/** match(OR include) 중 하나라도 맞고, exclude 에는 하나도 안 걸리면 true. */
export function urlMatchesScript(
  url: string,
  positive: readonly CompiledPattern[],
  exclude: readonly CompiledPattern[],
): boolean {
  if (positive.length === 0) return false
  if (!positive.some((p) => p.test(url))) return false
  if (exclude.some((p) => p.test(url))) return false
  return true
}
