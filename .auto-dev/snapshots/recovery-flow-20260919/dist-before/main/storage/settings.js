"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSettings = getSettings;
exports.getSetting = getSetting;
exports.setSetting = setSetting;
exports.setNestedSetting = setNestedSetting;
exports.onSettingsChange = onSettingsChange;
const safe_store_1 = require("./safe-store");
const DEFAULTS = {
    appearance: {
        theme: 'system', density: 'regular', forcePageDark: false,
        pageDarkFollowSystem: false, pageDarkSiteOverrides: {},
    },
    startup: { mode: 'newtab', urls: [] },
    search: { defaultEngine: 'google', suggestEnabled: true, bangsEnabled: true },
    privacy: { historyRetention: '1y', blockThirdPartyCookies: true, passkeyAutoPrompt: 'block' },
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
        ytdlpAutoUpdate: true,
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
        agentAutoApprove: false,
        agentHumanInput: true,
        agentInputMode: 'auto',
        cliSession: true,
        agentCollapsePanels: true,
        webhookUrl: '',
        taskLongMaxHours: 24,
        taskSegmentSteps: 12,
        taskLongMaxSteps: 2000,
        taskLongMaxLlmCalls: 1500,
    },
};
// clearInvalidConfig: 손상된 settings.json(예: BOM·잘림)이 있어도 throw 대신 기본값으로 리셋 —
// 설정 파일 하나가 메인 프로세스 전체를 죽이지 않도록 방어.
const store = (0, safe_store_1.createStore)({ name: 'settings', defaults: DEFAULTS });
function getSettings() {
    return store.store;
}
function getSetting(key) {
    return store.get(key);
}
function setSetting(key, value) {
    store.set(key, value);
}
function setNestedSetting(path, value) {
    store.set(path, value);
}
function onSettingsChange(cb) {
    const unsubscribe = store.onDidAnyChange(() => cb(store.store));
    return unsubscribe;
}
