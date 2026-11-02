import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import yaml from 'js-yaml'
import { FileMatcher, getNodeModuleFileMatcher } from 'app-builder-lib/out/fileMatcher.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const config = yaml.load(readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'))
const stats = { isDirectory: () => false }

test('actual builder patterns include generated app/assets and exclude source, caches and private runtime paths', () => {
  const matcher = new FileMatcher(root, path.join(root, 'synthetic-destination'), value => value, config.files)
  const accepts = matcher.createFilter()
  for (const value of ['out/main/index.js', 'out/preload/voice-input-preload.js', 'out/renderer/voice-input.html',
    'resources/sounds/chime-start.wav', 'package.json']) {
    assert.equal(accepts(path.join(root, value), stats), true, value)
  }
  for (const value of ['.avx1-work/private.db', 'cache/private.json', 'logs/runtime.log', '.env', '.npmrc',
    'src/main/index.ts', '.avx1/test_desktop_ui.cjs', 'out/main/index.js.map', 'resources/debug.pdb']) {
    assert.equal(accepts(path.join(root, value), stats), false, value)
  }
})

test('builder retains native production modules while dropping debug payloads, and all extra resources are named source files', () => {
  const matcher = getNodeModuleFileMatcher(root, path.join(root, 'synthetic-destination'), value => value, {}, { config, debugLogger: { isEnabled: false } })
  const accepts = matcher.createFilter()
  assert.equal(accepts(path.join(root, 'node_modules/node-pty/build/Release/pty.node'), stats), true)
  assert.equal(accepts(path.join(root, 'node_modules/node-pty/build/Release/pty.pdb'), stats), false)
  for (const item of config.extraResources) {
    assert.equal(existsSync(path.join(root, item.from)), true, item.from)
    assert.ok(!/cache|private|\.env/.test(item.from), item.from)
  }
  assert.ok(config.extraResources.some(item => item.to === 'licenses/Vazirmatn-LICENSE.txt'))
})
