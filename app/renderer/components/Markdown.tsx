import { useMemo, type ReactNode } from 'react'

// 가벼운 마크다운 렌더러 — 외부 의존성 없음, XSS 안전.
// 파싱(순수 함수)과 렌더(React 노드)를 분리한다. dangerouslySetInnerHTML 을 절대 쓰지 않으므로
// 텍스트는 항상 React 가 이스케이프하고, 허용된 요소 타입만 생성한다(스크립트·이벤트 핸들러 주입 불가).

export type MdInline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: MdInline[] }
  | { t: 'em'; c: MdInline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: MdInline[] }

export type MdBlock =
  | { t: 'p'; c: MdInline[] }
  | { t: 'h'; level: number; c: MdInline[] }
  | { t: 'ul'; items: MdInline[][] }
  | { t: 'ol'; items: MdInline[][] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: MdInline[] }
  | { t: 'hr' }

function parseInline(s: string): MdInline[] {
  const out: MdInline[] = []
  let buf = ''
  const flush = (): void => { if (buf) { out.push({ t: 'text', v: buf }); buf = '' } }
  let i = 0
  while (i < s.length) {
    const rest = s.slice(i)
    let m: RegExpExecArray | null
    if ((m = /^`([^`]+)`/.exec(rest))) { flush(); out.push({ t: 'code', v: m[1] ?? '' }); i += m[0].length; continue }
    if ((m = /^\*\*([^]+?)\*\*/.exec(rest))) { flush(); out.push({ t: 'strong', c: parseInline(m[1] ?? '') }); i += m[0].length; continue }
    if ((m = /^__([^]+?)__/.exec(rest))) { flush(); out.push({ t: 'strong', c: parseInline(m[1] ?? '') }); i += m[0].length; continue }
    if ((m = /^\*([^*\n]+?)\*/.exec(rest))) { flush(); out.push({ t: 'em', c: parseInline(m[1] ?? '') }); i += m[0].length; continue }
    if ((m = /^_([^_\n]+?)_/.exec(rest))) { flush(); out.push({ t: 'em', c: parseInline(m[1] ?? '') }); i += m[0].length; continue }
    if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) { flush(); out.push({ t: 'link', href: m[2] ?? '', c: parseInline(m[1] ?? '') }); i += m[0].length; continue }
    buf += s[i] ?? ''; i++
  }
  flush()
  return out
}

const BLOCK_START = /^(```|#{1,6}\s|\s*[-*+]\s+|\s*\d+\.\s+|\s*>\s?)/

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const at = (k: number): string => lines[k] ?? ''
  const blocks: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = at(i)
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim()
      i++
      const buf: string[] = []
      while (i < lines.length && !/^```/.test(at(i))) { buf.push(at(i)); i++ }
      i++ // 닫는 펜스
      blocks.push({ t: 'code', lang, v: buf.join('\n') })
      continue
    }
    if (/^\s*$/.test(line)) { i++; continue }
    let m: RegExpExecArray | null
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { blocks.push({ t: 'h', level: (m[1] ?? '').length, c: parseInline(m[2] ?? '') }); i++; continue }
    if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) { blocks.push({ t: 'hr' }); i++; continue }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: MdInline[][] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(at(i))) { items.push(parseInline(at(i).replace(/^\s*[-*+]\s+/, ''))); i++ }
      blocks.push({ t: 'ul', items }); continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: MdInline[][] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(at(i))) { items.push(parseInline(at(i).replace(/^\s*\d+\.\s+/, ''))); i++ }
      blocks.push({ t: 'ol', items }); continue
    }
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(at(i))) { buf.push(at(i).replace(/^\s*>\s?/, '')); i++ }
      blocks.push({ t: 'quote', c: parseInline(buf.join(' ')) }); continue
    }
    const buf: string[] = []
    while (i < lines.length && !/^\s*$/.test(at(i)) && !BLOCK_START.test(at(i))) { buf.push(at(i)); i++ }
    blocks.push({ t: 'p', c: parseInline(buf.join('\n')) })
  }
  return blocks
}

function safeHref(href: string): string | null {
  const h = href.trim()
  if (/^https?:\/\//i.test(h) || /^mailto:/i.test(h)) return h
  return null
}

function renderInline(nodes: MdInline[], windowId: string, keyPrefix: string): ReactNode[] {
  return nodes.map((n, idx) => {
    const key = `${keyPrefix}-${idx}`
    switch (n.t) {
      case 'text': return <span key={key}>{n.v}</span>
      case 'code': return <code key={key} className="md-code">{n.v}</code>
      case 'strong': return <strong key={key}>{renderInline(n.c, windowId, key)}</strong>
      case 'em': return <em key={key}>{renderInline(n.c, windowId, key)}</em>
      case 'link': {
        const href = safeHref(n.href)
        const children = renderInline(n.c, windowId, key)
        if (!href) return <span key={key}>{children}</span>
        return (
          <a key={key} className="md-link" href={href}
            onClick={(e) => { e.preventDefault(); void window.browserAPI.tabs.create(windowId, href, { background: false }) }}>
            {children}
          </a>
        )
      }
    }
  })
}

export function Markdown({ text, windowId }: { text: string; windowId: string }) {
  // 스트리밍 중 매 델타마다 스레드의 모든 assistant 메시지가 재렌더되므로 파싱을 메모이즈한다.
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <div className="md">
      {blocks.map((b, idx) => {
        const key = `b-${idx}`
        switch (b.t) {
          case 'p': return <p key={key} className="md-p">{renderInline(b.c, windowId, key)}</p>
          case 'h': {
            const lvl = Math.min(4, Math.max(1, b.level))
            const Tag = (`h${lvl}`) as 'h1' | 'h2' | 'h3' | 'h4'
            return <Tag key={key} className={`md-h md-h${lvl}`}>{renderInline(b.c, windowId, key)}</Tag>
          }
          case 'ul': return <ul key={key} className="md-ul">{b.items.map((it, j) => <li key={`${key}-${j}`}>{renderInline(it, windowId, `${key}-${j}`)}</li>)}</ul>
          case 'ol': return <ol key={key} className="md-ol">{b.items.map((it, j) => <li key={`${key}-${j}`}>{renderInline(it, windowId, `${key}-${j}`)}</li>)}</ol>
          case 'code': return <pre key={key} className="md-pre"><code>{b.v}</code></pre>
          case 'quote': return <blockquote key={key} className="md-quote">{renderInline(b.c, windowId, key)}</blockquote>
          case 'hr': return <hr key={key} className="md-hr" />
        }
      })}
    </div>
  )
}
