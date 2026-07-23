import { useEffect, useState } from 'react'
import { useChromeOverlay } from '../hooks/useChromeOverlay'

interface Prompt {
  promptId: string
  origin: string
  username: string
  isUpdate: boolean
}

interface Props {
  windowId: string | null
}

export function PasswordSavePrompt({ windowId }: Props): JSX.Element | null {
  const [queue, setQueue] = useState<Prompt[]>([])

  useEffect(() => {
    const offOpen = window.browserAPI.password.onPromptOpen((p) => {
      setQueue((q) => q.some((x) => x.promptId === p.promptId) ? q : [...q, p])
    })
    const offResolved = window.browserAPI.password.onPromptResolved(({ promptId }) => {
      setQueue((q) => q.filter((x) => x.promptId !== promptId))
    })
    return () => { offOpen(); offResolved() }
  }, [])

  // 대기 중인 프롬프트가 있는 동안 chrome 을 콘텐츠 위로 승격 — 그렇지 않으면 페이지에 가려 보이지 않는다.
  useChromeOverlay(windowId, queue.length > 0)

  const current = queue[0]
  if (!current) return null

  const handle = (action: 'save' | 'discard' | 'never') => {
    void window.browserAPI.password.confirmSave(current.promptId, action)
    setQueue((q) => q.slice(1))
  }

  let originLabel: string
  try {
    originLabel = new URL(current.origin).host
  } catch {
    originLabel = current.origin
  }

  return (
    <div className="pw-prompt">
      <div className="pw-prompt-body">
        <div className="pw-prompt-icon">🔐</div>
        <div className="pw-prompt-text">
          <div className="pw-prompt-title">
            {current.isUpdate ? '비밀번호를 업데이트할까요?' : '비밀번호를 저장할까요?'}
          </div>
          <div className="pw-prompt-meta">
            <span className="pw-prompt-origin">{originLabel}</span>
            <span className="pw-prompt-sep">·</span>
            <span className="pw-prompt-user">{current.username}</span>
          </div>
        </div>
        <div className="pw-prompt-actions">
          <button className="pw-prompt-btn primary" onClick={() => handle('save')}>
            {current.isUpdate ? '업데이트' : '저장'}
          </button>
          <button className="pw-prompt-btn" onClick={() => handle('discard')}>이번엔 안 함</button>
          <button className="pw-prompt-btn ghost" onClick={() => handle('never')}>이 사이트는 안 함</button>
        </div>
      </div>
      {queue.length > 1 && (
        <div className="pw-prompt-queue">대기 {queue.length - 1}건 더 있음</div>
      )}
    </div>
  )
}
