import { app, type WebContents } from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// 현재 페이지의 본문 텍스트 + 선택 영역을 읽어온다. 리더 모드(features/reader)와 동일한
// @mozilla/readability 를 쓰되, DOM 을 바꾸지 않고 clone 에서 파싱만 해서 결과를 반환한다(읽기 전용).
//
// 에이전트 라운드에서 이 모듈을 "클릭 가능한 요소 목록(role/text/selector)"까지 반환하도록 확장하면,
// 관찰(observe) 단계가 그대로 재사용된다.

export interface PageContent {
  url: string
  title: string
  byline: string
  text: string
  selection: string
  truncated: boolean
}

let readabilityCode: string | null = null

function resolveReadabilityPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar', 'node_modules', '@mozilla', 'readability', 'Readability.js')
  }
  return require.resolve('@mozilla/readability/Readability.js')
}

async function loadReadability(): Promise<string> {
  if (readabilityCode) return readabilityCode
  readabilityCode = await readFile(resolveReadabilityPath(), 'utf-8')
  return readabilityCode
}

function buildScript(libCode: string): string {
  return `
(function() {
  ${libCode}
  var out = { url: location.href, title: document.title || '', byline: '', text: '', selection: '' };
  try {
    out.selection = String((window.getSelection && window.getSelection().toString()) || '');
  } catch (e) {}
  try {
    var clone = document.cloneNode(true);
    var article = new Readability(clone).parse();
    if (article && article.textContent && article.textContent.trim().length > 0) {
      out.title = article.title || out.title;
      out.byline = article.byline || '';
      out.text = article.textContent;
    } else if (document.body) {
      out.text = document.body.innerText || '';
    }
  } catch (e) {
    if (document.body) out.text = document.body.innerText || '';
  }
  return out;
})();
`
}

interface RawPage {
  url: string
  title: string
  byline: string
  text: string
  selection: string
}

export async function extractPageContent(wc: WebContents, maxChars: number): Promise<PageContent | null> {
  if (wc.isDestroyed()) return null
  const url = wc.getURL()
  if (!/^https?:/i.test(url)) return null
  let raw: RawPage
  try {
    const code = await loadReadability()
    raw = (await wc.executeJavaScript(buildScript(code), true)) as RawPage
  } catch (err) {
    console.warn('[ai] page extract failed', err)
    return null
  }
  const text = (raw.text ?? '').replace(/\n{3,}/g, '\n\n').trim()
  const truncated = text.length > maxChars
  return {
    url: raw.url ?? url,
    title: raw.title ?? '',
    byline: raw.byline ?? '',
    text: truncated ? text.slice(0, maxChars) : text,
    selection: (raw.selection ?? '').trim().slice(0, 8000),
    truncated,
  }
}

// UI 표시용 가벼운 컨텍스트(본문 추출 없이 제목/URL/선택 여부만).
export async function getPageSummaryInfo(wc: WebContents): Promise<{ url: string; title: string; hasSelection: boolean } | null> {
  if (wc.isDestroyed()) return null
  const url = wc.getURL()
  if (!/^https?:/i.test(url)) return { url, title: wc.getTitle(), hasSelection: false }
  try {
    const info = (await wc.executeJavaScript(
      `(function(){ try { return { hasSelection: !!(window.getSelection && window.getSelection().toString().trim()) } } catch(e){ return { hasSelection:false } } })();`,
      true,
    )) as { hasSelection: boolean }
    return { url, title: wc.getTitle(), hasSelection: !!info.hasSelection }
  } catch {
    return { url, title: wc.getTitle(), hasSelection: false }
  }
}
