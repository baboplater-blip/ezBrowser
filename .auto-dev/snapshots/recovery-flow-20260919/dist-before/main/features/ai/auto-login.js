"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEntryById = void 0;
exports.attemptAutoLogin = attemptAutoLogin;
exports.hasAutoLoginAccountFor = hasAutoLoginAccountFor;
const password_1 = require("../password");
Object.defineProperty(exports, "getEntryById", { enumerable: true, get: function () { return password_1.getEntryById; } });
const frames_1 = require("./frames");
const ACCOUNTS_PAGE = 'browser://passwords';
// ===== 인페이지 스크립트 =====
// 탐색(discover)은 **비밀 없이** 돌고, 채우기(fill)는 같은 탐색을 **다시 돌려 스스로 재검증한 뒤**에만
// 값을 넣는다. 두 호출 사이에 페이지가 바뀌었으면 채우기 쪽이 독립적으로 거부한다(이중 방어).
const HELPERS = `
function bbVis(el){
  if(!el) return false;
  try{
    if(el.disabled) return true===false;
    var r=el.getBoundingClientRect();
    if(!(r.width>0&&r.height>0)) return false;
    var w=(el.ownerDocument&&el.ownerDocument.defaultView)||window;
    var cs=w.getComputedStyle(el);
    if(!cs) return false;
    if(cs.display==='none'||cs.visibility==='hidden'||cs.visibility==='collapse') return false;
    if(parseFloat(cs.opacity||'1')===0) return false;
  }catch(e){ return false; }
  return true;
}
function bbAttr(el,n){ try{ return String(el.getAttribute(n)||''); }catch(e){ return ''; } }
function bbLabel(el){
  var s='';
  try{
    s = bbAttr(el,'aria-label')||bbAttr(el,'placeholder')||'';
    if(!s && el.labels && el.labels[0]) s=(el.labels[0].innerText||el.labels[0].textContent||'');
    if(!s) s = bbAttr(el,'name')||bbAttr(el,'id')||'';
  }catch(e){}
  return String(s||'').replace(/\\s+/g,' ').trim();
}
function bbBtnText(el){
  try{ return String((el.value&&el.tagName==='INPUT'?el.value:(el.innerText||el.textContent||''))||'').replace(/\\s+/g,' ').trim(); }catch(e){ return ''; }
}
// 가입/비밀번호 변경 화면 표식 — **버튼 라벨과 구조**로만 판단한다. 본문에 '회원가입' 링크가 있다는 이유로
// 정상 로그인 폼을 거부하면 기능이 죽으므로, 문서 전체 텍스트는 쓰지 않는다.
var BB_SIGNUP_RE = /회원\\s*가입|가입\\s*하기|가입\\s*완료|sign\\s*up|signup|register|create\\s+account|비밀번호\\s*(변경|재설정|찾기)|change\\s+password|reset\\s+password|비밀번호\\s*확인|confirm\\s+password/i;
var BB_SUBMIT_RE = /로그인|sign\\s*in|log\\s*in|login|다음|next|계속|continue|확인|submit/i;
var BB_NEXT_RE = /다음|next|계속|continue/i;
var BB_USER_RE = /user(name)?|login|email|e-mail|account|아이디|이메일|사용자|계정|로그인/i;

function bbSubmitIn(scope, doc){
  var cands=[];
  try{
    var list=scope.querySelectorAll('button, input[type=submit], input[type=button], [role=button]');
    for(var i=0;i<list.length;i++){
      var b=list[i];
      if(!bbVis(b)) continue;
      if(b.disabled) continue;
      var t=bbBtnText(b)||bbAttr(b,'aria-label');
      var isSubmitType=(b.tagName==='BUTTON'&&(b.type==='submit'||!b.type))||(b.tagName==='INPUT'&&b.type==='submit');
      if(isSubmitType||BB_SUBMIT_RE.test(t)) cands.push({el:b,text:t,submitType:isSubmitType});
    }
  }catch(e){}
  return cands;
}

// 로그인 폼을 찾아 검사한다. 비밀은 여기 관여하지 않는다.
function bbDiscover(){
  var out={ href: location.href, origin: location.origin };
  if(location.protocol!=='https:') return { ok:false, reason:'not-https', detail: location.protocol, meta:out };
  var pws=[], allPw=[];
  try{
    var ps=document.querySelectorAll('input[type=password]');
    for(var i=0;i<ps.length;i++){ allPw.push(ps[i]); if(bbVis(ps[i])&&!ps[i].disabled&&!ps[i].readOnly) pws.push(ps[i]); }
  }catch(e){}

  // ---- 2단계 로그인 1단계(아이디 먼저) ----
  if(pws.length===0){
    if(allPw.length>0) return { ok:false, reason:'hidden-form', detail:'비밀번호 칸이 화면에 보이지 않습니다', meta:out };
    var idf=bbIdentifierStage();
    if(idf) return idf;
    return { ok:false, reason:'no-form', detail:'로그인 입력칸을 찾지 못했습니다', meta:out };
  }
  if(pws.length>1) return { ok:false, reason:'multi-password', detail:'비밀번호 칸이 '+pws.length+'개입니다(가입·비밀번호 변경 폼으로 보입니다)', meta:out };

  var pw=pws[0];
  for(var k=0;k<allPw.length;k++){
    if((bbAttr(allPw[k],'autocomplete')||'').toLowerCase().indexOf('new-password')>=0)
      return { ok:false, reason:'new-password', detail:'새 비밀번호 입력 폼입니다', meta:out };
  }
  var form=null;
  try{ form=pw.form||(pw.closest?pw.closest('form'):null); }catch(e){}
  if(form&&!bbVis(form)) return { ok:false, reason:'hidden-form', detail:'폼이 화면에 보이지 않습니다', meta:out };

  // 폼 action 검사 — 다른 origin 이거나 https→http 다운그레이드면 거부.
  var action='';
  if(form){
    try{ action=String(form.action||''); }catch(e){ action=''; }
    if(action){
      var au=null; try{ au=new URL(action, location.href); }catch(e){ au=null; }
      if(!au) return { ok:false, reason:'bad-action', detail:'폼 전송 주소를 해석할 수 없습니다', meta:out };
      if(au.protocol!=='https:') return { ok:false, reason:'downgrade', detail:'폼이 '+au.protocol+' 로 전송합니다', meta:out };
      if(au.origin!==location.origin) return { ok:false, reason:'cross-origin-action', detail:'폼이 다른 사이트('+au.origin+')로 전송합니다', meta:out };
      if(/\\/(signup|sign-up|register|join|account\\/new)(\\/|$|\\?)/i.test(au.pathname))
        return { ok:false, reason:'signup-action', detail:'가입 주소로 전송하는 폼입니다', meta:out };
    }
  }

  var scope=form||document;
  var subs=bbSubmitIn(scope, document);
  for(var s=0;s<subs.length;s++){
    if(BB_SIGNUP_RE.test(subs[s].text))
      return { ok:false, reason:'signup-form', detail:'버튼이 "'+subs[s].text.slice(0,20)+'" 입니다', meta:out };
  }
  if(subs.length===0&&!form) return { ok:false, reason:'no-submit', detail:'로그인 버튼을 찾지 못했습니다', meta:out };

  // 아이디 칸 — 힌트가 확실하거나 후보가 하나뿐일 때만. 모호하면 거부.
  var uv=bbUserField(scope, pw);
  if(uv.reason) return { ok:false, reason:uv.reason, detail:uv.detail, meta:out };

  return {
    ok:true, stage:'password', meta:out,
    hasUser: !!uv.el, userLabel: uv.el?bbLabel(uv.el).slice(0,40):'',
    submitText: subs.length?subs[0].text.slice(0,30):'', hasForm: !!form, action: action?action.slice(0,120):'',
  };
}

function bbUserField(scope, pw){
  var cands=[];
  try{
    var list=scope.querySelectorAll('input');
    for(var i=0;i<list.length;i++){
      var el=list[i];
      var t=String(el.type||'text').toLowerCase();
      if(t!=='text'&&t!=='email'&&t!=='tel'&&t!=='') continue;
      if(!bbVis(el)||el.disabled||el.readOnly) continue;
      var ac=(bbAttr(el,'autocomplete')||'').toLowerCase();
      var lab=bbLabel(el);
      var score=0;
      if(ac.indexOf('username')>=0||ac==='email') score=100;
      else if(t==='email') score=60;
      else if(BB_USER_RE.test(lab)) score=50;
      if(pw&&el.compareDocumentPosition&&(el.compareDocumentPosition(pw)&4)) score+=10; // pw 보다 앞
      cands.push({el:el,score:score,lab:lab});
    }
  }catch(e){}
  if(cands.length===0) return { el:null };   // 비밀번호만 있는 단계(2단계 로그인의 2단계) — 허용
  cands.sort(function(a,b){ return b.score-a.score; });
  var top=cands[0];
  if(top.score<50&&cands.length>1)
    return { reason:'ambiguous-user', detail:'아이디 칸 후보가 '+cands.length+'개인데 구분할 근거가 없습니다' };
  if(cands.length>1&&cands[1].score===top.score&&top.score<100)
    return { reason:'ambiguous-user', detail:'아이디 칸 후보가 동점입니다' };
  return { el: top.el };
}

// 2단계 로그인의 1단계: 비밀번호 칸이 없고, **autocomplete 로 명시된** 아이디 칸 하나 + 다음/로그인 버튼.
// autocomplete 는 페이지 작성자가 "이건 로그인 식별자" 라고 적어 둔 것이라 검색창 따위와 혼동되지 않는다.
function bbIdentifierStage(){
  var el=null, n=0;
  try{
    var list=document.querySelectorAll('input[autocomplete~=username i], input[autocomplete=email i], input[autocomplete="username webauthn" i]');
    for(var i=0;i<list.length;i++){ if(bbVis(list[i])&&!list[i].disabled&&!list[i].readOnly){ el=list[i]; n++; } }
  }catch(e){}
  if(n!==1||!el) return null;
  var form=null; try{ form=el.form||(el.closest?el.closest('form'):null); }catch(e){}
  if(form&&!bbVis(form)) return null;
  if(form){
    var au=null; try{ au=new URL(String(form.action||''), location.href); }catch(e){ au=null; }
    if(au&&(au.protocol!=='https:'||au.origin!==location.origin)) return null;
  }
  var subs=bbSubmitIn(form||document, document);
  var pick=null;
  for(var s=0;s<subs.length;s++){
    if(BB_SIGNUP_RE.test(subs[s].text)) return null;
    if(!pick&&(BB_NEXT_RE.test(subs[s].text)||subs[s].submitType)) pick=subs[s];
  }
  if(!pick) return null;
  return { ok:true, stage:'identifier', meta:{ href:location.href, origin:location.origin },
           hasUser:true, userLabel:bbLabel(el).slice(0,40), submitText:pick.text.slice(0,30), hasForm:!!form, action:'' };
}

function bbSetValue(el, v){
  try{
    var w=(el.ownerDocument&&el.ownerDocument.defaultView)||window;
    var proto=el.tagName==='TEXTAREA'?w.HTMLTextAreaElement.prototype:w.HTMLInputElement.prototype;
    var d=Object.getOwnPropertyDescriptor(proto,'value');
    if(d&&d.set) d.set.call(el, v); else el.value=v;
  }catch(e){ try{ el.value=v; }catch(e2){} }
  try{ el.dispatchEvent(new Event('input',{bubbles:true})); }catch(e){}
  try{ el.dispatchEvent(new Event('change',{bubbles:true})); }catch(e){}
}
`;
/** 탐색만 — 비밀 없음. */
const DISCOVER_SCRIPT = `(function(){${HELPERS}
try{ return bbDiscover(); }catch(e){ return { ok:false, reason:'error', detail:String(e&&e.message||e) }; }
})()`;
/**
 * 채우기 + 제출. **탐색을 다시 돌려 스스로 재검증**한 뒤에만 값을 넣는다 —
 * 두 호출 사이에 페이지가 바뀌었으면 여기서 거부한다.
 * 인자는 JSON 리터럴로만 끼워 넣는다(문자열 이스케이프 사고 방지).
 */
function fillScript(args) {
    return `(function(){${HELPERS}
var A=${JSON.stringify(args)};
try{
  if(location.href!==A.expectHref) return { ok:false, reason:'stale', detail:'페이지가 바뀌었습니다' };
  var d=bbDiscover();
  if(!d||!d.ok) return { ok:false, reason:(d&&d.reason)||'error', detail:(d&&d.detail)||'' };
  if(d.stage!==A.stage) return { ok:false, reason:'stale', detail:'화면 단계가 바뀌었습니다' };
  if(d.meta.origin!==new URL(A.expectHref).origin) return { ok:false, reason:'stale', detail:'출처가 바뀌었습니다' };

  var pw=null, scope=document, form=null;
  if(A.stage==='password'){
    var ps=document.querySelectorAll('input[type=password]'); var vis=[];
    for(var i=0;i<ps.length;i++) if(bbVis(ps[i])&&!ps[i].disabled&&!ps[i].readOnly) vis.push(ps[i]);
    if(vis.length!==1) return { ok:false, reason:'stale', detail:'비밀번호 칸 수가 달라졌습니다' };
    pw=vis[0];
    try{ form=pw.form||(pw.closest?pw.closest('form'):null); }catch(e){}
    scope=form||document;
  } else {
    var il=document.querySelectorAll('input[autocomplete~=username i], input[autocomplete=email i], input[autocomplete="username webauthn" i]');
    var iv=[]; for(var j=0;j<il.length;j++) if(bbVis(il[j])&&!il[j].disabled&&!il[j].readOnly) iv.push(il[j]);
    if(iv.length!==1) return { ok:false, reason:'stale', detail:'아이디 칸 수가 달라졌습니다' };
    try{ form=iv[0].form||(iv[0].closest?iv[0].closest('form'):null); }catch(e){}
    scope=form||document;
  }

  var uf=bbUserField(scope, pw);
  if(uf.reason) return { ok:false, reason:uf.reason, detail:uf.detail };
  var filled=[];
  if(uf.el){ try{ uf.el.focus(); }catch(e){} bbSetValue(uf.el, A.username); filled.push('id'); }
  if(A.stage==='password'){ try{ pw.focus(); }catch(e){} bbSetValue(pw, A.password); filled.push('pw'); }
  if(A.stage==='identifier'&&!uf.el) return { ok:false, reason:'stale', detail:'아이디 칸을 찾지 못했습니다' };

  // 제출 — 폼이 있으면 requestSubmit(버튼) 으로 폼의 정상 경로를 타고, 없으면 버튼을 누른다.
  var subs=bbSubmitIn(scope, document);
  var btn=null;
  for(var s=0;s<subs.length;s++){
    if(BB_SIGNUP_RE.test(subs[s].text)) return { ok:false, reason:'signup-form', detail:'제출 버튼이 가입 버튼입니다' };
    if(!btn&&(subs[s].submitType||BB_SUBMIT_RE.test(subs[s].text))) btn=subs[s].el;
  }
  var how='';
  if(form&&form.requestSubmit){
    try{
      if(btn&&btn.form===form&&(btn.tagName==='BUTTON'||btn.tagName==='INPUT')) { form.requestSubmit(btn); how='requestSubmit(btn)'; }
      else { form.requestSubmit(); how='requestSubmit()'; }
    }catch(e){ how=''; }
  }
  if(!how&&btn){ try{ btn.click(); how='click'; }catch(e){} }
  if(!how&&form){ try{ form.submit(); how='form.submit'; }catch(e){} }
  if(!how) return { ok:false, reason:'no-submit', detail:'제출 수단을 찾지 못했습니다', filled:filled.join('+') };
  return { ok:true, how:how, filled:filled.join('+') };
}catch(e){ return { ok:false, reason:'error', detail:String(e&&e.message||e) }; }
})()`;
}
/** 제출 뒤 상태 확인 — 비밀 없음. */
const PROBE_SCRIPT = `(function(){${HELPERS}
try{
  var pwVisible=false;
  var ps=document.querySelectorAll('input[type=password]');
  for(var i=0;i<ps.length;i++) if(bbVis(ps[i])) { pwVisible=true; break; }
  // OTP / 2단계 인증 — 자동으로 처리하지 않는다. 사람에게 넘기기 위한 **감지**일 뿐이다.
  var otp=false, otpMark='';
  try{
    var oc=document.querySelectorAll('input[autocomplete~="one-time-code" i], input[name*="otp" i], input[id*="otp" i], input[name*="verificationcode" i]');
    for(var o=0;o<oc.length;o++) if(bbVis(oc[o])) { otp=true; otpMark='one-time-code 입력칸'; break; }
  }catch(e){}
  var bodyText=(document.body?document.body.innerText:'')||'';
  bodyText=bodyText.replace(/\\n{3,}/g,'\\n\\n').trim();
  if(!otp&&bodyText.length<900&&/인증\\s*코드|인증번호|2단계\\s*인증|verification\\s+code|two[- ]factor|authenticator|일회용\\s*비밀번호/i.test(bodyText)){
    var mm=bodyText.match(/인증\\s*코드|인증번호|2단계\\s*인증|verification\\s+code|two[- ]factor|authenticator|일회용\\s*비밀번호/i);
    // 입력칸이 함께 있어야 한다 — 안내 문구만으로는 판단하지 않는다.
    var anyInput=false;
    try{ var ai=document.querySelectorAll('input:not([type=hidden])'); for(var q=0;q<ai.length;q++) if(bbVis(ai[q])){ anyInput=true; break; } }catch(e){}
    if(anyInput&&mm){ otp=true; otpMark='"'+mm[0]+'" + 입력칸'; }
  }
  var captcha=false, capMark='';
  try{
    var cs='.g-recaptcha, .h-captcha, #captcha, [data-sitekey], iframe[src*="recaptcha/api2"], iframe[src*="hcaptcha.com"],'
      + ' iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], iframe[src*="geetest"]';
    var ce=document.querySelector(cs);
    if(ce&&bbVis(ce)){ captcha=true; capMark=ce.tagName.toLowerCase(); }
  }catch(e){}
  // 자격증명 오류 문구 — 화면 전체가 아니라 "짧은 오류 문장" 패턴만.
  var err='';
  var em=bodyText.match(/[^\\n]{0,60}(비밀번호[^\\n]{0,12}(틀렸|올바르지|일치하지|다릅니다)|아이디[^\\n]{0,12}(틀렸|올바르지|일치하지)|로그인[^\\n]{0,8}(실패|할 수 없)|incorrect\\s+(password|username|email)|invalid\\s+(password|credentials|login|username)|didn'?t match|wrong password|authentication failed)[^\\n]{0,60}/i);
  if(em) err=em[0].replace(/\\s+/g,' ').trim().slice(0,140);
  return { url: location.href, pwVisible: pwVisible, otp: otp, otpMark: otpMark, captcha: captcha, capMark: capMark, err: err, textLen: bodyText.length };
}catch(e){ return { url: location.href, pwVisible:false, otp:false, captcha:false, err:'', textLen:0 }; }
})()`;
/** 남은 비밀번호 값 지우기 — 사람에게 넘기기 전에 DOM 에 평문이 남지 않게. */
const CLEAR_SCRIPT = `(function(){${HELPERS}
try{ var n=0; var ps=document.querySelectorAll('input[type=password]');
  for(var i=0;i<ps.length;i++){ if(ps[i].value){ bbSetValue(ps[i],''); n++; } }
  return n; }catch(e){ return 0; }
})()`;
function frameOrigin(u) {
    try {
        return new URL(u).origin;
    }
    catch {
        return '';
    }
}
function safeFrameUrl(f) {
    try {
        return f.url;
    }
    catch {
        return '';
    }
}
async function run(frame, code) {
    try {
        return (await frame.executeJavaScript(code, true));
    }
    catch {
        return null;
    }
}
/**
 * 로그인 폼이 실제로 있는 프레임을 고른다. 판단 근거는 페이지가 말한 호스트가 아니라
 * **메인 프로세스가 읽은 프레임 URL** 이다. 허용 범위 밖 프레임은 애초에 열거되지 않는다.
 */
function candidateFrames(wc, allowedHosts, frameHost) {
    const out = [];
    let main = null;
    try {
        main = wc.mainFrame;
    }
    catch {
        main = null;
    }
    if (main) {
        const u = safeFrameUrl(main);
        if ((0, frames_1.hostAllowed)(u, allowedHosts))
            out.push({ frame: main, url: u, origin: frameOrigin(u) });
    }
    const { roots } = (0, frames_1.listObservationFrames)(wc, allowedHosts);
    for (const r of roots)
        out.push({ frame: r.frame, url: r.url, origin: frameOrigin(r.url) });
    if (frameHost) {
        // 신호가 특정 프레임에서 왔다면 그 호스트를 먼저 본다(최상위도 후보로 남긴다).
        out.sort((a, b) => ((0, frames_1.hostOf)(b.url) === frameHost ? 1 : 0) - ((0, frames_1.hostOf)(a.url) === frameHost ? 1 : 0));
    }
    return out.filter((t) => t.origin.startsWith('https:'));
}
const VERIFY_TIMEOUT_MS = 20_000;
const VERIFY_POLL_MS = 500;
async function attemptAutoLogin(ctx) {
    if (ctx.readOnly)
        return { status: 'skip', detail: '읽기 전용 작업' };
    if (!(0, password_1.isPasswordStorageAvailable)())
        return { status: 'skip', detail: 'safeStorage 사용 불가' };
    // 1) 로그인 폼이 있는 프레임 찾기 — 실제 URL 기준.
    const targets = candidateFrames(ctx.wc, ctx.allowedHosts, ctx.frameHost);
    let target = null;
    let disc = null;
    let firstRefusal = null;
    for (const t of targets) {
        const d = await run(t.frame, DISCOVER_SCRIPT);
        if (!d)
            continue;
        if (d.ok) {
            target = t;
            disc = d;
            break;
        }
        // 거부 사유가 "폼이 없다" 가 아니면(= 로그인 폼처럼 보이는데 수상하다) 기억해 뒀다가 사용자에게 알린다.
        if (!firstRefusal && d.reason && d.reason !== 'no-form' && d.reason !== 'not-https') {
            firstRefusal = d;
            target = t;
        }
    }
    if (!disc || !target) {
        if (firstRefusal) {
            return {
                status: 'handoff',
                detail: `폼 거부: ${firstRefusal.reason}`,
                reason: `저장된 계정으로 자동 로그인하지 않았습니다 — ${firstRefusal.detail || firstRefusal.reason}.`
                    + ' 안전을 위해 이런 폼에는 비밀번호를 넣지 않습니다. 브라우저 창에서 직접 로그인하신 뒤 "계속" 이라고 알려주세요.',
            };
        }
        return { status: 'skip', detail: '자동 입력 가능한 로그인 폼 없음' };
    }
    const origin = target.origin;
    const pageUrl = disc.meta?.href || target.url;
    // 페이지가 스스로 말한 origin 과 메인이 읽은 origin 이 다르면 신뢰하지 않는다.
    if (disc.meta && disc.meta.origin !== origin) {
        return { status: 'skip', detail: 'origin 불일치(페이지 보고 vs 메인)' };
    }
    if (!(0, frames_1.hostAllowed)(pageUrl, ctx.allowedHosts)) {
        return { status: 'skip', detail: '작업 허용 범위 밖' };
    }
    // 2) 동의된 계정 고르기 — 정확히 같은 origin, 계정별 허용 켜짐.
    const entries = (0, password_1.autoLoginEntriesFor)(origin);
    if (entries.length === 0) {
        const savedOff = (0, password_1.savedButNotAllowedCount)(origin);
        return {
            status: 'skip',
            detail: savedOff > 0 ? '허용 꺼진 계정만 있음' : '저장된 계정 없음',
            needsAccountSetup: true,
            reason: savedOff > 0
                ? `${origin} 에 저장된 계정은 있지만 자동 로그인이 켜져 있지 않습니다. ${ACCOUNTS_PAGE} 에서 그 계정의 "자동 로그인 허용" 을 켜시면 다음부터 제가 직접 로그인합니다.`
                : `${origin} 에 저장된 계정이 없습니다. ${ACCOUNTS_PAGE} 에서 계정을 등록하고 "자동 로그인 허용" 을 켜시면 다음부터 제가 직접 로그인합니다.`,
        };
    }
    const usable = entries.filter((e) => !(0, password_1.isAutoLoginBlocked)(e));
    if (usable.length === 0) {
        const e = entries[0];
        return {
            status: 'handoff',
            detail: '자동 로그인 잠김',
            needsAccountSetup: true,
            reason: `${origin} 자동 로그인이 잠겨 있습니다 — 로그인이 ${e.autoLoginFailures ?? 0}회 연속 실패했습니다.`
                + ` 계정이 잠기는 것을 막기 위해 더 시도하지 않습니다. ${ACCOUNTS_PAGE} 에서 비밀번호를 확인·수정해 주세요.`,
        };
    }
    let entry = usable[0];
    if (usable.length > 1 && !usable.some((e) => e.preferred === true)) {
        return {
            status: 'handoff',
            detail: '계정 다중 — 기본 미지정',
            needsAccountSetup: true,
            reason: `${origin} 에 자동 로그인이 허용된 계정이 ${usable.length}개입니다(${usable.map((e) => e.username).join(', ')}).`
                + ` 어느 계정을 쓸지 알 수 없어 입력하지 않았습니다. ${ACCOUNTS_PAGE} 에서 기본 계정을 지정해 주세요.`,
        };
    }
    const pref = usable.find((e) => e.preferred === true);
    if (pref)
        entry = pref;
    // 3) 비밀 꺼내기 — 이 지역 변수 밖으로 나가지 않는다.
    const secret = (0, password_1.secretForAutoLogin)(entry.id);
    if (secret === null) {
        return { status: 'handoff', detail: '복호화 실패', needsAccountSetup: true,
            reason: `저장된 비밀번호를 복호화하지 못했습니다(다른 컴퓨터·다른 계정에서 복사한 데이터일 수 있습니다). ${ACCOUNTS_PAGE} 에서 다시 등록해 주세요.` };
    }
    const stage = disc.stage === 'identifier' ? 'identifier' : 'password';
    ctx.trace?.('자동 로그인', `${origin} · ${entry.username}${stage === 'identifier' ? ' (아이디 먼저 단계)' : ''}`, true);
    // 4) 부작용 직전 마지막 관문 — 정지·취소 뒤에는 입력도 제출도 없다.
    if (await ctx.gate())
        return { status: 'skip', detail: '중단됨' };
    // 프레임이 그 사이 다른 페이지로 갔는지 재확인(stale).
    if (safeFrameUrl(target.frame) !== pageUrl) {
        return { status: 'skip', detail: '프레임이 그 사이 이동함' };
    }
    const fill = await run(target.frame, fillScript({ username: entry.username, password: secret, expectHref: pageUrl, stage }));
    if (!fill || !fill.ok) {
        const why = fill?.detail || fill?.reason || '알 수 없는 이유';
        await run(target.frame, CLEAR_SCRIPT);
        return {
            status: 'handoff', detail: `입력 거부: ${fill?.reason ?? 'error'}`,
            reason: `자동 로그인을 중단했습니다 — ${why}. 브라우저 창에서 직접 로그인하신 뒤 "계속" 이라고 알려주세요.`,
        };
    }
    // 5) 아이디 먼저 단계였다면 비밀번호 단계로 넘어가길 기다렸다가 한 번 더.
    if (stage === 'identifier') {
        const moved = await waitForPasswordStage(ctx, target, pageUrl);
        if (moved.status !== 'success')
            return moved.result;
        const t2 = moved.target;
        if (await ctx.gate())
            return { status: 'skip', detail: '중단됨' };
        const url2 = safeFrameUrl(t2.frame);
        const d2 = await run(t2.frame, DISCOVER_SCRIPT);
        if (!d2 || !d2.ok || d2.stage !== 'password') {
            return { status: 'handoff', detail: '2단계 폼 확인 실패',
                reason: '아이디는 입력했지만 비밀번호 화면을 안전하게 확인하지 못했습니다. 브라우저 창에서 직접 이어서 로그인해 주세요.' };
        }
        if (frameOrigin(url2) !== origin) {
            return { status: 'handoff', detail: '2단계에서 출처 변경',
                reason: `로그인 도중 다른 사이트(${frameOrigin(url2)})로 넘어가 비밀번호를 넣지 않았습니다. 직접 로그인해 주세요.` };
        }
        const fill2 = await run(t2.frame, fillScript({ username: entry.username, password: secret, expectHref: d2.meta?.href || url2, stage: 'password' }));
        if (!fill2 || !fill2.ok) {
            await run(t2.frame, CLEAR_SCRIPT);
            return { status: 'handoff', detail: `2단계 입력 거부: ${fill2?.reason ?? 'error'}`,
                reason: `자동 로그인 2단계를 중단했습니다 — ${fill2?.detail || fill2?.reason || '알 수 없는 이유'}. 직접 로그인해 주세요.` };
        }
        target = t2;
    }
    // 6) 성공 확인 — 채워 넣은 것은 성공이 아니다.
    return await verifyLogin(ctx, target, entry.id, entry.username, origin, pageUrl);
}
/** 아이디 단계 제출 뒤 비밀번호 칸이 나타날 때까지(같은 출처에서) 기다린다. */
async function waitForPasswordStage(ctx, target, beforeUrl) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
        await sleep(VERIFY_POLL_MS);
        if (await ctx.gate())
            return { status: 'fail', result: { status: 'skip', detail: '중단됨' } };
        const cands = candidateFrames(ctx.wc, ctx.allowedHosts, ctx.frameHost)
            .filter((t) => t.origin === target.origin);
        for (const t of cands) {
            const p = await run(t.frame, PROBE_SCRIPT);
            if (!p)
                continue;
            if (p.captcha) {
                return { status: 'fail', result: { status: 'handoff', detail: 'CAPTCHA',
                        reason: '아이디를 입력하자 사람 확인(CAPTCHA) 화면이 나왔습니다. 자동으로 풀지 않습니다 — 직접 완료하신 뒤 "계속" 이라고 알려주세요.' } };
            }
            if (p.otp) {
                return { status: 'fail', result: { status: 'handoff', detail: '2단계 인증',
                        reason: '인증 코드(2단계 인증) 화면입니다. 코드는 대신 입력하지 않습니다 — 직접 입력하신 뒤 "계속" 이라고 알려주세요.' } };
            }
            if (p.pwVisible)
                return { status: 'success', target: t };
        }
    }
    return { status: 'fail', result: { status: 'handoff', detail: '2단계 대기 시간 초과',
            reason: `아이디를 입력했지만 비밀번호 화면이 나타나지 않았습니다(${beforeUrl}). 직접 이어서 로그인해 주세요.` } };
}
async function verifyLogin(ctx, target, entryId, username, origin, beforeUrl) {
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let last = null;
    while (Date.now() < deadline) {
        await sleep(VERIFY_POLL_MS);
        if (await ctx.gate())
            return { status: 'skip', detail: '중단됨' };
        // 최상위 기준으로 본다 — 로그인 후 iframe 이 통째로 사라지고 최상위가 넘어가는 사이트가 많다.
        let main = null;
        try {
            main = ctx.wc.mainFrame;
        }
        catch {
            main = null;
        }
        const topUrl = main ? safeFrameUrl(main) : '';
        // 로그인 폼이 있던 출처의 프레임들 + **최상위 프레임**(로그인 뒤 최상위가 다른 경로로 넘어가는 경우).
        const sameOrigin = candidateFrames(ctx.wc, ctx.allowedHosts, ctx.frameHost).filter((t) => t.origin === origin);
        const frames = [...sameOrigin];
        if (main && topUrl && (0, frames_1.hostAllowed)(topUrl, ctx.allowedHosts)
            && !frames.some((t) => safeFrameUrl(t.frame) === topUrl)) {
            frames.unshift({ frame: main, url: topUrl, origin: frameOrigin(topUrl) });
        }
        let pwVisible = false;
        let probe = null;
        for (const t of frames) {
            const p = await run(t.frame, PROBE_SCRIPT);
            if (!p)
                continue;
            if (p.pwVisible)
                pwVisible = true;
            if (!probe)
                probe = p;
            else if (p.err && !probe.err)
                probe = p;
            if (p.otp || p.captcha) {
                probe = p;
                break;
            }
        }
        // ⚠ 아무 프레임도 읽지 못했다면 **아무 결론도 내지 않는다.**
        // 예전에는 "읽지 못했는데 최상위 URL 이 바뀌었으면 성공" 으로 단정했다. 그러나 화면 전환 도중에는
        // executeJavaScript 가 흔히 실패하고, **로그인 실패 리다이렉트(/login?e=1)도 URL 변경**이다 —
        // 즉 틀린 비밀번호를 성공으로 보고하고 실패 누적까지 지워 버렸다(하네스 SL12 가 실측으로 잡음).
        // 못 본 것은 성공의 근거가 아니다. 계속 폴링하고, 끝내 못 보면 '모호' 로 사람에게 넘긴다.
        if (!probe)
            continue;
        last = probe;
        // ① 자격증명 오류가 가장 먼저 — 틀린 비밀번호로 화면이 바뀌어도 성공으로 읽지 않는다.
        if (probe.err) {
            await clearSecrets(ctx, origin);
            const f = (0, password_1.noteAutoLoginFailure)(entryId);
            ctx.trace?.('자동 로그인 실패', `${origin} · ${username} — ${probe.err}`, false);
            return {
                status: 'handoff', detail: `자격증명 오류(${f.failures}/${password_1.MAX_AUTO_LOGIN_FAILURES})`, needsAccountSetup: true,
                reason: `저장된 비밀번호로 로그인에 실패했습니다 — "${probe.err}".`
                    + (f.blocked
                        ? ` ${password_1.MAX_AUTO_LOGIN_FAILURES}회 연속 실패라 계정 잠김을 막기 위해 자동 로그인을 중단했습니다. ${ACCOUNTS_PAGE} 에서 비밀번호를 고쳐 주세요.`
                        : ` ${ACCOUNTS_PAGE} 에서 비밀번호를 확인해 주시거나, 브라우저 창에서 직접 로그인하신 뒤 "계속" 이라고 알려주세요.`),
            };
        }
        // ② CAPTCHA / 2단계 인증 — 풀지 않는다. 사람에게 넘긴다.
        if (probe.captcha) {
            await clearSecrets(ctx, origin);
            return { status: 'handoff', detail: 'CAPTCHA',
                reason: '로그인 도중 사람 확인(CAPTCHA) 화면이 나왔습니다. 자동으로 풀지 않습니다 — 브라우저 창에서 직접 완료하신 뒤 "계속" 이라고 알려주세요.' };
        }
        if (probe.otp) {
            return { status: 'handoff', detail: '2단계 인증',
                reason: `비밀번호는 입력됐고 인증 코드(2단계 인증) 화면입니다${probe.otpMark ? ` — ${probe.otpMark}` : ''}.`
                    + ' 코드는 대신 입력하지 않습니다 — 브라우저 창에서 직접 입력하신 뒤 "계속" 이라고 알려주세요.' };
        }
        // ③ 성공 — 비밀번호 칸이 사라졌고 화면이 실제로 넘어갔다.
        if (!pwVisible && ((topUrl && topUrl !== beforeUrl) || (probe.url && probe.url !== beforeUrl))) {
            (0, password_1.clearAutoLoginFailures)(entryId);
            (0, password_1.markUsed)(entryId);
            ctx.trace?.('자동 로그인 성공', `${origin} · ${username} → ${topUrl || probe.url}`, true);
            return { status: 'success', username, origin, detail: `이동: ${topUrl || probe.url}` };
        }
    }
    // ④ 모호 — 성공했다고 주장하지 않는다.
    await clearSecrets(ctx, origin);
    return {
        status: 'handoff', detail: '성공 여부 모호',
        reason: '로그인을 시도했지만 성공했는지 확인하지 못했습니다'
            + (last ? ` (현재 화면: ${last.url})` : '')
            + '. 잘못 진행하지 않도록 여기서 멈춥니다 — 브라우저 창에서 확인하신 뒤 "계속" 이라고 알려주세요.',
    };
}
/** 사람에게 넘기기 전에 화면에 남은 비밀번호 값을 지운다. */
async function clearSecrets(ctx, origin) {
    const frames = candidateFrames(ctx.wc, ctx.allowedHosts).filter((t) => t.origin === origin);
    for (const t of frames) {
        await run(t.frame, CLEAR_SCRIPT);
    }
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/** 이 화면에 대해 자동 로그인을 시도할 만한가 — agent 가 관찰 신호로 먼저 거르는 값싼 검사. */
function hasAutoLoginAccountFor(url) {
    const o = frameOrigin(url);
    if (!o.startsWith('https:'))
        return false;
    return (0, password_1.autoLoginEntriesFor)(o).length > 0;
}
