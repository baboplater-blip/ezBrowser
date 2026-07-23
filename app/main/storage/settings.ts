import Store from 'electron-store'

export interface AppSettings {
  appearance: {
    theme: 'system' | 'light' | 'dark'
    density: 'compact' | 'regular' | 'comfy'
    forcePageDark: boolean
    pageDarkFollowSystem: boolean
    pageDarkSiteOverrides: Record<string, boolean>
  }
  startup: {
    mode: 'newtab' | 'last-session' | 'urls'
    urls: string[]
  }
  search: {
    defaultEngine: string
    suggestEnabled: boolean
    bangsEnabled: boolean
  }
  privacy: {
    historyRetention: 'unlimited' | '1w' | '1m' | '3m' | '1y'
    blockThirdPartyCookies: boolean
  }
  adblock: {
    enabled: boolean
    level: 'lite' | 'standard' | 'strict' | 'custom'
    filters: {
      easylist: boolean
      easyprivacy: boolean
      kr: boolean
      antiAdblock: boolean
      fanboyAnnoyance: boolean
      fanboySocial: boolean
    }
    siteOverrides: Record<string, boolean>
  }
  downloads: {
    defaultPath: string
    askEveryTime: boolean
    accelerator: boolean
    torrentDht: boolean
    torrentMaxSeedRatio: number
  }
  freedom: {
    userChromeCss: boolean
    userChromeJs: boolean
    userscripts: boolean
    commandPalette: boolean
    modApi: boolean
    mouseGestures: boolean
    quickSearch: boolean
    hoverTranslate: boolean
    hoverTranslateTarget: string
  }
  ui: {
    bookmarkBarShow: boolean
    sidepanelLeftOpen: boolean
    sidepanelRightOpen: boolean
    tabbarOrientation: 'top' | 'left' | 'right'
    workspaceRailOpen: boolean
  }
  performance: {
    tabSleepEnabled: boolean
    tabSleepMinutes: number
  }
  tabs: {
    openBehavior: 'new-tab' | 'same-tab' | 'background-tab'
  }
  update: {
    channel: 'latest' | 'beta' | 'nightly'
    autoCheck: boolean
    autoDownload: boolean
    notifyOnUpdate: boolean
  }
  widgets: {
    weatherEnabled: boolean
    newsEnabled: boolean
    locationMode: 'auto' | 'manual'
    manualLat: number
    manualLon: number
    manualPlace: string
    units: 'metric' | 'imperial'
    newsTopic: 'headlines' | 'world' | 'nation' | 'business' | 'technology' | 'entertainment' | 'sports' | 'science' | 'health'
    notesEnabled: boolean
    todoEnabled: boolean
    fxEnabled: boolean
    fxBase: string
    fxSymbols: string
    readLaterEnabled: boolean
  }
  setup: {
    completed: boolean
    completedAt?: number
    version?: string
  }
  ai: {
    enabled: boolean
    provider: 'anthropic' | 'openai' | 'ollama' | 'google' | 'claude-code' | 'codex' | 'gemini-cli'
    anthropicModel: string
    openaiModel: string
    ollamaUrl: string
    ollamaModel: string
    googleModel: string
    claudeCodePath: string   // Claude Code CLI 실행 경로(비우면 'claude')
    claudeCodeModel: string  // 예: opus, sonnet (비우면 Claude Code 기본)
    codexPath: string        // Codex CLI 실행 경로(비우면 'codex')
    codexModel: string       // ChatGPT 계정에서 허용되는 모델(비우면 codex 기본 — 계정에 따라 지정 필요)
    geminiCliPath: string    // Gemini CLI 실행 경로(비우면 'gemini')
    geminiCliModel: string   // 예: gemini-2.5-flash (비우면 기본)
    maxTokens: number
    maxContextChars: number
    includePageByDefault: boolean
    memoryEnabled: boolean
    autoMemory: boolean
    nativeToolUse: 'auto' | 'off'
    agentFilesDir: string   // 에이전트가 업로드에 쓸 수 있는 자료 폴더(이 폴더 안 파일만 접근 허용)
    agentMaxSteps: number   // 에이전트 한 작업의 최대 단계 수(복잡한 작업일수록 크게)
    agentVision: 'auto' | 'always' | 'off'  // 화면 인식 — auto=스마트(화면 변화·막힘 때만 캡처, 한도 절약)·always=매 단계·off. 비전 지원 제공자/모델에서만
    webhookUrl: string      // 수집 데이터 연동 — 이 URL 로 JSON POST(Zapier·Make·구글시트 Apps Script 등)
  }
}

const DEFAULTS: AppSettings = {
  appearance: {
    theme: 'system', density: 'regular', forcePageDark: false,
    pageDarkFollowSystem: false, pageDarkSiteOverrides: {},
  },
  startup: { mode: 'newtab', urls: [] },
  search: { defaultEngine: 'google', suggestEnabled: true, bangsEnabled: true },
  privacy: { historyRetention: '1y', blockThirdPartyCookies: true },
  adblock: {
    enabled: true, level: 'standard',
    filters: {
      easylist: true, easyprivacy: true, kr: true, antiAdblock: true,
      fanboyAnnoyance: false, fanboySocial: false,
    },
    siteOverrides: {},
  },
  downloads: {
    defaultPath: '',
    askEveryTime: false,
    accelerator: true,
    torrentDht: false,
    torrentMaxSeedRatio: 2.0,
  },
  freedom: {
    userChromeCss: true,
    userChromeJs: false,
    userscripts: true,
    commandPalette: true,
    modApi: false,
    mouseGestures: true,
    quickSearch: true,
    hoverTranslate: false,
    hoverTranslateTarget: 'ko',
  },
  ui: {
    bookmarkBarShow: true,
    sidepanelLeftOpen: false,
    sidepanelRightOpen: false,
    tabbarOrientation: 'top',
    workspaceRailOpen: true,
  },
  performance: {
    tabSleepEnabled: true,
    tabSleepMinutes: 30,
  },
  tabs: {
    openBehavior: 'new-tab',
  },
  update: {
    channel: 'latest',
    autoCheck: true,
    autoDownload: false,
    notifyOnUpdate: true,
  },
  widgets: {
    weatherEnabled: true,
    newsEnabled: true,
    locationMode: 'auto',
    manualLat: 37.5665,
    manualLon: 126.978,
    manualPlace: '서울',
    units: 'metric',
    newsTopic: 'headlines',
    notesEnabled: true,
    todoEnabled: true,
    fxEnabled: false,
    fxBase: 'USD',
    fxSymbols: 'KRW,JPY,EUR,CNY',
    readLaterEnabled: true,
  },
  setup: {
    completed: false,
  },
  ai: {
    enabled: true,
    provider: 'anthropic',
    anthropicModel: 'claude-sonnet-4-5',
    openaiModel: 'gpt-4o-mini',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'llama3.2',
    googleModel: 'gemini-2.0-flash',
    claudeCodePath: '',
    claudeCodeModel: '',
    codexPath: '',
    codexModel: '',
    geminiCliPath: '',
    geminiCliModel: '',
    maxTokens: 2048,
    maxContextChars: 12000,
    includePageByDefault: true,
    memoryEnabled: true,
    autoMemory: false,
    nativeToolUse: 'auto',
    agentFilesDir: '',
    agentMaxSteps: 25,
    agentVision: 'auto',
    webhookUrl: '',
  },
}

// clearInvalidConfig: 손상된 settings.json(예: BOM·잘림)이 있어도 throw 대신 기본값으로 리셋 —
// 설정 파일 하나가 메인 프로세스 전체를 죽이지 않도록 방어.
const store = new Store<AppSettings>({ name: 'settings', defaults: DEFAULTS, clearInvalidConfig: true })

export function getSettings(): AppSettings {
  return store.store as AppSettings
}

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return store.get(key) as AppSettings[K]
}

export function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
  store.set(key, value)
}

export function setNestedSetting(path: string, value: unknown): void {
  store.set(path, value as never)
}

export function onSettingsChange(cb: (settings: AppSettings) => void): () => void {
  const unsubscribe = store.onDidAnyChange(() => cb(store.store as AppSettings))
  return unsubscribe
}
