"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.addTorrent = addTorrent;
exports.pauseTorrent = pauseTorrent;
exports.resumeTorrent = resumeTorrent;
exports.removeTorrent = removeTorrent;
exports.setTorrentFiles = setTorrentFiles;
exports.initTorrentBridge = initTorrentBridge;
exports.initMagnetHandler = initMagnetHandler;
exports.initTorrentResponseHook = initTorrentResponseHook;
exports.isTorrentDhtEnabled = isTorrentDhtEnabled;
const electron_1 = require("electron");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const settings_1 = require("../../storage/settings");
const downloads_1 = require("../downloads");
const response_hooks_1 = require("../response-hooks");
let client = null;
const handles = new Map();
const consentShown = { value: false };
let licenseAcknowledged = false;
async function loadWebTorrent() {
    if (client)
        return client;
    try {
        const name = ['webtorrent'][0];
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(name);
        const WebTorrent = (mod.default ?? mod);
        client = new WebTorrent({
            maxConns: 55,
            dht: false,
        });
        return client;
    }
    catch (err) {
        console.warn('[torrent] webtorrent not installed', err);
        return null;
    }
}
async function showLicenseDialog() {
    if (licenseAcknowledged)
        return true;
    const ok = await electron_1.dialog.showMessageBox({
        type: 'warning',
        buttons: ['동의하고 받기', '취소'],
        defaultId: 0, cancelId: 1,
        title: '토렌트 다운로드 안내',
        message: '저작권을 준수해 주세요.',
        detail: '권리자 동의가 있거나 자유 라이선스 콘텐츠(Creative Commons, public domain, Linux ISO 등) 에만 사용하세요. 책임은 사용자에게 있습니다.\n\n' +
            '계속하면 WebTorrent(분산 BitTorrent) 가 활성화됩니다. 첫 가동 시 Windows 방화벽이 권한을 물어볼 수 있습니다.',
    });
    if (ok.response !== 0)
        return false;
    licenseAcknowledged = true;
    return true;
}
function throttle(fn, ms) {
    let last = 0;
    let timer = null;
    return ((...args) => {
        const now = Date.now();
        if (now - last >= ms) {
            last = now;
            fn(...args);
        }
        else if (!timer) {
            timer = setTimeout(() => {
                last = Date.now();
                timer = null;
                fn(...args);
            }, ms - (now - last));
        }
    });
}
function snapshot(torrent) {
    return {
        receivedBytes: torrent.downloaded,
        totalBytes: torrent.length,
        speed: torrent.downloadSpeed,
        state: torrent.done ? 'seeding' : torrent.downloaded > 0 ? 'active' : 'metadata',
        torrent: {
            infoHash: torrent.infoHash,
            peers: torrent.numPeers,
            uploadedBytes: torrent.uploaded,
            uploadSpeed: torrent.uploadSpeed,
            ratio: torrent.ratio,
            files: torrent.files.map((f) => ({ name: f.name, length: f.length, selected: true })),
        },
    };
}
async function addTorrent(uri, opts) {
    if (!opts?.silent) {
        const ok = await showLicenseDialog();
        if (!ok)
            return null;
    }
    const wt = await loadWebTorrent();
    if (!wt) {
        if (!consentShown.value) {
            consentShown.value = true;
            void electron_1.dialog.showMessageBox({
                type: 'info',
                buttons: ['확인'],
                title: '토렌트 모듈 미설치',
                message: 'webtorrent 패키지가 설치되어 있지 않습니다.',
                detail: '"npm install webtorrent" 로 설치 후 다시 시도하세요. (optional dependency)',
            });
        }
        return null;
    }
    const id = (0, downloads_1.nextDownloadId)('tor');
    const savePath = node_path_1.default.join((0, downloads_1.defaultDownloadDir)('torrents'), id);
    await (0, promises_1.mkdir)(savePath, { recursive: true });
    const displayUri = typeof uri === 'string' ? uri : 'torrent-file';
    const meta = {
        id,
        kind: 'torrent',
        url: displayUri,
        filename: '메타데이터 로드 중…',
        savePath,
        totalBytes: 0,
        receivedBytes: 0,
        state: 'metadata',
        startedAt: Date.now(),
        torrent: {
            peers: 0,
            uploadedBytes: 0,
            uploadSpeed: 0,
            ratio: 0,
            files: [],
        },
    };
    (0, downloads_1.registerExternalDownload)(meta);
    try {
        const torrent = wt.add(uri, { path: savePath });
        torrent.on('metadata', () => {
            (0, downloads_1.updateExternalDownload)(id, {
                filename: torrent.name,
                totalBytes: torrent.length,
                ...snapshot(torrent),
            });
        });
        const broadcastProgress = throttle(() => {
            (0, downloads_1.updateExternalDownload)(id, snapshot(torrent));
        }, 1000);
        torrent.on('download', broadcastProgress);
        torrent.on('upload', broadcastProgress);
        torrent.on('done', () => {
            (0, downloads_1.updateExternalDownload)(id, {
                completedAt: Date.now(),
                ...snapshot(torrent),
                state: 'seeding',
            });
        });
        torrent.on('error', (err) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            (0, downloads_1.updateExternalDownload)(id, { state: 'failed', error: errorMsg });
        });
        handles.set(id, torrent);
    }
    catch (err) {
        (0, downloads_1.updateExternalDownload)(id, { state: 'failed', error: err.message });
    }
    return id;
}
function pauseTorrent(id) {
    const t = handles.get(id);
    if (t) {
        t.pause();
        (0, downloads_1.updateExternalDownload)(id, { state: 'paused' });
    }
}
function resumeTorrent(id) {
    const t = handles.get(id);
    if (t) {
        t.resume();
        (0, downloads_1.updateExternalDownload)(id, { state: 'active' });
    }
}
function removeTorrent(id, deleteFiles = false) {
    const t = handles.get(id);
    if (!t) {
        (0, downloads_1.removeExternalDownload)(id);
        return;
    }
    if (client) {
        client.remove(t.infoHash, { destroyStore: deleteFiles }, () => {
            handles.delete(id);
            (0, downloads_1.removeExternalDownload)(id);
            if (deleteFiles) {
                const meta = (0, downloads_1.getExternalDownload)(id);
                if (meta)
                    electron_1.shell.trashItem(meta.savePath).catch(() => undefined);
            }
        });
    }
}
function setTorrentFiles(id, selectedIndices) {
    const t = handles.get(id);
    if (!t)
        return;
    t.files.forEach((f, i) => {
        if (selectedIndices.includes(i))
            f.select();
        else
            f.deselect();
    });
}
function initTorrentBridge() {
    // downloads.ts 에서 외부 다운로드 제어 신호 받기
    downloads_1.downloadEvents.on('pause-external', (id) => pauseTorrent(id));
    downloads_1.downloadEvents.on('resume-external', (id) => resumeTorrent(id));
    downloads_1.downloadEvents.on('cancel-external', (id) => removeTorrent(id, false));
}
function initMagnetHandler() {
    // 시스템에 magnet: 핸들러로 등록
    try {
        if (process.defaultApp && process.argv.length >= 2) {
            electron_1.app.setAsDefaultProtocolClient('magnet', process.execPath, [node_path_1.default.resolve(process.argv[1] ?? '')]);
        }
        else {
            electron_1.app.setAsDefaultProtocolClient('magnet');
        }
    }
    catch (err) {
        console.warn('[torrent] could not register magnet handler', err);
    }
    electron_1.app.on('open-url', (e, url) => {
        if (url.startsWith('magnet:?')) {
            e.preventDefault();
            void addTorrent(url);
        }
    });
    electron_1.app.on('second-instance', (_e, argv) => {
        const mag = argv.find((a) => a.startsWith('magnet:?'));
        if (mag)
            void addTorrent(mag);
    });
    // 첫 실행 시 argv 에 magnet 포함 가능
    const argMagnet = process.argv.find((a) => a.startsWith('magnet:?'));
    if (argMagnet) {
        electron_1.app.whenReady().then(() => { void addTorrent(argMagnet); });
    }
}
function initTorrentResponseHook() {
    (0, response_hooks_1.onResponseStarted)((details) => {
        try {
            const ct = details.responseHeaders?.['content-type']?.[0]?.toLowerCase() ?? '';
            const url = details.url;
            const isTorrent = ct.includes('application/x-bittorrent') || /\.torrent(\?|$)/i.test(url);
            if (!isTorrent)
                return;
            if (url.startsWith('magnet:'))
                return;
            void fetchAndAdd(url);
        }
        catch {
            /* ignore */
        }
    });
}
async function fetchAndAdd(url) {
    try {
        const resp = await fetch(url);
        if (!resp.ok)
            return;
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length > 5 * 1024 * 1024)
            return;
        await addTorrent(buf);
    }
    catch (err) {
        console.warn('[torrent] fetch .torrent failed', err);
    }
}
function isTorrentDhtEnabled() {
    const downloadsSetting = (0, settings_1.getSetting)('downloads');
    return downloadsSetting.torrentDht ?? false;
}
