import { IPC } from '../../shared/ipc-channels'
import {
  getUserChromeState, openUserChromeInEditor, reloadUserChrome, updateUserChrome,
} from '../features/userchrome'
import { handleTrusted } from './trust'

export function registerUserChromeIpc(): void {
  handleTrusted(IPC.userchrome.get, () => getUserChromeState())
  handleTrusted(IPC.userchrome.update, (_e, { kind, content }: { kind: 'css' | 'js'; content: string }) =>
    updateUserChrome(kind, content))
  handleTrusted(IPC.userchrome.reload, () => reloadUserChrome())
  handleTrusted(IPC.userchrome.open, (_e, { kind }: { kind: 'css' | 'js' }) =>
    openUserChromeInEditor(kind))
}
