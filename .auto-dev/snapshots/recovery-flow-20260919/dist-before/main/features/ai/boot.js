"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureAiBooted = ensureAiBooted;
exports.isAiBooted = isAiBooted;
exports.hasScheduledAiWork = hasScheduledAiWork;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const electron_1 = require("electron");
const index_1 = require("./index");
const agent_triggers_1 = require("./agent-triggers");
const feed_collector_1 = require("./feed-collector");
const blog_drafts_1 = require("./blog-drafts");
/**
 * AI 레이어의 무거운 부팅 초기화(저장소 적재 + 스케줄러 타이머)를 **첫 사용 시점까지** 미룬다.
 *
 * 왜 (2026-09-07 A/B 실측): 이 초기화를 건너뛰면 빈 창 private WS 가 258~259MB → 240~246MB 로
 * 줄었다(총 13~18MB). 비용은 모듈 코드가 아니라 **초기화 호출**(JSON 저장소 적재·타이머 등록)에
 * 있었다. 브라우저를 열고 AI 를 한 번도 쓰지 않는 사용자가 그 비용을 낼 이유가 없다 —
 * CLAUDE.md 의 "무거운 기능은 lazy load, 끄면 메모리·CPU 도 0" 원칙 그대로다.
 *
 * 단, **사용자가 이미 백그라운드 작업을 설정해 둔 경우**(자동 트리거·피드 수집)는 미루면
 * 동작 자체가 사라진다. 그 경우에는 예전처럼 부팅 시 즉시 초기화한다(`hasScheduledAiWork`).
 */
let booted = null;
function ensureAiBooted() {
    if (!booted) {
        booted = (async () => {
            console.log('[ai] 지연 초기화 실행');
            await (0, index_1.initAi)();
            (0, agent_triggers_1.initAgentTriggers)();
            (0, feed_collector_1.initFeedCollectors)();
            (0, blog_drafts_1.initBlogDrafts)();
        })().catch((err) => {
            // 실패해도 다음 호출에서 다시 시도할 수 있게 캐시를 비운다.
            booted = null;
            console.warn('[ai] 지연 초기화 실패:', err);
        });
    }
    return booted;
}
function isAiBooted() {
    return booted !== null;
}
/** JSON 파일이 "비어 있지 않은 배열"을 담고 있는가 — 설정된 백그라운드 작업이 있는지 판별용. */
function hasNonEmptyArray(file) {
    try {
        if (!(0, node_fs_1.existsSync)(file))
            return false;
        const parsed = JSON.parse((0, node_fs_1.readFileSync)(file, 'utf8'));
        return Array.isArray(parsed) && parsed.length > 0;
    }
    catch {
        // 손상된 파일은 "작업 있음"으로 보고 정상 경로(즉시 초기화)로 보내 복구 기회를 준다.
        return true;
    }
}
/**
 * 사용자가 자동 실행되는 AI 백그라운드 작업을 설정해 뒀는가.
 * 있으면 지연시키지 않는다 — 지연은 메모리를 아끼자는 것이지 기능을 끄자는 게 아니다.
 */
function hasScheduledAiWork() {
    const userData = electron_1.app.getPath('userData');
    return hasNonEmptyArray((0, node_path_1.join)(userData, 'ai-triggers.json'))
        || hasNonEmptyArray((0, node_path_1.join)(userData, 'ai-collectors.json'));
}
