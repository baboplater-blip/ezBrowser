import { useEffect, useMemo, useState } from 'react'
import type { TabSummary } from '../../shared/types'

export function useTabs(windowId: string | null) {
  const [tabs, setTabs] = useState<TabSummary[]>([])

  useEffect(() => {
    if (!windowId) return
    let cancelled = false
    void window.browserAPI.tabs.list(windowId).then((list) => {
      if (!cancelled) setTabs(list)
    })

    const offList = window.browserAPI.tabs.onListChanged((payload) => {
      if (payload.windowId !== windowId) return
      setTabs(payload.tabs)
    })
    const offUpdate = window.browserAPI.tabs.onUpdate((tab) => {
      if (tab.windowId !== windowId) return
      setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, ...tab } : t)))
    })

    return () => { cancelled = true; offList(); offUpdate() }
  }, [windowId])

  const activeTab = useMemo(() => tabs.find((t) => t.active) ?? null, [tabs])

  return { tabs, activeTab }
}
