"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAiIpc = registerAiIpc;
const electron_1 = require("electron");
const node_path_1 = __importDefault(require("node:path"));
const ipc_channels_1 = require("../../shared/ipc-channels");
const trust_1 = require("./trust");
const settings_1 = require("../storage/settings");
const agent_files_1 = require("../features/ai/agent-files");
const ai_1 = require("../features/ai");
const keys_1 = require("../features/ai/keys");
const detect_1 = require("../features/ai/detect");
const agent_1 = require("../features/ai/agent");
const agent_schedule_1 = require("../features/ai/agent-schedule");
const memory_1 = require("../features/ai/memory");
const agent_triggers_1 = require("../features/ai/agent-triggers");
const profile_1 = require("../features/ai/profile");
const blog_writer_1 = require("../features/ai/blog-writer");
const blog_publish_1 = require("../features/ai/blog-publish");
const sns_publish_1 = require("../features/ai/sns-publish");
const intent_1 = require("../features/ai/intent");
const blog_drafts_1 = require("../features/ai/blog-drafts");
const feed_collector_1 = require("../features/ai/feed-collector");
const conversations_1 = require("../features/ai/conversations");
const site_report_1 = require("../features/ai/site-report");
const saved_tasks_1 = require("../features/ai/saved-tasks");
const artifacts_1 = require("../features/ai/artifacts");
const social_workflow_1 = require("../features/ai/social-workflow");
const blog_engage_1 = require("../features/ai/blog-engage");
const promises_1 = require("node:fs/promises");
const agent_runs_1 = require("../features/ai/agent-runs");
// 영속 작업 런타임(task-runtime.ts) — 다른 작업자가 같은 라운드에 병행 작성 중인 모듈.
// design.md §1 에 확정된 export 목록을 그대로 가져다 쓴다. 파일이 아직 없거나 시그니처가
// 다르면 이 import 부터 tsc 오류가 나는데, 그건 task-runtime.ts 쪽 문제이지 이 파일의 문제가 아니다.
const task_runtime_1 = require("../features/ai/task-runtime");
const window_service_1 = require("../windows/window-service");
function registerAiIpc() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.config, async (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return (0, ai_1.getAiClientConfig)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.pageContext, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return (0, ai_1.getAiPageInfo)(args?.tabId);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.keyStatus, async (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return (0, ai_1.getAiKeyStatus)();
    });
    // AI 상태 점검 — 현재 제공자에 실제 요청을 보내 정상/원인+해결책 판정.
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.diagnose, async (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        try {
            return await (0, ai_1.diagnoseAi)();
        }
        catch (err) {
            return { ok: false, status: 'error', message: '점검 중 오류', detail: err instanceof Error ? err.message : String(err) };
        }
    });
    // 이 컴퓨터에서 지금 쓸 수 있는 제공자 탐지 — 요금이 드는 호출은 하지 않는다(CLI --version·로컬 tags·키 유무).
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.detectProviders, async (e, args = {}) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        try {
            return await (0, detect_1.detectProviders)({ force: !!args?.force });
        }
        catch (err) {
            return { at: Date.now(), current: 'anthropic', currentReady: false, candidates: [], error: err instanceof Error ? err.message : String(err) };
        }
    });
    // 제공자 연결 — 고른 뒤 실제로 한 번 물어봐서 되는지 확인하고, 안 되면 원인·해결책을 그대로 돌려준다.
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.connectProvider, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false, error: 'untrusted' };
        const allowed = ['anthropic', 'openai', 'google', 'ollama', 'claude-code', 'codex', 'gemini-cli'];
        if (!args || !allowed.includes(args.provider))
            return { ok: false, error: '알 수 없는 제공자' };
        try {
            return await (0, detect_1.connectProvider)(args.provider, args.model);
        }
        catch (err) {
            return { ok: false, provider: args.provider, error: err instanceof Error ? err.message : String(err) };
        }
    });
    const SECRET_PROVIDERS = ['anthropic', 'openai', 'google'];
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.setKey, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false };
        if (!SECRET_PROVIDERS.includes(args.provider))
            return { ok: false };
        const ok = await (0, keys_1.setAiKey)(args.provider, args.key ?? '');
        return { ok, status: await (0, ai_1.getAiKeyStatus)() };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.clearKey, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false };
        if (!SECRET_PROVIDERS.includes(args.provider))
            return { ok: false };
        await (0, keys_1.clearAiKey)(args.provider);
        return { ok: true, status: await (0, ai_1.getAiKeyStatus)() };
    });
    // 에이전트 자료 폴더 — 폴더 선택(네이티브) + 현재 폴더/파일 정보
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.pickAgentDir, async (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false };
        const res = await electron_1.dialog.showOpenDialog({ title: '에이전트 자료 폴더 선택', properties: ['openDirectory'] });
        if (res.canceled || !res.filePaths[0])
            return { ok: false, dir: (0, agent_files_1.agentFilesDir)(), count: (0, agent_files_1.listAgentFiles)().length };
        (0, settings_1.setSetting)('ai', { ...(0, settings_1.getSetting)('ai'), agentFilesDir: res.filePaths[0] });
        return { ok: true, dir: res.filePaths[0], count: (0, agent_files_1.listAgentFiles)().length };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.agentFilesInfo, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { dir: '', count: 0, files: [] };
        const files = (0, agent_files_1.listAgentFiles)();
        return { dir: (0, agent_files_1.agentFilesDir)(), count: files.length, files: files.slice(0, 50) };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.send, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false };
        if (!args || !Array.isArray(args.messages) || !args.reqId)
            return { ok: false };
        const sender = e.sender;
        const send = (channel, payload) => {
            if (!sender.isDestroyed())
                sender.send(channel, payload);
        };
        // 창이 스트리밍 중 닫히면 남은 스트림 핸들을 정리한다.
        sender.once('destroyed', () => { try {
            (0, ai_1.cancelAiChat)(args.reqId);
        }
        catch { /* ignore */ } });
        await (0, ai_1.startAiChat)({
            reqId: args.reqId,
            tabId: args.tabId,
            includePage: !!args.includePage,
            messages: args.messages,
            summary: typeof args.summary === 'string' ? args.summary : undefined,
        }, {
            onDelta: (text) => send(ipc_channels_1.IPC.ai.delta, { reqId: args.reqId, text }),
            onDone: (text) => {
                send(ipc_channels_1.IPC.ai.done, { reqId: args.reqId, text });
                // 자동 Dreaming(설정 ON 시): 대화에서 장기 기억할 사실 추출 — 저장되면 조용히 알림.
                void (0, ai_1.maybeAutoRemember)([...args.messages, { role: 'assistant', content: text }]).then((added) => {
                    if (added.length && !sender.isDestroyed()) {
                        const more = added.length > 1 ? ` 외 ${added.length - 1}건` : '';
                        sender.send('toast:show', { message: `🧠 기억에 추가됨: ${(added[0] ?? '').slice(0, 24)}${more}`, ts: Date.now() });
                    }
                });
            },
            onError: (message) => send(ipc_channels_1.IPC.ai.error, { reqId: args.reqId, message }),
        });
        return { ok: true };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.cancel, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.reqId)
            (0, ai_1.cancelAiChat)(args.reqId);
    });
    // 대화 압축 — 접을 메시지들을 요약해 반환(+이전 요약 통합).
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.summarize, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false, summary: '' };
        if (!args || !Array.isArray(args.messages))
            return { ok: false, summary: '' };
        try {
            const summary = await (0, ai_1.summarizeChat)(args.messages, args.prevSummary);
            return { ok: !!summary, summary };
        }
        catch (err) {
            return { ok: false, summary: '', error: err instanceof Error ? err.message : String(err) };
        }
    });
    // ===== 에이전트 =====
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.agentStart, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false };
        if (!args || !args.reqId || !args.task?.trim())
            return { ok: false };
        const sender = e.sender;
        const task = args.task.trim();
        // 창이 확인/질문 대기 중 닫히면 에이전트가 리졸버를 붙든 채 영원히 멈춘다 — 창 파괴 시 취소.
        sender.once('destroyed', () => { try {
            (0, agent_1.cancelAgentTask)(args.reqId);
            (0, agent_1.cancelAgentBatch)(args.reqId);
        }
        catch { /* ignore */ } });
        const forward = (evt) => {
            (0, agent_runs_1.recordAgentEvent)(args.reqId, task, evt); // 실행 이력 영속화(메인 측 — UI 닫혀도 기록)
            // 보고서 자동 저장 알림(대화 내보내기 토스트와 동일 패턴).
            if (evt.type === 'report' && typeof evt.path === 'string' && !sender.isDestroyed()) {
                sender.send('toast:show', { message: `보고서 저장됨 ⤓ ${node_path_1.default.basename(String(evt.path))}`, ts: Date.now() });
            }
            if (!sender.isDestroyed())
                sender.send(ipc_channels_1.IPC.ai.agentEvent, { reqId: args.reqId, ...evt });
        };
        // 데이터(CSV/목록) 행이 있으면 각 행마다 작업을 반복하는 대량 처리(batch), 없으면 단일 실행.
        if (Array.isArray(args.rows) && args.rows.length) {
            void (0, agent_1.runAgentBatch)({ reqId: args.reqId, tabId: args.tabId, task, rows: args.rows, autoConfirm: !!args.autoConfirm }, forward);
        }
        else {
            // 허용 사이트 — 호스트 형태만 통과시킨다(경로·스킴이 섞인 값이 그대로 들어가면 규칙이 무력해진다).
            const allowedHosts = Array.isArray(args.allowedHosts)
                ? args.allowedHosts.map((h) => String(h ?? '').trim().toLowerCase().replace(/^\*\./, ''))
                    .filter((h) => /^[a-z0-9.-]+$/.test(h)).slice(0, 30)
                : undefined;
            void (0, agent_1.runAgentTask)({
                reqId: args.reqId, tabId: args.tabId, task, readOnly: !!args.readOnly,
                ...(allowedHosts && allowedHosts.length ? { allowedHosts } : {}),
            }, forward);
        }
        return { ok: true };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.agentConfirm, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.reqId)
            (0, agent_1.confirmAgentStep)(args.reqId, !!args.approved);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.agentReply, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.reqId)
            (0, agent_1.replyAgentAsk)(args.reqId, String(args.answer ?? ''));
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.agentCancel, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.reqId) {
            (0, agent_1.cancelAgentTask)(args.reqId);
            (0, agent_1.cancelAgentBatch)(args.reqId);
        }
    });
    // 세션 컨텍스트 초기화("새 작업") — 이후 지시는 이전 대화 맥락 없이 새로 시작.
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.agentReset, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.windowId)
            (0, agent_1.resetAgentSession)(args.windowId);
    });
    // ===== 에이전트 작업 자동 반복 =====
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.repeatStart, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false };
        const job = (0, agent_schedule_1.startRepeat)(args);
        return { ok: !!job, job };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.repeatStop, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.id)
            (0, agent_schedule_1.stopRepeat)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.repeatRemove, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.id)
            (0, agent_schedule_1.removeRepeat)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.repeatList, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, agent_schedule_1.listRepeats)();
    });
    agent_schedule_1.repeatEvents.on('changed', (list) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            if (!ctx.chrome.webContents.isDestroyed())
                ctx.chrome.webContents.send(ipc_channels_1.IPC.ai.repeatChanged, list);
        }
    });
    agent_schedule_1.repeatEvents.on('event', (evt) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            if (!ctx.chrome.webContents.isDestroyed())
                ctx.chrome.webContents.send(ipc_channels_1.IPC.ai.repeatEvent, evt);
        }
    });
    // ===== 메모리 =====
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.memoryGet, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return '';
        return (0, memory_1.getMemoryText)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.memorySet, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false };
        await (0, memory_1.setMemoryText)(String(args?.text ?? ''));
        return { ok: true };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.memoryClear, async (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false };
        await (0, memory_1.clearMemory)();
        return { ok: true };
    });
    memory_1.memoryEvents.on('changed', (text) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            if (!ctx.chrome.webContents.isDestroyed())
                ctx.chrome.webContents.send(ipc_channels_1.IPC.ai.memoryChanged, text);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.ai.memoryChanged, text);
    });
    // ===== AI 트리거(url 진입 / 매일 / 변경 감지) =====
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.triggerList, (e) => { if (!(0, trust_1.isTrustedSender)(e))
        return []; return (0, agent_triggers_1.listTriggers)(); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.triggerAdd, (e, p) => { if (!(0, trust_1.isTrustedSender)(e))
        return null; return (0, agent_triggers_1.addTrigger)(p ?? {}); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.triggerUpdate, (e, args) => { if (!(0, trust_1.isTrustedSender)(e))
        return; if (args?.id)
        (0, agent_triggers_1.updateTrigger)(args.id, args.patch ?? {}); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.triggerRemove, (e, args) => { if (!(0, trust_1.isTrustedSender)(e))
        return; if (args?.id)
        (0, agent_triggers_1.removeTrigger)(args.id); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.triggerSetEnabled, (e, args) => { if (!(0, trust_1.isTrustedSender)(e))
        return; if (args?.id)
        (0, agent_triggers_1.setTriggerEnabled)(args.id, !!args.enabled); });
    agent_triggers_1.triggerEvents.on('changed', (list) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            if (!ctx.chrome.webContents.isDestroyed())
                ctx.chrome.webContents.send(ipc_channels_1.IPC.ai.triggerChanged, list);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.ai.triggerChanged, list);
    });
    // ===== 스마트 폼필 프로필 (내 정보) =====
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.profileGet, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { fields: profile_1.PROFILE_FIELDS, values: {}, storageAvailable: false };
        return { fields: profile_1.PROFILE_FIELDS, values: (0, profile_1.getProfile)(), storageAvailable: (0, profile_1.storageAvailable)() };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.profileSet, (e, values) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false };
        (0, profile_1.setProfile)(values ?? {});
        return { ok: true };
    });
    profile_1.profileEvents.on('changed', () => { (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.ai.profileChanged, true); });
    // ===== 결과 내보내기·연동 (웹훅 JSON POST) — Zapier·Make·구글시트 Apps Script·노션·메일 등으로 라우팅 =====
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.exportWebhook, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false, detail: '권한 없음' };
        const url = (args?.url || (0, settings_1.getSetting)('ai').webhookUrl || '').trim();
        if (!/^https?:\/\//i.test(url))
            return { ok: false, detail: '웹훅 URL 이 설정되지 않았습니다(설정 > AI).' };
        const rows = Array.isArray(args?.rows) ? args.rows.slice(0, 5000) : [];
        const body = JSON.stringify({ source: 'ezBrowser', count: rows.length, rows, at: Date.now() });
        return await new Promise((resolve) => {
            try {
                const req = electron_1.net.request({ url, method: 'POST' });
                req.setHeader('content-type', 'application/json');
                const timer = setTimeout(() => { try {
                    req.abort();
                }
                catch { /* ignore */ } ; resolve({ ok: false, detail: '시간 초과' }); }, 20000);
                req.on('response', (resp) => {
                    const status = resp.statusCode ?? 0;
                    resp.on('data', () => { });
                    resp.on('end', () => { clearTimeout(timer); resolve(status >= 200 && status < 400 ? { ok: true, detail: `전송됨 (${status})` } : { ok: false, detail: `실패 (${status})` }); });
                    resp.on('error', () => { clearTimeout(timer); resolve({ ok: false, detail: '응답 오류' }); });
                });
                req.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, detail: err.message }); });
                req.write(body);
                req.end();
            }
            catch (err) {
                resolve({ ok: false, detail: String(err) });
            }
        });
    });
    // ===== 블로그 글쓰기 스튜디오 — 주제·옵션 → 구조화 초안 생성(발행은 사용자가 트리거) =====
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.blogGenerate, async (e, params) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false, error: '권한 없음' };
        if (!params?.topic?.trim())
            return { ok: false, error: '주제를 입력하세요.' };
        try {
            const draft = await (0, blog_writer_1.generateBlogDraft)(params);
            return { ok: true, draft };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    // 초안 → "에디터를 열어 작성/임시저장/발행" 하는 에이전트 태스크로 변환(네이버 SmartEditor ONE 인지).
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.blogBuildTask, (e, params) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { task: '', naverWriteUrl: blog_publish_1.NAVER_WRITE_URL };
        const task = (0, blog_publish_1.buildBlogTask)({
            platform: params?.platform, mode: params?.mode ?? 'insert',
            title: String(params?.title ?? ''), body: String(params?.body ?? ''),
            tags: Array.isArray(params?.tags) ? params.tags : [], autoOpen: !!params?.autoOpen,
        });
        return { task, naverWriteUrl: blog_publish_1.NAVER_WRITE_URL };
    });
    // SNS 게시(인스타·유튜브·틱톡) 레시피 태스크 빌드 — 완료 신호 표식 포함
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.snsBuildTask, (e, params) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { task: '', openUrl: '' };
        const platform = params?.platform === 'youtube' ? 'youtube' : params?.platform === 'tiktok' ? 'tiktok' : 'instagram';
        return (0, sns_publish_1.buildSnsTask)({
            platform, mode: params?.mode === 'publish' ? 'publish' : 'draft',
            file: String(params?.file ?? '').slice(0, 300), caption: String(params?.caption ?? '').slice(0, 5000), title: typeof params?.title === 'string' ? params.title.slice(0, 200) : undefined,
            tags: Array.isArray(params?.tags) ? params.tags.map(String) : [], autoOpen: !!params?.autoOpen,
        });
    });
    // 사이트 분석 보고서 — 원클릭 태스크(읽기 전용) 빌드
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.reportBuildTask, (e, params) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { task: '', readOnly: true };
        return (0, site_report_1.buildSiteReportTask)({
            url: typeof params?.url === 'string' ? params.url : undefined,
            focus: typeof params?.focus === 'string' ? params.focus : undefined,
            depth: typeof params?.depth === 'number' ? params.depth : undefined,
        });
    });
    // 보고서 마크다운을 다운로드 폴더에 .md 로 저장(다이얼로그 없이 결정적).
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.reportExport, async (e, p) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false };
        const md = String(p?.markdown ?? '');
        if (!md.trim())
            return { ok: false };
        const base = (0, conversations_1.safeFileName)(String(p?.title ?? '보고서') || '보고서');
        const res = await (0, conversations_1.writeDownloadMd)(base, md);
        if (res.ok && res.path && !e.sender.isDestroyed()) {
            e.sender.send('toast:show', { message: `보고서 저장됨 ⤓ ${node_path_1.default.basename(res.path)}`, ts: Date.now() });
        }
        return res;
    });
    // 블로그 글 다듬기(부분 개선)
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.blogRefine, async (e, params) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false, error: '권한 없음' };
        if (!params?.body?.trim() || !params?.instruction?.trim())
            return { ok: false, error: '본문과 지시가 필요합니다.' };
        try {
            return { ok: true, body: await (0, blog_writer_1.refineBlogBody)(params) };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    // 블로그 시리즈 연재 기획
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.blogSeriesPlan, async (e, params) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false, error: '권한 없음' };
        if (!params?.topic?.trim())
            return { ok: false, error: '주제를 입력하세요.' };
        try {
            return { ok: true, plan: await (0, blog_writer_1.generateSeriesPlan)(params) };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    // 블로그 초안 저장·불러오기
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.blogDraftList, (e) => { if (!(0, trust_1.isTrustedSender)(e))
        return []; return (0, blog_drafts_1.listBlogDrafts)(); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.blogDraftGet, (e, args) => { if (!(0, trust_1.isTrustedSender)(e))
        return null; return args?.id ? (0, blog_drafts_1.getBlogDraft)(args.id) : null; });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.blogDraftSave, (e, payload) => { if (!(0, trust_1.isTrustedSender)(e))
        return null; return (0, blog_drafts_1.saveBlogDraft)(payload ?? {}); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.blogDraftRemove, (e, args) => { if (!(0, trust_1.isTrustedSender)(e))
        return; if (args?.id)
        (0, blog_drafts_1.removeBlogDraft)(args.id); });
    blog_drafts_1.blogDraftEvents.on('changed', (list) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            if (!ctx.chrome.webContents.isDestroyed())
                ctx.chrome.webContents.send(ipc_channels_1.IPC.ai.blogDraftChanged, list);
        }
    });
    // ===== 작업 산출물 (캡처한 이미지·받은 파일) =====
    // 미리보기는 dataURL 로 준다 — 외피는 file:// 로 임의 경로를 읽지 못하고(읽게 하면 그 자체가 구멍),
    // 산출물은 크지 않아(수백 KB) 한 번 실어 보내는 편이 안전하다.
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.artifactList, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        const t = String(args?.taskId ?? '').trim();
        return t ? (0, artifacts_1.listArtifacts)(t) : [];
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.artifactData, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        const t = String(args?.taskId ?? '').trim();
        const id = String(args?.id ?? '').trim();
        if (!t || !id)
            return null;
        const meta = (0, artifacts_1.getArtifact)(t, id);
        const p = (0, artifacts_1.resolveArtifactPath)(t, id); // 작업 폴더 밖이면 null — 경계는 여기서 지킨다
        if (!meta || !p)
            return null;
        if (meta.bytes > 12 * 1024 * 1024)
            return { meta, dataUrl: null }; // 미리보기로 싣기엔 큼
        try {
            const buf = await (0, promises_1.readFile)(p);
            return { meta, dataUrl: `data:${meta.mime};base64,${buf.toString('base64')}` };
        }
        catch {
            return { meta, dataUrl: null };
        }
    });
    // 입력창 한 줄을 워크플로 폼값으로 읽는다 — **순수 판독 전용**이다.
    // 어떤 작업도 시작하지 않고 자동 게시 승인(grant)도 만들지 않는다. 승인 입구는 socialGrant 하나뿐.
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.intentDetect, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return (0, intent_1.detectWorkflowIntent)(String(args?.text ?? ''));
    });
    // ===== 생성→캡션→게시 워크플로 =====
    // 게시는 되돌릴 수 없으므로 **승인 단계를 코드로 분리**한다 — socialStart 는 생성까지만 하고,
    // 실제 게시는 사용자가 캡션을 확인한 뒤 socialApprove 를 부를 때만 시작된다.
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.socialList, (e) => { if (!(0, trust_1.isTrustedSender)(e))
        return []; return (0, social_workflow_1.listWorkflows)(); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.socialStart, (e, params) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        if (!params || typeof params !== 'object')
            return null;
        return (0, social_workflow_1.startImagePost)({
            service: params.service === 'chatgpt' ? 'chatgpt' : params.service === 'custom' ? 'custom' : 'genspark',
            customUrl: typeof params.customUrl === 'string' ? params.customUrl.slice(0, 500) : undefined,
            prompt: String(params.prompt ?? '').slice(0, 4000),
            platform: params.platform === 'youtube' ? 'youtube' : params.platform === 'tiktok' ? 'tiktok' : 'instagram',
            account: typeof params.account === 'string' ? params.account.slice(0, 120) : undefined,
            tone: typeof params.tone === 'string' ? params.tone.slice(0, 200) : undefined,
            tags: Array.isArray(params.tags) ? params.tags.map(String).slice(0, 30) : [],
            mode: params.mode === 'publish' ? 'publish' : 'draft', // 기본은 초안 — 실수로 게시되지 않게
            windowId: typeof params.windowId === 'string' ? params.windowId : null,
            tabId: String(params.tabId ?? ''),
        });
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.socialApprove, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false, error: '권한 없음' };
        return (0, social_workflow_1.approveAndPublish)(String(args?.id ?? ''), String(args?.caption ?? '').slice(0, 5000));
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.socialChoose, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false, error: '권한 없음' };
        return (0, social_workflow_1.chooseArtifact)(String(args?.id ?? ''), String(args?.artifactId ?? ''));
    });
    // 이번 작업 한정 자동 게시 선승인 — **사용자의 명시 선택만** 이 입구를 지난다(신뢰 sender 검증).
    // 모델·페이지는 이 채널에 도달할 수 없으므로 자동 게시 범위를 스스로 만들거나 넓힐 수 없다.
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.socialGrant, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        if (!args || typeof args !== 'object')
            return null;
        return (0, social_workflow_1.grantAutoPublish)({
            platform: args.platform === 'youtube' ? 'youtube' : args.platform === 'tiktok' ? 'tiktok' : 'instagram',
            accounts: Array.isArray(args.accounts) ? args.accounts.map((a) => String(a).slice(0, 120)) : [],
            maxPosts: Number(args.maxPosts),
            minutes: Number(args.minutes),
        });
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.socialGrantGet, (e) => { if (!(0, trust_1.isTrustedSender)(e))
        return null; return (0, social_workflow_1.getAutoPublishGrant)(); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.socialGrantRevoke, (e) => { if (!(0, trust_1.isTrustedSender)(e))
        return; (0, social_workflow_1.revokeAutoPublish)(); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.socialCancel, (e, args) => { if (!(0, trust_1.isTrustedSender)(e))
        return; (0, social_workflow_1.cancelWorkflow)(String(args?.id ?? '')); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.socialDelete, (e, args) => { if (!(0, trust_1.isTrustedSender)(e))
        return; (0, social_workflow_1.deleteWorkflow)(String(args?.id ?? '')); });
    social_workflow_1.workflowEvents.on('changed', (list) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            if (!ctx.chrome.webContents.isDestroyed())
                ctx.chrome.webContents.send(ipc_channels_1.IPC.ai.socialChanged, list);
        }
    });
    // ===== 관심 블로그 댓글·좋아요 =====
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.engageBuildTask, (e, params) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { task: '', openUrl: '', allowedHosts: [] };
        return (0, blog_engage_1.buildBlogEngageTask)({
            myBlogUrl: typeof params?.myBlogUrl === 'string' ? params.myBlogUrl.slice(0, 500) : undefined,
            topic: typeof params?.topic === 'string' ? params.topic.slice(0, 300) : undefined,
            searchUrl: typeof params?.searchUrl === 'string' ? params.searchUrl.slice(0, 500) : undefined,
            account: typeof params?.account === 'string' ? params.account.slice(0, 120) : undefined,
            maxPosts: Number(params?.maxPosts) || 5,
            actions: Array.isArray(params?.actions) ? params.actions.filter((a) => a === 'comment' || a === 'like') : ['comment'],
            mode: params?.mode === 'act' ? 'act' : 'draft',
            excludeHosts: Array.isArray(params?.excludeHosts) ? params.excludeHosts.map(String).slice(0, 50) : [],
            minBodyChars: Number(params?.minBodyChars) || undefined,
            intervalSeconds: typeof params?.intervalSeconds === 'number' ? params.intervalSeconds : undefined,
            // 기한(epoch ms). 과거 시각을 주면 즉시 한도 소진 상태가 되므로 미래 값만 받는다.
            until: typeof params?.until === 'number' && params.until > Date.now() ? params.until : undefined,
        });
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.engageLedger, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, blog_engage_1.listEngagements)(Number(args?.limit) || 200);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.engageLedgerClear, (e) => { if (!(0, trust_1.isTrustedSender)(e))
        return; (0, blog_engage_1.clearEngagements)(); });
    // ===== 매일 자동 수집 (피드 수집기) =====
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.collectorList, (e) => { if (!(0, trust_1.isTrustedSender)(e))
        return []; return (0, feed_collector_1.listCollectors)(); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.collectorAdd, (e, p) => { if (!(0, trust_1.isTrustedSender)(e))
        return null; return (0, feed_collector_1.addCollector)(p ?? {}); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.collectorUpdate, (e, args) => { if (!(0, trust_1.isTrustedSender)(e))
        return; if (args?.id)
        (0, feed_collector_1.updateCollector)(args.id, args.patch ?? {}); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.collectorRemove, (e, args) => { if (!(0, trust_1.isTrustedSender)(e))
        return; if (args?.id)
        (0, feed_collector_1.removeCollector)(args.id); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.collectorSetEnabled, (e, args) => { if (!(0, trust_1.isTrustedSender)(e))
        return; if (args?.id)
        (0, feed_collector_1.setCollectorEnabled)(args.id, !!args.enabled); });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.collectorRun, async (e, args) => { if (!(0, trust_1.isTrustedSender)(e))
        return { ok: false }; if (!args?.id)
        return { ok: false }; const run = await (0, feed_collector_1.runCollectorNow)(args.id); return { ok: !!run, run }; });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.collectorRuns, (e, args) => { if (!(0, trust_1.isTrustedSender)(e))
        return []; return args?.id ? (0, feed_collector_1.listRunsFor)(args.id, 10) : []; });
    feed_collector_1.collectorEvents.on('changed', (list) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            if (!ctx.chrome.webContents.isDestroyed())
                ctx.chrome.webContents.send(ipc_channels_1.IPC.ai.collectorChanged, list);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.ai.collectorChanged, list);
    });
    feed_collector_1.collectorEvents.on('run', (run) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            if (!ctx.chrome.webContents.isDestroyed())
                ctx.chrome.webContents.send(ipc_channels_1.IPC.ai.collectorRan, run);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.ai.collectorRan, run);
    });
    // ===== 대화 영속화 =====
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.convList, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, conversations_1.listConversations)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.convGet, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return args?.id ? (0, conversations_1.getConversation)(args.id) : null;
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.convSave, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        if (!args?.id || !Array.isArray(args.messages))
            return null;
        return (0, conversations_1.saveConversation)(args.id, args.messages, { summary: args.summary, foldCount: args.foldCount });
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.convDelete, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.id)
            (0, conversations_1.deleteConversation)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.convRename, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.id)
            (0, conversations_1.renameConversation)(args.id, String(args.title ?? ''));
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.convClear, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        (0, conversations_1.clearAllConversations)();
    });
    conversations_1.conversationEvents.on('changed', (list) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            if (!ctx.chrome.webContents.isDestroyed())
                ctx.chrome.webContents.send(ipc_channels_1.IPC.ai.convChanged, list);
        }
    });
    // ===== 대화 폴더 / 태그 =====
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.folderList, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, conversations_1.listFolders)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.folderCreate, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return args?.name ? (0, conversations_1.createFolder)(args.name) : null;
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.folderRename, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.id)
            (0, conversations_1.renameFolder)(args.id, String(args.name ?? ''));
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.folderDelete, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.id)
            (0, conversations_1.deleteFolder)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.convSetFolder, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.id)
            (0, conversations_1.setConversationFolder)(args.id, args.folderId ?? null);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.convSetTags, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.id)
            (0, conversations_1.setConversationTags)(args.id, Array.isArray(args.tags) ? args.tags : []);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.convSetPinned, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.id)
            (0, conversations_1.setConversationPinned)(args.id, !!args.pinned);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.convSearch, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, conversations_1.searchConversations)(String(args?.query ?? ''));
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.folderReorder, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (Array.isArray(args?.orderedIds))
            (0, conversations_1.reorderFolders)(args.orderedIds);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.convExport, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false };
        const conv = args?.id ? (0, conversations_1.getConversation)(args.id) : null;
        if (!conv)
            return { ok: false };
        const res = await (0, conversations_1.writeDownloadMd)((0, conversations_1.safeFileName)(conv.title || 'conversation'), (0, conversations_1.conversationToMarkdown)(conv));
        if (res.ok && res.path && !e.sender.isDestroyed()) {
            e.sender.send('toast:show', { message: `대화 내보냄 ⤓ ${node_path_1.default.basename(res.path)}`, ts: Date.now() });
        }
        return res;
    });
    // 여러 대화를 하나의 마크다운으로 (현재 필터된 목록/폴더 통째로)
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.convExportBulk, async (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return { ok: false, count: 0 };
        const ids = Array.isArray(args?.ids) ? args.ids : [];
        const convs = ids.map((id) => (0, conversations_1.getConversation)(id)).filter((c) => !!c);
        if (convs.length === 0)
            return { ok: false, count: 0 };
        const res = await (0, conversations_1.writeDownloadMd)((0, conversations_1.safeFileName)(`대화모음 ${convs.length}개`), (0, conversations_1.conversationsToMarkdown)(convs));
        if (res.ok && res.path && !e.sender.isDestroyed()) {
            e.sender.send('toast:show', { message: `대화 ${convs.length}개 내보냄 ⤓ ${node_path_1.default.basename(res.path)}`, ts: Date.now() });
        }
        return { ...res, count: convs.length };
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.folderSetColor, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.id && args?.color)
            (0, conversations_1.setFolderColor)(args.id, args.color);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.folderSetEmoji, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.id)
            (0, conversations_1.setFolderEmoji)(args.id, String(args.emoji ?? ''));
    });
    conversations_1.conversationEvents.on('folders', (list) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            if (!ctx.chrome.webContents.isDestroyed())
                ctx.chrome.webContents.send(ipc_channels_1.IPC.ai.folderChanged, list);
        }
    });
    // ===== 에이전트 작업 매크로 =====
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.taskList, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, saved_tasks_1.listSavedTasks)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.taskAdd, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        if (!args?.task)
            return null;
        return (0, saved_tasks_1.addSavedTask)(args.task, args.name);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.taskRemove, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.id)
            (0, saved_tasks_1.removeSavedTask)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.taskRename, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.id)
            (0, saved_tasks_1.renameSavedTask)(args.id, String(args.name ?? ''));
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.taskTouch, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.id)
            (0, saved_tasks_1.touchSavedTask)(args.id);
    });
    saved_tasks_1.savedTaskEvents.on('changed', (list) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            if (!ctx.chrome.webContents.isDestroyed())
                ctx.chrome.webContents.send(ipc_channels_1.IPC.ai.taskChanged, list);
        }
    });
    // ===== 에이전트 실행 이력 =====
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.runList, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, agent_runs_1.listAgentRuns)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.runGet, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return args?.id ? (0, agent_runs_1.getAgentRun)(args.id) : null;
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.runDelete, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        if (args?.id)
            (0, agent_runs_1.deleteAgentRun)(args.id);
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.runClear, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return;
        (0, agent_runs_1.clearAgentRuns)();
    });
    agent_runs_1.agentRunEvents.on('changed', (list) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            if (!ctx.chrome.webContents.isDestroyed())
                ctx.chrome.webContents.send(ipc_channels_1.IPC.ai.runChanged, list);
        }
    });
    // ===== 영속 작업 런타임 =====
    registerPersistentTaskIpc();
}
// 보낸 창(webContents)이 어느 BrowserWindowContext 에 속하는지 역추적.
// extensions.ts 의 resolveWindowId 와 같은 패턴 — 창마다 "외피 webContents" 하나(id)와
// "그 창의 BaseWindow" 둘 다로 매칭해, 탭/콘텐츠 쪽 webContents 가 잘못 걸리지 않게 한다.
function resolveSenderWindowId(e) {
    const wc = electron_1.BrowserWindow.fromWebContents(e.sender);
    for (const ctx of (0, window_service_1.getAllWindows)()) {
        if (ctx.chrome.webContents.id === e.sender.id)
            return ctx.id;
        if (wc && ctx.win === wc)
            return ctx.id;
    }
    return null;
}
// 이 작업을 이 창(sender)이 조작해도 되는가.
// ownerWindowId 가 null 인 작업은 무인 트리거·재시작 복원 등 "특정 창 소유가 아닌" 경우라
// 창을 가려낼 방법이 없으므로 어느 신뢰 창에서든 조작을 허용한다.
// null 이 아니면 정확히 그 창에서 온 요청만 통과 — 다른 창·외부 페이지가 남의 작업을
// 중단·승인·삭제하는 것을 막는 자리.
function ownsTask(e, task) {
    if (task.ownerWindowId === null)
        return true;
    return resolveSenderWindowId(e) === task.ownerWindowId;
}
function taskNotFound() {
    return { ok: false, error: '작업을 찾을 수 없습니다(이미 삭제되었을 수 있습니다).' };
}
function taskOwnershipDenied() {
    return { ok: false, error: '이 작업을 시작한 창에서만 조작할 수 있습니다.' };
}
const MAX_TASK_INSTRUCTION_LEN = 4000;
function clampFiniteNumber(v, min, max) {
    if (typeof v !== 'number' || !Number.isFinite(v))
        return undefined;
    return Math.min(max, Math.max(min, Math.floor(v)));
}
// budget 은 사용자가 직접 타이핑하는 값은 아니지만(장기/일반 모드 선택에서 UI 가 계산해 보냄),
// 검증 없이 그대로 구간 루프에 흘려보내면 0·음수·Infinity·비정상 배열이 예산 계산·allowedHosts
// 매칭을 깨뜨릴 수 있다 — 이 저장소에서 반복된 "받은 값을 그대로 저장" 결함과 같은 부류.
function sanitizeTaskBudget(b) {
    if (!b || typeof b !== 'object')
        return undefined;
    const src = b;
    const out = {};
    const maxSteps = clampFiniteNumber(src.maxSteps, 1, 5000);
    if (maxSteps !== undefined)
        out.maxSteps = maxSteps;
    const maxDurationMs = clampFiniteNumber(src.maxDurationMs, 10_000, 172_800_000); // 10초 ~ 48시간
    if (maxDurationMs !== undefined)
        out.maxDurationMs = maxDurationMs;
    const maxLlmCalls = clampFiniteNumber(src.maxLlmCalls, 1, 5000);
    if (maxLlmCalls !== undefined)
        out.maxLlmCalls = maxLlmCalls;
    if (Array.isArray(src.allowedHosts)) {
        out.allowedHosts = src.allowedHosts
            .filter((h) => typeof h === 'string' && h.trim().length > 0 && h.length <= 253)
            .slice(0, 50)
            .map((h) => h.trim().toLowerCase());
    }
    return out;
}
function registerPersistentTaskIpc() {
    // 목록·조회는 다른 대화·실행 이력 목록과 같은 원칙 — 이 데스크톱 앱엔 창별 데이터 격리가
    // 없으므로(convList·runList 등도 전역 공개) 소유권 검사 없이 모든 신뢰 창에 보인다.
    // 상태를 "바꾸는" 채널만 아래에서 ownsTask 로 가린다.
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.ptaskList, (e) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return [];
        return (0, task_runtime_1.listTasks)();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.ptaskGet, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return typeof args?.id === 'string' && args.id ? (0, task_runtime_1.getTask)(args.id) : null;
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.ptaskCreate, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        const instruction = typeof args?.instruction === 'string' ? args.instruction.trim() : '';
        if (!instruction || instruction.length > MAX_TASK_INSTRUCTION_LEN)
            return null;
        if (typeof args?.tabId !== 'string' || !args.tabId)
            return null;
        // windowId 는 렌더러가 보낸 값을 쓰지 않는다. 이 값이 그대로 작업의 ownerWindowId 가 되어
        // 이후 모든 조작 권한의 기준이 되므로, 다른 창 id 를 주장해 소유권을 위조하지 못하도록
        // 실제 발신 창에서 직접 구한다(호출자가 windowId 를 아예 안 보내도 항상 정확하다).
        const windowId = resolveSenderWindowId(e);
        // incognito 도 마찬가지로 클라이언트가 알려주는 값이 아니라 창 자체에서 읽는다.
        // task-runtime.ts 는 incognito=true 인 작업을 종료 스냅샷에서 제외한다(디스크에 한 줄도
        // 안 남기는 것이 시크릿 창의 계약) — 이 판정을 렌더러 말을 믿고 하면 그 계약이 깨진다.
        const incognito = windowId ? ((0, window_service_1.getWindow)(windowId)?.incognito ?? false) : false;
        const mode = args?.mode === 'long' ? 'long' : 'normal';
        return (0, task_runtime_1.createTask)({
            instruction,
            tabId: args.tabId,
            windowId,
            mode,
            readOnly: !!args?.readOnly,
            incognito,
            budget: sanitizeTaskBudget(args?.budget),
        });
    });
    const mutate = (channel, apply) => {
        electron_1.ipcMain.handle(channel, (e, args) => {
            if (!(0, trust_1.isTrustedSender)(e))
                return taskOwnershipDenied();
            const task = typeof args?.id === 'string' && args.id ? (0, task_runtime_1.getTask)(args.id) : null;
            if (!task)
                return taskNotFound();
            if (!ownsTask(e, task))
                return taskOwnershipDenied();
            apply(task, e, args);
            return { ok: true };
        });
    };
    mutate(ipc_channels_1.IPC.ai.ptaskStart, (task) => (0, task_runtime_1.startTask)(task.id));
    mutate(ipc_channels_1.IPC.ai.ptaskPause, (task) => (0, task_runtime_1.pauseTask)(task.id));
    mutate(ipc_channels_1.IPC.ai.ptaskResume, (task) => (0, task_runtime_1.resumeTask)(task.id));
    mutate(ipc_channels_1.IPC.ai.ptaskCancel, (task) => (0, task_runtime_1.cancelTask)(task.id));
    mutate(ipc_channels_1.IPC.ai.ptaskDelete, (task) => (0, task_runtime_1.deleteTask)(task.id));
    mutate(ipc_channels_1.IPC.ai.ptaskAccept, (task) => (0, task_runtime_1.acceptTaskResult)(task.id));
    mutate(ipc_channels_1.IPC.ai.ptaskConfirm, (task, _e, args) => (0, task_runtime_1.confirmTask)(task.id, !!args.approved));
    mutate(ipc_channels_1.IPC.ai.ptaskAnswer, (task, _e, args) => (0, task_runtime_1.answerTask)(task.id, String(args.answer ?? '')));
    task_runtime_1.taskEvents.on('changed', (list) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            if (!ctx.chrome.webContents.isDestroyed())
                ctx.chrome.webContents.send(ipc_channels_1.IPC.ai.ptaskChanged, list);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.ai.ptaskChanged, list);
    });
    task_runtime_1.taskEvents.on('event', (evt) => {
        for (const ctx of (0, window_service_1.getAllWindows)()) {
            if (!ctx.chrome.webContents.isDestroyed())
                ctx.chrome.webContents.send(ipc_channels_1.IPC.ai.ptaskEvent, evt);
        }
        (0, window_service_1.broadcastToInternalPages)(ipc_channels_1.IPC.ai.ptaskEvent, evt);
    });
    // 반복 예약(agent-schedule) 재개 — 이미 완성된 resumeRepeat() 를 그대로 IPC 로 노출.
    // 소유권 개념이 없는 기능(repeatStart/Stop 도 동일)이라 owns 검사 없이 신뢰 창이면 허용.
    electron_1.ipcMain.handle(ipc_channels_1.IPC.ai.scheduleResume, (e, args) => {
        if (!(0, trust_1.isTrustedSender)(e))
            return null;
        return typeof args?.id === 'string' && args.id ? (0, agent_schedule_1.resumeRepeat)(args.id) : null;
    });
}
