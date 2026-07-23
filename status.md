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
| 빌드 | ✅ 통과 (외피 JS ~205KB / gzip ~65KB — 예산 500KB의 13%) |
| 부팅 | ✅ packaged 5+ 프로세스 정상, 로그 clean |
| 기능 완성도 | 🟢 **높음** — 콕콕 14종 + 자유도 12모듈 + 다운로드 엔진 + 세션 복원 + 탭 그룹 |
| **출시 준비도** | 🔴 **낮음** — 미서명·미배포·온보딩 없음·데이터 가져오기 없음 |
| 실사용 검증 | 🟡 **부분** — 부팅·개별 기능은 확인, 장시간·매트릭스·외부환경 미검증 |

**핵심 진단: "기능은 다 됐는데, 아직 아무도 설치할 수 없다."** 간극은 *기능*이 아니라 *출시·검증·첫인상*에 있다.

---

## 현재 Phase: **Phase 3 진입 (첫인상 & 이주) — Phase 0·일부 Phase 5 완료**

- [x] goal/plan/status/rules/test 5문서 작성
- [x] 게이트 0 baseline 실측: typecheck 0 · build 성공(renderer gzip 72KB) · 부팅 7s alive 크래시 0
- [x] **크롬/엣지/Brave/웨일 데이터 가져오기** (북마크 JSON + 방문기록 SQLite) 구현
- [x] **온보딩 마법사에 가져오기 단계 통합** (browser://welcome 5단계로 확장)
- [x] **개인정보 처리방침**(browser://privacy) + **OSS 라이선스 페이지**(browser://licenses, 345개 패키지)
- [x] **i18n 정합성**: 점검 스크립트 작성 + en 누락 10키 채움 → ko/en 70키 일치
- [ ] 제품 정체성(이름·아이콘) 사용자 확정 ← **다음(사용자 결정 필요)**
- [ ] 코드 서명 + 자동 업데이트 저장소 연결 (Phase 2 잔여)

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
- **코드 서명** — Windows 미서명 (SmartScreen 경고 발생)
- **온보딩** — 첫 실행 환영/소개/기본브라우저 유도 화면 없음
- **데이터 가져오기** — 크롬/엣지 북마크·비밀번호·기록·탭 import 없음
- **제품 정체성** — 이름 "BrowserBuild"(임시)·기본 Electron 아이콘·브랜드 컬러 미확정
- **개인정보 처리방침 / 배포 채널 / 랜딩** — 없음
- **외부 환경 검증** — 깨끗한 Windows에서 설치·실행 테스트 안 함

---

## 알려진 위험 / 부채

- **세션 불일치 회귀 계열(#5·#11·#12·#13·#14)**: 새 partition 도입 때마다 재발했음. session-bootstrap hook으로 통합됐으나, **앞으로 새 세션 기능 추가 시 반드시 전 partition 적용 확인** (rules.md 명문화).
- **policy ↔ adblock onHeadersReceived 통합 디스패처 부재**: 보통 무해(정책 룰 비어있음)하나 잠재 충돌. Phase 4~5에서 통합 검토.
- **빌드 함정**: 패키징 전 실행 중인 `BrowserBuild.exe` 종료 필수(`Stop-Process -Name BrowserBuild -Force`) — 안 하면 `Access is denied`로 stale exe.
- **better-sqlite3 → sql.js(WASM)**: 네이티브 toolchain 회피로 sql.js 사용 중. 성능 한계 시 재검토.
- **HLS live 미지원 / DASH 네이티브는 muxed만**(분리 음성은 yt-dlp).

---

## 다음 행동 (구체적으로)

1. **test.md 스모크 테스트 완주** — dev 부팅 → 탭/검색/북마크/다운로드/설정 한 바퀴 → 로그 에러 0 확인 → 결과를 아래 "최근 라운드"에 기록
2. 그 결과로 Phase 1(안정성) 첫 작업 = **50탭 장시간 스트레스 + 에러 로그 0** 착수
3. 병행 가능: **제품 이름·아이콘 후보**(Phase 2) 사용자 의사결정 받기

---

## 최근 라운드 로그 (최신이 위)

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
