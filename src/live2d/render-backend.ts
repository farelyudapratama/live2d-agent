/**
 * live2d/render-backend.ts — abstraksi backend GPU untuk renderer Live2D.
 *
 * Lapisan Cubism (model/scheduler) TIDAK BOLEH tahu detail backend — sesuai
 * arsitektur dokumen teknis:
 *
 *   Cubism Render Layer → Render Scheduler → RenderBackend
 *                                            ├── WebGL2Backend
 *                                            └── WebGPUBackend
 *
 * Konsekuensi Cubism 5.3 yang mengikat lapisan ini:
 *  - Offscreen Drawing → lifecycle render target (framebuffer+texture) adalah
 *    wajib, bukan opsional; resource wajib di-pool (§18) karena create/destroy
 *    per frame = overhead GPU besar.
 *  - Blend mode 5.3 → setBlendState menerima id spesifikasi (15 color + 5
 *    alpha); mapping id → operasi GL/pipeline milik backend, TIDAK boleh
 *    dibatasi Normal/Add/Multiply/Screen.
 *  - Masking → mask render target terpisah dari target gambar; resolusi
 *    tinggi didukung (jangan diasumsikan mask buffer kecil tetap).
 */

import type {
  AlphaBlendModeId,
  ColorBlendModeId,
  RGB,
} from "./cubism-core";

/** Backend GPU yang tersedia. "webgl2" = dasar (Cubism 5.3 butuh WebGL2);
 * "webgpu" = opsional, arah masa depan. */
export type BackendKind = "webgl2" | "webgpu";

// ── Handle resource (opaque — implementasi bebas menyimpan apa pun) ──
export interface TextureHandle {
  readonly kind: "texture";
  readonly id: number;
}
export interface FramebufferHandle {
  readonly kind: "framebuffer";
  readonly id: number;
}
export interface ShaderHandle {
  readonly kind: "shader";
  readonly id: number;
}

/** Render target offscreen — pasangan texture+framebuffer berukuran tetap. */
export interface RenderTarget {
  texture: TextureHandle;
  framebuffer: FramebufferHandle;
  width: number;
  height: number;
}

/** State blending per draw — id spesifikasi 5.3, bukan enum GL. */
export interface BlendState {
  color: ColorBlendModeId;
  alpha: AlphaBlendModeId;
  /** true = sumber premultiplied alpha (pipeline era lama memakai ini;
   * pipeline 5.3 menentukan per-pass). */
  premultiplied: boolean;
}

/** Satu panggilan gambar mesh drawable — data polos, siap diupload backend. */
export interface MeshDrawCall {
  texture: TextureHandle;
  /** Posisi vertex (xy) dalam ruang clip core, UV, dan indeks segitiga. */
  vertices: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array | Uint32Array;
  opacity: number;
  blend: BlendState;
  /** Warna Cubism 4.2+ yang wajib sampai shader (pelajaran multiplyColor:
   * core baru mengubah artmesh; renderer lama memutihkan model). */
  multiplyColor: RGB;
  screenColor: RGB;
}

/** Sumber tekstur yang sah untuk createTexture (subset DOM — bebas renderer). */
export type TextureSource = TexImageSource;

/**
 * Backend GPU — kontrak dari dokumen teknis §15. Semua method pembuat resource
 * wajib berpasangan dengan penghancurnya (lifecycle eksplisit, tanpa GC rehat).
 */
export interface RenderBackend {
  readonly kind: BackendKind;

  createTexture(source: TextureSource): TextureHandle;
  destroyTexture(texture: TextureHandle): void;

  createFramebuffer(): FramebufferHandle;
  destroyFramebuffer(framebuffer: FramebufferHandle): void;

  createRenderTarget(width: number, height: number): RenderTarget;
  destroyRenderTarget(target: RenderTarget): void;

  createShader(source: string): ShaderHandle;
  destroyShader(shader: ShaderHandle): void;

  /** Mulai render pass ke target offscreen; `null` = main framebuffer. */
  beginRenderTarget(target: RenderTarget | null): void;
  endRenderTarget(): void;

  setViewport(x: number, y: number, width: number, height: number): void;
  setScissor(x: number, y: number, width: number, height: number): void;
  setBlendState(state: BlendState): void;

  drawMesh(call: MeshDrawCall): void;

  /** Lepas SEMUA resource milik backend (dipakai saat host.destroy()). */
  destroy(): void;
}

/**
 * Pool render target (§18) — Offscreen Drawing menggandakan kebutuhan GPU;
 * create framebuffer tiap frame dilarang. Pola: acquire per pass, release
 * di akhir frame; pool menyimpan berdasarkan ukuran.
 */
export interface RenderTargetPool {
  /** Ambil target ukuran ≥ yang diminta (boleh lebih besar bila reuse aman). */
  acquire(width: number, height: number): RenderTarget;
  /** Kembalikan target ke pool — TIDAK dihancurkan. */
  release(target: RenderTarget): void;
  /** Diagnostik performa (§19): efisiensi pool per frame. */
  stats(): { live: number; pooled: number; created: number; reused: number };
  /** Hancurkan semua target di pool (bersama backend.destroy()). */
  destroy(): void;
}
