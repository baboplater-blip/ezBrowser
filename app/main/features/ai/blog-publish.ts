// 블로그 발행 브릿지 — 스튜디오 초안(제목·본문·태그)을 "실제 에디터를 열어 작성/임시저장/발행"하는
// 에이전트 작업으로 변환한다. 네이버 SmartEditor ONE 은 셀렉터·발행 흐름이 특수해서(제목/본문이
// contenteditable, 발행은 2단계, 태그는 발행 패널 안, 도움말·복구 팝업), 그 도메인 지식을 태스크에
// 직접 심어 범용 추측이 아니라 에디터 인지로 구동하게 한다. 참고: naver_blog_automation_v3 의 실전 셀렉터.
// 발행/임시저장 같은 되돌리기 어려운 동작은 에이전트 루프의 확인 게이트(SENSITIVE)가 그대로 잡는다.

export type BlogMode = 'insert' | 'draft' | 'publish'

export interface BlogTaskParams {
  platform?: string          // naver / tistory / wordpress / generic
  mode: BlogMode
  title: string
  body: string               // 마크다운 본문
  tags?: string[]
  autoOpen?: boolean         // 글쓰기 페이지가 아니면 에이전트가 먼저 그 페이지로 이동
}

// 네이버 글쓰기 진입 URL — 로그인돼 있으면 본인 블로그 글쓰기(SmartEditor ONE)로 리다이렉트된다.
export const NAVER_WRITE_URL = 'https://blog.naver.com/GoBlogWrite.naver'

function contentBlock(title: string, body: string, tags: string[]): string {
  const lines = ['# 제목', title.trim(), '', '# 본문', body.trim().slice(0, 9000)]
  if (tags.length) { lines.push('', '# 태그', tags.join(', ')) }
  return lines.join('\n')
}

// 네이버 SmartEditor ONE 은 제목·본문이 React 로 제어되는 특수 편집영역이라, 단순히 텍스트를 대입하면
// 재렌더에 덮여 사라진다. 실제 타이핑과 같은 입력 이벤트를 만드는 document.execCommand('insertText')
// (+ 폴백)로 채우면 안정적으로 들어간다. 참고: naver_uploader.py 의 다중 전략을 축약.
// 속도를 위해 "팝업 닫기 + 제목 + 본문" 을 한 번의 run_js 로 처리한다(스텝 수 절감).
// 이 코드에는 '발행/등록/게시/저장' 같은 민감 단어가 없어 별도 확인 게이트를 유발하지 않는다(입력만 함).
function naverSetupRecipe(title: string, body: string): string {
  const T = JSON.stringify(title.trim())
  const B = JSON.stringify(body.trim())
  return `(function(){var T=${T},B=${B};`
    // 1) 도움말/코치마크 오버레이 숨김 + "작성 중이던 글" 복구 팝업은 '취소'(새 글) — 민감 아님
    + `try{document.querySelectorAll('[class*=se-help],[class*=se-guide],[class*=se-tooltip],[class*=se-popup-dimmed]').forEach(function(e){e.style.display='none';});}catch(e){}`
    + `try{var bt=(document.body&&document.body.innerText)||'';if(bt.indexOf('작성 중')>=0||bt.indexOf('작성하던')>=0||bt.indexOf('이어서')>=0){var bs=document.querySelectorAll('button,a');for(var q=0;q<bs.length;q++){var tx=(bs[q].textContent||'').trim();if((tx==='취소'||tx==='새로 작성'||tx==='새로작성')&&bs[q].offsetParent){bs[q].click();break;}}}}catch(e){}`
    // 2) 제목·본문 입력(실제 타이핑 이벤트)
    + `function ce(r){if(!r)return null;if(r.getAttribute&&r.getAttribute('contenteditable')==='true')return r;return r.querySelector('[contenteditable=true]')||r;}`
    + `function put(c,t){var el=ce(c);if(!el)return false;try{el.querySelectorAll('.se-placeholder').forEach(function(x){x.remove();});}catch(e){}el.focus();try{var s=window.getSelection(),g=document.createRange();g.selectNodeContents(el);g.collapse(false);s.removeAllRanges();s.addRange(g);}catch(e){}var ok=false;try{ok=document.execCommand('insertText',false,t);}catch(e){}if(!ok){try{el.textContent=t;el.dispatchEvent(new Event('input',{bubbles:true}));ok=true;}catch(e){}}return ok;}`
    + `var tc=document.querySelector('.se-title-text')||document.querySelector('.se-documentTitle');var r1=tc?put(tc,T):false;`
    + `var bc=null,all=document.querySelectorAll('.se-text-paragraph');for(var i=0;i<all.length;i++){var p=all[i];if(!p.closest('.se-documentTitle')&&!p.closest('.se-section-documentTitle')&&!p.closest('.se-title-text')){bc=p;break;}}`
    + `if(!bc){var cs=document.querySelectorAll('[contenteditable=true]');for(var j=0;j<cs.length;j++){var c=cs[j];if(!c.closest('.se-title-text')&&!c.closest('.se-documentTitle')){bc=c;break;}}}`
    + `var r2=bc?put(bc,B):false;return JSON.stringify({title:r1,body:r2});})()`
}

// 발행 설정 패널이 열린 뒤, 태그를 "한 번에" 입력한다(태그마다 별도 스텝 방지 → 속도). 민감 단어 없음.
function naverTagsRecipe(tags: string[]): string {
  const A = JSON.stringify(tags.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean))
  return `(function(){var A=${A};`
    + `var inp=document.querySelector('input.tag_input')||document.querySelector('input[placeholder*="태그"]')||document.querySelector('[class*=tag] input[type=text]')||document.querySelector('[class*=tag] input:not([type])');`
    + `if(!inp)return JSON.stringify({added:0,found:false});`
    + `var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;var n=0;`
    + `A.forEach(function(t){if(!t)return;try{inp.focus();setter.call(inp,t);inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,which:13,bubbles:true}));inp.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',keyCode:13,which:13,bubbles:true}));n++;}catch(e){}});`
    + `return JSON.stringify({added:n,found:true});})()`
}

// 네이버 SmartEditor ONE 인지 지침. 제목/본문은 contenteditable 이라 관찰(observe)에 잡히고 type 으로
// 입력된다. 발행은 상단 '발행'(publish_btn) → 설정 패널 → 최종 '발행'(confirm_btn) 2단계다.
function naverGuide(mode: BlogMode, hasTags: boolean, setupRecipe: string, tagsRecipe: string): string {
  const lines: string[] = [
    '이 사이트는 네이버 블로그 글쓰기(SmartEditor ONE)입니다. 빠르게, 최소 단계로 진행하세요(불필요한 read/wait 없이).',
    '',
    '① 팝업 닫기 + 제목·본문 입력을 "한 번에": 아래 run_js 한 줄이면 도움말/복구 팝업을 닫고 제목·본문까지 안정적으로 입력됩니다. **가장 먼저 이걸 실행하세요.**',
    `   {"action":"run_js","code":${JSON.stringify(setupRecipe)}}`,
    '   - 결과가 {"title":true,"body":true} 면 성공. 다음 관찰에서 제목·본문이 채워졌는지 확인하고, false 거나 비어 있으면 해당 편집칸을 클릭해 type 으로 보완하세요(내용은 아래 "작성할 내용"에 있음).',
    '② 발행·저장은 반드시 화면의 실제 버튼을 "클릭"(click). run_js 로 발행/저장/제출을 실행하지 마세요(그래야 확인이 명확하고 확실합니다).',
  ]
  if (mode === 'publish') {
    lines.push(
      '③ 발행 버튼 클릭: 상단 오른쪽 "발행" 버튼(텍스트가 정확히 "발행")을 클릭하면 발행 설정 패널이 열립니다.',
      hasTags
        ? `④ 태그 한 번에 입력: 발행 패널이 열린 뒤 아래 run_js 로 태그를 한꺼번에 넣으세요(태그마다 따로 입력하지 말 것). {"action":"run_js","code":${JSON.stringify(tagsRecipe)}}`
        : '④ 태그: 지정된 태그 없음 — 건너뜁니다.',
      '⑤ 최종 발행: 발행 패널 "안"의 확정 "발행" 버튼을 클릭해 실제로 발행합니다(카테고리·공개범위 기본값 유지). 이 클릭에서 사용자 확인이 뜨면 사용자가 승인합니다.',
      '⑥ 발행 완료(주소가 글 보기로 바뀌거나 "발행되었습니다" 안내)면 done 으로 보고합니다.',
    )
  } else if (mode === 'draft') {
    lines.push(
      '③ 임시저장: 상단 "저장" 버튼(임시저장, 저장 개수 표시)을 클릭합니다. "발행"과 혼동 금지 — 지금은 저장만.',
      '④ 저장 완료면 done 으로 보고합니다. 태그·발행은 사용자가 나중에 합니다.',
    )
  } else {
    lines.push(
      '③ 저장·발행 금지: 입력만 마치고 저장/발행 버튼은 누르지 마세요. 끝나면 done 으로 보고합니다.',
    )
  }
  return lines.join('\n')
}

// 티스토리·워드프레스·일반 에디터용 범용 지침.
function genericGuide(platform: string | undefined, mode: BlogMode, hasTags: boolean): string {
  const name = platform === 'tistory' ? '티스토리' : platform === 'wordpress' ? '워드프레스' : '블로그'
  const lines: string[] = [
    `이 사이트는 ${name} 글쓰기 에디터입니다. 아래 순서를 지키세요.`,
    '① 시작 시 안내·도움말 팝업이 있으면 닫습니다.',
    '② 제목 입력란을 찾아 제목을 정확히 입력합니다.',
    '③ 본문 영역(에디터 본문)에 본문을 문단 순서대로 입력합니다. 마크다운 기호는 그 에디터에 맞게 문단/제목으로 자연스럽게 입력합니다.',
  ]
  if (mode === 'publish') {
    lines.push(
      hasTags ? '④ 태그 입력란이 있으면 아래 태그를 입력합니다(있을 때만).' : '④ 태그: 지정된 태그 없음 — 건너뜁니다.',
      '⑤ "발행"/"공개 발행"/"등록"/"완료" 버튼을 눌러 실제로 발행합니다. 발행 옵션(공개범위·카테고리)이 뜨면 기본값 그대로 두고 진행합니다. (발행 버튼을 누를 때 사용자 확인을 요청하면 사용자가 승인합니다.)',
      '⑥ 발행이 끝나면 done 으로 보고합니다.',
    )
  } else if (mode === 'draft') {
    lines.push(
      hasTags ? '④ 태그 입력란이 있으면 아래 태그를 입력합니다.' : '',
      '⑤ "임시저장"/"저장" 버튼을 눌러 임시저장합니다(발행은 하지 않습니다). 완료되면 done 으로 보고합니다.',
    )
  } else {
    lines.push(
      '④ 저장·발행 버튼은 누르지 말고 입력만 마친 뒤 done 으로 보고합니다. 발행은 사용자가 직접 합니다.',
    )
  }
  return lines.filter(Boolean).join('\n')
}

export function buildBlogTask(p: BlogTaskParams): string {
  const platform = (p.platform || 'naver').toLowerCase()
  const tags = (p.tags ?? []).map((t) => String(t).trim()).filter(Boolean)
  const isNaver = platform === 'naver'
  const guide = isNaver
    ? naverGuide(p.mode, tags.length > 0, naverSetupRecipe(p.title, p.body), naverTagsRecipe(tags))
    : genericGuide(platform, p.mode, tags.length > 0)

  const head: string[] = []
  const modeWord = p.mode === 'publish' ? '작성하고 발행' : p.mode === 'draft' ? '작성하고 임시저장' : '작성'
  head.push(`아래 글을 블로그 에디터에 ${modeWord}해 주세요.`)
  if (p.autoOpen && isNaver) {
    head.push(`지금 페이지가 네이버 블로그 글쓰기 화면이 아니면, 먼저 ${NAVER_WRITE_URL} 로 이동하세요(로그인돼 있으면 본인 블로그 글쓰기로 이동합니다). 로그인 화면이 뜨면 로그인이 필요하다고 ask 로 알려주세요.`)
  } else if (p.autoOpen) {
    head.push('지금 페이지가 글쓰기 에디터가 아니면, 글쓰기 화면으로 먼저 이동하세요. 로그인이 필요하면 ask 로 알려주세요.')
  }

  return [
    head.join('\n'),
    '',
    guide,
    '',
    '# 작성할 내용',
    contentBlock(p.title, p.body, p.mode === 'insert' || p.mode === 'draft' ? [] : tags),
    ...(tags.length && (p.mode === 'insert' || p.mode === 'draft')
      ? ['', `(참고 태그 — 발행할 때 사용: ${tags.join(', ')})`] : []),
  ].join('\n')
}
