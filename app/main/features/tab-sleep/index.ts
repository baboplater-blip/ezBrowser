import { EventEmitter } from 'node:events'
import { getSetting } from '../../storage/settings'
import {
  discardTab, getAllTabRecordsForSleep, isPinnedTab, isTabActive, undiscardTab,
} from '../../tabs/tab-service'

// 기본 30분 비활성 → 슬립. settings 에서 조정 가능.
const DEFAULT_IDLE_MS = 30 * 60 * 1000
const CHECK_INTERVAL_MS = 60 * 1000

let timer: NodeJS.Timeout | null = null
let sleepCount = 0
let lastSweepAt = 0

export const tabSleepEvents = new EventEmitter()

function idleThresholdMs(): number {
  try {
    const v = (getSetting('performance') as { tabSleepMinutes?: number } | undefined)?.tabSleepMinutes
    if (typeof v === 'number' && v >= 1) return v * 60 * 1000
  } catch { /* ignore */ }
  return DEFAULT_IDLE_MS
}

function isSleepEnabled(): boolean {
  try {
    const v = (getSetting('performance') as { tabSleepEnabled?: boolean } | undefined)?.tabSleepEnabled
    return v !== false
  } catch { return true }
}

export function getSleepStats(): { sleepCount: number; lastSweepAt: number; thresholdMs: number; enabled: boolean } {
  return {
    sleepCount,
    lastSweepAt,
    thresholdMs: idleThresholdMs(),
    enabled: isSleepEnabled(),
  }
}

export function sweepNow(): { discarded: number; skipped: number } {
  lastSweepAt = Date.now()
  if (!isSleepEnabled()) return { discarded: 0, skipped: 0 }
  const threshold = idleThresholdMs()
  const now = Date.now()
  let discarded = 0
  let skipped = 0
  for (const t of getAllTabRecordsForSleep()) {
    if (t.discarded) { skipped += 1; continue }
    if (t.pinned || isPinnedTab(t.id)) { skipped += 1; continue }
    if (isTabActive(t.id)) { skipped += 1; continue }
    if (now - t.lastActiveAt < threshold) { skipped += 1; continue }
    const url = t.url
    if (!url) { skipped += 1; continue }
    if (/^browser:|^about:/i.test(url)) { skipped += 1; continue }
    if (url === 'about:blank') { skipped += 1; continue }
    discardTab(t.id)
    discarded += 1
  }
  sleepCount += discarded
  if (discarded > 0) tabSleepEvents.emit('changed')
  return { discarded, skipped }
}

export function wakeTab(tabId: string): boolean {
  return undiscardTab(tabId)
}

export function startTabSleepLoop(): void {
  if (timer) return
  timer = setInterval(() => { sweepNow() }, CHECK_INTERVAL_MS)
}

export function stopTabSleepLoop(): void {
  if (timer) { clearInterval(timer); timer = null }
}
