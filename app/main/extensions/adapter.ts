import { app, ipcMain, session, type Extension, type Session } from 'electron'
import { EventEmitter } from 'node:events'
import { promises as fsp, existsSync, createWriteStream, readFileSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash, generateKeyPairSync } from 'node:crypto'
import path from 'node:path'
import extract from 'extract-zip'
import {
  activateTab, closeTab, createTab, findTabIdByWebContentsId, getWebContentsByTabId,
} from '../tabs/tab-service'
import { getAllWindows, getWindow } from '../windows/window-service'
import { addSessionInitHook, forEachInstalledSession, partitionOfSession } from '../session-bootstrap'
import { listWorkspaces } from '../features/workspace'
import { DEFAULT_SESSION } from '../../shared/constants'
import type { ExtensionSessionLoad, ExtensionSummary } from '../../shared/types'
import {
  reloadDnrRules, dnrRuleCountFor, loadDynamicRules, watchDiskDynamicRules,
  updateRuntimeRules, getRuntimeRules, dropRuntimeRules,
} from '../features/extensions/dnr'

let extensionsAdapter: unknown = null
let extensionsModule: { ElectronChromeExtensions: ExtensionsCtor } | null = null

/**
 * 세션마다 하나씩 두는 확장 어댑터.
 *
 * 왜 세션마다인가 (2026-09-15): 라이브러리는 `addTab(wc, win)` 에서
 * `this.ctx.session !== wc.session` 이면 **TypeError 를 던진다**(엄격한 동일성 검사).
 * 그런데 우리 탭은 전부 워크스페이스 partition(`persist:ws-<id>`)에 있고 어댑터는
 * `defaultSession` 하나로만 만들어져 있었다 → 어떤 탭도 등록될 수 없었고
 * `chrome.tabs.query` 는 늘 빈 배열이었다.
 *
 * 인스턴스를 여러 개 만들어도 안전한 근거: 라이브러리의 IPC 라우터(`crx-msg` 등)는
 * **모듈 전역 싱글턴**(gRoutingDelegate)이 한 번만 등록하고 sender 세션으로 라우팅한다.
 * `ElectronChromeExtensions.fromSession(session)` 이 존재하는 것도 세션당 1개가 설계 의도임을 보여준다.
 * (adblock 의 코스메틱 핸들러처럼 "두 번째 등록이 throw" 하는 계열이 아님을 확인했다.)
 */
const adaptersBySession = new WeakMap<Session, unknown>()

interface ExtensionsCtor {
  new (opts: {
    session: Electron.Session
    license?: string
    createTab: (details: { url?: string; windowId?: number; active?: boolean }) => Promise<[Electron.WebContents, Electron.BaseWindow]>
    selectTab?: (tab: Electron.WebContents, win: Electron.BaseWindow) => void
    removeTab?: (tab: Electron.WebContents, win: Electron.BaseWindow) => void
  }): unknown
}

/**
 * 라이브러리 인스턴스가 제공하는 **탭 등록** 표면.
 *
 * 생성자에 넘기는 `createTab`/`selectTab`/`removeTab` 은 "확장이 브라우저에게 시키는" 방향이고,
 * 이 메서드들은 반대로 "브라우저가 확장에게 탭을 알려주는" 방향이다 — 둘은 다른 것이며,
 * 후자를 부르지 않으면 `chrome.tabs.*` 에 노출되는 탭이 **하나도 없다**.
 */
interface ExtensionsTabRegistry {
  addTab?: (tab: Electron.WebContents, window: Electron.BaseWindow) => void
  removeTab?: (tab: Electron.WebContents) => void
  selectTab?: (tab: Electron.WebContents) => void
}

async function loadModule(): Promise<{ ElectronChromeExtensions: ExtensionsCtor } | null> {
  try {
    const name = ['electron-chrome-extensions'][0]!
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(name) as { ElectronChromeExtensions: ExtensionsCtor }
    return mod
  } catch {
    console.warn('[extensions] electron-chrome-extensions not installed — skipped')
    return null
  }
}

function extensionsRoot(): string {
  return path.join(app.getPath('userData'), 'extensions')
}

function disabledFile(): string {
  return path.join(app.getPath('userData'), 'extensions-disabled.json')
}

async function readDisabled(): Promise<Set<string>> {
  try {
    const raw = await fsp.readFile(disabledFile(), 'utf-8')
    const arr = JSON.parse(raw) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

async function writeDisabled(set: Set<string>): Promise<void> {
  await fsp.writeFile(disabledFile(), JSON.stringify(Array.from(set)), 'utf-8')
}

export const extensionEvents = new EventEmitter()

// 확장이 바뀌면(설치·제거·활성 변경) declarativeNetRequest 정적 룰셋을 다시 읽는다.
// 한 곳에서 잡아야 어느 경로로 바뀌든 빠지지 않는다(임무 36).
// 확장이 부르는 chrome.declarativeNetRequest 동적 룰 API 를 받는다(preload 가 invoke 한다).
// 확장 컨텍스트에서만 오므로 별도 신뢰 검사는 두지 않되, extId 는 **보낸 쪽 값을 그대로 믿지 않고**
// 형식만 확인한다(디렉터리명과 같은 형태).
let dnrIpcRegistered = false
function registerDnrIpc(): void {
  if (dnrIpcRegistered) return
  dnrIpcRegistered = true
  const okId = (v: unknown): v is string => typeof v === 'string' && /^[a-p]{32}$|^[A-Za-z0-9._-]{1,80}$/.test(v)
  ipcMain.handle('bb-dnr:update', (_e, a: { extId?: string; scope?: string; addRules?: unknown[]; removeRuleIds?: number[] }) => {
    if (!okId(a?.extId)) return { ok: false, error: '확장 id 형식 오류' }
    const scope = a.scope === 'session' ? 'session' : 'dynamic'
    return updateRuntimeRules(a.extId, scope, {
      addRules: Array.isArray(a.addRules) ? (a.addRules as never[]) : undefined,
      removeRuleIds: Array.isArray(a.removeRuleIds) ? a.removeRuleIds.map((n) => Number(n)) : undefined,
    })
  })
  ipcMain.handle('bb-dnr:get', (_e, a: { extId?: string; scope?: string }) => {
    if (!okId(a?.extId)) return []
    return getRuntimeRules(a.extId, a.scope === 'session' ? 'session' : 'dynamic')
  })
  // 룰셋 활성/비활성은 아직 정적 룰셋 전체를 다시 읽는 것으로만 대응한다(부분 토글 미지원).
  ipcMain.handle('bb-dnr:rulesets', async () => ({ ok: true }))
  ipcMain.handle('bb-dnr:rulesets-get', () => [])
}

extensionEvents.on('changed', () => {
  void (async () => {
    try {
      const n = await reloadDnrRules(await readDisabled())
      if (n > 0) console.log(`[extensions] DNR 룰 ${n}개 적용`)
    } catch (err) { console.warn('[extensions] DNR 룰 적재 실패', err) }
  })()
})

// ===== 세션 식별 — "이 세션이 시크릿인가" · "사용자에게 뭐라고 부를까" =====

type SessionKind = ExtensionSessionLoad['kind']

interface SessionDesc { partition: string; label: string; kind: SessionKind }

function kindOfPartition(p: string): SessionKind {
  if (p.startsWith('incognito')) return 'incognito'
  if (p === '' || p === DEFAULT_SESSION) return 'default'
  if (p.startsWith('persist:ws-')) return 'workspace'
  return 'other'
}

function labelOfPartition(p: string): string {
  switch (kindOfPartition(p)) {
    case 'default': return '기본'
    case 'incognito': return '시크릿'
    case 'workspace': {
      const ws = listWorkspaces().find((w) => w.partition === p)
      return ws ? `워크스페이스: ${ws.name}` : `워크스페이스(${p.slice('persist:ws-'.length)})`
    }
    default: return p
  }
}

/** 사용자에게 보여줄 세션 설명. partition 문자열을 그대로 노출하지 않기 위한 단일 출처. */
function describeSession(ses: Session): SessionDesc {
  const p = partitionOfSession(ses)
  if (p === undefined) {
    // 우리가 만들지 않은 세션(있어선 안 되지만) — partition 을 되찾을 방법이 없다.
    return { partition: '(알 수 없음)', label: '알 수 없는 세션', kind: 'other' }
  }
  return { partition: p, label: labelOfPartition(p), kind: kindOfPartition(p) }
}

/** 로드 결과를 세션별로 보관할 때 쓰는 키(빈 partition = defaultSession). */
function sessionKey(desc: SessionDesc): string { return desc.partition || '(default)' }

/**
 * 확장에게 `file://` 콘텐츠 접근을 줄 것인가. **주지 않는다**(Electron·크롬 둘 다의 기본값).
 *
 * 왜 (2026-09-15, 검사 X26 이 실측으로 잡음): 우리 **외피(탭바·주소창·사이드패널)는 `file://` 로
 * 로드되는 또 하나의 webContents** 다. 그리고 Electron 35 의 `chrome.scripting` 은 대상 탭을
 * `electron::api::WebContents::FromID(tabId)` — **프로세스 전역 레지스트리** — 로 풀고 세션을 보지
 * 않는다(shell/browser/extensions/api/scripting/scripting_api.cc 의 `CanAccessTarget` 은 넘겨받은
 * `browser_context` 인자를 한 번도 쓰지 않는다). 즉 확장이 작은 정수를 훑기만 하면 외피에 닿았다.
 *
 * 그 결과가 추상적 위험이 아니었다 — 일반 워크스페이스의 확장이 **시크릿 창의 외피**에서
 * `document.body.innerText` 와 주소창 input 값을 읽어 **시크릿 탭의 주소를 그대로 가져갔다**
 * (X26 이 그 문자열을 증거로 남긴다). 시크릿 탭 **안**은 못 건드리지만(X25) "무엇을 보고 있는지"는
 * 새고 있었다.
 *
 * 남은 관문이 `permissions.CanAccessPage(대상 URL)` 뿐이므로, **우리가 통제할 수 있는 유일한 손잡이가
 * 이 플래그**다. 끄면 `<all_urls>` 를 가진 확장도 `file://` 에는 닿지 못한다.
 *
 * 비용(정직하게): 사용자가 연 로컬 파일(`file://` 페이지)에서 확장이 동작하지 않는다.
 * 크롬도 기본이 이것이며 확장마다 "파일 URL 접근 허용" 을 사용자가 켜도록 한다 — 그 토글은 아직 없다.
 * 한계: 개발 모드(`VITE_DEV_SERVER_URL`)에서는 외피가 `http://localhost` 라 이 플래그로 막히지 않는다.
 * 배포 빌드는 항상 `file://` 이므로 사용자에게 가는 경로는 막힌다.
 */
const EXTENSION_FILE_ACCESS = false

/**
 * 시크릿 세션인가.
 *
 * 왜 중요한가 (2026-09-15): 크롬은 **확장을 시크릿에서 기본으로 끈다**(확장마다 사용자가 명시적으로
 * "시크릿에서 허용" 을 켜야 한다). 우리는 시크릿 partition 도 `setupSessionByPartition` 을 지나가므로
 * 세션 hook 이 그대로 걸려 **확장이 시크릿에도 로드되고 시크릿 탭이 chrome.tabs 에 등록**됐다.
 * 확장은 `chrome.storage.local`(영속)에 쓸 수 있으니, 이는 단순한 호환성 문제가 아니라
 * **시크릿 방문 기록이 영속 저장소로 새는 통로**였다. 그래서 확장이 닿는 모든 경로에서 시크릿을 뺀다.
 *
 * 판정은 두 겹이다 — partition 이름(정상 경로)과 실제 시크릿 창 목록(라벨을 못 얻은 예외 상황).
 * 둘 중 하나라도 시크릿이면 시크릿으로 본다(모르면 안전한 쪽).
 */
function isIncognitoSession(ses: Session): boolean {
  if (describeSession(ses).kind === 'incognito') return true
  for (const ctx of getAllWindows()) {
    if (!ctx.incognito || !ctx.incognitoPartition) continue
    // 이미 존재하는 partition 이므로 fromPartition 이 새 세션을 만들지 않는다(캐시된 인스턴스 반환).
    try { if (session.fromPartition(ctx.incognitoPartition) === ses) return true } catch { /* ignore */ }
  }
  return false
}

function sessions(): Session[] {
  // 모든 설치된 세션(default + persist:default + 모든 워크스페이스 partition)에 확장을 로드해야
  // 비-default 워크스페이스에서도 확장이 동작한다. defaultSession 은 install 목록에 포함되지만
  // 방어적으로 Set 에 미리 넣어 dedup 한다. (회귀 #12/#13 계열 — session-bootstrap hook 시스템 재사용)
  // 단 **시크릿 세션은 제외**한다(위 isIncognitoSession 주석).
  const set = new Set<Session>([session.defaultSession])
  forEachInstalledSession((s) => set.add(s))
  return [...set].filter((s) => !isIncognitoSession(s))
}

// ===== 세션별 로드 결과 =====
//
// 현재 로드 여부 자체는 `ses.getAllExtensions()` 로 **그때그때 조회**한다(과거 기록을 믿지 않는다).
// 여기 남기는 것은 "왜 실패했는가" 뿐이다 — 조회로는 이유를 알 수 없기 때문이다.
interface LoadFailure { error: string; reason: string }
const loadFailures = new Map<string, Map<string, LoadFailure>>()

/** 영문 오류를 사용자가 이해할 수 있는 한 줄로. 못 알아보면 원문을 접어서 보여줄 뿐 지어내지 않는다. */
function koReason(raw: string): string {
  const s = raw.toLowerCase()
  if (s.includes('manifest')) return 'manifest.json 을 읽을 수 없거나 형식이 잘못됐습니다.'
  if (s.includes('version')) return '확장의 버전 표기가 올바르지 않습니다.'
  if (s.includes('enoent') || s.includes('no such file')) return '확장 파일을 찾을 수 없습니다.'
  if (s.includes('eacces') || s.includes('permission')) return '파일 권한 때문에 읽지 못했습니다.'
  if (s.includes('locale') || s.includes('_locales')) return '번역(_locales) 파일에 문제가 있습니다.'
  return '이 세션에서 확장을 불러오지 못했습니다.'
}

function recordLoadResult(extId: string, ses: Session, ok: boolean, err?: unknown): void {
  const key = sessionKey(describeSession(ses))
  let m = loadFailures.get(extId)
  if (ok) { m?.delete(key); return }
  if (!m) { m = new Map(); loadFailures.set(extId, m) }
  const error = String((err as Error)?.message ?? err ?? '알 수 없는 오류')
  m.set(key, { error, reason: koReason(error) })
}

function clearLoadResults(extId: string): void { loadFailures.delete(extId) }

// 새로 만들어지는 세션(예: 새 워크스페이스 partition)에 활성 확장을 로드한다. idempotent.
/**
 * 확장 컨텍스트에 우리 `chrome.declarativeNetRequest` 동적 룰 API preload 를 얹는다.
 * `electron-chrome-extensions` 가 자기 API 를 넣는 것과 **같은 방식**('frame' + 'service-worker').
 * id 를 고정해 두면 같은 세션에 두 번 등록돼도 교체된다(멱등).
 */
/** 이 세션의 확장 어댑터를 얻는다(없으면 만든다). 라이브러리가 없으면 null. */
function ensureAdapterFor(ses: Session): unknown {
  const existing = adaptersBySession.get(ses)
  if (existing) return existing
  if (!extensionsModule) return null
  // 시크릿 세션에는 어댑터 자체를 만들지 않는다 → 시크릿 탭이 chrome.tabs 에 등록될 길이 없다.
  if (isIncognitoSession(ses)) return null
  try {
    const instance = new extensionsModule.ElectronChromeExtensions({
      session: ses,
      license: 'GPL-3.0',
      createTab: async ({ url, active }) => {
        const ctx = getAllWindows()[0]
        if (!ctx) throw new Error('no window')
        const summary = createTab({ windowId: ctx.id, url, background: !active })
        const wc = getWebContentsByTabId(summary.id)
        if (!wc) throw new Error('webcontents not found')
        return [wc, ctx.win]
      },
      // 확장이 탭을 고르거나 닫으려 할 때(chrome.tabs.update({active:true}) / chrome.tabs.remove).
      // 전에는 둘 다 무시(() => undefined)라 확장의 탭 조작이 조용히 아무 일도 하지 않았다.
      // 라이브러리의 removeTab() 안에서 불리지만, 그쪽은 이미 자기 목록에서 지운 뒤라
      // 우리 closeTab → onTabClosed → untrackExtensionTab 이 되돌아와도 재진입하지 않는다.
      selectTab: (tab) => {
        const loc = findTabIdByWebContentsId(tab.id)
        if (loc) activateTab(loc.tabId)
      },
      removeTab: (tab) => {
        const loc = findTabIdByWebContentsId(tab.id)
        if (loc) closeTab(loc.tabId)
      },
    })
    adaptersBySession.set(ses, instance)
    return instance
  } catch (err) {
    console.warn('[extensions] adapter init failed', err)
    return null
  }
}

async function loadEnabledInto(ses: Session): Promise<void> {
  // 시크릿 세션에는 확장을 올리지 않는다(크롬 기본과 같다 — isIncognitoSession 주석 참고).
  if (isIncognitoSession(ses)) return
  const root = extensionsRoot()
  let entries: string[] = []
  try { entries = await fsp.readdir(root) } catch { return }
  const disabled = await readDisabled()
  const already = new Set(ses.getAllExtensions().map((x) => x.id))
  for (const entry of entries) {
    if (disabled.has(entry)) continue
    if (already.has(entry)) continue // 이미 로드됨 (디렉터리 이름 = 확장 id)
    const extPath = path.join(root, entry)
    const stat = await fsp.stat(extPath).catch(() => null)
    if (!stat?.isDirectory()) continue
    if (!existsSync(path.join(extPath, 'manifest.json'))) continue
    try {
      await ses.loadExtension(extPath, { allowFileAccess: EXTENSION_FILE_ACCESS })
      recordLoadResult(entry, ses, true)
    } catch (err) {
      // 이 세션에서만 실패할 수 있다(디스크·권한 등). 뭉개지 말고 세션별로 남겨
      // 관리 화면이 "어느 워크스페이스에서 안 뜨는지" 를 말할 수 있게 한다.
      recordLoadResult(entry, ses, false, err)
      console.warn(`[extensions] load into new session failed: ${entry}`, err)
    }
  }
}

export async function initExtensions(): Promise<void> {
  // 확장 라이브러리 유무와 무관하게 DNR 배관은 세운다 — 동적 룰은 디스크에서 복원한다.
  registerDnrIpc()
  await loadDynamicRules()
  // 확장이 런타임에 넣는 룰은 Electron 이 디스크에 쓴다 — 그것을 읽어 우리 엔진에 병합한다.
  watchDiskDynamicRules()

  const mod = await loadModule()
  if (!mod) return

  extensionsModule = mod
  // defaultSession 용 인스턴스. 실제 탭은 워크스페이스 partition 에 있으므로
  // 그쪽 인스턴스는 session-bootstrap hook 에서 세션마다 따로 만든다(ensureAdapterFor).
  extensionsAdapter = ensureAdapterFor(session.defaultSession)
  if (!extensionsAdapter) return

  // 탭이 실제로 쓰는 세션(persist:default · 워크스페이스 partition)에도 어댑터를 만든다.
  // addSessionInitHook 은 **이미 설치된 세션에도 즉시** 적용된다(회귀 #13 에서 그렇게 고쳤다).
  for (const ses of sessions()) ensureAdapterFor(ses)

  await fsp.mkdir(extensionsRoot(), { recursive: true }).catch(() => undefined)
  await loadInstalledExtensions()
  // 이후 생성되는 워크스페이스 partition 세션에도 자동으로 어댑터 생성 + 활성 확장 로드
  // (기존 세션은 위에서 이미 로드됨 → getAllExtensions 가드로 skip)
  addSessionInitHook((ses) => {
    // 시크릿 세션은 여기서 곧바로 돌려보낸다. 아래 두 함수에도 각각 가드가 있지만(다중 방어),
    // 이 hook 은 **새 partition 이 생길 때마다** 불리는 유일한 입구라 여기서 막는 것이 본줄기다.
    if (isIncognitoSession(ses)) return
    ensureAdapterFor(ses)
    void loadEnabledInto(ses)
  })
}

async function loadInstalledExtensions(): Promise<void> {
  const root = extensionsRoot()
  let entries: string[] = []
  try {
    entries = await fsp.readdir(root)
  } catch {
    return
  }
  const disabled = await readDisabled()
  for (const entry of entries) {
    if (disabled.has(entry)) continue
    const extPath = path.join(root, entry)
    const stat = await fsp.stat(extPath).catch(() => null)
    if (!stat?.isDirectory()) continue
    if (!existsSync(path.join(extPath, 'manifest.json'))) continue
    await loadExtensionInAll(extPath)
  }
  extensionEvents.emit('changed')
}

/**
 * 모든 (시크릿 아닌) 세션에 확장을 올린다.
 *
 * 반환값은 예전과 같다(하나라도 성공하면 그 Extension). 다만 **세션별 성패를 따로 기록**한다 —
 * 예전에는 실패를 `lastErr` 하나로 뭉개서 "3개 세션 중 1개만 성공" 도 성공으로 보고했고,
 * 그 워크스페이스에서 확장이 전혀 안 뜨는데 화면에는 정상으로 보였다.
 */
async function loadExtensionInAll(extPath: string): Promise<Extension | null> {
  const extId = path.basename(extPath)
  let lastErr: unknown = null
  let loaded: Extension | null = null
  for (const ses of sessions()) {
    try {
      const ext = await ses.loadExtension(extPath, { allowFileAccess: EXTENSION_FILE_ACCESS })
      loaded = ext
      recordLoadResult(extId, ses, true)
      // 계산된 id 와 런타임 id 가 어긋나는 예외 상황에서도 기록이 미아가 되지 않게 함께 남긴다.
      if (ext.id !== extId) recordLoadResult(ext.id, ses, true)
    } catch (err) {
      lastErr = err
      recordLoadResult(extId, ses, false, err)
    }
  }
  if (!loaded) console.warn(`[extensions] failed to load ${extPath}`, lastErr)
  return loaded
}

function removeFromAll(id: string): void {
  for (const ses of sessions()) {
    try { ses.removeExtension(id) } catch { /* ignore */ }
  }
}

/**
 * 설치된 확장 목록.
 *
 * 2026-09-15 에 고친 것: 예전에는 **`defaultSession` 하나만** 보고 메타데이터를 채웠고,
 * `enabled` 는 "비활성 목록에 없으면 true" 였다. 즉 **설정상 켬**과 **실제 로드됨**이 구분되지 않아,
 * 워크스페이스 세션에서 로드가 실패해도 화면에는 멀쩡히 켜진 확장으로 보였다.
 * 이제 확장이 로드될 수 있는 **모든 세션을 실제로 조회해서**(과거 시도 기록이 아니라 현재 상태)
 * 세션별 로드 여부를 싣는다. 실패 이유만 기록(loadFailures)에서 가져온다.
 */
export async function listExtensions(): Promise<ExtensionSummary[]> {
  const disabled = await readDisabled()
  const root = extensionsRoot()
  const dirs: string[] = await fsp.readdir(root).catch(() => [])
  const out: ExtensionSummary[] = []
  // 확장이 올라갈 수 있는 세션들의 **현재** 스냅샷(시크릿 제외). 세션마다 한 번만 조회한다.
  const eligible = sessions().map((ses) => ({
    desc: describeSession(ses),
    byId: new Map(ses.getAllExtensions().map((e) => [e.id, e])),
  }))
  for (const dir of dirs) {
    const dirPath = path.join(root, dir)
    const stat = await fsp.stat(dirPath).catch(() => null)
    if (!stat?.isDirectory()) continue
    const manifestPath = path.join(dirPath, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    let manifest: ManifestJson
    try {
      manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'))
    } catch {
      continue
    }
    const isDisabled = disabled.has(dir)

    // ── 세션별 실제 로드 상태 ──
    const sessionStates: ExtensionSessionLoad[] = eligible.map(({ desc, byId }) => {
      const has = byId.has(dir)
      const st: ExtensionSessionLoad = {
        partition: desc.partition, label: desc.label, kind: desc.kind, loaded: has,
      }
      if (!has) {
        const fail = loadFailures.get(dir)?.get(sessionKey(desc))
        if (fail) { st.error = fail.error; st.reason = fail.reason }
        else st.reason = isDisabled ? '꺼져 있습니다.' : '아직 이 세션에 불러오지 않았습니다.'
      }
      return st
    })
    const loadedSessions = sessionStates.filter((s) => s.loaded).length

    // 메타데이터는 이 확장을 실제로 들고 있는 아무 세션에서나 가져온다
    // (defaultSession 에만 없고 워크스페이스 세션에는 있는 경우가 실제로 있다).
    const ext = eligible.map((e) => e.byId.get(dir)).find((e) => e !== undefined)
    const iconDataUrl = await readBestIcon(dirPath, manifest).catch(() => undefined)
    const messages = await loadLocaleMessages(dirPath, manifest.default_locale || 'en')
    out.push({
      id: dir,
      // Electron 이 이미 name 을 치환해 준 경우(ext?.name) localizeString 은 정규식 불일치라
      // 그대로 통과시킨다 — 아직 __MSG_x__ 그대로면(또는 ext 가 없으면) messages.json 으로 해석.
      name: localizeString(ext?.name ?? manifest.name, messages) ?? dir,
      version: ext?.version ?? manifest.version ?? '0.0.0',
      description: localizeString(manifest.description, messages),
      enabled: !isDisabled,
      // 설정상 켬(enabled)과 다른 값 — 실제로 한 세션에라도 올라와 있는가.
      loaded: loadedSessions > 0,
      sessions: sessionStates,
      loadedSessions,
      totalSessions: sessionStates.length,
      hasOptions: Boolean(manifest.options_ui?.page || manifest.options_page),
      hasIcon: Boolean(iconDataUrl),
      iconDataUrl,
      hasAction: Boolean(manifest.action || manifest.browser_action),
      // 확장이 declarativeNetRequest 로 실제로 몇 개 룰을 적용 중인지 — 0 이면
      // '로드는 됐지만 아무것도 막지 못하는' 상태다(임무 34 에서 드러난 착시).
      dnrRules: dnrRuleCountFor(dir),
      actionTitle: localizeString(
        manifest.action?.default_title
        ?? manifest.browser_action?.default_title
        ?? manifest.name,
        messages,
      ),
      homepageUrl: manifest.homepage_url,
      source: 'crx',
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

// ── i18n: manifest 필드의 __MSG_key__ 플레이스홀더를 _locales/<locale>/messages.json 으로 해석 ──
// Chrome 확장 표준: manifest 의 name/description/action.default_title 등에 정확히
// "__MSG_key__" 형식의 값이 오면, default_locale(없으면 'en') 폴더의 messages.json 에서
// { "key": { "message": "..." } } 을 찾아 치환한다. Electron 의 loadExtension 은 name 만
// 이따금 이미 치환해 반환하므로(런타임 확장 객체 기준), name 은 우선 그 값을 쓰고 여전히
// 플레이스홀더 형태면(또는 없으면) 여기서 마저 해석한다. 파일 없음·키 없음 등은 원문을 그대로
// 반환해 표시가 깨지지 않게 한다(안전 우선).
type LocaleMessages = Record<string, { message?: string }>

async function loadLocaleMessages(extDir: string, locale: string): Promise<LocaleMessages | null> {
  const file = path.join(extDir, '_locales', locale, 'messages.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(await fsp.readFile(file, 'utf-8')) as LocaleMessages
  } catch {
    return null
  }
}

const MSG_PLACEHOLDER_RE = /^__MSG_([A-Za-z0-9_@]+)__$/

function localizeString(raw: string | undefined, messages: LocaleMessages | null): string | undefined {
  if (!raw) return raw
  const m = raw.match(MSG_PLACEHOLDER_RE)
  if (!m) return raw // 일반 문자열 — 이미 해석됐거나 애초에 플레이스홀더가 아님
  const key = m[1]!
  return messages?.[key]?.message ?? raw
}

interface ManifestJson {
  name?: string
  version?: string
  description?: string
  homepage_url?: string
  options_page?: string
  options_ui?: { page?: string }
  action?: { default_title?: string; default_icon?: string | Record<string, string> }
  browser_action?: { default_title?: string; default_icon?: string | Record<string, string> }
  icons?: Record<string, string>
  default_locale?: string
}

async function readBestIcon(extDir: string, manifest: ManifestJson): Promise<string | undefined> {
  const candidates: string[] = []
  const collect = (src: string | Record<string, string> | undefined) => {
    if (!src) return
    if (typeof src === 'string') { candidates.push(src); return }
    for (const v of Object.values(src)) candidates.push(v)
  }
  collect(manifest.action?.default_icon)
  collect(manifest.browser_action?.default_icon)
  collect(manifest.icons)
  // 큰 아이콘부터
  const ranked = candidates
    .map((p) => ({ p, size: parseInt(p.match(/(\d+)/)?.[1] ?? '0', 10) }))
    .sort((a, b) => b.size - a.size)
  for (const { p } of ranked) {
    const full = path.join(extDir, p)
    if (!existsSync(full)) continue
    try {
      const buf = await fsp.readFile(full)
      const ext = path.extname(p).slice(1).toLowerCase()
      const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch { continue }
  }
  return undefined
}

const CRX_MAGIC = Buffer.from('Cr24', 'utf-8')
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04])

// ── 회귀(버그 2) fix: manifest "key" 기반 안정 ID ────────────────────────
//
// 근본 원인: CRX 페이로드(zip)를 그대로 풀면 manifest.json 에는 보통 "key" 필드가 없다
// (웹스토어 서명키는 CRX 컨테이너의 바깥쪽 헤더에만 있고, 압축 payload 안 manifest 에는
// 기록되지 않는다). manifest 에 "key" 가 없으면 Chromium/Electron 은 **설치 경로 문자열의
// SHA256 해시**로 확장 ID 를 만든다 — 즉 ID 가 경로에 종속된다. 옛 코드는 임시 경로에서
// 한 번 로드해 ID 를 얻은 뒤(경로A 기준 ID) 최종 경로로 옮기고 다시 로드했는데(경로B 기준
// 재계산), 이때 재로드로 실제 활성화된 확장의 런타임 ID 는 경로B 기준으로 새로 계산되어
// 저장/반환한 ID(경로A 기준)와 영구히 달라진다 → 툴바 액션 팝업 chrome-error, 이름
// __MSG_extName__, disable/remove 무반응 등 "확장이 로드는 되지만 앱 UI 에서 못 씀" 증상.
//
// 수정: CRX 컨테이너 헤더에서 서명 공개키(pubkey, DER SubjectPublicKeyInfo)를 직접 추출해
// manifest.json 에 "key"(base64) 로 주입한다. Chrome 확장 ID = SHA256(pubkey DER)의 앞
// 16바이트를 a~p 알파벳으로 인코딩한 값 — **경로와 무관**, 웹스토어가 부여한 ID 와 동일.
// 이제 최종 설치 경로를 ID 로 미리 계산해 정확히 그 자리에 배치한 뒤 **단 한 번만** 로드한다
// (이동 후 재로드 없음 → mismatch 자체가 발생할 수 없는 구조).
// unpacked 로컬 드래그(importLocalUnpackedDir)처럼 서명키가 없는 입력은, Electron 이
// unpacked 로드 시 key 의 서명 유효성을 검증하지 않고 ID 파생에만 쓴다는 점을 이용해
// 자체 키쌍을 생성해 동일하게 주입한다 — 이 역시 경로 독립적인 안정 ID 를 얻는다.

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let result = 0
  let shift = 0
  let pos = offset
  while (pos < buf.length) {
    const byte = buf[pos]!
    pos++
    result += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value: result, next: pos }
    shift += 7
  }
  throw new Error('protobuf: truncated varint')
}

// CRX3 헤더는 protobuf(CrxFileHeader) — 라이브러리 없이 varint+wire-type 만 최소 파싱한다.
// 최상위 필드 번호별로 length-delimited(wire type 2) 바이트열을 모아 반환.
function parseProtoLenDelimitedFields(buf: Buffer): Map<number, Buffer[]> {
  const fields = new Map<number, Buffer[]>()
  let pos = 0
  while (pos < buf.length) {
    const { value: key, next: afterKey } = readVarint(buf, pos)
    pos = afterKey
    const tag = Math.floor(key / 8)
    const wireType = key % 8
    if (wireType === 0) {
      pos = readVarint(buf, pos).next
    } else if (wireType === 1) {
      pos += 8
    } else if (wireType === 2) {
      const { value: len, next } = readVarint(buf, pos)
      pos = next
      if (pos + len > buf.length) throw new Error('protobuf: length exceeds buffer')
      const data = buf.subarray(pos, pos + len)
      if (!fields.has(tag)) fields.set(tag, [])
      fields.get(tag)!.push(data)
      pos += len
    } else if (wireType === 5) {
      pos += 4
    } else {
      throw new Error(`protobuf: unsupported wire type ${wireType}`)
    }
  }
  return fields
}

// CrxFileHeader.sha256_with_rsa(field 2) / sha256_with_ecdsa(field 3) = repeated
// AsymmetricKeyProof{ public_key(field 1), signature(field 2) }.
//
// 실측(웹스토어 CRX 3종 직접 다운로드+파싱)으로 확인된 함정: field 2 에는 흔히 **proof 가
// 2개** 들어있다 — 첫 번째는 모든 확장에 걸쳐 바이트가 완전히 동일한 "배포/재서명" 키(웹
// 스토어가 다운로드 서비스를 통해 재패키징할 때 추가하는 것으로 보임)이고, 실제 개발자
// 고유 키(=웹스토어 ID 를 결정하는 키)는 **두 번째** proof 에 있다. 첫 proof 를 그대로 쓰면
// 모든 확장이 동일한 ID 로 뭉개진다(실측 재현: uBO Lite/Dark Reader/ColorZilla 3종 모두
// 첫 proof pubkey 가 바이트 단위로 동일 → id 도 동일).
//
// 신뢰 가능한 판별법: CrxFileHeader.signed_header_data(field 10000) = SignedData 안의
// crx_id(field 1) 는 Chromium 이 이미 계산해 넣어둔 **정답 ID 원본 바이트(16바이트, 해시 불필요,
// a-p 인코딩만 하면 곧 확장 ID)**. 이 값과 SHA256(pubkey)[0:16] 이 일치하는 proof 를
// field 2 → field 3 순서로 탐색해 "진짜" 개발자 키를 찾아낸다 — 실측 3/3 에서 크로스체크
// 정확히 일치함을 확인(예: uBO Lite crx_id 원본 바이트를 a-p 인코딩한 값이 field2[1] pubkey 의
// SHA256 기반 id 와 정확히 일치, 그리고 둘 다 실제 웹스토어 상세페이지 ID 'ddkjiahejl...' 와 일치).
function extractCrx3PublicKey(header: Buffer): Buffer | null {
  const top = parseProtoLenDelimitedFields(header)

  const candidates: Buffer[] = []
  for (const fieldNum of [2, 3]) {
    const proofs = top.get(fieldNum)
    if (!proofs) continue
    for (const proofBuf of proofs) {
      const proofFields = parseProtoLenDelimitedFields(proofBuf)
      const pubKeys = proofFields.get(1)
      if (pubKeys && pubKeys.length > 0) candidates.push(Buffer.from(pubKeys[0]!))
    }
  }
  if (candidates.length === 0) return null

  // signed_header_data(10000) → SignedData.crx_id(1) = 정답 ID 원본 바이트. 있으면 그 값과
  // SHA256 해시가 일치하는 후보를 찾아 self-verify. 여러 proof 가 있어도 순서에 의존하지 않는다.
  const signedHeaderData = top.get(10000)
  if (signedHeaderData && signedHeaderData.length > 0) {
    try {
      const shdFields = parseProtoLenDelimitedFields(signedHeaderData[0]!)
      const crxIdBytes = shdFields.get(1)?.[0]
      if (crxIdBytes && crxIdBytes.length === 16) {
        const expectedId = idFromRawIdBytes(Buffer.from(crxIdBytes))
        const match = candidates.find((pk) => idFromPublicKey(pk) === expectedId)
        if (match) return match
      }
    } catch {
      // signed_header_data 파싱 실패 — 아래 fallback 으로
    }
  }

  // signed_header_data 가 없거나 어느 후보와도 안 맞는 예외적 경우: 마지막 후보를 사용한다
  // (실측상 "배포/재서명" 키가 항상 먼저, 개발자 키가 나중에 오는 패턴과 일치하는 최선의 추정).
  return candidates[candidates.length - 1]!
}

// SignedData.crx_id 는 이미 계산된 16바이트 ID 원본 — 해시 없이 a-p 알파벳으로만 인코딩.
function idFromRawIdBytes(idBytes: Buffer): string {
  let id = ''
  for (const byte of idBytes) {
    id += String.fromCharCode(97 + (byte >> 4))
    id += String.fromCharCode(97 + (byte & 0x0f))
  }
  return id
}

// Chrome 확장 ID = SHA256(pubkey DER)[0:16] 을 hex 인코딩 후 각 hex 문자(0-9a-f)를
// a-p 알파벳으로 치환(0→a … 15→p). (Chromium crx_file::id_util::GenerateId 와 동일 알고리즘 —
// 다수의 빌드 도구·문서에서 검증된 공개 알고리즘.)
function idFromPublicKey(pubKeyDer: Buffer): string {
  const hash = createHash('sha256').update(pubKeyDer).digest()
  const first16 = hash.subarray(0, 16)
  let id = ''
  for (const byte of first16) {
    id += String.fromCharCode(97 + (byte >> 4))
    id += String.fromCharCode(97 + (byte & 0x0f))
  }
  return id
}

async function unpackCrx(crxPath: string, outDir: string): Promise<Buffer | null> {
  const buf = await fsp.readFile(crxPath)
  let zipOffset: number
  let pubKey: Buffer | null = null
  if (buf.length >= 4 && buf.subarray(0, 4).equals(CRX_MAGIC)) {
    const version = buf.readUInt32LE(4)
    if (version === 2) {
      const pubKeyLen = buf.readUInt32LE(8)
      const sigLen = buf.readUInt32LE(12)
      if (pubKeyLen > 0 && 16 + pubKeyLen <= buf.length) {
        pubKey = Buffer.from(buf.subarray(16, 16 + pubKeyLen))
      }
      zipOffset = 16 + pubKeyLen + sigLen
    } else if (version === 3) {
      const headerLen = buf.readUInt32LE(8)
      const header = buf.subarray(12, 12 + headerLen)
      try {
        pubKey = extractCrx3PublicKey(header)
      } catch (err) {
        console.warn('[extensions] CRX3 헤더 파싱 실패 — 서명 키 없이 진행(자체 키 생성으로 폴백)', err)
      }
      zipOffset = 12 + headerLen
    } else {
      // 알 수 없는 버전 — ZIP 시그니처 직접 탐색
      const found = buf.indexOf(ZIP_LOCAL_HEADER)
      if (found < 0) throw new Error('crx: ZIP header not found')
      zipOffset = found
    }
  } else if (buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_LOCAL_HEADER)) {
    // 이미 ZIP — unpacked 형식의 zip
    zipOffset = 0
  } else {
    throw new Error('crx: not a CRX or ZIP file')
  }

  const tmpZip = path.join(outDir, '__inner.zip')
  await fsp.mkdir(outDir, { recursive: true })
  await fsp.writeFile(tmpZip, buf.subarray(zipOffset))
  try {
    await extract(tmpZip, { dir: outDir })
  } finally {
    await fsp.unlink(tmpZip).catch(() => undefined)
  }
  return pubKey
}

// manifest.json 에 "key" 가 없으면(CRX payload 의 일반적 상태) pubKeyFromCrx(있으면) 또는
// 자체 생성 키를 주입해 경로 독립적 ID 를 계산한다. 이미 key 가 있으면(재서명된 unpacked 등)
// 그 key 기준으로만 ID 를 계산 — 존중하고 덮어쓰지 않는다.
async function ensureManifestKey(extDir: string, pubKeyFromCrx: Buffer | null): Promise<string | null> {
  const manifestPath = path.join(extDir, 'manifest.json')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'))
  } catch (err) {
    console.warn('[extensions] manifest.json 파싱 실패', err)
    return null
  }

  const existingKey = typeof manifest.key === 'string' ? manifest.key : null
  if (existingKey) {
    try {
      return idFromPublicKey(Buffer.from(existingKey, 'base64'))
    } catch {
      // 손상된 key 값 — 아래에서 재생성해 덮어씀
    }
  }

  let pubKeyDer = pubKeyFromCrx
  if (!pubKeyDer) {
    // CRX 헤더에서 서명 키를 못 얻었거나(unpacked 로컬 드래그 등) manifest 에 key 가 없는 경우.
    // Electron/Chrome 은 unpacked 로드 시 key 의 서명 유효성을 검증하지 않고 ID 파생에만
    // 사용하므로, 안정적(경로 독립적) ID 확보를 위해 자체 키를 생성해 주입한다.
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    pubKeyDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  }
  manifest.key = pubKeyDer.toString('base64')
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
  return idFromPublicKey(pubKeyDer)
}

// key 주입이 끝난 준비 디렉터리(preparedDir)를 계산된 ID 기준 최종 위치로 배치하고
// **단 한 번만** 로드한다. content-based ID 이므로 이동 자체가 ID 를 바꾸지 않는다 —
// 그래도 방어적으로 loaded.id !== computedId 면(파싱 버그 등 이론상 상황) 순수 rename 으로
// 디렉터리명을 런타임 진실(loaded.id)에 맞춰 정정한다(재로드 불필요 — content-based ID 는
// 경로가 아니라 key 내용에만 의존하므로 이후 재부팅 시에도 동일 id 로 다시 계산된다).
async function finalizeInstall(preparedDir: string, computedId: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  removeFromAll(computedId) // 재설치/업데이트 시 기존 로드분 정리

  const finalDir = path.join(extensionsRoot(), computedId)
  if (existsSync(finalDir)) {
    await fsp.rm(finalDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await fsp.mkdir(extensionsRoot(), { recursive: true })
  await fsp.rename(preparedDir, finalDir).catch(async () => {
    // 다른 디스크일 수도 — copy fallback
    await copyDir(preparedDir, finalDir)
    await fsp.rm(preparedDir, { recursive: true, force: true }).catch(() => undefined)
  })

  const loaded = await loadExtensionInAll(finalDir)
  if (!loaded) return { ok: false, error: '로드 실패' }

  let finalId = loaded.id
  if (loaded.id !== computedId) {
    console.warn(`[extensions] id mismatch — 정정: computed=${computedId} runtime=${loaded.id}`)
    const correctedDir = path.join(extensionsRoot(), loaded.id)
    if (existsSync(correctedDir)) await fsp.rm(correctedDir, { recursive: true, force: true }).catch(() => undefined)
    await fsp.rename(finalDir, correctedDir).catch(() => undefined)
    finalId = loaded.id
  }

  const disabled = await readDisabled()
  if (disabled.delete(finalId)) await writeDisabled(disabled)
  extensionEvents.emit('changed')
  return { ok: true, id: finalId }
}

export async function installFromCrx(crxPath: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!existsSync(crxPath)) return { ok: false, error: 'file not found' }

  // 임시 디렉터리에 압축 해제(+ CRX 헤더에서 서명 pubkey 추출)
  const tmpDir = path.join(app.getPath('temp'), `browserbuild-crx-${Date.now()}`)
  let pubKey: Buffer | null = null
  try {
    pubKey = await unpackCrx(crxPath, tmpDir)
  } catch (err) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: `압축 해제 실패: ${(err as Error).message}` }
  }

  const computedId = await ensureManifestKey(tmpDir, pubKey)
  if (!computedId) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: 'manifest.json 을 읽을 수 없습니다.' }
  }

  return finalizeInstall(tmpDir, computedId)
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fsp.mkdir(dst, { recursive: true })
  const entries = await fsp.readdir(src, { withFileTypes: true })
  for (const e of entries) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) await copyDir(s, d)
    else await fsp.copyFile(s, d)
  }
}

const WEBSTORE_URL_RE = /chrome(?:webstore)?\.google\.com\/(?:webstore\/)?detail\/[^/]+\/([a-p]{32})/i
// 버그 1 fix: prodversion 을 하드코딩(120.0.0.0)하면 minimum_chrome_version 이 그보다 높은
// 확장(uBO Lite·Stylus·Wappalyzer 등)에 대해 웹스토어가 204(No Content) 를 반환해 다운로드가
// 조용히 실패한다. Electron 이 내장한 실제 Chromium 런타임 버전(process.versions.chrome)을
// 그대로 전달해 항상 현재 엔진과 일치하는 버전으로 질의한다.
const WEBSTORE_CRX_URL = (id: string): string =>
  `https://clients2.google.com/service/update2/crx?response=redirect`
  + `&os=win&arch=x64&os_arch=x86_64&nacl_arch=x86-64`
  + `&prod=chromiumcrx&prodchannel=unknown&prodversion=${process.versions.chrome}`
  + `&acceptformat=crx2,crx3&x=id%3D${id}%26uc`

export function parseWebstoreId(url: string): string | null {
  const m = url.match(WEBSTORE_URL_RE)
  return m?.[1] ?? null
}

export async function installFromUrl(url: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const id = parseWebstoreId(url)
  let downloadUrl: string
  if (id) {
    downloadUrl = WEBSTORE_CRX_URL(id)
  } else if (/^https?:\/\/.+\.crx(\?.*)?$/i.test(url)) {
    downloadUrl = url
  } else {
    return { ok: false, error: '지원하지 않는 URL — 웹스토어 detail URL 또는 .crx 직접 링크여야 합니다.' }
  }

  const tmpCrx = path.join(app.getPath('temp'), `browserbuild-dl-${Date.now()}.crx`)
  try {
    const res = await fetch(downloadUrl, { redirect: 'follow' })
    if (!res.ok || !res.body) {
      return { ok: false, error: `다운로드 실패 (${res.status})` }
    }
    const ws = createWriteStream(tmpCrx)
    await pipeline(Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream), ws)
  } catch (err) {
    return { ok: false, error: `네트워크 오류: ${(err as Error).message}` }
  }

  try {
    return await installFromCrx(tmpCrx)
  } finally {
    await fsp.unlink(tmpCrx).catch(() => undefined)
  }
}

export async function removeExtension(id: string): Promise<{
  ok: boolean; error?: string }> {
  dropRuntimeRules(id)   // 확장이 사라지면 그 확장의 런타임 룰도 버린다
  clearLoadResults(id)   // 세션별 실패 기록도 함께(같은 id 로 재설치될 수 있다)
  if (!/^[a-z]{32}$/i.test(id) && !/^[a-z0-9_-]+$/i.test(id)) {
    return { ok: false, error: 'invalid id' }
  }
  removeFromAll(id)
  const dir = path.join(extensionsRoot(), id)
  if (!existsSync(dir)) return { ok: false, error: 'not found' }
  await fsp.rm(dir, { recursive: true, force: true })
  const disabled = await readDisabled()
  if (disabled.delete(id)) await writeDisabled(disabled)
  extensionEvents.emit('changed')
  return { ok: true }
}

export async function setExtensionEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const dir = path.join(extensionsRoot(), id)
  if (!existsSync(dir)) return { ok: false, error: 'not found' }
  const disabled = await readDisabled()
  // 상태가 바뀌면 이전 실패 이유는 더 이상 사실이 아니다 — 먼저 비우고 새로 기록한다.
  clearLoadResults(id)
  if (enabled) {
    disabled.delete(id)
    await writeDisabled(disabled)
    await loadExtensionInAll(dir)
  } else {
    disabled.add(id)
    await writeDisabled(disabled)
    removeFromAll(id)
  }
  extensionEvents.emit('changed')
  return { ok: true }
}

export async function openExtensionOptions(id: string, windowId: string): Promise<{ ok: boolean; error?: string }> {
  const dir = path.join(extensionsRoot(), id)
  if (!existsSync(dir)) return { ok: false, error: 'not found' }
  let manifest: ManifestJson
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf-8'))
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  const page = manifest.options_ui?.page ?? manifest.options_page
  if (!page) return { ok: false, error: '옵션 페이지 없음' }
  createTab({ windowId, url: `chrome-extension://${id}/${page}` })
  return { ok: true }
}

export async function invokeExtensionAction(id: string, windowId: string): Promise<{ ok: boolean; error?: string }> {
  // 기본 동작: popup 페이지를 새 탭으로 (정식 popup 창은 향후 보완)
  const dir = path.join(extensionsRoot(), id)
  if (!existsSync(dir)) return { ok: false, error: 'not found' }
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf-8')) as ManifestJson & {
      action?: { default_popup?: string }
      browser_action?: { default_popup?: string }
    }
    const popup = manifest.action?.default_popup ?? manifest.browser_action?.default_popup
    if (popup) {
      createTab({ windowId, url: `chrome-extension://${id}/${popup}` })
      return { ok: true }
    }
    // popup 없으면 옵션 페이지로 fallback
    return openExtensionOptions(id, windowId)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function importLocalUnpackedDir(srcDir: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!existsSync(path.join(srcDir, 'manifest.json'))) {
    return { ok: false, error: 'manifest.json 없음 (unpacked 디렉터리가 맞나요?)' }
  }
  // srcDir 은 사용자 소유 임의 경로일 수 있으므로 직접 수정하지 않고 임시 복사본에 key 주입.
  // 폴더 드래그(unpacked) 는 CRX 헤더가 없어 pubKeyFromCrx=null → manifest 에 기존 key 가
  // 없으면 ensureManifestKey 가 자체 키를 생성해 경로 독립적 ID 를 부여한다(installFromCrx 와
  // 동일한 finalizeInstall 단일 로드 경로 — 이동 후 재로드로 인한 ID mismatch 가 구조적으로 없음).
  const tmpDir = path.join(app.getPath('temp'), `browserbuild-unpacked-${Date.now()}`)
  try {
    await copyDir(srcDir, tmpDir)
  } catch (err) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: `복사 실패: ${(err as Error).message}` }
  }

  const computedId = await ensureManifestKey(tmpDir, null)
  if (!computedId) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: 'manifest.json 을 읽을 수 없습니다.' }
  }

  return finalizeInstall(tmpDir, computedId)
}

export function getExtensionsAdapter(): unknown {
  return extensionsAdapter
}

// ===== 탭 등록 (chrome.tabs.*) =====
//
// 2026-09-15 에 고친 결함: 어디에서도 `addTab` 을 부르지 않아 확장이 보는 탭 목록이 **항상 비어 있었다**.
// `chrome.tabs.query({})` 가 0개를 돌려주니 탭을 훑어 동작하는 확장(Vimium·Bitwarden·uBO 팝업 등)과
// `chrome.scripting.executeScript({ target: { tabId } })` 처럼 탭 id 가 필요한 경로가 통째로 죽어 있었다.
// CLAUDE.md 확장 지원 우선순위 4번(tabs/windows/runtime/scripting)이 사실상 미구현이던 셈.
// 확장은 로드되고 콘텐츠 스크립트도 돌아서 겉으로는 멀쩡해 보였다 — 그래서 오래 눈에 띄지 않았다.
//
// 닫힌 뒤에는 webContents 를 다시 얻을 수 없으므로(onTabClosed 는 id 만 준다) 등록 시점에 붙잡아 둔다.
const trackedExtensionTabs = new Map<string, Electron.WebContents>()

/**
 * 이 webContents 가 속한 **세션의** 어댑터. 세션이 어긋나면 라이브러리가 TypeError 를 던지므로
 * 반드시 wc.session 으로 고른다(전역 인스턴스 하나를 쓰면 안 된다).
 */
function tabRegistryFor(wc: Electron.WebContents): ExtensionsTabRegistry | null {
  return (ensureAdapterFor(wc.session) as ExtensionsTabRegistry | null) ?? null
}

/** 새 탭을 확장 시스템에 등록한다. 라이브러리가 없거나 창을 못 찾으면 조용히 건너뛴다. */
export function trackExtensionTab(tabId: string): void {
  const wc = getWebContentsByTabId(tabId)
  if (!wc || wc.isDestroyed()) return
  // 시크릿 탭은 어떤 확장에도 알리지 않는다. (ensureAdapterFor 가 이미 null 을 주지만,
  // 여기서 먼저 끊어야 trackedExtensionTabs 에 시크릿 webContents 참조가 남지 않는다.)
  if (isIncognitoSession(wc.session)) return
  const api = tabRegistryFor(wc)
  if (typeof api?.addTab !== 'function') return
  const loc = findTabIdByWebContentsId(wc.id)
  const ctx = loc ? getWindow(loc.windowId) : undefined
  if (!ctx) return
  try {
    api.addTab(wc, ctx.win)
    trackedExtensionTabs.set(tabId, wc)
  } catch (err) {
    console.warn('[extensions] addTab failed', err)
  }
}

/** 닫힌 탭을 확장 시스템에서 지운다(안 지우면 chrome.tabs 가 유령 탭을 계속 보고한다). */
export function untrackExtensionTab(tabId: string): void {
  const wc = trackedExtensionTabs.get(tabId)
  trackedExtensionTabs.delete(tabId)
  if (!wc || wc.isDestroyed()) return
  const api = tabRegistryFor(wc)
  if (typeof api?.removeTab !== 'function') return
  try { api.removeTab(wc) } catch { /* 이미 파괴된 webContents — 무시 */ }
}

/** 활성 탭이 바뀐 것을 알린다 — `chrome.tabs.query({ active: true })` 가 이 값을 쓴다. */
export function selectExtensionTab(tabId: string): void {
  const wc = trackedExtensionTabs.get(tabId) ?? getWebContentsByTabId(tabId)
  if (!wc || wc.isDestroyed()) return
  const api = tabRegistryFor(wc)
  if (typeof api?.selectTab !== 'function') return
  try { api.selectTab(wc) } catch { /* ignore */ }
}
