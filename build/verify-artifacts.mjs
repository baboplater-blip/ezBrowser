// 작업 산출물 저장소 검증 — 앱을 띄우지 않는 순수 검사(즉시 끝나므로 마감 게이트에 넣는다).
//
// 왜 상설인가: 여기서 지키는 것은 **작업 격리 경계**다. "A 작업이 만든 파일을 B 작업이 업로드할 수
// 없다" 가 깨지면 엉뚱한 이미지가 남의 SNS 에 올라간다. 그리고 **HTML 위장 거부**가 깨지면
// "로그인이 필요합니다" 페이지가 이미지인 척 게시된다(토큰 CDN 에서 실제로 일어나는 일).
// 둘 다 눈에 안 보이고, 깨져도 다른 검사는 전부 초록이다.
//
// 검출력 확인(2026-09-18): `resolveArtifactPath` 의 경계를 일부러 없애자 "다른 작업의 산출물 경로
// 거부" 가 빨개졌고, 원복 후 다시 통과했다. 빈 검사가 아니다.
//
// electron 의 `app.getPath` 는 임시 폴더로 가로챈다 — 사용자 프로필을 건드리지 않는다.

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-art-'))

// electron 을 가짜로 바꿔치기 — 산출물 루트가 임시 폴더로 가게 한다.
const Module = require('module')
const origLoad = Module._load
Module._load = function (req, ...rest) {
  if (req === 'electron') return { app: { getPath: () => root } }
  return origLoad.call(this, req, ...rest)
}

const A = require(path.join(REPO, 'app/dist/main/features/ai/artifacts.js'))

// ---- 진짜 PNG 를 손으로 조립한다(외부 의존 없이 "실제 바이트" 를 만들기 위해) ----
function crc32(buf) {
  const t = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  let r = 0xFFFFFFFF
  for (const b of buf) r = t[(r ^ b) & 0xFF] ^ (r >>> 8)
  return (r ^ 0xFFFFFFFF) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const idat = zlib.deflateSync(Buffer.alloc((w * 3 + 1) * h))
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

let pass = 0, fail = 0
const results = []
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS', name) } else { fail++; console.log('  FAIL', name, detail) }
  results.push({ name, ok: !!cond, detail: cond ? '' : String(detail).slice(0, 300) })
}

const base = { sourceUrl: 'https://cdn.example/y.png', sourcePageUrl: 'https://example/', sourceTabId: 'tab1' }

const r1 = A.saveArtifactBytes({ taskId: 'taskA', data: png(800, 600), ...base })
t('진짜 PNG 저장 + 치수 디코딩', r1.ok && r1.meta.width === 800 && r1.meta.height === 600 && r1.meta.format === 'png', JSON.stringify(r1).slice(0, 200))

if (r1.ok) {
  const onDisk = fs.readFileSync(r1.meta.path)
  t('sha256 가 실제 디스크 내용과 일치', crypto.createHash('sha256').update(onDisk).digest('hex') === r1.meta.sha256)
  t('바이트 수가 실제 파일 크기와 일치', onDisk.length === r1.meta.bytes)
}

const rHtml = A.saveArtifactBytes({ taskId: 'taskA', data: Buffer.from('<!DOCTYPE html><html>로그인이 필요합니다</html>'), ...base })
t('HTML 위장 거부', !rHtml.ok && rHtml.code === 'not-image', JSON.stringify(rHtml))
t('대문자·선행공백 HTML 도 거부', !A.saveArtifactBytes({ taskId: 'taskA', data: Buffer.from('   <HTML><body>x</body></HTML>'), ...base }).ok)
t('빈 파일 거부', !A.saveArtifactBytes({ taskId: 'taskA', data: Buffer.alloc(0), ...base }).ok)
t('잘린 PNG 거부', !A.saveArtifactBytes({ taskId: 'taskA', data: png(10, 10).subarray(0, 12), ...base }).ok)
t('확장자만 png 인 텍스트 거부', !A.saveArtifactBytes({ taskId: 'taskA', data: Buffer.from('not an image at all'), ...base }).ok)

// ===== 작업 격리 경계 (이 파일의 존재 이유) =====
if (r1.ok) {
  t('다른 작업은 산출물 경로를 얻지 못한다', A.resolveArtifactPath('taskB', r1.meta.id) === null)
  t('같은 작업은 경로를 얻는다(양성 대조)', A.resolveArtifactPath('taskA', r1.meta.id) === r1.meta.path)
  t('다른 작업 목록은 비어 있다', A.listArtifacts('taskB').length === 0)
  t('같은 작업 목록에는 있다(양성 대조)', A.listArtifacts('taskA').some((a) => a.id === r1.meta.id))
}
t('경로 이탈 id 거부', A.resolveArtifactPath('taskA', '../../../etc/passwd') === null)
t('taskId 경로 이탈 차단', A.taskArtifactDir('../../escape').startsWith(path.join(root, 'agent-artifacts')))

const rAny = A.saveArtifactBytes({ taskId: 'taskC', data: Buffer.from('plain text'), sourceUrl: 'https://x/a.txt', sourcePageUrl: 'https://x/', sourceTabId: 't', expect: 'any' })
t("expect:'any' 는 형식 검증을 건너뛴다", rAny.ok && rAny.meta.kind === 'file', JSON.stringify(rAny).slice(0, 150))

console.log(`\n합계 PASS ${pass} / FAIL ${fail}`)

const outDir = path.join(REPO, 'verify-out', 'artifacts')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), pass, fail, results }, null, 2))
fs.rmSync(root, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
