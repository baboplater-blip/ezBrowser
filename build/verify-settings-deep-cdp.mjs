#!/usr/bin/env node
// verify-settings-deep-cdp.mjs — 설정 페이지의 **되돌릴 수 없는 동작**을 실측 검증한다.
//
// 왜 (2026-09-07, 임무 18): 임무 17 은 설정 화면의 표시·반영·렌더까지 덮었지만,
// **데이터 내보내기/가져오기**와 **키맵 편집**은 성격이 다르다 — 잘못되면 사용자 데이터가
// 사라지거나 덮어써지고, 단축키가 먹통이 된다. 되돌릴 수 없는 동작일수록 검증이 필요하다.
//
// 특히 가져오기는 **파일 경로를 받아 사용자 데이터 디렉터리에 쓰는** 코드다.
// 화이트리스트·경로 이탈 방어가 실제로 작동하는지는 "코드를 읽어서"가 아니라 **찔러 봐서** 안다.
//
// 검사는 설정 페이지의 컨텍스트에서 `internalAPI` 를 직접 호출한다 — 페이지가 실제로 쓰는 경로다.
//
// 사용: node build/verify-settings-deep-cdp.mjs [--port <n>] [--out <dir>]

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

const args = { port: 9247, out: path.join(REPO_ROOT, 'verify-out', 'settings-deep') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const results = []
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}

async function evaluate(session, expression, timeoutMs = 25_000) {
  const r = await session.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, timeoutMs)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'JS 예외')
  return r.result?.value
}

async function main() {
  fs.mkdirSync(args.out, { recursive: true })
  if (!fs.existsSync(EXE)) {
    console.error(`exe 없음: ${EXE} — 먼저 npx electron-builder --win --dir`)
    process.exit(2)
  }
  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true, completedAt: Date.now(), version: 'verify-deep' },
    startup: { mode: 'newtab', urls: [] },
  }, null, 2))

  // 고정 포트가 앞선 실행의 잔재에 물려 있으면 빈 포트로 대체한다(실행이 통째로 죽지 않게).
  args.port = await preferFreePort(args.port, 'verify-settings-deep-cdp.mjs')
  if (!(await waitForPortFree(args.port))) {
    console.error(`디버그 포트 ${args.port} 사용 중 — 남은 인스턴스를 종료하세요.`)
    process.exit(2)
  }

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`], {
    env, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.pipe(fs.createWriteStream(path.join(args.out, 'app-stdout.log')))
  child.stderr?.pipe(fs.createWriteStream(path.join(args.out, 'app-stderr.log')))

  let shell = null
  let settings = null
  try {
    shell = await connectShellSessionReady(args.port, { log: (m) => console.log(`[verify-deep] ${m}`) })
    const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)

    await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, 'browser://settings')`)
    const deadline = Date.now() + 15_000
    let target = null
    while (Date.now() < deadline && !target) {
      target = (await getTargetList(args.port)).find((x) => String(x.url).startsWith('browser://settings')) ?? null
      if (!target) await sleep(300)
    }
    if (!target) throw new Error('browser://settings 타깃을 찾지 못함')
    settings = await connectSession(target, 'settings')
    await sleep(1500)

    // ── D1: 내보내기가 알려진 데이터를 담는가 ────────────────────────────
    const MARK = `verify-deep-${Date.now()}`
    await evaluate(shell, `window.browserAPI.settings.set('appearance.density', 'compact')`)
    await evaluate(shell, `window.browserAPI.bookmarks.add({ url: 'https://example.com/${MARK}', title: ${JSON.stringify(MARK)} })`)
      .catch(() => {}) // 북마크 API 시그니처가 다르면 설정만으로 검증한다
    await sleep(800)

    const exported = await evaluate(settings, `(async () => {
      const b = await window.internalAPI.data.export()
      const files = (b && b.files) ? Object.keys(b.files) : []
      const settingsRaw = (b && b.files && b.files['settings.json']) ? b.files['settings.json'].content : ''
      return { version: b?.version, files, hasSettings: files.includes('settings.json'),
               settingsHasDensity: /compact/.test(String(settingsRaw)) }
    })()`, 60_000)
    check('D1', '내보내기가 설정을 포함한 번들을 만든다',
      exported.version === 1 && exported.hasSettings && exported.settingsHasDensity,
      `version=${exported.version} · 파일 ${exported.files.length}개 · settings.json 에 방금 바꾼 값 포함=${exported.settingsHasDensity}`)

    // ── D2: 가져오기가 화이트리스트 밖·경로 이탈을 거부하는가 ─────────────
    // 되돌릴 수 없는 쓰기 경로다. 코드를 읽어 안심하지 말고 실제로 찔러 본다.
    const evil = await evaluate(settings, `(async () => {
      const bundle = { version: 1, files: {
        '../../evil-escape.json': { encoding: 'utf-8', content: 'x' },
        'not-allowed.json':       { encoding: 'utf-8', content: 'x' },
        'userscripts/../../up.json': { encoding: 'utf-8', content: 'x' },
      } }
      const r = await window.internalAPI.data.import(bundle)
      return { restored: r?.restored, errors: r?.errors ?? [] }
    })()`, 60_000)
    const outsideWritten = fs.existsSync(path.join(path.dirname(profileDir), 'evil-escape.json'))
      || fs.existsSync(path.join(REPO_ROOT, 'evil-escape.json'))
    check('D2', '가져오기가 화이트리스트 밖·경로 이탈 항목을 전부 거부한다',
      exported.version === 1 && evil.restored === 0 && evil.errors.length === 3 && !outsideWritten,
      `복원 ${evil.restored}건 · 거부 ${evil.errors.length}건 · 프로필 밖 파일 생성=${outsideWritten}`)

    // ── D3: 왕복 — 내보낸 뒤 값을 바꾸고 다시 가져오면 복원되는가 ─────────
    const roundTrip = await evaluate(settings, `(async () => {
      const bundle = await window.internalAPI.data.export()
      await window.internalAPI.settings.set('appearance.density', 'roomy')
      const mid = await window.internalAPI.settings.get('appearance.density')
      const r = await window.internalAPI.data.import(bundle)
      return { mid, restored: r?.restored, errors: r?.errors ?? [] }
    })()`, 60_000)
    // 가져오기는 파일을 덮어쓰고 **재시작 시 반영**된다(electron-store 싱글턴이 부팅 때 로드).
    // 그러므로 여기서는 "파일이 실제로 되돌아갔는지"를 디스크에서 확인한다.
    await sleep(1000)
    let onDisk = ''
    try { onDisk = fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf8') } catch { /* ignore */ }
    check('D3', '내보내기→변경→가져오기 왕복이 파일을 되돌린다',
      roundTrip.mid === 'roomy' && roundTrip.restored > 0 && /compact/.test(onDisk),
      `중간값 ${roundTrip.mid} · 복원 ${roundTrip.restored}건 · 디스크 settings.json 에 compact 복귀=${/compact/.test(onDisk)}`)

    // ── K1: 키맵을 읽는다 (실제 계약: { keymap: {version, bindings}, conflicts }) ─────
    const km = await evaluate(settings, `(async () => {
      const r = await window.internalAPI.keymap.get()
      const list = r?.keymap?.bindings ?? []
      return { count: list.length, sample: list[0] ?? null, conflicts: (r?.conflicts ?? []).length }
    })()`, 60_000)
    check('K1', '키맵을 읽어 바인딩 목록을 얻는다',
      km.count > 0 && km.sample !== null,
      `바인딩 ${km.count}개 · 충돌 ${km.conflicts}개 · 예: ${JSON.stringify(km.sample)}`)

    // ── K2: 편집이 저장되고 기본값 복원이 되돌리는가 ─────────────────────
    const PROBE_KEY = 'Ctrl+Alt+Shift+F9'
    const edit = await evaluate(settings, `(async () => {
      const r0 = await window.internalAPI.keymap.get()
      const list = [...(r0?.keymap?.bindings ?? [])]
      const probe = { action: 'action.tab.new', key: ${JSON.stringify(PROBE_KEY)}, when: 'global' }
      const next = { version: r0?.keymap?.version ?? 1, bindings: [...list.filter((b) => b.key !== probe.key), probe] }
      await window.internalAPI.keymap.set(next)
      const r1 = await window.internalAPI.keymap.get()
      const saved = (r1?.keymap?.bindings ?? []).some((b) => b.key === probe.key && b.action === probe.action)
      await window.internalAPI.keymap.reset()
      const r2 = await window.internalAPI.keymap.get()
      const afterList = r2?.keymap?.bindings ?? []
      return { saved, restored: !afterList.some((b) => b.key === probe.key), count: afterList.length }
    })()`, 60_000)
    check('K2', '키맵 편집이 저장되고 기본값 복원이 되돌린다',
      edit.saved === true && edit.restored === true,
      `저장됨=${edit.saved} · 복원 후 사라짐=${edit.restored} · 복원 후 ${edit.count}개`)

    // ── K3: 잘못된 키맵을 보내면 **거부되고 기존 키맵이 살아남는가** ──────
    // 2026-09-07 임무 18 에서 찾은 결함의 회귀 검사: 예전에는 검증 없이 덮어써서
    // 배열 하나로 모든 단축키가 먹통이 되고 그 상태가 디스크에 저장됐다.
    const guard = await evaluate(settings, `(async () => {
      const before = (await window.internalAPI.keymap.get())?.keymap?.bindings?.length ?? 0
      const bad = []
      for (const payload of [[], { version: 1 }, { version: 1, bindings: [{ nope: 1 }] }, null]) {
        try { await window.internalAPI.keymap.set(payload); bad.push({ payload: JSON.stringify(payload), accepted: true }) }
        catch (e) { bad.push({ payload: JSON.stringify(payload), accepted: false }) }
      }
      let after = -1
      try { after = (await window.internalAPI.keymap.get())?.keymap?.bindings?.length ?? -1 } catch { after = -1 }
      return { before, after, accepted: bad.filter((b) => b.accepted).length }
    })()`, 60_000)
    check('K3', '잘못된 키맵을 거부하고 기존 단축키가 살아남는다 (회귀 검사)',
      guard.accepted === 0 && guard.after === guard.before && guard.before > 0,
      `거부 실패 ${guard.accepted}건 · 바인딩 ${guard.before} → ${guard.after}`)

  } catch (err) {
    check('FATAL', '하네스 실행', false, err.message)
  } finally {
    try { settings?.close() } catch { /* ignore */ }
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

  console.log('\n===== verify-settings-deep 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 이름: r.name, 상태: r.status })))
  const failed = results.filter((r) => r.status !== 'PASS')
  for (const f of failed) console.log(`FAIL ${f.id}: ${f.detail}`)
  fs.writeFileSync(path.join(args.out, 'settings-deep-results.json'), JSON.stringify(results, null, 2))
  console.log(`PASS=${results.length - failed.length} FAIL=${failed.length} (총 ${results.length})`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify-settings-deep] 치명적 오류:', err); process.exit(2) })
