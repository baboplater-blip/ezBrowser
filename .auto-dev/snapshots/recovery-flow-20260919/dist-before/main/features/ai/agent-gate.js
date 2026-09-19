"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENGAGE_MARK_PREFIX = exports.COMPLETION_MARK = exports.NO_PUBLISH_MARK = void 0;
exports.registerTrustedJs = registerTrustedJs;
exports.isTrustedJs = isTrustedJs;
exports.buildCompletionMark = buildCompletionMark;
exports.parseCompletionMark = parseCompletionMark;
exports.isNoPublishTask = isNoPublishTask;
exports.isPublishAction = isPublishAction;
exports.looksPublished = looksPublished;
exports.detectInjection = detectInjection;
exports.looksLikeInstruction = looksLikeInstruction;
exports.isRiskyUrl = isRiskyUrl;
exports.assessRisk = assessRisk;
exports.buildEngageMark = buildEngageMark;
exports.parseEngageMark = parseEngageMark;
exports.classifyEngageClick = classifyEngageClick;
const NONE = { level: 'none', reason: '' };
// ===== 위험 어휘 =====
// 돈 계열. "구독"(유튜브 구독 등 무료)·"게시/발행/공유"는 의도적으로 제외 — 오탐이 자동 발행을 막는다.
const MONEY_RE = /결제|결재|구매|구입|주문하기|바로\s*구매|장바구니\s*주문|송금|이체|출금|충전|후원|선물하기|유료\s*전환|환불|청구|카드\s*등록|payment|checkout|purchase|\bpay now\b|\bpay\b|paypal|\bbilling\b|place order/i;
// 데이터·계정 파괴 계열. "지우기·초기화"는 검색어 지우기·필터 초기화 오탐이 많아 제외.
const DESTRUCTIVE_RE = /삭제|영구\s*삭제|탈퇴|회원\s*탈퇴|해지|구독\s*취소|비활성화|\bdelete\b|\bdeactivate\b|close account|\bunsubscribe\b|\bwithdraw\b/i;
// 계정 이탈 — 되돌릴 수 있으나 세션을 잃어 자동화가 중단된다(confirm).
const LOGOUT_RE = /로그아웃|sign\s?out|log\s?out/i;
// 카드·주민·계좌 등 민감 입력 필드(라벨 기준) — 여기에 타이핑하는 것은 금전 위험.
const PII_FIELD_RE = /카드\s*번호|card\s*number|\bcvc\b|\bcvv\b|보안\s*코드|유효\s*기간|expiry|주민\s*(등록)?\s*번호|계좌\s*번호|account\s*number/i;
// 카드번호 형태의 값(16자리 등) — 입력 텍스트 자체로 판정(키워드 오탐 없이 정확).
const CARD_NUMBER_RE = /\b(?:\d[ -]?){13,19}\b/;
// 결제·삭제성 URL — navigate/open_tab 게이트 + "지금 페이지가 위험한가" 컨텍스트 판정 둘 다에 쓴다.
const RISKY_URL_RE = /checkout|\/pay(ment)?(\/|$|\?)|\bbilling\b|purchase|order\/(confirm|payment)|결제|송금|이체|withdraw|unsubscribe|delete[-_]?account|account\/(delete|close)|탈퇴|해지/i;
// 한국 PG·해외 결제 위젯 호스트 — cross-origin iframe 이라 내용을 볼 수 없으므로 좌표 클릭 시 보수 판정.
const PAY_HOST_RE = /(toss|tosspayments|kakaopay|naverpay|payco|nicepay|inicis|kcp|danal|payple|eximbay|smilepay|paypal|stripe|adyen|braintree)/i;
// 임의 JS 가 "되돌릴 수 없는 일"을 하는가 — 키워드가 아니라 코드가 하는 행위로 판정.
// (클릭·폼 제출·이동·네트워크 전송). 순수 조회(querySelector + 텍스트 반환)는 none.
const JS_EFFECT_RE = /\.click\s*\(|\.submit\s*\(|requestSubmit|location\s*\.\s*(href|assign|replace)|location\s*=|window\.open|\bfetch\s*\(|XMLHttpRequest|sendBeacon|document\.forms|\.remove\s*\(|removeChild/i;
// 위험 판정에서 아예 제외되는 행동(페이지를 바꾸지 않음).
// request_scope 는 그 자체로 페이지를 바꾸지 않고, 별도의 사용자 승인 창을 띄우는 동작이라 여기서는 무해로 둔다
// (승인 없이는 아무 것도 넓어지지 않는다). select 는 페이지 상태를 바꾸므로 **여기 없다** — 라벨 기반 위험 판정을 받는다.
const HARMLESS = new Set(['scroll', 'read', 'wait', 'wait_for', 'done', 'ask', 'note', 'report', 'remember', 'extract', 'hover', 'switch_tab', 'close_tab', 'request_scope']);
// ===== 신뢰 레시피(우리 제품이 생성한 JS) =====
// 블로그 발행 브릿지처럼 앱이 직접 만든 JS 는 내용이 검증돼 있으므로 게이트를 면제한다.
// LLM 이 스스로 작성한 JS 만 게이트를 받도록 해, "클릭 게이트를 run_js 로 우회"하는 경로를 막는다.
// 문자열 완전 일치로만 인정 — 한 글자라도 바뀌면 신뢰하지 않는다(변조 방지).
const trustedJs = new Map();
const TRUSTED_TTL_MS = 60 * 60 * 1000;
function registerTrustedJs(code) {
    const c = (code ?? '').trim();
    if (!c)
        return;
    const now = Date.now();
    for (const [k, t] of trustedJs)
        if (now - t > TRUSTED_TTL_MS)
            trustedJs.delete(k);
    trustedJs.set(c, now);
}
function isTrustedJs(code) {
    const c = (code ?? '').trim();
    const t = trustedJs.get(c);
    if (t === undefined)
        return false;
    if (Date.now() - t > TRUSTED_TTL_MS) {
        trustedJs.delete(c);
        return false;
    }
    return true;
}
// ===== 게시(발행) 인식 =====
// 게시는 확인 게이트 대상이 아니지만(정상 작업), "이미 게시된 뒤 또 누르는 것"은 중복 게시라 막아야 한다.
// 그래서 위험 판정과 별개로 "이 클릭이 게시성인가"를 알아본다.
// "게시" 단독은 발행 버튼(유튜브 "게시")이지만, "게시물"·"게시 예약"·"게시물 미리보기" 는 아니다 — 인스타의 메뉴
// "새로운 게시물 만들기"·"게시물" 이 발행성으로 오인돼 draft 모드에서 차단되던 결함(실사이트 파일럿 2026-09-13).
const PUBLISH_RE = /발행|게시(?!\s*(물|예약|미리|정책))|등록하기|올리기|업로드하기|공유하기|공유$|저장하기|publish|post now|share$|submit post|upload$/i;
// 게시 완료 신호 — 화면에 이런 문구가 뜨거나 URL 이 글 주소로 바뀌면 발행이 끝난 것으로 본다.
const PUBLISHED_TEXT_RE = /발행(이|되)?\s*(완료|되었|됐)|게시(가|되|물이)?\s*(완료|되었|됐|공유되었)|공유(가|되)?\s*(완료|되었|됐)|등록(이|되)?\s*(완료|되었|됐)|성공적으로\s*(발행|게시|등록)|published|posted successfully|your post is live|has been shared/i;
// 작업 지시에 이 표식이 있으면 발행성 클릭을 코드로 차단한다(임시저장·입력만 모드).
// 프롬프트 지시만으로는 "저장" 대신 "발행" 오클릭을 막을 수 없다.
exports.NO_PUBLISH_MARK = '[모드: 발행 금지]';
exports.COMPLETION_MARK = '[완료 신호]';
const SEP_LINE = String.fromCharCode(10);
function buildCompletionMark(sig) {
    const parts = [];
    const texts = (sig.texts ?? []).map((t) => String(t).replace(/[|;]/g, ' ').trim()).filter(Boolean);
    if (texts.length)
        parts.push('문구=' + texts.join(' | '));
    if (sig.urlContains)
        parts.push('URL=' + String(sig.urlContains).replace(/[;]/g, '').trim());
    if (sig.message)
        parts.push('메시지=' + String(sig.message).replace(/[;]/g, ' ').trim());
    return `${exports.COMPLETION_MARK} ${parts.join(' ; ')}`;
}
function parseCompletionMark(task) {
    const t = String(task ?? '');
    const i = t.indexOf(exports.COMPLETION_MARK);
    if (i < 0)
        return null;
    const line = t.slice(i + exports.COMPLETION_MARK.length).split(SEP_LINE)[0] ?? '';
    const sig = { texts: [] };
    for (const seg of line.split(';')) {
        const x = seg.trim();
        if (x.startsWith('문구='))
            sig.texts = x.slice(3).split('|').map((v) => v.trim()).filter(Boolean);
        else if (x.startsWith('URL='))
            sig.urlContains = x.slice(4).trim() || undefined;
        else if (x.startsWith('메시지='))
            sig.message = x.slice(4).trim() || undefined;
    }
    return sig.texts.length || sig.urlContains ? sig : null;
}
function isNoPublishTask(task) {
    return String(task ?? '').includes(exports.NO_PUBLISH_MARK);
}
function isPublishAction(label) {
    return PUBLISH_RE.test(label ?? '');
}
function looksPublished(pageText) {
    return PUBLISHED_TEXT_RE.test(pageText ?? '');
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
    '"action"\\s*:', // 페이지 안에 우리 액션 JSON 을 심어 행동을 지시하는 시도
    'new\\s+instructions?\\s*:',
    '새로운?\\s*지시\\s*:',
].join('|'), 'i');
function detectInjection(text) {
    if (!text)
        return false;
    return INJECTION_RE.test(text);
}
// 기억(remember)에 저장하려는 내용이 "사실"이 아니라 "지시"인가.
// 1회 인젝션이 영구 기억에 들어가면 이후 모든 세션의 시스템 프롬프트를 오염시키는 백도어가 된다.
const MEMORY_INSTRUCTION_RE = new RegExp([
    '무시하',
    '하세요|해라|하라|해야\\s*한다|반드시\\s*\\S+하', // 한글 뒤 \\b 금지(위 주석 참고)
    '앞으로\\s*(모든|항상)',
    'always\\s+\\w+|must\\s+\\w+|never\\s+\\w+',
    'ignore|instruction',
    'https?://', // 기억에 심어진 링크 = 이후 세션에 피싱 유도
    '"action"\\s*:|run_js|navigate',
].join('|'), 'i');
function looksLikeInstruction(text) {
    if (!text)
        return false;
    return MEMORY_INSTRUCTION_RE.test(text);
}
function classifyLabel(label) {
    if (MONEY_RE.test(label))
        return { level: 'critical', reason: '금전 관련 동작(결제·송금·충전)' };
    if (DESTRUCTIVE_RE.test(label))
        return { level: 'critical', reason: '삭제·탈퇴 등 되돌릴 수 없는 동작' };
    if (LOGOUT_RE.test(label))
        return { level: 'confirm', reason: '로그아웃(세션이 끊겨 자동화가 중단됨)' };
    return NONE;
}
function isRiskyUrl(url) {
    return RISKY_URL_RE.test(url ?? '');
}
function assessRisk(action, obs, ctx) {
    if (HARMLESS.has(action.action))
        return NONE;
    const pageRisky = isRiskyUrl(ctx.pageUrl);
    // 이동류(navigate/open_tab) — 목적지 URL 자체로 판정. open_tab 도 navigate 와 동일하게 검사한다
    // (예전에는 open_tab 이 게이트를 통째로 우회했다).
    if (action.action === 'navigate' || action.action === 'open_tab') {
        const u = action.url ?? '';
        if (MONEY_RE.test(u))
            return { level: 'critical', reason: '결제성 주소로 이동' };
        if (DESTRUCTIVE_RE.test(u) || /delete[-_]?account|account\/(delete|close)|unsubscribe/i.test(u)) {
            return { level: 'critical', reason: '삭제·탈퇴성 주소로 이동' };
        }
        return NONE;
    }
    // 대상 라벨 — click_at 은 좌표 조사 결과, 나머지는 관찰된 요소.
    const el = obs.elements.find((e) => e.ref === action.ref);
    const label = action.action === 'click_at'
        ? (ctx.clickAtLabel ?? '')
        : `${el?.name ?? ''} ${el?.type ?? ''}`;
    const byLabel = classifyLabel(label);
    if (byLabel.level !== 'none')
        return byLabel;
    // 임의 JS 실행 — 앱이 만든 신뢰 레시피가 아니면, 효과를 내는 코드는 확인을 받는다.
    if (action.action === 'run_js') {
        const code = action.code ?? '';
        if (isTrustedJs(code))
            return NONE;
        if (MONEY_RE.test(code) || DESTRUCTIVE_RE.test(code)) {
            return { level: 'critical', reason: 'JS 로 결제·삭제성 동작 실행' };
        }
        if (JS_EFFECT_RE.test(code)) {
            return pageRisky
                ? { level: 'critical', reason: '결제·삭제성 페이지에서 JS 로 클릭·제출·전송' }
                : { level: 'confirm', reason: 'JS 로 클릭·제출·이동·네트워크 전송' };
        }
        return NONE;
    }
    // 저장된 개인정보 자동 채우기 — 어떤 사이트에 무엇을 흘리는지 사용자가 알아야 한다.
    if (action.action === 'autofill') {
        let host = '';
        try {
            host = new URL(ctx.pageUrl).hostname;
        }
        catch {
            host = '이 사이트';
        }
        return { level: 'confirm', reason: `저장된 내 정보를 ${host} 폼에 채웁니다` };
    }
    // 입력 — 카드번호 형태의 값이나 카드·주민·계좌 필드는 금전 위험.
    if (action.action === 'type') {
        if (PII_FIELD_RE.test(label))
            return { level: 'critical', reason: '카드·주민·계좌 등 민감 필드 입력' };
        if (CARD_NUMBER_RE.test(action.text ?? ''))
            return { level: 'critical', reason: '카드번호 형태의 값 입력' };
    }
    // 키 입력 — ref 없는 Enter 는 "지금 포커스된 무언가를 제출"이라 대상 확인이 불가능하다.
    if (action.action === 'key') {
        const k = (action.key ?? '').toLowerCase();
        const submitish = k === 'enter' || k === 'return' || k === 'numpadenter';
        const destructive = /(^|\+)(delete|backspace)$/.test(k);
        if (submitish) {
            if (pageRisky)
                return { level: 'critical', reason: '결제·삭제성 페이지에서 Enter 제출' };
            if (!el)
                return { level: 'confirm', reason: '대상을 알 수 없는 Enter 제출(포커스된 폼이 제출됨)' };
            if (el.type === 'submit')
                return { level: 'confirm', reason: '폼 제출' };
        }
        if (destructive && pageRisky)
            return { level: 'critical', reason: '결제·삭제성 페이지에서 삭제 키' };
    }
    // click_at — 좌표만 알고 대상은 모른다. 내용을 볼 수 없는 외부 프레임(결제 위젯)은 보수적으로.
    if (action.action === 'click_at' && !label.trim()) {
        const src = ctx.clickAtFrameSrc ?? '';
        if (ctx.clickAtTag === 'IFRAME' && (PAY_HOST_RE.test(src) || isRiskyUrl(src))) {
            return { level: 'critical', reason: '외부 결제 프레임 클릭(내용 확인 불가)' };
        }
        if (ctx.clickAtTag === 'IFRAME' && pageRisky) {
            return { level: 'critical', reason: '결제·삭제성 페이지의 외부 프레임 클릭(내용 확인 불가)' };
        }
    }
    // 페이지 컨텍스트 자체가 위험하면(결제·탈퇴 화면) 그 위에서의 조작은 라벨과 무관하게 확인을 받는다.
    // — 아이콘·이미지 버튼처럼 라벨이 없는 결제 확정 버튼을 잡아내는 마지막 그물.
    if (pageRisky && (action.action === 'click' || action.action === 'click_at' || action.action === 'type' || action.action === 'key' || action.action === 'drag')) {
        return { level: 'confirm', reason: '결제·삭제성 페이지에서의 조작' };
    }
    return NONE;
}
// ===== 참여 가드 (블로그 댓글·좋아요) =====
//
// 왜 필요한가: 중복 방지를 **지시문으로만** 하면 지켜지지 않는다. 실측(2026-09-18 하네스)에서
// 같은 글에 댓글이 두 번 달렸고, 이미 눌린 좋아요를 다시 눌러 **취소**됐고, 초안 모드인데도
// 댓글이 등록됐다. 장부에 기록만 하고 **행동을 막지 않으면** 그건 방지가 아니다.
//
// 그래서 발행 금지 표식(NO_PUBLISH_MARK)과 같은 방식으로 작업 지시문에 표식을 싣고,
// 에이전트 루프가 **클릭 직전에 코드로** 막는다.
exports.ENGAGE_MARK_PREFIX = '[참여 가드]';
function intField(line, name) {
    const m = new RegExp(`${name}=(\\d{1,15})`).exec(line);
    const v = m ? Number(m[1]) : 0;
    return Number.isFinite(v) && v > 0 ? v : 0;
}
function buildEngageMark(g) {
    const acts = [g.comment ? 'comment' : '', g.like ? 'like' : ''].filter(Boolean).join(',');
    // 계정 이름에 줄바꿈·파이프가 들어가면 파싱이 깨지므로 제거한다.
    const acc = String(g.account ?? '').replace(/[|\r\n]/g, ' ').trim().slice(0, 120);
    // guardId 는 파싱이 흔들리지 않게 영숫자·하이픈만 남긴다.
    const gid = String(g.guardId ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
    const nums = [
        gid ? `id=${gid}` : '',
        g.limit > 0 ? `limit=${Math.floor(g.limit)}` : '',
        g.intervalMs > 0 ? `interval=${Math.floor(g.intervalMs)}` : '',
        g.until > 0 ? `until=${Math.floor(g.until)}` : '',
    ].filter(Boolean).join(' ');
    return `${exports.ENGAGE_MARK_PREFIX} account=${acc} mode=${g.mode} actions=${acts}${nums ? ` ${nums}` : ''}`;
}
function parseEngageMark(task) {
    const line = String(task ?? '').split('\n').find((l) => l.includes(exports.ENGAGE_MARK_PREFIX));
    if (!line)
        return null;
    const acc = /account=([^\n]*?)\s+mode=/.exec(line)?.[1] ?? '';
    const mode = /mode=(draft|act)/.exec(line)?.[1] === 'act' ? 'act' : 'draft';
    const acts = (/actions=([a-z,]*)/.exec(line)?.[1] ?? '').split(',');
    return {
        account: acc.trim(),
        mode,
        comment: acts.includes('comment'),
        like: acts.includes('like'),
        guardId: /\bid=([A-Za-z0-9-]{1,64})/.exec(line)?.[1] ?? '',
        limit: intField(line, 'limit'),
        intervalMs: intField(line, 'interval'),
        until: intField(line, 'until'),
    };
}
// 클릭 라벨 분류. **취소를 먼저 본다** — "좋아요 취소" 는 좋아요가 아니라 취소다(순서를 뒤집으면
// 이미 눌린 좋아요를 다시 눌러 풀어 버린다).
const UNLIKE_RE = /(좋아요|공감|like)\s*(취소|해제)|(취소|해제)\s*(좋아요|공감)|unlike/i;
const LIKE_RE = /좋아요|공감|\blike\b|추천/i;
// 댓글 "등록" 동사가 함께 있을 때만 제출로 본다 — 그냥 "댓글" 이라는 글자는 목록 제목에도 흔하다.
const COMMENT_SUBMIT_RE = /(댓글|덧글|리플|comment|reply)[^\n]{0,12}(등록|작성|남기|올리|달기|게시|보내|submit|post|send)|(등록|작성|남기|올리|달기)[^\n]{0,8}(댓글|덧글)/i;
function classifyEngageClick(label) {
    const s = String(label ?? '');
    if (!s)
        return null;
    if (UNLIKE_RE.test(s))
        return 'unlike';
    if (COMMENT_SUBMIT_RE.test(s))
        return 'comment';
    if (LIKE_RE.test(s))
        return 'like';
    return null;
}
