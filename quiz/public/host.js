/*
  HomPub Quiz — host page (teacher's laptop → projector). MIT licence.

  Built against quiz/PROTOCOL.md. Plain ES2020, no frameworks, no bundler.
  Organisation:
    0. constants            limits and defaults, mirroring PROTOCOL §2 / §9
    1. DOM helpers          h() builds elements; every string becomes a text node (no innerHTML)
    2. storage + quizzes    localStorage keys, validation, sample quiz
    3. state                ONE state object; currentPhase() picks the screen
    4. render()             a single switch on phase → one function per screen
    5. actions              click / input / change delegation via data-action / data-field
    6. hosting              POST /api/room, the host WebSocket, applyFrame()
    7. socket wrapper       backoff 500 ms → 8 s ×2 ±30 %, "ping" every 25 s, no-retry codes
    8. clock + countdown    offset = serverNow - Date.now(); ring animates deadline - (now + offset)
    9. misc                 wake lock, fullscreen, keyboard, contrast, toast, downloads
*/
(function () {
'use strict';

/* ======================================================================
   0. Constants
   ====================================================================== */

const KEYS = {
  quizzes: 'hompub-quiz:quizzes',   // [{id, title, questions, updatedAt, exportedAt}]  (PROTOCOL §2 Quiz + id/updatedAt)
  host: 'hompub-quiz:host',         // {pin, hostToken, title} while a game is live     (PROTOCOL §5)
  prefs: 'hompub-quiz:host-prefs',  // {highContrast, settings} — per-device conveniences only
};
const LIMITS = { title: 80, text: 200, option: 80, questions: 100, bodyBytes: 200 * 1024 };
const TIME_LIMITS = [5, 10, 15, 20, 30, 60, 90, 120, 240];
const POINTS = [0, 1000, 2000];
const INTRO_MS = 3000;
const LETTERS = ['A', 'B', 'C', 'D'];
const PIN_RE = /^[1-9][0-9]{5}$/;
const NO_RETRY_CODES = new Set([4001, 4003, 4004, 4009, 4010]);
const DEFAULT_CLOSE_MSG = {
  4001: 'The host key for this game was rejected. It cannot be resumed from here.',
  4003: 'This connection was removed from the game.',
  4004: 'This game has ended or no longer exists.',
  4009: 'The room is full.',
  4010: 'The room is locked.',
};
const DEFAULT_SETTINGS = { mode: 'speed', showOnDevices: false, lateJoin: true, earlyClose: false, nicknameMode: 'free' };
const MODES = [
  { id: 'speed', label: 'Speed', desc: 'Kahoot-style: a correct answer earns the full points if instant, about half at the buzzer.' },
  { id: 'accuracy', label: 'Accuracy', desc: '1 point per correct answer. Speed does not matter.' },
  { id: 'coarse', label: 'Coarse speed', desc: 'Like Speed, but time is rounded up to whole seconds so Wi-Fi lag matters less.' },
];
// Answer slots: shape AND colour, always both. Colours live in host.css (--opt-N).
const SHAPES = [
  { name: 'Red triangle', path: 'M12 2.5 L22.5 21 H1.5 Z' },
  { name: 'Blue diamond', path: 'M12 1.5 L22.5 12 L12 22.5 L1.5 12 Z' },
  { name: 'Yellow circle', circle: true },
  { name: 'Green square', path: 'M2.5 2.5 H21.5 V21.5 H2.5 Z' },
];
const BLOCKED_MSG = 'WebSockets are blocked on this network. Try the guest Wi-Fi or a phone hotspot for the host.';
const STAGE_PHASES = new Set(['connecting', 'lobby', 'intro', 'open', 'closed', 'podium', 'ended', 'wiped', 'disconnected']);
const RING_R = 54;
const RING_C = 2 * Math.PI * RING_R;
const SHORTCUT_MUTE_MS = 500;   // Space/Enter stay quiet this long after a rebuild dropped focus to <body>
const NOT_SAVED_MSG = 'Not saved — this browser is blocking storage. Export your quiz to keep it.';
// "Import Word or text" / "Paste questions" (section 4a-ii). The parsing itself lives in import-text.js
// (window.HomPubImport); the file is read in this browser and never sent anywhere.
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const IMPORT_FILE_RE = /\.(docx|txt|md|markdown|text)$/i;
const IMPORT_HELPER_MISSING = 'The import helper (import-text.js) did not load. Reload the page and try again.';
const IMPORT_EXAMPLE = [
  'Cell biology — week 6',
  '',
  '1. Which organelle makes ATP?',
  'A. Ribosome',
  'B. Mitochondrion *',
  'C. Golgi body',
  'D. Nucleus',
  '',
  '2. Water boils at 100 °C at sea level. (10s)',
  '- True',
  '- False',
  'Answer: A',
].join('\n');

const SAMPLE_QUIZ = {
  title: 'General knowledge warm-up',
  questions: [
    { text: 'Which planet is known as the Red Planet?', options: ['Venus', 'Mars', 'Jupiter', 'Mercury'], correct: 1, timeLimit: 20, points: 1000 },
    { text: 'How many continents are there?', options: ['Five', 'Six', 'Seven', 'Eight'], correct: 2, timeLimit: 15, points: 1000 },
    { text: 'What is the largest ocean on Earth?', options: ['Atlantic', 'Indian', 'Arctic', 'Pacific'], correct: 3, timeLimit: 20, points: 1000 },
    { text: 'Which gas do plants take in from the air to make food?', options: ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Helium'], correct: 2, timeLimit: 20, points: 1000 },
    { text: 'What is the capital city of Australia?', options: ['Sydney', 'Melbourne', 'Canberra', 'Perth'], correct: 2, timeLimit: 30, points: 2000 },
  ],
};

/* ======================================================================
   1. DOM helpers
   ====================================================================== */

const $ = (id) => document.getElementById(id);

// h('tag', {attrs}, ...children). Strings become text nodes, so server text is never parsed as HTML.
// Attribute values go through setAttribute (also never parsed as HTML). null/undefined/false attrs are skipped.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const v = attrs[key];
      if (v === null || v === undefined || v === false) continue;
      if (key === 'class') el.className = v;
      else if (key === 'style') el.style.cssText = v;              // only ever constant strings
      else el.setAttribute(key, v === true ? '' : String(v));
    }
  }
  appendChildren(el, children);
  return el;
}
function appendChildren(el, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false || k === '') continue;
    if (Array.isArray(k)) appendChildren(el, k);
    else if (k instanceof Node) el.appendChild(k);
    else el.appendChild(document.createTextNode(String(k)));
  }
}
function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const key of Object.keys(attrs || {})) el.setAttribute(key, String(attrs[key]));
  return el;
}
function shapeSvg(slot) {
  const s = SHAPES[slot];
  const svg = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
  svg.appendChild(s.circle ? svgEl('circle', { cx: 12, cy: 12, r: 10.5 }) : svgEl('path', { d: s.path }));
  return svg;
}
function swatch(slot) {
  return h('span', { class: `swatch slot-${slot}`, role: 'img', 'aria-label': SHAPES[slot].name }, shapeSvg(slot));
}
function checkIcon() {
  const svg = svgEl('svg', { class: 'tick', viewBox: '0 0 24 24', 'aria-label': 'Correct', role: 'img' });
  svg.appendChild(svgEl('path', { d: 'M4 12.5 L9.5 18 L20 6.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 3.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return svg;
}
function btn(label, action, opts) {
  const o = opts || {};
  const attrs = Object.assign({ type: 'button', class: 'btn' + (o.cls ? ' ' + o.cls : ''), 'data-action': action }, o.attrs || {});
  if (o.disabled) attrs.disabled = true;
  return h('button', attrs, label);
}
// Both carry a stable id (the field name, plus the value for radios) so render() can restore focus.
function toggle(field, checked, label, desc) {
  return h('label', { class: 'check' },
    h('input', { type: 'checkbox', id: field, 'data-field': field, checked: checked || null }),
    h('span', { class: 'check-text' }, h('b', null, label), desc ? h('small', null, desc) : null));
}
function radio(field, value, checked, label, desc) {
  return h('label', { class: 'check' },
    h('input', { type: 'radio', id: `${field}-${value}`, name: field, value, 'data-field': field, checked: checked || null }),
    h('span', { class: 'check-text' }, h('b', null, label), desc ? h('small', null, desc) : null));
}

function fmtInt(n) { return Number.isFinite(n) ? Math.round(n).toLocaleString() : '0'; }
function fmtSec(ms) { return (Math.max(0, ms) / 1000).toFixed(1) + ' s'; }
function fmtDuration(sec) {
  if (sec < 90) return `${sec} s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
function fmtDate(ts) {
  if (!ts) return 'never';
  try { return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return new Date(ts).toLocaleString(); }
}
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

/* ======================================================================
   2. Storage + quizzes
   ====================================================================== */

// localStorage can be missing or throw (private mode, blocked site data); every access is guarded.
function loadJSON(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
}
function removeKey(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }

function loadHostKey() {
  const k = loadJSON(KEYS.host, null);
  return k && typeof k === 'object' && PIN_RE.test(String(k.pin)) && typeof k.hostToken === 'string' ? k : null;
}
function saveHostKey(k) { saveJSON(KEYS.host, { pin: k.pin, hostToken: k.hostToken, title: k.title || '' }); }

function loadQuizzes() {
  const list = loadJSON(KEYS.quizzes, []);
  return Array.isArray(list) ? list.filter((q) => q && typeof q === 'object' && typeof q.id === 'string' && Array.isArray(q.questions)) : [];
}
// Returns whether the write succeeded, so the editor's status line can say "Not saved" honestly.
function persistQuizzes() {
  const ok = saveJSON(KEYS.quizzes, state.quizzes);
  state.storageBlocked = !ok;
  if (!ok) toast('Could not save: this browser is blocking storage. Export your quiz to keep it.');
  return ok;
}
function findQuiz(id) { return state.quizzes.find((q) => q.id === id) || null; }
function uid() {
  try { return crypto.randomUUID(); } catch (e) { return 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
}
function newQuestion() { return { text: '', options: ['', '', '', ''], correct: 0, timeLimit: 20, points: 1000 }; }
function makeStored(quiz, exported) {
  const now = Date.now();
  return { id: uid(), title: quiz.title, questions: quiz.questions, updatedAt: now, exportedAt: exported ? now : null };
}
// A quiz counts as exported only while no edit is newer than its last export; otherwise the
// "not exported" marker and the setup-screen notice must come back.
function isExported(q) { return !!q.exportedAt && !(q.updatedAt > q.exportedAt); }

// Coerce an imported object into the Quiz shape. Returns null when it is not a quiz at all.
// Values the editor can flag are kept as problems: an out-of-range or non-integer `correct`
// becomes -1 (no radio ticked, "tick the correct option"), never silently option A. Options
// beyond 4 and questions beyond 100 have to be dropped; they are counted in `dropped` so the
// import toast can say so instead of pretending the file came through whole.
function normaliseQuiz(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.questions)) return null;
  const dropped = { questions: Math.max(0, raw.questions.length - LIMITS.questions), options: 0 };
  const questions = raw.questions.slice(0, LIMITS.questions).map((item) => {
    const o = item && typeof item === 'object' ? item : {};
    const rawOptions = Array.isArray(o.options) ? o.options : null;
    if (rawOptions) dropped.options += Math.max(0, rawOptions.length - 4);
    const options = rawOptions ? rawOptions.slice(0, 4).map((x) => String(x == null ? '' : x)) : ['', ''];
    while (options.length < 2) options.push('');
    const correct = Number.isInteger(o.correct) && o.correct >= 0 && o.correct < options.length ? o.correct : -1;
    const timeLimit = TIME_LIMITS.includes(Number(o.timeLimit)) ? Number(o.timeLimit) : 20;
    const points = POINTS.includes(Number(o.points)) ? Number(o.points) : 1000;
    return { text: String(o.text == null ? '' : o.text), options, correct, timeLimit, points };
  });
  if (!questions.length) questions.push(newQuestion());
  return { title: String(raw.title == null ? '' : raw.title), questions, dropped };
}

// The exact object sent in POST /api/room (PROTOCOL §2): nothing but title + questions, trimmed.
function cleanQuiz(q) {
  return {
    title: String(q.title || '').trim(),
    questions: (q.questions || []).map((qq) => ({
      text: String(qq.text || '').trim(),
      options: (qq.options || []).map((o) => String(o || '').trim()),
      correct: qq.correct,
      timeLimit: qq.timeLimit,
      points: qq.points,
    })),
  };
}
function quizBytes(q) {
  try { return new Blob([JSON.stringify({ quiz: cleanQuiz(q), settings: DEFAULT_SETTINGS })]).size; } catch (e) { return 0; }
}
function quizDurationSec(q) {
  return (q.questions || []).reduce((n, qq) => n + (Number(qq.timeLimit) || 0) + INTRO_MS / 1000 + 8, 0) | 0; // +8 s per reveal, rough
}

// Human-readable problems, matching the server-side limits in PROTOCOL §2 / §9.
function validateQuiz(q) {
  const p = [];
  const title = String(q.title || '').trim();
  if (title.length < 1 || title.length > LIMITS.title) p.push(`Title: 1–${LIMITS.title} characters.`);
  const qs = Array.isArray(q.questions) ? q.questions : [];
  if (qs.length < 1) p.push(`Add at least one question (up to ${LIMITS.questions}).`);
  if (qs.length > LIMITS.questions) p.push(`Too many questions: ${qs.length} (max ${LIMITS.questions}).`);
  qs.forEach((qq, i) => {
    const n = `Question ${i + 1}`;
    const text = String(qq.text || '').trim();
    if (text.length < 1 || text.length > LIMITS.text) p.push(`${n}: text must be 1–${LIMITS.text} characters.`);
    const opts = Array.isArray(qq.options) ? qq.options : [];
    if (opts.length < 2 || opts.length > 4) p.push(`${n}: needs 2–4 options.`);
    opts.forEach((o, j) => {
      const s = String(o || '').trim();
      if (s.length < 1 || s.length > LIMITS.option) p.push(`${n}, option ${LETTERS[j] || j + 1}: 1–${LIMITS.option} characters.`);
    });
    if (!Number.isInteger(qq.correct) || qq.correct < 0 || qq.correct >= opts.length) p.push(`${n}: tick the correct option.`);
    if (!TIME_LIMITS.includes(qq.timeLimit)) p.push(`${n}: time limit must be one of ${TIME_LIMITS.join(', ')} seconds.`);
    if (!POINTS.includes(qq.points)) p.push(`${n}: points must be 0, 1000 or 2000.`);
  });
  if (quizBytes(q) > LIMITS.bodyBytes) p.push('The quiz is larger than 200 KB. Shorten some text.');
  return p;
}

/* ======================================================================
   3. State
   ====================================================================== */

const storedPrefs = loadJSON(KEYS.prefs, {}) || {};
const state = {
  screen: 'home',          // local screens while no game is live: 'home' | 'editor' | 'setup'
  editorId: null,          // quiz being edited / prepared for hosting
  quizzes: [],             // mirror of localStorage hompub-quiz:quizzes
  game: null,              // server snapshot while hosting: the last `sync` frame (minus t), delta frames applied in place
  closeInfo: null,         // {code, reason} once the socket closed for good (a no-retry code)
  results: null,           // {pin, csv, filename, downloaded} — kept outside `game` so a later sync cannot drop it
  wiped: false,            // true after the `wiped` frame
  busy: false,             // POST /api/room in flight
  error: null,             // readable error for the setup screen
  netCheck: { status: 'idle', message: '' },
  conn: { status: 'idle', detail: '' },
  allTimers: null,         // last value chosen in the editor's "Set all timers to…" select
  storageBlocked: false,   // the last persistQuizzes() failed (private window, site data blocked)
  importer: null,          // Word/text import dialog over the home screen: null | {mode: 'paste'|'preview', source: 'paste'|'file', sourceName, text, preview, error, busy}
  prefs: {
    highContrast: !!storedPrefs.highContrast,
    settings: Object.assign({}, DEFAULT_SETTINGS, storedPrefs.settings || {}),
  },
};
let socket = null;        // reconnect wrapper (section 7)
let clockOffset = 0;      // serverNow - Date.now(), refreshed by every frame that carries serverNow
let wakeLock = null;
let tickHandle = null;
let qrCache = null;       // {pin, svg} — the QR is generated once per PIN
let toastTimer = null;
let shortcutMuteUntil = 0; // Date.now() before which the Space/Enter primary shortcut is ignored
let lastPasteText = '';   // what was in the paste box when the dialog was closed, so an accidental Escape loses nothing
let importerOpener = '';  // id of the home-screen button that opened the import dialog; focus goes back there on close

function savePrefs() { saveJSON(KEYS.prefs, state.prefs); }

// The one key the render switch turns on. Server phases win; local pseudo-phases fill the gaps.
function currentPhase() {
  if (state.wiped) return 'wiped';
  if (state.closeInfo) return 'disconnected';
  if (state.game) return state.game.phase || 'connecting';
  return state.screen;
}
function isLive() { return !!state.game && !state.wiped && !state.closeInfo; }
function emptyTally(optionCount, expected) {
  return { counts: new Array(Math.max(0, optionCount | 0)).fill(0), answered: 0, expected: expected | 0 };
}
function joinUrl(pin) { return location.origin + '/play?pin=' + (PIN_RE.test(String(pin)) ? pin : ''); }

/* ======================================================================
   4. render(): one switch on phase
   ====================================================================== */

function render() {
  const phase = currentPhase();
  const app = $('app');
  // Re-rendering replaces the DOM; keep focus and the options menu where they were.
  const active = document.activeElement;
  const hadFocus = !!(active && active !== document.body && app.contains(active));
  const focusedId = hadFocus ? active.id : '';
  const menu = $('stage-menu');
  const menuOpen = !!(menu && menu.open);

  let view;
  switch (phase) {
    case 'home': view = renderHome(); break;
    case 'editor': view = renderEditor(); break;
    case 'setup': view = renderSetup(); break;
    case 'connecting': view = renderConnecting(); break;
    case 'lobby': view = renderLobby(); break;
    case 'intro':
    case 'open': view = renderQuestion(phase); break;
    case 'closed': view = renderReveal(); break;
    case 'podium': view = renderPodium(); break;
    case 'ended': view = renderEnded(); break;
    case 'wiped': view = renderWiped(); break;
    case 'disconnected': view = renderDisconnected(); break;
    default: view = renderHome();
  }
  document.body.dataset.mode = STAGE_PHASES.has(phase) ? 'stage' : 'page';
  app.replaceChildren(view);
  // The import dialog is rebuilt with the rest of the screen; re-open it as a modal (focus trap, Escape,
  // inert page behind). Without showModal() it still shows, as an ordinary open <dialog>.
  const dlg = $('importer');
  if (dlg && !dlg.open) { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } }

  let restored = false;
  if (focusedId) {
    const el = $(focusedId);
    if (el) {
      try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      restored = document.activeElement === el;
    }
  }
  // Focus that could not be handed back falls to <body>; mute the Space/Enter shortcut briefly so a
  // key meant for the control the teacher had reached does not fire the phase's primary action.
  if (hadFocus && !restored) shortcutMuteUntil = Date.now() + SHORTCUT_MUTE_MS;
  const menu2 = $('stage-menu');
  if (menu2 && menuOpen) menu2.open = true;

  renderPill();
  document.title = state.game && state.game.pin ? `HomPub Quiz — PIN ${state.game.pin}` : 'HomPub Quiz — Host';
  ensureTicker(phase);
}

/* ---------- 4a. HOME ---------- */

function renderHome() {
  const quizzes = state.quizzes.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const hostKey = loadHostKey();
  return h('div', { class: 'wrap page' },
    hostKey && h('section', { class: 'card resume' },
      h('p', { class: 'eyebrow' }, 'A game is still live'),
      h('h2', null, 'Resume game ', h('span', { class: 'mono' }, hostKey.pin)),
      h('p', { class: 'fine' }, hostKey.title ? `“${hostKey.title}” — ` : '', 'this browser still holds the host key. Students who are connected are waiting for you.'),
      h('div', { class: 'btn-row' },
        btn(`Resume game ${hostKey.pin}`, 'resume', { cls: 'primary big' }),
        h('button', { type: 'button', class: 'link-btn', 'data-action': 'forget-host' }, 'Forget this game'))),
    h('div', { class: 'page-head' },
      h('div', null,
        h('p', { class: 'eyebrow' }, 'Host'),
        h('h1', null, 'Your quizzes'),
        h('p', { class: 'lede' }, 'Build a quiz, put the PIN on the projector, students answer on their phones. Nothing is kept after the game except the CSV you download.')),
      h('div', { class: 'toolbar' },
        btn('New quiz', 'new-quiz', { cls: 'primary' }),
        btn('Import .json', 'import'),
        btn('Import Word or text', 'import-text', { attrs: { id: 'import-text-btn' } }),
        btn('Paste questions', 'paste-open', { attrs: { id: 'paste-btn' } }),
        btn('Load sample', 'load-sample'))),
    h('p', { class: 'fine' },
      'Writing in Word? ', h('a', { href: 'template-questions.docx', download: true }, 'Download the Word template'),
      ', type your questions into it, then “Import Word or text”. Or paste questions straight from any document. The file is read in this browser; nothing is uploaded.'),
    quizzes.length
      ? h('div', { class: 'quiz-list' }, quizzes.map(renderQuizRow))
      : h('p', { class: 'empty' }, 'No quizzes yet. Start with “New quiz” or “Load sample”, or import questions written in Word.'),
    renderNetCheck(),
    h('p', { class: 'fine' }, 'Quizzes are saved only in this browser (localStorage). Export a .json copy before a lesson — a cleared browser means a lost quiz.'),
    state.importer ? renderImporter() : null);
}

function renderQuizRow(q) {
  const n = q.questions.length;
  const problems = validateQuiz(q).length;
  return h('div', { class: 'card quiz-row' },
    h('div', null,
      h('div', { class: 'title' }, q.title || 'Untitled quiz'),
      h('div', { class: 'meta mono' },
        `${plural(n, 'question')} · about ${fmtDuration(quizDurationSec(q))} · edited ${fmtDate(q.updatedAt)}`,
        problems ? ` · ${plural(problems, 'problem')}` : '',
        isExported(q) ? '' : ' · not exported')),
    h('div', { class: 'btn-row' },
      btn('Host', 'setup', { cls: 'primary', attrs: { 'data-id': q.id } }),
      btn('Edit', 'edit', { attrs: { 'data-id': q.id } }),
      btn('Duplicate', 'duplicate', { attrs: { 'data-id': q.id } }),
      btn('Export .json', 'export', { attrs: { 'data-id': q.id } }),
      btn('Delete', 'delete', { cls: 'danger', attrs: { 'data-id': q.id } })));
}

function renderNetCheck() {
  const nc = state.netCheck;
  return h('section', { class: 'card netcheck' },
    h('h2', null, 'Check my network'),
    h('p', { class: 'fine' }, 'School networks sometimes block WebSockets, which the live game needs. Run this on the Wi-Fi you will use in class.'),
    h('div', { class: 'btn-row' }, btn(nc.status === 'running' ? 'Testing…' : 'Check my network', 'net-check', { disabled: nc.status === 'running' })),
    nc.status !== 'idle' && h('div', { class: 'net-result', 'data-status': nc.status, role: 'status' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', null, nc.message)));
}

/* ---------- 4a-ii. IMPORT WORD / TEXT (dialog over the home screen) ---------- */

// One <dialog> for both routes: "Paste questions" (mode 'paste' → 'preview') and "Import Word or text"
// (mode 'preview' straight away, with busy/error states). Everything shown comes from HomPubImport's
// result, re-shaped by shapeImportResult(), and is rendered as text nodes through h().
function renderImporter() {
  const imp = state.importer;
  const dlg = h('dialog', { class: 'importer', id: 'importer', 'aria-labelledby': 'importer-heading' });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeImporter(); });   // Escape inside a modal dialog
  dlg.addEventListener('close', () => { if (state.importer) closeImporter(); });     // the browser closed it anyway
  dlg.appendChild(h('div', { class: 'card importer-panel' }, imp.mode === 'paste' ? renderPasteForm(imp) : renderImportPreview(imp)));
  return dlg;
}

function importerHead(eyebrow, title) {
  return h('div', { class: 'importer-head' },
    h('p', { class: 'eyebrow' }, eyebrow),
    h('h2', { id: 'importer-heading', tabindex: -1 }, title));
}

function renderPasteForm(imp) {
  return [
    importerHead('Import', 'Paste questions'),
    h('p', { class: 'fine' }, 'Paste from Word, Google Docs, an email or a web page. One question per block with a blank line between blocks; mark the right answer with a * or an “Answer:” line. You can fix anything in the editor afterwards.'),
    h('div', { class: 'importer-grid' },
      h('label', { class: 'field' },
        h('span', null, 'Questions'),
        h('textarea', { class: 'input importer-text', id: 'import-text', rows: 12, 'data-field': 'import-text', autofocus: true, spellcheck: 'false', autocomplete: 'off' }, imp.text || '')),
      h('div', { class: 'field' },
        h('span', null, 'Format example'),
        h('pre', { class: 'format-example' }, IMPORT_EXAMPLE),
        h('p', { class: 'fine' },
          'Numbers and letters are optional. Timer: “(30s)” at the end of a question. Points: a line “Points: 2000” for double points or “Points: 0” for a survey question. ',
          h('a', { href: 'template-questions.docx', download: true }, 'Download the Word template'), ' to see it laid out in Word.'))),
    imp.error && h('div', { class: 'notice bad', role: 'alert' }, imp.error),
    h('div', { class: 'btn-row end importer-actions' },
      btn('Cancel', 'import-cancel', { cls: 'ghost', attrs: { id: 'import-cancel' } }),
      btn('Preview', 'import-preview', { cls: 'primary', attrs: { id: 'import-preview-btn' } })),
  ];
}

function renderImportPreview(imp) {
  const p = imp.preview;
  const eyebrow = imp.source === 'file' ? `From ${imp.sourceName}` : 'Pasted text';
  if (imp.busy) {
    return [
      importerHead(eyebrow, 'Reading the file…'),
      h('p', { class: 'fine' }, 'The file is read here in this browser; nothing is uploaded.'),
      h('div', { class: 'btn-row end importer-actions' }, btn('Cancel', 'import-cancel', { cls: 'ghost', attrs: { id: 'import-cancel' } })),
    ];
  }
  if (imp.error || !p) {
    return [
      importerHead(eyebrow, 'Could not import'),
      h('div', { class: 'notice bad', role: 'alert' }, imp.error || 'Nothing could be read from this.'),
      h('div', { class: 'btn-row end importer-actions' },
        btn('Cancel', 'import-cancel', { cls: 'ghost', attrs: { id: 'import-cancel' } }),
        imp.source === 'paste'
          ? btn('Edit text', 'import-edit-text', { cls: 'primary', attrs: { id: 'import-edit' } })
          : btn('Choose another file', 'import-text', { cls: 'primary', attrs: { id: 'import-another' } })),
    ];
  }
  const qs = p.quiz.questions;
  const n = qs.length;
  return [
    importerHead(eyebrow, 'Check the import'),
    h('label', { class: 'field' },
      h('span', null, `Quiz title (1–${LIMITS.title} characters)`),
      h('input', { class: 'input', id: 'import-quiz-title', type: 'text', maxlength: LIMITS.title, value: p.quiz.title, 'data-field': 'import-title', autocomplete: 'off' })),
    h('p', { class: 'importer-count mono', role: 'status' }, `${plural(n, 'question')} found` + (p.skipped ? ` · ${plural(p.skipped, 'block')} skipped` : '')),
    renderImportWarnings(p.warnings),
    n
      ? h('div', { class: 'quiz-list' }, qs.map((qq, i) => renderPreviewQuestion(qq, i, p.warnings)))
      : h('p', { class: 'empty' }, 'No questions were recognised. Each question needs at least two option lines under it (A. B. C. D. or a dash), with a blank line between questions.'),
    h('div', { class: 'btn-row end importer-actions' },
      btn('Cancel', 'import-cancel', { cls: 'ghost', attrs: { id: 'import-cancel' } }),
      imp.source === 'paste' ? btn('Edit text', 'import-edit-text', { attrs: { id: 'import-edit' } }) : null,
      btn('Add to my quizzes', 'import-add', { cls: 'primary', disabled: n === 0, attrs: { id: 'import-add' } })),
  ];
}

function importWarningText(w) { return (w.question ? `Question ${w.question}: ` : '') + w.message; }

function renderImportWarnings(warnings) {
  if (!warnings.length) return h('p', { class: 'fine', style: 'color:var(--ok)' }, '✓ Nothing to fix.');
  const shown = 30;
  return h('div', { class: 'notice' },
    h('b', null, `${plural(warnings.length, 'thing')} to check — the editor opens next so you can fix them`),
    h('ul', { class: 'problems' }, warnings.slice(0, shown).map((w) => h('li', null, importWarningText(w)))),
    warnings.length > shown ? h('p', { class: 'fine' }, `…and ${warnings.length - shown} more, shown under the questions below.`) : null);
}

function renderPreviewQuestion(qq, i, warnings) {
  const notes = warnings.filter((w) => w.question === i + 1).map((w) => w.message);
  const unmarked = qq.correct < 0;
  if (unmarked && !notes.some((m) => /correct/i.test(m))) notes.push('No correct answer marked — tick it in the editor.');
  return h('section', { class: 'card q-card preview-q' + (unmarked ? ' needs-answer' : ''), 'aria-label': `Question ${i + 1}` },
    h('div', { class: 'q-head' },
      h('h3', null, `Question ${i + 1}`),
      h('div', { class: 'tags' },
        h('span', { class: 'tag mono' }, `${qq.timeLimit} s`),
        h('span', { class: 'tag mono' }, qq.points === 0 ? 'survey · 0 pts' : `${fmtInt(qq.points)} pts`))),
    h('p', { class: 'preview-text' }, qq.text),
    h('ol', { class: 'preview-opts' }, qq.options.map((o, j) => {
      const correct = j === qq.correct;
      return h('li', { class: 'preview-opt' + (correct ? ' is-correct' : '') },
        swatch(j),
        h('span', { class: 'text' }, o),
        correct ? checkIcon() : null);
    })),
    notes.length ? h('ul', { class: 'problems' }, notes.map((m) => h('li', null, m))) : null);
}

/* ---------- 4b. EDITOR ---------- */

function renderEditor() {
  const q = findQuiz(state.editorId);
  if (!q) { state.screen = 'home'; return renderHome(); }
  const total = q.questions.length;
  const allTimers = TIME_LIMITS.includes(state.allTimers) ? state.allTimers : ((q.questions[0] && q.questions[0].timeLimit) || 20);
  return h('div', { class: 'wrap page' },
    h('div', null, h('button', { type: 'button', class: 'link-btn', 'data-action': 'home' }, '← All quizzes')),
    h('div', { class: 'page-head' },
      h('div', null, h('p', { class: 'eyebrow' }, 'Editor'), h('h1', null, 'Edit quiz')),
      h('div', { class: 'toolbar' },
        btn('Export .json', 'export', { attrs: { 'data-id': q.id } }),
        btn('Host this quiz →', 'setup', { cls: 'primary', attrs: { 'data-id': q.id } }))),
    h('section', { class: 'card' },
      h('label', { class: 'field' },
        h('span', null, `Title (1–${LIMITS.title} characters)`),
        h('input', { class: 'input', id: 'title-input', type: 'text', maxlength: LIMITS.title, value: q.title || '', 'data-field': 'title', autocomplete: 'off' })),
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Set all timers to…'),
        h('div', { class: 'btn-row' },
          h('select', { class: 'input', id: 'all-timers', 'data-field': 'all-timers', 'aria-label': 'Time limit for every question', style: 'width:auto;flex:1 1 140px' },
            TIME_LIMITS.map((t) => h('option', { value: t, selected: t === allTimers || null }, `${t} seconds`))),
          btn('Apply to all', 'all-timers'))),
      h('div', { id: 'problems-box' }, renderProblems(validateQuiz(q))),
      h('p', { class: 'autosave', id: 'autosave' }, state.storageBlocked ? NOT_SAVED_MSG : 'Saved automatically in this browser.')),
    h('div', { class: 'quiz-list' }, q.questions.map((qq, i) => renderQuestionCard(qq, i, total))),
    h('div', { class: 'btn-row' },
      btn('+ Add question', 'add-question', { cls: 'primary', disabled: total >= LIMITS.questions }),
      h('span', { class: 'fine mono' }, `${total} / ${LIMITS.questions}`)));
}

function renderProblems(problems) {
  if (!problems.length) return h('p', { class: 'fine', style: 'color:var(--ok)' }, '✓ Ready to host.');
  return h('div', { class: 'notice' },
    h('b', null, `${plural(problems.length, 'thing')} to fix before hosting`),
    h('ul', { class: 'problems' }, problems.map((p) => h('li', null, p))));
}

function renderQuestionCard(qq, i, total) {
  const opts = qq.options;
  return h('section', { class: 'card q-card', 'aria-label': `Question ${i + 1}` },
    h('div', { class: 'q-head' },
      h('h3', null, `Question ${i + 1}`),
      h('div', { class: 'btn-row' },
        btn('↑', 'move-q', { cls: 'small icon', disabled: i === 0, attrs: { 'data-q': i, 'data-dir': -1, 'aria-label': `Move question ${i + 1} up` } }),
        btn('↓', 'move-q', { cls: 'small icon', disabled: i === total - 1, attrs: { 'data-q': i, 'data-dir': 1, 'aria-label': `Move question ${i + 1} down` } }),
        btn('Remove', 'remove-q', { cls: 'small danger', disabled: total <= 1, attrs: { 'data-q': i } }))),
    h('label', { class: 'field' },
      h('span', null, `Question text (1–${LIMITS.text} characters)`),
      h('textarea', { class: 'input', id: `q-${i}-text`, maxlength: LIMITS.text, rows: 2, 'data-field': 'q-text', 'data-q': i }, qq.text || '')),
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, `Options (2–4, each 1–${LIMITS.option} characters) — tick the correct one`),
      h('div', { class: 'opt-list', role: 'radiogroup', 'aria-label': `Correct option for question ${i + 1}` },
        opts.map((o, j) => h('div', { class: 'opt-row' },
          swatch(j),
          h('input', { class: 'input', id: `q-${i}-opt-${j}`, type: 'text', maxlength: LIMITS.option, value: o || '', 'data-field': 'opt', 'data-q': i, 'data-i': j, autocomplete: 'off', 'aria-label': `Option ${LETTERS[j]} (${SHAPES[j].name})` }),
          h('span', { class: 'radio-wrap' },
            h('input', { type: 'radio', name: `correct-${i}`, value: j, checked: qq.correct === j || null, 'data-field': 'correct', 'data-q': i, 'aria-label': `Option ${LETTERS[j]} is the correct answer` })),
          btn('×', 'remove-opt', { cls: 'small icon', disabled: opts.length <= 2, attrs: { 'data-q': i, 'data-i': j, 'aria-label': `Remove option ${LETTERS[j]}` } }))),
        opts.length < 4 && h('div', null, btn('+ Add option', 'add-opt', { cls: 'small', attrs: { 'data-q': i } })))),
    h('div', { class: 'inline-fields' },
      h('label', { class: 'field' }, h('span', null, 'Time limit'),
        h('select', { class: 'input', 'data-field': 'timeLimit', 'data-q': i },
          TIME_LIMITS.map((t) => h('option', { value: t, selected: qq.timeLimit === t || null }, `${t} seconds`)))),
      h('label', { class: 'field' }, h('span', null, 'Points'),
        h('select', { class: 'input', 'data-field': 'points', 'data-q': i },
          POINTS.map((p) => h('option', { value: p, selected: qq.points === p || null }, p === 0 ? '0 — survey, nobody scores' : String(p)))))));
}

// Typing must not rebuild the form (it would steal the caret), so text edits only refresh these two bits.
function refreshEditorStatus(q, saved) {
  const box = $('problems-box');
  if (box) box.replaceChildren(renderProblems(validateQuiz(q)));
  const auto = $('autosave');
  if (auto) auto.textContent = saved === false ? NOT_SAVED_MSG : 'Saved ' + new Date().toLocaleTimeString();
}

/* ---------- 4c. SETUP (settings before hosting) ---------- */

function renderSetup() {
  const q = findQuiz(state.editorId);
  if (!q) { state.screen = 'home'; return renderHome(); }
  const problems = validateQuiz(q);
  const s = state.prefs.settings;
  return h('div', { class: 'wrap page' },
    h('div', null, btn('← Back to editor', 'edit', { cls: 'ghost', attrs: { 'data-id': q.id } })),
    h('div', { class: 'page-head' },
      h('div', null,
        h('p', { class: 'eyebrow' }, 'Before hosting'),
        h('h1', null, q.title || 'Untitled quiz'),
        h('p', { class: 'lede mono' }, `${plural(q.questions.length, 'question')} · about ${fmtDuration(quizDurationSec(q))} of play`))),
    problems.length ? h('div', { class: 'notice bad' },
      h('b', null, 'This quiz cannot be hosted yet'),
      h('ul', { class: 'problems' }, problems.map((p) => h('li', null, p))),
      h('div', { class: 'btn-row' }, btn('Fix in editor', 'edit', { attrs: { 'data-id': q.id } }))) : null,
    !isExported(q) && h('div', { class: 'notice' },
      h('b', null, 'Export a copy before hosting'),
      h('p', { class: 'fine' },
        q.exportedAt ? 'This quiz has changed since it was last exported. ' : 'This quiz exists only in this browser. ',
        'If the browser clears its storage, the latest version is gone. Save a .json copy first — it takes one click.'),
      h('div', { class: 'btn-row' }, btn('Export .json', 'export', { attrs: { 'data-id': q.id } }))),
    h('section', { class: 'card' },
      h('h2', null, 'Scoring'),
      h('div', { class: 'radio-group' }, MODES.map((m) => radio('s-mode', m.id, s.mode === m.id, m.label, m.desc)))),
    h('section', { class: 'card' },
      h('h2', null, 'Room options'),
      toggle('s-showOnDevices', s.showOnDevices, 'Show question and options on phones', 'Off: phones show only the four shapes; the question lives on the projector. Can be changed during the game.'),
      toggle('s-lateJoin', s.lateJoin, 'Allow late joiners', 'Students who join after the start score 0 for the questions they missed. Can be changed during the game.'),
      toggle('s-earlyClose', s.earlyClose, 'Close early when everyone has answered', 'Otherwise each question runs for its full time, or until you press “Close now”.'),
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Nicknames'),
        h('div', { class: 'radio-group' },
          radio('s-nicknameMode', 'free', s.nicknameMode === 'free', 'Students type a nickname', 'Filtered for profanity; duplicates get a number.'),
          radio('s-nicknameMode', 'spin', s.nicknameMode === 'spin', 'Random two-word names only', 'e.g. “Brave Otter”. No typing, nothing to moderate.')))),
    renderNetCheck(),
    h('section', { class: 'card accent' },
      h('h2', null, 'Host'),
      h('p', { class: 'fine' }, 'Creates a room with a 6-digit PIN. Keep this tab open on the projector for the whole game.'),
      state.error && h('div', { class: 'notice bad', role: 'alert' }, state.error),
      h('div', { class: 'btn-row' },
        btn(state.busy ? 'Creating room…' : 'Host this quiz', 'host', { cls: 'primary big', disabled: problems.length > 0 || state.busy, attrs: { 'data-id': q.id } }))));
}

/* ---------- 4d. STAGE scaffolding (shared by lobby / question / reveal / podium / ended) ---------- */

// opts.controlsFirst puts the controls BEFORE the body in DOM order (host.css keeps them at the
// bottom visually with flex `order`), so keyboard and screen-reader users reach Lock / Show on
// phones / Start without passing every player chip first.
function stageFrame(body, controls, hint, opts) {
  const g = state.game || {};
  const o = opts || {};
  const ctl = controls && controls.length
    ? h('div', { class: 'controls' }, hint ? h('span', { class: 'hint' }, hint) : null, controls.map(stableControlId))
    : null;
  return h('div', { class: 'stage' },
    renderStageHead(g),
    o.controlsFirst ? ctl : null,
    h('section', { class: 'stage-body' }, body),
    o.controlsFirst ? null : ctl);
}
// Stage controls get a stable id (ctl-<action>) so render() can hand focus back after a rebuild.
function stableControlId(el) {
  if (el instanceof Element && !el.id && el.dataset && el.dataset.action) el.id = 'ctl-' + el.dataset.action;
  return el;
}

function renderStageHead(g) {
  const count = g.playerCount | 0;
  return h('header', { class: 'stage-head' },
    h('span', { class: 'pin' }, 'PIN ', h('b', null, g.pin || '')),
    h('span', null, location.host + '/play'),
    h('span', { class: 'grow' }, plural(count, 'player'), g.locked ? ' · locked' : ''),
    g.phase && g.phase !== 'ended' && isLive() ? renderStageMenu(g) : null);
}

// Live options: showOnDevices and lateJoin may change in any phase (PROTOCOL §2); lock too (§4.2).
function renderStageMenu(g) {
  const s = g.settings || DEFAULT_SETTINGS;
  return h('details', { class: 'stage-menu', id: 'stage-menu' },
    h('summary', { id: 'stage-menu-summary' }, 'Options'),
    h('div', { class: 'menu-body' },
      toggle('g-showOnDevices', !!s.showOnDevices, 'Show question on phones', 'Off: phones show only the four shapes.'),
      toggle('g-lateJoin', !!s.lateJoin, 'Allow late joiners', null),
      toggle('g-lock', !!g.locked, 'Lock room', 'No new players; reconnects still work.'),
      h('hr'),
      btn(g.phase === 'lobby' ? 'Cancel game' : 'End game now', 'abort', { cls: 'danger', attrs: { id: 'menu-abort' } }),
      h('p', { class: 'fine', style: 'color:var(--stage-ink-soft);font-size:0.8rem' },
        g.phase === 'lobby' ? 'Ends the game at once. Nothing has been played, so no results file is made.' : 'Ends the game at once and downloads the results so far.')));
}

function abortOnlyControls() { return [btn('End game', 'abort', { cls: 'danger' })]; }

/* ---------- 4e. CONNECTING ---------- */

function renderConnecting() {
  const g = state.game;
  return stageFrame(
    h('div', { class: 'center-card' },
      h('h1', null, 'Connecting…'),
      h('p', null, 'Opening the host connection for game ', h('b', { class: 'mono' }, g.pin), '.'),
      h('p', { class: 'fine' }, 'If this takes more than a few seconds, check the connection pill at the top.')),
    [btn('Back to my quizzes', 'leave', { cls: 'ghost' })]);
}

/* ---------- 4f. LOBBY ---------- */

function renderLobby() {
  const g = state.game;
  const s = g.settings || DEFAULT_SETTINGS;
  const roster = Array.isArray(g.roster) ? g.roster : [];
  const count = typeof g.playerCount === 'number' ? g.playerCount : roster.length;
  const url = joinUrl(g.pin);
  return stageFrame(
    h('div', { class: 'lobby' },
      h('div', { class: 'lobby-join' },
        h('p', { class: 'eyebrow' }, 'Join at'),
        h('p', { class: 'join-url mono' }, url),
        h('p', { class: 'eyebrow' }, 'Game PIN'),
        h('p', { class: 'pin-big mono' }, g.pin),
        qrNode(url, g.pin)),
      h('div', { class: 'lobby-players' },
        h('h2', null, plural(count, 'player')),
        roster.length
          ? h('p', { class: 'fine', style: 'color:var(--stage-ink-soft)' }, 'Click a name to remove that player.')
          : h('p', { class: 'lobby-empty' }, 'Waiting for players to join…'),
        h('div', { class: 'players-grid' }, roster.map((p) =>
          h('button', {
            type: 'button',
            id: 'chip-' + p.pid,
            class: 'player-chip' + (p.connected === false ? ' offline' : ''),
            'data-action': 'kick', 'data-pid': p.pid, 'data-nick': p.nick,
            'aria-label': `Remove ${p.nick}${p.connected === false ? ' (offline)' : ''} from the game`,
            title: 'Remove this player',
          }, p.nick, p.connected === false ? ' (offline)' : ''))))),
    [
      btn(g.locked ? 'Locked' : 'Lock room', 'toggle-lock', { attrs: { 'aria-pressed': g.locked ? 'true' : 'false' } }),
      btn('Show on phones', 'toggle-show', { attrs: { 'aria-pressed': s.showOnDevices ? 'true' : 'false' } }),
      btn('Start ▸', 'start', { cls: 'primary big' }),
    ],
    'Space / Enter: start · F: fullscreen',
    { controlsFirst: true });
}

// The QR is built locally from location.origin + a regex-checked PIN, then parsed as SVG (no innerHTML).
function qrNode(url, pin) {
  if (!qrCache || qrCache.pin !== pin) {
    let svg = null;
    try {
      if (typeof window.qrcode !== 'function') throw new Error('qrcode.js missing');
      const qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      const markup = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
      if (doc.documentElement.nodeName !== 'svg') throw new Error('bad svg');
      svg = document.importNode(doc.documentElement, true);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'QR code for ' + url);
    } catch (e) { svg = null; }
    qrCache = { pin, svg };
  }
  if (!qrCache.svg) return h('p', { class: 'fine', style: 'color:var(--stage-ink-soft)' }, 'QR code unavailable — use the URL and PIN above.');
  return h('div', { class: 'qr' }, qrCache.svg.cloneNode(true));
}

/* ---------- 4g. QUESTION (intro / open) ---------- */

function renderCounter(q, g) {
  return h('p', { class: 'q-counter' },
    h('span', null, `Question ${(q.q | 0) + 1} of ${q.total || g.total || '?'}`),
    h('span', null, q.points === 0 ? 'Survey — no points' : `${fmtInt(q.points)} points`),
    h('span', null, `${q.timeLimit} s`));
}

function renderRing() {
  const wrap = h('div', { class: 'ring', id: 'ring', role: 'timer' });
  const svg = svgEl('svg', { viewBox: '0 0 120 120', 'aria-hidden': 'true' });
  svg.appendChild(svgEl('circle', { class: 'track', cx: 60, cy: 60, r: RING_R }));
  svg.appendChild(svgEl('circle', { class: 'progress', id: 'ring-progress', cx: 60, cy: 60, r: RING_R, 'stroke-dasharray': RING_C.toFixed(2), 'stroke-dashoffset': '0' }));
  wrap.appendChild(svg);
  wrap.appendChild(h('div', { class: 'num', id: 'ring-num' }));
  return wrap;
}

function optionTile(slot, text, reveal) {
  const cls = `opt-tile slot-${slot}` + (reveal && reveal.correct ? ' is-correct' : '') + (reveal && reveal.dim ? ' is-dim' : '');
  const tile = h('div', { class: cls },
    h('span', { class: 'shape', role: 'img', 'aria-label': SHAPES[slot].name }, shapeSvg(slot)),
    h('span', { class: 'label' }, text));
  if (reveal) {
    if (reveal.correct) tile.appendChild(checkIcon());
    tile.appendChild(h('span', { class: 'count mono', 'aria-label': plural(reveal.count, 'answer') }, String(reveal.count)));
    const bar = h('span', { class: 'bar', 'aria-hidden': 'true' });
    bar.style.width = (reveal.max ? Math.round(100 * reveal.count / reveal.max) : 0) + '%';
    tile.appendChild(bar);
  }
  return tile;
}

function renderQuestion(phase) {
  const g = state.game;
  const q = g.question;
  if (!q) return stageFrame(h('p', { class: 'lobby-empty' }, 'Waiting for the question…'), abortOnlyControls());
  const tally = g.tally || emptyTally(q.optionCount, g.playerCount);
  const options = Array.isArray(q.options) ? q.options : [];
  return stageFrame(
    [
      renderCounter(q, g),
      h('h1', { class: 'q-text' }, q.text || ''),
      h('div', { class: 'q-meta' },
        renderRing(),
        phase === 'intro'
          ? h('p', { class: 'answered' }, 'Get ready…', h('small', null, 'the clock starts in a moment'))
          : h('p', { class: 'answered', id: 'answered' }, `${tally.answered | 0} of ${tally.expected | 0}`, h('small', null, 'answered'))),
      h('div', { class: 'options' }, options.map((o, i) => optionTile(i, o))),
    ],
    phase === 'open'
      ? [btn('Close now', 'close', { cls: 'primary big' })]
      : [btn('Get ready…', 'noop', { cls: 'big', disabled: true })],
    phase === 'open' ? 'Space / Enter: close now' : null);
}

/* ---------- 4h. REVEAL (closed) ---------- */

function renderBoard(list, withDelta) {
  if (!list.length) return h('p', { class: 'fine', style: 'color:var(--stage-ink-soft)' }, 'No scores yet.');
  return h('ol', { class: 'board' }, list.slice(0, 10).map((p, i) => h('li', null,
    h('span', { class: 'rank' }, `${i + 1}.`),
    h('span', { class: 'nick' }, p.nick),
    h('span', { class: 'score' }, fmtInt(p.score)),
    withDelta ? h('span', { class: 'delta' + (p.delta ? '' : ' zero') }, (p.delta > 0 ? '+' : '') + fmtInt(p.delta || 0)) : null)));
}

function renderReveal() {
  const g = state.game;
  const q = g.question;
  const r = g.reveal;
  if (!q || !r) return stageFrame(h('p', { class: 'lobby-empty' }, 'Waiting for the results of this question…'), abortOnlyControls());
  const counts = Array.isArray(r.counts) ? r.counts : (g.tally && g.tally.counts) || [];
  const max = Math.max(1, ...counts.map((c) => c | 0));
  const options = Array.isArray(q.options) ? q.options : [];
  const total = q.total || g.total || 0;
  const isLast = total > 0 && (q.q | 0) + 1 >= total;
  const lb = Array.isArray(g.leaderboard) ? g.leaderboard : (Array.isArray(r.leaderboard) ? r.leaderboard : []);
  return stageFrame(
    [
      renderCounter(q, g),
      h('h1', { class: 'q-text' }, q.text || ''),
      h('div', { class: 'reveal-row' },
        h('div', { class: 'stage-body' },
          h('div', { class: 'options' }, options.map((o, i) => optionTile(i, o, { count: counts[i] | 0, max, correct: i === r.correct, dim: i !== r.correct }))),
          h('p', { class: 'answered' }, `${r.answered | 0} of ${r.expected | 0}`, h('small', null, 'answered')),
          h('p', { class: 'fastest' },
            r.fastest && r.fastest.nick
              ? ['Fastest correct: ', h('b', null, r.fastest.nick), ` (${fmtSec(r.fastest.ms)})`]
              : (q.points === 0 ? 'Survey question — no points awarded.' : 'Nobody got this one right.'))),
        h('div', null, h('p', { class: 'board-title' }, 'Leaderboard'), renderBoard(lb, true))),
    ],
    [btn(isLast ? 'Show podium ▸' : 'Next question ▸', 'next', { cls: 'primary big' })],
    'Space / Enter: next');
}

/* ---------- 4i. PODIUM ---------- */

function renderPodium() {
  const g = state.game;
  const lb = Array.isArray(g.leaderboard) ? g.leaderboard : [];
  // PROTOCOL lists `podium.top` under player-only sync fields; a resumed host derives top 3 from the leaderboard.
  const top = g.podium && Array.isArray(g.podium.top) && g.podium.top.length ? g.podium.top : lb.slice(0, 3);
  const places = [1, 0, 2].map((idx) => {           // 2nd · 1st · 3rd, so 1st stands in the middle
    const p = top[idx];
    return h('div', { class: `place place-${idx + 1}` + (p ? '' : ' empty') },
      h('div', { class: 'nick' }, p ? p.nick : '—'),
      h('div', { class: 'score' }, p ? fmtInt(p.score) + ' pts' : ''),
      h('div', { class: 'block', 'aria-label': `${idx + 1}${['st', 'nd', 'rd'][idx]} place` }, String(idx + 1)));
  });
  return stageFrame(
    [
      h('p', { class: 'eyebrow' }, g.title || ''),
      h('h1', { class: 'podium-title' }, 'Podium'),
      h('div', { class: 'podium' }, places),
      lb.length ? [h('p', { class: 'board-title' }, 'Top 10'), renderBoard(lb, false)] : null,
    ],
    [btn('End game', 'end', { cls: 'primary big' })],
    'Space / Enter: end game · the results file downloads next');
}

/* ---------- 4j. ENDED / WIPED / DISCONNECTED ---------- */

// The results we hold for THIS game (state.results survives reconnects and later syncs).
function heldResults(g) {
  return g && state.results && state.results.pin === g.pin ? state.results : null;
}
// `end` sent from the lobby (q is still -1) or before anyone answered the first question: nothing
// worth a results file exists, so the host page neither downloads one nor asks the teacher to
// confirm they have it. From q >= 1 on, a question has been closed and the file matters.
function gameWasCancelled(g) {
  if (!g || typeof g.q !== 'number') return false;           // no sync yet: never hide a held results file
  const q = g.q;
  if (q < 0) return true;
  if (q > 0) return false;
  if (g.reveal) return false;
  if (g.tally && (g.tally.answered | 0) > 0) return false;
  const roster = Array.isArray(g.roster) ? g.roster : [];
  return !roster.some((p) => p && (p.answered || (p.score | 0) > 0));
}
// "Download started", never "downloaded": the page cannot see whether the browser saved the file.
function resultsStatus(r) {
  return r.downloaded ? ' — download started. Check your Downloads folder before wiping.' : ' is ready to download.';
}
function downloadButton(r) {
  return btn(r.downloaded ? 'Download again' : 'Download the results', 'download');
}

function renderEnded() {
  const g = state.game;
  const r = heldResults(g);
  if (gameWasCancelled(g)) return renderCancelled(r);
  return stageFrame(
    h('div', { class: 'center-card' },
      h('h1', null, 'Game over'),
      r ? [
        h('p', null, 'The results file ', h('b', { class: 'mono' }, r.filename), resultsStatus(r)),
        h('p', { class: 'fine' }, 'It is the only copy. Once you confirm below, nothing about this game remains on the server. The phones already show “Game over”.'),
        h('div', { class: 'btn-row' }, downloadButton(r)),
        h('div', { class: 'btn-row' }, btn('I have the results — wipe the game', 'ack', { cls: 'primary big' })),
      ] : [
        h('p', null, 'Waiting for the results file from the server…'),
        h('p', { class: 'fine' }, 'If this takes more than a few seconds, check the connection pill at the top. The room keeps the results for 30 minutes.'),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'link-btn danger', 'data-action': 'ack-anyway' }, 'Wipe the game without the results')),
      ]),
    []);
}

// A game aborted before anyone answered: one button, no results file, no "make sure the CSV is saved".
function renderCancelled(r) {
  return stageFrame(
    h('div', { class: 'center-card' },
      h('h1', null, 'Game cancelled'),
      h('p', null, 'The game ended before anyone answered a question, so there are no results to keep. The phones already show “Game over”.'),
      r ? [
        h('p', { class: 'fine' }, 'Wiping deletes the room and the player list from the server at once. Otherwise the server does it by itself later.'),
        h('div', { class: 'btn-row' }, btn('Wipe the game', 'ack-cancelled', { cls: 'primary big' })),
      ] : [
        h('p', { class: 'fine' }, 'Waiting for the server to confirm… If this takes more than a few seconds, check the connection pill at the top.'),
      ]),
    []);
}

// A results file we still hold is offered on every final screen: the server may have sent it just
// before a TTL wipe (podium → results_csv → wiped / 4004), and the Blob is gone once the page is left.
function finalScreenResults(g) {
  const r = heldResults(g);
  if (!r || gameWasCancelled(g)) return null;
  return [
    h('p', null, 'Results file ', h('b', { class: 'mono' }, r.filename),
      r.downloaded ? ' — download started. Check your Downloads folder.' : ' is still held by this page — download it before leaving.'),
    h('div', { class: 'btn-row' }, downloadButton(r)),
  ];
}

function renderWiped() {
  const extra = finalScreenResults(state.game);
  return stageFrame(
    h('div', { class: 'center-card' },
      h('div', { class: 'big-check', 'aria-hidden': 'true' }, '✓'),
      h('h1', null, 'Nothing about this game remains.'),
      h('p', { class: 'fine' }, 'The room, the players, the scores — all deleted.', extra ? ' Your CSV is the only copy.' : ''),
      extra,
      h('div', { class: 'btn-row' }, btn('Back to my quizzes', 'leave', { cls: 'primary' }))),
    []);
}

function renderDisconnected() {
  const ci = state.closeInfo;
  const msg = ci.reason || DEFAULT_CLOSE_MSG[ci.code] || `The connection was closed (code ${ci.code}).`;
  return stageFrame(
    h('div', { class: 'center-card' },
      h('h1', null, 'Connection closed'),
      h('p', null, msg),
      h('p', { class: 'fine' }, `Close code ${ci.code}.`),
      finalScreenResults(state.game),
      h('div', { class: 'btn-row' }, btn('Back to my quizzes', 'leave', { cls: 'primary' }))),
    []);
}

/* ---------- 4k. connection pill ---------- */

function renderPill() {
  const pill = $('conn-pill');
  const text = $('conn-text');
  if (!pill || !text) return;
  let status = state.conn.status;
  if (navigator.onLine === false && isLive()) status = 'offline';
  let label;
  switch (status) {
    case 'live': label = 'Connected'; break;
    case 'connecting': label = 'Connecting…'; break;
    case 'reconnecting': label = state.conn.detail ? `Reconnecting in ${state.conn.detail} s…` : 'Reconnecting…'; break;
    case 'offline': label = 'Offline — waiting for network'; break;
    case 'closed': label = 'Connection closed'; break;
    default: label = state.game ? 'Not connected' : 'Not hosting';
  }
  pill.dataset.status = status;
  text.textContent = label;
}
function setConn(status, detail) {
  state.conn = { status, detail: detail || '' };
  renderPill();
}

/* ======================================================================
   5. Actions (event delegation)
   ====================================================================== */

function openEditor(id) { state.editorId = id; state.screen = 'editor'; state.error = null; render(); }

// Mutate the quiz being edited, persist, then either rebuild (structural change) or just refresh the status line.
function editQuiz(mutate, structural) {
  const q = findQuiz(state.editorId);
  if (!q) return;
  mutate(q);
  q.updatedAt = Date.now();
  const saved = persistQuizzes();
  if (structural) render(); else refreshEditorStatus(q, saved);
}

const actions = {
  noop() {},
  home() { state.screen = 'home'; state.error = null; render(); },
  'new-quiz'() {
    const q = makeStored({ title: '', questions: [newQuestion()] });
    state.quizzes.push(q); persistQuizzes(); openEditor(q.id);
  },
  'load-sample'() {
    const q = makeStored(JSON.parse(JSON.stringify(SAMPLE_QUIZ)));
    state.quizzes.push(q); persistQuizzes(); openEditor(q.id);
    toast('Sample quiz loaded. Edit it or host it as is.');
  },
  import() { $('import-file').click(); },
  'import-text'() { importerOpener = 'import-text-btn'; $('import-text-file').click(); },
  'paste-open'() { openImporter({ mode: 'paste', source: 'paste', sourceName: '', text: lastPasteText, preview: null, error: null, busy: false }, 'paste-btn'); },
  'import-preview'() { previewPastedText(); },
  'import-edit-text'() { const imp = state.importer; if (!imp) return; imp.mode = 'paste'; imp.preview = null; imp.error = null; render(); focusImporter(); },
  'import-add'() { addImportedQuiz(); },
  'import-cancel'() { closeImporter(); },
  edit(d) { openEditor(d.id); },
  setup(d) { state.editorId = d.id; state.screen = 'setup'; state.error = null; render(); },
  duplicate(d) {
    const q = findQuiz(d.id); if (!q) return;
    const copy = makeStored({ title: `${q.title || 'Untitled quiz'} (copy)`.slice(0, LIMITS.title), questions: JSON.parse(JSON.stringify(q.questions)) });
    state.quizzes.push(copy); persistQuizzes(); render();
  },
  export(d) { exportQuiz(d.id); },
  delete(d) {
    const q = findQuiz(d.id); if (!q) return;
    if (!window.confirm(`Delete “${q.title || 'Untitled quiz'}”? This cannot be undone.`)) return;
    state.quizzes = state.quizzes.filter((x) => x.id !== d.id);
    persistQuizzes();
    if (state.editorId === d.id) { state.editorId = null; state.screen = 'home'; }
    render();
  },
  'add-question'() { editQuiz((q) => { if (q.questions.length < LIMITS.questions) q.questions.push(newQuestion()); }, true); },
  'remove-q'(d) {
    editQuiz((q) => {
      if (q.questions.length <= 1) return;
      const qq = q.questions[+d.q];
      if (qq && (qq.text || qq.options.some(Boolean)) && !window.confirm(`Remove question ${+d.q + 1}?`)) return;
      q.questions.splice(+d.q, 1);
    }, true);
  },
  'move-q'(d) {
    editQuiz((q) => {
      const i = +d.q, j = i + (+d.dir);
      if (j < 0 || j >= q.questions.length) return;
      const tmp = q.questions[i]; q.questions[i] = q.questions[j]; q.questions[j] = tmp;
    }, true);
  },
  'add-opt'(d) { editQuiz((q) => { const qq = q.questions[+d.q]; if (qq && qq.options.length < 4) qq.options.push(''); }, true); },
  'remove-opt'(d) {
    editQuiz((q) => {
      const qq = q.questions[+d.q]; const i = +d.i;
      if (!qq || qq.options.length <= 2) return;
      qq.options.splice(i, 1);
      // Removing the ticked option clears the tick (-1): validateQuiz then says "tick the correct
      // option" instead of the tick silently landing on whichever option slid into that slot.
      if (qq.correct === i) qq.correct = -1;
      else if (qq.correct > i) qq.correct -= 1;
    }, true);
  },
  'all-timers'() {
    const sel = $('all-timers'); const t = sel ? +sel.value : NaN;
    if (!TIME_LIMITS.includes(t)) return;
    state.allTimers = t;                                       // the rebuilt select keeps showing this value
    editQuiz((q) => { q.questions.forEach((qq) => { qq.timeLimit = t; }); }, true);
    toast(`All timers set to ${t} seconds.`);
  },
  'net-check'() { checkNetwork(); },
  host(d) { hostQuiz(d.id); },
  resume() { const key = loadHostKey(); if (key) connectHost(key); else render(); },
  'forget-host'() {
    if (!window.confirm('Forget this game on this browser? Students still connected will see it time out.')) return;
    removeKey(KEYS.host); render();
  },
  // ---- in-game ----
  start() {
    if (!state.game) return;
    if ((state.game.playerCount | 0) === 0 && !window.confirm('No players have joined yet. Start anyway?')) return;
    send({ t: 'start' });
  },
  close() { send({ t: 'close' }); },
  next() { send({ t: 'next' }); },
  end() { send({ t: 'end' }); },
  abort() {
    if (!state.game) return;
    const inLobby = state.game.phase === 'lobby';
    if (!window.confirm(inLobby ? 'Cancel this game? Players will be sent away.' : 'End the game now? You will get the results so far.')) return;
    send({ t: 'end' });
  },
  kick(d) {
    if (!window.confirm(`Remove ${d.nick || 'this player'} from the game? They cannot rejoin.`)) return;
    send({ t: 'kick', pid: d.pid });
  },
  'toggle-lock'() { if (state.game) setLock(!state.game.locked); },
  'toggle-show'() { if (state.game) updateSettings({ showOnDevices: !(state.game.settings && state.game.settings.showOnDevices) }); },
  download() { downloadResults(); },
  ack() {
    if (!state.results) { toast('No results file has arrived yet.'); return; }
    if (!window.confirm('Wipe the game? The server deletes everything about it. Make sure the CSV is saved.')) return;
    send({ t: 'ack_results' });
  },
  'ack-anyway'() {
    if (!window.confirm('No results file was received. Wipe the game anyway? The scores will be lost for good.')) return;
    send({ t: 'ack_results' });
  },
  'ack-cancelled'() { send({ t: 'ack_results' }); },          // nothing was played, so nothing to confirm
  leave() { leaveGame(); },
  'toggle-contrast'() { toggleContrast(); },
  'toggle-fullscreen'() { toggleFullscreen(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest ? e.target.closest('[data-action]') : null;
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  fn(el.dataset, el);
});

// Text fields (editor): update + autosave on every keystroke without rebuilding the form.
document.addEventListener('input', (e) => {
  const el = e.target;
  const f = el && el.dataset ? el.dataset.field : null;
  if (!f) return;
  if (f === 'title') editQuiz((q) => { q.title = el.value; });
  else if (f === 'q-text') editQuiz((q) => { const qq = q.questions[+el.dataset.q]; if (qq) qq.text = el.value; });
  else if (f === 'opt') editQuiz((q) => { const qq = q.questions[+el.dataset.q]; if (qq) qq.options[+el.dataset.i] = el.value; });
  // Import dialog: typing never rebuilds the dialog; the state just follows the fields.
  else if (f === 'import-text') { if (state.importer) state.importer.text = el.value; }
  else if (f === 'import-title') { if (state.importer && state.importer.preview) state.importer.preview.quiz.title = el.value; }
});

// Selects, radios and checkboxes: editor, pre-host settings and live game options.
document.addEventListener('change', (e) => {
  const el = e.target;
  const f = el && el.dataset ? el.dataset.field : null;
  if (!f) return;
  const qi = +el.dataset.q;
  switch (f) {
    case 'correct': editQuiz((q) => { const qq = q.questions[qi]; if (qq) qq.correct = +el.value; }); break;
    case 'timeLimit': editQuiz((q) => { const qq = q.questions[qi]; const t = +el.value; if (qq && TIME_LIMITS.includes(t)) qq.timeLimit = t; }); break;
    case 'points': editQuiz((q) => { const qq = q.questions[qi]; const p = +el.value; if (qq && POINTS.includes(p)) qq.points = p; }); break;
    case 'all-timers': { const t = +el.value; if (TIME_LIMITS.includes(t)) state.allTimers = t; break; }
    case 's-mode': if (MODES.some((m) => m.id === el.value)) { state.prefs.settings.mode = el.value; savePrefs(); } break;
    case 's-showOnDevices': state.prefs.settings.showOnDevices = !!el.checked; savePrefs(); break;
    case 's-lateJoin': state.prefs.settings.lateJoin = !!el.checked; savePrefs(); break;
    case 's-earlyClose': state.prefs.settings.earlyClose = !!el.checked; savePrefs(); break;
    case 's-nicknameMode': if (el.value === 'free' || el.value === 'spin') { state.prefs.settings.nicknameMode = el.value; savePrefs(); } break;
    case 'g-showOnDevices': updateSettings({ showOnDevices: !!el.checked }); break;
    case 'g-lateJoin': updateSettings({ lateJoin: !!el.checked }); break;
    case 'g-lock': setLock(!!el.checked); break;
    default: break;
  }
});

$('import-file').addEventListener('change', async () => {
  const input = $('import-file');
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast('That file is not valid JSON.'); return; }
  const items = Array.isArray(data) ? data : [data];
  const added = [];
  const dropped = { questions: 0, options: 0 };
  for (const item of items) {
    const n = normaliseQuiz(item);
    if (!n) continue;
    dropped.questions += n.dropped.questions;
    dropped.options += n.dropped.options;
    added.push(makeStored(n, true));                 // a file exists outside the browser, so it counts as exported
  }
  if (!added.length) { toast('No quiz found in that file. Expected {"title": "…", "questions": [ … ]}.'); return; }
  state.quizzes.push(...added);
  persistQuizzes();
  const problems = added.reduce((n, q) => n + validateQuiz(q).length, 0);
  let msg = `Imported ${added.length === 1 ? '1 quiz' : added.length + ' quizzes'}` + (problems ? ` — ${plural(problems, 'thing')} to fix.` : '.');
  if (dropped.options || dropped.questions) {
    msg += ` ${plural(dropped.options, 'option')} and ${plural(dropped.questions, 'question')} over the limits (4 per question, 100 per quiz) were dropped — re-check the ticked answers.`;
  }
  toast(msg, 9000);
  if (added.length === 1) openEditor(added[0].id); else { state.screen = 'home'; render(); }
});

/* ---------- import from Word / text (import-text.js does the parsing) ---------- */

// "Import Word or text": the file is read in this browser by HomPubImport.textFromFile (a .docx is unzipped
// locally), parsed by parseQuizText, and shown in the preview dialog for the teacher to check before anything
// is stored. Nothing here can throw out of the handler: every failure becomes a message in the dialog.
$('import-text-file').addEventListener('change', async () => {
  const input = $('import-text-file');
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const name = String(file.name || 'file');
  const imp = { mode: 'preview', source: 'file', sourceName: name, text: '', preview: null, error: null, busy: false };
  const problem = importFileProblem(file);
  if (problem) { openImporter(Object.assign(imp, { error: problem }), 'import-text-btn'); return; }
  const api = importApi();
  if (!api || typeof api.textFromFile !== 'function') { openImporter(Object.assign(imp, { error: IMPORT_HELPER_MISSING }), 'import-text-btn'); return; }
  openImporter(Object.assign(imp, { busy: true }), 'import-text-btn');
  let text = '';
  let error = null;
  try { text = String(await api.textFromFile(file)); } catch (e) { error = importReadError(name, e); }
  if (state.importer !== imp) return;                        // closed while the file was being read
  imp.busy = false;
  if (error) imp.error = error;
  else Object.assign(imp, runImportParse(text, importTitleFromName(name)));
  render();
  focusImporter();
});

function importApi() {
  const api = window.HomPubImport;
  return api && typeof api.parseQuizText === 'function' ? api : null;
}

// Pure helpers (no DOM), so they can be unit-tested outside the browser.
function importTitleFromName(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base.slice(0, LIMITS.title) || 'Imported quiz';
}
// Why a file is refused before it is read, or null when it may be read. Checks name and size only.
function importFileProblem(file) {
  const name = String((file && file.name) || '');
  const size = Number(file && file.size) || 0;
  if (/\.doc$/i.test(name)) return 'This is an old-style .doc file. In Word choose File → Save As and pick “Word Document (.docx)”, then import that.';
  if (!IMPORT_FILE_RE.test(name)) return `“${name || 'This file'}” is not a Word (.docx) or text (.txt) file. Save it as .docx or .txt first, or paste the questions instead.`;
  if (size > IMPORT_MAX_BYTES) return `This file is ${(size / (1024 * 1024)).toFixed(1)} MB; the limit is 5 MB. A quiz needs only text — remove the pictures, or paste the questions instead.`;
  return null;
}
function importReadError(name, e) {
  const detail = e && typeof e.message === 'string' && e.message.trim() ? e.message.trim() : 'it could not be read.';
  // The parser's own messages already say what to do; only add the hint when they do not.
  const hint = /paste|\.docx/i.test(detail) ? '' : ' If it is a Word file, make sure it is saved as .docx; otherwise paste the questions instead.';
  return `Could not read “${name}”: ${detail}${hint}`;
}
// Runs HomPubImport.parseQuizText. Never throws: a missing script or a parser bug become a readable error.
function runImportParse(text, fallbackTitle) {
  const api = importApi();
  if (!api) return { preview: null, error: IMPORT_HELPER_MISSING };
  try {
    return { preview: shapeImportResult(api.parseQuizText(text, { title: fallbackTitle }), fallbackTitle), error: null };
  } catch (e) {
    return { preview: null, error: 'The text could not be read: ' + (e && e.message ? e.message : 'unknown error') + '. Try pasting a smaller part of it.' };
  }
}
// Whatever parseQuizText returned, the preview gets the shapes it renders: questions through
// normaliseQuiz (so correct → -1 and the limits follow the editor's rules), warnings as
// {question: 1-based | null, message}, skipped as a count. Zero questions stay zero (normaliseQuiz
// alone would insert a blank question).
function shapeImportResult(r, fallbackTitle) {
  const quiz = r && r.quiz && typeof r.quiz === 'object' ? r.quiz : {};
  const rawQuestions = Array.isArray(quiz.questions) ? quiz.questions : [];
  const n = rawQuestions.length ? normaliseQuiz({ title: '', questions: rawQuestions }) : null;
  const title = String(quiz.title == null ? '' : quiz.title).replace(/\s+/g, ' ').trim().slice(0, LIMITS.title) || fallbackTitle;
  const warnings = (Array.isArray(r && r.warnings) ? r.warnings : [])
    .map((w) => (w && typeof w === 'object'
      ? { question: Number.isInteger(w.question) && w.question > 0 ? w.question : null, message: String(w.message == null ? '' : w.message) }
      : { question: null, message: String(w == null ? '' : w) }))
    .filter((w) => w.message);
  const skipped = r && Number.isFinite(r.skipped) ? Math.max(0, Math.floor(r.skipped)) : 0;
  return { quiz: { title, questions: n ? n.questions : [] }, warnings, skipped };
}
function importToastMessage(count, toFix, warningCount) {
  let msg = `Imported ${plural(count, 'question')}`;
  if (toFix) msg += ` — ${toFix} to fix. The list above the questions says what.`;
  else if (warningCount) msg += '. Some text was trimmed to fit the limits — check it in the editor.';
  else msg += '.';
  return msg;
}

function openImporter(imp, openerId) {
  if (openerId) importerOpener = openerId;
  state.importer = imp;
  state.screen = 'home';
  render();
  focusImporter();
}
function closeImporter() {
  const imp = state.importer;
  if (!imp) return;
  if (imp.source === 'paste') { const ta = $('import-text'); lastPasteText = ta ? ta.value : (imp.text || ''); }
  state.importer = null;
  render();
  const back = importerOpener ? $(importerOpener) : null;
  if (back) { try { back.focus(); } catch (e) { /* ignore */ } }
}
// Paste mode: into the text box. Preview / error: onto the heading, so the count and the warnings are read in order.
function focusImporter() {
  const imp = state.importer;
  if (!imp) return;
  const el = imp.mode === 'paste' ? $('import-text') : $('importer-heading');
  if (el) { try { el.focus(); } catch (e) { /* ignore */ } }
}
function previewPastedText() {
  const imp = state.importer;
  if (!imp) return;
  const ta = $('import-text');
  imp.text = ta ? ta.value : (imp.text || '');
  if (!imp.text.trim()) { imp.error = 'Paste some questions first.'; render(); focusImporter(); return; }
  Object.assign(imp, runImportParse(imp.text, 'Pasted quiz'), { mode: 'preview' });
  render();
  focusImporter();
}
// Same path as "Import .json": normaliseQuiz → makeStored → persistQuizzes, then the editor, where any
// question without a marked answer shows up as "tick the correct option" (normaliseQuiz keeps correct = -1).
function addImportedQuiz() {
  const imp = state.importer;
  const p = imp && imp.preview;
  if (!p || !p.quiz.questions.length) return;
  const titleEl = $('import-quiz-title');
  const typed = String((titleEl ? titleEl.value : p.quiz.title) || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.title);
  const n = normaliseQuiz({ title: typed || p.quiz.title, questions: p.quiz.questions });
  if (!n) return;
  const stored = makeStored(n, false);                       // no .json copy exists yet, so the "export a copy" notice stays on
  state.quizzes.push(stored);
  persistQuizzes();
  if (imp.source === 'paste') lastPasteText = '';
  state.importer = null;
  openEditor(stored.id);
  toast(importToastMessage(stored.questions.length, validateQuiz(stored).length, p.warnings.length), 9000);
}

function exportQuiz(id) {
  const q = findQuiz(id); if (!q) return;
  const clean = cleanQuiz(q);
  const slug = clean.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'quiz';
  downloadText(JSON.stringify(clean, null, 2), `hompub-quiz-${slug}.json`, 'application/json');
  q.exportedAt = Date.now();
  persistQuizzes();
  render();
  toast('Exported. Keep that file somewhere safe.');
}

/* ---------- network preflight: WebSocket echo ---------- */

function wsBase() { return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host; }

function checkNetwork() {
  if (navigator.onLine === false) {
    state.netCheck = { status: 'fail', message: 'You appear to be offline. Connect to Wi-Fi first.' }; render(); return;
  }
  state.netCheck = { status: 'running', message: 'Opening a test WebSocket…' };
  render();
  let done = false;
  let ws = null;
  const finish = (ok, message) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    state.netCheck = { status: ok ? 'ok' : 'fail', message };
    render();
  };
  const timer = setTimeout(() => finish(false, BLOCKED_MSG), 3000);   // PROTOCOL: echo expected within 3 s
  try { ws = new WebSocket(wsBase() + '/api/echo'); } catch (e) { finish(false, BLOCKED_MSG); return; }
  ws.addEventListener('open', () => { try { ws.send('hello'); } catch (e) { finish(false, BLOCKED_MSG); } });
  ws.addEventListener('message', (ev) => { if (ev.data === 'hello') finish(true, 'WebSockets work on this network. You are good to host.'); });
  ws.addEventListener('close', () => { if (!done) finish(false, BLOCKED_MSG); });
  ws.addEventListener('error', () => { /* a close event follows */ });
}

/* ======================================================================
   6. Hosting: create room, connect, apply frames
   ====================================================================== */

async function hostQuiz(id) {
  const q = findQuiz(id); if (!q) return;
  const problems = validateQuiz(q);
  if (problems.length) { state.error = problems[0]; render(); return; }
  if (loadHostKey() && !window.confirm('Another game is still live from this browser. Starting a new one forgets the old one here (its room times out on the server). Continue?')) return;
  const quiz = cleanQuiz(q);
  const settings = Object.assign({}, DEFAULT_SETTINGS, state.prefs.settings);
  state.busy = true; state.error = null; render();

  let res;
  try {
    res = await fetch('/api/room', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quiz, settings }) });
  } catch (e) {
    failCreate('Could not reach the server. Check your connection (or run “Check my network”) and try again.'); return;
  }
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (!res.ok) { failCreate(createErrorMessage(res.status, body)); return; }
  if (!body || !PIN_RE.test(String(body.pin)) || typeof body.hostToken !== 'string' || !body.hostToken) {
    failCreate('The server sent an unexpected reply. Try again.'); return;
  }
  state.busy = false;
  const key = { pin: String(body.pin), hostToken: body.hostToken, title: quiz.title };
  saveHostKey(key);
  connectHost(key);
}
function failCreate(message) { state.busy = false; state.error = message; render(); }
function createErrorMessage(status, body) {
  const detail = body && typeof body.error === 'string' ? body.error : '';
  switch (status) {
    case 400: return 'The server rejected the quiz' + (detail ? `: ${detail}` : '.');
    case 403: return 'The server refused this page’s origin. Open the host page from the quiz site itself, not a copy.';
    case 413: return 'The quiz is too large (over 200 KB). Shorten some questions.';
    case 429: return 'Too many games have been created today (the pilot allows 30 per network and 300 in total). Try again tomorrow, or from another network.';
    case 503: return 'No game PIN is free right now. Wait a minute and try again.';
    default: return `The server answered ${status}` + (detail ? ` (${detail})` : '') + '. Try again.';
  }
}

function connectHost(key) {
  if (socket) { socket.close(); socket = null; }
  state.game = { pin: key.pin, title: key.title || '', hostToken: key.hostToken };   // minimal until the first sync
  state.closeInfo = null; state.wiped = false; state.busy = false; state.error = null;
  if (state.results && state.results.pin !== key.pin) state.results = null;
  qrCache = null;
  const url = `${wsBase()}/api/room/${key.pin}/ws?role=host&token=${encodeURIComponent(key.hostToken)}`;
  socket = createSocket({ url, onFrame: applyFrame, onStatus: setConn, onClose: onSocketClosed });
  requestWakeLock();
  render();
}

function send(obj) {
  if (!socket || !socket.send(obj)) toast('Not connected right now — reconnecting…');
}
function updateSettings(partial) {
  if (!state.game) return;
  state.game.settings = Object.assign({}, state.game.settings || DEFAULT_SETTINGS, partial);   // optimistic; the `settings` reply confirms
  send({ t: 'settings', settings: partial });
  render();
}
function setLock(on) {
  if (!state.game) return;
  state.game.locked = !!on;                                   // optimistic; PROTOCOL gives `lock` no explicit reply
  send({ t: 'lock', on: !!on });
  render();
}

// Every server frame lands here. `sync` replaces the snapshot wholesale; deltas patch it in place.
function applyFrame(f) {
  if (typeof f.serverNow === 'number') clockOffset = f.serverNow - Date.now();
  const g = state.game;
  if (f.t !== 'sync' && !g) return;
  switch (f.t) {
    case 'sync': {
      const snap = Object.assign({}, f);
      delete snap.t; delete snap.serverNow;
      if (!PIN_RE.test(String(snap.pin))) snap.pin = g ? g.pin : '';
      if (snap.question && !snap.tally) snap.tally = emptyTally(snap.question.optionCount, snap.playerCount);
      if (!Array.isArray(snap.roster)) snap.roster = [];
      state.game = snap;
      if (snap.hostToken) saveHostKey({ pin: snap.pin, hostToken: snap.hostToken, title: snap.title });
      break;
    }
    case 'roster':
      g.roster = Array.isArray(f.players) ? f.players : [];
      if (typeof f.playerCount === 'number') g.playerCount = f.playerCount;
      break;
    case 'intro':
      g.phase = 'intro';
      g.question = f.question || null;
      if (g.question) { g.q = g.question.q; if (g.question.total) g.total = g.question.total; }
      g.reveal = null;
      g.tally = emptyTally(g.question ? g.question.optionCount : 0, g.playerCount);
      break;
    case 'open':
      g.phase = 'open';
      if (g.question && g.question.q === f.q && typeof f.deadline === 'number') g.question.deadline = f.deadline;
      break;
    case 'tally':
      if (g.question && f.q === g.question.q) g.tally = { counts: Array.isArray(f.counts) ? f.counts : [], answered: f.answered | 0, expected: f.expected | 0 };
      break;
    case 'reveal': {
      g.phase = 'closed';
      const r = Object.assign({}, f); delete r.t; delete r.serverNow;
      g.reveal = r;
      g.leaderboard = Array.isArray(f.leaderboard) ? f.leaderboard : [];
      g.tally = { counts: Array.isArray(f.counts) ? f.counts : [], answered: f.answered | 0, expected: f.expected | 0 };
      if (typeof f.playerCount === 'number') g.playerCount = f.playerCount;
      break;
    }
    case 'podium':
      g.phase = 'podium';
      g.podium = { top: Array.isArray(f.top) ? f.top : [] };
      if (Array.isArray(f.leaderboard)) g.leaderboard = f.leaderboard;
      if (typeof f.playerCount === 'number') g.playerCount = f.playerCount;
      break;
    case 'results_csv': {
      // Arrives on `end`, again on every host connection while `ended`, and once before a TTL wipe
      // of a `podium` room (then `wiped` / 4004 follow). Keep what we hold; download only when the
      // file is new or has changed, so a Wi-Fi blip on the Game over screen does not drop another
      // "… (1).csv". A cancelled game (nothing answered) gets no file at all.
      g.phase = 'ended';
      if (typeof f.csv === 'string') {
        const held = heldResults(g);
        if (!held || held.csv !== f.csv) {
          state.results = { pin: g.pin, csv: f.csv, filename: safeFilename(f.filename, g.pin), downloaded: false };
          if (!gameWasCancelled(g)) downloadResults();       // "Download the results" stays available either way
        }
      }
      break;
    }
    case 'wiped':
      finishWipe();
      return;                                                // finishWipe() renders
    case 'settings':
      if (f.settings && typeof f.settings === 'object') g.settings = Object.assign({}, g.settings || DEFAULT_SETTINGS, f.settings);
      if (typeof f.locked === 'boolean') g.locked = f.locked;
      break;
    case 'error':
      toast(typeof f.message === 'string' && f.message ? f.message : `Server error: ${f.code || 'unknown'}`);
      break;
    default:
      break;                                                 // unknown frame types are ignored
  }
  render();
}

function onSocketClosed(code, reason, willRetry) {
  if (willRetry) return;                                     // the pill shows "reconnecting"
  if (state.wiped) return;                                   // the expected 4004 after `wiped`
  if (code === 4004 && state.game && state.game.phase === 'ended') { finishWipe(); return; }   // `wiped` frame lost in flight: same meaning
  if (code === 4004 || code === 4001) removeKey(KEYS.host);  // this host key cannot work any more
  state.closeInfo = { code, reason: typeof reason === 'string' ? reason : '' };
  releaseWakeLock();
  render();
}

function finishWipe() {
  state.wiped = true;
  removeKey(KEYS.host);
  if (socket) { socket.close(); socket = null; }
  releaseWakeLock();
  setConn('idle');
  render();
}

function leaveGame() {
  if (socket) { socket.close(); socket = null; }
  state.game = null; state.closeInfo = null; state.wiped = false; state.results = null;
  state.screen = 'home';
  releaseWakeLock();
  setConn('idle');
  render();
}

function safeFilename(name, pin) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(name) && !/^\.+$/.test(name) ? name : `hompub-quiz-${pin}.csv`;
}
function downloadResults() {
  const r = state.results; if (!r) return;
  // A UTF-8 BOM makes Excel open accented nicknames correctly; it changes nothing for other tools.
  const csv = r.csv.charCodeAt(0) === 0xFEFF ? r.csv : '﻿' + r.csv;
  if (downloadText(csv, r.filename, 'text/csv;charset=utf-8')) r.downloaded = true;   // "started", the page cannot see more
  render();
}

/* ======================================================================
   7. Socket wrapper (PROTOCOL §4, §5)
   ====================================================================== */

function createSocket(opts) {
  let ws = null;
  let attempt = 0;
  let retryTimer = null;
  let pingTimer = null;
  let connectTimer = null;
  let stopped = false;

  function status(s, detail) { if (opts.onStatus) opts.onStatus(s, detail); }

  function connect() {
    if (stopped) return;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    clearTimeout(retryTimer); retryTimer = null;
    status('connecting');
    let s;
    try { s = new WebSocket(opts.url); } catch (e) { scheduleRetry(); return; }
    ws = s;
    // A handshake that hangs (captive portal, dead proxy) is closed after 10 s so the backoff loop continues.
    connectTimer = setTimeout(() => { if (s.readyState === WebSocket.CONNECTING) { try { s.close(); } catch (e) { /* ignore */ } } }, 10000);

    s.addEventListener('open', () => {
      if (s !== ws) return;
      clearTimeout(connectTimer);
      attempt = 0;
      status('live');
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { if (s.readyState === WebSocket.OPEN) { try { s.send('ping'); } catch (e) { /* ignore */ } } }, 25000);
    });
    s.addEventListener('message', (ev) => {
      if (s !== ws || typeof ev.data !== 'string' || ev.data === 'pong') return;
      let frame;
      try { frame = JSON.parse(ev.data); } catch (e) { return; }
      if (frame && typeof frame.t === 'string') opts.onFrame(frame);
    });
    s.addEventListener('close', (ev) => {
      if (s !== ws) return;
      clearTimeout(connectTimer);
      clearInterval(pingTimer); pingTimer = null;
      ws = null;
      if (stopped) return;
      const retry = !NO_RETRY_CODES.has(ev.code);
      if (!retry) { stopped = true; status('closed', ev.reason); }
      if (opts.onClose) opts.onClose(ev.code, ev.reason, retry);
      if (retry) scheduleRetry();
    });
    s.addEventListener('error', () => { /* the close event that follows drives the retry */ });
  }

  // 500 ms → 8 s, doubling, ±30 % jitter.
  function scheduleRetry() {
    if (stopped || retryTimer) return;
    const base = Math.min(8000, 500 * Math.pow(2, attempt));
    const delay = Math.round(base * (1 + 0.3 * (Math.random() * 2 - 1)));
    attempt += 1;
    status('reconnecting', String(Math.max(1, Math.round(delay / 1000))));
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  }

  // Called on visibilitychange→visible and 'online': reconnect at once instead of waiting out the backoff.
  function nudge() {
    if (stopped) return;
    if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send('ping'); } catch (e) { /* ignore */ } return; }
    if (ws && ws.readyState === WebSocket.CONNECTING) return;
    clearTimeout(retryTimer); retryTimer = null;
    connect();
  }
  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; } }
    return false;
  }
  function close() {
    stopped = true;
    clearTimeout(retryTimer); clearInterval(pingTimer); clearTimeout(connectTimer);
    if (ws) { try { ws.close(1000); } catch (e) { /* ignore */ } ws = null; }
  }

  connect();
  return { send, close, nudge };
}

/* ======================================================================
   8. Countdown (server clock)
   ====================================================================== */

const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function ensureTicker(phase) {
  const need = phase === 'intro' || phase === 'open';
  if (need && tickHandle === null) tickHandle = requestAnimationFrame(tick);
  if (!need && tickHandle !== null) { cancelAnimationFrame(tickHandle); tickHandle = null; }
}
function tick() {
  tickHandle = null;
  const g = state.game;
  const q = g && g.question;
  if (!q || (g.phase !== 'intro' && g.phase !== 'open')) return;
  const now = Date.now() + clockOffset;                       // the server's clock, as PROTOCOL §2 requires
  const end = g.phase === 'intro' ? q.opensAt : q.deadline;
  const total = g.phase === 'intro' ? INTRO_MS : (q.timeLimit | 0) * 1000;
  let remaining = Math.max(0, (typeof end === 'number' ? end : now) - now);
  const secs = Math.ceil(remaining / 1000);
  if (reducedMotion) remaining = secs * 1000;                 // step once a second instead of sweeping
  const frac = total > 0 ? Math.min(1, remaining / total) : 0;

  const num = $('ring-num');
  if (num) num.textContent = g.phase === 'open' && remaining === 0 ? '…' : String(secs);
  const prog = $('ring-progress');
  if (prog) prog.style.strokeDashoffset = String(RING_C * (1 - frac));
  const ring = $('ring');
  if (ring) ring.classList.toggle('urgent', g.phase === 'open' && secs <= 5);

  tickHandle = requestAnimationFrame(tick);
}

/* ======================================================================
   9. Wake lock, fullscreen, keyboard, contrast, toast, downloads
   ====================================================================== */

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { wakeLock = null; }                            // denied or unsupported: ignore
}
function releaseWakeLock() {
  if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
}

function toggleFullscreen() {
  const doc = document, root = document.documentElement;
  try {
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
    } else if (root.requestFullscreen) {
      const p = root.requestFullscreen();
      if (p && p.catch) p.catch(() => toast('Fullscreen is not available here. Try the browser’s own fullscreen (F11).'));
    } else if (root.webkitRequestFullscreen) {
      root.webkitRequestFullscreen();
    } else {
      toast('Fullscreen is not available in this browser. Try the browser’s own fullscreen (F11).');
    }
  } catch (e) { toast('Fullscreen is not available here.'); }
}
function onFullscreenChange() {
  const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
  const b = $('fullscreen-btn');
  if (b) { b.replaceChildren(on ? 'Exit fullscreen ' : 'Fullscreen ', h('kbd', null, 'F')); }
}

function applyContrast() {
  const on = !!state.prefs.highContrast;
  if (on) document.documentElement.dataset.contrast = 'high'; else delete document.documentElement.dataset.contrast;
  const b = $('contrast-btn');
  if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false');
}
function toggleContrast() { state.prefs.highContrast = !state.prefs.highContrast; savePrefs(); applyContrast(); }

function toast(message, ms) {
  const el = $('toast'); if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms || 4500);
}

// Returns true when the download was handed to the browser; whether it saved the file is invisible here.
function downloadText(text, filename, type) {
  try {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename, hidden: true });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  } catch (e) { toast('The download could not start. Use the download button.'); return false; }
}

// Space / Enter = the primary action of the current phase; F = fullscreen. Only while hosting, never while typing.
function primaryAction(phase) {
  switch (phase) {
    case 'lobby': return actions.start;
    case 'open': return actions.close;
    case 'closed': return actions.next;
    case 'podium': return actions.end;
    default: return null;
  }
}
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  if (e.key === 'Escape' && state.importer) { e.preventDefault(); closeImporter(); return; }
  const t = e.target && typeof e.target.closest === 'function' ? e.target : null;
  if (t && (t.closest('input, textarea, select') || t.isContentEditable)) return;   // typing
  const phase = currentPhase();
  if (!STAGE_PHASES.has(phase)) return;
  if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); return; }
  if (e.key === ' ' || e.key === 'Enter') {
    // Focus inside any control: that control acts itself. And right after a rebuild dropped focus to
    // <body> (see render()), a key meant for the control the teacher had reached must do nothing.
    if (t && t.closest('button, a, summary, label, input, select, textarea')) return;
    if (Date.now() < shortcutMuteUntil) return;
    const fn = primaryAction(phase);
    if (fn) { e.preventDefault(); fn(); }
  }
});

window.addEventListener('beforeunload', (e) => {
  if (isLive()) { e.preventDefault(); e.returnValue = ''; }   // browsers show their own generic warning
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (socket) socket.nudge();
  if (isLive()) requestWakeLock();
  renderPill();
});
window.addEventListener('online', () => { if (socket) socket.nudge(); renderPill(); });
window.addEventListener('offline', renderPill);
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);
window.addEventListener('storage', (e) => {                  // another tab changed the quiz list
  if (e.key === KEYS.quizzes && state.screen === 'home' && !state.game) { state.quizzes = loadQuizzes(); render(); }
});

/* ---------- init ---------- */
state.quizzes = loadQuizzes();
applyContrast();
render();

})();
