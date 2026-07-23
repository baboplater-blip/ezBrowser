import { useEffect, useState } from 'react'
import { useChromeOverlay } from '../hooks/useChromeOverlay'

interface Item { id: number; message: string }

// 단조 증가 id — main 의 ts 를 쓰면 같은 ms 두 토스트가 키 충돌 + 첫 타이머가 둘 다 제거한다.
let toastSeq = 0

interface Props {
  windowId: string | null
}

export function Toast({ windowId }: Props) {
  const [items, setItems] = useState<Item[]>([])

  useEffect(() => {
    const off = window.browserAPI.toast.onShow(({ message }) => {
      const id = (toastSeq += 1)
      setItems((prev) => [...prev.slice(-3), { id, message }])
      setTimeout(() => {
        setItems((prev) => prev.filter((x) => x.id !== id))
      }, 2400)
    })
    return off
  }, [])

  // 토스트가 하나라도 표시 중이면 chrome 을 콘텐츠 위로 승격 — 그렇지 않으면 페이지에 완전히
  // 가려져 보이지 않는다(2.4초 후 자동 소멸이므로 승격도 그 사이에만 유지된다).
  useChromeOverlay(windowId, items.length > 0)

  if (items.length === 0) return null
  return (
    <div className="toast-stack">
      {items.map((it) => (
        <div key={it.id} className="toast">{it.message}</div>
      ))}
    </div>
  )
}
