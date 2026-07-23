import { useEffect, useState } from 'react'
import type { DownloadItem } from '../../shared/types'

export function useDownloads() {
  const [list, setList] = useState<DownloadItem[]>([])
  useEffect(() => {
    void window.browserAPI.downloads.list().then(setList)
    const off = window.browserAPI.downloads.onUpdate(setList)
    return off
  }, [])
  return list
}
