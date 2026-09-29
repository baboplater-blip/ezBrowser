#!/usr/bin/env node
// verify-general-engage.mjs — 일반 영속 작업의 댓글·좋아요 중복 방지 판정 회귀 검사 (순수 함수)
//
// 왜: 참여 워크플로 표식(blog-engage)이 없는 "일반 작업" 에서도 재시도·재시작이 같은 댓글을 두 번
// 달거나, 이미 눌린 좋아요를 다시 눌러 취소시킬 수 있었다. 그 구멍을 막는 판정이
// `classifyEngageAction`(+ `hasDraftTextIn`/`wantsUnlike`) 이다. 이 판정은 **어휘만으로는 반드시
// 두 방향으로 틀린다** — ① 댓글 작성창을 여는 링크를 "제출했다"로 오인(과차단: 진짜 등록이 막힘)
// ② 이미 켜진 좋아요 토글을 못 알아보고 "좋아요"로만 읽어 취소를 못 막음(미차단: 더 나쁘다).
// 그래서 어휘는 후보를 고르는 씨앗으로만 쓰고, 관찰이 가진 구조(요소 tag·type·state, 입력된 초안
// 유무)로 판정을 좁힌다. 이 검사는 그 구조 우선 판정이 실제로 두 방향 모두를 지키는지 본다.
//
// 사용: node build/verify-general-engage.mjs [--out <dir>]

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)

const args = { out: path.join(REPO, 'verify-out', 'general-engage') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const GATE_JS = path.join(REPO, 'app', 'dist', 'main', 'features', 'ai', 'agent-gate.js')
if (!fs.existsSync(GATE_JS)) {
  console.error(`빌드 산출물 없음: ${GATE_JS} — 먼저 npm run build`)
  process.exit(2)
}
const gate = require(GATE_JS)

const results = []
let failed = 0
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}

// 관찰 요소를 간단히 만드는 헬퍼. el 을 안 주면 undefined(click_at 처럼 요소를 모르는 경우와 구분).
function verdict({ label, el, probeTag, hasDraftText, actionKind, pressed }) {
  // actionKind 를 안 주면 제품은 라벨 모양(`클릭 …`)으로 판단한다 — 아래 대부분의 검사가 그 경로다.
  return gate.classifyEngageAction({
    label,
    el: el ?? null,
    probeTag: probeTag ?? '',
    hasDraftText,
    ...(actionKind ? { actionKind } : {}),
    ...(pressed !== undefined ? { pressed } : {}),
  })
}

// ===========================================================================
// G1 — 댓글 제출 인식: 제출 가능한 컨트롤(button / input[submit] / role=button) + 입력된 초안
//      → 'comment' 로 정확히 잡는다.
// ===========================================================================
{
  const label = '클릭 "댓글 등록"'
  const cases = [
    ['button', { label, el: { tag: 'button', type: 'submit', name: '댓글 등록' }, hasDraftText: true }],
    ['input[type=submit]', { label, el: { tag: 'input', type: 'submit', name: '댓글 등록' }, hasDraftText: true }],
    ['role=button(div)', { label, el: { tag: 'div', type: 'button', name: '댓글 등록' }, hasDraftText: true }],
  ]
  const bad = cases.filter(([, input]) => verdict(input).kind !== 'comment')
  check('G1', '제출 가능한 컨트롤 + 입력된 초안 → 댓글 등록으로 인식', bad.length === 0,
    bad.length ? `놓친 것: ${bad.map(([n, input]) => `${n}→${verdict(input).kind}`).join(', ')}` : `${cases.length}종 전부 comment`)
}

// ===========================================================================
// G2 — 작성창 열기를 제출로 오인하지 않는다 (중요 — 과차단 방지)
// ===========================================================================
{
  const label = '클릭 "댓글 작성"' // 어휘 씨앗으로는 'comment' 를 seed 한다(구조가 이를 좁혀야 한다)
  const seedIsComment = gate.classifyEngageClick(label) === 'comment'

  // (a) <a> 링크는 보통 이동·작성창 열기다 — hasDraftText 값에 관계없이 null 이어야 한다.
  const linkEl = { tag: 'a', type: '', name: '댓글 쓰기' }
  const aCases = [true, false, undefined].map((hasDraftText) => {
    const v = verdict({ label, el: linkEl, hasDraftText })
    return { hasDraftText, v }
  })
  const aBad = aCases.filter(({ v }) => v.kind !== null || !v.reason)
  check('G2a', '<a> 링크는 hasDraftText 무엇이든 제출로 보지 않는다(작성창 열기)',
    seedIsComment && aBad.length === 0,
    !seedIsComment
      ? `씨앗 전제 붕괴: classifyEngageClick('${label}')='${gate.classifyEngageClick(label)}' (comment 가 아님 — 이 검사 자체가 무의미)`
      : (aBad.length
          ? `어긋남: ${aBad.map(({ hasDraftText, v }) => `hasDraftText=${hasDraftText}→kind=${v.kind},reason='${v.reason}'`).join(' / ')}`
          : `3종(hasDraftText=true/false/undefined) 전부 kind=null · reason 있음`))

  // (b) 버튼이지만 입력된 초안이 없다(hasDraftText:false) → null (작성창 열기로 강등)
  const btnEl = { tag: 'button', type: '', name: '댓글 등록' }
  const bV = verdict({ label, el: btnEl, hasDraftText: false })
  check('G2b', '버튼이라도 초안이 비어 있으면(hasDraftText:false) 제출로 보지 않는다',
    bV.kind === null && !!bV.reason,
    `kind=${bV.kind} reason='${bV.reason}'`)

  // (c) 버튼 + hasDraftText:undefined(판별 불가) → 강등하지 않는다 → 'comment' 로 남는다
  const cV = verdict({ label, el: btnEl, hasDraftText: undefined })
  check('G2c', '판별 불가(hasDraftText:undefined)는 강등하지 않는다',
    cV.kind === 'comment' && !!cV.reason,
    `kind=${cV.kind} reason='${cV.reason}'`)
}

// ===========================================================================
// G3 — 구조가 어휘를 이긴다: 이미 켜진 토글(state:'checked')을 누르면 '좋아요' 라벨이라도 취소다.
// ===========================================================================
{
  const label = '클릭 "좋아요"'
  const checkedV = verdict({ label, el: { tag: 'button', type: '', name: '좋아요', state: 'checked' } })
  const uncheckedV = verdict({ label, el: { tag: 'button', type: '', name: '좋아요', state: 'unchecked' } })
  check('G3', '체크 상태가 라벨보다 우선한다(checked→unlike, unchecked→like)',
    checkedV.kind === 'unlike' && checkedV.toggleOff === true
    && uncheckedV.kind === 'like' && uncheckedV.toggleOff === false,
    `checked→kind=${checkedV.kind},toggleOff=${checkedV.toggleOff} · unchecked→kind=${uncheckedV.kind},toggleOff=${uncheckedV.toggleOff}`)
}

// ===========================================================================
// G4 — 어휘로 명시된 취소: el 도 state 도 없어도 라벨 자체가 취소면 unlike 다.
// ===========================================================================
{
  const label = '클릭 "♥ 좋아요 취소"'
  const v = verdict({ label })
  check('G4', '어휘 취소(el/state 없이도) → unlike', v.kind === 'unlike' && v.toggleOff === true,
    `kind=${v.kind} toggleOff=${v.toggleOff}`)
}

// ===========================================================================
// G5 — 무관한 클릭은 건드리지 않는다(오탐 0)
// ⚠ '클릭 "댓글 12"' 는 COMMENT_SUBMIT_RE 가 동사를 요구하므로 null 이 맞다. null 이 아니면 제품 결함.
// ===========================================================================
{
  const labels = [
    '클릭 "로그인"', '클릭 "다음"', '클릭 "저장"', '클릭 "검색"', '클릭 "댓글 12"',
    '클릭 "공유하기"', '이동 https://example.com', '스크롤 아래',
    '입력 "좋아요 최고" → 포커스한 칸', '',
  ]
  const rows = labels.map((label) => ({ label, kind: verdict({ label }).kind }))
  const bad = rows.filter((r) => r.kind !== null)
  check('G5', '무관한 클릭·이동·스크롤·입력 라벨은 전부 kind=null(오탐 0)', bad.length === 0,
    bad.length
      ? `오탐 ${bad.length}건: ${bad.map((r) => `'${r.label}'→${r.kind}`).join(', ')}`
      : `${labels.length}종 전부 null`)
}

// ===========================================================================
// G6 — click_at(요소를 모른다): probeTag 로만 판단.
// ===========================================================================
{
  const label = '클릭 "댓글 작성"' // seed='comment'
  const linkCase = verdict({ label, el: null, probeTag: 'A' })
  const btnCase = verdict({ label, el: null, probeTag: 'BUTTON', hasDraftText: true })
  const unknownCase = verdict({ label, el: null, probeTag: '', hasDraftText: true })
  check('G6', 'click_at: probeTag=A→null(링크) · BUTTON+초안있음→comment · 모름+초안있음→comment(보수적 통과)',
    linkCase.kind === null && btnCase.kind === 'comment' && unknownCase.kind === 'comment',
    `A→${linkCase.kind} · BUTTON→${btnCase.kind} · unknown→${unknownCase.kind}`)
}

// ===========================================================================
// G7 — hasDraftTextIn: 화면에 입력된 초안이 있는가(관찰 요소 배열만으로 판단)
// ===========================================================================
{
  const cases = [
    ['textarea 값 있음', [{ tag: 'textarea', type: '', value: '안녕하세요 잘 읽었습니다' }], true],
    ['textarea 값 빈 문자열', [{ tag: 'textarea', type: '', value: '' }], false],
    ['textarea 값 키 없음', [{ tag: 'textarea', type: '' }], false],
    ['입력칸 없음(제출버튼뿐)', [{ tag: 'button', type: 'submit' }], undefined],
    ['빈 배열', [], undefined],
    ['undefined', undefined, undefined],
    ['공백만 입력', [{ tag: 'input', type: 'text', value: '  ' }], false],
    ['contenteditable(textbox)', [{ tag: 'div', type: 'textbox', value: '초안' }], true],
    // ⚠ 관찰(page-actions)은 contenteditable 의 값을 **채우지 않는다** — 값이 없다고 "빈 칸" 으로
    //    세면 div 편집기에서 댓글 보호가 조용히 꺼진다(2026-09-20 리뷰 M2). 모르면 모른다고 답해야 한다.
    ['contenteditable 값 미관찰', [{ tag: 'div', type: 'textbox' }], undefined],
    ['contenteditable + 빈 input', [{ tag: 'div', type: 'textbox' }, { tag: 'input', type: 'text', value: '' }], false],
  ]
  const bad = cases.filter(([, els, want]) => gate.hasDraftTextIn(els) !== want)
  check('G7', 'hasDraftTextIn 이 관찰 요소만으로 초안 유무를 정확히 판별', bad.length === 0,
    bad.length
      ? `어긋남: ${bad.map(([n, els, want]) => `${n}→${gate.hasDraftTextIn(els)}(기대 ${want})`).join(', ')}`
      : `${cases.length}종 전부 일치`)
}

// ===========================================================================
// G8 — wantsUnlike: 작업 지시(신뢰 경로)가 명시적으로 좋아요 취소를 요청했는가.
// ===========================================================================
{
  const trueCases = ['이 글 좋아요 취소해줘', '좋아요를 해제해 주세요', '공감 취소', 'unlike this post']
  const falseCases = ['이 글에 좋아요 눌러줘', '댓글 달아줘', '구독 취소해줘', '']
  const missed = trueCases.filter((t) => !gate.wantsUnlike(t))
  const wrong = falseCases.filter((t) => gate.wantsUnlike(t))
  check('G8', '명시적 좋아요 취소 의도만 true 로 잡는다(구독 취소 등은 아니다)',
    missed.length === 0 && wrong.length === 0,
    `미탐 ${missed.length}건${missed.length ? `(${missed[0]})` : ''} · 오탐 ${wrong.length}건${wrong.length ? `(${wrong[0]})` : ''}`)
}

// ===========================================================================
// G9 — 제출 경로(입력칸 Enter·폼 제출). 댓글은 버튼 클릭만으로 나가지 않는다.
//      이때 `el` 은 **타이핑한 입력칸**이지 제출 버튼이 아니므로, "이 요소가 버튼처럼 생겼는가" 를
//      물으면 무조건 거부된다(2026-09-20 e2e 가 실제 중복 댓글로 잡아낸 결함). 무슨 제출인지는
//      호출자가 찾아온 **폼의 제출 버튼 이름**(label)으로 가른다.
// ===========================================================================
{
  const box = { tag: 'input', type: 'text', name: '댓글을 입력하세요' }
  const cases = [
    ['댓글 등록 폼 제출', { actionKind: 'submit', label: '클릭 "댓글 등록"', el: box, hasDraftText: true }, 'comment'],
    ['검색 폼 제출(무관)', { actionKind: 'submit', label: '클릭 "검색"', el: box, hasDraftText: true }, null],
    ['로그인 폼 제출(무관)', { actionKind: 'submit', label: '클릭 "로그인"', el: box, hasDraftText: true }, null],
    ['제출 버튼 이름을 못 찾음', { actionKind: 'submit', label: '', el: box, hasDraftText: true }, null],
    ['초안이 비었으면 제출로 보지 않음', { actionKind: 'submit', label: '클릭 "댓글 등록"', el: box, hasDraftText: false }, null],
  ]
  const bad = []
  for (const [name, input, want] of cases) {
    const got = verdict(input).kind
    if (got !== want) bad.push(`${name}: 기대 ${want} · 실제 ${got}`)
  }
  check('G9', '제출 경로도 같은 가드를 타되 무관한 폼은 건드리지 않는다',
    bad.length === 0, bad.length ? bad.join(' / ') : `${cases.length}종 전부 일치`)
}

// ===========================================================================
// GNEG — 음성 대조: 구조 조건 없이 어휘(classifyEngageClick)만으로 판단하던 "옛 동작" 을
// 이 하네스 안에서 흉내 내, G2(a)·G2(b)·G3 의 입력을 먹였을 때 실제로 틀린 답을 내는지 확인한다.
// (제품 코드는 건드리지 않는다 — classifyEngageClick 은 이미 존재하는 export 를 그대로 쓴다.)
// 이 검사가 실패(=옛 동작도 정답을 맞힘)하면, G1~G8 이 애초에 아무것도 지키지 못하는 것이다.
// ===========================================================================
{
  const notes = []
  let detected = 0
  let total = 0

  // G2(a): <a> 링크(작성창 열기) — 옛 동작은 어휘만 보고 'comment' 로 오판(과차단 유발)
  {
    total++
    const label = '클릭 "댓글 작성"'
    const oldKind = gate.classifyEngageClick(label) // 구조 무시
    const newKind = verdict({ label, el: { tag: 'a', type: '', name: '댓글 쓰기' } }).kind
    const oldWrong = oldKind !== null // 정답은 null(작성창 열기)
    if (oldWrong && newKind === null) detected++
    notes.push(`G2a: 옛동작(어휘만)='${oldKind}'(오판) vs 새판정='${newKind}'(정답)`)
  }

  // G2(b): 버튼이지만 초안 없음 — 옛 동작은 초안 유무를 안 보므로 'comment' 로 오판
  {
    total++
    const label = '클릭 "댓글 등록"'
    const oldKind = gate.classifyEngageClick(label)
    const newKind = verdict({ label, el: { tag: 'button', type: '', name: '댓글 등록' }, hasDraftText: false }).kind
    const oldWrong = oldKind !== null
    if (oldWrong && newKind === null) detected++
    notes.push(`G2b: 옛동작(어휘만)='${oldKind}'(오판) vs 새판정='${newKind}'(정답)`)
  }

  // G3: 이미 켜진 좋아요 — 옛 동작은 state 를 안 보므로 'like' 로 오판(실제로는 누르면 취소된다 — 미차단)
  {
    total++
    const label = '클릭 "좋아요"'
    const oldKind = gate.classifyEngageClick(label)
    const newV = verdict({ label, el: { tag: 'button', type: '', name: '좋아요', state: 'checked' } })
    const oldWrong = oldKind !== 'unlike' // 정답은 unlike(이미 켜져 있어 누르면 꺼진다)
    if (oldWrong && newV.kind === 'unlike' && newV.toggleOff === true) detected++
    notes.push(`G3: 옛동작(어휘만)='${oldKind}'(오판) vs 새판정='${newV.kind}',toggleOff=${newV.toggleOff}(정답)`)
  }

  check('GNEG', `음성 대조 — 옛(어휘뿐) 판정을 되살리면 ${total}건 모두 틀리고, 새 판정은 전부 맞아야 한다`,
    detected === total, notes.join(' / '))
}

fs.mkdirSync(args.out, { recursive: true })
fs.writeFileSync(path.join(args.out, 'general-engage-results.json'), JSON.stringify(results, null, 2))
console.log('\n===== verify-general-engage 결과 =====')
console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
console.log(`PASS=${results.length - failed} FAIL=${failed} (총 ${results.length})`)
process.exit(failed ? 1 : 0)
