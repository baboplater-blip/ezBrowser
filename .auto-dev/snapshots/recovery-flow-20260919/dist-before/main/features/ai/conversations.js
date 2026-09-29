"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.conversationEvents = exports.FOLDER_COLORS = void 0;
exports.initConversations = initConversations;
exports.flushConversations = flushConversations;
exports.listConversations = listConversations;
exports.getConversation = getConversation;
exports.setConversationPinned = setConversationPinned;
exports.searchConversations = searchConversations;
exports.saveConversation = saveConversation;
exports.renameConversation = renameConversation;
exports.deleteConversation = deleteConversation;
exports.clearAllConversations = clearAllConversations;
exports.listFolders = listFolders;
exports.reorderFolders = reorderFolders;
exports.safeFileName = safeFileName;
exports.writeDownloadMd = writeDownloadMd;
exports.conversationToMarkdown = conversationToMarkdown;
exports.conversationsToMarkdown = conversationsToMarkdown;
exports.createFolder = createFolder;
exports.setFolderColor = setFolderColor;
exports.setFolderEmoji = setFolderEmoji;
exports.renameFolder = renameFolder;
exports.deleteFolder = deleteFolder;
exports.setConversationFolder = setConversationFolder;
exports.setConversationTags = setConversationTags;
exports.listTags = listTags;
const electron_1 = require("electron");
const node_crypto_1 = require("node:crypto");
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const json_store_1 = require("./json-store");
// 부작용 없는 경로 해석기만 가져온다(downloads/index 를 통째로 끌어오면 세션·종료 훅까지 딸려 온다).
const dir_1 = require("../downloads/dir");
// 폴더 색(외피 탭 그룹과 동일 팔레트) — 좁은 폭에서 폴더를 색 점으로 구분한다.
exports.FOLDER_COLORS = ['blue', 'red', 'green', 'yellow', 'purple', 'pink', 'orange', 'gray'];
function isFolderColor(c) {
    return typeof c === 'string' && exports.FOLDER_COLORS.includes(c);
}
exports.conversationEvents = new node_events_1.EventEmitter();
const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES = 200;
const MAX_TAGS = 8;
const MAX_TAG_LEN = 24;
const FILE_NAME = 'ai-chats.json';
let cache = null;
let folderCache = null;
let quitHooked = false;
const store = (0, json_store_1.createJsonStore)({
    fileName: FILE_NAME,
    label: '대화',
    debounceMs: 300,
    snapshot: () => ({ version: 1, conversations: all(), folders: allFolders() }),
});
function isValidConv(c) {
    if (!c || typeof c !== 'object')
        return false;
    const o = c;
    return typeof o.id === 'string' && Array.isArray(o.messages);
}
function isValidFolder(f) {
    if (!f || typeof f !== 'object')
        return false;
    const o = f;
    return typeof o.id === 'string' && typeof o.name === 'string';
}
function initConversations() {
    // 종료 시 디바운스 대기 중이던 저장을 동기 flush(정상 종료 데이터 손실 방지).
    if (!quitHooked) {
        quitHooked = true;
        try {
            electron_1.app.on('before-quit', flushConversations);
        }
        catch { /* ignore */ }
    }
    if (cache !== null)
        return;
    // 파일을 통째로 못 읽으면 loadJsonObject 가 고유 이름 백업을 남기고 null 을 준다(빈 상태로 시작).
    const raw = (0, json_store_1.loadJsonObject)(FILE_NAME, '대화', 'conversations');
    if (!raw) {
        cache = [];
        folderCache = [];
        return;
    }
    // 파싱은 됐지만 일부 항목이 망가진 경우 — 정상 항목은 **복구**하고, 버린 개수를 알린다.
    // (조용히 버리면 사용자는 몇 개가 사라졌는지 알 수 없다.)
    const rawConvs = Array.isArray(raw.conversations) ? raw.conversations : [];
    cache = rawConvs.filter(isValidConv);
    const foldersOk = Array.isArray(raw.folders);
    const rawFolders = foldersOk ? raw.folders : [];
    folderCache = rawFolders.filter(isValidFolder).map((f) => {
        const o = f;
        return {
            ...f,
            color: isFolderColor(o.color) ? o.color : 'gray',
            emoji: typeof o.emoji === 'string' && o.emoji ? o.emoji : undefined,
        };
    });
    const dropped = (rawConvs.length - cache.length)
        + (rawFolders.length - folderCache.length)
        + (raw.folders !== undefined && !foldersOk ? 1 : 0);
    store.reportDropped(dropped, cache.length + folderCache.length);
}
function all() {
    if (cache === null)
        initConversations();
    return cache ?? [];
}
function allFolders() {
    if (folderCache === null)
        initConversations();
    return folderCache ?? [];
}
function schedulePersist() {
    store.markDirty();
}
// 종료 시 동기 저장 — 디바운스 대기 중이던 마지막 대화가 유실되지 않도록.
function flushConversations() {
    store.flush();
}
function summaryOf(c) {
    return {
        id: c.id, title: c.title || '새 대화', updatedAt: c.updatedAt, messageCount: c.messages.length,
        folderId: c.folderId ?? null, tags: c.tags ?? [], pinned: c.pinned ?? false,
    };
}
function emitChanged() {
    exports.conversationEvents.emit('changed', listConversations());
}
function emitFolders() {
    exports.conversationEvents.emit('folders', listFolders());
}
function listConversations() {
    return all().slice().sort((a, b) => {
        // 고정 대화 먼저, 그다음 최근성
        const pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0;
        if (pa !== pb)
            return pb - pa;
        return b.updatedAt - a.updatedAt;
    }).map(summaryOf);
}
function getConversation(id) {
    return all().find((c) => c.id === id) ?? null;
}
function setConversationPinned(id, pinned) {
    const c = all().find((x) => x.id === id);
    if (!c)
        return;
    c.pinned = !!pinned; // updatedAt 은 유지 — 고정은 정렬 그룹만 바꾸고 최근성은 보존
    schedulePersist();
    emitChanged();
}
// 매칭 위치 주변의 짧은 본문 발췌(하이라이트용) — 앞뒤 …
function snippetAround(text, q) {
    const flat = text.replace(/\s+/g, ' ');
    const idx = flat.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0)
        return '';
    const start = Math.max(0, idx - 30);
    const end = Math.min(flat.length, idx + q.length + 40);
    return (start > 0 ? '…' : '') + flat.slice(start, end).trim() + (end < flat.length ? '…' : '');
}
// 제목 + 메시지 본문까지 검색. 제목만 매칭이면 snippet=null(제목 하이라이트로 충분),
// 본문 매칭이면 그 위치 발췌를 함께 반환(어디서 맞았는지 보여주기).
function searchConversations(query) {
    // 쿼리·본문 모두 공백을 같은 방식으로 정규화(collapse)해서 매칭한다 — 그러지 않으면 "foo bar"(한 칸)가
    // 본문 "foo\nbar"/"foo  bar" 를 놓치거나, 매칭돼도 snippet 이 '' 이 되어 결과에서 탈락하는 불일치가 생긴다.
    const q = String(query ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!q)
        return [];
    const out = [];
    for (const c of all()) {
        const titleHit = typeof c.title === 'string' && c.title.replace(/\s+/g, ' ').toLowerCase().includes(q);
        let contentHit = false;
        let snippet = null;
        for (const m of c.messages) {
            if (typeof m?.content === 'string' && m.content.replace(/\s+/g, ' ').toLowerCase().includes(q)) {
                contentHit = true;
                snippet = snippetAround(m.content, q) || null; // 매칭했으나 발췌가 비어도 결과에는 포함
                break;
            }
        }
        if (titleHit || contentHit)
            out.push({ id: c.id, snippet: titleHit ? null : snippet });
    }
    return out;
}
function deriveTitle(messages) {
    const first = messages.find((m) => m.role === 'user' && m.content.trim());
    const t = (first?.content ?? '').replace(/\s+/g, ' ').trim();
    if (!t)
        return '새 대화';
    return t.length > 40 ? t.slice(0, 40) + '…' : t;
}
// upsert — 렌더러가 한 번의 왕복이 끝날 때마다 스레드 전체를 저장.
// extra: 압축 상태(summary/foldCount)도 함께 영속화 → 재시작해도 접힌 상태 유지.
function saveConversation(id, messages, extra) {
    const clean = messages
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content }))
        .slice(-MAX_MESSAGES);
    if (clean.length === 0)
        return null;
    // foldCount 는 저장되는 메시지 수를 넘지 않도록 클램프(필터/슬라이스로 개수가 줄 수 있음).
    const summary = typeof extra?.summary === 'string' ? extra.summary : undefined;
    const foldCount = typeof extra?.foldCount === 'number' ? Math.max(0, Math.min(extra.foldCount, clean.length)) : undefined;
    const now = Date.now();
    const list = all();
    const existing = list.find((c) => c.id === id);
    let conv;
    if (existing) {
        existing.messages = clean;
        existing.updatedAt = now;
        if (!existing.title || existing.title === '새 대화')
            existing.title = deriveTitle(clean);
        existing.summary = summary;
        existing.foldCount = foldCount;
        conv = existing;
    }
    else {
        conv = { id, title: deriveTitle(clean), createdAt: now, updatedAt: now, messages: clean, summary, foldCount };
        list.push(conv);
        if (list.length > MAX_CONVERSATIONS) {
            // 고정 대화는 되도록 축출하지 않는다 — "고정=보존" 의미 보장.
            list.sort((a, b) => {
                const pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0;
                if (pa !== pb)
                    return pb - pa;
                return b.updatedAt - a.updatedAt;
            });
            let trimmed = list.slice(0, MAX_CONVERSATIONS);
            // 단, 고정이 상한을 꽉 채워 방금 저장한 새 대화가 잘려나갔다면(조용히 유실 — saveConversation 은
            // 성공을 반환) 가장 오래된 고정 하나를 대신 축출해 새 대화를 보존한다.
            if (!trimmed.some((x) => x.id === conv.id))
                trimmed = [...trimmed.slice(0, MAX_CONVERSATIONS - 1), conv];
            cache = trimmed;
        }
    }
    schedulePersist();
    emitChanged();
    return summaryOf(conv);
}
function renameConversation(id, title) {
    const conv = all().find((c) => c.id === id);
    if (!conv)
        return;
    conv.title = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || '새 대화';
    conv.updatedAt = Date.now();
    schedulePersist();
    emitChanged();
}
function deleteConversation(id) {
    const list = all();
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0)
        return;
    list.splice(idx, 1);
    schedulePersist();
    emitChanged();
}
function clearAllConversations() {
    cache = [];
    schedulePersist();
    emitChanged();
}
// ===== 폴더 (1단 평면) =====
function listFolders() {
    return allFolders().slice(); // 저장된 배열 순서 = 사용자 정렬 순서
}
function reorderFolders(orderedIds) {
    const list = allFolders();
    const byId = new Map(list.map((f) => [f.id, f]));
    const next = [];
    for (const id of orderedIds) {
        const f = byId.get(id);
        if (f) {
            next.push(f);
            byId.delete(id);
        }
    }
    for (const f of list) {
        if (byId.has(f.id))
            next.push(f);
    } // 누락분은 뒤에 보존
    folderCache = next;
    schedulePersist();
    emitFolders();
}
// 파일명 위생 처리(대화·보고서 내보내기 공용).
function safeFileName(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'export';
}
// 다운로드 폴더에 마크다운 파일을 충돌 없이 기록(대화·보고서 내보내기 공용 — 다이얼로그/블롭 우회).
//
// 저장 위치는 **다운로드와 같은 규칙**(설정의 downloads.defaultPath 우선 → 없으면 OS 기본)을 따른다.
// 전에는 app.getPath('downloads') 로 고정돼 있어, 사용자가 저장 위치를 바꿔 놔도 AI 보고서·대화
// 내보내기만 OS Downloads 폴더로 샜다(검증 하네스도 그래서 사용자의 실제 폴더를 건드렸다).
async function writeDownloadMd(base, md) {
    try {
        const dir = (0, dir_1.defaultDownloadDir)();
        await (0, promises_1.mkdir)(dir, { recursive: true });
        let file = node_path_1.default.join(dir, `${base}.md`);
        let n = 1;
        while ((0, node_fs_1.existsSync)(file)) {
            file = node_path_1.default.join(dir, `${base} (${n++}).md`);
        }
        await (0, promises_1.writeFile)(file, md, 'utf-8');
        return { ok: true, path: file };
    }
    catch {
        return { ok: false };
    }
}
// 대화 하나를 마크다운으로 (개별 내보내기)
function conversationToMarkdown(conv) {
    const lines = [`# ${conv.title || '대화'}`, ''];
    for (const m of conv.messages) {
        lines.push(`**${m.role === 'user' ? '나' : 'AI'}:**`, '', m.content, '', '---', '');
    }
    return lines.join('\n');
}
// 여러 대화를 하나의 마크다운으로 (다중/폴더 내보내기)
function conversationsToMarkdown(convs) {
    const lines = [`# 대화 내보내기 (${convs.length}개)`, '', '---', ''];
    for (const c of convs) {
        lines.push(`## ${c.title || '대화'}`, '');
        for (const m of c.messages)
            lines.push(`**${m.role === 'user' ? '나' : 'AI'}:**`, '', m.content, '');
        lines.push('---', '');
    }
    return lines.join('\n');
}
function pickFolderColor() {
    const used = new Set(allFolders().map((f) => f.color));
    const free = exports.FOLDER_COLORS.find((c) => !used.has(c));
    return free ?? exports.FOLDER_COLORS[allFolders().length % exports.FOLDER_COLORS.length] ?? 'gray';
}
function createFolder(name, color) {
    const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!n)
        return null;
    const folder = { id: (0, node_crypto_1.randomUUID)(), name: n, createdAt: Date.now(), color: isFolderColor(color) ? color : pickFolderColor() };
    allFolders().push(folder);
    schedulePersist();
    emitFolders();
    return folder;
}
function setFolderColor(id, color) {
    if (!isFolderColor(color))
        return;
    const f = allFolders().find((x) => x.id === id);
    if (!f)
        return;
    f.color = color;
    schedulePersist();
    emitFolders();
}
function setFolderEmoji(id, emoji) {
    const f = allFolders().find((x) => x.id === id);
    if (!f)
        return;
    const e = String(emoji ?? '').trim().slice(0, 8);
    f.emoji = e || undefined; // 빈 문자열 = 아이콘 제거(색 점으로 복귀)
    schedulePersist();
    emitFolders();
}
function renameFolder(id, name) {
    const f = allFolders().find((x) => x.id === id);
    if (!f)
        return;
    f.name = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || f.name;
    schedulePersist();
    emitFolders();
}
function deleteFolder(id) {
    const list = allFolders();
    const idx = list.findIndex((f) => f.id === id);
    if (idx < 0)
        return;
    list.splice(idx, 1);
    // 폴더에 속했던 대화는 미분류로
    let touched = false;
    for (const c of all()) {
        if (c.folderId === id) {
            c.folderId = null;
            touched = true;
        }
    }
    schedulePersist();
    emitFolders();
    if (touched)
        emitChanged();
}
function setConversationFolder(convId, folderId) {
    const c = all().find((x) => x.id === convId);
    if (!c)
        return;
    c.folderId = folderId && allFolders().some((f) => f.id === folderId) ? folderId : null;
    schedulePersist();
    emitChanged();
}
function sanitizeTags(tags) {
    const out = [];
    for (const raw of Array.isArray(tags) ? tags : []) {
        const t = String(raw ?? '').replace(/\s+/g, ' ').replace(/^#+/, '').trim().slice(0, MAX_TAG_LEN);
        if (t && !out.includes(t))
            out.push(t);
        if (out.length >= MAX_TAGS)
            break;
    }
    return out;
}
function setConversationTags(convId, tags) {
    const c = all().find((x) => x.id === convId);
    if (!c)
        return;
    c.tags = sanitizeTags(tags);
    schedulePersist();
    emitChanged();
}
// 모든 대화의 태그 합집합(필터 칩용)
function listTags() {
    const set = new Set();
    for (const c of all())
        for (const t of c.tags ?? [])
            set.add(t);
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ko'));
}
