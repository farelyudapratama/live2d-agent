/**
 * client/i18n-entry — entrypoint bundle TERPISAH → static/js/i18n.js.
 *
 * Dipakai static/pet.html yang tidak memuat bundle.js penuh (pet tidak butuh
 * MotionRuntime/brain). self-executing: init() langsung menyweep DOM pet.
 * index.html TIDAK memuat file ini — i18n sudah ikut di dalam bundle.js.
 */
import { init } from "./i18n/index";

if (typeof window !== "undefined") {
  init();
}
