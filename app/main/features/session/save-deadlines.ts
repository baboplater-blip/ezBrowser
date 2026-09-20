/**
 * 세션 스냅샷 저장 기한 계산 — 순수 로직(타이머·파일·electron 없음)이라 단독으로 시험할 수 있다.
 *
 * 왜 두 갈래인가:
 *  - 구조 변경(탭 추가·삭제·이동·핀·페이지 이동)을 잃으면 **사용자가 열어 둔 것이 사라진다**.
 *  - 제목·파비콘·로딩 상태·창 크기는 잃어도 다음 저장에서 따라잡힌다.
 *
 * 예전에는 타이머가 하나뿐이었고 모든 이벤트가 그 타이머를 **다시 깔았다**. 페이지가 로딩되는 동안
 * 제목·파비콘이 5초보다 자주 바뀌면 방금 만든 탭의 1초 기한이 계속 5초 뒤로 밀려,
 * 30초 강제 저장이 올 때까지 그 탭이 디스크에 한 번도 닿지 않을 수 있었다.
 * 그 구간에 크래시가 나면 그 탭은 복원되지 않는다.
 *
 * 그래서 구조 변경의 기한은 **앞당겨질 수만 있고 뒤로 밀리지 않는다**.
 */
export class SaveDeadlines {
  private structuralAt: number | null = null
  private softAt: number | null = null

  /** 구조 변경 — 이미 잡힌 기한보다 늦게 잡지 않는다. */
  markStructural(now: number, delay: number): void {
    const due = now + delay
    this.structuralAt = this.structuralAt === null ? due : Math.min(this.structuralAt, due)
  }

  /** 잡음성 변경 — 마지막 것만 유효(합쳐도 되는 변경이라 매 이벤트마다 디스크를 쓰지 않는다). */
  markSoft(now: number, delay: number): void {
    this.softAt = now + delay
  }

  /** 다음에 저장해야 할 시각. 대기 중인 변경이 없으면 null. */
  nextDueAt(): number | null {
    const due = Math.min(this.structuralAt ?? Infinity, this.softAt ?? Infinity)
    return Number.isFinite(due) ? due : null
  }

  /**
   * **지금 도래한 기한만** 비운다. 아직 오지 않은 기한은 남긴다.
   *
   * 구조 변경의 이른 저장이 뒤따라올 "가라앉은 뒤의 저장" 을 잡아먹으면 안 된다.
   * 스크롤 위치·폼 값은 메인 프로세스에 이벤트를 발생시키지 않고, Chromium 이 그것을
   * 내비게이션 항목(pageState)에 반영하는 데도 몇 초가 걸린다. 탭 목록을 지키려고 1초 만에
   * 뜬 스냅샷은 그 값들이 아직 낡아 있으므로, **활동이 잦아든 뒤 한 번 더** 떠야 한다.
   * (2026-09-20: 이 구분을 빼먹어 스크롤·폼 복원이 회귀했다 — 하네스가 잡았다.)
   */
  consumeDue(now: number, slackMs = 50): void {
    if (this.structuralAt !== null && this.structuralAt <= now + slackMs) this.structuralAt = null
    if (this.softAt !== null && this.softAt <= now + slackMs) this.softAt = null
  }

  /** 아직 예약된 "가라앉은 뒤의 저장" 이 없으면 하나 잡는다. */
  ensureSoft(now: number, delay: number): void {
    if (this.softAt === null) this.softAt = now + delay
  }

  /** 구조 변경이 대기 중인가 (진단·시험용). */
  hasStructural(): boolean { return this.structuralAt !== null }

  /** 지금 뜨는 저장이 **구조 변경 때문**인가 — 뒤따르는 "가라앉은 뒤의 저장" 을 붙일지 정한다. */
  isStructuralDue(now: number, slackMs = 50): boolean {
    return this.structuralAt !== null && this.structuralAt <= now + slackMs
  }

  /** 저장을 마쳤거나 취소됐다 — 두 기한 모두 비운다. */
  clear(): void {
    this.structuralAt = null
    this.softAt = null
  }
}
