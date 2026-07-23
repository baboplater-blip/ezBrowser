import { session, type Session } from 'electron'
import { forEachInstalledSession } from '../../session-bootstrap'

// 쿠키는 도메인 스코프라 clearStorageData(origin) 로 안 지워질 수 있어 개별 제거한다.
// 그 외 저장소는 origin 스코프로 일괄 삭제.
const ORIGIN_STORAGES = [
  'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage', 'filesystem', 'shadercache',
] as const

export interface SiteDataSummary {
  cookies: number
  hasData: boolean
}

/** defaultSession + 설치된 모든 파티션 세션(중복 제거). */
function allSessions(): Session[] {
  const list: Session[] = [session.defaultSession]
  forEachInstalledSession((s) => { if (!list.includes(s)) list.push(s) })
  return list
}

/** origin 으로 전송될 쿠키 수를 모든 세션에서 합산. */
export async function getSiteDataSummary(origin: string): Promise<SiteDataSummary> {
  let cookies = 0
  for (const ses of allSessions()) {
    try {
      const cs = await ses.cookies.get({ url: `${origin}/` })
      cookies += cs.length
    } catch { /* 세션 접근 실패 무시 */ }
  }
  return { cookies, hasData: cookies > 0 }
}

/** 한 사이트(origin)의 쿠키 + 로컬/세션 스토리지·IndexedDB·SW·캐시를 모든 세션에서 삭제. */
export async function clearSiteData(origin: string): Promise<void> {
  const scheme = origin.startsWith('https') ? 'https' : 'http'
  for (const ses of allSessions()) {
    // 쿠키 — 도메인·경로 기준 URL 을 만들어 개별 제거
    try {
      const cs = await ses.cookies.get({ url: `${origin}/` })
      for (const c of cs) {
        const host = (c.domain ?? '').replace(/^\./, '')
        if (!host) continue
        const cookieUrl = `${c.secure ? 'https' : scheme}://${host}${c.path || '/'}`
        try { await ses.cookies.remove(cookieUrl, c.name) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    // 그 외 저장소 — origin 스코프
    try {
      await ses.clearStorageData({ origin, storages: [...ORIGIN_STORAGES] })
    } catch { /* ignore */ }
  }
}
