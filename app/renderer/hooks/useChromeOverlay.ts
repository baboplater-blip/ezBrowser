import { useEffect } from 'react'

// chrome WebContentsView 는 평소 콘텐츠 탭 view 아래에 있다(z-order). 모달·토스트·컨텍스트 메뉴 같은
// 오버레이가 화면에 보이려면(그리고 마우스 입력을 받으려면) chrome 을 일시적으로 최상위로
// 승격(windows.beginPaneDrag)했다가, 오버레이가 모두 닫히면 원래 순서로 복구(windows.endPaneDrag)해야 한다.
//
// 문제는 오버레이가 여러 개 동시에 열릴 수 있다는 것 — 예: 팔레트가 열린 상태에서 토스트가 뜨는 경우.
// 각 오버레이가 독립적으로 begin/end 를 호출하면 먼저 닫힌 쪽이 endPaneDrag 를 불러 아직 열려있는
// 다른 오버레이까지 강등시켜 버릴 수 있다. 이를 막기 위해 윈도우별 참조 카운터를 모듈 스코프에 두고,
// 0→1 로 올라갈 때만 실제 beginPaneDrag 를, 1→0 으로 내려갈 때만 실제 endPaneDrag 를 호출한다.
const counters = new Map<string, number>()

/** 카운터를 1 올리고, 0→1 전이일 때만 실제 chrome 승격을 호출한다. */
export function acquireChromeOverlay(windowId: string): void {
  const next = (counters.get(windowId) ?? 0) + 1
  counters.set(windowId, next)
  if (next === 1) void window.browserAPI.windows.beginPaneDrag(windowId)
}

/** 카운터를 1 내리고, 1→0 전이일 때만 실제 chrome 강등을 호출한다. 0 밑으로는 내려가지 않는다. */
export function releaseChromeOverlay(windowId: string): void {
  const cur = counters.get(windowId) ?? 0
  const next = Math.max(0, cur - 1)
  counters.set(windowId, next)
  if (next === 0) void window.browserAPI.windows.endPaneDrag(windowId)
}

/**
 * 콘텐츠 탭 view 위로 chrome 을 승격시켜야 하는 오버레이(모달·토스트·컨텍스트 메뉴·드롭다운 등)를
 * 위한 훅. `active` 가 true 인 동안 모듈 스코프 카운터를 점유하고, false 가 되거나 언마운트되면
 * 반납한다. 여러 오버레이가 동시에 열려 있어도 서로 승격/강등이 꼬이지 않는다.
 *
 * StrictMode 의 effect 이중 실행에도 acquire/release 가 항상 쌍으로 실행되므로 안전하다
 * (mount → acquire, unmount → release, 다시 mount → acquire — 카운터는 항상 일관된 상태로 수렴한다).
 */
export function useChromeOverlay(windowId: string | null | undefined, active: boolean): void {
  useEffect(() => {
    if (!windowId || !active) return
    acquireChromeOverlay(windowId)
    return () => releaseChromeOverlay(windowId)
    // windowId/active 가 바뀔 때만 재평가하면 된다 — acquire/release 는 참조가 안정적인 모듈 함수.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowId, active])
}
