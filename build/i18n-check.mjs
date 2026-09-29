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

// 같은 객체 안의 중복 키 — JSON.parse 는 뒤의 값으로 조용히 덮어써 앞쪽 키들이 통째로 사라진다.
// 여러 lane 의 사전 추가를 git 이 텍스트로 자동 병합하면 `"page": {` 가 두 번 생겨 실제로
// vi.json 에서 키 310개가 사라졌다(2026-09-29). 누락 검사만으로는 한쪽만 깨졌을 때만 잡히므로 따로 본다.
function duplicateKeys(text) {
  const BS = String.fromCharCode(92)
  const stack = []
  const dups = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === BS ? 2 : 1
      const str = text.slice(i + 1, j)
      let k = j + 1
      while (k < text.length && /\s/.test(text[k])) k++
      if (text[k] === ':' && stack.length) {
        const top = stack[stack.length - 1]
        if (top.has(str)) dups.push(str)
        top.add(str)
      }
      i = j + 1
      continue
    }
    if (c === '{') stack.push(new Set())
    else if (c === '}') stack.pop()
    i++
  }
  return dups
}

const locales = ['ko', 'en', 'vi']
let dupTotal = 0
for (const l of locales) {
  const dups = duplicateKeys(readFileSync(path.join(dir, `${l}.json`), 'utf-8'))
  if (dups.length) {
    dupTotal += dups.length
    console.error(`\n[${l}.json] 같은 객체 안 중복 키 ${dups.length}개(뒤의 값이 앞을 덮어씀): ${dups.slice(0, 10).join(', ')}`)
  }
}
if (dupTotal) {
  console.error(`\n✗ i18n 중복 키 ${dupTotal}건 — 병합으로 생긴 중복 블록을 하나로 합치세요.`)
  process.exit(1)
}
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
