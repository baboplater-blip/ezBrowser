import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { runAgentTask, cancelAgentTask, confirmAgentStep, type AgentEvent } from './agent'
import { getWebContentsByTabId, listTabs } from '../../tabs/tab-service'
import { createJsonStore, loadJsonObject } from './json-store'

// 에이전트 작업 자동 반복 — 저장/현재 작업을 일정 간격으로 반복 실행한다(무인).
// 안전: 무인 반복 중 게시·삭제 같은 민감 동작은 기본적으로 자동 승인하지 않는다.
// autoConfirm 를 켜지 않으면, 확인이 필요한 실행은 60초 뒤 그 실행만 취소한다(자동 실행 금지).
// ask(사용자 질문)도 무인에선 답할 수 없으므로 그 실행을 취소한다.
// 재시작 시에는 자동 부활하지 않는다(부팅 시 무인 에이전트 자동 실행은 위험 — 사용자가 다시 시작).
//
// 영속화: userData/ai-agent-schedule.json. 저장 기전(디바운스·원자적 쓰기·손상 복구)은
// json-store.ts 가 맡는다 — 그 파일의 머리말 참고.

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
  // 마지막으로 "실행을 시도"한 시각(성패 무관). 재시작 직후 재발화 억제(dedup)에 쓴다.
  lastRunAt?: number
  // true 면 이 stopped 상태가 "사용자가 멈춘 것"이 아니라 "브라우저 재시작으로 멈춘 것"임을 뜻한다.
  // UI 가 "다시 시작"을 안내할 근거로만 쓰는 표식 — 재개 동작 자체를 막지는 않는다.
  resumable?: boolean
}

export interface RepeatSummary {
  id: string; task: string; intervalMs: number; totalCount: number; doneCount: number
  autoConfirm: boolean; status: RepeatJob['status']; nextAt: number | null; lastResult?: string
  lastRunAt?: number; resumable?: boolean
}

// 최소 간격 — 예전 2초는 "0.05분·무제한" 같은 설정 하나로 2초마다 같은 글을 계속 게시하는 스팸 머신이 됐다.
// 계정 활동(게시·댓글·팔로우)은 더 긴 하한을 강제한다.
const MIN_INTERVAL_MS = 60_000
const MIN_INTERVAL_PUBLISH_MS = 10 * 60_000
// 계정 활동 반복은 하루 상한을 둔다(무제한 반복으로 계정이 잠기는 것 방지).
const MAX_PUBLISH_RUNS_PER_DAY = 24
const CONFIRM_WAIT_MS = 60_000
// 반복 작업 자체의 개수 상한 — 무한정 쌓여 파일이 비대해지거나 무인 작업이 통제 불능으로 늘어나는 것 방지.
const MAX_JOBS = 20
const FILE_NAME = 'ai-agent-schedule.json'

// 이 반복이 계정 활동(게시·댓글·팔로우·DM)인가 — 하한 간격·일일 상한 적용 여부.
function isAccountActivity(task: string): boolean {
  return /게시|발행|올리|업로드|댓글|답글|좋아요|팔로우|구독|공유|보내|전송|post|publish|upload|comment|follow|like|share|send|dm/i.test(task ?? '')
}

export const repeatEvents = new EventEmitter()
const jobs = new Map<string, RepeatJob>()
const timers = new Map<string, NodeJS.Timeout>()
const runningReq = new Map<string, string>()

let loaded = false
let quitHooked = false

const store = createJsonStore({
  fileName: FILE_NAME,
  label: '반복 작업',
  debounceMs: 400,
  snapshot: () => ({ version: 1, jobs: Array.from(jobs.values()) }),
})

function isValidJob(j: unknown): j is RepeatJob {
  if (!j || typeof j !== 'object') return false
  const o = j as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.task === 'string'
    && typeof o.windowId === 'string' && typeof o.tabId === 'string'
    && typeof o.intervalMs === 'number' && typeof o.totalCount === 'number'
    && typeof o.doneCount === 'number' && typeof o.autoConfirm === 'boolean'
    && typeof o.status === 'string' && typeof o.createdAt === 'number'
}

/**
 * 디스크에서 반복 작업 목록을 읽어 복원한다. `main` 진입이 다른 init 들과 같은 모양으로 호출하는 것을
 * 전제하지만, 혹시 그 배선이 빠지더라도 데이터가 조용히 무시되지 않도록 `ensureLoaded()` 가
 * 모든 진입점(export 함수)에서 지연 호출한다 — agent-runs.ts 의 `all()` 패턴과 동일.
 *
 * ⚠ 재시작 직후 즉시 재발화하지 않는 이유: 여기서 로드만 할 뿐 **timer 를 다시 걸지 않는다**.
 * 부팅 시 무인 에이전트가 스스로 페이지를 조작하기 시작하면(특히 running 이던 게시 작업), 사용자가
 * 화면을 보기도 전에 되돌릴 수 없는 동작이 일어날 수 있다. 그래서 running/waiting 이던 작업은
 * 전부 stopped 로 정리하고 `resumable` 표식만 남긴다 — 다시 시작하는 것은 항상 사용자의 명시적
 * 조작(resumeRepeat/startRepeat)이어야 한다.
 */
export function initAgentSchedule(): void {
  if (!quitHooked) { quitHooked = true; try { app.on('before-quit', flushAgentSchedule) } catch { /* ignore */ } }
  if (loaded) return
  loaded = true

  const raw = loadJsonObject(FILE_NAME, '반복 작업', 'jobs')
  if (!raw) return // 파일 없음(첫 실행) 또는 손상(loadJsonObject 가 이미 백업 남김) — 빈 상태로 시작

  const rawJobs = Array.isArray(raw.jobs) ? raw.jobs : []
  const validJobs = rawJobs.filter(isValidJob)
  store.reportDropped(rawJobs.length - validJobs.length, validJobs.length)

  for (const job of validJobs.slice(0, MAX_JOBS)) {
    if (job.status === 'running' || job.status === 'waiting') {
      job.status = 'stopped'
      job.nextAt = null
      job.resumable = true
      job.lastResult = '브라우저 재시작으로 중단됨 — 다시 시작하면 이어갑니다'
    }
    jobs.set(job.id, job)
  }
}

function ensureLoaded(): void {
  if (!loaded) initAgentSchedule()
}

export function flushAgentSchedule(): void {
  store.flush()
}

function summaryOf(j: RepeatJob): RepeatSummary {
  return {
    id: j.id, task: j.task, intervalMs: j.intervalMs, totalCount: j.totalCount, doneCount: j.doneCount,
    autoConfirm: j.autoConfirm, status: j.status, nextAt: j.nextAt, lastResult: j.lastResult,
    lastRunAt: j.lastRunAt, resumable: j.resumable,
  }
}
export function listRepeats(): RepeatSummary[] {
  ensureLoaded()
  return Array.from(jobs.values()).map(summaryOf)
}
// 저장(markDirty)을 emitChanged 한 곳에서만 트리거한다 — 상태를 바꾸는 모든 지점이 이미
// emitChanged 를 호출하므로, 여기 한 줄만 추가하면 저장 누락 지점이 생기지 않는다.
function emitChanged(): void {
  store.markDirty()
  repeatEvents.emit('changed', listRepeats())
}

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
    // unattended: 전역 "무인 실행 승인" 토글이 아니라 이 반복 작업의 autoConfirm 만 따른다.
    await runAgentTask({ reqId, tabId, task: job.task, unattended: true }, (evt: AgentEvent) => {
      repeatEvents.emit('event', { scheduleId: job.id, reqId, run: job.doneCount + 1, ...evt })
      switch (evt.type) {
        case 'confirm':
          clearCt()
          // critical(결제·삭제 등 되돌릴 수 없는 것)은 autoConfirm 이어도 자동 승인하지 않고 이번 실행을 중단한다.
          if (evt.critical) { job.lastResult = `안전 중단: ${String(evt.label ?? '되돌릴 수 없는 동작')}`.slice(0, 200); cancelAgentTask(reqId) }
          else if (job.autoConfirm) confirmAgentStep(reqId, true)
          else confirmTimer = setTimeout(() => cancelAgentTask(reqId), CONFIRM_WAIT_MS)
          break
        case 'ask':
          // 무인 반복은 질문에 답할 수 없다 — 왜 아무 일도 안 일어났는지 사용자가 바로 알 수 있게
          // "안전 중단"과 구분되는 사유를 남기고 이번 실행만 취소한다(반복 자체는 살아 있다).
          job.lastResult = `건너뜀: 사용자 답변이 필요합니다 — ${String(evt.message ?? '질문')}`.slice(0, 200)
          cancelAgentTask(reqId)
          break
        case 'done': job.lastResult = String(evt.message ?? '완료'); clearCt(); break
        // 단계 예산 소진 — 예전에는 agent.ts 가 done 을 보내 매 회차가 "완료"로 기록됐다.
        // 반복 작업은 매번 같은 지시를 새로 돌리므로(이어가기가 아니다) 이 회차는 미완으로 남긴다.
        case 'exhausted': job.lastResult = `미완료: ${String(evt.stepsUsed ?? '')}단계까지 진행했지만 끝내지 못했습니다`; clearCt(); break
        case 'error': job.lastResult = '오류: ' + String(evt.message ?? ''); clearCt(); break
        // 안전 중단(critical 거부)·질문 건너뜀 사유가 이미 기록돼 있으면 덮어쓰지 않는다.
        case 'cancelled':
          if (!job.lastResult?.startsWith('안전 중단') && !job.lastResult?.startsWith('건너뜀')) {
            job.lastResult = job.autoConfirm ? '중단됨' : '민감 동작 확인 없음으로 이번 실행 취소'
          }
          clearCt(); break
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
  job.status = 'running'; job.nextAt = null; job.resumable = false; emitChanged()
  await runOnce(job)                 // 실행 완료까지 대기 — 절대 겹쳐 돌지 않음
  // 성패·중단 여부와 무관하게 "시도했다" 시각을 남긴다 — 재시작 후 재개 시 이 값으로 간격을 다시 따진다.
  job.lastRunAt = Date.now()
  // await 동안 stopRepeat 로 상태가 바뀔 수 있어 TS 가 좁힌 타입을 무시하고 다시 읽는다.
  if ((job.status as RepeatJob['status']) === 'stopped') { emitChanged(); return }
  job.doneCount += 1
  emitChanged()
  scheduleNext(job)
}

/**
 * 작업을 "돌게" 만드는 유일한 진입점 — 새로 만들 때(startRepeat)와 재개할 때(resumeRepeat) 모두 여기를 거친다.
 *
 * ⚠ 재시작 직후 즉시 재발화하지 않는 이유(핵심): `lastRunAt` 이 있고 아직 `intervalMs` 가 안 지났으면
 * 남은 시간만큼 기다렸다가 tick 한다. 이게 없으면 "재시작 → 사용자가 반복 재개 → 몇 초 뒤 다시 재시작"을
 * 반복할 때마다 간격을 무시한 연타(중복 실행)가 된다 — 특히 게시 같은 계정 활동에서는 스팸으로 번진다.
 * 새로 만든 작업은 `lastRunAt` 이 없어 remaining=0 이 되므로 기존과 동일하게 즉시 첫 실행된다.
 *
 * tick() 의 `if (job.status === 'stopped') return` 가드를 안전하게 통과시키기 위해, 실행을 걸기
 * 직전에는 항상 상태를 'waiting' 으로 먼저 옮겨 둔다(실제 'running' 전이는 tick() 자신이 한다).
 */
function armJob(job: RepeatJob): void {
  const remaining = job.lastRunAt != null ? job.lastRunAt + job.intervalMs - Date.now() : 0
  job.status = 'waiting'
  if (remaining > 0) {
    job.nextAt = Date.now() + remaining
    emitChanged()
    timers.set(job.id, setTimeout(() => { void tick(job) }, remaining))
  } else {
    job.nextAt = null
    emitChanged()
    void tick(job)
  }
}

export function startRepeat(args: { task: string; windowId: string; tabId: string; intervalMinutes: number; count: number; autoConfirm?: boolean }): RepeatSummary | null {
  ensureLoaded()
  const task = String(args.task ?? '').trim()
  if (!task || !args.windowId || !args.tabId) return null
  if (jobs.size >= MAX_JOBS) return null // 상한 — 무한정 쌓이는 것 방지
  const activity = isAccountActivity(task)
  const floor = activity ? MIN_INTERVAL_PUBLISH_MS : MIN_INTERVAL_MS
  const intervalMs = Math.max(floor, Math.round((Number(args.intervalMinutes) || 1) * 60_000))
  // 무제한(0) 이어도 계정 활동이면 하루치 상한으로 잘라 스팸 판정·계정 정지를 막는다.
  const askedCount = Math.max(0, Math.floor(Number(args.count) || 0))
  const cappedCount = activity
    ? (askedCount === 0 ? MAX_PUBLISH_RUNS_PER_DAY : Math.min(askedCount, MAX_PUBLISH_RUNS_PER_DAY))
    : askedCount
  const job: RepeatJob = {
    id: randomUUID(), task, windowId: args.windowId, tabId: args.tabId,
    intervalMs, totalCount: cappedCount,
    doneCount: 0, autoConfirm: !!args.autoConfirm, status: 'waiting', nextAt: null, createdAt: Date.now(),
  }
  jobs.set(job.id, job)
  armJob(job) // 새 작업 — lastRunAt 이 없어 즉시 첫 실행(기존 동작과 동일)
  return summaryOf(job)
}

/**
 * 재시작으로(또는 사용자가) 멈춘 작업을 사용자가 명시적으로 다시 돌린다.
 * 부팅만으로는 절대 호출되지 않는다 — initAgentSchedule 은 이 함수를 부르지 않는다.
 */
export function resumeRepeat(id: string): RepeatSummary | null {
  ensureLoaded()
  const job = jobs.get(id)
  if (!job) return null
  if (job.status !== 'stopped') return summaryOf(job) // 이미 돌고 있거나(running/waiting) 끝남(finished)
  job.resumable = false // 사용자가 명시적으로 재개함 — 더는 "재시작으로 멈춤" 상태가 아니다
  armJob(job)
  return summaryOf(job)
}

export function stopRepeat(id: string): void {
  ensureLoaded()
  const job = jobs.get(id)
  if (!job) return
  job.status = 'stopped'; job.nextAt = null; job.resumable = false // 사용자가 직접 멈춘 것 — 재시작-중단과 구분
  const t = timers.get(id); if (t) { clearTimeout(t); timers.delete(id) }
  const rid = runningReq.get(id); if (rid) cancelAgentTask(rid)
  emitChanged()
}

export function removeRepeat(id: string): void {
  ensureLoaded()
  stopRepeat(id)
  jobs.delete(id)
  emitChanged()
}
