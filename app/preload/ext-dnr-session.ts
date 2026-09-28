// ext-dnr-session.ts — 확장 서비스워커/프레임 컨텍스트에 세션 단위로 주입되는 preload.
//
// 왜 (묶음 J 항목 2): `chrome.declarativeNetRequest.updateSessionRules` 로 넣은 룰은
// Chromium 이 **디스크에 절대 쓰지 않는다**(세션 룰의 API 설계 자체가 "메모리에만, 재시작하면
// 사라짐" — 동적 룰과 달리 디스크 경유 가로채기(임무 39 의 `watchDiskDynamicRules`)가 원천적으로
// 안 통한다). 그래서 우리 엔진이 그 룰을 알 방법은 확장이 호출하는 그 순간을 **직접 가로채는 것**뿐이다.
//
// 이 파일은 `session.registerPreloadScript({ type: 'service-worker' | 'frame', filePath })` 로
// 확장 세션에 등록된다(adapter.ts 의 registerExtDnrSessionPreload). electron-chrome-extensions
// 라이브러리 자신의 browserAction preload 와 같은 방식 — 확장 컨텍스트에서 `require('electron')` 가
// 가능한 특권 preload 컨텍스트(일반 렌더러 sandbox preload 와 다름)에서 실행된다.
//
// 네이티브 `chrome.declarativeNetRequest.updateSessionRules`/`updateEnabledRulesets` 자체는
// Electron/Chromium 이 이미 구현해 두었다(요청을 받아 저장은 하지만 **집행하지 않는다** — 임무 36의
// 발견과 같은 성격). 여기서는 그 함수를 감싸 우리 IPC 로도 같은 내용을 보내고, 원래 함수는 그대로
// 불러 확장 쪽 Promise 계약(성공/실패)은 깨지 않는다.
//
// ⚠ 이 전략이 실제로 통하려면 **preload 가 확장의 자체 스크립트보다 먼저 실행돼야** 한다.
// `registerPreloadScript` 가 그 순서를 보장하는지는 harness(verify-extension-ux-cdp.mjs)의
// 실측으로만 확인할 수 있다 — 안 되면 `globalThis.__bbDnrSessionPreload` 가 그대로 false 로 남고,
// 그 경우 dnr.ts 의 세션 룰은 정직하게 GAP 으로 남는다(추측으로 "된다"고 적지 않는다).

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ipcRenderer } = require('electron') as typeof import('electron')

interface RawRuleLike { id?: number }
interface DnrLike {
  updateSessionRules?: (opts: { addRules?: RawRuleLike[]; removeRuleIds?: number[] }) => Promise<void>
  getSessionRules?: (...args: unknown[]) => Promise<RawRuleLike[]>
  updateEnabledRulesets?: (opts: { enableRulesetIds?: string[]; disableRulesetIds?: string[] }) => Promise<void>
  getEnabledRulesets?: (...args: unknown[]) => Promise<string[]>
}

try {
  const g = globalThis as typeof globalThis & { chrome?: { declarativeNetRequest?: DnrLike } }
  const dnr = g.chrome?.declarativeNetRequest
  if (dnr && typeof dnr === 'object') {
    let extId = ''
    try { extId = new URL(location.href).hostname } catch { /* location 없는 컨텍스트 — extId 빈 채로 둔다 */ }

    // 하네스·진단용 신호 — "이 컨텍스트에서 preload 가 실제로 돌았다"를 확인하는 유일한 방법이다.
    ;(g as unknown as Record<string, unknown>).__bbDnrSessionPreload = true

    if (typeof dnr.updateSessionRules === 'function') {
      const orig = dnr.updateSessionRules.bind(dnr)
      dnr.updateSessionRules = (opts) => {
        void ipcRenderer.invoke('bb-dnr:update', {
          extId, scope: 'session', addRules: opts?.addRules, removeRuleIds: opts?.removeRuleIds,
        }).catch(() => undefined)
        return orig(opts)
      }
    }

    if (typeof dnr.getSessionRules === 'function') {
      const orig = dnr.getSessionRules.bind(dnr)
      dnr.getSessionRules = async (...args: unknown[]) => {
        try {
          const mine = await ipcRenderer.invoke('bb-dnr:get', { extId, scope: 'session' }) as RawRuleLike[]
          if (Array.isArray(mine) && mine.length > 0) return mine
        } catch { /* 우리 쪽이 실패해도 네이티브 결과로 물러난다 */ }
        return orig(...args)
      }
    }

    if (typeof dnr.updateEnabledRulesets === 'function') {
      const orig = dnr.updateEnabledRulesets.bind(dnr)
      dnr.updateEnabledRulesets = (opts) => {
        void ipcRenderer.invoke('bb-dnr:rulesets', {
          extId, enableRulesetIds: opts?.enableRulesetIds, disableRulesetIds: opts?.disableRulesetIds,
        }).catch(() => undefined)
        return orig(opts)
      }
    }

    if (typeof dnr.getEnabledRulesets === 'function') {
      const orig = dnr.getEnabledRulesets.bind(dnr)
      dnr.getEnabledRulesets = async (...args: unknown[]) => {
        const native = await orig(...args)
        try {
          const disabled = await ipcRenderer.invoke('bb-dnr:rulesets-get', { extId }) as string[]
          if (Array.isArray(native) && Array.isArray(disabled) && disabled.length > 0) {
            return native.filter((id) => !disabled.includes(id))
          }
        } catch { /* ignore */ }
        return native
      }
    }
  }
} catch {
  // 확장 컨텍스트가 아니거나(location/chrome 미정의) 예외적 상황 — preload 가 앱을 절대
  // 깨서는 안 되므로 조용히 넘어간다. __bbDnrSessionPreload 가 안 찍히면 그게 곧 신호다.
}
