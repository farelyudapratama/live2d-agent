/* motion-runtime.js — Motion Runtime: satu pintu pemutaran Motion Asset (UMD)
 *
 * Spec §11/§31: SEMUA pemanggil animasi (app.js, agent.js, editor, idle)
 * berakhir di sini, dan runtime ini sendiri TIDAK menulis parameter Live2D
 * secara langsung. Ia menulis delta pose ke bridge yang disuntikan app.js —
 * bridge itu menulis ke state.aiPose persis seperti playGesture() lama, jadi
 * ease engine, fidget, override sticky, dan guard clipUntil tetap memerintah.
 * Tidak ada mesin animasi kedua yang bertarung dengan yang pertama.
 *
 * Bridge contract (app.js menyediakan saat attach):
 *   getPoseBase()      -> snapshot {ax, ay, ex, ey, bodyX, bodyY, bodyZ, mouthForm}
 *   applyPoseDelta(d)  -> terapkan delta ke target pose (di atas base snapshot)
 *   clearPoseDelta()   -> kembalikan ke base (motion selesai)
 *   playNative(group)  -> putar klip .motion3.json lewat MotionManager model
 *   now()              -> clock (di-inject supaya test bisa deterministik)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MotionRuntime = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createRuntime(registry, bridge) {
    let br = bridge || {};
    let rafId = null;
    // Watchdog berbasis timer, WAJIB ada di samping rAF.
    //
    // requestAnimationFrame BERHENTI total saat tab tidak terlihat (background
    // tab / window minimize). Tanpa watchdog, sebuah motion yang mulai lalu
    // tab-nya disembunyikan akan menggantung selamanya: `active` tidak pernah
    // dibersihkan, delta pose-nya tetap menempel di state.aiPose, dan semua
    // motion prioritas lebih rendah ditolak sampai halaman dibuka lagi. Jalur
    // gesture lama memakai setTimeout sehingga tidak punya masalah ini, jadi
    // ini bukan cacat baru yang boleh dibiarkan. setTimeout memang di-throttle
    // ke ~1/detik di background, tapi TETAP jalan — cukup untuk memastikan
    // motion selesai dan pose dikembalikan.
    let watchdogId = null;
    // Hanya SATU motion keyframe aktif pada satu waktu — sama seperti token
    // gesture lama: dua pose-delta bersamaan di 8 field yang sama hanya
    // menghasilkan kejang. Motion dengan prioritas lebih tinggi mengalahkan
    // yang sedang jalan; yang lebih rendah ditolak.
    let active = null;   // {asset, opts, startTime, base, phase}
    const history = [];  // id yang baru selesai (untuk debug/UI)

    function now() { return br.now ? br.now() : (typeof performance !== 'undefined' ? performance.now() : Date.now()); }
    function getDSL() {
      return globalThis.MotionDSL || (typeof require === 'function' ? require('./motion-dsl.js') : null);
    }

    function stopLoop() {
      if (rafId != null) {
        (typeof requestAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout)(rafId);
        rafId = null;
      }
      if (watchdogId != null) { clearTimeout(watchdogId); watchdogId = null; }
    }

    function finishActive(restore) {
      if (!active) return;
      history.unshift({ id: active.asset.id, at: now() });
      if (history.length > 20) history.length = 20;
      const done = active;
      active = null;
      stopLoop();
      if (restore && br.clearPoseDelta) br.clearPoseDelta();
      // Raw parameter drive HARUS dilepas juga, kalau tidak nilai keyframe
      // terakhir menempel selamanya dan model terlihat "nyangkut" di pose akhir
      // — jauh lebih kentara daripada delta pose, karena drive menulis nilai
      // absolut dengan weight 1 setiap frame dan mengalahkan idle sepenuhnya.
      if (restore && br.releaseParamDrive) br.releaseParamDrive(done.paramIds || []);
      if (done.opts && typeof done.opts.onDone === 'function') done.opts.onDone(done.asset.id);
    }

    // ── Loop utama ────────────────────────────────────────────────
    // Amp: 0→1 selama blendIn, 1 selama badan motion, 1→0 selama blendOut.
    // Blend-out dievaluasi dari kurva pada t=akhir (nilai dibekukan lalu
    // dilerengkan ke nol) sehingga idle → motion → idle tidak pernah snap.
    function tick() {
      // rAF/timer yang memanggil kita sudah "dipakai" — kosongkan dulu, kalau
      // tidak scheduleTick() di akhir tick menolak menjadwalkan frame berikutnya
      // dan loop mati setelah satu frame. Watchdog di-clear juga supaya tidak
      // menumpuk dua timer untuk frame yang sama.
      rafId = null;
      if (watchdogId != null) { clearTimeout(watchdogId); watchdogId = null; }
      if (!active) { stopLoop(); return; }
      const { asset, opts, startTime, base } = active;
      const DSL = getDSL();
      const durMs = DSL.assetDurationMs(asset);
      const blendIn = Math.max(0, opts.blendIn != null ? opts.blendIn : 120);
      const blendOut = Math.max(0, opts.blendOut != null ? opts.blendOut : 250);
      const tMs = now() - startTime;
      const totalMs = durMs + blendOut;

      if (tMs >= totalMs) {
        if (asset.loop) { active.startTime = now(); scheduleTick(); return; }
        finishActive(true);
        return;
      }

      let amp = 1, tSec = (tMs - blendIn) / 1000;
      if (tMs < blendIn) { amp = blendIn > 0 ? tMs / blendIn : 1; tSec = 0; }
      if (tMs > durMs) {
        const f = (tMs - durMs) / (blendOut || 1);
        amp = 1 - Math.min(1, f);
        tSec = durMs / 1000;
      }

      const supports = br.getSupports ? br.getSupports() : null;
      const ownedParams = br.getOwnedParams ? br.getOwnedParams() : null;
      const ev = DSL.evaluateAsset(asset, Math.max(0, tSec), opts.intensity, supports, ownedParams);
      const roles = ev.__roles || ev;
      const params = ev.__params || {};
      if (br.applyPoseDelta) {
        const scaled = {};
        for (const k in roles) scaled[k] = roles[k] * amp;
        br.applyPoseDelta(scaled, base);
      }
      // Track parameter mentah: nilai ABSOLUT, jadi tidak bisa cuma dikalikan
      // amp seperti delta. Blend dilakukan dengan meng-interpolasi dari nilai
      // parameter SAAT MOTION MULAI (base) menuju nilai target — itulah arti
      // "fade in" untuk nilai absolut; mengalikan angka absolut dengan 0.5 akan
      // memindahkan pose ke tempat lain, bukan meredamnya.
      if (br.applyParamDrive) {
        const paramBase = active.paramBase || {};
        const blended = {};
        for (const id in params) {
          const from = Number.isFinite(paramBase[id]) ? paramBase[id] : params[id];
          blended[id] = from + (params[id] - from) * amp;
        }
        br.applyParamDrive(blended);
      }

      if (opts.onProgress && typeof opts.onProgress === 'function') {
        opts.onProgress(Math.min(1, tMs / totalMs));
      }
      scheduleTick();
    }

    function scheduleTick() {
      if (typeof requestAnimationFrame === 'function') {
        if (rafId == null) rafId = requestAnimationFrame(tick);
        // Watchdog: rAF mati total di tab background, jadi selalu pasang timer
        // cadangan yang menjamin motion tetap selesai dan pose dikembalikan.
        // ~250ms cukup halus untuk crossfade blendOut dan tidak membanjiri timer.
        if (watchdogId == null) {
          watchdogId = setTimeout(() => { watchdogId = null; tick(); }, 250);
        }
        return;
      }
      // Lingkungan tanpa rAF (Node/test): timer adalah satu-satunya penggerak.
      if (rafId == null) rafId = setTimeout(tick, 16);
    }

    // ── API publik (SPEC §11) ─────────────────────────────────────
    function play(id, opts) {
      const o = opts || {};
      if (!registry) return false;
      const asset = registry.get(id);
      if (!asset || asset.aiEnabled === false && o.fromLLM) return false;
      if (!registry.canPlay(id, now())) {
        if (o.fromLLM) return false;   // LLM harus hormati cooldown; user manual boleh paksa
      }

      // Native clip: tidak punya keyframe — serahkan ke MotionManager model.
      if (asset.source === 'native') {
        registry.markPlayed(id, now());
        if (br.playNative) br.playNative(asset.id.replace(/^motion_/, ''));
        return true;
      }
      if (!asset.tracks || !asset.tracks.length) return false;

      const prio = o.priority != null ? o.priority : (asset.priority != null ? asset.priority : 60);
      if (active) {
        const activePrio = active.opts.priority != null ? active.opts.priority
          : (active.asset.priority != null ? active.asset.priority : 60);
        if (prio < activePrio) return false;
        finishActive(false);   // digantikan tanpa restore — motion baru mulai dari pose sekarang
      }

      registry.markPlayed(id, now());
      const base = br.getPoseBase ? br.getPoseBase() : {};
      // Nilai AWAL setiap parameter mentah yang akan disentuh motion ini.
      // Dipakai sebagai titik asal blend-in/out (lihat applyParamDrive di tick):
      // nilai absolut tidak bisa di-fade dengan perkalian, hanya dengan
      // interpolasi dari nilai yang sedang berlaku menuju nilai target.
      const paramIds = [];
      const paramBase = {};
      for (const tr of asset.tracks) {
        if (tr.kind !== 'param' || typeof tr.param !== 'string') continue;
        paramIds.push(tr.param);
        paramBase[tr.param] = br.readParam ? br.readParam(tr.param) : 0;
      }
      active = {
        asset, opts: Object.assign({}, o, { priority: prio }),
        startTime: now(), base, paramBase, paramIds,
      };
      scheduleTick();
      return true;
    }

    function stop(id) {
      if (active && (!id || active.asset.id === id)) { finishActive(true); return true; }
      return false;
    }
    function stopAll() { if (active) { finishActive(true); return true; } return false; }
    function isPlaying(id) { return !!active && (!id || active.asset.id === id); }
    function getActive() { return active ? { id: active.asset.id, asset: active.asset } : null; }
    function getHistory() { return history.slice(); }
    function listAvailable() {
      return registry ? registry.list().filter(a => a.source !== 'native' || a.aiEnabled !== false) : [];
    }

    // Tukar bridge (dipakai app.js saat model di-swap).
    function attach(newBridge) { br = newBridge || {}; stopAll(); }

    return { play, stop, stopAll, isPlaying, getActive, getHistory, listAvailable, attach };
  }

  return { createRuntime };
});
