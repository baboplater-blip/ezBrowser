# 프로젝트 복원 브리핑
- id: browser-build-36466a626d
- 이름: ezBrowser
- 검증자: claude
- 마지막 실행: run-20260915T101940Z-e8b5cf (unclear)

## 최근 진행
- [2026-09-15T09:32:21Z] run-20260915T091853Z-3c8909 종료 status=unclear (verification.md 에 VERDICT 표기 없음 — 판정 근거 부재)
- [2026-09-15T09:33:05Z] [intervention] 검증 보고서의 ### VERDICT 형식 때문에 런처가 unclear로 마감. 실행층 검증 결과는 유지하고 Codex가 마지막 두 줄의 제목 기호만 제거. 과거 run/outbox 상태는 소급 변경하지 않음. 효율 상세 efficiency-20260915.md 기록.
- [2026-09-15T10:03:24Z] run-20260915T100324Z-f1550b 시작 (model=opus, task=사용자 승인: 앞서 제안한 1~6 모두 한 번에 구현. 추가 승인 불필요. 이전 변경은 보존하고 최신 코드에서 시작. 완료 기준: (1) AI conversations/agent-runs 저장 직렬화 및 종료 flu)
- [2026-09-15T10:19:23Z] run-20260915T100324Z-f1550b 종료 status=unclear (판정이 다른 실행(run-20260915T091853Z-3c8909)에 귀속됨 — 이번 실행(run-20260915T100324Z-f1550b)의 근거가 아님)
- [2026-09-15T10:19:39Z] [intervention] 6항목 실행이 작업자 배정/작성 뒤 통합검증 없이 종료되어 unclear. 기존 작업자 상태 및 산출물을 수합해 완료까지 재개, 같은 작업 재배정 금지.
- [2026-09-15T10:19:40Z] run-20260915T101940Z-e8b5cf 시작 (model=opus, task=이전 run run-20260915T100324Z-f1550b가 작업자 배정 후 통합검증/판정 없이 종료했다. 사용자 1~6 구현 승인 범위 그대로 완료하라. 새 작업자 중복배정 금지. 기존 A/B/C 작업자 생존상)
- [2026-09-15T11:01:09Z] run-20260915T101940Z-e8b5cf 종료 status=unclear (판정이 다른 실행(run-20260915T091853Z-3c8909)에 귀속됨 — 이번 실행(run-20260915T101940Z-e8b5cf)의 근거가 아님)
- [2026-09-15T11:01:36Z] [intervention] 두 번째 실행도 최종보고/현재run 판정 없이 종료. 세 번째 실행은 신규 작업자/비동기 배정 없이 팀장이 기존 결과와 남은 검증을 직접 수합하도록 제한.

## 교훈
# ezBrowser — 교훈

<!-- 교훈 목록 (자동 관리, 최신이 아래) -->
- **음성 대조는 "결함을 넣으면 빨개지는가" 를 넘어 "옛 판정은 놓치고 새 판정만 잡는가" 까지 봐야 한다.**
  X13 강화의 경우 제품 결함(탭 미등록) 주입은 옛·새 판정이 **둘 다** 실패해 강화의 가치를 증명하지 못한다.
  판정을 함수로 뽑아(`judgeX13`) 같은 함수에 결함 데이터를 먹이면, 제품으로는 만들 수 없는 조건
  (라이브러리가 세션 불일치 addTab 에 TypeError 를 던져 교차 등록 자체가 불가)까지 검출력을 확인할 수 있다.
  단 이것은 **판정식의 검증**이지 제품 검증이 아니므로, 제품 결함 주입과 **둘 다** 돌리고 그렇게 적을 것.
- **제품을 일부러 망가뜨렸다면 복구는 소스가 아니라 컴파일 산출물에서 확인한다.**
  `git diff` 가 깨끗해도 `app/dist/main/*.js` 와 `app.asar` 가 낡아 있으면 다음 실행은 망가진 앱을 잰다
  (V5 의 "낡은 결과 파일" 과 같은 부류). 산출물 타임스탬프가 소스보다 뒤인지까지 볼 것.

## 문서
- 목표: C:\Users\molma\Desktop\하네스\browser-build\.auto-dev\goal.md
- 설계: C:\Users\molma\Desktop\하네스\browser-build\.auto-dev\design.md
- 진행: C:\Users\molma\Desktop\하네스\browser-build\.auto-dev\progress.md
- 결과: C:\Users\molma\Desktop\하네스\browser-build\.auto-dev\result.md
- 검증: C:\Users\molma\Desktop\하네스\browser-build\.auto-dev\verification.md
- 교훈: C:\Users\molma\Desktop\하네스\browser-build\.auto-dev\lessons.md
필요한 것만 직접 읽어라. 여기 본문을 다시 싣지 않는다.


## 이번 지시 (run-20260915T110136Z-b1e3f7)
마지막 통합 마감을 직접 수행하라. 이번에는 신규 Agent/작업자/Task 배정 금지, 기존 생존 작업 있으면 완료 수합 후 단일 팀장이 직접 처리. 이전 실행이 background 알림만 기다리다 최종 verdict/result 없이 2회 종료했다. 사용자1~6 승인 유지: 저장경합/손상복구,다중workspace와시크릿 확장격리,on/off/remove/재활성/재시작,세션별로드상태UI,취소후부작용차단. 기존 소스 변경과 검사 보존. 취소35/35 결과 확인됨, storage 하네스 완료본 존재, 확장X14~X23 추가 중 테스트 exceptionDetails 위치버그 및 destroyed window workspace broadcast 수정 존재. 최신 결과 JSON과 파일 timestamp로 아직 안 끝난 부분을 식별해 직접 완료. npm run verify 최종1회가 실제 실행 안 됐으면 실행하고 대상하네스 최종결과 확보. 이미 통과한 변경없는검증 반복금지, 실패한것만수정. 최종 소스보다 오래된 exe 결과는 최종검증아님. worker가 종료window회피로 workspace수정을 우회했다면 수정된 빌드에서 실제창닫기후전환 검사. 추가 패키지/전역설정/권한변경/사용자프로필/외부발행/push 금지. apply_patch 편집, 테스트프로젝트내, 소유PID만정리. 선호permissions가 trust때문에 무시된다는 경고가 있어도 전역 trust변경하지 말고 실제 차단되는명령인지 구분. 반환전에 각6항목 완료/미완과 이유, 검증수/현재빌드/잔여프로세스, 변경전후,한계를 result.md에 기록. 현재run의 VERDICT-RUN: 및 VERDICT: pass 또는 fail을 verification.md끝에 plain 두줄로 남기고 파서형식 확인. 더 이상 배정/대기 선언을 final로 내지 말고 실결과를 반환. 문제가 환경적으로 해결불가면 정확한 실패를 fail로 보고하고 안전한 현상 보존.
