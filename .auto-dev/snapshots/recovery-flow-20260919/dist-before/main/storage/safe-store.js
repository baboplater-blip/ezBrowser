"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStore = createStore;
const electron_store_1 = __importDefault(require("electron-store"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const electron_1 = require("electron");
/**
 * 깨진 JSON 때문에 앱이 **시작조차 못 하는 것**을 막는 electron-store 생성기.
 *
 * 왜 (2026-09-07, 임무 23): 저장소 모듈들은 최상위에서 `new Store(...)` 를 만든다.
 * 그 파일이 잘려 있으면(정전·강제 종료 중 쓰기가 끊기면 실제로 그렇게 된다)
 * conf 가 생성자 안에서 `JSON.parse` 를 하다 던지고, 그것이 **import 도중** 터지므로
 * 우리 try/catch·로그·창 생성보다 앞이다. 결과는 사용자에게 이렇게 보인다:
 *
 *     A JavaScript error occurred in the main process
 *     SyntaxError: Unexpected end of JSON input   (at new ElectronStore)
 *
 * 창이 하나도 뜨지 않고, 어떤 파일을 지워야 하는지도 알 수 없다.
 * `clearInvalidConfig: true` 만으로는 막히지 않았다(실측).
 *
 * 그래서: 만들다 실패하면 **깨진 파일을 격리(rename)하고 한 번 더 시도**한다.
 * 그 파일의 내용은 어차피 읽을 수 없으므로 잃는 것은 없고, 사용자는 앱을 연다.
 * 격리본(`<name>.corrupt-<시각>.json`)은 남겨 둔다 — 원인 조사·수동 복구용.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createStore(options) {
    const opts = { clearInvalidConfig: true, ...options };
    try {
        return new electron_store_1.default(opts);
    }
    catch (err) {
        const quarantined = quarantine(options.name);
        console.error(`[storage] '${options.name}' 설정 파일을 읽을 수 없어 격리했습니다`
            + (quarantined ? ` → ${node_path_1.default.basename(quarantined)}` : '')
            + ` (${err instanceof Error ? err.message : String(err)})`);
        // 격리 후 재시도 — 파일이 없으면 기본값으로 새로 만들어진다.
        return new electron_store_1.default(opts);
    }
}
/** 깨진 파일을 `<name>.corrupt-<시각>.json` 으로 옮긴다. 실패하면 삭제라도 한다. */
function quarantine(name) {
    let file;
    try {
        file = node_path_1.default.join(electron_1.app.getPath('userData'), `${name}.json`);
    }
    catch {
        return null;
    }
    if (!node_fs_1.default.existsSync(file))
        return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = node_path_1.default.join(node_path_1.default.dirname(file), `${name}.corrupt-${stamp}.json`);
    try {
        node_fs_1.default.renameSync(file, dest);
        return dest;
    }
    catch {
        try {
            node_fs_1.default.unlinkSync(file);
        }
        catch { /* 지우지도 못하면 재시도가 다시 던진다 */ }
        return null;
    }
}
