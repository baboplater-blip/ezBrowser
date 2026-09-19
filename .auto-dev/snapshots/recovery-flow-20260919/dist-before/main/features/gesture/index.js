"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initGesture = initGesture;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../../shared/ipc-channels");
const constants_1 = require("../../../shared/constants");
const tab_service_1 = require("../../tabs/tab-service");
function initGesture() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.gesture.exec, (e, args) => {
        const found = (0, tab_service_1.findTabIdByWebContentsId)(e.sender.id);
        if (!found)
            return;
        const { tabId, windowId } = found;
        switch (args.action) {
            case 'back':
                (0, tab_service_1.tabBack)(tabId);
                break;
            case 'forward':
                (0, tab_service_1.tabForward)(tabId);
                break;
            case 'reload':
                (0, tab_service_1.tabReload)(tabId);
                break;
            case 'tab.new':
                (0, tab_service_1.createTab)({ windowId, url: constants_1.NEW_TAB_URL });
                break;
            case 'tab.close':
                (0, tab_service_1.closeTab)(tabId);
                break;
        }
    });
}
