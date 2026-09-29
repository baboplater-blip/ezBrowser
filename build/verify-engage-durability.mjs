// 블로그 참여 내구성 경계(persistEngageBoundary) 검증 — 앱을 띄우지 않는 순수 Node 검사.
//
// 무엇을 지키는가: blog-engage.ts 의 중복 방지 장부·한도 카운터는 300ms 디바운스로만 저장됐다.
// 에이전트 루프는 클릭 **직전에** 장부를 적지만, 그 기록은 클릭이 나가는 순간 아직 디스크에 없었다.
// 그 창 안에서 앱이 죽으면(크래시·강제 종료·정전) 재시작한 제품은 "아직 안 건드렸다" 고 보고
// 같은 글에 댓글을 또 달거나(스팸), 이미 눌린 좋아요를 다시 눌러 취소한다.
// `persistEngageBoundary()` 는 그 경계를 동기로 확정하는 함수다 — 여기서는 그것이 실제로
// ① 즉시 디스크에 착지하는지 ② 재시작(=새 프로세스)을 넘어 중복을 막는지 ③ 실패를 정직하게
// 보고하는지 ④ 종료 훅이 실제로 걸리는지 ⑤ 과하게 막지는 않는지를 본다.
//
// 패턴은 build/verify-engage-ledger.mjs 를 그대로 따른다 — electron 을 스텁으로 갈아끼우고
// app/dist/main/features/ai/blog-engage.js 를 직접 require 해서 도는 순수 검사다.
//
// ED2(재시작을 넘는 중복 방지)는 **별도 자식 프로세스**로 검증한다 — 그게 "재시작" 을 가장 정직하게
// 재현한다. 같은 프로세스에서 require 캐시를 지우는 방식도 모듈 상태는 리셋하지만, 그것은 여전히
// "같은 프로세스가 계속 살아 있다" 는 가정을 깔고 있어 크래시 재현으로는 약하다.

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const BLOG_ENGAGE_PATH = path.join(REPO, 'app/dist/main/features/ai/blog-engage.js')
const AGENT_GATE_PATH = path.join(REPO, 'app/dist/main/features/ai/agent-gate.js')
const LEDGER_FILE = 'ai-engage-ledger.json'
const QUOTA_FILE = 'ai-engage-quota.json'

// ===== --only / --out 파싱 =====
// (`--out` 은 통합 러너 verify-all.mjs 가 단계마다 자기 출력 디렉터리를 넘기기 때문에 받는다.
//  다른 하네스들과 같은 관례 — 안 넘기면 저장소 기본 위치에 쓴다.)
const args = process.argv.slice(2)
let onlySet = null
let outRoot = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--only' && args[i + 1]) {
    onlySet = new Set(args[i + 1].split(',').map((s) => s.trim()).filter(Boolean))
    i++
  } else if (args[i] === '--out' && args[i + 1]) {
    outRoot = path.resolve(args[i + 1])
    i++
  }
}
function wanted(id) { return onlySet === null || onlySet.has(id) }

// ===== electron 스텁 — currentRoot 을 매 호출 시점에 읽는다(재요청 없이 방을 바꿀 수 있게) =====
let currentRoot = ''
const onLog = [] // { event, handler } — before-quit 등록 여부를 본다(ED5)
const Module = require('module')
const origLoad = Module._load
Module._load = function (req, ...rest) {
  if (req === 'electron') {
    return {
      app: {
        getPath: () => currentRoot,
        on: (event, handler) => { onLog.push({ event, handler }) },
        whenReady: () => Promise.resolve(),
      },
    }
  }
  return origLoad.call(this, req, ...rest)
}

const G = require(AGENT_GATE_PATH)

/** blog-engage.js 의 모듈 상태(cache/index/quota/quitHooked)를 완전히 새로 시작한다. */
function freshEngageModule(root) {
  currentRoot = root
  const resolved = require.resolve(BLOG_ENGAGE_PATH)
  delete require.cache[resolved]
  return require(BLOG_ENGAGE_PATH)
}

const tempRoots = []
function freshRoot(tag) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), `bb-engage-dur-${tag}-`))
  tempRoots.push(r)
  return r
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return null }
}

/** 자식 프로세스에서 blog-engage.js 를 그 root 로 돌린다 — "재시작" 을 가장 정직하게 재현한다. */
function runChild(root, body, timeoutMs = 15000) {
  const code = [
    "const Module = require('module');",
    'const orig = Module._load;',
    `const root = ${JSON.stringify(root)};`,
    "Module._load = function (req, ...rest) {",
    "  if (req === 'electron') return { app: { getPath: () => root, on: () => {}, whenReady: () => Promise.resolve() } };",
    '  return orig.call(this, req, ...rest);',
    '};',
    `const E = require(${JSON.stringify(BLOG_ENGAGE_PATH)});`,
    body,
  ].join('\n')
  const res = spawnSync(process.execPath, ['-e', code], { encoding: 'utf-8', timeout: timeoutMs })
  return res
}

// ===== 결과 수집 =====
const results = []
let anyFail = false

/** 하나의 ED 항목을 실행한다. fn 은 { checks: [{desc, ok, detail}], summary? } 를 돌려준다. */
function section(id, name, fn) {
  if (!wanted(id)) {
    console.log(`\n== ${id} ${name} == SKIP (--only 로 제외됨)`)
    results.push({ id, name, status: 'SKIP', detail: '--only 로 제외됨' })
    return
  }
  console.log(`\n== ${id} ${name} ==`)
  let out
  try {
    out = fn()
  } catch (err) {
    console.log('  FAIL (예외)', err && err.stack ? err.stack : String(err))
    results.push({ id, name, status: 'FAIL', detail: `예외: ${err && err.message ? err.message : String(err)}` })
    anyFail = true
    return
  }
  if (out && out.skip) {
    console.log('  SKIP', out.reason || '')
    results.push({ id, name, status: 'SKIP', detail: out.reason || '' })
    return
  }
  const checks = (out && out.checks) || []
  let ok = true
  const failedDescs = []
  for (const c of checks) {
    if (c.ok) { console.log('  PASS', c.desc) }
    else { console.log('  FAIL', c.desc, c.detail ?? ''); ok = false; failedDescs.push(`${c.desc}${c.detail ? ` (${c.detail})` : ''}`) }
  }
  const status = ok ? 'PASS' : 'FAIL'
  if (!ok) anyFail = true
  results.push({
    id, name, status,
    detail: ok ? (out && out.summary ? out.summary : '') : failedDescs.join(' / '),
  })
}

// =====================================================================================
// ED1 — 경계가 통과하면 장부가 그 자리에서 디스크에 있다
// =====================================================================================
section('ED1', '경계 통과 → 즉시 디스크 착지(디바운스 대기 없음)', () => {
  const root = freshRoot('ed1')
  const E = freshEngageModule(root)
  E.initEngageLedger()
  const key = E.normalizeTargetUrl('https://blog.example/post/ed1')
  const guard = { account: 'me', mode: 'act', comment: true, like: true, guardId: 'ed1-guard', limit: 5, intervalMs: 0, until: 0 }

  E.recordEngagement({ key, account: 'me', action: 'comment', note: 'ED1 테스트' })
  E.engageQuotaRecord(guard, 'comment')

  const ledgerPathBefore = path.join(root, LEDGER_FILE)
  const quotaPathBefore = path.join(root, QUOTA_FILE)
  const existedBeforePersist = fs.existsSync(ledgerPathBefore) || fs.existsSync(quotaPathBefore)

  const r = E.persistEngageBoundary()

  // 디바운스를 기다리지 않고 **바로 지금** 확인한다.
  const ledgerJson = readJsonIfExists(ledgerPathBefore)
  const quotaJson = readJsonIfExists(quotaPathBefore)
  const ledgerHasEntry = !!ledgerJson && Array.isArray(ledgerJson.entries)
    && ledgerJson.entries.some((e) => e.key === key && e.account === 'me' && e.action === 'comment')
  const quotaHasEntry = !!quotaJson && quotaJson.records && quotaJson.records['ed1-guard']
    && quotaJson.records['ed1-guard'].comment === 1

  return {
    checks: [
      { desc: '반환값 ok:true', ok: r.ok === true, detail: JSON.stringify(r) },
      { desc: '반환값 failed 는 빈 배열', ok: Array.isArray(r.failed) && r.failed.length === 0, detail: JSON.stringify(r.failed) },
      { desc: '경계 호출 전에는 파일이 없었다(디바운스가 아직 안 돔을 확인)', ok: existedBeforePersist === false },
      { desc: '경계 호출 직후 장부 파일이 즉시 존재하고 그 항목을 담고 있다', ok: ledgerHasEntry, detail: ledgerJson ? JSON.stringify(ledgerJson) : '파일 없음' },
      { desc: '경계 호출 직후 한도 파일이 즉시 존재하고 그 항목을 담고 있다', ok: quotaHasEntry, detail: quotaJson ? JSON.stringify(quotaJson) : '파일 없음' },
    ],
  }
})

// =====================================================================================
// ED2 — 재시작을 넘어 중복이 막힌다 (핵심) — 자식 프로세스로 재현
// =====================================================================================
section('ED2', '재시작 후에도 중복이 막힌다(양성) / 경계 없이 죽으면 뚫린다(부정 대조)', () => {
  const checks = []

  // ---- 양성: recordEngagement + engageQuotaRecord + persistEngageBoundary 후 정상 종료 ----
  const rootPos = freshRoot('ed2-pos')
  const keyPos = 'https://blog.example/post/ed2-pos'
  const bodyWrite = [
    "E.initEngageLedger();",
    `const key = E.normalizeTargetUrl(${JSON.stringify(keyPos)});`,
    "const guard = { account: 'me', mode: 'act', comment: true, like: true, guardId: 'ed2-pos', limit: 5, intervalMs: 0, until: 0 };",
    "E.recordEngagement({ key, account: 'me', action: 'comment' });",
    "E.engageQuotaRecord(guard, 'comment');",
    "const r = E.persistEngageBoundary();",
    "process.stdout.write(JSON.stringify(r));",
    "process.exit(r.ok ? 0 : 1);",
  ].join('\n')
  const w1 = runChild(rootPos, bodyWrite)
  let w1json = null
  try { w1json = JSON.parse(w1.stdout || 'null') } catch { /* ignore */ }
  checks.push({ desc: '자식1(경계 호출 후 정상 종료) exit 0', ok: w1.status === 0, detail: `status=${w1.status} stderr=${w1.stderr}` })
  checks.push({ desc: '자식1 이 ok:true 를 돌려줬다', ok: !!w1json && w1json.ok === true, detail: JSON.stringify(w1json) })

  const bodyCheck = [
    "E.initEngageLedger();",
    `const key = E.normalizeTargetUrl(${JSON.stringify(keyPos)});`,
    "const did = E.alreadyDid(key, 'me', 'comment');",
    "process.stdout.write(JSON.stringify({ did }));",
    "process.exit(0);",
  ].join('\n')
  const c1 = runChild(rootPos, bodyCheck)
  let c1json = null
  try { c1json = JSON.parse(c1.stdout || 'null') } catch { /* ignore */ }
  checks.push({ desc: '새 프로세스(재시작)에서 alreadyDid === true — 중복이 막힌다', ok: !!c1json && c1json.did === true, detail: JSON.stringify(c1json) })

  // ---- 부정 대조: recordEngagement 만 하고 persistEngageBoundary 를 부르지 않은 채 즉시 종료 ----
  // (300ms 디바운스가 뜨기 전에 process.exit — "경계 없이 크래시" 를 재현한다)
  const rootNeg = freshRoot('ed2-neg')
  const keyNeg = 'https://blog.example/post/ed2-neg'
  const bodyCrash = [
    "E.initEngageLedger();",
    `const key = E.normalizeTargetUrl(${JSON.stringify(keyNeg)});`,
    "const guard = { account: 'me', mode: 'act', comment: true, like: true, guardId: 'ed2-neg', limit: 5, intervalMs: 0, until: 0 };",
    "E.recordEngagement({ key, account: 'me', action: 'comment' });",
    "E.engageQuotaRecord(guard, 'comment');",
    // 의도적으로 persistEngageBoundary() 를 부르지 않는다 — 여기서 즉시 죽는다.
    "process.exit(0);",
  ].join('\n')
  const w2 = runChild(rootNeg, bodyCrash)
  checks.push({ desc: '자식2(경계 없이 즉시 종료) 정상 실행', ok: w2.status === 0, detail: `status=${w2.status} stderr=${w2.stderr}` })

  const ledgerFileAfterCrash = fs.existsSync(path.join(rootNeg, LEDGER_FILE))
  checks.push({ desc: '경계를 안 부르면 디스크에 장부 파일이 아예 없다(디바운스가 못 떴다)', ok: ledgerFileAfterCrash === false })

  const c2 = runChild(rootNeg, [
    "E.initEngageLedger();",
    `const key = E.normalizeTargetUrl(${JSON.stringify(keyNeg)});`,
    "const did = E.alreadyDid(key, 'me', 'comment');",
    "process.stdout.write(JSON.stringify({ did }));",
    "process.exit(0);",
  ].join('\n'))
  let c2json = null
  try { c2json = JSON.parse(c2.stdout || 'null') } catch { /* ignore */ }
  const bugReproduced = !!c2json && c2json.did === false
  checks.push({
    desc: '부정 대조 — 경계 없이 죽으면 재시작 후 alreadyDid === false (결함이 실제로 재현된다)',
    ok: bugReproduced,
    detail: JSON.stringify(c2json),
  })

  return { checks, summary: `부정 대조 재현 ${bugReproduced ? '성공' : '실패(재현 못 함 — 아래 참고)'}` }
})

// =====================================================================================
// ED3 — 한도 카운터도 같은 경계를 넘는다
// =====================================================================================
section('ED3', '한도(quota) 카운터도 재시작을 넘어 보존된다', () => {
  const root = freshRoot('ed3')
  const guardId = 'ed3-guard'
  const bodyWrite = [
    "E.initEngageLedger();",
    `const guard = { account: 'me', mode: 'act', comment: true, like: true, guardId: ${JSON.stringify(guardId)}, limit: 10, intervalMs: 0, until: 0 };`,
    "const k1 = E.normalizeTargetUrl('https://blog.example/post/ed3-a');",
    "const k2 = E.normalizeTargetUrl('https://blog.example/post/ed3-b');",
    "E.recordEngagement({ key: k1, account: 'me', action: 'comment' });",
    "E.engageQuotaRecord(guard, 'comment');",
    "E.recordEngagement({ key: k2, account: 'me', action: 'comment' });",
    "E.engageQuotaRecord(guard, 'comment');",
    "const r = E.persistEngageBoundary();",
    "process.stdout.write(JSON.stringify(r));",
    "process.exit(r.ok ? 0 : 1);",
  ].join('\n')
  const w = runChild(root, bodyWrite)
  let wjson = null
  try { wjson = JSON.parse(w.stdout || 'null') } catch { /* ignore */ }

  const c = runChild(root, [
    "E.initEngageLedger();",
    `const used = E.engageQuotaUsed(${JSON.stringify(guardId)});`,
    "process.stdout.write(JSON.stringify(used));",
    "process.exit(0);",
  ].join('\n'))
  let cjson = null
  try { cjson = JSON.parse(c.stdout || 'null') } catch { /* ignore */ }

  return {
    checks: [
      { desc: '자식1(2건 기록 + 경계) exit 0', ok: w.status === 0, detail: `status=${w.status} stderr=${w.stderr}` },
      { desc: '자식1 이 ok:true 를 돌려줬다', ok: !!wjson && wjson.ok === true, detail: JSON.stringify(wjson) },
      { desc: '자식2(재시작) exit 0', ok: c.status === 0, detail: `status=${c.status} stderr=${c.stderr}` },
      { desc: '재시작 후에도 comment 카운트 2 가 보존된다(0 으로 되돌아가지 않는다)', ok: !!cjson && cjson.comment === 2, detail: JSON.stringify(cjson) },
    ],
  }
})

// =====================================================================================
// ED4 — 경계가 실패하면 정직하게 돌려준다
// =====================================================================================
// 막는 방법: 대상 파일 경로에 **디렉터리**를 미리 만들어 둔다. writeFileSync(tmp,...) 는 성공하지만
// renameSync(tmp, file) 이 EPERM(디렉터리 위로 rename 불가)으로 실패한다 — 실측으로 확인된 방법.
// 순서가 중요하다: initEngageLedger() 를 **먼저** 정상 상태로 실행해 module 캐시를 채운 뒤에
// 디렉터리를 만들어야 한다 — 그렇지 않으면 loadJsonObject 가 "손상 파일"로 보고 quarantine(rename)
// 해서 디렉터리를 치워버려, 막는 효과가 사라진다.
section('ED4', '경계 실패를 정직하게 보고한다(파일명 포함)', () => {
  const checks = []

  // ---- 4a: 장부만 막는다 ----
  {
    const root = freshRoot('ed4a')
    const E = freshEngageModule(root)
    E.initEngageLedger() // 정상 상태로 먼저 채운다(파일 아직 없음 → null 로 안전하게 초기화)
    const key = E.normalizeTargetUrl('https://blog.example/post/ed4a')
    E.recordEngagement({ key, account: 'me', action: 'comment' }) // 장부만 dirty (quota 는 건드리지 않음)

    fs.mkdirSync(path.join(root, LEDGER_FILE)) // 장부 파일 자리를 디렉터리로 선점

    const r = E.persistEngageBoundary()
    checks.push({ desc: '(4a) 장부만 막으면 ok:false', ok: r.ok === false, detail: JSON.stringify(r) })
    checks.push({ desc: '(4a) failed 에 정확히 1개, 장부 파일명 포함', ok: Array.isArray(r.failed) && r.failed.length === 1 && r.failed[0].includes(LEDGER_FILE), detail: JSON.stringify(r.failed) })
    checks.push({ desc: '(4a) failed 에 한도 파일명은 없다(건드리지 않은 저장소는 막히지 않았다고 보고)', ok: !r.failed.some((f) => f.includes(QUOTA_FILE)), detail: JSON.stringify(r.failed) })
  }

  // ---- 4b: 한도만 막는다 ----
  {
    const root = freshRoot('ed4b')
    const E = freshEngageModule(root)
    E.initEngageLedger()
    const guard = { account: 'me', mode: 'act', comment: true, like: true, guardId: 'ed4b-guard', limit: 5, intervalMs: 0, until: 0 }
    E.engageQuotaRecord(guard, 'comment') // 한도만 dirty (장부는 건드리지 않음)

    fs.mkdirSync(path.join(root, QUOTA_FILE))

    const r = E.persistEngageBoundary()
    checks.push({ desc: '(4b) 한도만 막으면 ok:false', ok: r.ok === false, detail: JSON.stringify(r) })
    checks.push({ desc: '(4b) failed 에 정확히 1개, 한도 파일명 포함', ok: Array.isArray(r.failed) && r.failed.length === 1 && r.failed[0].includes(QUOTA_FILE), detail: JSON.stringify(r.failed) })
  }

  // ---- 4c: 둘 다 막는다 ----
  {
    const root = freshRoot('ed4c')
    const E = freshEngageModule(root)
    E.initEngageLedger()
    const key = E.normalizeTargetUrl('https://blog.example/post/ed4c')
    const guard = { account: 'me', mode: 'act', comment: true, like: true, guardId: 'ed4c-guard', limit: 5, intervalMs: 0, until: 0 }
    E.recordEngagement({ key, account: 'me', action: 'comment' })
    E.engageQuotaRecord(guard, 'comment')

    fs.mkdirSync(path.join(root, LEDGER_FILE))
    fs.mkdirSync(path.join(root, QUOTA_FILE))

    const r = E.persistEngageBoundary()
    checks.push({ desc: '(4c) 둘 다 막으면 ok:false', ok: r.ok === false, detail: JSON.stringify(r) })
    checks.push({ desc: '(4c) failed 에 2개, 둘 다의 파일명 포함', ok: Array.isArray(r.failed) && r.failed.length === 2 && r.failed.some((f) => f.includes(LEDGER_FILE)) && r.failed.some((f) => f.includes(QUOTA_FILE)), detail: JSON.stringify(r.failed) })
  }

  return { checks }
})

// =====================================================================================
// ED5 — 종료 훅이 실제로 걸린다
// =====================================================================================
section('ED5', 'before-quit 훅이 정확히 1번 등록되고, 부르면 실제로 flush 한다', () => {
  const root = freshRoot('ed5')
  onLog.length = 0 // 이 섹션 전용으로 비운다
  const E = freshEngageModule(root)

  E.initEngageLedger()
  const afterFirst = onLog.filter((x) => x.event === 'before-quit')
  E.initEngageLedger() // 여러 번 불러도 중복 등록되면 안 된다
  E.initEngageLedger()
  const afterMultiple = onLog.filter((x) => x.event === 'before-quit')

  const key = E.normalizeTargetUrl('https://blog.example/post/ed5')
  E.recordEngagement({ key, account: 'me', action: 'comment' }) // 디바운스만 걸림, 아직 디스크에 없음
  const existedBeforeHook = fs.existsSync(path.join(root, LEDGER_FILE))

  let hookInvokeOk = false
  let hookInvokeErr = ''
  if (afterMultiple.length >= 1) {
    try { afterMultiple[0].handler(); hookInvokeOk = true } catch (err) { hookInvokeErr = String(err) }
  }
  const ledgerJson = readJsonIfExists(path.join(root, LEDGER_FILE))
  const hasEntry = !!ledgerJson && Array.isArray(ledgerJson.entries) && ledgerJson.entries.some((e) => e.key === key)

  return {
    checks: [
      { desc: '첫 initEngageLedger() 호출로 before-quit 가 정확히 1개 등록된다', ok: afterFirst.length === 1, detail: `count=${afterFirst.length}` },
      { desc: '여러 번 불러도 before-quit 등록이 중복되지 않는다(여전히 1개)', ok: afterMultiple.length === 1, detail: `count=${afterMultiple.length}` },
      { desc: '훅 호출 전에는 디바운스 대기 중이던 기록이 디스크에 없다', ok: existedBeforeHook === false },
      { desc: '등록된 핸들러를 직접 호출해도 예외 없이 실행된다', ok: hookInvokeOk, detail: hookInvokeErr },
      { desc: '핸들러 호출 후 디바운스 대기 중이던 기록이 디스크에 확정된다', ok: hasEntry, detail: ledgerJson ? JSON.stringify(ledgerJson) : '파일 없음' },
    ],
  }
})

// =====================================================================================
// ED6 — 양성 대조: 경계가 중복 방지를 과하게 만들지 않는다
// =====================================================================================
section('ED6', '양성 대조 — 다른 글·다른 행동·다른 계정은 막히지 않는다', () => {
  const root = freshRoot('ed6')
  const E = freshEngageModule(root)
  E.initEngageLedger()

  const keyA = E.normalizeTargetUrl('https://blog.example/post/ed6-a')
  const keyB = E.normalizeTargetUrl('https://blog.example/post/ed6-b')

  E.recordEngagement({ key: keyA, account: 'me', action: 'comment' })
  const r1 = E.persistEngageBoundary()

  const checks = [
    { desc: '기준 기록의 경계는 정상 확정된다', ok: r1.ok === true, detail: JSON.stringify(r1) },
    { desc: '다른 글(keyB)은 아직 안 한 것으로 남는다', ok: E.alreadyDid(keyB, 'me', 'comment') === false },
    { desc: '같은 글이라도 다른 행동(like)은 아직 안 한 것으로 남는다', ok: E.alreadyDid(keyA, 'me', 'like') === false },
    { desc: '같은 글·같은 행동이라도 다른 계정은 아직 안 한 것으로 남는다', ok: E.alreadyDid(keyA, 'other', 'comment') === false },
  ]

  // 이 "안 막힘" 이 실제로 기록·경계까지 정상 동작하는지도 확인한다(단순 조회만 통과하는 걸로 착각하지 않게).
  E.recordEngagement({ key: keyB, account: 'me', action: 'comment' })
  E.recordEngagement({ key: keyA, account: 'me', action: 'like' })
  E.recordEngagement({ key: keyA, account: 'other', action: 'comment' })
  const r2 = E.persistEngageBoundary()
  checks.push({ desc: '다른 조합 3건을 실제로 기록·경계 확정해도 성공한다', ok: r2.ok === true, detail: JSON.stringify(r2) })
  checks.push({ desc: '기록 후에는 그 조합들도 각각 alreadyDid === true 로 바뀐다', ok: E.alreadyDid(keyB, 'me', 'comment') === true && E.alreadyDid(keyA, 'me', 'like') === true && E.alreadyDid(keyA, 'other', 'comment') === true })

  return { checks }
})

// ===== 정리 및 결과 저장 =====
for (const r of tempRoots) {
  try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ }
}

const passCount = results.filter((r) => r.status === 'PASS').length
const failCount = results.filter((r) => r.status === 'FAIL').length
const skipCount = results.filter((r) => r.status === 'SKIP').length
console.log(`\n합계 PASS ${passCount} / FAIL ${failCount} / SKIP ${skipCount}`)

const outDir = outRoot ?? path.join(REPO, 'verify-out', 'engage-durability')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(
  path.join(outDir, 'engage-durability-results.json'),
  JSON.stringify({ at: new Date().toISOString(), pass: passCount, fail: failCount, skip: skipCount, results }, null, 2),
)

process.exit(anyFail || failCount > 0 ? 1 : 0)
