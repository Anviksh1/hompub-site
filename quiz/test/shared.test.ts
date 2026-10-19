// Unit tests for the pure helpers. Run with: node --test test/shared.test.ts
// (Node 22.18+ strips TypeScript types natively; no build step.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  isProfane,
  mergeSettings,
  sanitizeNick,
  scoreAnswer,
  validateQuiz,
} from '../src/shared.ts';

test('speed scoring follows the published formula', () => {
  // 2 s on a 30 s, 1000-point question → 967 (Kahoot's own worked example)
  assert.equal(scoreAnswer(true, 2000, 30, 1000, 'speed'), 967);
  assert.equal(scoreAnswer(true, 0, 20, 1000, 'speed'), 1000);
  assert.equal(scoreAnswer(true, 499, 20, 1000, 'speed'), 1000);  // under 0.5 s → full points
  assert.equal(scoreAnswer(true, 500, 20, 1000, 'speed'), 988);   // 1000 * (1 - (0.5/20)/2)
  assert.equal(scoreAnswer(true, 20000, 20, 1000, 'speed'), 500); // at the deadline → half
  assert.equal(scoreAnswer(true, 25000, 20, 1000, 'speed'), 500); // grace clamps to T
  assert.equal(scoreAnswer(true, 10000, 20, 2000, 'speed'), 1500); // double points
});

test('wrong, survey and accuracy answers', () => {
  assert.equal(scoreAnswer(false, 100, 20, 1000, 'speed'), 0);
  assert.equal(scoreAnswer(true, 100, 20, 0, 'speed'), 0);        // survey question
  assert.equal(scoreAnswer(true, 19000, 20, 1000, 'accuracy'), 1);
  assert.equal(scoreAnswer(false, 100, 20, 1000, 'accuracy'), 0);
});

test('coarse mode rounds elapsed up to whole seconds', () => {
  // 1.2 s → 2 s on a 20 s question: 1000 * (1 - (2/20)/2) = 950
  assert.equal(scoreAnswer(true, 1200, 20, 1000, 'coarse'), 950);
  assert.equal(scoreAnswer(true, 150, 20, 1000, 'coarse'), 975);  // 0.15 s → 1 s, no sub-second advantage
  assert.equal(scoreAnswer(true, 20000, 20, 1000, 'coarse'), 500);
});

test('validateQuiz accepts a good quiz and normalises defaults', () => {
  const r = validateQuiz({
    title: '  Week 6 ',
    questions: [{ text: 'Q?', options: ['a', 'b'], correct: 1 }],
  });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.title, 'Week 6');
    assert.equal(r.value.questions[0].timeLimit, 20);
    assert.equal(r.value.questions[0].points, 1000);
  }
});

test('validateQuiz rejects bad shapes with a readable error', () => {
  const cases: unknown[] = [
    null,
    { title: '', questions: [] },
    { title: 'x', questions: [] },
    { title: 'x', questions: [{ text: 'q', options: ['a'], correct: 0 }] },
    { title: 'x', questions: [{ text: 'q', options: ['a', 'b'], correct: 2 }] },
    { title: 'x', questions: [{ text: 'q', options: ['a', 'b'], correct: 0, timeLimit: 7 }] },
    { title: 'x', questions: [{ text: 'q', options: ['a', 'b'], correct: 0, points: 50 }] },
    { title: 'x', questions: [{ text: 'q', options: ['a', 'b', 'c', 'd', 'e'], correct: 0 }] },
    { title: 'x'.repeat(81), questions: [{ text: 'q', options: ['a', 'b'], correct: 0 }] },
  ];
  for (const c of cases) {
    const r = validateQuiz(c);
    assert.equal(r.ok, false, JSON.stringify(c).slice(0, 60));
    if (!r.ok) assert.ok(r.error.length > 0);
  }
});

test('mergeSettings only changes lobby-only fields in the lobby', () => {
  const inLobby = mergeSettings(DEFAULT_SETTINGS, { mode: 'accuracy', showOnDevices: true, bogus: 1 }, true);
  assert.equal(inLobby.mode, 'accuracy');
  assert.equal(inLobby.showOnDevices, true);
  const live = mergeSettings(DEFAULT_SETTINGS, { mode: 'accuracy', lateJoin: false }, false);
  assert.equal(live.mode, 'speed');
  assert.equal(live.lateJoin, false);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { mode: 'turbo' }, true).mode, 'speed');
});

test('sanitizeNick trims, strips control characters and caps length', () => {
  assert.equal(sanitizeNick('  Priya   S ​'), 'Priya S');
  assert.equal(sanitizeNick('a\u0000b c'), 'abc');
  assert.equal(sanitizeNick('x'.repeat(40)).length, 20);
  assert.equal(sanitizeNick(42), '');
  assert.equal(sanitizeNick('   '), '');
});

test('isProfane catches spacing and leetspeak but not ordinary names', () => {
  assert.equal(isProfane('sh1t head'), true);
  assert.equal(isProfane('F U C K'), true);
  assert.equal(isProfane('Priya'), false);
  assert.equal(isProfane('Scunthorpe'), true); // known false positive of substring filters; replaced by a spun name, never shown
  assert.equal(isProfane('Brave Otter'), false);
});
