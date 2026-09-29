"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerVideoIpc = registerVideoIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const video_download_1 = require("../features/video-download");
const window_service_1 = require("../windows/window-service");
const tab_service_1 = require("../tabs/tab-service");
// tabId 가 있으면 그 탭이 속한 창을 우선 — 없거나 못 찾으면 첫 창으로 폴백.
function notifyDownloadStarted(message, tabId) {
    let ctx = tabId ? (0, window_service_1.getWindow)((0, tab_service_1.getTab)(tabId)?.windowId ?? '') : undefined;
    if (!ctx)
        ctx = (0, window_service_1.getAllWindows)()[0];
    if (!ctx)
        return;
    ctx.chrome.webContents.send('toast:show', { message, ts: Date.now() });
    // 다운로드 패널 자동 표시 — 진행률이 보이도록
    ctx.chrome.webContents.send('panel:open', { panel: 'downloads' });
}
function registerVideoIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.video.candidates, (_e, { tabId }) => (0, video_download_1.getCandidates)(tabId));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.video.download, async (_e, { candidate }) => {
        // 감지된 후보는 pageUrl 이 비어 있으므로 탭에서 실제 URL·제목을 보강(referer·파일명용)
        const tab = candidate.tabId ? (0, tab_service_1.getTab)(candidate.tabId) : null;
        const pageUrl = candidate.pageUrl || tab?.url || '';
        const title = tab?.title ?? '';
        // site 후보(YouTube 등 지원 호스트 · MSE blob 감지) → 페이지 URL 로 yt-dlp 직행.
        if (candidate.kind === 'site') {
            notifyDownloadStarted('동영상 추출 중… (yt-dlp, 진행률은 다운로드 패널)', candidate.tabId);
            await (0, video_download_1.downloadWithYtDlp)(candidate.url || pageUrl, pageUrl, { title, tabId: candidate.tabId });
            return { ok: true, kind: 'ytdlp' };
        }
        // hls/dash 스트림은 downloadStream(네이티브 HLS→yt-dlp 폴백), 그 외(mp4/octet/video)는 범용 downloadMedia.
        const isStream = candidate.kind === 'hls' || candidate.kind === 'dash' || /\.(m3u8|mpd)(\?|$)/i.test(candidate.url);
        if (isStream) {
            const kindHint = candidate.kind === 'hls' || candidate.kind === 'dash' ? candidate.kind : undefined;
            await (0, video_download_1.downloadStream)(candidate.url || pageUrl, pageUrl, candidate.tabId, title, kindHint);
            return { ok: true, kind: 'stream' };
        }
        if (candidate.url) {
            // downloadMedia 가 직접 받기→실패 시 yt-dlp 폴백까지 내부 처리(토스트 포함)
            await (0, video_download_1.downloadMedia)(candidate.url, pageUrl, candidate.tabId, title);
            return { ok: true, kind: 'direct' };
        }
        notifyDownloadStarted('동영상 다운로드 준비 중…', candidate.tabId);
        await (0, video_download_1.downloadMedia)(pageUrl, pageUrl, candidate.tabId, title);
        return { ok: true, kind: 'direct' };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.video.ytdlpStatus, () => ({ installed: (0, video_download_1.isYtDlpInstalled)() }));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.video.ytdlpEnsure, async () => {
        const p = await (0, video_download_1.ensureYtDlp)();
        return { ok: !!p, path: p };
    });
    // 지금 최신화 — 미설치면 최신을 받고(사용자 동의 다이얼로그), 설치돼 있으면 강제 최신 확인·교체.
    electron_1.ipcMain.handle(ipc_channels_1.IPC.video.ytdlpUpdate, async () => {
        if (!(0, video_download_1.isYtDlpInstalled)()) {
            const p = await (0, video_download_1.ensureYtDlp)();
            return { ok: !!p, result: p ? 'updated' : 'failed' };
        }
        const result = await (0, video_download_1.maybeUpdateYtDlp)({ force: true });
        return { ok: result !== 'failed', result };
    });
}
