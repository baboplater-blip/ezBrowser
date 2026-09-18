#!/usr/bin/env node
// pilot-realsite-cdp.mjs — 실사이트 읽기 전용 다단계 작업 파일럿 (실제 구독 모델 사용)
//
// 무엇을 증명하려는가: **패키징된 브라우저의 에이전트가, 실제 구독 모델로, 공개 사이트에서
// 다단계 읽기 작업을 스스로 완수한다.** 합성 모델·모의 페이지가 아니다.
//
// ⚠ 게이트 미등록(수동). 이유: ① 실제 구독 호출을 쓴다(한도 소모) ② 외부 네트워크에 의존해
//    비결정론적이다. verify-all 에 넣으면 남의 사이트 상태로 게이트가 빨개진다.
// ⚠ 읽기 전용만. 로그인·쓰기·게시를 하지 않는다(readOnly 모드로 강제).
// ⚠ 격리 프로필을 쓴다 — 사용자 실제 프로필·로그인 세션을 건드리지 않는다.
//
// 기대값을 **대상 사이트의 내용에서 끌어오지 않는다.** 판정은 구조적이다:
//   - 여러 페이지를 실제로 이동했는가(다단계)
//   - 노트를 기록했는가 / 결과 파일이 실제로 생겼는가
//   - 작업 상태가 completed 또는 needs-verify(근거 있음) 인가
//   "정답 문자열이 나왔는가" 는 보지 않는다 — 그건 사이트 내용을 컨닝하는 것이다.
//
// 사용:
//   node build/pilot-realsite-cdp.mjs                     3개 사이트 전부
//   node build/pilot-realsite-cdp.mjs --only mdn           하나만
//   node build/pilot-realsite-cdp.mjs --provider codex     제공자 지정(기본 claude-code)
// 결과: verify-out/realsite-pilot/realsite-results.json + 사이트별 이벤트 로그

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connectShellSessionReady, waitForPortFree } from './lib/cdp.mjs'
import { preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')

const args = {
  port: 9311,
  out: path.join(REPO, 'verify-out', 'realsite-pilot'),
  provider: 'claude-code',
  only: '',
  keepProfile: false,
  perTaskMs: 10 * 60000,
  sustainMin: 0,   // >0 이면 R4 지속 실행 모드(실제 시계 분)
}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--port') args.port = Number(process.argv[++i])
  else if (a === '--out') args.out = path.resolve(process.argv[++i])
  else if (a === '--provider') args.provider = process.argv[++i]
  else if (a === '--only') args.only = process.argv[++i]
  else if (a === '--keep-profile') args.keepProfile = true
  else if (a === '--per-task-ms') args.perTaskMs = Number(process.argv[++i])
  else if (a === '--sustain') args.sustainMin = Number(process.argv[++i])
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const NL = String.fromCharCode(10)

// 다단계를 **구조적으로** 요구하는 작업 — 한 페이지만 보고는 끝낼 수 없게 구성했다.
// 정답 내용을 명시하지 않는다(기대값을 대상에서 끌어오지 않기 위해).
const SITES = [
  {
    id: 'mdn',
    label: 'MDN',
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array',
    hosts: ['developer.mozilla.org'],
    task: 'MDN 의 Array 참조 문서에서 시작해서, Array 의 인스턴스 메서드 중 서로 다른 두 개(예: map 과 filter)의 개별 문서 페이지를 각각 열어 읽고, 각 페이지에서 note 로 "메서드 이름 / 반환값 / 원본 배열을 바꾸는지" 를 기록하세요. 두 페이지를 모두 기록한 뒤 report 로 비교 보고서를 작성하세요.',
  },
  {
    id: 'wikipedia',
    label: 'Wikipedia',
    url: 'https://en.wikipedia.org/wiki/Web_browser',
    hosts: ['en.wikipedia.org'],
    task: 'Wikipedia 의 Web browser 문서에서 시작해서, 본문에 링크된 다른 문서 두 개를 각각 열어 읽고 note 로 "문서 제목 / 그 문서가 웹 브라우저와 어떤 관계인지 한 문장" 을 기록하세요. 두 문서를 모두 기록한 뒤 report 로 보고서를 작성하세요.',
  },
  {
    id: 'github',
    label: 'GitHub',
    url: 'https://github.com/electron/electron',
    hosts: ['github.com'],
    task: 'GitHub 의 electron/electron 저장소에서 시작해서, 저장소 첫 화면과 Releases(또는 Tags) 목록 페이지를 각각 열어 읽고 note 로 "그 화면에서 확인한 사실 2가지" 를 기록하세요. 두 화면을 모두 기록한 뒤 report 로 보고서를 작성하세요.',
  },
]

// R4 — **실제 시계**로 오래 도는지. 가상시계가 아니다.
// 24시간을 기다릴 수는 없으므로 "수십 분 연속 실행이 살아 있다" 만 증명하고, 24시간 주장과 구분해 적는다.
// 구간(segment)이 여러 개 지나가는지를 함께 보는 것이 핵심 — 그래야 장시간 실행이 "한 번 길게 도는 것"이
// 아니라 "구간을 이어 붙여 무한히 갈 수 있는 구조" 임이 확인된다.
const SUSTAIN = {
  id: 'sustain',
  label: '지속 실행(실제 시계)',
  url: 'https://en.wikipedia.org/wiki/Web_browser',
  hosts: ['en.wikipedia.org'],
  task: 'Wikipedia 의 Web browser 문서에서 시작해, 본문에 링크된 문서를 하나씩 열어 읽고 그 문서마다 note 로 "문서 제목 / 웹 브라우저와의 관계 한 문장" 을 기록하세요. 한 문서를 기록하면 다음 링크로 넘어가 계속 반복하세요. 중간에 report 하지 말고, 지시가 멈출 때까지 계속 새 문서를 탐색하며 기록만 이어가세요.',
}

function findApp() {
  const candidates = [
    path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe'),
    path.join(REPO, 'dist', 'win-unpacked', 'BrowserBuild.exe'),
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

// 격리 프로필 시드 — welcome 화면을 건너뛰고, 실제 구독 CLI 제공자를 쓰게 한다.
// 사용자 실제 프로필은 절대 읽지도 쓰지도 않는다.
function seedProfile(dir, provider) {
  fs.mkdirSync(dir, { recursive: true })
  const settings = {
    setup: { completed: true },
    startup: { mode: 'newtab' },
    ai: {
      enabled: true,
      provider,
      // 읽기 전용 파일럿이라 비전은 끈다 — 스크린샷 왕복이 시간·한도를 먹고, 판정에 필요하지 않다.
      agentVision: 'off',
      agentAutoApprove: false,
      cliSession: true,
      agentMaxSteps: 25,
      taskSegmentSteps: 12,
    },
    // 광고차단 콜드 빌드가 부팅을 늦춰 CDP 접속이 흔들린다 — 파일럿 판정과 무관하므로 끈다.
    adblock: { enabled: false },
  }
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2))
}

const evalIn = async (s, expression, awaitPromise = false, timeoutMs = 60000) => {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, timeoutMs)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.result?.value ?? r.result?.value
}
const J = (v) => JSON.stringify(v)

async function main() {
  console.log('=== 실사이트 읽기 전용 파일럿 (실제 구독 모델) ===')
  console.log('제공자:', args.provider, '· 읽기 전용 · 격리 프로필')
  fs.mkdirSync(args.out, { recursive: true })

  const exe = findApp()
  if (!exe) {
    console.error('패키징 앱을 찾지 못했습니다. `npm run package:win` 을 먼저 돌리세요.')
    process.exit(2)
  }
  const port = await preferFreePort(args.port)
  await waitForPortFree(port, 20000)

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ezb-realsite-'))
  seedProfile(profile, args.provider)

  const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
  })
  const appLog = []
  child.stdout.on('data', (d) => appLog.push(String(d)))
  child.stderr.on('data', (d) => appLog.push(String(d)))

  const results = []
  let shell = null
  try {
    shell = await connectShellSessionReady(port)
    const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
    const cfg = await evalIn(shell, 'window.browserAPI.ai.config()', true).catch(() => null)
    console.log('AI 설정:', cfg?.provider, '· 준비됨:', cfg?.hasKey)
    if (!cfg?.hasKey) {
      console.error(`제공자 ${args.provider} 가 준비되지 않았습니다 — 파일럿을 돌릴 수 없습니다.`)
      results.push({ id: 'provider', status: 'BLOCKED', detail: `${args.provider} 미준비` })
    } else {
      if (args.sustainMin > 0) {
        console.log(NL + `--- ${SUSTAIN.label}: 실제 시계로 ${args.sustainMin}분 ---`)
        console.log('⚠ 이것은 실제 지속 실행이며, 24시간 실행의 증거가 아니다(그건 별도·미실시).')
        const r = await runOne(shell, windowId, SUSTAIN, { sustain: true })
        results.push(r)
        fs.writeFileSync(path.join(args.out, 'sustain-events.json'), JSON.stringify(r.events ?? [], null, 2))
        console.log(`${r.status === 'PASS' ? '✅' : r.status === 'GAP' ? '⚠' : '❌'} ${SUSTAIN.label}: ${r.detail}`)
      } else {
      const todo = args.only ? SITES.filter((s) => s.id === args.only) : SITES
      for (const site of todo) {
        console.log(`\n--- ${site.label} ---`)
        const r = await runOne(shell, windowId, site)
        results.push(r)
        fs.writeFileSync(path.join(args.out, `${site.id}-events.json`), JSON.stringify(r.events ?? [], null, 2))
        console.log(`${r.status === 'PASS' ? '✅' : r.status === 'GAP' ? '⚠' : '❌'} ${site.label}: ${r.detail}`)
      }
      }
    }
  } catch (err) {
    console.error('파일럿 실패:', err?.message ?? err)
    results.push({ id: 'infra', status: 'FAIL', detail: String(err?.message ?? err) })
  } finally {
    try { if (shell) await shell.send('Browser.close', {}, 8000) } catch { /* ignore */ }
    await sleep(2500)
    try { child.kill() } catch { /* ignore */ }
    if (!args.keepProfile) { try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ } }
  }

  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const gap = results.filter((r) => r.status === 'GAP' || r.status === 'BLOCKED').length
  const summary = { at: new Date().toISOString(), provider: args.provider, readOnly: true, results, pass, fail, gap }
  fs.writeFileSync(path.join(args.out, 'realsite-results.json'), JSON.stringify(summary, null, 2))
  fs.writeFileSync(path.join(args.out, 'app.log'), appLog.join(''))
  console.log(`\n=== ${pass} PASS / ${fail} FAIL / ${gap} 미실시 ===`)
  console.log('결과:', path.join(args.out, 'realsite-results.json'))
  process.exit(fail > 0 ? 1 : 0)
}

// 한 사이트 실행 — 생성·시작·폴링·판정
async function runOne(shell, windowId, site, opts = {}) {
  const sustain = !!opts.sustain
  const sustainMs = args.sustainMin * 60000
  const t0 = Date.now()
  const out = { id: site.id, label: site.label, status: 'FAIL', detail: '', ms: 0, events: [], evidence: {} }

  const tab = await evalIn(shell, `window.browserAPI.tabs.create(${J(windowId)}, ${J(site.url)})`, true)
  if (!tab?.id) { out.detail = '시작 탭을 열지 못했습니다'; return out }
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const list = await evalIn(shell, `window.browserAPI.tabs.list(${J(windowId)})`, true).catch(() => [])
    const t = (list || []).find((x) => x.id === tab.id)
    if (t && !t.loading && String(t.url).includes(site.hosts[0])) break
  }

  await evalIn(shell, `(function(){
    window.__pilot = { evts: [], off: null };
    window.__pilot.off = window.browserAPI.ai.onPtaskEvent(function(e){ if (window.__pilot.evts.length < 4000) window.__pilot.evts.push(e) });
    return true;
  })()`)

  const createArgs = sustain
    // 지속 실행: mode='long' + **시간을 상한**으로 둔다(단계·호출은 넉넉히 → 실제 시계가 종료 조건이 되게).
    ? { instruction: site.task, tabId: tab.id, mode: 'long', readOnly: true,
      budget: { allowedHosts: site.hosts, maxSteps: 4000, maxLlmCalls: 4000, maxDurationMs: sustainMs } }
    : { instruction: site.task, tabId: tab.id, mode: 'normal', readOnly: true,
      budget: { allowedHosts: site.hosts, maxSteps: 40, maxLlmCalls: 60, maxDurationMs: args.perTaskMs } }
  const created = await evalIn(shell, `window.browserAPI.ai.ptaskCreate(${J(createArgs)})`, true)
  if (!created?.id) { out.detail = '작업 생성 실패(taskCreate null)'; return out }
  out.taskId = created.id
  await evalIn(shell, `window.browserAPI.ai.ptaskStart(${J(created.id)})`, true)

  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'needs-verify', 'interrupted'])
  const deadline = Date.now() + (sustain ? sustainMs + 120000 : args.perTaskMs + 30000)
  let task = null
  let lastStep = -1
  // 지속 실행에서는 "살아서 구간을 넘기고 있는가" 를 시계열로 남긴다 — 한 번 길게 도는 것과
  // 구간을 이어 붙여 계속 갈 수 있는 구조를 구분하는 증거다.
  const timeline = []
  let maxSegment = 0
  while (Date.now() < deadline) {
    await sleep(3000)
    const list = await evalIn(shell, 'window.browserAPI.ai.ptaskList()', true).catch(() => [])
    task = (list || []).find((x) => x.id === created.id) ?? null
    if (!task) continue
    if (typeof task.segment === 'number') maxSegment = Math.max(maxSegment, task.segment)
    if (task.stepsUsed !== lastStep) {
      lastStep = task.stepsUsed
      const atMin = +((Date.now() - t0) / 60000).toFixed(2)
      if (sustain) timeline.push({ atMin, state: task.state, steps: task.stepsUsed, segment: task.segment ?? null, llm: task.llmCalls ?? null })
      process.stdout.write(`  ${atMin.toFixed(1)}분 · 단계 ${task.stepsUsed} · 구간 ${task.segment ?? '?'} · ${task.state}   \r`)
    }
    if (TERMINAL.has(task.state)) break
  }
  if (sustain) { out.timeline = timeline; out.maxSegment = maxSegment }
  out.events = await evalIn(shell, 'window.__pilot ? window.__pilot.evts : []').catch(() => [])
  out.ms = Date.now() - t0
  if (!task) { out.detail = '작업을 목록에서 찾지 못했습니다'; return out }

  // ===== 구조적 판정 (사이트 내용을 컨닝하지 않는다) =====
  const evts = out.events
  const urls = new Set(evts.filter((e) => e.type === 'observe' && e.url).map((e) => String(e.url)))
  const notes = evts.filter((e) => e.type === 'result' && String(e.label ?? '').includes('노트 기록') && e.ok).length
  const reports = evts.filter((e) => e.type === 'report')
  const reportPath = reports.map((r) => r.path).filter(Boolean).pop() ?? null
  const offHost = [...urls].filter((u) => { try { const h = new URL(u).hostname; return !site.hosts.some((a) => h === a || h.endsWith('.' + a)) } catch { return false } })

  out.evidence = {
    state: task.state, stepsUsed: task.stepsUsed, llmCalls: task.llmCalls,
    distinctPages: urls.size, pages: [...urls].slice(0, 12),
    notes, reportPath, reportExists: reportPath ? fs.existsSync(reportPath) : false,
    offHostVisits: offHost, result: String(task.result ?? '').slice(0, 500),
  }

  const problems = []
  if (sustain) {
    // 지속 실행의 합격 기준은 "완성물"이 아니라 **살아서 계속 일했는가** 다.
    // 시간 예산으로 끝나므로 상태는 interrupted 가 정상이다(그게 실패가 아님을 여기서 명시한다).
    const ranMin = out.ms / 60000
    const wantMin = args.sustainMin * 0.8   // 네트워크·모델 지연을 감안해 80% 이상 돌았으면 지속으로 본다
    if (ranMin < wantMin) problems.push(`요청 ${args.sustainMin}분 중 ${ranMin.toFixed(1)}분만 돌고 멈춤`)
    if (urls.size < 3) problems.push(`탐색한 페이지 ${urls.size}개(3개 이상 요구)`)
    if (notes < 3) problems.push(`노트 ${notes}개(3개 이상 요구)`)
    // 구간이 2개 이상 지나가야 "구간을 이어 붙여 계속 간다"가 증명된다(한 구간만 길게 돈 것과 구분).
    if ((out.maxSegment ?? 0) < 2) problems.push(`구간 ${out.maxSegment ?? 0}개만 지남(2개 이상 요구 — 이어가기 구조 증명)`)
    if (offHost.length > 0) problems.push(`허용 사이트 밖 방문 ${offHost.length}건`)
    if (task.state === 'failed') problems.push(`작업 실패: ${String(task.result ?? '').slice(0, 160)}`)
    if (task.state === 'cancelled') problems.push('작업이 취소됨')
    out.evidence.sustainMinutes = +ranMin.toFixed(1)
    out.evidence.maxSegment = out.maxSegment ?? 0
    out.evidence.note = '실제 시계 기준 지속 실행이다. 24시간 연속 실행의 증거가 아니다(미실시).'
  } else {
    if (urls.size < 2) problems.push(`다단계 아님(관찰한 페이지 ${urls.size}개)`)
    if (notes < 2) problems.push(`노트 ${notes}개(2개 이상 요구)`)
    if (!out.evidence.reportExists) problems.push('보고서 파일이 실제로 없음')
    if (offHost.length > 0) problems.push(`허용 사이트 밖 방문 ${offHost.length}건`)
    if (task.state === 'failed') problems.push(`작업 실패: ${String(task.result ?? '').slice(0, 160)}`)
    if (task.state === 'cancelled') problems.push('작업이 취소됨')
  }

  if (problems.length === 0) {
    out.status = 'PASS'
    out.detail = sustain
      ? `실제 ${(out.ms / 60000).toFixed(1)}분 지속 · 구간 ${out.maxSegment}개 · ${urls.size}개 페이지 · 노트 ${notes}개 · ${task.stepsUsed}단계 · 모델 ${task.llmCalls}회 (상태 ${task.state} — 시간 예산 종료가 정상)`
      : `${urls.size}개 페이지·노트 ${notes}개·보고서 저장 · 상태 ${task.state} · ${task.stepsUsed}단계 · 모델 ${task.llmCalls}회 · ${Math.round(out.ms / 1000)}초`
  } else {
    // interrupted(단계 소진)는 "실패"가 아니라 "미완"이다 — 그대로 적는다.
    out.status = task.state === 'interrupted' ? 'GAP' : 'FAIL'
    out.detail = `${problems.join(' / ')} (상태 ${task.state}, ${task.stepsUsed}단계)`
  }
  // 결과 파일은 실제 다운로드 폴더에 생긴다 — 파일럿이 만든 것만 치운다.
  if (reportPath && fs.existsSync(reportPath)) {
    try { fs.copyFileSync(reportPath, path.join(args.out, `${site.id}-report.md`)); fs.rmSync(reportPath, { force: true }) } catch { /* ignore */ }
  }
  return out
}

main().catch((e) => { console.error(e); process.exit(1) })
