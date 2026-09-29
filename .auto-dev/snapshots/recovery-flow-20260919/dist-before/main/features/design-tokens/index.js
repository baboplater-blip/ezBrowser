"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenEvents = exports.EDITABLE_TOKENS = void 0;
exports.initDesignTokens = initDesignTokens;
exports.getOverrides = getOverrides;
exports.getOverridesAsCssVars = getOverridesAsCssVars;
exports.setOverride = setOverride;
exports.resetTokens = resetTokens;
exports.listEditableTokens = listEditableTokens;
exports.defaultsAsCssVars = defaultsAsCssVars;
const electron_1 = require("electron");
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
// 사용자가 수정 가능한 토큰 화이트리스트.
// CSS 변수 이름은 build/gen-tokens.mjs 의 규칙과 동일 — '.' → '-'.
exports.EDITABLE_TOKENS = [
    { key: 'color.accent.primary', cssVar: '--color-accent-primary', label: '액센트', type: 'color', defaultValue: '#3478F6' },
    { key: 'color.accent.hover', cssVar: '--color-accent-hover', label: '액센트 호버', type: 'color', defaultValue: '#2C66D6' },
    { key: 'color.bg.base', cssVar: '--color-bg-base', label: '배경', type: 'color', defaultValue: '#F7F7F8' },
    { key: 'color.bg.elevated', cssVar: '--color-bg-elevated', label: '카드 배경', type: 'color', defaultValue: '#FFFFFF' },
    { key: 'color.text.primary', cssVar: '--color-text-primary', label: '본문', type: 'color', defaultValue: '#1A1A1A' },
    { key: 'color.text.secondary', cssVar: '--color-text-secondary', label: '보조 글자', type: 'color', defaultValue: '#5F5F66' },
    { key: 'color.border.subtle', cssVar: '--color-border-subtle', label: '경계선', type: 'color', defaultValue: '#E5E5E8' },
    { key: 'radius.sm', cssVar: '--radius-sm', label: '작은 라운드', type: 'size', defaultValue: '4px' },
    { key: 'radius.md', cssVar: '--radius-md', label: '중간 라운드', type: 'size', defaultValue: '8px' },
    { key: 'radius.lg', cssVar: '--radius-lg', label: '큰 라운드', type: 'size', defaultValue: '12px' },
    { key: 'radius.tab', cssVar: '--radius-tab', label: '탭 라운드', type: 'size', defaultValue: '8px' },
    { key: 'density.tabbar-h', cssVar: '--density-tabbar-h', label: '탭바 높이', type: 'size', defaultValue: '36px' },
    { key: 'density.toolbar-h', cssVar: '--density-toolbar-h', label: '툴바 높이', type: 'size', defaultValue: '36px' },
    { key: 'density.font-size', cssVar: '--density-font-size', label: '기본 글자 크기', type: 'size', defaultValue: '13px' },
    { key: 'motion.normal', cssVar: '--motion-normal', label: '애니메이션 속도', type: 'duration', defaultValue: '180ms' },
];
const cssVarByKey = new Map(exports.EDITABLE_TOKENS.map((t) => [t.key, t.cssVar]));
const defaultByKey = new Map(exports.EDITABLE_TOKENS.map((t) => [t.key, t.defaultValue]));
const editableKeys = new Set(exports.EDITABLE_TOKENS.map((t) => t.key));
let overrides = {};
let loaded = false;
exports.tokenEvents = new node_events_1.EventEmitter();
function filePath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'user-tokens.json');
}
async function ensureDir() {
    await (0, promises_1.mkdir)(node_path_1.default.dirname(filePath()), { recursive: true });
}
async function persist() {
    await ensureDir();
    try {
        await (0, promises_1.writeFile)(filePath(), JSON.stringify(overrides, null, 2), 'utf-8');
    }
    catch (err) {
        console.warn('[design-tokens] persist failed', err);
    }
}
function sanitizeValue(key, raw) {
    const v = String(raw ?? '').trim();
    if (!v)
        return '';
    const meta = exports.EDITABLE_TOKENS.find((t) => t.key === key);
    if (!meta)
        return '';
    if (meta.type === 'color') {
        if (/^#[0-9a-f]{3,8}$/i.test(v))
            return v;
        if (/^rgba?\([0-9.,\s%]+\)$/i.test(v))
            return v;
        if (/^hsla?\([0-9.,\s%]+\)$/i.test(v))
            return v;
        return '';
    }
    if (meta.type === 'size') {
        if (/^-?\d+(\.\d+)?(px|rem|em|%)$/.test(v))
            return v;
        return '';
    }
    if (meta.type === 'duration') {
        if (/^\d+(\.\d+)?(ms|s)$/.test(v))
            return v;
        return '';
    }
    return v.slice(0, 100);
}
async function initDesignTokens() {
    if (loaded)
        return;
    loaded = true;
    await ensureDir();
    if (!(0, node_fs_1.existsSync)(filePath()))
        return;
    try {
        const raw = await (0, promises_1.readFile)(filePath(), 'utf-8');
        const parsed = JSON.parse(raw);
        overrides = {};
        for (const [k, v] of Object.entries(parsed ?? {})) {
            if (!editableKeys.has(k))
                continue;
            const clean = sanitizeValue(k, v);
            if (clean)
                overrides[k] = clean;
        }
    }
    catch (err) {
        console.warn('[design-tokens] load failed', err);
    }
}
function getOverrides() {
    return { ...overrides };
}
function getOverridesAsCssVars() {
    const out = {};
    for (const [k, v] of Object.entries(overrides)) {
        const cssVar = cssVarByKey.get(k);
        if (cssVar)
            out[cssVar] = v;
    }
    return out;
}
async function setOverride(key, value) {
    if (!editableKeys.has(key))
        return false;
    const clean = sanitizeValue(key, value);
    if (!clean) {
        if (overrides[key]) {
            delete overrides[key];
            await persist();
            exports.tokenEvents.emit('changed', getOverrides());
        }
        return true;
    }
    if (overrides[key] === clean)
        return true;
    overrides[key] = clean;
    await persist();
    exports.tokenEvents.emit('changed', getOverrides());
    return true;
}
async function resetTokens() {
    overrides = {};
    await persist();
    exports.tokenEvents.emit('changed', getOverrides());
}
function listEditableTokens() {
    return exports.EDITABLE_TOKENS;
}
function defaultsAsCssVars() {
    const out = {};
    for (const [k, v] of defaultByKey) {
        const cssVar = cssVarByKey.get(k);
        if (cssVar)
            out[cssVar] = v;
    }
    return out;
}
