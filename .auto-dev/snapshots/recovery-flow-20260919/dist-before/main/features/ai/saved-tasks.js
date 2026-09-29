"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.savedTaskEvents = void 0;
exports.initSavedTasks = initSavedTasks;
exports.flushSavedTasks = flushSavedTasks;
exports.listSavedTasks = listSavedTasks;
exports.addSavedTask = addSavedTask;
exports.removeSavedTask = removeSavedTask;
exports.renameSavedTask = renameSavedTask;
exports.touchSavedTask = touchSavedTask;
const electron_1 = require("electron");
const node_crypto_1 = require("node:crypto");
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
exports.savedTaskEvents = new node_events_1.EventEmitter();
const MAX_TASKS = 50;
let cache = null;
let writeTimer = null;
let dirty = false;
let quitHooked = false;
function filePath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'ai-agent-tasks.json');
}
function isValid(t) {
    if (!t || typeof t !== 'object')
        return false;
    const o = t;
    return typeof o.id === 'string' && typeof o.task === 'string';
}
function initSavedTasks() {
    if (!quitHooked) {
        quitHooked = true;
        try {
            electron_1.app.on('before-quit', flushSavedTasks);
        }
        catch { /* ignore */ }
    }
    if (cache !== null)
        return;
    try {
        if ((0, node_fs_1.existsSync)(filePath())) {
            const raw = JSON.parse((0, node_fs_1.readFileSync)(filePath(), 'utf-8'));
            cache = Array.isArray(raw?.tasks) ? raw.tasks.filter(isValid) : [];
        }
        else {
            cache = [];
        }
    }
    catch (err) {
        console.warn('[ai] saved tasks load failed', err);
        cache = [];
    }
}
function all() {
    if (cache === null)
        initSavedTasks();
    return cache ?? [];
}
function schedulePersist() {
    dirty = true;
    if (writeTimer)
        clearTimeout(writeTimer);
    writeTimer = setTimeout(() => { void persist(); }, 300);
}
async function persist() {
    try {
        await (0, promises_1.mkdir)(node_path_1.default.dirname(filePath()), { recursive: true });
        const tmp = filePath() + '.tmp';
        await (0, promises_1.writeFile)(tmp, JSON.stringify({ version: 1, tasks: all() }), 'utf-8');
        await (0, promises_1.rename)(tmp, filePath());
        dirty = false;
    }
    catch (err) {
        console.warn('[ai] saved tasks persist failed', err);
    }
}
function flushSavedTasks() {
    if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
    }
    if (!dirty)
        return;
    try {
        (0, node_fs_1.mkdirSync)(node_path_1.default.dirname(filePath()), { recursive: true });
        const tmp = filePath() + '.tmp'; // 원자적 쓰기 — 종료 중 크래시로 파일이 잘리지 않도록
        (0, node_fs_1.writeFileSync)(tmp, JSON.stringify({ version: 1, tasks: all() }), 'utf-8');
        (0, node_fs_1.renameSync)(tmp, filePath());
        dirty = false;
    }
    catch (err) {
        console.warn('[ai] saved tasks flush failed', err);
    }
}
function emitChanged() {
    exports.savedTaskEvents.emit('changed', listSavedTasks());
}
function listSavedTasks() {
    return all().slice().sort((a, b) => b.createdAt - a.createdAt);
}
function deriveName(task) {
    const t = task.replace(/\s+/g, ' ').trim();
    if (!t)
        return '작업';
    return t.length > 30 ? t.slice(0, 30) + '…' : t;
}
function addSavedTask(task, name) {
    const t = String(task ?? '').trim();
    if (!t)
        return null;
    const item = {
        id: (0, node_crypto_1.randomUUID)(),
        name: name && name.trim() ? name.trim().slice(0, 60) : deriveName(t),
        task: t,
        createdAt: Date.now(),
    };
    const list = all();
    list.unshift(item);
    if (list.length > MAX_TASKS)
        cache = list.slice(0, MAX_TASKS);
    schedulePersist();
    emitChanged();
    return item;
}
function removeSavedTask(id) {
    const list = all();
    const idx = list.findIndex((t) => t.id === id);
    if (idx < 0)
        return;
    list.splice(idx, 1);
    schedulePersist();
    emitChanged();
}
function renameSavedTask(id, name) {
    const t = all().find((x) => x.id === id);
    if (!t)
        return;
    t.name = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || t.name;
    schedulePersist();
    emitChanged();
}
function touchSavedTask(id) {
    const t = all().find((x) => x.id === id);
    if (!t)
        return;
    t.lastRunAt = Date.now();
    schedulePersist();
    emitChanged();
}
