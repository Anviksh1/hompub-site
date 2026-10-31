/*
  HomPub Quiz — library.js. MIT licence. Part of HomPub Quiz.

  The host page's copy of the synced quiz library (PROTOCOL.md §12). Classic
  script, plain ES2020, no dependencies. It defines window.HomPubLibrary (and
  module.exports when `module` exists, so node --test can load it) with:

    bodyOf(quiz)        -> the stored body: the quiz minus this page's own fields
    quizHash(body)      -> Promise<hex>: SHA-256 of JSON.stringify(body), as the server computes it
    createLibrary(deps) -> a Library: the cache, the changes not yet sent, sync with the server

  Every quiz is one localStorage key, so two tabs never overwrite each other's
  list (P0-32), and one damaged entry is backed up and set aside instead of
  blanking the page (P0-33). Each entry remembers the server version its body
  is based on; a change made from an older version than the server's is never
  sent over it: the page is asked (conflicts) instead.
*/
(function () {
'use strict';

const KEYS = {
  index: 'hompub-quiz:lib:index',       // {generation, ids, syncedAt}
  quiz: 'hompub-quiz:lib:q:',           // + id: one Entry
  outbox: 'hompub-quiz:lib:outbox',     // {id: queuedAt}: entries with changes not yet on the server
  migrating: 'hompub-quiz:lib:migrating', // ids copied from the old key, until the server has them all
  migrated: 'hompub-quiz:lib:migrated', // set once the old key's quizzes are on the server
  backup: 'hompub-quiz:backup:',        // + time: copies kept when something could not be used as it was
  old: 'hompub-quiz:quizzes',           // Phase 1: the whole list in one key (left untouched)
};
const KNOWN_SCHEMA = 1;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BATCH = 50;
const LOCAL_FIELDS = ['id', 'updatedAt', 'exportedAt', 'version', 'hash'];
const FLUSH_DELAY_MS = 2500;   // after the last edit
const FLUSH_MAX_MS = 15000;    // ...but at least this often while typing
const PUSHED_KEEP = 5;         // hashes this browser saved per quiz, to recognise its own versions

/* ===================================================================== pure helpers */

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** The body the library stores: every field of the quiz except the ones this page adds. */
function bodyOf(quiz) {
  const out = {};
  for (const k of Object.keys(quiz || {})) if (!LOCAL_FIELDS.includes(k)) out[k] = quiz[k];
  if (typeof out.title !== 'string') out.title = out.title == null ? '' : String(out.title);
  if (!Array.isArray(out.questions)) out.questions = [];
  return out;
}

async function quizHash(body) {
  const data = new TextEncoder().encode(JSON.stringify(body));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function newId() {
  try { return crypto.randomUUID(); } catch (e) { return 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
}

/** Does this stored value look like an Entry this page can use? */
function validEntry(e) {
  return isObject(e) && typeof e.id === 'string' && ID_RE.test(e.id) && isObject(e.body) && Array.isArray(e.body.questions)
    && Number.isInteger(e.version) && e.version >= 0;
}

function schemaOf(body) { return isObject(body) && Number.isInteger(body.schema) ? body.schema : 1; }

/* ===================================================================== the library */

/**
 * deps: {
 *   storage: a Storage (localStorage), or null when the browser blocks it;
 *   fetch: window.fetch;  now(): ms;  locks: navigator.locks or null;
 *   onChange(): something the page shows changed;
 *   tabId: a string unique to this tab (for the fallback lock).
 * }
 */
function createLibrary(deps) {
  const now = deps.now || (() => Date.now());
  const memory = new Map();            // stands in for localStorage when it is blocked
  let storageBlocked = !deps.storage;
  const entries = new Map();
  let outbox = {};
  let generation = null;
  let syncedAt = 0;
  const conflicts = new Map();         // id -> {kind, server, mine}
  const errors = new Map();            // id -> message (a change the server refused)
  const notices = [];                  // {kind, ...} for banners
  let status = 'local';                // see statusText()
  let flushTimer = null;
  let firstQueuedAt = 0;
  let syncing = null;
  let wasReset = false;                // the cache was dropped after a restore; fetch everything again

  /* ---------- storage (every access guarded; a blocked browser keeps working from memory) ---------- */

  function sGet(key) {
    if (deps.storage) { try { return deps.storage.getItem(key); } catch (e) { storageBlocked = true; } }
    return memory.has(key) ? memory.get(key) : null;
  }
  function sSet(key, value) {
    memory.set(key, value);
    if (!deps.storage) return false;
    try { deps.storage.setItem(key, value); return true; } catch (e) { storageBlocked = true; return false; }
  }
  function sRemove(key) {
    memory.delete(key);
    if (deps.storage) { try { deps.storage.removeItem(key); } catch (e) { /* ignore */ } }
  }
  function sKeys() {
    const out = new Set(memory.keys());
    if (deps.storage) {
      try { for (let i = 0; i < deps.storage.length; i++) { const k = deps.storage.key(i); if (k) out.add(k); } } catch (e) { /* ignore */ }
    }
    return [...out];
  }
  function readJSON(key) {
    const raw = sGet(key);
    if (raw == null) return { ok: true, value: null, raw };
    try { return { ok: true, value: JSON.parse(raw), raw }; } catch (e) { return { ok: false, value: null, raw }; }
  }
  function backup(raw, why) {
    const key = KEYS.backup + now() + (why ? ':' + why : '');
    sSet(key, typeof raw === 'string' ? raw : JSON.stringify(raw));
    return key;
  }

  /** Write one entry. The versions this browser saved are merged with what another tab may have written meanwhile. */
  function saveEntry(e) {
    const stored = readJSON(KEYS.quiz + e.id).value;
    if (isObject(stored) && Array.isArray(stored.pushed)) {
      e.pushed = [...new Set((e.pushed || []).concat(stored.pushed))].slice(0, PUSHED_KEEP * 2);
    }
    return sSet(KEYS.quiz + e.id, JSON.stringify(e));
  }
  function saveIndex() { return sSet(KEYS.index, JSON.stringify({ generation, ids: [...entries.keys()], syncedAt })); }
  function saveOutbox() { return sSet(KEYS.outbox, JSON.stringify(outbox)); }

  /* ---------- load ---------- */

  function load() {
    entries.clear();
    const idx = readJSON(KEYS.index);
    if (idx.ok && isObject(idx.value)) {
      generation = Number.isFinite(idx.value.generation) ? idx.value.generation : null;
      syncedAt = Number(idx.value.syncedAt) || 0;
    } else if (!idx.ok) {
      notices.push({ kind: 'damaged', key: backup(idx.raw, 'index') });
      sRemove(KEYS.index);
    }
    for (const key of sKeys()) {
      if (!key.startsWith(KEYS.quiz)) continue;
      const r = readJSON(key);
      if (r.ok && validEntry(r.value) && key === KEYS.quiz + r.value.id) { entries.set(r.value.id, r.value); continue; }
      // Unreadable: keep the text where the teacher can get it back, and never write over it.
      notices.push({ kind: 'damaged', key: backup(r.raw, 'quiz') });
      sRemove(key);
    }
    const ob = readJSON(KEYS.outbox);
    outbox = ob.ok && isObject(ob.value) ? ob.value : {};
    if (!ob.ok) { notices.push({ kind: 'damaged', key: backup(ob.raw, 'outbox') }); sRemove(KEYS.outbox); }
    for (const id of Object.keys(outbox)) if (!entries.has(id)) delete outbox[id];
  }

  /** Another tab changed a key: take its version (this tab writes every change at once, so storage is the truth). */
  function onStorage(key) {
    if (!key) { load(); return true; }
    if (key === KEYS.outbox) { const ob = readJSON(KEYS.outbox); if (ob.ok) outbox = isObject(ob.value) ? ob.value : {}; return true; }
    if (key === KEYS.index) { const idx = readJSON(KEYS.index); if (idx.ok && isObject(idx.value)) generation = Number.isFinite(idx.value.generation) ? idx.value.generation : generation; return true; }
    if (!key.startsWith(KEYS.quiz)) return false;
    const id = key.slice(KEYS.quiz.length);
    const r = readJSON(key);
    if (r.ok && r.value === null) entries.delete(id);
    else if (r.ok && validEntry(r.value)) entries.set(id, r.value);
    return true;
  }

  /* ---------- reading ---------- */

  function needsSync(e) {
    if (e.purge) return true;
    if (e.version === 0) return !e.deletedAt;                     // never on the server: only a live quiz goes up
    return !!e.dirty || (e.deletedAt || null) !== (e.serverDeletedAt || null);
  }
  function readOnly(e) { return schemaOf(e.body) > KNOWN_SCHEMA; }
  function list() { return [...entries.values()].filter((e) => !e.deletedAt && !e.purge).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); }
  function trash() { return [...entries.values()].filter((e) => e.deletedAt && !e.purge).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0)); }
  function get(id) { return entries.get(id) || null; }
  function pendingCount() { return Object.keys(outbox).length; }
  /** Queued changes that can be sent now (not waiting for the teacher's choice or refused by the server). */
  function sendable() { return Object.keys(outbox).filter((id) => !conflicts.has(id) && !errors.has(id)).length; }

  /* ---------- local changes ---------- */

  function queue(e) {
    if (needsSync(e)) { if (!outbox[e.id]) outbox[e.id] = now(); }
    else delete outbox[e.id];
    errors.delete(e.id);
    const ok = saveEntry(e);
    saveIndex();
    saveOutbox();
    scheduleFlush();
    return ok;
  }

  /** A new quiz. Returns the entry; `opts.id` keeps a known id (the sample, an old quiz being moved). */
  function create(body, opts) {
    const o = opts || {};
    const id = o.id && ID_RE.test(o.id) && !entries.has(o.id) ? o.id : newId();
    const t = now();
    const e = { id, version: 0, hash: '', serverDeletedAt: null, body: bodyOf(body), updatedAt: o.updatedAt || t, deletedAt: null, exportedAt: o.exportedAt || null, dirty: true, pushed: [] };
    entries.set(id, e);
    queue(e);
    return e;
  }

  /** The body of `id` was changed in place (the editor works on entry.body). Returns false if it could not be stored. */
  function touch(id) {
    const e = entries.get(id);
    if (!e || readOnly(e)) return false;
    e.dirty = true;
    e.updatedAt = now();
    return queue(e);
  }

  function markExported(id) {
    const e = entries.get(id);
    if (!e) return;
    e.exportedAt = now();
    saveEntry(e);                     // this page's own note: not a change to the quiz
  }

  function remove(id) {
    const e = entries.get(id);
    if (!e || e.deletedAt) return;
    e.deletedAt = now();
    queue(e);
  }
  function restore(id) {
    const e = entries.get(id);
    if (!e || !e.deletedAt) return;
    e.deletedAt = null;
    queue(e);
  }
  /** Delete for good, from the Trash. */
  function purge(id) {
    const e = entries.get(id);
    if (!e) return;
    if (e.version === 0) { forget(id); return; }
    e.purge = true;
    queue(e);
  }
  function forget(id) {
    entries.delete(id);
    delete outbox[id];
    conflicts.delete(id);
    errors.delete(id);
    sRemove(KEYS.quiz + id);
    saveIndex();
    saveOutbox();
  }

  /* ---------- talking to the server ---------- */

  async function api(method, path, body) {
    let res;
    try {
      res = await deps.fetch(path, {
        method, cache: 'no-store',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) { return { status: 0, body: null }; }
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, body: json };
  }

  /** A reply's generation. Returns false (and resets the cache) when the library was restored from a backup. */
  async function checkGeneration(reply) {
    const g = reply.body && Number.isFinite(reply.body.generation) ? reply.body.generation : null;
    if (g === null) return true;
    if (generation === null) { generation = g; saveIndex(); return true; }
    if (g === generation) return true;
    // Restored from a backup: everything cached here, and every change not sent, is from before it.
    const saved = { reason: 'library restored from a backup', generation, entries: [...entries.values()] };
    const key = backup(JSON.stringify(saved), 'restore');
    for (const id of [...entries.keys()]) sRemove(KEYS.quiz + id);
    entries.clear();
    outbox = {};
    conflicts.clear();
    errors.clear();
    generation = g;
    saveOutbox();
    saveIndex();
    notices.push({ kind: 'restored', key, count: saved.entries.length });
    wasReset = true;
    return false;
  }

  /** The generation for a change's query string (`sep` is ? or &), empty until a reply has told us. */
  function genParam(sep) { return generation === null ? '' : (sep || '&') + 'generation=' + generation; }

  /** The quiz's own saved versions, including those another tab of this browser saved just now. */
  function pushedHashes(e) {
    const stored = readJSON(KEYS.quiz + e.id).value;
    return (e.pushed || []).concat(isObject(stored) && Array.isArray(stored.pushed) ? stored.pushed : []);
  }

  function fail(reply) {
    if (reply.status === 401) status = 'signin';
    else if (reply.status === 404) status = 'old-server';
    else if (reply.status === 0) status = 'offline';
    else status = 'unavailable';
  }

  function adoptServer(e, meta, body) {
    e.version = meta.version;
    e.hash = meta.hash;
    e.serverDeletedAt = meta.deletedAt || null;
    if (body !== undefined) {
      e.body = isObject(body) ? body : e.body;
      e.updatedAt = meta.updatedAt || e.updatedAt;
      e.deletedAt = meta.deletedAt || null;
      e.dirty = false;
    }
  }
  function rememberPushed(e, hash) {
    e.pushed = [hash].concat((e.pushed || []).filter((h) => h !== hash)).slice(0, PUSHED_KEEP);
  }

  /** Send one entry's changes. Returns 'ok', 'stop' (try later) or 'conflict'. */
  async function sendOne(e) {
    if (e.purge) {
      // Only a quiz in the server's Trash can be deleted for good: move it there first if that was not sent yet.
      if (!e.serverDeletedAt) {
        const t = await api('DELETE', `/api/library/quizzes/${encodeURIComponent(e.id)}?baseVersion=${e.version}${genParam()}`);
        if (!(await checkGeneration(t))) return 'stop';
        if (t.status === 409 && t.body && t.body.server) {
          e.purge = false;
          conflicts.set(e.id, { kind: 'edited', server: t.body.server, mine: e.body });
          saveEntry(e);
          return 'conflict';
        }
        if (t.status !== 200) { fail(t); return 'stop'; }
        if (t.body && t.body.quiz) adoptServer(e, t.body.quiz);
        else e.serverDeletedAt = e.deletedAt || now();
      }
      const r = await api('DELETE', `/api/library/quizzes/${encodeURIComponent(e.id)}?forever=1${genParam()}`);
      if (!(await checkGeneration(r))) return 'stop';
      if (r.status !== 200) { fail(r); return 'stop'; }
      forget(e.id);
      return 'ok';
    }
    const wantDeleted = !!e.deletedAt;
    // A live quiz with changes (or one taken out of the Trash with changes): PUT.
    if (e.dirty || (e.version === 0 && !wantDeleted)) {
      const text = JSON.stringify(e.body);
      const r = await api('PUT', `/api/library/quizzes/${encodeURIComponent(e.id)}`, { baseVersion: e.version, generation, quiz: e.body });
      if (!(await checkGeneration(r))) return 'stop';
      if (r.status === 200 && r.body && r.body.quiz) {
        adoptServer(e, r.body.quiz);
        rememberPushed(e, r.body.quiz.hash);
        if (JSON.stringify(e.body) === text) e.dirty = false;    // edits made while it was in flight go next time
        if (wantDeleted) e.serverDeletedAt = null;                 // PUT takes it out of the Trash; the delete follows
      } else if (r.status === 409 && r.body) {
        const server = r.body.server || null;
        // The server's copy is one this browser saved (another tab sent it first): ours follows from it.
        if (server && r.body.error === 'conflict' && pushedHashes(e).includes(server.hash)) {
          adoptServer(e, server);
          return sendOne(e);
        }
        // The same content was saved elsewhere: nothing to choose.
        if (server && r.body.error === 'conflict' && server.hash === await quizHash(e.body)) {
          adoptServer(e, server, server.body);
          e.deletedAt = wantDeleted ? e.deletedAt : null;
        } else {
          conflicts.set(e.id, { kind: r.body.error === 'gone' ? 'gone' : r.body.error === 'newer_schema' ? 'newer' : 'conflict', server, mine: e.body });
          saveEntry(e);
          return 'conflict';
        }
      } else if (r.status === 422) {
        status = 'full';                                           // tried again on the next sync
        return 'stop';
      } else if (r.status === 400 || r.status === 413) {
        errors.set(e.id, (r.body && r.body.message) || (r.status === 413 ? 'This quiz is larger than 200 KB. Shorten some text.' : 'The server refused this quiz.'));
        saveEntry(e);
        return 'ok';
      } else { fail(r); return 'stop'; }
    }
    if (e.version > 0 && wantDeleted && !e.serverDeletedAt) {
      const r = await api('DELETE', `/api/library/quizzes/${encodeURIComponent(e.id)}?baseVersion=${e.version}${genParam()}`);
      if (!(await checkGeneration(r))) return 'stop';
      if (r.status === 200) { if (r.body && r.body.quiz) adoptServer(e, r.body.quiz); else e.serverDeletedAt = e.deletedAt; }
      else if (r.status === 409 && r.body && r.body.server) {
        conflicts.set(e.id, { kind: 'edited', server: r.body.server, mine: e.body });   // changed elsewhere after it was deleted here
        return 'conflict';
      } else { fail(r); return 'stop'; }
    } else if (e.version > 0 && !wantDeleted && e.serverDeletedAt) {
      const r = await api('POST', `/api/library/quizzes/${encodeURIComponent(e.id)}/restore${genParam('?')}`);
      if (!(await checkGeneration(r))) return 'stop';
      if (r.status === 200 && r.body && r.body.quiz) adoptServer(e, r.body.quiz);
      else if (r.status === 404) { e.version = 0; e.dirty = true; return sendOne(e); }   // gone for good: send it again
      else if (r.status === 422) { status = 'full'; return 'stop'; }
      else { fail(r); return 'stop'; }
    }
    saveEntry(e);
    return 'ok';
  }

  async function flush() {
    const ids = Object.keys(outbox).sort((a, b) => outbox[a] - outbox[b]);
    for (const id of ids) {
      const e = entries.get(id);
      if (!e) { delete outbox[id]; continue; }
      if (conflicts.has(id) || errors.has(id)) continue;
      if (readOnly(e)) { delete outbox[id]; continue; }
      const result = await sendOne(e);
      if (entries.has(id)) { if (needsSync(e) && result !== 'ok') outbox[id] = outbox[id] || now(); else if (!needsSync(e)) delete outbox[id]; }
      saveOutbox();
      if (result === 'stop') return false;
    }
    checkMigrated();
    return true;
  }

  async function pull() {
    const r = await api('GET', '/api/library');
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.quizzes)) { fail(r); return false; }
    if (!(await checkGeneration(r))) return pull();
    const metas = [].concat(r.body.quizzes, Array.isArray(r.body.trash) ? r.body.trash : []).filter((m) => m && ID_RE.test(String(m.id)));
    const seen = new Set();
    const want = [];                                  // ids whose body must be fetched
    for (const m of metas) {
      seen.add(m.id);
      const e = entries.get(m.id);
      if (conflicts.has(m.id)) continue;            // a choice is already waiting for this one
      if (!e) { want.push(m.id); continue; }
      if (e.version === m.version) { e.serverDeletedAt = m.deletedAt || null; continue; }
      if (!needsSync(e)) { want.push(m.id); continue; }
      if (pushedHashes(e).includes(m.hash)) { adoptServer(e, m); saveEntry(e); continue; }   // another tab of this browser
      want.push(m.id);                                // local changes on an older version: a conflict, decided below
    }
    for (let i = 0; i < want.length; i += BATCH) {
      const ids = want.slice(i, i + BATCH);
      const g = await api('GET', '/api/library/quizzes?ids=' + ids.map(encodeURIComponent).join(','));
      if (g.status !== 200 || !g.body || !Array.isArray(g.body.quizzes)) { fail(g); return false; }
      if (!(await checkGeneration(g))) return pull();
      for (const q of g.body.quizzes) {
        if (!q || !ID_RE.test(String(q.id)) || !isObject(q.body)) continue;
        const e = entries.get(q.id);
        if (!e) {
          const fresh = { id: q.id, version: 0, hash: '', serverDeletedAt: null, body: q.body, updatedAt: q.updatedAt, deletedAt: null, exportedAt: null, dirty: false, pushed: [] };
          adoptServer(fresh, q, q.body);
          entries.set(q.id, fresh);
          saveEntry(fresh);
        } else if (!needsSync(e)) {
          adoptServer(e, q, q.body);
          saveEntry(e);
        } else if (q.hash === await quizHash(e.body)) {
          adoptServer(e, q, q.body);                  // same content: nothing to choose
          saveEntry(e);
        } else {
          conflicts.set(q.id, { kind: q.deletedAt && !e.deletedAt ? 'deleted' : 'conflict', server: q, mine: e.body });
        }
      }
    }
    // Quizzes deleted for good elsewhere (purged from the Trash).
    for (const e of [...entries.values()]) {
      if (seen.has(e.id) || e.version === 0 || conflicts.has(e.id)) continue;
      if (needsSync(e) && !e.deletedAt && !e.purge) conflicts.set(e.id, { kind: 'gone', server: null, mine: e.body });
      else forget(e.id);
    }
    syncedAt = now();
    saveIndex();
    return true;
  }

  /** One sync at a time per browser: Web Locks where available, else a short lease in storage. */
  function withLock(fn) {
    if (deps.locks && typeof deps.locks.request === 'function') {
      return deps.locks.request('hompub-quiz-library', { ifAvailable: true }, (lock) => (lock ? fn() : null));
    }
    const leaseKey = 'hompub-quiz:lib:lease';
    const lease = readJSON(leaseKey).value;
    const t = now();
    if (isObject(lease) && lease.tab !== deps.tabId && lease.until > t) return Promise.resolve(null);
    sSet(leaseKey, JSON.stringify({ tab: deps.tabId, until: t + 30000 }));
    return Promise.resolve().then(fn).finally(() => {
      const l = readJSON(leaseKey).value;
      if (isObject(l) && l.tab === deps.tabId) sRemove(leaseKey);
    });
  }

  /**
   * Send what is queued, then fetch what changed (`pullToo: false` only sends). Statuses:
   * 'saving', 'synced', 'conflict' (a choice is waiting), 'signin', 'offline', 'unavailable',
   * 'full' (the library is at its limit), 'old-server' (no library on this server), 'local' (not tried yet).
   */
  function sync(pullToo) {
    if (syncing) return syncing;
    clearTimeout(flushTimer); flushTimer = null; firstQueuedAt = 0;
    status = 'saving';
    deps.onChange();
    syncing = withLock(async () => {
      // Learn the generation before sending anything, so no change can land on a restored library.
      if (generation === null && !(await pull())) return;
      const sent = await flush();
      if (wasReset) { wasReset = false; if (!(await pull())) return; }
      else if (!sent) return;
      else if (pullToo !== false && !(await pull())) return;
      status = 'synced';
    }).catch(() => { status = 'offline'; }).finally(() => {
      syncing = null;
      if (status === 'synced' && conflicts.size) status = 'conflict';
      // Another tab held the lock, or edits arrived meanwhile: go again shortly.
      if ((status === 'saving' || status === 'synced') && sendable()) { status = 'saving'; scheduleFlush(); }
      else if (status === 'saving') status = 'synced';
      deps.onChange();
    });
    return syncing;
  }

  function scheduleFlush() {
    if (status === 'signin' || status === 'old-server') { deps.onChange(); return; }
    const t = now();
    if (!firstQueuedAt) firstQueuedAt = t;
    clearTimeout(flushTimer);
    const wait = Math.max(0, Math.min(FLUSH_DELAY_MS, firstQueuedAt + FLUSH_MAX_MS - t));
    flushTimer = setTimeout(() => { flushTimer = null; firstQueuedAt = 0; sync(false); }, wait);
    deps.onChange();
  }

  /* ---------- conflicts ---------- */

  /**
   * choice: 'mine' (send this browser's version over the server's), 'theirs' (take the server's),
   * 'copy' (keep this browser's version as a new quiz, take the server's for this one).
   */
  function resolve(id, choice) {
    const c = conflicts.get(id);
    const e = entries.get(id);
    if (!c || !e) { conflicts.delete(id); return null; }
    conflicts.delete(id);
    let copy = null;
    if (choice === 'copy') {
      const body = bodyOf(c.mine);
      body.title = (String(body.title || 'Untitled quiz').trim() + ' (my copy)').slice(0, 80);
      copy = create(body);
    }
    if (c.kind === 'migrate') {
      // The library's version stays unless the teacher picks the copy from this browser's old list.
      if (choice === 'mine') { e.body = bodyOf(c.mine); e.dirty = true; e.updatedAt = now(); queue(e); }
      markHandled(c.mine);
    } else if (choice === 'mine' && c.kind === 'edited') {
      // Delete anyway: the delete is now based on the other device's version.
      e.version = c.server.version; e.hash = c.server.hash; e.serverDeletedAt = c.server.deletedAt || null; e.dirty = false;
      queue(e);
    } else if (choice === 'mine' && c.kind !== 'newer') {
      if (c.server) { e.version = c.server.version; e.hash = c.server.hash; e.serverDeletedAt = c.server.deletedAt || null; }
      else { e.version = 0; e.hash = ''; e.serverDeletedAt = null; }
      e.deletedAt = null;
      e.dirty = true;
      queue(e);
    } else if (c.server) {
      adoptServer(e, c.server, c.server.body);
      queue(e);
    } else {
      forget(id);
    }
    checkMigrated();
    deps.onChange();
    return copy;
  }

  /* ---------- moving the Phase 1 list (hompub-quiz:quizzes) ---------- */

  /** What has been moved from the old list so far: the ids it gave, and the content hashes dealt with. */
  function migrating() {
    const r = readJSON(KEYS.migrating);
    const v = r.ok && isObject(r.value) ? r.value : {};
    return { ids: Array.isArray(v.ids) ? v.ids : [], handled: Array.isArray(v.handled) ? v.handled : [] };
  }
  function markHandled(body) {
    quizHash(bodyOf(body)).then((h) => {
      const m = migrating();
      if (!m.handled.includes(h)) { m.handled.push(h); sSet(KEYS.migrating, JSON.stringify(m)); }
    });
  }

  /**
   * Copy the quizzes of the Phase 1 key into the library, once per browser. It can run again
   * (after a reload before the server had them all): a quiz moved before is skipped by id, or by
   * content hash when it had no id. A quiz whose id the library already holds with other content
   * becomes a 'migrate' conflict. The old key is never changed.
   */
  async function migrateOld() {
    if (sGet(KEYS.migrated)) return null;
    const r = readJSON(KEYS.old);
    if (r.value === null && r.ok) return null;
    if (!r.ok || !Array.isArray(r.value)) {
      notices.push({ kind: 'damaged-old', key: backup(r.raw, 'old-list') });
      sSet(KEYS.migrated, String(now()));          // nothing usable to move; the text is in the backup
      return null;
    }
    const m = migrating();
    const moved = new Set(m.ids);
    const handled = new Set(m.handled);
    const hashes = new Map();
    for (const e of entries.values()) hashes.set(await quizHash(e.body), e.id);
    const report = { found: 0, added: 0, same: 0, conflicts: 0 };
    for (const item of r.value) {
      if (!isObject(item) || !Array.isArray(item.questions)) continue;
      report.found += 1;
      const body = bodyOf(item);
      const hash = await quizHash(body);
      const id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : null;
      if ((id && moved.has(id)) || handled.has(hash)) { report.same += 1; continue; }
      const have = id ? entries.get(id) : null;
      if (have || hashes.has(hash)) {
        if (have && hashes.get(hash) !== id) { conflicts.set(id, { kind: 'migrate', server: null, mine: body }); report.conflicts += 1; }
        else report.same += 1;
        if (id) moved.add(id);
        if (!have || hashes.get(hash) === id) handled.add(hash);
        continue;
      }
      const e = create(body, { id: id || undefined, updatedAt: Number(item.updatedAt) || undefined, exportedAt: Number(item.exportedAt) || null });
      hashes.set(hash, e.id);
      moved.add(e.id);
      handled.add(hash);
      report.added += 1;
    }
    sSet(KEYS.migrating, JSON.stringify({ ids: [...moved], handled: [...handled] }));
    if (report.added || report.conflicts) notices.push(Object.assign({ kind: 'migrated' }, report));
    checkMigrated();
    return report;
  }

  /** The old list counts as moved once the server has every quiz it gave and no choice is waiting. */
  function checkMigrated() {
    if (sGet(KEYS.migrated)) return;
    const r = readJSON(KEYS.migrating);
    if (!r.ok || !isObject(r.value)) return;
    const ids = migrating().ids;
    if ([...conflicts.values()].some((c) => c.kind === 'migrate')) return;
    const done = ids.every((id) => {
      const e = entries.get(id);
      return !e || (e.version > 0 && !needsSync(e) && !conflicts.has(id));
    });
    if (done) { sSet(KEYS.migrated, String(now())); sRemove(KEYS.migrating); }
  }

  /* ---------- sign-out ---------- */

  /** Remove the cached quizzes from this browser (they are on the server). Only when nothing is waiting to be sent. */
  function clearCache() {
    if (pendingCount()) return false;
    for (const id of [...entries.keys()]) sRemove(KEYS.quiz + id);
    entries.clear();
    conflicts.clear();
    errors.clear();
    syncedAt = 0;
    saveIndex();
    deps.onChange();
    return true;
  }

  load();

  return {
    // reading
    list, trash, get, readOnly, needsSync, pendingCount, sendable,
    conflicts: () => [...conflicts.entries()].map(([id, c]) => Object.assign({ id }, c)),
    error: (id) => errors.get(id) || '',
    notices: () => notices.slice(),
    dismissNotice: (n) => { const i = notices.indexOf(n); if (i >= 0) notices.splice(i, 1); },
    status: () => status,
    setStatus: (s) => { status = s; },
    storageBlocked: () => storageBlocked,
    syncedAt: () => syncedAt,
    readBackup: (key) => readJSON(key).value,
    // changing
    create, touch, markExported, remove, restore, purge, resolve,
    // server
    sync, migrateOld, clearCache, onStorage,
  };
}

const api = { bodyOf, quizHash, createLibrary, KEYS, KNOWN_SCHEMA };
if (typeof window !== 'undefined') window.HomPubLibrary = api;
if (typeof module === 'object' && module && module.exports) module.exports = api;
})();
