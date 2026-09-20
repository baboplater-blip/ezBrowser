import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  cancelAgentTask, confirmAgentStep, pauseAgentTask, replyAgentAsk, resumeAgentTask, runAgentTask,
  type AgentEvent,
} from './agent'
import { isPublishAction, normalizeAccountName, normalizeVerifyText, type ReadSighting } from './agent-gate'
import {
  getTab, getAllTabs, getTabPartition, getWebContentsByTabId, getTabRestoreKey, findTabByRestoreKey,
  undiscardTab, listTabs, listTabsInWorkspace,
} from '../../tabs/tab-service'
// 창 쪽 복원 안정 키 — tab-service.ts 와 동일 계열의 다른 작업자가 병행 작성 중인 API.
// 아직 반영 전이면 이 import 부터 tsc 오류가 나는데, 그건 window-service.ts 쪽 문제다.
import {
  getAllWindows, getWindow, getWindowRestoreKey, findWindowByRestoreKey,
} from '../../windows/window-service'
import { getWorkspace, getActiveWorkspaceId } from '../workspace'
import { createJsonStore, loadJsonObject } from './json-store'
import { writeDownloadMd, safeFileName } from './conversations'

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

/**
 * 작업 저장 파일. **export 한다** — social-workflow 가 "저장이 막혔다" 고 사용자에게 알릴 때
 * 파일명을 손으로 적다가 틀린 적이 있다(찾아가면 없는 파일을 가리켰다). 이름은 한 곳에서만 온다.
 */
export const FILE_NAME = 'ai-tasks.json'
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

/**
 * 사람을 기다리는 이유. **재시작을 넘어 보존된다**(PersistentTask.waitCause).
 *
 *  - `confirm`  되돌릴 수 없는/위험한 동작의 승인을 기다렸다(결제·삭제·전송 등)
 *  - `login`    사이트 로그인 또는 제공자 인증이 필요하다 — 사람이 직접 해야 한다
 *  - `captcha`  사람 확인(CAPTCHA) — 사람이 직접 풀어야 한다
 *  - `ask`      에이전트가 정보를 물었다(일반 질문)
 *  - `ledger`   발행을 눌렀는데 완료 근거가 없다 — 중복 게시 위험
 *  - `user-fix` 탭이 사라지는 등 사람만 풀 수 있는 상황
 *  - `tab-target` 복원 안정 키로 원래 탭을 다시 찾지 못했다 — 사람이 **어느 탭에서 이어갈지** 직접
 *    골라야 한다(호스트로 후보를 추측해 엉뚱한 탭에 붙는 사고를 피하려고 자동으로 찾지 않는다).
 */
export type WaitCause = 'confirm' | 'login' | 'captcha' | 'ask' | 'ledger' | 'user-fix' | 'tab-target'

const WAIT_CAUSES = new Set<WaitCause>(['confirm', 'login', 'captcha', 'ask', 'ledger', 'user-fix', 'tab-target'])

/** 사람이 **직접 조치**해야 풀리는 사유 — 재시작 뒤에도 그 사실을 문구로 유지한다. */
const HUMAN_ACTION_CAUSES = new Set<WaitCause>(['confirm', 'login', 'captcha', 'ledger', 'user-fix', 'tab-target'])

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
  /**
   * 대상 탭의 **복원 안정 키**(tab-service 의 restoreKey). 재시작 뒤 `windowId`/탭 id 는 프로세스마다
   * 다시 발급되므로 호스트로 후보를 추측하지 않고 이 키로 정확히 그 탭을 다시 찾는다.
   * 옛 저장본(이 필드가 생기기 전)은 null — 그 경우엔 세션 안 마지막 탭으로만 완화 시도한다.
   */
  tabKey: string | null
  /** 그 탭이 있던 창의 복원 안정 키(window-service 의 restoreKey). */
  windowKey: string | null
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
  /**
   * 이 작업이 **실제로 화면에서 관찰한** 대조 근거(읽기 전용 확인 작업 전용).
   * 에이전트 루프가 관찰 텍스트·주소에서 직접 뽑아 적는다 — **모델이 만들 수 없는 값**이다.
   * 모델의 결론(산문)을 이 기록과 대조해야 "봤다고 말한 것"과 "실제로 본 것"이 갈린다.
   */
  readSightings?: ReadSighting[]
  waitReason?: string
  /**
   * **무엇을 기다리다 멈췄는가.** `TaskRuntime.waitKind` 와 달리 이것은 디스크에 남는다.
   *
   * 왜 (2026-09-19 실측): 재시작하면 `waiting-user` 가 `interrupted` 로 정리되는데, 예전에는 그때
   * `waitReason` 을 "재시작으로 중단됐습니다 — 이어서 진행할 수 있습니다." 로 **덮어썼다**.
   * 그래서 "🔐 로그인이 필요합니다" 로 멈춘 작업도, "결제하기 — 확인이 필요합니다" 로 멈춘 작업도
   * 재시작 뒤에는 똑같이 무해한 문구와 평범한 이어가기 버튼으로만 보였다. 사용자는 왜 멈췄는지
   * 알 수 없고, 돈을 쓰려다 멈춘 작업이 아무 일 없던 것처럼 읽힌다.
   *
   * ⚠ 이 값이 이어가기를 **자동 승인**으로 만들지는 않는다. 재시작 뒤 이어가기는 언제나 새 구간을
   *   시작하고, 위험 동작이면 에이전트 가드가 **다시** 확인을 요구한다(아래 initTaskRuntime 참고).
   */
  waitCause?: WaitCause
  // 사용자가 기다림을 풀려면 가야 할 곳(예: 로그인 계정 설정). 외피가 버튼으로 띄운다.
  waitActionUrl?: string
  waitActionLabel?: string
  retry?: { kind: RetryKind; attempt: number; nextAt: number; detail: string }
  /**
   * 이어가기(resumeTask/startTask 의 interrupted 경로) 전에 먼저 확인해야 하는 이유. 있으면 이어가기가
   * 거부된다. 원인은 이 파일이 몰라도 된다(예: social-workflow.ts 가 "게시 여부가 확인되지 않았다" 를
   * 세운다) — setResumeBlock 은 문자열만 받아 저장할 뿐이다.
   */
  resumeBlockedReason?: string
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
  waitReason?: string; waitActionUrl?: string; waitActionLabel?: string; retry?: PersistentTask['retry']
  /** 무엇을 기다리다 멈췄는가(재시작을 넘어 보존). 외피가 사유별 안내·버튼 문구를 고르는 데 쓴다. */
  waitCause?: WaitCause
  resumeBlockedReason?: string
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
   * 'tab-target' = 대상 탭을 다시 찾지 못해 사람이 골라야 한다 — confirmTask 로는 풀리지 않고
   * **setTaskTarget** 이 직접 state 를 'interrupted' 로 옮긴다(default 분기가 조용히 무시한다).
   */
  waitKind: 'agent-confirm' | 'agent-ask' | 'ledger' | 'user-fix' | 'tab-target' | null
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
  /** 구간 모드에서 조립된 부분 보고서 — 작업이 끝날 때 한 번만 파일로 쓴다(휘발, 재시작 시 보존 안 함). */
  pendingReport: { title: string; markdown: string } | null
}

const runtimes = new Map<string, TaskRuntime>()

function runtimeOf(id: string): TaskRuntime {
  let rt = runtimes.get(id)
  if (!rt) {
    rt = {
      reqId: null, waitKind: null, loopActive: false, runningSince: 0,
      retryTimer: null, retryKind: null, retryCount: 0, lastTabId: null, pendingReport: null,
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

/** 한 작업이 들고 갈 관찰 근거 상한 — 근거는 몇 건이면 충분하고, 파일이 부풀면 저장이 느려진다. */
const MAX_SIGHTINGS = 5

/**
 * 디스크에서 읽은 관찰 근거를 **모양이 맞는 것만** 남긴다. 손상·조작된 파일이 근거로 둔갑해
 * 게시 완료를 확정시키지 못하게, 필수 필드가 하나라도 빠지면 그 항목을 버린다.
 */
function sanitizeSightings(v: unknown): { readSightings?: ReadSighting[] } {
  if (!Array.isArray(v)) return {}
  const out: ReadSighting[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const url = str(o.url).slice(0, 500)
    const needle = normalizeVerifyText(str(o.needle)).slice(0, 300)
    const at = num(o.at)
    if (!url || !needle || !(at > 0)) continue
    // 작성자·게시 시각도 **모양이 맞을 때만** 복원한다. 특히 `authorScope` 가 'post' 가 아니면
    // 작성자를 통째로 버린다 — 손상·조작된 파일이 "글 안에서 읽은 계정" 인 척하지 못하게.
    const author = normalizeAccountName(o.author)
    const postedAt = num(o.postedAt)
    out.push({
      url, host: str(o.host).slice(0, 200), needle, snippet: str(o.snippet).slice(0, 300), at,
      ...(author && o.authorScope === 'post'
        ? {
          author,
          authorScope: 'post' as const,
          // 손상·조작 파일이 휴리스틱 값을 '구조적'으로 승격해 **확정 거부**를 만들지 못하게,
          // 정확히 'structural' 일 때만 그대로 두고 나머지는 보수적으로 낮춘다.
          authorSource: o.authorSource === 'structural' ? ('structural' as const) : ('heuristic' as const),
        }
        : {}),
      ...(postedAt > 0 ? { postedAt } : {}),
      ...(str(o.postedAtText) ? { postedAtText: str(o.postedAtText).slice(0, 60) } : {}),
      ...(str(o.ambiguous) ? { ambiguous: str(o.ambiguous).slice(0, 120) } : {}),
    })
    if (out.length >= MAX_SIGHTINGS) break
  }
  return out.length ? { readSightings: out } : {}
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
    // 하위호환: 이 필드가 생기기 전에 저장된 작업은 null — reviveTask 는 절대 throw 하지 않는다.
    tabKey: typeof rawCp.tabKey === 'string' && rawCp.tabKey ? rawCp.tabKey : null,
    windowKey: typeof rawCp.windowKey === 'string' && rawCp.windowKey ? rawCp.windowKey : null,
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
    ...(sanitizeSightings(o.readSightings)),
    ...(typeof o.waitReason === 'string' ? { waitReason: o.waitReason } : {}),
    ...(typeof o.waitActionUrl === 'string' && o.waitActionUrl.startsWith('browser://')
      ? { waitActionUrl: o.waitActionUrl.slice(0, 300) } : {}),
    ...(typeof o.waitActionLabel === 'string' ? { waitActionLabel: o.waitActionLabel.slice(0, 40) } : {}),
    ...(WAIT_CAUSES.has(o.waitCause as WaitCause) ? { waitCause: o.waitCause as WaitCause } : {}),
    ...(typeof o.resumeBlockedReason === 'string' && o.resumeBlockedReason
      ? { resumeBlockedReason: o.resumeBlockedReason.slice(0, 300) } : {}),
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
      const wasWaiting = task.state === 'waiting-user'
      task.state = 'interrupted'
      delete task.retry
      if (wasWaiting && task.waitCause) {
        // ⚠ **사유를 덮어쓰지 않는다.** 예전에는 여기서 waitReason 을 일반 문구로 갈아치워,
        //   "🔐 로그인이 필요합니다" 로 멈춘 작업도 "결제하기 — 확인이 필요합니다" 로 멈춘 작업도
        //   재시작 뒤에는 똑같이 무해해 보이는 한 줄이 됐다. 왜 멈췄는지 모르는 채로 이어가기를
        //   누르게 만드는 화면이었다. 원래 사유·갈 곳(waitActionUrl)을 그대로 두고 꼬리만 붙인다.
        const base = str(task.waitReason, '사람의 처리를 기다리던 중이었습니다.')
        task.waitReason = `${base} (재시작으로 중단됨)`
        // 사람이 직접 조치해야 풀리는 사유는 그 사실을 한 번 더 말해 준다 — 이어가기가 곧
        // 승인이 아니라는 것도 함께(아래 beginRun 은 언제나 **새 구간**을 시작하고, 위험 동작이면
        // 에이전트 가드가 다시 확인을 요구한다. 즉 이어가기는 자동 승인 경로가 아니다).
        if (HUMAN_ACTION_CAUSES.has(task.waitCause)) {
          task.waitReason += task.waitCause === 'confirm'
            ? ' 이어가도 자동으로 승인되지 않습니다 — 다시 확인을 요청합니다.'
            : ' 직접 처리한 뒤 이어가세요.'
        }
      } else {
        // 기다리고 있지 않았거나(running·retrying) 사유를 모르는 옛 저장본 — 예전 문구 그대로.
        task.waitReason = '재시작으로 중단됐습니다 — 이어서 진행할 수 있습니다.'
        delete task.waitCause
        delete task.waitActionUrl
        delete task.waitActionLabel
      }
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

/**
 * 작업 목록을 **지금 디스크에 확정한다**. 종료 훅과, 되돌릴 수 없는 외부 쓰기 직전의
 * 내구성 경계(social-workflow 의 persistPublishBoundary)가 함께 쓴다.
 *
 * @returns 확정됐는가. `false` 면 메모리의 최신 작업 목록이 디스크에 없다 —
 *   그 상태로 외부 쓰기를 시작하면 재시작한 제품이 "무엇을 하려 했는지" 를 잃는다.
 */
export function flushTasks(): boolean {
  return store.flush()
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
    ...(t.waitActionUrl !== undefined ? { waitActionUrl: t.waitActionUrl } : {}),
    ...(t.waitActionLabel !== undefined ? { waitActionLabel: t.waitActionLabel } : {}),
    ...(t.waitCause !== undefined ? { waitCause: t.waitCause } : {}),
    ...(t.retry !== undefined ? { retry: t.retry } : {}),
    ...(t.resumeBlockedReason !== undefined ? { resumeBlockedReason: t.resumeBlockedReason } : {}),
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

/**
 * 아직 시작하지 않은 작업의 지시문을 바꾼다.
 *
 * 왜 필요한가: 지시문에 "이 작업의 산출물 id" 를 넣어야 하는 흐름이 있는데(생성→게시 워크플로),
 * 그 id 는 **작업을 만든 뒤에야** 정해진다(산출물 폴더가 작업 id 로 갈리므로). 순서가 뒤집힌 셈이라
 * 자리표시자를 넣어 만든 뒤 시작 전에 치환해야 한다.
 *
 * **시작한 작업은 거부한다** — 이미 도는 구간이 옛 지시문을 들고 있어, 바꾸면 같은 작업의 두 구간이
 * 서로 다른 지시를 따르게 된다. 그건 디버깅이 불가능한 종류의 버그다.
 */
export function setTaskInstruction(id: string, instruction: string): boolean {
  const task = getTask(id)
  if (!task) return false
  if (task.state !== 'queued') return false
  const next = String(instruction ?? '').trim()
  if (!next) return false
  task.instruction = next
  task.updatedAt = Date.now()
  markDirty(task)
  return true
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
    delete task.waitActionUrl
    delete task.waitActionLabel
    // 다시 달리기 시작했다 = 그 기다림은 끝났다. 사유를 남겨 두면 다음 중단 때 **옛 사유**가 보인다.
    delete task.waitCause
    delete task.retry   // 표시용 기록만 지운다. 연속 실패 카운터는 runtime 에 있다(위 주석 참고).
    // ⚠ waitKind 는 여기서 지우지 않는다. 일시정지와 확인 요청이 겹친 뒤 재개하면 "무엇을 기다렸는지"가
    //   사라져, 에이전트는 확인을 기다리는데 응답을 보낼 상대를 잃는 교착이 된다.
    //   waitKind 는 응답을 실제로 전달한 자리(confirmTask·answerTask)와 구간 종료·종료 상태에서만 지운다.
  }
  if (waitReason !== undefined) task.waitReason = waitReason
  if (isTerminal(next)) {
    task.endedAt = Date.now()
    rt.waitKind = null
    delete task.waitCause
  }
  task.updatedAt = Date.now()
  markDirty(task)
  emitChanged()
}

/**
 * 사람을 기다리는 상태로 들어가는 **단일 통로**. 휘발 `waitKind`(응답을 누구에게 보낼지)와
 * 영속 `waitCause`(무엇을 기다렸는지)를 **함께** 세운다.
 *
 * 둘을 따로 두던 시절엔 재시작 뒤 사유가 통째로 사라졌다 — 사유가 휘발 쪽에만 있었기 때문이다.
 */
function setWaiting(
  task: PersistentTask,
  waitKind: NonNullable<TaskRuntime['waitKind']>,
  cause: WaitCause,
  reason: string,
): void {
  const rt = runtimeOf(task.id)
  // waitKind 는 setState **전에** 정한다 — 'changed' 를 받은 쪽이 곧바로 confirmTask 를 불러도
  // 기다리는 상대가 이미 지정돼 있어야 응답이 엉뚱한 곳으로 가지 않는다.
  rt.waitKind = waitKind
  task.waitCause = cause
  setState(task, 'waiting-user', reason)
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
  /**
   * **태어날 때부터 막힌 작업**으로 만든다 — `startTask`/`resumeTask` 가 거부한다.
   *
   * 왜 생성 시점이어야 하는가 (2026-09-19): 되돌릴 수 없는 외부 쓰기(게시)를 하는 작업은
   * "저장이 확정됐을 때만 시작 가능" 해야 한다. 그런데 만든 **뒤에** 막으면, 그 사이에 디바운스
   * 저장이 한 번 돌면 디스크에는 **막히지 않은** 작업이 남는다. 그 상태로 앱이 죽으면 재시작한
   * 사용자가 작업 목록에서 그것을 직접 시작할 수 있고 — 그것이 곧 경계를 우회한 게시다.
   * 태어날 때 막으면 **디스크에 존재하는 모든 판본이 막혀 있다**(구조적 보장). 저장 확정을
   * 확인한 뒤에야 `clearResumeBlock` 으로 푼다.
   */
  blockedReason?: string
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

  // 시작 탭은 "id" 가 아니라 **URL + 워크스페이스 + 복원 안정 키**로 기억한다. 재시작 뒤 옛 탭 id 는
  // 다른 탭을 가리킬 수 있어서다(T9). id 는 이 세션 동안만 runtime.lastTabId 로 들고 간다.
  const tabId = str(args.tabId)
  const tab = tabId ? getTab(tabId) : null
  const wc = tabId ? getWebContentsByTabId(tabId) : null
  const tabUrl = wc && !wc.isDestroyed() ? wc.getURL() : (tab?.url ?? '')
  const now = Date.now()
  const resolvedWindowId = args.windowId ?? tab?.windowId ?? null

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
      windowId: resolvedWindowId,
      tabKey: tabId ? getTabRestoreKey(tabId) : null,
      windowKey: resolvedWindowId ? getWindowRestoreKey(resolvedWindowId) : null,
      savedAt: now,
    },
    usage: { input: 0, cacheRead: 0, cacheCreate: 0, output: 0, llmCalls: 0 },
    resultFiles: [],
    readOnly: args.readOnly === true,
    incognito: args.incognito === true,
    ownerWindowId: resolvedWindowId,
    externalWrites: [],
    createdAt: now, updatedAt: now, startedAt: now,
    elapsedMs: 0,
    ...(str(args.blockedReason).trim()
      ? { resumeBlockedReason: str(args.blockedReason).trim().slice(0, 300) } : {}),
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

type TabBinding =
  | { tabId: string; note: string | null }
  | { tabId: null; reason: string; needsTarget: boolean }

/** 잠든(about:blank) 탭을 깨우고 로드를 기다린다. 판단으로 정한 상한 — 사람이 손대는 값이 아니라
 *  "영원히 걸리지 않게" 두는 안전망일 뿐이라 15초로 넉넉히 잡았다(느린 사이트도 대개 그 안에 뜬다). */
const WAKE_TIMEOUT_MS = 15_000

async function wakeTabIfSleeping(tabId: string, abort?: () => boolean): Promise<boolean> {
  const t = getTab(tabId)
  if (!t) return false
  if (!t.discarded) return true
  if (!undiscardTab(tabId)) return false
  const deadline = Date.now() + WAKE_TIMEOUT_MS
  for (;;) {
    // 사용자가 그 사이 중단·일시정지했으면 더 기다리지 않는다(15초를 헛되이 붙들지 않게).
    // 부작용 차단 자체는 runLoop 의 관문이 하고, 여기서는 그 대기를 빨리 끊는 것이 목적이다.
    if (abort?.()) return false
    const wc = getWebContentsByTabId(tabId)
    if (!wc || wc.isDestroyed()) return false
    if (!wc.isLoading() && /^https?:/i.test(wc.getURL())) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/**
 * 지금 이 탭을 기준으로 체크포인트의 복원 안정 키(tabKey/windowKey)와 windowId/workspaceId 를
 * 최신화한다. 재바인딩으로 대상 탭이 바뀌었으면(같은 사이트의 다른 탭 등) 다음 재시작도 그 탭을
 * 정확히 다시 찾아야 하므로, 매 저장 시점마다 "지금 실제로 조작한 탭" 기준으로 동기화한다.
 * @returns 무엇이든 바뀌었는가(저장 트리거 판단용).
 */
function syncCheckpointKeys(cp: TaskCheckpoint, tabId: string): boolean {
  const tab = getTab(tabId)
  if (!tab) return false
  let changed = false
  const tabKey = getTabRestoreKey(tabId)
  const windowKey = getWindowRestoreKey(tab.windowId)
  if (tabKey && tabKey !== cp.tabKey) { cp.tabKey = tabKey; changed = true }
  if (windowKey && windowKey !== cp.windowKey) { cp.windowKey = windowKey; changed = true }
  if (tab.windowId !== cp.windowId) { cp.windowId = tab.windowId; changed = true }
  if (tab.workspaceId && tab.workspaceId !== cp.workspaceId) { cp.workspaceId = tab.workspaceId; changed = true }
  return changed
}

/**
 * 지금 그 창을 가리키는 실제 windowId 를 구한다. `windowKey` 가 있으면 **그것으로만** 찾는다 —
 * 재시작 뒤 창 id 는 프로세스마다 1부터 다시 세므로, 키가 있는데도 못 찾았다면 그 창이 진짜로
 * 없어진 것이다. 우연히 같은 이름의 다른 창을 잘못 집지 않도록 여기서 포기한다(옛 raw id 로
 * 폴백하지 않는다). 키가 없는 옛 기록만 raw id 를 그대로 시도한다(같은 세션 안에서는 유효할 수 있다).
 */
function resolveCurrentWindowId(cp: TaskCheckpoint, ownerWindowId: string | null): string | null {
  if (cp.windowKey) {
    const win = findWindowByRestoreKey(cp.windowKey)
    return win ? win.id : null
  }
  const rawId = cp.windowId ?? ownerWindowId
  return rawId && getWindow(rawId) ? rawId : null
}

/** 사람이 구분할 수 있는 창 이름 — 창 목록 순서 기준 "창 N" (제목이 있으면 덧붙인다). */
function windowLabelOf(windowId: string): string {
  const list = getAllWindows()
  const idx = list.findIndex((w) => w.id === windowId)
  if (idx < 0) return '알 수 없는 창'
  const label = `창 ${idx + 1}`
  try {
    const title = list[idx]?.win.getTitle()
    return title ? `${label} · ${title}` : label
  } catch { return label }
}

/** allowedHosts 가 비어 있으면 전체 허용, 아니면 정확히 그 호스트이거나 그 서브도메인만. */
function hostInAllowList(url: string, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return true
  try {
    const h = new URL(url).hostname.toLowerCase()
    return allowedHosts.some((allowed) => h === allowed || h.endsWith(`.${allowed}`))
  } catch { return false }
}

/**
 * 이 작업이 조작할 탭을 지금 다시 찾는다.
 *
 * **추측하지 않는다.** 예전에는 창 안의 탭들을 호스트로 훑어 후보를 골랐는데, 그러면 같은 사이트의
 * 다른 탭(다른 계정 세션·다른 글)을 엉뚱하게 집을 수 있었다(발행·결제면 사고다). 이제는 `checkpoint.tabKey`
 * (복원 안정 키)로 **정확히 그 탭**을 다시 찾거나, 그마저 안 되면 사람이 직접 고르게 한다
 * (`needsTarget: true` → 'tab-target' 대기 → `listTaskTargets`/`setTaskTarget`).
 *
 * 개인정보 경계는 **양방향으로** 지킨다: 일반 작업은 시크릿 탭으로 넘어가지 않고, 시크릿 작업도
 * 일반(영속 세션) 탭으로 내려오지 않는다. 워크스페이스도 넘지 않는다 — 찾지 못하면 사용자에게 묻는다.
 */
async function resolveTaskTab(task: PersistentTask): Promise<TabBinding> {
  const cp = task.checkpoint

  // ① 복원 안정 키로 정확히 그 탭을 찾는다 — 호스트로 다른 탭을 훑지 않는다.
  if (cp.tabKey) {
    const found = findTabByRestoreKey(cp.tabKey)
    if (!found) {
      return {
        tabId: null, needsTarget: true,
        reason: '작업하던 탭을 찾을 수 없습니다 — 창이 아직 복원되지 않았거나 탭이 닫혔습니다. 대상 탭을 다시 선택해 주세요.',
      }
    }
    if (isIncognitoTab(found.id) !== task.incognito) {
      return {
        tabId: null, needsTarget: true,
        reason: '작업하던 탭을 찾았지만 시크릿 여부가 달라 사용할 수 없습니다. 대상 탭을 다시 선택해 주세요.',
      }
    }
    if (cp.workspaceId && found.workspaceId !== cp.workspaceId) {
      return {
        tabId: null, needsTarget: true,
        reason: '작업하던 탭을 찾았지만 다른 워크스페이스로 옮겨져 있습니다. 대상 탭을 다시 선택해 주세요.',
      }
    }
    const tabId = found.id
    // 복원된 탭은 대개 슬립(about:blank) 상태다 — 그대로 usableTab() 을 들이대면 "쓸 수 없다" 로
    // 오판한다. 여기서 직접 깨우고 로드를 기다린다.
    if (getTab(tabId)?.discarded) {
      const awake = await wakeTabIfSleeping(tabId, () => getTask(task.id)?.state !== 'running')
      if (!awake) {
        return {
          tabId: null, needsTarget: true,
          reason: '작업하던 탭을 깨우지 못했습니다(15초 넘게 로드되지 않았습니다). 대상 탭을 다시 선택해 주세요.',
        }
      }
    }
    const currentUrl = currentUrlOf(tabId)
    // 체크포인트에 애초에 추적할 URL 이 없었다면(대상이 방금 확정된 경우 등) 그대로 그 탭을 쓴다.
    if (!cp.tabUrl || sameTarget(cp.tabUrl, currentUrl)) return { tabId, note: null }
    if (sameHost(cp.tabUrl, currentUrl)) {
      return { tabId, note: `같은 사이트의 다른 페이지에서 재개: 이전 ${cp.tabUrl} → 현재 ${currentUrl}` }
    }
    // 호스트까지 다르면 읽기 전용만 진행을 허용한다(부작용이 없으니). 그 외엔 엉뚱한 대상 보호.
    if (task.readOnly) {
      return { tabId, note: `다른 페이지에서 재개: 이전 ${cp.tabUrl} → 현재 ${currentUrl}` }
    }
    return {
      tabId: null, needsTarget: true,
      reason: `작업하던 페이지(${cp.tabUrl})가 열려 있지 않습니다 — 그 페이지를 다시 열고 이어가거나, 대상 탭을 다시 선택해 주세요.`
        + ' (다른 페이지에서 그대로 진행하면 엉뚱한 대상에 작업할 수 있어 멈췄습니다.)',
    }
  }

  // ② 키가 없는 옛 기록(이 필드가 생기기 전에 저장된 작업). 이 세션 안에서 쓰던 탭이 아직 살아
  //    있고 경계·URL 조건을 만족하면 그것을 쓴다 — **호스트 스캔은 하지 않는다.**
  if (cp.tabUrl) {
    const lastId = runtimeOf(task.id).lastTabId
    if (lastId && usableTab(lastId) && isIncognitoTab(lastId) === task.incognito) {
      const lastTab = getTab(lastId)
      if (!cp.workspaceId || lastTab?.workspaceId === cp.workspaceId) {
        const currentUrl = currentUrlOf(lastId)
        if (sameTarget(cp.tabUrl, currentUrl)) return { tabId: lastId, note: null }
        if (sameHost(cp.tabUrl, currentUrl)) {
          return { tabId: lastId, note: `같은 사이트의 다른 페이지에서 재개: 이전 ${cp.tabUrl} → 현재 ${currentUrl}` }
        }
      }
    }
    return {
      tabId: null, needsTarget: true,
      reason: `작업하던 페이지(${cp.tabUrl})를 찾을 수 없습니다 — 대상 탭을 다시 선택해 주세요.`,
    }
  }

  // ③ 처음부터 대상이 없던 작업(트리거·일정으로 만들어진 첫 구간 등) — 기록된 창의 활성 탭에서
  //    시작하고, 그 탭의 키를 지금 바로 체크포인트에 새겨 다음부터는 ①번 경로로 정확히 되찾게 한다.
  const windowId = resolveCurrentWindowId(cp, task.ownerWindowId)
  if (!windowId) {
    return { tabId: null, needsTarget: true, reason: '작업할 창을 찾을 수 없습니다 — 창에서 다시 시작해 주세요.' }
  }
  const wsId = cp.workspaceId
  const candidates = (wsId ? listTabsInWorkspace(windowId, wsId) : listTabs(windowId))
    .filter((t) => isIncognitoTab(t.id) === task.incognito && usableTab(t.id))
  const active = candidates.find((t) => t.active) ?? candidates[0]
  if (!active) {
    return { tabId: null, needsTarget: true, reason: '작업할 탭을 열어주세요 — 작업하던 페이지가 닫혔습니다.' }
  }
  if (syncCheckpointKeys(cp, active.id)) { task.updatedAt = Date.now(); markDirty(task) }
  return { tabId: active.id, note: null }
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
  // **내구성 경계** — 이 기록은 발행 클릭이 나가기 전에 디스크에 있어야 한다.
  // agent.ts 는 'action' 이벤트를 **클릭 직전에** 동기로 내보내므로, 여기서 flush 하면
  // 클릭보다 먼저 확정된다. 예전에는 디바운스(400ms)뿐이라, 그 창 안에서 앱이 죽으면
  // 재시작한 제품은 "누른 적 없다" 고 보고 이어가기가 같은 글을 또 올릴 수 있었다.
  // (social-workflow 의 게시 경로에는 persistPublishBoundary 가 있었지만, 사용자가 직접 낸
  //  일반 에이전트 작업의 발행 클릭에는 아무 경계도 없었다.)
  if (!task.incognito && !flushTasks()) {
    // 확정 실패를 조용히 넘기지 않는다. 메모리 원장은 남아 있어 **이 프로세스 안에서는** 보호되지만,
    // 재시작을 넘지 못한다는 사실을 로그로 남긴다(사용자 흐름은 막지 않는다 — 이 시점에서 클릭을
    // 되돌릴 수단이 없고, 막는 흉내만 내면 오히려 상태가 어긋난다).
    console.warn(`[task-runtime] 외부 쓰기 원장을 디스크에 확정하지 못했습니다: ${trimmed}`)
  }
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
  // ⚠ 한국어 문구는 **제품이 실제로 내보내는 것**을 그대로 적는다. 2026-09-19 실측: 제공자 계층이
  //    내는 `로컬 Ollama 서버에 연결할 수 없습니다…` 와 `로컬 Ollama 서버 연결 실패…` 가
  //    `연결하지 못` 하나만 보던 이 분기를 빠져나가 **unknown(재시도 1회)** 으로 떨어졌다.
  //    네트워크 사다리(2·8·30초 3회)를 타야 할 일시적 연결 실패가 10초 한 번 만에 포기됐다는 뜻이다.
  //    (`CLI 를 찾을 수 없습니다` 같은 "찾을 수 없" 문구는 여기 걸리지 않는다 — 어휘가 다르다.)
  if (/econnrefused|enotfound|etimedout|socket hang up|fetch failed|network|연결하지 못|연결할 수 없|연결 실패|시간 초과|timeout/.test(m)) return 'network'
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
    /** 구간 모드에서 조립된 부분 보고서(파일 미저장) — 작업이 실제로 끝날 때 한 번만 쓴다. */
    reportTitle: string
    reportMarkdown: string
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
    // 에이전트 루프가 **실제로 관찰한** 대조 근거. 모델의 응답이 아니라 관찰 텍스트·주소에서
    // 뽑은 값이라, 뒤에서 이 기록과 모델의 결론을 대조할 수 있다(social-workflow 의 게시 여부 확인).
    case 'sighting': {
      const url = str(evt.url).slice(0, 500)
      const needle = normalizeVerifyText(str(evt.needle)).slice(0, 300)
      if (!url || !needle) return
      const list = task.readSightings ?? (task.readSightings = [])
      if (list.some((s) => s.url === url && s.needle === needle)) return   // 같은 페이지·같은 문구는 한 번만
      // 작성자·게시 시각은 관찰이 읽어 낸 경우에만 싣는다. **빈 값을 기본값으로 채우지 않는다** —
      // 그러면 "읽지 못했다"(사람이 확인해야 함)가 "그런 표기가 없었다"로 조용히 바뀐다.
      const author = normalizeAccountName(evt.author)
      const postedAt = num(evt.postedAt)
      const next: ReadSighting = {
        url, host: str(evt.host).slice(0, 200), needle, snippet: str(evt.snippet).slice(0, 300), at: Date.now(),
        ...(author && evt.authorScope === 'post'
          ? {
            author,
            authorScope: 'post' as const,
            authorSource: evt.authorSource === 'structural' ? ('structural' as const) : ('heuristic' as const),
          }
          : {}),
        ...(postedAt > 0 ? { postedAt } : {}),
        ...(str(evt.postedAtText) ? { postedAtText: str(evt.postedAtText).slice(0, 60) } : {}),
        ...(str(evt.ambiguous) ? { ambiguous: str(evt.ambiguous).slice(0, 120) } : {}),
      }
      if (list.length >= MAX_SIGHTINGS) {
        // ⚠ 상한에 닿았다고 **무조건 버리지 않는다.** 확인 에이전트는 보통 홈 피드 → 탐색 → 프로필
        //   순으로 돌아다니는데, 앞선 페이지에서 쓸모없는 근거(모호·작성자 없음)가 상한을 채우면
        //   **마지막에 도달한 프로필의 진짜 근거가 조용히 버려진다**. 결과는 안전한 쪽(모름)이지만,
        //   자동 확인이 "왜 안 되는지 모르게" 죽고 사용자에겐 무관한 사유만 나열된다.
        //   판정에 쓰일 가능성이 낮은 것부터 밀어낸다.
        const weakIdx = list.findIndex((s) => s.ambiguous || !s.author)
        if (weakIdx < 0) return          // 전부 쓸모 있는 근거면 새것을 버린다(기존 보존)
        list.splice(weakIdx, 1)
      }
      list.push(next)
      markDirty(task)
      return
    }
    // waitKind 는 setState **전에** 정한다 — 'changed' 를 받은 쪽이 곧바로 confirmTask 를 불러도
    // 기다리는 대상이 이미 지정돼 있어야 응답이 엉뚱한 곳으로 가지 않는다.
    case 'confirm': {
      setWaiting(task, 'agent-confirm', 'confirm', `확인이 필요합니다: ${str(evt.label, '되돌릴 수 없는 동작')}`)
      return
    }
    case 'ask': {
      // 로그인/CAPTCHA 로 넘어온 대기는 사유를 눈에 띄게 구분한다 — 사용자가 "내가 브라우저에서 직접
      // 해야 하는 일" 임을 바로 알아야 한다(그냥 질문과 성격이 다르다).
      const isChallenge = evt.challenge === 'login' || evt.challenge === 'captcha'
      const prefix = evt.challenge === 'captcha' ? '🧩 사람 확인이 필요합니다 — '
        : evt.challenge === 'login' ? '🔐 로그인이 필요합니다 — ' : ''
      // 사유를 **영속**으로 남긴다 — 재시작 뒤에도 "로그인/사람 확인이 필요했다" 가 유지돼야 한다.
      const cause: WaitCause = evt.challenge === 'captcha' ? 'captcha' : evt.challenge === 'login' ? 'login' : 'ask'
      setWaiting(task, 'agent-ask', cause,
        prefix + str(evt.message, isChallenge ? '직접 처리한 뒤 이어가기를 눌러 주세요.' : '추가 정보가 필요합니다.'))
      // 사용자가 가야 할 곳이 분명하면(저장된 계정 등록·허용) 버튼으로 띄울 수 있게 함께 싣는다.
      // browser:// 내부 페이지만 허용 — 페이지가 만든 문자열이 외피 버튼으로 흘러들지 않게 한다.
      if (typeof evt.actionUrl === 'string' && evt.actionUrl.startsWith('browser://')) {
        task.waitActionUrl = evt.actionUrl
        task.waitActionLabel = str(evt.actionLabel, '설정 열기').slice(0, 40)
      }
      return
    }
    // 감지 사실 자체는 트레이스로만 남긴다(상태 전환은 바로 뒤따르는 'ask' 가 한다).
    case 'challenge': return
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
        reportTitle: str(evt.reportTitle),
        reportMarkdown: str(evt.reportMarkdown),
      }
      // 구간마다 덮어써서 **가장 최근에 조립된** 부분 보고서를 들고 간다(노트는 누적이므로 최신이 가장 완전하다).
      // 파일은 작업이 실제로 끝날 때 한 번만 쓴다 — 구간마다 쓰면 긴 작업 하나가 파일 수십 개를 쏟아낸다.
      if (trace.exhausted.reportMarkdown) {
        const rt2 = runtimeOf(task.id)
        rt2.pendingReport = { title: trace.exhausted.reportTitle || '분석 보고서 (부분)', markdown: trace.exhausted.reportMarkdown }
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
      // 산출물 바구니 = 이 작업. 구간이 바뀌어도 같은 폴더에 쌓이고, 다른 작업은 닿지 못한다.
      taskId: task.id,
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
  /** 이 저장이 어느 탭을 기준으로 이뤄졌는가 — 넘기면 복원 안정 키(tabKey/windowKey)도 함께 갱신한다. */
  tabId?: string
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
  // 재바인딩으로 실제 조작 대상이 달라졌을 수 있다 — 이번에 실제로 쓴 탭 기준으로 키를 다시 맞춘다.
  if (args.tabId) syncCheckpointKeys(cp, args.tabId)
  cp.savedAt = Date.now()

  task.updatedAt = cp.savedAt
  markDirty(task)
  emitChanged()
}

// ===== 구간 루프 =====

function toInterrupted(task: PersistentTask, reason: string): void {
  // 여기가 "작업이 실제로 멈추는" 자리다 — 구간마다 모아 둔 부분 보고서를 **이제** 한 번 쓴다.
  // (agent.ts 는 구간 모드에서 파일을 쓰지 않는다. 예전처럼 구간마다 쓰면 25분 작업 하나가
  //  사용자 다운로드 폴더에 보고서 25개를 남긴다 — 실측으로 확인된 문제다.)
  void flushPendingReport(task)
  setState(task, 'interrupted', `${reason} 이어서 진행할 수 있습니다.`)
}

/** 모아 둔 부분 보고서를 파일로 한 번 쓰고 결과 파일 목록에 더한다. 실패해도 작업 흐름을 막지 않는다. */
async function flushPendingReport(task: PersistentTask): Promise<void> {
  const rt = runtimes.get(task.id)
  const pending = rt?.pendingReport
  if (!rt || !pending) return
  rt.pendingReport = null   // 두 번 쓰지 않도록 먼저 비운다
  try {
    const host = (() => { try { return new URL(task.checkpoint.tabUrl ?? '').hostname || '사이트' } catch { return '사이트' } })()
    const saved = await writeDownloadMd(safeFileName(`보고서-${host}-${reportStampNow()}`), pending.markdown)
    if (saved.ok && saved.path) {
      addResultFiles(task, [saved.path])
      taskEvents.emit('event', { taskId: task.id, type: 'report', title: pending.title, notes: 0, path: saved.path })
    }
  } catch (err) {
    console.warn('[task-runtime] 부분 보고서 저장 실패', err)
  }
}

/** 파일명용 시각 도장 — agent.ts 의 reportStamp 와 같은 모양(YYYYMMDD-HHmm). */
function reportStampNow(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
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
        setWaiting(task, 'ledger', 'ledger',
          `발행이 됐는지 확실하지 않습니다 — 확인해 주세요. (마지막 동작: ${pending.label})`
          + ' 이미 올라갔다면 중단하시고, 아직이라면 계속을 눌러 주세요.')
        break
      }

      // 3. 탭 재바인딩
      const bind = await resolveTaskTab(task)

      // ⚠ 재바인딩은 **기다릴 수 있다**(잠든 복원 탭을 깨우느라 최대 15초). 그 사이 사용자가 누른
      //    중단·일시정지가 여기서 유실되면, 멈추라고 해 놓고 12단계짜리 구간이 그대로 실행된다 —
      //    이 시점엔 아직 reqId 가 없어 cancelAgentTask 로도 못 막는다. 그래서 **부작용 직전 관문**을
      //    여기 하나 더 둔다(resolveTaskTab 이 동기였을 때는 이 창이 없었다).
      const afterBind = getTask(id)
      if (!afterBind || afterBind.state !== 'running') break

      if (bind.tabId === null) {
        // 대상을 다시 찾지 못한 것(needsTarget)과, 찾을 대상 자체가 없는 것(창이 없음 등)을
        // 같은 'user-fix' 로 뭉치지 않는다 — 전자는 외피가 대상 선택 패널을 띄워야 한다.
        setWaiting(
          task,
          bind.needsTarget ? 'tab-target' : 'user-fix',
          bind.needsTarget ? 'tab-target' : 'user-fix',
          bind.reason,
        )
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
      if (bind.note) saveCheckpoint(task, { stepsUsed: stepsBefore, note: bind.note, tabUrl: currentUrlOf(bind.tabId), tabId: bind.tabId })

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
          tabId: bind.tabId,
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
          tabId: bind.tabId,
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
        saveCheckpoint(live, { stepsUsed: observedSteps, tabUrl: currentUrlOf(bind.tabId), tabId: bind.tabId })
        if (!isTerminal(live.state)) setState(live, 'cancelled')
        break
      }

      // error 또는 결과 없이 끝난 구간
      const detail = outcome.kind === 'error'
        ? str(outcome.message, '알 수 없는 오류')
        : '구간이 결과를 남기지 않고 끝났습니다.'
      saveCheckpoint(live, { stepsUsed: observedSteps, tabUrl: currentUrlOf(bind.tabId), tabId: bind.tabId })

      const kind = classifyRetry(detail)
      if (BACKOFF_MS[kind].length === 0) {
        // 사람만 풀 수 있는 원인(탭 닫힘·로그인) — 재시도로 태우지 않고 기다린다.
        // 두 경우 모두 waitKind 는 'user-fix' 로 둔다: 조치를 마친 사용자가 confirmTask(id, true) 로
        // 이어갈 수 있어야 한다(waitKind 가 null 이면 startTask 는 waiting-user 를 거부해
        // 되살릴 방법이 없는 막다른 길이 된다). 다만 **사유**는 둘을 구분해 영속한다 —
        // 재시작 뒤 사용자가 "로그인하라는 거였나, 탭이 닫힌 거였나" 를 알아야 한다.
        setWaiting(live, 'user-fix', kind === 'login' ? 'login' : 'user-fix', waitMessageFor(kind, detail))
        break
      }
      // ⚠ **미확인 외부 쓰기가 있으면 자동 재시도하지 않는다.** 발행·댓글을 이미 눌렀는데 그 결과를
      //   못 본 채 오류가 났다면, 서버에는 이미 반영됐을 수 있다(응답만 유실). 그 상태에서 자동으로
      //   다시 돌리면 같은 글을 두 번 올릴 위험을 기계가 떠안는다 — 그건 사람의 결정이어야 한다.
      //   (구간 시작의 원장 관문이 결국 잡기는 했지만, 그전까지 상태가 "재시도 중" 으로 표시돼
      //    사용자에게 **진행 중인 것처럼** 보였고 backoff 도 헛되이 태웠다.)
      const uncertain = pendingExternalWrite(live)
      if (uncertain) {
        setWaiting(live, 'ledger', 'ledger',
          `오류로 중단됐는데(${detail.slice(0, 120)}) 발행이 됐는지 확실하지 않습니다 — 확인해 주세요.`
          + ` (마지막 동작: ${uncertain.label}) 이미 올라갔다면 중단하시고, 아직이라면 계속을 눌러 주세요.`)
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

/**
 * 이 작업의 이어가기를 막는다(또는 `null` 로 푼다). 원인은 이 파일이 몰라도 된다 — 예컨대
 * social-workflow.ts 는 게시 작업이 `interrupted` 로 끝났는데 완료 근거가 없을 때(게시됐는지
 * 확인이 안 될 때) 이걸로 이어가기를 막아 중복 게시를 막는다. 사용자가 게시 여부를 직접 확인하기
 * 전까지는 startTask/resumeTask 둘 다 이 작업을 다시 실행하지 못한다(아래 두 함수 참고).
 *
 * 같은 값이 이미 반영돼 있으면 다시 쓰지 않는다 — taskEvents 는 잦게 발생하므로, 멱등이 아니면
 * 호출자가 매 tick 마다 이 함수를 불러도 무의미한 저장·재알림이 반복된다.
 */
export function setResumeBlock(taskId: string, reason: string | null): void {
  const task = getTask(taskId)
  if (!task) return
  const next = reason ? reason.trim().slice(0, 300) : ''
  const cur = task.resumeBlockedReason ?? ''
  if (cur === next) return
  if (next) task.resumeBlockedReason = next
  else delete task.resumeBlockedReason
  task.updatedAt = Date.now()
  markDirty(task)
  emitChanged()
}

/**
 * 시작/이어가기의 결과. **거절을 조용히 삼키지 않는다** — 예전에는 두 함수가 `void` 라
 * IPC 가 무조건 `{ok:true}` 를 돌려줬고, 차단이 제대로 걸린 경우에도 화면에는 "성공" 으로 보였다
 * (사용자는 버튼을 눌러도 아무 일이 없는 이유를 알 수 없고, 검사는 차단을 확인할 수 없었다).
 */
export interface StartResult { ok: boolean; error?: string }

export function startTask(id: string): StartResult {
  const task = getTask(id)
  if (!task) return { ok: false, error: '작업을 찾을 수 없습니다.' }
  if (task.state !== 'queued' && task.state !== 'interrupted' && task.state !== 'paused') {
    return { ok: false, error: `지금 상태(${task.state})에서는 시작할 수 없습니다.` }
  }
  // startTask 도 'interrupted' 를 실행 상태로 되돌릴 수 있는 경로다 — resumeTask 와 같은 관문을 둔다
  // (관문이 한쪽에만 있으면 다른 쪽으로 우회해 차단이 무력화된다).
  if (task.resumeBlockedReason) return { ok: false, error: task.resumeBlockedReason }
  beginRun(task)
  return { ok: true }
}

export function resumeTask(id: string): StartResult {
  const task = getTask(id)
  if (!task) return { ok: false, error: '작업을 찾을 수 없습니다.' }
  if (task.state !== 'paused' && task.state !== 'interrupted') {
    return { ok: false, error: `지금 상태(${task.state})에서는 이어갈 수 없습니다.` }
  }
  // 게시 여부가 불확실한 채로 이어가면 중복 게시 위험이 있다 — social-workflow.ts 가 세운 차단을
  // 사용자가 먼저 풀어야 한다(resolvePublishUncertainty 로).
  if (task.resumeBlockedReason) return { ok: false, error: task.resumeBlockedReason }
  beginRun(task)
  return { ok: true }
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

// ===== 대상 탭 재선택 (waitCause 'tab-target') =====

export interface TaskTargetCandidate {
  tabId: string
  title: string
  url: string
  windowId: string
  windowLabel: string
  active: boolean
  /** 체크포인트가 기억하던 원래 대상과 같은 페이지인가 — 목록 맨 위로 정렬해 눈에 띄게 한다. */
  sameUrl: boolean
}

export interface TaskTargetList {
  ok: boolean
  reason: string
  expected: { url: string | null; windowLabel: string | null; workspaceName: string | null }
  tabs: TaskTargetCandidate[]
}

const EMPTY_TARGET_LIST: TaskTargetList = {
  ok: false, reason: '작업을 찾을 수 없습니다.',
  expected: { url: null, windowLabel: null, workspaceName: null }, tabs: [],
}

/**
 * 이 작업이 다시 붙을 수 있는 탭 후보를 고른다. **메인이 정본** — 렌더러가 이 목록에서 고른 tabId 만
 * `setTaskTarget` 이 다시 검증해 받아들인다(렌더러가 임의 tabId 를 지어내도 통과하지 못한다).
 */
export function listTaskTargets(id: string): TaskTargetList {
  const task = getTask(id)
  if (!task) return EMPTY_TARGET_LIST

  const cp = task.checkpoint
  let wsId = cp.workspaceId
  let reason = ''
  if (wsId && !getWorkspace(wsId)) {
    // 원래 워크스페이스가 사라졌다 — 활성 워크스페이스로 완화하되 그 사실을 숨기지 않는다.
    // 시크릿 작업은 전역 워크스페이스 개념이 없으므로 완화하지 않고 그냥 워크스페이스 제한을 푼다.
    reason = '원래 워크스페이스가 사라져 활성 워크스페이스에서 대신 찾았습니다. '
    wsId = task.incognito ? null : getActiveWorkspaceId()
  }

  const allowedHosts = task.budget.allowedHosts
  const expectedUrl = cp.tabUrl

  const candidates = getAllTabs()
    .filter((t) => isIncognitoTab(t.id) === task.incognito)
    .filter((t) => (wsId ? t.workspaceId === wsId : true))
    .filter((t) => /^https?:/i.test(t.url))   // 잠든 탭도 원본 URL 이 보존돼 있으면 포함(summary() 가 채워 줌)
    .filter((t) => hostInAllowList(t.url, allowedHosts))
    .map((t) => ({
      t,
      sameUrl: !!expectedUrl && sameTarget(expectedUrl, t.url),
      hostMatch: !!expectedUrl && sameHost(expectedUrl, t.url),
    }))
    .sort((a, b) => {
      const rank = (x: { sameUrl: boolean; hostMatch: boolean }): number => (x.sameUrl ? 0 : x.hostMatch ? 1 : 2)
      return rank(a) - rank(b)
    })

  const expectedWindowId = resolveCurrentWindowId(cp, task.ownerWindowId)

  return {
    ok: true,
    reason,
    expected: {
      url: expectedUrl ?? null,
      windowLabel: expectedWindowId ? windowLabelOf(expectedWindowId) : null,
      workspaceName: wsId ? (getWorkspace(wsId)?.name ?? null) : null,
    },
    tabs: candidates.map(({ t, sameUrl }) => ({
      tabId: t.id, title: t.title, url: t.url, windowId: t.windowId,
      windowLabel: windowLabelOf(t.windowId), active: t.active, sameUrl,
    })),
  }
}

/**
 * 사용자가 대상 탭을 직접 고른다. **이것은 승인 관문이 아니다** — "어디서 이어갈지" 만 정할 뿐,
 * 위험 동작 확인(waitCause 'confirm')·발행 불확실 원장('ledger')은 이 함수가 손대지 않는다.
 * 다음 구간이 시작되면 그 관문들이 **다시** 걸린다(에이전트 가드는 매 동작마다 독립적으로 판정한다).
 */
export function setTaskTarget(id: string, tabId: string): { ok: boolean; error?: string } {
  const task = getTask(id)
  if (!task) return { ok: false, error: '작업을 찾을 수 없습니다.' }
  if (task.state !== 'waiting-user' && task.state !== 'interrupted') {
    return { ok: false, error: `지금 상태(${task.state})에서는 대상을 선택할 수 없습니다.` }
  }

  // **대상 선택은 'tab-target' 대기의 출구일 뿐이다.** 이 문을 열어 두면 결제 승인(`agent-confirm`)이나
  // 발행 불확실(`ledger`)을 기다리던 작업에서도 이 함수가 불릴 수 있고, 그러면 ① 기다리던 쪽(에이전트)
  // 이 영영 응답을 못 받아 구간이 멈추고 ② `waitCause` 가 지워져 "무엇을 기다리다 멈췄는지" 라는
  // 사용자 신호까지 사라진다. 재시작 뒤에는 runtime 이 비어 있으므로 저장된 `waitCause` 로도 본다.
  const rtNow = runtimeOf(id)
  if (task.waitCause !== 'tab-target' && rtNow.waitKind !== 'tab-target') {
    return { ok: false, error: '지금은 대상 탭을 고를 수 없습니다 — 다른 확인을 기다리는 중입니다.' }
  }

  const chosen = String(tabId ?? '').trim()
  if (!chosen) return { ok: false, error: '탭을 선택해 주세요.' }

  // 목록에 실제로 있는 후보인지 먼저 확인한다(렌더러가 준 tabId 를 그대로 믿지 않는다).
  const list = listTaskTargets(id)
  if (!list.tabs.some((t) => t.tabId === chosen)) {
    return { ok: false, error: '유효하지 않은 대상입니다 — 목록을 다시 불러와 주세요.' }
  }
  // 목록 생성 이후 그 탭이 닫혔거나 경계가 바뀌었을 수 있다 — 실행 직전에 한 번 더 검증한다.
  if (isIncognitoTab(chosen) !== task.incognito) {
    return { ok: false, error: '시크릿 경계가 달라 선택할 수 없습니다.' }
  }
  const tabSummary = getTab(chosen)
  if (!tabSummary) return { ok: false, error: '그 탭이 방금 닫혔습니다 — 목록을 다시 불러와 주세요.' }

  const cp = task.checkpoint
  cp.tabUrl = tabSummary.url || cp.tabUrl
  if (tabSummary.workspaceId) cp.workspaceId = tabSummary.workspaceId
  syncCheckpointKeys(cp, chosen)

  const rt = runtimeOf(id)
  rt.lastTabId = chosen
  rt.waitKind = null   // 'user-fix' 경로(confirmTask)로는 이 대기를 풀 수 없다 — 이 함수가 유일한 출구다.

  delete task.waitActionUrl
  delete task.waitActionLabel
  // setState 는 next==='running' 일 때만 waitCause 를 지운다 — 'interrupted' 로 갈 때는 그대로
  // 남기므로(재시작 뒤 "왜 멈췄는지" 문구를 보존하기 위한 설계, initTaskRuntime 참고) 여기서 직접 지운다.
  // 대상을 골랐다는 것 자체가 'tab-target' 사유가 끝났다는 뜻이다.
  delete task.waitCause
  // ⚠ 여기서 승인 관문을 통과시키지 않는다 — resumeBlockedReason 은 그대로 둔다.
  //   (게시 여부 확인 등 다른 이유로 이어가기가 막혀 있었다면, 대상만 바뀌었을 뿐 그 차단은 유효하다.)
  setState(task, 'interrupted', '대상 탭을 선택했습니다 — 이어가기를 누르면 그 탭에서 계속합니다.')
  return { ok: true }
}
