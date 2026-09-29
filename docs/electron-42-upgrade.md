# Electron 판올림 보고서 — 35.7.5 → 42.11.3

작성 2026-09-15 · 사유: 확장 `chrome.scripting` 의 **교차 워크스페이스(세션) 누출**(검사 X15)을
우리 코드로는 막을 수 없어 엔진 판올림이 유일한 해결책이었다. 사용자 명시 승인 후 진행.

---

## 1. 무엇이 문제였나

확장 서비스워커가 **다른 워크스페이스 파티션의 탭 id** 를 넘겨 `chrome.scripting.executeScript` 를
부르면 그 탭에 실제로 코드가 주입됐다. 워크스페이스별로 갈라 둔 확장 인스턴스의 경계가 깨진다
(B 인스턴스가 A 의 페이지 내용을 읽어 갈 수 있다).

원인은 우리 코드도 `electron-chrome-extensions` 도 아니다(라이브러리 전체에 `executeScript` 0건).
Electron v35.7.5 `shell/browser/extensions/api/scripting/scripting_api.cc` 의 `CanAccessTarget` 이
대상 탭을 **프로세스 전역** `electron::api::WebContents::FromID(target.tab_id)` 로 풀고,
넘겨받은 `browser_context` · `include_incognito_information` 인자를 **한 번도 쓰지 않았다**
(원본 Chromium 은 같은 자리에서 `ExtensionTabUtil::GetTabById(..., browser_context, ...)` 로
프로필 범위를 건다). 남는 관문은 대상 URL 에 대한 host 권한뿐이라 **세션으로는 막을 수 없었다.**

호출 경로가 SW(렌더러) → Mojo → 브라우저 프로세스 C++ → 대상 렌더러 라서 우리 JS 가 한 번도
지나지 않는다 — 그래서 앱 코드에 끼워 넣을 방어 지점이 없었다.

## 2. 어느 버전이 이것을 고쳤나 (공식 근거)

| 항목 | 값 |
|------|-----|
| 상류 수정 | [electron/electron#50906](https://github.com/electron/electron/pull/50906) `fix: scope extension tab-ID resolution to the calling BrowserContext` |
| 머지 | 2026-04-11T02:16:21Z → `main` (merge `f36def66`) |
| 신설 파일 | `shell/browser/extensions/electron_extension_tab_util.{h,cc}` (`GetElectronTabById` 헬퍼) |
| 고친 호출부 | `.../api/scripting/scripting_api.cc`, `.../api/tabs/tabs_api.cc`, `electron_messaging_delegate.cc` |
| 백포트 | #50925 → `39-x-y` · #50924 → `40-x-y` · #50926 → `41-x-y` · #50923 → `42-x-y` (모두 2026-04-11 머지) |
| 백포트 **없는** 계열 | **38 이하** — 35·36·37·38 에는 들어가지 않는다 |

**"39 이상이면 다 고쳐졌다" 는 틀리다.** 백포트는 2026-04-11 에 머지됐고 `v39.0.0` 은 그 전에
잘렸다 — 실제로 태그 `v39.0.0` 에는 신설 파일이 **없다**(GitHub contents API 404 로 확인).
따라서 "메이저 번호" 가 아니라 **그 태그에 파일이 있는지** 로 판정해야 한다.

태그별 실측(`repos/electron/electron/contents/shell/browser/extensions/electron_extension_tab_util.cc?ref=<tag>`):

```
v38.6.0  → 404 (없음)
v39.0.0  → 404 (없음)   ← 메이저만 보고 고르면 틀리는 지점
v42.11.3 → 717 bytes (있음)
v43.7.0  → 717 bytes (있음)
v44.3.0  → 717 bytes (있음)
```

## 3. 왜 42.11.3 인가 (지원 상태 + 호환성 영향)

선택 기준 세 가지를 동시에 만족하는 가장 **작은 도약**:

1. **수정 포함** — 위 실측대로 `v42.11.3` 에 신설 파일이 있다.
2. **보안 지원 중** — 공식 문서 `docs/tutorial/electron-timelines.md` 가 못박아 둔 정책:
   *"Electron's official support policy is the latest 3 stable releases."* 그리고 같은 문서의
   타임라인이 **v42 는 "Supported until v45 release"** 라고 명시한다. 44 가 최신 stable 이므로
   지원선은 **42·43·44**. 실제로 2026-09-08 에 `v42.11.3` 이 받은 수정들이 릴리스 노트에서
   "Also in 43/44/45" 로 상호 참조돼, 42 가 지금도 같이 유지보수되는 것이 확인된다.
   42.11.3 은 42 계열의 최신 패치다.
3. **호환성 영향 최소** — 35 → 44 보다 35 → 42 가 깨질 표면이 작다. 특히 44 는
   **렌더러에서 `clipboard` 모듈 제거**, `net.request` 의 frame destination 제한,
   Windows 32-bit 제거 같은 추가 파괴를 포함한다. 우리가 지금 필요한 것은 X15 하나이므로
   불필요한 파괴를 사지 않았다.

> 트레이드오프(기록): 42 는 45 가 stable 이 되는 시점에 지원선에서 빠진다.
> 그때 43/44/45 중 하나로 다시 올려야 한다. 오늘의 선택은 "지원 중 + 최소 도약" 이다.

## 4. 실제로 바뀐 것

| | 이전 | 이후 |
|---|---|---|
| Electron | 35.7.5 (2025-08-19) | **42.11.3** (2026-09-08) |
| Chromium | 134.0.6998.205 | **148.0.7778.280** |
| Node | 22.16.0 | **24.19.0** |
| V8 | 13.4.114.21 | **14.8.178.38-electron.0** |

**패키지 실측**(`dist/win-unpacked/ezBrowser.exe`, `ELECTRON_RUN_AS_NODE=1 … -e process.versions`):

```json
{"electron":"42.11.3","chrome":"148.0.7778.280","node":"24.19.0","v8":"14.8.178.38-electron.0"}
```

### 코드 변경

- `package.json` `devDependencies.electron`: `^35.7.5` → **`42.11.3`**(정확 고정 — 엔진은
  조용히 미끄러지면 안 된다. 다음 판올림은 명시 결정으로 한다).
- `package-lock.json`: `@electron/get` 이 undici 기반으로 바뀌며 전이 의존성 정리
  (`global-agent`·`roarr`·`fs-extra` 등 제거, `undici`·`@electron-internal/extract-zip` 추가).
  **무관한 의존성 교체는 하지 않았다.**
- **앱 소스 수정 0건.** typecheck 3/3 무경고, 빌드·패키징 무수정 통과.

### 손대지 않은 것(의도)

- `loadExtension(allowFileAccess: false)` — 직전 라운드에서 넣은 보안 조치.
  스킬 예제의 `allowFileAccess: true` 로 되돌리지 **않았다**(외피 `file://` 주입 차단 근거: X26).
- `session.loadExtension` 계열 — 39 부터 `session.extensions.*` 로 이동하며 **deprecated** 지만
  42·44 문서 모두에 **남아 있다**. 강제 이전이 아니므로 이번 범위에서 건드리지 않았다.
  (이전이 필요해지면 그때 별도 라운드.)
- 프리로드 esbuild 타깃 `chrome134` — 더 낮은 타깃은 상위 Chromium 에서 안전하다.

## 5. 검증

### X15 — GAP → **정식 검사 승격**

판정식 `judgeX15Scripting` 은 **한 글자도 약화하지 않았다**. `gap()` 호출만 `check()` 로 바꿨다.

```
[X15] PASS — 대조 전 표식=(없음) · 교차 세션 시도 결과=오류: No tab with id: 4
           · 교차 시도 후 표식=(없음) · 제 세션 호출=ok · 제 세션 호출 후 표식=yes(양성 대조)
```

- **차단**: 다른 세션의 SW 가 A 의 탭 id 를 넘기면 이제 `No tab with id` — 애초에 풀리지 않는다.
- **양성 대조**: 같은 세션의 정상 `executeScript` 는 여전히 성공해 표식이 `yes` 가 된다.
  (이게 없으면 "안 뚫렸다" 와 "기능이 죽었다" 를 구분할 수 없다.)
- 검출력: `SELFCHECK` 가 같은 판정식에 결함 데이터를 먹여
  `교차 세션이 주입시킴=결함 → false`, `양성대조 실패 → false` 를 매 실행 확인한다.

### 판올림이 **검사 하나를 무효로 만든 것**(고침)

X25(시크릿 탭 변조)·X26(외피 주입)은 "대조 탭을 **못 보는 다른 세션**" 하나를 골라 id 를 훑는
설계였다. 그 설계는 교차 세션 해석이 새던 시절에만 성립한다 — 구멍이 막히자 **양성 대조가
영영 서지 않아** 두 검사가 통째로 빈 검사가 됐다(판올림 직후 실측 FAIL 2건).

고친 방향은 **공격자 모델을 넓히는 쪽**이다(약화 아님): 이제 **열려 있는 모든 확장 세션**에서
각자 id 를 훑는다. 시크릿·외피에 닿을 수 있는 세션이 하나라도 있으면 그 세션이 잡아낸다.

```
[X25] PASS — 훑은 확장 세션 4개 · 주입 성공 4개 · "No tab with id" 132개
           · [양성 대조] 다른 워크스페이스 새 탭 (없음)→yes · [본 검사] 시크릿 탭 (없음)→(없음)
           · 시크릿 탭에서 코드가 실행됨=false
[X26] PASS — 외피를 실제로 시도했는가=true · [대조] 일반 탭에서는 여전히 실행됨=true
           · [본 검사] 외피에서 코드가 실행됨=false · 시크릿 주소 유출 0건
```

외피 시도의 실제 거부 문구(기타 오류로 수집됨):
`Cannot access contents of url "file:///C:/Users/molma/…"` — `allowFileAccess:false` 가 살아 있다.

### 회귀

`npm run verify`(게이트 0 + 스모크 16종)와 영향 하네스를 최종 빌드에서 실행. 결과는
[.auto-dev/verification.md](../.auto-dev/verification.md) 에 기록한다.

## 6. 한계 · 남은 일

- **웹 호환성 자체(Chromium 134→148)** 는 자동 하네스가 재지 않는다. 우리 하네스는 로컬 고정
  픽스처만 쓴다(외부 사이트·실계정 금지). 실사이트 렌더링 회귀는 실사용 관찰로만 드러난다.
- macOS·Linux 빌드는 이번에 만들지 않았다(Windows x64 만 패키징·실행 검증).
- 42 는 45 stable 시점에 지원 종료 — 그때 재판올림이 필요하다.
- `session.extensions.*` 이전은 미착수(현재 API 가 살아 있어 급하지 않다).
