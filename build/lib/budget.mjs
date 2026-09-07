// lib/budget.mjs — 가벼움 예산의 단일 출처(`app/shared/perf-budget.json`)를 읽는 얇은 로더.
//
// 왜 (2026-09-07, 임무 15): 예산 숫자가 `perf-measure.mjs` 와 `gen-perf-baseline.mjs` 두 곳에
// 각각 박혀 있었다. 한쪽만 고치면 **측정은 통과인데 화면에는 다른 예산이 뜨는** 상태가 된다.
// 판정에 쓰이는 값은 파일 하나로 모은다.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
export const BUDGET_FILE = path.join(REPO_ROOT, 'app', 'shared', 'perf-budget.json')

/** 예산에 반드시 있어야 하는 키 — 하나라도 없으면 조용히 잘못된 판정을 하느니 크게 실패한다. */
const REQUIRED = [
  'coldStartMs',
  'blankWindowNoAdblockMB',
  'blankWindowMemoryMB',
  'adblockColdAllowanceMB',
  'perTabMemoryMB',
  'idleCpuPercent',
  'rendererJsGzipKB',
]

let cache = null

export function loadBudget() {
  if (cache) return cache
  const raw = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'))
  // `_` 로 시작하는 키는 사람이 읽는 설명이다(JSON 에 주석을 못 쓰므로) — 값에서 걸러낸다.
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith('_')) out[k] = v
  }
  const missing = REQUIRED.filter((k) => !Number.isFinite(out[k]))
  if (missing.length) {
    throw new Error(`예산 파일에 값이 없거나 숫자가 아님: ${missing.join(', ')} (${BUDGET_FILE})`)
  }
  cache = out
  return out
}
