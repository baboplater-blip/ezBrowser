"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resumePendingDownloads = resumePendingDownloads;
const window_service_1 = require("../../windows/window-service");
const video_download_1 = require("../video-download");
const index_1 = require("./index");
const pending_store_1 = require("./pending-store");
/**
 * 부팅 시 호출 — 지난 세션에서 진행 중이던(완료되지 않은) 다운로드를 이어받는다.
 * - video : 같은 outputTpl 로 yt-dlp 재실행 → .part/.ytdl 에서 이어받음
 * - http-accel : .part<i> 임시 파일 크기로 받은 양 복원 후 Range 로 이어받음
 */
async function resumePendingDownloads() {
    (0, pending_store_1.installPendingQuitHook)();
    const pending = (0, pending_store_1.listPending)();
    if (pending.length === 0)
        return;
    const ctx = (0, window_service_1.getAllWindows)()[0];
    if (ctx) {
        ctx.chrome.webContents.send('toast:show', {
            message: `이전 다운로드 ${pending.length}건 이어받기 ⬇`, ts: Date.now(),
        });
        ctx.chrome.webContents.send('panel:open', { panel: 'downloads' });
    }
    for (const job of pending) {
        try {
            if (job.kind === 'video') {
                await (0, video_download_1.resumeVideoDownload)(job);
            }
            else if (job.kind === 'http-accel') {
                await (0, index_1.resumeAccelPending)(job);
            }
            else if (job.kind === 'hls') {
                // HLS 는 다운로드 완료까지 resolve 하지 않으므로 대기하지 않는다(뒤 작업 블록 방지)
                void (0, video_download_1.resumeHlsDownload)(job).catch((err) => {
                    console.warn('[downloads] resume failed', job.id, err);
                    (0, pending_store_1.removePending)(job.id);
                });
            }
        }
        catch (err) {
            console.warn('[downloads] resume failed', job.id, err);
            (0, pending_store_1.removePending)(job.id);
        }
    }
}
