import type { PageObservation } from './page-actions'

// ===== 로그인 / CAPTCHA 화면 감지 → 사람에게 넘기기 =====
//
// 왜: 이런 화면 앞에서 에이전트는 **원리적으로** 할 수 있는 게 없다. 예전에는 그걸 모르고 같은 화면을
// 계속 관찰하며 단계·시간·모델 호출 예산을 다 태운 뒤에야 "막힘 감지(같은 동작 3회 반복)" 로 겨우
// 사용자에게 물었다. 이제 **보자마자** 넘긴다 — 상태 `waiting-user`, 사유 명시, 사용자가 직접 처리한 뒤 재개.
//
// 절대 하지 않는 것(정책):
//   · CAPTCHA 를 풀거나 우회하지 않는다. 솔버 서비스·자동 클릭·오디오 우회 — 전부 없다. 여기서 하는 일은
//     "사람이 해야 하는 화면임을 알아보고 멈추는 것" 뿐이다.
//   · 비밀번호를 모델에게 묻거나 대신 입력하지 않는다(사용자가 직접 로그인한다).
//
// 오탐을 막는 규칙(중요): **본문에 '로그인'·'verify'·'인증' 같은 단어가 있다는 이유만으로는 절대 멈추지 않는다.**
// 안내 문서·약관·고객센터 페이지에는 그런 단어가 흔하다. 판단 근거는 **구조적 신호**여야 한다 —
// 보이는 password 입력칸, 실제 CAPTCHA 위젯/프레임. 문구는 "본문이 아주 짧은 차단 간지(interstitial)"
// 라는 구조적 조건과 함께일 때만 보조 근거로 쓴다.

export type ChallengeKind = 'captcha' | 'login'

export interface ChallengeVerdict {
  kind: ChallengeKind
  /** 사용자에게 보일 사유 */
  reason: string
  /** 무엇을 보고 판단했는가(트레이스·디버깅용) */
  evidence: string
  /** 같은 화면에서 반복 발동하지 않도록 쓰는 키 */
  key: string
  /** 프레임 안에서 발견됐다면 그 호스트 */
  frameHost?: string
}

// 관찰 스크립트가 페이지에서 직접 채워 주는 신호(page-actions.ts OBSERVE_SCRIPT 참고).
export interface ChallengeSignal {
  kind: ChallengeKind
  marker: string
}

function urlKey(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch { return String(url ?? '') }
}

/**
 * 관찰 결과에서 로그인/CAPTCHA 화면을 판정한다. 해당 없으면 null.
 *
 * @param resolved 사용자가 이미 처리했다고 알려 준 화면들의 키(`kind:origin+path`). 같은 화면에서
 *                 계속 다시 묻지 않기 위한 것 — 사용자가 "계속" 이라고 하면 호출부가 여기에 넣는다.
 */
export function detectChallenge(
  obs: Pick<PageObservation, 'url' | 'elements' | 'text' | 'challenge' | 'frames'>,
  resolved?: ReadonlySet<string>,
): ChallengeVerdict | null {
  const candidates: Array<{ sig: ChallengeSignal; frameHost?: string }> = []
  if (obs.challenge) candidates.push({ sig: obs.challenge })
  for (const f of obs.frames ?? []) {
    if (f.challenge) candidates.push({ sig: f.challenge, frameHost: f.host })
  }
  if (candidates.length === 0) return null
  // CAPTCHA 를 로그인보다 먼저 — 로그인 화면 위에 CAPTCHA 가 함께 있으면 더 막힌 쪽을 말해 준다.
  candidates.sort((a, b) => (a.sig.kind === 'captcha' ? -1 : 0) - (b.sig.kind === 'captcha' ? -1 : 0))
  for (const c of candidates) {
    const key = `${c.sig.kind}:${urlKey(obs.url)}${c.frameHost ? `@${c.frameHost}` : ''}`
    if (resolved?.has(key)) continue
    const where = c.frameHost ? ` (프레임 ${c.frameHost})` : ''
    if (c.sig.kind === 'captcha') {
      return {
        kind: 'captcha',
        key,
        frameHost: c.frameHost,
        reason: `사람 확인(CAPTCHA) 화면입니다${where}. 자동으로 풀지 않습니다 — 브라우저 창에서 직접 완료해 주신 뒤 "계속" 이라고 알려주세요.`,
        evidence: c.sig.marker,
      }
    }
    return {
      kind: 'login',
      key,
      frameHost: c.frameHost,
      reason: `로그인이 필요한 화면입니다${where}. 비밀번호는 대신 입력하지 않습니다 — 브라우저 창에서 직접 로그인하신 뒤 "계속" 이라고 알려주세요.`,
      evidence: c.sig.marker,
    }
  }
  return null
}

/** 해당 화면을 "사용자가 처리했다" 로 표시할 때 쓰는 키 — detectChallenge 의 key 와 같은 규칙. */
export function challengeKey(kind: ChallengeKind, url: string, frameHost?: string): string {
  return `${kind}:${urlKey(url)}${frameHost ? `@${frameHost}` : ''}`
}
