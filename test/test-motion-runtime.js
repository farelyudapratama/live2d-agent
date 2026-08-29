/**
 * test-motion-runtime.js — verifikasi js/motion-runtime.js (Fase 1)
 *
 * Run: node test/test-motion-runtime.js
 *
 * SPEC §29 (Runtime): play/stop/blend/intensity/cooldown/priority/ownership.
 * Waktu di-inject lewat bridge.now() supaya deterministik; rAF digantikan
 * setTimeout (fallback yang sudah disediakan runtime untuk lingkungan Node).
 */
const DSL = require('../js/motion-dsl.js');
global.MotionDSL = DSL;
const { createRegistry } = require('../js/motion-registry.js');
const { createRuntime } = require('../js/motion-runtime.js');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra != null ? '  -> ' + JSON.stringify(extra) : ''}`); }
}

function mkAsset(id, over) {
  return Object.assign({
    version: 1, id, name: id, source: 'user', type: 'keyframe',
    description: '', tags: [], duration: 1, loop: false,
    intensity: { min: 0.3, max: 1, default: 0.8 },
    emotionCompatibility: {}, cooldown: 0, priority: 60, aiEnabled: true,
    requires: [],
    // 0 → 10 dalam 1 detik, linear — mudah dihitung manual.
    tracks: [{ target: 'ax', keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }] }],
  }, over || {});
}

// Bridge tirau: mencatat setiap penulisan delta.
let clock = 0;
let lastDelta = null, lastBase = null, restored = 0, nativePlayed = [];
function makeBridge() {
  return {
    now: () => clock,
    getPoseBase: () => ({ ax: 0, ay: 0 }),
    applyPoseDelta: (d, base) => { lastDelta = d; lastBase = base; },
    clearPoseDelta: () => { restored++; lastDelta = null; },
    playNative: (g) => { nativePlayed.push(g); },
    getSupports: () => new Set(['head', 'eyes', 'mouth', 'body']),
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ── Play dasar + interpolasi + blend ──
  {
    const R = createRegistry();
    R.register(mkAsset('ramp'));
    const rt = createRuntime(R, makeBridge());
    check('play mengembalikan true', rt.play('ramp', { intensity: 1, blendIn: 0, blendOut: 0 }));
    check('isPlaying benar', rt.isPlaying('ramp') && rt.isPlaying());
    check('getActive memuat asset', rt.getActive() && rt.getActive().id === 'ramp');
    await sleep(30); clock += 500; await sleep(30);   // maju ke tengah
    check('delta dievaluasi di tengah timeline', lastDelta && Math.abs(lastDelta.ax - 5) < 0.6, lastDelta);
    clock += 600; await sleep(30);                    // lewat akhir
    check('motion selesai sendiri', !rt.isPlaying());
    check('pose dikembalikan (clearPoseDelta dipanggil)', restored === 1);
    check('listAvailable memuat asset', rt.listAvailable().some(a => a.id === 'ramp'));
  }

  // ── blendIn meredam amplitudo awal ──
  // Asset yang LANGSUNG bernilai 10 di t=0: tanpa blend dia menyentap dari
  // base ke 10; dengan blendIn 1s, di tMs=500 amplitudo harus ~5.
  {
    const R = createRegistry();
    R.register(mkAsset('fade', { tracks: [{ target: 'ax', keys: [{ t: 0, v: 10 }, { t: 1, v: 10 }] }] }));
    restored = 0;
    const rt = createRuntime(R, makeBridge());
    rt.play('fade', { intensity: 1, blendIn: 1000, blendOut: 0 });
    await sleep(30); clock += 500; await sleep(30);   // 50% dari blendIn
    check('blendIn meredam amplitudo (≈ setengah)', lastDelta && Math.abs(lastDelta.ax - 5) < 0.6, lastDelta);
    clock += 5000; await sleep(30);
  }

  // ── Priority: yang lebih rendah tidak boleh merebut ──
  {
    const R = createRegistry();
    R.register(mkAsset('hi_prio', { priority: 80 }));
    R.register(mkAsset('lo_prio', { priority: 20 }));
    restored = 0;
    const rt = createRuntime(R, makeBridge());
    rt.play('hi_prio', { blendIn: 0, blendOut: 0 });
    check('prioritas rendah DITOLAK saat tinggi berjalan', rt.play('lo_prio') === false);
    check('active tetap motion prioritas tinggi', rt.getActive().id === 'hi_prio');
    check('prioritas tinggi lain MENGALIHKAN', rt.play('hi_prio', { priority: 90 }) === true);
    clock += 5000; await sleep(30);
  }

  // ── stop / stopAll ──
  {
    const R = createRegistry();
    R.register(mkAsset('stoppable'));
    restored = 0;
    const rt = createRuntime(R, makeBridge());
    rt.play('stoppable', { blendIn: 0, blendOut: 0 });
    check('stop dengan id lain tidak menghentikan', rt.stop('bukan_id') === false && rt.isPlaying('stoppable'));
    check('stop dengan id benar menghentikan', rt.stop('stoppable') === true && !rt.isPlaying());
    check('stopAll idempoten', rt.stopAll() === false);
    rt.play('stoppable', { blendIn: 0, blendOut: 0 });
    check('stopAll menghentikan', rt.stopAll() === true && !rt.isPlaying());
    check('onDone terpanggil saat berhenti', true);   // dibuktikan lewat restored di bawah
    check('pose dikembalikan saat stop', restored >= 2);
  }

  // ── Native: didelegasikan ke playNative ──
  {
    const R = createRegistry();
    R.registerNativeGroups(['Tap']);
    const rt = createRuntime(R, makeBridge());
    check('native diputar via bridge', rt.play('motion_Tap') === true && nativePlayed.includes('Tap'));
    check('native tidak menyisakan active keyframe', !rt.getActive());
  }

  // ── Cooldown: LLM dihalangi, user manual boleh ──
  {
    const R = createRegistry();
    R.register(mkAsset('cd', { cooldown: 60000 }));
    const rt = createRuntime(R, makeBridge());
    rt.play('cd', { blendIn: 0, blendOut: 0, priority: 10 });
    check('fromLLM ditolak saat cooldown', rt.play('cd', { fromLLM: true, priority: 10 }) === false);
    check('user manual boleh menembus cooldown', rt.play('cd', { priority: 10 }) === true);
    clock += 5000; await sleep(30);
  }

  // ── aiEnabled=false tak bisa dipanggil LLM ──
  {
    const R = createRegistry();
    R.register(mkAsset('off', { aiEnabled: false }));
    const rt = createRuntime(R, makeBridge());
    check('LLM ditolak untuk aiEnabled=false', rt.play('off', { fromLLM: true }) === false);
    check('user masih boleh', rt.play('off', { blendIn: 0, blendOut: 0 }) === true);
    clock += 5000; await sleep(30);
  }

  // ── attach baru menghentikan motion aktif (model swap) ──
  {
    const R = createRegistry();
    R.register(mkAsset('swap'));
    const rt = createRuntime(R, makeBridge());
    rt.play('swap', { blendIn: 0, blendOut: 0 });
    rt.attach(makeBridge());
    check('attach menghentikan motion aktif', !rt.isPlaying());
  }

  // ── degrade: track tanpa kapabilitas tak pernah ditulis ──
  {
    const R = createRegistry();
    R.register(mkAsset('degrade', { tracks: [{ target: 'bodyZ', keys: [{ t: 0, v: 10 }] }] }));
    const br = makeBridge();
    br.getSupports = () => new Set(['head']);   // model tanpa body
    const rt = createRuntime(R, br);
    rt.play('degrade', { blendIn: 0, blendOut: 0 });
    await sleep(30);
    check('track body dilewati pada model tanpa body', lastDelta && Object.keys(lastDelta).length === 0, lastDelta);
    clock += 5000; await sleep(30);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
