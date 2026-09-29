---
name: korean-ime-handling
description: 한국어 IME 처리 — composition 이벤트, 자모 분리, 단축키 발화 타이밍. Electron + Chromium 환경에서 일관된 한글 입력.
---

# 한국어 IME 처리

## 단축키와 composition 충돌

한글 입력 중(`compositionstart` ~ `compositionend`) 에 단축키(`keydown`) 처리하면 마지막 글자가 잘림:

```ts
// ❌ 잘못된 처리
function onKeyDown(e: KeyboardEvent) {
  if (e.ctrlKey && e.key === 't') openNewTab()
}

// ✅ composing 체크
function onKeyDown(e: KeyboardEvent) {
  if (e.isComposing) return  // IME 진행 중이면 무시
  if (e.ctrlKey && e.key === 't') openNewTab()
}
```

omnibox `input` 이벤트는 composition 중에도 발화 — `compositionupdate` 와 동기화:

```ts
input.addEventListener('compositionstart', () => { isComposing = true })
input.addEventListener('compositionend', () => {
  isComposing = false
  // 최종 글자가 input.value 에 반영된 후 suggest 호출
  debouncedSuggest(input.value)
})
input.addEventListener('input', (e) => {
  if (isComposing) return  // 조합 중간은 무시 — composition 이벤트만 사용
  debouncedSuggest(input.value)
})
```

## main 의 before-input-event

```ts
webContents.on('before-input-event', (e, input) => {
  // input.isComposing 체크 (Electron 11+)
  if ((input as any).isComposing) return
  // 단축키 매칭
})
```

## 자모 분리 검색

omnibox 자동완성이 초성(`ㅁㅅㅈ` → "맥세이프", "메시지" 등) 매칭 가능하게:

```ts
// 한글 → 초성 추출
const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ']

function chosung(str: string): string {
  return Array.from(str).map(ch => {
    const code = ch.charCodeAt(0)
    if (code < 0xAC00 || code > 0xD7A3) return ch
    const idx = Math.floor((code - 0xAC00) / 588)
    return CHO[idx]
  }).join('')
}

// matching
const inputCho = chosung(query)
const titleCho = chosung(title)
if (titleCho.includes(inputCho)) score += 0.3
```

## 한자 → 한글 변환 (빠른 검색)

선택 텍스트가 한자만일 때 빠른 검색에 "한자→한글" 옵션. 간단한 lookup table:

```ts
const HANJA = new Map<string, string[]>([
  ['人', ['인', '사람']],
  ['国', ['국', '나라']],
  // ... 또는 외부 사전 파일
])

function hanjaToHangul(s: string): string {
  return Array.from(s).map(ch => HANJA.get(ch)?.[0] ?? ch).join('')
}
```

## 시간·날짜 한국어

```ts
function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '방금'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}분 전`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}시간 전`
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)}일 전`
  return new Date(ts).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })
}
```

## 조사 (`josa.ts`)

```ts
export function josa(word: string, pair: '이/가' | '을/를' | '은/는' | '와/과'): string {
  const last = word.codePointAt(word.length - 1)!
  if (last < 0xAC00 || last > 0xD7A3) return pair.split('/')[1]  // 비한글은 두번째
  const jong = (last - 0xAC00) % 28
  const hasJong = jong !== 0
  const [a, b] = pair.split('/')
  return hasJong ? a : b
}

// 사용
const msg = `${file.name}${josa(file.name, '이/가')} 저장되었습니다`
```

## 절대 피할 것

- `keydown` 만 보고 단축키 — `isComposing` 미체크
- `input.value` 를 composition 중간에 자동 완성 — 마지막 자모 사라짐
- 초성 검색을 `LIKE %?%` — 전처리 인덱스(`title_cho` 컬럼)
- 한자→한글을 모든 텍스트에 자동 — 사용자 명시 선택
- 한국어 로케일 사용자에게 영문 시간 표기
