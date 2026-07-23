import { dialog, ipcMain, net } from 'electron'
import path from 'node:path'
import { IPC } from '../../shared/ipc-channels'
import { isTrustedSender } from './trust'
import { getSetting, setSetting } from '../storage/settings'
import { agentFilesDir, listAgentFiles } from '../features/ai/agent-files'
import {
  getAiClientConfig, getAiKeyStatus, getAiPageInfo, startAiChat, cancelAiChat, maybeAutoRemember, summarizeChat, diagnoseAi,
  type AiMessage,
} from '../features/ai'
import { setAiKey, clearAiKey, type AiSecretProvider } from '../features/ai/keys'
import { runAgentTask, confirmAgentStep, replyAgentAsk, cancelAgentTask, resetAgentSession, runAgentBatch, cancelAgentBatch } from '../features/ai/agent'
import { startRepeat, stopRepeat, removeRepeat, listRepeats, repeatEvents, type RepeatSummary } from '../features/ai/agent-schedule'
import { getMemoryText, setMemoryText, clearMemory, memoryEvents } from '../features/ai/memory'
import { listTriggers, addTrigger, updateTrigger, removeTrigger, setTriggerEnabled, triggerEvents, type AgentTrigger } from '../features/ai/agent-triggers'
import { getProfile, setProfile, storageAvailable, PROFILE_FIELDS, profileEvents } from '../features/ai/profile'
import { generateBlogDraft, generateSeriesPlan, refineBlogBody, type BlogDraftParams, type SeriesPlanParams, type RefineParams } from '../features/ai/blog-writer'
import { buildBlogTask, NAVER_WRITE_URL, type BlogTaskParams } from '../features/ai/blog-publish'
import {
  listBlogDrafts, getBlogDraft, saveBlogDraft, removeBlogDraft, blogDraftEvents, type BlogDraftSummary,
} from '../features/ai/blog-drafts'
import {
  listCollectors, addCollector, updateCollector, removeCollector, setCollectorEnabled,
  runCollectorNow, listRunsFor, collectorEvents, type FeedCollector,
} from '../features/ai/feed-collector'
import {
  listConversations, getConversation, saveConversation, deleteConversation,
  renameConversation, clearAllConversations, conversationEvents, type StoredMessage, type ConversationSummary,
  listFolders, createFolder, renameFolder, deleteFolder, reorderFolders, setFolderColor, setConversationFolder, setConversationTags,
  setConversationPinned, searchConversations, setFolderEmoji, conversationToMarkdown, conversationsToMarkdown,
  safeFileName, writeDownloadMd, type ChatFolder, type FolderColor,
} from '../features/ai/conversations'
import { buildSiteReportTask, type SiteReportParams } from '../features/ai/site-report'
import {
  listSavedTasks, addSavedTask, removeSavedTask, renameSavedTask, touchSavedTask, savedTaskEvents, type SavedAgentTask,
} from '../features/ai/saved-tasks'
import {
  listAgentRuns, getAgentRun, recordAgentEvent, deleteAgentRun, clearAgentRuns, agentRunEvents, type AgentRunSummary,
} from '../features/ai/agent-runs'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'

interface SendArgs {
  reqId: string
  tabId?: string
  includePage?: boolean
  messages: AiMessage[]
  summary?: string // 접힌 이전 대화 요약(압축 기능)
}

export function registerAiIpc(): void {
  ipcMain.handle(IPC.ai.config, async (e) => {
    if (!isTrustedSender(e)) return null
    return getAiClientConfig()
  })

  ipcMain.handle(IPC.ai.pageContext, async (e, args: { tabId?: string }) => {
    if (!isTrustedSender(e)) return null
    return getAiPageInfo(args?.tabId)
  })

  ipcMain.handle(IPC.ai.keyStatus, async (e) => {
    if (!isTrustedSender(e)) return null
    return getAiKeyStatus()
  })

  // AI 상태 점검 — 현재 제공자에 실제 요청을 보내 정상/원인+해결책 판정.
  ipcMain.handle(IPC.ai.diagnose, async (e) => {
    if (!isTrustedSender(e)) return null
    try { return await diagnoseAi() } catch (err) {
      return { ok: false, status: 'error', message: '점검 중 오류', detail: err instanceof Error ? err.message : String(err) }
    }
  })

  const SECRET_PROVIDERS: AiSecretProvider[] = ['anthropic', 'openai', 'google']

  ipcMain.handle(IPC.ai.setKey, async (e, args: { provider: AiSecretProvider; key: string }) => {
    if (!isTrustedSender(e)) return { ok: false }
    if (!SECRET_PROVIDERS.includes(args.provider)) return { ok: false }
    const ok = await setAiKey(args.provider, args.key ?? '')
    return { ok, status: await getAiKeyStatus() }
  })

  ipcMain.handle(IPC.ai.clearKey, async (e, args: { provider: AiSecretProvider }) => {
    if (!isTrustedSender(e)) return { ok: false }
    if (!SECRET_PROVIDERS.includes(args.provider)) return { ok: false }
    await clearAiKey(args.provider)
    return { ok: true, status: await getAiKeyStatus() }
  })

  // 에이전트 자료 폴더 — 폴더 선택(네이티브) + 현재 폴더/파일 정보
  ipcMain.handle(IPC.ai.pickAgentDir, async (e) => {
    if (!isTrustedSender(e)) return { ok: false }
    const res = await dialog.showOpenDialog({ title: '에이전트 자료 폴더 선택', properties: ['openDirectory'] })
    if (res.canceled || !res.filePaths[0]) return { ok: false, dir: agentFilesDir(), count: listAgentFiles().length }
    setSetting('ai', { ...getSetting('ai'), agentFilesDir: res.filePaths[0] })
    return { ok: true, dir: res.filePaths[0], count: listAgentFiles().length }
  })

  ipcMain.handle(IPC.ai.agentFilesInfo, (e) => {
    if (!isTrustedSender(e)) return { dir: '', count: 0, files: [] }
    const files = listAgentFiles()
    return { dir: agentFilesDir(), count: files.length, files: files.slice(0, 50) }
  })

  ipcMain.handle(IPC.ai.send, async (e, args: SendArgs) => {
    if (!isTrustedSender(e)) return { ok: false }
    if (!args || !Array.isArray(args.messages) || !args.reqId) return { ok: false }
    const sender = e.sender
    const send = (channel: string, payload: unknown): void => {
      if (!sender.isDestroyed()) sender.send(channel, payload)
    }
    // 창이 스트리밍 중 닫히면 남은 스트림 핸들을 정리한다.
    sender.once('destroyed', () => { try { cancelAiChat(args.reqId) } catch { /* ignore */ } })
    await startAiChat(
      {
        reqId: args.reqId,
        tabId: args.tabId,
        includePage: !!args.includePage,
        messages: args.messages,
        summary: typeof args.summary === 'string' ? args.summary : undefined,
      },
      {
        onDelta: (text) => send(IPC.ai.delta, { reqId: args.reqId, text }),
        onDone: (text) => {
          send(IPC.ai.done, { reqId: args.reqId, text })
          // 자동 Dreaming(설정 ON 시): 대화에서 장기 기억할 사실 추출 — 저장되면 조용히 알림.
          void maybeAutoRemember([...args.messages, { role: 'assistant', content: text }]).then((added) => {
            if (added.length && !sender.isDestroyed()) {
              const more = added.length > 1 ? ` 외 ${added.length - 1}건` : ''
              sender.send('toast:show', { message: `🧠 기억에 추가됨: ${(added[0] ?? '').slice(0, 24)}${more}`, ts: Date.now() })
            }
          })
        },
        onError: (message) => send(IPC.ai.error, { reqId: args.reqId, message }),
      },
    )
    return { ok: true }
  })

  ipcMain.handle(IPC.ai.cancel, (e, args: { reqId: string }) => {
    if (!isTrustedSender(e)) return
    if (args?.reqId) cancelAiChat(args.reqId)
  })

  // 대화 압축 — 접을 메시지들을 요약해 반환(+이전 요약 통합).
  ipcMain.handle(IPC.ai.summarize, async (e, args: { messages: AiMessage[]; prevSummary?: string }) => {
    if (!isTrustedSender(e)) return { ok: false, summary: '' }
    if (!args || !Array.isArray(args.messages)) return { ok: false, summary: '' }
    try {
      const summary = await summarizeChat(args.messages, args.prevSummary)
      return { ok: !!summary, summary }
    } catch (err) {
      return { ok: false, summary: '', error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ===== 에이전트 =====
  ipcMain.handle(IPC.ai.agentStart, async (e, args: { reqId: string; tabId?: string; task: string; rows?: Array<Record<string, string>>; autoConfirm?: boolean; readOnly?: boolean }) => {
    if (!isTrustedSender(e)) return { ok: false }
    if (!args || !args.reqId || !args.task?.trim()) return { ok: false }
    const sender = e.sender
    const task = args.task.trim()
    // 창이 확인/질문 대기 중 닫히면 에이전트가 리졸버를 붙든 채 영원히 멈춘다 — 창 파괴 시 취소.
    sender.once('destroyed', () => { try { cancelAgentTask(args.reqId); cancelAgentBatch(args.reqId) } catch { /* ignore */ } })
    const forward = (evt: Parameters<typeof recordAgentEvent>[2]): void => {
      recordAgentEvent(args.reqId, task, evt) // 실행 이력 영속화(메인 측 — UI 닫혀도 기록)
      // 보고서 자동 저장 알림(대화 내보내기 토스트와 동일 패턴).
      if ((evt as { type?: string }).type === 'report' && typeof (evt as { path?: string }).path === 'string' && !sender.isDestroyed()) {
        sender.send('toast:show', { message: `보고서 저장됨 ⤓ ${path.basename(String((evt as { path?: string }).path))}`, ts: Date.now() })
      }
      if (!sender.isDestroyed()) sender.send(IPC.ai.agentEvent, { reqId: args.reqId, ...evt })
    }
    // 데이터(CSV/목록) 행이 있으면 각 행마다 작업을 반복하는 대량 처리(batch), 없으면 단일 실행.
    if (Array.isArray(args.rows) && args.rows.length) {
      void runAgentBatch({ reqId: args.reqId, tabId: args.tabId, task, rows: args.rows, autoConfirm: !!args.autoConfirm }, forward)
    } else {
      void runAgentTask({ reqId: args.reqId, tabId: args.tabId, task, readOnly: !!args.readOnly }, forward)
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.ai.agentConfirm, (e, args: { reqId: string; approved: boolean }) => {
    if (!isTrustedSender(e)) return
    if (args?.reqId) confirmAgentStep(args.reqId, !!args.approved)
  })

  ipcMain.handle(IPC.ai.agentReply, (e, args: { reqId: string; answer: string }) => {
    if (!isTrustedSender(e)) return
    if (args?.reqId) replyAgentAsk(args.reqId, String(args.answer ?? ''))
  })

  ipcMain.handle(IPC.ai.agentCancel, (e, args: { reqId: string }) => {
    if (!isTrustedSender(e)) return
    if (args?.reqId) { cancelAgentTask(args.reqId); cancelAgentBatch(args.reqId) }
  })

  // 세션 컨텍스트 초기화("새 작업") — 이후 지시는 이전 대화 맥락 없이 새로 시작.
  ipcMain.handle(IPC.ai.agentReset, (e, args: { windowId: string }) => {
    if (!isTrustedSender(e)) return
    if (args?.windowId) resetAgentSession(args.windowId)
  })

  // ===== 에이전트 작업 자동 반복 =====
  ipcMain.handle(IPC.ai.repeatStart, (e, args: { task: string; windowId: string; tabId: string; intervalMinutes: number; count: number; autoConfirm?: boolean }) => {
    if (!isTrustedSender(e)) return { ok: false }
    const job = startRepeat(args)
    return { ok: !!job, job }
  })
  ipcMain.handle(IPC.ai.repeatStop, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return
    if (args?.id) stopRepeat(args.id)
  })
  ipcMain.handle(IPC.ai.repeatRemove, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return
    if (args?.id) removeRepeat(args.id)
  })
  ipcMain.handle(IPC.ai.repeatList, (e) => {
    if (!isTrustedSender(e)) return []
    return listRepeats()
  })
  repeatEvents.on('changed', (list: RepeatSummary[]) => {
    for (const ctx of getAllWindows()) {
      if (!ctx.chrome.webContents.isDestroyed()) ctx.chrome.webContents.send(IPC.ai.repeatChanged, list)
    }
  })
  repeatEvents.on('event', (evt: Record<string, unknown>) => {
    for (const ctx of getAllWindows()) {
      if (!ctx.chrome.webContents.isDestroyed()) ctx.chrome.webContents.send(IPC.ai.repeatEvent, evt)
    }
  })

  // ===== 메모리 =====
  ipcMain.handle(IPC.ai.memoryGet, (e) => {
    if (!isTrustedSender(e)) return ''
    return getMemoryText()
  })

  ipcMain.handle(IPC.ai.memorySet, async (e, args: { text: string }) => {
    if (!isTrustedSender(e)) return { ok: false }
    await setMemoryText(String(args?.text ?? ''))
    return { ok: true }
  })

  ipcMain.handle(IPC.ai.memoryClear, async (e) => {
    if (!isTrustedSender(e)) return { ok: false }
    await clearMemory()
    return { ok: true }
  })

  memoryEvents.on('changed', (text: string) => {
    for (const ctx of getAllWindows()) {
      if (!ctx.chrome.webContents.isDestroyed()) ctx.chrome.webContents.send(IPC.ai.memoryChanged, text)
    }
    broadcastToInternalPages(IPC.ai.memoryChanged, text)
  })

  // ===== AI 트리거(url 진입 / 매일 / 변경 감지) =====
  ipcMain.handle(IPC.ai.triggerList, (e) => { if (!isTrustedSender(e)) return []; return listTriggers() })
  ipcMain.handle(IPC.ai.triggerAdd, (e, p: Partial<AgentTrigger>) => { if (!isTrustedSender(e)) return null; return addTrigger(p ?? {}) })
  ipcMain.handle(IPC.ai.triggerUpdate, (e, args: { id: string; patch: Partial<AgentTrigger> }) => { if (!isTrustedSender(e)) return; if (args?.id) updateTrigger(args.id, args.patch ?? {}) })
  ipcMain.handle(IPC.ai.triggerRemove, (e, args: { id: string }) => { if (!isTrustedSender(e)) return; if (args?.id) removeTrigger(args.id) })
  ipcMain.handle(IPC.ai.triggerSetEnabled, (e, args: { id: string; enabled: boolean }) => { if (!isTrustedSender(e)) return; if (args?.id) setTriggerEnabled(args.id, !!args.enabled) })
  triggerEvents.on('changed', (list: AgentTrigger[]) => {
    for (const ctx of getAllWindows()) {
      if (!ctx.chrome.webContents.isDestroyed()) ctx.chrome.webContents.send(IPC.ai.triggerChanged, list)
    }
    broadcastToInternalPages(IPC.ai.triggerChanged, list)
  })

  // ===== 스마트 폼필 프로필 (내 정보) =====
  ipcMain.handle(IPC.ai.profileGet, (e) => {
    if (!isTrustedSender(e)) return { fields: PROFILE_FIELDS, values: {}, storageAvailable: false }
    return { fields: PROFILE_FIELDS, values: getProfile(), storageAvailable: storageAvailable() }
  })
  ipcMain.handle(IPC.ai.profileSet, (e, values: Record<string, string>) => {
    if (!isTrustedSender(e)) return { ok: false }
    setProfile(values ?? {})
    return { ok: true }
  })
  profileEvents.on('changed', () => { broadcastToInternalPages(IPC.ai.profileChanged, true) })

  // ===== 결과 내보내기·연동 (웹훅 JSON POST) — Zapier·Make·구글시트 Apps Script·노션·메일 등으로 라우팅 =====
  ipcMain.handle(IPC.ai.exportWebhook, async (e, args: { rows: unknown[]; url?: string }) => {
    if (!isTrustedSender(e)) return { ok: false, detail: '권한 없음' }
    const url = (args?.url || getSetting('ai').webhookUrl || '').trim()
    if (!/^https?:\/\//i.test(url)) return { ok: false, detail: '웹훅 URL 이 설정되지 않았습니다(설정 > AI).' }
    const rows = Array.isArray(args?.rows) ? args.rows.slice(0, 5000) : []
    const body = JSON.stringify({ source: 'ezBrowser', count: rows.length, rows, at: Date.now() })
    return await new Promise<{ ok: boolean; detail: string }>((resolve) => {
      try {
        const req = net.request({ url, method: 'POST' })
        req.setHeader('content-type', 'application/json')
        const timer = setTimeout(() => { try { req.abort() } catch { /* ignore */ }; resolve({ ok: false, detail: '시간 초과' }) }, 20000)
        req.on('response', (resp) => {
          const status = resp.statusCode ?? 0
          resp.on('data', () => { /* drain */ })
          resp.on('end', () => { clearTimeout(timer); resolve(status >= 200 && status < 400 ? { ok: true, detail: `전송됨 (${status})` } : { ok: false, detail: `실패 (${status})` }) })
          resp.on('error', () => { clearTimeout(timer); resolve({ ok: false, detail: '응답 오류' }) })
        })
        req.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, detail: err.message }) })
        req.write(body); req.end()
      } catch (err) { resolve({ ok: false, detail: String(err) }) }
    })
  })

  // ===== 블로그 글쓰기 스튜디오 — 주제·옵션 → 구조화 초안 생성(발행은 사용자가 트리거) =====
  ipcMain.handle(IPC.ai.blogGenerate, async (e, params: BlogDraftParams) => {
    if (!isTrustedSender(e)) return { ok: false, error: '권한 없음' }
    if (!params?.topic?.trim()) return { ok: false, error: '주제를 입력하세요.' }
    try {
      const draft = await generateBlogDraft(params)
      return { ok: true, draft }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 초안 → "에디터를 열어 작성/임시저장/발행" 하는 에이전트 태스크로 변환(네이버 SmartEditor ONE 인지).
  ipcMain.handle(IPC.ai.blogBuildTask, (e, params: BlogTaskParams) => {
    if (!isTrustedSender(e)) return { task: '', naverWriteUrl: NAVER_WRITE_URL }
    const task = buildBlogTask({
      platform: params?.platform, mode: params?.mode ?? 'insert',
      title: String(params?.title ?? ''), body: String(params?.body ?? ''),
      tags: Array.isArray(params?.tags) ? params.tags : [], autoOpen: !!params?.autoOpen,
    })
    return { task, naverWriteUrl: NAVER_WRITE_URL }
  })

  // 사이트 분석 보고서 — 원클릭 태스크(읽기 전용) 빌드
  ipcMain.handle(IPC.ai.reportBuildTask, (e, params: SiteReportParams) => {
    if (!isTrustedSender(e)) return { task: '', readOnly: true }
    return buildSiteReportTask({
      url: typeof params?.url === 'string' ? params.url : undefined,
      focus: typeof params?.focus === 'string' ? params.focus : undefined,
      depth: typeof params?.depth === 'number' ? params.depth : undefined,
    })
  })

  // 보고서 마크다운을 다운로드 폴더에 .md 로 저장(다이얼로그 없이 결정적).
  ipcMain.handle(IPC.ai.reportExport, async (e, p: { title?: string; markdown?: string }) => {
    if (!isTrustedSender(e)) return { ok: false }
    const md = String(p?.markdown ?? '')
    if (!md.trim()) return { ok: false }
    const base = safeFileName(String(p?.title ?? '보고서') || '보고서')
    const res = await writeDownloadMd(base, md)
    if (res.ok && res.path && !e.sender.isDestroyed()) {
      e.sender.send('toast:show', { message: `보고서 저장됨 ⤓ ${path.basename(res.path)}`, ts: Date.now() })
    }
    return res
  })

  // 블로그 글 다듬기(부분 개선)
  ipcMain.handle(IPC.ai.blogRefine, async (e, params: RefineParams) => {
    if (!isTrustedSender(e)) return { ok: false, error: '권한 없음' }
    if (!params?.body?.trim() || !params?.instruction?.trim()) return { ok: false, error: '본문과 지시가 필요합니다.' }
    try { return { ok: true, body: await refineBlogBody(params) } }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  // 블로그 시리즈 연재 기획
  ipcMain.handle(IPC.ai.blogSeriesPlan, async (e, params: SeriesPlanParams) => {
    if (!isTrustedSender(e)) return { ok: false, error: '권한 없음' }
    if (!params?.topic?.trim()) return { ok: false, error: '주제를 입력하세요.' }
    try { return { ok: true, plan: await generateSeriesPlan(params) } }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  // 블로그 초안 저장·불러오기
  ipcMain.handle(IPC.ai.blogDraftList, (e) => { if (!isTrustedSender(e)) return []; return listBlogDrafts() })
  ipcMain.handle(IPC.ai.blogDraftGet, (e, args: { id: string }) => { if (!isTrustedSender(e)) return null; return args?.id ? getBlogDraft(args.id) : null })
  ipcMain.handle(IPC.ai.blogDraftSave, (e, payload: Parameters<typeof saveBlogDraft>[0]) => { if (!isTrustedSender(e)) return null; return saveBlogDraft(payload ?? {}) })
  ipcMain.handle(IPC.ai.blogDraftRemove, (e, args: { id: string }) => { if (!isTrustedSender(e)) return; if (args?.id) removeBlogDraft(args.id) })
  blogDraftEvents.on('changed', (list: BlogDraftSummary[]) => {
    for (const ctx of getAllWindows()) {
      if (!ctx.chrome.webContents.isDestroyed()) ctx.chrome.webContents.send(IPC.ai.blogDraftChanged, list)
    }
  })

  // ===== 매일 자동 수집 (피드 수집기) =====
  ipcMain.handle(IPC.ai.collectorList, (e) => { if (!isTrustedSender(e)) return []; return listCollectors() })
  ipcMain.handle(IPC.ai.collectorAdd, (e, p: Partial<FeedCollector>) => { if (!isTrustedSender(e)) return null; return addCollector(p ?? {}) })
  ipcMain.handle(IPC.ai.collectorUpdate, (e, args: { id: string; patch: Partial<FeedCollector> }) => { if (!isTrustedSender(e)) return; if (args?.id) updateCollector(args.id, args.patch ?? {}) })
  ipcMain.handle(IPC.ai.collectorRemove, (e, args: { id: string }) => { if (!isTrustedSender(e)) return; if (args?.id) removeCollector(args.id) })
  ipcMain.handle(IPC.ai.collectorSetEnabled, (e, args: { id: string; enabled: boolean }) => { if (!isTrustedSender(e)) return; if (args?.id) setCollectorEnabled(args.id, !!args.enabled) })
  ipcMain.handle(IPC.ai.collectorRun, async (e, args: { id: string }) => { if (!isTrustedSender(e)) return { ok: false }; if (!args?.id) return { ok: false }; const run = await runCollectorNow(args.id); return { ok: !!run, run } })
  ipcMain.handle(IPC.ai.collectorRuns, (e, args: { id: string }) => { if (!isTrustedSender(e)) return []; return args?.id ? listRunsFor(args.id, 10) : [] })
  collectorEvents.on('changed', (list: unknown[]) => {
    for (const ctx of getAllWindows()) {
      if (!ctx.chrome.webContents.isDestroyed()) ctx.chrome.webContents.send(IPC.ai.collectorChanged, list)
    }
    broadcastToInternalPages(IPC.ai.collectorChanged, list)
  })
  collectorEvents.on('run', (run: unknown) => {
    for (const ctx of getAllWindows()) {
      if (!ctx.chrome.webContents.isDestroyed()) ctx.chrome.webContents.send(IPC.ai.collectorRan, run)
    }
    broadcastToInternalPages(IPC.ai.collectorRan, run)
  })

  // ===== 대화 영속화 =====
  ipcMain.handle(IPC.ai.convList, (e) => {
    if (!isTrustedSender(e)) return []
    return listConversations()
  })

  ipcMain.handle(IPC.ai.convGet, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return null
    return args?.id ? getConversation(args.id) : null
  })

  ipcMain.handle(IPC.ai.convSave, (e, args: { id: string; messages: StoredMessage[]; summary?: string; foldCount?: number }) => {
    if (!isTrustedSender(e)) return null
    if (!args?.id || !Array.isArray(args.messages)) return null
    return saveConversation(args.id, args.messages, { summary: args.summary, foldCount: args.foldCount })
  })

  ipcMain.handle(IPC.ai.convDelete, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return
    if (args?.id) deleteConversation(args.id)
  })

  ipcMain.handle(IPC.ai.convRename, (e, args: { id: string; title: string }) => {
    if (!isTrustedSender(e)) return
    if (args?.id) renameConversation(args.id, String(args.title ?? ''))
  })

  ipcMain.handle(IPC.ai.convClear, (e) => {
    if (!isTrustedSender(e)) return
    clearAllConversations()
  })

  conversationEvents.on('changed', (list: ConversationSummary[]) => {
    for (const ctx of getAllWindows()) {
      if (!ctx.chrome.webContents.isDestroyed()) ctx.chrome.webContents.send(IPC.ai.convChanged, list)
    }
  })

  // ===== 대화 폴더 / 태그 =====
  ipcMain.handle(IPC.ai.folderList, (e) => {
    if (!isTrustedSender(e)) return []
    return listFolders()
  })

  ipcMain.handle(IPC.ai.folderCreate, (e, args: { name: string }) => {
    if (!isTrustedSender(e)) return null
    return args?.name ? createFolder(args.name) : null
  })

  ipcMain.handle(IPC.ai.folderRename, (e, args: { id: string; name: string }) => {
    if (!isTrustedSender(e)) return
    if (args?.id) renameFolder(args.id, String(args.name ?? ''))
  })

  ipcMain.handle(IPC.ai.folderDelete, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return
    if (args?.id) deleteFolder(args.id)
  })

  ipcMain.handle(IPC.ai.convSetFolder, (e, args: { id: string; folderId: string | null }) => {
    if (!isTrustedSender(e)) return
    if (args?.id) setConversationFolder(args.id, args.folderId ?? null)
  })

  ipcMain.handle(IPC.ai.convSetTags, (e, args: { id: string; tags: string[] }) => {
    if (!isTrustedSender(e)) return
    if (args?.id) setConversationTags(args.id, Array.isArray(args.tags) ? args.tags : [])
  })

  ipcMain.handle(IPC.ai.convSetPinned, (e, args: { id: string; pinned: boolean }) => {
    if (!isTrustedSender(e)) return
    if (args?.id) setConversationPinned(args.id, !!args.pinned)
  })

  ipcMain.handle(IPC.ai.convSearch, (e, args: { query: string }) => {
    if (!isTrustedSender(e)) return []
    return searchConversations(String(args?.query ?? ''))
  })

  ipcMain.handle(IPC.ai.folderReorder, (e, args: { orderedIds: string[] }) => {
    if (!isTrustedSender(e)) return
    if (Array.isArray(args?.orderedIds)) reorderFolders(args.orderedIds)
  })

  ipcMain.handle(IPC.ai.convExport, async (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return { ok: false }
    const conv = args?.id ? getConversation(args.id) : null
    if (!conv) return { ok: false }
    const res = await writeDownloadMd(safeFileName(conv.title || 'conversation'), conversationToMarkdown(conv))
    if (res.ok && res.path && !e.sender.isDestroyed()) {
      e.sender.send('toast:show', { message: `대화 내보냄 ⤓ ${path.basename(res.path)}`, ts: Date.now() })
    }
    return res
  })

  // 여러 대화를 하나의 마크다운으로 (현재 필터된 목록/폴더 통째로)
  ipcMain.handle(IPC.ai.convExportBulk, async (e, args: { ids: string[] }) => {
    if (!isTrustedSender(e)) return { ok: false, count: 0 }
    const ids = Array.isArray(args?.ids) ? args.ids : []
    const convs = ids.map((id) => getConversation(id)).filter((c): c is NonNullable<typeof c> => !!c)
    if (convs.length === 0) return { ok: false, count: 0 }
    const res = await writeDownloadMd(safeFileName(`대화모음 ${convs.length}개`), conversationsToMarkdown(convs))
    if (res.ok && res.path && !e.sender.isDestroyed()) {
      e.sender.send('toast:show', { message: `대화 ${convs.length}개 내보냄 ⤓ ${path.basename(res.path)}`, ts: Date.now() })
    }
    return { ...res, count: convs.length }
  })

  ipcMain.handle(IPC.ai.folderSetColor, (e, args: { id: string; color: string }) => {
    if (!isTrustedSender(e)) return
    if (args?.id && args?.color) setFolderColor(args.id, args.color as FolderColor)
  })

  ipcMain.handle(IPC.ai.folderSetEmoji, (e, args: { id: string; emoji: string }) => {
    if (!isTrustedSender(e)) return
    if (args?.id) setFolderEmoji(args.id, String(args.emoji ?? ''))
  })

  conversationEvents.on('folders', (list: ChatFolder[]) => {
    for (const ctx of getAllWindows()) {
      if (!ctx.chrome.webContents.isDestroyed()) ctx.chrome.webContents.send(IPC.ai.folderChanged, list)
    }
  })

  // ===== 에이전트 작업 매크로 =====
  ipcMain.handle(IPC.ai.taskList, (e) => {
    if (!isTrustedSender(e)) return []
    return listSavedTasks()
  })

  ipcMain.handle(IPC.ai.taskAdd, (e, args: { task: string; name?: string }) => {
    if (!isTrustedSender(e)) return null
    if (!args?.task) return null
    return addSavedTask(args.task, args.name)
  })

  ipcMain.handle(IPC.ai.taskRemove, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return
    if (args?.id) removeSavedTask(args.id)
  })

  ipcMain.handle(IPC.ai.taskRename, (e, args: { id: string; name: string }) => {
    if (!isTrustedSender(e)) return
    if (args?.id) renameSavedTask(args.id, String(args.name ?? ''))
  })

  ipcMain.handle(IPC.ai.taskTouch, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return
    if (args?.id) touchSavedTask(args.id)
  })

  savedTaskEvents.on('changed', (list: SavedAgentTask[]) => {
    for (const ctx of getAllWindows()) {
      if (!ctx.chrome.webContents.isDestroyed()) ctx.chrome.webContents.send(IPC.ai.taskChanged, list)
    }
  })

  // ===== 에이전트 실행 이력 =====
  ipcMain.handle(IPC.ai.runList, (e) => {
    if (!isTrustedSender(e)) return []
    return listAgentRuns()
  })

  ipcMain.handle(IPC.ai.runGet, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return null
    return args?.id ? getAgentRun(args.id) : null
  })

  ipcMain.handle(IPC.ai.runDelete, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return
    if (args?.id) deleteAgentRun(args.id)
  })

  ipcMain.handle(IPC.ai.runClear, (e) => {
    if (!isTrustedSender(e)) return
    clearAgentRuns()
  })

  agentRunEvents.on('changed', (list: AgentRunSummary[]) => {
    for (const ctx of getAllWindows()) {
      if (!ctx.chrome.webContents.isDestroyed()) ctx.chrome.webContents.send(IPC.ai.runChanged, list)
    }
  })
}
