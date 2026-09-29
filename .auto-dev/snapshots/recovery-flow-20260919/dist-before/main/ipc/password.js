"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPasswordIpc = registerPasswordIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const password_1 = require("../features/password");
const window_service_1 = require("../windows/window-service");
const tab_service_1 = require("../tabs/tab-service");
const trust_1 = require("./trust");
/**
 * 요청을 **실제로 보낸 프레임**의 origin.
 *
 * 예전에는 `e.sender.getURL()`(= 탭의 **최상위 문서** URL)만 봤다. 그래서 페이지 안에 박힌 다른 출처의
 * iframe 이 content preload 로 lookup 을 부르면, 그 프레임이 아니라 **최상위 페이지의** 자격증명을
 * 돌려줬다 — 광고·위젯 iframe 하나가 그 사이트에 저장된 아이디·비밀번호를 가져갈 수 있는 경로였다.
 * 이제 `senderFrame` 의 URL 을 쓰고, 그것을 읽을 수 없으면 **거부**한다(모르면 주지 않는다).
 */
function senderOrigin(e) {
    try {
        const f = e.senderFrame;
        if (f) {
            let u = '';
            try {
                u = f.url;
            }
            catch {
                u = '';
            }
            // 프레임 URL 을 못 읽었으면(파괴됨 등) 최상위로 대체하지 않는다 — fail-closed.
            return u ? (0, password_1.normalizeOrigin)(u) : null;
        }
        // senderFrame 자체가 없는 경우(최상위 webContents 직접 호출)만 sender URL 로.
        return (0, password_1.normalizeOrigin)(e.sender.getURL());
    }
    catch {
        return null;
    }
}
// ===== 런타임 타입 검사 =====
// 신뢰된 sender 라도 인자 모양까지 믿지 않는다. 저장소가 "받은 값을 그대로 파일에 쓰는" 경로였던
// 전례(keymap)가 있어, 사용자 입력이 디스크로 가는 길목마다 형태를 검사한다.
function asObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}
function optString(v) {
    return typeof v === 'string' ? v : undefined;
}
function optBool(v) {
    return typeof v === 'boolean' ? v : undefined;
}
// 시크릿 탭에서 온 요청인지 — 자동 저장 제안(proposeSave)만 막는다.
// 자동 "입력"(lookup)은 Chrome 과 동일하게 시크릿 탭에서도 허용.
function isIncognitoSender(e) {
    const found = (0, tab_service_1.findTabIdByWebContentsId)(e.sender.id);
    if (!found)
        return false;
    return ((0, tab_service_1.getTabPartition)(found.tabId) ?? '').startsWith('incognito');
}
function registerPasswordIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.password.available, () => (0, password_1.isPasswordStorageAvailable)());
    electron_1.ipcMain.handle(ipc_channels_1.IPC.password.list, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, password_1.listPasswords)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.password.reveal, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        const id = optString(asObject(args)?.id);
        if (!id)
            return null;
        const plain = (0, password_1.revealPassword)(id);
        if (plain)
            (0, password_1.markUsed)(id);
        return plain;
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.password.remove, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        const o = asObject(args);
        const id = optString(o?.id);
        if (!id)
            throw new Error('invalid');
        (0, password_1.removePassword)(id);
    });
    // 선등록 — 신뢰된 내부 페이지(browser://passwords)만. 외부 사이트에는 preload 에서도 노출되지 않는다.
    electron_1.ipcMain.handle(ipc_channels_1.IPC.password.add, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        const o = asObject(args);
        if (!o)
            return { ok: false, reason: 'invalid', message: '입력 형식이 올바르지 않습니다.' };
        const origin = optString(o.origin);
        const username = optString(o.username);
        const password = optString(o.password);
        if (origin === undefined || username === undefined || password === undefined) {
            return { ok: false, reason: 'invalid', message: '사이트 주소·사용자명·비밀번호를 모두 입력해 주세요.' };
        }
        return (0, password_1.addPassword)({ origin, username, password, autoLoginAllowed: optBool(o.autoLoginAllowed) === true });
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.password.update, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        const o = asObject(args);
        const id = optString(o?.id);
        if (!o || !id)
            return { ok: false, reason: 'invalid', message: '입력 형식이 올바르지 않습니다.' };
        return (0, password_1.updatePassword)({
            id,
            username: optString(o.username),
            password: optString(o.password),
            autoLoginAllowed: optBool(o.autoLoginAllowed),
            preferred: optBool(o.preferred),
        });
    });
    // content.js 가 sender → main 으로 호출. origin 은 sender URL 에서 강제 유도(변조 방지).
    electron_1.ipcMain.handle(ipc_channels_1.IPC.password.lookup, (e) => {
        const origin = senderOrigin(e);
        if (!origin)
            return [];
        return (0, password_1.lookupForOrigin)(origin);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.password.proposeSave, (e, args) => {
        // 시크릿 탭은 저장 제안 자체를 하지 않는다 — 사용자 확인 배너도 뜨지 않음(무기록 원칙).
        if (isIncognitoSender(e))
            return { status: 'never' };
        const origin = senderOrigin(e);
        if (!origin)
            return { status: 'invalid' };
        const o = asObject(args);
        const username = optString(o?.username);
        const password = optString(o?.password);
        if (username === undefined || password === undefined)
            return { status: 'invalid' };
        return (0, password_1.proposeSave)({ origin, username, password });
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.password.confirmSave, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, password_1.confirmSave)(args.promptId, args.action);
    });
    password_1.passwordEvents.on('changed', () => {
        const list = (0, password_1.listPasswords)();
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            ctx.chrome.webContents.send(ipc_channels_1.IPC.password.changed, list);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.password.changed, list);
    });
    password_1.passwordEvents.on('prompt', (p) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            ctx.chrome.webContents.send(ipc_channels_1.IPC.password.promptOpen, {
                promptId: p.promptId,
                origin: p.origin,
                username: p.username,
                isUpdate: p.isUpdate,
            });
        }
    });
    password_1.passwordEvents.on('prompt-resolved', (promptId) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            ctx.chrome.webContents.send(ipc_channels_1.IPC.password.promptResolved, { promptId });
        }
    });
}
