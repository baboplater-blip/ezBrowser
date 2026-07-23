---
description: 버전 업·CHANGELOG·GitHub Release·자동 업데이트 메타 갱신
argument-hint: <version> [channel]
---

# /release

새 버전을 만든다. release-engineer 가 처리.

## 인자

- `version`: semver (`1.2.3` 또는 `1.2.3-beta.1` 또는 `1.2.3-nightly.20260525`)
- `channel`: `latest` (기본) / `beta` / `nightly` — 미지정 시 prerelease tag 로 자동 결정

## 절차

1. **버전 정합성** — `package.json` + `app/main/constants.ts` 의 BUILD_VERSION 동시 갱신
2. **CHANGELOG.md** — 마지막 태그 이후 conventional commits 기반 자동 초안 + 사용자 검수
3. **`/test-safety`** 자동 실행 — 차단 시 중단
4. **`/build all`** 자동 실행 — 세 OS 빌드 + 사이닝
5. **git tag** `v<version>` + push
6. **GitHub Release 드래프트** 생성 — 빌드 산출물 + `latest.yml`/`beta.yml`/`nightly.yml` 업로드
7. **사용자가 publish 누르면** 자동 업데이트 채널 활성

## 출력 형식

```
🚀 Release v1.2.3 (channel: latest)
  ✅ 버전 동기화: package.json + constants.ts
  ✅ CHANGELOG.md
    + 12 commits (feat: 5, fix: 4, refactor: 2, docs: 1)
    → 검수 후 커밋: git add CHANGELOG.md && git commit ...
  ✅ /test-safety: 18/18 통과
  ✅ /build all:
    - dist/BrowserBuild-1.2.3-win-x64.exe (192 MB)
    - dist/BrowserBuild-1.2.3-mac-arm64.dmg (183 MB)
    - dist/BrowserBuild-1.2.3-linux-x86_64.AppImage (201 MB)
  ✅ git tag v1.2.3 → origin
  ✅ GitHub Release 드래프트: https://github.com/.../releases/tag/v1.2.3

다음 단계:
  - GitHub 에서 Release publish 누르면 latest.yml 활성 → 1시간 내 사용자 PC 가 업데이트 감지
  - beta/nightly 는 채널 가입자만 받음
```

## CHANGELOG 형식 (keepachangelog 한국어)

```markdown
## [1.2.3] - 2026-05-25

### 추가
- 동영상 다운로드 가속 (멀티 커넥션 4)
- 사이드패널에 QR 생성기

### 변경
- omnibox 자동완성 응답 800ms → 500ms 타임아웃 단축

### 수정
- 시크릿 세션에서 이력 저장되던 버그
- 한글 IME 입력 중 단축키 발화 (compositionend 까지 대기)
```

## 절대 피할 것

- 미사인 빌드 publish — Windows SmartScreen, macOS Gatekeeper 차단
- CHANGELOG 자동 생성 그대로 publish — 사람이 한 번 읽고 정리
- 이전 버전과 호환 깨짐 (스키마/매크로/userscript) 인데 마이그레이션 누락
- nightly 를 latest 채널로
