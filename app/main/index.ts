import './bootstrap-userdata' // 반드시 첫 import — 다른 모듈의 top-level Store 생성보다 먼저 userData 경로를 정해야 함
import { app, BrowserWindow, Menu, protocol, session } from 'electron'
import { registerAllIpc } from './ipc'
import {
  createBrowserWindow, getAllWindows, setMagnetHandler, setOpenInTabHandler,
  windowEvents, type BrowserWindowContext,
} from './windows/window-service'
import { registerDefaultActions } from './actions/register-defaults'
import { getAction, runAction } from './actions/registry'
import { loadKeymap, getKeymap } from './keymap/keymap-service'
import { initUserChrome } from './features/userchrome'
import { initAdblock } from './features/adblock'
import { initDownloads } from './features/downloads'
import { resumePendingDownloads } from './features/downloads/resume'
import {
  addTorrent, initTorrentBridge, initMagnetHandler, initTorrentResponseHook,
} from './features/torrent'
import {
  initVideoDetect, registerTabWebContents, unregisterTabWebContents, reportSiteCandidate,
  clearCandidates as clearVideoCandidates,
} from './features/video-download'
import {
  createTab, navigateTab, onTabCreated, onTabClosed, onTabNavigated, onTabTitleUpdated,
  onTabInPageNavigated, getTabPartition,
} from './tabs/tab-service'
import { initExtensions } from './extensions/adapter'
import { buildAppMenu } from './menu/build-menu'
import { initBookmarks } from './storage/bookmarks'
import { initHistory, recordVisit, updateVisitTitle } from './storage/history'
import { DEFAULT_SESSION } from '../shared/constants'
import { bindNativeTheme, trackWebContents as trackDarkMode } from './features/dark-mode'
import { getWebContentsByTabId } from './tabs/tab-service'
import { initGesture } from './features/gesture'
import { initQuickSearch } from './features/quick-search'
import { initTranslate } from './features/translate'
import { initQrcode } from './features/qrcode'
import { initAi } from './features/ai'
import { initAgentTriggers, onNavigatedForTriggers } from './features/ai/agent-triggers'
import { initFeedCollectors } from './features/ai/feed-collector'
import { initBlogDrafts } from './features/ai/blog-drafts'
import { initUserscripts, trackWebContents as trackUserscripts } from './features/userscript'
import { initPolicies, trackWebContents as trackPolicies, installPolicyOn } from './features/policy'
import { initWorkspaces, listWorkspaces, workspaceEvents } from './features/workspace'
import { initPasswords } from './features/password'
import { addSessionInitHook, setupSession, setupSessionByPartition } from './session-bootstrap'
import { initDesignTokens, getOverridesAsCssVars, tokenEvents } from './features/design-tokens'
import {
  initAutomation, listStartupMacros, listUrlMacrosFor, runMacro,
} from './features/automation'
import {
  dispatchTabClosed, dispatchTabCreated, dispatchTabNavigated, initModApi,
} from './features/mod-api'
import { startTabSleepLoop } from './features/tab-sleep'
import { trackFind } from './features/find'
import { trackContextMenu } from './features/context-menu'
import { trackZoom } from './features/page-tools'
import { initSessionTracking, maybeRestoreSession } from './features/session'
import { initAutoUpdate } from './features/auto-update'
import {
  recordFirstTabLoaded, recordFirstWindowReady, recordWhenReady,
} from './features/perf'
import { nudgeGc } from './features/gc-nudge'

protocol.registerSchemesAsPrivileged([
  { scheme: 'browser', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

let lastFocusedWindowId: string | null = null

// 시크릿 창의 탭인지 — 방문 기록 등 영속 저장을 건너뛸 때 사용.
// (CLAUDE.md: "시크릿 세션은 메모리에만 보관, 종료 시 삭제")
function isIncognitoTab(tabId: string): boolean {
  return (getTabPartition(tabId) ?? '').startsWith('incognito')
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  const NAV_ALLOWED_SCHEMES = new Set([
    'http:', 'https:', 'file:', 'browser:', 'devtools:', 'chrome-extension:',
    'about:', 'data:', 'blob:', 'view-source:',
  ])
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-navigate', (ev, url) => {
      try {
        const u = new URL(url)
        if (!NAV_ALLOWED_SCHEMES.has(u.protocol)) {
          ev.preventDefault()
          console.warn(`[nav] blocked will-navigate scheme=${u.protocol} url=${url}`)
        }
      } catch { /* invalid url — leave to Electron */ }
    })
    wc.on('did-fail-load', (_ev, code, desc, validatedURL) => {
      if (code !== -3) {
        console.warn(`[nav] did-fail-load wc#${wc.id} code=${code} ${desc} url=${validatedURL}`)
      }
    })
  })

  app.on('second-instance', () => {
    const ctx = getAllWindows()[0]
    if (ctx) {
      if (ctx.win.isMinimized()) ctx.win.restore()
      ctx.win.focus()
    } else {
      createBrowserWindow()
    }
  })

  app.whenReady().then(async () => {
    recordWhenReady()
    try {
      // policy 의 webRequest 후킹을 session 초기화 hook 으로 등록 (모든 세션 자동 적용)
      addSessionInitHook((ses) => { installPolicyOn(ses) })
      // default + persist:default 즉시 install
      setupSession(session.defaultSession)
      setupSessionByPartition(DEFAULT_SESSION)
      setOpenInTabHandler((windowId, url, opts) => {
        if (opts?.sourceTabId && !opts.forceNewTab) {
          // same-tab 모드 — 요청을 발생시킨 탭에서 navigate
          navigateTab(opts.sourceTabId, url)
          return
        }
        createTab({ windowId, url, background: opts?.background === true })
      })
      setMagnetHandler((url) => { void addTorrent(url) })
      await initBookmarks()
      await initHistory()
      await initWorkspaces()
      // 모든 워크스페이스 partition 에 핸들러 install
      for (const ws of listWorkspaces()) setupSessionByPartition(ws.partition)
      // 새 워크스페이스 생성 시 자동 install
      workspaceEvents.on('created', (ws: { partition: string }) => {
        setupSessionByPartition(ws.partition)
      })
      await initUserscripts()
      await initPolicies()
      await initPasswords()
      await initDesignTokens()
      await initAutomation()
      await initModApi()
      registerAllIpc()
      registerDefaultActions()
      initDownloads()
      initVideoDetect()
      initTorrentBridge()
      initMagnetHandler()
      initTorrentResponseHook()
      bindNativeTheme()
      initGesture()
      initQuickSearch()
      initTranslate()
      initQrcode()
      void initAi()
      initAgentTriggers()
      initFeedCollectors()
      initBlogDrafts()

      onTabCreated(({ id, webContentsId }) => {
        registerTabWebContents(id, webContentsId)
        const wc = getWebContentsByTabId(id)
        if (wc) {
          trackDarkMode(wc)
          trackUserscripts(wc)
          trackPolicies(wc)
          trackFind(wc, id)
          trackContextMenu(wc, id)
          trackZoom(wc, id)
          wc.once('did-finish-load', () => recordFirstTabLoaded())
        }
        dispatchTabCreated({ id, webContentsId })
      })
      onTabClosed((id) => {
        unregisterTabWebContents(id)
        dispatchTabClosed(id)
      })
      // SPA(pushState) 경로 변경 시에도 이전 영상 후보를 비운다 — did-navigate 만으로는 안 불림
      onTabInPageNavigated(({ id }) => clearVideoCandidates(id))
      onTabNavigated(({ id, url, title }) => {
        // 새 페이지로 이동 시 이전 영상의 미디어 후보를 비운다 —
        // 안 비우면 새 영상에서 받기를 눌러도 이전 영상의 m3u8 로 받아 "이름만 다르고 내용은 같은" 문제가 생김.
        clearVideoCandidates(id)
        reportSiteCandidate(id, url)
        if (!isIncognitoTab(id)) recordVisit({ url, title })
        dispatchTabNavigated({ id, url, title })
        if (!isIncognitoTab(id)) onNavigatedForTriggers(id, url) // AI URL 진입 트리거
        // URL 트리거 매크로 자동 실행
        const matched = listUrlMacrosFor(url)
        if (matched.length > 0) {
          const wc = getWebContentsByTabId(id)
          for (const macro of matched) {
            void runMacro(macro.id, {
              webContents: wc,
              toast: (msg) => {
                for (const ctx of getAllWindows()) {
                  ctx.chrome.webContents.send('toast:show', { message: msg, ts: Date.now() })
                }
              },
            })
          }
        }
      })
      onTabTitleUpdated(({ id, url, title }) => {
        if (!isIncognitoTab(id)) updateVisitTitle(url, title)
      })

      await loadKeymap()
      await initUserChrome()

      windowEvents.on('created', (ctx: BrowserWindowContext) => {
        attachAcceleratorsToWindow(ctx)
        ctx.win.on('focus', () => { lastFocusedWindowId = ctx.id })
        lastFocusedWindowId = ctx.id
      })

      // 새 창 생성 시 토큰 overrides 자동 적용 (복원 창도 포함되도록 창 생성 전에 등록)
      windowEvents.on('created', (newCtx: BrowserWindowContext) => {
        newCtx.chrome.webContents.once('did-finish-load', () => {
          const cssVars = getOverridesAsCssVars()
          if (Object.keys(cssVars).length > 0) {
            newCtx.chrome.webContents.send('tokens:changed', { overrides: {}, cssVars })
          }
        })
      })

      // 세션 추적 시작 + 부팅 시 복원 시도. 복원이 창을 만들었으면 기본 창 생성을 건너뜀.
      initSessionTracking()
      const restored = await maybeRestoreSession().catch((err) => {
        console.warn('[main] session restore failed', err)
        return false
      })
      const ctx = (restored ? getAllWindows()[0] : undefined) ?? createBrowserWindow()
      Menu.setApplicationMenu(buildAppMenu(() => lastFocusedWindowId ?? ctx.id))

      // 부팅 시 'startup' 트리거 매크로 실행 (외피 마운트 직후)
      const runStartup = (): void => {
        recordFirstWindowReady()
        setTimeout(() => {
          const startupMacros = listStartupMacros()
          for (const macro of startupMacros) {
            void runMacro(macro.id, {
              webContents: null,
              toast: (msg) => ctx.chrome.webContents.send('toast:show', { message: msg, ts: Date.now() }),
            })
          }
          // 디자인 토큰 overrides 외피에 전송
          const cssVars = getOverridesAsCssVars()
          if (Object.keys(cssVars).length > 0) {
            ctx.chrome.webContents.send('tokens:changed', { overrides: {}, cssVars })
          }
        }, 100)
      }
      if (ctx.chrome.webContents.isLoadingMainFrame()) {
        ctx.chrome.webContents.once('did-finish-load', runStartup)
      } else {
        runStartup()
      }

      // 토큰 변경 broadcast (IPC 핸들러에서도 broadcast 하나, init 흐름 보강)
      tokenEvents.on('changed', () => { /* IPC 핸들러가 broadcast 처리 */ })

      setTimeout(() => {
        const adblockDone = initAdblock().catch((err) => console.error('[main] adblock init failed', err))
        const extensionsDone = initExtensions().catch((err) => console.error('[main] extensions init failed', err))
        // 부팅 초기 대량 JSON 파싱(설정·워크스페이스·정책·userscript 등) + adblock 필터 빌드까지
        // 끝난 뒤 1회 GC 넛지 — 스크래치 메모리를 최대한 회수한 상태를 "새 바닥"으로 굳힌다.
        // 기능·데이터에는 영향 없음(순수 메모리 정리).
        void Promise.allSettled([adblockDone, extensionsDone]).then(() => nudgeGc('post-boot-settle'))
      }, 1500)

      // 백그라운드 탭 슬립 루프 — 매 60초마다 비활성 탭 검사
      startTabSleepLoop()

      // 지난 세션에서 진행 중이던 다운로드 이어받기 (렌더러 마운트 후 토스트·패널이 보이도록 약간 지연)
      setTimeout(() => {
        void resumePendingDownloads().catch((err) => console.warn('[main] resume downloads failed', err))
      }, 1800)

      // 자동 업데이트 — packaged 빌드에서만 활성
      void initAutoUpdate().catch((err) => console.warn('[main] auto-update init failed', err))
    } catch (err) {
      console.error('[main] startup failed', err)
      throw err
    }
  }).catch((err) => {
    console.error('[main] whenReady chain failed', err)
  })

  process.on('uncaughtException', (err) => { console.error('[main] uncaught', err) })
  process.on('unhandledRejection', (err) => { console.error('[main] unhandled rejection', err) })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (getAllWindows().length === 0) createBrowserWindow()
  })
}


function attachAcceleratorsToWindow(ctx: BrowserWindowContext): void {
  // keymap 변경 시 즉시 반영되도록 closure 캡처 대신 매번 getKeymap() 호출
  ctx.chrome.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if ((input as { isComposing?: boolean }).isComposing) return
    const km = getKeymap()
    for (const binding of km.bindings) {
      if (!matchesAccelerator(binding.key, input)) continue
      const action = getAction(binding.action)
      if (!action) continue
      event.preventDefault()
      const focused = BrowserWindow.getFocusedWindow()
      const windowId = ctx.id
      void runAction(binding.action, { windowId, tabId: focused ? undefined : undefined })
      return
    }
  })
}

function matchesAccelerator(accel: string, input: Electron.Input): boolean {
  const parts = accel.split('+').map((p) => p.trim().toLowerCase())
  const wantCtrl = parts.includes('ctrl') || parts.includes('cmdorctrl')
  const wantShift = parts.includes('shift')
  const wantAlt = parts.includes('alt')
  const wantMeta = parts.includes('cmd') || parts.includes('meta') || parts.includes('super')
  const key = parts[parts.length - 1] ?? ''
  if (input.control !== wantCtrl) return false
  if (input.shift !== wantShift) return false
  if (input.alt !== wantAlt) return false
  if (input.meta !== wantMeta) return false
  return input.key.toLowerCase() === key
}
