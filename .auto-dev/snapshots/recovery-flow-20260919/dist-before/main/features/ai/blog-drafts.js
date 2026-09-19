"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.blogDraftEvents = void 0;
exports.listBlogDrafts = listBlogDrafts;
exports.getBlogDraft = getBlogDraft;
exports.saveBlogDraft = saveBlogDraft;
exports.removeBlogDraft = removeBlogDraft;
exports.initBlogDrafts = initBlogDrafts;
const electron_1 = require("electron");
const node_crypto_1 = require("node:crypto");
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const FILE = () => (0, node_path_1.join)(electron_1.app.getPath('userData'), 'blog-drafts.json');
const CAP = 200;
let drafts = [];
exports.blogDraftEvents = new node_events_1.EventEmitter();
let saveTimer = null;
function persist() {
    if (saveTimer)
        clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            const tmp = FILE() + '.tmp';
            (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(drafts, null, 2), 'utf8');
            (0, node_fs_1.renameSync)(tmp, FILE());
        }
        catch { /* ignore */ }
    }, 300);
}
function emitChanged() { exports.blogDraftEvents.emit('changed', listBlogDrafts()); }
function summaryOf(d) {
    return { id: d.id, title: d.title, topic: d.topic, seriesId: d.seriesId, seriesTitle: d.seriesTitle, part: d.part, updatedAt: d.updatedAt };
}
function listBlogDrafts() {
    return drafts.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(summaryOf);
}
function getBlogDraft(id) {
    return drafts.find((d) => d.id === id) ?? null;
}
function saveBlogDraft(p) {
    const now = Date.now();
    const title = String(p.title ?? '').slice(0, 200) || '제목 없음';
    const body = String(p.bodyMarkdown ?? '');
    const tags = Array.isArray(p.tags) ? p.tags.map((t) => String(t).slice(0, 40)).filter(Boolean).slice(0, 20) : [];
    const existing = p.id ? drafts.find((d) => d.id === p.id) : undefined;
    if (existing) {
        existing.topic = String(p.topic ?? existing.topic).slice(0, 300);
        existing.title = title;
        existing.bodyMarkdown = body;
        existing.tags = tags;
        existing.summary = String(p.summary ?? existing.summary ?? '').slice(0, 400);
        if (p.options)
            existing.options = p.options;
        if (p.seriesId !== undefined)
            existing.seriesId = p.seriesId;
        if (p.seriesTitle !== undefined)
            existing.seriesTitle = p.seriesTitle;
        if (p.part !== undefined)
            existing.part = p.part;
        existing.updatedAt = now;
        persist();
        emitChanged();
        return summaryOf(existing);
    }
    const d = {
        id: (0, node_crypto_1.randomUUID)(),
        topic: String(p.topic ?? '').slice(0, 300),
        title, bodyMarkdown: body, tags,
        summary: String(p.summary ?? '').slice(0, 400),
        options: p.options,
        seriesId: p.seriesId, seriesTitle: p.seriesTitle, part: p.part,
        createdAt: now, updatedAt: now,
    };
    drafts.unshift(d);
    if (drafts.length > CAP)
        drafts.length = CAP;
    persist();
    emitChanged();
    return summaryOf(d);
}
function removeBlogDraft(id) {
    drafts = drafts.filter((d) => d.id !== id);
    persist();
    emitChanged();
}
function initBlogDrafts() {
    try {
        if ((0, node_fs_1.existsSync)(FILE())) {
            const raw = JSON.parse((0, node_fs_1.readFileSync)(FILE(), 'utf8'));
            if (Array.isArray(raw))
                drafts = raw;
        }
    }
    catch {
        drafts = [];
    }
}
