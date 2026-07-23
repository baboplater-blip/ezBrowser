import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  addTorrent, pauseTorrent, removeTorrent, resumeTorrent, setTorrentFiles,
} from '../features/torrent'
import { isTrustedSender } from './trust'

export function registerTorrentIpc(): void {
  ipcMain.handle(IPC.torrent.add, (e, { uri }: { uri: string }) => {
    if (!isTrustedSender(e)) return
    return addTorrent(uri)
  })
  ipcMain.handle(IPC.torrent.pause, (e, { id }: { id: string }) => {
    if (!isTrustedSender(e)) return
    return pauseTorrent(id)
  })
  ipcMain.handle(IPC.torrent.resume, (e, { id }: { id: string }) => {
    if (!isTrustedSender(e)) return
    return resumeTorrent(id)
  })
  ipcMain.handle(IPC.torrent.remove, (e, { id, deleteFiles }: { id: string; deleteFiles?: boolean }) => {
    if (!isTrustedSender(e)) return
    return removeTorrent(id, !!deleteFiles)
  })
  ipcMain.handle(IPC.torrent.setFiles, (e, { id, indices }: { id: string; indices: number[] }) => {
    if (!isTrustedSender(e)) return
    return setTorrentFiles(id, indices)
  })
}
