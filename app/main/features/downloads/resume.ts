import { getAllWindows } from '../../windows/window-service'
import { resumeHlsDownload, resumeVideoDownload } from '../video-download'
import { resumeAccelPending } from './index'
import { installPendingQuitHook, listPending, removePending } from './pending-store'

/**
 * 부팅 시 호출 — 지난 세션에서 진행 중이던(완료되지 않은) 다운로드를 이어받는다.
 * - video : 같은 outputTpl 로 yt-dlp 재실행 → .part/.ytdl 에서 이어받음
 * - http-accel : .part<i> 임시 파일 크기로 받은 양 복원 후 Range 로 이어받음
 */
export async function resumePendingDownloads(): Promise<void> {
  installPendingQuitHook()
  const pending = listPending()
  if (pending.length === 0) return

  const ctx = getAllWindows()[0]
  if (ctx) {
    ctx.chrome.webContents.send('toast:show', {
      message: `이전 다운로드 ${pending.length}건 이어받기 ⬇`, ts: Date.now(),
    })
    ctx.chrome.webContents.send('panel:open', { panel: 'downloads' })
  }

  for (const job of pending) {
    try {
      if (job.kind === 'video') {
        await resumeVideoDownload(job)
      } else if (job.kind === 'http-accel') {
        await resumeAccelPending(job)
      } else if (job.kind === 'hls') {
        // HLS 는 다운로드 완료까지 resolve 하지 않으므로 대기하지 않는다(뒤 작업 블록 방지)
        void resumeHlsDownload(job).catch((err) => {
          console.warn('[downloads] resume failed', job.id, err)
          removePending(job.id)
        })
      }
    } catch (err) {
      console.warn('[downloads] resume failed', job.id, err)
      removePending(job.id)
    }
  }
}
