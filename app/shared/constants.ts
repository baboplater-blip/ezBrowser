export const APP_NAME = 'ezBrowser'
export const APP_VERSION = '0.1.0'

export const CHROME_HEIGHT = 72
export const TABBAR_HEIGHT = 36
export const TOOLBAR_HEIGHT = 36
export const BOOKMARKBAR_HEIGHT = 32

export const NEW_TAB_URL = 'browser://newtab'
export const SETTINGS_URL = 'browser://settings'

export const DEFAULT_SESSION = 'persist:default'
export const incognitoPartition = (n: number) => `incognito-${n}`

export const SUGGEST_DEBOUNCE_MS = 150
export const SUGGEST_TIMEOUT_MS = 800

export const DISCARD_AFTER_MS = 30 * 60 * 1000

export const INTERNAL_URL_PREFIXES = [
  'browser://',
  'http://localhost:5173',
  'file://',
  'chrome-extension://',
]
