// Unit tests for the pure helpers. Run with: node --test test/shared.test.ts
// (Node 22.18+ strips TypeScript types natively; no build step.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  LIMITS,
  csvEscape,
  displayRanks,
  hasResults,
  idlePlan,
  isProfane,
  joinName,
  legacyNicknameMode,
  mergeAway,
  mergeSettings,
  nameWords,
  normalizeSettings,
  renameCheck,
  sanitizeNick,
  scoreAnswer,
  scoreMulti,
  normalizeAnswer,
  typedRight,
  cleanTyped,
  cutText,
  codePoints,
  quizSchema,
  questionType,
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

test('sanitizeNick trims, strips control characters, formula triggers, and caps length', () => {
  assert.equal(sanitizeNick('=HYPERLINK("//x")'), 'HYPERLINK("//x")');
  assert.equal(sanitizeNick('-2+3'), '2+3');
  assert.equal(sanitizeNick('@@+='), '');
  assert.equal(sanitizeNick('  Priya   S \u200b'), 'Priya S');
  assert.equal(sanitizeNick('a\u0000b\u2028c'), 'abc');
  assert.equal(sanitizeNick('x'.repeat(40)).length, 20);
  assert.equal(sanitizeNick(42), '');
  assert.equal(sanitizeNick('   '), '');
});

test('isProfane catches spacing and leetspeak but not ordinary names', () => {
  assert.equal(isProfane('sh1t head'), true);
  assert.equal(isProfane('F U C K'), true);
  // Whole words only (brief, Phase 1): a run-together word is no longer caught. Documented trade-off.
  assert.equal(isProfane('fuckface'), false);
  assert.equal(isProfane('f.u.c.k'), true);
  assert.equal(isProfane('Fucking Otter'), true);
  assert.equal(isProfane('Priya'), false);
  assert.equal(isProfane('Brave Otter'), false);
  // Whole-token matching keeps real names that contain a short deny-list word.
  for (const name of ['Akshit', 'Dickens', 'Essex', 'Hancock', 'Nazir', 'Grape', 'Scunthorpe', 'Prickett', 'Alex Sexton']) {
    assert.equal(isProfane(name), false, name);
  }
});

test('csvEscape neutralises spreadsheet formula triggers', () => {
  assert.equal(csvEscape('Priya'), 'Priya');
  assert.equal(csvEscape(12), '12');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('=1+1'), '"\'=1+1"');
  assert.equal(csvEscape('@SUM(A1)'), '"\'@SUM(A1)"');
  assert.equal(csvEscape('-2'), '"\'-2"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
});

test('isProfane passes common Indian names, Devanagari and IAST spellings', () => {
  const names = [
    'Dikshit', 'Shital', 'Sushil', 'Kumari', 'Ashish', 'Harshita', 'Babita', 'Shitanshu', 'Hitesh', 'Ashok Kumar',
    'Dīkṣit', 'Śītal', 'Suśīl', 'Kumārī', 'Āśiṣ', 'Harṣitā', 'Bābitā', 'Kṛṣṇa', 'Ṛṣi Śarmā',
    'दीक्षित', 'शीतल', 'सुशील', 'कुमारी', 'आशीष', 'हर्षिता', 'बबीता', 'राम कुमार',
  ];
  for (const name of names) assert.equal(isProfane(name), false, name);
});

test('isProfane no longer matches letters across separate words', () => {
  // The old letters-run-together check flagged these (hitler, asshole, bastard, nigga).
  for (const name of ['Mohit Lerch', 'Ashit Lerner', 'Vikas Shole', 'Abbas Tarde', 'Niggam']) {
    assert.equal(isProfane(name), false, name);
  }
});

test('nameWords folds accents and joins single letters', () => {
  assert.deepEqual(nameWords('Dīkṣit'), ['diksit']);
  assert.deepEqual(nameWords('F U C K'), ['fuck']);
  assert.deepEqual(nameWords('J K Rowling'), ['jk', 'rowling']);
});

test('nameMode defaults to typed names; legacy values map for old rooms and old host pages', () => {
  assert.equal(DEFAULT_SETTINGS.nameMode, 'typed');
  assert.equal(DEFAULT_SETTINGS.allowRename, true);
  assert.equal(normalizeSettings({ nicknameMode: 'spin' }).nameMode, 'random');
  assert.equal(normalizeSettings({ nicknameMode: 'free' }).nameMode, 'either');
  assert.equal(normalizeSettings({}).nameMode, 'typed');
  assert.equal(normalizeSettings({ nameMode: 'random', nicknameMode: 'free' }).nicknameMode, 'spin');
  assert.equal(legacyNicknameMode('typed'), 'free');
  assert.equal(legacyNicknameMode('either'), 'free');
  assert.equal(legacyNicknameMode('random'), 'spin');
  const m = mergeSettings(DEFAULT_SETTINGS, { nameMode: 'random' }, true);
  assert.equal(m.nameMode, 'random');
  assert.equal(m.nicknameMode, 'spin');
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { nameMode: 'random' }, false).nameMode, 'typed'); // lobby only
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { allowRename: false }, false).allowRename, false); // any time
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { nicknameMode: 'spin' }, true).nameMode, 'random');
});

test('joinName: an unusable name is refused with a reason, never swapped silently', () => {
  assert.deepEqual(joinName({ nameMode: 'typed', nick: 'Priya', spin: false }), { kind: 'typed', nick: 'Priya', note: null });
  assert.equal(joinName({ nameMode: 'typed', nick: 'shit', spin: false }).kind, 'reject');
  assert.equal(joinName({ nameMode: 'typed', nick: '   ', spin: false }).kind, 'reject');
  assert.equal(joinName({ nameMode: 'typed', nick: '', spin: true }).kind, 'reject');   // no random names
  assert.equal(joinName({ nameMode: 'either', nick: '', spin: true }).kind, 'random');
  assert.equal(joinName({ nameMode: 'random', nick: 'Priya', spin: false }).kind, 'random');
  assert.deepEqual(joinName({ nameMode: 'random', nick: 'Priya', spin: false }), { kind: 'random', replaced: true });   // told why
  assert.deepEqual(joinName({ nameMode: 'random', nick: '', spin: true }), { kind: 'random' });
  const stripped = joinName({ nameMode: 'typed', nick: '+91 Priya', spin: false });
  assert.ok(stripped.kind === 'typed' && stripped.nick === '91 Priya' && stripped.note?.reason === 'stripped');
  const long = joinName({ nameMode: 'typed', nick: 'Abcdefghijklmnopqrstuvwxyz', spin: false });
  assert.ok(long.kind === 'typed' && long.nick.length === LIMITS.nickChars && long.note?.reason === 'shortened');
});

test('renameCheck enforces the setting, the limit, the mode and the filter', () => {
  const base = { allowRename: true, nameMode: 'typed' as const, renames: 0, current: 'Brave Otter' };
  assert.deepEqual(renameCheck({ ...base, nick: 'Priya' }), { ok: true, kind: 'typed', nick: 'Priya', note: null });
  assert.equal(renameCheck({ ...base, allowRename: false, nick: 'Priya' }).ok, false);
  assert.equal(renameCheck({ ...base, renames: LIMITS.maxRenames, nick: 'Priya' }).ok, false);
  assert.equal(renameCheck({ ...base, random: true }).ok, false);                          // typed only
  assert.deepEqual(renameCheck({ ...base, nameMode: 'either', random: true }), { ok: true, kind: 'random' });
  assert.equal(renameCheck({ ...base, nameMode: 'random', nick: 'Priya' }).ok, false);     // random only
  const filtered = renameCheck({ ...base, nick: 'sh1t' });
  assert.ok(!filtered.ok && filtered.reason === 'filtered' && filtered.message === 'Please choose another name.');
  assert.equal(renameCheck({ ...base, nick: 'brave otter' }).ok, false);                   // same name
  assert.equal(renameCheck({ ...base, nick: '' }).ok, false);
});

test('idlePlan keeps the 2-hour and 30-minute rules and warns 15 minutes ahead', () => {
  const t = 1_700_000_000_000;
  assert.deepEqual(idlePlan({ phase: 'open', lastActivity: t, phaseAt: t }), { wipeAt: t + LIMITS.ttlActiveMs, warnAt: t + LIMITS.ttlActiveMs - LIMITS.expiryWarnMs });
  assert.deepEqual(idlePlan({ phase: 'ended', lastActivity: t, phaseAt: t }), { wipeAt: t + LIMITS.ttlFinishedMs, warnAt: null });
  assert.equal(idlePlan({ phase: 'lobby', lastActivity: t, phaseAt: t, scale: 0.001 }).wipeAt, t + LIMITS.ttlActiveMs * 0.001);
});

test('hasResults: an idle wipe destroys results once a question has been played', () => {
  assert.equal(hasResults('lobby', -1), false);
  assert.equal(hasResults('intro', 0), false);   // the first question has not opened
  assert.equal(hasResults('open', 0), true);
  assert.equal(hasResults('closed', 0), true);
  assert.equal(hasResults('intro', 1), true);
  assert.equal(hasResults('podium', 4), true);
  assert.equal(hasResults('ended', 4), false);   // already sent at End
});

test('invisible characters cannot split a filtered word, and are removed from the name shown', () => {
  for (const raw of ['fu⁠ck', 'nig­ger', 'sh​it', 'b᠎itch', 'f\u{E0020}uck', 'cuㅤnt']) {
    const nick = sanitizeNick(raw);
    assert.equal(isProfane(nick), true, JSON.stringify(raw));
    assert.equal(renameCheck({ allowRename: true, nameMode: 'typed', renames: 0, current: 'Priya', nick: raw }).ok, false, JSON.stringify(raw));
  }
  assert.equal(sanitizeNick('Pri­ya'), 'Priya');
  assert.equal(sanitizeNick('ㅤ'), '');                         // a blank-looking name is no name
  assert.equal(sanitizeNick('❤️ Asha'), '❤️ Asha');                   // emoji presentation selector kept
  assert.equal(isProfane(sanitizeNick('Dīkṣit')), false);
});

test('a room stored before allowRename existed gets it only while still in the lobby', () => {
  const stored = { mode: 'speed', showOnDevices: false, lateJoin: true, earlyClose: true, nicknameMode: 'free' };
  assert.equal(normalizeSettings(stored, 'lobby').allowRename, true);
  for (const phase of ['intro', 'open', 'closed', 'podium', 'ended'] as const) assert.equal(normalizeSettings(stored, phase).allowRename, false, phase);
  assert.equal(normalizeSettings({ ...stored, allowRename: true }, 'open').allowRename, true);   // the host turned it back on
  assert.equal(normalizeSettings(stored).allowRename, DEFAULT_SETTINGS.allowRename);               // a new room
});

test('Focus check is off by default, kept when stored, and changed through settings', () => {
  assert.equal(DEFAULT_SETTINGS.focusCheck, false);
  assert.equal(normalizeSettings({}).focusCheck, false);
  assert.equal(normalizeSettings({ focusCheck: 'yes' }).focusCheck, false);
  assert.equal(normalizeSettings({ focusCheck: true }).focusCheck, true);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { focusCheck: true }, false).focusCheck, true);
  assert.equal(mergeSettings({ ...DEFAULT_SETTINGS, focusCheck: true }, { mode: 'accuracy' }, true).focusCheck, true);
});

test('mergeAway: running totals only go up, are clamped, and need a real leave or a blocked copy', () => {
  // 20 s question: at most 21 s away (with the 1 s grace).
  assert.deepEqual(mergeAway(null, { n: 1, ms: 4000 }, 20), { n: 1, ms: 4000, copies: 0 });
  assert.deepEqual(mergeAway(null, { n: 2, ms: 99_000, copies: 3 }, 20), { n: 2, ms: 21_000, copies: 3 });
  assert.equal(mergeAway(null, { n: 1, ms: 400 }, 20), null);            // under a second: noise
  assert.deepEqual(mergeAway(null, { n: 1, ms: 400, copies: 1 }, 20), { n: 0, ms: 0, copies: 1 });
  assert.equal(mergeAway(null, { n: 0, ms: 0, copies: 0 }, 20), null);
  assert.equal(mergeAway(null, { n: 'x', ms: 1000 }, 20), null);
  assert.equal(mergeAway(null, { ms: 5000 }, 20), null);
  const prev = { n: 3, ms: 9000, copies: 2 };
  assert.deepEqual(mergeAway(prev, { n: 1, ms: 2000, copies: 0 }, 20), prev);   // a reloaded page cannot lower it
  assert.deepEqual(mergeAway(prev, { n: 4, ms: 12_000, copies: 2 }, 20), { n: 4, ms: 12_000, copies: 2 });
  assert.deepEqual(mergeAway(null, { n: 1e9, ms: 5000, copies: 1e9 }, 20), { n: 100, ms: 5000, copies: 1000 });
  assert.deepEqual(mergeAway(null, { n: -3, ms: -5, copies: 2 }, 20), { n: 0, ms: 0, copies: 2 });
});

test('displayRanks: equal scores share a place and are marked tied', () => {
  const r = displayRanks([
    { pid: 'a', score: 3000 }, { pid: 'b', score: 2000 }, { pid: 'c', score: 2000 }, { pid: 'd', score: 0 }, { pid: 'e', score: 0 },
  ]);
  assert.deepEqual(r.get('a'), { rank: 1, tied: false });
  assert.deepEqual(r.get('b'), { rank: 2, tied: true });
  assert.deepEqual(r.get('c'), { rank: 2, tied: true });
  assert.deepEqual(r.get('d'), { rank: 4, tied: true });
  assert.deepEqual(r.get('e'), { rank: 4, tied: true });
  assert.equal(displayRanks([]).size, 0);
});

// ------------------------------------------------------------ Phase 3 (schema 2)

const KEY = 'a'.repeat(64) + '.webp';

test('validateQuiz: a schema-1 quiz comes out exactly as before', () => {
  const r = validateQuiz({ title: 'T', questions: [{ text: 'Q?', options: [' a ', 'b'], correct: 1, timeLimit: 30, points: 2000, extra: 1 }] });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value.questions[0], { text: 'Q?', options: ['a', 'b'], correct: 1, timeLimit: 30, points: 2000 });
});

test('validateQuiz: multi-select, typed answer and poll questions', () => {
  const r = validateQuiz({
    title: 'T',
    questions: [
      { type: 'multi', text: 'Primes?', options: ['2', '4', '5', '9'], correct: [2, 0, 2] },
      { type: 'multi', text: 'Primes?', options: ['2', '4'], correct: [0], partial: true },
      { type: 'typein', text: 'Capital of France?', accept: [' Paris ', 'paris', 'Paname'] },
      { type: 'poll', text: 'Enjoying it?', options: ['Yes', 'No'] },
    ],
  });
  assert.ok(r.ok, !r.ok ? r.error : '');
  if (!r.ok) return;
  const [m, m2, t, p] = r.value.questions;
  assert.deepEqual(m, { type: 'multi', text: 'Primes?', options: ['2', '4', '5', '9'], correct: [0, 2], partial: false, timeLimit: 20, points: 1000 });
  assert.equal(m2.type === 'multi' && m2.partial, true);
  assert.deepEqual(t, { type: 'typein', text: 'Capital of France?', accept: ['Paris', 'Paname'], timeLimit: 20, points: 1000 });
  assert.deepEqual(p, { type: 'poll', text: 'Enjoying it?', options: ['Yes', 'No'], timeLimit: 20, points: 0 });
  assert.equal(questionType(m), 'multi');
  assert.equal(questionType({}), 'single');
});

test('validateQuiz: explanation, picture and the 400-character limit', () => {
  const long = 'क'.repeat(400);
  const r = validateQuiz({ title: 'T', questions: [{ text: long, options: ['a', 'b'], correct: 0, explanation: ' Because. ', image: { key: KEY, alt: ' A cell ', w: 800, h: 600 } }] });
  assert.ok(r.ok, !r.ok ? r.error : '');
  if (r.ok) {
    assert.equal(r.value.questions[0].explanation, 'Because.');
    assert.deepEqual(r.value.questions[0].image, { key: KEY, alt: 'A cell', w: 800, h: 600 });
  }
  const bad: unknown[] = [
    { text: 'x'.repeat(401), options: ['a', 'b'], correct: 0 },
    { type: 'quiz', text: 'q', options: ['a', 'b'], correct: 0 },
    { type: 'multi', text: 'q', options: ['a', 'b'], correct: [] },
    { type: 'multi', text: 'q', options: ['a', 'b'], correct: [2] },
    { type: 'multi', text: 'q', options: ['a', 'b'], correct: 0 },
    { type: 'typein', text: 'q', accept: [] },
    { type: 'typein', text: 'q', accept: ['...'] },
    { type: 'typein', text: 'q', accept: ['a'], options: ['a', 'b'] },
    { type: 'typein', text: 'q', accept: Array.from({ length: 11 }, (_, i) => `a${i}`) },
    { type: 'poll', text: 'q', options: ['a', 'b'], points: 1000 },
    { type: 'poll', text: 'q', options: ['a'] },
    { text: 'q', options: ['a', 'b'], correct: 0, image: { key: 'x.webp', alt: 'a' } },
    { text: 'q', options: ['a', 'b'], correct: 0, image: { key: KEY, alt: '' } },
    { text: 'q', options: ['a', 'b'], correct: 0, image: { key: KEY, alt: 'a', w: 0 } },
    { text: 'q', options: ['a', 'b'], correct: 0, explanation: 'x'.repeat(401) },
  ];
  for (const q of bad) {
    const v = validateQuiz({ title: 'T', questions: [q] });
    assert.equal(v.ok, false, JSON.stringify(q).slice(0, 80));
  }
});

test('quizSchema: 2 once a quiz uses anything a schema-1 page cannot keep', () => {
  assert.equal(quizSchema({ questions: [{ text: 'q', options: ['a', 'b'], correct: 0 }] }), 1);
  assert.equal(quizSchema({ questions: [{ type: 'single', text: 'q' }] }), 1);
  assert.equal(quizSchema({ questions: [{ type: 'poll', text: 'q' }] }), 2);
  assert.equal(quizSchema({ questions: [{ text: 'q', explanation: '' }] }), 2);
  assert.equal(quizSchema({ questions: [{ text: 'q', image: { key: KEY, alt: 'a' } }] }), 2);
  assert.equal(quizSchema({ questions: [{ text: 'x'.repeat(201) }] }), 2);
  assert.equal(quizSchema({ questions: [{ text: 'x'.repeat(200) }] }), 1);
});

test('scoreMulti: all or nothing, and partial credit beside the unchanged scoreAnswer', () => {
  const full = scoreAnswer(true, 2000, 30, 1000, 'speed');
  assert.deepEqual(scoreMulti([0, 2], [0, 2], false, 2000, 30, 1000, 'speed'), { points: full, right: true });
  assert.deepEqual(scoreMulti([2, 0, 0], [0, 2], false, 2000, 30, 1000, 'speed'), { points: full, right: true });
  assert.deepEqual(scoreMulti([0], [0, 2], false, 2000, 30, 1000, 'speed'), { points: 0, right: false });
  assert.deepEqual(scoreMulti([0], [0, 2], true, 2000, 30, 1000, 'speed'), { points: Math.round(full / 2), right: false });
  assert.deepEqual(scoreMulti([0, 1], [0, 2], true, 2000, 30, 1000, 'speed'), { points: 0, right: false });   // one right, one wrong
  assert.deepEqual(scoreMulti([0, 2, 3], [0, 2], true, 2000, 30, 1000, 'speed'), { points: Math.round(full / 2), right: false });
  assert.deepEqual(scoreMulti([1, 3], [0, 2], true, 2000, 30, 1000, 'speed'), { points: 0, right: false });
  assert.deepEqual(scoreMulti([0], [0, 2], true, 2000, 30, 1000, 'accuracy'), { points: 0, right: false });
  assert.deepEqual(scoreMulti([0, 2], [0, 2], true, 2000, 30, 1000, 'accuracy'), { points: 1, right: true });
  assert.deepEqual(scoreMulti([0, 2], [0, 2], true, 2000, 30, 0, 'speed'), { points: 0, right: true });
});

test('normalizeAnswer: case, Latin accents and IAST ignored; Devanagari signs kept', () => {
  assert.equal(normalizeAnswer('  New   Delhi. '), 'new delhi');
  assert.equal(normalizeAnswer('“Paris”'), 'paris');
  assert.equal(normalizeAnswer('Kṛṣṇa'), 'krsna');
  assert.equal(normalizeAnswer('Śiva'), normalizeAnswer('siva'));
  assert.equal(normalizeAnswer('ā ī ū ṛ ṣ ṇ ś ṃ'), 'a i u r s n s m');
  assert.equal(normalizeAnswer('-5'), '-5');
  assert.equal(normalizeAnswer('C++'), 'c++');
  assert.equal(normalizeAnswer('राम।'), 'राम');
  // Vowel signs and virama change the word: they are never stripped.
  assert.notEqual(normalizeAnswer('कि'), normalizeAnswer('क'));
  assert.notEqual(normalizeAnswer('क्'), normalizeAnswer('क'));
  assert.notEqual(normalizeAnswer('कं'), normalizeAnswer('क'));
  // Zero-width joiners only change the shape.
  assert.equal(normalizeAnswer('क्‍ष'), normalizeAnswer('क्ष'));
  // Composed and decomposed forms are the same answer.
  assert.equal(normalizeAnswer('é'), normalizeAnswer('é'));
});

test('typedRight and cleanTyped', () => {
  assert.equal(typedRight('paris', ['Paris']), true);
  assert.equal(typedRight('Pariss', ['Paris']), false);
  assert.equal(typedRight('...', ['...x']), false);
  assert.equal(typedRight('Krishna', ['Kṛṣṇa', 'Krishna']), true);
  assert.equal(cleanTyped('  Pa\u0000ris \n'), 'Pa ris');
  assert.equal(cleanTyped(''), null);
  assert.equal(cleanTyped('   '), null);
  assert.equal(cleanTyped(5), null);
  assert.equal(cleanTyped('x'.repeat(81)), null);
  assert.equal(cleanTyped('क'.repeat(80)), 'क'.repeat(80));
});

test('shuffle is off by default and kept through settings', () => {
  assert.equal(DEFAULT_SETTINGS.shuffle, false);
  assert.equal(normalizeSettings({ shuffle: true }).shuffle, true);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { shuffle: true }, false).shuffle, true);
});

test('cutText cuts between letters: no lone vowel sign, virama or half conjunct', () => {
  assert.equal(cutText('Hello', 10), 'Hello');
  assert.equal(cutText('नमस्ते दुनिया', 4), 'नम');            // never "नमस्" (half of स्त)
  assert.equal(cutText('कि', 1), '');                        // the vowel sign never stands alone
  assert.equal(cutText('क्षमा', 2), '');
  assert.equal(cutText('क्षमा', 3), 'क्ष');
  assert.equal(cutText('Kṛṣṇa', 3), 'Kṛ');   // IAST written with combining dots
  assert.equal(cutText('a😀b', 2), 'a');                      // never half a surrogate pair
  assert.equal(cutText('क्‍ष', 3), '');
  // Names count code points: 20 at most, cut between letters.
  const name = 'कृष्णकृष्णकृष्णकृष्ण';                         // 4 × 5 = 20 code points
  assert.ok(codePoints(cutText(name + 'क', 20, codePoints)) <= 20);
  assert.equal(sanitizeNick('अर्जुन कृष्ण मुरारी गोपाल'), cutText('अर्जुन कृष्ण मुरारी गोपाल', 20, codePoints).trim());
  assert.doesNotMatch(sanitizeNick('अर्जुन कृष्ण मुरारी गोपाल'), /[्ा-ौ]$/u.source === '' ? /^$/ : /्$/u);
});
