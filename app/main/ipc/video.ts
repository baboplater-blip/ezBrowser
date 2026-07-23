import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { MediaCandidate } from '../../shared/types'
import {
  downloadMedia, downloadStream, downloadWithYtDlp, ensureYtDlp, getCandidates, isYtDlpInstalled,
} from '../features/video-download'
import { getAllWindows, getWindow } from '../windows/window-service'
import { getTab } from '../tabs/tab-service'

// tabId 가 있으면 그 탭이 속한 창을 우선 — 없거나 못 찾으면 첫 창으로 폴백.
function notifyDownloadStarted(message: string, tabId?: string): void {
  let ctx = tabId ? getWindow(getTab(tabId)?.windowId ?? '') : undefined
  if (!ctx) ctx = getAllWindows()[0]
  if (!ctx) return
  ctx.chrome.webContents.send('toast:show', { message, ts: Date.now() })
  // 다운로드 패널 자동 표시 — 진행률이 보이도록
  ctx.chrome.webContents.send('panel:open', { panel: 'downloads' })
}

export function registerVideoIpc(): void {
  ipcMain.handle(IPC.video.candidates, (_e, { tabId }: { tabId: string }) => getCandidates(tabId))

  ipcMain.handle(IPC.video.download, async (_e, { candidate }: { candidate: MediaCandidate }) => {
    // 감지된 후보는 pageUrl 이 비어 있으므로 탭에서 실제 URL·제목을 보강(referer·파일명용)
    const tab = candidate.tabId ? getTab(candidate.tabId) : null
    const pageUrl = candidate.pageUrl || tab?.url || ''
    const title = tab?.title ?? ''
    // site 후보(YouTube 등 지원 호스트 · MSE blob 감지) → 페이지 URL 로 yt-dlp 직행.
    if (candidate.kind === 'site') {
      notifyDownloadStarted('동영상 추출 중… (yt-dlp, 진행률은 다운로드 패널)', candidate.tabId)
      await downloadWithYtDlp(candidate.url || pageUrl, pageUrl, { title, tabId: candidate.tabId })
      return { ok: true, kind: 'ytdlp' as const }
    }
    // hls/dash 스트림은 downloadStream(네이티브 HLS→yt-dlp 폴백), 그 외(mp4/octet/video)는 범용 downloadMedia.
    const isStream = candidate.kind === 'hls' || candidate.kind === 'dash' || /\.(m3u8|mpd)(\?|$)/i.test(candidate.url)
    if (isStream) {
      const kindHint = candidate.kind === 'hls' || candidate.kind === 'dash' ? candidate.kind : undefined
      await downloadStream(candidate.url || pageUrl, pageUrl, candidate.tabId, title, kindHint)
      return { ok: true, kind: 'stream' as const }
    }
    if (candidate.url) {
      // downloadMedia 가 직접 받기→실패 시 yt-dlp 폴백까지 내부 처리(토스트 포함)
      await downloadMedia(candidate.url, pageUrl, candidate.tabId, title)
      return { ok: true, kind: 'direct' as const }
    }
    notifyDownloadStarted('동영상 다운로드 준비 중…', candidate.tabId)
    await downloadMedia(pageUrl, pageUrl, candidate.tabId, title)
    return { ok: true, kind: 'direct' as const }
  })

  ipcMain.handle(IPC.video.ytdlpStatus, () => ({ installed: isYtDlpInstalled() }))

  ipcMain.handle(IPC.video.ytdlpEnsure, async () => {
    const p = await ensureYtDlp()
    return { ok: !!p, path: p }
  })
}
