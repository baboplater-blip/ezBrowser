---
name: torrent-webtorrent
description: WebTorrent 으로 magnet/.torrent 다운로드. lazy init, 동시 5 토렌트·55 연결, DHT opt-in, magnet 프로토콜 등록, 사이드패널 진행률.
---

# Torrent (WebTorrent)

## 채택

[`webtorrent`](https://github.com/webtorrent/webtorrent) — 순수 JS BitTorrent (Node + WebRTC). 네이티브 컴파일 없음. Electron 메인 프로세스에서 lazy 로드.

```bash
npm i webtorrent
```

옵션 의존성으로 두고 첫 토렌트 추가 직전에 dynamic import:

```ts
let client: any = null
async function ensureClient() {
  if (client) return client
  const mod = require((['webtorrent'])[0]!)
  const WebTorrent = mod.default ?? mod
  client = new WebTorrent({ maxConns: 55, dht: getSetting('downloads').torrentDht })
  return client
}
```

## 추가 흐름

```ts
async function addTorrent(uri: string): Promise<string> {
  const wt = await ensureClient()
  const id = uuid()
  const savePath = path.join(downloadsDir(), 'torrents', id)
  await fs.mkdir(savePath, { recursive: true })

  const torrent = wt.add(uri, { path: savePath })

  torrent.on('metadata', () => {
    insertOrUpdate(id, {
      kind: 'torrent',
      filename: torrent.name,
      totalBytes: torrent.length,
      savePath,
      url: uri,
      state: 'active',
    })
    broadcastFiles(id, torrent.files)
  })

  torrent.on('download', throttled(() => broadcastProgress(id, torrent), 1000))
  torrent.on('upload',   throttled(() => broadcastProgress(id, torrent), 2000))
  torrent.on('done',     () => markDone(id, torrent))
  torrent.on('error',    (err: Error) => markError(id, err.message))

  return id
}
```

`throttled` 는 1초당 1회 IPC broadcast — 외피 reflow 비용 절약.

## 진행 정보

```ts
function summary(t: any) {
  return {
    downloaded: t.downloaded,
    uploaded: t.uploaded,
    downloadSpeed: t.downloadSpeed,
    uploadSpeed: t.uploadSpeed,
    progress: t.progress,
    timeRemaining: t.timeRemaining,
    peers: t.numPeers,
    ratio: t.ratio,
  }
}
```

## 파일 선택

다중 파일 토렌트에서 사용자가 받을 파일만 선택:

```ts
torrent.files.forEach((f: any, i: number) => {
  if (selectedIndices.includes(i)) f.select()
  else f.deselect()
})
```

기본은 모두 선택. 외피 토렌트 행을 펼치면 파일 트리 노출.

## 제어

- pause: `torrent.pause()` — 새 데이터 받지 않지만 시드는 유지
- resume: `torrent.resume()`
- remove: `wt.remove(torrent.infoHash, { destroyStore: deleteFiles })`
- listSeeding: `wt.torrents.filter(t => t.done)`

## magnet 프로토콜 핸들러

```ts
app.setAsDefaultProtocolClient('magnet')

// macOS
app.on('open-url', (e, url) => {
  e.preventDefault()
  if (url.startsWith('magnet:?')) void addTorrent(url)
})

// Windows/Linux 두 번째 인스턴스로 들어옴
app.on('second-instance', (_e, argv) => {
  const mag = argv.find((a) => a.startsWith('magnet:?'))
  if (mag) void addTorrent(mag)
})

// 페이지 내 magnet 링크 클릭
chrome.webContents.on('will-navigate', (e, url) => {
  if (url.startsWith('magnet:?')) {
    e.preventDefault()
    void addTorrent(url)
  }
})
```

## .torrent 파일 처리

탭 응답이 `application/x-bittorrent` 또는 URL 이 `.torrent` 로 끝나면 다운로드 가로채기:

```ts
session.defaultSession.webRequest.onResponseStarted((details) => {
  const ct = details.responseHeaders?.['content-type']?.[0] ?? ''
  if (ct.includes('application/x-bittorrent') || details.url.endsWith('.torrent')) {
    // 일반 다운로드 대신 토렌트 추가
    fetch(details.url).then(r => r.arrayBuffer()).then(buf => addTorrent(Buffer.from(buf)))
  }
})
```

외피로 `.torrent` 드롭 시도 동일.

## 가벼움·안전

- WebTorrent 인스턴스 lazy init — 첫 토렌트 직전까지 메모리 0
- 최대 동시 토렌트 5 (`maxConns` 와 별도, 자체 큐)
- DHT 기본 OFF — 설정에서 사용자가 켤 때만
- 시크릿 모드 partition 에서는 토렌트 추가 차단 (IP 노출)
- 시드 비율 도달 시 자동 멈춤 옵션 (기본: ratio ≥ 2.0 에서 자동 stop)
- 첫 활성 시 Windows 방화벽 다이얼로그 안내 토스트

## 라이선스 안내

첫 토렌트 추가 시 한 번:
> ⚠️ 권리자 동의 또는 자유 라이선스 콘텐츠만 받으세요.

토글 불가 (법적 책임 회피).

## 절대 피할 것

- WebTorrent 부팅 시 init — 부팅 ≤ 2초 깨짐
- IPC broadcast 매 청크마다 — 1초 throttle
- 트래커 응답 무한 대기 — 30초 타임아웃, 실패 시 사용자 알림
- DHT 강제 ON — 사용자 명시 동의 (P2P 노출 인지)
- 시크릿 세션에서 토렌트 — partition.startsWith('incognito-') 시 즉시 reject
