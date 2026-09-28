import { useEffect, useRef, useState } from 'react'
// i18n(묶음 M2) - 번역 함수는 tr 로 부른다. 이 파일은 TaboFolder 류 t 충돌은 없지만
// AiTab.tsx / TaskCard.tsx 와 이름을 통일해 관례를 지킨다.
import { useI18nT } from '../i18n'

// AI 소셜 패널 — 두 하위 뷰를 하나로 묶는다.
// ① 이미지 만들어 올리기: 생성 서비스(Genspark/ChatGPT/직접 URL)로 이미지를 만들고, 캡션을 확인한 뒤
//    SNS(인스타/유튜브/틱톡)에 올린다. 진행 단계(생성→확인→게시)를 카드로 보여준다.
// ② 관심 블로그 댓글·좋아요: 관심사에 맞는 블로그를 찾아 댓글/좋아요를 남긴다(초안 또는 실제 실행).
//    시작 전 "허용될 사이트"(engageBuildTask 가 넓게 잡아 돌려준 목록)를 사용자가 보고 좁힐 수 있게 하며,
//    활동 기록(중복 방지 근거)을 항상 볼 수 있게 한다.
// 실행은 기존 backend API(social*/engage*/ptask*)만 쓴다 — 이 라운드에서 새 IPC 는 만들지 않는다.

// ===== 백엔드(chrome.ts) 타입을 이 파일에 필요한 만큼만 미러링 — 프리로드 독립 원칙과 동일하게,
// 렌더러 쪽도 각 컴포넌트가 자신이 쓰는 모양만 로컬로 선언한다(AiTab.tsx 의 TaskSummary/RunSummary 와 동일 관례). =====
type SocialService = 'genspark' | 'chatgpt' | 'custom'
type SocialPlatform = 'instagram' | 'youtube' | 'tiktok'
type SocialMode = 'draft' | 'publish'
type SocialStage = 'generate' | 'review' | 'publish' | 'done' | 'failed' | 'cancelled'

interface SocialParams {
  service: SocialService
  customUrl?: string
  prompt: string
  platform: SocialPlatform
  account?: string
  tone?: string
  tags?: string[]
  mode: SocialMode
  windowId: string | null
  tabId: string
}
interface SocialWorkflow {
  id: string
  params: SocialParams
  stage: SocialStage
  taskIds: { generate?: string; publish?: string }
  artifactId?: string
  artifactPreview?: { width?: number; height?: number; bytes: number; format: string; sha256: string }
  caption?: string
  captionError?: string
  artifactAmbiguous?: boolean
  autoPublished?: boolean
  receipt?: { url?: string; evidence?: string; status?: ReceiptStatus; at: number }
  captionPending?: boolean
  captionUserEdited?: boolean
  publishUncertain?: boolean
  verifyTaskId?: string
  recovery?: WorkflowRecovery
  error?: string
  createdAt: number
  updatedAt: number
  /** 사용자가 이 초안을 게시로 올린 시각. 있으면 이미 승격된 작업이다. */
  promotedAt?: number
  /** 승격 전의 지난 영수증들(초안 준비 기록 등). 최신이 뒤. */
  priorReceipts?: Array<{ url?: string; evidence?: string; status?: ReceiptStatus; at: number; taskId?: string; note?: string }>
}

/** 초안 승격("이 초안을 게시하기") 확인 계획 — main 의 socialPromotePrepare 가 돌려주는 값을 그대로 미러링. */
interface AiPromotionPlan {
  token: string
  workflowId: string
  revision: string
  platform: SocialPlatform
  platformLabel: string
  platformLabelEn: string
  account: string
  caption: string
  artifactId: string
  artifactSha256: string
  artifactBytes: number
  artifactFormat: string
  tags: string[]
  source: 'review' | 'completed-draft'
  expiresAt: number
}
type AiPromotePrepareResult =
  | { ok: true; plan: AiPromotionPlan }
  | { ok: false; error: string; errorEn: string }
type PublishResolution = 'verify' | 'published' | 'not-published'
interface WorkflowRecovery {
  kind: 'caption-interrupted' | 'caption-failed' | 'publish-uncertain' | 'publish-storage-failed'
  stoppedAt: string
  nextAction: string
  at: number
}
interface AutoPublishGrantView {
  id: string; createdAt: number
  platform: SocialPlatform
  accounts: string[]
  maxPosts: number; expiresAt: number; used: number
  consumed: string[]
  revokedAt?: number
}
interface ArtifactMeta { id: string; name: string; format: string; bytes: number; width?: number; height?: number }
interface EngageLedgerEntry { key: string; account: string; action: 'comment' | 'like'; at: number; note?: string }

// PLATFORM_LABEL/SERVICE_LABEL 은 화면 라벨 - i18n. TONE_PRESETS 는 캡션 생성 프롬프트에
// 그대로 실리는 값(백엔드로 전송)이라 번역 범위 밖(다른 컴포넌트의 AGENT_EXAMPLES.task 와 동일 판단).
function platformLabel(tr: TFn, p: SocialPlatform): string {
  switch (p) {
    case 'instagram': return tr('ai.social.platform.instagram', '인스타그램')
    case 'youtube': return tr('ai.social.platform.youtube', '유튜브')
    case 'tiktok': return tr('ai.social.platform.tiktok', '틱톡')
  }
}
function serviceLabel(tr: TFn, s: SocialService): string {
  switch (s) {
    case 'genspark': return 'Genspark'
    case 'chatgpt': return 'ChatGPT'
    case 'custom': return tr('ai.social.directInput', '직접 입력')
  }
}
const TONE_PRESETS = ['친근하게', '전문적으로', '짧고 간결하게']
const STAGE_ORDER: SocialStage[] = ['generate', 'review', 'publish', 'done']
type TFn = (key: string, fallback?: string, vars?: Record<string, string | number>) => string

function stepClass(stage: SocialStage, step: 'generate' | 'review' | 'publish'): string {
  if (stage === 'failed' || stage === 'cancelled') return ''
  const curIdx = STAGE_ORDER.indexOf(stage)
  const stepIdx = STAGE_ORDER.indexOf(step)
  if (curIdx < 0) return ''
  if (curIdx === stepIdx) return 'active'
  return curIdx > stepIdx ? 'done' : ''
}
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}
function fmtWhen(tr: TFn, ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return tr('ai.shared.relTime.now', '방금')
  if (m < 60) return tr('ai.shared.relTime.minutesAgo', '{m}분 전', { m })
  const h = Math.floor(m / 60)
  if (h < 24) return tr('ai.shared.relTime.hoursAgo', '{h}시간 전', { h })
  try { return new Date(ts).toLocaleDateString() } catch { return '' }
}
/**
 * 영수증이 말하는 결론의 종류(main 의 `ReceiptStatus` 미러링).
 *
 * ⚠ 예전에는 이 판단을 `evidence` **문장에 정규식**을 걸어 내렸다("미확인" 이 있으면 경고).
 *   그런데 그 문장에는 **실제 글에서 읽어 온 발췌가 그대로** 들어간다 — 사용자의 캡션에 "미확인"
 *   이라는 낱말이 있으면 **확인된 게시가 경고로** 보이고, 반대로 확인되지 않은 결론의 문구가 조금만
 *   달라지면 **확인 안 된 것이 ✅ 로** 보인다. 이제 판정은 판정을 내린 자리에서 값으로 온다.
 */
type ReceiptStatus = 'verified' | 'user-confirmed' | 'draft' | 'unverified'

/** status 가 없는 **옛 영수증**만 문장으로 물러서서 판단한다(새 영수증에는 쓰이지 않는다). */
function legacyEvidenceUnresolved(evidence?: string): boolean {
  return !!evidence && /미확인|확인되지\s*않|확인하지\s*못/.test(evidence)
}
function receiptStatusOf(r?: { evidence?: string; status?: ReceiptStatus }): ReceiptStatus | 'legacy-unverified' | 'legacy-ok' | null {
  if (!r) return null
  if (r.status) return r.status
  return legacyEvidenceUnresolved(r.evidence) ? 'legacy-unverified' : 'legacy-ok'
}
/**
 * ⚠ 키를 **유니온으로 못 박는다.** 느슨한 `Record<string, …>` 이면 나중에 상태값이 하나 늘었을 때
 *   대응 표시를 빠뜨려도 컴파일이 통과하고, 그때 아래 폴백이 **✅(성공) 쪽으로 조용히 새는**
 *   fail-open 이 된다 — 저장소 복원(`reviveWorkflow`)은 모르는 값을 경고 쪽으로 보내는데
 *   화면만 반대 방향으로 새면 이번에 고친 "표시가 판정을 뒤집는" 문제가 그대로 재발한다.
 */
/** ✅ 로 보여도 되는 상태. 여기 없으면 전부 경고로 본다(모르는 값 포함). */
const RECEIPT_OK: ReadonlySet<string> = new Set(['verified', 'user-confirmed', 'draft', 'legacy-ok'])
function receiptMark(tr: TFn, status: ReceiptStatus | 'legacy-unverified' | 'legacy-ok'): { icon: string; label: string } {
  switch (status) {
    case 'verified': return { icon: '✅', label: '' }
    case 'user-confirmed': return { icon: '✅', label: tr('ai.social.receipt.userConfirmed', '사용자 확인 — ') }
    case 'draft': return { icon: '📝', label: '' }
    case 'unverified': return { icon: '⚠', label: tr('ai.social.receipt.needsCheck', '확인 필요 — ') }
    case 'legacy-unverified': return { icon: '⚠', label: tr('ai.social.receipt.needsCheck', '확인 필요 — ') }
    case 'legacy-ok': return { icon: '✅', label: '' }
  }
}

/**
 * "이 초안을 게시하기" 버튼을 보일지. main 이 최종 권한을 갖지만(같은 판정을 다시 하고 토큰을 낸다),
 * 불가능한 상황에서 버튼 자체를 숨기는 것이 1차 방어다.
 *
 * ⚠ `stage === 'review'` 일 때만 `taskIds.publish` 를 확인한다 — `stage === 'done'` 인 초안은
 *   "초안 준비" 작업 기록이 `taskIds.publish` 에 정상적으로 남아 있으므로, 그 필드로 두 단계를
 *   함께 걸러내면 완료된 초안의 버튼이 항상 사라진다.
 */
function canPromote(w: SocialWorkflow): boolean {
  if (w.params.mode === 'publish') return false          // 애초에 게시 작업이다
  if (w.promotedAt) return false                          // 이미 승격했다
  if (w.publishUncertain || w.verifyTaskId) return false  // 게시 여부 불확실 — 손대지 않는다
  if (w.stage === 'review') {
    if (w.taskIds.publish) return false                   // 게시 작업 레코드가 남아 있다
    return !w.captionPending && !w.captionError && !!w.caption?.trim()
  }
  if (w.stage === 'done') return w.receipt?.status === 'draft'
  return false
}

/**
 * 확인 단계의 계정 편집 한 줄. 계정은 **게시 전에는 아무 곳에도 나가지 않는** 표시·대조용 값이라
 * 여기서 고쳐도 안전하다. 실제 허용 여부는 main(`setWorkflowAccount`)이 판정하고, 여기서는
 * 그 결과(성공/거부 사유/선승인 범위)를 사용자 말로 옮긴다.
 */
function AccountRow({ w, onSaveAccount }: {
  w: SocialWorkflow
  onSaveAccount: (account: string) => Promise<{ ok: boolean; error?: string; autoPublish?: string; handleShaped?: boolean }>
}) {
  const tr = useI18nT()
  const saved = w.params.account ?? ''
  const [draft, setDraft] = useState(saved)
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // 다른 창에서 계정이 바뀌면 따라간다 — 단, **사용자가 지금 고치는 중이면 덮어쓰지 않는다.**
  // ⚠ 이 보호는 ref 로 읽어야 한다. 저장 브로드캐스트(`ai:social-changed`)가 늦게 도착하거나
  //   다른 창에서 같은 작업의 계정을 저장하면 `saved` 가 바뀌는데, 그때 조건 없이 setDraft 하면
  //   **사용자가 입력 중이던 값이 오류도 없이 조용히 사라진다.**
  const lastSaved = useRef(saved)
  const draftRef = useRef(draft)
  draftRef.current = draft
  useEffect(() => {
    if (lastSaved.current === saved) return
    const wasEditing = draftRef.current.trim().replace(/^@+/, '') !== lastSaved.current
    lastSaved.current = saved
    if (!wasEditing) setDraft(saved)   // 고치는 중이 아닐 때만 바깥 값으로 맞춘다
  }, [saved])

  const dirty = draft.trim().replace(/^@+/, '') !== saved
  async function save(): Promise<void> {
    setBusy(true)
    try {
      const r = await onSaveAccount(draft)
      if (!r.ok) { setNote({ kind: 'err', text: r.error || tr('ai.social.account.changeFailed', '계정을 바꾸지 못했습니다.') }); return }
      const bits: string[] = [tr('ai.social.account.changed', '계정을 바꿨습니다 — 이미지와 캡션은 그대로입니다.')]
      if (r.handleShaped === false) bits.push(tr('ai.social.account.notHandleShaped', '아이디 형태가 아니라 게시 여부 자동 확인은 "모름" 으로만 끝납니다(@ 없이 아이디를 넣어 주세요).'))
      // 계정을 손으로 고친 작업은 선승인이 있어도 **자동으로 나가지 않는다**(main 이 강제).
      // 범위 밖이라서든, 고쳤기 때문이든 — 사용자에게는 "게시 전에 한 번 더 확인한다" 가 중요하다.
      if (r.autoPublish === 'not-covered') bits.push(tr('ai.social.account.notCovered', '이 계정은 자동 게시 선승인 범위 밖입니다 — 게시 전에 확인을 받습니다.'))
      else if (r.autoPublish === 'covered') bits.push(tr('ai.social.account.covered', '계정을 직접 고친 작업이라, 선승인이 있어도 게시 전에 한 번 확인을 받습니다.'))
      setNote({ kind: 'ok', text: bits.join(' ') })
    } finally { setBusy(false) }
  }

  return (
    <div className="ai-social-account">
      <label className="ai-hint" htmlFor={`acct-${w.id}`}>{tr('ai.social.account.toPost', '올릴 계정')}</label>
      <div className="ai-social-account-row">
        <input id={`acct-${w.id}`} className="ai-input ai-social-account-input" value={draft}
          placeholder={tr('ai.social.account.placeholder', '계정 아이디 (@ 없이)')} spellCheck={false} disabled={busy}
          onChange={(e) => { setDraft(e.target.value); setNote(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && dirty && !busy) void save() }} />
        <button className="ai-mini-btn ai-social-account-save" disabled={!dirty || busy}
          onClick={() => void save()}
          title={tr('ai.social.account.saveTitle', '계정만 바꿉니다 — 만든 이미지와 캡션은 그대로 유지됩니다')}>💾 {tr('ai.social.account.save', '계정 저장')}</button>
      </div>
      {note && <div className={note.kind === 'err' ? 'ai-handoff-note ai-err' : 'ai-hint'}>{note.text}</div>}
      {!note && !saved && <div className="ai-hint">{tr('ai.social.account.hint', '계정을 넣어 두면 게시 뒤 "정말 내 계정에 올라갔는지" 를 자동으로 확인할 수 있습니다.')}</div>}
    </div>
  )
}

/**
 * 초안 승격 확정 패널 — 무엇이 어디로 나가는지 마지막으로 한눈에 보여준 뒤에만 게시로 넘긴다.
 * 이미지·캡션은 여기서 절대 다시 만들지 않는다(그대로 올라간다는 것이 이 패널의 존재 이유).
 */
function PromotePanel({ plan, busy, onConfirm, onCancel }: {
  plan: AiPromotionPlan
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const tr = useI18nT()
  return (
    <div className="ai-social-promote-panel" data-testid="social-promote-panel" data-revision={plan.revision}>
      <div className="ai-social-promote-title">
        ⚠ {tr('ai.social.promote.confirmTitle', '정말 게시할까요?')}<span className="ai-social-en">Publish for real?</span>
      </div>
      <div className="ai-social-promote-row">
        <span className="ai-social-promote-label">{tr('ai.social.promote.destination', '목적지')} / Destination</span>
        <span data-testid="social-promote-platform">{plan.platformLabel} ({plan.platformLabelEn})</span>
      </div>
      <div className="ai-social-promote-row">
        <span className="ai-social-promote-label">{tr('ai.social.account.label', '계정')} / Account</span>
        <span data-testid="social-promote-account">@{plan.account}</span>
      </div>
      <div className="ai-social-promote-row">
        <span className="ai-social-promote-label">{tr('ai.social.promote.image', '이미지')} / Image</span>
        <span data-testid="social-promote-hash">
          {plan.artifactFormat} · {formatBytes(plan.artifactBytes)} · sha256 {plan.artifactSha256.slice(0, 12)}…
        </span>
      </div>
      <div className="ai-social-promote-caption" data-testid="social-promote-caption">{plan.caption}</div>
      {plan.tags.length > 0 && (
        /* 태그는 캡션 끝에 실제로 붙어 나간다 — 보여 주지 않으면 확인 화면이 올라갈 내용과 달라진다. */
        <div className="ai-social-promote-tags" data-testid="social-promote-tags">
          {plan.tags.map((tg) => `#${tg}`).join(' ')}
        </div>
      )}
      <div className="ai-hint">
        {tr('ai.social.promote.notRegenerated', '이미지와 캡션은 다시 만들지 않습니다 — 위 내용 그대로 올라갑니다.')}
        <span className="ai-social-en">Nothing is regenerated — exactly the image and caption above will be posted.</span>
      </div>
      <div className="ai-handoff-note ai-err">
        {tr('ai.social.cannotUndo', '되돌릴 수 없습니다.')}<span className="ai-social-en">This cannot be undone.</span>
      </div>
      <div className="ai-task-actions">
        <button className="ai-send ai-social-promote-go" data-testid="social-promote-go" onClick={onConfirm} disabled={busy}>
          {busy ? tr('ai.social.promote.publishing', '게시하는 중…') : (<>{tr('ai.social.promote.confirm', '게시 확정')}<span className="ai-social-en">Publish</span></>)}
        </button>
        <button className="ai-mini-btn" data-testid="social-promote-cancel" onClick={onCancel} disabled={busy}>
          {tr('ai.tab.cancel', '취소')}<span className="ai-social-en">Cancel</span>
        </button>
      </div>
    </div>
  )
}

// ===== 카드(뷰1의 진행 중 워크플로 1개) =====
function SocialCard({
  w, candidates, previewData, captionDraft,
  onChooseCandidate, onCaptionChange, onApprove, onCancel, onDelete, onRetry,
  onRetryCaption, onSaveCaption, onSaveAccount, onResolvePublish,
  promotion, promoteError, promoteBusy, onPromote, onPromoteConfirm, onPromoteCancel,
}: {
  w: SocialWorkflow
  candidates: Array<{ meta: ArtifactMeta; dataUrl: string | null }> | undefined
  previewData: string | null | undefined
  captionDraft: string
  onChooseCandidate: (artifactId: string) => void
  onCaptionChange: (v: string) => void
  onApprove: (caption: string) => void
  onCancel: () => void
  onDelete: () => void
  onRetry: () => void
  onRetryCaption: () => void
  onSaveCaption: (caption: string) => void
  onSaveAccount: (account: string) => Promise<{ ok: boolean; error?: string; autoPublish?: string; handleShaped?: boolean }>
  onResolvePublish: (choice: PublishResolution) => void
  promotion: AiPromotionPlan | undefined
  promoteError: { error: string; errorEn: string } | undefined
  promoteBusy: boolean
  onPromote: () => void
  onPromoteConfirm: () => void
  onPromoteCancel: () => void
}) {
  const tr = useI18nT()
  const terminal = w.stage === 'done' || w.stage === 'failed' || w.stage === 'cancelled'
  const rStatus = receiptStatusOf(w.receipt)
  // 영수증이 있을 때만 판단하고, **아는 성공값이 아니면 경고**로 본다(아이콘 폴백과 같은 방향).
  // 영수증 자체가 없으면 예전처럼 중립으로 둔다 — 없는 것을 경고로 바꾸는 것은 이번 범위가 아니다.
  const unresolved = !!w.receipt && !RECEIPT_OK.has(rStatus ?? '')
  return (
    <div className={`ai-social-card ${w.stage === 'done' ? (unresolved ? 'warn' : 'ok') : w.stage === 'failed' ? 'warn' : ''}`} data-workflow-id={w.id}>
      <div className="ai-task-head">
        <span className="ai-task-badge">{platformLabel(tr, w.params.platform)}</span>
        <span className="ai-task-instruction" title={w.params.prompt}>{w.params.prompt}</span>
      </div>
      <div className="ai-task-meta">
        <span>{serviceLabel(tr, w.params.service)}</span>
        <span>· {w.params.mode === 'publish' ? tr('ai.social.toPublish', '게시까지') : tr('ai.social.draftOnly', '초안까지만')}</span>
        {w.promotedAt && <span>· {tr('ai.social.promotedFromDraft', '초안→게시 승격됨')} <span className="ai-social-en-inline">promoted</span></span>}
      </div>

      {w.stage === 'failed' || w.stage === 'cancelled' ? (
        <span className={`ai-task-badge ${w.stage === 'failed' ? 'warn' : 'muted'}`}>{w.stage === 'failed' ? tr('ai.social.failed', '실패') : tr('ai.social.cancelled', '취소됨')}</span>
      ) : (
        <div className="ai-social-steps">
          <span className={`ai-social-step ${stepClass(w.stage, 'generate')}`}>{tr('ai.social.stepGenerate', '생성')}</span>
          <span className={`ai-social-step ${stepClass(w.stage, 'review')}`}>{tr('ai.social.stepReview', '확인')}</span>
          <span className={`ai-social-step ${stepClass(w.stage, 'publish')}`}>{tr('ai.social.stepPublish', '게시')}</span>
        </div>
      )}

      {/* 중단 후 복구 안내 — 어디서 멈췄는지 + 다음에 무엇을 하면 되는지. 새 작업을 만들지 않고 이어간다. */}
      {w.recovery && !terminal && (
        <div className="ai-social-recovery">
          <div className="ai-social-recovery-head">⏸ {tr('ai.social.stoppedAt', '중단된 지점: {where}', { where: w.recovery.stoppedAt })}</div>
          <div className="ai-hint">{w.recovery.nextAction}</div>
        </div>
      )}

      {w.stage === 'generate' && (
        !w.artifactId && candidates && candidates.length > 0 ? (
          <>
            <div className="ai-hint">{tr('ai.social.pickOneOfCandidates', '여러 후보 중 하나를 고르세요.')}</div>
            <div className="ai-social-thumbs">
              {candidates.map((c) => (
                <button key={c.meta.id} className="ai-social-thumb" onClick={() => onChooseCandidate(c.meta.id)} title={c.meta.name}>
                  {c.dataUrl ? <img src={c.dataUrl} alt={c.meta.name} /> : null}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="ai-hint">{tr('ai.social.generatingImage', '이미지를 만드는 중… (수십 초~수 분 걸릴 수 있어요)')}</div>
        )
      )}

      {w.stage === 'review' && (
        <>
          <div className="ai-social-preview">
            {previewData === undefined
              ? <span className="ai-hint">{tr('ai.social.loadingPreview', '미리보기 불러오는 중…')}</span>
              : previewData
                ? <img src={previewData} alt={tr('ai.social.generatedImageAlt', '생성된 이미지')} />
                : <span className="ai-hint">{tr('ai.social.previewLoadFailed', '미리보기를 불러오지 못했습니다.')}</span>}
          </div>
          {w.artifactPreview && (
            <div className="ai-social-preview-meta">
              {w.artifactPreview.width ?? '?'}×{w.artifactPreview.height ?? '?'} · {formatBytes(w.artifactPreview.bytes)} · {w.artifactPreview.format}
            </div>
          )}
          {/* 계정 고치기 — 빠뜨렸거나 잘못 넣었을 때 이미지·캡션을 버리고 처음부터 다시 만들지 않아도 된다.
              게시 전(확인 단계)에서만 보인다. 게시가 나갔거나 나갔는지 모르는 동안에는 잠긴다(main 이 강제). */}
          <AccountRow w={w} onSaveAccount={onSaveAccount} />
          <textarea className="ai-input" rows={3} value={captionDraft} placeholder={tr('ai.social.caption', '캡션')}
            onChange={(e) => onCaptionChange(e.target.value)} />
          {/* 캡션 생성이 실패하면 프롬프트를 캡션으로 대신 올리지 않는다 — 사유를 보이고 기다린다. */}
          {w.captionError
            ? <div className="ai-handoff-note ai-err">{w.captionError}</div>
            : w.captionPending
              ? <div className="ai-hint">{tr('ai.social.writingCaption', '캡션을 쓰는 중…')}</div>
              : w.artifactAmbiguous
                ? <div className="ai-hint">{tr('ai.social.ambiguousCandidates', '이미지 후보가 여럿이라 확인이 필요합니다 — 자동 게시하지 않습니다.')}</div>
                : <div className="ai-hint">{tr('ai.social.stopsHere', '이 단계에서 멈춥니다 — 아래 버튼을 눌러야 다음으로 넘어갑니다.')}</div>}
          {/* 캡션이 중단·실패했을 때: 같은 보관 이미지를 그대로 두고 다시 만들거나 직접 써서 저장한다. */}
          {(w.captionError || w.recovery?.kind === 'caption-interrupted') && (
            <div className="ai-task-actions">
              <button className="ai-mini-btn" onClick={onRetryCaption} disabled={!!w.captionPending}
                title={tr('ai.social.retryCaptionTitle', '같은 이미지로 캡션만 다시 만듭니다')}>↻ {tr('ai.social.retryCaption', '캡션 다시 만들기')}</button>
              <button className="ai-mini-btn" onClick={() => onSaveCaption(captionDraft)} disabled={!captionDraft.trim()}
                title={tr('ai.social.useThisCaptionTitle', '지금 입력한 캡션을 저장합니다(늦게 도착한 자동 초안이 덮어쓰지 않습니다)')}>💾 {tr('ai.social.useThisCaption', '이 캡션 사용')}</button>
            </div>
          )}
          <button className="ai-send ai-social-cta" onClick={() => onApprove(captionDraft)} disabled={!captionDraft.trim()}>
            {w.params.mode === 'publish' ? '📤 ' + tr('ai.social.publishAsIs', '이대로 게시') : '▶ ' + tr('ai.social.proceedAsIs', '이대로 진행')}
          </button>
        </>
      )}

      {w.stage === 'publish' && (
        w.publishUncertain ? (
          <div className="ai-social-recovery warn">
            {/* 되돌릴 수 없는 결정이므로 "그냥 이어가기"를 주지 않는다 — 먼저 확인하거나 사용자가 결론을 준다. */}
              {/* 저장된 산출물 미리보기 — 무엇이 올라갔을 수 있는지를 사용자가 눈으로 확인한다. */}
            {previewData ? <div className="ai-social-preview"><img src={previewData} alt={tr('ai.social.aboutToPublishAlt', '게시하려던 이미지')} /></div> : null}
            {w.caption ? <div className="ai-social-preview-meta" title={w.caption}>{tr('ai.social.captionLabel', '캡션:')} {w.caption}</div> : null}
            <div className="ai-hint">{tr('ai.social.duplicateRisk', '확인 없이 이어가면 같은 글이 두 번 올라갈 수 있습니다.')}</div>
            <div className="ai-task-actions">
              <button className="ai-mini-btn" onClick={() => onResolvePublish('verify')} disabled={!!w.verifyTaskId}
                title={tr('ai.social.verifyReadOnlyTitle', '새 글을 올리지 않고 읽기만 해서 이미 게시됐는지 확인합니다')}>
                {w.verifyTaskId ? '🔎 ' + tr('ai.social.verifying', '확인하는 중…') : '🔎 ' + tr('ai.social.verifyPublished', '게시 여부 확인 (읽기 전용)')}
              </button>
              <button className="ai-mini-btn" onClick={() => onResolvePublish('published')}
                title={tr('ai.social.alreadyPublishedTitle', '직접 확인했고 이미 올라가 있습니다')}>✅ {tr('ai.social.alreadyPublished', '이미 게시됨')}</button>
              <button className="ai-mini-btn" onClick={() => onResolvePublish('not-published')}
                title={tr('ai.social.notPublishedTitle', '직접 확인했고 올라가지 않았습니다 — 이어서 진행합니다')}>▶ {tr('ai.social.notPublishedProceed', '게시 안 됨 · 이어가기')}</button>
            </div>
          </div>
        ) : (
          <div className="ai-hint">{w.autoPublished ? tr('ai.social.autoPublishing', '선승인 범위 안이라 확인 없이 게시하는 중…') : tr('ai.social.publishing', '게시하는 중…')}</div>
        )
      )}

      {/* 승격 전의 지난 기록 — 지우거나 덮어쓰지 않고 접어서 보존한다.
          ⚠ `done` 안에 두지 않는다: 승격이 실패해 단계가 'review' 로 돌아간 경우에도 이 기록은
             남아 있어야 사용자가 "무슨 일이 있었는지" 를 볼 수 있다(데이터로만 보존하고 화면에서
             사라지면 보존하지 않은 것과 같다). */}
      {w.priorReceipts && w.priorReceipts.length > 0 && (
        <details className="ai-social-prior">
          <summary>{tr('ai.social.priorRecordsCount', '이전 기록 {n}건', { n: w.priorReceipts.length })} <span className="ai-social-en-inline">Previous records</span></summary>
          <div className="ai-social-prior-list">
            {w.priorReceipts.map((r, i) => (
              <div key={`${r.at}-${i}`} className="ai-social-prior-item">
                {/* 시각이 유효할 때만 보여 준다 — 손상된 기록의 0 을 그대로 쓰면 "1970년" 이 뜬다. */}
                {r.at > 0 && <span className="ai-social-prior-when">{fmtWhen(tr, r.at)}</span>}
                {r.evidence && <span className="ai-social-prior-evidence">{r.evidence}</span>}
                {r.note && <span className="ai-hint">{r.note}</span>}
              </div>
            ))}
          </div>
        </details>
      )}

      {w.stage === 'done' && (
        <>
          <div className="ai-social-receipt">
            {w.receipt?.url && <div><a href={w.receipt.url} target="_blank" rel="noreferrer">{w.receipt.url}</a></div>}
            {w.receipt?.evidence && (
              <div className="ai-social-receipt-status" data-status={rStatus ?? ''}>
                {/* 모르는 값은 **경고 쪽**으로 떨어뜨린다(fail-closed) — 확인 안 된 것을 ✅ 로 보이는 것이
                    반대 경우보다 훨씬 나쁘다. 저장소 복원의 방향과 같다. */}
                {(rStatus ? receiptMark(tr, rStatus) : receiptMark(tr, 'unverified')).icon}{' '}
                {(rStatus ? receiptMark(tr, rStatus) : receiptMark(tr, 'unverified')).label}{w.receipt.evidence}
              </div>
            )}
            {w.receipt?.at ? <div className="ai-hint">{fmtWhen(tr, w.receipt.at)}</div> : null}
          </div>
        </>
      )}

      {w.stage === 'failed' && <div className="ai-task-note warn">{w.error || tr('ai.social.failedDot', '실패했습니다.')}</div>}
      {w.stage === 'cancelled' && <div className="ai-task-note warn">{tr('ai.social.cancelledDot', '취소되었습니다.')}</div>}

      {/* 초안 승격("이 초안을 게시하기") — review 의 CTA·done 의 영수증 블록이 위에서 이미 그려진 뒤라,
          여기 한 곳에 두면 두 단계 모두에서 "그 아래" 에 자연히 나타난다. */}
      {canPromote(w) && !promotion && (
        <button className="ai-mini-btn ai-social-promote" onClick={onPromote} disabled={promoteBusy}
          title={tr('ai.social.publishDraftTitle', '이미지와 캡션을 다시 만들지 않고, 지금 이대로 게시합니다 / Publishes as-is — no image or caption is regenerated')}>
          📤 {tr('ai.social.publishDraft', '이 초안을 게시하기')}
          <span className="ai-social-en">Publish this draft</span>
        </button>
      )}
      {promoteError && (
        <div data-testid="social-promote-error" className="ai-handoff-note ai-err">
          {promoteError.error}<span className="ai-social-en-inline">{promoteError.errorEn}</span>
        </div>
      )}
      {promotion && (
        <PromotePanel plan={promotion} busy={promoteBusy} onConfirm={onPromoteConfirm} onCancel={onPromoteCancel} />
      )}

      <div className="ai-task-actions">
        {(w.stage === 'generate' || w.stage === 'review' || w.stage === 'publish') && (
          <button className="ai-mini-btn" onClick={onCancel} title={tr('ai.tab.cancel', '취소')}>⏹ {tr('ai.tab.cancel', '취소')}</button>
        )}
        {w.stage === 'failed' && <button className="ai-mini-btn" onClick={onRetry} title={tr('ai.social.retrySameSettingsTitle', '같은 설정으로 다시 시도')}>↻ {tr('ai.social.retrySameSettings', '다시 시도')}</button>}
        {terminal && <button className="ai-history-del" onClick={onDelete} title={tr('ai.tab.delete', '삭제')}>×</button>}
      </div>
    </div>
  )
}

export function AiSocialPanel({
  windowId, activeId, isInternal, providerReady,
}: {
  windowId: string
  activeId: string | undefined
  isInternal: boolean
  providerReady: boolean
}) {
  const tr = useI18nT()
  const [view, setView] = useState<'generate' | 'engage'>('generate')

  // ===== 뷰1: 이미지 만들어 올리기 =====
  const [genService, setGenService] = useState<SocialService>('genspark')
  const [customUrl, setCustomUrl] = useState('')
  const [prompt, setPrompt] = useState('')
  const [genPlatform, setGenPlatform] = useState<SocialPlatform>('instagram')
  const [genAccount, setGenAccount] = useState('')
  const [tone, setTone] = useState('')
  const [tags, setTags] = useState('')
  const [genMode, setGenMode] = useState<SocialMode>('draft')
  // 자동 게시 선승인 — 기본은 꺼짐. 사용자가 이 작업을 시작할 때 직접 켠 경우에만 적용된다.
  const [autoPublish, setAutoPublish] = useState(false)
  const [autoMaxPosts, setAutoMaxPosts] = useState(1)
  const [autoMinutes, setAutoMinutes] = useState(30)
  const [grantInfo, setGrantInfo] = useState<AutoPublishGrantView | null>(null)
  const refreshGrant = () => { void window.browserAPI.ai.socialGrantGet().then(setGrantInfo) }
  const [genBusy, setGenBusy] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  const [workflows, setWorkflows] = useState<SocialWorkflow[]>([])
  const [candidates, setCandidates] = useState<Record<string, Array<{ meta: ArtifactMeta; dataUrl: string | null }>>>({})
  const [previewData, setPreviewData] = useState<Record<string, string | null>>({})
  const [captionDrafts, setCaptionDrafts] = useState<Record<string, string>>({})
  const captionSeededRef = useRef<Set<string>>(new Set())
  // 초안 승격("이 초안을 게시하기") — 워크플로 id 별로 열린 확정 패널·오류·진행중 여부를 든다.
  const [promotions, setPromotions] = useState<Record<string, AiPromotionPlan>>({})
  const [promoteErrors, setPromoteErrors] = useState<Record<string, { error: string; errorEn: string }>>({})
  const [promoteBusyIds, setPromoteBusyIds] = useState<Record<string, boolean>>({})

  useEffect(() => {
    void window.browserAPI.ai.socialList().then(setWorkflows)
    const off = window.browserAPI.ai.onSocialChanged((list) => setWorkflows(list))
    return off
  }, [])

  // 생성 후보(여러 장 나올 수 있는 경우) 썸네일 — 아직 못 받았으면 다시 시도, 받았으면 멈춘다.
  useEffect(() => {
    for (const w of workflows) {
      if (w.stage !== 'generate' || w.artifactId || !w.taskIds.generate) continue
      const already = candidates[w.id]
      if (already && already.length) continue
      const tid = w.taskIds.generate
      void window.browserAPI.ai.artifactList(tid).then(async (list) => {
        if (!list.length) return
        const items = await Promise.all(list.map(async (m) => ({
          meta: m as ArtifactMeta,
          dataUrl: (await window.browserAPI.ai.artifactData(tid, m.id))?.dataUrl ?? null,
        })))
        setCandidates((prev) => ({ ...prev, [w.id]: items }))
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflows, candidates])

  // 확정된 이미지 미리보기(캡션 확인 단계 이후) — 한 번만 받아 캐시.
  useEffect(() => {
    for (const w of workflows) {
      if (!w.artifactId || !w.taskIds.generate) continue
      if (w.id in previewData) continue
      const tid = w.taskIds.generate
      const aid = w.artifactId
      void window.browserAPI.ai.artifactData(tid, aid).then((r) => {
        setPreviewData((prev) => ({ ...prev, [w.id]: r?.dataUrl ?? null }))
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflows, previewData])

  // 캡션 초안 — review 단계에 처음 들어설 때만 백엔드 값으로 시드(그 뒤엔 사용자 편집을 덮어쓰지 않음).
  useEffect(() => {
    for (const w of workflows) {
      if (w.stage === 'review' && !captionSeededRef.current.has(w.id)) {
        captionSeededRef.current.add(w.id)
        setCaptionDrafts((prev) => ({ ...prev, [w.id]: w.caption ?? '' }))
      }
    }
  }, [workflows])

  // 열린 확정 패널이 낡아지면 자동으로 닫는다 — 사용자가 **더 이상 사실이 아닌 화면**을 보며
  // 게시 확정을 누르는 일을 막는다. 낡는 경우는 셋이다.
  //   ① 이미 승격됐다(promotedAt) ② 계획을 딸 때의 단계에서 벗어났다
  //   ③ 확정이 묶여 있는 사실 — 캡션·계정 — 이 그 사이에 바뀌었다
  // ③ 은 메인이 확정 시점에 revision 으로 다시 걸러 내지만(그래서 안전은 이미 확보돼 있다),
  // 화면에 옛 캡션이 그대로 떠 있으면 사용자는 "확인한 대로 나간다" 고 믿는다. 화면이 거짓말을
  // 하지 않게 하는 것이 여기 목적이다.
  useEffect(() => {
    setPromotions((prev) => {
      if (Object.keys(prev).length === 0) return prev
      let changed = false
      const next = { ...prev }
      for (const w of workflows) {
        const plan = next[w.id]
        if (!plan) continue
        const expectedStage: SocialStage = plan.source === 'review' ? 'review' : 'done'
        const drifted = (w.caption ?? '').trim() !== plan.caption
          || (w.params.account ?? '').trim() !== plan.account
          || w.params.platform !== plan.platform
          || (w.artifactId ?? '') !== plan.artifactId
        if (w.promotedAt || w.stage !== expectedStage || drifted) {
          delete next[w.id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [workflows])

  const requestPromote = async (id: string) => {
    setPromoteErrors((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }; delete next[id]; return next
    })
    const r: AiPromotePrepareResult = await window.browserAPI.ai.socialPromotePrepare(id)
    if (!r.ok) {
      setPromoteErrors((prev) => ({ ...prev, [id]: { error: r.error, errorEn: r.errorEn } }))
      return
    }
    setPromotions((prev) => ({ ...prev, [id]: r.plan }))
  }
  const cancelPromote = (id: string) => {
    setPromotions((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }; delete next[id]; return next
    })
    void window.browserAPI.ai.socialPromoteCancel(id)
  }
  const confirmPromote = async (id: string) => {
    const plan = promotions[id]
    if (!plan) return
    setPromoteBusyIds((prev) => ({ ...prev, [id]: true }))
    try {
      const r = await window.browserAPI.ai.socialPromoteConfirm(id, plan.token)
      setPromotions((prev) => {
        if (!(id in prev)) return prev
        const next = { ...prev }; delete next[id]; return next
      })
      // 토큰이 이미 무효라 실패했을 수 있으므로, 같은 패널을 다시 열어 두지 않는다 —
      // 다시 시도하려면 승격 버튼을 눌러 새 확정을 받아야 한다.
      if (!r.ok) {
        setPromoteErrors((prev) => ({
          ...prev,
          [id]: { error: r.error || tr('ai.social.promote.confirmFailed', '게시를 확정하지 못했습니다.'), errorEn: r.errorEn || 'Could not confirm the publish.' },
        }))
      }
    } finally {
      setPromoteBusyIds((prev) => {
        if (!(id in prev)) return prev
        const next = { ...prev }; delete next[id]; return next
      })
    }
  }

  const startGenerate = async () => {
    if (!activeId || genBusy || !prompt.trim()) return
    if (genService === 'custom' && !customUrl.trim()) { setGenError(tr('ai.social.enterCustomUrl', '직접 입력할 생성 서비스 URL을 입력하세요.')); return }
    setGenBusy(true); setGenError(null)
    try {
      // 선승인은 **작업을 만들기 전에** 등록한다 — 작업이 선승인보다 먼저 생기면 범위 밖으로 판정돼
      // 자동 게시가 되지 않는다(메인의 createdAt 비교 규칙).
      if (genMode === 'publish' && autoPublish) {
        const g = await window.browserAPI.ai.socialGrant({
          platform: genPlatform,
          accounts: [genAccount.trim() || 'default'],
          maxPosts: autoMaxPosts,
          minutes: autoMinutes,
        })
        setGrantInfo(g)
        if (!g) { setGenError(tr('ai.tab.intent.autoPublishGrantFailed', '자동 게시 선승인을 등록하지 못했습니다 — 확인 후 게시로 진행합니다.')); }
      }
      const params = {
        service: genService,
        customUrl: genService === 'custom' ? customUrl.trim() : undefined,
        prompt: prompt.trim(),
        platform: genPlatform,
        account: genAccount.trim() || undefined,
        tone: tone.trim() || undefined,
        tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
        mode: genMode,
        windowId,
        tabId: activeId,
      }
      const w = await window.browserAPI.ai.socialStart(params)
      if (!w) { setGenError(tr('ai.tab.intent.startFailed', '작업을 시작하지 못했습니다.')); return }
      setPrompt('') // 연속 생성 편의 — 나머지 옵션(서비스·플랫폼·톤 등)은 유지
    } catch (e) {
      setGenError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenBusy(false)
    }
  }
  const chooseCandidate = (workflowId: string, artifactId: string) => { void window.browserAPI.ai.socialChoose(workflowId, artifactId) }
  const approveWorkflow = (workflowId: string, caption: string) => { void window.browserAPI.ai.socialApprove(workflowId, caption) }
  const cancelWorkflow = (id: string) => { void window.browserAPI.ai.socialCancel(id) }
  const deleteWorkflow = (id: string) => { void window.browserAPI.ai.socialDelete(id) }
  const retryWorkflow = (w: SocialWorkflow) => {
    void window.browserAPI.ai.socialStart(w.params).then((nw) => { if (nw) void window.browserAPI.ai.socialDelete(w.id) })
  }
  // 중단 후 복구 — 셋 다 **새 작업을 만들지 않는다**(같은 워크플로·같은 보관 이미지를 그대로 이어간다).
  const retryCaption = (id: string) => { void window.browserAPI.ai.socialRetryCaption(id).then(applyResult) }
  const saveCaption = (id: string, caption: string) => { void window.browserAPI.ai.socialSetCaption(id, caption).then(applyResult) }
  // 계정 고치기는 결과를 **그 카드 안에서** 보여 준다(패널 상단 오류 줄로 밀어내지 않는다) —
  // 방금 누른 자리에서 왜 안 됐는지 읽혀야 사용자가 다음 행동을 고른다.
  const saveAccount = (id: string, account: string) => window.browserAPI.ai.socialSetAccount(id, account)
  const resolvePublish = (id: string, choice: PublishResolution) => {
    void window.browserAPI.ai.socialResolvePublish(id, choice).then(applyResult)
  }
  const applyResult = (r: { ok: boolean; error?: string }) => { if (!r?.ok && r?.error) setGenError(r.error) }

  // ===== 뷰2: 관심 블로그 댓글·좋아요 =====
  const [myBlogUrl, setMyBlogUrl] = useState('')
  const [topic, setTopic] = useState('')
  const [searchUrl, setSearchUrl] = useState('')
  const [engageAccount, setEngageAccount] = useState('')
  const [maxPosts, setMaxPosts] = useState(5)
  const [doComment, setDoComment] = useState(true)
  const [doLike, setDoLike] = useState(true)
  const [excludeHosts, setExcludeHosts] = useState('')
  const [intervalSeconds, setIntervalSeconds] = useState(30)
  // 이 작업을 언제까지 할 것인가(분). 0 = 기한 없음(글 수로만 제한).
  const [engageWindowMin, setEngageWindowMin] = useState(0)
  const [engageMode, setEngageMode] = useState<'draft' | 'act'>('draft')
  const [engageBusy, setEngageBusy] = useState(false)
  const [engageError, setEngageError] = useState<string | null>(null)
  const [engageNotice, setEngageNotice] = useState<string | null>(null)
  const [engageStep, setEngageStep] = useState<'form' | 'review'>('form')
  const [engageBuild, setEngageBuild] = useState<{ task: string; openUrl: string; hosts: string[] } | null>(null)
  const [ledger, setLedger] = useState<EngageLedgerEntry[] | null>(null)

  const refreshLedger = () => { void window.browserAPI.ai.engageLedger(30).then(setLedger) }
  useEffect(() => { refreshLedger() }, [])

  const buildEngageTask = async () => {
    if (engageBusy) return
    if (!myBlogUrl.trim() && !topic.trim()) { setEngageError(tr('ai.social.needBlogOrTopic', '블로그 주소 또는 주제 중 하나는 입력하세요.')); return }
    if (!doComment && !doLike) { setEngageError(tr('ai.social.needCommentOrLike', '댓글·좋아요 중 하나는 선택하세요.')); return }
    setEngageBusy(true); setEngageError(null); setEngageNotice(null)
    try {
      // engageBuildTask 의 파라미터 타입(AiEngageParams)에 intervalSeconds 가 아직 반영되지 않았을 수
      // 있어(백엔드 blog-engage.ts 병행 작업), 리터럴이 아닌 변수로 넘겨 타입 폭 검사를 피한다 —
      // 필드가 무시되더라도 이 파일의 컴파일은 그 변경과 독립적이다.
      const actions: Array<'comment' | 'like'> = []
      if (doComment) actions.push('comment')
      if (doLike) actions.push('like')
      const params = {
        myBlogUrl: myBlogUrl.trim() || undefined,
        topic: topic.trim() || undefined,
        searchUrl: searchUrl.trim() || undefined,
        account: engageAccount.trim() || undefined,
        maxPosts: Math.max(1, Math.min(20, maxPosts)),
        actions,
        mode: engageMode,
        excludeHosts: excludeHosts.split(',').map((s) => s.trim()).filter(Boolean),
        intervalSeconds: Math.max(0, Math.min(600, intervalSeconds)),
        // 기한은 "지금부터 N분" 을 절대 시각으로 바꿔 넘긴다(메인이 표식에 실어 코드로 강제한다).
        until: engageWindowMin > 0 ? Date.now() + engageWindowMin * 60_000 : undefined,
      }
      const res = await window.browserAPI.ai.engageBuildTask(params)
      setEngageBuild({ task: res.task, openUrl: res.openUrl, hosts: [...res.allowedHosts] })
      setEngageStep('review')
    } catch (e) {
      setEngageError(e instanceof Error ? e.message : String(e))
    } finally {
      setEngageBusy(false)
    }
  }
  const removeHost = (h: string) => setEngageBuild((prev) => (prev ? { ...prev, hosts: prev.hosts.filter((x) => x !== h) } : prev))
  const startEngage = async () => {
    if (!engageBuild || !activeId || engageBuild.hosts.length === 0 || engageBusy) return
    setEngageBusy(true); setEngageError(null)
    try {
      await window.browserAPI.omnibox.navigate(windowId, activeId, engageBuild.openUrl)
      await new Promise((r) => setTimeout(r, 1200))
      const summary = await window.browserAPI.ai.ptaskCreate({
        instruction: engageBuild.task, tabId: activeId, budget: { allowedHosts: engageBuild.hosts },
      })
      if (!summary) { setEngageError(tr('ai.tab.intent.createFailed', '작업을 만들지 못했습니다.')); return }
      const startRes = await window.browserAPI.ai.ptaskStart(summary.id)
      if (!startRes?.ok) { setEngageError(startRes?.error || tr('ai.tab.intent.startFailed', '작업을 시작하지 못했습니다.')); return }
      setEngageNotice(tr('ai.social.engageStarted', '작업을 시작했습니다 — 🤖 에이전트 탭의 📌 작업에서 진행 상황을 볼 수 있습니다.'))
      setEngageStep('form'); setEngageBuild(null)
      refreshLedger()
    } catch (e) {
      setEngageError(e instanceof Error ? e.message : String(e))
    } finally {
      setEngageBusy(false)
    }
  }
  const clearLedger = () => {
    if (!ledger || ledger.length === 0) return
    if (!window.confirm(tr('ai.social.confirmClearLedger', '활동 기록을 모두 지울까요?'))) return
    void window.browserAPI.ai.engageLedgerClear().then(refreshLedger)
  }

  if (!providerReady) {
    return (
      <div className="ai-welcome">
        <div className="ai-welcome-title">🎨 {tr('ai.social.title', '만들어 올리기')}</div>
        <div className="ai-welcome-page dim">{tr('ai.social.needSetup', 'AI 설정을 먼저 완료하면 이미지 생성·게시와 블로그 참여 자동화를 쓸 수 있습니다.')}</div>
      </div>
    )
  }

  return (
    <div className="ai-body ai-write">
      <div className="ai-social-subtabs">
        <button className={`ai-social-subtab ${view === 'generate' ? 'active' : ''}`} onClick={() => setView('generate')}>🎨 {tr('ai.social.subtabGenerate', '이미지 만들어 올리기')}</button>
        <button className={`ai-social-subtab ${view === 'engage' ? 'active' : ''}`} onClick={() => setView('engage')}>🤝 {tr('ai.social.subtabEngage', '블로그 참여')}</button>
      </div>

      {view === 'generate' ? (
        <>
          {workflows.length > 0 && (
            <div className="ai-task-list">
              {workflows.map((w) => (
                <SocialCard key={w.id} w={w}
                  candidates={candidates[w.id]}
                  previewData={previewData[w.id]}
                  captionDraft={captionDrafts[w.id] ?? ''}
                  onChooseCandidate={(aid) => chooseCandidate(w.id, aid)}
                  onCaptionChange={(v) => setCaptionDrafts((prev) => ({ ...prev, [w.id]: v }))}
                  onApprove={(caption) => approveWorkflow(w.id, caption)}
                  onCancel={() => cancelWorkflow(w.id)}
                  onDelete={() => deleteWorkflow(w.id)}
                  onRetry={() => retryWorkflow(w)}
                  onRetryCaption={() => retryCaption(w.id)}
                  onSaveCaption={(caption) => saveCaption(w.id, caption)}
                  onSaveAccount={(account) => saveAccount(w.id, account)}
                  onResolvePublish={(choice) => resolvePublish(w.id, choice)}
                  promotion={promotions[w.id]}
                  promoteError={promoteErrors[w.id]}
                  promoteBusy={!!promoteBusyIds[w.id]}
                  onPromote={() => void requestPromote(w.id)}
                  onPromoteConfirm={() => void confirmPromote(w.id)}
                  onPromoteCancel={() => cancelPromote(w.id)}
                />
              ))}
            </div>
          )}

          <div className="ai-social-form">
            <label className="ai-write-label">{tr('ai.tab.genService', '생성 서비스')}</label>
            <div className="ai-chips">
              {(['genspark', 'chatgpt', 'custom'] as const).map((s) => (
                <button key={s} className={`ai-chip ${genService === s ? 'active' : ''}`} onClick={() => setGenService(s)}>{serviceLabel(tr, s)}</button>
              ))}
            </div>
            {genService === 'custom' && (
              <input className="ai-input" value={customUrl} placeholder={tr('ai.tab.genServiceUrl', '생성 서비스 URL')} onChange={(e) => setCustomUrl(e.target.value)} />
            )}

            <label className="ai-write-label">{tr('ai.social.prompt', '프롬프트')}</label>
            <textarea className="ai-input" rows={3} value={prompt} placeholder={tr('ai.social.promptPlaceholder', '예: 노을 지는 해변에서 커피 한 잔, 따뜻한 느낌')}
              onChange={(e) => setPrompt(e.target.value)} />

            <label className="ai-write-label">{tr('ai.tab.whereToPost', '게시할 곳')}</label>
            <div className="ai-chips">
              {(['instagram', 'youtube', 'tiktok'] as const).map((p) => (
                <button key={p} className={`ai-chip ${genPlatform === p ? 'active' : ''}`} onClick={() => setGenPlatform(p)}>{platformLabel(tr, p)}</button>
              ))}
            </div>

            <label className="ai-write-label">{tr('ai.social.accountIdOptional', '계정 아이디 (선택)')}</label>
            <input className="ai-input" value={genAccount} placeholder={tr('ai.social.accountIdPlaceholder', '예: my_account (@ 없이)')} onChange={(e) => setGenAccount(e.target.value)} />
            <div className="ai-hint">
              {tr('ai.social.accountIdHint1', '게시 뒤 "정말 올라갔는지" 를 화면에서 확인할 때 ')}<b>{tr('ai.social.accountIdHintBold', '이 아이디의 글인지')}</b>{tr('ai.social.accountIdHint2', ' 대조합니다.')}
              {tr('ai.social.accountIdHint3', '비워 두면 같은 문구의 남의 글·지난 글과 구분할 수 없어, 확인 결과를 직접 선택해야 합니다.')}
            </div>

            <label className="ai-write-label">{tr('ai.social.captionToneOptional', '캡션 톤 (선택)')}</label>
            <div className="ai-chips">
              {TONE_PRESETS.map((t) => (
                <button key={t} className={`ai-chip ${tone === t ? 'active' : ''}`} onClick={() => setTone(t)}>{t}</button>
              ))}
            </div>
            <input className="ai-input" value={tone} placeholder={tr('ai.social.toneCustomPlaceholder', '톤 직접 입력(선택)')} onChange={(e) => setTone(e.target.value)} />

            <label className="ai-write-label">{tr('ai.social.hashtags', '해시태그 (쉼표)')}</label>
            <input className="ai-input" value={tags} placeholder={tr('ai.social.tagsPlaceholder', '태그1, 태그2')} onChange={(e) => setTags(e.target.value)} />

            <label className="ai-write-label">{tr('ai.social.mode', '모드')}</label>
            <div className="ai-chips">
              <button className={`ai-chip ${genMode === 'draft' ? 'active' : ''}`} onClick={() => setGenMode('draft')}>{tr('ai.tab.draftOnly', '초안까지만')}</button>
              <button className={`ai-chip ${genMode === 'publish' ? 'active' : ''}`} onClick={() => setGenMode('publish')}>{tr('ai.tab.toPublish', '게시까지')}</button>
            </div>
            {genMode === 'publish' && (
              <>
                <div className="ai-handoff-note ai-err">⚠ {tr('ai.tab.publishWarning', '실제 계정에 게시됩니다. 되돌릴 수 없습니다.')}</div>
                {/*
                  한 번 맡기면 끝까지 — 다만 **사용자가 여기서 직접 켤 때만**. 켜면 이번에 시작하는
                  작업(같은 플랫폼·같은 계정·정한 건수·정한 시간 안)에 한해 캡션 확인 클릭 없이 게시까지 간다.
                  범위 밖·이미지 모호·캡션 실패는 자동으로 넘어가지 않고 그대로 확인 대기로 남는다.
                */}
                <label className="ai-write-label">{tr('ai.tab.publishNoConfirm', '캡션 확인 없이 게시(이번 작업 한정)')}</label>
                <div className="ai-chips">
                  <button className={`ai-chip ${autoPublish ? '' : 'active'}`} onClick={() => setAutoPublish(false)}>{tr('ai.tab.publishAfterConfirm', '확인 후 게시')}</button>
                  <button className={`ai-chip ${autoPublish ? 'active' : ''}`} onClick={() => setAutoPublish(true)}>{tr('ai.tab.autoPublishEntrust', '맡기고 자동 게시')}</button>
                </div>
                {autoPublish && (
                  <>
                    <div className="ai-social-auto-row">
                      <label className="ai-write-label">{tr('ai.tab.maxCount', '최대 건수')}</label>
                      <input className="ai-input ai-input-sm" type="number" min={1} max={50} value={autoMaxPosts}
                        onChange={(e) => setAutoMaxPosts(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
                      <label className="ai-write-label">{tr('ai.tab.validMinutes', '유효 시간(분)')}</label>
                      <input className="ai-input ai-input-sm" type="number" min={5} max={1440} value={autoMinutes}
                        onChange={(e) => setAutoMinutes(Math.max(5, Math.min(1440, Number(e.target.value) || 5)))} />
                    </div>
                    <div className="ai-handoff-note ai-err">
                      {tr('ai.social.autoPublishWarning2', '⚠ {platform} · 계정 "{account}" 로 최대 {max}건을 {minutes}분 안에 ', {
                        platform: platformLabel(tr, genPlatform), account: genAccount.trim() || tr('ai.tab.accountUnset', '(계정 미지정)'),
                        max: autoMaxPosts, minutes: autoMinutes,
                      })}<b>{tr('ai.tab.autoPublishWarningBold', '확인 없이 게시')}</b>{tr('ai.tab.autoPublishWarningTail', '합니다. 이미지가 모호하거나 캡션 생성이 실패하면 자동 게시하지 않고 확인을 기다립니다.')}
                    </div>
                    {grantInfo && !grantInfo.revokedAt && grantInfo.expiresAt > Date.now() && (
                      <div className="ai-hint">
                        {tr('ai.social.grantUsed', '선승인 사용 {used}/{max}건', { used: grantInfo.used, max: grantInfo.maxPosts })}
                        <button className="ai-mini-btn" onClick={() => { void window.browserAPI.ai.socialGrantRevoke().then(refreshGrant) }}>{tr('ai.social.revokeGrant', '선승인 취소')}</button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            <button className="ai-send ai-social-cta" onClick={() => void startGenerate()} disabled={!prompt.trim() || genBusy || !activeId}>
              {genBusy ? tr('ai.social.requesting', '요청 중…') : '✨ ' + tr('ai.social.start', '시작')}
            </button>
            {!activeId && <div className="ai-hint">{tr('ai.tab.needActiveTab', '활성 탭이 필요합니다.')}</div>}
            {genError && <div className="ai-handoff-note ai-err">{genError}</div>}
          </div>
        </>
      ) : (
        <div className="ai-social-form">
          {engageStep === 'form' ? (
            <>
              <label className="ai-write-label">{tr('ai.social.myBlogUrlOptional', '내 블로그 주소 (선택)')}</label>
              <input className="ai-input" value={myBlogUrl} placeholder="https://blog.naver.com/내블로그" onChange={(e) => setMyBlogUrl(e.target.value)} />
              <label className="ai-write-label">{tr('ai.social.topicOptional', '주제 (선택 — 위와 하나는 필요)')}</label>
              <input className="ai-input" value={topic} placeholder={tr('ai.tab.topicPlaceholder', '예: 홈트레이닝, 캠핑 장비')} onChange={(e) => setTopic(e.target.value)} />
              <label className="ai-write-label">{tr('ai.social.searchUrlOptional', '검색 시작 주소 (선택)')}</label>
              <input className="ai-input" value={searchUrl} placeholder={tr('ai.social.searchUrlPlaceholder', '비우면 기본 네이버 블로그 검색')} onChange={(e) => setSearchUrl(e.target.value)} />
              <label className="ai-write-label">{tr('ai.social.accountDisplayNameOptional', '계정 표시 이름 (선택)')}</label>
              <input className="ai-input" value={engageAccount} placeholder={tr('ai.tab.commentNamePlaceholderOpt', '댓글에 쓸 이름(선택)')} onChange={(e) => setEngageAccount(e.target.value)} />

              <label className="ai-write-label">{tr('ai.social.postsToHandle', '다룰 글 수')}</label>
              <input className="ai-input" type="number" min={1} max={20} value={maxPosts}
                onChange={(e) => setMaxPosts(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />

              <label className="ai-write-label">{tr('ai.tab.whatToDo', '무엇을 할지')}</label>
              <label className="ai-write-autoopen"><input type="checkbox" checked={doComment} onChange={(e) => setDoComment(e.target.checked)} /><span>{tr('ai.tab.comment', '댓글')}</span></label>
              <label className="ai-write-autoopen"><input type="checkbox" checked={doLike} onChange={(e) => setDoLike(e.target.checked)} /><span>{tr('ai.tab.like', '좋아요')}</span></label>

              <label className="ai-write-label">{tr('ai.tab.excludeHostsComma', '제외할 사이트 (쉼표)')}</label>
              <input className="ai-input" value={excludeHosts} placeholder="example.com, ads.co.kr" onChange={(e) => setExcludeHosts(e.target.value)} />

              <label className="ai-write-label">{tr('ai.tab.intervalSeconds', '글 사이 간격(초)')}</label>
              <input className="ai-input" type="number" min={0} max={600} value={intervalSeconds}
                onChange={(e) => setIntervalSeconds(Math.max(0, Math.min(600, Number(e.target.value) || 0)))} />
              <div className="ai-hint">{tr('ai.social.intervalHint1', '간격이 덜 지난 클릭은 ')}<b>{tr('ai.social.intervalHintBold', '코드가 거부')}</b>{tr('ai.social.intervalHint2', '합니다(작업별 카운터를 디스크에 두고 검사 — 중단 후 재개해도 유지).')}</div>

              <label className="ai-write-label">{tr('ai.social.deadlineMinutes', '기한(분) — 0이면 기한 없음')}</label>
              <input className="ai-input" type="number" min={0} max={1440} value={engageWindowMin}
                onChange={(e) => setEngageWindowMin(Math.max(0, Math.min(1440, Number(e.target.value) || 0)))} />
              <div className="ai-hint">{tr('ai.social.deadlineHint', '이 시간이 지나면 남은 글이 있어도 댓글·좋아요를 더 하지 않습니다.')}</div>

              <label className="ai-write-label">{tr('ai.social.mode', '모드')}</label>
              <div className="ai-chips">
                <button className={`ai-chip ${engageMode === 'draft' ? 'active' : ''}`} onClick={() => setEngageMode('draft')}>{tr('ai.tab.draftOnly2', '초안만')}</button>
                <button className={`ai-chip ${engageMode === 'act' ? 'active' : ''}`} onClick={() => setEngageMode('act')}>{tr('ai.social.actForRealAttach', '실제로 달기')}</button>
              </div>
              {engageMode === 'act' && <div className="ai-handoff-note ai-err">⚠ {tr('ai.tab.engageWarning', '실제로 댓글/좋아요가 등록됩니다. 되돌릴 수 없습니다.')}</div>}
              {isInternal && <div className="ai-hint">{tr('ai.social.internalPageHint', '현재 새 탭 등 내부 페이지입니다 — 시작하면 검색 시작 주소로 이동합니다.')}</div>}

              <button className="ai-send ai-social-cta" onClick={() => void buildEngageTask()} disabled={engageBusy}>
                {engageBusy ? tr('ai.social.checking', '확인 중…') : tr('ai.social.nextConfirmTarget', '다음: 대상 확인 →')}
              </button>
              {engageError && <div className="ai-handoff-note ai-err">{engageError}</div>}
              {engageNotice && <div className="ai-handoff-note">{engageNotice}</div>}
            </>
          ) : engageBuild ? (
            <>
              <label className="ai-write-label">{tr('ai.social.allowedHostsRemove', '허용될 사이트 — 필요 없는 곳은 지우세요')}</label>
              <div className="ai-social-hosts">
                {engageBuild.hosts.length === 0 && <span className="ai-social-empty">{tr('ai.social.needAtLeastOneHost', '최소 한 곳은 필요합니다.')}</span>}
                {engageBuild.hosts.map((h) => (
                  <button key={h} className="ai-chip removable" onClick={() => removeHost(h)} title={tr('ai.tab.remove', '제거')}>{h} ×</button>
                ))}
              </div>
              <div className="ai-hint">{tr('ai.social.noHostsOutside', '여기 없는 사이트로는 나가지 않습니다.')}</div>
              <div className="ai-write-actions">
                <button className="ai-mini-btn" onClick={() => setEngageStep('form')} disabled={engageBusy}>← {tr('ai.social.edit2', '수정')}</button>
                <button className="ai-send ai-social-cta" onClick={() => void startEngage()} disabled={engageBusy || engageBuild.hosts.length === 0 || !activeId}>
                  {engageBusy ? tr('ai.social.starting', '시작하는 중…') : '▶ ' + tr('ai.social.start', '시작')}
                </button>
              </div>
              {!activeId && <div className="ai-hint">{tr('ai.tab.needActiveTab', '활성 탭이 필요합니다.')}</div>}
              {engageError && <div className="ai-handoff-note ai-err">{engageError}</div>}
            </>
          ) : null}

          <div className="ai-history-head" style={{ marginTop: 4 }}>
            <span>{tr('ai.social.activityLog', '활동 기록')}</span>
            <div className="ai-history-head-actions">
              <button className="ai-mini-btn" onClick={refreshLedger} title={tr('ai.social.refresh', '새로고침')}>↻</button>
              <button className="ai-mini-btn" onClick={clearLedger} disabled={!ledger || ledger.length === 0}>{tr('ai.social.clearLog', '기록 비우기')}</button>
            </div>
          </div>
          <div className="ai-social-ledger">
            {ledger === null ? (
              <div className="ai-welcome-page dim" style={{ padding: 8, textAlign: 'center' }}>{tr('ai.tab.loading', '불러오는 중…')}</div>
            ) : ledger.length === 0 ? (
              <div className="ai-welcome-page dim" style={{ padding: 8, textAlign: 'center' }}>{tr('ai.social.noActivityYet', '아직 활동 기록이 없습니다.')}</div>
            ) : (
              ledger.map((e) => (
                <div key={`${e.key}-${e.at}`} className="ai-social-ledger-row">
                  <span className="ai-social-ledger-when">{fmtWhen(tr, e.at)}</span>
                  <span className="ai-social-ledger-action">{e.action === 'comment' ? '💬 ' + tr('ai.tab.comment', '댓글') : '❤️ ' + tr('ai.tab.like', '좋아요')}</span>
                  <span className="ai-social-ledger-addr" title={e.note ?? e.key}>{e.note ?? e.key}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
