import { useEffect, useRef, useState } from 'react'
import { useI18nT } from '../i18n'

interface FindBarProps {
  open: boolean
  initialText: string
  tabId: string | undefined
  stepSignal?: { forward: boolean; nonce: number } | null
  onClose: () => void
}

export function FindBar({ open, initialText, tabId, stepSignal, onClose }: FindBarProps) {
  const tr = useI18nT()
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

  // F3/Shift+F3/Ctrl+G — 이미 검색어가 있을 때만 이동(없으면 조용히 무시, 찾기 바를 여는 것만으로 충분).
  const stepNonceRef = useRef<number>(0)
  useEffect(() => {
    if (!stepSignal || stepSignal.nonce === stepNonceRef.current) return
    stepNonceRef.current = stepSignal.nonce
    step(stepSignal.forward)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepSignal])

  const close = (): void => {
    if (tabId) void window.browserAPI.find.stop(tabId)
    setText('')
    setResult(null)
    onClose()
  }

  if (!open) return null

  const countLabel = result
    ? (result.total > 0 ? `${result.active}/${result.total}` : tr('ui.findBar.noResults', '결과 없음'))
    : (text ? tr('ui.findBar.searching', '검색 중…') : '')

  return (
    <div className="findbar" role="search">
      <input
        ref={inputRef}
        className="findbar-input"
        value={text}
        placeholder={tr('ui.findBar.placeholder', '페이지에서 찾기')}
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
        title={tr('ui.findBar.matchCase', '대소문자 구분')}
        onClick={() => setMatchCase((v) => !v)}
      >Aa</button>
      <button className="findbar-btn" title={tr('ui.findBar.prev', '이전 (Shift+Enter)')} onClick={() => step(false)} disabled={!text}>↑</button>
      <button className="findbar-btn" title={tr('ui.findBar.next', '다음 (Enter)')} onClick={() => step(true)} disabled={!text}>↓</button>
      <button className="findbar-btn" title={tr('ui.findBar.close', '닫기 (Esc)')} onClick={close}>✕</button>
    </div>
  )
}
