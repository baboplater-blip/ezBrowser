import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { writeFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'

// AI 챗 대화 영속화 — 재시작해도 대화가 남고, 여러 스레드를 오가며 이어갈 수 있게 한다.
// userData/ai-chats.json 하나에 모든 대화를 담고, 원자적(tmp+rename) 디바운스 저장.

export interface StoredMessage { role: 'user' | 'assistant'; content: string }

// 폴더 색(외피 탭 그룹과 동일 팔레트) — 좁은 폭에서 폴더를 색 점으로 구분한다.
export const FOLDER_COLORS = ['blue', 'red', 'green', 'yellow', 'purple', 'pink', 'orange', 'gray'] as const
export type FolderColor = (typeof FOLDER_COLORS)[number]
function isFolderColor(c: unknown): c is FolderColor {
  return typeof c === 'string' && (FOLDER_COLORS as readonly string[]).includes(c)
}

export interface ChatFolder { id: string; name: string; createdAt: number; color: FolderColor; emoji?: string }
export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: StoredMessage[]
  folderId?: string | null
  tags?: string[]
  pinned?: boolean
  summary?: string    // 접힌(요약된) 앞부분 대화 — 압축 기능
  foldCount?: number  // 앞에서 몇 개 메시지가 요약으로 접혔는지
}
export interface ConversationSummary {
  id: string
  title: string
  updatedAt: number
  messageCount: number
  folderId: string | null
  tags: string[]
  pinned: boolean
}

export const conversationEvents = new EventEmitter()

const MAX_CONVERSATIONS = 100
const MAX_MESSAGES = 200
const MAX_TAGS = 8
const MAX_TAG_LEN = 24

let cache: Conversation[] | null = null
let folderCache: ChatFolder[] | null = null
let writeTimer: NodeJS.Timeout | null = null
let dirty = false
let quitHooked = false

function filePath(): string {
  return path.join(app.getPath('userData'), 'ai-chats.json')
}

function isValidConv(c: unknown): c is Conversation {
  if (!c || typeof c !== 'object') return false
  const o = c as Record<string, unknown>
  return typeof o.id === 'string' && Array.isArray(o.messages)
}

function isValidFolder(f: unknown): f is ChatFolder {
  if (!f || typeof f !== 'object') return false
  const o = f as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.name === 'string'
}

export function initConversations(): void {
  // 종료 시 디바운스 대기 중이던 저장을 동기 flush(정상 종료 데이터 손실 방지).
  if (!quitHooked) { quitHooked = true; try { app.on('before-quit', flushConversations) } catch { /* ignore */ } }
  if (cache !== null) return
  try {
    if (existsSync(filePath())) {
      const raw = JSON.parse(readFileSync(filePath(), 'utf-8')) as { conversations?: unknown; folders?: unknown }
      cache = Array.isArray(raw?.conversations) ? raw.conversations.filter(isValidConv) : []
      folderCache = Array.isArray(raw?.folders)
        ? raw.folders.filter(isValidFolder).map((f) => {
            const o = f as { color?: unknown; emoji?: unknown }
            return {
              ...f,
              color: isFolderColor(o.color) ? o.color : 'gray',
              emoji: typeof o.emoji === 'string' && o.emoji ? o.emoji : undefined,
            }
          })
        : []
    } else {
      cache = []
      folderCache = []
    }
  } catch (err) {
    console.warn('[ai] conversations load failed', err)
    // 손상 파일을 .bak 으로 보존한 뒤 빈 상태로 시작한다 — 다음 저장이 원본을 영구히 덮어써
    // 복구 불가능해지는 것을 막는다.
    try { if (existsSync(filePath())) renameSync(filePath(), filePath() + '.corrupt.bak') } catch { /* ignore */ }
    cache = []
    folderCache = []
  }
}

function all(): Conversation[] {
  if (cache === null) initConversations()
  return cache ?? []
}

function allFolders(): ChatFolder[] {
  if (folderCache === null) initConversations()
  return folderCache ?? []
}

function schedulePersist(): void {
  dirty = true
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => { void persist() }, 300)
}

async function persist(): Promise<void> {
  try {
    await mkdir(path.dirname(filePath()), { recursive: true })
    const tmp = filePath() + '.tmp'
    await writeFile(tmp, JSON.stringify({ version: 1, conversations: all(), folders: allFolders() }), 'utf-8')
    await rename(tmp, filePath())
    dirty = false
  } catch (err) {
    console.warn('[ai] conversations persist failed', err)
  }
}

// 종료 시 동기 저장 — 디바운스 대기 중이던 마지막 대화가 유실되지 않도록.
export function flushConversations(): void {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
  if (!dirty) return
  try {
    mkdirSync(path.dirname(filePath()), { recursive: true })
    // 원자적 쓰기(tmp+rename) — 종료 중 프로세스가 죽어도 ai-chats.json 이 잘려 전체 대화가 날아가지 않도록.
    const tmp = filePath() + '.tmp'
    writeFileSync(tmp, JSON.stringify({ version: 1, conversations: all(), folders: allFolders() }), 'utf-8')
    renameSync(tmp, filePath())
    dirty = false
  } catch (err) {
    console.warn('[ai] conversations flush failed', err)
  }
}

function summaryOf(c: Conversation): ConversationSummary {
  return {
    id: c.id, title: c.title || '새 대화', updatedAt: c.updatedAt, messageCount: c.messages.length,
    folderId: c.folderId ?? null, tags: c.tags ?? [], pinned: c.pinned ?? false,
  }
}

function emitChanged(): void {
  conversationEvents.emit('changed', listConversations())
}

function emitFolders(): void {
  conversationEvents.emit('folders', listFolders())
}

export function listConversations(): ConversationSummary[] {
  return all().slice().sort((a, b) => {
    // 고정 대화 먼저, 그다음 최근성
    const pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0
    if (pa !== pb) return pb - pa
    return b.updatedAt - a.updatedAt
  }).map(summaryOf)
}

export function getConversation(id: string): Conversation | null {
  return all().find((c) => c.id === id) ?? null
}

export function setConversationPinned(id: string, pinned: boolean): void {
  const c = all().find((x) => x.id === id)
  if (!c) return
  c.pinned = !!pinned // updatedAt 은 유지 — 고정은 정렬 그룹만 바꾸고 최근성은 보존
  schedulePersist()
  emitChanged()
}

export interface ConvSearchHit { id: string; snippet: string | null }

// 매칭 위치 주변의 짧은 본문 발췌(하이라이트용) — 앞뒤 …
function snippetAround(text: string, q: string): string {
  const flat = text.replace(/\s+/g, ' ')
  const idx = flat.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return ''
  const start = Math.max(0, idx - 30)
  const end = Math.min(flat.length, idx + q.length + 40)
  return (start > 0 ? '…' : '') + flat.slice(start, end).trim() + (end < flat.length ? '…' : '')
}

// 제목 + 메시지 본문까지 검색. 제목만 매칭이면 snippet=null(제목 하이라이트로 충분),
// 본문 매칭이면 그 위치 발췌를 함께 반환(어디서 맞았는지 보여주기).
export function searchConversations(query: string): ConvSearchHit[] {
  // 쿼리·본문 모두 공백을 같은 방식으로 정규화(collapse)해서 매칭한다 — 그러지 않으면 "foo bar"(한 칸)가
  // 본문 "foo\nbar"/"foo  bar" 를 놓치거나, 매칭돼도 snippet 이 '' 이 되어 결과에서 탈락하는 불일치가 생긴다.
  const q = String(query ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  if (!q) return []
  const out: ConvSearchHit[] = []
  for (const c of all()) {
    const titleHit = typeof c.title === 'string' && c.title.replace(/\s+/g, ' ').toLowerCase().includes(q)
    let contentHit = false
    let snippet: string | null = null
    for (const m of c.messages) {
      if (typeof m?.content === 'string' && m.content.replace(/\s+/g, ' ').toLowerCase().includes(q)) {
        contentHit = true
        snippet = snippetAround(m.content, q) || null // 매칭했으나 발췌가 비어도 결과에는 포함
        break
      }
    }
    if (titleHit || contentHit) out.push({ id: c.id, snippet: titleHit ? null : snippet })
  }
  return out
}

function deriveTitle(messages: StoredMessage[]): string {
  const first = messages.find((m) => m.role === 'user' && m.content.trim())
  const t = (first?.content ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return '새 대화'
  return t.length > 40 ? t.slice(0, 40) + '…' : t
}

// upsert — 렌더러가 한 번의 왕복이 끝날 때마다 스레드 전체를 저장.
// extra: 압축 상태(summary/foldCount)도 함께 영속화 → 재시작해도 접힌 상태 유지.
export function saveConversation(id: string, messages: StoredMessage[], extra?: { summary?: string; foldCount?: number }): ConversationSummary | null {
  const clean: StoredMessage[] = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }))
    .slice(-MAX_MESSAGES)
  if (clean.length === 0) return null
  // foldCount 는 저장되는 메시지 수를 넘지 않도록 클램프(필터/슬라이스로 개수가 줄 수 있음).
  const summary = typeof extra?.summary === 'string' ? extra.summary : undefined
  const foldCount = typeof extra?.foldCount === 'number' ? Math.max(0, Math.min(extra.foldCount, clean.length)) : undefined
  const now = Date.now()
  const list = all()
  const existing = list.find((c) => c.id === id)
  let conv: Conversation
  if (existing) {
    existing.messages = clean
    existing.updatedAt = now
    if (!existing.title || existing.title === '새 대화') existing.title = deriveTitle(clean)
    existing.summary = summary
    existing.foldCount = foldCount
    conv = existing
  } else {
    conv = { id, title: deriveTitle(clean), createdAt: now, updatedAt: now, messages: clean, summary, foldCount }
    list.push(conv)
    if (list.length > MAX_CONVERSATIONS) {
      // 고정 대화는 되도록 축출하지 않는다 — "고정=보존" 의미 보장.
      list.sort((a, b) => {
        const pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0
        if (pa !== pb) return pb - pa
        return b.updatedAt - a.updatedAt
      })
      let trimmed = list.slice(0, MAX_CONVERSATIONS)
      // 단, 고정이 상한을 꽉 채워 방금 저장한 새 대화가 잘려나갔다면(조용히 유실 — saveConversation 은
      // 성공을 반환) 가장 오래된 고정 하나를 대신 축출해 새 대화를 보존한다.
      if (!trimmed.some((x) => x.id === conv.id)) trimmed = [...trimmed.slice(0, MAX_CONVERSATIONS - 1), conv]
      cache = trimmed
    }
  }
  schedulePersist()
  emitChanged()
  return summaryOf(conv)
}

export function renameConversation(id: string, title: string): void {
  const conv = all().find((c) => c.id === id)
  if (!conv) return
  conv.title = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || '새 대화'
  conv.updatedAt = Date.now()
  schedulePersist()
  emitChanged()
}

export function deleteConversation(id: string): void {
  const list = all()
  const idx = list.findIndex((c) => c.id === id)
  if (idx < 0) return
  list.splice(idx, 1)
  schedulePersist()
  emitChanged()
}

export function clearAllConversations(): void {
  cache = []
  schedulePersist()
  emitChanged()
}

// ===== 폴더 (1단 평면) =====

export function listFolders(): ChatFolder[] {
  return allFolders().slice() // 저장된 배열 순서 = 사용자 정렬 순서
}

export function reorderFolders(orderedIds: string[]): void {
  const list = allFolders()
  const byId = new Map(list.map((f) => [f.id, f]))
  const next: ChatFolder[] = []
  for (const id of orderedIds) { const f = byId.get(id); if (f) { next.push(f); byId.delete(id) } }
  for (const f of list) { if (byId.has(f.id)) next.push(f) } // 누락분은 뒤에 보존
  folderCache = next
  schedulePersist()
  emitFolders()
}

// 파일명 위생 처리(대화·보고서 내보내기 공용).
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'export'
}

// 다운로드 폴더에 마크다운 파일을 충돌 없이 기록(대화·보고서 내보내기 공용 — 다이얼로그/블롭 우회).
export async function writeDownloadMd(base: string, md: string): Promise<{ ok: boolean; path?: string }> {
  try {
    const dir = app.getPath('downloads')
    await mkdir(dir, { recursive: true })
    let file = path.join(dir, `${base}.md`)
    let n = 1
    while (existsSync(file)) { file = path.join(dir, `${base} (${n++}).md`) }
    await writeFile(file, md, 'utf-8')
    return { ok: true, path: file }
  } catch {
    return { ok: false }
  }
}

// 대화 하나를 마크다운으로 (개별 내보내기)
export function conversationToMarkdown(conv: Conversation): string {
  const lines: string[] = [`# ${conv.title || '대화'}`, '']
  for (const m of conv.messages) {
    lines.push(`**${m.role === 'user' ? '나' : 'AI'}:**`, '', m.content, '', '---', '')
  }
  return lines.join('\n')
}

// 여러 대화를 하나의 마크다운으로 (다중/폴더 내보내기)
export function conversationsToMarkdown(convs: Conversation[]): string {
  const lines: string[] = [`# 대화 내보내기 (${convs.length}개)`, '', '---', '']
  for (const c of convs) {
    lines.push(`## ${c.title || '대화'}`, '')
    for (const m of c.messages) lines.push(`**${m.role === 'user' ? '나' : 'AI'}:**`, '', m.content, '')
    lines.push('---', '')
  }
  return lines.join('\n')
}

function pickFolderColor(): FolderColor {
  const used = new Set(allFolders().map((f) => f.color))
  const free = FOLDER_COLORS.find((c) => !used.has(c))
  return free ?? FOLDER_COLORS[allFolders().length % FOLDER_COLORS.length] ?? 'gray'
}

export function createFolder(name: string, color?: FolderColor): ChatFolder | null {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
  if (!n) return null
  const folder: ChatFolder = { id: randomUUID(), name: n, createdAt: Date.now(), color: isFolderColor(color) ? color : pickFolderColor() }
  allFolders().push(folder)
  schedulePersist()
  emitFolders()
  return folder
}

export function setFolderColor(id: string, color: FolderColor): void {
  if (!isFolderColor(color)) return
  const f = allFolders().find((x) => x.id === id)
  if (!f) return
  f.color = color
  schedulePersist()
  emitFolders()
}

export function setFolderEmoji(id: string, emoji: string): void {
  const f = allFolders().find((x) => x.id === id)
  if (!f) return
  const e = String(emoji ?? '').trim().slice(0, 8)
  f.emoji = e || undefined // 빈 문자열 = 아이콘 제거(색 점으로 복귀)
  schedulePersist()
  emitFolders()
}

export function renameFolder(id: string, name: string): void {
  const f = allFolders().find((x) => x.id === id)
  if (!f) return
  f.name = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || f.name
  schedulePersist()
  emitFolders()
}

export function deleteFolder(id: string): void {
  const list = allFolders()
  const idx = list.findIndex((f) => f.id === id)
  if (idx < 0) return
  list.splice(idx, 1)
  // 폴더에 속했던 대화는 미분류로
  let touched = false
  for (const c of all()) { if (c.folderId === id) { c.folderId = null; touched = true } }
  schedulePersist()
  emitFolders()
  if (touched) emitChanged()
}

export function setConversationFolder(convId: string, folderId: string | null): void {
  const c = all().find((x) => x.id === convId)
  if (!c) return
  c.folderId = folderId && allFolders().some((f) => f.id === folderId) ? folderId : null
  schedulePersist()
  emitChanged()
}

function sanitizeTags(tags: string[]): string[] {
  const out: string[] = []
  for (const raw of Array.isArray(tags) ? tags : []) {
    const t = String(raw ?? '').replace(/\s+/g, ' ').replace(/^#+/, '').trim().slice(0, MAX_TAG_LEN)
    if (t && !out.includes(t)) out.push(t)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

export function setConversationTags(convId: string, tags: string[]): void {
  const c = all().find((x) => x.id === convId)
  if (!c) return
  c.tags = sanitizeTags(tags)
  schedulePersist()
  emitChanged()
}

// 모든 대화의 태그 합집합(필터 칩용)
export function listTags(): string[] {
  const set = new Set<string>()
  for (const c of all()) for (const t of c.tags ?? []) set.add(t)
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'ko'))
}
