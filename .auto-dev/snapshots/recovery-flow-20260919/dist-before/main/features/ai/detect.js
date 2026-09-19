"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectProviders = detectProviders;
exports.invalidateProviderDetection = invalidateProviderDetection;
exports.connectProvider = connectProvider;
const node_child_process_1 = require("node:child_process");
const settings_1 = require("../../storage/settings");
const keys_1 = require("./keys");
const providers_1 = require("./providers");
const diagnose_1 = require("./diagnose");
const LABEL = {
    anthropic: 'Claude (Anthropic API)',
    openai: 'OpenAI API',
    google: 'Google Gemini API',
    ollama: 'Ollama (로컬)',
    'claude-code': 'Claude Code CLI',
    codex: 'Codex CLI',
    'gemini-cli': 'Gemini CLI',
};
const CLI_BIN = {
    'claude-code': 'claude', codex: 'codex', 'gemini-cli': 'gemini',
};
const PROBE_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 60_000;
let cache = null;
/**
 * CLI 바이너리가 실행 가능한지 `--version` 으로 확인한다. 모델을 호출하지 않으므로 요금·한도 소모 0.
 * 실행 방식(shell·windowsHide)은 providers.ts 의 runCli 과 같아야 한다 — 다르면 "탐지는 됐는데 실행은 실패"가 난다.
 */
function probeCli(bin) {
    return new Promise((resolve) => {
        let done = false;
        let out = '';
        const finish = (ok, detail) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            try {
                child.kill();
            }
            catch { /* 이미 종료 */ }
            resolve({ ok, detail });
        };
        const timer = setTimeout(() => finish(false, '응답 없음(시간 초과)'), PROBE_TIMEOUT_MS);
        let child;
        try {
            child = (0, node_child_process_1.spawn)(bin, ['--version'], {
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: process.platform === 'win32',
                windowsHide: true,
            });
        }
        catch {
            clearTimeout(timer);
            resolve({ ok: false, detail: '실행할 수 없음' });
            return;
        }
        child.stdout?.on('data', (c) => { out += c.toString('utf8'); });
        child.stderr?.on('data', (c) => { out += c.toString('utf8'); });
        child.on('error', () => finish(false, '설치되어 있지 않음'));
        child.on('close', (code) => {
            const v = out.trim().split(/\r?\n/)[0]?.slice(0, 60) ?? '';
            finish(code === 0, code === 0 ? (v || '설치됨') : `종료 코드 ${code}`);
        });
    });
}
/** 로컬 Ollama 서버와 설치된 모델. 로컬 HTTP 라 비용 없음. */
async function probeOllama(url) {
    const base = (url || 'http://localhost:11434').replace(/\/+$/, '');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4_000);
    try {
        const res = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
        if (!res.ok)
            return { ok: false, models: [], detail: `서버 응답 ${res.status}` };
        const body = await res.json();
        const models = (body.models ?? []).map((m) => String(m.name ?? '')).filter(Boolean);
        return { ok: models.length > 0, models, detail: models.length > 0 ? `모델 ${models.length}개 설치됨` : '서버는 켜져 있으나 설치된 모델이 없음' };
    }
    catch {
        return { ok: false, models: [], detail: '서버에 연결할 수 없음' };
    }
    finally {
        clearTimeout(t);
    }
}
async function detectProviders(opts = {}) {
    if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS)
        return cache;
    const s = (0, settings_1.getSetting)('ai');
    const cliIds = ['claude-code', 'codex', 'gemini-cli'];
    const [cliResults, ollama, keyFlags] = await Promise.all([
        Promise.all(cliIds.map(async (id) => {
            const pathKey = (0, providers_1.cliPathSettingKey)(id);
            const configured = pathKey ? String(s[pathKey] ?? '').trim() : '';
            return { id, ...(await probeCli(configured || CLI_BIN[id])) };
        })),
        probeOllama(s.ollamaUrl),
        Promise.all(['anthropic', 'openai', 'google'].map(async (id) => ({ id, has: await (0, keys_1.hasAiKey)(id) }))),
    ]);
    const candidates = [];
    for (const r of cliResults) {
        candidates.push({
            id: r.id,
            label: LABEL[r.id],
            kind: 'cli',
            ready: r.ok,
            cost: 'subscription',
            detail: r.ok
                ? `${r.detail} — 이미 쓰고 있는 구독 계정으로 동작합니다(추가 요금 없음).`
                : `${CLI_BIN[r.id]} 명령을 찾을 수 없습니다 (${r.detail}).`,
            fix: r.ok ? undefined : `${CLI_BIN[r.id]} CLI 를 설치하고 한 번 실행해 로그인하세요. 설정 > AI 에서 실행 경로를 직접 지정할 수도 있습니다.`,
        });
    }
    candidates.push({
        id: 'ollama',
        label: LABEL.ollama,
        kind: 'local',
        ready: ollama.ok,
        cost: 'free-local',
        detail: ollama.ok ? `${ollama.detail} — 내 컴퓨터에서만 돌아가 요금도, 외부 전송도 없습니다.` : ollama.detail,
        fix: ollama.ok ? undefined : 'ollama.com 에서 설치 후 `ollama pull llama3.2` 로 모델을 하나 받으세요.',
        models: ollama.models,
    });
    for (const k of keyFlags) {
        candidates.push({
            id: k.id,
            label: LABEL[k.id],
            kind: 'key',
            ready: k.has,
            cost: k.id === 'google' ? 'free-tier' : 'paid-key',
            detail: k.has
                ? '키가 저장되어 있습니다.'
                : (k.id === 'google' ? '무료 티어 키를 발급받아 입력하면 쓸 수 있습니다.' : 'API 키를 입력하면 쓸 수 있습니다(사용한 만큼 과금).'),
            fix: k.has ? undefined : '설정 > AI 에서 키를 입력하세요.',
        });
    }
    // 권장 순서: 지금 쓸 수 있는 것 먼저, 그다음 추가 비용이 없는 것 먼저.
    const costRank = { subscription: 0, 'free-local': 1, 'free-tier': 2, 'paid-key': 3 };
    candidates.sort((a, b) => (Number(b.ready) - Number(a.ready)) || (costRank[a.cost] - costRank[b.cost]));
    const current = s.provider;
    const currentReady = (0, providers_1.isCliProvider)(current) || current === 'ollama'
        ? (candidates.find((c) => c.id === current)?.ready ?? false)
        : await (0, keys_1.hasAiKey)(current);
    cache = { at: Date.now(), current, currentReady, candidates };
    return cache;
}
function invalidateProviderDetection() { cache = null; }
/**
 * 제공자를 고르고 **실제로 한 번 물어봐서** 되는지 확인한다.
 * 실패해도 선택은 되돌리지 않는다 — 사용자가 고른 제공자를 그대로 두고 무엇을 고쳐야 하는지 알려주는 편이
 * "눌렀는데 아무 일도 안 일어남"보다 낫다(로그인만 하면 바로 동작하는 경우가 대부분).
 */
async function connectProvider(id, model) {
    const s = (0, settings_1.getSetting)('ai');
    if (!s.enabled)
        (0, settings_1.setNestedSetting)('ai.enabled', true);
    (0, settings_1.setNestedSetting)('ai.provider', id);
    if (model && model.trim()) {
        const key = id === 'ollama' ? 'ai.ollamaModel'
            : id === 'claude-code' ? 'ai.claudeCodeModel'
                : id === 'codex' ? 'ai.codexModel'
                    : id === 'gemini-cli' ? 'ai.geminiCliModel'
                        : id === 'anthropic' ? 'ai.anthropicModel'
                            : id === 'openai' ? 'ai.openaiModel'
                                : 'ai.googleModel';
        (0, settings_1.setNestedSetting)(key, model.trim());
    }
    else if (id === 'ollama') {
        // 설정된 모델이 실제로 설치돼 있지 않으면 설치된 것 중 하나로 맞춘다 — 안 그러면 첫 질문이 404 로 실패한다.
        const det = await detectProviders({ force: true });
        const installed = det.candidates.find((c) => c.id === 'ollama')?.models ?? [];
        if (installed.length && !installed.includes(s.ollamaModel))
            (0, settings_1.setNestedSetting)('ai.ollamaModel', installed[0]);
    }
    invalidateProviderDetection();
    const diagnosis = await (0, diagnose_1.diagnoseAi)();
    return { ok: diagnosis.ok, provider: id, providerLabel: LABEL[id], diagnosis };
}
