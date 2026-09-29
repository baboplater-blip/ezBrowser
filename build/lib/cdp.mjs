// lib/cdp.mjs — 검증 하네스가 공유하는 CDP(Chrome DevTools Protocol) 접속 계층.
//
// 왜 있는가 (2026-09-07, auto-dev 임무 3):
//   스모크·다운로드·확장·복원·스트레스·성능·에이전트안전·지문 8개 하네스가 각자 CDPSession 을
//   복제해 갖고 있었다. 2026-09-06 에 스모크에서 발견·수정한 결함(무응답 커맨드로 pending 영구
//   잔류, 좀비 인스턴스의 포트 선점, 갓 패키징한 exe 의 CDP 응답 지연)이 **나머지 7개에는 그대로
//   남아 있었다.** 한 곳을 고치면 전부 안전해지도록 여기로 모은다.
//
// 이 모듈은 "앱에 어떻게 붙는가"만 담는다. 각 하네스의 시나리오 로직·앱 spawn·프로필 시드는
// 하네스가 계속 소유한다(하네스마다 다르고, 섣불리 합치면 회귀 위험만 커진다).
//
// 의존성 0 — Node 22+ 내장 WebSocket/fetch 만 사용.

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout(${ms}ms): ${label}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export async function pollUntil(fn, { timeoutMs = 10_000, intervalMs = 300, label = 'condition' } = {}) {
  const start = Date.now()
  let last
  let lastErr
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn()
      lastErr = null
      if (last) return last
    } catch (err) {
      lastErr = err
    }
    await sleep(intervalMs)
  }
  const suffix = lastErr ? ` (마지막 오류: ${lastErr.message})` : ''
  throw new Error(`timeout(${timeoutMs}ms) waiting for ${label}${suffix}`)
}

// ── CDP 세션 ────────────────────────────────────────────────────────────

/**
 * 한 CDP 타깃(페이지·브라우저)에 대한 WebSocket 세션.
 *
 * `events` 는 CDP 이벤트(msg.method) 구독자 목록이다. Electron 의 `webContents.debugger`
 * 시그니처(event, method, params, sessionId)로 호출하므로, 디버거를 흉내내는 하네스가
 * 그대로 쓸 수 있다(verify-agent-safety 의 파일 선택창 가로채기 검증이 이 경로를 쓴다).
 */
export class CDPSession {
  constructor(wsUrl, label) {
    this.wsUrl = wsUrl
    this.label = label
    this.ws = null
    this._id = 0
    this.pending = new Map()
    this.events = []
  }

  async connect(timeoutMs = 10_000) {
    this.ws = new WebSocket(this.wsUrl)
    await withTimeout(new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', (e) => reject(new Error(`ws error: ${e?.message ?? 'unknown'}`)))
    }), timeoutMs, `CDP ws connect (${this.label})`)
    this.ws.addEventListener('message', (ev) => this._onMessage(ev))
    this.ws.addEventListener('close', () => {
      for (const [, p] of this.pending) p.reject(new Error('ws closed before response'))
      this.pending.clear()
    })
  }

  _onMessage(ev) {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(`CDP error [${msg.error.code}]: ${msg.error.message}`))
      else resolve(msg.result)
      return
    }
    if (typeof msg.method === 'string' && this.events.length) {
      for (const fn of this.events) {
        try { fn({}, msg.method, msg.params ?? {}, msg.sessionId) } catch { /* 구독자 예외는 세션을 죽이지 않는다 */ }
      }
    }
  }

  send(method, params = {}, timeoutMs = 15_000) {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
      return Promise.reject(new Error(`CDP session not open (${this.label}) — method=${method}`))
    }
    const id = (this._id += 1)
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.ws.send(JSON.stringify({ id, method, params }))
    // 타임아웃 시 pending 엔트리를 반드시 지운다 — 무응답 커맨드가 맵에 영구 잔류하면
    // 나중에 도착한 응답이 엉뚱한 대기자를 깨우거나, close 시 대량 reject 를 낳는다.
    return withTimeout(p, timeoutMs, `CDP ${method} (${this.label})`).catch((err) => {
      this.pending.delete(id)
      throw err
    })
  }

  close() {
    try { this.ws?.close() } catch { /* ignore */ }
  }
}

export async function connectSession(target, label) {
  const session = new CDPSession(target.webSocketDebuggerUrl, label ?? target.id)
  await session.connect()
  return session
}

// ── 타깃 발견 ───────────────────────────────────────────────────────────

export async function getTargetList(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`)
  return res.json()
}

/** 외피(브라우저 크롬 UI) 타깃인가 — file://…/index.html?windowId=… */
export function isShellTarget(t) {
  return t.type === 'page' && typeof t.url === 'string'
    && t.url.startsWith('file://') && t.url.includes('index.html') && t.url.includes('windowId=')
}

export async function waitForShellTarget(port, timeoutMs = 30_000) {
  let lastList = []
  return pollUntil(async () => {
    lastList = await getTargetList(port)
    return lastList.find(isShellTarget) ?? null
  }, { timeoutMs, intervalMs: 500, label: 'shell CDP target' }).catch((err) => {
    const summary = lastList.map((t) => `${t.type}:${t.url}`).join('\n  ')
    throw new Error(`${err.message}\n마지막 타깃 목록:\n  ${summary || '(없음)'}`)
  })
}

export async function waitForTargetByUrlPredicate(port, predicate, label, timeoutMs = 15_000) {
  return pollUntil(async () => {
    const list = await getTargetList(port)
    return list.find((t) => t.type === 'page' && typeof t.url === 'string' && predicate(t.url)) ?? null
  }, { timeoutMs, intervalMs: 300, label })
}

// ── 접속 견고화 (여기가 이 모듈의 존재 이유) ─────────────────────────────

/**
 * CDP 디버그 포트가 **정말로 비었는지** 확인한다.
 *
 * 앞선 실행이 남긴 인스턴스가 같은 포트를 쥐고 있으면, 새 앱을 띄워도 `/json/list` 는
 * **좀비의 타깃**을 돌려준다. 그 렌더러는 이미 죽어 CDP 명령이 영영 응답하지 않고,
 * 하네스는 원인을 알 수 없는 전면 실패로 무너진다(2026-09-06 실측 — INFRA 실패의 주원인).
 *
 * **연결 거부만 "비었음"이다.** 타임아웃·리셋은 소켓만 쥔 좀비가 응답을 못 하는 상태일 수
 * 있으므로 점유로 간주한다(좀비는 TCP 는 받고 HTTP 는 답하지 않는다).
 */
export async function waitForPortFree(port, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (!res.ok) return true
    } catch (err) {
      const code = err?.cause?.code ?? err?.code
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return true
    }
    await sleep(500)
  }
  // 여기까지 왔다는 것은 누군가 그 포트를 쥐고 있다는 뜻이다.
  // **누가** 쥐고 있는지 찍어 준다 - 이게 없으면 "앱이 안 뜬다" 로 오해하게 된다(임무 23 실화).
  try {
    const { describePortOwner } = await import('./ports.mjs')
    const owner = describePortOwner(port)
    if (owner) console.warn(`[cdp] 포트 ${port} 를 ${owner} 가 점유 중 - 앞선 실행의 잔재일 수 있다`)
  } catch { /* 진단 실패는 무시 */ }
  return false
}

/**
 * 이미 연결한 세션이 **실제로 응답하는지** 확인한다(필요하면 기다린다).
 *
 * 갓 만들어진 창의 타깃은 `/json/list` 에 먼저 나타나고 렌더러 준비는 그 뒤다. 곧바로 보낸
 * 첫 명령이 한참 응답하지 않을 수 있다(2026-09-06 실측: 같은 머신에서 20ms ↔ 16초).
 */
export async function ensureSessionReady(session, { totalMs = 45_000, probeMs = 15_000 } = {}) {
  const deadline = Date.now() + totalMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      await session.send('Runtime.enable', {}, probeMs)
      const probe = await session.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, probeMs)
      if (probe?.result?.value === 2) return true
    } catch (err) { lastErr = err }
    await sleep(300)
  }
  throw new Error(`세션 응답 확인 실패(${session.label})${lastErr ? ` — ${lastErr.message}` : ''}`)
}

/**
 * 외피 CDP 세션을 **실제로 응답하는 상태로** 확보한다.
 *
 * 타깃 재발견 → 연결 → Runtime.enable → 프로브 evaluate 를 성공할 때까지 반복하고,
 * 응답이 없으면 그 세션을 버리고 새로 연결한다(타깃 스왑 대응).
 *
 * 프로브 대기는 **짧게 시작해 크게 늘린다**: 갓 패키징한 exe 는 첫 실행에서 백신 검사·콜드
 * 캐시 때문에 CDP 응답이 수십 초 늦을 수 있고, 짧은 타임아웃으로 재연결만 반복하면
 * **늦게 오는 응답을 매번 버려** 영원히 실패한다(실측: 45초를 18번 헛되이 씀).
 */
export async function connectShellSessionReady(port, { totalMs = 90_000, label = 'chrome-shell', log = null } = {}) {
  const deadline = Date.now() + totalMs
  const schedule = [8_000, 20_000, 30_000, 30_000]
  let attempt = 0
  let lastErr = null
  while (Date.now() < deadline) {
    const remain = deadline - Date.now()
    const probeMs = Math.max(2_000, Math.min(schedule[Math.min(attempt, schedule.length - 1)], remain))
    attempt += 1
    let session = null
    try {
      const target = await waitForShellTarget(port, Math.max(1_000, deadline - Date.now()))
      session = await connectSession(target, label)
      await session.send('Runtime.enable', {}, probeMs)
      const probe = await session.send('Runtime.evaluate', {
        expression: '1+1', returnByValue: true,
      }, probeMs)
      if (probe?.result?.value !== 2) throw new Error(`프로브 값 이상: ${JSON.stringify(probe)}`)
      if (attempt > 1 && log) log(`외피 세션 확보 (재시도 ${attempt}회차)`)
      return session
    } catch (err) {
      lastErr = err
      try { session?.close() } catch { /* ignore */ }
      await sleep(500)
    }
  }
  throw new Error(`외피 CDP 세션 확보 실패(${totalMs}ms, ${attempt}회 시도)${lastErr ? ` — 마지막 오류: ${lastErr.message}` : ''}`)
}
