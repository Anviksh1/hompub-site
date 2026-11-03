// Tests for public/library.js (the host page's copy of the quiz library, PROTOCOL.md §12).
// Run with: node --test quiz/test/library-client.test.mjs   (Node 22; no dependencies)
//
// library.js is a classic browser script, loaded into a vm context. A small fake of the
// /api/library endpoints stands in for the server (same rules as src/library.ts), and a
// Map-backed object stands in for localStorage, so two "browsers" or two "tabs" can share one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'public', 'library.js'), 'utf8');

function loadApi() {
  const mod = { exports: {} };
  // Timers are inert: the tests call sync() themselves.
  const sandbox = { module: mod, crypto: webcrypto, TextEncoder, console, setTimeout: () => 0, clearTimeout: () => {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'library.js' });
  return mod.exports;
}
const Lib = loadApi();
const plain = (v) => JSON.parse(JSON.stringify(v));
const sha = (text) => createHash('sha256').update(text).digest('hex');

class FakeStorage {
  constructor() { this.map = new Map(); this.blocked = false; }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { if (this.blocked) throw new Error('QuotaExceededError'); this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

/** The /api/library rules of src/library.ts, in memory. */
function fakeServer() {
  const srv = { generation: 1, rows: new Map(), signedIn: true, down: false, calls: [] };
  const meta = (id, r) => ({ id, title: r.body.title, schema: r.body.schema || 1, questions: r.body.questions.length, version: r.version, hash: r.hash, updatedAt: r.updatedAt, deletedAt: r.deletedAt });
  const reply = (status, body) => ({ status, json: async () => (body === undefined ? null : body) });
  let clock = 1_000_000;
  srv.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    srv.calls.push(`${method} ${url}`);
    if (srv.down) throw new TypeError('Failed to fetch');
    if (!srv.signedIn) return reply(401, { error: 'sign_in' });
    const u = new URL(url, 'http://x');
    const g = { generation: srv.generation };
    if (u.pathname === '/api/library') {
      const all = [...srv.rows].map(([id, r]) => meta(id, r));
      return reply(200, { ...g, quizzes: all.filter((m) => !m.deletedAt), trash: all.filter((m) => m.deletedAt) });
    }
    if (u.pathname === '/api/library/quizzes') {
      const ids = u.searchParams.get('ids').split(',');
      return reply(200, { ...g, quizzes: ids.filter((id) => srv.rows.has(id)).map((id) => ({ ...meta(id, srv.rows.get(id)), body: plain(srv.rows.get(id).body) })) });
    }
    const m = u.pathname.match(/^\/api\/library\/quizzes\/([^/]+)(\/restore)?$/);
    const id = decodeURIComponent(m[1]);
    const claimed = method === 'PUT' ? JSON.parse(init.body).generation : u.searchParams.get('generation');
    if (claimed !== undefined && claimed !== null && claimed !== '' && Number(claimed) !== srv.generation) return reply(409, { ...g, error: 'generation_changed' });
    const r = srv.rows.get(id);
    const withBody = (x) => ({ ...meta(id, x), body: plain(x.body) });
    if (m[2]) {
      if (!r) return reply(404, { ...g, error: 'gone' });
      if (r.deletedAt) { r.deletedAt = null; r.version += 1; }
      return reply(200, { ...g, quiz: meta(id, r) });
    }
    if (method === 'PUT') {
      const { baseVersion, quiz } = JSON.parse(init.body);
      const text = JSON.stringify(quiz);
      const hash = sha(text);
      if (baseVersion === 0) {
        if (r) return reply(409, { ...g, error: 'conflict', server: withBody(r) });
        srv.rows.set(id, { body: JSON.parse(text), version: 1, hash, updatedAt: ++clock, deletedAt: null });
        return reply(200, { ...g, quiz: meta(id, srv.rows.get(id)) });
      }
      if (!r) return reply(409, { ...g, error: 'gone', server: null });
      if ((r.body.schema || 1) > (quiz.schema || 1)) return reply(409, { ...g, error: 'newer_schema', server: withBody(r) });
      if (r.version !== baseVersion) return reply(409, { ...g, error: 'conflict', server: withBody(r) });
      if (r.hash !== hash || r.deletedAt) Object.assign(r, { body: JSON.parse(text), hash, version: r.version + 1, updatedAt: ++clock, deletedAt: null });
      return reply(200, { ...g, quiz: meta(id, r) });
    }
    if (method === 'DELETE') {
      if (u.searchParams.get('forever') === '1') {
        if (r && !r.deletedAt) return reply(409, { ...g, error: 'not_in_trash', server: meta(id, r) });
        if (r) srv.rows.delete(id);
        return reply(200, g);
      }
      const base = Number(u.searchParams.get('baseVersion'));
      if (!r || r.deletedAt) return reply(200, { ...g, quiz: r ? meta(id, r) : null });
      if (r.version !== base) return reply(409, { ...g, error: 'conflict', server: withBody(r) });
      r.deletedAt = ++clock; r.version += 1;
      return reply(200, { ...g, quiz: meta(id, r) });
    }
    return reply(405, {});
  };
  return srv;
}

let tick = 5_000_000;
function browser(srv, storage, extra = {}) {
  return Lib.createLibrary({ storage, fetch: (u, i) => srv.fetch(u, i), now: () => ++tick, locks: null, tabId: extra.tabId || 'tab-' + tick, onChange: () => {} });
}
const quiz = (title, extra = {}) => ({ title, questions: [{ text: 'Q?', options: ['a', 'b'], correct: 0, timeLimit: 20, points: 1000 }], ...extra });

test('bodyOf drops this page\'s own fields and keeps unknown ones', () => {
  assert.deepEqual(plain(Lib.bodyOf({ id: 'x', title: 'T', questions: [], updatedAt: 1, exportedAt: 2, future: 3 })), { title: 'T', questions: [], future: 3 });
});

test('quizHash matches the server: SHA-256 of JSON.stringify(body)', async () => {
  const body = quiz('Hash me');
  assert.equal(await Lib.quizHash(body), sha(JSON.stringify(body)));
});

test('create, edit and sync: one key per quiz, versions follow the server', async () => {
  const srv = fakeServer();
  const st = new FakeStorage();
  const lib = browser(srv, st);
  const e = lib.create(quiz('One'));
  assert.ok(st.getItem('hompub-quiz:lib:q:' + e.id));
  assert.equal(lib.pendingCount(), 1);
  await lib.sync();
  assert.equal(lib.status(), 'synced');
  assert.equal(lib.get(e.id).version, 1);
  assert.equal(lib.pendingCount(), 0);
  lib.get(e.id).body.title = 'One, edited';
  lib.touch(e.id);
  await lib.sync();
  assert.equal(srv.rows.get(e.id).body.title, 'One, edited');
  assert.equal(lib.get(e.id).version, 2);
});

test('an edit made on another device first is never overwritten: mine, theirs, or a copy', async () => {
  for (const choice of ['mine', 'theirs', 'copy']) {
    const srv = fakeServer();
    const a = browser(srv, new FakeStorage());
    const e = a.create(quiz('Shared'));
    await a.sync();
    const bStore = new FakeStorage();
    const b = browser(srv, bStore);
    await b.sync();
    // Both edit version 1; A saves first.
    a.get(e.id).body.title = 'From A'; a.touch(e.id); await a.sync();
    b.get(e.id).body.title = 'From B'; b.touch(e.id); await b.sync();
    assert.equal(b.status(), 'conflict', choice);
    const c = b.conflicts();
    assert.equal(c.length, 1);
    assert.equal(c[0].server.body.title, 'From A');
    assert.equal(srv.rows.get(e.id).body.title, 'From A', 'nothing overwritten before the choice');
    const copy = b.resolve(e.id, choice);
    await b.sync();
    if (choice === 'mine') assert.equal(srv.rows.get(e.id).body.title, 'From B');
    if (choice === 'theirs') { assert.equal(srv.rows.get(e.id).body.title, 'From A'); assert.equal(b.get(e.id).body.title, 'From A'); }
    if (choice === 'copy') {
      assert.equal(srv.rows.get(e.id).body.title, 'From A');
      assert.equal(srv.rows.get(copy.id).body.title, 'From B (my copy)');
    }
    assert.equal(b.conflicts().length, 0);
  }
});

test('two tabs of one browser do not conflict with themselves', async () => {
  const srv = fakeServer();
  const st = new FakeStorage();
  const t1 = browser(srv, st, { tabId: 't1' });
  const e = t1.create(quiz('Tabs'));
  await t1.sync();
  const t2 = browser(srv, st, { tabId: 't2' });   // loads the same storage
  t1.get(e.id).body.title = 'Tab 1'; t1.touch(e.id); await t1.sync();
  // Tab 2 missed the storage event and edits from version 1.
  t2.get(e.id).body.title = 'Tab 2'; t2.touch(e.id); await t2.sync();
  assert.equal(t2.conflicts().length, 0);
  assert.equal(srv.rows.get(e.id).body.title, 'Tab 2');
});

test('the same content saved elsewhere is not a conflict', async () => {
  const srv = fakeServer();
  const a = browser(srv, new FakeStorage());
  const e = a.create(quiz('Same'));
  await a.sync();
  const b = browser(srv, new FakeStorage());
  await b.sync();
  a.get(e.id).body.title = 'Both'; a.touch(e.id); await a.sync();
  b.get(e.id).body.title = 'Both'; b.touch(e.id); await b.sync();
  assert.equal(b.conflicts().length, 0);
  assert.equal(b.status(), 'synced');
});

test('Trash: delete, restore, delete for good; a delete never removes another device\'s newer edit', async () => {
  const srv = fakeServer();
  const a = browser(srv, new FakeStorage());
  const e = a.create(quiz('Bin me'));
  await a.sync();
  a.remove(e.id); await a.sync();
  assert.ok(srv.rows.get(e.id).deletedAt);
  assert.equal(a.trash().length, 1);
  a.restore(e.id); await a.sync();
  assert.equal(srv.rows.get(e.id).deletedAt, null);
  // Another device edits; this one deletes from the older version.
  const b = browser(srv, new FakeStorage());
  await b.sync();
  b.get(e.id).body.title = 'Edited on B'; b.touch(e.id); await b.sync();
  a.remove(e.id); await a.sync();
  assert.equal(a.conflicts()[0].kind, 'edited');
  assert.equal(srv.rows.get(e.id).deletedAt, null);
  a.resolve(e.id, 'mine'); await a.sync();          // delete anyway
  assert.ok(srv.rows.get(e.id).deletedAt);
  a.purge(e.id); await a.sync();
  assert.equal(srv.rows.has(e.id), false);
  assert.equal(a.get(e.id), null);
});

test('a restore from backup (new generation) sets the cache aside and reloads', async () => {
  const srv = fakeServer();
  const st = new FakeStorage();
  const a = browser(srv, st);
  const e = a.create(quiz('Before restore'));
  await a.sync();
  a.get(e.id).body.title = 'Unsent edit'; a.touch(e.id);
  srv.rows.get(e.id).body.title = 'Restored copy';
  srv.rows.get(e.id).version = 1;
  srv.generation = 1793000000000;
  await a.sync();
  const n = a.notices().find((x) => x.kind === 'restored');
  assert.ok(n, 'a notice says so');
  const saved = JSON.parse(a.readBackup(n.key));
  assert.equal(saved.entries[0].body.title, 'Unsent edit', 'the unsent edit is kept in the backup');
  assert.equal(a.get(e.id).body.title, 'Restored copy');
  assert.equal(a.pendingCount(), 0, 'nothing from before the restore is sent');
  assert.equal(srv.rows.get(e.id).body.title, 'Restored copy');
});

test('moving the Phase 1 list: once, by id or content, never duplicated, old key untouched', async () => {
  const srv = fakeServer();
  const st = new FakeStorage();
  const old = [
    { id: 'q-old-1', title: 'Old one', questions: quiz('x').questions, updatedAt: 10, exportedAt: 5 },
    { title: 'No id', questions: quiz('x').questions },
    'garbage',
  ];
  st.setItem('hompub-quiz:quizzes', JSON.stringify(old));
  const lib = browser(srv, st);
  const report = await lib.migrateOld();
  assert.deepEqual(plain(report), { found: 2, added: 2, same: 0, conflicts: 0 });
  assert.equal(lib.get('q-old-1').exportedAt, 5);
  // A reload before the server has them: nothing is added twice.
  const again = browser(srv, st);
  assert.equal((await again.migrateOld()).added, 0);
  assert.equal(again.list().length, 2);
  await again.sync();
  assert.equal(srv.rows.size, 2);
  assert.ok(st.getItem('hompub-quiz:lib:migrated'), 'marker set once the server has them');
  assert.equal(st.getItem('hompub-quiz:quizzes'), JSON.stringify(old), 'old key untouched');
  assert.equal(await browser(srv, st).migrateOld(), null);
});

test('moving the Phase 1 list: an id the library holds with other content asks first', async () => {
  const srv = fakeServer();
  const other = browser(srv, new FakeStorage());
  other.create(quiz('Library version'), { id: 'q-same' });
  await other.sync();
  const st = new FakeStorage();
  st.setItem('hompub-quiz:quizzes', JSON.stringify([{ id: 'q-same', title: 'Old browser version', questions: quiz('x').questions }]));
  const lib = browser(srv, st);
  await lib.sync();
  const r = await lib.migrateOld();
  assert.equal(r.conflicts, 1);
  assert.equal(lib.conflicts()[0].kind, 'migrate');
  lib.resolve('q-same', 'copy');
  await lib.sync();
  assert.equal(srv.rows.get('q-same').body.title, 'Library version');
  assert.ok([...srv.rows.values()].some((x) => x.body.title === 'Old browser version (my copy)'));
  assert.ok(st.getItem('hompub-quiz:lib:migrated'));
  assert.equal(await browser(srv, st).migrateOld(), null, 'not asked again');
});

test('a damaged entry is backed up and set aside; the rest still loads', () => {
  const st = new FakeStorage();
  st.setItem('hompub-quiz:lib:q:good', JSON.stringify({ id: 'good', version: 0, body: quiz('Good'), updatedAt: 1, deletedAt: null, dirty: true }));
  st.setItem('hompub-quiz:lib:q:bad', '{not json');
  const lib = browser(fakeServer(), st);
  assert.equal(lib.list().length, 1);
  const n = lib.notices().find((x) => x.kind === 'damaged');
  assert.equal(st.getItem(n.key), '{not json');
  assert.equal(st.getItem('hompub-quiz:lib:q:bad'), null);
});

test('blocked storage: the page keeps working from memory and says so', async () => {
  const srv = fakeServer();
  const st = new FakeStorage();
  st.blocked = true;
  const lib = browser(srv, st);
  const e = lib.create(quiz('In memory'));
  assert.equal(lib.storageBlocked(), true);
  await lib.sync();
  assert.equal(srv.rows.get(e.id).body.title, 'In memory');
});

test('signed out, offline, or an older server: changes wait, with a status that says why', async () => {
  const srv = fakeServer();
  const lib = browser(srv, new FakeStorage());
  lib.create(quiz('Waiting'));
  srv.signedIn = false;
  await lib.sync();
  assert.equal(lib.status(), 'signin');
  srv.signedIn = true; srv.down = true;
  await lib.sync();
  assert.equal(lib.status(), 'offline');
  srv.down = false;
  await lib.sync();
  assert.equal(lib.status(), 'synced');
  assert.equal(lib.pendingCount(), 0);
});

test('deleting for good straight after moving to the Trash removes it from the server', async () => {
  const srv = fakeServer();
  const a = browser(srv, new FakeStorage());
  const e = a.create(quiz('Quick bin'));
  await a.sync();
  a.remove(e.id);
  a.purge(e.id);                                    // before the move to the Trash was sent
  await a.sync();
  assert.equal(srv.rows.has(e.id), false);
  assert.equal(a.get(e.id), null);
});

test('a quiz with a newer schema is read-only and never sent', async () => {
  const srv = fakeServer();
  const a = browser(srv, new FakeStorage());
  const e = a.create(quiz('Future', { schema: 3 }));
  assert.equal(a.readOnly(a.get(e.id)), true);
  assert.equal(a.touch(e.id), false);
  // Schema 2 (Phase 3 question types) is this page's own.
  const two = a.create(quiz('Now', { schema: 2 }));
  assert.equal(a.readOnly(a.get(two.id)), false);
});

test('a quiz moved to the Trash is done once the server has it (nothing left pending)', async () => {
  const srv = fakeServer();
  const a = browser(srv, new FakeStorage());
  const e = a.create(quiz('Bin'));
  await a.sync();
  a.remove(e.id);
  await a.sync();
  assert.equal(a.pendingCount(), 0);
  assert.equal(a.status(), 'synced');
  assert.equal(a.clearCache(), true, 'sign-out can clear this computer');
});

test('one quiz the server refuses does not hold up the others', async () => {
  const srv = fakeServer();
  const a = browser(srv, new FakeStorage());
  const big = a.create(quiz('Refused'));
  const ok = a.create(quiz('Fine'));
  const realFetch = srv.fetch;
  srv.fetch = async (url, init) => (init && init.method === 'PUT' && url.includes(big.id) ? { status: 422, json: async () => ({ generation: srv.generation, error: 'library_full', message: 'full' }) } : realFetch(url, init));
  await a.sync();
  assert.ok(srv.rows.has(ok.id), 'the other quiz went');
  assert.equal(a.status(), 'full');
  srv.fetch = realFetch;
  await a.sync();
  assert.ok(srv.rows.has(big.id), 'tried again on the next sync');
});

test('"Delete for good" of a quiz restored on another device keeps it and says so', async () => {
  const srv = fakeServer();
  const a = browser(srv, new FakeStorage());
  const e = a.create(quiz('Back again'));
  await a.sync();
  a.remove(e.id);
  await a.sync();
  const b = browser(srv, new FakeStorage());
  await b.sync();
  b.restore(e.id);
  await b.sync();
  a.purge(e.id);
  a.create(quiz('Later edit'));
  await a.sync();
  assert.ok(srv.rows.has(e.id), 'not deleted');
  assert.ok(a.get(e.id) && !a.get(e.id).deletedAt, 'shown again here');
  assert.ok(a.notices().some((n) => n.kind === 'kept'));
  assert.ok([...srv.rows.values()].some((r) => r.body.title === 'Later edit'), 'later changes still go');
});

test('an in-flight sync never writes over a newer edit another tab made meanwhile', async () => {
  const srv = fakeServer();
  const st = new FakeStorage();
  const t1 = browser(srv, st, { tabId: 'a' });
  const e = t1.create(quiz('typed 1'));
  await t1.sync();
  const t2 = browser(srv, st, { tabId: 'b' });
  t1.get(e.id).body.title = 'typed 1 and 2';
  t1.touch(e.id);
  // While tab 1's PUT is out, tab 2 types more (and tab 1 hears of it through a storage event).
  const realFetch = srv.fetch;
  srv.fetch = async (url, init) => {
    if (init && init.method === 'PUT') {
      t2.onStorage('hompub-quiz:lib:q:' + e.id);
      t2.get(e.id).body.title = 'typed 1 and 2 and 3';
      t2.touch(e.id);
      t1.onStorage('hompub-quiz:lib:q:' + e.id);
    }
    return realFetch(url, init);
  };
  await t1.sync();
  srv.fetch = realFetch;
  assert.equal(JSON.parse(st.getItem('hompub-quiz:lib:q:' + e.id)).body.title, 'typed 1 and 2 and 3');
  await t1.sync();
  assert.equal(srv.rows.get(e.id).body.title, 'typed 1 and 2 and 3');
});

test('a delete made here survives the same edit saved on another device', async () => {
  const srv = fakeServer();
  const a = browser(srv, new FakeStorage());
  const e = a.create(quiz('Twin'));
  await a.sync();
  const b = browser(srv, new FakeStorage());
  await b.sync();
  a.get(e.id).body.title = 'Same edit'; a.touch(e.id); a.remove(e.id);
  b.get(e.id).body.title = 'Same edit'; b.touch(e.id); await b.sync();
  await a.sync();
  assert.ok(srv.rows.get(e.id).deletedAt, 'still deleted on the server');
  assert.ok(a.get(e.id).deletedAt);
});

test('moving the Phase 1 list: an unanswered clash is asked again after a reload', async () => {
  const srv = fakeServer();
  const other = browser(srv, new FakeStorage());
  other.create(quiz('Library version'), { id: 'q-clash' });
  await other.sync();
  const st = new FakeStorage();
  st.setItem('hompub-quiz:quizzes', JSON.stringify([{ id: 'q-clash', title: 'Old version', questions: quiz('x').questions }]));
  const lib = browser(srv, st);
  await lib.sync();
  await lib.migrateOld();
  assert.equal(lib.conflicts().length, 1);
  const again = browser(srv, st);          // reload before choosing
  await again.sync();
  assert.equal(st.getItem('hompub-quiz:lib:migrated'), null, 'not marked as moved');
  await again.migrateOld();
  assert.equal(again.conflicts().length, 1, 'asked again');
});

test('a damaged entry can be downloaded as it was', () => {
  const st = new FakeStorage();
  st.setItem('hompub-quiz:lib:q:cut', '{"id":"cut","version":3,"body":{"title":"Half a qu');
  const lib = browser(fakeServer(), st);
  const n = lib.notices().find((x) => x.kind === 'damaged');
  assert.equal(lib.readBackup(n.key), '{"id":"cut","version":3,"body":{"title":"Half a qu');
});
