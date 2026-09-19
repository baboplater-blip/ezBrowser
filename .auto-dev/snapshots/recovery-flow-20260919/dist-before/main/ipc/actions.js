"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerActionsIpc = registerActionsIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const registry_1 = require("../actions/registry");
const keymap_service_1 = require("../keymap/keymap-service");
const trust_1 = require("./trust");
function registerActionsIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.actions.list, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        const actions = (0, registry_1.listActions)();
        return actions.map((a) => ({ ...a, key: (0, keymap_service_1.findKeyFor)(a.id) }));
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.actions.run, async (e, { id, ctx }) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, registry_1.runAction)(id, ctx);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.keymap.get, async (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { keymap: { version: 1, bindings: [] }, conflicts: [] };
        await (0, keymap_service_1.loadKeymap)();
        return { keymap: (0, keymap_service_1.getKeymap)(), conflicts: (0, keymap_service_1.findConflicts)() };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.keymap.set, async (e, { keymap }) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        await (0, keymap_service_1.saveKeymap)(keymap);
        return { keymap: (0, keymap_service_1.getKeymap)(), conflicts: (0, keymap_service_1.findConflicts)() };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.keymap.reset, async (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        await (0, keymap_service_1.resetKeymap)();
        return { keymap: (0, keymap_service_1.getKeymap)(), conflicts: (0, keymap_service_1.findConflicts)() };
    });
}
