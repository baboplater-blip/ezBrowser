"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadKeymap = loadKeymap;
exports.getKeymap = getKeymap;
exports.saveKeymap = saveKeymap;
exports.resetKeymap = resetKeymap;
exports.findKeyFor = findKeyFor;
exports.findConflicts = findConflicts;
const electron_1 = require("electron");
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const keymap_default_json_1 = __importDefault(require("../../shared/keymap.default.json"));
const KEYMAP_FILENAME = 'keymap.json';
let cache = keymap_default_json_1.default;
function keymapPath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), KEYMAP_FILENAME);
}
async function loadKeymap() {
    const p = keymapPath();
    try {
        if (!(0, node_fs_1.existsSync)(p)) {
            await (0, promises_1.mkdir)(node_path_1.default.dirname(p), { recursive: true });
            await (0, promises_1.writeFile)(p, JSON.stringify(keymap_default_json_1.default, null, 2), 'utf8');
            cache = keymap_default_json_1.default;
            return cache;
        }
        const text = await (0, promises_1.readFile)(p, 'utf8');
        const parsed = JSON.parse(text);
        cache = mergeWithDefaults(parsed);
        return cache;
    }
    catch (err) {
        console.warn('[keymap] load failed, using defaults', err);
        cache = keymap_default_json_1.default;
        return cache;
    }
}
function mergeWithDefaults(user) {
    const merged = { version: user.version || 1, bindings: [...user.bindings] };
    for (const def of keymap_default_json_1.default.bindings) {
        const exists = merged.bindings.some((b) => b.action === def.action && b.when === def.when);
        if (!exists)
            merged.bindings.push(def);
    }
    return merged;
}
function getKeymap() {
    return cache;
}
/**
 * 저장 전 형태 검증 — 잘못된 값이 오면 **캐시도 디스크도 건드리지 않고** 거부한다.
 *
 * 왜 (2026-09-07, 임무 18 에서 발견): 예전에는 `cache = next` 로 무조건 덮어썼다. 설정 페이지가
 * 실수로 배열을 보내면 `cache.bindings` 가 사라져 **모든 단축키가 먹통이 되고 그 상태가 디스크에
 * 저장**됐다(로드 시 폴백이 있어 재시작하면 회복되지만, 재시작 전까지는 깨진 채로 남는다).
 * 사용자 설정을 받아 쓰는 경로는 "호출자가 알아서 잘 보낼 것"을 전제하면 안 된다.
 */
function isValidKeymap(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        return false;
    const f = v;
    if (!Array.isArray(f.bindings))
        return false;
    return f.bindings.every((b) => b && typeof b === 'object'
        && typeof b.action === 'string'
        && typeof b.key === 'string');
}
async function saveKeymap(next) {
    if (!isValidKeymap(next)) {
        throw new Error('키맵 형식이 올바르지 않습니다 — { version, bindings: [{ action, key, ... }] } 여야 합니다');
    }
    cache = { version: typeof next.version === 'number' ? next.version : 1, bindings: next.bindings };
    await (0, promises_1.writeFile)(keymapPath(), JSON.stringify(cache, null, 2), 'utf8');
}
async function resetKeymap() {
    cache = keymap_default_json_1.default;
    await (0, promises_1.writeFile)(keymapPath(), JSON.stringify(keymap_default_json_1.default, null, 2), 'utf8');
    return cache;
}
function findKeyFor(actionId) {
    return cache.bindings.find((b) => b.action === actionId)?.key;
}
function findConflicts() {
    const groups = new Map();
    for (const b of cache.bindings) {
        const k = `${b.when}::${b.key.toLowerCase()}`;
        const arr = groups.get(k) ?? [];
        arr.push(b.action);
        groups.set(k, arr);
    }
    const conflicts = [];
    for (const [k, actions] of groups) {
        if (actions.length > 1) {
            const [when, key] = k.split('::');
            conflicts.push({ key, when, actions });
        }
    }
    return conflicts;
}
