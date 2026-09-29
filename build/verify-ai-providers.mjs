#!/usr/bin/env node
// verify-ai-providers.mjs — AI 제공자 계층 검증 (API 키 불필요, 앱을 띄우지 않는다)
//
// 왜 (2026-09-07, 임무 24): 제공자 4종(Anthropic/OpenAI/Gemini/Ollama)은 **요청 형식이 서로 다르고**
// 스트림 형식도 다르다(SSE vs NDJSON). 여기가 조용히 어긋나면 증상은 "AI 가 대답을 안 한다" 하나로
// 뭉뚱그려져, 어느 제공자의 어느 단계가 깨졌는지 알 수 없다. 그런데 이 코드에는 검사가 없었다.
//
// 키 없이 검증할 수 있는 순수 부분만 본다:
//   P1 요청 형식   — URL·인증 헤더·본문(시스템 프롬프트 위치, 스트림 플래그, 최대 토큰)
//   P2 스트림 파싱 — 각 형식의 정상/빈 줄/[DONE]/부분 청크/깨진 JSON
//   P3 도구 호출   — 구조화 tool_calls 와, 본문에 함수 호출 JSON 을 넣는 모델의 폴백
//   P4 네이티브 도구 지원 판정 — 모델 이름 허용목록
//
// 실제 네트워크 왕복(취소·타임아웃·HTTP 오류 문구)은 Electron 의 net.request 를 쓰므로
// 여기서 다루지 않는다 — 그 부분은 앱을 띄우는 하네스의 몫이다(현재 미구현, 알려진 공백).
//
// 사용: node build/verify-ai-providers.mjs [--out <dir>]

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)

const args = { out: path.join(REPO, 'verify-out', 'ai-providers') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const JS = path.join(REPO, 'app', 'dist', 'main', 'features', 'ai', 'providers.js')
if (!fs.existsSync(JS)) {
  console.error(`빌드 산출물 없음: ${JS} — 먼저 npm run build`)
  process.exit(2)
}
const P = require(JS)

const results = []
let failed = 0
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}

const req = (provider, extra = {}) => ({
  provider,
  model: extra.model ?? 'test-model',
  apiKey: 'TEST-KEY',
  system: '너는 브라우저 비서다',
  messages: [{ role: 'user', content: '안녕' }],
  maxTokens: 512,
  ...extra,
})

// ===========================================================================
// P1 — 요청 형식
// ===========================================================================
{
  const problems = []
  const ep = {}
  for (const p of ['anthropic', 'openai', 'google', 'ollama']) {
    try { ep[p] = P.endpointFor(req(p, p === 'ollama' ? { baseUrl: 'http://127.0.0.1:11434' } : {})) } catch (e) {
      problems.push(`${p}: ${e.message}`)
    }
  }
  // Endpoint.body 는 **객체**다(직렬화는 streamChat 이 한다) — 파싱하면 안 된다.
  const body = (p) => (ep[p]?.body && typeof ep[p].body === 'object' ? ep[p].body : {})
  const headerOf = (p, name) => {
    const h = ep[p]?.headers ?? {}
    const k = Object.keys(h).find((x) => x.toLowerCase() === name)
    return k ? String(h[k]) : ''
  }

  // 각 제공자가 지켜야 하는 것 — 하나라도 어긋나면 그 제공자만 조용히 죽는다.
  if (!/api\.anthropic\.com/.test(ep.anthropic?.url ?? '')) problems.push('anthropic URL')
  if (!headerOf('anthropic', 'x-api-key')) problems.push('anthropic 인증 헤더(x-api-key)')
  if (!headerOf('anthropic', 'anthropic-version')) problems.push('anthropic 버전 헤더')
  if (body('anthropic').system !== '너는 브라우저 비서다') problems.push('anthropic system 은 본문 최상위여야 함')
  if (body('anthropic').stream !== true) problems.push('anthropic stream 플래그')
  if (body('anthropic').max_tokens !== 512) problems.push('anthropic max_tokens')

  if (!/api\.openai\.com/.test(ep.openai?.url ?? '')) problems.push('openai URL')
  if (!/^Bearer /.test(headerOf('openai', 'authorization'))) problems.push('openai Bearer 헤더')
  if (body('openai').messages?.[0]?.role !== 'system') problems.push('openai system 은 첫 메시지여야 함')
  if (body('openai').stream !== true) problems.push('openai stream 플래그')

  if (!/generativelanguage\.googleapis\.com/.test(ep.google?.url ?? '')) problems.push('google URL')
  if (!/alt=sse/.test(ep.google?.url ?? '')) problems.push('google SSE 파라미터')
  if (!body('google').systemInstruction) problems.push('google systemInstruction')
  const gRole = body('google').contents?.[0]?.role
  if (gRole !== 'user') problems.push(`google 역할 이름(user/model) — 받은 값 ${gRole}`)

  if (!/127\.0\.0\.1:11434/.test(ep.ollama?.url ?? '')) problems.push('ollama 사용자 지정 주소 반영')
  if (body('ollama').stream !== true) problems.push('ollama stream 플래그')

  check('P1', '4제공자의 요청 형식(주소·인증·본문)이 규격대로다', problems.length === 0,
    problems.length ? `어긋남: ${problems.join(', ')}` : '4종 전부 일치')
}

// ===========================================================================
// P2 — 스트림 파싱 (형식마다 다르다)
// ===========================================================================
{
  const problems = []
  const parse = (p, line, extra = {}) => {
    const e = P.endpointFor(req(p, p === 'ollama' ? { baseUrl: 'http://127.0.0.1:11434', ...extra } : extra))
    return e.parseLine(line)
  }
  const textOf = (r) => (r && typeof r.text === 'string' ? r.text : null)

  // Anthropic: SSE, content_block_delta
  if (textOf(parse('anthropic', 'data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '안녕' } }))) !== '안녕') {
    problems.push('anthropic 델타')
  }
  // OpenAI: SSE, choices[].delta.content + [DONE]
  if (textOf(parse('openai', 'data: ' + JSON.stringify({ choices: [{ delta: { content: '반가' } }] }))) !== '반가') problems.push('openai 델타')
  const openaiDone = parse('openai', 'data: [DONE]')
  if (!openaiDone || openaiDone.done !== true) problems.push('openai [DONE] 인식')
  // Google: SSE, candidates[].content.parts[].text
  if (textOf(parse('google', 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: '하이' }] } }] }))) !== '하이') {
    problems.push('google 델타')
  }
  // Ollama: NDJSON (data: 접두사 없음)
  if (textOf(parse('ollama', JSON.stringify({ message: { content: '음' } }))) !== '음') problems.push('ollama 델타')
  const ollamaDone = parse('ollama', JSON.stringify({ done: true }))
  if (!ollamaDone || ollamaDone.done !== true) problems.push('ollama done 인식')

  // 어느 형식이든 **깨진 줄에 던지면 안 된다** — 한 줄 때문에 전체 응답이 죽는다.
  for (const p of ['anthropic', 'openai', 'google', 'ollama']) {
    for (const bad of ['', '   ', 'data: {깨진', ': keep-alive', 'event: ping', '{"부분']) {
      try { parse(p, bad) } catch (e) { problems.push(`${p} 가 깨진 줄에 예외: ${JSON.stringify(bad)} (${e.message})`) }
    }
  }

  check('P2', '스트림 줄 파싱이 형식별로 맞고 깨진 줄에 죽지 않는다', problems.length === 0,
    problems.length ? `어긋남: ${problems.slice(0, 3).join(' · ')}${problems.length > 3 ? ` 외 ${problems.length - 3}건` : ''}` : '4형식 · 정상/빈줄/[DONE]/깨진 줄 전부 통과')
}

// ===========================================================================
// P3 — 도구 호출 파싱 (에이전트 tool 경로의 뿌리)
// ===========================================================================
{
  const problems = []
  const known = new Set(['click', 'type_text', 'navigate', 'done'])

  // 본문에 함수 호출 JSON 을 넣는 모델(Ollama 계열에서 흔하다)
  const fromText = P.extractToolCallFromText('{"name":"click","arguments":{"ref":3}}', known)
  if (fromText?.name !== 'click' || fromText?.args?.ref !== 3) problems.push('본문 JSON 폴백')

  // ```json 펜스와 <tool_call> 태그로 감싼 경우
  const fenced = P.extractToolCallFromText('```json\n{"name":"navigate","arguments":{"url":"https://a.example"}}\n```', known)
  if (fenced?.name !== 'navigate') problems.push('코드펜스 감싼 호출')
  const tagged = P.extractToolCallFromText('<tool_call>{"name":"done","arguments":{}}</tool_call>', known)
  if (tagged?.name !== 'done') problems.push('<tool_call> 태그 호출')

  // 앞뒤에 설명(프로즈)이 붙은 경우 — 균형 중괄호 스캔이 필요하다
  const prosed = P.extractToolCallFromText('먼저 이걸 누를게요. {"name":"click","arguments":{"ref":7}} 그 다음에…', known)
  if (prosed?.name !== 'click' || prosed?.args?.ref !== 7) problems.push('프로즈 속 호출 추출')

  // 도구 호출이 아닌 평범한 답변을 호출로 착각하면 안 된다
  const notCall = P.extractToolCallFromText('그 버튼은 화면 오른쪽 위에 있습니다.', known)
  if (notCall !== null) problems.push(`평범한 답변을 호출로 오인: ${JSON.stringify(notCall)}`)

  check('P3', '도구 호출을 구조화·본문 양쪽에서 읽고 오인하지 않는다', problems.length === 0,
    problems.length ? `어긋남: ${problems.join(' · ')}` : '폴백·펜스·태그·프로즈·오인방지 전부 통과')
}

// ===========================================================================
// P4 — 네이티브 도구 지원 판정 (모델 허용목록)
// ===========================================================================
{
  const problems = []
  // 클라우드 3사는 항상 지원
  for (const p of ['anthropic', 'openai', 'google']) {
    if (!P.supportsNativeTools(p, 'any-model')) problems.push(`${p} 는 항상 지원이어야 함`)
  }
  // Ollama 는 모델 이름으로 가른다 — 지원 모델을 놓치면 느린 JSON 경로로 떨어지고,
  // 미지원 모델을 지원으로 보면 tool 경로가 무한 관찰 루프가 된다.
  const yes = ['qwen2.5-coder:7b', 'llama3.1:8b', 'mistral:latest', 'gpt-oss:20b']
  const no = ['exaone3.5:7.8b', 'llama2:7b']
  for (const m of yes) if (!P.supportsNativeTools('ollama', m)) problems.push(`ollama/${m} 지원 판정 누락`)
  for (const m of no) if (P.supportsNativeTools('ollama', m)) problems.push(`ollama/${m} 를 지원으로 오판`)

  check('P4', '네이티브 도구 지원 판정이 모델별로 맞다', problems.length === 0,
    problems.length ? `어긋남: ${problems.join(' · ')}` : `클라우드 3종 + ollama 허용 ${yes.length}·제외 ${no.length} 일치`)
}

fs.mkdirSync(args.out, { recursive: true })
fs.writeFileSync(path.join(args.out, 'ai-providers-results.json'), JSON.stringify(results, null, 2))
console.log('\n===== verify-ai-providers 결과 =====')
console.table(results.map((r) => ({ ID: r.id, 상태: r.status })))
console.log(`PASS=${results.length - failed} FAIL=${failed} (총 ${results.length})`)
process.exit(failed ? 1 : 0)
