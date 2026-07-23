import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { getFx, getNews, getWeather, getWidgetData, setWidgetData } from '../features/widgets'
import { isTrustedSender } from './trust'

// 새 탭 위젯 사용자 데이터 키 화이트리스트 — 임의 키 쓰기 방지.
const DATA_KEYS = new Set(['notes', 'todos', 'shortcuts', 'notes-left', 'notes-right'])

export function registerWidgetsIpc(): void {
  ipcMain.handle(IPC.widgets.weather, (e, args?: { force?: boolean }) => {
    if (!isTrustedSender(e)) return null
    return getWeather(!!args?.force)
  })

  ipcMain.handle(IPC.widgets.news, (e, args?: { force?: boolean }) => {
    if (!isTrustedSender(e)) return null
    return getNews(!!args?.force)
  })

  ipcMain.handle(IPC.widgets.fx, (e, args?: { force?: boolean }) => {
    if (!isTrustedSender(e)) return null
    return getFx(!!args?.force)
  })

  ipcMain.handle(IPC.widgets.dataGet, (e, args: { key: string }) => {
    if (!isTrustedSender(e)) return null
    if (!DATA_KEYS.has(args?.key)) return null
    return getWidgetData(args.key)
  })

  ipcMain.handle(IPC.widgets.dataSet, (e, args: { key: string; value: unknown }) => {
    if (!isTrustedSender(e)) return
    if (!DATA_KEYS.has(args?.key)) return
    setWidgetData(args.key, args.value)
  })
}
