"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readlaterEvents = void 0;
exports.listReadLater = listReadLater;
exports.isReadLaterSaved = isReadLaterSaved;
exports.addReadLater = addReadLater;
exports.removeReadLater = removeReadLater;
exports.removeReadLaterByUrl = removeReadLaterByUrl;
exports.setReadLaterRead = setReadLaterRead;
exports.clearReadReadLater = clearReadReadLater;
const safe_store_1 = require("./safe-store");
const node_crypto_1 = require("node:crypto");
const node_events_1 = require("node:events");
// 읽기 목록(나중에 보기) — 페이지를 저장해두고 탭을 비운 뒤 나중에 다시 방문.
exports.readlaterEvents = new node_events_1.EventEmitter();
const store = (0, safe_store_1.createStore)({ name: 'readlater', defaults: { items: [] } });
const MAX_ITEMS = 500;
function getItems() {
    const items = store.get('items');
    return Array.isArray(items) ? items : [];
}
function setItems(items) {
    store.set('items', items.slice(0, MAX_ITEMS));
    exports.readlaterEvents.emit('changed');
}
function listReadLater() {
    return getItems();
}
function isReadLaterSaved(url) {
    return getItems().some((x) => x.url === url);
}
function addReadLater(args) {
    if (!args.url || !/^https?:/i.test(args.url))
        return null;
    const items = getItems();
    const existing = items.find((x) => x.url === args.url);
    if (existing)
        return existing;
    const item = {
        id: (0, node_crypto_1.randomUUID)(),
        url: args.url,
        title: args.title || args.url,
        favicon: args.favicon,
        read: false,
        savedAt: Date.now(),
    };
    setItems([item, ...items]); // 최신 우선
    return item;
}
function removeReadLater(id) {
    setItems(getItems().filter((x) => x.id !== id));
}
function removeReadLaterByUrl(url) {
    setItems(getItems().filter((x) => x.url !== url));
}
function setReadLaterRead(id, read) {
    const items = getItems();
    const it = items.find((x) => x.id === id);
    if (!it)
        return;
    it.read = read;
    it.readAt = read ? Date.now() : undefined;
    setItems(items);
}
function clearReadReadLater() {
    setItems(getItems().filter((x) => !x.read));
}
