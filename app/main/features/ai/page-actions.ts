import { type WebContents, type WebFrameMain } from 'electron'
import path from 'node:path'
import {
  listObservationFrames, frameFromId, computeFrameOffset, setRefRouting, resolveRefRoute,
  hostAllowed, hostOf, type RefSlot,
} from './frames'
import { POST_TIME_FN_SRC } from './agent-gate'

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
  // 교차 출처 프레임 — 이제 **관찰·조작한다**(WebFrameMain). 여기엔 그 프레임들의 요약이 담긴다.
  // elements 에는 이 프레임들의 요소가 전역 번호로 합쳐져 들어가 있다(이름에 "(프레임 호스트)" 표시).
  frames?: Array<{ host: string; url: string; title: string; text: string; elementCount: number; challenge?: { kind: 'captcha' | 'login'; marker: string }; loginHint?: { identifierFirst: true; marker: string } }>
  // 로그인 / CAPTCHA 화면 신호(구조적 근거만). 판정·문구는 challenge-detect.ts 가 맡는다.
  challenge?: { kind: 'captcha' | 'login'; marker: string }
  // 연성 로그인 신호 — "아이디 먼저" 2단계 로그인의 1단계. **이것만으로는 작업을 멈추지 않는다**
  // (멈추면 로그인 위젯이 있는 평범한 페이지에서 오탐). 저장된 계정으로 자동 로그인할지 고를 때만 본다.
  loginHint?: { identifierFirst: true; marker: string }
  // 허용 사이트 목록 밖이라 **일부러 열지 않은** 프레임의 호스트. 안의 텍스트·요소는 단 한 글자도
  // 읽지 않는다(모델 프롬프트로 가지 않는다). 사용자가 명시 승인하면 범위가 넓어져 다음 관찰부터 보인다.
  blockedFrames?: string[]
  // 기술적으로 접근하지 못한 프레임 — 정직하게 "여긴 못 봤다"로 남긴다.
  // (프레임 열거 자체가 불가능한 환경이거나 프레임 스크립트 실행이 실패한 경우. 평소에는 비어 있다.)
  crossOriginFrames?: string[]
  // 최상위 문서 JS 가 "안을 못 본" 프레임 목록(내부용) — 위 두 목록과 대조해 무엇이 진짜 미관찰인지 가린다.
  frameStubs?: Array<{ src: string; label: string }>
  // 관찰 세대(epoch) — 이 관찰에서 나온 ref 번호들은 이 토큰과 짝일 때만 유효하다는 표. 실행 함수에
  // epoch 를 함께 넘기면, 그 사이 재관찰(다른 탭에 갔다 오거나 SPA 재렌더 후 다시 observePage)이 있었는지
  // pick() 이 검증한다 — 옛 번호로 "지금 화면의 다른 요소"를 집는 사고를 막는다(과제1). 탭 id 를 섞어
  // 탭이 달라도 절대 같은 토큰이 나오지 않는다(같은 이유로 다른 탭의 ref 는 애초에 먹히지 않는다).
  epoch: string
}

export interface AgentAction {
  thought?: string
  action: 'click' | 'type' | 'navigate' | 'scroll' | 'read' | 'wait' | 'done' | 'ask' | 'open_tab' | 'switch_tab' | 'close_tab' | 'remember' | 'upload_file' | 'click_at' | 'extract'
    | 'wait_for' | 'key' | 'hover' | 'drag' | 'download' | 'run_js' | 'autofill' | 'note' | 'report' | 'expect'
    | 'select' | 'request_scope' | 'mark_baseline' | 'capture_image'
  ref?: number
  text?: string
  url?: string
  urlContains?: string   // expect: 현재 URL 에 이 문자열이 포함돼야 통과
  urlChanged?: boolean   // expect: 동작 전과 URL 이 달라졌으면 통과(문구를 모를 때)
  changed?: boolean      // expect: 화면(본문·요소)이 유의미하게 바뀌었으면 통과(문구를 모를 때) — 바뀐 내용이 done 에 요약된다
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
  host?: string          // request_scope: 허용 목록에 추가를 요청할 호스트(사용자 승인 필요)
  artifact?: string      // upload_file: 이 작업이 만든 산출물 id(자료 폴더 대신)
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
// 두 번째 인자 epoch(과제1) — 넘기면 지금 레지스트리의 세대와 일치하는지, 요소가 속한 문서(프레임)가
// 관찰 당시와 같은 페이지인지까지 검증한다. 실패 사유는 pick.reason 에 남겨(함수 객체 프로퍼티 — 같은
// executeJavaScript 안에서 pick() 직후 동기적으로 읽으면 항상 그 호출의 결과다) 호출부가 사람이 읽을
// 메시지를 만들 수 있게 한다. epoch 를 안 넘기면(하위호환) 세대·프레임 검사를 생략하고 예전과 동일하게 동작한다.
const PICK_FN = `function pick(r,epoch){pick.reason='';var A=window['${REF_KEY}'];if(!A){pick.reason='stale';return null;}`
  // 관찰 세대(epoch) 불일치 — 탭을 전환했다 돌아오거나 SPA 재렌더 후 다시 observePage 를 부르면 레지스트리가
  // 통째로 새로 만들어지며 __epoch 도 바뀐다(observePage 참고). 옛 번호를 그대로 쓰면 지금 화면에서 그 자리에
  // 나타난 "다른" 요소를 집게 되므로, 넘어온 epoch 가 지금 것과 다르면 즉시 거부한다.
  + `if(epoch!=null&&A.__epoch!==epoch){pick.reason='epoch';return null;}`
  + `var it=A[r];if(!it||!it.e){pick.reason='stale';return null;}var el=it.e;`
  // 프레임 검사 — 요소가 속한 문서(top 또는 same-origin iframe)의 현재 URL 이 관찰 당시 기록한 것과
  // 다르면 거부한다. iframe 이 새 페이지로 넘어간 뒤 같은 슬롯에 생긴 다른 요소(예: 결제 iframe 이 다음
  // 단계로 넘어간 뒤 남은 참조로 그 화면의 버튼을 누르는 사고)를 막는다. cross-origin 프레임은 관찰
  // 단계에서부터 수집되지 않으므로(같은 파일의 collect() 주석 참고) 여기서 SecurityError 가 날 일은
  // 없지만, 어떤 이유로든 접근이 막히면 통과시킨다(과잉 차단보다 재관찰 유도가 먼저인 다른 검사들과 달리,
  // 이 값을 못 읽는 것 자체는 화면이 바뀌었다는 증거가 아니다). epoch 검사와 마찬가지로 epoch 를 넘긴
  // 호출자에게만 적용한다 — 아직 epoch 를 안 넘기는 호출자(agent.ts 배선 전)의 기존 동작을 그대로 보존.
  + `try{if(epoch!=null&&it.f){var fw=(el.ownerDocument&&el.ownerDocument.defaultView)||null;var curF=fw?((fw.location&&fw.location.href)||''):'';if(curF&&curF!==it.f){pick.reason='frame';return null;}}}catch(e){}`
  // React 재렌더로 관찰 때 요소가 DOM 에서 떨어지면(인스타 사이드바 "새로운 게시물" — 실사이트 2회 재현) 같은 이름의 요소를 다시 찾는다.
  + `try{if(!el.isConnected){var Q='a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[contenteditable=true],[onclick],[tabindex]';var cand=document.querySelectorAll(Q);var found=null;for(var qi=0;qi<cand.length&&!found;qi++){var ce=cand[qi];var cn='';try{cn=(ce.getAttribute('aria-label')||ce.getAttribute('placeholder')||ce.innerText||ce.textContent||'').replace(/\\s+/g,' ').trim();}catch(e){}if(cn&&it.n&&(cn===it.n||cn.indexOf(it.n)===0)){var cr=ce.getBoundingClientRect();if(cr.width>0&&cr.height>0)found=ce;}}if(!found){pick.reason='stale';return null;}el=found;it.e=found;}}catch(e){}`
  // 이름 계산은 관찰(nameOf)과 **같은 순서**여야 한다 — 다르면 라벨로 이름 붙은 입력칸("설명")·라디오("공개")가
  // value 와 비교돼 "다른 요소" 로 거부된다(2026-09-13, SNS 하네스 S3·S4).
  + `if(it.n){var cur='';try{var tg=el.tagName;cur=el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.getAttribute('data-placeholder')||el.getAttribute('aria-placeholder')||'';`
  + `if(!cur&&(tg==='INPUT'||tg==='TEXTAREA'||tg==='SELECT')){try{var lb=(el.labels&&el.labels[0])||(el.closest?el.closest('label'):null);if(lb){var lt='';var cs=lb.childNodes;for(var ci=0;ci<cs.length;ci++){var cn=cs[ci];if(cn===el)continue;if(cn.nodeType===3)lt+=cn.textContent;else if(cn.nodeType===1&&!cn.contains(el))lt+=(cn.innerText||cn.textContent||'');}cur=lt;}}catch(e){}}`
  + `if(!cur&&tg==='INPUT'&&String(el.type||'').toLowerCase()!=='password')cur=el.value||el.getAttribute('name')||el.getAttribute('title')||'';`
  + `if(!cur)cur=(el.innerText||el.textContent||'');if(!cur)cur=el.getAttribute('title')||el.getAttribute('alt')||el.getAttribute('name')||'';`
  + `cur=(cur+'').replace(/\\s+/g,' ').trim();}catch(e){cur='';}`
  // 접두 일치 허용 — 호버·펼침으로 라벨이 늘어나는 요소(인스타 사이드바 "새로운 게시물" → "새로운 게시물만들기")를 "다른 요소" 로
  // 거부하던 것(실사이트 draft 재실행 2026-09-13). 재활용 노드는 이름이 통째로 바뀌므로 접두 검사로도 여전히 걸러진다(A4).
  + `var a=it.n.slice(0,20),b=cur.slice(0,20);if(a&&b&&a!==b&&!(it.n.indexOf(cur)===0||cur.indexOf(it.n)===0)){pick.reason='name';return null;}}`
  + `return el;}`

// pick() 이 null 을 돌려줄 때의 pick.reason 을 사람이 읽을 한국어 문장으로. 여러 실행 함수가 공유한다.
const PICK_REASON_FN = `function pickReasonText(r){if(r==='epoch')return '관찰이 바뀌었습니다 — 다시 관찰하세요';if(r==='frame')return '요소가 다른 프레임으로 이동했습니다';if(r==='name')return '요소가 변경되어 안전하게 식별할 수 없습니다 — 다시 관찰하세요';return '요소를 찾을 수 없습니다(페이지가 바뀌었을 수 있음)';}`

// pick(ref, epoch) 호출 문자열을 만든다 — epoch 가 없으면(하위호환) 인자를 생략해 세대·프레임 검사를 건너뛴다.
function pickCallArg(epoch?: string): string {
  return epoch != null ? `,${JSON.stringify(epoch)}` : ''
}

// ===== 실행 대상(ExecTarget) — 이 ref 가 어느 프레임의 몇 번인가 =====
// 교차 출처 프레임의 요소도 모델에게는 그냥 번호 하나로 보인다. 실행할 때 그 번호를 (프레임, 프레임 안 번호)로
// 되돌리고, 그 프레임이 관찰 때와 같은 문서인지 확인한다. 프레임이 사라졌거나 다른 주소로 바뀌었으면 거부한다 —
// 옛 번호로 지금 프레임의 엉뚱한 요소를 건드리는 것이 이 검사가 막으려는 사고다.
interface ExecTarget {
  frame: WebFrameMain | null            // null = 최상위 프레임(기존 경로 그대로)
  localRef: number
  offset: { x: number; y: number } | null  // 최상위 뷰포트 기준 프레임 좌표. null = 좌표 불명(실제 입력 불가)
  frameHost: string | null
}

const TOP_TARGET = (ref: number): ExecTarget => ({ frame: null, localRef: ref, offset: { x: 0, y: 0 }, frameHost: null })

// ref → 실행 대상. 라우팅 정보가 없으면(= epoch 미전달, 또는 12회 이전의 낡은 관찰) 예전처럼 최상위로 본다.
// 낡은 관찰의 경우 페이지 안 레지스트리의 __epoch 도 이미 달라져 pick() 이 거부하므로 사고로 이어지지 않는다.
async function targetFor(ref: number, epoch?: string, opts?: { scrollIntoView?: boolean }): Promise<ExecTarget | RefFail> {
  const route = resolveRefRoute(epoch, ref)
  if (!route || route.frameId == null) return TOP_TARGET(ref)
  const frame = frameFromId(route.frameId, route.frameUrl)
  if (!frame) return { __fail: '그 요소가 있던 프레임이 사라지거나 다른 주소로 바뀌었습니다 — 다시 관찰하세요' }
  const offset = await computeFrameOffset(frame, { scrollIntoView: opts?.scrollIntoView !== false })
  return { frame, localRef: route.localRef, offset, frameHost: hostOf(route.frameUrl) }
}

// 대상 프레임(또는 최상위)에서 스크립트를 실행한다. WebFrameMain.executeJavaScript 는 그 프레임의 문서
// 컨텍스트에서 직접 돌아, 교차 출처여도 페이지 JS 의 SOP 제약을 받지 않는다(메인 프로세스 권한).
async function runInTarget(wc: WebContents, t: ExecTarget, code: string): Promise<unknown> {
  if (!t.frame) return wc.executeJavaScript(code, true)
  return t.frame.executeJavaScript(code, true)
}

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

// pick() 이 실패했을 때 사유를 담아 돌려주는 공용 실패 모양. dragOnPage·dropFilesOnRef 처럼 pointForRef 를
// 쓰는 여러 함수가 같은 판별을 반복하지 않도록 타입가드를 함께 둔다.
interface RefFail { __fail: string }
function isRefFail(v: unknown): v is RefFail {
  return !!v && typeof v === 'object' && '__fail' in (v as Record<string, unknown>)
}

// ref 의 화면(뷰포트) 중심 좌표를 구한다(호버·드래그용). 최상위 뷰포트 기준.
// epoch(과제1) 를 넘기면 pick() 이 세대·프레임을 검증하고, 실패 시 이유를 담은 RefFail 을 돌려준다.
// 교차 출처 프레임 안 요소면 그 프레임에서 rect 를 재고, 프레임 자신의 오프셋을 더해 최상위 좌표로 바꾼다.
async function pointForTarget(wc: WebContents, t: ExecTarget, epoch?: string): Promise<{ x: number; y: number; name: string } | RefFail | null> {
  if (!t.offset) return { __fail: '프레임의 화면 위치를 계산할 수 없습니다 — 실제 입력 대신 폴백을 씁니다' }
  try {
    const r = (await runInTarget(wc, t, `
(function(){
  ${PICK_FN}
  ${PICK_REASON_FN}
  ${FRAME_OFFSET_FN}
  var el = pick(${t.localRef}${pickCallArg(epoch)}); if(!el) return { __fail: pickReasonText(pick.reason) };
  try{ el.scrollIntoView({block:'center'}); }catch(e){}
  var r = el.getBoundingClientRect();
  var fo = frameOffset(el);
  return { x: Math.round(r.left + r.width/2 + fo.ox), y: Math.round(r.top + r.height/2 + fo.oy), name: (el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,30) };
})()
`)) as { x: number; y: number; name: string } | RefFail | null
    if (r && isRefFail(r)) return r
    if (!r) return null
    // 위 스크립트의 scrollIntoView 가 부모 문서까지 스크롤했을 수 있으므로 오프셋을 다시 잰다(prepareClickPoint 주석 참고).
    const fresh = t.frame ? await computeFrameOffset(t.frame, { scrollIntoView: false }) : null
    const off = fresh ?? t.offset
    return { x: r.x + off.x, y: r.y + off.y, name: r.name }
  } catch { return null }
}

async function pointForRef(wc: WebContents, ref: number, epoch?: string): Promise<{ x: number; y: number; name: string } | RefFail | null> {
  const t = await targetFor(ref, epoch)
  if (isRefFail(t)) return t
  return pointForTarget(wc, t, epoch)
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
async function pointHitsRef(wc: WebContents, t: ExecTarget, x: number, y: number, epoch?: string): Promise<boolean> {
  const lx = t.offset ? x - t.offset.x : x
  const ly = t.offset ? y - t.offset.y : y
  try {
    return (await runInTarget(wc, t, `
(function(){
  ${PICK_FN}
  var el = pick(${t.localRef}${pickCallArg(epoch)}); if(!el) return false;
  try { if (el.ownerDocument !== document) return true; } catch(e) { return true; }
  var hit = document.elementFromPoint(${Math.round(lx)}, ${Math.round(ly)});
  if (!hit) return false;
  return hit === el || el.contains(hit) || (hit.contains && hit.contains(el));
})()
`)) as boolean
  } catch { return true } // 검사 자체가 실패하면 막지 않는다(오탐으로 조작을 멈추지 않도록)
}

// 프레임 안 요소를 클릭할 때의 바깥쪽 가림 검사 — 프레임 **안에서는** 안 가려졌더라도, 최상위 문서의
// 모달·쿠키 배너가 iframe 자체를 덮고 있으면 클릭은 그 덮개로 간다. 최상위에서 그 좌표를 찍어
// iframe(또는 그 조상)이 맞는지 확인한다.
async function topPointHitsFrame(wc: WebContents, x: number, y: number): Promise<boolean> {
  try {
    return (await wc.executeJavaScript(`
(function(){
  var hit = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
  if (!hit) return false;
  var g = 0, n = hit;
  while (n && g++ < 8) { var tg = (n.tagName||'').toUpperCase(); if (tg === 'IFRAME' || tg === 'FRAME') return true; n = n.parentElement; }
  return false;
})()
`, true)) as boolean
  } catch { return true }
}

// 클릭 준비를 인페이지에서 한 번에 처리한다 — 스크롤 → 좌표 안정화(rAF) → 좌표 계산 → 가림 검사.
// 예전에는 JS 왕복 4회 + 고정 대기 120·180ms 로 나뉘어 있어 클릭마다 수백 ms 를 그냥 버렸다.
// 안정화는 고정 대기가 아니라 "연속 두 프레임에서 좌표가 같으면 통과" 라 대개 훨씬 빨리 끝난다.
type ClickPoint = { x: number; y: number; name: string; w: number; h: number; vw: number; vh: number; occluded: boolean }

async function prepareClickPoint(wc: WebContents, t: ExecTarget, settleMs: number, epoch?: string): Promise<ClickPoint | RefFail | null> {
  if (!t.offset) return { __fail: '프레임의 화면 위치를 계산할 수 없습니다' }
  try {
    const r = (await runInTarget(wc, t, `
(function(){
  ${PICK_FN}
  ${PICK_REASON_FN}
  ${FRAME_OFFSET_FN}
  var el = pick(${t.localRef}${pickCallArg(epoch)}); if(!el) return { __fail: pickReasonText(pick.reason) };
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
`)) as ClickPoint | RefFail | null
    if (!r || isRefFail(r)) return r
    if (!t.frame) return r
    // ⚠ 오프셋을 **여기서 다시 잰다.** 위 스크립트의 `el.scrollIntoView` 는 프레임 안만 스크롤하는 게 아니라
    // 조상 스크롤 컨테이너(= 부모 문서)까지 따라 스크롤한다. 그래서 targetFor 에서 미리 계산해 둔 오프셋은
    // 이 시점에 이미 낡았고, 그 값으로 클릭하면 **엉뚱한 자리**를 누른다(성공으로 보고하면서).
    // 실측으로 잡은 결함(2026-09-18, F8) — 프레임 버튼이 "눌렸다"고 보고되는데 실제로는 안 눌렸다.
    const fresh = await computeFrameOffset(t.frame, { scrollIntoView: false })
    const off = fresh ?? t.offset
    // 프레임 안 좌표 → 최상위 좌표. 화면 경계 판정도 최상위 뷰포트 기준이어야 한다(프레임 뷰포트가 아니라).
    const top = await viewportSize(wc)
    const abs = { ...r, x: r.x + off.x, y: r.y + off.y, vw: top.w, vh: top.h }
    if (!abs.occluded) {
      const hitsFrame = await topPointHitsFrame(wc, abs.x, abs.y)
      if (!hitsFrame) abs.occluded = true
    }
    return abs
  } catch { return null }
}

// ref 의 화면 좌표를 구하고(scrollIntoView 포함) 뷰포트 안이면 실제 클릭. 좌표를 못 구하거나 화면 밖이면 null,
// pick() 이 세대·프레임·이름 불일치로 거부했으면 RefFail(사유 포함)을 돌려준다.
async function realClickRef(wc: WebContents, t: ExecTarget, prof: InputProfile = PROFILE_STRICT, epoch?: string): Promise<{ ok: true; name: string } | RefFail | null> {
  const p = await prepareClickPoint(wc, t, prof.settleMs, epoch)
  if (!p) return null
  if (isRefFail(p)) return p
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
async function verifyTyped(wc: WebContents, t: ExecTarget, text: string, epoch?: string): Promise<boolean> {
  const probe = JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, 12))
  try {
    return (await runInTarget(wc, t, `
(function(){
  ${PICK_FN}
  var el = pick(${t.localRef}${pickCallArg(epoch)}); if(!el) return false;
  var v = (el.value != null ? el.value : (el.innerText || el.textContent || ''));
  var probe = ${probe};
  if (!probe) return (String(v).trim().length > 0);
  return String(v).replace(/\\s+/g,' ').indexOf(probe) >= 0;
})()
`)) as boolean
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
export async function typeIntoFocused(wc: WebContents, text: string, submit: boolean, prof: InputProfile = PROFILE_STRICT, allowedHosts?: string[]): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: 'tab destroyed' }
  try { wc.focus() } catch { /* ignore */ }
  await sleep(prof.typeWordPause ? 30 : 10)
  await typeCharsReal(wc, text, prof)
  // 입력이 실제로 들어갔는지 확인한다. 예전에는 검증 없이 항상 성공으로 보고해서, 포커스가 빗나갔거나
  // 오버레이에 가려 글자가 사라져도 다음 단계(게시)로 넘어가 "빈 캡션으로 게시"되는 사고가 가능했다.
  const verdict = await verifyFocusedText(wc, text, allowedHosts)
  if (verdict === 'missing') {
    return { ok: false, detail: '입력한 글자가 화면에 들어가지 않았습니다(포커스가 빗나갔을 수 있음) — 입력 칸을 다시 클릭한 뒤 시도하세요.' }
  }
  if (submit) {
    await sleep(30 + Math.floor(Math.random() * 90))
    try { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }) } catch { /* ignore */ }
  }
  return { ok: true, detail: verdict === 'ok' ? '입력(포커스, 사람처럼)' : '입력(포커스) — 입력 결과를 확인하지 못했습니다' }
}

// 지금 포커스된 요소에 방금 친 글자가 들어갔는지 확인. shadow DOM·same-origin iframe 을 따라 내려간다.
// 'ok' 들어감 / 'missing' 안 들어감 / 'unknown' 확인 불가.
// 교차 출처 프레임에 포커스가 있으면 최상위 문서에서는 알 수 없으므로(activeElement 가 <iframe> 까지),
// 허용된 프레임들에 같은 검사를 직접 돌려 확인한다 — 예전엔 여기서 늘 'unknown' 이라 "확인 못 함" 으로만 보고했다.
async function verifyFocusedText(wc: WebContents, text: string, allowedHosts?: string[]): Promise<'ok' | 'missing' | 'unknown'> {
  const probe = JSON.stringify(String(text).replace(/\s+/g, ' ').trim().slice(0, 12))
  if (probe === '""') return 'unknown'
  const top = await evalFocusProbe(wc, null, probe)
  if (top === 'ok' || top === 'missing') return top
  // 최상위에서 판정 불가 → 교차 출처 프레임들에서 같은 검사를 돌린다(허용 목록 안의 프레임만).
  try {
    const { roots } = listObservationFrames(wc, allowedHosts)
    let sawMissing = false
    for (const r of roots) {
      const v = await evalFocusProbe(wc, r.frame, probe)
      if (v === 'ok') return 'ok'
      if (v === 'missing') sawMissing = true
    }
    if (sawMissing) return 'missing'
  } catch { /* 프레임 열거 실패는 무시 */ }
  return 'unknown'
}

async function evalFocusProbe(wc: WebContents, frame: WebFrameMain | null, probe: string): Promise<'ok' | 'missing' | 'unknown'> {
  const code = `
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
`
  try {
    const r = frame ? await frame.executeJavaScript(code, true) : await wc.executeJavaScript(code, true)
    return r as 'ok' | 'missing' | 'unknown'
  } catch { return 'unknown' }
}

// 실제 키 입력으로 텍스트를 타이핑 — 포커스(실제 클릭 or focus) → 기존 값 비우기 → 한 글자씩 char 이벤트.
// 한글 등 조합 문자도 char 이벤트로 직접 삽입된다. 검증 실패 시 호출부가 합성 방식으로 폴백한다.
// 입력칸이 실제로 비었는지 확인하고, 남아 있으면 비운 뒤 캐럿을 끝으로 보낸다.
// 값을 "지우는" 것은 사람 흉내가 필요한 부분이 아니므로(중요한 건 타이핑) 결정적으로 처리한다.
async function ensureFieldCleared(wc: WebContents, t: ExecTarget, epoch?: string): Promise<void> {
  try {
    await runInTarget(wc, t, `
(function(){
  ${PICK_FN}
  var el = pick(${t.localRef}${pickCallArg(epoch)}); if(!el) return false;
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
`)
  } catch { /* 확인 실패는 무시 — 아래 verifyTyped 가 최종 판정한다 */ }
}

async function realTypeRef(wc: WebContents, t: ExecTarget, text: string, submit: boolean, prof: InputProfile = PROFILE_STRICT, epoch?: string): Promise<{ ok: boolean; detail: string }> {
  const focused = await realClickRef(wc, t, prof, epoch)
  // RefFail(세대·프레임·이름 불일치)이면 클릭이 아예 일어나지 않은 것 — 타이핑을 시도하지 말고 즉시 사유를 돌려준다.
  if (focused && isRefFail(focused)) return { ok: false, detail: focused.__fail }
  if (focused) await sleep(prof.typeWordPause ? 70 : 20)
  else {
    try { await runInTarget(wc, t, `(function(){ ${PICK_FN} var el=pick(${t.localRef}${pickCallArg(epoch)}); if(el){ try{el.scrollIntoView({block:'center'}); el.focus();}catch(e){} } })()`) } catch { /* ignore */ }
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
  await ensureFieldCleared(wc, t, epoch)
  await typeCharsReal(wc, text, prof)
  await sleep(20)
  const ok = await verifyTyped(wc, t, text, epoch)
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
// 과제2 U8 — execScript 의 click_at 과 동일하게, 범위 밖 좌표는 경계로 당겨 찍지 않고 거부한다.
async function realClickAtPct(wc: WebContents, xPct: number, yPct: number, prof: InputProfile = PROFILE_STRICT): Promise<{ ok: boolean; detail: string }> {
  if (!Number.isFinite(xPct) || !Number.isFinite(yPct) || xPct < 0 || xPct > 100 || yPct < 0 || yPct > 100) {
    return { ok: false, detail: `화면 밖 좌표(${xPct}%, ${yPct}%) — xPct·yPct 는 0~100 사이여야 합니다` }
  }
  const vp = await viewportSize(wc)
  const x = Math.round(xPct / 100 * vp.w)
  const y = Math.round(yPct / 100 * vp.h)
  await realClickXY(wc, x, y, prof)
  return { ok: true, detail: `화면 클릭 ${x},${y}` }
}

// 호버 — JS 기반 메뉴는 합성 mouseover 로, CSS :hover 는 실제 마우스 이동(sendInputEvent)으로 둘 다 커버.
export async function hoverElement(wc: WebContents, ref: number, epoch?: string): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: 'tab destroyed' }
  const t = await targetFor(ref, epoch)
  if (isRefFail(t)) return { ok: false, detail: t.__fail }
  let pt: { x: number; y: number; name: string } | RefFail | null
  try {
    pt = (await runInTarget(wc, t, `
(function(){
  ${PICK_FN}
  ${PICK_REASON_FN}
  ${FRAME_OFFSET_FN}
  var el = pick(${t.localRef}${pickCallArg(epoch)}); if(!el) return { __fail: pickReasonText(pick.reason) };
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
`)) as { x: number; y: number; name: string } | RefFail | null
  } catch { pt = null }
  if (pt && isRefFail(pt)) return { ok: false, detail: pt.__fail }
  if (!pt) return { ok: false, detail: 'ref 요소를 찾을 수 없음' }
  if (t.offset) { try { wc.sendInputEvent({ type: 'mouseMove', x: pt.x + t.offset.x, y: pt.y + t.offset.y }) } catch { /* top-level 만 */ } }
  return { ok: true, detail: `호버: ${pt.name || ref}` }
}

// 드래그 — 실제 마우스 down→move→up(sendInputEvent). 슬라이더·캔버스·정렬 등. from/to 는 ref 또는 화면 %.
export async function dragOnPage(wc: WebContents, spec: { ref?: number; xPct?: number; yPct?: number; toRef?: number; toXPct?: number; toYPct?: number }, epoch?: string): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: 'tab destroyed' }
  const vp = await viewportSize(wc)
  const resolve = async (ref?: number, xp?: number, yp?: number): Promise<{ x: number; y: number } | RefFail | null> => {
    if (ref != null) { const p = await pointForRef(wc, ref, epoch); if (p && isRefFail(p)) return p; return p ? { x: p.x, y: p.y } : null }
    if (xp != null && yp != null) return { x: Math.round(Math.max(0, Math.min(100, xp)) / 100 * vp.w), y: Math.round(Math.max(0, Math.min(100, yp)) / 100 * vp.h) }
    return null
  }
  const from = await resolve(spec.ref, spec.xPct, spec.yPct)
  const to = await resolve(spec.toRef, spec.toXPct, spec.toYPct)
  if (from && isRefFail(from)) return { ok: false, detail: from.__fail }
  if (to && isRefFail(to)) return { ok: false, detail: to.__fail }
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
//
// ⚠ ref 를 준 키 동작은 "그 요소에" 보내겠다는 뜻이다. 예전에는 포커스 이동 실패(세대·프레임 불일치,
// 요소 소멸)를 조용히 삼키고 **지금 포커스가 어디든 키를 그대로 보냈다**. 그러면 Ctrl+A → Delete 가
// 의도한 입력칸이 아니라 엉뚱한 편집 영역을 비우고, Enter 가 엉뚱한 폼을 제출한다 — 되돌릴 수 없는
// 사고가 조용한 실패에서 나온다. 이제 **검증 실패 시 키를 한 개도 보내지 않고 즉시 사유와 함께 실패**한다.
// (ref 를 아예 주지 않은 경우만 "지금 포커스에 보낸다" 는 의도된 동작이다.)
export async function pressKey(wc: WebContents, spec: { key: string; ref?: number }, epoch?: string): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: 'tab destroyed' }
  if (spec.ref != null) {
    const t = await targetFor(spec.ref, epoch)
    if (isRefFail(t)) return { ok: false, detail: `${t.__fail} (ref ${spec.ref}) — 키를 보내지 않았습니다` }
    let focused: unknown = null
    try {
      focused = await runInTarget(wc, t, `
(function(){
  ${PICK_FN}
  ${PICK_REASON_FN}
  var el = pick(${t.localRef}${pickCallArg(epoch)});
  if (!el) return { ok: false, reason: pickReasonText(pick.reason) };
  try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
  try { el.focus(); } catch (e) { return { ok: false, reason: '요소에 포커스를 줄 수 없습니다' }; }
  return { ok: true };
})()
`)
    } catch (err) {
      return { ok: false, detail: `키 대상 요소를 확인할 수 없습니다(${String(err)}) — 키를 보내지 않았습니다` }
    }
    const f = focused as { ok?: boolean; reason?: string } | null
    if (!f || f.ok !== true) {
      return { ok: false, detail: `${f?.reason ?? '요소를 찾을 수 없습니다'} (ref ${spec.ref}) — 키를 보내지 않았습니다` }
    }
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
// 반환형이 string|null 이라(사유를 담을 자리가 없다) epoch 불일치도 그냥 null 로 — 호출부(agent.ts)가
// "다운로드 대상을 못 찾음" 수준의 기존 일반 메시지로 처리한다(다른 함수들처럼 세밀한 사유는 못 준다).
export async function resolveHref(wc: WebContents, ref: number, epoch?: string): Promise<string | null> {
  const t = await targetFor(ref, epoch, { scrollIntoView: false })
  if (isRefFail(t)) return null
  try {
    return (await runInTarget(wc, t, `
(function(){
  ${PICK_FN}
  var el = pick(${t.localRef}${pickCallArg(epoch)}); if(!el) return null;
  var a = el.closest ? (el.closest('a[href]') || el) : el;
  var h = a.getAttribute ? a.getAttribute('href') : null;
  if(!h) return null;
  try{ return new URL(h, location.href).href; }catch(e){ return h; }
})()
`)) as string | null
  } catch { return null }
}

// 다운로드용 미디어 소스 해석 — 사진(img)·영상(video/source)·배경이미지·링크(a[href])를 절대 URL 로.
// blob:/data: 는 직접 받을 수 없으므로 제외(호출부가 감지 후보·yt-dlp 로 폴백하게 null 반환).
export async function resolveMediaSrc(wc: WebContents, ref: number, epoch?: string): Promise<{ url: string; kind: 'image' | 'video' | 'link' } | null> {
  try {
    return (await wc.executeJavaScript(`
(function(){
  ${PICK_FN}
  var el = pick(${ref}${pickCallArg(epoch)}); if(!el) return null;
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

const OBSERVE_SCRIPT = (maxEls: number, maxText: number, epoch: string) => `
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
    // 폼 컨트롤은 연결된 <label> 텍스트가 이름이다(<label>설명 <textarea>> 형태). 이게 없어 입력칸이 이름 없이 잡히고
    // 라벨이 별도 요소로 잡혀 입력이 라벨로 가던 결함(2026-09-13, SNS 하네스 S3·S4 — 유튜브 제목·틱톡 설명).
    if (!n && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
      try {
        var lb = (el.labels && el.labels[0]) || (el.closest ? el.closest('label') : null);
        // 값 문자열을 치환해 빼는 방식은 짧은 값("i")이 라벨 글자를 훼손한다 → 컨트롤 자신을 뺀 자식 노드 텍스트만 모은다.
        if (lb) { var lt = ''; var cs = lb.childNodes; for (var ci = 0; ci < cs.length; ci++) { var cn = cs[ci]; if (cn === el) continue; if (cn.nodeType === 3) lt += cn.textContent; else if (cn.nodeType === 1 && !cn.contains(el)) lt += (cn.innerText || cn.textContent || ''); } n = lt; }
      } catch (e) {}
    }
    if (!n && el.tagName === 'INPUT') n = (isSecret(el) ? '' : (el.value || '')) || el.getAttribute('name') || el.getAttribute('title') || '';
    if (!n) n = (el.innerText || el.textContent || '').trim();
    if (!n) n = el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '';
    return String(n).replace(/\\s+/g, ' ').trim().slice(0, 120);
  }
  var out = [];
  var ref = { n: 0 };
  // 접근 불가 프레임(대개 cross-origin) — 과제2 U1: 안이 안 보이면 조용히 넘어가지 않고 "여기 프레임이
  // 있는데 못 본다" 를 정직하게 보고한다(같은 출처 정책은 페이지 JS 로 우회할 수 없는 구조적 한계).
  var UNREACHABLE = [];
  // 요소 참조 레지스트리 — DOM 에 속성을 달지 않고 여기에만 담는다(봇 탐지 지문 제거).
  // 관찰마다 통째로 새로 만들어, 옛 번호가 살아남아 엉뚱한 요소를 집는 일이 없다.
  // __epoch(과제1) — 이 관찰의 세대 토큰(TS 쪽 observePage 가 탭 id 를 섞어 매번 새로 만든다). pick() 이
  // 실행 시 넘어온 epoch 와 이 값을 비교해, 그 사이 재관찰이 있었으면 옛 번호를 거부한다.
  var REG = []; REG.__epoch = ${JSON.stringify(epoch)}; window['${REF_KEY}'] = REG;
  var TAKEN = new WeakSet();  // 같은 요소가 두 번(요소 스캔 + 클릭가능 보강) 담기는 것 방지
  // f: 이 요소가 속한 문서(top 또는 same-origin iframe)의 관찰 당시 URL — pick() 의 프레임 검사(과제1)가 쓴다.
  function reg(el, name) {
    var fw = winOf(el); var fu = '';
    try { fu = (fw && fw.location && fw.location.href) || ''; } catch (e) {}
    REG[ref.n] = { e: el, n: String(name || '').replace(/\\s+/g, ' ').trim(), f: fu };
    TAKEN.add(el);
  }
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
      // 보이는 컨트롤을 가리키는 label 은 그 컨트롤이 대신 목록에 오른다(이름은 라벨 텍스트). 둘 다 올리면 모델이 라벨을 집어
      // 입력이 허공에 간다. 컨트롤이 숨겨진 커스텀 UI(스타일된 라디오 등)에서는 label 을 그대로 둔다.
      if (tag === 'label') { var ctl = null; try { ctl = el.control; } catch (e) {} if (ctl && !ctl.disabled && visible(ctl)) continue; }
      var type = tag === 'input' ? (el.getAttribute('type') || 'text') : (el.getAttribute('role') || tag);
      var name = nameOf(el);
      // 빈 편집 영역(contenteditable·role=textbox/combobox)은 이름이 없어도 목록에 남긴다 —
      // 리치 에디터의 빈 제목/본문 칸이 관찰에서 사라지지 않도록(이게 없으면 에디터 칸을 못 찾는다).
      var editable = el.isContentEditable || (el.getAttribute('contenteditable') === 'true') || type === 'textbox' || type === 'combobox';
      if (!name && tag !== 'input' && tag !== 'textarea' && tag !== 'select' && !editable) continue;
      if (!name && editable) name = '(입력 영역)';
      reg(el, name);
      var off = false; try { var rr = el.getBoundingClientRect(); off = (rr.bottom < 0 || rr.top > window.innerHeight || rr.right < 0 || rr.left > window.innerWidth); } catch (e) {}
      var rec = { ref: ref.n, tag: tag, type: type, name: (depth > 0 ? '(프레임) ' : '') + name + (off ? ' (화면 밖 — 클릭하면 자동 스크롤)' : '') };
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
        var fEl = frames[j];
        var fdoc = null;
        try { fdoc = fEl.contentDocument; } catch(e) { fdoc = null; }
        if (fdoc) { collect(fdoc, depth + 1); continue; }
        // contentDocument 가 null 이면 대개 cross-origin(같은 이유로 로드 전일 수도 있어 완벽하진 않지만,
        // "이 프레임 안은 관찰할 수 없다" 는 신호로 충분하다). 보이는 것만, 개수는 소음 방지로 상한을 둔다.
        try {
          if (visible(fEl) && UNREACHABLE.length < 8) {
            var fsrc = fEl.getAttribute('src') || '';
            var fabs = '';
            try { fabs = fsrc ? new URL(fsrc, location.href).href : ''; } catch (e2) { fabs = fsrc; }
            UNREACHABLE.push({ src: fabs, label: ((fEl.getAttribute('title') || fEl.getAttribute('name') || '') + (fsrc ? ' ' + fsrc.slice(0, 80) : '(src 없음)')).trim() });
          }
        } catch(e) {}
      }
    }
  }
  // 열린 대화상자(role=dialog·aria-modal·<dialog open>)가 있으면 **그 안을 먼저** 수집한다. 상한(MAX)에 피드 링크가 먼저 차서
  // 대화상자의 "다음"·"공유하기" 가 잘려 나가던 결함(인스타 실사이트 파일럿 2026-09-13 — 모델이 run_js 로 우회, 스텝 4개 낭비).
  // 뷰포트 밖 요소도 담고 이름에 "(화면 밖)" 을 붙인다(클릭은 scrollIntoView 로 처리된다).
  try {
    // DOM 순서(마지막 매치)로 고르면 body 끝에 포탈된 토스트·쿠키 배너(role=dialog 오용)가 진짜 모달을 밀어낸다(리뷰) →
    // 보이는 것 중 **화면 안 면적이 가장 큰** 대화상자를 고르고, aria-modal="true" 는 가산점.
    var dlgs = document.querySelectorAll('[role=dialog], [aria-modal="true"], dialog[open]');
    var top = null, best = -1;
    for (var di = 0; di < dlgs.length; di++) {
      var dEl = dlgs[di]; if (!visible(dEl)) continue;
      var dr = dEl.getBoundingClientRect();
      var iw = Math.max(0, Math.min(dr.right, window.innerWidth) - Math.max(dr.left, 0));
      var ih = Math.max(0, Math.min(dr.bottom, window.innerHeight) - Math.max(dr.top, 0));
      var score = iw * ih * (dEl.getAttribute('aria-modal') === 'true' ? 1.5 : 1);
      if (score > best) { best = score; top = dEl; }
    }
    if (top) collect(top, 0);
  } catch (e) {}
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
  // ===== 로그인 / CAPTCHA 화면 신호 (challenge-detect.ts 가 판정한다) =====
  // **구조적 신호만** 모은다. 본문에 '로그인'·'verify' 같은 단어가 있다는 이유로는 절대 신호를 만들지 않는다
  // (안내 문서·약관에 흔하다 → 오탐으로 작업이 멈춘다). 문구는 "본문이 아주 짧은 차단 간지" 일 때만 보조로 쓴다.
  var challenge = null;
  try {
    // reCAPTCHA v3 배지(.grecaptcha-badge)는 **도전 과제가 아니다** — 뒤에서 조용히 점수만 매기고 사용자가
    // 할 일이 없다. 이걸 CAPTCHA 로 세면 그 스크립트를 쓰는 수많은 평범한 사이트에서 매번 멈춘다.
    var CAP_SEL = '.g-recaptcha, #g-recaptcha, .h-captcha, .cf-turnstile, #cf-turnstile, [data-sitekey],'
      + ' iframe[src*="/recaptcha/api2/"], iframe[src*="/recaptcha/enterprise/"], iframe[src*="hcaptcha.com"],'
      + ' iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], iframe[src*="geetest"]';
    var caps = document.querySelectorAll(CAP_SEL);
    for (var ci = 0; ci < caps.length; ci++) {
      var ce = caps[ci];
      var ccls = '';
      try { ccls = typeof ce.className === 'string' ? ce.className : ''; } catch (e) {}
      if (/grecaptcha-badge/.test(ccls)) continue;
      if (!visible(ce)) continue;
      var csrc = '';
      try { csrc = ce.getAttribute('src') || ''; } catch (e) {}
      challenge = { kind: 'captcha', marker: (ce.tagName.toLowerCase() + (ccls ? '.' + String(ccls).trim().split(/\\s+/)[0] : '') + (csrc ? ' ' + csrc.slice(0, 70) : '')).slice(0, 120) };
      break;
    }
    // 차단 간지(Cloudflare 등) — 위젯이 안 보여도 본문이 아주 짧고 문구가 뚜렷하면 사람 확인 화면이다.
    if (!challenge && bodyText.length < 600) {
      var CAP_TEXT = /(로봇이 아닙니다|사람인지 확인|사람임을 확인|자동입력 방지|보안문자|I am not a robot|I'm not a robot|Verify you are human|Checking your browser|Just a moment)/i;
      var cm = CAP_TEXT.exec(bodyText);
      if (cm) challenge = { kind: 'captcha', marker: '차단 간지 문구: "' + cm[0] + '" (본문 ' + bodyText.length + '자)' };
    }
    if (!challenge) {
      var pws = document.querySelectorAll('input[type=password]');
      for (var pi = 0; pi < pws.length; pi++) {
        if (!visible(pws[pi])) continue;
        challenge = { kind: 'login', marker: 'input[type=password] (보이는 비밀번호 입력칸)' };
        break;
      }
    }
  } catch (e) {}
  // ===== 연성(soft) 로그인 신호 — "아이디 먼저" 2단계 로그인의 1단계 =====
  // 비밀번호 칸이 없어서 위의 challenge 는 잡지 못한다. 그렇다고 이걸 challenge 로 올리면
  // **작업이 멈추는 오탐**이 생긴다(헤더에 로그인 위젯이 있는 평범한 페이지까지 중단). 그래서 별도 필드로
  // 내보내고, **자동 로그인 시도 여부를 고를 때만** 참고한다 — 사람에게 넘기는 판단에는 쓰지 않는다.
  // 근거는 autocomplete="username|email" 하나뿐이다. 이건 페이지 작성자가 "이 칸은 로그인 식별자" 라고
  // 명시한 것이라 검색창·일반 입력과 혼동되지 않는다(본문 문구 추측이 아니다).
  var loginHint = null;
  try {
    if (!challenge) {
      var idc = document.querySelectorAll('input[autocomplete~=username i], input[autocomplete=email i]');
      var idn = 0, idEl = null;
      for (var ii = 0; ii < idc.length; ii++) { if (visible(idc[ii]) && !idc[ii].disabled) { idn++; idEl = idc[ii]; } }
      if (idn === 1 && idEl) loginHint = { identifierFirst: true, marker: 'autocomplete=username (아이디 먼저 단계로 보임)' };
    }
  } catch (e) {}
  return {
    challenge: challenge,
    loginHint: loginHint,
    url: location.href,
    title: document.title || '',
    text: bodyText.slice(0, ${maxText}),
    truncated: bodyText.length > ${maxText},
    elements: out,
    listHint: listHint,
    progress: progress || undefined,
    frameStubs: UNREACHABLE.length ? UNREACHABLE : undefined,
    scroll: { y: Math.round(window.scrollY), maxY: Math.round(Math.max(0, Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0) - window.innerHeight)) }
  };
})();
`

// 교차 출처 프레임 하나에 할당하는 예산 — 프롬프트가 프레임 수만큼 부풀지 않도록 최상위보다 작게 잡는다.
const FRAME_MAX_ELEMENTS = 30
const FRAME_MAX_TEXT = 700

export async function observePage(
  wc: WebContents,
  opts?: { maxElements?: number; maxText?: number; allowedHosts?: string[] },
): Promise<PageObservation | null> {
  if (wc.isDestroyed()) return null
  const url = wc.getURL()
  if (!/^https?:/i.test(url)) return null
  // 관찰 세대(epoch, 과제1) — 매 관찰마다 새로 만든다. wc.id 를 섞어 두는 이유: 탭마다 이미 별개의
  // window(JS 컨텍스트) 라 다른 탭의 레지스트리에 원천적으로 접근할 수 없지만, 탭 id 를 토큰 자체에
  // 명시해 "이 ref 번호는 어느 탭의 몇 번째 관찰에서 나왔는가"가 값만 봐도 드러나게 한다(재사용 시
  // 두 번째 방어선 + 디버깅용).
  const epoch = `${wc.id}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
  let obs: Omit<PageObservation, 'epoch'>
  try {
    obs = (await wc.executeJavaScript(
      OBSERVE_SCRIPT(opts?.maxElements ?? 80, opts?.maxText ?? 1800, epoch), true,
    )) as Omit<PageObservation, 'epoch'>
  } catch (err) {
    console.warn('[ai-agent] observe failed', err)
    return null
  }
  if (!obs || !Array.isArray(obs.elements)) return null

  // ===== 교차 출처 프레임 관찰 =====
  // 최상위 스크립트는 SOP 때문에 다른 출처 iframe 안을 볼 수 없다. 메인 프로세스는 볼 수 있다 —
  // 각 프레임 문서에서 같은 관찰 스크립트를 직접 돌리고, 요소 번호를 전역 번호로 이어 붙인다.
  // 허용 사이트 밖 프레임은 **스크립트를 아예 실행하지 않는다**(텍스트 0글자 유출).
  const slots: RefSlot[] = [{ frameId: null, frameUrl: url, base: 0, count: obs.elements.length }]
  let next = obs.elements.length
  const frameReports: NonNullable<PageObservation['frames']> = []
  const unreachable: string[] = []
  let blockedHosts: string[] = []
  try {
    const { roots, blocked } = listObservationFrames(wc, opts?.allowedHosts)
    blockedHosts = blocked.map((b) => b.host)
    for (const r of roots) {
      let fobs: Omit<PageObservation, 'epoch'> | null = null
      try {
        fobs = (await r.frame.executeJavaScript(
          OBSERVE_SCRIPT(FRAME_MAX_ELEMENTS, FRAME_MAX_TEXT, epoch), true,
        )) as Omit<PageObservation, 'epoch'>
      } catch { fobs = null }
      if (!fobs || !Array.isArray(fobs.elements)) { unreachable.push(r.host); continue }
      const base = next
      for (const el of fobs.elements) {
        obs.elements.push({ ...el, ref: base + el.ref, name: `(프레임 ${r.host}) ${el.name}` })
      }
      next = base + fobs.elements.length
      slots.push({ frameId: r.id, frameUrl: r.url, base, count: fobs.elements.length })
      frameReports.push({
        host: r.host, url: r.url, title: String(fobs.title ?? ''),
        text: String(fobs.text ?? '').slice(0, FRAME_MAX_TEXT), elementCount: fobs.elements.length,
        ...(fobs.challenge ? { challenge: fobs.challenge } : {}),
        ...(fobs.loginHint ? { loginHint: fobs.loginHint } : {}),
      })
    }
  } catch (err) {
    console.warn('[ai-agent] frame observe failed', err)
  }
  setRefRouting(epoch, slots)
  // "정말 못 본 프레임" 가리기 — 최상위 JS 가 안을 못 본 프레임(frameStubs) 중, 우리가 실제로 관찰하지도
  // 않았고 정책으로 일부러 막은 것도 아닌 것들. 이 대조가 없으면, 프레임 열거가 불가능한 환경에서
  // "여기 못 보는 영역이 있다"는 신호가 조용히 사라진다(그러면 모델은 요소가 없다고 판단해 헛돈다).
  const observedHosts = new Set(frameReports.map((f) => f.host))
  const blockedSet = new Set(blockedHosts)
  for (const stub of obs.frameStubs ?? []) {
    const h = hostOf(stub.src)
    if (h && (observedHosts.has(h) || blockedSet.has(h))) continue
    if (unreachable.length < 8) unreachable.push(stub.label || h || '(주소 불명)')
  }
  const { frameStubs: _stubs, ...rest } = obs
  return {
    ...rest,
    epoch,
    frames: frameReports.length ? frameReports : undefined,
    blockedFrames: blockedHosts.length ? blockedHosts : undefined,
    crossOriginFrames: unreachable.length ? unreachable : undefined,
  }
}

function execScript(action: AgentAction, epoch?: string, localRef?: number): string {
  const ref = JSON.stringify(localRef ?? action.ref ?? -1)
  const text = JSON.stringify(action.text ?? '')
  const dir = action.direction === 'up' ? -1 : 1
  const submit = action.submit ? 'true' : 'false'
  const xPct = Number.isFinite(action.xPct as number) ? Number(action.xPct) : 50
  const yPct = Number.isFinite(action.yPct as number) ? Number(action.yPct) : 50
  // scroll 에 명시적 지점이 왔는지(과제2 — 컨테이너 내부 스크롤). 지점이 없으면(보통의 "더 보자" 의도)
  // 페이지 스크롤만 시도한다 — 항상 xPct/yPct 를 50 으로 기본값 채우면, 우연히 화면 중앙에 걸린 작은
  // 스크롤 위젯(코드블록 등)을 메인 스크롤 대신 잘못 건드리는 사고가 난다.
  const hasPoint = Number.isFinite(action.xPct as number) && Number.isFinite(action.yPct as number)
  const epochArg = pickCallArg(epoch)
  return `
(function() {
  // ref 는 관찰 때 만든 레지스트리에서 꺼낸다(DOM 속성 미사용 — 봇 탐지 지문 제거 + 재활용 노드 검증).
  ${PICK_FN}
  ${PICK_REASON_FN}
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
    if (act === 'scroll') {
      var scrolled = false;
      if (${JSON.stringify(hasPoint)}) {
        // 과제2 — 컨테이너 내부 스크롤. 지점이 스크롤 가능한(overflow auto/scroll + 실제로 넘치는) 요소
        // 위라면 그 컨테이너를 스크롤한다(채팅창·목록 패널 등, 페이지 자체는 안 움직이는 UI 대응).
        // 지점이 없으면(보통의 "페이지를 더 보자") 아래 폴백으로 페이지만 스크롤한다.
        var svx = Math.max(0, Math.min(100, ${xPct})) / 100 * window.innerWidth;
        var svy = Math.max(0, Math.min(100, ${yPct})) / 100 * window.innerHeight;
        var snode = document.elementFromPoint(svx, svy);
        var sguard = 0;
        while (snode && snode !== document.body && snode !== document.documentElement && sguard++ < 12) {
          var scs = null; try { scs = getComputedStyle(snode); } catch (e) {}
          var soy = scs ? scs.overflowY : '';
          if ((soy === 'auto' || soy === 'scroll') && snode.scrollHeight > snode.clientHeight + 2) {
            snode.scrollBy({ top: ${dir} * Math.round(snode.clientHeight * 0.85), behavior: 'instant' });
            scrolled = true;
            break;
          }
          snode = snode.parentElement;
        }
      }
      if (!scrolled) window.scrollBy({ top: ${dir} * Math.round(window.innerHeight * 0.85), behavior: 'instant' });
      return { ok: true, detail: scrolled ? 'scrolled(컨테이너)' : 'scrolled' };
    }
    if (act === 'click_at') {
      // 과제2 U8 — 화면 밖 비율은 경계로 당겨 찍지 않고 거부한다. 조용히 clamp 하면 모델이 잘못
      // 계산한 좌표(예: 150%)를 "가장자리를 클릭했다"고 오해한 채 다음 단계로 넘어갈 수 있다.
      if (${xPct} < 0 || ${xPct} > 100 || ${yPct} < 0 || ${yPct} > 100) {
        return { ok: false, detail: '화면 밖 좌표(' + ${xPct} + '%, ' + ${yPct} + '%) — xPct·yPct 는 0~100 사이여야 합니다' };
      }
      // 화면(뷰포트)의 백분율 좌표를 CSS 좌표로 바꿔, 그 지점의 요소에 실제 마우스 이벤트를 보낸다
      // (캔버스·커스텀 UI 처럼 DOM 요소 목록에 안 잡히는 대상도 클릭 가능).
      var vx = ${xPct} / 100 * window.innerWidth;
      var vy = ${yPct} / 100 * window.innerHeight;
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
    var el = pick(${ref}${epochArg});
    // 과제1의 상세 사유 — 이 자리가 "주 경로"다: executeInPageAction 의 사람 입력이 실패하면 항상
    // 여기(합성 폴백)로 떨어지므로, 세대·프레임·이름 중 무엇이 안 맞았는지가 최종적으로 사용자·에이전트에
    // 보이는 detail 이 된다(fallback() 이 이 detail 을 그대로 실어 나른다).
    if (!el) return { ok: false, detail: pickReasonText(pick.reason) + ' (ref ' + ${ref} + ')' };
    var win = winOf(el);
    el.scrollIntoView({ block: 'center' });
    if (act === 'click') { el.click(); return { ok: true, detail: 'clicked' }; }
    if (act === 'select') {
      // 드롭다운(<select>) 선택 — 값 또는 보이는 글자로 고른다. 커스텀 드롭다운(div 목록)은 click 으로 처리.
      if (el.tagName !== 'SELECT') return { ok: false, detail: '드롭다운(select) 요소가 아닙니다 — 목록을 클릭해 고르세요' };
      var want = String(${text});
      var hit = -1, names = [];
      for (var oi = 0; oi < el.options.length; oi++) {
        var op = el.options[oi];
        var ot = String(op.text || '').replace(/\\s+/g, ' ').trim();
        names.push(ot);
        if (op.value === want || ot === want) { hit = oi; break; }
      }
      if (hit < 0) {
        for (var oj = 0; oj < el.options.length; oj++) {
          var ot2 = String(el.options[oj].text || '').replace(/\\s+/g, ' ').trim();
          if (ot2 && ot2.indexOf(want) >= 0) { hit = oj; break; }
        }
      }
      if (hit < 0) return { ok: false, detail: '"' + want + '" 항목이 없습니다 (선택 가능: ' + names.slice(0, 12).join(' / ') + ')' };
      el.focus();
      el.selectedIndex = hit;
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
      el.dispatchEvent(new win.Event('change', { bubbles: true }));
      return { ok: true, detail: '선택: ' + names[hit] };
    }
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
async function execSynthetic(wc: WebContents, action: AgentAction, epoch?: string, target?: ExecTarget): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: 'tab destroyed' }
  // ref 가 있으면 그 요소가 사는 프레임에서 실행한다(교차 출처 프레임 포함). ref 가 없는 동작
  // (scroll·click_at)은 최상위에서 — 좌표가 최상위 뷰포트 기준이기 때문.
  let t: ExecTarget | null = target ?? null
  if (!t && action.ref != null && action.ref >= 0) {
    const r = await targetFor(action.ref, epoch, { scrollIntoView: false })
    if (isRefFail(r)) return { ok: false, detail: `${r.__fail} (ref ${action.ref})` }
    t = r
  }
  const tt = t ?? TOP_TARGET(action.ref ?? -1)
  try {
    return (await runInTarget(wc, tt, execScript(action, epoch, tt.localRef))) as { ok: boolean; detail: string }
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
  // epoch(과제1) — 이 행동이 근거한 관찰의 세대 토큰. observePage() 가 돌려준 obs.epoch 를 그대로 넘기면,
  // 그 사이 다른 관찰(탭 전환 후 재관찰 등)이 있었을 때 옛 ref 로 지금 화면의 다른 요소를 집지 않는다.
  // 생략하면(하위호환) 세대·프레임 검사 없이 예전과 동일하게 동작한다.
  opts?: { humanInput?: boolean; profile?: InputProfile; epoch?: string; allowedHosts?: string[] },
): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: 'tab destroyed' }
  const human = opts?.humanInput !== false
  const prof = opts?.profile ?? PROFILE_STRICT
  const epoch = opts?.epoch
  if (!human) return execSynthetic(wc, action, epoch)
  // 대상 해석을 한 번만 하고(프레임 오프셋 계산 포함) 실제 입력·합성 폴백이 같은 대상을 쓴다.
  let target: ExecTarget | null = null
  if (action.ref != null && action.ref >= 0) {
    const r = await targetFor(action.ref, epoch)
    if (isRefFail(r)) return { ok: false, detail: `${r.__fail} (ref ${action.ref})` }
    target = r
  }
  // 합성 폴백은 isTrusted=false 이벤트라 봇 탐지에 걸릴 수 있다. 예전에는 아무 표시 없이 폴백해서
  // 사용자도 에이전트도 "사람처럼 클릭됐다"고 믿었다 — 이제 결과 detail 에 폴백 사실을 명시한다.
  const fallback = async (why: string): Promise<{ ok: boolean; detail: string }> => {
    const r = await execSynthetic(wc, action, epoch, target ?? undefined)
    return { ok: r.ok, detail: r.ok ? `${r.detail} ※ 사람 입력 대신 합성 이벤트 사용(${why})` : r.detail }
  }
  try {
    if (action.action === 'click' && target) {
      const r = await realClickRef(wc, target, prof, epoch)
      // 세대·프레임·이름 불일치(RefFail) 는 "화면 밖·가려짐" 과 다른 사고다 — 폴백으로 넘기지 않고
      // 바로 사유를 돌려준다(합성 클릭도 같은 pick() 을 거치므로 어차피 똑같이 거부되지만, 여기서
      // 즉시 끊으면 불필요한 왕복 없이 더 빠르고 사유가 더 분명하다).
      if (r && isRefFail(r)) return { ok: false, detail: r.__fail }
      if (r) return { ok: true, detail: `클릭(사람처럼) ${r.name || action.ref}${target.frameHost ? ` [프레임 ${target.frameHost}]` : ''}` }
      return fallback(target.offset ? '화면 밖·좌표 불가·다른 요소가 덮음' : '프레임 화면 위치 계산 실패')
    }
    if (action.action === 'click_at') {
      return await realClickAtPct(wc, Number(action.xPct ?? 50), Number(action.yPct ?? 50), prof)
    }
    if (action.action === 'type') {
      // ref 가 없으면(리치 에디터·iframe 칸) 직전 click_at 으로 포커스한 곳에 실제 키로 입력.
      if (!target) return typeIntoFocused(wc, action.text ?? '', !!action.submit, prof, opts?.allowedHosts)
      const r = await realTypeRef(wc, target, action.text ?? '', !!action.submit, prof, epoch)
      if (r.ok) return r
      return fallback('실제 키 입력이 반영되지 않음')
    }
    // scroll·select 등은 그대로(사람 입력 궤적이 필요 없는 동작) — 단, ref 가 있으면 그 프레임 안에서 실행된다.
    return execSynthetic(wc, action, epoch, target ?? undefined)
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
  // MIME 형태 accept(image/jpeg,video/mp4 …)도 맞춘다 — 인스타그램 웹은 확장자가 아니라 MIME 목록을 쓴다
  // (실사이트 파일럿 2026-09-13: accept="image/avif,image/jpeg,…" 에 .jpg 가 "다른 형식" 으로 거부됐다).
  const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic', '.heif': 'image/heif', '.avif': 'image/avif',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac' }
  const mime = MIME[ext] ?? ''
  const parts = a.split(',').map((s) => s.trim()).filter(Boolean)
  for (const p of parts) {
    if (p === ext || (p.startsWith('.') === false && p === ext.slice(1))) return 5   // 확장자 정확 일치(.jpg / jpg)
    if (mime && p === mime) return 5                                                  // MIME 정확 일치
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

    // 붙였다고 말하기 전에 **정말 붙었는지** 읽어서 확인한다 — 첨부가 조용히 0개로 끝난 것을
    // "성공" 으로 보고하면 빈 게시물이 올라간다(SEC-1 의 "무검증 성공 제거" 와 같은 원칙).
    //
    // ⚠ 여기서 `input`/`change` 를 **직접 쏘지 않는다.** Puppeteer 는 쏘지만, 이 Chromium(148)에서는
    //   `DOM.setFileInputFiles` 가 이미 change 를 발생시킨다 — 2026-09-19 에 음성 대조로 확인했다
    //   (이벤트 발송을 빼고 픽스처 업로드 위저드를 끝까지 돌려 게시 1건이 그대로 도착했다).
    //   필요 없는 중복 발송은 change 를 세는 사이트에서 같은 업로드를 두 번 처리하게 만들 수 있으므로
    //   넣지 않는다. 근거 없이 "혹시 몰라" 남기지 않는다.
    let landed = -1
    try {
      const resolved = await dbg.sendCommand(
        'DOM.resolveNode', { nodeId: best.nodeId }, best.sessionId,
      ) as { object?: { objectId?: string } }
      const objectId = resolved?.object?.objectId
      if (objectId) {
        const r = await dbg.sendCommand('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function () { return this.files ? this.files.length : -1 }',
          returnByValue: true,
        }, best.sessionId) as { result?: { value?: number } }
        landed = typeof r?.result?.value === 'number' ? r.result.value : -1
      }
    } catch { /* 확인 자체가 안 되면 아래에서 개수를 말하지 않는다(거짓말하지 않는다) */ }

    if (landed === 0) {
      return { ok: false, detail: '파일을 첨부했지만 입력칸이 비어 있습니다 — 이 화면이 파일을 거부했을 수 있습니다' }
    }
    const where = best.sessionId ? '(프레임 안 입력)' : ''
    const acc = best.accept ? ` accept="${best.accept}"` : ''
    const note = landed > 0 ? ` · 입력칸 파일 ${landed}개 확인` : ''
    return { ok: true, detail: `파일 ${filePaths.length}개 첨부됨${where}${acc}${note}` }
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
export async function dropFilesOnRef(wc: WebContents, ref: number, filePaths: string[], epoch?: string): Promise<{ ok: boolean; detail: string }> {
  if (wc.isDestroyed()) return { ok: false, detail: '탭이 닫혔습니다' }
  if (!filePaths.length) return { ok: false, detail: '선택된 파일이 없습니다' }
  const pt = await pointForRef(wc, ref, epoch)
  if (pt && isRefFail(pt)) return { ok: false, detail: pt.__fail }
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

// ===== 생성물 수집 — 페이지의 이미지 열거·바이트 읽기 (묶음 SOCIAL-1) =====
//
// 왜 따로 두는가: 관찰(observePage)은 **상호작용 요소**만 담는다(버튼·입력칸). 그래서 "AI 사이트가
// 방금 만들어 준 그림"은 관찰 목록에 아예 없거나 이름 없는 요소로만 잡힌다. 생성물을 가려내려면
// 이미지 자체의 주소·실제 픽셀 치수를 봐야 하므로 전용 열거를 둔다.
//
// 가려내기의 핵심은 **기준선 대비 새로 생긴 것**이다(agent.ts). 여기서는 판단하지 않고 목록만 준다 —
// 다만 로고·아이콘 같은 잡음이 목록을 채우지 않도록 면적 큰 순으로 정렬해 돌려준다.

export interface PageImage {
  src: string            // http(s) · data: · blob: · 'canvas:<n>'(캔버스는 주소가 없어 색인으로 집는다)
  width: number          // 실제 픽셀(naturalWidth) — CSS 로 줄여 그린 큰 이미지를 작다고 오판하지 않게
  height: number
  alt: string
  area: number
  kind: 'img' | 'canvas'
  frameId?: string       // 자식 프레임 안의 이미지면 그 프레임 키
  frameUrl?: string
}

const IMAGES_SCRIPT = (cap: number): string => `(() => {
  const out = []; const seen = new Set();
  const push = (src, w, h, alt, kind) => {
    if (!src || seen.has(src)) return;
    // 거대한 data: URI 는 목록에 실으면 IPC 왕복이 폭주한다. 캡처는 캔버스/주소 경로로 따로 한다.
    if (src.slice(0, 5) === 'data:' && src.length > 200000) return;
    seen.add(src);
    const W = Math.round(w) || 0, H = Math.round(h) || 0;
    out.push({ src: String(src).slice(0, 2000), width: W, height: H, alt: String(alt || '').slice(0, 80), area: W * H, kind });
  };
  try {
    for (const im of document.querySelectorAll('img')) {
      if (out.length >= ${cap}) break;
      let r = { width: 0, height: 0 };
      try { r = im.getBoundingClientRect(); } catch (e) {}
      push(im.currentSrc || im.src, im.naturalWidth || r.width, im.naturalHeight || r.height, im.alt, 'img');
    }
    const cvs = document.querySelectorAll('canvas');
    for (let i = 0; i < cvs.length && out.length < ${cap}; i++) {
      const cv = cvs[i];
      push('canvas:' + i, cv.width, cv.height, cv.getAttribute('aria-label') || '', 'canvas');
    }
  } catch (e) {}
  out.sort((a, b) => b.area - a.area);
  return out;
})()`

/**
 * 현재 페이지(및 허용된 자식 프레임)의 이미지 목록. 면적 큰 순.
 * 허용 사이트 밖 프레임은 **스크립트를 돌리지 않는다** — 관찰과 같은 규칙(frames.ts).
 */
export async function listPageImages(wc: WebContents, allowedHosts?: string[], cap = 60): Promise<PageImage[]> {
  if (wc.isDestroyed()) return []
  const url = wc.getURL()
  if (!/^https?:/i.test(url)) return []
  const out: PageImage[] = []
  try {
    const top = (await wc.executeJavaScript(IMAGES_SCRIPT(cap), true)) as PageImage[]
    if (Array.isArray(top)) out.push(...top)
  } catch (err) {
    console.warn('[ai-agent] listPageImages failed', err)
  }
  try {
    const { roots } = listObservationFrames(wc, allowedHosts)
    for (const r of roots) {
      if (out.length >= cap) break
      let fimgs: PageImage[] | null = null
      try { fimgs = (await r.frame.executeJavaScript(IMAGES_SCRIPT(20), true)) as PageImage[] } catch { fimgs = null }
      if (!Array.isArray(fimgs)) continue
      for (const im of fimgs) out.push({ ...im, frameId: r.id, frameUrl: r.url })
    }
  } catch { /* 프레임 열거 불가 환경 — 최상위 목록만 */ }
  out.sort((a, b) => b.area - a.area)
  return out.slice(0, cap)
}

const READ_URL_SCRIPT = (url: string, maxBytes: number): string => `(async () => {
  const toB64 = (buf) => {
    const bytes = new Uint8Array(buf); let s = ''; const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  };
  try {
    const u = ${JSON.stringify(url)};
    if (u.slice(0, 7) === 'canvas:') {
      const idx = parseInt(u.slice(7), 10) || 0;
      const cv = document.querySelectorAll('canvas')[idx];
      if (!cv) return { ok: false, error: '캔버스를 찾지 못했습니다' };
      // 다른 출처 이미지를 그린 캔버스는 보안상 읽을 수 없다(tainted). 우회하지 않고 그대로 실패로 알린다.
      let dataUrl = '';
      try { dataUrl = cv.toDataURL('image/png'); }
      catch (e) { return { ok: false, error: '캔버스를 읽을 수 없습니다(다른 출처 이미지가 그려져 보호됨)' }; }
      const comma = dataUrl.indexOf(',');
      return { ok: true, base64: dataUrl.slice(comma + 1), mime: 'image/png' };
    }
    const r = await fetch(u);
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    const b = await r.blob();
    if (b.size > ${maxBytes}) return { ok: false, error: '파일이 너무 큽니다(' + b.size + ' 바이트)' };
    if (b.size === 0) return { ok: false, error: '빈 파일입니다' };
    return { ok: true, base64: toB64(await b.arrayBuffer()), mime: b.type || '' };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) }; }
})()`

/**
 * 페이지 컨텍스트에서 주소를 읽어 base64 로 돌려준다.
 *
 * 왜 페이지에서 읽는가: `blob:` 은 그 문서 안에서만 유효한 주소라 메인 프로세스가 열 수 없다.
 * `canvas:` 도 마찬가지로 DOM 이 있어야 읽힌다. **http(s) 는 이 경로를 쓰지 마라** — 메인에서
 * 탭 세션으로 받는 편이 쿠키·Referer 가 정확하고 CORS 제약도 받지 않는다(artifacts 쪽에서 처리).
 */
export async function readUrlInPage(
  wc: WebContents, url: string, maxBytes: number, frameId?: string, frameUrl?: string,
): Promise<{ ok: boolean; base64?: string; mime?: string; error?: string }> {
  if (wc.isDestroyed()) return { ok: false, error: '탭이 닫혔습니다' }
  let target: WebContents | WebFrameMain = wc
  if (frameId) {
    const f = frameFromId(frameId, frameUrl)
    if (!f) return { ok: false, error: '이미지가 있던 프레임이 사라졌습니다(다시 관찰하세요)' }
    target = f
  }
  try {
    const r = await target.executeJavaScript(READ_URL_SCRIPT(url, maxBytes), true)
    if (r && typeof r === 'object') return r as { ok: boolean; base64?: string; mime?: string; error?: string }
    return { ok: false, error: '읽기 결과를 받지 못했습니다' }
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) }
  }
}

/**
 * 화면에서 대조 문구를 찾는다(게시 여부 확인 전용). **작성 중인 글은 근거로 세지 않는다.**
 *
 * 왜 관찰(observePage)의 본문 조각으로는 안 되는가 — 두 가지다.
 *
 * ① **잘린다.** 관찰이 프롬프트에 싣는 본문은 1800자 상한이다. 계정 첫 화면은 메뉴·안내가 길어서
 *    실제로 올라간 글이 그 뒤에 있으면 조각에는 안 보인다. 그 상태로 "근거 없음" 이라고 결론 내면
 *    **실제로 올라간 글을 못 봤다고 말하는 셈**이다.
 *
 * ② **작성창의 글까지 들어 있다.** `innerText` 는 contenteditable·textarea 의 내용을 포함한다.
 *    게시 작업이 캡션을 **입력만 하고** 중단된 탭이 열려 있으면, 확인 작업이 그 탭으로 넘어가
 *    "내 캡션이 이 사이트 화면에 보인다" 를 근거로 삼을 수 있다 — 아무것도 올라가지 않았는데
 *    완료로 확정된다. 모델의 결론과 런타임의 관찰이 **같은 화면 하나에 함께 속는** 경로다
 *    (이 저장소는 2026-09-13 에 같은 성질의 오탐을 완료 문구 쪽에서 이미 겪었다).
 *    그래서 편집 가능한 영역(textarea·input·contenteditable)의 텍스트는 **아예 빼고** 읽는다.
 *
 * 돌려주는 것은 **찾았는가와 짧은 발췌뿐**이라 프롬프트가 커지지 않는다(본문 전체를 모델에게
 * 보내지 않는다). 최상위 문서만 본다 — 교차 출처 프레임까지 뒤지면 "다른 사이트에서 본 것" 과
 * 구분이 흐려진다.
 *
 * ⚠ 인페이지 스크립트는 템플릿 리터럴 안에 있으므로 정규식의 백슬래시를 **두 번** 써야 한다
 *   (`\s`). 한 번만 쓰면 `\s` 가 `s` 로 접혀 `/s+/g` 가 나가고, 문법 오류가 아니라서 조용히 틀린다.
 */
export async function probeVerifyNeedles(
  wc: WebContents, needles: string[],
): Promise<VerifyProbeHit | null> {
  if (wc.isDestroyed() || needles.length === 0) return null
  const want = needles.filter((n) => typeof n === 'string' && n.length > 0)
  if (want.length === 0) return null
  try {
    const res = (await wc.executeJavaScript(VERIFY_PROBE_SCRIPT(want), true)) as Record<string, unknown> | null
    if (!res || typeof res.needle !== 'string' || !res.needle) return null
    const hit: VerifyProbeHit = {
      needle: res.needle,
      snippet: typeof res.snippet === 'string' ? res.snippet : '',
    }
    // 작성자는 **글 영역 안에서 읽은 것만** 근거가 된다. 스크립트가 그 밖에서 읽었다면(그럴 수 없게
    // 짜여 있지만, 이 검사는 계약을 코드로 못 박는 자리다) 여기서 버린다.
    if (typeof res.author === 'string' && res.author && res.authorScope === 'post') {
      hit.author = res.author
      hit.authorScope = 'post'
      // 출처를 함께 넘긴다 — 판정이 "확정 거부" 와 "모름" 을 가를 때 쓴다.
      // 알 수 없으면 보수적으로 heuristic 으로 본다(확정 거부에 쓰지 않는다).
      hit.authorSource = res.authorSource === 'structural' ? 'structural' : 'heuristic'
    }
    if (typeof res.postedAt === 'number' && Number.isFinite(res.postedAt) && res.postedAt > 0) {
      hit.postedAt = res.postedAt
      if (typeof res.postedAtText === 'string' && res.postedAtText) hit.postedAtText = res.postedAtText.slice(0, 60)
    } else if (typeof res.postedAtUnclear === 'string' && res.postedAtUnclear) {
      // 시각 표기는 있었지만 시간대가 없어 확정하지 못했다 — 사용자에게 **왜** 모르는지 그대로 말한다.
      hit.postedAtUnclear = res.postedAtUnclear.slice(0, 120)
    }
    if (typeof res.ambiguous === 'string' && res.ambiguous) hit.ambiguous = res.ambiguous.slice(0, 120)
    return hit
  } catch {
    return null
  }
}

/** `probeVerifyNeedles` 가 돌려주는 것 — `ReadSighting` 의 관찰 부분과 같은 모양. */
export interface VerifyProbeHit {
  needle: string
  snippet: string
  author?: string
  authorScope?: 'post'
  /** 작성자를 어떻게 읽었는가 — 구조적 표기(신뢰)인가 위치·모양 추정(휴리스틱)인가. */
  authorSource?: 'structural' | 'heuristic'
  postedAt?: number
  postedAtText?: string
  /** 시각 표기는 있었지만 시간대가 없어 확정하지 못한 사유. `postedAt` 이 없을 때만 채워진다. */
  postedAtUnclear?: string
  ambiguous?: string
}

/**
 * 인페이지 대조 스크립트. 문구를 찾는 데서 끝나지 않고 **그 문구가 있는 글 한 건**을 특정해
 * 작성자와 게시 시각까지 같이 읽는다(agent-gate 의 `sightingSupportsPublication` 이 그 셋으로 판정).
 *
 * 설계에서 물러설 수 없는 두 가지:
 *
 *  ① **작성자는 글 영역 안에서만 읽는다.** 화면 전체에서 찾으면 대부분의 사이트가 전역 막대에
 *     표시하는 **로그인한 내 계정**이 잡힌다 — 그러면 남의 글 페이지에서도 "내 글" 로 읽힌다.
 *     못 찾으면 못 찾은 채로 둔다(판정이 "모름" 으로 처리한다). 밖으로 넓혀 찾지 않는다.
 *
 *  ② **상대시각은 짧고 통째로 시각인 요소에서만 읽는다.** 글 영역 전체 텍스트에 정규식을 걸면
 *     캡션 안의 "3일 전에 갔던 카페" 같은 문장이 게시 시각으로 둔갑한다. 그래서 `<time datetime>`
 *     을 최우선으로 보고, 없으면 **20자 이하이고 전체가 시각 표기인** 요소만 본다.
 *
 * ⚠ 이 스크립트는 템플릿 리터럴 안에 있다 — 정규식 백슬래시는 **두 번**(`\\s`, `\\d`). 한 번만 쓰면
 *   문법 오류 없이 조용히 다른 정규식이 나간다(이 파일이 2026-09-19 에 실제로 겪은 결함이다).
 */
function VERIFY_PROBE_SCRIPT(want: string[]): string {
  return `(function(){
  try {
    // 게시 시각 파서 — agent-gate 의 \`parseUnambiguousPostTime\` **그 함수 자체**를 넣는다.
    // 문자열로 따로 적어 두면 언젠가 갈라지고, 그때 갈라진 쪽은 조용히 틀린 시각을 낸다.
    ${POST_TIME_FN_SRC}
    // ⚠ contenteditable 은 **대소문자 구분 없이** 잡아야 한다. 예전엔 [contenteditable="true"] 로
    //   값 정확 일치를 걸어 \`contenteditable="TRUE"\` 를 놓쳤다 — 그러면 "입력만 하고 안 올린 캡션"이
    //   게시 근거로 둔갑한다(이 배제가 그 사고를 막는 유일한 장치다).
    var SKIP = 'script,style,noscript,template,textarea,input,select,[contenteditable]:not([contenteditable="false"]):not([contenteditable="FALSE"])';
    var GLOBAL_NAV = 'nav,header,[role="banner"],[role="navigation"]';
    var CONTAINER = 'article,[role="article"],[data-post-id],li';
    var MAX_CONTAINER_TEXT = 3000;
    var MAX_HOPS = 10;

    // ── 1) 보이는 텍스트를 모으되, 조각마다 **어느 요소에서 왔는지**를 같이 기억한다.
    //    (예전 판은 통째로 이어 붙인 뒤 정규화해서 위치 정보를 잃었다 — 그러면 글을 특정할 수 없다.)
    var hay = '';
    var map = [];
    var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        // 작성 중인 글·스크립트 본문은 "화면에 올라간 글" 이 아니다.
        if (el.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      var raw = n.nodeValue;
      if (!raw) continue;
      var piece = String(raw).replace(/\\s+/g, ' ').trim().toLowerCase();
      if (!piece) continue;
      if (hay.length) hay += ' ';
      var start = hay.length;
      hay += piece;
      map.push({ el: n.parentElement, end: hay.length });
    }
    if (!hay) return null;

    // ── 2) 문구 찾기. **긴 것부터** — 더 구체적인 근거를 남긴다.
    //    (호출자가 내림차순으로 넘기지만 여기서 다시 정렬한다. 규칙이 호출 순서에 기대면
    //     호출자가 바뀌는 순간 조용히 달라진다 — agent-gate.matchNeedleInText 도 스스로 정렬한다.)
    var needles = ${JSON.stringify(want)}.slice().sort(function (a, b) { return b.length - a.length; });
    var found = null;
    for (var i = 0; i < needles.length; i++) {
      var at = hay.indexOf(needles[i]);
      if (at >= 0) { found = { needle: needles[i], at: at }; break; }
    }
    if (!found) return null;
    var from = Math.max(0, found.at - 40);
    var out = {
      needle: found.needle,
      snippet: hay.slice(from, found.at + found.needle.length + 40).trim().slice(0, 200),
    };

    // ── 3) 그 문구가 **어느 글**에 있는가.
    var startEl = null;
    for (var k = 0; k < map.length; k++) {
      if (map[k].end > found.at) { startEl = map[k].el; break; }
    }
    if (!startEl) { out.ambiguous = '문구가 있는 요소를 특정하지 못했습니다'; return out; }

    var container = null;
    var cur = startEl;
    for (var hop = 0; cur && hop < MAX_HOPS; hop++) {
      if (cur === document.body || cur === document.documentElement) break;
      if (cur.matches && cur.matches(CONTAINER)) { container = cur; break; }
      cur = cur.parentElement;
    }
    if (!container) { out.ambiguous = '글 단위 영역을 찾지 못했습니다'; return out; }
    if (container.closest && container.closest(GLOBAL_NAV)) {
      out.ambiguous = '글 영역이 전역 탐색 영역 안에 있습니다'; return out;
    }
    if (container.querySelector && container.querySelector(GLOBAL_NAV)) {
      out.ambiguous = '글 영역에 전역 탐색 영역이 섞여 있습니다'; return out;
    }
    if ((container.textContent || '').length > MAX_CONTAINER_TEXT) {
      out.ambiguous = '글 영역이 너무 커서 한 건으로 볼 수 없습니다'; return out;
    }

    // ── 4) 작성자 — **컨테이너 안에서만**, 그리고 **캡션보다 위에 있는 것만**.
    //
    // 왜 위치까지 보는가 (2026-09-19, 적대적 리뷰가 잡았다): 글 영역 안에서만 읽어도 부족하다.
    //  ⓐ **캡션 안의 멘션**("@friend")은 작성자 표기와 글자 모양이 똑같다. 그것을 작성자로 읽으면
    //     내 글을 "@friend 의 글" 로 단정하고, 사용자는 "내 글이 아니라는데?" 하며 **"게시 안 됨"**
    //     을 눌러 차단을 풀고 **같은 글을 또 올린다**. 반대로 남이 나를 멘션한 글은 "내 글" 로
    //     읽혀 **거짓 완료**가 된다. 양쪽 다 비가역이다.
    //  ⓑ **댓글 작성자 링크**도 같은 모양이라, 댓글이 하나만 달려도 후보가 여러 개가 돼 버린다.
    //
    // 거의 모든 소셜 레이아웃에서 **작성자는 캡션 위**, 멘션·댓글은 **캡션 아래**다. 그래서
    // 캡션 위치 앞의 후보만 보고, 그중 **캡션에 가장 가까운 것**(바로 위)을 고른다.
    // 구조적 표기(data-author/data-account)는 위치와 무관하게 신뢰한다.
    var structural = [];
    var heuristic = [];   // { name, pos }
    function normName(v) {
      var s = String(v == null ? '' : v).trim().replace(/^@+/, '').replace(/\\/+$/, '');
      return /^[A-Za-z0-9._-]{2,30}$/.test(s) ? s.toLowerCase() : '';
    }
    function posOf(el) {
      // 이 요소의 텍스트가 hay 의 어디쯤에서 시작하는가(대략) — map 을 거꾸로 훑어 찾는다.
      for (var q = 0; q < map.length; q++) {
        if (map[q].el && (map[q].el === el || el.contains(map[q].el))) return map[q].end;
      }
      return -1;
    }
    if (container.getAttribute) {
      var c1 = normName(container.getAttribute('data-account')) || normName(container.getAttribute('data-author'));
      if (c1 && structural.indexOf(c1) < 0) structural.push(c1);
    }
    var tagged = container.querySelectorAll('[data-account],[data-author]');
    for (var a = 0; a < tagged.length; a++) {
      var c2 = normName(tagged[a].getAttribute('data-account') || tagged[a].getAttribute('data-author'));
      if (c2 && structural.indexOf(c2) < 0) structural.push(c2);
    }
    if (structural.length > 1) {
      out.ambiguous = '작성자 표기가 여러 개입니다(' + structural.slice(0, 3).join(', ') + ')';
      return out;
    }
    if (structural.length === 1) {
      out.author = structural[0];
      out.authorScope = 'post';
      out.authorSource = 'structural';   // 이 출처의 불일치만 "확정" 으로 쓴다
    } else {
      var cands = container.querySelectorAll('a[href], span, b, strong, h1, h2, h3');
      for (var c = 0; c < cands.length; c++) {
        var el2 = cands[c];
        var name = '';
        var tx = (el2.textContent || '').trim();
        if (/^@[A-Za-z0-9._-]{2,30}$/.test(tx)) name = normName(tx);
        if (!name && el2.tagName === 'A') {
          var p = '';
          try { p = new URL(el2.getAttribute('href'), location.href).pathname; } catch (e) { p = ''; }
          var m = /^\\/([A-Za-z0-9._-]{2,30})\\/?$/.exec(p);
          if (m) name = normName(m[1]);
        }
        if (!name) continue;
        var pos = posOf(el2);
        if (pos < 0 || pos > found.at) continue;   // 캡션보다 아래(멘션·댓글)는 작성자가 아니다
        heuristic.push({ name: name, pos: pos });
      }
      if (heuristic.length) {
        heuristic.sort(function (x, y) { return x.pos - y.pos; });
        out.author = heuristic[heuristic.length - 1].name;   // 캡션 바로 위
        out.authorScope = 'post';
        out.authorSource = 'heuristic';   // 불일치해도 "확정" 으로 쓰지 않는다(모름으로 낮춘다)
      }
    }

    // ── 5) 게시 시각 — 컨테이너 안에서 찾은 것 중 **가장 이른 값**.
    //
    // 왜 가장 이른 값인가: 글 상세에는 댓글마다 시각이 있고, DOM 순서로 첫 번째를 집으면 **댓글 시각**을
    // 잡기 쉽다. 댓글은 언제나 글보다 뒤이므로 판정이 **체계적으로 "더 최근" 쪽으로 기울고**,
    // 오래 지난 글에 최근 댓글이 달린 경우 그 지난 글이 이번 게시의 근거로 통과한다.
    // 글은 자기 댓글보다 새로울 수 없다 — 가장 이른 값이 글의 시각에 가장 가깝다.
    //
    // ⚠ 시각은 **시간대가 명시된 값만** 받는다(__bbPostTime). 오프셋 없는 \`datetime\` 을 Date.parse 로
    //   읽으면 기계의 지역 시간으로 해석되어, 같은 글이 PC 마다 "새 글"/"지난 글" 로 갈린다.
    //   확정할 수 없으면 읽지 않고 **모름으로 남긴다**(사유는 postedAtUnclear 로 알린다).
    var now = Date.now();
    var best = 0, bestText = '';
    var sawTzLess = false;
    var times = container.querySelectorAll('time[datetime]');
    for (var t2 = 0; t2 < times.length; t2++) {
      var parsed = __bbPostTime(times[t2].getAttribute('datetime'));
      if (!parsed) { sawTzLess = true; continue; }
      if (!best || parsed < best) {
        best = parsed;
        bestText = ((times[t2].textContent || '').trim() || times[t2].getAttribute('datetime') || '').slice(0, 60);
      }
    }
    if (!best) {
      var UNITS = [
        { re: /^(\\d{1,4})\\s*초\\s*전$/, ms: 1000 },
        { re: /^(\\d{1,4})\\s*분\\s*전$/, ms: 60000 },
        { re: /^(\\d{1,4})\\s*시간\\s*전$/, ms: 3600000 },
        { re: /^(\\d{1,4})\\s*일\\s*전$/, ms: 86400000 },
        { re: /^(\\d{1,4})\\s*seconds?\\s+ago$/i, ms: 1000 },
        { re: /^(\\d{1,4})\\s*minutes?\\s+ago$/i, ms: 60000 },
        { re: /^(\\d{1,4})\\s*hours?\\s+ago$/i, ms: 3600000 },
        { re: /^(\\d{1,4})\\s*days?\\s+ago$/i, ms: 86400000 },
      ];
      var stamps = container.querySelectorAll('time,span,small,abbr,a,div,p');
      for (var d = 0; d < stamps.length; d++) {
        var st = (stamps[d].textContent || '').replace(/\\s+/g, ' ').trim();
        if (!st || st.length > 20) continue;
        var val = 0;
        if (/^(방금|방금 전|just now)$/i.test(st)) val = now;
        else {
          for (var u = 0; u < UNITS.length; u++) {
            var mm = UNITS[u].re.exec(st);
            if (mm) { val = now - (parseInt(mm[1], 10) * UNITS[u].ms); break; }
          }
        }
        if (val && (!best || val < best)) { best = val; bestText = st; }
      }
    }
    if (best) { out.postedAt = best; out.postedAtText = bestText; }
    else if (sawTzLess) {
      out.postedAtUnclear = '글의 시각 표기에 시간대가 없어 어느 시점인지 확정할 수 없습니다';
    }
    return out;
  } catch (e) { return null; }
})()`
}
