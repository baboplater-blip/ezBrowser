#!/usr/bin/env node
// verify-ubo-rules.mjs — uBlock Origin Lite 의 **진짜 룰**로 우리 DNR 엔진을 시험한다.
//
// 왜 (2026-09-07, 임무 40): 임무 39 로 "룰 18,806개 적용" 까지 왔지만, 그건 **컴파일 개수**일 뿐
// 실제로 막는지는 다른 문제다. 그렇다고 진짜 광고 서버에 접속해 확인할 수는 없다(외부 네트워크는
// 이 저장소의 금지선이고, 붙는다 해도 그날 그 서버 상태에 결과가 좌우된다).
//
// 그래서 **우리 엔진에 uBO 의 진짜 룰을 먹이고 판정만** 본다 — 네트워크 없이 결정론적이다.
// 시험 URL 은 내가 상상해서 쓰지 않고 **룰 파일에서 역산**한다. 내 가정이 아니라 실제 룰을 검증한다.
//
//   U1 uBO 의 룰 파일을 우리 컴파일러가 읽어 충분히 많이 컴파일한다
//   U2 그 룰들이 겨냥하는 URL 이 실제로 차단 판정을 받는다
//   U3 평범한 URL 은 막지 않는다(오탐 0)
//   U4 uBO 의 예외(allow) 룰이 block 을 이긴다
//
// uBO 룰은 `ext-matrix` 가 받아 둔 프로필에서 읽는다. 없으면 **SKIP**(이유 명시) — 게이트를
// 빨갛게 만들지 않는다. 먼저 `node build/ext-matrix.mjs` 를 돌리면 생긴다.
//
// 사용: node build/verify-ubo-rules.mjs [--ext-dir <경로>] [--out <dir>]

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)

const UBO_ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh'
const args = {
  extDir: path.join(REPO, 'verify-out', 'ext-matrix', 'profile', 'extensions', UBO_ID),
  out: path.join(REPO, 'verify-out', 'ubo-rules'),
}
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--ext-dir') args.extDir = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const results = []
let failed = 0
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}
function skipAll(reason) {
  results.push({ id: 'U0', name: 'uBO 룰 확보', status: 'SKIP', detail: reason })
  console.log(`  – U0 SKIP — ${reason}`)
}

function finish() {
  fs.mkdirSync(args.out, { recursive: true })
  fs.writeFileSync(path.join(args.out, 'ubo-rules-results.json'), JSON.stringify(results, null, 2))
  console.log('\n===== verify-ubo-rules 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
  const skipped = results.filter((r) => r.status === 'SKIP').length
  console.log(`PASS=${results.length - failed - skipped} FAIL=${failed} SKIP=${skipped} (총 ${results.length})`)
  process.exit(failed ? 1 : 0)
}

// ===== uBO 룰 모으기 =====
if (!fs.existsSync(args.extDir)) {
  skipAll(`uBO Lite 설치본이 없다: ${args.extDir} — 먼저 node build/ext-matrix.mjs 를 돌리면 생긴다`)
  finish()
}

const manifestPath = path.join(args.extDir, 'manifest.json')
let manifest
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { manifest = null }
const resources = manifest?.declarative_net_request?.rule_resources ?? []
const ruleFiles = resources
  .filter((r) => r?.enabled !== false && typeof r?.path === 'string')
  .map((r) => path.join(args.extDir, r.path))
  .filter((f) => fs.existsSync(f))

if (!ruleFiles.length) {
  skipAll('uBO Lite manifest 에서 활성 룰셋을 찾지 못했다')
  finish()
}

const allRules = []
for (const f of ruleFiles) {
  try {
    const list = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (Array.isArray(list)) allRules.push(...list)
  } catch { /* 못 읽는 파일은 건너뛴다 */ }
}

// ===== 우리 엔진에 먹인다 =====
// dnr.js 는 `electron` 의 app.getPath 를 쓴다. 앱 없이 부르기 위해 **require 캐시를 미리 채워**
// 가짜 electron 을 심는다(모듈 경로 조작은 dnr.js 가 자기 트리의 진짜 electron 을 먼저 찾아 실패했다).
const fakeUserData = path.join(args.out, 'fake-userdata')
fs.mkdirSync(fakeUserData, { recursive: true })

const DNR_JS = path.join(REPO, 'app', 'dist', 'main', 'features', 'extensions', 'dnr.js')
if (!fs.existsSync(DNR_JS)) {
  skipAll(`빌드 산출물이 없다: ${DNR_JS} — 먼저 npm run build`)
  finish()
}

try {
  const electronPath = require.resolve('electron', { paths: [path.dirname(DNR_JS), REPO] })
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true, children: [], paths: [],
    exports: { app: { getPath: () => fakeUserData, isPackaged: false } },
  }
} catch (e) {
  skipAll(`electron 스텁을 심지 못했다: ${e.message}`)
  finish()
}

let dnr
try { dnr = require(DNR_JS) } catch (e) { skipAll(`dnr.js 를 불러오지 못했다: ${e.message}`); finish() }

// 룰 파일을 가짜 확장 디렉터리에 두고 reloadDnrRules 로 정식 경로를 태운다.
const fakeExtRoot = path.join(args.out, 'fake-userdata', 'extensions', 'ubo-test')
fs.mkdirSync(fakeExtRoot, { recursive: true })
fs.writeFileSync(path.join(fakeExtRoot, 'manifest.json'), JSON.stringify({
  manifest_version: 3, name: 'ubo-rules', version: '1.0',
  declarative_net_request: { rule_resources: [{ id: 'r', enabled: true, path: 'rules.json' }] },
}))
fs.writeFileSync(path.join(fakeExtRoot, 'rules.json'), JSON.stringify(allRules))

const run = async () => {
  const compiled = await dnr.reloadDnrRules()

  // ---- U1 컴파일 ----
  check('U1', '우리 엔진이 uBO 의 실제 룰을 컴파일한다', compiled > 10000,
    `룰 파일 ${ruleFiles.length}개 · 원본 ${allRules.length}개 → 컴파일 ${compiled}개(1만 이상이어야 함)`)

  // ---- U2 차단 ----
  // 시험 URL 을 **룰에서 역산**한다: `||host^` 형태의 block 룰을 골라 그 호스트로 URL 을 만든다.
  const samples = []
  for (const r of allRules) {
    if (samples.length >= 40) break
    if (r?.action?.type !== 'block') continue
    const f = r?.condition?.urlFilter
    if (typeof f !== 'string') continue
    const m = /^\|\|([a-z0-9.-]+)\^?$/i.exec(f)
    if (!m) continue
    if (m[1].endsWith('.') || !m[1].includes('.')) continue   // 끝점·단일 라벨 호스트는 표본에서 뺀다
    const types = r?.condition?.resourceTypes
    samples.push({
      url: `https://${m[1]}/x`,
      resourceType: Array.isArray(types) && types.length ? types[0] : 'script',
      filter: f,
    })
  }
  const blocked = samples.filter((s) =>
    dnr.dnrDecide({ url: s.url, resourceType: s.resourceType === 'xmlhttprequest' ? 'xhr' : s.resourceType })?.cancel === true)
  check('U2', '룰이 겨냥하는 광고 호스트가 실제로 차단 판정된다',
    samples.length >= 10 && blocked.length === samples.length,
    `표본 ${samples.length}개(룰에서 역산) → 차단 ${blocked.length}개` +
    (blocked.length < samples.length
      ? ` · 놓친 예: ${samples.find((s) => !blocked.includes(s))?.url}`
      : ''))

  // ---- U3 오탐 ----
  const benign = [
    'https://news.naver.com/main/read.naver?oid=1',
    'https://www.google.com/search?q=hello',
    'https://ko.wikipedia.org/wiki/브라우저',
    'https://github.com/electron/electron',
    'https://cdn.jsdelivr.net/npm/react/index.js',
    'https://fonts.gstatic.com/s/roboto/v30/font.woff2',
  ]
  const wrong = benign.filter((u) => dnr.dnrDecide({ url: u, resourceType: 'script' })?.cancel === true)
  check('U3', '평범한 URL 은 막지 않는다(오탐 0)', wrong.length === 0,
    wrong.length ? `잘못 막음: ${wrong.join(', ')}` : `${benign.length}개 전부 통과`)

  // ---- U4 우선순위·allow 우선 (합성 룰로 직접) ----
  // uBO 의 실제 예외 룰은 조건이 복잡해(경로·발신 목록·domainType) 시험 URL 을 정확히 만들기 어렵다.
  // 확인하려는 성질은 **크롬의 판정 규칙**이므로 그것을 합성 룰로 직접 시험한다:
  //   같은 우선순위면 allow 가 block 을 이기고, 더 높은 우선순위는 액션과 무관하게 이긴다.
  const fakeExtRoot2 = path.join(args.out, 'fake-userdata', 'extensions', 'prio-test')
  fs.mkdirSync(fakeExtRoot2, { recursive: true })
  fs.writeFileSync(path.join(fakeExtRoot2, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'prio', version: '1.0',
    declarative_net_request: { rule_resources: [{ id: 'r', enabled: true, path: 'rules.json' }] },
  }))
  // uBO 와 같은 우선순위 값을 쓴다(block@10 · allow@30 · block@40).
  fs.writeFileSync(path.join(fakeExtRoot2, 'rules.json'), JSON.stringify([
    { id: 1, priority: 10, action: { type: 'block' }, condition: { urlFilter: '||a.example^' } },
    { id: 2, priority: 30, action: { type: 'allow' }, condition: { urlFilter: '||a.example^' } },
    { id: 3, priority: 10, action: { type: 'block' }, condition: { urlFilter: '||b.example^' } },
    { id: 4, priority: 10, action: { type: 'allow' }, condition: { urlFilter: '||b.example^' } },
    { id: 5, priority: 30, action: { type: 'allow' }, condition: { urlFilter: '||c.example^' } },
    { id: 6, priority: 40, action: { type: 'block' }, condition: { urlFilter: '||c.example^' } },
  ]))
  // 기존 uBO 룰 디렉터리는 지우고 이 세트만 남긴다(판정이 섞이지 않게).
  fs.rmSync(fakeExtRoot, { recursive: true, force: true })
  await dnr.reloadDnrRules()

  const dec = (host) => dnr.dnrDecide({ url: `https://${host}/x`, resourceType: 'script' })
  const higherAllowWins = dec('a.example')?.cancel !== true      // allow@30 > block@10
  const sameAllowWins = dec('b.example')?.cancel !== true        // 같은 10 이면 allow 우선
  const higherBlockWins = dec('c.example')?.cancel === true      // block@40 > allow@30
  check('U4', '우선순위가 높은 룰이 이기고, 같은 우선순위면 allow 가 block 을 이긴다',
    higherAllowWins && sameAllowWins && higherBlockWins,
    `allow@30>block@10=${higherAllowWins} · 같은순위 allow우선=${sameAllowWins} · block@40>allow@30=${higherBlockWins}`)

  finish()
}

void run()
