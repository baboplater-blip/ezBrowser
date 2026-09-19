"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initQrcode = initQrcode;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../../shared/ipc-channels");
// lazy load — 첫 generate 호출 시점까지 require 지연 (콜드 스타트 단축)
let qrLib = null;
function getQRCode() {
    if (qrLib)
        return qrLib;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    qrLib = require('qrcode');
    return qrLib;
}
function initQrcode() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.qrcode.generate, async (_e, args) => {
        const text = (args.text ?? '').trim();
        if (!text)
            return null;
        const size = Math.max(128, Math.min(1024, args.size ?? 256));
        try {
            return await getQRCode().toDataURL(text, {
                width: size, margin: 1,
                color: { dark: '#1a1a1a', light: '#ffffff' },
            });
        }
        catch (err) {
            console.warn('[qrcode] generate failed', err);
            return null;
        }
    });
}
