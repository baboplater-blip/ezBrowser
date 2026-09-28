import type { ActionContext, ActionDescriptor } from '../../shared/types'

export interface ActionRunCtx {
  windowId?: string
  tabId?: string
}

export interface Action extends ActionDescriptor {
  run: (ctx: ActionRunCtx) => void | Promise<void>
  enabled?: (ctx: ActionRunCtx) => boolean
}

const actions = new Map<string, Action>()

export function registerAction(action: Action): void {
  if (actions.has(action.id)) {
    console.warn(`[actions] duplicate id ${action.id} — overwriting`)
  }
  actions.set(action.id, action)
}

// 묶음 G: 매크로 등 동적으로 등록된 액션을 제거·수정 시 정리하기 위한 최소 추가.
export function unregisterAction(id: string): void {
  actions.delete(id)
}

export function getAction(id: string): Action | undefined {
  return actions.get(id)
}

export function listActions(): ActionDescriptor[] {
  return Array.from(actions.values()).map((a) => ({
    id: a.id,
    category: a.category,
    labelKey: a.labelKey,
    defaultKey: a.defaultKey,
    when: a.when,
  }))
}

export async function runAction(id: string, ctx: ActionRunCtx): Promise<boolean> {
  const a = actions.get(id)
  if (!a) {
    console.warn(`[actions] unknown action ${id}`)
    return false
  }
  if (a.enabled && !a.enabled(ctx)) return false
  try {
    await a.run(ctx)
    return true
  } catch (err) {
    console.error(`[actions] ${id} failed`, err)
    return false
  }
}

export function listByContext(when: ActionContext): ActionDescriptor[] {
  return listActions().filter((a) => !a.when || a.when === when || a.when === 'global')
}
