// 자동 게시 선승인(AutoPublishGrant) 판정 검증 — 앱 없이 도는 순수 검사.
//
// 왜 상설인가: 여기서 지키는 것은 **"사용자가 승인한 범위 안에서만 확인 없이 게시한다"** 이다.
// 이 판정이 느슨해지면 사용자가 승인하지 않은 계정·플랫폼·건수로 **되돌릴 수 없는 게시**가 나간다.
// 반대로 너무 조이면 사용자가 "한 번 맡기고 끝까지" 를 고른 의미가 사라진다(매번 확인 클릭).
// 그래서 양방향으로 본다 — 허용돼야 할 것은 허용되고, 거부돼야 할 것은 거부되는가.
//
// 이 파일은 판정 규칙만 본다. 실제 게시 흐름(작업 생성·산출물 복사·업로드)은
// build/verify-social-pipeline-cdp.mjs 가 실제 앱으로 검증한다.

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-autopub-'))

// social-workflow 는 electron(app) 과 설정을 끌어온다 — 파일 경로만 임시 디렉터리로 돌려주면 충분하다.
const Module = require('module')
const origLoad = Module._load
Module._load = function (req, ...rest) {
  if (req === 'electron') {
    return {
      app: {
        getPath: () => root,
        getVersion: () => '0.0.0-test',
        getName: () => 'ezbrowser-test',
        on: () => {}, whenReady: () => Promise.resolve(), isPackaged: false,
      },
      ipcMain: { handle: () => {}, on: () => {} },
      safeStorage: { isEncryptionAvailable: () => false },
    }
  }
  return origLoad.call(this, req, ...rest)
}

const W = require(path.join(REPO, 'app/dist/main/features/ai/social-workflow.js'))

let pass = 0, fail = 0
const results = []
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS', name) } else { fail++; console.log('  FAIL', name, detail) }
  results.push({ name, ok: !!cond, detail: cond ? '' : String(detail).slice(0, 300) })
}

// ===== 선승인 만들기 — 입력 검증 =====

t('계정을 지정하지 않으면 선승인이 만들어지지 않는다',
  W.grantAutoPublish({ platform: 'instagram', accounts: [], maxPosts: 3, minutes: 30 }) === null)
t('건수가 0 이면 만들어지지 않는다',
  W.grantAutoPublish({ platform: 'instagram', accounts: ['me'], maxPosts: 0, minutes: 30 }) === null)
t('유효 시간이 0 이면 만들어지지 않는다',
  W.grantAutoPublish({ platform: 'instagram', accounts: ['me'], maxPosts: 3, minutes: 0 }) === null)
t('플랫폼이 이상하면 만들어지지 않는다',
  W.grantAutoPublish({ platform: 'myspace', accounts: ['me'], maxPosts: 3, minutes: 30 }) === null)

const grant = W.grantAutoPublish({ platform: 'instagram', accounts: ['me'], maxPosts: 2, minutes: 30 })
t('정상 입력이면 선승인이 만들어진다', !!grant && grant.maxPosts === 2, JSON.stringify(grant))
t('선승인에 기한이 박힌다', !!grant && grant.expiresAt > Date.now())
t('건수 상한(50)을 넘지 못한다',
  W.grantAutoPublish({ platform: 'instagram', accounts: ['me'], maxPosts: 9999, minutes: 30 }).maxPosts === 50)
t('유효 시간 상한(24시간)을 넘지 못한다', (() => {
  const g = W.grantAutoPublish({ platform: 'instagram', accounts: ['me'], maxPosts: 1, minutes: 99999 })
  return g.expiresAt - g.createdAt <= 24 * 60 * 60 * 1000
})())

// 판정에 쓸 선승인을 다시 세팅(위 상한 테스트가 덮어썼으므로)
const G = W.grantAutoPublish({ platform: 'instagram', accounts: ['me'], maxPosts: 2, minutes: 30 })

// 선승인 이후에 만들어진, 범위에 딱 맞는 워크플로 — 이것이 "허용돼야 하는" 기준선이다.
const base = () => ({
  id: 'wf-' + Math.random().toString(36).slice(2),
  params: { service: 'genspark', platform: 'instagram', prompt: 'p', mode: 'publish', tabId: 't', windowId: null, account: 'me' },
  stage: 'review',
  taskIds: { generate: 'gen-1' },
  artifactId: 'art-1',
  caption: '멋진 사진입니다',
  createdAt: G.createdAt + 1000,
  updatedAt: G.createdAt + 1000,
})

// ===== 양성 — 범위 안이면 확인 없이 게시한다 =====
// (이게 없으면 아래 부정 검사들은 "전부 막혀서" 통과한 것과 구분되지 않는다.)
const okV = W.autoPublishVerdict(base())
t('범위 안이면 자동 게시 허용(양성 대조)', okV.ok === true, JSON.stringify(okV))

// ===== 부정 — 하나라도 어긋나면 사용자 확인으로 남는다 =====
const deny = (name, patch, expectWhy) => {
  const wf = { ...base(), ...patch }
  const v = W.autoPublishVerdict(wf)
  t(name, v.ok === false && (!expectWhy || v.why.includes(expectWhy)), JSON.stringify(v))
}

deny('초안 모드는 자동 게시하지 않는다', { params: { ...base().params, mode: 'draft' } }, '초안')
deny('승인한 계정이 아니면 자동 게시하지 않는다', { params: { ...base().params, account: '다른계정' } }, '계정')
deny('계정이 비어 있으면(미지정) 승인 계정과 다르므로 거부', { params: { ...base().params, account: '' } }, '계정')
deny('승인한 플랫폼이 아니면 자동 게시하지 않는다', { params: { ...base().params, platform: 'tiktok' } }, '플랫폼')
deny('선승인 이전에 만들어진 작업은 대상이 아니다', { createdAt: G.createdAt - 1 }, '이전')
deny('이미지 후보가 모호했으면 자동 게시하지 않는다', { artifactAmbiguous: true }, '여럿')
deny('캡션 생성이 실패했으면 자동 게시하지 않는다', { captionError: '모델 오류' }, '캡션')
deny('캡션이 비어 있으면 자동 게시하지 않는다', { caption: '   ' }, '캡션')
deny('산출물이 없으면 자동 게시하지 않는다', { artifactId: undefined }, '산출물')
deny('이미 영수증이 있으면(게시됨) 다시 게시하지 않는다', { receipt: { evidence: 'x', at: Date.now() } }, '이미')
deny('확인 단계가 아니면 자동 게시하지 않는다', { stage: 'generate' }, '단계')

// 재시작 뒤 재시도 방지 — 이미 이 선승인으로 진행한 워크플로는 다시 자동 게시되지 않는다.
const consumedWf = base()
G.consumed.push(consumedWf.id)
deny2: {
  const v = W.autoPublishVerdict(consumedWf)
  t('이미 이 선승인으로 진행한 작업은 다시 자동 게시하지 않는다(재시작 재시도 방지)',
    v.ok === false && v.why.includes('이미'), JSON.stringify(v))
}

// 건수 소진
G.used = G.maxPosts
t('승인 건수를 다 쓰면 더 자동 게시하지 않는다', (() => {
  const v = W.autoPublishVerdict(base())
  return v.ok === false && v.why.includes('건수')
})(), JSON.stringify(W.autoPublishVerdict(base())))
G.used = 0

// 기한 경과
const savedExpiry = G.expiresAt
G.expiresAt = Date.now() - 1
t('기한이 지나면 자동 게시하지 않는다', W.autoPublishVerdict(base()).why.includes('기한'))
G.expiresAt = savedExpiry

// 철회
W.revokeAutoPublish()
t('사용자가 철회하면 즉시 자동 게시하지 않는다', W.autoPublishVerdict(base()).why.includes('철회'))

// 선승인 자체가 없을 때(기본 상태) — 기본값은 언제나 "확인 후 게시" 다.
const W2 = (() => {
  // 새 모듈 인스턴스를 얻기 위해 require 캐시를 비운다(선승인이 모듈 상태이므로).
  const p = require.resolve(path.join(REPO, 'app/dist/main/features/ai/social-workflow.js'))
  delete require.cache[p]
  return require(p)
})()
t('선승인이 없으면 기본은 확인 후 게시', (() => {
  const v = W2.autoPublishVerdict(base())
  return v.ok === false && v.why.includes('선승인')
})())

// ===== 배선 — 판정이 맞아도 **실제로 게시 단계로 넘어가지 않으면** 의미가 없다 =====
//
// 위 검사는 "허용해야 하는가" 만 본다. 사용자가 보는 동작은 "캡션이 나온 뒤 클릭 없이 게시가 시작되는가" 다.
// 그래서 **공개 API 경로 그대로** 돌린다(startImagePost → 생성 완료 → 확인 → 캡션 → 게시).
// 실제 브라우저 조작·LLM 호출만 가짜로 바꿔 끼우고, 판정·전이는 제품 코드가 하게 둔다.
// (테스트 전용 export 를 제품에 만들지 않는다 — 그건 검사를 위해 제품을 바꾸는 것이다.)
{
  const resolve = (rel) => require.resolve(path.join(REPO, 'app/dist/main/features/ai', rel))
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('dist', 'main', 'features', 'ai'))) delete require.cache[k]
  }

  const created = []          // 만들어진 작업들(지시문 포함)
  const rt = require(resolve('task-runtime.js'))
  let genState = 'running'
  rt.createTask = (o) => { const task = { id: 'task-' + (created.length + 1), instruction: o.instruction }; created.push(task); return task }
  rt.startTask = () => {}
  rt.setTaskInstruction = () => true
  rt.cancelTask = () => {}
  rt.deleteTask = () => {}
  // 첫 작업(생성)만 상태를 준다 — 게시 작업은 아직 진행 중으로 둔다.
  rt.getTask = (id) => (id === 'task-1' ? { id, state: genState, checkpoint: {}, result: '' } : { id, state: 'running', checkpoint: {} })

  const art = require(resolve('artifacts.js'))
  const onlyArtifact = { id: 'art-1', bytes: 100, format: 'png', sha256: 'abc', width: 512, height: 512 }
  art.listArtifacts = () => [onlyArtifact]     // 후보 1개 = 모호하지 않음
  art.getArtifact = () => onlyArtifact
  art.resolveArtifactPath = () => path.join(root, 'fake.png')
  art.importDownloadedFile = () => ({ ok: true, meta: { id: 'copy-1' } })

  let captionOutcome = { ok: true, text: '정상 캡션' }
  const prov = require(resolve('providers.js'))
  prov.chatOnce = () => ({
    promise: captionOutcome.ok ? Promise.resolve(captionOutcome.text) : Promise.reject(new Error('모델 오류')),
    cancel: () => {},
  })
  prov.isCliProvider = () => true
  prov.cliPathSettingKey = () => 'claudeCodePath'

  const W3 = require(resolve('social-workflow.js'))
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const params = { service: 'genspark', platform: 'instagram', prompt: '고양이 그림', mode: 'publish', account: 'me', tabId: 'tab-1', windowId: null }

  // 생성 작업이 끝난 상태를 알리고(제품이 reconcile 로 확인 단계까지 스스로 간다) 캡션을 기다린다.
  const runOnce = async () => {
    created.length = 0
    genState = 'running'
    const wf = W3.startImagePost(params)
    genState = 'completed'
    rt.taskEvents.emit('changed')
    await wait(50)
    return W3.listWorkflows().find((x) => x.id === wf.id)
  }

  // ① 선승인 있음 + 후보 1개 + 캡션 성공 → 확인 클릭 없이 게시가 시작된다
  W3.grantAutoPublish({ platform: 'instagram', accounts: ['me'], maxPosts: 2, minutes: 30 })
  const a = await runOnce()
  t('선승인 범위 안이면 캡션 뒤 게시가 실제로 시작된다(배선)',
    a?.stage === 'publish' && a?.autoPublished === true && !!a?.taskIds?.publish,
    JSON.stringify({ stage: a?.stage, auto: a?.autoPublished, ids: a?.taskIds }))
  t('자동 진행이 선승인 건수를 실제로 소비한다', W3.getAutoPublishGrant()?.used === 1, JSON.stringify(W3.getAutoPublishGrant()))
  t('게시 작업 지시문에 캡션이 실린다', (created[1]?.instruction ?? '').includes('정상 캡션'), String(created[1]?.instruction).slice(0, 120))

  // ② 캡션 실패 → 게시하지 않고 사유와 함께 대기(프롬프트를 캡션으로 올리지 않는다)
  captionOutcome = { ok: false }
  const b = await runOnce()
  t('캡션이 실패하면 게시가 시작되지 않는다(배선)', b?.stage === 'review' && !b?.taskIds?.publish, JSON.stringify({ stage: b?.stage, ids: b?.taskIds }))
  t('캡션 실패 시 사유가 남는다', !!b?.captionError, String(b?.captionError))
  t('캡션 실패 시 프롬프트를 캡션으로 대체하지 않는다', !b?.caption, String(b?.caption))

  // ③ 철회 뒤에는 캡션이 성공해도 게시가 시작되지 않는다(부정 대조)
  captionOutcome = { ok: true, text: '정상 캡션2' }
  W3.revokeAutoPublish()
  const c = await runOnce()
  t('철회 뒤에는 캡션이 나와도 게시가 시작되지 않는다(부정 대조)',
    c?.stage === 'review' && !c?.taskIds?.publish, JSON.stringify({ stage: c?.stage, ids: c?.taskIds }))
  t('철회 뒤에도 캡션 자체는 채워져 사용자가 승인할 수 있다', c?.caption === '정상 캡션2', String(c?.caption))
}

const summary = `\n합계 PASS ${pass} / FAIL ${fail}`
console.log(summary)

const outDir = path.join(REPO, 'verify-out', 'auto-publish')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), pass, fail, results }, null, 2))
fs.rmSync(root, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
