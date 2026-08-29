#!/usr/bin/env node
/**
 * test-motion-llm.js — integrasi LLM Motion Studio (Fase 5/6/7)
 *
 * Run: node test/test-motion-llm.js
 *
 * Yang dijamin di sini (SPEC §20/§29 bagian LLM + CONSTRAINTS §7):
 *  A. parseSegments() agent.js menerima [MOTION:] & [INTENSITY:] BARU tanpa
 *     merusak [GESTURE:] lama — kedua format hidup berdampingan.
 *  B. applyActions() mendahulukan motion, lalu JATUH ke gesture kalau motion
 *     ditolak runtime (id asing / cooldown) — segmen tidak pernah jadi diam.
 *  C. /api/animate-text membuang motion id yang tidak ada di katalog (null),
 *     sama seperti perlakuan gesture asing.
 *  D. /api/motions/generate memvalidasi keluaran LLM lewat sanitizeMotionAsset.
 *  E. Prompt tidak menawarkan blok Motion Studio saat katalog kosong.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const agentSrc = fs.readFileSync(path.join(ROOT, 'agent.js'), 'utf8');
const srvSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail != null ? '  -> ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail != null ? '  -> ' + detail : '')); }
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

// ── A. parseSegments menerima MOTION + GESTURE ──────────────────────────────
section('A. parseSegments(): [MOTION:] baru, [GESTURE:] lama tetap jalan');

const dirTypesLine = agentSrc.match(/const DIRECTIVE_TYPES = '([^']+)'/);
ok('DIRECTIVE_TYPES terpusat di satu const', !!dirTypesLine);
const psSrc = extractFn(agentSrc, 'parseSegments');
ok('parseSegments() bisa diekstrak', !!psSrc);
if (!psSrc || !dirTypesLine) { console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); }

const sandbox = { DIRECTIVE_TYPES: dirTypesLine[1] };
vm.createContext(sandbox);
vm.runInContext(psSrc + '\nthis.parseSegments = parseSegments;', sandbox);
const parseSegments = (t) => sandbox.parseSegments(t);

let segs = parseSegments('[EMOTION:senang][GESTURE:wave_hi] Halo!');
ok('format LAMA (gesture) tetap terparse', segs.length === 1 && segs[0].actions.gesture === 'wave_hi' && segs[0].actions.emotion === 'senang');

segs = parseSegments('[EMOTION:malu][MOTION:shy_look_away] Eh...');
ok('[MOTION:] terparse ke actions.motion', segs.length === 1 && segs[0].actions.motion === 'shy_look_away');
ok('[MOTION:] TIDAK mengisi actions.gesture', segs[0].actions.gesture === undefined);

segs = parseSegments('[MOTION:x][INTENSITY:0.9] Hai');
ok('[INTENSITY:] terparse & di-clamp', segs[0].actions.intensity === 0.9);
segs = parseSegments('[INTENSITY:5] Hai');
ok('[INTENSITY:] di luar rentang di-clamp ke 1', segs[0].actions.intensity === 1);
segs = parseSegments('[INTENSITY:abc] Hai');
ok('[INTENSITY:] non-numerik diabaikan', segs[0].actions.intensity === undefined);

segs = parseSegments('[EMOTION:senang][MOTION:a] Satu. [EMOTION:sedih][GESTURE:nod] Dua.');
ok('multi-segment campur MOTION + GESTURE', segs.length === 2 && segs[0].actions.motion === 'a' && segs[1].actions.gesture === 'nod');

segs = parseSegments('Selesai bicara.[MOTION:bow]');
ok('directive MOTION di ujung tanpa teks tetap jadi segmen', segs.length === 2 && segs[1].actions.motion === 'bow');

segs = parseSegments('Teks biasa tanpa directive.');
ok('teks polos tetap satu segmen tanpa actions', segs.length === 1 && Object.keys(segs[0].actions).length === 0);

// ── B. applyActions: motion diutamakan, fallback ke gesture ─────────────────
section('B. applyActions(): motion diutamakan, gagal → fallback gesture');

const aaSrc = extractFn(agentSrc, 'applyActions');
ok('applyActions() bisa diekstrak', !!aaSrc);

function runApply(actions, playMotionResult) {
  const calls = { motion: [], gesture: [], pose: [], expr: [] };
  const agent = {
    isReady: () => true,
    _getSupportedEmotions: () => ({ senang: {}, malu: {} }),
    setExpression: (n, i) => calls.expr.push([n, i]),
    setAIPose: (p) => calls.pose.push(p),
    setAccessory: () => {},
    playMotion: (id, o) => { calls.motion.push([id, o]); return playMotionResult; },
    playGesture: (g) => calls.gesture.push(g),
  };
  const sb = {
    window: { __live2dAgent: agent },
    capProfile: null,
    EMOTION_GESTURE_FALLBACK: { senang: 'lean_excited', malu: 'look_away_shy', normal: 'nod' },
    inferMovementFromEmotion: () => ({ head: { x: 0, y: 0 }, eyes: { x: 0, y: 0 }, body: { x: 0, y: 0, z: 0 } }),
    Math, console,
  };
  vm.createContext(sb);
  vm.runInContext(aaSrc + '\nthis.applyActions = applyActions;', sb);
  sb.applyActions(actions, 0, 1);
  return calls;
}

let c = runApply({ emotion: 'malu', motion: 'shy_look_away', intensity: 0.7 }, true);
ok('motion dipanggil dengan fromLLM=true', c.motion.length === 1 && c.motion[0][1].fromLLM === true);
ok('motion memakai prioritas 80 (explicit LLM motion)', c.motion[0][1].priority === 80);
ok('intensity diteruskan ke runtime', c.motion[0][1].intensity === 0.7);
ok('gesture TIDAK dipanggil saat motion berhasil', c.gesture.length === 0);

c = runApply({ emotion: 'malu', motion: 'tidak_ada', gesture: 'nod' }, false);
ok('motion ditolak → gesture eksplisit dipakai', c.gesture.length === 1 && c.gesture[0] === 'nod');

c = runApply({ emotion: 'senang', motion: 'tidak_ada' }, false);
ok('motion ditolak tanpa gesture → fallback per emosi', c.gesture.length === 1 && c.gesture[0] === 'lean_excited');

c = runApply({ emotion: 'senang', gesture: 'wave_hi' }, false);
ok('segmen tanpa motion sama sekali: perilaku lama utuh', c.motion.length === 0 && c.gesture[0] === 'wave_hi');

// ── E. Prompt: blok Motion Studio hanya saat katalog berisi ────────────────
section('E. motionCatalogBlock(): kosong = tidak menawarkan fitur');

const mcbSrc = extractFn(agentSrc, 'motionCatalogBlock');
ok('motionCatalogBlock() bisa diekstrak', !!mcbSrc);
const sb2 = {};
vm.createContext(sb2);
vm.runInContext(mcbSrc + '\nthis.motionCatalogBlock = motionCatalogBlock;', sb2);
ok('katalog kosong → string kosong', sb2.motionCatalogBlock({ motionCatalog: [] }) === '');
ok('profil null → string kosong', sb2.motionCatalogBlock(null) === '');
const blk = sb2.motionCatalogBlock({ motionCatalog: [{ id: 'shy_look_away', description: 'menunduk malu', tags: ['malu'], compatibleEmotions: ['malu'] }] });
ok('katalog berisi → id disebut persis', blk.includes('shy_look_away'));
ok('blok menyebut format [MOTION:', blk.includes('[MOTION:'));
ok('blok melarang mengarang id', /jangan mengarang/i.test(blk));

// ── C + D. Endpoint (butuh server hidup, provider mock) ────────────────────
const PORT = 18000 + Math.floor(Math.random() * 20000);
const BASE = 'http://127.0.0.1:' + PORT;

async function waitForServer(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(BASE + '/api/models'); if (r.ok) return true; } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

(async () => {
  section('C+D. endpoint animate-text / generate / analyze');

  // Validator dipakai bersama: buktikan server memakai modul yang sama.
  ok('server.js require motion-dsl (validator dipakai bersama)',
    /require\(['"]\.\/js\/motion-dsl\.js['"]\)/.test(srvSrc));
  ok('animate-text memvalidasi motion terhadap katalog',
    /const okMotion = new Set\(motions\.map\(m => m\.id\)\)/.test(srvSrc));
  ok('motion asing dijadikan null, bukan diteruskan',
    /okMotion\.has\(s\.motion\) \? s\.motion : null/.test(srvSrc));
  ok('generate melewatkan hasil LLM ke sanitizeMotionAsset',
    /MotionDSL\.sanitizeMotionAsset\(parsed, \{ requireTracks: true/.test(srvSrc));
  ok('analyze TIDAK menyimpan apa pun (tak ada queueJsonWrite di handler)', (() => {
    const i = srvSrc.indexOf("urlPath === '/api/motions/analyze'");
    const j = srvSrc.indexOf("urlPath === '/api/motions/generate'");
    return i > 0 && j > i && !srvSrc.slice(i, j).includes('queueJsonWrite');
  })());
  ok('generate TIDAK menyimpan apa pun', (() => {
    const i = srvSrc.indexOf("urlPath === '/api/motions/generate'");
    const j = srvSrc.indexOf("urlPath.startsWith('/api/motions/')", i);
    return i > 0 && j > i && !srvSrc.slice(i, j).includes('queueJsonWrite');
  })());
  ok('analyze/generate terdaftar SEBELUM handler /api/motions/<id>',
    srvSrc.indexOf("urlPath === '/api/motions/analyze'") < srvSrc.indexOf("req.method === 'GET' && urlPath.startsWith('/api/motions/')"));

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});

  try {
    ok('server hidup', await waitForServer(15000), BASE);

    // animate-text: teks kosong → tanpa segmen (tak butuh LLM sungguhan)
    let r = await fetch(BASE + '/api/animate-text', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '', capabilities: {} }),
    });
    let d = await r.json();
    ok('animate-text teks kosong → segments []', r.status === 200 && Array.isArray(d.segments) && d.segments.length === 0);

    // animate-text dengan katalog motion: struktur balasan selalu punya field motion
    r = await fetch(BASE + '/api/animate-text', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'Halo dunia.',
        capabilities: { emotions: ['senang'], gestures: ['nod'], motions: [{ id: 'shy_look_away', description: 'menunduk' }] },
      }),
    });
    d = await r.json();
    ok('animate-text selalu balas 200 dengan segments', r.status === 200 && Array.isArray(d.segments) && d.segments.length >= 1);
    ok('setiap segmen punya emotion & gesture tervalidasi',
      d.segments.every(s => typeof s.text === 'string' && 'emotion' in s && 'gesture' in s));

    // generate: prompt kosong → 400
    r = await fetch(BASE + '/api/motions/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    });
    ok('generate prompt kosong → 400', r.status === 400);

    // analyze: motion tanpa track → 400
    r = await fetch(BASE + '/api/motions/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ motion: { duration: 1, tracks: [] } }),
    });
    ok('analyze motion tanpa track → 400', r.status === 400);

    // analyze: body rusak → 400
    r = await fetch(BASE + '/api/motions/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{rusak',
    });
    ok('analyze body JSON rusak → 400', r.status === 400);
  } catch (e) {
    fail++;
    console.log('  FAIL  exception: ' + e.message);
  } finally {
    server.kill();
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
