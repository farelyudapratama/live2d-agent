/**
 * live2d/cubism-core.ts — kontrak lapisan Cubism di bawah adapter.
 *
 * Lapisan ini MEMBUNGKUS Cubism Core (bukan menyembunyikannya): semua konsep
 * model runtime yang dijanjikan core — MOC3 versi, parameter, part, drawable,
 * render order gabungan, blend mode, offscreen — terekspose di sini sebagai
 * objek polos (snapshot), bebas tipe pustaka renderer mana pun.
 *
 * Sumber kebenaran spesifikasi: Cubism 5.3 (MOC3 v6). Poin yang MENGIKAT
 * (dokumen technical-context):
 *  - Core lama hanya mengenal MOC3 s/d v5 → moc v6 pada core lama WAJIB
 *    gagal LOUD (tidak pernah ada lagi stamp versi sebagai solusi kompat).
 *  - Render order: era lama memakai csmGetDrawableRenderOrders(); Cubism 5.3
 *    memakai csmGetRenderOrders() — urutan GABUNGAN drawable+offscreen.
 *    Renderer tidak boleh mengasumsikan API lama masih sumber utama.
 *  - Blend mode: BUKAN lagi Normal/Add/Multiply/Screen saja — spesifikasi
 *    resmi 15 color/RGB mode + 5 alpha mode. Jumlah & mapping mengikuti
 *    spesifikasi resmi, diakses per-id (lihat konstanta di bawah).
 *  - Part BUKAN sekadar kumpulan drawable: dengan Offscreen Drawing, hasil
 *    compositing part bisa butuh render target sendiri (opacity/blend diterapkan
 *    ke hasil GABUNGAN, bukan per-drawable).
 */

// ── Versi & kompatibilitas ─────────────────────────────────────
/** Versi MOC3 yang pernah ada. v6 = Cubism 5.3. Versi >6 dari editor lebih
 * baru = pertanyaan kompatibilitas BARU — selalu fail-loud, tidak pernah
 * ditebak/di-stamp. */
export type MocVersion = 3 | 4 | 5 | 6;

/** Versi moc yang dikenal adapter. Semua yang terdaftar wajib punya pipeline
 * yang benar; yang tidak terdaftar ditolak LOUD saat loadModel. */
export const SUPPORTED_MOC_VERSIONS: readonly MocVersion[] = [3, 4, 5, 6];

/** Info core yang terpasang di halaman (jawaban audit §23 dokumen teknis). */
export interface CoreInfo {
  /** Versi core (csmGetVersion pada core asli). */
  version: string;
  /** MOC tertinggi yang dikenal core ini (csmGetLatestMocVersion). */
  latestMocVersion: MocVersion | number;
  /** true bila core mengekspos csmGetRenderOrders() gabungan (era 5.3). */
  hasCombinedRenderOrders: boolean;
}

// ── Blend mode (spesifikasi 5.3) ───────────────────────────────
/**
 * Mode diakses per-ID sesuai spesifikasi resmi Cubism 5.3: 15 color/RGB mode
 * + 5 alpha mode. Empat id pertama punya arti era lama dan diberi konstanta
 * bernama; ID LAIN TIDAK BOLEH di-hard-code artinya di renderer — mapping
 * id → operasi blending hidup di backend, mengikuti spesifikasi resmi.
 */
export const BLEND_NORMAL = 0;
export const BLEND_ADDITIVE = 1;
export const BLEND_MULTIPLY = 2;
export const BLEND_SCREEN = 3;

export const COLOR_BLEND_MODE_COUNT = 15;
export const ALPHA_BLEND_MODE_COUNT = 5;

export type ColorBlendModeId = number; // 0..COLOR_BLEND_MODE_COUNT-1
export type AlphaBlendModeId = number; // 0..ALPHA_BLEND_MODE_COUNT-1

export interface BlendModeSpec {
  color: ColorBlendModeId;
  alpha: AlphaBlendModeId;
}

/** Warna 0..1 per kanal (bentuk core: Float32Array per-drawable). */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

// ── Snapshot model (data frame dari core, objek polos) ─────────
export interface PartSnapshot {
  id: string;
  /** Part induk dalam hierarki, -1 bila akar. */
  parentIndex: number;
  opacity: number;
}

export interface DrawableSnapshot {
  id: string;
  textureIndex: number;
  /**
   * Urutan dari API render order GABUNGAN era 5.3 (drawable + offscreen
   * disatukan). Renderer memampatkannya menjadi permutasi padat 0..count-1
   * sambil mempertahankan urutan relatif — nilai sparse dilarang mengosongkan
   * slot draw (pelajaran PATCH 3 pada stack lama).
   */
  renderOrder: number;
  opacity: number;
  blendMode: BlendModeSpec;
  multiplyColor: RGB;
  screenColor: RGB;
  /** Indeks drawable yang dipakai sebagai mask untuk drawable ini. */
  maskIndices: number[];
  isInvertedMask: boolean;
  /** Part pemilik (untuk komposit offscreen per-part). -1 bila tanpa part. */
  parentPartIndex: number;
  vertexCount: number;
  indexCount: number;
}

/** Satu offscreen render target milik model (Offscreen Drawing 5.3).
 * Opacity part yang hidup di sini TIDAK dibake ke drawable oleh core —
 * renderer wajib menerapkannya saat compositing (pelajaran `__offGroupFactor`). */
export interface OffscreenSnapshot {
  index: number;
  /** Indeks part yang memakai offscreen ini. */
  ownerIndices: number[];
  /** Faktor opacity hasil compositing offscreen (0..1). */
  opacity: number;
}

/** Seluruh data model yang dibutuhkan satu frame render — diambil dari core
 * lewat API gabungan era 5.3. Untuk diagnostik dan perencanaan render;
 * jalur per-frame renderer internal boleh membaca core langsung demi
 * performa (tanpa alokasi snapshot tiap frame). */
export interface CoreModelSnapshot {
  mocVersion: MocVersion | number;
  /** Urutan gabungan (drawable lalu offscreen) panjang drawableCount+offscreenCount. */
  combinedRenderOrders: number[];
  drawables: DrawableSnapshot[];
  parts: PartSnapshot[];
  offscreens: OffscreenSnapshot[];
  textureCount: number;
  /** Parameter model — id aktual milik model (model-agnostic; tanpa makna). */
  parameterIds: string[];
  parameterValues: number[];
  parameterRanges: Array<{ min: number; max: number; def: number }>;
}

// ── Fitur 5.3 yang dijanjikan lapisan ini ──────────────────────
/** Jawaban runtime atas audit §23 — dipakai app.js untuk gate fitur dan
 * menampilkan diagnostik, bukan ditebak dari keberadaan global. */
export interface CubismCapabilities {
  coreReady: boolean;
  coreVersion: string;
  latestMocVersion: MocVersion | number;
  /** true = core mengenal moc v6 (Cubism 5.3). */
  supportsMoc6: boolean;
  /** true = API render order gabungan tersedia (csmGetRenderOrders). */
  renderOrdersCombined: boolean;
  /** true = 15 color + 5 alpha blend mode tersedia. */
  blendModes53: boolean;
  /** true = Offscreen Drawing tersedia. */
  offscreenDrawing: boolean;
  /** true = masking resolusi tinggi tersedia (bukan diasumsikan mask lama). */
  highDefinitionMasking: boolean;
}
