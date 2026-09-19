"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROFILE_FIELDS = exports.profileEvents = void 0;
exports.getProfile = getProfile;
exports.hasProfileData = hasProfileData;
exports.storageAvailable = storageAvailable;
exports.setProfile = setProfile;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_events_1 = require("node:events");
// 스마트 폼필용 개인 프로필 — 이름·주소·이메일·카드 등. safeStorage(OS 키체인)로 암호화 저장.
// 값은 자동 채우기 시 메인 → 페이지로만 흐르고 AI(LLM)로는 절대 전송되지 않는다(자동 채우기는 결정적).
const FILE = () => (0, node_path_1.join)(electron_1.app.getPath('userData'), 'ai-profile.json');
let cache = {};
let loaded = false;
exports.profileEvents = new node_events_1.EventEmitter();
exports.PROFILE_FIELDS = [
    { key: 'fullName', label: '이름(전체)' },
    { key: 'firstName', label: '이름' },
    { key: 'lastName', label: '성' },
    { key: 'email', label: '이메일' },
    { key: 'phone', label: '전화번호' },
    { key: 'postalCode', label: '우편번호' },
    { key: 'address', label: '주소' },
    { key: 'addressDetail', label: '상세주소' },
    { key: 'city', label: '도시' },
    { key: 'country', label: '국가' },
    { key: 'birthday', label: '생년월일(YYYY-MM-DD)' },
    { key: 'organization', label: '회사/소속' },
    { key: 'username', label: '아이디' },
    { key: 'cardNumber', label: '카드번호', sensitive: true },
    { key: 'cardExp', label: '카드 만료(MM/YY)', sensitive: true },
    { key: 'cardCVC', label: '카드 CVC', sensitive: true },
];
const VALID_KEYS = new Set(exports.PROFILE_FIELDS.map((f) => f.key));
function load() {
    if (loaded)
        return;
    loaded = true;
    try {
        if ((0, node_fs_1.existsSync)(FILE())) {
            const raw = JSON.parse((0, node_fs_1.readFileSync)(FILE(), 'utf8'));
            if (raw?.enc && electron_1.safeStorage.isEncryptionAvailable()) {
                cache = JSON.parse(electron_1.safeStorage.decryptString(Buffer.from(raw.enc, 'base64')));
            }
            else if (raw?.plain) {
                cache = raw.plain;
            }
        }
    }
    catch {
        cache = {};
    }
    if (!cache || typeof cache !== 'object')
        cache = {};
}
function save() {
    try {
        // 암호화 불가 시 저장하지 않는다 — 카드번호·CVC 등 민감 정보를 평문으로 디스크에 남기지 않고,
        // 기존 암호화 파일도 덮어써 파괴하지 않는다(safeStorage 일시 불가 시 보존). password/keys 와 동일 정책.
        if (!electron_1.safeStorage.isEncryptionAvailable())
            return;
        const payload = { enc: electron_1.safeStorage.encryptString(JSON.stringify(cache)).toString('base64') };
        const tmp = FILE() + '.tmp';
        (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(payload), 'utf8');
        (0, node_fs_1.renameSync)(tmp, FILE());
    }
    catch { /* ignore */ }
}
function getProfile() { load(); return { ...cache }; }
function hasProfileData() { load(); return Object.keys(cache).length > 0; }
function storageAvailable() { return electron_1.safeStorage.isEncryptionAvailable(); }
function setProfile(fields) {
    load();
    const next = {};
    for (const [k, v] of Object.entries(fields || {})) {
        if (VALID_KEYS.has(k) && typeof v === 'string' && v.trim())
            next[k] = v.trim().slice(0, 300);
    }
    cache = next;
    save();
    exports.profileEvents.emit('changed');
}
