/**
 * live2d/render-scheduler.ts — kontrak penjadwal render Cubism 5.3.
 *
 * Unit render TIDAK BOLEH diasumsikan hanya drawable ("drawable = langsung
 * draw ke canvas" dilarang). Dengan Offscreen Drawing, scheduler memahami
 * minimal:
 *
 *   RenderObject = DrawableRenderObject | OffscreenRenderObject
 *
 * dan menyusun rencana pass (pipeline minimal dokumen teknis §16):
 *
 *   mask pass → drawable pass → offscreen pass → composite pass → main
 *
 * Scheduler hanya MERENCANAKAN; eksekusi oleh RenderBackend. Pemisahan ini
 * yang membuat pipeline bisa bercabang per-versi moc (kompatibilitas §20)
 * tanpa menyentuh backend.
 */

import type { CoreModelSnapshot } from "./cubism-core";
import type { RenderTarget } from "./render-backend";

// ── Node/object model (§9) ─────────────────────────────────────
/** Referensi objek render — indeks ke snapshot core (tanpa salin data mesh). */
export type RenderObjectRef =
  | { object: "drawable"; index: number }
  | { object: "offscreen"; index: number };

/** Satu pass dalam rencana render. */
export interface RenderPass {
  kind: "mask" | "drawable" | "offscreen" | "composite";
  /** Tujuan pass: main framebuffer, target offscreen milik model, atau
   * target pinjaman pool (untuk mask buffer resolusi tinggi). */
  target: RenderTarget | "main";
  /** Urutan objek dalam pass ini — SUDAH mengikuti render order gabungan
   * core yang dipadatkan (permutasi 0..count-1, urutan relatif dipertahankan). */
  objects: RenderObjectRef[];
  /** Untuk pass offscreen/composite: indeks offscreen tujuan pada snapshot. */
  offscreenIndex?: number;
}

/** Rencana render satu frame — output murni, tanpa efek samping. */
export interface RenderPlan {
  /** false bila model diputar dengan pipeline legacy (< v6) — pass offscreen
   * tidak akan ada; scheduler tetap menyusun mask+drawable dengan benar. */
  uses53Pipeline: boolean;
  passes: RenderPass[];
}

// ── Statistik performa (§19) ───────────────────────────────────
export interface FrameStats {
  ms: number;
  drawCalls: number;
  passes: number;
  /** Pinjaman pool yang kena vs miss (create baru) — indikator §18. */
  poolHits: number;
  poolMisses: number;
}

/**
 * Penjadwal render. Satu instans per model. buildPlan dipanggil setiap frame
 * SETELAH core dievaluasi (parameter/deformer selesai), SEBELUM backend
 * menggambar — urutan pipeline dokumen §16 langkah 6–13.
 */
export interface RenderScheduler {
  /** Versi moc yang dilayani — menentukan cabang pipeline (§20):
   * v6 = pipeline 5.3 lengkap (offscreen+composite), <v6 = pipeline legacy. */
  readonly mocVersion: number;
  buildPlan(snapshot: CoreModelSnapshot): RenderPlan;
  /** Statistik frame terakhir (nol bila belum pernah build). */
  lastStats(): FrameStats | null;
}
