import { app, shell, BrowserWindow } from 'electron'
import { tMain } from '../i18n'
import { registerAction } from './registry'
import { IPC } from '../../shared/ipc-channels'
import {
  activateTab, closeTab, createTab, duplicateTab, focusNextPane, listTabs, pinTab,
  restoreLastClosed, splitWindow, tabBack, tabForward, tabReload, tabStop, unsplitWindow,
  getTab, getWebContentsByTabId, moveTabToWorkspace, setTabMuted, navigateTab,
} from '../tabs/tab-service'
import { clearSiteData } from '../features/sitedata'
import { createBrowserWindow, getAllWindows, getWindow } from '../windows/window-service'
import { NEW_TAB_URL } from '../../shared/constants'
import { reloadUserChrome, openUserChromeInEditor } from '../features/userchrome'
import { captureViewport } from '../features/screenshot'
import {
  addBookmark, isBookmarked,
} from '../storage/bookmarks'
import {
  addReadLater, isReadLaterSaved, removeReadLaterByUrl,
} from '../storage/readlater'
import {
  setFollowSystemDark, toggleForcePageDark, toggleSiteDark,
} from '../features/dark-mode'
import { getSetting } from '../storage/settings'
import { toggleSiteAllowed as toggleSiteAdblock } from '../features/adblock'
import { checkForUpdates as checkForUpdatesNow } from '../features/auto-update'
import { toggleReader } from '../features/reader'
import { togglePageTranslate } from '../features/translate'
import {
  createWorkspace, getActiveWorkspace, getActiveWorkspaceId, listWorkspaces, nextWorkspaceId, setActiveWorkspace,
} from '../features/workspace'
import { printTab, printTabToPdf, adjustZoom, savePageAs } from '../features/page-tools'
import { autofillPage } from '../features/ai/page-actions'
import { getProfile, hasProfileData } from '../features/ai/profile'

function activeTabIdOf(windowId?: string): string | undefined {
  if (!windowId) return undefined
  const t = listTabs(windowId).find((x) => x.active)
  return t?.id
}

function broadcastToast(windowId: string | undefined, message: string): void {
  const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
  ctx?.chrome.webContents.send('toast:show', { message, ts: Date.now() })
}

export function registerDefaultActions(): void {
  registerAction({
    id: 'action.autofill.page', category: 'ai', labelKey: 'action.autofill.page', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      const wc = id ? getWebContentsByTabId(id) : null
      if (!wc || !/^https?:/i.test(wc.getURL())) { broadcastToast(windowId, tMain('main.toast.webOnly', '웹 페이지에서만 사용할 수 있습니다')); return }
      if (!hasProfileData()) { broadcastToast(windowId, tMain('main.toast.profileEmpty', '내 정보가 비어 있습니다 — 설정 > AI 에서 입력하세요')); return }
      void autofillPage(wc, getProfile()).then((r) => {
        broadcastToast(windowId, r.count > 0 ? tMain('main.toast.autofillDone', `자동 채우기: ${r.count}개 필드 ✍️`, { count: r.count }) : tMain('main.toast.autofillNone', '채울 폼 필드를 못 찾았습니다'))
      })
    },
  })

  registerAction({
    id: 'action.tab.new', category: 'tab', labelKey: 'action.tab.new',
    defaultKey: 'Ctrl+T', when: 'global',
    run: ({ windowId }) => { if (windowId) createTab({ windowId, url: NEW_TAB_URL }) },
  })

  registerAction({
    id: 'action.tab.close', category: 'tab', labelKey: 'action.tab.close',
    defaultKey: 'Ctrl+W', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (id) closeTab(id)
    },
  })

  registerAction({
    id: 'action.tab.restore', category: 'tab', labelKey: 'action.tab.restore',
    defaultKey: 'Ctrl+Shift+T', when: 'global',
    run: ({ windowId }) => { if (windowId) restoreLastClosed(windowId) },
  })

  registerAction({
    id: 'action.tab.duplicate', category: 'tab', labelKey: 'action.tab.duplicate',
    when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (id) duplicateTab(id)
    },
  })

  registerAction({
    id: 'action.tab.pin', category: 'tab', labelKey: 'action.tab.pin',
    when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (!id) return
      const t = getTab(id)
      if (t) pinTab(id, !t.pinned)
    },
  })

  registerAction({
    id: 'action.tab.next', category: 'tab', labelKey: 'action.tab.next',
    defaultKey: 'Ctrl+Tab', when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      const list = listTabs(windowId)
      const i = list.findIndex((t) => t.active)
      const next = list[(i + 1) % list.length]
      if (next) activateTab(next.id)
    },
  })

  registerAction({
    id: 'action.tab.prev', category: 'tab', labelKey: 'action.tab.prev',
    defaultKey: 'Ctrl+Shift+Tab', when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      const list = listTabs(windowId)
      const i = list.findIndex((t) => t.active)
      const prev = list[(i - 1 + list.length) % list.length]
      if (prev) activateTab(prev.id)
    },
  })

  registerAction({
    id: 'action.nav.back', category: 'nav', labelKey: 'action.nav.back',
    defaultKey: 'Alt+Left', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (id) tabBack(id)
    },
  })

  registerAction({
    id: 'action.nav.forward', category: 'nav', labelKey: 'action.nav.forward',
    defaultKey: 'Alt+Right', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (id) tabForward(id)
    },
  })

  registerAction({
    id: 'action.nav.home', category: 'nav', labelKey: 'action.nav.home',
    defaultKey: 'Alt+Home', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (!id) return
      const home = getActiveWorkspace()?.homeUrl || NEW_TAB_URL
      navigateTab(id, home)
    },
  })

  registerAction({
    id: 'action.page.reload', category: 'nav', labelKey: 'action.page.reload',
    defaultKey: 'Ctrl+R', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (id) tabReload(id)
    },
  })

  registerAction({
    id: 'action.page.reloadHard', category: 'nav', labelKey: 'action.page.reloadHard',
    defaultKey: 'Ctrl+Shift+R', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (!id) return
      const wc = getWebContentsByTabId(id)
      wc?.reloadIgnoringCache()
    },
  })

  registerAction({
    id: 'action.page.viewSource', category: 'tools', labelKey: 'action.page.viewSource',
    defaultKey: 'Ctrl+U', when: 'global',
    run: ({ windowId, tabId }) => {
      if (!windowId) return
      const id = tabId ?? activeTabIdOf(windowId)
      const t = id ? getTab(id) : null
      const url = t?.url
      if (!url || !/^https?:|^file:/i.test(url)) return
      createTab({ windowId, url: `view-source:${url}` })
    },
  })

  registerAction({
    id: 'action.page.save', category: 'tools', labelKey: 'action.page.save',
    defaultKey: 'Ctrl+S', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (!id) return
      void savePageAs(id).then((r) => {
        if (r.ok) broadcastToast(windowId, tMain('main.toast.pageSaveOk', '페이지 저장 완료 💾'))
        else if (r.error !== 'canceled') broadcastToast(windowId, tMain('main.toast.pageSaveFail', '페이지 저장 실패'))
      })
    },
  })

  registerAction({
    id: 'action.page.stop', category: 'nav', labelKey: 'action.page.stop',
    defaultKey: 'Escape', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (id) tabStop(id)
    },
  })

  registerAction({
    id: 'action.omnibox.focus', category: 'omnibox', labelKey: 'action.omnibox.focus',
    defaultKey: 'Ctrl+L', when: 'global',
    run: ({ windowId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      ctx?.chrome.webContents.send('omnibox:focus')
    },
  })

  registerAction({
    id: 'action.palette.open', category: 'palette', labelKey: 'action.palette.open',
    defaultKey: 'Ctrl+Shift+P', when: 'global',
    run: ({ windowId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      ctx?.chrome.webContents.send('palette:open')
    },
  })

  registerAction({
    id: 'action.tab.search', category: 'tab', labelKey: 'action.tab.search',
    defaultKey: 'Ctrl+Shift+A', when: 'global',
    run: ({ windowId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      ctx?.chrome.webContents.send('tabsearch:open')
    },
  })

  registerAction({
    id: 'action.readlater.add', category: 'readlater', labelKey: 'action.readlater.add',
    when: 'global',
    run: ({ windowId, tabId }) => {
      const tab = tabId ? getTab(tabId) : listTabs(windowId ?? '').find((t) => t.active)
      if (!tab?.url || !/^https?:/i.test(tab.url)) return
      if (isReadLaterSaved(tab.url)) {
        removeReadLaterByUrl(tab.url)
        broadcastToast(windowId, tMain('main.toast.readLaterRemoved', '읽기 목록에서 제거됨'))
      } else {
        addReadLater({ url: tab.url, title: tab.title, favicon: tab.favicon })
        broadcastToast(windowId, tMain('main.toast.readLaterAdded', '읽기 목록에 추가됨 📚'))
      }
    },
  })

  registerAction({
    id: 'action.readlater.open', category: 'readlater', labelKey: 'action.readlater.open',
    when: 'global',
    run: ({ windowId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      ctx?.chrome.webContents.send('readlater:open-panel')
    },
  })

  registerAction({
    id: 'action.tab.recentClosed', category: 'tab', labelKey: 'action.tab.recentClosed',
    when: 'global',
    run: ({ windowId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      ctx?.chrome.webContents.send('recent-closed:open')
    },
  })

  registerAction({
    id: 'action.find.toggle', category: 'tools', labelKey: 'action.find.toggle',
    defaultKey: 'Ctrl+F', when: 'global',
    run: ({ windowId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      ctx?.chrome.webContents.send('find:open', {})
    },
  })

  registerAction({
    id: 'action.find.next', category: 'tools', labelKey: 'action.find.next',
    defaultKey: 'F3', when: 'global',
    run: ({ windowId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      ctx?.chrome.webContents.send(IPC.find.step, { forward: true })
    },
  })

  registerAction({
    id: 'action.find.prev', category: 'tools', labelKey: 'action.find.prev',
    defaultKey: 'Shift+F3', when: 'global',
    run: ({ windowId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      ctx?.chrome.webContents.send(IPC.find.step, { forward: false })
    },
  })

  registerAction({
    id: 'action.history.clear', category: 'tools', labelKey: 'action.history.clear',
    defaultKey: 'Ctrl+Shift+Delete', when: 'global',
    run: ({ windowId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      ctx?.chrome.webContents.send('cleardata:open')
    },
  })

  registerAction({
    id: 'action.page.print', category: 'tools', labelKey: 'action.page.print',
    defaultKey: 'Ctrl+P', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (id) printTab(id)
    },
  })

  registerAction({
    id: 'action.page.printPdf', category: 'tools', labelKey: 'action.page.printPdf',
    defaultKey: 'Ctrl+Alt+P', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (!id) return
      void printTabToPdf(id).then((r) => {
        if (r.ok) broadcastToast(windowId, tMain('main.toast.pdfSaveOk', 'PDF 저장 완료 📄'))
        else if (r.error !== 'canceled') broadcastToast(windowId, tMain('main.toast.pdfSaveFail', 'PDF 저장 실패'))
      })
    },
  })

  registerAction({
    id: 'action.page.zoom.in', category: 'tools', labelKey: 'action.page.zoom.in',
    defaultKey: 'Ctrl+=', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (id) adjustZoom(id, 1)
    },
  })

  registerAction({
    id: 'action.page.zoom.out', category: 'tools', labelKey: 'action.page.zoom.out',
    defaultKey: 'Ctrl+-', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (id) adjustZoom(id, -1)
    },
  })

  registerAction({
    id: 'action.page.zoom.reset', category: 'tools', labelKey: 'action.page.zoom.reset',
    defaultKey: 'Ctrl+0', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (id) adjustZoom(id, 0)
    },
  })

  registerAction({
    id: 'action.devtools.toggle', category: 'dev', labelKey: 'action.devtools.toggle',
    defaultKey: 'F12', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      const wc = id ? getWebContentsByTabId(id) : null
      if (wc?.isDevToolsOpened()) wc.closeDevTools()
      else wc?.openDevTools({ mode: 'detach' })
    },
  })

  registerAction({
    id: 'action.userchrome.reload', category: 'freedom', labelKey: 'action.userchrome.reload',
    defaultKey: 'Ctrl+Alt+Shift+R', when: 'chrome',
    run: () => { void reloadUserChrome() },
  })

  registerAction({
    id: 'action.userchrome.edit', category: 'freedom', labelKey: 'action.userchrome.edit',
    when: 'chrome',
    run: () => { void openUserChromeInEditor('css') },
  })

  registerAction({
    id: 'action.screenshot.viewport', category: 'tools', labelKey: 'action.screenshot.viewport',
    defaultKey: 'Ctrl+Shift+Alt+S', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (id) void captureViewport(id)
    },
  })

  registerAction({
    id: 'action.window.new', category: 'window', labelKey: 'action.window.new',
    defaultKey: 'Ctrl+N', when: 'global',
    run: () => {
      createBrowserWindow()
    },
  })

  registerAction({
    id: 'action.window.incognito', category: 'window', labelKey: 'action.window.incognito',
    defaultKey: 'Ctrl+Shift+N', when: 'global',
    run: () => {
      const ctx = createBrowserWindow({ incognito: true })
      createTab({ windowId: ctx.id, url: NEW_TAB_URL })
    },
  })

  registerAction({
    id: 'action.window.close', category: 'window', labelKey: 'action.window.close',
    defaultKey: 'Ctrl+Shift+W', when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      const ctx = getWindow(windowId)
      ctx?.win.close()
    },
  })

  registerAction({
    id: 'action.app.quit', category: 'app', labelKey: 'action.app.quit',
    defaultKey: 'Ctrl+Q', when: 'global',
    run: () => app.quit(),
  })

  registerAction({
    id: 'action.help.report', category: 'help', labelKey: 'action.help.report',
    when: 'global',
    run: () => { void shell.openExternal('https://github.com/') },
  })

  registerAction({
    id: 'action.bookmark.add', category: 'bookmark', labelKey: 'action.bookmark.add',
    defaultKey: 'Ctrl+D', when: 'global',
    // 예전엔 이미 북마크된 페이지에서 Ctrl+D 를 누르면 확인 없이 바로 삭제됐다(오삭제 위험) —
    // 크롬처럼 "추가(없으면) + 항상 편집 말풍선 열기" 로 바꾸고, 실제 삭제는 말풍선의 삭제
    // 버튼으로만 하도록 이동했다.
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (!id) return
      const t = getTab(id)
      if (!t || !t.url || /^browser:|^chrome:|^about:/i.test(t.url)) return
      if (!isBookmarked(t.url)) {
        addBookmark({ url: t.url, title: t.title || t.url })
        broadcastToast(windowId, tMain('main.toast.bookmarkAdded', '북마크에 추가됨 ★'))
      }
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      ctx?.chrome.webContents.send(IPC.bookmarks.bubbleOpen, { tabId: id })
    },
  })

  registerAction({
    id: 'action.history.open', category: 'history', labelKey: 'action.history.open',
    defaultKey: 'Ctrl+H', when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      createTab({ windowId, url: 'browser://history' })
    },
  })

  registerAction({
    id: 'action.bookmark.list', category: 'bookmark', labelKey: 'action.bookmark.list',
    when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      createTab({ windowId, url: 'browser://bookmarks' })
    },
  })

  registerAction({
    id: 'action.bookmark.bar.toggle', category: 'bookmark', labelKey: 'action.bookmark.bar.toggle',
    defaultKey: 'Ctrl+Shift+B', when: 'global',
    run: ({ windowId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      ctx?.chrome.webContents.send('bookmark-bar:toggle')
    },
  })

  registerAction({
    id: 'action.sidepanel.left.toggle', category: 'sidepanel', labelKey: 'action.sidepanel.left.toggle',
    defaultKey: 'Ctrl+B', when: 'global',
    run: ({ windowId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      ctx?.chrome.webContents.send('sidepanel:toggle', { side: 'left' })
    },
  })

  registerAction({
    id: 'action.sidepanel.right.toggle', category: 'sidepanel', labelKey: 'action.sidepanel.right.toggle',
    defaultKey: 'Ctrl+Alt+B', when: 'global',
    run: ({ windowId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      ctx?.chrome.webContents.send('sidepanel:toggle', { side: 'right' })
    },
  })

  registerAction({
    id: 'action.ai.open', category: 'tools', labelKey: 'action.ai.open',
    defaultKey: 'Ctrl+Shift+Space', when: 'global',
    run: ({ windowId, tabId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      const id = tabId ?? activeTabIdOf(windowId ?? ctx?.id)
      ctx?.chrome.webContents.send('ai:open', { tabId: id })
    },
  })

  registerAction({
    id: 'action.ai.summarize', category: 'tools', labelKey: 'action.ai.summarize', when: 'global',
    run: ({ windowId, tabId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      const id = tabId ?? activeTabIdOf(windowId ?? ctx?.id)
      ctx?.chrome.webContents.send('ai:summarize', { tabId: id })
    },
  })

  registerAction({
    id: 'action.ai.write', category: 'tools', labelKey: 'action.ai.write', when: 'global',
    run: ({ windowId, tabId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      const id = tabId ?? activeTabIdOf(windowId ?? ctx?.id)
      ctx?.chrome.webContents.send('ai:write', { tabId: id })
    },
  })

  registerAction({
    id: 'action.tab.reader', category: 'tab', labelKey: 'action.tab.reader',
    defaultKey: 'Ctrl+Alt+R', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      const wc = id ? getWebContentsByTabId(id) : null
      if (!wc) return
      void toggleReader(wc).then((on) => {
        broadcastToast(windowId, on ? tMain('main.toast.readerOn', '리더 모드 📖') : tMain('main.toast.readerOff', '원본 보기'))
      })
    },
  })

  registerAction({
    id: 'action.translate.page', category: 'tab', labelKey: 'action.translate.page',
    defaultKey: 'Ctrl+Shift+L', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      const wc = id ? getWebContentsByTabId(id) : null
      if (!wc) return
      broadcastToast(windowId, tMain('main.toast.translating', '번역 중… ⏳'))
      void togglePageTranslate(wc).then((r) => {
        if (r.restored) broadcastToast(windowId, tMain('main.toast.translateRestored', '원본 복원'))
        else if (r.started) broadcastToast(windowId, tMain('main.toast.translateDone', '번역 완료 🌐'))
      }).catch((err) => {
        console.warn('[translate] failed', err)
        broadcastToast(windowId, tMain('main.toast.translateFail', '번역 실패'))
      })
    },
  })

  registerAction({
    id: 'action.userscript.toggle', category: 'freedom', labelKey: 'action.userscript.toggle',
    defaultKey: 'Ctrl+Shift+U', when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      createTab({ windowId, url: 'browser://userscripts' })
    },
  })

  registerAction({
    id: 'action.policy.open', category: 'freedom', labelKey: 'action.policy.open',
    defaultKey: 'Ctrl+Shift+Y', when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      createTab({ windowId, url: 'browser://policies' })
    },
  })

  registerAction({
    id: 'action.macros.open', category: 'freedom', labelKey: 'action.macros.open',
    when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      createTab({ windowId, url: 'browser://macros' })
    },
  })

  registerAction({
    id: 'action.mods.open', category: 'freedom', labelKey: 'action.mods.open',
    when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      createTab({ windowId, url: 'browser://mods' })
    },
  })

  registerAction({
    id: 'action.memory.open', category: 'tools', labelKey: 'action.memory.open',
    when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      createTab({ windowId, url: 'browser://memory' })
    },
  })

  registerAction({
    id: 'action.ai.collectors', category: 'tools', labelKey: 'action.ai.collectors',
    when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      createTab({ windowId, url: 'browser://ai-collectors' })
    },
  })

  registerAction({
    id: 'action.extensions.open', category: 'tools', labelKey: 'action.extensions.open',
    defaultKey: 'Ctrl+Shift+X', when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      createTab({ windowId, url: 'browser://extensions' })
    },
  })

  registerAction({
    id: 'action.adblock.openPage', category: 'tools', labelKey: 'action.adblock.openPage',
    when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      createTab({ windowId, url: 'browser://adblock' })
    },
  })

  registerAction({
    id: 'action.perf.open', category: 'tools', labelKey: 'action.perf.open',
    when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      createTab({ windowId, url: 'browser://perf' })
    },
  })

  registerAction({
    id: 'action.keymap.open', category: 'tools', labelKey: 'action.keymap.open',
    when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      createTab({ windowId, url: 'browser://keymap' })
    },
  })

  registerAction({
    id: 'action.update.check', category: 'app', labelKey: 'action.update.check',
    when: 'global',
    run: ({ windowId }) => {
      void checkForUpdatesNow(false).then((s) => {
        if (s.state === 'available') broadcastToast(windowId, tMain('main.toast.updateAvailable', `새 버전 ${s.available} 발견`, { version: String(s.available) }))
        else if (s.state === 'not-available') broadcastToast(windowId, tMain('main.toast.updateLatest', '최신 버전입니다 ✓'))
        else if (s.state === 'downloaded') broadcastToast(windowId, tMain('main.toast.updateReady', '업데이트 준비 완료 — 재시작 시 적용'))
        else if (s.state === 'disabled') broadcastToast(windowId, s.error ?? tMain('main.toast.updateDisabled', '자동 업데이트 비활성'))
        else if (s.state === 'error') broadcastToast(windowId, tMain('main.toast.updateCheckFail', `업데이트 확인 실패: ${s.error}`, { error: String(s.error) }))
      })
    },
  })

  registerAction({
    id: 'action.adblock.toggleSite', category: 'tools', labelKey: 'action.adblock.toggleSite',
    defaultKey: 'Ctrl+Alt+A', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      const wc = id ? getWebContentsByTabId(id) : null
      const url = wc?.getURL() ?? ''
      if (!url) {
        broadcastToast(windowId, tMain('main.toast.noTabUrl', '현재 탭 URL 을 확인할 수 없습니다'))
        return
      }
      void toggleSiteAdblock(url).then(({ host, allowed }) => {
        if (!host) {
          broadcastToast(windowId, tMain('main.toast.adblockNotApplicable', '이 페이지에 광고차단을 적용할 수 없습니다'))
          return
        }
        // allowed=true → 이 사이트에서 광고차단 "꺼짐"(허용), false → "켜짐"
        broadcastToast(windowId, allowed
          ? tMain('main.toast.adblockOffReload', `🛡️ ${host} — 광고차단 꺼짐 · 새로고침 중…`, { host })
          : tMain('main.toast.adblockOnReload', `🛡️ ${host} — 광고차단 켜짐 · 새로고침 중…`, { host }))
        // 변경은 새 요청부터 적용되므로 탭을 새로고침해 결과가 바로 보이게 한다.
        try { wc?.reload() } catch { /* ignore */ }
      })
    },
  })

  registerAction({
    id: 'action.settings.open', category: 'app', labelKey: 'action.settings.open',
    defaultKey: 'Ctrl+,', when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      createTab({ windowId, url: 'browser://settings' })
    },
  })

  registerAction({
    id: 'action.password.open', category: 'tools', labelKey: 'action.password.open',
    defaultKey: 'Ctrl+Shift+;', when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      createTab({ windowId, url: 'browser://passwords' })
    },
  })

  registerAction({
    id: 'action.workspace.next', category: 'workspace', labelKey: 'action.workspace.next',
    defaultKey: 'Ctrl+Alt+Right', when: 'global',
    run: ({ windowId }) => {
      const next = nextWorkspaceId(1)
      if (next) {
        void setActiveWorkspace(next)
        const ws = listWorkspaces().find((w) => w.id === next)
        if (ws) broadcastToast(windowId, tMain('main.toast.workspaceSwitched', `스페이스: ${ws.name}`, { name: ws.name }))
      }
    },
  })

  registerAction({
    id: 'action.workspace.prev', category: 'workspace', labelKey: 'action.workspace.prev',
    defaultKey: 'Ctrl+Alt+Left', when: 'global',
    run: ({ windowId }) => {
      const prev = nextWorkspaceId(-1)
      if (prev) {
        void setActiveWorkspace(prev)
        const ws = listWorkspaces().find((w) => w.id === prev)
        if (ws) broadcastToast(windowId, tMain('main.toast.workspaceSwitched', `스페이스: ${ws.name}`, { name: ws.name }))
      }
    },
  })

  registerAction({
    id: 'action.workspace.new', category: 'workspace', labelKey: 'action.workspace.new',
    defaultKey: 'Ctrl+Alt+N', when: 'global',
    run: async ({ windowId }) => {
      const ws = await createWorkspace()
      await setActiveWorkspace(ws.id)
      broadcastToast(windowId, tMain('main.toast.workspaceCreated', `새 스페이스 ${ws.name} 생성됨`, { name: ws.name }))
    },
  })

  for (let i = 1; i <= 5; i += 1) {
    const idx = i
    registerAction({
      id: `action.workspace.switch.${idx}`, category: 'workspace',
      labelKey: 'action.workspace.switch', defaultKey: `Ctrl+Alt+${idx}`, when: 'global',
      run: ({ windowId }) => {
        const list = listWorkspaces()
        const target = list[idx - 1]
        if (target && target.id !== getActiveWorkspaceId()) {
          void setActiveWorkspace(target.id)
          broadcastToast(windowId, tMain('main.toast.workspaceSwitched', `스페이스: ${target.name}`, { name: target.name }))
        }
      },
    })
  }

  function moveActiveTabTo(windowId: string | undefined, direction: 1 | -1): void {
    if (!windowId) return
    const list = listWorkspaces()
    if (list.length <= 1) {
      broadcastToast(windowId, tMain('main.toast.workspaceOnlyOne', '스페이스가 하나뿐입니다'))
      return
    }
    const activeWsId = getActiveWorkspaceId()
    const i = list.findIndex((w) => w.id === activeWsId)
    if (i < 0) return
    const target = list[(i + direction + list.length) % list.length]
    if (!target) return
    const tabId = activeTabIdOf(windowId)
    if (!tabId) return
    const result = moveTabToWorkspace(tabId, target.id)
    if (!result.moved) {
      broadcastToast(windowId, tMain('main.toast.tabMoveFail', '탭 이동 실패'))
      return
    }
    const suffix = result.needsReload ? tMain('main.toast.reloadSuffix', ' · 페이지 재로드') : ''
    broadcastToast(windowId, tMain('main.toast.tabMoved', `탭 이동 → ${target.name}${suffix}`, { name: target.name, suffix }))
  }

  registerAction({
    id: 'action.tab.move.next.workspace', category: 'workspace',
    labelKey: 'action.tab.move.next.workspace',
    defaultKey: 'Ctrl+Shift+PageDown', when: 'global',
    run: ({ windowId }) => moveActiveTabTo(windowId, 1),
  })

  registerAction({
    id: 'action.tab.move.prev.workspace', category: 'workspace',
    labelKey: 'action.tab.move.prev.workspace',
    defaultKey: 'Ctrl+Shift+PageUp', when: 'global',
    run: ({ windowId }) => moveActiveTabTo(windowId, -1),
  })

  registerAction({
    id: 'action.qrcode.show', category: 'tools', labelKey: 'action.qrcode.show',
    defaultKey: 'Ctrl+Shift+Q', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      const t = id ? getTab(id) : null
      const url = t?.url
      if (!url) return
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      ctx?.chrome.webContents.send('qrcode:open', { url })
    },
  })

  registerAction({
    id: 'action.darkmode.toggle', category: 'appearance', labelKey: 'action.darkmode.toggle',
    defaultKey: 'Ctrl+Shift+D', when: 'global',
    run: ({ windowId }) => {
      void toggleForcePageDark().then((enabled) => {
        broadcastToast(windowId, enabled ? tMain('main.toast.darkForceOn', '강제 다크 모드 켜짐 🌙') : tMain('main.toast.darkForceOff', '강제 다크 모드 꺼짐 ☀'))
      })
    },
  })

  registerAction({
    id: 'action.darkmode.toggleSite', category: 'appearance', labelKey: 'action.darkmode.toggleSite',
    defaultKey: 'Ctrl+Alt+D', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      const wc = id ? getWebContentsByTabId(id) : null
      const url = wc?.getURL() ?? ''
      if (!url) {
        broadcastToast(windowId, tMain('main.toast.noTabUrl', '현재 탭 URL 을 확인할 수 없습니다'))
        return
      }
      void toggleSiteDark(url).then(({ origin, state }) => {
        if (!origin) {
          broadcastToast(windowId, tMain('main.toast.darkSiteNotApplicable', '이 페이지에는 사이트별 다크 모드를 적용할 수 없습니다'))
          return
        }
        const label = state === 'on' ? tMain('main.toast.siteDarkOn', `사이트 다크 켜짐 🌙 (${origin})`, { origin })
          : state === 'off' ? tMain('main.toast.siteDarkOff', `사이트 다크 꺼짐 ☀ (${origin})`, { origin })
          : tMain('main.toast.siteDarkDefault', `사이트 다크 기본값 따름 (${origin})`, { origin })
        broadcastToast(windowId, label)
      })
    },
  })

  registerAction({
    id: 'action.darkmode.followSystem', category: 'appearance', labelKey: 'action.darkmode.followSystem',
    when: 'global',
    run: ({ windowId }) => {
      const cur = getSetting('appearance').pageDarkFollowSystem === true
      void setFollowSystemDark(!cur).then(() => {
        broadcastToast(windowId, !cur ? tMain('main.toast.followSystemOn', 'OS 다크 모드 따라가기 켜짐 🌓') : tMain('main.toast.followSystemOff', 'OS 다크 모드 따라가기 꺼짐'))
      })
    },
  })

  registerAction({
    id: 'action.tabbar.cycle', category: 'layout', labelKey: 'action.tabbar.cycle',
    defaultKey: 'Ctrl+Alt+T', when: 'global',
    run: ({ windowId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      ctx?.chrome.webContents.send('tabbar:cycle-orientation')
    },
  })

  registerAction({
    id: 'action.pane.split.h', category: 'layout', labelKey: 'action.pane.split.h',
    defaultKey: 'Ctrl+\\', when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      splitWindow(windowId, 'h')
      broadcastToast(windowId, tMain('main.toast.splitH', '좌우 분할 ⫾'))
    },
  })

  registerAction({
    id: 'action.pane.split.v', category: 'layout', labelKey: 'action.pane.split.v',
    defaultKey: 'Ctrl+Alt+-', when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      splitWindow(windowId, 'v')
      broadcastToast(windowId, tMain('main.toast.splitV', '상하 분할 ⫿'))
    },
  })

  registerAction({
    id: 'action.pane.unsplit', category: 'layout', labelKey: 'action.pane.unsplit',
    defaultKey: 'Ctrl+Alt+0', when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      unsplitWindow(windowId)
      broadcastToast(windowId, tMain('main.toast.unsplit', '분할 해제'))
    },
  })

  registerAction({
    id: 'action.pane.focus.next', category: 'layout', labelKey: 'action.pane.focus.next',
    defaultKey: 'Ctrl+`', when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      focusNextPane(windowId)
    },
  })

  registerAction({
    id: 'action.downloads.open', category: 'tools', labelKey: 'action.downloads.open',
    defaultKey: 'Ctrl+J', when: 'global',
    run: ({ windowId }) => {
      const ctx = windowId ? getWindow(windowId) : getAllWindows()[0]
      ctx?.chrome.webContents.send('panel:open', { panel: 'downloads' })
    },
  })

  registerAction({
    id: 'action.downloads.openPage', category: 'tools', labelKey: 'action.downloads.openPage',
    defaultKey: 'Ctrl+Shift+J', when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      createTab({ windowId, url: 'browser://downloads' })
    },
  })

  registerAction({
    id: 'action.tab.mute', category: 'tab', labelKey: 'action.tab.mute', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      if (!id) return
      const summary = listTabs(windowId ?? '').find((t) => t.id === id)
      setTabMuted(id, !summary?.muted)
    },
  })

  registerAction({
    id: 'action.tab.muteOthers', category: 'tab', labelKey: 'action.tab.muteOthers', when: 'global',
    run: ({ windowId, tabId }) => {
      if (!windowId) return
      const id = tabId ?? activeTabIdOf(windowId)
      let n = 0
      for (const t of listTabs(windowId)) if (t.id !== id && !t.muted) { setTabMuted(t.id, true); n += 1 }
      broadcastToast(windowId, n > 0 ? tMain('main.toast.muteOthersDone', `다른 탭 ${n}개 음소거됨 🔇`, { count: n }) : tMain('main.toast.muteOthersNone', '음소거할 다른 탭이 없습니다'))
    },
  })

  registerAction({
    id: 'action.tab.unmuteAll', category: 'tab', labelKey: 'action.tab.unmuteAll', when: 'global',
    run: ({ windowId }) => {
      if (!windowId) return
      let n = 0
      for (const t of listTabs(windowId)) if (t.muted) { setTabMuted(t.id, false); n += 1 }
      broadcastToast(windowId, n > 0 ? tMain('main.toast.unmuteAllDone', `${n}개 탭 음소거 해제 🔊`, { count: n }) : tMain('main.toast.unmuteAllNone', '음소거된 탭이 없습니다'))
    },
  })

  registerAction({
    id: 'action.sitedata.clear', category: 'tools', labelKey: 'action.sitedata.clear', when: 'global',
    run: ({ windowId, tabId }) => {
      const id = tabId ?? activeTabIdOf(windowId)
      const wc = id ? getWebContentsByTabId(id) : null
      const url = wc?.getURL() ?? ''
      let origin: string | null = null
      try {
        const u = new URL(url)
        if (u.protocol === 'http:' || u.protocol === 'https:') origin = u.origin
      } catch { /* invalid url */ }
      if (!origin) {
        broadcastToast(windowId, tMain('main.toast.siteDataNotApplicable', '이 페이지의 사이트 데이터는 지울 수 없습니다'))
        return
      }
      void clearSiteData(origin).then(() => {
        broadcastToast(windowId, tMain('main.toast.siteDataCleared', '사이트 데이터 삭제됨 · 새로고침 중… 🗑'))
        try { wc?.reload() } catch { /* ignore */ }
      })
    },
  })

  // 탭 직접 점프 액션은 명령 팔레트가 동적으로 생성 (action.tab.goto.<N>)
  for (let i = 1; i <= 9; i += 1) {
    const idx = i
    registerAction({
      id: `action.tab.goto.${idx}`, category: 'tab',
      labelKey: 'action.tab.goto', defaultKey: `Ctrl+${idx}`, when: 'global',
      run: ({ windowId }) => {
        if (!windowId) return
        const list = listTabs(windowId)
        const target = idx === 9 ? list[list.length - 1] : list[idx - 1]
        if (target) activateTab(target.id)
      },
    })
  }
}
