// Unit tests for the pure helpers. Run with: node --test test/shared.test.ts
// (Node 22.18+ strips TypeScript types natively; no build step.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  LIMITS,
  csvEscape,
  hasResults,
  idlePlan,
  isProfane,
  joinName,
  legacyNicknameMode,
  mergeSettings,
  nameWords,
  normalizeSettings,
  renameCheck,
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

test('joinName: version-2 pages are told why; version-1 pages keep the old silent spin', () => {
  assert.deepEqual(joinName({ nameMode: 'typed', v2: true, nick: 'Priya', spin: false }), { kind: 'typed', nick: 'Priya', note: null });
  assert.equal(joinName({ nameMode: 'typed', v2: true, nick: 'shit', spin: false }).kind, 'reject');
  assert.equal(joinName({ nameMode: 'typed', v2: false, nick: 'shit', spin: false }).kind, 'random');
  assert.equal(joinName({ nameMode: 'typed', v2: true, nick: '   ', spin: false }).kind, 'reject');
  assert.equal(joinName({ nameMode: 'typed', v2: true, nick: '', spin: true }).kind, 'reject');   // no random names
  assert.equal(joinName({ nameMode: 'typed', v2: false, nick: '', spin: true }).kind, 'random');  // old Spin honoured
  assert.equal(joinName({ nameMode: 'either', v2: true, nick: '', spin: true }).kind, 'random');
  assert.equal(joinName({ nameMode: 'random', v2: true, nick: 'Priya', spin: false }).kind, 'random');
  const stripped = joinName({ nameMode: 'typed', v2: true, nick: '+91 Priya', spin: false });
  assert.ok(stripped.kind === 'typed' && stripped.nick === '91 Priya' && stripped.note?.reason === 'stripped');
  const long = joinName({ nameMode: 'typed', v2: true, nick: 'Abcdefghijklmnopqrstuvwxyz', spin: false });
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
