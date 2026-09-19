"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.modEvents = void 0;
exports.initModApi = initModApi;
exports.listMods = listMods;
exports.setModEnabled = setModEnabled;
exports.reloadMod = reloadMod;
exports.removeMod = removeMod;
exports.dispatchTabCreated = dispatchTabCreated;
exports.dispatchTabClosed = dispatchTabClosed;
exports.dispatchTabNavigated = dispatchTabNavigated;
exports.collectMenuItems = collectMenuItems;
exports.listMenuItemsMeta = listMenuItemsMeta;
exports.invokeMenuItem = invokeMenuItem;
const electron_1 = require("electron");
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const node_vm_1 = __importDefault(require("node:vm"));
const window_service_1 = require("../../windows/window-service");
const tab_service_1 = require("../../tabs/tab-service");
const mods = new Map();
let loaded = false;
// 각 모드 storage 의 동기 flush 함수 — 앱 종료 시 일괄 호출(250ms 디바운스 손실 방지)
const storageFlushers = [];
let quitHookBound = false;
exports.modEvents = new node_events_1.EventEmitter();
function clearModTimers(mod) {
    for (const t of mod.timers) {
        clearTimeout(t);
        clearInterval(t);
    }
    mod.timers.clear();
}
function rootDir() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'mods');
}
function storageDirOf(id) {
    return node_path_1.default.join(rootDir(), id, 'storage');
}
async function ensureDir(p) {
    await (0, promises_1.mkdir)(p, { recursive: true });
}
function isAllowedPermission(p) {
    return p === 'tabs' || p === 'menu' || p === 'storage' || p === 'network' || p === 'node';
}
function normalizeManifest(raw, id) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : id;
    const description = typeof r.description === 'string' ? r.description : '';
    const version = typeof r.version === 'string' && r.version.trim() ? r.version.trim() : '0.0.0';
    const author = typeof r.author === 'string' ? r.author : '';
    const permsRaw = Array.isArray(r.permissions) ? r.permissions : [];
    const permissions = [];
    for (const p of permsRaw) {
        if (typeof p === 'string' && isAllowedPermission(p))
            permissions.push(p);
    }
    return { id, name, description, version, author, permissions };
}
function makeStorageApi(modId) {
    const dir = storageDirOf(modId);
    const file = node_path_1.default.join(dir, 'kv.json');
    let cache = {};
    let cacheLoaded = false;
    function loadSync() {
        if (cacheLoaded)
            return;
        cacheLoaded = true;
        try {
            if ((0, node_fs_1.existsSync)(file)) {
                const raw = require('node:fs').readFileSync(file, 'utf-8');
                cache = JSON.parse(raw);
            }
        }
        catch (err) {
            console.warn(`[mod:${modId}] storage load failed`, err);
        }
    }
    let writeTimer = null;
    let dirtyKv = false;
    function scheduleWrite() {
        dirtyKv = true;
        if (writeTimer)
            clearTimeout(writeTimer);
        writeTimer = setTimeout(async () => {
            writeTimer = null;
            dirtyKv = false;
            try {
                await ensureDir(dir);
                await (0, promises_1.writeFile)(file, JSON.stringify(cache, null, 2), 'utf-8');
            }
            catch (err) {
                console.warn(`[mod:${modId}] storage persist failed`, err);
            }
        }, 250);
    }
    // 종료 시 대기 중인 변경을 동기 기록 (디바운스 손실 방지)
    storageFlushers.push(() => {
        if (!dirtyKv)
            return;
        dirtyKv = false;
        if (writeTimer) {
            clearTimeout(writeTimer);
            writeTimer = null;
        }
        try {
            require('node:fs').mkdirSync(dir, { recursive: true });
            require('node:fs').writeFileSync(file, JSON.stringify(cache, null, 2), 'utf-8');
        }
        catch (err) {
            console.warn(`[mod:${modId}] storage sync flush failed`, err);
        }
    });
    return {
        get: (k) => { loadSync(); return cache[k]; },
        set: (k, v) => { loadSync(); cache[k] = v; scheduleWrite(); },
    };
}
function firstWindowId() {
    return (0, window_service_1.getAllWindows)()[0]?.id ?? null;
}
function makeApiForMod(mod, nodeGranted) {
    const perms = new Set(mod.manifest.permissions);
    const api = {
        info: { ...mod.manifest },
        log: (...args) => console.log(`[mod:${mod.id}]`, ...args),
        toast: (msg) => {
            const text = String(msg ?? '').slice(0, 200);
            for (const ctx of (0, window_service_1.getAllWindows)()) {
                ctx.chrome.webContents.send('toast:show', { message: `[${mod.manifest.name}] ${text}`, ts: Date.now() });
            }
        },
    };
    if (perms.has('tabs')) {
        api.tabs = {
            // 관찰
            onCreated: (cb) => {
                if (typeof cb === 'function')
                    mod.tabListeners.created.push(cb);
            },
            onClosed: (cb) => {
                if (typeof cb === 'function')
                    mod.tabListeners.closed.push(cb);
            },
            onNavigated: (cb) => {
                if (typeof cb === 'function')
                    mod.tabListeners.navigated.push(cb);
            },
            // 조작
            list: () => (0, tab_service_1.getAllTabs)().map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })),
            create: (url) => {
                const windowId = firstWindowId();
                if (!windowId)
                    return null;
                const safe = typeof url === 'string' && /^https?:|^browser:/i.test(url) ? url : undefined;
                const t = (0, tab_service_1.createTab)({ windowId, url: safe });
                return t.id;
            },
            navigate: (tabId, url) => {
                if (typeof tabId !== 'string' || typeof url !== 'string')
                    return;
                if (!/^https?:|^browser:/i.test(url))
                    return;
                (0, tab_service_1.navigateTab)(tabId, url);
            },
            close: (tabId) => { if (typeof tabId === 'string')
                (0, tab_service_1.closeTab)(tabId); },
            active: () => {
                const windowId = firstWindowId();
                if (!windowId)
                    return null;
                const t = (0, tab_service_1.listTabs)(windowId).find((x) => x.active);
                return t ? { id: t.id, url: t.url, title: t.title } : null;
            },
        };
    }
    if (perms.has('menu')) {
        api.menu = {
            add: (item) => {
                if (!item || typeof item.label !== 'string' || typeof item.click !== 'function')
                    return;
                mod.menuItems.push({ label: item.label.slice(0, 80), click: item.click });
            },
        };
    }
    if (perms.has('storage')) {
        api.storage = makeStorageApi(mod.id);
    }
    if (perms.has('network')) {
        api.net = {
            // 메인 프로세스 대행 fetch (CORS 우회). 텍스트/JSON 반환.
            fetch: async (url, opts) => {
                if (typeof url !== 'string' || !/^https?:/i.test(url)) {
                    throw new Error('net.fetch: http(s) URL 만 허용됩니다');
                }
                const res = await electron_1.net.fetch(url, {
                    method: opts?.method ?? 'GET',
                    headers: opts?.headers,
                    body: opts?.body,
                });
                const text = await res.text();
                return {
                    ok: res.ok,
                    status: res.status,
                    text,
                    json: () => { try {
                        return JSON.parse(text);
                    }
                    catch {
                        return null;
                    } },
                };
            },
        };
    }
    if (perms.has('node') && nodeGranted) {
        // 사용자가 명시적으로 Node 권한을 승인한 모드만 — 확장보다 깊은 후킹 허용 (userChrome.js 정신)
        api.node = {
            require: (m) => require(m),
            process,
            modDir: mod.modPath,
        };
    }
    return api;
}
function executeModCode(mod, code, nodeGranted) {
    const api = makeApiForMod(mod, nodeGranted);
    // 모드가 등록하는 타이머를 추적 — 비활성화/종료 시 일괄 취소
    const trackedSetTimeout = (fn, ms) => {
        const t = setTimeout(() => { mod.timers.delete(t); try {
            fn();
        }
        catch (e) {
            console.warn(`[mod:${mod.id}] timer error`, e);
        } }, ms);
        mod.timers.add(t);
        return t;
    };
    const trackedSetInterval = (fn, ms) => {
        const t = setInterval(() => { try {
            fn();
        }
        catch (e) {
            console.warn(`[mod:${mod.id}] interval error`, e);
        } }, ms);
        mod.timers.add(t);
        return t;
    };
    const trackedClear = (t) => { mod.timers.delete(t); clearTimeout(t); clearInterval(t); };
    const context = node_vm_1.default.createContext({
        mod: api,
        console: {
            log: (...a) => console.log(`[mod:${mod.id}]`, ...a),
            warn: (...a) => console.warn(`[mod:${mod.id}]`, ...a),
            error: (...a) => console.error(`[mod:${mod.id}]`, ...a),
        },
        setTimeout: trackedSetTimeout,
        clearTimeout: trackedClear,
        setInterval: trackedSetInterval,
        clearInterval: trackedClear,
        URL, URLSearchParams,
    });
    try {
        const script = new node_vm_1.default.Script(code, { filename: `mod:${mod.id}/index.js` });
        script.runInContext(context, { timeout: 5000 });
        mod.hasError = false;
        mod.errorMessage = undefined;
    }
    catch (err) {
        mod.hasError = true;
        mod.errorMessage = err instanceof Error ? err.message : String(err);
        console.warn(`[mod:${mod.id}] exec failed`, err);
    }
}
async function loadMod(id, modPath) {
    const manifestPath = node_path_1.default.join(modPath, 'manifest.json');
    const indexPath = node_path_1.default.join(modPath, 'index.js');
    if (!(0, node_fs_1.existsSync)(manifestPath) || !(0, node_fs_1.existsSync)(indexPath)) {
        console.warn(`[mod] ${id} missing manifest.json or index.js`);
        return null;
    }
    try {
        const raw = await (0, promises_1.readFile)(manifestPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const manifest = normalizeManifest(parsed, id);
        if (!manifest)
            return null;
        const mod = {
            id, modPath, manifest,
            enabled: false, hasError: false,
            tabListeners: { created: [], closed: [], navigated: [] },
            menuItems: [],
            timers: new Set(),
        };
        return mod;
    }
    catch (err) {
        console.warn(`[mod:${id}] manifest parse failed`, err);
        return null;
    }
}
// ===== Node 권한 동의 (옵트인) =====
function nodeGrantsPath() {
    return node_path_1.default.join(rootDir(), '_node-grants.json');
}
async function readNodeGrants() {
    const file = nodeGrantsPath();
    if (!(0, node_fs_1.existsSync)(file))
        return {};
    try {
        return JSON.parse(await (0, promises_1.readFile)(file, 'utf-8'));
    }
    catch {
        return {};
    }
}
async function writeNodeGrant(id, granted) {
    const grants = await readNodeGrants();
    grants[id] = granted;
    try {
        await ensureDir(rootDir());
        await (0, promises_1.writeFile)(nodeGrantsPath(), JSON.stringify(grants, null, 2), 'utf-8');
    }
    catch (err) {
        console.warn('[mod] write node grants failed', err);
    }
}
/** Node 권한이 필요한 모드면 사용자 동의를 받는다(1회, 영구 저장). 동의 여부 반환. */
async function ensureNodeGrant(mod) {
    if (!mod.manifest.permissions.includes('node'))
        return false;
    const grants = await readNodeGrants();
    if (typeof grants[mod.id] === 'boolean')
        return grants[mod.id];
    const result = await electron_1.dialog.showMessageBox({
        type: 'warning',
        buttons: ['거부', 'Node 권한 허용'],
        defaultId: 0,
        cancelId: 0,
        title: 'Node 권한 요청',
        message: `모드 "${mod.manifest.name}" 가 Node.js 시스템 접근을 요청합니다.`,
        detail: '이 권한은 파일 시스템·프로세스 등 컴퓨터 전체에 접근할 수 있어 확장보다 강력하고 위험합니다. '
            + '신뢰하는 모드에만 허용하세요. (이 결정은 저장되며 모드 페이지에서 변경할 수 있습니다)',
    });
    const granted = result.response === 1;
    await writeNodeGrant(mod.id, granted);
    return granted;
}
async function activateMod(mod) {
    const indexPath = node_path_1.default.join(mod.modPath, 'index.js');
    try {
        const code = await (0, promises_1.readFile)(indexPath, 'utf-8');
        const nodeGranted = await ensureNodeGrant(mod);
        // 활성화 전 listener·타이머 초기화 (재로드 시 중복 방지)
        clearModTimers(mod);
        mod.tabListeners = { created: [], closed: [], navigated: [] };
        mod.menuItems = [];
        executeModCode(mod, code, nodeGranted);
        mod.enabled = true;
    }
    catch (err) {
        mod.hasError = true;
        mod.errorMessage = err instanceof Error ? err.message : String(err);
        console.warn(`[mod:${mod.id}] activate failed`, err);
    }
}
async function readEnabledState() {
    const file = node_path_1.default.join(rootDir(), '_state.json');
    if (!(0, node_fs_1.existsSync)(file))
        return {};
    try {
        const raw = await (0, promises_1.readFile)(file, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
async function writeEnabledState() {
    const file = node_path_1.default.join(rootDir(), '_state.json');
    const state = {};
    for (const m of mods.values())
        state[m.id] = m.enabled;
    try {
        await ensureDir(rootDir());
        await (0, promises_1.writeFile)(file, JSON.stringify(state, null, 2), 'utf-8');
    }
    catch (err) {
        console.warn('[mod] write state failed', err);
    }
}
async function initModApi() {
    if (loaded)
        return;
    loaded = true;
    if (!quitHookBound) {
        quitHookBound = true;
        electron_1.app.on('before-quit', () => { for (const flush of storageFlushers)
            flush(); });
    }
    await ensureDir(rootDir());
    const state = await readEnabledState();
    let entries = [];
    try {
        entries = await (0, promises_1.readdir)(rootDir());
    }
    catch (err) {
        console.warn('[mod] readdir failed', err);
        return;
    }
    for (const entry of entries) {
        if (entry.startsWith('_') || entry.startsWith('.'))
            continue;
        const full = node_path_1.default.join(rootDir(), entry);
        try {
            const st = await (0, promises_1.stat)(full);
            if (!st.isDirectory())
                continue;
        }
        catch {
            continue;
        }
        const mod = await loadMod(entry, full);
        if (!mod)
            continue;
        mods.set(mod.id, mod);
        if (state[mod.id]) {
            await activateMod(mod);
        }
    }
    if (mods.size > 0) {
        console.log(`[mod] loaded ${mods.size} mods, ${Array.from(mods.values()).filter((m) => m.enabled).length} active`);
    }
}
function listMods() {
    return Array.from(mods.values()).map((m) => ({
        id: m.id,
        name: m.manifest.name,
        description: m.manifest.description,
        version: m.manifest.version,
        author: m.manifest.author,
        permissions: m.manifest.permissions,
        enabled: m.enabled,
        hasError: m.hasError,
        errorMessage: m.errorMessage,
        path: m.modPath,
    }));
}
async function setModEnabled(id, enabled) {
    const mod = mods.get(id);
    if (!mod)
        return false;
    if (enabled && !mod.enabled) {
        await activateMod(mod);
    }
    else if (!enabled && mod.enabled) {
        mod.enabled = false;
        clearModTimers(mod);
        mod.tabListeners = { created: [], closed: [], navigated: [] };
        mod.menuItems = [];
        mod.hasError = false;
        mod.errorMessage = undefined;
    }
    await writeEnabledState();
    exports.modEvents.emit('changed');
    return true;
}
async function reloadMod(id) {
    const mod = mods.get(id);
    if (!mod)
        return false;
    if (mod.enabled) {
        await activateMod(mod);
    }
    exports.modEvents.emit('changed');
    return true;
}
async function removeMod(id) {
    const mod = mods.get(id);
    if (!mod)
        return false;
    clearModTimers(mod);
    mods.delete(id);
    try {
        await (0, promises_1.rm)(mod.modPath, { recursive: true, force: true });
    }
    catch (err) {
        console.warn(`[mod:${id}] remove failed`, err);
    }
    await writeEnabledState();
    exports.modEvents.emit('changed');
    return true;
}
// ===== tab lifecycle hook bridge =====
// main 진입의 onTabCreated/onTabClosed/onTabNavigated 가 이 함수들 호출.
function dispatchTabCreated(info) {
    for (const mod of mods.values()) {
        if (!mod.enabled)
            continue;
        for (const cb of mod.tabListeners.created) {
            try {
                cb(info);
            }
            catch (err) {
                console.warn(`[mod:${mod.id}] tab.onCreated error`, err);
            }
        }
    }
}
function dispatchTabClosed(id) {
    for (const mod of mods.values()) {
        if (!mod.enabled)
            continue;
        for (const cb of mod.tabListeners.closed) {
            try {
                cb(id);
            }
            catch (err) {
                console.warn(`[mod:${mod.id}] tab.onClosed error`, err);
            }
        }
    }
}
function dispatchTabNavigated(info) {
    for (const mod of mods.values()) {
        if (!mod.enabled)
            continue;
        for (const cb of mod.tabListeners.navigated) {
            try {
                cb(info);
            }
            catch (err) {
                console.warn(`[mod:${mod.id}] tab.onNavigated error`, err);
            }
        }
    }
}
function collectMenuItems() {
    const out = [];
    for (const mod of mods.values()) {
        if (!mod.enabled)
            continue;
        for (const item of mod.menuItems) {
            out.push({ modId: mod.id, label: item.label, click: item.click });
        }
    }
    return out;
}
/** 명령 팔레트/외피용: 안정 id 가 붙은 모드 메뉴 메타 목록 */
function listMenuItemsMeta() {
    const out = [];
    for (const mod of mods.values()) {
        if (!mod.enabled)
            continue;
        mod.menuItems.forEach((item, i) => {
            out.push({ id: `${mod.id}::${i}`, modId: mod.id, modName: mod.manifest.name, label: item.label });
        });
    }
    return out;
}
/** id(`<modId>::<index>`) 로 모드 메뉴 항목 실행 */
function invokeMenuItem(id) {
    const sep = id.lastIndexOf('::');
    if (sep < 0)
        return false;
    const modId = id.slice(0, sep);
    const idx = Number(id.slice(sep + 2));
    const mod = mods.get(modId);
    if (!mod || !mod.enabled || !Number.isInteger(idx))
        return false;
    const item = mod.menuItems[idx];
    if (!item)
        return false;
    try {
        item.click();
        return true;
    }
    catch (err) {
        console.warn(`[mod:${modId}] menu invoke error`, err);
        return false;
    }
}
