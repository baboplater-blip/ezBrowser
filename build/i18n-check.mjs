// i18n 키 정합성 점검 — ko/en 로케일의 키가 완전히 일치하는지 검사한다.
// 누락(한쪽에만 있는 키)이 하나라도 있으면 비0 종료 → 품질 게이트(test.md 게이트 7).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dir = path.join(root, 'app', 'shared', 'locales')

function load(name) {
  return JSON.parse(readFileSync(path.join(dir, name), 'utf-8'))
}

function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out.set(key, v)
  }
  return out
}

const locales = ['ko', 'en']
const flat = Object.fromEntries(locales.map((l) => [l, flatten(load(`${l}.json`))]))

// 모든 로케일 키의 합집합을 기준으로 각 로케일의 누락을 찾는다.
const allKeys = new Set()
for (const l of locales) for (const k of flat[l].keys()) allKeys.add(k)

let missing = 0
for (const l of locales) {
  const absent = [...allKeys].filter((k) => !flat[l].has(k)).sort()
  if (absent.length) {
    missing += absent.length
    console.error(`\n[${l}.json] 누락된 키 ${absent.length}개:`)
    for (const k of absent) console.error(`  - ${k}`)
  }
}

if (missing === 0) {
  console.log(`✓ i18n 정합성 통과 — ${locales.join('/')} 모두 ${allKeys.size}개 키 일치`)
  process.exit(0)
} else {
  console.error(`\n✗ i18n 누락 ${missing}건 — 위 키를 채우세요.`)
  process.exit(1)
}
