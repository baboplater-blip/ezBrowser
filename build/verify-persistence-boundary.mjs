#!/usr/bin/env node
// verify-persistence-boundary.mjs — 저장 실패 가시성 + 게시 확인 근거 판정 검증 (앱을 띄우지 않는다)
//
// 왜 (2026-09-19): 이 라운드에서 두 가지를 고쳤고, 둘 다 "조용히 틀리면 되돌릴 수 없는 일이 난다"는
// 공통점이 있다.
//
//  1) json-store 의 flush() 가 void → boolean 이 됐다. 디스크가 막혔는데(권한·용량·읽기전용 등)
//     호출자가 그걸 모르면, "저장을 확정한 뒤에만 되돌릴 수 없는 외부 동작(게시·매크로 진행 등)을
//     시작한다"는 경계가 코드가 아니라 말로만 지켜진다. flush() 가 false 를 돌려주는데도 호출자가
//     계속 진행하면 사용자는 "저장됐다고 들었는데 재시작하니 사라졌다"를 겪는다.
//     그리고 실패 자체보다 더 위험한 건 **실패 처리 도중 정상 파일을 훼손하는 것**이다 — 이 검사는
//     실패했을 때 진짜로 아무 일도 안 일어나는지(옛 내용 보존, tmp 잔재 없음)를 본다.
//
//  2) agent-gate 의 "게시 여부 확인 근거" 판정(`sightingSupportsPublication`)이 호스트·문구·관찰시각
//     3필드 계약에서 **작성자(author/authorScope)·게시시각(postedAt)·모호함(ambiguous) 을 더한 5필드
//     계약**으로 바뀌었다(2026-09-19, V 그룹). 3필드만으로는 ① 같은 사이트의 남의 계정 글, ② 같은
//     캡션을 가진 오래된 글도 근거로 통과한다 — 둘 다 되돌릴 수 없는 오판(중복 게시 또는 영구 대기)
//     으로 이어진다. 그래서 "누가 썼는가"·"언제 올라갔는가" 두 축을 더 보고, 그것을 **확인한 것**
//     (다른 계정·오래된 글 → 확정 거부)과 **읽지 못한 것**(계정 표기 없음·시각 없음·구조 모호 →
//     `uncertain:true`, "모름")을 구분한다 — 이 구분이 없으면 "안 올라갔다" 고 잘못 단정해 같은 글이
//     또 올라간다. V 그룹은 판정 순서 11단계 전부와 이 구분을 앱 없이 순수 함수로 검증한다.
//     DOM → 판정 끝에서 끝까지의 실증은 `build/verify-publish-evidence-cdp.mjs` 가 별도로 맡는다.
//
// 두 검사군 모두 **양방향**으로 본다(허용돼야 할 것은 허용, 거부돼야 할 것은 거부) + 음성 대조로
// 판정식이 실제로 무언가를 잡는지 스스로 증명한다.
//
// 사용: node build/verify-persistence-boundary.mjs [--out <dir>]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)

const args = { out: path.join(REPO, 'verify-out', 'persistence-boundary') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const JSON_STORE_JS = path.join(REPO, 'app', 'dist', 'main', 'features', 'ai', 'json-store.js')
const GATE_JS = path.join(REPO, 'app', 'dist', 'main', 'features', 'ai', 'agent-gate.js')
for (const f of [JSON_STORE_JS, GATE_JS]) {
  if (!fs.existsSync(f)) {
    console.error(`빌드 산출물 없음: ${f} — 먼저 npm run build`)
    process.exit(2)
  }
}

const results = []
let failed = 0
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
  if (!ok) failed++
}

// ===========================================================================
// P 그룹 — json-store 저장 경계 (electron 을 임시 디렉터리로 스텁)
// ===========================================================================

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-persist-'))

// json-store.ts 는 `app.getPath('userData')` 로 저장 위치를 정한다. 실제 electron 없이 순수 함수처럼
// 시험하려면 verify-auto-publish.mjs 와 같은 방식으로 require('electron') 을 가로채 임시 디렉터리를
// 돌려준다(파일 경로 결정에만 쓰이므로 이 정도 스텁으로 충분하다).
const Module = require('module')
const origLoad = Module._load
Module._load = function (req, ...rest) {
  if (req === 'electron') {
    return { app: { getPath: () => root } }
  }
  return origLoad.call(this, req, ...rest)
}

const store = require(JSON_STORE_JS)

// 순환 참조 객체 — JSON.stringify 가 반드시 던진다(직렬화 실패를 인위로 만드는 유일하게 정직한 방법).
function makeCircular(id) {
  const o = { id }
  o.self = o
  return { items: [o] }
}

/** debounceMs 를 크게 둬 타이머가 저절로 안 돈다 — 모든 저장은 우리가 명시적으로 flush() 한다. */
const NO_AUTO_MS = 999999

// --- P1 — 직렬화 실패: 정상 파일을 먼저 만들고, 그 다음 순환 참조로 stringify 를 터뜨린다.
{
  let broken = false
  const s1 = store.createJsonStore({
    fileName: 'p1.json', label: 'p1', debounceMs: NO_AUTO_MS,
    snapshot: () => (broken ? makeCircular('x') : { items: [{ id: 'a', v: 'good' }] }),
  })
  s1.markDirty()
  const okFirst = s1.flush()
  const file1 = path.join(root, 'p1.json')
  const before = fs.existsSync(file1) ? fs.readFileSync(file1, 'utf-8') : null

  broken = true
  s1.markDirty()
  const okSecond = s1.flush()
  const after = fs.existsSync(file1) ? fs.readFileSync(file1, 'utf-8') : null

  check('P1', '직렬화 실패 시 flush()=false + 기존 파일 훼손 없음',
    okFirst === true && okSecond === false && before !== null && before === after,
    `첫 저장=${okFirst} · 실패 저장=${okSecond} · 내용 보존=${before === after}`)
}

// --- P2 — 쓰기 실패: writeFileSync 가 .tmp 경로에 대해 던지게 몽키패치.
{
  const s2 = store.createJsonStore({
    fileName: 'p2.json', label: 'p2', debounceMs: NO_AUTO_MS,
    snapshot: () => ({ items: [{ id: 'b' }] }),
  })
  const file2 = path.join(root, 'p2.json')
  const origWriteFileSync = fs.writeFileSync
  let ok2
  try {
    fs.writeFileSync = function (p, ...rest) {
      if (String(p).endsWith('.tmp')) throw new Error('시뮬레이션: 디스크 쓰기 실패(EIO)')
      return origWriteFileSync.call(fs, p, ...rest)
    }
    s2.markDirty()
    ok2 = s2.flush()
  } finally {
    fs.writeFileSync = origWriteFileSync
  }
  const leftoverTmp = fs.readdirSync(root).filter((n) => n.startsWith('p2.json.') && n.endsWith('.tmp'))
  const fileCreated = fs.existsSync(file2)
  check('P2', '쓰기 실패 시 flush()=false + tmp 잔재 0 + 정상 파일 미생성',
    ok2 === false && leftoverTmp.length === 0 && !fileCreated,
    `flush=${ok2} · tmp잔재=${leftoverTmp.length}개 · 파일생성=${fileCreated}`)
}

// --- P3/P4/P5 — rename 실패(읽기 전용) → 복구 → 재시작 재로드. 같은 파일을 이어서 쓴다.
let p3ok = false, p4ok = false
{
  const file345 = path.join(root, 'p345.json')
  let data = { items: [{ id: 'r1', text: 'v1-baseline' }] }
  const s345 = store.createJsonStore({
    fileName: 'p345.json', label: 'p345', debounceMs: NO_AUTO_MS,
    snapshot: () => data,
  })

  // 기준선: 정상 저장.
  s345.markDirty()
  const baseline = s345.flush()
  const baselineContent = fs.readFileSync(file345, 'utf-8')

  // P3 — Windows 실측: renameSync 가 읽기 전용 대상에 EPERM 을 던진다.
  fs.chmodSync(file345, 0o444)
  data = { items: [{ id: 'r1', text: 'v2-blocked-attempt' }] }
  s345.markDirty()
  const okP3 = s345.flush()
  const afterP3 = fs.readFileSync(file345, 'utf-8')
  const leftoverTmpP3 = fs.readdirSync(root).filter((n) => n.startsWith('p345.json.') && n.endsWith('.tmp'))
  p3ok = baseline === true && okP3 === false && afterP3 === baselineContent && leftoverTmpP3.length === 0
  check('P3', 'rename 실패(읽기 전용) 시 flush()=false + 옛 내용 보존 + tmp 잔재 0',
    p3ok,
    `기준선=${baseline} · rename실패=${okP3} · 내용보존=${afterP3 === baselineContent} · tmp잔재=${leftoverTmpP3.length}개`)

  // P4 — 양성 대조: 쓰기 권한을 복구하면 실제로 다시 저장된다(그것도 최신 스냅샷으로).
  fs.chmodSync(file345, 0o666)
  data = { items: [{ id: 'r1', text: 'v3-recovered' }] }
  const okP4 = s345.flush()  // markDirty 는 P3 에서 이미 했고 아직 착지 못 했으므로 seq 는 여전히 dirty
  const afterP4 = JSON.parse(fs.readFileSync(file345, 'utf-8'))
  p4ok = okP4 === true && afterP4.items?.length === 1 && afterP4.items[0]?.text === 'v3-recovered'
  check('P4', '복구 후 flush()=true + 최신 스냅샷이 실제로 저장됨(양성 대조)',
    p4ok,
    `flush=${okP4} · 저장내용=${JSON.stringify(afterP4)}`)

  // P5 — 재시작 시 loadJsonObject 로 다시 읽어도 레코드가 정확히 1건, 중복 없음.
  const reloaded = store.loadJsonObject('p345.json', 'p345', 'items')
  const items = Array.isArray(reloaded?.items) ? reloaded.items : []
  const dupIds = new Set(items.map((it) => it?.id))
  check('P5', '재시작 재로드 시 레코드 정확히 1건, 중복 없음',
    p4ok && items.length === 1 && items[0]?.id === 'r1' && items[0]?.text === 'v3-recovered' && dupIds.size === items.length,
    `건수=${items.length} · 내용=${JSON.stringify(items)}`)
}

// --- P6 — 쓸 것이 없으면 true, 정상 파일을 건드리지 않는다(디스크 접근 자체가 없어야 한다).
{
  const file6 = path.join(root, 'p6.json')
  const s6 = store.createJsonStore({
    fileName: 'p6.json', label: 'p6', debounceMs: NO_AUTO_MS,
    snapshot: () => ({ items: [{ id: 'z' }] }),
  })
  s6.markDirty()
  const first = s6.flush()
  const mtime1 = fs.statSync(file6).mtimeMs
  const second = s6.flush() // markDirty 를 다시 부르지 않았다 — seq <= persistedSeq 라 디스크를 안 건드려야 한다
  const mtime2 = fs.statSync(file6).mtimeMs
  check('P6', '변경 없이 flush() 하면 true + 파일 mtime 불변(디스크 미접근)',
    first === true && second === true && mtime1 === mtime2,
    `첫 저장=${first} · 재호출=${second} · mtime 동일=${mtime1 === mtime2}`)
}

Module._load = origLoad // electron 스텁 해제 — 이후 require 는 전부 정상 경로로

// ===========================================================================
// V 그룹 — 게시 확인 근거 판정: 5필드 계약 · 판정 순서 11단계 (순수 함수, electron 불필요)
// ===========================================================================
//
// sightingSupportsPublication(s, expect) 의 판정 순서(첫 번째로 걸리는 것이 결론):
//   1  url/needle 비어 있음                                   → ok:false
//   2  host 불일치                                             → ok:false
//   3  needle 불일치                                           → ok:false
//   4  at < notBefore                                          → ok:false
//   5  s.ambiguous 있음                                        → ok:false, uncertain:true
//   6  expect.account 없음                                     → ok:false, uncertain:true
//   7  s.author 없거나 authorScope !== 'post'                  → ok:false, uncertain:true
//   8  계정 불일치(정규화 비교) — wrong-author                 → ok:false (확정 거부)
//   9  s.postedAt 없음                                         → ok:false, uncertain:true
//   10 postedAt < attemptStartedAt - PUBLICATION_CLOCK_SKEW_MS — old-post → ok:false (확정 거부)
//   11 전부 통과 — fresh-expected-author                       → ok:true
//
// 1~11 을 전부 하나씩 분리 시험한다. 특히 8(wrong-author)·10(old-post)·11(fresh-expected-author)·
// 5(ambiguous) 는 과제가 "반드시" 로 지목한 네 가지다. uncertain 플래그는 "확인한 거부"(8·10)와
// "읽지 못해 모름"(5·6·7·9)을 구분하는 것이 이 설계의 핵심이므로 매 단계 함께 검사한다.

const gate = require(GATE_JS)

const NOW = Date.now()
const ATTEMPT_STARTED_AT = NOW
const NOT_BEFORE = NOW - 10000
const HOST = 'instagram.com'
const NEEDLE = 'validation needle for v group test' // 이미 정규화된(소문자·공백 정리) 형태로 골라 재정규화에 흔들리지 않게 한다.
const PAGE_URL = 'https://www.instagram.com/p/vgroup/' // www 서브도메인 — instagram.com 기대에 부합해야 함
const OTHER_HOST_URL = 'https://evil.example.com/p/vgroup/'
const MY_ACCOUNT = 'ez_test_account'

const EXPECT_FULL = {
  host: HOST,
  needles: [NEEDLE],
  notBefore: NOT_BEFORE,
  account: MY_ACCOUNT,
  attemptStartedAt: ATTEMPT_STARTED_AT,
}

/** 순서 11단계를 전부 통과하는 "정상" 근거. 각 검사는 여기서 딱 한 군데만 깨뜨린다. */
function freshSighting(overrides = {}) {
  return {
    url: PAGE_URL,
    host: HOST,
    needle: NEEDLE,
    snippet: '검증용 발췌',
    at: ATTEMPT_STARTED_AT + 1000,
    author: MY_ACCOUNT,
    authorScope: 'post',
    postedAt: ATTEMPT_STARTED_AT + 2000,
    postedAtText: '방금',
    ...overrides,
  }
}

// --- V1 (순서1) — url 또는 needle 이 비어 있으면 거부, uncertain 아님.
{
  const v1a = gate.sightingSupportsPublication(freshSighting({ url: '' }), EXPECT_FULL)
  const v1b = gate.sightingSupportsPublication(freshSighting({ needle: '' }), EXPECT_FULL)
  check('V1', '순서1: url/needle 비어 있음 → 거부(uncertain 아님)',
    v1a.ok === false && !v1a.uncertain && v1b.ok === false && !v1b.uncertain,
    `url빈값=${JSON.stringify(v1a)} · needle빈값=${JSON.stringify(v1b)}`)
}

// --- V2 (순서2) — 다른 사이트에서 본 것은 거부.
{
  const v2 = gate.sightingSupportsPublication(freshSighting({ url: OTHER_HOST_URL }), EXPECT_FULL)
  check('V2', '순서2: 호스트 불일치 → 거부(uncertain 아님)', v2.ok === false && !v2.uncertain, JSON.stringify(v2))
}

// --- V3 (순서3) — 지금 캡션과 다른 문구는 거부.
{
  const v3 = gate.sightingSupportsPublication(freshSighting({ needle: '완전히 다른 내용의 문구입니다' }), EXPECT_FULL)
  check('V3', '순서3: 문구 불일치 → 거부(uncertain 아님)', v3.ok === false && !v3.uncertain, JSON.stringify(v3))
}

// --- V4 (순서4) — 이번 확인 이전에 기록된 오래된 근거는 거부.
{
  const v4 = gate.sightingSupportsPublication(freshSighting({ at: NOT_BEFORE - 5000 }), EXPECT_FULL)
  check('V4', '순서4: at < notBefore → 거부(uncertain 아님)', v4.ok === false && !v4.uncertain, JSON.stringify(v4))
}

// --- V5 (순서5, ambiguous) — 화면 구조가 모호하면 "모름"(uncertain:true). 확정 거부가 아니다.
{
  const v5 = gate.sightingSupportsPublication(freshSighting({ ambiguous: '글 단위 컨테이너를 찾지 못함' }), EXPECT_FULL)
  check('V5', '순서5(ambiguous): 구조 모호 → "모름"(uncertain:true)',
    v5.ok === false && v5.uncertain === true, JSON.stringify(v5))
}

// --- V6 (순서6) — 어느 계정으로 올리는지 설정돼 있지 않으면 자동 확정하지 않는다("모름").
{
  const { account: _omit, ...expectNoAccount } = EXPECT_FULL
  const v6 = gate.sightingSupportsPublication(freshSighting(), expectNoAccount)
  check('V6', '순서6: 기대 계정 미설정 → "모름"(uncertain:true)', v6.ok === false && v6.uncertain === true, JSON.stringify(v6))
}

// --- V7 (순서7) — 작성자를 글 영역에서 못 읽었으면(없음, 또는 authorScope !== 'post') "모름".
{
  const v7a = gate.sightingSupportsPublication(freshSighting({ author: undefined }), EXPECT_FULL)
  const v7b = gate.sightingSupportsPublication(freshSighting({ authorScope: 'nav' }), EXPECT_FULL)
  check('V7', '순서7: 작성자 없음 / 글 영역 밖에서 읽음 → "모름"(uncertain:true)',
    v7a.ok === false && v7a.uncertain === true && v7b.ok === false && v7b.uncertain === true,
    `작성자없음=${JSON.stringify(v7a)} · scope≠post=${JSON.stringify(v7b)}`)
}

// --- V8 (순서8, wrong-author) — 다른 계정의 글은 **절대 근거로 쓰지 않는다.**
//
// 다만 "확정 거부" 로 말할지 "모름" 으로 말할지는 **그 작성자 값을 얼마나 믿을 수 있는가**에 달렸다
// (2026-09-19 적대적 리뷰 H1). 화면 구조 추정(캡션 위의 @이름·프로필 링크)으로 읽은 값이 빗나가면,
// "다른 계정의 글" 이라는 단정을 본 사용자가 **"게시 안 됨"** 을 눌러 차단을 풀고 **같은 글을 또
// 올린다** — 이 코드가 막으려던 바로 그 사고다. 그래서 출처별로 결론의 **강도**가 달라야 한다.
//
// ⚠ 기준을 느슨하게 한 것이 아니다. 두 경우 모두 `ok:false`(근거로 인정하지 않음)는 그대로이고,
//   여기에 **"확신의 정도가 출처와 맞는가"** 라는 조건이 하나 더 붙었다.
{
  const heur = gate.sightingSupportsPublication(
    freshSighting({ author: 'someone_else', authorSource: 'heuristic' }), EXPECT_FULL)
  const struct = gate.sightingSupportsPublication(
    freshSighting({ author: 'someone_else', authorSource: 'structural' }), EXPECT_FULL)
  check('V8', '순서8(wrong-author): 어느 출처든 근거로 인정하지 않는다 — 추정이면 "모름", 명시 표기면 "확정 거부"',
    heur.ok === false && heur.uncertain === true
    && struct.ok === false && !struct.uncertain,
    `추정출처=${JSON.stringify(heur)} · 명시표기=${JSON.stringify(struct)}`)
}

// --- V8-FUTURE (순서9.5, H2) — 미래 시각 글(예약 게시)은 아직 공개되지 않았다.
{
  const future = gate.sightingSupportsPublication(
    freshSighting({ postedAt: Date.now() + (gate.PUBLICATION_CLOCK_SKEW_MS + 3600_000) }), EXPECT_FULL)
  check('V8-FUTURE', '미래 시각 글(예약 게시)은 완료 근거가 아니다 → "모름"',
    future.ok === false && future.uncertain === true, JSON.stringify(future))
}

// --- V9 (순서9) — 글 자체의 게시 시각을 못 읽었으면 "모름".
{
  const v9 = gate.sightingSupportsPublication(freshSighting({ postedAt: undefined }), EXPECT_FULL)
  check('V9', '순서9: 게시시각을 못 읽음 → "모름"(uncertain:true)', v9.ok === false && v9.uncertain === true, JSON.stringify(v9))
}

// --- V10 (순서10, old-post) — 시계 오차(5분) 밖으로 오래된 글은 "확정 거부".
{
  const stalePostedAt = ATTEMPT_STARTED_AT - (gate.PUBLICATION_CLOCK_SKEW_MS + 100000)
  const v10 = gate.sightingSupportsPublication(freshSighting({ postedAt: stalePostedAt, postedAtText: '30일 전' }), EXPECT_FULL)
  check('V10', '순서10(old-post): 시도 시작보다 훨씬 전 글 → 확정 거부(uncertain 아님)',
    v10.ok === false && !v10.uncertain, JSON.stringify(v10))
}

// --- V-BOUND — 시계 오차 경계값(postedAt === attemptStartedAt - skew)은 "<" 조건이라 거부되면 안 된다.
{
  const boundaryPostedAt = ATTEMPT_STARTED_AT - gate.PUBLICATION_CLOCK_SKEW_MS
  const vb = gate.sightingSupportsPublication(freshSighting({ postedAt: boundaryPostedAt }), EXPECT_FULL)
  check('V-BOUND', '시계 오차 경계값은 거부되지 않음(엄격한 미만 비교)', vb.ok === true, JSON.stringify(vb))
}

// --- V11 (순서11, fresh-expected-author) — 전부 통과하면 ok:true(양성 대조).
{
  const v11 = gate.sightingSupportsPublication(freshSighting(), EXPECT_FULL)
  check('V11', '순서11(fresh-expected-author): 전부 통과 → ok:true', v11.ok === true, JSON.stringify(v11))
}

// --- V-NORM — normalizeAccountName: 소문자·trim·선행 '@'·후행 '/' 제거(계약에 명시된 4개 규칙만 시험).
{
  const cases = [
    ['  @Ez_Test_Account/ ', 'ez_test_account'],
    ['PlainName', 'plainname'],
    ['@Already//', 'already'],
    [undefined, ''],
  ]
  const got = cases.map(([input, want]) => ({ input, want, actual: gate.normalizeAccountName(input) }))
  const allOk = got.every((r) => r.actual === r.want)
  check('V-NORM', 'normalizeAccountName: 소문자·trim·선행@·후행/ 제거', allOk,
    got.map((r) => `${JSON.stringify(r.input)}→"${r.actual}"(기대"${r.want}")`).join(' · '))
}

// --- V-SKEW — PUBLICATION_CLOCK_SKEW_MS 는 5분(300000ms).
{
  const skewOk = typeof gate.PUBLICATION_CLOCK_SKEW_MS === 'number' && gate.PUBLICATION_CLOCK_SKEW_MS === 5 * 60_000
  check('V-SKEW', 'PUBLICATION_CLOCK_SKEW_MS = 5분(300000ms)', skewOk, `값=${gate.PUBLICATION_CLOCK_SKEW_MS}`)
}

// --- V-NEG 음성 대조 — 옛 3필드 계약(호스트·문구·관찰시각만)을 흉내낸 느슨한 판정 복제본이라면
//     wrong-author(V8)·old-post(V10) 의 나쁜 근거를 통과시켜 버린다는 것을 보여, 실제
//     sightingSupportsPublication 이 추가한 작성자·게시시각 검사가 검출력을 갖고 있음을 증명한다.
//     제품 코드는 손대지 않는다 — looseJudge3Field 는 이 하네스 안에만 존재한다.
{
  function looseJudge3Field(s, expect) {
    if (!s.url || !s.needle) return { ok: false }
    let h = ''
    try { h = new URL(s.url).hostname.toLowerCase() } catch { return { ok: false } }
    const wantHost = String(expect.host ?? '').toLowerCase()
    if (h !== wantHost && !h.endsWith(`.${wantHost}`)) return { ok: false }
    if (!expect.needles.includes(s.needle)) return { ok: false }
    if (typeof s.at !== 'number' || s.at < expect.notBefore) return { ok: false }
    return { ok: true } // 작성자·게시시각은 전혀 보지 않는다 — 옛 3필드 계약 그대로
  }

  const wrongAuthorSighting = freshSighting({ author: 'someone_else' })
  const oldPostSighting = freshSighting({ postedAt: ATTEMPT_STARTED_AT - (gate.PUBLICATION_CLOCK_SKEW_MS + 100000) })

  const looseAcceptsWrongAuthor = looseJudge3Field(wrongAuthorSighting, EXPECT_FULL).ok === true
  const looseAcceptsOldPost = looseJudge3Field(oldPostSighting, EXPECT_FULL).ok === true
  const realRejectsWrongAuthor = gate.sightingSupportsPublication(wrongAuthorSighting, EXPECT_FULL).ok === false
  const realRejectsOldPost = gate.sightingSupportsPublication(oldPostSighting, EXPECT_FULL).ok === false

  check('V-NEG', '음성 대조 — 옛 3필드 계약(작성자·게시시각 무시)은 wrong-author·old-post 를 통과시킨다',
    looseAcceptsWrongAuthor && looseAcceptsOldPost && realRejectsWrongAuthor && realRejectsOldPost,
    `느슨한판정: 다른계정=${looseAcceptsWrongAuthor}·오래된글=${looseAcceptsOldPost} `
    + `/ 실제판정: 다른계정거부=${realRejectsWrongAuthor}·오래된글거부=${realRejectsOldPost}`)
}

// ===========================================================================
// B 그룹 — **태어날 때부터 막힌 게시 작업** (2026-09-19)
// ===========================================================================
//
// 왜 (실제 결함이었다): 게시 작업을 만든 **뒤에** `setResumeBlock` + flush 로 막으려 했는데,
// 그 flush 가 실패하는 상황이 바로 "물러나야 하는" 상황(저장이 막힘)이다 — 즉 **막는 행위 자체가
// 저장에 의존**했다. 저장이 막히면 차단도 못 적고, 디스크에는 차단 없는 `queued` 게시 작업이 남아
// 사용자가 작업 목록에서 그것을 직접 시작할 수 있었다(= 내구성 경계를 우회한 게시).
//
// 고친 방식: **막힌 상태가 기본값**이다. `createTask({ blockedReason })` 으로 태어날 때 빗장을 걸고,
// 내구성 경계가 확정된 뒤에만 푼다. 그러면 저장이 한 번도 성공하지 않아도 안전하다.
//
// 여기서 확인하는 것은 그 성질 자체다 — **디스크에 적힌 판본이 막혀 있는가.**
// (앱 전체 흐름에서의 확인은 verify-recovery-cdp 의 저장 실패 주입 시나리오가 맡는다.)
{
  const trRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-blocked-'))
  // task-runtime 은 electron 의 여러 조각을 건드린다 — 파일 경로·버전만 쓰는 최소 스텁으로 충분하다.
  const prevLoad = Module._load
  Module._load = function (req, ...rest) {
    if (req === 'electron') {
      return {
        app: {
          getPath: () => trRoot, on: () => {}, isPackaged: false,
          getVersion: () => 'test', getName: () => 'ezBrowser',
          whenReady: () => Promise.resolve(), getAppPath: () => trRoot,
        },
        ipcMain: { handle: () => {}, on: () => {} },
        BrowserWindow: class {}, WebContentsView: class {}, Notification: class {},
        session: { fromPartition: () => ({}), defaultSession: {} },
        safeStorage: { isEncryptionAvailable: () => false },
        nativeTheme: { on: () => {} }, shell: {}, dialog: {},
      }
    }
    return prevLoad.call(this, req, ...rest)
  }

  let tr = null
  try {
    // ⚠ json-store 는 **모듈 로드 시점에** `require('electron')` 의 app 을 붙잡는다. P 그룹이 이미
    //   그것을 자기 임시 디렉터리로 로드해 뒀으므로, 그대로 두면 task-runtime 의 저장이 **P 그룹
    //   디렉터리**로 나간다(처음에 이 검사가 "디스크에 없다" 로 실패한 진짜 이유였다 — 제품이 아니라
    //   하네스 문제였고, 그래서 여기 적어 둔다). 캐시에서 비워 이 스텁의 디렉터리로 다시 붙게 한다.
    delete require.cache[require.resolve(JSON_STORE_JS)]
    tr = require(path.join(REPO, 'app', 'dist', 'main', 'features', 'ai', 'task-runtime.js'))
  } catch (e) {
    check('B1', '게시 작업이 태어날 때부터 막혀 있다', false, `task-runtime 로드 실패: ${e.message.slice(0, 160)}`)
  }

  if (tr) {
    const BLOCK = '저장이 확정되기 전이라 시작할 수 없습니다 — 게시 준비 중입니다.'
    const blocked = tr.createTask({ instruction: '게시 작업(시험)', tabId: '', windowId: null, blockedReason: BLOCK })
    const start1 = tr.startTask(blocked.id)
    check('B1', '태어날 때 막힌 작업은 startTask 가 거부한다(경계 우회 차단)',
      start1.ok === false && String(start1.error).includes('저장이 확정되기 전'),
      `startTask=${JSON.stringify(start1)}`)

    // 핵심: **디스크에 적힌 판본**이 막혀 있는가. 메모리만 막혀 있으면 재시작으로 우회된다.
    const flushed = tr.flushTasks()
    const diskFile = path.join(trRoot, 'ai-tasks.json')
    let onDisk = null
    try {
      onDisk = (JSON.parse(fs.readFileSync(diskFile, 'utf8')).tasks ?? []).find((t) => t.id === blocked.id)
    } catch { /* 아래에서 실패로 잡힌다 */ }
    check('B2', '디스크에 적힌 `queued` 게시 작업도 막혀 있다 — 재시작해도 시작할 수 없다',
      flushed === true && !!onDisk && onDisk.state === 'queued' && onDisk.resumeBlockedReason === BLOCK,
      `flush=${flushed} · 디스크 state=${onDisk?.state} · 디스크 차단=${JSON.stringify(onDisk?.resumeBlockedReason ?? null)}`)

    // 빗장을 푸는 것은 경계를 통과한 뒤 뿐이다 — 풀면 정상적으로 시작된다(양성 대조).
    // 이것이 없으면 B1·B2 는 "모든 작업이 다 막혀서" 통과한 것과 구분되지 않는다.
    tr.setResumeBlock(blocked.id, null)
    const start2 = tr.startTask(blocked.id)
    check('B3', '양성 대조 — 빗장을 풀면 같은 작업이 정상 시작된다(무조건 막는 것이 아니다)',
      start2.ok === true, `startTask=${JSON.stringify(start2)}`)
    tr.cancelTask(blocked.id)

    // 재시작 뒤 이어가기 경로도 같은 관문을 지나는가(startTask 만 막고 resumeTask 가 열려 있으면 무의미).
    const t2 = tr.createTask({ instruction: '게시 작업(시험2)', tabId: '', windowId: null, blockedReason: BLOCK })
    tr.setResumeBlock(t2.id, '게시 여부가 확인되지 않아 이어가기를 막았습니다 — 먼저 게시 여부를 확인하세요.')
    const st = tr.getTask(t2.id)
    st.state = 'interrupted'   // 재시작 복원 상태를 직접 만든다(앱 전체를 돌리지 않고 관문만 본다)
    const resumeBlockedRes = tr.resumeTask(t2.id)
    const startBlockedRes = tr.startTask(t2.id)
    check('B4', 'interrupted 로 복원된 막힌 작업은 resume·start 두 경로 **모두** 거부된다',
      resumeBlockedRes.ok === false && startBlockedRes.ok === false
      && String(resumeBlockedRes.error).includes('게시 여부가 확인되지 않아'),
      `resume=${JSON.stringify(resumeBlockedRes)} · start=${JSON.stringify(startBlockedRes)}`)
    tr.deleteTask(t2.id)

    // 음성 대조 — `blockedReason` 없이 만든 작업은 **디스크에서도 막혀 있지 않고 시작된다.**
    // 이것이 없으면 B1·B2 는 "원래 모든 작업이 막혀 있어서" 통과한 것과 구분되지 않는다.
    // (즉 이 검사는 빗장이 **우리가 건 것**임을 보인다 — 기본 동작이 아니다.)
    const plain = tr.createTask({ instruction: '평범한 작업(시험)', tabId: '', windowId: null })
    tr.flushTasks()
    let plainOnDisk = null
    try {
      plainOnDisk = (JSON.parse(fs.readFileSync(path.join(trRoot, 'ai-tasks.json'), 'utf8')).tasks ?? [])
        .find((t) => t.id === plain.id)
    } catch { /* 아래에서 실패로 잡힌다 */ }
    const plainStart = tr.startTask(plain.id)
    check('B-NEG', '음성 대조 — 빗장 없이 만든 작업은 디스크에서도 막혀 있지 않고 시작된다',
      !!plainOnDisk && plainOnDisk.resumeBlockedReason === undefined && plainStart.ok === true,
      `디스크 차단=${JSON.stringify(plainOnDisk?.resumeBlockedReason ?? null)} · startTask=${JSON.stringify(plainStart)}`)
    tr.cancelTask(plain.id)
  }

  Module._load = prevLoad
  fs.rmSync(trRoot, { recursive: true, force: true })
}

// ===========================================================================
fs.mkdirSync(args.out, { recursive: true })
fs.writeFileSync(path.join(args.out, 'persistence-boundary-results.json'), JSON.stringify(results, null, 2))
console.log('\n===== verify-persistence-boundary 결과 =====')
console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
console.log(`PASS=${results.length - failed} FAIL=${failed} (총 ${results.length})`)

fs.rmSync(root, { recursive: true, force: true })
process.exit(failed ? 1 : 0)

// ===========================================================================
// 음성 대조 방법 (수동 재확인용 메모)
// ===========================================================================
// P 그룹: writeSyncAt() 안의 `renameSync(tmp, file)` 를 항상 성공하는 no-op 으로 바꾸면(예:
//   `try { renameSync(tmp, file) } catch {}` 로 실패를 삼키면) P3 이 통과해 버려야 정상인데
//   `persistedSeq` 갱신 로직이 없으니 P4 가 "이미 저장된 것으로 착각"해 거짓 PASS 를 낼 것이다 —
//   이게 바로 flush() 를 void 로 되돌렸을 때 벌어지는 일이다(호출자가 실패를 볼 방법이 없어진다).
// V 그룹: 이 파일의 V-NEG 로컬 `looseJudge3Field` 가 실측 대조군이다 — 작성자·게시시각 검사를
//   지우면(옛 3필드 계약으로 되돌리면) V8(wrong-author)·V10(old-post) 이 지키려는 성질(남의 계정
//   글/오래된 글 거부)이 사라지는 것을 같은 데이터로 보여준다. uncertain 플래그(V5·V6·V7·V9)는
//   "모름" 과 "확정 거부"(V8·V10)를 구분하는 자리이므로, 두 성질을 한 조건으로 뭉개면 안 된다.
