"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.videoEvents = void 0;
exports.registerTabWebContents = registerTabWebContents;
exports.unregisterTabWebContents = unregisterTabWebContents;
exports.clearCandidates = clearCandidates;
exports.getCandidates = getCandidates;
exports.handleOverlayDownload = handleOverlayDownload;
exports.initVideoDetect = initVideoDetect;
exports.reportSiteCandidate = reportSiteCandidate;
exports.isYtDlpInstalled = isYtDlpInstalled;
exports.ensureYtDlp = ensureYtDlp;
exports.maybeUpdateYtDlp = maybeUpdateYtDlp;
exports.downloadWithYtDlp = downloadWithYtDlp;
exports.resumeVideoDownload = resumeVideoDownload;
exports.downloadMedia = downloadMedia;
exports.downloadDirect = downloadDirect;
exports.downloadStream = downloadStream;
exports.resumeHlsDownload = resumeHlsDownload;
const electron_1 = require("electron");
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const ipc_channels_1 = require("../../../shared/ipc-channels");
const window_service_1 = require("../../windows/window-service");
const downloads_1 = require("../downloads");
const hls_1 = require("../downloads/hls");
const dash_1 = require("../downloads/dash");
const response_hooks_1 = require("../response-hooks");
const tab_service_1 = require("../../tabs/tab-service");
const pending_store_1 = require("../downloads/pending-store");
const settings_1 = require("../../storage/settings");
const VIDEO_MIME = [/^video\//i, /application\/vnd\.apple\.mpegurl/i, /application\/dash\+xml/i, /application\/x-mpegurl/i];
const VIDEO_EXT = /\.(m3u8|mpd|mp4|webm|mkv|mov)(\?|$)/i;
// 매니페스트(다운로드 단위) — 이것만 후보로 올린다
const MANIFEST_MIME = /mpegurl|dash\+xml/i;
const MANIFEST_EXT = /\.(m3u8|mpd)(\?|$)/i;
// HLS/DASH 세그먼트(개별 조각) — 후보에서 제외. 다운로드 단위가 아니라 수십 개가 쏟아진다.
const SEGMENT_EXT = /\.(ts|dts|m4s|cmfv|cmfa|m4v|seg)(\?|$)/i;
const SEGMENT_MIME = /video\/mp2t|video\/iso\.segment/i;
// 큰 octet-stream(확장자 없이 서빙되는 mp4 등)도 미디어로 인식하는 임계치
const OCTET_MEDIA_MIN_BYTES = 3 * 1024 * 1024;
// HTTP 헤더는 대소문자 무관 — Electron 의 responseHeaders 키가 원본 그대로(Content-Type 등)일 수 있음
function headerVal(h, name) {
    if (!h)
        return '';
    const target = name.toLowerCase();
    for (const k of Object.keys(h)) {
        if (k.toLowerCase() === target)
            return h[k]?.[0] ?? '';
    }
    return '';
}
function isManifest(url, ct) {
    return MANIFEST_MIME.test(ct) || MANIFEST_EXT.test(url);
}
function isSegment(url, ct) {
    if (isManifest(url, ct))
        return false;
    // 완전한 파일 확장자(.mp4/.webm/.mkv/.mov)면 세그먼트가 아니다 —
    // 토큰 CDN 이 mp4 를 application/octet-stream 으로 줘도 세그먼트로 오인하지 않도록.
    if (VIDEO_EXT.test(url))
        return false;
    if (SEGMENT_EXT.test(url))
        return true;
    return SEGMENT_MIME.test(ct);
}
const YT_DLP_HOSTS = [
    /(^|\.)youtube\.com$/i, /(^|\.)youtu\.be$/i, /(^|\.)vimeo\.com$/i,
    /(^|\.)twitch\.tv$/i, /(^|\.)soundcloud\.com$/i, /(^|\.)bilibili\.com$/i,
    /(^|\.)tv\.naver\.com$/i, /(^|\.)tiktok\.com$/i, /(^|\.)instagram\.com$/i,
    /(^|\.)twitter\.com$/i, /(^|\.)x\.com$/i, /(^|\.)facebook\.com$/i,
    /(^|\.)dailymotion\.com$/i, /(^|\.)afreecatv\.com$/i,
];
const candidatesByTab = new Map();
exports.videoEvents = new node_events_1.EventEmitter();
const wcToTabId = new Map();
// blob/MSE 스니핑: 매니페스트 후보 없이 세그먼트만 흐르는 탭의 세그먼트 카운트.
const segActivityByTab = new Map();
const SEG_ACTIVITY_THRESHOLD = 3;
function registerTabWebContents(tabId, wcId) {
    wcToTabId.set(wcId, tabId);
}
function unregisterTabWebContents(tabId) {
    for (const [wcId, t] of wcToTabId) {
        if (t === tabId) {
            wcToTabId.delete(wcId);
            lastOverlayCallByWc.delete(wcId);
        }
    }
    candidatesByTab.delete(tabId);
    segActivityByTab.delete(tabId);
    broadcastCandidates(tabId);
}
function broadcastCandidates(tabId) {
    const list = candidatesByTab.get(tabId) ?? [];
    for (const ctx of (0, window_service_1.getAllWindows)()) {
        ctx.chrome.webContents.send(ipc_channels_1.IPC.video.candidatesChanged, { tabId, candidates: list });
    }
}
function pushCandidate(tabId, cand) {
    let list = candidatesByTab.get(tabId) ?? [];
    if (list.some((c) => c.url === cand.url))
        return;
    // 실제 받을 수 있는 후보(매니페스트/직접 파일)가 들어오면, MSE 추정으로 띄운 합성 'site' 후보는 제거
    // (더 정확한 직접 다운로드가 가능하므로 중복·오선택 방지). 단 yt-dlp 지원 호스트(YouTube 등)의
    // 정당한 site 후보(reportSiteCandidate)는 URL 호스트로 구분해 보존한다.
    if (cand.kind === 'hls' || cand.kind === 'dash' || cand.kind === 'mp4' || cand.kind === 'video') {
        list = list.filter((c) => {
            if (c.kind !== 'site')
                return true;
            try {
                return isYtDlpHost(new URL(c.url).hostname);
            }
            catch {
                // 합성 site 후보는 항상 http(s) 페이지 URL — 파싱 실패면 비정상, 보수적으로 제거
                return false;
            }
        });
    }
    if (list.length >= 25)
        list.shift();
    list.push(cand);
    candidatesByTab.set(tabId, list);
    broadcastCandidates(tabId);
}
// blob/MSE 스니핑: 세그먼트(.ts/.m4s 등)가 임계치 이상 흐르는데 받을 수 있는 후보(매니페스트/직접
// 파일)가 하나도 없으면 — MSE 플레이어가 blob 으로 재생 중이라 네트워크에 매니페스트가 안 보이는
// 경우 — 페이지 URL 을 'site' 후보로 띄워 yt-dlp 로 받을 수단을 제공한다(임계치에서 1회).
function noteSegmentActivity(tabId) {
    const n = (segActivityByTab.get(tabId) ?? 0) + 1;
    segActivityByTab.set(tabId, n);
    if (n !== SEG_ACTIVITY_THRESHOLD)
        return;
    const list = candidatesByTab.get(tabId) ?? [];
    if (list.some((c) => c.kind === 'hls' || c.kind === 'dash' || c.kind === 'mp4' || c.kind === 'video' || c.kind === 'site'))
        return;
    const pageUrl = (0, tab_service_1.getTab)(tabId)?.url ?? '';
    if (!/^https?:/i.test(pageUrl))
        return;
    pushCandidate(tabId, { tabId, url: pageUrl, pageUrl, mime: '', kind: 'site', detectedAt: Date.now() });
}
function clearCandidates(tabId) {
    candidatesByTab.delete(tabId);
    segActivityByTab.delete(tabId);
    broadcastCandidates(tabId);
}
function getCandidates(tabId) {
    return candidatesByTab.get(tabId) ?? [];
}
function looksLikeDirectMediaUrl(url) {
    return /\.(mp4|webm|mov|mkv|m4a|mp3)(\?|$)/i.test(url);
}
function looksLikeStreamUrl(url) {
    return /\.(m3u8|mpd|ts)(\?|$)/i.test(url);
}
function isYtDlpHost(host) {
    return YT_DLP_HOSTS.some((re) => re.test(host));
}
// tabId 가 있으면 그 탭이 속한 창을 우선 — 없거나 못 찾으면 첫 창으로 폴백.
function resolveNotifyCtx(tabId) {
    if (tabId) {
        const winId = (0, tab_service_1.getTab)(tabId)?.windowId;
        if (winId) {
            const ctx = (0, window_service_1.getWindow)(winId);
            if (ctx)
                return ctx;
        }
    }
    return (0, window_service_1.getAllWindows)()[0];
}
function notifyStarted(message, tabId) {
    const ctx = resolveNotifyCtx(tabId);
    if (!ctx)
        return;
    ctx.chrome.webContents.send('toast:show', { message, ts: Date.now() });
    ctx.chrome.webContents.send('panel:open', { panel: 'downloads' });
}
// 실패 토스트 전용 — 패널은 열지 않는다(downloadMedia 의 기존 실패 처리와 동일 패턴).
function notifyToast(message, tabId) {
    const ctx = resolveNotifyCtx(tabId);
    ctx?.chrome.webContents.send('toast:show', { message, ts: Date.now() });
}
async function handleOverlayDownload(args) {
    const { videoSrc, pageUrl, senderWcId } = args;
    const tabId = wcToTabId.get(senderWcId);
    const candidates = tabId ? getCandidates(tabId) : [];
    const title = tabId ? ((0, tab_service_1.getTab)(tabId)?.title ?? '') : '';
    let host = '';
    try {
        host = new URL(pageUrl).hostname;
    }
    catch { /* ignore */ }
    // 우선순위: "재생 중인 것을 받는다" 가 가장 직관적이고 정확.
    // 1) yt-dlp 지원 호스트(YouTube 등) → 페이지 URL 로 yt-dlp
    // 2) video.src 가 직접 미디어(mp4 등) → downloadMedia (재생 중인 그 파일, 후보 오탐보다 우선)
    // 3) video.src 가 스트림(m3u8/mpd) → downloadStream
    // 4) (video.src 가 blob/MSE 등) 감지된 hls/dash 후보 → downloadStream
    // 5) 감지된 mp4/octet 후보 → downloadMedia
    // 6) 그 외 → 가진 URL 로 downloadMedia, 없으면 페이지 URL 로 yt-dlp
    if (host && isYtDlpHost(host)) {
        notifyStarted('동영상 추출 중… (yt-dlp, 진행률은 다운로드 패널 Ctrl+J)', tabId);
        void downloadWithYtDlp(pageUrl, pageUrl, { title, tabId });
        return;
    }
    // 재생 중인 video.src 가 구체적 미디어 URL 이면 그것을 최우선(후보 오탐보다 정확)
    if (videoSrc && looksLikeDirectMediaUrl(videoSrc)) {
        void downloadMedia(videoSrc, pageUrl, tabId, title);
        return;
    }
    if (videoSrc && looksLikeStreamUrl(videoSrc)) {
        void downloadStream(videoSrc, pageUrl, tabId, title);
        return;
    }
    // video.src 가 blob/MSE/없음 → 네트워크에서 감지한 후보 사용
    const stream = candidates.find((c) => c.kind === 'hls' || c.kind === 'dash');
    if (stream) {
        // 후보가 저장한 프레임 URL 을 Referer 로 사용 — 임베드 플레이어(Bunny 등)는 세그먼트를
        // iframe 컨텍스트에서 요청하므로 탭 URL 이 아니라 프레임 URL 이 올바른 Referer 다.
        const hint = stream.kind === 'hls' || stream.kind === 'dash' ? stream.kind : undefined;
        void downloadStream(stream.url, stream.pageUrl || pageUrl, tabId, title, hint);
        return;
    }
    const mp4Cand = candidates.find((c) => c.kind === 'mp4' || c.kind === 'video');
    if (mp4Cand) {
        void downloadMedia(mp4Cand.url, mp4Cand.pageUrl || pageUrl, tabId, title);
        return;
    }
    // 마지막 fallback — 무엇이든 가진 것으로 시도(downloadMedia 가 HTML 이면 yt-dlp 로 넘김)
    if (videoSrc) {
        void downloadMedia(videoSrc, pageUrl, tabId, title);
    }
    else if (pageUrl) {
        notifyStarted('동영상 추출 중… (yt-dlp, 진행률은 다운로드 패널 Ctrl+J)', tabId);
        void downloadWithYtDlp(pageUrl, pageUrl, { title, tabId });
    }
}
// 오버레이 click rate limit — 한 webContents 마다 3초 1회. 광고 iframe 의 무한 다운로드 트리거 차단.
const lastOverlayCallByWc = new Map();
const OVERLAY_THROTTLE_MS = 3000;
function initVideoDetect() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.video.downloadFromOverlay, async (e, args) => {
        const senderUrl = e.sender.getURL();
        // 외부 사이트(http/https) 또는 신뢰 protocol 만 허용
        let allowed = false;
        try {
            const u = new URL(senderUrl);
            allowed = u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:';
        }
        catch { /* ignore */ }
        if (!allowed) {
            console.warn('[video] overlay download rejected — untrusted sender', senderUrl);
            return { ok: false, reason: 'untrusted-sender' };
        }
        const now = Date.now();
        const wcId = e.sender.id;
        const last = lastOverlayCallByWc.get(wcId) ?? 0;
        if (now - last < OVERLAY_THROTTLE_MS) {
            console.warn('[video] overlay download throttled', senderUrl);
            return { ok: false, reason: 'throttled' };
        }
        lastOverlayCallByWc.set(wcId, now);
        const videoSrc = String(args?.videoSrc ?? '');
        const pageUrl = String(args?.pageUrl ?? senderUrl ?? '');
        await handleOverlayDownload({ videoSrc, pageUrl, senderWcId: e.sender.id });
        return { ok: true };
    });
    (0, response_hooks_1.onResponseStarted)((details) => {
        try {
            const wcId = details.webContentsId;
            if (typeof wcId !== 'number')
                return;
            const tabId = wcToTabId.get(wcId);
            if (!tabId)
                return;
            const ct = headerVal(details.responseHeaders, 'content-type');
            const url = details.url;
            // 세그먼트(.ts/.dts/.m4s 등)는 후보로 올리지 않되, MSE blob 재생 감지를 위해 활동만 집계
            if (isSegment(url, ct)) {
                noteSegmentActivity(tabId);
                return;
            }
            const sizeHeader = Number(headerVal(details.responseHeaders, 'content-length') || 0);
            const ctLower = ct.toLowerCase();
            // 큰 octet-stream(확장자 없이 서빙되는 mp4 등 토큰 CDN)도 미디어 후보로 인정
            const bigOctet = ctLower.includes('application/octet-stream') && sizeHeader >= OCTET_MEDIA_MIN_BYTES;
            const isMedia = isManifest(url, ct) || VIDEO_MIME.some((re) => re.test(ct)) || VIDEO_EXT.test(url) || bigOctet;
            if (!isMedia)
                return;
            const kind = ctLower.includes('mpegurl') ? 'hls'
                : ctLower.includes('dash') ? 'dash'
                    : /\.m3u8/.test(url) ? 'hls'
                        : /\.mpd/.test(url) ? 'dash'
                            : /\.mp4/.test(url) ? 'mp4'
                                : bigOctet ? 'mp4'
                                    : 'video';
            // yt-dlp 지원 호스트(YouTube 등)는 site→yt-dlp 경로가 이미 정확 — raw mp4/video 조각(예: googlevideo
            // 파편)이 후보 패널을 오염시키지 않도록 hls/dash 매니페스트가 아닌 후보는 올리지 않는다.
            if (kind === 'mp4' || kind === 'video') {
                try {
                    const tabUrl = (0, tab_service_1.getTab)(tabId)?.url ?? '';
                    const tabHost = tabUrl ? new URL(tabUrl).hostname : '';
                    if (tabHost && isYtDlpHost(tabHost))
                        return;
                }
                catch { /* ignore */ }
            }
            // referer 정확도: 요청을 보낸 프레임 URL 을 pageUrl 로 저장 — 임베드 플레이어(Bunny 등)는
            // 세그먼트/플레이리스트를 iframe 컨텍스트에서 요청하므로 탭 URL 보다 프레임 URL 이 올바른 Referer.
            let frameUrl = '';
            try {
                const f = details.frame;
                if (f?.url && /^https?:/i.test(f.url))
                    frameUrl = f.url;
            }
            catch { /* ignore */ }
            pushCandidate(tabId, {
                tabId, url: details.url, pageUrl: frameUrl, mime: ct, kind,
                sizeBytes: sizeHeader > 0 ? sizeHeader : undefined,
                detectedAt: Date.now(),
            });
        }
        catch {
            /* ignore */
        }
    });
    // 설치된 yt-dlp 를 최신으로 유지 — 부팅 8초 후 백그라운드 확인(throttle 12h),
    // 이후 하루 한 번 주기 확인. YouTube 등은 추출 로직이 자주 바뀌어 최신 유지가 필수.
    setTimeout(() => { void maybeUpdateYtDlp(); }, 8_000);
    setInterval(() => { void maybeUpdateYtDlp(); }, YT_DLP_UPDATE_INTERVAL_MS);
}
function reportSiteCandidate(tabId, pageUrl) {
    try {
        const host = new URL(pageUrl).hostname;
        if (!YT_DLP_HOSTS.some((re) => re.test(host)))
            return;
        pushCandidate(tabId, {
            tabId, url: pageUrl, pageUrl, mime: '', kind: 'site',
            detectedAt: Date.now(),
        });
    }
    catch {
        /* ignore */
    }
}
// ====== yt-dlp 통합 ======
//
// yt-dlp 는 YouTube 등이 추출 로직을 자주 바꿔 "최신 유지"가 사실상 필수다(구버전은 곧 실패).
// 그래서 ① 최초 설치는 항상 최신을 받고 ② 설치 후에도 백그라운드로 GitHub 최신 릴리즈를 확인해
// 새 버전이면 조용히 교체한다. throttle 로 하루 한 번만 확인하고, 실행 중 다운로드가 있으면
// 파일 잠금 위험 때문에 교체를 미룬다.
const YT_DLP_RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const YT_DLP_API_LATEST = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const YT_DLP_UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h
// 실행 중인 yt-dlp 자식 프로세스 수 — 교체 시 파일 잠금(특히 Windows) 회피용
let activeYtDlpCount = 0;
let ytDlpUpdateInFlight = false;
function ytDlpAssetName() {
    if (process.platform === 'win32')
        return 'yt-dlp.exe';
    if (process.platform === 'darwin')
        return 'yt-dlp_macos';
    return 'yt-dlp_linux';
}
function ytDlpPath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'binaries', ytDlpAssetName());
}
function ytDlpVersionPath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'binaries', 'yt-dlp.version.json');
}
function isYtDlpInstalled() {
    return (0, node_fs_1.existsSync)(ytDlpPath());
}
async function readYtDlpState() {
    try {
        const j = JSON.parse(await (0, promises_1.readFile)(ytDlpVersionPath(), 'utf8'));
        return {
            tag: typeof j.tag === 'string' ? j.tag : '',
            checkedAt: typeof j.checkedAt === 'number' ? j.checkedAt : 0,
        };
    }
    catch {
        return { tag: '', checkedAt: 0 };
    }
}
async function writeYtDlpState(tag) {
    try {
        await (0, promises_1.mkdir)(node_path_1.default.dirname(ytDlpVersionPath()), { recursive: true });
        await (0, promises_1.writeFile)(ytDlpVersionPath(), JSON.stringify({ tag, checkedAt: Date.now() }), 'utf8');
    }
    catch { /* ignore */ }
}
/** GitHub API 로 최신 릴리즈 태그(예: '2024.08.06') 조회. 실패 시 null. */
async function fetchLatestYtDlpTag() {
    try {
        const resp = await fetch(YT_DLP_API_LATEST, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ezBrowser' },
        });
        if (!resp.ok)
            return null;
        const j = (await resp.json());
        return typeof j.tag_name === 'string' && j.tag_name ? j.tag_name : null;
    }
    catch {
        return null;
    }
}
/** 최신 바이너리를 내려받아 target 을 원자적으로(tmp→rename) 교체. */
async function downloadYtDlpBinary(target) {
    await (0, promises_1.mkdir)(node_path_1.default.dirname(target), { recursive: true });
    const resp = await fetch(`${YT_DLP_RELEASE}/${ytDlpAssetName()}`);
    if (!resp.ok)
        throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const tmp = `${target}.tmp`;
    await (0, promises_1.writeFile)(tmp, buf);
    if (process.platform !== 'win32')
        await (0, promises_1.chmod)(tmp, 0o755);
    try {
        await (0, promises_1.rename)(tmp, target); // 기존 파일 대체(atomic)
    }
    catch {
        // Windows 에서 target 잠김 등으로 rename 실패 시 직접 덮어쓰기 폴백
        await (0, promises_1.writeFile)(target, buf);
        if (process.platform !== 'win32')
            await (0, promises_1.chmod)(target, 0o755);
        await (0, promises_1.unlink)(tmp).catch(() => { });
    }
}
async function ensureYtDlp(opts) {
    const target = ytDlpPath();
    if ((0, node_fs_1.existsSync)(target))
        return target;
    if (!opts?.silent) {
        const ok = await electron_1.dialog.showMessageBox({
            type: 'question',
            buttons: ['받기', '취소'],
            defaultId: 0, cancelId: 1,
            title: 'yt-dlp 가 필요합니다',
            message: '동영상 다운로드를 위해 yt-dlp 를 다운로드합니다.',
            detail: '약 15 MB. GitHub yt-dlp/yt-dlp 공식 릴리즈(최신)에서 받습니다. 이후 자동으로 최신 유지됩니다.',
        });
        if (ok.response !== 0)
            return null;
    }
    try {
        await downloadYtDlpBinary(target);
        // 설치본 버전 기록 — 이후 auto-update 가 이 태그와 최신을 비교
        void fetchLatestYtDlpTag().then((tag) => { if (tag)
            void writeYtDlpState(tag); });
        return target;
    }
    catch (err) {
        console.error('[video] yt-dlp download failed', err);
        void electron_1.dialog.showMessageBox({
            type: 'error',
            message: 'yt-dlp 다운로드 실패',
            detail: err.message,
        });
        return null;
    }
}
/**
 * 설치본 yt-dlp 를 GitHub 최신 릴리즈로 유지한다(백그라운드, 조용히).
 * - 설치 안 됨 → skip(최초 다운로드는 ensureYtDlp 가 최신을 받음)
 * - throttle: force 아니면 마지막 확인 후 12h 이내면 skip
 * - 설정 downloads.ytdlpAutoUpdate=false 면(force 아닌 한) skip
 * - 실행 중 다운로드가 있으면 파일 잠금 위험 → 교체 보류(다음 기회에)
 */
async function maybeUpdateYtDlp(opts) {
    if (ytDlpUpdateInFlight)
        return 'skipped';
    const target = ytDlpPath();
    if (!(0, node_fs_1.existsSync)(target))
        return 'skipped';
    if (!opts?.force && (0, settings_1.getSetting)('downloads').ytdlpAutoUpdate === false)
        return 'skipped';
    const state = await readYtDlpState();
    if (!opts?.force && Date.now() - state.checkedAt < YT_DLP_UPDATE_INTERVAL_MS)
        return 'skipped';
    ytDlpUpdateInFlight = true;
    try {
        const latest = await fetchLatestYtDlpTag();
        if (!latest)
            return 'failed';
        if (latest === state.tag) {
            await writeYtDlpState(latest); // checkedAt 만 갱신 → throttle 리셋
            return 'up-to-date';
        }
        if (activeYtDlpCount > 0)
            return 'skipped'; // 다운로드 중 — 나중에 교체
        await downloadYtDlpBinary(target);
        await writeYtDlpState(latest);
        console.log(`[video] yt-dlp updated → ${latest}`);
        return 'updated';
    }
    catch (err) {
        console.warn('[video] yt-dlp update check failed', err.message);
        return 'failed';
    }
    finally {
        ytDlpUpdateInFlight = false;
    }
}
function sanitizeName(name) {
    return name.replace(/[\\/:*?"<>|%\n\r\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}
async function downloadWithYtDlp(url, pageUrl, opts = {}) {
    const bin = await ensureYtDlp();
    if (!bin)
        return null;
    // 다운로드 계기로 최신 여부 확인(throttle 12h, 비차단). 실제 교체는 실행 중 다운로드가
    // 없을 때만 일어나므로 지금 시작하는 다운로드의 바이너리를 건드리지 않는다.
    void maybeUpdateYtDlp();
    const id = (0, downloads_1.nextDownloadId)('vid');
    const outDir = (0, downloads_1.defaultDownloadDir)('videos');
    await (0, promises_1.mkdir)(outDir, { recursive: true });
    // ffmpeg 미번들 환경 고려: 병합이 필요 없는 단일 파일(progressive)을 우선 선택.
    // ffmpeg 가 있으면 bv*+ba 병합으로 최고화질, 없으면 단일 mp4(best) 로 폴백 — 둘 다 실패 시 best.
    const format = opts.format ?? 'best[ext=mp4]/bv*+ba/best';
    // 파일명: 페이지 제목이 있으면 사용(없거나 'playlist' 면 yt-dlp title). 항상 고유 id 를 붙여
    // 같은 m3u8 제목('playlist') 끼리 충돌해 yt-dlp 가 "이미 받음"으로 건너뛰는 문제를 막는다.
    const cleanTitle = sanitizeName(opts.title ?? '');
    const baseName = (cleanTitle && !/^playlist$/i.test(cleanTitle))
        ? `${cleanTitle} [${id}]`
        : `%(title).80B [${id}]`;
    const outputTpl = node_path_1.default.join(outDir, `${baseName}.%(ext)s`);
    // 쿠키 게이트 영상(로그인 필요 등) 대응 — 탭 세션 쿠키를 Netscape cookies.txt 로 넘긴다.
    const cookiesPath = await writeCookiesFileForTab(opts.tabId, pageUrl, id);
    // 진행 중 작업을 영속화 — 브라우저가 닫혀도 다음 실행 때 같은 outputTpl 로 이어받음.
    const pending = {
        kind: 'video', id, url, pageUrl, title: opts.title ?? '',
        format, outputTpl, filename: 'yt-dlp 시작 중…', startedAt: Date.now(),
    };
    (0, pending_store_1.putPending)(pending);
    runYtDlpProcess(bin, pending, cookiesPath);
    return id;
}
/**
 * 탭 세션의 쿠키를 Netscape cookies.txt 형식으로 임시 파일에 작성 — yt-dlp --cookies 용.
 * 탭이 없거나 쿠키가 없거나 실패하면 undefined(쿠키 없이 진행, 기존 동작 그대로).
 */
async function writeCookiesFileForTab(tabId, pageUrl, downloadId) {
    if (!tabId || !/^https?:/i.test(pageUrl))
        return undefined;
    try {
        const { session: ses } = resolveTabSession(tabId);
        const cookies = await ses.cookies.get({ url: pageUrl });
        if (!cookies.length)
            return undefined;
        const fallbackHost = new URL(pageUrl).hostname;
        const lines = ['# Netscape HTTP Cookie File'];
        for (const c of cookies) {
            const domain = c.domain ?? fallbackHost;
            const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
            const cpath = c.path ?? '/';
            const secure = c.secure ? 'TRUE' : 'FALSE';
            const expiry = Math.floor(c.expirationDate ?? 0);
            lines.push([domain, includeSubdomains, cpath, secure, String(expiry), c.name, c.value].join('\t'));
        }
        const cookiesPath = node_path_1.default.join(electron_1.app.getPath('temp'), `bb-ytdlp-cookies-${downloadId}.txt`);
        await (0, promises_1.writeFile)(cookiesPath, lines.join('\n') + '\n', 'utf8');
        return cookiesPath;
    }
    catch {
        return undefined;
    }
}
/** 부팅 시 영속화된 영상 작업을 같은 outputTpl 로 재실행 → yt-dlp 가 .part/.ytdl 에서 이어받음. */
async function resumeVideoDownload(p) {
    const bin = await ensureYtDlp({ silent: true });
    if (!bin) {
        (0, pending_store_1.removePending)(p.id, true);
        return;
    }
    // p 는 이미 pending-store 에 있음 — 재실행만 하면 됨.
    // 재시작 이어받기는 탭이 사라져 쿠키 미전달(VideoPending 에 tabId 없음) — 현행대로 쿠키 없이 진행.
    runYtDlpProcess(bin, p);
}
function runYtDlpProcess(bin, p, cookiesPath) {
    const { id, url, pageUrl, format, outputTpl } = p;
    let persistedFilename = p.filename;
    const args = [
        '-f', format,
        '-o', outputTpl,
        '--no-playlist',
        '--no-warnings',
        '--newline',
        '--retries', '3',
        '--fragment-retries', '3',
        // 부분 다운로드 이어받기(.part/.ytdl) — yt-dlp 기본값이지만 명시
        '--continue',
        // HLS 를 ffmpeg 없이도 받도록 네이티브 다운로더로 세그먼트 직접 합치기
        '--hls-prefer-native',
        '--concurrent-fragments', '5',
        // HLS 는 total_bytes 가 NA 인 경우가 많아 estimate·fragment 정보까지 받아 진행률을 보강
        '--progress-template',
        'PROG|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.fragment_index)s|%(progress.fragment_count)s',
    ];
    // CDN HLS 는 referer 가 없으면 403 인 경우가 많음
    if (pageUrl)
        args.push('--referer', pageUrl);
    // 쿠키 게이트 영상(로그인 필요 등) — 탭 세션 쿠키를 Netscape 형식으로 전달
    if (cookiesPath)
        args.push('--cookies', cookiesPath);
    args.push(url);
    const meta = {
        id,
        kind: 'video',
        url,
        filename: p.filename || 'yt-dlp 시작 중…',
        savePath: node_path_1.default.dirname(outputTpl),
        totalBytes: 0,
        receivedBytes: 0,
        state: 'active',
        startedAt: p.startedAt,
        sourceTabUrl: pageUrl,
    };
    (0, downloads_1.registerExternalDownload)(meta);
    const child = (0, node_child_process_1.spawn)(bin, args, { windowsHide: true });
    activeYtDlpCount++;
    let exitCounted = false;
    const decActive = () => { if (!exitCounted) {
        exitCounted = true;
        activeYtDlpCount = Math.max(0, activeYtDlpCount - 1);
    } };
    const titleRe = /\[download\] Destination:\s+(.+)/;
    let buffer = '';
    let lastReceived = 0;
    let lastTotal = 0;
    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line)
                continue;
            if (line.startsWith('PROG|')) {
                // 필드: downloaded | total | total_estimate | speed | frag_index | frag_count
                // HLS 는 일부가 'NA' 이므로 lenient 파싱(숫자 아니면 0)
                const parts = line.split('|');
                const num = (s) => {
                    const n = Number(s);
                    return Number.isFinite(n) && n >= 0 ? n : 0;
                };
                const received = num(parts[1]);
                let total = num(parts[2]) || num(parts[3]); // total_bytes 없으면 estimate
                const speed = num(parts[4]);
                const fragIdx = num(parts[5]);
                const fragCount = num(parts[6]);
                // total 을 모르면(HLS) 받은 바이트와 세그먼트 진행으로 추정 — 진행률 바가 움직이도록
                if (total === 0 && fragCount > 0 && fragIdx > 0 && received > 0) {
                    total = Math.round((received * fragCount) / fragIdx);
                }
                (0, downloads_1.updateExternalDownload)(id, {
                    receivedBytes: received,
                    totalBytes: total,
                    speed,
                    state: 'active',
                });
                lastReceived = received;
                lastTotal = total;
                continue;
            }
            const dest = titleRe.exec(line);
            if (dest && dest[1]) {
                const fn = node_path_1.default.basename(dest[1]);
                (0, downloads_1.updateExternalDownload)(id, { filename: fn });
                // 파일명이 실제로 바뀐 경우에만 영속 상태에 반영(이어받기 표시용, 불필요한 디스크 쓰기 방지)
                if (fn !== persistedFilename) {
                    persistedFilename = fn;
                    (0, pending_store_1.putPending)({ ...p, filename: fn });
                }
            }
        }
    });
    child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8').trim();
        if (text)
            console.warn('[yt-dlp]', text);
    });
    child.on('exit', (code) => {
        decActive();
        // 완료/종료 — 영속 상태 제거(이어받기 대상에서 빠짐). 비정상 종료(크래시)면 exit 자체가 안 불려 영속 유지.
        (0, pending_store_1.removePending)(id);
        if (cookiesPath)
            void (0, promises_1.unlink)(cookiesPath).catch(() => { });
        // 완료 시 받은 크기가 0KB 로 보이지 않도록 마지막 진행값 유지(+100% 표기)
        const finalTotal = lastTotal > 0 ? lastTotal : lastReceived;
        (0, downloads_1.updateExternalDownload)(id, {
            completedAt: Date.now(),
            state: code === 0 ? 'done' : 'failed',
            error: code === 0 ? undefined : `yt-dlp exited ${code}`,
            ...(code === 0 && lastReceived > 0
                ? { receivedBytes: finalTotal, totalBytes: finalTotal }
                : {}),
            speed: 0,
        });
        exports.videoEvents.emit('done', id);
    });
    child.on('error', (err) => {
        decActive();
        (0, pending_store_1.removePending)(id);
        if (cookiesPath)
            void (0, promises_1.unlink)(cookiesPath).catch(() => { });
        (0, downloads_1.updateExternalDownload)(id, { state: 'failed', error: err.message });
    });
    // 외부 제어 핸들러 (cancel) — 사용자의 명시적 취소이므로 종료 중에도 강제 제거
    const onCancel = (cancelId) => {
        if (cancelId !== id)
            return;
        (0, pending_store_1.removePending)(id, true);
        try {
            child.kill();
        }
        catch { /* ignore */ }
    };
    downloads_1.downloadEvents.on('cancel-external', onCancel);
    child.on('exit', () => downloads_1.downloadEvents.off('cancel-external', onCancel));
}
function guessFilename(url, title) {
    let base = '';
    try {
        base = node_path_1.default.basename(new URL(url).pathname);
    }
    catch { /* ignore */ }
    if (!base || !/\.[a-z0-9]{2,4}$/i.test(base)) {
        const t = sanitizeName(title);
        base = `${t || 'video'}.mp4`;
    }
    return sanitizeName(decodeURIComponent(base));
}
/**
 * 범용 미디어 다운로드 — 어떤 사이트든 받히도록 설계.
 * 탭 세션(쿠키)+Referer 로 받고, 받으려는 URL 이 HTML(=미디어 아님)이면 yt-dlp 로 자동 폴백.
 * 이게 "html 파일이 받아지는" 문제의 핵심 해결: 다운로드 전 content-type 을 확인해 거른다.
 */
async function downloadMedia(url, pageUrl, tabId, title = '') {
    const wc = tabId ? (0, tab_service_1.getWebContentsByTabId)(tabId) : null;
    const partition = tabId ? (0, tab_service_1.getTabPartition)(tabId) : undefined;
    // wc 가 살아있으면 그 세션, 아니면 partition 으로 세션 복원(쿠키 일치 유지), 둘 다 없으면 default
    const ses = wc?.session ?? (partition ? electron_1.session.fromPartition(partition) : electron_1.session.defaultSession);
    const filename = guessFilename(url, title);
    let started = false;
    if (url) {
        try {
            started = await (0, downloads_1.startManagedHttpDownload)({ url, pageUrl, session: ses, partition, filename });
        }
        catch (err) {
            console.warn('[video] managed download failed', err);
        }
    }
    if (started) {
        notifyStarted('다운로드를 시작했습니다 ⬇ (다운로드 패널 Ctrl+J)', tabId);
        return;
    }
    // 직접 받기 불가(HTML 페이지·임베드·스트림) → yt-dlp 범용 추출기로 폴백
    notifyStarted('동영상 추출 중… (yt-dlp, 진행률은 다운로드 패널)', tabId);
    const id = await downloadWithYtDlp(url || pageUrl, pageUrl, { title, tabId });
    if (!id) {
        notifyToast('다운로드 시작 실패 — yt-dlp 설치를 거절했거나 오류', tabId);
    }
}
/** 하위 호환 별칭 — 기존 호출부 보존. */
async function downloadDirect(url, pageUrl, tabId) {
    return downloadMedia(url, pageUrl, tabId);
}
function resolveTabSession(tabId) {
    const wc = tabId ? (0, tab_service_1.getWebContentsByTabId)(tabId) : null;
    const partition = tabId ? (0, tab_service_1.getTabPartition)(tabId) : undefined;
    const ses = wc?.session ?? (partition ? electron_1.session.fromPartition(partition) : electron_1.session.defaultSession);
    return { session: ses, partition };
}
/**
 * 스트림(HLS/DASH) 다운로드 라우터.
 *  - .m3u8 → 네이티브 HLS 다운로더(yt-dlp 불필요). 실패 시 yt-dlp 로 폴백.
 *  - .mpd(DASH) → 네이티브 DASH 다운로더(muxed 한정). 분리 음성·실패 시 yt-dlp 로 폴백.
 */
async function downloadStream(url, pageUrl, tabId, title = '', kindHint) {
    // kindHint 가 주어지면(감지 시점의 MIME 기반 kind) URL 정규식보다 우선 — 배타적으로 신뢰한다.
    const isHls = kindHint ? kindHint === 'hls' : (/\.m3u8(\?|$)/i.test(url) || /[?&]type=m3u8/i.test(url));
    const isDash = kindHint ? kindHint === 'dash' : (/\.mpd(\?|$)/i.test(url) || /[?&]type=mpd/i.test(url));
    if (!isHls && !isDash) {
        // 그 외 → yt-dlp
        notifyStarted('동영상 추출 중… (yt-dlp, 진행률은 다운로드 패널 Ctrl+J)', tabId);
        await downloadWithYtDlp(url || pageUrl, pageUrl, { title, tabId });
        return;
    }
    const { session: ses, partition } = resolveTabSession(tabId);
    if (isDash) {
        const headers = {};
        if (pageUrl)
            headers.Referer = pageUrl;
        const id = (0, downloads_1.nextDownloadId)('dash');
        const outDir = (0, downloads_1.defaultDownloadDir)('videos');
        await (0, promises_1.mkdir)(outDir, { recursive: true });
        const cleanTitle = sanitizeName(title);
        const base = (cleanTitle && !/^playlist$/i.test(cleanTitle)) ? `${cleanTitle} [${id}]` : `video [${id}]`;
        const outPathNoExt = node_path_1.default.join(outDir, base);
        const meta = {
            id, kind: 'video', url, filename: `${base} (DASH)`, savePath: outDir,
            totalBytes: 0, receivedBytes: 0, state: 'active', startedAt: Date.now(), sourceTabUrl: pageUrl,
        };
        (0, downloads_1.registerExternalDownload)(meta);
        notifyStarted('동영상 다운로드 중… (DASH, 진행률은 다운로드 패널 Ctrl+J)', tabId);
        await runDashJob({ id, manifestUrl: url, pageUrl, title, session: ses, headers, outPathNoExt, tabId });
        return;
    }
    const headers = {};
    if (pageUrl)
        headers.Referer = pageUrl;
    const id = (0, downloads_1.nextDownloadId)('hls');
    const outDir = (0, downloads_1.defaultDownloadDir)('videos');
    await (0, promises_1.mkdir)(outDir, { recursive: true });
    const cleanTitle = sanitizeName(title);
    const base = (cleanTitle && !/^playlist$/i.test(cleanTitle)) ? `${cleanTitle} [${id}]` : `video [${id}]`;
    const outPathNoExt = node_path_1.default.join(outDir, base);
    const meta = {
        id, kind: 'video', url, filename: `${base} (HLS)`, savePath: outDir,
        totalBytes: 0, receivedBytes: 0, state: 'active', startedAt: Date.now(), sourceTabUrl: pageUrl,
    };
    (0, downloads_1.registerExternalDownload)(meta);
    notifyStarted('동영상 다운로드 중… (HLS, 진행률은 다운로드 패널 Ctrl+J)', tabId);
    await runHlsJob({
        id, playlistUrl: url, pageUrl, title, session: ses, partition, headers,
        outPathNoExt, resumeFrom: 0, resumeBytes: 0, tabId,
    });
}
/** 부팅 시 영속화된 HLS 작업을 같은 파일에 이어받는다(doneBytes 로 truncate 후 append). */
async function resumeHlsDownload(p) {
    const partition = p.partition;
    const ses = partition ? electron_1.session.fromPartition(partition) : electron_1.session.defaultSession;
    // downloadHls 가 isFmp4 로 ext 를 재계산하므로, 어떤 확장자든 제거해 이중 확장자(.mp4.mp4)를 막는다.
    const outPathNoExt = p.savePath.replace(/\.[^./\\]+$/, '');
    const meta = {
        id: p.id, kind: 'video', url: p.playlistUrl, filename: node_path_1.default.basename(p.savePath),
        savePath: node_path_1.default.dirname(p.savePath), totalBytes: 0, receivedBytes: 0,
        state: 'active', startedAt: p.startedAt, sourceTabUrl: p.pageUrl,
    };
    (0, downloads_1.registerExternalDownload)(meta);
    await runHlsJob({
        id: p.id, playlistUrl: p.playlistUrl, pageUrl: p.pageUrl, title: p.title,
        session: ses, partition, headers: p.headers ?? {}, outPathNoExt,
        resumeFrom: p.doneSegments, resumeBytes: p.doneBytes,
    });
}
/** HLS 다운로드 실행 본체 — 신규 시작·이어받기 공용. 진행 영속화 + 취소 + yt-dlp 폴백. */
async function runHlsJob(args) {
    const { id, playlistUrl, pageUrl, title, session: ses, partition, headers, outPathNoExt, resumeFrom, resumeBytes, tabId, } = args;
    const signal = { cancelled: false };
    const onCancel = (cancelId) => { if (cancelId === id)
        signal.cancelled = true; };
    downloads_1.downloadEvents.on('cancel-external', onCancel);
    let lastTs = Date.now();
    let lastBytes = 0;
    let persistedSavePath = '';
    let totalSegments = 0;
    let lastPersistSeg = resumeFrom;
    const persist = (doneSegments, doneBytes) => {
        if (!persistedSavePath)
            return;
        (0, pending_store_1.putPending)({
            kind: 'hls', id, playlistUrl, pageUrl, title, savePath: persistedSavePath,
            doneSegments, doneBytes, totalSegments, headers, partition, startedAt: Date.now(),
        });
    };
    try {
        const { savePath } = await (0, hls_1.downloadHls)({
            playlistUrl, session: ses, headers, outPathNoExt, resumeFrom, resumeBytes, signal,
            onStart: (info) => {
                persistedSavePath = info.savePath;
                totalSegments = info.totalSegments;
                persist(resumeFrom, resumeBytes); // 시작 지점 영속(이어받기 기준점)
            },
            onProgress: (pr) => {
                const now = Date.now();
                const dt = (now - lastTs) / 1000;
                const speed = dt > 0 ? (pr.receivedBytes - lastBytes) / dt : 0;
                const est = pr.doneSegments > 0 ? Math.round((pr.receivedBytes * pr.totalSegments) / pr.doneSegments) : 0;
                if (dt > 0.25) {
                    lastTs = now;
                    lastBytes = pr.receivedBytes;
                }
                (0, downloads_1.updateExternalDownload)(id, { receivedBytes: pr.receivedBytes, totalBytes: est, speed, state: 'active' });
                // 10세그먼트마다 이어받기 지점(세그먼트 수 + 정확한 바이트) 영속
                if (pr.doneSegments - lastPersistSeg >= 10) {
                    lastPersistSeg = pr.doneSegments;
                    persist(pr.doneSegments, pr.writtenBytes);
                }
            },
        });
        (0, pending_store_1.removePending)(id);
        (0, downloads_1.updateExternalDownload)(id, {
            filename: node_path_1.default.basename(savePath), savePath, state: 'done', completedAt: Date.now(), speed: 0,
        });
        exports.videoEvents.emit('done', id);
    }
    catch (err) {
        const msg = err.message;
        if (signal.cancelled || /cancelled/i.test(msg)) {
            (0, pending_store_1.removePending)(id, true); // 사용자 취소 — 종료 중에도 강제 제거(되살아나지 않게)
            (0, downloads_1.updateExternalDownload)(id, { state: 'cancelled', completedAt: Date.now(), speed: 0 });
        }
        else {
            // 네이티브 HLS 실패 → yt-dlp 폴백. yt-dlp 항목을 먼저 등록한 뒤 HLS 항목을 제거.
            console.warn('[video] native HLS failed, falling back to yt-dlp:', msg);
            (0, pending_store_1.removePending)(id);
            notifyStarted('동영상 추출 중… (yt-dlp 폴백, 진행률은 다운로드 패널)', tabId);
            // yt-dlp 가 throw 해도 HLS 임시 항목이 UI 에 남지 않도록 finally 로 항상 제거.
            let ytId = null;
            try {
                ytId = await downloadWithYtDlp(playlistUrl, pageUrl, { title, tabId });
            }
            finally {
                (0, downloads_1.removeExternalDownload)(id);
            }
            if (!ytId)
                notifyToast('다운로드 시작 실패 — yt-dlp 설치를 거절했거나 오류', tabId);
        }
    }
    finally {
        downloads_1.downloadEvents.off('cancel-external', onCancel);
    }
}
/** 네이티브 DASH 실행 본체 — 진행률 + 취소 + (분리 음성·실패 시) yt-dlp 폴백. 재시작 이어받기는 미지원. */
async function runDashJob(args) {
    const { id, manifestUrl, pageUrl, title, session: ses, headers, outPathNoExt, tabId } = args;
    const signal = { cancelled: false };
    const onCancel = (cancelId) => { if (cancelId === id)
        signal.cancelled = true; };
    downloads_1.downloadEvents.on('cancel-external', onCancel);
    let lastTs = Date.now();
    let lastBytes = 0;
    try {
        const { savePath } = await (0, dash_1.downloadDash)({
            manifestUrl, session: ses, headers, outPathNoExt, signal,
            onProgress: (pr) => {
                const now = Date.now();
                const dt = (now - lastTs) / 1000;
                const speed = dt > 0 ? (pr.receivedBytes - lastBytes) / dt : 0;
                const est = pr.doneSegments > 0 ? Math.round((pr.receivedBytes * pr.totalSegments) / pr.doneSegments) : 0;
                if (dt > 0.25) {
                    lastTs = now;
                    lastBytes = pr.receivedBytes;
                }
                (0, downloads_1.updateExternalDownload)(id, { receivedBytes: pr.receivedBytes, totalBytes: est, speed, state: 'active' });
            },
        });
        (0, downloads_1.updateExternalDownload)(id, {
            filename: node_path_1.default.basename(savePath), savePath, state: 'done', completedAt: Date.now(), speed: 0,
        });
        exports.videoEvents.emit('done', id);
    }
    catch (err) {
        const msg = err.message;
        if (signal.cancelled || /cancelled/i.test(msg)) {
            (0, downloads_1.updateExternalDownload)(id, { state: 'cancelled', completedAt: Date.now(), speed: 0 });
        }
        else {
            // 분리 음성(muxing 불가) 또는 파싱·세그먼트 실패 → yt-dlp 폴백
            const why = err instanceof dash_1.DashSeparateAvError ? '음성/영상 분리' : msg;
            console.warn('[video] native DASH fallback to yt-dlp:', why);
            notifyStarted('동영상 추출 중… (yt-dlp 폴백, 진행률은 다운로드 패널)', tabId);
            let ytId = null;
            try {
                ytId = await downloadWithYtDlp(manifestUrl, pageUrl, { title, tabId });
            }
            finally {
                (0, downloads_1.removeExternalDownload)(id);
            }
            if (!ytId)
                notifyToast('다운로드 시작 실패 — yt-dlp 설치를 거절했거나 오류', tabId);
        }
    }
    finally {
        downloads_1.downloadEvents.off('cancel-external', onCancel);
    }
}
