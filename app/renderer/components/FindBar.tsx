import { useEffect, useRef, useState } from 'react'

interface FindBarProps {
  open: boolean
  initialText: string
  tabId: string | undefined
  onClose: () => void
}

export function FindBar({ open, initialText, tabId, onClose }: FindBarProps) {
  const [text, setText] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [result, setResult] = useState<{ active: number; total: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const tabIdRef = useRef(tabId)
  tabIdRef.current = tabId

  // 매치 결과 수신
  useEffect(() => {
    const off = window.browserAPI.find.onResult((payload) => {
      if (payload.tabId !== tabIdRef.current) return
      setResult({ active: payload.activeMatchOrdinal, total: payload.matches })
    })
    return off
  }, [])

  // 열릴 때 초기 텍스트 세팅 + 포커스
  useEffect(() => {
    if (!open) return
    setText(initialText)
    setResult(null)
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 10)
    return () => clearTimeout(t)
  }, [open, initialText])

  // 텍스트/대소문자 변경 시 검색 (디바운스)
  useEffect(() => {
    if (!open || !tabId) return
    if (!text) {
      void window.browserAPI.find.stop(tabId)
      setResult(null)
      return
    }
    const h = setTimeout(() => {
      void window.browserAPI.find.start(tabId, text, { findNext: false, matchCase })
    }, 120)
    return () => clearTimeout(h)
  }, [text, matchCase, open, tabId])

  const step = (forward: boolean): void => {
    if (!tabId || !text) return
    void window.browserAPI.find.start(tabId, text, { forward, findNext: true, matchCase })
  }

  const close = (): void => {
    if (tabId) void window.browserAPI.find.stop(tabId)
    setText('')
    setResult(null)
    onClose()
  }

  if (!open) return null

  const countLabel = result
    ? (result.total > 0 ? `${result.active}/${result.total}` : '결과 없음')
    : (text ? '검색 중…' : '')

  return (
    <div className="findbar" role="search">
      <input
        ref={inputRef}
        className="findbar-input"
        value={text}
        placeholder="페이지에서 찾기"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(!e.shiftKey)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
        }}
      />
      <span className={`findbar-count${result && result.total === 0 ? ' findbar-count--none' : ''}`}>
        {countLabel}
      </span>
      <button
        className={`findbar-btn${matchCase ? ' findbar-btn--on' : ''}`}
        title="대소문자 구분"
        onClick={() => setMatchCase((v) => !v)}
      >Aa</button>
      <button className="findbar-btn" title="이전 (Shift+Enter)" onClick={() => step(false)} disabled={!text}>↑</button>
      <button className="findbar-btn" title="다음 (Enter)" onClick={() => step(true)} disabled={!text}>↓</button>
      <button className="findbar-btn" title="닫기 (Esc)" onClick={close}>✕</button>
    </div>
  )
}
