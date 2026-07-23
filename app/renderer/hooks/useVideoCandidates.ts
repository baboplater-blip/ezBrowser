import { useEffect, useState } from 'react'
import type { MediaCandidate } from '../../shared/types'

export function useVideoCandidates(tabId: string | undefined): MediaCandidate[] {
  const [candidates, setCandidates] = useState<MediaCandidate[]>([])
  useEffect(() => {
    if (!tabId) { setCandidates([]); return }
    void window.browserAPI.video.candidates(tabId).then(setCandidates)
    const off = window.browserAPI.video.onCandidates(({ tabId: t, candidates: c }) => {
      if (t === tabId) setCandidates(c)
    })
    return off
  }, [tabId])
  return candidates
}
