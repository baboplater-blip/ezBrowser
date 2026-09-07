---
name: ai-sidebar-design
description: AI 사이드바(AiTab) UI 를 좁은 280px 도크·디자인 토큰·외피 테마 제약 안에서 잘 설계·확장하는 방법. 정보구조(IA)·컴포넌트 패턴·상호작용·접근성·빈 상태. 새 하위 뷰(폴더/태그 등) 추가 시 참조.
---

# AI Sidebar Design

frontend-design 방법론을 **우리의 고정 제약**에 특화한 프로젝트 스킬. AI 사이드바([app/renderer/components/AiTab.tsx](../../app/renderer/components/AiTab.tsx))에 UI 를 추가·개선할 때 이 문서를 먼저 읽는다.

## 절대 제약 (바꿀 수 없는 것 — 여기에 맞춰라)

1. **폭 ~280px 세로 도크.** 가로 공간이 없다. 다단 레이아웃·넓은 표·나란한 버튼 6개 금지. 세로 스택 + 접기(collapse) + 필터가 기본 언어.
2. **비주얼 언어 = 디자인 토큰만.** 하드코딩 색/폰트 금지. 반드시 CSS 변수 사용:
   - 배경: `--color-bg-base`(패널) · `--color-bg-sunken`(hover/강조) · `--color-bg-elevated`
   - 텍스트: `--color-text-primary` · `--color-text-secondary` · `--color-text-muted`
   - 강조: `--color-accent`(선택/활성) · `--color-danger`(삭제, fallback `#e5484d`)
   - 경계: `--color-border-subtle`
   - 다크/라이트는 토큰이 자동 처리 — 우리는 변수만 참조하면 양쪽 다 맞는다.
3. **외피 z-order.** 사이드패널은 insets 로 콘텐츠 뷰를 밀어내므로 오버레이 승격 불필요. 단 팝오버·드롭다운을 절대좌표로 띄우면 콘텐츠 뷰에 가린다 → 도크 폭 안(패널 내부)에서만 펼쳐라.

## 확립된 컴포넌트 어휘 (재사용 · 새로 만들지 말 것)

| 용도 | 클래스 | 규칙 |
|------|--------|------|
| 메타바(모드·보조 액션) | `.ai-meta` / `.ai-mode-btn` / `.ai-mini-btn` | 보조 액션은 `.ai-mini-btn`(작은 pill). 활성 = `.active`(accent 채움). |
| 본문 스크롤 영역 | `.ai-body` | flex:1, 세로 스택. |
| 빈/안내 상태 | `.ai-welcome` / `.ai-welcome-page(.dim)` | 모든 뷰는 빈 상태 문구 필수. |
| 빠른 액션 세로 버튼 | `.ai-quick` / `.ai-quick-btn` | 좌측 정렬 텍스트, 세로 스택. |
| 목록 헤더 | `.ai-history-head` / `.ai-history-head-actions` | 제목 + 우측 액션(전체삭제/닫기). |
| 목록 검색 | `.ai-history-search` | 목록 위 단일 input. focus 시 accent 테두리. |
| 목록 행 | `.ai-history-list` / `.ai-history-item(.current)` | 클릭=열기, hover=sunken, 현재=accent 테두리. |
| 행 내부 | `.ai-history-main` / `.ai-history-title` / `.ai-history-sub` | 제목 1줄 ellipsis + 보조 메타(시각·개수). |
| 인라인 편집 | `.ai-history-edit` | ✎ 클릭 → input 치환, Enter 저장·Esc 취소·blur 저장. |
| 행 액션 | `.ai-history-icon`(✎ 등) / `.ai-history-del`(×, hover danger) | 아이콘 22px. stopPropagation 필수. |
| 실행 트레이스 | `.ai-trace` / `.ai-trace-item(.ok/.warn/.muted)` | 아이콘 + 텍스트. |
| 태그/필터 칩 | (신규) `.ai-chip(.active)` | 아래 "칩" 규칙 참조. |

## IA 원칙 (기능이 쌓일수록 중요)

- **모드는 최상위 2개까지**(현재 💬 챗 / 🤖 에이전트). 세 번째 모드 만들지 말 것 — 하위 뷰는 메타바 `.ai-mini-btn` 토글(🕘 이력 등)로.
- **메타바 버튼 예산 ≤ 4.** 넘으면 묶어라(오버플로 메뉴/토글). 라벨은 아이콘+짧은 한글("🕘 이력").
- **한 뷰 = 한 목적.** 목록 뷰와 상세 뷰를 분리하고 `← 뒤로`로 잇는다(실행 이력 상세가 예시).
- **필터는 목록 상단 한 줄.** 검색 input + 칩 행. 필터가 걸리면 결과 0건 문구를 검색과 구분해 보여라("검색 결과가 없습니다" ≠ "아직 없습니다").
- **파괴적 동작은 즉시 실행 금지.** 전체 삭제는 `window.confirm`, 개별 삭제는 × 아이콘(실수 시 되돌릴 수 있으면 confirm 생략 가능).

## 칩(chip) 규칙 — 태그·필터의 표준

좁은 폭에서 다중 선택·라벨은 드롭다운보다 **칩**이 낫다.
- `.ai-chip`: pill, `--color-bg-base` + `--color-border-subtle`, 12px, 좌우 8px. 활성 `.active` = accent 채움 흰 글자.
- 칩 행은 `flex-wrap: wrap; gap: 4px` — 넘치면 다음 줄로(가로 스크롤 X).
- 태그 색을 쓰려면 `--group-color` 식 CSS 변수 + `color-mix(in srgb, var(--tag) 18%, transparent)` 배경(외피 그룹 색 방식과 동일).
- 태그 편집은 칩 + 마지막에 `＋` 입력 칸(Enter 추가, 백스페이스로 마지막 제거).

## 상호작용·접근성 체크리스트 (새 UI 추가 시 전부)

- [ ] 모든 색/간격이 토큰 변수인가 (하드코딩 0)
- [ ] 다크·라이트 양쪽에서 대비 충분한가 (토큰만 쓰면 자동)
- [ ] 빈 상태 문구가 있는가
- [ ] 목록은 검색/필터가 있는가(항목이 많아질 수 있으면)
- [ ] 파괴적 동작에 확인이 있는가
- [ ] 인라인 편집은 Enter 저장·Esc 취소·blur 저장·stopPropagation 인가
- [ ] 키보드로 조작 가능한가(input focus·Enter·Esc). 커스텀 div 버튼엔 `title` 툴팁
- [ ] 팝오버/드롭다운이 패널 폭 안에서 펼쳐지는가(콘텐츠 뷰 침범 X)
- [ ] 상태 변경이 `on*Changed` broadcast 로 다중 창 동기되는가
- [ ] relTime 등 기존 헬퍼 재사용(중복 구현 X)

## 새 하위 뷰 추가 절차

1. 메타바에 `.ai-mini-btn` 토글 1개(예산 확인). 상호배타 뷰는 `showX` state.
2. `.ai-body` 안에 목록(+검색/필터) → 상세(`← 뒤로`) 2단.
3. 메인 저장소 + IPC `xxxChanged` broadcast + preload `onXxxChanged` 구독.
4. 빈 상태·필터 0건·삭제 확인·인라인 편집 표준을 위 어휘로.
5. CSS 는 기존 `.ai-history-*`/`.ai-chip` 재사용, 신규는 최소.
6. CDP 하네스로 검증(로컬 Ollama 로 키 없이 e2e 가능).

## 폴더/태그 적용안 (이 스킬의 첫 적용)

좁은 폭 → **얕게** 간다:
- **폴더 = 1단 평면**(중첩 트리 금지 — 280px 에서 들여쓰기 트리는 가독성 붕괴). 대화는 `folderId?: string | null`.
- **태그 = 교차 라벨**(다대다). 대화는 `tags?: string[]`.
- **히스토리 필터 행**(검색 아래): `[전체] [📁 폴더칩들…]` + `[#태그칩들…]`. 칩 클릭 = 필터 토글(폴더 단일선택·태그 다중선택 AND).
- **대화 행**: 제목 아래 보조 메타에 `📁폴더 · #태그1 #태그2` 작게.
- **분류(assign)**: 대화 행 `✎` 옆 `📁` 아이콘 → 폴더 선택 + 태그 입력 미니 패널(패널 폭 안 인라인 확장, 절대좌표 팝오버 아님).
- 저장은 `conversations.ts` 에 `folderId`/`tags` 필드 + `setConversationFolder`/`setConversationTags` + 폴더 목록은 대화들의 folderId 에서 유도(별도 폴더 엔티티 최소화) 또는 `ai-chat-folders.json` 경량 저장. 태그는 대화의 tags 합집합에서 유도.
