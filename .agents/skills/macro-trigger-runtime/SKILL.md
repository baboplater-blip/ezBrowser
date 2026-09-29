---
name: macro-trigger-runtime
description: 자동화 매크로 트리거·액션 런타임. URL/시간/단축키/요소 트리거 → 액션 시퀀스 실행. 무한 루프·cooldown 방어.
---

# Macro Trigger Runtime

## 트리거 라우터

```ts
type Trigger =
  | { type: 'urlEnter'; match: string }
  | { type: 'cron'; spec: string }      // "0 9 * * *"
  | { type: 'shortcut'; key: string }
  | { type: 'elementVisible'; selector: string; urlMatch?: string }
  | { type: 'downloadDone'; mimeMatch?: string }
  | { type: 'tabClose' }
  | { type: 'appStart' }
  | { type: 'workspaceSwitch'; workspaceId?: string }

class MacroRouter {
  private macros: Macro[] = []
  private cooldowns = new Map<string, number>()  // macroId → lastFiredTs
  private runCounts = new Map<string, number>()  // 5초 윈도우

  shouldFire(macroId: string): boolean {
    const last = this.cooldowns.get(macroId) ?? 0
    if (Date.now() - last < 5000) {
      const count = (this.runCounts.get(macroId) ?? 0) + 1
      this.runCounts.set(macroId, count)
      if (count > 10) {
        log.warn(`Macro ${macroId} firing too frequently — disabled for 1 min`)
        this.cooldowns.set(macroId, Date.now() + 60_000)
        return false
      }
    } else {
      this.runCounts.set(macroId, 1)
    }
    this.cooldowns.set(macroId, Date.now())
    return true
  }

  async fire(macro: Macro, ctx: TriggerCtx) {
    if (!this.shouldFire(macro.id)) return
    try {
      await runActions(macro.actions, ctx)
      auditLog(macro.id, 'success')
    } catch (e) {
      auditLog(macro.id, 'error', (e as Error).message)
    }
  }
}
```

## 트리거 등록

### URL 진입
```ts
webContents.on('did-navigate', (e, url) => {
  for (const m of macros.filter(m => m.trigger.type === 'urlEnter')) {
    if (urlMatches(url, m.trigger.match)) router.fire(m, { url, tabId: tabIdOf(webContents) })
  }
})
```

### 시간 (cron)
```ts
import cron from 'node-cron'
for (const m of macros.filter(m => m.trigger.type === 'cron')) {
  cron.schedule(m.trigger.spec, () => router.fire(m, {}))
}
```

### 단축키
```ts
// keymap-engineer 가 매크로마다 action.macro.run.<id> 등록
registerAction({
  id: `action.macro.run.${m.id}`,
  defaultKey: m.trigger.type === 'shortcut' ? m.trigger.key : undefined,
  run: (ctx) => router.fire(m, ctx),
})
```

### 요소 등장
콘텐츠 스크립트 주입 — MutationObserver:
```ts
const obs = new MutationObserver(() => {
  for (const { selector, macroId } of activeWatchers) {
    if (document.querySelector(selector)) {
      browserAPI.macro.notifyElementVisible(macroId, selector)
      activeWatchers.delete(macroId)  // 한 번만
    }
  }
})
obs.observe(document.body, { childList: true, subtree: true })
```

## 액션 실행

```ts
type Action =
  | { type: 'openUrl'; url: string; background?: boolean }
  | { type: 'click'; selector: string; nth?: number }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'wait'; ms?: number; selector?: string }
  | { type: 'scroll'; px?: number; selector?: string }
  | { type: 'screenshot'; mode: 'viewport' | 'fullpage'; savePath: string }
  | { type: 'runJs'; code: string }
  | { type: 'notify'; message: string }
  | { type: 'sendKeys'; combo: string }
  | { type: 'if'; cond: string; then: Action[]; else?: Action[] }
  | { type: 'loop'; times: number; body: Action[] }
  | { type: 'switchWorkspace'; id: string }

async function runActions(actions: Action[], ctx: TriggerCtx) {
  for (const a of actions) await runAction(a, ctx)
}

async function runAction(a: Action, ctx: TriggerCtx) {
  switch (a.type) {
    case 'openUrl': await tabService.create({ url: a.url, background: a.background ?? false }); break
    case 'click':   await execInTab(ctx.tabId, `document.querySelectorAll(${JSON.stringify(a.selector)})[${a.nth ?? 0}]?.click()`); break
    case 'fill':    {
      const value = resolveSecrets(a.value)
      await execInTab(ctx.tabId, `(() => { const el = document.querySelector(${JSON.stringify(a.selector)}); if (!el) return; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles:true})); })()`)
      break
    }
    case 'wait':    {
      if (a.ms) await sleep(a.ms)
      if (a.selector) await waitForSelector(ctx.tabId, a.selector, 5000)
      break
    }
    // ... etc
  }
}
```

## 비밀 참조

```ts
function resolveSecrets(value: string): string {
  return value.replace(/\{secret:([^}]+)\}/g, (_, id) => {
    return credentialsManager.peek(id) ?? ''  // 메모리 only, 즉시 zero-fill
  })
}
```

매크로 본문에 평문 비밀번호 금지. `{secret:gmail-pw}` 같은 참조만.

## 로그

`userData/logs/automation.log` — 매 발화 결과(시각·매크로·트리거·성공/실패).

## 절대 피할 것

- 매크로가 자기 트리거 다시 발화 (예: openUrl 이 같은 URL) — cooldown + 자기 자신 트리거 무시
- runJs 가 메인 권한 — 격리 컨텍스트, `browserAPI` 만
- fill 액션에 평문 비밀번호 — `{secret:id}` 강제
- 트리거 매칭이 모든 매크로 순회 — URL/이벤트 인덱싱
- 사용자 동의 없는 매크로 자동 실행 — 첫 활성 시 명시 동의
