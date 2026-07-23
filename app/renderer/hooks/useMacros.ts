import { useEffect, useState } from 'react'
import type { MacroSummary } from '../../shared/types'

export function useMacros(): MacroSummary[] {
  const [macros, setMacros] = useState<MacroSummary[]>([])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await window.browserAPI.macro.list()
        if (!cancelled) setMacros(list)
      } catch { /* ignore */ }
    })()
    const off = window.browserAPI.macro.onChanged((list) => setMacros(list))
    return () => { cancelled = true; off() }
  }, [])
  return macros
}
