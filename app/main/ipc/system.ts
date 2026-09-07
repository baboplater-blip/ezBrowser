import { app, ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { IPC } from '../../shared/ipc-channels'
import { isTrustedSender } from './trust'
import { getSleepStats, sweepNow, wakeTab } from '../features/tab-sleep'
import { getDiscardedCount, getTotalTabCount } from '../tabs/tab-service'

interface LicenseEntry {
  name: string
  version: string
  licenses: string
  repository?: string
  publisher?: string
}

let licenseCache: LicenseEntry[] | null = null

async function loadLicenses(): Promise<LicenseEntry[]> {
  if (licenseCache) return licenseCache
  try {
    const file = path.join(app.getAppPath(), 'app', 'main', 'storage', 'oss-licenses.json')
    const raw = await readFile(file, 'utf-8')
    const data = JSON.parse(raw) as Record<string, {
      licenses?: string | string[]; repository?: string; publisher?: string
    }>
    const out: LicenseEntry[] = []
    for (const [key, val] of Object.entries(data)) {
      // key 형식: "name@version"
      const at = key.lastIndexOf('@')
      const name = at > 0 ? key.slice(0, at) : key
      const version = at > 0 ? key.slice(at + 1) : ''
      const licenses = Array.isArray(val.licenses) ? val.licenses.join(', ') : (val.licenses ?? 'Unknown')
      out.push({ name, version, licenses, repository: val.repository, publisher: val.publisher })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    licenseCache = out
    return out
  } catch {
    return []
  }
}

interface ProcessRow {
  pid: number
  type: string
  name?: string
  memoryMB: number
  cpu: number
}

interface Metrics {
  processes: ProcessRow[]
  totals: {
    processCount: number
    memoryMB: number
    /** 메인 프로세스의 정확한 private 메모리(MB). 전체 합계는 workingSet 이라 과대평가된다. */
    mainPrivateMB: number
    avgCpu: number
  }
  tabs: {
    total: number
    discarded: number
    active: number
  }
  sleep: ReturnType<typeof getSleepStats>
  app: {
    version: string
    electronVersion: string
    chromeVersion: string
    nodeVersion: string
    platform: string
    arch: string
  }
  uptime: {
    appMs: number
    processMs: number
  }
}

async function collectMetrics(): Promise<Metrics> {
  const metrics = app.getAppMetrics()
  const rows: ProcessRow[] = metrics.map((m) => ({
    pid: m.pid,
    type: String((m as { type?: string }).type ?? 'Unknown'),
    name: (m as { name?: string }).name,
    memoryMB: Math.round((m.memory?.workingSetSize ?? 0) / 1024),
    cpu: Number(((m.cpu?.percentCPUUsage ?? 0) as number).toFixed(2)),
  })).sort((a, b) => b.memoryMB - a.memoryMB)
  const memoryMB = rows.reduce((s, r) => s + r.memoryMB, 0)
  // getAppMetrics().workingSetSize 는 프로세스 간 공유 페이지를 중복 집계해 실제 물리 사용량보다
  // 크게 나온다(CLAUDE.md: 5~7배). 메인 프로세스만이라도 **정확한 private** 을 함께 준다.
  let mainPrivateMB = 0
  try {
    const info = await process.getProcessMemoryInfo()
    mainPrivateMB = Math.round((info.private ?? 0) / 1024)
  } catch { /* 플랫폼 미지원 시 0 */ }
  const avgCpu = rows.length > 0
    ? Number((rows.reduce((s, r) => s + r.cpu, 0) / rows.length).toFixed(2))
    : 0
  return {
    processes: rows,
    totals: { processCount: rows.length, memoryMB, avgCpu, mainPrivateMB },
    tabs: {
      total: getTotalTabCount(),
      discarded: getDiscardedCount(),
      active: getTotalTabCount() - getDiscardedCount(),
    },
    sleep: getSleepStats(),
    app: {
      version: app.getVersion(),
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    uptime: {
      appMs: Date.now() - bootTime,
      processMs: Math.round(process.uptime() * 1000),
    },
  }
}

const bootTime = Date.now()

export function registerSystemIpc(): void {
  ipcMain.handle(IPC.system.metrics, async (e) => {
    if (!isTrustedSender(e)) return null
    return collectMetrics()
  })

  ipcMain.handle(IPC.system.bootInfo, (e) => {
    if (!isTrustedSender(e)) return null
    return {
      bootTime,
      now: Date.now(),
      uptimeMs: Date.now() - bootTime,
    }
  })

  ipcMain.handle(IPC.system.sweepTabSleep, (e) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return sweepNow()
  })

  ipcMain.handle(IPC.system.wakeTab, (e, args: { tabId: string }) => {
    if (!isTrustedSender(e)) throw new Error('untrusted')
    return wakeTab(args.tabId)
  })

  ipcMain.handle(IPC.system.licenses, async (e) => {
    if (!isTrustedSender(e)) return { app: null, packages: [] }
    return {
      app: {
        version: app.getVersion(),
        electronVersion: process.versions.electron,
        chromeVersion: process.versions.chrome,
      },
      packages: await loadLicenses(),
    }
  })
}

