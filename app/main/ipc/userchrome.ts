import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  getUserChromeState, openUserChromeInEditor, reloadUserChrome, updateUserChrome,
} from '../features/userchrome'

export function registerUserChromeIpc(): void {
  ipcMain.handle(IPC.userchrome.get, () => getUserChromeState())
  ipcMain.handle(IPC.userchrome.update, (_e, { kind, content }: { kind: 'css' | 'js'; content: string }) =>
    updateUserChrome(kind, content))
  ipcMain.handle(IPC.userchrome.reload, () => reloadUserChrome())
  ipcMain.handle(IPC.userchrome.open, (_e, { kind }: { kind: 'css' | 'js' }) =>
    openUserChromeInEditor(kind))
}
