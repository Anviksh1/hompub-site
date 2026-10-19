// The Room is the referee for one game: it owns every WebSocket in the room,
// keeps all authoritative state in its own SQLite database, stamps and scores
// every answer on its own clock, and never sends the answer key to a player.
// One instance per PIN; created where the host's POST /api/room landed.
//
// It uses the WebSocket Hibernation API, so between questions (no pending
// timers) the object is evicted from memory while the sockets stay attached
// at the edge; the next frame re-runs the constructor, which reloads state
// from SQLite. Per-socket attachments carry only {role, pid}.
//
// See ../PROTOCOL.md for every frame and transition implemented here.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import {
  LIMITS,
  csvEscape,
  isProfane,
  letterFor,
  mergeSettings,
  randomHex,
  sanitizeNick,
  scoreAnswer,
  spinName,
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

interface Attachment { role: 'host' | 'player'; pid: string | null }

type Frame = Record<string, unknown> & { t: string };
type Timer = ReturnType<typeof setTimeout>;

const ACTIVITY_PERSIST_MS = 60_000;

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
    answers TEXT NOT NULL DEFAULT '{}'
  );
`;

export class Room extends DurableObject<Env> {
  private sql: SqlStorage;
  private state: RoomState | null = null;
  private players = new Map<string, Player>();
  private byToken = new Map<string, string>();
  /** pids that have answered the current question (rebuilt from SQLite on wake). */
  private answered = new Set<string>();
  /** pids connected when the current question opened; null after a wake. */
  private eligible: Set<string> | null = null;
  private openTimer: Timer | null = null;
  private closeTimer: Timer | null = null;
  private tallyTimer: Timer | null = null;
  private rosterTimer: Timer | null = null;
  private buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();
  private lastPersistedActivity = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => this.load());
  }

  // ----------------------------------------------------------------- RPC

  /** Called once by the Worker right after allocation. */
  async init(pin: string, quiz: Quiz, settings: Settings): Promise<{ hostToken: string }> {
    if (this.state) throw new Error('room already initialised');
    const now = Date.now();
    const hostToken = randomHex(16);
    this.sql.exec(
      `INSERT INTO room (id, pin, host_token, phase, q, opens_at, deadline, settings, quiz, locked, created_at, last_activity, phase_at)
       VALUES (1, ?, ?, 'lobby', -1, NULL, NULL, ?, ?, 0, ?, ?, ?)`,
      pin, hostToken, JSON.stringify(settings), JSON.stringify(quiz), now, now, now,
    );
    this.state = {
      pin, hostToken, phase: 'lobby', q: -1, opensAt: null, deadline: null,
      settings, quiz, locked: false, createdAt: now, lastActivity: now, phaseAt: now,
    };
    this.lastPersistedActivity = now;
    await this.armAlarm();
    return { hostToken };
  }

  /** Public, answer-key-free summary for the join page. */
  async summary(): Promise<{ pin: string; phase: Phase; playerCount: number; locked: boolean; lateJoin: boolean; nicknameMode: string; title: string } | null> {
    const s = this.state;
    if (!s) return null;
    return {
      pin: s.pin, phase: s.phase, playerCount: this.activePlayers().length,
      locked: s.locked, lateJoin: s.settings.lateJoin, nicknameMode: s.settings.nicknameMode, title: s.quiz.title,
    };
  }

  // -------------------------------------------------------- WebSocket upgrade

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const token = url.searchParams.get('token') || '';
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const respond = () => new Response(null, { status: 101, webSocket: client });
    const reject = (code: number, reason: string) => {
      server.accept();
      server.close(code, reason);
      return respond();
    };

    const s = this.state;
    if (!s) return reject(4004, 'Room not found');

    if (role === 'host') {
      if (token.length === 0 || token !== s.hostToken) return reject(4001, 'Bad host token');
      this.accept(server, { role: 'host', pid: null });
      this.touch();
      this.send(server, this.buildSync('host', null));
      // A host taking over after the game ended still needs the results file.
      if (s.phase === 'ended') this.send(server, this.resultsFrame());
      return respond();
    }

    if (role !== 'player') return reject(4000, 'Unknown role');

    if (token) {
      const pid = this.byToken.get(token);
      if (!pid) return reject(4004, 'Unknown player token; join again');
      const p = this.players.get(pid)!;
      if (p.kicked) {
        server.accept();
        server.send(JSON.stringify({ t: 'kicked' }));
        server.close(4003, 'Removed by the host');
        return respond();
      }
      this.accept(server, { role: 'player', pid });
      this.touch();
      this.send(server, this.buildSync('player', pid));
      this.scheduleRoster();
      return respond();
    }

    const refusal = this.joinRefusal();
    if (refusal) return reject(refusal.code, refusal.reason);
    // Pending player: joins with a `join` frame.
    this.accept(server, { role: 'player', pid: null });
    this.touch();
    return respond();
  }

  private accept(ws: WebSocket, att: Attachment): void {
    this.ctx.acceptWebSocket(ws, [att.role]);
    ws.serializeAttachment(att);
  }

  private joinRefusal(): { code: number; reason: string } | null {
    const s = this.state!;
    if (s.phase === 'podium' || s.phase === 'ended') return { code: 4004, reason: 'This game has ended' };
    if (s.locked) return { code: 4010, reason: 'The host has locked this game' };
    if (s.phase !== 'lobby' && !s.settings.lateJoin) return { code: 4010, reason: 'Late joining is off for this game' };
    const max = Number(this.env.MAX_PLAYERS) || 250;
    if (this.activePlayers().length >= max) return { code: 4009, reason: 'This game is full' };
    return null;
  }

  // ------------------------------------------------------- socket handlers

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) { ws.close(4000, 'No session'); return; }
    const size = typeof message === 'string' ? message.length : message.byteLength;
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
    this.touch();

    if (att.role === 'host') await this.handleHost(ws, frame);
    else this.handlePlayer(ws, att, frame);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    try { ws.close(code, reason); } catch { /* already closed */ }
    this.scheduleRoster();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try { ws.close(1011, 'Socket error'); } catch { /* ignore */ }
    this.scheduleRoster();
  }

  // ------------------------------------------------------------- player side

  private handlePlayer(ws: WebSocket, att: Attachment, frame: Frame): void {
    const s = this.state!;
    switch (frame.t) {
      case 'join': {
        if (att.pid) {
          // Already joined: allow re-spinning the name before the first answer (max 3 spins).
          const p = this.players.get(att.pid);
          if (p && frame.spin === true && Object.keys(p.answers).length === 0 && p.spins < 3) {
            p.nick = this.uniqueNick(spinName(), p.pid);
            p.spins += 1;
            this.persistPlayer(p);
            this.send(ws, this.buildSync('player', p.pid));
            this.scheduleRoster();
          } else {
            this.sendError(ws, 'already_joined', 'You have already joined');
          }
          return;
        }
        const refusal = this.joinRefusal();
        if (refusal) { ws.close(refusal.code, refusal.reason); return; }

        let nick = '';
        let spins = 0;
        if (s.settings.nicknameMode === 'spin' || frame.spin === true) {
          nick = spinName();
          spins = 1;
        } else {
          nick = sanitizeNick(frame.nick);
          if (nick.length === 0 || isProfane(nick)) nick = spinName();
        }
        const pid = `p_${randomHex(4)}`;
        nick = this.uniqueNick(nick, pid);
        const token = randomHex(16);
        const now = Date.now();
        const p: Player = { pid, token, nick, joinedAt: now, kicked: false, spins, score: 0, elapsedTotal: 0, streak: 0, answers: {} };
        this.sql.exec(
          'INSERT INTO players (pid, token, nick, joined_at, kicked, spins, score, elapsed_total, streak, answers) VALUES (?, ?, ?, ?, 0, ?, 0, 0, 0, ?)',
          pid, token, nick, now, spins, '{}',
        );
        this.players.set(pid, p);
        this.byToken.set(token, pid);
        att.pid = pid;
        ws.serializeAttachment(att);
        this.send(ws, { t: 'welcome', pid, token, nick, pin: s.pin });
        this.send(ws, this.buildSync('player', pid));
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
    if (s.phase === 'intro' && s.opensAt != null && Date.now() >= s.opensAt && q === s.q) void this.openQuestion();

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

    p.answers[String(q)] = { c: choice, ms: elapsed, p: points };
    p.score += points;
    if (correct) { p.elapsedTotal += elapsed; p.streak += 1; } else { p.streak = 0; }
    this.persistPlayer(p); // persist before ack: nothing acknowledged is ever lost
    this.answered.add(pid);
    ack(true);
    this.scheduleTally();

    if (s.settings.earlyClose && this.eligible && this.eligible.size > 0) {
      let all = true;
      for (const e of this.eligible) if (!this.answered.has(e)) { all = false; break; }
      if (all) this.closeQuestion();
    }
  }

  // --------------------------------------------------------------- host side

  private async handleHost(ws: WebSocket, frame: Frame): Promise<void> {
    const s = this.state!;
    const badPhase = (what: string) => this.sendError(ws, 'bad_phase', `Cannot ${what} during ${s.phase}`);
    switch (frame.t) {
      case 'start':
        if (s.phase !== 'lobby') return badPhase('start');
        await this.startQuestion(0);
        return;
      case 'next':
        if (s.phase !== 'closed') return badPhase('go to the next question');
        if (s.q + 1 < s.quiz.questions.length) await this.startQuestion(s.q + 1);
        else await this.podium();
        return;
      case 'close':
        if (s.phase !== 'open') return badPhase('close');
        await this.closeQuestion();
        return;
      case 'end':
        if (s.phase === 'ended') return badPhase('end');
        await this.end();
        return;
      case 'ack_results':
        if (s.phase !== 'ended') return badPhase('wipe');
        await this.wipe();
        return;
      case 'kick': {
        const pid = typeof frame.pid === 'string' ? frame.pid : '';
        const p = this.players.get(pid);
        if (!p) return this.sendError(ws, 'unknown_player', 'No such player');
        p.kicked = true;
        this.persistPlayer(p);
        this.answered.delete(pid);
        this.eligible?.delete(pid);
        for (const sock of this.ctx.getWebSockets('player')) {
          const a = sock.deserializeAttachment() as Attachment | null;
          if (a?.pid === pid) {
            this.send(sock, { t: 'kicked' });
            try { sock.close(4003, 'Removed by the host'); } catch { /* ignore */ }
          }
        }
        this.scheduleRoster();
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
        this.broadcast('host', { t: 'settings', settings: s.settings, locked: s.locked });
        if (before.showOnDevices !== s.settings.showOnDevices) {
          // Phones may need the question text they did not have a moment ago: send a snapshot.
          for (const sock of this.ctx.getWebSockets('player')) {
            const a = sock.deserializeAttachment() as Attachment | null;
            if (a?.pid) this.send(sock, this.buildSync('player', a.pid));
          }
        }
        return;
      }
      default:
        this.sendError(ws, 'unknown_type', `Unknown frame type ${frame.t}`);
    }
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
    this.openTimer = setTimeout(() => { void this.openQuestion(); }, LIMITS.introMs);
    await this.armAlarm();
  }

  private async openQuestion(): Promise<void> {
    const s = this.state;
    if (!s || s.phase !== 'intro') return;
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
    this.closeTimer = setTimeout(() => { void this.closeQuestion(); }, wait);
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
    this.answered.clear();
    this.eligible = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    if (s) {
      try {
        const dir = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('global'));
        await dir.release(s.pin);
      } catch { /* the Directory expires PINs on its own after 24 h */ }
    }
  }

  // ------------------------------------------------------------------ alarm

  async alarm(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    if (s.phase === 'intro' && s.opensAt != null && now >= s.opensAt) await this.openQuestion();
    if (s.phase === 'open' && s.deadline != null && now >= s.deadline + LIMITS.graceMs) await this.closeQuestion();
    if (!this.state) return;
    const ttl = this.ttlAt();
    if (now >= ttl) {
      const finished = s.phase === 'podium' || s.phase === 'ended';
      if (finished || this.ctx.getWebSockets().length === 0) {
        await this.wipe();
        return;
      }
      // Sockets are still attached: treat that as activity and look again later.
      s.lastActivity = now;
      this.persistActivity(now);
    }
    await this.armAlarm();
  }

  private ttlAt(): number {
    const s = this.state!;
    if (s.phase === 'podium' || s.phase === 'ended') return s.phaseAt + LIMITS.ttlFinishedMs;
    return Math.max(s.lastActivity, this.lastPersistedActivity) + LIMITS.ttlActiveMs;
  }

  private async armAlarm(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    let next = this.ttlAt();
    if (s.phase === 'intro' && s.opensAt != null) next = Math.min(next, s.opensAt + 500);
    if (s.phase === 'open' && s.deadline != null) next = Math.min(next, s.deadline + LIMITS.graceMs + 500);
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
      t: 'sync', serverNow: now, role, pin: s.pin, title: s.quiz.title,
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
          streak: p.streak, answered: !!ans, choice: ans ? ans.c : null,
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

  private roster(): object[] {
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
    const sorted = this.sortedPlayers();
    sorted.forEach((p, i) => {
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
      lines.push([i + 1, csvEscape(p.nick), p.score, correct, answered, ...cells].join(','));
    });
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

  private uniqueNick(nick: string, pid: string): string {
    const taken = new Set<string>();
    for (const p of this.players.values()) if (p.pid !== pid && !p.kicked) taken.add(p.nick.toLowerCase());
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

  private broadcast(tag: 'host' | 'player', frame: object): void {
    const text = JSON.stringify(frame);
    for (const sock of this.ctx.getWebSockets(tag)) {
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
      const s = this.state;
      if (!s) return;
      const playerCount = this.activePlayers().length;
      this.broadcast('host', { t: 'roster', players: this.roster(), playerCount });
      if (s.phase === 'lobby') this.broadcast('player', { t: 'lobby', playerCount, locked: s.locked });
    }, LIMITS.rosterIntervalMs);
  }

  private clearTimers(): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (this.tallyTimer) clearTimeout(this.tallyTimer);
    this.openTimer = this.closeTimer = this.tallyTimer = null;
  }

  /** Record activity; persist it at most once a minute (a row write each time). */
  private touch(): void {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    s.lastActivity = now;
    if (now - this.lastPersistedActivity > ACTIVITY_PERSIST_MS) this.persistActivity(now);
  }

  private persistActivity(now: number): void {
    this.sql.exec('UPDATE room SET last_activity = ? WHERE id = 1', now);
    this.lastPersistedActivity = now;
  }

  private persistRoom(): void {
    const s = this.state!;
    this.sql.exec(
      'UPDATE room SET phase = ?, q = ?, opens_at = ?, deadline = ?, settings = ?, locked = ?, last_activity = ?, phase_at = ? WHERE id = 1',
      s.phase, s.q, s.opensAt, s.deadline, JSON.stringify(s.settings), s.locked ? 1 : 0, s.lastActivity, s.phaseAt,
    );
    this.lastPersistedActivity = s.lastActivity;
  }

  private persistPlayer(p: Player): void {
    this.sql.exec(
      'UPDATE players SET nick = ?, kicked = ?, spins = ?, score = ?, elapsed_total = ?, streak = ?, answers = ? WHERE pid = ?',
      p.nick, p.kicked ? 1 : 0, p.spins, p.score, p.elapsedTotal, p.streak, JSON.stringify(p.answers), p.pid,
    );
  }

  /** Rebuild in-memory state from SQLite (constructor / wake from hibernation). */
  private load(): void {
    const rows = this.sql.exec<RoomRow>('SELECT * FROM room WHERE id = 1').toArray();
    if (rows.length === 0) { this.state = null; return; }
    const r = rows[0];
    this.state = {
      pin: r.pin, hostToken: r.host_token, phase: r.phase, q: r.q, opensAt: r.opens_at, deadline: r.deadline,
      settings: JSON.parse(r.settings) as Settings, quiz: JSON.parse(r.quiz) as Quiz, locked: r.locked === 1,
      createdAt: r.created_at, lastActivity: r.last_activity, phaseAt: r.phase_at,
    };
    this.lastPersistedActivity = r.last_activity;
    this.players.clear();
    this.byToken.clear();
    this.answered.clear();
    const key = String(r.q);
    for (const row of this.sql.exec<PlayerRow>('SELECT * FROM players').toArray()) {
      const p: Player = {
        pid: row.pid, token: row.token, nick: row.nick, joinedAt: row.joined_at, kicked: row.kicked === 1, spins: row.spins,
        score: row.score, elapsedTotal: row.elapsed_total, streak: row.streak, answers: JSON.parse(row.answers) as Record<string, AnswerRecord>,
      };
      this.players.set(p.pid, p);
      this.byToken.set(p.token, p.pid);
      if (!p.kicked && p.answers[key]) this.answered.add(p.pid);
    }
    this.eligible = null;
    // Re-arm in-memory timers if we woke up mid-question (deferred so sockets are available).
    const s = this.state;
    const now = Date.now();
    if (s.phase === 'intro' && s.opensAt != null) {
      this.openTimer = setTimeout(() => { void this.openQuestion(); }, Math.max(s.opensAt - now, 0));
    } else if (s.phase === 'open' && s.deadline != null) {
      this.closeTimer = setTimeout(() => { void this.closeQuestion(); }, Math.max(s.deadline + LIMITS.graceMs - now, 0));
    }
  }
}
