// Question pictures (PROTOCOL.md §14). The files are in the R2 bucket IMAGES;
// the D1 tables `images` and `quiz_images` (migrations/0002_images.sql) say
// which pictures exist and which quizzes use them, so unused ones can be
// removed. The Worker checks the session and the Origin before an upload;
// pictures are read without signing in (phones show them). The pure helpers at
// the top are unit-tested (test/images.test.ts) and must stay free of
// Workers-only APIs.

import { IMAGE_KEY_RE } from './shared.ts';

export const IMAGES = {
  maxBytes: 1024 * 1024,                  // one picture as uploaded (the host page shrinks it first)
  maxCount: 5000,                         // pictures per library, used or not: at most ~5 GB of R2's free 10 GB
  unusedMs: 8 * 24 * 60 * 60 * 1000,      // removed this long after no quiz uses it: longer than Time Travel's 7 days
  checkEveryMs: 60 * 60 * 1000,           // how often reading the list looks for unused pictures
  deleteBatch: 90,                        // per check (D1 binds at most 100 parameters)
  cacheControl: 'public, max-age=31536000, immutable',   // a key names its content, so it never changes
} as const;

export const IMAGE_TYPES = { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif' } as const;
export type ImageExt = keyof typeof IMAGE_TYPES;

/** The picture format, from the file's first bytes (never from what the request says). */
export function sniffImage(b: Uint8Array): ImageExt | null {
  const at = (i: number, ...v: number[]) => b.length >= i + v.length && v.every((x, k) => b[i + k] === x);
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (at(4, 0x37, 0x61) || at(4, 0x39, 0x61))) return 'gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  return null;
}

/** The bucket key of a picture: SHA-256 of its bytes, then its format. The same file is stored once. */
export async function imageKey(bytes: Uint8Array, ext: ImageExt): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `${Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('')}.${ext}`;
}

/** The picture keys a quiz body uses (any schema; unreadable parts are skipped). */
export function imageKeysOf(body: unknown): string[] {
  const out = new Set<string>();
  const qs = body && typeof body === 'object' ? (body as Record<string, unknown>).questions : null;
  if (Array.isArray(qs)) {
    for (const q of qs) {
      const img = q && typeof q === 'object' ? (q as Record<string, unknown>).image : null;
      const key = img && typeof img === 'object' ? (img as Record<string, unknown>).key : null;
      if (typeof key === 'string' && IMAGE_KEY_RE.test(key)) out.add(key);
    }
  }
  return [...out];
}

/**
 * Statements that make `quiz_images` match quiz `id` as stored, for the same
 * D1 batch as the write. They act only if the stored body has `hash`, so a
 * refused write (an edit from another device) leaves the rows as they were.
 */
export function refStatements(db: D1Database, id: string, hash: string, keys: string[]): D1PreparedStatement[] {
  const stored = 'EXISTS (SELECT 1 FROM quizzes WHERE id = ?1 AND content_hash = ?2)';
  return [
    db.prepare(`DELETE FROM quiz_images WHERE quiz_id = ?1 AND ${stored}`).bind(id, hash),
    ...keys.map((k) => db.prepare(`INSERT OR IGNORE INTO quiz_images (quiz_id, key) SELECT ?1, ?3 WHERE ${stored}`).bind(id, hash, k)),
    db.prepare('UPDATE images SET unused_since = NULL WHERE unused_since IS NOT NULL AND key IN (SELECT key FROM quiz_images WHERE quiz_id = ?1)').bind(id),
  ];
}

export interface ImageReply { status: number; body: Record<string, unknown> }

const MSG = {
  tooLarge: `A picture can be at most ${IMAGES.maxBytes / 1024 / 1024} MB. The page shrinks pictures before sending them: try another picture.`,
  notImage: 'Use a JPEG, PNG, WebP or GIF picture.',
  full: `The library has ${IMAGES.maxCount} pictures. Pictures no quiz uses are removed 8 days after their last use.`,
} as const;

/** POST /api/images: the request body is the picture. Signed-in hosts only (the Worker checks). */
export async function uploadImage(request: Request, db: D1Database, bucket: R2Bucket, lib: string, now: number): Promise<ImageReply> {
  if (request.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
  if (Number(request.headers.get('content-length') || 0) > IMAGES.maxBytes) return { status: 413, body: { error: 'image_too_large', message: MSG.tooLarge } };
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > IMAGES.maxBytes) return { status: 413, body: { error: 'image_too_large', message: MSG.tooLarge } };
  const ext = sniffImage(bytes);
  if (!ext) return { status: 415, body: { error: 'not_an_image', message: MSG.notImage } };
  const key = await imageKey(bytes, ext);

  const known = await db.prepare('SELECT key FROM images WHERE key = ?1').bind(key).first<{ key: string }>();
  if (!known) {
    const n = (await db.prepare('SELECT COUNT(*) AS n FROM images WHERE library_id = ?1').bind(lib).first<number>('n')) ?? 0;
    if (n >= IMAGES.maxCount) return { status: 422, body: { error: 'images_full', message: MSG.full } };
  }
  // Put the file first: a row never names a picture the bucket lacks.
  if (!(await bucket.head(key))) {
    await bucket.put(key, bytes, { httpMetadata: { contentType: IMAGE_TYPES[ext], cacheControl: IMAGES.cacheControl }, sha256: key.slice(0, 64) });
  }
  // A picture not yet in a quiz counts as unused from now: the editor saves the quiz within seconds,
  // and an upload of a picture already here starts its 8 days again.
  await db.prepare(
    `INSERT INTO images (key, library_id, bytes, type, created_at, unused_since) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(key) DO UPDATE SET unused_since = CASE WHEN unused_since IS NULL THEN NULL ELSE ?5 END`,
  ).bind(key, lib, bytes.byteLength, IMAGE_TYPES[ext], now).run();
  return { status: 200, body: { key, url: `/api/images/${key}`, bytes: bytes.byteLength, type: IMAGE_TYPES[ext] } };
}

/** GET or HEAD /api/images/:key. Anyone may read a picture; its key is the SHA-256 of the file. */
export async function serveImage(request: Request, bucket: R2Bucket, key: string): Promise<Response> {
  const base = {
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { ...base, allow: 'GET, HEAD' } });
  if (!IMAGE_KEY_RE.test(key)) return new Response(null, { status: 404, headers: { ...base, 'cache-control': 'no-store' } });
  const obj = request.method === 'HEAD' ? await bucket.head(key) : await bucket.get(key, { onlyIf: request.headers });
  if (!obj) return new Response(null, { status: 404, headers: { ...base, 'cache-control': 'no-store' } });
  const headers = new Headers(base);
  // The type comes from the key, which upload set from the file's own bytes.
  headers.set('content-type', IMAGE_TYPES[key.slice(65) as ImageExt]);
  headers.set('cache-control', IMAGES.cacheControl);
  headers.set('etag', obj.httpEtag);
  if (request.method === 'HEAD') { headers.set('content-length', String(obj.size)); return new Response(null, { status: 200, headers }); }
  if (!('body' in obj)) return new Response(null, { status: 304, headers });   // If-None-Match matched
  return new Response((obj as R2ObjectBody).body, { status: 200, headers });
}

/**
 * Remove pictures no quiz has used for 8 days. Run when the list is read, at
 * most hourly. Rows of quizzes deleted for good (or purged from the Trash) go
 * first, then pictures nobody uses are marked, and the oldest marked ones are
 * deleted: rows first (RETURNING tells which), then the files.
 */
export async function removeUnusedImages(db: D1Database, bucket: R2Bucket, lib: string, now: number): Promise<number> {
  const claimed = await db.prepare(
    'UPDATE library SET images_checked_at = ?2 WHERE id = ?1 AND (images_checked_at IS NULL OR images_checked_at < ?3)',
  ).bind(lib, now, now - IMAGES.checkEveryMs).run();
  if (!claimed.meta.changes) return 0;
  await db.batch([
    db.prepare('DELETE FROM quiz_images WHERE quiz_id NOT IN (SELECT id FROM quizzes)'),
    db.prepare('UPDATE images SET unused_since = ?2 WHERE library_id = ?1 AND unused_since IS NULL AND key NOT IN (SELECT key FROM quiz_images)').bind(lib, now),
    db.prepare('UPDATE images SET unused_since = NULL WHERE library_id = ?1 AND unused_since IS NOT NULL AND key IN (SELECT key FROM quiz_images)').bind(lib),
  ]);
  const gone = await db.prepare(
    `DELETE FROM images WHERE key IN (
       SELECT key FROM images WHERE library_id = ?1 AND unused_since IS NOT NULL AND unused_since < ?2
         AND key NOT IN (SELECT key FROM quiz_images) LIMIT ?3)
     RETURNING key`,
  ).bind(lib, now - IMAGES.unusedMs, IMAGES.deleteBatch).all<{ key: string }>();
  const keys = gone.results.map((r) => r.key);
  if (keys.length) await bucket.delete(keys);
  return keys.length;
}
