"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerBookmarksIpc = registerBookmarksIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const bookmarks_1 = require("../storage/bookmarks");
const window_service_1 = require("../windows/window-service");
const trust_1 = require("./trust");
function registerBookmarksIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.bookmarks.list, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { folders: [], bookmarks: [] };
        return (0, bookmarks_1.listBookmarks)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.bookmarks.add, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, bookmarks_1.addBookmark)(args);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.bookmarks.remove, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        (0, bookmarks_1.removeBookmarkById)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.bookmarks.rename, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        (0, bookmarks_1.renameBookmark)(args.id, args.title);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.bookmarks.update, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        (0, bookmarks_1.updateBookmark)(args.id, { title: args.title, url: args.url });
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.bookmarks.move, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        (0, bookmarks_1.moveBookmark)(args.id, args.folderId, args.position);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.bookmarks.isBookmarked, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return false;
        return (0, bookmarks_1.isBookmarked)(args.url);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.bookmarks.folderCreate, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, bookmarks_1.createFolder)(args);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.bookmarks.folderRename, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        (0, bookmarks_1.renameFolder)(args.id, args.name);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.bookmarks.folderRemove, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        (0, bookmarks_1.removeFolder)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.bookmarks.exportHtml, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return '';
        return (0, bookmarks_1.exportBookmarksAsHtml)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.bookmarks.importHtml, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            throw new Error('untrusted');
        return (0, bookmarks_1.importBookmarksFromHtml)(args.html);
    });
    bookmarks_1.bookmarkEvents.on('changed', () => {
        const tree = (0, bookmarks_1.listBookmarks)();
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            ctx.chrome.webContents.send(ipc_channels_1.IPC.bookmarks.changed, tree);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.bookmarks.changed, tree);
    });
}
