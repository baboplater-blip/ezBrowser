import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  cancelDownload, clearFinishedDownloads, getDownloadMeta, listDownloads, openDownloadFile,
  openDownloadFolder, pauseDownload, removeDownloadEntry, resumeDownload, retryDownload,
} from '../features/downloads'
import { isTrustedSender } from './trust'

export function registerDownloadsIpc(): void {
  ipcMain.handle(IPC.downloads.list, (e) => { if (!isTrustedSender(e)) return []; return listDownloads() })
  ipcMain.handle(IPC.downloads.pause, (e, { id }: { id: string }) => { if (!isTrustedSender(e)) return; return pauseDownload(id) })
  ipcMain.handle(IPC.downloads.resume, (e, { id }: { id: string }) => { if (!isTrustedSender(e)) return; return resumeDownload(id) })
  ipcMain.handle(IPC.downloads.cancel, (e, { id }: { id: string }) => { if (!isTrustedSender(e)) return; return cancelDownload(id) })
  ipcMain.handle(IPC.downloads.openFolder, (e, { id }: { id?: string }) => { if (!isTrustedSender(e)) return; return openDownloadFolder(id ?? '') })
  ipcMain.handle(IPC.downloads.openFile, (e, { id }: { id: string }) => { if (!isTrustedSender(e)) return; return openDownloadFile(id) })
  ipcMain.handle(IPC.downloads.retry, (e, { id }: { id: string }) => { if (!isTrustedSender(e)) return; return retryDownload(id) })
  ipcMain.handle(IPC.downloads.remove, (e, { id }: { id: string }) => { if (!isTrustedSender(e)) return; return removeDownloadEntry(id) })
  ipcMain.handle(IPC.downloads.clearFinished, (e) => { if (!isTrustedSender(e)) return; return clearFinishedDownloads() })
  ipcMain.handle(IPC.downloads.copyPath, (e, { id }: { id: string }) => {
    if (!isTrustedSender(e)) return ''
    const meta = getDownloadMeta(id)
    if (meta?.savePath) clipboard.writeText(meta.savePath)
    return meta?.savePath ?? ''
  })
  // 설정 페이지("기본 저장 위치")에서만 사용 — browser:// 내부 페이지만 신뢰(외부 사이트가
  // 임의로 폴더 선택 다이얼로그를 띄우지 못하도록).
  ipcMain.handle(IPC.downloads.pickFolder, async (e) => {
    if (!isTrustedSender(e)) return { canceled: true }
    const win = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      title: '기본 다운로드 폴더 선택',
      properties: ['openDirectory'],
    })
    if (r.canceled || r.filePaths.length === 0) return { canceled: true }
    return { canceled: false, path: r.filePaths[0] }
  })
}
