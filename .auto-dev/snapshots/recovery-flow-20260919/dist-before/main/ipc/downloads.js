"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDownloadsIpc = registerDownloadsIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const downloads_1 = require("../features/downloads");
const trust_1 = require("./trust");
function registerDownloadsIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.downloads.list, (e) => { if (!(0, trust_1.isTrustedSender)(e))
        return []; return (0, downloads_1.listDownloads)(); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.downloads.pause, (e, { id }) => { if (!(0, trust_1.isTrustedSender)(e))
        return; return (0, downloads_1.pauseDownload)(id); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.downloads.resume, (e, { id }) => { if (!(0, trust_1.isTrustedSender)(e))
        return; return (0, downloads_1.resumeDownload)(id); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.downloads.cancel, (e, { id }) => { if (!(0, trust_1.isTrustedSender)(e))
        return; return (0, downloads_1.cancelDownload)(id); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.downloads.openFolder, (e, { id }) => { if (!(0, trust_1.isTrustedSender)(e))
        return; return (0, downloads_1.openDownloadFolder)(id ?? ''); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.downloads.openFile, (e, { id }) => { if (!(0, trust_1.isTrustedSender)(e))
        return; return (0, downloads_1.openDownloadFile)(id); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.downloads.retry, (e, { id }) => { if (!(0, trust_1.isTrustedSender)(e))
        return; return (0, downloads_1.retryDownload)(id); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.downloads.remove, (e, { id }) => { if (!(0, trust_1.isTrustedSender)(e))
        return; return (0, downloads_1.removeDownloadEntry)(id); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.downloads.clearFinished, (e) => { if (!(0, trust_1.isTrustedSender)(e))
        return; return (0, downloads_1.clearFinishedDownloads)(); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.downloads.copyPath, (e, { id }) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return '';
        const meta = (0, downloads_1.getDownloadMeta)(id);
        if (meta?.savePath)
            electron_1.clipboard.writeText(meta.savePath);
        return meta?.savePath ?? '';
    });
    // 설정 페이지("기본 저장 위치")에서만 사용 — browser:// 내부 페이지만 신뢰(외부 사이트가
    // 임의로 폴더 선택 다이얼로그를 띄우지 못하도록).
    electron_1.ipcMain.handle(ipc_channels_1.IPC.downloads.pickFolder, async (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { canceled: true };
        const win = electron_1.BrowserWindow.fromWebContents(e.sender);
        const r = await electron_1.dialog.showOpenDialog(win ?? new electron_1.BrowserWindow({ show: false }), {
            title: '기본 다운로드 폴더 선택',
            properties: ['openDirectory'],
        });
        if (r.canceled || r.filePaths.length === 0)
            return { canceled: true };
        return { canceled: false, path: r.filePaths[0] };
    });
}
