// Fase 4 tests — surfacing user 'properti' presets to the LLM (Langkah 1).
//
// capabilityPropertyNames(sheet) is a pure helper extracted from app.js's
// getCapabilityProfile(). We run the REAL function body (extracted by regex,
// same technique as the other suites) so a broken projection cannot pass.
//
// What must hold:
//   - only presets.user of category 'properti' are advertised
//   - presets.ai 'properti' entries are EXCLUDED (suggestions, not capabilities)
//   - other categories (emosi/aksesoris/gerak) are NOT leaked into properties
//   - a malformed sheet (no presets, garbage) never throws
//   - empty/whitespace names are dropped (the LLM must never see a blank token)
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
section('test-fase4-properties');
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

const fnSrc = extractFn(appSrc, 'capabilityPropertyNames');
ok('capabilityPropertyNames() is extractable', !!fnSrc);
if (!fnSrc) { console.log(pass + ' passed, ' + fail + ' failed'); process.exit(1); }

// Run the real body in a sandbox with no DOM/state deps (it only reads `sheet`).
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fnSrc + '\nthis.capabilityPropertyNames = capabilityPropertyNames;', sandbox);
const capabilityPropertyNames = (sheet) => sandbox.capabilityPropertyNames(sheet);

section('1. Only user "properti" presets are advertised');
{
  const sheet = {
    presets: {
      user: [
        { name: 'Kacamata', category: 'properti' },
        { name: 'Syal', category: 'properti' },
        { name: 'Senang', category: 'emosi' },
        { name: 'Melambai', category: 'gerak' },
        { name: 'Topi', category: 'aksesoris' },
      ],
      ai: [
        { name: 'Cincin', category: 'properti' },
      ],
    },
  };
  const got = capabilityPropertyNames(sheet);
  ok('returns exactly the 2 user "properti" names', got.length === 2 && got.includes('Kacamata') && got.includes('Syal'),
    JSON.stringify(got));
  ok('excludes the "emosi" preset', !got.includes('Senang'));
  ok('excludes the "gerak" preset', !got.includes('Melambai'));
  ok('excludes the "aksesoris" preset', !got.includes('Topi'));
}

section('2. .ai "properti" suggestions are NEVER advertised');
{
  const sheet = {
    presets: {
      user: [],
      ai: [{ name: 'Cincin', category: 'properti' }, { name: 'Mahkota', category: 'properti' }],
    },
  };
  const got = capabilityPropertyNames(sheet);
  ok('empty when only .ai entries exist', got.length === 0, JSON.stringify(got));
}

section('3. A user "properti" and an .ai "properti" with the SAME name — user wins, duplicate-free');
{
  const sheet = {
    presets: {
      user: [{ name: 'Cincin', category: 'properti' }],
      ai: [{ name: 'Cincin', category: 'properti' }],
    },
  };
  const got = capabilityPropertyNames(sheet);
  ok('exactly one entry, the user-authored one', got.length === 1 && got[0] === 'Cincin', JSON.stringify(got));
}

section('4. Malformed / empty sheets never throw');
{
  ok('null sheet -> []', (() => { try { return capabilityPropertyNames(null).length === 0; } catch (e) { return false; } })());
  ok('undefined sheet -> []', (() => { try { return capabilityPropertyNames(undefined).length === 0; } catch (e) { return false; } })());
  ok('sheet without presets -> []', (() => { try { return capabilityPropertyNames({}).length === 0; } catch (e) { return false; } })());
  ok('presets:null -> []', (() => { try { return capabilityPropertyNames({ presets: null }).length === 0; } catch (e) { return false; } })());
  ok('presets.user:null -> []', (() => { try { return capabilityPropertyNames({ presets: { user: null } }).length === 0; } catch (e) { return false; } })());
}

section('5. Garbage / whitespace entries are dropped');
{
  const sheet = {
    presets: {
      user: [
        { name: '  ', category: 'properti' },
        { name: '', category: 'properti' },
        { category: 'properti' },          // missing name
        { name: 'Kacamata', category: 'properti' },
        { name: 123, category: 'properti' },// non-string name
      ],
    },
  };
  const got = capabilityPropertyNames(sheet);
  ok('only the valid "Kacamata" survives', got.length === 1 && got[0] === 'Kacamata', JSON.stringify(got));
}

section('6. Trimming — "  Kacamata  " is normalised');
{
  const sheet = { presets: { user: [{ name: '  Kacamata  ', category: 'properti' }] } };
  const got = capabilityPropertyNames(sheet);
  ok('name is trimmed', got.length === 1 && got[0] === 'Kacamata', JSON.stringify(got));
}

section('7. Source of truth — getCapabilityProfile wires properties via this helper');
{
  // The call site must use capabilityPropertyNames(sheet), not the now-removed
  // TODO inline. Guard the source so a regression re-introducing the dead TODO
  // (or hardcoding nativeExpressions) is caught.
  const useHelper = /properties:\s*capabilityPropertyNames\(sheet\)/.test(appSrc);
  ok('getCapabilityProfile uses capabilityPropertyNames(sheet)', useHelper);
  const noStaleTodo = !/TODO: 'properti' presets are still not surfaced/.test(appSrc);
  ok('the stale Langkah-1 TODO comment is gone', noStaleTodo);
  const notMerged = !/nativeExpressions:\s*sheet\.nativeExpressions\.concat\([^)]*'properti'/.test(appSrc);
  ok('properties are NOT merged into nativeExpressions (provenance kept separate)', notMerged);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
