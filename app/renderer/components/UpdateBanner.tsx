import { useEffect, useState } from 'react'
import { useChromeOverlay } from '../hooks/useChromeOverlay'

type UpdateState =
  | 'idle' | 'checking' | 'available' | 'not-available'
  | 'downloading' | 'downloaded' | 'error' | 'disabled'

interface UpdateStatus {
  state: UpdateState
  current: string
  available?: string
  progress?: number
  error?: string
}

const BANNER_DISMISSED_KEY = 'browserbuild.updateBannerDismissedFor'

interface Props {
  windowId: string | null
}

export function UpdateBanner({ windowId }: Props) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [dismissedFor, setDismissedFor] = useState<string>(() => {
    try { return localStorage.getItem(BANNER_DISMISSED_KEY) ?? '' } catch { return '' }
  })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await window.browserAPI.update.status()
        if (!cancelled) setStatus(s as UpdateStatus)
      } catch { /* ignore */ }
    })()
    const off = window.browserAPI.update.onStatus((s) => setStatus(s as UpdateStatus))
    return () => { cancelled = true; off() }
  }, [])

  // fixed 배너(우하단, 콘텐츠 영역 위) — 표시되는 동안만 chrome 을 승격한다.
  const isShown = status != null
    && (status.state === 'available' || status.state === 'downloading' || status.state === 'downloaded')
    && !(status.available && dismissedFor === status.available && status.state !== 'downloaded')
  useChromeOverlay(windowId, isShown)

  if (!status || !isShown) return null

  const dismiss = () => {
    if (status.available) {
      try { localStorage.setItem(BANNER_DISMISSED_KEY, status.available) } catch { /* ignore */ }
      setDismissedFor(status.available)
    }
  }

  return (
    <div className="update-banner" role="status">
      <div className="update-banner-icon">⤴</div>
      <div className="update-banner-text">
        {status.state === 'available' && (
          <>새 버전 <b>{status.available}</b> 사용 가능 (현재 v{status.current})</>
        )}
        {status.state === 'downloading' && (
          <>업데이트 다운로드 중… {status.progress != null ? `${Math.round(status.progress * 100)}%` : ''}</>
        )}
        {status.state === 'downloaded' && (
          <>업데이트 <b>{status.available}</b> 준비 완료 — 재시작 시 적용됩니다</>
        )}
      </div>
      <div className="update-banner-actions">
        {status.state === 'available' && (
          <button className="ub-btn primary" onClick={() => window.browserAPI.update.download()}>
            다운로드
          </button>
        )}
        {status.state === 'downloaded' && (
          <button className="ub-btn primary" onClick={() => window.browserAPI.update.install()}>
            재시작 후 설치
          </button>
        )}
        <button className="ub-btn" onClick={dismiss} aria-label="알림 닫기">✕</button>
      </div>
    </div>
  )
}
