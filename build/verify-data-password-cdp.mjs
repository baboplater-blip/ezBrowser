#!/usr/bin/env node
// verify-data-password-cdp.mjs — 묶음 H(데이터 백업·비밀번호 매니저) 실측 검증.
//
// 다루는 항목(묶음 H 작업 지시서 1~5):
//   P1  백업 암호 없이 내보내면 비밀번호가 아예 빠진다(safeStorage 암호문을 남기지 않는다)
//   P2  백업 암호를 넣으면 이식 가능한 암호화 블록(passwordsEncrypted)이 생긴다
//   P3  틀린 백업 암호로 가져오면 wrong-password 로 거부되고 비밀번호는 하나도 안 들어온다
//   P4  올바른 백업 암호로 가져오면 실제로 복원되고, 평문이 정확히 일치한다(왕복 무결성)
//   P5  병합 정책 = "최신 우선": 이미 있는 항목을 오래된 백업으로 다시 가져오면 건너뛴다
//   P6  코드 실행 항목(userChrome.js)은 기본적으로 가져오기에서 제외되고, 디스크에도 안 쓰인다.
//       `includeCode:true` 를 명시해야만 실제로 쓰인다 (양방향 — 음성 대조 포함)
//   P7  "이 사이트는 저장 안 함"이 재시작 후에도 유지된다(실 재시작으로 검증) — 해제하면 사라진다
//   P8  CSV 왕복 — 내보낸 CSV 를 파싱해 가져오면 계정이 실제로 생긴다(다이얼로그를 거치지 않고
//       csv.ts 순수 파서 + importPlainFromCsv 를 직접 구동 — 네이티브 파일 다이얼로그는 CDP 로
//       조작할 수 없어 우회. 다이얼로그 자체(showSaveDialog/showOpenDialog 배선)는 코드 리뷰로 검증.
//
// 사용: node build/verify-data-password-cdp.mjs [--port <n>] [--out <dir>]

import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { connectSession, connectShellSessionReady, getTargetList, waitForPortFree, sleep } from './lib/cdp.mjs'
import { preferFreePort, getFreePorts } from './lib/ports.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const EXE = path.join(REPO, 'dist', 'win-unpacked', 'ezBrowser.exe')
const require = createRequire(import.meta.url)

const args = { port: 9271, out: path.join(REPO, 'verify-out', 'data-password') }
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
  const r = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'JS 예외')
  return r.result?.value
}

// ===== P8용 순수 로직 (빌드 산출물의 csv.ts/index.js 를 직접 구동 — 네이티브 다이얼로그 우회) =====
function checkCsvRoundTrip(outDir) {
  const jsPath = path.join(REPO, 'app', 'dist', 'main', 'features', 'password', 'csv.js')
  if (!fs.existsSync(jsPath)) {
    check('P8', 'CSV 순수 파서 왕복', false, `빌드 산출물 없음: ${jsPath}`)
    return
  }
  const { buildCsv, parseCsv } = require(jsPath)
  const csv = buildCsv([
    { name: '테스트', url: 'https://csv-example.com', username: 'csvuser', password: 'csvPw123!,"quote' },
    { name: '', url: 'http://insecure.example.com', username: 'httpuser', password: 'x' },
  ])
  const hasHeader = csv.startsWith('name,url,username,password,note')
  const parsed = parseCsv(csv)
  const row1 = parsed.find((r) => r.username === 'csvuser')
  const quoteOk = row1 && row1.password === 'csvPw123!,"quote'
  // 쉼표·따옴표가 포함된 필드가 정확히 왕복하는지가 핵심 — 단순 split(',') 이면 여기서 깨진다.
  check('P8a', 'CSV 빌드→파싱 왕복 (쉼표·따옴표 필드 보존)',
    hasHeader && !!quoteOk && parsed.length === 2,
    `header=${hasHeader} · rows=${parsed.length} · quoteRoundTrip=${!!quoteOk}`)

  // 헤더 없는 파일(순수 데이터, name,url,username,password 고정 순서)도 인식하는가
  const noHeaderCsv = '내이름,https://noheader.example.com,nhuser,nhpass\r\n'
  const parsed2 = parseCsv(noHeaderCsv)
  check('P8b', '헤더 없는 CSV(고정 순서)도 파싱한다',
    parsed2.length === 1 && parsed2[0].url === 'https://noheader.example.com' && parsed2[0].username === 'nhuser',
    `parsed=${JSON.stringify(parsed2)}`)

  // 동의어 헤더(login_uri/login_username/login_password — 비트워든 계열) 인식
  const aliasCsv = 'login_uri,login_username,login_password\r\nhttps://alias.example.com,aliasuser,aliaspass\r\n'
  const parsed3 = parseCsv(aliasCsv)
  check('P8c', '동의어 헤더(login_uri 등)도 인식한다',
    parsed3.length === 1 && parsed3[0].username === 'aliasuser',
    `parsed=${JSON.stringify(parsed3)}`)

  fs.writeFileSync(path.join(outDir, 'csv-roundtrip-sample.csv'), csv, 'utf-8')
}

// ===== 최소 로그인 폼 픽스처 서버 (P7의 실제 form-submit → proposeSave 트리거용) =====
function startLoginFixture(port) {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <form id="loginForm">
      <input id="u" name="username" type="text" autocomplete="username" />
      <input id="p" name="password" type="password" autocomplete="current-password" />
      <button type="submit">로그인</button>
    </form>
    <script>
      document.getElementById('loginForm').addEventListener('submit', function (e) { e.preventDefault() })
    </script>
  </body></html>`
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  return new Promise((resolve, reject) => {
    srv.on('error', reject)
    srv.listen(port, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${port}/` }))
  })
}

async function main() {
  fs.mkdirSync(args.out, { recursive: true })
  if (!fs.existsSync(EXE)) {
    console.error(`exe 없음: ${EXE} — 먼저 npx electron-builder --win --dir`)
    process.exit(2)
  }

  checkCsvRoundTrip(args.out) // 앱을 띄우지 않는 순수 검사부터

  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const SETTINGS_SEED = JSON.stringify({
    setup: { completed: true, completedAt: Date.now(), version: 'verify-data-password' },
    // startup.mode='newtab' + 비정상 종료(session/current.json 잔존) 조합은 부팅 중
    // dialog.showMessageBox(사용자 응답 대기)를 띄워 **창이 뜨기도 전에** CDP 타깃 없이 영원히
    // 막힌다(실측 — features/session/index.ts maybeRestoreSession). 'last-session' 은 묻지 않고
    // 자동 복원하므로 강제 종료→재부팅 하네스에서는 항상 이 모드를 쓴다(다른 하네스와 동일 패턴).
    startup: { mode: 'last-session', urls: [] },
    adblock: { enabled: false },
  }, null, 2)
  fs.writeFileSync(path.join(profileDir, 'settings.json'), SETTINGS_SEED)

  args.port = await preferFreePort(args.port, 'verify-data-password-cdp.mjs')
  if (!(await waitForPortFree(args.port))) {
    console.error(`디버그 포트 ${args.port} 사용 중 — 남은 인스턴스를 종료하세요.`)
    process.exit(2)
  }
  const [fixturePort] = await getFreePorts(1)
  const fixture = await startLoginFixture(fixturePort)

  let child = null
  let shell = null
  let panel = null

  async function boot(label) {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const logStream = fs.createWriteStream(path.join(args.out, `app-${label}.log`))
    child = spawn(EXE, [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`], {
      env, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.pipe(logStream)
    child.stderr?.pipe(logStream)
    shell = await connectShellSessionReady(args.port, { log: (m) => console.log(`[verify-data-password] ${m}`) })
    await sleep(1000)
    // internalAPI(data.*·password.*)는 browser:// 내부 페이지에만 주입된다(shell 은 browserAPI 만
    // 갖는다) — 반드시 browser://passwords 탭을 열어 그 컨텍스트에서 호출한다.
    const wid = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)
    await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(wid)}, 'browser://passwords')`)
    const deadline = Date.now() + 15_000
    let target = null
    while (Date.now() < deadline && !target) {
      target = (await getTargetList(args.port)).find((x) => String(x.url).startsWith('browser://passwords')) ?? null
      if (!target) await sleep(300)
    }
    if (!target) throw new Error('browser://passwords 타깃을 찾지 못함')
    panel = await connectSession(target, 'panel')
    await sleep(800)
  }

  async function hardKill() {
    const exited = new Promise((r) => { child.once('exit', r) })
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    await Promise.race([exited, sleep(4000)])
    // Windows 는 프로세스 트리(GPU·렌더러·유틸리티 프로세스)가 남을 수 있다 — 남으면 프로필의
    // 단일 인스턴스 락을 쥔 채 다음 부팅이 조용히 자기 자신을 종료해 CDP 타깃이 영원히 안 뜬다(실측).
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    try { shell?.close() } catch { /* ignore */ }
    await waitForPortFree(args.port, 15_000).catch(() => {})
    await sleep(1500)
  }

  async function gracefulShutdown() {
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close', {}, 5000).catch(() => {})
      b.close()
    } catch { /* ignore */ }
    await sleep(1200)
    try { shell?.close() } catch { /* ignore */ }
    if (child && child.exitCode === null) {
      try { child.kill() } catch { /* ignore */ }
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    }
  }

  try {
    await boot('first')

    // ── P1: 백업 암호 없이 내보내면 비밀번호가 아예 빠진다 ─────────────────
    const noPwBundle = await evaluate(panel, `window.internalAPI.data.export()`)
    check('P1', '백업 암호 없이 내보내면 비밀번호가 제외된다',
      !noPwBundle.passwordsEncrypted && !(noPwBundle.files && noPwBundle.files['passwords.json']),
      `passwordsEncrypted 존재=${!!noPwBundle.passwordsEncrypted} · files["passwords.json"] 존재=${!!(noPwBundle.files && noPwBundle.files['passwords.json'])}`)

    // ── 준비: 비밀번호 2개 등록(하나는 자동로그인 허용) ─────────────────
    const seed = await evaluate(panel, `(async () => {
      const r1 = await window.internalAPI.password.add({ origin: 'https://backup-a.example.com', username: 'alice', password: 'Correct-Horse-1', autoLoginAllowed: true })
      const r2 = await window.internalAPI.password.add({ origin: 'https://backup-b.example.com', username: 'bob', password: 'Battery-Staple-2' })
      const list = await window.internalAPI.password.list()
      return { r1, r2, count: list.length }
    })()`, 60_000)
    check('SEED', '비밀번호 2개 선등록', seed.r1.ok === true && seed.r2.ok === true && seed.count >= 2,
      `등록 결과=${JSON.stringify({ r1: seed.r1.ok, r2: seed.r2.ok })} · 목록 ${seed.count}개`)

    // ── P2: 백업 암호를 넣으면 이식 가능한 블록이 생긴다 ────────────────
    const BACKUP_PW = 'my-backup-passphrase-9'
    const WRONG_PW = 'totally-wrong-passphrase'
    const pwBundle = await evaluate(panel,
      `window.internalAPI.data.export({ backupPassword: ${JSON.stringify(BACKUP_PW)} })`, 60_000)
    check('P2', '백업 암호를 넣으면 passwordsEncrypted 블록이 생긴다',
      !!pwBundle.passwordsEncrypted && pwBundle.passwordsEncrypted.alg === 'aes-256-gcm' && pwBundle.passwordsEncrypted.kdf === 'scrypt',
      `payload=${JSON.stringify(pwBundle.passwordsEncrypted ? Object.keys(pwBundle.passwordsEncrypted) : null)}`)

    // 기존 항목을 지워 "가져오기가 실제로 채우는지"를 깨끗하게 본다.
    await evaluate(panel, `(async () => {
      const list = await window.internalAPI.password.list()
      for (const e of list) await window.internalAPI.password.remove(e.id)
      return true
    })()`, 30_000)
    const clearedCount = (await evaluate(panel, `window.internalAPI.password.list()`, 30_000)).length

    // ── P3: 틀린 암호 → wrong-password, 아무것도 안 들어온다 ────────────
    const wrongImport = await evaluate(panel, `(async () => {
      const r = await window.internalAPI.data.import(${JSON.stringify(pwBundle)}, { backupPassword: ${JSON.stringify(WRONG_PW)} })
      const list = await window.internalAPI.password.list()
      return { r, count: list.length }
    })()`, 60_000)
    check('P3', '틀린 백업 암호는 wrong-password 로 거부되고 비밀번호가 안 들어온다',
      clearedCount === 0 && wrongImport.r.passwordStatus === 'wrong-password' && wrongImport.count === 0,
      `초기화 후 ${clearedCount}개 · 상태=${wrongImport.r.passwordStatus} · 가져오기 후 ${wrongImport.count}개`)

    // ── P4: 올바른 암호 → 실제로 복원 + 평문 왕복 무결성 ────────────────
    const rightImport = await evaluate(panel, `(async () => {
      const r = await window.internalAPI.data.import(${JSON.stringify(pwBundle)}, { backupPassword: ${JSON.stringify(BACKUP_PW)} })
      const list = await window.internalAPI.password.list()
      const alice = list.find(e => e.origin === 'https://backup-a.example.com' && e.username === 'alice')
      const alicePlain = alice ? await window.internalAPI.password.reveal(alice.id) : null
      return { r, count: list.length, aliceFound: !!alice, aliceAutoLogin: alice ? alice.autoLoginAllowed : null, alicePlain }
    })()`, 60_000)
    check('P4', '올바른 백업 암호로 실제로 복원되고 평문이 정확히 일치한다',
      rightImport.r.passwordStatus === 'imported' && rightImport.r.passwordImported === 2 && rightImport.count === 2
        && rightImport.aliceFound && rightImport.aliceAutoLogin === true && rightImport.alicePlain === 'Correct-Horse-1',
      `상태=${rightImport.r.passwordStatus} · imported=${rightImport.r.passwordImported} · 목록 ${rightImport.count}개 · `
      + `alice 발견=${rightImport.aliceFound} · autoLogin=${rightImport.aliceAutoLogin} · 평문일치=${rightImport.alicePlain === 'Correct-Horse-1'}`)

    // ── P5: 병합 정책 = 최신 우선 — 같은(오래된) 백업을 다시 가져오면 전부 건너뛴다 ──
    const reImport = await evaluate(panel, `(async () => {
      const r = await window.internalAPI.data.import(${JSON.stringify(pwBundle)}, { backupPassword: ${JSON.stringify(BACKUP_PW)} })
      const list = await window.internalAPI.password.list()
      return { r, count: list.length }
    })()`, 60_000)
    check('P5', '병합 정책(최신 우선) — 오래된 백업 재가져오기는 기존 값을 덮어쓰지 않는다',
      reImport.r.passwordImported === 0 && reImport.r.passwordUpdated === 0 && reImport.r.passwordSkippedRows === 2
        && reImport.count === 2,
      `imported=${reImport.r.passwordImported} · updated=${reImport.r.passwordUpdated} · skipped=${reImport.r.passwordSkippedRows} · 목록 ${reImport.count}개`)

    // ── P6: 코드 항목(userChrome.js) 게이팅 — 기본 제외 + 명시 시에만 포함 ──
    //
    // 번들에는 userChrome.js **하나만** 담는다. 'settings.json' 을 동봉하지 않는 이유: 이 앱의
    // 설정 저장소(`conf`/`electron-store`)의 `.store` getter 는 **매 호출마다 디스크를 새로 읽는다**
    // (캐시하지 않음, `node_modules/conf/dist/source/index.js` `get store()` 확인). 그래서 온전치
    // 않은 임시 settings.json 을 실행 중에 직접 썼더니 그 순간부터 dark-mode·passkey·history-purge
    // 등 도처의 `getSettings().xxx.yyy` 호출이 전부 `Cannot read properties of undefined` 로 깨졌다
    // (실측 — 실제 백업은 항상 완전한 settings.json 이라 재발하지 않지만, 이 하네스처럼 일부러 조각난
    // 값을 쓰면 즉시 재현된다). 이건 이번 묶음(1~5)의 범위를 넘는 기존 설계 특성이라 고치지 않고,
    // 대신 게이팅 검사를 settings.json 과 무관하게 만든다 — userChrome.js 는 이미 `ensureFile()`
    // 로 부팅 시 기본값이 생성돼 있으므로, "파일 존재 여부"가 아니라 **마커 문자열 포함 여부**로 판정한다.
    const userChromePath = path.join(profileDir, 'userChrome.js')
    const contentBefore = fs.existsSync(userChromePath) ? fs.readFileSync(userChromePath, 'utf-8') : ''
    check('SANITY-P6', 'userChrome.js 는 부팅 시 기본값으로 이미 존재한다(게이팅 판정의 전제)',
      contentBefore.length > 0 && !contentBefore.includes('verify-data-password 마커'),
      `기본 파일 길이=${contentBefore.length} · 이미 마커 포함=${contentBefore.includes('verify-data-password 마커')}`)

    const codeBundle = {
      version: 1, exportedAt: Date.now(), app: { name: 'x', version: '1' },
      files: {
        'userChrome.js': { encoding: 'utf-8', content: '/* verify-data-password 마커 */ window.__bbTestMarker = 1' },
      },
    }
    const preview = await evaluate(panel, `window.internalAPI.data.previewCode(${JSON.stringify(codeBundle)})`, 30_000)
    check('P6a', 'previewCode 가 코드 항목을 정확히 짚는다',
      Array.isArray(preview.codeItems) && preview.codeItems.length === 1 && preview.codeItems[0] === 'userChrome.js',
      `codeItems=${JSON.stringify(preview.codeItems)}`)

    const importNoCode = await evaluate(panel,
      `window.internalAPI.data.import(${JSON.stringify(codeBundle)})`, 30_000)
    await sleep(300)
    const contentAfterSkip = fs.existsSync(userChromePath) ? fs.readFileSync(userChromePath, 'utf-8') : ''
    check('P6b', '기본(includeCode 없음)은 userChrome.js 를 건너뛰고 디스크 내용도 그대로다',
      importNoCode.codeItemsSkipped.includes('userChrome.js') && importNoCode.restored === 0
        && !contentAfterSkip.includes('verify-data-password 마커') && contentAfterSkip === contentBefore,
      `codeItemsSkipped=${JSON.stringify(importNoCode.codeItemsSkipped)} · restored=${importNoCode.restored} · 마커포함=${contentAfterSkip.includes('verify-data-password 마커')} · 내용불변=${contentAfterSkip === contentBefore}`)

    const importWithCode = await evaluate(panel,
      `window.internalAPI.data.import(${JSON.stringify(codeBundle)}, { includeCode: true })`, 30_000)
    await sleep(300)
    const contentAfterInclude = fs.existsSync(userChromePath) ? fs.readFileSync(userChromePath, 'utf-8') : ''
    check('P6c', 'includeCode:true 면 실제로 userChrome.js 가 디스크에 쓰인다 (양성 대조)',
      importWithCode.codeItemsSkipped.length === 0 && importWithCode.restored === 1
        && contentAfterInclude.includes('verify-data-password 마커'),
      `codeItemsSkipped=${JSON.stringify(importWithCode.codeItemsSkipped)} · restored=${importWithCode.restored} · 마커포함=${contentAfterInclude.includes('verify-data-password 마커')}`)

    // ── P7: "이 사이트는 저장 안 함" 재시작 후에도 유지 ─────────────────
    const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)
    const tab = await evaluate(shell,
      `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(fixture.url)})`, 15_000)
    const tabId = tab.id
    await sleep(1500)

    // 셸에서 prompt-open 이벤트를 기다렸다가 즉시 'never' 로 확정한다.
    const waitAndConfirmNever = evaluate(shell, `new Promise((resolve) => {
      const unsub = window.browserAPI.password.onPromptOpen(async (p) => {
        const r = await window.browserAPI.password.confirmSave(p.promptId, 'never')
        resolve({ promptId: p.promptId, origin: p.origin, confirmResult: r })
      })
      setTimeout(() => resolve({ timedOut: true }), 12000)
    })`, 20_000)

    // 콘텐츠 탭에서 로그인 폼을 채우고 submit 이벤트를 발생시킨다(content.js 의 진짜 감지 경로).
    const contentTargets = await getTargetList(args.port)
    const contentTarget = contentTargets.find((t) => String(t.url).startsWith(fixture.url))
    if (!contentTarget) throw new Error('로그인 픽스처 탭 타깃을 찾지 못함')
    const content = await connectSession(contentTarget, 'fixture-tab')
    await evaluate(content, `(() => {
      const u = document.getElementById('u'); const p = document.getElementById('p')
      u.value = 'never-user'; p.value = 'never-pass-1'
      document.getElementById('loginForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      return true
    })()`, 10_000)
    content.close()

    const neverResult = await waitAndConfirmNever
    await sleep(500)
    const neverListAfterConfirm = await evaluate(panel, `window.internalAPI.password.neverList()`, 15_000)
    check('P7a', '"이 사이트는 안 함" 확정 직후 목록에 나타난다',
      !neverResult.timedOut && neverResult.confirmResult?.status === 'never'
        && Array.isArray(neverListAfterConfirm) && neverListAfterConfirm.includes('http://127.0.0.1:' + fixturePort),
      `결과=${JSON.stringify(neverResult)} · 목록=${JSON.stringify(neverListAfterConfirm)}`)

    // 디스크에 실제로 쓰였는지(디바운스 250ms) 확인 — 재시작을 기다리지 않아도 되는 직접 증거.
    await sleep(500)
    let neverFileOnDisk = []
    try { neverFileOnDisk = JSON.parse(fs.readFileSync(path.join(profileDir, 'password-never-save.json'), 'utf-8')) } catch { /* not yet */ }
    check('P7b', '디스크(password-never-save.json)에도 실제로 쓰인다',
      Array.isArray(neverFileOnDisk) && neverFileOnDisk.includes('http://127.0.0.1:' + fixturePort),
      `디스크=${JSON.stringify(neverFileOnDisk)}`)

    // ── 강제 재시작 — 회귀했던 그 시나리오를 실제로 재현해 검증한다 ────
    await hardKill()
    await boot('second')
    const neverListAfterRestart = await evaluate(panel, `window.internalAPI.password.neverList()`, 15_000)
    check('P7c', '강제 종료 후 재시작해도 "저장 안 함" 목록이 유지된다 (회귀 검사)',
      Array.isArray(neverListAfterRestart) && neverListAfterRestart.includes('http://127.0.0.1:' + fixturePort),
      `재시작 후 목록=${JSON.stringify(neverListAfterRestart)}`)

    // 해제하면 사라지고, 그것도 재시작을 넘어 유지되는가.
    await evaluate(panel, `window.internalAPI.password.neverRemove(${JSON.stringify('http://127.0.0.1:' + fixturePort)})`, 15_000)
    await sleep(600)
    const neverListAfterRemove = await evaluate(panel, `window.internalAPI.password.neverList()`, 15_000)
    check('P7d', '해제하면 목록에서 사라진다',
      Array.isArray(neverListAfterRemove) && !neverListAfterRemove.includes('http://127.0.0.1:' + fixturePort),
      `해제 후 목록=${JSON.stringify(neverListAfterRemove)}`)

    // ── P4 데이터가 재시작을 넘어 살아 있는지도 겸사겸사(비밀번호 자체의 기본 영속성 회귀 없음) ──
    const listAfterRestart = await evaluate(panel, `window.internalAPI.password.list()`, 15_000)
    check('SANITY', '비밀번호 자체도 재시작 후 살아 있다(회귀 없음)',
      Array.isArray(listAfterRestart) && listAfterRestart.length === 2,
      `재시작 후 비밀번호 ${listAfterRestart.length}개`)

    await gracefulShutdown()
  } catch (err) {
    check('FATAL', '하네스 실행', false, err.message)
    await gracefulShutdown().catch(() => {})
  } finally {
    try { fixture.srv.close() } catch { /* ignore */ }
    if (child && child.exitCode === null) {
      try { child.kill() } catch { /* ignore */ }
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    }
  }

  console.log('\n===== verify-data-password 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 이름: r.name, 상태: r.status })))
  const failed = results.filter((r) => r.status !== 'PASS')
  for (const f of failed) console.log(`FAIL ${f.id}: ${f.detail}`)
  fs.writeFileSync(path.join(args.out, 'data-password-results.json'), JSON.stringify(results, null, 2))
  console.log(`PASS=${results.length - failed.length} FAIL=${failed.length} (총 ${results.length})`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify-data-password] 치명적 오류:', err); process.exit(2) })
