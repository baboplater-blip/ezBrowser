"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isKeyStorageAvailable = isKeyStorageAvailable;
exports.initAiKeys = initAiKeys;
exports.setAiKey = setAiKey;
exports.clearAiKey = clearAiKey;
exports.getAiKey = getAiKey;
exports.hasAiKey = hasAiKey;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const cipherByProvider = new Map(); // base64 ciphertext
let loaded = false;
function filePath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'ai-keys.json');
}
function isKeyStorageAvailable() {
    try {
        return electron_1.safeStorage.isEncryptionAvailable();
    }
    catch {
        return false;
    }
}
async function ensureLoaded() {
    if (loaded)
        return true;
    if (!(0, node_fs_1.existsSync)(filePath())) {
        loaded = true;
        return true;
    }
    try {
        const raw = await (0, promises_1.readFile)(filePath(), 'utf-8');
        const obj = JSON.parse(raw);
        for (const p of ['anthropic', 'openai', 'google']) {
            if (typeof obj[p] === 'string')
                cipherByProvider.set(p, obj[p]);
        }
        loaded = true;
        return true;
    }
    catch (err) {
        // loaded 를 true 로 올리지 않고 false 를 반환한다 — 일시적 read 실패(AV/EBUSY) 후 setAiKey 가 빈 맵을
        // persist 해서 다른 제공자 키를 영구 소실시키는 것을 막는다(호출자는 실패 시 persist 금지). 다음 접근에서 재시도.
        console.warn('[ai] key load failed', err);
        return false;
    }
}
async function persist() {
    try {
        await (0, promises_1.mkdir)(node_path_1.default.dirname(filePath()), { recursive: true });
        const obj = {};
        for (const [p, c] of cipherByProvider)
            obj[p] = c;
        const tmp = filePath() + '.tmp';
        await (0, promises_1.writeFile)(tmp, JSON.stringify(obj), 'utf-8');
        await (0, promises_1.rename)(tmp, filePath());
    }
    catch (err) {
        console.warn('[ai] key persist failed', err);
    }
}
async function initAiKeys() {
    await ensureLoaded();
}
async function setAiKey(provider, plaintext) {
    if (!(await ensureLoaded()))
        return false; // 로드 실패 시 persist 금지 — 다른 제공자 키 유실 방지
    if (!isKeyStorageAvailable())
        return false;
    const trimmed = plaintext.trim();
    if (!trimmed) {
        cipherByProvider.delete(provider);
    }
    else {
        const enc = electron_1.safeStorage.encryptString(trimmed);
        cipherByProvider.set(provider, enc.toString('base64'));
    }
    await persist();
    return true;
}
async function clearAiKey(provider) {
    if (!(await ensureLoaded()))
        return; // 로드 실패 시 아무것도 안 함 — 다른 제공자 키 유실 방지
    cipherByProvider.delete(provider);
    await persist();
}
async function getAiKey(provider) {
    await ensureLoaded();
    const cipher = cipherByProvider.get(provider);
    if (!cipher)
        return null;
    try {
        return electron_1.safeStorage.decryptString(Buffer.from(cipher, 'base64'));
    }
    catch (err) {
        console.warn('[ai] key decrypt failed', err);
        return null;
    }
}
async function hasAiKey(provider) {
    await ensureLoaded();
    return cipherByProvider.has(provider);
}
