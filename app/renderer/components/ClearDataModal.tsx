import { useEffect, useState } from 'react'

interface Props {
  open: boolean
  onClose: () => void
}

const RANGES: Array<{ label: string; ms: number }> = [
  { label: '지난 1시간', ms: 60 * 60 * 1000 },
  { label: '지난 24시간', ms: 24 * 60 * 60 * 1000 },
  { label: '지난 7일', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '지난 4주', ms: 28 * 24 * 60 * 60 * 1000 },
  { label: '전체 기간', ms: 0 }, // 0 → 전체 삭제
]

export function ClearDataModal({ open, onClose }: Props) {
  const [rangeIdx, setRangeIdx] = useState(1) // 기본: 지난 24시간
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (open) { setDone(false); setBusy(false) }
  }, [open])

  if (!open) return null

  async function confirm() {
    const range = RANGES[rangeIdx]
    if (!range) return
    setBusy(true)
    try {
      await window.browserAPI.history.clear(range.ms > 0 ? { sinceMs: range.ms } : {})
      setDone(true)
      setTimeout(onClose, 900)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cd-backdrop" onMouseDown={onClose}>
      <div className="cd-modal" role="dialog" aria-label="방문 기록 삭제" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cd-header">방문 기록 삭제</div>
        <div className="cd-body">
          {done ? (
            <div className="cd-done">✓ 방문 기록을 삭제했습니다.</div>
          ) : (
            <>
              <label className="cd-field">
                <span>기간</span>
                <select
                  value={rangeIdx}
                  onChange={(e) => setRangeIdx(Number(e.target.value))}
                  autoFocus
                >
                  {RANGES.map((r, i) => <option key={i} value={i}>{r.label}</option>)}
                </select>
              </label>
              <p className="cd-note">선택한 기간의 방문 기록이 삭제됩니다. 되돌릴 수 없습니다.</p>
            </>
          )}
        </div>
        {!done && (
          <div className="cd-actions">
            <button onClick={onClose}>취소</button>
            <button className="primary" disabled={busy} onClick={() => void confirm()}>
              {busy ? '삭제 중…' : '삭제'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
