import { dialog } from 'electron'
import path from 'node:path'
import { getSetting } from '../../storage/settings'
import {
  getWebContentsByTabId, findTabIdByWebContentsId, listTabs, createTab, activateTab, closeTab,
} from '../../tabs/tab-service'
import { getAiKey } from './keys'
import { memoryBlock, appendMemory } from './memory'
import { chatOnce, chatWithTools, supportsNativeTools, supportsVision, isCliProvider, cliPathSettingKey, type AiMessage, type AiRequest, type ToolSpec, type ToolCall } from './providers'
import {
  observePage, executeInPageAction, setFileInputFiles, extractFromPage,
  waitForOnPage, runPageJs, hoverElement, dragOnPage, pressKey, resolveHref, autofillPage,
  type AgentAction, type PageObservation,
} from './page-actions'
import { getProfile, hasProfileData } from './profile'
import { hasAgentFilesDir, listAgentFiles, resolveAgentFile } from './agent-files'
import { writeDownloadMd, safeFileName } from './conversations'

// 자율 에이전트 — 관찰(observe) → LLM 판단 → 확인 게이트 → 실행(execute) 루프.
// 판단은 두 경로: 지원 제공자/모델이면 네이티브 tool-use(구조화 함수 호출, 더 안정적),
// 아니면 "JSON 액션 프로토콜"로 폴백 → 로컬 Ollama·Gemini·Claude·OpenAI 어디서든 동작.

export interface AgentEvent { type: string; [k: string]: unknown }
type Emit = (evt: AgentEvent) => void

const DEFAULT_MAX_STEPS = 25
const STUCK_REPEAT = 3    // 같은 동작이 이만큼 반복되면 막힘으로 보고 사용자에게 물음
const NOPARSE_LIMIT = 3   // 응답을 이만큼 연속으로 못 읽으면 중단
const FAIL_LIMIT = 3      // 같은 실패가 이만큼 연속되면 사용자에게 물음

const cancelledSet = new Set<string>()
const pendingConfirm = new Map<string, (approved: boolean) => void>()
const pendingAsk = new Map<string, (answer: string | null) => void>()
const activeCall = new Map<string, () => void>()

// 세션 대화 맥락 — 창(windowId) 단위로 이전 지시와 결과를 이어붙여, 다음 지시가
// "그거/거기/방금" 처럼 이전 맥락을 참조할 수 있게 한다("대화가 이어져야 한다").
// 사용자가 "＋ 새 작업" 을 누르면 resetAgentSession 으로 비운다.
interface AgentTurn { task: string; outcome: string }
const agentSessions = new Map<string, AgentTurn[]>()
const MAX_SESSION_TURNS = 8

export function resetAgentSession(key: string): void {
  if (key) agentSessions.delete(key)
}

function priorContextBlock(turns: AgentTurn[] | undefined): string {
  if (!turns || turns.length === 0) return ''
  const lines = turns.map((t, i) => `${i + 1}. 이전 지시: ${t.task}\n   → 결과: ${t.outcome}`).join('\n')
  return '\n\n# 지금까지의 대화 맥락 (같은 세션의 이전 지시와 결과)\n'
    + '이어서 같은 흐름으로 작업하세요. 사용자가 "그거/거기/방금/이어서" 처럼 말하면 아래 맥락을 가리킵니다.\n'
    + lines
}

// 되돌리기 어려운(민감) 행동 키워드 — 매칭 시 사용자 확인을 거친다(자동 승인 금지).
const SENSITIVE = /결제|구매|구입|주문|송금|이체|삭제|탈퇴|게시|게재|발행|등록|올리기|전송|보내기|보내|제출|purchase|checkout|payment|publish|register|\bpay\b|\border\b|\bbuy\b|delete|remove|\bpost\b|\bsend\b|submit|subscribe|sign\s?out|log\s?out|로그아웃/i
// URL(navigate)용 좁은 셋 — 블로그 "post"·"send" 오탐을 피하되 결제/구매성 GET 은 확인을 거친다.
const SENSITIVE_URL = /checkout|\bpayment\b|purchase|결제|송금|이체/i

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// 화면 인식 — 현재 탭의 보이는 화면을 캡처해 base64 PNG 로. 폭 1024 로 축소(토큰·비용 절약).
async function captureScreenshot(wc: Electron.WebContents): Promise<string | undefined> {
  // 첫 프레임이 아직 안 그려졌거나 일시적 실패 시 몇 번 재시도(창이 가려져 있으면 결국 undefined → DOM 만으로 진행).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const img = await wc.capturePage()
      const sz = img.getSize()
      if (!img.isEmpty() && sz.width > 0) {
        const resized = sz.width > 1024 ? img.resize({ width: 1024 }) : img
        const b64 = resized.toPNG().toString('base64')
        if (b64) return b64
      }
    } catch { /* 재시도 */ }
    await sleep(200)
  }
  return undefined
}

// click_at 좌표 지점에 있는 요소의 라벨을 조사한다 — 민감 동작 확인·막힘 감지·표시에 쓴다.
async function probeClickAtLabel(wc: Electron.WebContents, action: AgentAction): Promise<string> {
  const x = Number.isFinite(action.xPct as number) ? Number(action.xPct) : 50
  const y = Number.isFinite(action.yPct as number) ? Number(action.yPct) : 50
  try {
    const js = `(function(){var x=Math.max(0,Math.min(100,${x}))/100*innerWidth,y=Math.max(0,Math.min(100,${y}))/100*innerHeight;var el=document.elementFromPoint(x,y);if(!el)return '';return ((el.innerText||el.textContent||(el.getAttribute&&el.getAttribute('aria-label'))||'')+' '+el.tagName).replace(/\\s+/g,' ').trim().slice(0,120);})()`
    return String((await wc.executeJavaScript(js, true)) || '')
  } catch { return '' }
}

export function confirmAgentStep(reqId: string, approved: boolean): void {
  const fn = pendingConfirm.get(reqId)
  if (fn) { pendingConfirm.delete(reqId); fn(approved) }
}

export function replyAgentAsk(reqId: string, answer: string): void {
  const fn = pendingAsk.get(reqId)
  if (fn) { pendingAsk.delete(reqId); fn(answer) }
}

export function cancelAgentTask(reqId: string): void {
  cancelledSet.add(reqId)
  activeCall.get(reqId)?.()
  const c = pendingConfirm.get(reqId)
  if (c) { pendingConfirm.delete(reqId); c(false) }
  const a = pendingAsk.get(reqId)
  if (a) { pendingAsk.delete(reqId); a(null) }
}

// 지정 자료 폴더가 있으면 사용 가능한 파일 목록을 프롬프트에 넣는다(업로드에 이름으로 지정 가능).
function agentFilesBlock(): string {
  if (!hasAgentFilesDir()) return ''
  const files = listAgentFiles()
  if (files.length === 0) return '\n\n# 자료 폴더\n(지정된 자료 폴더가 비어 있습니다.)'
  return '\n\n# 자료 폴더 (업로드에 쓸 수 있는 파일)\n' + files.join(', ')
    + '\n파일 업로드가 필요하면 upload_file 의 name 에 이 중 하나를 지정하세요.'
}

// 네이티브 tool-use 시 시스템 프롬프트(도구를 호출하도록 안내).
function agentToolSystemPrompt(task: string): string {
  return [
    '당신은 웹 브라우저를 직접 조작하는 자율 에이전트입니다. 매 단계마다 [현재 페이지] 정보와 [조작 가능한 요소] 목록([번호] role "이름")을 보고, 제공된 도구(함수) 중 하나를 호출해 한 번에 정확히 하나의 행동을 합니다.',
    '',
    '규칙:',
    '- ref 는 반드시 이번 관찰에 나온 [번호] 중 하나. 없는 번호를 지어내지 마세요.',
    '- 각 단계에 [열린 탭] 목록(▶ 는 지금 조작 중인 탭)이 주어집니다. 다른 탭이 필요하면 switch_tab, 새 사이트가 필요하면 open_tab.',
    '- 목표를 이미 이뤘으면 곧바로 done. 같은 행동을 반복하지 마세요.',
    '- 결제·구매·주문·삭제·전송·게시처럼 되돌리기 어려운 행동은 사용자 확인을 거칩니다.',
    '- 비밀번호 등 당신이 모르는 정보가 필요하면 ask 로 물으세요.',
    '- 여러 입력창을 채울 때는 type_text 도구를 연속으로 여러 번 호출해도 됩니다(한 번에 처리 — 마지막에 클릭/제출).',
    '- 반드시 도구를 호출하세요(설명만 하지 말고). thought 인자에 이유를 한 문장으로.',
    '',
    '# 사용자가 지시한 작업',
    task,
  ].join('\n') + (getSetting('ai').memoryEnabled ? memoryBlock(1500) : '') + agentFilesBlock()
}

// 네이티브 tool-use 도구 정의 — JSON 프로토콜의 액션과 1:1 대응.
const THOUGHT_PROP = { thought: { type: 'string', description: '무엇을 왜 하는지 한 문장(한국어)' } }
function toolSpec(name: string, description: string, props: Record<string, unknown>, required: string[] = []): ToolSpec {
  return { name, description, parameters: { type: 'object', properties: { ...THOUGHT_PROP, ...props }, required } }
}
const AGENT_TOOLS: ToolSpec[] = [
  toolSpec('click', '요소를 클릭', { ref: { type: 'integer', description: '관찰의 [번호]' } }, ['ref']),
  toolSpec('type_text', '입력창에 텍스트 입력', { ref: { type: 'integer' }, text: { type: 'string' }, submit: { type: 'boolean', description: 'true 면 Enter 로 제출' } }, ['ref', 'text']),
  toolSpec('navigate', '현재 탭에서 URL 로 이동', { url: { type: 'string' } }, ['url']),
  toolSpec('open_tab', '새 탭을 열고 그 탭으로 작업을 계속', { url: { type: 'string' } }, ['url']),
  toolSpec('switch_tab', '[열린 탭] 번호로 전환', { index: { type: 'integer' } }, ['index']),
  toolSpec('close_tab', '[열린 탭] 번호를 닫기(지금 조작 중인 탭 제외)', { index: { type: 'integer' } }, ['index']),
  toolSpec('scroll', '페이지 스크롤', { direction: { type: 'string', enum: ['up', 'down'] } }, ['direction']),
  toolSpec('upload_file', '파일/사진 업로드. "컴퓨터에서 선택" 같은 버튼은 클릭하지 말고 이 도구를 쓰세요(그 버튼은 OS 창을 열어 조작 불가). name 에 [자료 폴더] 의 파일 이름(하위 폴더면 photos/cat.jpg 처럼)을 주면 그 파일을 바로 첨부하고, 생략하면 사용자가 창에서 고릅니다.', { name: { type: 'string', description: '[자료 폴더] 의 파일 경로(예: cat.jpg 또는 photos/cat.jpg). 모르면 생략' } }),
  toolSpec('read', '페이지를 다시 관찰', {}),
  toolSpec('wait', '잠시 대기', {}),
  toolSpec('wait_for', '요소나 텍스트가 나타날 때까지 대기(동적 페이지·로딩·AJAX). selector(CSS) 또는 text 중 하나, timeout(ms).', { selector: { type: 'string' }, text: { type: 'string' }, timeout: { type: 'integer', description: '최대 대기 ms(기본 10000)' } }),
  toolSpec('key', '키보드 키/조합을 누름(실제 키 입력 — Enter·Tab·Escape·방향키·Ctrl+A 등 기본 동작 발동). ref 를 주면 그 요소에 먼저 포커스.', { key: { type: 'string', description: '예 "Enter","Tab","Escape","Control+a"' }, ref: { type: 'integer' } }, ['key']),
  toolSpec('hover', '요소에 마우스를 올림(호버로만 뜨는 메뉴 등).', { ref: { type: 'integer' } }, ['ref']),
  toolSpec('drag', '요소/좌표에서 요소/좌표로 드래그(슬라이더·정렬·캔버스). 시작=ref 또는 xPct,yPct / 끝=toRef 또는 toXPct,toYPct.', { ref: { type: 'integer' }, xPct: { type: 'number' }, yPct: { type: 'number' }, toRef: { type: 'integer' }, toXPct: { type: 'number' }, toYPct: { type: 'number' } }),
  toolSpec('download', '파일 다운로드 — ref(링크 요소) 또는 url 을 받아 다운로드 관리자로 내려받음.', { ref: { type: 'integer' }, url: { type: 'string' } }),
  toolSpec('run_js', '페이지에서 자바스크립트를 실행하고 결과를 받음(추출·조작 만능). 마지막 값을 return 하세요.', { code: { type: 'string' } }, ['code']),
  toolSpec('autofill', '저장된 내 프로필(이름·주소·이메일·전화·카드 등)로 현재 페이지의 폼을 자동으로 채움. 가입·주문·신청 폼에 사용. 값은 안전 저장소에서 오며 당신(AI)에게는 노출되지 않습니다.', {}),
  toolSpec('remember', '다음에도 쓸 사실을 기억에 저장(사용자 이름·선호·자주 쓰는 값 등)', { text: { type: 'string' } }, ['text']),
  toolSpec('extract', '페이지에서 구조화된 데이터를 수집(스크래핑). rowSelector(반복 항목 CSS 선택자)+fields({열이름:선택자}, 선택자에 @attr 로 속성 — 예 "a@href","img@src")로 화면 밖 항목까지 완전하게 한 번에 긁습니다(권장). 선택자를 못 쓰면 직접 읽은 데이터를 rows 로 넘기세요. 여러 페이지면 각 페이지에서 호출하면 누적됩니다.', {
    rowSelector: { type: 'string', description: '반복 항목의 CSS 선택자(예 .product, li.item). 페이지 전체를 한 행으로 보려면 생략' },
    fields: { type: 'object', description: '{열이름: 선택자}. 선택자에 @attr 로 속성(예 "a@href"). 행 자체 속성은 "@href"', additionalProperties: { type: 'string' } },
    rows: { type: 'array', description: '선택자 대신 직접 읽은 데이터 행들. [{"열":"값",...}]', items: { type: 'object', additionalProperties: { type: 'string' } } },
  }),
  toolSpec('note', '보고서 노트 — 지금 페이지에서 파악한 내용을 마크다운으로 기록합니다. 페이지마다 호출하면 누적되어 마지막 report 의 본문이 됩니다. 화면에 보이는 실제 데이터(수치·항목·이름·상태)를 구체적으로 적으세요.', { text: { type: 'string', description: '이 페이지에서 파악한 내용(마크다운)' } }, ['text']),
  toolSpec('report', '보고서 완성 — 지금까지 누적한 노트를 종합해 마크다운 보고서로 작업을 종료합니다. 본문은 노트가 자동으로 붙으니 markdown 에는 개요·핵심 결론만 적으면 됩니다.', { title: { type: 'string' }, markdown: { type: 'string', description: '개요·핵심 결론(선택)' } }, ['title']),
  toolSpec('done', '작업 완료 — 사용자에게 최종 결과를 보고', { message: { type: 'string' } }, ['message']),
  toolSpec('ask', '모르는 정보를 사용자에게 질문', { message: { type: 'string' } }, ['message']),
]

// 비전(화면 인식) 이 켜진 경우에만 도구 목록에 더한다 — 요소 목록에 없지만 화면에 보이는 대상을 좌표로 클릭.
const CLICK_AT_TOOL: ToolSpec = toolSpec('click_at', '화면(스크린샷)에서 보이는 지점을 좌표로 클릭 — [조작 가능한 요소] 목록에 없지만 화면에 보이는 대상(캔버스·커스텀 UI 등)에 사용. 목록에 있으면 click(ref) 을 우선.', { xPct: { type: 'number', description: '화면 가로의 0~100 (%)' }, yPct: { type: 'number', description: '화면 세로의 0~100 (%)' } }, ['xPct', 'yPct'])

function asNum(x: unknown): number | undefined {
  if (typeof x === 'number' && Number.isFinite(x)) return x
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x)
  return undefined
}

// 구조화된 tool_call → 내부 AgentAction(JSON 경로와 동일 실행기 재사용).
function toolCallToAction(tc: ToolCall): AgentAction | null {
  const a = tc.args ?? {}
  const thought = typeof a.thought === 'string' ? a.thought : undefined
  switch (tc.name) {
    case 'click': { const ref = asNum(a.ref); return ref == null ? null : { action: 'click', ref, thought } }
    case 'type_text': { const ref = asNum(a.ref); return ref == null ? null : { action: 'type', ref, text: String(a.text ?? ''), submit: !!a.submit, thought } }
    case 'navigate': return { action: 'navigate', url: String(a.url ?? ''), thought }
    case 'open_tab': return { action: 'open_tab', url: String(a.url ?? ''), thought }
    case 'switch_tab': { const i = asNum(a.index); return i == null ? null : { action: 'switch_tab', index: i, thought } }
    case 'close_tab': { const i = asNum(a.index); return i == null ? null : { action: 'close_tab', index: i, thought } }
    case 'scroll': return { action: 'scroll', direction: a.direction === 'up' ? 'up' : 'down', thought }
    case 'upload_file': return { action: 'upload_file', name: typeof a.name === 'string' ? a.name : undefined, thought }
    case 'read': return { action: 'read', thought }
    case 'wait': return { action: 'wait', thought }
    case 'wait_for': return { action: 'wait_for', selector: typeof a.selector === 'string' ? a.selector : undefined, text: typeof a.text === 'string' ? a.text : undefined, timeout: asNum(a.timeout), thought }
    case 'key': return { action: 'key', key: String(a.key ?? ''), ref: asNum(a.ref), thought }
    case 'hover': { const ref = asNum(a.ref); return ref == null ? null : { action: 'hover', ref, thought } }
    case 'drag': return { action: 'drag', ref: asNum(a.ref), xPct: asNum(a.xPct), yPct: asNum(a.yPct), toRef: asNum(a.toRef), toXPct: asNum(a.toXPct), toYPct: asNum(a.toYPct), thought }
    case 'download': return { action: 'download', ref: asNum(a.ref), url: typeof a.url === 'string' ? a.url : undefined, thought }
    case 'run_js': return { action: 'run_js', code: String(a.code ?? ''), thought }
    case 'autofill': return { action: 'autofill', thought }
    case 'remember': return { action: 'remember', text: String(a.text ?? ''), thought }
    case 'extract': return {
      action: 'extract',
      rowSelector: typeof a.rowSelector === 'string' ? a.rowSelector : undefined,
      fields: (a.fields && typeof a.fields === 'object' && !Array.isArray(a.fields)) ? a.fields as Record<string, string> : undefined,
      rows: Array.isArray(a.rows) ? a.rows as Array<Record<string, unknown>> : undefined,
      thought,
    }
    case 'note': return { action: 'note', text: String(a.text ?? ''), thought }
    case 'report': return { action: 'report', title: String(a.title ?? ''), markdown: typeof a.markdown === 'string' ? a.markdown : '', thought }
    case 'done': return { action: 'done', message: String(a.message ?? '작업을 완료했습니다.'), thought }
    case 'ask': return { action: 'ask', message: String(a.message ?? '추가 정보가 필요합니다.'), thought }
    case 'click_at': { const x = asNum(a.xPct); const y = asNum(a.yPct); return (x == null || y == null) ? null : { action: 'click_at', xPct: x, yPct: y, thought } }
    default: return null
  }
}

function agentSystemPrompt(task: string): string {
  return [
    '당신은 웹 브라우저를 직접 조작하는 자율 에이전트입니다. 사용자의 작업을 완료하기 위해 현재 탭 페이지를 관찰하고, 한 번에 정확히 하나의 행동을 JSON 으로 출력합니다.',
    '',
    '매 단계마다 [현재 페이지] 정보와 [조작 가능한 요소] 목록([번호] role "이름")이 주어집니다.',
    '당신은 반드시 아래 형식의 JSON 객체 "하나만" 출력합니다. 설명·인사·코드펜스 없이 JSON 만.',
    '',
    '{"thought":"지금 무엇을 왜 하는지 한국어 한 문장","action":"click|type|navigate|scroll|read|wait|done|ask", ...필드}',
    '',
    '행동별 필드:',
    '- 클릭: {"action":"click","ref":<번호>}',
    '- 입력: {"action":"type","ref":<번호>,"text":"입력값","submit":true|false}  (submit=true 면 Enter 로 제출)',
    '- 이동: {"action":"navigate","url":"https://..."}  (현재 탭에서 이동)',
    '- 새 탭: {"action":"open_tab","url":"https://..."}  (새 탭을 열고 그 탭으로 작업 계속)',
    '- 탭 전환: {"action":"switch_tab","index":<[열린 탭] 번호>}',
    '- 탭 닫기: {"action":"close_tab","index":<[열린 탭] 번호>}  (지금 조작 중인 탭 ▶ 은 닫을 수 없음)',
    '- 스크롤: {"action":"scroll","direction":"down|up"}',
    '- 대기: {"action":"wait_for","selector":".result"} 또는 {"action":"wait_for","text":"완료","timeout":8000}  (요소·텍스트가 나타날 때까지 — 로딩·AJAX·SPA)',
    '- 키 입력: {"action":"key","key":"Enter"}  (Enter·Tab·Escape·방향키·"Control+a" 등 실제 키. ref 를 주면 그 요소에 포커스 후)',
    '- 호버: {"action":"hover","ref":<번호>}  (마우스를 올려야 뜨는 메뉴)',
    '- 드래그: {"action":"drag","ref":<시작번호>,"toRef":<끝번호>}  (슬라이더·정렬·캔버스. 좌표로는 xPct,yPct → toXPct,toYPct)',
    '- 다운로드: {"action":"download","ref":<링크번호>} 또는 {"action":"download","url":"https://..."}',
    '- JS 실행: {"action":"run_js","code":"return document.title"}  (페이지에서 코드 실행하고 결과 받기 — 추출·조작 만능)',
    '- 내 정보 자동 채우기: {"action":"autofill"}  (저장된 프로필로 가입·주문·신청 폼을 한 번에 채움. 값은 안전 저장소에서 오며 당신에게 노출되지 않음)',
    '- 파일 업로드: {"action":"upload_file","name":"cat.jpg"}  (사진/파일 첨부. "컴퓨터에서 선택" 버튼은 누르지 말고 이걸 쓰세요. name 은 [자료 폴더] 의 파일 경로 — 하위 폴더면 "photos/cat.jpg" 처럼. 모르면 생략하면 사용자가 고름)',
    '- 다시 관찰: {"action":"read"}',
    '- 기억: {"action":"remember","text":"다음에도 쓸 사실을 저장(사용자 이름·선호·자주 쓰는 값 등)"}',
    '- 데이터 추출: {"action":"extract","rowSelector":".product","fields":{"상품명":".title","가격":".price","링크":"a@href"}}  (반복 항목을 화면 밖 것까지 한 번에 수집 — 권장·완전). 선택자를 못 쓰면 {"action":"extract","rows":[{"상품명":"...","가격":"..."}]} 로 직접. 여러 페이지면 각 페이지에서 extract 하면 누적되고, 다 모으면 done 하세요.',
    '- 노트 기록: {"action":"note","text":"이 페이지에서 파악한 내용(마크다운)"}  (보고서 재료 — 페이지마다 기록하면 누적됨)',
    '- 보고서 완성: {"action":"report","title":"보고서 제목","markdown":"## 개요\\n- 핵심 결론"}  (누적한 노트가 본문으로 자동 합쳐지며 작업이 끝남)',
    '- 완료: {"action":"done","message":"사용자에게 보고할 최종 결과(한국어)"}',
    '- 질문: {"action":"ask","message":"사용자에게 물어볼 것(모르는 정보가 필요할 때)"}',
    '',
    '규칙:',
    '- ref 는 반드시 이번 관찰에 나온 [번호] 중 하나. 없는 번호를 지어내지 마세요.',
    '- 각 단계에 [열린 탭] 목록(▶ 는 지금 조작 중인 탭)이 주어집니다. 다른 탭이 필요하면 switch_tab, 새 사이트가 필요하면 open_tab 으로 여러 탭을 오갈 수 있습니다.',
    '- 목표를 이미 이뤘으면 곧바로 done. 같은 행동을 반복하지 마세요.',
    '- 결제·구매·주문·삭제·전송·게시처럼 되돌리기 어려운 행동은 사용자 확인을 거칩니다.',
    '- 비밀번호 등 당신이 모르는 정보가 필요하면 ask 로 물으세요.',
    '- 여러 입력을 연속으로 할 때는 JSON 배열 `[{...},{...}]` 로 여러 동작을 한 번에 반환해도 됩니다(예: 입력창 여러 개를 채우고 마지막에 클릭). 페이지가 바뀌는 동작(클릭·이동·제출)은 배열의 맨 마지막 하나로만. 그 외에는 객체 하나만 출력합니다.',
    '',
    '# 사용자가 지시한 작업',
    task,
  ].join('\n') + (getSetting('ai').memoryEnabled ? memoryBlock(1500) : '') + agentFilesBlock()
}

function formatObservation(obs: PageObservation): string {
  const els = obs.elements.map((e) => {
    const v = e.value ? ` value="${e.value}"` : ''
    return `[${e.ref}] ${e.type} "${e.name}"${v}`
  }).join('\n')
  return [
    '[현재 페이지]',
    `URL: ${obs.url}`,
    `제목: ${obs.title}`,
    `스크롤: ${obs.scroll.y}/${obs.scroll.maxY}`,
    '',
    '[본문]',
    '"""',
    obs.text + (obs.truncated ? '\n…(생략)' : ''),
    '"""',
    ...(obs.listHint ? [
      '',
      `[반복 구조 감지] rowSelector 후보: "${obs.listHint.rowSelector}" (${obs.listHint.count}개). 데이터 수집(extract)에 이 선택자를 rowSelector 로 쓰세요.`,
      ...(obs.listHint.fields && obs.listHint.fields.length
        ? ['각 항목 안 필드 후보(하위 선택자 → 예시값): ' + obs.listHint.fields.map((f) => `${f.sel}${f.attr ? '@' + f.attr : ''}="${f.sample}"`).join(' · ')]
        : []),
    ] : []),
    '',
    '[조작 가능한 요소]',
    els || '(없음)',
  ].join('\n')
}

function extractJson(reply: string): AgentAction | null {
  let s = reply.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0, end = -1, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return null
  try {
    const obj = JSON.parse(s.slice(start, end + 1)) as AgentAction
    if (!obj || typeof obj.action !== 'string') return null
    return obj
  } catch { return null }
}

// 여러 동작을 한 번에 — JSON 배열 [{...},{...}] 또는 단일 객체 모두 허용(단일이면 길이 1 배열).
function extractActions(reply: string): AgentAction[] {
  const s = reply.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const arrStart = s.indexOf('[')
  const objStart = s.indexOf('{')
  if (arrStart >= 0 && (objStart < 0 || arrStart < objStart)) {
    let depth = 0, end = -1, inStr = false, esc = false
    for (let i = arrStart; i < s.length; i++) {
      const c = s[i]
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
      if (c === '"') inStr = true
      else if (c === '[') depth++
      else if (c === ']') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end >= 0) {
      try {
        const arr = JSON.parse(s.slice(arrStart, end + 1)) as unknown[]
        const acts = arr.filter((o): o is AgentAction => !!o && typeof (o as AgentAction).action === 'string')
        if (acts.length) return acts
      } catch { /* 단일 파싱으로 폴백 */ }
    }
  }
  const one = extractJson(s)
  return one ? [one] : []
}

// 행동의 지문(같은 동작 반복 감지용) — 종류+대상 요소+URL+입력값.
function actionSig(a: AgentAction): string {
  return `${a.action}|${a.ref ?? ''}|${(a.url ?? '').slice(0, 60)}|${(a.text ?? '').slice(0, 24)}|${a.xPct ?? ''},${a.yPct ?? ''}`
}

// LLM 호출 오류를 사용자가 바로 고칠 수 있는 안내로 변환(모델 미설치·연결 실패·인증 등).
function friendlyError(msg: string): string {
  const m = msg.toLowerCase()
  if (/\bmodel\b|not found|없는 모델|404/.test(m)) return `AI 모델을 찾을 수 없습니다 (${msg}). 설정 > AI 에서 설치된 모델 이름이 맞는지 확인하세요.`
  if (/econnrefused|fetch failed|network|connect|timeout|시간 초과/.test(m)) return `AI 서버에 연결하지 못했습니다 (${msg}). 로컬 모델(Ollama) 실행 여부나 인터넷 연결을 확인하세요.`
  if (/api key|unauthorized|401|403|인증/.test(m)) return `AI 인증에 실패했습니다 (${msg}). 설정 > AI 에서 키 또는 로그인 상태를 확인하세요.`
  return `AI 호출 중 오류: ${msg}`
}

function describeAction(action: AgentAction, obs: PageObservation): string {
  const el = obs.elements.find((e) => e.ref === action.ref)
  const name = el ? `"${el.name || el.type}"` : `[${action.ref}]`
  switch (action.action) {
    case 'click': return `클릭 ${name}`
    case 'click_at': return `화면 클릭 ${Math.round(action.xPct ?? 50)}%,${Math.round(action.yPct ?? 50)}%`
    case 'type': return `입력 "${(action.text ?? '').slice(0, 40)}" → ${name}${action.submit ? ' (제출)' : ''}`
    case 'navigate': return `이동 ${action.url ?? ''}`
    case 'open_tab': return `새 탭 열기 ${action.url ?? ''}`
    case 'switch_tab': return `탭 전환 #${action.index ?? '?'}`
    case 'close_tab': return `탭 닫기 #${action.index ?? '?'}`
    case 'scroll': return `스크롤 ${action.direction === 'up' ? '위' : '아래'}`
    case 'note': return `노트 기록 (${(action.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 30)}…)`
    case 'report': return `보고서 완성 "${action.title ?? ''}"`
    default: return action.action
  }
}

// 보고서 파일명용 타임스탬프(YYYYMMDD-HHmm).
function reportStamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

// 누적한 페이지별 노트를 결정적으로 하나의 마크다운 보고서로 조립(LLM 재호출 없음).
function assembleReport(title: string, overview: string, notes: Array<{ url: string; title: string; md: string }>, task: string): string {
  const lines: string[] = [`# ${title}`, '']
  const focus = task.replace(/\s+/g, ' ').trim().slice(0, 160)
  if (focus) lines.push(`> ${focus}`, '')
  lines.push(`> 생성: ${new Date().toLocaleString('ko-KR')} · ezBrowser AI 에이전트`, '')
  if (overview) lines.push('## 개요', '', overview, '')
  for (const n of notes) lines.push(`## ${n.title || n.url}`, '', `<${n.url}>`, '', n.md, '')
  const urls = [...new Set(notes.map((n) => n.url))]
  if (urls.length) lines.push('---', '', '### 살펴본 페이지', ...urls.map((u) => `- <${u}>`))
  return lines.join('\n')
}

interface AgentTab { id: string; title: string; url: string }

function formatTabs(tabs: AgentTab[], currentId: string): string {
  if (tabs.length <= 1) return ''
  const lines = tabs.map((t, i) => `[탭${i}] ${t.id === currentId ? '▶ ' : ''}${(t.title || t.url || '').slice(0, 50)}`).join('\n')
  return '[열린 탭]\n' + lines + '\n\n'
}

function waitTabLoad(tabId: string): Promise<void> {
  return new Promise((resolve) => {
    const wc = getWebContentsByTabId(tabId)
    if (!wc || !wc.isLoading()) { resolve(); return }
    let done = false
    const fin = (): void => { if (!done) { done = true; resolve() } }
    wc.once('did-finish-load', fin)
    wc.once('did-fail-load', fin)
    setTimeout(fin, 15000)
  })
}

function isSensitive(action: AgentAction, obs: PageObservation): boolean {
  if (action.action === 'scroll' || action.action === 'read' || action.action === 'wait') return false
  if (action.action === 'navigate') return SENSITIVE_URL.test(action.url ?? '')
  const el = obs.elements.find((e) => e.ref === action.ref)
  const label = `${el?.name ?? ''} ${el?.type ?? ''}`
  if (el && (el.type === 'submit' || SENSITIVE.test(label))) return true
  if (action.action === 'type' && action.submit) return true
  return false
}

// run_js·key·drag·download 등 개별 핸들러는 아래 민감 게이트(click/type/navigate 용) 앞에서 continue 하므로,
// 되돌릴 수 없는 위험(임의 클릭·폼 제출)을 담은 경우 그 앞에서 별도로 확인을 받는다.
function earlyGateSensitive(action: AgentAction, obs: PageObservation): boolean {
  if (action.action === 'run_js') return SENSITIVE.test(action.code ?? '')
  if (action.action === 'key') {
    const k = (action.key ?? '').toLowerCase()
    const submitish = k === 'enter' || k === 'return' || k === 'numpadenter'
    if (!submitish) return false
    const el = obs.elements.find((e) => e.ref === action.ref)
    const label = `${el?.name ?? ''} ${el?.type ?? ''}`
    return !!el && (el.type === 'submit' || SENSITIVE.test(label))
  }
  return false
}

async function resolveReq(system: string, messages: AiMessage[]): Promise<AiRequest> {
  const s = getSetting('ai')
  const provider = s.provider
  const model = provider === 'anthropic' ? s.anthropicModel
    : provider === 'openai' ? s.openaiModel
      : provider === 'google' ? s.googleModel
        : provider === 'claude-code' ? s.claudeCodeModel
          : provider === 'codex' ? s.codexModel
            : provider === 'gemini-cli' ? s.geminiCliModel
              : s.ollamaModel
  let apiKey: string | undefined
  let baseUrl: string | undefined
  if (provider === 'ollama') baseUrl = s.ollamaUrl
  else if (isCliProvider(provider)) { const k = cliPathSettingKey(provider); baseUrl = k ? s[k] : '' }
  else {
    const key = await getAiKey(provider)
    if (!key) throw new Error(`${provider} API 키가 설정되지 않았습니다. 설정 > AI 에서 입력하세요.`)
    apiKey = key
  }
  return { provider, model, system, messages, apiKey, baseUrl, maxTokens: Math.max(512, s.maxTokens) }
}

function navigateAndWait(wc: Electron.WebContents, url: string): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const fin = (): void => { if (!done) { done = true; resolve() } }
    wc.once('did-finish-load', fin)
    wc.once('did-fail-load', fin)
    // loadURL 은 리다이렉트/실패 시 promise reject — void 로는 삼켜지지 않아 unhandledRejection 이 된다.
    try { wc.loadURL(url).catch(() => fin()) } catch { fin() }
    setTimeout(fin, 15000)
  })
}

// 현재 탭이 로딩 중이면 로드 완료(또는 실패/정지)까지 기다린다 — 바운드 타임아웃으로 무한 대기 방지.
function waitLoadFinish(wc: Electron.WebContents, timeout = 8000): Promise<void> {
  return new Promise((resolve) => {
    if (!wc.isLoading()) { resolve(); return }
    let done = false
    const fin = (): void => { if (!done) { done = true; resolve() } }
    wc.once('did-finish-load', fin)
    wc.once('did-fail-load', fin)
    wc.once('did-stop-loading', fin)
    setTimeout(fin, timeout)
  })
}

// 행동 후 페이지 안정화 — 고정 900ms 대신 상황에 맞춰: 클릭/제출이 내비게이션을 유발하면
// 로드 완료를 기다리고(더 정확하고 대개 더 빠름), 단순 DOM 변경이면 짧게만 대기한다.
async function settleAfterAction(wc: Electron.WebContents, action: AgentAction): Promise<void> {
  if (action.action === 'type' && !action.submit) { await sleep(150); return }
  await sleep(120) // 내비게이션이 시작될 여지를 잠깐 준다
  try { if (wc.isLoading()) { await waitLoadFinish(wc); return } } catch { /* ignore */ }
  await sleep(300) // 내비게이션이 없으면 DOM 갱신 반영을 위한 짧은 대기
}

// 업로드할 파일을 사용자가 직접 고른다(에이전트가 임의 경로를 추측하지 않음 — 안전 + 사용자 통제).
async function pickFilesForUpload(): Promise<string[]> {
  const res = await dialog.showOpenDialog({
    title: '업로드할 파일 선택',
    properties: ['openFile'],
    filters: [
      { name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
  })
  return res.canceled ? [] : res.filePaths
}

function waitConfirm(reqId: string): Promise<boolean> {
  return new Promise((resolve) => { pendingConfirm.set(reqId, resolve) })
}

function waitAsk(reqId: string): Promise<string | null> {
  return new Promise((resolve) => { pendingAsk.set(reqId, resolve) })
}

// 관찰이 커서 이력이 폭증하지 않도록 최근 메시지만 유지(작업 지시는 system 에 있으므로 안전).
function trimHistory(history: AiMessage[]): void {
  const MAX = 10
  if (history.length > MAX) history.splice(0, history.length - MAX)
}

export interface AgentTaskParams { reqId: string; tabId?: string; task: string; readOnly?: boolean }

// 읽기 전용(사이트 분석 보고서 등) 에서 차단하는 "페이지를 바꾸는" 동작 — 열람·이동·note/report 만 허용.
const READONLY_BLOCKED = new Set(['type', 'run_js', 'upload_file', 'autofill', 'drag', 'download', 'key'])

export async function runAgentTask(params: AgentTaskParams, emit: Emit): Promise<void> {
  const { reqId, tabId, task } = params
  const readOnly = !!params.readOnly
  cancelledSet.delete(reqId)
  const startWc = tabId ? getWebContentsByTabId(tabId) : null
  if (!startWc || !tabId) { emit({ type: 'error', message: '활성 탭을 찾을 수 없습니다.' }); return }
  if (!/^https?:/i.test(startWc.getURL())) {
    emit({ type: 'error', message: '웹 페이지(http/https)에서만 에이전트를 실행할 수 있습니다.' })
    return
  }
  // 여러 탭을 넘나들 수 있도록 조작 대상 탭을 가변으로 둔다(open_tab/switch_tab 이 바꾼다).
  const windowId = findTabIdByWebContentsId(startWc.id)?.windowId ?? null
  let currentTabId = tabId

  // 판단 경로 결정: 네이티브 tool-use 지원 + 설정 on 이면 구조화 함수 호출, 아니면 JSON 프로토콜.
  const st = getSetting('ai')
  const provider = st.provider
  const model = provider === 'anthropic' ? st.anthropicModel
    : provider === 'openai' ? st.openaiModel
      : provider === 'google' ? st.googleModel
        : provider === 'claude-code' ? st.claudeCodeModel
          : provider === 'codex' ? st.codexModel
            : provider === 'gemini-cli' ? st.geminiCliModel
              : st.ollamaModel
  const useTools = (st.nativeToolUse ?? 'auto') !== 'off' && supportsNativeTools(provider, model)
  // 화면 인식 — 비전 지원 제공자/모델일 때. 'always'=매 단계 캡처, 'auto'=스마트(첫 단계·화면 변화·막힘 때만
  // 캡처해 구독 한도·시간 절약), 'off'=미사용.
  const visionMode = (st.agentVision ?? 'auto') as 'auto' | 'always' | 'off'
  const useVision = visionMode !== 'off' && supportsVision(provider, model)
  // 비전이 켜져 있으면 좌표 클릭 도구를 추가로 제공(요소 목록 밖 대상도 화면을 보고 클릭).
  const tools = useVision ? [...AGENT_TOOLS, CLICK_AT_TOOL] : AGENT_TOOLS
  // 창 단위 세션 맥락(이전 지시·결과)을 프롬프트에 이어붙인다 → 연속 대화처럼 동작.
  const sessionKey = windowId ?? tabId
  const priorTurns = agentSessions.get(sessionKey)
  const system = (useTools ? agentToolSystemPrompt(task) : agentSystemPrompt(task)) + priorContextBlock(priorTurns)
    + (useVision ? '\n\n# 화면 인식\n각 단계에 현재 화면의 스크린샷이 함께 제공됩니다. [조작 가능한 요소] 목록과 더불어 화면을 눈으로 보고 판단하세요(시각적 위치·색·이미지·레이아웃 등). ref 는 반드시 요소 목록의 번호를 사용합니다.'
      + '\n화면에는 보이지만 [조작 가능한 요소] 목록에 없는 대상(캔버스·커스텀 위젯 등)은 좌표 클릭을 쓰세요: '
      + (useTools ? 'click_at 도구에 xPct,yPct(화면 가로/세로의 0~100 %)를 지정.' : 'JSON `{"action":"click_at","xPct":<0~100>,"yPct":<0~100>}` 로 화면 가로/세로 백분율 위치를 클릭.')
      + ' 목록에 있으면 ref 클릭을 우선하세요.' : '')
  // 이 실행이 끝나면 세션에 남길 결과(done/최대단계 도달만 기록 — 오류·중단은 맥락 오염 방지 위해 제외).
  let recordOutcome: string | null = null
  // 복잡한 작업(로그인→업로드→게시 등)이 중간에 끊기지 않도록 단계 수를 설정에서(기본 25) 받는다.
  const maxSteps = Math.max(6, Math.min(80, st.agentMaxSteps || DEFAULT_MAX_STEPS))
  const recentSigs: string[] = [] // 최근 행동 지문(막힘 감지)
  let noParseStreak = 0           // 응답을 연속으로 못 읽은 횟수
  let failStreak = 0              // 행동이 연속으로 실패한 횟수
  let needVision = true           // 이번(첫) 단계에 스마트 비전 캡처가 필요한가(화면 변화·막힘 시 재설정)
  const collected: Array<Record<string, string>> = [] // extract 로 모은 데이터(여러 페이지 누적)
  const seenRows = new Set<string>()                   // 중복 행 제거(같은 페이지 재추출 시 이중 집계 방지)
  const reportNotes: Array<{ url: string; title: string; md: string }> = [] // note 로 모은 보고서 재료(페이지별)
  const seenNoteUrls = new Set<string>()               // 노트를 기록한 페이지(재방문 억제·부록용)
  let reportNudged = false                             // 빈 report 를 한 번 되돌렸는지(무한 루프 방지)
  const history: AiMessage[] = []
  // 직전 행동 결과·거부·사용자 답변을 다음 관찰 앞에 붙인다. history 는 오직 user/assistant 쌍으로만
  // 늘어나므로 엄격한 교대(alternation)가 항상 보장된다 — Anthropic/Gemini 는 연속 같은 role 을 거부한다.
  let pendingPrefix = ''
  emit({ type: 'start', task })

  try {
    for (let step = 1; step <= maxSteps; step++) {
      if (cancelledSet.has(reqId)) { emit({ type: 'cancelled' }); return }

      const wc = getWebContentsByTabId(currentTabId)
      if (!wc) { emit({ type: 'error', message: '현재 탭을 찾을 수 없습니다(닫혔을 수 있음).' }); return }

      // 스마트 비전: 'always' 면 매 단계, 'auto' 면 화면이 바뀌었거나 막혔을 때만 캡처(한도·시간 절약).
      const captureThisStep = useVision && (visionMode === 'always' || needVision)
      needVision = false
      // 관찰(DOM)과 화면 캡처는 서로 독립적 → 병렬로 돌려 단계당 지연을 줄인다(둘 중 긴 쪽만큼만 소요).
      let [obs, shot] = await Promise.all([
        observePage(wc),
        captureThisStep ? captureScreenshot(wc) : Promise.resolve<string | undefined>(undefined),
      ])
      // 새 탭 전환 직후 아직 about:blank/로딩 중이면 관찰이 null 이 되므로 한 번 재시도한다.
      if (!obs) {
        await sleep(600); if (cancelledSet.has(reqId)) { emit({ type: 'cancelled' }); return }
        obs = await observePage(wc)
        if (obs && captureThisStep && !shot) shot = await captureScreenshot(wc) // 첫 캡처가 blank 였으면 다시
      }
      if (!obs) { emit({ type: 'error', message: '페이지를 관찰하지 못했습니다.' }); return }
      emit({ type: 'observe', step, url: obs.url, title: obs.title, elements: obs.elements.length, vision: !!shot })

      const tabList: AgentTab[] = windowId ? listTabs(windowId).map((t) => ({ id: t.id, title: t.title, url: t.url })) : []
      const userContent = (pendingPrefix ? pendingPrefix + '\n\n' : '') + formatTabs(tabList, currentTabId) + formatObservation(obs)
      pendingPrefix = ''
      const req = await resolveReq(system, [...history, { role: 'user', content: userContent }])
      if (shot) req.image = shot

      let action: AgentAction | null = null
      let actions: AgentAction[] = []  // 한 응답에 여러 동작(선행 입력 연쇄) 가능
      let assistantText = ''
      if (useTools) {
        // 네이티브 tool-use — 구조화된 함수 호출로 행동 선택
        const call = chatWithTools(req, tools)
        activeCall.set(reqId, call.cancel)
        let res: { toolCalls: ToolCall[]; text: string }
        try { res = await call.promise } catch (err) {
          if (cancelledSet.has(reqId)) { emit({ type: 'cancelled' }); return }
          emit({ type: 'error', message: friendlyError(err instanceof Error ? err.message : String(err)) }); return
        } finally { activeCall.delete(reqId) }
        if (cancelledSet.has(reqId)) { emit({ type: 'cancelled' }); return }
        assistantText = res.text || ''
        actions = res.toolCalls.map(toolCallToAction).filter((a): a is AgentAction => a !== null)
        if (!actions.length && assistantText) actions = extractActions(assistantText) // 도구 대신 텍스트로 답한 경우 폴백
      } else {
        // JSON 액션 프로토콜(폴백)
        const call = chatOnce(req)
        activeCall.set(reqId, call.cancel)
        let reply: string
        try { reply = await call.promise } catch (err) {
          if (cancelledSet.has(reqId)) { emit({ type: 'cancelled' }); return }
          emit({ type: 'error', message: friendlyError(err instanceof Error ? err.message : String(err)) }); return
        } finally { activeCall.delete(reqId) }
        if (cancelledSet.has(reqId)) { emit({ type: 'cancelled' }); return }
        assistantText = reply
        actions = extractActions(reply)
      }
      action = actions[0] ?? null

      history.push({ role: 'user', content: userContent })
      history.push({ role: 'assistant', content: assistantText || (action ? `(도구 호출: ${action.action})` : '(빈 응답)') })
      trimHistory(history)

      if (!action) {
        noParseStreak++
        if (noParseStreak >= NOPARSE_LIMIT) {
          recordOutcome = '모델이 올바른 행동 형식을 반복해서 지키지 못했습니다.'
          emit({ type: 'error', message: `AI 응답을 ${NOPARSE_LIMIT}회 연속 이해하지 못해 중단했습니다. 지시를 더 간단·구체적으로 하거나, 설정 > AI 에서 더 성능 좋은 제공자(예: Claude Code)로 바꿔 보세요.` })
          return
        }
        emit({ type: 'thought', thought: '(행동을 해석하지 못함 — 재시도)', raw: assistantText.slice(0, 160) })
        pendingPrefix = useTools
          ? '방금 도구를 호출하지 않았습니다. 반드시 제공된 도구 중 하나를 호출하세요(설명만 하지 말고).'
          : '방금 응답이 올바른 JSON 액션이 아니었습니다. 설명 없이 JSON 객체 하나만 출력하세요.'
        continue
      }
      noParseStreak = 0 // 정상 파싱되면 리셋

      // 여러 동작을 한 번에 — 선행 '입력(비제출 type)' 들을 먼저 실행해 LLM 호출을 줄인다(같은 화면·같은 ref 유지).
      // 입력은 요소 ref 배치를 바꾸지 않아 안전하게 연쇄된다. 페이지가 바뀌는 클릭·이동은 이 배치의 마지막 한 동작으로만.
      let mainIdx = 0
      let preFailed = false
      while (!readOnly && mainIdx < actions.length - 1) {
        const t = actions[mainIdx]
        if (!t || t.action !== 'type' || t.submit) break
        if (isSensitive(t, obs)) break // 민감 필드 입력은 게이트를 거치도록 단일 경로로 넘긴다
        const tl = describeAction(t, obs)
        emit({ type: 'thought', thought: t.thought ?? '', action: t.action })
        emit({ type: 'action', label: tl })
        const tr = await executeInPageAction(wc, t)
        emit({ type: 'result', ok: tr.ok, label: tl, detail: tr.detail })
        await settleAfterAction(wc, t)
        if (cancelledSet.has(reqId)) { emit({ type: 'cancelled' }); return }
        needVision = true
        if (!tr.ok) { preFailed = true; pendingPrefix = `입력 실패 — ${tr.detail}. 화면을 다시 확인합니다.`; break }
        mainIdx++
      }
      if (preFailed) continue
      const mainAction = actions[mainIdx]
      if (mainAction) action = mainAction

      emit({ type: 'thought', thought: action.thought ?? '', action: action.action })

      // 읽기 전용(보고서 등): 페이지를 바꾸는 동작은 하드 블록 — 열람·이동·note/report 만 허용.
      if (readOnly && READONLY_BLOCKED.has(action.action)) {
        emit({ type: 'result', ok: false, label: describeAction(action, obs), detail: '읽기 전용 모드에서는 허용되지 않는 동작' })
        pendingPrefix = '이 작업은 읽기 전용입니다. 입력·실행·업로드 없이 페이지 열람(이동·클릭·스크롤)과 note/report 만 사용하세요.'
        continue
      }

      // 개별 핸들러(run_js/key)가 게이트 앞에서 continue 하므로, 위험한 경우 먼저 확인을 받는다.
      if (earlyGateSensitive(action, obs)) {
        const snippet = (action.code ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
        const gateLabel = action.action === 'run_js' ? `JS 실행(민감): ${snippet}${snippet.length >= 60 ? '…' : ''}` : `키: ${action.key ?? ''}`
        const gateP = waitConfirm(reqId)
        emit({ type: 'confirm', label: gateLabel })
        const okGate = await gateP
        if (cancelledSet.has(reqId)) { emit({ type: 'cancelled' }); return }
        if (!okGate) {
          emit({ type: 'result', ok: false, label: gateLabel, detail: '사용자가 거부했습니다.' })
          pendingPrefix = '사용자가 그 행동을 거부했습니다. 다른 방법을 찾거나 done/ask 하세요.'
          continue
        }
      }

      if (action.action === 'done') {
        recordOutcome = action.message ?? '작업을 완료했습니다.'
        const evidence = await captureScreenshot(wc) // 완료 증거 — 최종 화면 스크린샷을 함께 보여준다
        emit({ type: 'done', message: recordOutcome, ...(evidence ? { shot: evidence } : {}) })
        return
      }
      if (action.action === 'ask') {
        const askP = waitAsk(reqId) // 대기자를 emit 전에 등록 — 배치(runAgentBatch)가 emit 콜백에서 동기 응답해도 유실 안 됨
        emit({ type: 'ask', message: action.message ?? '추가 정보가 필요합니다.' })
        const answer = await askP
        if (cancelledSet.has(reqId) || answer === null) { emit({ type: 'cancelled' }); return }
        emit({ type: 'answer', text: answer })
        pendingPrefix = `사용자 답변: ${answer}`
        needVision = true
        continue
      }
      if (action.action === 'read') { continue }
      if (action.action === 'wait') { await sleep(1200); continue }

      if (action.action === 'remember') {
        const text = (action.text ?? '').trim()
        if (text) { await appendMemory(text); emit({ type: 'result', ok: true, label: '기억함', detail: text.slice(0, 60) }) }
        pendingPrefix = text ? `기억에 저장했습니다: ${text}` : '저장할 내용이 비어 있습니다.'
        continue
      }

      if (action.action === 'note') {
        const md = (action.text ?? '').trim().slice(0, 4000)
        if (md && reportNotes.length < 40) {
          reportNotes.push({ url: obs.url, title: obs.title, md })
          seenNoteUrls.add(obs.url)
          emit({ type: 'result', ok: true, label: '노트 기록', detail: `${obs.title || obs.url} (누적 ${reportNotes.length})` })
          pendingPrefix = `노트 기록됨(누적 ${reportNotes.length}개). 더 볼 페이지가 있으면 이동해 계속하고, 다 봤으면 report 로 보고서를 완성하세요. 이미 기록한 페이지: ${[...seenNoteUrls].slice(-6).join(', ')}`
        } else {
          emit({ type: 'result', ok: false, label: '노트 기록', detail: md ? '노트 상한(40개) 도달' : '내용이 비어 있음' })
          pendingPrefix = md ? '노트가 상한에 달했습니다. 이제 report 로 보고서를 완성하세요.' : '노트 내용이 비었습니다. 화면에서 파악한 내용을 구체적으로 적으세요.'
        }
        continue
      }

      if (action.action === 'report') {
        // 노트가 하나도 없으면(빈 보고서 방지) 한 번은 되돌려 note 를 유도한다.
        if (reportNotes.length === 0 && !(action.markdown ?? '').trim() && !reportNudged) {
          reportNudged = true
          emit({ type: 'result', ok: false, label: '보고서 완성', detail: '아직 기록한 노트가 없음' })
          pendingPrefix = '아직 note 로 기록한 페이지가 없습니다. 먼저 각 페이지를 살펴보고 note 로 내용을 기록한 뒤 report 하세요.'
          continue
        }
        const host = (() => { try { return new URL(obs.url).hostname } catch { return '사이트' } })()
        const title = (action.title ?? '').trim() || `${host} 분석 보고서`
        const md = assembleReport(title, (action.markdown ?? '').trim(), reportNotes, task)
        const saved = await writeDownloadMd(safeFileName(`보고서-${host}-${reportStamp()}`), md)
        recordOutcome = `보고서 작성 완료: ${title} (노트 ${reportNotes.length}개${saved.ok && saved.path ? `, ${path.basename(saved.path)} 저장` : ''})`
        emit({ type: 'report', title, markdown: md, notes: reportNotes.length, sources: [...seenNoteUrls], ...(saved.ok && saved.path ? { path: saved.path } : {}) })
        const evidence = await captureScreenshot(wc)
        emit({ type: 'done', message: recordOutcome, ...(evidence ? { shot: evidence } : {}) })
        return
      }

      if (action.action === 'extract') {
        // 데이터 수집(스크래핑) — 선택자로 페이지에서 완전 수집하거나, 에이전트가 읽은 rows 를 직접 받는다. 여러 페이지 누적.
        let rows: Array<Record<string, string>> = []
        if (Array.isArray(action.rows) && action.rows.length) {
          rows = action.rows
            .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r))
            .map((r) => {
              const o: Record<string, string> = {}
              for (const k of Object.keys(r)) o[String(k).slice(0, 60)] = String(r[k] ?? '').slice(0, 500)
              return o
            }).slice(0, 1000)
        } else if (action.rowSelector || action.fields) {
          const res = await extractFromPage(wc, { rowSelector: action.rowSelector, fields: action.fields })
          rows = res.rows
        }
        if (rows.length) {
          // 중복 제거 — 같은 페이지를 또 extract 해도 이중 집계되지 않고, 새 항목이 없으면 done 을 유도한다.
          const fresh: Array<Record<string, string>> = []
          for (const r of rows) {
            const key = JSON.stringify(r)
            if (!seenRows.has(key) && collected.length < 5000) { seenRows.add(key); collected.push(r); fresh.push(r) }
          }
          if (fresh.length) {
            emit({ type: 'extracted', rows: fresh, total: collected.length })
            emit({ type: 'result', ok: true, label: '데이터 추출', detail: `${fresh.length}건 신규 (누적 ${collected.length}건)` })
            pendingPrefix = `데이터 ${fresh.length}건 추출(누적 ${collected.length}건). 더 있으면 다음 페이지로 이동 후 다시 extract, 다 모았으면 done 으로 완료하세요.`
          } else {
            emit({ type: 'result', ok: true, label: '데이터 추출', detail: `신규 없음 (이미 ${collected.length}건 수집됨)` })
            pendingPrefix = `이미 수집한 데이터입니다(새 항목 없음, 누적 ${collected.length}건). 더 수집할 다음 페이지가 없으면 done 으로 완료하세요.`
          }
        } else {
          emit({ type: 'result', ok: false, label: '데이터 추출', detail: '추출 항목이 없음' })
          pendingPrefix = '추출 결과가 비었습니다. rowSelector/fields 선택자를 바꾸거나, 화면에서 읽은 데이터를 rows 로 직접 넘기세요.'
        }
        continue
      }

      if (action.action === 'wait_for') {
        const label = `대기: ${action.selector ? `요소 ${action.selector}` : action.text ? `"${action.text}"` : '조건'}`
        emit({ type: 'action', label })
        const r = await waitForOnPage(wc, { selector: action.selector, text: action.text, timeout: action.timeout })
        emit({ type: 'result', ok: r.ok, label, detail: r.detail })
        pendingPrefix = r.ok ? `대기 완료: ${r.detail}` : `대기 실패: ${r.detail}. 다른 방법을 시도하세요.`
        if (r.ok) needVision = true
        continue
      }
      if (action.action === 'run_js') {
        const code = action.code ?? ''
        emit({ type: 'action', label: 'JS 실행' })
        const r = await runPageJs(wc, code)
        emit({ type: 'result', ok: r.ok, label: 'JS 실행', detail: r.detail.slice(0, 120) })
        pendingPrefix = r.ok ? `JS 실행 결과: ${r.detail}` : `JS 실행 실패: ${r.detail}`
        needVision = true
        continue
      }
      if (action.action === 'hover') {
        const label = describeAction({ ...action, action: 'click' }, obs).replace('클릭', '호버')
        emit({ type: 'action', label })
        const r = await hoverElement(wc, action.ref ?? -1)
        await sleep(400) // 호버 메뉴가 뜰 시간
        emit({ type: 'result', ok: r.ok, label, detail: r.detail })
        pendingPrefix = r.ok ? `호버했습니다: ${r.detail}. 이제 나타난 항목을 확인하세요.` : `호버 실패: ${r.detail}`
        needVision = true
        continue
      }
      if (action.action === 'drag') {
        emit({ type: 'action', label: '드래그' })
        const r = await dragOnPage(wc, { ref: action.ref, xPct: action.xPct, yPct: action.yPct, toRef: action.toRef, toXPct: action.toXPct, toYPct: action.toYPct })
        await settleAfterAction(wc, action)
        emit({ type: 'result', ok: r.ok, label: '드래그', detail: r.detail })
        pendingPrefix = r.ok ? `드래그 완료: ${r.detail}` : `드래그 실패: ${r.detail}`
        needVision = true
        continue
      }
      if (action.action === 'key') {
        const label = `키: ${action.key ?? ''}`
        emit({ type: 'action', label })
        const r = await pressKey(wc, { key: action.key ?? '', ref: action.ref })
        await settleAfterAction(wc, action)
        emit({ type: 'result', ok: r.ok, label, detail: r.detail })
        pendingPrefix = r.ok ? `키 입력함: ${action.key}` : `키 입력 실패: ${r.detail}`
        needVision = true
        continue
      }
      if (action.action === 'download') {
        let url = (action.url ?? '').trim()
        if (!url && action.ref != null) url = (await resolveHref(wc, action.ref)) ?? ''
        if (!url || !/^https?:/i.test(url)) {
          emit({ type: 'result', ok: false, label: '다운로드', detail: '다운로드할 URL 을 찾지 못함(ref 의 링크 또는 url 필요)' })
          pendingPrefix = '다운로드에 실패했습니다. 링크 요소의 ref 나 http(s) url 을 지정하세요.'
          continue
        }
        emit({ type: 'action', label: `다운로드: ${url.slice(0, 60)}` })
        try { wc.downloadURL(url); emit({ type: 'result', ok: true, label: '다운로드', detail: url.slice(0, 80) }); pendingPrefix = `다운로드를 시작했습니다: ${url}` }
        catch (e) { emit({ type: 'result', ok: false, label: '다운로드', detail: String(e) }); pendingPrefix = `다운로드 실패: ${String(e)}` }
        continue
      }
      if (action.action === 'autofill') {
        emit({ type: 'action', label: '내 정보 자동 채우기' })
        if (!hasProfileData()) {
          emit({ type: 'result', ok: false, label: '자동 채우기', detail: '저장된 프로필이 없음(설정 > AI 에서 내 정보 입력)' })
          pendingPrefix = '자동 채우기할 프로필이 비어 있습니다. 필드를 직접 type 으로 채우거나 사용자에게 정보를 물으세요(ask).'
          continue
        }
        const r = await autofillPage(wc, getProfile()) // 값은 여기서 페이지로만 — LLM 미노출
        emit({ type: 'result', ok: r.ok && r.count > 0, label: '자동 채우기', detail: r.count > 0 ? `${r.count}개 필드 채움: ${r.fields.join(', ')}` : '채울 필드를 못 찾음' })
        pendingPrefix = r.count > 0
          ? `프로필로 ${r.count}개 필드를 채웠습니다(${r.fields.join(', ')}). 남은 빈 칸이 있으면 확인하고, 준비되면 제출하세요.`
          : '자동으로 채울 폼 필드를 찾지 못했습니다. 각 칸을 직접 확인해 채우세요.'
        needVision = true
        continue
      }

      if (action.action === 'upload_file') {
        // 지정 자료 폴더의 이름이 주어지면 그 파일을 바로 쓴다(자율). 폴더 밖·미존재면 거부(보안).
        const wanted = (action.name ?? '').trim()
        let picked: string[] = []
        let fromFolder = false
        if (wanted) {
          const resolved = resolveAgentFile(wanted)
          if (resolved) { picked = [resolved]; fromFolder = true }
          else {
            emit({ type: 'result', ok: false, label: '파일 업로드', detail: `자료 폴더에 '${wanted}' 없음` })
            const avail = listAgentFiles()
            pendingPrefix = avail.length
              ? `자료 폴더에 '${wanted}' 가 없습니다. 사용 가능: ${avail.join(', ')}. 정확한 이름으로 다시 upload_file 하거나, 이름 없이 호출해 사용자가 고르게 하세요.`
              : `자료 폴더가 설정돼 있지 않거나 비어 있습니다. 이름 없이 upload_file 하면 사용자가 창에서 고릅니다.`
            continue
          }
        } else {
          // 이름 미지정 → 사용자가 파일 창에서 직접 선택
          emit({ type: 'action', label: '파일 선택 — 사용자가 파일을 고릅니다' })
          picked = await pickFilesForUpload()
          if (cancelledSet.has(reqId)) { emit({ type: 'cancelled' }); return }
          if (!picked.length) {
            emit({ type: 'result', ok: false, label: '파일 업로드', detail: '사용자가 파일 선택을 취소함' })
            pendingPrefix = '사용자가 파일 선택을 취소했습니다. 다른 방법을 찾거나 ask/done 하세요.'
            continue
          }
        }
        const label = fromFolder ? `파일 업로드(자료 폴더): ${path.basename(picked[0] ?? '')}` : '파일 업로드'
        emit({ type: 'action', label })
        const r = await setFileInputFiles(wc, picked)
        emit({ type: 'result', ok: r.ok, label: '파일 업로드', detail: r.ok ? `첨부: ${picked.map((p) => path.basename(p)).join(', ')}` : r.detail })
        pendingPrefix = r.ok
          ? `파일을 첨부했습니다(${picked.length}개). 이제 캡션 작성·공유(게시) 등 다음 단계를 진행하세요.`
          : `파일 첨부 실패: ${r.detail}`
        continue
      }

      if (action.action === 'open_tab') {
        const url = action.url
        if (!windowId || !url || !/^https?:/i.test(url)) {
          emit({ type: 'result', ok: false, label: describeAction(action, obs), detail: '유효하지 않은 URL' })
          pendingPrefix = '새 탭 열기에 실패했습니다. 유효한 http(s) URL 이 필요합니다.'
          continue
        }
        emit({ type: 'action', label: describeAction(action, obs) })
        const nt = createTab({ windowId, url })
        currentTabId = nt.id
        await waitTabLoad(nt.id)
        emit({ type: 'result', ok: true, label: '새 탭', detail: url })
        pendingPrefix = `새 탭을 열고 이동했습니다: ${url}. 이제 그 탭을 조작합니다.`
        needVision = true
        continue
      }
      if (action.action === 'switch_tab') {
        const idx = action.index ?? -1
        const target = tabList[idx]
        if (!target) {
          emit({ type: 'result', ok: false, label: describeAction(action, obs), detail: `탭 #${idx} 없음` })
          pendingPrefix = `탭 #${idx} 이(가) 없습니다. [열린 탭] 목록의 번호를 확인하세요.`
          continue
        }
        emit({ type: 'action', label: describeAction(action, obs) })
        activateTab(target.id)
        currentTabId = target.id
        await sleep(300)
        emit({ type: 'result', ok: true, label: '탭 전환', detail: target.title || target.url })
        pendingPrefix = `탭을 전환했습니다: ${target.title || target.url}`
        needVision = true
        continue
      }
      if (action.action === 'close_tab') {
        const idx = action.index ?? -1
        const target = tabList[idx]
        if (!target) {
          emit({ type: 'result', ok: false, label: describeAction(action, obs), detail: `탭 #${idx} 없음` })
          pendingPrefix = `탭 #${idx} 이(가) 없습니다. [열린 탭] 번호를 확인하세요.`
          continue
        }
        if (target.id === currentTabId) {
          emit({ type: 'result', ok: false, label: describeAction(action, obs), detail: '현재 조작 중인 탭은 닫을 수 없음' })
          pendingPrefix = '지금 조작 중인 탭(▶)은 닫을 수 없습니다. 먼저 다른 탭으로 전환하거나 그대로 두세요.'
          continue
        }
        emit({ type: 'action', label: describeAction(action, obs) })
        closeTab(target.id)
        await sleep(300)
        emit({ type: 'result', ok: true, label: '탭 닫기', detail: target.title || target.url })
        pendingPrefix = `탭을 닫았습니다: ${target.title || target.url}`
        continue
      }

      // click_at 은 요소 목록에 없으므로 좌표 지점의 대상 라벨을 미리 조사(막힘·민감 판단·표시용).
      let clickAtLabel = ''
      if (action.action === 'click_at') clickAtLabel = await probeClickAtLabel(wc, action)
      const label = action.action === 'click_at'
        ? `화면 클릭 ${clickAtLabel ? '"' + clickAtLabel.slice(0, 30) + '"' : `${Math.round(action.xPct ?? 50)}%,${Math.round(action.yPct ?? 50)}%`}`
        : describeAction(action, obs)

      // 막힘 감지 — 같은 동작(클릭·입력·이동)을 반복하는데 진전이 없으면 멈추고 사용자에게 묻는다.
      if (action.action === 'click' || action.action === 'type' || action.action === 'navigate' || action.action === 'click_at') {
        const sig = actionSig(action)
        recentSigs.push(sig)
        if (recentSigs.length > 6) recentSigs.shift()
        if (recentSigs.filter((s) => s === sig).length >= STUCK_REPEAT) {
          const askP = waitAsk(reqId) // 대기자를 emit 전에 등록(배치 동기 응답 대비)
          emit({ type: 'ask', message: `같은 동작(${label})을 여러 번 반복했는데 진전이 없습니다. 어떻게 할까요? 다른 방법을 알려주시거나, 필요한 부분을 직접 하신 뒤 "계속" 이라고 해주세요.` })
          const answer = await askP
          if (cancelledSet.has(reqId) || answer === null) { emit({ type: 'cancelled' }); return }
          emit({ type: 'answer', text: answer })
          pendingPrefix = `사용자 안내: ${answer}. 같은 동작 반복을 멈추고 다른 접근을 시도하세요.`
          recentSigs.length = 0
          needVision = true
          continue
        }
      }

      // click_at 은 목록에 없어 라벨을 미리 알 수 없으므로, 좌표 지점 라벨로 민감 여부를 판단한다.
      const sensitive = action.action === 'click_at' ? SENSITIVE.test(clickAtLabel) : isSensitive(action, obs)
      if (sensitive) {
        const approvalP = waitConfirm(reqId) // 대기자를 emit 전에 등록(배치 동기 승인/거부 대비)
        emit({ type: 'confirm', label })
        const approved = await approvalP
        if (cancelledSet.has(reqId)) { emit({ type: 'cancelled' }); return }
        if (!approved) {
          emit({ type: 'result', ok: false, label, detail: '사용자가 거부했습니다.' })
          pendingPrefix = '사용자가 그 행동을 거부했습니다. 다른 방법을 찾거나 done/ask 하세요.'
          continue
        }
      }

      let result: { ok: boolean; detail: string }
      if (action.action === 'navigate') {
        if (!action.url || !/^https?:/i.test(action.url)) result = { ok: false, detail: '유효하지 않은 URL' }
        else { emit({ type: 'action', label }); await navigateAndWait(wc, action.url); result = { ok: true, detail: '이동함' } }
      } else {
        emit({ type: 'action', label })
        result = await executeInPageAction(wc, action)
        await settleAfterAction(wc, action)
      }

      emit({ type: 'result', ok: result.ok, label, detail: result.detail })
      // 화면이 바뀌는 동작 뒤에는 다음 관찰에서 스마트 비전을 다시 캡처한다(auto 모드).
      if (result.ok && (action.action === 'navigate' || action.action === 'click' || action.action === 'click_at' || action.action === 'scroll' || (action.action === 'type' && action.submit))) needVision = true
      // 실패가 연속되면 헛도는 대신 사용자에게 물어 방향을 받는다.
      if (result.ok) { failStreak = 0 } else {
        failStreak++
        needVision = true // 실패 시 화면을 다시 봐 원인 파악
        if (failStreak >= FAIL_LIMIT) {
          const askP = waitAsk(reqId) // 대기자를 emit 전에 등록(배치 동기 응답 대비)
          emit({ type: 'ask', message: `행동이 ${FAIL_LIMIT}회 연속 실패했습니다(마지막: ${result.detail}). 어떻게 할까요? 다른 방법을 알려주시거나, 막힌 부분을 직접 처리하신 뒤 "계속" 이라고 해주세요.` })
          const answer = await askP
          if (cancelledSet.has(reqId) || answer === null) { emit({ type: 'cancelled' }); return }
          emit({ type: 'answer', text: answer })
          pendingPrefix = `사용자 안내: ${answer}. 이전과 다른 방법을 시도하세요.`
          failStreak = 0
          continue
        }
      }
      pendingPrefix = `이전 행동 결과: ${result.ok ? '성공' : '실패'} — ${result.detail}`
    }
    recordOutcome = `${maxSteps}단계까지 진행했지만 작업을 마치지 못했습니다.`
    const wcEnd = getWebContentsByTabId(currentTabId)
    const evidence = wcEnd ? await captureScreenshot(wcEnd) : undefined
    // 보고서 작업이 report 없이 단계 소진 시, 모은 노트를 버리지 않고 부분 보고서로 저장·전달한다.
    if (reportNotes.length > 0) {
      const host = wcEnd ? (() => { try { return new URL(wcEnd.getURL()).hostname } catch { return '사이트' } })() : '사이트'
      const title = `${host} 분석 보고서 (부분)`
      const md = assembleReport(title, '', reportNotes, task)
      const saved = await writeDownloadMd(safeFileName(`보고서-${host}-${reportStamp()}`), md)
      emit({ type: 'report', title, markdown: md, notes: reportNotes.length, sources: [...seenNoteUrls], ...(saved.ok && saved.path ? { path: saved.path } : {}) })
      emit({ type: 'done', message: `${maxSteps}단계에서 멈췄지만 그때까지 살펴본 ${reportNotes.length}개 페이지로 부분 보고서를 작성했습니다.${saved.ok && saved.path ? ` (${path.basename(saved.path)} 저장)` : ''}`, ...(evidence ? { shot: evidence } : {}) })
    } else {
      emit({ type: 'done', message: `${maxSteps}단계까지 시도했지만 완료하지 못했습니다. 더 구체적으로 지시하시거나, 막힌 부분을 직접 처리하신 뒤 이어서 지시해 주세요. (설정 > AI 에서 최대 단계 수를 늘릴 수도 있습니다.)`, ...(evidence ? { shot: evidence } : {}) })
    }
  } catch (err) {
    emit({ type: 'error', message: friendlyError(err instanceof Error ? err.message : String(err)) })
  } finally {
    activeCall.delete(reqId)
    pendingConfirm.delete(reqId)
    pendingAsk.delete(reqId)
    cancelledSet.delete(reqId)
    // 성공적으로 끝난 턴만 세션 맥락에 남긴다(다음 지시가 이어받도록).
    if (recordOutcome !== null) {
      const turns = agentSessions.get(sessionKey) ?? []
      turns.push({ task, outcome: recordOutcome.slice(0, 300) })
      while (turns.length > MAX_SESSION_TURNS) turns.shift()
      agentSessions.set(sessionKey, turns)
    }
  }
}

// ===== 대량·반복 처리 — 데이터(CSV/목록) 각 행마다 같은 작업을 자동 반복하고 결과를 누적한다 =====

const MAX_BATCH_ROWS = 100
interface BatchState { cancelled: boolean; current: string | null }
const batchState = new Map<string, BatchState>()

export function cancelAgentBatch(reqId: string): void {
  const b = batchState.get(reqId)
  if (b) { b.cancelled = true; if (b.current) cancelAgentTask(b.current) }
}

// 작업 지시의 {열} 을 행 값으로 치환. 치환된 게 없으면 행 데이터를 뒤에 붙인다.
function fillTemplate(task: string, row: Record<string, string>): string {
  let used = false
  const out = task.replace(/\{([^}]+)\}/g, (m, k: string) => {
    const key = String(k).trim()
    const hit = key in row ? key : Object.keys(row).find((kk) => kk.toLowerCase() === key.toLowerCase())
    if (hit) { used = true; return row[hit] ?? '' }
    return m
  })
  if (used) return out
  const pairs = Object.entries(row).map(([k, v]) => `${k}=${v}`).join(', ')
  return task + `\n\n[이번 데이터 행] ${pairs}`
}

export interface AgentBatchParams { reqId: string; tabId?: string; task: string; rows: Array<Record<string, string>>; autoConfirm?: boolean }

export async function runAgentBatch(params: AgentBatchParams, emit: Emit): Promise<void> {
  const rows = (params.rows || []).slice(0, MAX_BATCH_ROWS)
  if (!rows.length) { emit({ type: 'error', message: '반복할 데이터 행이 없습니다.' }); return }
  const st: BatchState = { cancelled: false, current: null }
  batchState.set(params.reqId, st)
  emit({ type: 'batch-start', total: rows.length })
  let completed = 0
  try {
    for (let i = 0; i < rows.length; i++) {
      if (st.cancelled) { emit({ type: 'cancelled' }); break }
      const row = rows[i] ?? {}
      const task = fillTemplate(params.task, row)
      emit({ type: 'batch-row', index: i, total: rows.length, row })
      const sub = `${params.reqId}#${i}`
      st.current = sub
      let outcome = ''
      // 무인 반복: 민감 동작은 autoConfirm 이면 승인, 아니면 그 행만 취소. 질문(ask)도 답할 수 없어 그 행 취소.
      await runAgentTask({ reqId: sub, tabId: params.tabId, task }, (evt) => {
        if (evt.type === 'done') { outcome = String(evt.message ?? '완료'); return }
        if (evt.type === 'error') { outcome = '오류: ' + String(evt.message ?? ''); return }
        if (evt.type === 'cancelled') { outcome = outcome || '건너뜀'; return }
        if (evt.type === 'confirm') { if (params.autoConfirm) confirmAgentStep(sub, true); else cancelAgentTask(sub); return }
        if (evt.type === 'ask') { cancelAgentTask(sub); return }
        // 진행 이벤트(observe/thought/action/result/extracted)는 행 번호를 달아 그대로 전달 → 트레이스·수집표 갱신.
        emit({ ...evt, batchIndex: i })
      })
      st.current = null
      completed++
      emit({ type: 'batch-row-done', index: i, total: rows.length, outcome: outcome.slice(0, 200) })
    }
    emit({ type: 'done', message: `대량 처리 완료 — ${completed}/${rows.length}개 행 처리${st.cancelled ? ' (중단됨)' : ''}.` })
  } catch (err) {
    emit({ type: 'error', message: friendlyError(err instanceof Error ? err.message : String(err)) })
  } finally {
    batchState.delete(params.reqId)
  }
}
