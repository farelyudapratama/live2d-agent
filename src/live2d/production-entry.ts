/**
 * live2d/production-entry.ts — pasang Live2DApi PRODUKSI (Stage R2) sebagai
 * window.__live2dApi untuk halaman yang memuat bundle ini
 * (static/js/live2d-adapter.js).
 *
 * ENGINE MAIN TIDAK memuat bundle ini — index.html tetap memuat bundle.js
 * yang memasang stub, jadi perilaku engine existing tidak berubah (aturan
 * R2). Halaman smoke/golden memuat: core → cubism-framework.js → bundle ini.
 */
import { installLive2DApi } from "./index";
import { createProductionAdapter } from "./production";

if (typeof window !== "undefined") {
  installLive2DApi(window, createProductionAdapter());
}
