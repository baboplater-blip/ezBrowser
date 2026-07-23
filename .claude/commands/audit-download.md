---
description: 다운로드 다사이트 매트릭스 — 어떤 사이트든 받히는지 시나리오별 검증
---

# /audit-download

"어떤 사이트든 경우의 수 무관하게 다운로드된다"(묶음 Y)를 시나리오별로 검증한다.
봇 차단 사이트는 GUI 로 직접 확인하고, URL 단위 판정은 `probe-download` CLI 로 즉시 가린다.

## 엔진 라우팅 (현재 구현)

| 입력 | 감지 | 다운로드 경로 |
|---|---|---|
| `.mp4`/`.webm`/`.mkv`/`.mov` (URL 또는 `video/*`) | mp4/video 후보 | `downloadMedia` → 탭 세션+Referer 직접, Range 면 가속 |
| **octet-stream ≥3MB** (토큰 CDN mp4) | mp4(octet) 후보 | `downloadMedia` → 직접/가속 |
| `.m3u8` (HLS, `application/x-mpegurl`) | hls 후보 | **네이티브 HLS 다운로더**(세그먼트 병합·AES-128 복호화) → 실패 시 yt-dlp |
| `.mpd` (DASH) | dash 후보 | yt-dlp |
| YouTube·Vimeo 등 지원 호스트 | site 후보 | yt-dlp (페이지 URL) |
| 받으려는 URL 이 `text/html` | — | "미디어 아님" 판정 → yt-dlp 폴백 (HTML 파일 저장 차단) |

핵심 불변식:
- **다운로드는 탭 partition 세션으로** 실행 → 쿠키 일치(쿠키 게이트 CDN).
- **모든 미디어 요청에 Referer** → 핫링크 CDN 의 403/HTML 차단 회피.
- **다운로드 전 content-type probe** → HTML 이면 받지 않고 yt-dlp 로 폴백.
- 이어받기 시 **headers·partition 복원**(가속 HTTP).

## URL 단위 진단 — probe-download CLI

```
node build/probe-download.mjs <미디어URL> [referer]
```

앱의 `probeUrl`(HEAD→GET 0-0 폴백) + 미디어 분류를 독립 Node 로 재현한다. 출력:
- status / content-type / size / ranges
- 판정: 직접(가속)·HLS·DASH·yt-dlp 폴백·HTML(실패)

활용 예 (실측):
- `… referer https://07.avsee.ru/` → `200 octet-stream 2.6GB ranges:yes` → ✔ 가속 직접
- referer 없이 같은 URL → `403 text/html` → ✖ HTML, referer 누락이 원인

## 시나리오 매트릭스 (GUI 검증)

각 시나리오에서 ① 영상 감지(툴바 ▶ 뱃지/오버레이), ② 다운로드 시작, ③ **받은 파일이 실제 재생**되는지 확인.

| # | 시나리오 | 기대 |
|---|---|---|
| 1 | progressive mp4 (확장자 명시) | 직접/가속, `.mp4` 재생 |
| 2 | **토큰 CDN mp4** (octet-stream, 핫링크) | Referer 로 200, 가속, `.mp4` 재생 (HTML 아님) |
| 3 | **HLS(.m3u8)** 평문 TS | 네이티브 HLS → `.ts` 재생 |
| 4 | **HLS fMP4**(#EXT-X-MAP) | 네이티브 HLS → `.mp4` 재생 |
| 5 | **HLS AES-128** 암호화 | 키 받아 복호화 → 재생 |
| 6 | HLS master(다해상도) | 최고 화질 variant 선택 |
| 7 | DASH(.mpd) | yt-dlp |
| 8 | YouTube 등 지원 호스트 | yt-dlp, 페이지 URL |
| 9 | blob:(MSE) src | 후보 없으면 페이지 URL→yt-dlp (※ 다음 라운드: MSE 캡처) |
| 10 | 쿠키 게이트(로그인 후 영상) | 탭 세션 쿠키로 받힘 |
| 11 | 닫힌 탭에서 이어받기 | partition·Referer 복원 (가속 HTTP) |

## 절차

1. 변경 빌드 실행 (`npm run build` → 패키지 또는 dev).
2. 위 매트릭스의 대표 사이트를 열고 1~11 확인. 막히면 콘솔이 아니라 **해당 미디어 URL 을 `probe-download` 로** 진단(메인 로그는 페이지 콘솔에 안 보임).
3. 회귀 발견 시: octet-stream 분류(`isSegment`)·Referer 첨부(`startManagedHttpDownload`)·세션 일치(`will-download` 모든 세션)·HLS 파서(`hls.ts`) 순으로 점검.

## 이어받기 / MSE (묶음 AA)

- **HLS 이어받기**: 네이티브 HLS 도 종료 후 같은 파일에 이어받음. doneSegments·doneBytes 영속 →
  재실행 시 `doneBytes` 로 truncate 후 append(중복/누락 방지). 파일이 기대보다 작으면 처음부터.
- **blob/MSE 스니핑**: 세그먼트만 흐르고 매니페스트 후보가 없으면(MSE blob 재생) 페이지 URL 을
  `site` 후보로 띄워 yt-dlp 로 받게 함. 이후 실제 후보 등장 시 합성 site 후보 자동 제거.

## 알려진 제한 (다음 라운드)

- DASH 네이티브 미구현 (yt-dlp).
- HLS live(끝없는 플레이리스트) 미지원 — VOD 만.
- MSE 의 **실제 미디어 URL 직접 캡처**는 아직 yt-dlp 경유 (세그먼트 패턴→.m3u8 역추적은 다음 라운드).
