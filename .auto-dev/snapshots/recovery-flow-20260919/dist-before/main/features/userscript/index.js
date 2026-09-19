"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.userscriptEvents = void 0;
exports.parseUserscript = parseUserscript;
exports.initUserscripts = initUserscripts;
exports.listUserscripts = listUserscripts;
exports.getUserscript = getUserscript;
exports.saveUserscript = saveUserscript;
exports.removeUserscript = removeUserscript;
exports.setUserscriptEnabled = setUserscriptEnabled;
exports.trackWebContents = trackWebContents;
const electron_1 = require("electron");
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const userscripts = new Map();
let loaded = false;
let counter = 0;
exports.userscriptEvents = new node_events_1.EventEmitter();
function dir() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'userscripts');
}
function nextId() {
    counter += 1;
    return `us-${Date.now().toString(36)}-${counter}`;
}
// ===== 메타데이터 파서 =====
const META_BLOCK = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/i;
const META_LINE = /\/\/\s*@([\w-]+)(?:\s+(.*))?/g;
function parseUserscript(source, fallbackName) {
    const m = META_BLOCK.exec(source);
    const meta = {};
    if (m) {
        META_LINE.lastIndex = 0;
        let mm;
        while ((mm = META_LINE.exec(m[1] ?? '')) !== null) {
            const key = (mm[1] ?? '').toLowerCase();
            const value = (mm[2] ?? '').trim();
            if (!meta[key])
                meta[key] = [];
            meta[key].push(value);
        }
    }
    const first = (key) => (meta[key]?.[0] ?? '').trim();
    const all = (key) => (meta[key] ?? []).filter(Boolean);
    const runAtRaw = first('run-at');
    const runAt = runAtRaw === 'document-start' || runAtRaw === 'document-idle' ? runAtRaw : 'document-end';
    return {
        name: first('name') || fallbackName || '이름 없는 스크립트',
        description: first('description'),
        version: first('version') || '1.0',
        author: first('author'),
        namespace: first('namespace'),
        match: [...all('match'), ...all('include')],
        exclude: all('exclude'),
        grant: all('grant'),
        runAt,
    };
}
// ===== Chrome match pattern → 정규식 =====
function escapeRegex(s) {
    return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
function matchPatternToRegex(pattern) {
    // Chrome match pattern: <scheme>://<host>/<path>
    // 가장 단순 변환: * → .*, ? 그대로 escape, 나머지는 literal
    // 와일드카드 *, ? 만 의미.
    const compiled = pattern
        .split('')
        .map((c) => {
        if (c === '*')
            return '.*';
        if (c === '?')
            return '\\?';
        return escapeRegex(c);
    })
        .join('');
    return new RegExp('^' + compiled + '$', 'i');
}
function urlMatches(url, patterns) {
    for (const p of patterns) {
        try {
            if (matchPatternToRegex(p).test(url))
                return true;
        }
        catch { /* ignore */ }
    }
    return false;
}
// ===== 저장소 =====
async function ensureDir() {
    await (0, promises_1.mkdir)(dir(), { recursive: true });
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
                const us = JSON.parse(raw);
                if (us && us.id)
                    userscripts.set(us.id, us);
            }
            catch (err) {
                console.warn('[userscript] load failed', f, err);
            }
        }
    }
    catch (err) {
        console.warn('[userscript] readdir failed', err);
    }
    loaded = true;
}
// id 는 그대로 파일 이름이 된다. `../..` 같은 값이 오면 프로필 **밖**에 쓰거나 지운다.
// 파일을 만지는 두 함수에서 막는다 — 어느 호출자를 거쳐도 새지 않게.
// (2026-09-07 임무 19: 데이터 가져오기에는 같은 방어가 있었는데 여기엔 없었다.)
function safeId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(id) && !id.includes('..') ? id : null;
}
async function persist(us) {
    const safe = safeId(us.id);
    if (!safe)
        throw new Error('저장 id 가 올바르지 않습니다');
    await ensureDir();
    const p = node_path_1.default.join(dir(), `${safe}.json`);
    await (0, promises_1.writeFile)(p, JSON.stringify(us, null, 2), 'utf-8');
}
async function removeFile(id) {
    const safe = safeId(id);
    if (!safe)
        return;
    const p = node_path_1.default.join(dir(), `${safe}.json`);
    if ((0, node_fs_1.existsSync)(p))
        await (0, promises_1.unlink)(p);
}
async function initUserscripts() {
    await loadAll();
}
// ===== CRUD =====
function summarize(us) {
    return {
        id: us.id, name: us.name, description: us.description,
        version: us.version, enabled: us.enabled,
        match: us.match, updatedAt: us.updatedAt,
    };
}
function listUserscripts() {
    return Array.from(userscripts.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(summarize);
}
function getUserscript(id) {
    return userscripts.get(id) ?? null;
}
async function saveUserscript(input) {
    // 스크립트 본문은 **문자열**이어야 한다. 임무 19 실측: 검증이 없어 숫자·배열·null 이
    // 스크립트로 저장됐다(파서가 관대해 빈 메타로 통과시켰다).
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.source !== 'string') {
        throw new Error('userscript 형식이 올바르지 않습니다 — { source: string } 이어야 합니다');
    }
    const parsed = parseUserscript(input.source);
    const now = Date.now();
    const existing = input.id ? userscripts.get(input.id) : null;
    const us = existing
        ? { ...existing, ...parsed, source: input.source, updatedAt: now }
        : {
            id: nextId(),
            ...parsed,
            enabled: true,
            source: input.source,
            createdAt: now,
            updatedAt: now,
        };
    userscripts.set(us.id, us);
    await persist(us);
    exports.userscriptEvents.emit('changed');
    return us;
}
async function removeUserscript(id) {
    userscripts.delete(id);
    await removeFile(id);
    exports.userscriptEvents.emit('changed');
}
async function setUserscriptEnabled(id, enabled) {
    const us = userscripts.get(id);
    if (!us)
        return;
    us.enabled = enabled;
    us.updatedAt = Date.now();
    await persist(us);
    exports.userscriptEvents.emit('changed');
}
// ===== 페이지 주입 =====
function wrap(us) {
    const idLit = JSON.stringify(us.id);
    const nameLit = JSON.stringify(us.name);
    const versionLit = JSON.stringify(us.version);
    return `
;(function() {
  if (window.__bbUS && window.__bbUS[${idLit}]) return
  if (!window.__bbUS) window.__bbUS = {}
  window.__bbUS[${idLit}] = true
  var SCRIPT_ID = ${idLit}
  var GM_info = { script: { name: ${nameLit}, version: ${versionLit} } }
  function _key(k) { return 'GM_' + SCRIPT_ID + '_' + k }
  function GM_setValue(k, v) { try { localStorage.setItem(_key(k), JSON.stringify(v)) } catch(e) {} }
  function GM_getValue(k, def) {
    try {
      var v = localStorage.getItem(_key(k))
      return v == null ? def : JSON.parse(v)
    } catch(e) { return def }
  }
  function GM_deleteValue(k) { try { localStorage.removeItem(_key(k)) } catch(e) {} }
  function GM_listValues() {
    var out = []
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i)
        if (key && key.indexOf('GM_' + SCRIPT_ID + '_') === 0) out.push(key.slice(('GM_' + SCRIPT_ID + '_').length))
      }
    } catch(e) {}
    return out
  }
  function GM_addStyle(css) {
    var s = document.createElement('style')
    s.setAttribute('data-bb-userscript', SCRIPT_ID)
    s.textContent = css
    ;(document.head || document.documentElement).appendChild(s)
    return s
  }
  function GM_openInTab(url) { return window.open(url, '_blank') }
  function GM_setClipboard(text) {
    try { navigator.clipboard.writeText(text) } catch(e) {}
  }
  function GM_log() { console.log.apply(console, ['[userscript]', GM_info.script.name].concat([].slice.call(arguments))) }
  var unsafeWindow = window
  try {
    (function(GM_info, GM_setValue, GM_getValue, GM_deleteValue, GM_listValues, GM_addStyle, GM_openInTab, GM_setClipboard, GM_log, unsafeWindow) {
      ${us.source}
    })(GM_info, GM_setValue, GM_getValue, GM_deleteValue, GM_listValues, GM_addStyle, GM_openInTab, GM_setClipboard, GM_log, unsafeWindow)
  } catch(err) {
    console.error('[userscript:' + GM_info.script.name + ']', err)
  }
})();
`;
}
async function injectScripts(wc, runAtTrigger) {
    if (wc.isDestroyed())
        return;
    const url = wc.getURL();
    if (!/^https?:/i.test(url))
        return;
    for (const us of userscripts.values()) {
        if (!us.enabled)
            continue;
        if (us.runAt !== runAtTrigger)
            continue;
        if (us.match.length === 0)
            continue;
        if (!urlMatches(url, us.match))
            continue;
        if (us.exclude.length > 0 && urlMatches(url, us.exclude))
            continue;
        try {
            await wc.executeJavaScript(wrap(us), true);
        }
        catch (err) {
            console.warn(`[userscript] inject ${us.name} failed`, err);
        }
    }
}
function trackWebContents(wc) {
    // run-at 별 hook
    wc.on('did-start-navigation', () => { });
    wc.on('dom-ready', () => {
        void injectScripts(wc, 'document-start');
        void injectScripts(wc, 'document-end');
    });
    wc.on('did-finish-load', () => {
        void injectScripts(wc, 'document-idle');
    });
}
