import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  getPolicy, listPolicies, policyEvents, removePolicy,
  savePolicy, setPolicyEnabled,
} from '../features/policy'
import type { PolicyRule } from '../../shared/types'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { isTrustedSender } from './trust'

export function registerPolicyIpc(): void {
  ipcMain.handle(IPC.policy.list, (e) => {
    if (!isTrustedSender(e)) return []
    return listPolicies()
  })

  ipcMain.handle(IPC.policy.get, (e, args: { id: string }) => {
    if (!isTrustedSender(e)) return null
    return getPolicy(args.id)
  })

  ipcMain.handle(IPC.policy.save, async (e, args: Partial<PolicyRule>) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return savePolicy(args)
  })

  ipcMain.handle(IPC.policy.remove, async (e, args: { id: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    await removePolicy(args.id)
  })

  ipcMain.handle(IPC.policy.setEnabled, async (e, args: { id: string; enabled: boolean }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    await setPolicyEnabled(args.id, args.enabled)
  })

  policyEvents.on('changed', () => {
    const summaries = listPolicies()
    for (const ctx of getAllWindows()) {
      ctx.chrome.webContents.send(IPC.policy.changed, summaries)
    }
    broadcastToInternalPages(IPC.policy.changed, summaries)
  })
}
