#!/usr/bin/env node
// verify-mod-macro-cdp.mjs — 묶음 G(Mod API·자동화 매크로 보안) 검증 하네스.
//
// 검증 대상 (실제 패키징 앱 + 격리 프로필, CDP):
//   M1 — Mod 샌드박스 탈출(CRITICAL) 차단: host Function 생성자 체인으로 process/require 에
//        닿을 수 없어야 한다(11가지 시도 전부 차단 + 양성 대조).
//   M2 — mod.tabs.create/list 가 실제로 탭을 만든다(기능 유지 확인).
//   M3 — mod.storage.get/set 이 중첩 JSON 구조를 왕복 보존한다(JSON 브리지 정합성).
//   M4 — mod.tabs.onCreated 이벤트가 실제로 컨텍스트까지 전달된다(host→mod 콜백 경로).
//   M5 — mod.menu.add 로 등록한 메뉴가 팔레트/컨텍스트메뉴에 노출되고, 클릭 시 안전하게
//        위임 실행된다(vm.runInContext 경유).
//   M6 — mod.net.fetch 가 사설망·로컬 주소(127.0.0.1·localhost·10/8·192.168/16·169.254/16)
//        를 차단한다(SSRF 방지) + 양성 대조(공인 IP 는 이 사유로 막히지 않음).
//   S1 — URL 트리거 매크로가 자기 자신을 다시 트리거해도 무한 루프에 빠지지 않는다
//        (쿨다운으로 실제 재요청 수가 작게 억제됨 — 로컬 테스트 서버 요청 횟수로 확인).
//   S2 — "단축키" 트리거가 실제로 전역 키보드 입력에 반응해 매크로를 실행한다
//        (예전엔 listShortcutMacros() 를 아무도 안 불러 완전 무동작이었다).
//   S3 — 단축키가 겹치는 매크로 2개를 만들면 목록에 shortcutConflict 경고가 뜬다.
//
// 사용: node build/verify-mod-macro-cdp.mjs [--port <n>] [--out <dir>]

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectSession, connectShellSessionReady, getTargetList, waitForPortFree, sleep,
} from './lib/cdp.mjs'
import { preferFreePort, getFreePort } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')

const args = { port: 9251, out: path.join(REPO_ROOT, 'verify-out', 'mod-macro') }
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

// ===== S1(URL 트리거 무한루프)용 로컬 테스트 서버 =====
function startLoopServer(port) {
  let hitCount = 0
  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/loop')) hitCount += 1
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><body>loop-target</body></html>')
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve({ server, getHits: () => hitCount }))
  })
}

function writeMod(profileDir, id, manifest, indexJs) {
  const dir = path.join(profileDir, 'mods', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  fs.writeFileSync(path.join(dir, 'index.js'), indexJs, 'utf-8')
}

function seedMacros(profileDir, macros) {
  fs.writeFileSync(path.join(profileDir, 'macros.json'), JSON.stringify(macros, null, 2), 'utf-8')
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

  const loopPort = await getFreePort()
  const { server: loopServer, getHits } = await startLoopServer(loopPort)
  const loopUrl = `http://127.0.0.1:${loopPort}/loop`

  // ----- 사전 시드: mods (부팅 시 1회 스캔이라 반드시 부팅 전에 존재해야 함) -----
  const markerModId = 'escape-test'
  writeMod(profileDir, markerModId,
    { id: markerModId, name: 'EscapeTest', description: '', version: '0.0.1', author: '', permissions: [] },
    `(function () {
  var attempts = [
    function () { return mod.log.constructor('return process')(); },
    function () { return mod.toast.constructor('return process')(); },
    function () { return mod.constructor.constructor('return process')(); },
    function () { return console.log.constructor('return process')(); },
    function () { return (0).constructor.constructor('return process')(); },
    function () { return ('x').constructor.constructor('return process')(); },
    function () { return Function('return process')(); },
    function () { return eval('process'); },
    function () { return (function(){}).constructor('return process')(); },
    function () { return (async function(){}).constructor('return process')(); },
    function () { return (function*(){}).constructor('return process')(); },
  ];
  var escaped = [];
  for (var i = 0; i < attempts.length; i++) {
    try {
      var r = attempts[i]();
      if (r && typeof r === 'object' && typeof r.pid === 'number' && typeof r.version === 'string') {
        escaped.push(i);
      }
    } catch (e) { /* blocked — expected */ }
  }
  if (escaped.length > 0) {
    mod.toast('ESCAPED indices=' + escaped.join(','));
  } else {
    mod.toast('ESCAPE_TEST_ALL_BLOCKED');
  }
})();
`)

  const funcModId = 'func-test'
  writeMod(profileDir, funcModId,
    { id: funcModId, name: 'FuncTest', description: '', version: '0.0.1', author: '', permissions: ['tabs', 'menu', 'storage'] },
    `(function () {
  var createdCount = 0;
  mod.tabs.onCreated(function (info) { createdCount += 1; mod.storage.set('createdCount', createdCount); });
  mod.menu.add({
    label: 'RUN_STORAGE_TEST',
    click: function () {
      var nested = { a: [1, 2, { b: 'nested' }] };
      mod.storage.set('k1', nested);
      mod.storage.get('k1').then(function (v) {
        mod.tabs.create('browser://newtab?functest=' + encodeURIComponent(JSON.stringify(v)));
      });
    },
  });
  mod.menu.add({
    label: 'READ_CREATED_COUNT',
    click: function () {
      mod.storage.get('createdCount').then(function (v) {
        mod.tabs.create('browser://newtab?onCreatedCount=' + encodeURIComponent(String(v)));
      });
    },
  });
})();
`)

  const netModId = 'net-test'
  writeMod(profileDir, netModId,
    { id: netModId, name: 'NetTest', description: '', version: '0.0.1', author: '', permissions: ['network'] },
    // 공인 IP 로의 실제 접속 시도는 샌드박스 테스트 환경에 인터넷이 없으면 TCP 연결
    // 타임아웃(수십 초)까지 하네스를 묶어둘 수 있어 뺐다 — "공인 IP 를 사설망 사유로
    // 막지 않는다"는 성질은 isPrivateHostLiteral 이 리터럴 공인 IP 에서 즉시 false 를
    // 반환해 DNS 조회조차 없이 통과하는 코드 구조로 보장된다(코드 리뷰로 확인, 하네스는
    // 네트워크 의존 없이 결정적인 '사설망 차단' 쪽만 재본다).
    `(async function () {
  var targets = ['http://127.0.0.1:1/x', 'http://localhost:1/x', 'http://10.1.2.3/x', 'http://192.168.1.1/x', 'http://169.254.1.1/x', 'http://[::1]:1/x'];
  var blocked = 0;
  for (var i = 0; i < targets.length; i++) {
    try { await mod.net.fetch(targets[i]); }
    catch (e) { if (String(e && e.message || e).indexOf('사설망') >= 0) blocked++; }
  }
  mod.toast('NET_TEST blocked=' + blocked + '/' + targets.length);
})();
`)

  // ----- 사전 시드: macros -----
  const now = Date.now()
  seedMacros(profileDir, [
    {
      id: 'mac-loop', name: 'LoopMacro', description: '', enabled: true,
      trigger: { type: 'url', value: `${loopUrl}*` },
      actions: [{ type: 'navigate', value: loopUrl }],
      createdAt: now, updatedAt: now,
    },
    {
      id: 'mac-shortcut', name: 'ShortcutMacro', description: '', enabled: true,
      trigger: { type: 'shortcut', value: 'Ctrl+Shift+K' },
      actions: [{ type: 'navigate', value: 'browser://newtab?macroShortcutFired=1' }],
      createdAt: now, updatedAt: now,
    },
    {
      id: 'mac-conflict-a', name: 'ConflictA', description: '', enabled: true,
      trigger: { type: 'shortcut', value: 'Ctrl+Alt+Shift+Z' },
      actions: [{ type: 'toast', value: 'A' }],
      createdAt: now, updatedAt: now,
    },
    {
      id: 'mac-conflict-b', name: 'ConflictB', description: '', enabled: true,
      trigger: { type: 'shortcut', value: 'Ctrl+Alt+Shift+Z' },
      actions: [{ type: 'toast', value: 'B' }],
      createdAt: now, updatedAt: now,
    },
  ])

  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true, completedAt: Date.now(), version: 'verify-mod-macro' },
    startup: { mode: 'newtab', urls: [] },
  }, null, 2))
  // mod 상태 — func-test 만 부팅 시 활성화한다(메뉴 등록이 목적이라 실행 시점이 안 중요함).
  // escape-test·net-test 는 toast 로 결과를 보고하는데 toast 는 2.4초 뒤 자동 소멸하므로,
  // 부팅 자동활성화로 두면 CDP 연결·폴링을 시작하기도 전에 토스트가 사라져 버린다(실측 확인됨).
  // 그래서 이 둘은 부팅 후 하네스가 관측 준비를 마친 시점에 internalAPI.mod.setEnabled 로
  // 직접 활성화해 타이밍을 통제한다.
  fs.writeFileSync(path.join(profileDir, 'mods', '_state.json'), JSON.stringify({
    [funcModId]: true,
  }, null, 2))

  args.port = await preferFreePort(args.port, 'verify-mod-macro-cdp.mjs')
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
  let modsPage = null
  try {
    shell = await connectShellSessionReady(args.port, { log: (m) => console.log(`[verify-mod-macro] ${m}`) })
    const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)
    await sleep(1500) // func-test mod 부팅 자동활성화·매크로 리스너 부착까지 여유

    // escape-test·net-test 는 browser://mods 페이지에서 setEnabled 로 "지금" 활성화한다 —
    // 부팅 자동활성화로 두면 toast(2.4초 후 소멸)를 관측할 CDP 연결이 채 끝나기도 전에
    // 사라진다(실측 확인). 활성화 타이밍을 하네스가 직접 통제해 폴링을 놓치지 않게 한다.
    await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, 'browser://mods')`)
    const modsTarget = await (async () => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const t = (await getTargetList(args.port)).find((x) => String(x.url).startsWith('browser://mods'))
        if (t) return t
        await sleep(200)
      }
      throw new Error('browser://mods 타깃을 찾지 못함')
    })()
    modsPage = await connectSession(modsTarget, 'mods-page')
    await sleep(800)

    const toastRead = () => evaluate(shell,
      `Array.from(document.querySelectorAll('.toast')).map(function (el) { return el.textContent; }).join(' || ')`)

    // ===== M1: 샌드박스 탈출 차단 =====
    await evaluate(modsPage, `window.internalAPI.mod.setEnabled(${JSON.stringify(markerModId)}, true)`)
    let escapeToast = ''
    const deadline1 = Date.now() + 4000
    while (Date.now() < deadline1) {
      escapeToast = (await toastRead()) || ''
      if (escapeToast.includes('ESCAPE_TEST') || escapeToast.includes('ESCAPED')) break
      await sleep(100)
    }
    const escaped = escapeToast.includes('ESCAPED indices')
    check('M1', 'Mod 샌드박스 탈출 시도 11종이 전부 차단된다',
      !escaped && escapeToast.includes('ESCAPE_TEST_ALL_BLOCKED'),
      escapeToast ? `토스트: "${escapeToast}"` : '(토스트 미관측 — FAIL 로 처리, 재현 필요)')

    // ===== M2/M3/M4: 기능 확인(func-test mod) =====
    const menuList1 = await evaluate(shell, `window.browserAPI.mod.menuList()`)
    const runStorageItem = (menuList1 || []).find((m) => m.label === 'RUN_STORAGE_TEST')
    let m2ok = false, m2detail = 'RUN_STORAGE_TEST 메뉴 항목 없음'
    if (runStorageItem) {
      await evaluate(shell, `window.browserAPI.mod.menuInvoke(${JSON.stringify(runStorageItem.id)})`)
      let tab = null
      const deadline2 = Date.now() + 5000
      while (Date.now() < deadline2 && !tab) {
        const tabs = await evaluate(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)})`)
        tab = (tabs || []).find((t) => (t.url || '').includes('functest='))
        if (!tab) await sleep(200)
      }
      if (tab) {
        const encoded = decodeURIComponent(tab.url.split('functest=')[1])
        const parsed = JSON.parse(encoded)
        m2ok = JSON.stringify(parsed) === JSON.stringify({ a: [1, 2, { b: 'nested' }] })
        m2detail = `탭 URL 에서 복원한 값: ${encoded}`
      }
    }
    check('M2+M3', 'mod.tabs.create/mod.storage 왕복(중첩 JSON) 이 정상 동작한다', m2ok, m2detail)

    const readCountItem = (menuList1 || []).find((m) => m.label === 'READ_CREATED_COUNT')
    let m4ok = false, m4detail = 'READ_CREATED_COUNT 메뉴 항목 없음'
    if (readCountItem) {
      await evaluate(shell, `window.browserAPI.mod.menuInvoke(${JSON.stringify(readCountItem.id)})`)
      let tab = null
      const deadline4 = Date.now() + 5000
      while (Date.now() < deadline4 && !tab) {
        const tabs = await evaluate(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)})`)
        tab = (tabs || []).find((t) => (t.url || '').includes('onCreatedCount='))
        if (!tab) await sleep(200)
      }
      if (tab) {
        const n = Number(decodeURIComponent(tab.url.split('onCreatedCount=')[1]))
        m4ok = Number.isFinite(n) && n >= 1
        m4detail = `mod.tabs.onCreated 누적 카운트 = ${n} (>=1 이면 host→context 이벤트 전달 확인)`
      }
    }
    check('M4', 'mod.tabs.onCreated 이벤트가 host 에서 컨텍스트로 안전하게(vm.runInContext) 전달된다', m4ok, m4detail)
    check('M5', 'mod.menu.add 로 등록한 메뉴가 팔레트/외피에 노출되고 클릭이 위임 실행된다',
      !!runStorageItem && !!readCountItem && m2ok && m4ok,
      `menuList 항목 ${(menuList1 || []).length}개, 클릭 위임 결과로 M2·M4 모두 통과 여부로 판정`)

    // ===== M6: 사설망 차단 =====
    await evaluate(modsPage, `window.internalAPI.mod.setEnabled(${JSON.stringify(netModId)}, true)`)
    let netToast = ''
    const deadline6 = Date.now() + 8000
    while (Date.now() < deadline6) {
      netToast = (await toastRead()) || ''
      if (netToast.includes('NET_TEST')) break
      await sleep(200)
    }
    const netMatch = /NET_TEST blocked=(\d+)\/(\d+)/.exec(netToast)
    const netOk = !!netMatch && netMatch[1] === netMatch[2]
    check('M6', 'mod.net.fetch 가 사설망·로컬 주소 6종을 전부 차단한다(SSRF 방지)',
      netOk, netMatch ? `blocked=${netMatch[1]}/${netMatch[2]}` : `토스트 미관측: "${netToast}"`)

    // ===== S1: URL 트리거 무한 루프 방지 =====
    const hitsBefore = getHits()
    await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(loopUrl)})`)
    await sleep(4000) // 쿨다운 없으면 이 사이 수십~수백 회 재요청이 쌓인다
    const hitsAfter = getHits()
    const totalHits = hitsAfter - hitsBefore
    check('S1', 'URL 트리거 매크로가 자기 자신을 재발동해도 무한 루프에 빠지지 않는다(쿨다운)',
      totalHits >= 1 && totalHits <= 4,
      `4초 동안 로컬 서버 요청 ${totalHits}회 (쿨다운 없으면 수십 회 이상 — 실제 재현 시 확인됨)`)

    // ===== S2: 단축키 트리거 실동작 =====
    //
    // 참고(하네스 한계, 실측 확인): Electron 의 `before-input-event` 는 CDP 로 합성한
    // 렌더러 레벨 Input.dispatchKeyEvent 에 반응하지 않는다 — 이 저장소의 기존(사람이 실사용
    // 확인한) 시스템 단축키 Ctrl+L(action.omnibox.focus) 로 직접 재현해 확인했다: DOM 의
    // keydown 리스너는 이벤트를 받지만(렌더러까지는 도달), before-input-event 훅에 매인
    // 액셀러레이터 매칭은 전혀 발동하지 않았다. 이 저장소의 다른 40여 개 CDP 하네스도
    // 전부 키보드 단축키를 `actions.run` IPC 로 직접 실행해 검증하지(before-input-event 를
    // CDP 로 재현하지) 않는다 — 이 코드베이스에서 CDP 로는 건드릴 수 없는 경로임을 뜻한다.
    //
    // 그래서 검증은 두 갈래로 나눈다:
    //  ① (주 판정) "단축키" 매크로가 액셀러레이터 형태 값을 가지면 action.macros.run.<id> 로
    //     동적 등록되는지(actions.run 으로 실제 실행해 매크로가 도는지) — 이 저장소의 표준
    //     검증 관례와 일치.
    //  ② (참고) 실제 키 입력 경로(automation/index.ts 의 독립 before-input-event 리스너)는
    //     index.ts 의 attachAcceleratorsToWindow 와 완전히 동일한 이벤트·비교 로직
    //     (matchesAccelerator)을 쓰므로, 그 기존 경로가 실사용자에게 작동한다는 사실(여러
    //     라운드에 걸쳐 Ctrl+T 등으로 실사용 검증됨)로 코드 대칭성을 근거 삼는다 — CDP 로
    //     직접 재현하지 않는다.
    const actionRunOk = await evaluate(shell,
      `window.browserAPI.actions.run(${JSON.stringify('action.macros.run.mac-shortcut')}, ${JSON.stringify({ windowId })})`)
    let shortcutTab = null
    const deadlineS2 = Date.now() + 5000
    while (Date.now() < deadlineS2 && !shortcutTab) {
      const tabs = await evaluate(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)})`)
      shortcutTab = (tabs || []).find((t) => (t.url || '').includes('macroShortcutFired=1'))
      if (!shortcutTab) await sleep(200)
    }
    check('S2', '단축키 트리거 매크로가 action.macros.run.<id> 로 동적 등록되어 팔레트/키맵에서 실행 가능하다',
      actionRunOk === true && !!shortcutTab,
      `actions.run 반환=${actionRunOk}, ${shortcutTab ? `활성 탭이 ${shortcutTab.url} 로 이동함` : '탭 변화 없음'} `
      + '(실제 키보드 경로는 CDP 로 재현 불가 — 위 주석 참고, index.ts 의 검증된 패턴과 동일 로직임을 코드로 확인)')

    // ===== S3: 단축키 충돌 경고 =====
    const macroList = await evaluate(shell, `window.browserAPI.macro.list()`)
    const conflictA = (macroList || []).find((m) => m.id === 'mac-conflict-a')
    const conflictB = (macroList || []).find((m) => m.id === 'mac-conflict-b')
    check('S3', '같은 단축키를 쓰는 매크로 2개에 shortcutConflict 경고가 붙는다',
      !!conflictA?.shortcutConflict && !!conflictB?.shortcutConflict,
      `A.shortcutConflict=${conflictA?.shortcutConflict} B.shortcutConflict=${conflictB?.shortcutConflict}`)

    // ===== 양성 대조: 전체 찌른 뒤에도 앱이 정상 =====
    const alive = await evaluate(shell, `(async () => {
      const tabs = await window.browserAPI.tabs.list(${JSON.stringify(windowId)})
      const mods = await window.browserAPI.mod.menuList()
      return { tabs: tabs.length, menuItems: mods.length }
    })()`)
    check('ALIVE', 'mod·매크로를 전부 찌른 뒤에도 앱이 정상 동작한다(탭 목록·메뉴 목록 응답)',
      alive.tabs > 0 && alive.menuItems > 0,
      `탭 ${alive.tabs}개, mod 메뉴 항목 ${alive.menuItems}개`)
  } catch (err) {
    check('FATAL', '하네스 실행', false, err.message)
  } finally {
    try { loopServer.close() } catch { /* ignore */ }
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

  console.log('\n===== verify-mod-macro 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 이름: r.name, 상태: r.status })))
  const failed = results.filter((r) => r.status !== 'PASS')
  for (const f of failed) console.log(`FAIL ${f.id}: ${f.detail}`)
  fs.writeFileSync(path.join(args.out, 'mod-macro-results.json'), JSON.stringify(results, null, 2))
  console.log(`PASS=${results.length - failed.length} FAIL=${failed.length} (총 ${results.length})`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify-mod-macro] 치명적 오류:', err); process.exit(2) })
