---
description: 보안 정책 정합성 검증 — sandbox, contextIsolation, CSP, 권한 핸들러, 외부 링크 가드
---

# /test-safety

`security-auditor` 가 `electron-secure-defaults` 체크리스트 전부를 자동 검사.

## 검사 항목

1. **webPreferences 정합성** — grep 으로 모든 BrowserWindow / WebContentsView 생성처
   - sandbox: true
   - contextIsolation: true
   - nodeIntegration: false
   - webSecurity: true
   - allowRunningInsecureContent: false
2. **preload 노출** — `ipcRenderer` 직접 노출 패턴 없음, contextBridge.exposeInMainWorld 만
3. **navigation 가드** — 모든 외피 view 에 `will-navigate` + `setWindowOpenHandler` 정의
4. **권한 핸들러** — `setPermissionRequestHandler` 화이트리스트 정의
5. **CSP** — 내부 페이지(`pages/*/index.html`) 의 `<meta http-equiv="Content-Security-Policy">` 검사
6. **commandLine 스위치** — 보안 약화 스위치(`--no-sandbox`, `--disable-web-security` 등) 부재
7. **<webview> 태그** — 사용 안 함 (`WebContentsView` 만)
8. **keymap 충돌** — keymap.json 의 동일 key + when 중복 검출
9. **확장 권한** — 설치된 확장의 매니페스트 권한 검토 (사용자 동의 기록 있음)
10. **userChrome.js opt-in** — settings.freedom.userChromeJs 가 기본 false 인지

## 출력 형식

`audit-report.md` 파일 작성 + 터미널에 요약:

```
🔒 Security Audit — 2026-05-25
✅ 통과 (15 / 18)
⚠️  경고 (2)
  - app/main/windows/main.ts:42 — webPreferences 의 sandbox 옵션 명시 안 됨 (Electron 디폴트 true 지만 명시 권장)
  - pages/settings/index.html:8 — CSP 의 script-src 에 'unsafe-inline' — 인라인 스크립트 제거 또는 nonce 사용 권장
❌ 차단 (1)
  - app/main/devtools/debug.ts:15 — app.commandLine.appendSwitch('disable-web-security') — 즉시 제거 필요

리포트: audit-report.md
```

## 차단 시

❌ 항목이 1개라도 있으면 `/build` `/release` 차단. 수정 후 재실행.

## 키 충돌 표시 (자유도 보조)

```
⚠️  keymap 충돌
  - Ctrl+Shift+P: action.palette.open + action.userscript.toggle (둘 다 chrome 컨텍스트)
    → 하나 변경 필요. 권장: action.userscript.toggle → Ctrl+Shift+U
```
