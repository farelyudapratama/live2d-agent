#!/usr/bin/env node
/* test-api-origin.js — the backend origin must be DERIVED, never a literal port.
 *
 * WHY THIS EXISTS
 * The server honours `process.env.PORT` (`const PORT =
 * Number(process.env.PORT) || 8310`), but the frontend once had `http://127.0.0.1:8310`
 * written out in 11 places across js/app.js and agent.js. Start the server on any
 * other port — a second instance for testing, or 8310 already taken — and the page
 * loads fine (it's served by that server) while every single fetch goes to a port
 * with nothing on it. Symptom: config never loads, chat does nothing, model list
 * empty, no obvious cause.
 *
 * The page is always served BY the backend, so location.origin is correct by
 * construction. This suite asserts the derivation exists, that no literal
 * survives outside its documented fallback, and that the derivation actually
 * produces the right origin under http/https/file protocols.
 *
 * Run: node test/test-api-origin.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'static', 'js', 'app.js'), 'utf8');
// v2: otak agent kini TS (src/client/agent/brain.ts) — guard yang sama berlaku.
const agentSrc = fs.readFileSync(path.join(ROOT, 'src', 'client', 'agent', 'brain.ts'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── 1. no stray literals ─────────────────────────────────────────────────────
section('no hardcoded origin outside the documented fallback');

for (const [label, src] of [['static/js/app.js', appSrc], ['src/client/agent/brain.ts', agentSrc]]) {
  const lines = src.split(/\r?\n/);
  const hits = [];
  lines.forEach((line, i) => {
    if (!/127\.0\.0\.1:8310|localhost:8310/.test(line)) return;
    // Allowed: the comment explaining the fix, and the single file:// fallback
    // literal in the API derivation.
    const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
    const isFallback = /:\s*['"]http:\/\/127\.0\.0\.1:8310['"]\s*;?\s*$/.test(line);
    if (isComment || isFallback) return;
    hits.push(`${i + 1}: ${line.trim()}`);
  });
  ok(`${label}: no literal :8310 in live code`, hits.length === 0,
    hits.length ? hits.join(' | ') : 'clean');
}

// Every fetch must go through the derived constant.
for (const [label, src] of [['static/js/app.js', appSrc], ['src/client/agent/brain.ts', agentSrc]]) {
  const fetches = src.match(/fetch\(\s*['"`]https?:\/\/[^'"`]+/g) || [];
  ok(`${label}: no fetch() to an absolute literal URL`, fetches.length === 0,
    fetches.length ? fetches.join(' | ') : 'clean');
  const viaApi = (src.match(/fetch\(API\s*\+/g) || []).length;
  ok(`${label}: fetches route through API constant`, viaApi > 0, viaApi + ' call site(s)');
}

// Both files are separate modules, so each needs its own derivation.
for (const [label, src] of [['static/js/app.js', appSrc], ['src/client/agent/brain.ts', agentSrc]]) {
  ok(`${label}: declares its own API constant`,
    /const API\s*=\s*\(?\s*typeof location/.test(src));
}

// ── 2. the derivation behaves ────────────────────────────────────────────────
section('derivation under each protocol');

// The file uses CRLF, so anchor on the fallback literal rather than ';\n'.
const API_EXPR_RE = /const API = \(typeof location[\s\S]*?'http:\/\/127\.0\.0\.1:8310';/;

function deriveWith(locObj) {
  // Extract and evaluate the REAL expression from js/app.js rather than a copy.
  // `const` does not create a property on the vm global, so export it explicitly.
  const m = appSrc.match(API_EXPR_RE);
  if (!m) return { err: 'expression not found' };
  const sandbox = { location: locObj, __out: undefined };
  vm.createContext(sandbox);
  vm.runInContext(m[0] + '\n;__out = API;', sandbox);
  return { api: sandbox.__out };
}

ok('API derivation expression extracted from js/app.js', API_EXPR_RE.test(appSrc));

let r = deriveWith({ protocol: 'http:', origin: 'http://127.0.0.1:8310' });
ok('default port → same origin', r.api === 'http://127.0.0.1:8310', r.api);

r = deriveWith({ protocol: 'http:', origin: 'http://127.0.0.1:8399' });
ok('PORT=8399 → follows the page, not the literal', r.api === 'http://127.0.0.1:8399', r.api);

r = deriveWith({ protocol: 'http:', origin: 'http://192.168.1.50:8310' });
ok('LAN host → keeps the host (would 404 on 127.0.0.1 from another device)',
  r.api === 'http://192.168.1.50:8310', r.api);

r = deriveWith({ protocol: 'https:', origin: 'https://live2d.example.com' });
ok('https origin preserved (no mixed-content downgrade)',
  r.api === 'https://live2d.example.com', r.api);

r = deriveWith({ protocol: 'file:', origin: 'null' });
ok('file:// → falls back to the literal (origin is "null" there)',
  r.api === 'http://127.0.0.1:8310', r.api);

// A missing `location` must not throw at load time — app.js is also parsed by
// the other test harnesses in this directory.
const m = appSrc.match(API_EXPR_RE);
let threw = false;
try {
  const sb = { __out: undefined };
  vm.createContext(sb);
  vm.runInContext(m[0] + '\n;__out = API;', sb);
  ok('no location at all → literal fallback, no throw', sb.__out === 'http://127.0.0.1:8310', sb.__out);
} catch (e) { threw = true; }
ok('derivation never throws on a headless context', !threw);

// ── 3. server side actually honours PORT ─────────────────────────────────────
section('server side of the contract (src/server/index.ts)');
const srvSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'index.ts'), 'utf8');
ok('server reads process.env.PORT', /Number\(process\.env\.PORT\)\s*\|\|\s*8310/.test(srvSrc));
ok('server default is still 8310 (no behaviour change for normal use)',
  /\|\|\s*8310/.test(srvSrc));

// ── 4. the brain's own derivation behaves (v2: brain.ts bukan agent.js) ──────
section('brain.ts derivation under each protocol');
const BRAIN_API_RE = /const API =[\s\S]*?['"]http:\/\/127\.0\.0\.1:8310['"];/;
ok('brain.ts API derivation expression extracted', BRAIN_API_RE.test(agentSrc));
function deriveBrainWith(locObj) {
  const m = agentSrc.match(BRAIN_API_RE);
  if (!m) return { err: 'expression not found' };
  const sandbox = { location: locObj, __out: undefined };
  vm.createContext(sandbox);
  vm.runInContext(m[0] + '\n;__out = API;', sandbox);
  return { api: sandbox.__out };
}
let rb = deriveBrainWith({ protocol: 'http:', origin: 'http://127.0.0.1:8399' });
ok('brain: PORT=8399 → follows the page', rb.api === 'http://127.0.0.1:8399', rb.api);
rb = deriveBrainWith({ protocol: 'https:', origin: 'https://live2d.example.com' });
ok('brain: https origin preserved', rb.api === 'https://live2d.example.com', rb.api);
rb = deriveBrainWith({ protocol: 'file:', origin: 'null' });
ok('brain: file:// → literal fallback', rb.api === 'http://127.0.0.1:8310', rb.api);
rb = deriveBrainWith(undefined);
ok('brain: no location at all → literal fallback, no throw', rb.api === 'http://127.0.0.1:8310', rb.api);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
