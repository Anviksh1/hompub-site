// Host sign-in, session cookies, the Origin rule, signed values and the
// attempt counters. Pure functions and plain classes only: no imports, no
// cloudflare:workers, so `node --test` can load this file directly.
//
// Secrets: HOST_PASSCODE (what the teacher types) and SESSION_KEY (32 random
// bytes, never typed). Every key used here is HMAC(SESSION_KEY, purpose|passcode),
// so changing either secret invalidates every cookie, host header and token MAC,
// and a stolen cookie cannot be brute-forced back to the passcode without
// SESSION_KEY. Every comparison of a secret-derived value is constant-time:
// crypto.subtle.verify for full MACs, and equalBytes() for truncated ones.

export const SESSION_COOKIE = '__Host-hq_session';
export const LIBRARY_ID = 'main';
export const PASSCODE_MIN_CHARS = 12;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SESSION = {
  ttlMs: 30 * DAY,          // normal sign-in, renewed after half of it has passed
  maxMs: 90 * DAY,          // never renewed past this age
  sharedIdleMs: 4 * HOUR,   // "This is a shared computer": browser-session cookie, idle limit
  sharedMaxMs: 12 * HOUR,   // ... and never renewed past this age
  hostHeaderMs: 60_000,     // lifetime of the Worker → Room signed host header
} as const;

export const LOCKOUT = { maxFailures: 5, windowMs: 15 * MINUTE } as const;
export const PIN_GUESS = { windowMs: 10 * MINUTE } as const;

const enc = new TextEncoder();

// ------------------------------------------------------------------ bytes

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(text: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})*$/.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Constant-time equality for two byte arrays of the same expected length. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

// ------------------------------------------------------------------- keys

export type Purpose = 'pass' | 'session' | 'host' | 'token' | 'room';

/** Secrets present and usable? The passcode must be long enough to resist guessing. */
export function secretsProblem(env: { HOST_PASSCODE?: string; SESSION_KEY?: string }): 'not_configured' | 'passcode_too_short' | null {
  if (!env.HOST_PASSCODE || !env.SESSION_KEY) return 'not_configured';
  if (Array.from(env.HOST_PASSCODE).length < PASSCODE_MIN_CHARS) return 'passcode_too_short';
  return null;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/** HMAC-SHA256 key for one purpose: HMAC(SESSION_KEY, `hq-v1|purpose|passcode`), imported as a key. */
export function deriveKey(sessionSecret: string, passcode: string, purpose: Purpose): Promise<CryptoKey> {
  const cacheKey = `${purpose}\u0000${sessionSecret}\u0000${passcode}`;
  let p = keyCache.get(cacheKey);
  if (!p) {
    p = (async () => {
      const base = await crypto.subtle.importKey('raw', enc.encode(sessionSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const material = new Uint8Array(await crypto.subtle.sign('HMAC', base, enc.encode(`hq-v1|${purpose}|${passcode}`)));
      return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    })();
    if (keyCache.size > 64) keyCache.clear();
    keyCache.set(cacheKey, p);
  }
  return p;
}

export async function mac(key: CryptoKey, text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

// --------------------------------------------------------------- passcode

/** Constant-time passcode check: compares HMAC(given) with HMAC(expected) via crypto.subtle.verify. */
export async function checkPasscode(sessionSecret: string, expected: string, given: unknown): Promise<boolean> {
  if (typeof given !== 'string' || given.length === 0 || given.length > 512) return false;
  const key = await deriveKey(sessionSecret, expected, 'pass');
  const expectedMac = await mac(key, `pass|${expected}`);
  return crypto.subtle.verify('HMAC', key, expectedMac, enc.encode(`pass|${given}`));
}

// ---------------------------------------------------------------- session

export interface Session {
  v: 1;
  lib: string;   // library id ('main': one passcode, one library)
  o: string;     // origin the cookie was issued for
  iat: number;   // issued at (ms)
  exp: number;   // expires at (ms)
  sh: 0 | 1;     // 1 = "This is a shared computer"
}

export function newSession(origin: string, shared: boolean, now: number): Session {
  return { v: 1, lib: LIBRARY_ID, o: origin, iat: now, exp: now + (shared ? SESSION.sharedIdleMs : SESSION.ttlMs), sh: shared ? 1 : 0 };
}

export async function signSession(key: CryptoKey, s: Session): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(s)));
  return `v1.${body}.${b64url(await mac(key, `v1.${body}`))}`;
}

/** The session in a cookie value, or null if it is forged, expired, too old or for another origin. */
export async function readSession(key: CryptoKey, value: string | null, origin: string, now: number): Promise<Session | null> {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const sig = fromB64url(parts[2]);
  const body = fromB64url(parts[1]);
  if (!sig || !body || sig.length !== 32) return null;
  const ok = await crypto.subtle.verify('HMAC', key, sig, enc.encode(`v1.${parts[1]}`));
  if (!ok) return null;
  let s: Session;
  try { s = JSON.parse(new TextDecoder().decode(body)) as Session; } catch { return null; }
  if (!s || s.v !== 1 || typeof s.lib !== 'string' || s.o !== origin) return null;
  if (typeof s.exp !== 'number' || typeof s.iat !== 'number' || s.exp <= now) return null;
  if (now - s.iat > (s.sh === 1 ? SESSION.sharedMaxMs : SESSION.maxMs)) return null;
  return s;
}

/**
 * A renewed session when this one is past half-life (or idle-limited and used), else null.
 * Only call it for real use: for a shared-computer session, renewing is what keeps it alive.
 */
export function renewSession(s: Session, now: number): Session | null {
  if (s.sh === 1) {
    const exp = Math.min(now + SESSION.sharedIdleMs, s.iat + SESSION.sharedMaxMs);
    return exp - s.exp > 5 * MINUTE ? { ...s, exp } : null;
  }
  if (s.exp - now > SESSION.ttlMs / 2) return null;
  const exp = Math.min(now + SESSION.ttlMs, s.iat + SESSION.maxMs);
  return exp > s.exp ? { ...s, exp } : null;
}

/** Set-Cookie value. A shared-computer session has no Max-Age, so the browser drops it on exit. */
export function sessionCookie(value: string, s: Session, now: number): string {
  const base = `${SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict`;
  return s.sh === 1 ? base : `${base}; Max-Age=${Math.max(0, Math.floor((s.exp - now) / 1000))}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// ----------------------------------------------------------------- origin

/**
 * The Origin rule for requests that use the session cookie. Browsers always send
 * Origin on POST/PUT/DELETE and on WebSocket handshakes, but not on same-origin
 * GET/HEAD, so a missing Origin passes only for GET/HEAD, and only when
 * Sec-Fetch-Site (absent on older Safari) does not say the request is cross-site.
 */
export function originOkForSession(o: { method: string; upgrade: boolean; origin: string | null; secFetchSite: string | null; self: string }): boolean {
  const m = o.method.toUpperCase();
  if (o.upgrade || (m !== 'GET' && m !== 'HEAD')) return o.origin === o.self;
  if (o.origin !== null && o.origin !== o.self) return false;
  if (o.secFetchSite !== null && o.secFetchSite !== 'same-origin') return false;
  return true;
}

// ------------------------------------------------------- signed host header

/**
 * Worker → Room: "this host upgrade carried a valid session for this PIN, which
 * expires at `sessionExp`". The header itself lives a minute; the Room keeps
 * `sessionExp` and closes the host socket with 4011 once it has passed.
 */
export async function signHostHeader(key: CryptoKey, pin: string, now: number, sessionExp: number): Promise<string> {
  const exp = now + SESSION.hostHeaderMs;
  const sexp = Math.floor(sessionExp);
  return `${exp}.${sexp}.${b64url(await mac(key, `host|${pin}|${exp}|${sexp}`))}`;
}

/** The session expiry the Worker vouched for, or null if the header is missing, stale or forged. */
export async function verifyHostHeader(key: CryptoKey, value: string | null, pin: string, now: number): Promise<number | null> {
  if (!value) return null;
  const m = /^(\d{13})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return null;
  const exp = Number(m[1]);
  const sexp = Number(m[2]);
  if (exp <= now || exp > now + SESSION.hostHeaderMs + 5_000 || sexp <= now) return null;
  const sig = fromB64url(m[3]);
  if (!sig) return null;
  return (await crypto.subtle.verify('HMAC', key, sig, enc.encode(`host|${pin}|${exp}|${sexp}`))) ? sexp : null;
}

// -------------------------------------------- self-verifying tokens and keys

/** A player token the Worker can check without asking the Room: 32 hex random + 16 hex MAC over the PIN. */
export async function mintPlayerToken(key: CryptoKey, pin: string): Promise<string> {
  const r = hex(randomBytes(16));
  return r + hex((await mac(key, `tok|${pin}|${r}`)).slice(0, 8));
}

export async function playerTokenValid(key: CryptoKey, pin: string, token: string | null): Promise<boolean> {
  if (!token || !/^[0-9a-f]{48}$/.test(token)) return false;
  const want = (await mac(key, `tok|${pin}|${token.slice(0, 32)}`)).slice(0, 8);
  return equalBytes(want, fromHex(token.slice(32))!);
}

/** The per-room key carried by the QR code and join link (&k=...). */
export async function roomKey(key: CryptoKey, pin: string): Promise<string> {
  return hex((await mac(key, `room|${pin}`)).slice(0, 8));
}

export async function roomKeyValid(key: CryptoKey, pin: string, k: string | null): Promise<boolean> {
  if (!k || !/^[0-9a-f]{16}$/.test(k)) return false;
  return equalBytes((await mac(key, `room|${pin}`)).slice(0, 8), fromHex(k)!);
}

// ------------------------------------------------------------- IP grouping

/** The part of an address that identifies one network: an IPv4 address, or the /64 of an IPv6 one. */
export function ipGroup(ip: string | null): string {
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return full.slice(0, 4).map(x => (x || '0').replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

// ---------------------------------------------------------------- counters

/**
 * Timestamps per key inside a sliding window, in memory only (no storage writes,
 * so an attacker cannot spend the daily write allowance). Bounded: the oldest
 * keys are dropped beyond `maxKeys`.
 */
export class WindowCounter {
  private hits = new Map<string, number[]>();
  private windowMs: number;
  private maxKeys: number;

  constructor(windowMs: number, maxKeys = 20_000) {
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  count(key: string, now: number): number {
    const list = this.hits.get(key);
    if (!list) return 0;
    const fresh = list.filter(t => t > now - this.windowMs);
    if (fresh.length === 0) this.hits.delete(key); else this.hits.set(key, fresh);
    return fresh.length;
  }

  add(key: string, now: number): number {
    const n = this.count(key, now);
    const list = this.hits.get(key) ?? [];
    list.push(now);
    this.hits.delete(key);
    this.hits.set(key, list); // re-insert: Map order is least-recently-touched first
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value as string);
    return n + 1;
  }

  /** Milliseconds until the count for `key` drops below `limit`. */
  retryAfter(key: string, limit: number, now: number): number {
    const list = (this.hits.get(key) ?? []).filter(t => t > now - this.windowMs);
    if (list.length < limit) return 0;
    return list[list.length - limit] + this.windowMs - now;
  }

  clear(key: string): void { this.hits.delete(key); }
}

/**
 * Wrong-passcode limiter: an attempt is reserved before the (async) check and
 * released after it, so parallel requests can never test more than
 * `maxFailures` passcodes per network per window. Counts live in memory; the
 * caller persists what `settle` reports and hands it back through `restore` /
 * `restoreFailures` after a restart. There is deliberately no cap across all
 * networks: one person could then block sign-in for everyone.
 */
export class AttemptLimiter {
  private failures: WindowCounter;
  private pending = new Map<string, number>();
  private lockedUntil = new Map<string, number>();
  private max: number;
  private windowMs: number;

  constructor(max: number = LOCKOUT.maxFailures, windowMs: number = LOCKOUT.windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.failures = new WindowCounter(windowMs);
  }

  /** Reserve an attempt, or say how long the key is locked out. */
  reserve(key: string, now: number): { ok: true } | { ok: false; retryAfterMs: number } {
    const until = this.lockedUntil.get(key) ?? 0;
    if (until > now) return { ok: false, retryAfterMs: until - now };
    if (until) this.lockedUntil.delete(key);
    const used = this.failures.count(key, now) + (this.pending.get(key) ?? 0);
    if (used >= this.max) return { ok: false, retryAfterMs: Math.max(1000, this.failures.retryAfter(key, this.max, now)) };
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    return { ok: true };
  }

  /** Release a reservation. Returns the lockout end if this failure started one, and the failures now in the window. */
  settle(key: string, success: boolean, now: number): { lockedUntil: number | null; remaining: number; failures: number } {
    const p = (this.pending.get(key) ?? 1) - 1;
    if (p <= 0) this.pending.delete(key); else this.pending.set(key, p);
    if (success) { this.failures.clear(key); return { lockedUntil: null, remaining: this.max, failures: 0 }; }
    const n = this.failures.add(key, now);
    if (n >= this.max) {
      const until = now + this.windowMs;
      this.lockedUntil.set(key, until);
      return { lockedUntil: until, remaining: 0, failures: n };
    }
    return { lockedUntil: null, remaining: this.max - n, failures: n };
  }

  /** Restore a lockout read back from storage after the object restarted. */
  restore(key: string, until: number): void { this.lockedUntil.set(key, until); }

  /** Restore a saved failure count: `n` failures, counted from `at`. */
  restoreFailures(key: string, n: number, at: number): void {
    const have = this.failures.count(key, at);
    for (let i = have; i < n; i++) this.failures.add(key, at);
  }
}
