// Edge entry point. Static pages come from Workers Static Assets (free and
// unlimited); only /api/* reaches this code. The Worker validates input and
// routes to the Durable Objects: the Directory (PIN → room id) and the Room
// (one per game). Both Worker and Room are billed one request per WebSocket
// upgrade, so cheap rejections happen here before any object is touched.

import type { Env } from './env';
import { DEFAULT_SETTINGS, LIMITS, PIN_RE, mergeSettings, sha256Hex, validateQuiz } from './shared';

export { Room } from './room';
export { Directory } from './directory';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function originAllowed(request: Request, url: URL, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // non-browser clients (curl, the load harness)
  if (origin === url.origin) return true;
  return (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).includes(origin);
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

async function createRoom(request: Request, url: URL, env: Env): Promise<Response> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > LIMITS.quizBytes) return json({ error: 'too_large' }, 413);
  const text = await request.text();
  if (text.length > LIMITS.quizBytes) return json({ error: 'too_large' }, 413);

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

  // Rate-limit key: SHA-256 of the client IP and the UTC date. It lives in the
  // Directory for at most 48 hours and cannot be linked across days.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const ipHash = (await sha256Hex(`${day}|${ip}`)).slice(0, 32);

  const id = env.ROOM.newUniqueId();
  const alloc = await directory(env).allocate(id.toString(), ipHash);
  if (!alloc.ok) return json({ error: alloc.error }, alloc.status);

  const room = env.ROOM.get(id);
  const { hostToken } = await room.init(alloc.pin, quiz.value, settings);
  return json({ pin: alloc.pin, hostToken, joinUrl: `${url.origin}/play?pin=${alloc.pin}` });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!originAllowed(request, url, env)) return json({ error: 'forbidden_origin' }, 403);

    if (url.pathname === '/api/health') return json({ ok: true, now: Date.now() });
    if (url.pathname === '/api/echo') return echo(request);
    if (url.pathname === '/api/room') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return createRoom(request, url, env);
    }

    const m = url.pathname.match(/^\/api\/room\/([0-9]{6})(\/ws)?$/);
    if (m) {
      const pin = m[1];
      const wantsSocket = m[2] === '/ws';
      if (wantsSocket && !isUpgrade(request)) return new Response('Expected WebSocket upgrade', { status: 426 });
      if (!wantsSocket && request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      if (!PIN_RE.test(pin)) return wantsSocket ? wsReject(4004, 'Room not found') : json({ error: 'not_found' }, 404);

      const found = await directory(env).lookup(pin);
      if (!found) return wantsSocket ? wsReject(4004, 'Room not found') : json({ error: 'not_found' }, 404);

      const room = env.ROOM.get(env.ROOM.idFromString(found.roomId));
      if (wantsSocket) return room.fetch(request);
      const summary = await room.summary();
      return summary ? json(summary) : json({ error: 'not_found' }, 404);
    }

    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<Env>;
