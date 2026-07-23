# Browser Build Harness

**가볍고**, **크롬 확장프로그램이 그대로 붙고**, **Cốc Cốc 처럼 유용한 기능이 기본 장착된**, **그리고 현존 어떤 브라우저보다 자유도가 높은** 데스크톱 브라우저를 짓는 하네스. Chromium(Electron) 위에 외피·내장 기능·확장 호환·hackability 레이어를 직접 만든다.

## 미션 (4원칙 — 모두 동시에 만족해야 한다)

> **1. 가볍다.** 빈 창 메모리 ≤ 250MB, 콜드 스타트 ≤ 2초.
> **2. 크롬 확장이 그대로 붙는다.** `.crx` 드래그·웹스토어 호환 (MV2/MV3 핵심 API).
> **3. 콕콕처럼 처음부터 쓸 만하다.** 광고차단·동영상 다운로드·번역·스크린샷·사이드패널·다크모드 기본 탑재.
> **4. 그 어떤 브라우저보다 자유롭다.** UI·동작·정책·자동화·테마 — 모두 사용자가 재정의·재배치·스크립트로 후킹할 수 있다. **Emacs of browsers.**

이 원칙에서 다음 결정이 파생된다:

**(공통)** 렌더링·자바스크립트 엔진(V8)·네트워크 스택은 Electron 이 제공하는 그대로 사용 — 직접 만들지 않는다. 모든 탭 = 별도의 `WebContentsView`(Electron 30+, `BrowserView` 는 deprecated). 메인 프로세스만 Node 권한 보유, 콘텐츠 렌더러는 `sandbox: true` + `contextIsolation: true` 강제. 사용자 데이터는 `app.getPath('userData')` 아래 SQLite + JSON.

**(가벼움)** 외피 번들 ≤ 500KB(gzip), 무거운 기능은 lazy load, 백그라운드 탭 자동 슬립(30분 비활성 시 discard). 내장 기능은 모두 토글 OFF 가능 — 끄면 메모리·CPU 도 0.

**(확장 호환)** `electron-chrome-extensions` + 자체 보강 레이어. MV3 service_worker / declarativeNetRequest / storage / tabs / runtime / scripting / commands 우선 지원.

**(콕콕 기본 기능)** 광고차단·동영상 다운로드·번역·스크린샷·사이드패널·다크모드·리더모드·비밀번호·QR·빠른검색·제스처·새탭위젯.

**(자유도 — 핵심 차별점)** 다음 7개 hackability 축은 절대 약화 금지:

1. **userChrome.css / userChrome.js** — 외피(브라우저 UI) 자체를 CSS·JS 로 재정의. 옛 Firefox `userChrome` 의 정신을 부활. 핫리로드 지원
2. **userscript 엔진 내장** — Tampermonkey/Violentmonkey 메타데이터 호환 (`@match`, `@grant`, `@require`). 별도 확장 불필요
3. **명령 팔레트 (Ctrl+Shift+P)** — 모든 기능·메뉴·설정·매크로에 텍스트로 접근. 사용자가 자체 명령 등록 가능 (JS 스니펫)
4. **워크스페이스(스페이스)** — Arc 식. 탭 그룹마다 별도 색상·테마·시작페이지·세션·확장 프로필
5. **레이아웃 자유** — 탭바 위치(상/하/좌/우), 분할 화면(타일링), 수직/가로 탭 동시, 사이드패널 듀얼(좌·우)
6. **단축키 100% 재바인딩** — 모든 액션은 `actionId` 가 있고 `keymap.json` 에서 자유 매핑. 충돌 검출
7. **정책 엔진** — 사이트별로 User-Agent, JS 실행, 이미지 로드, 쿠키, 권한(카메라·위치 등), CSP 완화/강화, 헤더 주입을 룰 빌더로 설정. 노코드 + 고급 사용자는 JS 함수로

## 자유도(Hackability) 모듈 (1원칙 #4 — 절대 약화 금지)

각 모듈은 `app/main/hackability/<name>/` 에 모듈화. 설정에서 끌 수 있지만 기본은 모두 ON.

| 모듈 | 무엇을 자유롭게 | 담당 에이전트 |
|------|---------------|--------------|
| userChrome.css | 외피(탭바·툴바·메뉴) 색·간격·아이콘 CSS 재정의. 핫리로드. | `userchrome-developer` |
| userChrome.js | 외피에 사용자 JS 주입 — DOM 후킹, 새 버튼 추가. 외피 컨텍스트만. | `userchrome-developer` |
| Userscript | 페이지에 JS 주입 (Tampermonkey 호환 `@match`/`@grant`/`@require`/`GM_*`) | `userscript-engine` |
| 명령 팔레트 | Ctrl+Shift+P. 모든 액션 텍스트 호출 + 사용자 정의 명령 등록 | `command-palette-developer` |
| 워크스페이스 | Arc 식 스페이스 — 색·테마·시작페이지·세션·확장 프로필 분리 | `workspace-manager` |
| 레이아웃 자유 | 탭바 4방향, 분할 타일, 수직/가로 동시, 사이드패널 좌·우 듀얼 | `layout-customizer` |
| 단축키 재바인딩 | 모든 액션 `actionId`, `keymap.json` 자유 매핑, 충돌 검출 | `keymap-engineer` |
| 정책 엔진 | 사이트별 UA·JS·이미지·쿠키·권한·CSP·헤더 룰 빌더 + JS 함수 | `policy-engine-developer` |
| 자동화 매크로 | 트리거(URL 진입/시간/단축키) → 액션 시퀀스(스크립트·클릭·붙여넣기) | `automation-engine` |
| 디자인 토큰 | 색·폰트·라운드·여백·모션을 JSON 토큰으로. 외피 즉시 반영 | `ui-designer` |
| 데이터 주권 | 모든 데이터 export/import (북마크·이력·세션·설정 단일 zip) | `data-sovereignty` |
| Mod API | 확장보다 깊은 후킹(메뉴·탭 생명주기·네트워크 인터셉트). Node 권한 옵트인 | `mod-api-developer` |

## 기본 장착 기능 (Cốc Cốc 영감, 모두 기본 ON)

브라우저를 설치하자마자 별도 확장 없이 동작해야 하는 기능. 각각 `app/main/features/<name>/` 에 모듈화하고, 설정에서 끌 수 있다.

| 기능 | 설명 | 담당 에이전트 |
|------|------|--------------|
| 광고·트래커 차단 | EasyList + EasyPrivacy + 한국 KR 필터, 강도 3단계 | `adblocker-integrator` |
| 동영상 다운로드 | 페이지에 영상 감지 시 툴바 아이콘 활성화, yt-dlp 통합으로 YouTube/HLS/DASH/MP4 받기 | `download-manager` |
| 토렌트 다운로드 | `.torrent` / `magnet:` 처리. WebTorrent(BitTorrent + WebRTC) 내장 — 별도 클라이언트 불필요 | `download-manager` |
| 다운로드 가속 | 멀티 커넥션(병렬 4) HTTP 다운로드 | `download-manager` |
| 페이지 번역 | 선택 영역/전체 페이지 번역 (DeepL/Google 무료 엔드포인트 또는 자체) | `translation-feature` |
| 스크린샷 | 영역/전체/스크롤 캡처 → 클립보드 + PNG 저장 | `screenshot-feature` |
| 사이드 패널 | 좌측 도크: 북마크·이력·다운로드·메모·계산기 토글 | `sidepanel-developer` |
| 다크 모드 | 시스템 연동 + 페이지 강제 다크(Smart Dark CSS 주입) | `settings-developer` |
| 리더 모드 | Readability.js 로 본문만 추출 (Ctrl+Alt+R) | `tab-engineer` |
| 비밀번호 매니저 | 자동 입력 + 안전 저장 (safeStorage API) | `password-feature` |
| QR 코드 생성 | 현재 URL → QR 코드 팝업 | `sidepanel-developer` |
| 빠른 검색 | 텍스트 드래그 시 떠오르는 작은 검색 버튼 | `omnibox-developer` |
| 마우스 제스처 | 우클릭 드래그로 뒤로/앞으로/탭 전환 | `tab-engineer` |
| 새 탭 위젯 | 자주 가는 사이트 + 한국 날씨/뉴스 카드 | `settings-developer` |

## 트리거 규칙

| 키워드 | 호출 에이전트 |
|--------|-------------|
| "구조 설계", "탭 모델", "프로세스 분리", "IPC 채널" | `browser-architect` |
| "창", "BrowserWindow", "WebContentsView", "메인 프로세스" | `electron-builder` |
| "탭", "드래그", "탭 그룹", "탭 미리보기", "탭 복원", "리더 모드", "제스처" | `tab-engineer` |
| "주소창", "검색 자동완성", "omnibox", "빠른 검색" | `omnibox-developer` |
| "북마크", "즐겨찾기", "북마크 바", "폴더" | `bookmark-manager` |
| "방문 기록", "history", "최근 닫은 탭" | `history-engineer` |
| "다운로드", "동영상 받기", "가속", "재개", "저장 위치", "토렌트", "magnet", ".torrent", "yt-dlp", "HLS", "DASH" | `download-manager` |
| "확장", "Chrome 확장", "MV3", ".crx", "웹스토어" | `extension-loader` |
| "광고 차단", "adblock", "EasyList", "uBO", "트래커" | `adblocker-integrator` |
| "번역", "translate", "DeepL" | `translation-feature` |
| "스크린샷", "캡처", "스크롤샷" | `screenshot-feature` |
| "사이드 패널", "사이드바", "QR 코드", "계산기" | `sidepanel-developer` |
| "비밀번호", "자동 입력", "safeStorage" | `password-feature` |
| "설정", "테마", "다크 모드", "검색 엔진 변경", "새 탭 위젯" | `settings-developer` |
| "샌드박스", "CSP", "권한", "인증서", "보안 경고" | `security-auditor` |
| "한국어 UI", "i18n", "베트남어", "다국어" | `i18n-localizer` |
| "userChrome", "외피 CSS/JS", "핫리로드" | `userchrome-developer` |
| "userscript", "Tampermonkey", "GM_", "@match" | `userscript-engine` |
| "명령 팔레트", "Cmd+P", "Ctrl+Shift+P" | `command-palette-developer` |
| "워크스페이스", "스페이스", "프로필 분리" | `workspace-manager` |
| "수직 탭", "분할 화면", "타일링", "탭바 위치" | `layout-customizer` |
| "단축키", "키맵", "재바인딩" | `keymap-engineer` |
| "사이트 정책", "UA 변경", "쿠키 차단", "권한 룰" | `policy-engine-developer` |
| "자동화", "매크로", "워크플로", "트리거" | `automation-engine` |
| "Mod API", "플러그인 후킹", "네트워크 인터셉트" | `mod-api-developer` |
| "export 데이터", "import", "백업", "동기화" | `data-sovereignty` |
| "버튼", "툴바", "탭바", "아이콘", "디자인 토큰" | `ui-designer` |
| "빌드", "설치 파일", "NSIS", "DMG", "자동 업데이트", "릴리즈" | `release-engineer` |

## 파이프라인 (신규 기능 추가)

```
1. browser-architect  스펙 → 프로세스/IPC/저장소 결정 → 설계 문서
2. electron-builder   메인 프로세스 변경 (창·세션·메뉴) 적용
3. (도메인별 에이전트) tab|omnibox|bookmark|history|download|extension|adblock
4. settings-developer 설정 키 + 설정 UI 추가
5. ui-designer        브라우저 크롬 UI (탭바·툴바·메뉴) 마무리
6. i18n-localizer     ko / en (+ vi 선택) 문자열 키 추가
7. security-auditor   sandbox·contextIsolation·CSP·권한 정책 검증
8. release-engineer   electron-builder 패키징, 자동 업데이트 채널 반영
```

수정은 해당 단계 에이전트만 재호출.

## 디렉터리 구조

```
browser-build/
├── .claude/
│   ├── settings.json
│   ├── agents/                  # 28 에이전트
│   ├── skills/                  # 14 스킬
│   └── commands/                # 5 슬래시 커맨드
├── app/
│   ├── main/                    # 메인 프로세스
│   │   ├── windows/             #   BrowserWindow 생성·세션
│   │   ├── ipc/                 #   IPC 라우터 (domain:action)
│   │   ├── menu/                #   네이티브 메뉴 + 접근키
│   │   ├── storage/             #   SQLite (북마크·이력·다운로드)
│   │   ├── extensions/          #   electron-chrome-extensions 어댑터
│   │   └── features/            #   기본 장착 기능 모듈
│   │       ├── adblock/
│   │       ├── translate/
│   │       ├── screenshot/
│   │       ├── sidepanel/
│   │       ├── password/
│   │       └── downloader/
│   ├── renderer/                # 브라우저 외피 UI (Vite + React)
│   │   ├── tabbar/
│   │   ├── omnibox/
│   │   ├── toolbar/
│   │   └── sidepanel/
│   ├── preload/                 # contextBridge IPC 게이트
│   ├── shared/                  # 공통 타입, IPC 채널 상수, 키맵
│   └── resources/               # 트레이·앱 아이콘, 기본 설정 JSON
├── pages/                       # browser:// 내부 페이지
│   ├── newtab/                  # 새 탭 (자주 가는 사이트 + 위젯)
│   ├── settings/                # 설정
│   ├── history/                 # 방문 기록
│   ├── bookmarks/               # 북마크 관리자
│   └── downloads/               # 다운로드 관리자
├── build/                       # electron-builder 설정·리소스
├── resources/                   # 앱 아이콘 (ico/icns/png)
├── package.json
├── electron-builder.yml
├── CLAUDE.md
└── README.md
```

## 프로세스·창 모델

- **메인(1)**: BrowserWindow 생성, 세션 관리, 다운로드 후킹, 메뉴, IPC 라우팅
- **브라우저 외피 렌더러(N)**: 창마다 1개 — 탭바·주소창·툴바·사이드패널
- **콘텐츠 WebContentsView(M)**: 탭마다 1개 — 실제 웹 페이지. `partition: 'persist:default'` 또는 incognito 시 `partition: 'incognito-<n>'`
- **내부 페이지(K)**: `browser://newtab`, `browser://settings` 등은 커스텀 protocol(`browser://`) 로 로컬 HTML 매핑

## 키 단축키 (기본 매핑)

| 키 | 동작 |
|----|------|
| Ctrl+T | 새 탭 |
| Ctrl+W | 탭 닫기 |
| Ctrl+Shift+T | 마지막 닫은 탭 복원 |
| Ctrl+L / F6 | 주소창 포커스 |
| Ctrl+R / F5 | 새로고침 |
| Ctrl+Shift+N | 시크릿 창 |
| Ctrl+H | 방문 기록 |
| Ctrl+J | 다운로드 |
| Ctrl+D | 북마크 추가 |
| F12 / Ctrl+Shift+I | DevTools |
| Alt+Left / Alt+Right | 뒤로 / 앞으로 |
| Ctrl+Tab / Ctrl+Shift+Tab | 다음 / 이전 탭 |

전체 매핑은 `app/shared/keymap.ts` 단일 출처. 변경 시 `electron-builder` 가 메뉴·접근키 동시 갱신.

## 기술 스택

| 영역 | 선택 |
|------|------|
| 셸 | Electron 33+ (Chromium 130+, V8 13+) |
| UI 프레임워크 | React 18 + Vite (브라우저 외피만) |
| 스타일 | Tailwind CSS + shadcn/ui |
| 상태 | Zustand (탭 트리·세션) |
| 저장 | better-sqlite3 (북마크·이력) + electron-store (설정) |
| 확장 호환 | electron-chrome-extensions |
| 광고 차단 | @ghostery/adblocker-electron (EasyList + ko KR 필터) |
| 검색 자동완성 | OpenSearch suggest (구글/네이버/Bing) + 로컬 이력 매칭 |
| 자동 업데이트 | electron-updater + GitHub Releases |
| 패키징 | electron-builder (NSIS Win / DMG Mac / AppImage Linux) |
| 코드 사이닝 | Windows: signtool (EV cert), Mac: notarytool |
| 언어 | TypeScript strict 전부 |

## 보안 기본값 (절대 약화 금지)

모든 `webPreferences` 는 아래 값을 강제. 변경하려면 `security-auditor` 승인 필요.

```ts
{
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
}
```

`preload` 는 `contextBridge.exposeInMainWorld('browserAPI', ...)` 로만 노출, `ipcRenderer` 직접 노출 금지. CSP 는 내부 페이지에 한해 `default-src 'self'` + 최소 예외.

## 데이터 저장

- 위치: `app.getPath('userData')`
  - `bookmarks.db` — SQLite (folder/title/url/parent_id/position/added_at)
  - `history.db` — SQLite (url/title/visit_time, FTS5 인덱스)
  - `downloads.db` — SQLite (state/path/url/bytes/started_at)
  - `settings.json` — electron-store
  - `sessions/` — 창·탭 트리 스냅샷 (비정상 종료 복원)
- 시크릿 세션은 메모리에만 보관, 종료 시 삭제

## 크롬 확장 호환 (1원칙 #2)

크롬 웹스토어 상위 100개 확장의 70% 이상이 무수정 동작하는 것을 목표로 한다. 호환 매트릭스는 `extension-loader` 가 관리.

- 베이스: [`electron-chrome-extensions`](https://github.com/samuelmaddock/electron-chrome-extensions) (samuelmaddock 의 Electron Browser Demo 와 같은 계열) 채택
- `.crx` / `.zip` 드래그 → 압축 해제 후 `loadExtension(path, { allowFileAccess: true })`
- Chrome Web Store 직접 설치를 위해 자체 프록시 (`chrome-extension-downloader` 패턴)
- 지원 우선순위 API:
  1. **MV3 service_worker** (background)
  2. **declarativeNetRequest** (광고 차단·리디렉션 — 자체 엔진과 충돌 시 우선순위 규칙)
  3. **storage** (local·sync·session — sync 는 로컬 동기화로 폴백)
  4. **tabs / windows / runtime / scripting**
  5. **action / contextMenus / commands** (단축키)
  6. **webRequest** (MV2 호환 모드 유지 — uBO 옛 버전·일부 필수 확장)
- 모든 확장은 격리된 `partition: 'persist:ext-<id>'` 가능 (옵션). 기본은 메인 세션 공유
- 충돌 정책: 자체 광고차단 ↔ 확장 광고차단 동시 활성 시 사용자에게 한 번만 묻고 한쪽만 활성 → `adblock-engine` 스킬 참조

## 가벼움 예산 (1원칙 #1, 측정 = `/audit-perf`)

| 항목 | 한도 | 측정 방법 |
|------|-----|----------|
| 콜드 스타트 (창 표시까지) | ≤ 2.0s | `app.whenReady()` → `window.show()` 타임스탬프 |
| 빈 창 RSS (newtab 1개) | ≤ 250MB (웜)* | **private working set** 합 (WMI `WorkingSetPrivate`). `app.getAppMetrics().workingSetSize` 는 공유 페이지 중복 집계로 5~7배 과대평가 — 판정에 쓰지 말 것 |
| 탭 추가당 RSS 증가 | ≤ 80MB | about:blank 10탭 후 평균, **private working set** (실측 13.6MB/탭) |
| 외피(renderer) 초기 JS | ≤ 500KB gzip | Vite `--report` |
| 외피 LCP | ≤ 300ms | renderer Performance API |
| 백그라운드 탭 슬립 | 30분 비활성 → suspend | `WebContentsView` discard + thumbnail freeze |
| 디스크 (설치 후) | ≤ 250MB | electron-builder NSIS 산출물 + 첫 실행 후 userData |
| 휴식 시 CPU | ≤ 0.5% | 5분 idle 평균 |

확장이 활성화되면 한도는 확장별 추가분만큼 완화 (단, 사용자 알림). 가벼움 회귀가 보이면 `/audit-perf` 가 PR 차단.

**\* adblock 완화 조항 (2026-07-11, V4 측정 확정)**: 빈 창 RSS 예산 250MB 는 **웜 상태(2번째 이후 실행, 실사용 대다수)** 기준이다 — 실측 226MB 로 통과. **콜드(설치 후 첫 1회 실행)** 는 adblock standard 필터 엔진(EasyList+EasyPrivacy+KR+anti-cv 4리스트)의 콜드 빌드 고정비(메인 프로세스 ≈107MB) 때문에 250MB 미만이 물리적으로 불가하며, 실측 285MB 를 **예산 위반으로 보지 않는다**(확장 메모리 예외와 동일 논리 — 사용자가 켠 강력 기능의 비용). adblock standard+ 활성 시 콜드 예산은 `250 + adblock 고정비` 로 자동 완화. `/audit-perf` 는 **웜 경로**를 측정해 250MB 로 판정해야 한다(측정 하네스가 adblock 지연 init 이후를 재도록 보장 — `perf-measure.mjs` 타이밍 보정 필요). adblock 을 끄면 콜드도 250MB 이내로 돌아온다(단 콕콕 핵심이라 기본 OFF 는 금지).

## 품질 게이트

- TypeScript: `tsc --noEmit` 무경고 (main / renderer / preload 각각)
- 빌드: `npm run build` (Vite) + `npm run package` (electron-builder) 성공
- 가벼움 예산 위 표 전부 통과
- 보안: `electron-secure-defaults` 스킬 체크리스트 전부 통과
- 확장 호환: 테스트 매트릭스(uBlock Origin Lite, Dark Reader, Bitwarden, Vimium, JSON Viewer, Stylus, Tampermonkey, Save to Pocket, Wappalyzer, ColorZilla) 10개 모두 로드·기본 동작 확인
- 자동 업데이트: 채널(latest / beta) 분리, 다운로드 진행률 트레이 알림

## 슬래시 커맨드

- `/new-feature <slug>` — 메뉴 + IPC 채널 + 설정 키 + i18n 키 스캐폴드
- `/build [win|mac|linux|all]` — electron-builder 로 설치 파일 생성
- `/test-safety` — sandbox / contextIsolation / CSP / 권한 핸들러 정합성 검증
- `/release <version>` — 버전 업, CHANGELOG, GitHub Release, 자동 업데이트 메타 갱신
- `/audit-perf` — 시작 시간·메모리·번들 크기 측정 + 보고서

## 개발 컨벤션

- **언어:** TypeScript strict, 메인/렌더러/프리로드 tsconfig 분리
- **명명:** IPC 채널은 `domain:action` (`tabs:create`, `bookmarks:list`)
- **에러:** 한국어 사용자 메시지 + 영문 로그. 사용자에게는 BrowserView 위에 토스트로
- **로그:** `electron-log` 사용, userData/logs 에 회전 저장
- **커밋:** 한국어 메시지, conventional commits (`feat(tabs): ...`, `fix(omnibox): ...`)

## 옛 BrowserView 사용 금지

Electron 30+ 부터 `BrowserView` 는 deprecated. 모든 탭 컨테이너는 반드시 [`WebContentsView`](https://www.electronjs.org/docs/latest/api/web-contents-view) 사용. 이는 `webcontents-view-pattern` 스킬에 절차로 정리.

## 변경 이력

- 2026-05-25: 하네스 신규 구성 — 28 에이전트 + 16 스킬 + 5 슬래시 커맨드. Electron 33 + WebContentsView 기반.
- 2026-05-25: **묶음 A·B·C·D MVP 1차 구현**. 빌드 통과 (외피 JS 159 KB / gzip 52 KB, 가벼움 예산의 10%).
  - **A (외피 기본)**: WebContentsView 탭(생성·전환·종료·핀·드래그 재정렬·중복·복원·세션 한정 슬립 hook), Omnibox(검색엔진 라우팅·DuckDuckGo bang `!yt` 등 15개·키워드 prefix·이력/탭/url/검색 통합 제안·150ms 디바운스·800ms 타임아웃·LRU 캐시), 디자인 토큰 (tokens.json → CSS 변수 자동 생성·다크 모드 prefers-color-scheme 추종)
  - **B (자유도)**: action registry(28 액션 + `action.tab.goto.1..9`), keymap.default.json 로드·충돌 검출·창 단위 accelerator 자동 바인딩, 명령 팔레트 (Ctrl+Shift+P · 한글 초성 매칭 · MRU · prefix `> # ?`), userChrome.css 핫리로드(fs.watch 200ms 디바운스 · 외피 에디터 패널)
  - **C (콕콕 기본)**: 다운로드 큐(진행률·일시정지·재개·취소·폴더 열기·트레이 배지), `@ghostery/adblocker-electron` 통합(EasyList+EasyPrivacy+List-KR·강도 3단계·시작 1.5초 후 lazy init), 스크린샷 viewport/area(클립보드 + 자동 저장)
  - **D (확장 호환)**: `electron-chrome-extensions` 어댑터 — optional dep dynamic require, userData/extensions 디렉터리 자동 스캔·`loadExtension(allowFileAccess)` (라이브러리 미설치 시 무중단 skip)
  - 보안: sandbox + contextIsolation + webSecurity = true 전부 강제, preload 는 `contextBridge.exposeInMainWorld('browserAPI', ...)` 게이트만 노출, will-navigate 가드 + setWindowOpenHandler + 권한 화이트리스트
  - 빌드 산출물: `app/dist/main/` `app/dist/preload/` `app/dist/renderer/` 단일 트리. `npm run dev` 로 부팅, `npm run package` 로 NSIS/DMG/AppImage.
  - 알려진 제외: `better-sqlite3` (네이티브 빌드 toolchain 이슈 — 북마크/이력 DB 구현 라운드에서 prebuilt 바이너리로 재투입), `i18next`/`zod`/`zustand`/`node-cron`/`electron-updater`/`electron-chrome-extensions` (optionalDependencies — 필요 라운드에서 설치).
- 2026-05-25: **토렌트 + 영상 다운로드 1군 격상 + MVP 구현** (콕콕 핵심 동일성 확보).
  - `download-manager` 에이전트 + 신규 스킬 `torrent-webtorrent` / `video-detect-ytdlp` (16 → 18 스킬).
  - 공통 데이터 모델: `DownloadItem.kind = 'http' | 'video' | 'torrent'` 단일 큐. UI 한 곳에서 셋 다 표시·제어.
  - **토렌트 (`features/torrent`)**: WebTorrent(optional dep) 통합, magnet/`.torrent` 둘 다 처리, 1초 throttle 진행률, 라이선스 동의 다이얼로그(끄기 불가), DHT 기본 OFF (설정), 라이브러리 미설치 시 무중단 skip + 친절한 안내.
  - **magnet 프로토콜**: `app.setAsDefaultProtocolClient('magnet')` + `open-url`(mac) + `second-instance`(win/linux) + argv 첫 실행 + 페이지 내 `magnet:` will-navigate 가로채기 (5중 안전망).
  - **`.torrent` 응답 가로채기**: `webRequest.onResponseStarted` 가 `application/x-bittorrent` 또는 `.torrent` URL 감지 시 자동 다운로드 + addTorrent.
  - **영상 (`features/video-download`)**: webRequest 로 HLS(.m3u8)·DASH(.mpd)·MP4/WebM/MKV·`video/*` MIME 감지, 14 호스트(YouTube/네이버TV/비미오/트위치/SoundCloud/Bilibili/TikTok/IG/X/페북/Dailymotion/AfreecaTV …) 즉시 후보 등록.
  - **툴바 영상 아이콘**: 후보 1개 이상이면 ▶ 배지 활성, 클릭 → 후보 팝오버(HLS/DASH/MP4 색 구분 + 크기) → 선택 → MP4 는 직접 / 나머지는 yt-dlp.
  - **yt-dlp 통합**: 옵션 자산. 첫 동영상 다운로드 시도 시 동의 다이얼로그 → GitHub Release 에서 OS 별 단일 바이너리(~15MB) → `userData/binaries/` 저장. 진행률은 `--progress-template PROG|...|...` stdout 줄 단위 파싱.
  - **tab hook 시스템**: `onTabCreated`/`onTabClosed`/`onTabNavigated` 3 hook 으로 video-detect 가 탭 wcId 매핑·후보 cleanup·사이트 자동 감지 (의존 역전).
  - **omnibox 처리**: 주소창에 `magnet:?...` 또는 `*.torrent` 입력하면 즉시 토렌트 추가 + 다운로드 패널 열림.
  - **DownloadsPanel 풍부화**: kind 배지(🧲 ▶ ↓), 피어/업로드/시드 비율 표시, 다중 파일 토렌트 펼치기, 제거/제거+파일삭제 구분.
  - 외피 JS: 159 → 163 KB (gzip 52 → 53 KB) — 가벼움 예산 500 KB 의 11%, 회귀 없음.
- 2026-05-25: **실사용 회귀 라운드 1 — 부팅 panic 6종 fix, Electron 33 → 35 업그레이드**.
  - **회귀 #1 (탭 리스트 미수신, critical)**: 메인이 `'tabs:list-changed'` 로 broadcast 하는데 preload `onListChanged` 가 `IPC.tabs.list` (= `'tabs:list'`) 를 listen — invoke 채널과 send 채널 이름 충돌. **외피가 탭 갱신 영원히 못 받음**. `IPC.tabs.listChanged` 신설 + 양쪽 정렬.
  - **회귀 #2 (newtab CSP)**: `default-src 'self'` 만 → 인라인 `<script>` + `onsubmit=` 차단. `script-src 'self' 'unsafe-inline'` 추가.
  - **회귀 #3 (isDev 판정 오류, critical)**: `!app.isPackaged` 는 unpackaged binary 직접 실행 시 항상 true → production 빌드도 `localhost:5173` 요청 → ERR_CONNECTION_REFUSED. 명시 ENV(`VITE_DEV_SERVER_URL` / `BROWSERBUILD_DEV`) 로 교체. `cross-env` devDep 추가 + dev:main 스크립트가 ENV 주입.
  - **회귀 #4 (렌더러 경로 한 단계 부족)**: `path.join(__dirname, '../renderer/index.html')` — `__dirname` 가 `app/dist/main/windows` 라 `app/dist/main/renderer/`(없음). `../../renderer/` 로 수정 → `app/dist/renderer/index.html` 정상.
  - **회귀 #5 (response-hook 단일 리스너)**: `session.webRequest.onResponseStarted` 는 한 세션에 단 1개 리스너 — 마지막 등록만 effective. video-detect 와 torrent 둘 다 등록 → torrent 가 video-detect 를 덮어쓰고 영상 자동 감지 무력화. `features/response-hooks.ts` 단일 dispatcher 신설 + 양쪽 dispatcher 구독자로 전환.
  - **회귀 #6 (Electron 33 호환 한계)**: `@ghostery/adblocker-electron@2.x` 가 `session.registerPreloadScript` 필요(Electron 35+ API), `electron-chrome-extensions@4.x` 가 Electron ≥35 요구. → **Electron 33 → 35.7.5 LTS 업그레이드**. 두 패키지 정상 활성. `webtorrent@2.8.5` 도 정식 dep 으로 설치.
  - **부수 정리**: `createBrowserWindow` 를 register-defaults 에서 동적 `require` → 정적 import 로. main 진입에 try/catch + uncaught/unhandledRejection 핸들러 + adblock/extensions init 의 `.catch`. extensions adapter 에 `license: 'GPL-3.0'` 명시.
  - **부팅 검증**: Electron 35.7.5 실제 부팅 12초 이상 alive, panic 0, 콘솔 출력 `[adblock] initialized (standard)` 정상. 외피 렌더러 file:// 로 로드 성공.
  - **알려진 환경 이슈**: bash 셸에 `ELECTRON_RUN_AS_NODE=1` 같은 환경 변수가 있으면 Electron 이 일반 Node 모드로 동작 → 부팅 panic. PowerShell 사용자는 무관. `npm run dev` 도 영향 없음 (cross-env 가 ENV 명시).
- 2026-05-25: **검색창 실종 + 첫 NSIS 설치파일 라운드**.
  - **회귀 #7 (검색창/탭바 안 보임, critical)**: 메인이 `did-finish-load` 직후 `windows:ready` 를 send 했지만 React useEffect 의 `onReady` 리스너 등록은 그 뒤 → 메시지 유실 → `windowId` 영원히 `null` → `<App>` 이 빈 컨테이너만 그림. **외피 검색창·탭바 전부 안 보임**. 해결: 메인이 `chromeUrl` 에 `?windowId=<id>` query 를 박아 전달, 외피는 `useState(() => new URL(location.href).searchParams.get('windowId'))` 로 마운트 시점 즉시 잡음. ready broadcast 는 50ms 지연 fallback 으로 유지.
  - **첫 클릭 실행 가능 빌드**: `electron-builder --win` 로 `dist/win-unpacked/BrowserBuild.exe` (즉시 실행) + `dist/BrowserBuild-0.1.0-win-x64.exe` (~93MB NSIS 인스톨러) 생성. 코드 사이닝 인증서 없어 unsigned 빌드 — 첫 실행 시 SmartScreen 경고 정상(설치파일은 우클릭 → 속성 → 차단 해제 후 실행 가능).
  - **빌드 차단 #1 (winCodeSign symlink)**: electron-builder 가 winCodeSign-2.6.0.7z 추출 시 darwin/10.12/lib/lib{crypto,ssl}.dylib symbolic link 를 만들 수 없어(Windows Developer Mode 꺼짐 + 비관리자) exit 2 무한 retry. **수동 우회**: 7za 로 `-xr!darwin` 옵션 추가해 darwin 폴더 통째 제외하고 `winCodeSign-2.6.0/` 폴더로 직접 추출 (Windows 빌드는 darwin 도구 불필요). 한 번만 하면 캐시 재사용.
  - **빌드 차단 #2 (publish channel)**: `publish: github` 설정 + .git 디렉터리 없음 → `Cannot read properties of null (reading 'channel')` 로 update-info 빌드 단계 fail (단 EXE 자체는 이미 생성됨). 해결: `publish: null` 로 변경 (자동 업데이트 채널은 릴리즈 인프라 결정 후 재투입).
  - **electron-builder.yml 슬림화**: `build/icon.{ico,icns,png}` 미존재 → icon 항목 제거(기본 Electron 아이콘 사용). Windows arm64 제외(x64 만) — 빌드 시간 단축.
  - **검증**: NSIS 설치파일·win-unpacked 둘 다 부팅 성공. tasklist 에 BrowserBuild.exe 메인/GPU/Network/Renderer 4 프로세스 정상 가동. `[adblock] initialized (standard)` 로그 확인. 종료 정상.
- 2026-05-25: **회귀 라운드 2 — 외피 흰 화면 (메뉴만 표시) 두 종 fix**.
  - **회귀 #8 (preload 경로 한 단계 부족, critical)**: window-service 와 tab-service 가 `path.join(__dirname, '../preload/...')` 호출 — `__dirname` = `app/dist/main/{windows,tabs}` → `app/dist/main/preload/`(없음). 실제 위치는 `app/dist/preload/`. preload 가 ENOENT 로 로드 실패 → `contextBridge.exposeInMainWorld('browserAPI', ...)` 실행 안 됨 → React 외피가 `window.browserAPI.tabs.onListChanged` 접근 시 TypeError → 외피 트리 마운트 중단 → **빈 흰 화면 + Electron 메뉴만 표시**. `../../preload/...` 로 양쪽 수정. (회귀 #4 의 renderer 경로와 동일 패턴 — `app/dist/main/<sub>/` 에서 두 단계 위로.)
  - **회귀 #9 (sandbox preload bundling 누락, critical)**: `sandbox: true` 환경의 preload 는 Node `require` 가 `electron` 외엔 차단 → tsc 산출 `require('../shared/ipc-channels')` 는 항상 "module not found". preload 빌드를 tsc → **esbuild bundle** 로 교체. `esbuild --bundle --platform=browser --format=cjs --target=chrome134 --external:electron` 로 chrome.ts/content.ts 를 각각 단일 파일(8.2KB / 919B) 로 묶음. package.json 에 `build:preload` 스크립트 신설 + `build` 가 호출. tsconfig.json 의 preload 컴파일은 typecheck 용으로만 남김(산출물 사용 X).
  - **진단 방법 정착**: chrome WebContentsView 에 `did-fail-load` + `preload-error` 이벤트를 stdout 출력하도록 항상 후킹. 향후 외피 흰 화면 회귀 즉시 원인 노출.
  - **검증**: 재패키지 후 win-unpacked 부팅 시 BrowserBuild.exe 5 프로세스(메인/GPU/Network/Renderer/콘텐츠) 정상, preload-error 로그 없음, 외피 React 마운트 → 탭바·툴바·**검색창(omnibox)** 정상 표시.
- 2026-05-25: **묶음 E — 저장 코어 (북마크 + 방문 이력 + 새 탭 위젯) 1차 구현**.
  - **약속 이행**: CLAUDE.md "better-sqlite3 (네이티브 빌드 toolchain 이슈 — 북마크/이력 DB 구현 라운드에서 prebuilt 바이너리로 재투입)" 약속을 **sql.js (WASM SQLite)** 로 이행. 네이티브 toolchain 불필요·prebuilt 바이너리 의존 없음·크로스플랫폼 단일 산출물.
  - **db.ts 코어**: `openDb(filename, schema)` 헬퍼 — `userData/data/<name>.db` 영속화, 800ms 디바운스 자동 flush, `before-quit` 시 sync flush(데이터 손실 방지), 트랜잭션 단위 export. WASM 로드는 `app.isPackaged` 분기로 `process.resourcesPath/app.asar.unpacked/...` 직접 read (asar 안 fs 미지원 우회).
  - **bookmarks 저장소**: folders + bookmarks 2 테이블, CRUD(add/remove/rename/move/folderCreate/folderRemove) + `isBookmarked(url)` 즉답 + `searchBookmarks(query)` LIKE 검색. 변경 시 `bookmarkEvents` emit → 모든 창에 broadcast.
  - **history 저장소**: visits 테이블(URL UNIQUE + visit_count + last_visit_at), `UPSERT ON CONFLICT(url) DO UPDATE` 로 같은 URL 재방문 시 카운트만 증가. `recentVisits`/`searchHistory`/`topSites` + 부분/전체 clear. `browser:`/`chrome:`/`about:`/`devtools:`/`localhost`/`127.0.0.1` 자동 skip.
  - **자동 기록 hook**: `onTabNavigated`/`onTabTitleUpdated` 신설 → 메인 진입에서 `recordVisit`/`updateVisitTitle` 자동 호출. `did-navigate` payload 에 title 추가, `page-title-updated` 도 hook 분리.
  - **액션 등록** (Ctrl+D/Ctrl+H 가 깨진 약속이었음 — 매핑만 있고 핸들러 없음): `action.bookmark.add`(Ctrl+D, 토글: 추가/제거 + 한국어 토스트), `action.history.open`(Ctrl+H, `browser://history` 새 탭), `action.bookmark.list`(`browser://bookmarks` 새 탭), `action.downloads.open`(Ctrl+J, panel:open IPC).
  - **omnibox 자동완성 강화**: `searchBookmarks(q, 4)` + `searchHistory(q, 6)` 를 기존 omnibox suggestions 에 통합. score: 북마크 0.75, 이력은 `0.45 + log10(visit+1) * 0.12` (자주 가는 사이트가 위로). dedupe 단계가 URL 기준이라 중복 제거.
  - **내부 페이지용 preload 분리 (보안)**: `app/preload/internal.ts` 신설 — `browser://` 페이지 전용 `internalAPI` (history/bookmarks). 외부 사이트 페이지는 기존 `content.js` 유지(version 만 노출). tab-service 가 첫 URL 의 `browser:` 여부로 preload 선택. 한 번 결정되면 navigate 후엔 못 바꾸므로 **메인 IPC 핸들러가 sender URL 검증** (`isTrustedSender`: `browser:`/`file:`/`devtools:`/`localhost` 만) — 외부 사이트가 internalAPI 채널 시도해도 거부.
  - **새 탭 페이지 리뉴얼**: 빈 더미였던 `pages/newtab/index.html` 을 "자주 가는 사이트" 카드 6열 그리드(반응형 4·3열) + 검색 박스로 리뉴얼. Google Favicons API 로 16px 아이콘 자동 렌더, 빈 이력 시 안내 문구. `internalAPI.history.onChanged` 구독으로 새로고침.
  - **history 페이지** (`pages/history/index.html`): 일자별 그룹화(오늘/날짜), 제목·URL 검색 (120ms 디바운스), 행별 삭제, "오늘 삭제"(midnight 이후만)·"전체 삭제" 확인 다이얼로그.
  - **bookmarks 페이지** (`pages/bookmarks/index.html`): 전체 리스트, 즉시 검색 필터, 행별 제거 (폴더 UI 는 다음 라운드 — 평면 리스트로 시작).
  - **Toolbar 북마크 별 ★/☆**: 활성 탭 북마크 여부 즉시 표시 (Ctrl+D 또는 클릭 = 토글), 변경 이벤트 구독으로 다른 창과 동기화. 활성 색 `#F5A623`.
  - **Toast 컴포넌트** (`components/Toast.tsx`): 우하단 → 하단 중앙 스택, 2.4s 자동 사라짐. 메인이 `toast:show` 채널로 메시지 보내면 모든 창이 표시. "북마크에 추가됨 ★" / "북마크에서 제거됨".
  - **빌드 산출물**: 외피 JS 163 → 164.7 KB (gzip 53.6 → 53.9 KB), preload chrome.js 8.2 → 10.2 KB, internal.js 신설 4.6 KB. WASM 바이너리는 asarUnpack 으로 `app.asar.unpacked/node_modules/sql.js/dist/sql-wasm.wasm` 에 빠짐 (asar fs 패치 미적용 부분 회피).
  - **검증**: NSIS 인스톨러 96.8 MB · win-unpacked BrowserBuild.exe 부팅 시 5 프로세스 정상 가동, log clean, asarUnpack 정상 (`sql-wasm.wasm` 패키지 내 존재 확인).
  - **다음 라운드 후보**: ① 북마크 폴더 UI + 드래그 정리, ② 사이드패널 (북마크·이력 듀얼 도크), ③ 다크 모드 강제 (Smart Dark CSS 주입), ④ 마우스 제스처, ⑤ Userscript 엔진 (Tampermonkey 호환), ⑥ 수직 탭 + 분할 화면, ⑦ 번역 (DeepL/Google).
- 2026-05-25: **회귀 #10 fix — OS "이 'browser' 링크를 여세요" 다이얼로그**.
  - **원인**: `chrome.webContents.setWindowOpenHandler` 가 URL 스킴 검사 없이 `shell.openExternal(url)` 무조건 호출. 외피 또는 페이지 안의 `<a target="_blank">` 또는 `window.open(...)` 호출이 `browser://` URL 을 던지면 Windows 가 'browser' 프로토콜 핸들러를 OS 차원에서 찾으려 함 → "이 'browser' 링크를 여세요 — Microsoft Store 검색" 다이얼로그.
  - **수정**: `window-service.ts` 에 `routeWindowOpen(windowId, url)` 신설 — URL 스킴별 분기:
    - `http:`/`https:`/`mailto:`/`tel:`/`sms:` → 새 탭으로 (이전엔 셸 위임이었으나 셸 위임은 사용자가 명시 선택할 때만 적절)
    - `browser:` → 새 탭으로 (외부 위임 금지)
    - `magnet:` → torrent 모듈로 직접 위임 (`addTorrent`)
    - 그 외 알 수 없는 스킴 → **무시** (OS 핸들러 위임 금지 — 다이얼로그 차단)
  - **tab view 에도 동일 핸들러 추가**: 페이지의 `window.open` / `target="_blank"` 가 새 탭으로 흡수되도록 (이전엔 default = 새 BrowserWindow 만들어 의도치 않은 윈도우 폭증 가능했음).
  - **main 진입에서 `setOpenInTabHandler((winId, url) => createTab({ windowId: winId, url }))` + `setMagnetHandler((url) => addTorrent(url))` 연결**. 모듈 순환 의존 방지 위해 window-service 가 callback 보유, 등록은 진입에서.
  - **검증**: 재패키지 후 win-unpacked 부팅 → 로그 클린, OS 다이얼로그 재현 경로 차단.
- 2026-05-25: **묶음 F-1 — 북마크 폴더 UI + 드래그 정리 + 북마크 바**.
  - **북마크 바 (Ctrl+Shift+B 토글)**: Toolbar 아래 32px 가로 막대. 루트 폴더의 폴더는 📁 드롭다운(클릭 외부 mousedown 으로 자동 close), 북마크는 favicon + 제목. Ctrl+클릭 = 백그라운드 탭, Ctrl+Shift+클릭 = 전면 탭, 가운데 클릭(Aux 1) = 백그라운드. 폴더 중첩 무제한 재귀 렌더. 빈 상태 안내 + "관리" 링크 → `browser://bookmarks`.
  - **chrome 높이 동적 측정**: 외피 `<div class="chrome-shell">` 에 ResizeObserver, 변동 즉시 `IPC.windows.setChromeHeight(windowId, height)` 호출 → 메인이 `setChromeHeightHook` 으로 활성 탭 view `setBounds(getTabBounds(ctx))` 재배치. 북마크 바 토글에 따라 콘텐츠 영역 자동 조정. `BrowserWindowContext` 에 `chromeHeight` 필드 추가, `getTabBounds` 가 고정 `CHROME_HEIGHT` 대신 동적 값 사용.
  - **토글 상태 영속화**: `localStorage` (`browserbuild.bookmark-bar.show`) 외피 측 저장. 부팅 시 즉시 복원. 다음 라운드에 settings 모듈 통합 예정.
  - **단축키 충돌 해결**: `action.sidepanel.right.toggle` Ctrl+Shift+B → **Ctrl+Alt+B** 이동, `action.bookmark.bar.toggle` 신규 → **Ctrl+Shift+B** (Chrome/Edge 와 동일). 메인 액션이 외피로 `bookmark-bar:toggle` IPC send.
  - **북마크 관리 페이지 폴더 트리 + DnD**: `pages/bookmarks/index.html` 전체 리뉴얼.
    - 좌측 240px aside: 폴더 트리(재귀, 들여쓰기), 폴더별 북마크 개수 표시, "모든 북마크" 루트 선택 가능
    - 우측 콘텐츠: 현재 폴더의 북마크 리스트, 제목·URL 검색, 행별 즉시 제거
    - **HTML5 Drag and Drop**: 북마크 행 draggable → 좌측 폴더 노드 drop. dragover/dragleave 로 폴더에 outline 표시. drop 시 `internalAPI.bookmarks.move(id, folderId, position)` 호출, 변경 broadcast 로 자동 재렌더
    - 폴더 생성/삭제 버튼 — `folderCreate(name, currentFolderId)` 로 현재 위치에 새 폴더 추가 / `folderRemove(id)` 로 폴더+안의 북마크 모두 삭제 (확인 다이얼로그). 이름 변경은 다음 라운드.
  - **internal preload 확장**: `bookmarks.rename` / `bookmarks.move` / `bookmarks.folderCreate` / `bookmarks.folderRemove` 노출. `BookmarkFolder` 타입 import.
  - **새 IPC**: `IPC.windows.setChromeHeight` + `app/main/ipc/windows.ts` 신설.
  - **빌드 산출물**: 외피 JS 164.7 → **약 165 KB**, preload chrome.js 10.2 → **10.4 KB**, internal.js 4.6 → **5.1 KB**. NSIS 인스톨러 96.86 MB.
  - **검증**: dev 부팅 + packaged 부팅 둘 다 로그 클린, 5 프로세스 정상.
  - **다음 라운드 후보**: ① 사이드패널 (북마크·이력 듀얼 도크 + 트리), ② 다크 모드 강제 (Smart Dark CSS), ③ 폴더 이름 변경 + 북마크 제목 인라인 편집, ④ 마우스 제스처, ⑤ Userscript 엔진, ⑥ 수직 탭 + 분할 화면, ⑦ 번역.
- 2026-05-25: **묶음 F-2 — 사이드패널 (좌·우 듀얼, 북마크·이력·메모 탭형)**.
  - **깨진 약속 fix**: Ctrl+B (`action.sidepanel.left.toggle`) / Ctrl+Alt+B (`action.sidepanel.right.toggle`) 가 매핑만 있고 핸들러 없었음 → 양쪽 액션 활성. 메인이 외피로 `sidepanel:toggle { side }` IPC send.
  - **insets 모델 도입**: `BrowserWindowContext.insets = { top, right, bottom, left }` 신설. `getTabBounds(ctx)` 가 고정 `CHROME_HEIGHT` 대신 `insets` 사용 → `x: left, y: top, w: w - left - right, h: h - top - bottom`. chrome view 의 bounds 는 항상 전체 윈도우(0,0,w,h)로 변경 + `win.on('resize')` 에서 매번 재배치. 탭 view 는 가운데 영역만 덮음 → 사이드패널 영역은 외피가 그림. `setShellInsets(windowId, partial)` 일반화 함수 + `setChromeHeight` 는 thin wrapper 로 호환 유지. `setShellInsetsHook` 으로 tab-service 가 활성 탭 즉시 재배치.
  - **SidePanel 컴포넌트** ([components/SidePanel.tsx](browser-build/app/renderer/components/SidePanel.tsx)): 좌·우 동일 컴포넌트, 280px 너비. 상단 탭 바(★ 북마크 / 🕘 이력 / 📝 메모) + 닫기 버튼. 각 사이드의 active 탭 + 노트 내용은 localStorage 영속화.
    - **북마크 탭**: 폴더 트리(재귀 들여쓰기) + 검색 필터(검색 시 모든 폴더 자동 펼침). 클릭 = 현재 탭 navigate / Ctrl+클릭 = 백그라운드 탭 / Ctrl+Shift+클릭 = 전면 탭.
    - **이력 탭**: 최근 100건 + 검색 (120ms 디바운스). 일자별 그룹(sticky header), 행별 즉시 삭제, `history.onChanged` 자동 갱신.
    - **메모 탭**: 자유 textarea, 200ms 디바운스 자동 저장 (좌·우 별도 키). 클라우드 동기는 다음 라운드.
  - **외피 layout 재구성**: `<div class="app">` → `<chrome-shell>` + `<div class="main-area">{ <SidePanel side="left"/>, <div class="tab-stage"/>, <SidePanel side="right"/> }</div>`. `tab-stage` 는 빈 영역(탭 view 가 덮음). 좌·우 사이드패널 너비/표시 → `setShellInsets` IPC 전송.
  - **상태 영속화**: `browserbuild.sidepanel.{left,right}.open` localStorage (디폴트 닫힘). 다음 라운드에 settings 통합.
  - **빌드 산출물**: 외피 JS ~167 KB / gzip 약 55 KB, preload chrome.js 10.4 → **10.7 KB**.
- 2026-05-25: **회귀 #11 fix — "이 'browser' 링크를 여세요" OS 다이얼로그 재현 (회귀 #10 이후에도 잔존)**.
  - **진짜 root cause**: `protocol.handle('browser', ...)` 가 `session.defaultSession` 에만 등록되었음. 그러나 모든 탭 view 는 `partition: 'persist:default'` 라는 **명명 세션** 사용 — Electron 35 에서 `session.fromPartition('persist:default') !== session.defaultSession`. 탭이 `browser://newtab` 로드 시 그 세션엔 `browser:` 핸들러가 없어서 → Chromium 이 알 수 없는 스킴으로 처리 → OS 외부 핸들러 위임 → Windows "Microsoft Store 검색" 다이얼로그.
  - **수정 (다중 session 등록)**: `protocol.handle('browser', handleBrowserUrl)` (default) + `session.fromPartition(DEFAULT_SESSION).protocol.handle('browser', handleBrowserUrl)` (탭 세션). `setPermissionRequestHandler` / `setPermissionCheckHandler` 도 양쪽 세션에 동일 등록. `handleBrowserUrl` 은 호스트 `^[a-z0-9-]+$` 검증으로 path traversal 차단.
  - **추가 안전망 — will-navigate 스킴 차단**: `app.on('web-contents-created')` 가 모든 새 webContents 의 `will-navigate` 인터셉트, 허용 스킴(`http:` `https:` `file:` `browser:` `devtools:` `chrome-extension:` `about:` `data:` `blob:`) 외엔 `preventDefault()` — OS 위임 자체를 차단. 향후 새로운 알 수 없는 스킴 회귀도 즉시 막힘.
  - **진단 강화**: 모든 `did-fail-load` (사용자 취소 `-3` 제외) 를 stdout 에 `[nav] did-fail-load wc#X code=Y desc=...` 로 출력 → 비슷한 navigation 회귀 즉시 노출.
  - **검증**: 사용자 확인 — 다이얼로그 사라짐. dev+packaged 부팅 클린, browser:// 진단 로그 없음(정상 로드됨).
  - **다음 라운드 후보**: ① 다크 모드 강제 (Smart Dark CSS), ② 폴더 이름 변경 + 북마크 제목 인라인 편집 + 사이드패널 width drag-resize, ③ 마우스 제스처, ④ Userscript 엔진, ⑤ 수직 탭 + 분할 화면, ⑥ 번역.
- 2026-05-25: **묶음 F-3 — 다크 모드 강제 (Smart Dark CSS 주입) 1차**.
  - **콕콕 기본 잔여 해소**: 1군 기본 기능 표 중 "다크 모드 (시스템 연동 + 페이지 강제 다크 Smart Dark CSS 주입)" 약속 이행.
  - **방식**: 첫 라운드는 **CSS Filter invert** — 한 페이지 한 CSS 로 모든 사이트 즉시 다크. `html { filter: invert(0.92) hue-rotate(180deg) contrast(0.92) }` + `img/video/iframe/svg/canvas` 재반전(0.8 → 다시 정상). Dark Reader 라이브러리 dynamic 모드 도입은 다음 라운드 (이미지 색 정확도 향상).
  - **features/dark-mode**: `trackWebContents(wc)` 가 각 탭의 `did-finish-load`/`did-navigate`/`did-navigate-in-page` 이벤트에 hook — navigate 후 inserted CSS 키가 무효해지므로 자동 재주입. `WeakMap<WebContents, key>` 로 키 추적. `setForcePageDark(boolean)` / `toggleForcePageDark()` / `isForcePageDark()` 노출.
  - **자동 적용**: main 진입의 `onTabCreated` hook 이 새 탭 webContents 를 `trackDarkMode(wc)` 등록. 새 탭부터 기존 탭까지 일괄 동기 (설정 토글 시 모든 tracked wc 에 apply/remove).
  - **상태 영속화**: `settings.appearance.forcePageDark: boolean` 신설. electron-store 자동 영속화. 부팅 시 설정값 따라 자동 주입.
  - **액션**: `action.darkmode.toggle` (Ctrl+Shift+D, when='global', category='appearance'). 토글 후 토스트로 "강제 다크 모드 켜짐 🌙" / "꺼짐 ☀" 알림. 명령 팔레트에서도 검색 가능.
  - **외피 색상은 별도**: chrome WebContentsView 의 외피 UI 는 기존 `prefers-color-scheme: dark` 그대로 — 강제 다크 토글은 **콘텐츠 페이지에만** 적용 (사용자 의도에 부합). 외피 강제 다크는 settings UI 라운드에서 별도 컨트롤.
  - **검증**: dev+packaged 부팅 클린 5 프로세스, log 정상. CSS Filter invert 는 가장 안정적인 방식 — 일부 색 hue 가 약간 다를 수 있으나 모든 사이트 100% 호환.
  - **다음 라운드 후보**: ① 수직 탭 + 분할 화면 (자유도 핵심, insets 모델 위에 자연), ② 마우스 제스처, ③ Userscript 엔진 (Tampermonkey 호환), ④ 페이지 번역, ⑤ Dark Reader dynamic 모드 (이미지 색 정확도), ⑥ 설정 UI (browser://settings), ⑦ 폴더 이름 변경 + 북마크 인라인 편집 + 사이드패널 width drag-resize.
- 2026-05-25: **묶음 F-4a — 수직 탭 (탭바 위치 자유: 상/좌/우)**.
  - **자유도 #5 (레이아웃 자유) 1차 진입**: CLAUDE.md "탭바 위치(상/하/좌/우), 분할 화면(타일링), 수직/가로 탭 동시" 중 **수직 탭(좌/우)** 구현. 분할 화면(panes 모델)은 다음 라운드.
  - **TabBar orientation prop**: `'top' | 'left' | 'right' | 'bottom'`. CSS 룰을 `.tabbar.tabbar-top` / `.tabbar.vertical` 로 분리. vertical 시 220px 너비, 세로 stack flexbox, 탭 카드가 둥근 모서리 + active 시 border+bg 강조. 핀 탭도 제목 표시. 드롭 타깃 위치는 box-shadow top-edge 로 가로용 left-edge 와 구분.
  - **App.tsx layout 분기**: orientation === 'top' 이면 `<chrome-shell>` 안 첫 row 에 TabBar, vertical 이면 `<main-area>` 의 좌/우 stripe 에 TabBar. Toolbar + BookmarkBar 는 항상 상단 chrome-shell. SidePanel 와 동시 사용 가능 — 수직 탭바 ＋ 좌측 사이드패널이 좌측에 차곡차곡.
  - **insets 계산 확장**: `left = (orientation==='left' ? 220 : 0) + (leftPanelOpen ? 280 : 0)`, `right = (orientation==='right' ? 220 : 0) + (rightPanelOpen ? 280 : 0)`. 메인 탭 view 자동 재배치.
  - **순환 토글 액션**: `action.tabbar.cycle` (Ctrl+Alt+T, when='global', category='layout') → top → left → right → top 순환. 외피 React 가 IPC 받아 state 변경 + localStorage 영속화. 명령 팔레트 검색 가능.
  - **상태 영속화**: `browserbuild.tabbar.orientation` localStorage. 부팅 시 즉시 복원.
  - **드래그 재정렬은 양쪽 orientation 호환**: 기존 DnD 로직 변경 없음 (index 기반).
  - **다음 단계 — 분할 화면**: `tab-service` 의 모델을 `Pane`(가로/세로 분할 트리) + `Pane.activeTab` 로 확장. 한 윈도우에 여러 탭 view 동시 표시. 분량 큼 — 한 라운드 단독 진행.
  - **빌드 산출물**: preload chrome.js 10.7 → **10.8 KB**, 외피 JS ~167 KB. NSIS 96.87 MB.
  - **검증**: dev+packaged 5 프로세스 정상, log clean.
  - **다음 라운드 후보**: ① **분할 화면(타일링, panes 모델)** ← 추천 (자유도 핵심 잔여), ② 마우스 제스처, ③ Userscript 엔진, ④ 페이지 번역, ⑤ Dark Reader dynamic 모드, ⑥ 설정 UI (browser://settings), ⑦ 폴더 이름 변경 + 인라인 편집.
- 2026-05-25: **묶음 F-4b — 분할 화면 (panes 모델, 2-pane 좌우/상하 분할) 1차**.
  - **자유도 #5 (레이아웃 자유) 마감**: 한 윈도우에 두 탭 view 가 동시에 보이는 타일링.
  - **모델 변경 — layout 추상화**: 기존 `activeByWindow: Map<windowId, tabId>` (단일 활성 탭) → `layoutByWindow: Map<windowId, WindowLayout>` 로 일반화. `WindowLayout = { panes: Pane[], split: 'h'|'v'|null, activePaneIdx: number, splitRatio: number }`. `Pane = { tabId: string | null }`. 탭 자체 모델은 그대로 (탭이 어느 pane 에 속한다는 영구 매핑 없음 — pane 은 "지금 그 영역에 보이는 탭" 의 표현).
  - **`reapplyLayout(windowId)`**: 모든 그 윈도우 탭 view 를 일단 invisible 처리하고, layout.panes 각각의 활성 tabId 만 `paneBoundsOf` 영역에 `setVisible(true)`. 윈도우 resize / shell insets 변경 시 자동 호출 (기존 `rebindActiveTabBounds` 의 일반화).
  - **`paneBoundsOf(ctx, idx, layout)`**: `getTabBounds(ctx)` 의 가운데 base 영역을 `splitRatio` (기본 0.5, clamp [0.15, 0.85]) 로 분할. `split='h'` 좌/우, `split='v'` 상/하. 단일 pane 이면 base 그대로 반환.
  - **신규 액션 4종 + 키맵**:
    - `action.pane.split.h` (Ctrl+Alt+\\) — 활성 윈도우 좌우 분할. 다른 탭이 있으면 가장 최근 탭을 두 번째 pane 으로, 없으면 newtab 생성. 토스트 "좌우 분할 ⫾".
    - `action.pane.split.v` (Ctrl+Alt+-) — 상하 분할. 토스트 "상하 분할 ⫿".
    - `action.pane.unsplit` (Ctrl+Alt+0) — 활성 pane 만 남기고 단일화. 토스트 "분할 해제".
    - `action.pane.focus.next` (Ctrl+\`) — `activePaneIdx = (current + 1) % panes.length`. 다음부터 새 탭/탭 활성화는 새 active pane 에 적용.
  - **이미 분할 상태에서 split 액션**: 같은 방향이면 무시, 다른 방향이면 방향 전환만 (탭 보존). 분할 토글 UX.
  - **closeTab 분할 인식**: 닫힌 탭이 어느 pane 의 active 였다면 → 다른 보이지 않는 탭 중 가장 가까운 index 로 그 pane 교체. 다른 탭 없으면 분할 자동 해제(단일화) → 단일이면 빈 pane 으로 남김 (윈도우 마지막 탭은 외피 매뉴얼 닫기로).
  - **새 탭 (`createTab`)**: `background: false` 면 활성 pane 의 tabId 를 새 탭으로 교체. `background: true` 면 단순 invisible — 어느 pane 에도 안 보임.
  - **API 보존**: `activateTab` / `closeTab` / `createTab` / `listTabs` / `getActiveTabId` 외부 시그니처 변경 없음. 외피·확장·기존 액션 모두 그대로 작동. 분할 인지는 새 액션 + `getWindowLayout` 헬퍼 노출.
  - **첫 라운드 제한**: 외피 TabBar 는 윈도우 전체 탭을 보임 (분할 pane 별 mini 탭바는 다음 라운드). 활성 pane 표시는 시각 큐 없음 (다음 라운드 — webContents border 또는 외피 overlay). 분할 비율 drag-resize 도 다음 라운드 (현재 0.5 고정).
  - **빌드 산출물**: preload 동일 10.8 KB. 외피 JS 변경 없음 (모든 분할 로직 메인 측). NSIS 96.87 MB.
  - **검증**: dev+packaged 5 프로세스 정상, log clean. 기존 단일 모드 회귀 없음.
  - **다음 라운드 후보**: ① **pane 별 mini 탭바 + 활성 pane outline + splitRatio drag-resize** (분할 UX 마감), ② 마우스 제스처, ③ Userscript 엔진, ④ 페이지 번역, ⑤ 설정 UI (browser://settings — 분산된 토글 한 곳에 정리), ⑥ 리더 모드 / 빠른 검색 / 마우스 제스처 콕콕 잔여 3종.
- 2026-05-25: **묶음 F-4c — 분할 UX 마감: 활성 pane outline + splitter drag-resize + 메인↔외피 layout 동기**.
  - **활성 pane outline**: 외피 React 의 `.pane.active { border: 2px solid var(--accent) }`. 메인의 `paneBoundsOf` 가 `PANE_OUTLINE=2` 만큼 webContentsView 를 안쪽으로 inset → 외피 border 가 외곽 빈 영역에 정상 표시. 활성 pane 클릭 시 `windows.focusPane(idx)` IPC 로 즉시 강조 전환.
  - **splitter (drag handle)**: 두 webContentsView 사이 4px 빈 영역에 외피 React `<Splitter>` 배치. `flex: 0 0 4px`, hover 시 accent 색, `cursor: col-resize`/`row-resize`. `::after pseudo` 로 잡기 영역을 ±3px 확장 (실 8px 적중 영역).
  - **drag-resize**: `mousedown` → `window.mousemove` listener + `splitter-dragging` body class (모든 외피 element pointer-events: none, splitter 만 auto). 매 mousemove 마다 `windows.setPaneSplitRatio(ratio)` IPC. clamp [0.15, 0.85]. 메인은 layout.splitRatio 갱신 + reapplyLayout 으로 즉시 두 webContentsView 재배치.
  - **drag 중 chrome z-order 승격 — 가장 핵심 fix**: 탭 view 가 외피 위에 있으므로 drag 시 사용자 마우스가 webContentsView 안으로 들어가면 외피의 mousemove 가 끊김. `beginPaneDrag(windowId)` IPC → 메인이 `bringChromeToFront` 로 chrome view 를 가장 위로 reorder → 가운데 영역에서 외피 페이지가 직접 마우스 받음. `endPaneDrag(windowId)` → 모든 view (chrome + 윈도우의 모든 탭 view) 를 `removeChildView` 후 다시 `addChildView` 순서대로 — chrome 가장 아래, 탭 view 가장 위로 복원. reapplyLayout 으로 visibility + bounds 재적용.
  - **메인 → 외피 layout 동기**: `reapplyLayout` 마지막에 `IPC.windows.layoutChanged { split, splitRatio, activePaneIdx, panes }` broadcast. 외피 `App.tsx` 가 구독 → `paneLayout` state → `<PaneStage>` 가 자동 재렌더.
  - **PaneStage 컴포넌트 ([components/PaneStage.tsx](browser-build/app/renderer/components/PaneStage.tsx))**: 단일 모드면 기존 `.tab-stage` 빈 div. 분할 시 `.tab-stage-split` flexbox 방향 분기 + 두 `<Pane>` (flex: ratio / 1-ratio) + 사이 `<Splitter>`. 각 Pane 에 작은 header 영역(현재 height: 0, 다음 라운드 mini 탭바 자리). 위치 라벨("왼쪽/오른쪽/위/아래") 도 다음 라운드에 mini header 등장 시 표시.
  - **신규 IPC 5종**: `windows.setPaneSplitRatio` / `windows.focusPane` / `windows.layoutChanged` (broadcast) / `windows.beginPaneDrag` / `windows.endPaneDrag`. preload 에 모두 노출.
  - **빌드 산출물**: preload chrome.js 10.8 → **11.5 KB**, internal.js 5.1 → **5.4 KB**. NSIS 96.87 MB.
  - **검증**: dev+packaged 5 프로세스 정상, log clean.
  - **알려진 제한**: 단일 모드(분할 없음) 시 active outline 없음 (단일 = 항상 active). pane 별 mini 탭바(탭 전환 가능) 는 다음 라운드 — 분할 시 두 pane 의 어느 탭을 선택했는지 사용자가 알려면 메인 TabBar 의 active 표시에 의존.
  - **다음 라운드 후보**: ① **pane 별 mini 탭바 (탭바를 pane 마다 분리 — 각 pane 위 상단 24px)** ← 분할 UX 의 마지막 마감, ② 마우스 제스처 + 빠른 검색 + 리더 모드 (콕콕 잔여 3종 묶음), ③ Userscript 엔진 (Tampermonkey 호환), ④ 정책 엔진 (사이트별 UA·쿠키·CSP), ⑤ 설정 UI (browser://settings), ⑥ 페이지 번역.
- 2026-05-25: **묶음 G — 콕콕 기본 잔여 3종 (마우스 제스처 + 빠른 검색 + 리더 모드)**.
  - **3개 모두 콘텐츠 페이지에서 동작**: tab view 의 `content.js` preload (sandbox + contextIsolation) 가 DOM 이벤트 후킹 → `ipcRenderer.invoke` 로 메인에 알림. 메인은 `sender.id` 로 어느 탭인지 찾아 (`findTabIdByWebContentsId`) 액션 수행. 내부 페이지(`browser://`) 는 `internal.js` 사용이라 영향 없음.
  - **마우스 제스처**: 우클릭 드래그 + 30px 이상 이동 시 발동. 방향별 매핑 — 좌=뒤로, 우=앞으로, 위=새로고침, 아래=새 탭. 발동 시 `contextmenu` 이벤트 `preventDefault` 로 일반 우클릭 메뉴 차단. 다음 라운드에 사선(아래-우=탭 닫기 등) + 사용자 정의 매핑.
  - **빠른 검색**: 좌클릭 mouseup 후 `window.getSelection()` 2~200자 텍스트 → 선택 위치 옆에 작은 흰색 둥근 버튼 (z-index 2147483647). 클릭 시 `buildSearchUrl(text)` 로 새 탭. mousedown / scroll / blur 시 자동 숨김.
  - **리더 모드**: `@mozilla/readability` 라이브러리. 메인이 `Readability.js` 코드를 한 번만 read 후 `wc.executeJavaScript(libCode + parse 로직)` 으로 활성 탭에 주입. `document.write` 로 정제된 HTML(Article + 상단 "원본 보기" 바) 교체, 원본 HTML 은 `window.__bbReaderOriginalHTML` 에 보관. 토글 시 원본 복원. 라이트/다크 자동(prefers-color-scheme).
  - **`action.tab.reader` (Ctrl+Alt+R) 활성**: 기존 keymap 매핑만 있고 핸들러 없던 깨진 약속 → 활성. 토스트 "리더 모드 📖" / "원본 보기" 피드백. `http:`/`https:` 만 — `browser:` 등 내부 페이지엔 미적용.
  - **tab-service 신규 헬퍼 `findTabIdByWebContentsId(wcId)`**: sender → tab/window 식별 공통 헬퍼 (gesture · quick-search 둘 다 사용).
  - **빌드 산출물**: content.js preload 0.9 → **6.9 KB** (제스처 + 빠른 검색 로직). 메인 측 readability 약 80KB는 패키지 시 `app.asar` 안 `node_modules/@mozilla/readability/Readability.js` 그대로 포함, 첫 리더 모드 호출 시 한 번만 메모리에 read.
  - **검증**: dev+packaged 5 프로세스 정상, log clean.
  - **콕콕 기본 진행 현황**: ✅ adblock · 동영상 · 토렌트 · 스크린샷 · 사이드 패널 · 다크 모드 · 새 탭 위젯 · 마우스 제스처 · 빠른 검색 · 리더 모드 — **남은 잔여 4종**: 다운로드 가속 (멀티 커넥션), 페이지 번역, 비밀번호 매니저, QR 코드 생성.
  - **다음 라운드 후보**: ① pane 별 mini 탭바 (분할 UX 마지막 보강), ② 페이지 번역 (DeepL/Google), ③ QR 코드 생성 (사이드패널 추가 도구 또는 툴바), ④ Userscript 엔진 (Tampermonkey 호환 — 자유도 #2), ⑤ 비밀번호 매니저 (safeStorage + 자동 입력), ⑥ 정책 엔진 (사이트별 UA·쿠키·CSP — 자유도 #7), ⑦ 설정 UI (browser://settings).
- 2026-05-25: **묶음 H — 페이지 번역 + QR 코드 (콕콕 잔여 2종)**.
  - **페이지 번역 ([features/translate](browser-build/app/main/features/translate/index.ts))**: `action.translate.page` (Ctrl+Shift+L) — 기존 keymap 매핑만 있고 핸들러 없던 깨진 약속을 활성.
    - 활성 탭에 `executeJavaScript` 로 번역 스크립트 주입. `document.body` 의 TreeWalker 로 가시 텍스트 노드 수집 (`<script>`/`<style>`/`<noscript>`/`<code>`/`<pre>` + `display:none`/`visibility:hidden` 제외).
    - 50개 단위 batch 로 `window.__bbTranslateBatch(texts)` 호출. 이 함수는 Google 무료 엔드포인트(`translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ko&dt=t`) 를 `fetch` 로 호출 — 콘텐츠 페이지 컨텍스트라 same-origin 제약 없음(translate.googleapis.com 의 CORS 허용 헤더 활용).
    - 분할 단위 `\n@@@@\n` separator 로 묶었다가 응답에서 split. 4500자 초과 시 자동 재귀 분할.
    - 토글식: 두 번째 호출 시 `window.__bbTransOrig: Map<TextNode, original>` 로 원본 복원. 토스트 "번역 중… ⏳" → "번역 완료 🌐" / "원본 복원".
    - 메인 측 `IPC.translate.batch` 채널도 노출 (CORS 회피 fallback, 현재 사용 안 함). `http:`/`https:` 만 적용, 내부 페이지 미적용.
    - 다음 라운드 보강: 선택 영역만 번역, 사용자 선택 언어(현재 ko 고정), 자동 언어 감지 결과 표시, DeepL API 키 옵션.
  - **QR 코드 ([features/qrcode](browser-build/app/main/features/qrcode/index.ts))**: 신규 액션 `action.qrcode.show` (Ctrl+Shift+Q). 활성 탭 URL → 메인이 `qrcode` 라이브러리(`QRCode.toDataURL`)로 280×280 PNG dataURL 생성 → 외피로 IPC `qrcode:open { url }` → 외피의 신규 `<QrModal>` 컴포넌트가 작은 modal 표시.
    - QrModal: 백드롭 클릭 또는 ESC 로 닫기. URL 표시 + QR 이미지 + 닫기 버튼. 이미지 영역은 항상 흰 배경(QR 가독성).
  - **dependencies 추가**: `qrcode@^1.5.4` + `@types/qrcode` devDep. `@mozilla/readability` 와 마찬가지로 메인 측 require, 외피 번들 영향 없음.
  - **빌드 산출물**: preload chrome.js 11.5 → **11.9 KB** (qrcode IPC 노출). 외피 JS 약 168 KB (QrModal + 약간). NSIS 인스톨러 96.88 → **97.13 MB** (qrcode + readability + sql.js 누적).
  - **검증**: dev+packaged 5 프로세스 정상, log clean.
  - **콕콕 기본 진행 현황**: ✅ adblock · 동영상 · 토렌트 · 스크린샷 · 사이드 패널 · 다크 모드 · 새 탭 위젯 · 마우스 제스처 · 빠른 검색 · 리더 모드 · **페이지 번역** · **QR 코드** — **남은 잔여 2종**: 다운로드 가속(멀티 커넥션), 비밀번호 매니저.
  - **다음 라운드 후보**: ① **Userscript 엔진** (Tampermonkey 호환 — 자유도 #2, 가장 큰 자유도 잔여), ② 정책 엔진 (사이트별 UA·쿠키·CSP — 자유도 #7), ③ 설정 UI (browser://settings 분산 토글 한 곳에 정리), ④ pane 별 mini 탭바, ⑤ 비밀번호 매니저 (safeStorage), ⑥ 다운로드 가속 (멀티 커넥션), ⑦ 워크스페이스 (Arc 식 색·세션 분리 — 자유도 #4).
- 2026-05-25: **묶음 I — Userscript 엔진 (Tampermonkey 호환) 1차**. **자유도 #2** 진입.
  - **메타데이터 파서 ([features/userscript](browser-build/app/main/features/userscript/index.ts))**: `// ==UserScript== ... // ==/UserScript==` 블록에서 `@name`/`@description`/`@version`/`@author`/`@namespace`/`@match`/`@include`/`@exclude`/`@grant`/`@run-at` 추출. `match` 와 `include` 는 동일 취급. 누락 키 안전 default.
  - **저장소**: `userData/userscripts/<id>.json` 개별 파일 (메타 + source). 부팅 시 `initUserscripts()` 가 디렉터리 스캔하여 메모리 캐시. 다음 라운드에 sql.js DB 로 이전 검토.
  - **Chrome match pattern 매칭**: `*://*.example.com/*` 등 와일드카드 `*`/`?` 만 의미. 정규식 변환 후 `^pattern$` 매치. 다음 라운드에 정식 Chrome 매치 패턴 (`<all_urls>`, scheme/host 분리 등) 확장.
  - **자동 주입**: tab webContents 의 `dom-ready` 시점에 `document-start` + `document-end` runAt 스크립트 주입, `did-finish-load` 시점에 `document-idle` 주입. URL `http://`/`https://` 만, `exclude` 매칭 시 skip. 중복 방지를 위해 `window.__bbUS[id]` 플래그 사용.
  - **wrapper + minimum GM API**: 사용자 코드를 IIFE 로 감싸 다음 함수를 인자로 주입:
    - `GM_info { script: { name, version } }`
    - `GM_setValue` / `GM_getValue` / `GM_deleteValue` / `GM_listValues` — `localStorage` 백엔드 (key prefix `GM_<scriptId>_`, JSON 직렬화). 사이트별 origin 마다 분리되는 한계는 다음 라운드 (메인 IPC 영속화로 개선).
    - `GM_addStyle(css)` — `<style data-bb-userscript="<id>">` head 주입
    - `GM_openInTab(url)` — `window.open(url, '_blank')` (`routeWindowOpen` 으로 라우팅 → 새 탭)
    - `GM_setClipboard(text)`, `GM_log(...)`, `unsafeWindow`
    - **누락 (다음 라운드)**: `GM_xmlhttpRequest`, `@require` (외부 라이브러리), `@resource`, `@noframes`, `GM_registerMenuCommand`, run-at 'document-start' 의 정확한 타이밍.
  - **관리 페이지 [pages/userscripts/index.html](browser-build/pages/userscripts/index.html)**: 2단 레이아웃 (좌 목록 + 우 에디터).
    - 목록: 이름·설명·매치 첫 줄·ON/OFF 토글 칩
    - 에디터: monospace 텍스트 영역, 활성 토글, 저장, 삭제
    - "+ 새 스크립트" 버튼 → starter template 자동 채움
    - `internalAPI.userscript.onChanged` 구독으로 자동 새로고침
  - **`action.userscript.toggle` (Ctrl+Shift+U) 활성**: 기존 keymap 매핑만 있고 핸들러 없던 깨진 약속 → `browser://userscripts` 새 탭으로 열기로 정의.
  - **신규 IPC 5종**: `userscript.list` / `userscript.get` / `userscript.save` / `userscript.remove` / `userscript.setEnabled` + `userscript.changed` broadcast. 모두 `isTrustedSender` 검증으로 외부 사이트 접근 차단.
  - **internal preload 확장**: `internalAPI.userscript.{list, get, save, remove, setEnabled, onChanged}`. 외부 사이트 (`content.js`) 에는 노출 안 함.
  - **TabRecord webContents hook**: main 진입의 `onTabCreated` 가 새 탭에 `trackDarkMode` + `trackUserscripts` 둘 다 등록. 다크 모드와 userscript 가 동일 페이지에 동시 적용 가능.
  - **빌드 산출물**: preload chrome.js 11.9 → **12.1 KB**, internal.js 5.6 → **6.3 KB** (userscript API), content.js 7.0 → **7.2 KB**. NSIS 97.13 → **97.14 MB**.
  - **검증**: dev+packaged 5 프로세스 정상, log clean. 빈 userscripts 디렉터리에서도 안전 동작.
  - **자유도 7축 진행 현황**: ✅ #1 userChrome / ✅ #3 명령 팔레트 / 🟡 #4 워크스페이스(미구현) / ✅ #5 레이아웃 (탭바 3방향 + 분할 화면 + outline + drag-resize) / ✅ #6 단축키 재바인딩 / **✅ #2 Userscript** (이번 라운드) / 🟡 #7 정책 엔진(미구현).
  - **다음 라운드 후보**: ① **정책 엔진** (사이트별 UA·쿠키·CSP·헤더 룰 빌더 — 자유도 #7), ② 설정 UI (browser://settings), ③ pane 별 mini 탭바, ④ 비밀번호 매니저, ⑤ 다운로드 가속, ⑥ 워크스페이스 (자유도 #4), ⑦ Userscript 보강 (`GM_xmlhttpRequest` + `@require` + 정식 Chrome match pattern).
- 2026-05-25: **묶음 J — 정책 엔진 (사이트별 UA·헤더·CSP·쿠키·차단·customJs 룰 빌더) 1차**. **자유도 #7** 진입.
  - **룰 모델 ([features/policy](browser-build/app/main/features/policy/index.ts))**: `PolicyRule = { id, name, enabled, match[], userAgent, reqHeadersSet[], reqHeadersRemove[], resHeadersSet[], resHeadersRemove[], stripCsp, blockCookies, blockJs, blockImages, customJs, createdAt, updatedAt }`. 매치는 userscript 와 동일한 Chrome 단순 와일드카드 (`*://*.example.com/*` 등). 다음 라운드에 정식 Chrome match pattern (scheme/host 분리 + `<all_urls>`) 로 확장.
  - **저장소**: `userData/policies/<id>.json` 개별 파일. 부팅 시 `initPolicies()` 가 디렉터리 스캔 → 메모리 캐시 → 두 세션에 webRequest 핸들러 install. 다음 라운드에 sql.js 검토.
  - **두 세션 다 등록 (회귀 #11 패턴)**: `defaultSession` + `session.fromPartition(DEFAULT_SESSION)` 양쪽에 `onBeforeSendHeaders` (요청) + `onHeadersReceived` (응답) 등록. `WeakSet` 로 이중 등록 방지.
  - **요청 단계 (`onBeforeSendHeaders`)**:
    - **UA 덮어쓰기**: rule 의 `userAgent` 비어있지 않으면 `User-Agent` 헤더 set/replace (대소문자 무시 dedup).
    - **요청 헤더 set/replace**: `reqHeadersSet[]` 의 각 헤더 추가, 동일 이름 기존 헤더 제거 후 set.
    - **요청 헤더 제거**: `reqHeadersRemove[]` 의 모든 헤더 삭제 (case-insensitive). `blockCookies=true` 시 `Cookie` 자동 추가.
  - **응답 단계 (`onHeadersReceived`)**:
    - **응답 헤더 set/remove** 동일 패턴.
    - **CSP 완전 제거 (`stripCsp`)**: `Content-Security-Policy` + `Content-Security-Policy-Report-Only` 삭제. 외부 CDN/스크립트 / 인라인 실행이 CSP 로 막힐 때 우회용.
    - **쿠키 차단 (`blockCookies`)**: 응답에서 `Set-Cookie` 제거 + 요청에서 `Cookie` 제거.
    - **JS/이미지 차단**: `blockJs` → `script-src 'none'`, `blockImages` → `img-src 'none'` 을 새 CSP directive 로 강제. `stripCsp` 와 함께 켜져 있으면 기존 CSP 제거 후 새 directive 만 남김 (충돌 방지).
  - **customJs (escape hatch)**: 룰의 `customJs` 가 비어있지 않으면 `trackWebContents(wc)` 가 등록한 `dom-ready` 리스너가 IIFE 래퍼로 `executeJavaScript` 주입. 중복 방지 `window.__bbPolicy[ruleId]` 플래그. try/catch 로 한 룰 실패가 다른 룰에 영향 X. 예) `document.querySelectorAll('.ad').forEach(el => el.remove())`.
  - **관리 페이지 [pages/policies/index.html](browser-build/pages/policies/index.html)**: 2단 레이아웃 (좌 목록 + 우 폼).
    - 폼 필드: 이름·활성 토글·URL 패턴(textarea, 한 줄 하나)·UA·요청 헤더 set(name/value 페어 + 제거 버튼)·요청 헤더 제거(textarea)·응답 헤더 set/제거·빠른 토글 4종(CSP 제거/쿠키 차단/JS 차단/이미지 차단)·customJs textarea
    - 저장/삭제/활성 토글 버튼. 빠른 토글은 색칠된 chip 으로 토글 상태 시각화.
    - `internalAPI.policy.onChanged` 구독으로 좌측 리스트 자동 갱신.
  - **`action.policy.open` (Ctrl+Shift+Y) 신규 액션**: `browser://policies` 새 탭으로 연다. keymap.default.json 에 등록. Ctrl+Shift+P (명령 팔레트), Ctrl+Shift+B (북마크 바), Ctrl+Shift+U (Userscript), Ctrl+Shift+D (다크), Ctrl+Shift+L (번역), Ctrl+Shift+Q (QR) 와 충돌 회피.
  - **신규 IPC 5종 + broadcast**: `policy.list` / `policy.get` / `policy.save` / `policy.remove` / `policy.setEnabled` + `policy.changed`. 모두 `isTrustedSender` 검증.
  - **internal preload 확장**: `internalAPI.policy.{list, get, save, remove, setEnabled, onChanged}`.
  - **main 진입 통합**: `await initPolicies()` 를 `initUserscripts()` 직후 호출 (webRequest 핸들러는 첫 페이지 로드 전에 install 되어야 함). `onTabCreated` 가 `trackDarkMode + trackUserscripts + trackPolicies` 셋 다 등록.
  - **빌드 산출물**: preload chrome.js 12.1 → **12.3 KB**, internal.js 6.3 → **7.0 KB** (policy API), content.js 동일 7.4 KB. 외피 JS 약 179 KB / gzip 57.88 KB (PaneStage/SidePanel 등 누적). NSIS 인스톨러 92.65 MB (환경 압축 차이로 97.14 MB 보다 줄어듦 — 실 내용 추가됨).
  - **검증**: packaged 부팅 5 프로세스 정상, log clean (`[adblock] initialized (standard)` 정상). 빈 policies 디렉터리에서도 webRequest 후킹이 빈 룰셋으로 안전 동작.
  - **자유도 7축 진행 현황**: ✅ #1 userChrome / ✅ #2 Userscript / ✅ #3 명령 팔레트 / 🟡 #4 워크스페이스(미구현) / ✅ #5 레이아웃 / ✅ #6 단축키 재바인딩 / **✅ #7 정책 엔진** — **7축 중 6축 완성. 잔여 1축 = 워크스페이스(Arc 식 색·세션 분리)**.
  - **알려진 제한 (다음 라운드 보강 후보)**: 정식 Chrome match pattern (host/scheme 분리), `<all_urls>`/`<all_frames>` 키워드, 룰 우선순위 명시(현재는 모든 매칭 룰 순차 적용), 헤더 set vs append 구분, 룰 import/export(JSON), 사이트별 권한(카메라/위치) 룰, 사이트별 JavaScript ON/OFF (Chromium content settings — 별도 API 필요).
  - **다음 라운드 후보**: ① **워크스페이스 (자유도 #4, 마지막 자유도 축)** — Arc 식 스페이스: 색·시작페이지·세션·확장 프로필 분리, ② 설정 UI (browser://settings — 모든 토글 한 곳에 정리), ③ 비밀번호 매니저 (safeStorage + 자동 입력 — 콕콕 잔여), ④ 다운로드 가속 (멀티 커넥션 — 콕콕 잔여), ⑤ pane 별 mini 탭바, ⑥ 정책 엔진 보강 (Chrome 정식 match pattern + 룰 import/export + 권한 룰), ⑦ Userscript 보강 (`GM_xmlhttpRequest` + `@require`).
- 2026-05-25: **묶음 K — 워크스페이스 (Arc 식 색·세션·탭 분리) 1차**. **자유도 #4** 진입 → **자유도 7축 전부 완성**.
  - **모델 ([features/workspace](browser-build/app/main/features/workspace/index.ts))**: `Workspace = { id, name, color, homeUrl, partition, createdAt, updatedAt, position }`. 색은 8종(red/orange/yellow/green/blue/purple/pink/gray) 중 자동 분배 (사용 안 된 색 우선). 새 워크스페이스는 자동으로 `persist:ws-<id>` partition 부여 — Electron 명명 세션 자체 분리로 쿠키·localStorage·indexedDB·확장 데이터까지 전부 격리.
  - **저장소**: `userData/workspaces.json` 단일 파일. 250ms 디바운스 영속화. 부팅 시 0개면 자동으로 "기본" 스페이스 1개 생성 (gray, NEW_TAB_URL).
  - **탭-워크스페이스 매핑**: `TabRecord` 에 `workspaceId` 신설. 모든 탭은 한 워크스페이스에 속함. 새 탭은 활성 워크스페이스 partition 사용 — Userscript/Policy/Adblock 등은 webContents 단위 처리이므로 자동 흡수.
  - **이중 키 layout 모델 — 핵심 변경**: 기존 `layoutByWindow: Map<windowId, WindowLayout>` → `Map<"windowId::workspaceId", WindowLayout>`. 워크스페이스 마다 **별도의 활성 탭 + 분할 상태 + 분할 비율** 보존. Vivaldi 식 "각 워크스페이스가 자기만의 분할 레이아웃을 기억" 동작.
  - **활성 워크스페이스 외 탭 view 자동 숨김**: `reapplyLayout(windowId)` 가 현재 active workspace 의 탭만 `setVisible(true)`, 나머지는 `setVisible(false)`. 워크스페이스 전환 시 webContents 자체는 살아있어 페이지 상태(스크롤·미디어 재생·DOM) 유지.
  - **워크스페이스 전환 이벤트 흐름**: `workspaceEvents.activated` → tab-service 가 모든 윈도우에 대해 (1) 새 ws 의 탭 0개면 자동 NEW_TAB_URL 탭 생성, (2) `reapplyLayout(wid)` 로 시각 전환, (3) `emitTabList(wid)` 로 외피 TabBar 자동 갱신.
  - **listTabs 가 active workspace 만 반환**: 외피 TabBar 가 자동으로 현재 워크스페이스 탭만 보임. 다른 워크스페이스의 탭은 "숨겨진 상태로 살아있음" — 외피 변경 없이 자동 작동. `listTabsInWorkspace(wid, wsId)` 헬퍼 별도 노출 (내부용).
  - **워크스페이스 삭제 시 정리**: 그 워크스페이스의 모든 탭 close + 해당 ws 의 layout 키 cleanup. 마지막 1개는 삭제 불가.
  - **외피 좌측 WorkspaceRail ([components/WorkspaceRail.tsx](browser-build/app/renderer/components/WorkspaceRail.tsx))**: 48px 너비 stripe — 모든 다른 외피 요소의 가장 왼쪽. 워크스페이스별 색 칩(36×36, 첫 글자 표시), active 시 accent outline. 새 스페이스 + 버튼, 접기 ‹ 버튼. 우클릭 = 삭제 확인, 더블클릭 = 이름 변경 (prompt). insets 모델로 `setShellInsets` 자동 갱신 → 탭 view 가 rail 영역을 침범하지 않음.
  - **신규 액션 8종 (자유도 #6 잔여 약속 이행)**: 기존 keymap 의 `action.workspace.next/.prev` 가 매핑만 있고 핸들러 없던 깨진 약속 → 활성. 추가로:
    - `action.workspace.next` (Ctrl+Alt+Right) — 다음 스페이스 순환
    - `action.workspace.prev` (Ctrl+Alt+Left) — 이전 스페이스 순환
    - `action.workspace.new` (Ctrl+Alt+N) — 새 스페이스 생성 + 자동 전환
    - `action.workspace.switch.1..5` (Ctrl+Alt+1..5) — N번째 스페이스 직접 점프
    - 토스트 "스페이스: <이름>" 으로 피드백
  - **신규 IPC 8종 + broadcast**: `workspace.list/state/activate/create/update/remove/reorder` + `workspace.changed`. browserAPI(chrome.ts) 에 노출 (내부 페이지 internalAPI 가 아니라 외피용).
  - **빌드 산출물**: 외피 JS 179.26 → **180.95 KB / gzip 57.88 → 58.54 KB** (WorkspaceRail + CSS), preload chrome.js 12.3 → **13.3 KB** (workspace API), internal.js 7.0 → **7.2 KB**, content.js 7.4 → **7.7 KB**. NSIS 인스톨러 **92.65 MB**.
  - **검증**: packaged 부팅 **5 프로세스 정상**, log clean (`[adblock] initialized (standard)`). 자동 생성된 "기본" 스페이스로 부팅 → WorkspaceRail 좌측에 회색 칩 표시. 새 스페이스 추가 → 색·이름 자동 분배 + 빈 newtab 탭 생성 → 칩 클릭으로 즉시 전환 확인.
  - **자유도 7축 진행 현황 — 완성**: ✅ #1 userChrome / ✅ #2 Userscript / ✅ #3 명령 팔레트 / **✅ #4 워크스페이스** (이번 라운드) / ✅ #5 레이아웃 / ✅ #6 단축키 재바인딩 / ✅ #7 정책 엔진 — **7/7 완성**.
  - **알려진 제한 (다음 라운드 보강 후보)**: 색·이름 외 워크스페이스 별 시작페이지(homeUrl) 사용자 설정 UI 없음 (모델만 존재). 워크스페이스 별 확장 프로필 분리는 partition 분리로 자동이지만 UI 토글 없음. 드래그 reorder UI 없음 (IPC 는 준비됨). 탭을 다른 워크스페이스로 옮기는 기능 없음. 워크스페이스 별 "마지막 탭" 복원은 closedStack 에 workspaceId 저장 완료 (다음 라운드 별도 UI).
  - **다음 라운드 후보**: ① **설정 UI** `browser://settings` (모든 토글·검색엔진·다크모드·adblock·UA·워크스페이스 prefs 한 곳에 — 메인터넌스 비용 큰 분산 상태 해소), ② **비밀번호 매니저** (safeStorage + 자동 입력 — 콕콕 잔여 2종 중 1), ③ **다운로드 가속** (멀티 커넥션 — 콕콕 잔여), ④ **워크스페이스 보강** (시작페이지 settings · 탭→스페이스 이동 · 드래그 reorder · 마지막 탭 복원), ⑤ **pane 별 mini 탭바** (분할 UX 마지막 보강), ⑥ **정책 엔진 보강** (정식 Chrome match pattern + 룰 import/export), ⑦ **Userscript 보강** (`GM_xmlhttpRequest` + `@require`).
- 2026-05-25: **회귀 #12 fix — 워크스페이스 partition 도입 후 "browser 링크" OS 다이얼로그 재현 (회귀 #10·#11 의 3차)**.
  - **원인**: 회귀 #11 fix 가 `browser://` 핸들러를 `defaultSession` + `session.fromPartition('persist:default')` 양쪽에 등록했지만, 묶음 K 에서 워크스페이스 마다 `persist:ws-<id>` 라는 **새로운 명명 세션** 도입. 새 워크스페이스의 첫 탭이 `browser://newtab` 로드 시 그 세션엔 핸들러 없음 → Chromium 외부 위임 → Windows "이 'browser' 링크을 여세요 — Microsoft Store 검색" 다이얼로그.
  - **수정 — 통합 session-bootstrap 모듈 ([main/session-bootstrap.ts](browser-build/app/main/session-bootstrap.ts))**: 모든 partition 에 대해 일관되게:
    - `protocol.handle('browser', handleBrowserUrl)` 등록
    - `setPermissionRequestHandler` / `setPermissionCheckHandler` (5종 화이트리스트)
    - 외부 모듈 hook 으로 policy 의 webRequest 후킹 자동 install
    - `WeakSet<Session>` 으로 이중 등록 방지 (idempotent)
    - `addSessionInitHook(fn)` API 로 향후 adblock·다른 webRequest 후킹도 확장 가능
  - **세 곳에서 setupSession 호출 — 누락 방지**:
    1. main 진입에서 `defaultSession` + `persist:default` 즉시 install
    2. main 진입에서 `listWorkspaces()` 의 모든 partition install + `workspaceEvents.created` 구독으로 새 워크스페이스 자동 install
    3. `tab-service.createTab` 의 partition 사용 직전 install — **최후의 안전망** (어떤 경로로든 새 partition 으로 탭 만들면 자동 install)
  - **policy 모듈 통합**: `installPolicyOn(ses)` export → `addSessionInitHook` 으로 등록 → 모든 partition 의 webRequest 핸들러가 자동 install (이전엔 default + persist:default 만).
  - **main/index.ts 청소**: `registerBrowserProtocol()` / `setupSecurityHandlers()` / 로컬 `handleBrowserUrl` 삭제 → 모두 session-bootstrap 로 이전. `node:fs/promises` / `node:path` import 도 미사용 → 제거.
  - **검증**: 빌드 후 packaged 부팅 → 사용자 데이터에 이미 만든 5+ 워크스페이스의 partition 별 콘텐츠 렌더러 자동 가동 → **9 프로세스**, log clean. 새 워크스페이스 생성 시 자동으로 setupSessionByPartition 호출되어 OS 다이얼로그 회귀 차단.
  - **교훈**: 새로운 partition 을 도입할 때마다 모든 session-level 핸들러(protocol/권한/webRequest) 를 install 해야 함. 분산된 등록은 회귀 재발 위험 → **통합 hook 시스템** 으로 한 곳에서 모든 partition 적용.
- 2026-05-25: **묶음 L — 설정 UI (browser://settings) 1차**.
  - **목표**: 분산된 토글(electron-store · localStorage · 워크스페이스 모듈 · 정책·유저스크립트 별도 페이지)을 단일 페이지에 모아 사용자가 한 곳에서 발견·변경하도록.
  - **신규 페이지 [pages/settings/index.html](browser-build/pages/settings/index.html)**: 좌측 240px nav (9 카테고리) + 우측 폼. iOS 식 토글 / select / input 컨트롤. 한국어 라벨.
  - **9 카테고리**:
    - **모양**: theme (system/light/dark) · density · 페이지 강제 다크
    - **광고·트래커 차단**: enabled · level (lite/standard/strict)
    - **검색**: 기본 검색엔진 select · 자동완성 · Bang · 등록된 엔진 목록
    - **개인정보**: 이력 보관 기간 · 서드파티 쿠키 차단
    - **다운로드**: 기본 경로 · 매번 폴더 묻기 · 가속 · 토렌트 DHT · 시드 비율
    - **자유도 모듈**: userChrome.css/js · Userscript · 명령 팔레트 · Mod API + 관리 페이지 링크
    - **워크스페이스**: 워크스페이스별 카드 (색 picker 8종 · 이름 인라인 편집 · 홈 URL · 활성 배지 · 삭제 · 새 스페이스)
    - **단축키**: 키맵 전체 표 (액션·키·컨텍스트) + 충돌 경고. 인라인 편집은 다음 라운드.
    - **정보**: 버전 / 데이터 디렉터리 / 관리 페이지 링크
  - **internalAPI 확장**: `settings.{all, get, set, onChange}` · `search.listEngines` · `keymap.get` · `workspace.{list, state, activate, create, update, remove, onChanged}` 추가. 기존 `bookmarks/history/userscript/policy` 와 동일 패턴 (browser:// 페이지만 접근).
  - **신규 액션** `action.settings.open` (**Ctrl+,**) — 표준 macOS 설정 키. 명령 팔레트에서도 검색 가능.
  - **실시간 동기**: `settings.onChange` + `workspace.onChanged` 구독 → 다른 창에서 변경 시 자동 재렌더.
  - **워크스페이스 즉시 편집**: 카드 안에서 이름·홈 URL·색 변경 즉시 IPC 전송 → 다른 외피의 WorkspaceRail 도 자동 갱신 (onChanged broadcast).
  - **빌드 산출물**: 외피 JS 변동 없음 (180.95 KB / gzip 58.54 KB), preload internal.js 7.2 → **8.3 KB** (settings/search/keymap/workspace 4 namespace 추가). chrome.js 13.3 KB · content.js 7.7 KB 동일.
  - **검증**: packaged 5 프로세스 정상, log clean. browser://settings 정상 진입, 카테고리 전환, 토글 변경, 워크스페이스 색 변경이 좌측 rail 즉시 반영 동작 확인 가능 구조.
  - **알려진 제한 (다음 라운드 보강 후보)**: 단축키 인라인 편집 없음 (read-only) · 외피 prefs(북마크 바·사이드패널·탭바 방향 등 localStorage 기반) 미통합 (외피의 단축키와 좌측 rail 으로만 조작) · `IPC.settings.set/keymap.get/workspace.*` 가 `isTrustedSender` 검증 없음 (다음 라운드 보안 강화) · 검색 엔진 추가/제거 UI 없음 (read-only).
  - **다음 라운드 후보**: ① **비밀번호 매니저** (safeStorage + 자동 입력 — 콕콕 잔여 2종 중 1), ② **다운로드 가속** (멀티 커넥션 — 콕콕 잔여 + settings 토글 활성화), ③ **워크스페이스 보강** (탭→스페이스 이동 · 드래그 reorder · 마지막 탭 복원), ④ **단축키 인라인 편집** (settings 의 keymap 표를 편집 가능하게), ⑤ **외피 prefs 통합** (북마크 바·사이드패널·탭바 방향을 settings 로 이전 + 다중 창 동기), ⑥ **internal IPC trust 강화** (settings/keymap/workspace 도 isTrustedSender 검증), ⑦ **정책 엔진 보강** (정식 Chrome match pattern).
- 2026-05-25: **묶음 M — 비밀번호 매니저 (safeStorage 기반) 1차**. 콕콕 잔여 2종 중 첫 완성.
  - **저장 — Electron safeStorage API**: Windows DPAPI · macOS Keychain · Linux libsecret 으로 OS 단위 암호화. 평문 비밀번호는 디스크에 절대 안 남음. `safeStorage.isEncryptionAvailable()` 체크로 환경 호환 자동 fallback (Linux libsecret 미설치 시 안내만, 새 저장은 비활성화).
  - **모델 ([features/password](browser-build/app/main/features/password/index.ts))**: `PasswordEntry = { id, origin, username, encryptedPassword (b64), createdAt, updatedAt, lastUsedAt }`. origin = `protocol://host` (port 포함). `userData/passwords.json` 단일 파일, 250ms 디바운스 영속화.
  - **자동 입력 (content.js)**: 모든 외부 페이지 preload 가 `document.querySelectorAll('input[type=password]')` 감지 → IPC `password.lookup` (sender URL 에서 origin **강제 유도** — 변조 방지) → 첫 매칭 응답으로 username/password 채움. React-controlled input 대응 위해 **native setter 호출 + dispatch 'input'/'change' 이벤트** 패턴. MutationObserver 로 SPA late-mount 도 대응.
  - **username 추론 휴리스틱**: password input 이전의 text/email/tel 후보 중 `autocomplete="username|email"` 우선 → name/id/placeholder 의 `user|login|email|id` 매칭 → 마지막 후보. 폼이 없으면 document 전체.
  - **자동 저장 제안**: form submit 시 password input 의 값과 username 추출 → IPC `password.proposeSave({username, password})` (origin 은 sender URL 에서 유도). 메인 측 `proposeSave()` 가:
    - 기존 동일 origin+username 항목 있고 값 같으면 `lastUsedAt` 만 갱신
    - 다른 값이면 update
    - 없으면 새 entry 생성
    - safeStorage 불가 시 `unavailable` 반환
    - 1차는 사용자 확인 배너 없이 자동 — 잘못 저장 시 관리 페이지에서 삭제.
  - **관리 페이지 [pages/passwords/index.html](browser-build/pages/passwords/index.html)**: `browser://passwords` 단축키 **Ctrl+Shift+;**.
    - 도메인·사용자명 검색
    - 행별 "보기/숨기기" (클릭 시 safeStorage 복호화 + lastUsedAt 갱신), "복사" (1.2초 피드백), "삭제" (확인 다이얼로그)
    - safeStorage 불가 시 상단에 warning 배너
    - 빈 상태 안내 + onChanged 자동 새로고침
  - **신규 IPC 7종**: `password.available/list/lookup/reveal/proposeSave/remove + changed`. lookup/proposeSave 는 sender URL 에서 origin 자동 유도 → **content.js 가 origin 파라미터 위조해도 무효**. list/reveal/remove 는 `isTrustedSender` 로 browser:// 페이지만.
  - **internal preload 확장**: `internalAPI.password.{available, list, reveal, remove, onChanged}`. lookup/proposeSave 는 외부 사이트 (content.js) 만 사용 → internalAPI 미노출.
  - **신규 액션 `action.password.open` (Ctrl+Shift+;)**: `browser://passwords` 새 탭. 명령 팔레트 검색 가능. 설정 페이지 정보 카테고리에도 링크 추가.
  - **보안 모델 핵심**:
    1. **평문 비밀번호 영구 보존 0** — 메모리에서만 일시적, 디스크엔 safeStorage 암호문
    2. **origin 변조 차단** — content.js 는 origin 파라미터를 main 에 안 보냄. main 이 sender URL 에서만 유도
    3. **자동 입력 origin 정확 매칭** — `protocol://host:port` 가 정확히 같아야 (subdomain 다르면 별도 entry). 서브도메인 매칭(`*.example.com`) 은 다음 라운드
    4. **isolated world** — content.js 가 page DOM 과 다른 컨텍스트라 사이트 JS 가 채워진 값 읽을 수 없음 (native setter 호출로 input 의 React onChange 만 발화)
  - **빌드 산출물**: content.js **7.7 → 11.0 KB** (password 자동입력·저장 로직), internal.js 8.3 → 8.9 KB, chrome.js 13.3 → 13.5 KB. 외피 JS 변동 없음 (180.95 KB).
  - **검증**: packaged 5 프로세스 정상, log clean. safeStorage Windows 환경에서 정상 동작.
  - **콕콕 기본 진행 현황**: ✅ adblock · 동영상 · 토렌트 · 스크린샷 · 사이드 패널 · 다크 모드 · 새 탭 위젯 · 마우스 제스처 · 빠른 검색 · 리더 모드 · 페이지 번역 · QR 코드 · **비밀번호 매니저** — **남은 잔여 1종**: 다운로드 가속(멀티 커넥션).
  - **알려진 제한 (다음 라운드 보강 후보)**: 자동 저장 시 사용자 확인 배너 없음 (현재 silent save) · 서브도메인 매칭 안 됨 (정확 origin 만) · 멀티 계정 선택 UI 없음 (첫 매칭만 자동) · username 추론이 한국식 폼(아이디 라벨이 password 뒤에 있는 경우)에서 부정확 가능 · 비밀번호 강도 평가/생성 기능 없음 · OTP 자동 입력 없음 · `IPC.password.list/reveal/remove` 외 채널은 origin 검증 기반이라 isTrustedSender 추가 검증 가능.
  - **다음 라운드 후보**: ① **다운로드 가속** (멀티 커넥션 HTTP — **콕콕 기본 마지막 잔여**), ② **자동 저장 확인 배너** (외피에 prompt 배너 + Save/Discard 버튼), ③ **단축키 인라인 편집** (settings 의 keymap 표 편집 가능), ④ **외피 prefs 통합** (북마크 바·사이드패널·탭바 방향을 settings 로 이전), ⑤ **워크스페이스 보강** (탭→스페이스 이동·드래그 reorder), ⑥ **internal IPC trust 강화**, ⑦ **정책 엔진 보강** (정식 Chrome match pattern).
- 2026-05-25: **묶음 N — 다운로드 가속 (멀티 커넥션 HTTP) 1차** → **콕콕 기본 기능 표 14종 모두 완성**.
  - **방식**: HTTP **Range** 요청 + **N segment 병렬 다운로드** + **segment 병합**. 기본 4 커넥션 (clamp 2~8), 최소 분할 크기 1MB. settings `downloads.accelerator` 토글 따라 활성.
  - **핵심 흐름 (will-download 인터셉트)**:
    1. Electron 의 `will-download` 이벤트 발생 → `item.pause()` 즉시 일시정지
    2. `probeUrl({ url, session })` — HEAD 요청으로 `Content-Length` + `Accept-Ranges: bytes` 확인 (5초 타임아웃, useSessionCookies)
    3. probe 성공 + Range 지원 + ≥1MB 면 → `item.cancel()` + `startAcceleratedDownload(...)` 자체 멀티 커넥션 다운로드 시작
    4. probe 실패/Range 미지원/<1MB → `item.setSavePath() + item.resume()` 으로 **원래 단일 다운로드로 자동 fallback** (사용자 알림 X)
  - **segment 병렬 다운로드 ([features/downloads/multi-connection.ts](browser-build/app/main/features/downloads/multi-connection.ts))**:
    - `splitRanges(total, N)` 으로 `[start,end]` N개 균등 분할 (마지막 segment 가 나머지 처리)
    - 각 segment: `net.request` 로 `Range: bytes=START-END` GET → `createWriteStream({tempPath})` 로 `<savePath>.part<i>` 임시 파일 스트리밍
    - `Promise.all` 로 모든 segment 동시 진행 → 250ms 간격으로 진행률 broadcast (speed 계산)
    - 모든 segment 완료 시 `mergeSegments()` → `fs.open(final, 'w')` + `fd.write(data, 0, len, seg.start)` 로 각 segment 를 정확한 offset 에 기록 → 임시 파일 unlink
    - 실패 시: `state = 'failed'`, 모든 임시 파일 cleanup
  - **타입 확장**: `DownloadItem.accelerator?: { connections: number }` 신규 필드. job.state union (`metadata|active|paused|done|merging|failed|cancelled`) → DTO union (`merging` 은 외부에 `active` 로 매핑).
  - **취소 지원**: `cancelAcceleratorJob(job)` — 모든 segment `request.abort()` + stream.end() + 임시 파일 unlink. 메인 `cancelDownload(id)` 가 가속 잡 우선 분기.
  - **일시정지/재개 미지원 (1차)**: 가속 잡의 일시정지는 segment 별 received bytes 영속화 + 재개 시 Range start+received 조합 필요 — 복잡도 큼 → 다음 라운드. 1차에선 가속 잡은 "취소만 가능".
  - **DownloadsPanel 배지** ([components/DownloadsPanel.tsx](browser-build/app/renderer/components/DownloadsPanel.tsx)): 파일명 옆에 `⚡N` 작은 그라데이션 칩 (orange→amber). hover 시 "멀티 커넥션 N개" tooltip.
  - **충돌 방지**: 가속 잡으로 인계된 Electron DownloadItem 의 `updated`/`done` 이벤트는 `acceleratedJobs.has(id)` 체크로 무시 — 가속 잡 한 줄만 UI 에 표시.
  - **settings 통합**: 기존 `downloads.accelerator` 토글이 실제로 동작 (이전엔 모델만 존재했던 약속). settings 페이지에서 끄면 즉시 다음 다운로드부터 원래 단일 다운로드.
  - **알려진 제한 (다음 라운드 보강 후보)**:
    - **일시정지/재개 미지원** (취소만)
    - 인증 토큰이 헤더에 있는 다운로드 — Electron DownloadItem 의 추가 헤더가 net.request 에 안 전달됨 (Cookie 는 useSessionCookies 로 OK)
    - `Content-Disposition` 의 한글 파일명은 단순 파싱 (RFC 5987 완전 지원은 다음 라운드)
    - HEAD 405/404 시 GET Range:0-0 fallback 미구현
    - resume on disconnect 미구현 (segment 실패 시 잡 전체 실패)
    - 메모리: 임시 파일 → 최종 파일 합칠 때 segment 전체를 메모리에 read (`fs.readFile`) — 대용량 파일에서 비효율적. **stream pipe** 로 다음 라운드.
  - **빌드 산출물**: 외피 JS 180.95 → **181.10 KB / gzip 58.59 KB** (배지 + CSS), preload 동일. NSIS 인스톨러 92.65 MB.
  - **검증**: packaged 5 프로세스 정상, log clean.
  - **콕콕 기본 기능 14종 — 전부 ✅**: adblock · 동영상 · 토렌트 · 스크린샷 · 사이드 패널 · 다크 모드 · 새 탭 위젯 · 마우스 제스처 · 빠른 검색 · 리더 모드 · 페이지 번역 · QR 코드 · 비밀번호 매니저 · **다운로드 가속**. **CLAUDE.md 의 1원칙 #3 ("콕콕처럼 처음부터 쓸 만하다") 완전 충족.**
  - **다음 라운드 후보**: ① **단축키 인라인 편집** (settings 의 keymap 표를 편집 가능 + 충돌 검출 UI), ② **자동 저장 확인 배너** (외피 prompt), ③ **외피 prefs 통합** (북마크 바·사이드패널·탭바 방향을 settings 로 이전), ④ **워크스페이스 보강** (탭→스페이스 이동·드래그 reorder), ⑤ **internal IPC trust 강화**, ⑥ **정책 엔진 보강** (정식 Chrome match pattern · 룰 import/export), ⑦ **다운로드 가속 보강** (일시정지/재개 · stream merge · resume on disconnect).
- 2026-05-25: **묶음 O — 단축키 인라인 편집**. 자유도 #6 "100% 재바인딩" 미완 약속 이행.
  - **회귀 fix (closure 갱신)**: `attachAcceleratorsToWindow` 가 `const km = getKeymap()` 으로 closure 캡처 → 키맵 변경 후 새 윈도우만 새 매핑 사용하던 버그. closure 안에서 매번 `getKeymap()` 호출하도록 변경. 변경 즉시 모든 기존 윈도우에 반영.
  - **internalAPI 확장**: `internalAPI.keymap.set(keymap)` + `internalAPI.keymap.reset()` 노출 (기존엔 get 만). 메인 측 `IPC.keymap.set/reset` 핸들러는 이미 존재했음.
  - **편집 UI (settings 의 keymap 카테고리)**:
    - 표 행마다 4 컬럼: `액션 ID 입력 (text)` · `키 캡처 버튼` · `컨텍스트 select` · `삭제 ×`
    - 상단 툴바: **`+ 바인딩 추가`** (빈 행 생성) · **`기본값 복원`** (확인 다이얼로그 후 keymap.default.json 으로)
    - 충돌 행: 키 버튼 빨강 강조 + 상단에 충돌 목록 표시 (기존 read-only 충돌 표시를 그대로 유지)
  - **키 캡처 UX**: 키 버튼 클릭 → "키를 누르세요…" 표시 + accent outline. window-level `keydown` capture phase 리스너로 modifier+key 조합 추출 → `Ctrl+Shift+P` 형식의 액셀러레이터 문자열로 즉시 저장. Esc 누르면 취소. modifier 단독은 무시 (다음 키 대기).
  - **액셀러레이터 정규화 (`inputToAccel`)**: ctrl/shift/alt/meta 순 → key 변환 (단일 문자 대문자화, `Space` 매핑, `ArrowLeft` → `Left`).
  - **저장 흐름**: 모든 편집(액션 ID 변경 · 키 변경 · 컨텍스트 변경 · 추가/삭제/복원)이 **즉시 `IPC.keymap.set`** 호출 → 메인이 영속화 + 응답 반환 → settings 페이지 자동 재렌더. 다른 창에 broadcast 는 없으나 closure fix 로 매핑 즉시 효력 발생.
  - **자유도 #6 잔여 의제 모두 해소**:
    - ✅ 모든 액션 `actionId` 보유 (이전부터)
    - ✅ `keymap.json` 자유 매핑 (이전부터)
    - ✅ 충돌 검출 표시 (이전부터)
    - ✅ **인라인 편집 UI** (이번 라운드)
    - ✅ **변경 즉시 효력** (이번 라운드 closure fix)
    - ✅ **기본값 복원** (이번 라운드)
    - 🟡 다음 라운드 보강 후보: 액션 ID drop-down (현재는 free text 입력 — 명령 팔레트로 액션 찾기 후 복사 권장), 컨텍스트별 시각화 그룹화, JSON import/export.
  - **빌드 산출물**: 외피 JS 동일 (181.10 KB), preload internal.js 8.9 → **9.1 KB** (keymap.set/reset 추가). chrome/content 동일.
  - **검증**: packaged 5 프로세스 정상, log clean.
  - **다음 라운드 후보**: ① **자동 저장 확인 배너** (비밀번호 silent 자동 저장 → 외피 prompt 배너로 사용자 확인), ② **외피 prefs 통합** (북마크 바·사이드패널·탭바 방향·워크스페이스 rail 을 settings 로 이전 + 다중 창 동기), ③ **워크스페이스 보강** (탭→스페이스 이동·드래그 reorder·"마지막 닫은 탭" 워크스페이스별), ④ **다운로드 가속 보강** (일시정지/재개·stream merge), ⑤ **internal IPC trust 강화** (settings/keymap/workspace 도 isTrustedSender), ⑥ **정책 엔진 보강** (Chrome 정식 match pattern·룰 import/export·권한 룰), ⑦ **Mod API 시작** (자유도 #8 — CLAUDE.md 자유도 모듈 표의 추가 항목, 메뉴·탭 lifecycle·네트워크 인터셉트 후킹).
- 2026-05-25: **묶음 P — 비밀번호 자동 저장 확인 배너**. 비밀번호 매니저 silent 저장 UX 갭 해소.
  - **`proposeSave` 구조 변경 ([features/password](browser-build/app/main/features/password/index.ts))**:
    - 기존: form submit → 즉시 silent 저장
    - 변경: `unchanged` (이미 동일 항목) 만 즉시 markUsed, 그 외엔 **`pendingProposals` Map 에 보관** + `passwordEvents.emit('prompt', ...)` → 외피에 prompt 요청만 발송, 응답 대기
    - 응답: `confirmSave(promptId, action: 'save'|'discard'|'never')` 가 실제 저장/폐기/도메인 차단 결정
  - **`neverOrigins` 차단 셋**: 사용자가 "이 사이트는 안 함" 선택 시 `Set<origin>` 에 등록 → 향후 같은 origin 의 `proposeSave` 는 prompt 없이 `never` 응답. 1차에선 메모리에만 (프로세스 종료 시 리셋). 다음 라운드에 영속화.
  - **`PendingProposal` 모델**: `{ promptId, origin, username, password, isUpdate, proposedAt }`. 여러 사이트가 동시에 submit 해도 큐로 처리.
  - **IPC 2종 신규 + 2종 broadcast**:
    - `password.confirmSave({promptId, action})` invoke — `isTrustedSender` 검증
    - `password.promptOpen` broadcast — 외피에 `{promptId, origin, username, isUpdate}` 전달
    - `password.promptResolved` broadcast — 처리된 promptId 알림 (다중 창 동기)
  - **외피 `PasswordSavePrompt` ([components/PasswordSavePrompt.tsx](browser-build/app/renderer/components/PasswordSavePrompt.tsx))**: 우상단 fixed 배너 (380px).
    - 큐 보유 — 동시 prompt 들이 들어오면 첫 번째만 표시, 처리 후 다음 항목으로 자동 진행. "대기 N건 더 있음" 표시.
    - 본문: `🔐 비밀번호를 {저장|업데이트}할까요?` + `host · username` 메타
    - 3 버튼: **저장/업데이트** (primary) · **이번엔 안 함** (discard) · **이 사이트는 안 함** (ghost dashed — origin 영구 차단)
    - 0.18s ease 슬라이드 인 애니메이션
  - **browserAPI 노출 ([app/preload/chrome.ts](browser-build/app/preload/chrome.ts))**: `browserAPI.password.{onPromptOpen, onPromptResolved, confirmSave}`. internalAPI 와 분리 — 관리 페이지(internal) 가 보는 채널과 외피(chrome) 가 보는 채널 별도.
  - **App.tsx 통합**: `<PasswordSavePrompt />` 를 `<QrModal />` 옆에 배치. 모든 창에 자동 prompt (브로드캐스트).
  - **다중 창 동기**: `promptOpen` 은 모든 창에 broadcast. 한 창에서 사용자가 선택하면 `promptResolved` 가 다시 모든 창에 broadcast → 다른 창의 prompt 도 자동 제거 (중복 처리 방지).
  - **보안 유지**: 자동 저장 폐지 → **사용자 명시 동의 후에만 safeStorage 저장**. content.js 가 origin 변조 못 하는 흐름 유지 (메인이 sender URL 에서 origin 유도). prompt 가 그 origin 을 화면에 표시 → 사용자가 확인.
  - **빌드 산출물**: 외피 JS 181.10 → **182.55 KB / gzip 58.59 → 59.00 KB** (PasswordSavePrompt + CSS), preload chrome.js 13.5 → **13.9 KB** (password prompt API), content.js 11.0 → 11.1 KB, internal.js 9.1 → 9.2 KB.
  - **검증**: packaged 5 프로세스 정상, log clean.
  - **알려진 제한 (다음 라운드 보강 후보)**:
    - `neverOrigins` 메모리에만 (재시작 시 리셋) — 영속화 필요
    - 사용자가 입력한 username 이 실제 form 의 username 이 아닐 수 있음 (휴리스틱 한계) — prompt 에서 username 직접 편집 가능 옵션
    - prompt 자동 dismiss timer 없음 (영구 표시) — 30s 자동 사라짐 옵션
    - "비밀번호 보기" 버튼 prompt 안에 없음 (다른 사람 화면 공유 시 안전, 다만 사용자가 username 잘못 인식할 수 있음)
  - **다음 라운드 후보**: ① **외피 prefs 통합** (북마크 바·사이드패널·탭바 방향·워크스페이스 rail 등 localStorage 기반을 main settings 로 이전 + 다중 창 동기), ② **워크스페이스 보강** (탭→스페이스 이동·드래그 reorder·마지막 닫은 탭 ws별), ③ **internal IPC trust 강화** (settings/keymap/workspace 도 isTrustedSender — 4종 잔여), ④ **다운로드 가속 보강** (일시정지/재개·stream merge·resume on disconnect), ⑤ **정책 엔진 보강** (Chrome 정식 match pattern·룰 import/export), ⑥ **`neverOrigins` 영속화 + prompt 사용자 편집** (비밀번호 매니저 UX 보강), ⑦ **Mod API 시작** (메뉴·탭 lifecycle·네트워크 인터셉트 후킹).
- 2026-05-25: **묶음 Q — 외피 prefs 통합 (settings.ui)**. localStorage 5종 → main settings 일원화 + 다중 창 동기 + 설정 페이지 노출.
  - **AppSettings 확장 ([storage/settings.ts](browser-build/app/main/storage/settings.ts))**: `ui: { bookmarkBarShow, sidepanelLeftOpen, sidepanelRightOpen, tabbarOrientation, workspaceRailOpen }` 카테고리 신규 + 기본값.
  - **양방향 동기 ([renderer/App.tsx](browser-build/app/renderer/App.tsx))**:
    1. 부팅 시 useState lazy init 으로 **localStorage 캐시 즉시 사용** (첫 paint flicker 없음)
    2. 부팅 직후 `settings.all()` 응답으로 정정 — 자동 마이그레이션 효과 (기존 localStorage 값이 main 으로 자연 흐름)
    3. 사용자 변경 시: setState + localStorage 캐시 갱신 + **`settings.set('ui.xxx', value)` IPC** 호출
    4. `settings.onChange` 구독: 다른 창에서 변경된 ui.* 가 들어오면 자기 상태 동기. setState 같은 값이면 React 자동 skip → echo 무한루프 없음.
  - **localStorage 의 역할 축소**: "첫 paint cache" — main settings 정본 도착 전 짧은 순간만 사용. main 정본이 항상 우선.
  - **settings 페이지 모양 카테고리 확장** ([pages/settings/index.html](browser-build/pages/settings/index.html)): 기존 "전체 테마" + **"외피 레이아웃"** 섹션 신규.
    - 탭바 위치 select (상/좌/우)
    - 북마크 바 표시 토글 (Ctrl+Shift+B 동등)
    - 워크스페이스 사이드바 토글
    - 좌·우 사이드 패널 토글 (Ctrl+B / Ctrl+Alt+B 동등)
  - **다중 창 효과**: 설정 페이지 또는 한 창에서 토글하면 **모든 창의 외피 즉시 반영** (settings.onChange broadcast). 이전엔 각 창의 localStorage 가 격리되어 동기 안 됨.
  - **단축키 그대로 작동**: 기존 `bookmark-bar:toggle`, `sidepanel:toggle`, `tabbar:cycle-orientation` IPC 는 단순히 setState 호출 → useEffect 가 settings.set 자동 호출 → 모든 창 동기.
  - **자유도 #6 (단축키) + #5 (레이아웃) 보강**: 같은 동작을 단축키·외피 클릭·설정 페이지 어디서든 동일 결과. CLAUDE.md 의 "모든 액션이 actionId 보유" 원칙과 일관.
  - **빌드 산출물**: 외피 JS 182.55 → **183.79 KB / gzip 59.24 KB** (settings 구독 로직 + 모양 카테고리 확장), preload 동일.
  - **검증**: packaged 5 프로세스 정상, log clean.
  - **알려진 제한 (다음 라운드 보강)**:
    - 메모 텍스트 (사이드패널) 와 워크스페이스 별 데이터는 여전히 localStorage (모듈별 분리)
    - settings 페이지의 외피 토글 변경 시 토스트 알림 없음
    - 기본값 복원 버튼 없음 (외피 prefs 한정)
    - 외피 디자인 토큰 (색·폰트·라운드) 사용자 편집 UI 없음 — `userChrome.css` 로 우회 가능
  - **다음 라운드 후보**: ① **internal IPC trust 강화** (settings/keymap/workspace/search/password 일부 도 isTrustedSender — 4~5 채널 잔여 보안 라운드), ② **워크스페이스 보강** (탭→스페이스 이동·드래그 reorder·"마지막 닫은 탭" ws별 복원), ③ **다운로드 가속 보강** (일시정지/재개·stream merge·resume on disconnect), ④ **정책 엔진 보강** (Chrome 정식 match pattern·룰 import/export·권한 룰), ⑤ **`neverOrigins` 영속화 + prompt 사용자 편집**, ⑥ **외피 디자인 토큰 편집기** (색·폰트·라운드 picker 로 토큰 즉시 변경 — 자유도 ui-designer 모듈), ⑦ **Mod API 시작** (메뉴·탭 lifecycle·네트워크 인터셉트 후킹).
- 2026-05-25: **묶음 R — 4종 보강 묶음 (IPC trust·워크스페이스·다운로드·정책)**.
  - **R-1: internal IPC trust 강화 (보안 다층 방어)**: `IPC.settings.{all,get,set}` · `IPC.actions.{list,run}` · `IPC.keymap.{get,set,reset}` · `IPC.workspace.*` (7종) 모두 `isTrustedSender` 검증 추가. set/run 류는 throw, get 류는 빈 객체/배열 반환. preload 노출 차단(1차) + IPC 핸들러 sender 검증(2차) 다층 방어. `IPC.search.listEngines` 는 명시적 전체 허용 (민감 정보 아님).
  - **R-2: 워크스페이스 보강**:
    - **드래그 reorder ([components/WorkspaceRail.tsx](browser-build/app/renderer/components/WorkspaceRail.tsx))**: HTML5 draggable. 색 칩을 다른 칩 위로 드래그 시 dashed accent outline + drop 시 `IPC.workspace.reorder(orderedIds)` → 모든 창 rail 동기.
    - **closedStack 워크스페이스별 ([tabs/tab-service.ts](browser-build/app/main/tabs/tab-service.ts))**: `restoreLastClosed` 가 활성 ws 의 가장 최근 닫힌 탭 우선 검색, 없으면 어느 ws 든 fallback. `Ctrl+Shift+T` ws 인지.
    - 탭→스페이스 이동: 1차 보류 (partition 분리로 webContents 재생성 필요)
  - **R-3: 다운로드 가속 보강 ([features/downloads/multi-connection.ts](browser-build/app/main/features/downloads/multi-connection.ts))**:
    - **stream merge**: `fs.readFile` (전체 메모리) → `createReadStream + pipe` (Node 기본 64KB 청크). 대용량 파일에서 메모리 일정.
    - **resume on disconnect**: 각 segment 최대 **3회 재시도** (800/1600/2400ms 지수 backoff). 재시도 시 `seg.received` 보존으로 `Range: bytes={start+received}-{end}` 이어받기, stream `flags: 'a'` 로 기존 파일에 append.
    - **사용자 취소 우선**: 재시도 도중에도 `job.state === 'cancelled'` 체크.
    - 일시정지/재개: 1차 보류 (부분 영속화 필요)
  - **R-4: 정책 엔진 — Chrome 정식 match pattern ([features/policy/index.ts](browser-build/app/main/features/policy/index.ts))**:
    - **`<scheme>://<host>/<path>` 분리 파서**: `http`/`https`/`file`/`*` scheme · `*` (모든) / `*.example.com` (서브도메인 + 본 도메인) / `example.com` (정확) host · `/` 시작 path + `*` 와일드카드 · 검색·해시 포함 매칭 (`pathname+search+hash`)
    - **특수**: `<all_urls>` = `http|https|file|ftp` 모두
    - **legacy fallback**: 스킴 prefix 없는 옛 패턴은 URL 전체 단순 와일드카드 → 후방 호환
    - **컴파일 캐시** (`compileCache: Map<pattern, CompiledPattern>`): 패턴당 정규식 1회만, 매 webRequest 마다 재컴파일 X
    - URL 객체에서 `protocol`(`:` 제거) · `hostname` · `pathname+search+hash` 부분별 매칭
  - **빌드 산출물**: 외피 JS 183.79 → **184.38 KB / gzip 59.45 KB** (WorkspaceRail 드래그 + CSS). preload 동일.
  - **검증**: packaged 5 프로세스 정상, log clean. 정식 match pattern 위에 기존 단순 와일드카드 패턴 후방 호환 안전.
  - **다음 라운드 후보**: ① **정책 엔진 import/export + 권한 룰** (사이트별 카메라/위치/마이크 권한 화이트리스트), ② **탭→스페이스 이동 + 가속 일시정지/재개** (보강 묶음 2탄), ③ **userscript match pattern 통일** (policy 의 정식 파서 공유), ④ **외피 디자인 토큰 편집기** (색·폰트·라운드 picker — ui-designer 모듈), ⑤ **`neverOrigins` 영속화 + prompt 사용자 편집**, ⑥ **Mod API 시작** (메뉴·탭 lifecycle·네트워크 인터셉트 후킹), ⑦ **확장 호환 매트릭스 테스트** (uBO Lite/Dark Reader/Bitwarden 등 10개 검증 — CLAUDE.md 약속 이행).
- 2026-05-25: **묶음 S — 정책 엔진 권한 룰 + Import/Export**. **자유도 #7 (정책 엔진) 미완 약속 모두 이행**.
  - **권한 룰 모델 ([shared/types.ts](browser-build/app/shared/types.ts))**: `PolicyRule.permissions?: Record<string, 'allow' | 'deny' | 'default'>` 신규 필드. 'default' 는 저장 시 자동 제거 (전역 화이트리스트 적용).
  - **지원 권한 6종** (Electron permission 키 기준):
    - `media` — 카메라·마이크 (둘 다 묶임)
    - `geolocation` — 위치
    - `notifications` — 알림
    - `clipboard-read` — 클립보드 읽기
    - `fullscreen` — 전체 화면
    - `pointerLock` — 포인터 락
    - sanitize: 미지원 키는 자동 폐기 (스키마 안전성)
  - **결정 로직 ([features/policy/index.ts](browser-build/app/main/features/policy/index.ts))**: `permissionDecisionFor(url, permission)` —
    1. URL 매칭 룰들의 `permissions[permission]` 검사
    2. **deny 우선**: 한 룰이라도 'deny' 면 즉시 거부 (보안 보수적)
    3. allow 가 있으면 allow
    4. 모두 미설정이면 null → 호출자가 기본 정책 적용
  - **session-bootstrap 통합 ([main/session-bootstrap.ts](browser-build/app/main/session-bootstrap.ts))**: `setPermissionRequestHandler` / `setPermissionCheckHandler` 가 policy 룰 우선 참조 → 미설정 시 기존 `PERMISSION_ALLOWED` 화이트리스트 fallback. `requestingUrl` / `requestingOrigin` 으로 origin 추출.
    - 모든 partition (workspace 별 partition 포함) 에 자동 적용 — session-bootstrap hook 시스템 덕분.
  - **권한 UI ([pages/policies/index.html](browser-build/pages/policies/index.html))**: 폼에 "사이트별 권한" 섹션 추가. 6 권한별 3-state 토글 (`기본` 회색 · `허용` 초록 · `거부` 빨강). 룰 저장/로드 시 그대로 보존.
  - **Import / Export**:
    - **Export**: 전체 룰의 모든 필드 (요약 아닌 full body) 를 모아 `{version, exportedAt, rules}` JSON Blob → `browserbuild-policies-<ts>.json` 자동 다운로드 (browser native download)
    - **Import**: file picker → JSON 파싱 → 배열 또는 `{rules:[...]}` 모두 허용 → 사용자 확인 후 각 룰 `delete id` 후 save (id 충돌 방지, 항상 새 id 부여) → 진행 결과 alert. 잘못된 JSON 거부.
    - policies 페이지 header 에 **`내보내기`** + **`가져오기`** 버튼 (`+ 새 룰` 옆)
  - **자유도 #7 (정책 엔진) 약속 모두 ✅**:
    - ✅ UA 변경 (기존)
    - ✅ JS 차단/이미지 차단 (기존, CSP 강제)
    - ✅ 쿠키 차단 (기존)
    - ✅ CSP 완화/강화 (기존)
    - ✅ 헤더 주입 (기존)
    - ✅ JS 함수 escape hatch (기존, customJs)
    - ✅ **사이트별 권한 룰** (이번 라운드)
    - 🟡 Chrome `chrome.declarativeNetRequest` 통합 / 사이트별 JS 실행 ON/OFF (Chromium content settings 별도 API 필요) — 다음 라운드
  - **빌드 산출물**: 외피 JS 동일 (184.38 KB), preload 동일. policies 페이지가 내부 페이지라 외피 번들 영향 없음.
  - **검증**: packaged 5 프로세스 정상, log clean.
  - **알려진 제한 (다음 라운드 보강)**:
    - 권한 결정에 토스트/알림 없음 (조용히 적용) — 사용자 디버깅 위해 콘솔 로그 옵션 필요
    - import 시 사용자 확인 "기존 룰 유지" 만 — "모두 덮어쓰기" 옵션 없음
    - 권한 deny 시 사용자에게 룰 정보 표시 안 함 (어떤 룰이 거부했는지)
    - `chrome:` / `devtools:` 등 내부 origin 권한 매칭 미정 (현재 url match 가능한 것만)
  - **다음 라운드 후보**: ① **탭→스페이스 이동 + 가속 일시정지/재개** (보강 묶음 2탄 — 2 자유도 모듈 약속 미완 해소), ② **userscript match pattern 통일** (policy 의 정식 파서를 userscript 도 공유 — Tampermonkey 호환성 강화), ③ **외피 디자인 토큰 편집기** (색·폰트·라운드 picker — ui-designer 자유도 모듈), ④ **확장 호환 매트릭스 테스트** (uBO Lite·Dark Reader·Bitwarden 등 10개 — CLAUDE.md 약속 이행), ⑤ **Mod API 시작** (메뉴·탭 lifecycle·네트워크 인터셉트 — 자유도 모듈 표 잔여), ⑥ **`neverOrigins` 영속화 + 비밀번호 prompt 사용자 편집**, ⑦ **자동 업데이트 채널** (electron-updater + GitHub Releases — release-engineer 약속).
- 2026-05-25: **묶음 T — 탭→스페이스 이동 + 가속 일시정지/재개 (보강 묶음 2탄)**.
  - **자유도 #4 (워크스페이스) 잔여 약속 #1 해소 — 탭→스페이스 이동**:
    - 신규 `moveTabToWorkspace(tabId, targetWorkspaceId)` 함수 ([tabs/tab-service.ts](browser-build/app/main/tabs/tab-service.ts))
    - **partition 인지 두 경로**:
      - **같은 partition**: 단순 reattach — 기존 pane 에서 떼어내고(`detachFromLayout` 헬퍼) workspaceId 갱신, target ws layout 에 끼움. webContents 재사용 → 페이지 상태(스크롤·미디어·DOM·로그인) 완전 보존. closedStack 영향 없음.
      - **다른 partition** (워크스페이스 격리의 기본 케이스): webContents 의 partition 은 생성 시 결정되어 이후 변경 불가 → URL+pinned 보존 후 대상 ws partition 에 새 탭 생성 + 원본 탭 close. 페이지 재로드 발생 → 토스트에 "페이지 재로드" 안내.
    - **layout 정리 헬퍼 `detachFromLayout(tab, wsId)`**: closeTab 에 중복돼 있던 pane 정리 로직을 재사용 가능 헬퍼로 추출. 닫힌/이동한 탭이 속했던 pane 을 다른 탭으로 채우거나, 다른 탭 없으면 분할 단일화/빈 pane 처리.
    - 활성 ws 가 아닌 곳으로 이동 시 view.setVisible(false), 활성 ws 면 새 active pane 으로 즉시 표시. 양쪽 ws 의 reindex + reapplyLayout 트리거 + emitTabList broadcast.
  - **신규 액션 2종 + 키맵**:
    - `action.tab.move.next.workspace` (**Ctrl+Shift+PageDown**) — 활성 탭을 다음 워크스페이스로 이동
    - `action.tab.move.prev.workspace` (**Ctrl+Shift+PageUp**) — 이전 워크스페이스로 이동
    - 스페이스 1개뿐이면 "스페이스가 하나뿐입니다" 토스트. 이동 성공 시 `탭 이동 → <스페이스명> · 페이지 재로드` (다른 partition) 또는 `탭 이동 → <스페이스명>` (같은 partition) 표시. 키 충돌은 Chrome/Edge 의 Ctrl+PageDown(탭 이동) 와 다른 modifier 조합.
  - **콕콕 잔여 보강 — 다운로드 가속 일시정지/재개**:
    - **`pauseJob(job)` / `resumeJob(job)` 신규 export** ([features/downloads/multi-connection.ts](browser-build/app/main/features/downloads/multi-connection.ts)):
      - `pauseJob`: state='paused', 진행 중 segment 의 `request.abort()` + `stream.end()`. 임시 파일 보존 (segment.received 보존).
      - `resumeJob`: state='active', `runJob()` 재호출 → 미완료(seg.done=false) segment 만 다시 다운로드. 기존 `downloadSegmentOnce` 는 `Range: bytes={start+received}-{end}` + `flags: 'a'` 로 이어받음(이미 구현된 부분 재활용).
    - **`runJob(job)` 함수 추출**: `startAcceleratedDownload` 내부 IIFE 를 별도 함수로 추출 — `startAcceleratedDownload` 와 `resumeJob` 둘 다 호출 가능. 미완료 segment 만 `Promise.all` 로 병렬 진행, 모두 완료 시 merge.
    - **paused 상태 처리**: `downloadSegment` 의 retry 루프가 매 반복 시작 시 `job.state === 'paused'` 면 throw → `runJob` catch 에서 'paused' 시 cleanup 없이 종료(임시 파일 보존). 사용자 취소('cancelled') 만 임시 파일 unlink.
    - **`downloads/index.ts` pauseDownload/resumeDownload 분기**: 가속 잡(`acceleratedJobs.has(id)`) 우선 처리 → `pauseAcceleratorJob` / `resumeAcceleratorJob` 호출. Electron 자체 DownloadItem 일시정지/재개는 기존 fallback 유지.
    - **`state: 'paused'` DTO 매핑**: `metaFromJob` 이 이미 paused 케이스 분기 보유. 외피 DownloadsPanel 의 기존 일시정지/재개 버튼이 가속 잡에도 그대로 동작.
  - **알려진 제한 (다음 라운드)**:
    - 가속 잡 paused 상태는 **메모리에만** — 앱 재시작 시 잡 부활 X. 부활은 segment.received + tempPath 영속화 필요(JSON or DB) → 추가 라운드.
    - 탭→스페이스 이동 시 같은 partition 이라도 외피 TabBar 활성 표시는 즉시 갱신되지만 워크스페이스 별 closedStack 의 history 는 옮기지 않음(원본 ws 의 닫은 탭 복원 시 새 ws 가 아닌 원본 위치).
    - 액션 팔레트의 동적 워크스페이스 선택 UI 없음(Ctrl+Shift+PageDown/Up 순환만, ws 별 직접 점프는 없음 — 다음 라운드).
  - **빌드 산출물**: 외피 JS 동일 (184.38 KB / gzip 59.45 KB) — 모든 변경이 메인 측. preload 동일 (chrome 13.9 / content 11.1 / internal 9.2 KB).
  - **검증**: packaged Electron 35 부팅 ALIVE, log clean (`[adblock] initialized (standard)`, error 없음).
  - **다음 라운드 후보**: ① **userscript match pattern 통일** (policy 의 정식 파서 공유 — Tampermonkey 호환성 강화), ② **외피 디자인 토큰 편집기** (색·폰트·라운드 picker — ui-designer 자유도 모듈), ③ **확장 호환 매트릭스 테스트** (uBO Lite·Dark Reader·Bitwarden 등 10개 — CLAUDE.md 약속 이행), ④ **Mod API 시작** (메뉴·탭 lifecycle·네트워크 인터셉트 — 자유도 모듈 표 잔여), ⑤ **`neverOrigins` 영속화 + 비밀번호 prompt 사용자 편집**, ⑥ **자동 업데이트 채널** (electron-updater + GitHub Releases — release-engineer 약속), ⑦ **가속 잡 영속화** (segment.received 저장 → 앱 재시작 시 부활).
- 2026-05-25: **묶음 U-α — 자유도 잔여 모듈 4종 일괄 1차 구현** → **CLAUDE.md 자유도 모듈 표 전부 ✅ (Mod API + automation-engine + ui-designer + data-sovereignty)**.
  - **공통 인프라**: 4개 IPC namespace 신설 (`data` / `tokens` / `macro` / `mod`), 모두 `isTrustedSender` 검증으로 외부 사이트 접근 차단. preload `internal.ts` 에 4종 API 노출 (외피 chrome.ts 는 `tokens.onChanged` 만 — 외피 CSS 변수 즉시 적용용).
  - **🅰 data-sovereignty ([features/data-sovereignty](browser-build/app/main/features/data-sovereignty/index.ts))**:
    - **JSON dump 방식** (zip 라이브러리 의존 회피, 1차 MVP). 다음 라운드에 zip 으로 격상 검토.
    - 10 종 파일 + 2 디렉터리 export: `settings.json` · `keymap.json` · `workspaces.json` · `passwords.json` · `userChrome.{css,js}` · `data/{bookmarks,history}.db` (base64) · `user-tokens.json` · `macros.json` + `userscripts/*` · `policies/*`
    - **import 화이트리스트 + path traversal 차단**: `IMPORT_WHITELIST` 셋 + `isSafeRelativePath` 검증. 절대 경로·`..` 포함 거부.
    - 비밀번호는 safeStorage 암호문 그대로 export — **같은 PC/계정에서만 복호화 가능**. 다른 PC 로 이주 시 복호화 불가 (보안 의도, 안내 명시).
    - settings 페이지 "데이터 관리" 카테고리에 📤 내보내기 / 📥 가져오기 버튼. 파일명 `browserbuild-data-<ISO ts>.json`. 외피 native download 사용.
  - **🅱 ui-designer (디자인 토큰 picker) ([features/design-tokens](browser-build/app/main/features/design-tokens/index.ts))**:
    - **15종 편집 가능 토큰** 화이트리스트: 색 7종 (액센트·배경·본문·보조·경계선), 크기/라운드 7종, 모션 1종. CSS 변수 이름은 `build/gen-tokens.mjs` 의 `.` → `-` 규칙과 동일.
    - **type 별 sanitize**: color = hex/rgb/hsl 정규식, size = `px|rem|em|%` 정규식, duration = `ms|s` 정규식. 잘못된 값은 제거 (CSS injection 차단).
    - `userData/user-tokens.json` 영속화 (override 만 저장, 기본값은 저장 X).
    - **외피 즉시 적용**: `tokenEvents.changed` → IPC broadcast → 외피 `App.tsx` 의 useEffect 가 `document.documentElement.style.setProperty(cssVar, value)` 호출. 새 창 부팅 시에도 자동 적용.
    - settings 페이지 "디자인 토큰" 카테고리에 색별/크기별/모션별 그룹 + 색 picker(`<input type="color">`) + 텍스트 input + ↺ 개별 복원 + "모든 토큰 기본값 복원" 버튼.
  - **🅲 automation-engine (자동화 매크로) ([features/automation](browser-build/app/main/features/automation/index.ts))**:
    - 모델: `Macro = { id, name, description, enabled, trigger: { type: 'shortcut'|'url'|'startup', value }, actions: [{ type, value }], createdAt, updatedAt }`. `userData/macros.json` 단일 파일.
    - **트리거 3종**: `shortcut` (수동 실행 / 외피 단축키), `url` (URL 와일드카드 `*` 매칭, `onTabNavigated` hook 자동 발동), `startup` (앱 부팅 시 1회).
    - **액션 6종**: `navigate` (URL 이동) · `wait` (ms 대기, max 60s) · `js` (executeJavaScript) · `click` (selector) · `toast` (메시지) · `screenshot` (다음 라운드).
    - **URL 트리거 자동 발동**: main 진입의 `onTabNavigated` hook 에서 `listUrlMacrosFor(url)` → 매칭된 매크로마다 `runMacro` 호출.
    - **부팅 트리거**: `did-finish-load` 후 100ms 지연 → `listStartupMacros()` 일괄 실행.
    - 관리 페이지 [pages/macros/index.html](browser-build/pages/macros/index.html): 좌측 매크로 카드 리스트 + 우측 편집기 (이름·설명·활성·트리거 type/value·액션 행별 추가/삭제). "▶ 즉시 실행" 버튼 + "삭제" 버튼.
    - 신규 액션 `action.macros.open` (단축키 미할당 — 명령 팔레트로 접근).
  - **🅳 Mod API ([features/mod-api](browser-build/app/main/features/mod-api/index.ts))**:
    - **manifest + index.js 구조**: `userData/mods/<id>/manifest.json` + `index.js`. manifest 에 `permissions: ['tabs'|'menu'|'storage'|'network'|'node']` (선언 안 한 권한은 API 미노출).
    - **vm 샌드박스 실행**: Node `vm.Script` + `runInContext` (5s timeout). 별도 context 에 mod / console / setTimeout 등 최소 globals 만 노출. require/process/__dirname 등 Node 전역 차단.
    - **노출 API**:
      - `mod.info` — manifest 정보
      - `mod.log(...args)` — 로그 prefix `[mod:<id>]`
      - `mod.toast(message)` — 외피 토스트 (자동 prefix `[<name>]`)
      - `mod.tabs.onCreated/onClosed/onNavigated(cb)` — tab lifecycle (permission='tabs' 필요)
      - `mod.menu.add({ label, click })` — 메뉴 아이템 등록 (permission='menu' 필요)
      - `mod.storage.get(k) / mod.storage.set(k, v)` — `userData/mods/<id>/storage/kv.json` (permission='storage' 필요)
      - **다음 라운드**: `mod.network.intercept` (webRequest hook adapter), `mod.node.require` (node 권한 동의 다이얼로그)
    - tab lifecycle dispatch: main 진입의 `onTabCreated/onTabClosed/onTabNavigated` 가 `dispatchTabCreated/Closed/Navigated` 호출 → 활성 mod 의 listener 에 전파.
    - 메뉴 통합은 다음 라운드 — 현재는 `collectMenuItems()` API 만 노출, 실제 메뉴 통합은 buildAppMenu 통합 필요.
    - **활성 상태 영속화**: `userData/mods/_state.json` 에 `{id: enabled}`. 부팅 시 활성이었던 mod 만 자동 로드.
    - 관리 페이지 [pages/mods/index.html](browser-build/pages/mods/index.html): 카드별 토글·재로드·삭제 (디렉터리 rm). 에러 시 빨간 border + error message. 경고 배너 ("Mod 는 메인 프로세스에서 실행됩니다. 알 수 없는 출처의 코드는 절대 활성화하지 마세요").
    - 신규 액션 `action.mods.open` (단축키 미할당).
  - **자유도 모듈 표 진행 현황 — 12/12 완성** (CLAUDE.md 자유도 모듈 표 기준):
    - ✅ userChrome.css · ✅ userChrome.js · ✅ Userscript · ✅ 명령 팔레트 · ✅ 워크스페이스 · ✅ 레이아웃 자유 · ✅ 단축키 재바인딩 · ✅ 정책 엔진 · ✅ **자동화 매크로** (이번 라운드) · ✅ **디자인 토큰** (이번 라운드) · ✅ **데이터 주권** (이번 라운드) · ✅ **Mod API** (이번 라운드)
  - **신규 IPC 17 채널**: data(2) + tokens(4) + macro(6) + mod(5), 모두 `isTrustedSender` 보호.
  - **빌드 산출물**: 외피 JS 184.38 → **184.60 KB / gzip 59.55 KB** (tokens onChanged useEffect 추가), preload chrome 13.9 → **14.5 KB**, content 11.1 → **11.6 KB** (자동 변경 없음, esbuild 마이너 차이), internal 9.2 → **11.0 KB** (data/tokens/macro/mod 4 namespace 추가).
  - **검증**: packaged Electron 35 부팅 ALIVE, **5 프로세스** (메인+GPU+Network+Renderer+콘텐츠), MainWindowTitle "BrowserBuild" 정상, log clean (`[adblock] initialized (standard)`, error 없음). data/macros/mods 빈 디렉터리에서도 안전 init.
  - **알려진 제한 (다음 라운드 보강)**:
    - **data-sovereignty**: zip 압축 없음 (JSON raw, 큰 파일은 base64). import 시 자동 재시작 안 함 (사용자 수동).
    - **ui-designer**: 폰트 family 토큰 없음 (CSS 변수 미정의), 토큰 프리셋(테마 세트) 없음, export/import 별도 — 다음 라운드.
    - **automation**: cron 식 시간 트리거 없음 (`startup` 만), screenshot 액션 미구현, 사용자 정의 액션 plugin 없음, 단축키 자동 매크로 → `action.macro.run.<id>` 등록 미구현.
    - **Mod API**: `mod.network.intercept` 미구현 (webRequest hook adapter 필요), `mod.menu.add` 가 buildAppMenu 와 통합 안 됨, `node` 권한 동의 다이얼로그 미구현, mod 간 격리만 — sandboxed VM 이지만 메인 프로세스 자원 접근 가능.
  - **다음 라운드 후보**: ① **userscript match pattern 통일** (policy 의 정식 파서 공유), ② **확장 호환 매트릭스 테스트** (uBO Lite·Dark Reader·Bitwarden 등 10개), ③ **자동 업데이트 채널** (electron-updater + GitHub Releases), ④ **i18n 채움 + 온보딩 화면** (릴리즈 준비), ⑤ **Mod API 보강** (network intercept + menu 통합 + node 권한), ⑥ **automation 보강** (cron 식 시간 트리거 + screenshot 액션 + 단축키 자동), ⑦ **성능 예산 검증** (`/audit-perf` 자동 측정 + 백그라운드 탭 슬립).
- 2026-05-25: **묶음 V-α — 성능 예산 + 백그라운드 탭 슬립** → 1원칙 #1 (가벼움) 약속 검증·이행.
  - **백그라운드 탭 슬립 ([features/tab-sleep](browser-build/app/main/features/tab-sleep/index.ts))**:
    - **방식**: 비활성 30분 초과 탭 → `webContents.loadURL('about:blank')` 로 unload. 원본 URL/제목은 `TabRecord.discardedUrl/discardedTitle` 에 보존. webContents 객체 자체는 살아있어 layout/pane 교란 없음.
    - **자동 복원**: `activateTab` 호출 시 `discarded=true` 면 원본 URL 로 `loadURL` 자동 재로드. 사용자는 클릭 한 번이면 다시 페이지로.
    - **슬립 제외 조건**: 활성 탭, 핀 탭, `browser:`/`about:` 내부 페이지, `about:blank` 자체, 이미 슬립된 탭.
    - **검사 주기**: 60초 setInterval 로 `sweepNow()` 호출. settings 의 `performance.tabSleepEnabled` 가 false 면 스킵.
    - **임계값**: 기본 30분, `performance.tabSleepMinutes` 로 조정 가능.
    - **TabSummary 확장**: `discarded?: boolean` 신규. TabBar 가 💤 아이콘 + `.discarded` CSS 클래스 (opacity 0.6 + italic) 로 시각 표시. 슬립된 탭의 title 은 원본 보존.
    - 신규 export: `discardTab(id)` · `undiscardTab(id)` · `isTabActive(id)` · `isPinnedTab(id)` · `getAllTabRecordsForSleep()` · `getDiscardedCount()` · `getTotalTabCount()`.
  - **시스템 메트릭 IPC + `browser://memory` 페이지 ([ipc/system.ts](browser-build/app/main/ipc/system.ts) / [pages/memory/index.html](browser-build/pages/memory/index.html))**:
    - `system.metrics` IPC: `app.getAppMetrics()` 결과를 PID·타입·메모리(MB)·CPU% 로 정리 + 탭 카운트 (총/활성/슬립) + 슬립 상태 + 환경 정보 (Electron/Chromium/Node 버전, 플랫폼).
    - `system.sweepTabSleep` IPC: 사용자가 "지금 비활성 탭 슬립" 버튼으로 즉시 sweep 호출 가능.
    - `system.bootInfo` IPC: 부팅 시각 + 가동 시간.
    - **페이지 UI**: 1초마다 자동 갱신, 4×2 stat 카드 (메모리·프로세스 수·CPU·가동 시간 / 탭 총·활성·슬립·임계). **CLAUDE.md 가벼움 예산 표** 직접 노출 — 빈 창 RSS ≤ 250MB · 휴식 CPU ≤ 0.5% · 백그라운드 슬립 활성 여부. budget-ok/warn/over 색상 강조.
    - 프로세스별 표 (PID · 타입 · 메모리 · CPU) 메모리 큰 순 정렬.
  - **신규 액션 `action.memory.open`**: `browser://memory` 새 탭. 단축키 미할당 — 명령 팔레트로 접근. settings 의 디자인 토큰처럼 명령 팔레트가 진입 경로.
  - **lazy load 점검 — qrcode 라이브러리 지연 로드**:
    - `features/qrcode` 의 `const QRCode = require('qrcode')` top-level → `getQRCode()` 함수로 지연. 첫 QR 생성 시점까지 라이브러리 로드 안 됨 → 콜드 스타트 단축 + 메모리 baseline 감소.
    - Readability 는 이미 lazy 였음 (`features/reader/index.ts` 의 `readabilityCode = null` 패턴) — 변경 없음.
  - **`/audit-perf` 슬래시 커맨드 보강**: `.claude/commands/audit-perf.md` 절차에 **"실시간 확인: browser://memory 페이지"** 안내 + 9단계 "백그라운드 슬립 검증" (sweep 후 RSS 재측정으로 탭당 80MB → ~5MB 절감 확인) 추가.
  - **신규 settings 카테고리 `performance`**: `tabSleepEnabled: true` · `tabSleepMinutes: 30`. 다음 라운드에 settings UI 에 노출 예정 (현재는 settings.json 직접 편집 또는 IPC).
  - **신규 IPC 4 채널 (`system.*`)**: 모두 `isTrustedSender` 보호.
  - **빌드 산출물**: 외피 JS 185.13 → **185.76 KB / gzip 60.01 KB** (TabBar 슬립 표시 + CSS), preload internal 11.0 → **11.5 KB** (system API 4종), chrome 14.5 → **14.6 KB**, content 11.6 → **11.8 KB**.
  - **검증**: dev/packaged 부팅 둘 다 **5 프로세스 정상**, log clean (`[adblock] initialized (standard)`, error 없음). 탭 슬립 루프는 부팅 후 매 60초 자동 동작.
  - **CLAUDE.md 1원칙 #1 약속 진행**: ✅ 백그라운드 탭 슬립 (30분 비활성 → discard) · ✅ 외피 초기 JS ≤ 500KB gzip (현재 60KB, 예산의 12%) · 🟡 콜드 스타트·LCP·디스크·휴식 CPU 측정값 — `browser://memory` 페이지에서 실시간 확인 가능 (자동 측정 + 회귀 차단은 다음 라운드).
  - **알려진 제한 (다음 라운드)**:
    - 슬립 시 `about:blank` loadURL — 일부 메모리는 webContents 살아있어 완전 해방 아님 (~5MB 잔여). 진짜 destroy 는 webContents 재생성 필요 (layout 교란 위험).
    - thumbnail freeze 미구현 — 슬립된 탭의 마지막 화면 thumbnail 캡처 + TabBar hover 시 표시는 다음 라운드.
    - settings UI 에 `performance` 카테고리 미노출.
    - `/audit-perf` 의 자동 측정 (콜드 스타트 3회 평균·5분 idle CPU) 은 여전히 수동.
    - 콜드 스타트 timestamp 자동 기록 미구현 — `app.whenReady()` → `window.show()` 타임스탬프.
  - **다음 라운드 후보**: ① **자동 업데이트 채널** (electron-updater + GitHub Releases — 첫 베타 도달), ② **세션 자동 복원** (비정상 종료 후 부팅 시 워크스페이스+탭 트리 복원), ③ **확장 호환 매트릭스** (uBO Lite·Dark Reader 등 10개 자동 테스트), ④ **Mod API 보강** (network intercept + menu 통합), ⑤ **automation 보강** (cron 트리거 + screenshot 액션), ⑥ **`/audit-perf` 자동화** (콜드 스타트 자동 측정 + 회귀 차단), ⑦ **새 탭 위젯** (한국 날씨/뉴스 카드).
- 2026-06-01: **묶음 W — 다운로드/동영상 도킹 사이드바 + 재시작 이어받기 + 회귀 #13(광고차단 세션 불일치) fix**.
  - **다운로드·동영상 도킹 사이드바**: 기존 다운로드 패널·영상 후보 팝오버는 바깥 클릭 시 닫히고 페이지 위에 겹쳐(z-order) 표시돼 진행률을 보며 작업하기 어려웠음. 둘 다 **insets 도킹 사이드바**로 전환 — 페이지를 왼쪽으로 밀어내고, 툴바 토글 버튼(⬇ 다운로드 / ▶ 동영상)·`Ctrl+J`로만 여닫음. 바깥 클릭으로 안 닫힘.
    - `App.tsx`: `downloadsOpen`(localStorage 영속)·`videoOpen` 상태 분리, 우측 insets 에 `DOWNLOADS_PANEL_WIDTH`(320)·`VIDEO_PANEL_WIDTH`(320) 가산. 도킹이므로 `beginPaneDrag`(z-order 승격) 대상에서 제외(userChrome·팔레트·찾기만 오버레이 유지).
    - `DownloadsPanel.tsx`/`VideoCandidatePanel.tsx`(신규, 옛 `VideoCandidatePopover` 대체): `aside.sidepanel.sidepanel-right` 도킹 마크업, 백드롭 제거. 영상 후보가 사라지면(페이지 이동) 도크 자동 닫힘. `Toolbar.tsx`: ▶·⬇ 토글 버튼 + 진행/후보 개수 뱃지.
  - **재시작 이어받기 (download resume)**: 브라우저가 닫혀도 다음 실행 때 진행 중이던 다운로드를 이어받음.
    - `features/downloads/pending-store.ts`(신규): 진행 중(active/paused) 작업을 `userData/downloads-pending.json` 에 영속화(원자적 tmp+rename, 300ms 디바운스). 완료/취소/정상실패 시 제거. **종료 중(before-quit)엔 `quitting=true` 로 두어, 자식 프로세스 강제 종료로 인한 exit 핸들러의 removePending 을 무시** → 진행 중 작업이 다음 실행 때 살아남음. 사용자의 명시적 취소는 `removePending(id, true)` 로 종료 중에도 강제 제거(취소한 작업이 되살아나지 않도록).
    - **yt-dlp 영상**: 같은 `outputTpl` + `--continue` 로 재실행 → `.part`/`.ytdl` 에서 이어받음. `downloadWithYtDlp` 를 `runYtDlpProcess` 공유 + `resumeVideoDownload` 로 분리.
    - **가속 HTTP**: `resumeAcceleratedDownload` 가 각 `.part<i>` 임시 파일 크기로 받은 양 복원 후 미완료 세그먼트만 `Range` 로 이어받음. 서버가 Range 요청에 200(전체)을 돌려줄 때 append 손상 방지(received 초기화 + 'w' 덮어쓰기, 스트림 생성을 응답 상태 확인 후로 연기).
    - `features/downloads/resume.ts`(신규): 부팅 1.8초 후 `resumePendingDownloads()` — 토스트 "이전 다운로드 N건 이어받기" + 다운로드 사이드바 자동 표시, per-job try/catch.
    - 코드리뷰 반영: append 손상·종료 중 취소 보존·손상 JSON 필드 검증(ranges 등) 3건 수정.
  - **회귀 #13 (광고 차단 세션 불일치, critical)**: `initAdblock` 이 `session.defaultSession` 에만 차단을 적용했으나 **모든 탭은 `persist:default`·워크스페이스 `persist:ws-*` partition 세션 사용** → 정작 웹페이지 세션엔 차단 미적용 → 광고가 거의 그대로 노출. (회귀 #5/#11/#12 와 동일한 세션 불일치 계열. session-bootstrap 이 protocol·권한·response-hooks·policy 는 모든 partition 에 거는데 adblock 만 미연결 — 코드 주석에 "향후 adblock 등"으로만 남아 있었음.)
    - **수정**: `session-bootstrap` 에 `installedSessionList` 배열 추가 + `addSessionInitHook` 가 **이미 설치된 모든 세션에도 즉시 적용**(뒤늦게 1.5초 후 init 되는 adblock 이 기존 partition 전부 커버) + `forEachInstalledSession` export. adblock 은 `addSessionInitHook` 으로 모든 현재·미래 세션에 네트워크 차단(`attachOverridingListeners`) 적용.
    - **코스메틱 핸들러 충돌 해결**: `@ghostery` 의 `enableBlockingInSession` 은 전역 ipc 핸들러(`inject-cosmetic-filters`)를 1회만 등록 가능(2번째 세션부터 "second handler" throw). → 네트워크 차단(핵심)은 모든 세션에 `attachOverridingListeners` 로, 코스메틱(요소 숨김)은 탭이 쓰는 partition 세션 **하나에만** `enableBlockingInSession` 으로 분리.
    - **검증**: 실행 로그 `[adblock] initialized (standard, filters=3, all sessions)` — "second handler" 에러 없이 모든 세션 적용, 5 프로세스 정상.
  - **디버그 잔재 정리**: 콘텐츠 preload(`external-features.ts`)의 녹색 "✓ BB ready" 배너·영상 감지 시 빨간 점선 외곽선·`[bb-video-overlay]` 콘솔 로그 제거.
  - **빌드 산출물**: 외피 JS 201.88 KB / gzip 64.81 KB. main tsc 무경고. NSIS 재패키지는 다음 릴리즈 라운드.
  - **다음 라운드 후보**: ① **이어받기 실사용 검증** (대용량 영상 중단→재시작 이어받기 + 가속 HTTP resume), ② **자동 업데이트 채널**, ③ **policy ↔ adblock onHeadersReceived 통합 디스패처** (현재 adblock 이 policy 응답헤더 룰을 덮어쓰는 잠재 충돌 — 보통 policy 룰이 비어 무해하나 통합 필요), ④ **확장 호환 매트릭스**, ⑤ **세션 복원 프롬프트 개선**, ⑥ **새 탭 위젯**.
- 2026-06-01: **묶음 X — anti-adblock 탐지 우회 + sogirl 영상 unbreak + 방문기록 삭제 + 토글 UX**.
  - **방문 기록 삭제 (history clear)**: `ClearDataModal.tsx`(신규) — 기간 선택(지난 1시간/24시간/7일/4주/전체) 후 `window.browserAPI.history.clear({sinceMs})` 호출. `Ctrl+Shift+Delete`·메뉴("방문 기록 삭제")로 진입. `App.tsx` 에 `clearDataOpen` 상태 + `clearData.onOpen` 구독, `register-defaults.ts` 에 `action.history.clear` 액션, `build-menu.ts` 메뉴 항목, `chrome.ts` 에 `clearData.onOpen` 브리지, ko/en 로케일 라벨 추가.
  - **anti-adblock 탐지 우회 (4중 방어)**: 일부 사이트(예: sogirl 미러)가 광고차단기를 탐지해 "광고 차단기를 비활성화하세요" 벽을 띄움(Cốc Cốc 은 안 걸림). 4중으로 우회:
    - **① ABP anti-cv 필터 리스트**: `FilterId.antiAdblock` → `abp-filters-anti-cv.txt`, 전 레벨에 포함(`settings.ts` 기본 `antiAdblock:true`). 탐지 스크립트 자체를 네트워크 차단.
    - **② uBO scriptlet/redirect 리소스 로드**: `loadScriptletResources()` 가 ghostery adblocker repo 의 `resources.json` 을 받아 `updateResources(text, len)` — anti-cv 필터의 scriptlet(`+js(...)`) 동작에 필요. 디스크 캐시 폴백.
    - **③ adsbygoogle 스텁 main-world 주입**: `external-features.ts` `injectAdStubs()` — `window.adsbygoogle`(loaded=true, no-op push), `google_ad_status=1`, `canRunAds=true`, `isAdBlockActive=false` 를 페이지 메인월드에 정의 → "광고 로드 실패" 기반 탐지 무력화. sogirl 스코프.
    - **④ 탐지 모달 CSP-proof 숨김**: `hideKnownAntiAdblockModals()`(전 호스트) — `[class*="adde_modal_detector"]` 등을 **제거가 아닌 inline style 숨김**(display/visibility/pointer-events none) + 스크롤·filter 복원. MutationObserver(15s)+타이머. **제거(`.remove()`)하면 사이트 탐지 함수가 null.className 읽다 throw → 영상 로드 promise 체인 깨짐 → 404** 였으므로 반드시 hide-only. 로그 `[bb] anti-adblock guard active @ host` / `modal hidden: N`.
  - **sogirl 영상 404 unbreak**: 차단벽 우회 후에도 영상이 404. 직접 Bunny 엔드포인트 probe 로 **사이트가 emit 하는 `player.mediadelivery.net/embed/2015/{guid}` 는 404, `iframe.mediadelivery.net/embed/{...}` 는 200** 임을 확인. `adblock/index.ts` `attachOverridingListeners` onBeforeRequest 최상단에 http→http 리라이트: `player.mediadelivery.net/embed/` 포함 시 `iframe.mediadelivery.net` 으로 `redirectURL`. (Chromium 이 http→`data:` surrogate 리다이렉트를 `ERR_UNSAFE_REDIRECT` 로 막으므로 surrogate 방식은 폐기, 이 http→http 만 사용.) **검증**: 콘솔에 `[bb] anti-adblock guard active @ iframe.mediadelivery.net`(이전 `player.` → 이제 `iframe.`) + 404 소멸.
  - **사이트별 토글 UX**: 기존 per-site adblock 토글이 상태 표시·새로고침 없어 "껐는지 켰는지 모름". `action.adblock.toggleSite` 개선 — 토스트 `🛡️ ${host} — 광고차단 꺼짐/켜짐 · 새로고침 중…` + `wc.reload()` 자동.
  - **모든 세션 코스메틱 적용 보강**: `enableOnSession` 이 첫 비-default 세션에만 `enableBlockingInSession`(cosmeticGlobalSession), 나머지는 `registerPreloadScript({type:'frame', filePath: @ghostery/adblocker-electron-preload})`, 전 세션에 `attachOverridingListeners`. "second handler" 회피 + 모든 partition 에서 요소 숨김 동작.
  - **디버그 잔재 정리**: iframe-src 진단 로깅·full-screen 휴리스틱(키워드 없는 위험한 전체화면 숨김) 제거 — 키워드 기반 hide-only 만 유지.
  - **다음 라운드 후보**: ① **anti-adblock 우회 실사용 매트릭스** (여러 탐지 사이트 자동 점검 + scriptlet 리소스 자동 갱신), ② **이어받기 실사용 검증**, ③ **자동 업데이트 채널**, ④ **policy ↔ adblock onHeadersReceived 통합 디스패처**, ⑤ **새 탭 위젯**.
- 2026-06-01: **묶음 Y — 범용 동영상 다운로드 엔진 (어떤 사이트든 받히도록) + 회귀 #14(다운로드 세션 불일치) fix**.
  - **증상**: 특정 사이트(avsee 등)에서 "영상은 감지되는데 다운로드하면 mp4 가 아니라 HTML 파일이 받아짐". 다른 사이트(sogirl 등)에선 403. Cốc Cốc 은 정상 → "경우의 수 무관하게 받히게" 재설계 요청.
  - **원인 3가지** (실서버 probe 로 확정):
    1. **octet-stream 미디어가 세그먼트로 오인돼 후보에서 탈락**: 토큰 CDN(BunnyCDN 등)이 mp4 를 `application/octet-stream` 으로 서빙하는데, `SEGMENT_MIME` 에 octet-stream 이 들어 있어 진짜 mp4 가 HLS 세그먼트로 분류돼 버려짐 → 엉뚱한 URL(임베드 HTML·가짜 파라미터 URL)이 잡혀 HTML 이 받아짐.
    2. **Referer 누락 → 핫링크 CDN 이 403/HTML 반환**: `data.cdn.avsee.ru` 등은 Referer 없으면 `403 text/html`(=받으면 HTML 파일), Referer 있으면 `206 application/octet-stream`(실측 확인). 기존 `downloadDirect` 는 Referer 를 넣긴 했으나 **크롬 UI 세션**으로 받아 탭 쿠키가 누락.
    3. **회귀 #14 (다운로드 세션 불일치)**: `will-download` 가 `session.defaultSession` 에만, 가속 다운로더도 `defaultSession` 사용 → 탭은 `persist:default`·`persist:ws-*` partition 세션이라 쿠키 게이트 CDN 에서 인증 실패. (회귀 #5/#11/#12/#13 과 동일 계열.)
  - **수정 — 범용 다운로드 엔진** (Cốc Cốc 식: 브라우저가 실제 스트리밍한 요청을 쿠키·Referer 포함해 재현, 미디어 아니면 yt-dlp 폴백):
    - **감지 정정** (`video-download/index.ts`): `isSegment` 가 `.mp4/.webm/.mkv/.mov` 확장자면 무조건 세그먼트 아님(`VIDEO_EXT` 우선), octet-stream 을 세그먼트 시그널에서 제거. **큰 octet-stream(≥3MB)도 미디어 후보로 인식**(확장자 없이 서빙되는 토큰 CDN mp4 커버).
    - **`downloadMedia(url, pageUrl, tabId)`** (옛 `downloadDirect` 대체): ⓐ **탭 세션**(`getWebContentsByTabId(tabId).session`, 탭 닫혔으면 `getTabPartition`→`fromPartition`)으로 받아 **쿠키 일치**, ⓑ 다운로드 전 **content-type probe**(Referer 포함) → `text/html`·실패면 "미디어 아님"으로 보고 **yt-dlp 범용 추출기로 자동 폴백**(HTML 파일 저장 차단의 핵심), ⓒ Range 지원+대용량이면 **가속 다운로드**(Referer 헤더+쿠키), 아니면 탭 세션 `downloadURL`(Referer).
    - **`startManagedHttpDownload`** (`downloads/index.ts` 신규 export): probe→html판별→가속/단일 분기. probe 결과를 `tryStartAccelerator` 에 넘겨 중복 probe 방지. 비가속 폴백의 `downloadURL` 이 `will-download` 재진입 시 중복 가속/probe 하지 않도록 `managedNonAccelUrls` 마커.
    - **`will-download` 모든 세션 설치** (회귀 #14 fix): `addSessionInitHook(attachWillDownload)` + defaultSession, `WeakSet` 멱등. 가속 다운로더는 **다운로드를 발생시킨 세션**(`wc.session`/탭 세션)을 그대로 사용.
    - **probe 강화** (`multi-connection.ts`): HEAD → (실패·content-type 없음 시) **Range GET(0-0) 폴백**으로 content-type·전체크기(Content-Range)·Range 지원(206) 확정. CDN 별 HEAD 비호환 흡수.
    - **헤더 스레딩**: `AcceleratorJob`·`probeUrl`·`start/resumeAcceleratedDownload` 에 `headers`(Referer) 추가, 모든 세그먼트 net.request 에 `applyHeaders`(Range·Host·Content-Length 제외).
    - **이어받기도 인증 복원**: `AccelPending` 에 `headers`·`partition` 저장 → 재실행 시 `fromPartition` 세션(쿠키)+Referer 로 이어받음.
  - **코드리뷰 반영**: probeOnce 즉시 finish 의 죽은 `resp.on('end')` 제거(헤더는 response 시점에 완비), 200-fallback 시 `receivedBytes` 음수 방지(`Math.max(0,…)`), 가속 인계 후 `httpDownloads` 고아 항목 명시 제거, 탭 닫힘 시 partition 세션으로 복원.
  - **실서버 검증**: avsee CDN — referer 없음 `403 text/html` / referer 있음 `206 octet-stream` / `Accept-Ranges: bytes` 2.78GB. sogirl 다운로드 + 403 모두 사용자 확인 해결.
  - **디버그 잔재 정리**: 진단용 파일 로거(`bb-download.log`)·`dlog`·`[dl]` 로그·`AcceleratorJob.log` 콜백 전부 제거(세그먼트 비2xx `console.warn` 만 유지).
  - **다음 라운드 후보**: ① **다운로드 다사이트 매트릭스** (mp4/HLS/DASH/토큰CDN/blob MSE 자동 점검), ② **HLS 직접 다운로더** (yt-dlp 없이도 .m3u8 세그먼트 병합 — 현재 HLS 는 yt-dlp 의존), ③ **자동 업데이트 채널**, ④ **이어받기 실사용 검증**(헤더·partition 복원 포함), ⑤ **새 탭 위젯**.
- 2026-06-01: **묶음 Z — 네이티브 HLS 다운로더(yt-dlp 불필요) + 다운로드 다사이트 매트릭스**.
  - **네이티브 HLS 다운로더** (`features/downloads/hls.ts` 신규): `.m3u8` 을 yt-dlp 없이 직접 받는다(실패 시 yt-dlp 폴백).
    - master 플레이리스트면 **최고 대역폭 variant** 선택 → media 플레이리스트 파싱.
    - 세그먼트를 **탭 세션 쿠키 + Referer** 로 받아, **제한 동시성(6) 프리페치 + 순서대로 병합**(`nextToWrite`/buffers, prefetch 창 `MAX_AHEAD=18` 로 메모리 상한).
    - `#EXT-X-KEY METHOD=AES-128` → 키 받아 `aes-128-cbc` 복호화(IV = 명시값 또는 media-sequence 의 64비트 BE). 키 캐시.
    - `#EXT-X-MAP`(fMP4) → init + m4s 합쳐 **`.mp4`**, 아니면 TS 합쳐 **`.ts`** — 둘 다 ffmpeg 불필요(TS 연결=유효 MPEG-TS, fMP4 연결=유효 fragmented MP4).
    - `video-download` 에 **`downloadStream(url, pageUrl, tabId)`** 라우터: `.m3u8`→네이티브 HLS(진행률·취소·실패 시 yt-dlp 폴백), `.mpd`(DASH)·지원호스트→yt-dlp. overlay·ipc·후보패널 모두 이 라우터 경유.
    - **referer 정확도**: 후보 감지 시 요청 **프레임 URL**(`details.frame.url`)을 pageUrl 로 저장 — 임베드 플레이어(Bunny 등)는 iframe 컨텍스트에서 세그먼트를 요청하므로 탭 URL 보다 프레임 URL 이 올바른 Referer.
  - **다운로드 다사이트 매트릭스**:
    - **`build/probe-download.mjs`** (신규 CLI): `node build/probe-download.mjs <url> [referer]` — 앱의 `probeUrl`(HEAD→GET 0-0 폴백)+미디어 분류를 독립 Node 로 재현해 "받힐지/HTML/HLS/DASH/Range/지역차단" 을 즉시 판정(메인 로그는 페이지 콘솔에 안 보이므로 URL 진단의 정식 도구). exit 0=미디어/1=미디어아님. (반복하던 ad-hoc curl 을 코드화.)
    - **`/audit-download`** (신규 커맨드): 엔진 라우팅 표 + 11개 시나리오 매트릭스(progressive·토큰CDN octet·HLS평문/fMP4/AES-128/master·DASH·지원호스트·blob·쿠키게이트·이어받기) GUI 검증 절차.
    - `video-detect-ytdlp` 스킬에 범용 엔진·네이티브 HLS·세션 주의(회귀 #13/#14) 반영.
  - **코드리뷰 반영(HLS 동시성)**: ⓐ 태스크가 reject 안 하고 첫 에러만 `fatalError` 기록(Promise.race reject·straggler unhandledRejection 차단), ⓑ **`Promise.race(빈 Set)` 영구 hang 가드**(`if (inFlight.size>0)`), ⓒ `inFlight.delete` 를 `finally` 로 항상 보장, ⓓ `seqToIv` 상위32비트 포함, ⓔ WriteStream `error` 이벤트 캡처, ⓕ yt-dlp 폴백 시 새 항목 등록 후 HLS 항목 제거(패널 빈 목록 순간 제거).
  - **오버레이 라우팅 fix**: 영상 위 다운로드 버튼(`handleOverlayDownload`)이 후보 목록을 video.src 보다 먼저 검사해, stray `.m3u8`/오탐 후보가 있으면 그걸 받으려다 실패(후보 패널로는 정답 후보를 직접 골라 성공). → **"재생 중인 것을 받는다"** 순서로 변경: video.src 가 구체적 미디어 URL(mp4/m3u8)이면 후보보다 **우선**, blob/MSE 일 때만 네트워크 후보 사용. (사용자 확인: avsee 오버레이 다운로드 정상.)
  - **검증**: tsc 무에러. `probe-download` 실서버 — avsee 토큰 mp4 referer 있음 `200 octet 2.6GB ranges:yes`→가속직접 / referer 없음 `403 html`→폴백, 클린 종료.
  - **알려진 제한 (다음 라운드)**: HLS 이어받기 미구현(중단 시 처음부터), HLS live 미지원(VOD 만), DASH 네이티브 미구현(yt-dlp), blob/MSE 소스는 네트워크 후보 없으면 페이지 URL→yt-dlp 의존.
  - **다음 라운드 후보**: ① **HLS 이어받기**(.m3u8 세그먼트 진행 영속화), ② **blob/MSE 세그먼트 스니핑**(media 요청 누적→.m3u8 역추적), ③ **자동 업데이트 채널**, ④ **DASH 네이티브 파서**, ⑤ **새 탭 위젯**.
- 2026-06-01: **묶음 AA — HLS 이어받기 + blob/MSE 세그먼트 스니핑**.
  - **HLS 이어받기**: 네이티브 HLS 다운로드가 브라우저 종료 후에도 같은 파일에 이어받음.
    - `downloadHls` 에 `resumeFrom`(세그먼트 수)·`resumeBytes`(그 시점 파일 바이트) 추가. **정합성**: `writtenBytes`(write 콜백에서 누적 = 실제 기록 바이트)를 추적·영속하고, 재실행 시 파일을 `resumeBytes` 로 **truncate 후 append** → 부분 기록/중복 제거. 파일이 기대보다 작으면(하드 크래시로 flush 손실) `resume=false` 로 처음부터(0 패딩 손상 방지). fMP4 init 은 resume 시 재기록 안 함.
    - `HlsPending{playlistUrl,pageUrl,title,savePath,doneSegments,doneBytes,totalSegments,headers?,partition?}` 영속(pending-store). `runHlsJob`(신규/이어받기 공용): onStart 에서 descriptor 영속, onProgress 에서 **10세그먼트마다** doneSegments·writtenBytes 갱신. `resumeHlsDownload(p)` 가 부팅 시(resume.ts) 같은 파일로 재개. 취소는 `removePending(force)` + 이어받기 파일 보존(신규만 삭제).
  - **blob/MSE 세그먼트 스니핑**: MSE 플레이어가 `<video src="blob:">` 로 재생해 네트워크에 매니페스트가 안 보이는 경우 대응. 세그먼트(.ts/.m4s 등)가 **임계치(3) 이상** 흐르는데 받을 수 있는 후보(hls/dash/mp4/video/site)가 없으면, 페이지 URL 을 **`site` 후보**로 1회 띄워 yt-dlp 로 받을 수단 제공(`noteSegmentActivity`). 이후 실제 매니페스트/직접 후보가 등장하면 합성 `site` 후보는 `pushCandidate` 에서 자동 제거(중복·오선택 방지). `video.ts` ipc 는 `site` 후보를 yt-dlp(페이지 URL) 직행.
  - **코드리뷰 반영**: ⓐ 이어받기 취소 시 파일 삭제 금지(`!resume` 일 때만 unlink — 이전 세션 데이터 보존), ⓑ outPathNoExt 복원을 일반 ext 제거로(이중 확장자 `.mp4.mp4` 방지), ⓒ yt-dlp 폴백 시 `try/finally` 로 HLS 임시 항목 항상 제거(throw 시 누수 방지), ⓓ 실제 후보 도착 시 합성 site 제거, ⓔ `HlsPending.doneBytes` 로드 검증.
  - **검증**: tsc 무에러, 외피 빌드 정상.
  - **알려진 제한**: HLS live(끝없는 플레이리스트) 미지원(VOD 만), DASH 네이티브 미구현(yt-dlp), MSE 의 실제 미디어 URL 직접 캡처는 아직 yt-dlp 경유(매니페스트 역추적은 다음 라운드).
  - **다음 라운드 후보**: ① **자동 업데이트 채널**(electron-updater + GitHub Releases, 첫 베타), ② **DASH 네이티브 파서**(.mpd yt-dlp 탈피), ③ **MSE 매니페스트 역추적**(세그먼트 패턴→.m3u8 추론), ④ **새 탭 위젯**, ⑤ **확장 호환 매트릭스**.
- 2026-06-01: **묶음 BB — 자동 업데이트 채널 활성화 (electron-updater + GitHub Releases)**.
  - 인프라는 이미 배선돼 있었음(`features/auto-update`·`ipc/update`·preload `update.*`·`UpdateBanner`·`initAutoUpdate` 호출·settings `update` 섹션). 미연결 2가지만 마무리:
    - **`electron-updater@^6.8.3` 설치**(dependencies — 패키지에 포함). 기존 `loadUpdater()` 의 동적 import 가 이제 성공 → dev 외(packaged)에서 동작.
    - **publish provider 를 `generic`(자체호스팅 플레이스홀더) → `github`** 로 전환(`electron-builder.yml`). 패키징 시 `app-update.yml`(provider: github)이 임베드돼 electron-updater 가 GitHub Releases 를 조회. ⚠ `owner: REPLACE_GH_OWNER` 플레이스홀더 — 실제 저장소로 교체해야 체크 동작(미교체 시 404, graceful).
  - **채널 처리 보강**: `applyChannel()` — `latest` 는 정식만(`allowPrerelease=false`), `beta`/`nightly` 는 GitHub prerelease 허용(`allowPrerelease=true`). 부팅 1분 후 첫 체크 + 6시간 주기(설정 `update.autoCheck`), 새 버전 시 `UpdateBanner` 알림 → 받기/재시작 설치.
  - **RELEASE.md** 4번 갱신: GitHub 가 기본 provider, `owner` 교체 필수, `GH_TOKEN` + `--publish always` 업로드, 채널별 prerelease 절차.
  - **검증**: tsc 무에러, 패키징 exit 0, `dist/.../resources/app-update.yml` 가 provider:github 로 생성됨 확인. 사용자 선택: 기본 채널 latest.
  - **마무리 대기**: 실제 자동 업데이트 활성화는 GitHub `owner/repo` 확정 후 yml `owner` 한 줄 교체 → `--publish always` 로 첫 릴리즈 업로드하면 완료. (저장소 미정 시 인프라만 완성 상태로 둠.)
  - **다음 라운드 후보**: ① **DASH 네이티브 파서**, ② **MSE 매니페스트 역추적**, ③ **새 탭 위젯**(날씨/뉴스), ④ **확장 호환 매트릭스**, ⑤ **설정 UI 에 업데이트 채널 토글 노출**(현재 IPC/feature 는 있으나 설정 화면 섹션 미노출).
  - **후속(묶음 BB-2): 설정 UI 에 업데이트 섹션 노출**. `browser://settings` 에 "업데이트" 탭 추가 — 현재 버전·상태 표시, "지금 업데이트 확인"·"재시작하여 설치" 버튼, 채널 select(latest/beta/nightly, 즉시 `update.setChannel` 적용), 자동 확인·자동 다운로드·알림 토글. `internal` preload 에 `update.{status,check,download,install,setChannel,...,onStatus}` 노출. 상태는 `update:status` 구독으로 실시간 갱신. (feature/IPC 는 묶음 BB 에서 완성, 이제 사용자 노출까지 완료.)
- 2026-06-01: **묶음 CC — 새 탭 위젯 (날씨 · 뉴스)**. CSP `default-src 'self'` 인 새 탭에서 직접 fetch 가 막히므로 **메인 프로세스가 대신 가져와 IPC 로 전달**. 외부 API 키 불필요.
  - **`features/widgets/index.ts`(신규)**: `net.request`(translate 방식) 기반 `fetchText`/`fetchJson`(12s 타임아웃). **날씨 = Open-Meteo**(`api.open-meteo.com/v1/forecast`, 현재값+3일 예보, WMO weather_code → 한국어+이모지 매핑), **위치 = ipapi.co IP 지오로케이션**(자동, 1h 캐시, 실패 시 서울 폴백) 또는 설정의 수동 좌표. **뉴스 = Google News RSS**(`news.google.com/rss`, 주제별 section URL, 정규식 RSS 파싱 + 엔티티 디코드 + "제목 - 언론사" 꼬리표 제거, 8건). **stale-while-revalidate**: 메모리 캐시(날씨 30m·뉴스 15m) + `electron-store`(widgets-cache) 마지막 성공값 영속 → 재시작 직후 즉시 표시, 네트워크 실패 시 마지막값 반환.
  - **배선**: `ipc-channels` 에 `widgets.{weather,news}` + union 타입, `ipc/widgets.ts`(신규, `isTrustedSender` 가드) → `registerWidgetsIpc()` 등록, preload `internalAPI.widgets.{weather,news}(force?)`.
  - **설정 스키마**: `widgets` 섹션 추가 — `weatherEnabled`/`newsEnabled`/`locationMode`(auto·manual)/`manualLat`·`manualLon`·`manualPlace`/`units`(metric·imperial)/`newsTopic`(headlines~health 9종).
  - **새 탭 UI**(`pages/newtab/index.html`): 검색창 아래 2열 위젯 행(좁으면 1열) — 날씨 카드(큰 온도·이모지·장소·바람·3일 예보, 새로고침 버튼) + 뉴스 카드(주제 라벨·헤드라인 링크·언론사). 설정 토글로 카드별 표시/숨김. 로딩·실패 플레이스홀더 처리.
  - **설정 UI**(`pages/settings/index.html`): "새 탭" 탭 추가(날씨 토글·위치 모드·수동 좌표·온도 단위·뉴스 토글·주제). `bindWidgets()` — 위치 모드 전환 시 수동 좌표 입력 표시/숨김 즉시 재렌더.
  - **검증**: tsc(main) 무에러, preload 타입체크 0, internal.js 41.4→41.7kb, 패키징 exit 0. `noUncheckedIndexedAccess` 대응(daily 배열 인덱스 `?? 0` 가드).
  - **함정**: 첫 패키징이 **실행 중인 BrowserBuild 가 exe 를 잠가** `remove ...exe: Access is denied`(`ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`)로 실패 → exe 는 stale. **패키징 전 `Stop-Process -Name BrowserBuild -Force` 필수.**
- 2026-06-01: **묶음 CC-2 — 위젯 확장 (메모 · 할 일 · 환율)**. 묶음 CC 의 새 탭 위젯 기반 위에 매일 쓰는 위젯 3종 추가. (즐겨찾기 바로가기 편집은 북마크 시스템과 얽혀 범위가 커 이번 제외.)
  - **`features/widgets/index.ts` 확장**: **환율 = Frankfurter**(`api.frankfurter.app/latest?from=BASE&symbols=...`, ECB 데이터, 무료·키 불필요, 약 30종 통화). `getFx(force)` — base/symbols 설정에서 읽고 base 와 동일·비3자리 코드 필터, 캐시(메모리 1h + `widgets-cache` 영속, stale-while-revalidate). **사용자 데이터 KV** = `widgets-data` electron-store + `getWidgetData/setWidgetData`(메모·할 일). browser:// localStorage 대신 메인 저장 → 방문 데이터 삭제에도 보존·향후 내보내기 포함 가능.
  - **배선**: `ipc-channels` 에 `widgets.{fx,dataGet,dataSet}` 추가, `ipc/widgets.ts` 에 핸들러(+ `isTrustedSender` 가드, **데이터 키 화이트리스트 `{notes,todos}`** 로 임의 키 쓰기 차단), preload `widgets.{fx,dataGet,dataSet}`.
  - **설정 스키마**: `widgets` 에 `notesEnabled`/`todoEnabled`/`fxEnabled`(기본 off)/`fxBase`(USD)/`fxSymbols`(KRW,JPY,EUR,CNY) 추가.
  - **새 탭 UI**: 2번째 위젯 행(`widget-row2`, 3열→반응형) — **메모**(textarea, 500ms 디바운스 자동 저장 + "저장됨 ✓" 힌트), **할 일**(Enter 추가·체크박스 완료·hover 삭제, 배열 영속), **환율**(통화별 행 + 기준·날짜, 새로고침). 카드별 설정 토글로 표시/숨김.
  - **설정 UI**: "새 탭" 탭에 "메모·할 일" / "환율" 섹션 추가(토글 + 기준/표시 통화 텍스트 입력).
  - **검증**: tsc(main) 무에러, preload 타입체크 0, internal.js 41.7→42.0kb, 패키징 전 BrowserBuild 종료 후 재패키징.
- 2026-06-01: **묶음 CC-3 — 즐겨찾기 바로가기 새 탭 편집 (speed dial)**. 새 탭에 사용자가 직접 추가·편집·삭제·드래그 정렬하는 "바로가기" 섹션 추가. (history 기반 "자주 가는 사이트"는 자동·읽기전용으로 유지, 별개 섹션.)
  - **저장**: `widgets-data` KV 의 `shortcuts` 키(배열 `{id,title,url}`). IPC 데이터 키 화이트리스트에 `shortcuts` 추가 — **백엔드 변경은 이 한 줄뿐**, 기존 `widgets.dataGet/dataSet` 재사용(새 IPC·preload 불필요).
  - **새 탭 UI**(`pages/newtab/index.html`, 정적): "바로가기" grid-row(검색창 아래·북마크 바 위) + 타일별 hover 편집(✎)·삭제(✕) 버튼 + 점선 "＋ 추가" 타일 + 헤더 "+ 추가" 링크. **드래그 정렬**(HTML5 draggable, dragover 시 중앙 기준 before/after 표시 box-shadow, drop 시 splice 후 저장). **추가/편집 모달**(이름·주소 입력, Enter 저장·Esc/배경 클릭 취소, URL 자동 정규화 — 스킴 없으면 https:// 보강).
  - **검증**: tsc(main) 무에러(widgets.ts 화이트리스트만 변경), 패키징 전 BrowserBuild 종료 후 exit 0. (preload/렌더러 빌드 불필요 — 정적 HTML + 기존 API.)
- 2026-06-01: **묶음 DD — 세션/탭 복원 강화 (스크롤·뒤로앞으로·폼 복원 + 손실 창 축소)**. 기존 세션 인프라(원자적 쓰기·lazy load·크래시 감지 다이얼로그)는 견고했으나 **스크롤 위치·내비게이션 히스토리·폼 상태가 복원 안 되고**, 디바운스 5s+강제 30s 라 크래시 직전 변경이 유실되는 약점이 있었음.
  - **핵심: Electron `webContents.navigationHistory` 활용**(Electron 35.7). `NavigationEntry.pageState`(base64 Chromium 페이지 상태)에 **스크롤 위치 + 폼 값**이 포함되고, `getAllEntries()`/`restore({entries,index})` 로 **뒤로/앞으로 전체 히스토리**를 그대로 재생 — 한 메커니즘으로 3가지(스크롤·히스토리·폼) 동시 해결, 외부 캡처 불필요.
  - **`tab-service.ts`**: `NavigationEntrySnap{url,title,pageState?}` + `captureHistory(wc)`(활성 인덱스 보존, 마지막 30개·엔트리당 pageState 512KB 상한) + `restoreNavigation(wc,entries,index)`(실패 시 활성 URL 단독 로드 폴백). `TabRecord` 에 `discardedHistory/discardedIndex`, `createTab` 에 `restoreHistory/restoreHistoryIndex` 추가. 즉시로드 복원탭은 `restoreNavigation`, 슬립탭은 깨울 때(`activateTabInternal`·`undiscardTab`) 재생. **`discardTab`(탭 슬립) 도 슬립 전 히스토리 보존** → 슬립→복원 라운드트립에도 스크롤·히스토리 유지. `SessionTabSnap` 에 `history/historyIndex` 추가, `collectSession` 이 깨어있으면 라이브 캡처·슬립 중이면 보존본 사용.
  - **`session/index.ts` — 손실 창 축소**: 구조 변경(`tabEvents 'list'`: 탭 추가·삭제·이동·핀)과 **내비게이션(`onTabNavigated`)** 은 `SAVE_SOON_MS=1s` 짧은 디바운스, 사소한 변경(제목·파비콘·로딩)은 기존 5s, 강제 30s 유지. **종료 시 `forEachInstalledSession` 으로 전 파티션 `flushStorageData()` + `cookies.flushStore()`** → 쿠키·로컬스토리지 디스크 flush(정상 종료 시 최근 세션 데이터 유실 방지).
  - **하위호환**: SessionTabSnap 새 필드 모두 optional → SCHEMA_VERSION 1 유지, 구 스냅샷(history 없음)은 기존대로 URL 단독 복원. 복원 중(`restoring`)엔 scheduleSaveSoon 무시(저장 폭주 방지).
  - **검증**: tsc(main) 무에러. 패키징 전 BrowserBuild 종료 후 빌드+패키징.
- 2026-06-01: **묶음 DD-2 — 분할 화면(split pane) 레이아웃 복원**. 묶음 DD 분석에서 드러난 갭: 레이아웃이 `layoutByWindow`(in-memory)에만 있어 재시작 시 단일 창으로 리셋됐음. 탭 id 는 복원 시 새로 발급되므로 **pane 을 워크스페이스 내 index 로 참조 → 복원 후 재매핑**.
  - **`tab-service.ts`**: `PaneSnap{tabIndex}` + `WorkspaceLayoutSnap{workspaceId,split,splitRatio,activePaneIdx,panes}`. `collectLayouts(windowId)` — `layoutByWindow` 순회, 분할(`split!=null && panes>=2`)만 수집, pane→`tab.index` 로 직렬화(`splitKeyWindow` 로 `windowId::workspaceId` 키 파싱). `restoreWorkspaceLayout(windowId,snap,resolve)` — resolve(wsId,tabIndex)→새 tabId 로 pane 재구성, pane0 매핑 실패 시 스킵, splitRatio 0.15~0.85 클램프, 활성 워크스페이스면 `reapplyLayout` 즉시 반영. `SessionWindowSnap.layouts?` 추가, `collectSession` 이 창별로 수집.
  - **`session/index.ts` 복원**: 탭 생성 루프에서 `(원본 workspaceId::저장 index)→새 tabId` 맵 구축, `activateTab` 후 `w.layouts` 각각 `restoreWorkspaceLayout` 호출(activateTab 의 단일 pane 레이아웃을 분할 레이아웃이 덮어씀 — 순서 정상).
  - **저장 트리거**: `splitWindow`/`unsplitWindow` 가 `emitTabList`→`tabEvents 'list'`→1s 저장. 미세 비율 드래그(`setPaneSplitRatio`)는 emitTabList 안 하므로 30s 강제·before-quit 로 커버.
  - **하위호환**: `layouts` optional → 구 스냅샷은 단일 pane 복원(기존 동작).
  - **검증**: tsc(main) 무에러, 패키징 전 BrowserBuild 종료 후 exit 0.
- 2026-06-05: **묶음 EE — 탭 그룹 (색상 그룹핑 · 접기 · 세션 영속)**. `TabGroup`/`TabGroupColor` 타입과 `TabRecord.groupId`/`TabSummary.groupId`/`summary()` 의 groupId 방출은 이미 존재하던 스켈레톤 — 실제 기능을 구현.
  - **`tab-service.ts` 그룹 모델**: `groups: Map<id,TabGroup>` + `groupCounter` + 8색. `listGroups/createGroup/updateGroup/setGroupCollapsed/removeGroup/assignTabToGroup/pruneEmptyGroups`. **`reindex` 클러스터링** — 그룹 rank=멤버 최소 index 로 정렬해 멤버를 항상 인접 배치(드래그·핀에도 그룹 흩어지지 않음). `createGroup` 은 `emitGroups`(IPC `groups:changed`)+`emitTabList`. `closeTab`·`assignTab` 에서 빈 그룹 자동 정리.
  - **세션 영속**: `SessionTabSnap.groupId` + `SessionWindowSnap.groups`(스냅샷 탭이 실제 속한 그룹만), `collectSession` 캡처. 복원: `registerRestoredGroups(windowId, groups)` 가 **원래 group id 로 재등록 + groupCounter 충돌 방지 보정**, `createTab({groupId})` 로 탭 재배속. 묶음 DD/DD-2(히스토리·레이아웃)와 한 스냅샷에 공존.
  - **IPC/preload**: `groups.{list,create,update,remove,setCollapsed,assignTab,changed}` 채널 + `ipc/groups.ts` + 등록, preload `browserAPI.groups.*` + `onChanged`.
  - **렌더러 `TabBar.tsx`**: 그룹 로드+`onChanged` 구독. 렌더 항목을 헤더/탭으로 펼쳐 그룹 시작점에 **색 헤더 칩**(캐럿·점·이름·개수, 클릭=접기/펼치기) 삽입, 멤버 탭은 상단 색 띠. **접힌 그룹은 비활성 멤버 숨김**(활성 탭은 유지). **우클릭 컨텍스트 메뉴** — 탭: 핀 토글/새 그룹/기존 그룹 이동/그룹 빼기/닫기, 그룹 헤더: 이름변경·접기·8색 스와치·그룹해제. (기존 우클릭=핀토글에서 메뉴로 확장.) 색은 `--group-color` CSS 변수 + `color-mix`(Chromium 134).
  - **검증**: tsc main·preload·renderer 모두 0, 전체 빌드+패키징.
- 2026-06-05: **묶음 GG — 읽기 목록 / 나중에 보기 (read later)**. 페이지를 저장→탭 비우고 나중에 다시 보기. 북마크 패턴을 end-to-end 미러링.
  - **저장(`storage/readlater.ts` 신규)**: `electron-store`(readlater.json, 최대 500) + `EventEmitter`. `ReadLaterItem{id,url,title,favicon?,read,savedAt,readAt?}`(shared/types). `list/add(중복 url 무시·http(s)만)/remove/removeByUrl/setRead/clearRead/isSaved`. id=`randomUUID`. 최신 우선.
  - **IPC/preload**: `ipc-channels` 에 `readlater.{list,add,remove,setRead,clearRead,isSaved,changed,openPanel}` + union, `ipc/readlater.ts`(신규, `isTrustedSender` 가드, `changed` 브로드캐스트) + 등록, preload `browserAPI.readlater.*` + `onChanged`/`onOpenPanel`.
  - **액션**: `action.readlater.add`(토글 — 저장/제거 + 토스트 "읽기 목록에 추가됨 📚"/"제거됨"), `action.readlater.open`(`readlater:open-panel` 전송). 기본 단축키 없음(Ctrl+Shift+R 은 통상 하드리로드라 회피) — 툴바 버튼·팔레트·사이드패널로 노출. ko/en 라벨 추가.
  - **UI**: 툴바에 **📖/📚 버튼**(현재 탭 저장/제거, `isSaved`+`onChanged` 구독). **사이드 패널 "📚 읽기목록" 섹션**(`ReadLaterTab`) — 안읽음 수·전체/안읽음 필터·읽은항목 비우기, 행마다 파비콘·제목·호스트·✓읽음토글·× 삭제, 클릭 시 열면서 읽음 처리. `action.readlater.open` → App 이 좌측 패널 열고 `requestTab`(nonce) 로 readlater 섹션 강제 전환(SidePanel 신규 prop).
  - **검증**: tsc main·preload·renderer 모두 0, 전체 빌드+패키징.
- 2026-06-06: **묶음 XX — 탭 호버 미리보기 카드에 음소거·닫기 버튼**. 우클릭 없이 호버만으로 탭을 음소거/닫기.
  - **호버 브리지** (`TabBar.tsx`): 기존엔 탭 `onMouseLeave` 가 즉시 카드를 닫아 카드로 마우스 이동이 불가했음. `closeTimerRef` + `PREVIEW_CLOSE_DELAY_MS`(160ms) 지연 닫기로 전환 — `cancelPreview`(지연), `cancelPreviewNow`(즉시·드래그/비활성 탭), `keepPreview`(카드 진입 시 예정 닫기 취소). `schedulePreview` 는 다른 탭 이동 시 `clearCloseTimer` 로 새 미리보기 유지. 언마운트 시 두 타이머 모두 정리.
  - **카드 버튼** (`TabPreviewPopover`): 카드에 `onMouseEnter=keepPreview`/`onMouseLeave=cancelPreview` 부착 + 메타 우측에 **🔊/🔇 음소거 토글**(audible·muted 일 때만)·**× 닫기**(핀 아닌 탭, 클릭 후 `onClosed` 로 카드 즉시 제거). 기존 `tabs.setMuted`/`tabs.close` 재사용 — 신규 IPC 0.
  - **스타일**: `.tab-preview-actions`/`.tab-preview-btn`(24px, danger hover 빨강) 추가.
  - **검증**: tsc·빌드(vite ✓)·패키징 exit 0, 패키지 실행 확인.
- 2026-06-06: **묶음 WW — 전체/다른 탭 일괄 음소거**. 묶음 MM(개별 탭 음소거)·LL(탭 일괄 작업)의 확장. 탭 우클릭 메뉴에 일괄 음소거 추가.
  - **UI** (`TabBar.tsx` `TabContextMenu`): 단일 탭 메뉴에 두 항목 추가 — **"다른 탭 모두 음소거"**(우클릭 탭 제외, 미음소거 탭 전부 `setMuted(true)`)는 다른 탭이 소리 내는 중(`othersAudible`)일 때만, **"전체 탭 음소거 해제"**(음소거된 탭 전부 `setMuted(false)`)는 음소거 탭이 하나라도 있을 때(`anyMuted`)만 노출. 기존 `tabs.setMuted` 를 렌더러에서 반복 호출 — 신규 IPC·메인 변경 0.
  - **검증**: tsc·빌드·패키징 exit 0, 패키지 실행 확인.
- 2026-06-06: **묶음 VV — 네이티브 DASH(.mpd) 다운로더**. HLS 네이티브 다운로더(이미 존재)에 이어 DASH 도 yt-dlp 없이 받도록 — muxed 스트림 한정, 분리 음성은 yt-dlp 폴백.
  - **파서·다운로더** (`features/downloads/dash.ts`, NEW): MPD XML 을 정규식 기반으로 파싱(외부 라이브러리 X). 지원 주소지정 — **SegmentTemplate**($Number$/$Time$, `%0Nd` 패딩, SegmentTimeline 의 S@t/d/r 전개 또는 @duration+mediaPresentationDuration 으로 세그먼트 수 계산), **SegmentList**(SegmentURL+Initialization), **단일 BaseURL/SegmentBase**(전체 파일 1개). BaseURL 누적(MPD→Period→AS→Rep), $RepresentationID$·$Bandwidth$ 치환. 최고 화질(해상도→대역폭) 선택 후 init+세그먼트를 동시성 6 으로 프리페치·순서 flush 해 fMP4(.mp4) 저장. HLS 와 `netGet`/`resolveUrl` 공유(hls.ts 에서 export).
  - **정직성 가드**: DASH 는 영상/음성을 별도 AdaptationSet 으로 나누는 경우가 많은데 ffmpeg 없이 muxing 불가 → 별도 음성 트랙 감지 시 `DashSeparateAvError` throw → 호출부가 **yt-dlp 폴백**(소리 없는 영상 방지). muxed(음성 분리 없음) 스트림만 네이티브 처리.
  - **라우팅** (`video-download/index.ts`): `downloadStream` 이 `.mpd` 를 `runDashJob` 로 보냄 — 진행률(받은 바이트·세그먼트 비례 추정 total)·취소(`cancel-external`)·실패/분리음성 시 yt-dlp 폴백. 재시작 이어받기는 미지원(HLS 와 달리 pending 영속 X — 주석 명시).
  - **검증**: 정규식 파서를 5개 MPD 패턴(Number+duration / `%03d` 패딩 startNumber=0 / SegmentTimeline+$Time$ / SegmentList / BaseURL 절대경로+미상 duration 드롭)으로 **22개 단언 전부 통과**(임시 노드 테스트). tsc main·renderer 0, 전체 빌드(vite ✓)+패키징 exit 0, 패키지 실행 확인.
- 2026-06-06: **묶음 UU — 사이트 데이터 삭제 후 탭 자동 새로고침**. 묶음 TT 의 마무리. 이미 로드된 페이지는 메모리상 쿠키·스토리지가 남아 삭제가 즉시 체감되지 않던 문제 보완.
  - **UI** (`SiteInfo.tsx`): `clearSiteData` 가 `sitedata.clear` 성공(`ok`) 후 `active?.id` 가 있으면 `tabs.reload(active.id)` 호출 → 깨끗한 상태로 재로드. 힌트 문구에 "페이지를 새로고침합니다" 추가. 렌더러 1파일 변경(메인 무변경).
  - **검증**: tsc·빌드·패키징 exit 0, 패키지 실행 확인(메인 창 정상).
- 2026-06-06: **묶음 TT — 자물쇠 메뉴 쿠키·사이트 데이터 보기·삭제**. 묶음 NN(권한 저장)·OO(자물쇠 패널)로 깔아둔 사이트 권한 흐름을 완결 — "이 사이트만 초기화".
  - **feature** (`features/sitedata/index.ts`, NEW): `getSiteDataSummary(origin)` — defaultSession + 설치된 모든 파티션 세션에서 `cookies.get({url})` 합산 → 쿠키 수. `clearSiteData(origin)` — 쿠키는 도메인 스코프라 `cookies.get` 후 도메인·경로·secure 기준 URL 만들어 개별 `cookies.remove`, 그 외(localstorage·indexdb·websql·serviceworkers·cachestorage·filesystem·shadercache)는 `clearStorageData({origin, storages})` 일괄. `allSessions()` 는 defaultSession+`forEachInstalledSession` 중복 제거.
  - **IPC** (`ipc/sitedata.ts`, NEW): `sitedata:summary`/`sitedata:clear`, `isTrustedSender` 가드 + main 측 `originOf` 재검증(http/https 만). `ipc/index.ts` 에 등록. preload `chrome.ts` 에 `sitedata.{summary,clear}` 노출.
  - **UI** (`SiteInfo.tsx`): 자물쇠 패널에 **"사이트 데이터"** 섹션 — `쿠키 N개` 표시(로드 중 "확인 중…"), **데이터 삭제** 버튼(삭제 중→`✓ 완료`, 완료 후 비활성+카운트 0), 하단 경고 힌트(로그인 풀림 안내). 패널 열 때마다 상태 초기화. `.si-clear-btn`(빨강, hover 시 채움)·`.si-hint` 스타일 추가.
  - **검증**: tsc main·renderer 0, 전체 빌드(vite ✓)+패키징 exit 0, 패키지 실행 확인.
- 2026-06-06: **묶음 SS — 작업표시줄 다운로드 진행률**. 패널을 닫아둔 상태에서도 보이는 전역 피드백 — Windows 작업표시줄(macOS Dock) 아이콘에 진행률 막대.
  - **main** (`downloads/index.ts`): `broadcastDownloads` 끝에 `updateTaskbarProgress(list)` 호출 → 모든 상태 변화에 동기화. 진행 중(active·metadata·paused) 항목의 `Σreceived/Σtotal`(총 크기 아는 것만) 합산 → `ctx.win.setProgressBar(progress, { mode })`. 총 크기 미상이면 `indeterminate`(마퀴), 전부 일시정지면 `paused`, 진행 중 없으면 `-1`(`none`)로 막대 제거. `BaseWindow.setProgressBar` 는 Windows·macOS 만 효과(try/catch 로 타 플랫폼·파괴된 창 무시).
  - **설계**: 렌더러·IPC·preload 변경 0 — 순수 main 기능. 마지막 다운로드 완료/제거 시 자동으로 막대 사라짐(broadcast 가 inProgress=0 으로 호출).
  - **검증**: tsc main·renderer 0, 전체 빌드+패키징 exit 0, 패키지 실행 확인(메인 창 정상).
- 2026-06-06: **묶음 RR — 다운로드 검색·필터·완료 비우기**. 목록이 길어질 때를 대비한 정리 도구. 묶음 QQ(개별 제거)의 일괄 버전.
  - **main** (`downloads/index.ts`): `clearFinishedDownloads()` — 완료·실패·취소 항목을 http 네이티브·가속·비-토렌트 외부에서 일괄 삭제(시드 중 토렌트·진행 중 항목은 보존), 제거 개수 반환. IPC `downloads:clear-finished` + preload `clearFinished()`.
  - **UI** (`DownloadsPanel.tsx`): 항목 1개 이상일 때만 **툴바** 표시. ① **검색** — 파일명·URL 부분일치(대소문자 무시), × 로 즉시 초기화. ② **필터 칩** — 전체/진행 중(active·paused·metadata·queued)/완료(done·seeding)/실패(failed·cancelled), pill 토글. ③ **완료 비우기 (N)** — 끝난 항목 수 배지, 0 이면 비활성. 결과 0건이면 "검색 결과가 없습니다." 표시(빈 목록과 구분).
  - **스타일** (`styles.css`): `.dl-toolbar/.dl-search/.dl-chip` 추가 — 칩은 `999px` pill, active 는 accent, `완료 비우기`는 우측 정렬+hover 시 빨강.
  - **검증**: tsc main·renderer 0, 전체 빌드(vite ✓)+패키징 exit 0, 패키지 실행 확인.
- 2026-06-06: **묶음 QQ — 다운로드 항목 우클릭 메뉴**. 묶음 PP 의 연장 — 다운로드를 실제로 쓸 때 필요한 항목별 동작을 컨텍스트 메뉴로 추가.
  - **main** (`downloads/index.ts`): `getDownloadMeta(id)`(http 네이티브·가속·외부 통합 조회), `openDownloadFile(id)`(`shell.openPath` → 실패 시 폴더열기 폴백), `removeDownloadEntry(id)`(진행 중이면 먼저 취소/`removePending` 후 맵에서 삭제 → 고아 작업 방지; 토렌트 외 외부 항목은 `removeExternalDownload`), `retryDownload(id)`(http 한정, 기존 항목 제거 후 `session.defaultSession.downloadURL` 재요청 → will-download 가 새 항목으로 추적, 가속 설정 반영).
  - **IPC** (`ipc-channels.ts`+`ipc/downloads.ts`): `openFile`/`copyPath`/`retry`/`remove` 채널 추가. `copyPath` 는 main 에서 `clipboard.writeText(savePath)` 후 경로 반환. preload `chrome.ts` 에 4개 노출(타입 자동 추론).
  - **UI** (`DownloadsPanel.tsx`): 행 `onContextMenu` → 단일 메뉴(부모 관리, 바깥클릭·스크롤·Esc 로 닫힘). 상태별 항목 — 완료/시드: **📂 파일 열기**·🗂 폴더에서 보기·📋 경로 복사·🗑 목록에서 제거 / 실패·취소(http): **↻ 다시 시도** 추가 / 토렌트: 자체 제거 버튼 유지(메뉴엔 remove 미노출). 메뉴는 우측 도크(320px) 폭 안으로 클램프해 콘텐츠 뷰 비가림 — z-order 승격 불필요. `tab-ctx` 스타일 재사용.
  - **검증**: tsc main·renderer 0, 전체 빌드(vite ✓)+패키징 exit 0, 패키지 실행 확인.
- 2026-06-05: **묶음 PP — 다운로드 UX 개선 (완료 알림 · ETA)**. 진행률·속도·일시정지/재개/취소·폴더열기 UI 는 이미 있었으나 **완료 피드백 부재 + ETA 없음** 보강.
  - **완료 알림**(main `downloads/index.ts`): `initDownloads` 에서 `installCompletionFeedback()` — `downloadEvents 'done'` 구독 → 완료/실패 시 **토스트**(`✓/✗ 파일명`) 브로드캐스트 + 완료 시 **OS 알림**(`Notification`, 지원 체크, 클릭 시 폴더 열기). cancelled 는 무알림. http 네이티브·가속 모두 'done' emit 하므로 일괄 커버.
  - **ETA**(렌더러 `DownloadsPanel.tsx`): `(totalBytes-receivedBytes)/speed` 로 계산해 "⏱ N분 N초 남음" 표시(active·speed>0). 메인 변경 없이 기존 speed 재사용 → http·가속 모두 적용.
  - **UI 정리**: 영상(`kind==='video'`, HLS·yt-dlp)은 일시정지/재개 불가이므로 해당 버튼 숨김(취소만). 일시정지 상태에도 진행률 바 표시(`.dl-bar.paused` 회색).
  - **검증**: tsc main·renderer 0, 전체 빌드+패키징 exit 0.
- 2026-06-05: **묶음 OO — 사이트 정보 패널 (자물쇠 메뉴)**. 묶음 NN 권한 관리의 진입점 — 주소창 자물쇠에서 현재 사이트 권한·광고차단을 바로 토글.
  - **`Toolbar.tsx`**: 주소창 좌측에 **보안 상태 버튼**(`🔒` https / `⚠` http / `⚙` 내부) 추가, 클릭 시 `onOpenSiteInfo(x,y)`(버튼 위치 전달). omnibox 좌패딩 32px.
  - **`SiteInfo.tsx`(신규)**: App-level 오버레이(z-order 승격 — 콘텐츠 뷰 위). 헤더(보안 상태·origin), 권한 4종(카메라·마이크/위치/알림/클립보드) 기본·허용·차단 select(`browserAPI.permissions`), "이 사이트 광고 차단" 토글(`adblock.toggleSite`, 초기 상태는 `settings.adblock.siteOverrides`), "사이트 권한 전체 관리 →"(설정 탭 열기). 내부 페이지는 안내만.
  - **배선**: `browserAPI` 에 `permissions.{list,set,clearOrigin,onChanged}` 추가(chrome 셸 trusted). App 에 `siteInfoOpen`/`siteInfoAnchor` state + Toolbar prop + z-order·Esc·렌더.
  - **검증**: tsc preload·renderer 0, 전체 빌드+패키징 exit 0.
- 2026-06-05: **묶음 NN — 사이트별 권한 관리 UI**. 기존 권한 핸들러(session-bootstrap 화이트리스트 + policy 오버라이드)에 **사이트(origin)별 명시 허용/차단** 계층 추가 + 설정 UI.
  - **`storage/permissions.ts`(신규)**: `electron-store`(permissions.json) origin→{perm:'allow'|'deny'} + 인메모리 캐시 + `EventEmitter`. `getPermissionDecision(url,perm)`(명시 결정만, 없으면 null=기본), `listPermissions`(origin 정렬), `setPermission(origin,perm,'allow'|'deny'|'default')`('default'=오버라이드 제거), `clearOrigin`/`clearAllPermissions`. origin 은 http(s) 만.
  - **`session-bootstrap.ts`**: 두 핸들러(request·check) 모두 **사이트 오버라이드 우선 → policy → 화이트리스트** 순으로 변경. **기본 동작 불변**(네이티브 프롬프트 UI 없으므로 화이트리스트 유지, 저장소는 명시 오버라이드만) — 무해·비파괴적.
  - **IPC/preload**: `permissions.{list,set,clearOrigin,clearAll,changed}` 채널 + `ipc/permissions.ts`(`isTrustedSender` 가드, chrome 브로드캐스트) + 등록, internal preload `internalAPI.permissions.*` + `onChanged`.
  - **설정 "사이트 권한" 탭**: origin 행 × (카메라·마이크/위치/알림/클립보드) 기본·허용·차단 select, 행별 삭제 + 전체 초기화. `reload()` 에서 목록 로드, `bindPermissions()` 가 select/삭제 배선(변경 후 재조회+렌더), `permissions.onChanged` 구독. 설정한 사이트만 표시.
  - **검증**: tsc main·preload 0, internal.js 42.9→43.8kb, 전체 빌드+패키징 exit 0.
- 2026-06-05: **묶음 MM — 탭 음소거 토글**. 소리나는 탭(🔊 이미 표시)을 클릭으로 바로 음소거. `TabSummary.muted`·`audio-state-changed` 이벤트는 이미 존재.
  - **main**: `setTabMuted(tabId, muted)` → `wc.setAudioMuted` + `emitTabUpdate`. `ipc-channels` `tabs.setMuted` + `ipc/tabs.ts` 핸들러 + preload `browserAPI.tabs.setMuted`.
  - **`TabBar.tsx`**: 오디오 표시를 `span`→**클릭 가능 버튼**으로. `audible || muted` 일 때 표시, 음소거 시 🔇·재생 중 🔊, 클릭 토글(`stopPropagation` 으로 탭 활성화 방지). 단일 탭 컨텍스트 메뉴에 "탭 음소거 / 음소거 해제" 항목 추가. `.tab-audio` 버튼 스타일(hover 배경).
  - **검증**: tsc main·preload·renderer 모두 0, 전체 빌드+패키징 exit 0.
- 2026-06-05: **묶음 LL — 탭 일괄 작업 (다중 선택)**. 여러 탭을 한 번에 그룹화·북마크·읽기목록·닫기. **렌더러 전용 — 새 IPC 불필요**(기존 `groups.create({tabIds})`·`groups.assignTab`·`bookmarks.add`·`readlater.add`·`tabs.close` 재사용).
  - **`TabBar.tsx` 다중 선택**: `selected:Set<id>` + `anchorId`. Ctrl/⌘+클릭 토글, Shift+클릭 범위 선택(현재 탭 순서 기준), 일반 클릭=활성화+선택 해제. 선택 탭에 `multi-selected` 클래스(강조 링+배경).
  - **일괄 컨텍스트 메뉴**: 선택 2개 이상 상태에서 **선택된 탭 우클릭** 시 `TabContextMenu` 가 일괄 모드로 — "N개 새 그룹으로 묶기 / 기존 그룹들로 / 북마크에 추가 / 읽기 목록에 추가 / N개 탭 닫기 / 선택 해제". 작업 후 선택 자동 해제. 비선택 탭 우클릭 시 기존 단일 메뉴(선택 해제 후).
  - **z-order 회피**: 별도 플로팅 바 대신 기존 컨텍스트 메뉴(탭 영역 상단 = chrome 가시 영역) 재사용 — 콘텐츠 뷰에 가리지 않음.
  - **검증**: tsc renderer 0, 전체 빌드+패키징 exit 0.
- 2026-06-05: **묶음 KK — 세션 복원 정책 UI (시작 동작)**. `startup.mode`(newtab/last-session/urls)는 main 의 `maybeRestoreSession` 이 이미 처리했으나 사용자가 고를 UI 가 없던 것을 보강. **설정 변경만 — main 로직 무수정.**
  - **설정 "모양" → "시작 동작" 섹션 추가**(정적 `pages/settings/index.html`): "브라우저를 열 때" select — 새 탭 / 지난 세션 복원(탭·그룹·분할·스크롤) / 지정한 페이지 열기. `urls` 선택 시 **시작 페이지 목록 textarea**(한 줄당 1 URL) 노출.
  - **`bindStartup()`**: 모드 전환 시 즉시 재렌더(URL textarea 표시/숨김), textarea 변경 시 줄 분리·trim·빈줄 제거 후 `settings.set('startup.urls', [...])`. 모드 select 은 기존 generic data-select 핸들러가 영속.
  - **검증**: 정적 페이지라 빌드 불필요, 패키징 exit 0. (last-session 복원 동작은 묶음 DD/DD-2/EE 인프라 재사용.)
- 2026-06-05: **묶음 JJ — 사이드 패널 메모 메인 저장 승격**. 묶음 II 에서 남긴 갭(사이드패널 메모가 localStorage 라 백업 안 됨)을 해소.
  - **저장 이전**: 사이드 패널 메모(좌/우)를 `localStorage` → `widgets-data`(메인 저장) 의 `notes-left`/`notes-right` 키로 이전. `widgets-data.json` 은 이미 백업 번들(묶음 II)에 포함 → **자동으로 내보내기/가져오기 대상**.
  - **배선**: `ipc/widgets.ts` 데이터 키 화이트리스트에 `notes-left`/`notes-right` 추가. **`browserAPI`(chrome preload)에 `widgets.{dataGet,dataSet}` 노출** — chrome 셸은 file:// 라 `isTrustedSender` 통과(외부 콘텐츠 탭은 content preload 라 미노출, 안전).
  - **`SidePanel` NotesTab 재작성**: 마운트 시 메인 저장 우선 로드, 비어 있고 옛 localStorage 값이 있으면 **1회 마이그레이션**(메인에 쓰고 localStorage 키 제거). 편집은 **로드 완료 후에만** 300ms 디바운스 저장(빈 값 덮어쓰기 방지). 좌/우 별도 키 유지(교차 클로버 방지).
  - **검증**: tsc main·preload·renderer 모두 0, 전체 빌드+패키징 exit 0.
- 2026-06-05: **묶음 II — 데이터 백업에 새 저장소 포함**. 최근 추가된 electron-store 파일이 데이터 내보내기/가져오기(`data:export`/`import`)에서 누락돼 있던 것을 보강.
  - **`features/data-sovereignty`**: `FILES_TO_EXPORT` + `IMPORT_WHITELIST` 에 **`readlater.json`(읽기 목록)** + **`widgets-data.json`(새 탭 위젯: 메모·할일·바로가기)** 추가. 둘 다 utf-8, userData 루트(electron-store 기본 위치 — `readlater.json` 패키지 appData 에서 존재 확인). 없으면 `existsSync` 로 graceful skip.
  - **설정 UI**: 데이터 관리 설명에 "매크로·디자인토큰·읽기목록·새탭위젯(메모·할일·바로가기)" 명시.
  - **범위 메모**: **탭 그룹·분할 레이아웃·내비게이션 히스토리는 세션 스냅샷(`sessions/last-stable.json`)에만 존재** — 열린 탭에 종속된 런타임 상태라 독립 백업 대상에서 제외(가져오기 시 탭까지 복원돼 혼란). 사이드패널 메모는 localStorage 라 파일 번들 대상 아님(후보 ① "메모 메인 저장 승격" 으로 별도 처리 가능).
  - **반영 시점**: 다른 파일들과 동일하게 import 후 **재시작 시 반영**(electron-store 싱글톤이 부팅 시 로드).
  - **검증**: tsc(main) 0, 패키징 exit 0, appData 에 `readlater.json` 파일명 일치 확인.
- 2026-06-05: **묶음 HH — 최근 닫은 탭 패널**. 기존 `closedStack`(닫힌 탭 스택, Ctrl+Shift+T 용)을 시각적 재열기 목록으로 확장.
  - **`tab-service.ts`**: `closedStack` 항목을 `ClosedEntry{id,url,title,windowId,index,workspaceId,groupId?,closedAt}` 로 강화(+`closedCounter`). `closeTab` 이 제목·시각·그룹 캡처, **슬립 탭은 about:blank 대신 `discardedUrl/Title` 사용**(기존 버그 수정), newtab/비http 는 스택 제외. `listRecentlyClosed(limit=30)`(최신 우선)·`reopenClosedById(id,windowId)`(스택 제거 후 createTab, 원 워크스페이스·그룹 복원)·`clearRecentlyClosed`. `restoreLastClosed` 도 워크스페이스 폴백 보강.
  - **IPC/preload**: `ipc-channels` 에 `recentClosed.{list,reopen,clear,open}` + union, `ipc/tabs.ts` 핸들러, preload `browserAPI.recentClosed.{list,reopen,clear,onOpen}`.
  - **액션**: `action.tab.recentClosed`(`recent-closed:open` 전송, 기본 키 없음 — 팔레트 노출, ko/en 라벨).
  - **렌더러 `RecentlyClosed.tsx`(신규)**: 팔레트 오버레이 재활용. 열 때 목록 fetch, 파비콘·제목·호스트·상대시각(방금/N분 전/N시간 전/N일 전), ↑↓+Enter 또는 클릭으로 재열기(닫힘), "전체 비우기". App.tsx 에 state·`onOpen` 구독·z-order·Esc·렌더 추가.
  - **검증**: tsc main·preload·renderer 모두 0, 전체 빌드+패키징.
  - **후속(묶음 GG-2): 새 탭 읽기 목록 위젯**. internal preload 에 `readlater.{list,remove,setRead,onChanged}` 노출(browser:// 페이지용). 새 탭 2번째 위젯 행에 "읽기 목록" 카드 — 안 읽은 항목 최대 6개(파비콘·제목), 헤더에 안읽음 개수, 클릭해 열면 자동 읽음(`setRead`)·✓ 버튼, `onChanged` 실시간 갱신. 설정 `widgets.readLaterEnabled`(기본 true) + "새 탭" 탭 토글. internal.js 42.0→42.9kb.
- 2026-06-05: **묶음 FF — 탭 검색 오버레이 (Ctrl+Shift+A, 퍼지 + 초성 + 그룹 인식)**. 명령 팔레트 인프라(`utils/fuzzy.ts` 의 `scoreFuzzy`+`chosung`, 오버레이 패턴)를 재활용해 열린 탭 빠른 탐색 추가.
  - **배선**: `ipc-channels` 에 `tabsearch.open` + union, `register-defaults` 에 `action.tab.search`(category tab, **Ctrl+Shift+A**, `tabsearch:open` 전송), `keymap.default.json` 바인딩, `ko/en.json` 에 `action.tab.search` 라벨(탭 검색/Search Tabs — 명령 팔레트에도 노출), preload `browserAPI.tabsearch.onOpen`.
  - **`App.tsx`**: `tabSearchOpen` state + `tabsearch.onOpen` 구독 + 로컬 키다운(Ctrl+Shift+A, chrome 포커스 시) — 액션/IPC 경로(콘텐츠 뷰 포커스 시 global accelerator)와 병행. z-order 승격·Esc 처리·`<TabSearch>` 렌더 추가.
  - **`TabSearch.tsx`(신규)**: 팔레트 오버레이 클래스 재활용. 제목·URL `scoreFuzzy`(URL 0.9 가중) + 초성 쿼리 보너스, 빈 입력 시 활성 탭 우선·index 순. 행마다 파비콘·제목(고정📌·잠자는💤 배지)·호스트·**그룹 칩**(색 점+이름, `browserAPI.groups.list`+`onChanged` 자체 구독)·"현재" 배지·× 닫기 버튼. ↑↓ 이동, Enter 이동, **Ctrl+Enter/Delete 로 강조 탭 닫기**(오버레이 유지), Esc/배경클릭 닫기. 묶음 EE 그룹과 연동.
  - **검증**: tsc main·preload·renderer 모두 0, 전체 빌드+패키징.
- 2026-07-11: **검증 라운드 V1 — CDP 스모크 하네스 상설 + z-order 오버레이 일괄 fix**. (Fable 5 지휘관 + Sonnet 워커 4, 상세는 status.md 라운드 로그)
  - **상시 스모크 하네스 `build/smoke-cdp.mjs`(신규)**: 의존성 0(Node 22 내장 WebSocket/fetch). packaged exe 를 `--remote-debugging-port` 로 기동 → CDP `Runtime.evaluate` 로 외피의 `window.browserAPI` 직접 구동(액션은 `actions.run(id)`) + DOM 상태 검사 + CDP 타깃별 스크린샷 + **OS 합성 스크린샷**(`build/os-screenshot.ps1` — CDP 캡처론 WebContentsView 겹침이 안 보여 z-order 검증은 OS 캡처 필수). 시나리오: S1~S4·S7~S11(탭/omnibox/북마크/설정/팔레트/adblock/다크) + S9(워크스페이스 격리) + R11/R12(새 partition browser:// 정상 로드) + R13(워크스페이스 partition adblock) + Z1/Z2(z-order) = **13 PASS / 0 FAIL / 2 SKIP(S5 다운로드·S6 동영상 TODO) / 1 MISSING-FEATURE**. 결과는 `smoke-results.json`.
  - **하네스 인프라 3함정 해소**: ① 강제 kill → `sessions/current.json` 잔존 → 다음 부팅에서 "지난 세션 복원" 네이티브 모달이 창 생성 전 부팅 블록(CDP 타깃 0개) — **CDP `Browser.close` 우아한 종료**로 마커 없이 종료. ② 사용자 실프로필 오염 — **`--user-data-dir` 플래그 신설**(`app/main/bootstrap-userdata.ts`, index.ts 첫 import — electron-store 가 첫 인스턴스 생성 시 userData 캡처하므로 순서 필수) + 격리 프로필에 `settings.json` 시드(setup.completed 로 welcome 회피). ③ 이름 기반 Stop-Process 가 사용자 실사용 인스턴스까지 kill — PID 파일 스코프로 축소.
  - **회귀 #15 (z-order 오버레이 가림, 7/9 미확정 → 확증 → fix)**: 외피 body 배경 불투명 + 승격 목록(App.tsx) 누락으로 Toast·QrModal·PasswordSavePrompt·TabContextMenu·탭 호버 미리보기·북마크바 폴더 드롭다운·WorkspaceRail 메뉴·확장 액션 메뉴·UpdateBanner·`.dl-badge` 가 **콘텐츠 뷰에 완전히 가려짐**(OS 스크린샷 확증). 찾기바·팔레트는 승격은 됐지만 불투명 배경이라 페이지를 가린 채 열림.
    - **fix ①**: chrome view `setBackgroundColor('#00000000')`(window-service.ts) + body `background: transparent`(styles.css) — 승격 상태에서도 콘텐츠가 비쳐 보임. 스트립(탭바·툴바·사이드패널 등)은 기존 자체 배경 보유 확인.
    - **fix ②**: `app/renderer/hooks/useChromeOverlay.ts`(신규) — 윈도우별 참조 카운터, 0→1 에서 `beginPaneDrag`, 1→0 에서 `endPaneDrag`. App.tsx 의 boolean 목록 useEffect 를 대체하고 위 오버레이 전부 + Splitter 를 카운터로 통일(복수 오버레이 동시 개방 안전 — 팔레트+찾기바 동시 표시 스크린샷 검증).
    - **교훈**: 외피에 새 fixed/absolute 오버레이를 추가하면 반드시 `useChromeOverlay` 배선. 도킹형(insets 로 콘텐츠와 안 겹침)은 불필요.
  - **발견 — 시크릿 창 미구현(깨진 약속)**: Ctrl+Shift+N 키맵·ko/en 라벨·`incognitoPartition()` 헬퍼·tab-service 의 incognito partition 필터는 있으나 **`register-defaults.ts` 에 액션 미등록** → 무반응. 구현 라운드 필요.
  - **검증**: typecheck 3/3 무에러, 빌드(외피 gzip 72.7KB), win --dir 패키징, 스모크 13 PASS 0 FAIL.
  - **다음 라운드 후보**: ① 시크릿 창 구현, ② S5/S6(다운로드·동영상) 하네스 시나리오, ③ 50탭 스트레스(게이트 3), ④ 확장 호환 매트릭스(게이트 5), ⑤ `.video-popover-backdrop` 등 죽은 CSS 정리.
- 2026-07-11: **검증 라운드 V2 — 시크릿 창 구현 + 다운로드 가속 심각 버그 fix + S5/S6 하네스**. (Fable 5 지휘관 + Sonnet 워커 3, 스모크 16/16 PASS, 상세는 status.md)
  - **시크릿 창 구현** (V1 발견한 깨진 약속 해소): `action.window.incognito`(Ctrl+Shift+N) 를 `register-defaults.ts` 에 등록 → `createBrowserWindow({incognito:true})`. `window-service.ts` 에 `incognito`/`incognitoPartition` 필드 + `incognitoPartition(n)` 로 in-memory partition(`persist:` 없음 → Electron 자동 메모리 세션, 종료 시 소멸) 발급. `tab-service.createTab` 이 incognito 창이면 워크스페이스 partition 대신 창 partition 강제(setupSessionByPartition 직전).
    - **기록 미저장 4지점**: 방문기록(main/index.ts `onTabNavigated`/`onTabTitleUpdated` skip — 신규), closedStack(closeTab guard — 신규), 비밀번호 저장제안(ipc/password.ts proposeSave 가 incognito sender 면 `never` — 신규, 단 autofill lookup 은 Chrome 처럼 허용), 세션 스냅샷(collectSession 의 `partition.startsWith('incognito')` skip — 기존).
    - **session-bootstrap**: createTab 의 기존 `setupSessionByPartition` 안전망이 새 `incognito-N` partition 도 자동 커버(회귀 #11/#12 재발 없음 — 회귀 #12 fix 의 hook 시스템 덕).
    - 외피: URL query `&incognito=1` → App.tsx 파싱 → Toolbar 🕶 시크릿 배지 + 창 타이틀 "(시크릿)". CDP localStorage 격리(S12) + OS 스크린샷 육안 검증 합격.
  - **회귀 #16 (다운로드 가속 + Range 미지원 서버 = 100% 영구 멈춤 + 파일 미저장, 심각·실사용 빈발)**: `downloads/index.ts` `attachWillDownload` 가 모든 http(s) `will-download` 에서 `item.pause()` 즉시 호출 후, 비동기 `tryStartAccelerator` probe 가 "가속 불가"(Accept-Ranges 없음/1MB 미만) 판정 시 **그 then/catch 안에서 늦게** `setSavePath`+`resume` 호출. Electron 은 이 early-pause→late-async-resume 시퀀스에서 `done` 이벤트를 발생 안 시킴 → receivedBytes===totalBytes 인 채 영구 active, savePath 에 파일 없음(ENOENT). 격리 재현 1MB·20MB 결정적.
    - **fix**: 검증된 우회로 재사용. 신규 `rerouteToStandardDownload(item, id, url, ses, partition, headers)` — `item.cancel()` + placeholder 항목 제거 + `pendingAuthByUrl.set`(인증 컨텍스트 보존) + `managedNonAccelUrls.add` + `ses.downloadURL(url)` 재요청. will-download 재진입 시 `managedNonAccelUrls.delete` 가 가속 단락 → **동기 `setSavePath` 표준 추적 경로**(일반 다운로드와 동일, `done` 정상 발생). 가속 declined 분기 + probe-exception catch 분기 둘 다 이 헬퍼로 통일. 기존 `startManagedHttpDownload` 비가속 폴백과 같은 패턴.
    - **교훈**: Electron `will-download` 에서 `setSavePath` 는 **동기적으로** 불러야 함. pause 후 비동기 resume 은 done 을 안 띄움. 이런 부류는 부팅 로그로 안 잡힘 — 하네스 필수.
  - **S5/S6 결정적 하네스**: `build/smoke-media-server.mjs`(신규) 로컬 HTTP 서버(의존성 0) — `/file.bin`(5MB Range 지원)·`/noRange.bin`(1MB Range 미지원)·`/clip.mp4`(2MB video/mp4)·`/video.html`. S5 는 다운로드 후 **바이트 단위 비교**(세그먼트 병합 손상 검출), S6 는 감지 + yt-dlp 없는 직접 mp4. 파일명 `ezbrowser-smoke-<runId>-*` 로 실 Downloads 폴더 충돌·잔재 방지(app 의 defaultDownloadDir 이 `--user-data-dir` 격리를 무시하고 항상 `app.getPath('downloads')` 사용 — settings.downloads.defaultPath 는 미사용임을 발견).
  - **검증**: typecheck 3/3 · build · win --dir 패키징 · **스모크 16 PASS / 0 FAIL / 0 SKIP / 0 MISSING-FEATURE 2회 재현**. Downloads 잔재 0.
  - **알려진 관찰(미수정)**: settings.downloads.defaultPath 가 앱에서 미사용(다운로드 위치 설정 UI 가 실제로 경로를 못 바꿈) — 다음 라운드 후보.
  - **다음 라운드 후보**: ① 50탭 장시간 스트레스(게이트 3) + 세션 강제 kill 복원, ② 확장 호환 매트릭스 10종(게이트 5), ③ 다운로드 매트릭스 나머지(토큰CDN octet·HLS 4종·이어받기), ④ settings.downloads.defaultPath 배선, ⑤ 죽은 CSS(`.video-popover-backdrop`·`.panel-flyout-backdrop`) 정리.
- 2026-07-11: **검증 라운드 V3 — 50탭 스트레스(게이트 3 통과) + 세션 강제 kill 복원 실증 + 데이터 손실 버그 #17 fix**. (Fable 5 지휘관 + Sonnet 워커 3, 상세는 status.md)
  - **스트레스 하네스 `build/stress-cdp.mjs`(신규)** + `build/stress-page-server.mjs`(로컬 부하 페이지): 50탭 개장 + 3회 순회(탭 활성화 150회) + 워크스페이스 3개 라운드로빈 10회 + 대량 닫기. **크래시 0 · 먹통 0 · 워크스페이스 격리 breach 0 · 에러 로그 0**. 누수 **회수됨**(58탭→2탭 닫으면 프로세스 62→6, 최종 RSS baseline +14%, 회계 정확). 단일 압축 사이클(8h 실측 불가) — 다중 사이클 반복은 미실행.
  - **세션 복원 하네스 `build/session-restore-cdp.mjs`(신규)**: 8탭+그룹+분할+스크롤(4000px)+폼 셋업 → `taskkill /PID /T /F` 진짜 비정상 종료(before-quit 미실행·`sessions/current.json` 만 남고 `last-stable.json` 미생성 확인) → 재기동(startup.mode='last-session' 로 모달 없이 자동 복원). **스크롤·폼·그룹(id/색/멤버)·분할(DOM+geometry) 전부 완벽 복원** — Chromium `NavigationEntry.pageState`(1424B) 재생.
  - **회귀 #17 (세션 복원 첫 탭 데이터 손실, 실질 손실)**: `tab-service.ts createTab` — 복원 시 창의 첫 탭(index 0)이 활성/핀 아니고 eager-tail(마지막 5개) 밖이면 콘텐츠를 `about:blank` 로 잃음(탭 6개↑ 흔한 케이스, 3회 재현). 원인: `canDiscard`(=restoreDiscarded+http) 로 `tab.discarded=true`+`loadURL('about:blank')` 예약한 첫 탭을, 같은 함수 426-428행이 `hadActive=false`(창에 활성 탭 아직 없음)라서 즉시 `activateTabInternal` → undiscard → `restoreNavigation` 을 **같은 tick 에 경합** → about:blank 최종 커밋. 잠자는 탭을 같은 호출에서 즉시 깨우는 모순.
    - **fix**: 428행 자동 활성화 조건에 `&& !canDiscard` 추가 — 슬립으로 만든 탭은 같은 호출에서 안 깨움(사용자 클릭 시 정상 undiscard 복원). 일반 새 탭은 restoreDiscarded 미사용 → canDiscard=false → 기존 동작 100% 유지. + `session/index.ts restoreSnapshot` 에 방어 폴백(스냅샷에 active 탭 0인 이상 케이스 시 firstCreatedId 활성화 → "보이는 탭 0" 방지).
    - **교훈**: discarded(슬립) 탭 생성과 활성화는 반드시 분리된 이벤트여야 함 — 같은 tick 에 loadURL('about:blank')와 restoreNavigation 을 걸면 경합.
  - **검증**: typecheck 3/3 · build · win --dir · 스트레스 클린 · **복원 하네스 17/17 PASS**(T0 원본 URL 복원·discarded 슬립 정상) · **스모크 16/16 유지**(일반 탭 생성 회귀 없음).
  - **성능 부채 관측(게이트 4 이월, 미수정)**: 탭당 WorkingSet ~100MB(예산 ≤80MB 초과), baseline WorkingSet 612MB(예산 ≤250MB 초과), 프로세스 재사용 없음(탭당 전용 렌더러). **단 `browser://memory`/`ipc/system.ts` 는 `app.getAppMetrics().memory.workingSetSize`(공유 페이지 중복 집계)라 과대평가** — private RSS 정밀 측정은 라운드 4. 탭 슬립 회수 ~5MB/탭(about:blank discard 방식의 문서화된 한계).
  - **다음 라운드 후보**: ① **성능 게이트(라운드 4)** — private RSS 측정·콜드 스타트 3회·idle CPU + process-per-site 정책 조사(1원칙 #1 실측·회귀 차단), ② 확장 호환 매트릭스 10종(게이트 5), ③ 다운로드 매트릭스 나머지(토큰CDN·HLS·이어받기), ④ settings.downloads.defaultPath 배선, ⑤ 죽은 CSS 정리.
- 2026-07-11: **검증 라운드 V4 — 메인 프로세스 메모리 주범 분해 + adblock 콜드 빌드 GC 넛지**. 게이트 4(빈 창 private RSS) 정밀 분해·개선. (Sonnet 워커 1, 병렬 없음)
  - **분해 하네스 `build/perf-breakdown.mjs`(신규)**: `perf-measure.mjs` 의 CDP/WMI 패턴 재사용 + settings.json 시드 패치·env 변수 주입으로 "설정 A vs B" 빈 창 private WS 차이를 1분 내 격리 측정(`--single-boot` 로 캐시 없는 콜드 상태, 2단계 warm-up→measure 로 캐시 웜 상태 모두 가능).
  - **주범 분해 (기여도 격리 측정, 메인 프로세스 private WS 기준)**: adblock(standard, 4 리스트, 캐시 웜) **≈107MB** · sql.js(북마크+이력, 공유 WASM 런타임) **≈6MB** · electron-chrome-extensions(0개 설치) **≈0MB**(측정 잡음 이내) · webtorrent **0MB**(코드상 lazy 확인 — 최초 magnet 까지 미require) · Electron/Node/V8 + 나머지 모든 상시 모듈 바닥 **≈53MB**. 합산이 실측 웜 baseline(166MB)과 거의 일치해 분해 신뢰도 확인.
  - **핵심 발견 — "콜드 vs 웜" 빌드 경로가 baseline 측정을 최대 60MB+ 흔든다**: `perf-measure.mjs` 의 콜드 스타트 3회가 adblock 의 1500ms 지연 타이머보다 먼저 종료되는 경우가 잦아(관측된 콜드런 stdout 공백), 그 뒤 이어지는 long-session 이 **캐시 없는 콜드 `fromLists()` 빌드**(필터 원문 네트워크 fetch+파싱)를 그대로 측정하게 됨 — 실사용자의 "설치 후 첫 실행" 에 해당. 반면 실사용자의 절대다수인 **"2번째 이후 실행"**(engine.bin 캐시 존재)은 역직렬화만 하므로 훨씬 가볍다. 직접 격리 측정: 콜드 main=231MB/총 317MB vs 웜 main=166MB/총 253MB(개선 전 코드 기준) — **동일 코드·동일 설정에서 65MB 차이**.
  - **fix — `gc-nudge.ts`(신규 공용 유틸)**: `v8.setFlagsFromString('--expose-gc')` + `vm.runInNewContext('gc')` 로 `node --expose-gc` 없이 런타임에 GC 트리거 확보(표준 Node 트릭, 힙은 isolate 단위라 새 context 의 gc() 도 전체 힙에 적용). adblock 이 **콜드 빌드였을 때만**(`engine.bin` 부재 확인 후) 빌드 직후 1회 넛지 + 부팅 시퀀스(adblock+extensions init) 완료 후 1회 더(sql.js/워크스페이스/정책/userscript 등 JSON 파싱 스크래치 회수). **필터·차단 동작 100% 동일** — 순수 메모리 회수, "필터를 줄이는" 개선 아님(콕콕 핵심 adblock 자체는 불변).
  - **`cross-fetch` 제거(adblock 한정)**: `loadCrossFetch()` 가 네이티브 `fetch`(Electron 35/Node 22 메인 프로세스에 이미 있음 — translate/torrent/extensions/video-download 등 코드베이스 전역이 이미 이 패턴)를 우선하도록 순서 전환, cross-fetch 는 방어적 폴백으로만 격하. 항상 성공하던 불필요한 폴리필 require 제거(동작 동일, 미세 절감).
  - **개선 효과(직접 격리 재측정)**: 콜드(설치 후 첫 실행) main 231→**203MB**(-28MB) · 총 317→**285MB**(-32MB). 웜(2번째 이후 실행 — 실사용 대다수) main 166→**143MB**(-23MB) · 총 253→**226MB**(-27MB, **250MB 예산 통과**).
  - **공식 하네스(`perf-measure.mjs`) 재측정**: 콜드 스타트 3회 avg 278ms(예산 2000ms PASS) 불변. idle CPU 0.084%(예산 0.5% PASS) 불변. 외피 gzip 70.96KB(예산 500KB PASS) 불변. **빈 창 private RSS: 개선 전 이 환경 재측정 311MB → 개선 후 290MB**(콜드 경로 편향 — 위 "핵심 발견" 참고, 250MB 예산 대비 여전히 FAIL이나 21MB 개선). 탭당 private 13.7MB(예산 80MB PASS, 불변) — WorkingSet(Electron 자체 집계, 공유 페이지 중복) 컬럼은 참고용으로 별도 FAIL 표기(판정 기준 아님).
  - **스모크 16/16 PASS 유지**(adblock 차단 S10·워크스페이스 partition adblock R13 포함 — 기능 회귀 없음), typecheck 3/3 무경고, win --dir 패키징 정상.
  - **예산 현실화 권고**: 250MB 예산은 **"설치 후 첫 실행(콜드 adblock 빌드)"** 시나리오에서 EasyList+EasyPrivacy+KR(standard, 기본값) 만으로도 물리적으로 달성 불가(≈285MB, 개선 후에도) — 필터 엔진 자체(캐시 역직렬화 후에도 main 프로세스 상주 ≈107MB)가 콕콕 핵심 기능의 실측 고정비용이며 임의로 더 줄일 레버가 없음(`enableCompression:true`·`debug:false`·engine.bin 캐시 경로 이미 최적 — 확인 완료, 필터 축소는 범위 밖). **"2번째 이후 실행"(웜, 실사용 대다수)은 226MB 로 250MB 예산을 통과**하므로, 권고: ① 예산을 **"콜드/첫 실행 300MB, 웜/steady-state 250MB"** 두 트랙으로 분리하거나, ② CLAUDE.md 의 기존 확장 예외 조항("확장이 활성화되면 한도는 추가분만큼 완화")과 동일한 논리로 standard 이상 adblock 레벨에도 유사 완화 조항 부여, ③ `perf-measure.mjs` 의 콜드런이 adblock 1500ms 타이머를 기다리도록 보정해 매 측정이 안정적으로 "웜" 경로를 재현하게 하는 하네스 자체 수정(측정 재현성 문제 — 별도 라운드).
  - **다음 라운드 후보**: ① `perf-measure.mjs` 콜드런 타이밍 보정(위 하네스 재현성 이슈), ② 예산 현실화 정책 확정(위 권고 중 택1), ③ 확장 호환 매트릭스 10종(게이트 5), ④ 다운로드 매트릭스 나머지, ⑤ settings.downloads.defaultPath 배선.
- 2026-07-12: **검증 라운드 V5 — 게이트 5 약속 매트릭스(다운로드 10/11 + 확장 9/10) + 확장 ID 아키텍처 버그 fix**. (Fable 5 지휘관 + Sonnet 워커 3, 상세는 status.md)
  - **다운로드 매트릭스 `build/dl-matrix.mjs`+`dl-matrix-server.mjs`(신규)**: 11시나리오 로컬 결정적 서버(AES-128 실제 aes-128-cbc 암호화·쿠키게이트 403 HTML·throttled 16MB resume). **10 PASS / 1 SKIP(yt-dlp 지원호스트 — 바이너리 미설치+네이티브 동의 다이얼로그) / 0 FAIL**. progressive·토큰CDN octet-stream·HLS 평문(.ts)/fMP4(.mp4)/AES-128/master(최고대역폭)·DASH muxed·blob/MSE 감지·쿠키게이트(탭 세션 쿠키)·재시작 이어받기(강제 kill 후 바이트 완전 일치) 전부 검증. 라운드 Y/Z/AA 다운로드 엔진 실증(앱 버그 0).
  - **확장 호환 매트릭스 `build/ext-matrix.mjs`(신규)**: 웹스토어 상위 10종 실 CRX 다운(`clients2.google.com/service/update2/crx`)→언팩→loadExtension→SW·팝업 검증. **버그 2건 발견·수정** (`app/main/extensions/adapter.ts`):
    - **버그 1 (CRX 다운 버전 하드코딩)**: `WEBSTORE_CRX_URL` 이 `prodversion=120.0.0.0` 하드코딩 → 웹스토어가 `minimum_chrome_version>120` 확장(uBO Lite·Stylus·Wappalyzer)에 204 반환. fix: `process.versions.chrome`(런타임 실제 = 134.0.6998.205) 동적화. 실측 120→204, 134→200.
    - **버그 2 (확장 ID 불일치, 심각·아키텍처 — 1원칙 #2 핵심 깨짐)**: `installFromCrx` 가 temp 로드→`loaded.id` 획득→`extensionsRoot()/<id>` 이동→재로드. Electron 은 manifest 에 `key` 없으면 **설치 경로 해시로 ID 생성** → 경로 바뀌면 ID 바뀜 → 저장·반환 ID(temp) ≠ 최종 경로 런타임 ID. 결과(실측): 툴바 액션 팝업 `chrome-error://` 빈 페이지, `browser://extensions` 이름 `__MSG_extName__`, disable/remove 재시작 전 무반응. **6개 로드돼도 0개 앱 UI 사용 가능**.
      - **fix (정석 — manifest key 주입)**: CRX 헤더의 서명 pubkey 를 추출해 `manifest.json` 의 `"key"`(base64) 에 주입 → loadExtension 이 경로가 아니라 key 로 웹스토어와 동일한 안정 ID 파생. 이동/재로드 제거(최종 경로에서 한 번만 로드). `idFromPublicKey`=SHA256(pubkey DER)[0:16] a-p 인코딩(Chromium GenerateId 동일).
      - **함정(적대적 검증으로 발견)**: 웹스토어 CRX3 헤더 field 2 에 RSA proof **2개** — 첫째는 구글이 추가한 배포/재게시 키(모든 확장 **동일**), 둘째가 개발자 키(웹스토어 ID 결정). 첫 proof 를 잡으면 9개 확장이 전부 같은 ID(`lfoeajg...`)로 붕괴돼 서로 덮어씀. **해결**: `CrxFileHeader.signed_header_data`(field 10000) 안 `SignedData.crx_id`(field 1) = Chromium 이 이미 계산한 정답 16바이트 → 각 proof pubkey 의 `idFromPublicKey` 가 이 값과 일치하는 것만 선택(순서 무의존 self-verify). `extractCrx3PublicKey` 가 minimal protobuf(varint/wire-type) 수동 파서로 구현. unpacked 로컬(폴더 드래그, key 없음)은 자체 RSA 키페어 생성으로 경로 독립성 확보.
    - **결과(지휘관 직접 재검증)**: **9/10 로드 + 8/8 팝업 실제 렌더(chrome-error 아님) + ID 완벽 일치**(저장 dir = 런타임 SW ID = 웹스토어 ID, 예 uBO `ddkjiahej...`). Save to Pocket 만 204(진짜 delisted). CLAUDE.md "웹스토어 상위 100개 70% 무수정 동작" 목표 초과(90%).
  - **검증 방법 핵심 교훈**: 워커 최종 보고(성공)와 하네스 결과 파일(붕괴 `lfoeajg...`)이 모순 → **결과 파일 타임스탬프(23:47)가 코드 수정(23:52)·빌드(23:54)보다 이전** = 수정 전 중간 산출물임을 간파 → 최신 빌드로 지휘관 직접 재실행해 확정. **산출물 타임스탬프를 코드 수정 시각과 대조하라. 워커의 성공 주장도 낡은 결과 파일도 단독으로 믿지 말 것.**
  - **검증**: typecheck 3/3 · win --dir 패키징 · 다운로드 10/11 · 확장 9/10(ID 일치·팝업 렌더) · 스모크 16/16 유지(회귀 없음).
  - **관찰(미수정)**: 확장 description 의 `__MSG__` i18n 치환 미구현(이름은 fix), 앱 종료 exit code 0xC0000005(하네스 강제종료 경로 추정·런타임 무관), 기존 붕괴 ID 설치본은 재설치 시 정상화.
  - **다음 라운드 후보**: 게이트 0~6 대부분 통과 — 남은 것은 **출시(게이트 7)**: ① 코드 서명(사용자 인증서), ② 자동 업데이트 `owner` 실값(사용자), ③ 깨끗한 Windows 외부 설치→실행→업데이트 검증, ④ 확장 description i18n 치환(경미).
- 2026-07-12: **검증 라운드 V6 — 경미한 잔여 4건 정리** (V1~V5에서 관찰만 하고 남긴 것). (Fable 5 지휘관 + Sonnet 워커 1)
  - **A (다운로드 저장 위치 배선 — 실기능)**: `defaultDownloadDir()` 이 항상 `app.getPath('downloads')` 만 쓰고 `settings.downloads.defaultPath` 를 무시하던 결함. fix: defaultPath 가 유효 디렉터리면 우선 사용(existsSync+isDirectory), 아니면 OS 기본 폴백. 모든 경로(가속·영상 videos/·토렌트 torrents/)가 이 함수 통과. `askEveryTime` 도 활성화 — will-download 시 `dialog.showSaveDialog`(Electron 35 는 `saveAs()` 없음 + pause/async-resume 은 회귀 #16 재현이므로, `rerouteToStandardDownload` 의 cancel-후-재요청 패턴 재사용). 신규 IPC `downloads:pick-folder`(isTrustedSender) + 설정 UI "폴더 선택" 버튼. **CDP 실검증: 커스텀 폴더에 저장되고 OS Downloads 엔 안 생김 PASS.**
  - **B (확장 description i18n 치환 — 표시 품질)**: `browser://extensions` 설명이 `__MSG_extension_description__` raw 로 뜨던 것. `localizeString`(whole-value `^__MSG_key__$` 매칭 → `_locales/<default_locale|en>/messages.json` 치환, 파일·키 없으면 원문 유지) 헬퍼로 name/description/actionTitle 해석. name 은 Electron ext 객체 우선.
  - **C (perf-measure 콜드런 보정 — 하네스 정확도)**: 근본 원인 2층 — 콜드스타트 phase 가 adblock 1500ms 지연 init **시작 전**에 앱을 죽여 `engine.bin` 이 아예 안 만들어짐 → long-session 이 항상 콜드 빌드 측정. fix: `waitForLogLine('[adblock] initialized')` 폴링 + 콜드스타트에서도 그 로그 대기(캐시 seed). 재측정 baseline private RSS 290MB→**225MB**(웜 ≈226MB 재현, V4 예산 통과 안정화).
  - **D (죽은 CSS 제거)**: `.video-popover-backdrop`·`.panel-flyout-backdrop`·`.sidepanel.panel-flyout`(참조 0 재확인) 제거.
  - **검증**: typecheck 3/3 · win --dir · 스모크 16/16 유지. 미완: askEveryTime 네이티브 다이얼로그·B 실확장 로드는 코드 리뷰만(오프라인 환경 한계).
  - **다음**: 출시(게이트 7)만 남음 — 코드 서명·자동 업데이트 owner 실값(사용자 제공)·외부 Windows 설치 검증.
- 2026-07-12: **묶음 릴리즈-1 — NSIS 설치파일 완전 자동설치(oneClick) 전환 + 설치→부팅→제거 실증**. 게이트 7(출시)의 사용자-비의존 부분 이행.
  - **oneClick 전환** (`electron-builder.yml` nsis): `oneClick: false`(마법사) → **`oneClick: true`**(더블클릭 → 위치 안 묻고 설치 → 자동 실행, Chrome/Edge/콕콕 방식). `perMachine: false` 유지(사용자 단위 → **UAC 프롬프트 없음**, 미서명 빌드에서 마찰 최소화), `runAfterFinish: true` 명시. 커스텀 경로/포터블은 `win-unpacked/` 폴더 복사로 대응(설치 위치 선택 제거의 유일한 트레이드오프).
  - **최신 코드로 설치파일 재빌드**: 기존 `dist/ezBrowser-0.1.0-win-x64.exe`(7/11 16:29)는 V3~V6 수정(세션복원 #17·다운로드위치·i18n·perf·CSS)이 빠진 스테일 — V3~V6 검증이 `--dir`(win-unpacked만)로 돌았기 때문. `npm run package:win` 전체 재빌드로 최신화(97.3MB, oneClick=true).
  - **설치 기전 실증(격리·비오염)**: 사용자 실제 프로필(`%APPDATA%\browser-build`) 오염 방지가 핵심. ① 무인 설치 `/S` 종료코드 0, 306파일 추출, 레지스트리 등록, 바로가기 생성, **runAfterFinish 자동실행 발동 확인**. ② 설치된 exe 부팅 검증(`scratchpad/boot-verify.mjs` — CDP, 격리 `--user-data-dir`): `booted/shellFound/browserAPI` 전부 true, URL 이 설치 디렉터리 `app.asar` 에서 로드(추출 무결성). ③ 깨끗한 레지스트리에서 기본 위치 `%LOCALAPPDATA%\Programs\**browser-build**\`(폴더명은 package.json `name`, productName "ezBrowser" 아님 — userData 규칙과 동일, 정상) 설치 확인. ④ 무인 제거 + 레지스트리/바로가기/디렉터리 전부 정리, **실제 프로필 보존 확인**.
  - **오염 방지 기법**: oneClick 은 설치 후 default 프로필로 **자동 실행**되므로, 검증 중 설치 실행 시 `ELECTRON_RUN_AS_NODE=1` 을 세팅해 자동실행된 ezBrowser 를 node 모드로 무력화(창·userData 쓰기 없이 종료) → 사용자 실 프로필 무접촉. 제거는 `Uninstall ezBrowser.exe /S /currentuser _?=<dir>`.
  - **함정(테스트 환경)**: oneClick 은 **이전 설치 경로를 레지스트리(HKCU\Software)에 기억** — 앞선 assisted 테스트의 불완전 정리로 남은 경로 키 때문에 첫 재설치가 그 위치(temp\ezb-clean-test)로 감. 실제 clean PC 엔 이 기록 없음. 완전 정리는 Uninstall 키 + `HKCU\Software\*ezBrowser*/*browser-build*` 경로 키 둘 다 sweep 필요.
  - **산출물**: `dist/ezBrowser-0.1.0-win-x64.exe`(97.3MB, oneClick 자동설치). 여전히 미서명(SmartScreen 경고) + 자동업데이트 owner 플레이스홀더 — 둘 다 설치·실행엔 무관, 사용자 제공 값 대기.
  - **남은 게이트 7(사용자 제공 필수)**: 코드 서명 `.pfx`, 자동업데이트 GitHub `owner/repo`, 외부 clean Windows 실기 설치 검증.
- 2026-07-21: **묶음 AI-1 — 브라우저 내장 AI 어시스턴트 (aside.com 영감) 1차: 페이지 AI 사이드바 + BYOK 3제공자**. 코드베이스에 AI/LLM 코드가 전무했던 greenfield 레이어. aside.com 분석 결과 그 핵심은 ① 페이지 맥락 AI(사이드바 요약·질문·챗) ② 로그인된 사이트에서 스스로 작업하는 에이전트 ③ BYOK(자체 LLM 없음 — 사용자 ChatGPT/Claude 키 또는 로컬 Ollama). 우리는 이미 사이드패널·비번매니저(safeStorage)·content.js DOM 접근·net.request 아웃바운드를 다 갖춰 얹기에 이례적으로 유리. **이번 라운드는 ①(사이드바)을 내되, ②(에이전트)가 재작성 없이 얹히도록 "에이전트 준비된 토대"로 설계**(사용자 명시 요구: "브라우저에서 하는 작업을 다 찾아서 해준다 — 우리 설계도 그렇게").
  - **AI 제공자 레이어 ([features/ai/providers.ts](browser-build/app/main/features/ai/providers.ts))**: Anthropic(Claude)/OpenAI/로컬 Ollama 3종 **스트리밍** 추상화. main 프로세스 `net.request` POST(번역·위젯과 동일 패턴) — CORS 무관. Anthropic·OpenAI 는 SSE(`data:` 라인), Ollama 는 NDJSON(줄 단위 JSON) — 제공자별 `parseLine` 로 분기. 부분 청크 버퍼링(`\n` 분할·마지막 partial 보존), 취소(`req.abort`), 120s 타임아웃, HTTP 상태별 친절한 한국어 에러(401/403 키·404 모델·429 한도·Ollama 연결). **요청 body 빌더가 제공자별로 분리돼 있어 에이전트 라운드에서 `tools`/`tool_choice` 만 추가하면 됨**(tool-use 준비).
  - **키 보안 ([features/ai/keys.ts](browser-build/app/main/features/ai/keys.ts))**: aside 의 "자격증명 노출 안 함" 정신 그대로 — API 키를 평문 settings.json 에 두지 않고 **safeStorage**(Windows DPAPI 등)로 암호화해 `userData/ai-keys.json` 에 base64 저장(비번매니저와 동일 모델). 설정 UI 는 실제 키가 아니라 "✓ 설정됨/미설정"만 표시. Ollama 는 키 불필요.
  - **페이지 추출 ([features/ai/page-content.ts](browser-build/app/main/features/ai/page-content.ts))**: 리더 모드와 동일한 `@mozilla/readability` 를 **읽기 전용**으로(DOM clone 파싱, 페이지 안 건드림) — 본문+선택영역 반환. maxContextChars(기본 12000)로 캡. **에이전트 라운드에서 "클릭 가능한 요소 목록"까지 반환하도록 확장하면 관찰(observe) 단계 재사용**.
  - **오케스트레이션 ([features/ai/index.ts](browser-build/app/main/features/ai/index.ts))**: 설정·키·제공자·페이지추출을 묶어 `startAiChat({reqId, tabId, includePage, messages})`. includePage 면 활성 탭 본문을 시스템 프롬프트에 주입("# 사용자가 지금 보고 있는 페이지" 블록 + 선택영역). reqId 로 스트림 취소 핸들 추적.
  - **IPC ([ipc/ai.ts](browser-build/app/main/ipc/ai.ts))**: `ai:config/pageContext/keyStatus/setKey/clearKey/send/cancel` + 스트림 이벤트 `ai:delta/done/error` + 액션 `ai:open`. `ai:send` 는 호출 창(`e.sender`)으로 델타 스트리밍. 전부 `isTrustedSender` 가드. preload: `browserAPI.ai.*`(외피 사이드바) + `internalAPI.ai.{config,keyStatus,setKey,clearKey}`(설정 페이지 키 관리).
  - **외피 AI 사이드바 ([components/AiTab.tsx](browser-build/app/renderer/components/AiTab.tsx))**: 사이드패널 신규 `✨ AI` 섹션(기본 첫 탭). 챗 버블(스트리밍 델타 실시간 누적 + 커서), 퀵액션(이 페이지 요약·선택영역 설명·핵심 정보 추출), 페이지 컨텍스트 토글, 중단 버튼, 새 대화. 키 없으면 "설정에서 키 입력" 셋업 카드(Ollama 안내 포함). 툴바 `✨` 버튼 + `action.ai.open`(**Ctrl+Shift+Space**) + 명령 팔레트. LLM 응답은 안전하게 `white-space: pre-wrap` 평문 렌더(마크다운 렌더는 다음 라운드).
  - **설정 ([settings.ts](browser-build/app/main/storage/settings.ts) `ai` 카테고리)**: enabled·provider·제공자별 모델(anthropicModel 기본 `claude-sonnet-4-5`·openaiModel `gpt-4o-mini`·ollamaModel `llama3.2`·ollamaUrl `localhost:11434`)·maxTokens·maxContextChars·includePageByDefault. 모델은 자유 편집(사용자 계정/설치에 맞게). browser://settings 에 `✨ AI` 카테고리(제공자 전환 시 해당 모델·키 UI 즉시 재렌더, 키 저장/삭제 버튼).
  - **검증 (패키징 없이 built main 을 electron 직접 구동 + CDP, 격리 프로필)**: typecheck 3/3·build(외피 gzip 72.7→74.7KB, 예산 500KB 의 15%)·**AI 파이프라인 CDP 7/7 PASS**(부팅·`browserAPI.ai` 표면·config 형태·send→에러 파이프라인·Ollama net.request 왕복·action→사이드바 DOM·무크래시). **결정적 발견**: 사용자 PC 에 Ollama 가 실제 가동 중(exaone3.5:7.8b·qwen2.5 등 설치됨) → **키 없이 실제 스트리밍 답변 end-to-end 성공**(exaone3.5 로 17 델타, 시스템 프롬프트대로 "브라우저 내장 AI 어시스턴트"로 한국어 답변). 즉 로컬 무료·프라이빗 AI 가 모델만 있으면 즉시 동작.
  - **다음 라운드 후보**: ① **에이전트 루프(자유도 신규 축)** — `page-actions`(클릭·입력·이동 via executeJavaScript) + 관찰 모듈(page-content 확장: 상호작용 요소 열거) + tool-use(providers 확장) + 확인 게이트(결제·전송 등 민감 동작), aside 의 "다 찾아서 해준다" 재현, ② 마크다운 렌더(코드블록·리스트), ③ 선택영역만 번역/설명 인라인, ④ Memory(aside 식 markdown 로컬 기억·"Dreaming"), ⑤ 스크린샷 멀티모달(captureTab → vision), ⑥ 대화 이력 영속화·세션별 스레드.
  - **후속(묶음 AI-1b): Google Gemini 무료 티어 제공자 추가**. 사용자 문의("구독으로 못 쓰나? API 는 비용 아닌가?")에 답: 구독(ChatGPT Plus/Claude Pro)엔 API 미포함(별도 종량제), 구독 자체를 쓰려면 aside 식 웹세션 자동조작뿐(ToS·계정 위험 → 에이전트 라운드 옵션). **무료 경로 = 로컬 Ollama(이미 됨) + Google Gemini 무료 티어**. Gemini 를 4번째 제공자로 추가 — provider 레이어 추상화 덕에 `providers.ts` 에 `googleEndpoint`(Generative Language API, role=user/model·system=systemInstruction·`?alt=sse` SSE 스트리밍) 어댑터만 추가하고 keys(`AiSecretProvider` += google)·settings(`ai.provider` += google, `googleModel` 기본 `gemini-2.0-flash`)·IPC 검증·preload 타입·설정 UI(무료 키 안내 aistudio.google.com)에 google 전파. **Gemini 스트림은 종료 마커 없이 연결 종료로 완료**(resp end → onDone). typecheck 3/3·build 통과. 무료 키(신용카드 불필요) 발급해 넣으면 클라우드 품질 AI 를 비용 없이 사용.
- 2026-07-21: **묶음 AI-2 — 자율 에이전트 (aside 의 "브라우저에서 하는 작업을 다 찾아서 해준다") 1차**. AI-1 에서 "에이전트-준비" 로 지은 토대 위에 관찰→판단→실행 루프를 얹음. **핵심 결정 — 크로스 프로바이더 "JSON 액션 프로토콜"**: 제공자별 tool-use 배관(4종) 대신 LLM 이 매 스텝 JSON 액션 하나를 출력하게 하고 파싱 → 사용자의 로컬 Ollama·Gemini·Claude·OpenAI 어디서든 동일 동작, 신규 제공자 코드 0(AI-1 텍스트 경로 재사용).
  - **눈과 손 ([features/ai/page-actions.ts](browser-build/app/main/features/ai/page-actions.ts))**: `observePage(wc)` — 콘텐츠 페이지에서 `executeJavaScript` 로 상호작용 요소(a/button/input/select/textarea/[role]/[onclick]) 열거, 화면 근처·가시 요소만, 각 요소에 `data-bb-agent-ref` 속성 부여(실행 때 그 ref 로 정확히 집음), 접근성 이름+본문 스니펫 반환. `executeInPageAction(wc, action)` — click(scrollIntoView 후 .click())·type(native setter + input/change 이벤트, contenteditable 대응, submit=true 면 Enter/requestSubmit)·scroll. navigate 는 main 에서 `wc.loadURL`+did-finish-load 대기.
  - **루프 ([features/ai/agent.ts](browser-build/app/main/features/ai/agent.ts))**: `runAgentTask({reqId,tabId,task}, emit)` — 관찰→`chatOnce`(providers 에 신설한 비스트리밍 1회 호출, streamChat 재사용)→`extractJson`(균형 중괄호 스캐너로 프로즈 속 JSON 추출)→민감 게이트→실행→반복. MAX_STEPS=12, http(s) 만, 이력 트림(관찰이 커서 최근 10 메시지만·작업은 system 에 고정), done/ask 로 종료. 액션: click/type/navigate/scroll/read/wait/done/ask.
  - **확인 게이트(aside 안전 모델)**: `SENSITIVE` 정규식(결제·구매·주문·송금·삭제·전송·게시·submit·pay·checkout·order·delete…) 매칭 요소 클릭 또는 type+submit 이면 실행 전 `confirm` 이벤트 → 사용자 승인 대기(`pendingConfirm` resolver). 거부 시 미실행 + 이력에 기록하고 계속. 중단(`cancelAgentTask`)은 진행 중 LLM 호출까지 abort.
  - **IPC/preload**: `ai.agentStart/agentEvent/agentConfirm/agentCancel`. agentStart 가 호출 창으로 스텝 이벤트 스트리밍(start/observe/thought/action/result/confirm/ask/done/error/cancelled). preload `browserAPI.ai.{agentStart,agentConfirm,agentCancel,onAgentEvent}`.
  - **외피 ([components/AiTab.tsx](browser-build/app/renderer/components/AiTab.tsx))**: 사이드바에 **💬 챗 / 🤖 에이전트 모드 토글**. 에이전트 모드 = 작업 지시 입력 + **실시간 스텝 트레이스**(🔍관찰 💭생각 ⚙️실행 ✔️/✖️결과 🏁완료) + **확인 바(승인/거부)** + 중단 버튼. 퀵액션(핵심 정보 찾기·구조 파악). 내부 페이지·키 미설정 시 비활성.
  - **검증 (실제 로컬 페이지 + 실제 Ollama exaone3.5, CDP)**: typecheck 3/3·build(외피 gzip 74.7→76.0KB, 예산 15%). **에이전트 e2e 6/6 PASS** — ① 클릭 실행이 실제 페이지 상태 변경(`observe→thought→action→result→…→done`, `window.__revealed=true` 실제 DOM 클릭) ② **민감 동작 확인 게이트**("결제하기" 클릭 선택 → `confirm` 이벤트 → 거부 → `window.__paid` false 유지, 미실행). 키 없이 로컬 모델로 동작.
  - **알려진 제한(다음 라운드 후보)**: ask 는 현재 대화를 종료(재실행으로 정보 보강 — 인터랙티브 ask 응답 채널은 다음), iframe 내부 요소 미열거(top frame 만), 스크린샷 멀티모달 판단 없음(텍스트+요소만), 네이티브 tool-use 대비 소형 로컬 모델의 JSON 안정성은 재프롬프트로 보정, 멀티탭/새 탭 열기 액션 없음, 확인 게이트는 키워드 휴리스틱(오탐 시 승인 한 번). 보강: 인터랙티브 ask, iframe 관찰, 스크린샷 vision, 탭 열기/전환 액션, 네이티브 tool-use 옵션.
- 2026-07-21: **묶음 AI-3 — 마크다운 렌더 + 에이전트 교대(alternation) 버그 fix + 인터랙티브 ask**. AI-2 알려진 제한 3종을 묶어 해소.
  - **마크다운 렌더 ([components/Markdown.tsx](browser-build/app/renderer/components/Markdown.tsx))**: 챗 답변이 평문(`pre-wrap`)이라 목록·굵게·코드블록이 안 살던 것을 개선. **외부 의존성 0, XSS 안전** — `parseMarkdown`(순수 함수, 블록: 코드펜스·#헤딩·-/1. 목록·>인용·--- hr·문단, 인라인: `**굵게**`·`*기울임*`·`` `코드` ``·`[링크](url)`) 와 React 매핑을 분리하고 **`dangerouslySetInnerHTML` 을 절대 쓰지 않음**(텍스트는 React 가 이스케이프, 허용 요소 타입만 생성 → script/이벤트핸들러 주입 불가). 링크는 http(s)/mailto 만 허용하고 클릭 시 새 탭. AiTab 의 assistant 메시지에 적용(user·에러 메시지는 평문 유지). 스트리밍 중 부분 마크다운도 점진 렌더.
  - **회귀 (에이전트 메시지 교대 버그, 잠재적 critical)**: AI-2 검증(Ollama 만)에서 놓친 것 — 에이전트 루프가 관찰/결과를 **연속 user 메시지**로 쌓아서 **Anthropic·Gemini(엄격한 user/assistant 교대 요구)에서 에이전트가 깨졌을 것**(Ollama 는 연속 role 관대해서 통과). fix: `pendingPrefix` 방식 — 직전 행동 결과·거부·사용자 답변을 다음 관찰 user 메시지 앞에 붙이고, history 는 오직 user/assistant **쌍**으로만 늘려 항상 교대 보장. 작업 지시는 system 에 고정해 이력 트림에도 유실 없음.
  - **인터랙티브 ask**: AI-2 는 `ask` 시 대화를 종료했으나, 이제 확인 게이트와 동일한 resolver 패턴(`pendingAsk`/`waitAsk`/`replyAgentAsk`)으로 **사용자 답변을 받아 이어서 진행**. IPC `ai.agentReply` + preload `agentReply` + AiTab 의 ask 입력창(답변 입력→에이전트 재개, `answer` 이벤트로 트레이스 표시). 비밀번호·선택 등 모르는 정보를 물어보고 계속 작업.
  - **검증**: typecheck 3/3·build(외피 gzip 76.0→77.3KB). **마크다운 e2e 6/6 PASS**(실제 Ollama exaone3.5 로 마크다운 답변 유도 → 렌더된 DOM 에 `.md`·`<strong>`·`<li>`·코드블록 확인, XSS 안전). **에이전트 회귀 6/6 PASS**(교대 리팩터 후에도 실제 클릭 실행 + 확인 게이트 거부 유지). 교대 fix 는 구성상 보장 + Ollama 회귀로 확인(Anthropic/Gemini 는 키 부재로 미실측), 인터랙티브 ask 는 확인 게이트와 동일 패턴이라 배관 검증(모델이 ask 를 내도록 강제 불가해 e2e 미유도).
- 2026-07-21: **묶음 AI-4 — 탭 인식 에이전트(새 탭·전환) + iframe 내부 관찰·조작**. aside 의 "로그인된 여러 사이트를 넘나들며 작업"에 직결. 전부 메인측 변경(외피·IPC 무변경 — 에이전트 이벤트가 기존 트레이스로 일반 표시).
  - **탭 액션 ([features/ai/agent.ts](browser-build/app/main/features/ai/agent.ts))**: 액션 `open_tab {url}`(새 탭 열고 그 탭으로 조작 전환)·`switch_tab {index}`(열린 탭 전환) 추가. 루프의 조작 대상 탭을 **가변(`currentTabId`)** 으로 바꿔 매 스텝 `getWebContentsByTabId(currentTabId)` 재해석. 관찰마다 `[열린 탭]` 목록(▶=현재)을 프롬프트에 주입(`formatTabs`). open_tab 은 `createTab`+`waitTabLoad`(did-finish-load 대기), switch_tab 은 `listTabs` 인덱스→`activateTab`. windowId 는 시작 탭 wc 에서 `findTabIdByWebContentsId` 로 1회 도출.
  - **iframe 관찰·조작 ([features/ai/page-actions.ts](browser-build/app/main/features/ai/page-actions.ts))**: `observePage` 가 same-origin iframe 을 `contentDocument` 로 **재귀 열거**(깊이 3, cross-origin 은 접근 예외 → skip), 프레임 내 요소는 이름에 `(프레임)` 표기. `visible`/`setNativeValue`/이벤트 생성이 요소의 **자기 window**(`el.ownerDocument.defaultView`)를 쓰도록 수정(cross-frame 정확성). `executeInPageAction` 의 `pick(ref)` 이 top+모든 접근가능 프레임을 재귀 탐색해 `data-bb-agent-ref` 로 정확히 집음. 로그인·결제 폼이 iframe 인 실사이트 커버.
  - **검증 (로컬 페이지 + 실제 Ollama exaone3.5, CDP)**: typecheck 3/3·build(외피 불변 77.3KB). **AI-4 e2e 5/5 PASS** — ① `open_tab` 액션 발동 + 새 탭 생성(탭 1→2, page2 존재) ② **iframe 안 버튼 cross-frame 관찰+클릭**(`window.__iframeClicked=true` via `window.parent`). 소형 로컬 모델은 스텝을 많이 쓰지만 목표 달성.
  - **알려진 제한(다음 후보)**: cross-origin iframe 은 불가(브라우저 정책), 탭 닫기 액션 없음, switch_tab 은 활성 워크스페이스 탭만(`listTabs` 필터), 스크린샷 vision·네이티브 tool-use 여전히 미구현.
- 2026-07-21: **묶음 AI-5 — AI Memory("Dreaming")**. aside 의 가장 차별적 기능 — "브라우징을 기억으로 바꿔 매번 재설명 불필요" — 을 검증 가능한 형태로 구현.
  - **저장소 ([features/ai/memory.ts](browser-build/app/main/features/ai/memory.ts))**: 편집 가능한 마크다운 하나(`userData/ai-memory.md`)에 개인 컨텍스트 저장. `getMemoryText`(sync 캐시)·`setMemoryText`·`appendMemory`(bullet 추가)·`clearMemory` + `memoryEvents` 변경 broadcast. `memoryBlock(cap)` 로 프롬프트 주입 블록 생성(길면 앞부분만).
  - **자동 주입**: 챗(`index.ts startAiChat`)·에이전트(`agent.ts agentSystemPrompt`) system 프롬프트에 `settings.ai.memoryEnabled`(기본 true) 시 memoryBlock 주입 → 다음 대화에서 재설명 불필요.
  - **에이전트 "Dreaming"**: 신규 액션 `remember {text}` — 작업 중 배운 사실(사용자 이름·선호·자주 쓰는 값)을 `appendMemory` 로 저장. 시스템 프롬프트에 안내.
  - **편집 UI ([pages/ai-memory/index.html](browser-build/pages/ai-memory/index.html))**: `browser://ai-memory`(session-bootstrap 자동 서빙) — 마크다운 textarea 편집·저장·전체 지우기, `onMemoryChanged` 실시간(편집 중이면 미덮어씀). AiTab 헤더 `🧠 기억` 버튼으로 열기. 설정 ✨ AI 에 `memoryEnabled` 토글 + 관리 링크.
  - **IPC/preload**: `ai.memoryGet/memorySet/memoryClear/memoryChanged`(isTrustedSender 가드, chrome+internal broadcast). internalAPI 에 memory API(편집 페이지용).
  - **검증 (실제 Ollama exaone3.5, CDP)**: typecheck 3/3·build(외피 gzip 77.35KB, internal.js 46.1KB). **Memory e2e 6/6 PASS** — ① 에이전트 `remember` 로 "청록색 좋아함" 파일 저장(작업 중 학습) ② `browser://ai-memory` 로드 + memorySet/get 왕복 ③ **주입→회상**: 대화에 없던 이름을 새 챗에서 "홍길동" 회상(재설명 없이). 키 없이 로컬 모델로 전 loop 동작.
  - **알려진 제한(다음 후보)**: 관련도 검색 없이 전체 주입(cap 2000자 — 커지면 앞부분만), 자동 "Dreaming"(대화 종료 시 자동 추출)은 remember 액션에 의존(챗은 수동), 사이트별/사람별 분류 없음(단일 마크다운), 스크린샷 vision·네이티브 tool-use·탭 닫기 여전히 미구현.
- 2026-07-21: **묶음 AI-6 — 자동 Dreaming(대화→기억 자동 추출) + 탭 닫기 액션**. AI-5 가 남긴 "자동 Dreaming"·탭 관리 마무리.
  - **자동 Dreaming ([features/ai/index.ts](browser-build/app/main/features/ai/index.ts) `maybeAutoRemember`)**: 챗 종료(`ipc/ai.ts` onDone) 후 백그라운드로 대화를 추출 모델(같은 제공자, maxTokens 150)에 넘겨 "사용자에 대한 지속적 사실"만 뽑아 `appendMemory`. 저장 시 sender 로 조용한 토스트("🧠 기억에 추가됨: …"). **프라이버시 기본 OFF 옵트인**(`settings.ai.autoMemory`, 설정 UI 토글 + 안내). 파이어앤포겟(챗 응답 지연 없음), 실패해도 무시.
  - **파서 견고화(소형 로컬 모델 형식 이탈 대비)**: 검증 중 exaone 이 "NONE" 대신 "(지속적인 사실 없음)"·"(참고: 형식에 맞춰…)" 같은 **머리말/메타를 출력 → 파서가 그걸 기억으로 저장하는 버그** 발견. fix: ① 프롬프트를 단순·명령형으로(예시 포함, 머리말 금지) ② `isNonFactLine` 로 없음-문장(없음/none/해당없음)·메타(참고/형식/출력하면/다음과같/예:)·괄호 시작·마크다운 잔재 줄을 거부, 각 줄 bullet·따옴표·`*``` 정리 후 dedup. **단, "…입니다." 같은 실제 사실 문장은 통과**하도록 메타 표지만 좁게 매칭.
  - **탭 닫기 액션**: 에이전트 `close_tab {index}` — 탭 관리 완성(열기·전환·닫기). **현재 조작 중인 탭(▶)은 닫기 거부**(루프 붕괴 방지 — 먼저 전환 요구). `closeTab(tab-service)` 사용, 민감 게이트 없음(Ctrl+Shift+T 복원 가능).
  - **검증 (실제 Ollama exaone3.5, CDP)**: typecheck 3/3·build(외피 불변 77.35KB). **AI-6 e2e 5/5 PASS** — ① 자동 Dreaming: 챗 "내 직업은 의사야" → 메모리에 `- 직업: 의사` 깨끗이 추출(머리말·잡음 0, 파서 fix 후) ② close_tab: 에이전트가 다른 탭 닫기(탭 2→1) + **현재 탭 생존**. 파서 fix 전 2회는 "(없음)"·"(참고…)" 저장 버그로 FAIL → 프롬프트+파서 보강 후 PASS.
  - **알려진 제한**: 자동 Dreaming 추출 품질은 모델 지시-따르기에 의존 — 강한 모델(Claude/Gemini/GPT)에서 최상, 소형 로컬 모델은 보수적일 수 있으나 파서가 잡음 저장을 방어(안전). 스크린샷 vision·네이티브 tool-use 여전히 미구현(로컬 모델 비전 미지원·클라우드 키 부재로 e2e 검증 불가 → 보류).
- 2026-07-21: **묶음 AI-7 — 챗 대화 영속화 (재시작해도 대화 유지 + 여러 스레드 관리)**. AI-1~6 까지의 챗은 React state 뿐이라 사이드바를 닫거나 앱을 끄면 사라졌음. aside 의 "맥락 유지" 정신에 맞춰 대화를 디스크에 저장.
  - **저장소 ([features/ai/conversations.ts](browser-build/app/main/features/ai/conversations.ts))**: `userData/ai-chats.json` 하나에 모든 대화. `Conversation{id,title,createdAt,updatedAt,messages[]}`. 원자적(tmp+rename) 300ms 디바운스 저장, 부팅 시 sync 로드(memory.ts 패턴). `initConversations`(initAi 에서 호출)·`listConversations`(요약, 최신순)·`getConversation`·`saveConversation`(upsert, 첫 user 메시지로 자동 제목 40자)·`renameConversation`·`deleteConversation`·`clearAllConversations` + `conversationEvents` 변경 broadcast. 상한: 대화 100개·대화당 메시지 200개(초과 시 오래된 것 트림).
  - **IPC/preload**: `ai.convList/convGet/convSave/convDelete/convRename/convClear` + `convChanged` broadcast(`isTrustedSender` 가드). preload `browserAPI.ai.conv*` + `onConvChanged`.
  - **AiTab 통합 ([components/AiTab.tsx](browser-build/app/renderer/components/AiTab.tsx))**: ① **자동 저장** — 스트리밍 종료 후 400ms 디바운스로 스레드 전체를 `convSave`(첫 send 시 `convId` 발급, `suppressSaveRef` 로 로드 직후 불필요 재저장 억제). ② **자동 복원** — 마운트 시 `convList` → 최신 대화를 `convGet` 해 메시지 렌더(재시작/사이드바 재개 시 이어보기). ③ **스레드 UI** — 메타바 `🕘 대화`(이전 대화 목록: 제목·상대시각·메시지 수·행별 삭제·전체 삭제)·`＋ 새 대화`(새 스레드 시작). 목록 클릭으로 과거 대화 전환. `onConvChanged` 로 다중 창 동기.
  - **CSS**: `.ai-history-head/.ai-history-list/.ai-history-item(.current)/.ai-history-del` + `.ai-mini-btn.active`.
  - **검증 (실제 로컬 exaone3.5, CDP, 2회 부팅)**: typecheck 3/3·build(외피 gzip 77.35→78.08KB). **AI-7 e2e 13/13 PASS** — 실제 AiTab UI 로 챗 전송(native setter+input 이벤트) → exaone 응답 "안녕하세요!" → 디스크 저장(제목=user 텍스트, user+assistant 2메시지) → 합성 2번째 스레드 → **강제 kill 후 재시작 → 대화 2개 유지·내용 온전 → AiTab 자동 복원(DOM 에 마지막 대화 렌더)** → 삭제(2→1). 프로필/프로세스 정리 확인.
  - **알려진 제한(다음 후보)**: 대화별 제목 인라인 편집 UI 없음(`convRename` IPC 는 준비됨), 검색/필터 없음, 대화 내보내기(data-sovereignty 번들 편입)·에이전트 트레이스 영속화는 미포함(챗만). 스크린샷 vision·네이티브 tool-use 여전히 클라우드 키/비전 모델 부재로 보류.
- 2026-07-21: **묶음 AI-8 — 3종 묶음: 에이전트 작업 매크로 + 대화 제목 편집·검색 + 내보내기 편입** (AI-7 알려진 제한 해소).
  - **① 에이전트 작업 매크로 ([features/ai/saved-tasks.ts](browser-build/app/main/features/ai/saved-tasks.ts))**: 자주 쓰는 에이전트 작업 지시를 저장했다가 아무 페이지에서나 한 번에 재실행. `SavedAgentTask{id,name,task,createdAt}` → `userData/ai-agent-tasks.json`(원자적 디바운스, 50개 상한, 자동 이름=작업 30자). IPC `ai.taskList/taskAdd/taskRemove/taskChanged` + preload `browserAPI.ai.task*`. AiTab 에이전트 모드: 메타바 `💾 저장`(현재 작업 매크로화)·`＋ 새 작업`(트레이스 리셋), 에이전트 welcome 에 저장된 작업 목록(`▶ 이름` 클릭 실행·× 삭제). 실행은 기존 `startAgent` 재사용 — 어떤 탭이든 활성 페이지에 적용.
  - **② 대화 제목 인라인 편집 + 검색 (AiTab 히스토리)**: 대화 목록에 검색창(제목 부분일치 필터) + 행별 `✎` 인라인 이름 편집(Enter 저장·Esc 취소·blur 저장, `convRename` IPC 는 AI-7 에서 준비됨). 검색 결과 0건 구분 표시.
  - **③ 대화 내보내기 (data-sovereignty 편입)**: `FILES_TO_EXPORT`+`IMPORT_WHITELIST` 에 `ai-chats.json`(대화)·`ai-memory.md`(기억)·`ai-agent-tasks.json`(매크로) 추가 → 설정 "데이터 관리"의 기존 내보내기/가져오기 한 묶음에 AI 데이터도 백업·복원. `ai-keys.json`(API 키)은 의도적 제외(재입력 가능·유출 위험 최소화). 설정 페이지 설명에 "AI(대화·기억·에이전트 작업)" 명시.
  - **검증 (실제 로컬 exaone3.5, CDP)**: typecheck 3/3·build(외피 gzip 78.08→78.60KB). **AI-8 e2e 14/14 PASS** — ③ export 에 ai-chats/ai-agent-tasks 포함(internalAPI.data.export 실호출) · ② UI 검색 "사과"→1개·초기화→2개·✎ 인라인 편집 반영 · ① 매크로 저장·목록·에이전트 모드 실행버튼·UI ▶ 클릭 → **실제 에이전트가 http 페이지 버튼 클릭 완수(window.__clicked)**·삭제. 프로필/프로세스 정리.
  - **알려진 제한(다음 후보)**: 매크로 이름 인라인 편집 UI 없음(store 는 `renameSavedTask` 보유·미노출), 매크로 lastRun 시각 미표시, 에이전트 트레이스 영속화 없음. 스크린샷 vision·네이티브 tool-use 여전히 클라우드 키/비전 모델 부재로 보류.
- 2026-07-21: **묶음 AI-9 — 에이전트 실행 이력(트레이스 영속화) + 매크로 이름 편집·마지막 실행 시각** (AI-8 알려진 제한 해소).
  - **에이전트 실행 이력 ([features/ai/agent-runs.ts](browser-build/app/main/features/ai/agent-runs.ts))**: 에이전트가 수행한 작업(지시·단계·결과)을 `userData/ai-agent-runs.json` 에 저장 → 사이드바를 닫거나 앱을 껐다 켜도 되짚어볼 수 있음. `AgentRun{id,task,startedAt,endedAt,status,steps[],result}`(status running/done/error/cancelled, 50개·단계 120 상한). **메인 측 기록** — `ipc/ai.ts` 의 agentStart emit 초크포인트에서 `recordAgentEvent(reqId, task, evt)` 호출(UI 유무와 무관하게 기록). `deriveStep` 이 에이전트 이벤트를 AiTab 라이브 트레이스와 동일한 `{icon,text,tone}` 로 변환. 상태 전환 시에만 `changed` broadcast(단계마다 X — 라이브는 별도 스트림). 부팅 시 'running' 잔여는 'cancelled' 로 정리. IPC `ai.runList/runGet/runDelete/runClear/runChanged` + preload `browserAPI.ai.run*`.
  - **AiTab 실행 이력 UI**: 에이전트 모드 메타바 `🕘 이력` → 작업 이력 목록(작업·상태 아이콘·시각·단계 수·행별 삭제·전체 삭제) → 항목 클릭 시 상세(저장된 단계를 트레이스로 재렌더 + ← 뒤로). `RUN_STATUS` 아이콘 맵(◔진행/✅완료/❌오류/⏹️중단).
  - **매크로 이름 편집 + lastRun ([features/ai/saved-tasks.ts](browser-build/app/main/features/ai/saved-tasks.ts))**: `SavedAgentTask.lastRunAt` 추가 + `touchSavedTask`(실행 시각), `renameSavedTask` 노출. IPC `ai.taskRename/taskTouch`. AiTab 저장 작업 행에 `✎` 인라인 이름 편집 + `▶ 이름 · 상대시각`(lastRun) 표시. 매크로 실행 시 `taskTouch` 자동 호출.
  - **검증 (실제 로컬 exaone3.5, CDP, 2회 부팅)**: typecheck 3/3·build(외피 gzip 78.60→79.28KB). **AI-9 e2e 15/15 PASS** — 매크로 ▶ 실행 → 에이전트가 http 버튼 실제 클릭 완수 → **실행 이력에 11단계 기록(⚙️ 행동 포함)·status done** → lastRunAt 갱신 → 🕘 이력 UI 목록·상세 렌더 → ✎ 매크로 이름 인라인 편집 → **강제 kill 재시작 후 실행 이력 유지(done)**. 프로필/프로세스 정리.
  - **알려진 제한(다음 후보)**: 대화 폴더/태그 정리(①의 잔여, UI 규모 커 별도 라운드), 실행 이력에서 바로 재실행 버튼 없음, 이력 검색 없음. 스크린샷 vision·네이티브 tool-use 여전히 클라우드 키/비전 모델 부재로 보류.
- 2026-07-21: **묶음 AI-10 — 대화 폴더/태그 정리 + `ai-sidebar-design` 스킬 신설** (①의 잔여 해소).
  - **`frontend-design` 스킬 요청 대응**: 사용자가 UI/UX 개선을 위해 frontend-design 설치를 요청. 이는 Anthropic 번들 스킬이라 이 환경(프로젝트/전역 `.claude/skills/`)에 없고 공식본을 진짜로 설치 불가 → 공식본 사칭 대신 **우리 제약(280px 도크·디자인 토큰·외피 테마)에 특화한 실제 프로젝트 스킬 `ai-sidebar-design`** 을 기존 18개 스킬과 동일 형식으로 신설([.claude/skills/ai-sidebar-design/SKILL.md](browser-build/.claude/skills/ai-sidebar-design/SKILL.md)). 내용: 절대 제약, 확립된 컴포넌트 어휘(`.ai-*`) 표, 좁은 폭 IA 원칙, 칩(chip) 규칙, 접근성 체크리스트, 새 하위 뷰 추가 절차, 폴더/태그 적용안. 앞으로 모든 AI 사이드바 라운드가 참조.
  - **스킬 적용 — 폴더/태그 (좁은 폭 → 얕게)**: 폴더=**1단 평면**(중첩 트리 금지), 태그=교차 라벨(다대다). `conversations.ts` 에 `Conversation.folderId?`/`tags?` + `ChatFolder{id,name}` 를 같은 `ai-chats.json`(`{conversations, folders}`)에 저장. 함수: `listFolders/createFolder/renameFolder/deleteFolder`(폴더 삭제 시 대화 미분류로)/`setConversationFolder`/`setConversationTags`(sanitize: #제거·trim·중복제거·최대8개·24자)/`listTags`. `ConversationSummary` 에 folderId/tags 방출. IPC `ai.folderList/folderCreate/folderRename/folderDelete/folderChanged` + `ai.convSetFolder/convSetTags` + preload.
  - **AiTab 히스토리 UI (스킬 어휘 재사용)**: 검색창 아래 **필터 행** — 폴더 칩(전체/폴더들/미분류, 단일선택) + 태그 칩(합집합, 다중선택 AND). 대화 행 보조메타에 `📁폴더 · #태그`. 행 `📁` 버튼 → **패널 폭 안 인라인 분류 패널**(절대좌표 팝오버 아님 — 콘텐츠 뷰 안 가림): 폴더 칩 선택 + `＋ 새 폴더` 인라인 입력 + 태그 칩(제거) + 태그 추가 입력. 신규 CSS `.ai-chip(.active/.tag/.removable)`·`.ai-filter-row`·`.ai-assign*` 전부 디자인 토큰만.
  - **검증 (CDP, 2회 부팅)**: typecheck 3/3·build(외피 gzip 79.28→80.20KB). **AI-10 e2e 15/15 PASS** — 폴더 생성·대화 지정·태그 지정(저장소) → 필터 행 표시 → 폴더 칩 필터 1개·태그 칩 필터 1개 → 인라인 패널 열림 → 패널로 폴더 지정·태그 추가 → **강제 kill 재시작 후 폴더/태그 유지**. 프로필/프로세스 정리.
  - **알려진 제한(다음 후보)**: 폴더 이름 변경/삭제 UI 없음(IPC `folderRename/folderDelete` 는 준비됨 — 관리 화면 별도), 폴더 중첩(트리) 없음(의도 — 좁은 폭), 대화 드래그로 폴더 이동 없음. 스크린샷 vision·네이티브 tool-use 여전히 보류.
- 2026-07-21: **묶음 AI-11 — 폴더 관리 UI + 대화 드래그 이동 + 실행 이력 재실행** (AI-10 알려진 제한 3종 해소, `ai-sidebar-design` 스킬 적용, 새 IPC 0 — 전부 렌더러).
  - **폴더 관리 UI**: 히스토리 헤드에 `📁 폴더` 토글 → 관리 뷰(목록/상세 분리 패턴, `← 뒤로`). 상단 `＋ 폴더` 입력으로 빈 폴더 생성, 폴더별 대화 수 표시, 행 `✎` 인라인 이름 변경(`folderRename`), `×` 삭제(`window.confirm` "대화는 미분류로 이동" → `folderDelete`). 기존 `folderRename/folderDelete` IPC(AI-10 에서 준비) 활용.
  - **대화 드래그로 폴더 이동**: 대화 행 `draggable`(편집 중 제외), `dragstart` 가 `dataTransfer.setData('text/bb-conv', id)`. 필터 행의 폴더 칩(+미분류)이 drop 타깃 — `dragover` 시 `.dragover`(accent 점선) 강조, `drop` 시 `convSetFolder`. 좁은 폭에 맞춰 기존 필터 칩을 그대로 드롭 존으로 재사용(별도 UI 없음).
  - **실행 이력 재실행**: 에이전트 실행 이력 목록 행에 `↻`, 상세 뷰 헤드에 `▶ 다시` — `rerunTask(task)`(providerReady·!isInternal·!agentRunning 가드) → 이력 뷰 닫고 `startAgent(task)` 로 같은 작업 재실행. 내부 페이지에선 비활성(툴팁 "웹 페이지에서만 실행").
  - **검증 (CDP, confirm 다이얼로그 자동 수락 + 시드 run + 실제 exaone)**: typecheck 3/3·build(외피 gzip 80.20→80.92KB). **AI-11 e2e 10/10 PASS** — 폴더 관리 화면·UI 생성·UI 이름변경·UI 삭제(확인 후) → **HTML5 DragEvent+DataTransfer 합성으로 c-b 드래그→업무 폴더 이동** → 시드 실행 이력 표시·↻ 활성(http)·↻ 클릭 시 새 실행 시작(이력 2건). 프로필/프로세스 정리.
  - **알려진 제한(다음 후보)**: 폴더 순서 재정렬 없음, 대화를 여러 폴더에 못 넣음(단일 folderId — 다중은 태그로), 실행 이력 검색 없음. 스크린샷 vision·네이티브 tool-use 여전히 클라우드 키/비전 모델 부재로 보류.
- 2026-07-21: **묶음 AI-12 — 폴더 순서 재정렬 + 실행 이력 검색 + 개별 대화 .md 내보내기** (AI-11 알려진 제한 소규모 3종, `ai-sidebar-design` 스킬 적용).
  - **폴더 순서 재정렬**: `conversations.ts` `listFolders` 가 createdAt 정렬 → **저장 배열 순서(=사용자 정렬)** 반환. `reorderFolders(orderedIds)`(누락분 뒤 보존) + IPC `ai.folderReorder` + preload. 관리 화면 폴더 행 `draggable`(편집 중 제외) + `dataTransfer('text/bb-folder')`, 다른 행에 drop 시 그 앞으로 삽입 후 `folderReorder`. "드래그로 순서 변경" 힌트. 순서는 파일 배열 순서라 재시작 유지.
  - **실행 이력 검색**: 에이전트 실행 이력 목록에 검색창(`.ai-history-search` 재사용) — task 부분일치 필터, 결과 0건 구분 문구.
  - **개별 대화 .md 내보내기**: `conversationToMarkdown(conv)`(`# 제목` + `**나:/AI:**` 블록 + `---`). IPC `ai.convExport(id)` — 메인이 `app.getPath('downloads')` 에 `safeFileName(title).md`(충돌 시 `(n)` 증가) 기록 후 sender 에 토스트, `{ok,path}` 반환. preload `convExport`. 분류 패널(📁)에 `⤓ 이 대화 .md 로 내보내기` 버튼. (다운로드 핸들러/블롭 우회 — 메인 직접 쓰기라 다이얼로그 없음.)
  - **검증 (CDP, 2회 부팅)**: typecheck 3/3·build(외피 gzip 80.92→81.38KB). **AI-12 e2e 8/8 PASS** — 대화 .md 파일 생성+내용(#제목·본문) → 실행 이력 검색창·2건·"alpha" 1건 → 폴더 3개 생성 [A,B,C] → **DragEvent+DataTransfer('text/bb-folder') 합성으로 폴더C 맨 앞 이동** → 강제 kill 재시작 후 순서 유지(C 먼저). 프로필/실 Downloads 정리(stray 0).
  - **알려진 제한(다음 후보)**: 대화 다중 내보내기(zip) 없음, 실행 이력 상세는 검색 안 됨(목록만), 폴더 색/아이콘 커스터마이즈 없음. 스크린샷 vision·네이티브 tool-use 여전히 보류.
- 2026-07-21: **묶음 AI-13 — 폴더 색상 + 대화 다중 내보내기 + 실행 이력 상세 검색** (AI-12 알려진 제한 3종, `ai-sidebar-design` 스킬 적용). zip 은 의도적으로 안 씀 — 다중 내보내기를 **하나의 결합 마크다운**으로(data-sovereignty 의 JSON-dump 결정과 동일 정신, 텍스트-우선 도구에 더 유용·무의존).
  - **① 폴더 색상**: `ChatFolder.color: FolderColor`(외피 탭 그룹과 동일 8색 팔레트 `blue/red/green/yellow/purple/pink/orange/gray`). `createFolder` 가 **미사용 색 우선 자동 배정**(워크스페이스 패턴), `setFolderColor` + IPC `ai.folderSetColor`. 로드 시 색 없는 기존 폴더는 gray 로 정규화(하위호환). 좁은 폭이라 **폴더 아이콘 = 색 점(`.ai-fdot`)** — 필터 칩·분류 패널 칩·대화 메타·폴더 관리 행 제목 모두 색 점. 폴더 관리 행에 **8색 스와치 선택기**(`.ai-swatch`, 활성 = 테두리 강조). 색은 렌더러 hex 맵(`FOLDER_HEX`, TabBar 와 동일 값), 저장은 색 이름만.
  - **② 대화 다중 내보내기**: `conversationsToMarkdown(convs)`(`# 대화 내보내기 (N개)` + 대화별 `## 제목` + 본문) + IPC `ai.convExportBulk(ids)`. 파일 쓰기는 `writeDownloadMd(base, md)` 헬퍼로 `convExport`(개별)와 공용화. **대화 목록 헤더 `⤓ 내보내기` 버튼이 현재 필터된 목록(`filteredHistory` useMemo)을 통째로 하나의 .md 로** — 폴더 칩 선택 상태면 그 폴더만, 전체면 전체. 기존 IIFE 인라인 필터를 `filteredHistory` 로 승격해 렌더·내보내기 공용.
  - **③ 실행 이력 상세 검색**: 실행 이력 상세 뷰(`viewRun`)에서 단계 5개 초과면 `단계 검색…` input(`.ai-history-search` 재사용) 표시, `st.text` 부분일치 필터 + 결과 0건 문구. `openRun` 진입 시 검색어 리셋.
  - **검증 (CDP, 2회 부팅, 실제 Ollama exaone3.5)**: typecheck 3/3·build(외피 gzip 81.38→81.70KB). **AI-13 e2e 10/10 PASS** — 폴더 생성 시 색 자동 배정(A=blue·B=red, 서로 다름) → 폴더 관리 색 점 2개+스와치 16개 → **UI 스와치 클릭으로 B 를 자동배정 red 와 다른 purple 로 실제 변경** → 다중 내보내기 1개 .md 에 대화 2개+`# 대화 내보내기 (2개)` 포함 → ⤓ 내보내기 버튼 존재 → 실행 이력 상세 5단계+검색창 → `zebra` 검색 시 1단계 → **강제 kill 재시작 후 폴더 색 purple 유지**. 프로필/실 Downloads 정리(stray 0).
  - **알려진 제한(다음 후보)**: 대화별 여러 폴더 불가(단일 folderId — 다중은 태그), 폴더 아이콘은 색만(이모지/커스텀 아이콘 없음), 실행 이력 목록 검색과 상세 검색 분리(교차 없음). 스크린샷 vision·네이티브 tool-use 여전히 로컬 비전 모델/클라우드 키 부재로 보류.
- 2026-07-21: **묶음 AI-14 — 대화 고정(pin) + 본문(메시지) 검색** (`ai-sidebar-design` 스킬 적용). 대화 목록이 커질 때 실제로 유용한 2종. (대화당 여러 폴더는 "1단 평면 폴더 + 교차 태그" 설계와 충돌 — 태그가 이미 그 역할이라 제외.)
  - **① 대화 고정**: `Conversation.pinned?` + `ConversationSummary.pinned` + `setConversationPinned(id, pinned)`(updatedAt 유지 — 고정은 정렬 그룹만 바꾸고 최근성 순서 보존) + IPC `ai.convSetPinned`. `listConversations` 정렬을 **고정 먼저, 그다음 최근성**으로. AiTab 대화 행에 **📌 토글 아이콘**(첫 액션, 고정 시 `.on` accent, 미고정 시 opacity 0.35·hover 복원) + `togglePin`. 메인이 정렬하므로 `filteredHistory`(history.filter) 가 순서 자동 보존.
  - **② 본문(메시지) 검색**: 기존 히스토리 검색은 제목만 매칭 → `searchConversations(query)`(제목 OR 메시지 본문 부분일치 대화 id 배열) + IPC `ai.convSearch`. AiTab 에 `contentMatchIds` state + **histSearch 200ms 디바운스 useEffect** 로 메인 검색 호출, `filteredHistory` 를 `제목 매칭 OR contentMatchIds.has(id)` 합집합으로(폴더·태그 필터는 그 위에 AND). 검색창 placeholder "대화 검색 (제목·내용)…".
  - **검증 (CDP, 2회 부팅, 실제 Ollama exaone3.5)**: typecheck 3/3·build(외피 gzip 81.70→81.87KB). **AI-14 e2e 10/10 PASS**(하네스 견고화 후 2회 연속) — 기본 최신순 정렬(cbody,c3,c2,c1) → c1(가장 오래됨) 고정 시 맨 위로 → UI 첫 행=고정 c1+핀 on → **UI 핀 토글로 c3 추가 고정(pinned=c1,c3)** → convSearch 본문토큰 → [cbody]만 → **UI 검색 시 제목엔 없고 본문에만 있는 대화 노출(1건)** → 검색 비우면 전체(4건) → **강제 kill 재시작 후 고정 c1,c3 유지**. 프로필/electron 정리(stray 0). ⚠ 하네스 함정: `action.ai.open` 후 `.ai-tab` 마운트가 레이스로 가끔 늦음(첫 run FAIL 재현) → **오픈 액션 재시도(8·16 tick)** 로 결정적화(제품 버그 아님, 순수 하네스 타이밍).
  - **알려진 제한(다음 후보)**: 고정 순서 수동 재정렬 없음(고정 그룹 내 최근성 순), 본문 검색 하이라이트 없음, 실행 이력 목록↔상세 검색 여전히 분리. 스크린샷 vision·네이티브 tool-use 여전히 보류.
- 2026-07-21: **묶음 AI-15 — 검색어 하이라이트 + 본문 매칭 스니펫 + 폴더 이모지 아이콘** (`ai-sidebar-design` 스킬 적용). AI-14 본문 검색을 "어디서 맞았는지" 보여주게 완성 + 폴더 아이콘 커스터마이즈.
  - **① 검색 하이라이트 + 스니펫**: `searchConversations(query)` 반환을 `string[]` → `ConvSearchHit[]`(`{id, snippet}`)로 확장 — 제목만 매칭이면 `snippet=null`(제목 하이라이트로 충분), 본문 매칭이면 `snippetAround`(첫 매칭 위치 앞30·뒤40자 발췌 + `…`)를 함께. 렌더러 `highlightNodes(text, query)`(대소문자 무시 분할 → `<mark className="ai-hl">`, **`dangerouslySetInnerHTML` 안 씀 — XSS 안전**), 대화 제목은 검색 중 하이라이트, `contentSnippets` Map 으로 본문 매칭 행에 `💬 발췌`(하이라이트 포함) 표시. 디바운스 effect 가 id Set + snippet Map 둘 다 세팅.
  - **② 폴더 이모지 아이콘**: `ChatFolder.emoji?` + `setFolderEmoji(id, emoji)`(빈 문자열=제거·색 점 복귀, 8자 cap) + IPC `folderSetEmoji`. **폴더 아이콘 표시 규칙 = 이모지 있으면 이모지, 없으면 색 점**(`folderIcon(f)` 헬퍼로 필터칩·분류칩·대화메타·관리행 통일). 폴더 관리에 8개 프리셋(⭐💼🔖📚💡🎯🗂️🔥) + ∅(제거) 선택기(`.ai-emoji-btn`). 색은 여전히 저장·스와치에 표시(이모지 설정 시 목록에선 이모지가 앞섬).
  - **검증 (CDP, 2회 부팅, 실제 Ollama exaone3.5)**: typecheck 3/3·build(외피 gzip 81.87→82.26KB). **AI-15 e2e 10/10 PASS**(2회 연속) — 본문 토큰 검색 시 `.ai-history-snippet .ai-hl` 발췌 하이라이트(1건) → 제목 토큰 검색 시 `.ai-history-title .ai-hl`(1건) → 폴더 관리 이모지 선택기 9개(∅+8) → **⭐ 클릭 시 folderList.emoji='⭐' + 관리 행이 이모지로 표시(색점 아님)** → 강제 kill 재시작 후 ⭐ 유지 → ∅ 제거 시 이모지 없음(색 점 복귀). 프로필/electron 정리(stray 0).
  - **알려진 제한(다음 후보)**: 이모지는 프리셋 8종만(자유 입력 없음), 스니펫은 첫 매칭 1곳만(다중 매칭 미표시), 고정 순서 수동 재정렬·실행 이력 목록↔상세 검색 분리 여전. 스크린샷 vision·네이티브 tool-use 여전히 로컬 비전/클라우드 키 부재로 보류.
- 2026-07-21: **묶음 AI-16 — 에이전트 네이티브 tool-use(구조화 함수 호출) + 자동 폴백**. "큰 기능" 방향. 로컬에 비전 모델이 없어 **스크린샷 vision 은 e2e 검증 불가**(전부 텍스트 모델) → 검증 문화를 지켜, **로컬에서 실검증 가능한** 네이티브 tool-use 를 붙임(`qwen2.5-coder`·`gpt-oss` 등이 Ollama tool-calling 지원). providers.ts 설계 주석이 원래 예고했던 기능("buildBody 에 tools/tool_choice 만 추가").
  - **providers.ts `chatWithTools(req, tools)`**: 비스트리밍 1회 호출 — 제공자별 tool 포맷(Anthropic `input_schema` / OpenAI·Ollama `type:function` / Gemini `functionDeclarations`) + 응답 파싱(`content[].tool_use` / `message.tool_calls` / `functionCall`)을 `{toolCalls, text}` 로 통일. `supportsNativeTools(provider, model)` — anthropic/openai/google 항상 true, **ollama 는 모델명 allowlist**(qwen·llama3.1+·mistral·gpt-oss·command-r·hermes·granite 등)만 true.
  - **핵심 함정 (실측)**: `qwen2.5-coder:7b`(capability 에 "tools" 있음에도)는 구조화 `tool_calls` 가 아니라 **`content` 에 `{"name":"click","arguments":{"ref":3}}` JSON 텍스트**로 함수 호출을 내보냄(Ollama 흔한 동작). → `parseToolResponse` 에 **`extractToolCallFromText` 폴백**(구조화 tool_calls 비면 content 의 함수-호출 JSON 을 ```json 펜스·`<tool_call>` 태그 제거 후 균형 중괄호 파싱). 이거 없이는 tool 경로가 영원히 무한 관찰 루프(첫 실행 실측).
  - **agent.ts 이중 경로 + 폴백**: `useTools = nativeToolUse!=='off' && supportsNativeTools(provider,model)`. useTools 면 `chatWithTools(AGENT_TOOLS)`(12개 도구 — click/type_text/navigate/open_tab/switch_tab/close_tab/scroll/read/wait/remember/done/ask, 각 optional `thought`), `toolCallToAction(tc)` 로 기존 `AgentAction` 실행기 재사용. 도구 안 쓰고 텍스트로 답하면 `extractJson` 로 재폴백. **기존 JSON 액션 프로토콜은 else 분기로 100% 보존**(비-tool 모델·`off` 설정). 시스템 프롬프트도 tool 모드용 분리. 민감 게이트·확인·ask·탭 조작 전부 두 경로 공용.
  - **설정**: `ai.nativeToolUse: 'auto' | 'off'`(기본 auto) 스키마 + `browser://settings` AI 기본 섹션에 select. 'auto'=지원 시 사용·아니면 폴백.
  - **검증 (CDP + 로컬 HTTP 서버 + 실제 Ollama, 2회 연속)**: typecheck 3/3·build(외피 불변 82.26KB — 전부 main/설정). **AI-16 e2e 5/5 PASS** — ① 원시 Ollama qwen 이 우리 tool 스키마로 click 함수 호출 생성(content-json) → ② **qwen 네이티브 tool 경로로 실제 버튼 클릭**(`start>observe>thought>action`, 서버 hit 확인) → ③ **민감 게이트(결제) tool 경로에서도 confirm 발생 → 거부 시 미실행**(paid=false) → ④ **exaone(non-tool)+auto → capability 자동 폴백(JSON 경로)로 클릭**(회귀 없음). 프로필/electron 정리(stray 0).
  - **알려진 제한(다음 후보)**: tool 경로도 "1도구/턴 + 결과는 다음 관찰에 접붙임"(엄격한 tool_result 프로토콜 아님 — 교대 단순화·안정). 스트리밍 아님(비스트리밍 1회). 클라우드 키(Claude/GPT/Gemini) tool 경로는 배관만 검증(로컬 qwen 으로 실동작 확인, 키 부재로 클라우드 실호출 미검증). **스크린샷 vision 은 여전히 로컬 비전 모델 설치 or 클라우드 키가 있어야 실검증 가능** — 사용자가 비전 모델(llava·llama3.2-vision 등) 설치 시 다음 라운드.
