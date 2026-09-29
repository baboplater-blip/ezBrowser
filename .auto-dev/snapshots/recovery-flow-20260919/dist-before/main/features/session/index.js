"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initSessionTracking = initSessionTracking;
exports.maybeRestoreSession = maybeRestoreSession;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const tab_service_1 = require("../../tabs/tab-service");
const window_service_1 = require("../../windows/window-service");
const workspace_1 = require("../workspace");
const session_bootstrap_1 = require("../../session-bootstrap");
const settings_1 = require("../../storage/settings");
const SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 5_000;
// 구조 변경(탭 추가·삭제·이동·핀)과 내비게이션은 더 짧게 — 크래시 손실 창 축소
const SAVE_SOON_MS = 1_000;
const FORCE_SAVE_MS = 30_000;
// 즉시 로드할 탭 수 상한 (활성·핀 외) — 가벼움 예산 보호
const EAGER_TAIL = 5;
function sessionsDir() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'sessions');
}
function currentPath() { return node_path_1.default.join(sessionsDir(), 'current.json'); }
function lastStablePath() { return node_path_1.default.join(sessionsDir(), 'last-stable.json'); }
function buildSnapshot() {
    return { version: SCHEMA_VERSION, savedAt: Date.now(), windows: (0, tab_service_1.collectSession)() };
}
function writeSnapshot(target, snap) {
    try {
        (0, node_fs_1.mkdirSync)(sessionsDir(), { recursive: true });
        const tmp = `${target}.tmp`;
        (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(snap));
        (0, node_fs_1.renameSync)(tmp, target); // 원자적 교체 (sync)
    }
    catch (err) {
        console.warn('[session] write failed', target, err);
    }
}
function readSnapshot(target) {
    try {
        if (!(0, node_fs_1.existsSync)(target))
            return null;
        const raw = (0, node_fs_1.readFileSync)(target, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== SCHEMA_VERSION || !Array.isArray(parsed.windows))
            return null;
        return parsed;
    }
    catch (err) {
        console.warn('[session] read failed', target, err);
        return null;
    }
}
function safeUnlink(target) {
    try {
        if ((0, node_fs_1.existsSync)(target))
            (0, node_fs_1.unlinkSync)(target);
    }
    catch { /* ignore */ }
}
// ===== 저장 트리거 =====
let saveTimer = null;
let forceTimer = null;
let restoring = false;
let quitting = false;
function scheduleSave(delay = SAVE_DEBOUNCE_MS) {
    if (restoring || quitting)
        return; // 종료 절차 중 탭 종료가 'list' 를 발화해 빈 스냅샷을 다시 쓰지 않도록
    if (saveTimer)
        clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        writeSnapshot(currentPath(), buildSnapshot());
    }, delay);
}
// 구조 변경·내비게이션: 짧은 디바운스로 즉시 반영
function scheduleSaveSoon() { scheduleSave(SAVE_SOON_MS); }
function initSessionTracking() {
    tab_service_1.tabEvents.on('list', scheduleSaveSoon); // 탭 추가/삭제/이동/핀 — 손실 시 가장 치명적
    tab_service_1.tabEvents.on('update', () => scheduleSave()); // 제목/파비콘/로딩 — 5초 디바운스로 충분
    (0, tab_service_1.onTabNavigated)(scheduleSaveSoon); // 페이지 이동 — URL·히스토리 빠르게 반영
    window_service_1.windowEvents.on('created', (ctx) => {
        ctx.win.on('resize', () => scheduleSave());
        ctx.win.on('move', () => scheduleSave());
        // 파괴 전(close) 시점 — 탭이 아직 살아있을 때 동기 스냅샷. 종료 절차 중엔 금지.
        ctx.win.on('close', () => {
            if (restoring || quitting)
                return;
            writeSnapshot(currentPath(), buildSnapshot());
        });
    });
    // 30초 주기 강제 저장 (디바운스 무효화)
    forceTimer = setInterval(() => {
        if (restoring || (0, window_service_1.getAllWindows)().length === 0)
            return;
        writeSnapshot(currentPath(), buildSnapshot());
    }, FORCE_SAVE_MS);
    if (typeof forceTimer.unref === 'function')
        forceTimer.unref();
    // 정상 종료: last-stable 동기 기록 + current 제거(다음 부팅 시 깨끗한 종료로 인식)
    electron_1.app.on('before-quit', () => {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        if (forceTimer) {
            clearInterval(forceTimer);
            forceTimer = null;
        }
        quitting = true;
        try {
            const snap = buildSnapshot();
            if (snap.windows.length > 0) {
                writeSnapshot(lastStablePath(), snap);
            }
            else {
                const cur = readSnapshot(currentPath());
                if (cur && cur.windows.length > 0)
                    writeSnapshot(lastStablePath(), cur);
            }
            safeUnlink(currentPath());
            // 쿠키·로컬스토리지 디스크 flush — SIGKILL 외 정상 종료 시 최근 세션 데이터 유실 방지
            (0, session_bootstrap_1.forEachInstalledSession)((ses) => {
                try {
                    ses.flushStorageData();
                }
                catch { /* best-effort */ }
                try {
                    void ses.cookies.flushStore();
                }
                catch { /* best-effort */ }
            });
        }
        catch (err) {
            console.warn('[session] before-quit save failed', err);
        }
    });
}
// ===== 복원 =====
async function restoreSnapshot(snap) {
    if (snap.windows.length === 0)
        return false;
    restoring = true;
    try {
        const activeWsId = (0, workspace_1.getActiveWorkspaceId)();
        for (const w of snap.windows) {
            const ctx = (0, window_service_1.createBrowserWindow)();
            try {
                if (w.bounds)
                    ctx.win.setBounds(w.bounds);
            }
            catch { /* invalid bounds */ }
            // 탭 그룹 먼저 등록 — 탭 생성 시 groupId 매칭
            if (Array.isArray(w.groups) && w.groups.length > 0)
                (0, tab_service_1.registerRestoredGroups)(ctx.id, w.groups);
            // 즉시 로드 대상: 활성 탭 + 핀 + 마지막 EAGER_TAIL 개
            const eager = new Set();
            w.tabs.forEach((t, i) => { if (t.active || t.pinned)
                eager.add(i); });
            for (let i = Math.max(0, w.tabs.length - EAGER_TAIL); i < w.tabs.length; i += 1)
                eager.add(i);
            let activeTabId = null;
            // 스냅샷에 명시된 active 탭이 없는 이상 케이스를 대비한 폴백 (창에 보이는 탭이 0개가 되는 것을 방지)
            let firstCreatedId = null;
            // 분할 레이아웃 복원용: (원본 워크스페이스 id, 저장 index) → 새 tabId
            const idMap = new Map();
            w.tabs.forEach((t, i) => {
                // 존재하지 않는 워크스페이스면 활성 워크스페이스로 폴백
                const wsId = (0, workspace_1.getWorkspace)(t.workspaceId) ? t.workspaceId : activeWsId;
                const isEager = eager.has(i);
                const created = (0, tab_service_1.createTab)({
                    windowId: ctx.id,
                    url: t.url,
                    workspaceId: wsId,
                    background: true,
                    restoreDiscarded: !isEager,
                    restoreTitle: t.title,
                    restoreHistory: t.history,
                    restoreHistoryIndex: t.historyIndex,
                    groupId: t.groupId,
                });
                if (firstCreatedId === null)
                    firstCreatedId = created.id;
                idMap.set(`${t.workspaceId}::${t.index}`, created.id);
                if (t.pinned)
                    (0, tab_service_1.pinTab)(created.id, true);
                if (t.active)
                    activeTabId = created.id;
            });
            if (activeTabId)
                (0, tab_service_1.activateTab)(activeTabId);
            else if (firstCreatedId)
                (0, tab_service_1.activateTab)(firstCreatedId);
            // 분할 화면 레이아웃 복원 (활성 워크스페이스면 즉시 반영)
            if (Array.isArray(w.layouts)) {
                for (const ls of w.layouts) {
                    (0, tab_service_1.restoreWorkspaceLayout)(ctx.id, ls, (wsId, tabIndex) => idMap.get(`${wsId}::${tabIndex}`) ?? null);
                }
            }
        }
        return true;
    }
    finally {
        restoring = false;
    }
}
/**
 * 부팅 시 세션 복원 시도. 창을 하나라도 만들었으면 true 반환(호출측이 기본 창 생성을 건너뜀).
 * 정책(settings.startup.mode):
 *  - last-session: last-stable(또는 current) 자동 복원
 *  - urls: 지정 URL 목록 새 창에 열기
 *  - newtab: 기본 동작 — 단, 비정상 종료(current.json 잔존) 감지 시 복원 여부를 사용자에게 물음
 */
async function maybeRestoreSession() {
    const startup = (0, settings_1.getSetting)('startup');
    const current = readSnapshot(currentPath());
    const lastStable = readSnapshot(lastStablePath());
    if (startup.mode === 'last-session') {
        // current.json 이 남아 있으면 = 직전 비정상 종료 → current 가 last-stable(직전 정상 종료본)보다
        // 최신이다. savedAt 으로 더 최신 스냅샷을 골라 크래시된 세션의 탭을 잃지 않는다.
        const snap = (current && lastStable)
            ? ((current.savedAt ?? 0) >= (lastStable.savedAt ?? 0) ? current : lastStable)
            : (current ?? lastStable);
        // 복원이 끝난 뒤에 current 제거 — 복원 도중 재크래시 시 다음 부팅에서 다시 감지되도록
        if (snap && snap.windows.length > 0) {
            const ok = await restoreSnapshot(snap);
            safeUnlink(currentPath());
            return ok;
        }
        safeUnlink(currentPath());
        return false;
    }
    if (startup.mode === 'urls') {
        const urls = (startup.urls ?? []).filter((u) => /^https?:|^browser:/i.test(u));
        if (urls.length === 0)
            return false;
        const ctx = (0, window_service_1.createBrowserWindow)();
        urls.forEach((url, i) => { (0, tab_service_1.createTab)({ windowId: ctx.id, url, background: i !== 0 }); });
        return true;
    }
    // newtab 모드: current.json 이 남아 있으면 = 직전 비정상 종료 → 복원 여부 질문
    if (current && current.windows.length > 0) {
        const tabCount = current.windows.reduce((n, w) => n + w.tabs.length, 0);
        const result = await electron_1.dialog.showMessageBox({
            type: 'question',
            buttons: ['세션 복원', '새 탭으로 시작'],
            defaultId: 0,
            cancelId: 1,
            title: '지난 세션 복원',
            message: '브라우저가 비정상 종료된 것 같습니다.',
            detail: `직전 세션의 탭 ${tabCount}개를 복원하시겠습니까?`,
        });
        // 복원을 마친 뒤에 current 제거 — 복원 도중 재크래시해도 다음 부팅에서 다시 복원 가능하도록.
        if (result.response === 0) {
            const ok = await restoreSnapshot(current);
            safeUnlink(currentPath());
            return ok;
        }
        safeUnlink(currentPath());
        return false;
    }
    safeUnlink(currentPath());
    return false;
}
