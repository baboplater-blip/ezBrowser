"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.frameKey = frameKey;
exports.hostOf = hostOf;
exports.hostAllowed = hostAllowed;
exports.listObservationFrames = listObservationFrames;
exports.frameFromId = frameFromId;
exports.computeFrameOffset = computeFrameOffset;
exports.setRefRouting = setRefRouting;
exports.resolveRefRoute = resolveRefRoute;
exports.clearRefRouting = clearRefRouting;
const electron_1 = require("electron");
// ===== 교차 출처(cross-origin) 프레임 제어 =====
//
// 왜 필요한가: 관찰·조작 스크립트는 `wc.executeJavaScript` 로 **최상위 문서에서만** 돌았다. 같은 출처
// iframe 은 그 스크립트가 `contentDocument` 로 재귀해 들어가지만, 다른 출처 iframe 은 같은 출처 정책(SOP)
// 때문에 페이지 JS 로는 절대 들여다볼 수 없다. 그래서 로그인·결제·업로드 UI 가 iframe 인 사이트에서
// 에이전트는 "여기 프레임이 있는데 못 본다" 로 멈췄다.
//
// 그러나 **브라우저 메인 프로세스에는 그 제한이 없다.** Electron 의 WebFrameMain
// (https://www.electronjs.org/docs/latest/api/web-frame-main) 은 프레임 트리의 모든 프레임을 주고,
// `frame.executeJavaScript` 는 그 프레임의 문서 컨텍스트에서 직접 실행된다. SOP 는 "페이지 안의 JS 가
// 다른 출처 문서를 읽는 것" 을 막는 규칙이지, 브라우저 자신이 자기 프레임에 접근하는 것을 막는 규칙이 아니다.
// (웹 페이지 DOM 의 SOP 제한과 브라우저 메인 권한을 혼동하면 "구조상 불가" 라는 잘못된 결론이 나온다.)
//
// 보안·정책은 그대로 유지한다:
//   · webPreferences(sandbox·contextIsolation·webSecurity)는 건드리지 않는다 — 여기서 하는 일은
//     렌더러 권한 완화가 아니라, 메인 프로세스가 자기 프레임에 스크립트를 실행하는 것뿐이다.
//   · 허용 사이트(allowedHosts) 정책을 **자식 프레임에도 그대로** 적용한다. 허용 목록 밖 프레임은
//     스크립트를 아예 실행하지 않는다 — 그 안의 텍스트·요소가 모델 프롬프트로 한 글자도 가지 않는다.
//     (호스트 이름만 "여기 못 보는 프레임이 있다" 로 보고해, 사용자가 명시 승인으로 범위를 넓힐 수 있게 한다.)
const MAX_FRAME_DEPTH = 5; // 광고 프레임이 겹겹이 쌓인 페이지에서 무한 순회 방지
const MAX_OBSERVE_FRAMES = 6; // 한 관찰에서 스크립트를 돌릴 교차출처 프레임 상한(프롬프트 폭발 방지)
const MAX_BLOCKED_REPORT = 6;
function frameKey(frame) {
    return `${frame.processId}:${frame.routingId}`;
}
function originOf(u) {
    try {
        return new URL(u).origin;
    }
    catch {
        return '';
    }
}
function safeUrl(frame) {
    try {
        return frame.url;
    }
    catch {
        return '';
    }
}
function hostOf(u) {
    try {
        return new URL(u).hostname.toLowerCase();
    }
    catch {
        return '';
    }
}
// 허용 호스트 검사 — 사용자가 "이 사이트들에서만" 이라고 정한 범위를 코드로 강제한다.
// 프롬프트 지시만으로는 모델이 다른 사이트로 새는 것을 막을 수 없다. 최상위 이동(navigate/open_tab)과
// **자식 프레임 관찰** 이 같은 함수를 쓴다 — 규칙이 두 벌이면 한쪽만 조여지는 구멍이 생긴다.
function hostAllowed(url, allowed) {
    if (!allowed || allowed.length === 0)
        return true;
    const host = hostOf(url);
    if (!host)
        return false;
    return allowed.some((a) => {
        const want = String(a ?? '').trim().toLowerCase().replace(/^\*\./, '');
        if (!want)
            return false;
        return host === want || host.endsWith('.' + want);
    });
}
// 스크립트를 따로 돌려야 하는 프레임(= 부모 문서의 JS 로는 닿을 수 없는 프레임)만 고른다.
// 부모와 같은 출처인 프레임은 부모 관찰 스크립트가 이미 contentDocument 로 재귀해 들어갔으므로 제외한다.
function listObservationFrames(wc, allowedHosts) {
    const roots = [];
    const blocked = [];
    let main = null;
    try {
        main = wc.mainFrame;
    }
    catch {
        return { roots, blocked };
    }
    if (!main)
        return { roots, blocked };
    const seenBlockedHosts = new Set();
    const visit = (parent, depth) => {
        if (depth > MAX_FRAME_DEPTH || roots.length >= MAX_OBSERVE_FRAMES)
            return;
        let kids = [];
        try {
            kids = parent.frames;
        }
        catch {
            return;
        }
        const parentOrigin = originOf(safeUrl(parent));
        for (const k of kids) {
            if (roots.length >= MAX_OBSERVE_FRAMES)
                return;
            const url = safeUrl(k);
            const org = originOf(url);
            // 부모와 같은 출처 → 부모 스크립트가 이미 본다. 그 아래로만 계속 내려간다.
            if (org && parentOrigin && org === parentOrigin) {
                visit(k, depth + 1);
                continue;
            }
            // about:blank / about:srcdoc / data: 등은 부모 출처를 상속해 부모 JS 로 닿는다(또는 볼 내용이 없다).
            if (!/^https?:/i.test(url))
                continue;
            if (!hostAllowed(url, allowedHosts)) {
                // 허용 목록 밖 — 스크립트를 실행하지 않는다. 안의 텍스트는 모델로 가지 않고, 호스트만 보고한다.
                // 그 아래 자손도 보지 않는다(부모를 못 보는데 자식만 읽는 것은 정책 우회다).
                const h = hostOf(url);
                if (h && !seenBlockedHosts.has(h) && blocked.length < MAX_BLOCKED_REPORT) {
                    seenBlockedHosts.add(h);
                    blocked.push({ host: h, reason: 'not-allowed' });
                }
                continue;
            }
            roots.push({ id: frameKey(k), frame: k, url, host: hostOf(url), depth });
            visit(k, depth + 1);
        }
    };
    visit(main, 1);
    return { roots, blocked };
}
// id 로 프레임을 되찾는다. 프레임이 사라졌거나(detach) 다른 문서로 바뀌었으면 null 을 준다 —
// 실행 시점에 반드시 다시 확인해야 한다. 관찰 때의 핸들을 그대로 믿으면, 그 사이 프레임이 재로드된
// 화면에서 "옛 프레임의 번호" 로 지금 프레임의 다른 요소를 건드리게 된다.
function frameFromId(id, expectUrl) {
    const m = /^(\d+):(\d+)$/.exec(id);
    if (!m)
        return null;
    let f;
    try {
        f = electron_1.webFrameMain.fromId(Number(m[1]), Number(m[2]));
    }
    catch {
        return null;
    }
    if (!f)
        return null;
    try {
        if (f.detached === true)
            return null;
    }
    catch { /* 구버전엔 없음 */ }
    if (expectUrl != null) {
        const now = safeUrl(f);
        if (now !== expectUrl)
            return null;
    }
    return f;
}
// ===== 프레임 좌표 오프셋 =====
// 실제 입력(sendInputEvent)의 좌표는 **최상위 뷰포트 기준**이다. 프레임 안 요소의 rect 는 그 프레임 기준이므로,
// 조상 체인을 따라 <iframe> 요소의 위치를 더해야 진짜 클릭 지점이 나온다.
//
// 자식 프레임과 부모 문서의 <iframe> 요소를 짝짓는 방법: 부모 JS 에서 `iframe.contentWindow === window.frames[i]`
// 로 **참조 동일성**을 비교한다. 이건 교차 출처에서도 허용된다(속성을 읽는 게 아니라 같은 객체인지만 본다).
// window.frames 의 순서와 WebFrameMain.frames 의 순서는 둘 다 프레임 트리 자식 순서라 일치한다 —
// 다만 그 가정을 맹신하지 않고, **개수가 다르면 정렬을 신뢰할 수 없다고 보고 좌표를 포기**한다(null).
const CHILD_RECTS_SCRIPT = (scrollIdx) => `
(function(){
  var els=[]; try{ els = Array.prototype.slice.call(document.querySelectorAll('iframe, frame')); }catch(e){}
  var n=0; try{ n = window.frames.length; }catch(e){ n = 0; }
  var out=[];
  for(var i=0;i<n;i++){
    var w=null; try{ w=window.frames[i]; }catch(e){}
    var el=null;
    for(var j=0;j<els.length;j++){ try{ if(els[j].contentWindow===w){ el=els[j]; break; } }catch(e){} }
    if(!el){ out.push(null); continue; }
    if(i===${scrollIdx}){ try{ el.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'}); }catch(e){} }
    var r=null; try{ r=el.getBoundingClientRect(); }catch(e){}
    if(!r){ out.push(null); continue; }
    var cs=null; try{ cs=getComputedStyle(el); }catch(e){}
    var bl=cs?(parseFloat(cs.borderLeftWidth)||0):0, bt=cs?(parseFloat(cs.borderTopWidth)||0):0;
    var pl=cs?(parseFloat(cs.paddingLeft)||0):0, pt=cs?(parseFloat(cs.paddingTop)||0):0;
    out.push({ x: r.left+bl+pl, y: r.top+bt+pt, w: r.width, h: r.height });
  }
  return { count: n, rects: out };
})()
`;
async function computeFrameOffset(frame, opts) {
    // 조상 체인을 모은다(최상위 → … → frame).
    const chain = [];
    let cur = frame;
    let guard = 0;
    while (cur && guard++ < MAX_FRAME_DEPTH + 2) {
        let p = null;
        try {
            p = cur.parent;
        }
        catch {
            p = null;
        }
        if (!p)
            break;
        let kids = [];
        try {
            kids = p.frames;
        }
        catch {
            return null;
        }
        const target = cur;
        const idx = kids.findIndex((f) => f.processId === target.processId && f.routingId === target.routingId);
        if (idx < 0)
            return null;
        chain.unshift({ parent: p, index: idx });
        cur = p;
    }
    if (chain.length === 0)
        return { x: 0, y: 0 }; // 최상위 프레임 자신
    let x = 0, y = 0;
    for (let i = 0; i < chain.length; i++) {
        const link = chain[i];
        let res = null;
        try {
            res = (await link.parent.executeJavaScript(CHILD_RECTS_SCRIPT(opts?.scrollIntoView ? link.index : -1), true));
        }
        catch {
            return null;
        }
        if (!res || !Array.isArray(res.rects))
            return null;
        // 정렬 신뢰 검사 — 부모가 보는 자식 브라우징 컨텍스트 개수와 프레임 트리의 자식 개수가 같아야
        // index 로 짝지을 수 있다. 다르면 조용히 틀린 좌표를 쓰는 대신 좌표를 포기한다.
        let kidCount = 0;
        try {
            kidCount = link.parent.frames.length;
        }
        catch {
            return null;
        }
        if (res.count !== kidCount)
            return null;
        const r = res.rects[link.index];
        if (!r)
            return null;
        x += r.x;
        y += r.y;
    }
    return { x: Math.round(x), y: Math.round(y) };
}
const routing = new Map();
const ROUTE_KEEP = 12;
function setRefRouting(epoch, slots) {
    routing.set(epoch, slots);
    while (routing.size > ROUTE_KEEP) {
        const oldest = routing.keys().next();
        if (oldest.done)
            break;
        routing.delete(oldest.value);
    }
}
function resolveRefRoute(epoch, ref) {
    if (!epoch)
        return null;
    const slots = routing.get(epoch);
    if (!slots)
        return null;
    for (const s of slots) {
        if (ref >= s.base && ref < s.base + s.count) {
            return { frameId: s.frameId, frameUrl: s.frameUrl, localRef: ref - s.base };
        }
    }
    return null;
}
// 테스트·정리용
function clearRefRouting() { routing.clear(); }
