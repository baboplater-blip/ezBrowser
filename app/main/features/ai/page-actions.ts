import { type WebContents } from 'electron'

// 에이전트의 눈과 손 — 페이지를 관찰(observe)하고 행동(execute)한다.
// 콘텐츠 페이지 컨텍스트에서 executeJavaScript 로 실행(제스처·번역·리더와 동일 패턴).
// 관찰 시 상호작용 요소에 data-bb-agent-ref 속성을 달아, 실행 때 그 ref 로 정확히 집는다.

export interface ObservedElement {
  ref: number
  tag: string       // a / button / input / select / textarea / [role]
  type: string      // input type, 또는 role
  name: string      // 접근성 이름(텍스트·aria-label·placeholder·value·title)
  value?: string
}

export interface PageObservation {
  url: string
  title: string
  text: string           // 본문 스니펫(잘림)
  elements: ObservedElement[]
  scroll: { y: number; maxY: number }
  truncated: boolean
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

// ref 를 top 문서 + same-origin iframe + 열린 shadow DOM 에서 찾는 공통 스크립트 조각(인페이지).
const PICK_FN = `function pick(r){var q='[data-bb-agent-ref="'+r+'"]';function find(root){try{var el=root.querySelector(q);if(el)return el;}catch(e){}var all;try{all=root.querySelectorAll('*');}catch(e){all=[];}for(var i=0;i<all.length;i++){var sr=null;try{sr=all[i].shadowRoot;}catch(e){}if(sr){var e1=find(sr);if(e1)return e1;}}var fr;try{fr=root.querySelectorAll('iframe,frame');}catch(e){fr=[];}for(var k=0;k<fr.length;k++){var d=null;try{d=fr[k].contentDocument;}catch(e){}if(d){var e2=find(d);if(e2)return e2;}}return null;}return find(document);}`

// 요소가 same-origin iframe 안에 있으면 getBoundingClientRect 는 그 iframe 뷰포트 기준이다. sendInputEvent
// (마우스 이동·드래그)는 top 창 좌표를 쓰므로, 조상 iframe 들의 뷰포트 오프셋을 누적해 top 창 좌표로 변환한다.
const FRAME_OFFSET_FN = `function frameOffset(el){var ox=0,oy=0;var win=(el.ownerDocument&&el.ownerDocument.defaultView)||window;var g=0;while(win&&win!==win.top&&g++<10){var fe=null;try{fe=win.frameElement;}catch(e){break;}if(!fe)break;var fr=fe.getBoundingClientRect();ox+=fr.left;oy+=fr.top;win=(fe.ownerDocument&&fe.ownerDocument.defaultView)||null;}return {ox:ox,oy:oy};}`

// 조건부 대기 — 선택자가 매칭되거나 텍스트가 나타날 때까지(동적 페이지·AJAX·SPA 대응). 인페이지 Promise 로 폴링.
export async function waitForOnPage(wc: WebContents, spec: { selector?: string; text?: string; timeout?: number }): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: 'tab destroyed' }
  const sel = JSON.stringify(spec.selector ?? '')
  const txt = JSON.stringify(spec.text ?? '')
  const timeout = Math.max(500, Math.min(60000, Math.round(spec.timeout ?? 10000)))
  try {
    return (await wc.executeJavaScript(`
(function(){
  var sel = ${sel}, txt = ${txt}, deadline = Date.now() + ${timeout};
  function hit(){
    if (sel){ try{ if(document.querySelector(sel)) return true; }catch(e){} }
    if (txt){ try{ if((document.body&&document.body.innerText||'').indexOf(txt)>=0) return true; }catch(e){} }
    return false;
  }
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
    var n = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    // 비밀번호/신용카드 입력값은 절대 이름·값으로 노출하지 않는다(LLM·클라우드로 유출 방지).
    if (!n && el.tagName === 'INPUT') n = (isSecret(el) ? '' : (el.value || '')) || el.getAttribute('name') || el.getAttribute('title') || '';
    if (!n) n = (el.innerText || el.textContent || '').trim();
    if (!n) n = el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '';
    return String(n).replace(/\\s+/g, ' ').trim().slice(0, 120);
  }
  var out = [];
  var ref = { n: 0 };
  // 이전 관찰이 남긴 data-bb-agent-ref 를 먼저 모두 제거한다(shadow/iframe 포함) — 안 그러면 이번에
  // 수집되지 않은 옛 요소가 옛 번호를 유지해, pick 이 엉뚱한 요소를 집을 수 있다.
  function clearRefs(root, depth) {
    try { var olds = root.querySelectorAll('[data-bb-agent-ref]'); for (var k = 0; k < olds.length; k++) olds[k].removeAttribute('data-bb-agent-ref'); } catch (e) {}
    var all; try { all = root.querySelectorAll('*'); } catch (e) { all = []; }
    var clim = Math.min(all.length, 5000);
    for (var cs = 0; cs < clim; cs++) { var csr = null; try { csr = all[cs].shadowRoot; } catch (e) {} if (csr) clearRefs(csr, depth); }
    if (depth < 3) {
      var fr; try { fr = root.querySelectorAll('iframe, frame'); } catch (e) { fr = []; }
      for (var m = 0; m < fr.length; m++) { var fd = null; try { fd = fr[m].contentDocument; } catch (e) {} if (fd) clearRefs(fd, depth + 1); }
    }
  }
  clearRefs(document, 0);
  // same-origin iframe + 열린 shadow DOM(웹 컴포넌트) 을 재귀 관찰(cross-origin/closed 는 접근 예외 → skip).
  function collect(root, depth) {
    if (!root || out.length >= MAX) return;
    var nodes;
    try { nodes = root.querySelectorAll(SEL); } catch(e) { nodes = []; }
    for (var i = 0; i < nodes.length && out.length < MAX; i++) {
      var el = nodes[i];
      if (el.disabled) continue;
      if (el.hasAttribute && el.hasAttribute('data-bb-agent-ref')) continue;
      if (!visible(el)) continue;
      var tag = el.tagName.toLowerCase();
      var type = tag === 'input' ? (el.getAttribute('type') || 'text') : (el.getAttribute('role') || tag);
      var name = nameOf(el);
      if (!name && tag !== 'input' && tag !== 'textarea' && tag !== 'select') continue;
      el.setAttribute('data-bb-agent-ref', String(ref.n));
      var rec = { ref: ref.n, tag: tag, type: type, name: (depth > 0 ? '(프레임) ' : '') + name };
      if ((tag === 'input' || tag === 'textarea') && el.value && !isSecret(el)) rec.value = String(el.value).slice(0, 80);
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
      if (out.length < 60 && a.childElementCount === 0 && !(a.hasAttribute && a.hasAttribute('data-bb-agent-ref'))) {
        var nm = nameOf(a);
        if (nm && nm.length <= 40 && visible(a)) {
          var cur = ''; try { cur = winOf(a).getComputedStyle(a).cursor; } catch(e) {}
          if (cur === 'pointer') {
            a.setAttribute('data-bb-agent-ref', String(ref.n));
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
  var bodyText = (document.body ? document.body.innerText : '') || '';
  bodyText = bodyText.replace(/\\n{3,}/g, '\\n\\n').trim();
  return {
    url: location.href,
    title: document.title || '',
    text: bodyText.slice(0, ${maxText}),
    truncated: bodyText.length > ${maxText},
    elements: out,
    listHint: listHint,
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
  // ref 는 top 문서 + 접근 가능한 same-origin iframe + 열린 shadow DOM 을 모두 뒤져서 찾는다.
  function pick(r) {
    var q = '[data-bb-agent-ref="' + r + '"]';
    function find(root) {
      try { var el = root.querySelector(q); if (el) return el; } catch(e) {}
      var all; try { all = root.querySelectorAll('*'); } catch(e) { all = []; }
      for (var i = 0; i < all.length; i++) { var sr = null; try { sr = all[i].shadowRoot; } catch(e) {} if (sr) { var e1 = find(sr); if (e1) return e1; } }
      var fr; try { fr = root.querySelectorAll('iframe, frame'); } catch(e) { fr = []; }
      for (var k = 0; k < fr.length; k++) {
        var d = null; try { d = fr[k].contentDocument; } catch(e) {}
        if (d) { var e2 = find(d); if (e2) return e2; }
      }
      return null;
    }
    return find(document);
  }
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

export async function executeInPageAction(wc: WebContents, action: AgentAction): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: 'tab destroyed' }
  try {
    return (await wc.executeJavaScript(execScript(action), true)) as { ok: boolean; detail: string }
  } catch (err) {
    return { ok: false, detail: String(err) }
  }
}

// 파일 업로드 — 네이티브 OS 파일 창을 거치지 않고 페이지의 <input type=file> 에 파일을 직접 첨부한다.
// Chromium 디버거 프로토콜의 DOM.setFileInputFiles(Puppeteer/Playwright 가 쓰는 표준 방식)를 사용.
// 파일 입력은 보통 숨겨져 있어(관찰에 안 잡힘) 버튼 클릭 없이 여기서 직접 채운다.
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
  try {
    await dbg.sendCommand('DOM.enable')
    const doc = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true }) as { root: { nodeId: number } }
    const q = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' }) as { nodeIds: number[] }
    const ids = q.nodeIds ?? []
    if (!ids.length) return { ok: false, detail: '파일 입력(input[type=file])을 찾지 못했습니다 — 업로드 화면으로 먼저 이동하세요' }
    // 가장 마지막(대개 업로드 흐름에서 방금 생성된) 입력에 첨부. setFileInputFiles 가 change 이벤트도 발생시킨다.
    const nodeId = ids[ids.length - 1]
    await dbg.sendCommand('DOM.setFileInputFiles', { files: filePaths, nodeId })
    return { ok: true, detail: `파일 ${filePaths.length}개 첨부됨` }
  } catch (err) {
    return { ok: false, detail: '파일 첨부 실패: ' + (err instanceof Error ? err.message : String(err)) }
  } finally {
    if (attached) { try { dbg.detach() } catch { /* ignore */ } }
  }
}
