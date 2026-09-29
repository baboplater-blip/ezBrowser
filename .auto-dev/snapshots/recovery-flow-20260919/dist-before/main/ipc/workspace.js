"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerWorkspaceIpc = registerWorkspaceIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const workspace_1 = require("../features/workspace");
const window_service_1 = require("../windows/window-service");
const trust_1 = require("./trust");
function registerWorkspaceIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.workspace.list, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, workspace_1.listWorkspaces)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.workspace.state, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { workspaces: [], activeId: '' };
        return (0, workspace_1.getState)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.workspace.activate, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        await (0, workspace_1.setActiveWorkspace)(args.id);
        return (0, workspace_1.getActiveWorkspaceId)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.workspace.create, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, workspace_1.createWorkspace)(args);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.workspace.update, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, workspace_1.updateWorkspace)(args.id, args.patch);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.workspace.remove, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, workspace_1.removeWorkspace)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.workspace.reorder, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        await (0, workspace_1.reorderWorkspaces)(args.orderedIds);
    });
    workspace_1.workspaceEvents.on('changed', () => {
        const state = (0, workspace_1.getState)();
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            // 2026-09-15 검증 중 실측: 창(특히 시크릿 창)을 닫은 직후 워크스페이스를 전환하면
            // ctx.chrome.webContents 가 undefined 가 되어(단순 isDestroyed() 가드로도 못 막음 —
            // extensions.ts 의 같은 가드도 "Cannot read properties of undefined (reading 'isDestroyed')"
            // 로 동일하게 죽는 것을 확인) ipcMain.handle('workspace:activate', ...) 자체가 reject 되고
            // 렌더러의 workspace.activate() 호출이 통째로 실패했다. downloads/index.ts 의 setProgressBar
            // 가드와 같은 방식(try/catch)으로 — 파괴된 창은 조용히 건너뛴다.
            try {
                ctx.chrome.webContents.send(ipc_channels_1.IPC.workspace.changed, state);
            }
            catch { /* 파괴된 창 — 무시 */ }
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.workspace.changed, state);
    });
}
