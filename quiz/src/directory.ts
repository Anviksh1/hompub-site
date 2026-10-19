// The Directory is a single Durable Object (idFromName('global')) that maps
// 6-digit PINs to Room ids and enforces the per-IP and global daily caps on
// room creation. Rooms themselves use newUniqueId(), so each one is created
// in the Cloudflare data center nearest the teacher; a Durable Object never
// moves after creation, and this indirection keeps a recycled PIN from
// pinning a classroom to wherever that PIN was first used.
//
// Storage: two tiny SQLite tables, trimmed on every allocation. Nothing in
// here identifies a person: ip_hash is a SHA-256 of the IP plus the UTC date,
// so it cannot be linked across days and is useless after 48 hours.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { PIN_RE, randomInt } from './shared';

const PIN_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUSEKEEP_EVERY_MS = 60 * 60 * 1000;
const GLOBAL_KEY = '__all__';

export type AllocateResult =
  | { ok: true; pin: string }
  | { ok: false; status: 429 | 503; error: 'too_many_rooms' | 'no_pin_available' };

export class Directory extends DurableObject<Env> {
  private sql: SqlStorage;
  private lastHousekeep = 0;

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
    `);
  }

  /** Reserve a fresh PIN for `roomId`, applying the daily creation caps. */
  async allocate(roomId: string, ipHash: string): Promise<AllocateResult> {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const perIp = Number(this.env.ROOM_CREATE_PER_IP_PER_DAY) || 30;
    const perDay = Number(this.env.ROOM_CREATE_PER_DAY) || 300;
    await this.housekeep(now);

    const ipCount = this.count(ipHash, day);
    const allCount = this.count(GLOBAL_KEY, day);
    if (ipCount >= perIp || allCount >= perDay) {
      return { ok: false, status: 429, error: 'too_many_rooms' };
    }

    for (let attempt = 0; attempt < 20; attempt++) {
      const pin = String(100000 + randomInt(900000));
      const exists = this.sql.exec('SELECT 1 FROM pins WHERE pin = ?', pin).toArray().length > 0;
      if (exists) continue;
      this.sql.exec('INSERT INTO pins (pin, room_id, created_at) VALUES (?, ?, ?)', pin, roomId, now);
      this.bump(ipHash, day);
      this.bump(GLOBAL_KEY, day);
      return { ok: true, pin };
    }
    return { ok: false, status: 503, error: 'no_pin_available' };
  }

  /** Resolve a PIN to a Room id, or null if unknown or expired. */
  async lookup(pin: string): Promise<{ roomId: string } | null> {
    if (!PIN_RE.test(pin)) return null;
    await this.housekeep(Date.now());
    const rows = this.sql
      .exec<{ room_id: string; created_at: number }>('SELECT room_id, created_at FROM pins WHERE pin = ?', pin)
      .toArray();
    if (rows.length === 0) return null;
    if (rows[0].created_at < Date.now() - PIN_TTL_MS) return null;
    return { roomId: rows[0].room_id };
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

  /**
   * Delete expired PINs and creation counters. Counters are kept for today and
   * yesterday only, so a row written on day D is gone by 00:05 UTC on D+2, i.e.
   * within 48 hours (PROTOCOL.md §10). Runs at most hourly on traffic, plus
   * from a daily alarm scheduled for just after UTC midnight.
   */
  private async housekeep(now: number, force = false): Promise<void> {
    if (!force && now - this.lastHousekeep < HOUSEKEEP_EVERY_MS) return;
    this.lastHousekeep = now;
    this.sql.exec('DELETE FROM pins WHERE created_at < ?', now - PIN_TTL_MS);
    const yesterday = new Date(now - DAY_MS).toISOString().slice(0, 10);
    this.sql.exec('DELETE FROM creations WHERE day < ?', yesterday);
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
