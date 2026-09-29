#!/usr/bin/env node
// verify-draft-promotion-cdp.mjs — "초안 승격"(draft promotion) 검증.
//
// 무엇을 보증하는가: 이미 만들어진 이미지+캡션 초안(review 단계의 draft 워크플로, 또는 완료된
// draft 워크플로)을 socialPromotePrepare/Confirm/Cancel 로 게시로 올릴 때
//   ① 이미지·캡션을 **다시 만들지 않는다**(같은 산출물 id·같은 sha256·같은 taskIds.generate)
//   ② 열어 보거나 취소만 해서는 **절대 게시되지 않는다**
//   ③ 확정은 그 순간의 사실(플랫폼·계정·산출물 해시·캡션)에 묶인 **1회용**이고, 하나라도 달라지면
//     옛 확정은 무효다
//   ④ 중복 클릭·재전송·확정 전/후 강제 종료에도 **중복 게시가 나지 않는다**
//   ⑤ 계정이 비었거나, 게시 중이거나, 게시 여부가 불확실하거나, 산출물 파일이 사라졌으면 **버튼이
//     숨거나 백엔드가 거부한다**
// 를 실제 패키징 앱(dist/win-unpacked/ezBrowser.exe) + 사용자가 누르는 그대로의 UI 클릭으로 확인한다.
//
// 보증하지 않는 것: 실제 인스타그램 서버 응답(전부 로컬 HTTPS 픽스처로 가로챈다 — 외부 네트워크
// 접속 0줄), 실제 LLM 모델의 판단 품질(가짜 LLM 각본으로 완전히 결정론적이다). 이 하네스가 쓰는
// 모델은 **가짜 LLM 각본(결정론) · 실제 구독 모델 아님**이다 — 대신 작업 런타임·저장소·게시
// 게이트(evaluatePromotion/confirmPromotion/runPublishStage)는 전부 **진짜 프로덕션 코드**다.
//
// 격리 프로필(--user-data-dir)만 쓴다. 사용자의 실제 프로필·실제 계정에는 절대 접근하지 않는다.
//
// 선례: verify-social-account-cdp.mjs(부팅 전 ai-social-workflows.json 직접 심기 + 실제 UI 클릭),
//       verify-social-pipeline-cdp.mjs(가짜 LLM 각본으로 에이전트를 결정론적으로 몰기),
//       verify-social-realmodel-cdp.mjs(--host-resolver-rules 로 www.instagram.com 을 로컬 HTTPS
//       픽스처로 가로채는 방법 — social-fixture-server.mjs 의 startInstagramHttpsFixture).
//
// 사용: node build/verify-draft-promotion-cdp.mjs [--port <n>] [--out <dir>] [--only DP1,DP4,...] [--keep-profile]

import { spawn, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { connectSession, connectShellSessionReady, sleep, waitForPortFree } from './lib/cdp.mjs'
import { startFakeLlm } from './lib/fake-llm.mjs'
import { getFreePorts, preferFreePort } from './lib/ports.mjs'
import { startSocialFixtures, startInstagramHttpsFixture, REAL_DOMAIN_HOST } from './social-fixture-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')
const ASAR = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar')

const args = { port: 9287, out: path.join(REPO_ROOT, 'verify-out', 'draft-promotion'), only: null, keepProfile: false }
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port') args.port = Number(process.argv[++i])
  else if (process.argv[i] === '--out') args.out = path.resolve(process.argv[++i])
  else if (process.argv[i] === '--only') args.only = String(process.argv[++i])
  else if (process.argv[i] === '--keep-profile') args.keepProfile = true
}

const results = []
function check(id, name, ok, detail) {
  results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${ok ? 'PASS' : 'FAIL'} — ${name}: ${detail}`)
  return ok
}
function fail(id, name, detail) {
  results.push({ id, name, status: 'FAIL', detail })
  console.log(`  ✗ ${id} FAIL — ${name}: ${detail}`)
}
function skip(id, name, reason) {
  results.push({ id, name, status: 'SKIP', detail: reason })
  console.log(`  ⋯ ${id} SKIP — ${name}: ${reason}`)
}

/** `--only DP1,DP4` — 한 번의 실행에 여러 시나리오를 골라 담는다(결과 파일이 마지막 실행 하나로
 * 덮어써지는 사고를 막는 이 저장소의 관례). */
function wants(id) {
  if (!args.only) return true
  return args.only.split(',').map((s) => s.trim()).filter(Boolean).includes(id)
}

// ── 의존성 0 PNG 인코더 (social-fixture-server.mjs 의 기법을 그대로 재구현 — 그 파일은 읽기 전용이라
// 내부 함수를 export 하지 않으므로 여기서 독립 구현한다) ──────────────────────────────────────────
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()
function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}
/** width x height 8비트 RGB PNG — seed 로 색이 달라져(=바이트가 달라져) 워크플로마다 다른 sha256 을 낸다. */
function encodePng(width, height, seedStr) {
  const h = crypto.createHash('sha256').update(String(seedStr)).digest()
  const [br, bg, bb] = [h[0], h[1], h[2]]
  const rowBytes = width * 3
  const raw = Buffer.alloc((rowBytes + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1)
    raw[rowStart] = 0
    for (let x = 0; x < width; x++) {
      const t = (x + y) % 64
      const off = rowStart + 1 + x * 3
      raw[off] = (br + t) & 0xff
      raw[off + 1] = (bg + t * 2) & 0xff
      raw[off + 2] = (bb + t * 3) & 0xff
    }
  }
  const compressed = zlib.deflateSync(raw)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))])
}

// ── 프로필 파일 시딩 헬퍼 ───────────────────────────────────────────────────────────────────────
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj, null, 2))
}

const WORKSPACE_ID = 'ws-dp'
const WINDOW_ID = 'win-1' // createBrowserWindow() 의 `win-${counter}` — 격리 프로필의 첫(유일한) 창은
                           // 프로세스마다 새로 시작하는 counter=0 에서 +1 되어 항상 'win-1' 이다.

/** genTaskId 폴더에 실제 PNG 파일 + _meta.json 을 쓴다. artifacts.ts 의 저장 형식과 정확히 같아야
 * getArtifact/resolveArtifactPath 가 이 파일을 인식한다. */
function seedArtifact(profileDir, genTaskId, artifactId, seedTag) {
  const png = encodePng(8, 6, `draft-promotion:${seedTag}`)
  const sha256 = crypto.createHash('sha256').update(png).digest('hex')
  const dir = path.join(profileDir, 'agent-artifacts', genTaskId)
  fs.mkdirSync(dir, { recursive: true })
  const fileName = `${artifactId}.png`
  fs.writeFileSync(path.join(dir, fileName), png)
  const meta = {
    id: artifactId, taskId: genTaskId, name: fileName, path: path.join(dir, fileName),
    kind: 'image', format: 'png', mime: 'image/png', bytes: png.length, sha256,
    width: 8, height: 6,
    sourceUrl: 'https://gen.example.invalid/seed.png', sourcePageUrl: 'https://gen.example.invalid/',
    sourceTabId: 'seed', capturedAt: Date.now(), origin: 'page-capture', label: '검증용 시드 산출물',
  }
  writeJson(path.join(dir, '_meta.json'), [meta])
  return { sha256, bytes: png.length, width: 8, height: 6, format: 'png' }
}

// ── 시나리오 워크플로 정의 ──────────────────────────────────────────────────────────────────────
// 전부 계정·캡션·산출물을 사전에 갖춘 draft — "다시 만들지 않고 올린다"를 시험하는 것이 목적이라
// 어느 것도 mark_baseline/capture_image 를 거치지 않는다(그 파이프라인은 verify-social-pipeline 몫).
function scenarioDefs(now) {
  return [
    // DP1(재생성 없음) + DP4(정확히 1건) — 같은 워크플로로 한 번에 확인한다(전체 위저드 완주가
    // 필요한 시나리오를 두 번 돌리지 않기 위함).
    { id: 'dp1', account: 'dp1_account', caption: 'DP1 원본 캡션 — 다시 만들면 안 됨', stage: 'review', mode: 'draft' },
    // DP2(취소는 무해) — 확정 화면만 열고 취소한다.
    { id: 'dp2', account: 'dp2_account', caption: 'DP2 캡션', stage: 'review', mode: 'draft' },
    // DP3(계정 없음 거부) — account 키 자체를 생략한다.
    { id: 'dp3', account: null, caption: 'DP3 캡션(계정 없음)', stage: 'review', mode: 'draft' },
    // DP5(중복 클릭·재전송) — 별도 워크플로로 전체 위저드를 완주시킨다.
    { id: 'dp5', account: 'dp5_account', caption: 'DP5 캡션', stage: 'review', mode: 'draft' },
    // DP6(캡션이 바뀌면 옛 확정 무효)
    { id: 'dp6', account: 'dp6_account', caption: 'DP6 원본 캡션', stage: 'review', mode: 'draft' },
    // DP6-ACC(계정이 바뀌면 옛 확정 무효)
    { id: 'dp6acc', account: 'dp6acc_original', caption: 'DP6-ACC 캡션', stage: 'review', mode: 'draft' },
    // DP7(확정 전 재시작 → 아무것도 안 나감)
    { id: 'dp7', account: 'dp7_account', caption: 'DP7 캡션', stage: 'review', mode: 'draft' },
    // DP8(확정 후 죽으면 모름으로 남고 중복 게시 안 함)
    { id: 'dp8', account: 'dp8_account', caption: 'DP8 캡션', stage: 'review', mode: 'draft' },
    // DP9(a) — 게시 진행 중 단계. taskIds.publish 를 채워 diedWhilePreparing(reviveWorkflow) 로
    // 'failed' 로 강등되는 것을 막는다(그러면 "게시 중" 자체를 시험할 수 없다).
    {
      id: 'dp9a', account: 'dp9a_account', caption: 'DP9a 캡션', stage: 'publish', mode: 'draft',
      extra: { taskIds: { publish: 'pub-dp9a-nonexistent' } },
    },
    // DP9(b) — review 단계인데 게시 여부가 불확실. 이것만 빼면 완벽히 승격 가능한 워크플로라야
    // "publishUncertain 하나 때문에 막힌다"는 것을 깨끗이 보여준다.
    { id: 'dp9b', account: 'dp9b_account', caption: 'DP9b 캡션', stage: 'review', mode: 'draft', extra: { publishUncertain: true } },
    // DP10 — 완료된 초안(stage:'done', receipt.status:'draft') + 지난 기록 보존.
    {
      id: 'dp10', account: 'dp10_account', caption: 'DP10 캡션', stage: 'done', mode: 'draft',
      extra: {
        receipt: { status: 'draft', evidence: '초안까지 준비(게시 안 함) — DP10 원본 기록', at: now - 3600_000 },
        taskIds: { publish: 'pub-dp10-old-draft' },
      },
    },
    // DP11 — 산출물 파일이 사라짐(seedArtifact 를 의도적으로 건너뛴다).
    { id: 'dp11', account: 'dp11_account', caption: 'DP11 캡션', stage: 'review', mode: 'draft', skipArtifact: true },
  ]
}

/** 워크플로 12개 + 각 산출물(dp11 제외) + 각 fake 생성 작업(ai-tasks.json) 을 프로필에 심는다. */
function seedAll(profileDir) {
  const now = Date.now()
  const defs = scenarioDefs(now)
  const workflows = []
  const tasks = []
  const shaByWorkflow = {}
  for (const d of defs) {
    const genTaskId = `gen-${d.id}`
    const artifactId = `art_${d.id}`
    let artifactPreview
    if (!d.skipArtifact) {
      const meta = seedArtifact(profileDir, genTaskId, artifactId, d.id)
      artifactPreview = { width: meta.width, height: meta.height, bytes: meta.bytes, format: meta.format, sha256: meta.sha256 }
      shaByWorkflow[d.id] = meta.sha256
    }
    tasks.push({
      id: genTaskId, instruction: `(시드) ${d.id} 용 생성 작업`, state: 'completed', mode: 'normal',
      checkpoint: { workspaceId: WORKSPACE_ID, windowId: WINDOW_ID },
    })
    workflows.push({
      id: d.id,
      params: {
        service: 'genspark', platform: 'instagram', prompt: `[검증] ${d.id} 초안 승격 시나리오`,
        mode: d.mode, tabId: `seed-tab-${d.id}`, windowId: WINDOW_ID,
        ...(d.account !== null ? { account: d.account } : {}),
      },
      stage: d.stage,
      taskIds: { generate: genTaskId, ...(d.extra?.taskIds ?? {}) },
      artifactId,
      ...(artifactPreview ? { artifactPreview } : {}),
      caption: d.caption,
      createdAt: now, updatedAt: now,
      ...(d.extra?.receipt ? { receipt: d.extra.receipt } : {}),
      ...(d.extra?.publishUncertain ? { publishUncertain: true } : {}),
    })
  }
  writeJson(path.join(profileDir, 'workspaces.json'), {
    workspaces: [{
      id: WORKSPACE_ID, name: '초안승격검증', color: 'gray', homeUrl: 'about:blank',
      partition: `persist:ws-${WORKSPACE_ID}`, createdAt: now, updatedAt: now, position: 0,
    }],
    activeId: WORKSPACE_ID,
  })
  writeJson(path.join(profileDir, 'ai-tasks.json'), { version: 1, tasks })
  writeJson(path.join(profileDir, 'ai-social-workflows.json'), { version: 1, workflows, grant: null })
  return { defs, shaByWorkflow }
}

// ── CDP 헬퍼 ──────────────────────────────────────────────────────────────────────────────────
async function evaluate(session, expression, timeoutMs = 20_000) {
  const r = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'JS 예외')
  return r.result?.value
}
async function pollExpr(session, expression, predicate, { timeoutMs = 20_000, intervalMs = 400, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await evaluate(session, expression)
    if (predicate(last)) return last
    await sleep(intervalMs)
  }
  throw new Error(`timeout(${timeoutMs}ms) waiting for ${label} — 마지막 값: ${JSON.stringify(last)}`)
}
async function clickSelector(session, selector) {
  return evaluate(session, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`)
}
async function elementExists(session, selector) {
  return evaluate(session, `!!document.querySelector(${JSON.stringify(selector)})`)
}

async function openAiPanel(session, windowId) {
  await evaluate(session, `window.browserAPI.actions.run('action.ai.open', { windowId: ${JSON.stringify(windowId)} })`)
  const deadline = Date.now() + 20_000
  let reopened = false
  while (Date.now() < deadline) {
    const found = await evaluate(session, `!!document.querySelector('.ai-tab')`)
    if (found) return true
    if (!reopened && Date.now() > deadline - 12_000) {
      await evaluate(session, `window.browserAPI.actions.run('action.ai.open', { windowId: ${JSON.stringify(windowId)} })`)
      reopened = true
    }
    await sleep(500)
  }
  return false
}
async function openSocialPanel(session) {
  const already = await evaluate(session, `!!document.querySelector('.ai-social-subtabs')`)
  if (already) return true
  const clicked = await evaluate(session, `(() => {
    const els = [...document.querySelectorAll('.ai-meta-actions .ai-mini-btn')]
    const el = els.find(x => (x.textContent || '').includes('🎨 만들기'))
    if (!el) return false
    el.click(); return true
  })()`)
  if (!clicked) return false
  return pollExpr(session, `!!document.querySelector('.ai-social-subtabs')`, (v) => v === true,
    { timeoutMs: 8_000, label: '"🎨 만들기" 패널 열림' }).then(() => true).catch(() => false)
}

/** `[data-workflow-id]` 로 카드를 정확히 찾는다(내가 워크플로 id 를 직접 지어냈으므로 마커 문자열
 * 매칭보다 이 편이 더 정확하다). */
function cardSel(id, sub = '') { return `.ai-social-card[data-workflow-id=${JSON.stringify(id)}]${sub}` }
async function readCardState(session, id) {
  return evaluate(session, `(() => {
    const c = document.querySelector(${JSON.stringify(cardSel(id))})
    if (!c) return { found: false }
    const err = c.querySelector('[data-testid="social-promote-error"]')
    const panel = c.querySelector('[data-testid="social-promote-panel"]')
    return {
      found: true,
      hasPromoteBtn: !!c.querySelector('.ai-social-promote'),
      hasPanel: !!panel,
      revision: panel ? panel.getAttribute('data-revision') : null,
      hasError: !!err,
      errorText: err ? err.textContent.trim() : null,
    }
  })()`)
}
async function getWfById(session, id) {
  return evaluate(session, `(async () => {
    const list = await window.browserAPI.ai.socialList()
    return list.find(x => x.id === ${JSON.stringify(id)}) ?? null
  })()`)
}
async function callPreparePromote(session, id) {
  return evaluate(session, `window.browserAPI.ai.socialPromotePrepare(${JSON.stringify(id)})`)
}
async function callConfirmPromote(session, id, token) {
  return evaluate(session, `window.browserAPI.ai.socialPromoteConfirm(${JSON.stringify(id)}, ${JSON.stringify(token)})`)
}
async function callCancelPromote(session, id) {
  return evaluate(session, `window.browserAPI.ai.socialPromoteCancel(${JSON.stringify(id)})`)
}

/** publish 작업이 생길 때까지 기다린다(runPublishStage 는 탭 이동을 fire-and-forget 하므로
 * confirmPromotion 이 반환한 시점엔 아직 taskIds.publish 가 비어 있을 수 있다). */
/**
 * 승격이 만든 **새** 게시 작업 id 를 기다린다.
 *
 * ⚠ `exclude` 가 필요한 이유: 완료된 초안(DP10)은 **승격 전부터** `taskIds.publish` 에 그 초안이
 *   남긴 옛 작업 id 를 들고 있다. 그것을 그대로 돌려주면 이후 대기가 **옛 작업**(이미 끝났거나
 *   아예 없는)을 붙들고 앉아 60초 뒤 `state=undefined` 로 끝난다 — 제품은 멀쩡히 게시하고 있는데
 *   하네스가 엉뚱한 곳을 본 것이다(2026-09-19 에 실제로 그렇게 빨갛게 나왔다).
 */
async function waitForPublishTaskId(session, id, timeoutMs = 20_000, exclude = null) {
  const wf = await pollExpr(session, `(async () => {
    const list = await window.browserAPI.ai.socialList()
    const w = list.find(x => x.id === ${JSON.stringify(id)})
    return JSON.stringify(w ? (w.taskIds.publish ?? null) : undefined)
  })()`, (v) => {
    if (v === JSON.stringify(undefined) || v === JSON.stringify(null)) return false
    return exclude === null || JSON.parse(v) !== exclude
  }, { timeoutMs, label: `${id} 의 새 publish 작업 생성` })
  return JSON.parse(wf)
}

/** 게시 작업을 종료까지 몬다 — waiting-user/needs-verify 는 사용자가 하는 것과 같은 응답으로 넘긴다.
 * 완료 여부의 최종 판정은 항상 픽스처 /state 로 한다(여기서는 루프만 종료시킨다). */
async function driveTaskToTerminal(session, taskId, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastWaitAt = null
  let acceptedOnce = false
  let last = null
  while (Date.now() < deadline) {
    const t = await evaluate(session, `window.browserAPI.ai.ptaskGet(${JSON.stringify(taskId)})`)
    if (!t) return { ...last, notFound: true }
    last = t
    if (t.state === 'waiting-user') {
      if (t.updatedAt !== lastWaitAt) {
        lastWaitAt = t.updatedAt
        await evaluate(session, `window.browserAPI.ai.ptaskConfirm(${JSON.stringify(taskId)}, true)`).catch(() => {})
        const t2 = await evaluate(session, `window.browserAPI.ai.ptaskGet(${JSON.stringify(taskId)})`).catch(() => null)
        if (t2 && t2.state === 'waiting-user') {
          await evaluate(session, `window.browserAPI.ai.ptaskAnswer(${JSON.stringify(taskId)}, ${JSON.stringify('네, 계속 진행해 주세요.')})`).catch(() => {})
        }
      }
    } else if (t.state === 'needs-verify') {
      if (!acceptedOnce) { acceptedOnce = true; await evaluate(session, `window.browserAPI.ai.ptaskAccept(${JSON.stringify(taskId)})`).catch(() => {}) }
    } else if (t.state === 'completed' || t.state === 'failed' || t.state === 'cancelled' || t.state === 'interrupted') {
      return t
    }
    await sleep(400)
  }
  return { ...last, timedOut: true }
}

// ── 가짜 LLM 위저드 각본(인스타그램 픽스처) ────────────────────────────────────────────────────
function refFromObservation(text, label) {
  const re = /\[(\d+)\]\s+\S+\s+"([^"]*)"/g
  let m
  while ((m = re.exec(text ?? ''))) { if (String(m[2]).includes(label)) return Number(m[1]) }
  return null
}
/**
 * 각본이 페이지를 몰지 못한 순간들 — **하네스 결함**이지 제품 결함이 아니다.
 *
 * 왜 따로 모으는가 (2026-09-19 에 실제로 겪었다): 라벨을 못 찾았을 때 조용히 `done` 을 내보내면
 * 작업은 "완료" 로 끝나고 픽스처에는 아무것도 도착하지 않는다 — 화면에는 **제품이 게시에 실패한
 * 것처럼** 보인다(실제로 DP1·DP4·DP8 이 그렇게 빨갛게 나왔고, 원인은 위저드 단계 수를 하나 적게
 * 적은 각본이었다). 이제 그 사실을 기록해 판정이 원인을 지목할 수 있게 한다.
 */
const scriptFaults = []
function clickByLabel(label) {
  return {
    reply: (ctx) => {
      const ref = refFromObservation(ctx.lastUser, label)
      if (ref === null) {
        scriptFaults.push(label)
        return JSON.stringify({ action: 'done', message: `[하네스 각본 결함] "${label}" 을 관찰에서 못 찾음` })
      }
      return JSON.stringify({ action: 'click', ref, thought: `"${label}" 누름` })
    },
  }
}
/**
 * 인스타그램 픽스처 위저드.
 * ⚠ 단계 수는 픽스처(`social-fixture-server.mjs` 의 `instagramWizardHtml`)와 **정확히** 맞춰야 한다:
 *   만들기 → 파일 → 다음(자르기) → 다음(수정) → 다음(문구) → 캡션 입력 → 공유하기 → 완료 대기.
 *   `다음` 은 **3번**이다(예전 각본은 2번이라 문구 칸에 닿지 못했다).
 */
function wizardScript(artifactId, caption) {
  return [
    clickByLabel('만들기'),
    { reply: (ctx) => {
      // ⚠ 시드한 산출물 id 를 그대로 쓰면 안 된다. 앱은 게시 작업을 만들 때 산출물을 **그 작업의
      //   폴더로 복사**하면서 **새 id** 를 부여하고(작업 격리 경계), 지시문의 자리표시자를 그 새
      //   id 로 치환한다. 옛 id 로 upload_file 을 부르면 앱이 "이 작업의 산출물 중 'art_dp1' 는
      //   없습니다" 로 정확히 거부한다 — 제품이 옳고 각본이 틀린 것이다(2026-09-19 실측).
      //   그래서 **지시문에 적힌 id 를 읽어** 쓴다.
      const all = (ctx.messages ?? []).map((m) => String(m?.content ?? '')).join('\n')
      const m = /artifact 인자로 "(art_[0-9a-z]+)"/.exec(all) || /\b(art_[0-9a-f]{12})\b/.exec(all)
      return JSON.stringify({ action: 'upload_file', artifact: m ? m[1] : artifactId })
    } },
    clickByLabel('다음'),
    clickByLabel('다음'),
    clickByLabel('다음'),
    { reply: (ctx) => {
      const ref = refFromObservation(ctx.lastUser, '문구')
      if (ref === null) return JSON.stringify({ action: 'wait', thought: '캡션 칸 대기' })
      return JSON.stringify({ action: 'type', ref, text: caption })
    } },
    clickByLabel('공유하기'),
    { reply: () => JSON.stringify({ action: 'wait_for', text: '게시물이 공유되었습니다', timeout: 8_000 }) },
    { reply: () => JSON.stringify({ action: 'done', message: '완료' }) },
  ]
}

// ── 프로세스 제어 ──────────────────────────────────────────────────────────────────────────────
function hardKill(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) { resolve(); return }
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    child.once('exit', finish)
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 이미 죽었을 수 있다 */ }
    setTimeout(finish, 8_000)
  })
}

async function main() {
  fs.mkdirSync(args.out, { recursive: true })
  if (!fs.existsSync(EXE)) { console.error(`exe 없음: ${EXE} — 팀장이 패키징해야 한다`); process.exit(2) }

  // ── 신선도 대조 — 팀장이 동시에 구현 중인 기능이라, 낡은 빌드를 검사하고 있으면 매 실행마다
  // 드러낸다(관련 파일이 asar 보다 새로우면 재패키징이 필요하다는 뜻이다). ──────────────────────
  const asarMtime = fs.statSync(ASAR).mtimeMs
  const srcFiles = [
    'app/main/features/ai/social-workflow.ts', 'app/main/ipc/ai.ts',
    'app/preload/chrome.ts', 'app/renderer/components/AiSocialPanel.tsx', 'app/shared/ipc-channels.ts',
  ]
  const newestSrc = srcFiles
    .map((p) => ({ p, t: (() => { try { return fs.statSync(path.join(REPO_ROOT, p)).mtimeMs } catch { return 0 } })() }))
    .reduce((a, b) => (b.t > a.t ? b : a), { p: '(없음)', t: 0 })
  console.log(`[신선도] app.asar=${new Date(asarMtime).toISOString()} · 최신 소스=${newestSrc.p} ${new Date(newestSrc.t).toISOString()}`)
  if (asarMtime < newestSrc.t) {
    console.warn('[신선도] ⚠ 패키지가 소스보다 오래됐다 — 낡은 바이너리를 검사하고 있을 수 있다(재패키징 필요)')
  }
  console.log('[모델] 가짜 LLM 각본(결정론) · 실제 구독 모델 아님 — 단, 작업 런타임·저장소·게시 게이트는 진짜 프로덕션 코드다.')

  args.port = await preferFreePort(args.port, 'verify-draft-promotion-cdp.mjs')
  if (!(await waitForPortFree(args.port))) { console.error(`포트 ${args.port} 점유 중`); process.exit(2) }
  const [llmPort] = await getFreePorts(1)
  // 각본이 페이지를 어떻게 보고 있는지 그대로 남긴다 — 각본이 어긋났을 때 **어느 단계에서**
  // 무엇이 안 보였는지 추측하지 않고 읽을 수 있어야 한다(2026-09-19 진단에 실제로 필요했다).
  const obsLogPath = path.join(args.out, 'observations.log')
  try { fs.rmSync(obsLogPath, { force: true }) } catch { /* ignore */ }
  const llm = await startFakeLlm({
    port: llmPort,
    onRequest: ({ idx, lastUser }) => {
      try { fs.appendFileSync(obsLogPath, `
===== 호출 #${idx} =====
${String(lastUser ?? '').slice(0, 4000)}
`) } catch { /* ignore */ }
    },
  })

  const fixture = await startSocialFixtures()
  console.log(`[픽스처] base=${fixture.base} (127.0.0.1 loopback 전용 — 외부 접속 없음)`)
  const certOutDir = path.join(args.out, 'certs')
  // `control` 은 startInstagramHttpsFixture 의 **인자**다(반환값의 프로퍼티가 아니다) — 같은 객체
  // 참조를 들고 있다가 나중에 `igControl.holdPublish = true` 로 토글한다(DP8).
  const igControl = { holdPublish: false }
  const igHttps = await startInstagramHttpsFixture(fixture.state, certOutDir, igControl).catch((err) => {
    console.log('[igHttps] 인터셉터 기동 실패:', err?.message ?? err); return null
  })
  const wizardNeeded = ['DP1', 'DP4', 'DP5', 'DP7', 'DP8', 'DP10'].some(wants)
  if (!igHttps && wizardNeeded) {
    console.warn('[igHttps] 격리 인터셉터를 세우지 못함(openssl 확인 필요) — 위저드가 필요한 시나리오는 전부 SKIP 한다(안전 우선).')
  } else if (igHttps) {
    console.log(`[igHttps] ${REAL_DOMAIN_HOST} → 127.0.0.1:${igHttps.port} (--host-resolver-rules, 실제 인터넷 접속 없음)`)
  }

  const profileDir = path.join(args.out, 'profile')
  if (!args.keepProfile) fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  writeJson(path.join(profileDir, 'settings.json'), {
    setup: { completed: true, completedAt: Date.now(), version: 'verify-draft-promotion' },
    startup: { mode: 'newtab', urls: [] }, // 세션 복원 모달이 재시작 시나리오(DP7/DP8)에서 CDP 를 막지 않게.
    adblock: { enabled: false },
    ai: {
      enabled: true, provider: 'ollama', ollamaUrl: llm.url, ollamaModel: 'test-model',
      agentMaxSteps: 20, agentVision: 'off', agentHumanInput: false, agentAutoApprove: false, agentInputMode: 'fast',
    },
  })
  const { defs, shaByWorkflow } = seedAll(profileDir)
  console.log(`[시드] 워크플로 ${defs.length}개 · 산출물 ${defs.filter((d) => !d.skipArtifact).length}개 · 작업 ${defs.length}개`)

  const bootArgs = [`--remote-debugging-port=${args.port}`, `--user-data-dir=${profileDir}`]
  if (igHttps) bootArgs.push(`--host-resolver-rules=${igHttps.hostResolverRule}`, '--ignore-certificate-errors')

  let child = null
  let shell = null
  let windowId = null

  async function boot(label) {
    // ⚠ 앞 인스턴스가 디버그 포트를 **아직 쥐고 있으면** /json/list 가 죽어 가는 좀비의 타깃(또는
    //   아무것도)을 돌려주고, 새 앱은 영영 붙지 못한다(2026-09-19 에 boot3 가 90초 타임아웃으로
    //   무너진 실제 원인). 정상 종료 경로(gracefulQuit)에만 이 대기가 있었고 **강제 종료 뒤에는
    //   없었다.** 부팅 자체의 전제로 올린다.
    await waitForPortFree(args.port, 20_000).catch(() => {
      console.log(`[draft-promotion] 경고: 포트 ${args.port} 가 비지 않았다 — 그대로 진행한다`)
    })
    child = spawn(EXE, bootArgs, { env: { ...process.env }, cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.pipe(fs.createWriteStream(path.join(args.out, `app-${label}-stdout.log`)))
    child.stderr?.pipe(fs.createWriteStream(path.join(args.out, `app-${label}-stderr.log`)))
    shell = await connectShellSessionReady(args.port, { log: (m) => console.log(`[draft-promotion] ${m}`) })
    await sleep(1000)
    windowId = await evaluate(shell, `new URL(location.href).searchParams.get('windowId')`)
    return shell
  }

  async function afterBootUi(label) {
    const opened = await openAiPanel(shell, windowId)
    check(`SETUP-${label}-AI`, 'AI 패널이 실제로 열림', opened, opened ? '.ai-tab 마운트 확인' : '.ai-tab 을 찾지 못함')
    if (!opened) throw new Error('AI 패널을 열지 못해 이후 시나리오를 진행할 수 없음')
    const socialOpened = await openSocialPanel(shell)
    check(`SETUP-${label}-SOCIAL`, '"🎨 만들기" 클릭으로 소셜 패널이 열림', socialOpened, socialOpened ? 'OK' : '패널을 열지 못함')
    if (!socialOpened) throw new Error('소셜 패널을 열지 못해 이후 시나리오를 진행할 수 없음')
  }

  async function gracefulQuit() {
    const exited = new Promise((r) => { child.once('exit', r) })
    try {
      const v = await (await fetch(`http://127.0.0.1:${args.port}/json/version`)).json()
      const b = await connectSession({ webSocketDebuggerUrl: v.webSocketDebuggerUrl }, 'browser')
      await b.send('Browser.close').catch(() => {}); b.close()
    } catch { /* ignore */ }
    await Promise.race([exited, sleep(15_000)])
    try { shell?.close() } catch { /* ignore */ }
    try { child?.kill() } catch { /* ignore */ }
    await waitForPortFree(args.port).catch(() => {})
    await sleep(500)
  }

  try {
    // ═══════════════════════════════════ 1차 부팅 ═══════════════════════════════════════════
    await boot('boot1')
    await afterBootUi('boot1')

    for (const d of defs) {
      const card = await pollExpr(shell, `(() => !!document.querySelector(${JSON.stringify(cardSel(d.id))}))()`,
        (v) => v === true, { timeoutMs: 10_000, label: `카드[${d.id}] 렌더` }).catch(() => false)
      check(`SETUP-CARD-${d.id}`, `심은 워크플로 카드가 화면에 보임(${d.id})`, !!card, card ? 'OK' : '카드를 찾지 못함')
    }

    // ── DP3: 계정 없음 거부 ─────────────────────────────────────────────────────────────────
    if (wants('DP3')) {
      try {
        const before = await getWfById(shell, 'dp3')
        const before1 = await readCardState(shell, 'dp3')
        // ① 버튼은 있다(캡션만 있으면 canPromote 는 계정을 안 본다) — UI 로 실제 클릭.
        const clicked = await clickSelector(shell, cardSel('dp3', ' .ai-social-promote'))
        const afterClickErr = await pollExpr(shell, `(() => {
          const el = document.querySelector(${JSON.stringify(cardSel('dp3', ' [data-testid="social-promote-error"]'))})
          return el ? el.textContent.trim() : null
        })()`, (v) => typeof v === 'string' && v.length > 0, { timeoutMs: 6_000, label: 'DP3 오류 안내' }).catch(() => null)
        // ② 직접 IPC 로도 거부되는지(임의 토큰).
        const directConfirm = await callConfirmPromote(shell, 'dp3', '아무토큰')
        const after = await getWfById(shell, 'dp3')
        check('DP3', '계정 없음 — 버튼은 있어도 prepare 가 거부하고(①), confirm 도 거부되며(②), 초안은 그대로 남는다(④)',
          before1.hasPromoteBtn === true && clicked === true && typeof afterClickErr === 'string' && afterClickErr.length > 0
            && directConfirm?.ok === false
            && after?.caption === before?.caption && after?.stage === 'review' && (after?.params?.account ?? null) === null,
          `버튼존재=${before1.hasPromoteBtn} 클릭=${clicked} 화면오류="${afterClickErr}" 직접confirm=${JSON.stringify(directConfirm)} `
          + `초안보존(캡션 "${before?.caption}"→"${after?.caption}", 계정=${JSON.stringify(after?.params?.account)})`)
      } catch (e) { fail('DP3', '계정 없음 거부', e.message) }
    } else skip('DP3', '계정 없음 거부', '--only 로 제외됨')

    // ── DP9: 게시 중 / 불확실 상태 거부 ──────────────────────────────────────────────────────
    if (wants('DP9')) {
      try {
        const stagePublish = await readCardState(shell, 'dp9a')
        const stagePrep = await callPreparePromote(shell, 'dp9a')
        const stageConfirm = await callConfirmPromote(shell, 'dp9a', 'x')
        check('DP9-STAGE', '게시 중(stage=publish) — 버튼 없음 + prepare/confirm 모두 거부',
          stagePublish.found === true && stagePublish.hasPromoteBtn === false
            && stagePrep?.ok === false && stageConfirm?.ok === false,
          `버튼존재=${stagePublish.hasPromoteBtn}(없어야) prepare=${JSON.stringify(stagePrep)} confirm=${JSON.stringify(stageConfirm)}`)

        const uncertainCard = await readCardState(shell, 'dp9b')
        const uncertainPrep = await callPreparePromote(shell, 'dp9b')
        const uncertainConfirm = await callConfirmPromote(shell, 'dp9b', 'x')
        check('DP9-UNCERTAIN', '게시 여부 불확실(publishUncertain) — 버튼 없음 + prepare/confirm 모두 거부',
          uncertainCard.found === true && uncertainCard.hasPromoteBtn === false
            && uncertainPrep?.ok === false && uncertainConfirm?.ok === false,
          `버튼존재=${uncertainCard.hasPromoteBtn}(없어야) prepare=${JSON.stringify(uncertainPrep)} confirm=${JSON.stringify(uncertainConfirm)}`)
      } catch (e) { fail('DP9-STAGE', '게시 중 거부', e.message); fail('DP9-UNCERTAIN', '불확실 상태 거부', e.message) }
    } else { skip('DP9-STAGE', '게시 중 거부', '--only 로 제외됨'); skip('DP9-UNCERTAIN', '불확실 상태 거부', '--only 로 제외됨') }

    // ── DP11: 산출물 파일 없음 ──────────────────────────────────────────────────────────────
    if (wants('DP11')) {
      try {
        const before = await getWfById(shell, 'dp11')
        const card = await readCardState(shell, 'dp11')
        const prep = await callPreparePromote(shell, 'dp11')
        const after = await getWfById(shell, 'dp11')
        const stillNoPub = (fixture.state.publishes?.length ?? 0)
        check('DP11', '산출물 파일이 사라졌으면 명확한 사유로 거부하되 초안(캡션·stage)은 그대로 남는다',
          card.found === true && prep?.ok === false && typeof prep?.error === 'string' && prep.error.length > 0
            && after?.caption === before?.caption && after?.stage === before?.stage,
          `prepare=${JSON.stringify(prep)} 캡션보존="${after?.caption}" stage보존=${after?.stage} 픽스처publishes=${stillNoPub}`)
      } catch (e) { fail('DP11', '산출물 파일 없음', e.message) }
    } else skip('DP11', '산출물 파일 없음', '--only 로 제외됨')

    // ── DP2: 취소는 무해 ────────────────────────────────────────────────────────────────────
    // dp2Delta 는 이후 DP1/DP4 블록에서 "같은 실행 안의 대조"(요구사항 3)를 실제 숫자로 보여주는 데 쓴다.
    let dp2Delta = null
    if (wants('DP2')) {
      try {
        const before = await getWfById(shell, 'dp2')
        const beforePub = fixture.state.publishes.length
        const clicked = await clickSelector(shell, cardSel('dp2', ' .ai-social-promote'))
        const panelOpened = await pollExpr(shell, `(() => !!document.querySelector(${JSON.stringify(cardSel('dp2', ' [data-testid="social-promote-panel"]'))}))()`,
          (v) => v === true, { timeoutMs: 6_000, label: 'DP2 확정 패널 열림' }).catch(() => false)
        const cancelClicked = await clickSelector(shell, cardSel('dp2', ' [data-testid="social-promote-cancel"]'))
        const panelClosed = await pollExpr(shell, `(() => !document.querySelector(${JSON.stringify(cardSel('dp2', ' [data-testid="social-promote-panel"]'))}))()`,
          (v) => v === true, { timeoutMs: 6_000, label: 'DP2 확정 패널 닫힘' }).catch(() => false)
        await sleep(500) // 취소 IPC 가 무엇도 바꾸지 않는지 볼 시간을 준다
        const after = await getWfById(shell, 'dp2')
        const afterPub = fixture.state.publishes.length
        dp2Delta = afterPub - beforePub
        check('DP2', '열기·취소만으로는 절대 게시되지 않고, 워크플로가 취소 전과 완전히 동일하다',
          clicked && panelOpened && cancelClicked && panelClosed && dp2Delta === 0
            && after?.stage === before?.stage && after?.params?.mode === before?.params?.mode
            && after?.caption === before?.caption && after?.artifactId === before?.artifactId
            && JSON.stringify(after?.receipt) === JSON.stringify(before?.receipt)
            && !after?.promotedAt && !after?.taskIds?.publish,
          `패널열림=${panelOpened} 취소클릭=${cancelClicked} 패널닫힘=${panelClosed} `
          + `픽스처publishes ${beforePub}→${afterPub}(delta=${dp2Delta}, 같아야) promotedAt=${JSON.stringify(after?.promotedAt)}(없어야) `
          + `taskIds.publish=${JSON.stringify(after?.taskIds?.publish)}(없어야)`)
      } catch (e) { fail('DP2', '취소는 무해', e.message) }
    } else skip('DP2', '취소는 무해', '--only 로 제외됨')

    // ── DP6: 캡션이 바뀌면 옛 확정 무효 ─────────────────────────────────────────────────────
    // main 이 setCaption/setWorkflowAccount 로 열린 티켓을 **일부러** 지우지 않는다(그래야 확정
    // 시점에 "무엇이 바뀌었는지" 짚어 줄 수 있다) — 그리고 그 대칭으로 렌더러는 내용이 바뀌면 열린
    // 패널을 스스로 닫는다(팀장 지적). 그래서 "옛 토큰"을 실제로 손에 쥐려면 UI 패널이 아니라
    // **직접 IPC 로 캡처한 문자 그대로의 토큰**을 써야 한다 — 패널 DOM 에는 토큰이 노출되지 않는다.
    // 버튼·패널이 실제로 뜨는지는 별도의 가벼운 UI 클릭으로 구조만 확인한다.
    if (wants('DP6')) {
      try {
        const beforePub = fixture.state.publishes.length
        const uiClicked = await clickSelector(shell, cardSel('dp6', ' .ai-social-promote'))
        const uiPanelOpened = await pollExpr(shell, `(() => !!document.querySelector(${JSON.stringify(cardSel('dp6', ' [data-testid="social-promote-panel"]'))}))()`,
          (v) => v === true, { timeoutMs: 6_000, label: 'DP6 확정 패널 열림(UI 구조 확인)' }).catch(() => false)
        await callCancelPromote(shell, 'dp6') // UI 로 연 티켓을 정리 — 아래 직접 캡처와 섞이지 않게.
        await sleep(200)

        const prep = await callPreparePromote(shell, 'dp6')
        if (!prep?.ok) throw new Error(`prepare 자체가 실패함(선행조건 이상): ${JSON.stringify(prep)}`)
        const oldToken = prep.plan.token
        const setRes = await evaluate(shell, `window.browserAPI.ai.socialSetCaption(${JSON.stringify('dp6')}, ${JSON.stringify('DP6 변경된 캡션 — 이 값이 반영되기 전 토큰으로 confirm 한다')})`)
        await sleep(200)
        const confirmRes = await callConfirmPromote(shell, 'dp6', oldToken)
        await sleep(500)
        const afterPub = fixture.state.publishes.length
        const after = await getWfById(shell, 'dp6')
        const combinedMsg = `${confirmRes?.error ?? ''} ${confirmRes?.errorEn ?? ''}`
        const mentionsCaption = /캡션|caption/i.test(combinedMsg)
        check('DP6', 'UI 로 버튼·패널이 실제로 뜨고(구조 확인), 캡션 변경 뒤 옛 토큰으로 confirm 하면 거부되며(사유에 "캡션/caption" 포함) 게시는 나가지 않는다',
          uiClicked && uiPanelOpened && setRes?.ok === true && confirmRes?.ok === false && mentionsCaption
            && afterPub === beforePub && !after?.promotedAt
            && after?.caption === 'DP6 변경된 캡션 — 이 값이 반영되기 전 토큰으로 confirm 한다',
          `UI클릭=${uiClicked} UI패널=${uiPanelOpened} 캡션저장=${JSON.stringify(setRes)} 옛토큰confirm=${JSON.stringify(confirmRes)} `
          + `사유에캡션언급=${mentionsCaption} 픽스처publishes ${beforePub}→${afterPub}(같아야) promotedAt=${JSON.stringify(after?.promotedAt)}(없어야)`)
      } catch (e) { fail('DP6', '캡션 드리프트', e.message) }
    } else skip('DP6', '캡션 드리프트', '--only 로 제외됨')

    // ── DP6-ACC: 계정이 바뀌면 옛 확정 무효 (DP6 과 같은 이유로 직접 IPC 로 옛 토큰을 캡처) ─────
    if (wants('DP6-ACC')) {
      try {
        const beforePub = fixture.state.publishes.length
        const uiClicked = await clickSelector(shell, cardSel('dp6acc', ' .ai-social-promote'))
        const uiPanelOpened = await pollExpr(shell, `(() => !!document.querySelector(${JSON.stringify(cardSel('dp6acc', ' [data-testid="social-promote-panel"]'))}))()`,
          (v) => v === true, { timeoutMs: 6_000, label: 'DP6-ACC 확정 패널 열림(UI 구조 확인)' }).catch(() => false)
        await callCancelPromote(shell, 'dp6acc')
        await sleep(200)

        const prep = await callPreparePromote(shell, 'dp6acc')
        if (!prep?.ok) throw new Error(`prepare 자체가 실패함(선행조건 이상): ${JSON.stringify(prep)}`)
        const oldToken = prep.plan.token
        const setRes = await evaluate(shell, `window.browserAPI.ai.socialSetAccount(${JSON.stringify('dp6acc')}, ${JSON.stringify('dp6acc_changed')})`)
        await sleep(200)
        const confirmRes = await callConfirmPromote(shell, 'dp6acc', oldToken)
        await sleep(500)
        const afterPub = fixture.state.publishes.length
        const after = await getWfById(shell, 'dp6acc')
        const combinedMsg = `${confirmRes?.error ?? ''} ${confirmRes?.errorEn ?? ''}`
        const mentionsAccount = /계정|account/i.test(combinedMsg)
        check('DP6-ACC', 'UI 로 버튼·패널이 실제로 뜨고(구조 확인), 계정 변경 뒤 옛 토큰으로 confirm 하면 거부되며(사유에 "계정/account" 포함) 게시는 나가지 않는다',
          uiClicked && uiPanelOpened && setRes?.ok === true && confirmRes?.ok === false && mentionsAccount
            && afterPub === beforePub && !after?.promotedAt && after?.params?.account === 'dp6acc_changed',
          `UI클릭=${uiClicked} UI패널=${uiPanelOpened} 계정저장=${JSON.stringify(setRes)} 옛토큰confirm=${JSON.stringify(confirmRes)} `
          + `사유에계정언급=${mentionsAccount} 픽스처publishes ${beforePub}→${afterPub}(같아야) promotedAt=${JSON.stringify(after?.promotedAt)}(없어야)`)
      } catch (e) { fail('DP6-ACC', '계정 드리프트', e.message) }
    } else skip('DP6-ACC', '계정 드리프트', '--only 로 제외됨')

    // ── DP1 + DP4: 재생성 없음 + 정확히 1건 게시 (전체 위저드 완주) ─────────────────────────
    if (wants('DP1') && igHttps) {
      try {
        const before = await getWfById(shell, 'dp1')
        const beforePub = fixture.state.publishes.length
        llm.setScript(wizardScript('art_dp1', before.caption))
        const clicked = await clickSelector(shell, cardSel('dp1', ' .ai-social-promote'))
        const panelOpened = await pollExpr(shell, `(() => !!document.querySelector(${JSON.stringify(cardSel('dp1', ' [data-testid="social-promote-go"]'))}))()`,
          (v) => v === true, { timeoutMs: 6_000, label: 'DP1 확정 패널 열림' }).catch(() => false)
        const confirmClicked = await clickSelector(shell, cardSel('dp1', ' [data-testid="social-promote-go"]'))
        const pubTaskId = await waitForPublishTaskId(shell, 'dp1', 25_000).catch((e) => { throw new Error(`publish 작업 미생성: ${e.message}`) })
        const terminal = await driveTaskToTerminal(shell, pubTaskId, { timeoutMs: 60_000 })
        await sleep(500)
        const after = await getWfById(shell, 'dp1')
        const afterPub = fixture.state.publishes.length
        const pub = fixture.state.publishes[fixture.state.publishes.length - 1]
        const shaMatch = pub && pub.sha256 === shaByWorkflow.dp1
        check('DP1', '재생성 없음 — 승격 게시가 실제로 도착했고 sha256·caption·artifactId·taskIds.generate 가 승격 전과 동일하다',
          clicked && panelOpened && confirmClicked && !!pub && shaMatch
            && after?.artifactId === before?.artifactId && after?.taskIds?.generate === before?.taskIds?.generate
            && pub?.caption === before?.caption,
          `terminal.state=${terminal?.state} sha256 비교 — 산출물(시드)=${shaByWorkflow.dp1} · 픽스처가 받은 파일=${pub?.sha256} · 일치=${shaMatch} `
          + `artifactId ${before?.artifactId}→${after?.artifactId} genTaskId ${before?.taskIds?.generate}→${after?.taskIds?.generate} `
          + `캡션일치=${pub?.caption === before?.caption}`)
        const dp4Delta = afterPub - beforePub
        check('DP4', '확정하면 픽스처에 정확히 1건만 새로 도착한다',
          dp4Delta === 1, `픽스처publishes ${beforePub}→${afterPub}(delta=${dp4Delta}, 정확히 +1 이어야)`)
        console.log(`  [대조] 같은 실행 안에서 DP2(취소) delta=${JSON.stringify(dp2Delta)}(0 이어야) vs DP4(확정) delta=${dp4Delta}(+1 이어야) `
          + `— ${dp2Delta === 0 && dp4Delta === 1 ? '검사가 실제로 차이를 구분한다(성립)' : '⚠ 대조가 성립하지 않음 — 검출력 의심'}`)
      } catch (e) { fail('DP1', '재생성 없음', e.message); fail('DP4', '정확히 1건', e.message) }
    } else {
      const reason = igHttps ? '--only 로 제외됨' : '격리 인터셉터 없음(openssl 미확인) — 안전을 위해 SKIP'
      skip('DP1', '재생성 없음', reason); skip('DP4', '정확히 1건', reason)
    }

    // ── DP5: 중복 클릭·재전송해도 1건 이하 ──────────────────────────────────────────────────
    if (wants('DP5') && igHttps) {
      try {
        const beforePub = fixture.state.publishes.length
        const wf0 = await getWfById(shell, 'dp5')
        llm.setScript(wizardScript('art_dp5', wf0.caption))
        const clicked = await clickSelector(shell, cardSel('dp5', ' .ai-social-promote'))
        await pollExpr(shell, `(() => !!document.querySelector(${JSON.stringify(cardSel('dp5', ' [data-testid="social-promote-go"]'))}))()`,
          (v) => v === true, { timeoutMs: 6_000, label: 'DP5 확정 패널 열림' })
        // 연타 — 같은 클릭 틱에서 버튼을 두 번 누른다(disabled 로 넘어가기 전에 두 핸들러가 같은
        // React 클로저의 토큰으로 confirm 을 두 번 보내는 것이 "같은 토큰 재전송"과 동형이다).
        const doubleClickResult = await evaluate(shell, `(() => {
          const btn = document.querySelector(${JSON.stringify(cardSel('dp5', ' [data-testid="social-promote-go"]'))})
          if (!btn) return { ok: false, reason: 'no-btn' }
          btn.click(); btn.click()
          return { ok: true }
        })()`)
        const pubTaskId = await waitForPublishTaskId(shell, 'dp5', 25_000)
        const terminal = await driveTaskToTerminal(shell, pubTaskId, { timeoutMs: 60_000 })
        await sleep(500)
        const afterPub1 = fixture.state.publishes.length
        // 추가 재전송 — 이미 승격된(promotedAt) 워크플로에 새로 prepare+confirm 을 시도해도 거부되고
        // 중복 게시가 나지 않는지 본다(ticket 은 1회용이라 옛 토큰 재사용은 애초에 불가능하므로,
        // "승격된 것에 또 올리려는 시도"가 더 실질적인 재전송 시나리오다).
        const rePrep = await callPreparePromote(shell, 'dp5')
        const reConfirm = await callConfirmPromote(shell, 'dp5', 'garbage-resend-token')
        await sleep(500)
        const afterPub2 = fixture.state.publishes.length
        const wfAfter = await getWfById(shell, 'dp5')
        check('DP5', '연타·재전송해도 발행은 1건 이하이고 재전송은 거부된다',
          clicked && doubleClickResult.ok && (afterPub1 - beforePub) <= 1
            && rePrep?.ok === false && reConfirm?.ok === false && afterPub2 === afterPub1
            && !!wfAfter?.promotedAt,
          `terminal.state=${terminal?.state} 연타 후 픽스처publishes ${beforePub}→${afterPub1}(≤+1) `
          + `재전송prepare=${JSON.stringify(rePrep)} 재전송confirm=${JSON.stringify(reConfirm)} `
          + `재전송 후 ${afterPub1}→${afterPub2}(같아야) promotedAt=${JSON.stringify(wfAfter?.promotedAt)}`)
      } catch (e) { fail('DP5', '중복 클릭·재전송', e.message) }
    } else skip('DP5', '중복 클릭·재전송', igHttps ? '--only 로 제외됨' : '격리 인터셉터 없음 — 안전을 위해 SKIP')

    // ── DP7 준비: 확정 전 상태를 남기고 강제 종료 ───────────────────────────────────────────
    let dp7Ready = false
    if (wants('DP7')) {
      try {
        const beforePub = fixture.state.publishes.length
        const clicked = await clickSelector(shell, cardSel('dp7', ' .ai-social-promote'))
        const panelOpened = await pollExpr(shell, `(() => !!document.querySelector(${JSON.stringify(cardSel('dp7', ' [data-testid="social-promote-go"]'))}))()`,
          (v) => v === true, { timeoutMs: 6_000, label: 'DP7 확정 패널 열림' }).catch(() => false)
        check('DP7-SETUP', '확정 패널을 열어 둔 채(확정은 누르지 않음) 강제 종료 준비',
          clicked && panelOpened, `클릭=${clicked} 패널열림=${panelOpened}`)
        dp7Ready = clicked && panelOpened
        await hardKill(child)
        await waitForPortFree(args.port).catch(() => {})
        const diskRaw = JSON.parse(fs.readFileSync(path.join(profileDir, 'ai-social-workflows.json'), 'utf-8'))
        const diskWf = diskRaw.workflows.find((w) => w.id === 'dp7')
        check('DP7', '확정 전 강제 종료 — 디스크에 promotedAt 이 없고, 픽스처에 아무것도 도착하지 않았다',
          !diskWf?.promotedAt && fixture.state.publishes.length === beforePub,
          `디스크 promotedAt=${JSON.stringify(diskWf?.promotedAt)}(없어야) 픽스처publishes ${beforePub}→${fixture.state.publishes.length}(같아야)`)
      } catch (e) { fail('DP7-SETUP', 'DP7 준비', e.message); fail('DP7', '확정 전 재시작', e.message) }
    } else skip('DP7', '확정 전 재시작', '--only 로 제외됨')

    // ═══════════════════════════════════ 2차 부팅(DP7 이후) ═════════════════════════════════
    if (wants('DP7') || wants('DP8')) {
      await boot('boot2')
      await afterBootUi('boot2')
    }

    if (wants('DP7')) {
      try {
        const beforePub = fixture.state.publishes.length
        const before = await getWfById(shell, 'dp7')
        // 옛 토큰(존재한 적 없는 문자열이라도 "확인 없음" 거부의 성질은 동일 — 메모리 티켓은
        // 재시작으로 사라졌으므로 어떤 토큰을 넣어도 "유효한 확인이 없습니다"로 거부되어야 한다)
        const resumeConfirm = await callConfirmPromote(shell, 'dp7', 'old-token-from-before-restart')
        check('DP7-RESUME', '재시작 뒤 옛 확정(티켓)은 사라져 confirm 이 거부되고, 초안은 온전하며, 아무것도 나가지 않았다',
          resumeConfirm?.ok === false && before?.stage === 'review' && !before?.promotedAt
            && fixture.state.publishes.length === beforePub,
          `재시작후confirm=${JSON.stringify(resumeConfirm)} stage=${before?.stage} promotedAt=${JSON.stringify(before?.promotedAt)} `
          + `픽스처publishes=${fixture.state.publishes.length}(${beforePub}와 같아야)`)
      } catch (e) { fail('DP7-RESUME', 'DP7 재시작 확인', e.message) }
    }

    // ── DP8: 확정 후 죽으면 모름으로 남고 중복 게시 안 함 ───────────────────────────────────
    if (wants('DP8') && igHttps) {
      try {
        const beforePub = fixture.state.publishes.length
        const wf0 = await getWfById(shell, 'dp8')
        llm.setScript(wizardScript('art_dp8', wf0.caption))
        igControl.holdPublish = true
        const clicked = await clickSelector(shell, cardSel('dp8', ' .ai-social-promote'))
        await pollExpr(shell, `(() => !!document.querySelector(${JSON.stringify(cardSel('dp8', ' [data-testid="social-promote-go"]'))}))()`,
          (v) => v === true, { timeoutMs: 6_000, label: 'DP8 확정 패널 열림' })
        const confirmClicked = await clickSelector(shell, cardSel('dp8', ' [data-testid="social-promote-go"]'))
        check('DP8-SETUP', '확정 클릭 완료(게시 시작) — 이제 서버가 요청을 받는 순간을 기다린다',
          clicked && confirmClicked, `클릭=${clicked} 확정클릭=${confirmClicked}`)
        // 서버가 실제로 파일을 받는 순간(=상대가 "글이 나갔다"고 알 수 있는 유일한 사실)까지 대기 후
        // 응답이 오기 전에 강제 종료한다 — "서버는 받았는데 클라이언트는 성공 신호를 못 받았다".
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline && fixture.state.publishes.length === beforePub) await sleep(100)
        const receivedByServer = fixture.state.publishes.length > beforePub
        await hardKill(child)
        await waitForPortFree(args.port).catch(() => {})
        const held = igHttps.heldCount()
        igHttps.releaseHeld()
        check('DP8', '서버가 파일을 받은 직후(응답 전) 강제 종료 — 서버에는 1건 기록되고 클라이언트는 확인받지 못했다',
          receivedByServer && held >= 1, `서버수신=${receivedByServer} 응답보류중이던요청=${held}`)
      } catch (e) { fail('DP8-SETUP', 'DP8 준비', e.message); fail('DP8', '확정 후 강제 종료', e.message) }
    } else skip('DP8', '확정 후 강제 종료', igHttps ? '--only 로 제외됨' : '격리 인터셉터 없음 — 안전을 위해 SKIP')

    // ═══════════════════════════════════ 3차 부팅(DP8 이후) ═════════════════════════════════
    if (wants('DP8') || wants('DP10')) {
      await boot('boot3')
      await afterBootUi('boot3')
    }

    if (wants('DP8')) {
      try {
        const beforePub = fixture.state.publishes.length
        const wf = await pollExpr(shell, `(async () => {
          const list = await window.browserAPI.ai.socialList()
          const w = list.find(x => x.id === 'dp8')
          return JSON.stringify(w ? { publishUncertain: !!w.publishUncertain, receiptStatus: w.receipt?.status ?? null, stage: w.stage } : null)
        })()`, (v) => v !== JSON.stringify(null), { timeoutMs: 15_000, label: 'DP8 재시작 후 워크플로 조회' }).then(JSON.parse)
        const prep = await callPreparePromote(shell, 'dp8')
        check('DP8-RESUME', '재시작 뒤 "모름"(publishUncertain/unverified)으로 남고, 다시 승격을 시도해도 거부되며, 중복 게시가 나지 않는다',
          (wf.publishUncertain === true || wf.receiptStatus === 'unverified') && prep?.ok === false
            && fixture.state.publishes.length === beforePub,
          `재시작후상태=${JSON.stringify(wf)} 재승격시도=${JSON.stringify(prep)} 픽스처publishes=${fixture.state.publishes.length}(${beforePub}와 같아야)`)
      } catch (e) { fail('DP8-RESUME', 'DP8 재시작 확인', e.message) }
    }

    // ── DP10: 완료된 초안 승격 + 지난 기록 보존 ─────────────────────────────────────────────
    if (wants('DP10') && igHttps) {
      try {
        igControl.holdPublish = false
        const before = await getWfById(shell, 'dp10')
        const beforePub = fixture.state.publishes.length
        llm.setScript(wizardScript('art_dp10', before.caption))
        const cardBefore = await readCardState(shell, 'dp10')
        const clicked = await clickSelector(shell, cardSel('dp10', ' .ai-social-promote'))
        await pollExpr(shell, `(() => !!document.querySelector(${JSON.stringify(cardSel('dp10', ' [data-testid="social-promote-go"]'))}))()`,
          (v) => v === true, { timeoutMs: 6_000, label: 'DP10 확정 패널 열림' })
        const confirmClicked = await clickSelector(shell, cardSel('dp10', ' [data-testid="social-promote-go"]'))
        // 승격 **전** 의 옛 초안 작업 id 는 제외한다 — 새로 만들어진 게시 작업을 기다려야 한다.
        const pubTaskId = await waitForPublishTaskId(shell, 'dp10', 25_000, cardBefore?.publishTaskId ?? before.taskIds?.publish ?? null)
        const terminal = await driveTaskToTerminal(shell, pubTaskId, { timeoutMs: 60_000 })
        await sleep(500)
        const after = await getWfById(shell, 'dp10')
        const afterPub = fixture.state.publishes.length
        const priorHasOld = Array.isArray(after?.priorReceipts)
          && after.priorReceipts.some((r) => r.evidence === before.receipt.evidence && r.status === 'draft')
        check('DP10', '완료된 초안(stage:done, receipt.status:draft)을 승격 — 실제 게시 1건 + 옛 초안 영수증이 priorReceipts 에 보존',
          cardBefore.found === true && clicked && confirmClicked && afterPub - beforePub === 1
            && priorHasOld && after?.receipt?.status !== 'draft',
          `terminal.state=${terminal?.state} 픽스처publishes ${beforePub}→${afterPub}(정확히 +1) `
          + `priorReceipts 에 옛 draft 보존=${priorHasOld} 새 receipt.status=${after?.receipt?.status}(draft 아니어야)`)
      } catch (e) { fail('DP10', '완료된 초안 승격', e.message) }
    } else skip('DP10', '완료된 초안 승격', igHttps ? '--only 로 제외됨' : '격리 인터셉터 없음 — 안전을 위해 SKIP')
  } finally {
    try { shell?.close() } catch { /* ignore */ }
    try { child?.kill() } catch { /* ignore */ }
    if (child?.pid) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ } }
    await sleep(500)
    try { await llm.close() } catch { /* ignore */ }
    try { await igHttps?.close() } catch { /* ignore */ }
    try { await fixture.close() } catch { /* ignore */ }
  }

  const pass = results.filter((r) => r.status === 'PASS').length
  const fails = results.filter((r) => r.status === 'FAIL').length
  const skips = results.filter((r) => r.status === 'SKIP').length
  writeJson(path.join(args.out, 'results.json'), { at: new Date().toISOString(), pass, fail: fails, skip: skips, results })
  console.log(`\n===== 실제 숫자 요약(팀장 요청) =====`)
  console.log(`픽스처 /state 최종 publishes 총 건수: ${fixture.state.publishes.length}`)
  console.log(`전체 publishes 상세: ${JSON.stringify(fixture.state.publishes.map((p) => ({ id: p.id, bytes: p.bytes, sha256: p.sha256, caption: p.caption, viaHost: p.viaHost })), null, 2)}`)
  // 각본이 페이지를 몰지 못한 것은 **하네스 결함**이다 — 제품 결함으로 읽히지 않게 크게 찍는다.
  if (scriptFaults.length) {
    console.log(`\n⚠ 하네스 각본 결함 ${scriptFaults.length}건 — 관찰에서 못 찾은 라벨: ${[...new Set(scriptFaults)].join(', ')}`)
    console.log('   (이 경우의 FAIL 은 제품이 아니라 각본이 위저드를 끝까지 몰지 못한 것이다 — 각본을 먼저 고쳐라.)')
  }
  console.log(`\n초안 승격(draft promotion): ${pass} PASS · ${fails} FAIL · ${skips} SKIP`)
  process.exit(fails > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
