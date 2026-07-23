import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { writeFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'

// 에이전트 실행 이력 — 에이전트가 수행한 작업(지시·단계·결과)을 저장해 나중에 되짚어볼 수 있게 한다.
// 메인에서 기록하므로 사이드바를 닫아도 남는다. userData/ai-agent-runs.json.

export type AgentRunStatus = 'running' | 'done' | 'error' | 'cancelled'
export interface AgentRunStep { icon: string; text: string; tone?: 'ok' | 'warn' | 'muted' }
export interface AgentRun {
  id: string
  task: string
  startedAt: number
  endedAt?: number
  status: AgentRunStatus
  steps: AgentRunStep[]
  result?: string
}
export interface AgentRunSummary {
  id: string
  task: string
  startedAt: number
  endedAt?: number
  status: AgentRunStatus
  stepCount: number
}

export const agentRunEvents = new EventEmitter()

const MAX_RUNS = 50
const MAX_STEPS_PER_RUN = 120
let cache: AgentRun[] | null = null
let writeTimer: NodeJS.Timeout | null = null
let dirty = false
let quitHooked = false

function filePath(): string {
  return path.join(app.getPath('userData'), 'ai-agent-runs.json')
}

function isValid(r: unknown): r is AgentRun {
  if (!r || typeof r !== 'object') return false
  const o = r as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.task === 'string' && Array.isArray(o.steps)
}

export function initAgentRuns(): void {
  if (!quitHooked) { quitHooked = true; try { app.on('before-quit', flushAgentRuns) } catch { /* ignore */ } }
  if (cache !== null) return
  try {
    if (existsSync(filePath())) {
      const raw = JSON.parse(readFileSync(filePath(), 'utf-8')) as { runs?: unknown }
      cache = Array.isArray(raw?.runs) ? raw.runs.filter(isValid) : []
      // 재시작 시 'running' 으로 남은 것은 중단된 것으로 정리
      for (const r of cache) { if (r.status === 'running') { r.status = 'cancelled'; r.endedAt = r.endedAt ?? r.startedAt } }
    } else {
      cache = []
    }
  } catch (err) {
    console.warn('[ai] agent runs load failed', err)
    cache = []
  }
}

function all(): AgentRun[] {
  if (cache === null) initAgentRuns()
  return cache ?? []
}

function schedulePersist(): void {
  dirty = true
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => { void persist() }, 400)
}

async function persist(): Promise<void> {
  try {
    await mkdir(path.dirname(filePath()), { recursive: true })
    const tmp = filePath() + '.tmp'
    await writeFile(tmp, JSON.stringify({ version: 1, runs: all() }), 'utf-8')
    await rename(tmp, filePath())
    dirty = false
  } catch (err) {
    console.warn('[ai] agent runs persist failed', err)
  }
}

export function flushAgentRuns(): void {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
  if (!dirty) return
  try {
    mkdirSync(path.dirname(filePath()), { recursive: true })
    const tmp = filePath() + '.tmp' // 원자적 쓰기 — 종료 중 크래시로 파일이 잘리지 않도록
    writeFileSync(tmp, JSON.stringify({ version: 1, runs: all() }), 'utf-8')
    renameSync(tmp, filePath())
    dirty = false
  } catch (err) {
    console.warn('[ai] agent runs flush failed', err)
  }
}

function summaryOf(r: AgentRun): AgentRunSummary {
  return { id: r.id, task: r.task, startedAt: r.startedAt, endedAt: r.endedAt, status: r.status, stepCount: r.steps.length }
}

function emitChanged(): void {
  agentRunEvents.emit('changed', listAgentRuns())
}

export function listAgentRuns(): AgentRunSummary[] {
  return all().slice().sort((a, b) => b.startedAt - a.startedAt).map(summaryOf)
}

export function getAgentRun(id: string): AgentRun | null {
  return all().find((r) => r.id === id) ?? null
}

// 에이전트 이벤트를 사람이 읽는 단계로 변환(AiTab 라이브 트레이스와 동일 매핑).
type EventLike = { type: string; [k: string]: unknown }
function deriveStep(evt: EventLike): AgentRunStep | null {
  const s = (k: string): string => String(evt[k] ?? '')
  switch (evt.type) {
    case 'observe': return { icon: '🔍', text: `관찰 · 스텝 ${s('step')} · 요소 ${s('elements')}개`, tone: 'muted' }
    case 'thought': return evt.thought ? { icon: '💭', text: s('thought') } : null
    case 'action': return { icon: '⚙️', text: s('label') }
    case 'result': return { icon: evt.ok ? '✔️' : '✖️', text: s('detail'), tone: evt.ok ? 'ok' : 'warn' }
    case 'confirm': return { icon: '⏸️', text: `확인 필요: ${s('label')}`, tone: 'warn' }
    case 'ask': return { icon: '❓', text: s('message') }
    case 'answer': return { icon: '🗣️', text: `답변: ${s('text')}`, tone: 'muted' }
    case 'report': return { icon: '📄', text: `보고서: ${s('title')} (노트 ${s('notes')}개)`, tone: 'ok' }
    case 'done': return { icon: '🏁', text: s('message') || '완료', tone: 'ok' }
    case 'error': return { icon: '❌', text: s('message') || '오류', tone: 'warn' }
    case 'cancelled': return { icon: '⏹️', text: '중단됨', tone: 'muted' }
    default: return null
  }
}

export function recordAgentEvent(runId: string, task: string, evt: EventLike): void {
  const list = all()
  let run = list.find((r) => r.id === runId)

  if (evt.type === 'start') {
    if (run) return
    run = { id: runId, task: task || String(evt.task ?? '작업'), startedAt: Date.now(), status: 'running', steps: [] }
    list.unshift(run)
    if (list.length > MAX_RUNS) cache = list.slice(0, MAX_RUNS)
    schedulePersist(); emitChanged()
    return
  }

  if (!run) {
    run = { id: runId, task: task || '작업', startedAt: Date.now(), status: 'running', steps: [] }
    list.unshift(run)
    if (list.length > MAX_RUNS) cache = list.slice(0, MAX_RUNS)
  }

  const step = deriveStep(evt)
  if (step) {
    run.steps.push(step)
    // 상한 초과 시 최신(종료 마커 포함) 을 남기도록 오래된 단계를 버린다.
    if (run.steps.length > MAX_STEPS_PER_RUN) run.steps.splice(0, run.steps.length - MAX_STEPS_PER_RUN)
  }

  let transitioned = false
  if (evt.type === 'done') { run.status = 'done'; run.endedAt = Date.now(); run.result = String(evt.message ?? ''); transitioned = true }
  else if (evt.type === 'error') { run.status = 'error'; run.endedAt = Date.now(); run.result = String(evt.message ?? ''); transitioned = true }
  else if (evt.type === 'cancelled') { run.status = 'cancelled'; run.endedAt = Date.now(); transitioned = true }

  schedulePersist()
  if (transitioned) emitChanged() // 단계마다가 아니라 상태 전환 시에만 목록 갱신(라이브 트레이스는 별도 스트림)
}

export function deleteAgentRun(id: string): void {
  const list = all()
  const idx = list.findIndex((r) => r.id === id)
  if (idx < 0) return
  list.splice(idx, 1)
  schedulePersist(); emitChanged()
}

export function clearAgentRuns(): void {
  cache = []
  schedulePersist(); emitChanged()
}
