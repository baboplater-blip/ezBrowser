import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiProviderDetection, AiProviderKind, TabSummary } from '../../shared/types'
import { Markdown } from './Markdown'
import { AiWriteStudio } from './AiWriteStudio'

type Role = 'user' | 'assistant'
interface ChatMessage {
  id: string
  role: Role
  content: string
  streaming?: boolean
  error?: boolean
  reqId?: string
}

interface AiConfig {
  enabled: boolean
  provider: 'anthropic' | 'openai' | 'ollama' | 'google' | 'claude-code' | 'codex' | 'gemini-cli'
  providerLabel: string
  model: string
  hasKey: boolean
  storageAvailable: boolean
}

interface PageInfo { url: string; title: string; hasSelection: boolean }

/** 비용을 숨기지 않는다 — 고르기 전에 무엇이 드는지 먼저 보인다. */
const COST_LABEL: Record<AiProviderDetection['candidates'][number]['cost'], string> = {
  subscription: '구독 계정 · 추가 요금 없음',
  'free-local': '내 컴퓨터 · 무료',
  'free-tier': '무료 티어',
  'paid-key': '사용한 만큼 과금',
}
interface TraceItem { id: string; icon: string; text: string; tone?: 'ok' | 'warn' | 'muted'; shot?: string }
interface ConvSummary { id: string; title: string; updatedAt: number; messageCount: number; folderId: string | null; tags: string[]; pinned: boolean }
interface ChatFolder { id: string; name: string; createdAt: number; color: string; emoji?: string }
// 폴더 색(외피 탭 그룹과 동일 팔레트) — 좁은 폭에서 폴더를 색 점으로 구분.
const FOLDER_HEX: Record<string, string> = {
  red: '#E5484D', orange: '#F76808', yellow: '#FFB224', green: '#30A46C',
  blue: '#3478F6', purple: '#8E4EC6', pink: '#E93D82', gray: '#8E8E93',
}
const FOLDER_PALETTE: string[] = ['blue', 'red', 'green', 'yellow', 'purple', 'pink', 'orange', 'gray']
const FOLDER_EMOJIS: string[] = ['⭐', '💼', '🔖', '📚', '💡', '🎯', '🗂️', '🔥']
const folderHex = (c?: string): string => FOLDER_HEX[c ?? 'gray'] ?? '#8E8E93'

// 검색어를 텍스트 안에서 <mark> 로 감싼 React 노드 배열(XSS 안전 — dangerouslySetInnerHTML 안 씀).
function highlightNodes(text: string, query: string): React.ReactNode {
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
interface SavedTask { id: string; name: string; task: string; createdAt: number; lastRunAt?: number }
// 'interrupted'·'paused' 는 task-runtime(영속 작업) 도입으로 추가 — 단계를 다 쓰고 끝난 실행을
// 성공(done=✅)으로 남기지 않기 위해서다(T3: 단계 소진 ≠ 성공). 이력에는 "미완료"로 정직하게 남는다.
type RunStatus = 'running' | 'paused' | 'interrupted' | 'done' | 'error' | 'cancelled'
interface RunSummary { id: string; task: string; startedAt: number; endedAt?: number; status: RunStatus; stepCount: number }
interface RunStep { icon: string; text: string; tone?: 'ok' | 'warn' | 'muted' }
interface RunDetail { id: string; task: string; startedAt: number; endedAt?: number; status: RunStatus; steps: RunStep[]; result?: string }
const RUN_STATUS: Record<RunStatus, { icon: string; label: string }> = {
  running: { icon: '◔', label: '진행 중' },
  paused: { icon: '⏸️', label: '일시정지' },
  interrupted: { icon: '⏳', label: '미완료' },
  done: { icon: '✅', label: '완료' },
  error: { icon: '❌', label: '오류' },
  cancelled: { icon: '⏹️', label: '중단' },
}
interface RepeatSummary {
  id: string; task: string; intervalMs: number; totalCount: number; doneCount: number
  autoConfirm: boolean; status: 'running' | 'waiting' | 'stopped' | 'finished'; nextAt: number | null; lastResult?: string
  resumable?: boolean  // 재시작 후 자동 부활하지 않고 멈춘 반복(T10) — 사용자가 명시적으로 다시 시작해야 함
}

// ===== 영속 작업(task-runtime) — 단계 소진·크래시에도 이어갈 수 있는 실행 =====
// 단계 소진(exhausted)이 완료가 아니듯, 여기서도 "끝났다"와 "성공했다"를 절대 같은 뜻으로 쓰지 않는다.
type TaskState =
  | 'queued' | 'running' | 'paused' | 'waiting-user' | 'retrying'
  | 'interrupted' | 'needs-verify' | 'completed' | 'failed' | 'cancelled'
interface TaskRetryInfo { kind: string; attempt: number; nextAt: number; detail: string }
interface TaskSummary {
  id: string; instruction: string; state: TaskState; mode: 'normal' | 'long'
  stepsUsed: number; maxSteps: number; segment: number
  elapsedMs: number; startedAt: number; endedAt?: number
  waitReason?: string; retry?: TaskRetryInfo
  llmCalls: number; maxLlmCalls: number
  result?: string; resultFiles: string[]; needsVerify: boolean
}
type TaskPending = { kind: 'confirm'; label: string } | { kind: 'ask'; message: string }
const TASK_STATE_LABEL: Record<TaskState, { icon: string; label: string; tone?: 'ok' | 'warn' | 'muted' }> = {
  queued: { icon: '🕐', label: '대기 중', tone: 'muted' },
  running: { icon: '▶', label: '실행 중' },
  paused: { icon: '⏸️', label: '일시정지', tone: 'muted' },
  'waiting-user': { icon: '❓', label: '확인 대기', tone: 'warn' },
  retrying: { icon: '🔄', label: '재시도 대기', tone: 'warn' },
  interrupted: { icon: '⏳', label: '미완료', tone: 'warn' },
  'needs-verify': { icon: '🔍', label: '확인 필요', tone: 'warn' },
  completed: { icon: '✅', label: '완료', tone: 'ok' },
  failed: { icon: '❌', label: '실패', tone: 'warn' },
  cancelled: { icon: '⏹️', label: '중단됨', tone: 'muted' },
}
const RETRY_KIND_LABEL: Record<string, string> = {
  network: '네트워크 오류', 'rate-limit': '요청 한도 초과', 'cli-dead': 'CLI 연결 끊김',
  'tab-gone': '작업 탭이 닫힘', login: '로그인 필요', model: '모델 오류', unknown: '알 수 없는 오류',
}
function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}분 ${s % 60}초`
  const h = Math.floor(m / 60)
  return `${h}시간 ${m % 60}분`
}
function repeatStatusText(r: RepeatSummary): string {
  const of = r.totalCount > 0 ? `${r.doneCount}/${r.totalCount}회` : `${r.doneCount}회 (무제한)`
  if (r.status === 'running') return `실행 중 · ${of}`
  if (r.status === 'waiting') {
    const sec = r.nextAt ? Math.max(0, Math.round((r.nextAt - Date.now()) / 1000)) : 0
    return `대기 · ${of} · 다음 ${sec >= 60 ? Math.round(sec / 60) + '분' : sec + '초'} 후`
  }
  if (r.status === 'finished') return `완료 · ${of}`
  return `중지됨 · ${of}`
}

function newId(): string {
  try { return crypto.randomUUID() } catch { return `${Date.now()}-${Math.round(Math.random() * 1e9)}` }
}

// 에이전트에 무엇이든 시킬 수 있음을 보여주는 예시 작업(발견성). 클릭하면 입력창에 채워지고, 사용자가
// 자기 사이트에 맞게 다듬어 실행한다(자동 실행 아님 — 되돌리기 어려운 동작은 실행 시 확인 게이트가 잡음).
const AGENT_EXAMPLES: Array<{ label: string; task: string }> = [
  { label: '📋 목록을 표로 모아 CSV', task: '이 페이지의 목록을 페이지를 넘겨가며 빠짐없이 표로 수집하고 CSV로 내보내줘.' },
  { label: '📨 안 읽은 메일만 요약', task: '받은 편지함에서 안 읽은 메일 중 중요한 것만 골라 발신자·제목·핵심을 요약해줘.' },
  { label: '🧾 주문·예약 내역 정리', task: '내 주문/예약 내역을 최근 순으로 표로 정리해줘(날짜·항목·금액·상태).' },
  { label: '✍️ 답글 초안 쓰기', task: '지금 보고 있는 글/문의에 대한 정중한 답글 초안을 한국어로 써줘(게시하지 말고 초안만).' },
  { label: '🖊 폼 자동 작성', task: '이 페이지의 입력 폼을 내 저장된 프로필 정보로 채워줘(제출은 하지 말고 채우기만).' },
  { label: '🔎 원하는 정보 찾기', task: '이 사이트에서 (원하는 것)을 찾아서 정리해줘.' },
]

// 수집 데이터 내보내기 헬퍼 — 열 합집합·CSV·다운로드·복사.
function extractCols(rows: Array<Record<string, string>>): string[] {
  const set = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r)) set.add(k)
  return Array.from(set)
}
function rowsToCSV(rows: Array<Record<string, string>>): string {
  const cols = extractCols(rows)
  const esc = (v: string): string => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c] ?? '')).join(','))].join('\r\n')
}
function downloadText(name: string, mime: string, text: string): void {
  try {
    const a = document.createElement('a')
    a.href = `data:${mime};charset=utf-8,` + encodeURIComponent(text)
    a.download = name
    document.body.appendChild(a); a.click(); a.remove()
  } catch { /* ignore */ }
}
async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text) } catch {
    try { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove() } catch { /* ignore */ }
  }
}

// 대량 처리용 데이터 파싱 — CSV(첫 줄 헤더) 또는 줄 단위 목록(단일 열 '값').
function splitCSVLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += c }
    else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = '' } else cur += c }
  }
  out.push(cur)
  return out.map((s) => s.trim())
}
function parseDataset(text: string): Array<Record<string, string>> {
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
const COMPACT_THRESHOLD = 20
const COMPACT_KEEP = 8

// 챗 입력이 "브라우저를 조작하라"는 명령인지(=에이전트로 넘길지) 판별. 보수적으로 —
// 요약·설명·질문형이면 챗 유지, 명확한 이동/열기/상호작용 의도만 에이전트로 넘긴다.
// 오검지해도 사용자가 ■ 중단으로 즉시 되돌릴 수 있다.
function looksLikeAgentCommand(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  // 질문·요약·설명 요청이면 챗 유지
  if (/요약|정리해|설명(해|좀|을)|무슨|무엇|뭐(야|예요|인가|니|죠|지)|뭔|어때|어떻게\s*생각|분석해|번역|해석|리뷰|평가해|알려\s*줘|가르쳐|왜|차이(가|는|점)/i.test(t)) return false
  // 브라우저 조작 의도(이동/열기/상호작용)
  return /열어|열기|(으로|로|에)\s*(가|이동|접속)|가\s*줘|가\s*자|이동|접속|들어가|눌러|누르|클릭|입력|채워|적어\s*줘|로그인|로그아웃|제출|스크롤|검색\s*해|찾아\s*(가|서|줘)|추가해\s*줘|담아\s*줘|\bopen\b|go\s*to|navigate|visit\b|\bclick\b|log\s*in|log\s*out|submit\b|scroll\b|search\b|\bfill\b|\btype\b/i.test(t)
}
function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u }
}
function relTime(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '방금'
  if (m < 60) return `${m}분 전`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}시간 전`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}일 전`
  try { return new Date(ts).toLocaleDateString() } catch { return '' }
}

// 영속 작업 카드 — 목록(showPtasks 전체 보기)과 인라인 "진행 중" 영역이 이 한 컴포넌트를 함께 쓴다.
// SKILL 의 "한 뷰 = 한 목적" 을 지키려고 별도 상세 화면을 두지 않았다 — 카드 자체가 이미 상태·진척·
// 대기 이유·버튼을 전부 담고 있어, 드릴다운 없이도 필요한 조작을 이 자리에서 끝낼 수 있다.
function TaskCard({
  t, elapsedLabel, retryLabel, pending, traceItems, evidence, answerDraft, canRerun,
  onPause, onResume, onCancel, onDelete, onAccept, onRerun, onConfirm, onAnswerChange, onAnswerSend,
}: {
  t: TaskSummary
  elapsedLabel: string
  retryLabel: string | null
  pending?: TaskPending
  traceItems: TraceItem[]
  evidence?: string
  answerDraft: string
  canRerun: boolean
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onDelete: () => void
  onAccept: () => void
  onRerun: () => void
  onConfirm: (approved: boolean) => void
  onAnswerChange: (v: string) => void
  onAnswerSend: () => void
}) {
  const meta = TASK_STATE_LABEL[t.state]
  const cancellable = t.state === 'running' || t.state === 'paused' || t.state === 'waiting-user' || t.state === 'retrying' || t.state === 'queued'
  const terminal = t.state === 'completed' || t.state === 'failed' || t.state === 'cancelled'
  return (
    <div className={`ai-task-card ${meta.tone ?? ''}`}>
      <div className="ai-task-head">
        <span className={`ai-task-badge ${meta.tone ?? ''}`}>{meta.icon} {meta.label}</span>
        <span className="ai-task-instruction" title={t.instruction}>{t.instruction}</span>
      </div>
      <div className="ai-task-meta">
        {t.mode === 'long' && <span className="ai-task-pill">장시간</span>}
        <span>{elapsedLabel}</span>
        <span>· 단계 {t.stepsUsed}/{t.maxSteps}{t.segment > 1 ? ` · 구간 ${t.segment}` : ''}</span>
        <span>· 호출 {t.llmCalls}/{t.maxLlmCalls}</span>
      </div>

      {t.state === 'retrying' && t.retry && (
        <div className="ai-task-note warn">
          🔄 {RETRY_KIND_LABEL[t.retry.kind] ?? t.retry.kind} · {t.retry.attempt}번째 재시도{retryLabel ? ` · ${retryLabel}` : ''}
        </div>
      )}
      {/* 단계 소진 등으로 이어가지 못한 것이지 실패가 아니다 — ✅ 로 오인시키지 않고 '미완료'로 정직하게. */}
      {t.state === 'interrupted' && (
        <div className="ai-task-note warn">완료하지 못했습니다 — 이어갈 수 있습니다.</div>
      )}
      {/* 모델이 done 을 냈어도 근거(완료 문구·결과 파일 등)가 확인되기 전에는 완료로 표시하지 않는다. */}
      {t.state === 'needs-verify' && (
        <div className="ai-task-note warn">
          완료를 확인해 주세요.
          {evidence ? <div className="ai-task-evidence">{evidence}</div> : <div className="ai-task-evidence dim">근거를 불러오는 중…</div>}
        </div>
      )}
      {(t.state === 'failed' || t.state === 'cancelled') && t.result && (
        <div className="ai-task-note warn">{t.result}</div>
      )}
      {t.state === 'completed' && t.result && (
        <div className="ai-task-note ok">{t.result}</div>
      )}

      {traceItems.length > 0 && !terminal && (
        <div className="ai-task-trace">
          {traceItems.slice(-6).map((tr) => (
            <div key={tr.id} className={`ai-trace-item ${tr.tone ?? ''}`}>
              <span className="ai-trace-icon">{tr.icon}</span>
              <span className="ai-trace-text">{tr.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* 확인/질문 — 사이드바가 열려 있던 동안 라이브 이벤트로 종류를 정확히 알면 그 UI 만,
          재접속으로 종류를 모르면(waitReason 만 있음) 확인·답변 둘 다 제공한다. */}
      {pending?.kind === 'confirm' && (
        <div className="ai-confirm">
          <div className="ai-confirm-msg">⏸️ <b>{pending.label}</b> 을(를) 실행할까요?</div>
          <div className="ai-confirm-btns">
            <button className="ai-confirm-yes" onClick={() => onConfirm(true)}>승인</button>
            <button className="ai-confirm-no" onClick={() => onConfirm(false)}>거부</button>
          </div>
        </div>
      )}
      {pending?.kind === 'ask' && (
        <div className="ai-confirm">
          <div className="ai-confirm-msg">❓ {pending.message}</div>
          <div className="ai-ask-row">
            <input className="ai-ask-input" value={answerDraft} placeholder="답변을 입력하세요…"
              onChange={(e) => onAnswerChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAnswerSend() } }} />
            <button className="ai-confirm-yes" onClick={onAnswerSend} disabled={!answerDraft.trim()}>보내기</button>
          </div>
        </div>
      )}
      {!pending && t.state === 'waiting-user' && (
        <div className="ai-confirm">
          <div className="ai-confirm-msg">❓ {t.waitReason ?? '확인이 필요합니다.'}</div>
          <div className="ai-confirm-btns">
            <button className="ai-confirm-yes" onClick={() => onConfirm(true)}>승인</button>
            <button className="ai-confirm-no" onClick={() => onConfirm(false)}>거부</button>
          </div>
          <div className="ai-ask-row" style={{ marginTop: 6 }}>
            <input className="ai-ask-input" value={answerDraft} placeholder="또는 직접 답변…"
              onChange={(e) => onAnswerChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAnswerSend() } }} />
            <button className="ai-confirm-yes" onClick={onAnswerSend} disabled={!answerDraft.trim()}>보내기</button>
          </div>
        </div>
      )}

      <div className="ai-task-actions">
        {t.state === 'running' && <button className="ai-mini-btn" onClick={onPause} title="일시정지">⏸ 일시정지</button>}
        {t.state === 'paused' && <button className="ai-mini-btn active" onClick={onResume} title="재개">▶ 재개</button>}
        {t.state === 'interrupted' && <button className="ai-mini-btn active" onClick={onResume} title="이어가기">▶ 이어가기</button>}
        {t.state === 'needs-verify' && <button className="ai-mini-btn active" onClick={onAccept} title="완료를 확인하고 승인">✅ 결과 승인</button>}
        {cancellable && <button className="ai-mini-btn" onClick={onCancel} title="중단">⏹ 중단</button>}
        {canRerun && terminal && <button className="ai-mini-btn" onClick={onRerun} title="같은 작업 다시 실행">↻ 다시</button>}
        {(terminal || t.state === 'needs-verify' || t.state === 'interrupted') && (
          <button className="ai-history-del" onClick={onDelete} title="목록에서 삭제">×</button>
        )}
      </div>
    </div>
  )
}

export function AiTab({ windowId, active, summarizeNonce, writeNonce }: { windowId: string; active: TabSummary | null; summarizeNonce?: number; writeNonce?: number }) {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [detection, setDetection] = useState<AiProviderDetection | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [connecting, setConnecting] = useState<AiProviderKind | null>(null)
  const [connectError, setConnectError] = useState<{ message: string; fix?: string } | null>(null)
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null)
  const [mode, setMode] = useState<'chat' | 'agent' | 'write'>('chat')
  // 챗
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [includePage, setIncludePage] = useState(true)
  const [streaming, setStreaming] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const activeReqId = useRef<string | null>(null)
  // 대화 압축(콤팩트) — 긴 대화의 앞부분을 요약해 접는다(컨텍스트 폭증·소형 모델 초과 방지).
  const [summary, setSummary] = useState('')       // 접힌 앞부분의 요약
  const [foldCount, setFoldCount] = useState(0)     // 앞에서 몇 개 메시지가 접혔는지
  const [foldExpanded, setFoldExpanded] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const compactingRef = useRef(false)
  const autoCompactAtRef = useRef(0)                // 이 메시지 길이에서 자동 압축을 이미 시도했는지(실패 재시도 루프 방지)
  // 대화 영속화
  const [convId, setConvId] = useState<string | null>(null)
  const [history, setHistory] = useState<ConvSummary[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const suppressSaveRef = useRef(false)
  const [histSearch, setHistSearch] = useState('')
  const [contentMatchIds, setContentMatchIds] = useState<Set<string>>(new Set())
  const [contentSnippets, setContentSnippets] = useState<Map<string, string>>(new Map())
  const [editingConvId, setEditingConvId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  // 폴더 / 태그
  const [folders, setFolders] = useState<ChatFolder[]>([])
  const [folderFilter, setFolderFilter] = useState<string>('all') // 'all' | folderId | '__none__'
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [assignConvId, setAssignConvId] = useState<string | null>(null)
  const [newFolderName, setNewFolderName] = useState('')
  const [tagDraft, setTagDraft] = useState('')
  // 에이전트 작업 매크로
  const [savedTasks, setSavedTasks] = useState<SavedTask[]>([])
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [editTaskName, setEditTaskName] = useState('')
  // 에이전트 실행 이력
  const [agentRuns, setAgentRuns] = useState<RunSummary[]>([])
  const [showRuns, setShowRuns] = useState(false)
  const [viewRun, setViewRun] = useState<RunDetail | null>(null)
  // 폴더 관리 + 드래그
  const [showFolderManage, setShowFolderManage] = useState(false)
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [editFolderName, setEditFolderName] = useState('')
  const [mgNewFolder, setMgNewFolder] = useState('')
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null)
  const [dragFolderRow, setDragFolderRow] = useState<string | null>(null)
  const [runSearch, setRunSearch] = useState('')
  const [runDetailSearch, setRunDetailSearch] = useState('')
  // 에이전트
  const [agentTask, setAgentTask] = useState('')
  const [trace, setTrace] = useState<TraceItem[]>([])
  const [extractRows, setExtractRows] = useState<Array<Record<string, string>>>([]) // 에이전트가 수집한 데이터
  const [agentRunning, setAgentRunning] = useState(false)
  const [agentPaused, setAgentPaused] = useState(false)  // 'paused'/'resumed' 이벤트 — 종료가 아니라 스피너 문구만 바꾼다
  const [awaitingConfirm, setAwaitingConfirm] = useState<string | null>(null)
  const [awaitingAsk, setAwaitingAsk] = useState<string | null>(null)
  const [askInput, setAskInput] = useState('')
  const agentReqId = useRef<string | null>(null)
  const agentInputRef = useRef<HTMLTextAreaElement>(null)
  // 사이트 분석 보고서
  const [report, setReport] = useState<{ title: string; markdown: string; sources: string[] } | null>(null)
  const [reportOpen, setReportOpen] = useState(true)
  const [reportDepth, setReportDepth] = useState<'brief' | 'full'>('brief')
  const [writePreset, setWritePreset] = useState<{ nonce: number; title: string; body: string } | null>(null)
  // 자동 반복
  const [repeatOn, setRepeatOn] = useState(false)
  const [repeatEvery, setRepeatEvery] = useState(10)  // 분
  const [repeatCount, setRepeatCount] = useState(0)   // 0 = 무제한
  const [repeatAuto, setRepeatAuto] = useState(false)
  const [repeats, setRepeats] = useState<RepeatSummary[]>([])
  // 대량·반복 처리(데이터 각 행마다 작업)
  const [batchOn, setBatchOn] = useState(false)
  const [batchData, setBatchData] = useState('')
  // 영속 작업(task-runtime) — 실행 방식·범위 한도. IPC 는 ptask* 접두(에이전트 작업 매크로의
  // taskList/onTaskChanged 와 이름이 겹쳐 분리됨). 메인 입력창의 '▶ 실행' 이 이 경로를 탄다
  // (퀵액션·배치·다시실행은 기존 ephemeral agentStart 경로를 그대로 씀).
  const [execMode, setExecMode] = useState<'normal' | 'long'>('normal')
  const [longMaxHours, setLongMaxHours] = useState(24)
  const [longMaxSteps, setLongMaxSteps] = useState(2000)
  const [longMaxLlmCalls, setLongMaxLlmCalls] = useState(1500)
  const [allowedHostsText, setAllowedHostsText] = useState('')
  const [ptasks, setPtasks] = useState<TaskSummary[]>([])
  const [showPtasks, setShowPtasks] = useState(false)
  const [ptaskNotice, setPtaskNotice] = useState<string | null>(null)
  const [ptaskTraces, setPtaskTraces] = useState<Record<string, TraceItem[]>>({})
  const [ptaskPending, setPtaskPending] = useState<Record<string, TaskPending>>({})
  const [ptaskEvidence, setPtaskEvidence] = useState<Record<string, string>>({})
  const [ptaskAnswerDraft, setPtaskAnswerDraft] = useState<Record<string, string>>({})
  const ptaskSyncRef = useRef<Map<string, { elapsedMs: number; at: number }>>(new Map())
  const ptaskEvidenceFetchedRef = useRef<Set<string>>(new Set())
  // 고급 옵션(자동 반복·데이터 반복)은 기본 접힘 — 평소 입력창을 깔끔하게 유지
  const [showAdvanced, setShowAdvanced] = useState(false)
  // 부팅 시 마지막 대화 자동 복원이 늦게 도착해, 그 사이 사용자가 이미 입력을 시작한 경우
  // 덮어쓰지 않도록 상호작용 여부를 추적한다.
  const startedRef = useRef(false)

  const bodyRef = useRef<HTMLDivElement>(null)
  const activeId = active?.id
  const isInternal = active ? !/^https?:/i.test(active.url) : true

  const refreshConfig = () => { void window.browserAPI.ai.config().then((c) => setConfig(c)) }

  // 제공자 탐지·연결 — "키가 필요합니다"로 끝내지 않고 이 컴퓨터에서 쓸 수 있는 길을 찾아 준다.
  const loadDetection = async (force = false) => {
    setDetecting(true)
    try {
      const d = await window.browserAPI.ai.detectProviders(force)
      setDetection(d)
    } catch { setDetection(null) } finally { setDetecting(false) }
  }

  const connectTo = async (id: AiProviderKind) => {
    setConnecting(id)
    setConnectError(null)
    try {
      const r = await window.browserAPI.ai.connectProvider(id)
      if (r?.ok) { refreshConfig(); setDetection(null); return }
      // 실패해도 무엇이 문제인지·무엇을 하면 되는지 그대로 보여준다(조용한 실패 금지).
      setConnectError({
        message: r?.diagnosis?.message ?? r?.error ?? '연결하지 못했습니다.',
        fix: r?.diagnosis?.fix,
      })
      void loadDetection(true)
    } catch (e) {
      setConnectError({ message: e instanceof Error ? e.message : String(e) })
    } finally { setConnecting(null) }
  }

  // 설정에서 제공자·키가 바뀌면 이 패널도 따라온다. 없으면 설정 화면(또는 다른 창)에서 연결해도
  // 사이드바는 "키가 필요합니다"에 머물러, 사용자가 보기엔 연결이 안 된 것과 같다.
  useEffect(() => {
    const off = window.browserAPI.settings.onChange(() => {
      refreshConfig()
      setDetection(null)
    })
    return off
  }, [])

  // 제공자가 준비되지 않은 상태로 패널이 열리면 곧바로 탐지한다.
  const needsProvider = !!config && config.enabled && !config.hasKey && config.provider !== 'ollama'
  useEffect(() => {
    if (needsProvider && detection === null && !detecting) void loadDetection(false)
  }, [needsProvider, detection, detecting])

  // 챗 스트림 구독
  useEffect(() => {
    refreshConfig()
    const offDelta = window.browserAPI.ai.onDelta(({ reqId, text }) => {
      if (reqId !== activeReqId.current) return
      setMessages((prev) => prev.map((m) => (m.reqId === reqId && m.role === 'assistant' ? { ...m, content: m.content + text } : m)))
    })
    const offDone = window.browserAPI.ai.onDone(({ reqId }) => {
      if (reqId !== activeReqId.current) return
      setMessages((prev) => prev.map((m) => (m.reqId === reqId ? { ...m, streaming: false } : m)))
      activeReqId.current = null; setStreaming(false)
    })
    const offError = window.browserAPI.ai.onError(({ reqId, message }) => {
      if (reqId !== activeReqId.current) return
      setMessages((prev) => prev.map((m) => (m.reqId === reqId && m.role === 'assistant' ? { ...m, content: message, streaming: false, error: true } : m)))
      activeReqId.current = null; setStreaming(false)
    })
    return () => { offDelta(); offDone(); offError() }
  }, [])

  // 에이전트 이벤트 구독
  useEffect(() => {
    const push = (icon: string, text: string, tone?: TraceItem['tone'], shot?: string) =>
      setTrace((prev) => [...prev, { id: newId(), icon, text, tone, shot }])
    const off = window.browserAPI.ai.onAgentEvent((p) => {
      if (p.reqId !== agentReqId.current) return
      switch (p.type) {
        case 'start': push('🎯', `작업 시작: ${String(p.task ?? '')}`); break
        case 'observe': push(p.vision ? '👁' : '🔍', `관찰 · 스텝 ${String(p.step)} · 요소 ${String(p.elements)}개${p.vision ? ' · 화면 인식' : ''}`, 'muted'); break
        case 'thought': if (p.thought) push('💭', String(p.thought)); break
        case 'action': push('⚙️', String(p.label ?? '')); break
        case 'result': push(p.ok ? '✔️' : '✖️', String(p.detail ?? ''), p.ok ? 'ok' : 'warn'); break
        case 'extracted': {
          const rows = Array.isArray(p.rows) ? (p.rows as Array<Record<string, string>>) : []
          if (rows.length) setExtractRows((prev) => [...prev, ...rows])
          break
        }
        case 'confirm': push('⏸️', `확인 필요: ${String(p.label ?? '')}`, 'warn'); setAwaitingConfirm(String(p.label ?? '이 행동')); break
        // 로그인/CAPTCHA 감지 — "왜 멈췄는지" 를 사용자가 바로 알아야 한다(자동으로 풀지 않는다).
        case 'challenge': push(p.kind === 'captcha' ? '🧩' : '🔐',
          `${p.kind === 'captcha' ? '사람 확인(CAPTCHA)' : '로그인'} 화면입니다 — 브라우저에서 직접 처리해 주세요 (근거: ${String(p.evidence ?? '')})`, 'warn'); break
        case 'ask': push('❓', String(p.message ?? '')); setAwaitingAsk(String(p.message ?? '추가 정보가 필요합니다.')); break
        case 'answer': push('🗣️', `답변: ${String(p.text ?? '')}`, 'muted'); break
        case 'report': {
          const md = String(p.markdown ?? '')
          if (md.trim()) {
            setReport({ title: String(p.title ?? '사이트 분석 보고서'), markdown: md, sources: Array.isArray(p.sources) ? (p.sources as string[]) : [] })
            setReportOpen(true)
            push('📊', `보고서 작성됨 — ${String(p.title ?? '')}`.trim(), 'ok')
          }
          break
        }
        case 'batch-start': push('📋', `대량 처리 시작 — ${String(p.total)}개 행`); break
        case 'batch-row': push('▶', `행 ${Number(p.index) + 1}/${String(p.total)} 처리`, 'muted'); break
        case 'batch-row-done': push('✅', `행 ${Number(p.index) + 1} 완료: ${String(p.outcome ?? '')}`.slice(0, 120), 'ok'); break
        case 'done': push('🏁', String(p.message ?? '완료'), 'ok', typeof p.shot === 'string' ? p.shot : undefined); setAgentRunning(false); setAgentPaused(false); agentReqId.current = null; break
        // 단계 예산을 다 썼지만 끝난 게 아니다 — done(✅)과 절대 같은 톤으로 보이면 안 된다(T3 와 동일 원칙).
        case 'exhausted':
          push('⏳', `단계 ${String(p.stepsUsed ?? '')}까지 진행 — 아직 완료하지 못했습니다`, 'warn')
          if (p.publishPending) push('⚠️', '발행을 눌렀지만 완료 신호를 확인하지 못했습니다 — 실제로 올라갔는지 확인해 주세요', 'warn')
          setAgentRunning(false); setAgentPaused(false); agentReqId.current = null
          break
        case 'error': push('❌', String(p.message ?? '오류'), 'warn'); setAgentRunning(false); setAgentPaused(false); agentReqId.current = null; break
        case 'cancelled': push('⏹️', '중단됨', 'muted'); setAgentRunning(false); setAgentPaused(false); agentReqId.current = null; break
        // 일시정지/재개는 종료가 아니다 — agentRunning 은 유지하고 스피너 문구만 바꾼다.
        case 'paused': push('⏸️', '일시정지 — 페이지 조작을 멈췄습니다', 'muted'); setAgentPaused(true); break
        case 'resumed': push('▶', '재개', 'muted'); setAgentPaused(false); break
        default: break
      }
    })
    return off
  }, [])

  useEffect(() => {
    // 설정 탭에서 키를 넣고 돌아오면 탭이 바뀌므로, 이 시점에 config 를 새로고침해
    // 셋업 화면에 머무는 문제를 푼다(키는 settings 가 아니라 safeStorage 라 settings.onChange 로는 못 잡음).
    refreshConfig()
    if (!activeId) { setPageInfo(null); return }
    let cancelled = false
    void window.browserAPI.ai.pageContext(activeId).then((info) => { if (!cancelled) setPageInfo(info) })
    return () => { cancelled = true }
  }, [activeId, active?.url])

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, trace, awaitingConfirm])

  // 대화 목록 로드 + 마지막 대화 자동 복원(재시작해도 이어보기). 변경 broadcast 구독.
  useEffect(() => {
    void window.browserAPI.ai.convList().then((list) => {
      setHistory(list)
      const recent = list[0]
      if (recent) {
        void window.browserAPI.ai.convGet(recent.id).then((conv) => {
          // 복원 응답이 늦게 와도 사용자가 이미 대화를 시작했으면 덮어쓰지 않는다.
          if (conv && conv.messages.length && !startedRef.current) {
            suppressSaveRef.current = true
            setConvId(conv.id)
            setMessages(conv.messages.map((m) => ({ id: newId(), role: m.role, content: m.content })))
            setSummary(conv.summary ?? ''); setFoldCount(conv.foldCount ?? 0)
          }
        })
      }
    })
    const off = window.browserAPI.ai.onConvChanged((list) => setHistory(list))
    return () => off()
  }, [])

  // 대화 폴더 로드 + 변경 broadcast 구독
  useEffect(() => {
    void window.browserAPI.ai.folderList().then(setFolders)
    const off = window.browserAPI.ai.onFolderChanged((list) => setFolders(list))
    return () => off()
  }, [])

  const allTags = useMemo(() => {
    const s = new Set<string>()
    for (const h of history) for (const t of h.tags ?? []) s.add(t)
    return Array.from(s).sort((a, b) => a.localeCompare(b, 'ko'))
  }, [history])

  // 제목 즉시 검색 + 본문(메시지)까지 검색(메인 측, 200ms 디바운스). 매칭 id 합집합 + 본문 발췌.
  useEffect(() => {
    const q = histSearch.trim()
    if (!q) { setContentMatchIds(new Set()); setContentSnippets(new Map()); return }
    let stale = false // 늦게 도착한 이전 쿼리 결과가 최신 결과를 덮어쓰는 것을 막는다.
    const t = setTimeout(() => {
      void window.browserAPI.ai.convSearch(q).then((hits) => {
        if (stale) return
        setContentMatchIds(new Set(hits.map((h) => h.id)))
        setContentSnippets(new Map(hits.filter((h) => h.snippet).map((h) => [h.id, h.snippet as string])))
      })
    }, 200)
    return () => { stale = true; clearTimeout(t) }
  }, [histSearch])

  // 검색(제목·본문)·폴더·태그 필터가 적용된 대화 목록(렌더 + 다중 내보내기 공용).
  const filteredHistory = useMemo(() => {
    const q = histSearch.trim().toLowerCase()
    return history.filter((h) => {
      if (q && !h.title.toLowerCase().includes(q) && !contentMatchIds.has(h.id)) return false
      if (folderFilter === '__none__') { if (h.folderId) return false }
      else if (folderFilter !== 'all') { if (h.folderId !== folderFilter) return false }
      if (tagFilter.length && !tagFilter.every((t) => (h.tags ?? []).includes(t))) return false
      return true
    })
  }, [history, histSearch, folderFilter, tagFilter, contentMatchIds])

  // 저장된 에이전트 작업(매크로) 로드 + 변경 broadcast 구독
  useEffect(() => {
    void window.browserAPI.ai.taskList().then(setSavedTasks)
    const off = window.browserAPI.ai.onTaskChanged((list) => setSavedTasks(list))
    return () => off()
  }, [])

  // 에이전트 실행 이력 로드 + 변경 broadcast 구독
  useEffect(() => {
    void window.browserAPI.ai.runList().then(setAgentRuns)
    const off = window.browserAPI.ai.onRunChanged((list) => setAgentRuns(list))
    return () => off()
  }, [])

  // 자동 반복 목록 구독 (+ 대기 카운트다운을 위해 1초마다 리렌더)
  useEffect(() => {
    void window.browserAPI.ai.repeatList().then(setRepeats)
    const off = window.browserAPI.ai.onRepeatChanged((list) => setRepeats(list))
    return () => off()
  }, [])
  const activeRepeats = repeats.filter((r) => r.status === 'running' || r.status === 'waiting')
  // 재시작 후 자동 부활하지 않고 멈춘 반복(T10) — 명시적으로 다시 시작해야 한다.
  const resumableRepeats = repeats.filter((r) => r.status === 'stopped' && r.resumable)
  useEffect(() => {
    if (activeRepeats.length === 0) return
    const t = setInterval(() => setRepeats((prev) => [...prev]), 1000) // 카운트다운 갱신
    return () => clearInterval(t)
  }, [activeRepeats.length])

  // 영속 작업 목록 로드 + 변경 구독 — 사이드바를 닫았다 열어도 살아 있는 작업이 그대로 보인다.
  useEffect(() => {
    void window.browserAPI.ai.ptaskList().then(setPtasks)
    const off = window.browserAPI.ai.onPtaskChanged((list) => setPtasks(list))
    return () => off()
  }, [])

  // 영속 작업 라이브 이벤트. confirm/ask 는 종류를 정확히 구분해 받는다(사이드바가 열려 있는 동안
  // 도착한 경우) — 재시작 후 재접속처럼 라이브 이벤트를 못 받은 채 waiting-user 로 복원된 경우는
  // 카드가 waitReason 기반 일반 확인/답변 UI 로 대체 표시한다(아래 렌더 부분).
  useEffect(() => {
    const off = window.browserAPI.ai.onPtaskEvent((p) => {
      const id = String(p.taskId ?? '')
      if (!id) return
      const pushTrace = (icon: string, text: string, tone?: TraceItem['tone']) =>
        setPtaskTraces((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), { id: newId(), icon, text, tone }].slice(-60) }))
      switch (p.type) {
        case 'observe': pushTrace(p.vision ? '👁' : '🔍', `관찰 · 스텝 ${String(p.step)}`, 'muted'); break
        case 'thought': if (p.thought) pushTrace('💭', String(p.thought)); break
        case 'action': pushTrace('⚙️', String(p.label ?? '')); break
        case 'result': pushTrace(p.ok ? '✔️' : '✖️', String(p.detail ?? ''), p.ok ? 'ok' : 'warn'); break
        case 'confirm':
          setPtaskPending((prev) => ({ ...prev, [id]: { kind: 'confirm', label: String(p.label ?? '이 행동') } }))
          pushTrace('⏸️', `확인 필요: ${String(p.label ?? '')}`, 'warn')
          break
        case 'ask':
          setPtaskPending((prev) => ({ ...prev, [id]: { kind: 'ask', message: String(p.message ?? '추가 정보가 필요합니다.') } }))
          pushTrace('❓', String(p.message ?? ''))
          break
        case 'challenge':
          pushTrace(p.kind === 'captcha' ? '🧩' : '🔐',
            `${p.kind === 'captcha' ? '사람 확인(CAPTCHA)' : '로그인'} 화면 감지 — 브라우저에서 직접 처리해 주세요`, 'warn')
          break
        case 'answer':
          setPtaskPending((prev) => { const n = { ...prev }; delete n[id]; return n })
          pushTrace('🗣️', `답변: ${String(p.text ?? '')}`, 'muted')
          break
        default: break
      }
    })
    return off
  }, [])

  // needs-verify 로 접어든 작업만 taskGet 으로 완료 근거(verifyEvidence)를 따로 받아 온다
  // (목록 요약에는 근거 텍스트가 없어 — 카드에 "완료를 확인해 주세요"만 보이면 신뢰할 근거가 없다).
  useEffect(() => {
    for (const t of ptasks) {
      if (t.needsVerify && !ptaskEvidenceFetchedRef.current.has(t.id)) {
        ptaskEvidenceFetchedRef.current.add(t.id)
        void window.browserAPI.ai.ptaskGet(t.id).then((full) => {
          if (full) setPtaskEvidence((prev) => ({ ...prev, [t.id]: full.verifyEvidence ?? '' }))
        })
      }
    }
  }, [ptasks])

  // 경과 시간·재시도 카운트다운 — 목록 브로드캐스트 시점의 elapsedMs 를 기준 삼아 벽시계로
  // 보간한다(백엔드가 초 단위로 매번 다시 보내주지 않아도 화면은 실시간처럼 움직인다).
  useEffect(() => {
    for (const t of ptasks) ptaskSyncRef.current.set(t.id, { elapsedMs: t.elapsedMs, at: Date.now() })
  }, [ptasks])
  const [, tickPtasks] = useState(0)
  const ptaskTicking = ptasks.some((t) => t.state === 'running' || t.state === 'retrying')
  useEffect(() => {
    if (!ptaskTicking) return
    const timer = setInterval(() => tickPtasks((v) => v + 1), 1000)
    return () => clearInterval(timer)
  }, [ptaskTicking])
  const ptaskElapsed = (t: TaskSummary): number => {
    const sync = ptaskSyncRef.current.get(t.id)
    if (!sync) return t.elapsedMs
    return t.state === 'running' ? sync.elapsedMs + (Date.now() - sync.at) : sync.elapsedMs
  }
  const ptaskRetryCountdown = (t: TaskSummary): string | null => {
    if (!t.retry) return null
    const remain = Math.max(0, t.retry.nextAt - Date.now())
    const sec = Math.ceil(remain / 1000)
    return sec >= 60 ? `${Math.ceil(sec / 60)}분 후 재시도` : `${sec}초 후 재시도`
  }

  // 장시간 실행 기본값(설정에서) — 최초 진입 시 한 번 불러와 입력 필드 기본값으로.
  useEffect(() => {
    void window.browserAPI.settings.get('ai').then((v) => {
      const s = (v ?? {}) as Partial<{ taskLongMaxHours: number; taskLongMaxSteps: number; taskLongMaxLlmCalls: number }>
      if (typeof s.taskLongMaxHours === 'number') setLongMaxHours(s.taskLongMaxHours)
      if (typeof s.taskLongMaxSteps === 'number') setLongMaxSteps(s.taskLongMaxSteps)
      if (typeof s.taskLongMaxLlmCalls === 'number') setLongMaxLlmCalls(s.taskLongMaxLlmCalls)
    })
  }, [])

  // 대화가 안정되면(스트리밍 종료) 400ms 디바운스로 스레드 전체를 저장.
  useEffect(() => {
    if (streaming) return
    if (suppressSaveRef.current) { suppressSaveRef.current = false; return }
    if (!convId) return
    const persistable = messages.filter((m) => !m.error && m.content.trim())
    if (persistable.length === 0) return
    const payload = persistable.map((m) => ({ role: m.role, content: m.content }))
    const savedSummary = summary || undefined
    const savedFold = foldCount
    let saved = false
    const doSave = () => { if (!saved) { saved = true; void window.browserAPI.ai.convSave({ id: convId, messages: payload, summary: savedSummary, foldCount: savedFold }) } }
    const t = setTimeout(doSave, 400)
    // 언마운트·대화 전환·패널 닫힘 시에도 반드시 저장한다 — 그냥 clearTimeout 만 하면
    // 방금 끝난 대화가 디스크에 안 남고 사라진다(데이터 손실).
    return () => { clearTimeout(t); doSave() }
  }, [messages, streaming, convId, summary, foldCount])

  // ===== 대화 압축(콤팩트) — 앞부분을 요약해 접기 =====
  const compact = async (): Promise<void> => {
    if (compactingRef.current || streaming) return
    const cut = messages.length - COMPACT_KEEP
    if (cut <= foldCount) return // 접을 게 없음(최근 KEEP 개는 항상 원문 유지)
    const toFold = messages.slice(foldCount, cut).filter((m) => !m.error && m.content.trim()).map((m) => ({ role: m.role, content: m.content }))
    if (toFold.length === 0) { setFoldCount(cut); return }
    compactingRef.current = true; setCompacting(true)
    try {
      const res = await window.browserAPI.ai.summarize(toFold, summary || undefined)
      if (res.ok && res.summary) {
        // 요약 성공 → 앞부분 접기(원문은 messages 에 그대로 남아 '펼치기'로 볼 수 있고 저장본에도 보존).
        setSummary(res.summary); setFoldCount(cut); setFoldExpanded(false)
      }
    } catch { /* 실패 시 조용히 무시 — 원문 그대로, 다음 기회에 재시도 */ }
    finally { compactingRef.current = false; setCompacting(false) }
  }

  // 자동 압축: 활성 메시지가 임계를 넘고 스트리밍이 아니면 앞부분을 요약해 접는다.
  useEffect(() => {
    if (mode !== 'chat' || streaming || compactingRef.current) return
    if (messages.length - foldCount < COMPACT_THRESHOLD) return
    if (autoCompactAtRef.current === messages.length) return // 이 길이에서 이미 시도(실패 재시도 루프 방지)
    autoCompactAtRef.current = messages.length
    void compact()
  }, [messages, streaming, foldCount, mode])

  const providerReady = !!config && config.enabled && config.hasKey
  const openSettings = () => { void window.browserAPI.actions.run('action.settings.open', { windowId }) }

  // ===== 챗 =====
  const send = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || streaming || !providerReady) return
    // 챗 입력이 브라우저 조작 명령이면 자동으로 에이전트로 넘긴다("네이버 열어줘" 등).
    // 챗 모드는 페이지와 대화만 하고 실제 조작은 못 하므로, 명령을 챗으로 보내면 헛수고가 된다.
    if (mode === 'chat' && !agentRunning && looksLikeAgentCommand(trimmed)) {
      if (isInternal) {
        setNotice('🤖 브라우저 조작은 웹 페이지에서 실행됩니다. 사이트를 연 뒤 다시 시도하세요.')
        return
      }
      setNotice(null)
      setInput('')
      setMode('agent')
      setAgentTask(trimmed)
      startAgent(trimmed)
      return
    }
    startedRef.current = true
    if (!convId) setConvId(newId())
    const reqId = newId(); activeReqId.current = reqId
    const userMsg: ChatMessage = { id: newId(), role: 'user', content: trimmed }
    const assistantMsg: ChatMessage = { id: newId(), role: 'assistant', content: '', streaming: true, reqId }
    // 빈 내용(중단으로 남은 빈 assistant)은 이력에서 제외 — 일부 제공자는 빈 content 를 거부해
    // 이후 모든 전송이 실패한다.
    // 접힌(요약된) 앞부분은 보내지 않고, 요약을 system 으로 대신 전달 → 컨텍스트 절약.
    const base = foldCount > 0 ? messages.slice(foldCount) : messages
    const history = [...base, userMsg].filter((m) => !m.error && m.content.trim()).map((m) => ({ role: m.role, content: m.content }))
    setMessages((prev) => [...prev, userMsg, assistantMsg]); setInput(''); setStreaming(true)
    void window.browserAPI.ai.send({ reqId, tabId: activeId, includePage: includePage && !isInternal, messages: history, summary: summary || undefined })
  }
  const stop = () => {
    if (activeReqId.current) void window.browserAPI.ai.cancel(activeReqId.current)
    setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)))
    activeReqId.current = null; setStreaming(false)
  }
  // 수집한 데이터를 AI 로 비교·분석 → 리포트(조사·비교). 표를 마크다운으로 만들어 챗으로 보낸다.
  const analyzeCollectedData = () => {
    if (!extractRows.length || streaming || !providerReady) return
    const cols = extractCols(extractRows)
    const rows = extractRows.slice(0, 60)
    const md = ['| ' + cols.join(' | ') + ' |', '| ' + cols.map(() => '---').join(' | ') + ' |',
      ...rows.map((r) => '| ' + cols.map((c) => String(r[c] ?? '').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 60)).join(' | ') + ' |')].join('\n')
    const prompt = `다음은 웹에서 수집한 데이터 ${extractRows.length}건입니다. 항목들을 비교·분석해서 핵심 차이, 장단점, 추천을 한국어로 정리해줘(필요하면 표로).\n\n${md}${extractRows.length > rows.length ? `\n\n(총 ${extractRows.length}건 중 ${rows.length}건 표시)` : ''}`
    setMode('chat')
    send(prompt)
  }
  // 외부 요약 요청(툴바/팔레트 action.ai.summarize) — 아무 데서나 한 번에 현재 페이지 요약.
  // config 로드 전(providerReady=false)에 요청이 올 수 있어, providerReady 를 deps 에 넣어 준비되면 재발동한다.
  const lastSummarizeNonce = useRef(0)
  useEffect(() => {
    if (!summarizeNonce || summarizeNonce === lastSummarizeNonce.current) return
    if (isInternal) { lastSummarizeNonce.current = summarizeNonce; setNotice('웹 페이지에서 열면 요약할 수 있습니다.'); return }
    if (!providerReady) return // 아직 준비 전 — providerReady 가 true 되면 이 effect 가 재실행되어 발동
    lastSummarizeNonce.current = summarizeNonce
    setMode('chat')
    send('이 페이지의 핵심 내용을 불릿으로 간결하게 요약해줘.')
  }, [summarizeNonce, providerReady])
  // 외부에서 블로그 글쓰기 모드로 열기(메뉴 · 팔레트) — writeNonce 가 바뀌면 글쓰기 모드로 전환.
  const lastWriteNonce = useRef(0)
  useEffect(() => {
    if (!writeNonce || writeNonce === lastWriteNonce.current) return
    lastWriteNonce.current = writeNonce
    setMode('write')
  }, [writeNonce])
  // 압축 상태 초기화(새 대화·삭제) / 로드한 대화의 압축 상태 복원
  const resetCompaction = () => { setSummary(''); setFoldCount(0); setFoldExpanded(false); autoCompactAtRef.current = 0 }
  const newChat = () => {
    if (streaming) stop()
    suppressSaveRef.current = true
    setConvId(null); setMessages([]); setShowHistory(false); resetCompaction()
  }
  const loadConversation = (id: string) => {
    if (streaming) stop()
    void window.browserAPI.ai.convGet(id).then((conv) => {
      if (!conv) return
      suppressSaveRef.current = true
      setConvId(conv.id)
      setMessages(conv.messages.map((m) => ({ id: newId(), role: m.role, content: m.content })))
      setSummary(conv.summary ?? ''); setFoldCount(conv.foldCount ?? 0); setFoldExpanded(false); autoCompactAtRef.current = 0
      setShowHistory(false)
    })
  }
  const deleteConv = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    void window.browserAPI.ai.convDelete(id).then(() => {
      if (convId === id) { suppressSaveRef.current = true; setConvId(null); setMessages([]); resetCompaction() }
    })
  }
  const clearHistory = () => {
    if (history.length === 0) return
    if (!window.confirm('저장된 모든 대화를 삭제할까요?')) return
    void window.browserAPI.ai.convClear().then(() => {
      suppressSaveRef.current = true; setConvId(null); setMessages([]); setShowHistory(false); resetCompaction()
    })
  }
  const toggleHistory = () => {
    setShowHistory((s) => {
      if (!s) { void window.browserAPI.ai.convList().then(setHistory); setShowFolderManage(false) }
      return !s
    })
  }
  const beginRename = (h: ConvSummary, e: React.MouseEvent) => {
    e.stopPropagation(); setEditingConvId(h.id); setEditTitle(h.title)
  }
  const commitRename = (id: string) => {
    const t = editTitle.trim()
    setEditingConvId(null)
    if (t) void window.browserAPI.ai.convRename(id, t)
  }
  // 폴더 / 태그
  const folderName = (id: string | null) => (id ? (folders.find((f) => f.id === id)?.name ?? '') : '')
  const folderColorById = (id: string | null) => folderHex(id ? folders.find((f) => f.id === id)?.color : 'gray')
  const folderById = (id: string | null): ChatFolder | null => (id ? folders.find((f) => f.id === id) ?? null : null)
  // 폴더 아이콘 = 이모지가 있으면 이모지, 없으면 색 점
  const folderIcon = (f: ChatFolder | null) =>
    f?.emoji ? <span className="ai-femoji">{f.emoji}</span> : <span className="ai-fdot" style={{ background: folderHex(f?.color) }} />
  const toggleTagFilter = (t: string) => setTagFilter((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
  const beginAssign = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setAssignConvId((prev) => (prev === id ? null : id)); setNewFolderName(''); setTagDraft('')
  }
  const togglePin = (h: ConvSummary, e: React.MouseEvent) => {
    e.stopPropagation()
    void window.browserAPI.ai.convSetPinned(h.id, !h.pinned)
  }
  const assignFolder = (convId: string, folderId: string | null) => { void window.browserAPI.ai.convSetFolder(convId, folderId) }
  const convTagsOf = (id: string) => history.find((h) => h.id === id)?.tags ?? []
  const addTag = (convId: string, tag: string) => {
    const t = tag.replace(/^#+/, '').trim()
    setTagDraft('')
    if (!t) return
    const cur = convTagsOf(convId)
    if (cur.includes(t)) return
    void window.browserAPI.ai.convSetTags(convId, [...cur, t])
  }
  const removeTag = (convId: string, tag: string) => {
    void window.browserAPI.ai.convSetTags(convId, convTagsOf(convId).filter((x) => x !== tag))
  }
  const createFolderInline = (convId: string) => {
    const n = newFolderName.trim()
    if (!n) return
    setNewFolderName('')
    void window.browserAPI.ai.folderCreate(n).then((f) => { if (f) void window.browserAPI.ai.convSetFolder(convId, f.id) })
  }
  // 폴더 관리
  const beginFolderRename = (f: ChatFolder, e: React.MouseEvent) => { e.stopPropagation(); setEditingFolderId(f.id); setEditFolderName(f.name) }
  const commitFolderRename = (id: string) => {
    const n = editFolderName.trim()
    setEditingFolderId(null)
    if (n) void window.browserAPI.ai.folderRename(id, n)
  }
  const deleteFolderConfirm = (id: string) => {
    const f = folders.find((x) => x.id === id)
    if (!window.confirm(`'${f?.name ?? '폴더'}' 폴더를 삭제할까요? (대화는 미분류로 이동)`)) return
    void window.browserAPI.ai.folderDelete(id)
  }
  const createFolderTop = () => {
    const n = mgNewFolder.trim()
    if (!n) return
    setMgNewFolder('')
    void window.browserAPI.ai.folderCreate(n)
  }
  const setFolderColorFn = (id: string, color: string) => { void window.browserAPI.ai.folderSetColor(id, color) }
  const setFolderEmojiFn = (id: string, emoji: string) => { void window.browserAPI.ai.folderSetEmoji(id, emoji) }
  // 드래그로 폴더 이동
  const onFolderDrop = (folderId: string | null, e: React.DragEvent) => {
    e.preventDefault()
    const convId = e.dataTransfer.getData('text/bb-conv')
    setDragOverFolder(null)
    if (convId) void window.browserAPI.ai.convSetFolder(convId, folderId)
  }
  // 폴더 순서 재정렬(관리 화면)
  const onFolderRowDragStart = (id: string, e: React.DragEvent) => {
    e.dataTransfer.setData('text/bb-folder', id); e.dataTransfer.effectAllowed = 'move'; setDragFolderRow(id)
  }
  const onFolderRowDrop = (targetId: string, e: React.DragEvent) => {
    e.preventDefault()
    const srcId = e.dataTransfer.getData('text/bb-folder') || dragFolderRow
    setDragFolderRow(null)
    if (!srcId || srcId === targetId) return
    const ids = folders.map((f) => f.id).filter((id) => id !== srcId)
    const idx = ids.indexOf(targetId)
    ids.splice(idx < 0 ? ids.length : idx, 0, srcId)
    void window.browserAPI.ai.folderReorder(ids)
  }
  // 개별 대화 .md 내보내기
  const exportConv = (id: string) => { void window.browserAPI.ai.convExport(id) }
  // 현재 필터된 목록을 하나의 .md 로 (다중/폴더 내보내기)
  const exportBulk = () => {
    const ids = filteredHistory.map((h) => h.id)
    if (ids.length === 0) return
    void window.browserAPI.ai.convExportBulk(ids)
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) }
  }

  // ===== 에이전트 =====
  const startAgent = (task: string) => {
    const t = task.trim()
    if (!t || agentRunning || !providerReady || isInternal) return
    const reqId = newId(); agentReqId.current = reqId
    // 이전 턴 트레이스는 지우지 않는다 — 백엔드가 창 단위 세션 맥락을 이어가므로("대화가 이어짐"),
    // 화면도 이어서 쌓인다(각 턴은 🎯 작업 시작 줄로 구분). 초기화는 '＋ 새 작업' 으로.
    setAwaitingConfirm(null); setAwaitingAsk(null); setAskInput(''); setAgentRunning(true); setAgentPaused(false)
    setAgentTask('') // 전송 후 입력창 비우기
    const rows = batchOn ? parseDataset(batchData) : []
    void window.browserAPI.ai.agentStart({ reqId, tabId: activeId, task: t, ...(rows.length ? { rows, autoConfirm: repeatAuto } : {}) })
  }
  const stopAgent = () => {
    if (agentReqId.current) void window.browserAPI.ai.agentCancel(agentReqId.current)
    setAgentRunning(false); setAgentPaused(false); setAwaitingConfirm(null); setAwaitingAsk(null)
  }
  const respondConfirm = (approved: boolean) => {
    const rid = agentReqId.current
    if (rid) void window.browserAPI.ai.agentConfirm(rid, approved)
    setAwaitingConfirm(null)
  }
  const respondAsk = () => {
    const rid = agentReqId.current; const a = askInput.trim()
    if (!rid || !a) return
    void window.browserAPI.ai.agentReply(rid, a)
    setAskInput(''); setAwaitingAsk(null)
  }
  // 데이터 반복(batch)·자동 반복(repeat)은 기존 ephemeral 경로(agentStart/repeatStart) 그대로 두고,
  // 그 외의 "한 번 실행"만 영속 작업(ptask)으로 만든다 — 일시정지·재개·크래시 복원이 필요한 건
  // 결국 이 평범한 단발 실행이기 때문(배치·반복은 각자 다른 재개 메커니즘을 이미 갖고 있다).
  const runAgentOrRepeat = () => {
    const t = agentTask.trim()
    if (!t || !providerReady || isInternal) return
    if (batchOn && parseDataset(batchData).length) {
      startAgent(t)
    } else if (repeatOn) {
      if (!activeId) return
      void window.browserAPI.ai.repeatStart({ task: t, windowId, tabId: activeId, intervalMinutes: Math.max(0.1, repeatEvery), count: Math.max(0, repeatCount), autoConfirm: repeatAuto })
      setAgentTask('') // 전송 후 입력창 비우기
    } else {
      startPersistentTask(t)
    }
  }
  const onAgentKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runAgentOrRepeat() }
  }

  // ===== 영속 작업(ptask) =====
  // 상태 변경 호출은 throw 하지 않고 {ok, error} 를 돌려준다(소유 창이 아니거나 상태 전이가
  // 불가할 때) — 조용히 무시하면 "눌렀는데 아무 일도 안 일어난다"가 되므로 실패 사유를 반드시 보인다.
  const runPtaskAction = (p: Promise<{ ok: boolean; error?: string }>) => {
    void p.then((r) => { if (!r?.ok) setPtaskNotice(r?.error || '요청을 처리하지 못했습니다.') })
      .catch((e) => setPtaskNotice(e instanceof Error ? e.message : String(e)))
  }
  const startPersistentTask = (task: string) => {
    const trimmed = task.trim()
    if (!trimmed || isInternal || !providerReady || !activeId) return
    // 허용 사이트는 실행 방식(일반/장시간)과 무관하게 적용되는 범위 한도.
    const hosts = allowedHostsText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
    const budget: Partial<{ maxDurationMs: number; maxSteps: number; maxLlmCalls: number; allowedHosts: string[] }> = {}
    if (execMode === 'long') {
      budget.maxDurationMs = Math.max(1, longMaxHours) * 3600_000
      budget.maxSteps = Math.max(1, longMaxSteps)
      budget.maxLlmCalls = Math.max(1, longMaxLlmCalls)
    }
    if (hosts.length) budget.allowedHosts = hosts
    setAgentTask(''); setPtaskNotice('')
    void window.browserAPI.ai.ptaskCreate({
      instruction: trimmed, tabId: activeId, mode: execMode,
      ...(Object.keys(budget).length ? { budget } : {}),
    }).then((summary) => {
      if (!summary) { setPtaskNotice('작업을 만들지 못했습니다(빈 지시).'); return }
      runPtaskAction(window.browserAPI.ai.ptaskStart(summary.id))
    })
  }
  const pausePtask = (id: string) => runPtaskAction(window.browserAPI.ai.ptaskPause(id))
  const resumePtask = (id: string) => runPtaskAction(window.browserAPI.ai.ptaskResume(id))
  const cancelPtask = (id: string) => runPtaskAction(window.browserAPI.ai.ptaskCancel(id))
  const deletePtask = (id: string) => runPtaskAction(window.browserAPI.ai.ptaskDelete(id))
  const acceptPtask = (id: string) => runPtaskAction(window.browserAPI.ai.ptaskAccept(id))
  const rerunPtask = (t: TaskSummary) => {
    if (isInternal || !providerReady || !activeId) return
    void window.browserAPI.ai.ptaskCreate({ instruction: t.instruction, tabId: activeId, mode: t.mode }).then((s) => {
      if (!s) { setPtaskNotice('작업을 만들지 못했습니다.'); return }
      runPtaskAction(window.browserAPI.ai.ptaskStart(s.id))
    })
  }
  const respondPtaskConfirm = (id: string, approved: boolean) => {
    runPtaskAction(window.browserAPI.ai.ptaskConfirm(id, approved))
    setPtaskPending((prev) => { const n = { ...prev }; delete n[id]; return n })
  }
  const setPtaskAnswer = (id: string, v: string) => setPtaskAnswerDraft((prev) => ({ ...prev, [id]: v }))
  const respondPtaskAnswer = (id: string) => {
    const a = (ptaskAnswerDraft[id] ?? '').trim()
    if (!a) return
    runPtaskAction(window.browserAPI.ai.ptaskAnswer(id, a))
    setPtaskAnswerDraft((prev) => ({ ...prev, [id]: '' }))
    setPtaskPending((prev) => { const n = { ...prev }; delete n[id]; return n })
  }
  const togglePtasks = () => {
    setShowRuns(false); setViewRun(null)
    setShowPtasks((s) => {
      if (!s) { setPtaskNotice(null); void window.browserAPI.ai.ptaskList().then(setPtasks) }
      return !s
    })
  }
  // 사이드바를 닫았다 열어도 살아 있는 작업이 눈에 바로 띄도록, 진행/대기 중인 작업은 항상
  // 인라인으로도 보인다(완료·실패·중단은 '📌 작업' 전체 목록에서만 — 평소 입력창을 깔끔하게 유지).
  const livePtasks = ptasks.filter((t) => t.state !== 'completed' && t.state !== 'failed' && t.state !== 'cancelled')
  // 작업 매크로
  const saveCurrentTask = () => {
    const t = agentTask.trim()
    if (!t) return
    void window.browserAPI.ai.taskAdd(t)
  }
  const runSavedTask = (s: SavedTask) => {
    void window.browserAPI.ai.taskTouch(s.id)
    setAgentTask(s.task); setShowRuns(false); setViewRun(null); startAgent(s.task)
  }
  const deleteSavedTask = (id: string, e: React.MouseEvent) => {
    e.stopPropagation(); void window.browserAPI.ai.taskRemove(id)
  }
  const beginTaskRename = (s: SavedTask, e: React.MouseEvent) => {
    e.stopPropagation(); setEditingTaskId(s.id); setEditTaskName(s.name)
  }
  const commitTaskRename = (id: string) => {
    const n = editTaskName.trim()
    setEditingTaskId(null)
    if (n) void window.browserAPI.ai.taskRename(id, n)
  }
  const resetAgent = () => {
    setTrace([]); setExtractRows([]); setReport(null); setAwaitingConfirm(null); setAwaitingAsk(null); setShowRuns(false); setViewRun(null); setAgentPaused(false)
    void window.browserAPI.ai.agentReset(windowId) // 백엔드 세션 맥락도 초기화(이전 대화 잊기)
  }
  // 사이트 분석 보고서 — 현재 로그인된 사이트를 여러 페이지 훑어보고 보고서 작성(읽기 전용)
  const startSiteReport = () => {
    if (isInternal || !providerReady || agentRunning || !activeId) return
    const reqId = newId(); agentReqId.current = reqId
    setAwaitingConfirm(null); setAwaitingAsk(null); setAskInput(''); setReport(null); setAgentRunning(true); setAgentPaused(false)
    void window.browserAPI.ai.reportBuildTask({ depth: reportDepth === 'brief' ? 3 : 7 }).then((r) => {
      void window.browserAPI.ai.agentStart({ reqId, tabId: activeId, task: r.task, readOnly: r.readOnly })
    })
  }
  const openReportInStudio = () => {
    if (!report) return
    setWritePreset({ nonce: Date.now(), title: report.title, body: report.markdown })
    setMode('write')
  }
  // 예시 작업을 입력창에 채워 넣기(자동 실행 X — 사용자가 자기 사이트에 맞게 다듬고 실행). breadth 발견용.
  const fillAgentTask = (t: string) => {
    setMode('agent'); setAgentTask(t)
    requestAnimationFrame(() => { const el = agentInputRef.current; if (el) { el.focus(); const n = el.value.length; try { el.setSelectionRange(n, n) } catch { /* ignore */ } } })
  }
  // 실행 이력
  const toggleRuns = () => {
    setViewRun(null); setShowPtasks(false)
    setShowRuns((s) => {
      if (!s) void window.browserAPI.ai.runList().then(setAgentRuns)
      return !s
    })
  }
  const openRun = (id: string) => { setRunDetailSearch(''); void window.browserAPI.ai.runGet(id).then((r) => { if (r) setViewRun(r) }) }
  const deleteRun = (id: string, e: React.MouseEvent) => { e.stopPropagation(); void window.browserAPI.ai.runDelete(id) }
  const clearRuns = () => {
    if (agentRuns.length === 0) return
    if (!window.confirm('저장된 모든 작업 이력을 삭제할까요?')) return
    void window.browserAPI.ai.runClear().then(() => { setViewRun(null) })
  }
  const rerunTask = (task: string) => {
    if (!providerReady || isInternal || agentRunning || !task.trim()) return
    setShowRuns(false); setViewRun(null); setAgentTask(task); startAgent(task)
  }

  // ===== 셋업(제공자 미준비) =====
  if (config && !config.enabled) {
    return (
      <div className="ai-setup">
        <div className="ai-setup-title">AI 기능이 꺼져 있습니다</div>
        <p className="ai-setup-desc">설정에서 AI 를 켜면 이 페이지에 대해 질문하고 요약할 수 있습니다.</p>
        <button className="ai-setup-btn" onClick={openSettings}>설정 열기</button>
      </div>
    )
  }
  if (config && !config.hasKey && config.provider !== 'ollama') {
    // 막다른 안내를 주지 않는다 — 이 컴퓨터에서 지금 쓸 수 있는 것을 찾아 한 번에 연결한다.
    const usable = detection?.candidates.filter((c) => c.ready) ?? []
    const notReady = detection?.candidates.filter((c) => !c.ready) ?? []
    return (
      <div className="ai-setup">
        <div className="ai-setup-title">AI를 연결하세요</div>
        {detecting && <p className="ai-setup-desc">이 컴퓨터에서 쓸 수 있는 방법을 찾는 중…</p>}
        {!detecting && usable.length > 0 && (
          <>
            <p className="ai-setup-desc">지금 바로 쓸 수 있는 방법을 찾았습니다. 하나를 고르면 연결까지 확인합니다.</p>
            <div className="ai-provider-list">
              {usable.map((c) => (
                <button
                  key={c.id}
                  className="ai-provider-card"
                  disabled={!!connecting}
                  onClick={() => void connectTo(c.id)}
                >
                  <span className="ai-provider-head">
                    <span className="ai-provider-name">{c.label}</span>
                    <span className={`ai-provider-cost cost-${c.cost}`}>{COST_LABEL[c.cost]}</span>
                  </span>
                  <span className="ai-provider-detail">{c.detail}</span>
                  {connecting === c.id && <span className="ai-provider-detail">연결 확인 중…</span>}
                </button>
              ))}
            </div>
          </>
        )}
        {!detecting && usable.length === 0 && (
          <p className="ai-setup-desc">
            이 컴퓨터에서 바로 쓸 수 있는 AI를 찾지 못했습니다. 아래 중 하나를 준비하면 됩니다.
          </p>
        )}
        {connectError && (
          <div className="ai-setup-error">
            <div className="ai-setup-error-msg">{connectError.message}</div>
            {connectError.fix && <div className="ai-setup-error-fix">{connectError.fix}</div>}
          </div>
        )}
        {!detecting && notReady.length > 0 && (
          <details className="ai-provider-more">
            <summary>준비되지 않은 방법 {notReady.length}개 보기</summary>
            {notReady.map((c) => (
              <div key={c.id} className="ai-provider-row">
                <span className="ai-provider-name">{c.label}</span>
                <span className="ai-provider-detail">{c.detail}</span>
                {c.fix && <span className="ai-provider-fix">{c.fix}</span>}
              </div>
            ))}
          </details>
        )}
        <div className="ai-setup-actions">
          <button className="ai-setup-btn" onClick={openSettings}>설정에서 직접 고르기</button>
          <button className="ai-setup-btn ghost" disabled={detecting} onClick={() => void loadDetection(true)}>다시 찾기</button>
        </div>
      </div>
    )
  }

  return (
    <div className="ai-tab">
      <div className="ai-meta">
        <div className="ai-mode">
          <button className={`ai-mode-btn ${mode === 'chat' ? 'active' : ''}`} onClick={() => setMode('chat')} title="페이지와 대화">💬 챗</button>
          <button className={`ai-mode-btn ${mode === 'agent' ? 'active' : ''}`} onClick={() => setMode('agent')} title="작업을 자동 수행">🤖 에이전트</button>
          <button className={`ai-mode-btn ${mode === 'write' ? 'active' : ''}`} onClick={() => setMode('write')} title="블로그 글 작성">✍️ 글쓰기</button>
        </div>
        <div className="ai-meta-actions">
          <span className="ai-provider" title={config ? `${config.providerLabel} · ${config.model}` : ''}>{config ? config.model : '…'}</span>
          <button className="ai-mini-btn" onClick={() => void window.browserAPI.tabs.create(windowId, 'browser://ai-memory', { background: false })} title="AI 기억 보기·편집">🧠 기억</button>
          {mode === 'chat' && (
            <>
              <button className="ai-mini-btn" onClick={() => void compact()} disabled={streaming || compacting || messages.length - foldCount < 4}
                title="긴 대화의 앞부분을 요약해 압축(컨텍스트 절약)">{compacting ? '🗜 압축 중…' : '🗜 압축'}</button>
              <button className={`ai-mini-btn ${showHistory ? 'active' : ''}`} onClick={toggleHistory} title="이전 대화">🕘 대화</button>
              <button className="ai-mini-btn" onClick={newChat} title="새 대화 시작">＋ 새 대화</button>
            </>
          )}
          {mode === 'agent' && (
            <>
              <button className={`ai-mini-btn ${showPtasks ? 'active' : ''}`} onClick={togglePtasks} title="영속 작업 — 일시정지·재개, 사이드바를 닫아도 계속 진행">📌 작업</button>
              <button className={`ai-mini-btn ${showRuns ? 'active' : ''}`} onClick={toggleRuns} title="작업 이력">🕘 이력</button>
              {(trace.length > 0 || showRuns) && !agentRunning && <button className="ai-mini-btn" onClick={resetAgent} title="새 작업">＋ 새 작업</button>}
              <button className="ai-mini-btn" onClick={saveCurrentTask} disabled={!agentTask.trim()} title="현재 작업을 매크로로 저장">💾 저장</button>
            </>
          )}
        </div>
      </div>

      {mode === 'write' ? (
        <AiWriteStudio
          windowId={windowId}
          isInternal={isInternal}
          providerReady={providerReady}
          onInsertToEditor={(task) => { setMode('agent'); setAgentTask(task); startAgent(task) }}
          preset={writePreset}
        />
      ) : mode === 'chat' ? (
        showHistory ? (
          <div className="ai-body">
            {showFolderManage ? (
              <>
                <div className="ai-history-head">
                  <button className="ai-mini-btn" onClick={() => setShowFolderManage(false)}>← 뒤로</button>
                  <span>폴더 관리</span>
                  <span />
                </div>
                <div className="ai-assign-newfolder" style={{ margin: '8px 2px' }}>
                  <input className="ai-assign-input" value={mgNewFolder} placeholder="새 폴더 이름…"
                    onChange={(e) => setMgNewFolder(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createFolderTop() } }} />
                  <button className="ai-mini-btn" onClick={createFolderTop} disabled={!mgNewFolder.trim()}>＋ 폴더</button>
                </div>
                {folders.length === 0 ? (
                  <div className="ai-welcome-page dim" style={{ padding: '16px', textAlign: 'center' }}>폴더가 없습니다. 위에서 만들어 보세요.</div>
                ) : (
                  <div className="ai-history-list">
                    {folders.length > 1 && <div className="ai-hint">드래그해서 순서를 바꿀 수 있습니다.</div>}
                    {folders.map((f) => {
                      const count = history.filter((h) => h.folderId === f.id).length
                      return (
                        <div key={f.id} className={`ai-history-item ${dragFolderRow === f.id ? 'dragging' : ''}`}
                          draggable={editingFolderId !== f.id}
                          onDragStart={(e) => onFolderRowDragStart(f.id, e)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => onFolderRowDrop(f.id, e)}
                          onDragEnd={() => setDragFolderRow(null)}>
                          <div className="ai-history-main">
                            {editingFolderId === f.id ? (
                              <input className="ai-history-edit" value={editFolderName} autoFocus
                                onChange={(e) => setEditFolderName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitFolderRename(f.id) } else if (e.key === 'Escape') { e.preventDefault(); setEditingFolderId(null) } }}
                                onBlur={() => commitFolderRename(f.id)} />
                            ) : (
                              <>
                                <div className="ai-history-title">{folderIcon(f)}{f.name}</div>
                                <div className="ai-history-sub">{count}개 대화</div>
                                <div className="ai-folder-swatches" onClick={(e) => e.stopPropagation()}>
                                  {FOLDER_PALETTE.map((c) => (
                                    <button key={c} className={`ai-swatch ${f.color === c ? 'active' : ''}`} style={{ background: folderHex(c) }}
                                      title={`색: ${c}`} onClick={() => setFolderColorFn(f.id, c)} />
                                  ))}
                                </div>
                                <div className="ai-folder-emojis" onClick={(e) => e.stopPropagation()}>
                                  <button className={`ai-emoji-btn ${!f.emoji ? 'active' : ''}`} title="아이콘 없음(색 점)" onClick={() => setFolderEmojiFn(f.id, '')}>∅</button>
                                  {FOLDER_EMOJIS.map((em) => (
                                    <button key={em} className={`ai-emoji-btn ${f.emoji === em ? 'active' : ''}`} title={`아이콘: ${em}`} onClick={() => setFolderEmojiFn(f.id, em)}>{em}</button>
                                  ))}
                                </div>
                              </>
                            )}
                          </div>
                          {editingFolderId !== f.id && (
                            <>
                              <button className="ai-history-icon" onClick={(e) => beginFolderRename(f, e)} title="이름 변경">✎</button>
                              <button className="ai-history-del" onClick={() => deleteFolderConfirm(f.id)} title="삭제">×</button>
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            ) : (
              <>
            <div className="ai-history-head">
              <span>이전 대화</span>
              <div className="ai-history-head-actions">
                <button className="ai-mini-btn" onClick={() => setShowFolderManage(true)} title="폴더 관리">📁 폴더</button>
                <button className="ai-mini-btn" onClick={exportBulk} disabled={filteredHistory.length === 0} title="현재 목록을 하나의 마크다운으로 내보내기">⤓ 내보내기</button>
                <button className="ai-mini-btn" onClick={clearHistory} disabled={history.length === 0}>전체 삭제</button>
                <button className="ai-mini-btn" onClick={() => setShowHistory(false)}>닫기</button>
              </div>
            </div>
            {history.length > 0 && (
              <input className="ai-history-search" value={histSearch} placeholder="대화 검색 (제목·내용)…"
                onChange={(e) => setHistSearch(e.target.value)} />
            )}
            {(folders.length > 0 || allTags.length > 0) && (
              <div className="ai-filter-row">
                {folders.length > 0 && (
                  <div className="ai-chips">
                    <button className={`ai-chip ${folderFilter === 'all' ? 'active' : ''}`} onClick={() => setFolderFilter('all')}>전체</button>
                    {folders.map((f) => (
                      <button key={f.id}
                        className={`ai-chip ${folderFilter === f.id ? 'active' : ''} ${dragOverFolder === f.id ? 'dragover' : ''}`}
                        onClick={() => setFolderFilter(folderFilter === f.id ? 'all' : f.id)}
                        onDragOver={(e) => { e.preventDefault(); setDragOverFolder(f.id) }}
                        onDragLeave={() => setDragOverFolder((prev) => (prev === f.id ? null : prev))}
                        onDrop={(e) => onFolderDrop(f.id, e)}
                        title="여기로 대화를 끌어다 놓으면 이 폴더로 이동">{folderIcon(f)}{f.name}</button>
                    ))}
                    <button
                      className={`ai-chip ${folderFilter === '__none__' ? 'active' : ''} ${dragOverFolder === '__none__' ? 'dragover' : ''}`}
                      onClick={() => setFolderFilter(folderFilter === '__none__' ? 'all' : '__none__')}
                      onDragOver={(e) => { e.preventDefault(); setDragOverFolder('__none__') }}
                      onDragLeave={() => setDragOverFolder((prev) => (prev === '__none__' ? null : prev))}
                      onDrop={(e) => onFolderDrop(null, e)}
                      title="여기로 끌어다 놓으면 미분류로">미분류</button>
                  </div>
                )}
                {allTags.length > 0 && (
                  <div className="ai-chips">
                    {allTags.map((t) => (
                      <button key={t} className={`ai-chip tag ${tagFilter.includes(t) ? 'active' : ''}`} onClick={() => toggleTagFilter(t)}>#{t}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {(() => {
              if (history.length === 0) return <div className="ai-welcome-page dim" style={{ padding: '20px', textAlign: 'center' }}>저장된 대화가 없습니다.</div>
              if (filteredHistory.length === 0) return <div className="ai-welcome-page dim" style={{ padding: '20px', textAlign: 'center' }}>검색 결과가 없습니다.</div>
              return (
                <div className="ai-history-list">
                  {filteredHistory.map((h) => (
                    <div key={h.id} className="ai-history-row">
                      <div className={`ai-history-item ${convId === h.id ? 'current' : ''}`}
                        draggable={editingConvId !== h.id}
                        onDragStart={(e) => { e.dataTransfer.setData('text/bb-conv', h.id); e.dataTransfer.effectAllowed = 'move' }}
                        onClick={() => { if (editingConvId !== h.id) loadConversation(h.id) }}>
                        <div className="ai-history-main">
                          {editingConvId === h.id ? (
                            <input className="ai-history-edit" value={editTitle} autoFocus
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setEditTitle(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitRename(h.id) } else if (e.key === 'Escape') { e.preventDefault(); setEditingConvId(null) } }}
                              onBlur={() => commitRename(h.id)} />
                          ) : (
                            <>
                              <div className="ai-history-title">{histSearch.trim() ? highlightNodes(h.title, histSearch) : h.title}</div>
                              <div className="ai-history-sub">
                                {relTime(h.updatedAt)} · {h.messageCount}개
                                {h.folderId ? <span className="ai-meta-folder"> · {folderIcon(folderById(h.folderId))}{folderName(h.folderId)}</span> : null}
                                {(h.tags ?? []).map((t) => <span key={t} className="ai-meta-tag"> #{t}</span>)}
                              </div>
                              {(() => {
                                const sn = contentSnippets.get(h.id)
                                return sn ? <div className="ai-history-snippet">💬 {highlightNodes(sn, histSearch)}</div> : null
                              })()}
                            </>
                          )}
                        </div>
                        {editingConvId !== h.id && (
                          <>
                            <button className={`ai-history-icon ai-pin ${h.pinned ? 'on' : ''}`} onClick={(e) => togglePin(h, e)} title={h.pinned ? '고정 해제' : '고정'}>📌</button>
                            <button className={`ai-history-icon ${assignConvId === h.id ? 'on' : ''}`} onClick={(e) => beginAssign(h.id, e)} title="폴더·태그">📁</button>
                            <button className="ai-history-icon" onClick={(e) => beginRename(h, e)} title="이름 변경">✎</button>
                            <button className="ai-history-del" onClick={(e) => deleteConv(h.id, e)} title="삭제">×</button>
                          </>
                        )}
                      </div>
                      {assignConvId === h.id && (
                        <div className="ai-assign" onClick={(e) => e.stopPropagation()}>
                          <div className="ai-assign-label">폴더</div>
                          <div className="ai-chips">
                            <button className={`ai-chip ${!h.folderId ? 'active' : ''}`} onClick={() => assignFolder(h.id, null)}>미분류</button>
                            {folders.map((f) => (
                              <button key={f.id} className={`ai-chip ${h.folderId === f.id ? 'active' : ''}`} onClick={() => assignFolder(h.id, f.id)}>{folderIcon(f)}{f.name}</button>
                            ))}
                          </div>
                          <div className="ai-assign-newfolder">
                            <input className="ai-assign-input" value={newFolderName} placeholder="새 폴더 이름…"
                              onChange={(e) => setNewFolderName(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createFolderInline(h.id) } }} />
                            <button className="ai-mini-btn" onClick={() => createFolderInline(h.id)} disabled={!newFolderName.trim()}>＋ 폴더</button>
                          </div>
                          <div className="ai-assign-label">태그</div>
                          {(h.tags ?? []).length > 0 && (
                            <div className="ai-chips">
                              {(h.tags ?? []).map((t) => (
                                <button key={t} className="ai-chip tag removable" onClick={() => removeTag(h.id, t)} title="제거">#{t} ×</button>
                              ))}
                            </div>
                          )}
                          <input className="ai-assign-input" value={tagDraft} placeholder="태그 추가 후 Enter…"
                            onChange={(e) => setTagDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(h.id, tagDraft) } }} />
                          <button className="ai-mini-btn ai-assign-export" onClick={() => exportConv(h.id)} title="이 대화를 마크다운 파일로 저장">⤓ 이 대화 .md 로 내보내기</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )
            })()}
              </>
            )}
          </div>
        ) : (
        <>
          <div className="ai-body" ref={bodyRef}>
            {messages.length === 0 ? (
              <div className="ai-welcome">
                <div className="ai-welcome-title">이 페이지와 대화하세요</div>
                {pageInfo && !isInternal ? (
                  <div className="ai-welcome-page" title={pageInfo.url}>📄 {pageInfo.title || hostOf(pageInfo.url)}</div>
                ) : (
                  <div className="ai-welcome-page dim">웹 페이지에서 열면 그 페이지 내용을 함께 봅니다.</div>
                )}
                <div className="ai-quick">
                  <button className="ai-quick-btn" disabled={isInternal} onClick={() => send('이 페이지의 핵심 내용을 불릿으로 간결하게 요약해줘.')}>📝 이 페이지 요약</button>
                  <button className="ai-quick-btn" disabled={isInternal || !pageInfo?.hasSelection} onClick={() => send('내가 선택(드래그)한 텍스트를 쉽게 풀어서 설명해줘.')}>💡 선택 영역 설명</button>
                  <button className="ai-quick-btn" disabled={isInternal} onClick={() => send('이 페이지에서 중요한 사실이나 수치를 뽑아줘.')}>🔑 핵심 정보 추출</button>
                </div>
              </div>
            ) : (
              <>
                {foldCount > 0 && (
                  <div className="ai-fold-banner">
                    <button className="ai-fold-toggle" onClick={() => setFoldExpanded((v) => !v)}
                      title={foldExpanded ? '요약으로 접기' : '접힌 원문 보기'}>
                      🗜 이전 대화 {foldCount}개 요약됨 · {foldExpanded ? '접기' : '펼치기'}
                    </button>
                    {!foldExpanded && summary && <div className="ai-fold-summary">{summary}</div>}
                  </div>
                )}
                {(foldExpanded ? messages : messages.slice(foldCount)).map((m) => (
                  <div key={m.id} className={`ai-msg ai-${m.role} ${m.error ? 'ai-err' : ''}`}>
                    <div className="ai-msg-role">{m.role === 'user' ? '나' : 'AI'}</div>
                    <div className="ai-msg-text">
                      {m.role === 'assistant' && !m.error && m.content
                        ? <Markdown text={m.content} windowId={windowId} />
                        : m.content}
                      {m.streaming && <span className="ai-caret">▋</span>}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
          <div className="ai-compose">
            {notice && <div className="ai-handoff-note">{notice}</div>}
            <label className="ai-ctx-toggle" title="현재 페이지 내용을 질문에 함께 보냅니다">
              <input type="checkbox" checked={includePage} disabled={isInternal} onChange={(e) => setIncludePage(e.target.checked)} />
              페이지 컨텍스트{isInternal ? ' (내부 페이지 불가)' : ''}
            </label>
            <div className="ai-input-row">
              <textarea className="ai-input" value={input} rows={2}
                placeholder={providerReady ? '이 페이지에 대해 물어보세요… (Enter 전송)' : 'AI 설정을 먼저 완료하세요'}
                disabled={!providerReady} onChange={(e) => { setInput(e.target.value); if (notice) setNotice(null) }} onKeyDown={onKeyDown} />
              {streaming
                ? <button className="ai-send ai-stop" onClick={stop} title="중단">■</button>
                : <button className="ai-send" onClick={() => send(input)} disabled={!providerReady || !input.trim()} title="전송">↑</button>}
            </div>
          </div>
        </>
        )
      ) : (
        showPtasks ? (
          <div className="ai-body">
            <div className="ai-history-head">
              <span>영속 작업</span>
              <div className="ai-history-head-actions">
                <button className="ai-mini-btn" onClick={() => setShowPtasks(false)}>닫기</button>
              </div>
            </div>
            {ptaskNotice && <div className="ai-handoff-note">{ptaskNotice}</div>}
            {ptasks.length === 0 ? (
              <div className="ai-welcome-page dim" style={{ padding: '20px', textAlign: 'center' }}>영속 작업이 없습니다. 입력창에서 작업을 실행하면 여기에 남습니다.</div>
            ) : (
              <div className="ai-task-list">
                {ptasks.map((t) => (
                  <TaskCard key={t.id} t={t}
                    elapsedLabel={fmtDuration(ptaskElapsed(t))}
                    retryLabel={ptaskRetryCountdown(t)}
                    pending={ptaskPending[t.id]}
                    traceItems={ptaskTraces[t.id] ?? []}
                    evidence={ptaskEvidence[t.id]}
                    answerDraft={ptaskAnswerDraft[t.id] ?? ''}
                    canRerun={providerReady && !isInternal}
                    onPause={() => pausePtask(t.id)}
                    onResume={() => resumePtask(t.id)}
                    onCancel={() => cancelPtask(t.id)}
                    onDelete={() => deletePtask(t.id)}
                    onAccept={() => acceptPtask(t.id)}
                    onRerun={() => rerunPtask(t)}
                    onConfirm={(approved) => respondPtaskConfirm(t.id, approved)}
                    onAnswerChange={(v) => setPtaskAnswer(t.id, v)}
                    onAnswerSend={() => respondPtaskAnswer(t.id)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : showRuns ? (
          <div className="ai-body">
            {viewRun ? (
              <>
                <div className="ai-history-head">
                  <button className="ai-mini-btn" onClick={() => setViewRun(null)}>← 뒤로</button>
                  <span className="ai-run-detail-title" title={viewRun.task}>{RUN_STATUS[viewRun.status].icon} {viewRun.task}</span>
                  <button className="ai-mini-btn" onClick={() => rerunTask(viewRun.task)} disabled={isInternal || agentRunning} title={isInternal ? '웹 페이지에서만 실행' : '이 작업 다시 실행'}>▶ 다시</button>
                </div>
                {viewRun.steps.length > 3 && (
                  <input className="ai-history-search" value={runDetailSearch} placeholder="단계 검색…"
                    onChange={(e) => setRunDetailSearch(e.target.value)} />
                )}
                <div className="ai-trace">
                  {(() => {
                    if (viewRun.steps.length === 0) return <div className="ai-welcome-page dim" style={{ padding: '16px' }}>기록된 단계가 없습니다.</div>
                    const q = runDetailSearch.trim().toLowerCase()
                    const steps = q ? viewRun.steps.filter((st) => st.text.toLowerCase().includes(q)) : viewRun.steps
                    if (steps.length === 0) return <div className="ai-welcome-page dim" style={{ padding: '16px' }}>검색 결과가 없습니다.</div>
                    return steps.map((st, i) => (
                      <div key={i} className={`ai-trace-item ${st.tone ?? ''}`}>
                        <span className="ai-trace-icon">{st.icon}</span>
                        <span className="ai-trace-text">{st.text}</span>
                      </div>
                    ))
                  })()}
                </div>
              </>
            ) : (
              <>
                <div className="ai-history-head">
                  <span>작업 이력</span>
                  <div className="ai-history-head-actions">
                    <button className="ai-mini-btn" onClick={clearRuns} disabled={agentRuns.length === 0}>전체 삭제</button>
                    <button className="ai-mini-btn" onClick={() => setShowRuns(false)}>닫기</button>
                  </div>
                </div>
                {agentRuns.length > 0 && (
                  <input className="ai-history-search" value={runSearch} placeholder="작업 검색…"
                    onChange={(e) => setRunSearch(e.target.value)} />
                )}
                {(() => {
                  if (agentRuns.length === 0) return <div className="ai-welcome-page dim" style={{ padding: '20px', textAlign: 'center' }}>아직 실행한 작업이 없습니다.</div>
                  const q = runSearch.trim().toLowerCase()
                  const runs = q ? agentRuns.filter((r) => r.task.toLowerCase().includes(q)) : agentRuns
                  if (runs.length === 0) return <div className="ai-welcome-page dim" style={{ padding: '20px', textAlign: 'center' }}>검색 결과가 없습니다.</div>
                  return (
                    <div className="ai-history-list">
                      {runs.map((r) => (
                        <div key={r.id} className="ai-history-item" onClick={() => openRun(r.id)}>
                          <div className="ai-history-main">
                            <div className="ai-history-title">{RUN_STATUS[r.status].icon} {r.task}</div>
                            <div className="ai-history-sub">{relTime(r.startedAt)} · {RUN_STATUS[r.status].label} · {r.stepCount}단계</div>
                          </div>
                          <button className="ai-history-icon" onClick={(e) => { e.stopPropagation(); rerunTask(r.task) }} disabled={isInternal || agentRunning} title={isInternal ? '웹 페이지에서만 실행' : '다시 실행'}>↻</button>
                          <button className="ai-history-del" onClick={(e) => deleteRun(r.id, e)} title="삭제">×</button>
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </>
            )}
          </div>
        ) : (
        <>
          <div className="ai-body" ref={bodyRef}>
            {/* 진행/대기 중인 영속 작업 — 사이드바를 닫았다 열어도 바로 보인다. 완료·실패·중단은
                여기 안 남기고 '📌 작업' 전체 목록에서만(입력창까지 밀어내지 않도록). */}
            {livePtasks.length > 0 && (
              <div className="ai-task-list">
                {livePtasks.map((t) => (
                  <TaskCard key={t.id} t={t}
                    elapsedLabel={fmtDuration(ptaskElapsed(t))}
                    retryLabel={ptaskRetryCountdown(t)}
                    pending={ptaskPending[t.id]}
                    traceItems={ptaskTraces[t.id] ?? []}
                    evidence={ptaskEvidence[t.id]}
                    answerDraft={ptaskAnswerDraft[t.id] ?? ''}
                    canRerun={providerReady && !isInternal}
                    onPause={() => pausePtask(t.id)}
                    onResume={() => resumePtask(t.id)}
                    onCancel={() => cancelPtask(t.id)}
                    onDelete={() => deletePtask(t.id)}
                    onAccept={() => acceptPtask(t.id)}
                    onRerun={() => rerunPtask(t)}
                    onConfirm={(approved) => respondPtaskConfirm(t.id, approved)}
                    onAnswerChange={(v) => setPtaskAnswer(t.id, v)}
                    onAnswerSend={() => respondPtaskAnswer(t.id)}
                  />
                ))}
              </div>
            )}
            {trace.length === 0 && !agentRunning ? (
              <div className="ai-welcome">
                <div className="ai-welcome-title">🤖 에이전트</div>
                {isInternal
                  ? <div className="ai-welcome-page dim">웹 페이지(http/https)에서만 실행할 수 있습니다.</div>
                  : <div className="ai-welcome-page" title={pageInfo?.url}>📄 {pageInfo?.title || (pageInfo ? hostOf(pageInfo.url) : '현재 탭')}</div>}
                <p className="ai-agent-desc">현재 탭에서 대신 작업을 수행합니다. 클릭·입력·이동을 스스로 하며, <b>결제·삭제·전송</b> 같은 행동은 실행 전에 확인을 요청합니다.</p>
                <div className="ai-quick">
                  <button className="ai-quick-btn" disabled={isInternal} onClick={() => startAgent('이 페이지에서 가장 중요한 정보를 찾아 요약해줘.')}>🔎 핵심 정보 찾기</button>
                  <button className="ai-quick-btn" disabled={isInternal} onClick={() => startAgent('이 페이지의 주요 링크와 메뉴 구조를 파악해서 알려줘.')}>🧭 페이지 구조 파악</button>
                  <button className="ai-quick-btn" disabled={isInternal} onClick={startSiteReport} title="로그인된 이 사이트의 여러 페이지를 훑어보고 분석 보고서를 만듭니다(읽기 전용).">📊 이 사이트 분석 보고서</button>
                  <div className="ai-chips ai-report-depth">
                    <button className={`ai-chip ${reportDepth === 'brief' ? 'active' : ''}`} onClick={() => setReportDepth('brief')} title="핵심 페이지 위주로 빠르게">간단히</button>
                    <button className={`ai-chip ${reportDepth === 'full' ? 'active' : ''}`} onClick={() => setReportDepth('full')} title="주요 페이지를 폭넓게(단계 수 더 필요)">자세히</button>
                  </div>
                </div>
                {!isInternal && (
                  <div className="ai-examples">
                    <div className="ai-examples-head">💡 이런 것도 시킬 수 있어요 <span className="ai-examples-hint">(눌러서 다듬고 실행)</span></div>
                    <div className="ai-examples-list">
                      {AGENT_EXAMPLES.map((ex) => (
                        <button key={ex.label} className="ai-example-btn" onClick={() => fillAgentTask(ex.task)} title={ex.task}>{ex.label}</button>
                      ))}
                    </div>
                  </div>
                )}
                {savedTasks.length > 0 && (
                  <div className="ai-saved-tasks">
                    <div className="ai-saved-head">💾 저장된 작업</div>
                    {savedTasks.map((s) => (
                      <div key={s.id} className="ai-saved-item">
                        {editingTaskId === s.id ? (
                          <input className="ai-history-edit" value={editTaskName} autoFocus
                            onChange={(e) => setEditTaskName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitTaskRename(s.id) } else if (e.key === 'Escape') { e.preventDefault(); setEditingTaskId(null) } }}
                            onBlur={() => commitTaskRename(s.id)} />
                        ) : (
                          <>
                            <button className="ai-saved-run" disabled={isInternal} onClick={() => runSavedTask(s)} title={s.task}>
                              ▶ {s.name}{s.lastRunAt ? <span className="ai-saved-time"> · {relTime(s.lastRunAt)}</span> : ''}
                            </button>
                            <button className="ai-history-icon" onClick={(e) => beginTaskRename(s, e)} title="이름 변경">✎</button>
                            <button className="ai-saved-del" onClick={(e) => deleteSavedTask(s.id, e)} title="삭제">×</button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="ai-trace">
                {trace.map((t) => (
                  <div key={t.id} className={`ai-trace-item ${t.tone ?? ''}`}>
                    <span className="ai-trace-icon">{t.icon}</span>
                    <span className="ai-trace-text">
                      {t.text}
                      {t.shot && <img className="ai-trace-shot" src={`data:image/png;base64,${t.shot}`} alt="완료 화면" />}
                    </span>
                  </div>
                ))}
                {awaitingConfirm && (
                  <div className="ai-confirm">
                    <div className="ai-confirm-msg">⏸️ <b>{awaitingConfirm}</b> 을(를) 실행할까요?</div>
                    <div className="ai-confirm-btns">
                      <button className="ai-confirm-yes" onClick={() => respondConfirm(true)}>승인</button>
                      <button className="ai-confirm-no" onClick={() => respondConfirm(false)}>거부</button>
                    </div>
                  </div>
                )}
                {awaitingAsk && (
                  <div className="ai-confirm">
                    <div className="ai-confirm-msg">❓ {awaitingAsk}</div>
                    <div className="ai-ask-row">
                      <input className="ai-ask-input" value={askInput} autoFocus placeholder="답변을 입력하세요…"
                        onChange={(e) => setAskInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); respondAsk() } }} />
                      <button className="ai-confirm-yes" onClick={respondAsk} disabled={!askInput.trim()}>보내기</button>
                    </div>
                  </div>
                )}
                {agentRunning && !awaitingConfirm && !awaitingAsk && (
                  <div className="ai-trace-item muted">
                    <span className={agentPaused ? 'ai-trace-icon' : 'ai-trace-icon ai-spin'}>{agentPaused ? '⏸️' : '◔'}</span>
                    <span className="ai-trace-text">{agentPaused ? '일시정지 — 페이지 조작을 멈췄습니다' : '작업 중…'}</span>
                  </div>
                )}
              </div>
            )}
          </div>
          {report && (
            <div className="ai-report">
              <div className="ai-data-head">
                <button className="ai-data-title ai-report-toggle" onClick={() => setReportOpen((v) => !v)} title="접기/펼치기">
                  {reportOpen ? '▾' : '▸'} 📊 {report.title}
                </button>
                <div className="ai-data-actions">
                  <button className="ai-mini-btn active" onClick={openReportInStudio} title="글쓰기 스튜디오에서 편집·다듬기">✍️ 편집</button>
                  <button className="ai-mini-btn" onClick={() => void window.browserAPI.ai.reportExport({ title: report.title, markdown: report.markdown }).then((r) => setNotice(r.ok ? `⤓ 저장됨: ${r.path}` : '저장 실패'))} title="다운로드 폴더에 .md 로 저장">⤓ .md</button>
                  <button className="ai-mini-btn" onClick={() => void copyText(report.markdown)}>복사</button>
                  <button className="ai-mini-btn" onClick={() => setReport(null)}>지우기</button>
                </div>
              </div>
              {reportOpen && (
                <div className="ai-report-scroll">
                  <Markdown text={report.markdown} windowId={windowId} />
                  {report.sources.length > 0 && <div className="ai-report-src">🔗 살펴본 페이지 {report.sources.length}개</div>}
                </div>
              )}
            </div>
          )}
          {extractRows.length > 0 && (() => {
            const cols = extractCols(extractRows)
            const shown = extractRows.slice(0, 50)
            const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
            return (
              <div className="ai-data">
                <div className="ai-data-head">
                  <span className="ai-data-title">📊 수집한 데이터 {extractRows.length}건</span>
                  <div className="ai-data-actions">
                    <button className="ai-mini-btn active" disabled={streaming} onClick={analyzeCollectedData} title="수집한 데이터를 AI 로 비교·분석해 리포트로">🧠 분석·비교</button>
                    <button className="ai-mini-btn" onClick={() => { void window.browserAPI.ai.exportWebhook(extractRows).then((r) => setNotice(r.ok ? `🔗 웹훅 전송됨 (${r.detail})` : `웹훅 전송 실패: ${r.detail}`)) }} title="설정한 웹훅으로 전송(Zapier·구글시트·노션·메일 연동)">🔗 전송</button>
                    <button className="ai-mini-btn" onClick={() => downloadText(`data-${ts}.csv`, 'text/csv', rowsToCSV(extractRows))}>CSV</button>
                    <button className="ai-mini-btn" onClick={() => downloadText(`data-${ts}.json`, 'application/json', JSON.stringify(extractRows, null, 2))}>JSON</button>
                    <button className="ai-mini-btn" onClick={() => void copyText(rowsToCSV(extractRows))}>복사</button>
                    <button className="ai-mini-btn" onClick={() => setExtractRows([])}>지우기</button>
                  </div>
                </div>
                <div className="ai-data-scroll">
                  <table className="ai-data-table">
                    <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                    <tbody>{shown.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c} title={r[c] ?? ''}>{r[c] ?? ''}</td>)}</tr>)}</tbody>
                  </table>
                </div>
                {extractRows.length > shown.length && <div className="ai-data-more">표엔 {shown.length}건만 표시 · 내보내기에는 전체 {extractRows.length}건 포함</div>}
              </div>
            )
          })()}
          {(activeRepeats.length > 0 || resumableRepeats.length > 0) && (
            <div className="ai-repeats">
              {activeRepeats.map((r) => (
                <div key={r.id} className="ai-repeat-item">
                  <div className="ai-repeat-head">
                    <span className="ai-repeat-task" title={r.task}>🔁 {r.task}</span>
                    <button className="ai-repeat-stop" onClick={() => void window.browserAPI.ai.repeatStop(r.id)} title="반복 중지">중지</button>
                  </div>
                  <div className="ai-repeat-meta">{repeatStatusText(r)}{r.autoConfirm ? ' · 무인 자동 승인' : ''}{r.lastResult ? ` · ${r.lastResult}` : ''}</div>
                </div>
              ))}
              {/* 재시작 후 자동 부활하지 않는다(T10) — 사용자가 명시적으로 다시 시작해야 한다. */}
              {resumableRepeats.map((r) => (
                <div key={r.id} className="ai-repeat-item muted">
                  <div className="ai-repeat-head">
                    <span className="ai-repeat-task" title={r.task}>🔁 {r.task}</span>
                    <button className="ai-repeat-stop resume" onClick={() => void window.browserAPI.ai.scheduleResume(r.id)} title="다시 시작">재시작으로 멈춤 — 다시 시작</button>
                  </div>
                  <div className="ai-repeat-meta">{r.doneCount}회 완료됨</div>
                </div>
              ))}
            </div>
          )}
          {ptaskNotice && <div className="ai-handoff-note">{ptaskNotice}</div>}
          <div className="ai-compose">
            {/* 실행 방식 — '장시간'은 명시 선택이며, 고르면 무엇을 승인하는지 한 줄로 보인다.
                일반 실행이 압도 다수이므로 기본은 항상 '일반'(로드 시 초기화 안 함 — 사용자가 마지막에
                고른 방식이 아니라 매번 안전한 기본값으로 시작). */}
            <div className="ai-exec-mode">
              <span className="ai-exec-label">실행 방식</span>
              <div className="ai-chips">
                <button className={`ai-chip ${execMode === 'normal' ? 'active' : ''}`} onClick={() => setExecMode('normal')}>일반</button>
                <button className={`ai-chip ${execMode === 'long' ? 'active' : ''}`} onClick={() => setExecMode('long')} title="사이드바를 닫거나 브라우저를 오래 켜 둔 채로 장시간 이어가는 작업">장시간</button>
              </div>
            </div>
            {execMode === 'long' && (
              <div className="ai-exec-long">
                <div className="ai-exec-warn">⚠ 브라우저를 켜 둔 동안 최대 {longMaxHours}시간 계속 시도합니다.</div>
                <div className="ai-repeat-fields">
                  <span>최대 <input type="number" min={1} value={longMaxHours} onChange={(e) => setLongMaxHours(Math.max(1, Number(e.target.value) || 1))} />시간</span>
                  <span>단계 <input type="number" min={10} value={longMaxSteps} onChange={(e) => setLongMaxSteps(Math.max(10, Number(e.target.value) || 10))} />개</span>
                  <span>호출 <input type="number" min={10} value={longMaxLlmCalls} onChange={(e) => setLongMaxLlmCalls(Math.max(10, Number(e.target.value) || 10))} />회</span>
                </div>
              </div>
            )}
            <button className="ai-adv-toggle" onClick={() => setShowAdvanced((v) => !v)}
              title="자동 반복·데이터 반복·허용 사이트 등 고급 실행 옵션">
              <span className="ai-adv-caret">{showAdvanced ? '▾' : '▸'}</span>
              고급 옵션
              {(repeatOn || batchOn || allowedHostsText.trim()) && <span className="ai-adv-badge">켜짐</span>}
            </button>
            {showAdvanced && (
            <div className="ai-repeat-config">
              <label className="ai-ctx-toggle" title="작업을 일정 간격으로 자동 반복 실행합니다">
                <input type="checkbox" checked={repeatOn} disabled={isInternal} onChange={(e) => setRepeatOn(e.target.checked)} />
                🔁 자동 반복
              </label>
              {repeatOn && (
                <div className="ai-repeat-fields">
                  <span>매 <input type="number" min={1} value={repeatEvery} onChange={(e) => setRepeatEvery(Math.max(1, Number(e.target.value) || 1))} />분</span>
                  <span><input type="number" min={0} value={repeatCount} onChange={(e) => setRepeatCount(Math.max(0, Number(e.target.value) || 0))} />회 <span className="dim">(0=무제한)</span></span>
                  <label className="ai-repeat-auto" title="게시·삭제 같은 되돌리기 어려운 동작을 확인 없이 자동 승인합니다. 위험하니 신뢰하는 작업에만 켜세요.">
                    <input type="checkbox" checked={repeatAuto} onChange={(e) => setRepeatAuto(e.target.checked)} />
                    무인 자동 승인 ⚠
                  </label>
                </div>
              )}
              <label className="ai-ctx-toggle" title="데이터(CSV 또는 목록)의 각 행마다 같은 작업을 자동 반복합니다">
                <input type="checkbox" checked={batchOn} disabled={isInternal} onChange={(e) => setBatchOn(e.target.checked)} />
                📋 데이터 반복
              </label>
              {batchOn && (
                <div className="ai-batch-fields">
                  <textarea className="ai-batch-data" rows={3} value={batchData} disabled={agentRunning}
                    placeholder={'CSV(첫 줄 헤더) 또는 한 줄에 하나.\n예:\n이름,이메일\n홍길동,a@b.com\n김철수,c@d.com\n\n지시에 {이름} 처럼 열 이름을 쓰면 값으로 채워집니다.'}
                    onChange={(e) => setBatchData(e.target.value)} />
                  {(() => { const n = parseDataset(batchData).length; return n ? <div className="dim" style={{ fontSize: 11 }}>{n}개 행 감지 — 각 행마다 작업 실행</div> : <div className="dim" style={{ fontSize: 11 }}>데이터를 붙여넣으세요(CSV/목록)</div> })()}
                  <label className="ai-repeat-auto" title="게시·삭제 같은 되돌리기 어려운 동작을 확인 없이 자동 승인합니다.">
                    <input type="checkbox" checked={repeatAuto} onChange={(e) => setRepeatAuto(e.target.checked)} />
                    무인 자동 승인 ⚠
                  </label>
                </div>
              )}
              {/* 실행별 범위 한도 — 일반·장시간 어느 쪽에도 적용. 비우면 제한 없음. */}
              <div className="ai-exec-hosts">
                <label className="ai-exec-hosts-label" title="이 실행에서 이동을 허용할 사이트. 비우면 제한 없음.">🌐 허용 사이트 (선택)</label>
                <textarea className="ai-batch-data" rows={2} value={allowedHostsText}
                  placeholder={'example.com\nshop.example.com\n(줄바꿈 또는 쉼표로 구분 · 비우면 제한 없음)'}
                  onChange={(e) => setAllowedHostsText(e.target.value)} />
              </div>
            </div>
            )}
            <div className="ai-input-row">
              <textarea ref={agentInputRef} className="ai-input" value={agentTask} rows={2}
                placeholder={isInternal ? '웹 페이지에서만 실행할 수 있습니다' : providerReady ? '무엇이든 시켜보세요 (예: 로그인 폼 찾아서 이메일칸 클릭)' : 'AI 설정을 먼저 완료하세요'}
                disabled={!providerReady || isInternal || agentRunning} onChange={(e) => setAgentTask(e.target.value)} onKeyDown={onAgentKeyDown} />
              {agentRunning
                ? <button className="ai-send ai-stop" onClick={stopAgent} title="중단">■</button>
                : <button className="ai-send" onClick={runAgentOrRepeat} disabled={!providerReady || isInternal || !agentTask.trim()} title={batchOn ? '데이터 반복 실행' : repeatOn ? '반복 시작' : '실행'}>{batchOn ? '📋' : repeatOn ? '🔁' : '▶'}</button>}
            </div>
          </div>
        </>
        )
      )}
    </div>
  )
}
