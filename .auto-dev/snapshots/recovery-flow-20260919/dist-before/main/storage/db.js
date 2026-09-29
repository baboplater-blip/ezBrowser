"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.openExternalSqlite = openExternalSqlite;
exports.openDb = openDb;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const sql_js_1 = __importDefault(require("sql.js"));
let SQL = null;
// sql.js 는 in-memory DB 라 주기적·종료 시 디스크 flush 가 영속성의 유일한 보장.
// 디바운스를 짧게(400ms) + 주기 강제 flush(20s) + 종료 시 동기 atomic 쓰기로 손실창을 최소화.
const FLUSH_DEBOUNCE_MS = 400;
const FORCE_FLUSH_MS = 20_000;
function resolveWasmPath() {
    if (electron_1.app.isPackaged) {
        return node_path_1.default.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    }
    return require.resolve('sql.js/dist/sql-wasm.wasm');
}
async function ensureRuntime() {
    if (SQL)
        return SQL;
    const wasmPath = resolveWasmPath();
    const buf = await (0, promises_1.readFile)(wasmPath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    SQL = await (0, sql_js_1.default)({ wasmBinary: ab });
    return SQL;
}
/**
 * 외부(읽기 전용) SQLite 파일을 sql.js 로 연다. 가져오기(크롬/엣지 History 등)용.
 * 호출자가 끝나면 반드시 `db.close()` 한다. 원본 파일이 잠겨 있을 수 있으므로,
 * 호출자는 미리 임시 위치로 복사한 경로를 넘기는 것이 안전하다.
 */
async function openExternalSqlite(filePath) {
    const runtime = await ensureRuntime();
    const buf = await (0, promises_1.readFile)(filePath);
    return new runtime.Database(new Uint8Array(buf));
}
const dirty = new WeakMap();
async function openDb(filename, schema) {
    const runtime = await ensureRuntime();
    const userData = electron_1.app.getPath('userData');
    const dbDir = node_path_1.default.join(userData, 'data');
    await (0, promises_1.mkdir)(dbDir, { recursive: true });
    const filePath = node_path_1.default.join(dbDir, filename);
    let db;
    if ((0, node_fs_1.existsSync)(filePath)) {
        const buf = await (0, promises_1.readFile)(filePath);
        db = new runtime.Database(new Uint8Array(buf));
    }
    else {
        db = new runtime.Database();
    }
    for (const stmt of schema) {
        db.exec(stmt);
    }
    // 마지막 flush 이후 쓰기 발생 여부 — 주기 flush·종료 flush 가 불필요한 쓰기를 건너뛰도록.
    let pendingWrites = false;
    const flush = async () => {
        pendingWrites = false;
        const data = Buffer.from(db.export());
        const tmp = `${filePath}.tmp`;
        await (0, promises_1.writeFile)(tmp, data);
        await (0, promises_1.rename)(tmp, filePath);
    };
    const flushSync = () => {
        if (!pendingWrites)
            return;
        pendingWrites = false;
        try {
            const data = Buffer.from(db.export());
            const tmp = `${filePath}.tmp`;
            (0, node_fs_1.writeFileSync)(tmp, data);
            (0, node_fs_1.renameSync)(tmp, filePath); // atomic — 도중에 죽어도 원본 보존
        }
        catch (err) {
            console.error(`[db] sync flush ${filename} failed`, err);
        }
    };
    const scheduleFlush = () => {
        pendingWrites = true;
        const existing = dirty.get(db);
        if (existing)
            clearTimeout(existing);
        const t = setTimeout(() => {
            void flush().catch((err) => console.error(`[db] flush ${filename} failed`, err));
            dirty.set(db, null);
        }, FLUSH_DEBOUNCE_MS);
        dirty.set(db, t);
    };
    const close = async () => {
        const existing = dirty.get(db);
        if (existing)
            clearTimeout(existing);
        await flush();
        db.close();
    };
    // 주기적 강제 flush — 디바운스가 계속 밀려도 20초마다 디스크에 반영(비정상 종료 손실창 축소)
    const interval = setInterval(() => {
        if (!pendingWrites)
            return;
        const existing = dirty.get(db);
        if (existing) {
            clearTimeout(existing);
            dirty.set(db, null);
        }
        void flush().catch((err) => console.error(`[db] periodic flush ${filename} failed`, err));
    }, FORCE_FLUSH_MS);
    if (typeof interval.unref === 'function')
        interval.unref();
    // 정상 종료 — 동기 atomic 쓰기
    electron_1.app.on('before-quit', flushSync);
    electron_1.app.on('will-quit', flushSync);
    return { db, flush, scheduleFlush, close };
}
