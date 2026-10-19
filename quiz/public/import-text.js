/*
  HomPub Quiz — import-text.js. MIT licence. Part of HomPub Quiz.

  Turns questions typed in Word (.docx) or plain text into the Quiz shape of
  PROTOCOL.md §2, so a teacher can upload a file instead of filling in the
  editor. Classic script, plain ES2020, no dependencies. It defines
  window.HomPubImport (and module.exports when `module` exists, so node --test
  can load it) with:

    parseQuizText(text, { title })  -> { quiz, warnings, skipped }
    docxToText(arrayBuffer)         -> Promise<string>   (reads the .docx ZIP itself, no library)
    textFromFile(file)              -> Promise<string>   (browser only: File/Blob -> text)

  Accepted text — lenient, blank lines separate questions, every prefix is optional:

    Cell biology — week 6                <- a first line without "?" is the quiz title

    1. Which organelle makes ATP? (30s)  <- "1." "1)" "(1)" "Q1." "Question 1:" "Q." or just a line ending in "?"
    A. Ribosome                          <- "A." "A)" "(A)" "[A]" "a." or a bullet  -  •  –  *  ○
    B. Mitochondrion *                   <- the right option carries  *  ✓  ✔  (correct)  (right)  [x]  (x)  <-- correct
    C. Golgi body
    D. Nucleus

    Which gas do plants take in?
    - Oxygen
    - Carbon dioxide
    Answer: B                            <- ...or a line "Answer: B" / "Ans: carbon dioxide" / "Correct: B" / "Key: B"
    Time: 30                             <- optional; snapped to 5 10 15 20 30 60 90 120 240 seconds
    Points: 2000                         <- optional; 0 ("survey", "no points"), 1000, 2000 ("double points")

  "What is 2+2? A. 3  B. 4*  C. 5" on one line is split into options. Options
  may also be numbered ("1. 3" "2. 4*" straight after the question), roman
  "(i) (ii)", Devanagari "क. ख.", or a bare "True" / "False". An answer key at
  the end ("Answer key:" then "1. B" "2. A", or "Answers: 1-B, 2-A") fills in
  the answers by question number; "Answer: B and D" is ambiguous and is left
  unmarked. Lines starting with "//", "Note:", "Instructions:", "Tip:" or
  "Explanation:" are ignored. parseQuizText never throws on bad text: every
  problem comes back as a warning for the editor, and `skipped` counts blocks
  that could not become a question. docxToText also turns an option that is
  bold / underlined / highlighted on its own into "… *".
*/
(function () {
'use strict';

const TIME_LIMITS = [5, 10, 15, 20, 30, 60, 90, 120, 240];
const POINT_VALUES = [0, 1000, 2000];
const LIMITS = { title: 80, text: 200, option: 80, questions: 100, minOptions: 2, maxOptions: 4 };
const LETTERS = 'ABCDEFGH';

/* ===================================================================== 1. text helpers */

// Strip control and zero-width characters, collapse whitespace, trim.
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f​-‍⁠﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cut to `max` UTF-16 units (what validateQuiz counts) without splitting a surrogate pair.
function cut(s, max) {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.trim();
}

function shortQuote(s) { return s.length > 40 ? cut(s, 37) + '…' : s; }

// Nearest allowed value; a tie goes to the larger one (25 s -> 30 s, 1500 points -> 2000).
function snap(value, allowed) {
  let best = allowed[0];
  for (const v of allowed) {
    const d = Math.abs(v - value), bd = Math.abs(best - value);
    if (d < bd || (d === bd && v > best)) best = v;
  }
  return best;
}

// Letters and digits only, lower-cased: "Carbon dioxide." matches "carbon-dioxide".
function normKey(s) { return String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }

// Digits of other scripts (Devanagari "१.", Arabic-Indic, Bengali, Tamil, …, full-width "１.") -> ASCII,
// so "१." is a question number. Every listed block is 10 consecutive BMP code points, so lengths
// are preserved and offsets found on the converted string apply to the original.
const DIGIT_ZEROS = [0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xe50, 0xed0, 0xf20, 0x1040, 0xff10];
const OTHER_DIGIT_RE = new RegExp('[' + DIGIT_ZEROS.map((z) => String.fromCharCode(z) + '-' + String.fromCharCode(z + 9)).join('') + ']', 'g');
function asciiDigits(s) {
  return s.replace(OTHER_DIGIT_RE, (ch) => {
    const c = ch.charCodeAt(0);
    for (const z of DIGIT_ZEROS) if (c >= z && c <= z + 9) return String(c - z);
    return ch;
  });
}

/* ===================================================================== 2. line classification */

const COMMENT_RE = /^(?:\/\/|notes?\s*:|instructions?\s*:|tips?\s*:|hints?\s*:|explanation\s*:|comments?\s*:)/i;
const TITLE_PREFIX_RE = /^(?:#{1,6}\s+|(?:title|quiz title|quiz|topic)\s*[:\-–—]\s*)/i;
// "1." "1)" "(1)" "1:" "#1." "Q1." "Q 1)" "Question 1:" — but not "1.5" or "10:30".
const QNUM_RE = /^(?:(?:q|question|#)\s*)?(?:\(\s*\d{1,3}\s*\)|\d{1,3}\s*[.):\]．）](?!\d))\s*/i;
const QWORD_RE = /^(?:q|question)\s*\d{1,3}\b\s*[.):\-–—]?\s*/i;   // "Q1 What…"  "Question 2 What…"
const QBARE_RE = /^(?:q|question)\s*[.:)\-–—]\s*/i;                 // "Q. What…"  "Question: What…"
// "A." "A)" "(A)" "[A]" "A:" and lower-case "a." "a)" only when a space follows (so "e.g." is left alone).
// A–F, so a stray 5th or 6th option is still recognised as one (and dropped with a warning).
// Also Devanagari "क. ख. ग. घ." and roman "(i) (ii) (iii) (iv)" / "i. ii." (lower-case, space after).
const DEVA_LETTERS = 'कखगघ';
const ROMAN = { i: 'A', ii: 'B', iii: 'C', iv: 'D' };
const OPT_LETTER_RE = /^(?:\(([A-Fa-f])\)|\[([A-Fa-f])\]|([A-F])[.):]|([a-f])[.):](?=\s)|([कखगघ])[.):]|\((iv|i{1,3})\)|(iv|i{1,3})[.)](?=\s))\s*/;
// -> { letter: "A".."F", length } or null
function optionPrefix(s) {
  const m = OPT_LETTER_RE.exec(s);
  if (!m) return null;
  let letter;
  if (m[5]) letter = LETTERS[DEVA_LETTERS.indexOf(m[5])];
  else if (m[6] || m[7]) letter = ROMAN[m[6] || m[7]];
  else letter = (m[1] || m[2] || m[3] || m[4]).toUpperCase();
  return { letter, length: m[0].length };
}
const BULLET_RE = /^(?:[-*–—]\s+|[•○◦▪▫■□●·‣⁃➢➤►▶]\s*)/;
const STAR_LETTER_RE = /^[*★]\s*(?=\(?[A-Fa-f][.):\]]|\[[A-Fa-f]\])/;         // "*A. Paris"
const LEAD_MARK_RE = /^(?:[*★]+|✓|✔|✅|☑)\s*/;                                   // "A. *Paris"  "- ✓ Paris"
const CHECKBOX_RE = /^(?:\[\s*([xX✓✔])?\s*\]|\(\s*([xX✓✔])\s*\))\s*/;            // "- [x] Paris"  "- [ ] London"
const TRAIL_MARK_RE = /\s*(?:[*★]+|✓|✔|✅|☑|\(\s*(?:correct(?:\s+answer)?|right|answer|key)\s*\)|\[\s*(?:correct|right|answer)\s*\]|\s[\[(]\s*[xX✓✔]\s*[\])]|<-+\s*(?:correct|answer|right)?|←\s*(?:correct|answer|right)?)\s*$/i;
const ANSWER_RE = /^(?:answer key|answers?|ans|correct answer|right answer|correct|key|solution|उत्तर|जवाब|सही उत्तर)\s*[:=\-–—]\s*(.+)$/i;
const ANSWER_BARE_RE = /^(?:answers?|ans|correct|key|solution)\s+\(?([A-Ha-h])\)?[.)]?$/i;         // "Answer B"
// An answer key for the whole quiz: "Answer key:" / "Answers: 1-B, 2-A, 3-D" followed by "1. B" lines.
const KEY_HEAD_RE = /^(?:answer\s*keys?|answers|keys?|solutions?|correct\s+answers)\s*[:=\-–—]?\s*(.*)$/i;
const KEY_PAIRS_RE = /(?:q(?:uestion)?\s*)?(\d{1,3})\s*[.):\-–—=]?\s*\(?([A-Ha-h])\)?[.)]?(?=[\s,;]|$)/gi;
const KEY_PAIR_RE = /^(?:q(?:uestion)?\s*)?(\d{1,3})\s*[.):\-–—=]\s*([^?]{1,60})$/i;
const TIME_RE = /^(?:time limit|time|timer|limit|duration|seconds|secs)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)?\.?$/i;
const SECONDS_RE = /^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\.?$/i;
const POINTS_RE = /^(?:points?|pts|score|worth)\s*[:=]?\s*(\d+)\s*(?:pts?|points?)?\.?$/i;
const POINTS_N_RE = /^(\d+)\s*(?:pts?|points?)\.?$/i;
const POINTS_WORD_RE = /^(?:(double)(?:\s+points?)?|(survey|poll|no\s+points?|zero\s+points?))\.?$/i;

// "30s" / "Time: 30" / "double points" / "survey" -> { time } | { points } | null
function metaToken(piece) {
  const s = piece.trim().replace(/^[(\[]\s*|\s*[)\]]$/g, '');
  let m;
  if ((m = TIME_RE.exec(s)) || (m = SECONDS_RE.exec(s))) return { time: parseFloat(m[1]) };
  if ((m = POINTS_RE.exec(s)) || (m = POINTS_N_RE.exec(s))) return { points: parseInt(m[1], 10) };
  if ((m = POINTS_WORD_RE.exec(s))) return { points: m[1] ? 2000 : 0 };
  return null;
}

// Peel "(30s)", "[30 s, double points]", "… Time: 30", "…? 30 seconds" off the end of a question line.
function extractInlineMeta(text) {
  const out = { text, time: null, points: null };
  const apply = (t) => {
    if (t.time != null && out.time == null) out.time = t.time;
    if (t.points != null && out.points == null) out.points = t.points;
  };
  for (let guard = 0; guard < 4; guard++) {
    const s = out.text;
    let m, end = -1;
    if ((m = /\s*[(\[]([^()\[\]]{1,60})[)\]]\s*$/.exec(s))) {
      const toks = m[1].split(/\s*(?:[,;|/]|\band\b)\s*/i).filter(Boolean).map(metaToken);
      if (toks.length && toks.every(Boolean)) { toks.forEach(apply); end = m.index; }
    }
    if (end < 0 && (m = /(?:^|[\s,;:–—-])((?:time limit|time|timer|points?|pts)\s*[:=]\s*\d+\s*(?:s|sec|secs|seconds?|pts?|points?)?)\.?\s*$/i.exec(s))) {
      const t = metaToken(m[1]);
      if (t) { apply(t); end = m.index; }
    }
    if (end < 0 && (m = /([?!.;:,–—-])\s*(\d+\s*(?:s|sec|secs|seconds?)|double(?:\s+points?)?|survey|no\s+points?)\.?\s*$/i.exec(s))) {
      const t = metaToken(m[2]);
      if (t) { apply(t); end = m.index + 1; }
    }
    if (end < 0) break;
    out.text = s.slice(0, end).replace(/[\s,;:–—-]+$/, '').trim();
  }
  return out;
}

// Split "Paris B. London C) Berlin" into consecutive options when the letters run on from `first`.
function splitLettered(first, rest) {
  const parts = rest.split(/\s+(?=\(?[A-Fa-f][.)]\s)/);
  if (parts.length < 2) return null;
  const out = [{ letter: first, text: parts[0] }];
  for (let i = 1; i < parts.length; i++) {
    const m = /^\(?([A-Fa-f])[.)]\s*/.exec(parts[i]);
    if (!m || m[1].toUpperCase() !== LETTERS[LETTERS.indexOf(first) + i]) return null;
    out.push({ letter: m[1].toUpperCase(), text: parts[i].slice(m[0].length) });
  }
  return out;
}

// Pull the correct-answer markers off one option's text. `via` records how it was marked.
function finishOption(text, letter, correct, via) {
  let s = text, m;
  if ((m = CHECKBOX_RE.exec(s))) { if (m[1] || m[2]) { correct = true; via = 'mark'; } s = s.slice(m[0].length); }
  if ((m = LEAD_MARK_RE.exec(s))) { correct = true; via = 'mark'; s = s.slice(m[0].length); }
  for (let guard = 0; guard < 3 && (m = TRAIL_MARK_RE.exec(s)); guard++) {
    correct = true; via = 'mark'; s = s.slice(0, m.index);
  }
  return { kind: 'option', text: clean(s), correct, via, letter };
}

function classifyMeta(line) {
  let m = ANSWER_RE.exec(line);
  if (m && !/\?$/.test(m[1])) return { kind: 'answer', value: m[1].trim() };
  if ((m = ANSWER_BARE_RE.exec(line))) return { kind: 'answer', value: m[1] };
  const tok = metaToken(line);
  if (tok && tok.time != null) return { kind: 'time', value: tok.time };
  if (tok && tok.points != null) return { kind: 'points', value: tok.points };
  return null;
}

// "1-B, 2-A 3) d" or "Q1: B" -> [[1, "B"], …]; "3. Mitochondrion" -> [[3, "Mitochondrion"]]; else null.
function parseKeyPairs(s) {
  const out = [];
  const rest = s.replace(KEY_PAIRS_RE, (all, n, l) => { out.push([parseInt(n, 10), l.toUpperCase()]); return ' '; });
  if (out.length && /^[\s,;.]*$/.test(rest)) return out;
  const m = KEY_PAIR_RE.exec(s);
  return m ? [[parseInt(m[1], 10), m[2].trim()]] : null;
}

// "Answer key:" (pairs follow on the next lines) or "Answers: 1-B, 2-A". "Answers: B" is a plain answer line.
function classifyKeyHeader(line) {
  const m = KEY_HEAD_RE.exec(line);
  if (!m) return null;
  if (!m[1]) return { kind: 'keyhead', pairs: [] };
  const pairs = parseKeyPairs(m[1]);
  return pairs ? { kind: 'keyhead', pairs } : null;
}

function classifyOption(line) {
  let s = line, correct = false, via = null, letter = null, m, p;
  if ((m = STAR_LETTER_RE.exec(s))) { correct = true; via = 'leadstar'; s = s.slice(m[0].length); }
  if ((p = optionPrefix(s))) {
    letter = p.letter; s = s.slice(p.length);
  } else if (!via && (m = BULLET_RE.exec(s))) {
    s = s.slice(m[0].length);
    // "- Answer: B" / "- Time: 30" are meta lines; a bare "- 30 seconds" or "- double" is an option.
    const meta = classifyMeta(s);
    if (meta && (meta.kind === 'answer' || /^[a-z][a-z ]*\s*[:=]/i.test(s))) return meta;
    if ((p = optionPrefix(s))) { letter = p.letter; s = s.slice(p.length); }
  } else if (!via && !CHECKBOX_RE.test(s)) {
    const tf = finishOption(s, null, false, null);                  // "True *" / "False" need no prefix
    return /^(?:true|false)$/i.test(tf.text) ? tf : null;
  }
  const pieces = letter ? splitLettered(letter, s) : null;
  if (pieces) {
    return { kind: 'options', items: pieces.map((p, i) => finishOption(p.text, p.letter, i === 0 && correct, i === 0 ? via : null)) };
  }
  return finishOption(s, letter, correct, via);
}

function hasMarker(text) {
  const probe = asciiDigits(text);
  return QNUM_RE.test(probe) || QWORD_RE.test(probe) || QBARE_RE.test(text)
    || OPT_LETTER_RE.test(text) || BULLET_RE.test(text) || STAR_LETTER_RE.test(text);
}

function classifyLine(line) {
  const head = classifyKeyHeader(line);
  if (head) return head;
  const meta = classifyMeta(line);
  if (meta) return meta;
  const opt = classifyOption(line);
  if (opt) return opt;
  const probe = asciiDigits(line);
  let m;
  if ((m = QNUM_RE.exec(probe)) || (m = QWORD_RE.exec(probe))) {
    const num = parseInt((/\d{1,3}/.exec(m[0]) || [''])[0], 10);
    // `bare` = "1." "1)" "(1)" "1:" — a run of those straight after a question may be its options.
    return { kind: 'question', text: line.slice(m[0].length), num, bare: /^[(\d]/.test(m[0]) };
  }
  if ((m = QBARE_RE.exec(line))) return { kind: 'question', text: line.slice(m[0].length), num: null, bare: false };
  return { kind: 'text', text: line };
}

function classify(raw) {
  const line = clean(raw);
  if (!line) return { kind: 'blank' };
  if (COMMENT_RE.test(line)) return { kind: 'comment' };
  const it = classifyLine(line);
  it.raw = line;
  return it;
}

// "B" / "b)" / "option 2" / "Mitochondrion" -> option index, or -1 with a note.
function resolveAnswer(value, options) {
  const v = value.replace(/^(?:option|choice|letter)\s+/i, '').replace(/[.\s]+$/, '').trim();
  const key = normKey(v);
  if (key) {
    const i = options.findIndex((o) => normKey(o) === key);
    if (i >= 0) return { index: i, note: null };
  }
  const parts = v.split(/\s*(?:[,;/&]|\band\b|\bor\b)\s*/i).filter(Boolean);
  // "Answer: B and D" is ambiguous (one correct answer per question): leave it unmarked.
  if (parts.length > 1) return { index: -1, note: `the answer line names several answers ("${shortQuote(v)}"); only one is supported — tick the right one in the editor` };
  const head = parts[0] || '';
  let m = /^\(?([A-Ha-h])\)?(?:[.):]|\s|$)/.exec(head) || /^\(?([कखगघ])\)?(?:[.):]|\s|$)/.exec(head);
  if (m) {
    const i = /[A-Ha-h]/.test(m[1]) ? LETTERS.indexOf(m[1].toUpperCase()) : DEVA_LETTERS.indexOf(m[1]);
    if (i < options.length) return { index: i, note: null };
    return { index: -1, note: `the answer line says ${LETTERS[i]} but there are only ${options.length} options` };
  }
  m = /^\(?(\d{1,2})\)?[.):]?$/.exec(asciiDigits(head));
  if (m) {
    const i = parseInt(m[1], 10) - 1;
    if (i >= 0 && i < options.length) return { index: i, note: null };
  }
  return { index: -1, note: `the answer "${shortQuote(v)}" does not match any option` };
}

/* ===================================================================== 3. parseQuizText */

function parseQuizText(text, options) {
  const opts = options || {};
  const fallbackTitle = clean(opts.title) || 'Imported quiz';
  const warnings = [];
  const kept = [];
  let skipped = 0, overflow = 0;
  const warn = (question, message) => { warnings.push({ question, message }); };

  let items = String(text == null ? '' : text).split(/\r\n|\r|\n/).map(classify).filter((it) => it.kind !== 'comment');

  // Title: the first line, when it is plain prose (no number, no "?", not an option) and a question follows it.
  let title = '';
  const first = items.findIndex((it) => it.kind !== 'blank');
  if (first >= 0 && items[first].kind === 'text' && !items[first].text.includes('?')) {
    const next = items.slice(first + 1).find((it) => it.kind !== 'blank');
    if (TITLE_PREFIX_RE.test(items[first].text) || (next && (next.kind === 'question' || next.kind === 'text'))) {
      title = items[first].text.replace(TITLE_PREFIX_RE, '');
      items.splice(first, 1);
    }
  }

  // An answer key ("Answer key:" then "1. B" / "2. A" lines, or "Answers: 1-B, 2-A") applies by question number.
  const keys = new Map();
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== 'keyhead') continue;
    for (const [n, v] of items[i].pairs) keys.set(n, v);
    let j = i + 1;
    for (; j < items.length; j++) {
      const it = items[j];
      if (it.kind === 'blank') continue;
      if (it.kind !== 'question' && it.kind !== 'text') break;
      const pairs = parseKeyPairs(it.raw);
      if (!pairs) break;
      for (const [n, v] of pairs) keys.set(n, v);
    }
    items.splice(i, j - i);
    i--;
  }

  // "What is 2+2?" followed by "1. 3" "2. 4*" "3. 5": a run of numbered lines counting from 1 straight
  // after a question line is its options, not three more questions.
  for (let i = 1; i < items.length; i++) {
    const it = items[i], prev = items[i - 1];
    if (it.kind !== 'question' || !it.bare || it.num !== 1) continue;
    if (prev.kind !== 'question' && prev.kind !== 'text') continue;
    let j = i;
    while (j < items.length && items[j].kind === 'question' && items[j].bare && items[j].num === j - i + 1) j++;
    if (j - i < 2) continue;
    for (let k = i; k < j; k++) items[k] = Object.assign(finishOption(items[k].text, null, false, null), { raw: items[k].raw });
    i = j - 1;
  }

  const newQuestion = (num) => ({ num, lines: [], options: [], answers: [], time: null, points: null, dropped: 0, droppedCorrect: false, closed: false, notes: [] });
  let blockNo = 0;

  function addOption(q, o) {
    if (!o.text) { q.notes.push('an empty option was ignored'); return; }
    if (q.options.length >= LIMITS.maxOptions) { q.dropped++; if (o.correct) q.droppedCorrect = true; return; }
    q.options.push(o);
  }

  function addQuestionLine(q, line) {
    const meta = extractInlineMeta(line);
    if (meta.time != null) q.time = meta.time;
    if (meta.points != null) q.points = meta.points;
    let t = meta.text;
    const m = /\s(?=\(?[Aa][.)]\s)/.exec(t);                         // "What is 2+2? A. 3 B. 4* C. 5"
    if (m && /[?:]$/.test(t.slice(0, m.index).trim())) {
      const rest = t.slice(m.index).trim();
      const pieces = splitLettered('A', rest.replace(/^\(?[Aa][.)]\s*/, ''));
      if (pieces) {
        t = t.slice(0, m.index).trim();
        pieces.forEach((p) => addOption(q, finishOption(p.text, p.letter, false, null)));
      }
    }
    if (t) q.lines.push(t);
  }

  function finalize(q) {
    let text = clean(q.lines.join(' '));
    const meta = extractInlineMeta(text);                            // a tag that ended up on a continuation line
    text = meta.text;
    if (meta.time != null && q.time == null) q.time = meta.time;
    if (meta.points != null && q.points == null) q.points = meta.points;
    blockNo++;
    const num = q.num != null ? q.num : blockNo;                     // the teacher's number, else the block's position
    if (keys.has(num)) {
      if (!q.answers.length) q.answers.push(keys.get(num));
      keys.delete(num);
    }

    const label = text ? `"${shortQuote(text)}"` : 'a block with no question text';
    if (q.options.length < LIMITS.minOptions) {
      skipped++;
      warn(null, `Skipped ${label}: a question needs at least 2 options (found ${q.options.length}).`);
      return;
    }
    if (kept.length >= LIMITS.questions) { overflow++; return; }

    // "* A. …" on every option is a bullet style, not four correct answers.
    if (q.options.every((o) => o.correct && o.via === 'leadstar')) q.options.forEach((o) => { o.correct = false; });
    const notes = q.notes.slice();
    const marked = q.options.map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0);
    let correct = marked.length ? marked[0] : -1;
    if (marked.length > 1) notes.push(`more than one option is marked correct (${marked.map((i) => LETTERS[i]).join(', ')}); using ${LETTERS[correct]}`);
    if (q.answers.length) {
      const value = q.answers[q.answers.length - 1];
      if (q.answers.length > 1) notes.push(`several answer lines; using the last one ("${shortQuote(value)}")`);
      const r = resolveAnswer(value, q.options.map((o) => o.text));
      if (r.note) notes.push(r.note);
      if (r.index >= 0) {
        if (correct >= 0 && correct !== r.index) notes.push(`the answer line says ${LETTERS[r.index]} but option ${LETTERS[correct]} is marked on its own line; using ${LETTERS[correct]}`);
        else correct = r.index;
      }
    }
    if (q.dropped) {
      notes.push(`only 4 options are allowed; ${q.dropped} extra option${q.dropped > 1 ? 's were' : ' was'} dropped`
        + (q.droppedCorrect ? ' (one of them was marked correct — tick the right one)' : ''));
    }
    if (correct < 0) notes.push('no correct answer marked — tick it in the editor');
    let timeLimit = 20;
    if (q.time != null) {
      timeLimit = snap(q.time, TIME_LIMITS);
      if (timeLimit !== q.time) notes.push(`a time limit of ${q.time} s is not available; using ${timeLimit} s`);
    }
    let points = 1000;
    if (q.points != null) {
      points = q.points <= 0 ? 0 : snap(q.points, [1000, 2000]);
      if (points !== q.points) notes.push(`${q.points} points is not available; using ${points}`);
    }
    if (text.length > LIMITS.text) { text = cut(text, LIMITS.text); notes.push(`question text shortened to ${LIMITS.text} characters`); }
    if (!text) notes.push('no question text found above these options — type it in the editor');
    const optionTexts = q.options.map((o, i) => {
      if (o.text.length <= LIMITS.option) return o.text;
      notes.push(`option ${LETTERS[i]} shortened to ${LIMITS.option} characters`);
      return cut(o.text, LIMITS.option);
    });
    kept.push({ text, options: optionTexts, correct, timeLimit, points });
    const n = kept.length;
    for (const note of notes) warn(n, `Question ${n}: ${note}`);
  }

  let cur = null, atBlockStart = true;
  const finish = () => { if (cur) finalize(cur); cur = null; };
  const start = (line, num) => { finish(); cur = newQuestion(num == null ? null : num); if (line) addQuestionLine(cur, line); };

  for (const it of items) {
    if (it.kind === 'blank') { atBlockStart = true; continue; }
    switch (it.kind) {
      case 'question':
        start(it.text, it.num); break;
      case 'text':
        // A second line before any option continues the question ("Which of these\nis a mammal?").
        if (cur && !cur.options.length && !cur.closed && !atBlockStart) cur.lines.push(it.text);
        else start(it.text);
        break;
      case 'option': case 'options': {
        // Options straight after a blank line belong to a question that has none yet
        // ("1. Q?\n\nA. …"); otherwise they are a block with no question line of its own.
        if (!cur || cur.closed || (atBlockStart && cur.options.length)) start('');
        for (const o of (it.kind === 'options' ? it.items : [it])) addOption(cur, o);
        break;
      }
      case 'answer':
        if (cur) { cur.answers.push(it.value); cur.closed = true; }
        else warn(null, `An answer line ("${shortQuote(it.value)}") appears before any question and was ignored.`);
        break;
      case 'time': case 'points':
        if (cur) { cur[it.kind] = it.value; cur.closed = true; }
        else warn(null, `A ${it.kind} line appears before any question and was ignored.`);
        break;
      default: break;
    }
    atBlockStart = false;
  }
  finish();

  for (const n of keys.keys()) warn(null, `The answer key names question ${n}, but there is no question ${n}.`);
  if (overflow) {
    skipped += overflow;
    warn(null, `Only the first ${LIMITS.questions} questions were kept; ${overflow} more ${overflow === 1 ? 'was' : 'were'} skipped.`);
  }
  title = clean(title) || fallbackTitle;
  if (title.length > LIMITS.title) { title = cut(title, LIMITS.title); warn(null, `Title shortened to ${LIMITS.title} characters.`); }
  if (!kept.length) warn(null, items.some((it) => it.kind !== 'blank') ? 'No questions were found in this text.' : 'The text is empty — nothing to import.');
  return { quiz: { title, questions: kept }, warnings, skipped };
}

/* ===================================================================== 4. .docx -> text */

function toBytes(buf) {
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return new Uint8Array(buf);
}
const utf8 = (bytes) => new TextDecoder('utf-8').decode(bytes);
const notZip = () => new Error('This is not a .docx file (it is not a ZIP archive). Save the document as .docx, or paste the text instead.');

// Central directory of a ZIP -> Map name -> { method, csize, offset }. No ZIP64.
function readZipDirectory(b) {
  if (b.length > 7 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) {
    throw new Error('This is an old .doc file or a password-protected Word document. In Word remove the password or choose File → Save As → Word Document (.docx), or paste the text instead.');
  }
  if (b.length < 22 || b[0] !== 0x50 || b[1] !== 0x4b) throw notZip();
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22, stop = Math.max(0, b.length - 22 - 65535); i >= stop; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw notZip();
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 .docx files are not supported.');
  const entries = new Map();
  for (let p = cdOffset, n = 0; n < count; n++) {
    if (p + 46 > b.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('The .docx file is damaged (bad central directory).');
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    entries.set(utf8(b.subarray(p + 46, p + 46 + nlen)), {
      method: dv.getUint16(p + 10, true), csize: dv.getUint32(p + 20, true), offset: dv.getUint32(p + 42, true),
    });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

async function inflateRaw(data) {
  if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot unpack .docx files. Paste the text instead.');
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const written = writer.write(data).then(() => writer.close()).catch(() => {}); // errors surface on the read side
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value); total += value.length;
    }
  } catch (e) {
    throw new Error('The .docx file is damaged (its contents could not be decompressed).');
  }
  await written;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function extractEntry(b, e) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (e.offset + 30 > b.length || dv.getUint32(e.offset, true) !== 0x04034b50) throw new Error('The .docx file is damaged (bad local file header).');
  const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
  const data = b.subarray(start, Math.min(b.length, start + e.csize));
  if (e.method === 0) return data;
  if (e.method === 8) return inflateRaw(data);
  throw new Error(`The .docx uses an unsupported compression method (${e.method}).`);
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (all, e) => {
    if (e[0] !== '#') return XML_ENTITIES[e];
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

// Everything inside one <w:p> that shows on the page, in order: <w:t> text, tabs and
// breaks as spaces, Wingdings check marks as ✓; deleted text and field codes skipped.
const RUN_RE = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|noBreakHyphen|softHyphen)\s*\/>|<w:(br|cr)\b[^>]*\/>|<w:(?:delText|instrText|delInstrText)\b[^>]*>[^<]*<\/w:[a-zA-Z]+>|<w:sym\b([^>]*)\/>/g;
function paragraphText(inner) {
  let out = '';
  for (const m of inner.matchAll(RUN_RE)) {
    if (m[1] != null) out += unescapeXml(m[1]);
    else if (m[2] === 'tab' || m[3]) out += ' ';
    else if (m[2] === 'noBreakHyphen') out += '-';
    else if (m[4] != null && /w:font="Wingdings/i.test(m[4]) && /w:char="(?:F0)?F[CE]"/i.test(m[4])) out += '✓';
  }
  return clean(out);
}

// word/numbering.xml -> Map "numId/ilvl" -> numFmt ("decimal", "bullet", "lowerLetter", …).
function parseNumbering(xml) {
  const abstract = new Map();
  for (const a of xml.matchAll(/<w:abstractNum\b[^>]*\sw:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const levels = new Map();
    for (const l of a[2].matchAll(/<w:lvl\b[^>]*\sw:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      const f = /<w:numFmt\b[^>]*\sw:val="([^"]+)"/.exec(l[2]);
      levels.set(l[1], f ? f[1] : 'decimal');
    }
    abstract.set(a[1], levels);
  }
  const map = new Map();
  for (const n of xml.matchAll(/<w:num\b[^>]*\sw:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const a = /<w:abstractNumId\b[^>]*\sw:val="(\d+)"/.exec(n[2]);
    const levels = a ? abstract.get(a[1]) : null;
    if (levels) for (const [ilvl, fmt] of levels) map.set(`${n[1]}/${ilvl}`, fmt);
    for (const o of n[2].matchAll(/<w:lvlOverride\b[^>]*\sw:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvlOverride>/g)) {
      const f = /<w:numFmt\b[^>]*\sw:val="([^"]+)"/.exec(o[2]);
      if (f) map.set(`${n[1]}/${o[1]}`, f[1]);
    }
  }
  return map;
}

// True when every text run of the paragraph is bold, underlined or highlighted (run properties only;
// a bold paragraph style is not seen). Word teachers mark the right option that way.
const RUN_BLOCK_RE = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
const EMPH_RE = /<w:(?:b|u|highlight)\b(?![^>]*\sw:val="(?:0|false|off|none)")[^>]*\/>/;
function allRunsEmphasised(inner) {
  let runs = 0;
  for (const r of inner.matchAll(RUN_BLOCK_RE)) {
    if (!/<w:t\b[^>]*>[^<]*\S/.test(r[1])) continue;                 // no visible text in this run
    runs++;
    const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(r[1]);
    if (!rPr || !EMPH_RE.test(rPr[1])) return false;
  }
  return runs > 0;
}

// Paragraphs -> lines. Word's auto-numbering is invisible in the XML, so list paragraphs get a
// typed prefix back: "N. " for a level-0 numbered item (one count per list, as Word numbers
// them), "- " for deeper levels; when numbering.xml is readable, bullet lists become "- " and
// lettered lists "A. B. C. …" (letters restart with every run of consecutive items). Table cells
// and text boxes are paragraphs too. In a run of option lines where only some are bold,
// underlined or highlighted, those get a trailing " *" (the right-answer marker).
function docxLines(xml, numbering) {
  xml = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');   // text-box fallbacks duplicate their content
  const boxes = [];                                                  // text boxes nest <w:p> inside a <w:p>: hoist them
  xml = xml.replace(/<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g, (all, inner) => { boxes.push(inner); return ''; });
  xml += boxes.join('');
  const lines = [], optionLike = [], emphasised = [];
  const counters = new Map();
  let runKey = null, runIndex = -1;
  for (const m of xml.matchAll(/<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const inner = m[1];
    if (inner == null) { lines.push(''); optionLike.push(false); emphasised.push(false); runKey = null; continue; }
    let text = paragraphText(inner);
    const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(inner);
    const props = pPr ? pPr[1].replace(/<w:pPrChange\b[\s\S]*?<\/w:pPrChange>/g, '') : '';
    const numPr = /<w:numPr>([\s\S]*?)<\/w:numPr>/.exec(props);
    const numId = numPr ? (/<w:numId\s+w:val="(\d+)"/.exec(numPr[1]) || [])[1] : null;
    // Which lines may carry a bold-only answer: lettered/bulleted ones (group "opt"), and list
    // paragraphs (grouped by list, so a numbered question list and a numbered option list stay apart).
    let isOption = text && (OPT_LETTER_RE.test(text) || BULLET_RE.test(text) || STAR_LETTER_RE.test(text)) ? 'opt' : null;
    if (!numPr || numId === '0' || !text) {
      lines.push(text); runKey = null;
    } else {
      const ilvl = parseInt((/<w:ilvl\s+w:val="(\d+)"/.exec(numPr[1]) || [, '0'])[1], 10);
      const key = `${numId}/${ilvl}`;
      runIndex = key === runKey ? runIndex + 1 : 0;
      runKey = key;
      const fmt = numbering ? numbering.get(key) : null;
      isOption = key;
      if (!hasMarker(text)) {
        if (fmt === 'bullet') text = '- ' + text;
        else if (fmt && /letter|roman/i.test(fmt)) text = (runIndex < LETTERS.length ? LETTERS[runIndex] + '. ' : '- ') + text;
        else if (ilvl === 0) { const n = (counters.get(numId) || 0) + 1; counters.set(numId, n); text = `${n}. ` + text; }
        else text = '- ' + text;
      }
      lines.push(text);
    }
    optionLike.push(isOption);
    emphasised.push(!!isOption && allRunsEmphasised(inner));
  }
  // Bold-only answers: within each run of consecutive option lines of one group, mark the
  // emphasised ones unless all of them are (then it is just styling).
  for (let i = 0; i < lines.length;) {
    if (!optionLike[i]) { i++; continue; }
    let j = i;
    while (j < lines.length && optionLike[j] === optionLike[i]) j++;
    const marked = emphasised.slice(i, j).filter(Boolean).length;
    if (j - i >= 2 && marked > 0 && marked < j - i) {
      for (let k = i; k < j; k++) if (emphasised[k] && !TRAIL_MARK_RE.test(lines[k])) lines[k] += ' *';
    }
    i = j;
  }
  return lines;
}

async function docxToText(arrayBuffer) {
  const bytes = toBytes(arrayBuffer);
  const entries = readZipDirectory(bytes);
  const docName = entries.has('word/document.xml') ? 'word/document.xml' : [...entries.keys()].find((k) => /^word\/document\d*\.xml$/.test(k));
  if (!docName) throw new Error('This is not a Word document: the file has no word/document.xml inside. Save it as .docx, or paste the text instead.');
  const xml = utf8(await extractEntry(bytes, entries.get(docName)));
  let numbering = null;
  if (entries.has('word/numbering.xml')) {
    try { numbering = parseNumbering(utf8(await extractEntry(bytes, entries.get('word/numbering.xml')))); } catch (e) { numbering = null; }
  }
  return docxLines(xml, numbering).join('\n');
}

/* ===================================================================== 5. File -> text (browser) */

async function textFromFile(file) {
  const name = String((file && file.name) || '').toLowerCase();
  const buf = await file.arrayBuffer();
  const b = new Uint8Array(buf);
  const isZip = b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7);
  if (/\.docx$/.test(name) || isZip) return docxToText(buf);
  if (/\.doc$/.test(name) || (b.length > 7 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0)) {
    throw new Error('Old .doc files are not supported. In Word choose File → Save As → Word Document (.docx), or paste the text.');
  }
  let encoding = 'utf-8';
  if (b.length > 1 && b[0] === 0xff && b[1] === 0xfe) encoding = 'utf-16le';
  else if (b.length > 1 && b[0] === 0xfe && b[1] === 0xff) encoding = 'utf-16be';
  let text = new TextDecoder(encoding).decode(buf);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (/^\s*\{\\rtf/.test(text)) throw new Error('RTF files are not supported. Save as .docx or .txt, or paste the text.');
  return text;
}

/* ===================================================================== exports */

const api = { parseQuizText, docxToText, textFromFile, TIME_LIMITS, POINT_VALUES, LIMITS };
if (typeof window !== 'undefined') window.HomPubImport = api;
if (typeof module === 'object' && module && module.exports) module.exports = api;
})();
