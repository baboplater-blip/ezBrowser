import { getSetting } from '../../storage/settings'
import { chatOnce, isCliProvider, cliPathSettingKey, type AiRequest, type AiProviderId } from './providers'
import { getAiKey } from './keys'
import { getAiClientConfig } from './index'

// AI 상태 점검 — 현재 제공자에 실제로 한 번 요청을 보내, 정상인지 / 무엇이 문제인지(원인+해결책) 판정.
// 반복된 "AI 가 안 돼요" 의 근본 원인(모델 미설치·미로그인·연결 실패·키 없음)을 한 번에 짚어준다.

export type AiDiagStatus =
  | 'ok' | 'disabled' | 'no-key' | 'model-missing' | 'not-connected' | 'not-logged-in' | 'cli-missing' | 'empty' | 'error'

export interface AiDiagnosis {
  ok: boolean
  provider: AiProviderId
  providerLabel: string
  model: string
  status: AiDiagStatus
  message: string           // 한 줄 요약(한국어)
  detail?: string           // 원인 상세(원문 오류 등)
  fix?: string              // 해결 방법
  latencyMs?: number
  installedModels?: string[] // ollama: 실제 설치된 모델(전환 제안용)
}

const CLI_BIN: Record<string, string> = { 'claude-code': 'claude', codex: 'codex', 'gemini-cli': 'gemini' }

function modelFor(provider: AiProviderId): string {
  const s = getSetting('ai')
  if (provider === 'anthropic') return s.anthropicModel
  if (provider === 'openai') return s.openaiModel
  if (provider === 'google') return s.googleModel
  if (provider === 'claude-code') return s.claudeCodeModel
  if (provider === 'codex') return s.codexModel
  if (provider === 'gemini-cli') return s.geminiCliModel
  return s.ollamaModel
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try { return await fetch(url, { signal: ctrl.signal }) }
  finally { clearTimeout(t) }
}

async function buildPingRequest(): Promise<AiRequest> {
  const s = getSetting('ai')
  const provider = s.provider
  const model = modelFor(provider)
  let apiKey: string | undefined
  let baseUrl: string | undefined
  if (provider === 'ollama') baseUrl = s.ollamaUrl
  else if (isCliProvider(provider)) { const k = cliPathSettingKey(provider); baseUrl = k ? s[k] : '' }
  else {
    const key = await getAiKey(provider)
    if (!key) throw new Error('no key')
    apiKey = key
  }
  return { provider, model, system: '연결 점검용입니다. 한 단어로만 답하세요.', messages: [{ role: 'user', content: 'OK 라고만 답해.' }], apiKey, baseUrl, maxTokens: 16 }
}

function classifyError(base: Pick<AiDiagnosis, 'provider' | 'providerLabel' | 'model'>, rawMsg: string): AiDiagnosis {
  const msg = rawMsg
  const m = rawMsg.toLowerCase()
  const isCli = isCliProvider(base.provider)
  const bin = CLI_BIN[base.provider] ?? base.provider
  if (isCli && /enoent|not found|not recognized|command not found|is not recognized|spawn|no such file/.test(m)) {
    return { ...base, ok: false, status: 'cli-missing', message: `'${bin}' 명령을 찾을 수 없습니다.`, detail: msg.slice(0, 200), fix: `${bin} CLI 를 설치하고 PATH 에 추가하세요. 설정 > AI 에서 실행 경로를 직접 지정할 수도 있습니다.` }
  }
  if (/login|logged|unauthorized|401|403|forbidden|authenticate|not authenticated|api key/.test(m)) {
    return isCli
      ? { ...base, ok: false, status: 'not-logged-in', message: `'${bin}' 로그인이 필요합니다.`, detail: msg.slice(0, 200), fix: `터미널에서 '${bin}' 를 한 번 실행해 로그인(구독 계정 연결)하세요.` }
      : { ...base, ok: false, status: 'not-logged-in', message: `인증에 실패했습니다.`, detail: msg.slice(0, 200), fix: `설정 > AI 에서 API 키를 다시 확인하세요.` }
  }
  if (/\bmodel\b|not found|없는 모델|404/.test(m)) {
    return { ...base, ok: false, status: 'model-missing', message: `모델 '${base.model || '(기본)'}' 을(를) 사용할 수 없습니다.`, detail: msg.slice(0, 200), fix: `설정 > AI 에서 계정·설치에 맞는 모델 이름으로 바꾸세요.` }
  }
  if (/econnrefused|fetch failed|network|connect|timeout|시간 초과|aborted/.test(m)) {
    return { ...base, ok: false, status: 'not-connected', message: `AI 서버에 연결하지 못했습니다.`, detail: msg.slice(0, 200), fix: `인터넷 연결 또는 로컬 서버(Ollama) 실행 상태를 확인하세요.` }
  }
  return { ...base, ok: false, status: 'error', message: `오류가 발생했습니다.`, detail: msg.slice(0, 200), fix: `잠시 후 다시 시도하거나 다른 제공자로 바꿔 보세요.` }
}

async function pingModel(base: Pick<AiDiagnosis, 'provider' | 'providerLabel' | 'model'>): Promise<AiDiagnosis> {
  let req: AiRequest
  try { req = await buildPingRequest() } catch { return { ...base, ok: false, status: 'no-key', message: `${base.providerLabel} API 키가 없습니다.`, fix: '설정 > AI 에서 API 키를 입력하세요.' } }
  const t0 = Date.now()
  try {
    const text = await chatOnce(req).promise
    const latencyMs = Date.now() - t0
    if (!text || !text.trim()) return { ...base, ok: false, status: 'empty', message: '응답이 비어 있습니다.', latencyMs, fix: '다른 모델로 바꾸거나 잠시 후 다시 시도하세요.' }
    return { ...base, ok: true, status: 'ok', latencyMs, message: `정상 — 응답을 받았습니다 (${(latencyMs / 1000).toFixed(1)}초).` }
  } catch (err) {
    return classifyError(base, err instanceof Error ? err.message : String(err))
  }
}

export async function diagnoseAi(): Promise<AiDiagnosis> {
  const cfg = await getAiClientConfig()
  const base = { provider: cfg.provider, providerLabel: cfg.providerLabel, model: cfg.model }
  if (!cfg.enabled) {
    return { ...base, ok: false, status: 'disabled', message: 'AI 기능이 꺼져 있습니다.', fix: '설정 > AI 에서 AI 를 켜세요.' }
  }
  const s = getSetting('ai')

  // Ollama: 연결 + 모델 설치 여부를 먼저 확인(가장 흔한 실패 — 모델 미설치).
  if (cfg.provider === 'ollama') {
    let tags: string[] = []
    try {
      const url = s.ollamaUrl.replace(/\/$/, '') + '/api/tags'
      const r = await fetchWithTimeout(url, 4000)
      const j = await r.json() as { models?: Array<{ name?: string }> }
      tags = Array.isArray(j.models) ? j.models.map((mm) => mm.name ?? '').filter(Boolean) : []
    } catch {
      return { ...base, ok: false, status: 'not-connected', message: 'Ollama 에 연결하지 못했습니다.', detail: `${s.ollamaUrl} 응답 없음`, fix: 'Ollama 앱을 켜거나 터미널에서 `ollama serve` 를 실행하세요. 주소가 다르면 설정 > AI 에서 Ollama 주소를 확인하세요.' }
    }
    // Ollama /api/tags 는 'llama3.2:latest' 처럼 :tag 접미사를 포함 — 설정값이 태그 없는 'llama3.2' 여도
    // Ollama 는 :latest 로 해석해 실제로 동작하므로 접미사를 무시하고 매칭한다(오진 방지).
    const modelInstalled = tags.some((t) => t === s.ollamaModel || t.split(':')[0] === s.ollamaModel)
    if (tags.length && !modelInstalled) {
      return {
        ...base, ok: false, status: 'model-missing', installedModels: tags,
        message: `설정한 모델 '${s.ollamaModel}' 이(가) 설치돼 있지 않습니다.`,
        fix: `아래 설치된 모델 중 하나로 바꾸거나, 터미널에서 \`ollama pull ${s.ollamaModel}\` 로 설치하세요.`,
      }
    }
    const res = await pingModel(base)
    if (res.installedModels === undefined && tags.length) res.installedModels = tags
    return res
  }

  // 클라우드: 키 없으면 즉시 안내.
  if (!isCliProvider(cfg.provider) && !cfg.hasKey) {
    return { ...base, ok: false, status: 'no-key', message: `${cfg.providerLabel} API 키가 없습니다.`, fix: '설정 > AI 에서 API 키를 입력하세요.' }
  }

  // CLI + 클라우드: 실제 한 번 호출로 확인.
  return await pingModel(base)
}
