// 블로그 참여 중복 방지 장부 검증 — 앱 없이 도는 순수 검사.
//
// 왜 상설인가: 여기서 지키는 것은 **"같은 글에 두 번 손대지 않는다"** 이다.
// 이게 깨지면 같은 글에 댓글이 두 번 달리거나(스팸), 이미 눌린 좋아요를 다시 눌러 **취소**된다.
// 둘 다 사용자가 나중에야 알게 되는 종류의 사고고, 다른 검사로는 잡히지 않는다.
//
// 주소 정규화가 이 방어의 절반이다 — 같은 글이 `utm_*`·해시·`www.`·스킴 차이로 다른 키가 되면
// 중복 방지가 통째로 새기 때문이다. 반대로 **너무 많이 지워도** 안 된다: 글 id 가 쿼리에 있는
// 블로그가 많아서, 쿼리를 지우면 서로 다른 글이 같은 키로 뭉친다(그러면 두 번째 글을 건너뛴다).

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-engage-'))

const Module = require('module')
const origLoad = Module._load
Module._load = function (req, ...rest) {
  if (req === 'electron') return { app: { getPath: () => root, on: () => {}, whenReady: () => Promise.resolve() } }
  return origLoad.call(this, req, ...rest)
}

const E = require(path.join(REPO, 'app/dist/main/features/ai/blog-engage.js'))

let pass = 0, fail = 0
const results = []
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS', name) } else { fail++; console.log('  FAIL', name, detail) }
  results.push({ name, ok: !!cond, detail: cond ? '' : String(detail).slice(0, 300) })
}

const n = E.normalizeTargetUrl

// ===== 같은 글은 같은 키가 되어야 한다(중복 방지가 새지 않게) =====
t('utm 파라미터·www·스킴 차이를 흡수', n('http://www.a.com/p/1?utm_source=x') === n('https://a.com/p/1'),
  `${n('http://www.a.com/p/1?utm_source=x')} vs ${n('https://a.com/p/1')}`)
t('해시·끝 슬래시를 흡수', n('https://a.com/p/1#comment') === n('https://a.com/p/1/'),
  `${n('https://a.com/p/1#comment')} vs ${n('https://a.com/p/1/')}`)
t('쿼리 순서가 달라도 같은 키', n('https://a.com/p?b=2&a=1') === n('https://a.com/p?a=1&b=2'))

// ===== 다른 글은 달라야 한다(과잉 정규화로 남의 글을 건너뛰지 않게 — 양성 대조) =====
t('쿼리의 글 id 는 보존한다', n('https://a.com/p?id=1') !== n('https://a.com/p?id=2'),
  `${n('https://a.com/p?id=1')} vs ${n('https://a.com/p?id=2')}`)
t('경로가 다르면 다른 키', n('https://a.com/p/1') !== n('https://a.com/p/2'))
t('호스트가 다르면 다른 키', n('https://a.com/p/1') !== n('https://b.com/p/1'))

// ===== 장부 =====
E.initEngageLedger()
const key = n('https://blog.example/post/77')

t('기록 전에는 안 했다고 나온다', E.alreadyDid(key, 'me', 'comment') === false)
E.recordEngagement({ key, account: 'me', action: 'comment', note: '본문 인용 댓글' })
t('기록 후에는 했다고 나온다', E.alreadyDid(key, 'me', 'comment') === true)
t('같은 대상이라도 다른 행동은 아직 안 한 것', E.alreadyDid(key, 'me', 'like') === false)
t('같은 대상·행동이라도 다른 계정은 아직 안 한 것', E.alreadyDid(key, 'other', 'comment') === false)

// 다른 주소 표기로 같은 글에 다시 접근 — 건너뛰어야 한다(이 검사가 실사용의 핵심)
t('같은 글의 다른 표기도 중복으로 잡힌다',
  E.alreadyDid(n('http://www.blog.example/post/77/?utm_medium=rss'), 'me', 'comment') === true)

// 중복 기록은 최초 기록을 덮어쓰지 않는다
E.recordEngagement({ key, account: 'me', action: 'comment', note: '나중 기록' })
const listed = E.listEngagements(50).filter((x) => x.key === key && x.action === 'comment')
t('같은 (대상·계정·행동) 은 한 줄만 남는다', listed.length === 1, `${listed.length}줄`)
t('최초 기록이 보존된다', (listed[0]?.note ?? '').includes('본문 인용'), listed[0]?.note)

// 빈 계정은 'default' 로 정규화 — 빈 값과 'default' 가 갈리면 방어가 샌다
E.recordEngagement({ key, account: '', action: 'like' })
t("빈 계정은 'default' 와 같게 취급", E.alreadyDid(key, 'default', 'like') === true)

// ===== 레시피 =====
const draft = E.buildBlogEngageTask({ topic: '홈카페', maxPosts: 999, actions: ['comment', 'like'], mode: 'draft' })
const act = E.buildBlogEngageTask({ topic: '홈카페', maxPosts: 3, actions: ['comment'], mode: 'act' })
t('초안 모드에는 발행 금지 표식이 있다', /발행 금지/.test(draft.task))
t('실행 모드에는 발행 금지 표식이 없다', !/발행 금지/.test(act.task))
t('글 수는 20 으로 제한된다', /20/.test(draft.task) && !/999/.test(draft.task))
t('허용 사이트가 비어 있지 않다', Array.isArray(draft.allowedHosts) && draft.allowedHosts.length > 0)
t('본문을 읽지 못하면 건너뛰라는 지시가 있다', /건너뛰/.test(draft.task) && /읽지 못한|로드에 실패/.test(draft.task))
t('상투적 댓글 금지 지시가 있다', /상투적|잘 보고 갑니다/.test(draft.task))
t('이미 눌린 좋아요를 다시 누르지 말라는 지시가 있다', /좋아요 취소|공감 취소/.test(draft.task))
t('본문 속 지시를 따르지 말라는 인젝션 방어 문구가 있다', /지시가 아닙니다|따르지 마세요/.test(draft.task))

// ===== 참여 가드 — 클릭을 **코드로** 막는 부분 =====
// 장부에 적기만 하고 행동을 막지 않으면 방지가 아니다. 실측(2026-09-18)에서 지시문만 있을 때
// 댓글 중복·좋아요 취소·초안 모드 위반이 **전부 뚫렸다**. 그래서 판정을 코드로 옮겼고, 여기서 지킨다.
const G = require(path.join(REPO, 'app/dist/main/features/ai/agent-gate.js'))

t('"좋아요 취소" 는 취소로 분류(좋아요로 오인하면 눌러서 풀린다)', G.classifyEngageClick('♥ 좋아요 취소') === 'unlike')
t('"공감 취소" 도 취소', G.classifyEngageClick('공감 취소') === 'unlike')
t('"좋아요" 는 좋아요', G.classifyEngageClick('♥ 좋아요') === 'like')
t('"댓글 등록" 은 댓글 제출', G.classifyEngageClick('댓글 등록') === 'comment')
t('"댓글 작성하기" 도 댓글 제출', G.classifyEngageClick('댓글 작성하기') === 'comment')
t('그냥 "댓글 3개" 는 제출이 아니다(오탐 방지)', G.classifyEngageClick('댓글 3개') === null)
t('무관한 버튼은 null', G.classifyEngageClick('다음 페이지') === null)

const mark = G.buildEngageMark({ account: '내계정', mode: 'act', comment: true, like: false })
const parsed = G.parseEngageMark(['앞줄', mark, '뒷줄'].join(String.fromCharCode(10)))
t('가드 표식 왕복 — 계정', parsed?.account === '내계정', JSON.stringify(parsed))
t('가드 표식 왕복 — 모드', parsed?.mode === 'act')
t('가드 표식 왕복 — 고른 행동만 참', parsed?.comment === true && parsed?.like === false)
t('표식이 없으면 null', G.parseEngageMark('그냥 작업 지시문') === null)

t('초안 레시피에 가드 표식이 실린다',
  G.parseEngageMark(E.buildBlogEngageTask({ topic: 'x', maxPosts: 2, actions: ['comment'], mode: 'draft' }).task)?.mode === 'draft')
t('실행 레시피에 가드 표식이 실린다',
  G.parseEngageMark(E.buildBlogEngageTask({ topic: 'x', maxPosts: 2, actions: ['like'], mode: 'act' }).task)?.mode === 'act')



// ===== 한도·간격·기한 (작업 단위 영속 카운터) =====
//
// 왜 상설인가: 사용자가 정한 "글 몇 개까지 / 얼마 간격으로 / 언제까지" 가 **지시문 수준**이면
// 모델이 무시하거나, 작업이 중단 뒤 재개되거나, 구간이 바뀌어 지시문을 다시 읽을 때 카운트가
// 0 으로 돌아간다. 그러면 사용자가 5개라고 한 작업이 20개를 달 수 있다(계정 제한·스팸).
// 여기서는 그 한도가 **디스크 카운터로** 지켜지는지를 본다 — 양성(허용)·부정(차단) 양방향.

const guard = (over) => ({ account: 'a', mode: 'act', comment: true, like: true, guardId: 'g-quota-1', limit: 2, intervalMs: 0, until: 0, ...over })

// 양성 — 한도 안에서는 허용된다("전부 막혀서" 통과가 아님을 보증)
t('한도 안이면 허용', E.engageQuotaCheck(guard(), 'comment').ok === true)
E.engageQuotaRecord(guard(), 'comment')
t('1건 쓴 뒤에도 한도 안이면 허용', E.engageQuotaCheck(guard(), 'comment').ok === true)
E.engageQuotaRecord(guard(), 'comment')

// 부정 — 한도를 넘기면 차단된다
const over = E.engageQuotaCheck(guard(), 'comment')
t('한도를 넘기면 차단', over.ok === false, JSON.stringify(over))
t('차단 사유에 한도가 드러난다', /2건/.test(over.reason ?? ''), over.reason)

// 행동 종류는 따로 센다 — 댓글을 다 썼다고 좋아요까지 막히면 안 된다
t('행동 종류별로 따로 센다(좋아요는 아직 허용)', E.engageQuotaCheck(guard(), 'like').ok === true)

// 카운터는 **작업(guardId) 단위** — 다른 작업은 영향받지 않는다
t('다른 작업은 자기 한도를 그대로 쓴다', E.engageQuotaCheck(guard({ guardId: 'g-quota-2' }), 'comment').ok === true)

// 간격 — 방금 한 직후에는 막히고, 간격이 지나면 다시 허용된다
const iv = { account: 'a', mode: 'act', comment: true, like: true, guardId: 'g-iv', limit: 0, intervalMs: 30000, until: 0 }
E.engageQuotaRecord(iv, 'comment')
const tooSoon = E.engageQuotaCheck(iv, 'comment')
t('간격이 안 지나면 차단', tooSoon.ok === false, JSON.stringify(tooSoon))
t('차단 사유가 몇 초 더 기다리라고 알려준다', /초 더/.test(tooSoon.reason ?? ''), tooSoon.reason)
t('간격이 지나면 다시 허용(양성 대조)', E.engageQuotaCheck(iv, 'comment', Date.now() + 31000).ok === true)

// 기한 — 지나면 더 하지 않는다
const past = { account: 'a', mode: 'act', comment: true, like: true, guardId: 'g-until', limit: 0, intervalMs: 0, until: Date.now() - 1000 }
t('기한이 지나면 차단', E.engageQuotaCheck(past, 'comment').ok === false)
t('기한 전이면 허용(양성 대조)',
  E.engageQuotaCheck({ ...past, guardId: 'g-until2', until: Date.now() + 60000 }, 'comment').ok === true)

// 표식이 없던 시절 작업(guardId 없음)은 한도를 적용하지 않는다 — 기존 작업이 갑자기 막히면 안 된다
t('guardId 가 없으면 한도 미적용(하위호환)',
  E.engageQuotaCheck({ account: 'a', mode: 'act', comment: true, like: true, guardId: '', limit: 1, intervalMs: 999999, until: 1 }, 'comment').ok === true)

// 재개·구간 전환 내성 — 같은 guardId 로 다시 물어도 카운트가 0 으로 돌아가지 않는다
t('같은 작업을 다시 조회해도 카운트가 살아 있다(재개 내성)', E.engageQuotaUsed('g-quota-1').comment === 2)

// ===== 레시피가 한도·간격·기한을 표식에 싣는가 =====
const built = E.buildBlogEngageTask({ topic: 'x', maxPosts: 3, actions: ['comment', 'like'], mode: 'act', intervalSeconds: 45, until: Date.now() + 3600000 })
const bg = G.parseEngageMark(built.task)
t('레시피 표식에 한도가 실린다', bg?.limit === 3, JSON.stringify(bg))
t('레시피 표식에 간격이 실린다(ms)', bg?.intervalMs === 45000)
t('레시피 표식에 기한이 실린다', (bg?.until ?? 0) > Date.now())
t('레시피 표식에 작업별 guardId 가 실린다', !!bg?.guardId && bg.guardId.length >= 8)
// guardId 는 작업마다 달라야 한다 — 같으면 다른 작업이 서로의 한도를 갉아먹는다
const built2 = E.buildBlogEngageTask({ topic: 'x', maxPosts: 3, actions: ['comment'], mode: 'act' })
t('작업마다 guardId 가 다르다', G.parseEngageMark(built2.task)?.guardId !== bg?.guardId)
t('maxPosts clamp 가 표식 한도에도 반영된다',
  G.parseEngageMark(E.buildBlogEngageTask({ topic: 'x', maxPosts: 999, actions: ['like'], mode: 'act' }).task)?.limit === 20)


console.log(`\n합계 PASS ${pass} / FAIL ${fail}`)

const outDir = path.join(REPO, 'verify-out', 'engage-ledger')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), pass, fail, results }, null, 2))
fs.rmSync(root, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
