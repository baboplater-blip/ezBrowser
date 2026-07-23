import { useEffect, useState } from 'react'
import { useChromeOverlay } from '../hooks/useChromeOverlay'

interface Props {
  windowId: string | null
}

export function QrModal({ windowId }: Props) {
  const [url, setUrl] = useState<string | null>(null)
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  // 모달이 열려 있는 동안 chrome 을 콘텐츠 위로 승격 — 그렇지 않으면 페이지에 가려 보이지 않는다.
  useChromeOverlay(windowId, url !== null)

  useEffect(() => {
    const off = window.browserAPI.qrcode.onOpen(({ url: u }) => {
      setUrl(u); setDataUrl(null)
    })
    return off
  }, [])

  useEffect(() => {
    if (!url) return
    let cancelled = false
    void window.browserAPI.qrcode.generate(url, 280).then((d) => {
      if (!cancelled) setDataUrl(d)
    })
    return () => { cancelled = true }
  }, [url])

  useEffect(() => {
    if (!url) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setUrl(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [url])

  if (!url) return null

  return (
    <div className="qr-modal-backdrop" onClick={() => setUrl(null)}>
      <div className="qr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qr-modal-title">현재 페이지 QR 코드</div>
        <div className="qr-modal-body">
          {dataUrl ? (
            <img src={dataUrl} alt="QR" width={280} height={280} />
          ) : (
            <div className="qr-modal-loading">생성 중…</div>
          )}
        </div>
        <div className="qr-modal-url" title={url}>{url}</div>
        <div className="qr-modal-actions">
          <button className="btn" onClick={() => setUrl(null)}>닫기</button>
        </div>
      </div>
    </div>
  )
}
