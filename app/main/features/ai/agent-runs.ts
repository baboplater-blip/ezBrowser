import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { createJsonStore, loadJsonObject } from './json-store'

// 에이전트 실행 이력 — 에이전트가 수행한 작업(지시·단계·결과)을 저장해 나중에 되짚어볼 수 있게 한다.
// 메인에서 기록하므로 사이드바를 닫아도 남는다. userData/ai-agent-runs.json.
// 저장 기전(디바운스·원자적 쓰기·손상 복구)은 json-store.ts 가 맡는다 — 그 파일의 머리말 참고.

// 'interrupted' = 단계 예산을 다 썼지만 작업은 끝나지 않음 — **성공이 아니다**.
// 예전에는 단계 소진 시 agent.ts 가 done 을 내보내 이 목록에 ✅ 로 남았다(사용자가 "됐다"고 오해).
// 'paused' = 사용자가 일시정지한 상태로 남은 실행.
export type AgentRunStatus = 'running' | 'done' | 'error' | 'cancelled' | 'interrupted' | 'paused'
export interface AgentRunStep { icon: string; text: string; tone?: 'ok' | 'warn' | 'muted' }
export interface AgentRun {
  id: string
  task: string
  startedAt: number
  endedAt?: number
  status: AgentRunStatus
  steps: AgentRunStep[]
  result?: string
  // 토큰 합계(CLI 세션 경로가 스텝마다 usage 를 방출할 때만 채워진다) — 효율 벤치·사용자 확인용.
  usage?: { input: number; cacheRead: number; cacheCreate: number; output: number; llmCalls: number }
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
const FILE_NAME = 'ai-agent-runs.json'

let cache: AgentRun[] | null = null
let quitHooked = false

const store = createJsonStore({
  fileName: FILE_NAME,
  label: '실행 이력',
  debounceMs: 400,
  snapshot: () => ({ version: 1, runs: all() }),
})

function isValid(r: unknown): r is AgentRun {
  if (!r || typeof r !== 'object') return false
  const o = r as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.task === 'string' && Array.isArray(o.steps)
}

export function initAgentRuns(): void {
  if (!quitHooked) { quitHooked = true; try { app.on('before-quit', flushAgentRuns) } catch { /* ignore */ } }
  if (cache !== null) return

  // 파일을 통째로 못 읽으면 loadJsonObject 가 고유 이름 백업을 남기고 null 을 준다.
  // (예전에는 백업 없이 빈 상태로 시작해, 다음 저장이 손상 파일을 영구히 덮어썼다.)
  const raw = loadJsonObject(FILE_NAME, '실행 이력', 'runs')
  if (!raw) { cache = []; return }

  const rawRuns = Array.isArray(raw.runs) ? raw.runs : []
  cache = rawRuns.filter(isValid)
  // 파싱은 됐지만 일부 항목이 망가진 경우 — 정상 항목은 복구하고 버린 개수를 알린다.
  store.reportDropped(rawRuns.length - cache.length, cache.length)
  // 재시작 시 'running'/'paused' 로 남은 것은 **중단(interrupted)** 으로 정리한다.
  // 예전에는 'cancelled'(사용자가 취소한 것과 같은 표시)로 뭉갰다 — 크래시로 끊긴 것과
  // 사용자가 직접 중단한 것은 다른 사건이고, 전자는 이어갈 수 있어야 한다.
  for (const r of cache) {
    if (r.status === 'running' || r.status === 'paused') {
      r.status = 'interrupted'
      r.endedAt = r.endedAt ?? r.startedAt
      if (!r.result) r.result = '브라우저가 예기치 않게 종료돼 중단됐습니다(이어가기 가능)'
    }
  }
}

function all(): AgentRun[] {
  if (cache === null) initAgentRuns()
  return cache ?? []
}

function schedulePersist(): void {
  store.markDirty()
}

export function flushAgentRuns(): void {
  store.flush()
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

// 실행 이력은 디스크에 평문으로 남는다. 비밀번호·카드번호·토큰처럼 남으면 안 되는 값은 가린다.
const CARD_LIKE = /\b(?:\d[ -]?){13,19}\b/g
const TOKEN_LIKE = /\b(?:sk|pk|ghp|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._-]{12,}/gi
// 공백 없이 이어진 12자 이상 + 숫자·기호가 섞인 문자열 = 비밀번호일 가능성이 높다(URL·이메일은 제외).
const PASSWORD_LIKE = /(?<![\w./:@-])(?!https?:\/\/|www\.)(?=[^\s]{12,})(?=[^\s]*\d)(?=[^\s]*[^\w\s])(?![^\s]*@)[^\s]{12,}(?![\w./-])/g

function maskSecrets(text: string): string {
  return String(text ?? '')
    .replace(TOKEN_LIKE, '[가림: 토큰]')
    .replace(CARD_LIKE, '[가림: 번호]')
    .replace(PASSWORD_LIKE, '[가림]')
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
    // 사용자 답변은 디스크(ai-agent-runs.json)에 영구 저장된다 → 비밀번호·카드번호가 평문으로 남지 않게 가린다.
    case 'answer': return { icon: '🗣️', text: `답변: ${maskSecrets(s('text'))}`, tone: 'muted' }
    case 'report': return { icon: '📄', text: `보고서: ${s('title')} (노트 ${s('notes')}개)`, tone: 'ok' }
    case 'done': return { icon: '🏁', text: s('message') || '완료', tone: 'ok' }
    case 'error': return { icon: '❌', text: s('message') || '오류', tone: 'warn' }
    case 'cancelled': return { icon: '⏹️', text: '중단됨', tone: 'muted' }
    // 단계 예산 소진 — 완료가 아니라 "여기까지" 다. tone 을 ok 로 주지 않는다.
    case 'exhausted': return { icon: '⏳', text: `단계 ${s('stepsUsed')}까지 진행 — 아직 완료하지 못했습니다`, tone: 'warn' }
    case 'paused': return { icon: '⏸️', text: '일시정지 — 페이지 조작을 멈췄습니다', tone: 'muted' }
    case 'resumed': return { icon: '▶️', text: '재개', tone: 'muted' }
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

  if (evt.type === 'usage') {
    const n = (k: string): number => (typeof evt[k] === 'number' ? (evt[k] as number) : 0)
    const u = run.usage ?? { input: 0, cacheRead: 0, cacheCreate: 0, output: 0, llmCalls: 0 }
    u.input += n('input'); u.cacheRead += n('cacheRead'); u.cacheCreate += n('cacheCreate'); u.output += n('output'); u.llmCalls++
    run.usage = u
    schedulePersist()
    return
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
  // 단계 소진을 **성공으로 기록하지 않는다**. 이어갈 수 있다는 뜻의 'interrupted' 로 남긴다.
  else if (evt.type === 'exhausted') {
    run.status = 'interrupted'; run.endedAt = Date.now()
    run.result = `단계 ${String(evt.stepsUsed ?? '')}까지 진행 — 완료하지 못했습니다(이어가기 가능)`
    transitioned = true
  }
  // 일시정지는 종료가 아니다 — endedAt 을 찍지 않는다(재개하면 계속 같은 실행).
  else if (evt.type === 'paused') { run.status = 'paused'; transitioned = true }
  else if (evt.type === 'resumed') { run.status = 'running'; transitioned = true }

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
