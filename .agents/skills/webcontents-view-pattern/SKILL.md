---
name: webcontents-view-pattern
description: Electron 30+ WebContentsView 로 탭 컨테이너 구성. 옛 BrowserView 는 deprecated — 대체 패턴. 외피 + N개 콘텐츠 view 의 좌표·z-order 관리.
---

# WebContentsView 패턴

## 왜 WebContentsView 인가

- `BrowserView` 는 Electron 30 부터 deprecated, 추후 제거 예정
- `WebContentsView` 는 `BaseWindow.contentView` 에 child 로 add
- `<webview>` 태그는 보안·성능 둘 다 떨어짐 (사용 금지)

## 기본 구조

```ts
import { BaseWindow, WebContentsView } from 'electron'

const win = new BaseWindow({ width: 1280, height: 800 })

const CHROME_HEIGHT = 72  // tabbar(36) + toolbar(36)

const chrome = new WebContentsView({ webPreferences: { /* 외피 preload */ } })
win.contentView.addChildView(chrome)
chrome.setBounds({ x: 0, y: 0, width: 1280, height: CHROME_HEIGHT })

function addTab(url: string) {
  const tab = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/content.js'),
      sandbox: true, contextIsolation: true,
      partition: 'persist:default',
    },
  })
  win.contentView.addChildView(tab)
  tab.setBounds({ x: 0, y: CHROME_HEIGHT, width: 1280, height: 800 - CHROME_HEIGHT })
  tab.webContents.loadURL(url)
  return tab
}
```

## 활성 탭 전환

`contentView.children` 의 순서가 z-order. 활성 탭만 보이게:

```ts
function activateTab(tabId: string) {
  for (const v of contentViews) {
    if (v.id === tabId) {
      v.setVisible(true)
      v.setBounds(activeBounds())  // 늘 최신 좌표
    } else {
      v.setVisible(false)
    }
  }
}
```

`setVisible` 미지원 옛 빌드는 `setBounds` 를 `{ x: -99999 }` 로 옮기는 트릭.

## 창 리사이즈

```ts
win.on('resize', () => {
  const [w, h] = win.getContentSize()
  chrome.setBounds({ x: 0, y: 0, width: w, height: CHROME_HEIGHT })
  const activeBounds = { x: 0, y: CHROME_HEIGHT, width: w, height: h - CHROME_HEIGHT }
  activeTab()?.setBounds(activeBounds)
})
```

## 분할 화면 (layout-customizer 와 협업)

```ts
// 좌·우 50:50
const [w, h] = win.getContentSize()
const half = Math.floor(w / 2)
leftView.setBounds ({ x: 0,    y: CHROME_HEIGHT, width: half,     height: h - CHROME_HEIGHT })
rightView.setBounds({ x: half, y: CHROME_HEIGHT, width: w - half, height: h - CHROME_HEIGHT })
```

## 슬립 (메모리 회수)

```ts
function discard(tab: WebContentsView) {
  tab.webContents.close({ waitForBeforeUnload: false })
  win.contentView.removeChildView(tab)
  // 복원 시 새로 add + loadURL
}
```

`webContents.destroy()` 직접 호출 금지 — `close()` 가 안전.

## 외피 ↔ 탭 IPC

탭의 콘텐츠 페이지가 외피로 직접 IPC 보내면 안 됨. 메인 프로세스가 라우터:

```
content WebContents (페이지)
    → ipcRenderer.send('tabs:title-changed', { title })
메인 프로세스: 라우팅
    → chrome.webContents.send('tabs:updated', { tabId, title })
chrome (외피) 가 수신, UI 갱신
```

## 절대 피할 것

- 한 view 에서 URL 만 바꿔 탭 흉내 — 메모리는 절약 되지만 뒤로/앞으로·세션·격리 깨짐
- `setBounds` 마다 `forceNextDraw` 직접 호출 — Electron 이 알아서
- 활성/비활성 탭 모두 visible 로 둔 채 좌표만 0 — 렌더링·CPU 비용
- 탭마다 새 partition (`persist:tab-<id>`) — 격리 필요할 때만 (워크스페이스 또는 시크릿)
