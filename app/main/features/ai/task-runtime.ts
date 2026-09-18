import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  cancelAgentTask, confirmAgentStep, pauseAgentTask, replyAgentAsk, resumeAgentTask, runAgentTask,
  type AgentEvent,
} from './agent'
import { isPublishAction } from './agent-gate'
import {
  getTab, getTabPartition, getWebContentsByTabId, listTabs, listTabsInWorkspace,
} from '../../tabs/tab-service'
import { createJsonStore, loadJsonObject } from './json-store'

/**
 * 영속 작업 런타임 — 에이전트 작업을 **구간(segment) 단위**로 쪼개 돌리고, 구간 경계마다
 * 체크포인트(압축 진행요약 + 완료 하위작업 + 탭/워크스페이스)를 디스크에 남긴다.
 *
 * 왜 이 파일이 생겼나 (2026-09-18 실측):
 *
 *  ① `agent.ts` 는 단일 for 루프(최대 80단계)였다. 문맥을 압축해 이어갈 수단이 없어 80단계가 하드 천장이었다.
 *  ② **단계를 다 쓰면 `done` 을 내보냈다** → 실행 이력에 실패가 ✅ 성공으로 남았다.
 *     여기서는 단계 소진(`exhausted`)을 절대 `completed` 로 승격하지 않는다. `interrupted`(이어가기 가능)다.
 *  ③ 재시작하면 작업이 소실됐다(체크포인트가 없어 이어갈 수도 없었다).
 *
 * 설계에서 물러서지 않는 두 가지:
 *
 *  - **부팅만으로 실행을 재개하지 않는다.** 재시작 시 살아 있던 작업은 `interrupted` 로 정리되고,
 *    사용자가 명시로 이어가야 한다. 부팅 한 번에 결제·게시가 일어나면 안 된다(T7·T8).
 *  - **"정확히 한 번"을 보장한다고 쓰지 않는다.** 발행성 동작 뒤 완료 근거가 없으면 자동 재실행하지 않고
 *    사용자에게 확인을 구한다(T13). 보장할 수 없는 것을 보장한다고 적는 것이 중복 게시보다 위험하다.
 */

// ===== 상수 =====

/** 한 구간에 허용하는 단계 수 — 이 경계에서 문맥을 압축하고 체크포인트를 남긴다. */
const SEGMENT_STEPS = 12
/** 보관 작업 수 상한. 초과 시 **끝난 작업만** 오래된 것부터 비운다(아래 pruneTasks 주석 참고). */
const MAX_TASKS = 50
/** 진행요약 상한 — 다음 구간 프롬프트에 주입되므로 무한정 키우면 문맥이 터진다. */
const MAX_PROGRESS_CHARS = 1200
/** 완료 하위작업 보관 수 상한. */
const MAX_DONE_SUBTASKS = 20
/** 외부 쓰기 원장 보관 수 상한(오래된 것부터 버린다 — 최근 것이 중복 방지에 쓰인다). */
const MAX_EXTERNAL_WRITES = 50
/** UI 목록에 싣는 지시 길이. */
const SUMMARY_INSTRUCTION_CHARS = 200

const FILE_NAME = 'ai-tasks.json'
const STORE_LABEL = '작업'

// 예산 기본값 — normal 은 "사용자가 보고 있는 한 번의 지시", long 은 "자리를 비운 사이 오래 도는 작업".
const DEFAULT_BUDGET = {
  normal: { maxSteps: 25, maxDurationMs: 30 * 60_000, maxLlmCalls: 200 },
  long: { maxSteps: 2000, maxDurationMs: 24 * 60 * 60_000, maxLlmCalls: 4000 },
} as const

// 예산 값의 안전 범위 — 손상된 저장 파일이나 잘못된 호출이 예산을 무력화(0·음수·무한)하지 못하게 한다.
const CLAMP = {
  steps: { min: 1, max: 100_000 },
  durationMs: { min: 60_000, max: 30 * 24 * 60 * 60_000 },
  llmCalls: { min: 1, max: 1_000_000 },
} as const

/**
 * 원인별 재시도 정책. **상한이 있다** — 무한 재시도는 조용히 구독 한도를 태우고 계정을 잠근다(T11).
 * 지연 배열의 길이가 곧 최대 재시도 횟수다.
 */
const BACKOFF_MS: Record<RetryKind, number[]> = {
  network: [2_000, 8_000, 30_000],
  'rate-limit': [60_000, 300_000, 900_000],
  // CLI 세션이 죽은 것은 즉시 한 번 다시 열어 보고, 안 되면 agent.ts 의 스텝별 폴백에 맡긴다.
  'cli-dead': [0],
  // 탭이 사라졌거나 로그인이 필요한 것은 **사람만** 해결할 수 있다 — 재시도 대신 대기한다.
  'tab-gone': [],
  login: [],
  model: [5_000, 15_000, 60_000],
  // 분류되지 않은 오류는 프로그래밍 결함일 수 있다. 한 번만 다시 해보고 멈춘다(상태는 보존).
  unknown: [10_000],
}

// ===== 타입 (design.md 1절 확정 인터페이스) =====

export type TaskState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'waiting-user'
  | 'retrying'
  | 'interrupted'
  | 'needs-verify'
  | 'completed' | 'failed' | 'cancelled'

export type RetryKind = 'network' | 'rate-limit' | 'cli-dead' | 'tab-gone' | 'login' | 'model' | 'unknown'

export interface TaskBudget {
  maxSteps: number
  maxDurationMs: number
  maxLlmCalls: number
  /** [] = 제한 없음. 있으면 그 호스트(및 서브도메인)만 이동 허용. */
  allowedHosts: string[]
}

export interface TaskCheckpoint {
  segment: number
  stepsUsed: number
  llmCalls: number
  progressSummary: string
  doneSubtasks: string[]
  tabUrl: string | null
  workspaceId: string | null
  windowId: string | null
  savedAt: number
}

export interface PersistentTask {
  id: string
  instruction: string
  state: TaskState
  mode: 'normal' | 'long'
  budget: TaskBudget
  checkpoint: TaskCheckpoint
  usage: { input: number; cacheRead: number; cacheCreate: number; output: number; llmCalls: number }
  resultFiles: string[]
  result?: string
  verifyEvidence?: string
  waitReason?: string
  retry?: { kind: RetryKind; attempt: number; nextAt: number; detail: string }
  readOnly: boolean
  incognito: boolean
  ownerWindowId: string | null
  externalWrites: Array<{ label: string; at: number; confirmed: boolean }>
  createdAt: number; updatedAt: number; startedAt: number; endedAt?: number
  elapsedMs: number
}

export interface TaskSummary {
  id: string; instruction: string; state: TaskState; mode: 'normal' | 'long'
  stepsUsed: number; maxSteps: number; segment: number
  elapsedMs: number; startedAt: number; endedAt?: number
  waitReason?: string; retry?: PersistentTask['retry']
  llmCalls: number; maxLlmCalls: number
  result?: string; resultFiles: string[]; needsVerify: boolean
}

/** 'changed'(TaskSummary[]) · 'event'({ taskId, ...AgentEvent }) */
export const taskEvents = new EventEmitter()

// ===== 휘발 상태 =====

/**
 * 디스크에 남기지 않는 실행 상태. **저장 타입(PersistentTask)에 섞지 않는다** —
 * 살아 있는 프로세스 핸들(reqId·타이머)이 스냅샷에 들어가면 재시작 후 그것이 유효한 것처럼 보인다.
 */
interface TaskRuntime {
  /** 지금 비행 중인 구간의 reqId(없으면 null). 확인·질문·일시정지를 그 구간에 전달할 때 쓴다. */
  reqId: string | null
  /**
   * 무엇을 기다리는가 — confirmTask/answerTask 가 올바른 상대에게 응답을 보내야 한다.
   * 'user-fix' = 사람만 풀 수 있는 것(탭 열기·로그인)을 처리한 뒤 계속하는 경우.
   */
  waitKind: 'agent-confirm' | 'agent-ask' | 'ledger' | 'user-fix' | null
  /** 구간 루프가 도는 중인가(중복 루프 방지). */
  loopActive: boolean
  /** 실행 시간 누적 시작 시각(0 = 누적 중지). */
  runningSince: number
  retryTimer: NodeJS.Timeout | null
  /**
   * **연속** 실패 횟수와 그 원인. 여기(휘발)에 두는 이유: 재시도 직전에 상태가 running 으로 바뀌며
   * 표시용 `task.retry` 가 지워진다. 그걸 카운터로 쓰면 매번 1로 되돌아가 **무한 재시도**가 된다
   * (backoff 사다리를 영원히 소진하지 못한다). 진척이 생기거나 사용자가 다시 시작하면 0으로 되돌린다.
   */
  retryKind: RetryKind | null
  retryCount: number
  /**
   * 이 세션에서 마지막으로 조작한 탭 id. **영속하지 않는다** — 재시작 후 옛 탭 id 를 그대로 믿으면
   * 그 번호가 전혀 다른 탭을 가리킬 수 있다(T9). 재시작 뒤에는 URL 로만 다시 찾는다.
   */
  lastTabId: string | null
}

const runtimes = new Map<string, TaskRuntime>()

function runtimeOf(id: string): TaskRuntime {
  let rt = runtimes.get(id)
  if (!rt) {
    rt = {
      reqId: null, waitKind: null, loopActive: false, runningSince: 0,
      retryTimer: null, retryKind: null, retryCount: 0, lastTabId: null,
    }
    runtimes.set(id, rt)
  }
  return rt
}

// ===== 저장 =====

let cache: Map<string, PersistentTask> | null = null
let quitHooked = false

const store = createJsonStore({
  fileName: FILE_NAME,
  label: STORE_LABEL,
  debounceMs: 400,
  // 시크릿 작업은 스냅샷에서 제외한다 — 디스크에 한 줄도 남기지 않는 것이 계약이다(S2).
  snapshot: () => ({ version: 1, tasks: all().filter((t) => !t.incognito) }),
})

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function strList(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, cap)
}

const TASK_STATES: ReadonlySet<string> = new Set<TaskState>([
  'queued', 'running', 'paused', 'waiting-user', 'retrying', 'interrupted',
  'needs-verify', 'completed', 'failed', 'cancelled',
])

function isTerminal(state: TaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}

/**
 * 저장 파일의 항목 하나를 복원한다.
 *
 * json-store 는 "최상위가 객체이고 tasks 가 배열인가"까지만 본다. 항목의 **모양은 여기서 검증**해야 한다 —
 * 예산·상태처럼 안전에 쓰이는 값이 손상 파일에서 `null`/문자열/객체로 들어오면, 검사가 통째로 무력해진다.
 * 핵심 식별자(id·instruction)가 없으면 버리고, 나머지는 안전한 기본값으로 메운다.
 */
function reviveTask(raw: unknown): PersistentTask | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const id = str(o.id)
  const instruction = str(o.instruction)
  if (!id || !instruction) return null

  const mode: 'normal' | 'long' = o.mode === 'long' ? 'long' : 'normal'
  const defaults = DEFAULT_BUDGET[mode]
  const rawBudget = (o.budget && typeof o.budget === 'object' ? o.budget : {}) as Record<string, unknown>
  const budget: TaskBudget = {
    maxSteps: clamp(num(rawBudget.maxSteps, defaults.maxSteps), CLAMP.steps.min, CLAMP.steps.max),
    maxDurationMs: clamp(num(rawBudget.maxDurationMs, defaults.maxDurationMs), CLAMP.durationMs.min, CLAMP.durationMs.max),
    maxLlmCalls: clamp(num(rawBudget.maxLlmCalls, defaults.maxLlmCalls), CLAMP.llmCalls.min, CLAMP.llmCalls.max),
    allowedHosts: strList(rawBudget.allowedHosts, 200),
  }

  const rawCp = (o.checkpoint && typeof o.checkpoint === 'object' ? o.checkpoint : {}) as Record<string, unknown>
  const checkpoint: TaskCheckpoint = {
    segment: Math.max(0, Math.round(num(rawCp.segment))),
    stepsUsed: Math.max(0, Math.round(num(rawCp.stepsUsed))),
    llmCalls: Math.max(0, Math.round(num(rawCp.llmCalls))),
    progressSummary: str(rawCp.progressSummary).slice(0, MAX_PROGRESS_CHARS),
    doneSubtasks: strList(rawCp.doneSubtasks, MAX_DONE_SUBTASKS),
    tabUrl: typeof rawCp.tabUrl === 'string' ? rawCp.tabUrl : null,
    workspaceId: typeof rawCp.workspaceId === 'string' ? rawCp.workspaceId : null,
    windowId: typeof rawCp.windowId === 'string' ? rawCp.windowId : null,
    savedAt: num(rawCp.savedAt),
  }

  const rawUsage = (o.usage && typeof o.usage === 'object' ? o.usage : {}) as Record<string, unknown>
  const createdAt = num(o.createdAt, Date.now())
  const rawWrites = Array.isArray(o.externalWrites) ? o.externalWrites : []

  return {
    id,
    instruction,
    state: TASK_STATES.has(str(o.state)) ? (o.state as TaskState) : 'interrupted',
    mode,
    budget,
    checkpoint,
    usage: {
      input: Math.max(0, num(rawUsage.input)),
      cacheRead: Math.max(0, num(rawUsage.cacheRead)),
      cacheCreate: Math.max(0, num(rawUsage.cacheCreate)),
      output: Math.max(0, num(rawUsage.output)),
      llmCalls: Math.max(0, Math.round(num(rawUsage.llmCalls))),
    },
    resultFiles: strList(o.resultFiles, 100),
    ...(typeof o.result === 'string' ? { result: o.result } : {}),
    ...(typeof o.verifyEvidence === 'string' ? { verifyEvidence: o.verifyEvidence } : {}),
    ...(typeof o.waitReason === 'string' ? { waitReason: o.waitReason } : {}),
    readOnly: o.readOnly === true,
    // 시크릿 작업은 애초에 저장되지 않는다. 파일에 있다면 과거 결함의 흔적이므로 그대로 믿지 않는다.
    incognito: false,
    ownerWindowId: typeof o.ownerWindowId === 'string' ? o.ownerWindowId : null,
    externalWrites: rawWrites
      .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
      .map((w) => ({ label: str(w.label), at: num(w.at), confirmed: w.confirmed === true }))
      .filter((w) => w.label.length > 0)
      .slice(-MAX_EXTERNAL_WRITES),
    createdAt,
    updatedAt: num(o.updatedAt, createdAt),
    startedAt: num(o.startedAt, createdAt),
    ...(typeof o.endedAt === 'number' && Number.isFinite(o.endedAt) ? { endedAt: o.endedAt } : {}),
    elapsedMs: Math.max(0, num(o.elapsedMs)),
  }
}

export function initTaskRuntime(): void {
  if (!quitHooked) { quitHooked = true; try { app.on('before-quit', flushTasks) } catch { /* ignore */ } }
  if (cache !== null) return

  cache = new Map()
  const raw = loadJsonObject(FILE_NAME, STORE_LABEL, 'tasks')
  if (!raw) return

  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : []
  let kept = 0
  for (const item of rawTasks) {
    const task = reviveTask(item)
    if (!task) continue
    // 재시작은 곧 "돌던 구간이 통째로 사라졌다" 는 뜻이다. 실행/재시도/대기 중이던 것은 모두
    // 이어가기 가능한 interrupted 로 정리하고, **자동으로 되살리지 않는다**(T7·T8).
    // 특히 waiting-user 를 running 으로 되돌리면 재시작 한 번이 확인 없는 승인이 된다.
    if (task.state === 'running' || task.state === 'retrying' || task.state === 'waiting-user') {
      task.state = 'interrupted'
      task.waitReason = '재시작으로 중단됐습니다 — 이어서 진행할 수 있습니다.'
      delete task.retry
    }
    cache.set(task.id, task)
    kept++
  }
  store.reportDropped(rawTasks.length - kept, kept)
}

function all(): PersistentTask[] {
  if (cache === null) initTaskRuntime()
  return Array.from((cache ?? new Map<string, PersistentTask>()).values())
}

function tasksMap(): Map<string, PersistentTask> {
  if (cache === null) initTaskRuntime()
  return cache ?? new Map<string, PersistentTask>()
}

/** 시크릿 작업의 변경은 저장할 것이 없다 — 디스크를 건드리지 않는다. */
function markDirty(task: PersistentTask): void {
  if (!task.incognito) store.markDirty()
}

export function flushTasks(): void {
  store.flush()
}

// ===== 목록·이벤트 =====

function summaryOf(t: PersistentTask): TaskSummary {
  return {
    id: t.id,
    instruction: t.instruction.slice(0, SUMMARY_INSTRUCTION_CHARS),
    state: t.state,
    mode: t.mode,
    stepsUsed: t.checkpoint.stepsUsed,
    maxSteps: t.budget.maxSteps,
    segment: t.checkpoint.segment,
    elapsedMs: elapsedOf(t),
    startedAt: t.startedAt,
    ...(t.endedAt !== undefined ? { endedAt: t.endedAt } : {}),
    ...(t.waitReason !== undefined ? { waitReason: t.waitReason } : {}),
    ...(t.retry !== undefined ? { retry: t.retry } : {}),
    llmCalls: t.usage.llmCalls,
    maxLlmCalls: t.budget.maxLlmCalls,
    ...(t.result !== undefined ? { result: t.result } : {}),
    resultFiles: [...t.resultFiles],
    needsVerify: t.state === 'needs-verify',
  }
}

export function listTasks(): TaskSummary[] {
  return all().sort((a, b) => b.createdAt - a.createdAt).map(summaryOf)
}

export function getTask(id: string): PersistentTask | null {
  return tasksMap().get(id) ?? null
}

function emitChanged(): void {
  taskEvents.emit('changed', listTasks())
}

/**
 * 실제로 **실행에 쓴** 시간. 일시정지뿐 아니라 확인 대기·재시도 대기도 제외한다 —
 * 사용자가 답을 주기까지 두 시간이 흘렀다고 해서 작업의 실행 예산이 사라져선 안 된다.
 * (runningSince 는 state === 'running' 인 동안에만 켜진다.)
 */
function elapsedOf(t: PersistentTask): number {
  const rt = runtimes.get(t.id)
  const live = rt && rt.runningSince ? Date.now() - rt.runningSince : 0
  return t.elapsedMs + Math.max(0, live)
}

/** 상태 전환의 단일 통로 — 실행 시간 누적·종료 시각·저장·알림을 한자리에서 처리한다. */
function setState(task: PersistentTask, next: TaskState, waitReason?: string): void {
  const rt = runtimeOf(task.id)
  if (task.state === 'running' && rt.runningSince) {
    task.elapsedMs += Math.max(0, Date.now() - rt.runningSince)
    rt.runningSince = 0
  }
  task.state = next
  if (next === 'running') {
    rt.runningSince = Date.now()
    delete task.waitReason
    delete task.retry   // 표시용 기록만 지운다. 연속 실패 카운터는 runtime 에 있다(위 주석 참고).
    // ⚠ waitKind 는 여기서 지우지 않는다. 일시정지와 확인 요청이 겹친 뒤 재개하면 "무엇을 기다렸는지"가
    //   사라져, 에이전트는 확인을 기다리는데 응답을 보낼 상대를 잃는 교착이 된다.
    //   waitKind 는 응답을 실제로 전달한 자리(confirmTask·answerTask)와 구간 종료·종료 상태에서만 지운다.
  }
  if (waitReason !== undefined) task.waitReason = waitReason
  if (isTerminal(next)) {
    task.endedAt = Date.now()
    rt.waitKind = null
  }
  task.updatedAt = Date.now()
  markDirty(task)
  emitChanged()
}

/**
 * 보관 상한 정리. **끝난 작업만** 비운다 — 돌고 있는 작업을 목록에서 빼면 그 구간 루프가
 * 지도에 없는 객체를 붙들고 계속 돌아, 상태는 사라졌는데 페이지는 조작되는 최악의 상태가 된다.
 */
function pruneTasks(): void {
  const map = tasksMap()
  if (map.size <= MAX_TASKS) return
  const removable = Array.from(map.values())
    .filter((t) => isTerminal(t.state) || t.state === 'needs-verify')
    .sort((a, b) => a.createdAt - b.createdAt)
  for (const t of removable) {
    if (map.size <= MAX_TASKS) break
    map.delete(t.id)
    runtimes.delete(t.id)
  }
}

// ===== 생성 =====

export function createTask(args: {
  instruction: string; tabId: string; windowId: string | null
  mode?: 'normal' | 'long'; readOnly?: boolean; incognito?: boolean
  budget?: Partial<TaskBudget>
}): TaskSummary | null {
  const instruction = str(args.instruction).trim()
  if (!instruction) return null   // 빈 지시로는 작업을 만들지 않는다(T1 부정 사례)

  const mode: 'normal' | 'long' = args.mode === 'long' ? 'long' : 'normal'
  const defaults = DEFAULT_BUDGET[mode]
  const b = args.budget ?? {}
  const budget: TaskBudget = {
    maxSteps: clamp(num(b.maxSteps, defaults.maxSteps), CLAMP.steps.min, CLAMP.steps.max),
    maxDurationMs: clamp(num(b.maxDurationMs, defaults.maxDurationMs), CLAMP.durationMs.min, CLAMP.durationMs.max),
    maxLlmCalls: clamp(num(b.maxLlmCalls, defaults.maxLlmCalls), CLAMP.llmCalls.min, CLAMP.llmCalls.max),
    allowedHosts: strList(b.allowedHosts, 200),
  }

  // 시작 탭은 "id" 가 아니라 **URL + 워크스페이스**로 기억한다. 재시작 뒤 옛 탭 id 는 다른 탭을
  // 가리킬 수 있어서다(T9). id 는 이 세션 동안만 runtime.lastTabId 로 들고 간다.
  const tabId = str(args.tabId)
  const tab = tabId ? getTab(tabId) : null
  const wc = tabId ? getWebContentsByTabId(tabId) : null
  const tabUrl = wc && !wc.isDestroyed() ? wc.getURL() : (tab?.url ?? '')
  const now = Date.now()

  const task: PersistentTask = {
    id: randomUUID(),
    instruction,
    state: 'queued',   // 실행은 startTask 가 시작한다 — 만들기와 시작을 분리해 두 번 돌지 않게 한다.
    mode,
    budget,
    checkpoint: {
      segment: 0, stepsUsed: 0, llmCalls: 0,
      progressSummary: '', doneSubtasks: [],
      tabUrl: tabUrl || null,
      workspaceId: tab?.workspaceId ?? null,
      windowId: args.windowId ?? tab?.windowId ?? null,
      savedAt: now,
    },
    usage: { input: 0, cacheRead: 0, cacheCreate: 0, output: 0, llmCalls: 0 },
    resultFiles: [],
    readOnly: args.readOnly === true,
    incognito: args.incognito === true,
    ownerWindowId: args.windowId ?? tab?.windowId ?? null,
    externalWrites: [],
    createdAt: now, updatedAt: now, startedAt: now,
    elapsedMs: 0,
  }

  tasksMap().set(task.id, task)
  const rt = runtimeOf(task.id)
  rt.lastTabId = tabId || null
  pruneTasks()
  markDirty(task)
  emitChanged()
  return summaryOf(task)
}

export function deleteTask(id: string): void {
  const task = getTask(id)
  if (!task) return
  stopEverything(task)
  tasksMap().delete(id)
  runtimes.delete(id)
  markDirty(task)
  emitChanged()
}

// ===== 탭 재바인딩 (design.md 3절) =====

/** 시크릿 탭인가 — 파티션 이름으로 판정한다(tab-service 가 쓰는 것과 같은 규칙). */
function isIncognitoTab(tabId: string): boolean {
  return (getTabPartition(tabId) ?? '').startsWith('incognito')
}

/** 조작 가능한 웹 페이지 탭인가(살아 있고 http/https). */
function usableTab(tabId: string): boolean {
  const wc = getWebContentsByTabId(tabId)
  return !!wc && !wc.isDestroyed() && /^https?:/i.test(wc.getURL())
}

function currentUrlOf(tabId: string): string {
  const wc = getWebContentsByTabId(tabId)
  return wc && !wc.isDestroyed() ? wc.getURL() : ''
}

// 광고·분석 추적 파라미터 — 같은 페이지인데 이것만 붙는 경우가 많아 비교에서 제외한다.
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|igshid$|mc_cid$|mc_eid$|ref$|ref_src$|_ga$|yclid$|msclkid$|si$)/i

/** 비교용 질의문자열 — 추적 파라미터를 걷어내고 키 순으로 정렬해 정규화한다. */
function meaningfulQuery(u: URL): string {
  const keys: string[] = []
  for (const [k, v] of u.searchParams) {
    if (TRACKING_PARAMS.test(k)) continue
    keys.push(`${k}=${v}`)
  }
  return keys.sort().join('&')
}

/**
 * 같은 대상 페이지인가 — 호스트 + 경로 + **의미 있는 질의문자열**을 본다.
 *
 * ⚠ 예전에는 질의문자열을 통째로 무시했다. 그러면 질의문자열이 **대상의 정체**인 사이트에서
 *    엉뚱한 대상에 작업이 붙는다: `youtube.com/watch?v=A` 와 `?v=B` 가 같다고 판정되고,
 *    `mail/u/0/?compose=X`·게시물 id 가 쿼리인 CMS 도 마찬가지다. 발행·결제 작업이면 사고다.
 *    반대로 전부 엄격히 비교하면 `?utm_source=...` 가 붙은 것만으로 "다른 페이지" 가 되므로,
 *    추적 파라미터는 걷어내고 나머지만 비교한다.
 *    체크포인트 쪽에 질의문자열이 없으면(그 페이지는 쿼리로 식별되지 않는다는 뜻) 대상 쪽 쿼리는 무시한다.
 */
function sameTarget(a: string | null, b: string): boolean {
  if (!a || !b) return false
  try {
    const x = new URL(a), y = new URL(b)
    if (x.hostname.toLowerCase() !== y.hostname.toLowerCase()) return false
    if (x.pathname !== y.pathname) return false
    const qx = meaningfulQuery(x)
    if (!qx) return true          // 기준 URL 이 쿼리로 식별되지 않으면 경로까지 같으면 같은 대상
    return qx === meaningfulQuery(y)
  } catch { return false }
}

/** 같은 호스트인가 — 사이트 내 리다이렉트(세션 갱신 등)를 흡수하는 완화 단계. */
function sameHost(a: string | null, b: string): boolean {
  if (!a || !b) return false
  try { return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase() } catch { return false }
}

type TabBinding = { tabId: string; note: string | null } | { tabId: null; reason: string }

/**
 * 이 작업이 조작할 탭을 지금 다시 찾는다.
 *
 * 개인정보 경계를 **양방향으로** 지킨다: 일반 작업은 시크릿 탭으로 넘어가지 않고, 시크릿 작업도
 * 일반(영속 세션) 탭으로 내려오지 않는다. 어느 쪽이든 넘어가면 사용자가 분리해 둔 흔적이 섞인다.
 * 워크스페이스도 마찬가지로 넘지 않는다 — 찾지 못하면 조용히 남의 탭을 쓰는 대신 사용자에게 묻는다.
 */
function resolveTaskTab(task: PersistentTask): TabBinding {
  const windowId = task.checkpoint.windowId ?? task.ownerWindowId
  if (!windowId) return { tabId: null, reason: '작업할 창을 찾을 수 없습니다 — 창에서 다시 시작해 주세요.' }

  const wsId = task.checkpoint.workspaceId
  const candidates = (wsId ? listTabsInWorkspace(windowId, wsId) : listTabs(windowId))
    .filter((t) => isIncognitoTab(t.id) === task.incognito && usableTab(t.id))

  if (candidates.length === 0) {
    return { tabId: null, reason: '작업할 탭을 열어주세요 — 작업하던 페이지가 닫혔습니다.' }
  }

  // ① 체크포인트의 URL 과 같은 페이지. 이 세션에서 쓰던 탭이 그중에 있으면 그것을 우선한다
  //    (같은 호스트 탭이 여러 개일 때 사용자가 고른 탭을 유지하려고).
  const onTarget = candidates.filter((t) => sameTarget(task.checkpoint.tabUrl, currentUrlOf(t.id)))
  if (onTarget.length > 0) {
    const rt = runtimeOf(task.id)
    const preferred = onTarget.find((t) => t.id === rt.lastTabId) ?? onTarget[0]
    if (preferred) return { tabId: preferred.id, note: null }
  }

  // ② 같은 호스트의 탭. 사이트 안에서 리다이렉트(세션 갱신·로그인 후 복귀)된 경우를 흡수한다.
  if (task.checkpoint.tabUrl) {
    const sameSite = candidates.filter((t) => sameHost(task.checkpoint.tabUrl, currentUrlOf(t.id)))
    const pick = sameSite.find((t) => t.id === runtimeOf(task.id).lastTabId) ?? sameSite.find((t) => t.active) ?? sameSite[0]
    if (pick) {
      return { tabId: pick.id, note: `같은 사이트의 다른 페이지에서 재개: 이전 ${task.checkpoint.tabUrl} → 현재 ${currentUrlOf(pick.id)}` }
    }
    // ③ 작업하던 페이지가 아예 없다. **페이지를 바꾸는 작업이면 조용히 다른 사이트에 붙이지 않는다** —
    //    예전에는 활성 탭으로 그냥 재바인딩해, "결제하기를 눌러라" 작업이 무관한 페이지에서 예산을
    //    전부 태우거나 최악엔 엉뚱한 대상에 작용할 수 있었다(하네스 실측). 읽기 전용은 부작용이
    //    없으니 재바인딩을 허용하고, 그 외에는 사용자에게 묻는다.
    if (!task.readOnly) {
      return {
        tabId: null,
        reason: `작업하던 페이지(${task.checkpoint.tabUrl})가 열려 있지 않습니다 — 그 페이지를 다시 열고 이어가 주세요.`
          + ' (다른 페이지에서 그대로 진행하면 엉뚱한 대상에 작업할 수 있어 멈췄습니다.)',
      }
    }
  }

  // ④ 읽기 전용이거나 체크포인트 URL 이 없는 첫 구간 — 활성 탭에서 진행하고 그 사실을 요약에 남긴다.
  const active = candidates.find((t) => t.active) ?? candidates[0]
  if (!active) return { tabId: null, reason: '작업할 탭을 열어주세요 — 작업하던 페이지가 닫혔습니다.' }
  const url = currentUrlOf(active.id)
  const note = task.checkpoint.tabUrl
    ? `다른 페이지에서 재개: 이전 ${task.checkpoint.tabUrl} → 현재 ${url}`
    : null
  return { tabId: active.id, note }
}

// ===== 예산·원장 =====

function budgetExceeded(task: PersistentTask): string | null {
  const { budget, checkpoint } = task
  if (checkpoint.stepsUsed >= budget.maxSteps) {
    return `단계 예산(${budget.maxSteps}단계)을 모두 사용했습니다.`
  }
  if (elapsedOf(task) >= budget.maxDurationMs) {
    return `실행 시간 예산(${Math.round(budget.maxDurationMs / 60_000)}분)을 모두 사용했습니다.`
  }
  // llmCalls 는 `usage` 이벤트를 센 값이다. agent.ts 는 **모델을 실제로 부른 모든 경로**에서
  // usage 를 내보내므로(토큰을 못 받는 tool-use 경로도 `{type:'usage', step}` 만이라도 보낸다)
  // 제공자와 무관하게 이 검사가 발동한다. 토큰 합계는 제공자가 알려줄 때만 누적된다 —
  // 세지 못한 토큰을 0으로 채워 사용량 표시를 거짓으로 만들지 않는다.
  if (task.usage.llmCalls >= budget.maxLlmCalls) {
    return `모델 호출 예산(${budget.maxLlmCalls}회)을 모두 사용했습니다.`
  }
  return null
}

/**
 * 발행성 동작을 원장에 남긴다. 목적은 "정확히 한 번" 보장이 아니라 **모르는 채로 또 누르지 않기**다.
 * 완료 근거를 못 본 채 다음 구간을 시작하면 같은 글을 두 번 올릴 수 있다 → 구간 시작 전에 막는다.
 */
function recordExternalWrite(task: PersistentTask, label: string): void {
  const trimmed = label.trim().slice(0, 120)
  if (!trimmed) return
  task.externalWrites.push({ label: trimmed, at: Date.now(), confirmed: false })
  if (task.externalWrites.length > MAX_EXTERNAL_WRITES) {
    task.externalWrites.splice(0, task.externalWrites.length - MAX_EXTERNAL_WRITES)
  }
  task.updatedAt = Date.now()
  markDirty(task)
}

/** 결과 파일 누적(중복 제거). 보고서·다운로드 경로는 완료 근거로도 쓰인다. */
function addResultFiles(task: PersistentTask, paths: string[]): void {
  let changed = false
  for (const p of paths) {
    if (!p || task.resultFiles.includes(p)) continue
    task.resultFiles.push(p)
    changed = true
  }
  if (changed) {
    if (task.resultFiles.length > 100) task.resultFiles.splice(0, task.resultFiles.length - 100)
    task.updatedAt = Date.now()
    markDirty(task)
  }
}

function pendingExternalWrite(task: PersistentTask): { label: string; at: number; confirmed: boolean } | null {
  for (let i = task.externalWrites.length - 1; i >= 0; i--) {
    const w = task.externalWrites[i]
    if (w && !w.confirmed) return w
  }
  return null
}

function confirmExternalWrites(task: PersistentTask): void {
  let changed = false
  for (const w of task.externalWrites) {
    if (!w.confirmed) { w.confirmed = true; changed = true }
  }
  if (changed) { task.updatedAt = Date.now(); markDirty(task) }
}

// ===== 오류 분류 =====

/**
 * 오류 문구로 원인을 나눈다. 문구는 `agent.ts` 의 `friendlyError` 와 `providers.ts` 가 실제로 내보내는
 * 것에 맞춘다 — 여기서 추측한 문구로 맞추면 분기가 전부 unknown 으로 떨어져 정책이 죽는다.
 */
export function classifyRetry(message: string): RetryKind {
  const m = str(message).toLowerCase()
  if (!m) return 'unknown'
  // 한도 초과는 네트워크 오류보다 먼저 본다(둘 다 "잠시 후 다시" 류 문구를 갖는다).
  if (/429|한도 초과|rate ?limit|too many requests|quota/.test(m)) return 'rate-limit'
  // CLI 세션 종료 — providers.ts 의 CliSessionDead 메시지.
  if (/세션이 종료|clisessiondead|session (ended|closed|terminated)/.test(m)) return 'cli-dead'
  if (/탭을 찾을 수 없|닫혔을 수 있음|http\/https\)에서만|페이지를 관찰하지 못/.test(m)) return 'tab-gone'
  // 제공자 인증 실패도, 사이트 로그인 만료도 결국 사람이 처리해야 한다 → 같은 'login' 으로 묶고
  // 대기 문구만 아래 waitMessageFor 에서 갈라 쓴다.
  if (/인증에 실패|api key|unauthorized|401|403|로그인(이)? (필요|만료)|sign in|log ?in required|session expired/.test(m)) return 'login'
  if (/econnrefused|enotfound|etimedout|socket hang up|fetch failed|network|연결하지 못|시간 초과|timeout/.test(m)) return 'network'
  if (/모델을 찾을 수 없|없는 모델|not found|이해하지 못|model/.test(m)) return 'model'
  return 'unknown'
}

/** 사람이 처리해야 하는 원인(tab-gone·login)의 대기 문구. */
function waitMessageFor(kind: RetryKind, detail: string): string {
  if (kind === 'tab-gone') return `탭을 다시 열어주세요 — ${detail}`
  if (/인증에 실패|api key|401|403/i.test(detail)) {
    return `AI 인증에 실패했습니다 — 설정 > AI 에서 키·로그인 상태를 확인한 뒤 이어서 진행해 주세요. (${detail})`
  }
  return `로그인해 주세요 — 로그인 후 이어서 진행할 수 있습니다. (${detail})`
}

// ===== 구간 실행 =====

interface SegmentOutcome {
  kind: 'done' | 'exhausted' | 'error' | 'cancelled' | 'none'
  message?: string
  evidence?: string
}

interface SegmentTrace {
  /** 이 구간에서 관찰된 마지막 누적 단계 번호 — 구간이 오류로 끊겨도 쓴 단계를 회계에 반영한다. */
  lastStep: number
  exhausted: {
    stepsUsed: number; progressSummary: string; doneSubtasks: string[]; tabUrl: string
    files: string[]
    /**
     * 발행을 눌렀는데 완료 신호를 못 봤는가. `agent.ts` 가 실제 클릭 수와 완료 신호를 직접 세어 주는 값이라,
     * 라벨 문구 추측(isPublishAction)보다 정확하다 — 예컨대 "저장하기" 는 발행 정규식에 걸리지만
     * 임시저장일 뿐이어서, 라벨만 믿으면 멀쩡한 작업이 "발행됐는지 모르겠다" 로 멈춰 선다.
     */
    publishPending: boolean
  } | null
}

/**
 * 완료 근거를 판정한다.
 *
 * ⚠ `done` 이벤트의 `shot`(스크린샷)은 **근거로 쓰지 않는다**. `agent.ts` 는 단계 소진이든 성공이든
 * 웹 콘텐츠가 살아 있으면 항상 스크린샷을 붙이므로, 그것을 근거로 인정하면 "증거 없는 done" 이
 * 존재할 수 없게 되어 완료 검증(T4)이 그냥 통과 도장이 된다.
 */
function evidenceOf(task: PersistentTask, evt: AgentEvent): string | null {
  const explicit = str(evt.evidence).trim()
  if (explicit) return explicit.slice(0, 500)
  if (task.resultFiles.length > 0) {
    const last = task.resultFiles[task.resultFiles.length - 1] ?? ''
    return `결과 파일 ${task.resultFiles.length}개 저장 (${last})`
  }
  // 읽기 전용 작업은 페이지를 바꾸지 않는다 — 확인할 "외부 결과" 자체가 없으므로 근거를 요구하지 않는다.
  if (task.readOnly) return '읽기 전용 작업 — 결과는 대화·트레이스에 있습니다.'
  return null
}

function onSegmentEvent(task: PersistentTask, evt: AgentEvent, box: { outcome: SegmentOutcome }, trace: SegmentTrace): void {
  // 라이브 트레이스는 상태와 무관하게 흘려보낸다(UI 가 진행을 보여야 한다).
  taskEvents.emit('event', { taskId: task.id, ...evt })

  // 취소·삭제된 뒤 늦게 도착한 이벤트가 상태를 뒤집지 못하게 한다 — 특히 늦은 done 이
  // cancelled 를 completed 로 만드는 것을 막는다(T6 부정 사례).
  if (isTerminal(task.state)) return

  const rt = runtimeOf(task.id)
  switch (evt.type) {
    case 'observe': {
      const step = Math.round(num(evt.step))
      if (step > trace.lastStep) trace.lastStep = step
      return
    }
    case 'usage': {
      const u = task.usage
      u.input += Math.max(0, num(evt.input))
      u.cacheRead += Math.max(0, num(evt.cacheRead))
      u.cacheCreate += Math.max(0, num(evt.cacheCreate))
      u.output += Math.max(0, num(evt.output))
      u.llmCalls++
      markDirty(task)
      return
    }
    case 'report': {
      addResultFiles(task, [str(evt.path)])
      return
    }
    case 'action': {
      const label = str(evt.label)
      if (isPublishAction(label)) recordExternalWrite(task, label)
      return
    }
    // waitKind 는 setState **전에** 정한다 — 'changed' 를 받은 쪽이 곧바로 confirmTask 를 불러도
    // 기다리는 대상이 이미 지정돼 있어야 응답이 엉뚱한 곳으로 가지 않는다.
    case 'confirm': {
      rt.waitKind = 'agent-confirm'
      setState(task, 'waiting-user', `확인이 필요합니다: ${str(evt.label, '되돌릴 수 없는 동작')}`)
      return
    }
    case 'ask': {
      rt.waitKind = 'agent-ask'
      setState(task, 'waiting-user', str(evt.message, '추가 정보가 필요합니다.'))
      return
    }
    case 'answer': {
      if (task.state === 'waiting-user') setState(task, 'running')
      return
    }
    case 'exhausted': {
      trace.exhausted = {
        stepsUsed: Math.round(num(evt.stepsUsed)),
        progressSummary: str(evt.progressSummary),
        doneSubtasks: strList(evt.doneSubtasks, MAX_DONE_SUBTASKS),
        tabUrl: str(evt.tabUrl),
        files: strList(evt.files, 100),
        publishPending: evt.publishPending === true,
      }
      box.outcome = { kind: 'exhausted' }
      return
    }
    case 'done': {
      const evidence = evidenceOf(task, evt)
      box.outcome = {
        kind: 'done',
        message: str(evt.message, '완료'),
        ...(evidence ? { evidence } : {}),
      }
      return
    }
    case 'error': {
      box.outcome = { kind: 'error', message: str(evt.message, '알 수 없는 오류') }
      return
    }
    case 'cancelled': {
      box.outcome = { kind: 'cancelled' }
      return
    }
    default: return
  }
}

async function runSegment(task: PersistentTask, tabId: string, stepBudget: number): Promise<{ outcome: SegmentOutcome; trace: SegmentTrace }> {
  const rt = runtimeOf(task.id)
  const reqId = randomUUID()
  rt.reqId = reqId
  rt.lastTabId = tabId

  const box: { outcome: SegmentOutcome } = { outcome: { kind: 'none' } }
  const trace: SegmentTrace = { lastStep: task.checkpoint.stepsUsed, exhausted: null }

  try {
    await runAgentTask({
      reqId,
      tabId,
      task: task.instruction,
      readOnly: task.readOnly,
      // 누적 단계 번호를 이어 준다 — 사용자·모델이 "몇 단계째인지" 를 구간 경계와 무관하게 본다.
      startStep: task.checkpoint.stepsUsed + 1,
      stepBudget,
      resumeContext: {
        progressSummary: task.checkpoint.progressSummary,
        doneSubtasks: [...task.checkpoint.doneSubtasks],
      },
      allowedHosts: [...task.budget.allowedHosts],
    }, (evt: AgentEvent) => onSegmentEvent(task, evt, box, trace))
  } catch (err) {
    // runAgentTask 가 던지면(제공자 오류 등) 루프가 영구 동결되지 않도록 여기서 오류 결과로 바꾼다.
    box.outcome = { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  } finally {
    rt.reqId = null
    if (rt.waitKind === 'agent-confirm' || rt.waitKind === 'agent-ask') rt.waitKind = null
  }
  return { outcome: box.outcome, trace }
}

// ===== 체크포인트 =====

/** 진행요약을 상한 안에서 합친다. 넘치면 **뒤(최신)를 남긴다** — 다음 판단에 필요한 건 최근 맥락이다. */
function clampSummary(note: string | null, body: string): string {
  const head = note ? `${note}\n` : ''
  const room = MAX_PROGRESS_CHARS - head.length
  if (room <= 0) return head.slice(0, MAX_PROGRESS_CHARS)
  if (body.length <= room) return `${head}${body}`
  return `${head}…${body.slice(body.length - room + 1)}`
}

function saveCheckpoint(task: PersistentTask, args: {
  stepsUsed: number
  progressSummary?: string
  doneSubtasks?: string[]
  tabUrl?: string
  note?: string | null
  bumpSegment?: boolean
}): void {
  const cp = task.checkpoint
  cp.stepsUsed = Math.max(cp.stepsUsed, Math.max(0, Math.round(args.stepsUsed)))
  cp.llmCalls = task.usage.llmCalls
  if (args.bumpSegment) cp.segment += 1

  const body = str(args.progressSummary).trim()
  if (body || args.note) cp.progressSummary = clampSummary(args.note ?? null, body || cp.progressSummary)

  if (args.doneSubtasks && args.doneSubtasks.length > 0) {
    // 앞 구간의 완료 하위작업이 사라지지 않게 **합집합**으로 누적한다(T2 부정 사례).
    // 상한을 넘으면 최신을 남긴다 — 오래된 항목은 진행요약 서술에도 남아 있다.
    const merged = [...cp.doneSubtasks]
    for (const s of args.doneSubtasks) if (!merged.includes(s)) merged.push(s)
    cp.doneSubtasks = merged.slice(Math.max(0, merged.length - MAX_DONE_SUBTASKS))
  }

  if (args.tabUrl) cp.tabUrl = args.tabUrl
  cp.savedAt = Date.now()

  task.updatedAt = cp.savedAt
  markDirty(task)
  emitChanged()
}

// ===== 구간 루프 =====

function toInterrupted(task: PersistentTask, reason: string): void {
  setState(task, 'interrupted', `${reason} 이어서 진행할 수 있습니다.`)
}

function scheduleRetry(task: PersistentTask, kind: RetryKind, detail: string): boolean {
  const rt = runtimeOf(task.id)
  const ladder = BACKOFF_MS[kind]
  const attempt = (rt.retryKind === kind ? rt.retryCount : 0) + 1
  const delay = ladder[attempt - 1]
  if (delay === undefined) {
    // 상한 도달 — 무한 재시도 대신 상태를 보존하고 멈춘다(T11 부정 사례).
    rt.retryKind = null; rt.retryCount = 0
    setState(task, 'interrupted', `재시도 ${ladder.length}회를 모두 시도했지만 실패했습니다(${detail}). 이어서 진행할 수 있습니다.`)
    return false
  }
  rt.retryKind = kind
  rt.retryCount = attempt

  const nextAt = Date.now() + delay
  setState(task, 'retrying')
  task.retry = { kind, attempt, nextAt, detail: detail.slice(0, 300) }
  task.waitReason = `${kind} 오류로 ${Math.round(delay / 1000)}초 후 ${attempt}번째 재시도합니다.`
  task.updatedAt = Date.now()
  markDirty(task)
  emitChanged()

  if (rt.retryTimer) clearTimeout(rt.retryTimer)
  rt.retryTimer = setTimeout(() => {
    rt.retryTimer = null
    const cur = getTask(task.id)
    // 기다리는 동안 사용자가 일시정지·취소했으면 되살리지 않는다.
    if (!cur || cur.state !== 'retrying') return
    setState(cur, 'running')
    void runLoop(cur.id)
  }, delay)
  return true
}

/** 단계가 늘지 않는 구간이 이만큼 이어지면 진척이 없다고 보고 멈춘다(모델 호출만 태우는 공회전 차단). */
const NO_PROGRESS_LIMIT = 3

async function runLoop(id: string): Promise<void> {
  const rt = runtimeOf(id)
  if (rt.loopActive) return   // 구간 루프는 작업당 하나만 — 두 개가 같은 탭을 조작하면 서로를 망친다.
  rt.loopActive = true
  try {
    // 구간 수 안전 상한 — 예산 검사가 어떤 이유로든 통과되더라도 루프가 영원히 돌지 않게 한다.
    // (단계 예산을 구간 크기로 나눈 수 + 여유. 대기·재시도로 구간이 몇 번 헛돌 수 있어 넉넉히 둔다.)
    const budgetSteps = getTask(id)?.budget.maxSteps ?? SEGMENT_STEPS
    const maxSegments = Math.ceil(budgetSteps / SEGMENT_STEPS) + 16
    let noProgress = 0

    for (let seg = 0; seg < maxSegments; seg++) {
      const task = getTask(id)
      if (!task || task.state !== 'running') break

      // 1. 예산
      const over = budgetExceeded(task)
      if (over) { toInterrupted(task, over); break }

      // 2. 외부 쓰기 원장 — 발행을 눌렀는데 완료 근거가 없으면 **다시 시도하지 않고** 사용자에게 묻는다.
      const pending = pendingExternalWrite(task)
      if (pending) {
        rt.waitKind = 'ledger'
        setState(task, 'waiting-user',
          `발행이 됐는지 확실하지 않습니다 — 확인해 주세요. (마지막 동작: ${pending.label})`
          + ' 이미 올라갔다면 중단하시고, 아직이라면 계속을 눌러 주세요.')
        break
      }

      // 3. 탭 재바인딩
      const bind = resolveTaskTab(task)
      if (bind.tabId === null) {
        rt.waitKind = 'user-fix'
        setState(task, 'waiting-user', bind.reason)
        break
      }

      const stepsBefore = task.checkpoint.stepsUsed
      const remaining = task.budget.maxSteps - stepsBefore
      // 모델 호출 상한을 **구간 크기로도** 묶는다. 예산 검사는 구간 경계에서만 돌기 때문에,
      // 남은 호출이 3회인데 구간을 12단계로 주면 12회를 부르고 나서야 멈춘다(하네스 실측: 4배 초과).
      // 한 단계는 모델을 **최대 1회** 부르므로(가드가 통과하면 0회), 남은 호출 수로 단계 수를 제한하면
      // 초과가 사라진다. 사용자가 정한 비용 상한을 실제로 지키는 자리다.
      const remainingCalls = Math.max(1, task.budget.maxLlmCalls - task.usage.llmCalls)
      const stepBudget = Math.max(1, Math.min(SEGMENT_STEPS, remaining, remainingCalls))

      // 재바인딩으로 페이지가 달라졌으면 그 사실을 모델이 보는 진행요약에 먼저 남긴다.
      if (bind.note) saveCheckpoint(task, { stepsUsed: stepsBefore, note: bind.note, tabUrl: currentUrlOf(bind.tabId) })

      // 4. 구간 실행
      const { outcome, trace } = await runSegment(task, bind.tabId, stepBudget)

      const live = getTask(id)
      if (!live) break
      // 실행 중 사용자가 취소·삭제했으면 그 결정을 덮어쓰지 않는다(늦게 온 done 이 cancelled 를 뒤집지 못한다).
      if (isTerminal(live.state)) break
      // 일시정지 요청이 관문보다 늦게 닿아 구간이 이미 완료됐다면, 그 결과는 버리지 않고 기록한다 —
      // 버리면 재개가 **이미 끝난 일을 다시** 하게 된다(발행 작업이라면 두 번 올릴 수도 있다).
      // 완료 외의 결과는 사용자의 일시정지를 존중해 여기서 멈춘다.
      if (live.state === 'paused' && outcome.kind !== 'done') break

      const observedSteps = Math.max(stepsBefore, trace.lastStep)

      // 5. 결과 분기
      if (outcome.kind === 'done') {
        saveCheckpoint(live, {
          stepsUsed: observedSteps,
          tabUrl: currentUrlOf(bind.tabId),
          bumpSegment: true,
        })
        live.result = str(outcome.message, '완료')
        if (outcome.evidence) {
          live.verifyEvidence = outcome.evidence
          // 발행 완료 근거를 봤다 → 원장의 미확인 항목을 확정해 다음 지시가 막히지 않게 한다.
          confirmExternalWrites(live)
          setState(live, 'completed')
        } else {
          // 모델이 "다 했다" 고만 말하고 결과를 못 대는 경우. 사용자가 acceptTaskResult 로 승인해야
          // completed 가 된다 — 여기서 자동 승격하면 실패가 성공으로 기록된다(T4).
          delete live.verifyEvidence
          setState(live, 'needs-verify', '완료를 확인할 근거가 없습니다 — 결과를 확인한 뒤 승인해 주세요.')
        }
        break
      }

      if (outcome.kind === 'exhausted') {
        const ex = trace.exhausted
        if (ex) addResultFiles(live, ex.files)
        // 원장 확정은 라벨 추측이 아니라 agent.ts 가 센 publishPending 을 따른다. 발행이 없었거나
        // 완료 신호까지 확인됐다면 미확인 항목을 풀어 다음 구간이 헛되이 막히지 않게 한다.
        if (ex && !ex.publishPending) confirmExternalWrites(live)
        saveCheckpoint(live, {
          stepsUsed: Math.max(observedSteps, ex?.stepsUsed ?? 0),
          ...(ex?.progressSummary ? { progressSummary: ex.progressSummary } : {}),
          ...(ex?.doneSubtasks ? { doneSubtasks: ex.doneSubtasks } : {}),
          tabUrl: ex?.tabUrl || currentUrlOf(bind.tabId),
          bumpSegment: true,
        })
        // 단계 소진은 성공이 아니다 — done 으로 승격하지 않고 다음 구간을 잇는다(T3).
        if (live.checkpoint.stepsUsed > stepsBefore) {
          noProgress = 0
          // 진척이 있었다 → 앞선 실패는 "연속" 이 아니다. 오래 도는 작업이 한 시간마다 한 번 겪는
          // 일시적 네트워크 오류로 영구히 재시도 상한에 붙어 있지 않게 카운터를 되돌린다.
          rt.retryKind = null; rt.retryCount = 0
        } else {
          noProgress += 1
        }
        if (noProgress >= NO_PROGRESS_LIMIT) {
          toInterrupted(live, `${NO_PROGRESS_LIMIT}개 구간 동안 진척이 없었습니다.`)
          break
        }
        continue
      }

      if (outcome.kind === 'cancelled') {
        saveCheckpoint(live, { stepsUsed: observedSteps, tabUrl: currentUrlOf(bind.tabId) })
        if (!isTerminal(live.state)) setState(live, 'cancelled')
        break
      }

      // error 또는 결과 없이 끝난 구간
      const detail = outcome.kind === 'error'
        ? str(outcome.message, '알 수 없는 오류')
        : '구간이 결과를 남기지 않고 끝났습니다.'
      saveCheckpoint(live, { stepsUsed: observedSteps, tabUrl: currentUrlOf(bind.tabId) })

      const kind = classifyRetry(detail)
      if (BACKOFF_MS[kind].length === 0) {
        // 사람만 풀 수 있는 원인(탭 닫힘·로그인) — 재시도로 태우지 않고 기다린다.
        // 두 경우 모두 'user-fix' 로 둔다: 조치를 마친 사용자가 confirmTask(id, true) 로 이어갈 수 있어야 한다
        // (waitKind 가 null 이면 startTask 는 waiting-user 를 거부해 되살릴 방법이 없는 막다른 길이 된다).
        rt.waitKind = 'user-fix'
        setState(live, 'waiting-user', waitMessageFor(kind, detail))
        break
      }
      if (!scheduleRetry(live, kind, detail)) break
      break   // 재시도는 타이머가 새 루프를 시작한다 — 이 루프는 여기서 끝난다.
    }
  } finally {
    // 삭제된 작업의 runtime 을 되살리지 않도록 지도에 남아 있을 때만 정리한다.
    const cur = runtimes.get(id)
    if (cur) { cur.loopActive = false; cur.reqId = null }
  }
}

// ===== 제어 =====

/** 비행 중인 구간·재시도 타이머를 모두 멈춘다(취소·삭제 공용). */
function stopEverything(task: PersistentTask): void {
  const rt = runtimes.get(task.id)
  if (!rt) return
  if (rt.retryTimer) { clearTimeout(rt.retryTimer); rt.retryTimer = null }
  if (rt.reqId) cancelAgentTask(rt.reqId)
  rt.waitKind = null
}

export function startTask(id: string): void {
  const task = getTask(id)
  if (!task) return
  if (task.state !== 'queued' && task.state !== 'interrupted' && task.state !== 'paused') return
  beginRun(task)
}

export function resumeTask(id: string): void {
  const task = getTask(id)
  if (!task) return
  if (task.state !== 'paused' && task.state !== 'interrupted') return
  beginRun(task)
}

/**
 * 실행 상태로 들어간다. 이미 구간이 비행 중이면(일시정지로 관문에 멈춰 있는 경우) **새 루프를 만들지 않고**
 * 그 구간을 깨운다 — 두 루프가 같은 탭을 조작하는 것을 막는다.
 */
function beginRun(task: PersistentTask): void {
  const rt = runtimeOf(task.id)
  if (task.state === 'queued') task.startedAt = Date.now()
  if (rt.retryTimer) { clearTimeout(rt.retryTimer); rt.retryTimer = null }
  // 사용자가 직접 이어가기를 눌렀다 → 자동 재시도 상한은 다시 처음부터(사람의 의사가 자동 정책을 이긴다).
  rt.retryKind = null; rt.retryCount = 0
  setState(task, 'running')
  if (rt.loopActive) {
    if (rt.reqId) resumeAgentTask(rt.reqId)
    return
  }
  void runLoop(task.id)
}

export function pauseTask(id: string): void {
  const task = getTask(id)
  if (!task) return
  // waiting-user 는 일시정지 대상이 아니다. 이미 아무 것도 실행하지 않고(실행 시간도 늘지 않고) 사용자를
  // 기다리는 상태이며, 여기서 paused 로 바꾸면 확인·답변 경로가 막혀(둘 다 waiting-user 를 요구한다)
  // 에이전트는 응답을 기다리는데 보낼 방법이 없는 교착이 된다. 그 상태에서는 응답하거나 중단한다.
  if (task.state !== 'running' && task.state !== 'retrying') return
  const rt = runtimeOf(id)
  if (rt.retryTimer) { clearTimeout(rt.retryTimer); rt.retryTimer = null }
  // 부작용 직전 관문에서 멈춘다 — 일시정지 뒤에는 페이지가 바뀌지 않는다(T5 부정 사례).
  if (rt.reqId) pauseAgentTask(rt.reqId)
  setState(task, 'paused', '일시정지했습니다.')
}

export function cancelTask(id: string): void {
  const task = getTask(id)
  if (!task) return
  if (isTerminal(task.state)) return
  stopEverything(task)
  // 취소와 구간 완료가 거의 동시에 오면(모델이 done 을 내는 순간 사용자가 중단을 누르면) 이미
  // `result` 에 완료 보고가 쓰여 있을 수 있다. 상태는 cancelled 로 맞지만, 그대로 두면 사용자가
  // **"중단됨" 옆에 "완료했습니다" 를 보게 된다** — 중단한 작업이 성공한 것처럼 읽히는 잘못된 화면이다.
  // 정보를 버리지도 않는다: 중단이 결론임을 앞세우고, 모델이 마지막에 뭐라고 했는지는 괄호로 남긴다.
  const late = (task.result ?? '').trim()
  task.result = late
    ? `사용자가 중단했습니다. (중단 직전 모델이 보고한 내용: ${late.slice(0, 200)})`
    : '사용자가 중단했습니다.'
  // 완료 근거도 지운다 — 중단된 작업에 "완료 근거" 가 붙어 있으면 승인해도 되는 것처럼 보인다.
  delete task.verifyEvidence
  setState(task, 'cancelled', '사용자가 중단했습니다.')
}

export function confirmTask(id: string, approved: boolean): void {
  const task = getTask(id)
  if (!task || task.state !== 'waiting-user') return
  const rt = runtimeOf(id)

  switch (rt.waitKind) {
    case 'agent-confirm': {
      const reqId = rt.reqId
      if (!reqId) return
      rt.waitKind = null
      // 거부도 그대로 전달한다 — agent.ts 가 "거부됨" 을 맥락에 남기고 다른 방법을 찾게 한다.
      confirmAgentStep(reqId, approved)
      setState(task, 'running')
      return
    }
    case 'ledger': {
      rt.waitKind = null
      // 여기서 approved=true 는 "중복 위험을 확인했고 계속하겠다" 는 뜻이다.
      if (!approved) { stopEverything(task); setState(task, 'cancelled', '발행 확인에서 중단했습니다.'); return }
      confirmExternalWrites(task)
      beginRun(task)
      return
    }
    case 'user-fix': {
      rt.waitKind = null
      if (!approved) { stopEverything(task); setState(task, 'cancelled', '사용자가 이어가지 않기로 했습니다.'); return }
      beginRun(task)   // 사용자가 탭을 열었거나 로그인했다 → 다시 찾아 이어간다
      return
    }
    default: return
  }
}

export function answerTask(id: string, answer: string): void {
  const task = getTask(id)
  if (!task || task.state !== 'waiting-user') return
  const rt = runtimeOf(id)
  if (rt.waitKind !== 'agent-ask' || !rt.reqId) return
  const reqId = rt.reqId
  rt.waitKind = null
  replyAgentAsk(reqId, str(answer))
  setState(task, 'running')
}

/** needs-verify → completed. **사용자만** 할 수 있다 — 근거 없는 완료를 코드가 승격하지 않는다(T4). */
export function acceptTaskResult(id: string): void {
  const task = getTask(id)
  if (!task || task.state !== 'needs-verify') return
  task.verifyEvidence = '사용자가 결과를 확인했습니다.'
  confirmExternalWrites(task)
  setState(task, 'completed')
}
