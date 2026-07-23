import { app, dialog, shell } from 'electron'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { getSetting } from '../../storage/settings'
import {
  defaultDownloadDir, downloadEvents, getExternalDownload,
  nextDownloadId, registerExternalDownload, removeExternalDownload,
  updateExternalDownload,
} from '../downloads'
import { onResponseStarted } from '../response-hooks'
import type { DownloadItem } from '../../../shared/types'

interface WebTorrentInstance {
  add: (uri: string | Buffer, opts: { path: string }) => WebTorrentHandle
  remove: (infoHash: string, opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void) => void
  destroy: () => void
  torrents: WebTorrentHandle[]
}

interface WebTorrentHandle {
  infoHash: string
  name: string
  length: number
  downloaded: number
  uploaded: number
  downloadSpeed: number
  uploadSpeed: number
  progress: number
  numPeers: number
  ratio: number
  done: boolean
  files: Array<{ name: string; length: number; select: () => void; deselect: () => void }>
  pause: () => void
  resume: () => void
  on: (event: string, cb: (...args: unknown[]) => void) => void
}

let client: WebTorrentInstance | null = null
const handles = new Map<string, WebTorrentHandle>()
const consentShown = { value: false }
let licenseAcknowledged = false

async function loadWebTorrent(): Promise<WebTorrentInstance | null> {
  if (client) return client
  try {
    const name = ['webtorrent'][0]!
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(name)
    const WebTorrent = (mod.default ?? mod) as new (opts?: unknown) => WebTorrentInstance
    client = new WebTorrent({
      maxConns: 55,
      dht: false,
    })
    return client
  } catch (err) {
    console.warn('[torrent] webtorrent not installed', err)
    return null
  }
}

async function showLicenseDialog(): Promise<boolean> {
  if (licenseAcknowledged) return true
  const ok = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['동의하고 받기', '취소'],
    defaultId: 0, cancelId: 1,
    title: '토렌트 다운로드 안내',
    message: '저작권을 준수해 주세요.',
    detail:
      '권리자 동의가 있거나 자유 라이선스 콘텐츠(Creative Commons, public domain, Linux ISO 등) 에만 사용하세요. 책임은 사용자에게 있습니다.\n\n' +
      '계속하면 WebTorrent(분산 BitTorrent) 가 활성화됩니다. 첫 가동 시 Windows 방화벽이 권한을 물어볼 수 있습니다.',
  })
  if (ok.response !== 0) return false
  licenseAcknowledged = true
  return true
}

function throttle<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let last = 0
  let timer: NodeJS.Timeout | null = null
  return ((...args: unknown[]) => {
    const now = Date.now()
    if (now - last >= ms) {
      last = now
      fn(...args)
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now()
        timer = null
        fn(...args)
      }, ms - (now - last))
    }
  }) as T
}

function snapshot(torrent: WebTorrentHandle): Partial<DownloadItem> {
  return {
    receivedBytes: torrent.downloaded,
    totalBytes: torrent.length,
    speed: torrent.downloadSpeed,
    state: torrent.done ? 'seeding' : torrent.downloaded > 0 ? 'active' : 'metadata',
    torrent: {
      infoHash: torrent.infoHash,
      peers: torrent.numPeers,
      uploadedBytes: torrent.uploaded,
      uploadSpeed: torrent.uploadSpeed,
      ratio: torrent.ratio,
      files: torrent.files.map((f) => ({ name: f.name, length: f.length, selected: true })),
    },
  }
}

export async function addTorrent(uri: string | Buffer, opts?: { silent?: boolean }): Promise<string | null> {
  if (!opts?.silent) {
    const ok = await showLicenseDialog()
    if (!ok) return null
  }

  const wt = await loadWebTorrent()
  if (!wt) {
    if (!consentShown.value) {
      consentShown.value = true
      void dialog.showMessageBox({
        type: 'info',
        buttons: ['확인'],
        title: '토렌트 모듈 미설치',
        message: 'webtorrent 패키지가 설치되어 있지 않습니다.',
        detail: '"npm install webtorrent" 로 설치 후 다시 시도하세요. (optional dependency)',
      })
    }
    return null
  }

  const id = nextDownloadId('tor')
  const savePath = path.join(defaultDownloadDir('torrents'), id)
  await mkdir(savePath, { recursive: true })

  const displayUri = typeof uri === 'string' ? uri : 'torrent-file'

  const meta: DownloadItem = {
    id,
    kind: 'torrent',
    url: displayUri,
    filename: '메타데이터 로드 중…',
    savePath,
    totalBytes: 0,
    receivedBytes: 0,
    state: 'metadata',
    startedAt: Date.now(),
    torrent: {
      peers: 0,
      uploadedBytes: 0,
      uploadSpeed: 0,
      ratio: 0,
      files: [],
    },
  }
  registerExternalDownload(meta)

  try {
    const torrent = wt.add(uri, { path: savePath })

    torrent.on('metadata', () => {
      updateExternalDownload(id, {
        filename: torrent.name,
        totalBytes: torrent.length,
        ...snapshot(torrent),
      })
    })

    const broadcastProgress = throttle(() => {
      updateExternalDownload(id, snapshot(torrent))
    }, 1000)
    torrent.on('download', broadcastProgress as (...args: unknown[]) => void)
    torrent.on('upload', broadcastProgress as (...args: unknown[]) => void)

    torrent.on('done', () => {
      updateExternalDownload(id, {
        completedAt: Date.now(),
        ...snapshot(torrent),
        state: 'seeding',
      })
    })

    torrent.on('error', (err) => {
      const errorMsg = err instanceof Error ? err.message : String(err)
      updateExternalDownload(id, { state: 'failed', error: errorMsg })
    })

    handles.set(id, torrent)
  } catch (err) {
    updateExternalDownload(id, { state: 'failed', error: (err as Error).message })
  }

  return id
}

export function pauseTorrent(id: string): void {
  const t = handles.get(id)
  if (t) { t.pause(); updateExternalDownload(id, { state: 'paused' }) }
}

export function resumeTorrent(id: string): void {
  const t = handles.get(id)
  if (t) { t.resume(); updateExternalDownload(id, { state: 'active' }) }
}

export function removeTorrent(id: string, deleteFiles = false): void {
  const t = handles.get(id)
  if (!t) { removeExternalDownload(id); return }
  if (client) {
    client.remove(t.infoHash, { destroyStore: deleteFiles }, () => {
      handles.delete(id)
      removeExternalDownload(id)
      if (deleteFiles) {
        const meta = getExternalDownload(id)
        if (meta) shell.trashItem(meta.savePath).catch(() => undefined)
      }
    })
  }
}

export function setTorrentFiles(id: string, selectedIndices: number[]): void {
  const t = handles.get(id)
  if (!t) return
  t.files.forEach((f, i) => {
    if (selectedIndices.includes(i)) f.select()
    else f.deselect()
  })
}

export function initTorrentBridge(): void {
  // downloads.ts 에서 외부 다운로드 제어 신호 받기
  downloadEvents.on('pause-external', (id: string) => pauseTorrent(id))
  downloadEvents.on('resume-external', (id: string) => resumeTorrent(id))
  downloadEvents.on('cancel-external', (id: string) => removeTorrent(id, false))
}

export function initMagnetHandler(): void {
  // 시스템에 magnet: 핸들러로 등록
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('magnet', process.execPath, [path.resolve(process.argv[1] ?? '')])
    } else {
      app.setAsDefaultProtocolClient('magnet')
    }
  } catch (err) {
    console.warn('[torrent] could not register magnet handler', err)
  }

  app.on('open-url', (e, url) => {
    if (url.startsWith('magnet:?')) {
      e.preventDefault()
      void addTorrent(url)
    }
  })

  app.on('second-instance', (_e, argv) => {
    const mag = argv.find((a) => a.startsWith('magnet:?'))
    if (mag) void addTorrent(mag)
  })

  // 첫 실행 시 argv 에 magnet 포함 가능
  const argMagnet = process.argv.find((a) => a.startsWith('magnet:?'))
  if (argMagnet) {
    app.whenReady().then(() => { void addTorrent(argMagnet) })
  }
}

export function initTorrentResponseHook(): void {
  onResponseStarted((details) => {
    try {
      const ct = details.responseHeaders?.['content-type']?.[0]?.toLowerCase() ?? ''
      const url = details.url
      const isTorrent = ct.includes('application/x-bittorrent') || /\.torrent(\?|$)/i.test(url)
      if (!isTorrent) return
      if (url.startsWith('magnet:')) return
      void fetchAndAdd(url)
    } catch {
      /* ignore */
    }
  })
}

async function fetchAndAdd(url: string): Promise<void> {
  try {
    const resp = await fetch(url)
    if (!resp.ok) return
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length > 5 * 1024 * 1024) return
    await addTorrent(buf)
  } catch (err) {
    console.warn('[torrent] fetch .torrent failed', err)
  }
}

export function isTorrentDhtEnabled(): boolean {
  const downloadsSetting = getSetting('downloads') as { torrentDht?: boolean }
  return downloadsSetting.torrentDht ?? false
}
