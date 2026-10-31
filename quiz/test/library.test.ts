// Unit tests for the quiz library's pure checks. Run with: node --test test/library.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIBRARY, checkLibraryBody, contentHash, parseBaseVersion, parseIds } from '../src/library.ts';

const q = (over: Record<string, unknown> = {}) => ({ text: 'What is 2 + 2?', options: ['3', '4'], correct: 1, timeLimit: 20, points: 1000, ...over });

test('a draft with problems can be stored: blank text, unticked answer, long text', () => {
  const r = checkLibraryBody({ title: '', questions: [q({ text: '', correct: -1 }), q({ text: 'x'.repeat(500) })] });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.questionCount, 2);
    assert.equal(r.value.schema, 1);
  }
});

test('unknown fields are kept, byte for byte', () => {
  const body = { title: 'T', questions: [q({ explanation: 'kept' })], extra: { a: 1 } };
  const r = checkLibraryBody(body);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(JSON.parse(r.value.text), body);
});

test('the shape is enforced for schema 1', () => {
  assert.equal(checkLibraryBody(null).ok, false);
  assert.equal(checkLibraryBody([]).ok, false);
  assert.equal(checkLibraryBody({ title: 1, questions: [] }).ok, false);
  assert.equal(checkLibraryBody({ title: 'T', questions: {} }).ok, false);
  assert.equal(checkLibraryBody({ title: 'T', questions: [1] }).ok, false);
  assert.equal(checkLibraryBody({ title: 'T', questions: [q({ options: ['a', 'b', 'c', 'd', 'e'] })] }).ok, false);
  assert.equal(checkLibraryBody({ title: 'T', questions: [q({ options: ['a', 2] })] }).ok, false);
  assert.equal(checkLibraryBody({ title: 'T', questions: [q({ points: '1000' })] }).ok, false);
  assert.equal(checkLibraryBody({ title: 'T', questions: Array.from({ length: 101 }, () => q()) }).ok, false);
  assert.equal(checkLibraryBody({ title: 'T', questions: [], schema: 0 }).ok, false);
  assert.equal(checkLibraryBody({ title: 'T', questions: [], schema: 1.5 }).ok, false);
});

test('a newer schema is stored without looking inside', () => {
  const r = checkLibraryBody({ schema: 2, title: 'Future', questions: [{ type: 'typein', answers: ['x'] }, 'odd'] });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.schema, 2);
});

test('the 200 KB limit is in UTF-8 bytes', () => {
  const big = { title: 'T', questions: [q({ text: 'अ'.repeat(70_000) })] }; // 3 bytes each
  assert.equal(checkLibraryBody(big).ok, false);
  const ok = { title: 'T', questions: [q({ text: 'a'.repeat(150_000) })] };
  assert.equal(checkLibraryBody(ok).ok, true);
});

test('the content hash is SHA-256 of the stored text', async () => {
  assert.equal(await contentHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const r = checkLibraryBody({ title: 'T', questions: [q()] });
  assert.ok(r.ok);
  if (r.ok) assert.equal(await contentHash(r.value.text), await contentHash(JSON.stringify({ title: 'T', questions: [q()] })));
});

test('ids: 1 to 50, known characters, de-duplicated', () => {
  assert.deepEqual(parseIds('a,b,a'), ['a', 'b']);
  assert.equal(parseIds(''), null);
  assert.equal(parseIds(null), null);
  assert.equal(parseIds('a,b c'), null);
  assert.equal(parseIds(Array.from({ length: LIBRARY.batchIds + 1 }, (_, i) => `q${i}`).join(',')), null);
  assert.equal(parseIds(Array.from({ length: LIBRARY.batchIds }, (_, i) => `q${i}`).join(','))?.length, LIBRARY.batchIds);
});

test('baseVersion: a whole number from 0', () => {
  assert.equal(parseBaseVersion(0), 0);
  assert.equal(parseBaseVersion(7), 7);
  assert.equal(parseBaseVersion('12'), 12);
  assert.equal(parseBaseVersion(-1), null);
  assert.equal(parseBaseVersion(1.5), null);
  assert.equal(parseBaseVersion('1e3'), null);
  assert.equal(parseBaseVersion(undefined), null);
});
