// Unit tests for the picture helpers. Run with: node --test test/images.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMAGES, imageKey, imageKeysOf, sniffImage } from '../src/images.ts';
import { IMAGE_KEY_RE } from '../src/shared.ts';

const bytes = (...v: number[]) => new Uint8Array(v);

test('the format comes from the first bytes of the file', () => {
  assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0)), 'jpg');
  assert.equal(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), 'png');
  assert.equal(sniffImage(new TextEncoder().encode('GIF89a....')), 'gif');
  assert.equal(sniffImage(new TextEncoder().encode('GIF87a....')), 'gif');
  assert.equal(sniffImage(new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')), 'webp');
  assert.equal(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffImage(new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WAVE')), null);
  assert.equal(sniffImage(bytes(0xff, 0xd8)), null);
  assert.equal(sniffImage(bytes()), null);
});

test('a key is the SHA-256 of the file and its format', async () => {
  const k = await imageKey(new TextEncoder().encode('abc'), 'png');
  assert.equal(k, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad.png');
  assert.match(k, IMAGE_KEY_RE);
});

test('the keys a quiz uses, from any schema, de-duplicated', () => {
  const a = 'a'.repeat(64) + '.webp';
  const b = 'b'.repeat(64) + '.jpg';
  assert.deepEqual(imageKeysOf({ questions: [{ image: { key: a } }, { image: { key: b } }, { image: { key: a } }, { image: { key: '../x' } }, null, { image: 5 }] }), [a, b]);
  assert.deepEqual(imageKeysOf(null), []);
  assert.deepEqual(imageKeysOf({ questions: 'x' }), []);
});

test('unused pictures outlive the 7-day Time Travel window', () => {
  assert.ok(IMAGES.unusedMs > 7 * 24 * 60 * 60 * 1000);
  assert.ok(IMAGES.deleteBatch + 3 <= 100, 'D1 binds at most 100 parameters');
});
