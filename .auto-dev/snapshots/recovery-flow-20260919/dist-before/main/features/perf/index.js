"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.perfEvents = void 0;
exports.recordWhenReady = recordWhenReady;
exports.recordFirstWindowReady = recordFirstWindowReady;
exports.recordFirstTabLoaded = recordFirstTabLoaded;
exports.getMilestones = getMilestones;
exports.readHistory = readHistory;
exports.getReport = getReport;
exports.evaluateBudget = evaluateBudget;
const electron_1 = require("electron");
const node_events_1 = require("node:events");
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = require("node:fs");
// process.uptime() 시작 기준 — boot 부터 경과 시간
const BOOT_NS = process.hrtime.bigint();
function elapsedMs() {
    return Number((process.hrtime.bigint() - BOOT_NS) / 1000000n);
}
const milestones = {
    whenReadyMs: null,
    firstWindowReadyMs: null,
    firstTabLoadedMs: null,
    memoryAt30sMB: null,
    memoryNowMB: 0,
    startedAt: Date.now(),
    version: electron_1.app.getVersion(),
    packaged: electron_1.app.isPackaged,
};
const BUDGET = { coldStartMs: 2000, blankWindowMemoryMB: 250 };
const HISTORY_FILE = () => node_path_1.default.join(electron_1.app.getPath('userData'), 'logs', 'perf.json');
const HISTORY_LIMIT = 30;
exports.perfEvents = new node_events_1.EventEmitter();
function totalMemoryMB() {
    const m = electron_1.app.getAppMetrics();
    const total = m.reduce((s, p) => s + (p.memory?.workingSetSize ?? 0), 0);
    return Math.round(total / 1024);
}
function recordWhenReady() {
    if (milestones.whenReadyMs !== null)
        return;
    milestones.whenReadyMs = elapsedMs();
    exports.perfEvents.emit('milestone', { ...milestones });
}
function recordFirstWindowReady() {
    if (milestones.firstWindowReadyMs !== null)
        return;
    milestones.firstWindowReadyMs = elapsedMs();
    exports.perfEvents.emit('milestone', { ...milestones });
}
function recordFirstTabLoaded() {
    if (milestones.firstTabLoadedMs !== null)
        return;
    milestones.firstTabLoadedMs = elapsedMs();
    exports.perfEvents.emit('milestone', { ...milestones });
    setTimeout(() => { void captureMemory30s(); }, 30_000);
}
async function captureMemory30s() {
    milestones.memoryAt30sMB = totalMemoryMB();
    exports.perfEvents.emit('milestone', { ...milestones });
    await appendHistory();
}
function getMilestones() {
    milestones.memoryNowMB = totalMemoryMB();
    return { ...milestones };
}
async function readHistory() {
    try {
        const raw = await node_fs_1.promises.readFile(HISTORY_FILE(), 'utf-8');
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    }
    catch {
        return [];
    }
}
async function appendHistory() {
    try {
        await node_fs_1.promises.mkdir(node_path_1.default.dirname(HISTORY_FILE()), { recursive: true });
        const history = await readHistory();
        history.push({ ...milestones });
        while (history.length > HISTORY_LIMIT)
            history.shift();
        await node_fs_1.promises.writeFile(HISTORY_FILE(), JSON.stringify(history, null, 2), 'utf-8');
    }
    catch (err) {
        console.warn('[perf] write history failed', err);
    }
}
async function getReport() {
    return {
        current: getMilestones(),
        budget: { ...BUDGET },
        history: await readHistory(),
    };
}
function evaluateBudget(m) {
    const issues = [];
    const cold = m.firstWindowReadyMs ?? m.firstTabLoadedMs;
    if (cold !== null && cold > BUDGET.coldStartMs) {
        issues.push(`콜드 스타트 ${cold}ms > 예산 ${BUDGET.coldStartMs}ms`);
    }
    if (m.memoryAt30sMB !== null && m.memoryAt30sMB > BUDGET.blankWindowMemoryMB) {
        issues.push(`30초 메모리 ${m.memoryAt30sMB}MB > 예산 ${BUDGET.blankWindowMemoryMB}MB`);
    }
    return { pass: issues.length === 0, issues };
}
