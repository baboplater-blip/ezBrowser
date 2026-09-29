---
name: design-token-pipeline
description: tokens.json → CSS 변수 자동 생성, 다크/라이트 변형, 밀도(컴팩트/일반/넉넉) 스위치, userChrome 안전 변수 보장.
---

# Design Token Pipeline

## 단일 출처

`app/renderer/design/tokens.json` (라이트, 기본)
`app/renderer/design/tokens.dark.json` (다크 override)

빌드 시 `build/gen-tokens.ts` 가 두 파일을 읽어 CSS 변수 + TS 타입 생성:

```css
/* app/renderer/design/tokens.gen.css */
:root {
  --color-bg-elevated: #FFFFFF;
  --color-bg-base: #F7F7F8;
  /* ... */
}

:root[data-theme="dark"] {
  --color-bg-elevated: #1A1A1F;
  --color-bg-base: #0F0F12;
  /* ... */
}

:root[data-density="compact"] {
  --density-tabbar-h: 28px;
  --density-toolbar-h: 32px;
}

:root[data-density="regular"] {
  --density-tabbar-h: 36px;
  --density-toolbar-h: 36px;
}

:root[data-density="comfy"] {
  --density-tabbar-h: 42px;
  --density-toolbar-h: 40px;
}
```

```ts
// app/renderer/design/tokens.gen.ts
export const tokens = { ... } as const
export type Token = keyof typeof tokens
```

## gen-tokens 빌드 스크립트

```ts
// build/gen-tokens.ts
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const base = JSON.parse(readFileSync('app/renderer/design/tokens.json', 'utf8'))
const dark = JSON.parse(readFileSync('app/renderer/design/tokens.dark.json', 'utf8'))

function flatten(o: any, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}-${k}` : k
    if (typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key))
    else out[`--${key}`] = String(v)
  }
  return out
}

const lightVars = flatten(base)
const darkVars = flatten(dark)

let css = ':root {\n'
for (const [k, v] of Object.entries(lightVars)) css += `  ${k}: ${v};\n`
css += '}\n\n:root[data-theme="dark"] {\n'
for (const [k, v] of Object.entries(darkVars)) css += `  ${k}: ${v};\n`
css += '}\n'

writeFileSync('app/renderer/design/tokens.gen.css', css)
```

`prebuild` 스크립트로 자동 실행.

## 적용

```tsx
// app/renderer/main.tsx
import './design/tokens.gen.css'

const root = document.documentElement
root.dataset.theme = settings.appearance.theme === 'system'
  ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  : settings.appearance.theme
root.dataset.density = settings.appearance.density
```

## 시스템 테마 변화 추종

```ts
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (settings.appearance.theme === 'system') {
    document.documentElement.dataset.theme = e.matches ? 'dark' : 'light'
  }
})

// Electron
nativeTheme.on('updated', () => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('theme:system', nativeTheme.shouldUseDarkColors)
  }
})
```

## userChrome 안전 변수

`userchrome-developer` 가 약속한 변수는 토큰에 반드시 포함:
- `--color-bg-base` `--color-bg-elevated` `--color-bg-sunken`
- `--color-text-primary` `--color-text-secondary` `--color-text-muted`
- `--color-accent-primary` `--color-accent-hover`
- `--color-border-subtle` `--color-border-strong`
- `--tab-active-bg` `--tab-inactive-bg` `--tab-hover-bg`
- `--density-tabbar-h` `--density-toolbar-h` `--density-font-size`
- `--radius-sm` `--radius-md` `--radius-lg` `--radius-tab`
- `--motion-fast` `--motion-normal` `--motion-slow`

빌드 스크립트가 누락 검출 (`assertRequiredVars()`).

## 절대 피할 것

- 토큰 외 하드코딩 색·픽셀 (lint: `stylelint-no-hardcoded-color`)
- 다크/라이트 토큰 키 불일치 — 빌드 검증
- 밀도가 토큰 외 셀렉터(가짜 픽셀 직접 지정) — `[data-density]` 만
- 토큰 이름 임의 변경 — userChrome.css 깨짐. 별칭 + deprecation
- 매 setting 변경마다 빌드 — 런타임 CSS 변수만 변경 (data-* 토글)
