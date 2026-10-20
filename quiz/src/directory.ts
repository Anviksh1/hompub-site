// The Directory is a single Durable Object (idFromName('global')) that maps
// 6-digit PINs to Room ids, enforces the daily caps on room creation, checks
// the host passcode with a wrong-guess limit, and counts PIN guesses.
// Rooms themselves use newUniqueId(), so each one is created in the Cloudflare
// data center nearest the teacher; a Durable Object never moves after
// creation, and this indirection keeps a recycled PIN from pinning a classroom
// to wherever that PIN was first used.
//
// Storage: three tiny SQLite tables. Nothing in here identifies a person:
// - creations.ip_hash: SHA-256 of IP + UTC date, gone after 48 hours;
// - lockouts.ip_key: SHA-256 of the network (IPv4, or IPv6 /64), written only
//   when a passcode lockout starts and deleted when it ends (15 minutes);
// - pins.library: which library (passcode) created the room.
// PIN-guess and wrong-passcode counters live in memory only, so failures never
// spend the daily write allowance.
//
// Every RPC keeps its old call shape working (new parameters are optional),
// because for a few seconds after a deploy or rollback the Worker and this
// object can run different versions.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { AttemptLimiter, LIBRARY_ID, PIN_GUESS, WindowCounter, checkPasscode, secretsProblem } from './auth';
import { PIN_RE, randomInt } from './shared';

const PIN_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUSEKEEP_EVERY_MS = 60 * 60 * 1000;
const GLOBAL_KEY = '__all__';
/** Lockout rows written per UTC day before lockouts are kept in memory only. */
const LOCKOUT_WRITES_PER_DAY = 500;

export type AllocateResult =
  | { ok: true; pin: string }
  | { ok: false; status: 429 | 503; error: 'too_many_rooms' | 'no_pin_available' };

export type LookupResult =
  | { roomId: string; library: string; limited?: undefined }
  | { limited: true; retryAfterMs: number; roomId?: undefined };

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
    `);
    // Added in protocol 2. Nullable, so the previous version's INSERT still works after a rollback.
    const cols = this.sql.exec<{ name: string }>('PRAGMA table_info(pins)').toArray().map(r => r.name);
    if (!cols.includes('library')) this.sql.exec('ALTER TABLE pins ADD COLUMN library TEXT');
    const now = Date.now();
    for (const r of this.sql.exec<{ ip_key: string; until: number }>('SELECT ip_key, until FROM lockouts WHERE until > ?', now).toArray()) {
      this.limiter.restore(r.ip_key, r.until);
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
    if (ipKey && !opts?.bypass) {
      const missLimit = opts.missLimit ?? 100;
      const joinLimit = opts.joinLimit ?? 900;
      if (this.misses.count(ipKey, now) >= missLimit) return { limited: true, retryAfterMs: this.misses.retryAfter(ipKey, missLimit, now) };
      if (opts.tokenless && this.joins.count(ipKey, now) >= joinLimit) return { limited: true, retryAfterMs: this.joins.retryAfter(ipKey, joinLimit, now) };
    }
    const rows = this.sql
      .exec<{ room_id: string; created_at: number; library: string | null }>('SELECT room_id, created_at, library FROM pins WHERE pin = ?', pin)
      .toArray();
    if (rows.length === 0 || rows[0].created_at < now - PIN_TTL_MS) {
      if (ipKey) this.misses.add(ipKey, now);
      return null;
    }
    if (ipKey && opts?.tokenless && !opts.bypass) this.joins.add(ipKey, now);
    return { roomId: rows[0].room_id, library: rows[0].library ?? LIBRARY_ID };
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
    if (good) return { ok: true };
    if (s.lockedUntil) {
      this.persistLockout(ipKey, s.lockedUntil, done);
      return { ok: false, error: 'locked', retryAfterMs: s.lockedUntil - done };
    }
    return { ok: false, error: 'wrong_passcode', remaining: s.remaining };
  }

  /** Free a PIN once its room has been wiped. Idempotent; a PIN re-issued to another room is left alone. */
  async release(pin: string, roomId: string): Promise<void> {
    await this.housekeep(Date.now());
    this.sql.exec('DELETE FROM pins WHERE pin = ? AND room_id = ?', pin, roomId);
  }

  /** Daily sweep so the retention promise holds even when nobody creates rooms. */
  async alarm(): Promise<void> {
    await this.housekeep(Date.now(), true);
  }

  /** One row per lockout, so a restart does not lift it; capped per day, then memory only. */
  private persistLockout(ipKey: string, until: number, now: number): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.lockoutWrites.day !== day) this.lockoutWrites = { day, n: 0 };
    if (this.lockoutWrites.n >= LOCKOUT_WRITES_PER_DAY) return;
    this.lockoutWrites.n += 1;
    try {
      this.sql.exec('INSERT INTO lockouts (ip_key, until) VALUES (?, ?) ON CONFLICT(ip_key) DO UPDATE SET until = excluded.until', ipKey, until);
    } catch { /* memory still holds the lockout */ }
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
    this.sql.exec('DELETE FROM lockouts WHERE until < ?', now);
    const d = new Date(now);
    const nextSweep = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5);
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > nextSweep) await this.ctx.storage.setAlarm(nextSweep);
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
