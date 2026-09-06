# RECON.md — ezBrowser (browser-build) 정찰 지도

> auto-dev 첫 출정 정찰 (2026-09-06, 지휘자 직접 · 읽기 전용).
> 이후 임무는 이 파일을 읽고 재정찰을 생략하되, 실제와 어긋난 항목을 발견하면 그 자리에서 갱신한다.

## ① 구조·스택·진입점

| 항목 | 실제 |
|------|------|
| 제품 | **ezBrowser** (코드네임 browser-build), 버전 `0.1.0` |
| 셸 | Electron **35.7.5** (Chromium 134) + TypeScript strict |
| 외피 | React 18 + Vite (`app/renderer/`) — 번들 gzip ~65~82KB (예산 500KB) |
| 메인 진입 | `app/main/index.ts` → 빌드 산출 `app/dist/main/index.js` |
| preload | `app/preload/{chrome,content,internal}.ts` → **esbuild 번들**(sandbox 때문에 tsc 산출물 사용 금지) |
| 내부 페이지 | `pages/*/index.html` → `browser://<name>` (session-bootstrap 이 서빙) |
| 저장 | sql.js(WASM SQLite: 북마크·이력) + electron-store(설정·읽기목록·위젯·AI 데이터) |
| 규모 | main 기능 모듈 다수(`app/main/features/*`), AI 레이어(`features/ai/*`) 가 최근 최대 증식 지대 |

## ② 실행·테스트 방법 (실측 확인)

```bash
npm run typecheck   # main/preload/renderer 3개 tsc --noEmit  ← 2026-09-06 실행: 0 에러
npm run build       # gen:tokens → gen:icon → vite → tsc(main) → esbuild(preload)
npm run package:win # electron-builder NSIS (실행 중 앱 있으면 EXE 잠김 → 먼저 Stop-Process)
npm run dev         # vite + electron (cross-env 로 VITE_DEV_SERVER_URL 주입)
```

**검증 하네스는 `build/*.mjs` (의존성 0, Node 내장 WebSocket/fetch + CDP)** — 이 프로젝트의 최대 자산:

| 하네스 | 무엇을 검증 |
|--------|-------------|
| **`verify-all.mjs`** | **통합 러너 — 아래 하네스를 한 줄로 묶는다. `npm run verify`(quick) / `npm run verify:full`. 실패 시 비0 종료** |
| `smoke-cdp.mjs` | 상시 스모크 16종 (탭·omnibox·북마크·설정·팔레트·adblock·워크스페이스 격리·z-order·다운로드·동영상) |
| `verify-agent-safety-cdp.mjs` | AI 에이전트 안전·조작 A1~A14 (DOM 지문·업로드·드롭존·타이핑 인간화) |
| `dl-matrix.mjs` + `dl-matrix-server.mjs` | 다운로드 11시나리오 (HLS/DASH/토큰CDN/이어받기) |
| `ext-matrix.mjs` | 크롬 확장 10종 실 CRX 로드 |
| `perf-measure.mjs` / `perf-breakdown.mjs` / `perf-check.mjs` | 성능 예산 (private WS 기준) |
| `stress-cdp.mjs` / `session-restore-cdp.mjs` | 50탭 스트레스 / 강제 kill 후 복원 |
| `probe-fingerprint-cdp.mjs` / `bench-agent-cdp.mjs` | 자동화 지문 노출 / 에이전트 동작 속도 |
| `probe-download.mjs` | 단일 URL 다운로드 가능성 진단 CLI |

라운드 검증은 개별 하네스를 기억해 돌리지 말고 **`npm run verify`** 로 시작한다(무엇을 돌릴지는 러너 등록부가 정본).

**하네스 5대 함정 (반드시 지킬 것)**
1. 패키징·검증 전 `Stop-Process -Name ezBrowser -Force` (실행 중이면 EXE 잠김 / 사용자 인스턴스 kill 주의 — PID 스코프 권장)
2. 하네스는 **`--user-data-dir` 격리 프로필** 사용 (사용자 실프로필 오염 금지)
3. 종료는 CDP `Browser.close` (강제 kill 하면 `sessions/current.json` 잔존 → 다음 부팅에 복원 모달이 창 생성을 블록)
4. **`taskkill /F` 는 죽음을 보장하지 않는다** — 명령을 받고도 살아남아 **디버그 포트를 계속 쥐는** 인스턴스가 있다. 죽었는지 확인하고 재시도할 것. 좀비가 포트를 쥐면 `/json/list` 가 좀비의 타깃을 돌려주고, 그 렌더러는 영영 응답하지 않아 하네스가 통째로 무너진다(2026-09-06 실측 — INFRA 실패의 주원인)
5. **갓 패키징한 exe 의 첫 실행은 CDP 응답이 수십 초 늦을 수 있다**(같은 머신에서 20ms ↔ 16초, 백신 검사·콜드 캐시 추정). 짧은 타임아웃 + 재연결 반복은 늦게 오는 응답을 매번 버려 영원히 실패한다 — 대기를 키울 것. `--full` 은 패키징 직후를 피하고, `dist/win-unpacked` 를 백신 예외로 두면 안정적이다

## ③ 하네스 전수 (재사용 대상)

- **프로젝트 스킬 26종** (`.claude/skills/`): adblock-engine · webcontents-view-pattern · electron-secure-defaults · video-detect-ytdlp · ai-sidebar-design · policy-engine-rules · tab-restore-session 등
- **로컬 병과 28종** (`.claude/agents/`): tab-engineer · download-manager · policy-engine-developer · security-auditor · settings-developer · ui-designer · release-engineer 등 (전부 도메인 특화 — 신규 설계 전 반드시 재사용 탐색)
- **슬래시 커맨드 6종** (`.claude/commands/`): audit-perf · audit-download · build · new-feature · release · test-safety
- **훅**: 없음. `.claude/settings.json` 은 permissions allow/deny 만.
  - **deny (가드레일과 동급)**: `rm -rf` · `npm run package -- --publish*` · `gh release create` · `electron-builder --publish*` → **배포·발행은 전부 승인 대기**
- MCP: 프로젝트 전용 없음. launch.json 없음.

## ④ CLAUDE.md 3요소 충족 여부

| 요소 | 상태 |
|------|------|
| 실행·테스트 방법 | ✅ 충분 (품질 게이트 + `/audit-perf` + test.md 게이트 0~7) |
| 금지선 | ✅ 명확 (보안 기본값 절대 약화 금지 · BrowserView 사용 금지 · 자유도 7축 약화 금지 · adblock 기본 OFF 금지) |
| 알려진 함정 | ✅ **매우 풍부** — 회귀 #1~#17 전부 원인·수정까지 기록. 특히 **세션 불일치 계열(#5·#11·#12·#13·#14)** 은 재발 상습 지대: 새 partition 도입 시 protocol·권한·webRequest·will-download 를 `session-bootstrap` 훅으로 전부 걸어야 함 |

문서 역할 분리: **CLAUDE.md = 구현 정본**, `status.md` = 출시 진척 정본, `goal.md`/`plan.md`/`rules.md`/`test.md` = 목적지·경로·제약·합격.

## ⑤ git 상태 (2026-09-06 정찰 시점)

- 브랜치 `main`, 커밋 2개뿐 (`42d61c6`, `4f8b0d5`)
- ⚠ **미커밋 20파일 수정 + 5파일 신규 = +5190 / −3798 줄**
  - 신규: `features/ai/agent-gate.ts` · `features/client-hints.ts` · `build/{bench-agent,probe-fingerprint,verify-agent-safety}-cdp.mjs`
  - 내용상 **묶음 SEC-1~4 · SPD-1 · YTDLP-1**(2026-08-20~25) 분량이 통째로 미커밋
- 원격(remote) 없음 → 자동 업데이트 `owner: REPLACE_GH_OWNER` 미해결과 연결

## ⑥ 눈에 띄는 지뢰

1. **미커밋 대량 델타** — 위 ⑤. 로컬 사고 한 번에 6라운드 분량 유실 가능. 최우선 위생 과제.
2. **문서 드리프트** — `status.md` 는 **V5(2026-07-12)에서 멈춤**. 그 뒤 CLAUDE.md 에만 기록된 라운드가 **V6 · 릴리즈-1 · AI-1~16 · SEC-1~4 · SPD-1 · YTDLP-1 (약 25라운드)**. 출시 진척 정본이 2개월 낡음 → 다음 지휘자가 오판하기 쉬움.
3. **YTDLP-1 은 게이트 0만 통과** — typecheck·build 만 돌리고 스모크 미실행. 그 이후 회귀 미확인 상태.
4. TODO/FIXME 주석: **0건** (코드 위생 자체는 양호).
5. 출시 차단 2건은 **사용자 제공 필요**(코드 서명 인증서 · GitHub `owner/repo` 실값) → 자율 실행 불가, 가드레일.
6. 루트의 검증 산출물(`smoke-*.log`·`smoke-out*/`·`verify-out/`·`logs/`·`설치파일/`·`resources/brand/`)은 **.gitignore 등록 확인됨** — 커밋 오염 위험 없음.

## Changelog
- 2026-09-06: 최초 정찰 (auto-dev 첫 출정).
