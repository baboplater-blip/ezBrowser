---
name: auto-update-pattern
description: electron-updater + GitHub Releases 채널 분리 자동 업데이트. latest/beta/nightly, 트레이 진행률, 사용자 동의 적용.
---

# 자동 업데이트 패턴

## 의존성

```bash
npm i electron-updater electron-log
```

## main 에서

```ts
import { autoUpdater } from 'electron-updater'
import log from 'electron-log'

autoUpdater.logger = log
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = false  // 사용자 동의 후만

const channel = userSettings.updateChannel  // 'latest' | 'beta' | 'nightly'
autoUpdater.channel = channel
autoUpdater.allowPrerelease = channel !== 'latest'

app.whenReady().then(() => {
  setTimeout(() => autoUpdater.checkForUpdates(), 60_000)  // 부팅 1분 후
  setInterval(() => autoUpdater.checkForUpdates(), 6 * 3600 * 1000)  // 6시간마다
})

autoUpdater.on('update-available', (info) => {
  notifyUI('update:available', info)
})

autoUpdater.on('download-progress', (p) => {
  win.setProgressBar(p.percent / 100)
  trayIcon.setToolTip(`업데이트 다운로드 중: ${p.percent.toFixed(1)}%`)
})

autoUpdater.on('update-downloaded', (info) => {
  notifyUI('update:downloaded', info)  // 사용자에게 "지금 재시작" or "다음에"
})

ipcMain.handle('update:install', () => autoUpdater.quitAndInstall(false, true))
```

## electron-builder.yml publish

```yaml
publish:
  - provider: github
    owner: <github-org>
    repo: browser-build
    releaseType: draft   # 사용자가 publish 누를 때까지 발표 안 됨
```

`latest.yml` / `beta.yml` / `nightly.yml` 메타가 채널별로 자동 생성.

## 채널 분리

GitHub Release 의 prerelease 플래그로:
- `1.2.3` → latest.yml
- `1.2.3-beta.1` → beta.yml
- `1.2.3-nightly.20260525` → nightly.yml

사용자는 설정 → "정보" → "업데이트 채널" 에서 선택. 채널 변경 시 다음 체크부터 적용.

## 코드 사이닝과 함께

- Windows: 사인된 exe 만 electron-updater 가 적용 (signature check)
- macOS: notarized DMG 만
- 사인 누락 → 업데이트 실패 + 사용자 알림

## 사용자 UX

- 부팅 즉시 체크 금지 (시작 속도 영향) — 1분 후
- 다운로드 진행률 트레이 아이콘 + 토스트
- "지금 재시작" / "다음 종료 시" 선택
- 강제 업데이트 옵션은 critical security fix 만 (마니페스트 플래그)

## 절대 피할 것

- `autoInstallOnAppQuit: true` 기본 ON (사용자 의도 없는 적용)
- 매 부팅 즉시 체크 (시작 속도)
- 진행률 표시 없는 다운로드 (사용자 의심)
- 사인 누락 빌드 배포 (Windows SmartScreen, macOS Gatekeeper 차단)
- beta 사용자에게 latest 만 푸시 (채널 신뢰 파괴)
