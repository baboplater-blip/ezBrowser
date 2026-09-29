# 귀환 보고서 — auto-dev 임무 A: 위생·안전망

- 일시: 2026-09-06
- 브랜치: `auto-dev/hygiene-sync` (main 은 `42d61c6` 그대로 — merge 는 사용자 결정)
- 등급/편성: **T2 / 편성 0기 (지휘자 직접)** — 본체가 결정론 검증(스위트·스모크·해시)이라 편성 경제 §2에 따라 병과 미투입

---

## 1. 한 일

1. **첫 출정 정찰** → `docs/auto-dev/RECON.md` (신규, 83줄)
   구조·스택·진입점 / 실행·테스트 명령(실측) / 하네스 전수(빌드 하네스 20여 종·스킬 26·병과 28·커맨드 6·permissions deny) / CLAUDE.md 3요소 충족 / git 상태 / 지뢰 6종.
2. **미커밋 6라운드 분량 검증 후 체크포인트 커밋** — `b300a0a`
   묶음 SEC-1~4 · SPD-1 · YTDLP-1 (2026-08-20~25), 27파일(수정 21 + 신규 6, `agent-gate.ts`·`client-hints.ts`·검증 하네스 3종 포함).
3. **스모크 하네스 간헐 실패 수정** — `build/smoke-cdp.mjs`
   `connectShellSessionReady()` 신설 + `CDPSession.send()` pending 정리. 상시 게이트가 3회 중 2회 무너지던 문제 해소.
4. **문서 정본 동기화**
   - `status.md`: V6·릴리즈-1·AI-1~16·SEC-1~4·SPD-1·YTDLP-1 **5개 엔트리 추가**(2개월/25라운드 드리프트 해소), 한눈에 표·현재 Phase·출시 차단 목록·다음 행동 전면 갱신.
   - `CLAUDE.md`: 이번 라운드 변경 이력 추가(하네스 버그 원인·fix·교훈 포함).
5. 본 보고서 — `docs/run-reports/2026-09-06-hygiene-sync.md`

---

## 2. 내린 결정과 이유

| 결정 | 이유 |
|------|------|
| **정찰을 Explore 병과 대신 지휘자 직접** | CLAUDE.md 가 이미 매우 상세(회귀 #1~#17 원인·수정까지). 병과 정찰 ≈155k 를 쓸 위험이 없었음 |
| **편성 0기로 진행** | 이 임무의 본체는 결정론 검증. 테스터·리뷰어를 넣으면 같은 스위트를 두 번 돌리는 순수 낭비 |
| **패키지 exe 가 최신인데도 재패키징** | 검증 대상이 "미커밋 델타"라 exe↔소스 일치가 결론의 전제. mtime 증거(소스 중 asar 보다 새 것 없음)만으로 끝내지 않음 |
| **스모크 첫 FAIL 을 "앱 회귀"로 단정하지 않음** | 하네스가 멈춘 그 순간 **별도 CDP 클라이언트로 프로브**해 21ms 정상 응답을 확인 → 앱 아님, 하네스 레이스로 판정 |
| **스모크 하네스를 이번 임무에서 고침** | "3회 중 1회만 도는 게이트는 게이트가 아니다". 미커밋 델타 검증의 신뢰성이 여기 걸려 있었음 |
| **에이전트 안전(A1~A14)·지문 하네스까지 추가 실행** | 미커밋 델타의 **본체가 AI 에이전트 안전(SEC-1~4·SPD-1)** 이라 스모크만으로는 델타를 덮지 못함 |
| **미커밋 델타를 임의 수정하지 않음** | 사용자 본인 작업. 검증 통과 → 원형 그대로 커밋 (실제로 수정 필요 없었음) |
| **커밋을 main 이 아닌 `auto-dev/hygiene-sync` 에** | 승인받은 계획 그대로. main 은 사용자가 diff 보고 merge 결정 |
| **커밋 2개로 분리** | 사용자 작업(`b300a0a`)과 auto-dev 산출물(하네스 fix·문서)의 책임 경계를 분리 |

---

## 3. 검증 결과

### 게이트 0
| 항목 | 결과 |
|------|------|
| `npm run typecheck` (main/preload/renderer) | ✅ **0 에러** |
| `npm run build` | ✅ 성공 — 외피 JS 302.87KB / **gzip 99.21KB** (예산 500KB의 20%), preload chrome 33.2 / content 36.9 / internal 50.8KB |
| `npm run package:win` | ✅ NSIS `dist/ezBrowser-0.1.0-win-x64.exe` 생성 (미서명 — 인증서 부재, 예상된 경로) |

### 게이트 1 — 스모크 (`build/smoke-cdp.mjs`)
| 실행 | 결과 |
|------|------|
| 패치 전 1회차 | ❌ **INFRA FAIL** (전 시나리오 미실행) |
| 패치 전 2회차(--keep-alive) | ❌ INFRA FAIL |
| 패치 전 3회차 | ✅ **16/16 PASS** ← 미커밋 델타 무회귀 확정은 이 실행 |
| **패치 후 3회 연속** | ✅ **16/16 PASS ×3, INFRA 실패 0** |

통과 시나리오: S1 omnibox 라우팅 · S2 goBack · S3 탭 생성/전환/닫기 · S4 북마크 · **S5 다운로드(가속 5MB + 단일 폴백 1MB, 바이트 정확 일치)** · **S6 동영상 감지·직접 다운로드(2MB 바이트 일치)** · S7 settings 왕복 · S8 팔레트 · S9 워크스페이스 격리 · R11R12 browser:// 회귀 · R13 워크스페이스 partition adblock · S10 adblock · S11 다크모드 · S12 시크릿 창 격리 · Z1/Z2 z-order.

### 델타 전용 하네스
| 하네스 | 결과 |
|--------|------|
| `verify-agent-safety-cdp.mjs` (A1~A14) | ✅ **14/14 PASS** — DOM 지문 0 · shadow DOM · 재활용 노드 오클릭 방어 · 사람 궤적 클릭 · 가림 폴백 명시 · 진행률/선택상태 관찰 · 타이핑 변동계수 0.89 · accept 매칭 업로드 · 65초 대기 유지 · 파일창 가로채기 · 드롭존 · 아이콘 드롭존 · 빠른 프로파일 10/10 정확 |
| `probe-fingerprint-cdp.mjs` | ✅ **"[문제] 없음"** — UA `Chrome/134.0.6998.205 Safari/537.36`(Electron·앱 토큰 없음) · `sec-ch-ua` HTTPS 전송 · `navigator.webdriver` false |

### 하네스 버그 — 원인 규명 기록
- 증상: 외피 타깃은 발견되는데 가장 단순한 `Runtime.evaluate`("windowId 읽기")가 15초 타임아웃, **CDP 에러조차 없음**.
- 결정적 실험: 하네스가 멈춘 순간 별도 클라이언트로 같은 포트를 프로브 → `Runtime.enable` ok, `evaluate(1+1)` = 2 (수 ms). **앱은 정상**.
- 원인: `/json/list` 에 타깃이 보이는 것 ≠ CDP 명령 수신 준비 완료. 실행 컨텍스트 미생성/타깃 스왑 시점에 보낸 명령이 **영구 유실**.
- 수정: `Runtime.enable` 선행 + 짧은 타임아웃 프로브 + 재연결 재시도, `send()` 타임아웃 시 pending 정리.
- **정직한 한계**: 패치 후 3회 모두 **첫 시도에 성공**해 재시도·재연결 경로 자체는 실전에서 관측되지 않았다. 실효 원인은 `Runtime.enable` 선행일 가능성이 높고, 재시도는 방어층이다. 통계는 패치 전 1/3 → 패치 후 3/3.

### 커밋
| 커밋 | 내용 |
|------|------|
| `b300a0a` | 사용자 델타 체크포인트 (SEC-1~4·SPD-1·YTDLP-1, 27파일) |
| (본 보고서 커밋) | 하네스 fix + RECON.md + status.md/CLAUDE.md 동기화 + 보고서 |

### 지휘자 토큰
`~/.claude/auto-dev/token-log/<session_id>.json` 미생성(이 환경에 Stop 훅 `token_log.py` 미설치) → **실측 불가**. 체감 규모는 계획 견적 M(~300k) 이내(병과 0기, 대부분 하네스 실행 로그 판독).

---

## 4. 못 한 것과 이유

| 항목 | 사유 |
|------|------|
| **`git push` / 원격 반영** | **가드레일** — 계획서에 없음. 로컬 커밋까지만. 프로젝트 `.claude/settings.json` 의 deny(`gh release create`·`--publish`)와도 일치 |
| **main 으로 merge** | 규범상 사용자 결정. 아래 "복귀 방법" 참조 |
| **코드 서명** | 사용자 인증서(.pfx) 필요 — 자율 해결 불가 |
| **z-order(Z1/Z2) 육안 판정** | 하네스가 OS 스크린샷까지만 저장(`smoke-out/zorder-*.png`), PASS 는 "촬영 성공"이지 "가려지지 않음"의 자동 판정이 아님. 사람 눈 필요 |
| **`askEveryTime` 다운로드 다이얼로그** | 네이티브 모달이라 CDP 자동 검증 불가 |
| **재시도·재연결 경로 실증** | 위 3절 기재 — 패치 후 첫 시도에 계속 성공 |

### ⚠ 복귀 방법 (중요)
현재 HEAD 는 `auto-dev/hygiene-sync` 다. **이 상태에서 `git checkout main` 을 하면 작업 트리에서 6라운드 분량이 사라진 것처럼 보인다**(커밋은 브랜치에 안전히 있음). 정상 경로:

```bash
git diff main..auto-dev/hygiene-sync --stat   # 먼저 확인
git checkout main && git merge --ff-only auto-dev/hygiene-sync
```

---

## 5. 다음 업그레이드 제안 3개

1. **`perf-check.mjs` 를 판정 게이트로 승격 (게이트 4 자동화)** — goal.md DoD C 중 유일한 미완("`/audit-perf` 자동 측정이 회귀를 막는다"). V4/V6 에서 측정법(웜/콜드 트랙 분리, adblock 콜드 고정비 예외)은 이미 확정됐으므로, 남은 일은 **예산 판정 + 초과 시 비0 종료 + 결과 JSON 저장**뿐. 규모 S~M, 위험 낮음.

2. **하네스 통합 러너 `build/verify-all.mjs`** — 지금은 스모크·에이전트 안전·다운로드·확장·성능·스트레스·복원이 각각 따로 있고, 라운드마다 무엇을 돌릴지 사람이 기억해야 한다(YTDLP-1 이 게이트 0만 돌고 끝난 이유). `--quick`(게이트0+스모크) / `--full`(전 하네스) 두 모드 + 통합 결과표 + 종료 코드. **이번 임무에서 드러난 구조적 구멍을 메우는 항목.** 규모 M.

3. **자동 업데이트 실경로 e2e 검증** — 인프라(oneClick·GitHub Releases·`app-update.yml`)는 완성이나 **"구버전 설치본이 새 릴리즈를 실제로 받아 설치하는지"** 는 한 번도 확인된 적이 없다. 0.1.0 설치 → 0.1.1 로컬 릴리즈 발행(가드레일: 발행은 승인 필요) → 배너·다운로드·재시작 설치까지 격리 프로필로 확인. 출시 직전 반드시 필요. 규모 M.

---

## 부록 — 이번 임무가 남긴 재사용 자산
- `docs/auto-dev/RECON.md` — 다음 auto-dev 임무는 정찰 생략 가능
- `build/smoke-cdp.mjs` 의 `connectShellSessionReady()` — 다른 CDP 하네스(`stress`·`session-restore`·`dl-matrix`·`ext-matrix`)에도 같은 레이스가 잠재. 동일 패턴 이식 권장
