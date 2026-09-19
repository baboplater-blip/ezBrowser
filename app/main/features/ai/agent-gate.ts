import type { AgentAction, PageObservation } from './page-actions'

// 에이전트 행동의 위험 등급 판정 — "라벨 키워드 단독 판정"을 폐기하고 세 가지를 함께 본다:
//   (1) 페이지 컨텍스트(현재 URL 이 결제·삭제성인가)  ← 페이지가 위조하기 어려운 신호
//   (2) 행동 종류(무엇을 하는가 — 클릭/JS 실행/이동/입력)
//   (3) 대상 라벨·프레임(무엇을 누르는가 — 판별 불가면 보수적으로)
//
// 정책(사용자 결정): 글 게시·발행·업로드·공유는 에이전트의 정상 작업이라 확인 없이 진행한다.
// 확인을 남기는 것은 진짜 되돌리기 어려운 것뿐 — 돈(결제·송금·충전)과 데이터 파괴(삭제·탈퇴·해지).
//
// 등급:
//   none     확인 없이 실행
//   confirm  사용자 확인. 무인 실행(트리거·스케줄·배치)에서는 각 호출자의 autoConfirm 정책을 따른다.
//   critical 돈·데이터 파괴. 무인 실행에서는 autoConfirm 이라도 절대 자동 승인하지 않는다.

export type RiskLevel = 'none' | 'confirm' | 'critical'

export interface RiskVerdict {
  level: RiskLevel
  reason: string
}

const NONE: RiskVerdict = { level: 'none', reason: '' }

// ===== 위험 어휘 =====
// 돈 계열. "구독"(유튜브 구독 등 무료)·"게시/발행/공유"는 의도적으로 제외 — 오탐이 자동 발행을 막는다.
const MONEY_RE = /결제|결재|구매|구입|주문하기|바로\s*구매|장바구니\s*주문|송금|이체|출금|충전|후원|선물하기|유료\s*전환|환불|청구|카드\s*등록|payment|checkout|purchase|\bpay now\b|\bpay\b|paypal|\bbilling\b|place order/i
// 데이터·계정 파괴 계열. "지우기·초기화"는 검색어 지우기·필터 초기화 오탐이 많아 제외.
const DESTRUCTIVE_RE = /삭제|영구\s*삭제|탈퇴|회원\s*탈퇴|해지|구독\s*취소|비활성화|\bdelete\b|\bdeactivate\b|close account|\bunsubscribe\b|\bwithdraw\b/i
// 계정 이탈 — 되돌릴 수 있으나 세션을 잃어 자동화가 중단된다(confirm).
const LOGOUT_RE = /로그아웃|sign\s?out|log\s?out/i

// 카드·주민·계좌 등 민감 입력 필드(라벨 기준) — 여기에 타이핑하는 것은 금전 위험.
const PII_FIELD_RE = /카드\s*번호|card\s*number|\bcvc\b|\bcvv\b|보안\s*코드|유효\s*기간|expiry|주민\s*(등록)?\s*번호|계좌\s*번호|account\s*number/i
// 카드번호 형태의 값(16자리 등) — 입력 텍스트 자체로 판정(키워드 오탐 없이 정확).
const CARD_NUMBER_RE = /\b(?:\d[ -]?){13,19}\b/

// 결제·삭제성 URL — navigate/open_tab 게이트 + "지금 페이지가 위험한가" 컨텍스트 판정 둘 다에 쓴다.
const RISKY_URL_RE = /checkout|\/pay(ment)?(\/|$|\?)|\bbilling\b|purchase|order\/(confirm|payment)|결제|송금|이체|withdraw|unsubscribe|delete[-_]?account|account\/(delete|close)|탈퇴|해지/i

// 한국 PG·해외 결제 위젯 호스트 — cross-origin iframe 이라 내용을 볼 수 없으므로 좌표 클릭 시 보수 판정.
const PAY_HOST_RE = /(toss|tosspayments|kakaopay|naverpay|payco|nicepay|inicis|kcp|danal|payple|eximbay|smilepay|paypal|stripe|adyen|braintree)/i

// 임의 JS 가 "되돌릴 수 없는 일"을 하는가 — 키워드가 아니라 코드가 하는 행위로 판정.
// (클릭·폼 제출·이동·네트워크 전송). 순수 조회(querySelector + 텍스트 반환)는 none.
const JS_EFFECT_RE = /\.click\s*\(|\.submit\s*\(|requestSubmit|location\s*\.\s*(href|assign|replace)|location\s*=|window\.open|\bfetch\s*\(|XMLHttpRequest|sendBeacon|document\.forms|\.remove\s*\(|removeChild/i

// 위험 판정에서 아예 제외되는 행동(페이지를 바꾸지 않음).
// request_scope 는 그 자체로 페이지를 바꾸지 않고, 별도의 사용자 승인 창을 띄우는 동작이라 여기서는 무해로 둔다
// (승인 없이는 아무 것도 넓어지지 않는다). select 는 페이지 상태를 바꾸므로 **여기 없다** — 라벨 기반 위험 판정을 받는다.
const HARMLESS = new Set(['scroll', 'read', 'wait', 'wait_for', 'done', 'ask', 'note', 'report', 'remember', 'extract', 'hover', 'switch_tab', 'close_tab', 'request_scope'])

// ===== 신뢰 레시피(우리 제품이 생성한 JS) =====
// 블로그 발행 브릿지처럼 앱이 직접 만든 JS 는 내용이 검증돼 있으므로 게이트를 면제한다.
// LLM 이 스스로 작성한 JS 만 게이트를 받도록 해, "클릭 게이트를 run_js 로 우회"하는 경로를 막는다.
// 문자열 완전 일치로만 인정 — 한 글자라도 바뀌면 신뢰하지 않는다(변조 방지).
const trustedJs = new Map<string, number>()
const TRUSTED_TTL_MS = 60 * 60 * 1000

export function registerTrustedJs(code: string): void {
  const c = (code ?? '').trim()
  if (!c) return
  const now = Date.now()
  for (const [k, t] of trustedJs) if (now - t > TRUSTED_TTL_MS) trustedJs.delete(k)
  trustedJs.set(c, now)
}

export function isTrustedJs(code: string): boolean {
  const c = (code ?? '').trim()
  const t = trustedJs.get(c)
  if (t === undefined) return false
  if (Date.now() - t > TRUSTED_TTL_MS) { trustedJs.delete(c); return false }
  return true
}

// ===== 게시(발행) 인식 =====
// 게시는 확인 게이트 대상이 아니지만(정상 작업), "이미 게시된 뒤 또 누르는 것"은 중복 게시라 막아야 한다.
// 그래서 위험 판정과 별개로 "이 클릭이 게시성인가"를 알아본다.
// "게시" 단독은 발행 버튼(유튜브 "게시")이지만, "게시물"·"게시 예약"·"게시물 미리보기" 는 아니다 — 인스타의 메뉴
// "새로운 게시물 만들기"·"게시물" 이 발행성으로 오인돼 draft 모드에서 차단되던 결함(실사이트 파일럿 2026-09-13).
const PUBLISH_RE = /발행|게시(?!\s*(물|예약|미리|정책))|등록하기|올리기|업로드하기|공유하기|공유$|저장하기|publish|post now|share$|submit post|upload$/i
// 게시 완료 신호 — 화면에 이런 문구가 뜨거나 URL 이 글 주소로 바뀌면 발행이 끝난 것으로 본다.
const PUBLISHED_TEXT_RE = /발행(이|되)?\s*(완료|되었|됐)|게시(가|되|물이)?\s*(완료|되었|됐|공유되었)|공유(가|되)?\s*(완료|되었|됐)|등록(이|되)?\s*(완료|되었|됐)|성공적으로\s*(발행|게시|등록)|published|posted successfully|your post is live|has been shared/i

// 작업 지시에 이 표식이 있으면 발행성 클릭을 코드로 차단한다(임시저장·입력만 모드).
// 프롬프트 지시만으로는 "저장" 대신 "발행" 오클릭을 막을 수 없다.
export const NO_PUBLISH_MARK = '[모드: 발행 금지]'

// ===== 완료 신호 표식 =====
// 레시피(sns-publish 등)가 "게시가 끝나면 화면에 새로 나타날 문구 / 바뀔 URL" 을 작업 지시문 안에 표식으로 넣는다.
// 에이전트 루프는 주 동작 뒤 관찰에서 이 신호가 **새로 나타났는지**(동작 전 관찰 기준선 대비) 판정해 모델 호출
// 없이 done 한다. 모델이 가드(expect)를 붙이길 기다리지 않는 길 — 모델 채택률에 절감이 좌우되지 않는다.
export interface CompletionSignal { texts: string[]; urlContains?: string; message?: string }
export const COMPLETION_MARK = '[완료 신호]'
const SEP_LINE = String.fromCharCode(10)
export function buildCompletionMark(sig: { texts?: string[]; urlContains?: string; message?: string }): string {
  const parts: string[] = []
  const texts = (sig.texts ?? []).map((t) => String(t).replace(/[|;]/g, ' ').trim()).filter(Boolean)
  if (texts.length) parts.push('문구=' + texts.join(' | '))
  if (sig.urlContains) parts.push('URL=' + String(sig.urlContains).replace(/[;]/g, '').trim())
  if (sig.message) parts.push('메시지=' + String(sig.message).replace(/[;]/g, ' ').trim())
  return `${COMPLETION_MARK} ${parts.join(' ; ')}`
}
export function parseCompletionMark(task: string): CompletionSignal | null {
  const t = String(task ?? '')
  const i = t.indexOf(COMPLETION_MARK)
  if (i < 0) return null
  const line = t.slice(i + COMPLETION_MARK.length).split(SEP_LINE)[0] ?? ''
  const sig: CompletionSignal = { texts: [] }
  for (const seg of line.split(';')) {
    const x = seg.trim()
    if (x.startsWith('문구=')) sig.texts = x.slice(3).split('|').map((v) => v.trim()).filter(Boolean)
    else if (x.startsWith('URL=')) sig.urlContains = x.slice(4).trim() || undefined
    else if (x.startsWith('메시지=')) sig.message = x.slice(4).trim() || undefined
  }
  return sig.texts.length || sig.urlContains ? sig : null
}

export function isNoPublishTask(task: string): boolean {
  return String(task ?? '').includes(NO_PUBLISH_MARK)
}

/**
 * 이 클릭이 **발행성**인가(원장 기록 · 발행 금지 하드블록 · 중복 게시 가드가 모두 이걸 본다).
 *
 * ⚠ 왜 두 번 보는가 (2026-09-19 실측): `PUBLISH_RE` 에는 `공유$`·`upload$`·`share$` 처럼 **끝을 고정한**
 *   갈래가 있다. 그 의도는 "버튼 이름이 **바로 그 단어**일 때만"(`공유 정책` 같은 것에 걸리지 않게)이다.
 *   그런데 실제 라벨은 `describeAction` 이 만드는 **`클릭 "공유"`** 모양이라 **뒤에 닫는 따옴표가 붙는다** —
 *   끝 고정 갈래는 **어떤 라벨과도 매치될 수 없었다.** 결과로 `공유`·`업로드`·`Share` 처럼 이름이
 *   딱 한 단어인 버튼은 ① 원장에 안 적히고(중복 게시 보호 없음) ② **임시저장·입력만 모드의
 *   하드블록을 그냥 지나갔다**(초안만 만들어야 하는 작업이 실제로 게시될 수 있었다).
 *
 *   그래서 라벨 전체로 한 번 보고, **클릭 라벨이면 따옴표 안의 이름만 떼어** 아래 목록과 대조한다.
 *   `type`·`select` 처럼 사용자가 친 값이 따옴표에 담기는 라벨은 이 경로를 타지 않는다 —
 *   "공유" 라고 **입력**한 것이 발행으로 오인되면 안 되기 때문이다.
 *
 * ⚠ `업로드`/`Upload` 단독은 **일부러 넣지 않았다.** 유튜브 스튜디오처럼 그 버튼이 파일 선택 창을
 *   여는 사이트가 많아서, 발행성으로 보면 **초안(발행 금지) 모드가 파일 첨부조차 못 하게** 된다.
 *   (그래서 `PUBLISH_RE` 의 `upload$` 갈래는 클릭 라벨에 대해 여전히 닿지 않는다 — 알면서 둔다.)
 */
const PUBLISH_NAME_RE = /^(공유|공유하기|발행|발행하기|share|publish|post)$/i

export function isPublishAction(label: string): boolean {
  const s = String(label ?? '')
  if (PUBLISH_RE.test(s)) return true
  const named = /^\s*(?:클릭|화면 클릭)\s+"([^"]*)"/.exec(s)
  return named ? PUBLISH_NAME_RE.test((named[1] ?? '').trim()) : false
}

export function looksPublished(pageText: string): boolean {
  return PUBLISHED_TEXT_RE.test(pageText ?? '')
}

// ===== 프롬프트 인젝션 탐지 =====
// 페이지 본문·요소 이름은 "누가 썼는지 알 수 없는 데이터"다. 그런데 그것이 매 단계 LLM 프롬프트에
// 들어가므로, 악성 페이지가 "이전 지시 무시하고 …해라" 를 심어 에이전트를 조종할 수 있다.
// 완전 차단은 불가능하므로 3중으로 방어한다: (1) 데이터 경계 표기 (2) 아래 탐지 + 경고 주입
// (3) 실제 피해가 되는 행동은 위 위험 게이트가 최종 차단.
const INJECTION_RE = new RegExp([
  '이전\\s*(의\\s*)?(지시|명령|프롬프트)\\w*\\s*(은|는|를|을)?\\s*무시',
  '앞의?\\s*(지시|명령)\\w*\\s*무시',
  'ignore\\s+(all\\s+)?(previous|prior|above)\\s+(instructions?|prompts?)',
  'disregard\\s+(the\\s+)?(previous|above)',
  '(system|시스템)\\s*(prompt|프롬프트)\\s*(을|를)?\\s*(출력|무시|공개|reveal|print)',
  // 한글 뒤에는 \\b(단어 경계)를 쓰면 안 된다 — JS 정규식의 \\b 는 [A-Za-z0-9_] 기준이라
  // 한글 다음에는 **절대 성립하지 않는다**. 이 줄은 어떤 문장에도 매치되지 않는 죽은 패턴이었다
  // (2026-09-07 임무 24 실측). 영문 쪽(you are now …\\b)은 정상이라 그대로 둔다.
  '너는\\s*이제',
  'you\\s+are\\s+now\\s+(a|an)\\b',
  '"action"\\s*:',            // 페이지 안에 우리 액션 JSON 을 심어 행동을 지시하는 시도
  'new\\s+instructions?\\s*:',
  '새로운?\\s*지시\\s*:',
].join('|'), 'i')

export function detectInjection(text: string): boolean {
  if (!text) return false
  return INJECTION_RE.test(text)
}

// 기억(remember)에 저장하려는 내용이 "사실"이 아니라 "지시"인가.
// 1회 인젝션이 영구 기억에 들어가면 이후 모든 세션의 시스템 프롬프트를 오염시키는 백도어가 된다.
const MEMORY_INSTRUCTION_RE = new RegExp([
  '무시하',
  '하세요|해라|하라|해야\\s*한다|반드시\\s*\\S+하',   // 한글 뒤 \\b 금지(위 주석 참고)
  '앞으로\\s*(모든|항상)',
  'always\\s+\\w+|must\\s+\\w+|never\\s+\\w+',
  'ignore|instruction',
  'https?://',               // 기억에 심어진 링크 = 이후 세션에 피싱 유도
  '"action"\\s*:|run_js|navigate',
].join('|'), 'i')

export function looksLikeInstruction(text: string): boolean {
  if (!text) return false
  return MEMORY_INSTRUCTION_RE.test(text)
}

// ===== 판정 =====

export interface RiskCtx {
  pageUrl: string
  clickAtLabel?: string     // click_at 좌표 지점의 라벨(빈 문자열이면 판별 불가)
  clickAtTag?: string       // 그 지점 요소의 태그(IFRAME 이면 내용을 볼 수 없음)
  clickAtFrameSrc?: string  // IFRAME 이면 그 src
}

function classifyLabel(label: string): RiskVerdict {
  if (MONEY_RE.test(label)) return { level: 'critical', reason: '금전 관련 동작(결제·송금·충전)' }
  if (DESTRUCTIVE_RE.test(label)) return { level: 'critical', reason: '삭제·탈퇴 등 되돌릴 수 없는 동작' }
  if (LOGOUT_RE.test(label)) return { level: 'confirm', reason: '로그아웃(세션이 끊겨 자동화가 중단됨)' }
  return NONE
}

export function isRiskyUrl(url: string): boolean {
  return RISKY_URL_RE.test(url ?? '')
}

export function assessRisk(action: AgentAction, obs: PageObservation, ctx: RiskCtx): RiskVerdict {
  if (HARMLESS.has(action.action)) return NONE

  const pageRisky = isRiskyUrl(ctx.pageUrl)

  // 이동류(navigate/open_tab) — 목적지 URL 자체로 판정. open_tab 도 navigate 와 동일하게 검사한다
  // (예전에는 open_tab 이 게이트를 통째로 우회했다).
  if (action.action === 'navigate' || action.action === 'open_tab') {
    const u = action.url ?? ''
    if (MONEY_RE.test(u)) return { level: 'critical', reason: '결제성 주소로 이동' }
    if (DESTRUCTIVE_RE.test(u) || /delete[-_]?account|account\/(delete|close)|unsubscribe/i.test(u)) {
      return { level: 'critical', reason: '삭제·탈퇴성 주소로 이동' }
    }
    return NONE
  }

  // 대상 라벨 — click_at 은 좌표 조사 결과, 나머지는 관찰된 요소.
  const el = obs.elements.find((e) => e.ref === action.ref)
  const label = action.action === 'click_at'
    ? (ctx.clickAtLabel ?? '')
    : `${el?.name ?? ''} ${el?.type ?? ''}`

  const byLabel = classifyLabel(label)
  if (byLabel.level !== 'none') return byLabel

  // 임의 JS 실행 — 앱이 만든 신뢰 레시피가 아니면, 효과를 내는 코드는 확인을 받는다.
  if (action.action === 'run_js') {
    const code = action.code ?? ''
    if (isTrustedJs(code)) return NONE
    if (MONEY_RE.test(code) || DESTRUCTIVE_RE.test(code)) {
      return { level: 'critical', reason: 'JS 로 결제·삭제성 동작 실행' }
    }
    if (JS_EFFECT_RE.test(code)) {
      return pageRisky
        ? { level: 'critical', reason: '결제·삭제성 페이지에서 JS 로 클릭·제출·전송' }
        : { level: 'confirm', reason: 'JS 로 클릭·제출·이동·네트워크 전송' }
    }
    return NONE
  }

  // 저장된 개인정보 자동 채우기 — 어떤 사이트에 무엇을 흘리는지 사용자가 알아야 한다.
  if (action.action === 'autofill') {
    let host = ''
    try { host = new URL(ctx.pageUrl).hostname } catch { host = '이 사이트' }
    return { level: 'confirm', reason: `저장된 내 정보를 ${host} 폼에 채웁니다` }
  }

  // 입력 — 카드번호 형태의 값이나 카드·주민·계좌 필드는 금전 위험.
  if (action.action === 'type') {
    if (PII_FIELD_RE.test(label)) return { level: 'critical', reason: '카드·주민·계좌 등 민감 필드 입력' }
    if (CARD_NUMBER_RE.test(action.text ?? '')) return { level: 'critical', reason: '카드번호 형태의 값 입력' }
  }

  // 키 입력 — ref 없는 Enter 는 "지금 포커스된 무언가를 제출"이라 대상 확인이 불가능하다.
  if (action.action === 'key') {
    const k = (action.key ?? '').toLowerCase()
    const submitish = k === 'enter' || k === 'return' || k === 'numpadenter'
    const destructive = /(^|\+)(delete|backspace)$/.test(k)
    if (submitish) {
      if (pageRisky) return { level: 'critical', reason: '결제·삭제성 페이지에서 Enter 제출' }
      if (!el) return { level: 'confirm', reason: '대상을 알 수 없는 Enter 제출(포커스된 폼이 제출됨)' }
      if (el.type === 'submit') return { level: 'confirm', reason: '폼 제출' }
    }
    if (destructive && pageRisky) return { level: 'critical', reason: '결제·삭제성 페이지에서 삭제 키' }
  }

  // click_at — 좌표만 알고 대상은 모른다. 내용을 볼 수 없는 외부 프레임(결제 위젯)은 보수적으로.
  if (action.action === 'click_at' && !label.trim()) {
    const src = ctx.clickAtFrameSrc ?? ''
    if (ctx.clickAtTag === 'IFRAME' && (PAY_HOST_RE.test(src) || isRiskyUrl(src))) {
      return { level: 'critical', reason: '외부 결제 프레임 클릭(내용 확인 불가)' }
    }
    if (ctx.clickAtTag === 'IFRAME' && pageRisky) {
      return { level: 'critical', reason: '결제·삭제성 페이지의 외부 프레임 클릭(내용 확인 불가)' }
    }
  }

  // 페이지 컨텍스트 자체가 위험하면(결제·탈퇴 화면) 그 위에서의 조작은 라벨과 무관하게 확인을 받는다.
  // — 아이콘·이미지 버튼처럼 라벨이 없는 결제 확정 버튼을 잡아내는 마지막 그물.
  if (pageRisky && (action.action === 'click' || action.action === 'click_at' || action.action === 'type' || action.action === 'key' || action.action === 'drag')) {
    return { level: 'confirm', reason: '결제·삭제성 페이지에서의 조작' }
  }

  return NONE
}

// ===== 참여 가드 (블로그 댓글·좋아요) =====
//
// 왜 필요한가: 중복 방지를 **지시문으로만** 하면 지켜지지 않는다. 실측(2026-09-18 하네스)에서
// 같은 글에 댓글이 두 번 달렸고, 이미 눌린 좋아요를 다시 눌러 **취소**됐고, 초안 모드인데도
// 댓글이 등록됐다. 장부에 기록만 하고 **행동을 막지 않으면** 그건 방지가 아니다.
//
// 그래서 발행 금지 표식(NO_PUBLISH_MARK)과 같은 방식으로 작업 지시문에 표식을 싣고,
// 에이전트 루프가 **클릭 직전에 코드로** 막는다.

export const ENGAGE_MARK_PREFIX = '[참여 가드]'

export interface EngageGuard {
  account: string
  mode: 'draft' | 'act'
  comment: boolean
  like: boolean
  /**
   * 이 작업의 한도·간격 카운터를 묶는 키. 작업 지시문에만 실리므로 **모델도 페이지도 만들 수 없다**
   * (지시문은 신뢰 경로에서만 쓰인다 — createTask/setTaskInstruction).
   * 빈 문자열이면 한도 집계를 할 수 없으므로 한도·간격을 적용하지 않는다(표식이 없던 시절 작업 호환).
   */
  guardId: string
  /** 행동 종류별 이번 작업 최대 횟수. 0 이하 = 한도 없음(집계만). */
  limit: number
  /** 같은 계정의 연속 행동 사이 최소 간격(ms). 0 = 간격 제한 없음. */
  intervalMs: number
  /** 이 시각(epoch ms) 이후에는 더 하지 않는다. 0 = 기한 없음. */
  until: number
}

function intField(line: string, name: string): number {
  const m = new RegExp(`${name}=(\\d{1,15})`).exec(line)
  const v = m ? Number(m[1]) : 0
  return Number.isFinite(v) && v > 0 ? v : 0
}

export function buildEngageMark(g: EngageGuard): string {
  const acts = [g.comment ? 'comment' : '', g.like ? 'like' : ''].filter(Boolean).join(',')
  // 계정 이름에 줄바꿈·파이프가 들어가면 파싱이 깨지므로 제거한다.
  const acc = String(g.account ?? '').replace(/[|\r\n]/g, ' ').trim().slice(0, 120)
  // guardId 는 파싱이 흔들리지 않게 영숫자·하이픈만 남긴다.
  const gid = String(g.guardId ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64)
  const nums = [
    gid ? `id=${gid}` : '',
    g.limit > 0 ? `limit=${Math.floor(g.limit)}` : '',
    g.intervalMs > 0 ? `interval=${Math.floor(g.intervalMs)}` : '',
    g.until > 0 ? `until=${Math.floor(g.until)}` : '',
  ].filter(Boolean).join(' ')
  return `${ENGAGE_MARK_PREFIX} account=${acc} mode=${g.mode} actions=${acts}${nums ? ` ${nums}` : ''}`
}

export function parseEngageMark(task: string): EngageGuard | null {
  const line = String(task ?? '').split('\n').find((l) => l.includes(ENGAGE_MARK_PREFIX))
  if (!line) return null
  const acc = /account=([^\n]*?)\s+mode=/.exec(line)?.[1] ?? ''
  const mode = /mode=(draft|act)/.exec(line)?.[1] === 'act' ? 'act' : 'draft'
  const acts = (/actions=([a-z,]*)/.exec(line)?.[1] ?? '').split(',')
  return {
    account: acc.trim(),
    mode,
    comment: acts.includes('comment'),
    like: acts.includes('like'),
    guardId: /\bid=([A-Za-z0-9-]{1,64})/.exec(line)?.[1] ?? '',
    limit: intField(line, 'limit'),
    intervalMs: intField(line, 'interval'),
    until: intField(line, 'until'),
  }
}

// 클릭 라벨 분류. **취소를 먼저 본다** — "좋아요 취소" 는 좋아요가 아니라 취소다(순서를 뒤집으면
// 이미 눌린 좋아요를 다시 눌러 풀어 버린다).
const UNLIKE_RE = /(좋아요|공감|like)\s*(취소|해제)|(취소|해제)\s*(좋아요|공감)|unlike/i
const LIKE_RE = /좋아요|공감|\blike\b|추천/i
// 댓글 "등록" 동사가 함께 있을 때만 제출로 본다 — 그냥 "댓글" 이라는 글자는 목록 제목에도 흔하다.
const COMMENT_SUBMIT_RE = /(댓글|덧글|리플|comment|reply)[^\n]{0,12}(등록|작성|남기|올리|달기|게시|보내|submit|post|send)|(등록|작성|남기|올리|달기)[^\n]{0,8}(댓글|덧글)/i

export type EngageClick = 'comment' | 'like' | 'unlike' | null

export function classifyEngageClick(label: string): EngageClick {
  const s = String(label ?? '')
  if (!s) return null
  if (UNLIKE_RE.test(s)) return 'unlike'
  if (COMMENT_SUBMIT_RE.test(s)) return 'comment'
  if (LIKE_RE.test(s)) return 'like'
  return null
}

// ===== 게시 여부 확인 근거 (읽기 전용 확인 작업) =====
//
// 왜 필요한가 (2026-09-19, 실사용 결함): "이미 게시됐는가" 를 모델이 `게시됨:` 이라고 **말했다는
// 사실만으로** 판정하고 있었다. 그 한 줄은 페이지를 한 번도 보지 않아도, 로그인 화면에서도,
// 엉뚱한 계정에서도 나올 수 있다. 그런데 그 판정의 결과는 되돌릴 수 없다 —
// `게시됨` 으로 잘못 믿으면 실제로는 안 올라간 글이 '완료'로 닫히고,
// `게시안됨` 으로 잘못 믿으면 이어가기 차단이 풀려 **같은 글이 두 번 올라간다**.
//
// 그래서 모델의 산문은 **결론의 형식**으로만 쓰고, 그 결론을 **런타임이 실제로 관찰한 사실**과
// 대조한다. 런타임이 기록하는 것(ReadSighting)은 모델이 만들 수 없다 — 에이전트 루프가
// 관찰 텍스트(obs.text)와 실제 주소(obs.url)에서 직접 뽑아 작업에 적는다.
//
// ⚠ 비대칭은 의도된 것이다. **있는 것은 볼 수 있지만 없는 것은 증명할 수 없다.**
//   목록에서 캡션을 봤다 → 올라갔다는 구체적 증거가 된다(완료 확정 가능).
//   목록에서 못 봤다 → 아직 반영이 안 됐거나·다른 계정이거나·목록이 잘렸을 수 있다(증거가 아니다).
//   그래서 '게시안됨' 은 자동으로 차단을 풀지 않는다 — 사람이 직접 확인해 고르는 길만 남긴다.

/** 확인 작업이 화면에서 찾아야 할 대조 문구와 그 사이트. 작업 지시문에만 실린다(신뢰 경로). */
export interface VerifyProbe {
  /** 하나라도 화면에 보이면 근거가 된다(캡션 전체·앞부분 등). */
  needles: string[]
  /** 이 호스트(및 서브도메인)에서 본 것만 센다. 다른 사이트에서 같은 문구를 본 것은 근거가 아니다. */
  host: string
}

/** 런타임이 **직접 관찰해** 작업에 적는 근거 한 건. 모델은 이 값을 만들 수 없다. */
export interface ReadSighting {
  /** 실제로 관찰된 페이지 주소 */
  url: string
  /** 그 주소의 호스트 */
  host: string
  /** 어느 대조 문구가 보였는가(정규화된 형태) */
  needle: string
  /** 주변 텍스트 발췌 — 사용자가 "무엇을 근거로" 인지 눈으로 본다 */
  snippet: string
  /** 런타임이 그것을 **관찰한** 시각(글이 올라간 시각이 아니다 — 아래 postedAt 과 다르다) */
  at: number
  /**
   * 그 **글 안에서** 읽은 작성자/계정 표기(정규화). 화면 전체가 아니라 글 단위 영역에서만 읽는다.
   * 못 읽었으면 없음 — 없는 것은 "내 글이 아니다"가 아니라 **"모른다"** 다.
   */
  author?: string
  /**
   * 작성자를 **어디서** 읽었는가. `'post'`(글 영역 안) 만 근거로 인정한다.
   * 전역 탐색 막대·로그인 표기에서 읽은 이름은 어느 페이지에나 있으므로 게시 증거가 될 수 없다.
   */
  authorScope?: 'post'
  /**
   * 작성자를 **어떻게** 읽었는가.
   *  - `'structural'` — `data-author`/`data-account` 같은 명시 표기. 불일치를 **확정**으로 써도 된다.
   *  - `'heuristic'` — 위치·모양 추정(캡션 위의 `@이름`·프로필 링크). 맞을 때는 쓰되,
   *    **불일치를 확정으로 쓰지 않는다**(아래 판정 8번 참고).
   */
  authorSource?: 'structural' | 'heuristic'
  /** **글 자체의** 게시 시각(ms). `<time datetime>` 또는 상대시각 문구에서. 못 읽었으면 없음. */
  postedAt?: number
  /** 화면에 보인 시각 표기 원문 — 사용자에게 그대로 보여 준다("방금", "2일 전" 등) */
  postedAtText?: string
  /**
   * 화면에 `<time datetime>` 이 있긴 했는데 **시간대 표기가 없어** 시점을 확정하지 못한 경우의 사유.
   * 이 값이 있으면 `postedAt` 은 비어 있고, 판정은 "모름"(uncertain) 으로 간다 — 자세한 이유는
   * `parseUnambiguousPostTime` 의 주석 참고.
   */
  postedAtUnclear?: string
  /** 화면 구조가 모호해 판정 재료를 신뢰할 수 없었던 이유. 있으면 근거로 쓰지 않는다. */
  ambiguous?: string
}

/**
 * `<time datetime="…">` 의 값을 **기계가 자란 시간대와 무관하게** 절대 시각(epoch ms)으로 읽는다.
 * 확정할 수 없으면 `0` 을 돌려준다 — 추측하지 않는다.
 *
 * ⚠ 왜 `Date.parse` 를 쓰지 않는가 (2026-09-19):
 *   `Date.parse('2026-09-19T10:00')` 처럼 **오프셋이 없는** 값은 명세상 **실행 기계의 지역 시간**으로
 *   해석된다. 그러면 같은 페이지·같은 글이 개발자 PC(KST)에서는 "새 글", 다른 사용자 PC(UTC)에서는
 *   "9시간 전 글" 이 되어 **게시 확인 판정이 기계마다 달라진다**. 형식이 ISO 를 벗어나면
 *   (`'09/19/2026'` 같은 값) 파싱 자체가 구현·로캘 의존이라 더 나쁘다.
 *   게시 여부 판정은 "이번 시도보다 뒤에 올라간 글인가" 를 시간으로 가르는데, 그 축이 기계에 따라
 *   흔들리면 **남의 글·지난 글을 이번 게시의 근거로 세거나**, 반대로 올라간 글을 못 봤다고 말한다.
 *
 * 그래서 **오프셋이 명시된 값만** 받는다(`Z` 또는 `±HH:MM`/`±HHMM`). 그리고 그 경우에도 `Date.parse`
 * 대신 `Date.UTC` 로 직접 계산한다 — 지역 시간이 식에 들어갈 여지를 아예 없앤다.
 *
 * 일부러 **받지 않는** 것들(전부 "모름" 으로 남는다):
 *  - 오프셋 없는 날짜·시각(`'2026-09-19T10:00'`, `'2026-09-19 10:00:00'`)
 *  - 날짜만 있는 값(`'2026-09-19'`) — 파싱은 UTC 로 확정되지만 **자정**을 뜻하게 되어, 실제로는
 *    오늘 올라간 글이 "이번 시도보다 오래된 글" 로 **확정 거부**된다. 확정 거부는 사용자가
 *    "게시 안 됨" 을 눌러 **같은 글을 또 올리게** 만드는 방향이라 가장 위험하다.
 *  - 로캘 의존 형식(`'09/19/2026'`, `'19.09.2026'`)
 *
 * 이 함수는 **자기 완결**이어야 한다(외부 참조 금지) — 아래 `POST_TIME_FN_SRC` 로 소스를 그대로
 * 페이지 안 스크립트에 넣어 쓴다. 검사와 실제 동작이 **같은 코드**여야 어긋나지 않는다.
 */
export function parseUnambiguousPostTime(raw: unknown): number {
  if (typeof raw !== 'string') return 0
  var s = raw.trim()
  if (!s || s.length > 64) return 0
  var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?\s*(Z|z|[+-]\d{2}:?\d{2})$/.exec(s)
  if (!m) return 0
  var y = +(m[1] as string), mo = +(m[2] as string), d = +(m[3] as string)
  var hh = +(m[4] as string), mi = +(m[5] as string)
  var ss = m[6] ? +m[6] : 0
  var ms = m[7] ? +((m[7] + '00').slice(0, 3)) : 0
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return 0
  if (hh > 23 || mi > 59 || ss > 59) return 0
  var offMin = 0
  var off = m[8] as string
  if (off !== 'Z' && off !== 'z') {
    var oh = +off.slice(1, 3)
    var om = +off.slice(-2)
    if (oh > 14 || om > 59) return 0
    offMin = (oh * 60 + om) * (off.charAt(0) === '-' ? -1 : 1)
  }
  var utc = Date.UTC(y, mo - 1, d, hh, mi, ss, ms)
  if (!isFinite(utc)) return 0
  // 2026-02-31 같은 값은 Date.UTC 가 조용히 다음 달로 넘긴다 — 되읽어 대조해 걸러낸다.
  var back = new Date(utc)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return 0
  var val = utc - offMin * 60000
  return isFinite(val) && val > 0 ? val : 0
}

/**
 * 위 함수의 **소스 그대로**. 페이지 안 스크립트에 주입해 쓴다(page-actions.ts).
 * 문자열을 따로 적어 두면 언젠가 갈라진다 — 같은 함수를 문자열로 만들어 쓴다.
 */
export const POST_TIME_FN_SRC = `var __bbPostTime = ${String(parseUnambiguousPostTime)};`

/** 이번 게시가 인정할 수 있는 근거의 조건. 전부 **이 게시 한 건에** 묶여 있어야 한다. */
export interface PublicationExpectation {
  /** 이 호스트(및 서브도메인)에서 본 것만 센다. */
  host: string
  /** 하나라도 글에서 보이면 문구 조건을 만족한다. */
  needles: string[]
  /** 런타임이 **관찰한** 시각의 하한(예전 확인이 남긴 기록을 배제한다). */
  notBefore: number
  /** 어느 계정으로 올렸는가. 모르면 자동 확정하지 않는다(사람이 확인). */
  account?: string
  /** 이번 **게시 시도**가 시작된 시각 — 글 자체가 이보다 뒤에 올라간 것이어야 한다. */
  attemptStartedAt: number
}

/**
 * 서버 시계와 우리 시계의 어긋남 허용치. 글의 게시 시각은 **사이트가 찍은 값**이라 우리 시계와
 * 정확히 같지 않다(표시 반올림 — "방금"·"1분 전" — 까지 포함하면 분 단위로 흔들린다).
 * 이 정도는 눈감아 주되, **시간·일 단위로 오래된 글**은 확실히 걸러낸다.
 */
export const PUBLICATION_CLOCK_SKEW_MS = 5 * 60_000

/**
 * 계정 표기를 비교 가능한 형태로 — 소문자·공백 제거·선행 `@`·후행 `/` 제거.
 *
 * ⚠ social-workflow 의 `normAccount`(선승인 범위용)와 **일부러 다른 함수**다. 그쪽은 빈 값을
 *   `'default'` 로 접어 "계정을 지정하지 않은 사용자" 도 선승인 범위에 넣는다. 여기서 그렇게 하면
 *   계정을 설정하지 않은 워크플로가 `'default'` 라는 이름의 글을 찾는 꼴이 되어, **모른다는 사실이
 *   조용히 지워진다.** 증거 판정에서 빈 값은 끝까지 빈 값이어야 한다.
 */
export function normalizeAccountName(s: unknown): string {
  return String(s ?? '')
    .trim()
    .replace(/^@+/, '')
    .replace(/\/+$/, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

export const VERIFY_PROBE_MARK = '[게시 확인]'
/**
 * 대조 문구 최소 길이(정규화 후). 너무 짧으면 아무 페이지에나 우연히 들어 있어 근거가 되지 못한다.
 * 캡션이 이보다 짧으면 이 방식으로는 확인할 수 없다 — 그때는 근거 없음으로 두고 사람이 판단한다.
 */
export const MIN_VERIFY_NEEDLE = 8
const MAX_VERIFY_NEEDLES = 3

export function normalizeVerifyText(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function hostOfUrl(url: string): string {
  try { return new URL(String(url ?? '')).hostname.toLowerCase() } catch { return '' }
}

/** 호스트(및 서브도메인) 일치 — frames.ts 의 hostAllowed 와 같은 규칙을 순수 함수로 둔다. */
export function verifyHostMatches(url: string, want: string): boolean {
  const w = String(want ?? '').trim().toLowerCase().replace(/^\*\./, '')
  if (!w) return false
  const h = hostOfUrl(url)
  if (!h) return false
  return h === w || h.endsWith('.' + w)
}

/**
 * 캡션에서 대조 문구를 뽑는다. 전체와 앞부분 둘 다 담는 이유: 사이트가 긴 캡션을 "… 더 보기" 로
 * 잘라 보여 주면 전체로는 못 찾지만 앞부분으로는 찾는다.
 */
export function verifyNeedlesFromCaption(caption: string): string[] {
  const full = normalizeVerifyText(caption)
  if (full.length < MIN_VERIFY_NEEDLE) return []
  const out = [full]
  for (const n of [60, 30]) {
    const cut = full.slice(0, n).trim()
    if (cut.length >= MIN_VERIFY_NEEDLE && !out.includes(cut)) out.push(cut)
  }
  return out.slice(0, MAX_VERIFY_NEEDLES)
}

/**
 * 표식의 구분자(`|`·`;`)와 충돌하지 않게 **되돌릴 수 있는 형태로** 인코딩한다.
 *
 * 왜 (2026-09-19): 예전에는 `|`·`;` 를 **공백으로 치환**해 버렸다. 그러면 표식에 적힌 대조 문구가
 * 실제 화면 텍스트와 달라져(화면엔 `|` 가 그대로 있다) **영영 못 찾는다** — 캡션에 `|` 를 쓰는 것은
 * 흔한데(“오늘 기록 | 카페”), 그런 캡션에서는 게시 확인 기능이 조용히 죽어 있었다.
 */
function encodeNeedle(s: string): string {
  return s.replace(/%/g, '%25').replace(/\|/g, '%7C').replace(/;/g, '%3B')
}
function decodeNeedle(s: string): string {
  return s.replace(/%7C/gi, '|').replace(/%3B/gi, ';').replace(/%25/g, '%')
}

export function buildVerifyProbeMark(p: { needles: string[]; host: string }): string {
  const needles = (p.needles ?? [])
    .map((n) => normalizeVerifyText(n))
    .filter((n) => n.length >= MIN_VERIFY_NEEDLE)
    .map(encodeNeedle)
    .slice(0, MAX_VERIFY_NEEDLES)
  const host = String(p.host ?? '').replace(/[|;\s]/g, '').trim().toLowerCase()
  if (!needles.length || !host) return ''
  return `${VERIFY_PROBE_MARK} 사이트=${host} ; 문구=${needles.join(' | ')}`
}

export function parseVerifyProbeMark(task: string): VerifyProbe | null {
  const t = String(task ?? '')
  const i = t.indexOf(VERIFY_PROBE_MARK)
  if (i < 0) return null
  const line = t.slice(i + VERIFY_PROBE_MARK.length).split(SEP_LINE)[0] ?? ''
  let host = ''
  let needles: string[] = []
  for (const seg of line.split(';')) {
    const x = seg.trim()
    if (x.startsWith('사이트=')) host = x.slice(4).trim().toLowerCase()
    else if (x.startsWith('문구=')) {
      needles = x.slice(3).split('|')
        .map((v) => normalizeVerifyText(decodeNeedle(v)))
        .filter((v) => v.length >= MIN_VERIFY_NEEDLE)
    }
  }
  if (!host || needles.length === 0) return null
  return { host, needles: needles.slice(0, MAX_VERIFY_NEEDLES) }
}

/**
 * 주어진 텍스트가 대조 문구를 담고 있는가 — **순수 판정**(호스트는 보지 않는다).
 *
 * 실제 근거 수집은 `page-actions.probeVerifyNeedles` 가 **페이지 안에서** 한다.
 * 여기서 하지 않는 이유: 화면 텍스트에는 **작성 중인 글**(contenteditable·textarea)이 섞여 있어,
 * 밖에서 통째로 받아 대조하면 "입력만 하고 안 올린 캡션" 을 게시 증거로 세게 된다.
 * 그 제외는 DOM 을 봐야만 할 수 있다.
 *
 * 그래서 이 함수는 **문구 대조 규칙 자체**(정규화·가장 구체적인 것 우선·발췌 범위)의 단일 정의로만
 * 쓴다 — 인페이지 스크립트가 같은 규칙을 구현하고, 이 함수는 그 규칙을 검사가 직접 확인하는 자리다.
 */
export function matchNeedleInText(
  needles: string[], text: string,
): { needle: string; snippet: string } | null {
  const hay = normalizeVerifyText(text)
  if (!hay) return null
  // 긴 것부터 본다 — 더 구체적인 근거를 남긴다.
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
    const at = hay.indexOf(needle)
    if (at < 0) continue
    const from = Math.max(0, at - 40)
    return { needle, snippet: hay.slice(from, at + needle.length + 40).trim().slice(0, 200) }
  }
  return null
}

/**
 * 기록된 근거가 **이번 게시**의 근거로 쓸 수 있는가.
 *
 * ## 왜 호스트·문구·시각만으로는 부족한가 (2026-09-19, 이 함수의 두 번째 판)
 *
 * 예전 판은 "같은 사이트에서 / 같은 캡션을 / 이번 확인 이후에 봤다" 셋만 봤다. 그 셋을 모두
 * 만족하면서도 **내가 방금 올린 글이 아닌** 화면이 둘 있다:
 *
 *  ① **같은 사이트의 남의 계정 글.** 확인 작업이 추천·탐색 화면이나 다른 사람 프로필에 있으면,
 *     같은 캡션(같은 해시태그·같은 유행 문구는 실제로 흔하다)을 가진 **남의 글**을 보고
 *     "내 게시가 확인됐다" 고 확정한다. 그 결론은 되돌릴 수 없다 — 워크플로가 `done` 으로 닫히고
 *     사용자는 올라가지도 않은 글을 올라간 것으로 안다.
 *  ② **같은 캡션을 가진 오래된 글.** 재시도·중복 게시 상황에서는 **지난번에 올린 같은 글**이
 *     목록에 남아 있다. 관찰 시각(`at`)은 방금이지만 **글 자체는 어제 것**이다. 이번 게시가
 *     실패했는데도 지난 글을 보고 성공으로 닫는다.
 *
 * 그래서 두 축을 더 본다 — **누가 썼는가**(글 영역 안에서 읽은 계정)와 **언제 올라갔는가**(글 자체의 시각).
 *
 * ## "거부" 와 "모름" 을 구분한다 (`uncertain`)
 *
 * 같지 않다는 것을 **확인한 것**(다른 계정·오래된 글)과, 화면에서 **읽지 못한 것**(계정 표기 없음·
 * 시각 없음·구조 모호)은 성격이 다르다. 둘 다 완료로 확정하지 않는 것은 같지만, 후자는
 * "아니다" 가 아니라 "모른다" 이므로 사용자에게 그렇게 말해야 한다(사람이 직접 보고 고르는 길로 간다).
 * 이 구분을 지우면 "안 올라갔다" 고 잘못 단정해 사용자가 **같은 글을 또 올린다**.
 *
 * ⚠ 작성자는 반드시 `authorScope === 'post'` — **글 영역 안에서 읽은 것**이어야 한다.
 *   화면 전체를 뒤져 찾은 이름은 증거가 아니다: 대부분의 사이트는 전역 막대에 **로그인한 내 계정**을
 *   항상 표시하므로, 남의 글 페이지에서도 내 이름이 발견된다. 그것을 증거로 세면 ①을 막지 못한다.
 */
export function sightingSupportsPublication(
  s: {
    url?: unknown; host?: unknown; needle?: unknown; at?: unknown
    author?: unknown; authorScope?: unknown; authorSource?: unknown
    postedAt?: unknown; postedAtText?: unknown; postedAtUnclear?: unknown; ambiguous?: unknown
  },
  expect: PublicationExpectation,
): { ok: boolean; reason: string; uncertain?: boolean } {
  const url = typeof s.url === 'string' ? s.url : ''
  const needle = normalizeVerifyText(typeof s.needle === 'string' ? s.needle : '')
  const at = typeof s.at === 'number' && Number.isFinite(s.at) ? s.at : 0
  if (!url || !needle) return { ok: false, reason: '근거가 비어 있음' }
  if (!verifyHostMatches(url, expect.host)) {
    return { ok: false, reason: `다른 사이트에서 본 것(${hostOfUrl(url) || '알 수 없음'} ≠ ${expect.host})` }
  }
  const want = expect.needles.map((n) => normalizeVerifyText(n))
  if (!want.includes(needle)) return { ok: false, reason: '지금 캡션과 다른 문구' }
  if (at < expect.notBefore) return { ok: false, reason: '이번 확인 이전에 기록된 오래된 근거' }

  // ── 여기서부터: 같은 사이트·같은 문구인 것은 맞다. 그런데 **누구의 어느 시점 글인가**. ──
  const ambiguous = typeof s.ambiguous === 'string' ? s.ambiguous.trim() : ''
  if (ambiguous) {
    return { ok: false, uncertain: true, reason: `화면 구조가 모호해 글 단위로 확인하지 못했습니다(${ambiguous})` }
  }

  // 언제 시도했는지 모르면 freshness 축이 **조용히 꺼진 채** 통과한다(`postedAt < -300000` 은 늘 거짓).
  // 호출자가 앞에서 막고 있더라도, 판정의 불변식은 판정 함수 자신이 들고 있어야 한다 —
  // 두 번째 호출자가 생기는 순간 새는 자리다.
  if (!(expect.attemptStartedAt > 0)) {
    return { ok: false, uncertain: true, reason: '이번 게시를 언제 시도했는지 기록이 없어 지난 글과 구분할 수 없습니다' }
  }

  const wantAccount = normalizeAccountName(expect.account)
  if (!wantAccount) {
    return {
      ok: false,
      uncertain: true,
      reason: '어느 계정으로 올리는지 설정돼 있지 않아 "내 글" 인지 대조할 수 없습니다(새 작업을 만들 때 "계정 아이디" 칸에 입력하면 자동 확인이 가능합니다)',
    }
  }
  // 계정 칸에 **표시 이름**(예: "내 인스타 계정")을 넣어 둔 사용자가 있다. 그런 값은 화면의 핸들과
  // 절대 같을 수 없어, 그대로 대조하면 **자기 글을 남의 글이라고 단정**한다(아래 8번의 위험과 같다).
  // 핸들 형태가 아니면 대조하지 않고 모른다고 말한다.
  if (!/^[a-z0-9._-]{2,30}$/.test(wantAccount)) {
    return {
      ok: false,
      uncertain: true,
      reason: `설정된 계정("${String(expect.account ?? '').trim()}")이 아이디 형태가 아니라 화면의 계정과 대조할 수 없습니다 — 표시 이름 대신 아이디(@ 없이)를 넣어 주세요`,
    }
  }

  const sawAccount = normalizeAccountName(s.author)
  if (!sawAccount || s.authorScope !== 'post') {
    return {
      ok: false,
      uncertain: true,
      reason: '글에서 작성자 계정을 읽지 못했습니다(화면 전체의 로그인 표기는 게시 증거가 아닙니다)',
    }
  }
  if (sawAccount !== wantAccount) {
    // ⚠ **불일치를 확정으로 말할지는 그 값을 얼마나 믿을 수 있는가에 달렸다.**
    //   휴리스틱(캡션 위의 `@이름`·프로필 링크)은 레이아웃에 따라 빗나갈 수 있다. 그런데 이 문구는
    //   사용자에게 그대로 보이고, "다른 계정의 글" 이라고 단정해 읽히면 사용자는 **"게시 안 됨"** 을
    //   눌러 차단을 풀고 **같은 글을 또 올린다** — 이 코드가 막으려던 바로 그 사고다.
    //   그래서 확정은 명시 표기에만 허용하고, 추정은 "읽은 값을 알려 주되 판단은 사람에게" 로 둔다.
    if (s.authorSource === 'structural') {
      return { ok: false, reason: `다른 계정의 글(@${sawAccount} ≠ @${wantAccount})` }
    }
    return {
      ok: false,
      uncertain: true,
      reason: `화면에서 읽은 작성자(@${sawAccount})가 설정한 계정(@${wantAccount})과 달라 보입니다 — 화면 구조에 따라 잘못 읽었을 수 있으니 직접 확인해 주세요`,
    }
  }

  const postedAt = typeof s.postedAt === 'number' && Number.isFinite(s.postedAt) ? s.postedAt : 0
  if (!(postedAt > 0)) {
    // 시각 표기가 **있었는데** 시간대가 없어 못 읽은 경우와, 아예 시각이 없던 경우를 구분해 말한다.
    // 전자는 사용자가 "왜 못 읽었나" 를 알아야 직접 확인하러 갈 수 있다.
    const unclear = typeof s.postedAtUnclear === 'string' ? s.postedAtUnclear.trim() : ''
    return { ok: false, uncertain: true, reason: unclear || '글이 언제 올라간 것인지 화면에서 읽지 못했습니다' }
  }
  // **미래 시각은 아직 올라가지 않은 글이다.** 틱톡·유튜브의 예약 게시 항목은 내 계정 표기·캡션·
  // 미래 `<time datetime>` 을 모두 갖춘 채 목록에 보인다. 위쪽 경계가 없으면 그것이 "완료" 근거가
  // 되어, **아무것도 공개되지 않았는데 워크플로가 닫힌다.**
  if (postedAt > Date.now() + PUBLICATION_CLOCK_SKEW_MS) {
    const when = typeof s.postedAtText === 'string' && s.postedAtText.trim() ? s.postedAtText.trim() : new Date(postedAt).toLocaleString('ko-KR')
    return { ok: false, uncertain: true, reason: `글의 시각이 미래입니다(${when}) — 예약된 글이거나 시각 표기가 다른 경우이니 직접 확인해 주세요` }
  }
  if (postedAt < expect.attemptStartedAt - PUBLICATION_CLOCK_SKEW_MS) {
    const when = typeof s.postedAtText === 'string' && s.postedAtText.trim()
      ? s.postedAtText.trim()
      : new Date(postedAt).toLocaleString('ko-KR')
    return { ok: false, reason: `이번 게시보다 오래된 글(${when}) — 같은 문구의 지난 게시로 보입니다` }
  }

  return { ok: true, reason: `@${sawAccount} 계정의 새 글에서 같은 문구를 확인` }
}
