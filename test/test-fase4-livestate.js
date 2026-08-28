// Fase 4 (Langkah 2b) tests — live-state indicator data contract.
//
// The live-state strip renders window.__agent._reactiveState(). This test loads
// agent.js in a sandbox with minimal window/location stubs (no DOM needed —
// _reactiveState() only reads closure variables) and asserts the shape the
// indicator depends on, so a refactor that renames/drops a field breaks here
// instead of silently showing "—" forever in the UI.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const agentSrc = fs.readFileSync(path.join(ROOT, 'agent.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  -> ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

section('1. agent.js boots with window/location stubs (no DOM)');
const sandbox = {
  window: {},
  location: { origin: 'http://127.0.0.1:8310', protocol: 'http:' },
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: () => Promise.reject(new Error('no network in test')),
  Date,
};
sandbox.global = sandbox;
vm.createContext(sandbox);
let booted = true;
try { vm.runInContext(agentSrc, sandbox); } catch (e) { booted = false; console.log('  boot error: ' + e.message); }
ok('agent.js evaluates without throwing', booted);
ok('window.__agent is published', !!(sandbox.window && sandbox.window.__agent));

section('2. _reactiveState() shape matches the indicator contract');
const agent = sandbox.window && sandbox.window.__agent;
ok('_reactiveState is a function', !!(agent && typeof agent._reactiveState === 'function'));
if (agent && typeof agent._reactiveState === 'function') {
  const st = agent._reactiveState();
  ok('returns an object', st && typeof st === 'object');
  ok('has presenceState field', 'presenceState' in st, JSON.stringify(st && st.presenceState));
  ok('has userMood field', 'userMood' in st);
  ok('has moodSource field', 'moodSource' in st);
  ok('has quietMs field (number)', 'quietMs' in st && typeof st.quietMs === 'number', String(st && st.quietMs));
  ok('has events field', 'events' in st);
  // The indicator reads these three specifically:
  ok('presenceState is null|true|false', [null, true, false].includes(st.presenceState));
  ok('quietMs is non-negative', st.quietMs >= 0);
}

section('3. mood state is readable after setUserMood (no crash, source tracked)');
if (agent) {
  let crashed = false;
  try {
    agent.setUserMood('sedih', 'text');
    const st = agent._reactiveState();
    ok('userMood reflects setUserMood', st.userMood === 'sedih', st.userMood);
    ok('moodSource recorded as text', st.moodSource === 'text', String(st.moodSource));
    agent.setUserMood('normal');
    const st2 = agent._reactiveState();
    ok('reset to normal clears moodSource', st2.userMood === 'normal' && st2.moodSource === null);
  } catch (e) { crashed = true; console.log('  crash: ' + e.message); }
  ok('setUserMood path did not crash', !crashed);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
