---
description: 새 기능 스캐폴드 — 메뉴 항목 + IPC 채널 + 설정 키 + i18n 키 + 액션 ID 한 번에 추가
argument-hint: <slug> "<한국어 라벨>"
---

# /new-feature

새 기능 한 개를 일괄 스캐폴드한다.

## 입력 파싱

- `/new-feature reader-mode "리더 모드"`
- `/new-feature pip-mode "PIP 동영상"`

## 절차

1. **슬러그 검증** — `kebab-case`, 기존 액션/메뉴와 충돌 없는지 grep
2. **browser-architect 호출** — 어떤 프로세스에서, 어떤 IPC 채널, 어떤 저장소 결정. `SPEC.md` 작성
3. **도메인 에이전트 호출** — SPEC 의 카테고리(tab/omnibox/bookmark/…) 에 따라 자동 라우팅
4. **부산물 자동 추가**:
   - `app/main/actions/registry.ts` — actionId 등록 (`action.<slug>.<verb>`)
   - `app/shared/keymap.default.json` — 기본 단축키 (제안값, 충돌 없으면 적용)
   - `app/shared/locales/ko.json` `en.json` — i18n 키
   - `app/main/storage/settings-schema.ts` — 설정 키 (필요 시)
   - `app/main/ipc/<domain>.ts` — IPC 핸들러
   - `app/preload/chrome.ts` — contextBridge 노출
5. **security-auditor 호출** — 보안 영향 자동 검증
6. **빌드 + 단위 확인** — `npm run build` 통과

## 출력 형식

```
✓ 기능 "리더 모드" 스캐폴드 완료
  - SPEC: app/main/features/reader-mode/SPEC.md
  - 액션: action.reader.toggle (Ctrl+Alt+R, 충돌 없음)
  - IPC: reader:toggle, reader:status
  - i18n: action.reader.toggle = "리더 모드" / "Reader Mode"
  - 설정: appearance.readerFontSize: number
  - 빌드 OK
  - 보안 감사 OK (콘텐츠 스크립트 주입, contextIsolation 유지)

다음 단계:
  - tab-engineer 가 Readability.js 주입 로직 구현
  - ui-designer 가 리더 뷰 디자인
  - 명령 팔레트 등록 자동 (action registry 통과)
```

## 주의

- 기능이 자유도(userChrome·userscript·정책·매크로) 와 상호작용해야 하면 해당 에이전트도 호출
- 단축키 제안 시 keymap-engineer 충돌 검사 필수
- 설정 키 추가 시 zod 스키마 + 마이그레이션 함수 동시 작성
- i18n 키는 ko/en 동시 작성, vi 는 빈값 placeholder
