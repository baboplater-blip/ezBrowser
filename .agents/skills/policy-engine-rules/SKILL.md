---
name: policy-engine-rules
description: 사이트별 정책 룰 매칭·적용. 글롭/정규식 매칭, 우선순위, webRequest 후킹, setUserAgent 적용 지점.
---

# Policy Engine Rules

## 룰 평가

```ts
type Policy = { ua?: string; javascript?: 'allow' | 'block'; images?: 'allow' | 'block'
              ; cookies?: 'allow' | 'block' | 'third-party-blocked'
              ; adblock?: 'off' | 'lite' | 'standard' | 'strict'
              ; permissions?: Partial<Record<Permission, 'allow' | 'deny' | 'prompt'>>
              ; headers?: { request?: Record<string, string>; response_strip?: string[] }
              ; csp?: 'off' | 'strict' | 'relaxed'
              ; language?: string }

type Rule = { id: string; match: string; priority: number; policies: Policy }

let rules: Rule[] = []

export function effectivePolicy(url: string): Policy {
  const matched = rules
    .filter(r => urlMatchesRule(url, r.match))
    .sort((a, b) => b.priority - a.priority)

  // 머지: 높은 우선순위가 같은 키 정의 시 덮어쓰지 않음 (먼저 매치가 이김)
  const merged: Policy = {}
  for (const r of matched) {
    for (const [k, v] of Object.entries(r.policies)) {
      if ((merged as any)[k] === undefined) (merged as any)[k] = v
    }
  }
  return merged
}
```

매칭 규칙은 userscript-metadata 의 `matchToRegex` 재사용 (혹은 동일 함수 공유).

## 적용 지점

### UA

```ts
session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
  const policy = effectivePolicy(details.url)
  const headers = { ...details.requestHeaders }
  if (policy.ua) headers['User-Agent'] = policy.ua
  if (policy.language) headers['Accept-Language'] = policy.language
  if (policy.headers?.request) Object.assign(headers, policy.headers.request)
  cb({ requestHeaders: headers })
})
```

### Response 헤더 제거 (X-Frame-Options 등)

```ts
session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
  const policy = effectivePolicy(details.url)
  const headers = { ...details.responseHeaders }
  for (const key of policy.headers?.response_strip ?? []) {
    delete headers[key.toLowerCase()]
  }
  if (policy.csp === 'off') delete headers['content-security-policy']
  if (policy.csp === 'relaxed') headers['content-security-policy'] = ['default-src * \'unsafe-inline\' \'unsafe-eval\' data: blob:;']
  cb({ responseHeaders: headers })
})
```

### 이미지 차단

```ts
session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
  const policy = effectivePolicy(details.url)
  if (policy.images === 'block' && details.resourceType === 'image') {
    return cb({ cancel: true })
  }
  cb({})
})
```

### JS 차단

페이지 로드 시 `webContents.setJavaScriptEnabled(false)` — 탭 단위 결정, 정책 매칭 후 적용:

```ts
webContents.on('did-start-navigation', (e, url) => {
  if (!e.isMainFrame) return
  const policy = effectivePolicy(url)
  if (policy.javascript === 'block') {
    webContents.setJavaScriptEnabled(false)
  } else {
    webContents.setJavaScriptEnabled(true)
  }
})
```

### 권한

```ts
session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => {
  const policy = effectivePolicy(details.requestingUrl)
  const verdict = policy.permissions?.[perm as Permission] ?? 'prompt'
  if (verdict === 'allow') return cb(true)
  if (verdict === 'deny') return cb(false)
  // prompt → 외피에 다이얼로그 요청
  promptUserForPermission(details.requestingUrl, perm).then(cb)
})
```

## 우선순위

- 사용자 룰 priority 0~100
- 시스템 룰 (security-auditor 가 차단해야 하는 사이트 — 알려진 피싱 등): priority 999, 항상 이김
- 기본값(룰 없는 사이트): 안전한 보수적 디폴트

## 룰 빌더 UX

설정 → "정책" → 룰 카드:
- 도메인 입력 + 자동 글롭 변환 (`example.com` → `*://*.example.com/*`)
- 정책 토글들 (UA 프리셋, JS, 이미지, 쿠키, 권한)
- 미리보기 (룰 적용 시 변화)

## 절대 피할 것

- 모든 요청에 전체 룰 평가 O(N) — 도메인 → 룰 인덱싱
- 보안 약화 정책(`csp: off`, `webSecurity` 등) 자동 적용 — 명시 동의
- 룰 충돌(같은 도메인 다른 UA) 무경고 — 우선순위 표시 + 경고
- 룰 적용이 새 탭만 — 기존 탭도 다음 navigation 부터 반영
