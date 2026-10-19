#!/usr/bin/env node
/**
 * HomPub Quiz load harness. Node 22, no dependencies: it uses only the global
 * WebSocket and fetch (plus node:fs for the optional --quiz file).
 *
 * Drives one host and many simulated phones through a whole game against a
 * running server, measures latencies and checks the server's behaviour
 * against ../PROTOCOL.md. Run the server first ("npm run dev" in quiz/).
 *
 *   node test/load.mjs --url http://localhost:8787 --players 150 --questions 20 \
 *        --time-limit 5 --answer-window 2000 --drop 0.2 --join-burst 10000 [--seed 42] [--verbose]
 *
 * Exit codes: 0 PASS, 1 FAIL (every violation is listed), 2 usage error or
 * server unreachable. stdout carries the report only; diagnostics go to stderr.
 *
 * Every random decision (answer delays, who is right, who drops and when, who
 * answers twice) comes from a small PRNG seeded with --seed, keyed per
 * player and question, so two runs with the same seed make the same choices
 * even though network timing differs.
 *
 * MIT License. Part of HomPub Quiz.
 */

import { readFileSync } from 'node:fs';

// ------------------------------------------------------------------- CLI

const TIME_LIMITS = [5, 10, 15, 20, 30, 60, 90, 120, 240];
const NO_RETRY = new Set([4001, 4003, 4004, 4009, 4010]); // PROTOCOL §4: never auto-reconnect after these
const INTRO_MS = 3000;
const GRACE_MS = 1000;
const WIPE_CLOSE_WAIT_MS = 15000;
const RESYNC_WAIT_MS = 5000;      // a reconnect (?token=) must be answered with sync within this (§5)
const HOST_SYNC_WAIT_MS = 10000;  // the host socket must deliver its first sync within this
const CLOCK_TOL_MS = 50;          // slack for clock-offset jitter when the harness reasons on the server clock

const DEFAULTS = {
  url: 'http://localhost:8787',
  players: 150,
  questions: 20,
  'time-limit': 5,
  'answer-window': 2000,
  drop: 0.2,
  'join-burst': 10000,
  seed: 42,
  quiz: '',
  verbose: false,
};

const USAGE = `Usage: node test/load.mjs [options]
  --url <http(s)://host[:port]>  server under test                         (default ${DEFAULTS.url})
  --players <n>                  simulated phones, 1-250                   (default ${DEFAULTS.players})
  --questions <n>                generated questions, 1-100                (default ${DEFAULTS.questions})
  --time-limit <s>               ${TIME_LIMITS.join('|')}                (default ${DEFAULTS['time-limit']})
  --answer-window <ms>           answers are sent uniformly within this many ms of "open" (default ${DEFAULTS['answer-window']})
  --drop <fraction>              share of players that drop and reconnect during each question (default ${DEFAULTS.drop})
  --join-burst <ms>              players join uniformly over this window   (default ${DEFAULTS['join-burst']})
  --seed <n>                     PRNG seed; same seed = same decisions     (default ${DEFAULTS.seed})
  --quiz <file>                  use this Quiz JSON (e.g. test/sample-quiz.json) instead of generating one
  --verbose                      log every host frame and player lifecycle event to stderr
  -h, --help                     this text
`;

function die(msg, code = 2) {
  process.stderr.write(`load.mjs: ${msg}\n`);
  process.exit(code);
}

function parseCli(argv) {
  const raw = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { process.stdout.write(USAGE); process.exit(0); }
    if (!arg.startsWith('--')) die(`unexpected argument "${arg}"\n${USAGE}`);
    let key = arg.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq !== -1) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    if (!(key in DEFAULTS)) die(`unknown option --${key}\n${USAGE}`);
    if (typeof DEFAULTS[key] === 'boolean') { raw[key] = val === undefined ? true : val !== 'false'; continue; }
    if (val === undefined) val = argv[++i];
    if (val === undefined) die(`--${key} needs a value`);
    if (typeof DEFAULTS[key] === 'number') {
      const n = Number(val);
      if (!Number.isFinite(n)) die(`--${key} must be a number, got "${val}"`);
      raw[key] = n;
    } else {
      raw[key] = val;
    }
  }
  const o = {
    url: raw.url.replace(/\/+$/, ''),
    players: raw.players,
    questions: raw.questions,
    timeLimit: raw['time-limit'],
    answerWindow: raw['answer-window'],
    drop: raw.drop,
    joinBurst: raw['join-burst'],
    seed: raw.seed,
    quizFile: raw.quiz,
    verbose: raw.verbose,
  };
  if (!/^https?:\/\/[^/\s]+$/.test(o.url)) die(`--url must look like http://host:port (got "${o.url}")`);
  if (!Number.isInteger(o.players) || o.players < 1 || o.players > 250) die('--players must be an integer from 1 to 250');
  if (!Number.isInteger(o.questions) || o.questions < 1 || o.questions > 100) die('--questions must be an integer from 1 to 100');
  if (!TIME_LIMITS.includes(o.timeLimit)) die(`--time-limit must be one of ${TIME_LIMITS.join(', ')}`);
  if (o.answerWindow < 0) die('--answer-window must be >= 0');
  if (o.drop < 0 || o.drop > 1) die('--drop must be between 0 and 1');
  if (o.joinBurst < 0) die('--join-burst must be >= 0');
  if (!Number.isInteger(o.seed)) die('--seed must be an integer');
  return o;
}

const opts = parseCli(process.argv.slice(2));
const WS_BASE = opts.url.replace(/^http/, 'ws'); // ws: on http, wss: on https

// ------------------------------------------------------------------ PRNG

/** mulberry32: tiny, fast, good enough for test decisions. Returns [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a few small integers into one 32-bit seed, so each (player, question) gets its own stream. */
function mix(...parts) {
  let h = 0x9e3779b9;
  for (const p of parts) {
    h ^= (p >>> 0) + 0x7f4a7c15;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Jitter for reconnect backoff only touches failure paths, so one shared stream is fine.
const jitterRng = mulberry32(mix(opts.seed, 4));

// ----------------------------------------------------------------- stats

function summarize(samples) {
  if (samples.length === 0) return { n: 0, p50: NaN, p95: NaN, max: NaN };
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s[s.length - 1] };
}

const fmtMs = (x) => (Number.isFinite(x) ? `${x < 10 ? x.toFixed(1) : Math.round(x)} ms` : '-');
const fmtStat = (st) => `p50 ${fmtMs(st.p50)}   p95 ${fmtMs(st.p95)}   max ${fmtMs(st.max)}   (n=${st.n})`;
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);
const letter = (i) => String.fromCharCode(65 + i);
const sumCounts = (counts) => (Array.isArray(counts) ? counts.reduce((a, b) => a + b, 0) : NaN);

/** PROTOCOL §3, mode "speed" (the harness creates rooms with default settings): points for a correct answer. */
function expectedPoints(elapsed, T, P) {
  const e = Math.min(Math.max(elapsed, 0), T);   // grace answers are scored as elapsed = T
  return e < 500 ? P : Math.round(P * (1 - (e / T) / 2));
}

// ------------------------------------------------------------------ quiz

const OPTION_WORDS = ['Alpha', 'Bravo', 'Charlie', 'Delta'];

/** N generated questions, 4 options each, 1000 points; the key cycles so it varies. */
function buildQuiz(n, timeLimit, rng) {
  const start = Math.floor(rng() * 4);
  const questions = [];
  for (let i = 0; i < n; i++) {
    questions.push({
      text: `Load question ${i + 1} of ${n}: which option is the key?`,
      options: OPTION_WORDS.map((w) => `${w} ${i + 1}`),
      correct: (start + i) % 4,
      timeLimit,
      points: 1000,
    });
  }
  return { title: `Load test: ${n} questions x ${timeLimit} s`, questions };
}

/** Load a Quiz (or {"quiz": Quiz}) from disk and fill the server's defaults so the harness knows the key. */
function loadQuiz(file) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { die(`cannot read --quiz ${file}: ${err.message}`); }
  const quiz = parsed && parsed.quiz ? parsed.quiz : parsed;
  if (!quiz || typeof quiz.title !== 'string' || !Array.isArray(quiz.questions) || quiz.questions.length === 0) die(`--quiz ${file}: expected {title, questions[]}`);
  for (const [i, q] of quiz.questions.entries()) {
    if (!Array.isArray(q.options) || !Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.options.length) die(`--quiz ${file}: question ${i + 1} needs options[] and a correct index`);
    if (q.timeLimit === undefined) q.timeLimit = 20;
    if (q.points === undefined) q.points = 1000;
  }
  return quiz;
}

// --------------------------------------------------------------- logging

const T0 = performance.now();
const log = (...a) => process.stderr.write(`${String(Math.round(performance.now() - T0)).padStart(7)} ms  ${a.join(' ')}\n`);
const vlog = opts.verbose ? log : () => {};

const violations = [];
const warnings = [];
function violate(msg) {
  violations.push(msg);
  if (opts.verbose || violations.length <= 20) log(`VIOLATION: ${msg}`);
  if (violations.length === 21 && !opts.verbose) log('(further violations are listed in the report only)');
}
function warn(msg) {
  warnings.push(msg);
  vlog(`warning: ${msg}`);
}

// ----------------------------------------------------------- shared state

const stats = {
  framesSent: 0, framesRecv: 0, bytesSent: 0, bytesRecv: 0, pings: 0, pongs: 0,
  reconnects: 0, reconnectsAfterDrop: 0, deliberateDrops: 0, unexpectedCloses: 0,
  unexpectedCloseLog: [],   // first 20, for the report: a violation in the same question may be their consequence
  closeCodes: new Map(),
  joinMs: [], ackMs: [], resyncMs: [],
};

const game = {
  pin: null, hostToken: null, quiz: null, N: 0, showOnDevices: false,
  phase: 'lobby', q: -1,
  startedAt: 0, readyAtStart: 0, podiumAt: 0, endAt: 0, wipedAt: 0, lastCloseAt: 0, t0: 0,
  // per question (index q)
  introAt: [], introWall: [], openAt: [], revealAt: [], reveals: [],
  answersSent: [], acceptedAcks: [], uncertain: [], dropped: [], expectedResult: [],
  tallies: 0, dupsSent: 0, dupsRejected: 0, dupsLate: 0, dupsLost: 0,
  expectEnded: [],    // players with an open, synced socket when the host sent "end": each must get an "ended" frame
  resyncAudit: null,  // { resyncs, afterDrop, pending } snapshot taken when the host sent "end"
  over: false,        // host has sent "end": phones stop reconnecting, 4004 closes are expected
  aborted: null,      // reason string when the run was cut short
  csv: null, csvName: null,
  done: null,         // resolves the main() promise
};

const players = [];
let host = null;
let readyCount = 0;   // players that have received their first sync while in the lobby
let lobbyTimer = 0;

/** Send a JSON frame (or the literal "ping"). Returns false when the socket is not open. */
function send(ws, frame) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const text = typeof frame === 'string' ? frame : JSON.stringify(frame);
  ws.send(text);
  stats.framesSent += 1;
  stats.bytesSent += Buffer.byteLength(text);
  return true;
}

function noteClose(code) {
  stats.closeCodes.set(code, (stats.closeCodes.get(code) || 0) + 1);
}

/** A close the harness neither caused nor expects (1006 and friends): a warning, listed in the report next to the violations. */
function noteUnexpectedClose(what) {
  stats.unexpectedCloses += 1;
  if (stats.unexpectedCloseLog.length < 20) stats.unexpectedCloseLog.push(what);
  warn(`unexpected close: ${what}; reconnecting`);
}

/**
 * §3 (mode "speed"): a correct answer's points must match the formula for an elapsed between the
 * moment the harness sent it (server clock) and that moment plus the ack round trip (see onAck).
 * Without an acked answer record (ack lost in a drop) only the P/2 floor (elapsed clamped to T) holds.
 */
function checkPoints(points, a, key, label) {
  if (a && a.expectedLo !== null && a.accepted === true && !a.uncertain) {
    if (points < a.expectedLo || points > a.expectedHi) {
      const range = a.expectedLo === a.expectedHi ? String(a.expectedLo) : `${a.expectedLo}..${a.expectedHi}`;
      violate(`${label}: correct answer scored ${points}, expected ${range} from the speed formula (sent ${Math.round(a.sentServerAt - a.opensAt)} ms after opensAt, ack RTT ${Math.round(a.ackAt - a.sentAt)} ms)`);
    }
  } else if (points < key.points / 2) {
    violate(`${label}: correct answer scored ${points} < ${key.points / 2}`);
  }
}

/** Paths of every key named `key` inside `obj` (used to catch an answer key leaking to a phone). */
function findKeyPaths(obj, key, path, out) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) { obj.forEach((v, i) => findKeyPaths(v, key, `${path}[${i}]`, out)); return out; }
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (k === key) out.push(p);
    findKeyPaths(v, key, p, out);
  }
  return out;
}

// ---------------------------------------------------------------- Player

class Player {
  constructor(i) {
    this.i = i;                       // 1-based, "Student <i>"
    this.spin = i % 7 === 0;          // every 7th player asks for a spun two-word name
    this.isDup = false;               // deliberately answers twice (set in main)
    this.ws = null;
    this.token = null; this.pid = null; this.nick = null;
    this.welcomes = 0;
    this.synced = false;              // the current socket has received its sync
    this.syncedAt = 0;                // Date.now() of that sync
    this.joinedSyncAt = 0;            // Date.now() of the very first sync (0 = not joined yet)
    this.lastDisconnectAt = 0;        // Date.now() of the last close
    this.connectStartedAt = 0;        // performance.now() when the current socket was opened
    this.offset = 0;                  // serverNow - Date.now(): see noteOffset
    this.hasOffset = false;
    this.phase = 'lobby'; this.q = -1; this.deadline = 0;
    this.runningScore = 0; this.runningQ = -1;   // score confirmed through question runningQ
    this.results = new Map();         // q -> recorded result
    this.answers = new Map();         // q -> { choice, sentAt, ... }
    this.finalScore = null; this.finalRank = null; this.gotEnded = false;
    this.backoff = 500;
    this.dead = false;                // closed with a no-retry code: stays offline
    this.deliberateClose = false;     // the harness itself closed the socket (simulated drop)
    this.reconnectDelay = 0;
    this.timers = { answer: 0, drop: 0, reconnect: 0, ping: 0, sync: 0 };
  }

  get tag() { return `player ${this.i}${this.nick ? ` (${this.nick})` : ''}`; }

  // ---- connection lifecycle

  connect() {
    if (game.over || this.dead) return;
    this.clear('reconnect');
    const reconnecting = this.token !== null;
    const query = reconnecting ? `role=player&token=${encodeURIComponent(this.token)}` : 'role=player';
    let ws;
    try {
      ws = new WebSocket(`${WS_BASE}/api/room/${game.pin}/ws?${query}`);
    } catch (err) {
      warn(`${this.tag}: cannot open a socket: ${err.message}`);
      this.scheduleReconnect(this.nextBackoff(), false);
      return;
    }
    this.ws = ws;
    this.synced = false;
    this.deliberateClose = false;
    this.connectStartedAt = performance.now();
    ws.addEventListener('open', () => this.onOpen(ws));
    ws.addEventListener('message', (ev) => this.onMessage(ws, ev.data));
    // Node's WebSocket fires only "error" (no "close") when the connection is refused: treat that as a 1006 close.
    ws.addEventListener('error', () => { if (ws === this.ws && ws.readyState === WebSocket.CONNECTING) this.onClose(ws, 1006, 'connect failed'); });
    ws.addEventListener('close', (ev) => this.onClose(ws, ev.code, ev.reason));
    if (reconnecting) {
      // §5: the server answers a token reconnect with sync. Nothing else proves the reconnect worked.
      this.clear('sync');
      this.timers.sync = setTimeout(() => {
        this.timers.sync = 0;
        if (game.over || ws !== this.ws) return;
        if (ws.readyState === WebSocket.CONNECTING) {
          violate(`${this.tag}: reconnect did not complete within ${RESYNC_WAIT_MS} ms`);
          try { ws.close(); } catch { /* ignore */ }
          this.onClose(ws, 1006, 'connect timed out');   // retry with backoff; a later real close is ignored (ws !== this.ws)
        } else {
          violate(`${this.tag}: reconnected but received no sync within ${RESYNC_WAIT_MS} ms`);
        }
      }, RESYNC_WAIT_MS);
    }
    vlog(`${this.tag}: ${reconnecting ? 'reconnecting' : 'connecting'}`);
  }

  onOpen(ws) {
    if (ws !== this.ws) return;
    // First connection: join. A reconnecting player sends nothing; the server answers with sync (§4.1).
    if (!this.token) send(ws, this.spin ? { t: 'join', spin: true } : { t: 'join', nick: `Student ${this.i}` });
    this.clear('ping');
    this.timers.ping = setInterval(() => { if (send(this.ws, 'ping')) stats.pings += 1; }, 25000); // §4 keepalive
  }

  onClose(ws, code, reason) {
    if (ws !== this.ws) return;
    this.clear('ping');
    this.clear('sync');
    this.clear('answer');   // a phone that lost its connection cannot answer
    this.ws = null;
    this.synced = false;
    this.lastDisconnectAt = Date.now();
    // An answer (or deliberate duplicate) still in flight loses its ack whatever closed the socket:
    // sync.me.answered or, failing that, the CSV decides whether it landed.
    const a = game.over ? null : this.answers.get(this.q);
    if (a && !a.ackAt && !a.uncertain) { a.uncertain = true; game.uncertain[this.q] += 1; }
    if (a && a.dupSentServerAt && !a.dupAcked) { a.dupAcked = true; a.dupLost = true; game.dupsLost += 1; }
    noteClose(code);
    if (game.wipedAt) game.lastCloseAt = performance.now();
    vlog(`${this.tag}: socket closed ${code} "${reason}"${this.deliberateClose ? ' (simulated drop)' : ''}`);
    const deliberate = this.deliberateClose;
    this.deliberateClose = false;
    const serverError = (code >= 4000 && code <= 4010) || code === 1009 || code === 1011;   // 1011: Room.webSocketError
    if (game.over) {
      if (serverError && code !== 4004) violate(`${this.tag}: closed with ${code} "${reason}" after the game ended (only 4004 is expected)`);
      return;
    }
    if (serverError) violate(`${this.tag}: closed by the server with ${code} "${reason}" during ${game.phase}`);
    if (deliberate) { this.scheduleReconnect(this.reconnectDelay, true); return; }
    if (NO_RETRY.has(code)) { this.dead = true; return; }   // §4: show the message, never retry
    noteUnexpectedClose(`${this.tag}: ${code} "${reason}" during ${game.phase} (question ${game.q + 1})`);
    this.scheduleReconnect(this.nextBackoff(), false);
  }

  /** Simulated network drop: close now, reconnect with the token after `reconnectAfterMs` (onClose does the bookkeeping). */
  drop(reconnectAfterMs) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.synced) return false;
    this.deliberateClose = true;
    this.reconnectDelay = reconnectAfterMs;
    stats.deliberateDrops += 1;
    // Once close() is called nothing more is reliably delivered either way: cancel a pending tap
    // and treat an answer already in flight as uncertain now, not only when the close event lands
    // (a close that ends in 1006 can arrive late, after this.q has moved on).
    this.clear('answer');
    const inFlight = game.over ? null : this.answers.get(this.q);
    if (inFlight && !inFlight.ackAt && !inFlight.uncertain) { inFlight.uncertain = true; game.uncertain[this.q] += 1; }
    if (inFlight && inFlight.dupSentServerAt && !inFlight.dupAcked) { inFlight.dupAcked = true; inFlight.dupLost = true; game.dupsLost += 1; }
    this.ws.close(1000, 'simulated drop');
    vlog(`${this.tag}: dropped during ${game.phase} of question ${game.q + 1}, back in ${reconnectAfterMs} ms`);
    return true;
  }

  scheduleReconnect(delayMs, afterDrop) {
    this.clear('reconnect');
    this.timers.reconnect = setTimeout(() => {
      this.timers.reconnect = 0;
      if (game.over) return;
      stats.reconnects += 1;
      if (afterDrop) stats.reconnectsAfterDrop += 1;
      this.connect();
    }, delayMs);
  }

  /** §5: 500 ms → 8 s, doubling, ±30 % jitter. Reset to 500 ms by a successful sync. */
  nextBackoff() {
    const base = this.backoff;
    this.backoff = Math.min(8000, base * 2);
    return Math.round(base * (1 + 0.3 * (jitterRng() * 2 - 1)));
  }

  clear(name) { clearTimeout(this.timers[name]); clearInterval(this.timers[name]); this.timers[name] = 0; }
  clearAll() { for (const k of Object.keys(this.timers)) this.clear(k); }

  // ---- frames

  onMessage(ws, data) {
    if (ws !== this.ws) return;
    stats.framesRecv += 1;
    stats.bytesRecv += Buffer.byteLength(data);
    if (data === 'pong') { stats.pongs += 1; return; }
    let f;
    try { f = JSON.parse(data); } catch { violate(`${this.tag}: non-JSON frame: ${String(data).slice(0, 80)}`); return; }
    if (!f || typeof f.t !== 'string') { violate(`${this.tag}: frame without a string field t`); return; }
    if (typeof f.serverNow === 'number') this.noteOffset(f.serverNow);
    this.checkNoAnswerKey(f);
    switch (f.t) {
      case 'welcome': return this.onWelcome(f);
      case 'sync': return this.onSync(f);
      case 'lobby': return undefined;
      case 'intro':
        this.phase = 'intro';
        if (f.question && Number.isInteger(f.question.q)) this.q = f.question.q;
        else violate(`${this.tag}: intro without question.q`);
        if (f.question && !game.showOnDevices && ('text' in f.question || 'options' in f.question)) violate(`${this.tag}: intro carries question text although showOnDevices is off`);
        this.clear('answer');
        return undefined;
      case 'open':
        if (!Number.isInteger(f.q) || !game.quiz.questions[f.q]) { violate(`${this.tag}: open for question index ${f.q}, outside 0..${game.N - 1}`); return undefined; }
        if (typeof f.deadline !== 'number') violate(`${this.tag}: open for question ${f.q + 1} without a numeric deadline`);
        this.phase = 'open'; this.q = f.q; this.deadline = f.deadline;
        this.scheduleAnswer(f.q);
        return undefined;
      case 'ack': return this.onAck(f);
      case 'result':
        // The harness never sends "close" and earlyClose is off, so a result (it carries the answer key)
        // before the deadline on the shared clock means the question was closed early.
        if (this.phase === 'open' && this.q === f.q && this.deadline && Date.now() + this.offset < this.deadline) {
          violate(`${this.tag}: result (answer key) for question ${f.q + 1} received ${this.deadline - (Date.now() + this.offset)} ms before the deadline`);
        }
        this.phase = 'closed';
        return this.recordResult(f, 'result frame');
      case 'podium':
        this.phase = 'podium';
        if (!f.you || typeof f.you.score !== 'number') { violate(`${this.tag}: podium without you.score`); return undefined; }
        if (!Array.isArray(f.top) || f.top.length > 3) violate(`${this.tag}: podium.top must list at most 3 players`);
        this.finalScore = f.you.score; this.finalRank = f.you.rank;
        return undefined;
      case 'ended':
        this.phase = 'ended'; this.gotEnded = true;
        return undefined;
      case 'kicked': violate(`${this.tag}: kicked although the harness never kicks`); return undefined;
      case 'settings':
        // Sent when the host toggles showOnDevices (the harness never does): settings plus, in
        // intro/open/closed, the same question object as in sync. Not a sync: no me, no phase.
        if (!f.settings || typeof f.settings !== 'object') { violate(`${this.tag}: settings frame without a settings object`); return undefined; }
        if (f.question) {
          if (!f.settings.showOnDevices && ('text' in f.question || 'options' in f.question)) violate(`${this.tag}: settings.question carries text/options although showOnDevices is off`);
          if (f.question.q === this.q && typeof f.question.deadline === 'number') this.deadline = f.question.deadline;
        }
        return undefined;
      case 'error': violate(`${this.tag}: error frame ${f.code}: ${f.message}`); return undefined;
      default: violate(`${this.tag}: unknown frame type "${f.t}"`); return undefined;
    }
  }

  /**
   * Every serverNow sample is serverNow - Date.now() = true offset - one-way downlink latency, so the
   * largest sample seen is the best estimate (reconnects stay on the same Room, so the clock is the same).
   * Everything the harness derives from it (sentServerAt, deadline comparisons) therefore errs towards
   * "earlier than the server saw it", which the checks allow for.
   */
  noteOffset(serverNow) {
    const sample = serverNow - Date.now();
    this.offset = this.hasOffset ? Math.max(this.offset, sample) : sample;
    this.hasOffset = true;
  }

  /** §4.3: players never see "correct" before closed. Only result.correct (frame or sync in closed) may carry it. */
  checkNoAnswerKey(f) {
    const paths = findKeyPaths(f, 'correct', '', []);
    if (paths.length === 0) return;
    const allowed = f.t === 'result' ? ['correct'] : f.t === 'sync' && f.phase === 'closed' ? ['result.correct'] : [];
    const bad = paths.filter((p) => !allowed.includes(p));
    if (bad.length) violate(`${this.tag}: frame "${f.t}" (phase ${f.phase ?? this.phase}) exposes "correct" at ${bad.join(', ')}`);
  }

  onWelcome(f) {
    this.welcomes += 1;
    if (this.welcomes > 1) { violate(`${this.tag}: received a second welcome`); return; }
    if (typeof f.token !== 'string' || typeof f.pid !== 'string' || typeof f.nick !== 'string') violate(`${this.tag}: welcome is missing pid/token/nick`);
    if (f.pin !== game.pin) violate(`${this.tag}: welcome.pin ${f.pin} != ${game.pin}`);
    this.token = f.token; this.pid = f.pid; this.nick = f.nick;
    stats.joinMs.push(performance.now() - this.connectStartedAt);
    if (this.spin && /^Student \d+/.test(f.nick)) violate(`${this.tag}: asked for a spun name but got "${f.nick}"`);
    if (!this.spin && f.nick !== `Student ${this.i}`) warn(`${this.tag}: asked for "Student ${this.i}", got "${f.nick}"`);
    vlog(`${this.tag}: welcome pid=${f.pid}`);
  }

  onSync(s) {
    this.clear('sync');
    if (s.role !== 'player') violate(`${this.tag}: sync.role is "${s.role}"`);
    if (s.pin !== game.pin) violate(`${this.tag}: sync.pin ${s.pin} != ${game.pin}`);
    const me = s.me;   // me.spins (name spins used so far, 0..3) is informational and not checked
    if (!me || typeof me.score !== 'number') { violate(`${this.tag}: sync without me.score`); return; }
    if (s.question && !s.settings?.showOnDevices && ('text' in s.question || 'options' in s.question)) violate(`${this.tag}: sync.question carries text/options although showOnDevices is off`);
    if (me.nick !== this.nick) violate(`${this.tag}: sync.me.nick "${me.nick}" differs from welcome nick`);
    if (me.pid !== this.pid) violate(`${this.tag}: sync.me.pid differs from welcome pid`);
    if (!Number.isInteger(me.rank) || me.rank < 1 || me.rank > s.playerCount) violate(`${this.tag}: sync.me.rank ${me.rank} not in 1..${s.playerCount}`);

    const first = this.joinedSyncAt === 0;
    this.synced = true;
    this.syncedAt = Date.now();
    this.backoff = 500;
    if (first) {
      this.joinedSyncAt = this.syncedAt;
      if (s.phase === 'lobby') lobbyReady();
      else warn(`${this.tag}: joined during ${s.phase} (late joiner)`);
    } else {
      stats.resyncMs.push(performance.now() - this.connectStartedAt);
    }
    this.phase = s.phase; this.q = s.q;
    if (s.question && typeof s.question.deadline === 'number') this.deadline = s.question.deadline;

    // An answer whose ack was lost in a drop: me.answered says whether it landed.
    const a = this.answers.get(s.q);
    const inQuestion = s.phase === 'intro' || s.phase === 'open' || s.phase === 'closed';
    if (a && a.uncertain && inQuestion) {
      a.uncertain = false;
      a.resolvedBy = 'sync';           // fate settled by the server: no ack is owed any more
      a.accepted = me.answered === true;
      game.uncertain[s.q] -= 1;
      if (a.accepted) {
        game.acceptedAcks[s.q] += 1;
        if (me.choice !== a.choice) violate(`${this.tag}: sync.me.choice ${me.choice} != the choice sent (${a.choice})`);
      }
    }
    if (inQuestion && me.answered === true && !this.answers.has(s.q)) violate(`${this.tag}: sync says question ${s.q + 1} was answered but the harness never sent an answer`);

    // Running-total bookkeeping (see recordResult).
    if (s.phase === 'lobby') {
      if (me.score !== 0) violate(`${this.tag}: score ${me.score} while still in the lobby`);
      this.runningScore = 0; this.runningQ = -1;
    } else if (s.phase === 'intro' || s.phase === 'open') {
      // me.score already includes the current question once me.answered is true.
      this.runningScore = me.score; this.runningQ = me.answered === true ? s.q : s.q - 1;
    } else if (s.phase === 'podium' || s.phase === 'ended') {
      this.runningScore = me.score; this.runningQ = game.N - 1;
    }
    if (s.phase === 'closed') {
      if (s.result) this.recordResult(s.result, 'sync');
      else violate(`${this.tag}: sync in closed phase without result`);
    }
    if (s.podium && s.podium.you) {
      this.finalScore = s.podium.you.score; this.finalRank = s.podium.you.rank;
    } else if (s.phase === 'podium' || s.phase === 'ended') {
      violate(`${this.tag}: sync in ${s.phase} without podium.you`);
    }
    vlog(`${this.tag}: sync phase=${s.phase} q=${s.q} score=${me.score}`);
  }

  // ---- answering

  /** Decide (reproducibly) when and what to answer, then wait. */
  scheduleAnswer(q) {
    if (this.answers.has(q)) return;
    const key = game.quiz.questions[q];
    if (!key) { violate(`${this.tag}: cannot answer question index ${q}: not in the quiz`); return; }
    const rng = mulberry32(mix(opts.seed, this.i, q + 1));
    const delay = Math.floor(rng() * (opts.answerWindow + 1));
    const correct = rng() < 0.7;
    const wrong = (key.correct + 1 + Math.floor(rng() * (key.options.length - 1))) % key.options.length;
    const choice = correct ? key.correct : wrong;
    this.clear('answer');
    this.timers.answer = setTimeout(() => { this.timers.answer = 0; this.sendAnswer(q, choice); }, delay);
  }

  sendAnswer(q, choice) {
    if (this.phase === 'closed' && this.q === q && this.deadline && Date.now() + this.offset < this.deadline - 500) {
      violate(`${this.tag}: question ${q + 1} was already closed ${this.deadline - (Date.now() + this.offset)} ms before its deadline, so the phone could not answer`);
    }
    if (this.phase !== 'open' || this.q !== q || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const key = game.quiz.questions[q];
    const a = {
      choice, sentAt: performance.now(), sentServerAt: Date.now() + this.offset,
      opensAt: this.deadline - key.timeLimit * 1000,   // §2: deadline = opensAt + timeLimit * 1000
      ackAt: 0, accepted: null, reason: null, uncertain: false, resolvedBy: null,
      expectedLo: null, expectedHi: null,              // §3 points bounds, fixed by the ack (needs the RTT)
      dupSentServerAt: 0, dupAcked: false, dupLost: false,
    };
    this.answers.set(q, a);
    game.answersSent[q] += 1;   // counted before the send, so a tally can never be ahead of it
    send(this.ws, { t: 'answer', q, choice });
  }

  onAck(f) {
    const a = this.answers.get(f.q);
    if (!a) { violate(`${this.tag}: ack for question ${f.q + 1} without an answer`); return; }
    const key = game.quiz.questions[f.q];
    if (!a.ackAt) {
      a.ackAt = performance.now();
      a.accepted = f.accepted === true;
      a.reason = f.reason ?? null;
      stats.ackMs.push(a.ackAt - a.sentAt);
      if (a.accepted) {
        game.acceptedAcks[f.q] += 1;
        // §3 speed formula: the server's elapsed is at least the elapsed at send (sentServerAt errs early,
        // see noteOffset) and at most that plus the ack round trip; CLOCK_TOL_MS covers offset jitter.
        // The result frame and the CSV cell are checked against these bounds (checkPoints).
        if (key.points > 0 && Number.isFinite(a.opensAt) && a.opensAt > 0) {
          const T = key.timeLimit * 1000;
          const atSend = a.sentServerAt - a.opensAt;
          const rtt = a.ackAt - a.sentAt;
          a.expectedLo = expectedPoints(atSend + rtt + CLOCK_TOL_MS, T, key.points);
          a.expectedHi = expectedPoints(atSend - CLOCK_TOL_MS, T, key.points);
        }
        if (this.isDup) {
          // Deliberately answer again (with another choice): the server must refuse it as a duplicate (§3).
          a.dupSentServerAt = Date.now() + this.offset;
          game.dupsSent += 1;
          send(this.ws, { t: 'answer', q: f.q, choice: (a.choice + 1) % key.options.length });
        }
      } else if (a.reason !== 'late' && a.reason !== 'closed') {
        violate(`${this.tag}: answer for question ${f.q + 1} refused with reason "${a.reason}"`);
      } else if (a.sentServerAt < this.deadline - 500) {
        violate(`${this.tag}: answer for question ${f.q + 1} refused as "${a.reason}" although sent ${this.deadline - a.sentServerAt} ms before the deadline`);
      }
      return;
    }
    if (a.dupSentServerAt && !a.dupAcked) {
      a.dupAcked = true;
      if (f.accepted === false && f.reason === 'duplicate') { game.dupsRejected += 1; return; }
      if (f.accepted === false && (f.reason === 'late' || f.reason === 'closed') && a.dupSentServerAt >= this.deadline) {
        game.dupsLate += 1;
        warn(`${this.tag}: duplicate for question ${f.q + 1} was refused as "${f.reason}" because the question had closed`);
        return;
      }
      violate(`${this.tag}: duplicate answer for question ${f.q + 1} got accepted=${f.accepted} reason=${f.reason} (expected accepted=false, reason "duplicate")`);
      return;
    }
    violate(`${this.tag}: unexpected extra ack for question ${f.q + 1}`);
  }

  /** Validate a result (from a result frame or sync.result) against the key and what this player sent. */
  recordResult(r, source) {
    const q = r.q;
    if (!Number.isInteger(q) || q < 0 || q >= game.N) { violate(`${this.tag}: result with bad q ${q}`); return; }
    if (q !== this.q) violate(`${this.tag}: result.q is ${q} but the player is on question ${this.q} (${source})`);
    const prev = this.results.get(q);
    if (prev) {
      if (source === 'result frame' && prev.source === 'result frame') violate(`${this.tag}: two result frames for question ${q + 1}`);
      else if (prev.points !== r.points || prev.score !== r.score || prev.choice !== r.choice) violate(`${this.tag}: ${source} for question ${q + 1} disagrees with the earlier result`);
      return;
    }
    this.results.set(q, { q, correct: r.correct, choice: r.choice, points: r.points, score: r.score, rank: r.rank, source });
    const key = game.quiz.questions[q];
    const label = `${this.tag}, question ${q + 1}`;
    if (r.correct !== key.correct) violate(`${label}: result.correct ${r.correct} != key ${key.correct}`);
    if (!Number.isInteger(r.points) || r.points < 0 || r.points > key.points) violate(`${label}: points ${r.points} outside 0..${key.points}`);
    if (!Number.isInteger(r.rank) || r.rank < 1 || r.rank > r.playerCount) violate(`${label}: rank ${r.rank} not in 1..${r.playerCount}`);
    const a = this.answers.get(q);
    if (r.choice === null) {
      if (r.points !== 0) violate(`${label}: unanswered but ${r.points} points`);
      if (a && a.accepted === true) violate(`${label}: the answer was accepted (ack) but the result says unanswered`);
    } else {
      if (!a) violate(`${label}: result says choice ${r.choice} but the harness never answered`);
      else if (a.choice !== r.choice) violate(`${label}: result.choice ${r.choice} != sent ${a.choice}`);
      else if (a.accepted === false && !a.uncertain) violate(`${label}: a refused answer (${a.reason}) appears in the result`);
      if (r.choice !== key.correct && r.points !== 0) violate(`${label}: wrong answer scored ${r.points}`);
      if (r.choice === key.correct && key.points > 0) checkPoints(r.points, a, key, label);
    }
    if (this.runningQ === q - 1 && r.score !== this.runningScore + r.points) violate(`${label}: result.score ${r.score} != running total ${this.runningScore} + ${r.points}`);
    else if (this.runningQ === q && r.score !== this.runningScore) violate(`${label}: result.score ${r.score} != score ${this.runningScore} reported by sync after answering`);
    if (this.runningQ < q) { this.runningScore = r.score; this.runningQ = q; }
  }
}

// ------------------------------------------------------------------ Host

class Host {
  constructor() {
    this.ws = null;
    this.offset = 0;
    this.phase = 'lobby'; this.q = -1;
    this.opensAt = 0; this.deadline = 0;
    this.readyResolve = null; this.readyReject = null;
    this.startSent = false; this.nextSentFor = -1; this.endSent = false; this.ackSent = false;
    this.resumedInEnded = false;      // reconnected while the room was already "ended": results_csv comes again (§5)
    this.backoff = 500;
    this.timers = { ping: 0, watchdog: 0, next: 0, endPoll: 0, reconnect: 0, expect: 0 };
  }

  /**
   * Resolves on the first sync. Rejects if the socket closes before it (error.closeCode) or if nothing
   * arrives within HOST_SYNC_WAIT_MS (error.timedOut, error.opened = the upgrade had completed).
   */
  connect() {
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve; this.readyReject = reject;
      this.clear('expect');
      this.timers.expect = setTimeout(() => {
        this.timers.expect = 0;
        const r = this.readyReject;
        if (!r) return;
        this.readyResolve = this.readyReject = null;
        const ws = this.ws;
        const opened = !!ws && ws.readyState === WebSocket.OPEN;
        this.clear('ping');
        this.ws = null;
        if (ws) { try { ws.close(1000, 'harness: no sync'); } catch { /* ignore */ } }
        const what = opened ? `host socket open but no sync within ${HOST_SYNC_WAIT_MS} ms` : `host socket did not connect within ${HOST_SYNC_WAIT_MS} ms`;
        r(Object.assign(new Error(what), { timedOut: true, opened }));
      }, HOST_SYNC_WAIT_MS);
      this.open();
    });
  }

  open() {
    const ws = new WebSocket(`${WS_BASE}/api/room/${game.pin}/ws?role=host&token=${encodeURIComponent(game.hostToken)}`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.clear('ping');
      this.timers.ping = setInterval(() => { if (send(this.ws, 'ping')) stats.pings += 1; }, 25000);
    });
    ws.addEventListener('message', (ev) => this.onMessage(ws, ev.data));
    // Node's WebSocket fires only "error" (no "close") when the connection is refused: treat that as a 1006 close.
    ws.addEventListener('error', () => { if (ws === this.ws && ws.readyState === WebSocket.CONNECTING) this.onClose(ws, 1006, 'connect failed'); });
    ws.addEventListener('close', (ev) => this.onClose(ws, ev.code, ev.reason));
  }

  onClose(ws, code, reason) {
    if (ws !== this.ws) return;
    this.clear('ping');
    this.ws = null;
    noteClose(code);
    if (game.wipedAt) game.lastCloseAt = performance.now();
    vlog(`host: socket closed ${code} "${reason}"`);
    if (game.wipedAt || game.aborted) {
      if (game.wipedAt && code !== 4004) violate(`host: closed with ${code} "${reason}" after wipe, expected 4004`);
      return;
    }
    if (this.readyReject) {
      const r = this.readyReject;
      this.readyResolve = this.readyReject = null;
      this.clear('expect');
      r(Object.assign(new Error(`host socket closed before sync: ${code} "${reason}"`), { closeCode: code }));
      return;
    }
    if ((code >= 4000 && code <= 4010) || code === 1009 || code === 1011) violate(`host: closed by the server with ${code} "${reason}" during ${game.phase}`);
    if (NO_RETRY.has(code)) { abort(`host socket closed with ${code} "${reason}"`); return; }
    noteUnexpectedClose(`host: ${code} "${reason}" during ${game.phase} (question ${game.q + 1})`);
    const base = this.backoff;
    this.backoff = Math.min(8000, base * 2);
    this.timers.reconnect = setTimeout(() => {
      this.timers.reconnect = 0;
      stats.reconnects += 1;
      this.open();
    }, Math.round(base * (1 + 0.3 * (jitterRng() * 2 - 1))));
  }

  onMessage(ws, data) {
    if (ws !== this.ws) return;
    stats.framesRecv += 1;
    stats.bytesRecv += Buffer.byteLength(data);
    if (data === 'pong') { stats.pongs += 1; return; }
    let f;
    try { f = JSON.parse(data); } catch { violate(`host: non-JSON frame: ${String(data).slice(0, 80)}`); return; }
    if (!f || typeof f.t !== 'string') { violate('host: frame without a string field t'); return; }
    if (typeof f.serverNow === 'number') this.offset = f.serverNow - Date.now();
    this.armWatchdog();
    vlog(`host <- ${f.t}${f.q !== undefined ? ` q=${f.q}` : ''}${f.t === 'sync' ? ` phase=${f.phase}` : ''}`);
    switch (f.t) {
      case 'sync': return this.onSync(f);
      case 'roster':
        if (!Array.isArray(f.players) || f.players.length !== f.playerCount) violate(`host: roster.players has ${f.players?.length} entries but playerCount is ${f.playerCount}`);
        if (f.playerCount > opts.players) violate(`host: roster playerCount ${f.playerCount} > ${opts.players} players spawned`);
        return undefined;
      case 'intro': return this.onIntro(f);
      case 'open': return this.onOpen(f);
      case 'tally': return this.onTally(f);
      case 'reveal': return this.onReveal(f);
      case 'podium': return this.onPodium(f);
      case 'results_csv': return this.onCsv(f);
      case 'wiped': return this.onWiped();
      case 'settings': return undefined;
      case 'error': violate(`host: error frame ${f.code}: ${f.message}`); return undefined;
      default: violate(`host: unknown frame type "${f.t}"`); return undefined;
    }
  }

  onSync(s) {
    if (s.role !== 'host') violate(`host: sync.role is "${s.role}"`);
    if (s.hostToken !== game.hostToken) violate('host: sync.hostToken differs from the token returned by POST /api/room');
    if (!Array.isArray(s.roster)) violate('host: sync without roster');
    if (s.total !== game.N) violate(`host: sync.total ${s.total} != ${game.N} questions`);
    this.phase = s.phase; this.q = s.q; game.phase = s.phase; game.q = s.q;
    if (s.question && typeof s.question.deadline === 'number') { this.opensAt = s.question.opensAt; this.deadline = s.question.deadline; }
    game.showOnDevices = !!(s.settings && s.settings.showOnDevices);
    this.backoff = 500;
    if (this.readyResolve) {
      const r = this.readyResolve;
      this.readyResolve = this.readyReject = null;
      this.clear('expect');
      r();
      return;
    }
    // Resumed mid-game after an unexpected close: pick up where the server is.
    warn(`host: resumed in phase ${s.phase}, q=${s.q}`);
    if (s.phase === 'lobby' && this.startSent) send(this.ws, { t: 'start' });
    else if (s.phase === 'closed' && this.nextSentFor < s.q) this.scheduleNext(s.q);
    else if (s.phase === 'podium') this.maybeEnd();
    else if (s.phase === 'ended') {
      // §5: a host that connects during "ended" receives sync and then results_csv again; ack only after that.
      // An ack_results sent just before the close was evidently lost, or the room would be wiped (4004) by now.
      this.resumedInEnded = true;
      this.ackSent = false;
      this.expectWithin('results_csv', 5000);
    }
  }

  start(reason) {
    if (this.startSent) return;
    this.startSent = true;
    clearTimeout(lobbyTimer);
    game.readyAtStart = readyCount;
    game.startedAt = performance.now();
    log(`start: ${reason}`);
    if (!send(this.ws, { t: 'start' })) warn('host: socket not open at start; will start on resync');
  }

  onIntro(f) {
    const qv = f.question;
    if (!qv || !Number.isInteger(qv.q)) { violate('host: intro without question.q'); return; }
    const q = qv.q;
    if (q !== this.q + 1) violate(`host: intro for question ${q + 1} but the previous question was ${this.q + 1}`);
    const key = game.quiz.questions[q];
    if (!key) { violate(`host: intro for question index ${q}, outside 0..${game.N - 1}; ignored`); return; }
    this.phase = 'intro'; this.q = q; game.phase = 'intro'; game.q = q;
    game.introAt[q] = performance.now();
    game.introWall[q] = Date.now();
    if (qv.text !== key.text) violate(`host: intro text for question ${q + 1} differs from the quiz`);
    if (!Array.isArray(qv.options) || qv.options.join('\u0000') !== key.options.join('\u0000')) violate(`host: intro options for question ${q + 1} differ from the quiz`);
    if (qv.total !== game.N || qv.optionCount !== key.options.length || qv.timeLimit !== key.timeLimit || qv.points !== key.points) violate(`host: intro metadata for question ${q + 1} differs from the quiz`);
    if (qv.deadline - qv.opensAt !== key.timeLimit * 1000) violate(`host: deadline - opensAt = ${qv.deadline - qv.opensAt} ms, expected ${key.timeLimit * 1000}`);
    if (Math.abs(qv.opensAt - f.serverNow - INTRO_MS) > 100) violate(`host: opensAt is ${qv.opensAt - f.serverNow} ms after serverNow, expected ${INTRO_MS}`);
    this.opensAt = qv.opensAt; this.deadline = qv.deadline;
    scheduleDrops(q);
  }

  onOpen(f) {
    if (f.q !== this.q) violate(`host: open.q ${f.q} != current question ${this.q}`);
    if (f.deadline !== this.deadline) violate(`host: open.deadline ${f.deadline} != intro deadline ${this.deadline}`);
    if (Math.abs(f.serverNow - this.opensAt) > 250) warn(`host: open frame stamped ${f.serverNow - this.opensAt} ms after opensAt`);
    this.phase = 'open'; game.phase = 'open';
    game.openAt[this.q] = performance.now();
  }

  onTally(f) {
    if (f.q !== this.q) { violate(`host: tally.q ${f.q} != current question ${this.q}`); return; }
    const key = game.quiz.questions[f.q];
    if (!key) { violate(`host: tally for question index ${f.q}, not in the quiz`); return; }
    const sum = sumCounts(f.counts);
    if (!Array.isArray(f.counts) || f.counts.length !== key.options.length) violate(`host: tally.counts has ${f.counts?.length} entries, expected ${key.options.length}`);
    if (sum !== f.answered) violate(`host: tally counts sum ${sum} != answered ${f.answered}`);
    if (sum > game.answersSent[f.q]) violate(`host: tally for question ${f.q + 1} counts ${sum} answers but only ${game.answersSent[f.q]} were sent so far`);
    if (f.expected > opts.players) violate(`host: tally.expected ${f.expected} > ${opts.players} players`);
    game.tallies += 1;
  }

  onReveal(f) {
    const q = f.q;
    if (q !== this.q) { violate(`host: reveal.q ${q} != current question ${this.q}`); return; }
    if (game.reveals[q]) { violate(`host: second reveal for question ${q + 1}`); return; }
    const key = game.quiz.questions[q];
    if (!key) { violate(`host: reveal for question index ${q}, not in the quiz`); return; }
    // The harness never sends "close" and earlyClose is off: the only legitimate close is the server timer
    // at deadline + grace, so a reveal before the deadline on the shared clock means an early close.
    const at = Date.now() + this.offset;
    if (this.deadline && at < this.deadline) violate(`host: reveal for question ${q + 1} arrived ${this.deadline - at} ms before the deadline (question closed early)`);
    else if (this.deadline && at > this.deadline + GRACE_MS + 2000) warn(`host: reveal for question ${q + 1} arrived ${at - this.deadline - GRACE_MS} ms after deadline + grace`);
    this.phase = 'closed'; game.phase = 'closed';
    game.revealAt[q] = performance.now();
    game.reveals[q] = f;
    const sum = sumCounts(f.counts);
    if (f.correct !== key.correct) violate(`host: reveal.correct ${f.correct} != key ${key.correct} for question ${q + 1}`);
    if (!Array.isArray(f.counts) || f.counts.length !== key.options.length) violate(`host: reveal.counts has ${f.counts?.length} entries, expected ${key.options.length}`);
    if (sum !== f.answered) violate(`host: reveal counts sum ${sum} != answered ${f.answered}`);
    if (sum > game.answersSent[q]) violate(`host: reveal for question ${q + 1} counts ${sum} answers but only ${game.answersSent[q]} were sent`);
    if (!Array.isArray(f.leaderboard) || f.leaderboard.length > 10) violate('host: reveal.leaderboard must have at most 10 entries');
    else for (let i = 1; i < f.leaderboard.length; i++) {
      if (f.leaderboard[i].score > f.leaderboard[i - 1].score) { violate(`host: reveal.leaderboard for question ${q + 1} is not sorted by score`); break; }
    }
    if (f.fastest !== null && (typeof f.fastest?.nick !== 'string' || typeof f.fastest?.ms !== 'number')) violate('host: reveal.fastest is neither null nor {nick, ms}');
    if (f.fastest === null && Array.isArray(f.counts) && f.counts[key.correct] > 0) violate(`host: reveal.fastest is null although ${f.counts[key.correct]} players answered question ${q + 1} correctly`);

    // Everyone who was connected from this question's intro until now must receive a result frame.
    const introWall = game.introWall[q];
    const expected = new Set();
    for (const p of players) {
      if (p.ws && p.ws.readyState === WebSocket.OPEN && p.synced && p.syncedAt <= introWall && p.lastDisconnectAt < introWall) expected.add(p);
    }
    game.expectedResult[q] = expected;
    log(`q ${q + 1}/${game.N}: ${Math.round(game.revealAt[q] - game.introAt[q])} ms intro->reveal, accepted ${f.answered}, correct ${f.counts?.[key.correct] ?? '?'}, dropped ${game.dropped[q].size}, connected throughout ${expected.size}`);
    this.scheduleNext(q);
  }

  /** PROTOCOL flow for the harness: 300 ms after reveal, press Next. */
  scheduleNext(q) {
    this.clear('next');
    this.timers.next = setTimeout(() => {
      this.timers.next = 0;
      if (this.nextSentFor >= q) return;
      this.nextSentFor = q;
      send(this.ws, { t: 'next' });
    }, 300);
  }

  onPodium(f) {
    if (this.phase !== 'closed' || this.q !== game.N - 1) violate(`host: podium arrived during ${this.phase} of question ${this.q + 1}`);
    this.phase = 'podium'; game.phase = 'podium';
    game.podiumAt = performance.now();
    if (!Array.isArray(f.top) || f.top.length > 3) violate('host: podium.top must have at most 3 entries');
    if (!Array.isArray(f.leaderboard) || f.leaderboard.length > 10) violate('host: podium.leaderboard must have at most 10 entries');
    if (Array.isArray(f.top) && Array.isArray(f.leaderboard)) {
      for (let i = 0; i < f.top.length && i < f.leaderboard.length; i++) {
        if (f.top[i].pid !== f.leaderboard[i].pid) { violate('host: podium.top does not match the head of podium.leaderboard'); break; }
      }
    }
    this.maybeEnd();
  }

  /** Give phones that are mid-reconnect up to 5 s to learn their final rank, then End game. */
  maybeEnd() {
    const startedAt = performance.now();
    this.clear('endPoll');
    const poll = () => {
      this.timers.endPoll = 0;
      const missing = players.filter((p) => p.pid && !p.dead && p.finalScore === null);
      if (missing.length === 0 || performance.now() - startedAt > 5000) {
        if (missing.length) warn(`host: ending with ${missing.length} players still without a podium score`);
        this.sendEnd();
      } else {
        this.timers.endPoll = setTimeout(poll, 100);
      }
    };
    poll();
  }

  sendEnd() {
    if (this.endSent) return;
    this.endSent = true;
    game.over = true;   // phones stop reconnecting; 4004 closes are expected from here on
    game.endAt = performance.now();
    // Every phone with a live, synced socket right now must receive the "ended" broadcast (§4.3).
    game.expectEnded = players.filter((p) => p.ws && p.ws.readyState === WebSocket.OPEN && p.synced && !p.dead);
    // Reconnects after simulated drops must each have produced a sync, except those still in flight.
    game.resyncAudit = {
      resyncs: stats.resyncMs.length, afterDrop: stats.reconnectsAfterDrop,
      pending: players.filter((p) => p.token && !p.synced && !p.dead).length,
    };
    send(this.ws, { t: 'end' });
    this.expectWithin('results_csv', 5000);
  }

  onCsv(f) {
    this.clear('expect');
    const resent = this.resumedInEnded && this.phase === 'ended';   // §5: sent again to a host that connects during "ended"
    this.resumedInEnded = false;
    if (this.phase !== 'podium' && !resent) violate(`host: results_csv arrived during ${this.phase}`);
    this.phase = 'ended'; game.phase = 'ended';
    if (typeof f.csv !== 'string' || typeof f.filename !== 'string') violate('host: results_csv must carry csv and filename strings');
    const csv = typeof f.csv === 'string' ? f.csv : '';
    const csvName = typeof f.filename === 'string' ? f.filename : '';
    if (game.csv !== null && (csv !== game.csv || csvName !== game.csvName)) violate('host: the results_csv re-sent after a reconnect differs from the first one');
    game.csv = csv; game.csvName = csvName;
    if (!new RegExp(`^hompub-quiz-${game.pin}-\\d{8}\\.csv$`).test(game.csvName)) violate(`host: CSV filename "${game.csvName}" does not match hompub-quiz-<pin>-<YYYYMMDD>.csv`);
    this.sendAckResults();
  }

  sendAckResults() {
    if (this.ackSent) return;
    this.ackSent = true;
    send(this.ws, { t: 'ack_results' });
    this.expectWithin('wiped', 5000);
  }

  onWiped() {
    this.clear('expect');
    this.clear('watchdog');
    game.wipedAt = performance.now();
    game.phase = 'wiped';
    // Every socket, host and phones, must now be closed by the server with 4004. Sockets accepted
    // in the last second before the wipe have been seen to get their TCP teardown ~10 s late
    // (the 4004 close frame itself arrives at once), so allow 15 s before calling it a violation.
    waitForSocketsClosed(WIPE_CLOSE_WAIT_MS).then(() => game.done());
  }

  expectWithin(what, ms) {
    this.clear('expect');
    this.timers.expect = setTimeout(() => abort(`host: no ${what} frame within ${ms} ms`), ms);
  }

  armWatchdog() {
    this.clear('watchdog');
    this.timers.watchdog = setTimeout(() => abort(`host received nothing for ${STALL_MS} ms while in phase ${game.phase} (question ${game.q + 1})`), STALL_MS);
  }

  clear(name) { clearTimeout(this.timers[name]); clearInterval(this.timers[name]); this.timers[name] = 0; }
  clearAll() { for (const k of Object.keys(this.timers)) this.clear(k); }
}

// ------------------------------------------------------------- orchestration

/** Pick round(P * drop) players for this question; each drops at a random moment and returns 1-3 s later. */
function scheduleDrops(q) {
  const n = Math.round(players.length * opts.drop);
  if (n === 0) return;
  const rng = mulberry32(mix(opts.seed, 0xd0d, q + 1));
  const chosen = shuffle([...players], rng).slice(0, n);
  const span = INTRO_MS + game.quiz.questions[q].timeLimit * 1000;
  for (const p of chosen) {
    const at = Math.floor(rng() * span);
    const back = 1000 + Math.floor(rng() * 2001);
    p.clear('drop');
    p.timers.drop = setTimeout(() => {
      p.timers.drop = 0;
      if (p.drop(back)) game.dropped[q].add(p);
    }, at);
  }
}

function lobbyReady() {
  readyCount += 1;
  if (readyCount === players.length) host.start(`all ${readyCount} players are in the lobby`);
}

function waitForSocketsClosed(maxMs) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const tick = () => {
      const open = players.filter((p) => p.ws !== null).length + (host && host.ws ? 1 : 0);
      if (open === 0 || performance.now() - startedAt > maxMs) resolve(open);
      else setTimeout(tick, 50);
    };
    tick();
  });
}

function abort(reason) {
  if (game.aborted) return;
  game.aborted = reason;
  game.over = true;
  violate(`run aborted: ${reason}`);
  for (const p of players) {
    p.clearAll();
    if (p.ws && p.ws.readyState <= WebSocket.OPEN) { p.deliberateClose = true; try { p.ws.close(1000, 'harness abort'); } catch { /* ignore */ } }
  }
  if (host) {
    host.clearAll();
    if (host.ws && host.ws.readyState <= WebSocket.OPEN) { try { host.ws.close(1000, 'harness abort'); } catch { /* ignore */ } }
  }
  waitForSocketsClosed(2000).then(() => game.done && game.done());
}

// --------------------------------------------------------------- checks

/** Checks that need the whole game: results coverage, totals, CSV, reveal vs. recorded answers. */
function finalChecks() {
  const joined = players.filter((p) => p.pid);
  for (const p of players) if (p.welcomes !== 1) violate(`${p.tag}: received ${p.welcomes} welcome frames (expected exactly 1)`);
  for (let q = 0; q < game.N; q++) {
    const expected = game.expectedResult[q];
    if (!expected) { violate(`question ${q + 1}: never reached reveal`); continue; }
    for (const p of expected) if (!p.results.has(q)) violate(`${p.tag}: connected throughout question ${q + 1} but received no result`);
  }
  for (const p of joined) {
    if (p.finalScore === null) { violate(`${p.tag}: never received a final score (podium)`); continue; }
    if (p.results.size === game.N) {
      let sum = 0;
      for (const r of p.results.values()) sum += r.points;
      if (sum !== p.finalScore) violate(`${p.tag}: final score ${p.finalScore} != sum of result.points ${sum}`);
    }
  }
  // §4.3: everyone connected when the host pressed End must have been told the game is over.
  for (const p of game.expectEnded) if (!p.gotEnded) violate(`${p.tag}: connected when the host sent "end" but never received the "ended" frame`);
  // §5: reconnects are answered with sync (per-socket timer in Player.connect; coarse count here).
  const ra = game.resyncAudit;
  if (ra && ra.afterDrop > 0 && ra.resyncs === 0) violate(`${ra.afterDrop} reconnects after simulated drops but no resync (sync after a ?token= reconnect) was ever observed`);
  else if (ra && ra.resyncs < ra.afterDrop - ra.pending) violate(`${ra.afterDrop} reconnects after simulated drops but only ${ra.resyncs} resyncs (${ra.pending} still pending when the game ended)`);
  // Every answer sent on a socket that stayed open was acknowledged, and every deliberate duplicate was answered (§3).
  for (const p of joined) {
    for (const [q, a] of p.answers) {
      if (!a.ackAt && !a.uncertain && !a.resolvedBy) violate(`${p.tag}: answer for question ${q + 1} was sent on an open socket but never acknowledged`);
      if (a.dupSentServerAt && !a.dupAcked) violate(`${p.tag}: duplicate answer for question ${q + 1} was never acknowledged (expected accepted=false, reason "duplicate")`);
    }
  }
  if (game.dupsSent === 0) warn('no duplicate answer was ever sent, so the "duplicate" ack path was not exercised');
  checkCsv(joined);
  checkFastest();
}

/** reveal.fastest.ms is the server's elapsed for the fastest correct answer; the harness knows bounds for each one it sent. */
function checkFastest() {
  for (let q = 0; q < game.N; q++) {
    const rv = game.reveals[q];
    const key = game.quiz.questions[q];
    if (!rv || !rv.fastest || typeof rv.fastest.ms !== 'number') continue;
    const T = key.timeLimit * 1000;
    let lo = Infinity; let hi = Infinity;   // fastest >= the earliest send; fastest <= the earliest (send + RTT) among acked answers
    for (const p of players) {
      const a = p.answers.get(q);
      if (!a || a.choice !== key.correct || a.accepted !== true) continue;
      lo = Math.min(lo, Math.min(T, Math.max(0, a.sentServerAt - a.opensAt - CLOCK_TOL_MS)));
      if (a.ackAt) hi = Math.min(hi, Math.min(T, a.sentServerAt - a.opensAt + (a.ackAt - a.sentAt) + CLOCK_TOL_MS));
    }
    if (lo === Infinity) continue;
    if (rv.fastest.ms < lo || rv.fastest.ms > hi) violate(`question ${q + 1}: reveal.fastest.ms ${rv.fastest.ms} is outside ${Math.round(lo)}..${Math.round(hi)} ms, the bounds of the fastest correct answer the harness sent`);
  }
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false; } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function checkCsv(joined) {
  if (game.csv === null) { violate('no results_csv frame was received'); return; }
  if (!game.csv.endsWith('\r\n')) warn('CSV does not end with CRLF');
  const lines = game.csv.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const expectHeader = ['rank', 'nickname', 'score', 'correct', 'answered', ...Array.from({ length: game.N }, (_, i) => `q${i + 1}`)];
  if (parseCsvLine(lines[0] ?? '').join(',') !== expectHeader.join(',')) violate(`CSV header is "${lines[0]}"`);
  const rows = lines.slice(1).map(parseCsvLine).sort((a, b) => Number(a[0]) - Number(b[0]));
  if (rows.length !== joined.length) violate(`CSV has ${rows.length} data rows, expected ${joined.length} (one per joined player)`);

  const byNick = new Map(joined.map((p) => [p.nick, p]));
  const ranks = new Set();
  const seen = new Set();
  const csvAnswered = new Array(game.N).fill(0);
  let prevScore = Infinity;
  for (const row of rows) {
    if (row.length !== expectHeader.length) { violate(`CSV row has ${row.length} cells: "${row.join(',').slice(0, 80)}"`); continue; }
    const [rankS, nick, scoreS, correctS, answeredS, ...cells] = row;
    const rank = Number(rankS); const score = Number(scoreS);
    ranks.add(rank);
    if (score > prevScore) violate(`CSV rank ${rank} (${nick}) has a higher score than the rank above it`);
    prevScore = score;
    const p = byNick.get(nick);
    if (!p) { violate(`CSV row for unknown nickname "${nick}"`); continue; }
    if (seen.has(p)) violate(`CSV lists "${nick}" twice`);
    seen.add(p);
    if (p.finalScore !== null && score !== p.finalScore) violate(`${p.tag}: CSV score ${score} != final score ${p.finalScore}`);
    if (p.finalRank !== null && rank !== p.finalRank) violate(`${p.tag}: CSV rank ${rank} != podium rank ${p.finalRank}`);
    let sum = 0; let nAnswered = 0; let nCorrect = 0;
    cells.forEach((cell, q) => {
      const key = game.quiz.questions[q];
      const r = p.results.get(q);
      const a = p.answers.get(q);
      // An answer whose ack was lost in a drop and that no sync resolved: the CSV is the server's final word.
      if (a && a.uncertain) {
        a.uncertain = false;
        a.resolvedBy = 'csv';
        a.accepted = cell !== '';
        game.uncertain[q] -= 1;
        if (a.accepted) game.acceptedAcks[q] += 1;
      }
      if (cell === '') {
        if (r && r.choice !== null) violate(`${p.tag}: CSV q${q + 1} is empty but the result had choice ${r.choice}`);
        if (a && a.accepted === true) violate(`${p.tag}: answer for q${q + 1} was accepted but the CSV cell is empty`);
        return;
      }
      const m = /^([A-D]) (\d+)$/.exec(cell);
      if (!m) { violate(`${p.tag}: CSV q${q + 1} cell "${cell}" is not "<letter> <points>"`); return; }
      const choice = m[1].charCodeAt(0) - 65; const pts = Number(m[2]);
      nAnswered += 1; csvAnswered[q] += 1; sum += pts;
      if (choice === key.correct) nCorrect += 1;
      if (pts > key.points) violate(`${p.tag}: CSV q${q + 1} has ${pts} points > ${key.points}`);
      if (choice !== key.correct && pts !== 0) violate(`${p.tag}: CSV q${q + 1} wrong answer scored ${pts}`);
      if (choice === key.correct && key.points > 0) checkPoints(pts, a && a.choice === choice ? a : null, key, `${p.tag}: CSV q${q + 1}`);
      if (r && (r.choice !== choice || r.points !== pts)) violate(`${p.tag}: CSV q${q + 1} "${cell}" disagrees with the result (choice ${r.choice}, ${r.points} pts)`);
      if (!a) violate(`${p.tag}: CSV q${q + 1} shows an answer the harness never sent`);
      else if (a.choice !== choice) violate(`${p.tag}: CSV q${q + 1} choice ${m[1]} != sent ${letter(a.choice)}`);
      else if (a.accepted === false && !a.uncertain) violate(`${p.tag}: CSV q${q + 1} shows an answer the server refused (${a.reason})`);
    });
    if (sum !== score) violate(`${p.tag}: CSV score ${score} != sum of per-question points ${sum}`);
    if (nAnswered !== Number(answeredS)) violate(`${p.tag}: CSV answered ${answeredS} != ${nAnswered} non-empty cells`);
    if (nCorrect !== Number(correctS)) violate(`${p.tag}: CSV correct ${correctS} != ${nCorrect} correct cells`);
  }
  const P = rows.length;
  let permutation = ranks.size === P;
  for (let r = 1; r <= P; r++) if (!ranks.has(r)) permutation = false;
  if (!permutation) violate(`CSV ranks are not a permutation of 1..${P}`);
  for (const p of joined) if (!seen.has(p)) violate(`${p.tag}: missing from the CSV`);

  // The final reveal must count exactly the answers the server recorded (CSV), and those must
  // cover every accepted ack the harness saw (plus, at most, the acks lost in drops).
  for (let q = 0; q < game.N; q++) {
    const rv = game.reveals[q];
    if (!rv) continue;
    const sum = sumCounts(rv.counts);
    if (sum !== csvAnswered[q]) violate(`question ${q + 1}: reveal counted ${sum} answers but the CSV records ${csvAnswered[q]}`);
    const known = game.acceptedAcks[q]; const unresolved = game.uncertain[q];
    if (sum < known || sum > known + unresolved) violate(`question ${q + 1}: reveal counted ${sum} answers; the harness saw ${known} accepted acks (+${unresolved} unresolved)`);
  }
}

// --------------------------------------------------------------- report

function printReport() {
  const out = [];
  const joined = players.filter((p) => p.pid).length;
  const limits = [...new Set(game.quiz.questions.map((q) => q.timeLimit))].join('/');
  out.push(`HomPub Quiz load harness: ${game.aborted ? `ABORTED (${game.aborted})` : 'run complete'}`);
  out.push(`server ${opts.url}   pin ${game.pin ?? '-'}   seed ${opts.seed}${opts.quizFile ? `   quiz ${opts.quizFile}` : ''}`);
  out.push(`players ${opts.players}   questions ${game.N}   time limit ${limits} s   answer window ${opts.answerWindow} ms   drop ${opts.drop}   join burst ${opts.joinBurst} ms`);
  out.push('');
  out.push(`join time (connect -> welcome)   ${fmtStat(summarize(stats.joinMs))}`);
  out.push(`ack latency (send -> ack)        ${fmtStat(summarize(stats.ackMs))}`);
  out.push(`resync (reconnect -> sync)       ${fmtStat(summarize(stats.resyncMs))}`);
  out.push(`frames sent ${stats.framesSent}   frames received ${stats.framesRecv}   bytes received ${fmtBytes(stats.bytesRecv)}   bytes sent ${fmtBytes(stats.bytesSent)}`);
  out.push(`pings ${stats.pings}   pongs ${stats.pongs}   host tally frames ${game.tallies}`);
  out.push(`reconnects performed ${stats.reconnects} (after simulated drops ${stats.reconnectsAfterDrop}, after unexpected closes ${stats.reconnects - stats.reconnectsAfterDrop})   drops ${stats.deliberateDrops}   unexpected closes ${stats.unexpectedCloses}`);
  const dupNote = game.dupsLate || game.dupsLost ? ` (refused as late ${game.dupsLate}, ack lost in a drop ${game.dupsLost})` : '';
  out.push(`players joined ${joined}/${opts.players}   in lobby at start ${game.readyAtStart}   duplicate answers sent ${game.dupsSent}, refused as duplicate ${game.dupsRejected}${dupNote}   ended frames ${players.filter((p) => p.gotEnded).length}/${game.expectEnded.length} expected`);
  const t = (a, b) => (a && b ? `${Math.round(b - a)} ms` : '-');
  out.push(`lobby ${t(game.t0, game.startedAt)}   game (start -> podium) ${t(game.startedAt, game.podiumAt)}   podium -> wiped ${t(game.podiumAt, game.wipedAt)}   wiped -> last socket closed ${t(game.wipedAt, game.lastCloseAt)}   total ${t(game.t0, performance.now())}`);
  out.push(`close codes: ${[...stats.closeCodes.entries()].sort((a, b) => a[0] - b[0]).map(([c, n]) => `${c} x${n}`).join('   ') || '-'}`);
  out.push('');
  out.push('  q   intro->reveal   open->reveal   accepted   acks   correct   dropped   results/expected');
  for (let q = 0; q < game.N; q++) {
    const rv = game.reveals[q];
    const key = game.quiz.questions[q];
    const got = players.filter((p) => p.results.has(q)).length;
    out.push([
      String(q + 1).padStart(3),
      (game.revealAt[q] && game.introAt[q] ? `${Math.round(game.revealAt[q] - game.introAt[q])} ms` : '-').padStart(15),
      (game.revealAt[q] && game.openAt[q] ? `${Math.round(game.revealAt[q] - game.openAt[q])} ms` : '-').padStart(14),
      String(rv ? rv.answered : '-').padStart(10),
      String(game.acceptedAcks[q]).padStart(6),
      String(rv && Array.isArray(rv.counts) ? rv.counts[key.correct] : '-').padStart(9),
      String(game.dropped[q] ? game.dropped[q].size : 0).padStart(9),
      `${got}/${game.expectedResult[q] ? game.expectedResult[q].size : '-'}`.padStart(18),
    ].join(' '));
  }
  out.push('');
  if (warnings.length) {
    out.push(`warnings (${warnings.length}):`);
    for (const w of warnings.slice(0, 20)) out.push(`  - ${w}`);
    if (warnings.length > 20) out.push(`  ... and ${warnings.length - 20} more (run with --verbose to see them as they happen)`);
    out.push('');
  }
  if (stats.unexpectedCloseLog.length) {
    out.push(`unexpected closes (${stats.unexpectedCloses}; a violation about an answer, resync or result in the same question may be their consequence):`);
    for (const c of stats.unexpectedCloseLog) out.push(`  - ${c}`);
    if (stats.unexpectedCloses > stats.unexpectedCloseLog.length) out.push(`  ... and ${stats.unexpectedCloses - stats.unexpectedCloseLog.length} more`);
    out.push('');
  }
  if (violations.length) {
    out.push(`violations (${violations.length}):`);
    for (const v of violations.slice(0, 200)) out.push(`  - ${v}`);
    if (violations.length > 200) out.push(`  ... and ${violations.length - 200} more`);
  } else {
    out.push('violations: none');
  }
  out.push(violations.length ? 'FAIL' : 'PASS');
  process.stdout.write(`${out.join('\n')}\n`);
}

// ----------------------------------------------------------------- main

let STALL_MS = 60000;

async function main() {
  // 1. Is the server there at all?
  let health;
  try {
    const res = await fetch(`${opts.url}/api/health`, { signal: AbortSignal.timeout(5000) });
    health = await res.json();
    if (!res.ok || health.ok !== true) throw new Error(`HTTP ${res.status} ${JSON.stringify(health).slice(0, 100)}`);
  } catch (err) {
    die(`cannot reach ${opts.url}/api/health (${err.name === 'TimeoutError' ? 'timeout' : (err.cause?.code || err.message)}).\n  Start the server with "npm run dev" in quiz/ (it serves http://localhost:8787) or pass --url.`);
  }
  log(`server ${opts.url} is up (clock skew ${health.now - Date.now()} ms)`);

  // 2. The quiz (generated, or the fixture passed with --quiz).
  game.quiz = opts.quizFile ? loadQuiz(opts.quizFile) : buildQuiz(opts.questions, opts.timeLimit, mulberry32(mix(opts.seed, 1)));
  game.N = game.quiz.questions.length;
  for (let q = 0; q < game.N; q++) {
    game.answersSent[q] = 0; game.acceptedAcks[q] = 0; game.uncertain[q] = 0; game.dropped[q] = new Set();
  }
  const maxLimit = Math.max(...game.quiz.questions.map((q) => q.timeLimit));
  const minLimit = Math.min(...game.quiz.questions.map((q) => q.timeLimit));
  if (opts.answerWindow > minLimit * 1000) warn(`answer window ${opts.answerWindow} ms exceeds the ${minLimit} s time limit: some answers will be late by design`);
  STALL_MS = Math.max(INTRO_MS + maxLimit * 1000 + GRACE_MS + 15000, opts.joinBurst + 20000);

  // 3. Create the room.
  game.t0 = performance.now();
  let res; let body;
  try {
    res = await fetch(`${opts.url}/api/room`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quiz: game.quiz }),
      signal: AbortSignal.timeout(10000),
    });
    body = await res.json().catch(() => ({}));
  } catch (err) {
    die(`POST /api/room failed: ${err.message}`);
  }
  if (!res.ok || typeof body.pin !== 'string' || typeof body.hostToken !== 'string') {
    const hint = res.status === 429 ? '\n  The daily room-creation cap was hit (ROOM_CREATE_PER_IP_PER_DAY in wrangler.jsonc, default 30; local state lives in .wrangler/state).' : '';
    die(`POST /api/room failed: HTTP ${res.status} ${JSON.stringify(body)}${hint}`);
  }
  game.pin = body.pin; game.hostToken = body.hostToken;
  if (!/^[1-9][0-9]{5}$/.test(game.pin)) violate(`PIN "${game.pin}" does not match ^[1-9][0-9]{5}$`);
  if (!/^[0-9a-f]{32}$/.test(game.hostToken)) violate('hostToken is not 32 hex characters');
  log(`room ${game.pin} created (${body.joinUrl})`);

  // 4. Host socket.
  host = new Host();
  try { await host.connect(); } catch (err) {
    // The server answered and refused (4000-4010) or upgraded but never synced: a server defect, exit 1.
    // A connection that failed or hung: unreachable, exit 2.
    const serverAnswered = (err.closeCode >= 4000 && err.closeCode <= 4010) || err.closeCode === 1009 || err.closeCode === 1011 || (err.timedOut && err.opened);
    die(`host socket: ${err.message}`, serverAnswered ? 1 : 2);
  }
  log(`host synced; spawning ${opts.players} players over ${opts.joinBurst} ms`);
  host.armWatchdog();

  // 5. Players: who answers twice, and when each one joins.
  for (let i = 1; i <= opts.players; i++) players.push(new Player(i));
  const dupCount = Math.max(1, Math.round(opts.players * 0.05));
  for (const p of shuffle([...players], mulberry32(mix(opts.seed, 2))).slice(0, dupCount)) p.isDup = true;
  const joinRng = mulberry32(mix(opts.seed, 3));
  for (const p of players) setTimeout(() => p.connect(), Math.floor(joinRng() * opts.joinBurst));
  lobbyTimer = setTimeout(() => host.start(`join window + 5 s elapsed with ${readyCount}/${opts.players} players in the lobby`), opts.joinBurst + 5000);

  // 6. Play through; the host's wiped frame (or an abort) ends the wait.
  await new Promise((resolve) => { game.done = resolve; });

  // 7. Tidy up, check, report.
  for (const p of players) p.clearAll();
  host.clearAll();
  const stillOpen = players.filter((p) => p.ws !== null);
  if (host.ws) stillOpen.push(host);
  if (!game.aborted && stillOpen.length) violate(`${stillOpen.length} socket(s) were still open ${WIPE_CLOSE_WAIT_MS / 1000} s after wipe (expected 4004 closes)`);
  for (const s of stillOpen) { try { s.ws.close(1000, 'harness exit'); } catch { /* ignore */ } }
  if (stillOpen.length) await waitForSocketsClosed(1000);
  if (!game.aborted) finalChecks();
  printReport();
  process.exit(violations.length ? 1 : 0);
}

process.on('SIGINT', () => {
  if (game.aborted) process.exit(130);
  log('interrupted; closing sockets');
  abort('interrupted (SIGINT)');
});

// A bug in the harness, or a frame shape it did not expect, must still end in a report and exit 1
// rather than a bare stack trace from inside a WebSocket event handler.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (err) => {
    violations.push(`harness crashed (${event}): ${err && err.stack ? err.stack : String(err)}`);
    try {
      if (game.quiz) printReport();
      else process.stderr.write(`load.mjs: ${violations[violations.length - 1]}\n`);
    } catch (reportErr) {
      process.stderr.write(`load.mjs: ${reportErr && reportErr.stack ? reportErr.stack : String(reportErr)}\n`);
    }
    process.exit(1);
  });
}

main().catch((err) => die(`unexpected error: ${err.stack || err}`, 1));
