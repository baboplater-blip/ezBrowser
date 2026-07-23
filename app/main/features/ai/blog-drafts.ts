import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// 블로그 초안 저장·불러오기 — 스튜디오에서 만든 글을 디스크에 보관해 나중에 이어 쓰거나 재사용.
// 시리즈 연재(seriesId/part)도 함께 담아, 한 시리즈의 여러 편을 묶어 관리한다.

export interface BlogDraftSaved {
  id: string
  topic: string
  title: string
  bodyMarkdown: string
  tags: string[]
  summary: string
  options?: { tone?: string; length?: string; platform?: string; keywords?: string }
  seriesId?: string
  seriesTitle?: string
  part?: number
  createdAt: number
  updatedAt: number
}
export interface BlogDraftSummary {
  id: string; title: string; topic: string; seriesId?: string; seriesTitle?: string; part?: number; updatedAt: number
}

const FILE = (): string => join(app.getPath('userData'), 'blog-drafts.json')
const CAP = 200
let drafts: BlogDraftSaved[] = []
export const blogDraftEvents = new EventEmitter()
let saveTimer: NodeJS.Timeout | null = null

function persist(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try { const tmp = FILE() + '.tmp'; writeFileSync(tmp, JSON.stringify(drafts, null, 2), 'utf8'); renameSync(tmp, FILE()) } catch { /* ignore */ }
  }, 300)
}
function emitChanged(): void { blogDraftEvents.emit('changed', listBlogDrafts()) }

function summaryOf(d: BlogDraftSaved): BlogDraftSummary {
  return { id: d.id, title: d.title, topic: d.topic, seriesId: d.seriesId, seriesTitle: d.seriesTitle, part: d.part, updatedAt: d.updatedAt }
}
export function listBlogDrafts(): BlogDraftSummary[] {
  return drafts.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(summaryOf)
}
export function getBlogDraft(id: string): BlogDraftSaved | null {
  return drafts.find((d) => d.id === id) ?? null
}

interface SavePayload {
  id?: string
  topic?: string
  title?: string
  bodyMarkdown?: string
  tags?: string[]
  summary?: string
  options?: { tone?: string; length?: string; platform?: string; keywords?: string }
  seriesId?: string
  seriesTitle?: string
  part?: number
}
export function saveBlogDraft(p: SavePayload): BlogDraftSummary {
  const now = Date.now()
  const title = String(p.title ?? '').slice(0, 200) || '제목 없음'
  const body = String(p.bodyMarkdown ?? '')
  const tags = Array.isArray(p.tags) ? p.tags.map((t) => String(t).slice(0, 40)).filter(Boolean).slice(0, 20) : []
  const existing = p.id ? drafts.find((d) => d.id === p.id) : undefined
  if (existing) {
    existing.topic = String(p.topic ?? existing.topic).slice(0, 300)
    existing.title = title
    existing.bodyMarkdown = body
    existing.tags = tags
    existing.summary = String(p.summary ?? existing.summary ?? '').slice(0, 400)
    if (p.options) existing.options = p.options
    if (p.seriesId !== undefined) existing.seriesId = p.seriesId
    if (p.seriesTitle !== undefined) existing.seriesTitle = p.seriesTitle
    if (p.part !== undefined) existing.part = p.part
    existing.updatedAt = now
    persist(); emitChanged()
    return summaryOf(existing)
  }
  const d: BlogDraftSaved = {
    id: randomUUID(),
    topic: String(p.topic ?? '').slice(0, 300),
    title, bodyMarkdown: body, tags,
    summary: String(p.summary ?? '').slice(0, 400),
    options: p.options,
    seriesId: p.seriesId, seriesTitle: p.seriesTitle, part: p.part,
    createdAt: now, updatedAt: now,
  }
  drafts.unshift(d)
  if (drafts.length > CAP) drafts.length = CAP
  persist(); emitChanged()
  return summaryOf(d)
}
export function removeBlogDraft(id: string): void {
  drafts = drafts.filter((d) => d.id !== id)
  persist(); emitChanged()
}

export function initBlogDrafts(): void {
  try { if (existsSync(FILE())) { const raw = JSON.parse(readFileSync(FILE(), 'utf8')) as BlogDraftSaved[]; if (Array.isArray(raw)) drafts = raw } }
  catch { drafts = [] }
}
