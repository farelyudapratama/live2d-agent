#!/usr/bin/env node
/* test-exp3-adoption.js — orphaned .exp3 discovery + in-memory manifest merge.
 *
 * WHY THIS EXISTS
 * lumine ships 19 .exp3.json files and its model3.json declares ZERO of them.
 * pixi-live2d-display only constructs an ExpressionManager when
 * settings.expressions is truthy (`init(t){super.init(t),this.settings.expressions
 * &&(this.expressionManager=new Ge(...))}` in the bundled 0.4.0), so those 19
 * files were never loaded: no error, no warning, just a character that could not
 * use the expressions it shipped with.
 *
 * Two halves are covered here:
 *   SERVER  GET /api/model/expressions?name=X walks the model folder, reports
 *           every .exp3 with a path relative to the model3.json dir, and flags
 *           which ones the manifest already declares.
 *   CLIENT  buildModelSettings() merges only the UNdeclared ones into an
 *           in-memory copy of the manifest and hands that object to the loader.
 *
 * The interesting failure modes are all about NOT breaking working models:
 * a complete manifest must be left alone (return null → plain URL load), a
 * duplicate Name must never be appended (getExpressionIndex matches on Name, so
 * a dupe makes one entry permanently unreachable), and the file on disk must
 * never be rewritten.
 *
 * Run: node test/test-exp3-adoption.js
 * Requires: nothing running — spins its own server on an ephemeral port.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

function extractFn(src, name) {
  const start = src.indexOf('async function ' + name + '(') >= 0
    ? src.indexOf('async function ' + name + '(')
    : src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

// ── build a throwaway model tree so we never touch the user's model/ dir ──────
function mkTree(spec) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'l2dexp-'));
  for (const [rel, body] of Object.entries(spec)) {
    const full = path.join(base, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body, null, 1));
  }
  return base;
}
const EXP_BODY = { Type: 'Live2D Expression', Parameters: [{ Id: 'ParamEX01', Value: 1, Blend: 'Add' }] };
function model3(expressions) {
  const fr = { Moc: 'x.moc3', Textures: ['x.2048/texture_00.png'] };
  if (expressions) fr.Expressions = expressions;
  return { Version: 3, FileReferences: fr };
}

// ═════════════════ PART 1 — server endpoint, real HTTP ════════════════════════
function startServer(modelsParent) {
  return new Promise((resolve, reject) => {
    // Run the REAL server.js, with its ROOT relocated by copying it into the
    // temp tree. Testing the shipped file matters more than convenience: the
    // traversal guard and stripBom() are part of what we're verifying.
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'l2dsrv-'));
    fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(stage, 'server.js'));
    fs.mkdirSync(path.join(stage, 'js'), { recursive: true });
    for (const f of ['motion-taxonomy.js']) {
      const src = path.join(ROOT, 'js', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stage, 'js', f));
    }
    // model/ inside the staged root = our synthetic tree
    fs.cpSync(modelsParent, path.join(stage, 'model'), { recursive: true });

    const port = 8400 + Math.floor(Math.random() * 400);
    const child = spawn(process.execPath, ['server.js'], {
      cwd: stage, env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const t0 = Date.now();
    (function probe() {
      http.get({ host: '127.0.0.1', port, path: '/api/models' }, res => {
        res.resume(); resolve({ child, port, stage });
      }).on('error', () => {
        if (Date.now() - t0 > 8000) { child.kill(); reject(new Error('server never came up: ' + out)); }
        else setTimeout(probe, 120);
      });
    })();
  });
}

function get(port, p) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: p }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (e) {}
        resolve({ status: res.statusCode, body: b, json });
      });
    }).on('error', e => resolve({ status: 0, body: String(e.message), json: null }));
  });
}

async function serverTests() {
  // Three synthetic models covering the three states that matter.
  const parent = mkTree({
    // (a) orphans only — the lumine shape: files present, manifest declares none
    'orphan_only/nested/char.model3.json': model3(null),
    'orphan_only/nested/expr/joy.exp3.json': EXP_BODY,
    'orphan_only/nested/expr/rage.exp3.json': EXP_BODY,
    'orphan_only/nested/deep/sub/wink.exp3.json': EXP_BODY,

    // (b) fully declared — the shirako shape: must report zero orphans
    'declared_all/m.model3.json': model3([{ Name: 'a', File: 'a.exp3.json' }, { Name: 'b', File: 'b.exp3.json' }]),
    'declared_all/a.exp3.json': EXP_BODY,
    'declared_all/b.exp3.json': EXP_BODY,

    // (c) partial + BOM manifest + a CJK filename + an .exp3 ABOVE the model3 dir
    'partial/\uFEFFsub/m.model3.json': '\uFEFF' + JSON.stringify(model3([{ Name: 'known', File: 'known.exp3.json' }])),
    'partial/\uFEFFsub/known.exp3.json': EXP_BODY,
    'partial/\uFEFFsub/\u5446\u732b.exp3.json': EXP_BODY,
    'partial/outside.exp3.json': EXP_BODY,
  });

  const { child, port, stage } = await startServer(parent);
  try {
    section('SERVER  GET /api/model/expressions');

    const a = await get(port, '/api/model/expressions?name=orphan_only');
    ok('orphan model: 200', a.status === 200, 'status ' + a.status);
    ok('orphan model: finds all 3 .exp3 recursively',
      a.json && a.json.expressions.length === 3,
      a.json ? a.json.expressions.map(e => e.Name).join(',') : '-');
    ok('orphan model: declaredCount is 0', a.json && a.json.declaredCount === 0);
    ok('orphan model: every entry flagged undeclared',
      a.json && a.json.expressions.every(e => e.declared === false));
    ok('orphan model: orphanCount matches', a.json && a.json.orphanCount === 3);
    // Paths must be relative to the model3.json DIR, not the model folder —
    // that is what the Cubism loader resolves against.
    ok('orphan model: File is relative to model3 dir (not model folder)',
      a.json && a.json.expressions.some(e => e.File === 'expr/joy.exp3.json'),
      a.json ? a.json.expressions.map(e => e.File).join(' ') : '-');
    ok('orphan model: nested subdir path kept intact',
      a.json && a.json.expressions.some(e => e.File === 'deep/sub/wink.exp3.json'));
    ok('orphan model: Name is filename without .exp3.json',
      a.json && a.json.expressions.some(e => e.Name === 'wink'));

    const b = await get(port, '/api/model/expressions?name=declared_all');
    ok('complete manifest: orphanCount 0', b.json && b.json.orphanCount === 0,
      b.json ? 'declared=' + b.json.declaredCount : '-');
    ok('complete manifest: all flagged declared',
      b.json && b.json.expressions.length === 2 && b.json.expressions.every(e => e.declared === true));

    const c = await get(port, '/api/model/expressions?name=partial');
    ok('BOM manifest still parsed (declaredCount 1, not 0)',
      c.json && c.json.declaredCount === 1,
      c.json ? 'declaredCount=' + c.json.declaredCount : '-');
    ok('partial: known file flagged declared',
      c.json && c.json.expressions.some(e => e.Name === 'known' && e.declared === true));
    ok('partial: CJK filename discovered as orphan',
      c.json && c.json.expressions.some(e => e.Name === '\u5446\u732b' && e.declared === false),
      c.json ? c.json.expressions.map(e => e.Name).join(',') : '-');
    ok('partial: .exp3 ABOVE the model3 dir is skipped (unresolvable relative path)',
      c.json && !c.json.expressions.some(e => e.File.startsWith('..')),
      c.json ? c.json.expressions.map(e => e.File).join(' ') : '-');

    section('SERVER  guards');
    const t1 = await get(port, '/api/model/expressions?name=../..');
    ok('traversal ../.. rejected', t1.status === 404, 'status ' + t1.status);
    const t2 = await get(port, '/api/model/expressions?name=%2E%2E%2F%2E%2E');
    ok('encoded traversal rejected', t2.status === 404, 'status ' + t2.status);
    const t3 = await get(port, '/api/model/expressions?name=does_not_exist');
    ok('unknown model 404s', t3.status === 404, 'status ' + t3.status);

    section('SERVER  read-only guarantee');
    // The whole point of in-memory adoption: a user's model folder must be
    // byte-identical afterwards. Compare the staged manifest before/after.
    const m3 = path.join(stage, 'model', 'orphan_only', 'nested', 'char.model3.json');
    const before = fs.readFileSync(m3);
    await get(port, '/api/model/expressions?name=orphan_only');
    await get(port, '/api/model/expressions?name=orphan_only');
    ok('manifest on disk unchanged after discovery',
      Buffer.compare(before, fs.readFileSync(m3)) === 0);
    ok('no .exp3 files created or deleted',
      fs.readdirSync(path.join(stage, 'model', 'orphan_only', 'nested', 'expr')).length === 2);

    return { port, child, stage };
  } catch (e) {
    child.kill();
    throw e;
  }
}

// ═══════════ PART 2 — buildModelSettings(), the real extracted body ══════════
async function clientTests() {
  section('CLIENT  buildModelSettings() merge logic');

  const fnSrc = extractFn(appSrc, 'buildModelSettings');
  ok('buildModelSettings() found in js/app.js', !!fnSrc);
  if (!fnSrc) return;

  // Drive the real body with a stubbed fetch. Each scenario returns a manifest
  // and a discovery payload; we assert on what the function hands the loader.
  async function run(manifest, discovery, modelPath = 'model/foo/sub/char.model3.json') {
    const logs = [];
    const sandbox = {
      API: 'http://127.0.0.1:9999',
      location: { href: 'http://127.0.0.1:9999/index.html' },
      URL,
      console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')) },
      fetch: async (url) => {
        if (String(url).includes('/api/model/expressions')) {
          return { ok: discovery !== null, json: async () => discovery };
        }
        return { ok: manifest !== null, json: async () => manifest };
      },
      Promise, Array, Set, String, JSON, Object,
      result: undefined,
    };
    vm.createContext(sandbox);
    vm.runInContext(fnSrc + `\n;result = buildModelSettings(${JSON.stringify(modelPath)});`, sandbox);
    return { out: await sandbox.result, logs };
  }

  const disc3 = {
    expressions: [
      { Name: 'joy', File: 'expr/joy.exp3.json', declared: false },
      { Name: 'rage', File: 'expr/rage.exp3.json', declared: false },
    ],
  };

  // (1) orphans present, manifest declares nothing → merged object returned
  let r = await run(model3(null), disc3);
  ok('adopts orphans when manifest declares none', !!r.out);
  ok('adopted count is 2',
    r.out && r.out.FileReferences.Expressions.length === 2,
    r.out ? String(r.out.FileReferences.Expressions.length) : 'null');
  ok('entries carry Name + File only',
    r.out && r.out.FileReferences.Expressions.every(e =>
      Object.keys(e).sort().join(',') === 'File,Name'));
  ok('settings.url set (loader needs it to resolve moc/textures)',
    r.out && typeof r.out.url === 'string' && r.out.url.endsWith('model/foo/sub/char.model3.json'),
    r.out ? r.out.url : '-');
  ok('other FileReferences untouched',
    r.out && r.out.FileReferences.Moc === 'x.moc3' && r.out.FileReferences.Textures.length === 1);

  // (2) manifest already complete → null, so the caller loads by URL unchanged.
  // This is the "don't break working models" case.
  r = await run(model3([{ Name: 'a', File: 'a.exp3.json' }]),
               { expressions: [{ Name: 'a', File: 'a.exp3.json', declared: true }] });
  ok('complete manifest → null (plain URL load, no interference)', r.out === null);

  // (3) partial: only the undeclared one is appended, declaration preserved
  r = await run(model3([{ Name: 'known', File: 'known.exp3.json' }]), {
    expressions: [
      { Name: 'known', File: 'known.exp3.json', declared: true },
      { Name: 'newone', File: 'newone.exp3.json', declared: false },
    ],
  });
  ok('partial: result has 2 entries', r.out && r.out.FileReferences.Expressions.length === 2);
  ok('partial: original declaration kept first (rigger order preserved)',
    r.out && r.out.FileReferences.Expressions[0].Name === 'known');
  ok('partial: only the undeclared entry appended',
    r.out && r.out.FileReferences.Expressions[1].Name === 'newone');

  // (4) duplicate Name must NOT be appended. getExpressionIndex() does
  // definitions.findIndex(e => e.Name === t), so a dupe would shadow one entry
  // forever. Server said declared:false, but the manifest already has the Name.
  r = await run(model3([{ Name: 'joy', File: 'other/joy.exp3.json' }]), {
    expressions: [{ Name: 'joy', File: 'expr/joy.exp3.json', declared: false }],
  });
  ok('duplicate Name never appended (would shadow via findIndex)', r.out === null,
    r.out ? JSON.stringify(r.out.FileReferences.Expressions) : 'null');

  // (5) duplicate File with a different Name — also skipped; same asset twice is
  // pointless and inflates the expression list the LLM is told about.
  r = await run(model3([{ Name: 'alias', File: 'expr/joy.exp3.json' }]), {
    expressions: [{ Name: 'joy', File: 'expr/joy.exp3.json', declared: false }],
  });
  ok('duplicate File skipped even under a new Name', r.out === null);

  section('CLIENT  failure modes must never block model loading');
  r = await run(null, disc3);
  ok('manifest fetch fails → null (fallback to URL load)', r.out === null);
  r = await run(model3(null), null);
  ok('discovery fetch fails → null', r.out === null);
  r = await run({ Version: 3 }, disc3);
  ok('manifest without FileReferences → null', r.out === null);
  r = await run(model3(null), { expressions: [] });
  ok('server reports no .exp3 at all → null', r.out === null);
  r = await run(model3(null), {});
  ok('malformed discovery payload → null', r.out === null);
  r = await run(model3(null), disc3, 'model/only-two-parts.json');
  ok('unexpected modelPath shape → null', r.out === null);
  r = await run(model3(null), disc3, 'sheets/notamodel.json');
  ok('path outside model/ → null', r.out === null);

  section('CLIENT  model-agnostic guarantees');
  // Names come from the rigger's filenames verbatim — no translation, no
  // normalisation, no character-specific mapping.
  r = await run(model3(null), {
    expressions: [
      { Name: '\u5446\u732b', File: '\u5446\u732b.exp3.json', declared: false },
      { Name: '01', File: 'numbered/01.exp3.json', declared: false },
      { Name: 'exp_angry', File: 'mothion/exp_angry.exp3.json', declared: false },
    ],
  });
  const names = r.out ? r.out.FileReferences.Expressions.map(e => e.Name) : [];
  ok('CJK / numeric / snake_case names all preserved verbatim',
    names.join(',') === '\u5446\u732b,01,exp_angry', names.join(','));

  // Source guard: the adoption path must not contain a model name or an
  // expression name. If someone hardcodes 'lumine' or 'exp_angry' here, the
  // feature stops being generic and this test goes red.
  const banned = [/['"]lumine['"]/i, /\u795e\u5bab\u767d\u5b50/, /exp_angry/, /['"]mothion['"]/i, /\u5446\u732b/];
  const hits = banned.filter(re => re.test(fnSrc));
  ok('buildModelSettings() hardcodes no model/expression/folder name',
    hits.length === 0, hits.length ? hits.map(String).join(' ') : 'clean');

  const srvStart = appSrc.length; // guard the server handler too
  const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const handler = srvSrc.slice(srvSrc.indexOf("urlPath === '/api/model/expressions'"),
                               srvSrc.indexOf("urlPath === '/api/model/import-zip'"));
  ok('server handler hardcodes no model name',
    !/['"]lumine['"]/i.test(handler) && !/\u795e\u5bab\u767d\u5b50/.test(handler) && !/['"]mothion['"]/i.test(handler));
  void srvStart;
}

// ═════════════════ PART 3 — real bundled models, real server ═════════════════
async function realModelTests(port) {
  section('REAL MODELS  (whatever is actually in model/)');
  const list = await get(port, '/api/models');
  const models = (list.json && list.json.models) || [];
  ok('server lists at least one real model', models.length > 0, models.join(', '));
  for (const name of models) {
    const r = await get(port, '/api/model/expressions?name=' + encodeURIComponent(name));
    if (r.status !== 200) { ok(`${name}: endpoint 200`, false, 'status ' + r.status); continue; }
    const d = r.json;
    const orphans = d.expressions.filter(e => !e.declared);
    console.log(`  INFO  ${name}: ${d.expressions.length} .exp3 on disk, ` +
                `${d.declaredCount} declared, ${orphans.length} orphaned`);
    ok(`${name}: every File resolves inside the model3 dir`,
      d.expressions.every(e => !e.File.startsWith('..')));
    ok(`${name}: orphanCount agrees with the flags`, d.orphanCount === orphans.length);
    // Each reported File must actually be fetchable at the path the loader will
    // build, otherwise adoption would swap silent-no-expressions for a 404 storm.
    const base = d.model3.split('/').slice(0, -1).join('/');
    for (const e of d.expressions.slice(0, 3)) {
      const url = '/' + base + '/' + e.File;
      const hit = await get(port, url.split('/').map(encodeURIComponent).join('/').replace(/%2F/g, '/'));
      ok(`${name}: ${e.Name} fetchable at loader path`, hit.status === 200,
        url + ' -> ' + hit.status);
    }
  }
}

(async () => {
  let srv = null;
  try {
    srv = await serverTests();
    await clientTests();

    // Real-model pass needs a server rooted at the REAL project dir.
    const port = 8400 + Math.floor(Math.random() * 400);
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT, env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function probe() {
        http.get({ host: '127.0.0.1', port, path: '/api/models' }, res => { res.resume(); resolve(); })
          .on('error', () => {
            if (Date.now() - t0 > 8000) reject(new Error('real server never came up'));
            else setTimeout(probe, 120);
          });
      })();
    });
    try { await realModelTests(port); } finally { child.kill(); }
  } catch (e) {
    fail++;
    console.log('  FAIL  harness: ' + e.message);
  } finally {
    if (srv && srv.child) srv.child.kill();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
