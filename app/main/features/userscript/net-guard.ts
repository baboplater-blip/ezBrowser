// 사설망/로컬 접근 차단 — @require/@resource 다운로드와 GM_xmlhttpRequest 양쪽에서 쓰는 SSRF 방어.
//
// mod-api(app/main/features/mod-api/index.ts) 의 net.fetch 가드와 판정 로직이 동일하다.
// 그 파일은 다른 묶음 소유라 import 하지 않고(소유 경계 존중) 여기서 독립적으로 유지한다 —
// 두 모듈은 서로 다른 위협 모델(mod 는 완전 신뢰 escape hatch 옵션이 있고, userscript 는 없다)
// 이라 향후 정책이 갈라질 수 있어 애초에 공유하지 않는 편이 안전하다.

import dns from 'node:dns'

function dnsLookup(hostname: string): Promise<{ address: string }> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, (err, address) => {
      if (err) reject(err)
      else resolve({ address })
    })
  })
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  if (a === 127) return true // loopback
  if (a === 10) return true // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 169 && b === 254) return true // link-local
  if (a === 0) return true // 0.0.0.0/8
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const low = ip.toLowerCase()
  if (low === '::1' || low === '::') return true
  if (low.startsWith('fe80:')) return true // link-local
  const first = low.split(':')[0] ?? ''
  if (/^f[cd][0-9a-f]{2}$/.test(first)) return true // fc00::/7 unique local
  return false
}

function isPrivateHostLiteral(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '0.0.0.0') return true
  if (h.endsWith('.localhost')) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIPv4(h)
  if (h.includes(':')) return isPrivateIPv6(h)
  return false
}

/**
 * 호스트명이 사설망/로컬 주소를 가리키는지 확인한다. IP 리터럴은 즉시 판정하고,
 * 도메인명은 DNS 조회 결과로 한 번 더 판정한다(공인 도메인이 내부 IP 로 리졸브되는 우회 차단).
 *
 * 한계(DNS 리바인딩): 이 조회와 실제 연결 사이에 DNS 응답이 바뀌면(TTL=0 공격 등) 우회 가능 —
 * net.request 는 연결 직전 IP 를 검사하는 훅을 제공하지 않는다. 조회 실패 시엔 가용성을 우선해
 * 통과시킨다(완전히 막히는 것보다 낫다는 판단 — mod-api 와 동일 트레이드오프).
 */
export async function isPrivateHostResolved(hostname: string): Promise<boolean> {
  if (isPrivateHostLiteral(hostname)) return true
  try {
    const { address } = await dnsLookup(hostname)
    return isPrivateHostLiteral(address)
  } catch {
    return false
  }
}

/**
 * @require/@resource(설치 시 1회 다운로드) 전용 판정 — 오직 **DNS 리바인딩**(공인처럼 보이는
 * 도메인이 몰래 사설 IP 로 풀리는 경우)만 막고, **리터럴 사설 IP/localhost 는 막지 않는다**.
 *
 * gmxhr(런타임, 페이지가 트리거)와 다른 이유: @require URL 은 스크립트 소스에 그대로 적혀
 * 있어 사용자가 저장 화면에서 코드를 보면 무엇을 받는지 훤히 드러난다 — 숨겨진 게 아니다.
 * `@require https://192.168.1.5/lib.js` 처럼 저자가 명시한 사설 IP 는 인트라넷 자동화
 * 스크립트의 정당한 쓰임(사내 라이브러리 등)이라 막을 이유가 없다. 반대로 겉보기엔 공인
 * 도메인인데 실제로는 사설 IP 로 풀리는 경우(숨겨져 있어 코드 읽기로는 못 알아챈다)는 여전히 막는다.
 */
export async function isSneakyPrivateHost(hostname: string): Promise<boolean> {
  if (isPrivateHostLiteral(hostname)) return false // 리터럴은 투명하다 — 허용
  try {
    const { address } = await dnsLookup(hostname)
    return isPrivateHostLiteral(address)
  } catch {
    return false
  }
}
