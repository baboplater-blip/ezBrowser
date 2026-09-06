import { type WebContents } from 'electron'
import path from 'node:path'

// 에이전트의 눈과 손 — 페이지를 관찰(observe)하고 행동(execute)한다.
// 콘텐츠 페이지 컨텍스트에서 executeJavaScript 로 실행(제스처·번역·리더와 동일 패턴).
// 관찰 시 상호작용 요소를 페이지 컨텍스트의 레지스트리에 담아(DOM 은 수정하지 않음), 실행 때 그 번호로 집는다.

export interface ObservedElement {
  ref: number
  tag: string       // a / button / input / select / textarea / [role]
  type: string      // input type, 또는 role
  name: string      // 접근성 이름(텍스트·aria-label·placeholder·value·title)
  value?: string
  // 선택·활성 상태 — 이게 없으면 "공개/비공개", "아동용 여부" 같은 라디오가 지금 무엇으로 선택돼 있는지
  // 알 수 없어, 기본값(공개)인 채로 게시되는 사고가 난다. aria-disabled 버튼도 여기서 구분한다.
  state?: 'disabled' | 'checked' | 'unchecked'
}

export interface PageObservation {
  url: string
  title: string
  text: string           // 본문 스니펫(잘림)
  elements: ObservedElement[]
  scroll: { y: number; maxY: number }
  truncated: boolean
  // 업로드·인코딩 진행 상태(progressbar·"업로드 중 45%" 류). 영상 업로드에서 "다 됐는지"를
  // 본문 스니펫 운에 맡기지 않고 구조적으로 알려준다 — 미완 상태 게시 방지.
  progress?: string
  // 반복 구조(목록) 감지 — extract 의 rowSelector 후보 + 첫 항목 안의 필드(하위 선택자) 후보
  listHint?: { rowSelector: string; count: number; fields?: Array<{ sel: string; sample: string; attr?: string }> }
}

export interface AgentAction {
  thought?: string
  action: 'click' | 'type' | 'navigate' | 'scroll' | 'read' | 'wait' | 'done' | 'ask' | 'open_tab' | 'switch_tab' | 'close_tab' | 'remember' | 'upload_file' | 'click_at' | 'extract'
    | 'wait_for' | 'key' | 'hover' | 'drag' | 'download' | 'run_js' | 'autofill' | 'note' | 'report'
  ref?: number
  text?: string
  url?: string
  index?: number         // switch_tab 대상 탭 번호
  direction?: 'up' | 'down'
  message?: string
  submit?: boolean       // type 후 Enter 로 제출
  name?: string          // upload_file: 지정 폴더 안 파일 이름
  xPct?: number          // click_at / drag: 화면 가로의 0~100 (%)
  yPct?: number          // click_at / drag: 화면 세로의 0~100 (%)
  rowSelector?: string   // extract: 반복 항목 CSS 선택자
  fields?: Record<string, string>            // extract: { 열이름: 선택자(@attr 지원) }
  rows?: Array<Record<string, unknown>>      // extract: 직접 제공한 데이터 행들
  selector?: string      // wait_for: 나타나길 기다릴 CSS 선택자
  timeout?: number       // wait_for: 최대 대기(ms)
  key?: string           // key: 키/조합 (예 "Enter","Tab","Control+a")
  code?: string          // run_js: 실행할 자바스크립트
  toRef?: number         // drag: 목적지 요소 번호
  toXPct?: number        // drag: 목적지 가로 %
  toYPct?: number        // drag: 목적지 세로 %
  title?: string         // report: 보고서 제목
  markdown?: string      // report: 개요·핵심 결론(본문은 누적 note 로 조립)
}

// ===== ref 레지스트리 (DOM 을 건드리지 않는 요소 참조) =====
// 예전에는 관찰할 때마다 요소에 data-bb-agent-ref 속성을 달았다. 그러나 인스타·페북 등은 MutationObserver 로
// 자기 DOM 변화를 상시 감시하므로, 매 단계 수십 개 속성이 붙었다 지워지는 패턴은 그 자체로 자동화 지문이었다
// (`document.querySelector('[data-bb-agent-ref]')` 한 줄이면 탐지). 이제 DOM 을 전혀 수정하지 않고,
// 페이지 JS 컨텍스트의 배열에 요소 참조를 담아 번호로 집는다 — 속성 변경 0, MutationObserver 에 아무것도 안 잡힌다.
// 전역 키는 실행마다 무작위라 페이지가 이름을 하드코딩해 탐지할 수도 없다.
const REF_KEY = '__' + Math.random().toString(36).slice(2, 10)

// 집기 — 번호로 요소를 꺼내되, 그 사이 화면이 바뀌었는지 검증한다.
// 가상 스크롤(피드)은 DOM 노드를 재활용하므로, 관찰 때 본 이름과 지금 이름이 다르면 다른 항목이 된 것이다.
// 그대로 클릭하면 엉뚱한 게시물에 좋아요·신고를 누르게 되므로 null 을 돌려 재관찰을 유도한다.
const PICK_FN = `function pick(r){var A=window['${REF_KEY}'];if(!A)return null;var it=A[r];if(!it||!it.e)return null;var el=it.e;`
  + `try{if(!el.isConnected)return null;}catch(e){}`
  + `if(it.n){var cur='';try{cur=((el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.value||'')+'').replace(/\\s+/g,' ').trim();}catch(e){cur='';}`
  + `var a=it.n.slice(0,20),b=cur.slice(0,20);if(a&&b&&a!==b)return null;}`
  + `return el;}`

// 요소가 same-origin iframe 안에 있으면 getBoundingClientRect 는 그 iframe 뷰포트 기준이다. sendInputEvent
// (마우스 이동·드래그)는 top 창 좌표를 쓰므로, 조상 iframe 들의 뷰포트 오프셋을 누적해 top 창 좌표로 변환한다.
const FRAME_OFFSET_FN = `function frameOffset(el){var ox=0,oy=0;var win=(el.ownerDocument&&el.ownerDocument.defaultView)||window;var g=0;while(win&&win!==win.top&&g++<10){var fe=null;try{fe=win.frameElement;}catch(e){break;}if(!fe)break;var fr=fe.getBoundingClientRect();ox+=fr.left;oy+=fr.top;win=(fe.ownerDocument&&fe.ownerDocument.defaultView)||null;}return {ox:ox,oy:oy};}`

// 조건부 대기 — 선택자가 매칭되거나 텍스트가 나타날 때까지(동적 페이지·AJAX·SPA 대응). 인페이지 Promise 로 폴링.
export async function waitForOnPage(wc: WebContents, spec: { selector?: string; text?: string; timeout?: number }): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: 'tab destroyed' }
  const sel = JSON.stringify(spec.selector ?? '')
  const txt = JSON.stringify(spec.text ?? '')
  // 상한 5분 — 영상 업로드·인코딩 완료를 한 번의 대기로 기다릴 수 있어야 한다(예전 60초 상한은
  // 수 분짜리 처리를 기다리려면 대기를 여러 번 반복해야 해서 단계만 소진됐다).
  const timeout = Math.max(500, Math.min(300_000, Math.round(spec.timeout ?? 10000)))
  try {
    return (await wc.executeJavaScript(`
(function(){
  var sel = ${sel}, txt = ${txt}, deadline = Date.now() + ${timeout};
  // same-origin iframe 안까지 뚫어서 찾는다(네이버·티스토리 등 에디터는 iframe 안에 필드가 있다).
  function inRoot(root){
    try {
      if (sel && root.querySelector(sel)) return true;
      if (txt && ((root.body && root.body.innerText || root.documentElement && root.documentElement.innerText || '').indexOf(txt) >= 0)) return true;
    } catch(e){}
    var fr; try { fr = root.querySelectorAll('iframe, frame'); } catch(e){ fr = []; }
    for (var i=0;i<fr.length;i++){ var d=null; try{ d=fr[i].contentDocument; }catch(e){} if(d && inRoot(d)) return true; }
    return false;
  }
  function hit(){ return inRoot(document); }
  if (hit()) return { ok:true, detail:'이미 존재' };
  return new Promise(function(resolve){
    var iv = setInterval(function(){
      if (hit()){ clearInterval(iv); resolve({ ok:true, detail:'나타남' }); }
      else if (Date.now() > deadline){ clearInterval(iv); resolve({ ok:false, detail:'시간 초과 — 나타나지 않음' }); }
    }, 200);
  });
})()
`, true)) as { ok: boolean; detail: string }
  } catch (err) {
    return { ok: false, detail: String(err) }
  }
}

// 임의 자바스크립트 실행(페이지 컨텍스트) — 추출·조작의 만능 도구. 결과를 문자열로 반환(길이 제한).
export async function runPageJs(wc: WebContents, code: string): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: 'tab destroyed' }
  try {
    const wrapped = `(function(){try{var __r=(function(){${code}\n})();if(__r&&typeof __r.then==='function')return __r;return __r;}catch(e){return {__bbError:String(e)};}})()`
    const res = await wc.executeJavaScript(wrapped, true)
    if (res && typeof res === 'object' && '__bbError' in (res as Record<string, unknown>)) {
      return { ok: false, detail: 'JS 오류: ' + String((res as Record<string, unknown>).__bbError).slice(0, 300) }
    }
    let out: string
    try { out = typeof res === 'string' ? res : JSON.stringify(res) } catch { out = String(res) }
    return { ok: true, detail: (out ?? 'undefined').slice(0, 2000) }
  } catch (err) {
    return { ok: false, detail: 'JS 실행 실패: ' + String(err).slice(0, 300) }
  }
}

// ref 의 화면(뷰포트) 중심 좌표를 구한다(호버·드래그용). top 문서 기준.
async function pointForRef(wc: WebContents, ref: number): Promise<{ x: number; y: number; name: string } | null> {
  try {
    return (await wc.executeJavaScript(`
(function(){
  ${PICK_FN}
  ${FRAME_OFFSET_FN}
  var el = pick(${ref}); if(!el) return null;
  try{ el.scrollIntoView({block:'center'}); }catch(e){}
  var r = el.getBoundingClientRect();
  var fo = frameOffset(el);
  return { x: Math.round(r.left + r.width/2 + fo.ox), y: Math.round(r.top + r.height/2 + fo.oy), name: (el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,30) };
})()
`, true)) as { x: number; y: number; name: string } | null
  } catch { return null }
}

async function viewportSize(wc: WebContents): Promise<{ w: number; h: number }> {
  try { return (await wc.executeJavaScript('({w:window.innerWidth,h:window.innerHeight})', true)) as { w: number; h: number } }
  catch { return { w: 1200, h: 800 } }
}

// ===== 사람처럼 조작(human-like input) — 실제 마우스 이동 궤적 + trusted sendInputEvent =====
// 인스타그램·페이스북 등은 isTrusted 이벤트와 실제 마우스 움직임까지 봇 탐지에 쓴다. el.click()·dispatchEvent
// 같은 합성 이벤트는 isTrusted=false 라 걸릴 수 있으므로, 클릭·입력을 진짜 입력 이벤트로 보낸다(브라우저 그대로).

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
// 마지막 커서 위치를 WebContents 단위로 기억해 다음 이동이 그 자리에서 이어지도록(연속적인 궤적).
const lastMouse = new WeakMap<WebContents, { x: number; y: number }>()
const jitter = (amp: number): number => (Math.random() * 2 - 1) * amp

// ===== 입력 속도 프로파일 =====
// 사람처럼 보이는 타이밍(궤적·타건 간격·반응 지연)은 봇 탐지 회피에 필요하지만, 모든 사이트에서 쓰면
// 클릭마다 0.5초·40자 입력에 3초가 들어 작업 전체가 느려진다(실측: build/bench-agent-cdp.mjs).
// 그래서 두 프로파일을 둔다 — 둘 다 **실제 입력 이벤트(trusted)** 를 쓰는 건 같고, 사람 흉내의
// "여유 시간"만 다르다. 봇 탐지가 실제로 도는 사이트에서만 strict 를 쓰고 나머지는 fast 로 간다.
interface InputProfile {
  moveStepMs: [number, number]     // 마우스 이동 한 스텝 지연
  movePauseChance: number          // 이동 중 멈칫할 확률
  reactionMs: [number, number]     // 요소를 인지하고 누르기까지
  holdMs: [number, number]         // 버튼을 누르고 있는 시간
  settleMs: number                 // 클릭 전 좌표 안정화 최대 대기(인페이지)
  typeMs: [number, number]         // 타건 간격(base, 지수 스케일)
  typeWordPause: boolean           // 단어·문장 경계에서 생각하는 시간
  overshoot: boolean               // 목표를 지나쳤다 되돌아오기
}

const PROFILE_STRICT: InputProfile = {
  moveStepMs: [4, 2.2], movePauseChance: 0.06, reactionMs: [90, 220], holdMs: [40, 90],
  settleMs: 300, typeMs: [12, 3.1], typeWordPause: true, overshoot: true,
}
const PROFILE_FAST: InputProfile = {
  moveStepMs: [1, 1.2], movePauseChance: 0, reactionMs: [12, 25], holdMs: [12, 25],
  settleMs: 120, typeMs: [2, 1.6], typeWordPause: false, overshoot: false,
}

// 정규분포 난수(Box-Muller) — 사람의 손떨림·조준 오차는 균등분포가 아니라 정규분포에 가깝다.
function gauss(sigma: number): number {
  const u = Math.max(1e-9, Math.random())
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()) * sigma
}

// 이전 위치에서 (x,y)로 사람처럼 이동.
// 사람의 마우스는 ① 직선이 아니라 완만한 곡선(베지어) ② 매번 다른 가속 프로파일 ③ 목표를 살짝 지나쳤다
// 되돌아오는 보정 ④ 이동 중 짧은 멈칫 을 보인다. 직선+고정 ease+균등 지연은 궤적 통계만으로 봇으로 분류된다.
async function humanMoveTo(wc: WebContents, x: number, y: number, prof: InputProfile = PROFILE_STRICT): Promise<void> {
  const prev = lastMouse.get(wc) ?? { x: Math.round(x - 60 + jitter(20)), y: Math.round(y - 40 + jitter(20)) }
  const dx = x - prev.x, dy = y - prev.y
  const dist = Math.hypot(dx, dy)
  const steps = Math.max(6, Math.min(28, Math.round(dist / (16 + Math.random() * 12))))
  // 제어점 — 이동 직선의 수직 방향으로 거리 비례 편차를 줘 완만한 곡선을 만든다(매번 방향·크기 랜덤).
  const nx = dist > 0 ? -dy / dist : 0
  const ny = dist > 0 ? dx / dist : 0
  const bow = (Math.random() * 0.18 + 0.04) * dist * (Math.random() < 0.5 ? -1 : 1)
  const c1x = prev.x + dx * 0.3 + nx * bow, c1y = prev.y + dy * 0.3 + ny * bow
  const c2x = prev.x + dx * 0.7 + nx * bow * 0.6, c2y = prev.y + dy * 0.7 + ny * bow * 0.6
  // 목표를 살짝 지나쳤다 되돌아오는 오버슈트(먼 거리일수록 자주).
  const overshoot = prof.overshoot && dist > 120 && Math.random() < 0.45
  const ox = overshoot ? x + (dx / dist) * (4 + Math.random() * 10) : x
  const oy = overshoot ? y + (dy / dist) * (4 + Math.random() * 10) : y
  const pow = 1.6 + Math.random() * 1.2 // 가속 프로파일을 이동마다 바꾼다
  const bez = (t: number, p0: number, p1: number, p2: number, p3: number): number => {
    const u = 1 - t
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
  }
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const e = t < 0.5 ? Math.pow(2 * t, pow) / 2 : 1 - Math.pow(2 * (1 - t), pow) / 2
    const mx = Math.round(bez(e, prev.x, c1x, c2x, ox) + (i < steps ? jitter(1.5) : 0))
    const my = Math.round(bez(e, prev.y, c1y, c2y, oy) + (i < steps ? jitter(1.5) : 0))
    try { wc.sendInputEvent({ type: 'mouseMove', x: mx, y: my }) } catch { /* top-level 만 */ }
    // 로그정규에 가까운 지연 + 가끔 멈칫(사람은 이동 중 목표를 다시 확인한다).
    await sleep(Math.round(prof.moveStepMs[0] + Math.exp(Math.random() * prof.moveStepMs[1]))
      + (Math.random() < prof.movePauseChance ? 40 + Math.floor(Math.random() * 90) : 0))
  }
  if (overshoot) { // 지나친 만큼 되돌아오는 보정 이동
    await sleep(20 + Math.floor(Math.random() * 50))
    for (let i = 1; i <= 3; i++) {
      const t = i / 3
      try { wc.sendInputEvent({ type: 'mouseMove', x: Math.round(ox + (x - ox) * t), y: Math.round(oy + (y - oy) * t) }) } catch { /* ignore */ }
      await sleep(8 + Math.floor(Math.random() * 14))
    }
  }
  const fx = Math.round(x), fy = Math.round(y)
  try { wc.sendInputEvent({ type: 'mouseMove', x: fx, y: fy }) } catch { /* ignore */ }
  lastMouse.set(wc, { x: fx, y: fy })
}

// 좌표(top 창 CSS px)에 실제 클릭 — 이동 → 잠깐 멈춤 → 버튼 down → 사람 같은 클릭 지속 → up.
// down/up 좌표는 미세하게 어긋난다(사람은 누르는 동안 손이 완전히 멈추지 않는다).
async function realClickXY(wc: WebContents, x: number, y: number, prof: InputProfile = PROFILE_STRICT): Promise<void> {
  try { wc.focus() } catch { /* ignore */ }
  await humanMoveTo(wc, x, y, prof)
  // 요소를 인지하고 누르기까지의 반응 지연 — 즉시 클릭은 사람에게 없는 리듬이다.
  await sleep(prof.reactionMs[0] + Math.floor(Math.random() * prof.reactionMs[1]))
  const px = Math.round(x), py = Math.round(y)
  wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 })
  await sleep(prof.holdMs[0] + Math.floor(Math.random() * prof.holdMs[1]))
  const ux = px + (Math.random() < 0.4 ? Math.round(jitter(1)) : 0)
  const uy = py + (Math.random() < 0.4 ? Math.round(jitter(1)) : 0)
  wc.sendInputEvent({ type: 'mouseUp', x: ux, y: uy, button: 'left', clickCount: 1 })
  lastMouse.set(wc, { x: ux, y: uy })
}

// 클릭 지점이 실제로 그 요소인지 확인 — 스티키 헤더·쿠키 배너·로딩 오버레이가 위를 덮고 있으면
// 좌표만 보고 누르는 순간 엉뚱한 것이 눌린다. top 문서 좌표 기준(프레임 안 요소는 검사 생략).
async function pointHitsRef(wc: WebContents, ref: number, x: number, y: number): Promise<boolean> {
  try {
    return (await wc.executeJavaScript(`
(function(){
  ${PICK_FN}
  var el = pick(${ref}); if(!el) return false;
  try { if (el.ownerDocument !== document) return true; } catch(e) { return true; }
  var hit = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
  if (!hit) return false;
  return hit === el || el.contains(hit) || (hit.contains && hit.contains(el));
})()
`, true)) as boolean
  } catch { return true } // 검사 자체가 실패하면 막지 않는다(오탐으로 조작을 멈추지 않도록)
}

// 클릭 준비를 인페이지에서 한 번에 처리한다 — 스크롤 → 좌표 안정화(rAF) → 좌표 계산 → 가림 검사.
// 예전에는 JS 왕복 4회 + 고정 대기 120·180ms 로 나뉘어 있어 클릭마다 수백 ms 를 그냥 버렸다.
// 안정화는 고정 대기가 아니라 "연속 두 프레임에서 좌표가 같으면 통과" 라 대개 훨씬 빨리 끝난다.
async function prepareClickPoint(wc: WebContents, ref: number, settleMs: number): Promise<
{ x: number; y: number; name: string; w: number; h: number; vw: number; vh: number; occluded: boolean } | null> {
  try {
    return (await wc.executeJavaScript(`
(function(){
  ${PICK_FN}
  ${FRAME_OFFSET_FN}
  var el = pick(${ref}); if(!el) return null;
  try{ el.scrollIntoView({block:'center'}); }catch(e){}
  var deadline = Date.now() + ${Math.max(0, Math.round(settleMs))};
  function rect(){ var r = el.getBoundingClientRect(); var fo = frameOffset(el);
    return { x: r.left + r.width/2 + fo.ox, y: r.top + r.height/2 + fo.oy, w: r.width, h: r.height }; }
  function finish(r){
    var name = (el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,30);
    var occluded = false;
    try {
      if (el.ownerDocument === document) {
        var hit = document.elementFromPoint(Math.round(r.x), Math.round(r.y));
        occluded = !!hit && !(hit === el || el.contains(hit) || (hit.contains && hit.contains(el)));
      }
    } catch(e){}
    return { x: r.x, y: r.y, name: name, w: r.w, h: r.h, vw: innerWidth, vh: innerHeight, occluded: occluded };
  }
  return new Promise(function(resolve){
    var prev = rect();
    function step(){
      var cur = rect();
      var stable = Math.abs(cur.x - prev.x) < 1 && Math.abs(cur.y - prev.y) < 1;
      if (stable || Date.now() > deadline) { resolve(finish(cur)); return; }
      prev = cur;
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
})()
`, true)) as { x: number; y: number; name: string; w: number; h: number; vw: number; vh: number; occluded: boolean } | null
  } catch { return null }
}

// ref 의 화면 좌표를 구하고(scrollIntoView 포함) 뷰포트 안이면 실제 클릭. 좌표를 못 구하거나 화면 밖이면 null.
async function realClickRef(wc: WebContents, ref: number, prof: InputProfile = PROFILE_STRICT): Promise<{ ok: boolean; name: string } | null> {
  const p = await prepareClickPoint(wc, ref, prof.settleMs)
  if (!p) return null
  if (p.occluded) return null // 다른 것이 덮고 있음 → 합성 폴백
  if (p.x < 0 || p.y < 0 || p.x > p.vw || p.y > p.vh) return null // 화면 밖 → 합성 폴백
  // 요소 정중앙을 픽셀 단위로 반복해 찍는 것은 사람에게 불가능하다 — 요소 크기에 비례한 정규분포 오차.
  const sx = Math.min(6, Math.max(1, p.w / 6))
  const sy = Math.min(5, Math.max(1, p.h / 6))
  const tx = Math.max(1, Math.min(p.vw - 1, Math.round(p.x + gauss(sx))))
  const ty = Math.max(1, Math.min(p.vh - 1, Math.round(p.y + gauss(sy))))
  await realClickXY(wc, tx, ty, prof)
  return { ok: true, name: p.name }
}

// 입력값이 실제로 들어갔는지 검증(합성 폴백 판단용) — 첫 조각이 요소 값/본문에 있으면 성공으로 본다.
async function verifyTyped(wc: WebContents, ref: number, text: string): Promise<boolean> {
  const probe = JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, 12))
  try {
    return (await wc.executeJavaScript(`
(function(){
  ${PICK_FN}
  var el = pick(${ref}); if(!el) return false;
  var v = (el.value != null ? el.value : (el.innerText || el.textContent || ''));
  var probe = ${probe};
  if (!probe) return (String(v).trim().length > 0);
  return String(v).replace(/\\s+/g,' ').indexOf(probe) >= 0;
})()
`, true)) as boolean
  } catch { return false }
}

// 한 글자씩 실제 키 이벤트로 타이핑(줄바꿈은 Enter).
// 실제 사람의 키 입력은 keydown → char → keyup 시퀀스다. char 만 보내면 keydown 없는 문자 스트림이 되어
// 그 자체로 비정상 신호가 된다(ASCII 는 완전 시퀀스로, 한글 등 조합 문자는 char 로 — keyCode 매핑이 없다).
// 간격도 균등분포가 아니라 사람처럼 들쭉날쭉하게, 단어·문장 경계에서는 잠깐 생각하는 시간을 둔다.
async function typeCharsReal(wc: WebContents, text: string, prof: InputProfile = PROFILE_STRICT): Promise<void> {
  const lines = String(text).split('\n')
  for (let li = 0; li < lines.length; li++) {
    if (li > 0) {
      try {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
      } catch { /* ignore */ }
      await sleep(prof.typeWordPause ? 60 + Math.floor(Math.random() * 160) : 8)
    }
    for (const ch of Array.from(lines[li] ?? '')) {
      try {
        if (/^[\x20-\x7e]$/.test(ch)) {
          // ASCII — 브라우저가 실제 키보드에서 받는 것과 같은 완전 시퀀스
          wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
          wc.sendInputEvent({ type: 'char', keyCode: ch })
          wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
        } else {
          wc.sendInputEvent({ type: 'char', keyCode: ch })
        }
      } catch { /* ignore */ }
      // 로그정규에 가까운 타건 간격 + (strict 일 때만) 단어/문장 경계의 사고 정지.
      let d = Math.round(prof.typeMs[0] + Math.exp(Math.random() * prof.typeMs[1]))
      if (prof.typeWordPause) {
        if (ch === ' ' && Math.random() < 0.25) d += 60 + Math.floor(Math.random() * 180)
        else if (/[.,!?。、]/.test(ch)) d += 80 + Math.floor(Math.random() * 220)
        else if (Math.random() < 0.03) d += 150 + Math.floor(Math.random() * 350)
      }
      await sleep(d)
    }
  }
}

// ref 없이 "지금 포커스된 곳"에 실제 키로 입력한다 — 직전 click_at 으로 포커스한 리치 에디터(네이버·구글독스 등,
// iframe/cross-origin 이라 요소 목록에 안 잡히는 칸)에 사용. DOM 접근이 없어 어떤 프레임이든 입력된다.
export async function typeIntoFocused(wc: WebContents, text: string, submit: boolean, prof: InputProfile = PROFILE_STRICT): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: 'tab destroyed' }
  try { wc.focus() } catch { /* ignore */ }
  await sleep(prof.typeWordPause ? 30 : 10)
  await typeCharsReal(wc, text, prof)
  // 입력이 실제로 들어갔는지 확인한다. 예전에는 검증 없이 항상 성공으로 보고해서, 포커스가 빗나갔거나
  // 오버레이에 가려 글자가 사라져도 다음 단계(게시)로 넘어가 "빈 캡션으로 게시"되는 사고가 가능했다.
  const verdict = await verifyFocusedText(wc, text)
  if (verdict === 'missing') {
    return { ok: false, detail: '입력한 글자가 화면에 들어가지 않았습니다(포커스가 빗나갔을 수 있음) — 입력 칸을 다시 클릭한 뒤 시도하세요.' }
  }
  if (submit) {
    await sleep(30 + Math.floor(Math.random() * 90))
    try { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }) } catch { /* ignore */ }
  }
  return { ok: true, detail: verdict === 'ok' ? '입력(포커스, 사람처럼)' : '입력(포커스) — 외부 프레임이라 입력 결과를 확인하지 못했습니다' }
}

// 지금 포커스된 요소에 방금 친 글자가 들어갔는지 확인. shadow DOM·same-origin iframe 을 따라 내려간다.
// 'ok' 들어감 / 'missing' 안 들어감 / 'unknown' 확인 불가(cross-origin 프레임 등).
async function verifyFocusedText(wc: WebContents, text: string): Promise<'ok' | 'missing' | 'unknown'> {
  const probe = JSON.stringify(String(text).replace(/\s+/g, ' ').trim().slice(0, 12))
  if (probe === '""') return 'unknown'
  try {
    return (await wc.executeJavaScript(`
(function(){
  var probe = ${probe};
  function deepActive(doc){
    var a = doc.activeElement;
    var guard = 0;
    while (a && guard++ < 10) {
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') {
        var d = null; try { d = a.contentDocument; } catch(e) { d = null; }
        if (!d) return '__CROSS__';
        var inner = deepActive(d);
        return inner;
      }
      break;
    }
    return a;
  }
  var el = deepActive(document);
  if (el === '__CROSS__') return 'unknown';
  if (!el || el === document.body || el === document.documentElement) return 'unknown';
  var v = (el.value != null ? el.value : (el.innerText || el.textContent || ''));
  return String(v).replace(/\\s+/g,' ').indexOf(probe) >= 0 ? 'ok' : 'missing';
})()
`, true)) as 'ok' | 'missing' | 'unknown'
  } catch { return 'unknown' }
}

// 실제 키 입력으로 텍스트를 타이핑 — 포커스(실제 클릭 or focus) → 기존 값 비우기 → 한 글자씩 char 이벤트.
// 한글 등 조합 문자도 char 이벤트로 직접 삽입된다. 검증 실패 시 호출부가 합성 방식으로 폴백한다.
// 입력칸이 실제로 비었는지 확인하고, 남아 있으면 비운 뒤 캐럿을 끝으로 보낸다.
// 값을 "지우는" 것은 사람 흉내가 필요한 부분이 아니므로(중요한 건 타이핑) 결정적으로 처리한다.
async function ensureFieldCleared(wc: WebContents, ref: number): Promise<void> {
  try {
    await wc.executeJavaScript(`
(function(){
  ${PICK_FN}
  var el = pick(${ref}); if(!el) return false;
  var cur = (el.value != null ? el.value : (el.innerText || el.textContent || ''));
  if (!String(cur).trim()) return true;
  var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
  try {
    if (el.value != null) {
      var proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, ''); else el.value = '';
    } else {
      el.textContent = '';
    }
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
  } catch(e) {}
  // 캐럿을 끝으로 — 이어서 칠 때 중간에 끼어 들어가지 않도록.
  try {
    el.focus();
    if (el.setSelectionRange && el.value != null) el.setSelectionRange(el.value.length, el.value.length);
    else { var s = win.getSelection(), r = (el.ownerDocument||document).createRange(); r.selectNodeContents(el); r.collapse(false); s.removeAllRanges(); s.addRange(r); }
  } catch(e) {}
  return true;
})()
`, true)
  } catch { /* 확인 실패는 무시 — 아래 verifyTyped 가 최종 판정한다 */ }
}

async function realTypeRef(wc: WebContents, ref: number, text: string, submit: boolean, prof: InputProfile = PROFILE_STRICT): Promise<{ ok: boolean; detail: string }> {
  const focused = await realClickRef(wc, ref, prof)
  if (focused) await sleep(prof.typeWordPause ? 70 : 20)
  else {
    try { await wc.executeJavaScript(`(function(){ ${PICK_FN} var el=pick(${ref}); if(el){ try{el.scrollIntoView({block:'center'}); el.focus();}catch(e){} } })()`, true) } catch { /* ignore */ }
    await sleep(40)
  }
  // 기존 내용 비우기 — 전체 선택 후 삭제(실제 키).
  try {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] as never })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] as never })
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
  } catch { /* ignore */ }
  await sleep(10)
  // 지워졌는지 확인하고, 아직 남아 있으면 확실히 비운다.
  // (키로만 지우면 포커스가 잡히기 전이거나 편집기 구현에 따라 실패하는데, 그러면 기존 값 중간에
  //  새 글자가 끼어 들어가 엉뚱한 값이 된다 — 빠른 프로파일에서 재현됨. 타이밍에 기대지 않는다.)
  await ensureFieldCleared(wc, ref)
  await typeCharsReal(wc, text, prof)
  await sleep(20)
  const ok = await verifyTyped(wc, ref, text)
  if (submit) {
    await sleep(30)
    try {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    } catch { /* ignore */ }
  }
  return { ok, detail: ok ? '입력(사람처럼)' : '실제 입력이 반영되지 않음' }
}

// 화면 백분율 좌표에 실제 클릭(캔버스·커스텀 UI 등 요소 목록 밖 대상).
async function realClickAtPct(wc: WebContents, xPct: number, yPct: number, prof: InputProfile = PROFILE_STRICT): Promise<{ ok: boolean; detail: string }> {
  const vp = await viewportSize(wc)
  const x = Math.round(Math.max(0, Math.min(100, xPct)) / 100 * vp.w)
  const y = Math.round(Math.max(0, Math.min(100, yPct)) / 100 * vp.h)
  await realClickXY(wc, x, y, prof)
  return { ok: true, detail: `화면 클릭 ${x},${y}` }
}

// 호버 — JS 기반 메뉴는 합성 mouseover 로, CSS :hover 는 실제 마우스 이동(sendInputEvent)으로 둘 다 커버.
export async function hoverElement(wc: WebContents, ref: number): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: 'tab destroyed' }
  let pt: { x: number; y: number; name: string } | null
  try {
    pt = (await wc.executeJavaScript(`
(function(){
  ${PICK_FN}
  ${FRAME_OFFSET_FN}
  var el = pick(${ref}); if(!el) return null;
  try{ el.scrollIntoView({block:'center'}); }catch(e){}
  var rc = el.getBoundingClientRect();
  var w = (el.ownerDocument && el.ownerDocument.defaultView) || window;
  // 합성 이벤트의 clientX/Y 는 요소 자기 문서(프레임) 기준이 맞다 — rc 그대로 사용.
  var o = { bubbles:true, cancelable:true, clientX:Math.round(rc.left+rc.width/2), clientY:Math.round(rc.top+rc.height/2), view:w };
  ['pointerover','mouseover','mouseenter','mousemove'].forEach(function(t){ try{ el.dispatchEvent(new w.MouseEvent(t,o)); }catch(e){} });
  // 반환 좌표는 top 창의 실제 마우스 이동(sendInputEvent)용 — 프레임 오프셋을 더한다.
  var fo = frameOffset(el);
  return { x:Math.round(rc.left+rc.width/2+fo.ox), y:Math.round(rc.top+rc.height/2+fo.oy), name:(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,30) };
})()
`, true)) as { x: number; y: number; name: string } | null
  } catch { pt = null }
  if (!pt) return { ok: false, detail: 'ref 요소를 찾을 수 없음' }
  try { wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y }) } catch { /* top-level 만 */ }
  return { ok: true, detail: `호버: ${pt.name || ref}` }
}

// 드래그 — 실제 마우스 down→move→up(sendInputEvent). 슬라이더·캔버스·정렬 등. from/to 는 ref 또는 화면 %.
export async function dragOnPage(wc: WebContents, spec: { ref?: number; xPct?: number; yPct?: number; toRef?: number; toXPct?: number; toYPct?: number }): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: 'tab destroyed' }
  const vp = await viewportSize(wc)
  const resolve = async (ref?: number, xp?: number, yp?: number): Promise<{ x: number; y: number } | null> => {
    if (ref != null) { const p = await pointForRef(wc, ref); return p ? { x: p.x, y: p.y } : null }
    if (xp != null && yp != null) return { x: Math.round(Math.max(0, Math.min(100, xp)) / 100 * vp.w), y: Math.round(Math.max(0, Math.min(100, yp)) / 100 * vp.h) }
    return null
  }
  const from = await resolve(spec.ref, spec.xPct, spec.yPct)
  const to = await resolve(spec.toRef, spec.toXPct, spec.toYPct)
  if (!from || !to) return { ok: false, detail: '드래그 시작/끝 지점을 정할 수 없음(ref 또는 %)' }
  try {
    wc.focus()
    wc.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y })
    wc.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 })
    const steps = 12
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(from.x + (to.x - from.x) * (i / steps))
      const y = Math.round(from.y + (to.y - from.y) * (i / steps))
      wc.sendInputEvent({ type: 'mouseMove', x, y })
    }
    wc.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 })
    return { ok: true, detail: `드래그 ${from.x},${from.y} → ${to.x},${to.y}` }
  } catch (err) { return { ok: false, detail: String(err) } }
}

const KEY_ALIAS: Record<string, string> = {
  enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', space: 'Space', spacebar: 'Space',
  up: 'Up', arrowup: 'Up', down: 'Down', arrowdown: 'Down', left: 'Left', arrowleft: 'Left', right: 'Right', arrowright: 'Right',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
}
function normalizeKeyName(k: string): string {
  const low = k.toLowerCase()
  if (KEY_ALIAS[low]) return KEY_ALIAS[low]
  return k // 한 글자(a, A, 1 …) 또는 Electron 이 아는 이름 그대로
}

// 키보드 입력 — 실제 키 이벤트(sendInputEvent) 라 Ctrl+A(전체선택) 등 브라우저 기본 동작도 발동.
export async function pressKey(wc: WebContents, spec: { key: string; ref?: number }): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: 'tab destroyed' }
  if (spec.ref != null) {
    try { await wc.executeJavaScript(`(function(){ ${PICK_FN} var el=pick(${spec.ref}); if(el){ try{el.focus();}catch(e){} } })()`, true) } catch { /* ignore */ }
  }
  const parts = String(spec.key ?? '').split('+').map((s) => s.trim()).filter(Boolean)
  const keyName = parts.pop() ?? ''
  if (!keyName) return { ok: false, detail: '키가 비어 있음' }
  const modMap: Record<string, string> = { control: 'control', ctrl: 'control', shift: 'shift', alt: 'alt', option: 'alt', meta: 'meta', cmd: 'meta', command: 'meta', win: 'meta' }
  const modifiers = parts.map((p) => modMap[p.toLowerCase()]).filter(Boolean) as string[]
  const kc = normalizeKeyName(keyName)
  try {
    wc.focus()
    wc.sendInputEvent({ type: 'keyDown', keyCode: kc, modifiers: modifiers as never })
    if (kc.length === 1 && modifiers.length === 0) wc.sendInputEvent({ type: 'char', keyCode: kc })
    wc.sendInputEvent({ type: 'keyUp', keyCode: kc, modifiers: modifiers as never })
    return { ok: true, detail: `키 입력: ${spec.key}` }
  } catch (err) { return { ok: false, detail: String(err) } }
}

// 스마트 폼필 — 프로필 값을 페이지 폼 필드에 자동 매칭·입력한다. 값은 여기(메인)→페이지로만 흐르고
// LLM 으로는 가지 않는다. 매칭은 autocomplete·type·name·id·placeholder·label 신호로 결정적으로 수행.
export async function autofillPage(wc: WebContents, profile: Record<string, string>): Promise<{ ok: boolean; count: number; fields: string[] }> {
  if (wc.isDestroyed()) return { ok: false, count: 0, fields: [] }
  const P = JSON.stringify(profile || {})
  try {
    const r = await wc.executeJavaScript(`
(function(){
  var P = ${P};
  // [key, autocomplete 토큰들, 키워드(라벨/name/placeholder 부분일치), type 힌트]
  var DEFS = [
    ['email', ['email'], ['이메일','email','e-mail','메일'], ['email']],
    ['phone', ['tel','tel-national'], ['전화','휴대폰','핸드폰','연락처','phone','mobile','tel'], ['tel']],
    ['firstName', ['given-name'], ['이름(영문)','given','firstname','first name','fname'], []],
    ['lastName', ['family-name'], ['성(영문)','family','lastname','last name','lname','surname'], []],
    ['fullName', ['name'], ['이름','성명','fullname','full name','name','성함'], []],
    ['postalCode', ['postal-code'], ['우편번호','zip','postal','postcode'], []],
    ['addressDetail', ['address-line2'], ['상세주소','address2','line2','나머지 주소'], []],
    ['address', ['street-address','address-line1'], ['주소','address','street','도로명'], []],
    ['city', ['address-level2'], ['도시','시/군/구','city','구'], []],
    ['country', ['country','country-name'], ['국가','나라','country'], []],
    ['birthday', ['bday'], ['생년월일','생일','birth','bday','dob'], ['date']],
    ['organization', ['organization'], ['회사','소속','조직','company','organization'], []],
    ['username', ['username'], ['아이디','유저','id','username','로그인'], []],
    ['cardNumber', ['cc-number'], ['카드번호','card number','cardnumber','cc-number'], []],
    ['cardExp', ['cc-exp'], ['만료','유효기간','expiry','exp','cc-exp'], []],
    ['cardCVC', ['cc-csc'], ['cvc','cvv','보안코드','csc'], []]
  ];
  function winOf(el){ return (el.ownerDocument && el.ownerDocument.defaultView) || window; }
  function setNative(el, value){
    var win = winOf(el);
    try { var proto = el.tagName==='TEXTAREA'?win.HTMLTextAreaElement.prototype:win.HTMLInputElement.prototype; var d=Object.getOwnPropertyDescriptor(proto,'value'); if(d&&d.set)d.set.call(el,value); else el.value=value; } catch(e){ el.value=value; }
    el.dispatchEvent(new win.Event('input',{bubbles:true})); el.dispatchEvent(new win.Event('change',{bubbles:true}));
  }
  function labelFor(el){
    var t='';
    try { if(el.labels&&el.labels.length) t=el.labels[0].innerText||el.labels[0].textContent||''; } catch(e){}
    if(!t&&el.id){ try{ var l=document.querySelector('label[for="'+el.id.replace(/"/g,'')+'"]'); if(l) t=l.innerText||l.textContent||''; }catch(e){} }
    if(!t){ var p=el.closest?el.closest('label'):null; if(p) t=p.innerText||p.textContent||''; }
    return String(t).replace(/\\s+/g,' ').trim();
  }
  function visible(el){ try{ var r=el.getBoundingClientRect(); if(r.width<2||r.height<2) return false; var s=winOf(el).getComputedStyle(el); return !(!s||s.display==='none'||s.visibility==='hidden'); }catch(e){ return false } }
  var SKIP=['password','hidden','submit','button','checkbox','radio','file','image','reset','range','color'];
  var els=document.querySelectorAll('input, textarea');
  var filled=[];
  for(var i=0;i<els.length;i++){
    var el=els[i];
    var type=(el.getAttribute('type')||'text').toLowerCase();
    if(SKIP.indexOf(type)>=0) continue;
    if(el.disabled||el.readOnly) continue;
    if(!visible(el)) continue;
    if(el.value && el.value.trim()) continue; // 이미 채워진 필드는 건드리지 않음
    var ac=(el.getAttribute('autocomplete')||'').toLowerCase();
    var sig=(ac+' '+(el.getAttribute('name')||'')+' '+(el.id||'')+' '+(el.getAttribute('placeholder')||'')+' '+labelFor(el)).toLowerCase();
    var key=null;
    // 1) autocomplete 토큰 우선
    for(var d=0; d<DEFS.length && !key; d++){ var toks=DEFS[d][1]; for(var a=0;a<toks.length;a++){ if(ac===toks[a] || ac.split(/\\s+/).indexOf(toks[a])>=0){ key=DEFS[d][0]; break } } }
    // 2) type 힌트
    if(!key){ for(var d2=0; d2<DEFS.length && !key; d2++){ if(DEFS[d2][3].indexOf(type)>=0) key=DEFS[d2][0]; } }
    // 3) 키워드 부분일치
    if(!key){ for(var d3=0; d3<DEFS.length && !key; d3++){ var kws=DEFS[d3][2]; for(var w=0;w<kws.length;w++){ if(sig.indexOf(kws[w])>=0){ key=DEFS[d3][0]; break } } } }
    if(key && P[key]){ setNative(el, P[key]); filled.push(labelFor(el)||el.getAttribute('name')||key); }
  }
  return { count: filled.length, fields: filled.slice(0,30) };
})()
`, true) as { count: number; fields: string[] }
    return { ok: true, count: r.count, fields: r.fields }
  } catch (err) {
    return { ok: false, count: 0, fields: [String(err).slice(0, 100)] }
  }
}

// 다운로드 — ref 의 링크(href) 또는 지정 url 을 다운로드 매니저로 내려받는다.
export async function resolveHref(wc: WebContents, ref: number): Promise<string | null> {
  try {
    return (await wc.executeJavaScript(`
(function(){
  ${PICK_FN}
  var el = pick(${ref}); if(!el) return null;
  var a = el.closest ? (el.closest('a[href]') || el) : el;
  var h = a.getAttribute ? a.getAttribute('href') : null;
  if(!h) return null;
  try{ return new URL(h, location.href).href; }catch(e){ return h; }
})()
`, true)) as string | null
  } catch { return null }
}

// 다운로드용 미디어 소스 해석 — 사진(img)·영상(video/source)·배경이미지·링크(a[href])를 절대 URL 로.
// blob:/data: 는 직접 받을 수 없으므로 제외(호출부가 감지 후보·yt-dlp 로 폴백하게 null 반환).
export async function resolveMediaSrc(wc: WebContents, ref: number): Promise<{ url: string; kind: 'image' | 'video' | 'link' } | null> {
  try {
    return (await wc.executeJavaScript(`
(function(){
  ${PICK_FN}
  var el = pick(${ref}); if(!el) return null;
  function abs(u){ if(!u) return ''; try{ return new URL(u, location.href).href; }catch(e){ return u; } }
  function ok(u){ return u && u.indexOf('blob:')!==0 && u.indexOf('data:')!==0; }
  var tag = el.tagName ? el.tagName.toUpperCase() : '';
  // 영상
  var v = (tag==='VIDEO') ? el : (el.querySelector ? el.querySelector('video') : null);
  if (v) {
    var vs = v.currentSrc || v.getAttribute('src') || '';
    if (!vs) { var so = v.querySelector ? v.querySelector('source[src]') : null; if(so) vs = so.getAttribute('src'); }
    if (ok(vs)) return { url: abs(vs), kind: 'video' };
  }
  if (tag==='SOURCE') { var ssrc = el.getAttribute('src'); if(ok(ssrc)) return { url: abs(ssrc), kind: 'video' }; }
  // 사진
  var img = (tag==='IMG') ? el : (el.querySelector ? el.querySelector('img') : null);
  if (img) { var is = img.currentSrc || img.getAttribute('src') || ''; if(ok(is)) return { url: abs(is), kind: 'image' }; }
  // 배경 이미지
  try { var bg = getComputedStyle(el).backgroundImage || ''; var mm = bg.match(/url\\(["']?([^"')]+)["']?\\)/); if(mm && ok(mm[1])) return { url: abs(mm[1]), kind: 'image' }; } catch(e){}
  // 링크
  var a = el.closest ? (el.closest('a[href]') || (tag==='A'?el:null)) : (tag==='A'?el:null);
  if (a) { var h = a.getAttribute('href'); if(h) return { url: abs(h), kind: 'link' }; }
  return null;
})()
`, true)) as { url: string; kind: 'image' | 'video' | 'link' } | null
  } catch { return null }
}

export interface ExtractedData { rows: Array<Record<string, string>>; count: number }

// 데이터 추출 — rowSelector 로 반복 항목을 잡고, fields 의 선택자(@attr 지원)로 각 열을 뽑는다.
// 선택자는 페이지 DOM 을 직접 훑으므로 화면에 안 보이는 항목까지 완전하게 수집한다(스크래핑).
export async function extractFromPage(wc: WebContents, spec: { rowSelector?: string; fields?: Record<string, string> }): Promise<ExtractedData> {
  if (wc.isDestroyed()) return { rows: [], count: 0 }
  const rowSel = JSON.stringify(spec.rowSelector ?? '')
  const fields = JSON.stringify(spec.fields ?? {})
  try {
    return (await wc.executeJavaScript(`
(function(){
  var rowSel = ${rowSel};
  var fields = ${fields};
  function extractOne(el, spec){
    if(!spec){ return (el.innerText||el.textContent||'').trim(); }
    var at = spec.indexOf('@');
    var sel = at>=0 ? spec.slice(0,at) : spec;
    var attr = at>=0 ? spec.slice(at+1) : '';
    var t = sel ? el.querySelector(sel) : el;
    if(!t) return '';
    if(attr){
      if(attr==='text') return (t.innerText||t.textContent||'').trim();
      var v = t.getAttribute(attr) || '';
      if((attr==='href'||attr==='src') && v){ try{ v = new URL(v, location.href).href; }catch(e){} }
      return v;
    }
    return (t.innerText||t.textContent||'').trim();
  }
  var rowEls = rowSel ? Array.prototype.slice.call(document.querySelectorAll(rowSel)) : [document.body];
  rowEls = rowEls.slice(0, 1000);
  var cols = Object.keys(fields||{});
  var out = [];
  for(var i=0;i<rowEls.length;i++){
    var r = rowEls[i]; var rec = {}; var any=false;
    if(cols.length){
      for(var c=0;c<cols.length;c++){ var v = String(extractOne(r, fields[cols[c]])||'').replace(/\\s+/g,' ').trim().slice(0,500); rec[cols[c]]=v; if(v) any=true; }
    } else {
      var v2 = (r.innerText||r.textContent||'').replace(/\\s+/g,' ').trim().slice(0,500); rec.text=v2; any=!!v2;
    }
    if(any) out.push(rec);
  }
  return { rows: out, count: out.length };
})()
`, true)) as ExtractedData
  } catch {
    return { rows: [], count: 0 }
  }
}

const OBSERVE_SCRIPT = (maxEls: number, maxText: number) => `
(function() {
  var SEL = 'a[href], button, input, select, textarea, summary, label, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=option], [role=treeitem], [contenteditable=true], [onclick], [tabindex]:not([tabindex="-1"])';
  var MAX = ${maxEls};
  // 드래그&드롭 안내 문구(드롭존 인식용)
  var DROP_RE = /끌어다|끌어서|드래그|여기에 놓|파일을 놓|drag\\s*(and|&)?\\s*drop|drop\\s+(files?|here|it)|여기로 드래그/i;
  // class/id 토큰 — "dropdown" 같은 무관한 이름이 걸리지 않게 경계를 명시한다.
  var DROP_CLASS_RE = /(^|[-_\\s])(drop-?zone|dropzone|file-?drop|drag-?drop|dnd-?area|upload-?area|upload-?zone)([-_\\s]|$)/i;
  function winOf(el) { try { return el.ownerDocument.defaultView || window } catch(e) { return window } }
  function visible(el) {
    try {
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      var s = winOf(el).getComputedStyle(el);
      if (!s || s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return false;
      return true;
    } catch(e) { return false }
  }
  function isSecret(el) {
    var t = (el.getAttribute('type') || '').toLowerCase();
    if (t === 'password') return true;
    var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    return ac.indexOf('password') >= 0 || ac.indexOf('cc-') === 0 || ac === 'one-time-code';
  }
  function nameOf(el) {
    // data-placeholder/aria-placeholder 도 이름으로 — 리치 에디터(네이버·구글독스)의 빈 제목/본문 칸은
    // 이 속성에 "제목"·"내용을 입력하세요" 같은 안내를 담는다.
    var n = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-placeholder') || '';
    // 비밀번호/신용카드 입력값은 절대 이름·값으로 노출하지 않는다(LLM·클라우드로 유출 방지).
    if (!n && el.tagName === 'INPUT') n = (isSecret(el) ? '' : (el.value || '')) || el.getAttribute('name') || el.getAttribute('title') || '';
    if (!n) n = (el.innerText || el.textContent || '').trim();
    if (!n) n = el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '';
    return String(n).replace(/\\s+/g, ' ').trim().slice(0, 120);
  }
  var out = [];
  var ref = { n: 0 };
  // 요소 참조 레지스트리 — DOM 에 속성을 달지 않고 여기에만 담는다(봇 탐지 지문 제거).
  // 관찰마다 통째로 새로 만들어, 옛 번호가 살아남아 엉뚱한 요소를 집는 일이 없다.
  var REG = []; window['${REF_KEY}'] = REG;
  var TAKEN = new WeakSet();  // 같은 요소가 두 번(요소 스캔 + 클릭가능 보강) 담기는 것 방지
  function reg(el, name) { REG[ref.n] = { e: el, n: String(name || '').replace(/\\s+/g, ' ').trim() }; TAKEN.add(el); }
  // same-origin iframe + 열린 shadow DOM(웹 컴포넌트) 을 재귀 관찰(cross-origin/closed 는 접근 예외 → skip).
  function collect(root, depth) {
    if (!root || out.length >= MAX) return;
    var nodes;
    try { nodes = root.querySelectorAll(SEL); } catch(e) { nodes = []; }
    for (var i = 0; i < nodes.length && out.length < MAX; i++) {
      var el = nodes[i];
      if (el.disabled) continue;
      if (TAKEN.has(el)) continue;
      if (!visible(el)) continue;
      var tag = el.tagName.toLowerCase();
      var type = tag === 'input' ? (el.getAttribute('type') || 'text') : (el.getAttribute('role') || tag);
      var name = nameOf(el);
      // 빈 편집 영역(contenteditable·role=textbox/combobox)은 이름이 없어도 목록에 남긴다 —
      // 리치 에디터의 빈 제목/본문 칸이 관찰에서 사라지지 않도록(이게 없으면 에디터 칸을 못 찾는다).
      var editable = el.isContentEditable || (el.getAttribute('contenteditable') === 'true') || type === 'textbox' || type === 'combobox';
      if (!name && tag !== 'input' && tag !== 'textarea' && tag !== 'select' && !editable) continue;
      if (!name && editable) name = '(입력 영역)';
      reg(el, name);
      var rec = { ref: ref.n, tag: tag, type: type, name: (depth > 0 ? '(프레임) ' : '') + name };
      if ((tag === 'input' || tag === 'textarea') && el.value && !isSecret(el)) rec.value = String(el.value).slice(0, 80);
      // 드롭다운의 현재 선택값 — 카테고리·시청자층 등이 무엇으로 돼 있는지 보이게 한다.
      if (tag === 'select') { try { var so = el.options[el.selectedIndex]; if (so) rec.value = String(so.text || so.value || '').slice(0, 80); } catch (e) {} }
      // 상태 — aria-disabled(처리 중이라 아직 못 누르는 게시 버튼)와 체크/선택 여부.
      var ariaDis = false; try { ariaDis = el.getAttribute('aria-disabled') === 'true'; } catch (e) {}
      var ariaChk = null; try { ariaChk = el.getAttribute('aria-checked'); } catch (e) {}
      if (ariaDis) rec.state = 'disabled';
      else if (type === 'checkbox' || type === 'radio' || type === 'switch' || ariaChk === 'true' || ariaChk === 'false') {
        rec.state = (el.checked === true || ariaChk === 'true') ? 'checked' : 'unchecked';
      }
      out.push(rec);
      ref.n++;
    }
    // '*' 한 번으로 shadow host 재귀 + (요소가 적을 때) cursor:pointer 리프 보강 — role 도 onclick 속성도
    // 없이 addEventListener 로만 클릭을 다는 React/Vue div·span 을 잡는다(포인터 커서 = 클릭 가능 신호).
    var all; try { all = root.querySelectorAll('*'); } catch(e) { all = []; }
    var lim = Math.min(all.length, 5000);
    for (var s = 0; s < lim && out.length < MAX; s++) {
      var a = all[s];
      var sr = null; try { sr = a.shadowRoot; } catch(e) {}
      if (sr) { collect(sr, depth); continue; }
      // 드롭존 — "여기에 파일을 끌어다 놓으세요" 류 영역. 보통 role 도 onclick 도 없는 그냥 div 라
      // 위 요소 스캔에 안 잡히는데, 파일 입력이 아예 없는 업로드 UI(틱톡식)에서는 유일한 첨부 경로다.
      // 텍스트로만 좁게 인식해 잡음을 만들지 않는다(드래그&드롭 안내 문구는 매우 특징적).
      if (!TAKEN.has(a) && out.length < MAX) {
        var atxt = '';
        try { atxt = (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim(); } catch (e) {}
        // 세 가지 신호 중 하나라도 있으면 드롭존으로 본다:
        //   ① 안내 문구  ② class/id 가 dropzone·file-drop 류  ③ 안에 숨은 input[type=file] 을 품은 영역
        // (문구 없이 아이콘만 있는 드롭존이 흔하므로 ②③ 이 필요하다. "dropdown" 오탐은 토큰 매칭으로 배제.)
        var byText = !!atxt && atxt.length <= 80 && DROP_RE.test(atxt);
        var idcls = '';
        try { idcls = ((a.id || '') + ' ' + (typeof a.className === 'string' ? a.className : '')).trim(); } catch (e) {}
        var byClass = !!idcls && DROP_CLASS_RE.test(idcls);
        var byInput = false;
        if (!byText && !byClass) {
          try { byInput = a.children.length > 0 && !!a.querySelector('input[type=file]'); } catch (e) {}
        }
        if ((byText || byClass || byInput) && visible(a)) {
          var arect = null; try { arect = a.getBoundingClientRect(); } catch (e) {}
          if (arect && arect.width >= 80 && arect.height >= 40) {
            // 이미 등록된 자손을 품은 큰 컨테이너를 통째로 드롭존이라 하지 않도록, 문구/클래스 신호가
            // 없는 경우(byInput 만)엔 너무 큰 영역은 제외한다(페이지 전체가 드롭존으로 잡히는 것 방지).
            var tooBig = !byText && !byClass && (arect.width > innerWidth * 0.9 && arect.height > innerHeight * 0.9);
            if (!tooBig) {
              var dname = atxt && atxt.length <= 80 ? atxt : (idcls ? '파일 드롭 영역 (' + idcls.slice(0, 30) + ')' : '파일 드롭 영역');
              reg(a, atxt && atxt.length <= 80 ? atxt : '');
              out.push({ ref: ref.n, tag: a.tagName.toLowerCase(), type: 'dropzone', name: (depth > 0 ? '(프레임) ' : '') + dname });
              ref.n++;
              continue;
            }
          }
        }
      }
      if (out.length < 60 && a.childElementCount === 0 && !TAKEN.has(a)) {
        var nm = nameOf(a);
        if (nm && nm.length <= 40 && visible(a)) {
          var cur = ''; try { cur = winOf(a).getComputedStyle(a).cursor; } catch(e) {}
          if (cur === 'pointer') {
            reg(a, nm);
            out.push({ ref: ref.n, tag: a.tagName.toLowerCase(), type: 'clickable', name: (depth > 0 ? '(프레임) ' : '') + nm });
            ref.n++;
          }
        }
      }
    }
    if (depth < 3) {
      var frames;
      try { frames = root.querySelectorAll('iframe, frame'); } catch(e) { frames = []; }
      for (var j = 0; j < frames.length && out.length < MAX; j++) {
        var fdoc = null;
        try { fdoc = frames[j].contentDocument; } catch(e) { fdoc = null; }
        if (fdoc) collect(fdoc, depth + 1);
      }
    }
  }
  collect(document, 0);
  // 반복 구조 힌트 — 같은 (tag.첫class) 서명을 가진 요소가 3개 이상이면 목록으로 보고 rowSelector 후보로 제시(extract 용).
  var listHint = null;
  try {
    var sc = {}; var alln = document.querySelectorAll('*'); var L = Math.min(alln.length, 3000);
    for (var q = 0; q < L; q++) {
      var e2 = alln[q];
      var cn = (e2.className && typeof e2.className === 'string') ? e2.className.trim().split(/\\s+/)[0] : '';
      if (cn && /^[A-Za-z][\\w-]*$/.test(cn)) { var k2 = e2.tagName.toLowerCase() + '.' + cn; sc[k2] = (sc[k2] || 0) + 1; }
    }
    var best = null, bestN = 0;
    for (var kk in sc) { if (sc[kk] > bestN && sc[kk] >= 3 && sc[kk] <= 500) { bestN = sc[kk]; best = kk; } }
    if (best) {
      listHint = { rowSelector: best, count: bestN };
      // 첫 항목 안의 하위 요소(클래스 있는 것·링크)를 필드 후보로 — 에이전트가 fields 를 바로 쓸 수 있게.
      var f0 = document.querySelector(best);
      if (f0) {
        var samp = []; var kids = f0.querySelectorAll('*'); var seenSel = {};
        for (var w = 0; w < kids.length && samp.length < 8; w++) {
          var kd = kids[w];
          var kc = (kd.className && typeof kd.className === 'string') ? kd.className.trim().split(/\\s+/)[0] : '';
          var ksel = '';
          if (kc && /^[A-Za-z][\\w-]*$/.test(kc)) ksel = '.' + kc;
          else if (kd.tagName === 'A') ksel = 'a';
          if (ksel && !seenSel[ksel]) {
            seenSel[ksel] = 1;
            var kt = (kd.innerText || kd.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30);
            var rec2 = { sel: ksel, sample: kt };
            if (kd.tagName === 'A' && kd.getAttribute('href')) rec2.attr = 'href';
            samp.push(rec2);
          }
        }
        if (samp.length) listHint.fields = samp;
      }
    }
  } catch (e) {}
  // 업로드·인코딩 진행 상태 — progressbar 의 aria 값과 "업로드 중/처리 중 NN%" 문구를 모은다.
  // (영상 업로드는 첨부 후 수 분이 걸린다. 이 신호가 없으면 완료 여부를 추측하게 되고, 미완 상태로 게시된다.)
  var progress = '';
  try {
    var bars = document.querySelectorAll('[role=progressbar], progress');
    for (var pb = 0; pb < bars.length && progress.length < 160; pb++) {
      var b = bars[pb];
      if (!visible(b)) continue;
      var vt = b.getAttribute('aria-valuetext') || '';
      var vn = b.getAttribute('aria-valuenow'); if (vn == null && b.value != null) vn = b.value;
      var lbl = b.getAttribute('aria-label') || '';
      var piece = (lbl ? lbl + ': ' : '') + (vt || (vn != null ? vn + '%' : ''));
      if (piece.trim()) progress += (progress ? ' | ' : '') + piece.trim();
    }
    var bt0 = (document.body ? document.body.innerText : '') || '';
    var pm = bt0.match(/(업로드\\s*중[^\\n]{0,40}|처리\\s*중[^\\n]{0,40}|uploading[^\\n]{0,40}|processing[^\\n]{0,40}|\\d{1,3}\\s*%[^\\n]{0,30})/i);
    if (pm && pm[1]) progress += (progress ? ' | ' : '') + pm[1].replace(/\\s+/g, ' ').trim().slice(0, 80);
  } catch (e) {}
  var bodyText = (document.body ? document.body.innerText : '') || '';
  bodyText = bodyText.replace(/\\n{3,}/g, '\\n\\n').trim();
  return {
    url: location.href,
    title: document.title || '',
    text: bodyText.slice(0, ${maxText}),
    truncated: bodyText.length > ${maxText},
    elements: out,
    listHint: listHint,
    progress: progress || undefined,
    scroll: { y: Math.round(window.scrollY), maxY: Math.round(Math.max(0, Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0) - window.innerHeight)) }
  };
})();
`

export async function observePage(wc: WebContents, opts?: { maxElements?: number; maxText?: number }): Promise<PageObservation | null> {
  if (wc.isDestroyed()) return null
  const url = wc.getURL()
  if (!/^https?:/i.test(url)) return null
  try {
    return (await wc.executeJavaScript(OBSERVE_SCRIPT(opts?.maxElements ?? 80, opts?.maxText ?? 1800), true)) as PageObservation
  } catch (err) {
    console.warn('[ai-agent] observe failed', err)
    return null
  }
}

function execScript(action: AgentAction): string {
  const ref = JSON.stringify(action.ref ?? -1)
  const text = JSON.stringify(action.text ?? '')
  const dir = action.direction === 'up' ? -1 : 1
  const submit = action.submit ? 'true' : 'false'
  const xPct = Number.isFinite(action.xPct as number) ? Number(action.xPct) : 50
  const yPct = Number.isFinite(action.yPct as number) ? Number(action.yPct) : 50
  return `
(function() {
  // ref 는 관찰 때 만든 레지스트리에서 꺼낸다(DOM 속성 미사용 — 봇 탐지 지문 제거 + 재활용 노드 검증).
  ${PICK_FN}
  function winOf(el) { return (el.ownerDocument && el.ownerDocument.defaultView) || window; }
  function setNativeValue(el, value) {
    var win = winOf(el);
    try {
      var proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    } catch (e) { el.value = value; }
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
  }
  try {
    var act = ${JSON.stringify(action.action)};
    if (act === 'scroll') { window.scrollBy({ top: ${dir} * Math.round(window.innerHeight * 0.85), behavior: 'instant' }); return { ok: true, detail: 'scrolled' }; }
    if (act === 'click_at') {
      // 화면(뷰포트)의 백분율 좌표를 CSS 좌표로 바꿔, 그 지점의 요소에 실제 마우스 이벤트를 보낸다
      // (캔버스·커스텀 UI 처럼 DOM 요소 목록에 안 잡히는 대상도 클릭 가능).
      var vx = Math.max(0, Math.min(100, ${xPct})) / 100 * window.innerWidth;
      var vy = Math.max(0, Math.min(100, ${yPct})) / 100 * window.innerHeight;
      var tgt = document.elementFromPoint(vx, vy);
      if (!tgt) return { ok: false, detail: '그 위치에 요소가 없습니다 (' + Math.round(vx) + ',' + Math.round(vy) + ')' };
      var mo = { bubbles: true, cancelable: true, clientX: vx, clientY: vy, view: window, button: 0 };
      try {
        tgt.dispatchEvent(new MouseEvent('mousemove', mo));
        tgt.dispatchEvent(new MouseEvent('mousedown', mo));
        tgt.dispatchEvent(new MouseEvent('mouseup', mo));
        tgt.dispatchEvent(new MouseEvent('click', mo));
      } catch (e) { return { ok: false, detail: String(e) }; }
      var tt = (tgt.innerText || tgt.textContent || (tgt.getAttribute && tgt.getAttribute('aria-label')) || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
      return { ok: true, detail: '화면 클릭 ' + Math.round(vx) + ',' + Math.round(vy) + ' → ' + tgt.tagName + (tt ? ' "' + tt + '"' : '') };
    }
    var el = pick(${ref});
    if (!el) return { ok: false, detail: 'ref ' + ${ref} + ' 요소를 찾을 수 없음(페이지가 바뀌었을 수 있음)' };
    var win = winOf(el);
    el.scrollIntoView({ block: 'center' });
    if (act === 'click') { el.click(); return { ok: true, detail: 'clicked' }; }
    if (act === 'type') {
      if (el.isContentEditable) { el.focus(); el.textContent = ${text}; el.dispatchEvent(new win.Event('input', { bubbles: true })); }
      else { el.focus(); setNativeValue(el, ${text}); }
      if (${submit}) {
        var form = el.form;
        el.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        if (form && typeof form.requestSubmit === 'function') { try { form.requestSubmit(); } catch (e) { form.submit && form.submit(); } }
      }
      return { ok: true, detail: 'typed' };
    }
    return { ok: false, detail: 'unknown in-page action ' + act };
  } catch (e) { return { ok: false, detail: String(e) }; }
})();
`
}

// 합성(synthetic) 실행 — el.click()·setNativeValue·dispatchEvent. 실제 입력 실패 시 폴백으로만 쓴다.
async function execSynthetic(wc: WebContents, action: AgentAction): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: 'tab destroyed' }
  try {
    return (await wc.executeJavaScript(execScript(action), true)) as { ok: boolean; detail: string }
  } catch (err) {
    return { ok: false, detail: String(err) }
  }
}

// 페이지 행동 실행. 기본은 사람처럼(human-like) 실제 입력 이벤트로 조작해 봇 탐지(인스타·페북 등)를 피한다.
// click/type/click_at 은 실제 마우스 이동·키 입력을 보내고, 좌표를 못 구하거나 반영이 안 되면 합성 방식으로 폴백.
// 봇 탐지를 실제로 돌리는 사이트 — 여기서만 "사람 흉내" 타이밍을 전부 켠다(strict).
// 그 외 사이트에서는 같은 실제 입력 이벤트를 쓰되 여유 시간을 줄여 훨씬 빠르게 처리한다(fast).
const STRICT_HOSTS = /(^|\.)(instagram|facebook|fb|threads|tiktok|douyin|x|twitter|linkedin|pinterest|reddit|youtube|google|naver|kakao|coupang|cloudflare)\.[a-z.]+$/i

// 이 URL 이 "빠른 조작" 대상인가 — 호출부(에이전트 루프)가 단계 간 대기도 함께 줄이는 데 쓴다.
export function isFastSite(url: string, mode?: 'auto' | 'human' | 'fast'): boolean {
  return inputProfileFor(url, mode) === PROFILE_FAST
}

export function inputProfileFor(url: string, mode?: 'auto' | 'human' | 'fast'): InputProfile {
  if (mode === 'human') return PROFILE_STRICT
  if (mode === 'fast') return PROFILE_FAST
  try { return STRICT_HOSTS.test(new URL(url).hostname) ? PROFILE_STRICT : PROFILE_FAST }
  catch { return PROFILE_FAST }
}

export async function executeInPageAction(
  wc: WebContents,
  action: AgentAction,
  opts?: { humanInput?: boolean; profile?: InputProfile },
): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: 'tab destroyed' }
  const human = opts?.humanInput !== false
  const prof = opts?.profile ?? PROFILE_STRICT
  if (!human) return execSynthetic(wc, action)
  // 합성 폴백은 isTrusted=false 이벤트라 봇 탐지에 걸릴 수 있다. 예전에는 아무 표시 없이 폴백해서
  // 사용자도 에이전트도 "사람처럼 클릭됐다"고 믿었다 — 이제 결과 detail 에 폴백 사실을 명시한다.
  const fallback = async (why: string): Promise<{ ok: boolean; detail: string }> => {
    const r = await execSynthetic(wc, action)
    return { ok: r.ok, detail: r.ok ? `${r.detail} ※ 사람 입력 대신 합성 이벤트 사용(${why})` : r.detail }
  }
  try {
    if (action.action === 'click') {
      const r = await realClickRef(wc, action.ref ?? -1, prof)
      if (r) return { ok: true, detail: `클릭(사람처럼) ${r.name || action.ref}` }
      return fallback('화면 밖·좌표 불가·다른 요소가 덮음')
    }
    if (action.action === 'click_at') {
      return await realClickAtPct(wc, Number(action.xPct ?? 50), Number(action.yPct ?? 50), prof)
    }
    if (action.action === 'type') {
      // ref 가 없으면(리치 에디터·iframe 칸) 직전 click_at 으로 포커스한 곳에 실제 키로 입력.
      if (action.ref == null || action.ref < 0) return typeIntoFocused(wc, action.text ?? '', !!action.submit, prof)
      const r = await realTypeRef(wc, action.ref, action.text ?? '', !!action.submit, prof)
      if (r.ok) return r
      return fallback('실제 키 입력이 반영되지 않음')
    }
    return execSynthetic(wc, action) // scroll 등은 그대로(사람 입력이 필요 없는 동작)
  } catch (err) {
    return fallback('실제 입력 중 오류').catch(() => ({ ok: false, detail: String(err) }))
  }
}

// 파일 업로드 — 네이티브 OS 파일 창을 거치지 않고 페이지의 <input type=file> 에 파일을 직접 첨부한다.
// Chromium 디버거 프로토콜의 DOM.setFileInputFiles(Puppeteer/Playwright 가 쓰는 표준 방식)를 사용.
// 파일 입력은 보통 숨겨져 있어(관찰에 안 잡힘) 버튼 클릭 없이 여기서 직접 채운다.
interface FileInputCand { sessionId?: string; nodeId: number; accept: string; score: number }

// accept 속성과 실제 파일 확장자를 맞춰 본다.
// 예전에는 "문서의 마지막 input[type=file]" 을 근거 없이 골랐다 — 유튜브 스튜디오처럼 영상·썸네일·자막
// 입력이 공존하면 영상이 썸네일 칸에 첨부되고, 사이트가 조용히 거부해도 "첨부됨" 으로 보고됐다.
function scoreAccept(accept: string, filePath: string): number {
  const a = (accept || '').toLowerCase().trim()
  const ext = path.extname(filePath).toLowerCase()
  const isVideo = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'].includes(ext)
  const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.avif'].includes(ext)
  if (!a) return 1 // accept 미지정 = 아무거나 받는다(중립)
  const parts = a.split(',').map((s) => s.trim()).filter(Boolean)
  for (const p of parts) {
    if (p === ext) return 5                                   // 확장자 정확 일치
    if (p === 'video/*' && isVideo) return 4
    if (p === 'image/*' && isImage) return 4
    if (p === 'audio/*' && ['.mp3', '.wav', '.m4a', '.aac', '.flac'].includes(ext)) return 4
    if (p === '*/*') return 1
  }
  // accept 는 있는데 우리 파일과 안 맞음 → 이 입력은 피한다.
  return -3
}

async function collectFileInputs(dbg: Electron.Debugger, sessionId: string | undefined, filePath: string): Promise<FileInputCand[]> {
  const out: FileInputCand[] = []
  try {
    await dbg.sendCommand('DOM.enable', {}, sessionId)
    const doc = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true }, sessionId) as { root: { nodeId: number } }
    const q = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' }, sessionId) as { nodeIds: number[] }
    for (const nodeId of q.nodeIds ?? []) {
      let accept = ''
      try {
        const at = await dbg.sendCommand('DOM.getAttributes', { nodeId }, sessionId) as { attributes: string[] }
        const arr = at.attributes ?? []
        for (let i = 0; i + 1 < arr.length; i += 2) if ((arr[i] ?? '').toLowerCase() === 'accept') accept = arr[i + 1] ?? ''
      } catch { /* 속성을 못 읽으면 중립 취급 */ }
      out.push({ sessionId, nodeId, accept, score: scoreAccept(accept, filePath) })
    }
  } catch { /* 이 프레임은 건너뛴다 */ }
  return out
}

// 파일 업로드 — 네이티브 OS 파일 창을 거치지 않고 페이지의 <input type=file> 에 파일을 직접 첨부한다.
// Chromium 디버거 프로토콜의 DOM.setFileInputFiles(Puppeteer/Playwright 가 쓰는 표준 방식)를 사용.
// 파일 입력은 보통 숨겨져 있어(관찰에 안 잡힘) 버튼 클릭 없이 여기서 직접 채운다.
// cross-origin iframe(OOPIF) 안의 입력도 Target 자동 부착으로 찾아 첨부한다(틱톡 등 임베드 업로드 UI).
export async function setFileInputFiles(wc: WebContents, filePaths: string[]): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: '탭이 닫혔습니다' }
  if (!filePaths.length) return { ok: false, detail: '선택된 파일이 없습니다' }
  const dbg = wc.debugger
  let attached = false
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); attached = true }
  } catch {
    return { ok: false, detail: '개발자 도구가 열려 있어 파일을 첨부할 수 없습니다(닫고 다시 시도하세요)' }
  }
  const first = filePaths[0] ?? ''
  const childSessions: string[] = []
  const onMsg = (_e: unknown, method: string, params: unknown): void => {
    if (method === 'Target.attachedToTarget') {
      const p = params as { sessionId?: string; targetInfo?: { type?: string } }
      if (p.sessionId && (p.targetInfo?.type === 'iframe' || p.targetInfo?.type === 'page')) childSessions.push(p.sessionId)
    }
  }
  try {
    dbg.on('message', onMsg)
    // cross-origin iframe 은 별도 타깃이라 DOM.getDocument(pierce) 로 뚫리지 않는다 → 자동 부착으로 세션을 얻는다.
    try {
      await dbg.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
      await sleep(250)
    } catch { /* 자동 부착 미지원이면 top 문서만 본다 */ }

    let cands = await collectFileInputs(dbg, undefined, first)
    for (const sid of childSessions) cands = cands.concat(await collectFileInputs(dbg, sid, first))

    if (!cands.length) {
      return { ok: false, detail: '파일 입력(input[type=file])을 찾지 못했습니다 — 업로드 화면으로 먼저 이동하거나, 업로드 버튼을 클릭해 파일 선택이 뜨게 하세요' }
    }
    // 점수가 가장 높은 입력. 동점이면 뒤쪽(대개 업로드 흐름에서 방금 생긴 것).
    let best = cands[0] as FileInputCand
    for (const c of cands) if (c.score >= best.score) best = c
    if (best.score < 0) {
      return { ok: false, detail: `이 화면의 파일 입력은 다른 형식을 요구합니다(accept="${best.accept}") — 올리려는 파일 형식과 맞는 업로드 화면인지 확인하세요` }
    }
    await dbg.sendCommand('DOM.setFileInputFiles', { files: filePaths, nodeId: best.nodeId }, best.sessionId)
    const where = best.sessionId ? '(프레임 안 입력)' : ''
    const acc = best.accept ? ` accept="${best.accept}"` : ''
    return { ok: true, detail: `파일 ${filePaths.length}개 첨부됨${where}${acc}` }
  } catch (err) {
    return { ok: false, detail: '파일 첨부 실패: ' + (err instanceof Error ? err.message : String(err)) }
  } finally {
    try { dbg.off('message', onMsg) } catch { /* ignore */ }
    if (attached) { try { dbg.detach() } catch { /* ignore */ } }
  }
}

// 드롭존 업로드 — 파일 입력도 파일 선택 창도 쓰지 않고 오직 드래그&드롭(DataTransfer)만 받는 UI 대응.
// CDP Input.dispatchDragEvent 로 실제 드래그 시퀀스(dragEnter → dragOver → drop)를 보낸다.
// 좌표는 ref 요소의 화면 중심(top 창 기준). 브라우저가 만든 진짜 드래그라 페이지의 ondrop 이 파일을 받는다.
export async function dropFilesOnRef(wc: WebContents, ref: number, filePaths: string[]): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: '탭이 닫혔습니다' }
  if (!filePaths.length) return { ok: false, detail: '선택된 파일이 없습니다' }
  const pt = await pointForRef(wc, ref)
  if (!pt) return { ok: false, detail: `요소 ${ref} 의 위치를 찾지 못했습니다(화면 밖이거나 사라짐)` }
  const dbg = wc.debugger
  let attached = false
  try { if (!dbg.isAttached()) { dbg.attach('1.3'); attached = true } } catch {
    return { ok: false, detail: '개발자 도구가 열려 있어 드롭할 수 없습니다(닫고 다시 시도하세요)' }
  }
  try {
    const data = {
      items: filePaths.map((p) => ({ mimeType: 'application/octet-stream', data: path.basename(p), title: path.basename(p) })),
      files: filePaths,
      dragOperationsMask: 1, // copy
    }
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await dbg.sendCommand('Input.dispatchDragEvent', { type, x: Math.round(pt.x), y: Math.round(pt.y), data })
      await sleep(80)
    }
    return { ok: true, detail: `드롭존에 파일 ${filePaths.length}개를 드롭했습니다` }
  } catch (err) {
    return { ok: false, detail: '드롭 실패: ' + (err instanceof Error ? err.message : String(err)) }
  } finally {
    if (attached) { try { dbg.detach() } catch { /* ignore */ } }
  }
}

// 파일 선택 창 가로채기 — "컴퓨터에서 선택" 버튼을 눌러야만 입력이 생기는 UI(틱톡·드롭존형) 대응.
// 예전에는 그 버튼을 누르면 OS 파일 창이 떠서, 스크린샷에도 안 잡히고 닫을 수단도 없어 에이전트가 갇혔다.
// 이걸 켜 두면 파일 창이 뜨는 대신 우리가 지정한 파일이 자동으로 채워진다.
export async function armFileChooser(wc: WebContents, filePaths: string[], timeoutMs = 90_000): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: '탭이 닫혔습니다' }
  if (!filePaths.length) return { ok: false, detail: '선택된 파일이 없습니다' }
  const dbg = wc.debugger
  try { if (!dbg.isAttached()) dbg.attach('1.3') } catch {
    return { ok: false, detail: '개발자 도구가 열려 있어 파일 선택을 가로챌 수 없습니다(닫고 다시 시도하세요)' }
  }
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean, detail: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { dbg.off('message', onMsg) } catch { /* ignore */ }
      void dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => { /* ignore */ })
      try { dbg.detach() } catch { /* ignore */ }
      resolve({ ok, detail })
    }
    const onMsg = (_e: unknown, method: string, params: unknown, sessionId?: string): void => {
      if (method !== 'Page.fileChooserOpened') return
      const p = params as { backendNodeId?: number }
      if (!p.backendNodeId) { finish(false, '파일 선택 창을 가로챘지만 대상 입력을 찾지 못했습니다'); return }
      dbg.sendCommand('DOM.setFileInputFiles', { files: filePaths, backendNodeId: p.backendNodeId }, sessionId)
        .then(() => finish(true, `파일 선택 창을 가로채 ${filePaths.length}개를 자동 첨부했습니다`))
        .catch((e: unknown) => finish(false, '자동 첨부 실패: ' + String(e)))
    }
    const timer = setTimeout(() => finish(false, '파일 선택 창이 열리지 않았습니다(업로드 버튼을 누르지 않았거나 다른 방식)'), timeoutMs)
    dbg.on('message', onMsg)
    Promise.all([
      dbg.sendCommand('Page.enable'),
      dbg.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => { /* 선택 사항 */ }),
    ])
      .then(() => dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }))
      .catch((e: unknown) => finish(false, '파일 선택 가로채기를 켜지 못했습니다: ' + String(e)))
  })
}
