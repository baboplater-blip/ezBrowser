"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectChallenge = detectChallenge;
exports.challengeKey = challengeKey;
function urlKey(url) {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    }
    catch {
        return String(url ?? '');
    }
}
/**
 * 관찰 결과에서 로그인/CAPTCHA 화면을 판정한다. 해당 없으면 null.
 *
 * @param resolved 사용자가 이미 처리했다고 알려 준 화면들의 키(`kind:origin+path`). 같은 화면에서
 *                 계속 다시 묻지 않기 위한 것 — 사용자가 "계속" 이라고 하면 호출부가 여기에 넣는다.
 */
function detectChallenge(obs, resolved) {
    const candidates = [];
    if (obs.challenge)
        candidates.push({ sig: obs.challenge });
    for (const f of obs.frames ?? []) {
        if (f.challenge)
            candidates.push({ sig: f.challenge, frameHost: f.host });
    }
    if (candidates.length === 0)
        return null;
    // CAPTCHA 를 로그인보다 먼저 — 로그인 화면 위에 CAPTCHA 가 함께 있으면 더 막힌 쪽을 말해 준다.
    candidates.sort((a, b) => (a.sig.kind === 'captcha' ? -1 : 0) - (b.sig.kind === 'captcha' ? -1 : 0));
    for (const c of candidates) {
        const key = `${c.sig.kind}:${urlKey(obs.url)}${c.frameHost ? `@${c.frameHost}` : ''}`;
        if (resolved?.has(key))
            continue;
        const where = c.frameHost ? ` (프레임 ${c.frameHost})` : '';
        if (c.sig.kind === 'captcha') {
            return {
                kind: 'captcha',
                key,
                frameHost: c.frameHost,
                reason: `사람 확인(CAPTCHA) 화면입니다${where}. 자동으로 풀지 않습니다 — 브라우저 창에서 직접 완료해 주신 뒤 "계속" 이라고 알려주세요.`,
                evidence: c.sig.marker,
            };
        }
        return {
            kind: 'login',
            key,
            frameHost: c.frameHost,
            reason: `로그인이 필요한 화면입니다${where}. 비밀번호는 대신 입력하지 않습니다 — 브라우저 창에서 직접 로그인하신 뒤 "계속" 이라고 알려주세요.`,
            evidence: c.sig.marker,
        };
    }
    return null;
}
/** 해당 화면을 "사용자가 처리했다" 로 표시할 때 쓰는 키 — detectChallenge 의 key 와 같은 규칙. */
function challengeKey(kind, url, frameHost) {
    return `${kind}:${urlKey(url)}${frameHost ? `@${frameHost}` : ''}`;
}
