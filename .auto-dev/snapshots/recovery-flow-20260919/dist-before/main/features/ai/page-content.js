"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractPageContent = extractPageContent;
exports.getPageSummaryInfo = getPageSummaryInfo;
const electron_1 = require("electron");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
let readabilityCode = null;
function resolveReadabilityPath() {
    if (electron_1.app.isPackaged) {
        return node_path_1.default.join(process.resourcesPath, 'app.asar', 'node_modules', '@mozilla', 'readability', 'Readability.js');
    }
    return require.resolve('@mozilla/readability/Readability.js');
}
async function loadReadability() {
    if (readabilityCode)
        return readabilityCode;
    readabilityCode = await (0, promises_1.readFile)(resolveReadabilityPath(), 'utf-8');
    return readabilityCode;
}
function buildScript(libCode) {
    return `
(function() {
  ${libCode}
  var out = { url: location.href, title: document.title || '', byline: '', text: '', selection: '' };
  try {
    out.selection = String((window.getSelection && window.getSelection().toString()) || '');
  } catch (e) {}
  try {
    var clone = document.cloneNode(true);
    var article = new Readability(clone).parse();
    if (article && article.textContent && article.textContent.trim().length > 0) {
      out.title = article.title || out.title;
      out.byline = article.byline || '';
      out.text = article.textContent;
    } else if (document.body) {
      out.text = document.body.innerText || '';
    }
  } catch (e) {
    if (document.body) out.text = document.body.innerText || '';
  }
  return out;
})();
`;
}
async function extractPageContent(wc, maxChars) {
    if (wc.isDestroyed())
        return null;
    const url = wc.getURL();
    if (!/^https?:/i.test(url))
        return null;
    let raw;
    try {
        const code = await loadReadability();
        raw = (await wc.executeJavaScript(buildScript(code), true));
    }
    catch (err) {
        console.warn('[ai] page extract failed', err);
        return null;
    }
    const text = (raw.text ?? '').replace(/\n{3,}/g, '\n\n').trim();
    const truncated = text.length > maxChars;
    return {
        url: raw.url ?? url,
        title: raw.title ?? '',
        byline: raw.byline ?? '',
        text: truncated ? text.slice(0, maxChars) : text,
        selection: (raw.selection ?? '').trim().slice(0, 8000),
        truncated,
    };
}
// UI 표시용 가벼운 컨텍스트(본문 추출 없이 제목/URL/선택 여부만).
async function getPageSummaryInfo(wc) {
    if (wc.isDestroyed())
        return null;
    const url = wc.getURL();
    if (!/^https?:/i.test(url))
        return { url, title: wc.getTitle(), hasSelection: false };
    try {
        const info = (await wc.executeJavaScript(`(function(){ try { return { hasSelection: !!(window.getSelection && window.getSelection().toString().trim()) } } catch(e){ return { hasSelection:false } } })();`, true));
        return { url, title: wc.getTitle(), hasSelection: !!info.hasSelection };
    }
    catch {
        return { url, title: wc.getTitle(), hasSelection: false };
    }
}
