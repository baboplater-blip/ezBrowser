#!/usr/bin/env node
// verify-all.mjs — 흩어져 있는 검증 하네스를 하나의 게이트로 묶는 통합 러너.
//
// 왜 필요한가 (2026-09-06, auto-dev 임무 A 에서 드러난 구멍):
//   스모크·에이전트 안전·다운로드·확장·성능·스트레스·복원 하네스가 각각 따로 존재해서,
//   라운드마다 "무엇을 돌려야 하는지"를 사람이 기억해야 했다. 실제로 묶음 YTDLP-1 은
//   게이트 0(typecheck·build)만 돌고 끝났고, 그 상태가 미검증으로 남았다.
//   기억에 의존하는 게이트는 게이트가 아니다 — 목록을 코드로 고정한다.
//
// 사용:
//   node build/verify-all.mjs --quick        # 게이트 0 + 스모크 (라운드 기본)
//   node build/verify-all.mjs --full         # 전 하네스 (20~40분, 네트워크 사용)
//   node build/verify-all.mjs --only smoke,perf
//   node build/verify-all.mjs --list         # 등록된 단계 목록만 출력
//   옵션: --skip-build (게이트 0 생략 — 이미 빌드된 상태에서 재실행)
//         --out <dir>  (결과·로그 루트, 기본 verify-out/all)
//         --keep-going (게이트 0 실패해도 남은 단계 계속)
//
// 종료 코드: 0 = 전부 통과 / 1 = 하나 이상 실패·타임아웃 / 2 = 러너 치명적 오류(전제 불충족)
//
// 설계 원칙:
//   - 하네스를 고치지 않고 **감싸기만** 한다. 각 하네스의 종료 코드(0/1/2)가 1차 판정,
//     결과 JSON 이 있으면 PASS/FAIL 개수를 2차로 읽어 표에 채운다.
//   - 하네스는 전부 앱을 spawn 하므로 **순차 실행**한다(포트·프로필·창 포커스 충돌 방지).
//   - 단계마다 **회수 시계**(timeout)를 둔다. 정체된 하네스가 러너 전체를 잡아먹지 않게.

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')

// ── 단계 등록부 ─────────────────────────────────────────────────────────
//
// kind: 'cmd'     — 셸 명령 (게이트 0)
//       'harness' — build/*.mjs 하네스 (앱 spawn, exe 필요)
// outArg: true 면 러너가 --out <루트>/<id> 를 넘긴다. false 면 하네스 고정 경로를 읽는다.
// result: 결과 JSON 경로를 돌려주는 함수 (없으면 종료 코드만으로 판정)

function steps(outRoot) {
  const at = (id, file) => path.join(outRoot, id, file)
  const fixed = (file) => path.join(REPO_ROOT, 'verify-out', file)
  return [
    {
      id: 'typecheck', kind: 'cmd', modes: ['quick', 'full'], gate0: true,
      cmd: 'npm', args: ['run', 'typecheck'], timeoutMs: 5 * 60000,
      desc: 'tsc --noEmit x3 (main/preload/renderer)',
    },
    {
      id: 'build', kind: 'cmd', modes: ['quick', 'full'], gate0: true,
      cmd: 'npm', args: ['run', 'build'], timeoutMs: 10 * 60000,
      desc: 'tokens/icon/vite/tsc/esbuild',
    },
    {
      id: 'package', kind: 'cmd', modes: ['quick', 'full'], gate0: true,
      cmd: 'npx', args: ['electron-builder', '--win', '--dir'], timeoutMs: 15 * 60000,
      desc: 'win-unpacked (하네스가 구동할 exe)', preflight: preflightPackage,
    },
    {
      id: 'smoke', kind: 'harness', modes: ['quick', 'full'],
      script: 'smoke-cdp.mjs', outArg: true, result: (o) => path.join(o, 'smoke', 'smoke-results.json'),
      timeoutMs: 10 * 60000, desc: '게이트 1 스모크 16종',
    },
    {
      id: 'agent-safety', kind: 'harness', modes: ['full'],
      script: 'verify-agent-safety-cdp.mjs', outArg: false, result: () => fixed('agent-safety-results.json'),
      timeoutMs: 12 * 60000, desc: 'AI 에이전트 안전·조작 A1~A14',
    },
    {
      id: 'fingerprint', kind: 'harness', modes: ['full'],
      script: 'probe-fingerprint-cdp.mjs', outArg: false, result: () => fixed('fingerprint-report.json'),
      timeoutMs: 8 * 60000, desc: '자동화 지문 노출 진단',
    },
    {
      id: 'session-restore', kind: 'harness', modes: ['full'],
      script: 'session-restore-cdp.mjs', outArg: true, result: (o) => path.join(o, 'session-restore', 'restore-results.json'),
      timeoutMs: 12 * 60000, desc: '강제 kill 후 탭·그룹·분할·스크롤 복원',
    },
    {
      id: 'dl-matrix', kind: 'harness', modes: ['full'],
      script: 'dl-matrix.mjs', outArg: true, result: (o) => path.join(o, 'dl-matrix', 'dl-matrix-results.json'),
      timeoutMs: 20 * 60000, desc: '게이트 5 다운로드 11시나리오',
    },
    {
      id: 'ext-matrix', kind: 'harness', modes: ['full'], network: true,
      script: 'ext-matrix.mjs', outArg: true, result: (o) => path.join(o, 'ext-matrix', 'ext-matrix-results.json'),
      timeoutMs: 25 * 60000, desc: '게이트 5 확장 10종 (웹스토어 CRX 다운로드 — 네트워크)',
    },
    {
      id: 'stress', kind: 'harness', modes: ['full'],
      script: 'stress-cdp.mjs', outArg: true, result: (o) => path.join(o, 'stress', 'stress-results.json'),
      timeoutMs: 30 * 60000, desc: '게이트 3 50탭 스트레스',
    },
    {
      id: 'perf', kind: 'harness', modes: ['full'],
      script: 'perf-measure.mjs', outArg: true, result: (o) => path.join(o, 'perf', 'perf-results.json'),
      timeoutMs: 30 * 60000, desc: '게이트 4 성능 예산 실측',
    },
  ]
}

// ── 인자 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    mode: 'quick', only: null, skipBuild: false, list: false, keepGoing: false,
    outRoot: path.join(REPO_ROOT, 'verify-out', 'all'),
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--quick') out.mode = 'quick'
    else if (a === '--full') out.mode = 'full'
    else if (a === '--only') out.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--skip-build') out.skipBuild = true
    else if (a === '--keep-going') out.keepGoing = true
    else if (a === '--list') out.list = true
    else if (a === '--out') out.outRoot = path.resolve(argv[++i] ?? '')
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else console.warn(`[verify-all] 알 수 없는 인자 무시: ${a}`)
  }
  return out
}

function printHelp() {
  console.log([
    'verify-all — 검증 하네스 통합 러너',
    '',
    '  node build/verify-all.mjs --quick                게이트 0 + 스모크 (기본)',
    '  node build/verify-all.mjs --full                 전 하네스 (20~40분, 네트워크 사용)',
    '  node build/verify-all.mjs --only smoke,perf      지정한 단계만',
    '  node build/verify-all.mjs --list                 단계 목록',
    '',
    '옵션: --skip-build  게이트 0(typecheck/build/package) 생략',
    '      --keep-going  게이트 0 실패해도 남은 단계 계속',
    '      --out <dir>   결과 루트 (기본 verify-out/all)',
    '',
    '종료 코드: 0 통과 / 1 실패·타임아웃 / 2 러너 치명적 오류',
  ].join('\n'))
}

// ── 실행 ────────────────────────────────────────────────────────────────

/**
 * 패키징 전제 점검 — 실행 중인 ezBrowser 가 dist/win-unpacked 의 exe 를 잠그면
 * electron-builder 는 ERR_ELECTRON_BUILDER_CANNOT_EXECUTE 라는 원인 불명 오류만 뱉는다
 * (CLAUDE.md 에 기록된 알려진 함정). 여기서 미리 잡아 무엇을 종료해야 하는지 알려준다.
 *
 * 죽이지는 않는다 — 사용자가 지금 쓰고 있는 창일 수 있다. 판단은 사람이 한다.
 */
function preflightPackage() {
  if (process.platform !== 'win32') return { ok: true }
  const distPrefix = path.join(REPO_ROOT, 'dist').replace(/'/g, "''")
  const ps = [
    `Get-CimInstance Win32_Process -Filter "Name='ezBrowser.exe'"`,
    "| Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('" + distPrefix + "') }",
    "| Where-Object { $_.CommandLine -notlike '*--type=*' }",
    '| Select-Object -ExpandProperty ProcessId',
  ].join(' ')
  let out = ''
  try {
    const res = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
    out = String(res.stdout || '')
  } catch {
    return { ok: true } // 점검 자체가 실패하면 막지 않는다(점검은 편의지 관문이 아니다)
  }
  const pids = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!pids.length) return { ok: true }
  return {
    ok: false,
    message: [
      '  실행 중인 ezBrowser 가 exe 를 잠그고 있습니다 (PID ' + pids.join(', ') + ').',
      '  패키징하려면 먼저 그 인스턴스를 닫으세요 — 사용자가 쓰는 창일 수 있어 러너는 종료하지 않습니다.',
      '  강제 종료: taskkill /PID ' + pids[0] + ' /T /F',
      '  이미 빌드된 exe 로 하네스만 돌리려면: --skip-build',
    ].join('\n'),
  }
}

/**
 * 지정 시각 이후에 시작된 dist/ 소속 ezBrowser 프로세스를 정리하고 죽인 PID 목록을 반환.
 * 시각 조건이 안전장치다 — 사용자가 그 전부터 열어둔 창은 절대 건드리지 않는다.
 */
function killAppsStartedAfter(sinceMs) {
  if (process.platform !== 'win32') return []
  const distPrefix = path.join(REPO_ROOT, 'dist').replace(/'/g, "''")
  const ps = [
    `Get-CimInstance Win32_Process -Filter "Name='ezBrowser.exe'"`,
    "| Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('" + distPrefix + "') }",
    // CreationDate 를 ISO 문자열로 강제 — ConvertTo-Json 기본 출력(/Date(…)/)은 JS 가 못 읽는다.
    "| Select-Object ProcessId,@{n='Created';e={ $_.CreationDate.ToString('o') }} | ConvertTo-Json -Compress",
  ].join(' ')
  let list = []
  try {
    const res = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
    const raw = String(res.stdout || '').trim()
    if (!raw) return []
    const parsed = JSON.parse(raw)
    list = Array.isArray(parsed) ? parsed : [parsed]
  } catch { return [] }

  const killed = []
  const survivors = []
  for (const p0 of list) {
    const pid = p0?.ProcessId
    const created = new Date(p0?.Created ?? 0).getTime()
    if (!pid || !Number.isFinite(created)) continue
    if (created < sinceMs - 5000) continue // 단계 시작 전부터 있던 것 = 우리 것이 아님
    // taskkill 은 성공을 보장하지 않는다 — 커널 대기 중인 프로세스는 명령을 받고도 한동안
    // 살아 남아 **디버그 포트를 계속 쥔다**. 그러면 다음 하네스가 죽은 좀비의 CDP 타깃에
    // 붙어 무한 대기한다(2026-09-06 실측: "정리했다"고 보고한 PID 가 그대로 포트를 물고 있었다).
    // 그러므로 죽었는지 **확인**하고, 안 죽으면 재시도하고, 끝내 못 죽이면 그렇게 보고한다.
    let gone = false
    for (let attempt = 0; attempt < 3 && !gone; attempt++) {
      try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
      const check = spawnSync('powershell', ['-NoProfile', '-Command',
        `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`,
      ], { encoding: 'utf8' })
      gone = String(check.stdout || '').includes('gone')
      if (!gone) spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 700'], { stdio: 'ignore' })
    }
    if (gone) killed.push(pid)
    else survivors.push(pid)
  }
  if (survivors.length) {
    console.log(`  ⚠ 종료되지 않은 앱 PID ${survivors.join(', ')} — 디버그 포트를 쥐고 있으면 다음 단계가 실패할 수 있습니다.`)
  }
  return killed
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** 한 단계를 실행하고 {code, timedOut, ms, tail} 반환. 로그는 파일로, 꼬리는 메모리로. */
function runStep(step, { outRoot, logPath }) {
  return new Promise((resolve) => {
    // cmd 단계는 shell 에 **문자열 한 줄**로 넘긴다 — shell:true 에 args 배열을 함께 주면
    // Node 가 DEP0190(인자 미이스케이프) 경고를 낸다. 하네스 단계는 shell 없이 직접 spawn.
    const isCmd = step.kind === 'cmd'
    const cmd = isCmd
      ? [step.cmd, ...step.args].join(' ')
      : process.execPath
    const args = isCmd
      ? []
      : [path.join(__dirname, step.script), ...(step.outArg ? ['--out', path.join(outRoot, step.id)] : [])]

    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    const logStream = fs.createWriteStream(logPath)
    const tail = []
    const pushTail = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > 40) tail.shift()
      }
    }

    const started = Date.now()
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      shell: step.kind === 'cmd', // npm/npx 는 Windows 에서 셸 경유 필요
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (b) => { logStream.write(b); pushTail(b) })
    child.stderr?.on('data', (b) => { logStream.write(b); pushTail(b) })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // 회수 시계: 정체된 하네스는 트리째 종료(자기가 띄운 앱도 함께 정리되도록)
      try { child.kill() } catch { /* ignore */ }
      if (process.platform === 'win32' && child.pid) {
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
      }
    }, step.timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      logStream.end()
      resolve({ code: 2, timedOut: false, ms: Date.now() - started, tail: [...tail, `spawn 실패: ${err.message}`] })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      logStream.end()
      resolve({ code: timedOut ? 124 : (code ?? 1), timedOut, ms: Date.now() - started, tail })
    })
  })
}

/** 결과 JSON 에서 PASS/FAIL/SKIP 개수를 최대한 일반적으로 읽어낸다. */
function summarizeResult(file, notBefore = 0) {
  if (!file || !fs.existsSync(file)) return null
  // 낡은 산출물에 속지 않는다 — 이번 단계가 시작된 뒤에 쓰인 파일만 읽는다.
  // (하네스가 부팅 단계에서 죽으면 결과 JSON 을 새로 쓰지 않으므로, 이전 실행의 성공 기록을
  //  그대로 읽어 "PASS 14" 같은 거짓 통과를 보고하게 된다 — 2026-09-06 실측.)
  if (notBefore) {
    try {
      if (fs.statSync(file).mtimeMs < notBefore - 2000) return null
    } catch { return null }
  }
  let json
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }

  const countArr = (arr) => {
    const c = { pass: 0, fail: 0, skip: 0, other: 0 }
    for (const r of arr) {
      const st = String(r?.status ?? r?.판정 ?? '').toUpperCase()
      if (st.includes('FAIL')) c.fail += 1
      else if (st.includes('PASS') || st === 'OK') c.pass += 1
      else if (st.includes('SKIP')) c.skip += 1
      else c.other += 1
    }
    return (c.pass + c.fail + c.skip) > 0 ? c : null
  }

  if (Array.isArray(json)) return countArr(json)
  if (json && typeof json === 'object') {
    for (const key of ['findings', 'results', 'rows', 'scenarios', 'budget', 'extensions']) {
      if (Array.isArray(json[key])) {
        const c = countArr(json[key])
        if (c) return c
      }
    }
    // fingerprint 처럼 판정 배열이 없는 진단 보고서: 문제 목록만 세어 준다.
    if (Array.isArray(json.problems)) {
      return { pass: json.problems.length === 0 ? 1 : 0, fail: json.problems.length, skip: 0, other: 0 }
    }
  }
  return null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const all = steps(args.outRoot)

  if (args.list) {
    console.table(all.map((s) => ({
      id: s.id, 모드: s.modes.join('+'), 종류: s.kind,
      제한시간: fmtDuration(s.timeoutMs), 설명: s.desc,
    })))
    return 0
  }

  if (args.only) {
    const unknown = args.only.filter((id) => !all.some((s) => s.id === id))
    if (unknown.length) { console.error(`[verify-all] 알 수 없는 단계: ${unknown.join(', ')}`); return 2 }
  }

  let selected = args.only
    ? all.filter((s) => args.only.includes(s.id))
    : all.filter((s) => s.modes.includes(args.mode))
  if (args.skipBuild) selected = selected.filter((s) => !s.gate0)
  if (!selected.length) { console.error('[verify-all] 실행할 단계가 없습니다.'); return 2 }

  // 전제: 하네스 단계가 있는데 exe 가 없고 package 단계도 안 도는 경우 → 치명적으로 중단.
  const needsExe = selected.some((s) => s.kind === 'harness')
  const willPackage = selected.some((s) => s.id === 'package')
  if (needsExe && !willPackage && !fs.existsSync(EXE)) {
    console.error(`[verify-all] 하네스가 구동할 exe 가 없습니다: ${EXE}`)
    console.error('  → --skip-build 를 빼고 실행하거나, 먼저 npx electron-builder --win --dir 를 돌리세요.')
    return 2
  }

  fs.mkdirSync(args.outRoot, { recursive: true })
  const startedAt = Date.now()
  const modeLabel = args.only ? `only(${args.only.join(',')})` : args.mode
  console.log(`[verify-all] 모드=${modeLabel} · 단계 ${selected.length}개 · 결과 ${args.outRoot}`)
  if (selected.some((s) => s.network)) {
    console.log('[verify-all] 네트워크를 쓰는 단계 포함 (ext-matrix: 웹스토어 CRX 다운로드).')
  }

  const rows = []
  for (const [i, step] of selected.entries()) {
    const logPath = path.join(args.outRoot, `${step.id}.log`)
    process.stdout.write(`\n[${i + 1}/${selected.length}] ${step.id} — ${step.desc} … `)
    // 전제 점검이 있는 단계는 먼저 확인 — 실패를 원인 불명 오류로 만들지 않는다.
    const pre = step.preflight ? step.preflight() : { ok: true }
    if (!pre.ok) {
      console.log('BLOCKED')
      console.log(pre.message)
      rows.push({ id: step.id, status: 'BLOCKED', ms: 0, code: -1, detail: '전제 불충족', log: null })
      if (!args.keepGoing) {
        console.log('\n[verify-all] 전제 불충족(' + step.id + ') — 중단합니다.')
        break
      }
      continue
    }

    // 앞 단계가 남긴 앱을 먼저 치운다. 남은 인스턴스는 디버그 포트를 선점해, 다음 하네스가
    // **죽은 좀비의 CDP 타깃에 붙어** 무한 대기하게 만든다(2026-09-06 실측: 이것이 INFRA
    // 간헐 실패의 진짜 원인이었다). 이 실행이 시작된 뒤에 뜬 것만 죽인다.
    if (step.kind === 'harness') {
      const pre2 = killAppsStartedAfter(startedAt)
      if (pre2.length) console.log(`(앞 단계 잔재 앱 ${pre2.length}개 정리) `)
    }

    const stepStartedAt = Date.now()
    const r = await runStep(step, { outRoot: args.outRoot, logPath })
    const counts = step.result ? summarizeResult(step.result(args.outRoot), stepStartedAt) : null

    // 잔재 정리: 하네스가 타임아웃·비정상 종료로 죽으면 자기가 띄운 앱을 남긴다.
    // 남은 앱은 다음 하네스의 포트·프로필·exe 잠금을 망가뜨려 **연쇄 실패**를 만든다
    // (2026-09-06 실측: 스모크 타임아웃 후 앱 9개가 남아 이후 4개 하네스가 전부 실패).
    // 이 단계가 시작된 뒤에 뜬 것만 죽인다 — 사용자가 미리 열어둔 창은 건드리지 않는다.
    if (step.kind === 'harness') {
      const cleaned = killAppsStartedAfter(stepStartedAt)
      if (cleaned.length) console.log(`  ↳ 잔재 앱 ${cleaned.length}개 정리 (PID ${cleaned.join(', ')})`)
    }

    // 판정: 종료 코드가 1차. 결과 JSON 의 FAIL 개수가 있으면 그것도 실패로 본다.
    // 종료 코드 해석: 하네스는 0=통과/1=실패/2=치명 규약을 따르지만, cmd 단계(tsc 등)는
    // 자기 나름의 코드를 쓴다(tsc 는 타입 오류에 2). cmd 는 non-zero 를 전부 FAIL 로 본다.
    let status = 'PASS'
    if (r.timedOut) status = 'TIMEOUT'
    else if (step.kind === 'harness' && r.code === 2) status = 'ERROR'
    else if (r.code !== 0) status = 'FAIL'
    else if (counts && counts.fail > 0) status = 'FAIL'

    const detail = counts
      ? `PASS ${counts.pass}${counts.fail ? ` · FAIL ${counts.fail}` : ''}${counts.skip ? ` · SKIP ${counts.skip}` : ''}`
      : (status === 'PASS' ? '종료코드 0' : `종료코드 ${r.code}`)
    console.log(`${status} (${fmtDuration(r.ms)}) ${detail}`)

    if (status !== 'PASS') {
      console.log(`  ↳ 로그: ${logPath}`)
      for (const line of r.tail.slice(-12)) console.log(`    | ${line}`)
    }

    rows.push({ id: step.id, status, ms: r.ms, code: r.code, detail, log: logPath })

    if (status !== 'PASS' && step.gate0 && !args.keepGoing) {
      console.log(`\n[verify-all] 게이트 0 단계(${step.id}) 실패 — 이후 단계는 의미가 없어 중단합니다.`)
      break
    }
  }

  const notRun = selected.length - rows.length
  const summary = {
    startedAt: new Date(startedAt).toISOString(),
    ms: Date.now() - startedAt,
    mode: modeLabel,
    notRun,
    rows,
  }
  fs.writeFileSync(path.join(args.outRoot, 'verify-all-results.json'), JSON.stringify(summary, null, 2))

  console.log('\n===== verify-all 결과 =====')
  console.table(rows.map((r) => ({ 단계: r.id, 상태: r.status, 소요: fmtDuration(r.ms), 상세: r.detail })))
  const failed = rows.filter((r) => r.status !== 'PASS')
  console.log(`통과 ${rows.length - failed.length}/${rows.length}${notRun ? ` (중단으로 미실행 ${notRun})` : ''} · 총 ${fmtDuration(summary.ms)}`)
  console.log(`결과: ${path.join(args.outRoot, 'verify-all-results.json')}`)

  // ── 보고서용 요약 블록 ──────────────────────────────────────────────────
  // 라운드 종결 절차(CLAUDE.md 품질 게이트)는 "돌리고 결과를 보고서에 붙인다"이다.
  // 사람이 표를 손으로 옮겨 적게 하면 그 단계가 조용히 생략된다 — 붙여넣을 수 있는 형태로 준다.
  const icon = (st) => (st === 'PASS' ? '✅' : st === 'TIMEOUT' ? '⏱️' : st === 'BLOCKED' ? '⛔' : '❌')
  const md = [
    '',
    '── 보고서에 붙일 요약 (마크다운) ' + '─'.repeat(28),
    '',
    `**\`npm run verify${modeLabel === 'full' ? ':full' : ''}\` — ${rows.length - failed.length}/${rows.length} PASS · ${fmtDuration(summary.ms)}** (${new Date(startedAt).toISOString().slice(0, 16).replace('T', ' ')})`,
    '',
    '| 단계 | 상태 | 소요 | 상세 |',
    '|------|------|------|------|',
    ...rows.map((r) => `| ${r.id} | ${icon(r.status)} ${r.status} | ${fmtDuration(r.ms)} | ${r.detail} |`),
    ...(notRun ? ['', `> 중단으로 미실행: ${notRun}단계`] : []),
    ...(failed.length ? ['', `> 실패: ${failed.map((f) => `\`${f.id}\`(${f.status})`).join(', ')} — 로그: \`${args.outRoot}\``] : []),
    '─'.repeat(60),
    '',
  ].join('\n')
  console.log(md)
  try {
    fs.writeFileSync(path.join(args.outRoot, 'verify-all-summary.md'), md)
    console.log(`요약 파일: ${path.join(args.outRoot, 'verify-all-summary.md')}`)
  } catch { /* best-effort */ }
  if (failed.length) console.log(`실패 단계: ${failed.map((f) => `${f.id}(${f.status})`).join(', ')}`)

  return (failed.length || notRun) ? 1 : 0
}

main().then((code) => process.exit(code ?? 0)).catch((err) => {
  console.error('[verify-all] 치명적 오류:', err)
  process.exit(2)
})
