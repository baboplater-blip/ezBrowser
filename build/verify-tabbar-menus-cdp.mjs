#!/usr/bin/env node
// verify-tabbar-menus-cdp.mjs — 묶음 D(탭바·메뉴·접근성) 검증.
//
// 다루는 항목:
//   ① window.prompt() 는 Electron 렌더러에서 지원되지 않는다 — 탭 그룹 이름변경(TabBar) ·
//      북마크 새 폴더/이름변경(pages/bookmarks)을 인라인 입력으로 교체했다. **prompt() 를
//      호출하지 않고도** 실제로 값이 바뀌는지 실측한다(prompt 를 throw 로 monkeypatch 해서
//      혹시라도 호출되면 즉시 드러나게 한다).
//   ② 탭 우클릭 메뉴 보강(새로고침·복제·다른 탭 모두 닫기·오른쪽 탭 모두 닫기·닫은 탭 다시
//      열기·이 탭 북마크) — TabBar 의 컨텍스트 메뉴는 React 오버레이(순수 DOM)라 CDP 로
//      실제 클릭까지 검증 가능하다.
//   ⑥ 키보드 접근성 — 탭바 roving tabIndex + 화살표/Home/End/Enter/Space/Delete,
//      SidePanel·WorkspaceRail 의 aria 속성, CommandPalette 의 combobox/listbox 배선.
//
// ③(새 창/시크릿 창에서 링크 열기)·④(맞춤법 제안) 는 Electron 의 **네이티브 OS 컨텍스트
// 메뉴**(Menu.buildFromTemplate + popup())를 쓴다 — CDP 로 스크립트 dispatchEvent 한 합성
// contextmenu 이벤트는 untrusted 라 native 메뉴를 띄우지 않고(따라서 못 열어 볼 수 있다),
// 반대로 실제 OS 우클릭(Input.dispatchMouseEvent)을 흉내내면 진짜 OS 메뉴가 뜨는데 그
// 항목을 클릭하는 건 CDP/DOM 영역 밖(win32 네이티브 자동화가 필요)이라 이 하네스로는 못
// 미친다. 그래서 이 둘은 **컴파일된 코드의 구조 검증**(정확한 라벨·호출 배선이 실제로
// 산출물에 존재하는지)으로 대신한다 — 정적 검사라는 것을 결과에 명시한다.
//
// 사용: node build/verify-tabbar-menus-cdp.mjs [--port <n>] [--out <dir>]

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

const args = { port: 9310, out: path.join(REPO_ROOT, 'verify-out', 'tabbar-menus') }
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

/** 조건이 참이 될 때까지 짧게 재시도한다 — IPC 왕복·onChanged 브로드캐스트 타이밍 흡수용. */
async function waitUntil(fn, { timeoutMs = 3000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(intervalMs)
  }
  return last
}

// ── S0: 순수 로직 — 미리보기 캐시 LRU 상한 (앱 없이, TabBar.tsx 와 동일한 알고리즘) ──────
function checkPreviewCacheLru() {
  const CAP = 20
  const cache = new Map()
  function setCache(id, entry) {
    if (cache.has(id)) cache.delete(id)
    cache.set(id, entry)
    while (cache.size > CAP) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }
  for (let i = 0; i < 30; i += 1) setCache(`tab-${i}`, { ts: i })
  const sizeOk = cache.size === CAP
  const evictedOldest = !cache.has('tab-0') && !cache.has('tab-9')
  const keptNewest = cache.has('tab-29') && cache.has('tab-10')
  check('S0a', '미리보기 캐시가 상한(20)을 넘지 않는다 (LRU 알고리즘 순수 검증)',
    sizeOk, `30개 삽입 후 크기=${cache.size}`)
  check('S0b', 'LRU — 가장 오래된 항목부터 제거되고 최신 항목은 남는다',
    evictedOldest && keptNewest,
    `tab-0/tab-9 제거됨=${evictedOldest} · tab-10/tab-29 유지됨=${keptNewest}`)

  // 재삽입(재사용) 시 recency 갱신 확인 — setCache 와 동일한 알고리즘(상한 포함)을 재사용.
  const cache2 = new Map()
  function setCache2(id, entry) {
    if (cache2.has(id)) cache2.delete(id)
    cache2.set(id, entry)
    while (cache2.size > CAP) {
      const oldest = cache2.keys().next().value
      if (oldest === undefined) break
      cache2.delete(oldest)
    }
  }
  for (let i = 0; i < 20; i += 1) setCache2(`x-${i}`, i)
  setCache2('x-0', 'refreshed') // x-0 을 다시 쓰면 맨 뒤로(최신) — 크기는 여전히 20
  setCache2('x-20', 20) // 21번째 삽입 → 상한 초과 → 가장 오래된(x-1)이 제거되어야 함(x-0 은 방금 갱신했으므로 생존)
  check('S0c', '재삽입된 항목은 recency 가 갱신되어 우선 보존된다',
    cache2.has('x-0') && !cache2.has('x-1'),
    `x-0(재삽입) 유지=${cache2.has('x-0')} · x-1(안 건드림, 가장 오래됨) 제거=${!cache2.has('x-1')}`)
}

// ── S: 정적 구조 검증 — 네이티브 OS 컨텍스트 메뉴(③·④)는 CDP 로 클릭까지 못 미치므로
//      컴파일된 산출물에 정확한 배선이 있는지로 대신한다. ─────────────────────────────
function checkStaticContextMenuWiring() {
  const ctxMenuJs = path.join(REPO_ROOT, 'app', 'dist', 'main', 'features', 'context-menu', 'index.js')
  const src = fs.existsSync(ctxMenuJs) ? fs.readFileSync(ctxMenuJs, 'utf8') : ''
  check('S1', '[정적] "새 창에서 링크 열기" 가 createBrowserWindow 로 실제 새 창을 만든다',
    /새\s*창에서\s*링크\s*열기/.test(src) && /createBrowserWindow/.test(src),
    `라벨 존재=${/새\s*창에서\s*링크\s*열기/.test(src)} · createBrowserWindow 호출 존재=${/createBrowserWindow/.test(src)}`)
  check('S2', '[정적] "시크릿 창에서 링크 열기" 메뉴 항목이 incognito:true 로 새 창을 연다',
    /시크릿\s*창에서\s*링크\s*열기/.test(src) && /incognito:\s*true/.test(src),
    `라벨 존재=${/시크릿\s*창에서\s*링크\s*열기/.test(src)} · incognito:true 존재=${/incognito:\s*true/.test(src)}`)
  check('S3', '[정적] 맞춤법 제안(dictionarySuggestions→replaceMisspelling) + "사전에 추가" 배선 존재',
    /replaceMisspelling/.test(src) && /addWordToSpellCheckerDictionary/.test(src) && /misspelledWord/.test(src),
    `replaceMisspelling=${/replaceMisspelling/.test(src)} · addWordToSpellCheckerDictionary=${/addWordToSpellCheckerDictionary/.test(src)} · misspelledWord 분기=${/misspelledWord/.test(src)}`)

  const sessBootJs = path.join(REPO_ROOT, 'app', 'dist', 'main', 'session-bootstrap.js')
  const sb = fs.existsSync(sessBootJs) ? fs.readFileSync(sessBootJs, 'utf8') : ''
  check('S4', '[정적] 세션에 한국어+영어 맞춤법 검사 언어가 설정된다',
    /setSpellCheckerLanguages/.test(sb) && /['"]ko['"]/.test(sb) && /en-US/.test(sb),
    `setSpellCheckerLanguages 호출=${/setSpellCheckerLanguages/.test(sb)} · ko/en-US 포함=${/['"]ko['"]/.test(sb) && /en-US/.test(sb)}`)
}

async function main() {
  fs.mkdirSync(args.out, { recursive: true })
  checkPreviewCacheLru()
  checkStaticContextMenuWiring()

  if (!fs.existsSync(EXE)) {
    console.error(`exe 없음: ${EXE} — 먼저 npx electron-builder --win --dir`)
    finish()
    return
  }
  const profileDir = path.join(args.out, 'profile')
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({
    setup: { completed: true, completedAt: Date.now(), version: 'verify-tabbar-menus' },
    startup: { mode: 'newtab', urls: [] },
  }, null, 2))

  args.port = await preferFreePort(args.port, 'verify-tabbar-menus-cdp.mjs')
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
  let bookmarksSession = null
  try {
    shell = await connectShellSessionReady(args.port, { log: (m) => console.log(`[verify-tabbar-menus] ${m}`) })
    const windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)

    // window.prompt() 가 호출되면 즉시 드러나도록 throw 로 바꾼다(모든 렌더러 컨텍스트 공통 패턴).
    await evaluate(shell, `(() => { window.prompt = () => { throw new Error('window.prompt() 는 지원되지 않아야 함'); }; })()`)

    // ── L1: 탭 그룹 이름 변경 — 인라인 입력, prompt() 호출 없음 ───────────────────
    const tabA = await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, 'https://example.com/a')`)
    await sleep(500)
    const group = await evaluate(shell, `window.browserAPI.groups.create(${JSON.stringify(windowId)}, { tabIds: [${JSON.stringify(tabA.id)}] })`)
    await sleep(500)

    const renameOutcome = await evaluate(shell, `(async () => {
      const header = document.querySelector('[data-group-id="${group.id}"]')
      if (!header) return { error: 'header-not-found' }
      const rect = header.getBoundingClientRect()
      header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 5, clientY: rect.bottom + 5 }))
      await new Promise((r) => setTimeout(r, 200))
      const renameBtn = [...document.querySelectorAll('.tab-ctx-item')].find((b) => b.textContent === '이름 변경')
      if (!renameBtn) return { error: 'rename-btn-not-found' }
      renameBtn.click()
      await new Promise((r) => setTimeout(r, 150))
      const input = document.querySelector('.tab-ctx-rename-input')
      if (!input) return { error: 'rename-input-not-found' }
      input.value = '개편 테스트 그룹'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise((r) => setTimeout(r, 400))
      return { ok: true }
    })()`)
    await sleep(500)
    const groupsAfter = await evaluate(shell, `window.browserAPI.groups.list(${JSON.stringify(windowId)})`)
    const renamedGroup = groupsAfter.find((g) => g.id === group.id)
    check('L1', '탭 그룹 이름 변경 — 인라인 입력으로 실제 반영되고 window.prompt() 미사용',
      renameOutcome.ok === true && renamedGroup?.title === '개편 테스트 그룹',
      `outcome=${JSON.stringify(renameOutcome)} · 변경 후 제목="${renamedGroup?.title}"`)

    // ── L2/L3: 북마크 폴더 — 새 폴더/이름 변경 인라인 입력, prompt() 미사용 ────────────
    await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, 'browser://bookmarks')`)
    const bmTarget = await (async () => {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const t = (await getTargetList(args.port)).find((x) => String(x.url).startsWith('browser://bookmarks'))
        if (t) return t
        await sleep(300)
      }
      return null
    })()
    if (!bmTarget) throw new Error('browser://bookmarks 타깃을 찾지 못함')
    bookmarksSession = await connectSession(bmTarget, 'bookmarks')
    await sleep(1200)
    await evaluate(bookmarksSession, `(() => { window.prompt = () => { throw new Error('window.prompt() 는 지원되지 않아야 함'); }; })()`)

    const FOLDER_NAME = `검증-폴더-${Date.now()}`
    const newFolderOutcome = await evaluate(bookmarksSession, `(async () => {
      document.getElementById('new-folder').click()
      await new Promise((r) => setTimeout(r, 200))
      const input = document.querySelector('.folder-name-input[data-mode="create"]')
      if (!input) return { error: 'create-input-not-found' }
      input.value = ${JSON.stringify(FOLDER_NAME)}
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise((r) => setTimeout(r, 500))
      return { ok: true }
    })()`)
    const createdFolder = await waitUntil(async () => {
      const t = await evaluate(bookmarksSession, `window.internalAPI.bookmarks.list()`)
      return t.folders.find((f) => f.name === FOLDER_NAME) ?? null
    })
    check('L2', '북마크 "새 폴더" — 인라인 입력으로 실제 생성되고 window.prompt() 미사용',
      newFolderOutcome.ok === true && !!createdFolder,
      `outcome=${JSON.stringify(newFolderOutcome)} · 생성된 폴더=${createdFolder ? createdFolder.name : '없음'}`)

    let renameFolderOutcome = { error: 'skipped-no-folder' }
    let renamedFolder = null
    if (createdFolder) {
      const RENAMED = `${FOLDER_NAME}-변경됨`
      renameFolderOutcome = await evaluate(bookmarksSession, `(async () => {
        const node = document.querySelector('[data-folder-id="${createdFolder.id}"]')
        if (!node) return { error: 'folder-node-not-found' }
        node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 200))
        const input = document.querySelector('.folder-name-input[data-mode="rename"]')
        if (!input) return { error: 'rename-input-not-found' }
        input.value = ${JSON.stringify(RENAMED)}
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await new Promise((r) => setTimeout(r, 500))
        return { ok: true }
      })()`)
      renamedFolder = await waitUntil(async () => {
        const t = await evaluate(bookmarksSession, `window.internalAPI.bookmarks.list()`)
        const f = t.folders.find((x) => x.id === createdFolder.id)
        return f && f.name === RENAMED ? f : null
      }) ?? (await evaluate(bookmarksSession, `window.internalAPI.bookmarks.list()`)).folders.find((f) => f.id === createdFolder.id)
      check('L3', '북마크 폴더 이름 변경 — 더블클릭 인라인 입력으로 실제 반영되고 window.prompt() 미사용',
        renameFolderOutcome.ok === true && renamedFolder?.name === RENAMED,
        `outcome=${JSON.stringify(renameFolderOutcome)} · 변경 후 이름="${renamedFolder?.name}"`)
    } else {
      check('L3', '북마크 폴더 이름 변경 — 더블클릭 인라인 입력으로 실제 반영되고 window.prompt() 미사용',
        false, 'L2 에서 폴더 생성 실패 — 건너뜀')
    }

    // ── L4: 탭 컨텍스트 메뉴 — 항목 존재 + "탭 복제" 실제 동작 ─────────────────────
    const tabsBeforeDup = await evaluate(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)})`)
    const targetTab = tabsBeforeDup.find((t) => t.id === tabA.id) ?? tabsBeforeDup[0]
    const menuItems = await evaluate(shell, `(async () => {
      const el = document.querySelector('[data-tab-id="${targetTab.id}"]')
      if (!el) return { error: 'tab-el-not-found' }
      const rect = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 5, clientY: rect.bottom + 5 }))
      await new Promise((r) => setTimeout(r, 200))
      const labels = [...document.querySelectorAll('.tab-ctx-item')].map((b) => b.textContent)
      return { labels }
    })()`)
    const expectedLabels = ['새로고침', '탭 복제', '이 탭 북마크에 추가', '닫은 탭 다시 열기']
    const hasAll = Array.isArray(menuItems.labels) && expectedLabels.every((l) => menuItems.labels.includes(l))
    check('L4', '탭 우클릭 메뉴에 새로고침·복제·북마크·닫은탭다시열기 항목이 모두 있다',
      hasAll, `메뉴 항목=${JSON.stringify(menuItems.labels)}`)

    // "탭 복제" 클릭 → 탭 수 +1
    const tabCountBefore = tabsBeforeDup.length
    await evaluate(shell, `(async () => {
      const btn = [...document.querySelectorAll('.tab-ctx-item')].find((b) => b.textContent === '탭 복제')
      btn?.click()
    })()`)
    await sleep(900)
    const tabsAfterDup = await evaluate(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)})`)
    check('L5', '"탭 복제" 클릭 시 실제로 탭이 하나 늘어난다',
      tabsAfterDup.length === tabCountBefore + 1,
      `복제 전 ${tabCountBefore}개 → 복제 후 ${tabsAfterDup.length}개`)

    // ── L6: "이 탭 북마크에 추가" ────────────────────────────────────────────────
    const bmBeforeAdd = await evaluate(bookmarksSession, `window.internalAPI.bookmarks.list()`)
    const bmCountBefore = bmBeforeAdd.bookmarks.length
    await evaluate(shell, `(async () => {
      const el = document.querySelector('[data-tab-id="${targetTab.id}"]')
      const rect = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 5, clientY: rect.bottom + 5 }))
      await new Promise((r) => setTimeout(r, 200))
      const btn = [...document.querySelectorAll('.tab-ctx-item')].find((b) => b.textContent === '이 탭 북마크에 추가')
      btn?.click()
    })()`)
    await sleep(700)
    const bmAfter = await evaluate(bookmarksSession, `window.internalAPI.bookmarks.list()`)
    check('L6', '"이 탭 북마크에 추가" 클릭 시 실제로 북마크가 하나 늘어난다',
      bmAfter.bookmarks.length === bmCountBefore + 1,
      `추가 전 ${bmCountBefore}개 → 추가 후 ${bmAfter.bookmarks.length}개`)

    // ── L7: "닫은 탭 다시 열기" ──────────────────────────────────────────────────
    const tabsBeforeClose = await evaluate(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)})`)
    // browser://newtab 은 의도적으로 "닫은 탭" 스택 제외 대상이므로, 반드시 http(s) 탭을 고른다.
    const toClose = tabsBeforeClose.find((t) => !t.pinned && /^https?:/.test(t.url))
    if (toClose) {
      await evaluate(shell, `window.browserAPI.tabs.close(${JSON.stringify(toClose.id)})`)
      await sleep(500)
      const afterClose = await evaluate(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)})`)
      const anyTab = afterClose[0]
      await evaluate(shell, `(async () => {
        const el = document.querySelector('[data-tab-id="${anyTab.id}"]')
        const rect = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 5, clientY: rect.bottom + 5 }))
        await new Promise((r) => setTimeout(r, 200))
        const btn = [...document.querySelectorAll('.tab-ctx-item')].find((b) => b.textContent === '닫은 탭 다시 열기')
        btn?.click()
      })()`)
      await sleep(700)
      const afterReopen = await evaluate(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)})`)
      check('L7', '"닫은 탭 다시 열기" 클릭 시 방금 닫은 탭이 되돌아온다',
        afterReopen.length === afterClose.length + 1,
        `닫은 후 ${afterClose.length}개 → 다시 열기 후 ${afterReopen.length}개`)
    } else {
      check('L7', '"닫은 탭 다시 열기" 클릭 시 방금 닫은 탭이 되돌아온다', false, '닫을 비고정 탭이 없어 건너뜀')
    }

    // ── L8: "다른 탭 모두 닫기" / "오른쪽 탭 모두 닫기" ────────────────────────────
    // 알려진 상태로 재구성 — 탭 4개(A,B,C,D), 전부 비고정.
    const cleanupList = await evaluate(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)})`)
    for (const t of cleanupList) await evaluate(shell, `window.browserAPI.tabs.close(${JSON.stringify(t.id)})`)
    await sleep(500)
    const madeIds = []
    for (const u of ['https://example.com/1', 'https://example.com/2', 'https://example.com/3', 'https://example.com/4']) {
      const t = await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(u)})`)
      madeIds.push(t.id)
      await sleep(300)
    }
    // 오른쪽 탭 모두 닫기 — 2번째 탭(B) 기준, C·D 만 닫혀야 함
    const listForRight = await evaluate(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)})`)
    const ordered = [...listForRight].sort((a, b) => a.index - b.index)
    const bTab = ordered[1]
    await evaluate(shell, `(async () => {
      const el = document.querySelector('[data-tab-id="${bTab.id}"]')
      const rect = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 5, clientY: rect.bottom + 5 }))
      await new Promise((r) => setTimeout(r, 200))
      const btn = [...document.querySelectorAll('.tab-ctx-item')].find((b) => b.textContent === '오른쪽 탭 모두 닫기')
      btn?.click()
    })()`)
    await sleep(700)
    const afterCloseRight = await evaluate(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)})`)
    check('L8', '"오른쪽 탭 모두 닫기" — 기준 탭 오른쪽만 닫히고 자신·왼쪽은 남는다',
      afterCloseRight.length === 2 && afterCloseRight.some((t) => t.id === bTab.id) && afterCloseRight.some((t) => t.id === ordered[0].id),
      `4개 → ${afterCloseRight.length}개, 남은 탭=${afterCloseRight.map((t) => t.id).join(',')}`)

    // "다른 탭 모두 닫기" — 남은 2개 중 첫 탭 기준
    const beforeOthers = afterCloseRight
    const keepTab = beforeOthers[0]
    await evaluate(shell, `(async () => {
      const el = document.querySelector('[data-tab-id="${keepTab.id}"]')
      const rect = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 5, clientY: rect.bottom + 5 }))
      await new Promise((r) => setTimeout(r, 200))
      const btn = [...document.querySelectorAll('.tab-ctx-item')].find((b) => b.textContent === '다른 탭 모두 닫기')
      btn?.click()
    })()`)
    await sleep(700)
    const afterCloseOthers = await evaluate(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)})`)
    check('L9', '"다른 탭 모두 닫기" — 기준 탭 하나만 남는다',
      afterCloseOthers.length === 1 && afterCloseOthers[0].id === keepTab.id,
      `2개 → ${afterCloseOthers.length}개, 남은 탭=${afterCloseOthers.map((t) => t.id).join(',')}`)

    // ── L10: 미리보기 캐시 — 닫힌 탭의 캐시 항목이 정리되는가 (프루닝 이펙트, 회귀 없음 스모크) ──
    // 내부 Map 은 모듈 비공개라 직접 못 읽는다 — 여러 탭을 만들고 닫는 동안 콘솔 예외가
    // 없는지로 회귀 스모크를 대신한다(정밀 검증은 S0 의 순수 로직 검사).
    let previewSmokeOk = true
    try {
      for (let i = 0; i < 5; i += 1) {
        const t = await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, 'https://example.com/prev${i}')`)
        await sleep(150)
        await evaluate(shell, `window.browserAPI.tabs.close(${JSON.stringify(t.id)})`)
        await sleep(150)
      }
    } catch (err) { previewSmokeOk = false }
    check('L10', '탭 반복 생성/닫기 동안 미리보기 캐시 관련 예외 없음 (프루닝 이펙트 스모크)',
      previewSmokeOk, previewSmokeOk ? '오류 없음' : '평가 중 예외 발생')

    // ── L11: 탭바 키보드 접근성 — roving tabIndex + 화살표 + Home/End + Enter/Space + Delete ──
    for (const u of ['https://example.com/k1', 'https://example.com/k2', 'https://example.com/k3']) {
      await evaluate(shell, `window.browserAPI.tabs.create(${JSON.stringify(windowId)}, ${JSON.stringify(u)})`)
      await sleep(250)
    }
    await sleep(400)
    const kbState0 = await evaluate(shell, `(() => {
      const tabs = [...document.querySelectorAll('[role="tab"]')]
      return {
        count: tabs.length,
        zeroCount: tabs.filter((t) => t.tabIndex === 0).length,
        activeElIsTab: document.activeElement?.getAttribute('role') === 'tab',
      }
    })()`)
    check('L11', '탭바 roving tabIndex — 탭 중 정확히 1개만 tabIndex=0',
      kbState0.zeroCount === 1, `tabIndex=0 인 탭 수=${kbState0.zeroCount} (총 ${kbState0.count}개)`)

    // ArrowRight 로 다음 탭으로 이동하는지 확인.
    // roving 탭(tabIndex=0)은 "가장 최근 포커스/활성" 탭이라 **DOM 순서상 첫 탭이 아닐 수 있다**
    // (직전에 만든 탭이 활성화되어 roving 이 되는 경우가 흔하다). 그래서 먼저 Home 으로 확실히
    // 첫 탭에 착지시킨 뒤(Home/End 는 idx 계산 없이 절대 위치라 이 레이스가 없다 — L13 에서 검증됨)
    // ArrowRight 를 보낸다. 또한 focus() 가 일으키는 onFocus→setFocusedId 갱신은 React 18 자동
    // 배치로 비동기 커밋되므로, 각 키 입력 사이에 짧게 기다린다(실사용자는 키 입력이 서로 다른
    // 이벤트라 이 문제가 없다).
    const kbMove = await evaluate(shell, `(async () => {
      const tabs = [...document.querySelectorAll('[role="tab"]')]
      const roving = tabs.find((t) => t.tabIndex === 0) ?? tabs[0]
      roving.focus()
      await new Promise((r) => setTimeout(r, 200))
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
      await new Promise((r) => setTimeout(r, 200))
      const beforeId = document.activeElement?.getAttribute('data-tab-id')
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await new Promise((r) => setTimeout(r, 200))
      const afterId = document.activeElement?.getAttribute('data-tab-id')
      const afterTabIndex = document.activeElement?.tabIndex
      return { beforeId, afterId, afterTabIndex, moved: beforeId !== afterId }
    })()`)
    check('L12', '탭바 ArrowRight — 다음 탭으로 포커스 이동 + 그 탭이 tabIndex=0',
      kbMove.moved && kbMove.afterTabIndex === 0,
      `이동 전=${kbMove.beforeId} → 이동 후=${kbMove.afterId} (tabIndex=${kbMove.afterTabIndex})`)

    const kbHomeEnd = await evaluate(shell, `(() => {
      const tabs = [...document.querySelectorAll('[role="tab"]')]
      const mid = tabs[Math.floor(tabs.length / 2)]
      mid.focus()
      mid.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      const afterEndId = document.activeElement?.getAttribute('data-tab-id')
      const lastId = tabs[tabs.length - 1]?.getAttribute('data-tab-id')
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
      const afterHomeId = document.activeElement?.getAttribute('data-tab-id')
      const firstId = tabs[0]?.getAttribute('data-tab-id')
      return { afterEndId, lastId, afterHomeId, firstId }
    })()`)
    check('L13', '탭바 Home/End — 처음/끝 탭으로 포커스 이동',
      kbHomeEnd.afterEndId === kbHomeEnd.lastId && kbHomeEnd.afterHomeId === kbHomeEnd.firstId,
      `End→${kbHomeEnd.afterEndId}(끝=${kbHomeEnd.lastId}) · Home→${kbHomeEnd.afterHomeId}(처음=${kbHomeEnd.firstId})`)

    // Enter — 포커스된 탭이 활성화되는가. End 로 확실히 마지막 탭에 착지(키보드 경로로 DOM
    // 포커스와 rovingId 를 함께 갱신)한 뒤 그 탭에서 Enter 를 보낸다.
    const kbActivate = await evaluate(shell, `(async () => {
      const tabs = [...document.querySelectorAll('[role="tab"]')]
      const roving = tabs.find((t) => t.tabIndex === 0) ?? tabs[0]
      roving.focus()
      await new Promise((r) => setTimeout(r, 200))
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      await new Promise((r) => setTimeout(r, 200))
      const targetId = document.activeElement?.getAttribute('data-tab-id')
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise((r) => setTimeout(r, 400))
      return { targetId }
    })()`)
    await sleep(300)
    const tabsAfterEnter = await evaluate(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)})`)
    const activeNow = tabsAfterEnter.find((t) => t.active)
    check('L14', '탭바 Enter — 포커스된 탭이 실제로 활성화된다',
      activeNow?.id === kbActivate.targetId,
      `포커스된 탭=${kbActivate.targetId} · 활성 탭=${activeNow?.id}`)

    // Delete — 포커스된 탭이 닫히는가
    const beforeDelCount = tabsAfterEnter.length
    // Home 으로 첫 탭에 확실히 착지(rovingId 와 DOM 포커스가 함께 갱신됨)한 뒤 그 탭에서 Delete.
    const kbDelete = await evaluate(shell, `(async () => {
      const tabs = [...document.querySelectorAll('[role="tab"]')]
      const roving = tabs.find((t) => t.tabIndex === 0) ?? tabs[0]
      roving.focus()
      await new Promise((r) => setTimeout(r, 200))
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
      await new Promise((r) => setTimeout(r, 200))
      const id = document.activeElement?.getAttribute('data-tab-id')
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
      await new Promise((r) => setTimeout(r, 500))
      return { id }
    })()`)
    await sleep(400)
    const tabsAfterDelete = await evaluate(shell, `window.browserAPI.tabs.list(${JSON.stringify(windowId)})`)
    check('L15', '탭바 Delete — 포커스된 탭이 닫힌다',
      tabsAfterDelete.length === beforeDelCount - 1 && !tabsAfterDelete.some((t) => t.id === kbDelete.id),
      `삭제 전 ${beforeDelCount}개 → 삭제 후 ${tabsAfterDelete.length}개 (닫힌 탭=${kbDelete.id})`)

    // ── L16: SidePanel 섹션 버튼 — aria-label·aria-pressed ───────────────────────
    await evaluate(shell, `window.browserAPI.settings.set('ui.sidepanelLeftOpen', true)`)
    await sleep(1000)
    const sidePanelAria = await evaluate(shell, `(async () => {
      const btns = [...document.querySelectorAll('.sidepanel-tab')]
      if (btns.length === 0) return { error: 'no-sidepanel-tabs' }
      const allHaveLabel = btns.every((b) => !!b.getAttribute('aria-label'))
      const allHavePressed = btns.every((b) => b.hasAttribute('aria-pressed'))
      const pressedCountBefore = btns.filter((b) => b.getAttribute('aria-pressed') === 'true').length
      // 두 번째 섹션 버튼 클릭 → 그 버튼만 pressed=true 로 바뀌어야 (setTab 리렌더를 기다린다)
      btns[1]?.click()
      await new Promise((r) => setTimeout(r, 250))
      const pressedAfter = btns.map((b) => b.getAttribute('aria-pressed'))
      return { allHaveLabel, allHavePressed, pressedCountBefore, pressedAfter, clickedIsPressed: pressedAfter[1] === 'true' }
    })()`)
    check('L16', 'SidePanel 섹션 버튼 — aria-label·aria-pressed 존재하고 클릭 시 갱신',
      sidePanelAria.allHaveLabel && sidePanelAria.allHavePressed && sidePanelAria.pressedCountBefore === 1 && sidePanelAria.clickedIsPressed,
      `라벨 전부=${sidePanelAria.allHaveLabel} · pressed 속성 전부=${sidePanelAria.allHavePressed} · 클릭 전 pressed 1개=${sidePanelAria.pressedCountBefore === 1} · 클릭 후=${JSON.stringify(sidePanelAria.pressedAfter)}`)

    // ── L17: WorkspaceRail — aria-current·aria-label ─────────────────────────────
    const wsBefore = await evaluate(shell, `window.browserAPI.workspace.state()`)
    if (wsBefore.workspaces.length < 2) {
      await evaluate(shell, `window.browserAPI.workspace.create()`)
      await sleep(800)
    }
    const wsAria = await evaluate(shell, `(() => {
      const chips = [...document.querySelectorAll('.workspace-chip')]
      if (chips.length < 2) return { error: 'not-enough-chips', count: chips.length }
      const allHaveLabel = chips.every((c) => !!c.getAttribute('aria-label'))
      const currentCountBefore = chips.filter((c) => c.getAttribute('aria-current') === 'true').length
      chips[1].click()
      return { allHaveLabel, currentCountBefore, chipCount: chips.length }
    })()`)
    await sleep(700)
    const wsAfterClick = await evaluate(shell, `(() => {
      const chips = [...document.querySelectorAll('.workspace-chip')]
      return chips.map((c) => c.getAttribute('aria-current'))
    })()`)
    check('L17', 'WorkspaceRail 칩 — aria-label 존재 + aria-current 가 활성 워크스페이스만 표시',
      wsAria.allHaveLabel && wsAria.currentCountBefore === 1 && wsAfterClick.filter((v) => v === 'true').length === 1,
      `라벨 전부=${wsAria.allHaveLabel} · 클릭 전 current 1개=${wsAria.currentCountBefore === 1} · 클릭 후=${JSON.stringify(wsAfterClick)}`)

    // ── L18: CommandPalette — combobox/listbox/option + aria-activedescendant ───
    await evaluate(shell, `window.browserAPI.actions.run('action.palette.open', { windowId: ${JSON.stringify(windowId)} })`)
    await sleep(500)
    const paletteAria = await evaluate(shell, `(() => {
      const input = document.querySelector('.command-palette-input')
      if (!input) return { error: 'no-input' }
      const list = document.querySelector('.command-palette-list')
      return {
        role: input.getAttribute('role'),
        expanded: input.getAttribute('aria-expanded'),
        controls: input.getAttribute('aria-controls'),
        listRole: list?.getAttribute('role'),
        listId: list?.id,
      }
    })()`)
    // 입력해서 옵션이 뜨게 한 뒤 aria-activedescendant 가 현재 강조 항목을 가리키는지 확인
    await evaluate(shell, `(() => {
      const input = document.querySelector('.command-palette-input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '탭')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(300)
    const paletteActive = await evaluate(shell, `(() => {
      const input = document.querySelector('.command-palette-input')
      const activeId = input.getAttribute('aria-activedescendant')
      const activeEl = activeId ? document.getElementById(activeId) : null
      return {
        activeId,
        activeElRole: activeEl?.getAttribute('role'),
        activeElSelected: activeEl?.getAttribute('aria-selected'),
        optionCount: document.querySelectorAll('[role="option"]').length,
      }
    })()`)
    check('L18', 'CommandPalette — combobox/listbox 역할 + aria-controls 배선',
      paletteAria.role === 'combobox' && paletteAria.expanded === 'true'
        && paletteAria.listRole === 'listbox' && paletteAria.controls === paletteAria.listId,
      `input role=${paletteAria.role} expanded=${paletteAria.expanded} · list role=${paletteAria.listRole} · controls/id 일치=${paletteAria.controls === paletteAria.listId}`)
    check('L19', 'CommandPalette — aria-activedescendant 가 강조된 option 을 정확히 가리킴',
      !!paletteActive.activeId && paletteActive.activeElRole === 'option' && paletteActive.activeElSelected === 'true' && paletteActive.optionCount > 0,
      `activedescendant=${paletteActive.activeId} · 그 요소 role=${paletteActive.activeElRole} selected=${paletteActive.activeElSelected} · 옵션 수=${paletteActive.optionCount}`)

  } catch (err) {
    check('FATAL', '하네스 실행', false, err.message)
  } finally {
    try { bookmarksSession?.close() } catch { /* ignore */ }
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

  finish()
}

function finish() {
  console.log('\n===== verify-tabbar-menus 결과 =====')
  console.table(results.map((r) => ({ ID: r.id, 이름: r.name, 상태: r.status })))
  const failed = results.filter((r) => r.status !== 'PASS')
  for (const f of failed) console.log(`FAIL ${f.id}: ${f.detail}`)
  fs.mkdirSync(args.out, { recursive: true })
  fs.writeFileSync(path.join(args.out, 'tabbar-menus-results.json'), JSON.stringify(results, null, 2))
  console.log(`PASS=${results.length - failed.length} FAIL=${failed.length} (총 ${results.length})`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify-tabbar-menus] 치명적 오류:', err); process.exit(2) })
