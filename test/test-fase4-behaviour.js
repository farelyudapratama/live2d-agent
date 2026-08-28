// Fase 4 (Langkah 2a) tests — Behaviour panel persistence.
//
// mergeEventsIntoConfig(prev, incoming) is a pure helper in server.js: it
// replaces the config's events block with the incoming values while PRESERVING
// every other block (connections, tts, camera, motion) and dropping unknown
// event keys. We extract and run the REAL function (no disk writes) so a broken
// merge cannot pass.
//
// Why this matters: the Behaviour panel must round-trip the user's ambient-event
// tuning WITHOUT ever rewriting (and thus risking) their API keys. A naive
// Object.assign(prev, {events}) would be fine, but merging+filtering wrong could
// drop a connection or leak a stray key into config.json.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

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

const fnSrc = extractFn(srvSrc, 'mergeEventsIntoConfig');
ok('mergeEventsIntoConfig() is extractable', !!fnSrc);
if (!fnSrc) { console.log(pass + ' passed, ' + fail + ' failed'); process.exit(1); }

// The function only references Object.assign + the module-level KNOWN_EVENT_KEYS
// const. We provide KNOWN_EVENT_KEYS in the sandbox.
const KNOWN_EVENT_KEYS = ['idleSpeak', 'idleMs', 'idleRepeatMs', 'awaySpeak', 'returnSpeak', 'awayHiddenMs', 'quietMs'];
const sandbox = { KNOWN_EVENT_KEYS };
vm.createContext(sandbox);
vm.runInContext(fnSrc + '\nthis.mergeEventsIntoConfig = mergeEventsIntoConfig;', sandbox);
const mergeEventsIntoConfig = (prev, incoming) => sandbox.mergeEventsIntoConfig(prev, incoming);

section('1. connections are NEVER touched by an events save');
{
  const prev = {
    activeId: 'conn_1',
    connections: [{ id: 'conn_1', apiKey: 'SECRET', provider: 'gemini' }],
    tts: { endpoint: 'https://x.gradio.live' },
    events: { quietMs: 1800000, idleMs: 1800000 },
  };
  const out = mergeEventsIntoConfig(prev, { quietMs: 15000, idleMs: 45000 });
  ok('connections survive unchanged (incl. apiKey)', JSON.stringify(out.connections) === JSON.stringify(prev.connections),
    out.connections && out.connections[0] && out.connections[0].apiKey);
  ok('tts block preserved', JSON.stringify(out.tts) === JSON.stringify(prev.tts));
  ok('activeId preserved', out.activeId === 'conn_1');
}

section('2. events block is replaced by incoming values');
{
  const prev = { events: { quietMs: 1800000, idleMs: 1800000, idleRepeatMs: 1800000, awayHiddenMs: 10000 } };
  const out = mergeEventsIntoConfig(prev, { quietMs: 15000, idleMs: 45000, idleRepeatMs: 90000 });
  ok('new quietMs applied', out.events.quietMs === 15000);
  ok('new idleMs applied', out.events.idleMs === 45000);
  ok('new idleRepeatMs applied', out.events.idleRepeatMs === 90000);
  ok('untouched key (awayHiddenMs) kept from prev', out.events.awayHiddenMs === 10000);
}

section('3. unknown / stray keys are dropped (no config pollution)');
{
  const prev = { events: { quietMs: 1800000 }, connections: [] };
  const out = mergeEventsIntoConfig(prev, { quietMs: 1000, hackerField: 'x', malware: 1 });
  ok('hackerField not present', !('hackerField' in out.events));
  ok('malware not present', !('malware' in out.events));
  ok('quietMs still applied', out.events.quietMs === 1000);
}

section('4. degenerate inputs never throw');
{
  ok('null prev -> events only', (() => { try { const o = mergeEventsIntoConfig(null, { quietMs: 1 }); return o.events.quietMs === 1; } catch (e) { return false; } })());
  ok('undefined prev -> events only', (() => { try { const o = mergeEventsIntoConfig(undefined, { quietMs: 1 }); return o.events.quietMs === 1; } catch (e) { return false; } })());
  ok('null incoming -> prev events kept', (() => { try { const o = mergeEventsIntoConfig({ events: { quietMs: 5 } }, null); return o.events.quietMs === 5; } catch (e) { return false; } })());
  ok('empty incoming -> prev events kept', (() => { try { const o = mergeEventsIntoConfig({ events: { quietMs: 5 } }, {}); return o.events.quietMs === 5; } catch (e) { return false; } })());
}

section('5. toggles (booleans) round-trip');
{
  const prev = { events: { idleSpeak: true, awaySpeak: true, returnSpeak: true } };
  const out = mergeEventsIntoConfig(prev, { idleSpeak: false, awaySpeak: false });
  ok('idleSpeak flips to false', out.events.idleSpeak === false);
  ok('awaySpeak flips to false', out.events.awaySpeak === false);
  ok('returnSpeak kept true (not in incoming)', out.events.returnSpeak === true);
}

section('6. source of truth — handler uses the pure merge, not inline Object.assign');
{
  // The saveEvents branch must call mergeEventsIntoConfig (not re-declare
  // KNOWN_EVENT_KEYS inline). Guard the source so a regression that re-inlines
  // the filtering (which previously dropped connections risk) is caught.
  const handlerUsesMerge = /action === 'saveEvents'[\s\S]*?mergeEventsIntoConfig\(/.test(srvSrc);
  ok('POST /api/config saveEvents calls mergeEventsIntoConfig', handlerUsesMerge);
  const noInlineKeys = !/else if \(action === 'saveEvents'\)\s*\{[\s\S]*?const KNOWN_EVENT_KEYS = \[/.test(srvSrc);
  ok('saveEvents does NOT re-declare KNOWN_EVENT_KEYS inline', noInlineKeys);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
