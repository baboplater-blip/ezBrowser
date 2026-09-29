"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSettingsIpc = registerSettingsIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const settings_1 = require("../storage/settings");
const window_service_1 = require("../windows/window-service");
const trust_1 = require("./trust");
// 외피 측에서 ui.* 토글을 위해 chrome WebContentsView 도 trusted 로 인정.
// chrome.ts preload 도 file:// 또는 dev http://localhost 라 isTrustedSender 가 자동 통과.
function registerSettingsIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.settings.all, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return {};
        return (0, settings_1.getSettings)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.settings.get, (e, { key }) => {
        // 외부(http/https) 콘텐츠 페이지는 비민감 콘텐츠 토글(freedom)만 읽을 수 있다.
        // external-features.ts 가 마우스 제스처·빠른 검색·hover 번역 플래그를 로드하는 데 필요.
        // (그 외 임의 키 읽기는 정보 유출 방지를 위해 계속 차단)
        if (!(0, trust_1.isTrustedSender)(e)) {
            return key === 'freedom' ? (0, settings_1.getSettings)().freedom : undefined;
        }
        const parts = key.split('.');
        let value = (0, settings_1.getSettings)();
        for (const p of parts) {
            if (value && typeof value === 'object' && p in value) {
                value = value[p];
            }
            else {
                value = undefined;
                break;
            }
        }
        return value;
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.settings.set, (e, { key, value }) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        (0, settings_1.setNestedSetting)(key, value);
    });
    (0, settings_1.onSettingsChange)((s) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            ctx.chrome.webContents.send(ipc_channels_1.IPC.settings.changed, s);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.settings.changed, s);
    });
}
