"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPending = listPending;
exports.putPending = putPending;
exports.removePending = removePending;
exports.flushPendingSync = flushPendingSync;
exports.installPendingQuitHook = installPendingQuitHook;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
function storePath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'downloads-pending.json');
}
let cache = null;
let writeTimer = null;
// 앱 종료 중에는 yt-dlp/세그먼트 자식 프로세스가 강제 종료되며 exit 핸들러가 removePending 을
// 호출하는데, 이때 진행 중 작업이 지워지면 다음 실행 때 이어받지 못한다 → 종료 중엔 제거를 막는다.
let quitting = false;
function ensureLoaded() {
    if (cache)
        return cache;
    cache = new Map();
    try {
        const p = storePath();
        if ((0, node_fs_1.existsSync)(p)) {
            const raw = (0, node_fs_1.readFileSync)(p, 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                for (const item of parsed) {
                    const job = item;
                    if (!job || typeof job.id !== 'string')
                        continue;
                    if (job.kind === 'video' && typeof job.url === 'string' && typeof job.outputTpl === 'string') {
                        cache.set(job.id, job);
                    }
                    else if (job.kind === 'http-accel'
                        && typeof job.url === 'string' && typeof job.savePath === 'string'
                        && Array.isArray(job.ranges) && job.ranges.length > 0) {
                        cache.set(job.id, job);
                    }
                    else if (job.kind === 'hls'
                        && typeof job.playlistUrl === 'string' && typeof job.savePath === 'string'
                        && typeof job.doneSegments === 'number' && typeof job.doneBytes === 'number') {
                        cache.set(job.id, job);
                    }
                }
            }
        }
    }
    catch (err) {
        console.warn('[downloads] pending-store load failed', err);
    }
    return cache;
}
function flushSync() {
    if (!cache)
        return;
    try {
        const p = storePath();
        const tmp = `${p}.tmp`;
        (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(Array.from(cache.values()), null, 2), 'utf8');
        (0, node_fs_1.renameSync)(tmp, p);
    }
    catch (err) {
        console.warn('[downloads] pending-store flush failed', err);
    }
}
function scheduleWrite() {
    if (writeTimer)
        clearTimeout(writeTimer);
    writeTimer = setTimeout(() => { writeTimer = null; flushSync(); }, 300);
}
function listPending() {
    return Array.from(ensureLoaded().values());
}
function putPending(job) {
    ensureLoaded().set(job.id, job);
    scheduleWrite();
}
/**
 * @param force 종료 중에도 제거할지. 사용자의 명시적 취소는 force=true 로 호출해야
 *   종료 시점에 취소한 작업이 다음 실행 때 되살아나지 않는다.
 */
function removePending(id, force = false) {
    if (quitting && !force)
        return;
    const map = ensureLoaded();
    if (map.delete(id))
        scheduleWrite();
}
/** 앱 종료 직전 동기 flush — 진행 중 작업이 디스크에 확실히 남도록. */
function flushPendingSync() {
    if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
    }
    flushSync();
}
let quitHookInstalled = false;
function installPendingQuitHook() {
    if (quitHookInstalled)
        return;
    quitHookInstalled = true;
    electron_1.app.on('before-quit', () => { quitting = true; flushPendingSync(); });
    electron_1.app.on('will-quit', flushPendingSync);
}
