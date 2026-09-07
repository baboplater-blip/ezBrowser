---
name: userscript-metadata
description: Tampermonkey/Violentmonkey 메타데이터 블록 파서·매처. @match 글롭→정규식, @grant 권한 모델, @require fetch 캐시, @run-at 타이밍.
---

# Userscript Metadata

## 메타 블록 파싱

```ts
const META_RE = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/m
const FIELD_RE = /\/\/\s*@(\w[\w-]*)\s+(.+)$/gm

interface UserscriptMeta {
  name: string
  namespace?: string
  version?: string
  description?: string
  matches: string[]
  excludes: string[]
  grants: string[]
  requires: string[]
  resources: Record<string, string>
  runAt: 'document-start' | 'document-end' | 'document-idle'
  noframes: boolean
  updateURL?: string
  downloadURL?: string
}

export function parseMeta(source: string): UserscriptMeta | null {
  const m = META_RE.exec(source)
  if (!m) return null
  const block = m[1]
  const meta: any = { matches: [], excludes: [], grants: [], requires: [], resources: {}, runAt: 'document-idle', noframes: false }

  let f
  while ((f = FIELD_RE.exec(block))) {
    const [_, key, val] = f
    switch (key) {
      case 'name': case 'namespace': case 'version': case 'description':
      case 'updateURL': case 'downloadURL':
        meta[key] = val.trim(); break
      case 'match': meta.matches.push(val.trim()); break
      case 'exclude': meta.excludes.push(val.trim()); break
      case 'grant': meta.grants.push(val.trim()); break
      case 'require': meta.requires.push(val.trim()); break
      case 'resource': {
        const [name, url] = val.trim().split(/\s+/)
        if (name && url) meta.resources[name] = url
        break
      }
      case 'run-at': meta.runAt = val.trim() as any; break
      case 'noframes': meta.noframes = true; break
    }
  }
  return meta as UserscriptMeta
}
```

## @match 글롭 → 정규식

Chrome `match patterns` 호환:
- `*://*/*`
- `https://*.example.com/path/*`
- `<all_urls>` 특별 케이스

```ts
export function matchToRegex(pattern: string): RegExp | null {
  if (pattern === '<all_urls>') return /^(https?|ftp|file):\/\/.*/

  const m = /^(\*|https?|ftp|file):\/\/([^/]+)(\/.*)?$/.exec(pattern)
  if (!m) return null
  const [, scheme, host, path] = m

  const schemeRe = scheme === '*' ? '(https?)' : scheme
  const hostRe = host === '*'
    ? '[^/]+'
    : host.startsWith('*.')
    ? `([^/]+\\.)?${escapeRe(host.slice(2))}`
    : escapeRe(host)
  const pathRe = (path ?? '/').split('*').map(escapeRe).join('.*')

  return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`)
}

function escapeRe(s: string) { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&') }
```

## 매칭

```ts
export function scriptMatches(url: string, meta: UserscriptMeta): boolean {
  const ok = meta.matches.some(p => matchToRegex(p)?.test(url))
  const blocked = meta.excludes.some(p => matchToRegex(p)?.test(url))
  return ok && !blocked
}
```

## 주입 코드 빌드

```ts
async function buildInjectionCode(script: Userscript, meta: UserscriptMeta): Promise<string> {
  const reqs = await Promise.all(meta.requires.map(fetchAndCache))  // SHA + LRU
  const grants = meta.grants
  const gmShim = buildGmShim(grants, script.id, meta.resources)

  return `(function(){
    ${gmShim}
    ${reqs.join('\n')}
    ${script.source}
  })()`
}
```

## GM_* shim 생성

```ts
function buildGmShim(grants: string[], scriptId: string, resources: Record<string, string>): string {
  if (grants.length === 0 || (grants.length === 1 && grants[0] === 'none')) return ''

  const parts: string[] = []
  if (grants.includes('GM_setValue') || grants.includes('GM_getValue')) {
    parts.push(`
      window.GM_setValue = (k, v) => browserAPI.userscript.setValue(${JSON.stringify(scriptId)}, k, v);
      window.GM_getValue = (k, d) => browserAPI.userscript.getValue(${JSON.stringify(scriptId)}, k, d);
    `)
  }
  if (grants.includes('GM_addStyle')) {
    parts.push(`window.GM_addStyle = (css) => { const s=document.createElement('style'); s.textContent=css; document.head.appendChild(s); };`)
  }
  if (grants.includes('GM_xmlhttpRequest')) {
    parts.push(`window.GM_xmlhttpRequest = (opts) => browserAPI.userscript.fetch(${JSON.stringify(scriptId)}, opts);`)
  }
  // ... etc
  return parts.join('\n')
}
```

## 주입 시점

```ts
webContents.on('did-start-navigation', async (e, url, _ip, isMain) => {
  for (const s of activeScripts) {
    if (s.meta.noframes && !isMain) continue
    if (!scriptMatches(url, s.meta)) continue
    if (s.meta.runAt === 'document-start') {
      injectAtFrameStart(webContents, s)
    }
  }
})

webContents.on('did-finish-load', () => {
  for (const s of activeScripts) {
    if (s.meta.runAt === 'document-end' || s.meta.runAt === 'document-idle') {
      injectNow(webContents, s)
    }
  }
})
```

## 절대 피할 것

- 매 navigate 마다 모든 스크립트 매칭 — URL 인덱싱 (도메인별 buckets)
- `@grant none` 인데 GM_* 노출
- `unsafeWindow` 를 모든 스크립트에 — `@grant unsafeWindow` 명시 시만
- require 마다 fetch — SHA256 키 LRU 디스크 캐시
- 자동 업데이트 새 메타에 추가 grant 가 있는데 사용자에게 묻지 않음
