"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentFilesDir = agentFilesDir;
exports.hasAgentFilesDir = hasAgentFilesDir;
exports.listAgentFiles = listAgentFiles;
exports.resolveAgentFile = resolveAgentFile;
exports.resolveAgentFiles = resolveAgentFiles;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const settings_1 = require("../../storage/settings");
// 에이전트 자료 폴더 — 사용자가 지정한 폴더(하위 폴더 포함)의 파일만 에이전트가 업로드에 쓸 수 있다.
// 보안 경계: 최종 실제 경로(심볼릭 링크 해석 후)가 반드시 지정 폴더 안이어야 한다
// (`..`·절대경로·폴더 밖을 가리키는 심링크 모두 차단).
const MAX_LISTED = 300;
const MAX_DEPTH = 5;
function agentFilesDir() {
    const d = (0, settings_1.getSetting)('ai').agentFilesDir;
    return typeof d === 'string' ? d.trim() : '';
}
function hasAgentFilesDir() {
    const dir = agentFilesDir();
    if (!dir)
        return false;
    try {
        return (0, node_fs_1.statSync)(dir).isDirectory();
    }
    catch {
        return false;
    }
}
// 지정 폴더 + 하위 폴더의 파일 상대경로 목록(숨김 제외, 깊이·개수 상한). 구분자는 '/' 로 통일.
function listAgentFiles() {
    const dir = agentFilesDir();
    if (!dir)
        return [];
    const out = [];
    const walk = (abs, rel, depth) => {
        if (out.length >= MAX_LISTED || depth > MAX_DEPTH)
            return;
        let entries;
        try {
            entries = (0, node_fs_1.readdirSync)(abs, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (out.length >= MAX_LISTED)
                return;
            if (e.name.startsWith('.'))
                continue; // 숨김 파일·폴더 제외
            const childRel = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory())
                walk(node_path_1.default.join(abs, e.name), childRel, depth + 1);
            else if (e.isFile())
                out.push(childRel);
        }
    };
    try {
        walk(dir, '', 0);
    }
    catch { /* ignore */ }
    return out.sort((a, b) => a.localeCompare(b));
}
// 상대경로(하위 폴더 포함)를 지정 폴더 안의 실제 파일 경로로 안전하게 해석. 폴더 밖·미존재면 null.
function resolveAgentFile(name) {
    const dir = agentFilesDir();
    if (!dir || !name)
        return null;
    const raw = String(name).trim().replace(/\\/g, '/');
    if (!raw || node_path_1.default.isAbsolute(raw))
        return null; // 절대경로 거부
    const full = node_path_1.default.resolve(dir, raw);
    // 실제 파일이어야 하고, 심링크까지 해석한 최종 경로가 지정 폴더 안이어야 함.
    try {
        if (!(0, node_fs_1.statSync)(full).isFile())
            return null;
        const realFull = (0, node_fs_1.realpathSync)(full);
        const realDir = (0, node_fs_1.realpathSync)(dir);
        const rel = node_path_1.default.relative(realDir, realFull);
        if (rel === '' || rel.startsWith('..') || node_path_1.default.isAbsolute(rel))
            return null; // 폴더 밖(심링크 탈출 포함) 거부
        return realFull;
    }
    catch {
        return null;
    }
}
// 여러 이름 → 폴더 안에 실제로 존재하는 경로들만.
function resolveAgentFiles(names) {
    const out = [];
    for (const n of Array.isArray(names) ? names : []) {
        const p = resolveAgentFile(n);
        if (p && !out.includes(p))
            out.push(p);
    }
    return out;
}
