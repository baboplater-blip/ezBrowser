// Source-level fixture regression; no Electron window, network, or real profile.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = fs.readFileSync(new URL('../app/main/features/ai/page-actions.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source + '\nexport const testProbeSource = ENGAGE_TARGET_FN;', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const exports = {}
vm.runInNewContext(js, {
  exports, require: (id) => id === 'node:path' ? require(id) : {},
  setTimeout: (fn) => { fn(); return 0 }, clearTimeout, console,
})

// Minimal DOM fixture supporting the selectors used by the probe.
function node(tag, text = '', attrs = {}, children = []) {
  const n = { tagName: tag.toUpperCase(), nodeType: 1, textContent: text, children,
    getAttribute: (key) => attrs[key] ?? null, href: attrs.href,
    matches(selector) {
      return selector.split(',').some((s) => {
        s = s.trim()
        if (/^h[1-4] a|^\[role=heading\] a/.test(s)) return this.tagName === 'A' && this.parentElement?.matches(s.split(' ')[0])
        if (s === 'a[href][rel~=bookmark]') return this.tagName === 'A' && !!attrs.href && (attrs.rel ?? '').split(' ').includes('bookmark')
        if (s === 'a[href]') return this.tagName === 'A' && !!attrs.href
        if (s.startsWith('[role=')) return attrs.role === s.slice(6, -1)
        return this.tagName.toLowerCase() === s
      })
    },
    closest(selector) { for (let p = this; p; p = p.parentElement) if (p.matches(selector)) return p; return null },
    querySelectorAll(selector) { return children.flatMap((c) => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]) },
  }
  for (const c of children) c.parentElement = n
  return n
}
function probe(root, target) {
  const document = { querySelectorAll: (s) => root.querySelectorAll(s), defaultView: { location: { href: 'https://fixture.test/feed' } } }
  const attach = (n) => { n.ownerDocument = document; n.children.forEach(attach) }
  attach(root)
  return vm.runInNewContext(`(${exports.testProbeSource})(target)`, { document, target })
}
for (const container of ['article', 'li']) {
  const button = node('button', 'Like')
  const sibling = node(container, '', {}, [node('h2', 'Sibling', {}, [node('a', 'Sibling', { href: 'https://fixture.test/post/other' })])])
  const own = node(container, '', {}, [node('a', 'Author', { href: 'https://fixture.test/author' }), button])
  const root = node('body', '', {}, [node('div', '', {}, [sibling, own])])
  assert.equal(probe(root, button).permalink, '', `${container}: no sibling or author identity`)
  assert.equal(probe(root, button).heading, '', `${container}: no sibling title`)
  const title = node('h2', 'Own post', {}, [node('a', 'Own post', { href: 'https://fixture.test/post/own' })])
  own.children.unshift(title); title.parentElement = own
  assert.equal(probe(root, button).permalink, 'https://fixture.test/post/own', `${container}: own title accepted`)
  own.children.shift()
  const bookmark = node('a', 'Permalink', { href: 'https://fixture.test/post/bookmark', rel: 'bookmark' })
  own.children.unshift(bookmark); bookmark.parentElement = own
  assert.equal(probe(root, button).permalink, 'https://fixture.test/post/bookmark', `${container}: explicit bookmark accepted`)
}

let dispatched = 0
const report = { preDispatchFail: true }
const wc = { isDestroyed: () => false, executeJavaScript: async () => { dispatched++; throw Error('response lost after click') } }
let result = await exports.executeInPageAction(wc, { action: 'click_at', xPct: 50, yPct: 50 }, { humanInput: false, report })
assert.equal(result.ok, false)
assert.equal(report.preDispatchFail, false, 'transport loss must retain uncertainty and clear stale report')
assert.equal(dispatched, 1)

const page = { window: { innerWidth: 100, innerHeight: 100 }, document: { elementFromPoint: () => null } }
wc.executeJavaScript = async (code) => vm.runInNewContext(code, page)
result = await exports.executeInPageAction(wc, { action: 'click_at', xPct: 50, yPct: 50 }, { humanInput: false, report })
assert.equal(result.ok, false)
assert.equal(report.preDispatchFail, true, 'explicit missing target allows rollback')
page.document.elementFromPoint = () => ({ dispatchEvent: () => { dispatched++; throw Error('event handler uncertainty') } })
page.MouseEvent = class {}
result = await exports.executeInPageAction(wc, { action: 'click_at', xPct: 50, yPct: 50 }, { humanInput: false, report })
assert.equal(result.ok, false)
assert.equal(report.preDispatchFail, false, 'exception after dispatch does not allow rollback')

let syntheticRuns = 0
wc.executeJavaScript = async () => { syntheticRuns++; return { w: 100, h: 100 } }
wc.focus = () => {}
wc.sendInputEvent = (event) => { if (event.type === 'mouseUp') throw Error('lost release response') }
const profile = { reactionMs: [0, 0], holdMs: [0, 0], moveSteps: [1, 1], settleMs: 0 }
result = await exports.executeInPageAction(wc, { action: 'click_at', xPct: 50, yPct: 50 }, { profile, report })
assert.equal(result.ok, false)
assert.equal(report.preDispatchFail, false)
assert.equal(syntheticRuns, 1, 'human click error never retries through synthetic execution')
wc.sendInputEvent = (event) => { if (event.type === 'keyUp') throw Error('key response lost') }
report.preDispatchFail = true
result = await exports.pressKey(wc, { key: 'Enter' }, undefined, report)
assert.equal(result.ok, false)
assert.equal(report.preDispatchFail, false, 'key response loss must clear stale rollback permission')
result = await exports.pressKey(wc, { key: '' }, undefined, report)
assert.equal(result.ok, false)
assert.equal(report.preDispatchFail, true, 'empty key is a confirmed pre-input failure')
console.log('PASS: target article/li boundaries, own-title positive controls, dispatch uncertainty and no automatic click replay')
