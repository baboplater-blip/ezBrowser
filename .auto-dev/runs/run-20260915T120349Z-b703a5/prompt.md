# 프로젝트 복원 브리핑
- id: browser-build-36466a626d
- 이름: ezBrowser
- 검증자: claude
- 마지막 실행: run-20260915T112617Z-0b2f2e (failed)

## 최근 진행
- [2026-09-15T10:19:40Z] run-20260915T101940Z-e8b5cf 시작 (model=opus, task=이전 run run-20260915T100324Z-f1550b가 작업자 배정 후 통합검증/판정 없이 종료했다. 사용자 1~6 구현 승인 범위 그대로 완료하라. 새 작업자 중복배정 금지. 기존 A/B/C 작업자 생존상)
- [2026-09-15T11:01:09Z] run-20260915T101940Z-e8b5cf 종료 status=unclear (판정이 다른 실행(run-20260915T091853Z-3c8909)에 귀속됨 — 이번 실행(run-20260915T101940Z-e8b5cf)의 근거가 아님)
- [2026-09-15T11:01:36Z] [intervention] 두 번째 실행도 최종보고/현재run 판정 없이 종료. 세 번째 실행은 신규 작업자/비동기 배정 없이 팀장이 기존 결과와 남은 검증을 직접 수합하도록 제한.
- [2026-09-15T11:01:36Z] run-20260915T110136Z-b1e3f7 시작 (model=opus, task=마지막 통합 마감을 직접 수행하라. 이번에는 신규 Agent/작업자/Task 배정 금지, 기존 생존 작업 있으면 완료 수합 후 단일 팀장이 직접 처리. 이전 실행이 background 알림만 기다리다 최종 verdi)- [2026-09-15T11:01:36Z~] run-20260915T110136Z-b1e3f7 통합 마감 완료(팀장 직접, 신규 작업자 0): 앞 실행의 X15·X18 FAIL 은 **빌드보다 이른 결과 파일**이었음을 타임스탬프로 확인 → 최신 빌드에서 X18 PASS. 고친 줄에 검사가 없던 `ipc/workspace.ts` 가드에 **X24 신설**(음성 대조가 1·2차 설계를 기각 → 3차 "외피만 파괴" 방아쇠로 실제 검출 확인). 항목4 누락이던 "이미 주입된 DOM 소급복원 한계" 를 사용자 화면·검사 주석에 명시. 최종 빌드 기준 verify 8/8 · extension-behavior 23P/0F/1GAP · ai-persist 13/13 · agent-loop 35/35 = **79 PASS · 0 FAIL · 1 GAP**. VERDICT pass(X15 는 미해결 GAP 으로 3항은 부분 완료로 표기).
- [2026-09-15T11:25:56Z] run-20260915T110136Z-b1e3f7 종료 status=success (이번 실행(run-20260915T110136Z-b1e3f7)에 귀속된 판정: pass)
- [2026-09-15T11:26:17Z] [intervention] 최종 요약에서 3번 X15 교차세션 scripting 누출 미해결인데 pass 판정. 사용자1~6 모두완료 기준 미달이므로 pass 수용하지 않고 3번만 추가 재개. 시크릿 영향 확인과 네이티브 경계 해결 가능성 조사.
- [2026-09-15T11:26:17Z] run-20260915T112617Z-0b2f2e 시작 (model=opus, task=3번 미완 X15만 해결. 이전 pass는 전체6항목 완료 아님. 다른5항목 결과 재사용. 신규 작업자/배경배정 금지, 팀장 직접. 실제 교차workspace native chrome.scripting 실행 누출의 )- [2026-09-15T11:26:17Z~] run-20260915T112617Z-0b2f2e 항목 3(X15) 재개 — 팀장 직접, 신규 작업자 0. **X15 미해결(VERDICT fail).** 원인을 Electron v35.7.5 소스로 확정(`CanAccessTarget` 이 `browser_context` 인자를 받아 놓고 안 씀 → 탭을 프로세스 전역 `WebContents::FromID` 로 조회). 해결책은 **포크가 아니라 Electron ≥39 판올림**(upstream PR #50906; 릴리스 브랜치 실측 35·36·37·38 미적용 / 39·40 적용) — 엔진 교체라 권한 밖. 시크릿 **탭**은 실측 결과 변조 불가(신규 X25). 그러나 조사 중 **실제 시크릿 유출 1건 발견·수정**: 확장이 `file://` 로 뜨는 외피에 주입해 시크릿 창의 주소창 값을 읽어 갔다 → `loadExtension(allowFileAccess:false)`(Electron·크롬 기본값)로 차단, 음성 대조로 확인(신규 X26 FAIL→PASS). 검증: verify 8/8 · extension-behavior **25 PASS/0 FAIL/1 GAP** · ext-matrix 9/10(회귀 없음).
- [2026-09-15T11:57:00Z] run-20260915T112617Z-0b2f2e 종료 status=failed (이번 실행(run-20260915T112617Z-0b2f2e)에 귀속된 판정: fail)

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
- **"우리 코드 밖이라 못 고친다" 로 멈추지 말고 엔진 소스와 릴리스 브랜치까지 가라.**
  X15 는 두 라운드 동안 "라이브러리에 구현이 없다" 에서 멈춰 GAP 이었다. Electron 소스를 직접 읽자
  `CanAccessTarget` 이 `browser_context` 인자를 **받아 놓고 안 쓰는** 것이 드러났고(원인 확정),
  커밋 이력을 훑자 upstream 이 이미 고쳐(PR #50906) **Electron 39 부터 들어 있음**이 나왔다.
  결론이 "포크 필요"(사실상 영구 GAP)에서 **"판올림 여부 결정"**(실행 가능한 선택지)으로 바뀐다.
  `gh api repos/<o>/<r>/commits?path=<파일>` + 릴리스 브랜치별 파일 대조 두 번이면 된다.
- **"막혔다" 를 확인할 때는 대상 목록을 먼저 뜨라 — 예상 밖의 대상이 거기 있다.**
  X25 는 시크릿 탭만 물었는데, id→페이지 매핑을 찍자 **외피(브라우저 UI) 자체가 `file://` 로 로드되는
  또 하나의 webContents** 로 잡혀 있었고, 확장이 거기서 시크릿 창의 주소창 값을 실제로 읽어 갔다(X26).
  "무엇이 안 뚫렸나" 만 보면 놓치고, "무엇에 닿을 수 있나" 를 열거하면 보인다.

## 문서
- 목표: C:\Users\molma\Desktop\하네스\browser-build\.auto-dev\goal.md
- 설계: C:\Users\molma\Desktop\하네스\browser-build\.auto-dev\design.md
- 진행: C:\Users\molma\Desktop\하네스\browser-build\.auto-dev\progress.md
- 결과: C:\Users\molma\Desktop\하네스\browser-build\.auto-dev\result.md
- 검증: C:\Users\molma\Desktop\하네스\browser-build\.auto-dev\verification.md
- 교훈: C:\Users\molma\Desktop\하네스\browser-build\.auto-dev\lessons.md
필요한 것만 직접 읽어라. 여기 본문을 다시 싣지 않는다.


## 이번 지시 (run-20260915T120349Z-b703a5)
사용자가 Electron 수정버전 판올림과 호환성검증을 명시 승인했다. 이전 대규모의존성교체금지 중 Electron 엔진업그레이드 금지는 이번에 해제; 무관한 의존성 교체는 금지. 단일팀장이 직접 완료, 신규 작업자/비동기 Agent 배정 금지(과거2회 미완종료 원인). 공식 Electron 릴리스/태그에서 PR50906 BrowserContext tab-ID fix 포함된 정확한 안정 patch 버전과 지원상태 확인하여 호환성영향이 합리적인 버전을 선택/기록. 단지 >=39이면 모두 수정됐다고 가정금지. package.json/lock 및 필요한 호환수정 최소범위. 기존 사용자변경/앞선 모든 미커밋수정 보존. 관련 .agents 스킬 electron-bootstrap,chrome-extensions-bridge 및 필요보안지침 적용하되 예제 allowFileAccess:true는 현재 보안조치 false를 뒤집지 말것. 완료기준: 실제패키지 process.versions electron/chrome/node 확인, X15 교차workspace scripting 차단을 GAP가 아닌 필수PASS/FAIL로 승격, 같은세션 정상 scripting 양성대조, X25 시크릿/X26 외피 접근차단 보존. tabs/query/get 및 워크스페이스/시크릿/닫기복원/확장onoffremove/재시작/storage/DNR/광고차단/IPC/preload 회귀. npm run verify 최종1회+영향 하네스 extension-behavior,ext-matrix,session-restore,ai-persist,agent-loop,agent-safety,memory-page 및 성능은 범위에비례하여 측정. 사용자는 호환성검증 승인했으나 verify:full 화면점유50탭은 여전히 별도이므로 full 명령 대신 필요한 타겟 묶음만. 실패부분만 수정/재검증, 최종제품수정 뒤빌드 새로하고 결과시점확인. 외부사이트실계정/게시/유료API 금지 local fakefixture isolated profile, 테스트소유PID만정리. npm install 의존성업데이트는 승인범위; 버전다운로드후 실제버전확인, 예산완화로통과금지. 전역설정/trust/권한변경,push/release/deploy,프로젝트밖삭제금지. apply_patch 파일편집,무관콘텐츠/이전전체로그읽기금지. 보고서 .auto-dev/result.md 및 verification.md에 이전35.7.5→선정정확버전,공식fix근거,변경전후,검증/호환한계/재작업/효율기록. 추가로 프로젝트내 업그레이드 보고서 별도경로작성(기존보고서전체반복금지). 모델/토큰은 상위런처집계. 최종현재run의 VERDICT-RUN: 및 VERDICT: pass/fail plain두줄을 반드시쓰고 로컬형식확인. 3번 해결 전 pass금지. 배정/대기선언 final금지, 실제구현과검증이끝난요약2000자 반환.
