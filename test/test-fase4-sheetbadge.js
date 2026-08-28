// Fase 4 (Langkah 2c) tests — sheet preset source badges.
//
// paintPresetList() renders a badge per preset: 👤 for user-owned, 🤖 for AI
// suggestions (and "🤖 tertutup" when an AI suggestion is shadowed by a
// same-named user preset). The badge is driven entirely by resolvePresets()'s
// `source` and `suggestion` fields. We extract and run the REAL resolvePresets()
// so the badge contract can't silently regress.
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

const fnSrc = extractFn(appSrc, 'resolvePresets');
ok('resolvePresets() is extractable', !!fnSrc);
if (!fnSrc) { console.log(pass + ' passed, ' + fail + ' failed'); process.exit(1); }

// resolvePresets only reads `sheet.presets` — no other closure state needed.
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fnSrc + '\nthis.resolvePresets = resolvePresets;', sandbox);
const resolvePresets = (sheet, category) => sandbox.resolvePresets(sheet, category);

section('1. user preset is tagged source:user (badge 👤)');
{
  const sheet = { presets: { user: [{ name: 'Senang', category: 'emosi' }], ai: [] } };
  const items = resolvePresets(sheet, 'emosi');
  const it = items.find(x => x.name === 'Senang');
  ok('found the user preset', !!it);
  ok('source === "user"', it && it.source === 'user', it && it.source);
  ok('not flagged as suggestion', it && it.suggestion !== true);
}

section('2. AI suggestion (no clash) is tagged source:ai, suggestion:false (badge 🤖 saran)');
{
  const sheet = { presets: { user: [], ai: [{ name: 'Wink', category: 'emosi' }] } };
  const items = resolvePresets(sheet, 'emosi');
  const it = items.find(x => x.name === 'Wink');
  ok('found the ai preset', !!it);
  ok('source === "ai"', it && it.source === 'ai', it && it.source);
  ok('suggestion === false (not shadowed)', it && it.suggestion === false);
}

section('3. AI suggestion shadowed by same-named user preset → suggestion:true (badge 🤖 tertutup)');
{
  const sheet = {
    presets: {
      user: [{ name: 'Wink', category: 'emosi' }],
      ai: [{ name: 'Wink', category: 'emosi' }],
    },
  };
  const items = resolvePresets(sheet, 'emosi');
  const ai = items.find(x => x.source === 'ai' && x.name === 'Wink');
  const usr = items.find(x => x.source === 'user' && x.name === 'Wink');
  ok('user entry present', !!usr);
  ok('ai entry still present (listed, not deleted)', !!ai);
  ok('ai entry flagged suggestion:true', ai && ai.suggestion === true);
  ok('user entry NOT flagged suggestion', usr && usr.suggestion !== true);
  ok('both entries are distinct objects', ai !== usr);
}

section('4. category filter is honoured');
{
  const sheet = {
    presets: {
      user: [{ name: 'Syal', category: 'aksesoris' }, { name: 'Senang', category: 'emosi' }],
      ai: [{ name: 'X', category: 'gerak' }],
    },
  };
  const emosi = resolvePresets(sheet, 'emosi');
  ok('only emosi returned for emosi filter', emosi.length === 1 && emosi[0].name === 'Senang',
    JSON.stringify(emosi.map(x => x.name)));
  const all = resolvePresets(sheet);
  ok('no filter returns all 3', all.length === 3, String(all.length));
}

section('5. degenerate sheet never throws');
{
  ok('null sheet -> []', (() => { try { return resolvePresets(null).length === 0; } catch (e) { return false; } })());
  ok('sheet without presets -> []', (() => { try { return resolvePresets({}).length === 0; } catch (e) { return false; } })());
  ok('empty presets -> []', (() => { try { return resolvePresets({ presets: {} }).length === 0; } catch (e) { return false; } })());
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
