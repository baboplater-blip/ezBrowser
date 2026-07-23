import { useEffect, useState } from 'react'
import { useDownloads } from '../hooks/useDownloads'
import type { DownloadItem } from '../../shared/types'

interface Props {
  open: boolean
  onClose: () => void
  width?: number
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatSpeed(n?: number): string {
  if (!n || !isFinite(n) || n <= 0) return ''
  return `${formatBytes(n)}/s`
}

function formatEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return ''
  if (sec < 60) return `${Math.round(sec)}초`
  if (sec < 3600) return `${Math.floor(sec / 60)}분 ${Math.round(sec % 60)}초`
  return `${Math.floor(sec / 3600)}시간 ${Math.round((sec % 3600) / 60)}분`
}

function stateLabel(state: DownloadItem['state']): string {
  switch (state) {
    case 'active': return '진행 중'
    case 'paused': return '일시정지'
    case 'metadata': return '메타데이터'
    case 'done': return '완료'
    case 'seeding': return '시드 중'
    case 'failed': return '실패'
    case 'cancelled': return '취소'
    case 'queued': return '대기'
    default: return state
  }
}

function kindBadge(kind: DownloadItem['kind']): string {
  switch (kind) {
    case 'torrent': return '🧲'
    case 'video': return '▶'
    case 'http':
    default: return '↓'
  }
}

interface MenuState { id: string; x: number; y: number }

type DownloadFilter = 'all' | 'active' | 'done' | 'failed'

const FILTERS: { key: DownloadFilter; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'active', label: '진행 중' },
  { key: 'done', label: '완료' },
  { key: 'failed', label: '실패' },
]

function matchesFilter(state: DownloadItem['state'], f: DownloadFilter): boolean {
  switch (f) {
    case 'active': return state === 'active' || state === 'paused' || state === 'metadata' || state === 'queued'
    case 'done': return state === 'done' || state === 'seeding'
    case 'failed': return state === 'failed' || state === 'cancelled'
    case 'all':
    default: return true
  }
}

function isFinished(state: DownloadItem['state']): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled'
}

function DownloadRow({ d, onMenu }: { d: DownloadItem; onMenu: (id: string, e: React.MouseEvent) => void }) {
  const [expanded, setExpanded] = useState(false)
  const pct = d.totalBytes > 0 ? Math.round((d.receivedBytes / d.totalBytes) * 100) : 0
  const isTorrent = d.kind === 'torrent'
  const isVideo = d.kind === 'video'
  const hasFiles = isTorrent && (d.torrent?.files.length ?? 0) > 1
  const eta = (d.state === 'active' && d.speed && d.speed > 0 && d.totalBytes > d.receivedBytes)
    ? (d.totalBytes - d.receivedBytes) / d.speed : 0

  return (
    <div className="download-item" onContextMenu={(e) => onMenu(d.id, e)}>
      <div className="dl-name" title={d.url}>
        <span className="dl-kind">{kindBadge(d.kind)}</span>
        {d.filename}
        {d.accelerator && (
          <span className="dl-accel-badge" title={`멀티 커넥션 ${d.accelerator.connections}개`}>⚡{d.accelerator.connections}</span>
        )}
      </div>
      <div className="dl-meta">
        <span className={`dl-state state-${d.state}`}>{stateLabel(d.state)}</span>
        <span>
          {formatBytes(d.receivedBytes)}
          {d.totalBytes > 0 && ` / ${formatBytes(d.totalBytes)}`}
          {d.totalBytes > 0 && pct > 0 && ` · ${pct}%`}
        </span>
        {d.speed && d.state === 'active' && <span>↓ {formatSpeed(d.speed)}</span>}
        {eta > 0 && <span>⏱ {formatEta(eta)} 남음</span>}
        {isTorrent && d.torrent && (
          <>
            <span>피어 {d.torrent.peers}</span>
            {d.torrent.uploadSpeed > 0 && <span>↑ {formatSpeed(d.torrent.uploadSpeed)}</span>}
            {d.torrent.ratio > 0 && <span>비율 {d.torrent.ratio.toFixed(2)}</span>}
          </>
        )}
      </div>
      {d.totalBytes > 0 && (d.state === 'active' || d.state === 'metadata' || d.state === 'paused') && (
        <div className={`dl-bar ${d.state === 'paused' ? 'paused' : ''}`}><div style={{ width: `${pct}%` }} /></div>
      )}
      {d.error && <div className="error" style={{ marginTop: 4 }}>{d.error}</div>}
      <div className="dl-actions">
        {/* 영상(HLS·yt-dlp)은 일시정지/재개 불가 — 취소만 */}
        {d.state === 'active' && !isVideo && (
          <button onClick={() => isTorrent
            ? window.browserAPI.torrent.pause(d.id)
            : window.browserAPI.downloads.pause(d.id)}>
            일시정지
          </button>
        )}
        {d.state === 'paused' && !isVideo && (
          <button onClick={() => isTorrent
            ? window.browserAPI.torrent.resume(d.id)
            : window.browserAPI.downloads.resume(d.id)}>
            재개
          </button>
        )}
        {(d.state === 'active' || d.state === 'paused' || d.state === 'metadata') && !isTorrent && (
          <button onClick={() => window.browserAPI.downloads.cancel(d.id)}>취소</button>
        )}
        {isTorrent && d.state !== 'failed' && d.state !== 'cancelled' && (
          <>
            <button onClick={() => window.browserAPI.torrent.remove(d.id, false)}>제거</button>
            <button onClick={() => window.browserAPI.torrent.remove(d.id, true)}>제거 + 파일 삭제</button>
          </>
        )}
        {(d.state === 'done' || d.state === 'seeding') && (
          <button onClick={() => window.browserAPI.downloads.openFolder(d.id)}>폴더 열기</button>
        )}
        {hasFiles && (
          <button onClick={() => setExpanded((e) => !e)}>
            {expanded ? '파일 숨기기' : `파일 (${d.torrent?.files.length ?? 0})`}
          </button>
        )}
      </div>
      {expanded && d.torrent?.files && (
        <ul className="torrent-files">
          {d.torrent.files.map((f, i) => (
            <li key={i}>
              <span className="tf-name" title={f.name}>{f.name}</span>
              <span className="tf-size">{formatBytes(f.length)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function DownloadContextMenu({ item, menu, onClose }: { item: DownloadItem; menu: MenuState; onClose: () => void }) {
  // 우클릭 메뉴는 우측 도크(320px) 영역 안으로 클램프해 콘텐츠 뷰에 가리지 않게 한다.
  const MENU_W = 194
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - MENU_W))
  const top = Math.min(menu.y, window.innerHeight - 220)
  const stop = (e: React.MouseEvent) => e.stopPropagation()
  const after = (fn: () => void) => () => { fn(); onClose() }

  const isTorrent = item.kind === 'torrent'
  const isHttp = item.kind === 'http'
  const isDone = item.state === 'done' || item.state === 'seeding'
  const isFailed = item.state === 'failed' || item.state === 'cancelled'
  const canRetry = isHttp && isFailed
  const canRemove = !isTorrent && (isDone || isFailed)

  return (
    <div className="tab-ctx" style={{ top, left }} onClick={stop} onContextMenu={(e) => e.preventDefault()}>
      {isDone && (
        <button className="tab-ctx-item" onClick={after(() => void window.browserAPI.downloads.openFile(item.id))}>
          📂 파일 열기
        </button>
      )}
      {canRetry && (
        <button className="tab-ctx-item" onClick={after(() => void window.browserAPI.downloads.retry(item.id))}>
          ↻ 다시 시도
        </button>
      )}
      <button className="tab-ctx-item" onClick={after(() => void window.browserAPI.downloads.openFolder(item.id))}>
        🗂 폴더에서 보기
      </button>
      <button className="tab-ctx-item" onClick={after(() => void window.browserAPI.downloads.copyPath(item.id))}>
        📋 경로 복사
      </button>
      {canRemove && (
        <>
          <div className="tab-ctx-sep" />
          <button className="tab-ctx-item danger" onClick={after(() => void window.browserAPI.downloads.remove(item.id))}>
            🗑 목록에서 제거
          </button>
        </>
      )}
    </div>
  )
}

export function DownloadsPanel({ open, onClose, width = 320 }: Props) {
  const items = useDownloads()
  const [magnet, setMagnet] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<DownloadFilter>('all')

  // 메뉴 열림 동안 바깥 클릭·스크롤·Esc 로 닫기
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  if (!open) return null

  async function addTorrentFromInput() {
    const v = magnet.trim()
    if (!v) return
    await window.browserAPI.torrent.add(v)
    setMagnet('')
  }

  const onMenu = (id: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ id, x: e.clientX, y: e.clientY })
  }

  const menuItem = menu ? items.find((d) => d.id === menu.id) : undefined

  const q = query.trim().toLowerCase()
  const visible = items.filter((d) =>
    matchesFilter(d.state, filter) &&
    (q === '' || d.filename.toLowerCase().includes(q) || d.url.toLowerCase().includes(q)),
  )
  const finishedCount = items.filter((d) => isFinished(d.state) && d.kind !== 'torrent').length

  return (
    <aside className="sidepanel sidepanel-right downloads-dock" style={{ width }}>
      <div className="sidepanel-header">
        <span>다운로드</span>
        <button className="icon-btn" onClick={onClose} aria-label="닫기" title="다운로드 사이드바 닫기">×</button>
      </div>
      <div className="sidepanel-body">
        <div className="torrent-add">
          <input
            placeholder="magnet:?xt=... 또는 .torrent URL"
            value={magnet}
            onChange={(e) => setMagnet(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addTorrentFromInput() }}
          />
          <button className="primary" onClick={() => void addTorrentFromInput()}>토렌트 추가</button>
        </div>
        {items.length > 0 && (
          <div className="dl-toolbar">
            <div className="dl-search">
              <input
                placeholder="파일명·URL 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button className="dl-search-clear" onClick={() => setQuery('')} aria-label="검색 지우기" title="검색 지우기">×</button>
              )}
            </div>
            <div className="dl-filters">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  className={`dl-chip ${filter === f.key ? 'active' : ''}`}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </button>
              ))}
              <button
                className="dl-chip dl-clear"
                disabled={finishedCount === 0}
                onClick={() => void window.browserAPI.downloads.clearFinished()}
                title="완료·실패·취소된 항목 모두 목록에서 제거"
              >
                완료 비우기{finishedCount > 0 ? ` (${finishedCount})` : ''}
              </button>
            </div>
          </div>
        )}
        {items.length === 0 && <div className="empty">받은 파일이 없습니다.</div>}
        {items.length > 0 && visible.length === 0 && <div className="empty">검색 결과가 없습니다.</div>}
        {visible.map((d) => <DownloadRow key={d.id} d={d} onMenu={onMenu} />)}
      </div>
      {menu && menuItem && (
        <DownloadContextMenu item={menuItem} menu={menu} onClose={() => setMenu(null)} />
      )}
    </aside>
  )
}
