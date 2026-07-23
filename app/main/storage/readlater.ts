import Store from 'electron-store'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ReadLaterItem } from '../../shared/types'

// 읽기 목록(나중에 보기) — 페이지를 저장해두고 탭을 비운 뒤 나중에 다시 방문.
export const readlaterEvents = new EventEmitter()

const store = new Store<{ items: ReadLaterItem[] }>({ name: 'readlater', defaults: { items: [] } })
const MAX_ITEMS = 500

function getItems(): ReadLaterItem[] {
  const items = store.get('items')
  return Array.isArray(items) ? items : []
}
function setItems(items: ReadLaterItem[]): void {
  store.set('items', items.slice(0, MAX_ITEMS))
  readlaterEvents.emit('changed')
}

export function listReadLater(): ReadLaterItem[] {
  return getItems()
}

export function isReadLaterSaved(url: string): boolean {
  return getItems().some((x) => x.url === url)
}

export function addReadLater(args: { url: string; title?: string; favicon?: string }): ReadLaterItem | null {
  if (!args.url || !/^https?:/i.test(args.url)) return null
  const items = getItems()
  const existing = items.find((x) => x.url === args.url)
  if (existing) return existing
  const item: ReadLaterItem = {
    id: randomUUID(),
    url: args.url,
    title: args.title || args.url,
    favicon: args.favicon,
    read: false,
    savedAt: Date.now(),
  }
  setItems([item, ...items]) // 최신 우선
  return item
}

export function removeReadLater(id: string): void {
  setItems(getItems().filter((x) => x.id !== id))
}

export function removeReadLaterByUrl(url: string): void {
  setItems(getItems().filter((x) => x.url !== url))
}

export function setReadLaterRead(id: string, read: boolean): void {
  const items = getItems()
  const it = items.find((x) => x.id === id)
  if (!it) return
  it.read = read
  it.readAt = read ? Date.now() : undefined
  setItems(items)
}

export function clearReadReadLater(): void {
  setItems(getItems().filter((x) => !x.read))
}
