# rules.md — 절대 건드리면 안 되는 것

> **이 문서의 규칙은 협상 대상이 아니다.** 기능을 추가하다 이 규칙과 충돌하면, **기능을 포기하거나 다른 방법을 찾는다.** 규칙을 깨지 않는다.
> 규칙을 바꿔야 한다고 판단되면, 코드를 고치기 전에 **사용자에게 명시적으로 확인**받는다.
> 목적지 [goal.md](goal.md) · 경로 [plan.md](plan.md) · 현황 [status.md](status.md) · 합격 [test.md](test.md).

---

## 0. 메타 규칙

- **R0-1.** 이 5문서(goal/plan/status/rules/test)는 작업의 운영체제다. 라운드를 끝낼 때 **status.md를 갱신**하고, 새 기능은 **test.md 게이트를 통과**해야 "완료"다.
- **R0-2.** 회귀를 고칠 때마다 그 회귀의 **재현 시나리오를 test.md에 추가**한다. 같은 회귀가 두 번 나면 안 된다 (이미 #1~#14 발생 — 더 늘리지 않는다).
- **R0-3.** 사용자용 모든 문서·보고서·가이드는 **한국어**로 작성한다.

---

## 1. 4원칙 — 동시에 만족 (CLAUDE.md 미션)

> 하나라도 깨면 이 제품이 아니다.

- **R1-1. 가볍다.** 빈 창 RSS ≤ 250MB, 콜드 스타트 ≤ 2초, 외피 초기 JS ≤ 500KB gzip. 새 기능은 **lazy load**가 기본, 끄면 메모리·CPU 0.
- **R1-2. 크롬 확장이 그대로 붙는다.** 확장 호환 레이어를 약화시키는 변경 금지.
- **R1-3. 콕콕처럼 기본이 쓸 만하다.** 14종 기본 기능을 비활성·퇴화시키지 않는다 (끄는 토글은 OK, 기본 ON 유지).
- **R1-4. 그 어떤 브라우저보다 자유롭다.** 아래 자유도 7축은 **절대 약화 금지**: userChrome(css/js)·userscript·명령팔레트·워크스페이스·레이아웃 자유·키맵 100% 재바인딩·정책 엔진.

---

## 2. 보안 기본값 — 약화 절대 금지

> 변경하려면 `security-auditor` 검토 + 사용자 승인. 임의 완화 금지.

- **R2-1.** 모든 콘텐츠 `webPreferences`는 다음을 **강제**:
  ```ts
  sandbox: true, contextIsolation: true, nodeIntegration: false,
  webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false
  ```
- **R2-2.** preload는 `contextBridge.exposeInMainWorld(...)`로만 노출. `ipcRenderer`를 **직접 노출 금지**.
- **R2-3.** 민감 IPC 핸들러(설정·키맵·워크스페이스·비밀번호·내부페이지 API)는 **`isTrustedSender`로 sender URL 검증** (browser:/file:/devtools:/localhost만). 외부 사이트가 internalAPI 채널을 시도해도 거부.
- **R2-4.** 비밀번호는 **safeStorage 암호문**으로만 디스크에 저장. 평문 영구 보존 0. content.js는 origin을 main에 보내지 않고, **main이 sender URL에서 origin을 유도**한다 (변조 차단).
- **R2-5.** `will-navigate`는 허용 스킴(http/https/file/browser/devtools/chrome-extension/about/data/blob) 외 `preventDefault()`. 알 수 없는 스킴을 OS에 위임하지 않는다 (회귀 #10/#11 패턴).
- **R2-6.** 권한 핸들러는 화이트리스트 기본 + 정책/사이트 오버라이드. 무조건 allow 금지.

---

## 3. 아키텍처 불변

- **R3-1. 렌더링·V8·네트워크 스택은 Electron 제공분 그대로 사용.** 자체 엔진 만들지 않는다.
- **R3-2. 모든 탭 = 별도 `WebContentsView`.** 옛 `BrowserView`는 **deprecated — 사용 금지** (`webcontents-view-pattern` 스킬 준수).
- **R3-3. 메인 프로세스만 Node 권한.** 콘텐츠 렌더러는 권한 없음.
- **R3-4. 사용자 데이터는 `app.getPath('userData')` 아래** SQLite(sql.js WASM) + JSON(electron-store). 시크릿은 메모리만.
- **R3-5. IPC 채널 명명은 `domain:action`** (`tabs:create`). 단일 출처는 `ipc-channels.ts`.
- **R3-6. 키맵 단일 출처는 `app/shared/keymap`.** 모든 액션은 `actionId`를 가진다. 변경 시 메뉴·accelerator 동기.

---

## 4. 세션/Partition 불변 — 회귀 #5·#11·#12·#13·#14의 교훈

> **새로운 partition(세션)을 도입할 때마다, 모든 session-level 핸들러를 install해야 한다.** 이것을 어겨 같은 회귀가 5번 났다. 다시 내면 안 된다.

- **R4-1.** `browser://` protocol·권한 핸들러·webRequest 후킹(adblock·policy·response-hooks·will-download)은 **모든 partition에 적용**되어야 한다. 한 세션에만 등록하면 다른 워크스페이스/탭 세션에서 깨진다.
- **R4-2.** 새 세션 기능은 **반드시 `session-bootstrap`의 `addSessionInitHook`을 통해** 등록한다. 개별 세션에 직접 등록하는 분산 방식 금지.
- **R4-3.** `session.defaultSession !== session.fromPartition('persist:default')` (Electron 35). 둘은 다르다. 탭은 명명 세션을 쓴다 — defaultSession에만 걸면 페이지에 적용 안 된다.
- **R4-4.** 다운로드/가속 다운로더는 **다운로드를 발생시킨 세션(탭 세션)**을 사용한다. defaultSession으로 받으면 쿠키 게이트 CDN에서 인증 실패(회귀 #14).

---

## 5. 데이터·복원 불변

- **R5-1.** 세션 스냅샷 쓰기는 **원자적**(tmp + rename). 부분 기록으로 손상시키지 않는다.
- **R5-2.** 세션 스냅샷 스키마 변경 시 **하위호환**(새 필드 optional, 구 스냅샷 복원 보장). 깨면 사용자의 열린 탭이 날아간다.
- **R5-3.** 종료 시(`before-quit`) 진행 중 다운로드 pending·쿠키·스토리지를 **flush**한다. `quitting` 플래그로 자식 프로세스 강제 종료가 pending을 지우지 못하게 한다(이어받기 보존).
- **R5-4.** 데이터 가져오기(import)는 **화이트리스트 + path traversal 차단**(`..`·절대경로 거부).

---

## 6. 빌드·품질 게이트 (test.md가 판정)

- **R6-1.** `tsc --noEmit` 무경고 (main/preload/renderer 각각). 경고 있는 채로 "완료" 금지.
- **R6-2.** `npm run build` + 패키징 성공. **패키징 전 실행 중 `BrowserBuild.exe` 종료**(`Stop-Process -Name BrowserBuild -Force`).
- **R6-3.** 가벼움 예산(R1-1) 위반 시 머지 금지.
- **R6-4.** 보안 체크리스트(`electron-secure-defaults` / `/test-safety`) 전부 통과.
- **R6-5.** 디버그 잔재(콘솔 배너·진단 외곽선·임시 로거)는 라운드 종료 전 **제거**한다.

---

## 7. 출시 불변

- **R7-1.** OSS 라이선스 고지 의무(Electron MIT + Chromium 등)를 지킨다. 배포 전 `browser://licenses` 갱신.
- **R7-2.** 기본 동작은 **로컬·수집 0**. 외부 전송은 검색 제안·번역·위젯·업데이트 체크에 한하며, 무엇을 보내는지 문서화한다.
- **R7-3.** 자동 업데이트 채널(latest/beta/nightly)을 분리하고, 사용자 동의 없이 강제 설치하지 않는다.

---

## 8. 환경 함정 (반복 실수 방지)

- **R8-1.** 셸에 `ELECTRON_RUN_AS_NODE=1`이 있으면 Electron이 Node로 떠서 부팅 panic. 실행 전 해제.
- **R8-2.** 개발/배포 판정은 **명시 ENV**(`VITE_DEV_SERVER_URL`/`BROWSERBUILD_DEV`)로. `!app.isPackaged`만 믿지 않는다(회귀 #3).
- **R8-3.** 빌드 산출물 경로는 `app/dist/{main,preload,renderer}` 단일 트리. `__dirname` 기준 상대경로 계산 시 깊이 주의(회귀 #4/#8).
- **R8-4.** sandbox preload는 `require` 불가 → preload는 **esbuild 번들**로 빌드(회귀 #9).

---

> **요약:** 가벼움·확장호환·콕콕기본·자유도(4원칙) + 보안기본값 + WebContentsView + 전-partition 세션 일관성 + 원자적 복원 — 이 7개는 **무슨 일이 있어도 지킨다.** 나머지는 협상 가능, 이건 아니다.
