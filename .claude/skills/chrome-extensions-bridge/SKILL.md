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
  for (const ext of installedExtensions()) {
    await session.defaultSession.loadExtension(ext.path, { allowFileAccess: true })
  }

  // 새 탭 생성 시 확장의 콘텐츠 스크립트 자동 주입은 Electron 이 처리
})
```

## 자체 보강 (라이브러리 미지원 API)

### storage.sync 폴백

Chrome 의 `storage.sync` 는 Google 계정 동기화. 우리는 로컬 저장 + 자체 동기화(`data-sovereignty` WebDAV):

```ts
// 확장의 chrome.storage.sync 호출 → 우리 main 의 storage 어댑터
ipcMain.handle('chrome.storage.sync.get', async (e, keys) => {
  return storage.get(`ext-sync:${extId}`, keys)
})
```

### declarativeNetRequest

`electron-chrome-extensions` 가 기본 지원. 자체 광고차단(`adblocker-integrator`) 과 충돌:
- 확장의 룰 등록 시 우리 엔진과 도메인 우선순위 합의
- 사용자가 한쪽 선택

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
  `&prod=chromiumcrx&prodchannel=unknown&prodversion=120.0.0.0` +
  `&acceptformat=crx3&x=id%3D${id}%26installsource%3Dondemand%26uc`

async function installFromStore(id: string) {
  const buf = await fetch(CRX_URL(id, '120.0.0.0')).then(r => r.arrayBuffer())
  // CRX 헤더 떼고 ZIP 추출
  const zip = stripCrxHeader(Buffer.from(buf))
  const path = path.join(extensionsDir, id)
  await extractZip(zip, path)
  await session.defaultSession.loadExtension(path, { allowFileAccess: true })
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
