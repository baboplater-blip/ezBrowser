"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tabSleepEvents = void 0;
exports.getSleepStats = getSleepStats;
exports.sweepNow = sweepNow;
exports.wakeTab = wakeTab;
exports.startTabSleepLoop = startTabSleepLoop;
exports.stopTabSleepLoop = stopTabSleepLoop;
const node_events_1 = require("node:events");
const settings_1 = require("../../storage/settings");
const tab_service_1 = require("../../tabs/tab-service");
// 기본 30분 비활성 → 슬립. settings 에서 조정 가능.
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
let timer = null;
let sleepCount = 0;
let lastSweepAt = 0;
exports.tabSleepEvents = new node_events_1.EventEmitter();
function idleThresholdMs() {
    try {
        const v = (0, settings_1.getSetting)('performance')?.tabSleepMinutes;
        if (typeof v === 'number' && v >= 1)
            return v * 60 * 1000;
    }
    catch { /* ignore */ }
    return DEFAULT_IDLE_MS;
}
function isSleepEnabled() {
    try {
        const v = (0, settings_1.getSetting)('performance')?.tabSleepEnabled;
        return v !== false;
    }
    catch {
        return true;
    }
}
function getSleepStats() {
    return {
        sleepCount,
        lastSweepAt,
        thresholdMs: idleThresholdMs(),
        enabled: isSleepEnabled(),
    };
}
function sweepNow() {
    lastSweepAt = Date.now();
    if (!isSleepEnabled())
        return { discarded: 0, skipped: 0 };
    const threshold = idleThresholdMs();
    const now = Date.now();
    let discarded = 0;
    let skipped = 0;
    for (const t of (0, tab_service_1.getAllTabRecordsForSleep)()) {
        if (t.discarded) {
            skipped += 1;
            continue;
        }
        if (t.pinned || (0, tab_service_1.isPinnedTab)(t.id)) {
            skipped += 1;
            continue;
        }
        if ((0, tab_service_1.isTabActive)(t.id)) {
            skipped += 1;
            continue;
        }
        if (now - t.lastActiveAt < threshold) {
            skipped += 1;
            continue;
        }
        const url = t.url;
        if (!url) {
            skipped += 1;
            continue;
        }
        if (/^browser:|^about:/i.test(url)) {
            skipped += 1;
            continue;
        }
        if (url === 'about:blank') {
            skipped += 1;
            continue;
        }
        (0, tab_service_1.discardTab)(t.id);
        discarded += 1;
    }
    sleepCount += discarded;
    if (discarded > 0)
        exports.tabSleepEvents.emit('changed');
    return { discarded, skipped };
}
function wakeTab(tabId) {
    return (0, tab_service_1.undiscardTab)(tabId);
}
function startTabSleepLoop() {
    if (timer)
        return;
    timer = setInterval(() => { sweepNow(); }, CHECK_INTERVAL_MS);
}
function stopTabSleepLoop() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
