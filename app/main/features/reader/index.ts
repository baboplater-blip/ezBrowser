import { app, type WebContents } from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

let readabilityCode: string | null = null
const readerOn = new WeakSet<WebContents>()

function resolveReadabilityPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar', 'node_modules', '@mozilla', 'readability', 'Readability.js')
  }
  return require.resolve('@mozilla/readability/Readability.js')
}

async function loadCode(): Promise<string> {
  if (readabilityCode) return readabilityCode
  const buf = await readFile(resolveReadabilityPath(), 'utf-8')
  readabilityCode = buf
  return buf
}

function buildEnterScript(libCode: string): string {
  return `
(function() {
  ${libCode}
  try {
    if (window.__bbReaderActive) return
    window.__bbReaderActive = true
    window.__bbReaderOriginalHTML = document.documentElement.outerHTML
    var docClone = document.cloneNode(true)
    var article = new Readability(docClone).parse()
    if (!article) {
      window.__bbReaderActive = false
      return
    }
    var title = article.title || document.title
    var byline = article.byline || ''
    var content = article.content
    var html = ''
    html += '<!doctype html><html lang="ko"><head><meta charset="utf-8"/>'
    html += '<meta name="viewport" content="width=device-width, initial-scale=1.0"/>'
    html += '<title>' + (title || '') + '</title>'
    html += '<style>'
    html += ':root{color-scheme:light dark;}'
    html += 'html,body{margin:0;padding:0;background:#FAF9F6;color:#1A1A1A;}'
    html += '@media(prefers-color-scheme:dark){html,body{background:#0F0F12;color:#EDEDEF;}}'
    html += 'body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Pretendard,Apple SD Gothic Neo,sans-serif;'
    html += 'font-size:18px;line-height:1.7;}'
    html += '.bb-reader{max-width:720px;margin:32px auto 80px;padding:0 24px;}'
    html += '.bb-reader h1{font-size:32px;line-height:1.25;margin:0 0 8px;letter-spacing:-0.4px;}'
    html += '.bb-reader .byline{color:#888;font-size:13px;margin-bottom:32px;}'
    html += '.bb-reader img,.bb-reader video{max-width:100%;height:auto;border-radius:6px;}'
    html += '.bb-reader pre{overflow-x:auto;background:#f3f3f3;padding:12px;border-radius:6px;font-size:14px;}'
    html += '@media(prefers-color-scheme:dark){.bb-reader pre{background:#1a1a1f;}}'
    html += '.bb-reader p{margin:0 0 16px;}'
    html += '.bb-reader a{color:#3478F6;}'
    html += '.bb-reader blockquote{border-left:4px solid #ccc;padding:0 16px;color:#666;margin:16px 0;}'
    html += '.bb-reader-bar{position:fixed;top:0;left:0;right:0;height:36px;'
    html += 'background:rgba(255,255,255,0.85);backdrop-filter:blur(8px);'
    html += 'border-bottom:1px solid rgba(0,0,0,0.1);display:flex;align-items:center;'
    html += 'padding:0 16px;font-size:12px;color:#555;z-index:1000;}'
    html += '@media(prefers-color-scheme:dark){.bb-reader-bar{background:rgba(15,15,18,0.85);border-color:rgba(255,255,255,0.1);color:#aaa;}}'
    html += '.bb-reader-bar button{margin-left:auto;border:1px solid currentColor;background:transparent;'
    html += 'color:inherit;padding:3px 10px;border-radius:11px;cursor:pointer;font-size:11px;}'
    html += '</style></head><body>'
    html += '<div class="bb-reader-bar">📖 리더 모드 · <button onclick="window.__bbExitReader()">원본 보기</button></div>'
    html += '<article class="bb-reader">'
    html += '<h1>' + (title || '') + '</h1>'
    if (byline) html += '<p class="byline">' + byline + '</p>'
    html += content
    html += '</article></body></html>'
    document.open()
    document.write(html)
    document.close()
    window.__bbExitReader = function() {
      try {
        document.open()
        document.write(window.__bbReaderOriginalHTML)
        document.close()
        window.__bbReaderActive = false
      } catch(err) {}
    }
  } catch(err) {
    window.__bbReaderActive = false
    console.error('[bb-reader]', err)
  }
})();
`
}

const EXIT_SCRIPT = `
(function() {
  if (!window.__bbReaderActive || !window.__bbReaderOriginalHTML) return
  try {
    document.open()
    document.write(window.__bbReaderOriginalHTML)
    document.close()
    window.__bbReaderActive = false
  } catch(err) {}
})();
`

export async function toggleReader(wc: WebContents): Promise<boolean> {
  if (wc.isDestroyed()) return false
  if (readerOn.has(wc)) {
    await wc.executeJavaScript(EXIT_SCRIPT, true)
    readerOn.delete(wc)
    return false
  }
  const url = wc.getURL()
  if (!/^https?:/i.test(url)) return false
  const code = await loadCode()
  await wc.executeJavaScript(buildEnterScript(code), true)
  readerOn.add(wc)
  return true
}
