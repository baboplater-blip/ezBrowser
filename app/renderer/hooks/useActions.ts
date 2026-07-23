import { useEffect, useState } from 'react'
import type { ActionDescriptor } from '../../shared/types'

export type ActionWithKey = ActionDescriptor & { key?: string }

export function useActions() {
  const [actions, setActions] = useState<ActionWithKey[]>([])
  useEffect(() => {
    void window.browserAPI.actions.list().then(setActions)
  }, [])
  return actions
}
