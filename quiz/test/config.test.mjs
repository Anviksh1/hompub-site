// Checks wrangler.jsonc: the staging environment must repeat the bindings and vars
// exactly (they do not inherit), and no dev-only switch or secret may appear in it.
// Run with: node --test test/config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
