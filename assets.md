# assets.md — ezBrowser 이미지 에셋 가이드

> 이 문서는 **당신이 직접 만들 이미지의 사양·프롬프트**입니다. 각 항목의 크기·포맷·배경을 지켜 만들어 지정된 경로에 두면, **그 이후 적용(아이콘 변환·코드 배선·빌드)은 제가 자동으로 처리**합니다.
> 이미지 도구: Midjourney / 나노바나나2 / akool 어느 것이든 가능. 프롬프트는 영문(Midjourney용)과 한국어 의도를 함께 적었습니다.
> 관련 문서: 목표 [goal.md](goal.md) · 진행 [status.md](status.md). 이 에셋은 **Phase 2(제품 정체성)** 을 완성합니다.

---

## 0. 브랜드 기준 (모든 이미지 공통)

| 항목 | 값 |
|------|-----|
| 제품명 | **ezBrowser** (전부 소문자 e + 대문자 z·B, "이지브라우저") |
| 태그라인 | "가볍고 자유로운 브라우저" / "A light and free browser" |
| 핵심 인상 | **가벼움 · 자유 · 빠름 · 깔끔함** (무겁고 복잡한 크롬의 반대) |

### 컬러 팔레트 (이미지에 이 색을 쓰면 앱과 통일됩니다)

| 이름 | HEX | 용도 |
|------|-----|------|
| 액센트 블루 | `#3478F6` | 메인 브랜드 색 (로고·아이콘 주색) |
| 액센트 밝은 | `#5A93F9` | 그라데이션 밝은 쪽·다크모드 |
| 딥 블루 | `#1E5BD6` | 그라데이션 어두운 쪽 |
| 잉크(거의 검정) | `#1A1A1F` | 다크 배경·텍스트 |
| 오프화이트 | `#F7F7F8` | 라이트 배경 |
| 포인트 그린 | `#1E9E54` | 성공·"가벼움" 강조(선택) |

### 스타일 방향 (프롬프트에 공통으로 넣을 키워드)
`modern, minimal, flat design, soft rounded shapes, clean, friendly, vector style, generous negative space, subtle gradient, no harsh shadows`

### 로고 컨셉 — 셋 중 하나로 통일해 주세요 (전 항목 동일 컨셉 유지)
- **A. 깃털 (추천)** — "가볍고 자유로운"을 가장 직관적으로. 파란 깃털이 빠르게 날아가는 모션. (온보딩에서 이미 🪶 사용 중)
- **B. 종이비행기** — 가벼움·속도·자유. 접힌 종이비행기가 파란 궤적을 남김.
- **C. 둥근 'e' 마크** — ezBrowser 의 'e' 를 빠른 곡선/꼬리로 추상화. 가장 안전·범용.

> **추천: A 깃털.** 브라우저 카테고리에서 흔치 않아 식별성이 높고, 태그라인과 정확히 맞습니다. 아래 프롬프트는 모두 A 기준으로 적되, B/C 변형도 괄호로 덧붙였습니다.

---

## 전달 방법 (요약)

모든 원본 이미지는 **`resources/brand/`** 폴더에 아래 지정 파일명으로 넣어 주세요. (폴더 없으면 만들어 주세요.)
제가 거기서 자동으로: 앱 아이콘 → ico/icns/installer 변환, 일러스트 → 온보딩·빈 상태 화면 배선, 빌드 반영까지 처리합니다.

> ⚠️ **앱 아이콘만 먼저 주셔도 됩니다.** 1번이 Phase 2 의 마지막 출시 차단 항목입니다. 나머지(2~7)는 품질을 높이는 선택 항목이라 나중에 주셔도 됩니다.

| 우선순위 | 항목 | 파일명 (resources/brand/ 안) |
|---------|------|------------------------------|
| **P0 필수** | 1. 앱 아이콘 | `icon-1024.png` |
| P1 권장 | 2. 마스코트(선택) | `mascot.png` |
| P1 권장 | 3. 로고 가로형 | `logo-wordmark.png` |
| P2 | 4. 온보딩 일러스트 5종 | `onboarding-1.png` ~ `onboarding-5.png` |
| P2 | 5. 빈 상태 일러스트 5종 | `empty-newtab.png` 등 (아래 참고) |
| P2 | 6. 기본 파비콘 | `favicon-fallback.png` |
| P3 출시용 | 7. 스토어/OG 이미지 | `og-image.png`, `hero.png` |

---

## 1. [P0 필수] 앱 아이콘 — `resources/brand/icon-1024.png`

가장 중요합니다. 이 한 장이면 Windows(.ico)·macOS(.icns)·Linux·설치 파일 아이콘·작업표시줄 아이콘이 전부 자동 생성됩니다.

| 항목 | 사양 |
|------|------|
| 크기 | **1024 × 1024 px** (정사각형, 정확히) |
| 포맷 | PNG |
| 배경 | **불투명(꽉 찬 배경) 권장** — 둥근 사각형 안에 심볼. 투명 배경도 가능하나 불투명이 안전 |
| 여백 | 심볼 주위에 **약 15% 안전 여백** (가장자리에 붙이지 말 것 — macOS가 모서리를 둥글게 깎음) |
| 텍스트 | **글자 넣지 말 것** (작게 표시되면 안 보임). 심볼만 |

**스타일**: 둥근 사각형(super-ellipse) 배경에 `#3478F6 → #1E5BD6` 대각선 그라데이션, 중앙에 흰색/밝은 파랑 깃털 심볼. 모던 플랫.

**Midjourney 프롬프트 (영문, 그대로 사용):**
```
a modern app icon for a web browser called ezBrowser, a single minimalist white feather symbol centered on a rounded square with a smooth blue gradient background (#3478F6 to #1E5BD6), flat vector design, soft subtle highlight, clean, friendly, no text, generous padding, app icon style, dribbble, ios app icon --ar 1:1 --v 6
```
(컨셉 B: `white paper airplane with a small motion trail` / 컨셉 C: `a rounded lowercase letter e with a fast curved tail`)

**나노바나나2 / akool 한국어 의도:**
> 웹 브라우저 "ezBrowser" 앱 아이콘. 둥근 사각형 배경에 파란색 그라데이션(#3478F6→#1E5BD6), 정중앙에 흰색 미니멀 깃털 심볼 하나. 평면 벡터, 깔끔, 글자 없음, 충분한 여백. 1:1 정사각형.

> 💡 4~5개 변형을 만들어 주시면 그중 가장 또렷한 걸 제가 골라 적용하겠습니다. (작게 줄였을 때 알아볼 수 있는지가 핵심)

---

## 2. [P1 권장] 마스코트 캐릭터 (선택) — `resources/brand/mascot.png`

"캐릭터" 요청에 대한 항목입니다. 브라우저에 친근한 마스코트가 있으면 온보딩·빈 화면·에러 페이지에서 활용합니다. **없어도 출시 가능**하지만 있으면 브랜드 호감도가 올라갑니다.

| 항목 | 사양 |
|------|------|
| 크기 | **1024 × 1024 px** (여러 포즈를 줄 수 있으면 각각 1장씩) |
| 포맷 | PNG, **투명 배경(필수)** |
| 콘셉트 | 깃털에서 의인화된 작은 캐릭터, 또는 파란 새/깃털 요정. 둥글고 친근, 큰 눈, 단순한 형태 |

**Midjourney 프롬프트:**
```
a cute friendly mascot character for a web browser, a small round blue bird made of a single soft feather, big friendly eyes, minimal flat vector style, waving hello, sticker style, thick clean outline, pastel blue (#5A93F9), transparent background, mascot sheet --ar 1:1 --v 6
```
(포즈 추천: ① 인사하며 손 흔들기, ② 빠르게 나는 모습, ③ 박스/짐 들고 이사하는 모습=데이터 가져오기용, ④ 자는 모습=탭 슬립용)

**한국어 의도:**
> 웹 브라우저 마스코트. 부드러운 파란 깃털로 만들어진 작고 둥근 새 캐릭터, 큰 눈, 친근한 표정, 두꺼운 깔끔한 외곽선, 플랫 벡터, 투명 배경. 인사하는 포즈.

---

## 3. [P1 권장] 로고 가로형(워드마크) — `resources/brand/logo-wordmark.png`

온보딩 상단·설정 정보·랜딩에 쓰는 "심볼 + ezBrowser 글자" 가로 조합.

| 항목 | 사양 |
|------|------|
| 크기 | **1200 × 320 px** (가로로 긴 형태, 여백 포함) |
| 포맷 | PNG, **투명 배경(필수)** |
| 구성 | 왼쪽에 깃털 심볼 + 오른쪽에 "ezBrowser" 글자. 라이트/다크 양쪽에서 보이게 글자색은 중간 톤 또는 2버전 |
| 글꼴 | 둥글고 모던한 산세리프 (Poppins, Pretendard, SF Rounded 느낌). "ez"는 소문자 강조 |

**Midjourney 프롬프트 (참고용 — 워드마크는 글자 정확도 때문에 디자인 툴/Canva 권장):**
```
horizontal logo lockup, a small blue feather icon next to the wordmark "ezBrowser" in a rounded modern sans-serif, lowercase "ez", blue #3478F6, clean minimal, transparent background, vector --ar 4:1 --v 6
```
> 💡 글자가 들어가는 로고는 AI 이미지가 철자를 자주 틀립니다. **심볼만 PNG로 주시면(=1번 아이콘의 심볼 부분) 글자는 제가 코드/폰트로 조판**해 깔끔하게 합칠 수 있습니다. 이 방법을 권장합니다.

---

## 4. [P2] 온보딩 일러스트 5종 — `resources/brand/onboarding-1.png` ~ `onboarding-5.png`

첫 실행 마법사(`browser://welcome`)의 각 단계 상단에 들어갈 그림. 현재는 이모지(🪶🛡️⬇️🧩)라서, 일러스트로 바꾸면 첫인상이 크게 좋아집니다.

| 항목 | 사양 |
|------|------|
| 크기 | **800 × 480 px** (가로형) |
| 포맷 | PNG, 투명 배경 권장 |
| 스타일 | 5장 모두 **동일 스타일·동일 색감**(통일감이 가장 중요). 플랫, 라인+면, 파랑 위주 |

각 장의 주제:
1. `onboarding-1.png` — **환영/가벼움**: 깃털 또는 마스코트가 가볍게 떠오름
2. `onboarding-2.png` — **데이터 가져오기**: 박스를 든 마스코트가 크롬→ezBrowser로 짐 옮기는 느낌
3. `onboarding-3.png` — **광고 차단**: 방패가 광고/추적기를 막는 모습
4. `onboarding-4.png` — **편리 기능**: 동영상 다운로드·번역·스크린샷 아이콘들이 모인 모습
5. `onboarding-5.png` — **자유도/단축키**: 퍼즐 조각·슬라이더·키보드로 커스터마이즈하는 모습

**Midjourney 공통 프롬프트(주제만 바꿔서):**
```
flat vector illustration, [주제: e.g. a friendly blue feather mascot carrying a moving box of bookmarks from one browser to another], soft blue palette (#3478F6, #5A93F9), minimal, clean lines, white/transparent background, modern onboarding illustration, consistent style, no text --ar 5:3 --v 6
```

---

## 5. [P2] 빈 상태 일러스트 5종 — `resources/brand/empty-*.png`

목록이 비었을 때 보여줄 작은 그림(친근함·안내). 작게 표시되므로 단순하게.

| 파일명 | 화면 | 안내 의미 |
|--------|------|-----------|
| `empty-newtab.png` | 새 탭(자주 가는 사이트 없음) | "아직 방문한 사이트가 없어요" |
| `empty-bookmarks.png` | 북마크 없음 | "북마크가 비어 있어요" |
| `empty-history.png` | 방문 기록 없음 | "기록이 없어요" |
| `empty-downloads.png` | 다운로드 없음 | "받은 파일이 없어요" |
| `empty-readlater.png` | 읽기 목록 없음 | "나중에 볼 글이 없어요" |

| 항목 | 사양 |
|------|------|
| 크기 | **400 × 300 px** |
| 포맷 | PNG, **투명 배경(필수)** |
| 스타일 | 4번과 같은 톤, 더 단순. 마스코트 1마리 + 작은 소품(별/책갈피/시계/다운로드 화살표/책) |

**Midjourney 프롬프트(예: 북마크):**
```
small flat vector spot illustration, a cute blue feather mascot next to an empty bookmark star, soft blue palette, minimal, lots of white space, friendly, transparent background, no text --ar 4:3 --v 6
```

---

## 6. [P2] 기본 파비콘(폴백) — `resources/brand/favicon-fallback.png`

사이트가 파비콘을 제공하지 않을 때 탭·북마크·기록에 표시할 기본 아이콘.

| 항목 | 사양 |
|------|------|
| 크기 | **64 × 64 px** (단순해서 작아도 또렷하게) |
| 포맷 | PNG, 투명 배경 |
| 디자인 | 회색/연파랑 둥근 사각형 안에 단순한 "지구본" 또는 "문서" 실루엣. 중립적이어야 함(브랜드색 너무 튀지 않게) |

**프롬프트:**
```
simple monochrome favicon placeholder, a plain globe glyph inside a rounded square, neutral gray-blue, flat, minimal, 64px icon, transparent background, no text --ar 1:1 --v 6
```

---

## 7. [P3 출시용] 스토어·랜딩 이미지 (나중에)

배포(Phase 6) 때 필요. 지금 안 만들어도 됩니다.

| 파일명 | 크기 | 용도 |
|--------|------|------|
| `og-image.png` | 1200 × 630 | 링크 공유 시 미리보기(소셜) — 로고 + 태그라인 + 스크린샷 |
| `hero.png` | 1600 × 1000 | 랜딩 페이지 상단 큰 이미지 — 브라우저 창 목업 |
| `screenshot-*.png` | 1280 × 800 | 주요 기능 스크린샷(실제 화면 캡처로 대체 가능) |

> 스크린샷은 실제 앱 화면을 캡처해서 쓰는 게 가장 정확합니다. 이건 제품이 더 완성된 뒤에 함께 만들죠.

---

## 만들고 나서

1. `resources/brand/` 폴더에 위 파일명대로 저장
2. 저에게 "아이콘 넣었어" / "에셋 넣었어" 라고만 알려주세요
3. 제가 자동으로: 아이콘 변환·빌드 반영, 일러스트 화면 배선, 패키징까지 처리하고 결과를 보고합니다

> 가장 급한 건 **1번 앱 아이콘 한 장**입니다. 그것만 주시면 Phase 2(제품 정체성)가 끝나고, 코드 서명·저장소 owner만 더해지면 첫 베타 빌드가 나옵니다.
