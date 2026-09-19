"use strict";
// 다운로드 기본 저장 위치 — **단일 출처**.
//
// 왜 downloads/index.ts 에서 떼어냈나: 이 규칙("설정의 defaultPath 가 유효하면 그걸, 아니면 OS 기본")을
// 쓰고 싶은 쪽(예: AI 보고서·대화 내보내기)이 downloads/index.ts 를 통째로 import 하면
// 세션 훅·종료 훅 같은 모듈 초기화 부작용까지 딸려 온다. 그렇다고 규칙을 복제하면 두 벌이 엇갈려
// "설정은 바꿨는데 어떤 파일만 엉뚱한 곳에 저장되는" 상태가 된다(실제로 그랬다 — writeDownloadMd 가
// app.getPath('downloads') 고정이라 사용자의 저장 위치 설정을 무시했고, 검증 하네스도 실제
// Downloads 폴더를 건드렸다). 그래서 부작용 없는 이 파일 하나만 공유한다.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultDownloadDir = defaultDownloadDir;
const electron_1 = require("electron");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const settings_1 = require("../../storage/settings");
/**
 * 다운로드 기본 저장 위치 — settings.downloads.defaultPath 를 우선 사용(존재하는 디렉터리일 때만),
 * 비어있거나 유효하지 않으면 OS Downloads 폴더로 폴백. subfolder 는 그 base 아래에 join(영상/토렌트용).
 */
function defaultDownloadDir(subfolder) {
    let base = electron_1.app.getPath('downloads');
    const configured = (() => {
        try {
            return (0, settings_1.getSetting)('downloads').defaultPath;
        }
        catch {
            return '';
        }
    })();
    if (configured && configured.trim()) {
        try {
            if ((0, node_fs_1.existsSync)(configured) && (0, node_fs_1.statSync)(configured).isDirectory())
                base = configured;
        }
        catch { /* 유효하지 않은 경로 — OS 기본값 폴백 */ }
    }
    return subfolder ? node_path_1.default.join(base, subfolder) : base;
}
