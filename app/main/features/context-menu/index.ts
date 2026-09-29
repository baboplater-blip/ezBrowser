import { Menu, clipboard, nativeImage, type MenuItemConstructorOptions, type WebContents, type ContextMenuParams } from 'electron'
import { net } from 'electron'
import { IPC } from '../../../shared/ipc-channels'
import { createTab, getTab } from '../../tabs/tab-service'
import { buildSearchUrl, getDefaultEngine } from '../../storage/search-engines'
import { addBookmark } from '../../storage/bookmarks'
import { startFind } from '../find'
import { createBrowserWindow, getWindow } from '../../windows/window-service'
import { collectMenuItems } from '../mod-api'
import { handleOverlayDownload } from '../video-download'
import { tMain } from '../../i18n'

const SEARCH_LABEL_MAX = 24

function M(suffix: string, fallback: string, vars?: Record<string, string | number>): string {
  return tMain(`main.contextMenu.${suffix}`, fallback, vars)
}

function truncate(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * 원격 이미지를 다운로드해 클립보드에 복사. data:/blob: 은 직접 처리.
 */
async function copyImageToClipboard(srcUrl: string): Promise<void> {
  try {
    if (srcUrl.startsWith('data:')) {
      const img = nativeImage.createFromDataURL(srcUrl)
      if (!img.isEmpty()) clipboard.writeImage(img)
      return
    }
    const res = await net.fetch(srcUrl)
    const buf = Buffer.from(await res.arrayBuffer())
    const img = nativeImage.createFromBuffer(buf)
    if (!img.isEmpty()) clipboard.writeImage(img)
  } catch (err) {
    console.warn('[context-menu] copy image failed', err)
  }
}

function buildTemplate(
  wc: WebContents,
  tabId: string,
  windowId: string,
  params: ContextMenuParams,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []
  const sep = (): void => { template.push({ type: 'separator' }) }

  // ===== 링크 =====
  if (params.linkURL) {
    const link = params.linkURL
    template.push(
      { label: M('link.openNewTab', '새 탭에서 링크 열기'), click: () => { createTab({ windowId, url: link, background: true }) } },
      {
        label: M('link.openNewWindow', '새 창에서 링크 열기'),
        click: () => {
          const ctx = createBrowserWindow()
          createTab({ windowId: ctx.id, url: link })
        },
      },
      {
        label: M('link.openIncognito', '시크릿 창에서 링크 열기'),
        click: () => {
          const ctx = createBrowserWindow({ incognito: true })
          createTab({ windowId: ctx.id, url: link })
        },
      },
      { label: M('link.copyAddress', '링크 주소 복사'), click: () => clipboard.writeText(link) },
    )
    if (params.linkText) {
      template.push({ label: M('link.copyText', '링크 텍스트 복사'), click: () => clipboard.writeText(params.linkText) })
    }
    sep()
  }

  // ===== 이미지 =====
  if (params.mediaType === 'image' && params.srcURL) {
    const src = params.srcURL
    template.push(
      { label: M('image.openNewTab', '새 탭에서 이미지 열기'), click: () => { createTab({ windowId, url: src, background: true }) } },
      { label: M('image.copy', '이미지 복사'), click: () => { void copyImageToClipboard(src) } },
      { label: M('image.copyAddress', '이미지 주소 복사'), click: () => clipboard.writeText(src) },
      { label: M('image.download', '이미지 다운로드'), click: () => wc.downloadURL(src) },
    )
    sep()
  }

  // ===== 동영상/오디오 =====
  if (params.mediaType === 'video' || params.mediaType === 'audio') {
    const src = params.srcURL || ''
    template.push({
      label: M('media.download', '동영상 다운로드'),
      click: () => {
        // 스트림(HLS/blob)·직접 파일을 자동 판별해 yt-dlp/직접 다운로드로 라우팅
        void handleOverlayDownload({ videoSrc: src, pageUrl: wc.getURL(), senderWcId: wc.id })
      },
    })
    if (src && !src.startsWith('blob:')) {
      template.push({ label: M('media.copyAddress', '미디어 주소 복사'), click: () => clipboard.writeText(src) })
    }
    sep()
  }

  // ===== 선택 텍스트 =====
  if (params.selectionText && params.selectionText.trim()) {
    const sel = params.selectionText.trim()
    template.push({ label: M('selection.copy', '복사'), role: 'copy', enabled: params.editFlags.canCopy })
    const engine = getDefaultEngine()
    template.push({
      label: M('selection.searchWith', `${engine.name}에서 "${truncate(sel, SEARCH_LABEL_MAX)}" 검색`, { engine: engine.name, query: truncate(sel, SEARCH_LABEL_MAX) }),
      click: () => { createTab({ windowId, url: buildSearchUrl(sel, engine), background: false }) },
    })
    template.push({
      label: M('selection.findInPage', '선택 영역에서 찾기'),
      click: () => {
        const ctx = getWindow(windowId)
        ctx?.chrome.webContents.send(IPC.find.open, { initialText: sel.slice(0, 200) })
        startFind(tabId, sel.slice(0, 200))
      },
    })
    sep()
  }

  // ===== 맞춤법 제안 (오타 위에서 우클릭) =====
  if (params.isEditable && params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, 5)
    if (suggestions.length > 0) {
      for (const s of suggestions) {
        template.push({ label: s, click: () => wc.replaceMisspelling(s) })
      }
    } else {
      template.push({ label: M('spelling.none', '맞춤법 제안 없음'), enabled: false })
    }
    template.push({
      label: M('spelling.addToDictionary', '사전에 추가'),
      click: () => { wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
    })
    sep()
  }

  // ===== 편집 가능한 입력 =====
  if (params.isEditable) {
    template.push(
      { label: M('edit.undo', '실행 취소'), role: 'undo', enabled: params.editFlags.canUndo },
      { label: M('edit.redo', '다시 실행'), role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { label: M('edit.cut', '잘라내기'), role: 'cut', enabled: params.editFlags.canCut },
      { label: M('edit.copy', '복사'), role: 'copy', enabled: params.editFlags.canCopy },
      { label: M('edit.paste', '붙여넣기'), role: 'paste', enabled: params.editFlags.canPaste },
      { label: M('edit.selectAll', '모두 선택'), role: 'selectAll', enabled: params.editFlags.canSelectAll },
    )
    sep()
  }

  // ===== 페이지 일반 (위 항목이 없을 때 = 빈 영역 우클릭) =====
  const isPlainPage = !params.linkURL && params.mediaType === 'none'
    && !(params.selectionText && params.selectionText.trim()) && !params.isEditable
  if (isPlainPage) {
    template.push(
      { label: M('page.back', '뒤로'), enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: M('page.forward', '앞으로'), enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: M('page.reload', '새로고침'), click: () => wc.reload() },
      { type: 'separator' },
      {
        label: M('page.addBookmark', '이 페이지 북마크 추가 ★'),
        click: () => {
          const t = getTab(tabId)
          if (t?.url && !/^browser:|^chrome:|^about:/i.test(t.url)) {
            addBookmark({ url: t.url, title: t.title || t.url })
            const ctx = getWindow(windowId)
            ctx?.chrome.webContents.send('toast:show', { message: tMain('main.toast.bookmarkAdded', '북마크에 추가됨 ★'), ts: 0 })
          }
        },
      },
      { type: 'separator' },
    )
  }

  // ===== 모드가 등록한 메뉴 항목 =====
  const modItems = collectMenuItems()
  if (modItems.length > 0) {
    template.push({
      label: M('mods', '모드'),
      submenu: modItems.map((m) => ({
        label: m.label,
        click: () => {
          try { m.click() } catch (err) { console.warn(`[context-menu] mod "${m.modId}" menu click error`, err) }
        },
      })),
    })
    sep()
  }

  // ===== 항상 표시 =====
  template.push({
    label: M('viewSource', '페이지 소스 보기'),
    click: () => {
      const url = wc.getURL()
      if (/^https?:|^file:/i.test(url)) createTab({ windowId, url: `view-source:${url}`, background: true })
    },
  })
  template.push({
    label: M('inspect', '검사'),
    click: () => {
      wc.inspectElement(params.x, params.y)
      if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' })
    },
  })

  return template
}

/**
 * 탭 webContents 에 우클릭 컨텍스트 메뉴 부착. onTabCreated 훅에서 호출.
 */
export function trackContextMenu(wc: WebContents, tabId: string): void {
  const tab = getTab(tabId)
  const windowId = tab?.windowId
  if (!windowId) return
  wc.on('context-menu', (_e, params) => {
    const template = buildTemplate(wc, tabId, windowId, params)
    if (template.length === 0) return
    const menu = Menu.buildFromTemplate(template)
    const ctx = getWindow(windowId)
    if (ctx) menu.popup({ window: ctx.win })
    else menu.popup()
  })
}
