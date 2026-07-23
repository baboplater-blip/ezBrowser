import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { getSetting, setNestedSetting } from '../../storage/settings'
import { getAllWindows } from '../../windows/window-service'

export type UpdateState =
  | 'idle' | 'checking' | 'available' | 'not-available'
  | 'downloading' | 'downloaded' | 'error' | 'disabled'

export interface UpdateStatus {
  state: UpdateState
  current: string
  available?: string
  releaseNotes?: string
  progress?: number   // 0..1
  error?: string
  lastCheckedAt?: number
}

const status: UpdateStatus = { state: 'idle', current: app.getVersion() }
export const updateEvents = new EventEmitter()

interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  channel: string
  checkForUpdates: () => Promise<unknown>
  downloadUpdate: () => Promise<unknown>
  quitAndInstall: () => void
  on(event: string, cb: (...args: unknown[]) => void): unknown
}

// 안정 채널은 정식 릴리즈만, beta/nightly 는 GitHub prerelease 도 허용.
function applyChannel(u: AutoUpdaterLike, channel: string): void {
  u.channel = channel
  u.allowPrerelease = channel !== 'latest'
}

let updater: AutoUpdaterLike | null = null

async function loadUpdater(): Promise<AutoUpdaterLike | null> {
  try {
    const mod = await import('electron-updater')
    return (mod as unknown as { autoUpdater: AutoUpdaterLike }).autoUpdater
  } catch {
    console.warn('[update] electron-updater not installed — skipped')
    return null
  }
}

function broadcast(): void {
  for (const ctx of getAllWindows()) {
    if (!ctx.chrome.webContents.isDestroyed()) {
      ctx.chrome.webContents.send('update:status', { ...status })
    }
  }
  updateEvents.emit('status', { ...status })
}

function setState(patch: Partial<UpdateStatus>): void {
  Object.assign(status, patch)
  broadcast()
}

export async function initAutoUpdate(): Promise<void> {
  if (!app.isPackaged) {
    setState({ state: 'disabled', error: '개발 모드에서는 자동 업데이트 비활성' })
    return
  }
  const settings = getSetting('update')
  updater = await loadUpdater()
  if (!updater) {
    setState({ state: 'disabled', error: 'electron-updater 미설치' })
    return
  }
  updater.autoDownload = settings.autoDownload === true
  updater.autoInstallOnAppQuit = true
  applyChannel(updater, settings.channel ?? 'latest')

  updater.on('checking-for-update', () => setState({ state: 'checking' }))
  updater.on('update-available', (...args: unknown[]) => {
    const info = args[0] as { version?: string; releaseNotes?: string } | undefined
    setState({
      state: 'available',
      available: info?.version,
      releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : undefined,
      error: undefined,
    })
  })
  updater.on('update-not-available', () => setState({
    state: 'not-available', lastCheckedAt: Date.now(), error: undefined,
  }))
  updater.on('download-progress', (...args: unknown[]) => {
    const p = args[0] as { percent?: number } | undefined
    setState({ state: 'downloading', progress: typeof p?.percent === 'number' ? p.percent / 100 : undefined })
  })
  updater.on('update-downloaded', (...args: unknown[]) => {
    const info = args[0] as { version?: string } | undefined
    setState({ state: 'downloaded', available: info?.version })
  })
  updater.on('error', (...args: unknown[]) => {
    const err = args[0] as Error | undefined
    setState({ state: 'error', error: err?.message ?? 'unknown error' })
  })

  if (settings.autoCheck) {
    // 부팅 1분 후 첫 체크, 이후 6시간마다
    setTimeout(() => void checkForUpdates(true), 60_000)
    setInterval(() => void checkForUpdates(true), 6 * 60 * 60 * 1000)
  }
}

export async function checkForUpdates(silent = false): Promise<UpdateStatus> {
  if (!updater) {
    if (!silent) setState({ state: 'disabled', error: '업데이트 시스템 미초기화' })
    return { ...status }
  }
  try {
    await updater.checkForUpdates()
  } catch (err) {
    setState({ state: 'error', error: (err as Error).message })
  }
  return { ...status }
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  if (!updater) return { ...status }
  try {
    await updater.downloadUpdate()
  } catch (err) {
    setState({ state: 'error', error: (err as Error).message })
  }
  return { ...status }
}

export function quitAndInstall(): void {
  updater?.quitAndInstall()
}

export function getStatus(): UpdateStatus {
  return { ...status }
}

export function setChannel(channel: 'latest' | 'beta' | 'nightly'): void {
  setNestedSetting('update.channel', channel)
  if (updater) applyChannel(updater, channel)
}

export function setAutoDownload(enabled: boolean): void {
  setNestedSetting('update.autoDownload', enabled)
  if (updater) updater.autoDownload = enabled
}

export function setAutoCheck(enabled: boolean): void {
  setNestedSetting('update.autoCheck', enabled)
  // autoCheck 토글은 다음 부팅부터 반영 (setInterval 변경 회피)
}
