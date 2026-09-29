# 설계 계약 — 생성물 파이프라인 + SNS 게시 + 블로그 참여 (2026-09-18)

이 문서는 이번 라운드 작업자들이 **같은 인터페이스로** 병렬 구현하기 위한 계약이다.
여기 적힌 시그니처는 임의로 바꾸지 않는다(바꾸면 통합에서 tsc 가 깨진다).

## 왜 이 구조인가

지금 에이전트는 ① `download` 가 **백그라운드 시작만 하고 결과를 모른다**(완료·실패·타임아웃을
판정할 수 없다) ② `upload_file` 은 **사용자 지정 자료 폴더에서만** 파일을 찾는다.
그래서 "AI 로 이미지를 만들고 → 그 이미지를 SNS 에 올린다" 가 **연결되지 않는다**
(사람이 파일을 손으로 옮겨야 한다). 이 라운드는 그 사이를 잇는다.

핵심은 **작업(task)별로 격리된 산출물 저장소**다. 한 작업이 만든 파일만 그 작업이 업로드할 수 있고,
다른 작업·다른 탭·이전 실행의 파일은 닿지 않는다.

---

## 1. `app/main/features/ai/artifacts.ts` — 작업별 산출물 저장소 (담당: W1)

저장 위치: `<userData>/agent-artifacts/<taskId>/`.
`taskId` 는 영속 작업 id, 작업 없이 도는 단발 실행은 `session-<reqId>`.

```ts
export type ArtifactKind = 'image' | 'video' | 'file'

export interface ArtifactMeta {
  id: string                 // 'art_' + 12 hex
  taskId: string
  name: string               // 디스크 파일명 = id + '.' + format
  path: string               // 절대 경로
  kind: ArtifactKind
  format: string             // 'png'|'jpeg'|'webp'|'gif'|'mp4'|'bin' ...
  mime: string
  bytes: number
  sha256: string
  width?: number             // 이미지일 때만
  height?: number
  sourceUrl: string          // 원본 URL. blob:/data: 는 80자로 축약 저장
  sourcePageUrl: string
  sourceTabId: string
  sourceFrameUrl?: string
  capturedAt: number         // epoch ms
  origin: 'page-capture' | 'download-import'
  label?: string             // 사람이 읽는 설명(선택)
}

export type CaptureCode =
  | 'empty' | 'not-image' | 'too-large' | 'timeout' | 'cancelled'
  | 'fetch-failed' | 'scope' | 'io'

export interface CaptureResult { ok: boolean; meta?: ArtifactMeta; error?: string; code?: CaptureCode }

export function artifactsRoot(): string
export function taskArtifactDir(taskId: string): string          // 없으면 만든다
export function listArtifacts(taskId: string): ArtifactMeta[]    // 최신순
export function getArtifact(taskId: string, id: string): ArtifactMeta | null
/** 업로드용 실제 경로. realpath 가 그 작업 폴더 안일 때만 반환(아니면 null). */
export function resolveArtifactPath(taskId: string, id: string): string | null
export function deleteTaskArtifacts(taskId: string): void        // 자동 호출 금지 — 사용자 명시 정리용

/** 바이트를 검증하고 저장한다. 이미지면 형식·치수까지 확인. */
export function saveArtifactBytes(args: {
  taskId: string
  data: Buffer
  sourceUrl: string
  sourcePageUrl: string
  sourceTabId: string
  sourceFrameUrl?: string
  expect?: 'image' | 'any'      // 기본 'image'
  label?: string
  origin?: ArtifactMeta['origin']
}): CaptureResult

/** 다운로드 엔진이 저장한 파일을 작업 저장소로 **복사**(원본은 지우지 않는다). */
export function importDownloadedFile(args: {
  taskId: string
  filePath: string
  sourceUrl: string
  sourcePageUrl: string
  sourceTabId: string
  expect?: 'image' | 'any'
  label?: string
}): CaptureResult

export interface ImageProbe {
  ok: boolean
  format?: 'png' | 'jpeg' | 'webp' | 'gif'
  mime?: string
  width?: number
  height?: number
  reason?: string             // 실패 사유(한국어)
}
/** 매직 바이트로 실제 형식·치수를 읽는다. 확장자·Content-Type 을 믿지 않는다. */
export function probeImage(buf: Buffer): ImageProbe
```

### 검증 규칙 (요구 D 가 이걸 시험한다)
- 0 바이트 → `empty`.
- `<!DOCTYPE` / `<html` / `<?xml` 로 시작(앞 공백·BOM 무시, 대소문자 무관) → `not-image`
  ("HTML 위장" — 로그인 리다이렉트·에러 페이지가 이미지인 척 오는 실제 사례).
- PNG `89 50 4E 47 0D 0A 1A 0A` → IHDR 에서 폭·높이(BE).
- JPEG `FF D8 FF` → SOFn(C0~CF, C4·C8·CC 제외) 세그먼트에서 높이·폭(BE).
- WebP `RIFF????WEBP` → VP8 / VP8L / VP8X 각각의 치수.
- GIF `GIF87a`/`GIF89a` → LE 치수.
- 위 어느 것도 아니고 `expect:'image'` → `not-image`.
- 50MB 초과 → `too-large`.
- 치수가 0 이거나 읽히지 않으면 → `not-image`(디코딩 실패로 본다).

---

## 2. `page-actions.ts` 추가분 (담당: 팀장)

```ts
export interface PageImage {
  src: string; width: number; height: number; alt: string
  frameUrl?: string; area: number; kind: 'img' | 'canvas' | 'bg'
}
/** 현재 페이지(허용된 프레임 포함)의 이미지 목록. 면적 큰 순. */
export async function listPageImages(wc, allowedHosts?: string[]): Promise<PageImage[]>
/** blob:/data: 를 페이지 컨텍스트에서 읽어 base64 로. (메인은 blob 을 못 읽는다) */
export async function readUrlInPage(wc, url: string, maxBytes: number): Promise<{ ok: boolean; base64?: string; mime?: string; error?: string }>
```

## 3. 에이전트 액션 (담당: 팀장)

| 액션 | 뜻 |
|---|---|
| `mark_baseline` | 지금 페이지의 이미지 목록을 **기준선**으로 기록. 생성 버튼을 누르기 **전에** 부른다. |
| `capture_image` | 기준선에 없던 **새 이미지**만 골라 작업 저장소에 저장. 후보가 여럿이면 목록을 돌려주고 `index` 를 요구(불명확하면 고르게 한다). |
| `upload_file` | `artifact` 인자 추가 — 산출물 id 로 바로 첨부(폴더에 손으로 옮길 필요 없음). |
| `download` | 완료/실패/타임아웃까지 **기다려** 결과를 돌려주고, 끝난 파일을 작업 저장소로 가져온다. |

기준선 자동 기록: 작업 안에서 `navigate`/`open_tab` 이 일어나면 그 탭의 기준선을 자동으로 새로 잡는다
(모델이 `mark_baseline` 을 잊어도 "이동 후 새로 생긴 이미지"는 판별된다).

거부 규칙(요구 A):
- 면적이 작은 것(가로·세로 어느 쪽이든 **256px 미만**)은 후보에서 제외 — 로고·아이콘·아바타·썸네일.
- 기준선에 있던 URL 제외 — 광고·기존 이미지·이전 작업 결과.
- **다른 탭**의 이미지는 보지 않는다(현재 조작 탭만).
- 허용 사이트 밖 프레임은 애초에 관찰하지 않는다(frames.ts 규칙 그대로).
- 일시정지·취소 상태면 **파일을 만들지도 넘기지도 않는다**.

## 4. `social-workflow.ts` — 생성→캡션→게시 (담당: W3)
## 5. `blog-engage.ts` — 관심 블로그 댓글·좋아요 (담당: W4)
## 6. 픽스처·하네스 (담당: W2)

각 담당 브리핑에 상세 — 이 문서는 공용 계약(1·2·3)만 고정한다.
