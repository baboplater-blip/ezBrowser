import { useEffect, useState } from 'react'
import { useDownloads } from '../hooks/useDownloads'
import type { DownloadItem } from '../../shared/types'
import { useI18nT } from '../i18n'

type TFn = (key: string, fallback?: string, vars?: Record<string, string | number>) => string

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

function formatEta(sec: number, tr: TFn): string {
  if (!isFinite(sec) || sec <= 0) return ''
  if (sec < 60) return tr('ui.downloads.eta.seconds', '{n}초', { n: Math.round(sec) })
  if (sec < 3600) return tr('ui.downloads.eta.minutesSeconds', '{m}분 {s}초', { m: Math.floor(sec / 60), s: Math.round(sec % 60) })
  return tr('ui.downloads.eta.hoursMinutes', '{h}시간 {m}분', { h: Math.floor(sec / 3600), m: Math.round((sec % 3600) / 60) })
}

function stateLabel(state: DownloadItem['state'], tr: TFn): string {
  switch (state) {
    case 'active': return tr('ui.downloads.state.active', '진행 중')
    case 'paused': return tr('ui.downloads.state.paused', '일시정지')
    case 'metadata': return tr('ui.downloads.state.metadata', '메타데이터')
    case 'done': return tr('ui.downloads.state.done', '완료')
    case 'seeding': return tr('ui.downloads.state.seeding', '시드 중')
    case 'failed': return tr('ui.downloads.state.failed', '실패')
    case 'cancelled': return tr('ui.downloads.state.cancelled', '취소')
    case 'queued': return tr('ui.downloads.state.queued', '대기')
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
  const tr = useI18nT()
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
          <span className="dl-accel-badge" title={tr('ui.downloads.accelBadge', '멀티 커넥션 {count}개', { count: d.accelerator.connections })}>⚡{d.accelerator.connections}</span>
        )}
      </div>
      <div className="dl-meta">
        <span className={`dl-state state-${d.state}`}>{stateLabel(d.state, tr)}</span>
        <span>
          {formatBytes(d.receivedBytes)}
          {d.totalBytes > 0 && ` / ${formatBytes(d.totalBytes)}`}
          {d.totalBytes > 0 && pct > 0 && ` · ${pct}%`}
        </span>
        {d.speed && d.state === 'active' && <span>↓ {formatSpeed(d.speed)}</span>}
        {eta > 0 && <span>{tr('ui.downloads.etaSuffix', '⏱ {eta} 남음', { eta: formatEta(eta, tr) })}</span>}
        {isTorrent && d.torrent && (
          <>
            <span>{tr('ui.downloads.peers', '피어 {n}', { n: d.torrent.peers })}</span>
            {d.torrent.uploadSpeed > 0 && <span>↑ {formatSpeed(d.torrent.uploadSpeed)}</span>}
            {d.torrent.ratio > 0 && <span>{tr('ui.downloads.ratio', '비율 {n}', { n: d.torrent.ratio.toFixed(2) })}</span>}
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
            {tr('ui.downloads.pause', '일시정지')}
          </button>
        )}
        {d.state === 'paused' && !isVideo && (
          <button onClick={() => isTorrent
            ? window.browserAPI.torrent.resume(d.id)
            : window.browserAPI.downloads.resume(d.id)}>
            {tr('ui.downloads.resume', '재개')}
          </button>
        )}
        {(d.state === 'active' || d.state === 'paused' || d.state === 'metadata') && !isTorrent && (
          <button onClick={() => window.browserAPI.downloads.cancel(d.id)}>{tr('ui.downloads.cancel', '취소')}</button>
        )}
        {isTorrent && d.state !== 'failed' && d.state !== 'cancelled' && (
          <>
            <button onClick={() => window.browserAPI.torrent.remove(d.id, false)}>{tr('ui.downloads.remove', '제거')}</button>
            <button onClick={() => window.browserAPI.torrent.remove(d.id, true)}>{tr('ui.downloads.removeWithFiles', '제거 + 파일 삭제')}</button>
          </>
        )}
        {(d.state === 'done' || d.state === 'seeding') && (
          <button onClick={() => window.browserAPI.downloads.openFolder(d.id)}>{tr('ui.downloads.openFolder', '폴더 열기')}</button>
        )}
        {hasFiles && (
          <button onClick={() => setExpanded((e) => !e)}>
            {expanded ? tr('ui.downloads.hideFiles', '파일 숨기기') : tr('ui.downloads.showFiles', '파일 ({count})', { count: d.torrent?.files.length ?? 0 })}
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
  const tr = useI18nT()
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
          {tr('ui.downloads.ctx.openFile', '📂 파일 열기')}
        </button>
      )}
      {canRetry && (
        <button className="tab-ctx-item" onClick={after(() => void window.browserAPI.downloads.retry(item.id))}>
          {tr('ui.downloads.ctx.retry', '↻ 다시 시도')}
        </button>
      )}
      <button className="tab-ctx-item" onClick={after(() => void window.browserAPI.downloads.openFolder(item.id))}>
        {tr('ui.downloads.ctx.showInFolder', '🗂 폴더에서 보기')}
      </button>
      <button className="tab-ctx-item" onClick={after(() => void window.browserAPI.downloads.copyPath(item.id))}>
        {tr('ui.downloads.ctx.copyPath', '📋 경로 복사')}
      </button>
      {canRemove && (
        <>
          <div className="tab-ctx-sep" />
          <button className="tab-ctx-item danger" onClick={after(() => void window.browserAPI.downloads.remove(item.id))}>
            {tr('ui.downloads.ctx.removeFromList', '🗑 목록에서 제거')}
          </button>
        </>
      )}
    </div>
  )
}

export function DownloadsPanel({ open, onClose, width = 320 }: Props) {
  const tr = useI18nT()
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
        <span>{tr('ui.downloads.header', '다운로드')}</span>
        <button className="icon-btn" onClick={onClose} aria-label={tr('ui.downloads.closeAria', '닫기')} title={tr('ui.downloads.closeTitle', '다운로드 사이드바 닫기')}>×</button>
      </div>
      <div className="sidepanel-body">
        <div className="torrent-add">
          <input
            placeholder={tr('ui.downloads.addPlaceholder', 'magnet:?xt=... 또는 .torrent URL')}
            value={magnet}
            onChange={(e) => setMagnet(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addTorrentFromInput() }}
          />
          <button className="primary" onClick={() => void addTorrentFromInput()}>{tr('ui.downloads.addTorrent', '토렌트 추가')}</button>
        </div>
        {items.length > 0 && (
          <div className="dl-toolbar">
            <div className="dl-search">
              <input
                placeholder={tr('ui.downloads.searchPlaceholder', '파일명·URL 검색')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button className="dl-search-clear" onClick={() => setQuery('')} aria-label={tr('ui.downloads.searchClearAria', '검색 지우기')} title={tr('ui.downloads.searchClearAria', '검색 지우기')}>×</button>
              )}
            </div>
            <div className="dl-filters">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  className={`dl-chip ${filter === f.key ? 'active' : ''}`}
                  onClick={() => setFilter(f.key)}
                >
                  {tr(`ui.downloads.filter.${f.key}`, f.label)}
                </button>
              ))}
              <button
                className="dl-chip dl-clear"
                disabled={finishedCount === 0}
                onClick={() => void window.browserAPI.downloads.clearFinished()}
                title={tr('ui.downloads.clearFinishedTitle', '완료·실패·취소된 항목 모두 목록에서 제거')}
              >
                {tr('ui.downloads.clearFinished', '완료 비우기')}{finishedCount > 0 ? ` (${finishedCount})` : ''}
              </button>
            </div>
          </div>
        )}
        {items.length === 0 && <div className="empty">{tr('ui.downloads.emptyNone', '받은 파일이 없습니다.')}</div>}
        {items.length > 0 && visible.length === 0 && <div className="empty">{tr('ui.downloads.emptyFiltered', '검색 결과가 없습니다.')}</div>}
        {visible.map((d) => <DownloadRow key={d.id} d={d} onMenu={onMenu} />)}
      </div>
      {menu && menuItem && (
        <DownloadContextMenu item={menuItem} menu={menu} onClose={() => setMenu(null)} />
      )}
    </aside>
  )
}
