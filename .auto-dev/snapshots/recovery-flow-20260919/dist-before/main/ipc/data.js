"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDataIpc = registerDataIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const data_sovereignty_1 = require("../features/data-sovereignty");
const trust_1 = require("./trust");
function registerDataIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.data.export, async (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, data_sovereignty_1.exportAllData)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.data.import, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, data_sovereignty_1.importAllData)(args.bundle);
    });
}
