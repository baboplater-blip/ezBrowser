"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerOmniboxIpc = registerOmniboxIpc;
const electron_1 = require("electron");
const ipc_channels_1 = require("../../shared/ipc-channels");
const constants_1 = require("../../shared/constants");
const search_engines_1 = require("../storage/search-engines");
const tab_service_1 = require("../tabs/tab-service");
const bookmarks_1 = require("../storage/bookmarks");
const history_1 = require("../storage/history");
const cache = new Map();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;
function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry)
        return null;
    if (entry.expiresAt < Date.now()) {
        cache.delete(key);
        return null;
    }
    return entry.value;
}
function cacheSet(key, value) {
    if (cache.size >= CACHE_MAX) {
        const first = cache.keys().next().value;
        if (first)
            cache.delete(first);
    }
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}
async function fetchSuggest(engineId, query) {
    const engine = (0, search_engines_1.listEngines)().find((e) => e.id === engineId);
    if (!engine?.suggest)
        return [];
    const url = engine.suggest.replace('{query}', encodeURIComponent(query));
    return new Promise((resolve) => {
        let done = false;
        const request = electron_1.net.request({ url, method: 'GET', useSessionCookies: false });
        const chunks = [];
        const timer = setTimeout(() => {
            if (done)
                return;
            done = true;
            try {
                request.abort();
            }
            catch { /* ignore */ }
            resolve([]);
        }, constants_1.SUGGEST_TIMEOUT_MS);
        request.on('response', (resp) => {
            resp.on('data', (chunk) => chunks.push(chunk));
            resp.on('end', () => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                try {
                    const body = Buffer.concat(chunks).toString('utf8');
                    resolve(parseAdapter(engineId, body, engine.url));
                }
                catch {
                    resolve([]);
                }
            });
        });
        request.on('error', () => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            resolve([]);
        });
        request.end();
    });
}
function parseAdapter(engineId, body, engineUrl) {
    try {
        const json = JSON.parse(body);
        let phrases = [];
        if (engineId === 'google' && Array.isArray(json) && Array.isArray(json[1]))
            phrases = json[1];
        else if (engineId === 'ddg' && Array.isArray(json)) {
            phrases = json.map((it) => (typeof it === 'string' ? it : it.phrase ?? '')).filter(Boolean);
        }
        else if (engineId === 'naver' && json?.items && Array.isArray(json.items[0])) {
            phrases = json.items[0].map((it) => (Array.isArray(it) ? it[0] : '')).filter(Boolean);
        }
        return phrases.slice(0, 8).map((text, i) => ({
            id: `search-${i}-${text}`,
            source: 'search',
            text,
            url: engineUrl.replace('{query}', encodeURIComponent(text)),
            score: 0.3,
        }));
    }
    catch {
        return [];
    }
}
function normalizeUrl(input) {
    const v = input.trim();
    if (!v)
        return null;
    if (/^[a-z]+:\/\//i.test(v))
        return v;
    if (/^[\w.-]+\.[a-z]{2,}([/?#].*)?$/i.test(v))
        return `https://${v}`;
    return null;
}
async function combineSuggestions(query, windowId) {
    const out = [];
    const q = query.trim();
    if (!q)
        return out;
    const directUrl = normalizeUrl(q);
    if (directUrl) {
        out.push({
            id: `url-${directUrl}`, source: 'url', text: q,
            detail: directUrl, url: directUrl, score: 1,
        });
    }
    const bangResult = (0, search_engines_1.parseBangAndQuery)(q);
    if (bangResult.bang) {
        out.push({
            id: `bang-${bangResult.bang.trigger}`, source: 'search',
            text: `!${bangResult.bang.trigger} ${bangResult.query}`,
            detail: bangResult.bang.description, score: 0.95,
            url: bangResult.bang.url.replace('{query}', encodeURIComponent(bangResult.query)),
        });
    }
    else {
        const kwResult = (0, search_engines_1.parseEngineKeywordAndQuery)(q);
        if (kwResult.engine) {
            out.push({
                id: `kw-${kwResult.engine.id}`, source: 'search',
                text: `${kwResult.engine.name}: ${kwResult.query}`,
                detail: kwResult.engine.name, score: 0.9,
                url: (0, search_engines_1.buildSearchUrl)(kwResult.query, kwResult.engine),
            });
        }
    }
    if (windowId) {
        const tabs = (0, tab_service_1.listTabs)(windowId).filter((t) => t.title.toLowerCase().includes(q.toLowerCase()) ||
            t.url.toLowerCase().includes(q.toLowerCase())).slice(0, 3);
        for (const t of tabs) {
            out.push({
                id: `tab-${t.id}`, source: 'tab',
                text: t.title, detail: t.url, url: t.url, score: 0.6,
            });
        }
    }
    try {
        const bookmarks = (0, bookmarks_1.searchBookmarks)(q, 4);
        for (const b of bookmarks) {
            out.push({
                id: `bm-${b.id}`, source: 'bookmark',
                text: b.title, detail: b.url, url: b.url, score: 0.75,
            });
        }
    }
    catch { /* db not ready */ }
    try {
        const hist = (0, history_1.searchHistory)(q, 6);
        for (const h of hist) {
            const score = Math.min(0.7, 0.45 + Math.log10(h.visitCount + 1) * 0.12);
            out.push({
                id: `hist-${h.id}`, source: 'history',
                text: h.title || h.url, detail: h.url, url: h.url, score,
            });
        }
    }
    catch { /* db not ready */ }
    const engine = (0, search_engines_1.getDefaultEngine)();
    out.push({
        id: `default-${engine.id}`, source: 'search',
        text: `${engine.name} 검색: ${q}`,
        detail: engine.name, score: 0.4,
        url: (0, search_engines_1.buildSearchUrl)(q),
    });
    if (engine.suggest) {
        const cacheKey = `${engine.id}::${q.toLowerCase()}`;
        let suggest = cacheGet(cacheKey);
        if (!suggest) {
            suggest = await fetchSuggest(engine.id, q);
            cacheSet(cacheKey, suggest);
        }
        out.push(...suggest);
    }
    return dedupe(out).sort((a, b) => b.score - a.score).slice(0, 10);
}
function dedupe(arr) {
    const seen = new Set();
    const out = [];
    for (const s of arr) {
        const key = (s.url ?? s.text).toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(s);
    }
    return out;
}
function registerOmniboxIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.omnibox.suggest, async (_e, { query, windowId }) => combineSuggestions(query, windowId));
    electron_1.ipcMain.handle(ipc_channels_1.IPC.omnibox.navigate, (_e, { windowId, tabId, input }) => {
        const direct = normalizeUrl(input);
        let target = direct;
        if (!target) {
            const bang = (0, search_engines_1.parseBangAndQuery)(input);
            if (bang.bang)
                target = bang.bang.url.replace('{query}', encodeURIComponent(bang.query));
            else {
                const kw = (0, search_engines_1.parseEngineKeywordAndQuery)(input);
                if (kw.engine)
                    target = (0, search_engines_1.buildSearchUrl)(kw.query, kw.engine);
                else
                    target = (0, search_engines_1.buildSearchUrl)(input);
            }
        }
        if (tabId)
            (0, tab_service_1.navigateTab)(tabId, target);
        else
            (0, tab_service_1.createTab)({ windowId, url: target });
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.search.listEngines, () => {
        // 검색엔진 목록은 민감 정보 아님 — 모든 컨텍스트 허용 (omnibox 자동완성에서도 필요할 수 있음)
        return (0, search_engines_1.listEngines)();
    });
}
