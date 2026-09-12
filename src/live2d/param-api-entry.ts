/**
 * live2d/param-api-entry.ts — pasang ParameterApi + adapter CubismModel ke
 * global `Live2DParameterApi` untuk halaman golden (pixi8-official.html).
 *
 * Pola sama dengan cubismframework-entry.ts: bundle IIFE yang hanya menaruh
 * objek polos ke `window` (side-effect), tanpa memulai render loop. Halaman
 * sandbox memanggil komponennya dengan model yang SUDAH dimuat.
 */
import {
  ParameterApi,
  formatParameterTable,
  type CubismParameterBacking,
} from "./parameter-api";
import { createCubismModelBacking } from "./cubism-parameter-backing";

if (typeof window !== "undefined") {
  (window as unknown as { Live2DParameterApi: unknown }).Live2DParameterApi = {
    ParameterApi,
    createCubismModelBacking,
    formatParameterTable,
  };
}

export type { CubismParameterBacking };
export { ParameterApi, createCubismModelBacking, formatParameterTable };
