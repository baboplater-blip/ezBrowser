import type { MediaCandidate } from '../../shared/types'

interface Props {
  open: boolean
  candidates: MediaCandidate[]
  onClose: () => void
  width?: number
}

const KIND_LABEL: Record<MediaCandidate['kind'], string> = {
  hls: 'HLS', dash: 'DASH', mp4: 'MP4', video: '비디오', site: '사이트',
}

function formatBytes(n?: number): string {
  if (!n) return ''
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop() ?? ''
    return `${u.hostname}${last ? ' · ' + last : ''}`
  } catch { return url.slice(0, 60) }
}

export function VideoCandidatePanel({ open, candidates, onClose, width = 320 }: Props) {
  if (!open) return null

  async function download(c: MediaCandidate) {
    const result = await window.browserAPI.video.download(c)
    if (!result.ok) {
      alert('동영상 다운로드 시작 실패 — yt-dlp 설치를 거절했거나 오류가 났습니다.')
    }
    // 다운로드가 시작되면 메인이 다운로드 사이드바를 자동으로 엽니다(panel:open downloads).
  }

  return (
    <aside className="sidepanel sidepanel-right video-dock" style={{ width }}>
      <div className="sidepanel-header">
        <span>감지된 동영상 ({candidates.length})</span>
        <button className="icon-btn" onClick={onClose} aria-label="닫기" title="동영상 사이드바 닫기">×</button>
      </div>
      <div className="sidepanel-body video-dock-body">
        {candidates.length === 0 && <div className="empty">감지된 동영상이 없습니다.</div>}
        {candidates.map((c) => (
          <button
            key={c.url}
            className="video-candidate"
            onClick={() => download(c)}
            title={c.url}
          >
            <span className={`vc-kind k-${c.kind}`}>{KIND_LABEL[c.kind]}</span>
            <span className="vc-text">{shortUrl(c.url)}</span>
            {c.sizeBytes && <span className="vc-size">{formatBytes(c.sizeBytes)}</span>}
          </button>
        ))}
        <div className="video-popover-hint">
          HLS/DASH/사이트 후보는 yt-dlp 가 자동 처리합니다 (첫 사용 시 동의 후 약 15MB 받음).
        </div>
      </div>
    </aside>
  )
}
