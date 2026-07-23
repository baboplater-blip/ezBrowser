import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { NEW_TAB_URL } from '../../../shared/constants'
import type { Workspace, WorkspaceColor, WorkspaceState } from '../../../shared/types'

const COLORS: WorkspaceColor[] = ['blue', 'purple', 'green', 'orange', 'pink', 'red', 'yellow', 'gray']

const workspaces = new Map<string, Workspace>()
let activeId: string = ''
let loaded = false
let counter = 0

export const workspaceEvents = new EventEmitter()

function filePath(): string {
  return path.join(app.getPath('userData'), 'workspaces.json')
}

function nextId(): string {
  counter += 1
  return `ws-${Date.now().toString(36)}-${counter}`
}

function partitionOf(id: string): string {
  return `persist:ws-${id}`
}

function nextColor(): WorkspaceColor {
  const used = new Set<WorkspaceColor>()
  for (const w of workspaces.values()) used.add(w.color)
  for (const c of COLORS) if (!used.has(c)) return c
  return COLORS[workspaces.size % COLORS.length]!
}

function nextName(): string {
  let n = workspaces.size + 1
  const used = new Set<string>(Array.from(workspaces.values()).map((w) => w.name))
  while (used.has(`스페이스 ${n}`)) n += 1
  return `스페이스 ${n}`
}

// ===== 저장소 =====

async function ensureDir(): Promise<void> {
  await mkdir(path.dirname(filePath()), { recursive: true })
}

async function loadAll(): Promise<void> {
  if (loaded) return
  loaded = true
  await ensureDir()
  if (!existsSync(filePath())) return
  try {
    const raw = await readFile(filePath(), 'utf-8')
    const data = JSON.parse(raw) as Partial<WorkspaceState>
    if (Array.isArray(data.workspaces)) {
      for (const w of data.workspaces) {
        if (!w || typeof w.id !== 'string') continue
        workspaces.set(w.id, normalize(w))
      }
    }
    if (typeof data.activeId === 'string' && workspaces.has(data.activeId)) {
      activeId = data.activeId
    }
  } catch (err) {
    console.warn('[workspace] load failed', err)
  }
}

function normalize(w: Partial<Workspace>): Workspace {
  const id = w.id ?? nextId()
  return {
    id,
    name: (w.name ?? '').trim() || '이름 없는 스페이스',
    color: (COLORS as readonly string[]).includes(w.color as string) ? (w.color as WorkspaceColor) : 'gray',
    homeUrl: w.homeUrl ?? NEW_TAB_URL,
    partition: w.partition ?? partitionOf(id),
    createdAt: w.createdAt ?? Date.now(),
    updatedAt: w.updatedAt ?? Date.now(),
    position: typeof w.position === 'number' ? w.position : workspaces.size,
  }
}

let persistTimer: NodeJS.Timeout | null = null
async function persist(): Promise<void> {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(async () => {
    persistTimer = null
    await ensureDir()
    const data: WorkspaceState = { workspaces: getOrderedList(), activeId }
    try {
      await writeFile(filePath(), JSON.stringify(data, null, 2), 'utf-8')
    } catch (err) {
      console.warn('[workspace] persist failed', err)
    }
  }, 250)
}

function getOrderedList(): Workspace[] {
  return Array.from(workspaces.values()).sort((a, b) => a.position - b.position)
}

// ===== Init =====

export async function initWorkspaces(): Promise<void> {
  await loadAll()
  if (workspaces.size === 0) {
    const id = nextId()
    const ws: Workspace = {
      id, name: '기본', color: 'gray', homeUrl: NEW_TAB_URL,
      partition: partitionOf(id),
      createdAt: Date.now(), updatedAt: Date.now(), position: 0,
    }
    workspaces.set(id, ws)
    activeId = id
    await persist()
  }
  if (!activeId || !workspaces.has(activeId)) {
    const first = getOrderedList()[0]
    if (first) activeId = first.id
  }
}

// ===== CRUD =====

export function listWorkspaces(): Workspace[] {
  return getOrderedList()
}

export function getWorkspace(id: string): Workspace | null {
  return workspaces.get(id) ?? null
}

export function getActiveWorkspaceId(): string {
  return activeId
}

export function getActiveWorkspace(): Workspace | null {
  return workspaces.get(activeId) ?? null
}

export function getActivePartition(): string {
  const w = getActiveWorkspace()
  return w?.partition ?? `persist:ws-default`
}

export function getState(): WorkspaceState {
  return { workspaces: getOrderedList(), activeId }
}

export async function createWorkspace(input?: Partial<Workspace>): Promise<Workspace> {
  const id = nextId()
  const ws: Workspace = {
    id,
    name: (input?.name ?? '').trim() || nextName(),
    color: input?.color ?? nextColor(),
    homeUrl: input?.homeUrl ?? NEW_TAB_URL,
    partition: partitionOf(id),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    position: workspaces.size,
  }
  workspaces.set(id, ws)
  await persist()
  workspaceEvents.emit('created', ws)
  workspaceEvents.emit('changed')
  return ws
}

export async function updateWorkspace(id: string, patch: Partial<Workspace>): Promise<Workspace | null> {
  const ws = workspaces.get(id)
  if (!ws) return null
  const next: Workspace = {
    ...ws,
    name: patch.name !== undefined ? (patch.name.trim() || ws.name) : ws.name,
    color: patch.color ?? ws.color,
    homeUrl: patch.homeUrl ?? ws.homeUrl,
    updatedAt: Date.now(),
  }
  workspaces.set(id, next)
  await persist()
  workspaceEvents.emit('updated', next)
  workspaceEvents.emit('changed')
  return next
}

export async function removeWorkspace(id: string): Promise<{ removed: boolean; newActiveId: string }> {
  if (workspaces.size <= 1) return { removed: false, newActiveId: activeId }
  const ws = workspaces.get(id)
  if (!ws) return { removed: false, newActiveId: activeId }
  const wasActive = activeId === id
  workspaces.delete(id)
  // 인덱스 재정렬
  getOrderedList().forEach((w, i) => { w.position = i })
  if (wasActive) {
    const first = getOrderedList()[0]
    activeId = first ? first.id : ''
  }
  await persist()
  workspaceEvents.emit('removed', { id, partition: ws.partition })
  // 활성 워크스페이스를 지웠으면 새 활성으로 'activated' 를 발생시켜야 tab-service 가 새 워크스페이스의
  // 탭을 보이게 하고(레이아웃 재적용) 탭이 없으면 홈 탭을 만든다 — 안 그러면 빈 창이 된다.
  if (wasActive && activeId) workspaceEvents.emit('activated', { id: activeId, prev: id })
  workspaceEvents.emit('changed')
  return { removed: true, newActiveId: activeId }
}

export async function setActiveWorkspace(id: string): Promise<boolean> {
  if (!workspaces.has(id)) return false
  if (activeId === id) return true
  const prev = activeId
  activeId = id
  await persist()
  workspaceEvents.emit('activated', { id, prev })
  workspaceEvents.emit('changed')
  return true
}

export async function reorderWorkspaces(orderedIds: string[]): Promise<void> {
  orderedIds.forEach((id, i) => {
    const w = workspaces.get(id)
    if (w) w.position = i
  })
  await persist()
  workspaceEvents.emit('changed')
}

export function nextWorkspaceId(direction: 1 | -1): string | null {
  const list = getOrderedList()
  if (list.length <= 1) return null
  const i = list.findIndex((w) => w.id === activeId)
  if (i < 0) return list[0]?.id ?? null
  const next = (i + direction + list.length) % list.length
  return list[next]?.id ?? null
}
