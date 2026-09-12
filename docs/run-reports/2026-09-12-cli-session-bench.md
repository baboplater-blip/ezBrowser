# 귀환 보고서 — CLI 세션 유지 + 에이전트 효율 벤치

임무: 에이전트가 스텝마다 `claude -p` 를 새로 띄우던 구조를 **작업당 프로세스 하나(세션 유지)** 로 바꾸고, 그 효과를 스텝·시간·토큰·성공률로 재는 벤치 하네스를 만든다. 사용자 기준: 로컬 모델 없이 Claude·GPT 구독 CLI 만 사용, Codex 컴퓨터 유즈보다 효율이 좋아야 한다.
등급 T2 · 종결 범위 push까지 · 브랜치 `auto-dev/hygiene-sync`.

## 1. 한 일

- **`app/main/features/ai/providers.ts`** — 하단 신규 절 "CLI 세션".
  - `ClaudeStreamSession`: `claude -p --input-format stream-json --output-format stream-json --verbose --disallowedTools …` 한 프로세스. NDJSON 파서(`assistant` 텍스트 누적, `result` 에서 usage·session_id), 턴당 120초 타임아웃, Windows 트리 종료(`taskkill /T`), 세션 tmp 디렉터리(비전 스크린샷 저장·정리).
  - `CodexResumeSession`: 첫 턴 `codex exec --json` 의 `thread.started.thread_id` → 이후 `codex exec resume <id>` (서버측 문맥·캐시 유지, 프로세스는 턴마다).
  - `openCliSession`·`supportsCliSession`·`CliSessionDead`(세션 사망을 모델 오류와 구분).
  - 기존 스텝별 경로(`runCli`)도 보강: claude-code 를 `--output-format json` 으로 바꿔 usage 를 뽑고(`AiStreamHandlers.onUsage`, `chatOnce().usage()`), `--no-session-persistence`, **`--disallowedTools`**(Bash·Edit·Write·WebFetch 등 — CLI 내부 도구 루프 차단), **cwd 를 항상 tmp** 로.
- **`app/main/features/ai/agent.ts`** — `runAgentTask` 가 CLI 제공자·JSON 프로토콜·설정 ON 이면 세션을 열고(`session` 이벤트), `askCliSession` 으로 스텝마다 **새 관찰만** 전송. 세션이 죽으면 `--resume` 1회 → 실패 시 스텝별 `chatOnce`(로컬 history 전체) 폴백. 스텝마다 `usage` 이벤트. finally 에서 세션 close.
- **`app/main/features/ai/agent-runs.ts`** — `usage` 이벤트를 `run.usage`(input/cacheRead/cacheCreate/output/llmCalls)에 합산(실행 이력에서 토큰 확인 가능).
- **`app/main/storage/settings.ts` · `pages/settings/index.html`** — `ai.cliSession`(기본 ON) + 설정 UI 토글 "CLI 세션 유지".
- **`build/bench-agent-efficiency-cdp.mjs`(신규)** — 로컬 결정적 페이지 3작업(T1 클릭 · T2 폼 작성 · T3 링크 탐색 후 코드 읽기)을 실제 구독 CLI 로 세션/스텝별 두 모드 실행, 스텝 수·총 시간·스텝당 LLM 지연·토큰·성공률 표 + JSON. Codex 컴퓨터 유즈 추정 기준치 병기. **게이트 미등록(구독 호출·비결정론) — 수동 실행.** `docs/auto-dev/RECON.md` 하네스 표에 등록.
- 결과: `verify-out/bench-efficiency/bench-2026-09-12T15-04-50-727Z.json`(세션 6회) · `bench-2026-09-12T15-08-01-701Z.json`(공정 기존 6회) · `bench-2026-09-12T14-55-47-418Z.json`(수정 전 기존 1회).

## 2. 내린 결정과 이유

- **`--disallowedTools` 채택, `--tools ""` 기각** — 3턴 프로브 실측: `--tools ""`/`--tools Read` 는 첫 턴 캐시가 1.1만으로 작지만 **둘째 턴에 12만 토큰이 새로 캐시되는** CLI 특성이 있어 부적합. `--disallowedTools Bash,Edit,Write,…` 는 첫 턴 2.8만(기본 4.1만보다 작음)·이후 턴 2.2~3.1초·신규 150 토큰 안팎. 부수 효과로 **페이지 내용→프롬프트→CLI Bash 실행** 경로가 막힌다(보안). Read 는 남겨 비전 스크린샷을 읽는다.
- **CLI cwd 를 항상 tmp 로** — 스텝별 경로가 앱 cwd 를 물려받아, 하네스가 저장소 루트에서 앱을 띄우면 claude 가 그 폴더의 CLAUDE.md 를 자동 로드했다(호출당 캐시 생성 ≈20만 토큰, 첫 측정의 160초/3스텝·캐시 읽기 192만의 정체). 설치본은 CLAUDE.md 가 없어 실사용엔 없던 비용이지만 경로 자체가 잘못이라 고정.
- **응답 직후 다음 턴 선발송 기각** — 프로브로 확인: CLI 가 턴을 순차 처리해 이득 없음. 턴 후 요약(`post_turn_summary`) 대기 1~4초는 CLI 내부라 줄일 수 없음.
- **세션 모드 기본 ON, 스텝별 경로는 폴백으로 보존** — 세션 사망(타임아웃·프로세스 종료)은 `CliSessionDead` 로 구분해 재개→폴백. 어떤 경우에도 작업이 멈추지 않게.
- **Codex 실측 포기(배선만)** — 이 PC 의 codex CLI 0.130.0 이 사용자 config(`gpt-6-astra`, `service_tier=priority`)를 지원하지 않아 실행 불가. 사용자 환경(전역 CLI·config.toml)은 손대지 않았다.
- **Windows `shell:true` 빈 인자 소실** — `'--tools', ''` 가 cmd 를 거치며 사라져 "argument missing". 빈값이 필요하면 `'""'`. 이번엔 disallowedTools 로 바꿔 우회.
- 기존 도구 이름 목록은 CLI 버전에 따라 다를 수 있음 — 모르는 이름은 무시되므로 넓게 적었다.

## 3. 검증 결과

**효율 벤치(실제 claude-code 구독, T1·T2·T3 × 2회, vision off · humanInput off)** — 성공 **12/12**:

| 모드 | 작업당 시간(중앙) | 스텝당 LLM 지연(중앙) | 6회 총 시간 | 신규 토큰/스텝 | 캐시 읽기 합 |
|---|---|---|---|---|---|
| 스텝별 실행 — **수정 전**(도구 무제한 + 앱 cwd, T1 1회) | 160.1s | 25.9s | — | 229,099 | 1,924,785 |
| 스텝별 실행 — 도구 제한·tmp cwd 적용(공정 기준) | 17.1s | 7.8s | 128s / 16스텝 | 10,262 | 408,646 |
| **세션 유지(신규)** | **12.4s** | **5.2s** | **80s / 14스텝** | **8,140** | 454,825 |

- 세션 유지는 공정 기준 대비 작업 **1.4배**·스텝 지연 **1.5배** 빠르고 신규 토큰 21% 적다. 수정 전 상태 대비로는 시간 13배·신규 토큰 28배 차이지만, 그 대부분은 도구 제한·cwd 수정(스텝별 경로에도 적용됨)의 몫이다 — **두 수정을 나눠 적었다.**
- 세션 모드의 캐시 읽기 합이 기존보다 큰 것은 정상: 이력이 CLI 에 쌓여 매 턴 앞 문맥을 캐시에서 읽는다(캐시 읽기는 신규 토큰보다 훨씬 싸다).
- Codex 컴퓨터 유즈 추정 기준치(스텝당 스크린샷 ≈1,500 + 텍스트 ≈400): 같은 14스텝이면 ≈26,600 토큰. 우리는 8,140/스텝 × 14 = 114k 신규(첫 턴 프롬프트 캐시 생성 포함)이므로 **토큰 비교는 이 추정으로는 우리가 불리하게 보일 수 있다** — 스크린샷 토큰 가정이 실측이 아니고, 컴퓨터 유즈는 좌표 빗나감으로 스텝이 늘어나는 경향을 반영하지 않았다. 정직하게 "추정"으로만 둔다.

**세션 프로토콜 프로브(하네스 밖, `scratchpad`)**: 한 프로세스 2턴 성공, 둘째 턴 캐시 읽기 40,985(첫 턴 생성분 그대로) · 신규 4,748 — 캐시 이어짐 확인.

**게이트(지휘자 직접, 리뷰 반영 후 재실행)**: `npm run verify` **8/8**(typecheck·build·package·smoke 16·korean-regex·editor-text·agent-gate·ai-providers, 42s) → 리뷰 반영 후 `--skip-build` 5/5(smoke 16) · `verify-agent-loop` **17/17** · `verify-ai-errors` **8/8**. 리뷰 반영 후 세션 벤치 재실행 T1·T2 **2/2 성공**(스텝당 4.5~4.8초 · 폴백 0 — 세션 경로가 실제로 동작).
- 세션 프로토콜은 fake-llm 경로(ollama)를 타지 않으므로 agent-loop·ai-errors 는 "루프 변경 무회귀" 검사이고, 세션 자체는 실제 claude-code 벤치가 검증했다.

**적대적 리뷰(code-reviewer, sonnet, 35.9만 토큰)**: High 3 · Medium 4 · Low 3. 지휘자 판정·반영:
- 수용: H1 세션 열기를 try 안으로(emit 예외 시 프로세스·tmp 누수) · H2 stdin `error` 리스너 3+1곳(EPIPE 메인 크래시) · M1 `is_error` 는 텍스트 있어도 오류 전파 · M2 재개 세션 첫 턴에도 system · M3 비전 OFF 면 Read 도 금지(프로브로 12만 토큰 이상 없음 확인) · M4 assistant 블록 구분자 · Low: taskkill 오류 리스너·2시간 지난 tmp 폴더 청소 · 그 외: `resolveReq` 를 필요할 때만.
- 부분 수용: H3 — JSON 파싱 견고화(첫 `{`~마지막 `}`)는 반영. "챗 스트리밍 소실" 은 `-p` 텍스트 모드도 원래 완료 후 한 번에 출력하므로 회귀가 아니라고 판단, json 모드 유지(챗도 usage 를 얻는다).
- 미수용: Codex 빈 outFile 을 세션 사망으로 분류 — 재개→폴백으로 자연 회복되므로 이번 범위 밖.

**지휘자 토큰**(`~/.claude/auto-dev/token-log/cd146004….json`): 지휘자 출력 90,435 · 캐시 생성 439k · 캐시 읽기 21.2M / 군단(리뷰어) 출력 358,869(에이전트 보고 기준). 견적 M(~200k) 대비 지휘자 직접 구현·측정 반복(프로브 5회·벤치 4회)이 컨텍스트를 키웠다.

## 4. 못 한 것과 이유

- **Codex 세션 실측** — CLI 버전 제약(위). 배선(`CodexResumeSession`)은 완성. **승인 대기**: 사용자가 `npm i -g @openai/codex@latest` 로 올리거나 config.toml 의 모델·service_tier 를 이 버전이 아는 값으로 바꾸면 벤치 `--provider codex` 로 즉시 실측 가능.
- **턴 후 요약 대기(1~4초/스텝)** — CLI 내부 동작이라 우리 쪽에서 못 줄인다.
- **네이티브 tool-use 경로(`useTools`)는 세션 미적용** — CLI 제공자는 `supportsNativeTools=false` 라 해당 없음(변경 불필요).

## 5. 다음 업그레이드 제안 3개

1. **LLM 호출 횟수 줄이기(계획 2번)** — 페이지가 안정적이면 한 호출에 동작 여러 개를 계획·실행하고 관찰이 바뀔 때만 다시 묻기, 첫 스텝 이후 관찰은 바뀐 요소만 전송. 지금 세션 모드에서 스텝당 5.2초 중 CLI 고정비(초기화·요약)가 절반이라, 호출 수 자체를 줄이는 것이 다음 큰 레버.
2. **인스타·유튜브·틱톡 레시피 + 실사이트 파일럿(계획 4번)** — 네이버처럼 게시 흐름을 몇 스텝으로 압축. 벤치 하네스에 `--provider claude-code --tasks` 로 사이트 레시피 작업을 추가하면 같은 표로 비교된다.
3. **벤치를 주기 실행하고 추세 기록** — perf-history 처럼 `bench-efficiency` 이력을 쌓아 스텝당 지연·토큰의 중앙값 이동을 감시(CLI 업데이트로 조용히 느려지는 것을 잡는다). 구독 호출이라 게이트 밖·수동 유지.
