import { useEffect, useRef, useState } from 'react'

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
  receipt?: { url?: string; evidence?: string; at: number }
  error?: string
  createdAt: number
  updatedAt: number
}
interface ArtifactMeta { id: string; name: string; format: string; bytes: number; width?: number; height?: number }
interface EngageLedgerEntry { key: string; account: string; action: 'comment' | 'like'; at: number; note?: string }

const PLATFORM_LABEL: Record<SocialPlatform, string> = { instagram: '인스타그램', youtube: '유튜브', tiktok: '틱톡' }
const SERVICE_LABEL: Record<SocialService, string> = { genspark: 'Genspark', chatgpt: 'ChatGPT', custom: '직접 입력' }
const TONE_PRESETS = ['친근하게', '전문적으로', '짧고 간결하게']
const STAGE_ORDER: SocialStage[] = ['generate', 'review', 'publish', 'done']

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
function fmtWhen(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '방금'
  if (m < 60) return `${m}분 전`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}시간 전`
  try { return new Date(ts).toLocaleDateString() } catch { return '' }
}
// 완료 근거 문구에 "미확인" 계열이 섞여 있으면 성공(✅)으로 칠하지 않는다 — task-runtime 의
// exhausted/publishPending 과 같은 원칙(끝났다 ≠ 성공했다).
function evidenceUnresolved(evidence?: string): boolean {
  return !!evidence && /미확인|확인되지\s*않|확인하지\s*못/.test(evidence)
}

// ===== 카드(뷰1의 진행 중 워크플로 1개) =====
function SocialCard({
  w, candidates, previewData, captionDraft,
  onChooseCandidate, onCaptionChange, onApprove, onCancel, onDelete, onRetry,
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
}) {
  const terminal = w.stage === 'done' || w.stage === 'failed' || w.stage === 'cancelled'
  const unresolved = evidenceUnresolved(w.receipt?.evidence)
  return (
    <div className={`ai-social-card ${w.stage === 'done' ? (unresolved ? 'warn' : 'ok') : w.stage === 'failed' ? 'warn' : ''}`}>
      <div className="ai-task-head">
        <span className="ai-task-badge">{PLATFORM_LABEL[w.params.platform]}</span>
        <span className="ai-task-instruction" title={w.params.prompt}>{w.params.prompt}</span>
      </div>
      <div className="ai-task-meta">
        <span>{SERVICE_LABEL[w.params.service]}</span>
        <span>· {w.params.mode === 'publish' ? '게시까지' : '초안까지만'}</span>
      </div>

      {w.stage === 'failed' || w.stage === 'cancelled' ? (
        <span className={`ai-task-badge ${w.stage === 'failed' ? 'warn' : 'muted'}`}>{w.stage === 'failed' ? '실패' : '취소됨'}</span>
      ) : (
        <div className="ai-social-steps">
          <span className={`ai-social-step ${stepClass(w.stage, 'generate')}`}>생성</span>
          <span className={`ai-social-step ${stepClass(w.stage, 'review')}`}>확인</span>
          <span className={`ai-social-step ${stepClass(w.stage, 'publish')}`}>게시</span>
        </div>
      )}

      {w.stage === 'generate' && (
        !w.artifactId && candidates && candidates.length > 0 ? (
          <>
            <div className="ai-hint">여러 후보 중 하나를 고르세요.</div>
            <div className="ai-social-thumbs">
              {candidates.map((c) => (
                <button key={c.meta.id} className="ai-social-thumb" onClick={() => onChooseCandidate(c.meta.id)} title={c.meta.name}>
                  {c.dataUrl ? <img src={c.dataUrl} alt={c.meta.name} /> : null}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="ai-hint">이미지를 만드는 중… (수십 초~수 분 걸릴 수 있어요)</div>
        )
      )}

      {w.stage === 'review' && (
        <>
          <div className="ai-social-preview">
            {previewData === undefined
              ? <span className="ai-hint">미리보기 불러오는 중…</span>
              : previewData
                ? <img src={previewData} alt="생성된 이미지" />
                : <span className="ai-hint">미리보기를 불러오지 못했습니다.</span>}
          </div>
          {w.artifactPreview && (
            <div className="ai-social-preview-meta">
              {w.artifactPreview.width ?? '?'}×{w.artifactPreview.height ?? '?'} · {formatBytes(w.artifactPreview.bytes)} · {w.artifactPreview.format}
            </div>
          )}
          <textarea className="ai-input" rows={3} value={captionDraft} placeholder="캡션"
            onChange={(e) => onCaptionChange(e.target.value)} />
          <div className="ai-hint">이 단계에서 멈춥니다 — 아래 버튼을 눌러야 다음으로 넘어갑니다.</div>
          <button className="ai-send ai-social-cta" onClick={() => onApprove(captionDraft)}>
            {w.params.mode === 'publish' ? '📤 이대로 게시' : '▶ 이대로 진행'}
          </button>
        </>
      )}

      {w.stage === 'publish' && <div className="ai-hint">게시하는 중…</div>}

      {w.stage === 'done' && (
        <div className="ai-social-receipt">
          {w.receipt?.url && <div><a href={w.receipt.url} target="_blank" rel="noreferrer">{w.receipt.url}</a></div>}
          {w.receipt?.evidence && <div>{unresolved ? '⚠ 확인 필요 — ' : '✅ '}{w.receipt.evidence}</div>}
          {w.receipt?.at ? <div className="ai-hint">{fmtWhen(w.receipt.at)}</div> : null}
        </div>
      )}

      {w.stage === 'failed' && <div className="ai-task-note warn">{w.error || '실패했습니다.'}</div>}
      {w.stage === 'cancelled' && <div className="ai-task-note warn">취소되었습니다.</div>}

      <div className="ai-task-actions">
        {(w.stage === 'generate' || w.stage === 'review' || w.stage === 'publish') && (
          <button className="ai-mini-btn" onClick={onCancel} title="취소">⏹ 취소</button>
        )}
        {w.stage === 'failed' && <button className="ai-mini-btn" onClick={onRetry} title="같은 설정으로 다시 시도">↻ 다시 시도</button>}
        {terminal && <button className="ai-history-del" onClick={onDelete} title="목록에서 삭제">×</button>}
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
  const [genBusy, setGenBusy] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  const [workflows, setWorkflows] = useState<SocialWorkflow[]>([])
  const [candidates, setCandidates] = useState<Record<string, Array<{ meta: ArtifactMeta; dataUrl: string | null }>>>({})
  const [previewData, setPreviewData] = useState<Record<string, string | null>>({})
  const [captionDrafts, setCaptionDrafts] = useState<Record<string, string>>({})
  const captionSeededRef = useRef<Set<string>>(new Set())

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

  const startGenerate = async () => {
    if (!activeId || genBusy || !prompt.trim()) return
    if (genService === 'custom' && !customUrl.trim()) { setGenError('직접 입력할 생성 서비스 URL을 입력하세요.'); return }
    setGenBusy(true); setGenError(null)
    try {
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
      if (!w) { setGenError('작업을 시작하지 못했습니다.'); return }
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
    if (!myBlogUrl.trim() && !topic.trim()) { setEngageError('블로그 주소 또는 주제 중 하나는 입력하세요.'); return }
    if (!doComment && !doLike) { setEngageError('댓글·좋아요 중 하나는 선택하세요.'); return }
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
      if (!summary) { setEngageError('작업을 만들지 못했습니다.'); return }
      const startRes = await window.browserAPI.ai.ptaskStart(summary.id)
      if (!startRes?.ok) { setEngageError(startRes?.error || '작업을 시작하지 못했습니다.'); return }
      setEngageNotice('작업을 시작했습니다 — 🤖 에이전트 탭의 📌 작업에서 진행 상황을 볼 수 있습니다.')
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
    if (!window.confirm('활동 기록을 모두 지울까요?')) return
    void window.browserAPI.ai.engageLedgerClear().then(refreshLedger)
  }

  if (!providerReady) {
    return (
      <div className="ai-welcome">
        <div className="ai-welcome-title">🎨 만들어 올리기</div>
        <div className="ai-welcome-page dim">AI 설정을 먼저 완료하면 이미지 생성·게시와 블로그 참여 자동화를 쓸 수 있습니다.</div>
      </div>
    )
  }

  return (
    <div className="ai-body ai-write">
      <div className="ai-social-subtabs">
        <button className={`ai-social-subtab ${view === 'generate' ? 'active' : ''}`} onClick={() => setView('generate')}>🎨 이미지 만들어 올리기</button>
        <button className={`ai-social-subtab ${view === 'engage' ? 'active' : ''}`} onClick={() => setView('engage')}>🤝 블로그 참여</button>
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
                />
              ))}
            </div>
          )}

          <div className="ai-social-form">
            <label className="ai-write-label">생성 서비스</label>
            <div className="ai-chips">
              {(['genspark', 'chatgpt', 'custom'] as const).map((s) => (
                <button key={s} className={`ai-chip ${genService === s ? 'active' : ''}`} onClick={() => setGenService(s)}>{SERVICE_LABEL[s]}</button>
              ))}
            </div>
            {genService === 'custom' && (
              <input className="ai-input" value={customUrl} placeholder="생성 서비스 URL" onChange={(e) => setCustomUrl(e.target.value)} />
            )}

            <label className="ai-write-label">프롬프트</label>
            <textarea className="ai-input" rows={3} value={prompt} placeholder="예: 노을 지는 해변에서 커피 한 잔, 따뜻한 느낌"
              onChange={(e) => setPrompt(e.target.value)} />

            <label className="ai-write-label">게시할 곳</label>
            <div className="ai-chips">
              {(['instagram', 'youtube', 'tiktok'] as const).map((p) => (
                <button key={p} className={`ai-chip ${genPlatform === p ? 'active' : ''}`} onClick={() => setGenPlatform(p)}>{PLATFORM_LABEL[p]}</button>
              ))}
            </div>

            <label className="ai-write-label">계정 표시 이름 (선택)</label>
            <input className="ai-input" value={genAccount} placeholder="예: 내 인스타 계정" onChange={(e) => setGenAccount(e.target.value)} />

            <label className="ai-write-label">캡션 톤 (선택)</label>
            <div className="ai-chips">
              {TONE_PRESETS.map((t) => (
                <button key={t} className={`ai-chip ${tone === t ? 'active' : ''}`} onClick={() => setTone(t)}>{t}</button>
              ))}
            </div>
            <input className="ai-input" value={tone} placeholder="톤 직접 입력(선택)" onChange={(e) => setTone(e.target.value)} />

            <label className="ai-write-label">해시태그 (쉼표)</label>
            <input className="ai-input" value={tags} placeholder="태그1, 태그2" onChange={(e) => setTags(e.target.value)} />

            <label className="ai-write-label">모드</label>
            <div className="ai-chips">
              <button className={`ai-chip ${genMode === 'draft' ? 'active' : ''}`} onClick={() => setGenMode('draft')}>초안까지만</button>
              <button className={`ai-chip ${genMode === 'publish' ? 'active' : ''}`} onClick={() => setGenMode('publish')}>게시까지</button>
            </div>
            {genMode === 'publish' && <div className="ai-handoff-note ai-err">⚠ 실제 계정에 게시됩니다. 되돌릴 수 없습니다.</div>}

            <button className="ai-send ai-social-cta" onClick={() => void startGenerate()} disabled={!prompt.trim() || genBusy || !activeId}>
              {genBusy ? '요청 중…' : '✨ 시작'}
            </button>
            {!activeId && <div className="ai-hint">활성 탭이 필요합니다.</div>}
            {genError && <div className="ai-handoff-note ai-err">{genError}</div>}
          </div>
        </>
      ) : (
        <div className="ai-social-form">
          {engageStep === 'form' ? (
            <>
              <label className="ai-write-label">내 블로그 주소 (선택)</label>
              <input className="ai-input" value={myBlogUrl} placeholder="https://blog.naver.com/내블로그" onChange={(e) => setMyBlogUrl(e.target.value)} />
              <label className="ai-write-label">주제 (선택 — 위와 하나는 필요)</label>
              <input className="ai-input" value={topic} placeholder="예: 홈트레이닝, 캠핑 장비" onChange={(e) => setTopic(e.target.value)} />
              <label className="ai-write-label">검색 시작 주소 (선택)</label>
              <input className="ai-input" value={searchUrl} placeholder="비우면 기본 네이버 블로그 검색" onChange={(e) => setSearchUrl(e.target.value)} />
              <label className="ai-write-label">계정 표시 이름 (선택)</label>
              <input className="ai-input" value={engageAccount} placeholder="댓글에 쓸 이름(선택)" onChange={(e) => setEngageAccount(e.target.value)} />

              <label className="ai-write-label">다룰 글 수</label>
              <input className="ai-input" type="number" min={1} max={20} value={maxPosts}
                onChange={(e) => setMaxPosts(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />

              <label className="ai-write-label">무엇을 할지</label>
              <label className="ai-write-autoopen"><input type="checkbox" checked={doComment} onChange={(e) => setDoComment(e.target.checked)} /><span>댓글</span></label>
              <label className="ai-write-autoopen"><input type="checkbox" checked={doLike} onChange={(e) => setDoLike(e.target.checked)} /><span>좋아요</span></label>

              <label className="ai-write-label">제외할 사이트 (쉼표)</label>
              <input className="ai-input" value={excludeHosts} placeholder="example.com, ads.co.kr" onChange={(e) => setExcludeHosts(e.target.value)} />

              <label className="ai-write-label">글 사이 간격(초)</label>
              <input className="ai-input" type="number" min={0} max={600} value={intervalSeconds}
                onChange={(e) => setIntervalSeconds(Math.max(0, Math.min(600, Number(e.target.value) || 0)))} />
              <div className="ai-hint">이 값은 AI에게 전달되는 지시일 뿐 코드로 강제되지는 않습니다. 너무 빠르게 연속으로 달면 사이트가 차단할 수 있습니다.</div>

              <label className="ai-write-label">모드</label>
              <div className="ai-chips">
                <button className={`ai-chip ${engageMode === 'draft' ? 'active' : ''}`} onClick={() => setEngageMode('draft')}>초안만</button>
                <button className={`ai-chip ${engageMode === 'act' ? 'active' : ''}`} onClick={() => setEngageMode('act')}>실제로 달기</button>
              </div>
              {engageMode === 'act' && <div className="ai-handoff-note ai-err">⚠ 실제로 댓글/좋아요가 등록됩니다. 되돌릴 수 없습니다.</div>}
              {isInternal && <div className="ai-hint">현재 새 탭 등 내부 페이지입니다 — 시작하면 검색 시작 주소로 이동합니다.</div>}

              <button className="ai-send ai-social-cta" onClick={() => void buildEngageTask()} disabled={engageBusy}>
                {engageBusy ? '확인 중…' : '다음: 대상 확인 →'}
              </button>
              {engageError && <div className="ai-handoff-note ai-err">{engageError}</div>}
              {engageNotice && <div className="ai-handoff-note">{engageNotice}</div>}
            </>
          ) : engageBuild ? (
            <>
              <label className="ai-write-label">허용될 사이트 — 필요 없는 곳은 지우세요</label>
              <div className="ai-social-hosts">
                {engageBuild.hosts.length === 0 && <span className="ai-social-empty">최소 한 곳은 필요합니다.</span>}
                {engageBuild.hosts.map((h) => (
                  <button key={h} className="ai-chip removable" onClick={() => removeHost(h)} title="제거">{h} ×</button>
                ))}
              </div>
              <div className="ai-hint">여기 없는 사이트로는 나가지 않습니다.</div>
              <div className="ai-write-actions">
                <button className="ai-mini-btn" onClick={() => setEngageStep('form')} disabled={engageBusy}>← 수정</button>
                <button className="ai-send ai-social-cta" onClick={() => void startEngage()} disabled={engageBusy || engageBuild.hosts.length === 0 || !activeId}>
                  {engageBusy ? '시작하는 중…' : '▶ 시작'}
                </button>
              </div>
              {!activeId && <div className="ai-hint">활성 탭이 필요합니다.</div>}
              {engageError && <div className="ai-handoff-note ai-err">{engageError}</div>}
            </>
          ) : null}

          <div className="ai-history-head" style={{ marginTop: 4 }}>
            <span>활동 기록</span>
            <div className="ai-history-head-actions">
              <button className="ai-mini-btn" onClick={refreshLedger} title="새로고침">↻</button>
              <button className="ai-mini-btn" onClick={clearLedger} disabled={!ledger || ledger.length === 0}>기록 비우기</button>
            </div>
          </div>
          <div className="ai-social-ledger">
            {ledger === null ? (
              <div className="ai-welcome-page dim" style={{ padding: 8, textAlign: 'center' }}>불러오는 중…</div>
            ) : ledger.length === 0 ? (
              <div className="ai-welcome-page dim" style={{ padding: 8, textAlign: 'center' }}>아직 활동 기록이 없습니다.</div>
            ) : (
              ledger.map((e) => (
                <div key={`${e.key}-${e.at}`} className="ai-social-ledger-row">
                  <span className="ai-social-ledger-when">{fmtWhen(e.at)}</span>
                  <span className="ai-social-ledger-action">{e.action === 'comment' ? '💬 댓글' : '❤️ 좋아요'}</span>
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
