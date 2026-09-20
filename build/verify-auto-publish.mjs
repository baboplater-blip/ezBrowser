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

// 계정 칸을 **손으로 고친** 작업은 선승인 범위 안이어도 확인을 받는다.
// 왜: 범위 밖 계정으로 시작한 작업의 계정을 범위 안 계정으로 고치면, 텍스트 한 칸 편집만으로
// 그 작업이 자동 게시 대상이 된다 — 사용자가 "게시해도 좋다" 를 누른 적이 없는데 글이 나간다.
// (양성 대조는 바로 위 okV — 같은 워크플로가 **고치지 않았을 때는** 허용된다.)
deny('계정을 손으로 고친 작업은 선승인이 있어도 확인을 받는다', { accountEditedAt: Date.now() }, '직접 고친')
t('계정 편집 표시는 다른 조건이 모두 맞아도 단독으로 막는다(양성 대조와 한 쌍)', (() => {
  const clean = W.autoPublishVerdict(base())              // 같은 재료, 편집 표시만 없음
  const edited = W.autoPublishVerdict({ ...base(), accountEditedAt: Date.now() })
  return clean.ok === true && edited.ok === false
})(), JSON.stringify({ clean: W.autoPublishVerdict(base()), edited: W.autoPublishVerdict({ ...base(), accountEditedAt: Date.now() }) }))

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

  const created = []          // 만들어진 작업들(지시문 포함 · 어느 탭으로 만들었는지)

  // 탭은 진짜 브라우저가 필요하므로 최소 대역만 세운다. **무엇을 검사하려는지**가 여기에 있다 —
  // 게시 단계가 탭을 게시 사이트로 실제로 옮기는가(navigations), 그리고 옮기는 동안 끼어든
  // 취소·철회·중복 승인에도 게시 작업이 0건으로 남는가.
  const tabs = require(resolve('../../tabs/tab-service.js'))
  const navigations = []      // 우리 코드가 실제로 부른 loadURL 기록
  // tabId -> { url, gone, slow, workspaceId, key }
  // key = 복원 안정 키(tab-service 의 restoreKey). 재시작을 넘어 **바로 그 탭**을 가리키는 값이라
  // 게시 준비가 옛 탭 id 대신 이것으로 대상을 확정한다(2026-09-20).
  const tabState = new Map()
  const setTab = (id, url, extra = {}) => {
    tabState.set(id, { url, gone: false, slow: false, workspaceId: 'ws-1', key: `tk-${id}`, ...extra })
    return id
  }
  let pendingNav = null       // slow 탭의 로드 완료를 테스트가 직접 풀어준다
  const fakeWc = (id) => {
    const st = tabState.get(id)
    if (!st || st.gone) return null
    return {
      isDestroyed: () => !!tabState.get(id)?.gone,
      getURL: () => tabState.get(id)?.url ?? '',
      isLoading: () => false,
      once: () => {},
      loadURL: (u) => {
        navigations.push({ tabId: id, url: u })
        const cur = tabState.get(id)
        // 리다이렉트 흉내: landsAt 이 있으면 최종 URL 이 그것이 된다.
        const final = cur?.landsAt ?? u
        if (cur?.slow) return new Promise((res) => { pendingNav = () => { cur.url = final; res() } })
        if (cur) cur.url = final
        return Promise.resolve()
      },
    }
  }
  tabs.getWebContentsByTabId = (id) => fakeWc(id)
  tabs.getTab = (id) => {
    const st = tabState.get(id)
    return st && !st.gone ? { id, url: st.url, workspaceId: st.workspaceId } : undefined
  }
  tabs.findTabByRestoreKey = (key) => {
    for (const [id, st] of tabState) {
      if (st.key === key && !st.gone) return { id, windowId: 'win-1', workspaceId: st.workspaceId }
    }
    return null
  }
  const wins = require(resolve('../../windows/window-service.js'))
  wins.findWindowByRestoreKey = () => null     // 창 키는 이 검사의 관심사가 아니다(탭 대상만 본다)
  tabs.createTab = (o) => {
    if (o.workspaceId === '(없음)') throw new Error('워크스페이스 없음')
    const id = 'tab-new'
    setTab(id, o.url ?? 'about:blank')
    navigations.push({ tabId: id, url: o.url, created: true })
    return { id }
  }

  const rt = require(resolve('task-runtime.js'))
  let genState = 'running'
  rt.createTask = (o) => {
    const task = {
      id: 'task-' + (created.length + 1),
      instruction: o.instruction,
      tabId: o.tabId,
      allowedHosts: o.budget?.allowedHosts ?? [],
      // 체크포인트는 제품의 createTask 가 **그 탭의 실제 URL** 로 잡는다(여기선 스텁이라 직접 읽어 흉내).
      tabUrl: tabState.get(o.tabId)?.url ?? '',
    }
    created.push(task)
    return task
  }
  // 실제 startTask 는 StartResult(`{ ok, error? }`)를 돌려준다. 스텁이 아무것도 안 돌려주면
  // 호출부가 결과를 확인하는 순간 예외가 나고, 그 예외가 게시 준비 실패로 둔갑해 **선승인 건수
  // 환불**까지 일으킨다(이 스텁의 결함이 제품 결함처럼 보였다 — 2026-09-19).
  rt.startTask = () => ({ ok: true })
  rt.setTaskInstruction = () => true
  rt.cancelTask = () => {}
  rt.deleteTask = () => {}
  // 첫 작업(생성)만 상태를 준다 — 게시 작업은 아직 진행 중으로 둔다.
  let genWorkspaceId = 'ws-1'
  // 생성 작업의 체크포인트가 기억하는 **대상 탭의 복원 안정 키**. 게시 준비는 옛 탭 id 가 아니라
  // 이 키로 대상을 되찾는다 — 재시작 뒤 같은 id 가 다른 탭을 가리키기 때문이다.
  let genTabKey = 'tk-tab-1'
  rt.getTask = (id) => (id === 'task-1'
    ? { id, state: genState, checkpoint: { workspaceId: genWorkspaceId, tabKey: genTabKey, windowKey: null }, result: '' }
    : { id, state: 'running', checkpoint: { workspaceId: genWorkspaceId, tabKey: genTabKey, windowKey: null } })

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
    navigations.length = 0
    pendingNav = null
    setTab('tab-1', 'about:blank')          // 새 탭에서 시작하는 실제 흐름과 같게 둔다
    genState = 'running'
    const wf = W3.startImagePost(params)
    genState = 'completed'
    rt.taskEvents.emit('changed')
    // 게시 준비(탭 이동)는 비동기다 — 넉넉히 기다린다(스텁이라 실제로는 즉시 끝난다).
    await wait(120)
    return W3.listWorkflows().find((x) => x.id === wf.id)
  }

  /** 준비가 느린(로드가 안 끝난) 상태에서 멈춰 세운 뒤, 테스트가 경합을 끼워 넣고 풀어준다. */
  const runPaused = async () => {
    created.length = 0
    navigations.length = 0
    pendingNav = null
    setTab('tab-1', 'about:blank', { slow: true })
    genState = 'running'
    const wf = W3.startImagePost(params)
    genState = 'completed'
    rt.taskEvents.emit('changed')
    await wait(60)                           // 캡션 → 게시 준비 진입까지
    return wf
  }
  const release = async () => { pendingNav?.(); pendingNav = null; await wait(80) }
  const cur = (id) => W3.listWorkflows().find((x) => x.id === id)
  // created[0] 은 생성 작업이다 — 그 뒤에 만들어진 것이 게시 작업이다(0건이어야 할 때가 많다).
  const publishTasks = () => created.slice(1)

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

  // ===== 게시 단계 탭 전환 — 앱이 옮기는가, 그리고 옮기는 도중의 경합에서 게시가 0 또는 1 인가 =====
  //
  // 예전에는 "인스타그램이 아니면 이동하세요" 라는 **지시문만** 주고 탭은 그대로 뒀다. 그래서 작업의
  // 체크포인트가 생성 사이트(about:blank)로 잡혀 재바인딩 가드에 걸렸고, 실모델 R-SNS 가 모델을 한 번도
  // 부르지 못한 채 waiting-user 로 멈췄다(2회 재현). 여기서 지키는 것은 그 회귀와, 이동이 비동기가 되며
  // 새로 생긴 경합(취소·철회·기한 만료·중복 승인·탭 소멸·리다이렉트)에서 **게시가 두 번 나가지 않는 것**이다.
  const freshGrant = () => W3.grantAutoPublish({ platform: 'instagram', accounts: ['me'], maxPosts: 2, minutes: 30 })

  // ④ 양성 — 앱이 탭을 게시 사이트로 옮기고, 그 탭·그 URL 로 작업을 만든다
  freshGrant()
  const d = await runOnce()
  const dPub = publishTasks()[0]
  t('게시 단계가 탭을 게시 사이트로 실제로 옮긴다(앱이 옮긴다 — 모델 지시문에 의존하지 않는다)',
    navigations.some((n) => n.tabId === 'tab-1' && n.url === 'https://www.instagram.com/'),
    JSON.stringify(navigations))
  t('게시 작업의 탭·체크포인트가 이동한 실제 페이지와 일치한다(about:blank 로 잡히지 않는다)',
    dPub?.tabId === 'tab-1' && dPub?.tabUrl === 'https://www.instagram.com/',
    JSON.stringify({ tabId: dPub?.tabId, tabUrl: dPub?.tabUrl }))
  t('허용 사이트는 게시 호스트 하나로 유지된다(넓히지 않는다)',
    JSON.stringify(dPub?.allowedHosts) === JSON.stringify(['www.instagram.com']),
    JSON.stringify(dPub?.allowedHosts))
  t('정상 경로에서 게시 작업은 정확히 1건', publishTasks().length === 1, String(publishTasks().length))
  t('정상 경로에서 단계는 publish', d?.stage === 'publish', String(d?.stage))

  // ⑤ 부정 — 이동하는 도중 사용자가 취소하면 게시 작업이 아예 만들어지지 않는다
  freshGrant()
  const e0 = await runPaused()
  const midCancel = publishTasks().length
  W3.cancelWorkflow(e0.id)
  await release()
  t('이동 중 취소하면 게시 작업이 0건이다(게시 0건)',
    midCancel === 0 && publishTasks().length === 0, JSON.stringify({ midCancel, after: publishTasks().length }))
  t('이동 중 취소하면 단계가 cancelled 로 남는다', cur(e0.id)?.stage === 'cancelled', String(cur(e0.id)?.stage))

  // ⑥ 부정 — 이동하는 도중 선승인을 철회하면 게시하지 않고 건수를 돌려준다
  freshGrant()
  const f0 = await runPaused()
  const usedDuring = W3.getAutoPublishGrant()?.used
  W3.revokeAutoPublish()
  await release()
  t('이동 중 선승인을 철회하면 게시 작업이 0건이다', publishTasks().length === 0, String(publishTasks().length))
  t('이동 중 철회되면 실패로 남고 사유가 보인다',
    cur(f0.id)?.stage === 'failed' && (cur(f0.id)?.error ?? '').includes('게시는 진행되지 않았습니다'),
    JSON.stringify({ stage: cur(f0.id)?.stage, error: cur(f0.id)?.error }))
  t('이동 중 철회로 중단하면 선승인 건수를 돌려준다',
    usedDuring === 1 && W3.getAutoPublishGrant()?.used === 0,
    JSON.stringify({ usedDuring, after: W3.getAutoPublishGrant()?.used }))

  // ⑦ 부정 — 이동하는 도중 기한이 지나면 게시하지 않는다
  freshGrant()
  const g0 = await runPaused()
  W3.getAutoPublishGrant().expiresAt = Date.now() - 1000
  await release()
  t('이동 중 선승인 기한이 지나면 게시 작업이 0건이다',
    publishTasks().length === 0 && cur(g0.id)?.stage === 'failed',
    JSON.stringify({ n: publishTasks().length, stage: cur(g0.id)?.stage }))

  // ⑧ 부정 — 이동하는 도중 사용자가 승인 버튼을 또 눌러도 두 번 게시되지 않는다
  freshGrant()
  const h0 = await runPaused()
  const dup = W3.approveAndPublish(h0.id, '또 승인')
  await release()
  t('이동 중 중복 승인은 거부된다', dup?.ok === false, JSON.stringify(dup))
  t('이동 중 중복 승인이 와도 게시 작업은 1건뿐이다', publishTasks().length === 1, String(publishTasks().length))

  // ⑨ 부정 — 다른 호스트로 넘어가면(로그인 리다이렉트 등) 게시하지 않는다. 허용 목록을 넓혀 통과시키지 않는다.
  freshGrant()
  created.length = 0; navigations.length = 0; pendingNav = null
  setTab('tab-1', 'about:blank', { landsAt: 'https://login.example.com/oauth' })
  genState = 'running'
  const i0 = W3.startImagePost(params)
  genState = 'completed'
  rt.taskEvents.emit('changed')
  await wait(150)
  t('게시 사이트가 아닌 곳에 도착하면 게시 작업을 만들지 않는다',
    publishTasks().length === 0 && cur(i0.id)?.stage === 'failed'
    && (cur(i0.id)?.error ?? '').includes('login.example.com'),
    JSON.stringify({ n: publishTasks().length, stage: cur(i0.id)?.stage, err: cur(i0.id)?.error }))

  // ⑩ 탭이 닫힌 경우 — 같은 워크스페이스에 다시 열어 잇는다(로그인 세션 유지). 모르면 진행하지 않는다.
  freshGrant()
  created.length = 0; navigations.length = 0; pendingNav = null
  setTab('tab-1', 'about:blank')
  genState = 'running'
  // 탭을 다시 여는 경로는 창을 알아야 한다 — 실제 흐름에서는 항상 창이 있다.
  const paramsWin = { ...params, windowId: 'win-1' }
  const j0 = W3.startImagePost(paramsWin)
  tabState.get('tab-1').gone = true          // 생성이 끝난 뒤 사용자가 그 탭을 닫았다
  genState = 'completed'
  rt.taskEvents.emit('changed')
  await wait(150)
  const jPub = publishTasks()[0]
  t('게시 탭이 닫혔으면 같은 워크스페이스에 다시 열어 잇는다',
    navigations.some((n) => n.created && n.url === 'https://www.instagram.com/') && jPub?.tabId === 'tab-new',
    JSON.stringify({ navigations, tabId: jPub?.tabId }))

  freshGrant()
  created.length = 0; navigations.length = 0; pendingNav = null
  setTab('tab-1', 'about:blank')
  genWorkspaceId = '(없음)'                   // 어느 세션이었는지 알 수 없다
  genState = 'running'
  const k0 = W3.startImagePost(paramsWin)
  tabState.get('tab-1').gone = true
  genState = 'completed'
  rt.taskEvents.emit('changed')
  await wait(150)
  t('어느 세션이었는지 모르면 다른 세션에 열어 게시하지 않는다(부정 대조)',
    publishTasks().length === 0 && cur(k0.id)?.stage === 'failed',
    JSON.stringify({ n: publishTasks().length, stage: cur(k0.id)?.stage, err: cur(k0.id)?.error }))
  genWorkspaceId = 'ws-1'

  // ===== 재시작 뒤 "그 탭 id" 는 다른 탭이다 (2026-09-20) =====
  //
  // 탭 id(`tab-N`)는 프로세스마다 1부터 다시 발급된다. 그래서 저장된 워크플로의 `params.tabId` 를
  // 그대로 믿고 `loadURL` 하면 **무관한 복원 탭을 게시 사이트로 끌고 간다**. 그 탭이 다른
  // 워크스페이스면 로그인한 계정이 조용히 바뀐 채로 게시된다. 여기서 그 상황을 그대로 재현한다.
  const runPublish = async (p) => {
    freshGrant()
    created.length = 0; navigations.length = 0; pendingNav = null
    genState = 'running'
    const wf = W3.startImagePost(p)
    genState = 'completed'
    rt.taskEvents.emit('changed')
    await wait(150)
    return wf
  }
  const navOf = (id) => navigations.filter((n) => n.tabId === id && !n.created)

  {
    // 재시작을 흉내 낸다: 원래 탭(키 tk-orig)은 사라졌고, 같은 이름의 `tab-1` 은 **다른 사람의 탭**
    // (다른 워크스페이스 = 다른 로그인 세션)이 돼 있다.
    tabState.clear()
    setTab('tab-1', 'https://mail.example/inbox', { workspaceId: 'ws-2', key: 'tk-restored-other' })
    genTabKey = 'tk-orig'
    const wf = await runPublish({ ...params, windowId: 'win-1', tabId: 'tab-1' })
    t('재시작 뒤 그 id 가 다른 탭이면 그 탭을 게시 사이트로 끌고 가지 않는다(하이재킹 방지)',
      navOf('tab-1').length === 0,
      JSON.stringify({ navigations, wf: cur(wf.id)?.stage }))
    t('대신 원래 세션(워크스페이스)에 새 탭을 열어 잇는다',
      navigations.some((n) => n.created && n.url === 'https://www.instagram.com/')
      && publishTasks()[0]?.tabId === 'tab-new',
      JSON.stringify({ navigations, tabId: publishTasks()[0]?.tabId }))
  }

  {
    // 양성 대조 — 키로 찾은 탭이 저장된 id 와 **다른 id** 여도 그 탭에서 잇는다("전부 막혀서" 통과가 아님).
    tabState.clear()
    setTab('tab-1', 'https://mail.example/inbox', { workspaceId: 'ws-1', key: 'tk-restored-other' })
    setTab('tab-7', 'about:blank', { workspaceId: 'ws-1', key: 'tk-orig' })
    genTabKey = 'tk-orig'
    await runPublish({ ...params, windowId: 'win-1', tabId: 'tab-1' })
    t('복원 안정 키로 찾은 바로 그 탭에서 잇는다(id 가 달라져도)',
      navOf('tab-7').length === 1 && navOf('tab-1').length === 0 && publishTasks()[0]?.tabId === 'tab-7',
      JSON.stringify({ navigations, tabId: publishTasks()[0]?.tabId }))
  }

  {
    // 하위호환 — 키가 없던 옛 기록. 같은 세션 안이라면(워크스페이스 일치) 예전처럼 그 탭을 그대로 쓴다.
    tabState.clear()
    setTab('tab-1', 'about:blank', { workspaceId: 'ws-1' })
    genTabKey = null
    await runPublish({ ...params, windowId: 'win-1', tabId: 'tab-1' })
    t('키 없는 옛 기록도 같은 세션이면 그 탭에서 그대로 잇는다(회귀 없음)',
      navOf('tab-1').length === 1 && publishTasks()[0]?.tabId === 'tab-1',
      JSON.stringify({ navigations, tabId: publishTasks()[0]?.tabId }))
  }

  {
    // 하위호환의 부정 대조 — 키가 없는데 그 id 가 **다른 세션**의 탭이면 쓰지 않는다.
    tabState.clear()
    setTab('tab-1', 'https://mail.example/inbox', { workspaceId: 'ws-2' })
    genTabKey = null
    await runPublish({ ...params, windowId: 'win-1', tabId: 'tab-1' })
    t('키가 없어도 다른 세션의 탭이면 게시에 쓰지 않는다',
      navOf('tab-1').length === 0 && publishTasks()[0]?.tabId === 'tab-new',
      JSON.stringify({ navigations, tabId: publishTasks()[0]?.tabId }))
  }

  // 뒷정리 — 이 블록이 바꾼 전역 상태를 원래대로(뒤 시나리오가 있어도 영향받지 않게).
  genTabKey = 'tk-tab-1'
  tabState.clear()
  setTab('tab-1', 'about:blank')
}

// ===== 재시작 경합 — 탭을 옮기는 도중 앱이 꺼졌다면, 다시 켜도 저절로 게시되지 않는다 =====
{
  const file = path.join(root, 'ai-social-workflows.json')
  const wfRaw = {
    id: 'wf-restart', stage: 'publish', taskIds: { generate: 'task-1' },  // 게시 작업이 없다 = 준비 중이었다
    artifactId: 'art-1', caption: '캡션',
    params: { service: 'genspark', platform: 'instagram', prompt: '고양이', mode: 'publish', account: 'me', tabId: 'tab-1', windowId: null },
    createdAt: Date.now(), updatedAt: Date.now(),
  }
  fs.writeFileSync(file, JSON.stringify({ version: 1, workflows: [wfRaw], grant: null }))
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('dist', 'main', 'features', 'ai'))) delete require.cache[k]
  }
  const W4 = require(path.join(REPO, 'app/dist/main/features/ai/social-workflow.js'))
  const revived = W4.listWorkflows().find((x) => x.id === 'wf-restart')
  t('탭을 옮기는 도중 꺼졌던 작업은 재시작해도 저절로 게시되지 않는다',
    revived?.stage === 'failed' && !revived?.taskIds?.publish,
    JSON.stringify({ stage: revived?.stage, ids: revived?.taskIds }))
  t('재시작 뒤 사용자에게 "게시되지 않았다" 고 분명히 알린다',
    (revived?.error ?? '').includes('게시는 진행되지 않았습니다'), String(revived?.error))
}

const summary = `\n합계 PASS ${pass} / FAIL ${fail}`
console.log(summary)

const outDir = path.join(REPO, 'verify-out', 'auto-publish')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), pass, fail, results }, null, 2))
fs.rmSync(root, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
