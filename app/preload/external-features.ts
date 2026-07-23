// 외부 사이트(http/https)에서 활성화되는 콘텐츠 후킹.
// content.ts (외부 사이트 시작 탭) 와 internal.ts (browser:// 시작 후 외부로 navigate 한 탭)
// 양쪽에서 import — esbuild bundle 이 inline.
//
// browser:// 페이지에서도 side-effect 안전 (가벼운 이벤트 리스너만).
//
// contextBridge 노출 없음 — 모든 IPC 는 ipcRenderer.invoke 직접.

import { ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'

// =========== 콘텐츠 기능 토글 캐시 (settings.freedom) ===========

interface ContentFlags {
  mouseGestures: boolean
  quickSearch: boolean
  hoverTranslate: boolean
  hoverTranslateTarget: string
}
const flags: ContentFlags = {
  mouseGestures: true, quickSearch: true,
  hoverTranslate: false, hoverTranslateTarget: 'ko',
}

void (async () => {
  try {
    const f = await ipcRenderer.invoke(IPC.settings.get, { key: 'freedom' }) as Partial<ContentFlags & Record<string, unknown>>
    if (typeof f?.mouseGestures === 'boolean') flags.mouseGestures = f.mouseGestures
    if (typeof f?.quickSearch === 'boolean') flags.quickSearch = f.quickSearch
    if (typeof f?.hoverTranslate === 'boolean') flags.hoverTranslate = f.hoverTranslate
    if (typeof f?.hoverTranslateTarget === 'string') flags.hoverTranslateTarget = f.hoverTranslateTarget
  } catch { /* ignore — default ON */ }
})()
ipcRenderer.on(IPC.settings.changed, (_e, settings: { freedom?: Partial<ContentFlags> }) => {
  const f = settings?.freedom
  if (!f) return
  if (typeof f.mouseGestures === 'boolean') flags.mouseGestures = f.mouseGestures
  if (typeof f.quickSearch === 'boolean') flags.quickSearch = f.quickSearch
  if (typeof f.hoverTranslate === 'boolean') flags.hoverTranslate = f.hoverTranslate
  if (typeof f.hoverTranslateTarget === 'string') flags.hoverTranslateTarget = f.hoverTranslateTarget
})

function prefersDark(): boolean {
  try { return window.matchMedia?.('(prefers-color-scheme: dark)').matches === true } catch { return false }
}

// =========== 마우스 제스처 (우클릭 드래그) ===========

type GestureAction = 'back' | 'forward' | 'reload' | 'tab.new' | 'tab.close'
const GESTURE_TRIGGER_PX = 30
const GESTURE_L_MIN_PX = 60

let gestureActive = false
let gestureStartX = 0
let gestureStartY = 0
let gestureUsed = false
let gestureHintEl: HTMLElement | null = null
let gesturePath: Array<{ x: number; y: number }> = []

function ensureHint(): HTMLElement {
  if (gestureHintEl) return gestureHintEl
  const el = document.createElement('div')
  el.setAttribute('data-bb-gesture-hint', '1')
  el.style.cssText = [
    'position:fixed', 'z-index:2147483645', 'pointer-events:none',
    'top:0', 'left:0',
    `color:${prefersDark() ? '#f2f2f5' : '#1a1a1a'}`,
    'font:600 13px -apple-system,BlinkMacSystemFont,Segoe UI,Pretendard,sans-serif',
    'padding:6px 12px', 'border-radius:14px',
    `background:${prefersDark() ? 'rgba(20,20,24,0.92)' : 'rgba(255,255,255,0.92)'}`,
    'box-shadow:0 4px 14px rgba(0,0,0,0.25)',
    'transition:opacity .1s ease',
  ].join(';')
  document.body.appendChild(el)
  gestureHintEl = el
  return el
}
function showHint(text: string, x: number, y: number): void {
  const el = ensureHint()
  el.style.transform = `translate(${Math.min(window.innerWidth - 200, x + 16)}px, ${Math.min(window.innerHeight - 40, y + 16)}px)`
  el.textContent = text
  el.style.opacity = '1'
}
function clearGestureHint(): void {
  if (gestureHintEl) { gestureHintEl.remove(); gestureHintEl = null }
}

function describePath(path: Array<{ x: number; y: number }>): GestureAction | null {
  if (path.length < 2) return null
  const first = path[0]
  const last = path[path.length - 1]
  if (!first || !last) return null
  const dxTotal = last.x - first.x
  const dyTotal = last.y - first.y
  const absX = Math.abs(dxTotal)
  const absY = Math.abs(dyTotal)

  // L자 검출 — 시작 후 아래로 충분히 갔다가 좌/우로 꺾이면 tab.close
  if (absX >= GESTURE_L_MIN_PX && absY >= GESTURE_L_MIN_PX) {
    let maxYIdx = 0
    for (let i = 0; i < path.length; i += 1) {
      const p = path[i]
      if (!p) continue
      const m = path[maxYIdx]
      if (m && p.y > m.y) maxYIdx = i
    }
    const peak = path[maxYIdx]
    if (peak && maxYIdx > 0 && maxYIdx < path.length - 1
        && peak.y - first.y >= GESTURE_L_MIN_PX
        && Math.abs(last.x - peak.x) >= GESTURE_L_MIN_PX) {
      return 'tab.close'
    }
  }

  if (absX < GESTURE_TRIGGER_PX && absY < GESTURE_TRIGGER_PX) return null
  if (absX > absY) return dxTotal < 0 ? 'back' : 'forward'
  return dyTotal < 0 ? 'reload' : 'tab.new'
}

const GESTURE_LABEL: Record<GestureAction, string> = {
  'back': '← 뒤로',
  'forward': '앞으로 →',
  'reload': '↑ 새로고침',
  'tab.new': '↓ 새 탭',
  'tab.close': '↓→ 탭 닫기',
}

document.addEventListener('mousedown', (e) => {
  if (!flags.mouseGestures) return
  if (e.button !== 2) return
  gestureActive = true
  gestureStartX = e.clientX
  gestureStartY = e.clientY
  gestureUsed = false
  gesturePath = [{ x: e.clientX, y: e.clientY }]
})

document.addEventListener('mousemove', (e) => {
  if (!gestureActive) return
  // 1px 이상 이동 시 path 에 추가, 단 매우 자주 push 되지 않도록 최소 거리 8px
  const last = gesturePath[gesturePath.length - 1]
  if (!last) return
  const ddx = e.clientX - last.x
  const ddy = e.clientY - last.y
  if (ddx * ddx + ddy * ddy < 64) return
  gesturePath.push({ x: e.clientX, y: e.clientY })
  const tentative = describePath(gesturePath)
  if (tentative) showHint(GESTURE_LABEL[tentative], e.clientX, e.clientY)
})

document.addEventListener('mouseup', (e) => {
  if (e.button !== 2 || !gestureActive) return
  gestureActive = false
  gesturePath.push({ x: e.clientX, y: e.clientY })
  const action = describePath(gesturePath)
  gesturePath = []
  clearGestureHint()
  if (!action) return
  gestureUsed = true
  void ipcRenderer.invoke(IPC.gesture.exec, { action })
})

document.addEventListener('contextmenu', (e) => {
  if (gestureUsed) {
    e.preventDefault()
    gestureUsed = false
  }
}, true)

// =========== 빠른 검색 (텍스트 드래그 시 떠오르는 검색 버튼) ===========

let quickSearchEl: HTMLElement | null = null

function hideQuickSearch(): void {
  if (quickSearchEl) {
    quickSearchEl.remove()
    quickSearchEl = null
  }
}

function showQuickSearch(text: string, x: number, y: number): void {
  hideQuickSearch()
  const dark = prefersDark()
  const btn = document.createElement('div')
  btn.setAttribute('data-bb-quicksearch', '1')
  btn.style.cssText = [
    'position:fixed', 'z-index:2147483647',
    `top:${Math.max(8, y + 12)}px`,
    `left:${Math.max(8, Math.min(window.innerWidth - 100, x))}px`,
    'padding:5px 12px',
    `border:1px solid ${dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)'}`,
    'border-radius:14px',
    `background:${dark ? '#1f1f24' : '#ffffff'}`,
    `color:${dark ? '#f2f2f5' : '#1a1a1a'}`,
    'font-size:12px',
    'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Pretendard,Apple SD Gothic Neo,sans-serif',
    'cursor:pointer',
    'box-shadow:0 4px 14px rgba(0,0,0,0.18)',
    'user-select:none',
    '-webkit-user-select:none',
  ].join(';')
  btn.textContent = `🔍 "${text.length > 24 ? text.slice(0, 24) + '…' : text}"`
  btn.addEventListener('mousedown', (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    void ipcRenderer.invoke(IPC.quickSearch.open, { query: text })
    hideQuickSearch()
  })
  document.body.appendChild(btn)
  quickSearchEl = btn
}

document.addEventListener('mouseup', (e) => {
  if (!flags.quickSearch) return
  if (e.button !== 0) return
  if ((e.target as HTMLElement | null)?.hasAttribute?.('data-bb-quicksearch')) return
  setTimeout(() => {
    const sel = window.getSelection()
    const text = sel?.toString().trim() ?? ''
    if (text.length < 2 || text.length > 200 || /^\s*$/.test(text)) {
      hideQuickSearch()
      return
    }
    showQuickSearch(text, e.clientX, e.clientY)
  }, 10)
})

document.addEventListener('mousedown', (e) => {
  if ((e.target as HTMLElement | null)?.hasAttribute?.('data-bb-quicksearch')) return
  hideQuickSearch()
})

window.addEventListener('scroll', hideQuickSearch, true)
window.addEventListener('blur', hideQuickSearch)

// =========== 비밀번호 매니저 (자동 입력 + 자동 저장 제안) ===========

interface PasswordMatch { id: string; username: string; password: string }

function findPasswordInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('input[type=password]')) as HTMLInputElement[]
}

function findUsernameInputFor(passwordInput: HTMLInputElement): HTMLInputElement | null {
  const form = passwordInput.form
  const candidates: HTMLInputElement[] = []
  const inputs = form
    ? Array.from(form.querySelectorAll('input')) as HTMLInputElement[]
    : Array.from(document.querySelectorAll('input')) as HTMLInputElement[]
  for (const el of inputs) {
    if (el === passwordInput) break
    const t = (el.type || 'text').toLowerCase()
    if (t === 'text' || t === 'email' || t === 'tel') candidates.push(el)
  }
  if (candidates.length === 0) return null
  const byAutocomplete = candidates.find((e) => /username|email/i.test(e.autocomplete))
  if (byAutocomplete) return byAutocomplete
  const byName = candidates.find((e) => /user|login|email|id/i.test(`${e.name} ${e.id} ${e.placeholder}`))
  if (byName) return byName
  return candidates[candidates.length - 1] ?? null
}

function setNativeValue(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el)
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

let autofillApplied = false

async function tryAutofill(): Promise<void> {
  if (autofillApplied) return
  const pwInputs = findPasswordInputs()
  if (pwInputs.length === 0) return
  let matches: PasswordMatch[] = []
  try {
    matches = await ipcRenderer.invoke(IPC.password.lookup) as PasswordMatch[]
  } catch {
    return
  }
  if (!Array.isArray(matches) || matches.length === 0) return
  const m = matches[0]
  if (!m) return
  const firstPw = pwInputs[0]
  if (!firstPw) return
  const userInput = findUsernameInputFor(firstPw)
  if (userInput && !userInput.value) setNativeValue(userInput, m.username)
  if (!firstPw.value) setNativeValue(firstPw, m.password)
  autofillApplied = true
}

function watchForPasswordFields(): void {
  void tryAutofill()
  let timer: ReturnType<typeof setTimeout> | null = null
  const mo = new MutationObserver(() => {
    if (autofillApplied) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { void tryAutofill() }, 300)
  })
  mo.observe(document.documentElement, { childList: true, subtree: true })
}

async function captureCredentialsFromForm(form: HTMLFormElement): Promise<void> {
  const pwInputs = Array.from(form.querySelectorAll('input[type=password]')) as HTMLInputElement[]
  const pw = pwInputs.find((e) => e.value && e.value.length >= 1)
  if (!pw) return
  const userInput = findUsernameInputFor(pw)
  const username = userInput?.value?.trim()
  const password = pw.value
  if (!username || !password) return
  try {
    await ipcRenderer.invoke(IPC.password.proposeSave, { username, password })
  } catch { /* ignore */ }
}

document.addEventListener('submit', (e) => {
  const form = e.target as HTMLFormElement | null
  if (!form || !(form instanceof HTMLFormElement)) return
  void captureCredentialsFromForm(form)
}, true)

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', watchForPasswordFields, { once: true })
} else {
  watchForPasswordFields()
}

// =========== 동영상 오버레이 다운로드 버튼 (콕콕 스타일) ===========

const VIDEO_OVERLAY_ATTR = 'data-bb-video-overlay'
const VIDEO_TAGGED_ATTR = 'data-bb-video-overlayed'
const VIDEO_MIN_SIZE = 160
const BB_VIDEO_OVERLAY_ID = '__bbVideoOverlayInjected'

function isExcludedContext(): boolean {
  const proto = window.location.protocol
  if (proto === 'about:' || proto === 'data:' || proto === 'chrome:' || proto === 'devtools:') return true
  return false
}

function findVideoSrc(video: HTMLVideoElement): string {
  const sources = video.querySelectorAll('source[src]')
  for (const s of Array.from(sources)) {
    const el = s as HTMLSourceElement
    const url = el.src
    if (url && !url.startsWith('blob:')) return url
  }
  if (video.currentSrc && !video.currentSrc.startsWith('blob:')) return video.currentSrc
  if (video.src && !video.src.startsWith('blob:')) return video.src
  return video.currentSrc || video.src || ''
}

function createOverlayButton(video: HTMLVideoElement): HTMLElement {
  const wrap = document.createElement('div')
  wrap.setAttribute(VIDEO_OVERLAY_ATTR, '')
  wrap.style.cssText = [
    'position:absolute', 'top:8px', 'left:8px',
    'z-index:2147483646',
    'opacity:0.85', 'transition:opacity 0.15s ease, transform 0.1s ease',
    'pointer-events:auto',
  ].join(';')

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.title = '동영상 다운로드'
  btn.setAttribute('aria-label', '동영상 다운로드')
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13"/><path d="M5 12l7 7 7-7"/><path d="M5 21h14"/></svg>'
  btn.style.cssText = [
    'width:34px', 'height:34px',
    'display:flex', 'align-items:center', 'justify-content:center',
    'border:none', 'border-radius:50%',
    'background:rgba(30,180,90,0.95)', 'color:white',
    'cursor:pointer', 'box-shadow:0 2px 6px rgba(0,0,0,0.3)',
    'font-family:inherit', 'padding:0',
  ].join(';')

  btn.addEventListener('mouseenter', () => { wrap.style.opacity = '1'; wrap.style.transform = 'scale(1.06)' })
  btn.addEventListener('mouseleave', () => { wrap.style.opacity = '0.85'; wrap.style.transform = 'scale(1)' })

  btn.addEventListener('click', (e) => {
    if (!e.isTrusted) return // 페이지 스크립트의 합성 클릭으로 다운로드 트리거 차단
    e.stopPropagation()
    e.preventDefault()
    const src = findVideoSrc(video)
    void ipcRenderer.invoke(IPC.video.downloadFromOverlay, {
      videoSrc: src,
      pageUrl: window.location.href,
    }).catch((err) => console.warn('[bb] video overlay download failed', err))
    btn.style.background = 'rgba(52,120,246,0.95)'
    setTimeout(() => { btn.style.background = 'rgba(30,180,90,0.95)' }, 600)
  })

  wrap.appendChild(btn)
  return wrap
}

function isVideoBigEnough(video: HTMLVideoElement): boolean {
  const rect = video.getBoundingClientRect()
  if (rect.width >= VIDEO_MIN_SIZE && rect.height >= VIDEO_MIN_SIZE / 2) return true
  if (video.videoWidth >= VIDEO_MIN_SIZE && video.videoHeight >= VIDEO_MIN_SIZE / 2) return true
  return false
}

function attachOverlayToVideo(video: HTMLVideoElement): void {
  if (video.hasAttribute(VIDEO_TAGGED_ATTR)) return

  const parent = video.parentElement
  if (!parent) return
  const parentPos = window.getComputedStyle(parent).position
  if (parentPos === 'static') {
    parent.style.position = 'relative'
  }
  const overlay = createOverlayButton(video)
  parent.appendChild(overlay)
  video.setAttribute(VIDEO_TAGGED_ATTR, '1')

  function syncVisibility(): void {
    overlay.style.display = isVideoBigEnough(video) ? 'block' : 'none'
  }
  syncVisibility()
  try {
    const ro = new ResizeObserver(syncVisibility)
    ro.observe(video)
  } catch { /* ignore */ }
  video.addEventListener('loadedmetadata', syncVisibility)

  const cleanup = (): void => { try { overlay.remove() } catch { /* ignore */ } }
  ;(video as HTMLVideoElement & { __bbCleanup?: () => void }).__bbCleanup = cleanup
}

function scanAllVideos(): void {
  const videos = document.querySelectorAll('video')
  videos.forEach((v) => attachOverlayToVideo(v as HTMLVideoElement))
}

function initVideoOverlay(): void {
  if ((window as unknown as Record<string, unknown>)[BB_VIDEO_OVERLAY_ID]) return
  ;(window as unknown as Record<string, unknown>)[BB_VIDEO_OVERLAY_ID] = true

  if (isExcludedContext()) return

  try {
    document.documentElement.setAttribute('data-bb-content-loaded', '1')
    document.documentElement.setAttribute('data-bb-frame', window.top !== window.self ? 'sub' : 'top')
    document.documentElement.setAttribute('data-bb-href', window.location.href)
  } catch { /* ignore */ }

  scanAllVideos()
  const observer = new MutationObserver((mutations) => {
    let needScan = false
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue
        if (node.tagName === 'VIDEO') { attachOverlayToVideo(node as HTMLVideoElement); continue }
        if (node.querySelector && node.querySelector('video')) { needScan = true }
      }
    }
    if (needScan) scanAllVideos()
  })
  try {
    observer.observe(document.documentElement, { childList: true, subtree: true })
  } catch { /* ignore */ }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVideoOverlay, { once: true })
} else {
  initVideoOverlay()
}

// 추가 polling — DOMContentLoaded 후에도 player.js 가 lazy 로 video 추가하는 케이스 대응
// 1초 간격으로 15초간 scan. 광고 트래커 페이지엔 부담 없고, 비디오 사이트에서 결정적.
window.addEventListener('load', () => {
  try { scanAllVideos() } catch { /* ignore */ }
})
let scanPollCount = 0
const scanPollTimer = setInterval(() => {
  try { scanAllVideos() } catch { /* ignore */ }
  scanPollCount += 1
  if (scanPollCount >= 15) clearInterval(scanPollTimer)
}, 1000)
// 사용자 ▶ 클릭 등 첫 사용자 인터랙션 후에도 한 번 더 scan
document.addEventListener('click', () => {
  setTimeout(() => { try { scanAllVideos() } catch { /* ignore */ } }, 500)
  setTimeout(() => { try { scanAllVideos() } catch { /* ignore */ } }, 1500)
}, true)

// =========== 호버 단어 번역 (Alt 누른 상태에서 활성) ===========

let hoverTransEl: HTMLElement | null = null
let lastWord = ''
const hoverTransCache = new Map<string, string>()
let hoverPending = false

function hideHoverTrans(): void {
  if (hoverTransEl) { hoverTransEl.remove(); hoverTransEl = null }
  lastWord = ''
}

function isWordChar(c: string): boolean {
  if (!c) return false
  // 영문/숫자/유럽계 + 한자 + 일본어 + 한글
  return /[A-Za-z0-9À-ɏͰ-ϿЀ-ӿ぀-ヿ㐀-鿿가-힯]/.test(c)
}

function extractWordAt(node: Text, offset: number): { text: string; range: Range } | null {
  const data = node.data
  if (offset < 0 || offset > data.length) return null
  let start = offset
  let end = offset
  while (start > 0 && isWordChar(data[start - 1] ?? '')) start -= 1
  while (end < data.length && isWordChar(data[end] ?? '')) end += 1
  const text = data.slice(start, end).trim()
  if (!text || text.length < 2 || text.length > 60) return null
  // 숫자만은 제외
  if (/^[0-9.,]+$/.test(text)) return null
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  return { text, range }
}

async function translateWord(word: string, target: string): Promise<string> {
  const key = `${target}::${word}`
  const cached = hoverTransCache.get(key)
  if (cached !== undefined) return cached
  try {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='
      + encodeURIComponent(target) + '&dt=t&q=' + encodeURIComponent(word)
    const res = await fetch(url, { method: 'GET' })
    const data = await res.json() as unknown
    let combined = ''
    if (Array.isArray(data) && Array.isArray((data as unknown[])[0])) {
      for (const part of (data as Array<Array<unknown>>)[0] ?? []) {
        if (Array.isArray(part) && typeof part[0] === 'string') combined += part[0]
      }
    }
    const out = combined || ''
    hoverTransCache.set(key, out)
    return out
  } catch {
    return ''
  }
}

function showHoverTrans(text: string, translated: string, x: number, y: number): void {
  hideHoverTrans()
  const dark = prefersDark()
  const el = document.createElement('div')
  el.setAttribute('data-bb-hover-trans', '1')
  el.style.cssText = [
    'position:fixed', 'z-index:2147483646', 'pointer-events:none',
    `top:${Math.min(window.innerHeight - 80, y + 20)}px`,
    `left:${Math.max(8, Math.min(window.innerWidth - 320, x))}px`,
    `max-width:320px`,
    'padding:8px 12px',
    `border:1px solid ${dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)'}`,
    'border-radius:8px',
    `background:${dark ? '#1f1f24' : '#ffffff'}`,
    `color:${dark ? '#f2f2f5' : '#1a1a1a'}`,
    'font:13px -apple-system,BlinkMacSystemFont,Segoe UI,Pretendard,Apple SD Gothic Neo,sans-serif',
    'box-shadow:0 4px 14px rgba(0,0,0,0.18)',
  ].join(';')
  const orig = document.createElement('div')
  orig.style.cssText = `color:${dark ? '#9b9ba3' : '#5f5f66'};font-size:11px;margin-bottom:4px;`
  orig.textContent = text
  const trans = document.createElement('div')
  trans.style.cssText = 'font-weight:500;'
  trans.textContent = translated || '(번역 결과 없음)'
  el.appendChild(orig)
  el.appendChild(trans)
  document.body.appendChild(el)
  hoverTransEl = el
}

document.addEventListener('mousemove', (e) => {
  if (!flags.hoverTranslate) return
  if (!e.altKey) {
    if (hoverTransEl) hideHoverTrans()
    return
  }
  if (hoverPending) return
  const x = e.clientX
  const y = e.clientY
  let textNode: Text | null = null
  let offset = 0
  // caretRangeFromPoint 우선 — 대부분의 Chromium 에서 지원
  type Doc = Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  const d = document as Doc
  if (typeof d.caretRangeFromPoint === 'function') {
    const r = d.caretRangeFromPoint(x, y)
    if (r && r.startContainer && r.startContainer.nodeType === Node.TEXT_NODE) {
      textNode = r.startContainer as Text
      offset = r.startOffset
    }
  }
  if (!textNode) return
  const w = extractWordAt(textNode, offset)
  if (!w) return
  if (w.text === lastWord && hoverTransEl) return
  lastWord = w.text
  hoverPending = true
  void translateWord(w.text, flags.hoverTranslateTarget).then((tr) => {
    hoverPending = false
    if (lastWord !== w.text) return
    showHoverTrans(w.text, tr, x, y)
  })
})

document.addEventListener('keyup', (e) => {
  if (e.key === 'Alt' && hoverTransEl) hideHoverTrans()
})
window.addEventListener('scroll', hideHoverTrans, true)
window.addEventListener('blur', hideHoverTrans)

// =========== anti-adblock 탐지 우회 (사이트별) ===========
// 일부 사이트는 "광고 차단기를 비활성화하세요" 전체화면 오버레이 + 스크롤 잠금으로 이용을 막는다.
// 아래 도메인에 한해, 콘텐츠 preload(격리 컨텍스트)에서 그 오버레이를 제거하고 스크롤을 복원한다.
// 광고차단 문구를 포함한 요소만 제거하므로 일반 모달/콘텐츠는 건드리지 않는다.
const ANTI_ADBLOCK_HOSTS: RegExp[] = [
  /(^|\.)sogirl\.so$/i,
]
const ANTI_ADBLOCK_KW = /광고\s*차단|차단\s*기|애드\s*블[록로]|adblock|ad-?block|블로커|adblocker/i

function isAntiAdblockHost(): boolean {
  try { return ANTI_ADBLOCK_HOSTS.some((re) => re.test(window.location.hostname)) } catch { return false }
}

// 페이지 main world 에 광고 전역 스텁을 주입한다. preload(격리 컨텍스트)에서 page 의 전역을
// 직접 못 바꾸므로 <script> 태그로 삽입 → main world 에서 실행된다. document-start 에 page 스크립트보다
// 먼저 실행되어, "adsbygoogle 가 로드 안 됨" 식 탐지가 검사하기 전에 전역을 정의한다.
function injectAdStubs(): void {
  try {
    const code = `(function(){try{
      var ag = window.adsbygoogle;
      if (!ag || ag.loaded !== true) {
        var arr = (ag && typeof ag.push === 'function') ? ag : [];
        try { arr.loaded = true; } catch(e){}
        try { arr.push = function(){ return (arr.length||0); }; } catch(e){}
        window.adsbygoogle = arr;
      }
      window.google_ad_status = 1;
      window.canRunAds = true;
      window.isAdBlockActive = false;
    }catch(e){}})();`
    const s = document.createElement('script')
    s.textContent = code
    ;(document.head || document.documentElement).prepend(s)
    s.remove()
  } catch { /* ignore */ }
}

function defuseAntiAdblock(): void {
  // 0) 광고 전역 스텁 주입 — "광고 스크립트 미로드" 탐지 우회 (리디렉트가 ERR_UNSAFE_REDIRECT 로 막히는 대안)
  injectAdStubs()

  // 1) 스크롤 잠금 복원 — 페이지가 html/body 를 overflow:hidden 으로 잠그는 것을 강제 해제
  try {
    const style = document.createElement('style')
    style.setAttribute('data-bb-antiadblock', '')
    style.textContent = 'html,body{overflow:auto !important}'
    ;(document.head || document.documentElement).appendChild(style)
  } catch { /* ignore */ }

  // 숨김만 한다(remove 금지) — 사이트 탐지 함수가 그 요소를 다시 참조하다 throw 나 영상 로딩이
  // 끊기는 것을 방지. display:none 이면 충분히 안 보이고 클릭도 막힌다.
  const hideEl = (el: HTMLElement): void => {
    el.style.setProperty('display', 'none', 'important')
    el.style.setProperty('visibility', 'hidden', 'important')
    el.style.setProperty('pointer-events', 'none', 'important')
  }
  const removeWalls = (): void => {
    try {
      // 광고차단 "문구"를 포함한 fixed/absolute/sticky 요소만 숨긴다(안전). 전체화면 크기만으로
      // 판단하는 휴리스틱은 영상 플레이어를 오인할 수 있어 제거함 — 모달은 정밀 선택자(hideKnownAntiAdblockModals)가 처리.
      const nodes = document.querySelectorAll<HTMLElement>('body *')
      for (const el of Array.from(nodes)) {
        const pos = getComputedStyle(el).position
        if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') continue
        const hay = `${el.id} ${el.className} ${(el.textContent || '').slice(0, 300)}`
        if (ANTI_ADBLOCK_KW.test(hay)) hideEl(el)
      }
      // 잠금 복원(인라인 스타일로 다시 잠그는 경우 대비)
      document.documentElement.style.setProperty('overflow', 'auto', 'important')
      if (document.body) {
        document.body.style.setProperty('overflow', 'auto', 'important')
        document.body.style.setProperty('filter', 'none', 'important')
      }
    } catch { /* ignore */ }
  }

  // 즉시 + DOMContentLoaded + 짧은 관찰 윈도우 + 몇 차례 타이머 (탐지기가 늦게 띄우는 경우 대응)
  removeWalls()
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', removeWalls, { once: true })
  }
  let scheduled = false
  let observer: MutationObserver | null = null
  const onMutate = (): void => {
    if (scheduled) return
    scheduled = true
    setTimeout(() => { scheduled = false; removeWalls() }, 200) // throttle
  }
  try {
    observer = new MutationObserver(onMutate)
    observer.observe(document.documentElement, { childList: true, subtree: true })
  } catch { /* ignore */ }
  ;[400, 1000, 2500, 5000, 9000].forEach((t) => setTimeout(removeWalls, t))
  setTimeout(() => { try { observer?.disconnect() } catch { /* ignore */ } }, 12000) // 성능: 12초 후 관찰 종료
}

// 알려진 anti-adblock 플러그인 모달 — 클래스/식별자가 명확해 전역으로 숨겨도 안전하다.
// (예: WordPress 의 adde_modal_detector — 빨간 금지 아이콘 전체화면 모달)
const AA_MODAL_SELECTOR = [
  '[class*="adde_modal_detector"]',
  '[class*="adde-modal"]',
  '[id*="adde_modal"]',
  '.adblock-modal', '.adblocker-modal', '.adb-modal', '.adblock-detected',
  '.adblock-overlay', '.adblock-popup', '#adblock-modal', '#adblockDetector',
].join(',')

function hideKnownAntiAdblockModals(): void {
  // (1) CSS 주입 — 빠르고, 다시 추가돼도 계속 숨김. 단 사이트 CSP 가 막을 수 있다.
  try {
    const s = document.createElement('style')
    s.setAttribute('data-bb-aa-modal', '')
    s.textContent = `${AA_MODAL_SELECTOR}{display:none !important;visibility:hidden !important;opacity:0 !important;pointer-events:none !important;}`
    ;(document.head || document.documentElement).appendChild(s)
  } catch { /* ignore */ }

  // (2) JS 직접 숨김 — CSP 와 무관하게 확실히 적용. 모달이 있을 때만 스크롤/블러 복원.
  // 중요: 요소를 remove() 하지 않는다. 사이트의 탐지 함수(adde_modal_detector 등)가 그 요소를
  // 다시 참조하다 null 이 되어 throw → 영상 로딩 promise 체인이 끊기기 때문. 숨김만 하면 함수는
  // 정상 진행하고 모달은 계속 안 보인다.
  let loggedHidden = false
  const sweep = (): void => {
    try {
      const found = document.querySelectorAll<HTMLElement>(AA_MODAL_SELECTOR)
      if (found.length === 0) return
      for (const el of Array.from(found)) {
        el.style.setProperty('display', 'none', 'important')
        el.style.setProperty('visibility', 'hidden', 'important')
        el.style.setProperty('pointer-events', 'none', 'important')
      }
      document.documentElement.style.setProperty('overflow', 'auto', 'important')
      if (document.body) {
        document.body.style.setProperty('overflow', 'auto', 'important')
        document.body.style.setProperty('filter', 'none', 'important')
      }
      if (!loggedHidden) {
        loggedHidden = true
        console.info('[bb] anti-adblock modal hidden:', found.length)
      }
    } catch { /* ignore */ }
  }

  console.info('[bb] anti-adblock guard active @', window.location.hostname)
  sweep()
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sweep, { once: true })
  }
  let scheduled = false
  let observer: MutationObserver | null = null
  try {
    observer = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      setTimeout(() => { scheduled = false; sweep() }, 150)
    })
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id', 'style'] })
  } catch { /* ignore */ }
  ;[0, 300, 800, 1500, 3000, 6000].forEach((t) => setTimeout(sweep, t))
  setTimeout(() => { try { observer?.disconnect() } catch { /* ignore */ } }, 15000)
}

if (!isExcludedContext()) {
  hideKnownAntiAdblockModals()
  if (isAntiAdblockHost()) defuseAntiAdblock()
}
