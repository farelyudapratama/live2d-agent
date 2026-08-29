/* motion-registry.js — Motion Registry: satu daftar semua Motion Asset (UMD)
 *
 * Spec §8: registry menggabungkan TIGA sumber tanpa menyalin datanya —
 *   1. builtin  : gesture prosedural dari GESTURE_LIBRARY (dibungkus)
 *   2. native   : grup motion .motion3.json milik model (id "motion_<group>")
 *   3. user     : file motions/<model>/<id>.motion.json hasil Motion Studio
 *
 * Registry TIDAK memutar apa pun — itu tugas motion-runtime. Registry juga
 * tidak menyentuh sheet: preset 'gerak' tetap hidup di sheet dengan presedensi
 * user>ai-nya sendiri; entri di sini hanya memoderasi siapa yang kelihatan
 * oleh LLM dan siapa yang bisa dipanggil lewat playMotion().
 *
 * UMD: browser (window.MotionRegistry) + Node (test / server).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MotionRegistry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createRegistry() {
    const byId = new Map();
    // cooldown state: id -> timestamp selesai cooldown (ms epoch).
    const cooldownUntil = new Map();

    function register(asset, opts) {
      if (!asset || typeof asset !== 'object' || !asset.id) {
        return { ok: false, error: 'asset kosong / tanpa id' };
      }
      const prev = byId.get(asset.id);
      if (prev && !(opts && opts.overwrite)) {
        // Kolisi ID ditolak, bukan ditimpa senyap (SPEC §26). Sumber yang sama
        // boleh replace (update editorentry sendiri).
        if (prev.source !== asset.source) {
          return { ok: false, error: 'id "' + asset.id + '" sudah dipakai entri ' + prev.source + ' ("' + prev.name + '")' };
        }
      }
      byId.set(asset.id, Object.assign({}, asset));
      return { ok: true };
    }

    // Salinan dangkal: penelepon bebas membaca/mutasi hasilnya tanpa merusak
    // isi registry (track tetap dibagi referensi — read-only by convention).
    function get(id) { const a = byId.get(id); return a ? Object.assign({}, a) : null; }
    function has(id) { return byId.has(id); }
    function remove(id, source) {
      const a = byId.get(id);
      if (!a) return false;
      if (source && a.source !== source) return false;  // user tak boleh menghapus entri builtin/native
      byId.delete(id);
      cooldownUntil.delete(id);
      return true;
    }
    function list() { return Array.from(byId.values()); }

    // Cari berdasar tag (AND), source, dan/atau emosi yang kompatibel.
    function search(q) {
      const want = (q && q.tags) || [];
      let out = list();
      if (q && q.source) out = out.filter(a => a.source === q.source);
      if (want.length) out = out.filter(a => want.every(t => (a.tags || []).includes(String(t).toLowerCase())));
      if (q && q.emotion) out = out.filter(a => (a.emotionCompatibility || {})[q.emotion] >= 0.5);
      return out;
    }

    // ── Builder untuk tiga sumber ────────────────────────────────

    // Bungkus GESTURE_LIBRARY. Emotion map terpisah (dipakai untuk
    // emotionCompatibility) supaya modul ini tidak menyalin tabel emosi app.js.
    function registerGestureLibrary(lib, emotionGestureMap) {
      const DSL = globalThis.MotionDSL || (typeof require === 'function' ? require('./motion-dsl.js') : null);
      if (!DSL) throw new Error('motion-dsl belum dimuat');
      const emo2gest = emotionGestureMap || {};
      const gest2emo = {};
      for (const [emo, gest] of Object.entries(emo2gest)) {
        gest2emo[gest] = Math.max(gest2emo[gest] || 0, 1.0);
      }
      for (const [name, steps] of Object.entries(lib || {})) {
        const tracks = DSL.stepsToTracks(steps);
        // Durasi = total ms semua step (termasuk step hold kosong di akhir),
        // bukan timestamp key terakhir — gesture memang dirancang berhenti
        // sejenak di pose akhir sebelum engine ease kembali ke idle.
        const totalMs = (steps || []).reduce((s, st) => s + ((st && st.ms) || 0), 0);
        register({
          version: 1, id: name, name: name, source: 'builtin', type: 'gesture',
          description: 'Gerakan bawaan: ' + name.replace(/_/g, ' '),
          tags: ['builtin'], duration: +(totalMs / 1000).toFixed(3),
          loop: false, intensity: { min: 0.3, max: 1.0, default: 0.8 },
          emotionCompatibility: gest2emo[name] ? { normal: 0.7 } : {},
          cooldown: 0, priority: 60, aiEnabled: true, requires: [], tracks,
        });
      }
    }

    // Entri native per motion group model. duration/taxonomy info opsional.
    function registerNativeGroups(groups, info) {
      const meta = info || {};
      for (const g of (groups || [])) {
        if (!g) continue;
        const m = meta[g] || {};
        register({
          version: 1, id: 'motion_' + g, name: g, source: 'native', type: 'motion3',
          description: m.description || ('Motion bawaan model: ' + g),
          tags: m.tags || [], duration: m.duration || 2,
          loop: false, intensity: { min: 0.3, max: 1.0, default: 0.8 },
          emotionCompatibility: m.emotionCompatibility || {},
          cooldown: 0, priority: 90, aiEnabled: true, requires: [], tracks: [],
        }, { overwrite: true });   // native selalu tercermin dari data model terkini
      }
    }

    // Muat motion user (hasil fetch /api/motions). Replace penuh: file adalah
    // sumber kebenaran untuk source 'user'.
    function replaceUserMotions(assets) {
      for (const [id, a] of Array.from(byId)) if (a.source === 'user') byId.delete(id);
      let n = 0;
      for (const a of assets || []) {
        if (register(a, { overwrite: true }).ok) n++;
      }
      return n;
    }

    // Katalog ringkas untuk LLM — hanya yang aiEnabled dan bukan native tanpa
    // arti. Motion native tetap dimasukkan (dipanggil via playGesture jalur
    // lama), tapi tanpa description panjang.
    function catalogForLLM() {
      const DSL = globalThis.MotionDSL || (typeof require === 'function' ? require('./motion-dsl.js') : null);
      return list().filter(a => a.aiEnabled !== false).map(a => DSL.summaryForLLM(a));
    }

    // Cooldown (SPEC §20: respect cooldown).
    function canPlay(id, now) {
      const a = byId.get(id);
      if (!a) return false;
      const until = cooldownUntil.get(id) || 0;
      return now == null || now >= until;
    }
    function markPlayed(id, now) {
      const a = byId.get(id);
      if (!a || !a.cooldown) return;
      cooldownUntil.set(id, (now || 0) + a.cooldown);
    }

    return {
      register, get, has, remove, list, search,
      registerGestureLibrary, registerNativeGroups, replaceUserMotions,
      catalogForLLM, canPlay, markPlayed,
    };
  }

  return { createRegistry };
});
