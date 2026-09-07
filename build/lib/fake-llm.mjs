// fake-llm.mjs — 각본대로 답하는 가짜 LLM 서버 (Ollama 호환)
//
// 왜 (2026-09-07, 임무 26): 에이전트 루프를 실제 모델로 검증하면 ① 모델이 없으면 검증 자체가 안 되고
// ② 같은 입력에 다른 답이 와서 실패가 재현되지 않는다. 그래서 **각본대로만 답하는 서버**를 두고
// 앱 설정의 `ai.ollamaUrl` 을 여기로 돌린다. 모델 설치 없이, 매번 같은 결과로 루프 전체를 본다.
//
// 앱이 부르는 곳: POST <base>/api/chat  (Ollama 형식, NDJSON 스트리밍)
//
// 각본(step) 한 개는 다음 중 하나:
//   { reply: (ctx) => string }        정상 응답 — 반환 문자열이 assistant 본문이 된다
//   { status, body }                  HTTP 오류 응답 (401·429·404 …)
//   { mode: 'hang' }                  응답을 끝내지 않는다(타임아웃·취소 시험용)
//   { mode: 'garbage' }               깨진 NDJSON 을 흘린다(파서 견고성 시험용)
//   { mode: 'slow', chunks, delayMs } 천천히 조금씩 보낸다(취소 시험용)
//
// ctx 로 넘어오는 것: { body, messages, lastUser, refFor(label), n }

import http from 'node:http'

// 줄바꿈을 문자열 리터럴로 쓰지 않는다 — 이 저장소에서 파이썬 패치·히어독을 거치며
// 백슬래시가 여러 번 먹혀 파일이 깨진 적이 있다(2026-09-07). 상수로 두면 그 층을 안 탄다.
const NL = String.fromCharCode(10)

/** 관찰 블록에서 `[3] button "결제하기"` 형태를 찾아 라벨로 ref 를 고른다. */
export function refFromObservation(text, label) {
  const re = /\[(\d+)\]\s+\S+\s+"([^"]*)"/g
  let m
  while ((m = re.exec(text ?? ''))) {
    if (String(m[2]).includes(label)) return Number(m[1])
  }
  return null
}

export function startFakeLlm({ port = 11500, script = [], onRequest } = {}) {
  const state = { n: 0, requests: [], script: [...script] }

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      if (!req.url.startsWith('/api/chat')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch { body = {} }
      const messages = Array.isArray(body.messages) ? body.messages : []
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
      const idx = state.n++
      state.requests.push({ at: Date.now(), body, messages, lastUser })
      if (onRequest) { try { onRequest({ idx, body, messages, lastUser }) } catch { /* ignore */ } }

      // 각본이 모자라면 마지막 단계를 반복한다(루프가 예상보다 길어져도 멈추지 않게).
      const step = state.script[idx] ?? state.script[state.script.length - 1] ?? { reply: () => '{"action":"done","message":"끝"}' }

      if (step.status) {
        res.writeHead(step.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(step.body ?? { error: 'error' }))
        return
      }
      if (step.mode === 'hang') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write('{"message":{"content":""},"done":false}\n')
        return // 끝내지 않는다
      }
      if (step.mode === 'garbage') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write('{"message":{"content":"부분\n')      // 잘린 JSON
        res.write('아무 텍스트\n')                        // JSON 이 아님
        res.write('{"broken":\n')
        res.write('{"done":true}\n')
        res.end()
        return
      }
      if (step.mode === 'slow') {
        // 첫 조각을 **즉시** 보내고 나머지를 간격을 두고 보낸다.
        // (예전에는 setInterval 로만 보내 첫 조각까지 delayMs 를 기다렸고, 클라이언트가
        //  아무 것도 못 받은 채 멈춘 것처럼 보였다 - 2026-09-07 실측.)
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' })
        res.flushHeaders?.()
        const chunks = step.chunks ?? ['천', '천', '히']
        let i = 0
        const writeOne = () => {
          if (res.writableEnded) return false
          if (i >= chunks.length) {
            res.write('{"done":true}' + NL)
            res.end()
            return false
          }
          res.write(JSON.stringify({ message: { role: 'assistant', content: chunks[i++] }, done: false }) + NL)
          return true
        }
        writeOne()
        const timer = setInterval(() => { if (!writeOne()) clearInterval(timer) }, step.delayMs ?? 300)
        req.on('close', () => clearInterval(timer))
        return
      }

      const ctx = {
        body,
        messages,
        lastUser,
        n: idx,
        refFor: (label) => refFromObservation(lastUser, label),
      }
      let content = ''
      try { content = String(step.reply ? step.reply(ctx) : '') } catch (e) { content = `{"action":"done","message":"각본 오류: ${e.message}"}` }

      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(JSON.stringify({ model: body.model ?? 'fake', message: { role: 'assistant', content }, done: false }) + '\n')
      res.write(JSON.stringify({ model: body.model ?? 'fake', done: true }) + '\n')
      res.end()
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        get requests() { return state.requests },
        get count() { return state.n },
        setScript(next) { state.script = [...next]; state.n = 0; state.requests.length = 0 },
        async close() {
          await new Promise((r) => {
            // 앱의 keep-alive 연결 때문에 close 가 영원히 안 끝나는 것을 막는다(이 저장소에서 겪은 정지).
            try { server.closeAllConnections?.() } catch { /* ignore */ }
            const t = setTimeout(r, 3000)
            server.close(() => { clearTimeout(t); r() })
          })
        },
      })
    })
  })
}
