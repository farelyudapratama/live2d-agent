/**
 * live2d/index.ts — pemasangan global window.__live2dApi + pintu ekspor kontrak.
 *
 * Target dibuat objek polos (bukan window langsung) supaya idempotensi dan
 * perilaku pemasangan bisa dites tanpa DOM (bun test). bundle-entry memasang
 * ini SEBELUM app.js dieksekusi — pola yang sama dengan globals lain.
 *
 * Semua kontrak di-re-export dari sini: konsumen mengimpor dari "live2d",
 * bukan dari file internal — supaya tata letak file bebas berubah.
 */

import type { Live2DApi } from "./types";
import { createStubAdapter } from "./stub";

export type Live2DApiTarget = { __live2dApi?: Live2DApi };

// Re-export semua kontrak (API publik + lapisan Cubism + renderer internal).
export type * from "./types";
export type * from "./cubism-core";
export type * from "./render-backend";
export type * from "./render-scheduler";
export {
  SUPPORTED_MOC_VERSIONS,
  BLEND_NORMAL,
  BLEND_ADDITIVE,
  BLEND_MULTIPLY,
  BLEND_SCREEN,
  COLOR_BLEND_MODE_COUNT,
  ALPHA_BLEND_MODE_COUNT,
} from "./cubism-core";

/**
 * Pasang adapter ke target. Idempoten: kalau sudah terpasang, yang lama
 * dikembalikan dan adapter baru diabaikan — pemanggil ganda (bundle dimuat
 * dua kali, test, dsb.) tidak menimpa instans yang sudah hidup.
 */
export function installLive2DApi(
  target: Live2DApiTarget,
  adapter: Live2DApi = createStubAdapter(),
): Live2DApi {
  if (target.__live2dApi) return target.__live2dApi;
  target.__live2dApi = adapter;
  return adapter;
}
