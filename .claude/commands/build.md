---
description: electron-builder 로 설치 파일 생성 — Windows NSIS, macOS DMG, Linux AppImage/deb
argument-hint: [win|mac|linux|all]
---

# /build

설치 파일을 만든다. release-engineer 가 처리.

## 인자

- 없음 = 현재 OS
- `win` / `mac` / `linux` = 단일 OS
- `all` = 세 OS 동시 (CI 가능 환경)

## 절차

1. **사전 검증** — `tsc --noEmit` 모든 tsconfig, `npm run build` 통과
2. **라이선스 갱신** — `npm run licenses` (license-checker → app/main/storage/oss-licenses.json)
3. **디자인 토큰 빌드** — `node build/gen-tokens.ts`
4. **electron-builder 실행** — 인자별:
   - `--win`: NSIS + portable
   - `--mac`: DMG + ZIP (auto-update)
   - `--linux`: AppImage + deb
5. **사이닝 검증** — Windows signtool / macOS codesign
6. **SHA256 생성** — `dist/SHA256SUMS`
7. **가벼움 게이트** — 산출물 ≤ 250MB. 초과 시 차단 + 원인 분석

## 출력 형식

```
✓ 빌드 완료 (win)
  - dist/BrowserBuild-1.0.0-win-x64.exe (187 MB) ✅
  - dist/latest.yml (자동 업데이트 메타)
  - 사이닝: signtool ✅ (DigiCert EV)
  - SHA256: a3f...
  - 가벼움 게이트: 187 / 250 MB ✅

다음 단계:
  - 로컬 실행 테스트: dist/BrowserBuild-1.0.0-win-x64.exe
  - 릴리즈: /release 1.0.0
```

## 환경 변수 필수 (사이닝)

- Windows: `CSC_LINK` `CSC_KEY_PASSWORD` 또는 `WIN_CSC_LINK`
- macOS: `APPLE_ID` `APPLE_APP_SPECIFIC_PASSWORD` `APPLE_TEAM_ID`

누락 시 unsigned 빌드 + 큰 경고. CI 가 아닌 로컬 빌드는 unsigned 허용 (개발 테스트).

## 가벼움 초과 시 자동 분석

```
✗ 빌드 차단 — 산출물 285 MB > 250 MB
원인:
  - node_modules/@imgly/background-removal 28 MB (사용 안 함? 제거 권장)
  - resources/yt-dlp 18 MB (옵션 다운로드로 분리 검토)
  - node_modules 중복 23 MB (npm dedupe 권장)
```
