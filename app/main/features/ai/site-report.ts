// 사이트 분석 보고서 브릿지 — "내가 이미 로그인한 사이트를 여러 페이지 훑어보고 분석 보고서를 작성"하는
// 에이전트 작업으로 변환한다. 에이전트는 사용자의 실제 탭(로그인 세션 공유)에서 돌므로 로그인된 사이트를
// 그대로 열람한다. 훼손 방지를 위해 "읽기 전용"(readOnly) 로 실행 — 입력·제출·구매·삭제 등은 하드 블록되고,
// 페이지마다 note 로 기록을 메인에 누적했다가 마지막에 report 로 마크다운 보고서를 완성한다.
// 참고: buildBlogTask(blog-publish.ts) 와 동일한 "순수 태스크 문자열 빌더" 패턴.

export interface SiteReportParams {
  url?: string      // 지정 시 먼저 그 URL 로 이동, 미지정 시 현재 탭에서 시작
  focus?: string    // 분석 관점(예: "요금제 비교", "내 주문 내역 요약"). 없으면 구조·핵심 중심
  depth?: number    // 최대로 살펴볼 페이지 수 (clamp 1~8, 기본 5)
}

// depth 를 사람이 읽는 안내로.
function depthPhrase(depth: number): string {
  if (depth <= 3) return `핵심 페이지 위주로 간단히(최대 ${depth}개 페이지)`
  if (depth >= 7) return `주요 페이지를 폭넓게 자세히(최대 ${depth}개 페이지)`
  return `주요 페이지를 훑어(최대 ${depth}개 페이지)`
}

export function buildSiteReportTask(p: SiteReportParams): { task: string; readOnly: true } {
  const depth = Math.max(1, Math.min(8, Math.round(p.depth ?? 5)))
  const focus = (p.focus ?? '').trim()
  const head: string[] = []
  head.push('현재 사이트를 훑어보고 분석 보고서를 마크다운으로 작성해 주세요. 이 사이트는 사용자가 이미 로그인해 둔 상태일 수 있으니, 로그인된 화면을 그대로 열람하며 조사합니다.')
  if (p.url && /^https?:/i.test(p.url)) {
    head.push(`먼저 ${p.url} 로 이동한 뒤 시작하세요. 로그인 화면이 뜨거나 접근이 막히면 ask 로 알려주세요.`)
  }

  const rules: string[] = [
    '',
    '# 진행 방법 (읽기 전용 — 절대 규칙)',
    '① 열람만 합니다. 입력·제출·구매·주문·결제·삭제·설정 변경·업로드는 절대 하지 마세요. 클릭은 "다른 페이지로 이동/메뉴 열기" 목적으로만 씁니다(버튼으로 무언가를 실행하지 말 것).',
    `② ${depthPhrase(depth)} 살펴봅니다. 이미 기록(note)한 페이지는 다시 방문하지 마세요.`,
    '③ 각 페이지에서: 필요하면 스크롤로 내용을 확인(최대 2회) → 그 페이지에서 "파악한 내용"을 note 로 기록합니다. note 는 구체적으로 — 수치·항목·이름·상태 등 실제 데이터를 마크다운으로 적으세요(추측 금지, 화면에 보이는 것만).',
    focus
      ? `④ 분석 관점: ${focus}. 이 관점에 맞는 정보를 우선 수집하세요.`
      : '④ 분석 관점: 사이트의 구조·핵심 내용·눈에 띄는 항목·특이사항 중심으로 수집하세요.',
    '⑤ 표(table) 대신 소제목과 불릿(-)으로 정리하세요(보고서 렌더가 표를 아직 지원하지 않습니다).',
    '⑥ 충분히 살펴봤으면 report 로 보고서를 완성하고 작업을 끝냅니다:',
    '   {"action":"report","title":"구체적인 보고서 제목","markdown":"## 개요\\n- 핵심 결론 3~6개 불릿"}',
    '   - title 은 사이트/주제가 드러나게 구체적으로. markdown 에는 개요와 핵심 결론(요약)만 적으면 됩니다 — 페이지별 상세는 그동안 기록한 note 가 자동으로 본문에 합쳐집니다.',
    '⑦ 로그인이 풀려 있거나 원하는 페이지에 접근할 수 없으면 report 대신 ask 로 상황을 알려주세요.',
    '',
    '반드시 note 로 페이지별 내용을 먼저 쌓은 뒤 report 로 끝내세요. note 없이 report 하면 빈 보고서가 됩니다.',
  ]

  return { task: [head.join('\n'), ...rules].join('\n'), readOnly: true }
}
