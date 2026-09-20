#!/usr/bin/env node
// verify-session-schema.mjs — 세션 내구성의 **순수 판정부**를 앱 없이 결정론적으로 시험한다.
//
// 왜 따로 있나: "강제 종료 뒤 탭이 사라진다" 의 원인 두 가지는 둘 다 순수 로직이다.
//   1) 저장 기한 계산 — 제목·파비콘 같은 잡음성 변경이 구조 변경의 기한을 **뒤로 밀어** 버렸다.
//   2) 스냅샷 모양 검증 — 항목 하나가 이상하면 그 창의 나머지 탭까지 날아갔다.
// 앱을 띄워 이 둘을 시험하면 타이밍에 흔들리고 한 번 도는 데 수십 초가 든다.
// 여기서는 가상 시계로 100번 두드려도 1초가 안 걸리고, 결과가 매번 같다.
//
// 대상은 컴파일 산출물(app/dist/main/…)이다 — 실제로 앱이 싣는 바로 그 코드.
// (두 모듈은 타입만 import 하므로 electron 없이 노드에서 그대로 불린다.)
//
// 사용: node build/verify-session-schema.mjs [--out <dir>]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const DIST = path.join(REPO_ROOT, 'app', 'dist', 'main', 'features', 'session')

let outDir = path.join(REPO_ROOT, 'verify-out', 'session-schema')
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--out') outDir = path.resolve(process.argv[++i] ?? outDir)
}

const checks = []
function record(id, name, ok, detail) {
  checks.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}\n      ${detail}`)
}

const SCHEMA_VERSION = 1

async function main() {
  for (const f of ['save-deadlines.js', 'snapshot-schema.js']) {
    if (!fs.existsSync(path.join(DIST, f))) {
      console.error(`[session-schema] 컴파일 산출물이 없습니다: ${path.join(DIST, f)}\n`
        + '  먼저 `npm run build:main` 을 돌리세요.')
      process.exit(2)
    }
  }
  const { SaveDeadlines } = await import(pathToFileURL(path.join(DIST, 'save-deadlines.js')).href)
  const { sanitizeSnapshotShape } = await import(pathToFileURL(path.join(DIST, 'snapshot-schema.js')).href)

  // ── 저장 기한 ─────────────────────────────────────────────────────────

  // SS1: 이 라운드의 핵심. 탭을 하나 만든 뒤(구조 변경) 페이지가 로딩되며 제목·파비콘이
  //      쉴 새 없이 바뀌어도, 구조 변경의 기한은 **한 번 잡힌 그 시각 그대로**여야 한다.
  {
    const d = new SaveDeadlines()
    d.markStructural(0, 1000)          // 탭 생성 — 1초 뒤에 저장하기로
    for (let t = 50; t <= 4000; t += 50) d.markSoft(t, 5000) // 제목 변동 80회
    const due = d.nextDueAt()
    record('SS1', '잡음성 변경이 구조 변경의 저장 기한을 뒤로 밀지 못한다',
      due === 1000, `제목 변동 80회 이후 기한=${due} (기대 1000)`)
  }

  // SS2: 부정 대조 — 잡음성 변경만 있을 때는 예전처럼 합쳐져야 한다.
  //      (모든 이벤트를 즉시 저장으로 바꿔 버리면 SS1 은 통과하지만 매 이벤트마다 디스크를 쓴다.)
  {
    const d = new SaveDeadlines()
    d.markSoft(0, 5000)
    d.markSoft(100, 5000)
    d.markSoft(900, 5000)
    const due = d.nextDueAt()
    record('SS2', '잡음성 변경끼리는 여전히 합쳐진다(매 이벤트 디스크 쓰기 아님)',
      due === 5900, `기한=${due} (기대 5900 = 마지막 이벤트 900 + 5000)`)
  }

  // SS3: 구조 변경이 여러 번 와도 기한은 **앞당겨질 수만** 있다.
  {
    const d = new SaveDeadlines()
    d.markStructural(1000, 1000)   // 2000
    d.markStructural(1500, 1000)   // 2500 — 뒤로 밀면 안 된다
    const after = d.nextDueAt()
    const d2 = new SaveDeadlines()
    d2.markStructural(1000, 1000)  // 2000
    d2.markStructural(1100, 100)   // 1200 — 앞당기는 것은 허용
    const earlier = d2.nextDueAt()
    record('SS3', '구조 변경 기한은 앞당겨질 수만 있다',
      after === 2000 && earlier === 1200, `뒤늦은 표시=${after}(기대 2000) · 앞당김=${earlier}(기대 1200)`)
  }

  // SS4: 저장을 마치면 두 기한 모두 비워진다(같은 스냅샷을 반복해서 쓰지 않는다).
  {
    const d = new SaveDeadlines()
    d.markStructural(0, 1000); d.markSoft(0, 5000)
    d.clear()
    record('SS4', '저장 후 대기 중인 기한이 남지 않는다',
      d.nextDueAt() === null && d.hasStructural() === false, `기한=${d.nextDueAt()} · 구조대기=${d.hasStructural()}`)
  }

  // SS13: 이른 구조 저장이 **뒤따르는 "가라앉은 뒤의 저장" 을 잡아먹지 않는다.**
  //       스크롤·폼은 메인에 이벤트를 안 내고, Chromium 이 pageState 에 반영하는 데도 몇 초 걸린다.
  //       1초 만에 뜬 스냅샷만 남으면 그 값들이 낡은 채로 굳는다(2026-09-20 실제 회귀).
  {
    const d = new SaveDeadlines()
    d.markStructural(0, 1000)   // 탭 생성
    d.markSoft(300, 5000)       // 그 탭이 로딩되며 제목 변동 → 5300 에 가라앉은 저장
    const first = d.nextDueAt()
    d.consumeDue(1000)          // 1000 에 구조 저장이 떴다
    const remaining = d.nextDueAt()
    record('SS13', '이른 구조 저장이 뒤따르는 정착 저장을 잡아먹지 않는다',
      first === 1000 && remaining === 5300, `첫 저장=${first}(기대 1000) · 남은 기한=${remaining}(기대 5300)`)
  }

  // SS14: 대기 중인 정착 저장이 없으면 구조 저장이 하나 만들어 준다 — 그러나 **한 번만**.
  //       (매 저장마다 다음 저장을 예약하면 아무 활동이 없어도 5초마다 디스크를 쓴다.)
  {
    const d = new SaveDeadlines()
    d.markStructural(0, 1000)
    d.consumeDue(1000)
    const structuralWasDue = true
    d.ensureSoft(1000, 5000)              // 구조 저장이라 정착 저장을 붙인다 → 6000
    const followUp = d.nextDueAt()
    // 6000 에 정착 저장이 뜬다. 이번엔 구조 저장이 아니므로 아무것도 더 붙이지 않는다.
    const wasStructuralAtFollowUp = d.isStructuralDue(6000)
    d.consumeDue(6000)
    const afterFollowUp = d.nextDueAt()
    record('SS14', '구조 저장은 정착 저장을 한 번만 붙인다(무한 저장 루프 없음)',
      structuralWasDue && followUp === 6000 && wasStructuralAtFollowUp === false && afterFollowUp === null,
      `정착 저장=${followUp}(기대 6000) · 정착 시점의 구조여부=${wasStructuralAtFollowUp}(기대 false) · 그 뒤 기한=${afterFollowUp}(기대 null)`)
  }

  // SS15: 정착 저장이 이미 예약돼 있으면 그것을 **뒤로 밀지 않는다**.
  {
    const d = new SaveDeadlines()
    d.markSoft(0, 5000)     // 5000 에 예약됨
    d.ensureSoft(1000, 5000) // 이미 있으므로 6000 으로 밀면 안 된다
    record('SS15', '이미 예약된 정착 저장을 뒤로 밀지 않는다',
      d.nextDueAt() === 5000, `기한=${d.nextDueAt()} (기대 5000)`)
  }

  // ── 스냅샷 모양 검증 ───────────────────────────────────────────────────

  const win = (tabs, extra = {}) => ({
    windowId: 'w1', bounds: { x: 0, y: 0, width: 1200, height: 800 },
    activeTabId: 't1', tabs, ...extra,
  })
  const tab = (url, extra = {}) => ({
    url, title: `t ${url}`, pinned: false, workspaceId: 'ws1', active: false, index: 0, ...extra,
  })

  // SS5: 가운데 항목이 망가져도 앞뒤의 멀쩡한 탭은 살아남는다 (이 라운드의 두 번째 원인).
  {
    const res = sanitizeSnapshotShape({
      version: SCHEMA_VERSION, savedAt: 123,
      windows: [win([
        tab('http://127.0.0.1:1/p?n=1', { index: 0 }),
        { url: 42, title: null, index: 1 },              // 손상
        tab('http://127.0.0.1:1/p?n=3', { index: 2 }),
      ])],
    }, SCHEMA_VERSION)
    const urls = res.ok ? res.snapshot.windows[0].tabs.map((t) => t.url) : []
    record('SS5', '손상된 탭 하나가 같은 창의 유효한 탭들을 무너뜨리지 않는다',
      res.ok && urls.length === 2 && urls[0].endsWith('n=1') && urls[1].endsWith('n=3')
        && res.snapshot.droppedTabs === 1,
      `살아남은 탭=${JSON.stringify(urls)} · 버린 탭=${res.ok ? res.snapshot.droppedTabs : 'n/a'}`)
  }

  // SS6: 스키마 버전이 다른 파일은 **손상이 아니다** — 격리하면 안 된다.
  //      (예전 라운드에서 정상 파일을 손상으로 오판해 매 부팅마다 격리한 사고가 있었다.)
  {
    const res = sanitizeSnapshotShape({ version: 99, windows: [] }, SCHEMA_VERSION)
    record('SS6', '버전 불일치는 손상으로 취급하지 않는다(격리 금지)',
      res.ok === false && res.corrupt === false, `ok=${res.ok} corrupt=${res.corrupt} 사유=${res.reason}`)
  }

  // SS7: 진짜로 읽을 수 없는 모양만 "손상" 이다 — 증거 보존 대상.
  {
    const a = sanitizeSnapshotShape(null, SCHEMA_VERSION)
    const b = sanitizeSnapshotShape('not an object', SCHEMA_VERSION)
    const c = sanitizeSnapshotShape({ version: SCHEMA_VERSION, windows: 'nope' }, SCHEMA_VERSION)
    const d = sanitizeSnapshotShape([1, 2, 3], SCHEMA_VERSION)
    const all = [a, b, c, d]
    record('SS7', '읽을 수 없는 모양만 손상으로 표시된다',
      all.every((r) => r.ok === false && r.corrupt === true),
      all.map((r) => `${r.ok}/${r.corrupt}`).join(' · '))
  }

  // SS8: 복원이 스킴을 넓히지 않는다 — 저장할 때와 같은 규칙만 통과.
  {
    const res = sanitizeSnapshotShape({
      version: SCHEMA_VERSION, savedAt: 1,
      windows: [win([
        tab('javascript:alert(1)'),
        tab('file:///C:/Windows/System32/drivers/etc/hosts'),
        tab('data:text/html,<h1>x'),
        tab('https://example.com/ok'),
        tab('browser://settings'),
      ])],
    }, SCHEMA_VERSION)
    const urls = res.ok ? res.snapshot.windows[0].tabs.map((t) => t.url) : []
    record('SS8', '복원 대상 스킴이 넓어지지 않는다(javascript:·file:·data: 거부)',
      res.ok && urls.length === 2 && urls.includes('https://example.com/ok') && urls.includes('browser://settings'),
      `통과한 URL=${JSON.stringify(urls)}`)
  }

  // SS9: 탭이 하나도 살아남지 못한 창은 만들지 않는다(빈 껍데기 창 방지).
  {
    const res = sanitizeSnapshotShape({
      version: SCHEMA_VERSION, savedAt: 1,
      windows: [win([tab('javascript:bad')]), win([tab('https://example.com/ok')])],
    }, SCHEMA_VERSION)
    record('SS9', '살아남은 탭이 없는 창은 복원하지 않는다',
      res.ok && res.snapshot.windows.length === 1 && res.snapshot.droppedWindows === 1,
      `복원할 창=${res.ok ? res.snapshot.windows.length : 'n/a'} · 버린 창=${res.ok ? res.snapshot.droppedWindows : 'n/a'}`)
  }

  // SS10: bounds 가 망가져도 탭은 지킨다 (창 크기는 잃어도 되지만 탭은 안 된다).
  {
    const res = sanitizeSnapshotShape({
      version: SCHEMA_VERSION, savedAt: 1,
      windows: [win([tab('https://example.com/ok')], { bounds: { x: 0, y: 0, width: 'wide', height: -3 } })],
    }, SCHEMA_VERSION)
    const w = res.ok ? res.snapshot.windows[0] : null
    record('SS10', '창 크기가 망가져도 탭은 복원된다',
      !!w && w.bounds === undefined && w.tabs.length === 1,
      `bounds=${JSON.stringify(w?.bounds)} · 탭=${w?.tabs.length}`)
  }

  // SS11: 적대적 입력에도 절대 예외를 던지지 않는다 — 여기서 던지면 부팅이 통째로 막힌다.
  {
    const nasty = [
      undefined, 0, false, { version: SCHEMA_VERSION, windows: [null, 1, 'x', [], {}] },
      { version: SCHEMA_VERSION, windows: [{ tabs: null }] },
      { version: SCHEMA_VERSION, savedAt: NaN, windows: [win([tab('https://a/', { history: [1, null, { url: 2 }] })])] },
      { version: SCHEMA_VERSION, windows: [win([tab('https://a/', { index: 'x', historyIndex: {} })])] },
    ]
    let threw = null
    for (const input of nasty) {
      try { sanitizeSnapshotShape(input, SCHEMA_VERSION) }
      catch (err) { threw = `${JSON.stringify(input)} → ${err.message}`; break }
    }
    record('SS11', '적대적 입력에도 예외를 던지지 않는다(부팅을 막지 않는다)',
      threw === null, threw ?? `${nasty.length}종 입력 전부 예외 없음`)
  }

  // SS12: savedAt 이 숫자가 아니면 0 으로 — 스냅샷 선택(더 최신 쪽)이 NaN 비교로 무너지지 않게.
  {
    const res = sanitizeSnapshotShape({
      version: SCHEMA_VERSION, savedAt: 'yesterday',
      windows: [win([tab('https://example.com/ok')])],
    }, SCHEMA_VERSION)
    record('SS12', 'savedAt 이 숫자가 아니면 0 으로 정규화된다',
      res.ok && res.snapshot.savedAt === 0, `savedAt=${res.ok ? res.snapshot.savedAt : 'n/a'}`)
  }

  const pass = checks.filter((c) => c.status === 'PASS').length
  const fail = checks.filter((c) => c.status === 'FAIL').length
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'results.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), checks, summary: { pass, fail, skip: 0 } }, null, 2))
  console.log(`\n[session-schema] ${pass} PASS / ${fail} FAIL`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => { console.error('[session-schema] 실행 실패', err); process.exit(2) })
