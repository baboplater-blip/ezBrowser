"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INTERNAL_URL_PREFIXES = exports.DISCARD_AFTER_MS = exports.SUGGEST_TIMEOUT_MS = exports.SUGGEST_DEBOUNCE_MS = exports.incognitoPartition = exports.DEFAULT_SESSION = exports.SETTINGS_URL = exports.NEW_TAB_URL = exports.BOOKMARKBAR_HEIGHT = exports.TOOLBAR_HEIGHT = exports.TABBAR_HEIGHT = exports.CHROME_HEIGHT = exports.APP_VERSION = exports.APP_NAME = void 0;
exports.APP_NAME = 'ezBrowser';
exports.APP_VERSION = '0.1.0';
exports.CHROME_HEIGHT = 72;
exports.TABBAR_HEIGHT = 36;
exports.TOOLBAR_HEIGHT = 36;
exports.BOOKMARKBAR_HEIGHT = 32;
exports.NEW_TAB_URL = 'browser://newtab';
exports.SETTINGS_URL = 'browser://settings';
exports.DEFAULT_SESSION = 'persist:default';
const incognitoPartition = (n) => `incognito-${n}`;
exports.incognitoPartition = incognitoPartition;
exports.SUGGEST_DEBOUNCE_MS = 150;
exports.SUGGEST_TIMEOUT_MS = 800;
exports.DISCARD_AFTER_MS = 30 * 60 * 1000;
exports.INTERNAL_URL_PREFIXES = [
    'browser://',
    'http://localhost:5173',
    'file://',
    'chrome-extension://',
];
