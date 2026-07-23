import { ipcMain, net, type WebContents } from 'electron'
import { IPC } from '../../../shared/ipc-channels'

interface BatchPayload { texts: string[]; target?: string }

const SEP = '\n@@@@\n'

function translateChunk(text: string, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
      encodeURIComponent(target) + '&dt=t&q=' + encodeURIComponent(text)
    const req = net.request({ url, method: 'GET', useSessionCookies: false })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      try { req.abort() } catch { /* ignore */ }
      reject(new Error('timeout'))
    }, 15000)
    req.on('response', (resp) => {
      resp.on('data', (c: Buffer) => chunks.push(c))
      resp.on('end', () => {
        clearTimeout(timer)
        try {
          const body = Buffer.concat(chunks).toString('utf8')
          const data = JSON.parse(body) as Array<Array<Array<string>>>
          const combined = (data[0] ?? []).map((s) => s?.[0] ?? '').join('')
          resolve(combined)
        } catch (err) {
          reject(err as Error)
        }
      })
    })
    req.on('error', (err) => { clearTimeout(timer); reject(err) })
    req.end()
  })
}

export function initTranslate(): void {
  ipcMain.handle(IPC.translate.batch, async (_e, args: BatchPayload) => {
    const target = args.target ?? 'ko'
    const joined = args.texts.join(SEP)
    if (joined.length === 0) return [] as string[]
    if (joined.length > 4500) {
      // 너무 길면 절반씩 재귀 호출
      const mid = Math.floor(args.texts.length / 2)
      const [a, b] = await Promise.all([
        ipcCall({ texts: args.texts.slice(0, mid), target }),
        ipcCall({ texts: args.texts.slice(mid), target }),
      ])
      return [...a, ...b]
    }
    try {
      const translated = await translateChunk(joined, target)
      const parts = translated.split(SEP)
      // 분할이 깨질 수 있음 — 원본 길이에 맞춰 padding
      while (parts.length < args.texts.length) parts.push('')
      return parts.slice(0, args.texts.length)
    } catch (err) {
      console.warn('[translate] batch failed', err)
      return args.texts.map(() => '')
    }
  })
}

async function ipcCall(args: BatchPayload): Promise<string[]> {
  // 재귀용 내부 호출
  const target = args.target ?? 'ko'
  const joined = args.texts.join(SEP)
  try {
    const translated = await translateChunk(joined, target)
    const parts = translated.split(SEP)
    while (parts.length < args.texts.length) parts.push('')
    return parts.slice(0, args.texts.length)
  } catch {
    return args.texts.map(() => '')
  }
}

const TRANS_SCRIPT = `
(async function() {
  if (window.__bbTransOn) {
    try {
      if (window.__bbTransOrig) {
        window.__bbTransOrig.forEach(function(orig, node) {
          try { node.nodeValue = orig } catch(e) {}
        })
      }
    } catch(e) {}
    window.__bbTransOn = false
    window.__bbTransOrig = null
    return { restored: true }
  }
  window.__bbTransOn = true
  window.__bbTransOrig = new Map()

  function collectNodes() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function(n) {
        var t = n.nodeValue && n.nodeValue.trim()
        if (!t || t.length < 2) return NodeFilter.FILTER_REJECT
        var p = n.parentElement
        if (!p) return NodeFilter.FILTER_REJECT
        var tag = p.tagName
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'CODE' || tag === 'PRE') return NodeFilter.FILTER_REJECT
        var s = window.getComputedStyle(p)
        if (s && (s.display === 'none' || s.visibility === 'hidden')) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      }
    })
    var nodes = []
    var n
    while ((n = walker.nextNode())) nodes.push(n)
    return nodes
  }

  var nodes = collectNodes()
  var BATCH = 50
  var ok = 0
  for (var i = 0; i < nodes.length; i += BATCH) {
    var batch = nodes.slice(i, i + BATCH)
    var texts = batch.map(function(n) { return n.nodeValue })
    try {
      var translated = await window.__bbTranslateBatch(texts)
      batch.forEach(function(node, j) {
        var t = translated[j]
        if (!t || t === node.nodeValue) return
        window.__bbTransOrig.set(node, node.nodeValue)
        try { node.nodeValue = t } catch(e) {}
        ok++
      })
    } catch(err) {
      console.warn('[bb-translate] batch err', err)
    }
  }
  return { ok: ok, total: nodes.length }
})();
`

export async function togglePageTranslate(wc: WebContents, target = 'ko'): Promise<{ started: boolean; restored?: boolean }> {
  if (wc.isDestroyed()) return { started: false }
  const url = wc.getURL()
  if (!/^https?:/i.test(url)) return { started: false }

  // 콘텐츠 페이지 main world 에 batch 함수 노출. preload 통할 수 없어 chrome.webContents.executeJavaScript
  // 안의 fetch 는 same-origin 제약 받으므로 IPC 우회 — preload 가 contextBridge 로 노출하는 게 정석.
  // 대안 (이번 라운드 단순화): main 이 직접 wc.send('translate:provide', batch) 후 wc 가 chunk callback.
  // 더 단순한 fallback: window.fetch 를 직접 호출 (translate.googleapis.com 은 CORS-friendly)
  const setupScript = `
    if (!window.__bbTranslateBatch) {
      window.__bbTranslateBatch = async function(texts) {
        const SEP = '\\n@@@@\\n'
        const joined = texts.join(SEP)
        if (joined.length === 0) return []
        if (joined.length > 4500) {
          const mid = Math.floor(texts.length / 2)
          const a = await window.__bbTranslateBatch(texts.slice(0, mid))
          const b = await window.__bbTranslateBatch(texts.slice(mid))
          return a.concat(b)
        }
        try {
          const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${target}&dt=t&q=' + encodeURIComponent(joined)
          const res = await fetch(url, { method: 'GET' })
          const data = await res.json()
          const combined = (data[0] || []).map(function(s) { return (s && s[0]) || '' }).join('')
          const parts = combined.split(SEP)
          while (parts.length < texts.length) parts.push('')
          return parts.slice(0, texts.length)
        } catch (err) {
          console.warn('[bb-translate] fetch err', err)
          return texts.map(function() { return '' })
        }
      }
    }
  `
  await wc.executeJavaScript(setupScript, true)
  const result = await wc.executeJavaScript(TRANS_SCRIPT, true) as { restored?: boolean; ok?: number; total?: number }
  return result.restored ? { started: false, restored: true } : { started: true }
}
