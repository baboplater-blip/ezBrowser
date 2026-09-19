"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTokensIpc = registerTokensIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const design_tokens_1 = require("../features/design-tokens");
const window_service_1 = require("../windows/window-service");
const trust_1 = require("./trust");
function registerTokensIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tokens.get, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return {
            editable: (0, design_tokens_1.listEditableTokens)(),
            overrides: (0, design_tokens_1.getOverrides)(),
            cssVars: (0, design_tokens_1.getOverridesAsCssVars)(),
            defaults: (0, design_tokens_1.defaultsAsCssVars)(),
        };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tokens.set, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, design_tokens_1.setOverride)(args.key, args.value);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.tokens.reset, async (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        await (0, design_tokens_1.resetTokens)();
    });
    design_tokens_1.tokenEvents.on('changed', () => {
        const payload = { overrides: (0, design_tokens_1.getOverrides)(), cssVars: (0, design_tokens_1.getOverridesAsCssVars)() };
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            ctx.chrome.webContents.send(ipc_channels_1.IPC.tokens.changed, payload);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.tokens.changed, payload);
    });
}
