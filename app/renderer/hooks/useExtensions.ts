import { useEffect, useState } from 'react'
import type { ExtensionSummary } from '../../shared/types'

export function useExtensions(): ExtensionSummary[] {
  const [list, setList] = useState<ExtensionSummary[]>([])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const l = await window.browserAPI.extensions.list()
        if (!cancelled) setList(l)
      } catch { /* ignore */ }
    })()
    const off = window.browserAPI.extensions.onChanged((l) => setList(l))
    return () => { cancelled = true; off() }
  }, [])
  return list
}
