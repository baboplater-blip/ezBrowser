"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_AUTO_LOGIN_FAILURES = exports.passwordEvents = void 0;
exports.isPasswordStorageAvailable = isPasswordStorageAvailable;
exports.normalizeOrigin = normalizeOrigin;
exports.normalizeHttpsOrigin = normalizeHttpsOrigin;
exports.initPasswords = initPasswords;
exports.listPasswords = listPasswords;
exports.lookupForOrigin = lookupForOrigin;
exports.revealPassword = revealPassword;
exports.addPassword = addPassword;
exports.updatePassword = updatePassword;
exports.isAutoLoginBlocked = isAutoLoginBlocked;
exports.autoLoginEntriesFor = autoLoginEntriesFor;
exports.savedButNotAllowedCount = savedButNotAllowedCount;
exports.getEntryById = getEntryById;
exports.secretForAutoLogin = secretForAutoLogin;
exports.noteAutoLoginFailure = noteAutoLoginFailure;
exports.clearAutoLoginFailures = clearAutoLoginFailures;
exports.proposeSave = proposeSave;
exports.confirmSave = confirmSave;
exports.listPendingProposals = listPendingProposals;
exports.markUsed = markUsed;
exports.removePassword = removePassword;
const electron_1 = require("electron");
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const passwords = new Map();
let loaded = false;
let counter = 0;
exports.passwordEvents = new node_events_1.EventEmitter();
function filePath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'passwords.json');
}
function nextId() {
    counter += 1;
    return `pwd-${Date.now().toString(36)}-${counter}`;
}
function isPasswordStorageAvailable() {
    try {
        return electron_1.safeStorage.isEncryptionAvailable();
    }
    catch {
        return false;
    }
}
// ===== origin 정규화 =====
function normalizeOrigin(url) {
    try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
            return null;
        return `${u.protocol}//${u.host}`;
    }
    catch {
        return null;
    }
}
/**
 * 사용자가 선등록 폼에 적은 주소 → 저장용 origin.
 * `example.com` 처럼 스킴이 없으면 https 로 보강하고, **https 가 아니면 거부**한다.
 * (평문 http 로는 비밀번호를 내보내지 않는다 — 다운그레이드 차단의 출발점.)
 * 포트·호스트는 그대로 보존한다. `https://a.example.com` 과 `https://example.com` 은 서로 다른 origin 이며,
 * 자동 로그인은 **정확히 일치**할 때만 동작한다(서브도메인·유사문자 도메인에 비밀을 넘기지 않기 위해).
 */
function normalizeHttpsOrigin(input) {
    const raw = String(input ?? '').trim();
    if (!raw)
        return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    let u;
    try {
        u = new URL(withScheme);
    }
    catch {
        return null;
    }
    if (u.protocol !== 'https:')
        return null;
    if (!u.hostname)
        return null;
    return `https://${u.host}`;
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
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
            for (const e of arr) {
                if (!e || typeof e.id !== 'string')
                    continue;
                // ===== 마이그레이션 =====
                // 예전 항목에는 자동 로그인 관련 필드가 없다. **없으면 무조건 꺼진 것**으로 정규화한다.
                // (값이 없을 때 "허용"으로 읽히는 실수를 원천 차단 — 저장돼 있다는 이유로 자동 로그인이
                //  켜지면 사용자가 켠 적 없는 권한이 생긴다.)
                e.autoLoginAllowed = e.autoLoginAllowed === true;
                e.preferred = e.preferred === true;
                e.autoLoginFailures = typeof e.autoLoginFailures === 'number' && e.autoLoginFailures > 0
                    ? Math.floor(e.autoLoginFailures) : 0;
                e.autoLoginBlockedUntil = typeof e.autoLoginBlockedUntil === 'number' && e.autoLoginBlockedUntil > 0
                    ? Math.floor(e.autoLoginBlockedUntil) : 0;
                passwords.set(e.id, e);
            }
        }
    }
    catch (err) {
        console.warn('[password] load failed', err);
    }
}
let persistTimer = null;
function persist() {
    if (persistTimer)
        clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
        persistTimer = null;
        await ensureDir();
        try {
            const arr = Array.from(passwords.values());
            await (0, promises_1.writeFile)(filePath(), JSON.stringify(arr, null, 2), 'utf-8');
        }
        catch (err) {
            console.warn('[password] persist failed', err);
        }
    }, 250);
}
// ===== Init =====
async function initPasswords() {
    await loadAll();
    if (!isPasswordStorageAvailable()) {
        console.warn('[password] safeStorage not available — entries can be loaded but new saves will fail');
    }
}
// ===== Encrypt/Decrypt =====
function encrypt(plain) {
    if (!isPasswordStorageAvailable())
        return null;
    try {
        const buf = electron_1.safeStorage.encryptString(plain);
        return buf.toString('base64');
    }
    catch (err) {
        console.warn('[password] encrypt failed', err);
        return null;
    }
}
function decrypt(b64) {
    if (!isPasswordStorageAvailable())
        return null;
    try {
        const buf = Buffer.from(b64, 'base64');
        return electron_1.safeStorage.decryptString(buf);
    }
    catch (err) {
        console.warn('[password] decrypt failed', err);
        return null;
    }
}
// ===== CRUD =====
function summarize(e) {
    return {
        id: e.id,
        origin: e.origin,
        username: e.username,
        updatedAt: e.updatedAt,
        autoLoginAllowed: e.autoLoginAllowed === true,
        preferred: e.preferred === true,
        scheme: e.origin.startsWith('https:') ? 'https' : 'http',
        autoLoginFailures: e.autoLoginFailures ?? 0,
        autoLoginBlockedUntil: e.autoLoginBlockedUntil ?? 0,
    };
}
function listPasswords() {
    return Array.from(passwords.values())
        .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username))
        .map(summarize);
}
function lookupForOrigin(origin) {
    const out = [];
    for (const e of passwords.values()) {
        if (e.origin !== origin)
            continue;
        const plain = decrypt(e.encryptedPassword);
        if (plain === null)
            continue;
        out.push({ id: e.id, username: e.username, password: plain });
    }
    // 가장 최근 사용 우선
    return out.sort((a, b) => {
        const ea = passwords.get(a.id);
        const eb = passwords.get(b.id);
        return (eb?.lastUsedAt ?? 0) - (ea?.lastUsedAt ?? 0);
    });
}
function revealPassword(id) {
    const e = passwords.get(id);
    if (!e)
        return null;
    return decrypt(e.encryptedPassword);
}
const WRITE_MESSAGE = {
    unavailable: '이 컴퓨터에서 OS 암호화(safeStorage)를 쓸 수 없어 비밀번호를 저장하지 않았습니다. 평문으로는 저장하지 않습니다.',
    'invalid-origin': '사이트 주소가 올바르지 않습니다. https 주소여야 합니다 (예: https://example.com).',
    invalid: '사용자명과 비밀번호를 모두 입력해 주세요.',
    duplicate: '같은 사이트에 같은 사용자명이 이미 등록돼 있습니다. 기존 항목을 수정해 주세요.',
    'not-found': '해당 계정을 찾을 수 없습니다.',
};
function fail(reason) {
    return { ok: false, reason, message: WRITE_MESSAGE[reason] };
}
function findByOriginUser(origin, username) {
    return Array.from(passwords.values()).find((e) => e.origin === origin && e.username === username);
}
function addPassword(args) {
    const origin = normalizeHttpsOrigin(args.origin);
    if (!origin)
        return fail('invalid-origin');
    const username = String(args.username ?? '').trim();
    const password = String(args.password ?? '');
    if (!username || !password)
        return fail('invalid');
    if (!isPasswordStorageAvailable())
        return fail('unavailable');
    if (findByOriginUser(origin, username))
        return fail('duplicate');
    const encoded = encrypt(password);
    if (encoded === null)
        return fail('unavailable');
    const now = Date.now();
    const e = {
        id: nextId(),
        origin,
        username,
        encryptedPassword: encoded,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: 0,
        autoLoginAllowed: args.autoLoginAllowed === true,
        preferred: false,
        autoLoginFailures: 0,
        autoLoginBlockedUntil: 0,
    };
    passwords.set(e.id, e);
    // 기본 계정(preferred)을 자동으로 켜지 않는다. 허용 계정이 하나뿐이면 애초에 모호하지 않아 필요 없고,
    // 자동으로 켜 두면 나중에 둘째 계정이 생겼을 때 **사용자가 고른 적 없는 계정**이 조용히 쓰인다.
    persist();
    exports.passwordEvents.emit('changed');
    return { ok: true, id: e.id };
}
function updatePassword(args) {
    const e = passwords.get(String(args.id ?? ''));
    if (!e)
        return fail('not-found');
    if (args.username !== undefined) {
        const username = String(args.username).trim();
        if (!username)
            return fail('invalid');
        const dup = findByOriginUser(e.origin, username);
        if (dup && dup.id !== e.id)
            return fail('duplicate');
        e.username = username;
    }
    if (args.password !== undefined) {
        const password = String(args.password);
        if (!password)
            return fail('invalid');
        if (!isPasswordStorageAvailable())
            return fail('unavailable');
        const encoded = encrypt(password);
        if (encoded === null)
            return fail('unavailable');
        e.encryptedPassword = encoded;
        // 비밀번호를 고쳤다 = "틀린 비밀번호" 잠금의 원인이 사라졌을 수 있다 → 잠금 해제하고 다시 시도하게 한다.
        e.autoLoginFailures = 0;
        e.autoLoginBlockedUntil = 0;
    }
    if (args.autoLoginAllowed !== undefined) {
        const on = args.autoLoginAllowed === true;
        // http 항목은 켤 수 없다(저장은 과거에 됐을 수 있으나 자동 로그인 대상이 아니다).
        e.autoLoginAllowed = on && e.origin.startsWith('https:');
        if (!e.autoLoginAllowed)
            e.preferred = false;
    }
    if (args.preferred === false) {
        e.preferred = false;
    }
    else if (args.preferred === true) {
        if (!e.autoLoginAllowed)
            return fail('invalid');
        // 기본 계정은 origin 당 하나 — 형제들의 표시를 내린다.
        for (const other of passwords.values()) {
            if (other.origin === e.origin && other.id !== e.id)
                other.preferred = false;
        }
        e.preferred = true;
    }
    e.updatedAt = Date.now();
    persist();
    exports.passwordEvents.emit('changed');
    return { ok: true, id: e.id };
}
// ===== 자동화 로그인용 조회 =====
/** 잠금 만료 시각까지 남았는가. */
function isAutoLoginBlocked(e) {
    return (e.autoLoginBlockedUntil ?? 0) > Date.now();
}
/**
 * 이 origin 에서 **자동 로그인이 허용된** 계정들. 정확히 일치하는 origin 만 — 서브도메인·다른 포트·http 는
 * 절대 매칭되지 않는다(비밀을 유사 도메인에 넘기지 않기 위한 핵심 경계).
 */
function autoLoginEntriesFor(origin) {
    if (!origin.startsWith('https:'))
        return [];
    return Array.from(passwords.values())
        .filter((e) => e.origin === origin && e.autoLoginAllowed === true)
        .sort((a, b) => (b.preferred === true ? 1 : 0) - (a.preferred === true ? 1 : 0)
        || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
}
/** 이 origin 에 저장돼 있으나 자동 로그인이 꺼진 계정 수 — "등록은 했는데 허용을 안 켰다" 를 구분해 안내한다. */
function savedButNotAllowedCount(origin) {
    return Array.from(passwords.values())
        .filter((e) => e.origin === origin && e.autoLoginAllowed !== true).length;
}
function getEntryById(id) {
    return passwords.get(id);
}
/** 자동 로그인에 쓸 평문. 이 값은 호출자(auto-login)의 지역 변수 밖으로 절대 나가면 안 된다. */
function secretForAutoLogin(id) {
    const e = passwords.get(id);
    if (!e || e.autoLoginAllowed !== true)
        return null;
    if (isAutoLoginBlocked(e))
        return null;
    return decrypt(e.encryptedPassword);
}
exports.MAX_AUTO_LOGIN_FAILURES = 3;
const AUTO_LOGIN_BLOCK_MS = 30 * 60_000;
/**
 * 로그인 실패 기록. 상한에 닿으면 잠근다 — **디스크에 남으므로 구간 경계·작업 재개·앱 재시작을 넘어 유지된다.**
 * (계정 잠금은 되돌리기 어려운 피해다. 무한 재시도는 그 자체가 사고다.)
 */
function noteAutoLoginFailure(id) {
    const e = passwords.get(id);
    if (!e)
        return { failures: 0, blocked: false };
    e.autoLoginFailures = (e.autoLoginFailures ?? 0) + 1;
    const blocked = e.autoLoginFailures >= exports.MAX_AUTO_LOGIN_FAILURES;
    if (blocked)
        e.autoLoginBlockedUntil = Date.now() + AUTO_LOGIN_BLOCK_MS;
    persist();
    exports.passwordEvents.emit('changed');
    return { failures: e.autoLoginFailures, blocked };
}
function clearAutoLoginFailures(id) {
    const e = passwords.get(id);
    if (!e)
        return;
    if ((e.autoLoginFailures ?? 0) === 0 && (e.autoLoginBlockedUntil ?? 0) === 0)
        return;
    e.autoLoginFailures = 0;
    e.autoLoginBlockedUntil = 0;
    persist();
    exports.passwordEvents.emit('changed');
}
const pendingProposals = new Map();
let promptCounter = 0;
function nextPromptId() {
    promptCounter += 1;
    return `pwprompt-${Date.now().toString(36)}-${promptCounter}`;
}
const neverOrigins = new Set();
/**
 * content.js 가 form submit 감지 시 호출.
 * 결과:
 * - `unchanged`: 기존 항목과 동일 → 즉시 lastUsedAt 갱신만, prompt 없음
 * - `unavailable`/`invalid`: prompt 없음
 * - `prompt`: 외피에 사용자 확인 배너 요청, 응답을 기다림
 */
function proposeSave(args) {
    const origin = normalizeOrigin(args.origin);
    if (!origin)
        return { status: 'invalid' };
    if (!args.username || !args.password)
        return { status: 'invalid' };
    if (!isPasswordStorageAvailable())
        return { status: 'unavailable' };
    if (neverOrigins.has(origin))
        return { status: 'never' };
    const existing = Array.from(passwords.values())
        .find((e) => e.origin === origin && e.username === args.username);
    if (existing) {
        const oldPlain = decrypt(existing.encryptedPassword);
        if (oldPlain === args.password) {
            existing.lastUsedAt = Date.now();
            persist();
            return { status: 'unchanged' };
        }
    }
    const promptId = nextPromptId();
    pendingProposals.set(promptId, {
        promptId,
        origin,
        username: args.username,
        password: args.password,
        isUpdate: !!existing,
        proposedAt: Date.now(),
    });
    exports.passwordEvents.emit('prompt', pendingProposals.get(promptId));
    return { status: 'prompt', promptId, isUpdate: !!existing };
}
function confirmSave(promptId, action) {
    const p = pendingProposals.get(promptId);
    if (!p)
        return { status: 'unknown' };
    pendingProposals.delete(promptId);
    exports.passwordEvents.emit('prompt-resolved', promptId);
    if (action === 'discard')
        return { status: 'discarded' };
    if (action === 'never') {
        neverOrigins.add(p.origin);
        return { status: 'never' };
    }
    if (!isPasswordStorageAvailable())
        return { status: 'unavailable' };
    const encoded = encrypt(p.password);
    if (encoded === null)
        return { status: 'unavailable' };
    const existing = Array.from(passwords.values())
        .find((e) => e.origin === p.origin && e.username === p.username);
    if (existing) {
        existing.encryptedPassword = encoded;
        existing.updatedAt = Date.now();
        existing.lastUsedAt = Date.now();
        persist();
        exports.passwordEvents.emit('changed');
        return { status: 'updated', id: existing.id };
    }
    const e = {
        id: nextId(),
        origin: p.origin,
        username: p.username,
        encryptedPassword: encoded,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastUsedAt: Date.now(),
    };
    passwords.set(e.id, e);
    persist();
    exports.passwordEvents.emit('changed');
    return { status: 'saved', id: e.id };
}
function listPendingProposals() {
    return Array.from(pendingProposals.values());
}
function markUsed(id) {
    const e = passwords.get(id);
    if (!e)
        return;
    e.lastUsedAt = Date.now();
    persist();
}
function removePassword(id) {
    if (passwords.delete(id)) {
        persist();
        exports.passwordEvents.emit('changed');
    }
}
