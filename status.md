# status.md — 지금 어디까지 왔는가

> **이 문서는 살아있다.** 라운드를 끝낼 때마다 갱신한다.
> 목적지 [goal.md](goal.md) · 경로 [plan.md](plan.md) · 제약 [rules.md](rules.md) · 합격 [test.md](test.md).
> 상세 구현 이력(묶음 A~FF)은 [CLAUDE.md](CLAUDE.md)의 "변경 이력"이 정본. 여기는 **출시 관점의 요약**만 둔다.

---

## 한눈에

| 항목 | 상태 |
|------|------|
| 제품명 | **ezBrowser** (코드네임 browser-build) |
| 버전 | `0.1.0` (내부 개발 빌드) |
| 빌드 | ✅ 통과 (외피 JS 303KB / gzip **99KB** — 예산 500KB의 20%) |
| 부팅 | ✅ packaged 5+ 프로세스 정상, 로그 clean |
| 기능 완성도 | 🟢 **매우 높음** — 콕콕 14종 + 자유도 12모듈 + 다운로드 엔진 + 세션 복원 + 탭 그룹 + **AI 어시스턴트/자율 에이전트(AI-1~16)** |
| **출시 준비도** | 🟡 **중간** — 온보딩·데이터 가져오기·브랜드·oneClick 인스톨러·자동업데이트 실배포까지 완료. **잔여 차단 1건 = 코드 서명(사용자 인증서 필요)** |
| 실사용 검증 | 🟢 **상당** — 스모크 16/16·에이전트 안전 14/14·다운로드 10/11·확장 9/10·50탭 스트레스·강제kill 복원 17/17 전부 하네스 자동 검증 |

**핵심 진단(2026-09-06 갱신): "설치·검증까지 끝났고, 이제 서명만 남았다."** 초기 진단이었던 *출시·검증·첫인상*의 간극은 대부분 메워졌다 — 남은 것은 **코드 서명 인증서(사용자 제공)** 와 **실사용 관찰**이다.

---

## 현재 Phase: **Phase 4~6 (약속 실증 완료 → 베타 마감) — Phase 0·1·2·3·5 완료**

- [x] goal/plan/status/rules/test 5문서 작성
- [x] 게이트 0 baseline 실측 (typecheck 0 · build · 부팅 크래시 0) — 상시 유지 중
- [x] **크롬/엣지/Brave/웨일 데이터 가져오기** + **온보딩 마법사 5단계**
- [x] **개인정보 처리방침**(browser://privacy) + **OSS 라이선스**(browser://licenses)
- [x] **제품 정체성 확정** — ezBrowser, 깃털 아이콘, 온보딩·빈상태 일러스트 21종
- [x] **게이트 1 스모크 16/16** · **게이트 2 회귀 재현** · **게이트 3 50탭 스트레스·강제kill 복원**
- [x] **게이트 4 성능 분해** (웜 226MB 예산 통과 / 콜드 285MB = adblock 고정비, 예외 조항)
- [x] **게이트 5 약속 매트릭스** — 다운로드 10/11 · 확장 9/10(ID 아키텍처 버그 fix 포함)
- [x] **oneClick NSIS 인스톨러** 설치→부팅→제거 실증 · **자동 업데이트 GitHub Releases 실배포**
- [x] **AI 레이어**(AI-1~16) + **자동발행 안전 게이트·봇 탐지 회피**(SEC-1~4·SPD-1)
- [ ] **코드 서명 인증서** ← **유일한 출시 차단 (사용자 제공 필요)**
- [ ] 깨끗한 외부 Windows 실기 설치·업데이트 검증
- [ ] `/audit-perf` 자동 회귀 차단 게이트화 (측정법은 확정, 판정 자동화 미완)

---

## 무엇이 되어 있나 (출시 관점)

### ✅ 충분히 된 것
- **렌더링/엔진**: Electron 35.7.5 + Chromium, WebContentsView 탭 모델, sandbox+contextIsolation 전 세션 강제
- **콕콕 기본 14종**: 광고차단(전 세션, anti-adblock 우회 포함)·동영상 다운로드(progressive/HLS 네이티브/yt-dlp)·토렌트·다운로드 가속·번역·스크린샷·사이드패널·다크모드·리더모드·비밀번호(safeStorage)·QR·빠른검색·제스처·새탭위젯(날씨/뉴스/메모/할일/환율/바로가기)
- **자유도 7축 + 모듈 12종**: userChrome css/js·userscript·명령팔레트·워크스페이스·레이아웃(탭바3방향+분할)·키맵 재바인딩+인라인편집·정책엔진(권한룰+import/export)·자동화매크로·디자인토큰·데이터주권·Mod API
- **세션 복원**: 탭·그룹·분할 레이아웃·내비게이션 히스토리·스크롤·폼, 비정상 종료 대응
- **탭 관리**: 그룹(색·접기·영속)·일괄작업·음소거·호버 미리보기·검색(Ctrl+Shift+A)·최근 닫은 탭·읽기목록
- **확장 호환 기반**: electron-chrome-extensions 어댑터 (로드 경로는 있음)
- **자동 업데이트 인프라**: electron-updater 설치·UI·설정 노출 (저장소 미연결)

### 🟡 되어 있으나 미검증/미연결
- **자동 업데이트**: 코드는 완성, `electron-builder.yml`의 `owner: REPLACE_GH_OWNER` 플레이스홀더 — **실제 저장소 미연결**
- **확장 호환 매트릭스**: 어댑터는 있으나 10종 실로드 검증 안 함
- **다운로드 매트릭스**: 엔진은 있으나 `/audit-download` 11시나리오 전수 미실행
- **성능 예산**: 게이트 4 정밀 측정·분해 완료(라운드 4, 아래 로그) — 웜(2번째 이후 실행) 빈 창 226MB로 250MB 예산 통과, 콜드(첫 실행) 285MB로 여전히 초과(원인: adblock 필터 엔진 콜드 빌드, 고정비용). `/audit-perf` 자동 회귀 차단은 여전히 미완
- **i18n**: ko/en 키 존재, 누락 전수 점검(`i18n:check`) 미실행, vi 부분

### 🔴 아직 없는 것 (출시 차단)
- **코드 서명** — Windows 미서명 (SmartScreen 경고). **사용자 인증서(.pfx) 제공 필요 — 자율 해결 불가**
- **외부 환경 검증** — 깨끗한 Windows(다른 PC)에서 설치→실행→자동업데이트 수신 실기 테스트
- ~~온보딩~~ ✅ 완료 (browser://welcome 5단계) · ~~데이터 가져오기~~ ✅ 완료 · ~~제품 정체성~~ ✅ ezBrowser 확정
- ~~개인정보 처리방침~~ ✅ 완료 · ~~배포 채널~~ ✅ GitHub Releases 연결 (랜딩 페이지는 미정)

---

## 알려진 위험 / 부채

- **세션 불일치 회귀 계열(#5·#11·#12·#13·#14)**: 새 partition 도입 때마다 재발했음. session-bootstrap hook으로 통합됐으나, **앞으로 새 세션 기능 추가 시 반드시 전 partition 적용 확인** (rules.md 명문화).
- **policy ↔ adblock onHeadersReceived 통합 디스패처 부재**: 보통 무해(정책 룰 비어있음)하나 잠재 충돌. Phase 4~5에서 통합 검토.
- **빌드 함정**: 패키징 전 실행 중인 `ezBrowser.exe` 종료 필수 — 안 하면 `Access is denied`로 stale exe. (하네스는 이름이 아니라 **자기가 띄운 PID 트리만** 종료한다 — 사용자 인스턴스 보호)
- **better-sqlite3 → sql.js(WASM)**: 네이티브 toolchain 회피로 sql.js 사용 중. 성능 한계 시 재검토.
- **HLS live 미지원 / DASH 네이티브는 muxed만**(분리 음성은 yt-dlp).

---

## 다음 행동 (구체적으로)

1. **코드 서명 인증서 확보** — 유일한 출시 차단. 사용자가 `.pfx`(또는 EV) 제공 시 `CSC_LINK`/`CSC_KEY_PASSWORD` 로 즉시 서명 빌드 가능
2. **깨끗한 외부 Windows 실기 검증** — 설치 → 첫 실행 → 자동 업데이트 수신까지 (VM 또는 다른 PC)
3. **`/audit-perf` 자동 판정 게이트화** — `perf-check.mjs` 를 예산 판정기로 승격(콜드/웜 트랙 분리, 초과 시 비0 종료)
4. **실사용 관찰 항목** — SEC-4 이후 봇 탐지 통과 여부·yt-dlp 자동 최신화 실동작은 코드로 더 보증할 수 없고 실사용에서만 확인 가능

---

## 최근 라운드 로그 (최신이 위)

### 2026-09-07 — auto-dev 임무 11: A14 flake 원인 제거 → 종결 게이트 11/11 복귀
- **기준을 낮추지 않고 원인을 없앴다**: 의도된 폴백은 A6 가 이미 검증하므로 A14 에서 허용하면 시나리오의 질문 자체가 사라진다. 진짜 문제는 **시나리오 간 DOM 오염**(A6 오버레이·A13 드롭존이 남아 대상 버튼을 덮음) → A14 를 자기 완결적으로(잔재 제거 + 스크롤 리셋).
- **폴백 진단 추가**: rect·scrollY·뷰포트·덮은 요소를 오류에 첨부.
- **검증**: A14 **8회 연속 PASS**(수정 전 실패율 ≈1/5) · 종결 절차 `verify:full` **11/11 PASS · 10분 30초**(직전 10/11 · 16분 22초).
- **한계**: 실패를 직접 재현해 원인을 확정한 것은 아님 — "가장 그럴듯한 원인을 구조적으로 제거".

### 2026-09-07 — auto-dev 임무 10: 라운드 종결 절차 명문화 (`verify:full`)
- **종결 규칙**: 라운드 중 `npm run verify`(30초) / **닫을 때 `npm run verify:full`**(11단계, 기준선 11/11 · 약 10분) + **보고서용 요약 자동 생성**(`verify-all-summary.md`). test.md 판정 규칙 교체, `/audit-perf` 도 러너를 가리키게.
- **첫 적용에서 flake 포착**: verify:full **10/11** — agent-safety **A14** 가 합성 폴백으로 실패, 소요 1m14s→**7m13s**. 즉시 재실행 **14/14 PASS** → **회귀 아닌 기존 flake** 확인. 절차를 느슨하게 하지 않고 실패를 그대로 기록.
- **다음 1순위**: A14 판정 기준 재검토(오클릭·입력 정확도를 겨냥하도록) — 매번 빨간 게이트는 무시당한다.

### 2026-09-07 — auto-dev 임무 9: sql.js 지연 기각 · 메모리 페이지 거짓 판정 수정 · 탐지 한계 보고
- **sql.js 지연 로드 기각(짓기 전에)**: 새 탭이 로드 즉시 DB를 읽어 피크가 1초 미뤄질 뿐. sql.js 런타임은 이미 공유, 저장소 API 는 전부 동기라 광범위 리팩터 필요 → **비용 크고 이득 없음**. (임무 5는 구현 후 되돌렸는데, 이번엔 짓기 전에 걸렀다.)
- **`browser://memory` 사용자 대면 결함 수정**: WorkingSet 합(≈750MB)을 private 기준 250MB 예산과 비교해 **항상 초과로 보이던** 거짓 판정 제거. 하네스 실측 기준선(adblock 제외 145 / 총계 249 · 그중 adblock 104MB) 표시 + 지표 혼동 방지 안내.
- **A/B 탐지 한계 사전 보고**: 측정 전에 "이 조건에서 볼 수 없는 크기"를 알려 "차이 없음"을 원인 부재로 오해하지 않게.
- 검증: verify 4/4, memory 페이지 CDP 실기 확인.

### 2026-09-07 — auto-dev 임무 8: 예산 2축 재기준화 → **`verify:full` 첫 11/11**
- **판정 2축**: 1순위 **adblock 제외 ≤ 155MB**(우리 코드) / 총계 250MB 는 **참고·추세**로 강등. 총계가 249~254MB 로 예산선에 붙어 실행마다 뒤집혔고, adblock 고정비(104MB)가 우리 코드의 회귀를 덮었기 때문.
- **155MB 근거**: dual 3회 149·146·149MB(노이즈 ±1.5MB) → 중앙값+6MB. 확정 후 3회 **144·147·144 전부 PASS(여유 8~11MB)**. (첫 dual 164MB 는 이상치 — 1회로 정했으면 또 틀렸다.)
- **`perf-measure --dual`**: adblock ON/OFF 두 baseline 을 한 실행에서(+54초). 표에 `그중 adblock N MB` 와 **여유(headroom)** 표기.
- **`verify:full` 11/11 PASS · 10분 7초** — 유일하게 빨갛던 perf 가 초록. **예산을 올려서가 아니라 무엇을 재는지 바로잡아서.**
- CLAUDE.md 가벼움 예산 표에 2축·근거 실측 명문화.

### 2026-09-07 — auto-dev 임무 7: 메모리 출처 사냥 (adblock 110MB 확정)
- **adblock 이 빈 창 메모리의 44%**: A/B ON 257MB vs OFF **147MB** → 차이 **110MB**(산포 19MB 상회, "차이 있음" 판정). V4 기록 ≈107MB 와 동일 — adblock 은 커지지 않았다.
- **부팅 초기화 6종은 전부 꺼도 차이 없음**(-6.5MB < 산포 18MB). 대조군(AI)으로 절차 검증 완료.
- **방법론 전환**: 부팅 간 산포(15~18MB)로 10MB 미만 분리 불가 → **한 부팅 안에서** rss 증분 측정. `db(sql.js) +60.9MB`(GC 대부분 회수 — **피크 메모리 최대 항목**), 나머지는 전부 ≤1MB.
- **못 한 것**: +24MB 증가 출처는 **미상**(주요 후보는 배제). 이 머신 분해능으로는 더 좁힐 수 없어 억지 지목하지 않음.
- 측정용 임시 코드 전량 제거, `npm run verify` 4/4 무회귀.

### 2026-09-07 — auto-dev 임무 6: 측정 신뢰성 3종 (A/B 자동화 · 기준선 확정 · full 완주)
- **A/B 자동화**(`perf-breakdown --ab`): 교대 실행 N회 + **산포 대비 판정** — 차이가 산포 이내면 도구가 "차이 없음"을 선언. 임무 4·5의 두 번의 오판을 코드가 차단. 자기검증 통과.
- **기준선 확정**: 조용한 상태 5회 **249·250·249·250·251(±1MB)**, 누적 10회 중앙값 **250MB**. → 측정은 신뢰 가능하고, 임무 5의 ±13MB 는 **자기 유발 부하**였다. **예산 250MB 대비 여유 0**(게이트가 실행마다 뒤집히는 이유). V4(226MB) 대비 **+24MB 증가는 실재**로 판단 갱신, 출처는 미상(AI 아님).
- **`verify:full` 첫 완주**: **10/11 PASS · 9분 18초**(유일 실패 = perf 예산). 단계별 실측 소요 확보 — 견적(20~40분)보다 훨씬 싸다.
- **부수**: perf 이력을 저장소 고정 위치로 통일(게이트·수동 실행이 한 추세선 공유).

### 2026-09-07 — auto-dev 임무 5: 다크모드 오탐 해소 · AI 지연 로드 철회 · perf 기준선 추적
- **⚠ 임무 4 수치 정정**: "AI 레이어 ≈15MB" 는 **오판, 철회**. 4대4 교대 A/B 에서 차이 소멸(ON 256·256·248·233 / OFF 258·260·257·248). 실제 원인은 **실행 간 ±13MB 드리프트**(같은 빌드 233~260MB). 지연 로드는 구현 후 개선이 없어 **전량 되돌림**(앱 코드 변경 0).
- **S11 다크모드**: 격리 재현기 15/15 정상 → **앱 결함 아님**. 부하 시 CSS 반영 지연이 원인 → 폴링 3s→8s + 실패 진단(대상 탭·전체 탭 filter) 추가. **스모크 6회 연속 16/16**.
- **perf 기준선 추적**: `perf-history.json`(최근 50회) + 과거 중앙값 대비 delta·경고. 회귀는 **중앙값 이동**으로 판단.
- **부수**: `perf-out/`·`perf-breakdown-out/` git 추적 해제(산출물 290여 파일이 커밋 오염).
- **검증**: verify 4/4 · agent-safety 14/14 · session-restore 17/17.
- **남은 사실**: 웜 빈 창 RSS 251~254MB 로 예산 경계 위. **증가 출처 미특정**(AI 아님) — 조용한 머신 재측정이 선행 과제.

### 2026-09-07 — auto-dev 임무 4: perf 게이트 결정론화 + 빈 창 RSS 증가 원인 규명
- **진단**: baseline 을 5표본 시계열로 재고 `engine.bin` 존재로 웜/콜드를 라벨링 → 표본 내 변동 3~4MB(작음), **웜/콜드 차 40~46MB(큼)**. 판정 요동은 측정 노이즈가 아니었다.
- **수정**: 콜드 완화 조항 코드화(`adblockColdAllowanceMB: 60` → 웜 250MB / 콜드 310MB 자동 적용, 콜드 290MB PASS) · baseline **중앙값** 판정 · 결과 표에 경로·표본·적용 예산 표기.
- **핵심 발견(제품 사실)**: 웜 빈 창 RSS 가 **V4 226MB → 243~251MB**. `perf-breakdown` 격리 결과 메인 프로세스 169MB(V4 143MB), **AI 레이어를 끄면 총 240MB 로 예산 이내** = AI 기여 **≈15MB**. 웜 판정이 250/250/251 로 뒤집히는 것은 **값이 예산선 위에 있다는 뜻**이다. **예산은 고치지 않았다** — ① AI 지연 로드 ② 10MB 회수 ③ 완화 항목 명시 중 **제품 결정 필요**.
- **관찰**: S11(다크모드) 간헐 실패 ≈50% — 설정은 `true` 인데 그 탭에 CSS 주입 안 됨(추적 누락 의심). 앱 측 별도 라운드.

### 2026-09-07 — auto-dev 임무 3: CDP 접속 공통 모듈 이식 (하네스 11개)
- **왜**: 9/6 에 스모크에서 고친 접속 결함(좀비 포트 선점·CDP 응답 지연·pending 잔류)이 **나머지 10개 하네스에 그대로** 남아 있었다. `CDPSession` 은 11개 파일에 복제돼 있었다.
- **[build/lib/cdp.mjs](build/lib/cdp.mjs) 신설 + 11개 이식**: 중복 약 600줄 제거, 지역 `CDPSession` 0개. 외피 접속 8곳을 `connectShellSessionReady`(프로브 8s→20s→30s, 총 90초)로, 앱 기동 8곳에 포트 점유 가드, 갓 뜬 창·탭 접속 4곳에 `ensureSessionReady`.
- **검증(전부 실측)**: smoke 16/16 · session-restore 17/17 · dl-matrix 10 PASS/1 SKIP · ext-matrix PASS · stress PASS · fingerprint PASS · agent-safety 14/14 · bench-agent 정상(클릭 159ms, SPD-1 기록치 일치).
- **⚠ 자동 변환 사고 검출·복구**: 1차 변환기가 **한 줄 함수**를 만나 다음 블록까지 삼켜 압축형 3파일에서 함수들이 조용히 사라졌다(문법 검사는 통과 — 선언 소실은 문법 오류가 아님). **선언 소실 감사**로 3건 전부 검출 → 복원 후 중괄호 깊이 추적 방식으로 재이식, 파손 0. **자동 리팩터링에 문법 검사만으로는 부족하다.**
- **perf 게이트 판정 버그 수정**: 참고용 WorkingSet 열(CLAUDE.md 가 "판정에 쓰지 말 것"이라 명시) 때문에 **모든 예산 통과에도 항상 exit 1** 이던 것을 private 기준 판정으로 교정.
- **못 한 것**: 빈 창 RSS private 이 같은 세션에서 **242MB ↔ 254MB**(예산 250MB)로 경계에서 흔들린다 — V4 의 웜/콜드 구간 경계. **예산을 고쳐 통과시키지 않았다**(다음 라운드 과제). `verify-fixes`·`perf-breakdown` 은 이식만 하고 미실행.

### 2026-09-06 — auto-dev 임무 2: 검증 하네스 통합 러너 (`npm run verify`)
- **왜**: 하네스가 11개로 흩어져 라운드마다 무엇을 돌릴지 사람이 기억해야 했다(묶음 YTDLP-1 이 게이트 0만 돌고 끝난 원인). **기억에 의존하는 게이트는 게이트가 아니다** → 목록을 코드로 고정.
- **[build/verify-all.mjs](build/verify-all.mjs) 신설**: `npm run verify`(게이트 0+스모크) / `verify:full`(전 하네스) / `--only` / `--skip-build` / `--list`. 하네스를 **고치지 않고 감싸며** 종료코드(1차)+결과 JSON(2차)으로 판정, **하나라도 실패하면 비0 종료**. 단계별 회수 시계, 통합 결과표, `verify-out/all/verify-all-results.json`.
- **게이트로서의 자기 검증**: 고의 타입 오류 주입 → FAIL·exit 1 / 앱 실행 중 `--only package` → `BLOCKED`+PID 지목(사용자 창 미종료) / 낡은 결과 JSON 무시(거짓 `PASS 14` 차단) / 잔재 앱 정리·미종료 PID 경고 / **`--quick` 4/4 PASS**(스모크 16/16, exit 0).
- **감싸다 드러난 실제 결함 3건 수정**: ① 세 테스트 서버의 `close()` 가 앱 keep-alive 때문에 **영영 안 끝나던 정지**(스모크가 16/16 통과 후 8분 정지한 실측) ② **`taskkill /F` 가 죽음을 보장하지 않음** — "정리했다"던 PID 가 디버그 포트를 계속 쥠(확인·재시도 추가) ③ 4개 하네스의 기본 `--out` 이 죽은 절대경로.
- **⚠ 임무 A 원인 설명 정정**: INFRA 실패를 "실행 컨텍스트 미생성"으로 적었으나 **틀렸다**. 실제는 ① **좀비 인스턴스의 포트 선점**(죽은 타깃에 접속) ② **갓 패키징한 exe 의 첫 CDP 응답 지연**(같은 머신 20ms↔**16초** 실측). 대기를 90초로 확대.
- **못 한 것**: `--full` 완주 실패 — 위 ②와 반복 실행으로 누적된 미종료 인스턴스의 악순환. **앱은 정상**(adblock 정상 초기화·크래시 0·typecheck 0·`--quick` 통과). 재시도 전 **재부팅 또는 `dist/win-unpacked` 백신 예외** 권장, 패키징 직후는 피할 것.

### 2026-09-06 — auto-dev 임무 A: 위생·안전망 (미커밋 6라운드 검증·커밋 + 문서 정본 동기화)
- **계기**: auto-dev 첫 출정 정찰에서 **미커밋 +5190/−3798 줄**(SEC-1~4·SPD-1·YTDLP-1 6라운드 분량)과 **status.md 2개월 드리프트**(V5 이후 25라운드 누락) 발견. 로컬 사고 한 번에 유실될 수 있는 상태였다.
- **검증(전부 통과)**: typecheck 3/3 무경고 · build · `package:win` NSIS 재패키징 · **smoke-cdp 16/16 PASS ×3회 연속** · **verify-agent-safety A1~A14 14/14** · `probe-fingerprint` "[문제] 없음"(UA 정상·클라이언트 힌트 전송·webdriver false). → **미커밋 델타에 회귀 없음 확정** 후 체크포인트 커밋(`auto-dev/hygiene-sync` 브랜치).
- **하네스 버그 fix (상시 게이트가 3회 중 2회 무너지던 문제)**: `smoke-cdp.mjs` 가 `/json/list` 에 외피 타깃이 뜨자마자 `Runtime.evaluate` 를 보내면, 렌더러 실행 컨텍스트 미생성/타깃 스왑 순간에 걸려 **커맨드가 영영 응답하지 않았다**(CDP 에러도 없음) → INFRA 타임아웃으로 전 시나리오 FAIL. 앱은 정상이었음(동시 프로브가 같은 순간 정상 응답해 증명). **fix**: `connectShellSessionReady()` — 타깃 재발견→연결→`Runtime.enable`→짧은 타임아웃(2s) 프로브를 성공할 때까지 반복하고 실패한 세션은 버리고 재연결. `send()` 타임아웃 시 pending 정리도 함께. 패치 후 **3회 연속 무실패**.
- **문서 정본 동기화**: 이 로그의 V6~YTDLP-1 구간 + `docs/auto-dev/RECON.md`(정찰 지도 — 구조·실행법·하네스 전수·함정·지뢰) 신설.
- **출시 관점 변화**: 준비도 🔴낮음 → 🟡중간. **잔여 차단 = 코드 서명 1건**(사용자 인증서 필요).

### 2026-08-20~25 — 묶음 SEC-1~4 · SPD-1 · YTDLP-1: 자동발행 안전·봇 탐지 회피·속도·yt-dlp 최신화
- **SEC-1 (안전 게이트 재설계)**: 라벨 키워드 판정 폐기 → **위험 등급(none/confirm/critical)** 단일 게이트(`agent-gate.ts`). URL·행동·라벨 3축 판정, 모든 액션 핸들러보다 **앞**에 단일 지점(우회 경로 제거), 결제 iframe·삭제성 URL 은 판별 불가 시 보수적 차단, `run_js` 는 키워드가 아니라 **효과**로 판정(거부된 클릭의 JS 우회 차단). **무인 경로 격리** — 트리거·스케줄·배치는 전역 자동승인 토글을 무시, critical 은 자동승인 불가. 프롬프트 인젝션 신뢰 경계 + `remember` 영구 오염 차단 + 자격증명 마스킹. 격리 판정 테스트 **92 PASS**.
- **SEC-2~4 (봇 탐지 회피 — 재고 나서 고침)**: 진단 하네스(`probe-fingerprint-cdp.mjs`)로 실측 → **UA 에 `Electron/35.7.5` 노출**이 유일한 결정적 누출임을 확인하고 정규화. `navigator.webdriver` 는 이미 false(수정 불필요). 클라이언트 힌트(`client-hints.ts`)를 **실제 brands 그대로** HTTPS 에만 전송(값 지어내기 금지 — JS·헤더 불일치가 더 나쁜 신호), 브랜드 캐시로 첫 요청부터 적용. `navigator.languages` 는 3차 측정까지 하고 **손대지 않기로 확정**(헤더만 바뀌고 JS 는 안 바뀌어 불일치가 생김). DOM 지문(`data-bb-agent-ref`) 제거 → 레지스트리 방식. 파일 업로드 3종 결함(accept 매칭·OOPIF·파일창 가로채기) + 순수 드롭존 지원. 검증 하네스 **A1~A14**.
- **SPD-1 (속도)**: 벤치(`bench-agent-cdp.mjs`)로 먼저 측정 → 봇 회피 타이밍이 모든 사이트에 일괄 적용된 것이 원인. **사이트별 입력 프로파일**(탐지 도는 호스트만 strict) + 클릭 준비 JS 왕복 4→1 + 챗 컨텍스트 캐시. **클릭 525→162ms(3.2배)·입력 3.0→0.77초(3.9배)**, 정확도는 A14 로 유지 확인.
- **YTDLP-1**: yt-dlp 를 첫 설치 후 영원히 고정하던 것을 **버전 추적 + 자동 교체**(12h throttle, 다운로드 중이면 보류, 부팅 8초 후·주기·사용 시점 3트리거) + 설정 토글·"지금 최신화" 버튼.
- **출시 영향**: 자동발행(블로그·인스타·틱톡·유튜브) 기능이 "동작은 하나 위험"에서 **"등급 기반으로 안전하게 동작"** 으로. 실제 사이트 탐지 통과 여부는 실사용 관찰 항목으로 남음.

### 2026-07-21 — 묶음 AI-1~16: 브라우저 내장 AI 어시스턴트 + 자율 에이전트 (신규 제품 축)
- **AI-1 (사이드바·BYOK)**: Anthropic/OpenAI/Ollama(+AI-1b Gemini 무료 티어) **스트리밍** 제공자 추상화, API 키는 safeStorage 암호화(설정엔 "✓ 설정됨"만 표시), 페이지 맥락 주입(Readability 읽기 전용). **자체 LLM 없음 — 사용자 키 또는 로컬 Ollama**.
- **AI-2~4 (자율 에이전트)**: 관찰→판단→실행 루프. **크로스 프로바이더 JSON 액션 프로토콜**(제공자별 tool-use 배관 없이 어디서든 동작) + 민감 동작 확인 게이트 + 인터랙티브 ask + 탭 인식(열기·전환)·iframe 관찰/조작.
- **AI-5~6 (Memory·Dreaming)**: 편집 가능한 마크다운 1개(`browser://ai-memory`)에 개인 컨텍스트, 에이전트 `remember` 액션, 대화 종료 후 자동 추출(**프라이버시 기본 OFF 옵트인**).
- **AI-7~16 (사이드바 제품화)**: 대화 영속화·스레드·폴더/태그·고정·본문 검색·하이라이트·실행 이력·매크로·마크다운 렌더(외부 의존 0·XSS 안전)·**네이티브 tool-use**(지원 모델 자동 판별, 미지원은 JSON 폴백). 전용 설계 스킬 `ai-sidebar-design` 신설(280px 도크 제약).
- **검증**: 라운드마다 실제 로컬 Ollama 로 e2e(클릭 실행·게이트 거부·기억 회상·재시작 유지). 외피 gzip 72.7→82KB(예산의 16%).
- **출시 영향**: 경쟁 브라우저 대비 **차별화 축이 하나 더 생김**(aside.com 계열). 동시에 검증·안전 부담도 커져 SEC-1~4 라운드로 이어짐.

### 2026-07-12 — 묶음 릴리즈-1 + 자동 업데이트 실배포 (게이트 7 사용자-비의존 부분 완료)
- **oneClick NSIS 전환**: 마법사(`oneClick:false`) → **더블클릭 즉시 설치·자동 실행**(Chrome/Edge 방식), `perMachine:false` 로 **UAC 프롬프트 없음**. 커스텀 경로는 `win-unpacked` 복사로 대응.
- **설치 기전 실증(비오염)**: 무인 설치 `/S` exit 0 → 306파일 → 레지스트리·바로가기 → 자동 실행 확인 → 설치된 exe 를 격리 프로필로 부팅 검증 → 무인 제거 후 **사용자 실프로필 보존 확인**. 함정: oneClick 은 이전 설치 경로를 HKCU 에 기억 → 완전 정리는 Uninstall 키 + 경로 키 둘 다 sweep.
- **자동 업데이트 실연결**: 공개 저장소 `baboplater-blip/ezBrowser` 에 **첫 릴리즈 v0.1.0 발행** → `app-update.yml` provider:github 임베드 확인. 이후 업데이트는 version 올림 + `--publish always`.
- **잔여**: 코드 서명만.

### 2026-07-12 — 검증 라운드 V6: 경미한 잔여 4건 정리
- **다운로드 저장 위치 배선(실기능 결함)**: `settings.downloads.defaultPath` 를 앱이 무시하고 항상 OS Downloads 를 쓰던 것 → 유효 디렉터리면 우선 사용. `askEveryTime` 도 활성화(회귀 #16 재현을 피해 cancel-후-재요청 패턴 재사용). CDP 실검증 통과.
- **확장 description i18n 치환**(`__MSG_..__` raw 표시), **perf-measure 콜드런 보정**(adblock 캐시 seed 대기 → baseline 290→**225MB**, 웜 경로 안정 재현), **죽은 CSS 제거**.

### 2026-07-12 — 검증 라운드 V5: 게이트 5 매트릭스 (다운로드 10/11 + 확장 9/10) + 확장 ID 아키텍처 버그 fix
- **운용**: Fable 5 지휘관 + Sonnet 워커 3(확장 매트릭스 / 다운로드 매트릭스 / 확장 버그 fix). 지휘관이 **낡은 결과 파일에 속지 않고 최신 빌드로 직접 재검증**해 확정.
- **다운로드 매트릭스 (`build/dl-matrix.mjs`+`dl-matrix-server.mjs` 신규)**: 11시나리오 로컬 결정적 서버(AES-128 실제 암호화·쿠키게이트 403·throttled resume). **10 PASS / 1 SKIP(yt-dlp, 바이너리 미설치+네이티브 다이얼로그) / 0 FAIL**. progressive·토큰CDN octet·HLS 평문/fMP4/AES-128/master·DASH muxed·blob감지·쿠키게이트·재시작 이어받기 전부 바이트 일치. 라운드 Y/Z/AA 다운로드 엔진이 실증됨(앱 버그 0).
- **확장 호환 매트릭스 (`build/ext-matrix.mjs` 신규)**: 웹스토어 상위 10종 실 CRX 다운→로드→SW·팝업 검증. **버그 2건 발견·수정**:
  - **버그 1 (CRX 다운 버전 하드코딩)**: `adapter.ts` 가 `prodversion=120.0.0.0` 하드코딩 → `minimum_chrome_version>120` 확장(uBO Lite·Stylus·Wappalyzer) 204 거부. fix: `process.versions.chrome`(134) 동적화.
  - **버그 2 (확장 ID 불일치, 심각·아키텍처, 1원칙 #2 핵심 깨짐)**: temp 로드→최종 경로 이동→재로드 패턴이 경로 해시 기반 ID 를 두 번 생성 → 저장 ID ≠ 런타임 ID. 결과: 툴바 액션 팝업이 chrome-error, 이름 `__MSG_extName__`, disable/remove 무반응. **6개 로드돼도 0개 앱 UI 사용 가능**이었음. fix: **CRX 헤더 pubkey 를 manifest `key` 에 주입**(경로 무관 웹스토어 ID 파생) + 이동/재로드 제거(한 번만 로드). 함정: CRX3 헤더에 RSA proof 2개(구글 배포키 + 개발자키) → 첫 proof 잡으면 모든 확장이 동일 ID 로 붕괴. `signed_header_data(10000).crx_id`(정답 16바이트)와 교차검증해 올바른 proof 선택.
  - **결과(지휘관 직접 재검증)**: **9/10 로드 + 8/8 팝업 실제 렌더 + ID 완벽 일치**(저장 ID = 런타임 SW ID = 웹스토어 ID). Save to Pocket 만 delisted(204). CLAUDE.md "웹스토어 70% 무수정 동작" 목표 초과(90%).
- **검증 방법 교훈**: 워커 보고(성공)와 낡은 결과 파일(붕괴)이 모순 → 빌드 타임스탬프로 결과가 수정 전 산출물임을 간파 → 최신 빌드로 지휘관 직접 재실행해 확정. **산출물 타임스탬프를 코드 수정 시각과 대조하라.**
- **검증**: typecheck 3/3 · win --dir · 다운로드 10/11 · 확장 9/10(ID 일치) · 스모크 16/16 유지.
- **관찰(미수정)**: 확장 설명(description)의 `__MSG__` i18n 치환 미구현(이름은 fix됨), 앱 종료 시 exit code 0xC0000005(하네스 강제종료 경로 추정, 런타임 무관), 기존 붕괴 ID 설치본은 재설치 시 정상화.
- **다음**: 게이트 0~5 대부분 통과 — 남은 것은 **출시(게이트 7)**: 코드 서명·자동 업데이트 owner 실값(사용자 제공)·외부 환경 설치 검증.

### 2026-07-11 — 검증 라운드 V4: 게이트 4 메모리 주범 분해 + adblock 콜드 빌드 GC 넛지
- **운용**: Sonnet 워커 1, 병렬 없음. V3가 이월한 "게이트 4 = private RSS 정밀 측정" 과제 수행.
- **분해 하네스 `build/perf-breakdown.mjs`(신규)**: settings.json 시드 패치 + env 변수로 설정 A/B 빈 창 private WS 를 1분 내 격리 측정. `--single-boot`(캐시 없는 콜드) / warm-up→measure 2단계(캐시 웜) 모두 지원.
- **주범 분해(메인 프로세스 private WS, 웜 기준)**: adblock(standard 4리스트) **≈107MB** · sql.js(북마크+이력) **≈6MB** · electron-chrome-extensions(0개 설치) **≈0MB** · webtorrent **0MB**(lazy 확인) · Electron/Node/V8+나머지 모듈 바닥 **≈53MB**. 합산이 실측 웜 baseline(166MB)과 일치.
- **핵심 발견**: `perf-measure.mjs` 콜드런 3회가 adblock 1500ms 지연 타이머보다 먼저 끝나는 경우가 잦아, 뒤이은 long-session 이 "캐시 없는 콜드 빌드"(설치 후 첫 실행 시나리오)를 측정하게 됨. 실사용자 대다수인 "2번째 이후 실행"(캐시 웜)은 훨씬 가벼움 — 동일 코드에서 콜드 317MB vs 웜 253MB(개선 전), **65MB 차이**가 순전히 캐시 상태 때문.
- **fix**: `gc-nudge.ts`(신규) — adblock 콜드 빌드 직후 + 부팅 시퀀스 완료 후 1회씩 V8 GC 강제(런타임 `--expose-gc` 트릭). cross-fetch → 네이티브 fetch 우선(전 코드베이스 기존 패턴과 통일). **필터·차단 동작 100% 동일** — adblock 자체는 불변.
- **개선 효과**: 콜드(첫 실행) 총 317→**285MB**(-32MB). 웜(2번째 이후) 총 253→**226MB**(-27MB, **250MB 예산 통과**). 공식 하네스 재측정도 311→290MB(-21MB, 콜드 경로 편향으로 여전히 표면 FAIL).
- **예산 현실화 권고**: adblock 필터 엔진(콕콕 핵심, 축소 금지) 자체가 웜 상태에서도 main 프로세스 ≈107MB 고정비용 — 콜드 첫 실행에서 250MB 미만은 물리적으로 불가. 웜/steady-state 는 226MB로 통과. 권고: 예산을 콜드 300MB/웜 250MB 두 트랙으로 분리하거나 확장 예외 조항과 동일 논리로 adblock standard+ 에도 완화 조항 부여.
- **검증**: typecheck 3/3 · win --dir 패키징 · **스모크 16/16 유지**(adblock 차단 S10·R13 포함, 기능 회귀 없음) · 콜드 스타트/idle CPU/외피 gzip 불변(PASS 유지).
- **다음**: ① `perf-measure.mjs` 콜드런 타이밍 보정(매 측정이 웜 경로를 안정적으로 재현하도록), ② 예산 현실화 정책 확정, ③ 확장 호환 매트릭스 10종(게이트 5), ④ 다운로드 매트릭스 나머지.

### 2026-07-11 — 검증 라운드 V3: 50탭 스트레스 + 세션 강제 kill 복원 (게이트 3 통과 + 데이터 손실 버그 #17 fix)
- **운용**: Fable 5 지휘관 + Sonnet 워커 3(스트레스 하네스 / 복원 하네스 / #17 fix+통합). 워커 2명은 서로 다른 프로필·포트로 병렬(PID 스코프 kill 로 상호 간섭 차단).
- **게이트 3 안정성 통과**: `build/stress-cdp.mjs`(신규, 로컬 부하 페이지 서버 포함) — 50탭 개장 + 3회 순회(활성화 150회) + 워크스페이스 3개 라운드로빈 10회 + 대량 닫기. **크래시 0 · 먹통 0 · 워크스페이스 격리 breach 0 · 에러 로그 0**. 메모리 누수 **회수됨**(58탭→2탭 닫으면 프로세스 62→6, 최종 RSS baseline 대비 +14%, 프로세스/탭 회계 정확).
- **세션 복원 실증**: `build/session-restore-cdp.mjs`(신규) — 8탭+그룹+분할+스크롤(4000px)+폼 셋업 → `taskkill /F` 진짜 비정상 종료(before-quit 미실행·current.json 만 남음 확인) → 재기동 자동 복원. **스크롤 위치·폼 입력값·탭 그룹·분할 화면 전부 완벽 복원**(Chromium `NavigationEntry.pageState` 재생).
- **회귀 #17 (세션 복원 첫 탭 데이터 손실, 실질 손실)**: 복원 시 창의 첫 탭(index 0)이 활성/핀 아니고 eager-tail(마지막 5개) 밖이면 콘텐츠를 `about:blank` 로 잃음(탭 6개↑ 흔한 시나리오, 3회 재현). 원인: `createTab` 이 discarded(잠자는)로 만든 첫 탭을 같은 함수에서 즉시 `activateTabInternal`(창에 활성 탭 없어 hadActive=false) → `loadURL('about:blank')`(슬립 예약)와 `restoreNavigation`(undiscard)이 같은 tick 경합 → about:blank 커밋. **fix**: 자동 활성화 조건에 `&& !canDiscard` 추가(잠자는 탭은 같은 호출에서 안 깨움) + restoreSnapshot 방어 폴백(active 탭 0인 이상 스냅샷 대비). 수정 후 복원 하네스 **17/17 PASS**(T0 원본 URL·discarded 슬립 정상), 스모크 **16/16 유지**.
- **성능 부채 관측(게이트 4 이월)**: 탭당 WorkingSet ~100MB(예산 ≤80MB 초과), baseline WorkingSet 612MB(예산 ≤250MB 초과). **단 `browser://memory` 는 `workingSetSize`(공유 페이지 중복 집계)라 과대평가** — private RSS 정밀 측정·프로세스 정책은 라운드 4에서. 탭 슬립 회수 ~5MB/탭(about:blank 방식 문서화된 한계 재확인).
- **검증**: typecheck 3/3 · build · win --dir · 스트레스 클린 · 복원 17/17 · 스모크 16/16.
- **다음**: ① **라운드 4 = 성능 게이트**(private RSS 측정 + 콜드 스타트 + process-per-site 정책 조사 — 1원칙 #1 실측), ② 확장 호환 매트릭스 10종(게이트 5).

### 2026-07-11 — 검증 라운드 V2: 시크릿 창 구현 + 다운로드 가속 심각 버그 fix + S5/S6 하네스 (스모크 16/16)
- **운용**: Fable 5 지휘관(설계·근본원인 재검증·스크린샷 판독) + Sonnet 워커 3(시크릿 창 / S5·S6 하네스 / 다운로드 fix+통합).
- **스모크 전 시나리오 PASS**: **16 PASS / 0 FAIL / 0 SKIP / 0 MISSING-FEATURE** (2회 재현). V1 의 13개 + S5(다운로드) + S6(동영상) + S12(시크릿) 모두 실구현·통과.
- **시크릿 창 구현** (깨진 약속 해소 — V1 발견): `action.window.incognito`(Ctrl+Shift+N) 등록 → in-memory `incognito-N` partition 창. 기록 미저장 4지점(방문기록·closedStack·비밀번호 저장제안 신규 추가 / 세션 스냅샷 제외는 기존). session-bootstrap 안전망이 새 partition 자동 커버(회귀 #11/#12 재발 없음). 외피 🕶 시크릿 배지 + 타이틀 "(시크릿)". CDP localStorage 격리 + OS 스크린샷 육안 검증 합격.
- **회귀 #16 (다운로드 가속 + Range 미지원 서버 = 100% 영구 멈춤, 심각·실사용 빈발)**: 가속 기본 ON 상태에서 `Accept-Ranges` 없는 서버는 다운로드가 100%에서 영원히 멈추고 **파일이 저장 안 됨**. 격리 재현(1MB·20MB 결정적). 근본원인: `will-download` 가 `item.pause()` 즉시 호출 후 비동기 probe 의 then/catch 안에서 늦게 `setSavePath`+`resume` → Electron 이 이 early-pause→late-async-resume 에서 `done` 미발생. **fix**: 가속 불가 판정 시 검증된 우회로 재사용 — `rerouteToStandardDownload`(item.cancel → managedNonAccelUrls/pendingAuthByUrl 마킹 → `ses.downloadURL` 재요청) 로 will-download 재진입시켜 **동기 setSavePath 표준 추적 경로**로 흘림. 부팅 로그로는 안 잡히는 부류 — 하네스가 아니었으면 계속 묻혀 있었을 버그.
- **S5/S6 결정적 하네스**: `build/smoke-media-server.mjs`(신규) 로컬 HTTP 서버 — Range 지원/미지원 파일 + mp4 스텁. S5 는 다운로드 후 **바이트 단위 비교**(가속 병합 손상 검출), S6 는 동영상 감지 + yt-dlp 없는 직접 mp4 다운로드.
- **검증**: typecheck 3/3 · build(외피 gzip ~72.7KB) · win --dir 패키징 · 스모크 16/16 2회. Downloads 잔재 0.
- **다음**: ① 50탭 장시간 스트레스(게이트 3), ② 확장 호환 매트릭스 10종(게이트 5), ③ 다운로드 매트릭스 나머지(토큰CDN·HLS·이어받기), ④ 죽은 CSS(`.video-popover-backdrop` 등) 정리.

### 2026-07-11 — 검증 라운드 V1: CDP 스모크 하네스 + z-order 오버레이 일괄 fix (Phase 1 진입)
- **운용**: Fable 5 지휘관(설계·스크린샷 판독·최종 판정) + Sonnet 워커 4명(게이트 0 / 하네스 제작 / z-order 수정 / 잔여 배선+회귀 확장).
- **게이트 0 통과**: typecheck 0 · build(외피 gzip 72.7KB, 예산의 15%) · NSIS 패키징 · 부팅 5프로세스 로그 clean.
- **상시 스모크 하네스 신설** (`build/smoke-cdp.mjs`): CDP `Runtime.evaluate` 로 외피 `window.browserAPI` 직접 구동 + OS 합성 스크린샷(z-order 검증용). 격리 프로필(`--user-data-dir` 앱 지원 신설, `app/main/bootstrap-userdata.ts`), 우아한 종료(CDP `Browser.close` → 비정상 종료 마커 없음), PID 스코프 kill(사용자 실사용 인스턴스 보호). **최종 13 PASS / 0 FAIL / 2 SKIP(S5 다운로드·S6 동영상 — 다음 라운드) / 1 MISSING-FEATURE.**
- **z-order 오버레이 버그 일괄 fix (7/9 미확정 → 스크린샷 확증 → 수정 → 재검증)**: 외피 body 불투명 + 승격 목록 누락으로 Toast·QR모달·비밀번호배너·탭 컨텍스트메뉴·호버 미리보기·북마크바 드롭다운·워크스페이스 메뉴·확장 메뉴·업데이트배너·다운로드 배지가 콘텐츠에 가려짐(찾기바는 페이지를 가린 채 열림). **수정**: chrome view `setBackgroundColor('#00000000')` + body transparent + `useChromeOverlay` 참조 카운터 훅으로 승격 일반화 — 승격 중에도 콘텐츠가 비쳐 보임. OS 스크린샷 5종으로 지휘관 판독 합격.
- **회귀 게이트 2 자동화**: S9(워크스페이스 격리) · R11/R12(새 partition 의 browser:// 정상 로드) · R13(워크스페이스 partition adblock) 하네스 시나리오 추가 — 전부 PASS. #1/#3/#4/#7/#8/#9 는 부팅+스모크가 암묵 커버.
- **발견 — 시크릿 창 미구현 확정(MISSING-FEATURE)**: `Ctrl+Shift+N` 키맵·ko/en 라벨·`incognitoPartition()` 헬퍼는 있으나 `register-defaults.ts` 에 액션 미등록 → 무반응. 구현 라운드 필요.
- **다음**: ① 시크릿 창 구현, ② S5/S6(다운로드·동영상) 하네스 시나리오, ③ 50탭 스트레스(게이트 3), ④ 확장 호환 매트릭스(게이트 5).

### 2026-06-21 — 출시 마감 라운드 2: 브랜드 에셋 적용 (Phase 2 완성)
- 사용자가 `resources/brand/`에 21개 이미지 제작·제공 → 전부 적용.
- **앱 아이콘**: 깃털 아이콘 채택 → `gen-icon.mjs`가 `resources/brand/icon-1024.png` 있으면 사용하도록 개선(placeholder는 폴백). `build/icon.png`·`resources/icon.png` 반영 → 인스톨러·exe 아이콘 적용 확인.
- **온보딩 일러스트 5종** → `browser://welcome` 각 단계 상단. **빈 상태 일러스트 4종** → newtab/bookmarks/history/downloads. **마스코트**(파란 깃털 새) → welcome. **파비콘 폴백**(글로브) → TabBar(파비콘 없는 사이트).
- **인프라 2건**: ① `handleBrowserUrl` 확장 — browser:// 페이지가 폴더 내 정적 자산(png/css/js) 서빙(traversal 가드). ② `electron-builder.yml`에 `!resources/brand/**` — 원본 마스터 31MB 패키지 제외(가벼움).
- **이미지 최적화**: `build/optimize-assets.mjs`(Electron nativeImage)로 표시 크기 축소 — 온보딩 5×~410KB, 빈상태 4×~130KB, 마스코트 111KB, 파비콘 7KB(총 ~2.8MB만 번들에). `npm run gen:assets` 등록.
- **검증**: typecheck 0 · build · **패키지 `ezBrowser-0.1.0-win-x64.exe`(97.4MB, brand 마스터 제외 확인)** · 패키지 부팅 3프로세스·browser:// 정상(asset-serving 회귀 없음). **Phase 2(제품 정체성) 완성** — 이름·아이콘·일러스트 확정.
- **남은 출시 차단**: 코드 서명 인증서 · 자동업데이트 `owner` 실값(둘 다 사용자 제공 필요).

### 2026-06-21 — 출시 마감 라운드 1: 데이터 이주 + 온보딩 + 신뢰 문서 (Phase 3·5)
- **게이트 0 baseline**: typecheck 0 에러 · build 성공(renderer 228KB/gzip 72KB, 예산의 14%) · 메인 부팅 7초 alive 크래시 0.
- **데이터 가져오기** (`features/import`): 크롬·엣지·Brave·웨일 프로필 자동 탐지 → 북마크(Bookmarks JSON 트리 재구성) + 방문기록(History SQLite를 임시 복사 후 sql.js로 읽어 UPSERT 병합, Chrome 마이크로초 시각 변환). 렌더러엔 경로 비노출(IPC가 id만 받아 재탐지). `import:sources`/`import:run` + `onboarding:set-default-browser`/`complete` IPC, `isTrustedSender` 가드.
- **온보딩**: 기존 4단계 welcome에 **데이터 가져오기 단계 삽입(5단계)** — 소스 선택·북마크/기록 토글·결과 표시. 기존 검색·테마·기능·단축키 단계 보존.
- **설정 진입점**: 데이터 관리에 "다른 브라우저에서 가져오기"(스캔→프로필별 가져오기), 정보에 개인정보·라이선스 링크.
- **신뢰 문서**: `browser://privacy`(무엇을 수집/전송하는가 정직한 표 — 로컬 우선·수집 0), `browser://licenses`(345개 OSS 패키지 + 핵심 엔진, `system:licenses` IPC로 oss-licenses.json 서빙, 검색 가능).
- **i18n**: 누락돼 있던 `build/i18n-check.mjs` 작성(중첩 키 재귀 비교) + en.json 10키 채움 → **ko/en 70키 완전 일치**.
- **제품명 확정 → ezBrowser**: 사용자 결정으로 BrowserBuild → **ezBrowser** 일괄 리네임. 변경: `constants.ts APP_NAME`·renderer title·locales app.name·electron-builder.yml(productName·appId `com.ezbrowser.app`·publisherName·shortcutName)·welcome/settings/privacy/licenses 표시 문자열·window title·북마크 export 주석·스크린샷 폴더. 내부 키(`browserbuild.*` localStorage·드래그 MIME)는 유지(데이터 호환). 리네임 후 typecheck 0·i18n 70키·build·부팅(`[adblock] all sessions`, 크래시 0) 전부 통과.
- **자동 업데이트 저장소**: 사용자 "이미 연동"이라 했으나 browser-build 에 로컬 git remote 가 없어 owner 자동 확인 불가. `electron-builder.yml`은 `repo: browser-build` 유지, `owner: REPLACE_GH_OWNER` 그대로 둠 → **실제 owner 값만 채우면 자동 업데이트 동작**(실연결 미완 항목으로 유지).
- **출시 파이프라인 실증**: `npm run package:win` 성공 → **`dist/ezBrowser-0.1.0-win-x64.exe`(92.9MB) NSIS 인스톨러** + `win-unpacked/ezBrowser.exe` 생성. 패키지 부팅 시 3 프로세스·창 제목 "지난 세션 복원"(세션 복원 동작). 서명만 인증서 부재로 skip(미서명 빌드, 예상된 경로).
- **보안 게이트 6 자가점검**: 두 webPreferences(외피·콘텐츠 뷰) 모두 sandbox/contextIsolation/nodeIntegration=false/webSecurity 강제(R2-1), 신규 IPC(import·onboarding·licenses) 전부 isTrustedSender 가드(R2-3).
- **검증 종합**: 게이트 0(typecheck·build·부팅) + 게이트 6(보안) + 게이트 7 일부(i18n·privacy·licenses) + 패키징 전부 통과. 크래시 0.
- **다음(사용자 입력/GUI 필요)**: ① 앱 아이콘·브랜드 컬러 확정(디자인 결정), ② `electron-builder.yml` `owner` 실값 + 코드 서명 인증서(CSC_LINK), ③ Phase 1 안정성(50탭 8시간 스트레스 — GUI), ④ Phase 4 확장 호환·다운로드 매트릭스(GUI).

### 2026-06-21 — 문서 체계 수립 (Phase 0)
- goal.md / plan.md / status.md / rules.md / test.md 신규 작성. 출시 관점에서 현재를 진단: **기능 완성 ↔ 출시 미비**의 간극 명시.
- 앞으로 모든 라운드는 test.md 게이트 통과 후 여기 "완료" 기록. CLAUDE.md 변경이력은 구현 정본, status.md는 출시 진척 정본으로 역할 분리.
- 다음: 스모크 테스트 baseline 확정.

> 이전 구현 라운드(묶음 A~FF)는 [CLAUDE.md](CLAUDE.md) "변경 이력" 참조.
