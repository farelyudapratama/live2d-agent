// Fase 0 hardening tests — static + behavioral checks on the security /
// robustness invariants we just established. These are deliberately source-level
// where a runtime check would need a live LLM: the point is that a later refactor
// cannot silently remove a guard.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const agentSrc = fs.readFileSync(path.join(ROOT, 'agent.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  -> ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

// ── 1. LLM fallback extracted and actually shared ──────────────────
section('1. llmWithFallback() extraction');

ok('llmWithFallback is defined as a function',
  /function llmWithFallback\s*\(/.test(serverSrc));

ok('/api/chat routes through llmWithFallback',
  /llmWithFallback\(/.test(serverSrc.slice(serverSrc.indexOf("'/api/chat'"))));

const callLLMDirect = serverSrc.match(/callLLM\(\s*active/g) || [];
ok('no endpoint calls callLLM(active, ...) directly any more',
  callLLMDirect.length === 0,
  callLLMDirect.length + ' direct call(s)');

const fallbackCalls = (serverSrc.match(/llmWithFallback\(/g) || []).length;
ok('all three LLM endpoints share the helper',
  fallbackCalls >= 4, fallbackCalls + ' reference(s) incl. definition');

ok('rejections carry an httpStatus so callers can shape their own response',
  /httpStatus/.test(serverSrc));

// ── 2. Timeout + response cap ──────────────────────────────────────
section('2. Timeout & response size cap');

ok('LLM_TIMEOUT_MS constant exists', /LLM_TIMEOUT_MS\s*=/.test(serverSrc));
ok('socket timeout is armed on the outbound request',
  /setTimeout\(\s*LLM_TIMEOUT_MS/.test(serverSrc));
ok('timeout destroys the request (no dangling socket)',
  /req\.destroy\(/.test(serverSrc));
ok('provider response has a byte cap',
  /MAX_LLM_RESPONSE_BYTES/.test(serverSrc));

// ── 3. LLM output validation ───────────────────────────────────────
section('3. LLM output validation');

const classifyBlock = serverSrc.slice(
  serverSrc.indexOf("'/api/model/classify-params'"),
  serverSrc.indexOf("'/api/animate-text'"));

ok('classify-params validates ids against the submitted set',
  /requestedIds\.has\(/.test(classifyBlock));
ok('classify-params validates role against KNOWN_ROLES',
  /allowedRoles\.has\(/.test(classifyBlock) && /new Set\(KNOWN_ROLES\)/.test(classifyBlock));
ok('KNOWN_ROLES is a single source of truth used to build the prompt too',
  /KNOWN_ROLES\.join/.test(serverSrc));
ok('classify-params never echoes min/max/def from the LLM',
  !/\bmin:\s*(it|item|c)\./.test(classifyBlock) && !/\bmax:\s*(it|item|c)\./.test(classifyBlock),
  'no numeric passthrough');

const animateBlock = serverSrc.slice(serverSrc.indexOf("'/api/animate-text'"));
ok('animate-text clamps intensity',
  /Math\.min\(1\.0, Math\.max\(0\.3/.test(animateBlock));
ok('animate-text validates emotion/gesture against known values',
  /okEmotion\.has\(/.test(animateBlock) && /okGesture\.has\(/.test(animateBlock));

// ── 4. HTML escaping ───────────────────────────────────────────────
section('4. HTML escaping');

ok('esc() is defined at module scope, not inside wireUI()',
  /^  function esc\(s\) \{/m.test(appSrc));

const wireUIStart = appSrc.indexOf('function wireUI()');
const escIndex = appSrc.search(/^  function esc\(s\) \{/m);
ok('esc() is reachable from code outside wireUI()',
  escIndex !== -1 && escIndex < wireUIStart,
  'esc@' + escIndex + ' < wireUI@' + wireUIStart);

ok('esc() escapes single quotes too (attribute contexts)',
  /&#39;/.test(appSrc));

// every innerHTML assignment with a template literal must use esc()
const innerHtmlLines = appSrc.split('\n')
  .map((l, i) => ({ l, n: i + 1 }))
  .filter(o => /innerHTML\s*[+]?=/.test(o.l) && /\$\{/.test(o.l));
const unescaped = innerHtmlLines.filter(o => !/esc\(/.test(o.l));
ok('no interpolated innerHTML sink skips esc()',
  unescaped.length === 0,
  unescaped.length ? 'line(s) ' + unescaped.map(o => o.n).join(',') : innerHtmlLines.length + ' checked');

// ── 5. Numeric truth comes only from Cubism Core ───────────────────
section('5. min/max/def integrity');

const mergeBlock = appSrc.slice(appSrc.indexOf('function applyClassifications') >= 0
  ? appSrc.indexOf('function applyClassifications')
  : appSrc.indexOf('for (const item of items)'));
ok('classification merge copies named semantic fields only',
  !/Object\.assign\(\s*pObj\s*,\s*item\s*\)/.test(appSrc),
  'no blanket Object.assign onto the param object');

ok('merge skips ids that are not real model params',
  /continue/.test(mergeBlock.slice(0, 1200)));

// ── 6. Per-model isolation ─────────────────────────────────────────
section('6. Per-model isolation');

ok('agent exposes invalidateCapabilityProfile',
  /invalidateCapabilityProfile/.test(agentSrc));
ok('capability profile cache is cleared on model load',
  /invalidateCapabilityProfile/.test(appSrc));
ok('state.caps is reset when swapping models',
  /state\.caps\s*=\s*\{\}/.test(appSrc));
ok('state.modelParams is reset when swapping models',
  /state\.modelParams\s*=\s*null/.test(appSrc));
ok('deleteCharacterSheet no longer uses the raw model name as the key',
  !/localStorage\.removeItem\('live2d_sheet_'\s*\+\s*modelKey\)/.test(appSrc));
ok('deleteCharacterSheet sweeps by sanitized prefix',
  /sheetKeyPrefixForModelName/.test(appSrc));

// ── 7. Atomic / serialized writes ──────────────────────────────────
section('7. Atomic & serialized JSON writes');

ok('writeJsonAtomic exists', /function writeJsonAtomic\(/.test(serverSrc));
ok('it writes a temp file then renames', /renameSync\(/.test(serverSrc));
ok('queueJsonWrite serializes writes per path', /function queueJsonWrite\(/.test(serverSrc));
ok('config.json is written atomically',
  /writeJsonAtomic\(path\.join\(ROOT, 'config\.json'\)/.test(serverSrc));
ok('sheet POST goes through the write queue',
  /queueJsonWrite\(target/.test(serverSrc));
ok('no raw writeFileSync left for config.json',
  !/writeFileSync\(path\.join\(ROOT, 'config\.json'\), JSON\.stringify/.test(serverSrc));

// behavioral: the queue really serializes and survives a failure
section('7b. queueJsonWrite behavior (live)');
(async () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'l2dwq-'));
  const target = path.join(tmpDir, 'out.json');

  // re-implement the same primitives the server uses, to test the semantics
  function writeAtomic(file, obj) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + Date.now() + Math.random() + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }
  const queues = new Map();
  function q(file, obj) {
    const prev = queues.get(file) || Promise.resolve();
    const done = prev.then(() => writeAtomic(file, obj), () => writeAtomic(file, obj));
    const tail = done.catch(() => {});
    queues.set(file, tail);
    tail.then(() => { if (queues.get(file) === tail) queues.delete(file); });
    return done;
  }

  const N = 25;
  await Promise.all(Array.from({ length: N }, (_, i) => q(target, { n: i + 1 })));
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  ok('file is valid JSON after ' + N + ' concurrent writes', true, 'n=' + parsed.n);
  ok('last queued write wins', parsed.n === N, 'expected ' + N + ', got ' + parsed.n);
  const leftovers = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'));
  ok('no .tmp leftovers', leftovers.length === 0, leftovers.length + ' found');
  ok('queue map drains (no unbounded growth)', queues.size === 0, 'size=' + queues.size);

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
