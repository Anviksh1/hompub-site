// Tests for public/import-text.js (Word / plain-text quiz import).
// Run with: node --test quiz/test/import-text.test.mjs   (Node 22; no dependencies)
//
// import-text.js is a classic browser script, so it is loaded into a vm context whose
// globals carry what the browser would provide: `window`, `module` (for the Node export),
// DecompressionStream and TextDecoder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'public', 'import-text.js'), 'utf8');

function load() {
  const mod = { exports: {} };
  const sandbox = { module: mod, DecompressionStream, TextDecoder, TextEncoder, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'import-text.js' });
  return { api: mod.exports, sandbox };
}
const { api, sandbox } = load();
const { parseQuizText, docxToText } = api;

// Results are built inside the vm realm, whose Array/Object prototypes differ from ours;
// structuredClone gives assert.deepEqual plain host-realm values to compare.
const parse = (text, options) => structuredClone(parseQuizText(text, options));
const messages = (r) => r.warnings.map((w) => w.message);
const q = (r, i = 0) => r.quiz.questions[i];

// ------------------------------------------------------------------ loading

test('defines window.HomPubImport and module.exports with the three functions', () => {
  assert.equal(sandbox.window.HomPubImport, api);
  assert.equal(typeof api.parseQuizText, 'function');
  assert.equal(typeof api.docxToText, 'function');
  assert.equal(typeof api.textFromFile, 'function');
});

// ------------------------------------------------------------------ question prefixes

test('numbered, lettered, bulleted and unprefixed questions', () => {
  const r = parse([
    '1. First?', 'A. a', 'B. b *', '',
    '2) Second?', 'A) a', 'B) b *', '',
    '(3) Third?', '(A) a', '(B) b *', '',
    'Q4. Fourth?', '[A] a', '[B] b *', '',
    'Q5: Fifth?', 'a. a', 'b. b *', '',
    'Question 6: Sixth?', 'a) a', 'b) b *', '',
    'Q. Seventh?', '- a', '- b *', '',
    'Q8 Eighth', '• a', '• b *', '',
    'Ninth ends with a question mark?', '– a', '– b *', '',
    'Tenth is just the first line of a block', '* a', '* b *', '',
    '#11. Eleventh?', '○ a', '○ b *', '',
    '1: Twelfth?', 'A: a', 'B: b *',
  ].join('\n'));
  assert.deepEqual(r.quiz.questions.map((x) => x.text), [
    'First?', 'Second?', 'Third?', 'Fourth?', 'Fifth?', 'Sixth?', 'Seventh?', 'Eighth',
    'Ninth ends with a question mark?', 'Tenth is just the first line of a block', 'Eleventh?', 'Twelfth?',
  ]);
  for (const x of r.quiz.questions) {
    assert.deepEqual(x.options, ['a', 'b']);
    assert.equal(x.correct, 1);
    assert.equal(x.timeLimit, 20);
    assert.equal(x.points, 1000);
  }
  assert.deepEqual(r.warnings, []);
  assert.equal(r.skipped, 0);
});

test('consecutive "?" lines without blank lines start new questions; a wrapped question joins', () => {
  const r = parse('1. Which of these\nis a mammal?\nA. Trout\nB. Dolphin*\nWhat is 2+2?\nA. 3\nB. 4 *');
  assert.equal(r.quiz.questions.length, 2);
  assert.equal(q(r, 0).text, 'Which of these is a mammal?');
  assert.equal(q(r, 1).text, 'What is 2+2?');
  assert.equal(q(r, 1).correct, 1);
  // at the very top of the text, a plain line followed by prose is the title (Word: heading + unnumbered question)
  const r2 = parse('Which of these\nis a mammal?\nA. Trout\nB. Dolphin*');
  assert.equal(r2.quiz.title, 'Which of these');
  assert.equal(q(r2).text, 'is a mammal?');
});

test('"1.5" and "10:30" are not question numbers; "e.g." is not an option letter', () => {
  const r = parse('1.5 is what kind of number?\nA. e.g. integer\nB. decimal *');
  assert.equal(q(r).text, '1.5 is what kind of number?');
  assert.deepEqual(q(r).options, ['e.g. integer', 'decimal']);
  const r2 = parse('10:30 is what time?\nA. morning *\nB. night');
  assert.equal(q(r2).text, '10:30 is what time?');
});

test('options on the same line as each other or as the question are split', () => {
  const r = parse('What is 2+2? A. 3 B. 4* C. 5\n\nCapital of France?\nA. Paris * B. London C) Berlin');
  assert.deepEqual(q(r, 0).options, ['3', '4', '5']);
  assert.equal(q(r, 0).correct, 1);
  assert.deepEqual(q(r, 1).options, ['Paris', 'London', 'Berlin']);
  assert.equal(q(r, 1).correct, 0);
  // not split when the letters do not run on, or when the question has no "?" / ":" before them
  const r2 = parse('Compare A. Smith and B. Jones?\nA. same\nB. different *');
  assert.equal(q(r2).text, 'Compare A. Smith and B. Jones?');
  assert.deepEqual(q(r2).options, ['same', 'different']);
});

test('options after a blank line belong to a question that has none yet', () => {
  const r = parse('1. What is 2+2?\n\nA. 3\nB. 4 *\n\n2. What is 3+3?\nA. 5\nB. 6 *\n\nAnswer: A');
  assert.equal(r.quiz.questions.length, 2);
  assert.deepEqual(q(r, 0).options, ['3', '4']);
  assert.equal(q(r, 0).correct, 1);
  // the stray "Answer: A" after a blank line applies to question 2 and conflicts with its star
  assert.equal(q(r, 1).correct, 1);
  assert.match(messages(r).join('\n'), /Question 2: the answer line says A but option B is marked/);
});

test('comment lines are ignored', () => {
  const r = parse('// a comment\nNote: for the teacher\n1. Q?\nA. a *\nB. b\nInstructions: delete me\nTip: nope\nExplanation: because');
  assert.equal(r.quiz.questions.length, 1);
  assert.deepEqual(r.warnings, []);
});

// ------------------------------------------------------------------ correct-answer markers

test('every marker form on the option line', () => {
  const cases = [
    ['A. Paris *', 'Paris'], ['A. Paris*', 'Paris'], ['A. *Paris', 'Paris'], ['*A. Paris', 'Paris'], ['* A) Paris', 'Paris'],
    ['A. Paris ✓', 'Paris'], ['A. Paris ✔', 'Paris'], ['A. Paris (correct)', 'Paris'], ['A. Paris (right)', 'Paris'],
    ['A. Paris [x]', 'Paris'], ['A. Paris (x)', 'Paris'], ['A. Paris <-- correct', 'Paris'], ['A. Paris <--', 'Paris'],
    ['A. Paris (correct answer)', 'Paris'], ['A. Paris [correct]', 'Paris'], ['A. Paris ← correct', 'Paris'],
    ['- [x] Paris', 'Paris'], ['[x] Paris', 'Paris'], ['A. ✓ Paris', 'Paris'], ['A. Paris. *', 'Paris.'],
  ];
  for (const [line, text] of cases) {
    const r = parse(`Capital of France?\n${line}\nB. London`);
    assert.equal(q(r).correct, 0, line);
    assert.equal(q(r).options[0], text, line);
    assert.deepEqual(r.warnings, [], line);
  }
  // "- [ ] London" is an unchecked box; "f(x)" keeps its parentheses
  const r = parse('Q?\n- [ ] London\n- [x] Paris\n- f(x)');
  assert.deepEqual(q(r).options, ['London', 'Paris', 'f(x)']);
  assert.equal(q(r).correct, 1);
});

test('"* A." on every option is a bullet, not a marker; two marked options warn', () => {
  const r = parse('Q?\n* A. one\n* B. two\n* C. three');
  assert.equal(q(r).correct, -1);
  assert.match(messages(r)[0], /no correct answer marked/);
  const r2 = parse('Q?\nA. one *\nB. two *\nC. three');
  assert.equal(q(r2).correct, 0);
  assert.match(messages(r2)[0], /more than one option is marked correct \(A, B\); using A/);
});

test('answer lines: letter, lower-case, Correct:, Key:, text, number, "B) London"', () => {
  const body = 'Q?\nA. Ribosome\nB. Mitochondrion\nC. Golgi body\n';
  for (const [line, idx] of [
    ['Answer: B', 1], ['Ans: b', 1], ['Correct: C', 2], ['Key: A', 0], ['Answer: Mitochondrion', 1],
    ['Answer: golgi-body.', 2], ['Answer: MITOCHONDRION!', 1], ['Answer - B', 1], ['Answer: B) Mitochondrion', 1],
    ['Answer: 3', 2], ['Answer: option C', 2], ['Correct answer: (b)', 1], ['Solution: a', 0], ['- Answer: C', 2],
  ]) {
    const r = parse(body + line);
    assert.equal(q(r).correct, idx, line);
    assert.deepEqual(r.warnings, [], line);
  }
});

test('answer lines that do not resolve, name several answers, or conflict', () => {
  const body = 'Q?\nA. Ribosome\nB. Mitochondrion\n';
  let r = parse(body + 'Answer: Nucleus');
  assert.equal(q(r).correct, -1);
  assert.match(messages(r)[0], /the answer "Nucleus" does not match any option/);
  assert.match(messages(r)[1], /no correct answer marked/);
  r = parse(body + 'Answer: D');
  assert.match(messages(r)[0], /says D but there are only 2 options/);
  r = parse(body + 'Answer: A, B');
  assert.equal(q(r).correct, -1);
  assert.match(messages(r)[0], /several answers/);
  assert.match(messages(r)[1], /no correct answer marked/);
  r = parse(body + 'Answer: A\nAnswer: B');
  assert.equal(q(r).correct, 1);
  assert.match(messages(r)[0], /several answer lines; using the last/);
  r = parse('Q?\nA. Ribosome *\nB. Mitochondrion\nAnswer: B');
  assert.equal(q(r).correct, 0);
  assert.match(messages(r)[0], /answer line says B but option A is marked/);
  // "Key: what is the key?" is a question, not an answer line
  r = parse('Key: what is the key signature?\nA. C major *\nB. G major');
  assert.equal(q(r).text, 'Key: what is the key signature?');
});

test('no marker at all -> correct -1 and a warning', () => {
  const r = parse('Q?\nA. a\nB. b');
  assert.equal(q(r).correct, -1);
  assert.deepEqual(r.warnings, [{ question: 1, message: 'Question 1: no correct answer marked — tick it in the editor' }]);
});

// ------------------------------------------------------------------ title

test('title detection', () => {
  assert.equal(parse('Biology quiz\n\n1. Q?\nA. a *\nB. b').quiz.title, 'Biology quiz');
  assert.equal(parse('Biology quiz\nWhich organelle?\nA. a *\nB. b').quiz.title, 'Biology quiz');
  assert.equal(parse('Title: Week 6\n1. Q?\nA. a *\nB. b').quiz.title, 'Week 6');
  assert.equal(parse('# Week 6\n1. Q?\nA. a *\nB. b').quiz.title, 'Week 6');
  // a numbered first line, a first line with "?", or a first line followed by its options is not a title
  assert.equal(parse('1. Q?\nA. a *\nB. b', { title: 'my-file' }).quiz.title, 'my-file');
  assert.equal(parse('Is this a title?\nA. a *\nB. b').quiz.title, 'Imported quiz');
  const r = parse('Capital of France\nA. Paris *\nB. London');
  assert.equal(r.quiz.title, 'Imported quiz');
  assert.equal(q(r).text, 'Capital of France');
  assert.equal(parse('1. Q?\nA. a *\nB. b', { title: '  ' }).quiz.title, 'Imported quiz');
});

// ------------------------------------------------------------------ time and points

test('time limits: lines, inline tags, snapping', () => {
  const body = 'Q?\nA. a *\nB. b\n';
  for (const [tag, want, warns] of [
    ['Time: 30', 30, false], ['Timer: 30 s', 30, false], ['30 seconds', 30, false], ['(30s)', 30, false],
    ['time limit = 60', 60, false], ['Time: 25', 30, true], ['Time: 7', 5, true], ['Time: 1000', 240, true], ['Time: 0', 5, true],
  ]) {
    const r = parse(body + tag);
    assert.equal(q(r).timeLimit, want, tag);
    assert.equal(r.warnings.length, warns ? 1 : 0, tag);
    if (warns) assert.match(messages(r)[0], /time limit of \d+ s is not available; using \d+ s/);
  }
  for (const tag of ['? (30s)', '? (30 s)', '? [30 seconds]', '? (Time: 30)', '? Time: 30', '? 30 seconds', ' - 30 seconds', ', 30 sec', '? (30s, double points)']) {
    const r = parse(`Name the capital${tag}\nA. a *\nB. b`);
    assert.equal(q(r).timeLimit, 30, tag);
    assert.match(q(r).text, /^Name the capital\??$/, tag);
  }
  assert.equal(q(parse('Q?\nA. a *\nB. b')).timeLimit, 20);
  // a parenthesis that is not a tag stays in the text
  assert.equal(q(parse('Distance to the Moon (in km)?\nA. a *\nB. b')).text, 'Distance to the Moon (in km)?');
});

test('points: lines, words, inline tags, snapping', () => {
  const body = 'Q?\nA. a *\nB. b\n';
  for (const [tag, want, warns] of [
    ['Points: 2000', 2000, false], ['double points', 2000, false], ['Double', 2000, false], ['Points: 1000', 1000, false],
    ['survey', 0, false], ['no points', 0, false], ['Points: 0', 0, false], ['Points: 500', 1000, true], ['Points: 1', 1000, true],
    ['Points: 1500', 2000, true], ['Points: 9000', 2000, true], ['2000 pts', 2000, false],
  ]) {
    const r = parse(body + tag);
    assert.equal(q(r).points, want, tag);
    assert.equal(r.warnings.length, warns ? 1 : 0, tag);
  }
  let r = parse('Q? (double points)\nA. a *\nB. b');
  assert.equal(q(r).points, 2000);
  assert.equal(q(r).text, 'Q?');
  r = parse('Q? (survey)\nA. a\nB. b');
  assert.equal(q(r).points, 0);
  assert.equal(q(r).correct, -1); // a survey still reports the missing answer; the editor decides
  r = parse('Q? (30s, double points)\nA. a *\nB. b');
  assert.equal(q(r).timeLimit, 30);
  assert.equal(q(r).points, 2000);
});

// ------------------------------------------------------------------ limits

test('truncation warnings for title, question text and options', () => {
  const long = (n) => 'x'.repeat(n);
  const r = parse(`${long(90)}\n\n${long(250)}?\nA. ${long(100)} *\nB. b`);
  assert.equal(r.quiz.title.length, 80);
  assert.equal(q(r).text.length, 200);
  assert.equal(q(r).options[0].length, 80);
  assert.deepEqual(messages(r), [
    'Question 1: question text shortened to 200 characters',
    'Question 1: option A shortened to 80 characters',
    'Title shortened to 80 characters.',
  ]);
  // a surrogate pair is never cut in half
  const emoji = '😀'.repeat(45); // 90 UTF-16 units
  const r2 = parse(`Q?\nA. ${emoji} *\nB. b`);
  assert.equal(q(r2).options[0], '😀'.repeat(40));
});

test('a 5th option is dropped with a warning', () => {
  const r = parse('Q?\nA. a *\nB. b\nC. c\nD. d\nE. e\nF. f');
  assert.deepEqual(q(r).options, ['a', 'b', 'c', 'd']);
  assert.deepEqual(messages(r), ['Question 1: only 4 options are allowed; 2 extra options were dropped']);
  const r2 = parse('Q?\nA. a\nB. b\nC. c\nD. d\nE. e *');
  assert.equal(q(r2).correct, -1);
  assert.match(messages(r2)[0], /1 extra option was dropped \(one of them was marked correct/);
  // a bulleted 5th option counts too
  assert.equal(q(parse('Q?\n- a *\n- b\n- c\n- d\n- e')).options.length, 4);
});

test('a question with fewer than 2 options is skipped with a warning naming it', () => {
  const r = parse('1. Lonely question with a long text that goes on and on?\nA. only one\n\n2. Fine?\nA. a *\nB. b\n\n3. None at all?');
  assert.equal(r.quiz.questions.length, 1);
  assert.equal(q(r).text, 'Fine?');
  assert.equal(r.skipped, 2);
  assert.deepEqual(messages(r), [
    'Skipped "Lonely question with a long text that…": a question needs at least 2 options (found 1).',
    'Skipped "None at all?": a question needs at least 2 options (found 0).',
  ]);
  assert.deepEqual(r.warnings.map((w) => w.question), [null, null]);
});

test('options with no question line are kept with an empty text and a warning', () => {
  const r = parse('1. Q?\nA. a *\nB. b\nAnswer: A\nC. c\nD. d *');
  assert.equal(r.quiz.questions.length, 2);
  assert.equal(q(r, 1).text, '');
  assert.deepEqual(q(r, 1).options, ['c', 'd']);
  assert.match(messages(r).join('\n'), /Question 2: no question text found above these options/);
});

test('101 questions: 100 kept, the rest skipped with one warning', () => {
  const text = Array.from({ length: 101 }, (_, i) => `${i + 1}. Question ${i + 1}?\nA. a *\nB. b`).join('\n\n');
  const r = parse(text);
  assert.equal(r.quiz.questions.length, 100);
  assert.equal(q(r, 99).text, 'Question 100?');
  assert.equal(r.skipped, 1);
  assert.deepEqual(messages(r), ['Only the first 100 questions were kept; 1 more was skipped.']);
});

// ------------------------------------------------------------------ robustness

test('CRLF, CR, tabs, NBSP and zero-width characters give the same result as LF', () => {
  const lf = 'Title\n\n1. Q?\nA. a *\nB. b\n\n2. R?\nA. c\nB. d\nAnswer: B\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const cr = lf.replace(/\n/g, '\r');
  const messy = '﻿Title\n\n1.\tQ?\nA. a​ *\nB. b\n\n2. R?\n  A.   c  \nB. d\nAnswer: B\n';
  const base = parse(lf);
  assert.deepEqual(parse(crlf), base);
  assert.deepEqual(parse(cr), base);
  assert.deepEqual(parse(messy), base);
  assert.equal(base.quiz.title, 'Title');
  assert.equal(base.quiz.questions.length, 2);
});

test('empty, blank and junk input never throw', () => {
  for (const input of ['', '   \n\n\t', null, undefined]) {
    const r = parse(input);
    assert.deepEqual(r.quiz, { title: 'Imported quiz', questions: [] });
    assert.equal(r.warnings.length, 1);
    assert.equal(r.skipped, 0);
    assert.match(r.warnings[0].message, /empty/);
  }
  const r = parse('just some prose\nwith no questions in it');
  assert.equal(r.quiz.questions.length, 0);
  assert.match(messages(r).join('\n'), /No questions were found/);
  assert.equal(r.skipped, 1);
  const r2 = parse('Answer: B\nTime: 30\nA. orphan');
  assert.equal(r2.quiz.questions.length, 0);
  assert.equal(r2.skipped, 1);
  assert.equal(parse(12345).quiz.questions.length, 0);
});

test('the same text always yields the same result', () => {
  const text = readFileSync(new URL(import.meta.url)).toString().slice(0, 4000); // any text will do
  assert.deepEqual(parse(text), parse(text));
});

// ------------------------------------------------------------------ .docx

const crc32 = typeof zlib.crc32 === 'function' ? (buf) => zlib.crc32(buf) : (buf) => {
  let c = ~0;
  for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
};

// A tiny ZIP writer: local headers, data, central directory, end record. `deflate` picks method 8.
// An entry with `descriptor` sets general-purpose bit 3: the local header carries zero sizes and a
// data descriptor follows the data (what streaming writers produce). `zip64` writes the ZIP64
// "look elsewhere" markers (0xffff / 0xffffffff) into the end record.
function makeZip(entries, opts = {}) {
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const comp = e.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = e.deflate ? 8 : 0;
    const crc = crc32(raw);
    const flag = e.descriptor ? 0x08 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flag, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(e.descriptor ? 0 : crc, 14);
    local.writeUInt32LE(e.descriptor ? 0 : comp.length, 18); local.writeUInt32LE(e.descriptor ? 0 : raw.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const chunk = [local, name, comp];
    if (e.descriptor) {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(crc, 4); d.writeUInt32LE(comp.length, 8); d.writeUInt32LE(raw.length, 12);
      chunk.push(d);
    }
    parts.push(...chunk);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flag, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32); cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += chunk.reduce((n, c) => n + c.length, 0);
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(opts.zip64 ? 0xffff : entries.length, 8); end.writeUInt16LE(opts.zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(opts.zip64 ? 0xffffffff : offset, 16); end.writeUInt16LE(0, 20);
  const all = Buffer.concat([...parts, directory, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength); // a fresh ArrayBuffer
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const listP = (numId, ilvl, inner) => `<w:p w:rsidR="00AB12CD"><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${inner}</w:p>`;
const t = (s) => `<w:r><w:t xml:space="preserve">${s}</w:t></w:r>`;
const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${t('Cells &amp; energy')}</w:p>
<w:p/>
${listP(1, 0, `${t('Which organelle makes ')}<w:r><w:rPr><w:b/></w:rPr><w:t>ATP</w:t></w:r>${t('?')}`)}
${listP(1, 1, t('Ribosome'))}
${listP(1, 1, t('Mitochondrion *'))}
${listP(1, 1, `<w:r><w:t>Golgi</w:t><w:tab/><w:t>body</w:t></w:r>`)}
${listP(1, 1, `<w:r><w:t>Nucleus</w:t><w:br/><w:t>(control centre)</w:t><w:cr/></w:r>`)}
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr></w:pPr></w:p>
${listP(1, 0, `${t('Water is H&#8322;O &lt;true&gt; &quot;yes&quot; &#x26; &apos;ok&apos;?')}<w:del w:id="1" w:author="x"><w:r><w:delText xml:space="preserve">deleted words</w:delText></w:r></w:del><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`)}
<w:tbl><w:tblPr/><w:tr><w:tc>${`<w:p>${t('A. True *')}</w:p>`}</w:tc><w:tc><w:p>${t('B. False')}</w:p></w:tc></w:tr>
<w:tr><w:tc><w:p>${t('Time: 30')}</w:p></w:tc><w:tc><w:p>${t('Points: 2000')}</w:p></w:tc></w:tr></w:tbl>
${listP(2, 0, t('3. Already numbered?'))}
${listP(2, 1, t('yes'))}
${listP(2, 1, `${t('no ')}<w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>`)}
<w:sectPr/></w:body></w:document>`;

const NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}>
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0" w:tplc="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1" w:tplc="2"><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val=""/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:num w:numId="1" w16cid:durableId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="1"><w:lvl w:ilvl="1"><w:numFmt w:val="upperLetter"/></w:lvl></w:lvlOverride></w:num>
</w:numbering>`;

const EXPECTED_BODY = [
  'Cells & energy', '',
  '1. Which organelle makes ATP?', '- Ribosome', '- Mitochondrion *', '- Golgi body', '- Nucleus (control centre)', '',
  '2. Water is H₂O <true> "yes" & \'ok\'?', 'A. True *', 'B. False', 'Time: 30', 'Points: 2000',
  '3. Already numbered?',
];

test('docxToText: stored + deflated entries, paragraphs, auto-numbering, tab, break, entities, deleted text, table', async () => {
  const docx = makeZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES, deflate: false },
    { name: 'word/document.xml', data: DOCUMENT_XML, deflate: true },
  ]);
  const text = await docxToText(docx);
  assert.deepEqual(text.split('\n'), [...EXPECTED_BODY, '- yes', '- no ✓']);
  const r = parse(text, { title: 'file' });
  assert.equal(r.quiz.title, 'Cells & energy');
  assert.equal(r.quiz.questions.length, 3);
  assert.deepEqual(q(r, 0), { text: 'Which organelle makes ATP?', options: ['Ribosome', 'Mitochondrion', 'Golgi body', 'Nucleus (control centre)'], correct: 1, timeLimit: 20, points: 1000 });
  assert.deepEqual(q(r, 1), { text: 'Water is H₂O <true> "yes" & \'ok\'?', options: ['True', 'False'], correct: 0, timeLimit: 30, points: 2000 });
  assert.deepEqual(q(r, 2), { text: 'Already numbered?', options: ['yes', 'no'], correct: 1, timeLimit: 20, points: 1000 });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.skipped, 0);
  // a Uint8Array works too, and a deflated document.xml with a stored one gives the same text
  assert.equal(await docxToText(new Uint8Array(docx)), text);
  const stored = makeZip([{ name: 'word/document.xml', data: DOCUMENT_XML, deflate: false }, { name: '[Content_Types].xml', data: CONTENT_TYPES, deflate: true }]);
  assert.equal(await docxToText(stored), text);
});

test('docxToText uses word/numbering.xml when present: bullets, letters, decimal', async () => {
  const docx = makeZip([
    { name: 'word/document.xml', data: DOCUMENT_XML, deflate: true },
    { name: 'word/numbering.xml', data: NUMBERING_XML, deflate: true },
  ]);
  const lines = (await docxToText(docx)).split('\n');
  assert.deepEqual(lines, [
    'Cells & energy', '',
    '1. Which organelle makes ATP?', 'A. Ribosome', 'B. Mitochondrion *', 'C. Golgi body', 'D. Nucleus (control centre)', '',
    '2. Water is H₂O <true> "yes" & \'ok\'?', 'A. True *', 'B. False', 'Time: 30', 'Points: 2000',
    '3. Already numbered?', 'A. yes', 'B. no ✓',
  ]);
  const r = parse(lines.join('\n'));
  assert.equal(r.quiz.questions.length, 3);
  assert.deepEqual(r.warnings, []);
});

test('docxToText rejects a non-ZIP buffer and a ZIP without word/document.xml', async () => {
  await assert.rejects(docxToText(new TextEncoder().encode('This is a plain text file, not a zip archive at all. '.repeat(3)).buffer), /not a \.docx file/);
  await assert.rejects(docxToText(new ArrayBuffer(0)), /not a \.docx file/);
  await assert.rejects(docxToText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]).buffer), /not a \.docx file/);
  await assert.rejects(docxToText(makeZip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', deflate: false }])), /no word\/document\.xml/);
  // damaged deflate data is reported, not thrown as a zlib internal
  const bad = Buffer.from(makeZip([{ name: 'word/document.xml', data: DOCUMENT_XML, deflate: true }]));
  bad.fill(0xff, 40, 60);
  await assert.rejects(docxToText(bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength)), /damaged/);
});

test('the shipped Word template round-trips with no warnings', async () => {
  const file = readFileSync(path.join(here, '..', 'public', 'template-questions.docx'));
  const text = await docxToText(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const r = parse(text, { title: 'template-questions' });
  assert.equal(r.quiz.title, 'HomPub Quiz — question template');
  assert.equal(r.quiz.questions.length, 3);
  assert.deepEqual(r.quiz.questions.map((x) => x.correct), [1, 2, 2]);
  assert.deepEqual(r.quiz.questions.map((x) => x.timeLimit), [20, 30, 20]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.skipped, 0);
});

// ------------------------------------------------------------------ adversarial teacher input

test('Word smart quotes, non-breaking spaces and curly apostrophes pass through; NBSP is whitespace', () => {
  const r = parse('What is “water”?\nA. H2O *\nB. CO2\nC. Don’t know\nAnswer: A');
  assert.deepEqual(q(r), { text: 'What is “water”?', options: ['H2O', 'CO2', 'Don’t know'], correct: 0, timeLimit: 20, points: 1000 });
  assert.deepEqual(r.warnings, []);
  // an answer by text still matches when the teacher's quotes and the option's differ
  assert.equal(q(parse('Q?\nA. Paris’s river\nB. London\nAnswer: "Paris\'s river"')).correct, 0);
});

test('"a)" options with the right one in bold only -> -1 and a warning (bold is invisible in text)', () => {
  const r = parse('Which?\na) one\nb) two\nc) three');
  assert.deepEqual(q(r).options, ['one', 'two', 'three']);
  assert.equal(q(r).correct, -1);
  assert.deepEqual(messages(r), ['Question 1: no correct answer marked — tick it in the editor']);
});

test('"Answer: b." with a trailing period, "Answer B" with no colon, "Answer: (b)"', () => {
  for (const line of ['Answer: b.', 'Answer B', 'Answer b.', 'Ans: (b)', 'Answer: B.', 'Correct: b)']) {
    const r = parse(`Q?\nA. a\nB. b\n${line}`);
    assert.equal(q(r).correct, 1, line);
    assert.deepEqual(r.warnings, [], line);
  }
});

test('"Answer: B and D" is ambiguous: correct stays -1 with a warning', () => {
  for (const line of ['Answer: B and D', 'Answer: B & D', 'Key: b, d', 'Answer: A/B', 'Answer: both A and B']) {
    const r = parse(`Q?\nA. a\nB. b\nC. c\nD. d\n${line}`);
    assert.equal(q(r).correct, -1, line);
    assert.match(messages(r)[0], /names several answers/, line);
    assert.match(messages(r)[1], /no correct answer marked/, line);
  }
  // an option whose own text contains "and" still matches as a whole
  assert.equal(q(parse('Q?\nA. Salt and pepper\nB. Sugar\nAnswer: salt and pepper')).correct, 0);
});

test('"A." or "1." in the middle of a question line is not a marker', () => {
  let r = parse('Who wrote the A. Christie novels?\nA. Agatha *\nB. Bob');
  assert.equal(q(r).text, 'Who wrote the A. Christie novels?');
  assert.deepEqual(q(r).options, ['Agatha', 'Bob']);
  r = parse('Rule 1. says what?\nA. x *\nB. y');
  assert.equal(q(r).text, 'Rule 1. says what?');
  r = parse('See fig 1. What is shown?\n1. a cell\n2. a virus *');
  assert.equal(q(r).text, 'See fig 1. What is shown?');
  assert.deepEqual(q(r).options, ['a cell', 'a virus']);
  // an option whose text contains " B. " is not split when the letters do not run on
  assert.deepEqual(q(parse('Q?\nA. Plan A. B. Plan B *\nC. c')).options, ['Plan A. B. Plan B', 'c']);
});

test('numbered options "1. 3" "2. 4*" straight after a question are options, not questions', () => {
  let r = parse('What is 2+2?\n1. 3\n2. 4*\n3. 5');
  assert.deepEqual(q(r), { text: 'What is 2+2?', options: ['3', '4', '5'], correct: 1, timeLimit: 20, points: 1000 });
  assert.deepEqual(r.warnings, []);
  r = parse('1. What is 2+2?\n1) 3\n2) 4\n3) 5\nAnswer: 2\n\n2. What is 3+3?\n(1) 5\n(2) 6 ✓');
  assert.equal(r.quiz.questions.length, 2);
  assert.deepEqual(q(r, 0).options, ['3', '4', '5']);
  assert.equal(q(r, 0).correct, 1);
  assert.deepEqual(q(r, 1).options, ['5', '6']);
  assert.equal(q(r, 1).correct, 1);
  assert.deepEqual(r.warnings, []);
  // numbered questions with lettered options are untouched, even when their numbers restart at 1
  r = parse('1. One?\nA. a*\nB. b\n2. Two?\nA. a\nB. b*\n1. Three?\nA. a*\nB. b\n2. Four?\nA. a\nB. b*');
  assert.deepEqual(r.quiz.questions.map((x) => x.text), ['One?', 'Two?', 'Three?', 'Four?']);
  assert.deepEqual(r.quiz.questions.map((x) => x.correct), [0, 1, 0, 1]);
  // a run that does not count from 1, or follows an option, stays a list of questions
  r = parse('1. Q?\nA. a\nB. b *\n1. R?\n2. S?');
  assert.equal(r.quiz.questions.length, 1);
  assert.equal(r.skipped, 2);
});

test('everything on one line: "What is 2+2?  A. 3  B. 4*" (double spaces, tabs)', () => {
  for (const text of ['What is 2+2?  A. 3  B. 4*', 'What is 2+2?\tA.\t3\tB.\t4*', 'Q1. What is 2+2? A. 3 B. 4 (correct)']) {
    const r = parse(text);
    assert.deepEqual(q(r).options, ['3', '4'], text);
    assert.equal(q(r).correct, 1, text);
    assert.equal(q(r).text, 'What is 2+2?', text);
    assert.deepEqual(r.warnings, [], text);
  }
});

test('unnumbered questions separated only by blank lines', () => {
  const r = parse('First?\nA. a *\nB. b\n\n\n\nSecond?\nA. a\nB. b *\n\nThird (no question mark)\nA. a *\nB. b\n');
  assert.deepEqual(r.quiz.questions.map((x) => x.text), ['First?', 'Second?', 'Third (no question mark)']);
  assert.deepEqual(r.quiz.questions.map((x) => x.correct), [0, 1, 0]);
  assert.deepEqual(r.warnings, []);
});

test('trailing whitespace, Windows line endings and tabs between letter and text', () => {
  const r = parse('Q?   \r\nA.\ta *   \r\nB.\tb\t\t\r\na)\tc\r\n\r\n');
  assert.deepEqual(q(r), { text: 'Q?', options: ['a', 'b', 'c'], correct: 0, timeLimit: 20, points: 1000 });
  assert.deepEqual(r.warnings, []);
});

test('very long lines and 250 questions stay fast and bounded', () => {
  const t0 = performance.now();
  let r = parse('Q? ' + 'word '.repeat(5000) + '\nA. ' + 'y'.repeat(20000) + ' *\nB. b');
  assert.equal(q(r).text.length, 200);
  assert.equal(q(r).options[0].length, 80);
  assert.equal(q(r).correct, 0);
  for (const nasty of ['('.repeat(20000), '[x '.repeat(5000), '- '.repeat(20000), 'and '.repeat(20000)]) parse(`Q? ${nasty}\nA. a *\nB. b\nAnswer: ${nasty}`);
  r = parse(Array.from({ length: 250 }, (_, i) => `${i + 1}. Question ${i + 1}?\nA. a *\nB. b\nC. c\nD. d`).join('\n\n'));
  assert.equal(r.quiz.questions.length, 100);
  assert.equal(r.skipped, 150);
  assert.deepEqual(messages(r), ['Only the first 100 questions were kept; 150 more were skipped.']);
  assert.ok(performance.now() - t0 < 3000, 'parsing took too long');
});

test('emoji, Hindi, Arabic and Chinese text pass through untouched', () => {
  let r = parse('🧪 Which is 🔥?\nA. 🧊 ice\nB. 🔥 fire *');
  assert.deepEqual(q(r), { text: '🧪 Which is 🔥?', options: ['🧊 ice', '🔥 fire'], correct: 1, timeLimit: 20, points: 1000 });
  r = parse('भारत की राजधानी क्या है?\nA. मुंबई\nB. नई दिल्ली *\nC. कोलकाता\nAnswer: नई दिल्ली');
  assert.deepEqual(q(r).options, ['मुंबई', 'नई दिल्ली', 'कोलकाता']);
  assert.equal(q(r).text, 'भारत की राजधानी क्या है?');
  assert.equal(q(r).correct, 1);
  r = parse('ما هي عاصمة مصر؟\nA. القاهرة *\nB. الرياض\n\n中国的首都是哪里？\nA. 上海\nB. 北京 *');
  assert.deepEqual(r.quiz.questions.map((x) => x.text), ['ما هي عاصمة مصر؟', '中国的首都是哪里？']);
  assert.deepEqual(r.quiz.questions.map((x) => x.correct), [0, 1]);
  assert.deepEqual(r.warnings, []);
});

test('Devanagari numbers and letters ("१." "क. ख."), Hindi answer line, full-width "１．"', () => {
  let r = parse('१. भारत की राजधानी क्या है?\nक. मुंबई\nख. नई दिल्ली\nग. कोलकाता\nउत्तर: ख\n\n२. दो और दो?\nक. तीन\nख. चार *');
  assert.deepEqual(r.quiz.questions.map((x) => x.text), ['भारत की राजधानी क्या है?', 'दो और दो?']);
  assert.deepEqual(q(r, 0).options, ['मुंबई', 'नई दिल्ली', 'कोलकाता']);
  assert.deepEqual(r.quiz.questions.map((x) => x.correct), [1, 1]);
  assert.deepEqual(r.warnings, []);
  r = parse('１．これは？\nA. はい *\nB. いいえ\n\n２）二番？\nA. a\nB. b\nAnswer: २');
  assert.deepEqual(r.quiz.questions.map((x) => x.text), ['これは？', '二番？']);
  assert.deepEqual(r.quiz.questions.map((x) => x.correct), [0, 1]);
});

test('roman "(i) (ii)" options and bare "True" / "False" options', () => {
  let r = parse('Q?\n(i) one\n(ii) two ✓\n(iii) three\n(iv) four\n\nR?\ni. one\nii. two *');
  assert.deepEqual(q(r, 0).options, ['one', 'two', 'three', 'four']);
  assert.equal(q(r, 0).correct, 1);
  assert.deepEqual(q(r, 1).options, ['one', 'two']);
  assert.equal(q(r, 1).correct, 1);
  r = parse('Is water wet?\nTrue *\nFalse\n\nIs fire cold?\nTrue\nFalse *\n\nTrue or false: ice is cold?\nA. True *\nB. False');
  assert.deepEqual(r.quiz.questions.map((x) => x.options), [['True', 'False'], ['True', 'False'], ['True', 'False']]);
  assert.deepEqual(r.quiz.questions.map((x) => x.correct), [0, 1, 0]);
  assert.equal(q(r, 2).text, 'True or false: ice is cold?');
  assert.deepEqual(r.warnings, []);
});

test('an answer key at the end of the document fills in the answers by question number', () => {
  let r = parse('1. Q?\nA. a\nB. b\n\n2. R?\nA. c\nB. d\n\n3. S?\nA. e\nB. f *\n\nAnswer key:\n1. B\n2. A\n3. B\n4. C');
  assert.deepEqual(r.quiz.questions.map((x) => x.correct), [1, 0, 1]);
  assert.deepEqual(messages(r), ['The answer key names question 4, but there is no question 4.']);
  for (const key of ['Answers: 1-B, 2-A', 'Answer key: Q1: b  Q2: a.', 'ANSWERS\n\n1) b\n2) a', 'Key:\n1 - b\n2 - c', 'Solutions: 1. B 2. A']) {
    r = parse(`Q?\nA. a\nB. b\n\nR?\nA. c\nB. d\n\n${key}`);
    assert.deepEqual(r.quiz.questions.map((x) => x.correct), [1, 0], key);
    assert.deepEqual(r.warnings, [], key);
  }
  // by option text; a key that conflicts with a star warns and keeps the star
  assert.equal(q(parse('1. Q?\nA. Paris\nB. London\n\nKey:\n1 - London')).correct, 1);
  r = parse('1. Q?\nA. a *\nB. b\nAnswer key:\n1. B');
  assert.equal(q(r).correct, 0);
  assert.match(messages(r)[0], /says B but option A is marked/);
  // "Answers: B" for a single question and "Key: what is the key?" are not key blocks
  assert.equal(q(parse('Q?\nA. a\nB. b\nAnswers: B')).correct, 1);
  assert.equal(q(parse('Key: what is the key signature?\nA. C major *\nB. G major')).text, 'Key: what is the key signature?');
});

test('a bulleted "- 30 seconds" or "- double" is an option; "- Time: 30" is a tag', () => {
  const r = parse('How long?\n- 30 seconds\n- 2 hours *\n- Time: 30\n\nTwice as much?\n- double *\n- triple\n- Points: 2000');
  assert.deepEqual(q(r, 0).options, ['30 seconds', '2 hours']);
  assert.equal(q(r, 0).timeLimit, 30);
  assert.deepEqual(q(r, 1).options, ['double', 'triple']);
  assert.equal(q(r, 1).points, 2000);
  assert.deepEqual(r.warnings, []);
});

// ------------------------------------------------------------------ .docx edge cases

const W14 = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14 w15"';
const num = (id, lvl, inner) => `<w:p w14:paraId="0A0B0C0D" w14:textId="77777777" w:rsidR="00123456"><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${id}"/></w:numPr></w:pPr>${inner}</w:p>`;
const b = (s) => `<w:r w:rsidRPr="00AA"><w:rPr><w:b/><w:bCs/></w:rPr><w:t>${s}</w:t></w:r>`;
const W14_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W14}><w:body>
${num(3, 0, `<w:r><w:t xml:space="preserve">Which organelle makes </w:t></w:r><w:proofErr w:type="spellStart"/>${b('AT')}${b('P')}<w:r><w:t>?</w:t></w:r><w:proofErr w:type="spellEnd"/>`)}
${num(3, 1, '<w:r><w:t>Ribo</w:t></w:r><w:r w:rsidR="00B"><w:t>some</w:t></w:r>')}
${num(3, 1, `${b('Mito')}<w:r><w:rPr><w:b w:val="1"/></w:rPr><w:t>chondrion</w:t></w:r>`)}
${num(3, 1, '<w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>Golgi body</w:t></w:r>')}
${num(3, 0, '<w:r><w:t>Which gas do plants take in?</w:t></w:r>')}
${num(5, 0, '<w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>Carbon dioxide</w:t></w:r>')}
${num(5, 0, '<w:r><w:t>Oxygen</w:t></w:r>')}
${num(5, 0, '<w:r><w:rPr><w:u w:val="none"/></w:rPr><w:t>Helium</w:t></w:r>')}
<w:p><w:r><w:t>Both bold, so neither is marked:</w:t></w:r></w:p>
<w:p>${b('A. yes')}</w:p>
<w:p>${b('B. no')}</w:p>
<w:p><w:r><w:t xml:space="preserve">After box: </w:t></w:r><w:r><w:drawing><mc:AlternateContent><mc:Choice Requires="wps"><wps:txbx><w:txbxContent><w:p><w:r><w:t>inside the box</w:t></w:r></w:p></w:txbxContent></wps:txbx></mc:Choice><mc:Fallback><v:textbox><w:txbxContent><w:p><w:r><w:t>inside the box</w:t></w:r></w:p></w:txbxContent></v:textbox></mc:Fallback></mc:AlternateContent></w:drawing></w:r><w:r><w:t>after the box</w:t></w:r></w:p>
<w:sectPr/></w:body></w:document>`;
const W14_NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W14}>
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
<w:num w:numId="3"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="5"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

test('docxToText: w14/w15 namespaces, runs split mid-word, bold/highlight-only answers, per-list numbering, text boxes', async () => {
  const text = await docxToText(makeZip([{ name: 'word/document.xml', data: W14_DOCUMENT, deflate: true }, { name: 'word/numbering.xml', data: W14_NUMBERING, deflate: true }]));
  assert.deepEqual(text.split('\n'), [
    '1. Which organelle makes ATP?', 'A. Ribosome', 'B. Mitochondrion *', 'C. Golgi body',
    '2. Which gas do plants take in?', '1. Carbon dioxide *', '2. Oxygen', '3. Helium',
    'Both bold, so neither is marked:', 'A. yes', 'B. no',
    'After box: after the box', 'inside the box',
  ]);
  const r = parse(text);
  assert.equal(r.quiz.questions.length, 3);
  assert.deepEqual(q(r, 0), { text: 'Which organelle makes ATP?', options: ['Ribosome', 'Mitochondrion', 'Golgi body'], correct: 1, timeLimit: 20, points: 1000 });
  assert.deepEqual(q(r, 1), { text: 'Which gas do plants take in?', options: ['Carbon dioxide', 'Oxygen', 'Helium'], correct: 0, timeLimit: 20, points: 1000 });
  assert.equal(q(r, 2).correct, -1);
  // without numbering.xml the level-0 lists get "N." and level 1 "- "; the bold answer is still found
  const plain = await docxToText(makeZip([{ name: 'word/document.xml', data: W14_DOCUMENT, deflate: false }]));
  assert.deepEqual(plain.split('\n').slice(0, 8), [
    '1. Which organelle makes ATP?', '- Ribosome', '- Mitochondrion *', '- Golgi body',
    '2. Which gas do plants take in?', '1. Carbon dioxide *', '2. Oxygen', '3. Helium',
  ]);
  assert.equal(parse(plain).quiz.questions[1].correct, 0);
});

test('docxToText: data descriptors (sizes only in the central directory), ZIP64 markers, old .doc / password-protected files', async () => {
  const entries = [{ name: '[Content_Types].xml', data: CONTENT_TYPES, deflate: false, descriptor: true }, { name: 'word/document.xml', data: DOCUMENT_XML, deflate: true, descriptor: true }];
  const text = await docxToText(makeZip(entries));
  assert.deepEqual(text.split('\n').slice(0, 2), ['Cells & energy', '']);
  assert.equal(parse(text).quiz.questions.length, 3);
  await assert.rejects(docxToText(makeZip(entries, { zip64: true })), /ZIP64/);
  const cfb = new Uint8Array(1024);
  cfb.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  await assert.rejects(docxToText(cfb.buffer), /old \.doc file or a password-protected/);
});
