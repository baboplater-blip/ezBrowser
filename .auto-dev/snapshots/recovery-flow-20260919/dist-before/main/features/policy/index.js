"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.policyEvents = void 0;
exports.permissionDecisionFor = permissionDecisionFor;
exports.listPolicies = listPolicies;
exports.getPolicy = getPolicy;
exports.savePolicy = savePolicy;
exports.removePolicy = removePolicy;
exports.setPolicyEnabled = setPolicyEnabled;
exports.applyToResponseHeaders = applyToResponseHeaders;
exports.installPolicyOn = installPolicyOn;
exports.initPolicies = initPolicies;
exports.trackWebContents = trackWebContents;
const electron_1 = require("electron");
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const client_hints_1 = require("../client-hints");
const dnr_1 = require("../extensions/dnr");
const policies = new Map();
let loaded = false;
let counter = 0;
exports.policyEvents = new node_events_1.EventEmitter();
function dir() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'policies');
}
function nextId() {
    counter += 1;
    return `pol-${Date.now().toString(36)}-${counter}`;
}
// ===== Chrome 정식 match pattern → 정규식 =====
// https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
// 형식: <scheme>://<host>/<path>
//  - scheme: http | https | * | file
//  - host: '*' | '*.도메인' | '도메인'
//  - path: '/' 로 시작, '*' 와일드카드 허용
//  - 특수: '<all_urls>' = 모든 http/https/file/ftp
function escapeRegex(s) {
    return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
const compileCache = new Map();
function compileMatchPattern(pattern) {
    const cached = compileCache.get(pattern);
    if (cached !== undefined)
        return cached;
    const result = compileMatchPatternInner(pattern);
    compileCache.set(pattern, result);
    return result;
}
function compileMatchPatternInner(pattern) {
    if (pattern === '<all_urls>') {
        return {
            schemeRe: /^(http|https|file|ftp)$/i,
            hostRe: /^.*$/,
            pathRe: /^\/.*$/,
        };
    }
    // 스킴 분리
    const schemeMatch = /^([a-z*]+):\/\/(.*)$/i.exec(pattern);
    if (!schemeMatch || !schemeMatch[1] || !schemeMatch[2]) {
        // legacy 와일드카드 패턴 (예: '*example.com*') — 옛 단순 와일드카드로 fallback
        return compileLegacyPattern(pattern);
    }
    const scheme = schemeMatch[1].toLowerCase();
    const rest = schemeMatch[2];
    const schemeRe = scheme === '*'
        ? /^(http|https)$/i
        : new RegExp('^' + escapeRegex(scheme) + '$', 'i');
    // host 와 path 분리: 첫 '/' 가 분리점. host 에 path 없으면 path = '/*'
    let host;
    let pathPart;
    const slashIdx = rest.indexOf('/');
    if (slashIdx < 0) {
        host = rest;
        pathPart = '/*';
    }
    else {
        host = rest.slice(0, slashIdx);
        pathPart = rest.slice(slashIdx);
    }
    // host: '*' | '*.domain' | 'domain'
    let hostRe;
    if (host === '*') {
        hostRe = /^.*$/;
    }
    else if (host.startsWith('*.')) {
        const suffix = host.slice(2);
        hostRe = new RegExp('^(.*\\.)?' + escapeRegex(suffix) + '$', 'i');
    }
    else if (host.includes('*')) {
        // 비표준 위치의 '*' — 단순 와일드카드 허용 (관대한 처리)
        hostRe = new RegExp('^' + host.split('').map((c) => c === '*' ? '.*' : escapeRegex(c)).join('') + '$', 'i');
    }
    else {
        hostRe = new RegExp('^' + escapeRegex(host) + '$', 'i');
    }
    // path: '*' 를 '.*' 로
    const pathRe = new RegExp('^' + pathPart.split('').map((c) => c === '*' ? '.*' : escapeRegex(c)).join('') + '$');
    return { schemeRe, hostRe, pathRe };
}
function compileLegacyPattern(pattern) {
    // 'foo*bar' 같은 옛 단순 와일드카드 — URL 전체에 대해 .* 만 의미
    const re = new RegExp('^' + pattern.split('').map((c) => c === '*' ? '.*' : c === '?' ? '\\?' : escapeRegex(c)).join('') + '$', 'i');
    // schemeRe/hostRe/pathRe 를 우회 — 전체 URL 매칭 함수에서 별도 분기
    return {
        schemeRe: re, // 마커로 전체-URL 정규식 사용
        hostRe: /.*/,
        pathRe: /.*/,
    };
}
function urlMatchesPattern(url, p, raw) {
    // legacy 와일드카드 패턴 처리: '<scheme>://' 가 없으면 raw 전체에 매칭
    if (!/^[a-z*]+:\/\//i.test(raw) && raw !== '<all_urls>') {
        return p.schemeRe.test(url);
    }
    try {
        const u = new URL(url);
        const scheme = u.protocol.replace(/:$/, '');
        if (!p.schemeRe.test(scheme))
            return false;
        if (!p.hostRe.test(u.hostname))
            return false;
        const fullPath = u.pathname + u.search + u.hash;
        if (!p.pathRe.test(fullPath))
            return false;
        return true;
    }
    catch {
        return false;
    }
}
function urlMatches(url, patterns) {
    for (const p of patterns) {
        const compiled = compileMatchPattern(p);
        if (!compiled)
            continue;
        if (urlMatchesPattern(url, compiled, p))
            return true;
    }
    return false;
}
function activeRulesFor(url) {
    const out = [];
    for (const r of policies.values()) {
        if (!r.enabled)
            continue;
        if (r.match.length === 0)
            continue;
        if (!urlMatches(url, r.match))
            continue;
        out.push(r);
    }
    return out;
}
// ===== 저장소 =====
async function ensureDir() {
    await (0, promises_1.mkdir)(dir(), { recursive: true });
}
const VALID_PERMISSIONS = ['media', 'geolocation', 'notifications', 'clipboard-read', 'fullscreen', 'pointerLock'];
const VALID_DECISIONS = new Set(['allow', 'deny', 'default']);
function sanitizePermissions(input) {
    if (!input || typeof input !== 'object')
        return undefined;
    const out = {};
    for (const [k, v] of Object.entries(input)) {
        if (!VALID_PERMISSIONS.includes(k))
            continue;
        if (typeof v !== 'string' || !VALID_DECISIONS.has(v))
            continue;
        if (v === 'default')
            continue;
        out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
function normalizeRule(input, fallbackId, now = Date.now()) {
    return {
        id: input.id ?? fallbackId ?? nextId(),
        name: (input.name ?? '').trim() || '이름 없는 룰',
        enabled: input.enabled !== false,
        match: Array.isArray(input.match) ? input.match.filter((x) => typeof x === 'string' && x.trim()) : [],
        userAgent: (input.userAgent ?? '').trim(),
        reqHeadersSet: sanitizeHeaders(input.reqHeadersSet),
        reqHeadersRemove: sanitizeHeaderNames(input.reqHeadersRemove),
        resHeadersSet: sanitizeHeaders(input.resHeadersSet),
        resHeadersRemove: sanitizeHeaderNames(input.resHeadersRemove),
        stripCsp: !!input.stripCsp,
        blockCookies: !!input.blockCookies,
        blockJs: !!input.blockJs,
        blockImages: !!input.blockImages,
        customJs: typeof input.customJs === 'string' ? input.customJs : '',
        permissions: sanitizePermissions(input.permissions),
        createdAt: input.createdAt ?? now,
        updatedAt: now,
    };
}
/**
 * URL 에 매칭되는 룰들의 permission 결정.
 * - 'deny' 우선 (보안: 한 룰이라도 거부하면 거부)
 * - 그 외 'allow' 가 하나라도 있으면 허용
 * - 매칭 룰이 모두 미설정이면 null → 호출자가 기본 정책 적용
 */
function permissionDecisionFor(url, permission) {
    const rules = activeRulesFor(url);
    if (rules.length === 0)
        return null;
    let anyAllow = false;
    for (const r of rules) {
        const dec = r.permissions?.[permission];
        if (dec === 'deny')
            return 'deny';
        if (dec === 'allow')
            anyAllow = true;
    }
    return anyAllow ? 'allow' : null;
}
function sanitizeHeaders(arr) {
    if (!Array.isArray(arr))
        return [];
    return arr
        .map((h) => ({ name: String(h?.name ?? '').trim(), value: String(h?.value ?? '') }))
        .filter((h) => h.name.length > 0);
}
function sanitizeHeaderNames(arr) {
    if (!Array.isArray(arr))
        return [];
    return arr.map((x) => String(x).trim()).filter((x) => x.length > 0);
}
async function loadAll() {
    if (loaded)
        return;
    await ensureDir();
    try {
        const entries = await (0, promises_1.readdir)(dir());
        for (const f of entries) {
            if (!f.endsWith('.json'))
                continue;
            try {
                const raw = await (0, promises_1.readFile)(node_path_1.default.join(dir(), f), 'utf-8');
                const obj = JSON.parse(raw);
                const r = normalizeRule(obj, obj.id, obj.updatedAt ?? Date.now());
                policies.set(r.id, r);
            }
            catch (err) {
                console.warn('[policy] load failed', f, err);
            }
        }
    }
    catch (err) {
        console.warn('[policy] readdir failed', err);
    }
    loaded = true;
}
// id 는 그대로 파일 이름이 된다. `../..` 같은 값이 오면 프로필 **밖**에 쓰거나 지운다.
// 파일을 만지는 두 함수에서 막는다 — 어느 호출자를 거쳐도 새지 않게.
// (2026-09-07 임무 19: 데이터 가져오기에는 같은 방어가 있었는데 여기엔 없었다.)
function safeId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(id) && !id.includes('..') ? id : null;
}
async function persist(r) {
    const safe = safeId(r.id);
    if (!safe)
        throw new Error('저장 id 가 올바르지 않습니다');
    await ensureDir();
    const p = node_path_1.default.join(dir(), `${safe}.json`);
    await (0, promises_1.writeFile)(p, JSON.stringify(r, null, 2), 'utf-8');
}
async function removeFile(id) {
    const safe = safeId(id);
    if (!safe)
        return;
    const p = node_path_1.default.join(dir(), `${safe}.json`);
    if ((0, node_fs_1.existsSync)(p))
        await (0, promises_1.unlink)(p);
}
// ===== CRUD =====
function summarize(r) {
    return {
        id: r.id, name: r.name, enabled: r.enabled, match: r.match, updatedAt: r.updatedAt,
    };
}
function listPolicies() {
    return Array.from(policies.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(summarize);
}
function getPolicy(id) {
    return policies.get(id) ?? null;
}
async function savePolicy(input) {
    // 객체가 아닌 입력(null·숫자·문자열·배열)은 거부한다. 빈 객체는 "새 룰 만들기" 흐름이라 허용.
    // (2026-09-07 임무 19 실측: 검증이 없어 `42`·`'string'`·`[]` 가 정책으로 저장됐다.)
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('정책 형식이 올바르지 않습니다 — 객체여야 합니다');
    }
    const existing = input.id ? policies.get(input.id) : null;
    const merged = existing
        ? { ...existing, ...input, createdAt: existing.createdAt, updatedAt: Date.now() }
        : { ...input, createdAt: Date.now(), updatedAt: Date.now() };
    const r = normalizeRule(merged, existing?.id ?? input.id, Date.now());
    // 파일 이름이 될 수 없는 id 면 거부 대신 새로 발급한다 — 사용자에겐 "새 룰" 과 같은 결과.
    if (!safeId(r.id))
        r.id = nextId();
    policies.set(r.id, r);
    await persist(r);
    exports.policyEvents.emit('changed');
    return r;
}
async function removePolicy(id) {
    policies.delete(id);
    await removeFile(id);
    exports.policyEvents.emit('changed');
}
async function setPolicyEnabled(id, enabled) {
    const r = policies.get(id);
    if (!r)
        return;
    r.enabled = enabled;
    r.updatedAt = Date.now();
    await persist(r);
    exports.policyEvents.emit('changed');
}
// ===== webRequest 후킹 =====
const CSP_HEADER_KEYS = new Set(['content-security-policy', 'content-security-policy-report-only']);
const SET_COOKIE_KEYS = new Set(['set-cookie']);
const REQ_COOKIE_KEYS = new Set(['cookie']);
function lowerKeyEntries(headers) {
    return Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]);
}
function withoutHeaders(headers, blockedLower) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        if (blockedLower.has(k.toLowerCase()))
            continue;
        out[k] = v;
    }
    return out;
}
function setHeader(headers, name, value) {
    // 케이스 일관성을 위해 동일 이름(대소문자 무시) 모두 제거 후 set
    for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === name.toLowerCase())
            delete headers[k];
    }
    headers[name] = value;
}
function applyToRequestHeaders(url, requestHeaders) {
    const rules = activeRulesFor(url);
    if (rules.length === 0)
        return requestHeaders;
    let next = { ...requestHeaders };
    for (const r of rules) {
        if (r.userAgent)
            setHeader(next, 'User-Agent', r.userAgent);
        for (const h of r.reqHeadersSet)
            setHeader(next, h.name, h.value);
        const removed = new Set(r.reqHeadersRemove.map((s) => s.toLowerCase()));
        if (r.blockCookies)
            for (const k of REQ_COOKIE_KEYS)
                removed.add(k);
        if (removed.size > 0)
            next = withoutHeaders(next, removed);
    }
    return next;
}
function applyToResponseHeaders(url, responseHeaders) {
    if (!responseHeaders)
        return responseHeaders;
    const rules = activeRulesFor(url);
    if (rules.length === 0)
        return responseHeaders;
    let next = { ...responseHeaders };
    const cspDirectives = [];
    let dropCsp = false;
    for (const r of rules) {
        for (const h of r.resHeadersSet)
            setHeader(next, h.name, h.value);
        const removed = new Set(r.resHeadersRemove.map((s) => s.toLowerCase()));
        if (r.stripCsp)
            dropCsp = true;
        if (r.blockCookies)
            for (const k of SET_COOKIE_KEYS)
                removed.add(k);
        if (removed.size > 0)
            next = withoutHeaders(next, removed);
        if (r.blockJs)
            cspDirectives.push("script-src 'none'");
        if (r.blockImages)
            cspDirectives.push("img-src 'none'");
    }
    if (dropCsp)
        next = withoutHeaders(next, CSP_HEADER_KEYS);
    if (cspDirectives.length > 0) {
        // 새 CSP 강제 — stripCsp 가 우선 적용된 후라 충돌 없음. (stripCsp 안 켜져 있어도 추가 directive 로 작동)
        const existing = lowerKeyEntries(next)
            .find(([k]) => k === 'content-security-policy');
        const merged = (existing && !dropCsp ? String(existing[1]) + '; ' : '') + cspDirectives.join('; ');
        setHeader(next, 'Content-Security-Policy', merged);
    }
    return next;
}
const installedSessions = new WeakSet();
function installPolicyOn(ses) {
    installOn(ses);
}
function installOn(ses) {
    if (installedSessions.has(ses))
        return;
    installedSessions.add(ses);
    // 세션당 onBeforeSendHeaders 리스너는 하나만 유효하다(마지막 등록만 살아남는다 — 회귀 #5 계열).
    // 그래서 클라이언트 힌트 보강도 별도 등록이 아니라 이 디스패처 안에서 처리한다.
    // 순서: 클라이언트 힌트 먼저 → 사용자 정책 룰이 그 위에 덮어쓸 수 있게(사용자 룰이 항상 최종 결정권).
    ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, cb) => {
        try {
            // 순서: 확장 DNR → 클라이언트 힌트 → 사용자 정책.
            // 사용자가 직접 만든 룰이 마지막이라 항상 최종 결정권을 갖는다.
            const withDnr = (0, dnr_1.dnrRequestHeaders)(details, details.requestHeaders) ?? details.requestHeaders;
            const withHints = (0, client_hints_1.applyClientHints)(details.url, withDnr);
            const next = applyToRequestHeaders(details.url, withHints);
            cb({ cancel: false, requestHeaders: next });
        }
        catch (err) {
            console.warn('[policy] onBeforeSendHeaders error', err);
            cb({ cancel: false, requestHeaders: details.requestHeaders });
        }
    });
    ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, cb) => {
        try {
            const next = applyToResponseHeaders(details.url, details.responseHeaders);
            cb({ cancel: false, responseHeaders: next });
        }
        catch (err) {
            console.warn('[policy] onHeadersReceived error', err);
            cb({ cancel: false, responseHeaders: details.responseHeaders });
        }
    });
}
async function initPolicies() {
    await loadAll();
    // 세션별 install 은 session-bootstrap 의 hook 으로 처리됨 (idempotent)
}
// ===== customJs 주입 (페이지 컨텍스트) =====
function wrapCustomJs(rule) {
    const idLit = JSON.stringify(rule.id);
    const nameLit = JSON.stringify(rule.name);
    return `
;(function() {
  if (window.__bbPolicy && window.__bbPolicy[${idLit}]) return
  if (!window.__bbPolicy) window.__bbPolicy = {}
  window.__bbPolicy[${idLit}] = true
  try {
    (function() { ${rule.customJs} })()
  } catch (err) {
    console.error('[policy:' + ${nameLit} + '] customJs error', err)
  }
})();
`;
}
async function injectCustomJs(wc) {
    if (wc.isDestroyed())
        return;
    const url = wc.getURL();
    if (!/^https?:/i.test(url))
        return;
    const rules = activeRulesFor(url).filter((r) => r.customJs.trim().length > 0);
    for (const r of rules) {
        try {
            await wc.executeJavaScript(wrapCustomJs(r), true);
        }
        catch (err) {
            console.warn(`[policy] inject ${r.name} failed`, err);
        }
    }
}
function trackWebContents(wc) {
    wc.on('dom-ready', () => { void injectCustomJs(wc); });
}
