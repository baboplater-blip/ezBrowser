import { net } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

// AI 제공자 추상화 — Claude(Anthropic) / OpenAI / 로컬 Ollama.
// 셋 다 스트리밍(토큰 단위)으로 응답을 흘려보낸다. main 프로세스에서 net.request 로 직접 호출하므로
// CORS 제약이 없다(콘텐츠 페이지 fetch 와 다름 — 번역 모듈 주석 참고).
//
// 에이전트 라운드(다음)에서 tool-use(함수 호출)를 얹을 때, 요청 body 빌더가 제공자별로 분리돼 있어
// 여기 buildBody 에 tools/tool_choice 만 추가하면 되도록 설계.

export type AiProviderId = 'anthropic' | 'openai' | 'ollama' | 'google' | 'claude-code' | 'codex' | 'gemini-cli'
export type AiRole = 'user' | 'assistant'
export interface AiMessage { role: AiRole; content: string }

export interface AiRequest {
  provider: AiProviderId
  model: string
  system: string
  messages: AiMessage[]
  apiKey?: string        // anthropic / openai
  baseUrl?: string       // ollama (예: http://localhost:11434)
  maxTokens: number
  image?: string         // 비전 — 마지막 사용자 메시지에 붙일 스크린샷(base64 PNG, data: 접두사 없음)
}

// 마지막 user 메시지의 인덱스(스크린샷은 여기에 붙인다).
function lastUserIndex(msgs: AiMessage[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === 'user') return i
  return -1
}

// ===== 비전: 스크린샷을 마지막 user 메시지에 제공자별 포맷으로 첨부 =====
function anthropicMessages(req: AiRequest): unknown[] {
  const li = req.image ? lastUserIndex(req.messages) : -1
  return req.messages.map((m, i) => (i === li
    ? { role: 'user', content: [{ type: 'text', text: m.content }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: req.image } }] }
    : { role: m.role, content: m.content }))
}
function openaiMessages(req: AiRequest): unknown[] {
  const li = req.image ? lastUserIndex(req.messages) : -1
  return [{ role: 'system', content: req.system }, ...req.messages.map((m, i) => (i === li
    ? { role: 'user', content: [{ type: 'text', text: m.content }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + req.image } }] }
    : { role: m.role, content: m.content }))]
}
function ollamaMessages(req: AiRequest): unknown[] {
  const li = req.image ? lastUserIndex(req.messages) : -1
  return [{ role: 'system', content: req.system }, ...req.messages.map((m, i) => (i === li
    ? { role: 'user', content: m.content, images: [req.image] }
    : { role: m.role, content: m.content }))]
}
function googleContents(req: AiRequest): unknown[] {
  const li = req.image ? lastUserIndex(req.messages) : -1
  return req.messages.map((m, i) => {
    const parts: unknown[] = [{ text: m.content }]
    if (i === li) parts.push({ inline_data: { mime_type: 'image/png', data: req.image } })
    return { role: m.role === 'assistant' ? 'model' : 'user', parts }
  })
}

// 비전 지원 여부 — API 3종은 항상, Ollama 는 비전 모델명일 때, CLI 는 미지원(텍스트 전용).
const OLLAMA_VISION_MODELS = /llava|vision|[-_]vl\b|qwen2\.?5?-?vl|minicpm-?v|moondream|bakllava|gemma3|llama-?4|pixtral|granite3\.2-vision/i
export function supportsVision(provider: AiProviderId, model: string): boolean {
  if (provider === 'anthropic' || provider === 'openai' || provider === 'google') return true
  if (provider === 'claude-code') return true // CLI 이미지 경로 주입으로 비전 지원(claude 가 파일을 읽음 — 검증됨)
  if (provider === 'ollama') return OLLAMA_VISION_MODELS.test(model)
  return false // codex/gemini-cli 는 미검증 → 미지원(텍스트 전용)
}

export interface AiStreamHandlers {
  onDelta: (text: string) => void
  onDone: (full: string) => void
  onError: (message: string) => void
}

export interface AiStreamHandle {
  cancel(): void
}

const REQUEST_TIMEOUT_MS = 120_000

interface Endpoint {
  url: string
  headers: Record<string, string>
  body: unknown
  // 한 줄(line)에서 델타 텍스트를 뽑는다. 반환: { text?, done? } | null(무시)
  parseLine: (line: string) => { text?: string; done?: boolean } | null
}

function anthropicEndpoint(req: AiRequest): Endpoint {
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'content-type': 'application/json',
      'x-api-key': req.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: anthropicMessages(req),
      stream: true,
    },
    parseLine: (line) => {
      if (!line.startsWith('data:')) return null
      const payload = line.slice(5).trim()
      if (!payload) return null
      try {
        const obj = JSON.parse(payload) as {
          type?: string
          delta?: { type?: string; text?: string }
          error?: { message?: string }
        }
        if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') {
          return { text: obj.delta.text ?? '' }
        }
        if (obj.type === 'message_stop') return { done: true }
        if (obj.type === 'error') throw new Error(obj.error?.message ?? 'stream error')
        return null
      } catch (err) {
        if (err instanceof SyntaxError) return null
        throw err
      }
    },
  }
}

function openaiEndpoint(req: AiRequest): Endpoint {
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${req.apiKey ?? ''}`,
    },
    body: {
      model: req.model,
      messages: openaiMessages(req),
      max_tokens: req.maxTokens,
      stream: true,
    },
    parseLine: (line) => {
      if (!line.startsWith('data:')) return null
      const payload = line.slice(5).trim()
      if (!payload) return null
      if (payload === '[DONE]') return { done: true }
      try {
        const obj = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>
        }
        const text = obj.choices?.[0]?.delta?.content
        return text ? { text } : null
      } catch {
        return null
      }
    },
  }
}

function ollamaEndpoint(req: AiRequest): Endpoint {
  const base = (req.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '')
  return {
    url: `${base}/api/chat`,
    headers: { 'content-type': 'application/json' },
    body: {
      model: req.model,
      messages: ollamaMessages(req),
      stream: true,
    },
    // Ollama 는 SSE 가 아니라 NDJSON — 한 줄이 통째로 JSON.
    parseLine: (line) => {
      const trimmed = line.trim()
      if (!trimmed) return null
      try {
        const obj = JSON.parse(trimmed) as {
          message?: { content?: string }
          done?: boolean
          error?: string
        }
        if (obj.error) throw new Error(obj.error)
        const out: { text?: string; done?: boolean } = {}
        if (obj.message?.content) out.text = obj.message.content
        if (obj.done) out.done = true
        return out.text || out.done ? out : null
      } catch (err) {
        if (err instanceof SyntaxError) return null
        throw err
      }
    },
  }
}

function googleEndpoint(req: AiRequest): Endpoint {
  // Google Gemini (Generative Language API). role 은 user/model, system 은 systemInstruction 로 분리.
  // ?alt=sse 로 SSE 스트리밍(`data:` 라인). 스트림 종료 마커는 없고 연결 종료로 완료.
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`,
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': req.apiKey ?? '',
    },
    body: {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: googleContents(req),
      generationConfig: { maxOutputTokens: req.maxTokens },
    },
    parseLine: (line) => {
      if (!line.startsWith('data:')) return null
      const payload = line.slice(5).trim()
      if (!payload) return null
      try {
        const obj = JSON.parse(payload) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
          error?: { message?: string }
        }
        if (obj.error) throw new Error(obj.error.message ?? 'stream error')
        const parts = obj.candidates?.[0]?.content?.parts
        const text = parts?.map((p) => p.text ?? '').join('') ?? ''
        return text ? { text } : null
      } catch (err) {
        if (err instanceof SyntaxError) return null
        throw err
      }
    },
  }
}

function endpointFor(req: AiRequest): Endpoint {
  switch (req.provider) {
    case 'anthropic': return anthropicEndpoint(req)
    case 'openai': return openaiEndpoint(req)
    case 'ollama': return ollamaEndpoint(req)
    case 'google': return googleEndpoint(req)
    case 'claude-code': case 'codex': case 'gemini-cli': throw new Error('CLI 제공자는 HTTP 엔드포인트가 아닙니다')
  }
}

// ===== 구독/로컬 CLI 제공자 — 로컬 에이전트 CLI 를 백엔드로 =====
// 종량제 API 대신 구독으로 구동: Claude Code(Claude Pro/Max) / Codex(ChatGPT) / Gemini CLI(Google).
// API 키 불필요 — 인증은 각 CLI 가 자체 처리(사용자가 한 번 로그인). baseUrl 에 CLI 실행 경로를 싣는다.
// 네이티브 tool-use 미지원 → 에이전트는 JSON 프로토콜 사용.

function renderCliPrompt(req: AiRequest, imgPath?: string): string {
  const parts: string[] = []
  if (req.system) parts.push(req.system, '')
  // 화면 인식(비전) — 스크린샷을 파일로 저장하고, claude 가 그 파일을 읽어 화면을 보게 한다.
  if (imgPath) parts.push('## 화면 스크린샷', `먼저 아래 이미지 파일을 열어(Read) 현재 화면을 눈으로 확인한 뒤, 요소 목록과 함께 판단하세요:\n${imgPath}`, '')
  for (const m of req.messages) {
    parts.push(m.role === 'user' ? '## 사용자' : '## 어시스턴트', m.content, '')
  }
  parts.push('## 어시스턴트') // 응답 유도
  return parts.join('\n')
}

// CLI 별 실행 스펙. mode='stdout' 이면 표준출력을 스트리밍, 'outfile' 이면 최종 답을 파일에서 읽는다(codex).
interface CliSpec { name: string; defaultBin: string; mode: 'stdout' | 'outfile'; args: (model: string, outFile: string) => string[] }

function cliSpecFor(provider: AiProviderId): CliSpec | null {
  switch (provider) {
    case 'claude-code':
      return { name: 'Claude Code(claude)', defaultBin: 'claude', mode: 'stdout',
        args: (model) => ['-p', '--output-format', 'text', ...(model ? ['--model', model] : [])] }
    case 'codex':
      // codex exec 는 에이전트 활동을 stdout 에 쏟으므로 최종 답만 --output-last-message 파일에서 읽는다.
      return { name: 'Codex(codex)', defaultBin: 'codex', mode: 'outfile',
        args: (model, out) => ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-last-message', out, ...(model ? ['-m', model] : []), '-'] }
    case 'gemini-cli':
      return { name: 'Gemini CLI(gemini)', defaultBin: 'gemini', mode: 'stdout',
        args: (model) => [...(model ? ['-m', model] : [])] }
    default: return null
  }
}

function cliErrorMessage(spec: CliSpec, e: NodeJS.ErrnoException | null, stderr: string): string {
  const hint = `\n\n(${spec.name} 이(가) 설치돼 있고 구독/계정으로 로그인됐는지 확인하세요. 설정 > AI 에서 실행 경로·모델을 지정할 수 있습니다.)`
  if (e && e.code === 'ENOENT') return `${spec.name} CLI 를 찾을 수 없습니다.${hint}`
  const detail = (stderr || (e ? e.message : '')).slice(0, 400).trim()
  return `${spec.name} 실행 오류.${detail ? '\n' + detail : ''}${hint}`
}

function runCli(req: AiRequest, handlers: AiStreamHandlers): AiStreamHandle {
  const spec = cliSpecFor(req.provider)
  if (!spec) { handlers.onError('알 수 없는 CLI 제공자'); return { cancel() { /* noop */ } } }
  let finished = false
  let full = ''
  let stderr = ''
  let child: ChildProcess | null = null
  let outFile = ''
  let imgFile = '' // 비전 — 스크린샷 임시 PNG(claude 가 읽음). 종료 시 삭제.
  const cleanupFile = (): void => {
    if (outFile) { try { unlinkSync(outFile) } catch { /* ignore */ } }
    if (imgFile) { try { unlinkSync(imgFile) } catch { /* ignore */ } }
  }
  const finish = (fn: () => void): void => { if (finished) return; finished = true; clearTimeout(timer); fn() }
  const timer = setTimeout(() => {
    try { child?.kill() } catch { /* ignore */ }
    cleanupFile()
    finish(() => handlers.onError('시간 초과 (120초). 다시 시도하세요.'))
  }, REQUEST_TIMEOUT_MS)
  try {
    const bin = (req.baseUrl && req.baseUrl.trim()) ? req.baseUrl.trim() : spec.defaultBin
    if (spec.mode === 'outfile') outFile = join(tmpdir(), `bb-cli-${randomUUID()}.txt`)
    // 비전: claude-code 는 이미지를 임시 PNG 로 저장해 경로를 프롬프트에 넣으면 파일을 읽어 화면을 본다.
    if (req.image && req.provider === 'claude-code') {
      imgFile = join(tmpdir(), `bb-shot-${randomUUID()}.png`)
      try { writeFileSync(imgFile, Buffer.from(req.image, 'base64')) } catch { imgFile = '' }
    }
    const args = spec.args((req.model ?? '').trim(), outFile)
    // Windows 의 CLI 는 .cmd 셰임이라 shell 로 해석. 프롬프트는 args 가 아니라 stdin 으로(주입·길이 안전).
    // 비전: claude 는 작업 디렉터리 밖 파일 읽기를 막으므로, 스크린샷이 있을 때는 그 임시 폴더를 cwd 로 준다.
    const spawnOpts: Parameters<typeof spawn>[2] = { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' }
    if (imgFile) spawnOpts.cwd = dirname(imgFile)
    child = spawn(bin, args, spawnOpts)
    child.stdout?.on('data', (c: Buffer) => { if (finished) return; const t = c.toString('utf8'); if (spec.mode === 'stdout') { full += t; handlers.onDelta(t) } })
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
    child.on('error', (e) => { cleanupFile(); finish(() => handlers.onError(cliErrorMessage(spec, e as NodeJS.ErrnoException, stderr))) })
    child.on('close', (code) => {
      if (spec.mode === 'outfile') {
        let msg = ''
        try { msg = readFileSync(outFile, 'utf8') } catch { /* 파일 없음 = 실패 */ }
        cleanupFile()
        if (msg.trim()) { handlers.onDelta(msg); finish(() => handlers.onDone(msg)) }
        else finish(() => handlers.onError(cliErrorMessage(spec, null, stderr || `종료 코드 ${code}`)))
      } else {
        if (code === 0 || full.trim()) finish(() => handlers.onDone(full))
        else finish(() => handlers.onError(cliErrorMessage(spec, null, stderr || `종료 코드 ${code}`)))
      }
    })
    try { child.stdin?.write(renderCliPrompt(req, imgFile || undefined)); child.stdin?.end() } catch { /* child.on('error') 가 처리 */ }
  } catch (err) {
    cleanupFile()
    finish(() => handlers.onError(err instanceof Error ? err.message : String(err)))
  }
  return {
    cancel(): void {
      finished = true
      clearTimeout(timer)
      try { child?.kill() } catch { /* ignore */ }
      cleanupFile()
    },
  }
}

export function isCliProvider(provider: AiProviderId): provider is 'claude-code' | 'codex' | 'gemini-cli' {
  return provider === 'claude-code' || provider === 'codex' || provider === 'gemini-cli'
}

// CLI 제공자의 실행 경로 설정 키(baseUrl 로 전달) — 호출부에서 사용.
export function cliPathSettingKey(provider: AiProviderId): 'claudeCodePath' | 'codexPath' | 'geminiCliPath' | null {
  if (provider === 'claude-code') return 'claudeCodePath'
  if (provider === 'codex') return 'codexPath'
  if (provider === 'gemini-cli') return 'geminiCliPath'
  return null
}

function friendlyError(provider: AiProviderId, status: number, body: string): string {
  let detail = body.slice(0, 500)
  try {
    const obj = JSON.parse(body) as { error?: { message?: string } | string }
    if (typeof obj.error === 'string') detail = obj.error
    else if (obj.error?.message) detail = obj.error.message
  } catch { /* body 그대로 사용 */ }
  if (status === 401 || status === 403) {
    return `인증 실패 (${status}). API 키가 올바른지 설정에서 확인하세요.\n${detail}`
  }
  if (status === 404) {
    return `모델을 찾을 수 없습니다 (404). 설정의 모델 이름을 확인하세요.\n${detail}`
  }
  if (provider === 'google' && status === 400) {
    return `요청 오류 (400). API 키 또는 모델 이름을 확인하세요.\n${detail}`
  }
  if (status === 429) {
    return `요청 한도 초과 (429). 잠시 후 다시 시도하세요.\n${detail}`
  }
  if (provider === 'ollama' && (status === 0 || status >= 500)) {
    return `로컬 Ollama 서버에 연결할 수 없습니다. Ollama 가 실행 중인지, 모델이 설치됐는지 확인하세요.\n${detail}`
  }
  return `AI 요청 실패 (${status}).\n${detail}`
}

export function streamChat(req: AiRequest, handlers: AiStreamHandlers): AiStreamHandle {
  if (isCliProvider(req.provider)) return runCli(req, handlers)
  const ep = endpointFor(req)
  let cancelled = false
  let full = ''
  let buffer = ''
  let finished = false
  let request: Electron.ClientRequest | null = null

  const finish = (fn: () => void): void => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    fn()
  }

  const timer = setTimeout(() => {
    if (finished) return
    try { request?.abort() } catch { /* ignore */ }
    finish(() => handlers.onError('시간 초과 (120초). 다시 시도하세요.'))
  }, REQUEST_TIMEOUT_MS)

  try {
    request = net.request({ url: ep.url, method: 'POST' })
    for (const [k, v] of Object.entries(ep.headers)) request.setHeader(k, v)

    request.on('response', (resp) => {
      const status = resp.statusCode ?? 0
      const errorChunks: Buffer[] = []

      if (status < 200 || status >= 300) {
        resp.on('data', (c: Buffer) => errorChunks.push(c))
        resp.on('end', () => {
          finish(() => handlers.onError(friendlyError(req.provider, status, Buffer.concat(errorChunks).toString('utf8'))))
        })
        // 에러 본문 수신 중 연결이 끊기면 'error' 이벤트가 리스너 없이 throw 되므로 반드시 구독한다.
        resp.on('error', (err: Error) => finish(() => handlers.onError(err.message)))
        return
      }

      const processLine = (line: string): void => {
        let parsed: { text?: string; done?: boolean } | null
        try {
          parsed = ep.parseLine(line)
        } catch (err) {
          finish(() => handlers.onError(err instanceof Error ? err.message : String(err)))
          try { request?.abort() } catch { /* ignore */ }
          return
        }
        if (!parsed) return
        if (parsed.text) {
          full += parsed.text
          handlers.onDelta(parsed.text)
        }
        if (parsed.done) {
          finish(() => handlers.onDone(full))
          try { request?.abort() } catch { /* ignore */ }
        }
      }

      resp.on('data', (chunk: Buffer) => {
        if (finished) return
        buffer += chunk.toString('utf8')
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          processLine(line)
          if (finished) return
        }
      })
      resp.on('end', () => {
        if (buffer.trim()) processLine(buffer)
        finish(() => handlers.onDone(full))
      })
      resp.on('error', (err: Error) => {
        finish(() => handlers.onError(err.message))
      })
    })

    request.on('error', (err: Error) => {
      if (cancelled) return
      finish(() => handlers.onError(
        req.provider === 'ollama'
          ? `로컬 Ollama 서버 연결 실패. 실행 중인지 확인하세요.\n${err.message}`
          : err.message,
      ))
    })

    request.write(JSON.stringify(ep.body))
    request.end()
  } catch (err) {
    finish(() => handlers.onError(err instanceof Error ? err.message : String(err)))
  }

  return {
    cancel(): void {
      cancelled = true
      finished = true
      clearTimeout(timer)
      try { request?.abort() } catch { /* ignore */ }
    },
  }
}

// 비스트리밍 1회 호출 — streamChat 을 그대로 재사용해 전체 응답 텍스트를 모아 반환.
// 에이전트 루프의 각 스텝(이산 결정)에 사용. handle 을 통해 취소 가능.
export function chatOnce(req: AiRequest): { promise: Promise<string>; cancel(): void } {
  let handle: AiStreamHandle | null = null
  let acc = ''
  let settle: ((v: string) => void) | null = null
  const promise = new Promise<string>((resolve, reject) => {
    settle = resolve
    handle = streamChat(req, {
      onDelta: (t) => { acc += t },
      onDone: (full) => resolve(full || acc),
      onError: (msg) => reject(new Error(msg)),
    })
  })
  return {
    promise,
    // 취소 시 스트림을 멈추고 프로미스를 즉시 resolve(누적분) 한다 — 그러지 않으면
    // streamChat.cancel 이 어떤 핸들러도 부르지 않아 이 프로미스가 영원히 settle 되지 않고
    // 에이전트 루프의 await 가 무한 대기한다(중단 버튼 먹통의 근본 원인).
    cancel: () => {
      try { handle?.cancel() } catch { /* ignore */ }
      if (settle) { const s = settle; settle = null; s(acc) }
    },
  }
}

// ===== 네이티브 tool-use(구조화 함수 호출) =====
// 지원 제공자(Claude/OpenAI/Gemini + tool-calling 지원 Ollama 모델)에서 에이전트가 JSON 프롬프트 대신
// 구조화된 함수 호출로 행동을 선택하게 한다(더 안정적). 비스트리밍 1회 호출 — 전체 응답을 모아 파싱.

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { name: string; args: Record<string, unknown> }
export interface ToolChatResult { toolCalls: ToolCall[]; text: string }

// Ollama 는 모델이 tool-calling 을 지원해야 tools 파라미터가 먹힌다(미지원 모델은 무시하거나 에러).
// 이름 기반 allowlist — 확실히 지원하는 계열만. 나머지는 JSON 프로토콜로 폴백.
const OLLAMA_TOOL_MODELS = /qwen|llama-?3\.[1-9]|llama3\.[1-9]|mistral|mixtral|gpt-oss|firefunction|command-?r|hermes|granite|nemotron|smollm2/i

export function supportsNativeTools(provider: AiProviderId, model: string): boolean {
  if (provider === 'ollama') return OLLAMA_TOOL_MODELS.test(model)
  if (isCliProvider(provider)) return false // CLI 텍스트 출력 → 에이전트는 JSON 프로토콜로
  return true // anthropic / openai / google 는 함수 호출 지원
}

function toolEndpoint(req: AiRequest, tools: ToolSpec[]): { url: string; headers: Record<string, string>; body: unknown } {
  const oaiTools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  switch (req.provider) {
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'content-type': 'application/json', 'x-api-key': req.apiKey ?? '', 'anthropic-version': '2023-06-01' },
        body: {
          model: req.model, max_tokens: req.maxTokens, system: req.system,
          messages: anthropicMessages(req),
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        },
      }
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey ?? ''}` },
        body: { model: req.model, messages: openaiMessages(req), max_tokens: req.maxTokens, tools: oaiTools, tool_choice: 'auto' },
      }
    case 'ollama': {
      const base = (req.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '')
      return {
        url: `${base}/api/chat`,
        headers: { 'content-type': 'application/json' },
        body: { model: req.model, messages: ollamaMessages(req), stream: false, tools: oaiTools },
      }
    }
    case 'google':
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': req.apiKey ?? '' },
        body: {
          systemInstruction: { parts: [{ text: req.system }] },
          contents: googleContents(req),
          tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }],
          generationConfig: { maxOutputTokens: req.maxTokens },
        },
      }
    case 'claude-code': case 'codex': case 'gemini-cli': throw new Error('CLI 제공자는 네이티브 tool-use 를 지원하지 않습니다(JSON 프로토콜 사용)')
  }
}

function safeParseArgs(s: unknown): Record<string, unknown> {
  if (s && typeof s === 'object') return s as Record<string, unknown>
  if (typeof s === 'string') { try { return JSON.parse(s) as Record<string, unknown> } catch { return {} } }
  return {}
}

// 일부 모델(예: Ollama 의 qwen2.5-coder)은 구조화된 tool_calls 대신 content 에 `{"name":..,"arguments":..}`
// JSON 텍스트로 함수 호출을 내보낸다. 그 경우를 폴백으로 파싱한다(```json 펜스·<tool_call> 태그 제거).
function extractToolCallFromText(text: string, knownNames?: Set<string>): ToolCall | null {
  const s = text.trim().replace(/<\/?tool_call>/gi, '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0, end = -1, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return null
  try {
    const obj = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>
    const name = typeof obj.name === 'string' ? obj.name : undefined
    if (!name) return null
    // 실제 도구 이름일 때만 채택 — 모델이 데이터로 인용한 {"name":"홍길동"} 같은 평범한 JSON 을
    // 가짜 tool_call 로 오인해 모델의 진짜 텍스트를 버리는 것을 막는다.
    if (knownNames && !knownNames.has(name)) return null
    return { name, args: safeParseArgs(obj.arguments ?? obj.parameters ?? obj.args) }
  } catch { return null }
}

function parseToolResponse(provider: AiProviderId, text: string, knownNames?: Set<string>): ToolChatResult {
  const json = JSON.parse(text) as Record<string, unknown>
  let toolCalls: ToolCall[] = []
  let out = ''
  if (provider === 'anthropic') {
    const content = (json.content as Array<Record<string, unknown>>) ?? []
    toolCalls = content.filter((b) => b.type === 'tool_use').map((b) => ({ name: String(b.name ?? ''), args: safeParseArgs(b.input) }))
    out = content.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('')
  } else if (provider === 'openai' || provider === 'ollama') {
    const choicesMsg = provider === 'openai'
      ? ((json.choices as Array<{ message?: Record<string, unknown> }>)?.[0]?.message ?? {})
      : ((json.message as Record<string, unknown>) ?? {})
    const raw = (choicesMsg.tool_calls as Array<{ function?: { name?: string; arguments?: unknown } }>) ?? []
    toolCalls = raw.map((tc) => ({ name: String(tc.function?.name ?? ''), args: safeParseArgs(tc.function?.arguments) }))
    out = String(choicesMsg.content ?? '')
  } else {
    // google
    const parts = ((json.candidates as Array<{ content?: { parts?: Array<Record<string, unknown>> } }>)?.[0]?.content?.parts) ?? []
    toolCalls = parts.filter((p) => p.functionCall).map((p) => {
      const fc = p.functionCall as { name?: string; args?: unknown }
      return { name: String(fc.name ?? ''), args: safeParseArgs(fc.args) }
    })
    out = parts.filter((p) => typeof p.text === 'string').map((p) => String(p.text)).join('')
  }
  // 구조화 tool_calls 가 없으면 content 안의 함수-호출 JSON 을 폴백 파싱
  if (toolCalls.length === 0 && out) {
    const tc = extractToolCallFromText(out, knownNames)
    if (tc) return { toolCalls: [tc], text: '' }
  }
  return { toolCalls, text: out }
}

export function chatWithTools(req: AiRequest, tools: ToolSpec[]): { promise: Promise<ToolChatResult>; cancel(): void } {
  const ep = toolEndpoint(req, tools)
  const knownNames = new Set(tools.map((t) => t.name))
  let request: Electron.ClientRequest | null = null
  let aborted = false
  // 취소가 프로미스를 즉시 settle 할 수 있도록 done 을 밖으로 노출한다(그러지 않으면 취소 후
  // 120초 타임아웃까지 좀비로 남았다가 엉뚱한 "시간 초과" 에러를 낸다).
  let settleCancel: (() => void) | null = null
  const promise = new Promise<ToolChatResult>((resolve, reject) => {
    let settled = false
    const done = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); fn() }
    const timer = setTimeout(() => { try { request?.abort() } catch { /* ignore */ }; done(() => reject(new Error('시간 초과 (120초). 다시 시도하세요.'))) }, REQUEST_TIMEOUT_MS)
    settleCancel = () => done(() => resolve({ toolCalls: [], text: '' }))
    try {
      request = net.request({ url: ep.url, method: 'POST' })
      for (const [k, v] of Object.entries(ep.headers)) request.setHeader(k, v)
      request.on('response', (resp) => {
        const status = resp.statusCode ?? 0
        const chunks: Buffer[] = []
        resp.on('data', (c: Buffer) => chunks.push(c))
        resp.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (status < 200 || status >= 300) { done(() => reject(new Error(friendlyError(req.provider, status, body)))); return }
          try { const r = parseToolResponse(req.provider, body, knownNames); done(() => resolve(r)) }
          catch (err) { done(() => reject(err instanceof Error ? err : new Error(String(err)))) }
        })
        resp.on('error', (err: Error) => done(() => reject(err)))
      })
      request.on('error', (err: Error) => { if (!aborted) done(() => reject(err)) })
      request.write(JSON.stringify(ep.body))
      request.end()
    } catch (err) { done(() => reject(err instanceof Error ? err : new Error(String(err)))) }
  })
  return { promise, cancel: () => { aborted = true; try { request?.abort() } catch { /* ignore */ }; settleCancel?.() } }
}
