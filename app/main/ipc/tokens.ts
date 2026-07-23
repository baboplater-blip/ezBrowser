import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  defaultsAsCssVars, getOverrides, getOverridesAsCssVars,
  listEditableTokens, resetTokens, setOverride, tokenEvents,
} from '../features/design-tokens'
import { getAllWindows, broadcastToInternalPages } from '../windows/window-service'
import { isTrustedSender } from './trust'

export function registerTokensIpc(): void {
  ipcMain.handle(IPC.tokens.get, (e) => {
    if (!isTrustedSender(e)) return null
    return {
      editable: listEditableTokens(),
      overrides: getOverrides(),
      cssVars: getOverridesAsCssVars(),
      defaults: defaultsAsCssVars(),
    }
  })

  ipcMain.handle(IPC.tokens.set, async (e, args: { key: string; value: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return setOverride(args.key, args.value)
  })

  ipcMain.handle(IPC.tokens.reset, async (e) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    await resetTokens()
  })

  tokenEvents.on('changed', () => {
    const payload = { overrides: getOverrides(), cssVars: getOverridesAsCssVars() }
    for (const ctx of getAllWindows()) {
      ctx.chrome.webContents.send(IPC.tokens.changed, payload)
    }
    broadcastToInternalPages(IPC.tokens.changed, payload)
  })
}
