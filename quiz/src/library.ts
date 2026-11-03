// The synced quiz library (PROTOCOL.md §12): one D1 database, one row per quiz.
// The Worker checks the session and the Origin before calling handleLibrary();
// this module only knows the database. The pure checks at the top are unit-tested
// (test/library.test.ts) and must stay free of Workers-only APIs.
//
// Every change is a version bump, and every write names the version it was based
// on. A write based on an older version is refused with 409 and the server's
// copy, so a page never overwrites another device's edit without asking.

import { LIMITS, QUESTION_TYPES, sha256Hex, usesSchema2Fields, type QuestionType } from './shared.ts';
import { imageKeysOf, refStatements, removeUnusedImages } from './images.ts';

export const LIBRARY = {
  /** Quiz schema this server understands. Newer bodies are stored untouched, unchecked. */
  knownSchema: 2,
  maxLive: 500,            // quizzes not in the Trash
  maxRows: 1000,           // all rows, Trash included (bounds storage at ~200 MB)
  trashMs: 30 * 24 * 60 * 60 * 1000,
  batchIds: 50,            // ids per GET /api/library/quizzes
  envelopeBytes: 1024,     // room for {"baseVersion":…,"quiz":…} around a full-size quiz
} as const;

export const QUIZ_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

export interface CheckedBody {
  text: string;            // what is stored, byte for byte
  title: string;
  schema: number;
  questionCount: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Check a quiz body for storage. Drafts are allowed (an empty question, an
 * unticked answer, text over the hosting limit): the editor shows those as
 * problems, and POST /api/room still runs the strict validateQuiz before a game.
 * Here only the shape and the size are enforced. Unknown fields are kept, and a
 * body with a schema newer than this server knows is stored without looking inside.
 */
export function checkLibraryBody(raw: unknown): Ok<CheckedBody> | Err {
  if (!isObject(raw)) return { ok: false, error: 'The quiz must be an object.' };
  let schema = 1;
  if (raw.schema !== undefined) {
    if (typeof raw.schema !== 'number' || !Number.isInteger(raw.schema) || raw.schema < 1) return { ok: false, error: 'schema must be a whole number from 1.' };
    schema = raw.schema;
  }
  if (typeof raw.title !== 'string') return { ok: false, error: 'title must be text.' };
  const questions = raw.questions;
  if (!Array.isArray(questions)) return { ok: false, error: 'questions must be a list.' };
  if (schema <= LIBRARY.knownSchema) {
    if (questions.length > LIMITS.questions) return { ok: false, error: `A quiz can have at most ${LIMITS.questions} questions.` };
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const where = `Question ${i + 1}`;
      if (!isObject(q)) return { ok: false, error: `${where} must be an object.` };
      if (typeof q.text !== 'string') return { ok: false, error: `${where}: text must be text.` };
      if (q.type !== undefined && !QUESTION_TYPES.includes(q.type as QuestionType)) return { ok: false, error: `${where}: type must be one of ${QUESTION_TYPES.join(', ')}.` };
      const type = (q.type ?? 'single') as QuestionType;
      const texts = (v: unknown, max: number) => Array.isArray(v) && v.length <= max && v.every((o) => typeof o === 'string');
      if (type === 'typein') {
        if (!texts(q.accept, LIMITS.acceptAnswers)) return { ok: false, error: `${where}: accept must be a list of up to ${LIMITS.acceptAnswers} texts.` };
      } else if (!texts(q.options, LIMITS.maxOptions)) {
        return { ok: false, error: `${where}: options must be a list of up to ${LIMITS.maxOptions} texts.` };
      }
      if (type === 'multi') {
        if (!Array.isArray(q.correct) || !q.correct.every((c) => typeof c === 'number' && Number.isFinite(c))) return { ok: false, error: `${where}: correct must be a list of numbers.` };
      } else if (type === 'single' && (typeof q.correct !== 'number' || !Number.isFinite(q.correct))) {
        return { ok: false, error: `${where}: correct must be a number.` };
      }
      for (const k of ['timeLimit', 'points'] as const) {
        if (typeof q[k] !== 'number' || !Number.isFinite(q[k])) return { ok: false, error: `${where}: ${k} must be a number.` };
      }
    }
    // A schema-1 page (Phase 2) would edit a quiz it cannot fully show and lose the new parts.
    // (Long text alone is allowed in schema 1: Phase 2 pages saved such drafts, and keep them.)
    if (schema < 2 && usesSchema2Fields(raw)) return { ok: false, error: 'This quiz uses new question features, so its schema must be 2.' };
  }
  const text = JSON.stringify(raw);
  if (new TextEncoder().encode(text).byteLength > LIMITS.quizBytes) return { ok: false, error: 'The quiz is larger than 200 KB. Shorten some text.' };
  return { ok: true, value: { text, title: raw.title.slice(0, 200), schema, questionCount: questions.length } };
}

/** The content hash of a stored body: SHA-256 of its exact text (the page computes the same). */
export function contentHash(text: string): Promise<string> {
  return sha256Hex(text);
}

/** Parse the `ids` query parameter: comma-separated quiz ids, de-duplicated, at most 50. */
export function parseIds(param: string | null): string[] | null {
  if (!param) return null;
  const ids = [...new Set(param.split(',').map((s) => s.trim()).filter(Boolean))];
  if (!ids.length || ids.length > LIBRARY.batchIds || !ids.every((id) => QUIZ_ID_RE.test(id))) return null;
  return ids;
}

/** baseVersion from a PUT body or a query parameter: a whole number ≥ 0 (0 = create). */
export function parseBaseVersion(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// ------------------------------------------------------------------ D1

interface Row {
  id: string;
  title: string;
  schema: number;
  question_count: number;
  version: number;
  content_hash: string;
  updated_at: number;
  deleted_at: number | null;
  body?: string;
}

export interface QuizMeta {
  id: string;
  title: string;
  schema: number;
  questions: number;
  version: number;
  hash: string;
  updatedAt: number;
  deletedAt: number | null;
}

function meta(r: Row): QuizMeta {
  return {
    id: r.id, title: r.title, schema: r.schema, questions: r.question_count, version: r.version,
    hash: r.content_hash, updatedAt: r.updated_at, deletedAt: r.deleted_at ?? null,
  };
}

function withBody(r: Row): QuizMeta & { body: unknown } {
  let body: unknown = null;
  try { body = JSON.parse(r.body ?? 'null'); } catch { /* stored by this module: always JSON */ }
  return { ...meta(r), body };
}

const COLS = 'id, title, schema, question_count, version, content_hash, updated_at, deleted_at';

export interface LibraryReply { status: number; body: Record<string, unknown> }

const MSG = {
  conflict: 'This quiz was changed on another device.',
  gone: 'This quiz was deleted on another device and is no longer in the Trash.',
  newer: 'This quiz was saved by a newer version of HomPub Quiz. Reload the page to edit it.',
  generation: 'The quiz library was restored from a backup. This page will reload it before saving.',
  full: `The library is full (${LIBRARY.maxLive} quizzes, or ${LIBRARY.maxRows} counting the Trash). Delete some quizzes, or empty the Trash, first.`,
} as const;

async function generation(db: D1Database, lib: string): Promise<number> {
  return (await db.prepare('SELECT generation FROM library WHERE id = ?1').bind(lib).first<number>('generation')) ?? 1;
}

async function row(db: D1Database, lib: string, id: string, body = false): Promise<Row | null> {
  return db.prepare(`SELECT ${COLS}${body ? ', body' : ''} FROM quizzes WHERE library_id = ?1 AND id = ?2`).bind(lib, id).first<Row>();
}

async function readJson(request: Request, max: number): Promise<unknown | Err> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > max) return { ok: false, error: 'too_large' };
  const buf = await request.arrayBuffer();
  if (buf.byteLength > max) return { ok: false, error: 'too_large' };
  try { return JSON.parse(new TextDecoder().decode(buf)); } catch { return { ok: false, error: 'invalid_json' }; }
}

function isErr(v: unknown): v is Err {
  return isObject(v) && v.ok === false && typeof v.error === 'string';
}

/**
 * Route one /api/library request for library `lib`. The caller has already
 * checked the session and the Origin. Every reply carries the library's
 * generation, so a page notices a restore from backup (PROTOCOL.md §12).
 */
export async function handleLibrary(request: Request, url: URL, db: D1Database, lib: string, now: number, bucket?: R2Bucket): Promise<LibraryReply> {
  const path = url.pathname;
  const gen = () => generation(db, lib);

  // GET /api/library: every quiz's metadata, newest first, Trash included. Reading the
  // list is when quizzes deleted more than 30 days ago are purged.
  if (path === '/api/library') {
    if (request.method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } };
    const [g, , list] = await db.batch<Row & { generation: number }>([
      db.prepare('SELECT generation FROM library WHERE id = ?1').bind(lib),
      db.prepare('DELETE FROM quizzes WHERE library_id = ?1 AND deleted_at IS NOT NULL AND deleted_at < ?2').bind(lib, now - LIBRARY.trashMs),
      db.prepare(`SELECT ${COLS} FROM quizzes WHERE library_id = ?1 ORDER BY updated_at DESC`).bind(lib),
    ]);
    const rows = list.results.map(meta);
    // Pictures no quiz has used for 8 days (PROTOCOL.md §14). A failure here never fails the list.
    if (bucket) { try { await removeUnusedImages(db, bucket, lib, now); } catch { /* tried again next hour */ } }
    return {
      status: 200,
      body: {
        generation: g.results[0]?.generation ?? 1,
        quizzes: rows.filter((r) => r.deletedAt === null),
        trash: rows.filter((r) => r.deletedAt !== null),
        limits: { maxLive: LIBRARY.maxLive, maxRows: LIBRARY.maxRows, trashDays: LIBRARY.trashMs / 86_400_000 },
      },
    };
  }

  // GET /api/library/quizzes?ids=a,b,c: full bodies, at most 50 per request.
  if (path === '/api/library/quizzes') {
    if (request.method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } };
    const ids = parseIds(url.searchParams.get('ids'));
    if (!ids) return { status: 400, body: { error: 'bad_ids', message: `Ask for 1–${LIBRARY.batchIds} quiz ids.` } };
    const marks = ids.map((_, i) => `?${i + 2}`).join(', ');
    const res = await db.prepare(`SELECT ${COLS}, body FROM quizzes WHERE library_id = ?1 AND id IN (${marks})`).bind(lib, ...ids).all<Row>();
    return { status: 200, body: { generation: await gen(), quizzes: res.results.map(withBody) } };
  }

  const m = path.match(/^\/api\/library\/quizzes\/([^/]+)(\/restore)?$/);
  if (!m || !QUIZ_ID_RE.test(m[1])) return { status: 404, body: { error: 'not_found' } };
  const id = m[1];

  // A change made from a copy older than a restore from backup must not be applied over it:
  // pages send the generation they know with every change (PROTOCOL.md §12).
  const stale = async (claimed: unknown): Promise<LibraryReply | null> => {
    if (claimed === undefined || claimed === null || claimed === '') return null;
    const g = await gen();
    return Number(claimed) === g ? null : { status: 409, body: { generation: g, error: 'generation_changed', message: MSG.generation } };
  };

  // POST /api/library/quizzes/:id/restore: take a quiz out of the Trash.
  if (m[2]) {
    if (request.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
    const old = await stale(url.searchParams.get('generation'));
    if (old) return old;
    const res = await db.prepare(
      `UPDATE quizzes SET deleted_at = NULL, version = version + 1
         WHERE library_id = ?1 AND id = ?2 AND deleted_at IS NOT NULL
           AND (SELECT COUNT(*) FROM quizzes WHERE library_id = ?1 AND deleted_at IS NULL) < ?3`,
    ).bind(lib, id, LIBRARY.maxLive).run();
    const r = await row(db, lib, id);
    if (!r) return { status: 404, body: { generation: await gen(), error: 'gone', message: MSG.gone } };
    if (!res.meta.changes && r.deleted_at !== null) return { status: 422, body: { generation: await gen(), error: 'library_full', message: MSG.full } };
    return { status: 200, body: { generation: await gen(), quiz: meta(r) } };
  }

  // PUT /api/library/quizzes/:id {baseVersion, quiz}: create (baseVersion 0) or replace.
  // Saving a quiz that is in the Trash takes it out again ("Keep mine" after a delete).
  if (request.method === 'PUT') {
    const parsed = await readJson(request, LIMITS.quizBytes + LIBRARY.envelopeBytes);
    if (isErr(parsed)) return { status: parsed.error === 'too_large' ? 413 : 400, body: { error: parsed.error } };
    if (!isObject(parsed)) return { status: 400, body: { error: 'invalid_body' } };
    const base = parseBaseVersion(parsed.baseVersion);
    if (base === null) return { status: 400, body: { error: 'bad_base_version', message: 'baseVersion must be a whole number (0 to create).' } };
    const checked = checkLibraryBody(parsed.quiz);
    if (!checked.ok) return { status: 400, body: { error: 'invalid_quiz', message: checked.error } };
    const old = await stale(parsed.generation);
    if (old) return old;
    const b = checked.value;
    const hash = await contentHash(b.text);
    // Which pictures the quiz uses is rewritten in the same transaction as the quiz itself.
    const refs = refStatements(db, id, hash, imageKeysOf(parsed.quiz));

    let changes = 0;
    if (base === 0) {
      const [res] = await db.batch([db.prepare(
        `INSERT INTO quizzes (id, library_id, title, body, schema, question_count, version, content_hash, updated_at, deleted_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, NULL
           WHERE (SELECT COUNT(*) FROM quizzes WHERE library_id = ?2 AND deleted_at IS NULL) < ?9
             AND (SELECT COUNT(*) FROM quizzes WHERE library_id = ?2) < ?10
         ON CONFLICT(id) DO NOTHING`,
      ).bind(id, lib, b.title, b.text, b.schema, b.questionCount, hash, now, LIBRARY.maxLive, LIBRARY.maxRows), ...refs]);
      changes = res.meta.changes;
    } else {
      // Unchanged content on a live quiz is not a write; a lower schema never replaces a higher one.
      // Taking a quiz out of the Trash this way counts against the live limit, as a restore does.
      const [res] = await db.batch([db.prepare(
        `UPDATE quizzes SET title = ?3, body = ?4, schema = ?5, question_count = ?6, version = version + 1,
                content_hash = ?7, updated_at = ?8, deleted_at = NULL
           WHERE library_id = ?1 AND id = ?2 AND version = ?9 AND schema <= ?5
             AND (content_hash <> ?7 OR deleted_at IS NOT NULL)
             AND (deleted_at IS NULL OR (SELECT COUNT(*) FROM quizzes WHERE library_id = ?1 AND deleted_at IS NULL) < ?10)`,
      ).bind(lib, id, b.title, b.text, b.schema, b.questionCount, hash, now, base, LIBRARY.maxLive), ...refs]);
      changes = res.meta.changes;
    }
    const r = await row(db, lib, id, true);
    if (changes) return { status: 200, body: { generation: await gen(), quiz: meta(r!) } };
    if (r && base !== 0 && r.version === base && r.deleted_at !== null && r.schema <= b.schema) {
      return { status: 422, body: { generation: await gen(), error: 'library_full', message: MSG.full } };
    }
    if (!r) {
      if (base === 0) return { status: 422, body: { generation: await gen(), error: 'library_full', message: MSG.full } };
      return { status: 409, body: { generation: await gen(), error: 'gone', message: MSG.gone, server: null } };
    }
    if (base !== 0 && r.version === base && r.content_hash === hash && r.deleted_at === null) {
      return { status: 200, body: { generation: await gen(), quiz: meta(r) } };   // nothing to change
    }
    if (r.schema > b.schema) return { status: 409, body: { generation: await gen(), error: 'newer_schema', message: MSG.newer, server: withBody(r) } };
    return { status: 409, body: { generation: await gen(), error: 'conflict', message: MSG.conflict, server: withBody(r) } };
  }

  // DELETE /api/library/quizzes/:id?baseVersion=n moves a quiz to the Trash;
  // ?forever=1 removes one that is already there.
  if (request.method === 'DELETE') {
    const old = await stale(url.searchParams.get('generation'));
    if (old) return old;
    if (url.searchParams.get('forever') === '1') {
      const res = await db.prepare('DELETE FROM quizzes WHERE library_id = ?1 AND id = ?2 AND deleted_at IS NOT NULL').bind(lib, id).run();
      if (!res.meta.changes) {
        const r = await row(db, lib, id);
        // Still live: deleting for good is for the Trash only, so a page can never lose a quiz it thought was binned.
        if (r) return { status: 409, body: { generation: await gen(), error: 'not_in_trash', message: 'Move the quiz to the Trash first.', server: meta(r) } };
      }
      return { status: 200, body: { generation: await gen() } };
    }
    const base = parseBaseVersion(url.searchParams.get('baseVersion'));
    if (base === null || base === 0) return { status: 400, body: { error: 'bad_base_version', message: 'baseVersion must be the version being deleted.' } };
    const res = await db.prepare(
      'UPDATE quizzes SET deleted_at = ?3, version = version + 1 WHERE library_id = ?1 AND id = ?2 AND version = ?4 AND deleted_at IS NULL',
    ).bind(lib, id, now, base).run();
    const r = await row(db, lib, id, true);
    if (res.meta.changes || !r || r.deleted_at !== null) return { status: 200, body: { generation: await gen(), quiz: r ? meta(r) : null } };
    return { status: 409, body: { generation: await gen(), error: 'conflict', message: MSG.conflict, server: withBody(r) } };
  }

  return { status: 405, body: { error: 'method_not_allowed' } };
}
