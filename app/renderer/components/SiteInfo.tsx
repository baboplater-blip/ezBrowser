import { useEffect, useState } from 'react'
import type { TabSummary } from '../../shared/types'

interface Props {
  windowId: string
  open: boolean
  active: TabSummary | null
  anchor: { x: number; y: number }
  onClose: () => void
}

const PERMS = [
  { key: 'media', label: '카메라·마이크' },
  { key: 'geolocation', label: '위치' },
  { key: 'notifications', label: '알림' },
  { key: 'clipboard-read', label: '클립보드' },
] as const

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch { return null }
}
function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

export function SiteInfo({ windowId, open, active, anchor, onClose }: Props) {
  const url = active?.url ?? ''
  const origin = originOf(url)
  const [perms, setPerms] = useState<Record<string, 'allow' | 'deny'>>({})
  const [adblockOn, setAdblockOn] = useState(true)
  const [siteData, setSiteData] = useState<{ cookies: number; hasData: boolean } | null>(null)
  const [clearing, setClearing] = useState(false)
  const [cleared, setCleared] = useState(false)

  useEffect(() => {
    if (!open || !origin) return
    let cancelled = false
    setSiteData(null); setCleared(false); setClearing(false)
    void window.browserAPI.permissions.list().then((list) => {
      if (cancelled) return
      const hit = list.find((x) => x.origin === origin)
      setPerms(hit?.permissions ?? {})
    }).catch(() => setPerms({}))
    void window.browserAPI.sitedata.summary(origin).then((s) => {
      if (!cancelled) setSiteData(s)
    }).catch(() => { if (!cancelled) setSiteData({ cookies: 0, hasData: false }) })
    void window.browserAPI.settings.get('adblock').then((a) => {
      if (cancelled) return
      const ov = (a as { siteOverrides?: Record<string, boolean> })?.siteOverrides ?? {}
      const h = hostOf(url)
      const off = ov[h] === false || ov[`www.${h}`] === false
      setAdblockOn(!off)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [open, origin, url])

  if (!open) return null

  const secure = /^https:/i.test(url)
  const internal = !origin
  const style: React.CSSProperties = {
    top: Math.min(anchor.y + 4, window.innerHeight - 360),
    left: Math.min(anchor.x, window.innerWidth - 320),
  }

  const setPerm = (key: string, value: 'allow' | 'deny' | 'default') => {
    if (!origin) return
    void window.browserAPI.permissions.set(origin, key, value)
    setPerms((prev) => {
      const next = { ...prev }
      if (value === 'default') delete next[key]
      else next[key] = value
      return next
    })
  }

  const toggleAdblock = () => {
    void window.browserAPI.adblock.toggleSite(url).then((r) => setAdblockOn(!r.allowed))
  }

  const clearSiteData = () => {
    if (!origin || clearing) return
    setClearing(true)
    void window.browserAPI.sitedata.clear(origin)
      .then((ok) => {
        if (!ok) return
        setCleared(true)
        setSiteData({ cookies: 0, hasData: false })
        // 이미 로드된 페이지엔 메모리상 쿠키·스토리지가 남으므로 탭을 새로고침해 진짜 초기화 상태로.
        if (active?.id) void window.browserAPI.tabs.reload(active.id)
      })
      .finally(() => setClearing(false))
  }

  return (
    <div className="siteinfo-backdrop" onMouseDown={onClose}>
      <div className="siteinfo" style={style} onMouseDown={(e) => e.stopPropagation()}>
        <div className="si-head">
          <span className="si-lock">{internal ? '⚙' : secure ? '🔒' : '⚠'}</span>
          <div className="si-head-text">
            <div className="si-title">{internal ? '내부 페이지' : (secure ? '보안 연결' : '보안되지 않은 연결')}</div>
            <div className="si-origin">{internal ? (url || '—') : hostOf(url)}</div>
          </div>
        </div>

        {internal ? (
          <div className="si-empty">이 페이지에는 사이트 권한 설정이 없습니다.</div>
        ) : (
          <>
            <div className="si-section-title">권한</div>
            {PERMS.map((p) => (
              <div className="si-row" key={p.key}>
                <span className="si-row-label">{p.label}</span>
                <select
                  className="si-select"
                  value={perms[p.key] ?? 'default'}
                  onChange={(e) => setPerm(p.key, e.target.value as 'allow' | 'deny' | 'default')}
                >
                  <option value="default">기본</option>
                  <option value="allow">허용</option>
                  <option value="deny">차단</option>
                </select>
              </div>
            ))}
            <div className="si-row">
              <span className="si-row-label">이 사이트 광고 차단</span>
              <button className={`si-toggle ${adblockOn ? 'on' : ''}`} onClick={toggleAdblock} aria-pressed={adblockOn} />
            </div>

            <div className="si-section-title">사이트 데이터</div>
            <div className="si-row">
              <span className="si-row-label">
                {cleared ? '삭제됨' : siteData === null ? '확인 중…' : `쿠키 ${siteData.cookies}개`}
              </span>
              <button
                className="si-clear-btn"
                onClick={clearSiteData}
                disabled={clearing || cleared}
                title="이 사이트의 쿠키·로컬 저장소·캐시를 삭제합니다"
              >
                {clearing ? '삭제 중…' : cleared ? '✓ 완료' : '데이터 삭제'}
              </button>
            </div>
            <div className="si-hint">쿠키·로컬스토리지·IndexedDB·서비스워커·캐시를 모두 지우고 페이지를 새로고침합니다. 로그인이 풀릴 수 있습니다.</div>
          </>
        )}

        <div className="si-foot">
          <button className="si-link" onMouseDown={(e) => { e.preventDefault(); void window.browserAPI.tabs.create(windowId, 'browser://settings'); onClose() }}>
            사이트 권한 전체 관리 →
          </button>
        </div>
      </div>
    </div>
  )
}
