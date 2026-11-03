// Checks wrangler.jsonc: the staging environment must repeat the bindings and vars
// exactly (they do not inherit), and no dev-only switch or secret may appear in it.
// Run with: node --test test/config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/** Parse JSONC: drop // and /* *\/ comments that are outside strings. */
function parseJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += text[++i]; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out);
}

const config = parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

test('staging repeats the Durable Object bindings exactly', () => {
  assert.ok(config.env && config.env.staging, 'env.staging exists');
  assert.deepEqual(config.env.staging.durable_objects, config.durable_objects);
});

test('staging repeats every var with the same value', () => {
  assert.deepEqual(config.env.staging.vars, config.vars);
});

test('staging has its own Worker name', () => {
  assert.equal(config.env.staging.name, 'hompub-quiz-staging');
  assert.notEqual(config.env.staging.name, config.name);
});

test('no dev-only switch or secret is configured as a var', () => {
  const forbidden = /^(DEV_|HOST_PASSCODE$|SESSION_KEY$|IP_HASH_KEY$)/;
  for (const vars of [config.vars, config.env.staging.vars]) {
    for (const key of Object.keys(vars)) assert.doesNotMatch(key, forbidden, key);
  }
});

test('the room cap is at least 400 and observability stays off', () => {
  assert.ok(Number(config.vars.MAX_PLAYERS) >= 400);
  assert.equal(config.observability.enabled, false);
});

test('staging has its own quiz library database, with the same binding and migrations', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const prod = config.d1_databases;
  const stag = config.env.staging.d1_databases;
  assert.equal(prod.length, 1);
  assert.equal(stag.length, 1);
  assert.equal(prod[0].binding, 'DB');
  assert.equal(stag[0].binding, prod[0].binding);
  assert.equal(stag[0].migrations_dir, prod[0].migrations_dir);
  assert.match(prod[0].database_id, uuid);
  assert.match(stag[0].database_id, uuid);
  assert.notEqual(stag[0].database_id, prod[0].database_id);
});

test('migrations are numbered, additive SQL files', () => {
  const dir = new URL('../migrations/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length >= 1);
  files.forEach((f, i) => {
    assert.match(f, /^\d{4}_[a-z0-9_]+\.sql$/, f);
    assert.equal(Number(f.slice(0, 4)), i + 1, `${f} is numbered in order`);
    const sql = readFileSync(new URL(f, dir), 'utf8').replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /\b(DROP|RENAME)\b/i, `${f} only adds`);
  });
});

test('staging has its own picture bucket, with the same binding', () => {
  const prod = config.r2_buckets;
  const stag = config.env.staging.r2_buckets;
  assert.equal(prod.length, 1);
  assert.equal(stag.length, 1);
  assert.equal(prod[0].binding, 'IMAGES');
  assert.equal(stag[0].binding, prod[0].binding);
  assert.equal(prod[0].bucket_name, 'hompub-quiz-images');
  assert.equal(stag[0].bucket_name, 'hompub-quiz-images-staging');
});
