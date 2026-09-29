"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSystemIpc = registerSystemIpc;
const electron_1 = require("electron");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const ipc_channels_1 = require("../../shared/ipc-channels");
const trust_1 = require("./trust");
const tab_sleep_1 = require("../features/tab-sleep");
const tab_service_1 = require("../tabs/tab-service");
let licenseCache = null;
/**
 * 빌드 시점에 구운 성능 기준선(`build/gen-perf-baseline.mjs` 산출물).
 * 없으면 null — 페이지는 "측정 기록 없음"을 보인다. 하드코딩된 숫자는 낡으면 거짓말이 된다.
 */
let perfBaselineCache;
async function loadPerfBaseline() {
    if (perfBaselineCache !== undefined)
        return perfBaselineCache ?? null;
    try {
        const file = node_path_1.default.join(electron_1.app.getAppPath(), 'app', 'main', 'storage', 'perf-baseline.json');
        perfBaselineCache = JSON.parse(await (0, promises_1.readFile)(file, 'utf-8'));
    }
    catch {
        perfBaselineCache = null;
    }
    return perfBaselineCache ?? null;
}
async function loadLicenses() {
    if (licenseCache)
        return licenseCache;
    try {
        const file = node_path_1.default.join(electron_1.app.getAppPath(), 'app', 'main', 'storage', 'oss-licenses.json');
        const raw = await (0, promises_1.readFile)(file, 'utf-8');
        const data = JSON.parse(raw);
        const out = [];
        for (const [key, val] of Object.entries(data)) {
            // key 형식: "name@version"
            const at = key.lastIndexOf('@');
            const name = at > 0 ? key.slice(0, at) : key;
            const version = at > 0 ? key.slice(at + 1) : '';
            const licenses = Array.isArray(val.licenses) ? val.licenses.join(', ') : (val.licenses ?? 'Unknown');
            out.push({ name, version, licenses, repository: val.repository, publisher: val.publisher });
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        licenseCache = out;
        return out;
    }
    catch {
        return [];
    }
}
async function collectMetrics() {
    const metrics = electron_1.app.getAppMetrics();
    const rows = metrics.map((m) => ({
        pid: m.pid,
        type: String(m.type ?? 'Unknown'),
        name: m.name,
        memoryMB: Math.round((m.memory?.workingSetSize ?? 0) / 1024),
        cpu: Number((m.cpu?.percentCPUUsage ?? 0).toFixed(2)),
    })).sort((a, b) => b.memoryMB - a.memoryMB);
    const memoryMB = rows.reduce((s, r) => s + r.memoryMB, 0);
    // getAppMetrics().workingSetSize 는 프로세스 간 공유 페이지를 중복 집계해 실제 물리 사용량보다
    // 크게 나온다(CLAUDE.md: 5~7배). 메인 프로세스만이라도 **정확한 private** 을 함께 준다.
    let mainPrivateMB = 0;
    try {
        const info = await process.getProcessMemoryInfo();
        mainPrivateMB = Math.round((info.private ?? 0) / 1024);
    }
    catch { /* 플랫폼 미지원 시 0 */ }
    const avgCpu = rows.length > 0
        ? Number((rows.reduce((s, r) => s + r.cpu, 0) / rows.length).toFixed(2))
        : 0;
    return {
        processes: rows,
        totals: { processCount: rows.length, memoryMB, avgCpu, mainPrivateMB },
        tabs: {
            total: (0, tab_service_1.getTotalTabCount)(),
            discarded: (0, tab_service_1.getDiscardedCount)(),
            active: (0, tab_service_1.getTotalTabCount)() - (0, tab_service_1.getDiscardedCount)(),
        },
        sleep: (0, tab_sleep_1.getSleepStats)(),
        app: {
            version: electron_1.app.getVersion(),
            electronVersion: process.versions.electron,
            chromeVersion: process.versions.chrome,
            nodeVersion: process.versions.node,
            platform: process.platform,
            arch: process.arch,
        },
        uptime: {
            appMs: Date.now() - bootTime,
            processMs: Math.round(process.uptime() * 1000),
        },
    };
}
const bootTime = Date.now();
function registerSystemIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.system.metrics, async (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        const m = await collectMetrics();
        return { ...m, perfBaseline: await loadPerfBaseline() };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.system.bootInfo, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return {
            bootTime,
            now: Date.now(),
            uptimeMs: Date.now() - bootTime,
        };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.system.sweepTabSleep, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, tab_sleep_1.sweepNow)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.system.wakeTab, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, tab_sleep_1.wakeTab)(args.tabId);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.system.licenses, async (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { app: null, packages: [] };
        return {
            app: {
                version: electron_1.app.getVersion(),
                electronVersion: process.versions.electron,
                chromeVersion: process.versions.chrome,
            },
            packages: await loadLicenses(),
        };
    });
}
