# 릴리즈·코드사이닝·자동 업데이트 설정 가이드

배포 빌드를 만들기 전에 아래 항목을 환경변수로 주입한다. 값이 없으면 **미서명 빌드**가 생성되며, 자동 업데이트는 패키징 빌드에서만 동작한다(개발 모드는 항상 비활성).

## 1. 앱 아이콘

`build/icon.png`(1024×1024)는 `npm run gen:icon`(빌드 시 자동 실행)이 생성한다. electron-builder가 이 PNG 하나로 Windows `.ico` / macOS `.icns` / Linux 아이콘을 자동 변환한다. 자체 디자인 아이콘으로 교체하려면 `build/gen-icon.mjs`를 수정하거나 `build/icon.png`를 직접 1024×1024 PNG로 덮어쓴다.

## 2. Windows 코드 사이닝 (signtool)

EV 또는 OV 코드사이닝 인증서(`.pfx`)가 필요하다.

```powershell
$env:CSC_LINK = "C:\path\to\cert.pfx"   # 또는 base64 문자열
$env:CSC_KEY_PASSWORD = "인증서비밀번호"
npm run package:win
```

electron-builder가 환경변수를 감지해 signtool로 NSIS 인스톨러와 실행 파일을 서명한다. 환경변수가 없으면 서명 단계를 건너뛴다.

## 3. macOS 공증 (notarize)

Apple Developer 계정과 앱 전용 비밀번호가 필요하다. `electron-builder.yml`의 `mac.notarize`는 기본 `false`이며, 아래 3개 환경변수가 모두 있으면 `true`로 올려 공증을 수행한다.

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"
export CSC_LINK="/path/to/DeveloperIDApplication.p12"
export CSC_KEY_PASSWORD="비밀번호"
# electron-builder.yml 에서 notarize: true 로 변경 후
npm run package:mac
```

## 4. 자동 업데이트 엔드포인트

`electron-builder.yml`의 `publish` 블록이 업데이트 메타(`latest.yml`, `latest-mac.yml` 등) 위치를 결정한다. **기본 provider 는 GitHub Releases** 다. (`electron-updater` 6.x 의존성으로 동작.)

**필수 — owner 교체:** `electron-builder.yml` 의 `publish.owner` 가 현재 플레이스홀더(`REPLACE_GH_OWNER`)다. 실제 GitHub 사용자/조직으로 바꿔야 업데이트 체크가 동작한다. 안 바꾸면 체크 시 404 가 나지만 graceful(앱 동작 영향 없음).

```yaml
publish:
  provider: github
  owner: <GitHub 사용자/조직>   # ← 교체
  repo: browser-build
  releaseType: release
```

**퍼블리시(릴리즈 업로드):**
```powershell
$env:GH_TOKEN = "<repo 권한 PAT>"
npm run package:win -- --publish always   # 빌드 + GitHub Release 에 인스톨러·latest.yml 업로드
```

**채널 분리:** 앱 설정(`update.channel`: latest/beta/nightly).
- `latest` = 정식 릴리즈만(`allowPrerelease=false`).
- `beta`/`nightly` = GitHub **prerelease** 도 허용(`allowPrerelease=true`). 그 채널로 받게 하려면 해당 prerelease 에 `beta.yml`/`nightly.yml` 가 포함되도록 `releaseType: prerelease` 로 빌드해 업로드한다.

런타임은 `app/main/features/auto-update` 가 채널 메타를 조회한다. 부팅 1분 후 첫 체크, 이후 6시간 간격(설정 `update.autoCheck`). 새 버전 감지 시 `UpdateBanner` 가 알림을 띄우고, 사용자가 받기/재시작 설치를 누른다. 엔드포인트 도달 불가 시 오류 상태로 graceful 처리.

## 5. 빌드 명령 요약

| 명령 | 설명 |
|------|------|
| `npm run build` | 토큰·아이콘 생성 + 렌더러/메인/프리로드 컴파일 |
| `npm run package` | 현재 OS용 인스톨러 |
| `npm run package:win` | NSIS (Windows) |
| `npm run package:mac` | DMG (macOS) |
| `npm run package:linux` | AppImage + deb (Linux) |
