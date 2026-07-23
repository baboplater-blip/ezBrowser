import { app, dialog, shell, session, Notification, type Session } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { DownloadItem as DownloadDto } from '../../../shared/types'
import { IPC } from '../../../shared/ipc-channels'
import { getAllWindows, broadcastToInternalPages } from '../../windows/window-service'
import { getSetting } from '../../storage/settings'
import { addSessionInitHook, setupSessionByPartition } from '../../session-bootstrap'
import { findTabIdByWebContentsId, getTabPartition } from '../../tabs/tab-service'
import {
  type AcceleratorJob, cancelJob as cancelAcceleratorJob, metaFromJob,
  pauseJob as pauseAcceleratorJob, probeUrl, resumeAcceleratedDownload,
  resumeJob as resumeAcceleratorJob, startAcceleratedDownload,
} from './multi-connection'
import { type AccelPending, installPendingQuitHook, putPending, removePending } from './pending-store'

interface HttpTracked {
  id: string
  item: Electron.DownloadItem
  meta: DownloadDto
}

const httpDownloads = new Map<string, HttpTracked>()
const externalDownloads = new Map<string, DownloadDto>()
const acceleratedJobs = new Map<string, { job: AcceleratorJob; meta: DownloadDto }>()
export const downloadEvents = new EventEmitter()
let counter = 0

export function broadcastDownloads(): void {
  const list = listDownloads()
  for (const ctx of getAllWindows()) {
    ctx.chrome.webContents.send(IPC.downloads.update, list)
  }
  broadcastToInternalPages(IPC.downloads.update, list)
  updateTaskbarProgress(list)
}

// 작업표시줄(Windows)/Dock(macOS) 진행률 — 패널을 닫아둔 상태에서도 전체 진행률을 보여준다.
function updateTaskbarProgress(list: DownloadDto[]): void {
  const inProgress = list.filter((d) =>
    d.state === 'active' || d.state === 'metadata' || d.state === 'paused')
  let progress = -1
  let mode: 'none' | 'normal' | 'indeterminate' | 'paused' = 'none'
  if (inProgress.length > 0) {
    const known = inProgress.filter((d) => d.totalBytes > 0)
    if (known.length === 0) {
      // 총 크기 미상(메타데이터·스트리밍) — 진행률 막대를 마퀴로
      progress = 0.5
      mode = 'indeterminate'
    } else {
      const total = known.reduce((s, d) => s + d.totalBytes, 0)
      const received = known.reduce((s, d) => s + Math.min(d.receivedBytes, d.totalBytes), 0)
      progress = total > 0 ? received / total : 0
      mode = inProgress.every((d) => d.state === 'paused') ? 'paused' : 'normal'
    }
  }
  for (const ctx of getAllWindows()) {
    try { ctx.win.setProgressBar(progress, { mode }) } catch { /* 미지원 플랫폼·파괴된 창 */ }
  }
}

export function listDownloads(): DownloadDto[] {
  return [
    ...Array.from(httpDownloads.values()).map((d) => d.meta),
    ...Array.from(acceleratedJobs.values()).map((a) => a.meta),
    ...Array.from(externalDownloads.values()),
  ].sort((a, b) => b.startedAt - a.startedAt)
}

export function registerExternalDownload(item: DownloadDto): void {
  externalDownloads.set(item.id, item)
  broadcastDownloads()
}

export function updateExternalDownload(id: string, patch: Partial<DownloadDto>): void {
  const cur = externalDownloads.get(id)
  if (!cur) return
  externalDownloads.set(id, { ...cur, ...patch })
  broadcastDownloads()
}

export function removeExternalDownload(id: string): void {
  externalDownloads.delete(id)
  broadcastDownloads()
}

export function getExternalDownload(id: string): DownloadDto | undefined {
  return externalDownloads.get(id)
}

export function nextDownloadId(prefix: string): string {
  counter += 1
  return `${prefix}-${counter}-${Date.now()}`
}

/**
 * 다운로드 기본 저장 위치 — settings.downloads.defaultPath 를 우선 사용(존재하는 디렉터리일 때만),
 * 비어있거나 유효하지 않으면 OS Downloads 폴더로 폴백. subfolder 는 그 base 아래에 join(영상/토렌트용).
 */
export function defaultDownloadDir(subfolder?: string): string {
  let base = app.getPath('downloads')
  const configured = (() => {
    try { return getSetting('downloads').defaultPath } catch { return '' }
  })()
  if (configured && configured.trim()) {
    try {
      if (existsSync(configured) && statSync(configured).isDirectory()) base = configured
    } catch { /* 유효하지 않은 경로 — OS 기본값 폴백 */ }
  }
  return subfolder ? path.join(base, subfolder) : base
}

async function tryStartAccelerator(args: {
  id: string; url: string; filename: string; savePath: string;
  sourceTabUrl: string; mime?: string;
  session?: Session; headers?: Record<string, string>; partition?: string;
  totalBytes?: number; acceptsRanges?: boolean;
}): Promise<boolean> {
  const ses = args.session ?? session.defaultSession
  // probe 결과를 미리 받았으면 재사용(중복 probe 방지), 아니면 직접 조회
  let totalBytes = args.totalBytes ?? 0
  let acceptsRanges = args.acceptsRanges ?? false
  if (!totalBytes || !acceptsRanges) {
    const probe = await probeUrl({ url: args.url, session: ses, headers: args.headers })
    totalBytes = probe.totalBytes
    acceptsRanges = probe.acceptsRanges
  }
  if (!acceptsRanges || totalBytes < 1024 * 1024) return false
  const meta: DownloadDto = {
    id: args.id,
    kind: 'http',
    url: args.url,
    filename: args.filename,
    savePath: args.savePath,
    mime: args.mime,
    totalBytes,
    receivedBytes: 0,
    state: 'active',
    startedAt: Date.now(),
    sourceTabUrl: args.sourceTabUrl,
  }
  const job = await startAcceleratedDownload({
    id: args.id,
    url: args.url,
    savePath: args.savePath,
    totalBytes,
    session: ses,
    headers: args.headers,
    onUpdate: (j) => {
      const entry = acceleratedJobs.get(args.id)
      if (!entry) return
      entry.meta = metaFromJob(j, entry.meta)
      broadcastDownloads()
    },
    onComplete: (j) => {
      const entry = acceleratedJobs.get(args.id)
      if (!entry) return
      entry.meta = metaFromJob(j, entry.meta)
      entry.meta.completedAt = Date.now()
      // 완료/실패 — 이어받기 대상에서 제거
      removePending(args.id)
      broadcastDownloads()
      downloadEvents.emit('done', entry.meta)
    },
  })
  acceleratedJobs.set(args.id, { job, meta })
  // 진행 중 작업 영속화 — 브라우저가 닫혀도 .part<i> 와 Range 로 이어받음(헤더·파티션도 보존).
  // 단, 시크릿(incognito) 세션은 디스크에 남기지 않는다 — URL 유출·재시작 이어받기 금지(프라이버시 계약).
  if (!String(args.partition ?? '').startsWith('incognito')) {
    putPending({
      kind: 'http-accel', id: args.id, url: args.url, savePath: args.savePath,
      filename: args.filename, totalBytes, connections: job.connections,
      ranges: job.segments.map((s) => ({ start: s.start, end: s.end })),
      sourceTabUrl: args.sourceTabUrl, startedAt: Date.now(),
      headers: args.headers, partition: args.partition,
    })
  }
  broadcastDownloads()
  console.log(`[downloads] accelerated ${args.filename} (${totalBytes} bytes, ${job.connections} conn)`)
  return true
}

/** 부팅 시 영속화된 가속 HTTP 작업을 이어받는다(.part<i> 크기로 받은 양 복원). */
export async function resumeAccelPending(p: AccelPending): Promise<void> {
  // 핫링크 CDN 이어받기 — 저장해 둔 파티션 세션(쿠키)·헤더(Referer)로 복원
  const ses = p.partition ? session.fromPartition(p.partition) : session.defaultSession
  const meta: DownloadDto = {
    id: p.id, kind: 'http', url: p.url, filename: p.filename, savePath: p.savePath,
    totalBytes: p.totalBytes, receivedBytes: 0, state: 'active',
    startedAt: p.startedAt, sourceTabUrl: p.sourceTabUrl,
    accelerator: { connections: p.connections },
  }
  const job = await resumeAcceleratedDownload({
    id: p.id, url: p.url, savePath: p.savePath, totalBytes: p.totalBytes,
    ranges: p.ranges, session: ses, headers: p.headers,
    onUpdate: (j) => {
      const entry = acceleratedJobs.get(p.id)
      if (!entry) return
      entry.meta = metaFromJob(j, entry.meta)
      broadcastDownloads()
    },
    onComplete: (j) => {
      const entry = acceleratedJobs.get(p.id)
      if (!entry) return
      entry.meta = metaFromJob(j, entry.meta)
      entry.meta.completedAt = Date.now()
      // 완료 시에만 pending 제거 — 실패면 이전 세션 .part 를 보존한 채 다음 부팅에 다시 이어받는다.
      if (j.state === 'done') removePending(p.id)
      broadcastDownloads()
      downloadEvents.emit('done', entry.meta)
    },
  })
  acceleratedJobs.set(p.id, { job, meta })
  // retry 시 파티션·Referer 를 복원할 수 있도록 인증 컨텍스트도 등록해 둔다.
  downloadAuth.set(p.id, { partition: p.partition, headers: p.headers })
  // p 는 이미 pending-store 에 있음 — 완료 시 removePending 으로 제거된다(실패 시 위에서 보존).
  broadcastDownloads()
}

// will-download 를 모든 세션에 한 번씩만 설치(탭은 partition 세션 사용 — defaultSession 만 걸면 누락).
const willDownloadSessions = new WeakSet<Session>()
// startManagedHttpDownload 가 비가속 폴백으로 ses.downloadURL 을 호출하면 will-download 가 재진입한다.
// 이미 probe 해서 "가속 불가"로 판정된 URL 이므로, 재진입 시 중복 probe·가속 재시도를 건너뛴다.
const managedNonAccelUrls = new Set<string>()

// 다운로드 인증 컨텍스트(파티션·Referer) — retry·pending 영속화용
interface DownloadAuth { partition?: string; headers?: Record<string, string> }
const downloadAuth = new Map<string, DownloadAuth>()
const pendingAuthByUrl = new Map<string, DownloadAuth>()

// "매번 폴더 묻기" — 사용자가 Save 다이얼로그에서 고른 경로를, 재요청된 will-download 가
// 다시 묻지 않고 바로 쓰도록 URL 기준 1회성으로 보관한다(아래 attachWillDownload 참고).
const askEveryTimeChosen = new Map<string, string>()

/**
 * 가속 판정 실패(probe 결과 "가속 불가" 또는 probe 자체 예외) — pause 된 원본 item 을 폐기하고
 * startManagedHttpDownload 의 비가속 폴백(374-377행)과 동일한 방식으로 표준 추적 경로를 태운다.
 *
 * 왜 필요한가: `item.pause()` 를 동기 호출한 뒤 비동기 `.then()`/`.catch()` 안에서
 * `item.setSavePath()`+`item.resume()` 를 호출하면(예전 코드) Electron 이 이 pause→(늦은 비동기)
 * resume 사이클에서 `'done'` 이벤트를 아예 발생시키지 않는다 — 특히 서버가 Range 를 지원하지
 * 않아 probe 가 가속 불가로 판정하는 흔한 경우, 다운로드는 100% 까지 받아지고도 완료 처리가
 * 영원히 안 되고 파일도 savePath 에 저장되지 않는다.
 *
 * 대신 item 을 cancel 하고 같은 URL 로 `ses.downloadURL()` 을 재요청하면 'will-download' 가
 * 재진입한다 — 이때 managedNonAccelUrls 플래그로 가속 재시도를 건너뛰고 279행의 **동기**
 * `item.setSavePath()` 경로(표준 즉시-추적)를 타므로 'done' 이 정상적으로 발생한다.
 */
function rerouteToStandardDownload(
  item: Electron.DownloadItem, id: string, url: string, ses: Session,
  partition: string | undefined, headers: Record<string, string> | undefined,
): void {
  try { item.cancel() } catch { /* ignore */ }
  httpDownloads.delete(id)
  managedNonAccelUrls.add(url)
  pendingAuthByUrl.set(url, { partition, headers })
  try { ses.downloadURL(url, headers ? { headers } : undefined) } catch (e) {
    console.warn('[downloads] reroute downloadURL failed:', e)
  }
}

function attachWillDownload(ses: Session): void {
  if (willDownloadSessions.has(ses)) return
  willDownloadSessions.add(ses)
  ses.on('will-download', (_event, item, wc) => {
    const id = nextDownloadId('http')
    const filename = item.getFilename() || `download-${id}`
    const savePath = path.join(defaultDownloadDir(), filename)
    const url = item.getURL()
    const mime = item.getMimeType()
    const sourceTabUrl = wc?.getURL() ?? ''

    // 다운로드 인증 컨텍스트 확정 — 탭의 파티션(쿠키)·Referer 를 이 다운로드 id 에 묶어 둔다.
    // retryDownload·이어받기 pending 영속화가 이 정보를 그대로 재사용한다.
    const preAuth = pendingAuthByUrl.get(url)
    if (preAuth) pendingAuthByUrl.delete(url)
    const src = !preAuth && wc && !wc.isDestroyed() ? findTabIdByWebContentsId(wc.id) : null
    const partition = preAuth?.partition ?? (src ? getTabPartition(src.tabId) : undefined)
    const headers = preAuth?.headers
      ?? (/^https?:/i.test(sourceTabUrl) ? { Referer: sourceTabUrl } : undefined)
    downloadAuth.set(id, { partition, headers })

    // 우리 managed 폴백이 시작한 다운로드면 가속 재시도 생략(표준 추적만)
    const managedNonAccel = managedNonAccelUrls.delete(url)

    // askEveryTimeChosen 에 이미 값이 있으면 = 사용자가 방금 다이얼로그에서 경로를 고른 뒤의
    // 재요청(아래 참고) — 다시 묻지 않고 그 경로로 표준 동기 저장한다.
    const chosenSavePath = askEveryTimeChosen.get(url)
    if (chosenSavePath) askEveryTimeChosen.delete(url)

    // "매번 폴더 묻기" — 내부 관리 다운로드(가속 실패 재요청·영상/토렌트 자동 감지)와, 방금
    // 경로를 고른 재요청 자체는 재질문하지 않는다(managedNonAccel / chosenSavePath 로 판별).
    const askEveryTime = !managedNonAccel && !chosenSavePath && (() => {
      try { return getSetting('downloads').askEveryTime } catch { return false }
    })()

    if (askEveryTime) {
      // Electron DownloadItem 에는 saveAs() 가 없다(이 버전엔 미지원). pause() 를 동기 호출한 뒤
      // 비동기 콜백에서 setSavePath()+resume() 하는 방식은 rerouteToStandardDownload() 주석에 기록된
      // 알려진 버그('done' 이 영원히 발생하지 않음)를 유발할 수 있어, 그와 동일하게 검증된 안전한
      // 패턴을 재사용한다: 즉시 cancel() → 사용자가 다이얼로그에서 경로를 고르면 ses.downloadURL()
      // 로 재요청(같은 URL) → 재요청된 will-download 는 위 chosenSavePath 분기로 동기 저장.
      try { item.cancel() } catch { /* ignore */ }
      downloadAuth.delete(id)
      void dialog.showSaveDialog({ defaultPath: savePath }).then((r) => {
        if (r.canceled || !r.filePath) return
        askEveryTimeChosen.set(url, r.filePath)
        pendingAuthByUrl.set(url, { partition, headers })
        try { ses.downloadURL(url, headers ? { headers } : undefined) } catch (e) {
          console.warn('[downloads] askEveryTime re-download failed:', e)
        }
      }).catch((e) => console.warn('[downloads] save dialog failed:', e))
      return
    }

    if (chosenSavePath) {
      // 사용자가 이미 저장 위치를 골랐다 — 표준 동기 경로로 즉시 저장(가속 건너뜀, 최소 범위).
      item.setSavePath(chosenSavePath)
      const meta: DownloadDto = {
        id, kind: 'http', url, filename, savePath: chosenSavePath, mime,
        totalBytes: item.getTotalBytes(), receivedBytes: 0,
        state: 'active', startedAt: Date.now(), sourceTabUrl,
      }
      httpDownloads.set(id, { id, item, meta })
      attachItemEvents(item, meta, id)
      broadcastDownloads()
      return
    }

    const acceleratorEnabled = !managedNonAccel && (() => {
      try { return getSetting('downloads').accelerator } catch { return false }
    })()

    if (acceleratorEnabled && /^https?:/i.test(url)) {
      // 가속 시도 — 비동기. 가속 시작에 성공하면 기존 다운로드 cancel.
      // 다운로드를 발생시킨 세션(ses)을 그대로 사용 → 쿠키 일치(핫링크 CDN 대응).
      item.pause()
      void tryStartAccelerator({
        id, url, filename, savePath, sourceTabUrl, mime, session: ses, headers, partition,
      })
        .then((started) => {
          if (started) {
            try { item.cancel() } catch { /* ignore */ }
            // 가속으로 인계 — 고아 http 항목이 남지 않도록 명시 제거(done 핸들러 타이밍 보강)
            httpDownloads.delete(id)
          } else {
            // 가속 불가(예: Range 미지원 서버) — 표준 추적 경로로 재요청(비동기 resume 은 'done' 미발생 버그)
            rerouteToStandardDownload(item, id, url, ses, partition, headers)
          }
        })
        .catch((err) => {
          console.warn('[downloads] accelerator probe failed', err)
          rerouteToStandardDownload(item, id, url, ses, partition, headers)
        })
      // pause 직후 이벤트 등록 (가속 fallback 인 경우에도 사용)
      const meta: DownloadDto = {
        id, kind: 'http', url, filename, savePath, mime,
        totalBytes: item.getTotalBytes(), receivedBytes: 0,
        state: 'metadata', startedAt: Date.now(), sourceTabUrl,
      }
      httpDownloads.set(id, { id, item, meta })
      attachItemEvents(item, meta, id)
      broadcastDownloads()
      return
    }

    item.setSavePath(savePath)

    const meta: DownloadDto = {
      id,
      kind: 'http',
      url,
      filename,
      savePath,
      mime,
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: 'active',
      startedAt: Date.now(),
      sourceTabUrl,
    }
    httpDownloads.set(id, { id, item, meta })
    attachItemEvents(item, meta, id)
    broadcastDownloads()
  })
}

export function initDownloads(): void {
  installPendingQuitHook()
  // 모든 현재·미래 세션에 will-download 설치(탭 partition 세션 포함). idempotent.
  addSessionInitHook(attachWillDownload)
  attachWillDownload(session.defaultSession)
  installCompletionFeedback()
}

// 다운로드 완료/실패 시 토스트 + OS 알림 (http 네이티브·가속·외부 모두 'done' emit)
function installCompletionFeedback(): void {
  downloadEvents.on('done', (meta: DownloadDto) => {
    const ok = meta.state === 'done'
    if (!ok && meta.state !== 'failed') return // cancelled 는 알리지 않음
    const msg = ok ? `✓ ${meta.filename} 다운로드 완료` : `✗ ${meta.filename} 다운로드 실패`
    for (const ctx of getAllWindows()) {
      if (!ctx.chrome.webContents.isDestroyed()) {
        ctx.chrome.webContents.send('toast:show', { message: msg, ts: Date.now() })
      }
    }
    if (ok) {
      try {
        if (Notification.isSupported()) {
          const n = new Notification({ title: '다운로드 완료', body: meta.filename })
          n.on('click', () => { try { openDownloadFolder(meta.id) } catch { /* ignore */ } })
          n.show()
        }
      } catch { /* best-effort */ }
    }
  })
}

/**
 * 범용 미디어/파일 다운로드 — 어떤 사이트든 동작하도록 설계.
 *  1) 받으려는 URL 을 탭 세션(쿠키 일치)+Referer 로 probe 해 실제 content-type 확인
 *  2) text/html 이거나 probe 실패면 "미디어가 아님" → false 반환(호출부가 yt-dlp 로 폴백)
 *  3) Range 지원 + 큰 파일이면 가속 다운로드(헤더·쿠키 실어서)
 *  4) 아니면 탭 세션 downloadURL(Referer 포함) → all-session will-download 가 추적
 * @returns true=다운로드 시작함 / false=미디어 아님(폴백 필요)
 */
export async function startManagedHttpDownload(args: {
  url: string; pageUrl: string; session: Session; partition?: string;
  filename: string; mime?: string;
}): Promise<boolean> {
  const { url, pageUrl, session: ses, partition } = args
  if (!/^https?:/i.test(url)) return false
  // Referer 만 보낸다 — 핫링크 CDN 은 Referer 로 허용하며, Origin 은 일부 CDN 에서 CORS 거부를 유발.
  const headers: Record<string, string> = {}
  if (pageUrl) headers.Referer = pageUrl

  const probe = await probeUrl({ url, session: ses, headers })
  const ct = (probe.contentType ?? '').toLowerCase()
  // HTML 페이지(=미디어 아님)거나 아예 못 받으면 폴백시킨다.
  if (!probe.ok || ct.includes('text/html') || ct.includes('application/xhtml')) {
    return false
  }

  const filename = probe.filename || args.filename
  const savePath = path.join(defaultDownloadDir('videos'), filename)
  const acceleratorEnabled = (() => {
    try { return getSetting('downloads').accelerator } catch { return false }
  })()

  if (acceleratorEnabled && probe.acceptsRanges && probe.totalBytes >= 1024 * 1024) {
    const id = nextDownloadId('http')
    const started = await tryStartAccelerator({
      id, url, filename, savePath, sourceTabUrl: pageUrl, mime: args.mime,
      session: ses, headers, partition,
      totalBytes: probe.totalBytes, acceptsRanges: probe.acceptsRanges,
    })
    if (started) return true
  }

  // 비가속 폴백 — 탭 세션 downloadURL(Referer 포함). will-download 가 표준 추적.
  // 이미 "가속 불가"로 판정됐으므로 재진입 시 중복 probe 를 막도록 표시.
  managedNonAccelUrls.add(url)
  // will-download 재진입 시 인증 컨텍스트(파티션·Referer)를 정확히 이어받도록 등록 — retryDownload 의 516행과 동일 패턴.
  pendingAuthByUrl.set(url, { partition, headers })
  ses.downloadURL(url, { headers })
  return true
}

function attachItemEvents(item: Electron.DownloadItem, meta: DownloadDto, id: string): void {
  let lastTs = Date.now()
  let lastBytes = 0
  item.on('updated', (_e, state) => {
    // 가속 다운로드로 인계되어 cancel 된 경우 — 이벤트 무시
    if (acceleratedJobs.has(id)) return
    const now = Date.now()
    const deltaT = (now - lastTs) / 1000
    const deltaB = item.getReceivedBytes() - lastBytes
    const speed = deltaT > 0 ? deltaB / deltaT : 0
    // saveAs() 흐름(매번 폴더 묻기)은 사용자가 다이얼로그에서 고른 후에만 실제 경로를 알 수 있다 —
    // 매 tick 마다 동기화(빈 문자열이면 아직 진행 전이므로 무시).
    const actualSavePath = item.getSavePath()
    if (actualSavePath) meta.savePath = actualSavePath
    meta.receivedBytes = item.getReceivedBytes()
    meta.totalBytes = item.getTotalBytes()
    // 'interrupted'(네트워크 끊김 등)를 'active' 로 두면 0 B/s active 로 영원히 멈춘 것처럼 보이고
    // 완료 비우기로도 못 지운다 → 재개 가능한 '멈춤'으로 표시(영구 실패면 done 이벤트가 failed 로 확정).
    meta.state = state === 'progressing' ? (item.isPaused() ? 'paused' : 'active') : 'paused'
    meta.speed = speed
    lastTs = now
    lastBytes = meta.receivedBytes
    broadcastDownloads()
  })
  item.once('done', (_e, state) => {
    // 가속 다운로드가 시작된 경우 → 이 done 은 cancel 의 결과 → 가속 항목으로 표시 유지
    if (acceleratedJobs.has(id)) {
      httpDownloads.delete(id)
      return
    }
    const actualSavePath = item.getSavePath()
    if (actualSavePath) meta.savePath = actualSavePath
    meta.completedAt = Date.now()
    meta.state = state === 'completed' ? 'done' : state === 'cancelled' ? 'cancelled' : 'failed'
    if (state !== 'completed') meta.error = state
    broadcastDownloads()
    downloadEvents.emit('done', meta)
  })
}

export function pauseDownload(id: string): void {
  const acc = acceleratedJobs.get(id)
  if (acc) { pauseAcceleratorJob(acc.job); return }
  const d = httpDownloads.get(id)
  if (d && !d.item.isPaused()) { d.item.pause(); return }
  downloadEvents.emit('pause-external', id)
}

export function resumeDownload(id: string): void {
  const acc = acceleratedJobs.get(id)
  if (acc) { resumeAcceleratorJob(acc.job); return }
  const d = httpDownloads.get(id)
  if (d && d.item.canResume()) { d.item.resume(); return }
  downloadEvents.emit('resume-external', id)
}

export function cancelDownload(id: string): void {
  const acc = acceleratedJobs.get(id)
  if (acc) {
    removePending(id, true)
    cancelAcceleratorJob(acc.job)
    return
  }
  const d = httpDownloads.get(id)
  if (d) { d.item.cancel(); return }
  downloadEvents.emit('cancel-external', id)
}

/** id 로 다운로드 메타를 찾는다(http 네이티브·가속·외부 모두). */
export function getDownloadMeta(id: string): DownloadDto | undefined {
  return httpDownloads.get(id)?.meta ?? acceleratedJobs.get(id)?.meta ?? externalDownloads.get(id)
}

/** 받은 파일을 연결된 앱으로 연다. 실패하면 폴더에서 보기로 폴백. */
export async function openDownloadFile(id: string): Promise<void> {
  const meta = getDownloadMeta(id)
  if (!meta || !meta.savePath) return
  const err = await shell.openPath(meta.savePath)
  if (err) {
    console.warn('[downloads] openPath failed:', err)
    try { shell.showItemInFolder(meta.savePath) } catch { /* ignore */ }
  }
}

/** 목록에서 항목을 제거한다. 진행 중이면 먼저 취소한다(고아 작업 방지). */
export function removeDownloadEntry(id: string): void {
  const acc = acceleratedJobs.get(id)
  if (acc) {
    const s = acc.meta.state
    if (s === 'active' || s === 'metadata' || s === 'paused') {
      try { cancelAcceleratorJob(acc.job) } catch { /* ignore */ }
    }
    // 상태 무관하게 pending 폐기 — 실패로 보존해 둔 이어받기 정보도 목록 제거와 함께 지운다.
    removePending(id, true)
    acceleratedJobs.delete(id)
    downloadAuth.delete(id)
    broadcastDownloads()
    return
  }
  const http = httpDownloads.get(id)
  if (http) {
    const s = http.meta.state
    if (s === 'active' || s === 'metadata' || s === 'paused') {
      try { http.item.cancel() } catch { /* ignore */ }
    }
    httpDownloads.delete(id)
    downloadAuth.delete(id)
    broadcastDownloads()
    return
  }
  if (externalDownloads.has(id)) {
    // 토렌트는 torrent.remove 로 처리 — 여기 도달하는 외부 항목은 비-토렌트(영상 등)만 노출됨
    downloadAuth.delete(id)
    removeExternalDownload(id)
  }
}

/** 끝난 항목(완료·실패·취소)을 일괄 제거한다. 시드 중 토렌트·진행 중 항목은 남긴다. 제거 개수 반환. */
export function clearFinishedDownloads(): number {
  const finished = (s: DownloadDto['state']) => s === 'done' || s === 'failed' || s === 'cancelled'
  let n = 0
  for (const [id, d] of [...httpDownloads]) if (finished(d.meta.state)) { httpDownloads.delete(id); downloadAuth.delete(id); n += 1 }
  for (const [id, a] of [...acceleratedJobs]) if (finished(a.meta.state)) {
    // 실패로 보존된 이어받기 pending 이 있으면 함께 폐기
    removePending(id, true)
    acceleratedJobs.delete(id)
    downloadAuth.delete(id)
    n += 1
  }
  // 토렌트는 시드/파일 관리가 별도라 제외 — 비-토렌트 외부 항목(영상 등)만 정리
  for (const [id, m] of [...externalDownloads]) if (m.kind !== 'torrent' && finished(m.state)) { externalDownloads.delete(id); downloadAuth.delete(id); n += 1 }
  if (n > 0) broadcastDownloads()
  return n
}

/** 실패/취소된 http 다운로드를 같은 URL 로 다시 시작한다(가속 설정도 반영). 파티션·Referer 도 복원. */
export function retryDownload(id: string): void {
  const meta = getDownloadMeta(id)
  if (!meta || meta.kind !== 'http' || !/^https?:/i.test(meta.url)) return
  const auth = downloadAuth.get(id)
  // 기존 항목 제거 후 재요청 — will-download 가 새 항목으로 추적한다.
  removeDownloadEntry(id)
  try {
    if (auth?.partition) setupSessionByPartition(auth.partition)
    const ses = auth?.partition ? session.fromPartition(auth.partition) : session.defaultSession
    if (auth) pendingAuthByUrl.set(meta.url, auth)
    ses.downloadURL(meta.url, auth?.headers ? { headers: auth.headers } : undefined)
  } catch (e) { console.warn('[downloads] retry failed:', e) }
}

export function openDownloadFolder(id: string): void {
  const acc = acceleratedJobs.get(id)
  if (acc) { shell.showItemInFolder(acc.meta.savePath); return }
  const http = httpDownloads.get(id)
  if (http) { shell.showItemInFolder(http.meta.savePath); return }
  const ext = externalDownloads.get(id)
  if (ext) {
    if (ext.kind === 'torrent') { void shell.openPath(ext.savePath); return }
    shell.showItemInFolder(ext.savePath); return
  }
  void shell.openPath(app.getPath('downloads'))
}
