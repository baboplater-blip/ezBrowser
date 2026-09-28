// 영속 작업 카드 + 대상 탭 재선택 패널 (묶음 K — AiTab.tsx 2,388줄 분할). 순수 이동 — 동작 변경 없음.
import { useState } from 'react'
import {
  hostOf, NEEDS_MANUAL_ACTION, retryKindLabel, taskStateLabel, waitCauseInfo,
} from './ai-shared'
import type { TaskPending, TaskSummary, TaskTargetCandidate, TaskTargetList, TraceItem } from './ai-shared'
// i18n(묶음 M2) — 이 파일은 `t` 를 TaskSummary 소문자 prop 이름으로 이미 쓰고 있어(t.state 등),
// 번역 함수는 `tr` 로 부른다(ai-shared.tsx 와 같은 관례).
import { useI18nT } from '../../i18n'

/**
 * "어느 탭에서 이어갈지" 를 사람이 고르는 좁은 폭(280px) 인라인 패널.
 *
 * 절대 떠 있는 팝오버로 만들지 않는다(사이드바 도크 규칙 — 콘텐츠 뷰를 가린다). 카드 안에서
 * 펼쳐지고, 후보 목록은 **메인이 정본**이다. 여기서 고른 tabId 는 메인이 다시 검증하므로
 * 이 컴포넌트가 잘못된 id 를 보내도 통과하지 못한다.
 *
 * 고르는 것은 **실행도 승인도 아니다** — 고르면 '미완료' 로 돌아갈 뿐이고, 이어가기는 따로 눌러야 한다.
 */
export function TaskTargetPicker({ taskId }: { taskId: string }) {
  const tr = useI18nT()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<TaskTargetList | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const res = await window.browserAPI.ai.ptaskTargets(taskId)
      setList(res as TaskTargetList | null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const choose = async (tabId: string): Promise<void> => {
    setBusy(true); setError(null)
    try {
      const res = await window.browserAPI.ai.ptaskSetTarget(taskId, tabId)
      if (res?.ok) { setOpen(false); return }
      // 고르는 사이에 그 탭이 닫혔을 수 있다 — 사유를 보이고 목록을 새로 받는다.
      setError(res?.error || tr('ai.taskcard.picker.setFailed', '대상을 설정하지 못했습니다.'))
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  if (!open) {
    return (
      <div className="ai-task-note warn">
        <button className="ai-mini-btn active ai-target-open"
          onClick={() => { setOpen(true); void load() }}>🎯 {tr('ai.taskcard.picker.openButton', '대상 탭 선택')}</button>
      </div>
    )
  }

  return (
    <div className="ai-target-picker">
      <div className="ai-target-head">
        <b>{tr('ai.taskcard.picker.heading', '어느 탭에서 이어갈까요?')}</b>
        <div className="ai-history-head-actions">
          <button className="ai-mini-btn ai-target-refresh" onClick={() => void load()} disabled={busy}>↻</button>
          <button className="ai-mini-btn" onClick={() => setOpen(false)}>{tr('ai.taskcard.picker.close', '닫기')}</button>
        </div>
      </div>
      {list?.expected?.url && (
        <div className="ai-target-expected dim">
          {tr('ai.taskcard.picker.originalTarget', '원래 대상:')} {list.expected.url}
          {list.expected.windowLabel ? ` · ${list.expected.windowLabel}` : ''}
          {list.expected.workspaceName ? ` · ${list.expected.workspaceName}` : ''}
        </div>
      )}
      {list?.reason && <div className="ai-target-expected dim">{list.reason}</div>}
      {error && <div className="ai-task-note warn">{error}</div>}
      {busy && !list && <div className="ai-target-expected dim">{tr('ai.taskcard.picker.loading', '불러오는 중…')}</div>}
      {list && list.tabs.length === 0 && (
        <div className="ai-target-expected dim">
          {tr('ai.taskcard.picker.empty', '고를 수 있는 탭이 없습니다 — 작업하던 페이지를 연 뒤 ↻ 로 다시 불러오세요.')}
          {/* 여기서 하네스든 UI든 탭을 대신 열어 주지 않는다 — 사람이 연 탭만 대상이 된다. */}
        </div>
      )}
      {list?.tabs.map((c: TaskTargetCandidate) => (
        <button key={c.tabId} className="ai-target-item ai-target-pick" data-tab-id={c.tabId}
          disabled={busy} onClick={() => void choose(c.tabId)}>
          <span className="ai-target-title">{c.title || c.url}</span>
          <span className="ai-target-sub dim">
            {hostOf(c.url)} · {c.windowLabel}
            {c.sameUrl ? ' · ' + tr('ai.taskcard.picker.samePage', '같은 페이지') : ''}
            {c.active ? ' · ' + tr('ai.taskcard.picker.currentTab', '현재 탭') : ''}
          </span>
        </button>
      ))}
    </div>
  )
}

// 영속 작업 카드 — 목록(showPtasks 전체 보기)과 인라인 "진행 중" 영역이 이 한 컴포넌트를 함께 쓴다.
// SKILL 의 "한 뷰 = 한 목적" 을 지키려고 별도 상세 화면을 두지 않았다 — 카드 자체가 이미 상태·진척·
// 대기 이유·버튼을 전부 담고 있어, 드릴다운 없이도 필요한 조작을 이 자리에서 끝낼 수 있다.
export function TaskCard({
  t, windowId, elapsedLabel, retryLabel, pending, traceItems, evidence, answerDraft, canRerun,
  onPause, onResume, onCancel, onDelete, onAccept, onRerun, onConfirm, onAnswerChange, onAnswerSend,
}: {
  t: TaskSummary
  windowId: string
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
  const tr = useI18nT()
  const meta = taskStateLabel(tr, t.state)
  const cancellable = t.state === 'running' || t.state === 'paused' || t.state === 'waiting-user' || t.state === 'retrying' || t.state === 'queued'
  const terminal = t.state === 'completed' || t.state === 'failed' || t.state === 'cancelled'
  return (
    <div className={`ai-task-card ${meta.tone ?? ''}`}>
      <div className="ai-task-head">
        <span className={`ai-task-badge ${meta.tone ?? ''}`}>{meta.icon} {meta.label}</span>
        <span className="ai-task-instruction" title={t.instruction}>{t.instruction}</span>
      </div>
      <div className="ai-task-meta">
        {t.mode === 'long' && <span className="ai-task-pill">{tr('ai.taskcard.longMode', '장시간')}</span>}
        <span>{elapsedLabel}</span>
        <span>· {tr('ai.taskcard.step', '단계')} {t.stepsUsed}/{t.maxSteps}{t.segment > 1 ? ` · ${tr('ai.taskcard.segment', '구간')} ${t.segment}` : ''}</span>
        <span>· {tr('ai.taskcard.calls', '호출')} {t.llmCalls}/{t.maxLlmCalls}</span>
      </div>

      {t.state === 'retrying' && t.retry && (
        <div className="ai-task-note warn">
          🔄 {retryKindLabel(tr, t.retry.kind)} · {tr('ai.taskcard.retryNth', '{n}번째 재시도', { n: t.retry.attempt })}{retryLabel ? ` · ${retryLabel}` : ''}
        </div>
      )}
      {/* 단계 소진 등으로 이어가지 못한 것이지 실패가 아니다 — ✅ 로 오인시키지 않고 '미완료'로 정직하게.
          waitCause 가 있으면(재시작 전 승인·로그인·CAPTCHA 대기 중이었다면) 그 사유를 그대로 보여준다 —
          "재시작으로 중단됐습니다"라는 무해한 문구 뒤에 결제 승인 대기 같은 상태를 숨기지 않기 위해서다.
          waitCause 가 없는 옛 저장본은 기존 일반 문구 그대로(회귀 없음). */}
      {t.state === 'interrupted' && (
        t.waitCause ? (
          <div className="ai-task-note warn">
            <div><b>{waitCauseInfo(tr, t.waitCause).icon} {waitCauseInfo(tr, t.waitCause).title}</b></div>
            {t.waitReason && <div>{t.waitReason}</div>}
            {waitCauseInfo(tr, t.waitCause).hint && (
              <div className="ai-task-evidence dim">{waitCauseInfo(tr, t.waitCause).hint}</div>
            )}
          </div>
        ) : (
          <div className="ai-task-note warn">{tr('ai.taskcard.notFinished', '완료하지 못했습니다 — 이어갈 수 있습니다.')}</div>
        )
      )}
      {/* 모델이 done 을 냈어도 근거(완료 문구·결과 파일 등)가 확인되기 전에는 완료로 표시하지 않는다. */}
      {t.state === 'needs-verify' && (
        <div className="ai-task-note warn">
          {tr('ai.taskcard.pleaseVerify', '완료를 확인해 주세요.')}
          {evidence ? <div className="ai-task-evidence">{evidence}</div> : <div className="ai-task-evidence dim">{tr('ai.taskcard.loadingEvidence', '근거를 불러오는 중…')}</div>}
        </div>
      )}
      {/* 사용자가 기다림을 풀려면 가야 할 곳(예: 로그인 계정 등록·허용) — 사유만 주고 끝내지 않는다.
          재시작으로 waiting-user → interrupted 가 돼도 이 버튼이 사라지면 갈 곳을 잃으므로 함께 보인다. */}
      {(t.state === 'waiting-user' || t.state === 'interrupted') && t.waitActionUrl && (
        <div className="ai-task-note warn">
          <button className="ai-mini-btn" onClick={() => {
            const u = t.waitActionUrl
            if (u) void window.browserAPI?.tabs?.create?.(windowId, u)
          }}>{t.waitActionLabel ?? tr('ai.taskcard.openSettings', '설정 열기')}</button>
        </div>
      )}
      {/* 대상 탭을 다시 찾지 못해 멈춘 경우 — 승인/거부가 아니라 **어느 탭인지**를 골라야 풀린다.
          (confirmTask 로는 이 대기가 풀리지 않는다 — 메인의 유일한 출구가 setTaskTarget 이다.) */}
      {(t.state === 'waiting-user' || t.state === 'interrupted') && t.waitCause === 'tab-target' && (
        <TaskTargetPicker taskId={t.id} />
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
          <div className="ai-confirm-msg">⏸️ {tr('ai.taskcard.confirmRun', '{label} 을(를) 실행할까요?', { label: pending.label })}</div>
          <div className="ai-confirm-btns">
            <button className="ai-confirm-yes" onClick={() => onConfirm(true)}>{tr('ai.taskcard.approve', '승인')}</button>
            <button className="ai-confirm-no" onClick={() => onConfirm(false)}>{tr('ai.taskcard.reject', '거부')}</button>
          </div>
        </div>
      )}
      {pending?.kind === 'ask' && (
        <div className="ai-confirm">
          <div className="ai-confirm-msg">❓ {pending.message}</div>
          <div className="ai-ask-row">
            <input className="ai-ask-input" value={answerDraft} placeholder={tr('ai.taskcard.answerPlaceholder', '답변을 입력하세요…')}
              onChange={(e) => onAnswerChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAnswerSend() } }} />
            <button className="ai-confirm-yes" onClick={onAnswerSend} disabled={!answerDraft.trim()}>{tr('ai.taskcard.send', '보내기')}</button>
          </div>
        </div>
      )}
      {/* 'tab-target' 은 승인·답변으로 풀리지 않는다 — 위 대상 선택 패널이 유일한 출구라
          여기서 승인/거부 버튼을 보여 주면 눌러도 아무 일이 없어 사용자를 헷갈리게 한다. */}
      {!pending && t.state === 'waiting-user' && t.waitCause !== 'tab-target' && (
        <div className="ai-confirm">
          <div className="ai-confirm-msg">❓ {t.waitReason ?? tr('ai.taskcard.confirmNeeded', '확인이 필요합니다.')}</div>
          <div className="ai-confirm-btns">
            <button className="ai-confirm-yes" onClick={() => onConfirm(true)}>{tr('ai.taskcard.approve', '승인')}</button>
            <button className="ai-confirm-no" onClick={() => onConfirm(false)}>{tr('ai.taskcard.reject', '거부')}</button>
          </div>
          <div className="ai-ask-row" style={{ marginTop: 6 }}>
            <input className="ai-ask-input" value={answerDraft} placeholder={tr('ai.taskcard.answerDirectPlaceholder', '또는 직접 답변…')}
              onChange={(e) => onAnswerChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onAnswerSend() } }} />
            <button className="ai-confirm-yes" onClick={onAnswerSend} disabled={!answerDraft.trim()}>{tr('ai.taskcard.send', '보내기')}</button>
          </div>
        </div>
      )}

      <div className="ai-task-actions">
        {t.state === 'running' && <button className="ai-mini-btn" onClick={onPause} title={tr('ai.taskcard.pause', '일시정지')}>⏸ {tr('ai.taskcard.pause', '일시정지')}</button>}
        {t.state === 'paused' && <button className="ai-mini-btn active" onClick={onResume} title={tr('ai.taskcard.resume', '재개')}>▶ {tr('ai.taskcard.resume', '재개')}</button>}
        {/* login·captcha·user-fix·confirm·ledger 는 사람이 브라우저에서 직접 처리해야 풀린다 —
            버튼을 없애지 않되(명시적으로는 계속 이어갈 수 있어야 한다) 문구로 그 사실을 알린다. */}
        {t.state === 'interrupted' && (
          /* 'tab-target' 은 위 선택 패널이 정상 출구다. 그래도 버튼을 없애지는 않는다 —
             원래 탭이 다시 준비된 경우(느려서 못 깨웠던 탭 등)에는 그대로 이어갈 수 있어서다.
             다만 "처리했습니다" 라는 문구는 오해를 부르므로 조건을 문구에 그대로 적는다. */
          t.waitCause === 'tab-target' ? (
            <button className="ai-mini-btn" onClick={onResume}
              title={tr('ai.taskcard.resumeSameTabOnlyTitle', '원래 탭이 다시 열려 있을 때만 이어집니다 — 아니면 위에서 대상 탭을 고르세요')}>
              ▶ {tr('ai.taskcard.resumeSameTab', '그대로 이어가기')}
            </button>
          ) : t.waitCause && NEEDS_MANUAL_ACTION.has(t.waitCause) ? (
            <button className="ai-mini-btn active" onClick={onResume} title={tr('ai.taskcard.resumeAfterManualTitle', '직접 처리를 마친 뒤 누르세요')}>▶ {tr('ai.taskcard.resumeAfterManual', '처리했습니다 — 이어가기')}</button>
          ) : (
            <button className="ai-mini-btn active" onClick={onResume} title={tr('ai.taskcard.resume2', '이어가기')}>▶ {tr('ai.taskcard.resume2', '이어가기')}</button>
          )
        )}
        {t.state === 'needs-verify' && <button className="ai-mini-btn active" onClick={onAccept} title={tr('ai.taskcard.acceptResultTitle', '완료를 확인하고 승인')}>✅ {tr('ai.taskcard.acceptResult', '결과 승인')}</button>}
        {cancellable && <button className="ai-mini-btn" onClick={onCancel} title={tr('ai.taskcard.stop', '중단')}>⏹ {tr('ai.taskcard.stop', '중단')}</button>}
        {canRerun && terminal && <button className="ai-mini-btn" onClick={onRerun} title={tr('ai.taskcard.rerunTitle', '같은 작업 다시 실행')}>↻ {tr('ai.taskcard.rerun', '다시')}</button>}
        {(terminal || t.state === 'needs-verify' || t.state === 'interrupted') && (
          <button className="ai-history-del" onClick={onDelete} title={tr('ai.taskcard.deleteFromList', '목록에서 삭제')}>×</button>
        )}
      </div>
    </div>
  )
}
