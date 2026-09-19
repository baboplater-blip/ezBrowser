"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.passkeyModeFor = passkeyModeFor;
exports.trackWebContents = trackWebContents;
const settings_1 = require("../../storage/settings");
const permissions_1 = require("../../storage/permissions");
function passkeyModeFor(url) {
    const site = (0, permissions_1.getPermissionDecision)(url, 'passkey');
    if (site === 'deny')
        return 'deny';
    if (site === 'allow')
        return 'allow';
    const g = (0, settings_1.getSetting)('privacy').passkeyAutoPrompt;
    return g === 'allow' ? 'allow' : 'block-conditional';
}
// main world 에 넣는 스크립트. 지문을 최소화한다(리뷰 반영):
//  - navigator 인스턴스에 own property 를 심지 않고 **CredentialsContainer.prototype.get/create** 만 패치 → hasOwnProperty·instanceof 그대로.
//  - 조건부 요청은 거부가 아니라 **영구 대기**(어떤 브라우저든 "맞는 자격증명 없음" 상태는 pending 이다 — 즉시 NotAllowedError 는
//    실제 브라우저에 없는 패턴이라 그 자체가 신호). 사이트 'deny' 만 명시 거부.
//  - 래퍼 함수의 name/length/toString 을 원본처럼 보이게(Function.prototype.toString.call 까지는 못 막는다 — 알려진 잔여).
function buildScript(mode) {
    const rejectAll = mode === 'deny';
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
  }catch(e){}})();`;
}
const tracked = new WeakSet();
function trackWebContents(wc) {
    if (tracked.has(wc))
        return;
    tracked.add(wc);
    const apply = () => {
        if (wc.isDestroyed())
            return;
        const url = wc.getURL();
        if (!/^https?:/i.test(url))
            return;
        const mode = passkeyModeFor(url);
        if (mode === 'allow')
            return;
        wc.executeJavaScript(buildScript(mode), true).catch(() => { });
    };
    wc.on('dom-ready', apply);
    wc.on('did-navigate-in-page', apply);
}
