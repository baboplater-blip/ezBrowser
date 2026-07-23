---
name: video-detect-ytdlp
description: 탭에서 동영상 미디어 감지(HLS/DASH/MP4/WebM/YouTube) + yt-dlp 통합. 후보 누적, 툴바 아이콘, 사용자 동의 후 옵션 바이너리 다운로드.
---

# Video Detect + yt-dlp

## 감지 (페이지 자동 분석)

탭마다 미디어 URL 후보 누적. `session.webRequest.onResponseStarted` 로 hook:

```ts
const VIDEO_MIME = [/^video\//, /application\/vnd\.apple\.mpegurl/, /application\/dash\+xml/]
const VIDEO_EXT  = /\.(m3u8|mpd|mp4|webm|mkv|mov|ts)(\?|$)/i

const candidatesByTab = new Map<string, MediaCandidate[]>()

session.defaultSession.webRequest.onResponseStarted((details) => {
  const tabId = tabIdOfWebContents(details.webContentsId)
  if (!tabId) return
  const ct = details.responseHeaders?.['content-type']?.[0] ?? ''
  const isMedia = VIDEO_MIME.some((re) => re.test(ct)) || VIDEO_EXT.test(details.url)
  if (!isMedia) return

  const cand: MediaCandidate = {
    url: details.url,
    mime: ct,
    kind: ct.includes('mpegurl') ? 'hls'
        : ct.includes('dash') ? 'dash'
        : ct.includes('mp4') ? 'mp4'
        : 'video',
    pageUrl: details.referrer ?? '',
    sizeHeader: Number(details.responseHeaders?.['content-length']?.[0] ?? 0),
  }
  pushCandidate(tabId, cand)
})
```

`tabIdOfWebContents` 는 `tab-service` 에서 노출. 탭 닫힘 시 후보 비움.

## YouTube 등 사이트 감지

URL 자체로 즉시 감지 (네트워크 응답 없이도 yt-dlp 가 처리 가능한 호스트):

```ts
const YT_DLP_HOSTS = [
  /youtube\.com$/, /youtu\.be$/, /vimeo\.com$/, /twitch\.tv$/,
  /soundcloud\.com$/, /bilibili\.com$/, /naver\.com$/, /tiktok\.com$/,
  /instagram\.com$/, /twitter\.com$/, /x\.com$/, /facebook\.com$/,
]

webContents.on('did-navigate', (_e, url) => {
  try {
    const host = new URL(url).hostname
    if (YT_DLP_HOSTS.some((re) => re.test(host))) {
      pushCandidate(tabId, { url, mime: '', kind: 'site', pageUrl: url, sizeHeader: 0 })
    }
  } catch { /* ignore */ }
})
```

후보 1개 이상 있으면 외피 툴바에 영상 아이콘 활성화 (`videos:available` IPC).

> ⚠️ **세션 주의**: 위 예시는 `session.defaultSession` 을 쓰지만, 실제 탭은
> `persist:default`·`persist:ws-*` partition 세션을 사용한다. 감지(`onResponseStarted`)·
> 다운로드(`will-download`·net.request)는 **모든 세션**에 걸어야 한다(회귀 #13/#14).
> `installResponseHooks`·`addSessionInitHook(attachWillDownload)` 로 모든 partition 적용.

## 범용 다운로드 엔진 (묶음 Y — "어떤 사이트든 받힘")

핵심 원리: **브라우저가 실제 스트리밍한 요청을 쿠키·Referer 포함해 재현**하고,
받으려는 게 미디어가 아니면(HTML) yt-dlp 로 폴백한다.

1. **감지 정정**: 토큰 CDN(BunnyCDN 등)이 mp4 를 `application/octet-stream` 으로 서빙 →
   `isSegment` 에서 octet-stream 을 제거하고 `.mp4/.webm/.mkv/.mov` 확장자를 우선,
   **큰 octet-stream(≥3MB)도 미디어 후보**로 인식. (안 그러면 HLS 세그먼트로 오인돼 탈락)
2. **`downloadMedia(url, pageUrl, tabId)`**: ⓐ **탭 세션**(`getWebContentsByTabId(tabId).session`,
   닫혔으면 `getTabPartition`→`session.fromPartition`)으로 받아 쿠키 일치, ⓑ 다운로드 전
   **content-type probe**(Referer 포함) → `text/html`·실패면 미디어 아님 → **yt-dlp 폴백**
   (HTML 파일 저장을 막는 핵심), ⓒ Range+대용량이면 가속, 아니면 `ses.downloadURL`.
3. **Referer 필수**: 핫링크 CDN 은 Referer 없으면 `403 text/html`(=받으면 HTML), 있으면
   `206`. 모든 미디어 요청에 `Referer: pageUrl` 첨부. (Origin 은 일부 CDN 이 CORS 거부 → 미첨부)
4. **probe**(`multi-connection.probeUrl`): HEAD → (실패·ct 없음 시) **Range GET(0-0)** 폴백으로
   content-type·전체크기(Content-Range)·Range 지원(206) 확정.
5. **이어받기**: `AccelPending` 에 `headers`(Referer)·`partition` 저장 → 재실행 시 복원.

URL 진단: `node build/probe-download.mjs <url> [referer]` 로 "받힐지/HTML/HLS/Range" 즉시 판정.
매트릭스 검증: `/audit-download`.

## 네이티브 HLS 다운로더 (`downloads/hls.ts`)

yt-dlp 없이 `.m3u8` 을 받는다 (yt-dlp 는 실패 시 폴백):
- master 면 **최고 대역폭 variant** 선택 → media 플레이리스트 파싱.
- 세그먼트를 탭 세션 쿠키+Referer 로 **제한 동시성(6) 프리페치 + 순서대로 병합**(메모리 ≈ 동시성×세그먼트).
- `#EXT-X-KEY METHOD=AES-128` → 키 받아 `aes-128-cbc` 복호화(IV = 명시값 또는 media-sequence).
- `#EXT-X-MAP`(fMP4) → init + m4s 합쳐 **`.mp4`**, 아니면 TS 합쳐 **`.ts`** (둘 다 ffmpeg 불필요).
- 한계: VOD 만(live 미지원), 이어받기 미구현, DASH 는 여전히 yt-dlp.

## 사용자 다운로드 트리거 / 라우팅

툴바 영상 아이콘 클릭 → 후보 목록. 종류별 라우팅:

- mp4/octet/video/video.src(직접): **`downloadMedia`** (직접→실패 시 yt-dlp 폴백)
- HLS(.m3u8): **`downloadStream`** → 네이티브 HLS → 실패 시 yt-dlp
- DASH(.mpd)·지원 호스트(YouTube 등): yt-dlp

## yt-dlp 통합

`yt-dlp` 는 옵션 바이너리. 첫 사용 시 사용자 동의 → GitHub Release `yt-dlp/yt-dlp` 의 OS 별 빌드 다운로드 → SHA256 검증 → `userData/binaries/yt-dlp(.exe)` 저장.

```ts
const YT_DLP_RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
const ASSETS = {
  win32:  { name: 'yt-dlp.exe',     sha256Url: null },  // checksum 별 파일
  darwin: { name: 'yt-dlp_macos',   sha256Url: null },
  linux:  { name: 'yt-dlp',         sha256Url: null },
}

async function ensureYtDlp(): Promise<string> {
  const target = path.join(app.getPath('userData'), 'binaries', resolveAssetName())
  if (existsSync(target)) return target

  // 1) 동의 다이얼로그
  const ok = await dialog.showMessageBox({
    type: 'question',
    buttons: ['받기', '취소'],
    defaultId: 0, cancelId: 1,
    title: 'yt-dlp 가 필요합니다',
    message: '동영상 다운로드를 위해 yt-dlp(GPL) 를 다운로드합니다.',
    detail: '약 15 MB. GitHub yt-dlp/yt-dlp 공식 릴리즈에서 받습니다.',
  })
  if (ok.response !== 0) throw new Error('user cancelled')

  // 2) 다운로드
  await mkdir(path.dirname(target), { recursive: true })
  await fetchToFile(`${YT_DLP_RELEASE}/${assetName()}`, target)
  if (process.platform !== 'win32') await fs.chmod(target, 0o755)
  return target
}
```

## 호출

```ts
async function downloadWithYtDlp(url: string, pageUrl: string, opts: { format?: string } = {}) {
  const bin = await ensureYtDlp()
  const id = uuid()
  const outDir = path.join(downloadsDir(), 'videos')
  await mkdir(outDir, { recursive: true })

  const format = opts.format ?? 'bv*+ba/best'   // 비디오+오디오 머지, 폴백 best
  const args = [
    '-f', format,
    '-o', path.join(outDir, '%(title).100B.%(ext)s'),
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--progress-template', 'PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.speed)s',
    url,
  ]

  const child = spawn(bin, args, { windowsHide: true })
  insertRow(id, { kind: 'video', url, savePath: outDir, state: 'active', sourceTabUrl: pageUrl })

  child.stdout.on('data', (b: Buffer) => {
    for (const line of b.toString('utf8').split('\n')) {
      const m = /^PROG\|(\d+)\|(\d+)\|([\d.]+)$/.exec(line)
      if (m) updateRow(id, { receivedBytes: +m[1]!, totalBytes: +m[2]!, speed: +m[3]! })
    }
  })
  child.on('exit', (code) => {
    markState(id, code === 0 ? 'done' : 'failed')
  })

  return id
}
```

## 사용자 안내

영상 다운로드 시도 → yt-dlp 없으면 다이얼로그 → 동의 + 다운로드 → 진행 자동 시작. 동의 거부 시 후보 그대로 두고 사용자에게 "yt-dlp 없이는 이 형식 못 받음" 토스트.

## 절대 피할 것

- yt-dlp 자동 동봉 (앱 패키지 비대)
- 사용자 동의 없이 외부 바이너리 실행
- spawn 출력 파싱 무한 메모리 누적 — backpressure / 줄 단위 처리
- 시크릿 세션의 페이지 URL 을 후보에 그대로 — partition 검사
- yt-dlp 의 무한 retry — 명시 `--retries 3 --fragment-retries 3`
