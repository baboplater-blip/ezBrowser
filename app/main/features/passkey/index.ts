import type { WebContents } from 'electron'
import { getSetting } from '../../storage/settings'
import { getPermissionDecision } from '../../storage/permissions'

// 패스키(WebAuthn) 요청 처리.
//
// 왜 (2026-09-13, 인스타 실사이트 파일럿): 인스타그램 로그인 페이지는 로드 직후 `navigator.credentials.get({ mediation: 'conditional' })`
// 를 부른다. 크롬은 이 "조건부" 요청을 아이디 입력칸의 자동완성 목록에 "패스키로 로그인" 항목으로 조용히 넣지만,
// Electron 에는 그 자동완성 UI 가 없어 Windows 의 "암호 키로 로그인 — 보안 키를 USB 에 꽂으세요" OS 모달이 튀어나온다
// (Chromium 플래그 --disable-features=WebAuthenticationConditionalUI 로는 달라지지 않음 — 실측).
//
// 설계: **조건부 요청만 기본 보류**(영구 대기 — 우리가 어차피 채워 줄 수 없는 요청), 사용자가 "패스키로 로그인" 버튼을 눌러 생기는
// 명시 요청(mediation optional/required)은 그대로 둔다(그때의 OS 창은 기대되는 동작). 사이트별 오버라이드는 권한 저장소의
// 의사권한 'passkey' — allow(조건부도 허용) / deny(모든 WebAuthn 거부) / 기본.
// 주입은 dom-ready 시 main world 로(정책 엔진 customJs 와 같은 경로, CSP 무관). 페이지 스크립트보다 늦을 가능성은
// 인스타에서 실측으로 확인한다(하네스 + 실사이트 프로브).

export type PasskeyMode = 'block-conditional' | 'allow' | 'deny'

export function passkeyModeFor(url: string): PasskeyMode {
  const site = getPermissionDecision(url, 'passkey')
  if (site === 'deny') return 'deny'
  if (site === 'allow') return 'allow'
  const g = getSetting('privacy').passkeyAutoPrompt
  return g === 'allow' ? 'allow' : 'block-conditional'
}

// main world 에 넣는 스크립트. 지문을 최소화한다(리뷰 반영):
//  - navigator 인스턴스에 own property 를 심지 않고 **CredentialsContainer.prototype.get/create** 만 패치 → hasOwnProperty·instanceof 그대로.
//  - 조건부 요청은 거부가 아니라 **영구 대기**(어떤 브라우저든 "맞는 자격증명 없음" 상태는 pending 이다 — 즉시 NotAllowedError 는
//    실제 브라우저에 없는 패턴이라 그 자체가 신호). 사이트 'deny' 만 명시 거부.
//  - 래퍼 함수의 name/length/toString 을 원본처럼 보이게(Function.prototype.toString.call 까지는 못 막는다 — 알려진 잔여).
function buildScript(mode: PasskeyMode): string {
  const rejectAll = mode === 'deny'
  return `(function(){try{
    var P = window.CredentialsContainer && window.CredentialsContainer.prototype; if (!P) return;
    if (P.__bbPasskeyMode === ${JSON.stringify(mode)}) return;
    var og = P.__bbOrigGet || P.get, oc = P.__bbOrigCreate || P.create;
    Object.defineProperty(P, '__bbOrigGet', { value: og, configurable: true, enumerable: false });
    Object.defineProperty(P, '__bbOrigCreate', { value: oc, configurable: true, enumerable: false });
    Object.defineProperty(P, '__bbPasskeyMode', { value: ${JSON.stringify(mode)}, configurable: true, enumerable: false });
    function deny(){ return Promise.reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError')); }
    function hold(){ return new Promise(function(){}); }
    function mask(fn, orig){
      try { Object.defineProperty(fn, 'name', { value: orig.name }); Object.defineProperty(fn, 'length', { value: orig.length }); } catch (e) {}
      try { Object.defineProperty(fn, 'toString', { value: function(){ return Function.prototype.toString.call(orig); }, configurable: true, writable: true }); } catch (e) {}
      return fn;
    }
    var g = mask(function get(o){ if (${rejectAll}) return deny(); if (o && o.mediation === 'conditional' && o.publicKey) return hold(); return og.call(this, o); }, og);
    var c = mask(function create(o){ if (${rejectAll} && o && o.publicKey) return deny(); return oc.call(this, o); }, oc);
    Object.defineProperty(P, 'get', { value: g, configurable: true, writable: true, enumerable: true });
    Object.defineProperty(P, 'create', { value: c, configurable: true, writable: true, enumerable: true });
  }catch(e){}})();`
}

const tracked = new WeakSet<WebContents>()

export function trackWebContents(wc: WebContents): void {
  if (tracked.has(wc)) return
  tracked.add(wc)
  const apply = (): void => {
    if (wc.isDestroyed()) return
    const url = wc.getURL()
    if (!/^https?:/i.test(url)) return
    const mode = passkeyModeFor(url)
    if (mode === 'allow') return
    wc.executeJavaScript(buildScript(mode), true).catch(() => { /* 페이지 전환 중 등 — 무시 */ })
  }
  wc.on('dom-ready', apply)
  wc.on('did-navigate-in-page', apply)
}
