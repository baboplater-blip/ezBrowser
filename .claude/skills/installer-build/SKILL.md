---
name: installer-build
description: electron-builder 로 NSIS(Windows), DMG(macOS), AppImage/deb(Linux) 산출. 코드 사이닝·notarize·라이선스 첨부 절차.
---

# 설치 파일 빌드

## 빌드 명령

```bash
# 단일 OS (현재 OS)
npm run package

# 모든 OS (CI 권장)
npm run package -- --win --mac --linux

# 아키텍처 지정
npm run package -- --win --x64 --arm64
```

## 산출물 위치

`dist/` 아래:
- `BrowserBuild-1.0.0-win-x64.exe` (NSIS)
- `BrowserBuild-1.0.0-mac-arm64.dmg`
- `BrowserBuild-1.0.0-linux-x86_64.AppImage`
- `latest.yml` / `latest-mac.yml` / `latest-linux.yml` (자동 업데이트 메타)

## NSIS (Windows) 옵션

```yaml
nsis:
  oneClick: false                          # 인스톨러 위저드 표시
  perMachine: false                        # 사용자별 설치 (관리자 권한 불요)
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: always
  createStartMenuShortcut: true
  shortcutName: BrowserBuild
  uninstallDisplayName: BrowserBuild
  artifactName: ${productName}-${version}-win-${arch}.${ext}
  installerSidebar: build/sidebar.bmp      # 164×314 BMP
  installerHeader: build/header.bmp        # 150×57 BMP
  license: build/license.txt
```

## 코드 사이닝

### Windows

EV 코드사이닝 인증서(USB 토큰) 또는 Azure Key Vault:

```yaml
win:
  signtoolOptions:
    sign: ./build/sign.js   # 커스텀 signing 스크립트
```

`build/sign.js`:
```js
const { execSync } = require('child_process')
exports.default = async function(configuration) {
  execSync(`signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 /a "${configuration.path}"`)
}
```

### macOS

```yaml
mac:
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  notarize: true
```

환경 변수:
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

`build/entitlements.mac.plist`:
```xml
<plist><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
  <key>com.apple.security.network.client</key><true/>
  <key>com.apple.security.network.server</key><true/>
  <key>com.apple.security.files.user-selected.read-write</key><true/>
</dict></plist>
```

## 라이선스

`browser://licenses` 페이지에 의존성 OSS 라이선스 목록. 자동 생성:

```bash
npx license-checker --json --production --excludePrivatePackages \
  --customPath build/license-format.json > app/main/storage/oss-licenses.json
```

빌드 전 자동 갱신 (`prebuild` 스크립트).

## 산출물 검증

```bash
# 사이닝 검증
signtool verify /pa /v dist/BrowserBuild-1.0.0-win-x64.exe
codesign --verify --deep --strict dist/mac/BrowserBuild.app

# SHA256
shasum -a 256 dist/*.exe dist/*.dmg dist/*.AppImage > dist/SHA256SUMS
```

## 가벼움 게이트

설치 파일 ≤ 250MB. 초과 시:
- `asar` ON 인지 (`asar: true`)
- `files` 화이트리스트 좁히기
- 큰 리소스(yt-dlp 등) 옵션 다운로드로 분리
- `node_modules` 중복 (`npm dedupe`)

## 절대 피할 것

- 사이닝 누락 — Windows SmartScreen / macOS Gatekeeper 차단
- DMG 에 백그라운드 그림 누락 — UX 일관성
- `oneClick: true` — 사용자가 설치 옵션 못 봄
- 32bit Windows 빌드 — 부담 대비 사용자 매우 적음 (필요 시 별 요청)
- 코드 사이닝 키를 git 에 — `.gitignore` 필수
