/**
 * cubismframework-entry.ts — pasang renderer resmi Cubism sebagai global
 * `CubismFrameworkBundle` untuk halaman golden pixi8-official.html.
 * Core (live2dcubismcore.min.js) dipakai sebagai global dari script tag.
 * License framework: LICENSE.md pada folder ini (wajib disertakan).
 */
import * as CubismFrameworkBundle from "./cubismframework-exports";

if (typeof window !== "undefined") {
  window.CubismFrameworkBundle = CubismFrameworkBundle;
}
