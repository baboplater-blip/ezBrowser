import { getSetting } from '../../storage/settings'
import { getAiKey } from './keys'
import { chatOnce, isCliProvider, cliPathSettingKey, type AiMessage, type AiRequest } from './providers'

// 블로그 글쓰기 스튜디오 — 주제·옵션 → AI 가 제목 후보·본문(도입부·중제목·표·FAQ·CTA)·태그·SEO 요약을 한 번에 생성.
// 참고: naver_blog_automation_v3 의 콘텐츠 모델(도입부/중제목/표/FAQ/CTA/태그, C-Rank·D.I.A. 신호)을 프롬프트로 흡수.
// 실제 발행은 하지 않는다 — 초안 생성만. 에디터 입력·발행은 사용자가 스튜디오에서 트리거(에이전트가 자동 발행 안 함).

export interface BlogDraftParams {
  topic: string
  tone?: string             // 정보전달 / 친근 / 전문 / 후기 / 시니어(따뜻)
  length?: 'short' | 'medium' | 'long'
  keywords?: string         // 쉼표 구분 핵심 키워드
  category?: string
  audience?: string         // 독자 대상
  platform?: string         // naver / tistory / wordpress / generic
  extra?: string            // 추가 지시(자유)
  series?: {                // 시리즈 연재의 한 편으로 작성할 때 — 연속성 맥락 주입
    seriesTitle: string
    part: number
    totalParts: number
    partTitle?: string      // 이 편의 소제목/앵글
    otherTitles?: string[]  // 다른 편 제목들(중복 방지·연결)
  }
}

export interface SeriesPlanParams {
  topic: string
  parts: number             // 몇 부작
  tone?: string
  platform?: string
  keywords?: string
  audience?: string
}
export interface SeriesPlan {
  seriesTitle: string
  parts: Array<{ title: string; angle: string }>
}

export interface BlogDraft {
  titles: string[]          // 제목 후보(첫 번째가 추천)
  tags: string[]            // 해시태그/태그
  summary: string           // SEO 메타 설명(검색 노출용 한 줄)
  bodyMarkdown: string      // 본문(마크다운 — 도입부·## 중제목·표·FAQ·CTA)
}

interface LenGuide { chars: string; tokens: number }
const LENGTH_GUIDE: Record<string, LenGuide> = {
  short: { chars: '700~1000자', tokens: 2200 },
  medium: { chars: '1500~2000자', tokens: 3800 },
  long: { chars: '2500~3500자', tokens: 6000 },
}
const DEFAULT_LEN: LenGuide = { chars: '1500~2000자', tokens: 3800 }
function lenOf(length?: string): LenGuide { return LENGTH_GUIDE[length ?? 'medium'] ?? DEFAULT_LEN }

const TONE_GUIDE: Record<string, string> = {
  정보전달: '군더더기 없이 사실·절차 중심으로 명확하게. 단정적이되 근거를 곁들인다.',
  친근: '친구에게 설명하듯 편안한 존댓말. 이모지·비유를 적절히.',
  전문: '해당 분야 전문가의 신뢰감 있는 어조. 용어를 정확히 쓰되 풀어서 설명.',
  후기: '직접 경험한 것처럼 생생하게. 장단점을 솔직하게, 사진 자리(＜사진＞)를 군데군데 제안.',
  시니어: '어르신도 이해하도록 아주 쉽고 따뜻하게. 어려운 용어는 반드시 풀어 쓰고 단계별로.',
}

// 이 모듈 전용 요청 빌더(에이전트의 resolveReq 와 동일 규칙 — 제공자별 키/모델/경로).
async function resolveReq(system: string, messages: AiMessage[], maxTokens: number): Promise<AiRequest> {
  const s = getSetting('ai')
  const provider = s.provider
  const model = provider === 'anthropic' ? s.anthropicModel
    : provider === 'openai' ? s.openaiModel
      : provider === 'google' ? s.googleModel
        : provider === 'claude-code' ? s.claudeCodeModel
          : provider === 'codex' ? s.codexModel
            : provider === 'gemini-cli' ? s.geminiCliModel
              : s.ollamaModel
  let apiKey: string | undefined
  let baseUrl: string | undefined
  if (provider === 'ollama') baseUrl = s.ollamaUrl
  else if (isCliProvider(provider)) { const k = cliPathSettingKey(provider); baseUrl = k ? s[k] : '' }
  else {
    const key = await getAiKey(provider)
    if (!key) throw new Error(`${provider} API 키가 설정되지 않았습니다. 설정 > AI 에서 입력하세요.`)
    apiKey = key
  }
  return { provider, model, system, messages, apiKey, baseUrl, maxTokens }
}

function blogSystemPrompt(p: BlogDraftParams): string {
  const len = lenOf(p.length)
  const tone = TONE_GUIDE[p.tone ?? '정보전달'] ?? (p.tone?.trim() || '군더더기 없이 사실·절차 중심으로 명확하게 씁니다.')
  const platformHint = p.platform === 'naver'
    ? '네이버 블로그에 발행됩니다. 네이버 검색(C-Rank·D.I.A.)에 잘 노출되도록: 제목·첫 문단에 핵심 키워드를 자연스럽게 넣고, 실제 정보와 경험이 담긴 성의 있는 글로.'
    : p.platform === 'tistory' ? '티스토리(구글/다음 검색)에 발행됩니다. 소제목(H2)에 키워드를 넣고 구조적으로.'
      : p.platform === 'wordpress' ? '워드프레스(구글 검색)에 발행됩니다. SEO 를 고려한 소제목 구조로.'
        : '검색 노출을 고려해 제목·소제목에 핵심 키워드를 자연스럽게 배치.'
  return [
    '당신은 한국어 블로그 글을 전문적으로 써 주는 작가입니다. 아래 주제로 바로 발행 가능한 완성도 높은 글을 씁니다.',
    '',
    `# 어조\n${tone}`,
    `# 분량\n본문은 대략 ${len.chars}. 너무 짧지 않게, 알맹이 있게.`,
    `# 발행처\n${platformHint}`,
    '',
    '# 글의 구성 (반드시 지킬 것)',
    '- 도입부: 독자의 고민·검색 의도를 짚고 이 글이 무엇을 해결하는지 2~3문장.',
    '- 본문: `## 소제목` 을 3~6개. 각 소제목 아래 충분한 설명. 목록(-)·강조(**)를 적절히.',
    '- 표: 비교·요약·단계 정보가 있으면 마크다운 표(| ... |)를 최소 1개 넣는다.',
    '- FAQ: 마지막 근처에 `## 자주 묻는 질문(FAQ)` 으로 Q&A 2~4개.',
    '- 마무리: 핵심 요약 + 행동 유도(CTA) 한 문단.',
    '- 사실 관계는 정확하게. 모르는 수치를 지어내지 말고 일반적 원칙으로 서술.',
    '',
    '# 출력 형식 (정확히 이 형식으로, 다른 말·코드펜스 없이)',
    '[제목]',
    '- (제목 후보 1 — 가장 추천, 30자 내외, 키워드 포함)',
    '- (제목 후보 2)',
    '- (제목 후보 3)',
    '[태그]',
    '태그1, 태그2, 태그3, 태그4, 태그5 (5~10개, # 없이 쉼표로)',
    '[요약]',
    '(검색 노출용 메타 설명 한 줄, 80자 이내)',
    '[본문]',
    '(여기부터 끝까지 마크다운 본문)',
  ].join('\n')
}

function userPrompt(p: BlogDraftParams): string {
  const lines = [`주제: ${p.topic}`]
  if (p.keywords?.trim()) lines.push(`핵심 키워드: ${p.keywords.trim()}`)
  if (p.category?.trim()) lines.push(`카테고리: ${p.category.trim()}`)
  if (p.audience?.trim()) lines.push(`독자 대상: ${p.audience.trim()}`)
  if (p.extra?.trim()) lines.push(`추가 요청: ${p.extra.trim()}`)
  if (p.series) {
    const s = p.series
    lines.push('',
      `# 시리즈 연재 (${s.totalParts}부작 중 ${s.part}편)`,
      `시리즈 제목: ${s.seriesTitle}`,
      s.partTitle ? `이번 편 주제: ${s.partTitle}` : '',
      s.otherTitles?.length ? `다른 편들: ${s.otherTitles.join(' / ')} (내용이 겹치지 않게, 이번 편에 집중)` : '',
      '이 편만으로도 완결성 있게 읽히되, 시리즈의 한 편임을 자연스럽게 드러내세요(도입에 시리즈 언급, 마무리에 다음 편 예고 한 줄).',
    )
  }
  lines.push('', '위 조건으로 블로그 글을 위 출력 형식대로 작성하세요.')
  return lines.filter((l) => l !== '' || true).join('\n')
}

function seriesSystemPrompt(p: SeriesPlanParams): string {
  const tone = TONE_GUIDE[p.tone ?? '정보전달'] ?? (p.tone?.trim() || '명확하고 신뢰감 있게')
  return [
    `당신은 블로그 시리즈를 기획하는 편집자입니다. 주어진 주제로 ${p.parts}부작 연재 시리즈를 설계합니다.`,
    `어조: ${tone}`,
    '각 편은 서로 겹치지 않고, 독자가 1편부터 순서대로 읽으면 주제를 깊이 이해하도록 논리적으로 이어지게 구성하세요.',
    '',
    '# 출력 형식 (정확히 이 형식으로, 다른 말·코드펜스 없이)',
    '[시리즈제목]',
    '시리즈 전체를 아우르는 제목 한 줄',
    '[목차]',
    '1. (실제 1편 제목) | (그 편에서 다룰 핵심 내용 한 줄)',
    '2. (실제 2편 제목) | (핵심 내용)',
    `(총 ${p.parts}편까지)`,
    '',
    '아래는 "형식"을 보여주는 예시일 뿐입니다. 내용을 그대로 베끼지 말고, 반드시 사용자 주제에 맞는 실제 제목·내용으로 새로 쓰세요:',
    '[시리즈제목]',
    '30일 아침 루틴 완성하기',
    '[목차]',
    '1. 일찍 일어나는 3가지 방법 | 기상 습관을 만드는 실전 팁',
    '2. 5분 스트레칭으로 몸 깨우기 | 따라 하기 쉬운 동작 소개',
    '3. 아침 저널로 하루 계획하기 | 저널 양식과 작성 예시',
  ].join('\n')
}
function parseSeriesPlan(raw: string, wantParts: number): SeriesPlan {
  const text = raw.replace(/\r\n/g, '\n').trim()
  const tIdx = text.search(/^\s*\[?\s*시리즈제목\s*\]?\s*$/im)
  const oIdx = text.search(/^\s*\[?\s*목차\s*\]?\s*$/im)
  let seriesTitle = ''
  if (tIdx >= 0) {
    const from = tIdx
    const end = oIdx > from ? oIdx : text.length
    seriesTitle = text.slice(from, end).replace(/^\s*\[?\s*시리즈제목\s*\]?\s*\n?/i, '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? ''
  }
  const listBlock = oIdx >= 0 ? text.slice(oIdx).replace(/^\s*\[?\s*목차\s*\]?\s*\n?/i, '') : text
  const parts: Array<{ title: string; angle: string }> = []
  for (const rawLine of listBlock.split('\n')) {
    // 리스트 마커(1. / 1) / - / * / #) "하나"만 제거 — "1편 제목" 의 앞자리 숫자를 깎지 않도록.
    const l = rawLine.replace(/^\s*(?:\d{1,2}[.)]|[-*#•])\s+/, '').trim()
    if (!l || /^\[/.test(l)) continue          // 남은 마커/헤더 줄 건너뜀
    if (/^\(?실제\s|^시리즈 전체를|^핵심 내용/.test(l)) continue // 예시 플레이스홀더 방어
    const [title, ...rest] = l.split('|')
    const t = (title ?? '').trim().replace(/^\((.*)\)$/, '$1').trim() // 괄호 감싼 플레이스홀더 정리
    if (!t) continue
    parts.push({ title: t.slice(0, 120), angle: rest.join('|').trim().replace(/^\((.*)\)$/, '$1').trim().slice(0, 200) })
    if (parts.length >= wantParts) break
  }
  return { seriesTitle: seriesTitle || (parts[0]?.title ?? '블로그 시리즈'), parts }
}

export async function generateSeriesPlan(p: SeriesPlanParams): Promise<SeriesPlan> {
  if (!p || !p.topic?.trim()) throw new Error('주제를 입력하세요.')
  const parts = Math.max(2, Math.min(12, Math.round(p.parts) || 3))
  const req = await resolveReq(seriesSystemPrompt({ ...p, parts }),
    [{ role: 'user', content: `시리즈 주제: ${p.topic.trim()}${p.keywords?.trim() ? `\n핵심 키워드: ${p.keywords.trim()}` : ''}\n\n위 주제로 ${parts}부작 시리즈를 위 형식대로 기획하세요.` }], 1500)
  const { promise } = chatOnce(req)
  const plan = parseSeriesPlan(await promise, parts)
  if (!plan.parts.length) throw new Error('시리즈 기획에 실패했습니다. 다시 시도하세요.')
  return plan
}

// ===== 글 다듬기(부분 개선) — 현재 본문을 사용자 지시대로 고쳐 전체 본문을 다시 반환 =====
export interface RefineParams {
  body: string
  instruction: string
  title?: string
  tone?: string
  platform?: string
}
export async function refineBlogBody(p: RefineParams): Promise<string> {
  const body = (p?.body ?? '').trim()
  const instruction = (p?.instruction ?? '').trim()
  if (!body) throw new Error('다듬을 본문이 없습니다.')
  if (!instruction) throw new Error('어떻게 다듬을지 알려주세요.')
  const tone = TONE_GUIDE[p.tone ?? '정보전달'] ?? (p.tone?.trim() || '')
  const system = [
    '당신은 한국어 블로그 편집자입니다. 주어진 본문을 사용자 지시대로 다듬어 전체 본문을 마크다운으로 "다시" 씁니다.',
    tone ? `어조: ${tone}` : '',
    '규칙: 지시에 없는 부분은 원래 내용·구조(## 소제목·표·FAQ·목록)를 최대한 보존하고, 지시된 부분만 반영합니다. 사실을 임의로 지어내지 마세요.',
    '출력: 설명·인사·머리말·코드펜스 없이 다듬은 본문 전체(마크다운)만 출력합니다.',
  ].filter(Boolean).join('\n')
  const user = [
    `[지시] ${instruction}`,
    p.title?.trim() ? `\n[제목] ${p.title.trim()}` : '',
    '\n[현재 본문]', body,
    '\n위 지시대로 본문을 다듬어, 다듬은 본문 전체만 출력하세요.',
  ].filter(Boolean).join('\n')
  const maxTokens = Math.max(getSetting('ai').maxTokens, Math.min(6000, Math.round(body.length / 1.5) + 1200))
  const req = await resolveReq(system, [{ role: 'user', content: user }], maxTokens)
  const { promise } = chatOnce(req)
  const raw = (await promise).trim()
  // 머리말/코드펜스 정리 — "다듬은 본문:" 류 접두 + ```markdown 펜스 제거.
  let out = raw.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
  out = out.replace(/^(?:다듬은\s*본문|수정(?:된|한)?\s*본문|결과)\s*[:：]\s*\n?/i, '').trim()
  if (!out) throw new Error('다듬기 결과가 비었습니다. 다시 시도하세요.')
  return out
}

// 델리미터 파서 — 대용량 본문을 JSON 이스케이프 없이 안전하게 뽑는다(로컬 모델도 안정).
function parseDraft(raw: string): BlogDraft {
  const text = raw.replace(/\r\n/g, '\n').trim()
  // 섹션 마커 위치 찾기(대괄호 라벨). 유연하게: [제목]/[태그]/[요약]/[본문]
  const markers: Array<{ key: keyof BlogDraft | 'body'; re: RegExp }> = [
    { key: 'titles', re: /^\s*\[?\s*제목\s*\]?\s*$/im },
    { key: 'tags', re: /^\s*\[?\s*태그\s*\]?\s*$/im },
    { key: 'summary', re: /^\s*\[?\s*요약\s*\]?\s*$/im },
    { key: 'body', re: /^\s*\[?\s*본문\s*\]?\s*$/im },
  ]
  const idx: Record<string, number> = {}
  for (const m of markers) {
    const found = text.match(m.re)
    idx[m.key] = found?.index ?? -1
  }
  const at = (k: string): number => idx[k] ?? -1
  const bodyStart = at('body')
  const titlesIdx = at('titles')
  // 본문: [본문] 마커 다음 줄부터 끝까지
  let bodyMarkdown = ''
  if (bodyStart >= 0) {
    const after = text.slice(bodyStart)
    bodyMarkdown = after.replace(/^\s*\[?\s*본문\s*\]?\s*\n?/i, '').trim()
  }
  const sliceBetween = (from: number, upto: number[]): string => {
    if (from < 0) return ''
    const ends = upto.filter((n) => n > from)
    const end = ends.length ? Math.min(...ends) : text.length
    return text.slice(from, end).replace(/^\s*\[?\s*[가-힣]+\s*\]?\s*\n?/i, '').trim()
  }
  const titlesBlock = sliceBetween(titlesIdx, [at('tags'), at('summary'), bodyStart])
  const tagsBlock = sliceBetween(at('tags'), [at('summary'), bodyStart, titlesIdx])
  const summaryBlock = sliceBetween(at('summary'), [bodyStart, titlesIdx, at('tags')])

  const titles = titlesBlock.split('\n').map((l) => l.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean).slice(0, 5)
  const tags = tagsBlock.replace(/#/g, '').split(/[,\n]/).map((t) => t.trim()).filter(Boolean).slice(0, 12)
  const summary = summaryBlock.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? ''

  // 마커가 전혀 없으면(모델이 형식 무시) 전체를 본문으로, 첫 줄을 제목 후보로.
  if (bodyStart < 0 && titlesIdx < 0) {
    const firstLine = text.split('\n').find((l) => l.trim()) ?? ''
    return { titles: firstLine ? [firstLine.replace(/^#+\s*/, '').slice(0, 40)] : [], tags: [], summary: '', bodyMarkdown: text }
  }
  return { titles, tags, summary, bodyMarkdown: bodyMarkdown || text }
}

export async function generateBlogDraft(p: BlogDraftParams): Promise<BlogDraft> {
  if (!p || !p.topic?.trim()) throw new Error('주제를 입력하세요.')
  const maxTokens = Math.max(getSetting('ai').maxTokens, lenOf(p.length).tokens)
  const req = await resolveReq(blogSystemPrompt(p), [{ role: 'user', content: userPrompt(p) }], maxTokens)
  const { promise } = chatOnce(req)
  const raw = await promise
  const draft = parseDraft(raw)
  if (!draft.bodyMarkdown.trim()) throw new Error('생성된 본문이 비어 있습니다. 다시 시도하거나 다른 제공자로 바꿔 보세요.')
  return draft
}
