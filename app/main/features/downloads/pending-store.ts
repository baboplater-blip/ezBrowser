import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'

/**
 * 진행 중(active/paused) 다운로드를 디스크에 영속화하여, 브라우저가 닫혀도
 * 다음 실행 때 이어받을 수 있게 한다. 완료/취소/실패 시 항목을 제거한다.
 *
 * - video  : yt-dlp 작업. 같은 출력 템플릿(outputTpl)으로 재실행하면 .part/.ytdl 에서 이어받음.
 * - http-accel : 멀티 커넥션 가속 작업. .part<i> 임시 파일 크기로 받은 양을 복원해 Range 로 이어받음.
 */
export interface VideoPending {
  kind: 'video'
  id: string
  url: string
  pageUrl: string
  title: string
  format: string
  outputTpl: string
  filename: string
  startedAt: number
}

export interface AccelPending {
  kind: 'http-accel'
  id: string
  url: string
  savePath: string
  filename: string
  totalBytes: number
  connections: number
  ranges: Array<{ start: number; end: number }>
  sourceTabUrl: string
  startedAt: number
  // 핫링크 차단 CDN 이어받기용 — 재실행 시 같은 헤더(Referer)·세션 파티션(쿠키)으로 복원.
  headers?: Record<string, string>
  partition?: string
}

export interface HlsPending {
  kind: 'hls'
  id: string
  playlistUrl: string
  pageUrl: string
  title: string
  savePath: string // 확장자 포함 최종 경로(.mp4/.ts)
  doneSegments: number // 이미 기록한 세그먼트 수 — 재실행 시 이 다음부터 append
  doneBytes: number // doneSegments 시점의 파일 바이트 — 재실행 시 이 길이로 truncate(정합성)
  totalSegments: number
  headers?: Record<string, string>
  partition?: string
  startedAt: number
}

export type PendingJob = VideoPending | AccelPending | HlsPending

function storePath(): string {
  return path.join(app.getPath('userData'), 'downloads-pending.json')
}

let cache: Map<string, PendingJob> | null = null
let writeTimer: NodeJS.Timeout | null = null
// 앱 종료 중에는 yt-dlp/세그먼트 자식 프로세스가 강제 종료되며 exit 핸들러가 removePending 을
// 호출하는데, 이때 진행 중 작업이 지워지면 다음 실행 때 이어받지 못한다 → 종료 중엔 제거를 막는다.
let quitting = false

function ensureLoaded(): Map<string, PendingJob> {
  if (cache) return cache
  cache = new Map()
  try {
    const p = storePath()
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const job = item as PendingJob
          if (!job || typeof job.id !== 'string') continue
          if (job.kind === 'video' && typeof job.url === 'string' && typeof job.outputTpl === 'string') {
            cache.set(job.id, job)
          } else if (job.kind === 'http-accel'
            && typeof job.url === 'string' && typeof job.savePath === 'string'
            && Array.isArray(job.ranges) && job.ranges.length > 0) {
            cache.set(job.id, job)
          } else if (job.kind === 'hls'
            && typeof job.playlistUrl === 'string' && typeof job.savePath === 'string'
            && typeof job.doneSegments === 'number' && typeof job.doneBytes === 'number') {
            cache.set(job.id, job)
          }
        }
      }
    }
  } catch (err) {
    console.warn('[downloads] pending-store load failed', err)
  }
  return cache
}

function flushSync(): void {
  if (!cache) return
  try {
    const p = storePath()
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(Array.from(cache.values()), null, 2), 'utf8')
    renameSync(tmp, p)
  } catch (err) {
    console.warn('[downloads] pending-store flush failed', err)
  }
}

function scheduleWrite(): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => { writeTimer = null; flushSync() }, 300)
}

export function listPending(): PendingJob[] {
  return Array.from(ensureLoaded().values())
}

export function putPending(job: PendingJob): void {
  ensureLoaded().set(job.id, job)
  scheduleWrite()
}

/**
 * @param force 종료 중에도 제거할지. 사용자의 명시적 취소는 force=true 로 호출해야
 *   종료 시점에 취소한 작업이 다음 실행 때 되살아나지 않는다.
 */
export function removePending(id: string, force = false): void {
  if (quitting && !force) return
  const map = ensureLoaded()
  if (map.delete(id)) scheduleWrite()
}

/** 앱 종료 직전 동기 flush — 진행 중 작업이 디스크에 확실히 남도록. */
export function flushPendingSync(): void {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
  flushSync()
}

let quitHookInstalled = false
export function installPendingQuitHook(): void {
  if (quitHookInstalled) return
  quitHookInstalled = true
  app.on('before-quit', () => { quitting = true; flushPendingSync() })
  app.on('will-quit', flushPendingSync)
}
