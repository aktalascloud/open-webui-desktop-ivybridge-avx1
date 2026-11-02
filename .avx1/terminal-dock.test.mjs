import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import ts from 'typescript'

const component = readFileSync(new URL('../src/renderer/src/lib/components/Main/Connections/TerminalDock.svelte', import.meta.url), 'utf8')
const tree = ts.createSourceFile('dock.ts', component.slice(component.indexOf('>') + 1, component.indexOf('</script>')), ts.ScriptTarget.Latest, true)
const names = new Set(['canStop', 'isBusy', 'operate'])
const functions = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
assert.equal(functions.length, 3)
const code = stripTypeScriptTypes(functions.map(node => node.getText(tree)).join('\n'))
function fixture() {
  const selected = []
  return new Function('select', `${code}; let pending = {}, errors = {};
    return {operate, pending, errors};`)(id => selected.push(id))
}

test('external reconnect uses the running action once and rejects a duplicate click until completion', async () => {
  const f = fixture()
  let complete, calls = 0
  const service = { id: 'open-terminal', status: 'started', pid: null, runningAction: 'reconnect',
    onStart: () => { throw Error('Do not create a replacement') },
    onRunningAction: () => { calls++; return new Promise(resolve => { complete = resolve }) } }
  const pending = f.operate(service)
  assert.equal(f.pending['open-terminal'], 'reconnect')
  await f.operate(service)
  assert.equal(calls, 1)
  complete()
  await pending
  assert.equal(f.pending['open-terminal'], undefined)
})

test('failed starts leave an explicit error and release their pending action', async () => {
  const f = fixture()
  let calls = 0
  await f.operate({ id: 'open-terminal', status: 'stopped', runningAction: 'stop',
    onStart: async () => { calls++; throw Error('synthetic unavailable') } })
  assert.equal(calls, 1)
  assert.match(f.errors['open-terminal'], /synthetic unavailable/)
  assert.equal(f.pending['open-terminal'], undefined)
})

test('a pending action on one service does not block a different service', async () => {
  const f = fixture()
  f.pending.server = 'restart'
  let calls = 0
  await f.operate({ id: 'open-terminal', status: 'stopped', runningAction: 'stop', onStart: async () => { calls++ } })
  assert.equal(calls, 1)
  assert.equal(f.pending.server, 'restart')
})
