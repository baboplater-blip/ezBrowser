// ext-dnr.ts — 확장 컨텍스트에 `chrome.declarativeNetRequest` 동적 룰 API 를 노출한다.
//
// 왜 (2026-09-07, 임무 38): 정적 룰셋은 임무 36 에서 지원했지만, uBO Lite 의 **사용자 필터·
// 사이트별 해제**는 `updateDynamicRules` / `updateSessionRules` 로 런타임에 룰을 바꾼다.
// 그 API 가 없으면 확장은 조용히 실패하거나(예외) 사용자가 끈 사이트에서도 계속 막는다.
//
// `electron-chrome-extensions` 가 chrome.runtime·chrome.windows 등을 preload 로 넣는 것과
// **같은 방식**(session.registerPreloadScript 의 'frame' + 'service-worker')으로 얹는다.
// 이미 있는 `chrome` 객체를 **증강**하고, 없으면 최소한으로 만든다 — 남의 API 를 덮지 않는다.

import { ipcRenderer } from 'electron'

interface DynRuleArgs {
  addRules?: unknown[]
  removeRuleIds?: number[]
}

type ChromeLike = {
  runtime?: { id?: string }
  declarativeNetRequest?: Record<string, unknown>
}

const g = globalThis as unknown as { chrome?: ChromeLike }

/** 확장 id — 라이브러리가 넣어 준 chrome.runtime.id 를 그때그때 읽는다(로드 순서에 안 매이게). */
function extId(): string {
  return String(g.chrome?.runtime?.id ?? '')
}

/**
 * 크롬 API 는 콜백과 프라미스를 모두 받는다(MV3 은 프라미스가 기본).
 * 마지막 인자가 함수면 콜백으로도 돌려준다.
 */
function dual<T>(p: Promise<T>, cb?: unknown): Promise<T> | void {
  if (typeof cb === 'function') {
    void p.then((v) => { try { (cb as (x: T) => void)(v) } catch { /* 확장 콜백 예외는 우리 문제가 아니다 */ } })
    return
  }
  return p
}

const api = {
  updateDynamicRules: (args: DynRuleArgs, cb?: unknown) =>
    dual(ipcRenderer.invoke('bb-dnr:update', { extId: extId(), scope: 'dynamic', ...args }), cb),
  getDynamicRules: (cb?: unknown) =>
    dual(ipcRenderer.invoke('bb-dnr:get', { extId: extId(), scope: 'dynamic' }), cb),
  updateSessionRules: (args: DynRuleArgs, cb?: unknown) =>
    dual(ipcRenderer.invoke('bb-dnr:update', { extId: extId(), scope: 'session', ...args }), cb),
  getSessionRules: (cb?: unknown) =>
    dual(ipcRenderer.invoke('bb-dnr:get', { extId: extId(), scope: 'session' }), cb),
  updateEnabledRulesets: (args: { enableRulesetIds?: string[]; disableRulesetIds?: string[] }, cb?: unknown) =>
    dual(ipcRenderer.invoke('bb-dnr:rulesets', { extId: extId(), ...args }), cb),
  getEnabledRulesets: (cb?: unknown) =>
    dual(ipcRenderer.invoke('bb-dnr:rulesets-get', { extId: extId() }), cb),
  // 확장이 존재를 확인하는 데 쓰는 상수들(크롬과 같은 이름).
  MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 30000,
  MAX_NUMBER_OF_REGEX_RULES: 1000,
}

try {
  // 이 preload 가 실제로 실행됐는지 확인하는 표식(검증 하네스가 읽는다).
  ;(globalThis as unknown as { __bbDnrPreload?: boolean }).__bbDnrPreload = true
  // ⚠ 'frame' 등록은 **일반 웹페이지에도** 적용된다. 확장 컨텍스트가 아니면 아무 것도 정의하지 않는다
  //   — 웹페이지에 chrome.declarativeNetRequest 를 노출하면 지문·오탐의 원인이 된다.
  const isExtensionContext = typeof g.chrome?.runtime?.id === 'string' && g.chrome.runtime.id.length > 0
  if (!isExtensionContext) throw new Error('확장 컨텍스트 아님')
  if (!g.chrome) g.chrome = {}
  const existing = g.chrome.declarativeNetRequest
  // ⚠ Electron 은 `chrome.declarativeNetRequest` **표면만** 제공한다 — updateDynamicRules 를 받아
  //   저장하고 getDynamicRules 로 돌려주지만 **집행하지 않는다**(2026-09-07 실측: 룰은 저장되는데
  //   요청이 그대로 나갔고 우리 메인 IPC 에는 아무 것도 오지 않았다).
  //   그래서 우리가 구현한 메서드가 **이기도록** 나중에 얹는다. 우리가 모르는 나머지는 그대로 둔다.
  g.chrome.declarativeNetRequest = Object.assign({}, existing ?? {}, api)
} catch {
  /* 확장 컨텍스트가 아니면 아무 것도 하지 않는다 */
}
