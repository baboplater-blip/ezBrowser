"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.memoryEvents = void 0;
exports.initAiMemory = initAiMemory;
exports.getMemoryText = getMemoryText;
exports.setMemoryText = setMemoryText;
exports.appendMemory = appendMemory;
exports.clearMemory = clearMemory;
exports.memoryBlock = memoryBlock;
const electron_1 = require("electron");
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
// AI 메모리 — aside 의 "브라우징을 기억으로" 정신. 편집 가능한 마크다운 하나(userData/ai-memory.md)에
// 사용자가 저장한 개인 컨텍스트를 담고, 챗·에이전트 프롬프트에 자동 주입해 매번 재설명하지 않게 한다.
// 에이전트는 작업 중 배운 것을 remember 액션으로 append 한다("Dreaming").
exports.memoryEvents = new node_events_1.EventEmitter();
let cache = null;
function filePath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'ai-memory.md');
}
function initAiMemory() {
    if (cache !== null)
        return;
    try {
        cache = (0, node_fs_1.existsSync)(filePath()) ? (0, node_fs_1.readFileSync)(filePath(), 'utf-8') : '';
    }
    catch (err) {
        console.warn('[ai] memory load failed', err);
        cache = '';
    }
}
function getMemoryText() {
    if (cache === null)
        initAiMemory();
    return cache ?? '';
}
async function persist() {
    try {
        await (0, promises_1.mkdir)(node_path_1.default.dirname(filePath()), { recursive: true });
        await (0, promises_1.writeFile)(filePath(), cache ?? '', 'utf-8');
    }
    catch (err) {
        console.warn('[ai] memory persist failed', err);
    }
}
async function setMemoryText(text) {
    cache = String(text ?? '');
    await persist();
    exports.memoryEvents.emit('changed', cache);
}
const MEMORY_MAX_CHARS = 20000;
async function appendMemory(text) {
    const line = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!line)
        return;
    const cur = getMemoryText().trimEnd();
    let next = (cur ? cur + '\n' : '') + `- ${line}`;
    if (next.length > MEMORY_MAX_CHARS) {
        // 무한 성장 방지 — 오래된 앞부분을 잘라내고 온전한 줄부터 유지(새 기억은 tail 이라 보존).
        next = next.slice(next.length - MEMORY_MAX_CHARS);
        const nl = next.indexOf('\n');
        if (nl >= 0)
            next = next.slice(nl + 1);
    }
    cache = next;
    await persist();
    exports.memoryEvents.emit('changed', cache);
}
async function clearMemory() {
    cache = '';
    await persist();
    exports.memoryEvents.emit('changed', cache);
}
// 프롬프트 주입용 — 너무 길면 최근(뒷부분)만. append 가 tail 이므로 앞을 자르지 않으면 새 기억이 유실된다.
function memoryBlock(maxChars = 2000) {
    const mem = getMemoryText().trim();
    if (!mem)
        return '';
    const clipped = mem.length > maxChars ? '…(생략)\n' + mem.slice(mem.length - maxChars) : mem;
    return '\n\n# 기억 (사용자가 저장한 개인 컨텍스트)\n"""\n' + clipped + '\n"""\n이 정보를 관련 있을 때 활용하되, 관련 없으면 무시하세요.';
}
