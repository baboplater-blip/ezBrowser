#!/usr/bin/env node
// verify-userscript-match.mjs — match pattern 컴파일러 + 메타데이터 파서 (순수 함수, 앱을 띄우지 않는다)
//
// 왜 (묶음 I): 예전 구현은 `*.example.com` 을 통째로 문자열 치환해 항상 리터럴 점(.)을
// 요구했다 — "example.com" 단독(베어 도메인)은 절대 매치되지 않았다(item 6). `@include /regex/`
// 도 지원 안 됐다. 정규식 한 줄만 잘못 고쳐도 조용히 재발하는 종류라 상설 검사로 고정한다.
//
// 사용: node build/verify-userscript-match.mjs [--out <dir>]

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)

const args = { out: path.join(REPO, 'verify-out', 'userscript-match') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const MATCH_JS = path.join(REPO, 'app', 'dist', 'main', 'features', 'userscript', 'match.js')
const INDEX_JS = path.join(REPO, 'app', 'dist', 'main', 'features', 'userscript', 'index.js')
for (const f of [MATCH_JS, INDEX_JS]) {
  if (!fs.existsSync(f)) {
    console.error(`빌드 산출물 없음: ${f} — 먼저 npm run build:main`)
    process.exit(2)
  }
}
const { compilePattern, urlMatchesScript } = require(MATCH_JS)
const { parseUserscript } = require(INDEX_JS)

const results = []
let failed = 0
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}

// ===========================================================================
// M1 — `*.example.com` 이 서브도메인뿐 아니라 베어 도메인 자체도 포함한다(item 6 핵심)
// ===========================================================================
{
  const p = compilePattern('https://*.example.com/*')
  const bare = p.test('https://example.com/path')
  const sub = p.test('https://sub.example.com/path')
  const other = p.test('https://notexample.com/path')
  check('M1', '*.example.com 이 베어 도메인 + 서브도메인을 포함하고 다른 도메인은 제외한다',
    bare && sub && !other,
    `bare=${bare} sub=${sub} other(거부되어야)=${other}`)
}

// ===========================================================================
// M2 — <all_urls> 는 http/https/file/ftp 는 포함, 그 외 스킴은 제외
// ===========================================================================
{
  const p = compilePattern('<all_urls>')
  const ok = p.test('https://a.example/') && p.test('http://a.example/') && p.test('file:///c/x') && !p.test('chrome://settings')
  check('M2', '<all_urls> 가 http/https/file 은 포함하고 chrome: 는 제외한다', ok, `구현: ${p ? 'compiled' : 'null'}`)
}

// ===========================================================================
// M3 — @include 의 /regex/ 형태를 raw 정규식으로 지원한다
// ===========================================================================
{
  const p = compilePattern('/^https:\\/\\/[a-z]+\\.example\\.com\\/item\\/\\d+$/')
  const ok = p && p.test('https://shop.example.com/item/42') && !p.test('https://shop.example.com/item/abc')
  check('M3', '@include /regex/ 형태가 raw 정규식으로 컴파일된다', !!ok,
    `숫자 id 매치=${p ? p.test('https://shop.example.com/item/42') : 'null'} · 문자 id 거부=${p ? !p.test('https://shop.example.com/item/abc') : 'null'}`)
}

// ===========================================================================
// M4 — 스킴 와일드카드 `*://host/*` 는 http/https 만(ftp/file 제외)
// ===========================================================================
{
  const p = compilePattern('*://mail.example.com/*')
  const ok = p.test('https://mail.example.com/inbox') && p.test('http://mail.example.com/inbox') && !p.test('ftp://mail.example.com/inbox')
  check('M4', '스킴 * 는 http/https 만 포함한다(ftp 제외)', ok, `동작 확인`)
}

// ===========================================================================
// M5 — 이상한 입력에도 예외 없이 처리된다. 빈/공백 패턴은 null, 그 외(깨진 /regex/ 포함)는
// 레거시 glob 으로 대체 컴파일되어(설계상 의도 — "실패하면 레거시 glob") null 이 아니어도 된다.
// ===========================================================================
{
  const weird = ['/[/', '***', '', '   ', 'not a url at all', '<all_urls', '://']
  let threw = false
  for (const w of weird) {
    try { compilePattern(w) } catch { threw = true }
  }
  const emptyIsNull = compilePattern('') === null && compilePattern('   ') === null
  check('M5', '이상한 패턴 7종에도 예외가 나지 않고, 빈/공백 패턴만 null 이다', !threw && emptyIsNull,
    `threw=${threw} emptyIsNull=${emptyIsNull}`)
}

// ===========================================================================
// M6 — urlMatchesScript: exclude 가 match 를 이긴다
// ===========================================================================
{
  const pos = [compilePattern('https://*.example.com/*')]
  const exc = [compilePattern('https://example.com/private/*')]
  const allowed = urlMatchesScript('https://example.com/public/x', pos, exc)
  const blocked = urlMatchesScript('https://example.com/private/x', pos, exc)
  check('M6', 'exclude 에 걸리면 match 되더라도 제외된다', allowed && !blocked, `allowed=${allowed} blocked(제외되어야)=${blocked}`)
}

// ===========================================================================
// M7 — parseUserscript: @noframes(값 없는 플래그) 인식
// ===========================================================================
{
  const src = ['// ==UserScript==', '// @name test', '// @match https://a.example/*', '// @noframes', '// ==/UserScript==', ''].join('\n')
  const meta = parseUserscript(src)
  check('M7', '@noframes 플래그가 인식된다', meta.noframes === true, `noframes=${meta.noframes}`)
}

// ===========================================================================
// M8 — parseUserscript: @connect 여러 개 파싱
// ===========================================================================
{
  const src = ['// ==UserScript==', '// @name test', '// @connect api.example.com', '// @connect *', '// ==/UserScript==', ''].join('\n')
  const meta = parseUserscript(src)
  check('M8', '@connect 여러 줄이 배열로 모인다', meta.connect.length === 2 && meta.connect.includes('api.example.com') && meta.connect.includes('*'),
    `connect=${JSON.stringify(meta.connect)}`)
}

// ===========================================================================
// M9 — parseUserscript: @resource "name url" 파싱
// ===========================================================================
{
  const src = ['// ==UserScript==', '// @name test', '// @resource icon https://cdn.example.com/i.png', '// ==/UserScript==', ''].join('\n')
  const meta = parseUserscript(src)
  const ok = meta.resources.length === 1 && meta.resources[0].name === 'icon' && meta.resources[0].url === 'https://cdn.example.com/i.png'
  check('M9', '@resource 가 {name,url} 로 파싱된다', ok, `resources=${JSON.stringify(meta.resources)}`)
}

// ===========================================================================
// M10 — parseUserscript: @require 는 https 만 남고 http 는 조용히 걸러진다(item 5)
// ===========================================================================
{
  const src = [
    '// ==UserScript==', '// @name test',
    '// @require https://cdn.example.com/lib1.js',
    '// @require http://cdn.example.com/lib2.js',
    '// ==/UserScript==', '',
  ].join('\n')
  const meta = parseUserscript(src)
  check('M10', '@require 는 https 만 남고 http 는 걸러진다', meta.requireUrls.length === 1 && meta.requireUrls[0] === 'https://cdn.example.com/lib1.js',
    `requireUrls=${JSON.stringify(meta.requireUrls)}`)
}

fs.mkdirSync(args.out, { recursive: true })
fs.writeFileSync(path.join(args.out, 'userscript-match-results.json'), JSON.stringify(results, null, 2))
console.log('\n===== verify-userscript-match 결과 =====')
console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
console.log(`PASS=${results.length - failed} FAIL=${failed} (총 ${results.length})`)
process.exit(failed ? 1 : 0)
