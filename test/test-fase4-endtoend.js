// Fase 4 (Langkah 3) tests — end-to-end LLM directive → engine motion.
//
// This is the verification the plan demanded but no test ever did: prove that a
// real LLM reply containing [EMOTION:]/[GESTURE:]/[ACC:]/[PROP:] directives
// actually reaches the engine calls, not just that the reply is parsed. We load
// agent.js in a sandbox with a MOCK window.__live2dAgent that records every
// setExpression/setAIPose/playGesture/setAccessory/applyPreset call, stub fetch
// to return a directive-rich reply from the chat proxy, then drive think().
//
// What we assert (the plan's "4 directive terbukti tereksekusi" + multi-segment):
//   1. [EMOTION:senang]  -> setExpression('senang', ...) called
//   2. [GESTURE:wave_hi] -> playGesture('wave_hi') called
//   3. [ACC:ParamXX:1]   -> setAccessory('ParamXX', 1) called
//   4. [PROP:Kacamata]   -> setExpression('Kacamata') called (property path)
//   5. multi-segment: >= 2 segments with differing emotion/gesture
//   6. invert: a reply with NO directives still produces a speech (fallback path)
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

// ── Mock engine: records every motion call ──
const calls = { setExpression: [], setAIPose: [], playGesture: [], setAccessory: [], applyPreset: [], speak: [] };
const mockAgent = {
  isReady: () => true,
  lockAI() {}, unlockAI() {},
  getCapabilityProfile: () => Promise.resolve({
    emotions: ['senang', 'sedih', 'malu', 'kaget', 'normal'],
    nativeExpressions: ['Kacamata', 'Syal'],
    accessories: [],
    properties: ['Kacamata', 'Syal'],
    gestures: ['wave_hi', 'nod', 'shake', 'lean_excited', 'look_away_shy', 'recoil_surprised', 'think', 'tilt_curious', 'laugh_bounce'],
    roleIds: { angleX: 'ParamAngleX' },
    sheet: { params: [{ id: 'ParamXX', group: 'aksesoris' }], supportedEmotions: {} },
  }),
  _getSupportedEmotions: () => ({ senang: {}, sedih: {}, malu: {}, kaget: {}, normal: {} }),
  setExpression: (n, int) => { calls.setExpression.push({ name: n, int }); },
  setAIPose: (p) => { calls.setAIPose.push(p); },
  playGesture: (n) => { calls.playGesture.push(n); },
  setAccessory: (id, v) => { calls.setAccessory.push({ id, v }); },
  applyPreset: (p) => { calls.applyPreset.push(p); return true; },
  speak: (text, cb) => { calls.speak.push(text); if (cb) setTimeout(cb, 0); },
};
// A [PROP:] for "Kacamata" resolves through applyExpression() -> property path
// -> setExpression(name). Our mock setExpression records it; we detect PROP by
// checking the name appears in the capability properties list.

const sandbox = {
  window: {
    __live2dAgent: mockAgent,
    addEventListener() {},
  },
  location: { origin: 'http://127.0.0.1:8310', protocol: 'http:' },
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date,
  document: { getElementById: () => null, addEventListener() {} },
};
// fetch stub: POST /api/chat returns a directive-rich reply; everything else 404.
let lastChatReply = '';
sandbox.fetch = (url, opts) => {
  if (typeof url === 'string' && url.indexOf('/api/chat') !== -1) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ reply: lastChatReply }),
    });
  }
  return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
};
sandbox.window.__addChat = () => {};

vm.createContext(sandbox);
let booted = true;
try { vm.runInContext(agentSrc, sandbox); } catch (e) { booted = false; console.log('boot error: ' + e.message); }
ok('agent.js boots in sandbox', booted);
const agent = sandbox.window.__agent;
ok('window.__agent published', !!agent);

async function run() {
  section('1. EMOTION + GESTURE + ACC + PROP all reach the engine');
  lastChatReply =
    '[EMOTION:senang][GESTURE:wave_hi] Halo! [EMOTION:malu][ACC:ParamXX:1] Ini aku pakai kacamata ya~ ' +
    '[PROP:Kacamata]';
  // reset call log
  for (const k in calls) calls[k] = [];
  await agent.think('halo');
  // give the async multi-segment speak chain a tick to flush (180ms between segments)
  await new Promise(r => setTimeout(r, 600));

  ok('setExpression called for senang + malu (emotion path)',
    calls.setExpression.some(c => c.name === 'senang') && calls.setExpression.some(c => c.name === 'malu'),
    JSON.stringify(calls.setExpression.map(c => c.name)));
  ok('playGesture called for wave_hi',
    calls.playGesture.indexOf('wave_hi') !== -1, JSON.stringify(calls.playGesture));
  ok('setAccessory called with ParamXX:1',
    calls.setAccessory.some(c => c.id === 'ParamXX' && c.v === 1), JSON.stringify(calls.setAccessory));
  ok('PROP:Kacamata reached setExpression("Kacamata")',
    calls.setExpression.some(c => c.name === 'Kacamata'), JSON.stringify(calls.setExpression.map(c => c.name)));
  ok('at least one setAIPose (head/eyes/body target)', calls.setAIPose.length >= 1,
    String(calls.setAIPose.length));
  ok('speak() was driven (character talked)', calls.speak.length >= 1, String(calls.speak.length));

  section('2. multi-segment: reply splits into >= 2 segments with differing emotion');
  // parseSegments is internal; we infer multi-segment from number of speak() calls
  // (each segment speaks once) and distinct emotions applied.
  const distinctEmotions = new Set(calls.setExpression.filter(c => ['senang', 'malu'].includes(c.name)).map(c => c.name));
  ok('>= 2 distinct emotions applied across segments', distinctEmotions.size >= 2,
    JSON.stringify(Array.from(distinctEmotions)));
  ok('>= 2 speak() segments (multi-segment delivery)', calls.speak.length >= 2, String(calls.speak.length));

  section('3. no-directive reply still speaks (fallback path)');
  for (const k in calls) calls[k] = [];
  lastChatReply = 'Hai, senang ketemu kamu hari ini. Ceritakan dong, ada yang bisa kubantu?';
  await agent.think('apa kabar?');
  await new Promise(r => setTimeout(r, 600));
  ok('speak() fired even with no directives', calls.speak.length >= 1, String(calls.speak.length));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
run().catch(e => { console.log('RUN ERROR: ' + e.message); process.exit(1); });
