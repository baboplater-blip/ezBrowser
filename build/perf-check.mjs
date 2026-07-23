#!/usr/bin/env node
// perf-check — 최근 부팅 기록에서 콜드 스타트·메모리 예산 위반 여부 검사.
// 가장 최근 N회의 평균과 최악값을 평가하고 위반 시 exit 1.
//
// 사용:
//   node build/perf-check.mjs                  → AppData/userData 로그 읽기
//   PERF_LOG=/path/to/perf.json node build/perf-check.mjs

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const BUDGET = {
  coldStartMs: 2000,
  blankWindowMemoryMB: 250,
}
const SAMPLE_SIZE = 5

function defaultLogPath() {
  if (process.env.PERF_LOG) return process.env.PERF_LOG
  const plat = process.platform
  const home = os.homedir()
  // Electron 의 app.getPath('userData') 는 (app.setName() 을 호출하지 않는 한) package.json 의
  // "name" 필드(= "browser-build")를 쓴다 — electron-builder.yml 의 productName("ezBrowser")과는
  // 별개다. 실측: %APPDATA%/browser-build/logs/perf.json (productName 기준 폴더는 존재하지 않음).
  if (plat === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
      'browser-build', 'logs', 'perf.json')
  }
  if (plat === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'browser-build', 'logs', 'perf.json')
  }
  return path.join(home, '.config', 'browser-build', 'logs', 'perf.json')
}

async function main() {
  const file = defaultLogPath()
  let history
  try {
    const raw = await fs.readFile(file, 'utf-8')
    history = JSON.parse(raw)
  } catch (err) {
    console.error('[perf-check] 로그 파일을 읽을 수 없습니다:', file)
    console.error('  부팅 30초 후 자동으로 기록됩니다. 한 번 이상 실행하세요.')
    process.exit(2)
  }
  if (!Array.isArray(history) || history.length === 0) {
    console.error('[perf-check] 기록 없음:', file)
    process.exit(2)
  }
  const packaged = history.filter((h) => h.packaged === true)
  const sampleSrc = packaged.length > 0 ? packaged : history
  const recent = sampleSrc.slice(-SAMPLE_SIZE)
  const colds = recent.map((h) => h.firstWindowReadyMs ?? h.firstTabLoadedMs).filter((v) => typeof v === 'number')
  const mems = recent.map((h) => h.memoryAt30sMB).filter((v) => typeof v === 'number')
  const avgCold = colds.length ? Math.round(colds.reduce((s, v) => s + v, 0) / colds.length) : null
  const maxCold = colds.length ? Math.max(...colds) : null
  const avgMem = mems.length ? Math.round(mems.reduce((s, v) => s + v, 0) / mems.length) : null
  const maxMem = mems.length ? Math.max(...mems) : null

  const issues = []
  if (avgCold !== null && avgCold > BUDGET.coldStartMs) {
    issues.push(`콜드 스타트 평균 ${avgCold}ms > 예산 ${BUDGET.coldStartMs}ms (${recent.length}회)`)
  }
  if (maxCold !== null && maxCold > BUDGET.coldStartMs * 1.25) {
    issues.push(`콜드 스타트 최악 ${maxCold}ms > 예산 ${BUDGET.coldStartMs}ms 의 125%`)
  }
  if (avgMem !== null && avgMem > BUDGET.blankWindowMemoryMB) {
    issues.push(`빈 창 메모리 평균 ${avgMem}MB > 예산 ${BUDGET.blankWindowMemoryMB}MB`)
  }
  if (maxMem !== null && maxMem > BUDGET.blankWindowMemoryMB * 1.15) {
    issues.push(`빈 창 메모리 최악 ${maxMem}MB > 예산 ${BUDGET.blankWindowMemoryMB}MB 의 115%`)
  }

  console.log('성능 게이트 결과')
  console.log('---------------')
  console.log(`샘플: ${recent.length}회 (${packaged.length > 0 ? 'packaged' : 'dev'})`)
  console.log(`콜드 스타트  avg=${avgCold ?? 'N/A'}ms  max=${maxCold ?? 'N/A'}ms  예산=${BUDGET.coldStartMs}ms`)
  console.log(`30초 메모리  avg=${avgMem ?? 'N/A'}MB  max=${maxMem ?? 'N/A'}MB  예산=${BUDGET.blankWindowMemoryMB}MB`)
  if (issues.length === 0) {
    console.log('✓ 모든 예산 충족')
    process.exit(0)
  }
  console.log('✗ 예산 초과:')
  for (const s of issues) console.log('  - ' + s)
  process.exit(1)
}

main().catch((err) => {
  console.error('[perf-check] 오류:', err)
  process.exit(2)
})
