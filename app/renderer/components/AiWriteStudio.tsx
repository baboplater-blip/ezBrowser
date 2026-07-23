import { useEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from './Markdown'

// 블로그 글쓰기 스튜디오 — 주제·옵션 → AI 초안(제목 후보·본문·태그·SEO 요약) → 편집 →
// 에디터에 넣기(에이전트) 또는 복사/내보내기. 초안 저장·불러오기 + 시리즈 연재 지원.
// 실제 발행은 하지 않는다(사용자가 에디터에서 확인 후 발행).

interface BlogDraft { titles: string[]; tags: string[]; summary: string; bodyMarkdown: string }
interface DraftSummary { id: string; title: string; topic: string; seriesId?: string; seriesTitle?: string; part?: number; updatedAt: number }
interface SeriesPlan { seriesTitle: string; parts: Array<{ title: string; angle: string }> }

const TONES = ['정보전달', '친근', '전문', '후기', '시니어']
const LENGTHS: Array<{ v: 'short' | 'medium' | 'long'; label: string }> = [
  { v: 'short', label: '짧게' }, { v: 'medium', label: '보통' }, { v: 'long', label: '길게' },
]
const PLATFORMS: Array<{ v: string; label: string }> = [
  { v: 'naver', label: '네이버 블로그' }, { v: 'tistory', label: '티스토리' },
  { v: 'wordpress', label: '워드프레스' }, { v: 'generic', label: '일반' },
]

function newId(): string { try { return crypto.randomUUID() } catch { return `${Date.now()}-${Math.round(Math.random() * 1e9)}` } }
function downloadText(name: string, text: string): void {
  try {
    const a = document.createElement('a')
    a.href = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(text)
    a.download = name; document.body.appendChild(a); a.click(); a.remove()
  } catch { /* ignore */ }
}
async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text) } catch {
    try { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove() } catch { /* ignore */ }
  }
}

export function AiWriteStudio({
  windowId, isInternal, providerReady, onInsertToEditor, preset,
}: {
  windowId: string
  isInternal: boolean
  providerReady: boolean
  onInsertToEditor: (task: string) => void
  preset?: { nonce: number; title: string; body: string } | null
}) {
  const [topic, setTopic] = useState('')
  const [tone, setTone] = useState('정보전달')
  const [length, setLength] = useState<'short' | 'medium' | 'long'>('medium')
  const [platform, setPlatform] = useState('naver')
  const [keywords, setKeywords] = useState('')
  const [extra, setExtra] = useState('')
  const [showOpts, setShowOpts] = useState(false)

  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<BlogDraft | null>(null)
  // 편집 상태
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState('')
  const [preview, setPreview] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [autoOpen, setAutoOpen] = useState(true)   // 글쓰기 페이지가 아니면 에이전트가 먼저 이동
  // 글 다듬기(부분 개선)
  const [refineInput, setRefineInput] = useState('')
  const [refining, setRefining] = useState(false)
  const [prevBody, setPrevBody] = useState<string | null>(null)
  // 저장/불러오기
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [showDrafts, setShowDrafts] = useState(false)
  const [curDraftId, setCurDraftId] = useState<string | null>(null)
  // 시리즈 연재
  const [showSeries, setShowSeries] = useState(false)
  const [seriesParts, setSeriesParts] = useState(3)
  const [seriesPlan, setSeriesPlan] = useState<SeriesPlan | null>(null)
  const [seriesGen, setSeriesGen] = useState(false)
  const [seriesId, setSeriesId] = useState<string | null>(null)
  const [seriesTitle, setSeriesTitle] = useState('')
  const [curPart, setCurPart] = useState<number | undefined>(undefined)

  useEffect(() => {
    void window.browserAPI.ai.blogDraftList().then(setDrafts)
    const off = window.browserAPI.ai.onBlogDraftChanged((list) => setDrafts(list))
    return off
  }, [])

  const applyDraftResult = (d: BlogDraft) => {
    setDraft(d); setTitle(d.titles[0] ?? ''); setBody(d.bodyMarkdown); setTags(d.tags.join(', ')); setPreview(false)
  }

  // 외부(에이전트 보고서 등)에서 제목·본문을 스튜디오로 주입 — nonce 로 1회만 적용(챗의 nonce 패턴과 동일).
  const lastPresetNonce = useRef(0)
  useEffect(() => {
    if (!preset || preset.nonce === lastPresetNonce.current) return
    lastPresetNonce.current = preset.nonce
    setCurDraftId(null); setSeriesId(null); setSeriesTitle(''); setCurPart(undefined)
    setTopic(preset.title); setTitle(preset.title); setBody(preset.body); setTags('')
    setDraft({ titles: [preset.title], tags: [], summary: '', bodyMarkdown: preset.body }) // 편집 UI 개방
    setPreview(true) // 보고서는 읽기 우선 — 미리보기로 시작
    setNotice(null); setError(null)
  }, [preset])

  const generate = (over?: Partial<{ topic: string; series: { seriesTitle: string; part: number; totalParts: number; partTitle?: string; otherTitles?: string[] } }>) => {
    const t = (over?.topic ?? topic).trim()
    if (!t || generating || !providerReady) return
    setGenerating(true); setError(null); setNotice(null)
    // 새 글 생성 → 새 초안으로 취급(기존 편집본 덮어쓰기 방지). 시리즈 편이면 part/series 유지.
    if (!over?.series) { setCurDraftId(null); setSeriesId(null); setSeriesTitle(''); setCurPart(undefined) }
    void window.browserAPI.ai.blogGenerate({ topic: t, tone, length, platform, keywords: keywords.trim() || undefined, extra: extra.trim() || undefined, ...(over?.series ? { series: over.series } : {}) })
      .then((res) => { if (res.ok && res.draft) applyDraftResult(res.draft); else setError(res.error || '초안 생성에 실패했습니다.') })
      .catch((e) => setError(String(e)))
      .finally(() => setGenerating(false))
  }

  const fullMarkdown = (): string => {
    const parts: string[] = []
    if (title.trim()) parts.push(`# ${title.trim()}`)
    if (body.trim()) parts.push(body.trim())
    const tg = tags.split(',').map((s) => s.trim()).filter(Boolean)
    if (tg.length) parts.push(tg.map((x) => `#${x}`).join(' '))
    return parts.join('\n\n')
  }

  const saveDraft = () => {
    if (!body.trim() && !title.trim()) { setNotice('저장할 내용이 없습니다.'); return }
    const tg = tags.split(',').map((s) => s.trim()).filter(Boolean)
    void window.browserAPI.ai.blogDraftSave({
      id: curDraftId ?? undefined, topic, title: title.trim() || topic || '제목 없음', bodyMarkdown: body, tags: tg,
      summary: draft?.summary ?? '', options: { tone, length, platform, keywords },
      seriesId: seriesId ?? undefined, seriesTitle: seriesTitle || undefined, part: curPart,
    }).then((r) => { if (r) { setCurDraftId(r.id); setNotice('💾 저장했습니다.') } })
  }
  const loadDraft = (id: string) => {
    void window.browserAPI.ai.blogDraftGet(id).then((d) => {
      if (!d) return
      setTopic(d.topic || ''); setTitle(d.title || ''); setBody(d.bodyMarkdown || ''); setTags((d.tags || []).join(', '))
      if (d.options) { if (d.options.tone) setTone(d.options.tone); if (d.options.length) setLength(d.options.length as 'short' | 'medium' | 'long'); if (d.options.platform) setPlatform(d.options.platform); if (d.options.keywords != null) setKeywords(d.options.keywords) }
      setDraft({ titles: [d.title || ''], tags: d.tags || [], summary: d.summary || '', bodyMarkdown: d.bodyMarkdown || '' })
      setCurDraftId(d.id); setSeriesId(d.seriesId ?? null); setSeriesTitle(d.seriesTitle || ''); setCurPart(d.part)
      setShowDrafts(false); setPreview(false); setNotice('불러왔습니다.')
    })
  }
  const removeDraft = (id: string, e: React.MouseEvent) => { e.stopPropagation(); void window.browserAPI.ai.blogDraftRemove(id) }

  // 시리즈 기획
  const planSeries = () => {
    const t = topic.trim()
    if (!t || seriesGen || !providerReady) return
    setSeriesGen(true); setError(null)
    void window.browserAPI.ai.blogSeriesPlan({ topic: t, parts: seriesParts, tone, platform, keywords: keywords.trim() || undefined })
      .then((res) => {
        if (res.ok && res.plan) { setSeriesPlan(res.plan); setSeriesId(newId()); setSeriesTitle(res.plan.seriesTitle) }
        else setError(res.error || '시리즈 기획에 실패했습니다.')
      })
      .catch((e) => setError(String(e)))
      .finally(() => setSeriesGen(false))
  }
  const writePart = (idx: number) => {
    if (!seriesPlan) return
    const p = seriesPlan.parts[idx]
    if (!p) return
    const others = seriesPlan.parts.filter((_, i) => i !== idx).map((x) => x.title)
    setCurPart(idx + 1); setCurDraftId(null)
    setShowSeries(false)
    generate({ topic: p.title, series: { seriesTitle: seriesPlan.seriesTitle, part: idx + 1, totalParts: seriesPlan.parts.length, partTitle: p.angle, otherTitles: others } })
  }
  // 시리즈 편 중 이미 저장된 것 표시
  const savedParts = useMemo(() => {
    const m = new Set<number>()
    if (seriesId) for (const d of drafts) if (d.seriesId === seriesId && d.part) m.add(d.part)
    return m
  }, [drafts, seriesId])

  // 글 다듬기 — 지시대로 현재 본문을 고쳐 교체(되돌리기 위해 이전 본문 보관).
  const REFINE_PRESETS: Array<{ label: string; instr: string }> = [
    { label: '더 짧게', instr: '전체를 30% 정도 더 짧고 간결하게 줄여줘. 핵심은 남기고.' },
    { label: '더 자세히', instr: '설명이 부족한 부분을 더 자세하고 구체적으로 보강해줘.' },
    { label: '표 추가', instr: '비교·요약할 내용이 있으면 마크다운 표를 하나 추가해줘.' },
    { label: '도입부 강화', instr: '도입부를 독자의 흥미를 끌도록 더 매력적으로 다시 써줘.' },
    { label: '더 쉽게', instr: '어려운 용어를 풀어 쓰고, 초보자도 이해하도록 쉽게 바꿔줘.' },
    { label: 'FAQ 추가', instr: '글 끝에 자주 묻는 질문(FAQ) 2~3개를 추가해줘.' },
  ]
  const runRefine = (instruction: string) => {
    const instr = instruction.trim()
    if (!instr || refining || !body.trim()) return
    setRefining(true); setNotice(null); setError(null)
    const before = body
    void window.browserAPI.ai.blogRefine({ body, instruction: instr, title: title.trim() || undefined, tone, platform })
      .then((res) => {
        if (res.ok && res.body) { setPrevBody(before); setBody(res.body); setPreview(false); setRefineInput(''); setNotice('✨ 다듬었습니다.') }
        else setError(res.error || '다듬기에 실패했습니다.')
      })
      .catch((e) => setError(String(e)))
      .finally(() => setRefining(false))
  }
  const undoRefine = () => { if (prevBody != null) { setBody(prevBody); setPrevBody(null); setNotice('되돌렸습니다.') } }

  // 공통 — 에디터 인지 태스크(네이버 SmartEditor ONE 특화)를 메인에서 만들어 에이전트로 넘긴다.
  // autoOpen 이면 글쓰기 페이지가 아닐 때(새 탭 등 내부 페이지 포함) 먼저 네이버 글쓰기 페이지로 이동한다.
  const [handoffBusy, setHandoffBusy] = useState(false)
  const tagArr = (): string[] => tags.split(',').map((s) => s.trim()).filter(Boolean)
  const handoff = async (mode: 'insert' | 'draft' | 'publish') => {
    if (!body.trim() || handoffBusy) return
    // 자동 열기가 꺼져 있고 지금 내부 페이지(새 탭 등)면 글쓰기 페이지가 없으니 안내.
    if (!autoOpen && isInternal) { setNotice('블로그 글쓰기 페이지를 먼저 열거나, "글쓰기 페이지 자동 열기"를 켜세요.'); return }
    setHandoffBusy(true); setNotice(null)
    try {
      const res = await window.browserAPI.ai.blogBuildTask({ platform, mode, title: title.trim(), body, tags: tagArr(), autoOpen })
      // 내부 페이지(에이전트 시작 불가)에서 시작하는 경우엔, 먼저 활성 탭을 네이버 글쓰기로 이동시켜
      // 에이전트가 http 페이지에서 출발하게 한다(그 뒤 태스크가 로그인/에디터를 처리).
      if (autoOpen && isInternal && platform === 'naver' && res.naverWriteUrl) {
        await window.browserAPI.omnibox.navigate(windowId, undefined, res.naverWriteUrl)
        await new Promise((r) => setTimeout(r, 1400))
      }
      onInsertToEditor(res.task)
      setNotice(mode === 'publish' ? '에이전트가 작성 후 발행합니다(발행 순간 확인).'
        : mode === 'draft' ? '에이전트가 작성 후 임시저장합니다.' : '에이전트가 입력만 합니다.')
    } catch (e) {
      setError(String(e))
    } finally {
      setHandoffBusy(false)
    }
  }
  const canHandoff = !!body.trim() && !handoffBusy && (autoOpen || !isInternal)

  if (!providerReady) {
    return (
      <div className="ai-welcome">
        <div className="ai-welcome-title">✍️ 블로그 글쓰기</div>
        <div className="ai-welcome-page dim">AI 설정을 먼저 완료하면 주제만 넣어 완성된 블로그 글을 만들 수 있습니다.</div>
      </div>
    )
  }

  return (
    <div className="ai-body ai-write">
      {/* 상단 도구 — 저장·불러오기·시리즈 */}
      <div className="ai-write-tools">
        <button className="ai-mini-btn" onClick={saveDraft} disabled={!body.trim() && !title.trim()} title="현재 초안 저장">💾 저장</button>
        <button className={`ai-mini-btn ${showDrafts ? 'active' : ''}`} onClick={() => { setShowDrafts((s) => !s); setShowSeries(false) }} title="저장한 초안 불러오기">🗂 초안 {drafts.length ? `(${drafts.length})` : ''}</button>
        <button className={`ai-mini-btn ${showSeries ? 'active' : ''}`} onClick={() => { setShowSeries((s) => !s); setShowDrafts(false) }} title="시리즈 연재 기획">📚 시리즈</button>
        {curPart ? <span className="ai-write-partbadge">연재 {curPart}편</span> : null}
      </div>

      {/* 초안 목록 */}
      {showDrafts && (
        <div className="ai-write-drafts">
          {drafts.length === 0 ? <div className="ai-welcome-page dim" style={{ padding: 12, textAlign: 'center' }}>저장된 초안이 없습니다.</div> : (
            drafts.map((d) => (
              <div key={d.id} className={`ai-write-draftrow ${curDraftId === d.id ? 'current' : ''}`} onClick={() => loadDraft(d.id)}>
                <div className="ai-write-draftmain">
                  <div className="ai-write-drafttitle">{d.seriesId ? <span className="ai-write-partbadge sm">{d.part}편</span> : null}{d.title}</div>
                  <div className="ai-write-draftsub">{d.seriesTitle ? `📚 ${d.seriesTitle}` : (d.topic || '')}</div>
                </div>
                <button className="ai-history-del" onClick={(e) => removeDraft(d.id, e)} title="삭제">×</button>
              </div>
            ))
          )}
        </div>
      )}

      {/* 시리즈 기획 패널 */}
      {showSeries && (
        <div className="ai-write-series">
          <div className="ai-write-serieshead">
            <span>주제로 시리즈 기획 —</span>
            <input type="number" min={2} max={12} value={seriesParts} onChange={(e) => setSeriesParts(Math.max(2, Math.min(12, Number(e.target.value) || 3)))} />
            <span>부작</span>
            <button className="ai-mini-btn" onClick={planSeries} disabled={!topic.trim() || seriesGen}>{seriesGen ? '기획 중…' : '기획하기'}</button>
          </div>
          {!topic.trim() && <div className="ai-write-hint">먼저 아래에 시리즈 주제를 입력하세요.</div>}
          {seriesPlan && (
            <div className="ai-write-planlist">
              <div className="ai-write-planttl">📚 {seriesPlan.seriesTitle}</div>
              {seriesPlan.parts.map((p, i) => (
                <div key={i} className="ai-write-planrow">
                  <div className="ai-write-planmain">
                    <div className="ai-write-plantitle">{i + 1}. {p.title} {savedParts.has(i + 1) ? <span className="ai-write-partbadge sm ok">저장됨</span> : null}</div>
                    {p.angle && <div className="ai-write-plansub">{p.angle}</div>}
                  </div>
                  <button className="ai-mini-btn" disabled={generating} onClick={() => writePart(i)} title="이 편 작성">✍️ 작성</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 입력 폼 */}
      <div className="ai-write-form">
        <label className="ai-write-label">주제 / 무엇에 대한 글인가요?</label>
        <textarea className="ai-input ai-write-topic" rows={2} value={topic}
          placeholder="예: 초보자를 위한 홈트레이닝 시작하는 법"
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generate() } }} />
        <div className="ai-write-quickopts">
          <select value={tone} onChange={(e) => setTone(e.target.value)} title="어조">{TONES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <select value={length} onChange={(e) => setLength(e.target.value as 'short' | 'medium' | 'long')} title="분량">{LENGTHS.map((l) => <option key={l.v} value={l.v}>{l.label}</option>)}</select>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} title="발행처(SEO 최적화)">{PLATFORMS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}</select>
          <button className="ai-mini-btn" onClick={() => setShowOpts((s) => !s)} title="키워드·추가 요청">{showOpts ? '▾ 옵션' : '▸ 옵션'}</button>
        </div>
        {showOpts && (
          <div className="ai-write-adv">
            <input className="ai-input" value={keywords} placeholder="핵심 키워드 (쉼표, 검색 노출용)" onChange={(e) => setKeywords(e.target.value)} />
            <input className="ai-input" value={extra} placeholder="추가 요청 (예: 3가지 팁 위주로, 표 포함)" onChange={(e) => setExtra(e.target.value)} />
          </div>
        )}
        <button className="ai-send ai-write-gen" onClick={() => generate()} disabled={!topic.trim() || generating}>
          {generating ? '✍️ 생성 중… (수십 초 걸릴 수 있어요)' : draft ? '🔄 다시 생성' : '✨ 글 생성'}
        </button>
        {error && <div className="ai-handoff-note ai-err">{error}</div>}
        {notice && <div className="ai-handoff-note">{notice}</div>}
      </div>

      {/* 초안 결과 — 편집 가능 */}
      {draft && (
        <div className="ai-write-result">
          {seriesTitle ? <div className="ai-write-seriesctx">📚 {seriesTitle}{curPart ? ` · ${curPart}편` : ''}</div> : null}
          <label className="ai-write-label">제목 (후보 중 선택 · 수정 가능)</label>
          {draft.titles.length > 1 && (
            <div className="ai-write-titles">
              {draft.titles.map((tt, i) => (
                <button key={i} className={`ai-chip ${title === tt ? 'active' : ''}`} onClick={() => setTitle(tt)} title={tt}>
                  {tt.length > 22 ? tt.slice(0, 22) + '…' : tt}
                </button>
              ))}
            </div>
          )}
          <input className="ai-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="제목" />
          <div className="ai-write-bodyhead">
            <label className="ai-write-label" style={{ margin: 0 }}>본문 {preview ? '(미리보기)' : '(편집)'}</label>
            <button className="ai-mini-btn" onClick={() => setPreview((p) => !p)}>{preview ? '✎ 편집' : '👁 미리보기'}</button>
          </div>
          {preview
            ? <div className="ai-write-preview"><Markdown text={body} windowId="" /></div>
            : <textarea className="ai-input ai-write-bodyedit" value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} />}

          {/* 글 다듬기 — 지시로 본문 부분 개선 */}
          <div className="ai-write-refine">
            <div className="ai-write-refinehead">
              <span className="ai-write-label" style={{ margin: 0 }}>✨ 글 다듬기</span>
              {prevBody != null && <button className="ai-mini-btn" onClick={undoRefine} disabled={refining} title="다듬기 전으로 되돌리기">↩ 되돌리기</button>}
            </div>
            <div className="ai-write-refinepresets">
              {REFINE_PRESETS.map((p) => (
                <button key={p.label} className="ai-chip" disabled={refining || !body.trim()} onClick={() => runRefine(p.instr)}>{p.label}</button>
              ))}
            </div>
            <div className="ai-input-row">
              <input className="ai-input" value={refineInput} disabled={refining}
                placeholder="어떻게 다듬을까요? (예: 3번째 문단에 예시 추가)"
                onChange={(e) => setRefineInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runRefine(refineInput) } }} />
              <button className="ai-send" onClick={() => runRefine(refineInput)} disabled={refining || !refineInput.trim() || !body.trim()} title="다듬기">
                {refining ? '…' : '✨'}
              </button>
            </div>
          </div>

          <label className="ai-write-label">태그 (쉼표)</label>
          <input className="ai-input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="태그1, 태그2" />
          {draft.summary && <div className="ai-write-seo" title="검색 노출용 요약">🔎 {draft.summary}</div>}
          <label className="ai-write-autoopen" title="켜면 새 탭 등 글쓰기 화면이 아닐 때 에이전트가 먼저 네이버 글쓰기 페이지를 엽니다(로그인돼 있어야 함).">
            <input type="checkbox" checked={autoOpen} onChange={(e) => setAutoOpen(e.target.checked)} />
            <span>글쓰기 페이지 자동 열기 {platform === 'naver' ? '(네이버)' : ''}</span>
          </label>
          <div className="ai-write-actions">
            <button className="ai-send ai-write-insert" onClick={() => void handoff('publish')} disabled={!canHandoff}
              title="에이전트가 에디터에 작성하고 발행까지 합니다 (발행 순간 확인 요청)">📤 작성하고 발행</button>
            <button className="ai-mini-btn" onClick={() => void handoff('draft')} disabled={!canHandoff}
              title="에이전트가 작성 후 임시저장까지 합니다 (발행은 안 함)">📝 임시저장</button>
            <button className="ai-mini-btn" onClick={() => void handoff('insert')} disabled={!canHandoff}
              title="에이전트가 입력만 하고 저장·발행은 직접">✍️ 입력만</button>
            <button className="ai-mini-btn" onClick={saveDraft} disabled={!body.trim() && !title.trim()}>💾 초안저장</button>
            <button className="ai-mini-btn" onClick={() => { void copyText(fullMarkdown()).then(() => setNotice('복사했습니다.')) }}>복사</button>
            <button className="ai-mini-btn" onClick={() => downloadText(`${(title || 'blog').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)}.md`, fullMarkdown())}>.md</button>
          </div>
          <div className="ai-write-hint">💡 <b>작성하고 발행</b>은 네이버 SmartEditor 를 인지해 제목·본문·태그를 넣고 발행까지 하며, 되돌리기 어려운 <b>발행 버튼을 누르는 순간 한 번 확인</b>을 요청합니다. <b>임시저장</b>은 발행 없이 저장만 합니다. 네이버는 <b>미리 로그인</b>돼 있어야 합니다.</div>
        </div>
      )}
    </div>
  )
}
