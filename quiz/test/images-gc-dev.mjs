// Checks how pictures are tracked and removed (PROTOCOL.md §14) against a LOCAL dev server:
// it edits the local D1 database with `wrangler d1 execute --local` to skip ahead 9 days.
//   npm run dev                                           (in one terminal, in this folder)
//   node test/images-gc-dev.mjs --base http://127.0.0.1:8787 --passcode "…"
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => {
  if (v.startsWith('--')) a.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return a;
}, []));
const BASE = String(args.base || 'http://127.0.0.1:8787').replace(/\/$/, '');
const PASS = String(args.passcode || process.env.HOST_PASSCODE || '');
if (!PASS) { console.error('Pass --passcode or set HOST_PASSCODE.'); process.exit(2); }
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(BASE + '/')) { console.error('Local servers only: this script edits the local database.'); process.exit(2); }

// Each database edit takes a few seconds, after which the dev server may have closed the kept-alive
// connection: retry a request once if the socket was closed under it.
const plainFetch = globalThis.fetch;
const fetch = async (url, init) => {
  try { return await plainFetch(url, init); } catch (e) { if (e?.cause?.code !== 'UND_ERR_SOCKET') throw e; return plainFetch(url, init); }
};

let passed = 0;
const ok = (name) => { passed++; console.log('ok  ', name); };
const sql = (command) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--json', '--command', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).map((r) => r.results);

const signIn = await fetch(`${BASE}/api/session`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ passcode: PASS }) });
assert.equal(signIn.status, 200, 'sign in');
const H = { origin: BASE, cookie: signIn.headers.get('set-cookie').split(';')[0] };
const list = async () => (await fetch(`${BASE}/api/library`, { headers: H })).json();
const recheck = () => sql('UPDATE library SET images_checked_at = NULL');

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005000201a3c5f4e60000000049454e44ae426082', 'hex');
const file = Buffer.concat([png, Buffer.from(`gc-${Date.now()}-${Math.random()}`)]);
const { key } = await (await fetch(`${BASE}/api/images`, { method: 'POST', headers: H, body: file })).json();
const id = `gc-${Date.now()}`;
const gen = (await list()).generation;
const quiz = (withPicture) => ({ schema: 2, title: 'GC', questions: [{ text: 'Q', options: ['a', 'b'], correct: 0, timeLimit: 20, points: 1000, ...(withPicture ? { image: { key, alt: 'dot' } } : {}) }] });
const put = async (baseVersion, withPicture) => (await fetch(`${BASE}/api/library/quizzes/${id}`, { method: 'PUT', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ baseVersion, generation: gen, quiz: quiz(withPicture) }) })).json();
const row = () => sql(`SELECT unused_since FROM images WHERE key = '${key}'`)[0][0];
const refs = () => sql(`SELECT key FROM quiz_images WHERE quiz_id = '${id}'`)[0].map((r) => r.key);

let v = (await put(0, true)).quiz.version;
assert.deepEqual(refs(), [key]);
assert.equal(row().unused_since, null);
ok('saving a quiz records the picture it uses');

const stale = await fetch(`${BASE}/api/library/quizzes/${id}`, { method: 'PUT', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ baseVersion: 99, generation: gen, quiz: quiz(false) }) });
assert.equal(stale.status, 409);
assert.deepEqual(refs(), [key], 'a refused write leaves the record alone');
ok('a refused (conflicting) save changes nothing');

v = (await put(v, false)).quiz.version;
assert.deepEqual(refs(), []);
recheck(); await list();
assert.notEqual(row().unused_since, null);
v = (await put(v, true)).quiz.version;
assert.equal(row().unused_since, null);
ok('taking the picture out marks it unused at the next check; putting it back clears that');

await fetch(`${BASE}/api/library/quizzes/${id}?baseVersion=${v}&generation=${gen}`, { method: 'DELETE', headers: H });
recheck(); await list();
assert.equal(row().unused_since, null);
ok('a quiz in the Trash still uses its picture');

await fetch(`${BASE}/api/library/quizzes/${id}?forever=1&generation=${gen}`, { method: 'DELETE', headers: H });
recheck(); await list();
assert.notEqual(row().unused_since, null);
sql(`UPDATE images SET unused_since = unused_since - 7 * 86400000 WHERE key = '${key}'`);
recheck(); await list();
assert.equal((await fetch(`${BASE}/api/images/${key}`)).status, 200, '7 days unused: kept (Time Travel can still bring the quiz back)');
sql(`UPDATE images SET unused_since = unused_since - 2 * 86400000 WHERE key = '${key}'`);
await list();
assert.equal((await fetch(`${BASE}/api/images/${key}`)).status, 200, 'checked at most hourly');
recheck(); await list();
assert.equal((await fetch(`${BASE}/api/images/${key}`)).status, 404);
assert.equal(row(), undefined);
ok('deleted for good: removed after 8 days unused, not before, at most one check an hour');

console.log(`\n${passed} checks passed against ${BASE}`);
