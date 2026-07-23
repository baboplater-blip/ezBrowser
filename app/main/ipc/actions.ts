import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { listActions, runAction } from '../actions/registry'
import { findKeyFor, getKeymap, loadKeymap, saveKeymap, resetKeymap, findConflicts } from '../keymap/keymap-service'
import { isTrustedSender } from './trust'

export function registerActionsIpc(): void {
  ipcMain.handle(IPC.actions.list, (e) => {
    if (!isTrustedSender(e)) return []
    const actions = listActions()
    return actions.map((a) => ({ ...a, key: findKeyFor(a.id) }))
  })

  ipcMain.handle(IPC.actions.run, async (e, { id, ctx }: { id: string; ctx: { windowId?: string; tabId?: string } }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return runAction(id, ctx)
  })

  ipcMain.handle(IPC.keymap.get, async (e) => {
    if (!isTrustedSender(e)) return { keymap: { version: 1, bindings: [] }, conflicts: [] }
    await loadKeymap()
    return { keymap: getKeymap(), conflicts: findConflicts() }
  })

  ipcMain.handle(IPC.keymap.set, async (e, { keymap }: { keymap: ReturnType<typeof getKeymap> }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    await saveKeymap(keymap)
    return { keymap: getKeymap(), conflicts: findConflicts() }
  })

  ipcMain.handle(IPC.keymap.reset, async (e) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    await resetKeymap()
    return { keymap: getKeymap(), conflicts: findConflicts() }
  })
}
