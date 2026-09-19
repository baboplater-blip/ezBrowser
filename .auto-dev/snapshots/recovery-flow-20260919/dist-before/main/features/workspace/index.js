"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.workspaceEvents = void 0;
exports.initWorkspaces = initWorkspaces;
exports.listWorkspaces = listWorkspaces;
exports.getWorkspace = getWorkspace;
exports.getActiveWorkspaceId = getActiveWorkspaceId;
exports.getActiveWorkspace = getActiveWorkspace;
exports.getActivePartition = getActivePartition;
exports.getState = getState;
exports.createWorkspace = createWorkspace;
exports.updateWorkspace = updateWorkspace;
exports.removeWorkspace = removeWorkspace;
exports.setActiveWorkspace = setActiveWorkspace;
exports.reorderWorkspaces = reorderWorkspaces;
exports.nextWorkspaceId = nextWorkspaceId;
const electron_1 = require("electron");
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const constants_1 = require("../../../shared/constants");
const COLORS = ['blue', 'purple', 'green', 'orange', 'pink', 'red', 'yellow', 'gray'];
const workspaces = new Map();
let activeId = '';
let loaded = false;
let counter = 0;
exports.workspaceEvents = new node_events_1.EventEmitter();
function filePath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'workspaces.json');
}
function nextId() {
    counter += 1;
    return `ws-${Date.now().toString(36)}-${counter}`;
}
function partitionOf(id) {
    return `persist:ws-${id}`;
}
function nextColor() {
    const used = new Set();
    for (const w of workspaces.values())
        used.add(w.color);
    for (const c of COLORS)
        if (!used.has(c))
            return c;
    return COLORS[workspaces.size % COLORS.length];
}
function nextName() {
    let n = workspaces.size + 1;
    const used = new Set(Array.from(workspaces.values()).map((w) => w.name));
    while (used.has(`스페이스 ${n}`))
        n += 1;
    return `스페이스 ${n}`;
}
// ===== 저장소 =====
async function ensureDir() {
    await (0, promises_1.mkdir)(node_path_1.default.dirname(filePath()), { recursive: true });
}
async function loadAll() {
    if (loaded)
        return;
    loaded = true;
    await ensureDir();
    if (!(0, node_fs_1.existsSync)(filePath()))
        return;
    try {
        const raw = await (0, promises_1.readFile)(filePath(), 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.workspaces)) {
            for (const w of data.workspaces) {
                if (!w || typeof w.id !== 'string')
                    continue;
                workspaces.set(w.id, normalize(w));
            }
        }
        if (typeof data.activeId === 'string' && workspaces.has(data.activeId)) {
            activeId = data.activeId;
        }
    }
    catch (err) {
        console.warn('[workspace] load failed', err);
    }
}
function normalize(w) {
    const id = w.id ?? nextId();
    return {
        id,
        name: (w.name ?? '').trim() || '이름 없는 스페이스',
        color: COLORS.includes(w.color) ? w.color : 'gray',
        homeUrl: w.homeUrl ?? constants_1.NEW_TAB_URL,
        partition: w.partition ?? partitionOf(id),
        createdAt: w.createdAt ?? Date.now(),
        updatedAt: w.updatedAt ?? Date.now(),
        position: typeof w.position === 'number' ? w.position : workspaces.size,
    };
}
let persistTimer = null;
async function persist() {
    if (persistTimer)
        clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
        persistTimer = null;
        await ensureDir();
        const data = { workspaces: getOrderedList(), activeId };
        try {
            await (0, promises_1.writeFile)(filePath(), JSON.stringify(data, null, 2), 'utf-8');
        }
        catch (err) {
            console.warn('[workspace] persist failed', err);
        }
    }, 250);
}
function getOrderedList() {
    return Array.from(workspaces.values()).sort((a, b) => a.position - b.position);
}
// ===== Init =====
async function initWorkspaces() {
    await loadAll();
    if (workspaces.size === 0) {
        const id = nextId();
        const ws = {
            id, name: '기본', color: 'gray', homeUrl: constants_1.NEW_TAB_URL,
            partition: partitionOf(id),
            createdAt: Date.now(), updatedAt: Date.now(), position: 0,
        };
        workspaces.set(id, ws);
        activeId = id;
        await persist();
    }
    if (!activeId || !workspaces.has(activeId)) {
        const first = getOrderedList()[0];
        if (first)
            activeId = first.id;
    }
}
// ===== CRUD =====
function listWorkspaces() {
    return getOrderedList();
}
function getWorkspace(id) {
    return workspaces.get(id) ?? null;
}
function getActiveWorkspaceId() {
    return activeId;
}
function getActiveWorkspace() {
    return workspaces.get(activeId) ?? null;
}
function getActivePartition() {
    const w = getActiveWorkspace();
    return w?.partition ?? `persist:ws-default`;
}
function getState() {
    return { workspaces: getOrderedList(), activeId };
}
async function createWorkspace(input) {
    const id = nextId();
    const ws = {
        id,
        name: (input?.name ?? '').trim() || nextName(),
        color: input?.color ?? nextColor(),
        homeUrl: input?.homeUrl ?? constants_1.NEW_TAB_URL,
        partition: partitionOf(id),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        position: workspaces.size,
    };
    workspaces.set(id, ws);
    await persist();
    exports.workspaceEvents.emit('created', ws);
    exports.workspaceEvents.emit('changed');
    return ws;
}
async function updateWorkspace(id, patch) {
    const ws = workspaces.get(id);
    if (!ws)
        return null;
    // 렌더러가 보낸 값을 **타입까지 확인**하고 받는다. 2026-09-07 임무 19 실측:
    // 검증이 없어 `color` 에 객체 `{}` 가 그대로 저장·영속됐다(UI 가 그 값을 CSS 로 쓴다).
    // `name` 은 문자열이 아니면 `.trim()` 에서 예외가 나 업데이트 자체가 실패했다.
    const str = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
    const next = {
        ...ws,
        name: patch.name !== undefined ? str(patch.name, ws.name) : ws.name,
        color: patch.color !== undefined ? str(patch.color, ws.color) : ws.color,
        homeUrl: patch.homeUrl !== undefined ? str(patch.homeUrl, ws.homeUrl) : ws.homeUrl,
        updatedAt: Date.now(),
    };
    workspaces.set(id, next);
    await persist();
    exports.workspaceEvents.emit('updated', next);
    exports.workspaceEvents.emit('changed');
    return next;
}
async function removeWorkspace(id) {
    if (workspaces.size <= 1)
        return { removed: false, newActiveId: activeId };
    const ws = workspaces.get(id);
    if (!ws)
        return { removed: false, newActiveId: activeId };
    const wasActive = activeId === id;
    workspaces.delete(id);
    // 인덱스 재정렬
    getOrderedList().forEach((w, i) => { w.position = i; });
    if (wasActive) {
        const first = getOrderedList()[0];
        activeId = first ? first.id : '';
    }
    await persist();
    exports.workspaceEvents.emit('removed', { id, partition: ws.partition });
    // 활성 워크스페이스를 지웠으면 새 활성으로 'activated' 를 발생시켜야 tab-service 가 새 워크스페이스의
    // 탭을 보이게 하고(레이아웃 재적용) 탭이 없으면 홈 탭을 만든다 — 안 그러면 빈 창이 된다.
    if (wasActive && activeId)
        exports.workspaceEvents.emit('activated', { id: activeId, prev: id });
    exports.workspaceEvents.emit('changed');
    return { removed: true, newActiveId: activeId };
}
async function setActiveWorkspace(id) {
    if (!workspaces.has(id))
        return false;
    if (activeId === id)
        return true;
    const prev = activeId;
    activeId = id;
    await persist();
    exports.workspaceEvents.emit('activated', { id, prev });
    exports.workspaceEvents.emit('changed');
    return true;
}
async function reorderWorkspaces(orderedIds) {
    orderedIds.forEach((id, i) => {
        const w = workspaces.get(id);
        if (w)
            w.position = i;
    });
    await persist();
    exports.workspaceEvents.emit('changed');
}
function nextWorkspaceId(direction) {
    const list = getOrderedList();
    if (list.length <= 1)
        return null;
    const i = list.findIndex((w) => w.id === activeId);
    if (i < 0)
        return list[0]?.id ?? null;
    const next = (i + direction + list.length) % list.length;
    return list[next]?.id ?? null;
}
