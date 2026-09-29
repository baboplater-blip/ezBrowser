"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPolicyIpc = registerPolicyIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const policy_1 = require("../features/policy");
const window_service_1 = require("../windows/window-service");
const trust_1 = require("./trust");
function registerPolicyIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.policy.list, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, policy_1.listPolicies)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.policy.get, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return (0, policy_1.getPolicy)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.policy.save, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, policy_1.savePolicy)(args);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.policy.remove, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        await (0, policy_1.removePolicy)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.policy.setEnabled, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        await (0, policy_1.setPolicyEnabled)(args.id, args.enabled);
    });
    policy_1.policyEvents.on('changed', () => {
        const summaries = (0, policy_1.listPolicies)();
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            ctx.chrome.webContents.send(ipc_channels_1.IPC.policy.changed, summaries);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.policy.changed, summaries);
    });
}
