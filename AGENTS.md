# ezBrowser (browser-build) — 프로젝트 운영 지침

Chromium(Electron) 위에 외피·내장 기능·확장 호환·hackability 레이어를 직접 얹어 만드는 데스크톱 브라우저.

**이 파일의 범위** — 전역 규칙(자율·검증·보고·효율 기록·콘텐츠 읽기 제한)은 `C:/Users/molma/.codex/AGENTS.md`가
정본이며 여기서 **다시 쓰지 않는다**. auto-dev로 진행할 때의 지휘 규칙은 auto-dev 스킬(`C:/Users/molma/.agents/skills/auto-dev/SKILL.md`)이
정본이다. 이 파일에는 **이 프로젝트에서만 성립하는 제약**만 적는다. 충돌 시 우선순위는
시스템/개발자 지시 → 범위 안의 명시적 사용자 지시 → 이 파일 → 전역 지침.

auto-dev는 사용자나 프로젝트가 선택했을 때만 적용한다. Astra는 설계·중요 결정, Claude 실행층은 구현·문서·최종 통합 검증을 맡는다.
검증을 중복하지 않고 완료 결과로 판정한다. 이미 승인된 범위는 재승인 없이 진행하며, 세부 실행·대기 절차는 스킬을 따른다.

> 이전 판(2026-09-07까지의 383KB 사본)은 `docs/agent-guidance/AGENTS.before-2026-09-16.md`에 바이트 동일로 보존.
> 그 파일은 CLAUDE.md의 낡은 스냅샷이므로 **현재 사실의 근거로 쓰지 않는다.**

## 정본 — 숫자·버전은 여기서 읽는다

문서에 적힌 수치를 복사해 쓰지 말 것. 아래가 기계가 읽는 단일 출처이고, 문서는 설명일 뿐이다.

| 무엇 | 정본 |
|---|---|
| 런타임·의존성·스크립트 | `package.json` |
| 가벼움 예산 수치 | `app/shared/perf-budget.json` |
| 검증 단계 목록·제한시간 | `npm run verify:list` (`build/verify-all.mjs`가 등록부) |
| IPC 채널 이름 | `app/shared/ipc-channels.ts` |
| 단축키 기본 매핑 | `app/shared/keymap.default.json` + `app/main/keymap/keymap-service.ts` |
| i18n 문자열 | `app/shared/locales/{ko,en}.json` |
| 패키징·업데이트 채널 | `electron-builder.yml` |
| 구조·실행법·함정 정찰 지도 | `docs/auto-dev/RECON.md` |
| 라운드 이력(필요 구간만) | `CLAUDE.md` 변경 이력, `status.md` |

**스택 확인** — Electron·React·Vite의 현재 버전과 저장 라이브러리는 `package.json`에서 확인한다.
과거 문서에 남아 있는 `Electron 33`, `better-sqlite3`, `app/shared/keymap.ts`는 **현재 사실이 아니다.**
버전·경로를 단언하기 전에 위 정본을 연다. 판올림 경위는 `docs/electron-42-upgrade.md`.

**역사 자료 읽기** — `CLAUDE.md` 변경 이력과 `docs/run-reports/`, `perf-out/`, `verify-out/`, 스크린샷은 상시 로드 대상이 아니다.
필요한 라운드 구간만 골라 읽고, 작업자에게도 전체가 아니라 해당 구간·요약·경로만 전달한다.

## 제품 4원칙 — 넷을 동시에 만족해야 한다

1. **가볍다** — 빈 창 메모리·콜드 스타트 예산은 `perf-budget.json`.
2. **크롬 확장이 그대로 붙는다** — `.crx` 드래그, MV2/MV3 핵심 API.
3. **콕콕처럼 처음부터 쓸 만하다** — 광고차단·동영상/토렌트 다운로드·번역·스크린샷·사이드패널·다크모드·
   리더모드·비밀번호·QR·빠른검색·제스처·새탭위젯이 별도 확장 없이 기본 ON.
4. **그 어떤 브라우저보다 자유롭다** — UI·동작·정책·자동화·테마를 사용자가 재정의·재배치·스크립트로 후킹한다.

어떤 변경도 이 넷 중 하나를 다른 하나를 위해 깎지 않는다. 상충하면 멈추고 보고한다.

## 자유도 7축 — 절대 약화 금지

userChrome.css/js · Userscript(Tampermonkey 호환) · 명령 팔레트 · 워크스페이스 · 레이아웃 자유(탭바 방향·분할) ·
단축키 100% 재바인딩 · 사이트별 정책 엔진. 여기에 자동화 매크로 · 디자인 토큰 · 데이터 주권(export/import) ·
Mod API가 붙어 있다. **모든 모듈의 실제 위치는 `app/main/features/<name>/`이다** — 과거 문서의
`app/main/hackability/`는 존재하지 않는다.

- 모듈은 **설정에서 끌 수 있지만 기본은 ON**이고, **끄면 메모리·CPU도 0**이어야 한다(상시 초기화 금지, lazy load).
- 새 액션은 반드시 `actionId`를 갖고 keymap에서 재바인딩 가능해야 한다. 하드코딩 단축키를 만들지 않는다.
- 기본 기능을 추가할 때 토글을 같이 만들지 않으면 그 기능은 미완성이다.

## 아키텍처 경계

- **탭 컨테이너는 `WebContentsView`만 쓴다.** `BrowserView`는 deprecated이며 현재 소스에 하나도 없다 — 되살리지 않는다.
- 프로세스: 메인(1, Node 권한 보유) / 외피 렌더러(창마다 1) / 콘텐츠 `WebContentsView`(탭마다 1) / `browser://` 내부 페이지.
- 세션 partition: 기본 `persist:default`, 워크스페이스 `persist:ws-<id>`, 시크릿은 `persist:` 없는 **메모리 세션**.
- **새 partition을 도입하면 session 단위 핸들러(protocol·권한·webRequest·adblock·확장)를 전부 걸어야 한다.**
  등록은 `app/main/session-bootstrap.ts`의 훅 한 곳에서만 한다 — 이 규칙을 어겨 같은 계열 회귀가 네 번 났다.
- **한 세션의 `webRequest` 이벤트에는 리스너가 하나만 유효하다.** adblock·정책·확장 DNR·클라이언트 힌트는
  각자 등록하지 않고 기존 디스패처 안에서 팬아웃한다. 순서는 확장 DNR → 클라이언트 힌트 → 사용자 정책(사용자 룰이 최종).

## 보안 기본값 — 변경하려면 security-auditor 승인

모든 `webPreferences`는 아래를 강제한다(현재 `window-service.ts`·`tab-service.ts`·숨은 창 전부 준수).

```ts
{ sandbox: true, contextIsolation: true, nodeIntegration: false,
  webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false }
```

- preload는 `contextBridge.exposeInMainWorld`로만 노출한다 — `ipcRenderer` 직접 노출 금지.
  표면은 셋뿐: 외피 `browserAPI`(chrome.ts) / 내부 페이지 `internalAPI`(internal.ts) / 외부 사이트 `browserBuild`(content.ts).
  **외부 사이트 preload에 특권 API를 얹지 않는다.**
- 메인 IPC 핸들러는 `isTrustedSender`로 sender를 검증한다. preload 미노출은 1차 방어일 뿐 2차 방어를 대신하지 못한다.
- 외부에서 온 값(IPC·디스크 JSON·확장 manifest)은 **타입을 확인하고 받는다.** id가 파일명이 되는 경로는
  경로 이탈(`..`·절대경로·링크)을 저장·삭제 함수 자신에서 막는다.
- 내부 페이지 CSP는 `default-src 'self'` + 최소 예외. 알 수 없는 스킴은 OS에 위임하지 않고 무시한다.
- 데이터는 `app.getPath('userData')` 아래. 비밀번호·API 키는 `safeStorage`로만 저장하고 평문을 디스크에 남기지 않는다.
- **시크릿 창은 기록을 남기지 않는다** — 방문기록·closedStack·비밀번호 저장 제안·세션 스냅샷 4지점 모두 skip.
  시크릿 관련 변경 시 이 4지점을 함께 확인한다.
- 에이전트(AI) 자동 조작은 게이트(`app/main/features/ai/agent-gate.ts`)가 단일 판정처다. 돈·파괴·자격증명은
  확인을 요구하고, 무인 실행에서도 critical은 자동 승인하지 않는다. 정상 발행(블로그·SNS)을 막지 않는 오탐 0도 함께 지킨다.

## 확장 호환과 충돌

- 베이스는 `electron-chrome-extensions` + 자체 보강(`app/main/extensions/`). 우선 지원 API는
  MV3 service_worker → declarativeNetRequest → storage → tabs/windows/runtime/scripting → action/contextMenus/commands → webRequest(MV2 호환).
- 확장 ID는 **경로가 아니라 manifest `key`(CRX 서명 pubkey)에서 파생**되어야 한다. 경로 기반 ID는 설치 위치가
  바뀌면 툴바·팝업·제거가 전부 어긋난다.
- **자체 광고차단 ↔ 확장 광고차단 동시 활성** 시 사용자에게 한 번만 묻고 한쪽만 켠다.
- "로드 성공"은 동작 증거가 아니다. 차단기 계열은 **적용된 룰 수와 실제 차단 판정**까지 확인한다.

## 가벼움 예산 — 2축 판정

- **판정 1순위 = adblock 제외 빈 창 메모리**(`blankWindowNoAdblockMB`). 우리가 통제하는 코드의 회귀를 잡는 축이다.
- **총계(adblock 포함)는 참고·추세**다. 초과해도 실패로 보지 않되, 여유와 `그중 adblock N MB`를 함께 적어
  어느 쪽에서 늘었는지 보이게 한다. adblock 고정비가 빈 창의 40%대라 한 숫자로 합치면 회귀가 묻힌다.
- 예산 숫자를 올리기 전에 **왜 늘었는지부터 조사**한다. 완화는 측정 근거를 만든 뒤에만.
- 메모리 기여도는 **교대 실행 4회 이상 + 중앙값**으로만 말한다. 1~2표본 비교로 원인을 단정해 두 번 틀렸다.
  10MB 미만 항목은 부팅 간 비교로 분리되지 않는다 — 한 프로세스 안에서 증분을 재라.

## 개발 컨벤션

- **TypeScript strict**, main/renderer/preload tsconfig 분리. 타입 우회(`any` 캐스팅)로 게이트를 통과시키지 않는다.
- **IPC 채널은 `domain:action`**(`tabs:create`)이며 이름은 `ipc-channels.ts`가 정본. invoke 채널과 send 채널의
  이름을 겹치지 않게 한다.
- **i18n**: 사용자에게 보이는 문자열은 `ko`/`en` 동시 추가. 사용자 메시지는 한국어, 로그는 영문.
- **키맵**: 새 액션은 `actionId` 등록 + `keymap.default.json` 반영 + 충돌 검출 통과.
- 로그는 `electron-log`(userData/logs 회전). 사용자 오류는 콘텐츠 뷰 위 토스트로.
- 커밋은 한국어 conventional commits(`feat(tabs): ...`). 브랜치는 `auto-dev/<슬러그>` 계열.
- 외피에 새 fixed/absolute 오버레이를 추가하면 **반드시 `useChromeOverlay`에 배선**한다 — 안 하면 콘텐츠 뷰에 가려진다.
  도킹형(insets로 안 겹침)은 예외.

## 검증과 종결

- **코드 라운드 종결은 `npm run verify`**(게이트 0 + 스모크 + 순수함수 검사, 약 30초·창 1개).
- **`npm run verify:full`은 실제 창을 여러 번 띄우고 스트레스·성능 측정으로 화면을 오래 점유한다.**
  사용자가 요청할 때 · 자리를 비울 때 · 출시 전에만 돌린다. 단계 수와 제한시간은 `npm run verify:list`로 확인한다.
- **`status.md`의 `<!-- verify-all:begin -->` ~ `end` 구간은 러너가 자동 갱신한다 — 손으로 고치지 않는다.**
  사람은 라운드 로그에 해석·판단만 쓴다. 부분 실행(`--only`·`--skip-build`)은 기록되지 않는다.
- **돌리지 않은 것을 통과로 쓰지 않는다.** 산출물(결과 JSON·`app/dist`·`app.asar`)의 타임스탬프가 코드 수정보다
  이전이면 그것은 낡은 증거다 — 성공 주장과 결과 파일이 엇갈리면 시각부터 대조한다.
- 검사가 빨개지면 **기준을 완화하기 전에 원인을 제거**한다. 통제하지 못한 상태(앞 시나리오의 잔재, 포트 점유,
  좀비 프로세스)가 원인인 경우가 더 많다. 미구현 기능은 FAIL이 아니라 GAP으로 이유와 함께 남긴다.
- 억제를 검사할 때는 **양성 대조**(억제가 풀리면 다시 동작하는가)를 반드시 함께 둔다. "아무 일도 안 일어남"만
  보는 검사는 기능이 통째로 죽어도 통과한다.
- **하네스는 격리 프로필(`--user-data-dir`)로만 돈다.** 사용자 실프로필(`%APPDATA%/browser-build`)과
  실행 중인 사용자 인스턴스를 건드리지 않는다. 프로세스 정리는 이번 실행이 띄운 PID만 대상으로 한다.
- 문서만 바꾼 라운드는 앱을 실행하지 않는다 — 링크·원본 보존·규칙 누락 검토로 검증한다.

## 이 프로젝트의 함정

- **CDP 하네스**: 타깃이 `/json/list`에 보여도 명령을 받을 준비가 된 것이 아니다. 첫 명령은 짧은 타임아웃 +
  재시도 + 재연결로 감싼다(`build/lib/cdp.mjs`가 공통 구현).
- **패키징 전 실행 중인 앱을 확인**한다 — exe를 잠그면 `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`로 실패하고 산출물이 낡는다.
- **한글 정규식에 `\b`·`\w`를 쓰지 않는다** — 한글은 `\w`가 아니라 단어경계가 성립하지 않고, 영문 대안이
  함께 있으면 죽은 패턴이 조용히 통과한다. `npm run verify`의 `korean-regex`가 상시 검사한다.
- **여러 층을 거치는 문자열에 개행 이스케이프를 넣지 않는다**(패치 → 템플릿 리터럴 → CDP에서 실제 개행이 된다).
- `sandbox: true` preload는 `require`가 막히므로 esbuild 번들이 필요하다(`npm run build:preload`).
- 자동 일괄 편집 후에는 **선언 소실 감사**(최상위 심볼 집합 전후 비교)를 한다. 구문 검사는 선언이 사라져도 통과한다.

## 금지선

- 보안 기본값·자유도 7축·기본 기능 OFF 지원을 약화하는 변경.
- 전역 설정·권한·자격증명·훅 변경, 훅 우회. 막히면 우회하지 말고 막힌 사실과 사유를 보고한다.
- 외부 API 유료 전환·자동 결제·크레딧 소모 경로로의 대체.
- 원격 push·외부 배포·릴리즈 발행·실사이트 자동 게시는 승인 범위를 먼저 확인한다. 이미 명시적으로 승인된 범위는 재승인받지 않는다.
- 사용자 실프로필·미커밋 변경·다운로드 폴더의 사용자 파일 삭제·이동.
- 키워드가 보인다는 이유만으로 에이전트를 자동 호출하거나 전 병과를 순차로 돌리는 것. 편성은 실제 필요에 따른다.
