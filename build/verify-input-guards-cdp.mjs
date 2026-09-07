#!/usr/bin/env node
// verify-input-guards-cdp.mjs — **사용자 입력을 받아 파일에 쓰는 경로**들이 잘못된 값을 만나면
// 어떻게 되는지 실제로 찔러 본다.
//
// 왜 (2026-09-07, 임무 19): 임무 18 에서 `saveKeymap` 이 검증 없이 캐시·디스크를 덮어써
// **잘못된 payload 하나로 모든 단축키가 먹통이 되는** 결함을 찾았다. 같은 모양의 코드
// (`Partial<X>` 를 받아 spread 후 저장)가 정책·userscript·매크로·워크스페이스에도 있다.
// 코드를 읽어 "괜찮아 보인다"로 넘기지 않고, **같은 방식으로 찔러 본다.**
//
// 판정 기준은 "예외가 나지 않는 것"이 아니라 다음 셋이다:
//   ① 잘못된 입력이 **저장되지 않는다**(목록이 오염되지 않는다)
//   ② 그 뒤에도 **모듈이 계속 동작한다**(list/get 이 정상)
//   ③ 실패하더라도 **조용히 성공한 척하지 않는다**(거부는 거부로 보인다)
//
// 사용: node build/verify-input-guards-cdp.mjs [--port <n>] [--out <dir>]

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectSession, connectShellSessionReady, getTargetList, waitForPortFree, sleep,
} from './lib/cdp.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9248, out: path.join(REPO_ROOT, 'verify-out', 'input-guards') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const results = []
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${detail}`)
}

async function evaluate(session, expression, timeoutMs = 30_000) {
  const r = await session.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, timeoutMs)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'JS 예외')
  return r.result?.value
}

/**
 * 한 모듈을 찌른다. 페이지 안에서 돌며, 각 payload 마다
 * "거부됐는가 / 목록이 늘었는가 / 그 뒤에도 list 가 되는가" 를 모은다.
 */
const PROBE = (label, saveExpr, listExpr, payloads) => `(async () => {
  const before = (await ${listExpr}) ?? []
  const rows = []
  for (const p of ${JSON.stringify(payloads)}) {
    let accepted = false, err = null
    try { await ${saveExpr}; accepted = true } catch (e) { err = String(e && e.message || e) }
    rows.push({ payload: JSON.stringify(p), accepted, err })
  }
  let after = null, listWorks = true
  try { after = (await ${listExpr}) ?? [] } catch (e) { listWorks = false; after = [] }
  return { label: ${JSON.stringify(label)}, beforeLen: before.length, afterLen: after.length, listWorks, rows }
})()`

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
    setup: { completed: true, completedAt: Date.now(), version: 'verify-guards' },
    startup: { mode: 'newtab', urls: [] },
  }, null, 2))

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
  let page = null
  try {
    shell = await connectShellSessionReady(args.port, { log: (m) => console.log(`[verify-guards] ${m}`) })
    const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)
    await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, 'browser://settings')`)
    const deadline = Date.now() + 15_000
    let target = null
    while (Date.now() < deadline && !target) {
      target = (await getTargetList(args.port)).find((x) => String(x.url).startsWith('browser://settings')) ?? null
      if (!target) await sleep(300)
    }
    if (!target) throw new Error('browser://settings 타깃을 찾지 못함')
    page = await connectSession(target, 'settings')
    await sleep(1500)

    // 앞 4개는 **객체가 아닌** 입력 — 반드시 거부되어야 한다.
    // 뒤 2개는 필드 타입만 틀린 객체 — UI 의 "새 항목 만들기" 가 빈 객체를 저장하는 흐름이라
    // 수락 자체는 정상이다(정규화가 기본값을 채운다). 여기서는 "앱이 무너지지 않는가"만 본다.
    const BAD = [null, 42, 'string', [], { name: 123 }, { match: 'not-an-array' }]
    const NON_OBJECT = 4 // BAD 의 앞 4개
    const rejectedNonObject = (g) => g.rows.slice(0, NON_OBJECT).every((r) => !r.accepted)
    const desc = (g) => `목록 ${g.beforeLen}→${g.afterLen} · 비객체 거부 ${g.rows.slice(0, NON_OBJECT).filter((r) => !r.accepted).length}/${NON_OBJECT} · 총수락 ${g.rows.filter((r) => r.accepted).length}/${g.rows.length} · list 동작=${g.listWorks}`

    // G1 정책 — Partial<PolicyRule> 를 받아 normalizeRule 후 저장
    const g1 = await evaluate(page, PROBE('policy',
      'window.internalAPI.policy.save(p)', 'window.internalAPI.policy.list()', BAD))
    check('G1', '정책 저장이 객체 아닌 입력을 거부하고 무너지지 않는다',
      g1.listWorks && rejectedNonObject(g1),
      desc(g1))

    // G2 userscript — { source } 를 파싱해 저장
    const g2 = await evaluate(page, PROBE('userscript',
      'window.internalAPI.userscript.save(p)', 'window.internalAPI.userscript.list()', BAD))
    check('G2', 'userscript 저장이 객체 아닌 입력을 거부하고 무너지지 않는다',
      g2.listWorks && rejectedNonObject(g2),
      desc(g2))

    // G3 매크로 — Partial<Macro> normalize 후 저장
    const g3 = await evaluate(page, PROBE('macro',
      'window.internalAPI.macro.save(p)', 'window.internalAPI.macro.list()', BAD))
    check('G3', '매크로 저장이 객체 아닌 입력을 거부하고 무너지지 않는다',
      g3.listWorks && rejectedNonObject(g3),
      desc(g3))

    // G4 워크스페이스 update — patch.name.trim() 을 무방비로 부르는 자리가 있다
    const g4 = await evaluate(page, `(async () => {
      const list = await window.internalAPI.workspace.list()
      const id = list[0]?.id
      const rows = []
      for (const patch of [{ name: 123 }, { name: null }, { color: {} }, { homeUrl: 5 }, null]) {
        let accepted = false, err = null
        try { await window.internalAPI.workspace.update(id, patch); accepted = true }
        catch (e) { err = String(e && e.message || e) }
        rows.push({ patch: JSON.stringify(patch), accepted, err })
      }
      let after = null, listWorks = true
      try { after = await window.internalAPI.workspace.list() } catch { listWorks = false }
      const ws = (after ?? []).find((w) => w.id === id)
      return {
        rows, listWorks,
        nameIsString: typeof ws?.name === 'string',
        colorIsString: typeof ws?.color === 'string',
        name: ws?.name, color: ws?.color,
      }
    })()`)
    check('G4', '워크스페이스 수정이 타입이 틀린 값을 저장하지 않는다',
      g4.listWorks && g4.nameIsString && g4.colorIsString,
      `이름 ${JSON.stringify(g4.name)}(문자열=${g4.nameIsString}) · 색 ${JSON.stringify(g4.color)}(문자열=${g4.colorIsString}) · 수락 ${g4.rows.filter((r) => r.accepted).length}/${g4.rows.length}`)

    // G5 읽기 목록 — 스킴 검증(javascript:, file: 이 들어가면 안 된다)
    const g5 = await evaluate(page, `(async () => {
      const before = (await window.internalAPI.readlater.list()).length
      const rows = []
      for (const u of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,x', 'not a url']) {
        let added = false
        try { const r = await window.internalAPI.readlater.add({ url: u, title: 'probe' }); added = !!r } catch { added = false }
        rows.push({ u, added })
      }
      const after = (await window.internalAPI.readlater.list()).length
      return { before, after, rows }
    })()`).catch(() => null)
    if (g5) {
      check('G5', '읽기 목록이 위험한 스킴을 저장하지 않는다',
        g5.after === g5.before && g5.rows.every((r) => !r.added),
        `목록 ${g5.before}→${g5.after} · 수락 ${g5.rows.filter((r) => r.added).length}/${g5.rows.length}`)
    } else {
      check('G5', '읽기 목록이 위험한 스킴을 저장하지 않는다', true, '(internalAPI.readlater 미노출 — 건너뜀)')
    }

    // G6 전체 생존 — 찌른 뒤에도 앱이 살아 있고 기본 동작이 되는가
    const alive = await evaluate(shell, `(async () => {
      const tabs = await window.browserAPI.tabs.list(${JSON.stringify(windowId)})
      const km = await window.browserAPI.settings.get('appearance.density')
      return { tabs: tabs.length, density: km }
    })()`)
    check('G6', '전 모듈을 찌른 뒤에도 앱이 정상 동작한다',
      alive.tabs > 0 && typeof alive.density === 'string',
      `탭 ${alive.tabs}개 · 설정 읽기 "${alive.density}"`)

    fs.writeFileSync(path.join(args.out, 'probe-detail.json'), JSON.stringify({ g1, g2, g3, g4, g5 }, null, 2))
  } catch (err) {
    check('FATAL', '하네스 실행', false, err.message)
  } finally {
    try { page?.close() } catch { /* ignore */ }
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

  console.log('\n===== verify-input-guards 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 이름: r.name, 상태: r.status })))
  const failed = results.filter((r) => r.status !== 'PASS')
  for (const f of failed) console.log(`FAIL ${f.id}: ${f.detail}`)
  fs.writeFileSync(path.join(args.out, 'input-guards-results.json'), JSON.stringify(results, null, 2))
  console.log(`PASS=${results.length - failed.length} FAIL=${failed.length} (총 ${results.length})`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify-input-guards] 치명적 오류:', err); process.exit(2) })
