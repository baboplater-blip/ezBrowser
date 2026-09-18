import { spawn } from 'node:child_process'
import { getSetting, setNestedSetting } from '../../storage/settings'
import { hasAiKey } from './keys'
import { isCliProvider, cliPathSettingKey, type AiProviderId } from './providers'
import { diagnoseAi, type AiDiagnosis } from './diagnose'

// AI 제공자 자동 탐지 — "이 컴퓨터에서 지금 바로 쓸 수 있는 것"을 찾아 사용자에게 보여준다.
//
// 왜 (2026-09-18): 기본 제공자는 anthropic(API 키 필요)인데, 실제로는 이미 설치·로그인된 CLI
// (claude/codex/gemini)나 로컬 Ollama 가 있는 경우가 많다. 그런데 제품은 첫 화면에서 "API 키가
// 필요합니다" 만 말하고 끝나, **쓸 수 있는 길이 있는데도 막힌 것처럼 보였다.**
// 여기서 실제로 무엇이 있는지 재고, 한 번 눌러 연결할 수 있게 한다.
//
// 비용 주의: 탐지는 **요금이 발생하지 않는 것만** 한다 — CLI 는 `--version`(모델 호출 아님),
// Ollama 는 로컬 /api/tags, 키 제공자는 디스크의 키 유무만. 실제 모델 호출은 사용자가
// '연결'을 누른 뒤의 진단(diagnoseAi) 한 번뿐이다.

export type ProviderCost = 'subscription' | 'free-local' | 'free-tier' | 'paid-key'

export interface ProviderCandidate {
  id: AiProviderId
  label: string
  kind: 'cli' | 'local' | 'key'
  /** 지금 바로 연결을 시도할 수 있는가(로그인 여부는 연결 시점의 진단이 확인한다). */
  ready: boolean
  cost: ProviderCost
  /** 왜 준비됐는지 / 무엇이 없는지 — 사용자에게 그대로 보여주는 한 줄. */
  detail: string
  /** 준비되지 않았을 때 사용자가 할 일. */
  fix?: string
  /** ollama: 실제 설치된 모델. 연결 시 첫 모델을 기본값으로 쓴다. */
  models?: string[]
}

export interface ProviderDetection {
  at: number
  current: AiProviderId
  currentReady: boolean
  candidates: ProviderCandidate[]
}

const LABEL: Record<AiProviderId, string> = {
  anthropic: 'Claude (Anthropic API)',
  openai: 'OpenAI API',
  google: 'Google Gemini API',
  ollama: 'Ollama (로컬)',
  'claude-code': 'Claude Code CLI',
  codex: 'Codex CLI',
  'gemini-cli': 'Gemini CLI',
}

const CLI_BIN: Record<'claude-code' | 'codex' | 'gemini-cli', string> = {
  'claude-code': 'claude', codex: 'codex', 'gemini-cli': 'gemini',
}

const PROBE_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 60_000

let cache: ProviderDetection | null = null

/**
 * CLI 바이너리가 실행 가능한지 `--version` 으로 확인한다. 모델을 호출하지 않으므로 요금·한도 소모 0.
 * 실행 방식(shell·windowsHide)은 providers.ts 의 runCli 과 같아야 한다 — 다르면 "탐지는 됐는데 실행은 실패"가 난다.
 */
function probeCli(bin: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let done = false
    let out = ''
    const finish = (ok: boolean, detail: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.kill() } catch { /* 이미 종료 */ }
      resolve({ ok, detail })
    }
    const timer = setTimeout(() => finish(false, '응답 없음(시간 초과)'), PROBE_TIMEOUT_MS)
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true,
      })
    } catch {
      clearTimeout(timer)
      resolve({ ok: false, detail: '실행할 수 없음' })
      return
    }
    child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8') })
    child.stderr?.on('data', (c: Buffer) => { out += c.toString('utf8') })
    child.on('error', () => finish(false, '설치되어 있지 않음'))
    child.on('close', (code) => {
      const v = out.trim().split(/\r?\n/)[0]?.slice(0, 60) ?? ''
      finish(code === 0, code === 0 ? (v || '설치됨') : `종료 코드 ${code}`)
    })
  })
}

/** 로컬 Ollama 서버와 설치된 모델. 로컬 HTTP 라 비용 없음. */
async function probeOllama(url: string): Promise<{ ok: boolean; models: string[]; detail: string }> {
  const base = (url || 'http://localhost:11434').replace(/\/+$/, '')
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 4_000)
  try {
    const res = await fetch(`${base}/api/tags`, { signal: ctrl.signal })
    if (!res.ok) return { ok: false, models: [], detail: `서버 응답 ${res.status}` }
    const body = await res.json() as { models?: Array<{ name?: string }> }
    const models = (body.models ?? []).map((m) => String(m.name ?? '')).filter(Boolean)
    return { ok: models.length > 0, models, detail: models.length > 0 ? `모델 ${models.length}개 설치됨` : '서버는 켜져 있으나 설치된 모델이 없음' }
  } catch {
    return { ok: false, models: [], detail: '서버에 연결할 수 없음' }
  } finally { clearTimeout(t) }
}

export async function detectProviders(opts: { force?: boolean } = {}): Promise<ProviderDetection> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache

  const s = getSetting('ai')
  const cliIds: Array<'claude-code' | 'codex' | 'gemini-cli'> = ['claude-code', 'codex', 'gemini-cli']

  const [cliResults, ollama, keyFlags] = await Promise.all([
    Promise.all(cliIds.map(async (id) => {
      const pathKey = cliPathSettingKey(id)
      const configured = pathKey ? String(s[pathKey] ?? '').trim() : ''
      return { id, ...(await probeCli(configured || CLI_BIN[id])) }
    })),
    probeOllama(s.ollamaUrl),
    Promise.all((['anthropic', 'openai', 'google'] as const).map(async (id) => ({ id, has: await hasAiKey(id) }))),
  ])

  const candidates: ProviderCandidate[] = []

  for (const r of cliResults) {
    candidates.push({
      id: r.id,
      label: LABEL[r.id],
      kind: 'cli',
      ready: r.ok,
      cost: 'subscription',
      detail: r.ok
        ? `${r.detail} — 이미 쓰고 있는 구독 계정으로 동작합니다(추가 요금 없음).`
        : `${CLI_BIN[r.id]} 명령을 찾을 수 없습니다 (${r.detail}).`,
      fix: r.ok ? undefined : `${CLI_BIN[r.id]} CLI 를 설치하고 한 번 실행해 로그인하세요. 설정 > AI 에서 실행 경로를 직접 지정할 수도 있습니다.`,
    })
  }

  candidates.push({
    id: 'ollama',
    label: LABEL.ollama,
    kind: 'local',
    ready: ollama.ok,
    cost: 'free-local',
    detail: ollama.ok ? `${ollama.detail} — 내 컴퓨터에서만 돌아가 요금도, 외부 전송도 없습니다.` : ollama.detail,
    fix: ollama.ok ? undefined : 'ollama.com 에서 설치 후 `ollama pull llama3.2` 로 모델을 하나 받으세요.',
    models: ollama.models,
  })

  for (const k of keyFlags) {
    candidates.push({
      id: k.id,
      label: LABEL[k.id],
      kind: 'key',
      ready: k.has,
      cost: k.id === 'google' ? 'free-tier' : 'paid-key',
      detail: k.has
        ? '키가 저장되어 있습니다.'
        : (k.id === 'google' ? '무료 티어 키를 발급받아 입력하면 쓸 수 있습니다.' : 'API 키를 입력하면 쓸 수 있습니다(사용한 만큼 과금).'),
      fix: k.has ? undefined : '설정 > AI 에서 키를 입력하세요.',
    })
  }

  // 권장 순서: 지금 쓸 수 있는 것 먼저, 그다음 추가 비용이 없는 것 먼저.
  const costRank: Record<ProviderCost, number> = { subscription: 0, 'free-local': 1, 'free-tier': 2, 'paid-key': 3 }
  candidates.sort((a, b) => (Number(b.ready) - Number(a.ready)) || (costRank[a.cost] - costRank[b.cost]))

  const current = s.provider
  const currentReady = isCliProvider(current) || current === 'ollama'
    ? (candidates.find((c) => c.id === current)?.ready ?? false)
    : await hasAiKey(current)

  cache = { at: Date.now(), current, currentReady, candidates }
  return cache
}

export function invalidateProviderDetection(): void { cache = null }

export interface ConnectResult {
  ok: boolean
  provider: AiProviderId
  providerLabel: string
  /** 실제 한 번 호출해 확인한 결과 — 여기서 ok 가 아니면 사용자에게 원인·해결책을 그대로 보여준다. */
  diagnosis: AiDiagnosis
}

/**
 * 제공자를 고르고 **실제로 한 번 물어봐서** 되는지 확인한다.
 * 실패해도 선택은 되돌리지 않는다 — 사용자가 고른 제공자를 그대로 두고 무엇을 고쳐야 하는지 알려주는 편이
 * "눌렀는데 아무 일도 안 일어남"보다 낫다(로그인만 하면 바로 동작하는 경우가 대부분).
 */
export async function connectProvider(id: AiProviderId, model?: string): Promise<ConnectResult> {
  const s = getSetting('ai')
  if (!s.enabled) setNestedSetting('ai.enabled', true)
  setNestedSetting('ai.provider', id)
  if (model && model.trim()) {
    const key = id === 'ollama' ? 'ai.ollamaModel'
      : id === 'claude-code' ? 'ai.claudeCodeModel'
      : id === 'codex' ? 'ai.codexModel'
      : id === 'gemini-cli' ? 'ai.geminiCliModel'
      : id === 'anthropic' ? 'ai.anthropicModel'
      : id === 'openai' ? 'ai.openaiModel'
      : 'ai.googleModel'
    setNestedSetting(key, model.trim())
  } else if (id === 'ollama') {
    // 설정된 모델이 실제로 설치돼 있지 않으면 설치된 것 중 하나로 맞춘다 — 안 그러면 첫 질문이 404 로 실패한다.
    const det = await detectProviders({ force: true })
    const installed = det.candidates.find((c) => c.id === 'ollama')?.models ?? []
    if (installed.length && !installed.includes(s.ollamaModel)) setNestedSetting('ai.ollamaModel', installed[0] as string)
  }
  invalidateProviderDetection()
  const diagnosis = await diagnoseAi()
  return { ok: diagnosis.ok, provider: id, providerLabel: LABEL[id], diagnosis }
}
