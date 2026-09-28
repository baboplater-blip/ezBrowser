// 새 탭 픽셀 친구(pages/newtab/buddy.js) 실기 검증.
//  B1 무대가 보이고 캔버스에 실제로 그려진다  B2 시간이 지나면 그림이 바뀐다(애니메이션)
//  B3 새를 클릭하면 말풍선이 뜬다          B4 탭이 숨으면 타이머가 멈춘다(휴식 CPU 0)
//  B5 설정에서 끄면 무대도 스크립트도 없다(끄면 비용 0)
//  B6 절기 날짜마다 맞는 연출이 켜지고, 평일·표 밖의 해에는 켜지지 않는다(?buddyDate= 로 날짜 지정)
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectSession, connectShellSessionReady, getTargetList, waitForPortFree, sleep,
} from './lib/cdp.mjs'
import { preferFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9261, out: path.join(REPO_ROOT, 'verify-out', 'newtab-buddy') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const results = []
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}

async function evaluate(session, expression, timeoutMs = 20_000) {
  const r = await session.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, timeoutMs)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'JS 예외')
  return r.result?.value
}

async function main() {
  fs.mkdirSync(args.out, { recursive: true })
  if (!fs.existsSync(EXE)) { console.error(`exe 없음: ${EXE}`); process.exit(2) }
  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true, completedAt: Date.now(), version: 'verify-buddy' },
    startup: { mode: 'newtab', urls: [] },
    // 날씨는 네트워크 의존이라 끈다 — 이 검증은 새 자체만 본다
    widgets: { weatherEnabled: false, newsEnabled: false },
  }, null, 2))
  args.port = await preferFreePort(args.port, 'verify-newtab-buddy-cdp.mjs')
  if (!(await waitForPortFree(args.port))) { console.error(`디버그 포트 ${args.port} 사용 중`); process.exit(2) }

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`], {
    env, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.pipe(fs.createWriteStream(path.join(args.out, 'app-stdout.log')))
  child.stderr?.pipe(fs.createWriteStream(path.join(args.out, 'app-stderr.log')))

  let shell = null
  let memSession = null
  try {
    shell = await connectShellSessionReady(args.port, { log: (m) => console.log(`[verify-buddy] ${m}`) })
    const findNewtab = async () => {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const t = (await getTargetList(args.port)).find((x) => String(x.url).startsWith('browser://newtab'))
        if (t) return t
        await sleep(300)
      }
      return null
    }
    const nt = await findNewtab()
    if (!nt) throw new Error('browser://newtab 타깃을 찾지 못함')
    memSession = await connectSession(nt, 'newtab')
    // 테스트 창이 다른 창 뒤에 깔리면 Windows 창 가림 판정으로 Chromium 이 타이머를 늦춘다(실측: 8초에 4틱).
    // 사용자가 보고 있는 상황을 재현하려고 앞으로 가져오고 포커스를 흉내낸다.
    await memSession.send('Page.bringToFront', {}, 5000).catch(() => {})
    await memSession.send('Emulation.setFocusEmulationEnabled', { enabled: true }, 5000).catch(() => {})
    await sleep(2000)

    // 캔버스 픽셀 요약: 칠해진 칸 수 + 간단한 해시
    const snap = `(() => {
      const c = document.getElementById('buddy-canvas'); const s = document.getElementById('buddy-stage')
      if (!c || !s) return null
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      let n = 0, h = 0
      for (let i = 3; i < d.length; i += 4) if (d[i]) { n++; h = (h * 31 + i + d[i - 3]) | 0 }
      return { shown: getComputedStyle(s).display !== 'none' && s.offsetHeight > 0, painted: n, hash: h,
        script: !!document.getElementById('buddy-script') }
    })()`

    const env0 = await evaluate(memSession, `({ hidden: document.hidden, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, hour: new Date().getHours() })`)
    console.log('  환경:', JSON.stringify(env0))
    const a = await evaluate(memSession, snap)
    check('B1', '무대가 보이고 캔버스에 새가 그려진다', !!a && a.shown && a.painted > 200,
      a ? `표시 ${a.shown} · 칠해진 픽셀 ${a.painted}` : '무대 없음')

    const tick = () => evaluate(memSession, 'window.bbBuddy ? window.bbBuddy.tick : -1')
    const t0 = await tick()
    const hashes = new Set([a?.hash])
    for (let i = 0; i < 40; i++) { await sleep(200); hashes.add((await evaluate(memSession, snap))?.hash) }
    const t1 = await tick()
    check('B2', '시간이 지나면 그림이 바뀐다(애니메이션)', t1 - t0 >= 50 && hashes.size >= 3,
      `8초간 틱 ${t1 - t0}회(10fps 기대 ≈80) · 서로 다른 프레임 ${hashes.size}개`)

    const shot = await memSession.send('Page.captureScreenshot', { format: 'png' }, 15_000).catch(() => null)
    if (shot?.data) fs.writeFileSync(path.join(args.out, 'newtab-buddy.png'), Buffer.from(shot.data, 'base64'))

    const bubble = await evaluate(memSession, `(async () => {
      const c = document.getElementById('buddy-canvas'); const r = c.getBoundingClientRect()
      // 새는 무대 가운데에서 시작하지만 걸어다니므로, 칠해진 열의 중앙을 찾아 누른다
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      let sx = 0, cnt = 0
      for (let y = Math.floor(c.height / 2); y < c.height; y++)
        for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3]) { sx += x; cnt++ }
      const cx = r.left + (cnt ? sx / cnt : c.width / 2) * (r.width / c.width)
      c.dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: r.bottom - 10, bubbles: true }))
      await new Promise((res) => setTimeout(res, 300))
      const b = document.getElementById('buddy-bubble')
      return { show: b.classList.contains('show'), text: b.textContent }
    })()`)
    check('B3', '새를 클릭하면 말풍선이 뜬다', bubble.show && bubble.text.length > 0, `말풍선 "${bubble.text}"`)

    // B4: 탭이 숨으면 멈춘다 — 다른 탭을 활성화해 newtab 을 숨긴다
    const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)
    const ntTabId = await evaluate(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)}).then((t) => t.find((x) => String(x.url).startsWith('browser://newtab'))?.id)`)
    // 앞에서 켠 포커스 흉내는 "보이는 중" 으로 판정을 끌어당길 수 있어 먼저 끈다
    await memSession.send('Emulation.setFocusEmulationEnabled', { enabled: false }, 5000).catch(() => {})
    await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, 'about:blank')`)
    for (let i = 0; i < 20 && !(await evaluate(memSession, 'document.hidden')); i++) await sleep(250)
    const hidden = await evaluate(memSession, 'document.hidden')
    const k1 = await tick()
    await sleep(2500)
    const k2 = await tick()
    check('B4', '탭이 숨으면 그리기를 멈춘다', hidden === true && k1 === k2 && k1 > 0,
      `hidden=${hidden} · 숨은 2.5초 동안 틱 ${k2 - k1}회`)
    if (ntTabId) await evaluate(shell, `window.browserAPI.tabs.activate(${JSON.stringify(ntTabId)})`).catch(() => {})
    await sleep(800)

    // B5: 설정에서 끄면 불러오지 않는다
    await evaluate(shell, `window.browserAPI.settings.set('widgets.buddyEnabled', false)`)
    await evaluate(memSession, 'location.reload()').catch(() => {})
    await sleep(2500)
    const off = await evaluate(memSession, snap)
    check('B5', '끄면 무대도 스크립트도 없다', !!off && !off.shown && !off.script,
      off ? `표시 ${off.shown} · 스크립트 ${off.script}` : '페이지 읽기 실패')
    await evaluate(shell, `window.browserAPI.settings.set('widgets.buddyEnabled', true)`)

    // B6: 절기 — 날짜별 기대값(음력 명절은 앞뒤 하루 포함, 표 밖의 해는 없음)
    await sleep(500)
    const cases = [
      ['2026-12-25', 'christmas'], ['2026-12-31', 'newyear'], ['2027-01-02', 'newyear'],
      ['2027-02-06', 'seollal'], ['2027-02-08', 'seollal'], ['2027-02-10', null],
      ['2026-09-25', 'chuseok'], ['2028-10-03', 'chuseok'], ['2026-10-31', 'halloween'],
      ['2026-07-15', null], ['2031-01-23', null],
    ]
    const wrong = []
    let painted = 0
    for (const [date, want] of cases) {
      await evaluate(memSession, `location.href = 'browser://newtab/?buddyDate=${date}'`).catch(() => {})
      let got
      for (let i = 0; i < 20; i++) {
        await sleep(250)
        got = await evaluate(memSession, 'window.bbBuddy ? window.bbBuddy.event : undefined').catch(() => undefined)
        if (got !== undefined) break
      }
      if (got !== want) wrong.push(`${date}: 기대 ${want} · 실제 ${got}`)
      if (want === 'christmas') {
        const shotX = await memSession.send('Page.captureScreenshot', { format: 'png' }, 15_000).catch(() => null)
        if (shotX?.data) fs.writeFileSync(path.join(args.out, 'newtab-buddy-christmas.png'), Buffer.from(shotX.data, 'base64'))
        painted = (await evaluate(memSession, snap))?.painted || 0
      }
    }
    check('B6', '절기 날짜마다 맞는 연출(평일·표 밖의 해는 없음)', wrong.length === 0,
      wrong.length ? wrong.join(' / ') : `${cases.length}개 날짜 전부 일치 · 크리스마스 칠해진 픽셀 ${painted}`)
  } catch (err) {
    check('FATAL', '하네스 실행', false, err.message)
  } finally {
    try { memSession?.close() } catch { /* ignore */ }
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close', {}, 5000).catch(() => {})
      b.close()
    } catch { /* ignore */ }
    await sleep(1200)
    try { shell?.close() } catch { /* ignore */ }
    if (child.exitCode === null) {
      try { child.kill() } catch { /* ignore */ }
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    }
  }

  console.log('\n===== verify-newtab-buddy 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 이름: r.name, 상태: r.status })))
  const failed = results.filter((r) => r.status !== 'PASS')
  for (const f of failed) console.log(`FAIL ${f.id}: ${f.detail}`)
  fs.writeFileSync(path.join(args.out, 'newtab-buddy-results.json'), JSON.stringify(results, null, 2))
  console.log(`PASS=${results.length - failed.length} FAIL=${failed.length} (총 ${results.length})`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify-newtab-buddy] 치명적 오류:', err); process.exit(2) })
