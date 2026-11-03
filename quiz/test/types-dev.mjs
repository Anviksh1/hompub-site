// Checks the Phase 3 question types and pictures (PROTOCOL.md §2, §3, §14) against a running server.
//   npm run dev                                           (in one terminal)
//   node test/types-dev.mjs --base http://127.0.0.1:8787 --passcode "…"
// One host and three version-4 phones play single, multi-select (all or nothing, and partial
// credit), typed-answer, poll and 0-point questions; a version-3 page is told to reload; a picture
// is uploaded, served and named in the question.
import assert from 'node:assert/strict';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => {
  if (v.startsWith('--')) a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return a;
}, []));
const BASE = String(args.base || 'http://127.0.0.1:8787').replace(/\/$/, '');
const WS = BASE.replace(/^http/, 'ws');
const PASS = String(args.passcode || process.env.HOST_PASSCODE || '');
if (!PASS) { console.error('Pass --passcode or set HOST_PASSCODE.'); process.exit(2); }

let passed = 0;
function ok(name) { passed++; console.log('ok  ', name); }

function open(url, headers) {
  const ws = new WebSocket(url, headers ? { headers } : undefined);
  const frames = [];
  const waiters = [];
  ws.addEventListener('message', (ev) => {
    if (ev.data === 'pong') return;
    const f = JSON.parse(ev.data);
    frames.push(f);
    for (const w of [...waiters]) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); }
  });
  const closed = new Promise((resolve) => ws.addEventListener('close', (ev) => resolve({ code: ev.code, reason: ev.reason })));
  const opened = new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  return {
    ws, frames, closed, opened,
    send: (f) => ws.send(JSON.stringify(f)),
    wait(pred, ms = 8000, what = 'frame') {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timed out waiting for ${what}`)); } }, ms);
      });
    },
  };
}

const signIn = await fetch(`${BASE}/api/session`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ passcode: PASS }) });
assert.equal(signIn.status, 200, 'sign in');
const cookie = signIn.headers.get('set-cookie').split(';')[0];
const H = { origin: BASE, cookie };

// ------------------------------------------------------------------ pictures
// A 1×1 PNG, made unique per run so the upload is new.
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c63f8cfc0f01f0005000201' + 'a3c5f4e60000000049454e44ae426082', 'hex');
const unique = Buffer.concat([png, Buffer.from(`run-${Date.now()}-${Math.random()}`)]);   // trailing bytes after IEND
let r = await fetch(`${BASE}/api/images`, { method: 'POST', headers: { ...H, 'content-type': 'image/png' }, body: unique });
assert.equal(r.status, 200, 'upload');
const up = await r.json();
assert.match(up.key, /^[0-9a-f]{64}\.png$/);
assert.equal(up.url, `/api/images/${up.key}`);
r = await fetch(`${BASE}/api/images`, { method: 'POST', headers: { ...H, 'content-type': 'image/png' }, body: unique });
assert.equal((await r.json()).key, up.key, 'the same file gets the same key');
ok('a signed-in host uploads a picture; the same file is stored once');

r = await fetch(`${BASE}${up.url}`);
assert.equal(r.status, 200);
assert.equal(r.headers.get('content-type'), 'image/png');
assert.match(r.headers.get('cache-control'), /immutable/);
assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
assert.equal(Buffer.compare(Buffer.from(await r.arrayBuffer()), unique), 0);
const etag = r.headers.get('etag');
r = await fetch(`${BASE}${up.url}`, { headers: { 'if-none-match': etag } });
assert.equal(r.status, 304);
r = await fetch(`${BASE}${up.url}`, { method: 'HEAD' });
assert.equal(r.status, 200);
assert.equal(Number(r.headers.get('content-length')), unique.length);
ok('anyone can read it: right type, cached for good, 304 on a repeat');

assert.equal((await fetch(`${BASE}/api/images/${'0'.repeat(64)}.png`)).status, 404);
assert.equal((await fetch(`${BASE}/api/images/..%2Fsecret`)).status, 404);
assert.equal((await fetch(`${BASE}/api/images`, { method: 'POST', headers: { origin: BASE }, body: unique })).status, 401);
assert.equal((await fetch(`${BASE}/api/images`, { method: 'POST', headers: { ...H, origin: 'https://evil.example' }, body: unique })).status, 403);
r = await fetch(`${BASE}/api/images`, { method: 'POST', headers: H, body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
assert.equal(r.status, 415);
assert.equal((await r.json()).error, 'not_an_image');
r = await fetch(`${BASE}/api/images`, { method: 'POST', headers: H, body: Buffer.concat([png, Buffer.alloc(1024 * 1024)]) });
assert.equal(r.status, 413);
ok('uploads need sign-in and the page origin; SVG, other files and over 1 MB are refused');

// ------------------------------------------------------------------- the game
const quiz = {
  title: 'Types test',
  questions: [
    { text: 'Single', options: ['a', 'b'], correct: 0, timeLimit: 10, points: 1000, image: { key: up.key, alt: 'A tiny dot', w: 1, h: 1 } },
    { type: 'multi', text: 'Pick 1 and 3', options: ['1', '2', '3', '4'], correct: [0, 2], timeLimit: 10, points: 1000 },
    { type: 'multi', text: 'Pick a, b, c', options: ['a', 'b', 'c', 'd'], correct: [0, 1, 2], partial: true, timeLimit: 10, points: 1000 },
    { type: 'typein', text: 'Who?', accept: ['Kṛṣṇa', 'Krishna'], timeLimit: 10, points: 1000, explanation: 'He is.' },
    { type: 'poll', text: 'Fun?', options: ['Yes', 'No'], timeLimit: 10, points: 0 },
    { text: 'Practice', options: ['a', 'b'], correct: 1, timeLimit: 10, points: 0 },
  ],
};
r = await fetch(`${BASE}/api/room`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ quiz, settings: { showOnDevices: true, shuffle: true } }) });
assert.equal(r.status, 200, 'create room');
const { pin, hostToken } = await r.json();
const host = open(`${WS}/api/room/${pin}/ws?role=host&v=4`, { Origin: BASE, Cookie: cookie });
await host.opened;
host.send({ t: 'auth', token: hostToken });
const hsync = await host.wait((f) => f.t === 'sync', 8000, 'host sync');
assert.equal(hsync.proto, 4);
assert.equal(hsync.settings.shuffle, true);

const v3 = open(`${WS}/api/room/${pin}/ws?role=player&v=3`, { Origin: BASE });
const v3c = await v3.closed;
assert.equal(v3c.code, 4010);
assert.match(v3c.reason, /out of date/);
const v3h = open(`${WS}/api/room/${pin}/ws?role=host&v=3`, { Origin: BASE, Cookie: cookie });
assert.equal((await v3h.closed).code, 4010);
ok('a version-3 page is told to reload when the quiz uses the new types');

async function phone(name) {
  const p = open(`${WS}/api/room/${pin}/ws?role=player&v=4`, { Origin: BASE });
  await p.opened;
  p.send({ t: 'join', nick: name });
  p.welcome = await p.wait((f) => f.t === 'welcome', 8000, `${name} welcome`);
  await p.wait((f) => f.t === 'sync', 8000, `${name} sync`);
  return p;
}
const A = await phone('Asha');
const B = await phone('Bilal');
const C = await phone('Chen');

let ackN = 0;
async function answer(p, q, body, expect = true, reason) {
  ackN++;
  p.send({ t: 'answer', q, ...body });
  const before = p.frames.filter((f) => f.t === 'ack' && f.q === q).length;
  await p.wait((f) => f.t === 'ack' && f.q === q && p.frames.filter((g) => g.t === 'ack' && g.q === q).length > before, 4000, `ack ${ackN}`);
  const ack = p.frames.filter((f) => f.t === 'ack' && f.q === q).at(-1);
  assert.equal(ack.accepted, expect, `${JSON.stringify(body)} → ${JSON.stringify(ack)}`);
  if (reason) assert.equal(ack.reason, reason);
}

async function play(q, fn) {
  host.send({ t: q === 0 ? 'start' : 'next' });
  const intro = await A.wait((f) => f.t === 'intro' && f.question.q === q, 8000, `intro ${q}`);
  await A.wait((f) => f.t === 'open' && f.q === q, 8000, `open ${q}`);
  await fn(intro.question);
  host.send({ t: 'close' });
  const reveal = await host.wait((f) => f.t === 'reveal' && f.q === q, 8000, `reveal ${q}`);
  const res = {};
  for (const [n, p] of [['A', A], ['B', B], ['C', C]]) res[n] = await p.wait((f) => f.t === 'result' && f.q === q, 8000, `result ${q}`);
  return { reveal, res };
}

let g = await play(0, async (view) => {
  assert.equal(view.type, 'single');
  assert.equal(view.shuffle, true);
  assert.deepEqual(view.image, { url: up.url, alt: 'A tiny dot', w: 1, h: 1 });
  await answer(A, 0, { choice: 0 });
  await answer(B, 0, { choice: 1 });
});
assert.equal(g.reveal.correct, 0);
assert.equal(g.reveal.right, 1);
assert.equal(g.reveal.fastest.nick, 'Asha');
assert.equal(g.res.A.right, true);
assert.equal(g.res.B.right, false);
ok('a single-answer question as before, with its picture and shuffle in the view');

g = await play(1, async (view) => {
  assert.equal(view.type, 'multi');
  await answer(C, 1, { choice: [0, 0] }, false, 'invalid');
  await answer(C, 1, { choice: [4] }, false, 'invalid');
  await answer(C, 1, { choice: 1 }, false, 'invalid');
  await answer(C, 1, { choice: [] }, false, 'invalid');
  await answer(A, 1, { choice: [2, 0] });
  await answer(B, 1, { choice: [0] });
  await answer(C, 1, { choice: [1, 3] });
  await answer(C, 1, { choice: [0, 2] }, false, 'duplicate');
});
assert.deepEqual(g.reveal.correct, [0, 2]);
assert.deepEqual(g.reveal.counts, [2, 1, 1, 1]);
assert.equal(g.reveal.right, 1);
assert.deepEqual(g.res.A.choice, [0, 2]);
assert.equal(g.res.A.right, true);
assert.ok(g.res.A.points > 500);
assert.equal(g.res.B.points, 0);
assert.equal(g.res.B.right, false);
ok('multi-select, all or nothing: only exactly the right options score; bad shapes are refused');

g = await play(2, async () => {
  await answer(A, 2, { choice: [0, 1] });
  await answer(B, 2, { choice: [0, 3] });
  await answer(C, 2, { choice: [2, 1, 0] });
});
assert.equal(g.res.C.right, true);
assert.equal(g.res.A.right, false);
assert.ok(g.res.A.points > 0 && g.res.A.points < g.res.C.points, `partial ${g.res.A.points} < full ${g.res.C.points}`);
assert.equal(g.res.B.points, 0, 'one right and one wrong pick cancel out');
ok('multi-select with partial credit: a share of the points, never below 0');

// A reconnect during the open typed-answer question must not tell whether the answer was right.
host.send({ t: 'next' });
await A.wait((f) => f.t === 'intro' && f.question.q === 3, 8000, 'intro 3');
const v3view = A.frames.filter((f) => f.t === 'intro' && f.question.q === 3).at(-1).question;
assert.equal(v3view.type, 'typein');
assert.equal(v3view.optionCount, 0);
assert.deepEqual(v3view.options, []);
assert.equal('accept' in v3view, false, 'no accepted answers before the reveal');
assert.equal('explanation' in v3view, false);
await A.wait((f) => f.t === 'open' && f.q === 3, 8000, 'open 3');
await answer(A, 3, { text: '' }, false, 'invalid');
await answer(A, 3, { text: 'x'.repeat(81) }, false, 'invalid');
await answer(A, 3, { text: 'krsna' });
await answer(B, 3, { text: '  Krishna. ' });
await answer(C, 3, { text: '=SUM(A1:A9)' });
const scoreBefore = A.frames.filter((f) => f.t === 'result' && f.q === 2).at(-1).score;
const peek = open(`${WS}/api/room/${pin}/ws?role=player&v=4&token=${A.welcome.token}`, { Origin: BASE });
const psync = await peek.wait((f) => f.t === 'sync', 6000, 'peek sync');
assert.equal(psync.me.score, scoreBefore, 'score as before the question');
assert.equal(psync.me.typed, 'krsna');
Object.assign(A, { ws: peek.ws, frames: peek.frames, send: peek.send, wait: peek.wait });
host.send({ t: 'close' });
const rev3 = await host.wait((f) => f.t === 'reveal' && f.q === 3, 8000, 'reveal 3');
const res3 = { A: await A.wait((f) => f.t === 'result' && f.q === 3), B: await B.wait((f) => f.t === 'result' && f.q === 3), C: await C.wait((f) => f.t === 'result' && f.q === 3) };
assert.deepEqual(rev3.correct, ['Kṛṣṇa', 'Krishna']);
assert.equal(rev3.explanation, 'He is.');
assert.equal(res3.A.explanation, 'He is.');
assert.deepEqual(rev3.counts, []);
assert.equal(rev3.right, 2);
assert.equal(res3.A.right, true);
assert.equal(res3.B.right, true);
assert.equal(res3.C.right, false);
assert.equal(res3.C.typed, '=SUM(A1:A9)');
ok('a typed answer: case, accents and IAST ignored; the accepted answers and the explanation only at the reveal');

const streakBefore = res3.A.streak;
g = await play(4, async (view) => {
  assert.equal(view.type, 'poll');
  await answer(A, 4, { choice: 0 });
  await answer(B, 4, { choice: 1 });
});
assert.equal(g.reveal.correct, null);
assert.equal(g.reveal.fastest, null);
assert.deepEqual(g.reveal.counts, [1, 1]);
assert.equal(g.res.A.right, null);
assert.equal(g.res.A.points, 0);
assert.equal(g.res.A.streak, streakBefore, 'a poll neither extends nor breaks a streak');
ok('a poll: no right answer, no points, no "fastest", streaks untouched');

g = await play(5, async () => { await answer(A, 5, { choice: 1 }); });
assert.equal(g.reveal.correct, 1);
assert.equal(g.reveal.fastest, null, 'no "fastest" when speed scored nothing');
assert.equal(g.res.A.right, true);
ok('a 0-point question keeps its right answer but shows no "fastest"');

host.send({ t: 'end' });
const csvF = await host.wait((f) => f.t === 'results_csv', 8000, 'results');
const lines = csvF.csv.trim().split('\r\n');
const rowOf = (nick) => lines.find((l) => l.split(',')[1] === nick);
assert.match(rowOf('Asha'), /,A\+C \d+,/);
assert.match(rowOf('Asha'), /krsna \d+/);
assert.match(rowOf('Chen'), /"?'=SUM\(A1:A9\) 0"?/);
assert.ok(!/,=/.test(csvF.csv), 'no cell starts with =');
// rank,nickname,score,correct,answered: Asha was right on 0,1,3,5 (the poll is never "right").
assert.equal(rowOf('Asha').split(',')[3], '4');
ok('the results file: "A+C", typed text (formula-safe), polls never counted right');

host.send({ t: 'ack_results' });
await host.wait((f) => f.t === 'wiped', 6000, 'wiped');
for (const s of [host, A, B, C]) { try { s.ws.close(); } catch { /* gone */ } }
console.log(`\n${passed} checks passed against ${BASE}`);
console.log(`picture key: ${up.key}`);
process.exit(0);
