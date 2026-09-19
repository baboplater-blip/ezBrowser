"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.macroEvents = void 0;
exports.initAutomation = initAutomation;
exports.listMacros = listMacros;
exports.getMacro = getMacro;
exports.saveMacro = saveMacro;
exports.removeMacro = removeMacro;
exports.setMacroEnabled = setMacroEnabled;
exports.runMacro = runMacro;
exports.listUrlMacrosFor = listUrlMacrosFor;
exports.listStartupMacros = listStartupMacros;
exports.listShortcutMacros = listShortcutMacros;
const electron_1 = require("electron");
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const macros = new Map();
let loaded = false;
let counter = 0;
exports.macroEvents = new node_events_1.EventEmitter();
function filePath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'macros.json');
}
function nextId() {
    counter += 1;
    return `mac-${Date.now().toString(36)}-${counter}`;
}
async function ensureDir() {
    await (0, promises_1.mkdir)(node_path_1.default.dirname(filePath()), { recursive: true });
}
let persistTimer = null;
async function persist() {
    if (persistTimer)
        clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
        persistTimer = null;
        await ensureDir();
        try {
            const arr = Array.from(macros.values()).sort((a, b) => a.createdAt - b.createdAt);
            await (0, promises_1.writeFile)(filePath(), JSON.stringify(arr, null, 2), 'utf-8');
        }
        catch (err) {
            console.warn('[automation] persist failed', err);
        }
    }, 250);
}
function normalizeAction(a) {
    const type = a.type;
    if (!type || !['navigate', 'wait', 'js', 'click', 'screenshot', 'toast'].includes(type))
        return null;
    return { type, value: String(a.value ?? '') };
}
function normalize(m) {
    const id = m.id ?? nextId();
    const triggerType = m.trigger?.type;
    const trigger = triggerType === 'url' || triggerType === 'startup'
        ? { type: triggerType, value: String(m.trigger?.value ?? '') }
        : { type: 'shortcut', value: String(m.trigger?.value ?? '') };
    const actions = (Array.isArray(m.actions) ? m.actions : [])
        .map((a) => normalizeAction(a))
        .filter((a) => a !== null);
    return {
        id,
        name: String(m.name ?? '').trim() || '이름 없는 매크로',
        description: String(m.description ?? ''),
        enabled: m.enabled !== false,
        trigger,
        actions,
        createdAt: m.createdAt ?? Date.now(),
        updatedAt: m.updatedAt ?? Date.now(),
    };
}
async function initAutomation() {
    if (loaded)
        return;
    loaded = true;
    await ensureDir();
    if (!(0, node_fs_1.existsSync)(filePath()))
        return;
    try {
        const raw = await (0, promises_1.readFile)(filePath(), 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
            for (const m of data) {
                if (!m || typeof m.id !== 'string')
                    continue;
                macros.set(m.id, normalize(m));
            }
        }
    }
    catch (err) {
        console.warn('[automation] load failed', err);
    }
}
function listMacros() {
    return Array.from(macros.values())
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((m) => ({
        id: m.id, name: m.name, description: m.description, enabled: m.enabled,
        trigger: m.trigger, updatedAt: m.updatedAt,
    }));
}
function getMacro(id) {
    return macros.get(id) ?? null;
}
async function saveMacro(input) {
    // 객체가 아닌 입력은 거부(빈 객체는 "새 매크로" 흐름이라 허용) — 임무 19 실측 근거.
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('매크로 형식이 올바르지 않습니다 — 객체여야 합니다');
    }
    const existing = input.id ? macros.get(input.id) : null;
    const m = normalize({
        ...input,
        id: existing?.id ?? input.id ?? nextId(),
        createdAt: existing?.createdAt ?? input.createdAt ?? Date.now(),
        updatedAt: Date.now(),
    });
    macros.set(m.id, m);
    await persist();
    exports.macroEvents.emit('changed', m);
    return m;
}
async function removeMacro(id) {
    if (!macros.has(id))
        return false;
    macros.delete(id);
    await persist();
    exports.macroEvents.emit('changed', null);
    return true;
}
async function setMacroEnabled(id, enabled) {
    const m = macros.get(id);
    if (!m)
        return false;
    m.enabled = enabled;
    m.updatedAt = Date.now();
    await persist();
    exports.macroEvents.emit('changed', m);
    return true;
}
function escapeJs(s) {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}
async function runAction(action, ctx) {
    switch (action.type) {
        case 'navigate': {
            if (ctx.webContents && /^https?:|^browser:|^file:/.test(action.value)) {
                await ctx.webContents.loadURL(action.value);
            }
            return;
        }
        case 'wait': {
            const ms = Math.max(0, Math.min(60_000, parseInt(action.value, 10) || 0));
            await new Promise((r) => setTimeout(r, ms));
            return;
        }
        case 'js': {
            if (!ctx.webContents)
                return;
            await ctx.webContents.executeJavaScript(`(function(){try{${action.value}}catch(e){console.error('[macro]',e)}})()`);
            return;
        }
        case 'click': {
            if (!ctx.webContents)
                return;
            const sel = escapeJs(action.value);
            await ctx.webContents.executeJavaScript(`(function(){var el=document.querySelector('${sel}');if(el)el.click();})()`);
            return;
        }
        case 'toast': {
            ctx.toast(action.value);
            return;
        }
        case 'screenshot': {
            // 실제 캡처는 features/screenshot 모듈이 담당 — 매크로에서는 트리거만, 후속 작업은 다음 라운드
            ctx.toast('스크린샷 액션은 다음 라운드');
            return;
        }
    }
}
async function runMacro(id, ctx) {
    const m = macros.get(id);
    if (!m)
        return { ok: false, error: 'macro not found' };
    if (!m.enabled)
        return { ok: false, error: 'macro disabled' };
    try {
        for (const action of m.actions) {
            await runAction(action, ctx);
        }
        return { ok: true };
    }
    catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
// ===== URL 트리거 =====
// onTabNavigated hook 에서 호출 — URL 패턴 매칭된 macro 실행.
function listUrlMacrosFor(url) {
    const out = [];
    for (const m of macros.values()) {
        if (!m.enabled)
            continue;
        if (m.trigger.type !== 'url')
            continue;
        if (!m.trigger.value)
            continue;
        try {
            const re = new RegExp('^' + m.trigger.value.split('*').map(escapeRegex).join('.*') + '$', 'i');
            if (re.test(url))
                out.push(m);
        }
        catch { /* invalid pattern */ }
    }
    return out;
}
function escapeRegex(s) {
    return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
function listStartupMacros() {
    return Array.from(macros.values()).filter((m) => m.enabled && m.trigger.type === 'startup');
}
function listShortcutMacros() {
    return Array.from(macros.values()).filter((m) => m.enabled && m.trigger.type === 'shortcut');
}
