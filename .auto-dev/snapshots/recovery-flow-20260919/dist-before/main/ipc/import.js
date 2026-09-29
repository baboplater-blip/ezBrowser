"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerImportIpc = registerImportIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const import_1 = require("../features/import");
const settings_1 = require("../storage/settings");
const trust_1 = require("./trust");
function registerImportIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.imports.sources, async (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, import_1.detectImportSources)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.imports.run, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        if (!args?.sourceId)
            throw new Error('sourceId required');
        return (0, import_1.runImport)(args.sourceId, {
            bookmarks: args.bookmarks !== false,
            history: args.history !== false,
        });
    });
    // 기본 브라우저 설정 시도 (best-effort — OS 가 사용자 확인을 요구할 수 있음)
    electron_1.ipcMain.handle(ipc_channels_1.IPC.onboarding.setDefaultBrowser, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        let http = false;
        let https = false;
        try {
            http = electron_1.app.setAsDefaultProtocolClient('http');
        }
        catch { /* noop */ }
        try {
            https = electron_1.app.setAsDefaultProtocolClient('https');
        }
        catch { /* noop */ }
        return { ok: http || https, http, https };
    });
    // 온보딩 완료 표시
    electron_1.ipcMain.handle(ipc_channels_1.IPC.onboarding.complete, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        (0, settings_1.setNestedSetting)('setup.completed', true);
        (0, settings_1.setNestedSetting)('setup.completedAt', Date.now());
        (0, settings_1.setNestedSetting)('setup.version', electron_1.app.getVersion());
        return { ok: true };
    });
}
