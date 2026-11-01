import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OutputBuffer } from '../src/main/process/outputBuffer.ts';
test('retained output is bounded even for one huge UTF8 chunk', () => {
  const buffer = new OutputBuffer(1024);
  buffer.append('я'.repeat(100000));
  const text = buffer.read();
  assert.ok(text.startsWith('[Earlier output omitted]'));
  assert.ok(Buffer.byteLength(text) < 1100);
  assert.ok(!text.includes('\ufffd'));
  buffer.clear(); assert.equal(buffer.read(), '');
  buffer.append('ready'); assert.equal(buffer.read(), 'ready');
});
