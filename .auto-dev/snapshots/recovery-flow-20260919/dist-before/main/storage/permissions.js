"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.permissionEvents = void 0;
exports.originOf = originOf;
exports.getPermissionDecision = getPermissionDecision;
exports.listPermissions = listPermissions;
exports.setPermission = setPermission;
exports.clearOrigin = clearOrigin;
exports.clearAllPermissions = clearAllPermissions;
const safe_store_1 = require("./safe-store");
const node_events_1 = require("node:events");
exports.permissionEvents = new node_events_1.EventEmitter();
const store = (0, safe_store_1.createStore)({ name: 'permissions', defaults: { origins: {} } });
const cache = new Map();
let loaded = false;
function ensureLoaded() {
    if (loaded)
        return;
    loaded = true;
    const origins = store.get('origins');
    if (origins && typeof origins === 'object') {
        for (const [k, v] of Object.entries(origins))
            if (v && typeof v === 'object')
                cache.set(k, v);
    }
}
function persist() {
    store.set('origins', Object.fromEntries(cache));
    exports.permissionEvents.emit('changed');
}
function originOf(url) {
    try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
            return null;
        return u.origin;
    }
    catch {
        return null;
    }
}
/** session-bootstrap 핸들러용: 명시적 결정만 반환, 없으면 null(기본 동작). */
function getPermissionDecision(url, permission) {
    const origin = originOf(url);
    if (!origin)
        return null;
    ensureLoaded();
    return cache.get(origin)?.[permission] ?? null;
}
function listPermissions() {
    ensureLoaded();
    return Array.from(cache.entries())
        .map(([origin, permissions]) => ({ origin, permissions: { ...permissions } }))
        .sort((a, b) => a.origin.localeCompare(b.origin));
}
/** decision 'default' 는 오버라이드 제거(기본 동작 복귀). */
function setPermission(origin, permission, decision) {
    if (!originOf(origin))
        return;
    ensureLoaded();
    const perms = { ...(cache.get(origin) ?? {}) };
    if (decision === 'default')
        delete perms[permission];
    else
        perms[permission] = decision;
    if (Object.keys(perms).length === 0)
        cache.delete(origin);
    else
        cache.set(origin, perms);
    persist();
}
function clearOrigin(origin) {
    ensureLoaded();
    if (cache.delete(origin))
        persist();
}
function clearAllPermissions() {
    ensureLoaded();
    if (cache.size === 0)
        return;
    cache.clear();
    persist();
}
