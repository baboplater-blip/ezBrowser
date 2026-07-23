import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { writeFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'

// 에이전트 작업 매크로 — 자주 쓰는 작업 지시를 저장했다가 아무 페이지에서나 한 번에 재실행.
// userData/ai-agent-tasks.json 에 저장(원자적 tmp+rename, 디바운스).

export interface SavedAgentTask {
  id: string
  name: string
  task: string
  createdAt: number
  lastRunAt?: number
}

export const savedTaskEvents = new EventEmitter()

const MAX_TASKS = 50
let cache: SavedAgentTask[] | null = null
let writeTimer: NodeJS.Timeout | null = null
let dirty = false
let quitHooked = false

function filePath(): string {
  return path.join(app.getPath('userData'), 'ai-agent-tasks.json')
}

function isValid(t: unknown): t is SavedAgentTask {
  if (!t || typeof t !== 'object') return false
  const o = t as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.task === 'string'
}

export function initSavedTasks(): void {
  if (!quitHooked) { quitHooked = true; try { app.on('before-quit', flushSavedTasks) } catch { /* ignore */ } }
  if (cache !== null) return
  try {
    if (existsSync(filePath())) {
      const raw = JSON.parse(readFileSync(filePath(), 'utf-8')) as { tasks?: unknown }
      cache = Array.isArray(raw?.tasks) ? raw.tasks.filter(isValid) : []
    } else {
      cache = []
    }
  } catch (err) {
    console.warn('[ai] saved tasks load failed', err)
    cache = []
  }
}

function all(): SavedAgentTask[] {
  if (cache === null) initSavedTasks()
  return cache ?? []
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
    await writeFile(tmp, JSON.stringify({ version: 1, tasks: all() }), 'utf-8')
    await rename(tmp, filePath())
    dirty = false
  } catch (err) {
    console.warn('[ai] saved tasks persist failed', err)
  }
}

export function flushSavedTasks(): void {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
  if (!dirty) return
  try {
    mkdirSync(path.dirname(filePath()), { recursive: true })
    const tmp = filePath() + '.tmp' // 원자적 쓰기 — 종료 중 크래시로 파일이 잘리지 않도록
    writeFileSync(tmp, JSON.stringify({ version: 1, tasks: all() }), 'utf-8')
    renameSync(tmp, filePath())
    dirty = false
  } catch (err) {
    console.warn('[ai] saved tasks flush failed', err)
  }
}

function emitChanged(): void {
  savedTaskEvents.emit('changed', listSavedTasks())
}

export function listSavedTasks(): SavedAgentTask[] {
  return all().slice().sort((a, b) => b.createdAt - a.createdAt)
}

function deriveName(task: string): string {
  const t = task.replace(/\s+/g, ' ').trim()
  if (!t) return '작업'
  return t.length > 30 ? t.slice(0, 30) + '…' : t
}

export function addSavedTask(task: string, name?: string): SavedAgentTask | null {
  const t = String(task ?? '').trim()
  if (!t) return null
  const item: SavedAgentTask = {
    id: randomUUID(),
    name: name && name.trim() ? name.trim().slice(0, 60) : deriveName(t),
    task: t,
    createdAt: Date.now(),
  }
  const list = all()
  list.unshift(item)
  if (list.length > MAX_TASKS) cache = list.slice(0, MAX_TASKS)
  schedulePersist()
  emitChanged()
  return item
}

export function removeSavedTask(id: string): void {
  const list = all()
  const idx = list.findIndex((t) => t.id === id)
  if (idx < 0) return
  list.splice(idx, 1)
  schedulePersist()
  emitChanged()
}

export function renameSavedTask(id: string, name: string): void {
  const t = all().find((x) => x.id === id)
  if (!t) return
  t.name = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || t.name
  schedulePersist()
  emitChanged()
}

export function touchSavedTask(id: string): void {
  const t = all().find((x) => x.id === id)
  if (!t) return
  t.lastRunAt = Date.now()
  schedulePersist()
  emitChanged()
}
