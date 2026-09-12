import { net } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
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
  // 토큰 사용량(제공자가 알려 줄 때만 — 현재 claude-code 의 json 출력). 효율 계측용, 없어도 동작.
  onUsage?: (usage: CliUsage) => void
}

export interface AiStreamHandle {
  cancel(): void
}

const REQUEST_TIMEOUT_MS = 120_000

// claude-code 에 넘기는 도구 제한. 에이전트는 CLI 의 도구가 아니라 우리 브라우저 액션으로 움직이므로 CLI 내부 도구
// 루프(파일 탐색·Bash 실행)는 ① 스텝당 수십 초·수십만 토큰을 태우고(실측: 스텝별 실행에서 캐시 읽기 192만) ② 페이지
// 내용이 프롬프트를 거쳐 사용자 PC 에서 명령을 실행하는 표면이 된다. 실측(2026-09-12, 3턴):
//   기본                → 1턴 캐시 4.1만 · 이후 턴 2.5~3.6초
//   --tools ""  / Read  → 1턴 1.1만이지만 **2턴에 12만 토큰이 새로 잡히는** CLI 특성(부적합)
//   --disallowedTools … → 1턴 2.8만 · 이후 턴 2.2~3.1초 · 신규 150 토큰 안팎 ← 채택. Read 는 남겨 비전(스크린샷)을 읽는다.
const CLAUDE_CODE_DISALLOWED_TOOLS = 'Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Agent,Task,TodoWrite,Glob,Grep'

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

// 검증 하네스가 요청 형태(URL·헤더·본문)를 키 없이 대조할 수 있도록 노출한다 — 순수 함수.
export function endpointFor(req: AiRequest): Endpoint {
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
interface CliSpec { name: string; defaultBin: string; mode: 'stdout' | 'outfile' | 'json'; args: (model: string, outFile: string) => string[] }

function cliSpecFor(provider: AiProviderId): CliSpec | null {
  switch (provider) {
    case 'claude-code':
      // json 모드: 한 줄 JSON {result, usage, session_id} — 텍스트 모드와 달리 토큰 사용량을 준다(스텝별 폴백 경로 계측).
      // (-p 는 원래 최종 결과를 한 번에 내므로 "스트리밍" 을 잃는 것은 없다.)
      return { name: 'Claude Code(claude)', defaultBin: 'claude', mode: 'json',
        args: (model) => ['-p', '--output-format', 'json', '--no-session-persistence', '--disallowedTools', CLAUDE_CODE_DISALLOWED_TOOLS, ...(model ? ['--model', model] : [])] }
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
    // 비전(스크린샷)이 없으면 Read 도 막는다 — 페이지 텍스트가 프롬프트로 들어오므로 로컬 파일 읽기 표면을 닫는다.
    if (!imgFile) { const di = args.indexOf('--disallowedTools'); if (di >= 0 && typeof args[di + 1] === 'string') args[di + 1] = `${args[di + 1]},Read` }
    // Windows 의 CLI 는 .cmd 셰임이라 shell 로 해석. 프롬프트는 args 가 아니라 stdin 으로(주입·길이 안전).
    // 비전: claude 는 작업 디렉터리 밖 파일 읽기를 막으므로, 스크린샷이 있을 때는 그 임시 폴더를 cwd 로 준다.
    // cwd 는 항상 임시 폴더 — 앱의 작업 디렉터리를 물려주면 claude 가 그 폴더의 CLAUDE.md 를 자동 로드한다
    // (실측 2026-09-12: 저장소 루트에서 실행하니 호출당 캐시 생성 약 20만 토큰). 비전 파일도 이 폴더에서 읽는다.
    const spawnOpts: Parameters<typeof spawn>[2] = { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', cwd: imgFile ? dirname(imgFile) : tmpdir(), windowsHide: true }
    child = spawn(bin, args, spawnOpts)
    // stdin 은 별도 Writable — 프로세스가 먼저 죽은 뒤 write/end 하면 EPIPE 가 스트림에서 비동기로 난다. 리스너 없으면 메인 크래시.
    child.stdin?.on('error', () => { /* 프로세스 종료 경로가 처리 */ })
    child.stdout?.on('data', (c: Buffer) => { if (finished) return; const t = c.toString('utf8'); if (spec.mode === 'stdout') { full += t; handlers.onDelta(t) } else if (spec.mode === 'json') { full += t } })
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
    child.on('error', (e) => { cleanupFile(); finish(() => handlers.onError(cliErrorMessage(spec, e as NodeJS.ErrnoException, stderr))) })
    child.on('close', (code) => {
      if (spec.mode === 'outfile') {
        let msg = ''
        try { msg = readFileSync(outFile, 'utf8') } catch { /* 파일 없음 = 실패 */ }
        cleanupFile()
        if (msg.trim()) { handlers.onDelta(msg); finish(() => handlers.onDone(msg)) }
        else finish(() => handlers.onError(cliErrorMessage(spec, null, stderr || `종료 코드 ${code}`)))
      } else if (spec.mode === 'json') {
        cleanupFile()
        // 한 줄 JSON. 파싱이 안 되면(구버전 CLI 등) 원문을 그대로 답으로 쓴다.
        let text = full
        try {
          // stdout 에 경고 줄이 섞여도 JSON 본체만 집는다(첫 '{' ~ 마지막 '}').
          const a = full.indexOf('{'); const b = full.lastIndexOf('}')
          const j = JSON.parse(a >= 0 && b > a ? full.slice(a, b + 1) : full.trim()) as Record<string, unknown>
          if (typeof j.result === 'string') text = j.result
          const u = usageFromClaude(j.usage)
          if (u && handlers.onUsage) handlers.onUsage(u)
          // is_error 면 텍스트가 있어도 오류다(한도 초과·권한 거부 안내문을 정상 답으로 쓰면 안 된다).
          if (j.is_error === true) { finish(() => handlers.onError(`Claude Code 응답 오류(${String(j.subtype ?? 'error')})${text.trim() ? ': ' + text.trim().slice(0, 300) : ''}`)); return }
        } catch { /* 텍스트로 취급 */ }
        if (text.trim() || code === 0) { handlers.onDelta(text); finish(() => handlers.onDone(text)) }
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
export function chatOnce(req: AiRequest): { promise: Promise<string>; cancel(): void; usage(): CliUsage | null } {
  let handle: AiStreamHandle | null = null
  let acc = ''
  let usage: CliUsage | null = null
  let settle: ((v: string) => void) | null = null
  const promise = new Promise<string>((resolve, reject) => {
    settle = resolve
    handle = streamChat(req, {
      onDelta: (t) => { acc += t },
      onDone: (full) => resolve(full || acc),
      onError: (msg) => reject(new Error(msg)),
      onUsage: (u) => { usage = u },
    })
  })
  return {
    promise,
    usage: () => usage,
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
// 노출 이유: 일부 모델(Ollama 계열)이 구조화 tool_calls 대신 본문에 함수 호출 JSON 을 넣는다.
// 이 폴백이 깨지면 tool 경로가 무한 관찰 루프가 되므로 회귀 검사가 필요하다.
export function extractToolCallFromText(text: string, knownNames?: Set<string>): ToolCall | null {
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

export function parseToolResponse(provider: AiProviderId, text: string, knownNames?: Set<string>): ToolChatResult {
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

// ===== CLI 세션 — 에이전트 작업 하나에 프로세스 하나 =====
//
// 왜 (2026-09-12): 에이전트가 스텝마다 `claude -p` 를 새로 띄우면 ① Node 부팅·인증·초기화 고정비가 매 스텝
// 반복되고 ② 세션이 끊겨 프롬프트 캐시가 매번 버려진다(CLI 자체 시스템 컨텍스트만 약 4.1만 토큰 — 실측).
// 그래서 작업 시작 때 프로세스 하나를 띄워 두고 스텝을 stream-json 으로 이어 보낸다. 이력은 CLI 가 보유하므로
// 스텝마다 "새 관찰"만 보내면 된다. 실측(2턴): 첫 턴 캐시 생성 40,985 → 둘째 턴 캐시 읽기 40,985 · 신규 4,748.
//
// - claude-code: `--input-format stream-json --output-format stream-json` 한 프로세스. 죽으면 `--resume <id>` 로 재개.
// - codex:       프로세스는 턴마다 뜨지만 `codex exec resume <thread_id>` 로 서버측 문맥·캐시를 잇는다.
// - gemini-cli:  세션 방식 없음 → null(호출자가 기존 스텝별 spawn 사용).
// 세션이 죽었을 때(프로세스 종료·타임아웃)는 CliSessionDead 로 알려 호출자가 재개/폴백을 결정한다 —
// 모델 오류(파싱 실패 등)와 구분하기 위해서다. 어떤 경우에도 작업이 멈추지 않는 것이 목표.

export interface CliUsage { input: number; cacheRead: number; cacheCreate: number; output: number }
export interface CliTurnInput {
  system?: string   // 첫 턴에만 — 이후 턴은 CLI 가 문맥을 갖고 있다
  text: string      // 이번 턴의 사용자 내용(관찰 등)
  image?: string    // 비전 — base64 PNG. 세션 디렉터리에 파일로 써서 경로를 알려 준다(claude 가 읽음)
}
export interface CliTurnResult { text: string; usage: CliUsage | null; sessionId: string | null }
export interface CliSession {
  readonly provider: AiProviderId
  readonly sessionId: string | null   // claude: session_id · codex: thread_id — 재개용
  readonly alive: boolean
  readonly turns: number              // 완료된 턴 수
  send(input: CliTurnInput): { promise: Promise<CliTurnResult>; cancel(): void }
  close(): void
}
export class CliSessionDead extends Error {
  constructor(msg: string) { super(msg); this.name = 'CliSessionDead' }
}
export interface CliSessionOptions { provider: AiProviderId; model: string; bin?: string; resumeId?: string | null; allowRead?: boolean /* 비전(스크린샷 읽기)일 때만 Read 허용 */ }

// 세션 방식을 지원하는 CLI 인가(설정 토글과 별개 — 능력 판정).
export function supportsCliSession(provider: AiProviderId): boolean {
  return provider === 'claude-code' || provider === 'codex'
}

// Windows 의 shell:true spawn 은 cmd.exe 가 부모라 child.kill() 로는 실제 CLI(node)가 안 죽는다 → 트리째 종료.
function killTree(child: ChildProcess | null): void {
  if (!child || child.pid == null) return
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => { /* taskkill 부재 — 무시 */ }) } catch { /* ignore */ }
  } else {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
  }
}

function renderTurnText(input: CliTurnInput, imgPath?: string): string {
  const parts: string[] = []
  if (input.system) parts.push(input.system, '')
  if (imgPath) parts.push('## 화면 스크린샷', `먼저 아래 이미지 파일을 열어(Read) 현재 화면을 눈으로 확인한 뒤, 요소 목록과 함께 판단하세요:\n${imgPath}`, '')
  if (input.system) parts.push('## 사용자')
  parts.push(input.text)
  return parts.join('\n')
}

function usageFromClaude(u: unknown): CliUsage | null {
  if (!u || typeof u !== 'object') return null
  const o = u as Record<string, unknown>
  const n = (k: string): number => (typeof o[k] === 'number' ? (o[k] as number) : 0)
  return { input: n('input_tokens'), cacheRead: n('cache_read_input_tokens'), cacheCreate: n('cache_creation_input_tokens'), output: n('output_tokens') }
}

// --- claude-code: stream-json 한 프로세스 ---
class ClaudeStreamSession implements CliSession {
  readonly provider: AiProviderId = 'claude-code'
  sessionId: string | null
  alive = false
  turns = 0
  private child: ChildProcess | null = null
  private buf = ''
  private stderr = ''
  private dir: string
  private pending: { resolve: (r: CliTurnResult) => void; reject: (e: Error) => void; text: string; timer: NodeJS.Timeout } | null = null
  private closed = false

  constructor(private opts: CliSessionOptions) {
    this.sessionId = opts.resumeId ?? null
    this.dir = join(tmpdir(), `bb-cli-${randomUUID()}`)
    try { mkdirSync(this.dir, { recursive: true }) } catch { /* 비전 파일만 영향 */ }
    this.spawnProcess()
  }

  private spawnProcess(): void {
    const bin = (this.opts.bin && this.opts.bin.trim()) ? this.opts.bin.trim() : 'claude'
    const model = (this.opts.model ?? '').trim()
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--disallowedTools', this.opts.allowRead ? CLAUDE_CODE_DISALLOWED_TOOLS : `${CLAUDE_CODE_DISALLOWED_TOOLS},Read`,
      ...(model ? ['--model', model] : []),
      ...(this.opts.resumeId ? ['--resume', this.opts.resumeId] : [])]
    // 비전 파일을 읽으려면 그 폴더가 작업 디렉터리여야 한다(claude 는 cwd 밖 파일 읽기를 막는다).
    const spawnOpts: Parameters<typeof spawn>[2] = { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', cwd: this.dir, windowsHide: true }
    try {
      this.child = spawn(bin, args, spawnOpts)
    } catch (err) {
      this.alive = false
      this.failPending(new CliSessionDead(err instanceof Error ? err.message : String(err)))
      return
    }
    this.alive = true
    this.child.stdin?.on('error', () => { /* 프로세스 종료(close) 경로가 pending 을 정리한다 */ })
    this.child.stdout?.on('data', (c: Buffer) => this.onStdout(c.toString('utf8')))
    this.child.stderr?.on('data', (c: Buffer) => { this.stderr = (this.stderr + c.toString('utf8')).slice(-2000) })
    this.child.on('error', (e) => { this.alive = false; this.failPending(new CliSessionDead(cliErrorMessage(cliSpecFor('claude-code')!, e as NodeJS.ErrnoException, this.stderr))) })
    this.child.on('close', (code) => {
      this.alive = false
      this.failPending(new CliSessionDead(`Claude Code 세션이 종료됐습니다(코드 ${code}).${this.stderr ? '\n' + this.stderr.slice(-400).trim() : ''}`))
    })
  }

  private failPending(err: Error): void {
    const p = this.pending
    if (!p) return
    this.pending = null
    clearTimeout(p.timer)
    p.reject(err)
  }

  private onStdout(chunk: string): void {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let j: Record<string, unknown>
      try { j = JSON.parse(line) as Record<string, unknown> } catch { continue }
      this.onEvent(j)
    }
  }

  private onEvent(j: Record<string, unknown>): void {
    const sid = typeof j.session_id === 'string' ? j.session_id : null
    if (sid) this.sessionId = sid
    const p = this.pending
    if (!p) return
    if (j.type === 'assistant') {
      // message.content: [{type:'text', text}] — 텍스트 블록만 누적(도구 호출 블록은 무시)
      const msg = j.message as { content?: unknown } | undefined
      const content = Array.isArray(msg?.content) ? (msg!.content as Array<Record<string, unknown>>) : []
      for (const b of content) if (b && b.type === 'text' && typeof b.text === 'string') p.text += (p.text ? '\n' : '') + b.text
      return
    }
    if (j.type === 'result') {
      this.pending = null
      clearTimeout(p.timer)
      this.turns++
      const isError = j.is_error === true || (typeof j.subtype === 'string' && j.subtype !== 'success')
      const resultText = typeof j.result === 'string' ? j.result : ''
      if (isError) {
        // 텍스트가 있어도 오류로 전파 — 한도 초과·권한 거부 안내문을 행동 응답으로 파싱하면 "이해 못함" 으로 오진된다.
        const errs = Array.isArray(j.errors) ? (j.errors as unknown[]).map(String).join('; ') : ''
        const detail = errs || (resultText || p.text).trim().slice(0, 300)
        p.reject(new Error(`Claude Code 응답 오류(${String(j.subtype ?? 'error')})${detail ? ': ' + detail : ''}`))
        return
      }
      p.resolve({ text: resultText || p.text, usage: usageFromClaude(j.usage), sessionId: this.sessionId })
    }
  }

  send(input: CliTurnInput): { promise: Promise<CliTurnResult>; cancel(): void } {
    if (!this.alive || !this.child || this.closed) {
      return { promise: Promise.reject(new CliSessionDead('Claude Code 세션이 살아 있지 않습니다.')), cancel() { /* noop */ } }
    }
    if (this.pending) {
      return { promise: Promise.reject(new Error('이전 턴이 아직 진행 중입니다.')), cancel() { /* noop */ } }
    }
    let imgPath: string | undefined
    if (input.image) {
      imgPath = join(this.dir, `shot-${this.turns + 1}.png`)
      try { writeFileSync(imgPath, Buffer.from(input.image, 'base64')) } catch { imgPath = undefined }
    }
    const promise = new Promise<CliTurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 턴 타임아웃 = 프로세스가 막힌 것으로 보고 세션을 죽인다(호출자가 재개/폴백).
        this.pending = null
        this.alive = false
        killTree(this.child)
        reject(new CliSessionDead('시간 초과 (120초). 세션을 다시 엽니다.'))
      }, REQUEST_TIMEOUT_MS)
      this.pending = { resolve, reject, text: '', timer }
      const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: renderTurnText(input, imgPath) }] } }) + '\n'
      try { this.child!.stdin?.write(payload) } catch (err) {
        this.pending = null
        clearTimeout(timer)
        this.alive = false
        reject(new CliSessionDead(err instanceof Error ? err.message : String(err)))
      }
    })
    return {
      promise,
      cancel: () => {
        // 취소 = 프로세스 종료(현재 턴 즉시 중단). 세션은 죽는다 — 취소된 작업은 어차피 끝난다.
        const p = this.pending
        this.pending = null
        if (p) { clearTimeout(p.timer); p.reject(new Error('cancelled')) }
        this.alive = false
        killTree(this.child)
      },
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.failPending(new CliSessionDead('세션이 닫혔습니다.'))
    const child = this.child
    try { child?.stdin?.end() } catch { /* ignore */ }
    // 우아한 종료를 3초 주고, 안 죽으면 트리째.
    setTimeout(() => { if (this.alive) killTree(child) }, 3000).unref()
    setTimeout(() => { try { rmSync(this.dir, { recursive: true, force: true }) } catch { /* ignore */ } }, 5000).unref()
  }
}

// --- codex: 턴마다 `codex exec` / `codex exec resume <thread>` (서버측 문맥 유지) ---
class CodexResumeSession implements CliSession {
  readonly provider: AiProviderId = 'codex'
  sessionId: string | null
  alive = true
  turns = 0
  private child: ChildProcess | null = null
  private dir: string
  private closed = false

  constructor(private opts: CliSessionOptions) {
    this.sessionId = opts.resumeId ?? null
    this.dir = join(tmpdir(), `bb-cli-${randomUUID()}`)
    try { mkdirSync(this.dir, { recursive: true }) } catch { /* ignore */ }
  }

  send(input: CliTurnInput): { promise: Promise<CliTurnResult>; cancel(): void } {
    if (this.closed) return { promise: Promise.reject(new CliSessionDead('Codex 세션이 닫혔습니다.')), cancel() { /* noop */ } }
    if (this.child) return { promise: Promise.reject(new Error('이전 턴이 아직 진행 중입니다.')), cancel() { /* noop */ } }
    const bin = (this.opts.bin && this.opts.bin.trim()) ? this.opts.bin.trim() : 'codex'
    const model = (this.opts.model ?? '').trim()
    const outFile = join(this.dir, `out-${this.turns + 1}.txt`)
    let imgPath: string | undefined
    if (input.image) {
      imgPath = join(this.dir, `shot-${this.turns + 1}.png`)
      try { writeFileSync(imgPath, Buffer.from(input.image, 'base64')) } catch { imgPath = undefined }
    }
    const common = ['--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-last-message', outFile,
      ...(model ? ['-m', model] : []), ...(imgPath ? ['-i', imgPath] : [])]
    const args = this.sessionId ? ['exec', 'resume', this.sessionId, ...common, '-'] : ['exec', ...common, '-']
    let stderr = ''
    let buf = ''
    let usage: CliUsage | null = null
    let failMsg = ''
    let finished = false
    const promise = new Promise<CliTurnResult>((resolve, reject) => {
      const finish = (fn: () => void): void => { if (finished) return; finished = true; clearTimeout(timer); this.child = null; fn() }
      const timer = setTimeout(() => { killTree(this.child); finish(() => reject(new CliSessionDead('시간 초과 (120초).'))) }, REQUEST_TIMEOUT_MS)
      const spawnOpts: Parameters<typeof spawn>[2] = { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', cwd: this.dir, windowsHide: true }
      try { this.child = spawn(bin, args, spawnOpts) } catch (err) { finish(() => reject(new CliSessionDead(err instanceof Error ? err.message : String(err)))); return }
      const onLine = (line: string): void => {
        let j: Record<string, unknown>
        try { j = JSON.parse(line) as Record<string, unknown> } catch { return }
        if (j.type === 'thread.started' && typeof j.thread_id === 'string') this.sessionId = j.thread_id
        else if (j.type === 'turn.completed' && j.usage && typeof j.usage === 'object') {
          const u = j.usage as Record<string, unknown>
          const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0)
          usage = { input: n('input_tokens'), cacheRead: n('cached_input_tokens'), cacheCreate: 0, output: n('output_tokens') }
        } else if ((j.type === 'turn.failed' || j.type === 'error') && !failMsg) {
          const e = j.error as { message?: string } | undefined
          failMsg = (e && typeof e.message === 'string') ? e.message : (typeof j.message === 'string' ? j.message : 'turn.failed')
        }
      }
      this.child.stdout?.on('data', (c: Buffer) => {
        buf += c.toString('utf8')
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) onLine(line) }
      })
      this.child.stderr?.on('data', (c: Buffer) => { stderr = (stderr + c.toString('utf8')).slice(-2000) })
      this.child.stdin?.on('error', () => { /* close 경로가 처리 */ })
      this.child.on('error', (e) => finish(() => reject(new CliSessionDead(cliErrorMessage(cliSpecFor('codex')!, e as NodeJS.ErrnoException, stderr)))))
      this.child.on('close', (code) => {
        let text = ''
        try { text = readFileSync(outFile, 'utf8') } catch { /* 없음 = 실패 */ }
        if (text.trim()) { this.turns++; finish(() => resolve({ text, usage, sessionId: this.sessionId })) }
        else if (failMsg) finish(() => reject(new Error(`Codex 응답 오류: ${failMsg.slice(0, 400)}`)))
        else finish(() => reject(new CliSessionDead(cliErrorMessage(cliSpecFor('codex')!, null, stderr || `종료 코드 ${code}`))))
      })
      try { this.child.stdin?.write(renderTurnText(input)); this.child.stdin?.end() } catch { /* error 이벤트가 처리 */ }
    })
    return {
      promise,
      cancel: () => { killTree(this.child) },
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.alive = false
    killTree(this.child)
    setTimeout(() => { try { rmSync(this.dir, { recursive: true, force: true }) } catch { /* ignore */ } }, 5000).unref()
  }
}

// 세션을 연다. 세션 방식을 지원하지 않는 제공자면 null(호출자는 기존 스텝별 호출 사용).
// 앱이 강제 종료되면 5초 지연 정리가 못 돌아 세션 tmp 폴더(스크린샷 포함)가 남는다 → 다음 세션을 열 때 2시간 지난 것을 치운다.
function sweepStaleSessionDirs(): void {
  try {
    const base = tmpdir()
    const cutoff = Date.now() - 2 * 3600_000
    for (const name of readdirSync(base)) {
      if (!name.startsWith('bb-cli-')) continue
      const full = join(base, name)
      try { if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true }) } catch { /* 사용 중이면 다음에 */ }
    }
  } catch { /* tmp 목록 실패는 무시 */ }
}

export function openCliSession(opts: CliSessionOptions): CliSession | null {
  sweepStaleSessionDirs()
  if (opts.provider === 'claude-code') return new ClaudeStreamSession(opts)
  if (opts.provider === 'codex') return new CodexResumeSession(opts)
  return null
}
