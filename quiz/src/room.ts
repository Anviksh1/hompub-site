// The Room is the referee for one game: it owns every WebSocket in the room,
// keeps all authoritative state in its own SQLite database, stamps and scores
// every answer on its own clock, and never sends the answer key to a player.
// One instance per PIN; created where the host's POST /api/room landed.
//
// It uses the WebSocket Hibernation API, so between questions (no pending
// timers) the object is evicted from memory while the sockets stay attached
// at the edge; the next frame re-runs the constructor, which reloads state
// from SQLite. Per-socket attachments carry only {role, pid, v, authed, joinAt}.
//
// Protocol 2 (PROTOCOL.md §11): pages say `v=2`. Version-1 pages (cached before
// the deploy) keep receiving the frames they understand.
//
// See ../PROTOCOL.md for every frame and transition implemented here.

import { DurableObject } from 'cloudflare:workers';
import { devOn, type Env } from './env';
import { deriveKey, mintPlayerToken, roomKey, secretsProblem, verifyHostHeader } from './auth';
import {
  LIMITS,
  csvEscape,
  hasResults,
  idlePlan,
  joinName,
  letterFor,
  mergeSettings,
  normalizeSettings,
  randomHex,
  renameCheck,
  sanitizeNick,
  scoreAnswer,
  spinName,
  type NameNote,
  type Phase,
  type Question,
  type Quiz,
  type Settings,
} from './shared';

// ------------------------------------------------------------------ storage

type RoomRow = {
  id: number;
  pin: string;
  host_token: string;
  phase: Phase;
  q: number;
  opens_at: number | null;
  deadline: number | null;
  settings: string;
  quiz: string;
  locked: number;
  created_at: number;
  last_activity: number;
  phase_at: number;
};

type PlayerRow = {
  pid: string;
  token: string;
  nick: string;
  joined_at: number;
  kicked: number;
  spins: number;
  score: number;
  elapsed_total: number;
  streak: number;
  answers: string;
  renames?: number | null;
  join_id?: string | null;
};

/** One recorded answer: choice, elapsed ms (server clock), points awarded. */
interface AnswerRecord { c: number; ms: number; p: number }

interface Player {
  pid: string;
  token: string;
  nick: string;
  joinedAt: number;
  kicked: boolean;
  spins: number;
  score: number;
  elapsedTotal: number;
  streak: number;
  answers: Record<string, AnswerRecord>;
  renames: number;
  joinId: string | null;
}

interface RoomState {
  pin: string;
  hostToken: string;
  phase: Phase;
  q: number;
  opensAt: number | null;
  deadline: number | null;
  settings: Settings;
  quiz: Quiz;
  locked: boolean;
  createdAt: number;
  lastActivity: number;
  phaseAt: number;
}

/**
 * v: protocol version the page speaks (missing = 1). authed: false only for a
 * host socket still waiting for its `auth` frame (missing = authenticated, as
 * every host socket was before protocol 2). joinAt: last join attempt of a
 * player socket that has not joined yet. wid: id of a socket that is still
 * pending, so a timer can find it again through ctx.getWebSockets() (the
 * WebSocket object from the upgrade cannot be closed once it is accepted).
 */
interface Attachment { role: 'host' | 'player'; pid: string | null; v?: number; authed?: boolean; joinAt?: number; wid?: string }

interface RosterEntry { pid: string; nick: string; connected: boolean; score: number; answered: boolean }
interface Keys { host: CryptoKey; token: CryptoKey; room: CryptoKey }

type Frame = Record<string, unknown> & { t: string };
type Timer = ReturnType<typeof setTimeout>;

const PROTO = 2;
/** What a player_updated delta is about: the name and whether the phone is connected. */
const rosterSig = (e: RosterEntry) => `${e.connected ? 1 : 0}|${e.nick}`;
const ACTIVITY_PERSIST_MS = 60_000;
/** A socket that connects as a player but never sends a successful `join` is closed after this long. */
const PENDING_JOIN_MS = 60_000;
/** Extra player sockets allowed above 2 × MAX_PLAYERS, so reconnects still fit in a full room. */
const SOCKET_HEADROOM = 50;
const STORAGE_MESSAGE =
  "The server could not save the game. Cloudflare's free daily limit is probably used up; it resets at 05:30 IST (00:00 UTC). The game cannot continue until then.";

/** A SQLite write failed (most likely the daily write allowance is used up). */
class StorageError extends Error {}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS room (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pin TEXT NOT NULL,
    host_token TEXT NOT NULL,
    phase TEXT NOT NULL,
    q INTEGER NOT NULL DEFAULT -1,
    opens_at INTEGER,
    deadline INTEGER,
    settings TEXT NOT NULL,
    quiz TEXT NOT NULL,
    locked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    phase_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS players (
    pid TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    nick TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    kicked INTEGER NOT NULL DEFAULT 0,
    spins INTEGER NOT NULL DEFAULT 0,
    score INTEGER NOT NULL DEFAULT 0,
    elapsed_total INTEGER NOT NULL DEFAULT 0,
    streak INTEGER NOT NULL DEFAULT 0,
    answers TEXT NOT NULL DEFAULT '{}',
    renames INTEGER NOT NULL DEFAULT 0,
    join_id TEXT
  );
`;

export class Room extends DurableObject<Env> {
  private sql: SqlStorage;
  private state: RoomState | null = null;
  private players = new Map<string, Player>();
  private byToken = new Map<string, string>();
  /** Recent join ids → pid, so a join repeated after a lost `welcome` reattaches instead of duplicating. */
  private joinIds = new Map<string, string>();
  /** pids that have answered the current question (rebuilt from SQLite on wake). */
  private answered = new Set<string>();
  /** pids connected when the current question opened; null after a wake. */
  private eligible: Set<string> | null = null;
  private openTimer: Timer | null = null;
  private closeTimer: Timer | null = null;
  private tallyTimer: Timer | null = null;
  private rosterTimer: Timer | null = null;
  /** What version-2 hosts were last told about each player; null after a wake (they then get a sync). */
  private rosterBaseline: Map<string, string> | null = null;
  private buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();
  private lastPersistedActivity = 0;
  private warnedWipeAt = 0;
  private storageWarnedAt = 0;
  private keysP: Promise<Keys | null> | null = null;
  private roomKeyText: string | null = null;
  private dev = { ttlScale: 1, failAfter: null as number | null, report: false, statements: 0, rows: 0, alarms: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    // Columns added in protocol 2, for rooms created before it. Defaults keep the previous version's INSERT working.
    const cols = this.sql.exec<{ name: string }>('PRAGMA table_info(players)').toArray().map(r => r.name);
    if (!cols.includes('renames')) this.sql.exec('ALTER TABLE players ADD COLUMN renames INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('join_id')) this.sql.exec('ALTER TABLE players ADD COLUMN join_id TEXT');
    if (devOn(env)) {
      const scale = Number(env.DEV_TTL_SCALE);
      const fail = Number(env.DEV_FAIL_WRITES_AFTER);
      this.dev.ttlScale = scale > 0 ? scale : 1;
      this.dev.failAfter = Number.isInteger(fail) && fail >= 0 && env.DEV_FAIL_WRITES_AFTER !== undefined && env.DEV_FAIL_WRITES_AFTER !== '' ? fail : null;
      this.dev.report = env.DEV_REPORT_ROWS === '1';
    }
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.load();
      await this.loadRoomKey();
    });
  }

  // ----------------------------------------------------------------- RPC

  /** Called once by the Worker right after allocation. */
  async init(pin: string, quiz: Quiz, settings: Settings): Promise<{ hostToken: string }> {
    if (this.state) throw new Error('room already initialised');
    const now = Date.now();
    const hostToken = randomHex(16);
    const clean = normalizeSettings(settings);
    this.write(
      `INSERT INTO room (id, pin, host_token, phase, q, opens_at, deadline, settings, quiz, locked, created_at, last_activity, phase_at)
       VALUES (1, ?, ?, 'lobby', -1, NULL, NULL, ?, ?, 0, ?, ?, ?)`,
      pin, hostToken, JSON.stringify(clean), JSON.stringify(quiz), now, now, now,
    );
    this.state = {
      pin, hostToken, phase: 'lobby', q: -1, opensAt: null, deadline: null,
      settings: clean, quiz, locked: false, createdAt: now, lastActivity: now, phaseAt: now,
    };
    this.lastPersistedActivity = now;
    this.rosterBaseline = new Map(); // a new room: every host starts from an empty player list
    await this.loadRoomKey();
    await this.armAlarm();
    return { hostToken };
  }

  /**
   * Public, answer-key-free summary for the join page. The quiz title is not
   * included (anyone with a PIN could read it); players see it once they join.
   * `nicknameMode` keeps its version-1 values for pages cached before protocol 2.
   */
  async summary(): Promise<{ pin: string; phase: Phase; playerCount: number; locked: boolean; lateJoin: boolean; nicknameMode: string; nameMode: string; allowRename: boolean } | null> {
    const s = this.state;
    if (!s) return null;
    return {
      pin: s.pin, phase: s.phase, playerCount: this.activePlayers().length, locked: s.locked,
      lateJoin: s.settings.lateJoin, nicknameMode: s.settings.nicknameMode, nameMode: s.settings.nameMode, allowRename: s.settings.allowRename,
    };
  }

  /** For the signed-in host's "Resume game" list. */
  async hostSummary(): Promise<{ pin: string; title: string; phase: Phase; playerCount: number } | null> {
    const s = this.state;
    if (!s) return null;
    return { pin: s.pin, title: s.quiz.title, phase: s.phase, playerCount: this.activePlayers().length };
  }

  // -------------------------------------------------------- WebSocket upgrade

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const token = url.searchParams.get('token') || '';
    const v = Number(url.searchParams.get('v')) >= 2 ? 2 : 1;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const respond = () => new Response(null, { status: 101, webSocket: client });
    const reject = (code: number, reason: string) => {
      server.accept();
      server.close(code, reason);
      return respond();
    };

    if (!this.state) return reject(4004, 'Room not found');

    if (role === 'host') {
      const keys = await this.keys();
      const s = this.state;
      if (!s) return reject(4004, 'Room not found');
      // The Worker vouches for a signed-in host with a short-lived signed header; a client cannot forge it.
      const vouched = keys ? await verifyHostHeader(keys.host, request.headers.get('X-HQ-Host'), s.pin, Date.now()) : false;
      let authed: boolean;
      if (vouched) authed = true;
      else if (token) {
        if (token !== s.hostToken) return reject(4001, 'Bad host token');
        authed = true;
      } else if (v >= 2) authed = false; // waits for {t:'auth', token}
      else return reject(4001, 'Bad host token');
      if (!authed && this.pendingHosts() >= LIMITS.pendingHosts) return reject(4000, 'Too many host connections are waiting');
      const wid = authed ? undefined : randomHex(8);
      this.accept(server, { role: 'host', pid: null, v, authed, ...(wid ? { wid } : {}) });
      if (authed) this.hostReady(server);
      else {
        setTimeout(() => {
          const ws = this.findPending('host', wid!);
          if (ws) this.closeFromTimer(ws, 4001, 'Host sign-in timed out', 'auth_timeout');
        }, LIMITS.hostAuthMs);
      }
      return respond();
    }

    if (role !== 'player') return reject(4000, 'Unknown role');

    if (token) {
      const pid = this.byToken.get(token);
      if (!pid) {
        this.noteMiss(request);
        return reject(4004, 'Unknown player token; join again');
      }
      const p = this.players.get(pid)!;
      if (p.kicked) {
        server.accept();
        server.send(JSON.stringify({ t: 'kicked' }));
        server.close(4003, 'Removed by the host');
        return respond();
      }
      const mine = this.socketsOf(pid);
      if (v >= 2) {
        // One live page per player: the older version-2 socket is told why it closes and does not retry.
        // A page reconnecting its own socket ignores the close of the socket it already abandoned.
        for (const old of mine) {
          const a = old.deserializeAttachment() as Attachment | null;
          // A socket the page is already closing (its own reconnect) is left to finish closing.
          if ((a?.v ?? 1) >= 2 && old.readyState === 1 /* OPEN */) {
            try { old.close(4012, 'This game is open in another tab or device'); } catch { /* gone */ }
          }
        }
      } else if (mine.length >= LIMITS.socketsPerPlayer) {
        // Version-1 pages are never evicted (two old tabs would evict each other forever), only capped.
        return reject(4009, 'Too many tabs are open for this player. Close the others, then tap Try again.');
      }
      if (this.ctx.getWebSockets('player').length >= this.maxPlayers() * 2 + SOCKET_HEADROOM) return reject(4009, 'This game is full');
      this.accept(server, { role: 'player', pid, v });
      this.touch();
      this.send(server, this.buildSync('player', pid));
      this.scheduleRoster();
      return respond();
    }

    const refusal = this.joinRefusal();
    if (refusal) return reject(refusal.code, refusal.reason);
    // Pending player: joins with a `join` frame, or is dropped after a minute without a join attempt.
    const wid = randomHex(8);
    this.accept(server, { role: 'player', pid: null, v, joinAt: Date.now(), wid });
    this.touch();
    this.armPendingTimer(wid, PENDING_JOIN_MS);
    return respond();
  }

  private accept(ws: WebSocket, att: Attachment): void {
    this.ctx.acceptWebSocket(ws, [att.role]);
    ws.serializeAttachment(att);
  }

  /** An authenticated host socket: snapshot, results if the game is over, and the host count. */
  private hostReady(ws: WebSocket): void {
    const s = this.state!;
    this.touch();
    this.send(ws, this.buildSync('host', null));
    // A host taking over after the game ended still needs the results file.
    if (s.phase === 'ended') this.send(ws, this.resultsFrame());
    this.broadcastHostCount();
  }

  private armPendingTimer(wid: string, delay: number): void {
    setTimeout(() => {
      const ws = this.findPending('player', wid);
      if (!ws) return;
      try {
        const a = ws.deserializeAttachment() as Attachment | null;
        const left = (a?.joinAt ?? 0) + PENDING_JOIN_MS - Date.now();
        if (left > 500) { this.armPendingTimer(wid, left); return; }
        this.closeFromTimer(ws, 4000, 'Join timed out', 'join_timeout');
      } catch { /* socket already gone */ }
    }, delay);
  }

  /**
   * Close a socket from a timer. In local workerd a close() issued outside an
   * event handler does not reach the client, so first send an error frame that
   * version-2 pages act on by closing the socket themselves.
   */
  private closeFromTimer(ws: WebSocket, code: number, reason: string, errorCode: string): void {
    this.sendError(ws, errorCode, reason);
    try { ws.close(code, reason); } catch { /* already gone */ }
  }

  /** A socket that is still pending (not joined, or host not authenticated), found by its id. */
  private findPending(tag: 'host' | 'player', wid: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets(tag)) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.wid !== wid) continue;
      if (tag === 'host' ? a.authed === false : a.pid === null) return ws;
    }
    return null;
  }

  private joinRefusal(): { code: number; reason: string } | null {
    const s = this.state!;
    if (s.phase === 'podium' || s.phase === 'ended') return { code: 4004, reason: 'This game has ended' };
    if (s.locked) return { code: 4010, reason: 'The host has locked this game' };
    if (s.phase !== 'lobby' && !s.settings.lateJoin) return { code: 4010, reason: 'Late joining is off for this game' };
    const max = this.maxPlayers();
    if (this.activePlayers().length >= max) return { code: 4009, reason: 'This game is full' };
    // Sockets that have not joined yet (and second tabs) also count, against a looser cap.
    if (this.ctx.getWebSockets('player').length >= max * 2) return { code: 4009, reason: 'This game is full' };
    return null;
  }

  private maxPlayers(): number {
    return Number(this.env.MAX_PLAYERS) || 250;
  }

  // ------------------------------------------------------- socket handlers

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) { ws.close(4000, 'No session'); return; }
    // Limit is in bytes; a UTF-16 code unit is at most 3 UTF-8 bytes, so only measure long strings.
    const size = typeof message === 'string'
      ? (message.length * 3 > LIMITS.frameBytes ? new TextEncoder().encode(message).byteLength : message.length)
      : message.byteLength;
    if (size > LIMITS.frameBytes) { ws.close(1009, 'Frame too large'); return; }
    if (!this.allow(ws)) { ws.close(4008, 'Too many messages'); return; }
    if (typeof message !== 'string') { this.sendError(ws, 'bad_frame', 'Text frames only'); return; }
    if (message === 'ping') { this.send(ws, 'pong'); return; }

    let frame: Frame;
    try {
      const parsed = JSON.parse(message);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.t !== 'string') throw new Error('shape');
      frame = parsed as Frame;
    } catch {
      this.sendError(ws, 'bad_frame', 'Expected a JSON object with a string field t');
      return;
    }
    if (!this.state) { ws.close(4004, 'Room not found'); return; }
    if (att.role === 'host' && att.authed === false) { this.hostAuth(ws, att, frame); return; }
    this.touch();

    try {
      if (att.role === 'host') await this.handleHost(ws, frame);
      else await this.handlePlayer(ws, att, frame);
    } catch (err) {
      if (err instanceof StorageError) { this.storageFailed(); return; }
      throw err;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    try { ws.close(code, reason); } catch { /* already closed */ }
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.role === 'host') this.broadcastHostCount(ws);
    this.scheduleRoster();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try { ws.close(1011, 'Socket error'); } catch { /* ignore */ }
    this.scheduleRoster();
  }

  /** The first frame of a version-2 host socket without a URL token must be `{t:'auth', token}`. */
  private hostAuth(ws: WebSocket, att: Attachment, frame: Frame): void {
    const s = this.state;
    if (s && frame.t === 'auth' && typeof frame.token === 'string' && frame.token.length > 0 && frame.token === s.hostToken) {
      att.authed = true;
      delete att.wid;
      ws.serializeAttachment(att);
      this.hostReady(ws);
      return;
    }
    try { ws.close(4001, 'Bad host token'); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------- player side

  private async handlePlayer(ws: WebSocket, att: Attachment, frame: Frame): Promise<void> {
    switch (frame.t) {
      case 'join': {
        if (att.pid) {
          // Already joined: allow re-spinning the name before the first answer (max 3 spins).
          // Version-1 pages use this; version-2 pages use `rename`.
          const p = this.players.get(att.pid);
          if (p && frame.spin === true && Object.keys(p.answers).length === 0 && p.spins < 3) {
            const before = { nick: p.nick, spins: p.spins };
            p.nick = this.uniqueNick(spinName(), p.pid);
            p.spins += 1;
            try { this.persistPlayer(p); } catch (e) { Object.assign(p, before); throw e; }
            this.send(ws, this.buildSync('player', p.pid));
            this.scheduleRoster();
          } else {
            this.sendError(ws, 'already_joined', 'You have already joined');
          }
          return;
        }
        // Mint the token first: everything after this await runs without interruption.
        const token = await this.newPlayerToken();
        const s = this.state;
        if (!s) return;
        const joinId = typeof frame.joinId === 'string' && /^[0-9a-f]{32}$/.test(frame.joinId) ? frame.joinId : null;
        if (joinId) {
          const prev = this.players.get(this.joinIds.get(joinId) ?? '');
          if (prev && !prev.kicked && Date.now() - prev.joinedAt <= LIMITS.joinIdMs) {
            // The same page joined a moment ago and missed its `welcome`: reattach, do not create a ghost.
            att.pid = prev.pid;
            delete att.joinAt;
            delete att.wid;
            ws.serializeAttachment(att);
            this.send(ws, { t: 'welcome', pid: prev.pid, token: prev.token, nick: prev.nick, pin: s.pin });
            this.send(ws, this.buildSync('player', prev.pid));
            this.scheduleRoster();
            return;
          }
        }
        const refusal = this.joinRefusal();
        if (refusal) { ws.close(refusal.code, refusal.reason); return; }

        const choice = joinName({ nameMode: s.settings.nameMode, v2: (att.v ?? 1) >= 2, nick: frame.nick, spin: frame.spin === true });
        if (choice.kind === 'reject') {
          // The student stays on the form and tries again; the pending-socket clock restarts.
          att.joinAt = Date.now();
          ws.serializeAttachment(att);
          this.send(ws, { t: 'join_rejected', reason: choice.reason, message: choice.message });
          return;
        }
        const wanted = choice.kind === 'random' ? spinName() : choice.nick;
        const spins = choice.kind === 'random' ? 1 : 0;
        let pid = `p_${randomHex(4)}`;
        while (this.players.has(pid)) pid = `p_${randomHex(4)}`;
        const nick = this.uniqueNick(wanted, pid);
        let note: NameNote | null = choice.kind === 'typed' ? choice.note : null;
        if (choice.kind === 'typed' && nick !== wanted) note = { reason: 'duplicate', message: `Someone is already ${wanted}, so you are ${nick}.` };
        const now = Date.now();
        this.write(
          'INSERT INTO players (pid, token, nick, joined_at, kicked, spins, score, elapsed_total, streak, answers, renames, join_id) VALUES (?, ?, ?, ?, 0, ?, 0, 0, 0, ?, 0, ?)',
          pid, token, nick, now, spins, '{}', joinId,
        );
        const p: Player = { pid, token, nick, joinedAt: now, kicked: false, spins, score: 0, elapsedTotal: 0, streak: 0, answers: {}, renames: 0, joinId };
        this.players.set(pid, p);
        this.byToken.set(token, pid);
        if (joinId) this.joinIds.set(joinId, pid);
        att.pid = pid;
        delete att.joinAt;
        delete att.wid;
        ws.serializeAttachment(att);
        this.send(ws, { t: 'welcome', pid, token, nick, pin: s.pin, ...(note ? { note } : {}) });
        this.send(ws, this.buildSync('player', pid));
        this.scheduleRoster();
        return;
      }
      case 'rename': {
        if (!att.pid) { this.sendError(ws, 'not_joined', 'Join first'); return; }
        const s = this.state!;
        const p = this.players.get(att.pid);
        if (!p || p.kicked) return;
        const left = () => Math.max(0, LIMITS.maxRenames - p.renames);
        const rc = renameCheck({ allowRename: s.settings.allowRename, nameMode: s.settings.nameMode, renames: p.renames, current: p.nick, nick: frame.nick, random: frame.random });
        if (!rc.ok) { this.send(ws, { t: 'rename_rejected', reason: rc.reason, message: rc.message, renamesLeft: left() }); return; }
        const wanted = rc.kind === 'random' ? spinName() : rc.nick;
        const nick = this.uniqueNick(wanted, p.pid);
        let note: NameNote | null = rc.kind === 'typed' ? rc.note : null;
        if (rc.kind === 'typed' && nick !== wanted) note = { reason: 'duplicate', message: `Someone is already ${wanted}, so you are ${nick}.` };
        const before = { nick: p.nick, renames: p.renames };
        p.nick = nick;
        p.renames += 1;
        try { this.persistPlayer(p); } catch (e) { Object.assign(p, before); throw e; }
        this.sendToPlayer(p.pid, { t: 'renamed', nick: p.nick, renamesLeft: left(), ...(note ? { note } : {}) });
        this.scheduleRoster();
        return;
      }
      case 'answer': {
        if (!att.pid) { this.sendError(ws, 'not_joined', 'Join first'); return; }
        this.answer(ws, att.pid, frame);
        return;
      }
      default:
        this.sendError(ws, 'unknown_type', `Unknown frame type ${frame.t}`);
    }
  }

  private answer(ws: WebSocket, pid: string, frame: Frame): void {
    const s = this.state!;
    const q = frame.q;
    const choice = frame.choice;
    const ack = (accepted: boolean, reason?: string) => this.send(ws, { t: 'ack', q, accepted, ...(reason ? { reason } : {}) });

    // Phones switch to the answer buttons at opensAt on the shared clock; if a frame
    // beats our own intro timer by a few milliseconds, open the question now.
    if (s.phase === 'intro' && s.opensAt != null && Date.now() >= s.opensAt && q === s.q) this.guard(() => this.openQuestion());

    if (typeof q !== 'number' || q !== s.q || (s.phase !== 'open' && s.phase !== 'closed')) { ack(false, 'closed'); return; }
    if (s.phase === 'closed') { ack(false, 'late'); return; }
    const question = s.quiz.questions[s.q];
    if (typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0 || choice >= question.options.length) { ack(false, 'invalid'); return; }
    const p = this.players.get(pid);
    if (!p || p.kicked) { ws.close(4003, 'Removed by the host'); return; }
    if (this.answered.has(pid) || p.answers[String(q)]) { ack(false, 'duplicate'); return; }

    const now = Date.now();
    const T = question.timeLimit * 1000;
    const elapsed = Math.min(Math.max(now - (s.opensAt ?? now), 0), T);
    const correct = choice === question.correct;
    const points = scoreAnswer(correct, elapsed, question.timeLimit, question.points, s.settings.mode);

    const before = { score: p.score, elapsedTotal: p.elapsedTotal, streak: p.streak };
    p.answers[String(q)] = { c: choice, ms: elapsed, p: points };
    p.score += points;
    if (correct) { p.elapsedTotal += elapsed; p.streak += 1; } else { p.streak = 0; }
    try {
      this.persistPlayer(p); // persist before ack: nothing acknowledged is ever lost
    } catch (e) {
      delete p.answers[String(q)];
      Object.assign(p, before);
      ack(false, 'unavailable');
      throw e;
    }
    this.answered.add(pid);
    ack(true);
    this.scheduleTally();

    if (s.settings.earlyClose && this.eligible && this.eligible.size > 0) {
      let all = true;
      for (const e of this.eligible) if (!this.answered.has(e)) { all = false; break; }
      if (all) this.guard(() => this.closeQuestion());
    }
  }

  // --------------------------------------------------------------- host side

  private async handleHost(ws: WebSocket, frame: Frame): Promise<void> {
    const s = this.state!;
    const badPhase = (message: string) => this.sendError(ws, 'bad_phase', message);
    switch (frame.t) {
      case 'auth':
        return; // already authenticated
      case 'start': {
        if (s.phase !== 'lobby') return badPhase('The game has already started.');
        // Students may rename themselves in the lobby only, unless the host turns it on again.
        const renameWasOn = s.settings.allowRename;
        if (renameWasOn) s.settings = mergeSettings(s.settings, { allowRename: false }, false);
        await this.startQuestion(0);
        if (renameWasOn) this.settingsChanged(true);
        return;
      }
      case 'next':
        if (s.phase !== 'closed') return badPhase(s.phase === 'intro' || s.phase === 'open' ? 'Already on the next question.' : 'Next is not available now.');
        if (s.q + 1 < s.quiz.questions.length) await this.startQuestion(s.q + 1);
        else await this.podium();
        return;
      case 'close':
        if (s.phase !== 'open') return badPhase(s.phase === 'closed' ? 'This question is already closed.' : 'The question is not open yet.');
        await this.closeQuestion();
        return;
      case 'end':
        if (s.phase === 'ended') return badPhase('The game has already ended.');
        await this.end();
        return;
      case 'ack_results':
        if (s.phase !== 'ended') return badPhase('Results can be cleared only after the game ends.');
        await this.wipe();
        return;
      case 'kick': {
        const pid = typeof frame.pid === 'string' ? frame.pid : '';
        const p = this.players.get(pid);
        if (!p) return this.sendError(ws, 'unknown_player', 'No such player');
        const lock = frame.lock === true && !s.locked;
        p.kicked = true;
        this.persistPlayer(p);
        if (lock) { s.locked = true; this.persistRoom(); }
        this.answered.delete(pid);
        this.eligible?.delete(pid);
        for (const sock of this.socketsOf(pid)) {
          this.send(sock, { t: 'kicked' });
          try { sock.close(4003, 'Removed by the host'); } catch { /* ignore */ }
        }
        if (lock) this.broadcast('host', { t: 'settings', settings: s.settings, locked: s.locked });
        this.scheduleRoster();
        return;
      }
      case 'rename_player': {
        const pid = typeof frame.pid === 'string' ? frame.pid : '';
        const p = this.players.get(pid);
        if (!p) return this.sendError(ws, 'unknown_player', 'No such player');
        // The teacher may fix any name, so no profanity filter; the formula-trigger stripping still applies.
        const wanted = sanitizeNick(frame.nick);
        if (!wanted) return this.sendError(ws, 'bad_name', 'Type a name for this player.');
        const before = p.nick;
        p.nick = this.uniqueNick(wanted, p.pid);
        try { this.persistPlayer(p); } catch (e) { p.nick = before; throw e; }
        this.sendToPlayer(p.pid, { t: 'renamed', nick: p.nick, byHost: true, renamesLeft: Math.max(0, LIMITS.maxRenames - p.renames) });
        this.scheduleRoster();
        if (s.phase === 'closed' || s.phase === 'podium') this.broadcast('host', this.buildSync('host', null));
        // After End the results file changes; `update` tells the host page not to download it again.
        if (s.phase === 'ended') this.broadcast('host', { ...this.resultsFrame(), update: true });
        return;
      }
      case 'lock':
        s.locked = frame.on === true;
        this.persistRoom();
        this.broadcast('host', { t: 'settings', settings: s.settings, locked: s.locked });
        this.scheduleRoster();
        return;
      case 'settings': {
        const before = s.settings;
        s.settings = mergeSettings(before, frame.settings, s.phase === 'lobby');
        this.persistRoom();
        this.settingsChanged(
          before.nameMode !== s.settings.nameMode || before.allowRename !== s.settings.allowRename,
          before.showOnDevices !== s.settings.showOnDevices,
        );
        return;
      }
      case 'keep': {
        // "Keep 2 more hours" on the idle-wipe warning counts as activity.
        const now = Date.now();
        s.lastActivity = now;
        this.persistActivity(now);
        this.warnedWipeAt = 0;
        await this.armAlarm();
        this.broadcast('host', { t: 'expiry', ...this.expiry(), serverNow: now });
        return;
      }
      case 'dev_stats':
        if (devOn(this.env) && this.dev.report) {
          this.send(ws, {
            t: 'dev_stats', statements: this.dev.statements, rowsWritten: this.dev.rows, alarms: this.dev.alarms,
            players: this.players.size, wipeRows: this.players.size + 1,
          });
        }
        return;
      default:
        this.sendError(ws, 'unknown_type', `Unknown frame type ${frame.t}`);
    }
  }

  /** Tell hosts about new settings; tell phones when something they show changed. */
  private settingsChanged(phonesCare: boolean, showOnDevicesChanged = false): void {
    const s = this.state!;
    this.broadcast('host', { t: 'settings', settings: s.settings, locked: s.locked });
    if (!phonesCare && !showOnDevicesChanged) return;
    // Phones may need the question text they did not have a moment ago. A
    // `settings` frame (not a sync) lets them keep an in-progress answer UI.
    const inQuestion = s.phase === 'intro' || s.phase === 'open' || s.phase === 'closed';
    this.broadcast('player', {
      t: 'settings',
      settings: s.settings,
      ...(inQuestion && showOnDevicesChanged ? { question: this.questionView(s.settings.showOnDevices) } : {}),
    });
  }

  // ---------------------------------------------------------- game machine

  private async startQuestion(q: number): Promise<void> {
    const s = this.state!;
    const question = s.quiz.questions[q];
    const now = Date.now();
    this.clearTimers();
    s.phase = 'intro';
    s.q = q;
    s.opensAt = now + LIMITS.introMs;
    s.deadline = s.opensAt + question.timeLimit * 1000;
    s.phaseAt = now;
    s.lastActivity = now;
    this.answered.clear();
    this.eligible = null;
    this.persistRoom();

    this.broadcast('host', { t: 'intro', question: this.questionView(true), serverNow: now });
    this.broadcast('player', { t: 'intro', question: this.questionView(s.settings.showOnDevices), serverNow: now });
    this.openTimer = setTimeout(() => { this.guard(() => this.openQuestion()); }, LIMITS.introMs);
    await this.armAlarm();
  }

  private async openQuestion(): Promise<void> {
    const s = this.state;
    if (!s || s.phase !== 'intro') return;
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
    const now = Date.now();
    s.phase = 'open';
    s.phaseAt = now;
    s.lastActivity = now;
    this.persistRoom();
    this.eligible = this.connectedPids();
    const frame = { t: 'open', q: s.q, deadline: s.deadline, serverNow: now };
    this.broadcast('player', frame);
    this.broadcast('host', frame);
    this.broadcast('host', this.tallyFrame());
    const wait = Math.max((s.deadline ?? now) + LIMITS.graceMs - now, 0);
    this.closeTimer = setTimeout(() => { this.guard(() => this.closeQuestion()); }, wait);
    await this.armAlarm();
  }

  private async closeQuestion(): Promise<void> {
    const s = this.state;
    if (!s || s.phase !== 'open') return;
    this.clearTimers();
    const now = Date.now();
    s.phase = 'closed';
    s.phaseAt = now;
    s.lastActivity = now;
    this.persistRoom();

    const ranks = this.rankMap();
    const question = s.quiz.questions[s.q];
    const playerCount = this.activePlayers().length;
    const cache = new Map<string, object>();
    for (const sock of this.ctx.getWebSockets('player')) {
      const a = sock.deserializeAttachment() as Attachment | null;
      if (!a?.pid) continue;
      let frame = cache.get(a.pid);
      if (!frame) {
        const p = this.players.get(a.pid);
        if (!p || p.kicked) continue;
        frame = { t: 'result', ...this.resultFor(p, question, ranks, playerCount) };
        cache.set(a.pid, frame);
      }
      this.send(sock, frame);
    }
    this.broadcast('host', { t: 'reveal', ...this.revealView(ranks) });
    await this.armAlarm();
  }

  private async podium(): Promise<void> {
    const s = this.state!;
    this.clearTimers();
    const now = Date.now();
    s.phase = 'podium';
    s.phaseAt = now;
    s.lastActivity = now;
    this.persistRoom();
    const ranks = this.rankMap();
    const sorted = this.sortedPlayers();
    const playerCount = sorted.length;
    const top = sorted.slice(0, 3);
    for (const sock of this.ctx.getWebSockets('player')) {
      const a = sock.deserializeAttachment() as Attachment | null;
      if (!a?.pid) continue;
      const p = this.players.get(a.pid);
      if (!p || p.kicked) continue;
      this.send(sock, { t: 'podium', ...this.podiumFor(p, top, ranks), playerCount });
    }
    this.broadcast('host', {
      t: 'podium',
      top: top.map(p => ({ pid: p.pid, nick: p.nick, score: p.score })),
      leaderboard: this.leaderboard(sorted),
      playerCount,
    });
    await this.armAlarm();
  }

  private async end(): Promise<void> {
    const s = this.state!;
    this.clearTimers();
    const now = Date.now();
    s.phase = 'ended';
    s.phaseAt = now;
    s.lastActivity = now;
    this.persistRoom();
    this.broadcast('player', { t: 'ended' });
    this.broadcast('host', this.resultsFrame());
    await this.armAlarm();
  }

  private resultsFrame(): object {
    const s = this.state!;
    const d = new Date(s.phaseAt);
    const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    return { t: 'results_csv', csv: this.csv(), filename: `hompub-quiz-${s.pin}-${ymd}.csv` };
  }

  /** Forget everything. Called on ack_results or by the TTL alarm. */
  private async wipe(): Promise<void> {
    const s = this.state;
    this.clearTimers();
    this.broadcast('host', { t: 'wiped' });
    for (const sock of this.ctx.getWebSockets()) {
      try { sock.close(4004, 'Game over'); } catch { /* ignore */ }
    }
    this.state = null;
    this.players.clear();
    this.byToken.clear();
    this.joinIds.clear();
    this.answered.clear();
    this.eligible = null;
    this.rosterBaseline = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    if (s) {
      try {
        const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('global'));
        await dir.release(s.pin, this.ctx.id.toString());
      } catch { /* the Directory expires PINs on its own after 24 h */ }
    }
  }

  // ------------------------------------------------------------------ alarm

  async alarm(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    try {
      if (s.phase === 'intro' && s.opensAt != null && now >= s.opensAt) await this.openQuestion();
      if (s.phase === 'open' && s.deadline != null && now >= s.deadline + LIMITS.graceMs) await this.closeQuestion();
      if (!this.state) return;
      const plan = this.plan();
      const results = hasResults(s.phase, s.q);
      if (now >= plan.wipeAt) {
        // Idle sockets do not extend the TTL. If a question has been played, hand every
        // connected host the CSV before forgetting everything, in any phase.
        if (results) this.broadcast('host', this.resultsFrame());
        await this.wipe();
        return;
      }
      if (results && plan.warnAt !== null && now >= plan.warnAt && this.warnedWipeAt !== plan.wipeAt) {
        this.warnedWipeAt = plan.wipeAt;
        this.broadcast('host', { t: 'expiry', ...this.expiry(), serverNow: now });
      }
      await this.armAlarm();
    } catch (err) {
      if (err instanceof StorageError) { this.storageFailed(); return; }
      throw err;
    }
  }

  private plan(): { wipeAt: number; warnAt: number | null } {
    const s = this.state!;
    return idlePlan({ phase: s.phase, lastActivity: Math.max(s.lastActivity, this.lastPersistedActivity), phaseAt: s.phaseAt, scale: this.dev.ttlScale });
  }

  /** When the host should be warned and when the idle wipe happens, if results would be lost. */
  private expiry(): { wipeAt: number | null; warnAt: number | null } {
    const s = this.state!;
    if (!hasResults(s.phase, s.q)) return { wipeAt: null, warnAt: null };
    return this.plan();
  }

  private async armAlarm(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    const plan = this.plan();
    let next = plan.wipeAt;
    if (plan.warnAt !== null && now < plan.warnAt && hasResults(s.phase, s.q)) next = Math.min(next, plan.warnAt);
    if (s.phase === 'intro' && s.opensAt != null) next = Math.min(next, s.opensAt + 500);
    if (s.phase === 'open' && s.deadline != null) next = Math.min(next, s.deadline + LIMITS.graceMs + 500);
    this.dev.alarms += 1;
    await this.ctx.storage.setAlarm(Math.max(next, now + 1000));
  }

  // ---------------------------------------------------------------- views

  private questionView(withText: boolean): object {
    const s = this.state!;
    const q = s.quiz.questions[s.q];
    const view: Record<string, unknown> = {
      q: s.q, total: s.quiz.questions.length, optionCount: q.options.length,
      timeLimit: q.timeLimit, points: q.points, opensAt: s.opensAt, deadline: s.deadline,
    };
    if (withText) { view.text = q.text; view.options = q.options; }
    return view;
  }

  private buildSync(role: 'host' | 'player', pid: string | null): object {
    const s = this.state!;
    const now = Date.now();
    const inQuestion = s.phase === 'intro' || s.phase === 'open' || s.phase === 'closed';
    const finished = s.phase === 'podium' || s.phase === 'ended';
    const sorted = this.sortedPlayers();
    const ranks = this.rankMap(sorted);
    const playerCount = sorted.length;
    const base: Record<string, unknown> = {
      t: 'sync', proto: PROTO, serverNow: now, role, pin: s.pin, title: s.quiz.title,
      phase: s.phase, q: s.q, total: s.quiz.questions.length,
      locked: s.locked, settings: s.settings, playerCount,
      question: inQuestion ? this.questionView(role === 'host' || s.settings.showOnDevices) : null,
    };
    if (role === 'player' && pid) {
      const p = this.players.get(pid);
      if (p) {
        const ans = inQuestion ? p.answers[String(s.q)] : undefined;
        base.me = {
          pid: p.pid, nick: p.nick, score: p.score, rank: ranks.get(pid) ?? playerCount,
          streak: p.streak, answered: !!ans, choice: ans ? ans.c : null, spins: p.spins,
          renamesLeft: Math.max(0, LIMITS.maxRenames - p.renames),
        };
        if (s.phase === 'closed') base.result = this.resultFor(p, s.quiz.questions[s.q], ranks, playerCount);
        if (finished) base.podium = this.podiumFor(p, sorted.slice(0, 3), ranks);
      }
    }
    if (role === 'host') {
      base.roster = this.roster();
      if (inQuestion) base.tally = this.tallyFrame(false);
      if (s.phase === 'closed') base.reveal = this.revealView(ranks);
      if (s.phase === 'closed' || finished) base.leaderboard = this.leaderboard(sorted);
      if (finished) base.podium = { top: sorted.slice(0, 3).map(p => ({ pid: p.pid, nick: p.nick, score: p.score })) };
      base.hostToken = s.hostToken;
      base.roomKey = this.roomKeyText;
      base.hostCount = this.authedHosts().length;
      base.expiry = this.expiry();
    }
    return base;
  }

  private resultFor(p: Player, question: Question, ranks: Map<string, number>, playerCount: number): object {
    const s = this.state!;
    const ans = p.answers[String(s.q)];
    return {
      q: s.q, correct: question.correct, choice: ans ? ans.c : null, points: ans ? ans.p : 0,
      score: p.score, rank: ranks.get(p.pid) ?? playerCount, streak: p.streak, playerCount,
    };
  }

  private podiumFor(p: Player, top: Player[], ranks: Map<string, number>): object {
    return {
      top: top.map(t => ({ nick: t.nick, score: t.score })),
      you: { score: p.score, rank: ranks.get(p.pid) ?? this.activePlayers().length },
    };
  }

  private revealView(ranks: Map<string, number>): object {
    const s = this.state!;
    const question = s.quiz.questions[s.q];
    const key = String(s.q);
    const counts = new Array<number>(question.options.length).fill(0);
    let answered = 0;
    let fastest: { nick: string; ms: number } | null = null;
    const active = this.activePlayers();
    for (const p of active) {
      const a = p.answers[key];
      if (!a) continue;
      answered += 1;
      counts[a.c] += 1;
      if (a.c === question.correct && (fastest === null || a.ms < fastest.ms)) fastest = { nick: p.nick, ms: a.ms };
    }
    const sorted = this.sortedPlayers();
    void ranks;
    return {
      q: s.q, correct: question.correct, counts, answered,
      expected: this.eligible ? this.eligible.size : this.connectedPids().size,
      fastest, leaderboard: this.leaderboard(sorted), playerCount: active.length,
    };
  }

  private leaderboard(sorted: Player[]): object[] {
    const s = this.state!;
    const key = String(s.q);
    return sorted.slice(0, 10).map(p => ({ pid: p.pid, nick: p.nick, score: p.score, delta: p.answers[key]?.p ?? 0 }));
  }

  private tallyFrame(withType = true): object {
    const s = this.state!;
    const question = s.quiz.questions[s.q];
    const key = String(s.q);
    const counts = new Array<number>(question.options.length).fill(0);
    let answered = 0;
    for (const p of this.activePlayers()) {
      const a = p.answers[key];
      if (!a) continue;
      answered += 1;
      counts[a.c] += 1;
    }
    const expected = this.eligible ? this.eligible.size : this.connectedPids().size;
    return withType ? { t: 'tally', q: s.q, counts, answered, expected } : { counts, answered, expected };
  }

  private roster(): RosterEntry[] {
    const connected = this.connectedPids();
    return this.activePlayers().map(p => ({
      pid: p.pid, nick: p.nick, connected: connected.has(p.pid), score: p.score, answered: this.answered.has(p.pid),
    }));
  }

  private csv(): string {
    const s = this.state!;
    const n = s.quiz.questions.length;
    const header = ['rank', 'nickname', 'score', 'correct', 'answered'];
    for (let i = 1; i <= n; i++) header.push(`q${i}`);
    const lines = [header.join(',')];
    const row = (rank: number | string, p: Player) => {
      let correct = 0;
      let answered = 0;
      const cells: string[] = [];
      for (let qi = 0; qi < n; qi++) {
        const a = p.answers[String(qi)];
        if (!a) { cells.push(''); continue; }
        answered += 1;
        if (a.c === s.quiz.questions[qi].correct) correct += 1;
        cells.push(`${letterFor(a.c)} ${a.p}`);
      }
      return [rank, csvEscape(p.nick), p.score, correct, answered, ...cells].join(',');
    };
    this.sortedPlayers().forEach((p, i) => lines.push(row(i + 1, p)));
    // Players the host removed keep their recorded answers, marked "removed" instead of a rank.
    const removed = [...this.players.values()].filter(p => p.kicked).sort((a, b) => a.joinedAt - b.joinedAt);
    for (const p of removed) lines.push(row('removed', p));
    return lines.join('\r\n') + '\r\n';
  }

  // -------------------------------------------------------------- helpers

  private activePlayers(): Player[] {
    const out: Player[] = [];
    for (const p of this.players.values()) if (!p.kicked) out.push(p);
    return out;
  }

  /** Active players by score desc, then lower total elapsed on correct answers, then earlier join. */
  private sortedPlayers(): Player[] {
    return this.activePlayers().sort((a, b) =>
      b.score - a.score || a.elapsedTotal - b.elapsedTotal || a.joinedAt - b.joinedAt || (a.pid < b.pid ? -1 : 1));
  }

  private rankMap(sorted: Player[] = this.sortedPlayers()): Map<string, number> {
    const m = new Map<string, number>();
    sorted.forEach((p, i) => m.set(p.pid, i + 1));
    return m;
  }

  private connectedPids(): Set<string> {
    const set = new Set<string>();
    for (const sock of this.ctx.getWebSockets('player')) {
      const a = sock.deserializeAttachment() as Attachment | null;
      if (a?.pid && !this.players.get(a.pid)?.kicked) set.add(a.pid);
    }
    return set;
  }

  private socketsOf(pid: string): WebSocket[] {
    const out: WebSocket[] = [];
    for (const sock of this.ctx.getWebSockets('player')) {
      const a = sock.deserializeAttachment() as Attachment | null;
      if (a?.pid === pid) out.push(sock);
    }
    return out;
  }

  /** Version-2 pages get `frame`; a version-1 page gets a fresh sync, which carries the new name. */
  private sendToPlayer(pid: string, frame: object): void {
    for (const sock of this.socketsOf(pid)) {
      const a = sock.deserializeAttachment() as Attachment | null;
      this.send(sock, (a?.v ?? 1) >= 2 ? frame : this.buildSync('player', pid));
    }
  }

  private authedHosts(exclude?: WebSocket): { ws: WebSocket; att: Attachment }[] {
    const out: { ws: WebSocket; att: Attachment }[] = [];
    for (const ws of this.ctx.getWebSockets('host')) {
      if (ws === exclude) continue;
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att && att.authed !== false) out.push({ ws, att });
    }
    return out;
  }

  private pendingHosts(): number {
    let n = 0;
    for (const ws of this.ctx.getWebSockets('host')) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.authed === false) n += 1;
    }
    return n;
  }

  /** Every version-2 host learns how many host pages are open (P0-58). */
  private broadcastHostCount(exclude?: WebSocket): void {
    const hosts = this.authedHosts(exclude);
    const text = JSON.stringify({ t: 'hosts', count: hosts.length });
    for (const h of hosts) if ((h.att.v ?? 1) >= 2) { try { h.ws.send(text); } catch { /* gone */ } }
  }

  /** Kicked players' names stay reserved, so a removed student cannot rejoin under the same name. */
  private uniqueNick(nick: string, pid: string): string {
    const taken = new Set<string>();
    for (const p of this.players.values()) if (p.pid !== pid) taken.add(p.nick.toLowerCase());
    if (!taken.has(nick.toLowerCase())) return nick;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${nick} ${i}`.slice(0, LIMITS.nickChars + 4);
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${nick} ${randomHex(2)}`;
  }

  private allow(ws: WebSocket): boolean {
    const now = Date.now();
    let b = this.buckets.get(ws);
    if (!b) { b = { tokens: LIMITS.frameBurst, at: now }; this.buckets.set(ws, b); }
    b.tokens = Math.min(LIMITS.frameBurst, b.tokens + ((now - b.at) / 1000) * LIMITS.framesPerSecond);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private send(ws: WebSocket, frame: object | string): void {
    try { ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame)); } catch { /* socket gone */ }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.send(ws, { t: 'error', code, message });
  }

  /** Every host-bound frame goes through here: a host socket that has not authenticated gets nothing. */
  private broadcast(tag: 'host' | 'player', frame: object): void {
    const text = JSON.stringify(frame);
    for (const sock of this.ctx.getWebSockets(tag)) {
      const a = sock.deserializeAttachment() as Attachment | null;
      if (tag === 'player' && !a?.pid) continue; // connected but not joined yet
      if (tag === 'host' && a?.authed === false) continue;
      try { sock.send(text); } catch { /* socket gone */ }
    }
  }

  private scheduleTally(): void {
    if (this.tallyTimer) return;
    this.tallyTimer = setTimeout(() => {
      this.tallyTimer = null;
      const s = this.state;
      if (s && (s.phase === 'open' || s.phase === 'intro')) this.broadcast('host', this.tallyFrame());
    }, LIMITS.tallyIntervalMs);
  }

  private scheduleRoster(): void {
    if (this.rosterTimer) return;
    this.rosterTimer = setTimeout(() => {
      this.rosterTimer = null;
      if (this.state) this.flushRoster();
    }, LIMITS.rosterIntervalMs);
  }

  /**
   * Version-1 hosts get the full roster (as before protocol 2). Version-2 hosts
   * get only what changed: player_joined / player_updated / player_left, or a
   * full sync when this object has just woken and no longer knows what they hold.
   * "Changed" means a new name or a connection change: scores and answered
   * flags move for everyone on every question and reach the host through
   * tally, reveal and leaderboard instead, so they would only bloat the deltas.
   */
  private flushRoster(): void {
    const s = this.state!;
    const entries = this.roster();
    const playerCount = entries.length;
    const hosts = this.authedHosts();
    const v1 = hosts.filter(h => (h.att.v ?? 1) < 2);
    const v2 = hosts.filter(h => (h.att.v ?? 1) >= 2);
    if (v1.length) {
      const text = JSON.stringify({ t: 'roster', players: entries, playerCount });
      for (const h of v1) { try { h.ws.send(text); } catch { /* gone */ } }
    }
    if (v2.length) {
      const frames: object[] = [];
      if (!this.rosterBaseline) {
        frames.push(this.buildSync('host', null));
      } else {
        const joined: RosterEntry[] = [];
        const updated: RosterEntry[] = [];
        const seen = new Set<string>();
        for (const e of entries) {
          seen.add(e.pid);
          const was = this.rosterBaseline.get(e.pid);
          if (was === undefined) joined.push(e);
          else if (was !== rosterSig(e)) updated.push(e);
        }
        const left = [...this.rosterBaseline.keys()].filter(pid => !seen.has(pid));
        if (joined.length) frames.push({ t: 'player_joined', players: joined, playerCount });
        if (updated.length) frames.push({ t: 'player_updated', players: updated, playerCount });
        if (left.length) frames.push({ t: 'player_left', pids: left, playerCount });
      }
      for (const f of frames) {
        const text = JSON.stringify(f);
        for (const h of v2) { try { h.ws.send(text); } catch { /* gone */ } }
      }
    }
    this.rosterBaseline = new Map(entries.map(e => [e.pid, rosterSig(e)]));
    if (s.phase === 'lobby') this.broadcast('player', { t: 'lobby', playerCount, locked: s.locked });
  }

  private clearTimers(): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (this.tallyTimer) clearTimeout(this.tallyTimer);
    this.openTimer = this.closeTimer = this.tallyTimer = null;
  }

  /** Run a timer-driven transition; a failed save is reported to the host instead of thrown. */
  private guard(fn: () => Promise<void>): void {
    fn().catch(err => {
      if (err instanceof StorageError) this.storageFailed();
      else console.error(err);
    });
  }

  /** Tell the host plainly that saving failed (at most every 30 s). */
  private storageFailed(): void {
    const now = Date.now();
    if (now - this.storageWarnedAt < 30_000) return;
    this.storageWarnedAt = now;
    this.broadcast('host', { t: 'error', code: 'storage_full', message: STORAGE_MESSAGE });
  }

  private noteMiss(request: Request): void {
    const k = request.headers.get('X-HQ-IpKey');
    if (!k) return;
    const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('global'));
    dir.noteMiss(k).catch(() => { /* older Directory during a deploy */ });
  }

  private keys(): Promise<Keys | null> {
    if (!this.keysP) {
      const e = this.env;
      this.keysP = secretsProblem(e)
        ? Promise.resolve(null)
        : (async () => ({
            host: await deriveKey(e.SESSION_KEY!, e.HOST_PASSCODE!, 'host'),
            token: await deriveKey(e.SESSION_KEY!, e.HOST_PASSCODE!, 'token'),
            room: await deriveKey(e.SESSION_KEY!, e.HOST_PASSCODE!, 'room'),
          }))();
    }
    return this.keysP;
  }

  private async loadRoomKey(): Promise<void> {
    const s = this.state;
    const keys = await this.keys();
    this.roomKeyText = s && keys ? await roomKey(keys.room, s.pin) : null;
  }

  /** A self-verifying player token when secrets are set (the Worker can check it without waking this Room). */
  private async newPlayerToken(): Promise<string> {
    const keys = await this.keys();
    const s = this.state;
    return keys && s ? mintPlayerToken(keys.token, s.pin) : randomHex(16);
  }

  /** Record activity; persist it at most once a minute (a row write each time). */
  private touch(): void {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    s.lastActivity = now;
    if (now - this.lastPersistedActivity > ACTIVITY_PERSIST_MS) {
      try { this.persistActivity(now); } catch { /* reported by the write that matters */ }
    }
  }

  /** Every SQLite write goes through here, so a failure is recognisable and dev runs can count rows. */
  private write(query: string, ...params: SqlStorageValue[]): void {
    if (this.dev.failAfter !== null && this.dev.statements >= this.dev.failAfter) throw new StorageError('dev: injected write failure');
    this.dev.statements += 1;
    try {
      const cursor = this.sql.exec(query, ...params);
      if (this.dev.report) { cursor.toArray(); this.dev.rows += cursor.rowsWritten; }
    } catch (err) {
      throw new StorageError(err instanceof Error ? err.message : String(err));
    }
  }

  private persistActivity(now: number): void {
    this.write('UPDATE room SET last_activity = ? WHERE id = 1', now);
    this.lastPersistedActivity = now;
  }

  private persistRoom(): void {
    const s = this.state!;
    this.write(
      'UPDATE room SET phase = ?, q = ?, opens_at = ?, deadline = ?, settings = ?, locked = ?, last_activity = ?, phase_at = ? WHERE id = 1',
      s.phase, s.q, s.opensAt, s.deadline, JSON.stringify(s.settings), s.locked ? 1 : 0, s.lastActivity, s.phaseAt,
    );
    this.lastPersistedActivity = s.lastActivity;
  }

  private persistPlayer(p: Player): void {
    this.write(
      'UPDATE players SET nick = ?, kicked = ?, spins = ?, score = ?, elapsed_total = ?, streak = ?, answers = ?, renames = ? WHERE pid = ?',
      p.nick, p.kicked ? 1 : 0, p.spins, p.score, p.elapsedTotal, p.streak, JSON.stringify(p.answers), p.renames, p.pid,
    );
  }

  /** Rebuild in-memory state from SQLite (constructor / wake from hibernation). */
  private load(): void {
    const rows = this.sql.exec<RoomRow>('SELECT * FROM room WHERE id = 1').toArray();
    if (rows.length === 0) { this.state = null; return; }
    const r = rows[0];
    this.state = {
      pin: r.pin, hostToken: r.host_token, phase: r.phase, q: r.q, opensAt: r.opens_at, deadline: r.deadline,
      settings: normalizeSettings(JSON.parse(r.settings)), quiz: JSON.parse(r.quiz) as Quiz, locked: r.locked === 1,
      createdAt: r.created_at, lastActivity: r.last_activity, phaseAt: r.phase_at,
    };
    this.lastPersistedActivity = r.last_activity;
    this.players.clear();
    this.byToken.clear();
    this.joinIds.clear();
    this.answered.clear();
    this.rosterBaseline = null;
    const key = String(r.q);
    const now = Date.now();
    for (const row of this.sql.exec<PlayerRow>('SELECT * FROM players').toArray()) {
      const p: Player = {
        pid: row.pid, token: row.token, nick: row.nick, joinedAt: row.joined_at, kicked: row.kicked === 1, spins: row.spins,
        score: row.score, elapsedTotal: row.elapsed_total, streak: row.streak, answers: JSON.parse(row.answers) as Record<string, AnswerRecord>,
        renames: row.renames ?? 0, joinId: row.join_id ?? null,
      };
      this.players.set(p.pid, p);
      this.byToken.set(p.token, p.pid);
      if (p.joinId && now - p.joinedAt <= LIMITS.joinIdMs) this.joinIds.set(p.joinId, p.pid);
      if (!p.kicked && p.answers[key]) this.answered.add(p.pid);
    }
    this.eligible = null;
    // Re-arm in-memory timers if we woke up mid-question (deferred so sockets are available).
    const s = this.state;
    if (s.phase === 'intro' && s.opensAt != null) {
      this.openTimer = setTimeout(() => { this.guard(() => this.openQuestion()); }, Math.max(s.opensAt - now, 0));
    } else if (s.phase === 'open' && s.deadline != null) {
      this.closeTimer = setTimeout(() => { this.guard(() => this.closeQuestion()); }, Math.max(s.deadline + LIMITS.graceMs - now, 0));
    }
  }
}
