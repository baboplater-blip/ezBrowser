"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateEvents = void 0;
exports.initAutoUpdate = initAutoUpdate;
exports.checkForUpdates = checkForUpdates;
exports.downloadUpdate = downloadUpdate;
exports.quitAndInstall = quitAndInstall;
exports.getStatus = getStatus;
exports.setChannel = setChannel;
exports.setAutoDownload = setAutoDownload;
exports.setAutoCheck = setAutoCheck;
const electron_1 = require("electron");
const node_events_1 = require("node:events");
const settings_1 = require("../../storage/settings");
const window_service_1 = require("../../windows/window-service");
const status = { state: 'idle', current: electron_1.app.getVersion() };
exports.updateEvents = new node_events_1.EventEmitter();
// 안정 채널은 정식 릴리즈만, beta/nightly 는 GitHub prerelease 도 허용.
function applyChannel(u, channel) {
    u.channel = channel;
    u.allowPrerelease = channel !== 'latest';
}
let updater = null;
async function loadUpdater() {
    try {
        const mod = await Promise.resolve().then(() => __importStar(require('electron-updater')));
        return mod.autoUpdater;
    }
    catch {
        console.warn('[update] electron-updater not installed — skipped');
        return null;
    }
}
function broadcast() {
    for (const ctx of (0, window_service_1.getAllWindows)()) {
        if (!ctx.chrome.webContents.isDestroyed()) {
            ctx.chrome.webContents.send('update:status', { ...status });
        }
    }
    exports.updateEvents.emit('status', { ...status });
}
function setState(patch) {
    Object.assign(status, patch);
    broadcast();
}
async function initAutoUpdate() {
    if (!electron_1.app.isPackaged) {
        setState({ state: 'disabled', error: '개발 모드에서는 자동 업데이트 비활성' });
        return;
    }
    const settings = (0, settings_1.getSetting)('update');
    updater = await loadUpdater();
    if (!updater) {
        setState({ state: 'disabled', error: 'electron-updater 미설치' });
        return;
    }
    updater.autoDownload = settings.autoDownload === true;
    updater.autoInstallOnAppQuit = true;
    applyChannel(updater, settings.channel ?? 'latest');
    updater.on('checking-for-update', () => setState({ state: 'checking' }));
    updater.on('update-available', (...args) => {
        const info = args[0];
        setState({
            state: 'available',
            available: info?.version,
            releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : undefined,
            error: undefined,
        });
    });
    updater.on('update-not-available', () => setState({
        state: 'not-available', lastCheckedAt: Date.now(), error: undefined,
    }));
    updater.on('download-progress', (...args) => {
        const p = args[0];
        setState({ state: 'downloading', progress: typeof p?.percent === 'number' ? p.percent / 100 : undefined });
    });
    updater.on('update-downloaded', (...args) => {
        const info = args[0];
        setState({ state: 'downloaded', available: info?.version });
    });
    updater.on('error', (...args) => {
        const err = args[0];
        setState({ state: 'error', error: err?.message ?? 'unknown error' });
    });
    if (settings.autoCheck) {
        // 부팅 1분 후 첫 체크, 이후 6시간마다
        setTimeout(() => void checkForUpdates(true), 60_000);
        setInterval(() => void checkForUpdates(true), 6 * 60 * 60 * 1000);
    }
}
async function checkForUpdates(silent = false) {
    if (!updater) {
        if (!silent)
            setState({ state: 'disabled', error: '업데이트 시스템 미초기화' });
        return { ...status };
    }
    try {
        await updater.checkForUpdates();
    }
    catch (err) {
        setState({ state: 'error', error: err.message });
    }
    return { ...status };
}
async function downloadUpdate() {
    if (!updater)
        return { ...status };
    try {
        await updater.downloadUpdate();
    }
    catch (err) {
        setState({ state: 'error', error: err.message });
    }
    return { ...status };
}
function quitAndInstall() {
    updater?.quitAndInstall();
}
function getStatus() {
    return { ...status };
}
function setChannel(channel) {
    (0, settings_1.setNestedSetting)('update.channel', channel);
    if (updater)
        applyChannel(updater, channel);
}
function setAutoDownload(enabled) {
    (0, settings_1.setNestedSetting)('update.autoDownload', enabled);
    if (updater)
        updater.autoDownload = enabled;
}
function setAutoCheck(enabled) {
    (0, settings_1.setNestedSetting)('update.autoCheck', enabled);
    // autoCheck 토글은 다음 부팅부터 반영 (setInterval 변경 회피)
}
