"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTorrentIpc = registerTorrentIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const torrent_1 = require("../features/torrent");
const trust_1 = require("./trust");
function registerTorrentIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.torrent.add, (e, { uri }) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        return (0, torrent_1.addTorrent)(uri);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.torrent.pause, (e, { id }) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        return (0, torrent_1.pauseTorrent)(id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.torrent.resume, (e, { id }) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        return (0, torrent_1.resumeTorrent)(id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.torrent.remove, (e, { id, deleteFiles }) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        return (0, torrent_1.removeTorrent)(id, !!deleteFiles);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.torrent.setFiles, (e, { id, indices }) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        return (0, torrent_1.setTorrentFiles)(id, indices);
    });
}
