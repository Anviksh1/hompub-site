import type { Room } from './room';
import type { Directory } from './directory';

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  DIRECTORY: DurableObjectNamespace<Directory>;
  ASSETS: Fetcher;
  ALLOWED_ORIGINS: string;
  MAX_PLAYERS: string;
  ROOM_CREATE_PER_IP_PER_DAY: string;
  ROOM_CREATE_PER_DAY: string;
  /** Unknown-PIN lookups per network per 10 minutes before lookups are refused (default 100). */
  PIN_MISS_LIMIT?: string;
  /** Secret: what the teacher types to sign in. At least 12 characters. */
  HOST_PASSCODE?: string;
  /** Secret: 32 random bytes that key every cookie, header and token MAC. */
  SESSION_KEY?: string;
  /** Optional secret that keys the hashes kept for abuse limits. */
  IP_HASH_KEY?: string;
  // Dev-only switches. Read only when DEV_MODE is "1", and set only in .dev.vars
  // (test/config.test.mjs fails if any appears in wrangler.jsonc).
  DEV_MODE?: string;
  /** Multiply every idle-wipe period by this (e.g. 0.001 turns 2 h into 7.2 s). */
  DEV_TTL_SCALE?: string;
  /** Make every SQLite write after this many fail, to test the quota-exhausted message. */
  DEV_FAIL_WRITES_AFTER?: string;
  /** Count rows written per room and report them to the host as a `dev_stats` frame. */
  DEV_REPORT_ROWS?: string;
  /** Take the client IP from this request header (the load harness sets one per bot). */
  DEV_CLIENT_IP_HEADER?: string;
  /** Do not vouch for signed-in hosts, so the {t:'auth'} first-frame path can be tested. */
  DEV_SKIP_HOST_VOUCH?: string;
}

export function devOn(env: Env): boolean {
  return env.DEV_MODE === '1';
}
