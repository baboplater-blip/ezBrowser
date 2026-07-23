import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { runAgentTask, cancelAgentTask, confirmAgentStep, type AgentEvent } from './agent'
import { getWebContentsByTabId, listTabs } from '../../tabs/tab-service'

// 에이전트 작업 자동 반복 — 저장/현재 작업을 일정 간격으로 반복 실행한다(무인).
// 안전: 무인 반복 중 게시·삭제 같은 민감 동작은 기본적으로 자동 승인하지 않는다.
// autoConfirm 를 켜지 않으면, 확인이 필요한 실행은 60초 뒤 그 실행만 취소한다(자동 실행 금지).
// ask(사용자 질문)도 무인에선 답할 수 없으므로 그 실행을 취소한다.
// 재시작 시에는 자동 부활하지 않는다(부팅 시 무인 에이전트 자동 실행은 위험 — 사용자가 다시 시작).

export interface RepeatJob {
  id: string
  task: string
  windowId: string
  tabId: string
  intervalMs: number
  totalCount: number        // 0 = 무제한
  doneCount: number
  autoConfirm: boolean
  status: 'running' | 'waiting' | 'stopped' | 'finished'
  nextAt: number | null
  lastResult?: string
  createdAt: number
}

export interface RepeatSummary {
  id: string; task: string; intervalMs: number; totalCount: number; doneCount: number
  autoConfirm: boolean; status: RepeatJob['status']; nextAt: number | null; lastResult?: string
}

const MIN_INTERVAL_MS = 2_000
const CONFIRM_WAIT_MS = 60_000

export const repeatEvents = new EventEmitter()
const jobs = new Map<string, RepeatJob>()
const timers = new Map<string, NodeJS.Timeout>()
const runningReq = new Map<string, string>()

function summaryOf(j: RepeatJob): RepeatSummary {
  return { id: j.id, task: j.task, intervalMs: j.intervalMs, totalCount: j.totalCount, doneCount: j.doneCount, autoConfirm: j.autoConfirm, status: j.status, nextAt: j.nextAt, lastResult: j.lastResult }
}
export function listRepeats(): RepeatSummary[] { return Array.from(jobs.values()).map(summaryOf) }
function emitChanged(): void { repeatEvents.emit('changed', listRepeats()) }

// 실행할 http 탭 결정 — 저장한 탭이 살아있고 웹페이지면 그걸, 아니면 그 창의 활성 탭.
function resolveTabId(job: RepeatJob): string | null {
  const wc = getWebContentsByTabId(job.tabId)
  if (wc && !wc.isDestroyed() && /^https?:/i.test(wc.getURL())) return job.tabId
  const active = listTabs(job.windowId).find((t) => t.active)
  if (active) {
    const awc = getWebContentsByTabId(active.id)
    if (awc && !awc.isDestroyed() && /^https?:/i.test(awc.getURL())) return active.id
  }
  return null
}

async function runOnce(job: RepeatJob): Promise<void> {
  const tabId = resolveTabId(job)
  if (!tabId) { job.lastResult = '실행할 웹 페이지 탭이 없습니다(웹 페이지를 연 상태로 두세요)'; return }
  const reqId = randomUUID()
  runningReq.set(job.id, reqId)
  let confirmTimer: NodeJS.Timeout | null = null
  const clearCt = (): void => { if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null } }
  try {
    await runAgentTask({ reqId, tabId, task: job.task }, (evt: AgentEvent) => {
      repeatEvents.emit('event', { scheduleId: job.id, reqId, run: job.doneCount + 1, ...evt })
      switch (evt.type) {
        case 'confirm':
          clearCt()
          if (job.autoConfirm) confirmAgentStep(reqId, true)
          else confirmTimer = setTimeout(() => cancelAgentTask(reqId), CONFIRM_WAIT_MS)
          break
        case 'ask':
          cancelAgentTask(reqId) // 무인 반복은 질문에 답할 수 없음 → 이 실행 취소
          break
        case 'done': job.lastResult = String(evt.message ?? '완료'); clearCt(); break
        case 'error': job.lastResult = '오류: ' + String(evt.message ?? ''); clearCt(); break
        case 'cancelled': job.lastResult = job.autoConfirm ? '중단됨' : '민감 동작 확인 없음/질문으로 이번 실행 취소'; clearCt(); break
        default: break
      }
    })
  } catch (err) {
    // runAgentTask 가 던지면(예: 제공자 오류) 반복이 영구 동결되지 않도록 여기서 삼킨다.
    job.lastResult = '오류: ' + (err instanceof Error ? err.message : String(err))
  } finally {
    clearCt()
    runningReq.delete(job.id) // 성공·실패 무관하게 항상 정리 → stale reqId 로 잘못 취소되는 것 방지
  }
}

function scheduleNext(job: RepeatJob): void {
  if (job.status === 'stopped') return
  if (job.totalCount > 0 && job.doneCount >= job.totalCount) { job.status = 'finished'; job.nextAt = null; emitChanged(); return }
  job.status = 'waiting'
  job.nextAt = Date.now() + job.intervalMs
  emitChanged()
  timers.set(job.id, setTimeout(() => { void tick(job) }, job.intervalMs))
}

async function tick(job: RepeatJob): Promise<void> {
  if (job.status === 'stopped') return
  job.status = 'running'; job.nextAt = null; emitChanged()
  await runOnce(job)                 // 실행 완료까지 대기 — 절대 겹쳐 돌지 않음
  // await 동안 stopRepeat 로 상태가 바뀔 수 있어 TS 가 좁힌 타입을 무시하고 다시 읽는다.
  if ((job.status as RepeatJob['status']) === 'stopped') return
  job.doneCount += 1
  emitChanged()
  scheduleNext(job)
}

export function startRepeat(args: { task: string; windowId: string; tabId: string; intervalMinutes: number; count: number; autoConfirm?: boolean }): RepeatSummary | null {
  const task = String(args.task ?? '').trim()
  if (!task || !args.windowId || !args.tabId) return null
  const intervalMs = Math.max(MIN_INTERVAL_MS, Math.round((Number(args.intervalMinutes) || 1) * 60_000))
  const job: RepeatJob = {
    id: randomUUID(), task, windowId: args.windowId, tabId: args.tabId,
    intervalMs, totalCount: Math.max(0, Math.floor(Number(args.count) || 0)),
    doneCount: 0, autoConfirm: !!args.autoConfirm, status: 'running', nextAt: null, createdAt: Date.now(),
  }
  jobs.set(job.id, job)
  emitChanged()
  void tick(job) // 첫 실행 즉시
  return summaryOf(job)
}

export function stopRepeat(id: string): void {
  const job = jobs.get(id)
  if (!job) return
  job.status = 'stopped'; job.nextAt = null
  const t = timers.get(id); if (t) { clearTimeout(t); timers.delete(id) }
  const rid = runningReq.get(id); if (rid) cancelAgentTask(rid)
  emitChanged()
}

export function removeRepeat(id: string): void {
  stopRepeat(id)
  jobs.delete(id)
  emitChanged()
}
