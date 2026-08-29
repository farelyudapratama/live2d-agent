// test-exp3-adoption.ts — PORT v2 dari live2d-agent/test/test-exp3-adoption.js
//
// Perbedaan dari v1 (disengaja, semantik dijaga):
//  - Bagian SERVER dijalankan IN-PROCESS lewat handleAPI() (dispatcher nyata,
//    tanpa socket/spawn). v1 men-spawn server.js di direktori stage; v2 server
//    membaca data/ dari import.meta.dir, jadi model sintetis di-stage ke
//    data/model/__exp3_* lalu DIHAPUS di finally. Endpoint discovery read-only.
//  - Bagian CLIENT (vm-extract buildModelSettings dari app.js) identik v1,
//    dengan app.js dari static/js/app.js (byte-identik v1).
//  - Fetchability file ekspresi diverifikasi lewat serveStatic() (fallback DATA
//    yang sama dipakai loader di browser), bukan HTTP socket.
//
// Jalankan: bun test/legacy/test-exp3-adoption.ts
import { handleAPI, serveStatic } from "../../src/server/index";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

const ROOT = path.join(import.meta.dir, "..", "..");
const MODEL_DIR = path.join(ROOT, "data", "model");
const appSrc = fs.readFileSync(path.join(ROOT, "static", "js", "app.js"), "utf8");
const serverSrc = fs.readFileSync(path.join(ROOT, "src", "server", "index.ts"), "utf8");

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  -> ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function section(t: string) { console.log(`\n${t}`); }

function extractFn(src: string, name: string): string | null {
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

// ── model sintetis di-stage di dalam data/model (dibersihkan di finally) ──────
const staged: string[] = [];
function stageModel(name: string, files: Record<string, string | object>) {
  const base = path.join(MODEL_DIR, name);
  staged.push(base);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(base, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body, null, 1));
  }
  return name;
}
function cleanupStaged() {
  for (const dir of staged) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

const EXP_BODY = { Type: 'Live2D Expression', Parameters: [{ Id: 'ParamEX01', Value: 1, Blend: 'Add' }] };
function model3(expressions: any[] | null) {
  const fr: any = { Moc: 'x.moc3', Textures: ['x.2048/texture_00.png'] };
  if (expressions) fr.Expressions = expressions;
  return { Version: 3, FileReferences: fr };
}

async function apiGet(p: string): Promise<{ status: number; body: string; json: any }> {
  const res = await handleAPI(new Request("http://localhost" + p) as any);
  if (!res) return { status: 404, body: "", json: null };
  const body = await res.text();
  let json: any = null;
  try { json = JSON.parse(body); } catch {}
  return { status: res.status, body, json };
}

// ═════════════════ PART 1 — server endpoint, dispatcher nyata ════════════════
async function serverTests() {
  // Tiga model sintetis yang menutup tiga keadaan yang penting (sama dengan v1).
  const nOrphan = stageModel('__exp3_orphan_only', {
    'nested/char.model3.json': model3(null),
    'nested/expr/joy.exp3.json': EXP_BODY,
    'nested/expr/rage.exp3.json': EXP_BODY,
    'nested/deep/sub/wink.exp3.json': EXP_BODY,
  });
  const nDeclared = stageModel('__exp3_declared_all', {
    'm.model3.json': model3([{ Name: 'a', File: 'a.exp3.json' }, { Name: 'b', File: 'b.exp3.json' }]),
    'a.exp3.json': EXP_BODY,
    'b.exp3.json': EXP_BODY,
  });
  const nPartial = stageModel('__exp3_partial', {
    '\uFEFFsub/m.model3.json': '\uFEFF' + JSON.stringify(model3([{ Name: 'known', File: 'known.exp3.json' }])),
    '\uFEFFsub/known.exp3.json': EXP_BODY,
    '\uFEFFsub/\u5446\u732b.exp3.json': EXP_BODY,
    'outside.exp3.json': EXP_BODY,
  });
  void nDeclared; void nPartial;

  section('SERVER  GET /api/model/expressions');

  const a = await apiGet('/api/model/expressions?name=' + nOrphan);
  ok('orphan model: 200', a.status === 200, 'status ' + a.status);
  ok('orphan model: finds all 3 .exp3 recursively',
    a.json && a.json.expressions.length === 3,
    a.json ? a.json.expressions.map((e: any) => e.Name).join(',') : '-');
  ok('orphan model: declaredCount is 0', a.json && a.json.declaredCount === 0);
  ok('orphan model: every entry flagged undeclared',
    a.json && a.json.expressions.every((e: any) => e.declared === false));
  ok('orphan model: orphanCount matches', a.json && a.json.orphanCount === 3);
  // Path harus relatif terhadap DIR model3.json, bukan folder model — itu yang
  // di-resolve loader Cubism.
  ok('orphan model: File is relative to model3 dir (not model folder)',
    a.json && a.json.expressions.some((e: any) => e.File === 'expr/joy.exp3.json'),
    a.json ? a.json.expressions.map((e: any) => e.File).join(' ') : '-');
  ok('orphan model: nested subdir path kept intact',
    a.json && a.json.expressions.some((e: any) => e.File === 'deep/sub/wink.exp3.json'));
  ok('orphan model: Name is filename without .exp3.json',
    a.json && a.json.expressions.some((e: any) => e.Name === 'wink'));

  const b = await apiGet('/api/model/expressions?name=__exp3_declared_all');
  ok('complete manifest: orphanCount 0', b.json && b.json.orphanCount === 0,
    b.json ? 'declared=' + b.json.declaredCount : '-');
  ok('complete manifest: all flagged declared',
    b.json && b.json.expressions.length === 2 && b.json.expressions.every((e: any) => e.declared === true));

  const c = await apiGet('/api/model/expressions?name=__exp3_partial');
  ok('BOM manifest still parsed (declaredCount 1, not 0)',
    c.json && c.json.declaredCount === 1,
    c.json ? 'declaredCount=' + c.json.declaredCount : '-');
  ok('partial: known file flagged declared',
    c.json && c.json.expressions.some((e: any) => e.Name === 'known' && e.declared === true));
  ok('partial: CJK filename discovered as orphan',
    c.json && c.json.expressions.some((e: any) => e.Name === '\u5446\u732b' && e.declared === false),
    c.json ? c.json.expressions.map((e: any) => e.Name).join(',') : '-');
  ok('partial: .exp3 ABOVE the model3 dir is skipped (unresolvable relative path)',
    c.json && !c.json.expressions.some((e: any) => e.File.startsWith('..')),
    c.json ? c.json.expressions.map((e: any) => e.File).join(' ') : '-');

  section('SERVER  guards');
  const t1 = await apiGet('/api/model/expressions?name=../..');
  ok('traversal ../.. rejected', t1.status === 404, 'status ' + t1.status);
  const t2 = await apiGet('/api/model/expressions?name=%2E%2E%2F%2E%2E');
  ok('encoded traversal rejected', t2.status === 404, 'status ' + t2.status);
  const t3 = await apiGet('/api/model/expressions?name=does_not_exist');
  ok('unknown model 404s', t3.status === 404, 'status ' + t3.status);

  section('SERVER  read-only guarantee');
  // Inti adopsi in-memory: folder model user harus byte-identik sesudahnya.
  const m3 = path.join(MODEL_DIR, nOrphan, 'nested', 'char.model3.json');
  const before = fs.readFileSync(m3);
  await apiGet('/api/model/expressions?name=' + nOrphan);
  await apiGet('/api/model/expressions?name=' + nOrphan);
  ok('manifest on disk unchanged after discovery',
    Buffer.compare(before, fs.readFileSync(m3)) === 0);
  ok('no .exp3 files created or deleted',
    fs.readdirSync(path.join(MODEL_DIR, nOrphan, 'nested', 'expr')).length === 2);
}

// ═══════════ PART 2 — buildModelSettings(), body asli yang diekstrak ═════════
async function clientTests() {
  section('CLIENT  buildModelSettings() merge logic');

  const fnSrc = extractFn(appSrc, 'buildModelSettings');
  ok('buildModelSettings() found in static/js/app.js', !!fnSrc);
  if (!fnSrc) return;
  const filterSrc = extractFn(appSrc, 'filterAdoptable');
  ok('filterAdoptable() found in static/js/app.js', !!filterSrc);
  const combined = (filterSrc ? filterSrc + '\n' : '') + fnSrc;

  async function run(manifest: any, discovery: any, modelPath = 'model/foo/sub/char.model3.json') {
    const logs: string[] = [];
    const sandbox: any = {
      API: 'http://127.0.0.1:9999',
      location: { href: 'http://127.0.0.1:9999/index.html' },
      URL,
      console: { log: (...a: any[]) => logs.push(a.join(' ')), warn: (...a: any[]) => logs.push('WARN ' + a.join(' ')) },
      fetch: async (url: any) => {
        if (String(url).includes('/api/model/expressions-adoption')) {
          return { ok: true, json: async () => ({ expressions: [], disabled: [] }) };
        }
        if (String(url).includes('/api/model/expressions')) {
          return { ok: discovery !== null, json: async () => discovery };
        }
        return { ok: manifest !== null, json: async () => manifest };
      },
      Promise, Array, Set, String, JSON, Object,
      result: undefined,
    };
    vm.createContext(sandbox);
    vm.runInContext(combined + `;result = buildModelSettings(${JSON.stringify(modelPath)});`, sandbox);
    return { out: await sandbox.result, logs };
  }

  const disc3 = {
    expressions: [
      { Name: 'joy', File: 'expr/joy.exp3.json', declared: false },
      { Name: 'rage', File: 'expr/rage.exp3.json', declared: false },
    ],
  };

  let r = await run(model3(null), disc3);
  ok('adopts orphans when manifest declares none', !!r.out);
  ok('adopted count is 2',
    r.out && r.out.FileReferences.Expressions.length === 2,
    r.out ? String(r.out.FileReferences.Expressions.length) : 'null');
  ok('entries carry Name + File only',
    r.out && r.out.FileReferences.Expressions.every((e: any) =>
      Object.keys(e).sort().join(',') === 'File,Name'));
  ok('settings.url set (loader needs it to resolve moc/textures)',
    r.out && typeof r.out.url === 'string' && r.out.url.endsWith('model/foo/sub/char.model3.json'),
    r.out ? r.out.url : '-');
  ok('other FileReferences untouched',
    r.out && r.out.FileReferences.Moc === 'x.moc3' && r.out.FileReferences.Textures.length === 1);

  r = await run(model3([{ Name: 'a', File: 'a.exp3.json' }]),
               { expressions: [{ Name: 'a', File: 'a.exp3.json', declared: true }] });
  ok('complete manifest → null (plain URL load, no interference)', r.out === null);

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

  r = await run(model3([{ Name: 'joy', File: 'other/joy.exp3.json' }]), {
    expressions: [{ Name: 'joy', File: 'expr/joy.exp3.json', declared: false }],
  });
  ok('duplicate Name never appended (would shadow via findIndex)', r.out === null,
    r.out ? JSON.stringify(r.out.FileReferences.Expressions) : 'null');

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
  r = await run(model3(null), {
    expressions: [
      { Name: '\u5446\u732b', File: '\u5446\u732b.exp3.json', declared: false },
      { Name: '01', File: 'numbered/01.exp3.json', declared: false },
      { Name: 'exp_angry', File: 'mothion/exp_angry.exp3.json', declared: false },
    ],
  });
  const names: string[] = r.out ? r.out.FileReferences.Expressions.map((e: any) => e.Name) : [];
  ok('CJK / numeric / snake_case names all preserved verbatim',
    names.join(',') === '\u5446\u732b,01,exp_angry', names.join(','));

  const banned = [/['"]lumine['"]/i, /\u795e\u5bab\u767d\u5b50/, /exp_angry/, /['"]mothion['"]/i, /\u5446\u732b/];
  const hits = banned.filter(re => re.test(fnSrc));
  ok('buildModelSettings() hardcodes no model/expression/folder name',
    hits.length === 0, hits.length ? hits.map(String).join(' ') : 'clean');

  // v2: guard server diarahkan ke src/server/index.ts — fungsi discovery asli.
  const discServer = extractFn(serverSrc, 'discoverExpressions');
  ok('discoverExpressions() found in src/server/index.ts', !!discServer);
  const srvHits = banned.filter(re => re.test(discServer || ''));
  ok('server discovery hardcodes no model name',
    srvHits.length === 0, srvHits.length ? srvHits.map(String).join(' ') : 'clean');
}

// ═════════════════ PART 3 — model bawaan yang benar-benar ada ════════════════
async function realModelTests() {
  section('REAL MODELS  (whatever is actually in data/model/)');
  const list = await apiGet('/api/models');
  const models = (list.json && list.json.models) || [];
  ok('server lists at least one real model', models.length > 0, models.join(', '));
  for (const name of models) {
    const r = await apiGet('/api/model/expressions?name=' + encodeURIComponent(name));
    if (r.status !== 200) { ok(`${name}: endpoint 200`, false, 'status ' + r.status); continue; }
    const d = r.json;
    const orphans = d.expressions.filter((e: any) => !e.declared);
    console.log(`  INFO  ${name}: ${d.expressions.length} .exp3 on disk, ` +
                `${d.declaredCount} declared, ${orphans.length} orphaned`);
    ok(`${name}: every File resolves inside the model3 dir`,
      d.expressions.every((e: any) => !e.File.startsWith('..')));
    ok(`${name}: orphanCount agrees with the flags`, d.orphanCount === orphans.length);
    // Setiap File harus fetchable di path yang akan dibangun loader — kalau
    // tidak, adopsi cuma menukar "diam tanpa ekspresi" dengan badai 404.
    const base = d.model3.split('/').slice(0, -1).join('/');
    for (const e of d.expressions.slice(0, 3)) {
      const url = '/' + base + '/' + e.File;
      const hit = serveStatic(url.split('/').map(encodeURIComponent).join('/').replace(/%2F/g, '/'));
      ok(`${name}: ${e.Name} fetchable at loader path`, !!hit && hit.status === 200,
        url + ' -> ' + (hit ? hit.status : 'null'));
    }
  }
}

(async () => {
  try {
    await serverTests();
    await clientTests();
    cleanupStaged();
    await realModelTests();
  } catch (e: any) {
    fail++;
    console.log('  FAIL  harness: ' + (e && e.message));
  } finally {
    cleanupStaged();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
