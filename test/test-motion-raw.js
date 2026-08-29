#!/usr/bin/env node
/**
 * test-motion-raw.js — Raw Parameter Mode (track parameter mentah)
 *
 * Run: node test/test-motion-raw.js
 *
 * Yang dijamin di sini:
 *  A. DSL menerima track kind 'param' (nilai ABSOLUT, range milik rig) dan
 *     tidak meng-clamp-nya ke ±30/±1 seperti track peran.
 *  B. Track param TIDAK diskalakan intensity (nilai absolut ≠ amplitudo).
 *  C. Track param yang parameternya tidak dimiliki model DILEWATI, bukan error.
 *  D. Easing per key menang atas interp level track (model Cubism).
 *  E. sourceModelId + modelScoped tercatat untuk motion yang punya track param.
 *  F. Migrasi rolesToParamTracks(): 8 field semantik → parameter rig, dengan
 *     proyeksi ke range asli; peran tanpa padanan dibiarkan utuh.
 *  G. app.js punya jalur tulis per-frame (applyRawDrive) — inilah yang membuat
 *     preview realtime bekerja meski internalModel.update() menimpa parameter.
 *  H. Runtime memutar track param lewat bridge applyParamDrive dan melepasnya
 *     saat selesai (kalau tidak, pose nyangkut di keyframe terakhir).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DSL = require('../js/motion-dsl.js');
global.MotionDSL = DSL;
const { createRegistry } = require('../js/motion-registry.js');
const { createRuntime } = require('../js/motion-runtime.js');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
const edSrc = fs.readFileSync(path.join(ROOT, 'js', 'motion-editor.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail != null ? '  -> ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail != null ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

// ── A. Track param: nilai absolut, tidak di-clamp ke bound semantik ────────
section('A. track kind=param menerima nilai di luar ±30 (range milik rig)');

const rawAsset = {
  id: 'raw_test', name: 'Raw', duration: 1,
  sourceModelId: 'model_lumine',
  tracks: [
    { param: 'ParamHairFront', min: 0, max: 100, keys: [{ t: 0, v: 0 }, { t: 1, v: 85 }] },
    { param: 'ParamCheek', min: 0, max: 1, keys: [{ t: 0, v: 0.2 }] },
  ],
};
const s = DSL.sanitizeMotionAsset(rawAsset, { requireTracks: true });
ok('asset raw lolos sanitasi', s.ok, s.errors);
ok('nilai 85 TIDAK di-clamp ke 30', s.ok && s.asset.tracks[0].keys[1].v === 85);
ok('kind=param tercatat', s.ok && s.asset.tracks[0].kind === 'param');
ok('id parameter dipertahankan apa adanya', s.ok && s.asset.tracks[0].param === 'ParamHairFront');
ok('range min/max ikut tersimpan', s.ok && s.asset.tracks[0].min === 0 && s.asset.tracks[0].max === 100);
ok('nilai non-finite tetap ditolak', !DSL.sanitizeMotionAsset(
  { id: 'x', tracks: [{ param: 'P', keys: [{ t: 0, v: NaN }] }] }, { requireTracks: true }).ok);
ok('track param duplikat dibuang', (() => {
  const r = DSL.sanitizeMotionAsset({ id: 'x', duration: 1, tracks: [
    { param: 'P1', keys: [{ t: 0, v: 1 }] }, { param: 'P1', keys: [{ t: 0, v: 9 }] },
  ] }, { requireTracks: true });
  return r.ok && r.asset.tracks.length === 1;
})());
ok('track param dan track peran bisa hidup berdampingan', (() => {
  const r = DSL.sanitizeMotionAsset({ id: 'x', duration: 1, tracks: [
    { param: 'P1', keys: [{ t: 0, v: 1 }] }, { target: 'ax', keys: [{ t: 0, v: 5 }] },
  ] }, { requireTracks: true });
  return r.ok && r.asset.tracks.length === 2
    && r.asset.tracks.some(t => t.kind === 'param') && r.asset.tracks.some(t => t.kind === 'role');
})());
ok('batas track dinaikkan dari 8 (Raw Mode butuh belasan)', DSL.LIMITS.tracksMax >= 24, String(DSL.LIMITS.tracksMax));

// ── B. Intensity TIDAK menskalakan nilai absolut ──────────────────────────
section('B. intensity tidak boleh menggeser nilai parameter absolut');

const ev1 = DSL.evaluateAsset(s.asset, 1, 1.0, null, null);
const ev2 = DSL.evaluateAsset(s.asset, 1, 0.3, null, null);
ok('intensity 1.0 → 85', ev1.__params.ParamHairFront === 85, String(ev1.__params.ParamHairFront));
ok('intensity 0.3 TETAP 85 (bukan 25.5)', ev2.__params.ParamHairFront === 85, String(ev2.__params.ParamHairFront));
ok('track peran TETAP diskalakan intensity', (() => {
  const a = DSL.sanitizeMotionAsset({ id: 'x', duration: 1, tracks: [{ target: 'ax', keys: [{ t: 0, v: 10 }] }] }, { requireTracks: true });
  const e = DSL.evaluateAsset(a.asset, 0, 0.5, null, null);
  return e.__roles.ax === 5;
})());
ok('bentuk lama (delta polos di root) tetap tersedia', ev1.ax === undefined && typeof ev1.__roles === 'object');

// ── C. Parameter yang tidak dimiliki model dilewati dengan aman ───────────
section('C. graceful skip untuk parameter yang tidak ada di model ini');

const owned = new Set(['ParamCheek']);
const evOwn = DSL.evaluateAsset(s.asset, 1, 1, null, owned);
ok('param yang dimiliki tetap dievaluasi', evOwn.__params.ParamCheek !== undefined);
ok('param yang TIDAK dimiliki dilewati (bukan error)', evOwn.__params.ParamHairFront === undefined);
ok('ownedParams kosong/null = jangan filter apa pun',
  DSL.evaluateAsset(s.asset, 1, 1, null, new Set()).__params.ParamHairFront === 85);

// ── D. Easing per key ─────────────────────────────────────────────────────
section('D. easing per key menang atas interp track');

const tr = { interp: 'linear', keys: [{ t: 0, v: 0, easing: 'stepped' }, { t: 1, v: 10 }] };
ok('key easing=stepped menahan nilai di tengah segmen', DSL.evalTrack(tr, 0.5) === 0);
const tr2 = { interp: 'stepped', keys: [{ t: 0, v: 0, easing: 'linear' }, { t: 1, v: 10 }] };
ok('key easing=linear mengalahkan interp=stepped', DSL.evalTrack(tr2, 0.5) === 5);
ok('tanpa key easing, interp track dipakai', DSL.evalTrack({ interp: 'stepped', keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }] }, 0.5) === 0);
ok('easing tersimpan lewat sanitasi', (() => {
  const r = DSL.sanitizeMotionAsset({ id: 'x', duration: 1, tracks: [
    { param: 'P', keys: [{ t: 0, v: 1, easing: 'ease-out' }] },
  ] }, { requireTracks: true });
  return r.ok && r.asset.tracks[0].keys[0].easing === 'ease-out';
})());
ok('easing tak dikenal dibuang', (() => {
  const r = DSL.sanitizeMotionAsset({ id: 'x', duration: 1, tracks: [
    { param: 'P', keys: [{ t: 0, v: 1, easing: 'bouncy-magic' }] },
  ] }, { requireTracks: true });
  return r.ok && r.asset.tracks[0].keys[0].easing === undefined;
})());

// ── E. Model-scoped metadata ──────────────────────────────────────────────
section('E. sourceModelId + modelScoped');

ok('sourceModelId tercatat', s.ok && s.asset.sourceModelId === 'model_lumine');
ok('modelScoped=true saat ada track param', s.ok && s.asset.modelScoped === true);
ok('motion murni peran TIDAK ditandai modelScoped', (() => {
  const r = DSL.sanitizeMotionAsset({ id: 'x', duration: 1, tracks: [{ target: 'ax', keys: [{ t: 0, v: 5 }] }] }, { requireTracks: true });
  return r.ok && !r.asset.modelScoped;
})());
ok('sourceModelId bisa di-inject lewat opts (server)', (() => {
  const r = DSL.sanitizeMotionAsset({ id: 'x', duration: 1, tracks: [{ param: 'P', keys: [{ t: 0, v: 1 }] }] },
    { requireTracks: true, sourceModelId: 'dari_server' });
  return r.ok && r.asset.sourceModelId === 'dari_server';
})());

// ── F. Migrasi motion semantik lama → track parameter ────────────────────
section('F. rolesToParamTracks(): migrasi motion lama');

const legacy = DSL.sanitizeMotionAsset({
  id: 'legacy', duration: 1,
  tracks: [
    { target: 'ay', keys: [{ t: 0, v: 0 }, { t: 0.5, v: 15 }] },   // 15 dari ±30 = 0.5
    { target: 'mouthForm', keys: [{ t: 0, v: 1 }] },               // 1 dari ±1 = 1.0
  ],
}, { requireTracks: true }).asset;

const roleMap = { angleY: 'ParamAngleY', mouthForm: 'ParamMouthForm' };
const ranges = {
  ParamAngleY: { min: -30, max: 30, def: 0 },
  ParamMouthForm: { min: -1, max: 1, def: 0 },
};
const migrated = DSL.rolesToParamTracks(legacy, roleMap, ranges);
ok('semua track jadi kind=param', migrated.tracks.every(t => t.kind === 'param'));
ok('ay → ParamAngleY', migrated.tracks[0].param === 'ParamAngleY');
ok('nilai diproyeksikan ke range asli (15/30 × 30 = 15)', migrated.tracks[0].keys[1].v === 15, String(migrated.tracks[0].keys[1].v));
ok('mouthForm 1.0 → 1 pada range −1..1', migrated.tracks[1].keys[0].v === 1);
ok('label peran disimpan untuk keterbacaan', migrated.tracks[0].label === 'ay');
ok('modelScoped ditandai setelah migrasi', migrated.modelScoped === true);

// Proyeksi ke rig ber-range LAIN: inilah alasan migrasi tidak boleh menyalin
// angka mentah — 15 derajat di rig 0..1 berarti pose meledak.
const oddRanges = { ParamAngleY: { min: 0, max: 1, def: 0.5 } };
const odd = DSL.rolesToParamTracks(legacy, { angleY: 'ParamAngleY' }, oddRanges);
ok('rig 0..1: delta 15° → 0.75 (bukan 15)', odd.tracks[0].keys[1].v === 0.75, String(odd.tracks[0].keys[1].v));
ok('peran tanpa padanan dibiarkan utuh (tidak dibuang)',
  odd.tracks.some(t => t.kind === 'role' && t.target === 'mouthForm'));

// ── G. app.js: jalur tulis per-frame ─────────────────────────────────────
section('G. app.js — preview realtime butuh penulisan setiap frame');

ok('applyRawDrive() ada', /function applyRawDrive\(\)/.test(appSrc));
ok('dipanggil di dalam tick, SETELAH applyOverrides',
  /applyOverrides\(\);\s*\r?\n\s*applyRawDrive\(\);/.test(appSrc),
  'raw drive harus penulis terakhir agar menang atas idle/emosi/sticky');
// rAF bisa MATI total (tab background, webview tanpa compositing). Kalau
// setRawDrive hanya menyimpan nilai dan menunggu frame, menggeser slider pada
// kondisi itu tidak menghasilkan apa pun dan editor terlihat rusak.
ok('setRawDrive() juga menulis LANGSUNG, tidak menunggu frame',
  /if \(!Object\.keys\(state\.rawDrive\)\.length\) state\.rawDrive = null;\s*\r?\n\s*applyRawDrive\(\);/.test(appSrc));
// Parameter yang tidak dikemudikan sistem lain (pipi, rambut, aksesoris) tidak
// akan pernah kembali sendiri — nilai sebelum drive harus disimpan & dipulihkan.
ok('nilai sebelum drive disimpan untuk pemulihan', /rawDrivePrev/.test(appSrc));
ok('melepas satu param memulihkan nilai aslinya',
  /if \(id in state\.rawDrivePrev\)/.test(appSrc));
ok('clearRawDrive() memulihkan SEMUA param yang pernah dikemudikan',
  /function clearRawDrive\(\)[\s\S]{0,400}for \(const id in prev\)/.test(appSrc));
ok('nilai di-clamp ke range asli Cubism bila tersedia',
  /state\.paramRange\s*&&\s*state\.paramRange\[id\]/.test(appSrc));
ok('setRawDrive/clearRawDrive diekspos ke editor',
  /setRawDrive,\s*\r?\n\s*clearRawDrive,/.test(appSrc));
ok('listModelParams() membaca SEMUA parameter, bukan 8 peran',
  /function listModelParams\(\)/.test(appSrc) && /getParameterIds\(\)/.test(appSrc));
ok('rawDrive dibuang saat model diganti', /state\.rawDrive = null;/.test(appSrc));
ok('bridge runtime punya applyParamDrive + releaseParamDrive',
  /applyParamDrive: \(vals\) => setRawDrive\(vals\)/.test(appSrc) && /releaseParamDrive:/.test(appSrc));
ok('bridge melaporkan parameter yang dimiliki model', /getOwnedParams:/.test(appSrc));

// ── H. Runtime: putar + lepas track param ────────────────────────────────
section('H. runtime memutar track param dan melepasnya saat selesai');

let clock = 0;
const driven = [];
let released = null;
const R = createRegistry();
R.register(Object.assign({}, s.asset, {
  id: 'raw_play', source: 'user', priority: 60, cooldown: 0, aiEnabled: true,
  intensity: { min: 0.3, max: 1, default: 0.8 },
}));
const rt = createRuntime(R, {
  now: () => clock,
  getPoseBase: () => ({}),
  getOwnedParams: () => new Set(['ParamHairFront', 'ParamCheek']),
  readParam: () => 0,
  applyParamDrive: (v) => driven.push(Object.assign({}, v)),
  releaseParamDrive: (ids) => { released = ids.slice(); },
  applyPoseDelta: () => {},
  clearPoseDelta: () => {},
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  ok('play() menerima motion raw', rt.play('raw_play', { blendIn: 0, blendOut: 0, intensity: 1 }));
  await sleep(30); clock += 500; await sleep(30);
  const mid = driven[driven.length - 1] || {};
  ok('nilai parameter ditulis lewat applyParamDrive', mid.ParamHairFront !== undefined, JSON.stringify(mid));
  ok('nilai di tengah timeline sesuai interpolasi (≈42.5)',
    Math.abs(mid.ParamHairFront - 42.5) < 2, String(mid.ParamHairFront));
  clock += 1000; await sleep(40);
  ok('motion selesai sendiri', !rt.isPlaying());
  ok('parameter DILEPAS saat selesai (pose tidak nyangkut)',
    released && released.includes('ParamHairFront'), JSON.stringify(released));

  // blend-in untuk nilai absolut = interpolasi dari nilai awal, bukan perkalian
  driven.length = 0;
  clock = 0;
  const rt2 = createRuntime(R, {
    now: () => clock,
    getPoseBase: () => ({}),
    getOwnedParams: () => new Set(['ParamHairFront', 'ParamCheek']),
    readParam: () => 10,          // nilai awal 10
    applyParamDrive: (v) => driven.push(Object.assign({}, v)),
    releaseParamDrive: () => {},
    applyPoseDelta: () => {}, clearPoseDelta: () => {},
  });
  rt2.play('raw_play', { blendIn: 1000, blendOut: 0, intensity: 1 });
  await sleep(30); clock += 500; await sleep(30);
  const b = driven[driven.length - 1] || {};
  // t=0 pada kurva (tSec dikunci 0 selama blendIn) → target 0, dari awal 10,
  // amp 0.5 → 10 + (0 - 10) × 0.5 = 5
  ok('blend-in meng-interpolasi DARI nilai awal (10 → 5, bukan 0)',
    Math.abs(b.ParamHairFront - 5) < 0.6, String(b.ParamHairFront));
  rt2.stopAll();

  // ── I. UI: Semantic Mode benar-benar dihapus ────────────────────────────
  section('I. UI hanya punya satu mode (Raw Parameter)');

  ok('panel daftar parameter ada di markup', /id="ms-param-list"/.test(htmlSrc));
  ok('pencarian + filter kategori ada', /id="ms-param-search"/.test(htmlSrc) && /id="ms-param-group"/.test(htmlSrc));
  ok('input angka pas per key ada', /id="ms-key-v-num"/.test(htmlSrc));
  ok('pilihan easing per key ada', /id="ms-key-easing"/.test(htmlSrc));
  ok('copy/paste key ada', /id="ms-key-copy"/.test(htmlSrc) && /id="ms-key-paste"/.test(htmlSrc));
  ok('tabel "mode lanjutan" peran→param DIHAPUS', !/id="ms-role-map"/.test(htmlSrc));
  ok('editor tidak lagi punya daftar 8 field hardcode',
    !/const TRACKS = \[/.test(edSrc) && !/'Kepala X'/.test(edSrc));
  ok('editor menulis pose lewat setRawDrive (bukan setAIPose)',
    /l2d\.setRawDrive\(patch\)/.test(edSrc) && !/setAIPose\(\{/.test(edSrc));
  ok('scrub playhead memanggil applyScrubPose', /renderTime\(\); applyScrubPose\(\)/.test(edSrc));
  ok('slider nilai ter-apply saat input (live), bukan saat blur',
    /on\('#ms-key-v', 'input'/.test(edSrc) && /setSelectedValue\(e\.target\.value, false\)/.test(edSrc));
  ok('drag key memperbarui preview selama digeser',
    /renderTracks\(\); renderTime\(\); renderKeyBox\(\); applyScrubPose\(\)/.test(edSrc));
  ok('editor melepas param saat popup ditutup',
    /releaseAllDriven\(\)/.test(edSrc) && /clearRawDrive\(\)/.test(edSrc));
  ok('migrasi motion lama dipanggil saat memuat draft',
    /migrateSemanticTracks\(draft\)/.test(edSrc));
  ok('track param yang tak ada di model ditandai off', /paramAvailable\(tr\.param\)/.test(edSrc));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})();
