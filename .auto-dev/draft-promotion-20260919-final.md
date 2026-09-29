# 초안 → 게시 승격 (draft promotion) — 최종 보고

**실행** `run-20260919T121840Z-b597cd` · 2026-09-19 · rc.13 → **rc.14**
**한 줄**: `초안까지만` 으로 만들어 둔 이미지 게시 작업을, **이미지·캡션을 다시 만들지 않고**
사용자가 **한 번 명시적으로 확인해** 실제 게시로 올릴 수 있게 했다.

---

## 1. 무엇이 문제였나

초안 모드로 만든 워크플로에는 **게시로 올릴 방법이 전혀 없었다.** 이미지와 캡션이 멀쩡히
보관돼 있는데도 올리려면 같은 프롬프트로 워크플로를 **처음부터 다시 만들어야** 했다 —
생성 크레딧을 다시 쓰고, 나오는 그림도 캡션도 달라진다. 사용자가 보고 마음에 들어 한
**바로 그것**이 아니게 된다.

두 종류의 초안이 있는데 둘 다 막혀 있었다:
1. `stage:'review'` + `params.mode:'draft'` — 확인 단계에 멈춰 있는 초안
2. `stage:'done'` + `receipt.status:'draft'` — "초안까지 준비(게시 안 함)" 로 끝난 작업

---

## 2. 설계 — 왜 이렇게 했는가

### 2.1 아무것도 다시 만들지 않는다
승격은 **보관된 산출물 파일과 저장된 캡션을 그대로** 쓰고, 기존 게시 경로
(`runPublishStage` → 내구성 경계 → 작업 시작)에 그대로 얹는다. **새 게시 엔진을 만들지 않았다** —
게시 게이트·`persistPublishBoundary`·`setResumeBlock` 이어가기 보호를 전부 재사용한다.

### 2.2 `params.mode` 를 바꾸지 않는다 — 이것이 핵심 결정이다
가장 단순한 구현은 "초안 → 게시" 에서 `params.mode` 를 `'publish'` 로 뒤집는 것이다.
**그렇게 하지 않았다.** `autoPublishVerdict` 의 첫 관문이 바로 그 `mode` 검사이기 때문이다 —
뒤집는 순간 그 워크플로가 **자동 게시 선승인(AutoPublishGrant)의 대상으로 들어온다.**
사용자가 한 건을 손으로 확정한 사실이 "앞으로 이 작업은 자동으로 나가도 좋다" 로 번지면 안 된다.

대신 `promotedAt`(이 한 건을 올린다는 사실)만 따로 적고, 실제 게시 여부는
`effectivePublishMode(wf) = params.mode === 'publish' || promotedAt` 로 판정한다.
이 함수를 **게시 작업을 만들 때와 영수증을 적을 때 둘 다** 쓴다 — 한쪽만 쓰면 "실제로는
게시했는데 영수증은 초안" 이 되어 사용자가 안 올라간 줄 알고 같은 글을 또 올린다.
방어 이중화로 `autoPublishVerdict` 에도 `promotedAt` 거부를 명시했다.

### 2.3 확인은 그 순간의 사실에 묶인다(revision 바인딩)
확인 화면을 열 때 `revision = sha256(플랫폼 ∥ 계정 ∥ 산출물id ∥ 산출물sha256 ∥ 캡션)` 을 계산해
티켓에 넣는다. 확정 시점에 **다시 계산해 같은지 본다.** 하나라도 달라졌으면 게시하지 않고,
`describePromotionDrift` 가 **무엇이 달라졌는지**(캡션·계정·이미지·플랫폼) 한국어·영어로 짚어 준다.

`updatedAt` 같은 범용 리비전을 쓰지 않은 이유: 무관한 `touch()` 에도 무효가 되어 사용자가
이유 없이 다시 확인해야 한다. 반대로 너무 느슨하면 바뀐 내용이 나간다. **판정에 쓰이는 사실만**
지문에 넣는 것이 정확하다.

### 2.4 확인은 디스크로 나가지 않는다
티켓은 **메모리 전용 `Map`** 이다. 이것이 "확정 전에 재시작하면 아무것도 나가지 않는다" 의 근거다 —
승인을 파일에 적으면 그 파일이 곧 **재시작을 넘어 사는 권한**이 된다("한 번 확정" 이 아니게 된다).
반대로 **승격했다는 사실(`promotedAt`)은 반드시 디스크에 남아야** 한다: 잊으면 실제 게시가
"초안" 영수증으로 잘못 적히고 같은 초안을 또 올릴 수 있다. 그래서 복원은 fail-closed 로
**키가 있으면 승격된 것**으로 본다(값이 손상됐으면 `1`) — `accountEditedAt` 과 같은 규칙이다.

### 2.5 확인은 1회용이다
`confirmPromotion` 은 **검사보다 먼저** 티켓을 소비한다. 그래서 연타·재전송의 두 번째 호출은
볼 티켓이 없다. 거부되면 사용자는 화면에서 다시 확인해야 한다 — 그것이 "한 번 확정" 의 뜻이다.

### 2.6 지난 기록을 덮어쓰지 않는다 · 실패하면 되돌린다
완료된 초안을 승격하면 그 자리에 새 영수증이 들어온다. 옛 영수증은 지우지 않고
`priorReceipts` 로 **옮긴다**(화면의 `이전 기록` 에 접혀 보인다).
그리고 게시가 **시작조차 못 하면** 그 정리를 **되돌린다** — 아무것도 나가지 않았으므로
사용자가 보던 상태(완료된 초안이면 '완료', 확인 단계면 '확인')로 복원한다. 이미 게시 작업이
만들어졌으면 되돌리지 않는다(실제로 나갔을 수 있으므로 손대지 않는다).

### 2.7 전역 액션을 만들지 않았다 — 의도된 범위 결정
승격은 **특정 카드 하나**에 대한 동작이라 대상 선택 없이는 의미가 없다. 그래서 전역
액션(`actionId` + 키맵 재바인딩)을 만들지 않고 **카드 내부 컨트롤**로만 냈다 — 지시의
"internal card control use existing conventions" 에 해당한다. 따라서 `keymap.default.json`·
`app/shared/locales/*.json` 은 **변경하지 않았다**(그 파일들은 전역 액션·네이티브 메뉴 라벨만
담는다 — 확인함: 키 4개, social 관련 키 0개). ko/en 은 화면에 **두 언어를 함께** 렌더한다.

---

## 3. 사용자가 보는 것

카드에 **`📤 이 초안을 게시하기 / Publish this draft`** 버튼이 생긴다. 누르면 확인 화면이 열린다:

```
⚠ 정말 게시할까요? / Publish for real?
   목적지 / Destination   인스타그램 (Instagram)
   계정 / Account         @myaccount
   이미지 / Image         png · 412 KB · sha256 3f9a1c0b77e2…
   캡션                   (올라갈 문구 전문)
   이미지와 캡션은 다시 만들지 않습니다 — 위 내용 그대로 올라갑니다.
   되돌릴 수 없습니다. / This cannot be undone.
   [ 게시 확정 / Publish ]   [ 취소 / Cancel ]
```

- **여는 것·보는 것·취소하는 것은 게시하지 않는다.** `게시 확정` 하나만이 게시를 시작한다.
- 확인 뒤 내용이 바뀌면 화면이 **스스로 닫힌다**(렌더러가 캡션·계정·플랫폼·이미지 불일치를 감지).
  화면이 거짓말을 하지 않게 하는 것이 목적이다.
- 승격된 작업은 메타 줄에 `· 초안→게시 승격됨 / promoted`, 지난 기록은 `이전 기록 N건` 으로 보인다.

---

## 4. 코드 변경

| 파일 | 무엇 |
|---|---|
| `app/main/features/ai/social-workflow.ts` | 승격 코어 — `PromotionPlan`/`PriorReceipt` 모델, `preparePromotion`/`confirmPromotion`/`cancelPromotion`, `evaluatePromotion`(거부 20경로), `promotionRevision`/`describePromotionDrift`, `effectivePublishMode`, 되돌리기, 복원(`promotedAt`·`priorReceipts`) |
| `app/shared/ipc-channels.ts` | `ai:social-promote-{prepare,confirm,cancel}` |
| `app/main/ipc/ai.ts` | 세 핸들러(전부 `isTrustedSender`) |
| `app/preload/chrome.ts` | `socialPromote{Prepare,Confirm,Cancel}` + `AiPromotionPlan` 타입 · 워크플로에 `promotedAt`/`priorReceipts` |
| `app/renderer/components/AiSocialPanel.tsx` | 승격 버튼 · 확정 패널 · 지난 기록 접기 · 낡은 패널 자동 닫기 |
| `app/renderer/styles.css` | `.ai-social-promote*` · `.ai-social-prior*` · `.ai-social-en*` (디자인 토큰만) |
| `build/verify-draft-promotion.mjs` | **신규** 순수 게이트 하네스(quick+full 등록) |
| `build/verify-draft-promotion-cdp.mjs` | **신규** 실제 앱 + 실제 UI 클릭 e2e |
| `build/verify-all.mjs` | 순수 하네스 등록 |
| `docs/QUICKSTART.md` | 사용자 안내 절 추가 |

---

## 5. 검증

### 5.1 마감 게이트 — `npm run verify` **17/17 PASS · 59s**

| 단계 | 상태 | 상세 |
|---|---|---|
| typecheck (main·preload·renderer) | ✅ | 무경고 |
| build · package(win --dir) | ✅ | 외피 gzip 115.96 KB(예산 500 KB 의 23%) |
| smoke | ✅ | **16/16** |
| **draft-promotion**(신규) | ✅ | 순수 게이트 |
| korean-regex · editor-text · engage-ledger · auto-publish · post-time | ✅ | 회귀 |
| persistence-boundary 27 · publish-evidence 8 · artifacts · agent-gate 8 · intent-routing 8 · ai-providers 4 · ai-connect 9 | ✅ | 회귀 |

### 5.2 승격 게이트(순수) — **80 PASS / 0 FAIL** · `build/verify-draft-promotion.mjs`
앱 없이 1초. quick+full 양쪽 등록. 거부 20경로 각각에 대해 **거부 + 초안 보존**을 함께 본다.

**음성 대조 3회**(검사가 실제로 검출력이 있는지 — 전부 확인 후 원복·재검증):
- 계정 검사 + 바인딩 지문(캡션·계정) 무력화 → **7건 FAIL**, 그중 2건은 **바뀐 캡션으로 실제 게시가 나가는 것**을 잡음.
- 되돌리기(`onAbort`) 제거 → **4건 FAIL**(완료된 초안이 'failed' 로 굳고 다시 올릴 수 없게 됨).
- 확정 즉시 디스크에 승격 기록(옛 동작) 재현 → **1건 FAIL**(H2 회귀 검사가 실제로 잡는다).

### 5.3 승격 e2e — **35 PASS / 0 FAIL / 0 SKIP** · `build/verify-draft-promotion-cdp.mjs`
**모델: 가짜 LLM 각본(결정론) · 실제 구독 모델 아님.** 단 **작업 런타임·저장소·게시 게이트·UI 는
진짜 프로덕션 코드**이고, 클릭은 실제 DOM 클릭 → 신뢰 IPC 다. 게시 대상은
**로컬 HTTPS 픽스처**(`www.instagram.com` → 127.0.0.1, `--host-resolver-rules`) — 외부 접속 0줄.
격리 프로필(`--user-data-dir`)만 쓰고 사용자 실제 프로필·계정에는 접근하지 않는다. 부팅 3회(강제 종료 2회 포함).

| 요구 | 시나리오 | 실제 숫자 |
|---|---|---|
| 재생성 없음 | DP1 | 픽스처 수신 sha256 `57b2aa02…` = 시드 산출물 sha256 **일치** · `artifactId` `art_dp1`→`art_dp1` · `genTaskId` 불변 · 캡션 문자열 일치 |
| 취소는 무해 | DP2 | publishes 0→0 · `promotedAt` 없음 · 새 게시 작업 없음 · 워크플로 동일 |
| 계정 없음 거부 | DP3 | prepare 거부(ko+en) · 직접 confirm 도 거부 · 초안 보존 |
| **확정하면 정확히 1건** | DP4 | publishes **0→1** |
| 연타·재전송 ≤ 1건 | DP5 | 연타 후 0→1 · 재전송 prepare/confirm 모두 거부 |
| 캡션 변경 → 옛 확인 무효 | DP6 | 거부 사유에 "캡션/caption" 명시 · publishes 0→0 |
| 계정 변경 → 옛 확인 무효 | DP6-ACC | 거부 사유에 "계정/account" 명시 · publishes 0→0 |
| 확정 전 재시작 | DP7 / DP7-RESUME | 디스크에 `promotedAt` 없음 · 재시작 후 옛 토큰 거부 · 초안 온전 · publishes 0 |
| 발송 후 재시작 | DP8 | 서버 1건 기록·클라이언트 미수신 상태에서 강제 종료 → 재시작 후 불확실 표시, 중복 없음 |
| 게시 중·불확실 거부 | DP9-STAGE / DP9-UNCERTAIN | UI 에 버튼 **없음** + IPC 직접 호출도 거부 |
| 완료된 초안 승격 | DP10 | publishes 0→1 · **옛 draft 영수증 `priorReceipts` 보존** · 새 `receipt.status=verified` |
| 산출물 소실 거부 | DP11 | 명확한 사유로 거부 · 캡션·stage 보존 · publishes 0 |

**같은 실행 안의 대조**: `DP2(취소) delta=0` vs `DP4(확정) delta=1` — 검사가 실제로 차이를 구분한다(하네스가 스스로 출력).

### 5.4 코드 검토(opus)가 잡아 고친 것
| 등급 | 무엇 | 조치 |
|---|---|---|
| 높음 | 확정 후 탭 준비 실패가 **조용히 되돌아가** 화면에 아무 흔적이 없었다 | `failPromotion` 이 사유를 `recovery` 로 남긴다 |
| 높음 | **승격 도중 크래시 시 완료된 초안이 영구히 `failed` 로 굳음** | 장부 이동을 **내구성 경계 직전**으로 미뤄, 준비 구간에 죽어도 초안이 그대로 복원 |
| 높음 | `publishedBeforeThisBoot` 가 결론 후에도 남아 승격이 결정론적으로 실패 | 확정 시 + `completed`/`failed`/`cancelled` 에서 정리 |
| 보통 | 되돌리기가 **사용자의 취소를 되살림** | `cancelled` 면 승인만 거두고 단계는 손대지 않음 |
| 보통 | 확정 화면 캡션이 **실제 게시물과 다름**(해시태그 누락) | `tags` 를 plan·화면·바인딩 지문에 포함 |
| 보통 | 승격 실패 후 `priorReceipts` 가 화면에서 사라짐 | `done` 밖으로 빼서 항상 렌더 |
| 사소 | 소스에 **NUL 바이트** → git·grep 이 파일을 바이너리 취급 | 구분자를 `JSON.stringify` 로 |
| 사소 | prune 시 티켓 누수 / 가드 비대칭 / sha 기록값 비교 / 손상 기록의 1970년 표시 | 전부 반영(확정 시 **실제 파일 바이트 재해싱**) |

### 5.5 하네스 자신의 결함 3건(제품 아님) — 진단하고 고쳤다
1. **각본이 위저드 단계를 하나 적게** 밟아 문구 칸에 닿지 못함(픽스처는 `다음` 3회).
2. **산출물 id 를 시드 값으로 하드코딩** — 앱은 게시 작업 폴더로 복사하며 **새 id** 를 부여하고
   지시문에 치환한다. 앱이 `"art_dp1 는 없습니다. 쓸 수 있는 id: art_8eac…"` 로 **정확히 거부**한 것을
   제품 실패로 오해할 뻔했다 → 각본이 지시문에서 id 를 읽도록 수정. **이것이 DP1·DP4 실패의 진짜 원인.**
3. **강제 종료 뒤 포트 대기가 없어** 3번째 부팅이 90초 타임아웃으로 무너짐 → `boot()` 전제로 승격.

재발 방지: 각본이 라벨을 못 찾으면 **조용히 `done` 을 내보내지 않고** 결함으로 집계·출력하고,
매 호출의 관찰 전문을 `observations.log` 에 남긴다(이번 진단에 실제로 필요했다).

### 5.6 철회한 주장 — 정직하게 남긴다
진단 도중 **"`DOM.setFileInputFiles` 가 `change` 를 쏘지 않는 제품 결함"** 이라고 판단해 이벤트
발송 코드를 넣었다. 그러나 **음성 대조 결과 그 코드를 빼도 게시가 정상으로 1건 도착**했다 —
이 Chromium(148)에서는 `setFileInputFiles` 가 이미 `change` 를 발생시킨다. **내 판단이 틀렸다.**
불필요한 중복 발송은 change 를 세는 사이트에서 같은 업로드를 두 번 처리하게 만들 수 있으므로
**되돌렸다.** 다만 같은 자리에서 확인한 **"정말 붙었는지"(files.length) 읽기 검사**는 부작용이 없고
"무검증 성공" 을 막아 주므로 남겼다.

### 5.7 산출물
| 무엇 | 값 |
|---|---|
| 버전 | `0.2.0-rc.14` (Electron 42.11.3 · Chromium 148) |
| 설치파일 | `dist\ezBrowser-0.2.0-rc.14-win-x64.exe` |
| 크기 | 121,932,992 바이트 |
| SHA256 | `ddc43a2b8b37cc92bd92a1b6f939ed9217b12d7b9acd3187f089d6f7411116ca` |
| 만든 시각 | 2026-09-19 22:26 (KST) |
| 배포 | **하지 않음** — `--publish never`. GitHub 최신 릴리스는 조회 결과 여전히 `0.1.0` |
| 서명 | 없음(미서명) |

---

## 6. 남은 것 · 이번 범위 밖

### 이번 범위에서 의도적으로 하지 않은 것
- **전역 액션(actionId·키맵 재바인딩)을 만들지 않았다.** 승격은 특정 카드 하나에 대한 동작이라
  대상 선택 없이는 의미가 없다 — 지시의 "internal card control" 에 해당한다. 따라서
  `keymap.default.json`·`app/shared/locales/*.json` 은 **변경하지 않았다**(그 파일들은 전역 액션·
  네이티브 메뉴 라벨만 담는다 — 확인함: 키 4개, social 관련 0개). ko/en 은 화면에 함께 렌더한다.
- 승격 실패가 **탭 이동 실패**로 끝난 경우, 확인 단계 초안은 `review` 로 되돌아가지만 이는
  기존 일반 게시 경로와 같은 동작이다(새 상태를 발명하지 않았다).

### 이월된 제한(이번 라운드가 만든 것이 아니다)
- **코드 서명 인증서(.pfx) 없음** — rc.14 미서명, 첫 실행 시 SmartScreen 경고.
- **rc.14 설치파일의 설치→부팅→제거 미검증** — 이 PC 에 사용자 실설치본이 가동 중이라
  `verify-install` 이 스스로 BLOCKED 한다. **우회하지 않았다**(다른 PC/VM 필요).
  이번 검증은 전부 `dist/win-unpacked` 직접 실행이다.
- **실제 인스타그램·유튜브·틱톡에서 미검증** — 실계정 로그인·실제 게시가 필요해 자율 범위 밖.
  모든 게시 검증은 로컬 HTTPS 픽스처다.
- **실제 구독 모델로 승격 e2e 를 돌리지 않았다** — 결정론 확보를 위해 가짜 LLM 각본을 썼다.


---

## 7. 개입 기록 (계획을 바꾼 지점)

1. **하네스 작업자가 결과를 내지 못하고 두 번 종료** — 게다가 첫 실행은 **낡은 패키지**(rc.13,
   승격 코드 없음)를 쟀다. 재패키징 후 재지시했으나 두 번째도 실행을 남긴 채 멈춰,
   **하네스 파일 소유를 넘겨받아 내가 직접 진단·수정**했다(위 5.5 의 3건). 그 과정에서
   관찰 로그 계측을 넣어 "제품이 거부한 것"과 "각본이 못 몬 것"을 갈라냈다.
2. **`orchestrator.py` 가 이 설치본에 없다** — 정책이 지시하는 `board update`/`note`/
   `complete record` CLI 를 쓸 수 없었다. 우회하지 않고 같은 스키마로만 동작하는 최소 도구
   (`.auto-dev/board-card.py`)를 두고, 구조화 완료 기록은
   `.auto-dev/completions/run-20260919T121840Z-b597cd.json` 에 직접 썼다.
   `efficiency.jsonl` 은 런처가 실행 종료 시 자동 기록하는 원장이라 손대지 않았다.
3. **내 진단이 한 번 틀렸다** — 5.6 참고. 음성 대조로 반증돼 해당 변경을 되돌렸다.
