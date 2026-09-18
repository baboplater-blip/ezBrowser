# 프로젝트 복원 브리핑
- id: browser-build-36466a626d
- 이름: ezBrowser
- 검증자: claude
- 마지막 실행: run-20260915T100324Z-f1550b (unclear)

## 최근 진행
- [2026-09-15T09:18:52Z] [intervention] 최종 요약에 단계 상한120 미검증 및 SW 어느 하나 통과라는 약한 판정, run 귀속 VERDICT 누락이 남아 해당 부분만 재개. 기존 통합 검증은 반복하지 않는다.
- [2026-09-15T09:18:53Z] run-20260915T091853Z-3c8909 시작 (model=opus, task=이번 승인 범위 마감 보완만: 요약 결과 ai-persist7/7 extension12/12 quick8/8 ext-matrix PASS를 수용하며 통합검증 재실행 금지. 1) 저장 한도 범위의 남은 단계120 상한)
- [2026-09-15T09:18:53Z~] run-20260915T091853Z-3c8909 마감 보완 완료: PS8(단계 상한 120 경계값) 신설 · X13 판정 강화(정확한 탭 id·URL + 세션 격리) · 음성 대조 2종(제품 결함 주입, 판정식 결함 주입 4건) · ai-persist 8/8 · extension-behavior 12/12 GAP 0 · VERDICT pass
- [2026-09-15T09:32:21Z] run-20260915T091853Z-3c8909 종료 status=unclear (verification.md 에 VERDICT 표기 없음 — 판정 근거 부재)
- [2026-09-15T09:33:05Z] [intervention] 검증 보고서의 ### VERDICT 형식 때문에 런처가 unclear로 마감. 실행층 검증 결과는 유지하고 Codex가 마지막 두 줄의 제목 기호만 제거. 과거 run/outbox 상태는 소급 변경하지 않음. 효율 상세 efficiency-20260915.md 기록.
- [2026-09-15T10:03:24Z] run-20260915T100324Z-f1550b 시작 (model=opus, task=사용자 승인: 앞서 제안한 1~6 모두 한 번에 구현. 추가 승인 불필요. 이전 변경은 보존하고 최신 코드에서 시작. 완료 기준: (1) AI conversations/agent-runs 저장 직렬화 및 종료 flu)
- [2026-09-15T10:19:23Z] run-20260915T100324Z-f1550b 종료 status=unclear (판정이 다른 실행(run-20260915T091853Z-3c8909)에 귀속됨 — 이번 실행(run-20260915T100324Z-f1550b)의 근거가 아님)
- [2026-09-15T10:19:39Z] [intervention] 6항목 실행이 작업자 배정/작성 뒤 통합검증 없이 종료되어 unclear. 기존 작업자 상태 및 산출물을 수합해 완료까지 재개, 같은 작업 재배정 금지.

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


## 이번 지시 (run-20260915T101940Z-e8b5cf)
이전 run run-20260915T100324Z-f1550b가 작업자 배정 후 통합검증/판정 없이 종료했다. 사용자 1~6 구현 승인 범위 그대로 완료하라. 새 작업자 중복배정 금지. 기존 A/B/C 작업자 생존상태와 반환물 확인해 수합하고, 작업중이면 기다린 뒤 진행. 이전에 메인 타입체크 통과, 저장 PS9~PS12 작성 및 승인/취소 경합 코드 작성중이었다. 지금부터 팀장이 통합과 검증을 끝내고 최종 보고할 때까지 final로 조기종료하지 말것. 빌드/패키징/앱실행은 공유산출물 독점, npm run verify 최종1회+관련 하네스 통합 수행(이미 실행했다면 중복금지, 실패부분만 재검증). scope1 저장 경합,2 손상복구/원본고유백업,3 여러workspace+시크릿 탭격리,4 확장on/off/remove/재활성/재시작,5 세션별 실제 로드상태 UI,6 승인대기/응답/도구실행 취소와 다음작업 오염방지. 각항목 실제 증거와 제한을 보고. 사용자 변경 보존, apply_patch, 소유PID 및 프로젝트내 격리프로필, 외부발행/결제/push/전역설정 변경 금지. 전체6항목 미완이면 pass 금지. 완료 후 verification.md 끝에 새 현재run_id의 VERDICT-RUN: 과 VERDICT: pass/fail 두줄을 제목/불릿 없이 쓰고 로컬 파서로 인식되는지 확인. result.md 및 효율 개선기록 작성. summary에는 작업자배정 계획 아닌 실제6항목 완료결과와 검사수만 담아라.
