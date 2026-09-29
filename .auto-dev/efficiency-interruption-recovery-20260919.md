# 효율 기록 — 중단 복구 라운드 (run-20260919T133659Z-c6f72a)

> `orchestrator.py efficiency` 가 이 설치본에 없어 CLI 집계를 쓸 수 없었다.
> **실제로 계측된 값만** 적는다. 재지 못한 것은 `null` 이며 0 이 아니다.

## 편성

| 역할 | 모델 | 소유 파일 | 실측 토큰 | 도구 호출 | 소요 |
|---|---|---|---|---|---|
| 팀장(나) | `claude-opus-5` (requested=opus · resolved/verified=시스템 표기 `claude-opus-5`) | `app/main/**`, `json-store.ts`, `agent-gate.ts`, `verify-all.mjs`, `verify-agent-gate.mjs`, 문서 | `null`(부모 사용량 미계측) | — | — |
| UI 작업자 | `sonnet`(requested; resolved 미확인 → `verified=false`) | `app/preload/chrome.ts`, `app/renderer/components/AiTab.tsx` | 290,809 | 21 | 2분 10초 |
| 인게이지 내구성 하네스 | `sonnet`(동상) | `build/verify-engage-durability.mjs` | 331,918 | 20 | 5분 52초 |
| 중단 복구 하네스 | `sonnet`(동상) | `build/verify-interruption-recovery-cdp.mjs` | 622,244 | 115 | 40분 1초 |

작업자 합계 **1,244,971 토큰 / 156 도구 호출**. 팀장 몫은 계측되지 않았다.

## 편성에서 실제로 아낀 것 / 쓴 것

- **파일 소유권을 완전히 분리**해 세 작업자가 충돌 없이 동시에 돌았다. 병합 충돌 0건.
- **핵심 구현은 위임하지 않았다.** `task-runtime.ts`·`blog-engage.ts`·`agent.ts` 는 서로 얽혀 있어
  브리핑을 쓰는 값이 직접 고치는 것보다 비쌌다. D5·D6·D7 은 각각 몇 줄짜리라 전부 직접 했다.
- **가장 비싼 작업자(중단 복구 하네스, 62만 토큰·40분)가 값을 했다.** 그 하네스가 없었으면
  D6(`공유` 버튼 미인식)·D7(연결 실패 오분류)을 못 찾았다 — 둘 다 그 하네스의 **detail 문구**에서 나왔다.
- **낭비**: 수정 전 스냅샷(`dist-before-ir`)에 `shared/` 를 빠뜨려 작업자의 재현 시나리오 2건이
  90초 타임아웃으로 두 번 죽었다. 내 실수였고, 스냅샷을 뜰 때 **부팅을 한 번 확인**했으면 없었을 비용이다.

## 재시도·개입

| 무엇 | 왜 | 어떻게 |
|---|---|---|
| 하네스 작업자에게 3회 추가 지시 | ①UI 버튼 경로 검증 누락 ②IR3 실패 원인 분기 ③`app/dist` 재빌드 알림 | 초록이 될 때까지 시나리오를 만지지 말고 원인을 먼저 가르라고 못박았다 |
| `isPublishAction` 수정 범위 축소 | 첫 시도가 `업로드`/`Upload` 까지 발행으로 잡아 **초안 모드의 파일 첨부를 막을** 참이었다 | 내 테스트가 내 기대를 틀렸다고 알려 줬다. 목록을 좁히고 그 이유를 주석·검사에 남겼다 |
| `dist-before-ir` 스냅샷 보완 | `shared/` 누락으로 재현 불가 | 채운 뒤 앱 없이도 D3 재현에 성공 |
