---
name: adblock-engine
description: @ghostery/adblocker-electron 통합. EasyList + EasyPrivacy + KR 필터, 직렬화 캐시, 사이트별 강도, 확장 충돌 정책.
---

# Adblock Engine

## 의존성

```bash
npm i @ghostery/adblocker-electron cross-fetch
```

## 부트 (engine.bin 캐시)

```ts
import { ElectronBlocker, fullLists } from '@ghostery/adblocker-electron'
import fetch from 'cross-fetch'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const ENGINE_PATH = path.join(app.getPath('userData'), 'adblock/engine.bin')

async function buildBlocker(): Promise<ElectronBlocker> {
  return ElectronBlocker.fromLists(
    fetch,
    [
      ...fullLists,
      'https://raw.githubusercontent.com/List-KR/List-KR/master/filter.txt',
      'https://easylist-downloads.adblockplus.org/easylist.txt',
      'https://easylist-downloads.adblockplus.org/easyprivacy.txt',
    ],
    { enableCompression: true },
    {
      path: ENGINE_PATH,
      read: fs.readFile,
      write: fs.writeFile,
    },
  )
}

let blocker: ElectronBlocker | null = null

export async function initAdblock() {
  blocker = await buildBlocker()
  blocker.enableBlockingInSession(session.defaultSession)
}
```

부팅 시 캐시된 engine.bin 가 있으면 즉시 적용(빠른 시작) + 백그라운드 갱신.

## 강도 3단계

내부 표현은 enable/disable 할 필터 카테고리:

```ts
const FILTERS_BY_LEVEL = {
  lite:     ['easylist'],
  standard: ['easylist', 'easyprivacy', 'list-kr'],
  strict:   ['easylist', 'easyprivacy', 'list-kr', 'annoyances', 'fanboy-social'],
}

function applyLevel(level: 'lite' | 'standard' | 'strict') {
  buildBlocker(FILTERS_BY_LEVEL[level]).then(b => {
    blocker?.disableBlockingInSession(session.defaultSession)
    blocker = b
    b.enableBlockingInSession(session.defaultSession)
  })
}
```

## 사이트별 정책 (policy-engine 과 협업)

`policy-engine-developer` 의 룰에서 `adblock: 'off' | 'lite' | ...` 가 도메인별 override. 구현:

```ts
// 매 요청 전, policyEngine 이 도메인 조회 → 차단 결정 변경
blocker.match = patchedMatchFunction(originalMatch, policyEngine)
```

또는 도메인별 별 session partition 두고 각 partition 에 강도 다른 blocker 부착.

## 통계

```ts
blocker.on('request-blocked', (req) => {
  stats.increment(`${tabUrl(req.tabId)}.blocked`)
})
```

매일 자정 회전, 30일 유지.

## 필터 갱신

```ts
setInterval(async () => {
  try {
    const fresh = await buildBlocker()
    blocker?.disableBlockingInSession(session.defaultSession)
    blocker = fresh
    fresh.enableBlockingInSession(session.defaultSession)
  } catch (e) {
    log.warn('adblock filter update failed', e)
  }
}, 24 * 3600 * 1000)
```

## 확장과의 충돌 정책

uBO/AdGuard 등 광고차단 확장이 활성화되어 있고 자체 엔진도 ON 이면:
1. 첫 발견 시 사용자에게 한 번 다이얼로그
   "자체 광고 차단과 확장이 둘 다 활성화되어 있습니다. 어느 쪽을 사용하시겠습니까?"
2. 선택을 영구 저장 (재질문 안 함)
3. 비활성 측은 룰 등록 차단 / 엔진 disable

## 가벼움

- 엔진 메모리 ≤ 80MB (압축 + 트라이)
- engine.bin 디스크 ≤ 15MB
- 매칭 동기 (O(log N)) — IPC 비용 없음

## 절대 피할 것

- 필터 갱신을 부팅 동기 — async + 캐시 fallback
- 차단 결정 IPC 거치게 — main 동기 lookup
- 사용자 화이트리스트 무시 — 정책 엔진 우선
- 시크릿 세션도 통계 누적 — 시크릿은 카운터만 메모리, 디스크 미반영
