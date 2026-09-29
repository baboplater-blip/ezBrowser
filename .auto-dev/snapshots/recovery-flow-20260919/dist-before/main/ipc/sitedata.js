"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSiteDataIpc = registerSiteDataIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const sitedata_1 = require("../features/sitedata");
const trust_1 = require("./trust");
function originOf(url) {
    try {
        const u = new URL(url);
        return (u.protocol === 'http:' || u.protocol === 'https:') ? u.origin : null;
    }
    catch {
        return null;
    }
}
function registerSiteDataIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.sitedata.summary, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { cookies: 0, hasData: false };
        const origin = originOf(args.origin);
        if (!origin)
            return { cookies: 0, hasData: false };
        return (0, sitedata_1.getSiteDataSummary)(origin);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.sitedata.clear, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return false;
        const origin = originOf(args.origin);
        if (!origin)
            return false;
        await (0, sitedata_1.clearSiteData)(origin);
        return true;
    });
}
