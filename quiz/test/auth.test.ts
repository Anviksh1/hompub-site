// Unit tests for src/auth.ts. Run with: node --test test/auth.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AttemptLimiter,
  LOCKOUT,
  SESSION,
  SESSION_COOKIE,
  WindowCounter,
  checkPasscode,
  clearSessionCookie,
  deriveKey,
  ipGroup,
  mintPlayerToken,
  newSession,
  originOkForSession,
  playerTokenValid,
  readCookie,
  readSession,
  renewSession,
  roomKey,
  roomKeyValid,
  secretsProblem,
  sessionCookie,
  signHostHeader,
  signSession,
  verifyHostHeader,
} from '../src/auth.ts';

const SECRET = 'k'.repeat(43);
const PASS = 'correct horse battery';
const ORIGIN = 'https://hompub-quiz.example.workers.dev';
const T = 1_760_000_000_000;

test('secretsProblem requires both secrets and a long passcode', () => {
  assert.equal(secretsProblem({}), 'not_configured');
  assert.equal(secretsProblem({ HOST_PASSCODE: PASS }), 'not_configured');
  assert.equal(secretsProblem({ HOST_PASSCODE: 'short', SESSION_KEY: SECRET }), 'passcode_too_short');
  assert.equal(secretsProblem({ HOST_PASSCODE: PASS, SESSION_KEY: SECRET }), null);
});

test('checkPasscode accepts only the exact passcode', async () => {
  assert.equal(await checkPasscode(SECRET, PASS, PASS), true);
  for (const wrong of ['', 'correct horse battery ', 'Correct horse battery', 'x', 42, null, 'a'.repeat(600)]) {
    assert.equal(await checkPasscode(SECRET, PASS, wrong), false, String(wrong));
  }
});

test('a session cookie round-trips and is bound to its origin', async () => {
  const key = await deriveKey(SECRET, PASS, 'session');
  const s = newSession(ORIGIN, false, T);
  const value = await signSession(key, s);
  assert.deepEqual(await readSession(key, value, ORIGIN, T + 1000), s);
  assert.equal(await readSession(key, value, 'https://other.example', T + 1000), null);
  assert.equal(await readSession(key, value, ORIGIN, s.exp + 1), null);           // expired
  assert.equal(await readSession(key, value.slice(0, -2) + 'AA', ORIGIN, T), null); // forged signature
  assert.equal(await readSession(key, null, ORIGIN, T), null);
  assert.equal(await readSession(key, 'garbage', ORIGIN, T), null);
});

test('changing either secret ends every session', async () => {
  const key = await deriveKey(SECRET, PASS, 'session');
  const value = await signSession(key, newSession(ORIGIN, false, T));
  assert.equal(await readSession(await deriveKey(SECRET, 'a new passcode here', 'session'), value, ORIGIN, T), null);
  assert.equal(await readSession(await deriveKey('n'.repeat(43), PASS, 'session'), value, ORIGIN, T), null);
});

test('keys are separated by purpose', async () => {
  const sessionKey = await deriveKey(SECRET, PASS, 'session');
  const hostKey = await deriveKey(SECRET, PASS, 'host');
  const header = await signHostHeader(hostKey, '123456', T);
  assert.equal(await verifyHostHeader(hostKey, header, '123456', T), true);
  assert.equal(await verifyHostHeader(sessionKey, header, '123456', T), false);
});

test('renewSession: past half-life, never beyond the absolute cap; shared sessions slide', () => {
  const s = newSession(ORIGIN, false, T);
  assert.equal(renewSession(s, T + 1000), null);
  const later = T + SESSION.ttlMs / 2 + 1000;
  assert.equal(renewSession(s, later)!.exp, later + SESSION.ttlMs);
  const old = { ...s, exp: T + SESSION.maxMs - 1000 };
  assert.equal(renewSession(old, T + SESSION.maxMs - 2000)!.exp, T + SESSION.maxMs);
  const shared = newSession(ORIGIN, true, T);
  assert.equal(shared.exp, T + SESSION.sharedIdleMs);
  assert.equal(renewSession(shared, T + 60_000), null);                      // under 5 min gained
  assert.equal(renewSession(shared, T + 3_600_000)!.exp, T + 3_600_000 + SESSION.sharedIdleMs);
});

test('cookie headers: __Host- prefix rules, shared sessions have no Max-Age', () => {
  const s = newSession(ORIGIN, false, T);
  const c = sessionCookie('v', s, T);
  assert.ok(c.startsWith(`${SESSION_COOKIE}=v; Path=/; Secure; HttpOnly; SameSite=Strict`));
  assert.match(c, /Max-Age=2592000$/);
  assert.doesNotMatch(sessionCookie('v', newSession(ORIGIN, true, T), T), /Max-Age/);
  assert.doesNotMatch(c, /Domain=/i);
  assert.match(clearSessionCookie(), /Max-Age=0$/);
  assert.equal(readCookie(`a=1; ${SESSION_COOKIE}=abc.def; b=2`, SESSION_COOKIE), 'abc.def');
  assert.equal(readCookie('a=1', SESSION_COOKIE), null);
  assert.equal(readCookie(null, SESSION_COOKIE), null);
});

test('originOkForSession: strict on writes and upgrades, tolerant of same-origin GETs', () => {
  const ok = (method: string, origin: string | null, secFetchSite: string | null, upgrade = false) =>
    originOkForSession({ method, upgrade, origin, secFetchSite, self: ORIGIN });
  assert.equal(ok('POST', ORIGIN, 'same-origin'), true);
  assert.equal(ok('POST', null, null), false);
  assert.equal(ok('DELETE', 'https://evil.example', 'cross-site'), false);
  assert.equal(ok('GET', ORIGIN, null, true), true);         // WebSocket upgrade
  assert.equal(ok('GET', null, null, true), false);
  assert.equal(ok('GET', null, 'same-origin'), true);        // browsers send no Origin on same-origin GET
  assert.equal(ok('GET', null, null), true);                 // older Safari: no Sec-Fetch-Site either
  assert.equal(ok('GET', null, 'cross-site'), false);
  assert.equal(ok('GET', null, 'none'), false);              // typed into the address bar
  assert.equal(ok('GET', 'https://evil.example', null), false);
  assert.equal(ok('HEAD', null, 'same-origin'), true);
});

test('signed host header: bound to its PIN and short-lived', async () => {
  const key = await deriveKey(SECRET, PASS, 'host');
  const h = await signHostHeader(key, '123456', T);
  assert.equal(await verifyHostHeader(key, h, '123456', T + 1000), true);
  assert.equal(await verifyHostHeader(key, h, '654321', T + 1000), false);
  assert.equal(await verifyHostHeader(key, h, '123456', T + SESSION.hostHeaderMs + 1), false);
  assert.equal(await verifyHostHeader(key, null, '123456', T), false);
  assert.equal(await verifyHostHeader(key, '1.abc', '123456', T), false);
});

test('self-verifying player tokens and room keys', async () => {
  const key = await deriveKey(SECRET, PASS, 'token');
  const tok = await mintPlayerToken(key, '123456');
  assert.match(tok, /^[0-9a-f]{48}$/);
  assert.equal(await playerTokenValid(key, '123456', tok), true);
  assert.equal(await playerTokenValid(key, '654321', tok), false);
  assert.equal(await playerTokenValid(key, '123456', tok.slice(0, 47) + (tok[47] === '0' ? '1' : '0')), false);
  assert.equal(await playerTokenValid(key, '123456', 'a'.repeat(32)), false);      // a version-1 token
  const rk = await roomKey(await deriveKey(SECRET, PASS, 'room'), '123456');
  assert.equal(await roomKeyValid(await deriveKey(SECRET, PASS, 'room'), '123456', rk), true);
  assert.equal(await roomKeyValid(await deriveKey(SECRET, PASS, 'room'), '123457', rk), false);
  assert.equal(await roomKeyValid(await deriveKey(SECRET, PASS, 'room'), '123456', null), false);
});

test('ipGroup keeps IPv4 whole and groups IPv6 by /64', () => {
  assert.equal(ipGroup('203.0.113.7'), '203.0.113.7');
  assert.equal(ipGroup('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(ipGroup('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(ipGroup('2001:DB8::1'), '2001:db8:0:0::/64');
  assert.equal(ipGroup(null), 'unknown');
});

test('WindowCounter counts inside the window only and stays bounded', () => {
  const c = new WindowCounter(10_000, 3);
  assert.equal(c.add('a', T), 1);
  assert.equal(c.add('a', T + 1000), 2);
  assert.equal(c.count('a', T + 10_500), 1);
  assert.equal(c.retryAfter('a', 1, T + 10_500), 500);
  c.add('b', T); c.add('c', T); c.add('d', T);
  assert.equal(c.count('a', T + 1000), 0);   // evicted: oldest key beyond maxKeys
});

test('AttemptLimiter: parallel guesses never exceed the limit', () => {
  const lim = new AttemptLimiter();
  const granted = [];
  for (let i = 0; i < 20; i++) if (lim.reserve('ip', T).ok) granted.push(i);   // 20 at once, none settled yet
  assert.equal(granted.length, LOCKOUT.maxFailures);
  for (let i = 0; i < granted.length; i++) lim.settle('ip', false, T);
  const r = lim.reserve('ip', T + 1000);
  assert.ok(!r.ok && r.retryAfterMs > 14 * 60_000);
  assert.ok(lim.reserve('ip', T + LOCKOUT.windowMs + 1).ok);                    // lockout over
});

test('AttemptLimiter: a correct passcode clears earlier failures', () => {
  const lim = new AttemptLimiter();
  for (let i = 0; i < 4; i++) { assert.ok(lim.reserve('ip', T).ok); lim.settle('ip', false, T); }
  assert.ok(lim.reserve('ip', T).ok);
  assert.equal(lim.settle('ip', true, T).remaining, LOCKOUT.maxFailures);
  assert.ok(lim.reserve('ip', T).ok);
});
