/**
 * scene-layers.js — R7-1 GAP-1: lapisan visual di sekitar model Live2D tanpa
 * scene-graph renderer.
 *
 * KEPUTUSAN DESAIN (audit R7, kriteria per lapisan — bukan convenience):
 * dipilih DOM/CSS (opsi B), BUKAN lapisan di dalam compositor v8 (opsi A):
 *  - Ordering terhadap Live2D: kanvas produksi WAJIB transparan
 *    (backgroundAlpha 0 — syarat blend mode 5.3), jadi stack DOM
 *    [bg img] → [dim div] → [canvas] → [overlay div] menghasilkan urutan
 *    visual identik dengan zIndex legacy (-1 / -0.5 / 0 / 100).
 *  - resize/DPR: layer DOM memakai CSS px — mengikuti ukuran kanvas tanpa
 *    konversi piksel perangkat (compositor v8 justru butuh sinkronisasi
 *    sprite per resize/resolution).
 *  - pointer events: overlay `pointer-events:none` — identik legacy
 *    (partikel non-interaktif); bg berada DI BAWAH kanvas sehingga tak
 *    pernah menerima pointer.
 *  - destroy: hapus elemen DOM — tanpa manajemen children renderer.
 *  - existing UI behavior: visual identik (bg cover-fit, dim alpha 0..0.9,
 *    partikel emoji di atas model, anchor dari bbox kepala).
 *  - performance: ~1 img + 1 div + <20 span bertransformasi CSS — komposit
 *    GPU browser; tanpa render pass tambahan di jalur Live2D.
 *  - "apakah layer membutuhkan Pixi API": TIDAK — image/text/rect semuanya
 *    primitif DOM. Dengan itu kontrak Live2DHost tetap bebas scene-graph
 *    (prinsip bebas-renderer) dan TIDAK ADA transform Live2D kedua.
 *
 * Pemakai: halaman verifikasi r7-compat.html sekarang; ENGINE MAIN (port
 * fitStageBgImage + emotion-overlay) saat migrasi R7-2.
 * Plain JS (bukan bundle TS) — konsumen legacy tidak perlu build ulang.
 */
(function () {
  "use strict";

  /**
   * Pasang lapisan panggung di sekeliling kanvas Live2D.
   * @param {HTMLCanvasElement} canvas kanvas produksi (harus transparan)
   * @returns {object} handle layer:
   *   setBackground(url)      — gambar bg cover-fit di bawah kanvas (null = hapus)
   *   setDim(alpha)           — overlay hitam 0..0.9 di atas bg, di bawah kanvas
   *   overlay()               — div partikel (pointer-events:none, di atas kanvas)
   *   syncSize()              — ikutkan ukuran CSS kanvas (panggil saat resize)
   *   destroy()               — lepas semua elemen
   */
  function createStageLayers(canvas) {
    var host = canvas.parentElement || document.body;
    host.style.position = host.style.position || "relative";

    var bg = document.createElement("img");
    bg.className = "l2d-layer-bg";
    bg.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;" +
      "pointer-events:none;display:none;z-index:0;";
    var dim = document.createElement("div");
    dim.className = "l2d-layer-dim";
    dim.style.cssText =
      "position:absolute;inset:0;background:#000;pointer-events:none;display:none;z-index:1;";
    var overlay = document.createElement("div");
    overlay.className = "l2d-layer-overlay";
    overlay.style.cssText =
      "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:3;";
    // kanvas harus berada di antara dim (z1) dan overlay (z3)
    canvas.style.zIndex = "2";
    canvas.style.position = canvas.style.position || "absolute";

    host.insertBefore(bg, canvas);
    host.insertBefore(dim, canvas);
    host.appendChild(overlay);

    var api = {
      setBackground: function (url) {
        if (!url) {
          bg.style.display = "none";
          bg.removeAttribute("src");
          return;
        }
        bg.src = url;
        bg.style.display = "block";
      },
      setDim: function (alpha) {
        var a = Math.max(0, Math.min(0.9, Number(alpha) || 0));
        dim.style.display = a > 0 ? "block" : "none";
        dim.style.opacity = String(a);
      },
      overlay: function () {
        return overlay;
      },
      syncSize: function () {
        var r = canvas.getBoundingClientRect();
        overlay.style.width = r.width + "px";
        overlay.style.height = r.height + "px";
      },
      destroy: function () {
        bg.remove();
        dim.remove();
        overlay.remove();
      },
    };
    api.syncSize();
    return api;
  }

  window.L2DSceneLayers = { createStageLayers: createStageLayers };
})();
