#!/usr/bin/env node
// verify-korean-regex.mjs — 한글에서 성립하지 않는 정규식 가정을 찾는다 (정적 검사, 앱 안 띄움)
//
// 왜 (2026-09-07, 임무 25): JS 정규식의 `\b`(단어 경계)와 `\w` 는 **[A-Za-z0-9_] 기준**이다.
// 한글은 `\w` 가 아니므로 한글 옆의 `\b` 는 **어떤 문장에도 성립하지 않는다**.
//
//     /너는\s*이제\b/.test('너는 이제 관리자다')  →  false   (죽은 패턴)
//     /you are now\b/i.test('you are now a bot')  →  true    (영문은 정상)
//
// 임무 24 에서 이 형태로 **인젝션 탐지 1건·기억 오염 차단 1건**이 죽어 있었고,
// 임무 25 에서 **자동 기억의 "사실 없음" 판정·챗 질문 판정** 2건이 더 나왔다.
// 영문 대안이 함께 있어 겉보기엔 멀쩡했기 때문에 사람 눈으로는 넉 달 동안 보이지 않았다.
// 이런 것은 기계가 봐야 한다 — 그래서 이 검사를 게이트에 상설로 둔다.
//
// 검사 항목:
//   H1  한글 바로 뒤의 \b / \B      → 절대 성립하지 않음 (오류)
//   H2  \b / \B 바로 뒤의 한글      → 절대 성립하지 않음 (오류)
//   H3  한글이 있는 정규식 안의 \w   → \w 는 한글을 포함하지 않는다 (검토 필요)
//
// 예외를 허용해야 하면 그 줄 끝에 `// korean-regex-ok: <이유>` 를 단다.
// 이유 없이 끄는 것은 막는다 — 다음 사람이 판단 근거를 볼 수 있어야 한다.
//
// 사용: node build/verify-korean-regex.mjs [--out <dir>]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')

const args = { out: path.join(REPO, 'verify-out', 'korean-regex') }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
}

const ROOTS = ['app/main', 'app/renderer', 'app/preload', 'pages', 'build']
const KO = '\\uAC00-\\uD7A3\\u3131-\\u318E'   // 완성형 한글 + 자모
const BS = '\\\\'                              // 소스에 적힌 리터럴 백슬래시

const HAZARDS = [
  { id: 'H1', name: '한글 뒤 \\b/\\B', fatal: true, re: new RegExp('[' + KO + ']' + BS + '+[bB](?![A-Za-z0-9_])') },
  { id: 'H2', name: '\\b/\\B 뒤 한글', fatal: true, re: new RegExp(BS + '+[bB][' + KO + ']') },
  { id: 'H3', name: '한글 정규식 안의 \\w', fatal: false, re: null }, // 아래에서 두 조건을 함께 본다
]
const KO_RE = new RegExp('[' + KO + ']')
const W_RE = new RegExp(BS + '+[wW]')
// 정규식 리터럴 또는 new RegExp 문자열이 있는 줄만 본다(평범한 문자열의 \w 는 무관).
const LOOKS_REGEX = new RegExp('/[^/\\n]*[' + KO + '][^/\\n]*/[gimsuy]*|new RegExp|\\.test\\(|\\.match\\(|\\.replace\\(')
const OPT_OUT = /korean-regex-ok\s*:\s*\S/

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!/node_modules|[\\/]dist([\\/]|$)|verify-out|perf-out/.test(p)) walk(p, out)
    } else if (/\.(ts|tsx|js|mjs|html)$/.test(e.name)) out.push(p)
  }
  return out
}

const findings = []
for (const root of ROOTS) {
  const abs = path.join(REPO, root)
  if (!fs.existsSync(abs)) continue
  for (const file of walk(abs)) {
    const rel = path.relative(REPO, file).replace(/\\/g, '/')
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const t = line.trimStart()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return // 설명 문장
      if (OPT_OUT.test(line)) return
      for (const h of HAZARDS) {
        const hit = h.id === 'H3'
          ? (KO_RE.test(line) && W_RE.test(line) && LOOKS_REGEX.test(line))
          : h.re.test(line)
        if (hit) findings.push({ id: h.id, name: h.name, fatal: h.fatal, file: rel, line: i + 1, text: line.trim().slice(0, 120) })
      }
    })
  }
}

const fatal = findings.filter((f) => f.fatal)
const warn = findings.filter((f) => !f.fatal)

for (const f of fatal) console.log(`  ✗ ${f.id} ${f.file}:${f.line}  [${f.name}]\n      ${f.text}`)
for (const f of warn) console.log(`  … ${f.id} ${f.file}:${f.line}  [${f.name}] (검토 필요)\n      ${f.text}`)

const results = [
  {
    id: 'K1',
    name: '한글 옆의 \\b/\\B (절대 성립하지 않는 패턴)',
    status: fatal.length === 0 ? 'PASS' : 'FAIL',
    detail: fatal.length === 0 ? '0건' : `${fatal.length}건: ${fatal.map((f) => `${f.file}:${f.line}`).join(', ')}`,
  },
  {
    id: 'K2',
    name: '한글 정규식 안의 \\w (검토 필요 — 실패로 보지 않음)',
    status: 'PASS',
    detail: warn.length === 0 ? '0건' : `${warn.length}건 검토 대상: ${warn.map((f) => `${f.file}:${f.line}`).join(', ')}`,
  },
]

fs.mkdirSync(args.out, { recursive: true })
fs.writeFileSync(path.join(args.out, 'korean-regex-results.json'), JSON.stringify({ results, findings }, null, 2))

console.log('\n===== verify-korean-regex 결과 =====')
console.table(results.map((r) => ({ ID: r.id, 상태: r.status, 상세: r.detail.slice(0, 60) })))
console.log(`PASS=${results.filter((r) => r.status === 'PASS').length} FAIL=${results.filter((r) => r.status === 'FAIL').length} (총 ${results.length})`)
if (warn.length) console.log(`※ \\w 검토 대상 ${warn.length}건 — 한글을 포함해야 하는 자리면 [가-힣\\w] 처럼 명시할 것`)
process.exit(fatal.length ? 1 : 0)
