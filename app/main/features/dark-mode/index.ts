import { nativeTheme, type WebContents } from 'electron'
import { getSetting, setNestedSetting } from '../../storage/settings'

const DARK_CSS = `
:root, html { background-color: #1a1a1a !important; }
html { filter: invert(0.92) hue-rotate(180deg) contrast(0.92); }
img, video, picture, iframe, svg, [style*="background-image"],
canvas, embed, object {
  filter: invert(1) hue-rotate(180deg);
}
`.trim()

const installedKeys = new WeakMap<WebContents, string>()
const tracked = new Set<WebContents>()
let nativeThemeBound = false

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:') return null
    return u.origin
  } catch {
    return null
  }
}

function shouldApply(url: string): boolean {
  const appearance = getSetting('appearance')
  const overrides = appearance.pageDarkSiteOverrides ?? {}
  const origin = originOf(url)
  if (origin && Object.prototype.hasOwnProperty.call(overrides, origin)) {
    return overrides[origin] === true
  }
  if (appearance.pageDarkFollowSystem) {
    return nativeTheme.shouldUseDarkColors === true
  }
  return appearance.forcePageDark === true
}

async function applyTo(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return
  if (installedKeys.has(wc)) return
  try {
    const key = await wc.insertCSS(DARK_CSS, { cssOrigin: 'user' })
    installedKeys.set(wc, key)
  } catch (err) {
    console.warn('[dark-mode] insertCSS failed', err)
  }
}

async function removeFrom(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return
  const key = installedKeys.get(wc)
  if (!key) return
  try {
    await wc.removeInsertedCSS(key)
    installedKeys.delete(wc)
  } catch (err) {
    console.warn('[dark-mode] removeInsertedCSS failed', err)
  }
}

async function reconcile(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return
  const url = wc.getURL() ?? ''
  const want = shouldApply(url)
  const has = installedKeys.has(wc)
  if (want && !has) await applyTo(wc)
  else if (!want && has) await removeFrom(wc)
}

export function trackWebContents(wc: WebContents): void {
  if (tracked.has(wc)) return
  tracked.add(wc)

  const onChange = () => {
    installedKeys.delete(wc) // navigate 후 키 무효, 재주입 위해 키 폐기
    void reconcile(wc)
  }

  wc.on('did-finish-load', onChange)
  wc.on('did-navigate', onChange)
  wc.on('did-navigate-in-page', onChange)
  wc.once('destroyed', () => {
    tracked.delete(wc)
    installedKeys.delete(wc)
  })

  void reconcile(wc)
}

async function reapplyAll(): Promise<void> {
  for (const wc of tracked) await reconcile(wc)
}

export function bindNativeTheme(): void {
  if (nativeThemeBound) return
  nativeThemeBound = true
  nativeTheme.on('updated', () => {
    const appearance = getSetting('appearance')
    if (appearance.pageDarkFollowSystem) void reapplyAll()
  })
}

export async function setForcePageDark(enabled: boolean): Promise<void> {
  setNestedSetting('appearance.forcePageDark', enabled)
  await reapplyAll()
}

export function isForcePageDark(): boolean {
  return getSetting('appearance').forcePageDark === true
}

export function isFollowSystemDark(): boolean {
  return getSetting('appearance').pageDarkFollowSystem === true
}

export async function setFollowSystemDark(enabled: boolean): Promise<void> {
  setNestedSetting('appearance.pageDarkFollowSystem', enabled)
  await reapplyAll()
}

export async function setSiteDark(origin: string, enabled: boolean | null): Promise<void> {
  const appearance = getSetting('appearance')
  const overrides = { ...(appearance.pageDarkSiteOverrides ?? {}) }
  if (enabled === null) delete overrides[origin]
  else overrides[origin] = enabled
  setNestedSetting('appearance.pageDarkSiteOverrides', overrides)
  await reapplyAll()
}

export function getSiteDark(origin: string): 'on' | 'off' | 'inherit' {
  const overrides = getSetting('appearance').pageDarkSiteOverrides ?? {}
  if (!Object.prototype.hasOwnProperty.call(overrides, origin)) return 'inherit'
  return overrides[origin] ? 'on' : 'off'
}

export async function toggleForcePageDark(): Promise<boolean> {
  const next = !isForcePageDark()
  await setForcePageDark(next)
  return next
}

export async function toggleSiteDark(url: string): Promise<{ origin: string | null; state: 'on' | 'off' | 'inherit' }> {
  const origin = originOf(url)
  if (!origin) return { origin: null, state: 'inherit' }
  const cur = getSiteDark(origin)
  // cycle: inherit → on → off → inherit
  const next: 'on' | 'off' | 'inherit' = cur === 'inherit' ? 'on' : cur === 'on' ? 'off' : 'inherit'
  await setSiteDark(origin, next === 'inherit' ? null : next === 'on')
  return { origin, state: next }
}
