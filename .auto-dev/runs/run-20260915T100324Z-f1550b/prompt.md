# 프로젝트 복원 브리핑
- id: browser-build-36466a626d
- 이름: ezBrowser
- 검증자: claude
- 마지막 실행: run-20260915T091853Z-3c8909 (unclear)

## 최근 진행
# ezBrowser — 진행
- [2026-09-15T08:47:32Z] run-20260915T084732Z-0bf6b9 시작 (model=opus, task=사용자가 이전 제안 1,2를 승인했다. 목표: (1) 에이전트 실행기록/대화의 재시작 보존 및 실제 저장 한도 (2) 크롬 확장의 실제 요청 차단과 콘텐츠/스크립트 주입 검증. 최신 HEAD 3987051이며 과거 )
- [2026-09-15T09:18:38Z] run-20260915T084732Z-0bf6b9 종료 status=unclear (verification.md 에 VERDICT 표기 없음 — 판정 근거 부재)
- [2026-09-15T09:18:52Z] [intervention] 최종 요약에 단계 상한120 미검증 및 SW 어느 하나 통과라는 약한 판정, run 귀속 VERDICT 누락이 남아 해당 부분만 재개. 기존 통합 검증은 반복하지 않는다.
- [2026-09-15T09:18:53Z] run-20260915T091853Z-3c8909 시작 (model=opus, task=이번 승인 범위 마감 보완만: 요약 결과 ai-persist7/7 extension12/12 quick8/8 ext-matrix PASS를 수용하며 통합검증 재실행 금지. 1) 저장 한도 범위의 남은 단계120 상한)
- [2026-09-15T09:18:53Z~] run-20260915T091853Z-3c8909 마감 보완 완료: PS8(단계 상한 120 경계값) 신설 · X13 판정 강화(정확한 탭 id·URL + 세션 격리) · 음성 대조 2종(제품 결함 주입, 판정식 결함 주입 4건) · ai-persist 8/8 · extension-behavior 12/12 GAP 0 · VERDICT pass
- [2026-09-15T09:32:21Z] run-20260915T091853Z-3c8909 종료 status=unclear (verification.md 에 VERDICT 표기 없음 — 판정 근거 부재)
- [2026-09-15T09:33:05Z] [intervention] 검증 보고서의 ### VERDICT 형식 때문에 런처가 unclear로 마감. 실행층 검증 결과는 유지하고 Codex가 마지막 두 줄의 제목 기호만 제거. 과거 run/outbox 상태는 소급 변경하지 않음. 효율 상세 efficiency-20260915.md 기록.

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


## 이번 지시 (run-20260915T100324Z-f1550b)
사용자 승인: 앞서 제안한 1~6 모두 한 번에 구현. 추가 승인 불필요. 이전 변경은 보존하고 최신 코드에서 시작. 완료 기준: (1) AI conversations/agent-runs 저장 직렬화 및 종료 flush와 비동기 저장 경합 방지, 저장중 신규 변경 dirty 유실 방지. 연속 갱신/즉시종료/재시작에서 최신 기록 보존. (2) 손상 JSON/잘못된 필드에서 원본 고유 백업 보존, 정상 항목 복구 및 명확한 실패 처리. 기존 정상 파일 무손실, 손상 반복시 백업 덮어쓰기 금지. (3) 최소 두 workspace+시크릿 세션에 각각 탭을 만들어 확장 tabs.query/get 및 스크립트가 자기 세션 대상만 보고 조작하는 실제 양성/음성검사; 단일 탭 기존 X13 넘어서기. (4) 여러 세션 확장 enable/disable/remove 후 요청 차단 규칙과 service worker 및 새 문서 주입의 상태 확인, 재활성화/재시작 포함. 이미 주입된 DOM은 끄면 소급복원 안 될 수 있으므로 동작 한계를 명시. (5) extensions 목록/내부 관리 페이지에 세션별 실제 로드성공/실패 표시. defaultSession만 보고 활성이라고 처리하는 문제 수정, 설정상 enabled와 실제 loaded 구분, 실패 이유 사용자에게 이해되게. (6) AI 응답생성/승인대기/도구실행 중 취소가 후속 클릭/입력/늦은응답 및 다음 실행 오염을 막도록 수정/검증. 이미 실행된 외부동작을 되돌렸다고 주장 금지. fake LLM+로컬 페이지 사용, 실제 계정/키/게시 금지. 소유 묶음 A=저장1,2 app/main/features/ai/conversations.ts agent-runs.ts 관련 하네스; B=확장3,4,5 app/main/extensions/adapter.ts session/tab hooks 관련 IPC/shared/preload/pages 및 하네스; C=취소6 관련 ai 런타임 및 하네스. 독립 작업은 적절한 Claude 작업자에게 묶어 배정하고 공유파일 편집은 직렬화. 관련 스킬 chrome-extensions-bridge 등 필요한 것만 사용. 사용자 콘텐츠와 과거 보고서/전체 로그 광범위 읽기 금지; 관련 소스/설정/테스트 최소범위. apply_patch 편집. .claude/settings.json 및 .bak-deploy 등 기존 사용자 변경 보존. 프로젝트 밖 쓰기/삭제, 사용자 프로필, 이름기반 process kill, 전역설정/권한완화, push/deploy/결제 금지. 7 기록보관함 및 8 확장storage 공유정책은 범위 밖. 테스트 isolated profile, 소유 PID만 종료. 최종 변경 뒤 npm run verify 1회+영향 하네스를 하나의 통합 마감으로 수행, 실패부분만 재검증; verify:full 실행 금지. 원래 실행중인 사용자 창을 닫지 말고 패키징 방해시 안전 대안 확인. 각6항목 변경전후와 검사근거/한계, 재작업 이유를 .auto-dev/result.md와 읽기쉬운 efficiency 보고에 작성. 모델/토큰 최종 원장집계는 상위 런처 담당. 최종 summary는 6항목 완료여부/테스트수/남은제한을 2000자 안에. 이전 VERDICT 형식오류 반복금지: verification.md 맨 끝 두 줄은 Markdown 제목/불릿/코드펜스 없이 정확히 VERDICT-RUN: 현재run_id 와 VERDICT: pass 또는 fail. 마지막에 해당 두줄 형식을 로컬 코드로 확인하고 종료. 전체 범위 미완이면 pass 쓰지 말것.
