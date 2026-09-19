// 초안 승격(draft promotion) **게이트 판정** 검증 — 앱 없이 도는 순수 검사.
//
// 무엇을 지키는가: "만들어 둔 초안을 다시 만들지 않고 게시로 올린다" 는 편의 기능이지만, 그 끝에
// 있는 것은 **되돌릴 수 없는 외부 게시**다. 그래서 이 판정이 지켜야 하는 것은 둘이다.
//
//   ① 올려도 되는 것만 올린다 — 이미 게시된 것·게시 중인 것·나갔는지 모르는 것·계정이 없는 것·
//      이미지가 사라진 것은 거부한다. 그리고 **거부해도 초안을 잃지 않는다**.
//   ② 사용자가 **확인한 그것**만 올린다 — 확인 뒤에 캡션·계정·이미지가 바뀌었으면 그 확인은 무효다.
//      확인은 1회용이라 연타·재전송으로 두 번 나가지 않는다.
//
// 이 파일이 보증하는 것: 위 판정 규칙(거부 경로 전부 + 확인의 바인딩·1회용·디스크 미기록).
// 이 파일이 보증하지 **않는** 것: 실제 게시 흐름(작업 생성·산출물 복사·업로드·영수증). 그것은
//   build/verify-draft-promotion-cdp.mjs 가 실제 앱 + 실제 UI 클릭 + 로컬 픽스처로 검증한다.
//   여기서는 **성공 경로의 confirm 을 일부러 부르지 않는다** — 부르면 실제 게시 단계가 시작된다.
//
// ⚠ 하네스 구조상의 제약 (2026-09-19 에 한 번 틀렸던 부분): `initSocialWorkflows()` 는 **프로세스당
//   한 번만** 저장 파일을 읽는다(`if (cache !== null) return`). 그래서 시나리오마다 파일을 다시 써서
//   "다시 읽히는" 방식은 통하지 않는다 — 두 번째부터는 첫 번째 상태를 계속 보게 되고, 그러면 거부돼야
//   할 것이 통과한 것처럼 보인다(실제로 그렇게 47개가 거짓 FAIL 로 나왔다). 그래서 **모든 시나리오를
//   서로 다른 id 로 한 번에 심고 한 번만 init** 한다. 실제 사용자의 목록도 그런 모양이다.
//
// 선례: build/verify-auto-publish.mjs (같은 electron 스텁 방식 · 같은 양방향 판정 원칙).

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-promote-'))

// social-workflow 는 electron(app) 과 설정을 끌어온다 — 파일 경로만 임시 디렉터리로 돌려주면 충분하다.
const Module = require('module')
const origLoad = Module._load
Module._load = function (req, ...rest) {
  if (req === 'electron') {
    return {
      app: {
        getPath: () => root,
        getVersion: () => '0.0.0-test',
        getName: () => 'ezbrowser-test',
        on: () => {}, whenReady: () => Promise.resolve(), isPackaged: false,
      },
      ipcMain: { handle: () => {}, on: () => {} },
      safeStorage: { isEncryptionAvailable: () => false },
    }
  }
  return origLoad.call(this, req, ...rest)
}

const W = require(path.join(REPO, 'app/dist/main/features/ai/social-workflow.js'))
const A = require(path.join(REPO, 'app/dist/main/features/ai/artifacts.js'))

let pass = 0, fail = 0
const results = []
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS', name) } else { fail++; console.log('  FAIL', name, detail) }
  results.push({ name, ok: !!cond, detail: cond ? '' : String(detail).slice(0, 400) })
}

/** 거부는 **한국어와 영어를 함께** 줘야 한다(화면이 둘 다 보인다). 통과 여부와 같이 본다. */
function isRejection(r, pairs) {
  if (!r || r.ok !== false) return false
  if (typeof r.error !== 'string' || typeof r.errorEn !== 'string') return false
  return pairs.some(([ko, en]) => r.error.includes(ko) && r.errorEn.toLowerCase().includes(en.toLowerCase()))
}

// ───────────────────────── 진짜 산출물 만들기 ─────────────────────────
// 1×1 PNG — importDownloadedFile 이 이미지인지 확인하므로 진짜 PNG 여야 한다.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64')

const GEN_TASK = 'task_gen_promotion'
const tmpPng = path.join(root, 'seed.png')
fs.writeFileSync(tmpPng, PNG_1X1)
const imported = A.importDownloadedFile({
  taskId: GEN_TASK, filePath: tmpPng,
  sourceUrl: 'http://127.0.0.1/gen.png', sourcePageUrl: 'http://127.0.0.1/gen', sourceTabId: 'tab1',
  expect: 'image', label: '테스트 산출물',
})
if (!imported.ok || !imported.meta) {
  console.error('FATAL: 테스트 산출물을 만들지 못했습니다 —', imported.error ?? imported.code)
  process.exit(2)
}
const ART = imported.meta

// ───────────────────────── 워크플로 시드 ─────────────────────────
const WF_FILE = path.join(root, 'ai-social-workflows.json')
const BASE_CAPTION = '오늘의 사진입니다'

function wf(id, over = {}) {
  const now = Date.now()
  const { params: paramsOver, ...rest } = over
  const rec = {
    id,
    params: {
      service: 'genspark', platform: 'instagram', prompt: '테스트 프롬프트',
      mode: 'draft', tabId: 'tab1', windowId: 'win1', account: 'me',
      ...(paramsOver ?? {}),
    },
    stage: 'review',
    taskIds: { generate: GEN_TASK },
    artifactId: ART.id,
    artifactPreview: { bytes: ART.bytes, format: ART.format, sha256: ART.sha256 },
    caption: BASE_CAPTION,
    createdAt: now - 1000, updatedAt: now - 1000,
  }
  return { ...rec, ...rest }
}

// ── 거부돼야 하는 것들. [id, 설명, 레코드, 허용되는 거부 사유(ko,en) 목록]
const DENY = [
  ['d-noacct', '계정이 없으면 거부한다', wf('d-noacct', { params: { account: undefined } }), [['계정이 비어 있습니다', 'No account']]],
  ['d-nocap', '캡션이 비어 있으면 거부한다', wf('d-nocap', { caption: '   ' }), [['캡션이 비어 있습니다', 'caption is empty']]],
  ['d-cappend', '캡션을 쓰는 중이면 거부한다', wf('d-cappend', { captionPending: true }), [['캡션을 쓰는 중', 'still being drafted']]],
  ['d-caperr', '캡션 생성이 실패한 상태면 거부한다', wf('d-caperr', { captionError: '실패' }), [['캡션을 만들지 못한', 'failed to generate']]],
  ['d-pubmode', '처음부터 게시 모드였던 작업은 이 경로로 올리지 않는다', wf('d-pubmode', { params: { mode: 'publish' } }), [['초안이 아니라', 'publish mode']]],
  ['d-already', '이미 승격한 초안은 다시 올리지 않는다', wf('d-already', { promotedAt: Date.now() - 1 }), [['이미 게시로 올린 초안', 'already been promoted']]],
  ['d-uncertain', '게시 여부가 불확실하면 거부한다',
    wf('d-uncertain', { stage: 'done', receipt: { status: 'draft', at: 1 }, publishUncertain: true, taskIds: { generate: GEN_TASK, publish: 'task_pub_a' } }),
    [['게시 여부가 확인되지 않아', 'unresolved']]],
  ['d-verifying', '게시 여부 확인 작업이 도는 중이면 거부한다',
    wf('d-verifying', { stage: 'done', receipt: { status: 'draft', at: 1 }, verifyTaskId: 'task_verify', taskIds: { generate: GEN_TASK, publish: 'task_pub_b' } }),
    [['게시 여부가 확인되지 않아', 'unresolved']]],
  ['d-generating', '생성 중인 작업은 거부한다', wf('d-generating', { stage: 'generate' }), [['올릴 수 있는 단계가 아닙니다', 'Not in a promotable state']]],
  // stage:'publish' 는 부팅 재조정(reconcile)이 "작업 기록이 없다" 를 보고 불확실로 바꾼다 —
  // 둘 중 어느 사유로 거부되든 목적은 같다(게시 중인 것에 손대지 않는다).
  ['d-publishing', '게시 중인 작업은 거부한다',
    wf('d-publishing', { stage: 'publish', taskIds: { generate: GEN_TASK, publish: 'task_pub_c' } }),
    [['올릴 수 있는 단계가 아닙니다', 'Not in a promotable state'], ['게시 여부가 확인되지 않아', 'unresolved']]],
  ['d-failed', '실패한 작업은 거부한다', wf('d-failed', { stage: 'failed' }), [['올릴 수 있는 단계가 아닙니다', 'Not in a promotable state']]],
  ['d-cancelled', '취소된 작업은 거부한다', wf('d-cancelled', { stage: 'cancelled' }), [['올릴 수 있는 단계가 아닙니다', 'Not in a promotable state']]],
  ['d-verified', '이미 실제로 게시된 작업은 거부한다', wf('d-verified', { stage: 'done', receipt: { status: 'verified', at: 1 } }), [['이미 게시까지 끝났습니다', 'already completed a real publication']]],
  ['d-userconf', '사용자가 "이미 게시됨" 으로 결론 낸 작업도 거부한다', wf('d-userconf', { stage: 'done', receipt: { status: 'user-confirmed', at: 1 } }), [['이미 게시까지 끝났습니다', 'already completed']]],
  ['d-unverified', '게시 여부 미확인으로 끝난 작업도 거부한다', wf('d-unverified', { stage: 'done', receipt: { status: 'unverified', at: 1 } }), [['이미 게시까지 끝났습니다', 'already completed']]],
  ['d-legacy', 'status 가 없는 예전 영수증은 초안으로 치지 않는다(fail-closed)', wf('d-legacy', { stage: 'done', receipt: { evidence: '초안까지 준비(게시 안 함)', at: 1 } }), [['예전 판본이라', 'predates']]],
  ['d-prior', '지난 기록에 실제 게시가 있으면 거부한다', wf('d-prior', { stage: 'done', receipt: { status: 'draft', at: 2 }, priorReceipts: [{ status: 'verified', at: 1 }] }), [['이미 실제 게시 기록', 'already has a real publication']]],
  ['d-noart', '보관 이미지가 없으면 거부한다', wf('d-noart', { artifactId: 'art_doesnotexist' }), [['보관된 이미지 파일을 찾을 수 없습니다', 'stored image file is gone']]],
  ['d-nogen', '생성 작업 기록이 없으면 거부한다', wf('d-nogen', { taskIds: {} }), [['올릴 이미지 기록이 없습니다', 'No stored image']]],
  ['d-shadrift', '보관 이미지가 처음 확인한 것과 다르면 거부한다', wf('d-shadrift', { artifactPreview: { bytes: 1, format: 'png', sha256: 'deadbeef' } }), [['처음 확인한 것과 달라졌습니다', 'no longer matches']]],
]

const SEED = [
  wf('ok-review'),                       // ① 정상 초안(확정 화면·취소)
  wf('t-single'),                        // ② 1회용 토큰
  wf('t-expire'),                        // ② 만료
  wf('b-caption'),                       // ③ 확인 뒤 캡션 변경
  wf('b-account'),                       // ③ 확인 뒤 계정 변경
  wf('rev-a'), wf('rev-a2'),             // ③ 바인딩 지문 — 같은 내용
  wf('rev-cap', { caption: `${BASE_CAPTION}!` }),
  wf('rev-acct', { params: { account: 'other' } }),
  wf('ok-done', {                        // ⑤ 완료된 초안
    stage: 'done',
    taskIds: { generate: GEN_TASK, publish: 'task_pub_draft' },
    receipt: { status: 'draft', evidence: '초안까지 준비(게시 안 함)', at: 1234 },
  }),
  // ⑦ 재시작을 넘겨 기억하는가 — 저장 파일에서 복원되는 값 자체를 본다.
  wf('r-keep', {
    stage: 'done', promotedAt: 4242,
    receipt: { status: 'verified', at: 999 },
    priorReceipts: [{ status: 'draft', evidence: '초안까지 준비(게시 안 함)', at: 111, taskId: 'task_pub_draft', note: '초안 준비 기록' }],
  }),
  wf('r-corrupt', { stage: 'done', promotedAt: 'garbage', receipt: { status: 'verified', at: 1 } }),
  wf('r-badprior', { stage: 'done', priorReceipts: 'not-an-array', receipt: { status: 'draft', at: 1 } }),
  wf('tagged', { params: { tags: ['aa', 'bb'] } }),        // ⑨ 태그 바인딩
  wf('tagged-other', { params: { tags: ['aa', 'cc'] } }),
  wf('swap'),                                              // ⑩ 파일 제자리 교체 탐지
  ...DENY.map(([, , rec]) => rec),
]

fs.writeFileSync(WF_FILE, JSON.stringify({ version: 1, workflows: SEED, grant: null }), 'utf8')
W.initSocialWorkflows()

// ===================== ① 정상 초안은 확인 화면이 열린다 =====================

const p1 = W.preparePromotion('ok-review')
t('확인 단계 초안이면 확정 화면이 열린다', p1.ok === true, JSON.stringify(p1).slice(0, 300))
t('확정 화면이 보여 주는 이미지 지문이 **실제 보관 파일의 sha256** 과 같다',
  p1.ok && p1.plan.artifactSha256 === ART.sha256, `plan=${p1.ok ? p1.plan.artifactSha256 : 'n/a'} art=${ART.sha256}`)
t('확정 화면이 목적지·계정·캡션을 그대로 보여 준다',
  p1.ok && p1.plan.platform === 'instagram' && p1.plan.account === 'me' && p1.plan.caption === BASE_CAPTION,
  JSON.stringify(p1.ok ? p1.plan : {}).slice(0, 300))
t('확정 화면에 한국어·영어 플랫폼 이름이 함께 있다',
  p1.ok && !!p1.plan.platformLabel && !!p1.plan.platformLabelEn && p1.plan.platformLabel !== p1.plan.platformLabelEn,
  JSON.stringify(p1.ok ? [p1.plan.platformLabel, p1.plan.platformLabelEn] : []))
t('확인 단계 초안임을 표시한다', p1.ok && p1.plan.source === 'review', p1.ok ? p1.plan.source : 'n/a')

// **확인은 디스크로 나가지 않는다** — 저장소를 강제로 확정시킨 뒤 파일을 직접 읽어 확인한다.
// (이것이 "확정 전에 재시작하면 아무것도 나가지 않는다" 의 근거다: 승인이 파일에 없으면
//  재시작한 프로세스는 그 승인을 알 방법이 없다.)
W.persistPublishBoundary()
const diskAfterPrepare = fs.readFileSync(WF_FILE, 'utf8')
t('확정 화면을 여는 것만으로는 승격이 디스크에 기록되지 않는다',
  !W.getWorkflow('ok-review').promotedAt
  && !JSON.parse(diskAfterPrepare).workflows.some((w) => w.id === 'ok-review' && w.promotedAt))
t('확인 토큰이 디스크에 남지 않는다', p1.ok && !diskAfterPrepare.includes(p1.plan.token))

// 취소는 **아무것도 바꾸지 않는다**.
const beforeCancel = JSON.stringify(W.getWorkflow('ok-review'))
W.cancelPromotion('ok-review')
t('취소하면 워크플로가 한 글자도 바뀌지 않는다', JSON.stringify(W.getWorkflow('ok-review')) === beforeCancel)
t('취소한 뒤에는 그 확인으로 게시할 수 없다',
  isRejection(W.confirmPromotion('ok-review', p1.ok ? p1.plan.token : 'x'), [['유효한 확인이 없습니다', 'No valid confirmation']]))
t('취소·거부를 겪어도 초안은 그대로 남는다',
  W.getWorkflow('ok-review').caption === BASE_CAPTION && W.getWorkflow('ok-review').artifactId === ART.id
  && W.getWorkflow('ok-review').stage === 'review')

// ===================== ② 확인은 1회용이다 =====================

const p2 = W.preparePromotion('t-single')
t('틀린 토큰으로는 게시하지 않는다',
  isRejection(W.confirmPromotion('t-single', 'wrong-token'), [['확인 정보가 맞지 않아', 'did not match']]))
t('틀린 토큰 한 번으로 그 확인은 소진된다 — 곧이어 맞는 토큰을 보내도 게시하지 않는다',
  isRejection(W.confirmPromotion('t-single', p2.ok ? p2.plan.token : 'x'), [['유효한 확인이 없습니다', 'No valid confirmation']]))
t('그 사이에도 승격 기록은 생기지 않았다', !W.getWorkflow('t-single').promotedAt && !W.getWorkflow('t-single').taskIds.publish)

const p2b = W.preparePromotion('t-expire')
t('오래된 확인은 만료된다', (() => {
  const realNow = Date.now
  Date.now = () => realNow() + 11 * 60_000   // TTL 10분
  try { return isRejection(W.confirmPromotion('t-expire', p2b.ok ? p2b.plan.token : 'x'), [['만료', 'expired']]) }
  finally { Date.now = realNow }
})())

// ===================== ③ 확인한 것과 달라지면 무효다 =====================

const p3 = W.preparePromotion('b-caption')
W.setCaption('b-caption', '완전히 다른 캡션')
const r3 = W.confirmPromotion('b-caption', p3.ok ? p3.plan.token : 'x')
t('확인 뒤 캡션이 바뀌면 그 확인으로 게시하지 않는다', r3.ok === false, JSON.stringify(r3).slice(0, 300))
t('바뀐 것이 캡션이라고 사람 말로 알려 준다(ko·en)',
  typeof r3.error === 'string' && r3.error.includes('캡션')
  && typeof r3.errorEn === 'string' && r3.errorEn.includes('caption'),
  JSON.stringify(r3).slice(0, 300))
t('캡션을 바꾼 것만으로 게시가 나가지 않았다', !W.getWorkflow('b-caption').promotedAt && !W.getWorkflow('b-caption').taskIds.publish)

const p4 = W.preparePromotion('b-account')
W.setWorkflowAccount('b-account', 'someone-else')
const r4 = W.confirmPromotion('b-account', p4.ok ? p4.plan.token : 'x')
t('확인 뒤 계정이 바뀌면 그 확인으로 게시하지 않는다', r4.ok === false, JSON.stringify(r4).slice(0, 300))
t('바뀐 것이 계정이라고 사람 말로 알려 준다(ko·en)',
  typeof r4.error === 'string' && r4.error.includes('계정')
  && typeof r4.errorEn === 'string' && r4.errorEn.includes('account'),
  JSON.stringify(r4).slice(0, 300))

// 바인딩 지문 자체가 그 사실들로 갈리는가 — 같은 내용이면 같고, 한 글자만 달라도 다르다.
const revA = W.preparePromotion('rev-a').plan.revision
const revA2 = W.preparePromotion('rev-a2').plan.revision
const revB = W.preparePromotion('rev-cap').plan.revision
const revC = W.preparePromotion('rev-acct').plan.revision
t('같은 내용이면 바인딩 지문이 같고, 캡션·계정이 다르면 달라진다',
  revA === revA2 && revA !== revB && revA !== revC && revB !== revC,
  `A=${revA.slice(0, 8)} A2=${revA2.slice(0, 8)} cap=${revB.slice(0, 8)} acct=${revC.slice(0, 8)}`)

// ===================== ④ 올리면 안 되는 것은 거부한다 =====================

for (const [id, name, record, pairs] of DENY) {
  const pr = W.preparePromotion(id)
  // 확인 화면을 건너뛰고 직접 confirm 을 불러도 거부한다(화면이 버튼을 숨기는 것만 믿지 않는다).
  const cf = W.confirmPromotion(id, 'any-token')
  t(name, isRejection(pr, pairs) && cf.ok === false,
    `prepare=${JSON.stringify(pr).slice(0, 240)} confirm=${JSON.stringify(cf).slice(0, 140)}`)
  // 거부는 **초안을 잃지 않는다** — 캡션·이미지가 그대로 남아야 사용자가 고쳐서 다시 쓴다.
  const after = W.getWorkflow(id)
  t(`  └ 거부해도 초안이 그대로 남는다 — ${name}`,
    !!after && after.caption === record.caption && after.artifactId === record.artifactId
    // 게시 작업 자리가 새로 생기지도, 사라지지도 않았다.
    && Boolean(after.taskIds.publish) === Boolean(record.taskIds.publish)
    && (record.promotedAt ? !!after.promotedAt : !after.promotedAt),
    JSON.stringify(after ?? {}).slice(0, 220))
}

// ===================== ⑤ 완료된 초안은 올릴 수 있다 =====================

const p5 = W.preparePromotion('ok-done')
t('완료된 초안(영수증 status=draft)은 확정 화면이 열린다', p5.ok === true, JSON.stringify(p5).slice(0, 300))
t('그 확정 화면은 "완료된 초안에서 올린다" 고 표시한다', p5.ok && p5.plan.source === 'completed-draft', p5.ok ? p5.plan.source : 'n/a')
W.cancelPromotion('ok-done')

// ===================== ⑥ 승격 작업은 자동 게시 대상이 아니다 =====================

const g = W.grantAutoPublish({ platform: 'instagram', accounts: ['me'], maxPosts: 5, minutes: 60 })
t('선승인 자체는 만들어진다(대조군)', !!g)
const promoted = wf('verdict-probe', { params: { mode: 'publish' }, promotedAt: Date.now() })
promoted.createdAt = Date.now() + 1000   // 선승인보다 나중에 만들어진 것으로
const verdict = W.autoPublishVerdict(promoted)
t('사용자가 직접 확정해 올린 초안은 선승인이 있어도 자동 게시되지 않는다',
  verdict.ok === false && verdict.why.includes('직접 확정'), JSON.stringify(verdict))
W.revokeAutoPublish()

// ===================== ⑦ 재시작을 넘겨 기억한다 =====================

const kept = W.getWorkflow('r-keep')
t('승격 사실이 재시작을 넘겨 남는다', kept.promotedAt === 4242, String(kept.promotedAt))
t('지난 초안 기록이 재시작을 넘겨 그대로 남는다',
  kept.priorReceipts?.length === 1 && kept.priorReceipts[0].status === 'draft'
  && kept.priorReceipts[0].at === 111 && kept.priorReceipts[0].taskId === 'task_pub_draft',
  JSON.stringify(kept.priorReceipts))
// 손상된 값 — **잊는 쪽이 위험하다**(잊으면 실제 게시가 "초안" 으로 적히고 또 올릴 수 있게 된다).
t('승격 값이 손상돼도 "승격했다" 로 기억한다(fail-closed)',
  W.getWorkflow('r-corrupt').promotedAt === 1, String(W.getWorkflow('r-corrupt').promotedAt))
t('지난 기록이 손상됐으면 조용히 버리고 워크플로 자체는 살린다',
  !!W.getWorkflow('r-badprior') && !W.getWorkflow('r-badprior').priorReceipts)

// ===================== ⑧ 게시가 **시작조차 못 하면** 초안이 통째로 되돌아온다 =====================
//
// 이 순수 환경에는 실제 탭이 없으므로 `preparePublishTab` 이 반드시 실패한다 — 즉 "확정은 했는데
// 게시가 시작되지 못한" 상황을 결정론적으로 만들 수 있다. 그때 사용자가 보던 것(완료된 초안)이
// 그대로 돌아와야 한다. 돌아오지 않으면 초안 영수증이 이전 기록으로 밀려난 채 '실패' 로 남아,
// 아무것도 나가지 않았는데 사용자는 무슨 일이 있었는지 알 수 없게 된다.

const doneBefore = JSON.parse(JSON.stringify(W.getWorkflow('ok-done')))
const p8 = W.preparePromotion('ok-done')
const r8 = W.confirmPromotion('ok-done', p8.ok ? p8.plan.token : 'x')
t('확정 자체는 받아들여진다(대조군 — 이 시점까지는 정상 경로다)', r8.ok === true, JSON.stringify(r8))

// ⚠ 확정 **직후**(탭 준비는 아직 비동기로 돌고 있다) 장부가 그대로인지 본다.
//
// 왜 중요한가 (2026-09-19 코드 검토 H2): 예전 판은 확정 즉시 영수증을 priorReceipts 로 옮기고
// taskIds.publish 를 비웠다. 탭 준비는 비동기라 그 사이 400ms 디바운스 저장이 한 번만 돌아도
// 디스크에 `stage:'publish' + 게시 작업 없음` 이 남고, 거기서 앱이 죽으면 복원이 그것을
// **'failed' 로 굳혀 완료된 초안을 통째로 잃는다.** 이제 정리는 내구성 경계 직전에 한 번에 한다.
const midFlight = W.getWorkflow('ok-done')
t('확정 직후(탭 준비 중)에는 옛 영수증·게시 작업 기록이 **아직 제자리에** 있다 — 여기서 죽어도 초안을 잃지 않는다',
  JSON.stringify(midFlight.receipt) === JSON.stringify(doneBefore.receipt)
  && midFlight.taskIds.publish === doneBefore.taskIds.publish
  && !midFlight.promotedAt && !midFlight.priorReceipts,
  `receipt=${JSON.stringify(midFlight.receipt)} pubTask=${midFlight.taskIds.publish} promotedAt=${midFlight.promotedAt} prior=${JSON.stringify(midFlight.priorReceipts)}`)

await new Promise((res) => setTimeout(res, 300))   // 탭 준비(비동기)가 실패로 끝날 때까지
const doneAfter = W.getWorkflow('ok-done')
t('게시가 시작조차 못 하면 완료된 초안이 원래 상태로 돌아온다',
  doneAfter.stage === doneBefore.stage
  && JSON.stringify(doneAfter.receipt) === JSON.stringify(doneBefore.receipt)
  && doneAfter.taskIds.publish === doneBefore.taskIds.publish
  && !doneAfter.promotedAt,
  `stage=${doneAfter.stage}(${doneBefore.stage}) receipt=${JSON.stringify(doneAfter.receipt)} promotedAt=${doneAfter.promotedAt}`)
t('되돌린 뒤 이전 기록이 늘어나 있지 않다(같은 영수증이 두 군데 있으면 안 된다)',
  !doneAfter.priorReceipts, JSON.stringify(doneAfter.priorReceipts))
t('아무것도 나가지 않았으므로 게시 작업도 만들어지지 않았다',
  doneAfter.taskIds.publish === 'task_pub_draft', String(doneAfter.taskIds.publish))
t('되돌린 뒤에는 다시 올릴 수 있다(초안을 잃지 않았다)', W.preparePromotion('ok-done').ok === true)
W.cancelPromotion('ok-done')
// 조용히 되돌리기만 하면 사용자는 "눌렀는데 아무 일도 안 일어난다" 를 반복한다 — 사유를 남겨야 한다.
t('게시를 시작하지 못한 이유가 화면에 남는다(조용히 삼키지 않는다)',
  !!doneAfter.recovery && doneAfter.recovery.kind === 'publish-storage-failed'
  && !!doneAfter.recovery.stoppedAt && doneAfter.recovery.nextAction.includes('아무것도 올라가지 않았습니다'),
  JSON.stringify(doneAfter.recovery))

// ===================== ⑨ 태그도 확인 화면과 확정에 묶인다 =====================
// 태그는 캡션 끝에 실제로 붙어 나간다(captionWithTags). 확인 화면이 "위 내용 그대로" 라고 말하려면
// 보여 줘야 하고, 확정도 그 축에 묶여야 한다.
const pTag = W.preparePromotion('tagged')
t('확정 화면이 실제로 붙어 나갈 해시태그를 함께 보여 준다',
  pTag.ok && Array.isArray(pTag.plan.tags) && pTag.plan.tags.join(',') === 'aa,bb',
  JSON.stringify(pTag.ok ? pTag.plan.tags : pTag))
t('태그가 다르면 바인딩 지문도 다르다',
  pTag.ok && pTag.plan.revision !== W.preparePromotion('tagged-other').plan.revision,
  `tagged=${pTag.ok ? pTag.plan.revision.slice(0, 8) : 'n/a'}`)
W.cancelPromotion('tagged'); W.cancelPromotion('tagged-other')

// ===================== ⑩ 파일이 제자리에서 바뀌면 잡는다 =====================
// 기록된 값끼리만 비교하면 사용자가 그림 파일을 덮어쓴 경우를 못 잡는다 — 그러면 확인한 것과
// 다른 그림이 올라간다. 지금 디스크에 있는 바이트를 직접 해싱해 대조한다.
{
  const before = W.preparePromotion('swap')
  t('바꾸기 전에는 통과한다(대조군)', before.ok === true, JSON.stringify(before).slice(0, 150))
  W.cancelPromotion('swap')
  const artPath = A.resolveArtifactPath(GEN_TASK, ART.id)
  const original = fs.readFileSync(artPath)
  fs.writeFileSync(artPath, Buffer.concat([PNG_1X1, Buffer.from('tampered')]))   // 같은 경로, 다른 바이트
  const after = W.preparePromotion('swap')
  t('보관 파일이 제자리에서 바뀌면 거부한다(기록값이 아니라 실제 바이트를 다시 해싱한다)',
    isRejection(after, [['처음 확인한 것과 달라졌습니다', 'no longer matches']]), JSON.stringify(after).slice(0, 220))
  fs.writeFileSync(artPath, original)   // 되돌린다 — 이후 검사에 영향 주지 않게
  t('되돌리면 다시 통과한다(검사가 파일 내용에 실제로 반응한다)', W.preparePromotion('swap').ok === true)
  W.cancelPromotion('swap')
}

// ===================== 마무리 =====================

const outDir = path.join(REPO, 'verify-out', 'draft-promotion-pure')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'results.json'),
  JSON.stringify({ at: new Date().toISOString(), pass, fail, results }, null, 2), 'utf8')

try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* 임시 디렉터리 정리 실패는 무시 */ }

console.log(`\n초안 승격 게이트: ${pass} PASS / ${fail} FAIL`)
console.log('범위: 판정 규칙만(앱 없이). 실제 게시 흐름은 build/verify-draft-promotion-cdp.mjs 가 본다.')
process.exit(fail === 0 ? 0 : 1)
