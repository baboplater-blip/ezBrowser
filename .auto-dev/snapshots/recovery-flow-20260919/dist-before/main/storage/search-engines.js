"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_BANGS = exports.DEFAULT_ENGINES = void 0;
exports.listEngines = listEngines;
exports.getDefaultEngine = getDefaultEngine;
exports.setDefaultEngine = setDefaultEngine;
exports.findEngineByKeyword = findEngineByKeyword;
exports.findBang = findBang;
exports.buildSearchUrl = buildSearchUrl;
exports.parseBangAndQuery = parseBangAndQuery;
exports.parseEngineKeywordAndQuery = parseEngineKeywordAndQuery;
const settings_1 = require("./settings");
exports.DEFAULT_ENGINES = [
    {
        id: 'google',
        name: 'Google',
        keyword: 'g',
        url: 'https://www.google.com/search?q={query}',
        suggest: 'https://suggestqueries.google.com/complete/search?client=chrome&q={query}',
    },
    {
        id: 'naver',
        name: '네이버',
        keyword: 'n',
        url: 'https://search.naver.com/search.naver?query={query}',
        suggest: 'https://ac.search.naver.com/nx/ac?q={query}&st=100&r_format=json&r_enc=UTF-8&r_lt=11211&q_enc=UTF-8',
    },
    {
        id: 'ddg',
        name: 'DuckDuckGo',
        keyword: 'ddg',
        url: 'https://duckduckgo.com/?q={query}',
        suggest: 'https://duckduckgo.com/ac/?q={query}&type=list',
    },
    {
        id: 'bing',
        name: 'Bing',
        keyword: 'b',
        url: 'https://www.bing.com/search?q={query}',
    },
    {
        id: 'youtube',
        name: 'YouTube',
        keyword: 'yt',
        url: 'https://www.youtube.com/results?search_query={query}',
    },
];
exports.DEFAULT_BANGS = [
    { trigger: 'yt', url: 'https://www.youtube.com/results?search_query={query}', description: 'YouTube' },
    { trigger: 'g', url: 'https://www.google.com/search?q={query}', description: 'Google' },
    { trigger: 'n', url: 'https://search.naver.com/search.naver?query={query}', description: '네이버' },
    { trigger: 'k', url: 'https://kagi.com/search?q={query}', description: 'Kagi' },
    { trigger: 'w', url: 'https://en.wikipedia.org/wiki/Special:Search?search={query}', description: 'Wikipedia' },
    { trigger: 'wko', url: 'https://ko.wikipedia.org/wiki/Special:Search?search={query}', description: '한국어 위키' },
    { trigger: 'gh', url: 'https://github.com/search?q={query}', description: 'GitHub' },
    { trigger: 'mdn', url: 'https://developer.mozilla.org/en-US/search?q={query}', description: 'MDN' },
    { trigger: 'npm', url: 'https://www.npmjs.com/search?q={query}', description: 'npm' },
    { trigger: 'so', url: 'https://stackoverflow.com/search?q={query}', description: 'Stack Overflow' },
    { trigger: 'amz', url: 'https://www.amazon.com/s?k={query}', description: 'Amazon' },
    { trigger: 'cpg', url: 'https://www.coupang.com/np/search?q={query}', description: '쿠팡' },
    { trigger: 'map', url: 'https://map.naver.com/p/search/{query}', description: '네이버 지도' },
    { trigger: 'tr', url: 'https://translate.google.com/?text={query}', description: 'Translate' },
    { trigger: 'dic', url: 'https://en.dict.naver.com/#/search?query={query}', description: '네이버 사전' },
];
function listEngines() {
    return exports.DEFAULT_ENGINES;
}
function getDefaultEngine() {
    const id = (0, settings_1.getSetting)('search').defaultEngine;
    return exports.DEFAULT_ENGINES.find((e) => e.id === id) ?? exports.DEFAULT_ENGINES[0];
}
function setDefaultEngine(id) {
    if (!exports.DEFAULT_ENGINES.find((e) => e.id === id))
        return;
    (0, settings_1.setNestedSetting)('search.defaultEngine', id);
}
function findEngineByKeyword(keyword) {
    return exports.DEFAULT_ENGINES.find((e) => e.keyword === keyword);
}
function findBang(trigger) {
    return exports.DEFAULT_BANGS.find((b) => b.trigger === trigger);
}
function buildSearchUrl(query, engine) {
    const e = engine ?? getDefaultEngine();
    return e.url.replace('{query}', encodeURIComponent(query));
}
function parseBangAndQuery(input) {
    const m = /^!(\S+)\s+(.+)$/.exec(input.trim());
    if (!m)
        return { query: input };
    const bang = findBang(m[1]);
    if (!bang)
        return { query: input };
    return { bang, query: m[2] };
}
function parseEngineKeywordAndQuery(input) {
    const m = /^(\S+)\s+(.+)$/.exec(input.trim());
    if (!m)
        return { query: input };
    const engine = findEngineByKeyword(m[1]);
    if (!engine)
        return { query: input };
    return { engine, query: m[2] };
}
