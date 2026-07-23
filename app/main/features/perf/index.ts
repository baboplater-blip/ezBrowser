import { app } from 'electron'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import type { PerfBudget, PerfMilestones, PerfReport } from '../../../shared/types'

// process.uptime() 시작 기준 — boot 부터 경과 시간
const BOOT_NS = process.hrtime.bigint()

function elapsedMs(): number {
  return Number((process.hrtime.bigint() - BOOT_NS) / 1_000_000n)
}

const milestones: PerfMilestones = {
  whenReadyMs: null,
  firstWindowReadyMs: null,
  firstTabLoadedMs: null,
  memoryAt30sMB: null,
  memoryNowMB: 0,
  startedAt: Date.now(),
  version: app.getVersion(),
  packaged: app.isPackaged,
}

const BUDGET: PerfBudget = { coldStartMs: 2000, blankWindowMemoryMB: 250 }
const HISTORY_FILE = (): string => path.join(app.getPath('userData'), 'logs', 'perf.json')
const HISTORY_LIMIT = 30

export const perfEvents = new EventEmitter()

function totalMemoryMB(): number {
  const m = app.getAppMetrics()
  const total = m.reduce((s, p) => s + (p.memory?.workingSetSize ?? 0), 0)
  return Math.round(total / 1024)
}

export function recordWhenReady(): void {
  if (milestones.whenReadyMs !== null) return
  milestones.whenReadyMs = elapsedMs()
  perfEvents.emit('milestone', { ...milestones })
}

export function recordFirstWindowReady(): void {
  if (milestones.firstWindowReadyMs !== null) return
  milestones.firstWindowReadyMs = elapsedMs()
  perfEvents.emit('milestone', { ...milestones })
}

export function recordFirstTabLoaded(): void {
  if (milestones.firstTabLoadedMs !== null) return
  milestones.firstTabLoadedMs = elapsedMs()
  perfEvents.emit('milestone', { ...milestones })
  setTimeout(() => { void captureMemory30s() }, 30_000)
}

async function captureMemory30s(): Promise<void> {
  milestones.memoryAt30sMB = totalMemoryMB()
  perfEvents.emit('milestone', { ...milestones })
  await appendHistory()
}

export function getMilestones(): PerfMilestones {
  milestones.memoryNowMB = totalMemoryMB()
  return { ...milestones }
}

export async function readHistory(): Promise<PerfMilestones[]> {
  try {
    const raw = await fsp.readFile(HISTORY_FILE(), 'utf-8')
    const arr = JSON.parse(raw) as PerfMilestones[]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

async function appendHistory(): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(HISTORY_FILE()), { recursive: true })
    const history = await readHistory()
    history.push({ ...milestones })
    while (history.length > HISTORY_LIMIT) history.shift()
    await fsp.writeFile(HISTORY_FILE(), JSON.stringify(history, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[perf] write history failed', err)
  }
}

export async function getReport(): Promise<PerfReport> {
  return {
    current: getMilestones(),
    budget: { ...BUDGET },
    history: await readHistory(),
  }
}

export function evaluateBudget(m: PerfMilestones): { pass: boolean; issues: string[] } {
  const issues: string[] = []
  const cold = m.firstWindowReadyMs ?? m.firstTabLoadedMs
  if (cold !== null && cold > BUDGET.coldStartMs) {
    issues.push(`콜드 스타트 ${cold}ms > 예산 ${BUDGET.coldStartMs}ms`)
  }
  if (m.memoryAt30sMB !== null && m.memoryAt30sMB > BUDGET.blankWindowMemoryMB) {
    issues.push(`30초 메모리 ${m.memoryAt30sMB}MB > 예산 ${BUDGET.blankWindowMemoryMB}MB`)
  }
  return { pass: issues.length === 0, issues }
}
