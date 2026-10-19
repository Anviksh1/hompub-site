/* HomPub Quiz — player page (phones). MIT licence.
 * Vanilla ES2020, no dependencies, no build step. The contract is quiz/PROTOCOL.md;
 * section numbers in comments refer to it.
 *
 * Shape of this file
 *   1. ReconnectingSocket  — small WebSocket wrapper (backoff, keepalive, visibility
 *                            probe). Self-contained: the host page can copy it as-is.
 *   2. State               — `state` mirrors the server's `sync` frame; `ui` holds the
 *                            few client-only bits (token, pending tap, connection…).
 *   3. Frame handlers      — mutate state, then render().
 *   4. render()            — every screen is a pure function of (state, ui), so a
 *                            single `sync` reproduces any screen, late joiners included.
 */
'use strict';

/* =====================================================================
 * 1. ReconnectingSocket
 * ===================================================================== */

// §4: after these close codes the server has said a definite "no"; never retry.
const NO_RETRY_CODES = new Set([4001, 4003, 4004, 4009, 4010]);

class ReconnectingSocket {
  /**
   * @param {() => string} urlFor   Called before every attempt, so the URL can gain a
   *                                token between the first connection and a reconnect.
   * @param {object} handlers       { status(s), open(isReconnect), frame(obj), close(code, reason, willRetry) }
   *                                status is 'connecting' | 'open' | 'reconnecting' | 'closed'.
   */
  constructor(urlFor, handlers) {
    this.urlFor = urlFor;
    this.h = Object.assign({ status() {}, open() {}, frame() {}, close() {} }, handlers);
    this.ws = null;
    this.attempt = 0;          // consecutive failed attempts; drives the backoff
    this.everOpened = false;
    this.stopped = false;
    this.timers = { retry: 0, open: 0, ping: 0, probe: 0 };
    // §5: reconnect when the page comes back (tab switch, screen unlock, Wi-Fi back).
    this._wake = () => { if (document.visibilityState === 'visible') this.checkAlive(); };
    document.addEventListener('visibilitychange', this._wake);
    window.addEventListener('online', this._wake);
    window.addEventListener('pageshow', this._wake);
  }

  connect() {
    if (this.stopped) return;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;   // already connecting/open
    this._clearTimers();
    let ws;
    try { ws = new WebSocket(this.urlFor()); } catch (err) { this._scheduleRetry(); return; }
    this.ws = ws;
    this.h.status(this.everOpened ? 'reconnecting' : 'connecting');
    // School Wi-Fi sometimes black-holes a handshake; give it 10 s, then try again.
    this.timers.open = setTimeout(() => { if (ws.readyState === WebSocket.CONNECTING) ws.close(); }, 10000);

    ws.addEventListener('open', () => {
      if (ws !== this.ws) return;
      clearTimeout(this.timers.open);
      const isReconnect = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.timers.ping = setInterval(() => this.ping(), 25000);   // §4: literal "ping" every 25 s
      this.h.status('open');
      this.h.open(isReconnect);
    });

    ws.addEventListener('message', (ev) => {
      if (ws !== this.ws) return;
      clearTimeout(this.timers.probe);
      this.timers.probe = 0;
      if (typeof ev.data !== 'string' || ev.data === 'pong') return;
      let frame = null;
      try { frame = JSON.parse(ev.data); } catch (err) { return; }
      if (frame && typeof frame.t === 'string') this.h.frame(frame);
    });

    ws.addEventListener('close', (ev) => {
      if (ws !== this.ws) return;
      this.ws = null;
      this._clearTimers();
      const retry = !this.stopped && !NO_RETRY_CODES.has(ev.code);
      if (!retry) { this.stopped = true; this.h.status('closed'); }
      this.h.close(ev.code, ev.reason || '', retry);
      if (retry) this._scheduleRetry();
    });
    // 'error' is always followed by 'close' in browsers; nothing to do for it.
  }

  /** Sends a JSON object (or a raw string such as "ping"). Returns false when not open. */
  send(obj) {
    if (!this.isOpen) return false;
    this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    return true;
  }

  ping() { this.send('ping'); }

  get isOpen() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

  /** Called on visibilitychange / online / pageshow. */
  checkAlive() {
    if (this.stopped) return;
    const ws = this.ws;
    if (!ws || ws.readyState >= WebSocket.CLOSING) { this.reconnectNow(); return; }
    if (ws.readyState === WebSocket.OPEN && !this.timers.probe) {
      // iOS keeps a dead socket "open" after the tab was backgrounded: probe it.
      // Any message (pong or a frame) within 4 s cancels the probe.
      this.ping();
      this.timers.probe = setTimeout(() => {
        this.timers.probe = 0;
        if (this.ws === ws) ws.close();     // fires 'close' → backoff from zero
      }, 4000);
    }
    // CONNECTING: the open timer already covers it.
  }

  /** Skip the pending backoff and connect right away. */
  reconnectNow() {
    if (this.stopped) return;
    clearTimeout(this.timers.retry);
    this.attempt = 0;
    this.connect();
  }

  /** Permanent close: no more retries, listeners removed. */
  close(code = 1000) {
    this.stopped = true;
    this._clearTimers();
    document.removeEventListener('visibilitychange', this._wake);
    window.removeEventListener('online', this._wake);
    window.removeEventListener('pageshow', this._wake);
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(code); } catch (err) { /* already closed */ } }
    this.h.status('closed');
  }

  _scheduleRetry() {
    if (this.stopped) return;
    this.h.status(this.everOpened ? 'reconnecting' : 'connecting');
    // §5: 500 ms → 8 s, doubling, ±30 % jitter so 100 phones don't stampede at once.
    const base = Math.min(8000, 500 * 2 ** this.attempt);
    const jitter = base * 0.3 * (Math.random() * 2 - 1);
    this.attempt += 1;
    this.timers.retry = setTimeout(() => this.connect(), Math.round(base + jitter));
  }

  _clearTimers() {
    clearTimeout(this.timers.retry);
    clearTimeout(this.timers.open);
    clearTimeout(this.timers.probe);
    clearInterval(this.timers.ping);
    this.timers = { retry: 0, open: 0, ping: 0, probe: 0 };
  }
}

/* =====================================================================
 * 2. Constants and state
 * ===================================================================== */

const PIN_RE = /^[1-9][0-9]{5}$/;
const PIN = new URLSearchParams(location.search).get('pin') || '';
const STORE_KEY = 'hompub-quiz:player:' + PIN;      // §4.3 welcome
const CONTRAST_KEY = 'hompub-quiz:contrast';        // per-phone convenience only
const SHAPE_NAMES = ['Red triangle', 'Blue diamond', 'Yellow circle', 'Green square'];
const MAX_SPINS = 3;                                // §4.1
const PLACES = ['1st', '2nd', '3rd'];

// Title + fallback body for the no-retry close codes (§4). The server's own
// close reason, when it sends one, replaces the body.
const CLOSE_TEXT = {
  4001: ['Not allowed', 'This link is not valid for this game.'],
  4003: ['You were removed by the host', ''],
  4004: ['This game has ended', 'The game is over or the PIN is no longer in use.'],
  4009: ['This game is full', 'The host has reached the player limit.'],
  4010: ['This game is locked', 'The host is not letting new players in right now.'],
};

const PILL_TEXT = { connecting: 'Connecting…', open: 'Connected', reconnecting: 'Reconnecting…', closed: 'Disconnected' };

// Mirrors the server's `sync` frame (§4.3). Replaced wholesale on every sync.
let state = {
  phase: null, q: null, total: 0, title: '', playerCount: 0, locked: false,
  settings: null, question: null, me: null, result: null, podium: null,
};

// Client-only bits. Everything else comes from the server.
const ui = {
  saved: null,          // {pin, token, pid, nick} from welcome / localStorage; non-null = we are a player
  joining: false,       // join sent, waiting for welcome
  joinFrame: null,      // the join frame to (re)send when the socket opens
  spins: 0,             // name spins used
  conn: 'connecting',   // status pill
  fatal: null,          // {title, text, retry} → fatal screen
  pendingChoice: null,  // tapped, waiting for ack
  ack: null,            // {accepted, reason} for the current question
  timeUp: false,        // our clock passed the deadline while the question was open
  summary: null,        // GET /api/room/<pin> (join screen only)
  failures: 0,          // handshakes that failed before the first successful open
  focusedNick: false,
};

let clockOffset = 0;    // §2: serverNow - Date.now(); refreshed by every timed frame
let sock = null;
let rafId = 0;
let toastTimer = 0;
let wakeLock = null;

/* ---------- tiny helpers ---------- */
const $ = (id) => document.getElementById(id);
const setText = (id, text) => { $(id).textContent = text; };
const fmt = (n) => Number(n || 0).toLocaleString();
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;
function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return n + 'th';
  return n + (['th', 'st', 'nd', 'rd'][n % 10] || 'th');
}
const serverNow = () => Date.now() + clockOffset;
function syncClock(frame) {
  if (typeof frame.serverNow === 'number') clockOffset = frame.serverNow - Date.now();
}

/* ---------- localStorage (may be unavailable in private mode: every call is guarded) ---------- */
function loadSaved() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return v && typeof v.token === 'string' ? v : null;
  } catch (err) { return null; }
}
function saveSaved(v) {
  ui.saved = v;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch (err) { /* in-memory copy is enough */ }
}
function clearSaved() {
  ui.saved = null;
  try { localStorage.removeItem(STORE_KEY); } catch (err) { /* ignore */ }
}

function toast(text, ms = 2500) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// §5: keep the screen on while playing. Wake locks are released whenever the page
// is hidden, so we ask again on every return to the foreground.
function requestWakeLock() {
  if (!ui.saved || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  if (wakeLock && !wakeLock.released) return;
  try {
    navigator.wakeLock.request('screen').then((lock) => { wakeLock = lock; }, () => {});
  } catch (err) { /* unsupported or denied: fine */ }
}

/* =====================================================================
 * 3. Socket and frame handling
 * ===================================================================== */

function wsUrl() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let url = `${scheme}//${location.host}/api/room/${PIN}/ws?role=player`;
  if (ui.saved && ui.saved.token) url += '&token=' + encodeURIComponent(ui.saved.token);
  return url;
}

function openSocket() {
  if (sock) { sock.reconnectNow(); return; }
  sock = new ReconnectingSocket(wsUrl, {
    status(s) { ui.conn = s; renderPill(); },
    open(isReconnect) {
      if (isReconnect) toast('Reconnected');
      // §4.1: a newcomer introduces themself; a token holder sends nothing and gets `sync`.
      if (!ui.saved && ui.joinFrame) sock.send(ui.joinFrame);
      requestWakeLock();
    },
    frame: handleFrame,
    close(code, reason, willRetry) {
      if ((code === 4004 || code === 4000) && ui.saved && state.phase === null) {
        // The room did not accept our stored token (PROTOCOL §5: 4004 "Unknown player
        // token; join again", e.g. the PIN was reused for a new game). Retrying the same
        // handshake cannot help: forget it and join afresh (a wiped room then shows 404).
        sock.close();
        sock = null;
        clearSaved();
        toast('Your earlier session was not recognised — join again.');
        fetchSummary();
        return;
      }
      if (willRetry) {                             // pill already says "Reconnecting…"
        if (!sock.everOpened) { ui.failures += 1; render(); }
        return;
      }
      if (ui.fatal || state.phase === 'ended') return;
      const [title, fallback] = CLOSE_TEXT[code] || ['Disconnected', `The connection was closed (code ${code}).`];
      ui.fatal = { title, text: reason || fallback, retry: code === 4009 || code === 4010 };
      if (code === 4003 || code === 4004) clearSaved();   // token is dead either way
      ui.joining = false;
      render();
    },
  });
  sock.connect();
}

function handleFrame(f) {
  syncClock(f);
  switch (f.t) {
    case 'welcome':
      // §4.3: persist so a reload (or a new tab) resumes instead of re-joining.
      saveSaved({ pin: f.pin || PIN, token: f.token, pid: f.pid, nick: f.nick });
      ui.joining = false;
      state.me = Object.assign({}, state.me, { pid: f.pid, nick: f.nick });
      requestWakeLock();
      break;

    case 'sync':
      applySync(f);
      break;

    case 'lobby':
      if (typeof f.playerCount === 'number') state.playerCount = f.playerCount;
      if (typeof f.locked === 'boolean') state.locked = f.locked;
      break;

    case 'intro':
      if (!f.question) break;                      // malformed; wait for the next sync
      state.phase = 'intro';
      state.question = f.question;
      state.q = f.question.q;
      state.total = f.question.total;
      state.result = null;
      if (state.me) { state.me.answered = false; state.me.choice = null; }
      ui.pendingChoice = null; ui.ack = null; ui.timeUp = false;
      break;

    case 'open':
      if (state.question && state.question.q === f.q) state.question.deadline = f.deadline;
      state.phase = 'open';
      state.q = f.q;
      break;

    case 'ack':
      if (f.q !== state.q) break;                  // stale ack from a previous question
      ui.ack = { accepted: !!f.accepted, reason: f.reason || '' };
      if (f.accepted && state.me) { state.me.answered = true; state.me.choice = ui.pendingChoice; }
      if (!f.accepted && f.reason === 'invalid') ui.pendingChoice = null;   // let them tap again
      break;

    case 'result':
      state.phase = 'closed';
      state.q = f.q;
      state.result = f;
      if (state.me) {
        state.me.score = f.score; state.me.rank = f.rank; state.me.streak = f.streak;
        state.me.answered = f.choice != null; state.me.choice = f.choice;
      }
      if (typeof f.playerCount === 'number') state.playerCount = f.playerCount;
      break;

    case 'podium':
      state.phase = 'podium';
      state.podium = { top: Array.isArray(f.top) ? f.top : [], you: f.you || null };
      state.result = null;
      if (typeof f.playerCount === 'number') state.playerCount = f.playerCount;
      break;

    case 'ended':
      // §4.3: "Game over. Nothing about this game is kept." — and we keep nothing either.
      state.phase = 'ended';
      clearSaved();
      if (sock) sock.close();
      break;

    case 'kicked':
      ui.fatal = { title: 'You were removed by the host', text: '', retry: false };
      clearSaved();
      if (sock) sock.close();
      break;

    case 'settings':
      if (f.settings) state.settings = Object.assign({}, state.settings, f.settings);
      break;

    case 'error':
      toast(f.message || `Error: ${f.code}`);
      ui.joining = false;
      break;

    default:
      break;   // unknown frame types are ignored (forward compatibility)
  }
  render();
}

// §4.3: the snapshot is the truth; replace everything. Client bookkeeping that
// belongs to one question (pending tap, ack, local time-up) is reset too — the
// server's `me.answered` / `me.choice` say what counts.
function applySync(f) {
  state = Object.assign({}, f);
  delete state.t;
  delete state.serverNow;
  if (state.me && state.me.pid) {
    ui.joining = false;
    // A spun or de-duplicated nickname may differ from what we stored.
    if (ui.saved && state.me.nick && state.me.nick !== ui.saved.nick) {
      saveSaved(Object.assign({}, ui.saved, { nick: state.me.nick }));
    }
  }
  ui.pendingChoice = null;
  ui.ack = null;
  ui.timeUp = false;
}

/* ---------- player actions ---------- */

function startJoin(spin) {
  if (ui.joining || ui.saved) return;
  const nick = spin ? '' : $('nick').value.trim().slice(0, 20);
  ui.joinFrame = spin ? { t: 'join', spin: true } : { t: 'join', nick };
  if (spin) ui.spins += 1;
  ui.joining = true;
  if (!sock) openSocket();
  else if (!sock.send(ui.joinFrame)) sock.reconnectNow();   // sent from the open handler instead
  render();
}

// §4.1: up to 3 spins, before the first answer. The server enforces the limit;
// this just avoids offering a button that cannot work.
function respin() {
  if (ui.spins >= MAX_SPINS || !sock) return;
  if (!sock.send({ t: 'join', spin: true })) { toast('Not connected yet'); return; }
  ui.spins += 1;
  render();
}

function onChoice(choice) {
  if (state.phase !== 'open' || !state.question) return;
  if (ui.pendingChoice != null || (state.me && state.me.answered) || ui.timeUp) return;
  if (!sock || !sock.isOpen) {
    toast('Not connected — reconnecting…');
    if (sock) sock.reconnectNow();
    return;
  }
  if (navigator.vibrate) { try { navigator.vibrate(30); } catch (err) { /* ignore */ } }
  ui.pendingChoice = choice;
  sock.send({ t: 'answer', q: state.q, choice });
  render();
}

async function fetchSummary() {
  try {
    const res = await fetch(`/api/room/${PIN}`, { cache: 'no-store', headers: { accept: 'application/json' } });
    if (res.status === 404) {
      ui.fatal = { title: 'No game with that PIN', text: 'Check the PIN on the big screen and try again.', retry: false };
    } else if (res.ok) {
      const s = await res.json();
      ui.summary = s;
      if (s && typeof s.playerCount === 'number') state.playerCount = s.playerCount;
      if (s && typeof s.title === 'string') state.title = s.title;
      if (s && s.phase === 'ended') {
        ui.fatal = { title: 'This game has ended', text: 'Nothing about it is kept.', retry: false };
      }
    }
    // Other statuses: let the WebSocket report the real problem when they tap Join.
  } catch (err) { /* offline: the socket wrapper will retry when they tap Join */ }
  render();
}

/* =====================================================================
 * 4. Rendering
 * ===================================================================== */

function pickScreen() {
  if (!PIN_RE.test(PIN)) return 'nopin';
  if (ui.fatal) return 'fatal';
  if (state.phase === 'ended') return 'ended';
  if (!ui.saved) return 'join';
  switch (state.phase) {
    case 'lobby': case 'intro': case 'open': case 'closed': case 'podium':
      return state.phase;
    default:
      return 'connecting';   // token in hand, snapshot not here yet
  }
}

function render() {
  const screen = pickScreen();
  document.body.dataset.screen = screen;
  document.querySelectorAll('[data-screen]').forEach((el) => { el.hidden = el.dataset.screen !== screen; });
  renderPill();
  const draw = RENDER[screen];
  if (draw) draw();
  if (screen === 'intro' || screen === 'open') {
    // paintClock() may move intro → open or flag time-up; each change is one-way,
    // so this recursion is bounded (at most two extra passes).
    if (paintClock()) { render(); return; }
    startTicking();
  } else {
    stopTicking();
  }
}

function renderPill() {
  const pill = $('pill');
  pill.dataset.conn = ui.conn;
  pill.textContent = PILL_TEXT[ui.conn] || ui.conn;
}

function questionLabel() {
  const q = state.question;
  const idx = (q && typeof q.q === 'number') ? q.q : state.q;
  const total = (q && q.total) || state.total;
  return (typeof idx === 'number' && total) ? `Question ${idx + 1} of ${total}` : '';
}

const RENDER = {
  join() {
    const s = ui.summary;
    setText('join-heading', state.title || 'Join the game');
    setText('join-pin', 'PIN ' + PIN);
    setText('join-count', plural(state.playerCount, 'player') + ' in');

    const mode = (state.settings && state.settings.nicknameMode)
      || (s && (s.nicknameMode || (s.settings && s.settings.nicknameMode)));
    const spinOnly = mode === 'spin';
    $('nick-row').hidden = spinOnly;
    $('spin-hint').hidden = !spinOnly;

    let notice = '';
    if (s && s.locked) notice = 'The host has locked this game — new players can’t join right now.';
    else if (s && s.phase && s.phase !== 'lobby' && s.lateJoin === false) notice = 'This game has already started and the host isn’t letting new players in.';
    else if (s && s.phase && s.phase !== 'lobby') notice = 'This game has already started. You can still join; earlier questions won’t count for you.';
    $('join-notice').hidden = !notice;
    setText('join-notice', notice);

    const busy = ui.joining;
    $('nick').disabled = busy;
    $('join-btn').disabled = busy;
    $('spin-btn').disabled = busy;
    setText('join-btn', busy ? 'Joining…' : 'Join');
    setText('spin-btn', busy ? 'Joining…' : 'Spin a name');
    if (!spinOnly && !busy && !ui.focusedNick) { ui.focusedNick = true; $('nick').focus(); }
  },

  connecting() {
    const nick = ui.saved && ui.saved.nick;
    setText('connecting-title', ui.saved ? 'Rejoining…' : 'Connecting…');
    setText('connecting-text', nick ? `Welcome back, ${nick}.` : '');
    $('connecting-hint').hidden = ui.failures < 3;
  },

  lobby() {
    const me = state.me || {};
    setText('lobby-nick', me.nick || (ui.saved && ui.saved.nick) || '');
    setText('lobby-count', plural(state.playerCount, 'player') + ' in');
    const canSpin = ui.spins < MAX_SPINS && !me.answered;
    $('respin-btn').hidden = !canSpin;
    setText('respin-btn', ui.spins ? `Spin again (${MAX_SPINS - ui.spins} left)` : 'Spin a new name');
  },

  intro() {
    setText('intro-title', state.title || '');
    setText('intro-q', questionLabel());
  },

  open() {
    const q = state.question || {};
    const me = state.me || {};
    const count = Math.min(4, Math.max(2, q.optionCount || (Array.isArray(q.options) ? q.options.length : 4)));
    const hasText = Array.isArray(q.options) && q.options.length > 0;   // only when showOnDevices
    setText('open-q', questionLabel());
    $('open-text').hidden = !q.text;
    setText('open-text', q.text || '');

    const grid = $('grid');
    grid.dataset.count = String(count);
    grid.classList.toggle('with-text', hasText);

    const answered = me.answered || ui.pendingChoice != null;
    const locked = answered || ui.timeUp;
    const chosen = me.answered ? me.choice : ui.pendingChoice;
    grid.querySelectorAll('.opt').forEach((btn) => {
      const i = Number(btn.dataset.choice);
      btn.hidden = i >= count;
      const label = hasText && typeof q.options[i] === 'string' ? q.options[i] : '';
      btn.querySelector('.opt-text').textContent = label;
      btn.setAttribute('aria-label', SHAPE_NAMES[i] + (label ? ': ' + label : ''));
      btn.disabled = locked;
      btn.classList.toggle('picked', chosen === i);
      btn.classList.toggle('dim', locked && chosen !== i);
    });

    let text = 'Tap your answer';
    let kind = 'muted';
    if (ui.ack && !ui.ack.accepted) {
      kind = 'bad';
      if (ui.ack.reason === 'duplicate') text = 'Already answered';
      else if (ui.ack.reason === 'invalid') text = 'That answer wasn’t valid — try again';
      else text = 'Too late — not counted';                 // late / closed
    } else if (answered) {
      text = 'Answer sent — waiting for the others'; kind = 'ok';
    } else if (ui.timeUp) {
      text = 'Time’s up'; kind = 'muted';
    }
    const status = $('open-status');
    status.textContent = text;
    status.dataset.kind = kind;
  },

  closed() {
    const r = state.result;
    const me = state.me || {};
    const q = state.question || {};
    setText('closed-q', questionLabel());

    let verdict = 'No answer', cls = 'none';
    if (r && r.choice != null) {
      if (r.choice === r.correct) { verdict = 'Correct ✓'; cls = 'correct'; }
      else { verdict = 'Wrong ✗'; cls = 'wrong'; }
    }
    const v = $('verdict');
    v.textContent = verdict;
    v.dataset.verdict = cls;

    const points = r ? r.points : 0;
    setText('res-points', q.points === 0 ? 'Survey question — no points' : `+${fmt(points)} points`);

    const hasCorrect = !!r && Number.isInteger(r.correct) && r.correct >= 0 && r.correct <= 3;
    $('res-correct-row').hidden = !hasCorrect;
    if (hasCorrect) {
      $('res-correct').dataset.shape = String(r.correct);
      const optText = Array.isArray(q.options) && typeof q.options[r.correct] === 'string' ? q.options[r.correct] : '';
      setText('res-correct-text', optText || SHAPE_NAMES[r.correct]);
      $('res-correct').setAttribute('aria-label', SHAPE_NAMES[r.correct] + (optText ? ': ' + optText : ''));
    }

    const score = r ? r.score : me.score;
    const rank = r ? r.rank : me.rank;
    const total = (r && r.playerCount) || state.playerCount;
    setText('res-score', fmt(score));
    setText('res-rank', rank ? `You are ${ordinal(rank)} of ${fmt(total)}` : '—');

    const streak = (r ? r.streak : me.streak) || 0;
    $('res-streak').hidden = streak < 2;
    setText('res-streak-n', `${streak} in a row`);
  },

  podium() {
    const p = state.podium || {};
    const me = state.me || {};
    const you = p.you || { score: me.score, rank: me.rank };
    setText('pod-you', you.rank ? `You finished ${ordinal(you.rank)} of ${fmt(state.playerCount)}` : 'Final results');
    setText('pod-score', `${fmt(you.score)} points`);

    const list = $('pod-top');
    list.textContent = '';                       // rebuild; names are server text → textContent only
    (p.top || []).slice(0, 3).forEach((entry, i) => {
      const li = document.createElement('li');
      if (entry.nick && entry.nick === me.nick) li.className = 'you';
      const place = document.createElement('span'); place.className = 'place'; place.textContent = PLACES[i];
      const name = document.createElement('span'); name.className = 'name'; name.textContent = entry.nick || '';
      const score = document.createElement('span'); score.className = 'score'; score.textContent = fmt(entry.score);
      li.append(place, name, score);
      list.appendChild(li);
    });
  },

  fatal() {
    setText('fatal-title', ui.fatal.title);
    setText('fatal-text', ui.fatal.text || '');
    $('fatal-retry').hidden = !ui.fatal.retry;
  },
};

/* ---------- countdowns (§2: always the server's clock) ---------- */

// One requestAnimationFrame loop, started by render() for intro/open and stopped
// otherwise. (rAF pauses in background tabs; the server's frames still arrive.)
function startTicking() { if (!rafId) rafId = requestAnimationFrame(tick); }
function stopTicking() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  $('timefill').style.transform = 'scaleX(1)';
}
function tick() {
  rafId = 0;
  if (state.phase !== 'intro' && state.phase !== 'open') return;
  if (paintClock()) { render(); return; }      // render() restarts the loop
  rafId = requestAnimationFrame(tick);
}

/** Paints the countdown for the current phase. Returns true when the clock changed
 *  the state (intro → open, or the deadline passed) and the screen must be redrawn. */
function paintClock() {
  const q = state.question;
  if (!q) return false;
  const now = serverNow();
  if (state.phase === 'intro') {
    const left = q.opensAt - now;
    setText('intro-count', left > 0 ? String(Math.ceil(left / 1000)) : 'Go!');
    if (left <= 0) {
      // §2: everyone learns opensAt in advance, so we show the buttons on our own
      // (server-synced) clock; the server's `open` frame then only confirms the deadline.
      state.phase = 'open';
      return true;
    }
  } else if (state.phase === 'open') {
    const total = Math.max(1, q.deadline - q.opensAt);
    const left = Math.max(0, q.deadline - now);
    $('timefill').style.transform = `scaleX(${(left / total).toFixed(4)})`;
    setText('open-secs', `${Math.ceil(left / 1000)} s`);
    if (left <= 0 && !ui.timeUp) { ui.timeUp = true; return true; }
  }
  return false;
}

/* ---------- high-contrast toggle ---------- */

function applyContrast(pref) {              // 'high' | 'normal' | null (follow the OS)
  const root = document.documentElement;
  if (pref) root.dataset.contrast = pref; else delete root.dataset.contrast;
  const osHigh = window.matchMedia && window.matchMedia('(prefers-contrast: more)').matches;
  const on = pref ? pref === 'high' : osHigh;
  $('contrast').setAttribute('aria-pressed', on ? 'true' : 'false');
}
function initContrast() {
  let pref = null;
  try { pref = localStorage.getItem(CONTRAST_KEY); } catch (err) { /* ignore */ }
  applyContrast(pref === 'high' || pref === 'normal' ? pref : null);
  $('contrast').addEventListener('click', () => {
    const next = $('contrast').getAttribute('aria-pressed') === 'true' ? 'normal' : 'high';
    applyContrast(next);
    try { localStorage.setItem(CONTRAST_KEY, next); } catch (err) { /* ignore */ }
  });
}

/* ---------- boot ---------- */

function boot() {
  initContrast();
  $('join-form').addEventListener('submit', (ev) => { ev.preventDefault(); startJoin(false); });
  $('spin-btn').addEventListener('click', () => startJoin(true));
  $('respin-btn').addEventListener('click', respin);
  $('fatal-retry').addEventListener('click', () => location.reload());
  $('grid').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.opt');
    if (btn && !btn.disabled) onChoice(Number(btn.dataset.choice));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWakeLock();
  });

  if (!PIN_RE.test(PIN)) { render(); return; }
  ui.saved = loadSaved();
  render();
  if (ui.saved) openSocket();      // §5: resume with the token; the server replies with sync
  else fetchSummary();             // first visit: show title / player count on the join screen
}

boot();
