#!/usr/bin/env node
/**
 * 게시 시각 판정이 **기계의 시간대와 무관한가** — 순수 함수 검사(앱을 띄우지 않는다, 즉시 끝난다).
 *
 * 왜 이 검사가 필요한가 (2026-09-19):
 *   `<time datetime="2026-09-19T10:00">` 처럼 **오프셋이 없는** 값을 `Date.parse` 로 읽으면 명세상
 *   **실행 기계의 지역 시간**으로 해석된다. 게시 확인은 "이번 시도보다 뒤에 올라간 글인가" 를 시간으로
 *   가르는데, 그 축이 기계마다 달라지면 **같은 화면·같은 글이 PC 에 따라 "새 글"/"지난 글"** 이 된다.
 *   그 결과는 둘 다 나쁘다 — 남의 글·지난 글을 이번 게시의 근거로 세거나, 반대로 올라간 글을 못 봤다며
 *   사용자가 "게시 안 됨" 을 눌러 **같은 글을 또 올린다**.
 *
 * 검사 방법: 같은 단언을 **여러 시간대(UTC·+09·-07·+14)에서 각각 자식 프로세스로 실행**하고,
 *   판정(ok/uncertain)이 **전부 동일한지** 대조한다. 한 시간대에서만 돌리면 이 결함은 보이지 않는다.
 *
 * 네트워크·앱·모델 사용 0. `app/dist/main` 의 **빌드 산출물**을 직접 불러 검사한다.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const GATE = path.join(REPO, 'app', 'dist', 'main', 'features', 'ai', 'agent-gate.js')

const TZS = ['UTC', 'Asia/Seoul', 'America/Los_Angeles', 'Pacific/Kiritimati']

/** 이번 시도 시각 — 고정값을 써서 실행 시점에 흔들리지 않게 한다. */
const ATTEMPT = Date.UTC(2026, 8, 19, 0, 0, 0)   // 2026-09-19T00:00:00Z

/** 판정 함수에 넘길 최소 재료(계정·문구·호스트 축은 통과하게 두고 **시각 축만** 본다). */
function sighting(extra) {
  return {
    url: 'https://www.instagram.com/p/abc/',
    host: 'www.instagram.com',
    needle: '별이 쏟아지는 밤 호수 위 나룻배',
    at: ATTEMPT + 60_000,
    author: 'myhandle',
    authorScope: 'post',
    authorSource: 'structural',
    ...extra,
  }
}
function expectation() {
  return {
    host: 'www.instagram.com',
    needles: ['별이 쏟아지는 밤 호수 위 나룻배'],
    notBefore: ATTEMPT,
    account: 'myhandle',
    attemptStartedAt: ATTEMPT,
  }
}

/** 자식에서 실제로 재는 것. 시간대에 따라 달라지면 안 되는 값만 돌려준다(문구의 날짜 표기는 제외). */
function measure() {
  const g = require(GATE)
  const parse = g.parseUnambiguousPostTime
  const judge = g.sightingSupportsPublication
  const out = { tz: process.env.TZ ?? '(none)', parse: {}, judge: {}, drift: {}, tzOffsetMin: new Date().getTimezoneOffset() }

  // ── A. 파서: 무엇을 받고 무엇을 안 받는가
  const PARSE_CASES = {
    'offset-colon': '2026-09-19T10:00:00+09:00',
    'offset-nocolon': '2026-09-19T10:00:00+0900',
    'offset-Z': '2026-09-19T01:00:00Z',
    'offset-z-lower': '2026-09-19T01:00:00z',
    'offset-ms': '2026-09-19T01:00:00.123Z',
    'offset-nosec': '2026-09-19T01:00+00:00',
    'offset-space-sep': '2026-09-19 10:00:00+09:00',
    'offset-negative': '2026-09-18T18:00:00-07:00',
    // ↓ 여기부터는 전부 0(모름) 이어야 한다
    'tzless-T': '2026-09-19T10:00',
    'tzless-T-sec': '2026-09-19T10:00:00',
    'tzless-space': '2026-09-19 10:00:00',
    'date-only': '2026-09-19',
    'locale-us': '09/19/2026',
    'locale-eu': '19.09.2026',
    'rfc1123': 'Sat, 19 Sep 2026 10:00:00 GMT',
    'bad-calendar': '2026-02-31T10:00:00Z',
    'bad-offset': '2026-09-19T10:00:00+25:00',
    'bad-hour': '2026-09-19T25:00:00Z',
    'empty': '',
    'garbage': 'yesterday',
    'nonstring': 12345,
  }
  for (const [k, v] of Object.entries(PARSE_CASES)) out.parse[k] = parse(v)

  // ── B. 판정: 오래됨/미래/모름/정상 — 전부 같은 결론이어야 한다
  const now = Date.now()
  const JUDGE_CASES = {
    // 유효 오프셋 + 시도 직후 → 통과
    'fresh-offset': sighting({ postedAt: parse('2026-09-19T00:05:00Z'), postedAtText: '방금' }),
    // 유효 오프셋 + 시도보다 한참 전 → **확정 거부**(모름 아님)
    'old-offset': sighting({ postedAt: parse('2026-09-12T10:00:00+09:00'), postedAtText: '2026-09-12' }),
    // 미래 → 모름(예약 글일 수 있다)
    'future-offset': sighting({ postedAt: now + 3 * 86400_000, postedAtText: '예약됨' }),
    // 시간대 없는 표기만 있었다 → 모름(+ 사유가 시간대 때문임을 말해야 한다)
    'tzless-unclear': sighting({ postedAtUnclear: '글의 시각 표기에 시간대가 없어 어느 시점인지 확정할 수 없습니다' }),
    // 시각 자체가 없었다 → 모름
    'no-time': sighting({}),
  }
  for (const [k, s] of Object.entries(JUDGE_CASES)) {
    const v = judge(s, expectation())
    out.judge[k] = {
      ok: !!v.ok,
      uncertain: !!v.uncertain,
      // 날짜를 **문구로 렌더한 부분**은 시간대에 따라 달라지는 것이 정상이므로 비교에서 뺀다.
      // 대신 "어떤 종류의 사유인가" 만 표식으로 남긴다.
      kind: /시간대가 없어/.test(v.reason) ? 'tzless'
        : /미래/.test(v.reason) ? 'future'
          : /오래된 글/.test(v.reason) ? 'old'
            : /읽지 못했습니다/.test(v.reason) ? 'no-time'
              : v.ok ? 'ok' : 'other',
    }
  }

  // ── C. 드리프트: 페이지에 **실제로 주입되는 소스**가 내보낸 함수와 같은 답을 내는가
  const embedded = new Function(`${g.POST_TIME_FN_SRC} return __bbPostTime;`)()
  out.drift.mismatch = Object.values(PARSE_CASES).filter((v) => embedded(v) !== parse(v)).length
  out.drift.sampled = Object.keys(PARSE_CASES).length

  // ── D. 참고: 옛 방식(Date.parse)이 이 시간대에서 무엇을 냈는가. 결함의 존재를 눈으로 보이는 값.
  out.legacyDateParse = Date.parse('2026-09-19T10:00')

  return out
}

// ===== 자식 모드 =====
if (process.env.BB_POSTTIME_CHILD === '1') {
  try { process.stdout.write(JSON.stringify(measure())) } catch (e) { process.stdout.write(JSON.stringify({ error: String(e) })) }
  process.exit(0)
}

// ===== 부모 모드 =====
if (!fs.existsSync(GATE)) {
  console.error(`[post-time] 빌드 산출물이 없습니다: ${GATE}\n  먼저 npm run build 를 돌리세요.`)
  process.exit(2)
}

const results = []
for (const tz of TZS) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, TZ: tz, BB_POSTTIME_CHILD: '1' },
    encoding: 'utf8',
  })
  if (r.status !== 0 || !r.stdout) {
    console.error(`[post-time] ${tz} 자식 실행 실패: status=${r.status} ${r.stderr?.slice(0, 400) ?? ''}`)
    process.exit(2)
  }
  let parsed
  try { parsed = JSON.parse(r.stdout) } catch { console.error(`[post-time] ${tz} 출력 파싱 실패: ${r.stdout.slice(0, 300)}`); process.exit(2) }
  if (parsed.error) { console.error(`[post-time] ${tz} 측정 오류: ${parsed.error}`); process.exit(2) }
  results.push({ tz, ...parsed })
}

const base = results[0]
const checks = []
const add = (id, ok, detail) => checks.push({ id, ok, detail })

// 자식들이 정말 서로 다른 시간대에서 돌았는가 — 이게 아니면 이 검사 전체가 **빈 검사**다.
const offsets = new Set(results.map((r) => r.tzOffsetMin))
add('T0-실제로-다른-시간대에서-돌았다', offsets.size >= 3,
  `관측된 지역 오프셋(분): ${results.map((r) => `${r.tz}=${r.tzOffsetMin}`).join(', ')}`)

// 옛 방식이 실제로 기계마다 달랐다는 근거(결함의 존재 증명 — 수정의 가치를 수치로 남긴다)
const legacySpread = new Set(results.map((r) => r.legacyDateParse))
add('T1-옛-방식은-시간대마다-달랐다', legacySpread.size >= 3,
  `Date.parse('2026-09-19T10:00') = ${results.map((r) => `${r.tz}:${r.legacyDateParse}`).join(', ')}`)

// ── 양성: 오프셋이 명시된 값은 어디서나 같은 절대 시각
const WANT = Date.UTC(2026, 8, 19, 1, 0, 0)   // 2026-09-19T01:00:00Z == 10:00+09:00 == 18:00-07:00(전날)
for (const k of ['offset-colon', 'offset-nocolon', 'offset-Z', 'offset-z-lower', 'offset-nosec', 'offset-space-sep', 'offset-negative']) {
  const vals = results.map((r) => r.parse[k])
  add(`T2-양성-${k}`, vals.every((v) => v === WANT), `${k}: ${vals.join(' / ')} (기대 ${WANT})`)
}
add('T2-양성-offset-ms', results.every((r) => r.parse['offset-ms'] === WANT + 123),
  `offset-ms: ${results.map((r) => r.parse['offset-ms']).join(' / ')}`)

// ── 부정: 확정할 수 없는 표기는 어디서나 0(모름)
for (const k of ['tzless-T', 'tzless-T-sec', 'tzless-space', 'date-only', 'locale-us', 'locale-eu',
  'rfc1123', 'bad-calendar', 'bad-offset', 'bad-hour', 'empty', 'garbage', 'nonstring']) {
  const vals = results.map((r) => r.parse[k])
  add(`T3-부정-${k}`, vals.every((v) => v === 0), `${k}: ${vals.join(' / ')} (기대 0)`)
}

// ── 판정: 네 가지 결론이 시간대와 무관하게 같은가
for (const k of ['fresh-offset', 'old-offset', 'future-offset', 'tzless-unclear', 'no-time']) {
  const sigs = results.map((r) => `${r.judge[k].ok}/${r.judge[k].uncertain}/${r.judge[k].kind}`)
  add(`T4-판정일치-${k}`, new Set(sigs).size === 1, `${k}: ${results.map((r, i) => `${r.tz}=${sigs[i]}`).join(', ')}`)
}

// ── 판정의 **내용**이 맞는가(일치만으로는 모자라다 — 전부 똑같이 틀릴 수도 있다)
add('T5-새글은-통과', base.judge['fresh-offset'].ok === true && base.judge['fresh-offset'].kind === 'ok',
  JSON.stringify(base.judge['fresh-offset']))
add('T6-지난글은-확정거부', base.judge['old-offset'].ok === false && base.judge['old-offset'].uncertain === false
  && base.judge['old-offset'].kind === 'old', JSON.stringify(base.judge['old-offset']))
add('T7-미래글은-모름', base.judge['future-offset'].ok === false && base.judge['future-offset'].uncertain === true
  && base.judge['future-offset'].kind === 'future', JSON.stringify(base.judge['future-offset']))
add('T8-시간대없음은-모름이고-사유를-말한다',
  base.judge['tzless-unclear'].ok === false && base.judge['tzless-unclear'].uncertain === true
  && base.judge['tzless-unclear'].kind === 'tzless', JSON.stringify(base.judge['tzless-unclear']))
add('T9-시각없음은-모름', base.judge['no-time'].ok === false && base.judge['no-time'].uncertain === true
  && base.judge['no-time'].kind === 'no-time', JSON.stringify(base.judge['no-time']))

// ── 드리프트: 페이지에 주입되는 소스와 검사 대상 함수가 같은 답을 내는가
add('T10-주입소스와-검사함수-무드리프트', results.every((r) => r.drift.mismatch === 0),
  `불일치 ${results.map((r) => r.drift.mismatch).join('/')} 건 (표본 ${base.drift.sampled}개)`)

// ===== 보고 =====
const pass = checks.filter((c) => c.ok).length
const fail = checks.length - pass
console.log('\n== 게시 시각 판정 · 시간대 독립성 ==')
for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.id}\n         ${c.detail}`)
console.log(`\n  합계: ${pass} PASS / ${fail} FAIL  (시간대 ${TZS.join(', ')})`)

const outDir = path.join(REPO, 'verify-out', 'post-time')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'results.json'),
  JSON.stringify({ at: new Date().toISOString(), tzs: TZS, pass, fail, checks, raw: results }, null, 2))

process.exit(fail === 0 ? 0 : 1)
