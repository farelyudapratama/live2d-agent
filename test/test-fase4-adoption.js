// Fase 4 (Langkah 2d) tests — .exp3 adoption opt-out.
//
// filterAdoptable(onDisk, disabled) is a pure helper in app.js: given the list
// of .exp3 files discovered on disk + the user's disabled-set, it returns the
// ones that should actually be auto-adopted. We extract and run the REAL
// function so the opt-out logic can't regress (e.g. a disabled file sneaking in,
// or a valid orphan being dropped).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  -> ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return null;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const fnSrc = extractFn(appSrc, 'filterAdoptable');
ok('filterAdoptable() is extractable', !!fnSrc);
if (!fnSrc) { console.log(pass + ' passed, ' + fail + ' failed'); process.exit(1); }

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fnSrc + '\nthis.filterAdoptable = filterAdoptable;', sandbox);
const filterAdoptable = (onDisk, disabled) => sandbox.filterAdoptable(onDisk, disabled);

const orphan = (n) => ({ Name: n, File: n + '.exp3.json', declared: false });
const declared = (n) => ({ Name: n, File: n + '.exp3.json', declared: true });

section('1. orphans are adopted by default (disabled empty)');
{
  const disk = [orphan('A'), orphan('B'), declared('C')];
  const got = filterAdoptable(disk, new Set());
  ok('both orphans kept, declared dropped', got.length === 2 && got.every(e => !e.declared),
    JSON.stringify(got.map(e => e.Name)));
}

section('2. disabled names are excluded');
{
  const disk = [orphan('A'), orphan('B'), orphan('C')];
  const got = filterAdoptable(disk, new Set(['B']));
  ok('A and C adopted, B excluded', got.length === 2 && got.map(e => e.Name).sort().join(',') === 'A,C',
    JSON.stringify(got.map(e => e.Name)));
}

section('3. disabling EVERYTHING yields an empty list (manifest "complete" → no adoption)');
{
  const disk = [orphan('A'), orphan('B')];
  const got = filterAdoptable(disk, new Set(['A', 'B']));
  ok('no adoptable files', got.length === 0, String(got.length));
}

section('4. malformed entries never throw / never adopted');
{
  const disk = [null, {}, { Name: 'X' }, { File: 'y.exp3.json' }, orphan('OK')];
  const got = filterAdoptable(disk, new Set());
  ok('only the well-formed orphan survives', got.length === 1 && got[0].Name === 'OK',
    JSON.stringify(got.map(e => e && e.Name)));
}

section('5. degenerate inputs never throw');
{
  ok('null onDisk -> []', (() => { try { return filterAdoptable(null, new Set()).length === 0; } catch (e) { return false; } })());
  ok('undefined onDisk -> []', (() => { try { return filterAdoptable(undefined, new Set()).length === 0; } catch (e) { return false; } })());
  ok('null disabled (treated as none) -> all orphans', (() => { try { const g = filterAdoptable([orphan('A')], null); return g.length === 1; } catch (e) { return false; } })());
  ok('array disabled accepted', (() => { try { const g = filterAdoptable([orphan('A'), orphan('B')], ['B']); return g.length === 1 && g[0].Name === 'A'; } catch (e) { return false; } })());
}

section('6. source of truth — buildModelSettings uses filterAdoptable');
{
  const uses = /const orphans = filterAdoptable\(onDisk, disabled\)/.test(appSrc);
  ok('buildModelSettings calls filterAdoptable(onDisk, disabled)', uses);
  const noStaleInline = !/const orphans = onDisk\.filter\(e => e && !e\.declared && e\.File && e\.Name && !disabled\.has/.test(appSrc);
  ok('old inline filter is gone (single source of truth)', noStaleInline);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
