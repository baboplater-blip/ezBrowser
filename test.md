# test.md — 제대로 끝났는지 어떻게 확인하는가

> 이 문서는 **합격 판정기**다. 어떤 라운드든 여기 게이트를 통과해야 [status.md](status.md)에 "완료"로 적힌다.
> 목적지 [goal.md](goal.md) · 경로 [plan.md](plan.md) · 제약 [rules.md](rules.md).
> 환경: Windows, PowerShell. 패키징 전 항상 `Stop-Process -Name BrowserBuild -Force` (R6-2).

---

## 게이트 0 — 매 라운드 필수 (이걸 안 통과하면 "완료" 아님)

```powershell
# 1) 타입체크 — 무경고여야 함 (R6-1)
npm run typecheck            # main / preload / renderer 각각 0 에러

# 2) 빌드 — 성공해야 함 (R6-2)
npm run build                # tokens → icon → renderer → main → preload

# 3) 부팅 — dev 또는 packaged, 로그 clean
npm run dev                  # 또는 npm run package:win 후 win-unpacked 실행
```

**합격 기준**
- [ ] tsc 3개 프로젝트 모두 0 에러
- [ ] build 성공, 외피 JS gzip ≤ 500KB (R1-1)
- [ ] 부팅 시 5+ 프로세스, 콘솔에 `[adblock] initialized` 정상, **uncaught/unhandledRejection/preload-error/did-fail-load 에러 0**
- [ ] 디버그 잔재 없음 (R6-5)

---

## 게이트 1 — 스모크 테스트 (핵심 동작 한 바퀴)

> 부팅 후 손으로 또는 자동화로 한 바퀴. 하나라도 깨지면 회귀.

| # | 시나리오 | 합격 |
|---|----------|------|
| S1 | 새 탭 → 주소창에 검색어 → 검색엔진 라우팅 | 결과 페이지 정상 |
| S2 | URL 입력 → 페이지 로드 → 뒤로/앞으로 | 내비게이션 정상 |
| S3 | Ctrl+T/W/Tab, 드래그 재정렬, 핀 | 탭 조작 정상 |
| S4 | Ctrl+D 북마크 → 북마크바/사이드패널 표시 | 별 토글 + 동기 |
| S5 | 페이지에서 다운로드 → 진행률·완료 알림 | 받아짐 + 토스트/알림 |
| S6 | 동영상 사이트 → 툴바 ▶ → 다운로드 | mp4/HLS 받아짐 (HTML 아님) |
| S7 | Ctrl+, 설정 → 토글 변경 → 다른 창 반영 | 다중 창 동기 |
| S8 | Ctrl+Shift+P 명령팔레트 → 액션 실행 | 퍼지/초성 검색 동작 |
| S9 | 워크스페이스 전환 → 탭 격리 | 세션 분리 유지 |
| S10 | 광고 많은 사이트 방문 | 광고 차단됨 |
| S11 | 다크모드 토글(Ctrl+Shift+D) | 페이지 강제 다크 |
| S12 | 시크릿 창(Ctrl+Shift+N) | 분리 세션 |

**합격:** 12개 전부 통과 + 게이트 0 에러 0.

---

## 게이트 2 — 회귀 재현 테스트 (절대 재발 금지, R0-2)

> 각 회귀의 **재현 시나리오**로 다시 깨지지 않았는지 확인. 새 회귀는 여기에 추가한다.

| 회귀 | 재현 시나리오 | 합격 = |
|------|--------------|--------|
| #1 탭 리스트 미수신 | 부팅 후 탭 목록이 외피에 보임 | 탭바 표시됨 |
| #3 isDev 오판 | packaged 빌드 직접 실행 | localhost 요청 안 함 |
| #4/#8 경로 깊이 | packaged 부팅 | renderer/preload 로드됨(흰화면 아님) |
| #7 검색창 실종 | 부팅 | omnibox·탭바 보임 |
| #9 sandbox preload | packaged 부팅 | preload-error 없음 |
| #10/#11/#12 browser 링크 | 새 워크스페이스 생성 → newtab | OS "링크 여세요" 다이얼로그 **안 뜸** |
| #5/#13 adblock 세션 | 워크스페이스별 탭에서 광고 사이트 | 모든 세션에서 차단됨 |
| #14 다운로드 세션 | 쿠키 게이트 CDN 다운로드 | HTML 아닌 미디어 받아짐 |

**합격:** 8개 재현 시나리오 모두 회귀 없음.

---

## 게이트 3 — 안정성 (Phase 1)

```
50탭 열기 + 8시간 연속 + 워크스페이스 3개 전환 반복
```
- [ ] 크래시 0, 흰 화면 0, 먹통 0
- [ ] `browser://memory`에서 RSS 모니터 — 누수성 우상향 없음
- [ ] 작업관리자에서 강제 kill → 재시작 → **탭·그룹·분할·스크롤·폼 복원**
- [ ] 8시간 동안 로그 unhandled 에러 0

---

## 게이트 4 — 성능 예산 (R1-1, `/audit-perf`)

| 항목 | 한도 | 측정 |
|------|-----|------|
| 콜드 스타트 | ≤ 2.0s | `app.whenReady()`→`window.show()` 3회 평균 |
| 빈 창 RSS | ≤ 250MB | `browser://memory` newtab 1개 |
| 탭당 RSS 증가 | ≤ 80MB | about:blank 10탭 평균 |
| 외피 JS | ≤ 500KB gzip | vite `--report` |
| 휴식 CPU | ≤ 0.5% | 5분 idle 평균 |
| 백그라운드 슬립 | 30분 → discard | 슬립 후 RSS 재측정 (~5MB로 감소) |

**합격:** 전 항목 한도 내. 위반 시 머지 금지(R6-3).

---

## 게이트 5 — 약속 매트릭스 (Phase 4)

### 확장 호환 10종 (`chrome-extensions-bridge`)
uBlock Origin Lite · Dark Reader · Bitwarden · Vimium · JSON Viewer · Stylus · Tampermonkey · Save to Pocket · Wappalyzer · ColorZilla
- [ ] 각 .crx 로드 성공 + 기본 동작 1개 확인 → 결과표 기록

### 다운로드 11시나리오 (`/audit-download`)
progressive mp4 · 토큰CDN octet-stream · HLS 평문 · HLS fMP4 · HLS AES-128 · HLS master · DASH muxed · 지원호스트(yt-dlp) · blob/MSE · 쿠키게이트 · 재시작 이어받기
- [ ] 각 시나리오 "받힘/올바른 컨테이너" 확인. `node build/probe-download.mjs <url>`로 진단

### 콕콕 기본 14종 실사용
- [ ] adblock·동영상·토렌트·가속·번역·스크린샷·사이드패널·다크·리더·비밀번호·QR·빠른검색·제스처·새탭위젯 각 1회 실제 사이트

---

## 게이트 6 — 보안 (`/test-safety`, R2)

- [ ] 모든 webPreferences가 R2-1 값 강제 (sandbox·contextIsolation·webSecurity=true …)
- [ ] preload가 ipcRenderer 직접 노출 0
- [ ] 민감 IPC `isTrustedSender` 검증 (외부 사이트가 internalAPI 채널 호출 시 거부)
- [ ] will-navigate 알 수 없는 스킴 차단
- [ ] 모든 partition에 protocol·권한·webRequest 핸들러 적용(R4)
- [ ] 비밀번호 평문 디스크 저장 0 (safeStorage 암호문만)

---

## 게이트 7 — 출시 (Phase 2·5·6, goal Definition of Done)

- [ ] Windows 코드 서명된 인스톨러 (또는 평판 경로 + 안내)
- [ ] 자동 업데이트 실저장소 연결 → 실제 업데이트 수신 확인
- [ ] 깨끗한 Windows(외부 환경)에서 설치→실행→업데이트 한 바퀴
- [ ] 온보딩 + 크롬/엣지 데이터 가져오기 동작
- [ ] i18n 누락 0 (`npm run i18n:check`) — ko/en
- [ ] `browser://licenses` 최신 (`npm run licenses`)
- [ ] 개인정보 처리방침 + "무엇을 전송하는가" 문서 존재

---

## 판정 규칙

- **라운드 완료 = 게이트 0 + 그 라운드가 건드린 영역의 해당 게이트 통과.**
- **출시(v1.0) = 게이트 0~7 전부 + goal.md Definition of Done 전 항목.**
- 실패 항목은 status.md "알려진 위험"에 적고 plan.md에 작업으로 승격한다.
- **모든 검증 결과(통과/실패/수치)는 status.md "최근 라운드 로그"에 기록**한다. 기록 없는 검증은 안 한 것으로 친다.
