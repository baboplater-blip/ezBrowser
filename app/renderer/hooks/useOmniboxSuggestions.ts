import { useEffect, useRef, useState } from 'react'
import type { OmniboxSuggestion } from '../../shared/types'

export function useOmniboxSuggestions(query: string, windowId: string | null, enabled: boolean) {
  const [suggestions, setSuggestions] = useState<OmniboxSuggestion[]>([])
  const seqRef = useRef(0)

  useEffect(() => {
    if (!enabled || !windowId) { setSuggestions([]); return }
    const q = query.trim()
    if (!q) { setSuggestions([]); return }
    const seq = ++seqRef.current
    const timer = setTimeout(async () => {
      try {
        const result = await window.browserAPI.omnibox.suggest(q, windowId)
        if (seqRef.current === seq) setSuggestions(result)
      } catch {
        if (seqRef.current === seq) setSuggestions([])
      }
    }, 150)
    return () => clearTimeout(timer)
  }, [query, windowId, enabled])

  return suggestions
}
