"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.triggerEvents = void 0;
exports.listTriggers = listTriggers;
exports.addTrigger = addTrigger;
exports.updateTrigger = updateTrigger;
exports.removeTrigger = removeTrigger;
exports.setTriggerEnabled = setTriggerEnabled;
exports.onNavigatedForTriggers = onNavigatedForTriggers;
exports.initAgentTriggers = initAgentTriggers;
const electron_1 = require("electron");
const node_crypto_1 = require("node:crypto");
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const agent_1 = require("./agent");
const window_service_1 = require("../../windows/window-service");
const tab_service_1 = require("../../tabs/tab-service");
const FILE = () => (0, node_path_1.join)(electron_1.app.getPath('userData'), 'ai-triggers.json');
let triggers = [];
exports.triggerEvents = new node_events_1.EventEmitter();
let saveTimer = null;
function writeNow() {
    try {
        const tmp = FILE() + '.tmp';
        (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(triggers, null, 2), 'utf8');
        (0, node_fs_1.renameSync)(tmp, FILE());
    }
    catch { /* ignore */ }
}
function persist() {
    if (saveTimer)
        clearTimeout(saveTimer);
    saveTimer = setTimeout(writeNow, 300);
}
// 발화 사실만은 디바운스 없이 즉시 기록한다 — 발화 직후 앱이 죽으면(크래시·강제 종료) 300ms 저장이 날아가
// 다음 실행에서 같은 날 같은 작업이 한 번 더 돌아 중복 게시가 된다.
function persistNow() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    writeNow();
}
function emitChanged() { exports.triggerEvents.emit('changed', listTriggers()); }
function clone(t) { return { ...t }; }
function listTriggers() { return triggers.map(clone); }
function sanitize(p, base) {
    const type = (p.type === 'url' || p.type === 'daily' || p.type === 'watch') ? p.type : (base?.type ?? 'url');
    return {
        id: base?.id ?? (0, node_crypto_1.randomUUID)(),
        name: String(p.name ?? base?.name ?? '트리거').slice(0, 80),
        type,
        enabled: p.enabled != null ? !!p.enabled : (base?.enabled ?? true),
        task: String(p.task ?? base?.task ?? '').slice(0, 4000),
        autoConfirm: p.autoConfirm != null ? !!p.autoConfirm : (base?.autoConfirm ?? false),
        notify: p.notify != null ? !!p.notify : (base?.notify ?? true),
        urlPattern: p.urlPattern != null ? String(p.urlPattern).slice(0, 300) : base?.urlPattern,
        time: p.time != null ? String(p.time).slice(0, 5) : base?.time,
        openUrl: p.openUrl != null ? String(p.openUrl).slice(0, 500) : base?.openUrl,
        selector: p.selector != null ? String(p.selector).slice(0, 200) : base?.selector,
        intervalMinutes: p.intervalMinutes != null ? Math.max(1, Math.min(1440, Math.round(Number(p.intervalMinutes) || 10))) : base?.intervalMinutes,
        runOnChange: p.runOnChange != null ? !!p.runOnChange : (base?.runOnChange ?? false),
        lastValue: base?.lastValue,
        lastRun: base?.lastRun,
        lastFiredDay: base?.lastFiredDay,
        lastResult: base?.lastResult,
        createdAt: base?.createdAt ?? Date.now(),
    };
}
function addTrigger(p) {
    const t = sanitize(p);
    triggers.push(t);
    persist();
    emitChanged();
    return clone(t);
}
function updateTrigger(id, p) {
    const i = triggers.findIndex((t) => t.id === id);
    if (i < 0)
        return;
    triggers[i] = sanitize(p, triggers[i]);
    persist();
    emitChanged();
}
function removeTrigger(id) {
    triggers = triggers.filter((t) => t.id !== id);
    persist();
    emitChanged();
}
function setTriggerEnabled(id, on) {
    const t = triggers.find((x) => x.id === id);
    if (t) {
        t.enabled = !!on;
        persist();
        emitChanged();
    }
}
// ===== 매칭·유틸 =====
function urlMatch(pattern, url) {
    if (!pattern)
        return false;
    try {
        const rx = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
        return rx.test(url);
    }
    catch {
        return false;
    }
}
function simpleHash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++)
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h >>> 0);
}
function notify(title, body) {
    try {
        if (electron_1.Notification.isSupported())
            new electron_1.Notification({ title, body }).show();
    }
    catch { /* ignore */ }
}
function firstWindowId() {
    const ws = (0, window_service_1.getAllWindows)();
    return ws[0]?.id ?? null;
}
function activeHttpTab(windowId) {
    const tabs = (0, tab_service_1.listTabs)(windowId);
    const active = tabs.find((t) => t.active) ?? tabs[tabs.length - 1];
    if (active) {
        const wc = (0, tab_service_1.getWebContentsByTabId)(active.id);
        if (wc && !wc.isDestroyed() && /^https?:/i.test(wc.getURL()))
            return active.id;
    }
    return null;
}
function waitLoad(tabId) {
    return new Promise((resolve) => {
        const wc = (0, tab_service_1.getWebContentsByTabId)(tabId);
        if (!wc || !wc.isLoading()) {
            resolve();
            return;
        }
        let done = false;
        const fin = () => { if (!done) {
            done = true;
            resolve();
        } };
        wc.once('did-finish-load', fin);
        wc.once('did-fail-load', fin);
        setTimeout(fin, 20000);
    });
}
// ===== 실행 =====
async function runTriggerTask(t, tabId) {
    const reqId = (0, node_crypto_1.randomUUID)();
    let outcome = '';
    try {
        // unattended: 전역 "무인 실행 승인" 토글에 좌우되지 않고 이 트리거의 autoConfirm 만 따른다.
        // critical(결제·삭제)은 autoConfirm 이어도 자동 승인하지 않는다 — 사용자가 없을 때가 가장 위험하다.
        await (0, agent_1.runAgentTask)({ reqId, tabId, task: t.task, unattended: true }, (evt) => {
            if (evt.type === 'confirm') {
                if (evt.critical) {
                    outcome = `안전 중단: ${String(evt.label ?? '되돌릴 수 없는 동작')}`;
                    (0, agent_1.cancelAgentTask)(reqId);
                }
                else if (t.autoConfirm)
                    (0, agent_1.confirmAgentStep)(reqId, true);
                else
                    (0, agent_1.cancelAgentTask)(reqId);
            }
            else if (evt.type === 'ask')
                (0, agent_1.cancelAgentTask)(reqId);
            else if (evt.type === 'done')
                outcome = String(evt.message ?? '완료');
            // 단계 예산 소진 — 예전에는 agent.ts 가 여기에도 done 을 보내 "완료"로 기록됐다.
            // 이제 별도 이벤트이므로 직접 받아 **완료가 아니라 미완**으로 남긴다(안 받으면 결과가 빈 채로 끝난다).
            else if (evt.type === 'exhausted')
                outcome = `미완료: ${String(evt.stepsUsed ?? '')}단계까지 진행했지만 끝내지 못했습니다`;
            else if (evt.type === 'error')
                outcome = '오류: ' + String(evt.message ?? '');
        });
    }
    catch (err) {
        outcome = '오류: ' + String(err);
    }
    t.lastRun = Date.now();
    t.lastResult = outcome.slice(0, 200);
    persist();
    emitChanged();
    if (t.notify && outcome)
        notify(`AI 트리거: ${t.name}`, outcome.slice(0, 220));
}
// URL 진입 트리거 — 네비게이션 훅에서 호출. 쿨다운으로 에이전트 자체 네비 루프 방지.
const urlCooldown = new Map();
function onNavigatedForTriggers(tabId, url) {
    if (!/^https?:/i.test(url))
        return;
    for (const t of triggers) {
        if (!t.enabled || t.type !== 'url' || !t.urlPattern)
            continue;
        if (!urlMatch(t.urlPattern, url))
            continue;
        const last = urlCooldown.get(t.id) ?? 0;
        if (Date.now() - last < 60000)
            continue;
        urlCooldown.set(t.id, Date.now());
        void runTriggerTask(t, tabId);
    }
}
// 매일 시각 트리거 — lastFiredDay(영속) 로 하루 1회 보장. 재시작해도 같은 날 중복 발화하지 않고,
// 절전/지연으로 정확한 분을 놓쳐도 그날 안에 시각이 지났으면 실행(catch-up).
function dailyTick() {
    const now = new Date();
    const cur = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const day = now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate();
    for (const t of triggers) {
        if (!t.enabled || t.type !== 'daily' || !t.time)
            continue;
        if (t.lastFiredDay === day)
            continue;
        if (cur < t.time)
            continue; // "HH:MM" 0 패딩 문자열 비교 — 목표 시각이 아직 안 됨
        t.lastFiredDay = day;
        persistNow(); // 크래시로 중복 발화하지 않도록 즉시 기록
        void runDaily(t);
    }
}
async function runDaily(t) {
    const wid = firstWindowId();
    if (!wid)
        return;
    let tabId;
    if (t.openUrl && /^https?:/i.test(t.openUrl)) {
        const nt = (0, tab_service_1.createTab)({ windowId: wid, url: t.openUrl });
        tabId = nt.id;
        await waitLoad(tabId);
    }
    else
        tabId = activeHttpTab(wid);
    if (!tabId)
        return;
    await runTriggerTask(t, tabId);
}
// 변경 감지 트리거 — 숨은 창으로 몰래 확인.
async function backgroundText(url, selector) {
    let win = null;
    // 무한 스트리밍/멈춘 페이지에서 loadURL/executeJavaScript 가 영영 settle 안 되면 숨은 창이 누수되고
    // watchTick 이 인터벌마다 새 창을 또 만들어 무한 누적된다 → 반드시 타임아웃으로 감싼다.
    const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
    try {
        win = new electron_1.BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
        await withTimeout(win.loadURL(url), 30000).catch(() => { });
        const js = selector
            ? `(function(){var e=document.querySelector(${JSON.stringify(selector)});return e?(e.innerText||e.textContent||''):'';})()`
            : `(document.body?document.body.innerText:'')`;
        const txt = await withTimeout(win.webContents.executeJavaScript(js, true), 10000);
        return String(txt ?? '').replace(/\s+/g, ' ').trim().slice(0, 20000);
    }
    catch {
        return null;
    }
    finally {
        try {
            win?.destroy();
        }
        catch { /* ignore */ }
    }
}
function watchTick() {
    for (const t of triggers) {
        if (!t.enabled || t.type !== 'watch' || !t.openUrl)
            continue;
        const iv = Math.max(1, t.intervalMinutes ?? 10) * 60000;
        if (Date.now() - (t.lastRun ?? 0) < iv)
            continue;
        t.lastRun = Date.now();
        void runWatch(t);
    }
}
// 페이지 텍스트를 "의미 있는 변화"만 남도록 정규화한다.
// 시계·조회수·상대시각·광고 회전처럼 매번 달라지는 값이 그대로 해시에 들어가면, 아무 새 글이 없어도
// 매 검사마다 해시가 달라져 runOnChange 작업이 무한 재실행된다(같은 글 반복 게시 → 계정 스팸).
function normalizeForWatch(text) {
    return text
        .replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ') // 시:분(:초)
        .replace(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/g, ' ') // 날짜
        .replace(/\d+\s*(초|분|시간|일|주|개월|년)\s*(전|후)/g, ' ') // 3분 전 / 2시간 전
        .replace(/\d+\s*(seconds?|minutes?|hours?|days?)\s+ago/gi, ' ')
        .replace(/[\d,]{2,}\s*(회|명|개|건|views?|comments?|likes?)/gi, ' ') // 조회수·댓글수
        .replace(/\s+/g, ' ')
        .trim();
}
// 변경 감지가 발화한 뒤의 쿨다운 — 연속 발화로 같은 작업이 반복되는 것을 막는다.
const WATCH_FIRE_COOLDOWN_MS = 30 * 60_000;
const watchLastFire = new Map();
async function runWatch(t) {
    const text = await backgroundText(t.openUrl ?? '', t.selector);
    if (text == null) {
        persist();
        return;
    }
    const hash = simpleHash(normalizeForWatch(text));
    if (t.lastValue && t.lastValue !== hash) {
        const last = watchLastFire.get(t.id) ?? 0;
        if (Date.now() - last < WATCH_FIRE_COOLDOWN_MS) {
            // 아직 쿨다운 중 — 해시만 갱신하고 이번 변화로는 작업을 돌리지 않는다.
            t.lastValue = hash;
            persist();
            return;
        }
        watchLastFire.set(t.id, Date.now());
        if (t.notify)
            notify(`변경 감지: ${t.name}`, `${t.openUrl} 의 내용이 바뀌었습니다.`);
        if (t.runOnChange) {
            const wid = firstWindowId();
            if (wid) {
                const nt = (0, tab_service_1.createTab)({ windowId: wid, url: t.openUrl ?? '' });
                await waitLoad(nt.id);
                await runTriggerTask(t, nt.id);
            }
        }
    }
    t.lastValue = hash;
    persist();
    emitChanged();
}
let dailyTimer = null;
let watchTimer = null;
function initAgentTriggers() {
    try {
        if ((0, node_fs_1.existsSync)(FILE())) {
            const raw = JSON.parse((0, node_fs_1.readFileSync)(FILE(), 'utf8'));
            if (Array.isArray(raw))
                triggers = raw.map((t) => sanitize(t, t));
        }
    }
    catch {
        triggers = [];
    }
    if (!dailyTimer)
        dailyTimer = setInterval(dailyTick, 30000);
    if (!watchTimer)
        watchTimer = setInterval(watchTick, 60000);
    // 종료 시 디바운스 대기 중이던 상태(lastValue·lastFiredDay·lastRun)를 즉시 flush — 안 그러면 재시작 후
    // watch 가 "변경됨" 을 다시 알리거나 daily 가 중복 발화한다.
    electron_1.app.on('before-quit', () => {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        try {
            const tmp = FILE() + '.tmp';
            (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(triggers, null, 2), 'utf8');
            (0, node_fs_1.renameSync)(tmp, FILE());
        }
        catch { /* ignore */ }
    });
}
