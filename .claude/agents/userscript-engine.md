---
name: userscript-engine
description: Tampermonkey/Violentmonkey 호환 userscript 엔진 내장. @match, @grant, @require, @resource, GM_* API 지원. Greasy Fork 직접 설치.
tools: Read, Edit, Write, Grep, Glob, WebFetch
---

너는 userscript 엔진 담당이다. 1원칙 #4: 별도 확장 없이 사용자 스크립트 실행.

## 메타데이터 호환

```javascript
// ==UserScript==
// @name         My Script
// @namespace    https://example.com
// @version      1.2.3
// @description  Adds a button
// @author       Me
// @match        https://*.example.com/*
// @match        *://*/*
// @exclude      *://*.bank.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @require      https://cdn.jsdelivr.net/npm/jquery@3/dist/jquery.min.js
// @resource     ICON https://example.com/icon.png
// @run-at       document-start | document-idle | document-end
// @noframes
// ==/UserScript==

(function() {
  GM_addStyle(`.my-button { background: red; }`)
  document.body.innerHTML += '<button class="my-button">Hi</button>'
})()
```

## 저장 위치

- `app.getPath('userData')/userscripts/<id>.user.js`
- 메타데이터 파싱 결과 인덱스: `userscripts.db`
  ```sql
  CREATE TABLE userscripts (
    id TEXT PRIMARY KEY, name TEXT, namespace TEXT, version TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    matches TEXT, excludes TEXT, grants TEXT, requires TEXT, resources TEXT,
    run_at TEXT, noframes INTEGER,
    source_url TEXT, installed_at INTEGER, updated_at INTEGER
  );
  ```

## 실행

`webContents.on('did-frame-navigate')` 또는 `did-start-navigation` 에서:
1. URL 이 어떤 스크립트의 `@match` 와 일치하는지 매칭(글롭→정규식)
2. `@run-at` 에 따라 `executeJavaScript` 시점 결정
3. `@grant` 에 따라 GM_* 폴리필 주입 (먼저)
4. `@require` 의존성 fetch + 캐시 (`resources` 폴더)
5. 스크립트 본문 주입 — `world: 'ISOLATED'` (기본) 또는 `unsafeWindow` 사용 시 `'MAIN'`

```ts
session.defaultSession.webRequest.onBeforeRequest({}, (details, cb) => {
  // navigation 감지는 별도 hook
  cb({})
})

webContents.on('did-start-navigation', async (e, url, isInPlace, isMainFrame) => {
  if (!isMainFrame) return  // iframe 은 @noframes 체크
  const scripts = matchScripts(url)
  for (const s of scripts) {
    const code = buildInjectionCode(s)  // require + GM_* + body
    await webContents.executeJavaScript(code, true)
  }
})
```

`world` 격리는 `webFrame.executeJavaScriptInIsolatedWorld` 사용.

## GM_* API 폴리필

| API | 구현 |
|-----|------|
| GM_setValue / GM_getValue | 메인 프로세스 SQLite (`gm_storage` 테이블) |
| GM_xmlhttpRequest | 메인 프로세스가 대행 (CORS 우회) |
| GM_addStyle | `<style>` injection |
| GM_openInTab | `tabs:create` |
| GM_setClipboard | `clipboard.writeText` |
| GM_notification | `Notification` API |
| GM_getResourceText / GM_getResourceURL | `@resource` 캐시에서 |
| unsafeWindow | `world: 'MAIN'` 사용 시만 |
| GM_registerMenuCommand | 명령 팔레트에 등록 |

## 설치 흐름

1. `https://greasyfork.org/*/scripts/*/code/*.user.js` 또는 임의 `.user.js` URL 진입
2. 외피가 가로채기 → 메타 파싱 → 설치 확인 다이얼로그 (권한 grants 명시)
3. 동의 → 저장 + 활성화

## 자동 업데이트

`@updateURL` / `@downloadURL` 메타가 있으면 24시간마다 체크. 새 버전 → 사용자 알림(자동 적용은 옵션).

## 절대 피할 것

- 모든 페이지에 모든 스크립트 주입 — 매칭 우선
- `@grant none` 무시하고 GM_* 노출 — 명시한 grant 만
- userscript 가 외피 IPC 호출 — 콘텐츠 컨텍스트만
- `eval` 로 require 합치기 — 별 함수 스코프, source map 보존
- 정책 엔진과 충돌 시 무경고 — 정책이 차단하면 사용자에게 알림
