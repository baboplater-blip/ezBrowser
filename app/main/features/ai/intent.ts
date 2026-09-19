// intent.ts — 에이전트 입력창에 사용자가 직접 친 한 줄을 읽어, 이미 있는 생산 워크플로
// (생성→캡션→게시 / 관심 블로그 댓글·좋아요)의 **폼을 미리 채워 주는** 순수 판독기.
//
// 이 모듈의 존재 이유이자 경계 (2026-09-19):
//   1. **권한을 만들지 않는다.** 여기서 나오는 것은 제안된 필드값뿐이다. 실제 게시 권한은
//      오직 `social-workflow.grantAutoPublish`(사용자가 직접 켜는 토글)만이 만든다.
//      반환 객체에 grant·승인·토큰 류 필드를 절대 넣지 마라 — 검사(I8)가 이를 감시한다.
//   2. **신뢰 입력은 사용자가 타이핑한 원문 한 덩어리뿐이다.** 웹페이지 본문·모델 출력·
//      인용문은 입력이 아니다. 그래서 길이 상한·인용문 제거·전달문 거부 가드를 둔다.
//   3. **순수 함수다.** 파일·네트워크·작업 시작 어느 것도 하지 않는다. 그래서 앱을 띄우지 않고
//      `build/verify-intent-routing.mjs` 가 결정론으로 검사할 수 있다.
//
// 판단이 애매하면 항상 `null`(라우팅 안 함 → 평범한 에이전트로 감)이다. 키워드 하나로
// 쓰기 동작을 제안하는 쪽보다, 카드를 못 띄우는 쪽이 훨씬 싸다.
//
// ⚠ 한글 정규식에 `\b`(단어 경계)를 쓰지 마라 — 한글은 `\w` 가 아니라 절대 성립하지 않는다.
//   (build/verify-korean-regex.mjs 가 상설 검사한다.)

import type {
  BlogEngageIntentFields, ImagePostIntentFields, WorkflowIntent, WorkflowIntentKind,
} from '../../../shared/types'

export type { BlogEngageIntentFields, ImagePostIntentFields, WorkflowIntent, WorkflowIntentKind }

/** 사람이 입력창에 치는 지시의 현실적 상한. 넘으면 붙여넣은 페이지 본문으로 본다. */
const MAX_INPUT_CHARS = 1200

// ===========================================================================
// 거부 가드 — 하나라도 걸리면 즉시 null
// ===========================================================================

/** 조종 문구. 짧아도 거부한다 — 이런 문장은 사람이 자기 요청을 적을 때 쓰지 않는다. */
const INJECTION_RE = new RegExp([
  // 사이에 "모두"·"는" 같은 말이 끼어도 잡아야 한다("앞의 규칙 모두 잊고") — 공백 포함 12자까지 허용.
  '(이전|앞의|위의|기존|모든)\\s*(지시|명령|규칙|프롬프트)[^\\n]{0,12}(무시|잊)',
  '(지시|명령|규칙)[^\\n]{0,6}(무시하|잊고|잊어)',
  '시스템\\s*프롬프트',
  'ignore\\s+(all\\s+|the\\s+)?(previous|above|prior|earlier)',
  'disregard\\s+(all\\s+|the\\s+)?(previous|above|prior)',
].join('|'), 'i')

/** 질문. "해도 돼?"는 요청이 아니라 물음이다. */
const QUESTION_RE = new RegExp([
  '[?？]',
  '(나요|까요|을까|ㄹ까)',
  '해도\\s*(되|돼)',
  '수\\s*있(나|어|을까|는지)',
  '가능(해|한가|할까|합니까|한지)',
  '되나',
  '(인가|일까)',
].join('|'))

/** 설명 요구. 실행이 아니라 안내를 원한다. */
const EXPLAIN_RE = new RegExp([
  '방법', '어떻게', '왜(?![곡소])', '무엇', '뭐야', '뭔가',
  '설명해', '설명\\s*좀', '알려만', '차이', '뜻이', '가이드',
].join('|'))

/** 부정·금지. 하지 말라고 한 것을 폼으로 제안하지 않는다 — 다운그레이드가 아니라 거부다. */
const NEGATION_RE = new RegExp([
  '(하|올리|달|누르|게시|업로드|포스팅|만들|그리)지\\s*(마|말아|말것|말아라|맙)',
  '(하|올리|달|누르)진\\s*(마|말아|말아라)',   // "올리진 말고"(=초안)는 말고로 시작하므로 걸리지 않는다
  '금지',
  '안\\s*(돼|된다|됩니다)',
  '절대\\s*.{0,8}(마|말)',
  '(하|올리|달)지\\s*않(게|도록)',
].join('|'))

/** 남의 말 전달. 페이지·타인이 시킨 것은 사용자의 지시가 아니다. */
const HEARSAY_RE = new RegExp([
  '(라고|다고|하라고)\\s*(했|한다|하네|합니다|해요|써|적|하는)',
  '(라|다)면서',
  '댓글에',
  '본문에',
  '페이지에\\s*(적혀|써|나와)',
  '라는데',
  '(하|달|올리|눌러)래',
].join('|'))

/** 짝이 맞는 인용 부호 안의 내용. 신호 탐지는 이걸 걷어낸 텍스트에서만 한다. */
const QUOTED_RE = /"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|`[^`]*`/g

// ===========================================================================
// 긍정 신호 — 도메인 신호 AND 행동 동사가 모두 있어야 한다
// ===========================================================================

/** 생성 대상. 서비스명(아래)도 같은 자격의 도메인 신호로 인정한다. */
const IMG_TARGET_RE = /그림|이미지|사진|일러스트|일러|포스터|썸네일|로고|배너|수채화|유화|삽화|그래픽|아트워크/
/** 생성 동사. `그리고`(접속어)는 제외 — 한글은 음절 단위라 부분일치 오탐이 잦다. */
const IMG_GEN_RE = /그려|그리(?!고)|그린|만들|만드|생성|뽑아|제작/
const SNS_RE = /인스타그램|인스타|instagram|insta|틱톡|tiktok|유튜브|youtube|쇼츠|shorts|릴스|reels|에스엔에스|sns/i
const POST_RE = /올[려리릴]|게시|업로드|포스팅/

const BLOG_RE = /블로그|이웃|포스팅|포스트|글/
const ENGAGE_RE = /댓글|덧글|좋아요|공감/
const BLOG_DO_RE = /달[아어]|남[겨기]|눌러|해\s*줘|부탁|작성해/

const SVC_GENSPARK_RE = /genspark|젠스파크|젠스팍/i
const SVC_CHATGPT_RE = /chatgpt|챗\s*gpt|챗지피티|지피티|gpt|달리|dall/i
const SVC_ANY_RE = /genspark|젠스파크|젠스팍|chatgpt|챗\s*gpt|챗지피티|지피티|gpt|달리|dall|미드저니|midjourney/i

/** 프롬프트에서 걷어낼 서비스 절 — 뒤따르는 조사까지 함께 지워야 "에서 밤바다"가 남지 않는다. */
const SVC_CLAUSE_RE = /(genspark|젠스파크|젠스팍|chatgpt|챗\s*gpt|챗지피티|지피티|달리|dall[\s·]?e|미드저니|midjourney|gpt)\s*(에서|으로|로|에)?\s*(써서|사용해서|이용해서|시켜서|돌려서)?/gi
/** 프롬프트에서 걷어낼 게시 절: "내 인스타에 올려줘". */
const SNS_CLAUSE_RE = /(내|제|우리|나의)?\s*(인스타그램|인스타|instagram|insta|틱톡|tiktok|유튜브|youtube|쇼츠|shorts|릴스|reels|에스엔에스|sns)\s*(계정)?\s*(에다가|에다|에|으로|로)?\s*(도)?\s*(올[려리릴]\S*|게시\S*|업로드\S*|포스팅\S*)?/gi
const POST_TOKEN_RE = /(올[려리릴]|게시|업로드|포스팅)\S*/g

// ===========================================================================
// 보조
// ===========================================================================

function stripQuoted(text: string): string {
  return text.replace(QUOTED_RE, ' ')
}

/** 첫 매치의 위치. 없으면 Infinity — 여러 플랫폼이 언급되면 먼저 나온 것을 고른다. */
function firstIndex(re: RegExp, text: string): number {
  const m = re.exec(text)
  return m ? m.index : Number.POSITIVE_INFINITY
}

const PLATFORM_PATTERNS: { platform: 'instagram' | 'youtube' | 'tiktok'; re: RegExp }[] = [
  { platform: 'instagram', re: /인스타그램|인스타|instagram|insta|릴스|reels/i },
  { platform: 'tiktok', re: /틱톡|tiktok/i },
  { platform: 'youtube', re: /유튜브|youtube|쇼츠|shorts/i },
]

function detectPlatform(text: string): 'instagram' | 'youtube' | 'tiktok' | null {
  let best: 'instagram' | 'youtube' | 'tiktok' | null = null
  let bestAt = Number.POSITIVE_INFINITY
  for (const p of PLATFORM_PATTERNS) {
    const at = firstIndex(new RegExp(p.re.source, p.re.flags.replace('g', '')), text)
    if (at < bestAt) { bestAt = at; best = p.platform }
  }
  return best
}

const PLATFORM_LABEL: Record<string, string> = {
  instagram: '인스타그램', youtube: '유튜브', tiktok: '틱톡',
}

const SERVICE_LABEL: Record<ImagePostIntentFields['service'], string> = {
  genspark: 'Genspark', chatgpt: 'ChatGPT', custom: '지정한 도구',
}

function collectTags(text: string): string[] {
  const out: string[] = []
  const re = /#([^\s#,.]{1,40})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) && out.length < 10) {
    const tag = (m[1] ?? '').trim()
    if (tag && !out.includes(tag)) out.push(tag)   // sns-publish 는 '#' 없는 형태를 기대한다
  }
  return out
}

/** 생성 프롬프트 추출: 서비스 절·게시 절을 떼어 낸 뒤 생성 동사 앞까지를 남긴다. */
function extractImagePrompt(text: string): string {
  let s = text
  s = s.replace(SVC_CLAUSE_RE, ' ')
  s = s.replace(SNS_CLAUSE_RE, ' ')
  const gen = IMG_GEN_RE.exec(s)
  if (gen) s = s.slice(0, gen.index)
  s = s.replace(/#[^\s#]*/g, ' ')                       // 해시태그는 tags 로 따로 간다
  s = s.replace(/["'“”‘’「」『』`]/g, ' ')                // 인용 부호만 제거(내용은 보존)
  s = s.replace(POST_TOKEN_RE, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/^(그럼|그리고|이제|일단|먼저|자|좀)\s+/, '')
  s = s.replace(/^(내|제|우리|나의)\s+/, '')
  s = s.replace(/^[,·\-–—:]+|[,·\-–—:]+$/g, '').trim()
  s = s.replace(/(을|를|좀|하나|한\s*장)$/, '').trim()
  return s
}

const KOREAN_NUM: Record<string, number> = {
  한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10,
}

/**
 * 몇 곳에 참여할지. 못 읽으면 null(호출부가 기본값 + missing 처리).
 *
 * 한글 수사에는 두 가지 함정이 있다.
 * ① 관형형 어미가 수사와 같은 음절이다 — "비슷**한** 글", "유명**한** 글" 의 '한' 은 수사가 아닌데
 *    그냥 매치하면 maxPosts=1 이 된다(실측으로 잡았다). 앞에 한글 음절이 붙어 있으면 수사가 아니다.
 * ② 단위 '글' 은 한글 수사와 붙여 쓰지 않는다("한 글/두 글" 은 비문). 자연스러운 "글 3개" 는 숫자
 *    규칙이 이미 잡으므로, 한글 수사 쪽에서는 '글' 을 빼고 실제로 쓰는 '편' 을 넣는다.
 */
function extractMaxPosts(text: string): number | null {
  const digit = /(\d{1,3})\s*(개|건|곳|군데|글|편|포스트)/.exec(text)
  if (digit) return clampPosts(Number(digit[1]))
  const korean = /(?<![가-힣])(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*(개|건|곳|군데|편|포스트)/.exec(text)
  if (korean) {
    const n = KOREAN_NUM[korean[1] ?? '']
    if (typeof n === 'number') return clampPosts(n)
  }
  return null
}

function clampPosts(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(20, Math.max(1, Math.round(n)))
}

function extractTopic(text: string): string {
  const patterns = [
    /([^\s,.]{1,20})\s*(?:관련|쪽)/,
    /([^\s,.]{1,20})\s*에\s*대한/,
    /주제\s*(?:는|가|:)?\s*([^\s,.]{1,20})/,
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    const raw = (m?.[1] ?? '').trim()
    if (raw.length >= 2) return raw.replace(/["'“”‘’]/g, '')
  }
  return ''
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g
const SEARCH_URL_RE = /[?&](q|query|keyword|search|kw|sm)=|\/search|\/tag\/|검색/i
const OWNER_RE = /(내|제|우리|본인|나의)/

/** 원문에 실제로 적힌 주소만 쓴다 — 추측해서 채우지 않는다. */
function extractBlogUrls(text: string): { myBlogUrl: string; searchUrl: string } {
  let myBlogUrl = ''
  let searchUrl = ''
  const re = new RegExp(URL_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const url = (m[0] ?? '').replace(/[.,]+$/, '')
    if (SEARCH_URL_RE.test(url)) {
      if (!searchUrl) searchUrl = url
      continue
    }
    const before = text.slice(Math.max(0, m.index - 18), m.index)
    if (!myBlogUrl && OWNER_RE.test(before)) myBlogUrl = url
  }
  return { myBlogUrl, searchUrl }
}

// ===========================================================================
// 본체
// ===========================================================================

/**
 * 사용자가 직접 친 요청 한 덩어리를 생산 워크플로 폼값으로 읽는다.
 * 확신이 없으면 null — 그때는 호출부가 평범한 에이전트로 보낸다.
 */
export function detectWorkflowIntent(userText: string): WorkflowIntent | null {
  if (typeof userText !== 'string') return null
  const text = userText.trim()
  if (!text) return null
  if (text.length > MAX_INPUT_CHARS) return null           // 붙여넣은 페이지 본문 — 지시가 아니다

  if (INJECTION_RE.test(text)) return null
  // 질문·설명 판정에서는 **주소를 먼저 들어낸다.** 쿼리 문자열의 '?' 는 의문 부호가 아닌데
  // 그대로 두면 "블로그 .../search?q=등산 에서 3개 댓글 달아줘" 같은 정상 지시가 질문으로 걸린다
  // (실측으로 잡았다 — 주소를 붙이는 건 흔한 사용 방식이다). 다른 가드는 원문 그대로 본다.
  const guardText = text.replace(new RegExp(URL_RE.source, 'g'), ' ')
  if (QUESTION_RE.test(guardText)) return null
  if (EXPLAIN_RE.test(guardText)) return null
  if (NEGATION_RE.test(text)) return null
  if (HEARSAY_RE.test(text)) return null

  // 신호 탐지는 인용문을 걷어낸 텍스트에서 한다 — 인용 안에만 있으면 남의 말이다.
  const bare = stripQuoted(text)

  const hasImgTarget = IMG_TARGET_RE.test(bare) || SVC_ANY_RE.test(bare)
  const isImagePost = hasImgTarget && IMG_GEN_RE.test(bare) && SNS_RE.test(bare) && POST_RE.test(bare)
  if (isImagePost) return buildImagePost(text)

  const isBlogEngage = BLOG_RE.test(bare) && ENGAGE_RE.test(bare) && BLOG_DO_RE.test(bare)
  if (isBlogEngage) return buildBlogEngage(text)

  return null
}

function buildImagePost(text: string): WorkflowIntent {
  const matched: string[] = ['kind:image-post']
  const missing = new Set<string>()

  let service: ImagePostIntentFields['service'] = 'genspark'
  if (SVC_GENSPARK_RE.test(text)) { service = 'genspark'; matched.push('service:genspark') }
  else if (SVC_CHATGPT_RE.test(text)) { service = 'chatgpt'; matched.push('service:chatgpt') }
  else matched.push('service:default')                      // 사용자가 카드에서 바꿀 수 있다

  const platform = detectPlatform(text)
  if (platform) matched.push(`platform:${platform}`)
  else missing.add('platform')

  const prompt = extractImagePrompt(text)
  if (prompt.length >= 2) matched.push('prompt:extracted')
  else missing.add('prompt')

  // mode 는 **제안값일 뿐 자동 게시 승인이 아니다.** 실제 게시는 사용자가 캡션을 확인한 뒤
  // socialApprove(또는 명시 선승인 grant)를 부를 때만 시작된다.
  const draft = /초안|드래프트|저장만|올리진\s*말|발행\s*전|예약/.test(text)
  const mode: ImagePostIntentFields['mode'] = draft ? 'draft' : 'publish'
  matched.push(`mode:${mode}`)

  const tags = collectTags(text)
  if (tags.length) matched.push(`tags:${tags.length}`)

  // 어느 계정으로 올릴지는 사용자만 안다 — 본문에 핸들처럼 보이는 것이 있어도 확정하지 않는다.
  missing.add('account')

  const image: ImagePostIntentFields = {
    service,
    prompt: prompt.length >= 2 ? prompt : '',
    platform,
    mode,
    tags,
  }
  const serviceLabel = SERVICE_LABEL[image.service]
  const where = platform ? (PLATFORM_LABEL[platform] ?? platform) : '플랫폼 미정'
  const what = mode === 'publish' ? '게시' : '초안 저장'
  const summary = `${serviceLabel} 에서 이미지를 만들어 ${where}에 ${what} — 프롬프트: ${image.prompt || '(미정)'}`

  return { kind: 'image-post', summary, missing: [...missing], matched, image }
}

function buildBlogEngage(text: string): WorkflowIntent {
  const matched: string[] = ['kind:blog-engage']
  const missing = new Set<string>()

  const actions: BlogEngageIntentFields['actions'] = []
  if (/댓글|덧글/.test(text)) { actions.push('comment'); matched.push('action:comment') }
  if (/좋아요|공감/.test(text)) { actions.push('like'); matched.push('action:like') }

  const topic = extractTopic(text)
  if (topic) matched.push('topic:extracted')
  else missing.add('topic')

  const parsedPosts = extractMaxPosts(text)
  if (parsedPosts === null) missing.add('maxPosts')
  else matched.push(`maxPosts:${parsedPosts}`)
  const maxPosts = parsedPosts ?? 3

  const draft = /초안|초안만|미리|준비만|검토만/.test(text)
  const mode: BlogEngageIntentFields['mode'] = draft ? 'draft' : 'act'
  matched.push(`mode:${mode}`)

  const { myBlogUrl, searchUrl } = extractBlogUrls(text)
  if (myBlogUrl) matched.push('myBlogUrl:found')
  if (searchUrl) matched.push('searchUrl:found')

  // 어느 계정으로 참여할지는 사용자만 안다.
  missing.add('account')

  const blog: BlogEngageIntentFields = { topic, myBlogUrl, actions, mode, maxPosts, searchUrl }
  const actLabel = actions.length === 2 ? '댓글·좋아요' : actions[0] === 'like' ? '좋아요' : '댓글'
  const summary = `${topic || '주제 미정'} 관련 블로그 ${maxPosts}곳에 ${actLabel} ${mode === 'act' ? '실행' : '초안 준비'}`

  return { kind: 'blog-engage', summary, missing: [...missing], matched, blog }
}
