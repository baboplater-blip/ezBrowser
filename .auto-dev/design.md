# ezBrowser — 설계: 영속 작업 런타임 + 범용 조작

> run-20260918T071658Z-a991dc. 검증 매트릭스는 `verification.md` 에 **구현 전** 고정됨.

## 문제 (Astra 확인 + 코드 실측)

1. `agent.ts:747` `maxSteps = clamp(6..80)` + `:825` `for (let step=1; step<=maxSteps; step++)` — 단일 for 루프.
   문맥 압축·구간 재개 없음. 80단계가 하드 천장.
2. `agent.ts:1531~1545` — **단계 소진 시 `emit({type:'done'})`**. `agent-runs.ts` 는 done 을 `status:'done'` 으로
   기록 → 실패가 ✅ 성공으로 남는다.
3. `agent-runs.ts:72` — 재시작 시 `running` → `cancelled`. 이어갈 수 없다(체크포인트 없음).
4. `agent-schedule.ts` — `jobs` 가 메모리 `Map`. 재시작에 소실. 질문/확인 시 실행 취소.
5. `page-actions.ts:70` — `REF_KEY` 가 **모듈 상수**(모든 탭·모든 관찰 공유). 관찰 세대(epoch)·프레임 바인딩이
   없어 탭 전환·재렌더 후 같은 번호가 다른 요소를 집을 수 있다(이름 접두 검사만으로는 불충분).

## 새 구조

```
task-runtime.ts  (NEW · 영속 작업 관리자)
  └ 구간(segment) 단위로 agent.ts 를 반복 호출
       ├ 구간 끝 = 체크포인트 저장(압축 진행요약 + 완료 하위작업 + 탭/워크스페이스)
       ├ done → 결과 검증 → completed | needs-verify
       ├ exhausted → 다음 구간 (문맥은 요약으로 압축)
       └ error → 원인 분류 → retrying(backoff) | waiting-user | failed
agent.ts  (구간 실행기로 축소 — 한 구간의 단계만 돌린다)
page-actions.ts  (관찰 세대·프레임 엄격 바인딩)
agent-schedule.ts  (영속 + 중복 실행 방지)
```

## 1. `task-runtime.ts` — 확정 인터페이스 (W1 구현)

```ts
export type TaskState =
  | 'queued'        // 만들어졌지만 아직 시작 전
  | 'running'        // 구간 실행 중
  | 'paused'         // 사용자 일시정지 — 페이지 부작용 0
  | 'waiting-user'   // 확인/질문 대기 (이유는 waitReason)
  | 'retrying'       // 원인별 재시도 대기 (retry.nextAt)
  | 'interrupted'    // 단계/시간 소진 또는 크래시 — 이어가기 가능
  | 'needs-verify'   // 모델이 done 했으나 결과 근거 불충분 — 사용자 확인 필요
  | 'completed' | 'failed' | 'cancelled'

export type RetryKind = 'network' | 'rate-limit' | 'cli-dead' | 'tab-gone' | 'login' | 'model' | 'unknown'

export interface TaskBudget {
  maxSteps: number        // 총 단계 예산 (normal 기본 25 · long 기본 2000)
  maxDurationMs: number   // 총 실행 시간 (normal 30분 · long 사용자 지정, 24h+ 허용)
  maxLlmCalls: number     // 모델 호출 상한 (구독 한도 보호)
  allowedHosts: string[]  // [] = 제한 없음. 있으면 그 호스트(및 서브도메인)만 이동 허용
}

export interface TaskCheckpoint {
  segment: number          // 완료한 구간 수
  stepsUsed: number        // 누적 단계
  llmCalls: number
  progressSummary: string  // 압축 진행요약 — 다음 구간 프롬프트에 주입 (<=1200자)
  doneSubtasks: string[]   // 완료한 하위작업 (<=20)
  tabUrl: string | null    // 마지막 조작 탭의 URL (복원 시 재바인딩 기준)
  workspaceId: string | null
  windowId: string | null
  savedAt: number
}

export interface PersistentTask {
  id: string
  instruction: string          // 원 지시 (불변)
  state: TaskState
  mode: 'normal' | 'long'
  budget: TaskBudget
  checkpoint: TaskCheckpoint
  usage: { input: number; cacheRead: number; cacheCreate: number; output: number; llmCalls: number }
  resultFiles: string[]        // 보고서·다운로드 등 결과 파일 절대경로
  result?: string
  verifyEvidence?: string      // 완료 근거 (없으면 needs-verify)
  waitReason?: string
  retry?: { kind: RetryKind; attempt: number; nextAt: number; detail: string }
  readOnly: boolean
  incognito: boolean           // true → 디스크에 쓰지 않음(메모리만)
  ownerWindowId: string | null // 소유 창 — IPC 조작 권한 검사에 사용
  externalWrites: Array<{ label: string; at: number; confirmed: boolean }>  // 외부 쓰기 원장(중복 방지)
  createdAt: number; updatedAt: number; startedAt: number; endedAt?: number
  elapsedMs: number            // 누적 실행 시간(일시정지 제외)
}

export interface TaskSummary {   // UI 목록용 (instruction 는 200자 컷)
  id: string; instruction: string; state: TaskState; mode: 'normal' | 'long'
  stepsUsed: number; maxSteps: number; segment: number
  elapsedMs: number; startedAt: number; endedAt?: number
  waitReason?: string; retry?: PersistentTask['retry']
  llmCalls: number; maxLlmCalls: number
  result?: string; resultFiles: string[]; needsVerify: boolean
}

export const taskEvents: EventEmitter   // 'changed'(TaskSummary[]) · 'event'({taskId, ...AgentEvent})

export function initTaskRuntime(): void          // 부팅: 로드 + running/waiting-user → interrupted
export function listTasks(): TaskSummary[]
export function getTask(id: string): PersistentTask | null
export function createTask(args: {
  instruction: string; tabId: string; windowId: string | null
  mode?: 'normal' | 'long'; readOnly?: boolean; incognito?: boolean
  budget?: Partial<TaskBudget>
}): TaskSummary | null                            // 빈 지시 → null
export function startTask(id: string): void       // queued|interrupted|paused → running (구간 루프 시작)
export function pauseTask(id: string): void
export function resumeTask(id: string): void      // paused|interrupted → running (다음 미완 구간부터)
export function cancelTask(id: string): void
export function deleteTask(id: string): void
export function confirmTask(id: string, approved: boolean): void   // waiting-user(confirm)
export function answerTask(id: string, answer: string): void       // waiting-user(ask)
export function acceptTaskResult(id: string): void                 // needs-verify → completed (사용자 승인)
export function flushTasks(): void                                 // before-quit
```

### 구간 루프 (핵심)

```
startTask(id):
  while (state === 'running'):
    1. 예산 검사 — steps/duration/llmCalls 초과 → interrupted(사유 기록) + break
    2. 탭 재바인딩 — resolveTaskTab(task) (아래 3절)
    3. 구간 예산 = min(SEGMENT_STEPS(=12), 남은 단계)
    4. runAgentTask({ reqId, tabId, task: instruction, startStep, stepBudget,
                      resumeContext: {progressSummary, doneSubtasks}, allowedHosts, readOnly }, onEvent)
    5. 결과 분기:
       'done'       → 근거 있으면 completed / 없으면 needs-verify
       'exhausted'  → 체크포인트 저장 후 다음 구간 continue
       'error'      → classifyRetry() → retrying(backoff) | waiting-user | failed
       'cancelled'  → cancelled
```

- **단계 소진은 성공이 아니다.** `exhausted` 는 done 으로 승격되지 않는다(T3).
- **완료 검증(T4)**: `done` 이벤트에 `evidence`(스크린샷/완료문구/결과파일)가 없고 읽기전용도 아니면
  `needs-verify`. 사용자가 `acceptTaskResult` 해야 `completed`.
- **backoff**: network 2s→8s→30s(3회) · rate-limit 60s→300s→900s(3회) · cli-dead 즉시 1회 후 폴백 ·
  tab-gone → waiting-user("탭을 다시 열어주세요") · login → waiting-user("로그인해 주세요") · model 3회.
- **외부 쓰기 원장(T13)**: 발행성 동작은 `externalWrites` 에 기록. 같은 label 이 이미 있고 `confirmed=false`
  이면 자동 재실행하지 않고 `waiting-user`("발행이 됐는지 확실하지 않습니다 — 확인해 주세요").
  **"정확히 한 번"을 보장한다고 쓰지 않는다.**

### 3. 탭 재바인딩 (T9)

```
resolveTaskTab(task):
  1. checkpoint.windowId 의 탭 목록에서 checkpoint.tabUrl 과 같은 호스트+경로 탭 → 그것
  2. 없으면 같은 워크스페이스의 활성 http 탭 → 그것 (URL 이 다르면 진행요약에 "다른 페이지에서 재개" 기록)
  3. 시크릿 탭·다른 워크스페이스 탭은 **절대 쓰지 않는다** → waiting-user("작업할 탭을 열어주세요")
```

## 2. `agent.ts` 변경 (팀장 직접)

```ts
export interface AgentTaskParams {
  reqId: string; tabId?: string; task: string; readOnly?: boolean; unattended?: boolean
  // --- 신규 ---
  startStep?: number         // 이 구간의 시작 단계 번호(누적 표시용)
  stepBudget?: number        // 이 구간에 허용된 단계 수 (없으면 기존 설정값)
  resumeContext?: { progressSummary: string; doneSubtasks: string[] }
  allowedHosts?: string[]    // [] 또는 미지정 = 제한 없음
}
```
- 루프: `for (let step = startStep; step < startStep + stepBudget; step++)`
- **단계 소진 → `emit({type:'exhausted', stepsUsed, progressSummary, doneSubtasks, tabUrl})`** (done 아님)
- `done` 이벤트에 `evidence?: string` 동반(완료 문구·보고서 경로·스크린샷 유무)
- `pauseAgentTask(reqId)` / `resumeAgentTask(reqId)` — 부작용 직전 관문에서 대기(취소와 같은 자리)
- `navigate`/`open_tab` 에서 `allowedHosts` 밖이면 거부(사유 보고)
- `resumeContext` 는 system 프롬프트에 "# 지금까지 진행" 블록으로 주입 (기존 `priorContextBlock` 옆)

## 3. `page-actions.ts` 변경 (W2)

**관찰 세대(epoch) + 프레임 엄격 바인딩**
- `observePage` 가 `PageObservation.epoch: string` 을 반환. 관찰마다 새 토큰(`tabKey#n`).
- 레지스트리 항목에 `f`(프레임 URL) 저장. `pick(ref, epoch)` 는
  ① 레지스트리 epoch ≠ 인자 epoch → null ("관찰이 바뀌었습니다 — 다시 관찰")
  ② 프레임 URL 불일치 → null
  ③ (기존) 이름 접두 검사
- 모든 실행 함수(`executeInPageAction`·`hover`·`key`·`drag`·`upload`·`resolveHref` …)가 epoch 를 받아 전달.
- 탭마다 registry 를 분리(`REF_KEY` 를 탭별로) — 다른 탭의 같은 번호가 절대 안 걸린다.

**범용 조작 갭** — 실측 후 실제 막힌 것만 수정. 추측 방어 코드 금지.

## 4. `agent-schedule.ts` 변경 (W3)
- `ai-agent-schedule.json` 영속(json-store). 재시작 시 `running|waiting` → `stopped` + `resumable:true`
  (자동 부활 금지). `lastRunAt` 영속 → 재시작 직후 즉시 재발화 방지.
- 중복 실행 방지: job 당 단일 비행(`runningReq`) + 영속 `lastRunAt` 기준 간격 재계산.

## 보존할 기존 강점 (건드리지 않는다)
- 취소 경계(`terminated`/`abortIfCancelled`) — 취소 후 부작용 0 계약
- `agent-gate.ts` 위험 등급·인젝션·읽기전용 하드블록
- `agent-files.ts` 자료 폴더 경계
- 이전 라운드의 AI 첫 사용 개선(`detect.ts` 자동 탐지·원클릭 연결)
- 사람 입력(trusted) 경로·봇회피 — **추가 은폐 코드 금지**

---

## 구현 중 확정된 규격 변경 (조용히 바꾸지 않고 기록)

구현자가 규격을 실제 코드와 대조하며 찾은 문제들. **전부 규격보다 구현이 옳다고 판단해 채택**했다.

1. **`elapsedMs` 는 `running` 동안만 누적** — 규격은 "일시정지 제외"만 적었으나 확인 대기·재시도 대기도
   제외해야 한다. 안 그러면 사용자가 2시간 뒤에 답한 작업이 재개 즉시 시간 예산 초과로 죽는다.
2. **시크릿 경계는 양방향** — 규격의 "시크릿 탭은 절대 쓰지 않는다"를 문자대로 하면 시크릿 작업이
   자기 탭도 못 써서 첫 구간부터 막힌다. `isIncognitoTab(tab) === task.incognito` 로 일반→시크릿,
   시크릿→일반 **둘 다** 금지(T9 부정 사례는 그대로 충족).
3. **`login`/`tab-gone` 은 `user-fix` 로 묶어 재개 가능하게** — 규격대로 `waiting-user` 만 두면
   `startTask`/`resumeTask` 가 그 상태를 거부해 **로그인을 마친 사용자가 이어갈 방법이 없는 막다른 길**이었다.
   `confirmTask(id, true)` 로 이어간다.
4. **`createTask` 는 `queued` 로 남는다** — 호출자가 `startTask` 를 따로 불러야 `running` 이 된다.
5. **`pauseTask` 는 `running`/`retrying` 에서만** — `waiting-user` 에서 일시정지하면 확인·답변 경로가
   둘 다 `waiting-user` 를 요구해 교착된다.
6. **50개 상한은 끝난 작업만 비운다** — 돌고 있는 작업을 목록에서 빼면 루프가 지도에 없는 객체를 붙들고
   페이지를 계속 조작한다.
7. **`classifyRetry` 를 export** — 하네스가 T11 을 앱 없이 단위 검증할 수 있게(추가일 뿐 규격 변경 아님).

### 완료 근거 판정에서 의도적으로 제외한 것
- **`done.shot`(스크린샷)은 근거가 아니다.** `agent.ts` 는 단계 소진이든 성공이든 스크린샷을 붙이므로,
  근거로 인정하면 "증거 없는 done" 이 존재할 수 없어져 완료 검증(T4)이 **통과 도장**이 된다.
  판정은 `evidence` → `resultFiles` → `readOnly` 순으로만.
- **외부쓰기 원장 확정은 라벨 휴리스틱이 아니라 `agent.ts` 가 센 `publishPending` 사실값을 따른다.**
  `PUBLISH_RE` 에 "저장하기" 가 있어 임시저장 클릭도 발행으로 잡힌다 — 라벨만 믿으면 멀쩡한 작업이
  "발행됐는지 모르겠다"로 멈춘다. 라벨은 사람이 읽을 문구로만 쓴다.

### 알려진 한계 (추측 방어 코드를 넣지 않은 자리)
- 대상 탭이 **잠자는(discarded) 탭**이면 `about:blank` 라 후보에서 빠지고 활성 탭으로 재바인딩된다(깨우지 않는다).
- ~~`usage` 를 보고하지 않는 제공자에서는 `llmCalls` 가 0에 머물러 호출 예산이 발동하지 않는다~~
  → **팀장이 해소(2026-09-18)**: 모델을 실제로 부른 5개 경로 전부가 `{type:'usage', step}` 를 내보낸다.
  런타임이 이 이벤트 수로 `llmCalls` 를 세므로 **모든 제공자에서 호출 상한이 발동한다**.
  **토큰 필드는 넣지 않는다** — 미계측을 0으로 위장하면 사용량 표시가 거짓이 된다(호출 수만 정확하고,
  토큰은 제공자가 알려줄 때만 누적된다).
- **cross-origin iframe 내부는 관찰·조작 불가**(브라우저 same-origin 정책). 대신 `crossOriginFrames` 로
  "못 보는 영역이 있다"를 모델·사용자에게 알린다. 완전 지원은 `WebFrameMain` 기반 별도 아키텍처가 필요.
- **closed shadow DOM 은 스펙상 불가.**
