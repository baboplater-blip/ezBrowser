"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectImportSources = detectImportSources;
exports.runImport = runImport;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const db_1 = require("../../storage/db");
const bookmarks_1 = require("../../storage/bookmarks");
const history_1 = require("../../storage/history");
// Chrome epoch(1601-01-01) → Unix epoch(1970-01-01) 차이(밀리초)
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;
function browserDefs() {
    const home = node_os_1.default.homedir();
    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA || node_path_1.default.join(home, 'AppData', 'Local');
        return [
            { key: 'chrome', name: 'Chrome', userDataDirs: [node_path_1.default.join(local, 'Google', 'Chrome', 'User Data')] },
            { key: 'edge', name: 'Edge', userDataDirs: [node_path_1.default.join(local, 'Microsoft', 'Edge', 'User Data')] },
            { key: 'brave', name: 'Brave', userDataDirs: [node_path_1.default.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')] },
            { key: 'whale', name: 'Whale', userDataDirs: [node_path_1.default.join(local, 'Naver', 'Naver Whale', 'User Data')] },
        ];
    }
    if (process.platform === 'darwin') {
        const as = node_path_1.default.join(home, 'Library', 'Application Support');
        return [
            { key: 'chrome', name: 'Chrome', userDataDirs: [node_path_1.default.join(as, 'Google', 'Chrome')] },
            { key: 'edge', name: 'Edge', userDataDirs: [node_path_1.default.join(as, 'Microsoft Edge')] },
            { key: 'brave', name: 'Brave', userDataDirs: [node_path_1.default.join(as, 'BraveSoftware', 'Brave-Browser')] },
            { key: 'whale', name: 'Whale', userDataDirs: [node_path_1.default.join(as, 'Naver', 'Whale')] },
        ];
    }
    const cfg = node_path_1.default.join(home, '.config');
    return [
        { key: 'chrome', name: 'Chrome', userDataDirs: [node_path_1.default.join(cfg, 'google-chrome')] },
        { key: 'edge', name: 'Edge', userDataDirs: [node_path_1.default.join(cfg, 'microsoft-edge')] },
        { key: 'brave', name: 'Brave', userDataDirs: [node_path_1.default.join(cfg, 'BraveSoftware', 'Brave-Browser')] },
    ];
}
async function detectProfiles(def) {
    const out = [];
    for (const ud of def.userDataDirs) {
        if (!(0, node_fs_1.existsSync)(ud))
            continue;
        let entries = [];
        try {
            entries = await (0, promises_1.readdir)(ud);
        }
        catch {
            continue;
        }
        for (const name of entries) {
            // Chromium 프로필 디렉터리: 'Default' 또는 'Profile N'
            if (name !== 'Default' && !/^Profile \d+$/.test(name))
                continue;
            const dir = node_path_1.default.join(ud, name);
            const hasBookmarks = (0, node_fs_1.existsSync)(node_path_1.default.join(dir, 'Bookmarks'));
            const hasHistory = (0, node_fs_1.existsSync)(node_path_1.default.join(dir, 'History'));
            if (!hasBookmarks && !hasHistory)
                continue;
            let display = name;
            try {
                const prefRaw = await (0, promises_1.readFile)(node_path_1.default.join(dir, 'Preferences'), 'utf-8');
                const pref = JSON.parse(prefRaw);
                if (pref?.profile?.name)
                    display = pref.profile.name;
            }
            catch { /* Preferences 없거나 손상 — 폴더명 사용 */ }
            out.push({
                id: `${def.key}::${name}`,
                browser: def.name,
                profile: display,
                profileDir: dir,
                hasBookmarks,
                hasHistory,
            });
        }
    }
    return out;
}
async function detectAll() {
    const defs = browserDefs();
    const all = await Promise.all(defs.map(detectProfiles));
    return all.flat();
}
/** 설치된 Chromium 계열 브라우저의 가져오기 가능한 프로필 목록 (렌더러 안전 형태). */
async function detectImportSources() {
    const sources = await detectAll();
    return sources.map(({ profileDir: _omit, ...pub }) => pub);
}
function importBookmarkChildren(node, parentFolderId, counts) {
    const children = node.children ?? [];
    for (const child of children) {
        if (child.type === 'folder') {
            const folder = (0, bookmarks_1.createFolder)({ name: child.name || '폴더', parentId: parentFolderId });
            counts.folders += 1;
            importBookmarkChildren(child, folder.id, counts);
        }
        else if (child.type === 'url' && child.url && /^https?:|^ftp:|^file:/i.test(child.url)) {
            (0, bookmarks_1.addBookmark)({ url: child.url, title: child.name || child.url, folderId: parentFolderId });
            counts.bookmarks += 1;
        }
    }
}
function importBookmarks(src, result) {
    const file = node_path_1.default.join(src.profileDir, 'Bookmarks');
    let json;
    try {
        json = JSON.parse((0, node_fs_1.readFileSync)(file, 'utf-8'));
    }
    catch (err) {
        result.errors.push(`북마크 파일을 읽지 못했습니다: ${err.message}`);
        return;
    }
    const roots = json.roots;
    if (!roots)
        return;
    const counts = { folders: 0, bookmarks: 0 };
    const rootFolder = (0, bookmarks_1.createFolder)({ name: `${src.browser}에서 가져온 북마크`, parentId: null });
    counts.folders += 1;
    // 북마크 바 — 가져오기 루트 폴더 바로 아래에 평면 배치
    if (roots.bookmark_bar)
        importBookmarkChildren(roots.bookmark_bar, rootFolder.id, counts);
    // 기타 북마크 / 모바일 북마크 — 하위 폴더로
    if (roots.other?.children?.length) {
        const f = (0, bookmarks_1.createFolder)({ name: '기타 북마크', parentId: rootFolder.id });
        counts.folders += 1;
        importBookmarkChildren(roots.other, f.id, counts);
    }
    if (roots.synced?.children?.length) {
        const f = (0, bookmarks_1.createFolder)({ name: '모바일 북마크', parentId: rootFolder.id });
        counts.folders += 1;
        importBookmarkChildren(roots.synced, f.id, counts);
    }
    result.bookmarks += counts.bookmarks;
    result.folders += counts.folders;
}
async function importHistory(src, result) {
    const srcFile = node_path_1.default.join(src.profileDir, 'History');
    if (!(0, node_fs_1.existsSync)(srcFile))
        return;
    // 원본은 브라우저가 잠그고 있을 수 있으므로 임시 복사 후 읽는다.
    const tmp = node_path_1.default.join(electron_1.app.getPath('temp'), `bb-import-history-${process.pid}-${Date.now()}.sqlite`);
    try {
        await (0, promises_1.copyFile)(srcFile, tmp);
    }
    catch (err) {
        result.errors.push(`방문 기록을 복사하지 못했습니다. 해당 브라우저를 완전히 종료하고 다시 시도하세요. (${err.message})`);
        return;
    }
    try {
        const db = await (0, db_1.openExternalSqlite)(tmp);
        const entries = [];
        try {
            const res = db.exec('SELECT url, title, visit_count, last_visit_time FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT 5000');
            const rows = res[0]?.values ?? [];
            for (const row of rows) {
                const url = row[0];
                if (!url)
                    continue;
                const title = row[1] || url;
                const visitCount = row[2] || 1;
                const chromeTime = row[3] || 0;
                const lastVisitAt = chromeTime > 0
                    ? Math.round(chromeTime / 1000) - CHROME_EPOCH_OFFSET_MS
                    : Date.now();
                entries.push({ url, title, visitCount, lastVisitAt });
            }
        }
        finally {
            db.close();
        }
        result.history += (0, history_1.importVisits)(entries);
    }
    catch (err) {
        result.errors.push(`방문 기록을 읽지 못했습니다: ${err.message}`);
    }
    finally {
        await (0, promises_1.unlink)(tmp).catch(() => { });
    }
}
/** 지정 프로필에서 북마크·방문 기록을 현재 브라우저로 가져온다. */
async function runImport(sourceId, opts) {
    const result = { ok: false, bookmarks: 0, folders: 0, history: 0, errors: [] };
    const sources = await detectAll();
    const src = sources.find((s) => s.id === sourceId);
    if (!src) {
        result.errors.push('가져올 프로필을 찾을 수 없습니다.');
        return result;
    }
    if (opts.bookmarks && src.hasBookmarks) {
        try {
            importBookmarks(src, result);
        }
        catch (err) {
            result.errors.push(`북마크 가져오기 실패: ${err.message}`);
        }
    }
    if (opts.history && src.hasHistory) {
        await importHistory(src, result);
    }
    result.ok = result.bookmarks > 0 || result.history > 0 || result.errors.length === 0;
    return result;
}
