// Checks Focus check and protocol 3 (PROTOCOL.md §11, §13) against a running server.
//   npm run dev                                           (in one terminal)
//   node test/focus-dev.mjs --base http://127.0.0.1:8787 --passcode "…"
// One host and four phones play a 2-question game: version-3 phones report leaving the page,
// a version-2 phone is marked "not checked", a version-1 page is told to reload.
import assert from 'node:assert/strict';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => {
  if (v.startsWith('--')) a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return a;
}, []));
const BASE = String(args.base || 'http://127.0.0.1:8787').replace(/\/$/, '');
const WS = BASE.replace(/^http/, 'ws');
const PASS = String(args.passcode || process.env.HOST_PASSCODE || '');
if (!PASS) { console.error('Pass --passcode or set HOST_PASSCODE.'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(name) { passed++; console.log('ok  ', name); }

/** A socket that records every frame and lets a test wait for one. */
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
    take(pred) { const i = frames.findIndex(pred); return i < 0 ? null : frames.splice(i, 1)[0]; },
  };
}

// Sign in and create a 2-question room with Focus check on.
const signIn = await fetch(`${BASE}/api/session`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ passcode: PASS }) });
assert.equal(signIn.status, 200, 'sign in');
const cookie = signIn.headers.get('set-cookie').split(';')[0];
const quiz = {
  title: 'Focus check test',
  questions: [
    { text: 'One?', options: ['a', 'b'], correct: 0, timeLimit: 5, points: 1000 },
    { text: 'Two?', options: ['a', 'b'], correct: 1, timeLimit: 5, points: 1000 },
  ],
};
const created = await fetch(`${BASE}/api/room`, {
  method: 'POST', headers: { origin: BASE, cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ quiz, settings: { focusCheck: true, showOnDevices: true } }),
});
assert.equal(created.status, 200, 'create room');
const { pin, hostToken } = await created.json();

const host = open(`${WS}/api/room/${pin}/ws?role=host&v=4`, { Origin: BASE, Cookie: cookie });
await host.opened;
host.send({ t: 'auth', token: hostToken });
const hsync = await host.wait((f) => f.t === 'sync', 8000, 'host sync');
assert.equal(hsync.proto, 4);
assert.equal(hsync.settings.focusCheck, true);
assert.deepEqual(hsync.focusQs, []);
assert.deepEqual(hsync.focus, []);
ok('protocol 4 host sync carries Focus check');

async function phone(name, v) {
  const p = open(`${WS}/api/room/${pin}/ws?role=player${v ? `&v=${v}` : ''}`, { Origin: BASE });
  await p.opened;
  p.send({ t: 'join', nick: name });
  p.welcome = await p.wait((f) => f.t === 'welcome', 8000, `${name} welcome`);
  await p.wait((f) => f.t === 'sync', 8000, `${name} sync`);
  return p;
}
const A = await phone('Asha', 3);
const B = await phone('Bilal', 3);
const C = await phone('Chen', 2);
assert.equal(A.frames.find((f) => f.t === 'sync').settings.focusCheck, true);
ok('phones get the focusCheck setting');

const old = open(`${WS}/api/room/${pin}/ws?role=player`, { Origin: BASE });
const oldClose = await old.closed;
assert.equal(oldClose.code, 4010);
assert.match(oldClose.reason, /out of date/);
ok('a version-1 page is told to reload (4010)');

// Question 1: checked.
host.send({ t: 'start' });
await A.wait((f) => f.t === 'open' && f.q === 0, 8000, 'open q0');
host.send({ t: 'settings', settings: { focusCheck: false } });
const refused = await host.wait((f) => f.t === 'error' && f.code === 'focus_mid_question', 4000, 'focus_mid_question');
assert.ok(refused);
ok('Focus check cannot change during a question');

A.send({ t: 'away', q: 0, n: 1, ms: 3000, copies: 0 });
A.send({ t: 'away', q: 0, n: 2, ms: 5200, copies: 1 });
B.send({ t: 'away', q: 0, n: 1, ms: 300 });          // under a second: ignored
B.send({ t: 'away', q: 7, n: 1, ms: 3000 });         // no such checked question: ignored
A.send({ t: 'answer', q: 0, choice: 0 });
B.send({ t: 'answer', q: 0, choice: 0 });
await A.wait((f) => f.t === 'ack' && f.q === 0, 4000, 'ack');
// A reconnect during the open question must not show the new score (it would tell whether the answer was right).
const peek = open(`${WS}/api/room/${pin}/ws?role=player&v=3&token=${A.welcome.token}`, { Origin: BASE });
const psync = await peek.wait((f) => f.t === 'sync', 6000, 'peek sync');
assert.equal(psync.me.answered, true);
assert.equal(psync.me.score, 0, 'score as before the question');
assert.equal(psync.me.streak, null, 'no streak once answered');
ok('during an open question a reconnect shows the score from before it');
// That reconnect replaced Asha's first socket (one live page per player): carry on with the new one.
Object.assign(A, { ws: peek.ws, frames: peek.frames, send: peek.send, wait: peek.wait });
const focus = await host.wait((f) => f.t === 'focus' && f.records.some((r) => r.pid === A.welcome.pid && r.n === 2), 4000, 'focus frame');
const recA = focus.records.find((r) => r.pid === A.welcome.pid && r.q === 0);
assert.deepEqual({ n: recA.n, ms: recA.ms, copies: recA.copies, old: recA.old }, { n: 2, ms: 5200, copies: 1, old: false });
await sleep(700);
const all = host.frames.filter((f) => f.t === 'focus').flatMap((f) => f.records);
assert.ok(all.some((r) => r.pid === C.welcome.pid && r.q === 0 && r.old === true), 'the version-2 phone is not checked');
assert.ok(!all.some((r) => r.pid === B.welcome.pid), 'ignored reports reach nobody');
ok('reports reach the host; a version-2 phone is marked not checked; noise is ignored');

host.send({ t: 'close' });
const reveal = await host.wait((f) => f.t === 'reveal', 6000, 'reveal');
assert.ok(reveal.leaderboard.every((e) => typeof e.rank === 'number' && typeof e.tied === 'boolean'));
const tieA = reveal.leaderboard.find((e) => e.pid === A.welcome.pid);
const tieB = reveal.leaderboard.find((e) => e.pid === B.welcome.pid);
assert.equal(tieA.score === tieB.score, tieA.tied && tieB.tied);
ok('leaderboard carries display ranks with ties');

// A late report for the closed question still counts.
A.send({ t: 'away', q: 0, n: 3, ms: 6000, copies: 1 });
await host.wait((f) => f.t === 'focus' && f.records.some((r) => r.pid === A.welcome.pid && r.n === 3), 4000, 'late report');
ok('a report for the question just closed counts');

// Question 2: Focus check off between questions; it is not checked.
host.send({ t: 'settings', settings: { focusCheck: false } });
await host.wait((f) => f.t === 'settings' && f.settings.focusCheck === false, 4000, 'settings off');
await A.wait((f) => f.t === 'settings' && f.settings.focusCheck === false, 4000, 'phones told');
host.send({ t: 'next' });
await A.wait((f) => f.t === 'intro' && f.question.q === 1, 6000, 'intro q1');
// A phone that comes back during the intro gets what it missed.
const D = open(`${WS}/api/room/${pin}/ws?role=player&v=3&token=${B.welcome.token}`, { Origin: BASE });
const dsync = await D.wait((f) => f.t === 'sync', 6000, 'reconnect sync');
assert.equal(dsync.recap.q, 0);
assert.equal(typeof dsync.recap.points, 'number');
assert.equal('correct' in dsync.recap, false, 'no answer key in a frame before closed');
assert.equal(typeof dsync.recap.right, 'boolean');
ok('a phone back during the next intro gets a recap of the result it missed');
await A.wait((f) => f.t === 'open' && f.q === 1, 8000, 'open q1');
A.send({ t: 'away', q: 1, n: 1, ms: 3000 });
await sleep(800);
assert.ok(!host.frames.filter((f) => f.t === 'focus').flatMap((f) => f.records).some((r) => r.q === 1), 'unchecked question ignored');
ok('a question opened with Focus check off is not checked');

host.send({ t: 'close' });
await host.wait((f) => f.t === 'reveal' && f.q === 1, 6000, 'reveal q1');
host.send({ t: 'end' });
const ended = await A.wait((f) => f.t === 'ended', 6000, 'ended');
assert.equal(ended.played, true);
const res = await host.wait((f) => f.t === 'results_csv', 6000, 'results');
const lines = res.csv.trim().split('\r\n');
assert.ok(lines[0].includes('q1 left page,q2 left page,times left page,seconds away,copies blocked'), lines[0]);
const rowOf = (nick) => lines.find((l) => l.split(',')[1] === nick).split(',');
assert.deepEqual(rowOf('Asha').slice(-5), ['3x 6 s', '', '3', '6', '1']);
assert.deepEqual(rowOf('Bilal').slice(-5), ['0', '', '0', '0', '0']);
assert.deepEqual(rowOf('Chen').slice(-5), ['not checked', '', '0', '0', '0']);
ok('the CSV has Focus check columns for checked questions only');

host.send({ t: 'ack_results' });
await host.wait((f) => f.t === 'wiped', 6000, 'wiped');
for (const s of [host, A, B, C, D]) { try { s.ws.close(); } catch { /* gone */ } }
console.log(`\n${passed} checks passed against ${BASE}`);
process.exit(0);
