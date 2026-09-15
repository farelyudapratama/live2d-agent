/**
 * pixi8-namespace.js — loader PixiJS 8.20.1 ke namespace terisolasi.
 *
 * pixi.8.20.1.min.js memasang diri sebagai `var PIXI=` pada scope global.
 * Loader ini menangkap referensi v8 → window.__compositor8 sehingga seluruh
 * stack produksi (production-env, live2d-adapter, app, pet, vtuber) dapat
 * mengaksesnya tanpa bergantung pada state window.PIXI.
 *
 * window.__compositor8Ready — Promise yang resolve saat v8 siap dipakai.
 * Idempoten — panggilan ganda tidak memuat ulang.
 * Tidak ada ticker/rAF di sini (bukan loop; hanya pemuat).
 */
(function () {
  "use strict";
  if (window.__compositor8Ready) return; // idempoten

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
        window.__compositor8 = v8;
        resolve(window.__compositor8);
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
