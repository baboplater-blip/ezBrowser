# 귀환 보고서 — 대화상자 우선 관찰 · 패스키 OS 모달 · 실행 중 도크 접기

임무: 인스타 실사이트 파일럿(같은 날)이 드러낸 세 가지 마찰을 묶어 해소한다. 등급 T2 · 종결 범위 push까지 · 브랜치 `auto-dev/hygiene-sync`.

## 1. 한 일

**① 대화상자 우선 관찰** (`page-actions.ts` OBSERVE_SCRIPT)
- 파일럿 로그 재해석: 매 관찰이 **요소 80개 상한**에 걸려 있었고 인스타 피드 링크가 DOM 앞쪽을 채워 게시 대화상자의 "다음"·"공유하기" 가 잘렸다(모델은 "창 밖" 이라 해석하고 run_js 로 우회). 열린 대화상자(`role=dialog`·`aria-modal`·`dialog[open]` 중 마지막 visible)를 **먼저** 수집하고, 뷰포트 밖 요소는 이름에 `(화면 밖 — 클릭하면 자동 스크롤)` 표기.
- 검증: `verify-agent-safety` **A15**(피드 200개 + 뷰포트 아래로 밀린 대화상자 버튼 → 목록 index 0, 표기 있음, ref 클릭으로 실제 눌림) · SNS 모의 인스타에 피드 링크 120개 추가 → **결함 재현 후**(role=dialog 없는 모의에서 "다음" 잘림 4건 실패) 모의를 실제처럼 `role=dialog` 로 맞추자 7/7.

**② 패스키(WebAuthn) OS 모달** (`features/passkey/index.ts` 신규, `privacy.passkeyAutoPrompt`, 의사권한 `passkey`)
- 실측(프로브): 인스타 로그인 페이지는 로드 직후 `navigator.credentials.get({mediation:'conditional', publicKey})` 를 부른다. 크롬은 이를 자동완성 목록에 조용히 넣지만 Electron 은 그 UI 가 없어 Windows "암호 키로 로그인" 창이 뜬다. `--disable-features=WebAuthenticationConditionalUI` 로는 변화 없음(실측).
- 설계: **조건부 요청만 기본 거부**(`NotAllowedError`, 어차피 우리가 채워 줄 수 없는 요청), 사용자가 "패스키로 로그인" 버튼을 눌러 생기는 명시 요청은 그대로. 사이트별 오버라이드(자물쇠 패널·설정 "사이트 권한" 의 "패스키 로그인 창": 기본/허용/차단) + 전역 설정(개인정보 "패스키 자동 요청": 차단(기본)/허용). 주입은 `dom-ready` main world(정책 customJs 와 같은 경로, CSP 무관), 원본 보존·재주입 1회.
- 검증: `verify-passkey-cdp.mjs` **P1~P4**(게이트 full 등록) — 기본: 조건부 즉시 거부(0ms)·명시 통과 / 사이트 차단: 전부 거부 / 사이트 허용·전역 허용: 통과. 새 빌드로 인스타 로그인 페이지 프로브 → **조건부 호출이 프로브 기록에서 사라짐**(우리 계층이 먼저 거부 — 프로브 래퍼보다 뒤에 주입되므로 간접 증거).

**③ 실행 중 도크 자동 접기** (`App.tsx`, `ai.agentCollapsePanels` 기본 ON, 설정 UI)
- 에이전트 `start` 에 다운로드·동영상 도크·왼쪽 사이드패널 상태를 스냅샷하고 접음, `done/error/cancelled` 에 복구. AI 패널(트레이스)은 유지.
- 검증: `verify-agent-loop` **PC1**(도크 열림 → 실행 중 접힘 → 종료 후 복구) → 26/26.

## 2. 내린 결정과 이유
- 패스키 기본값 'block(조건부만)': 조건부 요청은 Electron 에서 사용자에게 보이는 방식이 OS 모달뿐이라 "크롬처럼 조용히" 를 재현할 길이 없다. 명시 요청은 남겨 패스키 로그인 자체는 가능하게.
- 대화상자 판별은 접근성 속성 기반: 인스타·유튜브 스튜디오가 `role=dialog` 를 쓴다. role 없는 커스텀 모달은 여전히 상한에 밀릴 수 있다(알려진 한계).
- A15 에서 클릭이 **합성 폴백**으로 떨어졌다: `overflow:hidden` 대화상자 안의 뷰포트 밖 버튼은 scrollIntoView 후에도 실제 마우스 좌표가 안 잡혀 폴백. 목적(버튼이 눌린다)은 달성했으나 인스타처럼 봇 탐지가 있는 사이트에서는 실제 클릭이 낫다 — 다음 후보.

## 3. 검증 결과

**적대적 리뷰(code-reviewer, sonnet, 35.5만 토큰)**: High 2 · Medium 3 · Low 3. 전부 타당해 반영:
- **H1 지문**: `navigator.credentials` 인스턴스 치환(own property·instanceof 붕괴·함수 소스 노출)을 **`CredentialsContainer.prototype.get/create` 패치**로 교체 — hasOwnProperty·instanceof 유지, 래퍼의 name/length/toString 을 원본처럼(P0 검사 신설). 잔여: `Function.prototype.toString.call(get)` 은 위장 못 함(문서화).
- **H2 즉시 거부 = 신호**: 조건부 요청을 `NotAllowedError` 로 즉시 거부하던 것을 **영구 대기**로 — 어떤 브라우저든 "맞는 자격증명 없음" 상태는 pending 이라 관찰상 구분 불가. 사이트 '차단' 만 명시 거부 유지. 하네스 P1 기대값을 pending 으로, P3·P4 는 "pending 도 거부도 아님(Chromium 원본 처리)" 로 강화.
- **M1 대화상자 선택**: DOM 마지막 매치 → **화면 안 면적이 가장 큰 가시 대화상자**(aria-modal 가산점). body 끝에 포탈된 토스트가 진짜 모달을 밀어내는 경로 차단.
- **M2·M3 도크 복구**: 스냅샷에 reqId 를 기록해 다른 실행의 종료로는 복구하지 않고, 실행 중 사용자가 직접 연 패널은 되돌리지 않는다(접힌 채인 것만 복구).
- 미반영: L1(비디오 도크 복구와 후보-없음 자동닫힘의 한 틱 경합 — 기존 정책과 일치) · L2(화면 밖 표기 토큰) · 주입 타이밍(dom-ready 가 헤드 동기 스크립트의 조건부 호출을 놓칠 수 있음 — 인스타는 실측상 잡혔으나 일반 보장은 없음, 문서화).

**게이트(지휘자 직접, 리뷰 반영 후 최종 코드)**: `verify-passkey` **5/5**(P0 지문: own property 없음·instanceof 유지·`get` 이 native 처럼 / P1 조건부 pending·명시 통과 / P2 차단 전부 거부 / P3·P4 허용 통과) · `verify-agent-safety` **15/15**(A15) · `verify-sns-publish` **7/7**(피드 120개 + role=dialog) · `verify-agent-loop` **26/26**(PC1) · `npm run verify --skip-build` 5/5(스모크 16) · `verify-ai-errors` 8/8 · typecheck 3/3.

## 4. 못 한 것과 이유
- `role` 없는 커스텀 모달의 우선 수집(휴리스틱 필요).
- 뷰포트 밖 대화상자 요소의 실제 마우스 클릭(현재 합성 폴백).
- 인스타 실사이트에서 패스키 모달이 실제로 안 뜨는지는 **사용자 육안**으로만 확인 가능(OS 창은 CDP 로 안 보임) — 다음 로그인 때 확인 부탁.

## 5. 다음 업그레이드 제안 3개
1. 인스타 파일럿 재실행(draft) — 관찰 우선순위·도크 접기로 스텝 12→8 안팎, 완료 신호 발동 확인.
2. `overflow:hidden` 대화상자 내부 스크롤 처리(`scrollIntoView` 가 컨테이너 스크롤을 못 옮길 때 wheel 이벤트/`scrollTop` 보정) → 실제 클릭 유지.
3. 유튜브·틱톡 실사이트 파일럿(승인 필요).
