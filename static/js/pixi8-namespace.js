/**
 * pixi8-namespace.js — STAGE R3: loader scene-graph v8 dengan namespace
 * terisolasi.
 *
 * Kedua vendor (pixi.6.5.10.min.js dan pixi.8.20.1.min.js) memasang diri
 * sebagai `var PIXI=` pada scope global — memuat keduanya apa adanya pasti
 * saling menimpa. Strategi yang disetujui audit Phase 14 §13:
 *
 *   1. SIMPAN referensi window.PIXI saat ini (Pixi6 legacy — boleh undefined
 *      di halaman yang tidak memuat legacy).
 *   2. Muat pixi.8.20.1.min.js (script dinamis, urutan terjaga).
 *   3. TANGKAP window.PIXI yang baru → window.__compositor8.
 *   4. PULIHKAN window.PIXI = referensi lama — SINKRON di onload, sehingga
 *      tidak ada satu pun script legacy yang pernah melihat objek v8.
 *
 * Pemakai: halaman coexist/smoke memuat file ini SETELAH semua script legacy,
 * lalu menunggu window.__compositor8Ready. Idempoten — panggilan ganda tidak
 * memuat ulang. Tidak ada ticker/rAF di sini (bukan loop; hanya pemuat).
 */
(function () {
  "use strict";
  if (window.__compositor8Ready) return; // idempoten

  var legacyPIXI = window.PIXI || null;

  window.__compositor8Ready = new Promise(function (resolve, reject) {
    var s = document.createElement("script");
    s.src = "js/pixi.8.20.1.min.js";
    s.async = false; // urutan eksekusi terjaga terhadap script dinamis lain
    s.onload = function () {
      try {
        var v8 = window.PIXI;
        if (!v8) {
          reject(new Error("pixi.8.20.1.min.js tidak menghasilkan global"));
          return;
        }
        window.__compositor8 = v8;      // namespace terisolasi v8
        window.PIXI = legacyPIXI; // pulihkan legacy — SINKRON, sebelum siapa pun membaca
        resolve(window.__compositor8);
        try {
          window.dispatchEvent(new CustomEvent("compositor8-ready"));
        } catch (e) {}
      } catch (e) {
        reject(e);
      }
    };
    s.onerror = function () {
      reject(new Error("gagal memuat js/pixi.8.20.1.min.js"));
    };
    document.head.appendChild(s);
  });
})();
