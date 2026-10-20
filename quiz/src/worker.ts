// Edge entry point. Static pages come from Workers Static Assets (free and
// unlimited); only /api/* reaches this code. The Worker validates input and
// routes to the Durable Objects: the Directory (PIN → room id, passcode check,
// guess limits) and the Room (one per game). Both Worker and Room are billed
// one request per WebSocket upgrade, so cheap rejections happen here before
// any object is touched.
//
// Host access (protocol 2): the teacher signs in with HOST_PASSCODE and gets an
// HttpOnly session cookie. Creating a room, the host socket and the live-rooms
// list need it. The Worker checks the cookie and forwards host upgrades to the
// Room with a short-lived signed header; it never forwards the cookie itself.

import { devOn, type Env } from './env';
import type { AuthResult, LookupResult } from './directory';
import {
  LIBRARY_ID,
  SESSION_COOKIE,
  clearSessionCookie,
  deriveKey,
  ipGroup,
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
  type Session,
} from './auth';
import { DEFAULT_SETTINGS, LIMITS, PIN_RE, mergeSettings, sha256Hex, validateQuiz } from './shared';

export { Room } from './room';
export { Directory } from './directory';

const VERSION = '0.2.0'; // not exported: the entry module may only export handlers and Durable Object classes
const PROTO = 2;

// API responses may not be framed and send no referrer (static pages get the same from public/_headers).
const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'referrer-policy': 'strict-origin-when-cross-origin',
};

function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...(extra || {}) } });
}

const MESSAGES = {
  not_configured: 'Hosting is not set up yet: HOST_PASSCODE and SESSION_KEY must be set in Cloudflare (README, "Host passcode").',
  passcode_too_short: 'The host passcode is shorter than 12 characters. Set a longer HOST_PASSCODE in Cloudflare (README, "Host passcode").',
  sign_in: 'Sign in with the host passcode to host a game.',
  try_again: 'The server is restarting. Try again in a minute.',
  bad_origin: 'This request did not come from the host page.',
} as const;

function originAllowed(request: Request, url: URL, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // non-browser clients (curl, the load harness)
  if (origin === url.origin) return true;
  return (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).includes(origin);
}

function sessionOrigin(request: Request, url: URL): boolean {
  return originOkForSession({
    method: request.method,
    upgrade: isUpgrade(request),
    origin: request.headers.get('Origin'),
    secFetchSite: request.headers.get('Sec-Fetch-Site'),
    self: url.origin,
  });
}

function isUpgrade(request: Request): boolean {
  return request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
}

/** Complete the WebSocket handshake and immediately close with a code the browser can read. */
function wsReject(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: client });
}

/** Network preflight: echoes text frames for up to 60 s. No Durable Object involved. */
function echo(request: Request): Response {
  if (!isUpgrade(request)) return new Response('Expected WebSocket upgrade', { status: 426 });
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  let frames = 0;
  server.addEventListener('message', (event) => {
    frames += 1;
    if (frames > 100 || typeof event.data !== 'string' || event.data.length > LIMITS.frameBytes) {
      try { server.close(1008, 'Echo limit'); } catch { /* ignore */ }
      return;
    }
    try { server.send(event.data); } catch { /* ignore */ }
  });
  setTimeout(() => { try { server.close(1000, 'Echo timeout'); } catch { /* ignore */ } }, 60_000);
  return new Response(null, { status: 101, webSocket: client });
}

function directory(env: Env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName('global'));
}

function clientIp(request: Request, env: Env): string {
  if (devOn(env) && env.DEV_CLIENT_IP_HEADER) {
    const fake = request.headers.get(env.DEV_CLIENT_IP_HEADER);
    if (fake) return fake;
  }
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

/**
 * Keyed hash of the caller's network, for one purpose. Not linked to a day: kept in
 * memory, or for a 15-minute lockout. Keyed with IP_HASH_KEY, or with SESSION_KEY
 * (always set when hosting works) if that optional secret is missing, so a stored
 * value cannot be reversed by trying every IPv4 address.
 */
async function ipKey(request: Request, env: Env, purpose: 'auth' | 'pin'): Promise<string> {
  return (await sha256Hex(`${env.IP_HASH_KEY || env.SESSION_KEY || ''}|${purpose}|${ipGroup(clientIp(request, env))}`)).slice(0, 32);
}

function minutes(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

// --------------------------------------------------------------- sessions

/** session: as renewed (if due); held: as the browser's cookie has it; renewed: the Set-Cookie, if any. */
interface SignedIn { session: Session; held: Session; renewed: string | null }

/**
 * The caller's valid session (renewing it if due), or null. `passive`: a timer on
 * the host page, not the teacher, so a shared-computer session is not renewed
 * and its 4-hour idle limit holds while the tab stays open.
 */
async function signedIn(request: Request, url: URL, env: Env, passive = false): Promise<SignedIn | null> {
  if (secretsProblem(env)) return null;
  const now = Date.now();
  const key = await deriveKey(env.SESSION_KEY!, env.HOST_PASSCODE!, 'session');
  const s = await readSession(key, readCookie(request.headers.get('Cookie'), SESSION_COOKIE), url.origin, now);
  if (!s || s.lib !== LIBRARY_ID) return null;
  if (passive && s.sh === 1) return { session: s, held: s, renewed: null };
  const next = renewSession(s, now);
  if (!next) return { session: s, held: s, renewed: null };
  return { session: next, held: s, renewed: sessionCookie(await signSession(key, next), next, now) };
}

function sessionView(s: Session): object {
  return { signedIn: true, shared: s.sh === 1, expiresAt: s.exp, library: s.lib };
}

async function handleSession(request: Request, url: URL, env: Env): Promise<Response> {
  if (!sessionOrigin(request, url)) return json({ error: 'bad_origin', message: MESSAGES.bad_origin }, 403);
  const problem = secretsProblem(env);

  if (request.method === 'GET') {
    const si = await signedIn(request, url, env, url.searchParams.get('passive') === '1');
    if (!si) return json({ signedIn: false, ...(problem ? { problem, message: MESSAGES[problem] } : {}) });
    return json(sessionView(si.session), 200, si.renewed ? { 'set-cookie': si.renewed } : undefined);
  }

  if (request.method === 'DELETE') {
    return json({ signedIn: false }, 200, { 'set-cookie': clearSessionCookie() });
  }

  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (problem) return json({ error: problem, message: MESSAGES[problem] }, 503);
  let body: { passcode?: unknown; shared?: unknown };
  try {
    const text = await request.text();
    if (text.length > 2048) return json({ error: 'too_large' }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  let result: AuthResult;
  try {
    result = await directory(env).authAttempt(await ipKey(request, env, 'auth'), body?.passcode);
  } catch {
    // The Directory may still run older code for a few seconds after a deploy. Never skip the check.
    return json({ error: 'try_again', message: MESSAGES.try_again }, 503);
  }
  if (result.ok) {
    const now = Date.now();
    const key = await deriveKey(env.SESSION_KEY!, env.HOST_PASSCODE!, 'session');
    const s = newSession(url.origin, body?.shared === true, now);
    return json(sessionView(s), 200, { 'set-cookie': sessionCookie(await signSession(key, s), s, now) });
  }
  if (result.error === 'locked') {
    const m = minutes(result.retryAfterMs);
    return json(
      { error: 'locked', retryAfter: Math.ceil(result.retryAfterMs / 1000), message: `Too many wrong passcodes. Try again in ${m} minute${m === 1 ? '' : 's'}.` },
      429,
      { 'retry-after': String(Math.ceil(result.retryAfterMs / 1000)) },
    );
  }
  if (result.error === 'wrong_passcode') {
    return json({ error: 'wrong_passcode', remaining: result.remaining, message: `That passcode is not right. ${result.remaining} tr${result.remaining === 1 ? 'y' : 'ies'} left before a 15-minute wait.` }, 401);
  }
  return json({ error: result.error, message: MESSAGES[result.error] }, 503);
}

// ------------------------------------------------------------------ rooms

async function createRoom(request: Request, url: URL, env: Env): Promise<Response> {
  if (!sessionOrigin(request, url)) return json({ error: 'bad_origin', message: MESSAGES.bad_origin }, 403);
  const problem = secretsProblem(env);
  if (problem) return json({ error: problem, message: MESSAGES[problem] }, 503);
  const si = await signedIn(request, url, env);
  if (!si) return json({ error: 'sign_in', message: MESSAGES.sign_in }, 401);

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > LIMITS.quizBytes) return json({ error: 'too_large' }, 413);
  const body_bytes = await request.arrayBuffer();
  if (body_bytes.byteLength > LIMITS.quizBytes) return json({ error: 'too_large' }, 413);
  const text = new TextDecoder().decode(body_bytes);

  let body: { quiz?: unknown; settings?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ error: 'invalid_body' }, 400);

  const quiz = validateQuiz(body.quiz);
  if (!quiz.ok) return json({ error: quiz.error }, 400);
  const settings = mergeSettings(DEFAULT_SETTINGS, body.settings, true);

  // Daily creation counter key: SHA-256 of the client IP and the UTC date, keyed
  // with the optional IP_HASH_KEY secret. Signed-in hosts skip the per-network
  // cap, so this only feeds the whole-deployment count (PROTOCOL.md §10).
  const day = new Date().toISOString().slice(0, 10);
  const ipHash = (await sha256Hex(`${env.IP_HASH_KEY || ''}|${day}|${clientIp(request, env)}`)).slice(0, 32);

  const id = env.ROOM.newUniqueId();
  const alloc = await directory(env).allocate(id.toString(), ipHash, { library: si.session.lib, skipPerIp: true });
  if (!alloc.ok) return json({ error: alloc.error }, alloc.status);

  const room = env.ROOM.get(id);
  let hostToken: string;
  try {
    ({ hostToken } = await room.init(alloc.pin, quiz.value, settings));
  } catch {
    // Do not leave a PIN pointing at an empty room.
    try { await directory(env).release(alloc.pin, id.toString()); } catch { /* expires on its own */ }
    return json({ error: 'room_unavailable' }, 503);
  }
  const k = await roomKey(await deriveKey(env.SESSION_KEY!, env.HOST_PASSCODE!, 'room'), alloc.pin);
  return json(
    { pin: alloc.pin, hostToken, roomKey: k, joinUrl: `${url.origin}/play?pin=${alloc.pin}&k=${k}` },
    200,
    si.renewed ? { 'set-cookie': si.renewed } : undefined,
  );
}

/** The signed-in library's live games, for "Resume game" on another device. Never returns host tokens. */
async function listRooms(request: Request, url: URL, env: Env): Promise<Response> {
  if (!sessionOrigin(request, url)) return json({ error: 'bad_origin', message: MESSAGES.bad_origin }, 403);
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  const si = await signedIn(request, url, env);
  if (!si) return json({ error: 'sign_in', message: MESSAGES.sign_in }, 401);
  let live: { pin: string; roomId: string; createdAt: number }[] = [];
  try { live = await directory(env).liveRooms(si.session.lib); } catch { /* older Directory during a deploy */ }
  const rooms = [];
  for (const r of live) {
    try {
      const sum = await env.ROOM.get(env.ROOM.idFromString(r.roomId)).hostSummary();
      if (sum) rooms.push({ ...sum, createdAt: r.createdAt });
    } catch { /* an older Room during a deploy: skip it */ }
  }
  return json({ rooms }, 200, si.renewed ? { 'set-cookie': si.renewed } : undefined);
}

/** GET summary or WebSocket upgrade for one PIN. */
async function roomRequest(request: Request, url: URL, env: Env, ctx: ExecutionContext, pin: string, wantsSocket: boolean): Promise<Response> {
  const role = url.searchParams.get('role');
  const v = Number(url.searchParams.get('v')) >= 2 ? 2 : 1;
  const isHost = wantsSocket && role === 'host';
  const notFound = () => (wantsSocket ? wsReject(4004, 'Room not found') : json({ error: 'not_found' }, 404));
  if (!PIN_RE.test(pin)) return notFound();

  let library: string | null = null;
  let sessionExp = 0;
  if (isHost) {
    // A host socket needs a valid session. A page from before protocol 2 cannot sign in at all.
    if (!sessionOrigin(request, url)) return wsReject(4011, 'Sign in again to continue this game.');
    const si = await signedIn(request, url, env);
    if (!si) {
      return v < 2
        ? wsReject(4010, `This page is out of date. Reload it and sign in to continue game ${pin}.`)
        : wsReject(4011, 'Sign in again to continue this game.');
    }
    library = si.session.lib;
    // The cookie's own expiry: a WebSocket response cannot carry a renewed cookie, and a reconnect is not use.
    sessionExp = si.held.exp;
  }

  const keysOk = !secretsProblem(env);
  const pinKey = await ipKey(request, env, 'pin');
  let bypass = isHost;
  if (!bypass && keysOk) {
    const k = url.searchParams.get('k');
    const token = url.searchParams.get('token');
    if (k && await roomKeyValid(await deriveKey(env.SESSION_KEY!, env.HOST_PASSCODE!, 'room'), pin, k)) bypass = true;
    else if (token && await playerTokenValid(await deriveKey(env.SESSION_KEY!, env.HOST_PASSCODE!, 'token'), pin, token)) bypass = true;
  }
  const maxPlayers = Number(env.MAX_PLAYERS) || 250;
  let found: LookupResult | null;
  try {
    found = await directory(env).lookup(pin, {
      ipKey: pinKey,
      tokenless: wantsSocket && role === 'player' && !url.searchParams.get('token'),
      bypass,
      missLimit: Number(env.PIN_MISS_LIMIT) || 100,
      joinLimit: maxPlayers * 2 + 100,
    });
  } catch {
    return wantsSocket ? wsReject(1011, 'Try again') : json({ error: 'try_again', message: MESSAGES.try_again }, 503);
  }
  if (found && found.limited) {
    if (found.notifyRoom) {
      // Tell the PIN's host, so the teacher can ask students to scan the QR code instead.
      const notice = env.ROOM.get(env.ROOM.idFromString(found.notifyRoom)).limitNotice(found.retryAfterMs);
      ctx.waitUntil(notice.catch(() => { /* an older Room during a deploy */ }));
    }
    const m = minutes(found.retryAfterMs);
    const message = `Too many wrong PINs from this network. Wait ${m} minute${m === 1 ? '' : 's'}, then try again, or scan the QR code.`;
    if (!wantsSocket) return json({ error: 'rate_limited', retryAfter: Math.ceil(found.retryAfterMs / 1000), message }, 429, { 'retry-after': String(Math.ceil(found.retryAfterMs / 1000)) });
    // 4010 is a code version-1 pages do not retry; version-2 pages get their own.
    return wsReject(v >= 2 ? 4014 : 4010, message);
  }
  if (!found) return notFound();
  // An older Directory (for a few seconds during a deploy) returns no library: rooms then count as 'main'.
  if (isHost && (found.library ?? LIBRARY_ID) !== library) return notFound();

  const room = env.ROOM.get(env.ROOM.idFromString(found.roomId));
  if (!wantsSocket) {
    const summary = await room.summary();
    if (!summary) return json({ error: 'not_found' }, 404);
    if (summary.phase === 'ended' && !bypass) { try { await directory(env).noteMiss(pinKey); } catch { /* ignore */ } }
    return json(summary);
  }

  // Forward a rebuilt request: never the cookie, never a client copy of our own headers.
  const headers = new Headers(request.headers);
  headers.delete('Cookie');
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith('x-hq-')) headers.delete(name);
  // The Room reports an unknown token as a PIN miss; a caller that proved it belongs is not guessing.
  if (!bypass) headers.set('X-HQ-IpKey', pinKey);
  if (isHost && keysOk && !(devOn(env) && env.DEV_SKIP_HOST_VOUCH === '1')) {
    headers.set('X-HQ-Host', await signHostHeader(await deriveKey(env.SESSION_KEY!, env.HOST_PASSCODE!, 'host'), pin, Date.now(), sessionExp));
  }
  return room.fetch(new Request(request.url, { method: 'GET', headers }));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!originAllowed(request, url, env)) return json({ error: 'forbidden_origin' }, 403);

    if (url.pathname === '/api/health') return json({ ok: true, now: Date.now(), version: VERSION, proto: PROTO });
    if (url.pathname === '/api/echo') return echo(request);
    if (url.pathname === '/api/session') return handleSession(request, url, env);
    if (url.pathname === '/api/rooms') return listRooms(request, url, env);
    if (url.pathname === '/api/room') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return createRoom(request, url, env);
    }

    const m = url.pathname.match(/^\/api\/room\/([0-9]{6})(\/ws)?$/);
    if (m) {
      const wantsSocket = m[2] === '/ws';
      if (wantsSocket && !isUpgrade(request)) return new Response('Expected WebSocket upgrade', { status: 426 });
      if (!wantsSocket && request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return roomRequest(request, url, env, ctx, m[1], wantsSocket);
    }

    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<Env>;
