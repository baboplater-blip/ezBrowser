import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

// Execute the production helper and done/exhausted branches without starting Electron.
// The implementation is extracted via the TypeScript AST, never copied into this test.
const source = fs.readFileSync(new URL('../app/main/features/ai/task-runtime.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('task-runtime.ts', source, ts.ScriptTarget.Latest, true)
const functions = new Map()
const outcomeBranches = new Map()
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node)
  if (ts.isIfStatement(node)) {
    const condition = node.expression.getText(ast)
    if (condition === "outcome.kind === 'done'" || condition === "outcome.kind === 'exhausted'") {
      outcomeBranches.set(condition, node)
    }
  }
  ts.forEachChild(node, visit)
}
visit(ast)
function functionText(name) {
  assert.ok(functions.has(name), `Production function missing: ${name}`)
  return functions.get(name).getText(ast)
}
function branchText(kind) {
  const branch = outcomeBranches.get(`outcome.kind === '${kind}'`)
  assert.ok(branch, `Production outcome branch missing: ${kind}`)
  return branch.getText(ast)
}
// For exhaustion, run the actual confirmation statement. Remaining branch concerns scheduling.
const exhausted = outcomeBranches.get("outcome.kind === 'exhausted'")
assert.ok(exhausted)
let exhaustionConfirmation = ''
for (const statement of exhausted.thenStatement.statements) {
  if (ts.isIfStatement(statement) && statement.thenStatement.getText(ast).includes('confirmExternalWrites(')) {
    exhaustionConfirmation = statement.getText(ast)
  }
}
assert.ok(exhaustionConfirmation, 'Exhaustion confirmation statement missing')
const extracted = functionText('confirmExternalWrites') + '\n'
  + `function finish(live, outcome) { const observedSteps = 1, bind = { tabId: 'fixture' }; while (true) { ${branchText('done')} break; } }\n`
  + `function exhaust(live, ex) { ${exhaustionConfirmation} }`
const compiled = ts.transpileModule(extracted, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const factory = new Function('markDirty', 'saveCheckpoint', 'currentUrlOf', 'str', 'setState', 'writeNoun',
  compiled + '; return { confirmExternalWrites, finish, exhaust };')
const api = factory(() => {}, () => {}, () => '', (s, fallback) => s || fallback,
  (task, state) => { task.state = state }, (write) => write.kind)
const mixed = () => ({ externalWrites: [
  { confirmed: false }, { kind: 'publish', confirmed: false },
  { kind: 'comment', confirmed: false }, { kind: 'like', confirmed: false },
] })

let task = mixed()
api.exhaust(task, { publishPending: false })
assert.deepEqual(task.externalWrites.map((w) => w.confirmed), [true, true, false, false])
task = mixed()
api.exhaust(task, { publishPending: true })
assert.ok(task.externalWrites.every((w) => !w.confirmed))
api.confirmExternalWrites(task)
assert.ok(task.externalWrites.every((w) => w.confirmed), 'Explicit user confirmation remains available')

for (const kind of ['comment', 'like']) {
  for (const evidence of ['unrelated report saved', 'publication observed', undefined]) {
    task = { externalWrites: [{ kind, confirmed: false }] }
    api.finish(task, { kind: 'done', message: 'done', evidence })
    assert.equal(task.state, 'needs-verify')
    assert.equal(task.externalWrites[0].confirmed, false)
  }
}
for (const externalWrites of [[], [{ kind: 'publish', confirmed: false }]]) {
  task = { externalWrites }
  api.finish(task, { kind: 'done', evidence: externalWrites.length ? 'publication observed' : 'read-only' })
  assert.equal(task.state, 'completed')
  assert.ok(task.externalWrites.every((w) => w.confirmed))
}
console.log('PASS: external write evidence — exhaustion, mixed kinds, unrelated evidence, explicit confirmation, read-only/publication completion')
