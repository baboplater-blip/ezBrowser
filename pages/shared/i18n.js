// 모든 browser:// 내부 페이지가 공유하는 i18n 로더. 빌드 없이 순정 JS(ES5 수준) —
// 규약은 docs/i18n.md. 쓰려면 그 페이지가:
//   1) CSP script-src 에 `browser://shared` 추가
//   2) <script src="browser://shared/i18n.js"></script> 를 <head> 에 넣기
//      (internalAPI 는 preload 가 window 생성 전 주입하므로 <head> 에 둬도 안전)
//   3) 정적 텍스트: <span data-i18n="page.foo.bar">한국어 원문</span>
//      속성:       <input data-i18n-attr="placeholder:page.foo.ph;title:page.foo.title">
//   4) 동적(JS 템플릿) 텍스트: window.t('page.foo.bar', '한국어 폴백')
//   5) 언어가 바뀔 때 다시 그려야 하는 동적 화면은 window.onI18nChanged(fn) 로 재렌더 훅을 건다.
//
// 원문(ko)을 항상 HTML/폴백에 그대로 남겨 두면 ko 사용자는 사전이 늦게 와도 깜빡임이 없고,
// en/vi 사용자만 사전 도착 시 한 번 다시 칠해진다(대량 이행 전까지 감수하는 비용 — docs/i18n.md 참고).
(function () {
  'use strict'

  var state = { locale: 'ko', dict: {} }
  var listeners = []

  function interpolate(str, vars) {
    if (!vars) return str
    return str.replace(/\{(\w+)\}/g, function (m, k) {
      return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
    })
  }

  window.t = function (key, fallback, vars) {
    var v = state.dict[key]
    if (typeof v !== 'string') return fallback !== undefined ? fallback : key
    return interpolate(v, vars)
  }

  window.getI18nLocale = function () { return state.locale }

  window.onI18nChanged = function (cb) {
    if (typeof cb === 'function') listeners.push(cb)
  }

  function applyStatic() {
    var nodes = document.querySelectorAll('[data-i18n]')
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      var key = el.getAttribute('data-i18n')
      var v = state.dict[key]
      if (typeof v === 'string') el.textContent = v
    }
    var attrNodes = document.querySelectorAll('[data-i18n-attr]')
    for (var j = 0; j < attrNodes.length; j++) {
      var el2 = attrNodes[j]
      var spec = el2.getAttribute('data-i18n-attr') || ''
      var pairs = spec.split(';')
      for (var p = 0; p < pairs.length; p++) {
        var pair = pairs[p].trim()
        if (!pair) continue
        var idx = pair.indexOf(':')
        if (idx < 0) continue
        var attr = pair.slice(0, idx).trim()
        var key2 = pair.slice(idx + 1).trim()
        var v2 = state.dict[key2]
        if (typeof v2 === 'string') el2.setAttribute(attr, v2)
      }
    }
  }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state) } catch (e) { console.error('[i18n] listener 오류', e) }
    }
  }

  function onPayload(payload) {
    if (!payload || typeof payload !== 'object') return
    state = payload
    applyStatic()
    notify()
  }

  function run() {
    if (!window.internalAPI || !window.internalAPI.i18n) return // browser:// 가 아닌 컨텍스트(있을 리 없지만 방어)
    window.internalAPI.i18n.get().then(onPayload).catch(function () { /* ko 폴백 유지 */ })
    window.internalAPI.i18n.onChanged(onPayload)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run)
  } else {
    run()
  }
})()
