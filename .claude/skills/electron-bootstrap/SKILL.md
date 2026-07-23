---
name: electron-bootstrap
description: Electron 33+ 프로젝트의 최소 부팅 절차. main / preload / renderer 3계층 + contextBridge 안전 IPC 패턴. tsconfig 분리.
---

# Electron 부팅 절차

## 의존성 (최소)

```bash
npm i -D electron electron-builder typescript vite @vitejs/plugin-react
npm i react react-dom electron-store better-sqlite3
```

## tsconfig 3개

```
tsconfig.base.json   # 공통 (strict, target ES2022)
app/main/tsconfig.json    # noEmit: false, module: commonjs, target ES2022
app/preload/tsconfig.json # 메인과 동일
app/renderer/tsconfig.json # Vite, module: esnext, jsx
```

## main/index.ts (최소)

```ts
import { app, BaseWindow, WebContentsView, session } from 'electron'
import path from 'node:path'

const isDev = process.env.NODE_ENV !== 'production'

app.whenReady().then(async () => {
  const win = new BaseWindow({ width: 1280, height: 800, show: false })

  const chrome = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/chrome.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.contentView.addChildView(chrome)
  chrome.setBounds({ x: 0, y: 0, width: 1280, height: 800 })

  if (isDev) {
    chrome.webContents.loadURL('http://localhost:5173')
  } else {
    chrome.webContents.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  chrome.webContents.once('ready-to-show' as any, () => win.show())
})
```

## preload/chrome.ts (contextBridge 게이트)

```ts
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  tabs: {
    create: (opts: any) => ipcRenderer.invoke('tabs:create', opts),
    list:   (winId: string) => ipcRenderer.invoke('tabs:list', { windowId: winId }),
    close:  (id: string) => ipcRenderer.invoke('tabs:close', { tabId: id }),
  },
  omnibox: {
    suggest: (q: string) => ipcRenderer.invoke('omnibox:suggest', { query: q }),
  },
  // ... 모든 도메인
}

contextBridge.exposeInMainWorld('browserAPI', api)
export type BrowserAPI = typeof api
```

타입은 renderer 에서 `declare global { interface Window { browserAPI: BrowserAPI } }` 로.

## renderer (Vite)

`app/renderer/index.html` + `app/renderer/main.tsx` (React 마운트). 외부 origin 아님 — 패키지 후엔 `file://` 또는 `app://` 프로토콜.

## npm scripts

```json
{
  "scripts": {
    "dev:renderer": "vite",
    "dev:main": "tsc -p app/main && tsc -p app/preload && electron app/main/dist/index.js",
    "dev": "concurrently -k \"npm:dev:renderer\" \"wait-on http://localhost:5173 && npm run dev:main\"",
    "build": "vite build && tsc -p app/main && tsc -p app/preload",
    "package": "npm run build && electron-builder"
  }
}
```

## 절대 피할 것

- `nodeIntegration: true`
- preload 에서 `require()` 노출
- main 에서 동기 차단(`dialog.showMessageBoxSync`, `fs.readFileSync` 큰 파일)
- renderer 가 `localhost:5173` 로딩을 패키지 빌드에 — 환경 분기
