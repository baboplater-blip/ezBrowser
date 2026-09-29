# 프로젝트 복원 브리핑
- id: browser-build-36466a626d
- 이름: ezBrowser
- 검증자: claude
- 마지막 실행: run-20260915T110136Z-b1e3f7 (success)

## 최근 진행
- [2026-09-15T10:19:23Z] run-20260915T100324Z-f1550b 종료 status=unclear (판정이 다른 실행(run-20260915T091853Z-3c8909)에 귀속됨 — 이번 실행(run-20260915T100324Z-f1550b)의 근거가 아님)
- [2026-09-15T10:19:39Z] [intervention] 6항목 실행이 작업자 배정/작성 뒤 통합검증 없이 종료되어 unclear. 기존 작업자 상태 및 산출물을 수합해 완료까지 재개, 같은 작업 재배정 금지.
- [2026-09-15T10:19:40Z] run-20260915T101940Z-e8b5cf 시작 (model=opus, task=이전 run run-20260915T100324Z-f1550b가 작업자 배정 후 통합검증/판정 없이 종료했다. 사용자 1~6 구현 승인 범위 그대로 완료하라. 새 작업자 중복배정 금지. 기존 A/B/C 작업자 생존상)
- [2026-09-15T11:01:09Z] run-20260915T101940Z-e8b5cf 종료 status=unclear (판정이 다른 실행(run-20260915T091853Z-3c8909)에 귀속됨 — 이번 실행(run-20260915T101940Z-e8b5cf)의 근거가 아님)
- [2026-09-15T11:01:36Z] [intervention] 두 번째 실행도 최종보고/현재run 판정 없이 종료. 세 번째 실행은 신규 작업자/비동기 배정 없이 팀장이 기존 결과와 남은 검증을 직접 수합하도록 제한.
- [2026-09-15T11:01:36Z] run-20260915T110136Z-b1e3f7 시작 (model=opus, task=마지막 통합 마감을 직접 수행하라. 이번에는 신규 Agent/작업자/Task 배정 금지, 기존 생존 작업 있으면 완료 수합 후 단일 팀장이 직접 처리. 이전 실행이 background 알림만 기다리다 최종 verdi)- [2026-09-15T11:01:36Z~] run-20260915T110136Z-b1e3f7 통합 마감 완료(팀장 직접, 신규 작업자 0): 앞 실행의 X15·X18 FAIL 은 **빌드보다 이른 결과 파일**이었음을 타임스탬프로 확인 → 최신 빌드에서 X18 PASS. 고친 줄에 검사가 없던 `ipc/workspace.ts` 가드에 **X24 신설**(음성 대조가 1·2차 설계를 기각 → 3차 "외피만 파괴" 방아쇠로 실제 검출 확인). 항목4 누락이던 "이미 주입된 DOM 소급복원 한계" 를 사용자 화면·검사 주석에 명시. 최종 빌드 기준 verify 8/8 · extension-behavior 23P/0F/1GAP · ai-persist 13/13 · agent-loop 35/35 = **79 PASS · 0 FAIL · 1 GAP**. VERDICT pass(X15 는 미해결 GAP 으로 3항은 부분 완료로 표기).
- [2026-09-15T11:25:56Z] run-20260915T110136Z-b1e3f7 종료 status=success (이번 실행(run-20260915T110136Z-b1e3f7)에 귀속된 판정: pass)
- [2026-09-15T11:26:17Z] [intervention] 최종 요약에서 3번 X15 교차세션 scripting 누출 미해결인데 pass 판정. 사용자1~6 모두완료 기준 미달이므로 pass 수용하지 않고 3번만 추가 재개. 시크릿 영향 확인과 네이티브 경계 해결 가능성 조사.

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


## 이번 지시 (run-20260915T112617Z-0b2f2e)
3번 미완 X15만 해결. 이전 pass는 전체6항목 완료 아님. 다른5항목 결과 재사용. 신규 작업자/배경배정 금지, 팀장 직접. 실제 교차workspace native chrome.scripting 실행 누출의 정확한API/권한/세션경계 확인, 시크릿 대상 실제변조 가능여부를 격리프로필 local fixture에서 확인. 현재 npm Electron 소스/선언/바인딩 및 앱 경로로 구현 가능한 경계검증 해결을 조사하고 가능한 최소수정 수행. 출발 확장세션과 목적webContents.session 동일성의 신뢰할수있는 메인측검증이 완료기준, 정상 같은세션 scripting 양성대조 유지. 쉽게우회되는 renderer wrapper만으로 보안해결 주장금지. 기능 전면삭제/확장 모두끄기/테스트GAP전환/조건완화로 완료처리금지. 엔진교체나 직접 Chromium/Electron 포크만가능하면 현행 앱 범위 내 완전해결 불가를 근거와 함께 fail로 보고하고 어떤 기술결정이 필요한지 설명. 프로젝트 외부설정/권한/파일삭제/사용자프로필/외부발행/push/의존성 대규모교체 금지. 해결되면 영향하네스와 필요한 빌드검증 수행, 전체검증 반복은 변경범위에 비례. 재현/수정/검증 및 한계 result.md에 업데이트. VERDICT-RUN 현재run, VERDICT pass는 실제3번까지 완료시만, 아니면 fail. 최종 요약 3번 해결여부/시크릿영향/근거/파일/검사수로 마감.
