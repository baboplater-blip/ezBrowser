import { registerTabsIpc } from './tabs'
import { registerOmniboxIpc } from './omnibox'
import { registerSettingsIpc } from './settings'
import { registerActionsIpc } from './actions'
import { registerUserChromeIpc } from './userchrome'
import { registerScreenshotIpc } from './screenshot'
import { registerDownloadsIpc } from './downloads'
import { registerAdblockIpc } from './adblock'
import { registerTorrentIpc } from './torrent'
import { registerVideoIpc } from './video'
import { registerBookmarksIpc } from './bookmarks'
import { registerHistoryIpc } from './history'
import { registerWindowsIpc } from './windows'
import { registerUserscriptIpc } from './userscript'
import { registerPolicyIpc } from './policy'
import { registerWorkspaceIpc } from './workspace'
import { registerPasswordIpc } from './password'
import { registerDataIpc } from './data'
import { registerTokensIpc } from './tokens'
import { registerMacroIpc } from './macro'
import { registerModIpc } from './mod'
import { registerSystemIpc } from './system'
import { registerExtensionsIpc } from './extensions'
import { registerUpdateIpc } from './update'
import { registerPerfIpc } from './perf'
import { registerFindIpc } from './find'
import { registerWidgetsIpc } from './widgets'
import { registerGroupsIpc } from './groups'
import { registerReadLaterIpc } from './readlater'
import { registerPermissionsIpc } from './permissions'
import { registerSiteDataIpc } from './sitedata'
import { registerImportIpc } from './import'
import { registerAiIpc } from './ai'

export function registerAllIpc(): void {
  registerWindowsIpc()
  registerWorkspaceIpc()
  registerUserscriptIpc()
  registerPolicyIpc()
  registerPasswordIpc()
  registerTabsIpc()
  registerOmniboxIpc()
  registerSettingsIpc()
  registerActionsIpc()
  registerUserChromeIpc()
  registerScreenshotIpc()
  registerDownloadsIpc()
  registerAdblockIpc()
  registerTorrentIpc()
  registerVideoIpc()
  registerBookmarksIpc()
  registerHistoryIpc()
  registerDataIpc()
  registerTokensIpc()
  registerMacroIpc()
  registerModIpc()
  registerSystemIpc()
  registerExtensionsIpc()
  registerUpdateIpc()
  registerPerfIpc()
  registerFindIpc()
  registerWidgetsIpc()
  registerGroupsIpc()
  registerReadLaterIpc()
  registerPermissionsIpc()
  registerSiteDataIpc()
  registerImportIpc()
  registerAiIpc()
}
