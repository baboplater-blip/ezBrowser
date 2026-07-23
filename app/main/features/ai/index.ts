import { getSetting } from '../../storage/settings'
import { getWebContentsByTabId, getTab } from '../../tabs/tab-service'
import { extractPageContent, getPageSummaryInfo, type PageContent } from './page-content'
import {
  streamChat, chatOnce, isCliProvider, cliPathSettingKey, type AiMessage, type AiProviderId, type AiRequest, type AiStreamHandle, type AiStreamHandlers,
} from './providers'
import {
  initAiKeys, getAiKey, hasAiKey, isKeyStorageAvailable,
} from './keys'
import { initAiMemory, memoryBlock, appendMemory, getMemoryText } from './memory'
import { initConversations } from './conversations'
import { initSavedTasks } from './saved-tasks'
import { initAgentRuns } from './agent-runs'

export type { AiMessage, AiProviderId } from './providers'
export { diagnoseAi, type AiDiagnosis } from './diagnose'

const BASE_SYSTEM =
  '당신은 웹 브라우저에 내장된 AI 어시스턴트입니다. 사용자가 지금 보고 있는 웹 페이지를 함께 보며 돕습니다. ' +
  '한국어로 정확하고 간결하게 답하세요. 마크다운을 적절히 사용하세요. ' +
  '페이지 내용에 없는 사실은 지어내지 말고, 모르면 모른다고 하세요.'

const PROVIDER_LABEL: Record<AiProviderId, string> = {
  anthropic: 'Claude (Anthropic)',
  openai: 'OpenAI (ChatGPT)',
  ollama: '로컬 Ollama',
  google: 'Google Gemini',
  'claude-code': 'Claude Code (구독)',
  codex: 'Codex (ChatGPT 구독)',
  'gemini-cli': 'Gemini CLI',
}

export interface AiClientConfig {
  enabled: boolean
  provider: AiProviderId
  providerLabel: string
  model: string
  hasKey: boolean          // 선택된 제공자가 바로 쓸 수 있는가 (ollama 는 항상 true)
  storageAvailable: boolean
}

export async function initAi(): Promise<void> {
  await initAiKeys()
  initAiMemory()
  initConversations()
  initSavedTasks()
  initAgentRuns()
}

function currentModel(provider: AiProviderId): string {
  const s = getSetting('ai')
  if (provider === 'anthropic') return s.anthropicModel
  if (provider === 'openai') return s.openaiModel
  if (provider === 'google') return s.googleModel
  if (provider === 'claude-code') return s.claudeCodeModel
  if (provider === 'codex') return s.codexModel
  if (provider === 'gemini-cli') return s.geminiCliModel
  return s.ollamaModel
}

export async function getAiClientConfig(): Promise<AiClientConfig> {
  const s = getSetting('ai')
  const provider = s.provider
  const hasKey = (provider === 'ollama' || isCliProvider(provider)) ? true : await hasAiKey(provider)
  return {
    enabled: s.enabled,
    provider,
    providerLabel: PROVIDER_LABEL[provider],
    model: currentModel(provider),
    hasKey,
    storageAvailable: isKeyStorageAvailable(),
  }
}

export async function getAiKeyStatus(): Promise<{ anthropic: boolean; openai: boolean; google: boolean; storageAvailable: boolean }> {
  return {
    anthropic: await hasAiKey('anthropic'),
    openai: await hasAiKey('openai'),
    google: await hasAiKey('google'),
    storageAvailable: isKeyStorageAvailable(),
  }
}

export async function getAiPageInfo(tabId?: string): Promise<{ url: string; title: string; hasSelection: boolean } | null> {
  if (!tabId) return null
  const wc = getWebContentsByTabId(tabId)
  if (!wc) {
    const t = getTab(tabId)
    return t ? { url: t.url, title: t.title, hasSelection: false } : null
  }
  return getPageSummaryInfo(wc)
}

function buildPageBlock(page: PageContent): string {
  let block = '\n\n# 사용자가 지금 보고 있는 페이지\n'
  block += `제목: ${page.title}\nURL: ${page.url}\n`
  if (page.byline) block += `작성자: ${page.byline}\n`
  if (page.selection) {
    block += `\n## 사용자가 선택(드래그)한 텍스트\n"""\n${page.selection}\n"""\n`
  }
  block += '\n## 페이지 본문\n"""\n' + page.text + '\n"""\n'
  if (page.truncated) block += '\n(본문이 길어 앞부분만 포함되었습니다.)\n'
  return block
}

export interface StartChatParams {
  reqId: string
  tabId?: string
  includePage: boolean
  messages: AiMessage[]
  summary?: string // 접힌(요약된) 이전 대화 — 시스템 프롬프트에 주입해 맥락 유지
}

const activeStreams = new Map<string, AiStreamHandle>()

export async function startAiChat(params: StartChatParams, handlers: AiStreamHandlers): Promise<void> {
  const s = getSetting('ai')
  if (!s.enabled) {
    handlers.onError('AI 기능이 꺼져 있습니다. 설정 > AI 에서 켜세요.')
    return
  }
  const provider = s.provider
  const model = currentModel(provider)

  let apiKey: string | undefined
  let baseUrl: string | undefined
  if (provider === 'ollama') {
    baseUrl = s.ollamaUrl
  } else if (isCliProvider(provider)) {
    const key = cliPathSettingKey(provider) // CLI 실행 경로(비우면 기본 바이너리) — 키 불필요, 구독/계정으로 구동
    baseUrl = key ? s[key] : ''
  } else {
    const key = await getAiKey(provider)
    if (!key) {
      handlers.onError(`${PROVIDER_LABEL[provider]} API 키가 설정되지 않았습니다. 설정 > AI 에서 키를 입력하세요.`)
      return
    }
    apiKey = key
  }

  let system = BASE_SYSTEM
  if (s.memoryEnabled) system += memoryBlock(2000)
  // 긴 대화의 앞부분을 요약해 접었으면, 그 요약을 맥락으로 주입(원문 대신 → 토큰·컨텍스트 절약).
  if (params.summary && params.summary.trim()) {
    system += '\n\n# 이전 대화 요약 (맥락 유지용 — 아래 최근 메시지와 함께 참고)\n' + params.summary.trim()
  }
  if (params.includePage && params.tabId) {
    const wc = getWebContentsByTabId(params.tabId)
    if (wc) {
      const page = await extractPageContent(wc, Math.max(1000, s.maxContextChars))
      if (page && page.text) system += buildPageBlock(page)
      else system += '\n\n(현재 페이지에서 본문 텍스트를 읽지 못했습니다. 내부 페이지이거나 아직 로딩 중일 수 있습니다.)'
    }
  }

  // 스트림 시작 — 취소 핸들을 reqId 로 추적한다.
  let settledSync = false
  const wrapped: AiStreamHandlers = {
    onDelta: handlers.onDelta,
    onDone: (full) => { settledSync = true; activeStreams.delete(params.reqId); handlers.onDone(full) },
    onError: (msg) => { settledSync = true; activeStreams.delete(params.reqId); handlers.onError(msg) },
  }
  const handle = streamChat(
    { provider, model, system, messages: params.messages, apiKey, baseUrl, maxTokens: s.maxTokens },
    wrapped,
  )
  // streamChat 이 동기적으로 onError 를 부른 경우(잘못된 ollamaUrl 등) 이미 delete 됐으므로
  // set 을 건너뛴다 — 아니면 죽은 핸들이 맵에 영구히 남는다.
  if (!settledSync) activeStreams.set(params.reqId, handle)
}

export function cancelAiChat(reqId: string): void {
  const handle = activeStreams.get(reqId)
  if (handle) {
    handle.cancel()
    activeStreams.delete(reqId)
  }
}

// ===== 대화 압축(콤팩트) — 긴 대화의 앞부분을 요약해 컨텍스트 폭증을 막는다 =====

const SUMMARIZE_SYSTEM =
  '다음은 사용자와 AI 어시스턴트의 대화 기록입니다. 이후 대화가 맥락을 잃지 않도록 핵심만 압축해 요약하세요. ' +
  '사용자의 목적·결정된 사항·중요한 사실·수치·미해결 질문을 한국어 불릿 몇 개로 정리하세요. ' +
  '인사·잡담은 생략하고, 요약문만 출력하세요(머리말·설명 없이).'

// 접을 메시지들(+이전 요약)을 한 번의 LLM 호출로 요약. 역할 구조 대신 평문 트랜스크립트로 넘겨
// 모든 제공자(CLI 포함)에서 alternation 문제 없이 동작. 실패 시 예외 → 호출부가 처리.
export async function summarizeChat(messages: AiMessage[], prevSummary?: string): Promise<string> {
  const convo = messages.filter((m) => m.content && m.content.trim())
  if (convo.length === 0) return (prevSummary ?? '').trim()
  let system = SUMMARIZE_SYSTEM
  if (prevSummary && prevSummary.trim()) {
    system += '\n\n# 지금까지의 요약(여기에 새 대화를 통합해 갱신)\n' + prevSummary.trim().slice(0, 3000)
  }
  const transcript = convo.map((m) => `${m.role === 'user' ? '사용자' : 'AI'}: ${m.content}`).join('\n\n')
  const req = await resolveRequestFor(system, [{ role: 'user', content: transcript }], 600)
  const text = await chatOnce(req).promise
  return text.trim()
}

// ===== 자동 Dreaming (대화에서 장기 기억할 사실 자동 추출) =====

const DREAM_SYSTEM =
  '사용자가 방금 대화에서 밝힌 "자기 자신에 대한 지속적 사실"만 한 줄에 하나씩 적어라. ' +
  '예: 직업, 이름, 사는 곳, 언어·말투 선호, 목표. ' +
  '규칙: 사실 문장만 적는다. 머리말·설명·괄호·번호·불릿·따옴표 금지. ' +
  '일회성 질문이나 인사는 무시한다. 적을 사실이 없으면 오직 NONE 이라고만 적어라.'

// 사실이 아닌 줄(없음 문장·머리말·메타·괄호 주석)을 저장하지 않도록 방어 — 소형 로컬 모델의 형식 이탈 대비.
function isNonFactLine(line: string): boolean {
  // 후행 문장부호까지 벗겨 "NONE." / "None found." 같은 변형도 걸러낸다.
  const s = line.replace(/[()[\]*_`~]/g, '').replace(/[.!?。,·:\s]+$/, '').trim()
  if (s.length < 3) return true
  if (/^none\b|없음|없습니다|없다\b|없어|해당\s*없|^n\/?a$|not\s+applicable|^nothing\b|특별한\s*(사실|정보)/i.test(s)) return true
  // 머리말·메타·설명형 문장 거부(사실이 아님) — 실제 사실 문장은 통과해야 하므로 메타 표지만 좁게.
  if (/참고|형식에\s*맞|출력하면|다음과\s*같|아래와\s*같|예\s*[):]|죄송|말씀하신|정리하면/i.test(s)) return true
  if (/^\(/.test(line.trim())) return true
  return false
}

async function resolveRequestFor(system: string, messages: AiMessage[], maxTokens: number): Promise<AiRequest> {
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
    if (!key) throw new Error('no key')
    apiKey = key
  }
  return { provider, model, system, messages, apiKey, baseUrl, maxTokens }
}

// 대화 종료 후 호출 — 새로 기억한 사실 목록을 반환(설정 OFF 면 빈 배열). 실패해도 조용히 무시.
export async function maybeAutoRemember(messages: AiMessage[]): Promise<string[]> {
  const s = getSetting('ai')
  if (!s.autoMemory || !s.memoryEnabled) return []
  const convo = messages.filter((m) => m.content && m.content.trim()).slice(-8)
  if (convo.length === 0) return []
  const cur = getMemoryText().trim()
  const system = DREAM_SYSTEM + (cur ? `\n\n# 이미 기억한 것(중복 저장 금지)\n${cur.slice(0, 1500)}` : '')
  let text: string
  try {
    const req = await resolveRequestFor(system, convo, 150)
    text = await chatOnce(req).promise
  } catch {
    return []
  }
  const trimmed = text.trim()
  if (!trimmed || /^none[\s.!?。]*$/i.test(trimmed)) return []
  const lines = trimmed
    .split('\n')
    .map((l) => l.replace(/^[-*\d.\s)]+/, '').replace(/[*`_]+/g, '').replace(/^["']|["']$/g, '').trim())
    .filter((l) => l && !isNonFactLine(l))
    .slice(0, 3)
  const added: string[] = []
  for (const line of lines) {
    if (cur.includes(line)) continue
    await appendMemory(line)
    added.push(line)
  }
  return added
}
