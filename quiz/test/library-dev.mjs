// Checks the quiz library API (PROTOCOL.md §12) against a running server.
//   npx wrangler d1 migrations apply DB --local && npm run dev     (in one terminal)
//   node test/library-dev.mjs --base http://127.0.0.1:8787 --passcode "…" [--cap]
// It signs in, creates quizzes with ids unique to this run, and deletes them for good
// at the end. --cap also fills the library to its 500-quiz limit (slow; local only).
import assert from 'node:assert/strict';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => {
  if (v.startsWith('--')) a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return a;
}, []));
const BASE = String(args.base || 'http://127.0.0.1:8787').replace(/\/$/, '');
const PASS = String(args.passcode || process.env.HOST_PASSCODE || '');
if (!PASS) { console.error('Pass --passcode or set HOST_PASSCODE.'); process.exit(2); }

let cookie = '';
async function call(method, path, body, opts = {}) {
  const headers = { origin: opts.origin ?? BASE };
  if (cookie && !opts.anon) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

const run = Date.now().toString(36);
const id = (n) => `t${run}-${n}`;
const quiz = (title, extra = {}) => ({ title, questions: [{ text: 'What is 2 + 2?', options: ['3', '4'], correct: 1, timeLimit: 20, points: 1000 }], ...extra });
const made = [];
let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log('ok  ', name);
}

await step('signed out: 401; foreign Origin: 403', async () => {
  assert.equal((await call('GET', '/api/library', undefined, { anon: true })).status, 401);
  assert.equal((await call('GET', '/api/library', undefined, { origin: 'https://evil.example' })).status, 403);
});

await step('sign in', async () => {
  const r = await call('POST', '/api/session', { passcode: PASS });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(cookie.startsWith('__Host-hq_session='));
});

let generation;
await step('list carries the generation, quizzes and trash', async () => {
  const r = await call('GET', '/api/library');
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.generation, 'number');
  assert.ok(Array.isArray(r.json.quizzes) && Array.isArray(r.json.trash));
  generation = r.json.generation;
});

const A = id('a');
await step('create (baseVersion 0), unknown fields kept', async () => {
  const r = await call('PUT', `/api/library/quizzes/${A}`, { baseVersion: 0, quiz: quiz('First', { future: { x: 1 } }) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  made.push(A);
  assert.equal(r.json.quiz.version, 1);
  assert.equal(r.json.generation, generation);
  const g = await call('GET', `/api/library/quizzes?ids=${A}`);
  assert.deepEqual(g.json.quizzes[0].body, quiz('First', { future: { x: 1 } }));
});

await step('a second create of the same id is a conflict with the server copy', async () => {
  const r = await call('PUT', `/api/library/quizzes/${A}`, { baseVersion: 0, quiz: quiz('Other') });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'conflict');
  assert.equal(r.json.server.body.title, 'First');
});

await step('update from the current version; a stale version is refused', async () => {
  const r = await call('PUT', `/api/library/quizzes/${A}`, { baseVersion: 1, quiz: quiz('Second') });
  assert.equal(r.status, 200);
  assert.equal(r.json.quiz.version, 2);
  const stale = await call('PUT', `/api/library/quizzes/${A}`, { baseVersion: 1, quiz: quiz('Lost?') });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.server.version, 2);
  assert.equal(stale.json.server.body.title, 'Second');
});

await step('saving unchanged content does not bump the version', async () => {
  const r = await call('PUT', `/api/library/quizzes/${A}`, { baseVersion: 2, quiz: quiz('Second') });
  assert.equal(r.status, 200);
  assert.equal(r.json.quiz.version, 2);
});

await step('delete needs the current version, then goes to the Trash', async () => {
  assert.equal((await call('DELETE', `/api/library/quizzes/${A}?baseVersion=1`)).status, 409);
  const r = await call('DELETE', `/api/library/quizzes/${A}?baseVersion=2`);
  assert.equal(r.status, 200);
  assert.equal(r.json.quiz.version, 3);
  assert.ok(r.json.quiz.deletedAt);
  const l = await call('GET', '/api/library');
  assert.ok(l.json.trash.some((q) => q.id === A));
  assert.ok(!l.json.quizzes.some((q) => q.id === A));
  assert.equal((await call('DELETE', `/api/library/quizzes/${A}?baseVersion=2`)).status, 200, 'deleting again is harmless');
});

await step('restore takes it out of the Trash', async () => {
  const r = await call('POST', `/api/library/quizzes/${A}/restore`);
  assert.equal(r.status, 200);
  assert.equal(r.json.quiz.deletedAt, null);
  assert.equal(r.json.quiz.version, 4);
});

await step('a newer schema is never replaced by an older one', async () => {
  const r = await call('PUT', `/api/library/quizzes/${A}`, { baseVersion: 4, quiz: { schema: 2, title: 'Future', questions: [{ kind: 'new' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.quiz.schema, 2);
  const down = await call('PUT', `/api/library/quizzes/${A}`, { baseVersion: 5, quiz: quiz('Older page') });
  assert.equal(down.status, 409);
  assert.equal(down.json.error, 'newer_schema');
});

await step('deleted for good: only from the Trash, and a later save is told the quiz is gone', async () => {
  const live = await call('DELETE', `/api/library/quizzes/${A}?forever=1`);
  assert.equal(live.status, 409);
  assert.equal(live.json.error, 'not_in_trash');
  await call('DELETE', `/api/library/quizzes/${A}?baseVersion=5`);
  assert.equal((await call('DELETE', `/api/library/quizzes/${A}?forever=1`)).status, 200);
  const r = await call('PUT', `/api/library/quizzes/${A}`, { baseVersion: 6, quiz: quiz('Mine') });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'gone');
  assert.equal(r.json.server, null);
  made.splice(made.indexOf(A), 1);
});

await step('a change from another generation (before a restore from backup) is refused', async () => {
  const B = id('gen');
  const r = await call('PUT', `/api/library/quizzes/${B}`, { baseVersion: 0, generation: generation + 1, quiz: quiz('Old copy') });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'generation_changed');
  assert.equal(r.json.generation, generation);
  const ok2 = await call('PUT', `/api/library/quizzes/${B}`, { baseVersion: 0, generation, quiz: quiz('Current copy') });
  assert.equal(ok2.status, 200);
  made.push(B);
  assert.equal((await call('DELETE', `/api/library/quizzes/${B}?baseVersion=1&generation=${generation + 1}`)).status, 409);
});

await step('bad input: size, shape, ids, baseVersion', async () => {
  const big = quiz('Big', { questions: [{ text: 'x'.repeat(210 * 1024), options: ['a', 'b'], correct: 0, timeLimit: 20, points: 1000 }] });
  assert.equal((await call('PUT', `/api/library/quizzes/${id('big')}`, { baseVersion: 0, quiz: big })).status, 413);
  assert.equal((await call('PUT', `/api/library/quizzes/${id('bad')}`, { baseVersion: 0, quiz: { title: 'x', questions: 'no' } })).status, 400);
  assert.equal((await call('PUT', `/api/library/quizzes/${id('bad')}`, { quiz: quiz('x') })).status, 400);
  assert.equal((await call('PUT', '/api/library/quizzes/bad%20id', { baseVersion: 0, quiz: quiz('x') })).status, 404);
  assert.equal((await call('GET', '/api/library/quizzes?ids=')).status, 400);
  assert.equal((await call('PUT', `/api/library/quizzes/${id('bad')}`, '{"baseVersion":0,')).status, 400);
});

if (args.cap) {
  await step('the 500-quiz cap', async () => {
    const before = (await call('GET', '/api/library')).json.quizzes.length;
    let n = 0;
    for (; before + n < 500; n++) {
      const r = await call('PUT', `/api/library/quizzes/${id('cap' + n)}`, { baseVersion: 0, quiz: quiz('Cap ' + n) });
      assert.equal(r.status, 200);
      made.push(id('cap' + n));
    }
    const over = await call('PUT', `/api/library/quizzes/${id('over')}`, { baseVersion: 0, quiz: quiz('Over') });
    assert.equal(over.status, 422);
    assert.equal(over.json.error, 'library_full');
  });
}

// Clean up: Trash, then delete for good.
const list = (await call('GET', '/api/library')).json;
for (const q of list.quizzes.filter((x) => made.includes(x.id))) {
  await call('DELETE', `/api/library/quizzes/${q.id}?baseVersion=${q.version}`);
  await call('DELETE', `/api/library/quizzes/${q.id}?forever=1`);
}
console.log(`\n${passed} checks passed against ${BASE}`);
