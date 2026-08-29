/**
 * test-motion-dsl.js — verifikasi js/motion-dsl.js (Fase 1 Motion Studio)
 *
 * Run: node test/test-motion-dsl.js
 *
 * Cakupan sesuai SPEC §29 (Parser):
 *   - asset valid lolos sanitasi dengan nilai default yang benar
 *   - JSON rusak / field hilang / keyframe invalid / target tak dikenal ditolak
 *   - NaN, Infinity, timestamp negatif, durasi negatif tidak pernah lolos
 *   - alias peran SPEC (angleX dsb) dinormalisasi ke field internal
 *   - konversi dua-arah steps ⇄ tracks
 *   - interpolasi linear/ease/stepped + intensity scaling + clamp bounds
 */
const DSL = require('../js/motion-dsl.js');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra != null ? '  -> ' + JSON.stringify(extra) : ''}`); }
}

// ── Sanitasi dasar ──
const good = {
  id: 'wave_hi', name: 'Wave Hi', description: 'Melambai ceria.',
  tags: ['Greeting', 'hello'], duration: 1.4, loop: false,
  intensity: { min: 0.3, max: 1.0, default: 0.8 },
  emotionCompatibility: { senang: 1.0, normal: 0.7, sedih: 0.1 },
  cooldown: 3000, priority: 50,
  tracks: [
    { target: 'angleX', keys: [{ t: 0, v: 0 }, { t: 0.3, v: 5 }, { t: 1.4, v: 0 }] },
    { target: 'bodyY', intensityScale: 0.5, keys: [{ t: 0, v: 0 }, { t: 0.4, v: -4 }] },
  ],
};
const s = DSL.sanitizeMotionAsset(good, { requireTracks: true });
check('asset valid lolos', s.ok, s.errors);
check('alias angleX dinormalisasi ke ax', s.ok && s.asset.tracks[0].target === 'ax');
check('tags dinormalkan lowercase', s.ok && s.asset.tags[0] === 'greeting');
check('durasi dipertahankan', s.ok && s.asset.duration === 1.4);

// ── Penolakan sampah ──
check('bukan objek ditolak', !DSL.sanitizeMotionAsset(null).ok);
check('array ditolak', !DSL.sanitizeMotionAsset([1, 2]).ok);
check('id kosong ditolak', !DSL.sanitizeMotionAsset({ id: '' }).ok);
check('id dengan spasi ditolak', !DSL.sanitizeMotionAsset({ id: 'wave hi' }).ok);
check('tanpa track + requireTracks ditolak',
  !DSL.sanitizeMotionAsset({ id: 'x', tracks: [] }, { requireTracks: true }).ok);
const badTarget = DSL.sanitizeMotionAsset({ id: 'x', tracks: [{ target: 'ParamAngleX', keys: [{ t: 0, v: 1 }] }] }, { requireTracks: true });
check('target parameter mentah Cubism DITOLAK (aturan SPEC §3)', !badTarget.ok);
const nanKey = DSL.sanitizeMotionAsset({ id: 'x', tracks: [{ target: 'ax', keys: [{ t: 0, v: NaN }, { t: 1, v: Infinity }] }] }, { requireTracks: true });
check('keyframe NaN/Infinity ditolak', !nanKey.ok);
const negDur = DSL.sanitizeMotionAsset({ id: 'x', duration: -5, tracks: [{ target: 'ax', keys: [{ t: 0, v: 1 }] }] }, { requireTracks: true });
check('durasi negatif di-clamp ke default', negDur.ok && negDur.asset.duration === 1);
const negT = DSL.sanitizeMotionAsset({ id: 'x', duration: 2, tracks: [{ target: 'ax', keys: [{ t: -1, v: 3 }, { t: 1, v: 3 }] }] }, { requireTracks: true });
check('timestamp negatif dibuang', negT.ok && negT.asset.tracks[0].keys.length === 1);

// ── Clamp & merge keyframe ──
const clamped = DSL.sanitizeMotionAsset({ id: 'x', duration: 2, tracks: [{ target: 'ax', keys: [{ t: 0, v: 999 }, { t: 1, v: -999 }, { t: 1, v: 5 }] }] }, { requireTracks: true });
check('nilai di-clamp ke ±30', clamped.ok && clamped.asset.tracks[0].keys[0].v === 30);
check('key duplikat waktu digabung (terakhir menang)', clamped.ok && clamped.asset.tracks[0].keys.length === 2 && clamped.asset.tracks[0].keys[1].v === 5);
const exClamp = DSL.sanitizeMotionAsset({ id: 'x', duration: 1, tracks: [{ target: 'ex', keys: [{ t: 0, v: 42 }] }] }, { requireTracks: true });
check('field ternormalisasi di-clamp ke ±1', exClamp.ok && exClamp.asset.tracks[0].keys[0].v === 1);
const dupTrack = DSL.sanitizeMotionAsset({ id: 'x', duration: 1, tracks: [
  { target: 'ax', keys: [{ t: 0, v: 1 }] }, { target: 'angleX', keys: [{ t: 0, v: 9 }] },
] }, { requireTracks: true });
check('track duplikat (ax + alias) dibuang satu', dupTrack.ok && dupTrack.asset.tracks.length === 1);

// ── Intensity / priority / requires ──
const inten = DSL.sanitizeMotionAsset({ id: 'x', duration: 1, intensity: { min: 0.9, max: 0.2, default: 5 }, tracks: [{ target: 'ax', keys: [{ t: 0, v: 1 }] }] });
check('intensity min/max tertukar diperbaiki', inten.ok && inten.asset.intensity.min === 0.2 && inten.asset.intensity.max === 0.9);
check('intensity default di-clamp ke [min,max]', inten.ok && inten.asset.intensity.default === 0.9);
const prio = DSL.sanitizeMotionAsset({ id: 'x', duration: 1, priority: 999, cooldown: -5, requires: ['head', 'tail'], tracks: [{ target: 'ax', keys: [{ t: 0, v: 1 }] }] });
check('priority di-clamp 0..100', prio.ok && prio.asset.priority === 100);
check('cooldown negatif jadi 0', prio.ok && prio.asset.cooldown === 0);
check('requires tak dikenal dibuang', prio.ok && prio.asset.requires.length === 1);

// ── Interpolasi ──
const lin = { keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }], interp: 'linear' };
check('linear tengah = 5', DSL.evalTrack(lin, 0.5) === 5);
const step = { keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }], interp: 'stepped' };
check('stepped tengah = nilai key sebelumnya', DSL.evalTrack(step, 0.5) === 0);
const eio = { keys: [{ t: 0, v: 0 }, { t: 1, v: 10 }], interp: 'ease-in-out' };
check('ease-in-out simetris di 0.5', DSL.evalTrack(eio, 0.5) === 5);
check('evalTrack sebelum key pertama = nilai awal', DSL.evalTrack(lin, -1) === 0);
check('evalTrack setelah key terakhir = nilai akhir', DSL.evalTrack(lin, 99) === 10);

// ── evaluateAsset: intensity, per-track scale, clamp, degrade ──
const asset = s.asset;
const ev = DSL.evaluateAsset(asset, 0.3, 0.5, null);
check('intensity 0.5 menskalakan nilai', ev.ax === 2.5, ev.ax);          // 5 * 0.5
check('intensityScale 0.5 ikut menskalakan bodyY', Math.abs(ev.bodyY - (-0.75)) < 1e-9, ev.bodyY); // linear -3 @t=.3 * 0.5 * 0.5
const noHead = DSL.evaluateAsset(asset, 0.3, 1, new Set(['body']));
check('degrade-graceful: track head dilewati saat model tanpa head', noHead.ax === undefined && Math.abs(noHead.bodyY - (-1.5)) < 1e-9);
const evClamp = DSL.evaluateAsset({ tracks: [{ target: 'ex', keys: [{ t: 0, v: 1 }] }] }, 0, 1, null);
check('hasil evaluasi tetap di-clamp bounds', evClamp.ex <= 1);

// ── Konversi steps ⇄ tracks ──
const steps = [
  { d: { ay: -8 }, ms: 160 },
  { d: { ay: 6 }, ms: 160 },
  { d: {}, ms: 160 },
];
const tracks = DSL.stepsToTracks(steps);
check('stepsToTracks menghasilkan 1 track ay', tracks.length === 1 && tracks[0].target === 'ay');
// Step kosong terakhir = kembali ke base → key v=0 di t=0.32 (semantik lama).
check('stepsToTracks waktu kumulatif + kembali ke base',
  tracks[0].keys.length === 3 && tracks[0].keys[1].t === 0.16 && tracks[0].keys[2].t === 0.32 && tracks[0].keys[2].v === 0);
const back = DSL.tracksToSteps({ tracks, duration: 0.48 });
check('tracksToSteps menghasilkan steps > 0', back.length > 0);
const sample = DSL.evaluateAsset({ tracks, duration: 0.48 }, 0, 1, null);
check('evaluasi track hasil konversi = delta asli', sample.ay === -8, sample.ay);

// ── summaryForLLM ──
const sum = DSL.summaryForLLM(asset);
check('summary memuat id + deskripsi', sum.id === 'wave_hi' && sum.description === 'Melambai ceria.');
check('summary hanya emosi skor >= 0.5',
  sum.compatibleEmotions.includes('senang') && sum.compatibleEmotions.includes('normal') && !sum.compatibleEmotions.includes('sedih'));
check('summary tidak membocorkan keyframe', sum.keys === undefined && sum.tracks === undefined);

// ── assetDurationMs ──
check('durasi efektif = max(duration, key terakhir)',
  DSL.assetDurationMs({ duration: 0.5, tracks: [{ target: 'ax', keys: [{ t: 2, v: 1 }] }] }) === 2000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
