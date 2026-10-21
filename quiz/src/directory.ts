// The Directory is a single Durable Object (idFromName('global')) that maps
// 6-digit PINs to Room ids, enforces the daily caps on room creation, checks
// the host passcode with a wrong-guess limit, and counts PIN guesses.
// Rooms themselves use newUniqueId(), so each one is created in the Cloudflare
// data center nearest the teacher; a Durable Object never moves after
// creation, and this indirection keeps a recycled PIN from pinning a classroom
// to wherever that PIN was first used.
//
// Storage: four tiny SQLite tables. Nothing in here identifies a person:
// - creations.ip_hash: SHA-256 of IP + UTC date, gone after 48 hours;
// - lockouts.ip_key: keyed hash of the network (IPv4, or IPv6 /64), written
//   only when a passcode lockout starts and deleted by an alarm when it ends
//   (15 minutes);
// - auth_fails: the same hash with a wrong-passcode count, written only at the
//   4th wrong passcode from one network, so a restart cannot reset the count;
//   deleted 15 minutes later, the same way;
// - pins.library: which library (passcode) created the room.
// PIN-guess counters live in memory only, and the passcode rows are capped per
// day, so failures cannot spend the daily write allowance.
//
// Every RPC keeps its old call shape working (new parameters are optional),
// because for a few seconds after a deploy or rollback the Worker and this
// object can run different versions.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { AttemptLimiter, LIBRARY_ID, LOCKOUT, PIN_GUESS, WindowCounter, checkPasscode, secretsProblem } from './auth';
import { PIN_RE, randomInt } from './shared';

const PIN_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUSEKEEP_EVERY_MS = 60 * 60 * 1000;
/** Rooms are asked to check their idle-wipe alarm by the daily sweep: an alarm in the hour after 00:05 UTC. */
const ROOM_CHECK_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_KEY = '__all__';
/** Passcode rows (lockouts and counts) written per UTC day before they are kept in memory only. */
const LOCKOUT_WRITES_PER_DAY = 500;
/** A host is told at most this often that lookups for its PIN are being refused. */
const LIMIT_NOTICE_EVERY_MS = 60_000;

export type AllocateResult =
  | { ok: true; pin: string }
  | { ok: false; status: 429 | 503; error: 'too_many_rooms' | 'no_pin_available' };

export type LookupResult =
  | { roomId: string; library: string; limited?: undefined }
  /** notifyRoom: the PIN's room, when its host should hear about the refusal (at most once a minute). */
  | { limited: true; retryAfterMs: number; roomId?: undefined; notifyRoom?: string };

export interface LookupOptions {
  /** Keyed hash of the caller's network. Without it, nothing is counted or limited. */
  ipKey?: string;
  /** A player socket with no token: a new join. */
  tokenless?: boolean;
  /** The caller proved it belongs here (room key, valid player token, signed-in host). */
  bypass?: boolean;
  missLimit?: number;
  joinLimit?: number;
}

export type AuthResult =
  | { ok: true }
  | { ok: false; error: 'wrong_passcode'; remaining: number }
  | { ok: false; error: 'locked'; retryAfterMs: number }
  | { ok: false; error: 'not_configured' | 'passcode_too_short' };

export class Directory extends DurableObject<Env> {
  private sql: SqlStorage;
  private lastHousekeep = 0;
  private limiter = new AttemptLimiter();
  private misses = new WindowCounter(PIN_GUESS.windowMs);
  private joins = new WindowCounter(PIN_GUESS.windowMs);
  private lockoutWrites = { day: '', n: 0 };
  /** Networks with a saved auth_fails row, so a successful sign-in can delete it. */
  private savedFails = new Set<string>();
  private noticeAt = new Map<string, number>();
  private lastRoomCheckDay = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pins (
        pin TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS creations (
        ip_hash TEXT NOT NULL,
        day TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (ip_hash, day)
      );
      CREATE TABLE IF NOT EXISTS lockouts (
        ip_key TEXT PRIMARY KEY,
        until INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_fails (
        ip_key TEXT PRIMARY KEY,
        n INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
    `);
    // Added in protocol 2. Nullable, so the previous version's INSERT still works after a rollback.
    const cols = this.sql.exec<{ name: string }>('PRAGMA table_info(pins)').toArray().map(r => r.name);
    if (!cols.includes('library')) this.sql.exec('ALTER TABLE pins ADD COLUMN library TEXT');
    const now = Date.now();
    for (const r of this.sql.exec<{ ip_key: string; until: number }>('SELECT ip_key, until FROM lockouts WHERE until > ?', now).toArray()) {
      this.limiter.restore(r.ip_key, r.until);
    }
    for (const r of this.sql.exec<{ ip_key: string; n: number; at: number }>('SELECT ip_key, n, at FROM auth_fails WHERE at > ?', now - LOCKOUT.windowMs).toArray()) {
      this.limiter.restoreFailures(r.ip_key, r.n, r.at);
      this.savedFails.add(r.ip_key);
    }
  }

  /** Reserve a fresh PIN for `roomId`, applying the daily creation caps. */
  async allocate(roomId: string, ipHash: string, opts?: { library?: string; skipPerIp?: boolean }): Promise<AllocateResult> {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const perIp = Number(this.env.ROOM_CREATE_PER_IP_PER_DAY) || 30;
    const perDay = Number(this.env.ROOM_CREATE_PER_DAY) || 300;
    await this.housekeep(now);

    // Signed-in hosts (the passcode holder) skip the per-network cap; the whole-deployment cap stays.
    const ipCount = opts?.skipPerIp ? 0 : this.count(ipHash, day);
    const allCount = this.count(GLOBAL_KEY, day);
    if (ipCount >= perIp || allCount >= perDay) {
      return { ok: false, status: 429, error: 'too_many_rooms' };
    }

    for (let attempt = 0; attempt < 20; attempt++) {
      const pin = String(100000 + randomInt(900000));
      const exists = this.sql.exec('SELECT 1 FROM pins WHERE pin = ?', pin).toArray().length > 0;
      if (exists) continue;
      this.sql.exec('INSERT INTO pins (pin, room_id, created_at, library) VALUES (?, ?, ?, ?)', pin, roomId, now, opts?.library ?? null);
      if (!opts?.skipPerIp) this.bump(ipHash, day);
      this.bump(GLOBAL_KEY, day);
      return { ok: true, pin };
    }
    return { ok: false, status: 503, error: 'no_pin_available' };
  }

  /**
   * Resolve a PIN to a Room id, or null if unknown or expired. With `ipKey`,
   * also counts unknown PINs (misses) and new joins per network, and refuses
   * a network over either limit unless the caller proved it belongs here.
   */
  async lookup(pin: string, opts?: LookupOptions): Promise<LookupResult | null> {
    if (!PIN_RE.test(pin)) return null;
    const now = Date.now();
    await this.housekeep(now);
    const ipKey = opts?.ipKey;
    const live = () => {
      const rows = this.sql
        .exec<{ room_id: string; created_at: number; library: string | null }>('SELECT room_id, created_at, library FROM pins WHERE pin = ?', pin)
        .toArray();
      return rows.length === 0 || rows[0].created_at < now - PIN_TTL_MS ? null : rows[0];
    };
    if (ipKey && !opts?.bypass) {
      const missLimit = opts.missLimit ?? 100;
      const joinLimit = opts.joinLimit ?? 900;
      let retryAfterMs = 0;
      if (this.misses.count(ipKey, now) >= missLimit) retryAfterMs = this.misses.retryAfter(ipKey, missLimit, now);
      else if (opts.tokenless && this.joins.count(ipKey, now) >= joinLimit) retryAfterMs = this.joins.retryAfter(ipKey, joinLimit, now);
      if (retryAfterMs > 0) {
        // The caller is refused whether or not the PIN is live; only the PIN's host is told.
        const row = live();
        const last = this.noticeAt.get(pin) ?? 0;
        if (!row || now - last < LIMIT_NOTICE_EVERY_MS) return { limited: true, retryAfterMs };
        this.noticeAt.set(pin, now);
        if (this.noticeAt.size > 1000) this.noticeAt.delete(this.noticeAt.keys().next().value as string);
        return { limited: true, retryAfterMs, notifyRoom: row.room_id };
      }
    }
    const row = live();
    if (!row) {
      // A caller that proved it belongs (a valid player token after the game was wiped, or the room key) is not guessing.
      if (ipKey && !opts?.bypass) this.misses.add(ipKey, now);
      return null;
    }
    if (ipKey && opts?.tokenless && !opts.bypass) this.joins.add(ipKey, now);
    return { roomId: row.room_id, library: row.library ?? LIBRARY_ID };
  }

  /** Count a miss found later: an unknown player token, or a game that has ended. */
  async noteMiss(ipKey: string): Promise<void> {
    if (ipKey) this.misses.add(ipKey, Date.now());
  }

  /** Live rooms created by a library, newest first (for "Resume game" on another device). */
  async liveRooms(library: string): Promise<{ pin: string; roomId: string; createdAt: number }[]> {
    const now = Date.now();
    const rows = this.sql
      .exec<{ pin: string; room_id: string; created_at: number; library: string | null }>(
        'SELECT pin, room_id, created_at, library FROM pins WHERE created_at >= ? ORDER BY created_at DESC LIMIT 50',
        now - PIN_TTL_MS,
      )
      .toArray();
    return rows
      .filter(r => (r.library ?? LIBRARY_ID) === library)
      .slice(0, 10)
      .map(r => ({ pin: r.pin, roomId: r.room_id, createdAt: r.created_at }));
  }

  /**
   * Check a host passcode. The attempt is reserved before the check and
   * settled after it, in this one call, so parallel requests cannot test more
   * than 5 passcodes per network per 15 minutes. During a lockout nothing is
   * checked at all.
   */
  async authAttempt(ipKey: string, passcode: unknown): Promise<AuthResult> {
    const problem = secretsProblem(this.env);
    if (problem) return { ok: false, error: problem };
    const now = Date.now();
    const r = this.limiter.reserve(ipKey, now);
    if (!r.ok) return { ok: false, error: 'locked', retryAfterMs: r.retryAfterMs };
    let good = false;
    try {
      good = await checkPasscode(this.env.SESSION_KEY!, this.env.HOST_PASSCODE!, passcode);
    } catch {
      good = false;
    }
    const done = Date.now();
    const s = this.limiter.settle(ipKey, good, done);
    if (good) {
      if (this.savedFails.delete(ipKey)) this.persist(done, 'DELETE FROM auth_fails WHERE ip_key = ?', ipKey);
      return { ok: true };
    }
    // Save what a restart must not forget: a lockout, or one wrong passcode short of one.
    if (s.lockedUntil) {
      this.persist(done, 'INSERT INTO lockouts (ip_key, until) VALUES (?, ?) ON CONFLICT(ip_key) DO UPDATE SET until = excluded.until', ipKey, s.lockedUntil);
      await this.armSweep(done);
    } else if (s.failures === LOCKOUT.maxFailures - 1) {
      this.saveFails(ipKey, s.failures, done);
      await this.armSweep(done);
    }
    if (s.lockedUntil) return { ok: false, error: 'locked', retryAfterMs: s.lockedUntil - done };
    return { ok: false, error: 'wrong_passcode', remaining: s.remaining };
  }

  /** Free a PIN once its room has been wiped. Idempotent; a PIN re-issued to another room is left alone. */
  async release(pin: string, roomId: string): Promise<void> {
    await this.housekeep(Date.now());
    this.sql.exec('DELETE FROM pins WHERE pin = ? AND room_id = ?', pin, roomId);
  }

  /** Daily sweep (and passcode-row expiry) so the retention promise holds even when nobody creates rooms. */
  async alarm(): Promise<void> {
    const now = Date.now();
    // Only the daily sweep checks rooms, not the alarms that expire passcode rows.
    const d = new Date(now);
    const sweepAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 5);
    const day = d.toISOString().slice(0, 10);
    if (now >= sweepAt && now < sweepAt + ROOM_CHECK_WINDOW_MS && this.lastRoomCheckDay !== day) {
      this.lastRoomCheckDay = day;
      await this.checkRooms();
    }
    await this.housekeep(now, true);
  }

  /**
   * A Room re-arms its idle-wipe alarm after every change, but cannot when its
   * saves fail (the free daily write allowance ran out). The daily sweep runs just
   * after that allowance resets at 00:00 UTC and asks every room still holding a
   * PIN, expired ones included, to re-arm a lost alarm, so the wipe still happens.
   */
  private async checkRooms(): Promise<void> {
    const rows = this.sql.exec<{ room_id: string }>('SELECT room_id FROM pins ORDER BY created_at DESC LIMIT 500').toArray();
    for (let i = 0; i < rows.length; i += 6) {
      await Promise.all(rows.slice(i, i + 6).map(async r => {
        try { await this.env.ROOM.get(this.env.ROOM.idFromString(r.room_id)).checkAlarm(); } catch { /* an older Room, or gone */ }
      }));
    }
  }

  /** A passcode-limit write (lockout or count), capped per day; past the cap, memory only. */
  private persist(now: number, query: string, ...params: SqlStorageValue[]): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.lockoutWrites.day !== day) this.lockoutWrites = { day, n: 0 };
    if (this.lockoutWrites.n >= LOCKOUT_WRITES_PER_DAY) return;
    this.lockoutWrites.n += 1;
    try { this.sql.exec(query, ...params); } catch { /* memory still holds it */ }
  }

  private saveFails(key: string, n: number, now: number): void {
    this.persist(now, 'INSERT INTO auth_fails (ip_key, n, at) VALUES (?, ?, ?) ON CONFLICT(ip_key) DO UPDATE SET n = excluded.n, at = excluded.at', key, n, now);
    this.savedFails.add(key);
  }

  /**
   * The alarm runs at the next daily sweep, or when the earliest passcode row
   * expires if that is sooner, so those rows are deleted when their 15 minutes end.
   */
  private async armSweep(now: number): Promise<void> {
    const d = new Date(now);
    let next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5);
    const lock = this.sql.exec<{ t: number | null }>('SELECT MIN(until) AS t FROM lockouts').toArray()[0]?.t;
    const fail = this.sql.exec<{ t: number | null }>('SELECT MIN(at) AS t FROM auth_fails').toArray()[0]?.t;
    if (lock != null) next = Math.min(next, lock + 1000);
    if (fail != null) next = Math.min(next, fail + LOCKOUT.windowMs + 1000);
    next = Math.max(next, now + 1000);
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > next) await this.ctx.storage.setAlarm(next);
  }

  /**
   * Delete expired PINs, creation counters and lockouts. Counters are kept for
   * today and yesterday only, so a row written on day D is gone by 00:05 UTC
   * on D+2, i.e. within 48 hours (PROTOCOL.md §10). Runs at most hourly on
   * traffic, plus from a daily alarm scheduled for just after UTC midnight.
   */
  private async housekeep(now: number, force = false): Promise<void> {
    if (!force && now - this.lastHousekeep < HOUSEKEEP_EVERY_MS) return;
    this.lastHousekeep = now;
    this.sql.exec('DELETE FROM pins WHERE created_at < ?', now - PIN_TTL_MS);
    const yesterday = new Date(now - DAY_MS).toISOString().slice(0, 10);
    this.sql.exec('DELETE FROM creations WHERE day < ?', yesterday);
    this.sql.exec('DELETE FROM lockouts WHERE until <= ?', now);
    this.sql.exec('DELETE FROM auth_fails WHERE at <= ?', now - LOCKOUT.windowMs);
    await this.armSweep(now);
  }

  private count(key: string, day: string): number {
    const rows = this.sql.exec<{ count: number }>('SELECT count FROM creations WHERE ip_hash = ? AND day = ?', key, day).toArray();
    return rows.length ? rows[0].count : 0;
  }

  private bump(key: string, day: string): void {
    this.sql.exec(
      'INSERT INTO creations (ip_hash, day, count) VALUES (?, ?, 1) ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1',
      key, day,
    );
  }
}
