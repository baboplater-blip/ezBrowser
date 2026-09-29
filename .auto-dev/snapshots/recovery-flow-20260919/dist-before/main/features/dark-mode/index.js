"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackWebContents = trackWebContents;
exports.bindNativeTheme = bindNativeTheme;
exports.setForcePageDark = setForcePageDark;
exports.isForcePageDark = isForcePageDark;
exports.isFollowSystemDark = isFollowSystemDark;
exports.setFollowSystemDark = setFollowSystemDark;
exports.setSiteDark = setSiteDark;
exports.getSiteDark = getSiteDark;
exports.toggleForcePageDark = toggleForcePageDark;
exports.toggleSiteDark = toggleSiteDark;
const electron_1 = require("electron");
const settings_1 = require("../../storage/settings");
const DARK_CSS = `
:root, html { background-color: #1a1a1a !important; }
html { filter: invert(0.92) hue-rotate(180deg) contrast(0.92); }
img, video, picture, iframe, svg, [style*="background-image"],
canvas, embed, object {
  filter: invert(1) hue-rotate(180deg);
}
`.trim();
const installedKeys = new WeakMap();
const tracked = new Set();
let nativeThemeBound = false;
function originOf(url) {
    try {
        const u = new URL(url);
        if (u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:')
            return null;
        return u.origin;
    }
    catch {
        return null;
    }
}
function shouldApply(url) {
    const appearance = (0, settings_1.getSetting)('appearance');
    const overrides = appearance.pageDarkSiteOverrides ?? {};
    const origin = originOf(url);
    if (origin && Object.prototype.hasOwnProperty.call(overrides, origin)) {
        return overrides[origin] === true;
    }
    if (appearance.pageDarkFollowSystem) {
        return electron_1.nativeTheme.shouldUseDarkColors === true;
    }
    return appearance.forcePageDark === true;
}
async function applyTo(wc) {
    if (wc.isDestroyed())
        return;
    if (installedKeys.has(wc))
        return;
    try {
        const key = await wc.insertCSS(DARK_CSS, { cssOrigin: 'user' });
        installedKeys.set(wc, key);
    }
    catch (err) {
        console.warn('[dark-mode] insertCSS failed', err);
    }
}
async function removeFrom(wc) {
    if (wc.isDestroyed())
        return;
    const key = installedKeys.get(wc);
    if (!key)
        return;
    try {
        await wc.removeInsertedCSS(key);
        installedKeys.delete(wc);
    }
    catch (err) {
        console.warn('[dark-mode] removeInsertedCSS failed', err);
    }
}
async function reconcile(wc) {
    if (wc.isDestroyed())
        return;
    const url = wc.getURL() ?? '';
    const want = shouldApply(url);
    const has = installedKeys.has(wc);
    if (want && !has)
        await applyTo(wc);
    else if (!want && has)
        await removeFrom(wc);
}
function trackWebContents(wc) {
    if (tracked.has(wc))
        return;
    tracked.add(wc);
    const onChange = () => {
        installedKeys.delete(wc); // navigate 후 키 무효, 재주입 위해 키 폐기
        void reconcile(wc);
    };
    wc.on('did-finish-load', onChange);
    wc.on('did-navigate', onChange);
    wc.on('did-navigate-in-page', onChange);
    wc.once('destroyed', () => {
        tracked.delete(wc);
        installedKeys.delete(wc);
    });
    void reconcile(wc);
}
async function reapplyAll() {
    for (const wc of tracked)
        await reconcile(wc);
}
function bindNativeTheme() {
    if (nativeThemeBound)
        return;
    nativeThemeBound = true;
    electron_1.nativeTheme.on('updated', () => {
        const appearance = (0, settings_1.getSetting)('appearance');
        if (appearance.pageDarkFollowSystem)
            void reapplyAll();
    });
}
async function setForcePageDark(enabled) {
    (0, settings_1.setNestedSetting)('appearance.forcePageDark', enabled);
    await reapplyAll();
}
function isForcePageDark() {
    return (0, settings_1.getSetting)('appearance').forcePageDark === true;
}
function isFollowSystemDark() {
    return (0, settings_1.getSetting)('appearance').pageDarkFollowSystem === true;
}
async function setFollowSystemDark(enabled) {
    (0, settings_1.setNestedSetting)('appearance.pageDarkFollowSystem', enabled);
    await reapplyAll();
}
async function setSiteDark(origin, enabled) {
    const appearance = (0, settings_1.getSetting)('appearance');
    const overrides = { ...(appearance.pageDarkSiteOverrides ?? {}) };
    if (enabled === null)
        delete overrides[origin];
    else
        overrides[origin] = enabled;
    (0, settings_1.setNestedSetting)('appearance.pageDarkSiteOverrides', overrides);
    await reapplyAll();
}
function getSiteDark(origin) {
    const overrides = (0, settings_1.getSetting)('appearance').pageDarkSiteOverrides ?? {};
    if (!Object.prototype.hasOwnProperty.call(overrides, origin))
        return 'inherit';
    return overrides[origin] ? 'on' : 'off';
}
async function toggleForcePageDark() {
    const next = !isForcePageDark();
    await setForcePageDark(next);
    return next;
}
async function toggleSiteDark(url) {
    const origin = originOf(url);
    if (!origin)
        return { origin: null, state: 'inherit' };
    const cur = getSiteDark(origin);
    // cycle: inherit → on → off → inherit
    const next = cur === 'inherit' ? 'on' : cur === 'on' ? 'off' : 'inherit';
    await setSiteDark(origin, next === 'inherit' ? null : next === 'on');
    return { origin, state: next };
}
