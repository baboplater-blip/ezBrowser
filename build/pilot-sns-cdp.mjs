#!/usr/bin/env node
// pilot-sns-cdp.mjs — 실사이트 SNS 게시 파일럿 드라이버 (사용자 실제 프로필·로그인 세션 사용)
//
// ⚠ 게이트 미등록. 사용자가 "테스트 게시 승인" 을 준 뒤에만 사람이 돌린다. 실제 계정에 올라간다.
// 앱은 이미 --remote-debugging-port 로 떠 있어야 한다(이 스크립트는 앱을 띄우지 않는다 — 실제 프로필을 쓰므로).
//
// 사용:
//   node build/pilot-sns-cdp.mjs --check                      로그인 상태만 확인(게시 안 함)
//   node build/pilot-sns-cdp.mjs --mode draft --file photos/test-post.jpg --caption "..."   게시 직전까지
//   node build/pilot-sns-cdp.mjs --mode publish --file ... --caption "..."                 실제 게시
// 결과: verify-out/sns-pilot/<mode>-<ts>.json (이벤트 전체) + 콘솔 요약

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectSession, getTargetList, connectShellSessionReady, ensureSessionReady } from './lib/cdp.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const args = { port: 9299, mode: 'check', platform: 'instagram', file: '', caption: '', tags: [], out: path.join(REPO, 'verify-out', 'sns-pilot'), timeoutMs: 12 * 60000 }
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '--port') args.port = Number(process.argv[++i])
  else if (a === '--check') args.mode = 'check'
  else if (a === '--mode') args.mode = process.argv[++i]
  else if (a === '--platform') args.platform = process.argv[++i]
  else if (a === '--file') args.file = process.argv[++i]
  else if (a === '--caption') args.caption = process.argv[++i]
  else if (a === '--tags') args.tags = process.argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const NL = String.fromCharCode(10)
const evalIn = async (s, expression, awaitPromise = false, timeoutMs = 60000) => {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, timeoutMs)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.result?.value ?? r.result?.value
}
const OPEN = { instagram: 'https://www.instagram.com/', youtube: 'https://studio.youtube.com/', tiktok: 'https://www.tiktok.com/upload' }

async function main() {
  fs.mkdirSync(args.out, { recursive: true })
  const shell = await connectShellSessionReady(args.port)
  const windowId = await evalIn(shell, 'new URL(location.href).searchParams.get("windowId")')
  const cfg = await evalIn(shell, 'window.browserAPI.ai.config()', true).catch(() => null)
  console.log('AI 제공자:', cfg?.label ?? cfg?.provider ?? '(?)', '· 키/CLI:', cfg?.hasKey)

  // 플랫폼 탭 열기(있으면 재사용)
  const url = OPEN[args.platform]
  const tabs = await evalIn(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)})`, true)
  let tab = (tabs || []).find((t) => String(t.url).includes(new URL(url).host))
  if (!tab) {
    tab = await evalIn(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(url)})`, true)
    await sleep(6000)
  } else {
    await evalIn(shell, `window.browserAPI.tabs.activate(${JSON.stringify(tab.id)})`, true).catch(() => {})
    await sleep(1500)
  }
  // 로그인 상태 — 페이지 텍스트로 판정(자격증명은 절대 다루지 않는다)
  let pageTarget = null
  for (let i = 0; i < 30 && !pageTarget; i++) { pageTarget = (await getTargetList(args.port)).find((t) => t.type === 'page' && String(t.url).includes(new URL(url).host)); if (!pageTarget) await sleep(500) }
  if (!pageTarget) throw new Error('플랫폼 탭 타깃을 찾지 못함')
  const page = await connectSession(pageTarget, 'page')
  await ensureSessionReady(page)
  await sleep(1500)
  const info = await evalIn(page, `(() => { const t = (document.body && document.body.innerText || '').slice(0, 4000); return { url: location.href, title: document.title, hasLogin: /비밀번호|Password|새 계정 만들기|Sign up/.test(t), hasCreate: /(^|[^계정 ])만들기|새 게시물|Create new post/.test(t.replace(/새 계정 만들기/g, '')), textHead: t.replace(/\\s+/g, ' ').slice(0, 200) } })()`)
  console.log('페이지:', info.url, '·', info.title)
  console.log('로그인 추정:', info.hasLogin ? '❌ 로그인 화면' : '✅ 로그인 화면 아님(피드/스튜디오)', '·', info.textHead)
  if (args.mode === 'check') { page.close(); shell.close(); return }
  if (info.hasLogin) { console.log('로그인이 필요합니다 — 브라우저에서 직접 로그인한 뒤 다시 실행하세요.'); page.close(); shell.close(); process.exit(2) }

  // 태스크 빌드 + 실행
  const built = await evalIn(shell, `window.browserAPI.ai.snsBuildTask(${JSON.stringify({ platform: args.platform, mode: args.mode === 'publish' ? 'publish' : 'draft', file: args.file, caption: args.caption, tags: args.tags, autoOpen: false })})`, true)
  const reqId = `pilot-${args.mode}-${Date.now()}`
  // 리스너는 외피 창에 한 번만 — 같은 창에서 두 번 돌리면 이벤트가 중복 기록된다(첫 파일럿에서 실제로 겪음).
  await evalIn(shell, 'window.__pev = []; if (!window.__pevHooked) { window.__pevHooked = true; window.browserAPI.ai.onAgentEvent((e) => window.__pev.push({ ...e, t: Date.now() })) } true')
  const t0 = Date.now()
  await evalIn(shell, `window.browserAPI.ai.agentStart(${JSON.stringify({ reqId, tabId: tab.id, task: built.task })})`, true)
  console.log(`에이전트 시작 (${args.mode}) — reqId ${reqId}`)
  let evs = []
  let printed = 0
  const deadline = Date.now() + args.timeoutMs
  while (Date.now() < deadline) {
    evs = JSON.parse(await evalIn(shell, 'JSON.stringify(window.__pev.map(e => ({ ...e, shot: undefined })))') ?? '[]')
    for (; printed < evs.length; printed++) {
      const e = evs[printed]
      const line = e.type === 'observe' ? `🔍 관찰 #${e.step} 요소 ${e.elements}` : e.type === 'thought' ? `💭 ${String(e.thought ?? '').slice(0, 120)}` : e.type === 'action' ? `⚙️ ${e.label}` : e.type === 'result' ? `${e.ok ? '✔' : '✖'} ${e.label} — ${String(e.detail ?? '').slice(0, 140)}` : e.type === 'usage' ? `🧮 usage in ${e.input} cacheR ${e.cacheRead} cacheW ${e.cacheCreate} out ${e.output}` : e.type === 'confirm' ? `⚠ 확인 요청: ${String(e.label ?? e.message ?? '')}` : e.type === 'ask' ? `❓ 질문: ${e.message}` : e.type === 'done' ? `🏁 ${e.message}` : e.type === 'error' ? `💥 ${e.message}` : `· ${e.type}`
      console.log(`[${Math.round((e.t - t0) / 1000)}s] ${line}`)
    }
    // 확인 요청은 사용자 승인(테스트 게시 1건)을 근거로 승인 — 단 돈·삭제(critical)는 자동 승인되지 않음(앱 게이트)
    const pending = evs.filter((e) => e.type === 'confirm').length - evs.filter((e) => e.type === 'confirm-resolved').length
    if (evs.some((e) => e.type === 'confirm') && !evs.some((e) => e.type === 'result' && e.label === '__confirmed')) {
      // 한 번만 승인 신호를 보낸다(중복 방지용 로컬 표식)
      const last = evs[evs.length - 1]
      if (last.type === 'confirm') { await evalIn(shell, `window.browserAPI.ai.agentConfirm(${JSON.stringify(reqId)}, true)`, true).catch(() => {}); await evalIn(shell, 'window.__pev.push({ type: "result", label: "__confirmed", ok: true, t: Date.now() }); true') }
    }
    if (evs.length && evs[evs.length - 1].type === 'ask') { console.log('   → 질문에는 답하지 않고 중단합니다(사람이 확인).'); await evalIn(shell, `window.browserAPI.ai.agentCancel(${JSON.stringify(reqId)})`, true).catch(() => {}); break }
    if (evs.some((e) => e.type === 'done' || e.type === 'error' || e.type === 'cancelled')) break
    await sleep(700)
    void pending
  }
  const steps = evs.filter((e) => e.type === 'observe').length
  const calls = evs.filter((e) => e.type === 'usage').length
  const end = evs.find((e) => e.type === 'done' || e.type === 'error' || e.type === 'cancelled')
  const summary = { mode: args.mode, platform: args.platform, steps, llmCalls: calls, wallSec: Math.round(((end?.t ?? Date.now()) - t0) / 1000), end: end?.type ?? 'timeout', message: String(end?.message ?? ''), completionSignal: evs.some((e) => e.type === 'result' && e.label === '완료 신호 확인') }
  const file = path.join(args.out, `${args.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.writeFileSync(file, JSON.stringify({ args: { ...args }, summary, events: evs }, null, 2))
  console.log(NL + '요약:', JSON.stringify(summary))
  console.log('기록:', file)
  page.close(); shell.close()
}

main().catch((err) => { console.error('pilot 실패:', err); process.exit(1) })
