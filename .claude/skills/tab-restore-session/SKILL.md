---
name: tab-restore-session
description: 세션 저장·복원 — 정상 종료·비정상 종료 모두. 창·탭 트리·스크롤 위치·폼 데이터 일부. 복원 정책(매번/마지막/안함).
---

# Session Restore

## 저장 단위

`userData/sessions/` 아래:
- `current.json` — 가장 최근 (5초 디바운스 저장)
- `last-stable.json` — 정상 종료 시 백업
- `crash-<timestamp>.json` — 비정상 종료 직전 (process exit 핸들)

## 스키마

```ts
interface SessionSnapshot {
  version: number
  savedAt: number
  windows: Array<{
    id: string
    bounds: { x: number; y: number; width: number; height: number }
    workspaceId: string
    activeTabId: string
    tabs: Array<{
      id: string
      url: string
      title: string
      favicon?: string
      pinned: boolean
      groupId?: string
      scrollY?: number       // navigation history 보다 가벼움
      formData?: Record<string, string>  // 옵션, 민감하면 skip
    }>
    groups: Array<{ id: string; title: string; color: string; collapsed: boolean }>
  }>
}
```

## 저장 트리거

- 탭 생성·종료·이동·URL 변경 → 5초 디바운스
- 창 리사이즈·이동 → 1초 디바운스
- 30초 주기 강제 저장 (디바운스 무효화)
- `before-quit` 이벤트 → `last-stable.json` 동기 쓰기

## 비정상 종료 감지

부팅 시:
1. `current.json` 존재하고 `last-stable.json` 보다 새것 → 비정상 종료 후보
2. 사용자에게 "지난 세션 복원하시겠습니까?" 다이얼로그
3. 동의 → `current.json` 으로 복원
4. 거부 → `last-stable.json` 로 복원 또는 새 시작

## 복원 정책 (settings.startup.mode)

- `newtab` — 새 탭 1개로 시작
- `last-session` — `last-stable.json` 자동 복원 (다이얼로그 없음)
- `urls` — 사용자 지정 URL 목록

## 복원 흐름

```ts
async function restoreWindow(snap: WindowSnap) {
  const win = await windowService.create({ bounds: snap.bounds, workspaceId: snap.workspaceId })
  for (const tabSnap of snap.tabs) {
    const tab = await tabService.create({
      windowId: win.id, url: tabSnap.url,
      pinned: tabSnap.pinned, groupId: tabSnap.groupId,
      background: tabSnap.id !== snap.activeTabId,
    })
    // 스크롤 복원: did-finish-load 후
    tab.webContents.once('did-finish-load', () => {
      if (tabSnap.scrollY) {
        tab.webContents.executeJavaScript(`window.scrollTo(0, ${tabSnap.scrollY})`, true)
      }
    })
  }
  if (snap.activeTabId) tabService.activate(snap.activeTabId)
}
```

## 가벼움 (대량 복원)

탭 100개 동시 복원 시 모두 즉시 로드하면 메모리 폭발:
- 활성 탭 + 핀 + 마지막 5개만 즉시 로드
- 나머지는 `discarded: true` 로 메타만 — 클릭 시 lazy load
- "복원 중..." 진행률 표시

## 시크릿 세션

시크릿 창은 절대 저장 안 함. `partition.startsWith('incognito-')` 인 탭/창은 스냅샷 제외.

## 절대 피할 것

- 매 이벤트마다 디스크 쓰기 — 디바운스 + 30초 강제
- 비정상 종료 후 복원을 사용자 묻지 않고 자동 — 옵션 (last-session 모드 외에는 묻기)
- 시크릿 탭이 복원에 — 분기 단위 테스트
- 비밀번호 폼 데이터 복원 — 절대 저장 안 함
- 100탭 모두 즉시 로드 — discarded 패턴
