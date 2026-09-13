/**
 * core-log-shim.js — STAGE R3: shim slot log Cubism Core untuk coexistence
 * dua binding (pixi-live2d era-4 + Cubism Framework 5.3) di SATU halaman.
 *
 * Akar masalah (diverifikasi di source):
 *  - glue Core: `csmSetLogFunction = function(handler){
 *      Logging.logFunction = handler; handler = _em.addFunction(...); ... }`
 *    → SETIAP panggilan mengkonsumsi satu slot WASM table, dan Core dibangun
 *    TANPA ALLOW_TABLE_GROWTH → panggilan KEDUA melempar
 *    "Unable to grow wasm table".
 *  - pixi-live2d-0.4.0.js memanggil csmSetLogFunction saat init cubism4-nya;
 *    CubismFramework.startUp (5.3) juga memanggilnya (live2dcubismframework.ts:93).
 *
 * Solusi: first-writer-wins — pendaftar PERTAMA memenangkan slot log; kandidat
 * berikutnya dilewati (aman: log adalah diagnostik, bukan semantik render).
 * WAJIB dimuat tepat setelah live2dcubismcore.min.js, SEBELUM binding mana pun
 * jalan. Idempoten. Tidak mengubah perilaku halaman yang hanya memuat satu
 * binding (pemanggil pertama tetap terdaftar seperti tanpa shim).
 */
(function () {
  "use strict";
  var C = window.Live2DCubismCore;
  if (!C || !C.Logging || C.Logging.__l2dShared) return;
  var L = C.Logging;
  L.__l2dShared = true; // idempoten
  var orig = L.csmSetLogFunction;
  L.csmSetLogFunction = function (handler) {
    if (L.logFunction) return; // slot sudah dimiliki pendaftar pertama
    orig(handler);
  };
})();
