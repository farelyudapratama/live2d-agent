/**
 * test-motion-registry.js — verifikasi js/motion-registry.js (Fase 1)
 *
 * Run: node test/test-motion-registry.js
 *
 * SPEC §29 (Registry): register/get/remove/search, penanganan ID duplikat,
 * pembungkus GESTURE_LIBRARY, entri native, katalog LLM, cooldown.
 */
const DSL = require('../js/motion-dsl.js');
const { createRegistry } = require('../js/motion-registry.js');
// Registry membaca MotionDSL dari global saat di browser; di Node berikan
// lewat require-fallback yang sama seperti di modulnya.
global.MotionDSL = DSL;

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
    requires: [], tracks: [{ target: 'ax', keys: [{ t: 0, v: 5 }] }],
  }, over || {});
}

// ── CRUD dasar ──
const R = createRegistry();
check('register ok', R.register(mkAsset('wave_hi')).ok);
check('get mengembalikan salinan (mutasi luar tak merusak)', (() => {
  const a = R.get('wave_hi'); a.name = 'dirusak'; return R.get('wave_hi').name === 'wave_hi';
})());
check('has benar', R.has('wave_hi') && !R.has('nope'));
check('remove benar', R.remove('nope') === false && R.remove('wave_hi') === true && !R.has('wave_hi'));

// ── ID duplikat lintas sumber ditolak ──
R.register(mkAsset('nod', { source: 'builtin' }));
const dup = R.register(mkAsset('nod', { source: 'user' }));
check('kolisi user vs builtin DITOLAK', !dup.ok && /builtin/.test(dup.error));
check('update dari sumber sama diperbolehkan', R.register(mkAsset('nod', { source: 'builtin', name: 'Nod v2' })).ok);
check('overwrite eksplisit memaksa replace', R.register(mkAsset('nod', { source: 'user', name: 'mine' }), { overwrite: true }).ok && R.get('nod').name === 'mine');
R.remove('nod');

// ── Pembungkus GESTURE_LIBRARY ──
const GESTURE_LIBRARY = {
  nod: [{ d: { ay: -8 }, ms: 160 }, { d: { ay: 6 }, ms: 160 }, { d: {}, ms: 160 }],
  wave_hi: [{ d: { ax: 8 }, ms: 200 }, { d: {}, ms: 200 }],
};
const EMOTION_GESTURE = { senang: 'lean_excited', normal: 'nod' };
R.registerGestureLibrary(GESTURE_LIBRARY, EMOTION_GESTURE);
const nod = R.get('nod');
check('gesture builtin terdaftar', !!nod && nod.source === 'builtin' && nod.type === 'gesture');
check('gesture builtin punya keyframe hasil konversi', nod.tracks.length === 1 && nod.tracks[0].target === 'ay' && nod.tracks[0].keys.length === 3);
check('emotionCompatibility dari peta emosi', (R.get('nod').emotionCompatibility || {}).normal === 0.7);
check('durasi = total ms steps (termasuk hold akhir)', R.get('nod').duration === 0.48);

// ── Native groups ──
R.registerNativeGroups(['Idle', 'Happy'], { Happy: { tags: ['happy'], duration: 2.5 } });
check('native terdaftar dengan id motion_<group>', R.has('motion_Idle') && R.has('motion_Happy'));
check('native prioritas 90 & tanpa tracks', R.get('motion_Happy').priority === 90 && R.get('motion_Happy').tracks.length === 0);
R.registerNativeGroups(['Idle', 'Happy', 'Sad']);
check('re-register native merefresh (overwrite)', R.has('motion_Sad'));
check('remove dengan source salah ditolak', R.remove('motion_Idle', 'user') === false && R.remove('motion_Idle', 'native') === true);

// ── replaceUserMotions ──
R.register(mkAsset('old_user', { source: 'user' }));
R.replaceUserMotions([mkAsset('u1', { source: 'user' }), mkAsset('u2', { source: 'user' })]);
check('replaceUserMotions membuang user lama', !R.has('old_user') && R.has('u1') && R.has('u2'));
check('replaceUserMotions tidak menyentuh builtin/native', R.has('nod') && R.has('motion_Happy'));

// ── search ──
R.register(mkAsset('greet_wave', { tags: ['greeting', 'happy'], emotionCompatibility: { senang: 1, sedih: 0.1 } }));
check('search by tag', R.search({ tags: ['greeting'] }).some(a => a.id === 'greet_wave'));
check('search tag AND', R.search({ tags: ['greeting', 'happy'] }).length === 1);
check('search tag yang tak cocok → kosong', R.search({ tags: ['nonexistent'] }).length === 0);
check('search by source', R.search({ source: 'builtin' }).every(a => a.source === 'builtin'));
check('search by emotion (skor >= 0.5)', R.search({ emotion: 'senang' }).some(a => a.id === 'greet_wave'));
check('search emotion skor rendah tak cocok', !R.search({ emotion: 'sedih' }).some(a => a.id === 'greet_wave'));

// ── Katalog LLM ──
R.register(mkAsset('hidden', { aiEnabled: false }));
const cat = R.catalogForLLM();
check('katalog menyembunyikan aiEnabled=false', !cat.some(c => c.id === 'hidden'));
check('katalog format ringkas (id+description+tags)', cat[0].id && cat[0].description !== undefined && Array.isArray(cat[0].tags));
check('katalog tanpa keyframe', cat.every(c => c.tracks === undefined));

// ── Cooldown ──
R.register(mkAsset('cd_test', { cooldown: 1000 }));
check('canPlay awal benar', R.canPlay('cd_test', 0));
R.markPlayed('cd_test', 0);
check('cooldown aktif menahan canPlay', !R.canPlay('cd_test', 500) && R.canPlay('cd_test', 1000));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
