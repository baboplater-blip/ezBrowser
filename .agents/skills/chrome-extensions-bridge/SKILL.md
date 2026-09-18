---
name: chrome-extensions-bridge
description: electron-chrome-extensions 통합 + 자체 보강. MV3 service_worker, declarativeNetRequest, storage 폴백, 웹스토어 .crx 다운로드 프록시.
---

# Chrome Extensions Bridge

## 채택 라이브러리

[`electron-chrome-extensions`](https://github.com/samuelmaddock/electron-chrome-extensions) — 가장 완성도 높은 Electron 어댑터. samuelmaddock 의 Electron Browser Demo 와 같은 계열.

```bash
npm i electron-chrome-extensions
```

라이선스: GPL-3.0. 자체 앱 라이선스 영향 검토 (브라우저 = OSS 가능).

## 부트

```ts
import { ElectronChromeExtensions } from 'electron-chrome-extensions'

app.whenReady().then(async () => {
  const extensions = new ElectronChromeExtensions({
    session: session.defaultSession,
    createTab: async ({ url, windowId }) => {
      const tab = await tabService.create({ url, windowId })
      return [tab.webContents, getWindow(windowId)]
    },
    selectTab: (wc, win) => tabService.activate(tabIdOf(wc)),
    removeTab: (wc) => tabService.close(tabIdOf(wc)),
    createWindow: async (details) => {
      const win = await windowService.create(details)
      return win
    },
  })

  // 설치된 확장 로드
  // ⚠ allowFileAccess 는 **켜지 말 것**(Electron·크롬 기본값 false). 우리 외피(탭바·주소창·
  //   사이드패널)는 `file://` 로 로드되는 또 하나의 webContents 라, 켜면 확장이 외피 DOM 을 읽어
  //   **시크릿 창이 무엇을 보고 있는지까지 가져간다**(2026-09-15 실측·수정, 회귀 검사 X26).
  for (const ext of installedExtensions()) {
    await session.defaultSession.loadExtension(ext.path, { allowFileAccess: false })
  }

  // 새 탭 생성 시 확장의 콘텐츠 스크립트 자동 주입은 Electron 이 처리
})
```

## 탭 등록 — 빠뜨리면 `chrome.tabs` 가 통째로 죽는다

생성자에 넘기는 `createTab`/`selectTab`/`removeTab` 은 **확장 → 브라우저** 방향(확장이 시키는 일)이다.
반대 방향, 즉 **브라우저 → 확장**(우리 탭을 확장에게 알려주는 것)은 인스턴스 메서드로 따로 불러야 한다:

```ts
extensions.addTab(webContents, baseWindow)  // 탭 생성 시
extensions.removeTab(webContents)           // 탭 닫을 때
extensions.selectTab(webContents)           // 활성 탭 바뀔 때
```

**안 부르면 `chrome.tabs.query({})` 가 항상 빈 배열이다.** 확장은 정상 로드되고 콘텐츠 스크립트도
돌기 때문에 겉보기엔 멀쩡해서 오래 눈에 띄지 않는다 — 실제로 이 저장소가 2026-09-15 까지 그 상태였다.
탭을 훑는 확장(Vimium·Bitwarden·uBO 팝업)과 `chrome.scripting.executeScript({target:{tabId}})` 처럼
탭 id 가 필요한 경로가 전부 조용히 죽는다.

### ⚠ 어댑터는 **세션마다** 하나여야 한다

`addTab` 은 `this.ctx.session !== wc.session` 이면 **TypeError 를 던진다**(엄격한 동일성 검사).
우리 탭은 전부 워크스페이스 partition(`persist:ws-<id>`)에 있으므로,
`defaultSession` 하나로만 어댑터를 만들면 **어떤 탭도 등록할 수 없다** — 이것이 위 결함의 진짜 원인이었다.
세션마다 인스턴스를 만들어도 안전하다: IPC 라우터(`crx-msg`)는 모듈 전역 싱글턴이 한 번만 등록하고
sender 세션으로 라우팅하며, `ElectronChromeExtensions.fromSession(session)` 의 존재 자체가
세션당 1개가 설계 의도임을 보여준다. (adblock 코스메틱 핸들러처럼 "두 번째 등록이 throw" 하는 계열이 아니다.)

배선: [`adapter.ts`](../../../app/main/extensions/adapter.ts) 의 `ensureAdapterFor(session)` +
`trackExtensionTab`/`untrackExtensionTab`/`selectExtensionTab` ←
[`app/main/index.ts`](../../../app/main/index.ts) 의 `onTabCreated`/`onTabClosed`/`onTabActivated`.
회귀 검사: `verify-extension-behavior-cdp.mjs` 의 **X13**.

## 자체 보강 (라이브러리 미지원 API)

> **라이브러리가 실제로 무엇을 주는지는 직접 재라.** 아래는 `electron-chrome-extensions@4.9.0` +
> Electron 35.7.5 에서 **실측**한 결과다(2026-09-15). 검사 ID 는 `verify-extension-behavior-cdp.mjs`.
>
> | API | 라이브러리 | 우리 상태 |
> |-----|-----------|----------|
> | content_scripts 주입 | Electron 제공 | ✅ 동작 (X2 · 끄면 멈춤 X10) |
> | `chrome.storage` | ✅ | ✅ 동작 (X3) |
> | MV3 service worker | Electron 제공 | ✅ 동작 (X4) |
> | `chrome.tabs` | ✅ — 단 `addTab` 을 **호출해야** 한다 | ✅ 동작 (X13) |
> | `declarativeNetRequest` | ❌ **구현 없음** (모듈 전체 문자열 검색 0건) | ✅ 자체 구현 (X1·X6~X9) |
> | `chrome.scripting` | ❌ 구현 없음 (검색 0건) — 그러나 **Electron 이 제공** | ✅ 동작 (X11) |
>
> `chrome.scripting` 은 한때 "미지원" 으로 보였지만 실제 원인은 위의 **탭 미등록**이었다
> (`target: { tabId }` 에 넣을 id 가 없었을 뿐). 라이브러리에 구현이 없다는 사실만 보고
> "그래서 안 된다" 고 단정하지 말 것 — 불러 보고 나온 문구로 판단한다.

### storage.sync 폴백

Chrome 의 `storage.sync` 는 Google 계정 동기화. 우리는 로컬 저장 + 자체 동기화(`data-sovereignty` WebDAV):

```ts
// 확장의 chrome.storage.sync 호출 → 우리 main 의 storage 어댑터
ipcMain.handle('chrome.storage.sync.get', async (e, keys) => {
  return storage.get(`ext-sync:${extId}`, keys)
})
```

### declarativeNetRequest

⚠ **라이브러리는 이걸 제공하지 않는다.** (모듈 전체에 `declarativeNetRequest` 문자열이 0건 — 2026-09-15 실측.
전에 이 문서가 "기본 지원" 이라고 적어 둔 것은 사실이 아니었고, 그 오해 때문에
uBO Lite 같은 MV3 차단기가 "로드는 되는데 아무것도 막지 못하는" 상태로 오래 남았다.)

지금은 [`app/main/features/extensions/dnr.ts`](../../../app/main/features/extensions/dnr.ts) 에
**자체 구현**한다 — 정적 룰셋 · `modifyHeaders` · 동적 룰(Electron 이 디스크에 써 주는
`DNR Extension Rules/<id>/rules.json` 을 읽어 병합). 세션 룰(`updateSessionRules`)은 디스크에
안 남아 미지원.

세션당 `onBeforeRequest` 리스너는 **하나만 유효**하므로(회귀 #5 계열) DNR 은 리스너를 직접 걸지 않고
순수 판정 함수만 내주고, adblock 의 단일 리스너가 가장 먼저 호출한다. 자체 광고차단과의 관계:
- 광고차단을 꺼도 확장 차단은 살아 있어야 한다 → DNR 전용 리스너로 대체 설치
- 확장의 룰과 우리 엔진이 겹칠 때 사용자가 한쪽 선택

### webRequest (MV2 호환)

Chrome 은 MV3 에서 webRequest blocking 제거. 우리는 둘 다 유지:

```ts
session.defaultSession.webRequest.onBeforeRequest({}, (details, cb) => {
  // 확장의 webRequest 핸들러 + 우리 엔진 합성
})
```

## 웹스토어 .crx 설치 프록시

`https://chromewebstore.google.com/detail/<slug>/<id>` 페이지에서 "설치" 가로채기:

```ts
const CRX_URL = (id: string, version: string) =>
  `https://clients2.google.com/service/update2/crx?response=redirect` +
  `&os=win&arch=x64&os_arch=x86_64&nacl_arch=x86-64` +
  // ⚠ prodversion 을 하드코딩하지 말 것. 120 으로 고정했더니 minimum_chrome_version 이 그보다 높은
  // 확장(uBO Lite·Stylus·Wappalyzer)에 웹스토어가 204 를 돌려줘 조용히 실패했다.
  `&prod=chromiumcrx&prodchannel=unknown&prodversion=${process.versions.chrome}` +
  `&acceptformat=crx3&x=id%3D${id}%26installsource%3Dondemand%26uc`

async function installFromStore(id: string) {
  const buf = await fetch(CRX_URL(id, '120.0.0.0')).then(r => r.arrayBuffer())
  // CRX 헤더 떼고 ZIP 추출
  const zip = stripCrxHeader(Buffer.from(buf))
  const path = path.join(extensionsDir, id)
  await extractZip(zip, path)
  await session.defaultSession.loadExtension(path, { allowFileAccess: false }) // 위 경고 참조
}
```

매니페스트의 `permissions` 보여주고 사용자 동의 받은 뒤만 install.

## 확장 관리 UI

`browser://extensions` 페이지:
- 설치 목록 + 토글 + 제거
- 옵션 페이지 열기 (`chrome-extension://<id>/options.html`)
- 권한 표시
- 단축키 (commands API) 충돌 검출 (keymap-engineer)

## 호환성 회귀 테스트

`tests/extensions/` 의 10개 확장 자동 로드 + 기본 동작 검증. CI 에서 매주 1회.

## 절대 피할 것

- 확장 권한 자동 허용 — 항상 사용자 동의
- 모든 확장 동시 부팅 (시작 속도) — lazy 로드 + 사용 시 활성화
- 확장이 외피 IPC 호출 가능하게 — Chrome API 표면만
- 매니페스트 V2 완전 차단 (Chrome 따라가지 말 것) — 차별점
- service_worker 무한 실행 — Chrome idle timeout 정책 모방
