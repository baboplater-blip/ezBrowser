#!/usr/bin/env node
// gen-perf-baseline.mjs — 마지막 성능 실측을 앱에 주입할 JSON 으로 굽는다.
//
// 왜 (2026-09-07, 임무 14): `browser://memory` 가 "하네스 실측 145MB / 249MB" 를 **하드코딩**하고
// 있었다. 시간이 지나면 낡고, 낡은 숫자는 없는 것만 못하다.
//
// 다만 이력 파일(`perf-out/perf-history.json`)은 **개발 머신 산출물**이라 설치된 앱이 읽을 수 없다.
// 그래서 `oss-licenses.json`(npm run licenses)과 같은 방식으로 **빌드 시점에 구워** 앱에 넣는다.
// 이력이 없으면(클론 직후 등) 파일을 만들지 않고 조용히 넘어간다 — 페이지는 "측정 기록 없음"을 보인다.
//
// 사용: node build/gen-perf-baseline.mjs   (npm run build 가 자동 호출)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBudget } from './lib/budget.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const HISTORY = path.join(REPO_ROOT, 'perf-out', 'perf-history.json')
const OUT = path.join(REPO_ROOT, 'app', 'main', 'storage', 'perf-baseline.json')

// 예산은 **단일 출처**(app/shared/perf-budget.json)에서 읽는다 — perf-measure 와 같은 값이 보장된다.
const B = loadBudget()
const BUDGETS = {
  noAdblockMB: B.blankWindowNoAdblockMB,
  totalMB: B.blankWindowMemoryMB,
  coldStartMs: B.coldStartMs,
  perTabMB: B.perTabMemoryMB,
  idleCpuPercent: B.idleCpuPercent,
}

function median(values) {
  const v = [...values].sort((a, b) => a - b)
  if (!v.length) return null
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2
}

function main() {
  let history = []
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY, 'utf8'))
    if (Array.isArray(parsed)) history = parsed.filter((h) => h && typeof h === 'object')
  } catch {
    console.log('[gen-perf-baseline] 실측 이력 없음 — 건너뜀 (npm run verify:full 로 생성된다)')
    try { fs.unlinkSync(OUT) } catch { /* 없으면 그만 */ }
    return
  }

  const warm = history.filter((h) => h.path === 'warm' && Number.isFinite(h.blankPrivateMB))
  if (!warm.length) {
    console.log('[gen-perf-baseline] 웜 경로 표본이 없음 — 건너뜀')
    return
  }
  const latest = warm[warm.length - 1]
  const recent = warm.slice(-10)

  const payload = {
    generatedAt: new Date().toISOString(),
    // 최신 1회와 최근 표본의 중앙값을 함께 준다 — 한 번의 값에 휘둘리지 않게.
    latest: {
      at: latest.at ?? null,
      totalMB: latest.blankPrivateMB ?? null,
      noAdblockMB: Number.isFinite(latest.noAdblockMB) ? latest.noAdblockMB : null,
      adblockCostMB: Number.isFinite(latest.adblockCostMB) ? latest.adblockCostMB : null,
      perTabMB: Number.isFinite(latest.perTabPrivateMB) ? latest.perTabPrivateMB : null,
      coldStartMs: Number.isFinite(latest.coldStartAvgMs) ? latest.coldStartAvgMs : null,
    },
    medianOfRecent: {
      samples: recent.length,
      totalMB: median(recent.map((h) => h.blankPrivateMB)),
      noAdblockMB: median(recent.map((h) => h.noAdblockMB).filter(Number.isFinite)),
    },
    budgets: BUDGETS,
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2))
  console.log(`[gen-perf-baseline] ${path.relative(REPO_ROOT, OUT)} 생성 — 최신 총계 ${payload.latest.totalMB}MB · adblock 제외 ${payload.latest.noAdblockMB ?? '미측정'}MB (웜 표본 ${warm.length}개)`)
}

main()
