"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initUserChrome = initUserChrome;
exports.getUserChromeState = getUserChromeState;
exports.reloadUserChrome = reloadUserChrome;
exports.openUserChromeInEditor = openUserChromeInEditor;
exports.updateUserChrome = updateUserChrome;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const ipc_channels_1 = require("../../../shared/ipc-channels");
const settings_1 = require("../../storage/settings");
const window_service_1 = require("../../windows/window-service");
const DEFAULT_CSS = `/* userChrome.css — 외피 CSS 주입
 * 안전 셀렉터:
 *   .tabbar, .tab, .tab.active, .tab.pinned
 *   .toolbar, .omnibox, .omnibox-suggestions
 *   .sidepanel.left, .sidepanel.right
 *   .command-palette
 * 안전 변수:
 *   --color-bg-base / --color-bg-elevated / --color-bg-sunken
 *   --color-text-primary / --color-accent-primary
 *   --tab-active-bg / --tab-inactive-bg
 *   --density-tabbar-h / --density-toolbar-h
 *
 * 예시 — 활성 탭을 두껍게 강조:
 * .tab.active { font-weight: 700; border-bottom: 2px solid var(--color-accent-primary); }
 */
`;
const DEFAULT_JS = `// userChrome.js — 외피 JS 주입 (opt-in)
// 사용 가능한 API: window.browserAPI
// 예시:
//   browserAPI.actions.run('action.tab.new')
`;
let cssWatcher = null;
let jsWatcher = null;
let cssCache = '';
let jsCache = '';
let lastError;
function cssPath() { return node_path_1.default.join(electron_1.app.getPath('userData'), 'userChrome.css'); }
function jsPath() { return node_path_1.default.join(electron_1.app.getPath('userData'), 'userChrome.js'); }
async function ensureFile(p, fallback) {
    await (0, promises_1.mkdir)(node_path_1.default.dirname(p), { recursive: true });
    if (!(0, node_fs_1.existsSync)(p))
        await (0, promises_1.writeFile)(p, fallback, 'utf8');
}
async function readSafe(p) {
    try {
        return await (0, promises_1.readFile)(p, 'utf8');
    }
    catch {
        return '';
    }
}
let debounceTimer = null;
function debouncedBroadcast() {
    if (debounceTimer)
        clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
        try {
            cssCache = await readSafe(cssPath());
            jsCache = (0, settings_1.getSetting)('freedom').userChromeJs ? await readSafe(jsPath()) : '';
            lastError = undefined;
        }
        catch (err) {
            lastError = err.message;
        }
        broadcast();
    }, 200);
}
function broadcast() {
    for (const ctx of (0, window_service_1.getAllWindows)()) {
        ctx.chrome.webContents.send(ipc_channels_1.IPC.userchrome.cssChanged, {
            cssEnabled: (0, settings_1.getSetting)('freedom').userChromeCss,
            jsEnabled: (0, settings_1.getSetting)('freedom').userChromeJs,
            css: cssCache,
            js: jsCache,
            lastError,
        });
    }
}
async function initUserChrome() {
    await ensureFile(cssPath(), DEFAULT_CSS);
    await ensureFile(jsPath(), DEFAULT_JS);
    cssCache = await readSafe(cssPath());
    jsCache = (0, settings_1.getSetting)('freedom').userChromeJs ? await readSafe(jsPath()) : '';
    try {
        cssWatcher?.close();
        cssWatcher = (0, node_fs_1.watch)(cssPath(), () => debouncedBroadcast());
        jsWatcher?.close();
        jsWatcher = (0, node_fs_1.watch)(jsPath(), () => debouncedBroadcast());
    }
    catch (err) {
        console.warn('[userchrome] watch failed', err);
    }
}
async function getUserChromeState() {
    return {
        cssEnabled: (0, settings_1.getSetting)('freedom').userChromeCss,
        cssPath: cssPath(),
        cssContent: cssCache,
        jsEnabled: (0, settings_1.getSetting)('freedom').userChromeJs,
        jsPath: jsPath(),
        jsContent: jsCache,
        lastError,
    };
}
async function reloadUserChrome() {
    cssCache = await readSafe(cssPath());
    jsCache = (0, settings_1.getSetting)('freedom').userChromeJs ? await readSafe(jsPath()) : '';
    broadcast();
}
async function openUserChromeInEditor(kind) {
    const p = kind === 'css' ? cssPath() : jsPath();
    await ensureFile(p, kind === 'css' ? DEFAULT_CSS : DEFAULT_JS);
    await electron_1.shell.openPath(p);
}
async function updateUserChrome(kind, content) {
    const p = kind === 'css' ? cssPath() : jsPath();
    await ensureFile(p, '');
    await (0, promises_1.writeFile)(p, content, 'utf8');
    await reloadUserChrome();
}
