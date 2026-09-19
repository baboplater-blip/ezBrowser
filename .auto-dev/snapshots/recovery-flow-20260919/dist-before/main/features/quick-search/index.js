"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initQuickSearch = initQuickSearch;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../../shared/ipc-channels");
const tab_service_1 = require("../../tabs/tab-service");
const search_engines_1 = require("../../storage/search-engines");
function initQuickSearch() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.quickSearch.open, (e, args) => {
        const q = (args.query ?? '').trim();
        if (!q)
            return;
        const found = (0, tab_service_1.findTabIdByWebContentsId)(e.sender.id);
        if (!found)
            return;
        const url = (0, search_engines_1.buildSearchUrl)(q);
        (0, tab_service_1.createTab)({ windowId: found.windowId, url });
    });
}
