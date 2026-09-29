// AiTab 이 쓰는 타입·상수·순수 헬퍼 함수 모음 (묶음 K — AiTab.tsx 2,388줄 분할).
// 동작 변경 없는 순수 이동 — AiTab.tsx 에서 그대로 옮겨졌다. React 상태·IPC 구독 없음.
import type { AiProviderDetection } from '../../../shared/types'

// i18n(묶음 M2) — 이 파일은 컴포넌트가 아니라 순수 함수 모음이라 useI18nT() 훅을 쓸 수 없다.
// 호출부(AiTab.tsx·TaskCard.tsx)가 useI18nT() 로 얻은 번역 함수를 인자로 넘긴다.
// 변수명은 `tr` — 이 영역의 TaskSummary/RepeatSummary 는 관례적으로 `t` 라는 이름을 쓰므로
// (예: ptasks.map((t) => ...), TaskCard 의 t: TaskSummary prop) 충돌을 피하기 위함.
export type TFn = (key: string, fallback?: string, vars?: Record<string, string | number>) => string

export type Role = 'user' | 'assistant'
export interface ChatMessage {
  id: string
  role: Role
  content: string
  streaming?: boolean
  error?: boolean
  reqId?: string
}

export interface AiConfig {
  enabled: boolean
  provider: 'anthropic' | 'openai' | 'ollama' | 'google' | 'claude-code' | 'codex' | 'gemini-cli'
  providerLabel: string
  model: string
  hasKey: boolean
  storageAvailable: boolean
}

export interface PageInfo { url: string; title: string; hasSelection: boolean }

/** 비용을 숨기지 않는다 — 고르기 전에 무엇이 드는지 먼저 보인다. */
export function costLabel(tr: TFn, cost: AiProviderDetection['candidates'][number]['cost']): string {
  switch (cost) {
    case 'subscription': return tr('ai.shared.cost.subscription', '구독 계정 · 추가 요금 없음')
    case 'free-local': return tr('ai.shared.cost.freeLocal', '내 컴퓨터 · 무료')
    case 'free-tier': return tr('ai.shared.cost.freeTier', '무료 티어')
    case 'paid-key': return tr('ai.shared.cost.paidKey', '사용한 만큼 과금')
    default: return cost
  }
}
export interface TraceItem { id: string; icon: string; text: string; tone?: 'ok' | 'warn' | 'muted'; shot?: string }
export interface ConvSummary { id: string; title: string; updatedAt: number; messageCount: number; folderId: string | null; tags: string[]; pinned: boolean }
export interface ChatFolder { id: string; name: string; createdAt: number; color: string; emoji?: string }
// 폴더 색(외피 탭 그룹과 동일 팔레트) — 좁은 폭에서 폴더를 색 점으로 구분.
export const FOLDER_HEX: Record<string, string> = {
  red: '#E5484D', orange: '#F76808', yellow: '#FFB224', green: '#30A46C',
  blue: '#3478F6', purple: '#8E4EC6', pink: '#E93D82', gray: '#8E8E93',
}
export const FOLDER_PALETTE: string[] = ['blue', 'red', 'green', 'yellow', 'purple', 'pink', 'orange', 'gray']
export const FOLDER_EMOJIS: string[] = ['⭐', '💼', '🔖', '📚', '💡', '🎯', '🗂️', '🔥']
export const folderHex = (c?: string): string => FOLDER_HEX[c ?? 'gray'] ?? '#8E8E93'

// 검색어를 텍스트 안에서 <mark> 로 감싼 React 노드 배열(XSS 안전 — dangerouslySetInnerHTML 안 씀).
export function highlightNodes(text: string, query: string): React.ReactNode {
  const q = query.trim()
  if (!q) return text
  const lower = text.toLowerCase(), lq = q.toLowerCase()
  const parts: React.ReactNode[] = []
  let i = 0, k = 0
  while (i <= text.length) {
    const idx = lower.indexOf(lq, i)
    if (idx < 0) { parts.push(text.slice(i)); break }
    if (idx > i) parts.push(text.slice(i, idx))
    parts.push(<mark key={k++} className="ai-hl">{text.slice(idx, idx + q.length)}</mark>)
    i = idx + q.length
  }
  return parts
}
export interface SavedTask { id: string; name: string; task: string; createdAt: number; lastRunAt?: number }
// 'interrupted'·'paused' 는 task-runtime(영속 작업) 도입으로 추가 — 단계를 다 쓰고 끝난 실행을
// 성공(done=✅)으로 남기지 않기 위해서다(T3: 단계 소진 ≠ 성공). 이력에는 "미완료"로 정직하게 남는다.
export type RunStatus = 'running' | 'paused' | 'interrupted' | 'done' | 'error' | 'cancelled'
export interface RunSummary { id: string; task: string; startedAt: number; endedAt?: number; status: RunStatus; stepCount: number }
export interface RunStep { icon: string; text: string; tone?: 'ok' | 'warn' | 'muted' }
export interface RunDetail { id: string; task: string; startedAt: number; endedAt?: number; status: RunStatus; steps: RunStep[]; result?: string }
export function runStatusInfo(tr: TFn, status: RunStatus): { icon: string; label: string } {
  switch (status) {
    case 'running': return { icon: '◔', label: tr('ai.shared.runStatus.running', '진행 중') }
    case 'paused': return { icon: '⏸️', label: tr('ai.shared.runStatus.paused', '일시정지') }
    case 'interrupted': return { icon: '⏳', label: tr('ai.shared.runStatus.interrupted', '미완료') }
    case 'done': return { icon: '✅', label: tr('ai.shared.runStatus.done', '완료') }
    case 'error': return { icon: '❌', label: tr('ai.shared.runStatus.error', '오류') }
    case 'cancelled': return { icon: '⏹️', label: tr('ai.shared.runStatus.cancelled', '중단') }
  }
}
export interface RepeatSummary {
  id: string; task: string; intervalMs: number; totalCount: number; doneCount: number
  autoConfirm: boolean; status: 'running' | 'waiting' | 'stopped' | 'finished'; nextAt: number | null; lastResult?: string
  resumable?: boolean  // 재시작 후 자동 부활하지 않고 멈춘 반복(T10) — 사용자가 명시적으로 다시 시작해야 함
}

// ===== 영속 작업(task-runtime) — 단계 소진·크래시에도 이어갈 수 있는 실행 =====
// 단계 소진(exhausted)이 완료가 아니듯, 여기서도 "끝났다"와 "성공했다"를 절대 같은 뜻으로 쓰지 않는다.
export type TaskState =
  | 'queued' | 'running' | 'paused' | 'waiting-user' | 'retrying'
  | 'interrupted' | 'needs-verify' | 'completed' | 'failed' | 'cancelled'
export interface TaskRetryInfo { kind: string; attempt: number; nextAt: number; detail: string }
// 무엇을 기다리다 멈췄는가 — 재시작(interrupted)을 넘어 보존된다. 없으면(옛 저장본) 일반 문구로 폴백한다.
// 'tab-target' = 재시작 뒤 **원래 그 탭**을 다시 찾지 못했다. 예전에는 같은 사이트의 아무 탭에나
// 붙었는데(엉뚱한 글·다른 계정 세션에 작용할 수 있었다) 이제는 사람이 직접 고르게 한다.
export type TaskWaitCause = 'confirm' | 'login' | 'captcha' | 'ask' | 'ledger' | 'user-fix' | 'tab-target'
export interface TaskSummary {
  id: string; instruction: string; state: TaskState; mode: 'normal' | 'long'
  stepsUsed: number; maxSteps: number; segment: number
  elapsedMs: number; startedAt: number; endedAt?: number
  waitReason?: string; waitActionUrl?: string; waitActionLabel?: string; waitCause?: TaskWaitCause; retry?: TaskRetryInfo
  llmCalls: number; maxLlmCalls: number
  result?: string; resultFiles: string[]; needsVerify: boolean
}
// 대기 사유별 안내 — 재시작으로 중단(interrupted)됐을 때 "왜 멈췄는지"를 무해한 일반 문구 뒤에
// 숨기지 않기 위한 사유별 문구. 승인 대기 중이던 결제·삭제 같은 위험 동작을 사람이 놓치지 않게 한다.
export function waitCauseInfo(tr: TFn, cause: TaskWaitCause): { icon: string; title: string; hint?: string } {
  switch (cause) {
    case 'confirm': return {
      icon: '⏸️', title: tr('ai.shared.waitCause.confirm.title', '승인이 필요했던 동작에서 멈췄습니다'),
      hint: tr('ai.shared.waitCause.confirm.hint', '이어가면 자동 승인되지 않습니다 — 다시 확인을 요청합니다.'),
    }
    case 'login': return {
      icon: '🔐', title: tr('ai.shared.waitCause.login.title', '로그인이 필요합니다'),
      hint: tr('ai.shared.waitCause.login.hint', '브라우저에서 직접 로그인한 뒤 이어가세요.'),
    }
    case 'captcha': return {
      icon: '🧩', title: tr('ai.shared.waitCause.captcha.title', '사람 확인이 필요합니다'),
      hint: tr('ai.shared.waitCause.captcha.hint', '직접 처리한 뒤 이어가세요.'),
    }
    case 'ledger': return {
      icon: '⚠', title: tr('ai.shared.waitCause.ledger.title', '게시 여부가 확인되지 않았습니다'),
      hint: tr('ai.shared.waitCause.ledger.hint', '이미 올라갔다면 이어가지 말고 중단하세요.'),
    }
    case 'ask': return { icon: '❓', title: tr('ai.shared.waitCause.ask.title', '답변을 기다리다 멈췄습니다') }
    case 'user-fix': return { icon: '🔧', title: tr('ai.shared.waitCause.userFix.title', '직접 처리가 필요합니다') }
    case 'tab-target': return {
      icon: '🎯', title: tr('ai.shared.waitCause.tabTarget.title', '작업하던 탭을 찾지 못했습니다'),
      hint: tr('ai.shared.waitCause.tabTarget.hint', '어느 탭에서 이어갈지 직접 골라 주세요 — 비슷한 탭을 대신 추측하지 않습니다.'),
    }
  }
}
// 이 사유들은 사람이 브라우저 안에서 직접 뭔가를 해야 풀린다 — '이어가기' 버튼 문구를 그렇게 바꿔
// 눌러도 자동으로 아무 일도 재승인되지 않는다는 것을 알린다('ask' 는 답변만 하면 되므로 제외).
export const NEEDS_MANUAL_ACTION: ReadonlySet<TaskWaitCause> = new Set(['confirm', 'login', 'captcha', 'ledger', 'user-fix', 'tab-target'])
export type TaskPending = { kind: 'confirm'; label: string } | { kind: 'ask'; message: string }
export function taskStateLabel(tr: TFn, state: TaskState): { icon: string; label: string; tone?: 'ok' | 'warn' | 'muted' } {
  switch (state) {
    case 'queued': return { icon: '🕐', label: tr('ai.shared.taskState.queued', '대기 중'), tone: 'muted' }
    case 'running': return { icon: '▶', label: tr('ai.shared.taskState.running', '실행 중') }
    case 'paused': return { icon: '⏸️', label: tr('ai.shared.taskState.paused', '일시정지'), tone: 'muted' }
    case 'waiting-user': return { icon: '❓', label: tr('ai.shared.taskState.waitingUser', '확인 대기'), tone: 'warn' }
    case 'retrying': return { icon: '🔄', label: tr('ai.shared.taskState.retrying', '재시도 대기'), tone: 'warn' }
    case 'interrupted': return { icon: '⏳', label: tr('ai.shared.taskState.interrupted', '미완료'), tone: 'warn' }
    case 'needs-verify': return { icon: '🔍', label: tr('ai.shared.taskState.needsVerify', '확인 필요'), tone: 'warn' }
    case 'completed': return { icon: '✅', label: tr('ai.shared.taskState.completed', '완료'), tone: 'ok' }
    case 'failed': return { icon: '❌', label: tr('ai.shared.taskState.failed', '실패'), tone: 'warn' }
    case 'cancelled': return { icon: '⏹️', label: tr('ai.shared.taskState.cancelled', '중단됨'), tone: 'muted' }
  }
}
export function retryKindLabel(tr: TFn, kind: string): string {
  switch (kind) {
    case 'network': return tr('ai.shared.retryKind.network', '네트워크 오류')
    case 'rate-limit': return tr('ai.shared.retryKind.rateLimit', '요청 한도 초과')
    case 'cli-dead': return tr('ai.shared.retryKind.cliDead', 'CLI 연결 끊김')
    case 'tab-gone': return tr('ai.shared.retryKind.tabGone', '작업 탭이 닫힘')
    case 'login': return tr('ai.shared.retryKind.login', '로그인 필요')
    case 'model': return tr('ai.shared.retryKind.model', '모델 오류')
    case 'unknown': return tr('ai.shared.retryKind.unknown', '알 수 없는 오류')
    default: return kind
  }
}
export function fmtDuration(tr: TFn, ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return tr('ai.shared.duration.seconds', '{s}초', { s })
  const m = Math.floor(s / 60)
  if (m < 60) return tr('ai.shared.duration.minSec', '{m}분 {s}초', { m, s: s % 60 })
  const h = Math.floor(m / 60)
  return tr('ai.shared.duration.hourMin', '{h}시간 {m}분', { h, m: m % 60 })
}
export function repeatStatusText(tr: TFn, r: RepeatSummary): string {
  const of = r.totalCount > 0
    ? tr('ai.shared.repeat.countOf', '{done}/{total}회', { done: r.doneCount, total: r.totalCount })
    : tr('ai.shared.repeat.countUnlimited', '{done}회 (무제한)', { done: r.doneCount })
  if (r.status === 'running') return tr('ai.shared.repeat.running', '실행 중 · {of}', { of })
  if (r.status === 'waiting') {
    const sec = r.nextAt ? Math.max(0, Math.round((r.nextAt - Date.now()) / 1000)) : 0
    const nextIn = sec >= 60
      ? tr('ai.shared.repeat.nextInMin', '{m}분', { m: Math.round(sec / 60) })
      : tr('ai.shared.repeat.nextInSec', '{s}초', { s: sec })
    return tr('ai.shared.repeat.waiting', '대기 · {of} · 다음 {nextIn} 후', { of, nextIn })
  }
  if (r.status === 'finished') return tr('ai.shared.repeat.finished', '완료 · {of}', { of })
  return tr('ai.shared.repeat.stopped', '중지됨 · {of}', { of })
}

export function newId(): string {
  try { return crypto.randomUUID() } catch { return `${Date.now()}-${Math.round(Math.random() * 1e9)}` }
}

// ===== 워크플로 의도 감지 — 백엔드(app/shared/types.ts) 타입을 필요한 만큼만 로컬 미러링
// (AiSocialPanel.tsx 와 동일 관례: 각 컴포넌트가 쓰는 모양만 로컬로 선언 — shared 타입 착지 시점과
// 무관하게 이 파일이 동작한다). 자연어 요청이 기존 생산 워크플로(이미지 생성→SNS 게시, 블로그
// 댓글·좋아요)와 일치하면 평범한 에이전트로 바로 보내지 않고 확인 카드를 먼저 띄운다. =====
export type WorkflowIntentKind = 'image-post' | 'blog-engage'
export interface WorkflowIntent {
  kind: WorkflowIntentKind
  summary: string        // 사용자에게 보여 줄 한 줄 요약
  missing: string[]      // 'platform' | 'account' | 'prompt' | 'topic' | 'maxPosts'
  matched: string[]
  image?: { service: 'genspark' | 'chatgpt' | 'custom'; prompt: string; platform: 'instagram' | 'youtube' | 'tiktok' | null; mode: 'draft' | 'publish'; tags: string[] }
  blog?: { topic: string; myBlogUrl: string; actions: ('comment' | 'like')[]; mode: 'draft' | 'act'; maxPosts: number; searchUrl: string }
}

// 에이전트에 무엇이든 시킬 수 있음을 보여주는 예시 작업(발견성). 클릭하면 입력창에 채워지고, 사용자가
// 자기 사이트에 맞게 다듬어 실행한다(자동 실행 아님 — 되돌리기 어려운 동작은 실행 시 확인 게이트가 잡음).
// task 는 실제로 에이전트에 보내지는 지시문(프롬프트)이라 번역 범위에서 제외 — label(버튼 문구)만 옮긴다.
export function agentExamples(tr: TFn): Array<{ label: string; task: string }> {
  return [
    { label: '📋 ' + tr('ai.shared.example.csv', '목록을 표로 모아 CSV'), task: '이 페이지의 목록을 페이지를 넘겨가며 빠짐없이 표로 수집하고 CSV로 내보내줘.' },
    { label: '📨 ' + tr('ai.shared.example.mail', '안 읽은 메일만 요약'), task: '받은 편지함에서 안 읽은 메일 중 중요한 것만 골라 발신자·제목·핵심을 요약해줘.' },
    { label: '🧾 ' + tr('ai.shared.example.orders', '주문·예약 내역 정리'), task: '내 주문/예약 내역을 최근 순으로 표로 정리해줘(날짜·항목·금액·상태).' },
    { label: '✍️ ' + tr('ai.shared.example.reply', '답글 초안 쓰기'), task: '지금 보고 있는 글/문의에 대한 정중한 답글 초안을 한국어로 써줘(게시하지 말고 초안만).' },
    { label: '🖊 ' + tr('ai.shared.example.form', '폼 자동 작성'), task: '이 페이지의 입력 폼을 내 저장된 프로필 정보로 채워줘(제출은 하지 말고 채우기만).' },
    { label: '🔎 ' + tr('ai.shared.example.find', '원하는 정보 찾기'), task: '이 사이트에서 (원하는 것)을 찾아서 정리해줘.' },
  ]
}

// 수집 데이터 내보내기 헬퍼 — 열 합집합·CSV·다운로드·복사.
export function extractCols(rows: Array<Record<string, string>>): string[] {
  const set = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r)) set.add(k)
  return Array.from(set)
}
export function rowsToCSV(rows: Array<Record<string, string>>): string {
  const cols = extractCols(rows)
  const esc = (v: string): string => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c] ?? '')).join(','))].join('\r\n')
}
export function downloadText(name: string, mime: string, text: string): void {
  try {
    const a = document.createElement('a')
    a.href = `data:${mime};charset=utf-8,` + encodeURIComponent(text)
    a.download = name
    document.body.appendChild(a); a.click(); a.remove()
  } catch { /* ignore */ }
}
export async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text) } catch {
    try { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove() } catch { /* ignore */ }
  }
}

// 대량 처리용 데이터 파싱 — CSV(첫 줄 헤더) 또는 줄 단위 목록(단일 열 '값').
export function splitCSVLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += c }
    else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = '' } else cur += c }
  }
  out.push(cur)
  return out.map((s) => s.trim())
}
export function parseDataset(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return []
  if (lines.some((l) => l.includes(','))) {
    const header = splitCSVLine(lines[0] ?? '')
    return lines.slice(1).map((l) => {
      const cells = splitCSVLine(l); const o: Record<string, string> = {}
      header.forEach((h, i) => { o[h || `열${i + 1}`] = cells[i] ?? '' })
      return o
    }).filter((o) => Object.values(o).some((v) => v))
  }
  return lines.map((l) => ({ 값: l }))
}

// 대화 압축: 활성(안 접힌) 메시지가 THRESHOLD 를 넘으면 앞부분을 요약해 접고, 최근 KEEP 개는 원문 유지.
export const COMPACT_THRESHOLD = 20
export const COMPACT_KEEP = 8

// 챗 입력이 "브라우저를 조작하라"는 명령인지(=에이전트로 넘길지) 판별. 보수적으로 —
// 요약·설명·질문형이면 챗 유지, 명확한 이동/열기/상호작용 의도만 에이전트로 넘긴다.
// 오검지해도 사용자가 ■ 중단으로 즉시 되돌릴 수 있다.
export function looksLikeAgentCommand(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  // 질문·요약·설명 요청이면 챗 유지
  if (/요약|정리해|설명(해|좀|을)|무슨|무엇|뭐(야|예요|인가|니|죠|지)|뭔|어때|어떻게\s*생각|분석해|번역|해석|리뷰|평가해|알려\s*줘|가르쳐|왜|차이(가|는|점)/i.test(t)) return false
  // 브라우저 조작 의도(이동/열기/상호작용)
  return /열어|열기|(으로|로|에)\s*(가|이동|접속)|가\s*줘|가\s*자|이동|접속|들어가|눌러|누르|클릭|입력|채워|적어\s*줘|로그인|로그아웃|제출|스크롤|검색\s*해|찾아\s*(가|서|줘)|추가해\s*줘|담아\s*줘|\bopen\b|go\s*to|navigate|visit\b|\bclick\b|log\s*in|log\s*out|submit\b|scroll\b|search\b|\bfill\b|\btype\b/i.test(t)
}
export function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u }
}
export function relTime(tr: TFn, ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return tr('ai.shared.relTime.now', '방금')
  if (m < 60) return tr('ai.shared.relTime.minutesAgo', '{m}분 전', { m })
  const h = Math.floor(m / 60)
  if (h < 24) return tr('ai.shared.relTime.hoursAgo', '{h}시간 전', { h })
  const d = Math.floor(h / 24)
  if (d < 7) return tr('ai.shared.relTime.daysAgo', '{d}일 전', { d })
  try { return new Date(ts).toLocaleDateString() } catch { return '' }
}

// ===== 대상 탭 다시 고르기 (waitCause 'tab-target') =====
// 백엔드(task-runtime.ts 의 TaskTargetList)를 이 파일이 쓰는 모양만 로컬 미러링 — 이 파일의 관례.
export interface TaskTargetCandidate {
  tabId: string; title: string; url: string
  windowId: string; windowLabel: string; active: boolean; sameUrl: boolean
}
export interface TaskTargetList {
  ok: boolean; reason: string
  expected: { url: string | null; windowLabel: string | null; workspaceName: string | null }
  tabs: TaskTargetCandidate[]
}
