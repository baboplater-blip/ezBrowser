import { app, dialog } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import {
  collectSession, createTab, activateTab, pinTab, tabEvents, onTabNavigated,
  restoreWorkspaceLayout, registerRestoredGroups,
  type SessionWindowSnap,
} from '../../tabs/tab-service'
import { SaveDeadlines } from './save-deadlines'
import { sanitizeSnapshotShape } from './snapshot-schema'
import { createBrowserWindow, getAllWindows, windowEvents } from '../../windows/window-service'
import { getActiveWorkspaceId, getWorkspace } from '../workspace'
import { forEachInstalledSession } from '../../session-bootstrap'
import { getSetting } from '../../storage/settings'

const SCHEMA_VERSION = 1
const SAVE_DEBOUNCE_MS = 5_000
// 구조 변경(탭 추가·삭제·이동·핀)과 내비게이션은 더 짧게 — 크래시 손실 창 축소
const SAVE_SOON_MS = 1_000
const FORCE_SAVE_MS = 30_000
// 즉시 로드할 탭 수 상한 (활성·핀 외) — 가벼움 예산 보호
const EAGER_TAIL = 5

interface SessionSnapshot {
  version: number
  savedAt: number
  windows: SessionWindowSnap[]
}

function sessionsDir(): string {
  return path.join(app.getPath('userData'), 'sessions')
}
function currentPath(): string { return path.join(sessionsDir(), 'current.json') }
function lastStablePath(): string { return path.join(sessionsDir(), 'last-stable.json') }

function buildSnapshot(): SessionSnapshot {
  return { version: SCHEMA_VERSION, savedAt: Date.now(), windows: collectSession() }
}

/**
 * 스냅샷을 원자적으로 교체한다. **성공 여부를 돌려준다** — 호출측이 "새 복구 자료가 확실히 디스크에
 * 놓였을 때만 옛 복구 자료를 지운다" 는 순서를 지킬 수 있어야 하기 때문이다.
 * (예전에는 쓰기 실패를 경고만 하고 삼켰고, 그 뒤 `before-quit` 이 current.json 을 지워
 *  실패한 쓰기와 함께 세션이 통째로 사라질 수 있었다.)
 */
function writeSnapshot(target: string, snap: SessionSnapshot): boolean {
  const tmp = `${target}.tmp`
  try {
    mkdirSync(sessionsDir(), { recursive: true })
    writeFileSync(tmp, JSON.stringify(snap))
    renameSync(tmp, target) // 원자적 교체 (sync)
    return true
  } catch (err) {
    console.warn('[session] write failed', target, err)
    // 반쯤 쓰인 tmp 가 남으면 다음 쓰기의 rename 을 방해할 수 있다 — 치운다(원본은 건드리지 않는다).
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best-effort */ }
    return false
  }
}

/**
 * 읽을 수 없는 스냅샷을 **지우지 않고 옆으로 치운다**. 이름을 고정해(타임스탬프 없이) 부팅마다
 * 손상본이 쌓이는 것을 막으면서도 원본 증거는 남긴다. 조용히 덮어쓰지 않는다 — 항상 로그를 남긴다.
 */
function preserveCorrupt(target: string, reason: string): void {
  const kept = `${target}.corrupt`
  try {
    try { if (existsSync(kept)) unlinkSync(kept) } catch { /* best-effort */ }
    renameSync(target, kept)
    console.warn(`[session] 손상된 스냅샷을 보존했습니다: ${kept} (${reason})`)
  } catch (err) {
    console.warn('[session] 손상 스냅샷 보존 실패', target, err)
  }
}

function readSnapshot(target: string): SessionSnapshot | null {
  if (!existsSync(target)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(target, 'utf-8'))
  } catch (err) {
    // 깨진 JSON(정전 중 반쯤 쓰인 파일 등) — 증거를 남기고 다른 스냅샷으로 넘어간다.
    preserveCorrupt(target, `JSON 파싱 실패: ${(err as Error).message}`)
    return null
  }
  const shape = sanitizeSnapshotShape(parsed, SCHEMA_VERSION)
  if (!shape.ok) {
    if (shape.corrupt) preserveCorrupt(target, shape.reason)
    else console.warn(`[session] 스냅샷을 쓸 수 없습니다(${shape.reason}) — 무시: ${target}`)
    return null
  }
  const { savedAt, windows, droppedTabs, droppedWindows } = shape.snapshot
  if (droppedTabs > 0 || droppedWindows > 0) {
    console.warn(`[session] 손상된 항목을 건너뜁니다 (탭 ${droppedTabs}개 · 창 ${droppedWindows}개): ${target}`)
  }
  return { version: SCHEMA_VERSION, savedAt, windows }
}

function safeUnlink(target: string): void {
  try { if (existsSync(target)) unlinkSync(target) } catch { /* ignore */ }
}

// ===== 저장 트리거 =====

let saveTimer: NodeJS.Timeout | null = null
let forceTimer: NodeJS.Timeout | null = null
let restoring = false
let quitting = false

// 기한 계산은 save-deadlines.ts 의 순수 로직에 맡긴다(단독 시험 가능).
const deadlines = new SaveDeadlines()

function armSaveTimer(): void {
  const due = deadlines.nextDueAt()
  if (due === null) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(runScheduledSave, Math.max(0, due - Date.now()))
}

function runScheduledSave(): void {
  saveTimer = null
  const now = Date.now()
  // 구조 변경 때문에 뜨는 저장인가? (뒤따르는 "가라앉은 뒤의 저장" 을 붙일지 정한다)
  const provisional = deadlines.isStructuralDue(now)
  // 지금 도래한 기한만 소비한다 — 아직 오지 않은 "가라앉은 뒤의 저장" 은 그대로 둔다.
  deadlines.consumeDue(now)
  if (restoring || quitting) { deadlines.clear(); return }
  writeSnapshot(currentPath(), buildSnapshot())
  // 구조 변경으로 일찍 뜬 스냅샷은 탭 목록은 지키지만 스크롤·폼(pageState)이 아직 낡아 있을 수 있다
  // (Chromium 이 그 값을 내비게이션 항목에 반영하는 데 몇 초가 걸린다).
  // 그래서 **그 경우에만** 활동이 잦아든 뒤 한 번 더 뜬다 → 활동 묶음당 최대 두 번, 그 뒤엔 조용하다.
  if (provisional) deadlines.ensureSoft(now, SAVE_DEBOUNCE_MS)
  armSaveTimer()
}

function clearScheduledSave(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  deadlines.clear()
}

/** 잡음성 변경(제목·파비콘·창 크기) — 마지막 것만 유효한 일반 디바운스. */
function scheduleSave(delay: number = SAVE_DEBOUNCE_MS): void {
  if (restoring || quitting) return // 종료 절차 중 탭 종료가 'list' 를 발화해 빈 스냅샷을 다시 쓰지 않도록
  deadlines.markSoft(Date.now(), delay)
  armSaveTimer()
}

/** 구조 변경·내비게이션 — 한 번 잡힌 기한은 어떤 후속 이벤트로도 미뤄지지 않는다. */
function scheduleSaveSoon(): void {
  if (restoring || quitting) return
  deadlines.markStructural(Date.now(), SAVE_SOON_MS)
  armSaveTimer()
}

export function initSessionTracking(): void {
  tabEvents.on('list', scheduleSaveSoon)        // 탭 추가/삭제/이동/핀 — 손실 시 가장 치명적
  tabEvents.on('update', () => scheduleSave())  // 제목/파비콘/로딩 — 5초 디바운스로 충분
  onTabNavigated(scheduleSaveSoon)              // 페이지 이동 — URL·히스토리 빠르게 반영
  windowEvents.on('created', (ctx: { win: { on: (e: string, cb: () => void) => void } }) => {
    ctx.win.on('resize', () => scheduleSave())
    ctx.win.on('move', () => scheduleSave())
    // 파괴 전(close) 시점 — 탭이 아직 살아있을 때 동기 스냅샷. 종료 절차 중엔 금지.
    ctx.win.on('close', () => {
      if (restoring || quitting) return
      writeSnapshot(currentPath(), buildSnapshot())
    })
  })

  // 30초 주기 강제 저장 (디바운스 무효화)
  forceTimer = setInterval(() => {
    if (restoring || getAllWindows().length === 0) return
    writeSnapshot(currentPath(), buildSnapshot())
  }, FORCE_SAVE_MS)
  if (typeof forceTimer.unref === 'function') forceTimer.unref()

  // 정상 종료: last-stable 동기 기록 + current 제거(다음 부팅 시 깨끗한 종료로 인식)
  app.on('before-quit', () => {
    clearScheduledSave()
    if (forceTimer) { clearInterval(forceTimer); forceTimer = null }
    quitting = true
    try {
      const snap = buildSnapshot()
      // 정상 종료의 핵심은 순서다: **새 복구 자료를 확실히 쓴 뒤에만** 옛 복구 자료를 지운다.
      // 디스크가 가득 찼거나 경로가 막혀 쓰기가 실패했는데 current.json 을 지워 버리면
      // 그 순간 복구 가능한 세션이 하나도 남지 않는다.
      let durable = false
      if (snap.windows.length > 0) {
        durable = writeSnapshot(lastStablePath(), snap)
      } else {
        // 창이 이미 다 닫힌 뒤라면 마지막으로 저장된 current 를 정본으로 승격한다.
        const cur = readSnapshot(currentPath())
        if (cur && cur.windows.length > 0) durable = writeSnapshot(lastStablePath(), cur)
        else durable = true // 보존할 세션 자체가 없다 — 지워도 잃을 것이 없다
      }
      if (durable) safeUnlink(currentPath())
      else console.warn('[session] last-stable 기록 실패 — current.json 을 남겨 복구 가능하게 둡니다')
      // 쿠키·로컬스토리지 디스크 flush — SIGKILL 외 정상 종료 시 최근 세션 데이터 유실 방지
      forEachInstalledSession((ses) => {
        try { ses.flushStorageData() } catch { /* best-effort */ }
        try { void ses.cookies.flushStore() } catch { /* best-effort */ }
      })
    } catch (err) {
      console.warn('[session] before-quit save failed', err)
    }
  })
}

// ===== 복원 =====

/**
 * 복원을 마친 직후 **디스크에 복구 가능한 자료가 남아 있는지** 보장한다.
 * 복원한 탭들은 아직 URL 을 커밋하지 않아 첫 라이브 저장이 1초쯤 뒤에야 일어난다.
 * 그 사이에 다시 크래시가 나도 같은 세션을 한 번 더 복원할 수 있어야 한다.
 */
function keepCurrentAsRecovery(snap: SessionSnapshot, why: string): void {
  if (existsSync(currentPath()) || existsSync(lastStablePath())) return // 이미 복구 자료가 있다
  if (snap.windows.length === 0) return
  if (writeSnapshot(currentPath(), snap)) console.warn(`[session] 복구 자료 재기록 (${why})`)
}

async function restoreSnapshot(snap: SessionSnapshot): Promise<boolean> {
  if (snap.windows.length === 0) return false
  restoring = true
  let restoredTabs = 0
  try {
    const activeWsId = getActiveWorkspaceId()
    for (const w of snap.windows) {
      // 창의 정체성을 그대로 물려준다 — 이 창에 매여 있던 내구 작업이 재시작 뒤에도 **바로 이 창**을
      // 찾을 수 있어야 한다(창 id 는 프로세스마다 다시 세므로 id 로는 구분되지 않는다).
      const ctx = createBrowserWindow({ restoreKey: w.restoreKey })
      try { if (w.bounds) ctx.win.setBounds(w.bounds) } catch { /* invalid bounds */ }

      // 탭 그룹 먼저 등록 — 탭 생성 시 groupId 매칭. 그룹 메타가 이상해도 탭 복원은 계속한다.
      if (Array.isArray(w.groups) && w.groups.length > 0) {
        try { registerRestoredGroups(ctx.id, w.groups) }
        catch (err) { console.warn('[session] 탭 그룹 복원 실패 — 탭만 복원합니다', err) }
      }

      // 즉시 로드 대상: 활성 탭 + 핀 + 마지막 EAGER_TAIL 개
      const eager = new Set<number>()
      w.tabs.forEach((t, i) => { if (t.active || t.pinned) eager.add(i) })
      for (let i = Math.max(0, w.tabs.length - EAGER_TAIL); i < w.tabs.length; i += 1) eager.add(i)

      let activeTabId: string | null = null
      // 스냅샷에 명시된 active 탭이 없는 이상 케이스를 대비한 폴백 (창에 보이는 탭이 0개가 되는 것을 방지)
      let firstCreatedId: string | null = null
      // 분할 레이아웃 복원용: (원본 워크스페이스 id, 저장 index) → 새 tabId
      const idMap = new Map<string, string>()
      w.tabs.forEach((t, i) => {
        // 탭 하나가 복원에 실패해도 그 뒤의 멀쩡한 탭들까지 잃지 않는다.
        try {
          // 존재하지 않는 워크스페이스면 활성 워크스페이스로 폴백
          const wsId = getWorkspace(t.workspaceId) ? t.workspaceId : activeWsId
          const isEager = eager.has(i)
          const created = createTab({
            windowId: ctx.id,
            url: t.url,
            workspaceId: wsId,
            background: true,
            restoreDiscarded: !isEager,
            restoreTitle: t.title,
            restoreHistory: t.history,
            restoreHistoryIndex: t.historyIndex,
            groupId: t.groupId,
            // 탭의 정체성을 그대로 물려준다(위 창과 같은 이유). 옛 스냅샷이면 undefined 라
            // 새 키가 발급되고, 그 탭에 매여 있던 작업은 추측 대신 사용자에게 대상을 묻는다.
            restoreKey: t.restoreKey,
          })
          restoredTabs += 1
          if (firstCreatedId === null) firstCreatedId = created.id
          idMap.set(`${t.workspaceId}::${t.index}`, created.id)
          if (t.pinned) pinTab(created.id, true)
          if (t.active) activeTabId = created.id
        } catch (err) {
          console.warn(`[session] 탭 복원 실패 — 건너뜁니다 (${t.url})`, err)
        }
      })
      if (firstCreatedId === null) {
        // 그 창의 탭을 하나도 되살리지 못했다 — 빈 껍데기를 보여 주지 않도록 새 탭 하나를 연다.
        // (창 자체는 이미 만들어졌으므로 호출측이 또 하나 만들게 두면 빈 창이 둘이 된다.)
        try { createTab({ windowId: ctx.id }) }
        catch (err) { console.warn('[session] 빈 복원 창에 새 탭 생성 실패', err) }
      }
      if (activeTabId) activateTab(activeTabId)
      else if (firstCreatedId) activateTab(firstCreatedId)

      // 분할 화면 레이아웃 복원 (활성 워크스페이스면 즉시 반영)
      if (Array.isArray(w.layouts)) {
        for (const ls of w.layouts) {
          try {
            restoreWorkspaceLayout(ctx.id, ls, (wsId, tabIndex) => idMap.get(`${wsId}::${tabIndex}`) ?? null)
          } catch (err) {
            console.warn('[session] 분할 레이아웃 복원 실패 — 단일 pane 으로 둡니다', err)
          }
        }
      }
    }
    if (restoredTabs === 0) console.warn('[session] 스냅샷에서 되살린 탭이 없습니다 — 빈 창으로 시작합니다')
    // 창을 만들었으면 true — 호출측이 기본 창을 또 만들지 않게 하는 신호다.
    return true
  } finally {
    restoring = false
  }
}

/**
 * 부팅 시 세션 복원 시도. 창을 하나라도 만들었으면 true 반환(호출측이 기본 창 생성을 건너뜀).
 * 정책(settings.startup.mode):
 *  - last-session: last-stable(또는 current) 자동 복원
 *  - urls: 지정 URL 목록 새 창에 열기
 *  - newtab: 기본 동작 — 단, 비정상 종료(current.json 잔존) 감지 시 복원 여부를 사용자에게 물음
 */
export async function maybeRestoreSession(): Promise<boolean> {
  const startup = getSetting('startup')
  const current = readSnapshot(currentPath())
  const lastStable = readSnapshot(lastStablePath())

  if (startup.mode === 'last-session') {
    // current.json 이 남아 있으면 = 직전 비정상 종료 → current 가 last-stable(직전 정상 종료본)보다
    // 최신이다. savedAt 으로 더 최신 스냅샷을 골라 크래시된 세션의 탭을 잃지 않는다.
    const snap = (current && lastStable)
      ? ((current.savedAt ?? 0) >= (lastStable.savedAt ?? 0) ? current : lastStable)
      : (current ?? lastStable)
    if (snap && snap.windows.length > 0) {
      const ok = await restoreSnapshot(snap)
      // 복원했다고 해서 current.json 을 지우지 않는다.
      // 지우면 "복원 직후 다시 크래시" 구간(첫 라이브 저장 전)에 디스크에 복구 자료가 **하나도** 없다.
      // 남겨 두면 최악의 경우에도 같은 스냅샷으로 한 번 더 복원할 수 있고,
      // 곧 도착하는 라이브 저장이 같은 파일을 최신 상태로 덮어쓰며, 정상 종료가 지운다.
      keepCurrentAsRecovery(snap, '복원 직후 재크래시 대비')
      return ok
    }
    // 복원할 내용이 없다 — 남은 빈/무효 마커만 정리한다.
    safeUnlink(currentPath())
    return false
  }

  if (startup.mode === 'urls') {
    const urls = (startup.urls ?? []).filter((u) => /^https?:|^browser:/i.test(u))
    if (urls.length === 0) return false
    const ctx = createBrowserWindow()
    urls.forEach((url, i) => { createTab({ windowId: ctx.id, url, background: i !== 0 }) })
    return true
  }

  // newtab 모드: current.json 이 남아 있으면 = 직전 비정상 종료 → 복원 여부 질문
  if (current && current.windows.length > 0) {
    const tabCount = current.windows.reduce((n, w) => n + w.tabs.length, 0)
    const result = await dialog.showMessageBox({
      type: 'question',
      buttons: ['세션 복원', '새 탭으로 시작'],
      defaultId: 0,
      cancelId: 1,
      title: '지난 세션 복원',
      message: '브라우저가 비정상 종료된 것 같습니다.',
      detail: `직전 세션의 탭 ${tabCount}개를 복원하시겠습니까?`,
    })
    if (result.response === 0) {
      const ok = await restoreSnapshot(current)
      // last-session 모드와 같은 이유로 current 를 남긴다 — 복원 직후 재크래시에도 한 번 더 복원 가능.
      // 라이브 저장이 곧 덮어쓰고, 정상 종료가 지운다.
      keepCurrentAsRecovery(current, '복원 직후 재크래시 대비')
      return ok
    }
    // 사용자가 "새 탭으로 시작" 을 골랐다 — 명시적 결정이므로 마커를 지운다(다시 묻지 않는다).
    safeUnlink(currentPath())
    return false
  }

  safeUnlink(currentPath())
  return false
}
