// gc-nudge.ts — 부팅 중 1회성 대량 파싱(필터 리스트·JSON 설정 여러 개·sql.js WASM 초기화 등)이
// 남긴 V8 스크래치 힙을 GC 로 회수 시도하는 유틸. V8 은 힙을 프로세스 수명 내내 보유하는 경향이 있어
// (freed object 를 OS 에 즉시 반환하지 않음) 부팅 직후 이 힙이 "새 바닥"으로 굳어버릴 수 있다 —
// 실측: adblock 콜드 빌드 직후 강제 GC 로 메인 프로세스 private working set 이 뚜렷이 줄어듦
// (231MB → 206MB, 8초 안정화 시점 기준). `node --expose-gc` 없이도 런타임에 `--expose-gc` 플래그를
// 걸고 새 vm context 에서 `gc` 참조를 얻는 표준 트릭(Node 문서에 언급되는 패턴) 사용 — 힙은 격리
// 단위(isolate)라 새 context 에서 부른 gc() 도 프로세스 전체 힙에 적용된다.
//
// 필터·차단 동작·기능 자체에는 어떤 영향도 없음(순수 메모리 회수) — "필터를 줄이는" 개선이 아니다.

import v8 from 'node:v8'
import vm from 'node:vm'

let cachedGc: (() => void) | null = null
let unavailable = false

/** 베스트 에포트 GC 넛지. 실패해도 무해 — 호출부는 결과를 기다리거나 검사할 필요 없음. */
export function nudgeGc(label: string): void {
  if (unavailable) return
  try {
    if (!cachedGc) {
      v8.setFlagsFromString('--expose-gc')
      cachedGc = vm.runInNewContext('gc') as () => void
    }
    cachedGc()
  } catch (err) {
    unavailable = true
    console.warn(`[gc-nudge] 사용 불가 — 이후 스킵 (${label})`, err)
  }
}
