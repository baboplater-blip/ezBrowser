"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerWidgetsIpc = registerWidgetsIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const widgets_1 = require("../features/widgets");
const trust_1 = require("./trust");
// 새 탭 위젯 사용자 데이터 키 화이트리스트 — 임의 키 쓰기 방지.
const DATA_KEYS = new Set(['notes', 'todos', 'shortcuts', 'notes-left', 'notes-right']);
function registerWidgetsIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.widgets.weather, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return (0, widgets_1.getWeather)(!!args?.force);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.widgets.news, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return (0, widgets_1.getNews)(!!args?.force);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.widgets.fx, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return (0, widgets_1.getFx)(!!args?.force);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.widgets.dataGet, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        if (!DATA_KEYS.has(args?.key))
            return null;
        return (0, widgets_1.getWidgetData)(args.key);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.widgets.dataSet, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (!DATA_KEYS.has(args?.key))
            return;
        (0, widgets_1.setWidgetData)(args.key, args.value);
    });
}
