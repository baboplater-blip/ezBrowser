---
name: electron-secure-defaults
description: Electron 보안 기본값 체크리스트. webPreferences, preload 패턴, 권한 핸들러, navigation 가드, CSP. security-auditor 가 사용.
---

# Electron Secure Defaults

`/test-safety` 슬래시 커맨드가 이 체크리스트를 자동 검사.

## 1. webPreferences (모든 BrowserWindow / WebContentsView)

```ts
webPreferences: {
  sandbox: true,                       // ✅
  contextIsolation: true,              // ✅
  nodeIntegration: false,              // ✅
  webSecurity: true,                   // ✅ (절대 false 금지)
  allowRunningInsecureContent: false,  // ✅
  experimentalFeatures: false,         // ✅
  enableBlinkFeatures: '',             // ✅ (옛 API 활성화 금지)
}
```

`security-auditor` grep 패턴:
```
grep -rn "sandbox:\s*false\|nodeIntegration:\s*true\|webSecurity:\s*false" app/
```

## 2. preload

- `contextBridge.exposeInMainWorld('browserAPI', ...)` 만 사용
- `ipcRenderer` 직접 노출 금지:

```ts
// ❌ 절대 금지
contextBridge.exposeInMainWorld('ipc', ipcRenderer)

// ✅ 채널·인자 모두 화이트리스트
contextBridge.exposeInMainWorld('browserAPI', {
  tabs: {
    create: (opts: { url: string }) => ipcRenderer.invoke('tabs:create', opts),
  },
})
```

## 3. navigation 가드

```ts
chrome.webContents.on('will-navigate', (e, url) => {
  if (!isInternalUrl(url)) e.preventDefault()
})
chrome.webContents.setWindowOpenHandler(({ url }) => {
  shell.openExternal(url)
  return { action: 'deny' }
})
```

내부 페이지(`browser://*`, `http://localhost:5173` 개발), 외피는 그 외 URL 로드 금지.

## 4. 권한 핸들러

```ts
const ALLOWED_PERMISSIONS: Electron.Permission[] = [
  'media', 'geolocation', 'notifications',
  'clipboard-read', 'fullscreen', 'pointerLock',
]

session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => {
  if (!ALLOWED_PERMISSIONS.includes(perm)) return cb(false)
  cb(policyEngine.permission(details.requestingUrl, perm))
})

session.defaultSession.setPermissionCheckHandler((wc, perm) => {
  return ALLOWED_PERMISSIONS.includes(perm as any)
})
```

## 5. CSP (내부 페이지)

`pages/*/index.html` 의 `<head>`:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https:;">
```

`'unsafe-eval'` 금지. `'unsafe-inline' script` 금지.

## 6. 외부 콘텐츠

- 콘텐츠 페이지는 어떤 사이트든 OK — Electron 의 콘텐츠 webPreferences 가 제대로면 sandbox 안전
- 외피 페이지는 자체 origin (`browser://`) 만

## 7. 명령줄 스위치 금지 목록

```
--no-sandbox
--disable-web-security
--disable-features=SiteIsolation
--disable-site-isolation-trials
--ignore-certificate-errors
```

`app.commandLine.appendSwitch(...)` grep 으로 검출.

## 8. 다운로드

```ts
session.defaultSession.on('will-download', (e, item, wc) => {
  if (!isTrustedTab(wc)) {
    e.preventDefault()
    return
  }
  // 저장 경로 정규화 + path traversal 차단
})
```

## 체크리스트 출력 (audit-report.md)

```
✅ 모든 webPreferences sandbox+contextIsolation+nodeIntegration:false
✅ preload 에 ipcRenderer 직접 노출 없음
✅ will-navigate / setWindowOpenHandler 정의
✅ 권한 핸들러 화이트리스트 있음
✅ 내부 페이지 CSP 정의
✅ 보안 약화 commandLine switch 없음
⚠️  pages/settings/index.html: script-src 'unsafe-inline' 사용 — 제거 권장
```
