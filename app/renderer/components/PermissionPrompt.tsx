import { useEffect, useState } from 'react'
import { useChromeOverlay } from '../hooks/useChromeOverlay'
import { useI18nT } from '../i18n'

interface Prompt {
  promptId: string
  origin: string
  permission: string
  tabId: string
}

interface Props {
  windowId: string | null
}

const PERMISSION_LABEL: Record<string, string> = {
  media: '카메라·마이크 사용',
  geolocation: '위치 정보 사용',
  notifications: '알림 표시',
  'clipboard-read': '클립보드 읽기',
}

const PERMISSION_ICON: Record<string, string> = {
  media: '🎙',
  geolocation: '📍',
  notifications: '🔔',
  'clipboard-read': '📋',
}

export function PermissionPrompt({ windowId }: Props): JSX.Element | null {
  const tr = useI18nT()
  const [queue, setQueue] = useState<Prompt[]>([])
  const [remember, setRemember] = useState(true)

  useEffect(() => {
    const off = window.browserAPI.permissions.onPromptOpen((p) => {
      setQueue((q) => (q.some((x) => x.promptId === p.promptId) ? q : [...q, p]))
    })
    // 사용자가 답하기 전에 메인이 스스로 거부를 확정했을 때(60초 타임아웃·탭 소멸) —
    // 이게 없으면 이미 사라진 탭에 대한 말풍선이 화면에 영원히 남는다.
    const offClosed = window.browserAPI.permissions.onPromptClosed(({ promptId }) => {
      setQueue((q) => q.filter((x) => x.promptId !== promptId))
    })
    return () => { off(); offClosed() }
  }, [])

  // 대기 중인 프롬프트가 있는 동안 chrome 을 콘텐츠 위로 승격 — 그렇지 않으면 페이지에 가려 보이지 않는다.
  useChromeOverlay(windowId, queue.length > 0)

  const current = queue[0]
  if (!current) return null

  const respond = (allow: boolean): void => {
    void window.browserAPI.permissions.respondPrompt(current.promptId, allow, remember)
    setQueue((q) => q.slice(1))
    setRemember(true)
  }

  let host: string
  try {
    host = new URL(current.origin).host
  } catch {
    host = current.origin
  }

  const label = tr(`ui.permPrompt.perm.${current.permission}`, PERMISSION_LABEL[current.permission] ?? current.permission)
  const icon = PERMISSION_ICON[current.permission] ?? '🔒'

  return (
    <div className="perm-prompt">
      <div className="perm-prompt-body">
        <div className="perm-prompt-icon">{icon}</div>
        <div className="perm-prompt-text">
          <div className="perm-prompt-title">
            <span className="perm-prompt-host">{host}</span>{tr('ui.permPrompt.requestSuffix', '이(가) {label}을(를) 요청합니다', { label })}
          </div>
          <label className="perm-prompt-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            {tr('ui.permPrompt.remember', '이 선택 기억')}
          </label>
          {queue.length > 1 && <div className="perm-prompt-queue">{tr('ui.permPrompt.queueMore', '대기 중인 요청 {count}건 더', { count: queue.length - 1 })}</div>}
        </div>
      </div>
      <div className="perm-prompt-actions">
        <button type="button" className="perm-prompt-btn primary" onClick={() => respond(true)}>{tr('ui.permPrompt.allow', '허용')}</button>
        <button type="button" className="perm-prompt-btn" onClick={() => respond(false)}>{tr('ui.permPrompt.deny', '차단')}</button>
      </div>
    </div>
  )
}
