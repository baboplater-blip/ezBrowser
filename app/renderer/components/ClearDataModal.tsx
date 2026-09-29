import { useEffect, useState } from 'react'
import { useI18nT } from '../i18n'

interface Props {
  open: boolean
  onClose: () => void
}

const RANGES: Array<{ key: string; label: string; ms: number }> = [
  { key: 'lastHour', label: '지난 1시간', ms: 60 * 60 * 1000 },
  { key: 'last24h', label: '지난 24시간', ms: 24 * 60 * 60 * 1000 },
  { key: 'last7d', label: '지난 7일', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: 'last4w', label: '지난 4주', ms: 28 * 24 * 60 * 60 * 1000 },
  { key: 'allTime', label: '전체 기간', ms: 0 }, // 0 → 전체 삭제
]

export function ClearDataModal({ open, onClose }: Props) {
  const tr = useI18nT()
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
      <div className="cd-modal" role="dialog" aria-label={tr('ui.clearData.title', '방문 기록 삭제')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="cd-header">{tr('ui.clearData.title', '방문 기록 삭제')}</div>
        <div className="cd-body">
          {done ? (
            <div className="cd-done">{tr('ui.clearData.done', '✓ 방문 기록을 삭제했습니다.')}</div>
          ) : (
            <>
              <label className="cd-field">
                <span>{tr('ui.clearData.range', '기간')}</span>
                <select
                  value={rangeIdx}
                  onChange={(e) => setRangeIdx(Number(e.target.value))}
                  autoFocus
                >
                  {RANGES.map((r, i) => <option key={i} value={i}>{tr(`ui.clearData.ranges.${r.key}`, r.label)}</option>)}
                </select>
              </label>
              <p className="cd-note">{tr('ui.clearData.note', '선택한 기간의 방문 기록이 삭제됩니다. 되돌릴 수 없습니다.')}</p>
            </>
          )}
        </div>
        {!done && (
          <div className="cd-actions">
            <button onClick={onClose}>{tr('ui.clearData.cancel', '취소')}</button>
            <button className="primary" disabled={busy} onClick={() => void confirm()}>
              {busy ? tr('ui.clearData.clearing', '삭제 중…') : tr('ui.clearData.clear', '삭제')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
