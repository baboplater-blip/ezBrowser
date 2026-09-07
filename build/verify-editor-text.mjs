#!/usr/bin/env node
// verify-editor-text.mjs — 마크다운 -> 에디터 평문 변환 검사 (순수 함수, 앱을 띄우지 않는다)
//
// 왜 (2026-09-07, 임무 30): 블로그 스튜디오의 초안은 마크다운인데 네이버 SmartEditor 는
// 마크다운을 해석하지 않는다. 그래서 `##`·`**`·`|` 가 **문자 그대로 발행**돼 한때 모든 발행글이
// 구조적으로 깨졌다(2026-08-20 SEC-1 에서 `toEditorText` 를 넣어 고쳤다). 그런데 그 함수에는
// 검사가 없었다 - 정규식 한 줄만 어긋나도 같은 사고가 조용히 재발한다.
//
// 두 방향으로 본다:
//   변환 정확도 - 각 입력이 기대한 평문이 되는가
//   누출 0     - 결과에 마크다운 기호가 **하나도** 남지 않는가
//
// 사용: node build/verify-editor-text.mjs [--out <dir>]

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)

const args = { out: path.join(REPO, 'verify-out', 'editor-text') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const JS = path.join(REPO, 'app', 'dist', 'main', 'features', 'ai', 'blog-publish.js')
if (!fs.existsSync(JS)) {
  console.error(`빌드 산출물 없음: ${JS} - 먼저 npm run build`)
  process.exit(2)
}
const { toEditorText } = require(JS)

const results = []
let failed = 0
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} - ${detail}`)
}

const NL = String.fromCharCode(10)
const t = (s) => toEditorText(s).trim()

// ===========================================================================
// M1 - 각 마크다운 요소가 기대한 평문이 된다
// ===========================================================================
{
  const cases = [
    ['헤딩', '## 소제목입니다', '소제목입니다'],
    ['헤딩 6단계', '###### 작은 제목', '작은 제목'],
    ['굵게', '이건 **중요한** 말', '이건 중요한 말'],
    ['기울임', '이건 *강조* 말', '이건 강조 말'],
    ['인라인 코드', '값은 `console.log` 입니다', '값은 console.log 입니다'],
    ['글머리 목록', '- 첫째' + NL + '- 둘째', '· 첫째' + NL + '· 둘째'],
    ['번호 목록', '1. 하나' + NL + '2. 둘', '1. 하나' + NL + '2. 둘'],
    ['인용', '> 인용문입니다', '인용문입니다'],
    ['링크', '자세히는 [여기](https://a.example) 참고', '자세히는 여기(https://a.example) 참고'],
    ['이미지(alt 있음)', '![고양이](https://a.example/c.jpg)', '[사진: 고양이]'],
    ['이미지(alt 없음)', '![](https://a.example/c.jpg)', '[사진]'],
    ['표', '| 이름 | 값 |' + NL + '|---|---|' + NL + '| 사과 | 3 |', '이름 · 값' + NL + '사과 · 3'],
  ]
  const bad = cases.filter(([, input, want]) => t(input) !== want)
  check('M1', '마크다운 요소가 기대한 평문으로 바뀐다', bad.length === 0,
    bad.length
      ? bad.map(([n, i]) => `${n}: ${JSON.stringify(t(i))}`).join(' | ').slice(0, 220)
      : `${cases.length}종 전부 일치`)
}

// ===========================================================================
// M2 - 결과에 마크다운 기호가 남지 않는다(누출 0)
// ===========================================================================
{
  const doc = [
    '# 제목',
    '',
    '## 소제목',
    '본문에 **굵게** 와 *기울임* 과 `코드` 가 있습니다.',
    '',
    '- 항목 하나',
    '- 항목 **둘**',
    '',
    '> 인용문',
    '',
    '| 열A | 열B |',
    '|-----|-----|',
    '| 값1 | 값2 |',
    '',
    '![사진설명](https://a.example/x.png)',
    '[링크](https://a.example)',
    '',
    '---',
  ].join(NL)
  const outText = toEditorText(doc)
  const leaks = []
  if (/(^|\n)\s{0,3}#{1,6}\s/.test(outText)) leaks.push('헤딩 #')
  if (/\*\*/.test(outText)) leaks.push('굵게 **')
  if (/!\[[^\]]*\]\(/.test(outText)) leaks.push('이미지 ![]()')
  if (/\[[^\]]+\]\([^)]+\)/.test(outText)) leaks.push('링크 []()')
  if (/(^|\n)\s*\|/.test(outText)) leaks.push('표 파이프 |')
  if (/```/.test(outText)) leaks.push('코드펜스 ```')
  if (/(^|\n)\s*[-*_]{3,}\s*(\n|$)/.test(outText)) leaks.push('수평선 ---')
  check('M2', '변환 결과에 마크다운 기호가 남지 않는다', leaks.length === 0,
    leaks.length ? `누출: ${leaks.join(', ')} / 결과: ${JSON.stringify(outText).slice(0, 200)}` : '7종 기호 전부 제거됨')
}

// ===========================================================================
// M3 - 내용을 잃지 않는다(기호만 벗기고 글자는 남아야 한다)
// ===========================================================================
{
  const doc = [
    '## 오늘의 정리',
    '핵심은 **속도** 와 *정확도* 입니다.',
    '- 사과 3개',
    '1. 첫 단계',
    '> 기억할 것',
    '| 항목 | 수량 |',
    '|---|---|',
    '| 배 | 5 |',
  ].join(NL)
  const outText = toEditorText(doc)
  const mustKeep = ['오늘의 정리', '속도', '정확도', '사과 3개', '첫 단계', '기억할 것', '항목', '수량', '배', '5']
  const lost = mustKeep.filter((w) => !outText.includes(w))
  check('M3', '기호만 벗기고 내용은 그대로 남는다', lost.length === 0,
    lost.length ? `사라진 내용: ${lost.join(', ')}` : `${mustKeep.length}개 조각 전부 보존`)
}

// ===========================================================================
// M4 - 코드펜스 안 내용은 그대로 두되 펜스 표시는 없앤다
// ===========================================================================
{
  const doc = ['설명:', '```js', 'const a = **1**', '```', '끝'].join(NL)
  const outText = toEditorText(doc)
  check('M4', '코드펜스는 표시만 없애고 내용은 손대지 않는다',
    !/```/.test(outText) && outText.includes('const a = **1**'),
    `결과: ${JSON.stringify(outText)}`)
}

// ===========================================================================
// M5 - 이상한 입력에 죽지 않는다
// ===========================================================================
{
  const weird = [null, undefined, '', '   ', 'a'.repeat(5000), '**', '|||', '![](', '#'.repeat(20)]
  const errs = []
  for (const w of weird) {
    try { toEditorText(w) } catch (e) { errs.push(`${JSON.stringify(String(w).slice(0, 12))}: ${e.message}`) }
  }
  check('M5', '빈 값·깨진 마크다운에도 예외가 나지 않는다', errs.length === 0,
    errs.length ? errs.join(' | ') : `${weird.length}종 입력 안전`)
}

fs.mkdirSync(args.out, { recursive: true })
fs.writeFileSync(path.join(args.out, 'editor-text-results.json'), JSON.stringify(results, null, 2))
console.log('\n===== verify-editor-text 결과 =====')
console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
console.log(`PASS=${results.length - failed} FAIL=${failed} (총 ${results.length})`)
process.exit(failed ? 1 : 0)
