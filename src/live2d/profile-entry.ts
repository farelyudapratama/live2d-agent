/**
 * live2d/profile-entry.ts — pasang Model Inspector (Phase 9) ke global
 * `Live2DModelProfile` untuk halaman golden (pixi8-official.html).
 *
 * Pola sama dengan param-api-entry.ts: bundle IIFE yang hanya menaruh objek
 * polos ke `window` (side-effect), tanpa memulai render loop. Satu API
 * kanonik: buildModelProfile(paramApi, backing) — TIDAK ada varian
 * inspectModel/getModelCapabilities/getModelInfo.
 */
import {
  buildModelProfile,
  formatProfileSummary,
  type ModelMetadataBacking,
  type ModelProfile,
} from "./model-profile";
import { createCubismInspectorBacking } from "./cubism-model-inspector";

if (typeof window !== "undefined") {
  (window as unknown as { Live2DModelProfile: unknown }).Live2DModelProfile = {
    buildModelProfile,
    createCubismInspectorBacking,
    formatProfileSummary,
  };
}

export type { ModelMetadataBacking, ModelProfile };
export { buildModelProfile, createCubismInspectorBacking, formatProfileSummary };
